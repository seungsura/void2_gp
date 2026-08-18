/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

import { URI } from '../../../../base/common/uri.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ILLMMessageService } from '../common/sendLLMMessageService.js';
import { chat_userMessageContent, isABuiltinToolName } from '../common/prompt/prompts.js';
import { AnthropicReasoning, getErrorMessage, RawToolCallObj, RawToolParamsObj } from '../common/sendLLMMessageTypes.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { FeatureName, ModelSelection, ModelSelectionOptions, SettingsOfProvider } from '../common/voidSettingsTypes.js';
import { IVoidSettingsService } from '../common/voidSettingsService.js';
import { getIsReasoningEnabledState, getModelCapabilities, getReservedOutputTokenSpace } from '../common/modelCapabilities.js';
import { estimateHistoryTokensForReadBudget, protectedSkillResourceHistoryLength } from './convertToLLMMessageService.js';
import { approvalTypeOfBuiltinToolName, BuiltinToolCallParams, BuiltinToolResultType, ToolCallParams, ToolName, ToolResult } from '../common/toolsServiceTypes.js';
import { computeMaxReadOutputTokens, isBoundedReadHistory, isBoundedReadHistoryString } from '../common/readFileReliability.js';
import { IToolsService } from './toolsServiceInterface.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { ChatMessage, CodespanLocationLink, isAgentDelegationSelection, StagingSelectionItem, ToolMessage } from '../common/chatThreadServiceTypes.js';
import { Position } from '../../../../editor/common/core/position.js';
import { IMetricsService } from '../common/metricsService.js';
import { shorten } from '../../../../base/common/labels.js';
import { IVoidModelService } from '../common/voidModelService.js';
import { findLast } from '../../../../base/common/arraysFind.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { truncate } from '../../../../base/common/strings.js';
import { THREAD_STORAGE_KEY } from '../common/storageKeys.js';
import { IConvertToLLMMessageService } from './convertToLLMMessageService.js';
import { timeout } from '../../../../base/common/async.js';
import { deepClone } from '../../../../base/common/objects.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { IDirectoryStrService } from '../common/directoryStrService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IMCPService } from '../common/mcpService.js';
import { RawMCPToolCall } from '../common/mcpServiceTypes.js';
import { IAgentInstructionsService } from './agentInstructionsService.js';
import { IAgentSkillsService } from './agentSkillsService.js';
import { AgentInstructionTaskSession, AgentInstructionTurnSnapshot } from '../common/agentInstructions.js';
import { AgentRuntimeTurnSnapshot, admitProtectedAgentAuthority, admitSkillResourceContext, assembleProtectedAgentAuthority, createAgentRuntimeTurnSnapshot, isReadSkillResourceToolName, reviveAgentRuntimeTurnSnapshot, runtimeModelFingerprint, selectExplicitSkills, skillAdvertisement, validateReadSkillResourceToolParams } from '../common/agentSkills.js';
import { isAgentSubagentControlName, isNativeAgentToolFormat, validateAgentSubagentControlParams } from '../common/agentSubagents.js';
import { IAgentSubagentService } from './agentSubagentService.js';
import { IAgentCustomAgentService } from './agentCustomAgentService.js';
import { CustomAgentCatalog, customAgentAdvertisement } from '../common/agentCustomAgents.js';


// related to retrying when LLM message has error
const CHAT_RETRIES = 3
const RETRY_DELAY = 2500
type AgentDelegationTurnAuthority = Readonly<{ allowed: boolean; generation: number; roles?: CustomAgentCatalog; settingsState?: IVoidSettingsService['state']; settingsOfProvider?: SettingsOfProvider }>


const findStagingSelectionIndex = (currentSelections: StagingSelectionItem[] | undefined, newSelection: StagingSelectionItem): number | null => {
	if (!currentSelections) return null

	for (let i = 0; i < currentSelections.length; i += 1) {
		const s = currentSelections[i]

		if (s.type === 'Skill' || newSelection.type === 'Skill') {
			if (s.type === 'Skill' && newSelection.type === 'Skill' && s.identity === newSelection.identity && s.catalogRevision === newSelection.catalogRevision) return i
			continue
		}
		if (s.type === 'Agent' || newSelection.type === 'Agent') {
			if (s.type === 'Agent' && newSelection.type === 'Agent') return i
			continue
		}
		if (s.uri.fsPath !== newSelection.uri.fsPath) continue

		if (s.type === 'File' && newSelection.type === 'File') {
			return i
		}
		if (s.type === 'CodeSelection' && newSelection.type === 'CodeSelection') {
			if (s.uri.fsPath !== newSelection.uri.fsPath) continue
			// if there's any collision return true
			const [oldStart, oldEnd] = s.range
			const [newStart, newEnd] = newSelection.range
			if (oldStart !== newStart || oldEnd !== newEnd) continue
			return i
		}
		if (s.type === 'Folder' && newSelection.type === 'Folder') {
			return i
		}
	}
	return null
}


type UserMessageType = ChatMessage & { role: 'user' }
type UserMessageState = UserMessageType['state']
type AgentInstructionTaskSessionRecord = {
	ownerProjectRoot: string | undefined;
	trustedAtStart: boolean;
	session: AgentInstructionTaskSession;
}
const defaultMessageState: UserMessageState = {
	stagingSelections: [],
	isBeingEdited: false,
}

// a 'thread' means a chat message history

type WhenMounted = {
	textAreaRef: { current: HTMLTextAreaElement | null }; // the textarea that this thread has, gets set in SidebarChat
	scrollToBottom: () => void;
}



export type ThreadType = {
	id: string; // store the id here too
	createdAt: string; // ISO string
	lastModified: string; // ISO string

	messages: ChatMessage[];
	filesWithUserChanges: Set<string>;

	// this doesn't need to go in a state object, but feels right
	state: {
		stagingSelections: StagingSelectionItem[];
		focusedMessageIdx: number | undefined; // index of the user message that is being edited (undefined if none)

		linksOfMessageIdx: { // eg. link = linksOfMessageIdx[4]['RangeFunction']
			[messageIdx: number]: {
				[codespanName: string]: CodespanLocationLink
			}
		}
		agentInstructionTurnSnapshot?: AgentRuntimeTurnSnapshot;


		mountedInfo?: {
			whenMounted: Promise<WhenMounted>
			_whenMountedResolver: (res: WhenMounted) => void
			mountedIsResolvedRef: { current: boolean };
		}


	};
}

type ChatThreads = {
	[id: string]: undefined | ThreadType;
}


export type ThreadsState = {
	allThreads: ChatThreads;
	currentThreadId: string; // intended for internal use only
}

export type IsRunningType =
	| 'LLM' // the LLM is currently streaming
	| 'tool' // whether a tool is currently running
	| 'awaiting_user' // awaiting user call
	| 'idle' // nothing is running now, but the chat should still appear like it's going (used in-between calls)
	| undefined

export type ThreadStreamState = {
	[threadId: string]: undefined | {
		isRunning: undefined;
		error?: { message: string, fullError: Error | null, };
		llmInfo?: undefined;
		toolInfo?: undefined;
		interrupt?: undefined;
	} | { // an assistant message is being written
		isRunning: 'LLM';
		error?: undefined;
		llmInfo: {
			displayContentSoFar: string;
			reasoningSoFar: string;
			toolCallSoFar: RawToolCallObj | null;
		};
		toolInfo?: undefined;
		interrupt: Promise<() => void>; // calling this should have no effect on state - would be too confusing. it just cancels the tool
	} | { // a tool is being run
		isRunning: 'tool';
		error?: undefined;
		llmInfo?: undefined;
		toolInfo: {
			toolName: ToolName;
			toolParams: ToolCallParams<ToolName>;
			id: string;
			content: string;
			rawParams: RawToolParamsObj;
			mcpServerName: string | undefined;
		};
		interrupt: Promise<() => void>;
	} | {
		isRunning: 'awaiting_user';
		error?: undefined;
		llmInfo?: undefined;
		toolInfo?: undefined;
		interrupt?: undefined;
	} | {
		isRunning: 'idle';
		error?: undefined;
		llmInfo?: undefined;
		toolInfo?: undefined;
		interrupt: 'not_needed' | Promise<() => void>; // calling this should have no effect on state - would be too confusing. it just cancels the tool
	}
}

const newThreadObject = () => {
	const now = new Date().toISOString()
	return {
		id: generateUuid(),
		createdAt: now,
		lastModified: now,
		messages: [],
		state: {
			stagingSelections: [],
			focusedMessageIdx: undefined,
			linksOfMessageIdx: {},
		},
		filesWithUserChanges: new Set()
	} satisfies ThreadType
}






export interface IChatThreadService {
	readonly _serviceBrand: undefined;

	readonly state: ThreadsState;
	readonly streamState: ThreadStreamState; // not persistent

	onDidChangeCurrentThread: Event<void>;
	onDidChangeStreamState: Event<{ threadId: string }>

	getCurrentThread(): ThreadType;
	openNewThread(): void;
	switchToThread(threadId: string): void;

	// thread selector
	deleteThread(threadId: string): void;
	duplicateThread(threadId: string): void;
	getTransientComposerDraft(threadId: string): string;
	setTransientComposerDraft(threadId: string, draft: string): void;
	clearTransientComposerDraft(threadId: string): void;
	clearSubmittedComposerState(threadId: string): void;

	// exposed getters/setters
	// these all apply to current thread
	getCurrentMessageState: (messageIdx: number) => UserMessageState
	setCurrentMessageState: (messageIdx: number, newState: Partial<UserMessageState>) => void
	getCurrentThreadState: () => ThreadType['state']
	setCurrentThreadState: (newState: Partial<ThreadType['state']>) => void

	// you can edit multiple messages - the one you're currently editing is "focused", and we add items to that one when you press cmd+L.
	getCurrentFocusedMessageIdx(): number | undefined;
	isCurrentlyFocusingMessage(): boolean;
	setCurrentlyFocusedMessageIdx(messageIdx: number | undefined): void;

	popStagingSelections(numPops?: number): void;
	addNewStagingSelection(newSelection: StagingSelectionItem): void;
	getSkillCatalog(threadId?: string): Promise<import('../common/agentSkills.js').AgentSkillCatalog>;
	getCustomAgentCatalog(threadId?: string, token?: CancellationToken): Promise<CustomAgentCatalog>;

	dangerousSetState: (newState: ThreadsState) => void;
	resetState: () => void;

	// // current thread's staging selections
	// closeCurrentStagingSelectionsInMessage(opts: { messageIdx: number }): void;
	// closeCurrentStagingSelectionsInThread(): void;

	// codespan links (link to symbols in the markdown)
	getCodespanLink(opts: { codespanStr: string, messageIdx: number, threadId: string }): CodespanLocationLink | undefined;
	addCodespanLink(opts: { newLinkText: string, newLinkLocation: CodespanLocationLink, messageIdx: number, threadId: string }): void;
	generateCodespanLink(opts: { codespanStr: string, threadId: string }): Promise<CodespanLocationLink>;
	getRelativeStr(uri: URI): string | undefined

	// entry pts
	abortRunning(threadId: string): Promise<void>;
	dismissStreamError(threadId: string): void;

	// call to edit a message
	editUserMessageAndStreamResponse({ userMessage, messageIdx, threadId }: { userMessage: string, messageIdx: number, threadId: string }): Promise<void>;

	// call to add a message
	addUserMessageAndStreamResponse({ userMessage, threadId }: { userMessage: string, threadId: string }): Promise<boolean>;

	// approve/reject
	approveLatestToolRequest(threadId: string): void;
	rejectLatestToolRequest(threadId: string): void;

	focusCurrentChat: () => Promise<void>
	blurCurrentChat: () => Promise<void>
}

export const IChatThreadService = createDecorator<IChatThreadService>('voidChatThreadService');
export class ChatThreadService extends Disposable implements IChatThreadService {
	_serviceBrand: undefined;

	// this fires when the current thread changes at all (a switch of currentThread, or a message added to it, etc)
	private readonly _onDidChangeCurrentThread = new Emitter<void>();
	readonly onDidChangeCurrentThread: Event<void> = this._onDidChangeCurrentThread.event;

	private readonly _onDidChangeStreamState = new Emitter<{ threadId: string }>();
	readonly onDidChangeStreamState: Event<{ threadId: string }> = this._onDidChangeStreamState.event;

	readonly streamState: ThreadStreamState = {}
	state: ThreadsState // allThreads is persisted, currentThread is not

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
		@IVoidModelService private readonly _voidModelService: IVoidModelService,
		@ILLMMessageService private readonly _llmMessageService: ILLMMessageService,
		@IToolsService private readonly _toolsService: IToolsService,
		@IVoidSettingsService private readonly _settingsService: IVoidSettingsService,
		@ILanguageFeaturesService private readonly _languageFeaturesService: ILanguageFeaturesService,
		@IMetricsService private readonly _metricsService: IMetricsService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IConvertToLLMMessageService private readonly _convertToLLMMessagesService: IConvertToLLMMessageService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IWorkspaceTrustManagementService private readonly _workspaceTrustManagementService: IWorkspaceTrustManagementService,
		@IDirectoryStrService private readonly _directoryStringService: IDirectoryStrService,
		@IFileService private readonly _fileService: IFileService,
		@IMCPService private readonly _mcpService: IMCPService,
		@IAgentInstructionsService private readonly _agentInstructionsService: IAgentInstructionsService,
		@IAgentSkillsService private readonly _agentSkillsService: IAgentSkillsService,
		@IAgentCustomAgentService private readonly _agentCustomAgentService: IAgentCustomAgentService,
		@IAgentSubagentService private readonly _agentSubagentService: IAgentSubagentService,
	) {
		super()
		this.state = { allThreads: {}, currentThreadId: null as unknown as string } // default state

		const readThreads = this._readAllThreads() || {}

		const allThreads = readThreads
		this.state = {
			allThreads: allThreads,
			currentThreadId: null as unknown as string, // gets set in startNewThread()
		}
		this._restoreInstructionTurns(allThreads)
		this._storeAllThreads(allThreads)

		// always be in a thread
		this.openNewThread()

	}

	// Config is task/session scoped; a turn snapshot is deliberately refreshed only for a user turn.
	private readonly _agentInstructionSessionOfThread = new Map<string, AgentInstructionTaskSessionRecord>();
	private readonly _instructionTurnOfThread = new Map<string, AgentRuntimeTurnSnapshot>();
	private readonly _agentControlGeneration = new Map<string, number>();
	private readonly _agentDelegationAuthorityOfThread = new Map<string, AgentDelegationTurnAuthority>();
	private readonly _transientComposerDraftOfThread = new Map<string, string>();
	getTransientComposerDraft(threadId: string): string { return this.state.allThreads[threadId] ? this._transientComposerDraftOfThread.get(threadId) ?? '' : '' }
	setTransientComposerDraft(threadId: string, draft: string): void {
		if (!draft) { this.clearTransientComposerDraft(threadId); return }
		if (!this.state.allThreads[threadId]) return
		this._transientComposerDraftOfThread.set(threadId, draft)
	}
	clearTransientComposerDraft(threadId: string): void { this._transientComposerDraftOfThread.delete(threadId) }
	clearSubmittedComposerState(threadId: string): void {
		this.clearTransientComposerDraft(threadId)
		this._setThreadState(threadId, { stagingSelections: [] }, true)
	}
	async getSkillCatalog(threadId = this.state.currentThreadId) {
		const owner = this._workspaceContextService.getWorkspace().folders[0]?.uri.toString();
		let record = this._agentInstructionSessionOfThread.get(threadId);
		if (record && record.ownerProjectRoot !== owner) throw new Error('skill_owner_or_trust_changed');
		if (!record) { const session = new AgentInstructionTaskSession(() => this._agentInstructionsService.beginTaskSession(), config => this._agentInstructionsService.beginTopLevelTurn(config)); record = { ownerProjectRoot: owner, trustedAtStart: this._workspaceTrustManagementService.isWorkspaceTrusted(), session }; this._agentInstructionSessionOfThread.set(threadId, record); }
		const config = await record.session.getConfig();
		if (this._workspaceContextService.getWorkspace().folders[0]?.uri.toString() !== owner || (record.trustedAtStart && !this._workspaceTrustManagementService.isWorkspaceTrusted())) { this._agentInstructionSessionOfThread.delete(threadId); throw new Error('skill_owner_or_trust_changed'); }
		return this._agentSkillsService.getCatalog(owner ? URI.parse(owner) : undefined, owner ? URI.parse(owner) : undefined, config);
	}
	async getCustomAgentCatalog(_threadId = this.state.currentThreadId, token = CancellationToken.None): Promise<CustomAgentCatalog> {
		const owner = this._workspaceContextService.getWorkspace().folders[0]?.uri;
		return this._agentCustomAgentService.getCatalog(owner, owner, token);
	}
	private async _beginInstructionTurn(threadId: string): Promise<AgentInstructionTurnSnapshot> {
		const currentOwner = this._workspaceContextService.getWorkspace().folders[0]?.uri.toString()
		const trustedNow = this._workspaceTrustManagementService.isWorkspaceTrusted()
		let record = this._agentInstructionSessionOfThread.get(threadId);
		const remembered = this._instructionTurnOfThread.get(threadId)
		if ((record && record.ownerProjectRoot !== currentOwner) || (remembered && remembered.ownerProjectRoot !== currentOwner)) {
			this._purgeInstructionTurn(threadId, false)
			throw new Error('This task belongs to a different workspace. Start a new task to continue in the current workspace.')
		}
		// Losing trust starts a new top-level task session so project config is not retained.
		if (record?.trustedAtStart && !trustedNow) {
			this._purgeInstructionTurn(threadId)
			record = undefined
		}
		if (!record) {
			const session = new AgentInstructionTaskSession(
				() => this._agentInstructionsService.beginTaskSession(),
				config => this._agentInstructionsService.beginTopLevelTurn(config),
			);
			record = { ownerProjectRoot: currentOwner, trustedAtStart: trustedNow, session };
			this._agentInstructionSessionOfThread.set(threadId, record);
		}
		const snapshot = await record.session.beginTopLevelTurn();
		const currentOwnerAfterLoad = this._workspaceContextService.getWorkspace().folders[0]?.uri.toString()
		const trustedAfterLoad = this._workspaceTrustManagementService.isWorkspaceTrusted()
		const ownerMatches = snapshot.ownerProjectRoot === record.ownerProjectRoot
			&& snapshot.runCwd === record.ownerProjectRoot
			&& snapshot.ownerProjectRoot === currentOwnerAfterLoad
			&& snapshot.runCwd === currentOwnerAfterLoad
		if (!ownerMatches) {
			this._purgeInstructionTurn(threadId, false)
			throw new Error('This task belongs to a different workspace. Start a new task to continue in the current workspace.')
		}
		const hasProjectConfig = snapshot.config.configSources.some(source => source.scope === 'project')
		if ((record.trustedAtStart && !trustedAfterLoad) || (!trustedAfterLoad && hasProjectConfig)) {
			this._purgeInstructionTurn(threadId)
			throw new Error('Workspace trust changed while instructions were loading. Send the message again to start a user-only session.')
		}
		return snapshot;
	}
	private _purgeInstructionTurn(threadId: string, removeSession = true) {
		if (removeSession) this._agentInstructionSessionOfThread?.delete(threadId)
		this._instructionTurnOfThread?.delete(threadId)
		const thread = this.state.allThreads[threadId]
		if (!thread) return
		delete thread.state.agentInstructionTurnSnapshot
		// Persist security metadata removal before a later provider or tool action.
		this._storeAllThreads?.(this.state.allThreads)
	}
	private _restoreInstructionTurns(threads: ChatThreads) {
		this._instructionTurnOfThread.clear()
		this._agentDelegationAuthorityOfThread?.clear()
		const currentOwner = this._workspaceContextService.getWorkspace().folders[0]?.uri.toString()
		for (const [id, thread] of Object.entries(threads)) {
			if (!thread) continue
			const snapshot = reviveAgentRuntimeTurnSnapshot(thread.state.agentInstructionTurnSnapshot)
			if (snapshot && snapshot.ownerProjectRoot === currentOwner && snapshot.runCwd === currentOwner && snapshot.workspaceTrustedAtAdmission === this._workspaceTrustManagementService.isWorkspaceTrusted()) {
				thread.state.agentInstructionTurnSnapshot = snapshot
				this._instructionTurnOfThread.set(id, snapshot)
			}
			else {
				delete thread.state.agentInstructionTurnSnapshot
			}
		}
	}
	private _rememberInstructionTurn(threadId: string, snapshot: AgentRuntimeTurnSnapshot) {
		this._instructionTurnOfThread.set(threadId, snapshot)
		const thread = this.state.allThreads[threadId]
		if (!thread) return
		// Persist this non-UI metadata before provider/tool work can begin.
		thread.state.agentInstructionTurnSnapshot = snapshot
		this._storeAllThreads(this.state.allThreads)
	}

	async focusCurrentChat() {
		const threadId = this.state.currentThreadId
		const thread = this.state.allThreads[threadId]
		if (!thread) return
		const s = await thread.state.mountedInfo?.whenMounted
		if (!this.isCurrentlyFocusingMessage()) {
			s?.textAreaRef.current?.focus()
		}
	}
	async blurCurrentChat() {
		const threadId = this.state.currentThreadId
		const thread = this.state.allThreads[threadId]
		if (!thread) return
		const s = await thread.state.mountedInfo?.whenMounted
		if (!this.isCurrentlyFocusingMessage()) {
			s?.textAreaRef.current?.blur()
		}
	}



	dangerousSetState(newState: ThreadsState) {
		for (const threadId of Object.keys(this.state.allThreads)) this._agentSubagentService.forgetParent(threadId)
		this._agentDelegationAuthorityOfThread.clear()
		this._agentControlGeneration.clear()
		this._agentInstructionSessionOfThread.clear()
		this._transientComposerDraftOfThread.clear()
		this._restoreInstructionTurns(newState.allThreads)
		this.state = newState
		this._onDidChangeCurrentThread.fire()
	}
	resetState() {
		for (const threadId of Object.keys(this.state.allThreads)) this._agentSubagentService.forgetParent(threadId)
		this._agentInstructionSessionOfThread.clear()
		this._instructionTurnOfThread.clear()
		this._agentDelegationAuthorityOfThread.clear()
		this._agentControlGeneration.clear()
		this._transientComposerDraftOfThread.clear()
		this.state = { allThreads: {}, currentThreadId: null as unknown as string } // see constructor
		this.openNewThread()
		this._onDidChangeCurrentThread.fire()
	}

	// !!! this is important for properly restoring URIs from storage
	// should probably re-use code from void/src/vs/base/common/marshalling.ts instead. but this is simple enough
	private _convertThreadDataFromStorage(threadsStr: string): ChatThreads {
		const threads = JSON.parse(threadsStr, (key, value) => {
			if (value && typeof value === 'object' && value.$mid === 1) { // $mid is the MarshalledId. $mid === 1 means it is a URI
				return URI.from(value); // TODO URI.revive instead of this?
			}
			return value;
		});

		for (const thread of Object.values(threads)) {
			if (!thread) continue
			const legacyThread = thread as ThreadType & {
				state: ThreadType['state'] & { currCheckpointIdx?: number | null };
			};
			const legacyMessages = legacyThread.messages as unknown[];
			legacyThread.messages = legacyMessages.filter((message): message is ChatMessage => {
				return !(typeof message === 'object' && message !== null && (message as { role?: unknown }).role === 'checkpoint');
			});
			delete legacyThread.state.currCheckpointIdx;
		}

		return threads;
	}

	private _readAllThreads(): ChatThreads | null {
		const threadsStr = this._storageService.get(THREAD_STORAGE_KEY, StorageScope.APPLICATION);
		if (!threadsStr) {
			return null
		}
		const threads = this._convertThreadDataFromStorage(threadsStr);
		this._storeAllThreads(threads);
		return threads
	}

	private _storeAllThreads(threads: ChatThreads) {
		const serializedThreads = JSON.stringify(threads);
		this._storageService.store(
			THREAD_STORAGE_KEY,
			serializedThreads,
			StorageScope.APPLICATION,
			StorageTarget.USER
		);
	}


	// this should be the only place this.state = ... appears besides constructor
	private _setState(state: Partial<ThreadsState>, doNotRefreshMountInfo?: boolean) {
		const newState = {
			...this.state,
			...state
		}

		this.state = newState

		this._onDidChangeCurrentThread.fire()


		// if we just switched to a thread, update its current stream state if it's not streaming to possibly streaming
		const threadId = newState.currentThreadId
		const streamState = this.streamState[threadId]
		if (streamState?.isRunning === undefined && !streamState?.error) {

			// set streamState
			const messages = newState.allThreads[threadId]?.messages
			const lastMessage = messages && messages[messages.length - 1]
			// if awaiting user but stream state doesn't indicate it (happens if restart Void)
			if (lastMessage && lastMessage.role === 'tool' && lastMessage.type === 'tool_request')
				this._setStreamState(threadId, { isRunning: 'awaiting_user', })

			// if running now but stream state doesn't indicate it (happens if restart Void), cancel that last tool
			if (lastMessage && lastMessage.role === 'tool' && lastMessage.type === 'running_now') {

				this._updateLatestTool(threadId, { role: 'tool', type: 'rejected', content: lastMessage.content, id: lastMessage.id, rawParams: lastMessage.rawParams, result: null, name: lastMessage.name, params: lastMessage.params, mcpServerName: lastMessage.mcpServerName })
			}

		}


		// if we did not just set the state to true, set mount info
		if (doNotRefreshMountInfo) return

		let whenMountedResolver: (w: WhenMounted) => void
		const whenMountedPromise = new Promise<WhenMounted>((res) => whenMountedResolver = res)

		this._setThreadState(threadId, {
			mountedInfo: {
				whenMounted: whenMountedPromise,
				mountedIsResolvedRef: { current: false },
				_whenMountedResolver: (w: WhenMounted) => {
					whenMountedResolver(w)
					const mountInfo = this.state.allThreads[threadId]?.state.mountedInfo
					if (mountInfo) mountInfo.mountedIsResolvedRef.current = true
				},
			}
		}, true) // do not trigger an update



	}


	private _setStreamState(threadId: string, state: ThreadStreamState[string]) {
		this.streamState[threadId] = state
		this._onDidChangeStreamState.fire({ threadId })
	}


	// ---------- streaming ----------



	private _currentModelSelectionProps = () => {
		// these settings should not change throughout the loop (eg anthropic breaks if you change its thinking mode and it's using tools)
		const featureName: FeatureName = 'Chat'
		const modelSelection = this._settingsService.state.modelSelectionOfFeature[featureName]
		const modelSelectionOptions = modelSelection ? this._settingsService.state.optionsOfModelSelection[featureName][modelSelection.providerName]?.[modelSelection.modelName] : undefined
		return { modelSelection, modelSelectionOptions }
	}



	private _swapOutLatestStreamingToolWithResult = (threadId: string, tool: ChatMessage & { role: 'tool' }) => {
		const messages = this.state.allThreads[threadId]?.messages
		if (!messages) return false
		const lastMsg = messages[messages.length - 1]
		if (!lastMsg) return false

		if (lastMsg.role === 'tool' && lastMsg.type !== 'invalid_params') {
			this._editMessageInThread(threadId, messages.length - 1, tool)
			return true
		}
		return false
	}
	private _updateLatestTool = (threadId: string, tool: ChatMessage & { role: 'tool' }) => {
		const swapped = this._swapOutLatestStreamingToolWithResult(threadId, tool)
		if (swapped) return
		this._addMessageToThread(threadId, tool)
	}

	approveLatestToolRequest(threadId: string) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return // should never happen

		const lastMsg = thread.messages[thread.messages.length - 1]
		if (!(lastMsg.role === 'tool' && lastMsg.type === 'tool_request')) return // should never happen

		const callThisToolFirst: ToolMessage<ToolName> = lastMsg
		const snapshot = this._instructionTurnOfThread.get(threadId)
		const currentOwner = this._workspaceContextService.getWorkspace().folders[0]?.uri.toString()
		if (!snapshot || snapshot.ownerProjectRoot !== currentOwner || snapshot.runCwd !== currentOwner || snapshot.workspaceTrustedAtAdmission !== this._workspaceTrustManagementService.isWorkspaceTrusted()) {
			this._purgeInstructionTurn(threadId)
			const content = 'This tool request cannot resume because the current workspace or trust context no longer matches its instruction snapshot. Send a new message in a new task to continue.'
			this._updateLatestTool(threadId, { role: 'tool', type: 'rejected', params: lastMsg.params, name: lastMsg.name, content, result: null, id: lastMsg.id, rawParams: lastMsg.rawParams, mcpServerName: lastMsg.mcpServerName })
			this._setStreamState(threadId, undefined)
			return
		}
		const currentProps = this._currentModelSelectionProps(); const selectedModel = currentProps.modelSelection
		const currentContext = selectedModel ? getModelCapabilities(selectedModel.providerName, selectedModel.modelName, this._settingsService.state.overridesOfModel).contextWindow : 0
		const currentReserve = selectedModel ? Math.max(Math.ceil(currentContext / 2), getReservedOutputTokenSpace(selectedModel.providerName, selectedModel.modelName, { isReasoningEnabled: getIsReasoningEnabledState('Chat', selectedModel.providerName, selectedModel.modelName, currentProps.modelSelectionOptions, this._settingsService.state.overridesOfModel), overridesOfModel: this._settingsService.state.overridesOfModel }) ?? 4096) : 0
		const currentOverride = selectedModel ? this._settingsService.state.overridesOfModel[selectedModel.providerName]?.[selectedModel.modelName] ?? {} : {};
		if (!snapshot.model.hasModel || !selectedModel || selectedModel.providerName !== snapshot.model.providerName || selectedModel.modelName !== snapshot.model.modelName || runtimeModelFingerprint({ providerName: selectedModel.providerName, modelName: selectedModel.modelName, contextWindow: currentContext, reservedOutputTokens: currentReserve, modelSelectionOptions: currentProps.modelSelectionOptions ?? {}, selectedModelOverrides: currentOverride as never }) !== snapshot.model.fingerprint) {
			this._purgeInstructionTurn(threadId)
			this._updateLatestTool(threadId, { role: 'tool', type: 'rejected', params: lastMsg.params, name: lastMsg.name, content: 'This tool request cannot resume because its admitted model changed. Send a new message.', result: null, id: lastMsg.id, rawParams: lastMsg.rawParams, mcpServerName: lastMsg.mcpServerName })
			this._setStreamState(threadId, undefined)
			return
		}

		this._wrapRunAgentToNotify(
			this._runChatAgent({ callThisToolFirst, threadId, instructionSnapshot: snapshot, modelSelection: { providerName: snapshot.model.providerName as ModelSelection['providerName'], modelName: snapshot.model.modelName }, modelSelectionOptions: snapshot.model.modelSelectionOptions as ModelSelectionOptions, agentDelegationAuthority: this._agentDelegationAuthorityOfThread?.get(threadId) })
			, threadId
		)
	}
	rejectLatestToolRequest(threadId: string) {
		this._agentDelegationAuthorityOfThread.delete(threadId)
		const thread = this.state.allThreads[threadId]
		if (!thread) return // should never happen

		const lastMsg = thread.messages[thread.messages.length - 1]

		let params: ToolCallParams<ToolName>
		if (lastMsg.role === 'tool' && lastMsg.type !== 'invalid_params') {
			params = lastMsg.params
		}
		else return

		const { name, id, rawParams, mcpServerName } = lastMsg

		const errorMessage = this.toolErrMsgs.rejected
		this._updateLatestTool(threadId, { role: 'tool', type: 'rejected', params: params, name: name, content: errorMessage, result: null, id, rawParams, mcpServerName })
		this._setStreamState(threadId, undefined)
	}

	private _computeMCPServerOfToolName(toolName: string) {
		if (isAgentSubagentControlName(toolName) || isReadSkillResourceToolName(toolName)) return undefined
		return this._mcpService.getMCPTools()?.find(t => t.name === toolName)?.mcpServerName
	}

	async abortRunning(threadId: string) {
		this._agentControlGeneration.set(threadId, (this._agentControlGeneration.get(threadId) ?? 0) + 1)
		this._agentDelegationAuthorityOfThread.delete(threadId)
		this._agentSubagentService.cancelParent(threadId)
		const thread = this.state.allThreads[threadId]
		if (!thread) return // should never happen

		// add assistant message
		if (this.streamState[threadId]?.isRunning === 'LLM') {
			const { displayContentSoFar, reasoningSoFar, toolCallSoFar } = this.streamState[threadId].llmInfo
			this._addMessageToThread(threadId, { role: 'assistant', displayContent: displayContentSoFar, reasoning: reasoningSoFar, anthropicReasoning: null })
			if (toolCallSoFar) this._addMessageToThread(threadId, { role: 'interrupted_streaming_tool', name: toolCallSoFar.name, mcpServerName: this._computeMCPServerOfToolName(toolCallSoFar.name) })
		}
		// add tool that's running
		else if (this.streamState[threadId]?.isRunning === 'tool') {
			const { toolName, toolParams, id, content: content_, rawParams, mcpServerName } = this.streamState[threadId].toolInfo
			const content = content_ || this.toolErrMsgs.interrupted
			this._updateLatestTool(threadId, { role: 'tool', name: toolName, params: toolParams, id, content, rawParams, type: 'rejected', result: null, mcpServerName })
		}
		// reject the tool for the user if relevant
		else if (this.streamState[threadId]?.isRunning === 'awaiting_user') {
			this.rejectLatestToolRequest(threadId)
		}
		else if (this.streamState[threadId]?.isRunning === 'idle') {
			// do nothing
		}

		// interrupt any effects
		const interrupt = await this.streamState[threadId]?.interrupt
		if (typeof interrupt === 'function')
			interrupt()


		this._setStreamState(threadId, undefined)
	}



	private readonly toolErrMsgs = {
		rejected: 'Tool call was rejected by the user.',
		interrupted: 'Tool call was interrupted by the user.',
		errWhenStringifying: (error: any) => `Tool call succeeded, but there was an error stringifying the output.\n${getErrorMessage(error)}`
	}


	// private readonly _currentlyRunningToolInterruptor: { [threadId: string]: (() => void) | undefined } = {}


	// returns true when the tool call is waiting for user approval
	private async _runToolCall(
		threadId: string,
		toolName: ToolName,
		toolId: string,
		mcpServerName: string | undefined,
		opts: { preapproved: true, unvalidatedToolParams: RawToolParamsObj, validatedParams: ToolCallParams<ToolName> } | { preapproved: false, unvalidatedToolParams: RawToolParamsObj },
		instructionSnapshot: AgentRuntimeTurnSnapshot,
		agentDelegationAuthority?: AgentDelegationTurnAuthority,
		agentSkillResourceReadAllowed = false,
		agentRunGeneration?: number,
	): Promise<{ awaitingUserApproval?: boolean, interrupted?: boolean }> {

		// compute these below
		let toolParams: ToolCallParams<ToolName>
		let toolResult: ToolResult<ToolName>
		let toolResultStr: string

		// Check if it's a built-in tool
		const isBuiltInTool = isABuiltinToolName(toolName)
		if (toolName === 'edit_file' || toolName === 'rewrite_file') {
			const message = `${toolName} is no longer supported; use write_file with native structured arguments.`
			this._addMessageToThread(threadId, { role: 'tool', type: 'invalid_params', rawParams: opts.unvalidatedToolParams, result: null, name: toolName, content: message, id: toolId, mcpServerName })
			return {}
		}
		// This application read is deliberately not a builtin or MCP call. It is
		// parent-Agent-only, never asks for approval, and resolves authority only
		// from the immutable selected entries of this exact runtime snapshot.
		if (isReadSkillResourceToolName(toolName)) {
			const sameGeneration = () => agentRunGeneration !== undefined && (this._agentControlGeneration.get(threadId) ?? 0) === agentRunGeneration;
			if (!sameGeneration()) return { interrupted: true };
			const currentOwnerAndTrustMatch = () => {
				const currentOwner = this._workspaceContextService.getWorkspace().folders[0]?.uri.toString();
				return instructionSnapshot.ownerProjectRoot === currentOwner && instructionSnapshot.runCwd === currentOwner && instructionSnapshot.workspaceTrustedAtAdmission === this._workspaceTrustManagementService.isWorkspaceTrusted();
			};
			const sameRememberedSnapshot = () => this._instructionTurnOfThread.get(threadId) === instructionSnapshot;
			const sameResourceAuthority = () => sameGeneration() && sameRememberedSnapshot() && currentOwnerAndTrustMatch();
			const addFailure = (type: 'invalid_params' | 'tool_error', content: string) => {
				if (type === 'invalid_params') this._addMessageToThread(threadId, { role: 'tool', type, rawParams: opts.unvalidatedToolParams, result: null, name: toolName, content, id: toolId, mcpServerName: undefined });
				else this._addMessageToThread(threadId, { role: 'tool', type, rawParams: opts.unvalidatedToolParams, params: opts.unvalidatedToolParams, result: content, name: toolName, content, id: toolId, mcpServerName: undefined });
			};
			if (!sameResourceAuthority()) {
				if (sameRememberedSnapshot()) this._purgeInstructionTurn(threadId);
				if (this.state.allThreads[threadId] && !this._instructionTurnOfThread.has(threadId)) addFailure('tool_error', 'skill_owner_or_trust_changed');
				return { interrupted: true };
			}
			if (!agentSkillResourceReadAllowed) { addFailure('invalid_params', 'read_skill_resource_not_available'); return {}; }
			let params: ReturnType<typeof validateReadSkillResourceToolParams>;
			try { params = validateReadSkillResourceToolParams(opts.unvalidatedToolParams); }
			catch (error) { addFailure('invalid_params', getErrorMessage(error)); return {}; }
			const selection = instructionSnapshot.selected.find(item => item.identity === params.skill);
			if (!selection) { addFailure('tool_error', 'skill_not_selected'); return {}; }
			const historyAtRead = this.state.allThreads[threadId]?.messages ?? [];
			const maxReadOutputTokens = instructionSnapshot.model.hasModel
				? computeMaxReadOutputTokens(instructionSnapshot.model.contextWindow, instructionSnapshot.model.reservedOutputTokens, estimateHistoryTokensForReadBudget(historyAtRead))
				: 0;
			const exactInputBudgetChars = instructionSnapshot.model.hasModel ? Math.max(0, instructionSnapshot.model.contextWindow - instructionSnapshot.model.reservedOutputTokens) * 4 : 0;
			const protectedCharsRemaining = Math.max(0, exactInputBudgetChars - assembleProtectedAgentAuthority(instructionSnapshot).length - protectedSkillResourceHistoryLength(historyAtRead));
			const maxResourceChars = Math.min(maxReadOutputTokens * 4, protectedCharsRemaining);
			const maxResourceBytes = maxResourceChars > 0 ? Math.min(Number.MAX_SAFE_INTEGER, maxResourceChars * 3 + 3) : 0;
			const applicationParams = opts.unvalidatedToolParams;
			if (!sameResourceAuthority()) return { interrupted: true };
			this._updateLatestTool(threadId, { role: 'tool', type: 'running_now', name: toolName, params: applicationParams, content: '(value not received yet...)', result: null, id: toolId, rawParams: applicationParams, mcpServerName: undefined });
			let interrupted = false;
			const readCancellation = new CancellationTokenSource();
			let resolveInterruptor: (interruptor: () => void) => void = () => { };
			const interruptorPromise = new Promise<() => void>(resolve => { resolveInterruptor = resolve; });
			this._setStreamState(threadId, { isRunning: 'tool', interrupt: interruptorPromise, toolInfo: { toolName, toolParams: applicationParams, id: toolId, content: 'interrupted...', rawParams: applicationParams, mcpServerName: undefined } });
			resolveInterruptor(() => { interrupted = true; readCancellation.cancel(); });
			try {
				const cancelled = Object.freeze({ cancelled: true as const });
				const cancellationRace = new Promise<typeof cancelled>(resolve => readCancellation.token.onCancellationRequested(() => resolve(cancelled)));
				const read = await Promise.race([this._agentSkillsService.readSkillResource(selection, params.resourcePath, { maxResourceBytes, token: readCancellation.token }), cancellationRace]);
				if ('cancelled' in read || interrupted || !sameGeneration()) return { interrupted: true };
				if (!sameResourceAuthority()) {
					if (sameRememberedSnapshot()) {
						this._purgeInstructionTurn(threadId);
						this._updateLatestTool(threadId, { role: 'tool', type: 'tool_error', params: applicationParams, result: 'skill_owner_or_trust_changed', name: toolName, content: 'skill_owner_or_trust_changed', id: toolId, rawParams: applicationParams, mcpServerName: undefined });
					}
					return { interrupted: true };
				}
				if (read.body === undefined) throw new Error(read.diagnostic?.code ?? 'skill_resource_unreadable');
				const resource = admitSkillResourceContext(read.body, maxReadOutputTokens);
				const successMessage: ChatMessage & { role: 'tool' } = { role: 'tool', type: 'success', params: applicationParams, result: resource as never, name: toolName, content: resource, id: toolId, rawParams: applicationParams, mcpServerName: undefined };
				const currentMessages = this.state.allThreads[threadId]?.messages ?? [];
				const prospectiveMessages = [...currentMessages];
				if (prospectiveMessages[prospectiveMessages.length - 1]?.role === 'tool' && (prospectiveMessages[prospectiveMessages.length - 1] as ToolMessage<ToolName>).id === toolId) prospectiveMessages[prospectiveMessages.length - 1] = successMessage;
				else prospectiveMessages.push(successMessage);
				try {
					if (!instructionSnapshot.model.hasModel) throw new Error('skill_resource_context_admission_failed');
					await this._convertToLLMMessagesService.prepareLLMChatMessages({ chatMessages: prospectiveMessages, chatMode: 'agent', modelSelection: { providerName: instructionSnapshot.model.providerName as ModelSelection['providerName'], modelName: instructionSnapshot.model.modelName }, instructionSnapshot, agentDelegationAllowed: !!agentDelegationAuthority?.allowed });
				} catch { throw new Error('skill_resource_context_admission_failed'); }
				if (interrupted || !sameGeneration()) return { interrupted: true };
				if (!sameResourceAuthority()) {
					if (sameRememberedSnapshot()) {
						this._purgeInstructionTurn(threadId);
						this._updateLatestTool(threadId, { role: 'tool', type: 'tool_error', params: applicationParams, result: 'skill_owner_or_trust_changed', name: toolName, content: 'skill_owner_or_trust_changed', id: toolId, rawParams: applicationParams, mcpServerName: undefined });
					}
					return { interrupted: true };
				}
				this._updateLatestTool(threadId, successMessage);
				return {};
			} catch (error) {
				if (interrupted || !sameGeneration()) return { interrupted: true };
				if (!sameResourceAuthority()) {
					if (sameRememberedSnapshot()) {
						this._purgeInstructionTurn(threadId);
						this._updateLatestTool(threadId, { role: 'tool', type: 'tool_error', params: applicationParams, result: 'skill_owner_or_trust_changed', name: toolName, content: 'skill_owner_or_trust_changed', id: toolId, rawParams: applicationParams, mcpServerName: undefined });
					}
					return { interrupted: true };
				}
				const errorMessage = getErrorMessage(error);
				const content = errorMessage.includes('skill_resource_context_admission_failed') ? 'skill_resource_context_admission_failed' : errorMessage;
				this._updateLatestTool(threadId, { role: 'tool', type: 'tool_error', params: applicationParams, result: content, name: toolName, content, id: toolId, rawParams: applicationParams, mcpServerName: undefined });
				return {};
			} finally {
				readCancellation.dispose();
			}
		}
		// These application controls are intentionally routed before builtin/MCP
		// classification. Their exact-key validation is authoritative and they never ask
		// for approval or fall through to a server named like a control tool.
		if (isAgentSubagentControlName(toolName)) {
			const currentAuthority = this._agentDelegationAuthorityOfThread?.get(threadId)
			const currentGeneration = this._agentControlGeneration.get(threadId) ?? 0
			if (!agentDelegationAuthority?.allowed || currentAuthority !== agentDelegationAuthority || agentDelegationAuthority.generation !== currentGeneration) {
				const content = 'agent_delegation_not_authorized: select @Agent in the current top-level turn before using child controls.';
				this._addMessageToThread(threadId, { role: 'tool', type: 'invalid_params', rawParams: opts.unvalidatedToolParams, result: null, name: toolName, content, id: toolId, mcpServerName: undefined });
				return {};
			}
			const controlGeneration = agentDelegationAuthority.generation;
			const isControlCurrent = () => this._agentDelegationAuthorityOfThread?.get(threadId) === agentDelegationAuthority && (this._agentControlGeneration.get(threadId) ?? 0) === controlGeneration;
			try {
				const control = validateAgentSubagentControlParams(toolName, opts.unvalidatedToolParams);
				let result: object;
				if (control.name === 'spawn_agent') result = await this._agentSubagentService.spawn(threadId, control.message, instructionSnapshot, control.agentType, agentDelegationAuthority.roles, agentDelegationAuthority.settingsState, agentDelegationAuthority.settingsOfProvider, controlGeneration);
				else if (control.name === 'wait_agent') result = await this._agentSubagentService.wait(threadId, control.timeoutMs, control.targets, controlGeneration);
				else result = this._agentSubagentService.interrupt(threadId, control.target, controlGeneration);
				if (!isControlCurrent()) return { interrupted: true };
				const content = JSON.stringify(result);
				this._addMessageToThread(threadId, { role: 'tool', type: 'success', rawParams: opts.unvalidatedToolParams, result: result as never, name: toolName, params: opts.unvalidatedToolParams, content, id: toolId, mcpServerName: undefined });
				return {};
			} catch (error) {
				if (!isControlCurrent()) return { interrupted: true };
				const content = getErrorMessage(error);
				this._addMessageToThread(threadId, { role: 'tool', type: 'invalid_params', rawParams: opts.unvalidatedToolParams, result: null, name: toolName, content, id: toolId, mcpServerName: undefined });
				return {};
			}
		}


		if (!opts.preapproved) { // skip this if pre-approved
			// 1. validate tool params
			try {
				if (isBuiltInTool) {
					const params = this._toolsService.validateParams[toolName](opts.unvalidatedToolParams)
					toolParams = params
				}
				else {
					toolParams = opts.unvalidatedToolParams
				}
			}
			catch (error) {
				const errorMessage = getErrorMessage(error)
				this._addMessageToThread(threadId, { role: 'tool', type: 'invalid_params', rawParams: opts.unvalidatedToolParams, result: null, name: toolName, content: errorMessage, id: toolId, mcpServerName })
				return {}
			}
			// 2. if tool requires approval, break from the loop, awaiting approval

			const approvalType = isBuiltInTool ? approvalTypeOfBuiltinToolName[toolName] : 'MCP tools'
			if (approvalType) {
				const autoApprove = this._settingsService.state.globalSettings.autoApprove[approvalType]
				// add a tool_request because we use it for UI if a tool is loading (this should be improved in the future)
				this._addMessageToThread(threadId, { role: 'tool', type: 'tool_request', content: '(Awaiting user permission...)', result: null, name: toolName, params: toolParams, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName })
				if (!autoApprove) {
					return { awaitingUserApproval: true }
				}
			}
		}
		else {
			toolParams = opts.validatedParams
		}






		// 3. call the tool
		// this._setStreamState(threadId, { isRunning: 'tool' }, 'merge')
		const runningTool = { role: 'tool', type: 'running_now', name: toolName, params: toolParams, content: '(value not received yet...)', result: null, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName } as const
		this._updateLatestTool(threadId, runningTool)


		let interrupted = false
		let resolveInterruptor: (r: () => void) => void = () => { }
		const interruptorPromise = new Promise<() => void>(res => { resolveInterruptor = res })
		try {

			// set stream state
			this._setStreamState(threadId, { isRunning: 'tool', interrupt: interruptorPromise, toolInfo: { toolName, toolParams, id: toolId, content: 'interrupted...', rawParams: opts.unvalidatedToolParams, mcpServerName } })

			if (isBuiltInTool) {
				const readContext = (() => {
					if (toolName !== 'read_file') return threadId
					if (!instructionSnapshot.model.hasModel) return { ownerThreadId: threadId, maxReadOutputTokens: 0 }
					const baseline = estimateHistoryTokensForReadBudget(this.state.allThreads[threadId]?.messages ?? [])
					return { ownerThreadId: threadId, maxReadOutputTokens: computeMaxReadOutputTokens(instructionSnapshot.model.contextWindow, instructionSnapshot.model.reservedOutputTokens, baseline) }
				})()
				let preparedWrite: Awaited<ReturnType<IToolsService['prepareWriteFile']>> | null = null
				if (toolName === 'write_file') {
					preparedWrite = await this._toolsService.prepareWriteFile(toolParams as BuiltinToolCallParams['write_file'], threadId)
					if (!preparedWrite) throw new Error('Internal error: write_file did not produce a receipt.')
				}
				const call = preparedWrite
					? { result: preparedWrite.execute() }
					: await this._toolsService.callTool[toolName](toolParams as any, readContext)
				const { result, interruptTool } = call
				const interruptor = () => { interrupted = true; interruptTool?.() }
				resolveInterruptor(interruptor)

				toolResult = await result
			}
			else {
				const mcpTools = this._mcpService.getMCPTools()
				const mcpTool = mcpTools?.find(t => t.name === toolName)
				if (!mcpTool) { throw new Error(`MCP tool ${toolName} not found`) }

				resolveInterruptor(() => { })

				toolResult = (await this._mcpService.callMCPTool({
					serverName: mcpTool.mcpServerName ?? 'unknown_mcp_server',
					toolName: toolName,
					params: toolParams
				})).result
			}

			if (interrupted) { return { interrupted: true } } // the tool result is added where we interrupt, not here
		}
		catch (error) {
			resolveInterruptor(() => { }) // resolve for the sake of it
			if (interrupted) { return { interrupted: true } } // the tool result is added where we interrupt, not here

			const errorMessage = getErrorMessage(error)
			this._updateLatestTool(threadId, { role: 'tool', type: 'tool_error', params: toolParams, result: errorMessage, name: toolName, content: errorMessage, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName })
			return {}
		}

		// 4. stringify the result to give to the LLM
		try {
			if (isBuiltInTool) {
				toolResultStr = this._toolsService.stringOfResult[toolName](toolParams as any, toolResult as any)
			}
			// For MCP tools, handle the result based on its type
			else {
				toolResultStr = this._mcpService.stringifyResult(toolResult as RawMCPToolCall)
			}
		} catch (error) {
			const errorMessage = this.toolErrMsgs.errWhenStringifying(error)
			this._updateLatestTool(threadId, { role: 'tool', type: 'tool_error', params: toolParams, result: errorMessage, name: toolName, content: errorMessage, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName })
			return {}
		}

		// 5. add to history and keep going
		if (toolName === 'read_file' && (!isBoundedReadHistory(toolResult as BuiltinToolResultType['read_file'], this._settingsService.state.globalSettings.readFileLimits) || !isBoundedReadHistoryString(toolResultStr, this._settingsService.state.globalSettings.readFileLimits))) {
			const errorMessage = 'read_file rejected: bounded history validation failed; re-read a smaller continuation.'
			this._updateLatestTool(threadId, { role: 'tool', type: 'tool_error', params: toolParams, result: errorMessage, name: toolName, content: errorMessage, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName })
			return {}
		}
		this._updateLatestTool(threadId, { role: 'tool', type: 'success', params: toolParams, result: toolResult, name: toolName, content: toolResultStr, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName })
		return {}
	}




	private async _runChatAgent({
		threadId,
		modelSelection,
		modelSelectionOptions,
		callThisToolFirst,
		instructionSnapshot,
		agentDelegationAuthority,
	}: {
		threadId: string,
		modelSelection: ModelSelection | null,
		modelSelectionOptions: ModelSelectionOptions | undefined,

		callThisToolFirst?: ToolMessage<ToolName> & { type: 'tool_request' }
		instructionSnapshot: AgentRuntimeTurnSnapshot,
		agentDelegationAuthority?: AgentDelegationTurnAuthority,
	}) {

		// Every invocation, including persisted approval continuation, owns the
		// generation current at its own entry. It never inherits ephemeral @Agent state.
		const agentRunGeneration = this._agentControlGeneration.get(threadId) ?? 0;
		let interruptedWhenIdle = false
		const idleInterruptor = Promise.resolve(() => { interruptedWhenIdle = true })
		// _runToolCall does not need setStreamState({idle}) before it, but it needs it after it. (handles its own setStreamState)

		// above just defines helpers, below starts the actual function
		const { chatMode } = this._settingsService.state.globalSettings // should not change as we loop even if user changes it, so it goes here
		const snapshot = instructionSnapshot;
		const isDelegationAuthorityCurrent = () => !!agentDelegationAuthority?.allowed && this._agentDelegationAuthorityOfThread?.get(threadId) === agentDelegationAuthority && (this._agentControlGeneration.get(threadId) ?? 0) === agentDelegationAuthority.generation

		let nMessagesSent = 0
		let shouldSendAnotherMessage = true
		let isRunningWhenEnd: IsRunningType = undefined

		// before enter loop, call tool
		if (callThisToolFirst) {
			const { interrupted } = await this._runToolCall(threadId, callThisToolFirst.name, callThisToolFirst.id, callThisToolFirst.mcpServerName, { preapproved: true, unvalidatedToolParams: callThisToolFirst.rawParams, validatedParams: callThisToolFirst.params }, snapshot, agentDelegationAuthority, chatMode === 'agent', agentRunGeneration)
			if (interrupted) {
				this._setStreamState(threadId, undefined)
				return
			}
		}
		this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' })  // just decorative, for clarity


		// tool use loop
		while (shouldSendAnotherMessage) {
			// false by default each iteration
			shouldSendAnotherMessage = false
			isRunningWhenEnd = undefined
			nMessagesSent += 1

			this._setStreamState(threadId, { isRunning: 'idle', interrupt: idleInterruptor })

			const chatMessages = this.state.allThreads[threadId]?.messages ?? []
			const { messages, separateSystemMessage } = await this._convertToLLMMessagesService.prepareLLMChatMessages({
				chatMessages,
				modelSelection,
				chatMode,
				instructionSnapshot: snapshot,
				agentDelegationAllowed: isDelegationAuthorityCurrent(),
			})

			if (interruptedWhenIdle) {
				this._setStreamState(threadId, undefined)
				return
			}

			let shouldRetryLLM = true
			let nAttempts = 0
			while (shouldRetryLLM) {
				shouldRetryLLM = false
				nAttempts += 1

				type ResTypes =
					| { type: 'llmDone', toolCall?: RawToolCallObj, info: { fullText: string, fullReasoning: string, anthropicReasoning: AnthropicReasoning[] | null } }
					| { type: 'llmError', error?: { message: string; fullError: Error | null; } }
					| { type: 'llmAborted' }

				let resMessageIsDonePromise: (res: ResTypes) => void // resolves when user approves this tool use (or if tool doesn't require approval)
				const messageIsDonePromise = new Promise<ResTypes>((res, rej) => { resMessageIsDonePromise = res })

				const llmCancelToken = this._llmMessageService.sendLLMMessage({
					messagesType: 'chatMessages',
					chatMode,
					messages: messages,
					modelSelection,
					modelSelectionOptions,
					overridesOfModel: snapshot.model.hasModel ? { [snapshot.model.providerName]: { [snapshot.model.modelName]: snapshot.model.selectedModelOverrides } } as never : undefined,
					agentDelegationAllowed: isDelegationAuthorityCurrent(),
					logging: { loggingName: `Chat - ${chatMode}`, loggingExtras: { threadId, nMessagesSent, chatMode } },
					separateSystemMessage: separateSystemMessage,
					onText: ({ fullText, fullReasoning, toolCall }) => {
						this._setStreamState(threadId, { isRunning: 'LLM', llmInfo: { displayContentSoFar: fullText, reasoningSoFar: fullReasoning, toolCallSoFar: toolCall ?? null }, interrupt: Promise.resolve(() => { if (llmCancelToken) this._llmMessageService.abort(llmCancelToken) }) })
					},
					onFinalMessage: async ({ fullText, fullReasoning, toolCall, anthropicReasoning, }) => {
						resMessageIsDonePromise({ type: 'llmDone', toolCall, info: { fullText, fullReasoning, anthropicReasoning } }) // resolve with tool calls
					},
					onError: async (error) => {
						resMessageIsDonePromise({ type: 'llmError', error: error })
					},
					onAbort: () => {
						// stop the loop to free up the promise, but don't modify state (already handled by whatever stopped it)
						resMessageIsDonePromise({ type: 'llmAborted' })
						this._metricsService.capture('Agent Loop Done (Aborted)', { nMessagesSent, chatMode })
					},
				})

				// mark as streaming
				if (!llmCancelToken) {
					this._setStreamState(threadId, { isRunning: undefined, error: { message: 'There was an unexpected error when sending your chat message.', fullError: null } })
					break
				}

				this._setStreamState(threadId, { isRunning: 'LLM', llmInfo: { displayContentSoFar: '', reasoningSoFar: '', toolCallSoFar: null }, interrupt: Promise.resolve(() => this._llmMessageService.abort(llmCancelToken)) })
				const llmRes = await messageIsDonePromise // wait for message to complete

				// if something else started running in the meantime
				if (this.streamState[threadId]?.isRunning !== 'LLM') {
					// console.log('Chat thread interrupted by a newer chat thread', this.streamState[threadId]?.isRunning)
					return
				}

				// llm res aborted
				if (llmRes.type === 'llmAborted') {
					this._setStreamState(threadId, undefined)
					return
				}
				// llm res error
				else if (llmRes.type === 'llmError') {
					// error, should retry
					if (nAttempts < CHAT_RETRIES) {
						shouldRetryLLM = true
						this._setStreamState(threadId, { isRunning: 'idle', interrupt: idleInterruptor })
						await timeout(RETRY_DELAY)
						if (interruptedWhenIdle) {
							this._setStreamState(threadId, undefined)
							return
						}
						else
							continue // retry
					}
					// error, but too many attempts
					else {
						const { error } = llmRes
						const { displayContentSoFar, reasoningSoFar, toolCallSoFar } = this.streamState[threadId].llmInfo
						this._addMessageToThread(threadId, { role: 'assistant', displayContent: displayContentSoFar, reasoning: reasoningSoFar, anthropicReasoning: null })
						if (toolCallSoFar) this._addMessageToThread(threadId, { role: 'interrupted_streaming_tool', name: toolCallSoFar.name, mcpServerName: this._computeMCPServerOfToolName(toolCallSoFar.name) })

						this._setStreamState(threadId, { isRunning: undefined, error })
						return
					}
				}

				// llm res success
				const { toolCall, info } = llmRes

				this._addMessageToThread(threadId, { role: 'assistant', displayContent: info.fullText, reasoning: info.fullReasoning, anthropicReasoning: info.anthropicReasoning })

				this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' }) // just decorative for clarity

				// call tool if there is one
				if (toolCall) {
					const mcpTool = isAgentSubagentControlName(toolCall.name) || isReadSkillResourceToolName(toolCall.name) ? undefined : this._mcpService.getMCPTools()?.find(t => t.name === toolCall.name)

					const { awaitingUserApproval, interrupted } = await this._runToolCall(threadId, toolCall.name, toolCall.id, mcpTool?.mcpServerName, { preapproved: false, unvalidatedToolParams: toolCall.rawParams }, snapshot, agentDelegationAuthority, chatMode === 'agent', agentRunGeneration)
					if (interrupted) {
						this._setStreamState(threadId, undefined)
						return
					}
					if (awaitingUserApproval) { isRunningWhenEnd = 'awaiting_user' }
					else { shouldSendAnotherMessage = true }

					this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' }) // just decorative, for clarity
				}

			} // end while (attempts)
		} // end while (send message)

		// if awaiting user approval, keep isRunning true, else end isRunning
		this._setStreamState(threadId, { isRunning: isRunningWhenEnd })

		// capture number of messages sent
		this._metricsService.capture('Agent Loop Done', { nMessagesSent, chatMode })
	}


	private _editMessageInThread(threadId: string, messageIdx: number, newMessage: ChatMessage,) {
		const { allThreads } = this.state
		const oldThread = allThreads[threadId]
		if (!oldThread) return // should never happen
		// update state and store it
		const newThreads = {
			...allThreads,
			[oldThread.id]: {
				...oldThread,
				lastModified: new Date().toISOString(),
				messages: [
					...oldThread.messages.slice(0, messageIdx),
					newMessage,
					...oldThread.messages.slice(messageIdx + 1, Infinity),
				],
			}
		}
		this._storeAllThreads(newThreads)
		this._setState({ allThreads: newThreads }) // the current thread just changed (it had a message added to it)
	}


	private _wrapRunAgentToNotify(p: Promise<void>, threadId: string) {
		const notify = ({ error }: { error: string | null }) => {
			const thread = this.state.allThreads[threadId]
			if (!thread) return
			const userMsg = findLast(thread.messages, m => m.role === 'user')
			if (!userMsg) return
			if (userMsg.role !== 'user') return
			const messageContent = truncate(userMsg.displayContent, 50, '...')

			this._notificationService.notify({
				severity: error ? Severity.Warning : Severity.Info,
				message: error ? `Error: ${error} ` : `A new Chat result is ready.`,
				source: messageContent,
				sticky: true,
				actions: {
					primary: [{
						id: 'void.goToChat',
						enabled: true,
						label: `Jump to Chat`,
						tooltip: '',
						class: undefined,
						run: () => {
							this.switchToThread(threadId)
							// scroll to bottom
							this.state.allThreads[threadId]?.state.mountedInfo?.whenMounted.then(m => {
								m.scrollToBottom()
							})
						}
					}]
				},
			})
		}

		p.then(() => {
			if (this.streamState[threadId]?.isRunning !== 'awaiting_user') this._toolsService.invalidateReadReceipts(threadId)
			if (threadId !== this.state.currentThreadId) notify({ error: null })
		}).catch((e) => {
			this._toolsService.invalidateReadReceipts(threadId)
			if (threadId !== this.state.currentThreadId) notify({ error: getErrorMessage(e) })
			throw e
		})
	}

	dismissStreamError(threadId: string): void {
		this._setStreamState(threadId, undefined)
	}


	private async _addUserMessageAndStreamResponse({ userMessage, _chatSelections, threadId }: { userMessage: string, _chatSelections?: StagingSelectionItem[], threadId: string }) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return false // should never happen
		const capturedSelections = [...(_chatSelections ?? thread.state.stagingSelections)]
		const agentSelections = capturedSelections.filter(isAgentDelegationSelection)
		if (agentSelections.length > 1) throw new Error('custom_agent_multiple_selections')
		const agentSelection = agentSelections[0]
		const agentDelegationIntent = !!agentSelection
		const preflightGeneration = this._agentControlGeneration.get(threadId) ?? 0
		// Capture every model-dependent input before any async catalog/instruction resolution.
		const capturedModel = this._currentModelSelectionProps();
		const capturedOverride = capturedModel.modelSelection ? this._settingsService.state.overridesOfModel[capturedModel.modelSelection.providerName]?.[capturedModel.modelSelection.modelName] ?? {} : {};
		const nativeToolFormat = capturedModel.modelSelection ? getModelCapabilities(capturedModel.modelSelection.providerName, capturedModel.modelSelection.modelName, { [capturedModel.modelSelection.providerName]: { [capturedModel.modelSelection.modelName]: capturedOverride } } as never).specialToolFormat : undefined;
		const isAgentChat = this._settingsService.state.globalSettings.chatMode === 'agent';
		const agentDelegationAllowed = isAgentChat && isNativeAgentToolFormat(nativeToolFormat);
		if (isAgentChat && !capturedModel.modelSelection) {
			this._setStreamState(threadId, { isRunning: undefined, error: { message: 'Agent chat requires a selected Chat model with native Agent tools. Select a supported model before sending.', fullError: null } });
			return false;
		}
		if (isAgentChat && !agentDelegationAllowed) {
			this._setStreamState(threadId, { isRunning: undefined, error: { message: 'The selected Chat model does not support native Agent tools. Select a supported model before sending.', fullError: null } });
			return false;
		}
		const owner = this._workspaceContextService.getWorkspace().folders[0]?.uri
		const roleCatalog = agentDelegationIntent && agentDelegationAllowed ? await this._agentCustomAgentService.getCatalog(owner, owner) : undefined
		if ((this._agentControlGeneration.get(threadId) ?? 0) !== preflightGeneration) return false
		if (agentSelection?.agentType && (!roleCatalog || roleCatalog.revision !== agentSelection.catalogRevision || roleCatalog.agents.find(role => role.identity === agentSelection.agentType)?.revision !== agentSelection.roleRevision)) {
			this._setStreamState(threadId, { isRunning: undefined, error: { message: `The selected Agent role '${agentSelection.agentType}' changed or is no longer available. Select it again before sending.`, fullError: null } }); return false
		}
		this._agentDelegationAuthorityOfThread.delete(threadId)
		this._agentControlGeneration.set(threadId, preflightGeneration + 1); this._agentSubagentService.forgetParent(threadId)
		if (this.streamState[threadId]?.isRunning) await this.abortRunning(threadId)
		const turnGeneration = this._agentControlGeneration.get(threadId) ?? 0
		const isCurrentTurn = () => (this._agentControlGeneration.get(threadId) ?? 0) === turnGeneration
		const capturedSettingsState = agentDelegationAllowed ? deepClone(this._settingsService.state) : undefined;
		const capturedSettingsOfProvider = agentDelegationAllowed ? this._llmMessageService.captureSettingsOfProvider() : undefined;
		const capturedOverrides = capturedModel.modelSelection ? { [capturedModel.modelSelection.providerName]: { [capturedModel.modelSelection.modelName]: deepClone(capturedOverride) } } as never : undefined;
		// This must happen before history changes: a task cannot cross a workspace owner boundary.
		const instructionSnapshot = await this._beginInstructionTurn(threadId)
		if (!isCurrentTurn()) return false
		// A failed new admission must not leave a previous turn's runtime authority resumable.
		this._purgeInstructionTurn(threadId, false)

		// add user's message to chat history
		const instructions = userMessage
		let currSelns: StagingSelectionItem[] = capturedSelections
		const catalog = await this._agentSkillsService.getCatalog(owner, owner, instructionSnapshot.config)
		if (!isCurrentTurn()) return false
		const direct = selectExplicitSkills(catalog, instructions)
		if (!direct.skills) throw new Error(direct.diagnostic?.code ?? 'skill_not_found')
		const selectedIdentities = new Set<string>(); const normalizedSelections: StagingSelectionItem[] = [];
		for (const selection of currSelns) {
			if (selection.type !== 'Skill' || !selectedIdentities.has(selection.identity)) { normalizedSelections.push(selection); if (selection.type === 'Skill') selectedIdentities.add(selection.identity); }
		}
		for (const skill of direct.skills) if (!selectedIdentities.has(skill.identity)) { selectedIdentities.add(skill.identity); normalizedSelections.push({ type: 'Skill', identity: skill.identity, catalogRevision: catalog.revision, bodyRevision: skill.bodyRevision, skillRoot: skill.provenance.skillRoot, description: skill.description, state: undefined }); }
		currSelns = normalizedSelections
		const skillSelections = currSelns.filter((selection): selection is Extract<StagingSelectionItem, { type: 'Skill' }> => selection.type === 'Skill')
		const skillBodies = await Promise.all(skillSelections.map(async selection => {
			const descriptor = catalog.skills.find(skill => skill.identity === selection.identity && skill.provenance.skillRoot === selection.skillRoot && skill.bodyRevision === selection.bodyRevision)
			if (selection.catalogRevision !== catalog.revision || !descriptor) throw new Error('skill_stale')
			const body = await this._agentSkillsService.readSkillBody(selection.skillRoot, selection.bodyRevision)
			if (!body.body) throw new Error(body.diagnostic?.code ?? 'skill_body_unreadable')
			return body.body
		}))
		if (!isCurrentTurn()) return false
		if (this._workspaceContextService.getWorkspace().folders[0]?.uri.toString() !== instructionSnapshot.ownerProjectRoot || (!this._workspaceTrustManagementService.isWorkspaceTrusted() && (instructionSnapshot.config.configSources.some(source => source.scope === 'project') || catalog.skills.some(skill => skill.provenance.source === 'repository')))) throw new Error('skill_owner_or_trust_changed')
		let effectiveReserve = 0
		if (capturedModel.modelSelection) {
			const { contextWindow } = getModelCapabilities(capturedModel.modelSelection.providerName, capturedModel.modelSelection.modelName, capturedOverrides)
			const reserve = getReservedOutputTokenSpace(capturedModel.modelSelection.providerName, capturedModel.modelSelection.modelName, { isReasoningEnabled: getIsReasoningEnabledState('Chat', capturedModel.modelSelection.providerName, capturedModel.modelSelection.modelName, capturedModel.modelSelectionOptions, capturedOverrides), overridesOfModel: capturedOverrides }) ?? 4096
			effectiveReserve = Math.max(Math.ceil(contextWindow / 2), reserve)
		}
		const advertisement = skillAdvertisement(catalog, capturedModel.modelSelection ? getModelCapabilities(capturedModel.modelSelection.providerName, capturedModel.modelSelection.modelName, capturedOverrides).contextWindow : undefined)
		const runtimeModel = capturedModel.modelSelection
			? { hasModel: true as const, providerName: capturedModel.modelSelection.providerName, modelName: capturedModel.modelSelection.modelName, contextWindow: getModelCapabilities(capturedModel.modelSelection.providerName, capturedModel.modelSelection.modelName, capturedOverrides).contextWindow, reservedOutputTokens: effectiveReserve, modelSelectionOptions: { ...(capturedModel.modelSelectionOptions as Record<string, unknown>) }, selectedModelOverrides: deepClone(capturedOverride) as never }
			: { hasModel: false as const };
		const runtimeSnapshot = createAgentRuntimeTurnSnapshot(instructionSnapshot, catalog, advertisement, skillSelections.map((selection, index) => ({ identity: selection.identity, skillRoot: selection.skillRoot, bodyRevision: selection.bodyRevision, body: skillBodies[index] })), runtimeModel, this._workspaceTrustManagementService.isWorkspaceTrusted())
		admitProtectedAgentAuthority(runtimeSnapshot)
		const userMessageContentBase = await chat_userMessageContent(instructions, currSelns, { directoryStrService: this._directoryStringService, fileService: this._fileService }) // user message + names of files (NOT content)
		if (!isCurrentTurn()) return false
		const roleAd = roleCatalog ? customAgentAdvertisement(roleCatalog, runtimeModel.hasModel ? Math.min(2_000, Math.max(0, Math.floor(runtimeModel.contextWindow * .01 * 4))) : 2_000) : undefined
		const userMessageContent = agentDelegationIntent
			? `${userMessageContentBase}\n\n[User delegation marker: up to four generic read-only children are available for this turn, with two running concurrently. Named custom agents admitted for this turn (optional exact agent_type): ${roleAd?.text || 'none'}${roleAd?.omitted ? `; ${roleAd.omitted} omitted` : ''}.${agentSelection?.agentType ? ` For this selected role, call spawn_agent with agent_type=${agentSelection.agentType} exactly.` : ''} Call spawn_agent for delegated tasks, then wait_agent for their results; partial child failures do not prevent your synthesis.]`
			: userMessageContentBase
		const currentOwner = this._workspaceContextService.getWorkspace().folders[0]?.uri.toString()
		if (currentOwner !== runtimeSnapshot.ownerProjectRoot || currentOwner !== runtimeSnapshot.runCwd || this._workspaceTrustManagementService.isWorkspaceTrusted() !== runtimeSnapshot.workspaceTrustedAtAdmission) { this._purgeInstructionTurn(threadId, false); throw new Error('skill_owner_or_trust_changed') }
		if (!isCurrentTurn()) return false
		const agentDelegationAuthority = Object.freeze({ allowed: agentDelegationAllowed, generation: turnGeneration, ...(roleCatalog ? { roles: roleCatalog, settingsState: capturedSettingsState, settingsOfProvider: capturedSettingsOfProvider } : {}) })
		this._agentDelegationAuthorityOfThread.set(threadId, agentDelegationAuthority)
		this._rememberInstructionTurn(threadId, runtimeSnapshot)
		const userHistoryElt: ChatMessage = { role: 'user', content: userMessageContent, displayContent: instructions, selections: currSelns, state: defaultMessageState }
		this._addMessageToThread(threadId, userHistoryElt)

		this._wrapRunAgentToNotify(
			this._runChatAgent({ threadId, instructionSnapshot: runtimeSnapshot, agentDelegationAuthority, ...capturedModel, }),
			threadId,
		)

		// scroll to bottom
		this.state.allThreads[threadId]?.state.mountedInfo?.whenMounted.then(m => {
			m.scrollToBottom()
		})
		return true
	}


	async addUserMessageAndStreamResponse({ userMessage, _chatSelections, threadId }: { userMessage: string, _chatSelections?: StagingSelectionItem[], threadId: string }) {
		return this._addUserMessageAndStreamResponse({ userMessage, _chatSelections, threadId });
	}

	editUserMessageAndStreamResponse: IChatThreadService['editUserMessageAndStreamResponse'] = async ({ userMessage, messageIdx, threadId }) => {

		const thread = this.state.allThreads[threadId]
		if (!thread) return // should never happen

		if (thread.messages?.[messageIdx]?.role !== 'user') {
			throw new Error(`Error: editing a message with role !=='user'`)
		}

		// get prev and curr selections before clearing the message
		const currSelns = thread.messages[messageIdx].state.stagingSelections || [] // staging selections for the edited message

		// clear messages up to the index
		const slicedMessages = thread.messages.slice(0, messageIdx)
		this._setState({
			allThreads: {
				...this.state.allThreads,
				[thread.id]: {
					...thread,
					messages: slicedMessages
				}
			}
		})

		// re-add the message and stream it
		this._addUserMessageAndStreamResponse({ userMessage, _chatSelections: currSelns, threadId })
	}

	// ---------- the rest ----------

	private _getAllSeenFileURIs(threadId: string) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return []

		const fsPathsSet = new Set<string>()
		const uris: URI[] = []
		const addURI = (uri: URI) => {
			if (!fsPathsSet.has(uri.fsPath)) uris.push(uri)
			fsPathsSet.add(uri.fsPath)
			uris.push(uri)
		}

		for (const m of thread.messages) {
			// URIs of user selections
			if (m.role === 'user') {
				for (const sel of m.selections ?? []) {
					if (sel.type !== 'Skill' && sel.type !== 'Agent') addURI(sel.uri)
				}
			}
			// URIs of files that have been read
			else if (m.role === 'tool' && m.type === 'success' && m.name === 'read_file') {
				const params = m.params as BuiltinToolCallParams['read_file']
				addURI(params.uri)
			}
		}
		return uris
	}



	getRelativeStr = (uri: URI) => {
		const isInside = this._workspaceContextService.isInsideWorkspace(uri)
		if (isInside) {
			const f = this._workspaceContextService.getWorkspace().folders.find(f => uri.fsPath.startsWith(f.uri.fsPath))
			if (f) { return uri.fsPath.replace(f.uri.fsPath, '') }
			else { return undefined }
		}
		else {
			return undefined
		}
	}


	// gets the location of codespan link so the user can click on it
	generateCodespanLink: IChatThreadService['generateCodespanLink'] = async ({ codespanStr: _codespanStr, threadId }) => {

		// process codespan to understand what we are searching for
		// TODO account for more complicated patterns eg `ITextEditorService.openEditor()`
		const functionOrMethodPattern = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/; // `fUnCt10n_name`
		const functionParensPattern = /^([^\s(]+)\([^)]*\)$/; // `functionName( args )`

		let target = _codespanStr // the string to search for
		let codespanType: 'file-or-folder' | 'function-or-class'
		if (target.includes('.') || target.includes('/')) {

			codespanType = 'file-or-folder'
			target = _codespanStr

		} else if (functionOrMethodPattern.test(target)) {

			codespanType = 'function-or-class'
			target = _codespanStr

		} else if (functionParensPattern.test(target)) {
			const match = target.match(functionParensPattern)
			if (match && match[1]) {

				codespanType = 'function-or-class'
				target = match[1]

			}
			else { return null }
		}
		else {
			return null
		}

		// get history of all AI and user added files in conversation + store in reverse order (MRU)
		const prevUris = this._getAllSeenFileURIs(threadId).reverse()

		if (codespanType === 'file-or-folder') {
			const doesUriMatchTarget = (uri: URI) => uri.path.includes(target)

			// check if any prevFiles are the `target`
			for (const [idx, uri] of prevUris.entries()) {
				if (doesUriMatchTarget(uri)) {

					// shorten it

					// TODO make this logic more general
					const prevUriStrs = prevUris.map(uri => uri.fsPath)
					const shortenedUriStrs = shorten(prevUriStrs)
					let displayText = shortenedUriStrs[idx]
					const ellipsisIdx = displayText.lastIndexOf('…/');
					if (ellipsisIdx >= 0) {
						displayText = displayText.slice(ellipsisIdx + 2)
					}

					return { uri, displayText }
				}
			}

			// else search codebase for `target`
			let uris: URI[] = []
			try {
				const { result } = await this._toolsService.callTool['search_pathnames_only']({ query: target, includePattern: null, pageNumber: 0 })
				const { uris: uris_ } = await result
				uris = uris_
			} catch (e) {
				return null
			}

			for (const [idx, uri] of uris.entries()) {
				if (doesUriMatchTarget(uri)) {

					// TODO make this logic more general
					const prevUriStrs = prevUris.map(uri => uri.fsPath)
					const shortenedUriStrs = shorten(prevUriStrs)
					let displayText = shortenedUriStrs[idx]
					const ellipsisIdx = displayText.lastIndexOf('…/');
					if (ellipsisIdx >= 0) {
						displayText = displayText.slice(ellipsisIdx + 2)
					}


					return { uri, displayText }
				}
			}

		}


		if (codespanType === 'function-or-class') {


			// check all prevUris for the target
			for (const uri of prevUris) {

				const modelRef = await this._voidModelService.getModelSafe(uri)
				const { model } = modelRef
				if (!model) continue

				const matches = model.findMatches(
					target,
					false, // searchOnlyEditableRange
					false, // isRegex
					true,  // matchCase
					null, //' ',   // wordSeparators
					true   // captureMatches
				);

				const firstThree = matches.slice(0, 3);

				// take first 3 occurences, attempt to goto definition on them
				for (const match of firstThree) {
					const position = new Position(match.range.startLineNumber, match.range.startColumn);
					const definitionProviders = this._languageFeaturesService.definitionProvider.ordered(model);

					for (const provider of definitionProviders) {

						const _definitions = await provider.provideDefinition(model, position, CancellationToken.None);

						if (!_definitions) continue;

						const definitions = Array.isArray(_definitions) ? _definitions : [_definitions];

						for (const definition of definitions) {

							return {
								uri: definition.uri,
								selection: {
									startLineNumber: definition.range.startLineNumber,
									startColumn: definition.range.startColumn,
									endLineNumber: definition.range.endLineNumber,
									endColumn: definition.range.endColumn,
								},
								displayText: _codespanStr,
							};

							// const defModelRef = await this._textModelService.createModelReference(definition.uri);
							// const defModel = defModelRef.object.textEditorModel;

							// try {
							// 	const symbolProviders = this._languageFeaturesService.documentSymbolProvider.ordered(defModel);

							// 	for (const symbolProvider of symbolProviders) {
							// 		const symbols = await symbolProvider.provideDocumentSymbols(
							// 			defModel,
							// 			CancellationToken.None
							// 		);

							// 		if (symbols) {
							// 			const symbol = symbols.find(s => {
							// 				const symbolRange = s.range;
							// 				return symbolRange.startLineNumber <= definition.range.startLineNumber &&
							// 					symbolRange.endLineNumber >= definition.range.endLineNumber &&
							// 					(symbolRange.startLineNumber !== definition.range.startLineNumber || symbolRange.startColumn <= definition.range.startColumn) &&
							// 					(symbolRange.endLineNumber !== definition.range.endLineNumber || symbolRange.endColumn >= definition.range.endColumn);
							// 			});

							// 			// if we got to a class/function get the full range and return
							// 			if (symbol?.kind === SymbolKind.Function || symbol?.kind === SymbolKind.Method || symbol?.kind === SymbolKind.Class) {
							// 				return {
							// 					uri: definition.uri,
							// 					selection: {
							// 						startLineNumber: definition.range.startLineNumber,
							// 						startColumn: definition.range.startColumn,
							// 						endLineNumber: definition.range.endLineNumber,
							// 						endColumn: definition.range.endColumn,
							// 					}
							// 				};
							// 			}
							// 		}
							// 	}
							// } finally {
							// 	defModelRef.dispose();
							// }
						}
					}
				}
			}

			// unlike above do not search codebase (doesnt make sense)

		}

		return null

	}

	getCodespanLink({ codespanStr, messageIdx, threadId }: { codespanStr: string, messageIdx: number, threadId: string }): CodespanLocationLink | undefined {
		const thread = this.state.allThreads[threadId]
		if (!thread) return undefined;

		const links = thread.state.linksOfMessageIdx?.[messageIdx]
		if (!links) return undefined;

		const link = links[codespanStr]

		return link
	}

	async addCodespanLink({ newLinkText, newLinkLocation, messageIdx, threadId }: { newLinkText: string, newLinkLocation: CodespanLocationLink, messageIdx: number, threadId: string }) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		this._setState({

			allThreads: {
				...this.state.allThreads,
				[threadId]: {
					...thread,
					state: {
						...thread.state,
						linksOfMessageIdx: {
							...thread.state.linksOfMessageIdx,
							[messageIdx]: {
								...thread.state.linksOfMessageIdx?.[messageIdx],
								[newLinkText]: newLinkLocation
							}
						}
					}

				}
			}
		})
	}


	getCurrentThread(): ThreadType {
		const state = this.state
		const thread = state.allThreads[state.currentThreadId]
		if (!thread) throw new Error(`Current thread should never be undefined`)
		return thread
	}

	getCurrentFocusedMessageIdx() {
		const thread = this.getCurrentThread()

		// get the focusedMessageIdx
		const focusedMessageIdx = thread.state.focusedMessageIdx
		if (focusedMessageIdx === undefined) return;

		// check that the message is actually being edited
		const focusedMessage = thread.messages[focusedMessageIdx]
		if (focusedMessage.role !== 'user') return;
		if (!focusedMessage.state) return;

		return focusedMessageIdx
	}

	isCurrentlyFocusingMessage() {
		return this.getCurrentFocusedMessageIdx() !== undefined
	}

	switchToThread(threadId: string) {
		this._setState({ currentThreadId: threadId })
	}


	openNewThread() {
		// if a thread with 0 messages already exists, switch to it
		const { allThreads: currentThreads } = this.state
		for (const threadId in currentThreads) {
			if (currentThreads[threadId]!.messages.length === 0) {
				// switch to the existing empty thread and exit
				this.switchToThread(threadId)
				return
			}
		}
		// otherwise, start a new thread
		const newThread = newThreadObject()

		// update state
		const newThreads: ChatThreads = {
			...currentThreads,
			[newThread.id]: newThread
		}
		this._storeAllThreads(newThreads)
		this._setState({ allThreads: newThreads, currentThreadId: newThread.id })
	}


	deleteThread(threadId: string): void {
		this._agentSubagentService.forgetParent(threadId)
		this._agentDelegationAuthorityOfThread.delete(threadId); this._agentControlGeneration.delete(threadId)
		this.clearTransientComposerDraft(threadId)
		const { allThreads: currentThreads } = this.state

		// delete the thread
		const newThreads = { ...currentThreads };
		delete newThreads[threadId];
		this._agentInstructionSessionOfThread.delete(threadId); this._instructionTurnOfThread.delete(threadId)
		this._toolsService.invalidateReadReceipts(threadId)

		// store the updated threads
		this._storeAllThreads(newThreads);
		this._setState({ ...this.state, allThreads: newThreads })
	}
	override dispose(): void { this._agentDelegationAuthorityOfThread.clear(); this._agentControlGeneration.clear(); this._transientComposerDraftOfThread.clear(); super.dispose(); }

	duplicateThread(threadId: string) {
		const { allThreads: currentThreads } = this.state
		const threadToDuplicate = currentThreads[threadId]
		if (!threadToDuplicate) return
		const newThread = {
			...deepClone(threadToDuplicate),
			id: generateUuid(),
		}
		const newThreads = {
			...currentThreads,
			[newThread.id]: newThread,
		}
		this._storeAllThreads(newThreads)
		this._setState({ allThreads: newThreads })
	}


	private _addMessageToThread(threadId: string, message: ChatMessage) {
		const { allThreads } = this.state
		const oldThread = allThreads[threadId]
		if (!oldThread) return // should never happen
		// update state and store it
		const newThreads = {
			...allThreads,
			[oldThread.id]: {
				...oldThread,
				lastModified: new Date().toISOString(),
				messages: [
					...oldThread.messages,
					message
				],
			}
		}
		this._storeAllThreads(newThreads)
		this._setState({ allThreads: newThreads }) // the current thread just changed (it had a message added to it)
	}

	// sets the currently selected message (must be undefined if no message is selected)
	setCurrentlyFocusedMessageIdx(messageIdx: number | undefined) {

		const threadId = this.state.currentThreadId
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		this._setState({
			allThreads: {
				...this.state.allThreads,
				[threadId]: {
					...thread,
					state: {
						...thread.state,
						focusedMessageIdx: messageIdx,
					}
				}
			}
		})

	}


	addNewStagingSelection(newSelection: StagingSelectionItem): void {

		const focusedMessageIdx = this.getCurrentFocusedMessageIdx()

		// set the selections to the proper value
		let selections: StagingSelectionItem[] = []
		let setSelections = (s: StagingSelectionItem[]) => { }

		if (focusedMessageIdx === undefined) {
			selections = this.getCurrentThreadState().stagingSelections
			setSelections = (s: StagingSelectionItem[]) => this.setCurrentThreadState({ stagingSelections: s })
		} else {
			selections = this.getCurrentMessageState(focusedMessageIdx).stagingSelections
			setSelections = (s) => this.setCurrentMessageState(focusedMessageIdx, { stagingSelections: s })
		}

		// if matches with existing selection, overwrite (since text may change)
		const idx = findStagingSelectionIndex(selections, newSelection)
		if (idx !== null && idx !== -1) {
			setSelections([
				...selections!.slice(0, idx),
				newSelection,
				...selections!.slice(idx + 1, Infinity)
			])
		}
		// if no match, add it
		else {
			setSelections([...(selections ?? []), newSelection])
		}
	}


	// Pops the staging selections from the current thread's state
	popStagingSelections(numPops: number): void {

		numPops = numPops ?? 1;

		const focusedMessageIdx = this.getCurrentFocusedMessageIdx()

		// set the selections to the proper value
		let selections: StagingSelectionItem[] = []
		let setSelections = (s: StagingSelectionItem[]) => { }

		if (focusedMessageIdx === undefined) {
			selections = this.getCurrentThreadState().stagingSelections
			setSelections = (s: StagingSelectionItem[]) => this.setCurrentThreadState({ stagingSelections: s })
		} else {
			selections = this.getCurrentMessageState(focusedMessageIdx).stagingSelections
			setSelections = (s) => this.setCurrentMessageState(focusedMessageIdx, { stagingSelections: s })
		}

		setSelections([
			...selections.slice(0, selections.length - numPops)
		])

	}

	// set message.state
	private _setCurrentMessageState(state: Partial<UserMessageState>, messageIdx: number): void {

		const threadId = this.state.currentThreadId
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		this._setState({
			allThreads: {
				...this.state.allThreads,
				[threadId]: {
					...thread,
					messages: thread.messages.map((m, i) =>
						i === messageIdx && m.role === 'user' ? {
							...m,
							state: {
								...m.state,
								...state
							},
						} : m
					)
				}
			}
		})

	}

	// set thread.state
	private _setThreadState(threadId: string, state: Partial<ThreadType['state']>, doNotRefreshMountInfo?: boolean): void {
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		this._setState({
			allThreads: {
				...this.state.allThreads,
				[thread.id]: {
					...thread,
					state: {
						...thread.state,
						...state
					}
				}
			}
		}, doNotRefreshMountInfo)

	}


	// closeCurrentStagingSelectionsInThread = () => {
	// 	const currThread = this.getCurrentThreadState()

	// 	// close all stagingSelections
	// 	const closedStagingSelections = currThread.stagingSelections.map(s => ({ ...s, state: { ...s.state, isOpened: false } }))

	// 	const newThread = currThread
	// 	newThread.stagingSelections = closedStagingSelections

	// 	this.setCurrentThreadState(newThread)

	// }

	// closeCurrentStagingSelectionsInMessage: IChatThreadService['closeCurrentStagingSelectionsInMessage'] = ({ messageIdx }) => {
	// 	const currMessage = this.getCurrentMessageState(messageIdx)

	// 	// close all stagingSelections
	// 	const closedStagingSelections = currMessage.stagingSelections.map(s => ({ ...s, state: { ...s.state, isOpened: false } }))

	// 	const newMessage = currMessage
	// 	newMessage.stagingSelections = closedStagingSelections

	// 	this.setCurrentMessageState(messageIdx, newMessage)

	// }



	getCurrentThreadState = () => {
		const currentThread = this.getCurrentThread()
		return currentThread.state
	}
	setCurrentThreadState = (newState: Partial<ThreadType['state']>) => {
		this._setThreadState(this.state.currentThreadId, newState)
	}

	// gets `staging` and `setStaging` of the currently focused element, given the index of the currently selected message (or undefined if no message is selected)

	getCurrentMessageState(messageIdx: number): UserMessageState {
		const currMessage = this.getCurrentThread()?.messages?.[messageIdx]
		if (!currMessage || currMessage.role !== 'user') return defaultMessageState
		return currMessage.state
	}
	setCurrentMessageState(messageIdx: number, newState: Partial<UserMessageState>) {
		const currMessage = this.getCurrentThread()?.messages?.[messageIdx]
		if (!currMessage || currMessage.role !== 'user') return
		this._setCurrentMessageState(newState, messageIdx)
	}



}

registerSingleton(IChatThreadService, ChatThreadService, InstantiationType.Eager);
