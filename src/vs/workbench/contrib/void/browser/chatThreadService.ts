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
import { captureParentModelToolSnapshot, chat_userMessageContent, isABuiltinToolName } from '../common/prompt/prompts.js';
import { AnthropicReasoning, getErrorMessage, RawToolCallObj, RawToolParamsObj } from '../common/sendLLMMessageTypes.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { FeatureName, ModelSelection, ModelSelectionOptions, SettingsOfProvider } from '../common/voidSettingsTypes.js';
import { IVoidSettingsService } from '../common/voidSettingsService.js';
import { getIsReasoningEnabledState, getModelCapabilities, getReservedOutputTokenSpace } from '../common/modelCapabilities.js';
import { closeNativeToolBatchForProspectiveAdmission, estimateHistoryTokensForReadBudget, hasSafeNativeToolBatchApprovalHistory, protectedSkillResourceHistoryLength, requiresNativeToolBatchRowIdentity, resolveNativeToolBatchDeclaration, validateNativeToolBatchRowIdentity } from './convertToLLMMessageService.js';
import { approvalTypeOfBuiltinToolName, BuiltinToolCallParams, BuiltinToolName, BuiltinToolResultType, ToolCallParams, ToolName, ToolResult } from '../common/toolsServiceTypes.js';
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
import { PENDING_CHAT_INPUT_STORAGE_KEY, THREAD_STORAGE_KEY } from '../common/storageKeys.js';
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
import { AgentDelegationLimits, AgentInstructionTaskSession, AgentInstructionTurnSnapshot } from '../common/agentInstructions.js';
import { AgentRuntimeTurnSnapshot, admitProtectedAgentAuthority, admitSkillResourceContext, assembleProtectedAgentAuthority, createAgentRuntimeTurnSnapshot, isReadSkillResourceToolName, reviveAgentRuntimeTurnSnapshot, runtimeModelFingerprint, selectExplicitSkills, skillAdvertisement, validateReadSkillResourceToolParams } from '../common/agentSkills.js';
import { AgentSubagentToolBroker, AgentSubagentToolBrokerRequest, AgentSubagentToolSnapshot, ChildToolApprovalKey, ChildToolApprovalView, childToolApprovalStructuralKey, createChildToolApprovalView, isAgentSubagentControlName, isNativeAgentToolFormat, readOnlyChildToolNames, validateAgentSubagentControlParams } from '../common/agentSubagents.js';
import { IAgentSubagentService } from './agentSubagentService.js';
import { IAgentCustomAgentService } from './agentCustomAgentService.js';
import { CustomAgentCatalog, customAgentAdvertisement } from '../common/agentCustomAgents.js';
import { sanitizeAssistantDisplayContent } from '../common/assistantMessagePresentation.js';
import { divideToolWaveOutputBudget, planToolBatchWaves } from '../common/toolBatchPlanner.js';


// related to retrying when LLM message has error
const CHAT_RETRIES = 3
const RETRY_DELAY = 2500
const stableToolValue = (value: unknown): string => {
	if (value instanceof URI) return JSON.stringify(value.toString())
	if (value === undefined) return '[undefined]'
	if (typeof value === 'number' && !Number.isFinite(value)) return `[${String(value)}]`
	if (typeof value === 'bigint') return `${value}n`
	if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? '[undefined]'
	if (Array.isArray(value)) return `[${value.map(stableToolValue).join(',')}]`
	const record = value as Record<string, unknown>
	return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableToolValue(record[key])}`).join(',')}}`
}
const semanticToolArgs = (toolName: ToolName, params: ToolCallParams<ToolName>): unknown => {
	if (!params || typeof params !== 'object') return params
	const value = { ...(params as Record<string, unknown>) }
	// Generated execution ids are receipts, not model intent; including them makes
	// a repeated terminal command look different on every attempt.
	if (toolName.toLowerCase() === 'run_command') delete value.terminalId
	return value
}
type AgentDelegationTurnAuthority = Readonly<{ allowed: boolean; generation: number; limits: AgentDelegationLimits; runtimeSnapshot: AgentRuntimeTurnSnapshot; parentTools: AgentSubagentToolSnapshot; autoApprove: Readonly<{ edits: boolean; terminal: boolean; mcp: boolean }>; roles?: CustomAgentCatalog; settingsState?: IVoidSettingsService['state']; settingsOfProvider?: SettingsOfProvider }>
type ParentRunOwnership = Readonly<{ token: symbol; runId: string; generation: number; isLatest: () => boolean; isActive: () => boolean; deactivate: () => void; releaseLatest: () => void }>
/** Durable identity of a call within one native provider declaration. Provider ids are
 * only unique inside that declaration, so they are never sufficient row identity. */
type BatchCallRef = Readonly<{ batchId: string; batchOrdinal: number }>;
type NativeBatchRangeCall = Readonly<{ id: string; name: ToolName; rawParams: RawToolParamsObj; ordinal: number }>;
const skippedPendingToolRow = (message: ToolMessage<ToolName> & { type: 'tool_request' }, content: string): ToolMessage<ToolName> => ({
	role: 'tool',
	type: 'skipped',
	name: message.name,
	content,
	result: null,
	id: message.id,
	rawParams: message.rawParams,
	mcpServerName: message.mcpServerName,
	...(message.batchId === undefined ? {} : { batchId: message.batchId }),
	...(message.batchOrdinal === undefined ? {} : { batchOrdinal: message.batchOrdinal }),
})
/** Ephemeral authority for a single live card. The provider tool id is not unique across
 * parent runs, so only this generated receipt may stop the operation. */
type ActiveToolCardReceipt = {
	toolId: string;
	batchRef?: BatchCallRef;
	messageIndex: number;
	cancel: () => void;
	isCurrent: () => boolean;
	interruptInstalled: boolean;
	cancelling: boolean;
}
type ParentSafeReadLedgerEntry = {
	toolId: string;
	receiptId: string;
	batchRef: BatchCallRef;
	messageIndex: number;
	started: boolean;
	interruptInstalled: boolean;
	settled: boolean;
	cancelled: boolean;
};

const beginParentRunOwnership = (threadId: string, tokens: Map<string, symbol>, generations: Map<string, number>): ParentRunOwnership => {
	const token = Symbol('parent-run')
	const runId = generateUuid()
	const generation = generations.get(threadId) ?? 0
	let active = true
	tokens.set(threadId, token)
	const isLatest = () => tokens.get(threadId) === token && (generations.get(threadId) ?? 0) === generation
	return Object.freeze({
		token,
		runId,
		generation,
		isLatest,
		isActive: () => active && isLatest(),
		deactivate: () => { active = false },
		releaseLatest: () => { if (isLatest()) tokens.delete(threadId) },
	})
}


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
export type PendingChatSubmission = Readonly<{
	id: string;
	threadId: string;
	generation: number;
	displayContent: string;
	selections: readonly StagingSelectionItem[];
	phase: 'preparing';
}>;
export type ChatSubmissionReceipt = Readonly<{
	id: string;
	accepted: boolean;
	settled: Promise<boolean>;
}>;
type PendingChatSubmissionRecord = PendingChatSubmission & {
	draft: string;
	composerCleared: boolean;
	priorRun?: Promise<void>;
};
export type PendingInputMode = 'queue' | 'steer' | 'stop_and_send';
export type PendingChatInput = Readonly<{
	id: string;
	threadId: string;
	text: string;
	/** The original composer text is retained separately from delivery state. */
	draft: string;
	selections: readonly StagingSelectionItem[];
	mode: PendingInputMode;
	order: number;
	createdAt: number;
	ownerProjectRoot: string | undefined;
	trustedAtSubmit: boolean;
	generation: number;
	runId?: string;
	/** `claiming` is an in-process delivery lease and revives as dormant after restart. */
	phase: 'queued' | 'steering' | 'claiming' | 'dormant';
	claimId?: string;
}>;
type PendingChatInputRecord = PendingChatInput;
type PendingChatInputStorageEnvelope = Readonly<{ version: 1; records: readonly unknown[] }>;
type ParentRunQuiescence = {
	runId: string;
	generation: number;
	settled: Promise<void>;
	/** Present only while an approval-request row holds the logical turn open. */
	releaseAwaitingApproval?: () => void;
};
type StartingParentRun = Readonly<{ id: string; generation: number }>;

const comparePendingChatInputs = (a: PendingChatInput, b: PendingChatInput): number =>
	a.order - b.order || a.id.localeCompare(b.id);

const isPendingInputMode = (value: unknown): value is PendingInputMode =>
	value === 'queue' || value === 'steer' || value === 'stop_and_send';
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
		retry?: { attempt: number; maxAttempts: number; retryAt: number; };
	} | { // an assistant message is being written
		isRunning: 'LLM';
		error?: undefined;
		llmInfo: {
			displayContentSoFar: string;
			reasoningSoFar: string;
			toolCallSoFar: RawToolCallObj | null;
			/** Ordered native calls are retained for the streaming preview; the singular
			 * field remains the first call for existing interruption presentation. */
			toolCallsSoFar?: readonly RawToolCallObj[];
		};
		toolInfo?: undefined;
		interrupt: Promise<() => void>; // calling this should have no effect on state - would be too confusing. it just cancels the tool
		retry?: undefined;
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
			receiptId?: string;
		};
		interrupt: Promise<() => void>;
		retry?: undefined;
	} | {
		isRunning: 'awaiting_user';
		error?: undefined;
		llmInfo?: undefined;
		toolInfo?: undefined;
		interrupt?: undefined;
		retry?: undefined;
	} | {
		isRunning: 'idle';
		error?: undefined;
		llmInfo?: undefined;
		toolInfo?: { toolName: ToolName; toolParams: ToolCallParams<ToolName>; id: string; content: string; rawParams: RawToolParamsObj; mcpServerName: string | undefined; receiptId: string; transient: true; startedAt: number; lifecycle?: 'cancelling'; cardStopUnavailableReason?: string; };
		interrupt: 'not_needed' | Promise<() => void>; // calling this should have no effect on state - would be too confusing. it just cancels the tool
		retry?: { attempt: number; maxAttempts: number; retryAt: number; };
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
	onDidChangePendingChatSubmission: Event<{ threadId: string }>;
	getPendingChatSubmission(threadId: string): PendingChatSubmission | undefined;
	onDidChangePendingChatInputs: Event<{ threadId: string }>;
	getPendingChatInputs(threadId: string): readonly PendingChatInput[];
	submitPendingInput(input: { threadId: string; text: string; mode: PendingInputMode; selections?: readonly StagingSelectionItem[] }): PendingChatInput | undefined;
	resumePendingInput(threadId: string, id: string): boolean;
	deletePendingInput(threadId: string, id: string): boolean;
	editPendingInput(threadId: string, id: string, text: string, selections?: readonly StagingSelectionItem[]): boolean;
	reorderPendingInput(threadId: string, id: string, beforeId?: string): boolean;
	onDidChangeChildToolApprovals: Event<void>;
	getChildToolApprovals(parentId: string): readonly ChildToolApprovalView[];
	approveChildToolApproval(key: ChildToolApprovalKey): boolean;
	rejectChildToolApproval(key: ChildToolApprovalKey): boolean;

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
	/** Stops one exact installed tool receipt without revoking the parent run or siblings. */
	cancelToolReceipt(threadId: string, receiptId: string, toolId: string): boolean;
	dismissStreamError(threadId: string): void;

	// call to edit a message
	editUserMessageAndStreamResponse({ userMessage, messageIdx, threadId }: { userMessage: string, messageIdx: number, threadId: string }): Promise<void>;

	// call to add a message
	addUserMessageAndStreamResponse({ userMessage, threadId }: { userMessage: string, threadId: string }): Promise<boolean>;
	beginUserMessageAndStreamResponse({ userMessage, threadId }: { userMessage: string, threadId: string }): ChatSubmissionReceipt;

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
	private readonly _onDidChangePendingChatSubmission = new Emitter<{ threadId: string }>();
	readonly onDidChangePendingChatSubmission: Event<{ threadId: string }> = this._onDidChangePendingChatSubmission.event;
	private readonly _onDidChangePendingChatInputs = new Emitter<{ threadId: string }>();
	readonly onDidChangePendingChatInputs: Event<{ threadId: string }> = this._onDidChangePendingChatInputs.event;
	private readonly _onDidChangeChildToolApprovals = this._register(new Emitter<void>());
	readonly onDidChangeChildToolApprovals: Event<void> = this._onDidChangeChildToolApprovals.event;

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
		this._restorePendingChatInputs()
		this._storeAllThreads(allThreads)

		// always be in a thread
		this.openNewThread()

	}

	// Config is task/session scoped; a turn snapshot is deliberately refreshed only for a user turn.
	private readonly _agentInstructionSessionOfThread = new Map<string, AgentInstructionTaskSessionRecord>();
	private readonly _instructionTurnOfThread = new Map<string, AgentRuntimeTurnSnapshot>();
	private readonly _agentControlGeneration = new Map<string, number>();
	private readonly _parentRunTokenOfThread = new Map<string, symbol>();
	/** Cancellation is retained separately from the persisted tool message until the
	 * underlying operation settles. This lets the card truthfully remain Cancelling
	 * while generation fences keep a late result from replacing it. */
	private readonly _cancellingToolReceiptsOfThread = new Map<string, Map<string, { toolId: string; batchRef?: BatchCallRef; messageIndex: number }>>();
	/** Live-only receipt registry. It is never translated to model history. */
	private readonly _activeToolCardReceiptsOfThread = new Map<string, Map<string, ActiveToolCardReceipt>>();
	private readonly _agentDelegationAuthorityOfThread = new Map<string, AgentDelegationTurnAuthority>();
	private readonly _childToolApprovals = new Map<string, { view: ChildToolApprovalView; resolve: (decision: 'approved' | 'rejected' | 'cancelled') => void }>();
	getChildToolApprovals(parentId: string): readonly ChildToolApprovalView[] { return Object.freeze([...this._childToolApprovals.values()].map(entry => entry.view).filter(view => view.key.parentId === parentId)); }
	private _decideChildToolApproval(key: ChildToolApprovalKey, decision: 'approved' | 'rejected' | 'cancelled'): boolean {
		const structuralKey = childToolApprovalStructuralKey(key); const record = this._childToolApprovals.get(structuralKey);
		if (!record || record.view.key.parentId !== key.parentId || record.view.key.generation !== key.generation || record.view.key.childId !== key.childId || record.view.key.batchId !== key.batchId || record.view.key.batchOrdinal !== key.batchOrdinal || record.view.key.toolId !== key.toolId || record.view.key.snapshotRevision !== key.snapshotRevision) return false;
		this._childToolApprovals.delete(structuralKey); record.resolve(decision); this._onDidChangeChildToolApprovals.fire(); return true;
	}
	approveChildToolApproval(key: ChildToolApprovalKey): boolean { return this._decideChildToolApproval(key, 'approved'); }
	rejectChildToolApproval(key: ChildToolApprovalKey): boolean { return this._decideChildToolApproval(key, 'rejected'); }
	private _cancelChildToolApproval(key: ChildToolApprovalKey): boolean { return this._decideChildToolApproval(key, 'cancelled'); }
	private _awaitChildToolApproval(request: AgentSubagentToolBrokerRequest): Promise<'approved' | 'rejected' | 'cancelled'> {
		const view = createChildToolApprovalView(request); const previous = this._childToolApprovals.get(view.structuralKey);
		if (previous) return Promise.resolve('cancelled');
		return new Promise(resolve => { this._childToolApprovals.set(view.structuralKey, { view, resolve }); this._onDidChangeChildToolApprovals.fire(); });
	}
	private _cancelChildToolApprovalsForParent(parentId: string): void { for (const view of this.getChildToolApprovals(parentId)) this._cancelChildToolApproval(view.key); }
	private readonly _transientComposerDraftOfThread = new Map<string, string>();
	private readonly _pendingChatSubmissionOfThread = new Map<string, PendingChatSubmissionRecord>();
	private readonly _pendingChatInputsOfThread = new Map<string, PendingChatInputRecord[]>();
	private readonly _drainingPendingChatInputs = new Set<string>();
	private readonly _runQuiescenceOfThread = new Map<string, ParentRunQuiescence>();
	/** Closes the receipt-success event seam before a real parent lease exists. */
	private readonly _startingParentRunOfThread = new Map<string, StartingParentRun>();
	private readonly _deletingPendingInputThreads = new Set<string>();
	/** One Stop-and-Send flight may own a parent run. A later queued input must not
	 * abort a replacement parent which happens to use the same thread. */
	private readonly _stopAndSendFlights = new Map<string, Promise<void>>();
	getPendingChatSubmission(threadId: string): PendingChatSubmission | undefined { return this._pendingChatSubmissionOfThread.get(threadId); }
	getTransientComposerDraft(threadId: string): string { return this.state.allThreads[threadId] ? this._transientComposerDraftOfThread.get(threadId) ?? '' : '' }
	setTransientComposerDraft(threadId: string, draft: string): void {
		if (!draft) { this.clearTransientComposerDraft(threadId); return }
		if (!this.state.allThreads[threadId]) return
		const pending = this._pendingChatSubmissionOfThread.get(threadId)
		if (pending) pending.composerCleared = false
		this._transientComposerDraftOfThread.set(threadId, draft)
	}
	clearTransientComposerDraft(threadId: string): void { this._transientComposerDraftOfThread.delete(threadId) }
	clearSubmittedComposerState(threadId: string): void {
		const pending = this._pendingChatSubmissionOfThread.get(threadId)
		if (pending) pending.composerCleared = true
		this.clearTransientComposerDraft(threadId)
		this._setThreadState(threadId, { stagingSelections: [] }, true, true)
	}
	private _setPendingChatSubmission(pending: PendingChatSubmissionRecord): void {
		this._pendingChatSubmissionOfThread.set(pending.threadId, pending)
		this._onDidChangePendingChatSubmission.fire({ threadId: pending.threadId })
	}
	private _settlePendingChatSubmission(pending: PendingChatSubmissionRecord, accepted: boolean): boolean {
		if (this._pendingChatSubmissionOfThread.get(pending.threadId) !== pending) return false
		this._pendingChatSubmissionOfThread.delete(pending.threadId)
		if (!accepted && pending.composerCleared && this.state.allThreads[pending.threadId] && !this.getTransientComposerDraft(pending.threadId) && this.state.allThreads[pending.threadId]!.state.stagingSelections.length === 0) {
			this._transientComposerDraftOfThread.set(pending.threadId, pending.draft)
			this._setThreadState(pending.threadId, { stagingSelections: [...pending.selections] }, true, true)
		}
		this._onDidChangePendingChatSubmission.fire({ threadId: pending.threadId })
		// A failed/cancelled preparation has no parent run left to wake the FIFO
		// drain. Successful admission installs its parent quiescence immediately
		// after this synchronous seam, so do not race that registration here.
		// Focused production-method fixtures intentionally omit the Unit 5
		// quiescence registry. Real service instances always construct it; retain
		// the former no-registry behavior only for those narrow prototype receivers.
		const quiescence = (this as unknown as { _runQuiescenceOfThread?: Map<string, ParentRunQuiescence> })._runQuiescenceOfThread
		const drain = (this as unknown as { _drainPendingChatInputs?: (threadId: string) => Promise<void> })._drainPendingChatInputs
		if (!accepted && !quiescence?.has(pending.threadId) && drain) void drain.call(this, pending.threadId)
		return accepted
	}
	private _cancelPendingChatSubmission(threadId: string): boolean {
		const pending = this._pendingChatSubmissionOfThread.get(threadId)
		if (!pending) return false
		this._revokeAgentDelegation(threadId, true)
		this._settlePendingChatSubmission(pending, false)
		return true
	}
	getPendingChatInputs(threadId: string): readonly PendingChatInput[] {
		return Object.freeze([...(this._pendingChatInputsOfThread.get(threadId) ?? [])].sort(comparePendingChatInputs))
	}
	private _clonePendingSelections(selections: readonly StagingSelectionItem[]): StagingSelectionItem[] {
		return selections.map(selection => {
			switch (selection.type) {
				case 'File': return { ...selection, state: { ...selection.state } };
				case 'CodeSelection': return { ...selection, range: [...selection.range] as [number, number], state: { ...selection.state } };
				case 'Folder': return { ...selection };
				case 'Agent': return { ...selection };
				case 'Skill': return { ...selection };
			}
		})
	}
	private _freezePendingInput(record: Omit<PendingChatInputRecord, 'selections'> & { selections: readonly StagingSelectionItem[] }): PendingChatInputRecord {
		return Object.freeze({ ...record, selections: Object.freeze(this._clonePendingSelections(record.selections)) })
	}
	private _currentPendingInputOwner(): string | undefined { return this._workspaceContextService.getWorkspace().folders[0]?.uri.toString() }
	private _isPendingInputOwnerCurrent(ownerProjectRoot: string | undefined, trustedAtSubmit: boolean): boolean {
		return ownerProjectRoot === this._currentPendingInputOwner() && trustedAtSubmit === this._workspaceTrustManagementService.isWorkspaceTrusted()
	}
	private _storePendingChatInputs(): void {
		const records = [...this._pendingChatInputsOfThread.values()].flat().sort(comparePendingChatInputs).map(record => ({ ...record, selections: this._clonePendingSelections(record.selections) }))
		const envelope: PendingChatInputStorageEnvelope = { version: 1, records }
		this._storageService.store(PENDING_CHAT_INPUT_STORAGE_KEY, JSON.stringify(envelope), StorageScope.WORKSPACE, StorageTarget.USER)
	}
	private _revivePendingSelection(value: unknown): StagingSelectionItem | undefined {
		if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
		const record = value as Record<string, unknown>
		const reviveUri = (candidate: unknown): URI | undefined => {
			if (URI.isUri(candidate)) return candidate
			if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined
			const components = candidate as Record<string, unknown>
			if (components.$mid !== 1 || typeof components.scheme !== 'string' || typeof components.path !== 'string') return undefined
			try {
				const uri = URI.revive(components as never)
				return URI.isUri(uri) ? uri : undefined
			} catch { return undefined }
		}
		if (record.type === 'File') {
			const uri = reviveUri(record.uri)
			if (!uri || typeof record.language !== 'string' || !record.state || typeof record.state !== 'object' || (record.state as Record<string, unknown>).wasAddedAsCurrentFile === undefined || typeof (record.state as Record<string, unknown>).wasAddedAsCurrentFile !== 'boolean') return undefined
			return { type: 'File', uri, language: record.language, state: { wasAddedAsCurrentFile: (record.state as Record<string, boolean>).wasAddedAsCurrentFile } }
		}
		if (record.type === 'CodeSelection') {
			const uri = reviveUri(record.uri); const range = record.range
			if (!uri || typeof record.language !== 'string' || !Array.isArray(range) || range.length !== 2 || !range.every(Number.isSafeInteger) || !record.state || typeof record.state !== 'object' || typeof (record.state as Record<string, unknown>).wasAddedAsCurrentFile !== 'boolean') return undefined
			return { type: 'CodeSelection', uri, language: record.language, range: [range[0], range[1]], state: { wasAddedAsCurrentFile: (record.state as Record<string, boolean>).wasAddedAsCurrentFile } }
		}
		if (record.type === 'Folder') {
			const uri = reviveUri(record.uri)
			return uri ? { type: 'Folder', uri } : undefined
		}
		if (record.type === 'Agent') return isAgentDelegationSelection(record) ? { ...record } : undefined
		if (record.type === 'Skill' && typeof record.identity === 'string' && !!record.identity && typeof record.catalogRevision === 'string' && !!record.catalogRevision && typeof record.bodyRevision === 'string' && !!record.bodyRevision && typeof record.skillRoot === 'string' && !!record.skillRoot && typeof record.description === 'string') {
			return { type: 'Skill', identity: record.identity, catalogRevision: record.catalogRevision, bodyRevision: record.bodyRevision, skillRoot: record.skillRoot, description: record.description }
		}
		return undefined
	}
	private _revivePendingChatInput(value: unknown): PendingChatInputRecord | undefined {
		if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
		const record = value as Record<string, unknown>
		const { id, threadId, text, draft, selections: storedSelections, mode, order, createdAt, ownerProjectRoot, trustedAtSubmit, generation, runId } = record
		if (typeof id !== 'string' || !id || typeof threadId !== 'string' || !threadId || typeof text !== 'string' || !text.trim() || !Array.isArray(storedSelections) || !isPendingInputMode(mode) || typeof order !== 'number' || !Number.isSafeInteger(order) || order < 0 || typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt) || createdAt < 0 || (ownerProjectRoot !== undefined && typeof ownerProjectRoot !== 'string') || typeof trustedAtSubmit !== 'boolean' || typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 0 || (runId !== undefined && typeof runId !== 'string')) return undefined
		const selections = storedSelections.map(selection => this._revivePendingSelection(selection))
		if (selections.some(selection => !selection)) return undefined
		// Workspace-scoped storage keeps another project from seeing this record. A
		// trust/owner change still leaves this user-authored draft visible as dormant;
		// `_canDeliverPendingChatInput` and `resumePendingInput` fail closed until it
		// again matches the current workspace snapshot.
		if (!this.state.allThreads[threadId]) return undefined
		return this._freezePendingInput({ id, threadId, text, draft: typeof draft === 'string' ? draft : text, selections: selections as StagingSelectionItem[], mode, order, createdAt, ownerProjectRoot, trustedAtSubmit, generation, ...(typeof runId === 'string' ? { runId } : {}), phase: 'dormant' })
	}
	private _restorePendingChatInputs(): void {
		const raw = this._storageService.get(PENDING_CHAT_INPUT_STORAGE_KEY, StorageScope.WORKSPACE)
		if (!raw) return
		try {
			const parsed = JSON.parse(raw) as unknown
			const records = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' && (parsed as PendingChatInputStorageEnvelope).version === 1 && Array.isArray((parsed as PendingChatInputStorageEnvelope).records) ? (parsed as PendingChatInputStorageEnvelope).records : undefined)
			if (!records) return
			const seen = new Set<string>()
			for (const value of records) {
				const record = this._revivePendingChatInput(value)
				if (!record || seen.has(record.id)) continue
				seen.add(record.id)
				const items = this._pendingChatInputsOfThread.get(record.threadId) ?? []
				items.push(record); this._pendingChatInputsOfThread.set(record.threadId, items)
			}
			this._storePendingChatInputs()
		} catch { /* Malformed or foreign-workspace inbox data is never replayed. */ }
	}
	private _setPendingChatInputs(threadId: string, records: readonly PendingChatInputRecord[]): void {
		const seen = new Set<string>()
		const normalized = records.filter(record => record.threadId === threadId && !seen.has(record.id) && (seen.add(record.id), true)).sort(comparePendingChatInputs)
		if (normalized.length) this._pendingChatInputsOfThread.set(threadId, normalized)
		else this._pendingChatInputsOfThread.delete(threadId)
		this._storePendingChatInputs(); this._onDidChangePendingChatInputs.fire({ threadId })
	}
	private _findPendingChatInput(threadId: string, id: string): PendingChatInputRecord | undefined {
		return this._pendingChatInputsOfThread.get(threadId)?.find(record => record.id === id)
	}
	private _claimPendingChatInput(threadId: string, id: string, phase: 'queued' | 'steering'): PendingChatInputRecord | undefined {
		const items = this._pendingChatInputsOfThread.get(threadId) ?? []
		const record = items.find(item => item.id === id && item.phase === phase)
		if (!record) return undefined
		const claimed = this._freezePendingInput({ ...record, phase: 'claiming', claimId: generateUuid() })
		this._setPendingChatInputs(threadId, items.map(item => item.id === id ? claimed : item))
		return claimed
	}
	private _finishPendingChatInputClaim(threadId: string, record: PendingChatInputRecord, result: 'remove' | 'queued' | 'dormant'): boolean {
		const items = this._pendingChatInputsOfThread.get(threadId) ?? []
		const current = items.find(item => item.id === record.id)
		if (!current || current.phase !== 'claiming' || current.claimId !== record.claimId) return false
		if (result === 'remove') this._setPendingChatInputs(threadId, items.filter(item => item.id !== record.id))
		else this._setPendingChatInputs(threadId, items.map(item => item.id === record.id ? this._freezePendingInput({ ...item, mode: result === 'queued' ? 'queue' : item.mode, phase: result, claimId: undefined, runId: result === 'queued' ? undefined : item.runId }) : item))
		return true
	}
	submitPendingInput({ threadId, text, mode, selections }: { threadId: string; text: string; mode: PendingInputMode; selections?: readonly StagingSelectionItem[] }): PendingChatInput | undefined {
		const thread = this.state.allThreads[threadId]; if (!thread || this._deletingPendingInputThreads.has(threadId) || !text.trim()) return undefined
		const active = this._runQuiescenceOfThread.get(threadId)
		const phase: PendingChatInput['phase'] = mode === 'steer' && active ? 'steering' : 'queued'
		let items = [...(this._pendingChatInputsOfThread.get(threadId) ?? [])]
		let maxOrder = items.reduce((largest, item) => Math.max(largest, item.order), -1)
		if (maxOrder >= Number.MAX_SAFE_INTEGER) {
			items = items.sort(comparePendingChatInputs).map((item, order) => this._freezePendingInput({ ...item, order }))
			maxOrder = items.length - 1
		}
		const record = this._freezePendingInput({ id: generateUuid(), threadId, text, draft: text, selections: selections ?? thread.state.stagingSelections, mode, order: maxOrder + 1, createdAt: Date.now(), ownerProjectRoot: this._currentPendingInputOwner(), trustedAtSubmit: this._workspaceTrustManagementService.isWorkspaceTrusted(), generation: active?.generation ?? (this._agentControlGeneration.get(threadId) ?? 0), ...(active ? { runId: active.runId } : {}), phase })
		items.push(record); this._setPendingChatInputs(threadId, items)
		// The event is synchronous. A listener may delete this record before any
		// privileged Stop side effect runs, so re-read the exact stored identity.
		const current = this._findPendingChatInput(threadId, record.id)
		if (mode === 'stop_and_send' && current === record && current.phase === 'queued' && this._canDeliverPendingChatInput(current)) void this._stopAndSendPendingInput(threadId, record, active)
		else if (phase === 'queued') void this._drainPendingChatInputs(threadId)
		return record
	}
	deletePendingInput(threadId: string, id: string): boolean { const items = this._pendingChatInputsOfThread.get(threadId) ?? []; if (!items.some(item => item.id === id)) return false; this._setPendingChatInputs(threadId, items.filter(item => item.id !== id)); return true }
	editPendingInput(threadId: string, id: string, text: string, selections?: readonly StagingSelectionItem[]): boolean { if (!text.trim()) return false; const items = this._pendingChatInputsOfThread.get(threadId) ?? []; const index = items.findIndex(item => item.id === id); if (index < 0 || items[index].phase === 'claiming') return false; items[index] = this._freezePendingInput({ ...items[index], text, draft: text, ...(selections ? { selections } : {}) }); this._setPendingChatInputs(threadId, items); return true }
	reorderPendingInput(threadId: string, id: string, beforeId?: string): boolean { const items = [...(this._pendingChatInputsOfThread.get(threadId) ?? [])].sort(comparePendingChatInputs); const index = items.findIndex(item => item.id === id); if (index < 0 || items[index].phase === 'claiming') return false; const [item] = items.splice(index, 1); const target = beforeId === undefined ? items.length : items.findIndex(candidate => candidate.id === beforeId && candidate.phase !== 'claiming'); if (target < 0) return false; items.splice(target, 0, item); this._setPendingChatInputs(threadId, items.map((candidate, order) => this._freezePendingInput({ ...candidate, order }))); return true }
	resumePendingInput(threadId: string, id: string): boolean { const items = this._pendingChatInputsOfThread.get(threadId) ?? []; const index = items.findIndex(item => item.id === id); if (this._deletingPendingInputThreads.has(threadId) || index < 0 || items[index].phase !== 'dormant' || !this._canDeliverPendingChatInput(items[index])) return false; items[index] = this._freezePendingInput({ ...items[index], mode: 'queue', phase: 'queued', runId: undefined, claimId: undefined }); this._setPendingChatInputs(threadId, items); void this._drainPendingChatInputs(threadId); return true }
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
			// This is an intentional user-turn rebuild. The prior authority is revoked by
			// the caller's new-turn boundary, so do not advance the generation twice.
			this._purgeInstructionTurn(threadId, true, false)
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
	/** Revocation is a parent lifecycle boundary, never a view/switch boundary. */
	private _revokeAgentDelegation(threadId: string, forget = false) {
		this._toolsService.invalidateReadReceipts(threadId)
		this._parentRunTokenOfThread.delete(threadId)
		this._cancelChildToolApprovalsForParent(threadId)
		this._agentDelegationAuthorityOfThread.delete(threadId)
		this._agentControlGeneration.set(threadId, (this._agentControlGeneration.get(threadId) ?? 0) + 1)
		if (forget) this._agentSubagentService.forgetParent(threadId)
		else this._agentSubagentService.cancelParent(threadId)
	}
	private _purgeInstructionTurn(threadId: string, removeSession = true, revoke = true) {
		if (revoke) this._revokeAgentDelegation(threadId)
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
		for (const threadId of Object.keys(this.state.allThreads)) this._deletingPendingInputThreads.add(threadId)
		for (const threadId of this._pendingChatSubmissionOfThread.keys()) this._cancelPendingChatSubmission(threadId)
		for (const threadId of Object.keys(this.state.allThreads)) this._revokeAgentDelegation(threadId, true)
		this._agentControlGeneration.clear()
		this._parentRunTokenOfThread.clear()
		this._cancellingToolReceiptsOfThread.clear()
		this._activeToolCardReceiptsOfThread?.clear()
		this._agentInstructionSessionOfThread.clear()
		this._transientComposerDraftOfThread.clear()
		for (const quiescence of this._runQuiescenceOfThread.values()) quiescence.releaseAwaitingApproval?.()
		this._pendingChatInputsOfThread.clear(); this._drainingPendingChatInputs.clear(); this._runQuiescenceOfThread.clear(); this._startingParentRunOfThread?.clear(); this._stopAndSendFlights.clear(); this._storePendingChatInputs()
		this._restoreInstructionTurns(newState.allThreads)
		this.state = newState
		this._deletingPendingInputThreads.clear()
		this._onDidChangeCurrentThread.fire()
	}
	resetState() {
		for (const threadId of Object.keys(this.state.allThreads)) this._deletingPendingInputThreads.add(threadId)
		for (const threadId of this._pendingChatSubmissionOfThread.keys()) this._cancelPendingChatSubmission(threadId)
		for (const threadId of Object.keys(this.state.allThreads)) this._revokeAgentDelegation(threadId, true)
		this._agentControlGeneration.clear()
		this._parentRunTokenOfThread.clear()
		this._cancellingToolReceiptsOfThread.clear()
		this._activeToolCardReceiptsOfThread?.clear()
		this._agentInstructionSessionOfThread.clear()
		this._instructionTurnOfThread.clear()
		this._transientComposerDraftOfThread.clear()
		for (const quiescence of this._runQuiescenceOfThread.values()) quiescence.releaseAwaitingApproval?.()
		this._pendingChatInputsOfThread.clear(); this._drainingPendingChatInputs.clear(); this._runQuiescenceOfThread.clear(); this._startingParentRunOfThread?.clear(); this._stopAndSendFlights.clear(); this._storePendingChatInputs()
		this.state = { allThreads: {}, currentThreadId: null as unknown as string } // see constructor
		this._deletingPendingInputThreads.clear()
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
			}).map(message => message.role === 'assistant'
				? { ...message, displayContent: sanitizeAssistantDisplayContent(message.displayContent) }
				: message);
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
			const messages = newState.allThreads[threadId]?.messages ?? []
			let pendingApproval: Extract<ChatMessage, { role: 'tool' }> | undefined
			for (const message of messages) {
				if (message.role !== 'tool') continue
				const ref = message.batchId === undefined || message.batchOrdinal === undefined ? undefined : { batchId: message.batchId, batchOrdinal: message.batchOrdinal }
				if (message.type === 'running_now') {
					// Earlier snapshot entries may already have been terminalized when a
					// sibling closed this batch. Revalidate the exact live row before
					// touching it so reload never appends a duplicate after the tail.
					const current = (this.state.allThreads[threadId]?.messages ?? []).find(candidate => candidate.role === 'tool' && candidate.id === message.id && candidate.batchId === message.batchId && candidate.batchOrdinal === message.batchOrdinal)
					if (current !== message || current.type !== 'running_now') continue
					// A reload has no physical receipt to resume. Close its later ordinals and
					// settle this exact persisted row once; it must never be replayed.
					if (ref) this._terminalizeBatchTailAfter(threadId, ref, 'Native tool batch was interrupted by restart before this call could finish.')
					this._updateLatestTool(threadId, { role: 'tool', type: 'rejected', content: message.content, id: message.id, rawParams: message.rawParams, result: null, name: message.name, params: message.params, mcpServerName: message.mcpServerName, ...ref })
					continue
				}
				if (message.type !== 'tool_request') continue
				const requiresNativeIdentity = requiresNativeToolBatchRowIdentity(messages, message)
				if (!requiresNativeIdentity) { pendingApproval = message; continue }
				const identity = validateNativeToolBatchRowIdentity(messages, message)
				const valid = !!identity && identity.rowIndex === messages.length - 1 && hasSafeNativeToolBatchApprovalHistory(messages, message)
				if (valid && !pendingApproval) pendingApproval = message
				else {
					const reason = 'Native tool batch could not be resumed after restart.'
					const index = messages.indexOf(message)
					if (index >= 0 && messages[index] === message) this._editMessageInThread(threadId, index, skippedPendingToolRow(message, reason))
					if (ref) this._terminalizeBatchTail(threadId, ref.batchId, reason)
				}
			}
			if (pendingApproval) this._setStreamState(threadId, { isRunning: 'awaiting_user' })

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

	/** Test receivers intentionally bind production methods without constructing the
	 * full service. Keep the live-only registry lazy so those focused fixtures retain
	 * their narrow dependencies while production always owns the field above. */
	private _activeToolCardReceipts(threadId: string, create = false): Map<string, ActiveToolCardReceipt> | undefined {
		const receiver = this as unknown as { _activeToolCardReceiptsOfThread?: Map<string, Map<string, ActiveToolCardReceipt>> }
		let all = receiver._activeToolCardReceiptsOfThread
		if (!all && create) receiver._activeToolCardReceiptsOfThread = all = new Map()
		if (!all) return undefined
		let receipts = all.get(threadId)
		if (!receipts && create) all.set(threadId, receipts = new Map())
		return receipts
	}

	private _expectedLiveToolMessageIndex(threadId: string, toolId: string, batchRef?: BatchCallRef): number {
		const messages = this.state.allThreads[threadId]?.messages ?? []
		for (let index = messages.length - 1; index >= 0; index--) {
			const message = messages[index]
			if (message.role === 'tool' && message.id === toolId && message.batchId === batchRef?.batchId && message.batchOrdinal === batchRef?.batchOrdinal && (message.type === 'running_now' || message.type === 'tool_request') && message.lifecycle !== 'cancelling') return index
		}
		return messages.length
	}

	/** Register before the visible row is published. `_updateLatestTool` fires state
	 * listeners synchronously, so publishing first would leave a re-entrant card Stop
	 * with no exact receipt to validate. */
	private _registerActiveToolCardReceipt(threadId: string, receiptId: string, toolId: string, batchRef: BatchCallRef | undefined, cancel: () => void, isCurrent: () => boolean, interruptInstalled: boolean, messageIndex = this._expectedLiveToolMessageIndex(threadId, toolId, batchRef)): void {
		this._activeToolCardReceipts(threadId, true)!.set(receiptId, {
			toolId,
			batchRef,
			messageIndex,
			cancel,
			isCurrent,
			interruptInstalled,
			cancelling: false,
		})
	}

	private _retireActiveToolCardReceipt(threadId: string, receiptId: string): void {
		const receipts = this._activeToolCardReceipts(threadId)
		if (!receipts) return
		receipts.delete(receiptId)
		if (receipts.size === 0) {
			const receiver = this as unknown as { _activeToolCardReceiptsOfThread?: Map<string, Map<string, ActiveToolCardReceipt>> }
			receiver._activeToolCardReceiptsOfThread?.delete(threadId)
		}
	}

	private _replaceExactLiveToolCard(threadId: string, receipt: ActiveToolCardReceipt, receiptId: string, update: (message: ToolMessage<ToolName> & { type: 'running_now' }) => ToolMessage<ToolName>): boolean {
		const messages = this.state.allThreads[threadId]?.messages
		const message = messages?.[receipt.messageIndex]
		if (!message || message.role !== 'tool' || message.type !== 'running_now' || message.lifecycle === 'cancelling' || message.id !== receipt.toolId || message.batchId !== receipt.batchRef?.batchId || message.batchOrdinal !== receipt.batchRef?.batchOrdinal || message.receiptId !== receiptId) return false
		const next = update(message)
		const receiver = this as unknown as { _storeAllThreads?: unknown; _editMessageInThread?: (threadId: string, index: number, nextMessage: ChatMessage) => void }
		if (typeof receiver._storeAllThreads === 'function') this._editMessageInThread(threadId, receipt.messageIndex, next)
		else if (typeof receiver._editMessageInThread === 'function') receiver._editMessageInThread(threadId, receipt.messageIndex, next)
		else messages[receipt.messageIndex] = next
		return true
	}

	private _markToolCardInterruptInstalled(threadId: string, receiptId: string): void {
		const receipt = this._activeToolCardReceipts(threadId)?.get(receiptId)
		if (!receipt || receipt.cancelling) return
		receipt.interruptInstalled = true
		this._replaceExactLiveToolCard(threadId, receipt, receiptId, message => ({ ...message, cardStopAvailable: true, cardStopUnavailableReason: undefined }))
	}

	/** Card-local Stop deliberately does not call `abortRunning`: that method revokes
	 * the generation and fan-outs to every child. This only targets the single exact
	 * installed receipt and leaves other parent/group operations alone. */
	cancelToolReceipt(threadId: string, receiptId: string, toolId: string): boolean {
		const receipts = this._activeToolCardReceipts(threadId)
		const receipt = receipts?.get(receiptId)
		if (!receipt || receipt.toolId !== toolId || !receipt.isCurrent() || receipt.cancelling || !receipt.interruptInstalled) return false
		const current = this.state.allThreads[threadId]?.messages[receipt.messageIndex]
		if (!current || current.role !== 'tool' || current.type !== 'running_now' || current.lifecycle === 'cancelling' || current.id !== toolId || current.receiptId !== receiptId) return false
		// Own cancellation before emitting the visible state change. An event listener
		// may immediately click the same card again or settle the operation.
		receipt.cancelling = true
		const cancelling = this._cancellingToolReceiptsOfThread.get(threadId) ?? new Map<string, { toolId: string; batchRef?: BatchCallRef; messageIndex: number }>()
		const previousCancellation = cancelling.get(receiptId)
		cancelling.set(receiptId, { toolId, batchRef: receipt.batchRef, messageIndex: receipt.messageIndex })
		this._cancellingToolReceiptsOfThread.set(threadId, cancelling)
		if (!this._replaceExactLiveToolCard(threadId, receipt, receiptId, message => ({ ...message, lifecycle: 'cancelling', cardStopAvailable: false, cardStopUnavailableReason: 'Waiting for this tool to stop.' }))) {
			receipt.cancelling = false
			if (previousCancellation) cancelling.set(receiptId, previousCancellation)
			else {
				cancelling.delete(receiptId)
				if (cancelling.size === 0) this._cancellingToolReceiptsOfThread.delete(threadId)
			}
			return false
		}
		try { receipt.cancel() } catch { /* tool settlement remains fenced and exact */ }
		return true
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
		for (let index = messages.length - 1; index >= 0; index--) {
			const message = messages[index]
			if (message.role === 'tool' && message.id === tool.id && message.batchId === tool.batchId && message.batchOrdinal === tool.batchOrdinal && (message.type === 'running_now' || message.type === 'tool_request')) {
				// A restored approval row already owns the durable batch identity.  Tool
				// execution deliberately creates fresh terminal objects, so carry that
				// immutable identity forward instead of relying on a live id lookup.
				this._editMessageInThread(threadId, index, tool.batchId === undefined && message.batchId !== undefined ? { ...tool, batchId: message.batchId, batchOrdinal: message.batchOrdinal } : tool)
				return true
			}
		}
		return false
	}
	private _updateLatestTool = (threadId: string, tool: ChatMessage & { role: 'tool' }) => {
		const swapped = this._swapOutLatestStreamingToolWithResult(threadId, tool)
		if (swapped) return
		this._addMessageToThread(threadId, tool)
	}

	/** Global Stop owns every live receipt.  Unlike card Stop it intentionally does
	 * not require the old generation to remain current, because revocation is the
	 * fence that makes every late completion unable to replace a newer run. */
	private _cancelAllActiveToolReceipts(threadId: string): boolean {
		const cardReceiver = this as unknown as { _activeToolCardReceipts?: (threadId: string) => Map<string, ActiveToolCardReceipt> | undefined };
		const activeToolCardReceipts = cardReceiver._activeToolCardReceipts ?? ChatThreadService.prototype._activeToolCardReceipts;
		const receipts = [...(activeToolCardReceipts.call(this, threadId)?.entries() ?? [])];
		let cancelled = false;
		for (const [receiptId, receipt] of receipts) {
			if (receipt.cancelling) continue;
			const current = this.state.allThreads[threadId]?.messages[receipt.messageIndex];
			// A native safe wave installs every exact receipt before publishing its
			// rows. Stop is allowed to re-enter from the first row publication, so an
			// as-yet unpublished sibling must still receive the cancellation latch.
			// It has no visible row to mark as cancelling and will be published as a
			// params-free skipped row by the wave itself.
			if (!current || current.role !== 'tool' || current.type !== 'running_now' || current.receiptId !== receiptId || current.id !== receipt.toolId) {
				receipt.cancelling = true;
				try { receipt.cancel(); } catch { /* cancellation remains fenced */ }
				cancelled = true;
				continue;
			}
			receipt.cancelling = true;
			const cancelling = this._cancellingToolReceiptsOfThread.get(threadId) ?? new Map<string, { toolId: string; batchRef?: BatchCallRef; messageIndex: number }>();
			cancelling.set(receiptId, { toolId: receipt.toolId, batchRef: receipt.batchRef, messageIndex: receipt.messageIndex });
			this._cancellingToolReceiptsOfThread.set(threadId, cancelling);
			this._replaceExactLiveToolCard(threadId, receipt, receiptId, message => ({ ...message, lifecycle: 'cancelling', cardStopAvailable: false, cardStopUnavailableReason: 'Waiting for this tool to stop.' }));
			try { receipt.cancel(); } catch { /* settlement is still fenced by receipt */ }
			cancelled = true;
		}
		return cancelled;
	}

	/** Global Stop must close declaration rows that have not reached visible execution
	 * yet, while leaving installed siblings to drain their exact cancellation rows. */
	private _terminalizeAbsentBatchRows(threadId: string, batchId: string, reason: string): void {
		const messages = this.state.allThreads[threadId]?.messages ?? [];
		const declaration = resolveNativeToolBatchDeclaration(messages, batchId);
		if (!declaration) return;
		for (let batchOrdinal = 0; batchOrdinal < declaration.batch.calls.length; batchOrdinal++) {
			const call = declaration.batch.calls[batchOrdinal];
			const existing = (this.state.allThreads[threadId]?.messages ?? []).find(message => message.role === 'tool' && message.id === call.id && message.batchId === batchId && message.batchOrdinal === batchOrdinal);
			if (existing) continue;
			this._addMessageToThread(threadId, { role: 'tool', type: 'skipped', name: call.name, content: reason, result: null, id: call.id, rawParams: call.rawParams, mcpServerName: this._computeMCPServerOfToolName(call.name), batchId, batchOrdinal });
		}
	}

	/** Close every unresolved declaration deterministically before history can be sent
	 * back to a native provider. This is derived only from durable rows/declaration;
	 * there is deliberately no in-memory batch cursor to revive after reload. */
	private _terminalizeBatchTail(threadId: string, batchId: string, reason: string): void {
		const messages = this.state.allThreads[threadId]?.messages ?? []
		const declaration = resolveNativeToolBatchDeclaration(messages, batchId)
		if (!declaration) return
		for (let batchOrdinal = 0; batchOrdinal < declaration.batch.calls.length; batchOrdinal++) {
			const call = declaration.batch.calls[batchOrdinal]
			const existing = (this.state.allThreads[threadId]?.messages ?? []).find(message => message.role === 'tool' && message.id === call.id && message.batchId === batchId && message.batchOrdinal === batchOrdinal)
			if (existing?.role === 'tool' && existing.type !== 'running_now' && existing.type !== 'tool_request') continue
			if (existing?.role === 'tool') {
				if (!('params' in existing)) continue
				const index = (this.state.allThreads[threadId]?.messages ?? []).indexOf(existing)
				if (index >= 0) this._editMessageInThread(threadId, index, { role: 'tool', type: 'rejected', name: call.name, params: existing.params, content: reason, result: null, id: call.id, rawParams: call.rawParams, mcpServerName: existing.mcpServerName, batchId, batchOrdinal })
			} else {
				this._addMessageToThread(threadId, { role: 'tool', type: 'skipped', name: call.name, content: reason, result: null, id: call.id, rawParams: call.rawParams, mcpServerName: this._computeMCPServerOfToolName(call.name), batchId, batchOrdinal })
			}
		}
	}

	private _terminalizeBatchTailAfter(threadId: string, batchRef: BatchCallRef, reason: string): void {
		const messages = this.state.allThreads[threadId]?.messages ?? []
		const declaration = resolveNativeToolBatchDeclaration(messages, batchRef.batchId)
		if (!declaration) return
		for (let batchOrdinal = batchRef.batchOrdinal + 1; batchOrdinal < declaration.batch.calls.length; batchOrdinal++) {
			const call = declaration.batch.calls[batchOrdinal]
			const existing = (this.state.allThreads[threadId]?.messages ?? []).find(message => message.role === 'tool' && message.id === call.id && message.batchId === batchRef.batchId && message.batchOrdinal === batchOrdinal)
			if (existing?.role === 'tool' && existing.type !== 'running_now' && existing.type !== 'tool_request') continue
			if (existing?.role === 'tool') {
				if (!('params' in existing)) continue
				const index = (this.state.allThreads[threadId]?.messages ?? []).indexOf(existing)
				if (index >= 0) this._editMessageInThread(threadId, index, { role: 'tool', type: 'rejected', name: call.name, params: existing.params, content: reason, result: null, id: call.id, rawParams: call.rawParams, mcpServerName: existing.mcpServerName, batchId: batchRef.batchId, batchOrdinal })
			} else this._addMessageToThread(threadId, { role: 'tool', type: 'skipped', name: call.name, content: reason, result: null, id: call.id, rawParams: call.rawParams, mcpServerName: this._computeMCPServerOfToolName(call.name), batchId: batchRef.batchId, batchOrdinal })
		}
	}

	approveLatestToolRequest(threadId: string) {
		const releaseAwaitingApproval = (this as unknown as { _releaseAwaitingApprovalQuiescenceIfTracked?: (threadId: string, drain?: boolean) => void })._releaseAwaitingApprovalQuiescenceIfTracked ?? ChatThreadService.prototype._releaseAwaitingApprovalQuiescenceIfTracked
		const thread = this.state.allThreads[threadId]
		if (!thread) { releaseAwaitingApproval.call(this, threadId); return } // should never happen

		const lastMsg = thread.messages[thread.messages.length - 1]
		if (!(lastMsg.role === 'tool' && lastMsg.type === 'tool_request')) { releaseAwaitingApproval.call(this, threadId); return } // should never happen

		const callThisToolFirst: ToolMessage<ToolName> = lastMsg
		const snapshot = this._instructionTurnOfThread.get(threadId)
		const currentOwner = this._workspaceContextService.getWorkspace().folders[0]?.uri.toString()
		if (!snapshot || snapshot.ownerProjectRoot !== currentOwner || snapshot.runCwd !== currentOwner || snapshot.workspaceTrustedAtAdmission !== this._workspaceTrustManagementService.isWorkspaceTrusted()) {
			this._purgeInstructionTurn(threadId)
			const content = 'This tool request cannot resume because the current workspace or trust context no longer matches its instruction snapshot. Send a new message in a new task to continue.'
			this._updateLatestTool(threadId, { role: 'tool', type: 'rejected', params: lastMsg.params, name: lastMsg.name, content, result: null, id: lastMsg.id, rawParams: lastMsg.rawParams, mcpServerName: lastMsg.mcpServerName, ...(lastMsg.batchId === undefined || lastMsg.batchOrdinal === undefined ? {} : { batchId: lastMsg.batchId, batchOrdinal: lastMsg.batchOrdinal }) })
			if (lastMsg.batchId) this._terminalizeBatchTail(threadId, lastMsg.batchId, content)
			this._setStreamState(threadId, undefined)
			releaseAwaitingApproval.call(this, threadId)
			return
		}
		const admittedModel = snapshot.model
		const currentProps = this._currentModelSelectionProps(); const selectedModel = currentProps.modelSelection
		const currentContext = selectedModel ? getModelCapabilities(selectedModel.providerName, selectedModel.modelName, this._settingsService.state.overridesOfModel).contextWindow : 0
		const currentReserve = selectedModel ? Math.max(Math.ceil(currentContext / 2), getReservedOutputTokenSpace(selectedModel.providerName, selectedModel.modelName, { isReasoningEnabled: getIsReasoningEnabledState('Chat', selectedModel.providerName, selectedModel.modelName, currentProps.modelSelectionOptions, this._settingsService.state.overridesOfModel), overridesOfModel: this._settingsService.state.overridesOfModel }) ?? 4096) : 0
		const currentOverride = selectedModel ? this._settingsService.state.overridesOfModel[selectedModel.providerName]?.[selectedModel.modelName] ?? {} : {};
		if (!admittedModel.hasModel || !selectedModel || selectedModel.providerName !== admittedModel.providerName || selectedModel.modelName !== admittedModel.modelName || runtimeModelFingerprint({ providerName: selectedModel.providerName, modelName: selectedModel.modelName, contextWindow: currentContext, reservedOutputTokens: currentReserve, modelSelectionOptions: currentProps.modelSelectionOptions ?? {}, selectedModelOverrides: currentOverride as never }) !== admittedModel.fingerprint) {
			this._purgeInstructionTurn(threadId)
			this._updateLatestTool(threadId, { role: 'tool', type: 'rejected', params: lastMsg.params, name: lastMsg.name, content: 'This tool request cannot resume because its admitted model changed. Send a new message.', result: null, id: lastMsg.id, rawParams: lastMsg.rawParams, mcpServerName: lastMsg.mcpServerName, ...(lastMsg.batchId === undefined || lastMsg.batchOrdinal === undefined ? {} : { batchId: lastMsg.batchId, batchOrdinal: lastMsg.batchOrdinal }) })
			if (lastMsg.batchId) this._terminalizeBatchTail(threadId, lastMsg.batchId, 'This tool request cannot resume because its admitted model changed. Send a new message.')
			this._setStreamState(threadId, undefined)
			releaseAwaitingApproval.call(this, threadId)
			return
		}

		// The approval continuation replaces the pause synchronously below. Do not
		// drain the ordinary FIFO queue in the gap between logical turn segments.
		releaseAwaitingApproval.call(this, threadId, false)
		const parentRun = beginParentRunOwnership(threadId, this._parentRunTokenOfThread, this._agentControlGeneration)
		const startTrackedParentRun = (this as unknown as { _startTrackedParentRun?: (threadId: string, parentRun: ParentRunOwnership, start: () => Promise<void>) => void })._startTrackedParentRun ?? ChatThreadService.prototype._startTrackedParentRun
		startTrackedParentRun.call(this, threadId, parentRun, () =>
			this._runChatAgent({ callThisToolFirst, threadId, instructionSnapshot: snapshot, modelSelection: { providerName: admittedModel.providerName as ModelSelection['providerName'], modelName: admittedModel.modelName }, modelSelectionOptions: admittedModel.modelSelectionOptions as ModelSelectionOptions, agentDelegationAuthority: this._agentDelegationAuthorityOfThread?.get(threadId), parentRun })
		)
	}
	rejectLatestToolRequest(threadId: string, revoke = true) {
		const releaseAwaitingApproval = (this as unknown as { _releaseAwaitingApprovalQuiescenceIfTracked?: (threadId: string, drain?: boolean) => void })._releaseAwaitingApprovalQuiescenceIfTracked ?? ChatThreadService.prototype._releaseAwaitingApprovalQuiescenceIfTracked
		if (revoke) this._revokeAgentDelegation(threadId)
		const thread = this.state.allThreads[threadId]
		if (!thread) { releaseAwaitingApproval.call(this, threadId); return } // should never happen

		const lastMsg = thread.messages[thread.messages.length - 1]

		let params: ToolCallParams<ToolName>
		if (lastMsg.role === 'tool' && lastMsg.type === 'tool_request') {
			params = lastMsg.params
		}
		else { releaseAwaitingApproval.call(this, threadId); return }

		const { name, id, rawParams, mcpServerName } = lastMsg

		const errorMessage = this.toolErrMsgs.rejected
		this._updateLatestTool(threadId, { role: 'tool', type: 'rejected', params: params, name: name, content: errorMessage, result: null, id, rawParams, mcpServerName, ...(lastMsg.batchId === undefined || lastMsg.batchOrdinal === undefined ? {} : { batchId: lastMsg.batchId, batchOrdinal: lastMsg.batchOrdinal }) })
		if (lastMsg.batchId) this._terminalizeBatchTail(threadId, lastMsg.batchId, errorMessage)
		this._setStreamState(threadId, undefined)
		releaseAwaitingApproval.call(this, threadId)
		// Restored approval rows deliberately have no live quiescence lease. Once
		// the user rejects one, wake a durable Queue that was held behind that row.
		const drain = (this as unknown as { _drainPendingChatInputs?: (threadId: string) => Promise<void> })._drainPendingChatInputs
		if (drain) void drain.call(this, threadId)
	}

	private _computeMCPServerOfToolName(toolName: string) {
		if (isAgentSubagentControlName(toolName) || isReadSkillResourceToolName(toolName)) return undefined
		return this._mcpService.getMCPTools()?.find(t => t.name === toolName)?.mcpServerName
	}

	/** Child mutations are deliberately not routed through _runToolCall: that path owns
	 * parent history, streaming state and interactive approval UI. */
	private _createAgentSubagentToolBroker(threadId: string, authority: AgentDelegationTurnAuthority): AgentSubagentToolBroker {
		type BrokerRequestState = { cancelled: boolean; executing: boolean; settled: boolean; interrupt?: () => void; interruptIssued: boolean; pendingKey?: ChildToolApprovalKey; resolve: () => void; quiescent: Promise<void> };
		const requests = new Map<string, BrokerRequestState>();
		// Retaining 128 completed exact batch-call tuples blocks replay without
		// retaining an unbounded log; it does not impose a cumulative child-turn cap.
		const completed = new Map<string, true>();
		const approvalKeyOf = (request: AgentSubagentToolBrokerRequest): ChildToolApprovalKey => Object.freeze({ parentId: request.parentId, generation: request.generation, childId: request.childId, batchId: request.batchId, batchOrdinal: request.batchOrdinal, toolId: request.toolId, snapshotRevision: request.snapshotRevision });
		const keyOf = (request: AgentSubagentToolBrokerRequest) => childToolApprovalStructuralKey(approvalKeyOf(request));
		const rememberCompleted = (key: string) => {
			completed.delete(key);
			completed.set(key, true);
			if (completed.size > 128) completed.delete(completed.keys().next().value!);
		};
		const current = (request: AgentSubagentToolBrokerRequest, state?: BrokerRequestState) =>
			!state?.cancelled && !request.cancellationToken.isCancellationRequested && this._agentDelegationAuthorityOfThread.get(threadId) === authority &&
			(this._agentControlGeneration.get(threadId) ?? 0) === authority.generation && request.parentId === threadId && request.generation === authority.generation &&
			!!this.state.allThreads[threadId] && this._instructionTurnOfThread.get(threadId) === authority.runtimeSnapshot &&
			this._workspaceContextService.getWorkspace().folders[0]?.uri.toString() === authority.runtimeSnapshot.ownerProjectRoot &&
			authority.runtimeSnapshot.runCwd === authority.runtimeSnapshot.ownerProjectRoot && this._workspaceTrustManagementService.isWorkspaceTrusted() === authority.runtimeSnapshot.workspaceTrustedAtAdmission;
		const fail = (error: string) => Object.freeze({ ok: false as const, error });
		const stale = (request: AgentSubagentToolBrokerRequest, state?: BrokerRequestState) => fail(state?.cancelled || request.cancellationToken.isCancellationRequested ? 'cancelled' : 'tool_stale');
		const settle = (state: BrokerRequestState) => { if (!state.settled) { state.settled = true; state.resolve(); } };
		const admitted = (request: AgentSubagentToolBrokerRequest, state: BrokerRequestState) => {
			if (!current(request, state) || request.snapshotRevision !== authority.parentTools.revision || request.tool.name !== request.name || isAgentSubagentControlName(request.name) || isReadSkillResourceToolName(request.name) || request.tool.kind === 'skill_resource') return false;
			const frozen = authority.parentTools.tools.filter(tool => tool.name === request.name);
			if (frozen.length !== 1 || frozen[0] !== request.tool || (readOnlyChildToolNames as readonly string[]).includes(request.name)) return false;
			const live = captureParentModelToolSnapshot('agent', this._mcpService.getMCPTools(), authority.allowed);
			if (live.revision !== authority.parentTools.revision) return false;
			const liveExact = live.tools.filter(tool => tool.name === request.name);
			if (liveExact.length !== 1 || liveExact[0].revision !== request.tool.revision) return false;
			if (request.tool.kind === 'builtin') return !request.tool.mcpServerName && isABuiltinToolName(request.name) && request.tool.approval === approvalTypeOfBuiltinToolName[request.name];
			return request.tool.kind === 'mcp' && !!request.tool.mcpServerName && request.tool.approval === 'MCP tools' && liveExact[0].kind === 'mcp' && liveExact[0].mcpServerName === request.tool.mcpServerName;
		};
		return Object.freeze({
			execute: async (request: AgentSubagentToolBrokerRequest) => {
				const key = keyOf(request);
				if (requests.has(key) || completed.has(key)) return fail('tool_replayed');
				let resolve!: () => void;
				const state: BrokerRequestState = { cancelled: false, executing: false, settled: false, interruptIssued: false, resolve: () => { }, quiescent: new Promise<void>(done => resolve = done) };
				state.resolve = resolve;
				requests.set(key, state); // synchronously installed before the first await
				if (!admitted(request, state)) { settle(state); requests.delete(key); rememberCompleted(key); return stale(request, state); }
				try {
					if (request.tool.kind === 'builtin') {
						if (!isABuiltinToolName(request.name)) return stale(request, state);
						const builtinName: BuiltinToolName = request.name;
						const validate = this._toolsService.validateParams[builtinName];
						if (!validate) return stale(request, state);
						const params: BuiltinToolCallParams[typeof builtinName] = validate(request.rawParams);
						if (!admitted(request, state)) return stale(request, state);
						const approval = request.tool.approval;
						if ((approval === 'edits' && !authority.autoApprove.edits) || (approval === 'terminal' && !authority.autoApprove.terminal) || (approval === 'MCP tools' && !authority.autoApprove.mcp)) {
							state.pendingKey = approvalKeyOf(request); const decision = await this._awaitChildToolApproval(request); state.pendingKey = undefined;
							if (decision === 'rejected') return fail('rejected'); if (decision !== 'approved') return fail('cancelled'); if (!admitted(request, state)) return stale(request, state);
						}
						let prepared: Awaited<ReturnType<IToolsService['prepareWriteFile']>> | undefined;
						if (builtinName === 'write_file') {
							prepared = await this._toolsService.prepareWriteFile(params as BuiltinToolCallParams['write_file'], request.childId);
							if (!prepared || !admitted(request, state)) return stale(request, state);
						}
						const ioLease = this._agentSubagentService?.acquireGroupIo ? await this._agentSubagentService.acquireGroupIo(request.parentId, request.generation, 'write', request.cancellationToken) : { release() { } };
						let result: unknown;
						try {
							if (!admitted(request, state)) return stale(request, state);
							if (prepared) { state.executing = true; result = await prepared.execute(); }
							else {
							const calls = this._toolsService.callTool as unknown as Record<string, (params: unknown, context: unknown) => Promise<{ result: unknown | Promise<unknown>; interruptTool?: () => void }>>;
							const call = await calls[builtinName](params, { ownerThreadId: request.childId, childId: request.childId, maxReadOutputTokens: request.maxReadOutputTokens, cancellationToken: request.cancellationToken });
							state.interrupt = typeof (call as { interruptTool?: unknown }).interruptTool === 'function' ? (call as { interruptTool: () => void }).interruptTool : undefined;
							if (state.cancelled && state.interrupt && !state.interruptIssued) { state.interruptIssued = true; try { state.interrupt(); } catch { } }
							state.executing = true;
							result = await call.result;
						}
						if (!admitted(request, state)) return stale(request, state);
						} finally { ioLease.release(); }
						const stringify = this._toolsService.stringOfResult as unknown as Record<string, (params: unknown, result: unknown) => string>;
						return Object.freeze({ ok: true as const, content: stringify[builtinName](params, result), result });
					}
					if (request.tool.kind !== 'mcp' || !request.tool.mcpServerName || !admitted(request, state)) return stale(request, state);
					if (!authority.autoApprove.mcp) { state.pendingKey = approvalKeyOf(request); const decision = await this._awaitChildToolApproval(request); state.pendingKey = undefined; if (decision === 'rejected') return fail('rejected'); if (decision !== 'approved') return fail('cancelled'); if (!admitted(request, state)) return stale(request, state); }
					const ioLease = this._agentSubagentService?.acquireGroupIo ? await this._agentSubagentService.acquireGroupIo(request.parentId, request.generation, 'write', request.cancellationToken) : { release() { } };
					let result: RawMCPToolCall;
					try { if (!admitted(request, state)) return stale(request, state); state.executing = true;
						result = (await this._mcpService.callMCPTool({ serverName: request.tool.mcpServerName, toolName: request.name, params: request.rawParams })).result as RawMCPToolCall;
						if (!admitted(request, state)) return stale(request, state);
					} finally { ioLease.release(); }
					return Object.freeze({ ok: true as const, content: this._mcpService.stringifyResult(result), result });
				} catch (error) { return fail(state.cancelled || request.cancellationToken.isCancellationRequested ? 'cancelled' : error instanceof Error && /invalid|param/i.test(error.message) ? 'invalid_params' : 'execution_failed'); }
				finally { settle(state); requests.delete(key); rememberCompleted(key); }
			},
			cancel: async (request: AgentSubagentToolBrokerRequest) => {
				const state = requests.get(keyOf(request));
				if (!state) return;
				state.cancelled = true;
				if (state.pendingKey) this._cancelChildToolApproval(state.pendingKey);
				if (state.interrupt && !state.interruptIssued) { state.interruptIssued = true; try { state.interrupt(); } catch { /* cancellation remains fenced */ } }
				await state.quiescent;
			},
		});
	}

	async abortRunning(threadId: string) {
		if (this._pendingChatSubmissionOfThread?.get(threadId) && this._cancelPendingChatSubmission(threadId)) return
		// A safe-read wave can have more than one physical leaf while stream state has
		// only one representative. Cancel all exact receipts before revoking the
		// generation; the leaves drain and settle their own rows afterwards.
		const cardReceiver = this as unknown as { _activeToolCardReceipts?: (threadId: string) => Map<string, ActiveToolCardReceipt> | undefined; _cancelAllActiveToolReceipts?: (threadId: string) => boolean; _terminalizeAbsentBatchRows?: (threadId: string, batchId: string, reason: string) => void }
		const activeToolCardReceipts = cardReceiver._activeToolCardReceipts ?? ChatThreadService.prototype._activeToolCardReceipts
		const cancelAllActiveToolReceipts = cardReceiver._cancelAllActiveToolReceipts ?? ChatThreadService.prototype._cancelAllActiveToolReceipts
		const terminalizeAbsentBatchRows = cardReceiver._terminalizeAbsentBatchRows ?? ChatThreadService.prototype._terminalizeAbsentBatchRows
		const activeReceipts = [...(activeToolCardReceipts.call(this, threadId)?.values() ?? [])]
		const hadActiveCards = activeReceipts.length > 0
		cancelAllActiveToolReceipts.call(this, threadId)
		for (const batchId of new Set(activeReceipts.flatMap(receipt => receipt.batchRef ? [receipt.batchRef.batchId] : []))) {
			terminalizeAbsentBatchRows.call(this, threadId, batchId, 'Native tool batch was cancelled before this call could start.')
		}
		// Child controls deliberately use an idle stream projection so they never enter
		// parent/model history. Capture and mark it before revocation: revocation wakes a
		// deferred wait, but the card must remain visibly Cancelling until that wait has
		// actually observed the fence and clears its own receipt.
		const streamAtAbort = this.streamState[threadId]
		const transientControl = streamAtAbort?.isRunning === 'idle' && streamAtAbort.toolInfo?.transient
			? { state: streamAtAbort, toolInfo: streamAtAbort.toolInfo }
			: undefined
		if (transientControl?.toolInfo.lifecycle === 'cancelling') return
		if (transientControl && transientControl.toolInfo.lifecycle !== 'cancelling') {
			this._setStreamState(threadId, { ...transientControl.state, toolInfo: { ...transientControl.toolInfo, lifecycle: 'cancelling' } })
		}
		this._revokeAgentDelegation(threadId)
		const thread = this.state.allThreads[threadId]
		if (!thread) return // should never happen

		// add assistant message
		if (this.streamState[threadId]?.isRunning === 'LLM') {
			const { displayContentSoFar, reasoningSoFar, toolCallSoFar } = this.streamState[threadId].llmInfo
			this._addMessageToThread(threadId, { role: 'assistant', displayContent: displayContentSoFar, reasoning: reasoningSoFar, anthropicReasoning: null })
			if (toolCallSoFar) this._addMessageToThread(threadId, { role: 'interrupted_streaming_tool', name: toolCallSoFar.name, mcpServerName: this._computeMCPServerOfToolName(toolCallSoFar.name) })
		}
		// add tool that's running
		else if (!hadActiveCards && this.streamState[threadId]?.isRunning === 'tool') {
			const { toolName, toolParams, id, content: content_, rawParams, mcpServerName, receiptId } = this.streamState[threadId].toolInfo
			const content = content_ || this.toolErrMsgs.interrupted
			const messages = this.state.allThreads[threadId]?.messages ?? []
			const messageIndex = messages.length - 1
			const latest = messages[messageIndex]
			const latestBatchRef = latest?.role === 'tool' && latest.batchId !== undefined && latest.batchOrdinal !== undefined ? { batchId: latest.batchId, batchOrdinal: latest.batchOrdinal } : undefined
			if (latestBatchRef) this._terminalizeBatchTailAfter(threadId, latestBatchRef, 'Native tool batch was interrupted before this call could start.')
			if (receiptId && messageIndex >= 0 && latest?.role === 'tool' && latest.id === id && latest.type === 'running_now') { const receipts = this._cancellingToolReceiptsOfThread.get(threadId) ?? new Map(); receipts.set(receiptId, { toolId: id, batchRef: latestBatchRef, messageIndex }); this._cancellingToolReceiptsOfThread.set(threadId, receipts) }
			this._updateLatestTool(threadId, { role: 'tool', name: toolName, params: toolParams, id, content, rawParams, type: 'running_now', result: null, mcpServerName, receiptId, startedAt: latest?.role === 'tool' ? latest.startedAt : undefined, lifecycle: 'cancelling', cardStopAvailable: false, cardStopUnavailableReason: 'Waiting for this tool to stop.', ...latestBatchRef })
		}
		// reject the tool for the user if relevant
		else if (this.streamState[threadId]?.isRunning === 'awaiting_user') {
			this.rejectLatestToolRequest(threadId, false)
		}
		else if (this.streamState[threadId]?.isRunning === 'idle') {
			// do nothing
		}

		// interrupt any effects
		const interrupt = await this.streamState[threadId]?.interrupt
		if (typeof interrupt === 'function')
			interrupt()


		if (!transientControl) this._setStreamState(threadId, undefined)
	}

	private _settleCancelledTool(threadId: string, receiptId: string, toolId: string, toolName: ToolName, toolParams: ToolCallParams<ToolName>, rawParams: RawToolParamsObj, mcpServerName: string | undefined, batchRef?: BatchCallRef): void {
		const receipts = this._cancellingToolReceiptsOfThread?.get(threadId); const receipt = receipts?.get(receiptId)
		if (!receipt || receipt.toolId !== toolId || receipt.batchRef?.batchId !== batchRef?.batchId || receipt.batchRef?.batchOrdinal !== batchRef?.batchOrdinal) return
		receipts!.delete(receiptId); if (receipts!.size === 0) this._cancellingToolReceiptsOfThread?.delete(threadId)
		const messages = this.state.allThreads[threadId]?.messages
		const index = receipt.messageIndex
		// Replace exactly the cancelling receipt, rather than the latest row: old A
		// settles without touching a newer B and does not strand A as Cancelling.
		if (index < 0 || messages?.[index]?.role !== 'tool' || messages[index].id !== toolId || messages[index].batchId !== batchRef?.batchId || messages[index].batchOrdinal !== batchRef?.batchOrdinal || messages[index].receiptId !== receiptId || messages[index].type !== 'running_now' || messages[index].lifecycle !== 'cancelling') return
		this._editMessageInThread(threadId, index, { role: 'tool', name: toolName, params: toolParams, id: toolId, content: this.toolErrMsgs.interrupted, rawParams, type: 'rejected', result: null, mcpServerName, ...batchRef })
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
		agentDelegationAuthority: AgentDelegationTurnAuthority | undefined,
		agentSkillResourceReadAllowed: boolean,
		agentRunGeneration: number | undefined,
		isCurrentParentRun: () => boolean,
		batchRef?: BatchCallRef,
	): Promise<{ awaitingUserApproval?: boolean, interrupted?: boolean, receiptCancelled?: boolean, failure?: string, validatedParams?: ToolCallParams<ToolName> }> {
		if (!isCurrentParentRun()) return { interrupted: true }
		// A few focused production fixtures bind this method to a narrow receiver rather
		// than construct the whole workbench service. Resolve live-card helpers through
		// the prototype without weakening the real service's exact receipt checks.
		const cardReceiver = this as unknown as {
			_registerActiveToolCardReceipt?: (threadId: string, receiptId: string, toolId: string, batchRef: BatchCallRef | undefined, cancel: () => void, isCurrent: () => boolean, interruptInstalled: boolean) => void;
			_markToolCardInterruptInstalled?: (threadId: string, receiptId: string) => void;
			_retireActiveToolCardReceipt?: (threadId: string, receiptId: string) => void;
		};
		const registerActiveToolCardReceipt = cardReceiver._registerActiveToolCardReceipt ?? ChatThreadService.prototype._registerActiveToolCardReceipt;
		const markToolCardInterruptInstalled = cardReceiver._markToolCardInterruptInstalled ?? ChatThreadService.prototype._markToolCardInterruptInstalled;
		const retireActiveToolCardReceipt = cardReceiver._retireActiveToolCardReceipt ?? ChatThreadService.prototype._retireActiveToolCardReceipt;

		// compute these below
		let toolParams: ToolCallParams<ToolName>
		let toolResult: ToolResult<ToolName>
		let toolResultStr: string

		// Check if it's a built-in tool
		const isBuiltInTool = isABuiltinToolName(toolName)
		if (toolName === 'edit_file' || toolName === 'rewrite_file') {
			if (!isCurrentParentRun()) return { interrupted: true }
			const message = `${toolName} is no longer supported; use write_file with native structured arguments.`
			this._addMessageToThread(threadId, { role: 'tool', type: 'invalid_params', rawParams: opts.unvalidatedToolParams, result: null, name: toolName, content: message, id: toolId, mcpServerName, ...batchRef })
			return {}
		}
		// This application read is deliberately not a builtin or MCP call. It is
		// parent-Agent-only, never asks for approval, and resolves authority only
		// from the immutable selected entries of this exact runtime snapshot.
		if (isReadSkillResourceToolName(toolName)) {
			const sameGeneration = () => isCurrentParentRun() && agentRunGeneration !== undefined && (this._agentControlGeneration.get(threadId) ?? 0) === agentRunGeneration;
			if (!sameGeneration()) return { interrupted: true };
			const currentOwnerAndTrustMatch = () => {
				const currentOwner = this._workspaceContextService.getWorkspace().folders[0]?.uri.toString();
				return instructionSnapshot.ownerProjectRoot === currentOwner && instructionSnapshot.runCwd === currentOwner && instructionSnapshot.workspaceTrustedAtAdmission === this._workspaceTrustManagementService.isWorkspaceTrusted();
			};
			const sameRememberedSnapshot = () => this._instructionTurnOfThread.get(threadId) === instructionSnapshot;
			const sameResourceAuthority = () => isCurrentParentRun() && sameGeneration() && sameRememberedSnapshot() && currentOwnerAndTrustMatch();
			const addFailure = (type: 'invalid_params' | 'tool_error', content: string) => {
				if (type === 'invalid_params') this._addMessageToThread(threadId, { role: 'tool', type, rawParams: opts.unvalidatedToolParams, result: null, name: toolName, content, id: toolId, mcpServerName: undefined, ...batchRef });
				else this._addMessageToThread(threadId, { role: 'tool', type, rawParams: opts.unvalidatedToolParams, params: opts.unvalidatedToolParams, result: content, name: toolName, content, id: toolId, mcpServerName: undefined, ...batchRef });
			};
			if (!isCurrentParentRun()) return { interrupted: true };
			if (!sameResourceAuthority()) {
				if (sameRememberedSnapshot()) this._purgeInstructionTurn(threadId);
				if (this.state.allThreads[threadId] && !this._instructionTurnOfThread.has(threadId)) addFailure('tool_error', 'skill_owner_or_trust_changed');
				return { interrupted: true };
			}
			if (!agentSkillResourceReadAllowed) { if (!isCurrentParentRun()) return { interrupted: true }; addFailure('invalid_params', 'read_skill_resource_not_available'); return {}; }
			let params: ReturnType<typeof validateReadSkillResourceToolParams>;
			try { params = validateReadSkillResourceToolParams(opts.unvalidatedToolParams); }
			catch (error) { if (!isCurrentParentRun()) return { interrupted: true }; addFailure('invalid_params', getErrorMessage(error)); return {}; }
			const selection = instructionSnapshot.selected.find(item => item.identity === params.skill);
			if (!selection) { if (!isCurrentParentRun()) return { interrupted: true }; addFailure('tool_error', 'skill_not_selected'); return { failure: 'skill_not_selected', validatedParams: params }; }
			const historyAtRead = this.state.allThreads[threadId]?.messages ?? [];
			const maxReadOutputTokens = instructionSnapshot.model.hasModel
				? computeMaxReadOutputTokens(instructionSnapshot.model.contextWindow, instructionSnapshot.model.reservedOutputTokens, estimateHistoryTokensForReadBudget(historyAtRead))
				: 0;
			const exactInputBudgetChars = instructionSnapshot.model.hasModel ? Math.max(0, instructionSnapshot.model.contextWindow - instructionSnapshot.model.reservedOutputTokens) * 4 : 0;
			const protectedCharsRemaining = Math.max(0, exactInputBudgetChars - assembleProtectedAgentAuthority(instructionSnapshot).length - protectedSkillResourceHistoryLength(historyAtRead));
			const maxResourceChars = Math.min(maxReadOutputTokens * 4, protectedCharsRemaining);
			const maxResourceBytes = maxResourceChars > 0 ? Math.min(Number.MAX_SAFE_INTEGER, maxResourceChars * 3 + 3) : 0;
			const applicationParams = opts.unvalidatedToolParams;
			if (!isCurrentParentRun() || !sameResourceAuthority()) return { interrupted: true };
			const receiptId = generateUuid();
			const settleCancelled = () => this._settleCancelledTool?.(threadId, receiptId, toolId, toolName, applicationParams, applicationParams, undefined, batchRef);
			let interrupted = false;
			let cancelledByCard = false;
			const readCancellation = new CancellationTokenSource();
			const interruptor = () => { if (interrupted) return; interrupted = true; readCancellation.cancel(); };
			const cardInterruptor = () => { cancelledByCard = true; interruptor(); };
			const cancellationOutcome = () => cancelledByCard && isCurrentParentRun() && sameGeneration() ? { receiptCancelled: true } : { interrupted: true };
			const interruptorPromise = Promise.resolve(interruptor);
			registerActiveToolCardReceipt.call(this, threadId, receiptId, toolId, batchRef, cardInterruptor, () => isCurrentParentRun() && sameGeneration(), true);
			// Establish global-Stop authority before publishing the live card. `_updateLatestTool`
			// notifies synchronously, so an observer can otherwise revoke this parent while
			// it still looks idle and leave the just-published row without a settlement path.
			this._setStreamState(threadId, { isRunning: 'tool', interrupt: interruptorPromise, toolInfo: { toolName, toolParams: applicationParams, id: toolId, content: 'interrupted...', rawParams: applicationParams, mcpServerName: undefined, receiptId } });
			if (!isCurrentParentRun()) { retireActiveToolCardReceipt.call(this, threadId, receiptId); return { interrupted: true }; }
			this._updateLatestTool(threadId, { role: 'tool', type: 'running_now', name: toolName, params: applicationParams, content: '(value not received yet...)', result: null, id: toolId, rawParams: applicationParams, mcpServerName: undefined, startedAt: Date.now(), receiptId, cardStopAvailable: true, ...batchRef });
			if (!isCurrentParentRun()) { settleCancelled(); retireActiveToolCardReceipt.call(this, threadId, receiptId); return { interrupted: true }; }
			try {
				const cancelled = Object.freeze({ cancelled: true as const });
				const cancellationRace = new Promise<typeof cancelled>(resolve => readCancellation.token.onCancellationRequested(() => resolve(cancelled)));
				const read = await Promise.race([this._agentSkillsService.readSkillResource(selection, params.resourcePath, { maxResourceBytes, token: readCancellation.token }), cancellationRace]);
				if ('cancelled' in read || interrupted || !isCurrentParentRun() || !sameGeneration()) return cancellationOutcome();
				if (!sameResourceAuthority()) {
					if (sameRememberedSnapshot()) {
						this._purgeInstructionTurn(threadId);
						this._updateLatestTool(threadId, { role: 'tool', type: 'tool_error', params: applicationParams, result: 'skill_owner_or_trust_changed', name: toolName, content: 'skill_owner_or_trust_changed', id: toolId, rawParams: applicationParams, mcpServerName: undefined, ...batchRef });
					}
					return { interrupted: true };
				}
				if (read.body === undefined) throw new Error(read.diagnostic?.code ?? 'skill_resource_unreadable');
				const resource = admitSkillResourceContext(read.body, maxReadOutputTokens);
			const successMessage: ChatMessage & { role: 'tool' } = { role: 'tool', type: 'success', params: applicationParams, result: resource as never, name: toolName, content: resource, id: toolId, rawParams: applicationParams, mcpServerName: undefined, ...batchRef };
				const currentMessages = this.state.allThreads[threadId]?.messages ?? [];
				const prospectiveMessages = [...currentMessages];
				if (prospectiveMessages[prospectiveMessages.length - 1]?.role === 'tool' && (prospectiveMessages[prospectiveMessages.length - 1] as ToolMessage<ToolName>).id === toolId) prospectiveMessages[prospectiveMessages.length - 1] = successMessage;
				else prospectiveMessages.push(successMessage);
				if (!isCurrentParentRun()) return cancellationOutcome();
				try {
					if (!instructionSnapshot.model.hasModel) throw new Error('skill_resource_context_admission_failed');
					const prospectiveAdmissionMessages = closeNativeToolBatchForProspectiveAdmission(prospectiveMessages, batchRef);
					await this._convertToLLMMessagesService.prepareLLMChatMessages({ chatMessages: prospectiveAdmissionMessages, chatMode: 'agent', modelSelection: { providerName: instructionSnapshot.model.providerName as ModelSelection['providerName'], modelName: instructionSnapshot.model.modelName }, instructionSnapshot, agentDelegationAllowed: !!agentDelegationAuthority?.allowed });
				} catch { throw new Error('skill_resource_context_admission_failed'); }
				if (interrupted || !isCurrentParentRun() || !sameGeneration()) return cancellationOutcome();
				if (!sameResourceAuthority()) {
					if (sameRememberedSnapshot()) {
						this._purgeInstructionTurn(threadId);
						this._updateLatestTool(threadId, { role: 'tool', type: 'tool_error', params: applicationParams, result: 'skill_owner_or_trust_changed', name: toolName, content: 'skill_owner_or_trust_changed', id: toolId, rawParams: applicationParams, mcpServerName: undefined, ...batchRef });
					}
					return { interrupted: true };
				}
				this._updateLatestTool(threadId, successMessage);
				return {};
			} catch (error) {
				if (interrupted || !isCurrentParentRun() || !sameGeneration()) return cancellationOutcome();
				if (!sameResourceAuthority()) {
					if (sameRememberedSnapshot()) {
						this._purgeInstructionTurn(threadId);
						this._updateLatestTool(threadId, { role: 'tool', type: 'tool_error', params: applicationParams, result: 'skill_owner_or_trust_changed', name: toolName, content: 'skill_owner_or_trust_changed', id: toolId, rawParams: applicationParams, mcpServerName: undefined, ...batchRef });
					}
					return { interrupted: true };
				}
				const errorMessage = getErrorMessage(error);
				const content = errorMessage.includes('skill_resource_context_admission_failed') ? 'skill_resource_context_admission_failed' : errorMessage;
				this._updateLatestTool(threadId, { role: 'tool', type: 'tool_error', params: applicationParams, result: content, name: toolName, content, id: toolId, rawParams: applicationParams, mcpServerName: undefined, ...batchRef });
				return { failure: content.trim().replace(/\s+/g, ' ').toLowerCase(), validatedParams: params };
			} finally {
				if (interrupted || !isCurrentParentRun() || !sameGeneration()) settleCancelled();
				readCancellation.dispose();
				retireActiveToolCardReceipt.call(this, threadId, receiptId);
			}
		}
		// These application controls are intentionally routed before builtin/MCP
		// classification. Their exact-key validation is authoritative and they never ask
		// for approval or fall through to a server named like a control tool.
		if (isAgentSubagentControlName(toolName)) {
			if (!isCurrentParentRun()) return { interrupted: true }
			const currentAuthority = this._agentDelegationAuthorityOfThread?.get(threadId)
			const currentGeneration = this._agentControlGeneration.get(threadId) ?? 0
			if (!agentDelegationAuthority?.allowed || currentAuthority !== agentDelegationAuthority || agentDelegationAuthority.generation !== currentGeneration) {
				const content = 'agent_delegation_not_authorized: native Agent delegation must be active in the current top-level turn before using child controls.';
				this._addMessageToThread(threadId, { role: 'tool', type: 'invalid_params', rawParams: opts.unvalidatedToolParams, result: null, name: toolName, content, id: toolId, mcpServerName: undefined, ...batchRef });
				return {};
			}
			const controlGeneration = agentDelegationAuthority.generation;
			const isControlCurrent = () => isCurrentParentRun() && this._agentDelegationAuthorityOfThread?.get(threadId) === agentDelegationAuthority && (this._agentControlGeneration.get(threadId) ?? 0) === controlGeneration;
			let control;
			try {
				control = validateAgentSubagentControlParams(toolName, opts.unvalidatedToolParams);
			} catch (error) {
				const content = getErrorMessage(error);
				this._addMessageToThread(threadId, { role: 'tool', type: 'invalid_params', rawParams: opts.unvalidatedToolParams, result: null, name: toolName, content, id: toolId, mcpServerName: undefined, ...batchRef });
				return {};
			}
			if (!isControlCurrent()) return { interrupted: true };
			const validatedParams = control.name === 'spawn_agent'
				? { message: control.message, ...(control.agentType === undefined ? {} : { agent_type: control.agentType }) }
				: control.name === 'wait_agent'
					? { timeout_ms: control.timeoutMs, ...(control.targets === undefined ? {} : { targets: [...control.targets] }) }
					: { target: control.target };
			const receiptId = generateUuid();
			this._setStreamState?.(threadId, { isRunning: 'idle', interrupt: Promise.resolve(() => { }), toolInfo: { toolName, toolParams: validatedParams as never, id: toolId, content: '(child control in progress...)', rawParams: opts.unvalidatedToolParams, mcpServerName: undefined, receiptId, transient: true, startedAt: Date.now(), cardStopUnavailableReason: 'This child control can only be stopped with the parent run, so this card cannot stop it independently.' } });
			const clearTransient = () => { const state = this.streamState[threadId]; if (state?.isRunning === 'idle' && state.toolInfo?.transient && state.toolInfo.receiptId === receiptId) this._setStreamState?.(threadId, { isRunning: 'idle', interrupt: 'not_needed' }); };
			try {
				let result: object;
				if (control.name === 'spawn_agent') result = await this._agentSubagentService.spawn(threadId, control.message, instructionSnapshot, control.agentType, agentDelegationAuthority.roles, agentDelegationAuthority.settingsState, agentDelegationAuthority.settingsOfProvider, controlGeneration, agentDelegationAuthority.parentTools, this._createAgentSubagentToolBroker?.(threadId, agentDelegationAuthority));
				else if (control.name === 'wait_agent') result = await this._agentSubagentService.wait(threadId, control.timeoutMs, control.targets, controlGeneration);
				else result = this._agentSubagentService.interrupt(threadId, control.target, controlGeneration);
				if (!isControlCurrent()) return { interrupted: true };
				clearTransient();
				const content = JSON.stringify(result);
				if (!isControlCurrent()) return { interrupted: true };
				this._addMessageToThread(threadId, { role: 'tool', type: 'success', rawParams: opts.unvalidatedToolParams, result: result as never, name: toolName, params: validatedParams as never, content, id: toolId, mcpServerName: undefined, ...batchRef });
				return {};
			} catch (error) {
				if (!isControlCurrent()) return { interrupted: true };
				const content = getErrorMessage(error);
				this._addMessageToThread(threadId, { role: 'tool', type: 'tool_error', rawParams: opts.unvalidatedToolParams, result: content, name: toolName, params: validatedParams as never, content, id: toolId, mcpServerName: undefined, ...batchRef });
				return { failure: content.trim().replace(/\s+/g, ' ').toLowerCase(), validatedParams };
			} finally {
				clearTransient();
			}
		}


		if (!opts.preapproved) { // skip this if pre-approved
			if (!isCurrentParentRun()) return { interrupted: true }
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
				if (!isCurrentParentRun()) return { interrupted: true }
				const errorMessage = getErrorMessage(error)
				this._addMessageToThread(threadId, { role: 'tool', type: 'invalid_params', rawParams: opts.unvalidatedToolParams, result: null, name: toolName, content: errorMessage, id: toolId, mcpServerName, ...batchRef })
				return {}
			}
			// 2. if tool requires approval, break from the loop, awaiting approval

			const approvalType = isBuiltInTool ? approvalTypeOfBuiltinToolName[toolName] : 'MCP tools'
			if (approvalType) {
				if (!isCurrentParentRun()) return { interrupted: true }
				const autoApprove = this._settingsService.state.globalSettings.autoApprove[approvalType]
				// add a tool_request because we use it for UI if a tool is loading (this should be improved in the future)
				this._addMessageToThread(threadId, { role: 'tool', type: 'tool_request', content: '(Awaiting user permission...)', result: null, name: toolName, params: toolParams, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName, ...batchRef })
				if (!autoApprove) {
					return { awaitingUserApproval: true }
				}
			}
		}
		else {
			if (!isCurrentParentRun()) return { interrupted: true }
			toolParams = opts.validatedParams
		}






		// 3. call the tool. The opaque receipt is registered before publishing the row:
		// state listeners can therefore never click a visible card before its exact
		// cancellation authority exists.
		if (!isCurrentParentRun()) return { interrupted: true }
		const receiptId = generateUuid()
		const settleCancelled = () => this._settleCancelledTool?.(threadId, receiptId, toolId, toolName, toolParams, opts.unvalidatedToolParams, mcpServerName, batchRef)
		let interrupted = false
		let cancelledByCard = false
		let interruptTool: (() => void) | undefined
		const interruptor = () => { if (interrupted) return; interrupted = true; try { interruptTool?.() } catch { } }
		const cardInterruptor = () => { cancelledByCard = true; interruptor() }
		const cancellationOutcome = () => cancelledByCard && isCurrentParentRun() ? { receiptCancelled: true } : { interrupted: true }
		const runningTool = {
			role: 'tool', type: 'running_now', name: toolName, params: toolParams, content: '(value not received yet...)', result: null,
			id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName, startedAt: Date.now(), receiptId, ...batchRef,
			cardStopUnavailableReason: isBuiltInTool ? 'Stop becomes available once this tool provides its cancellation handle.' : 'This MCP tool does not expose an independent cancellation handle.',
		} as const
		const interruptorPromise = Promise.resolve(interruptor)
		registerActiveToolCardReceipt.call(this, threadId, receiptId, toolId, batchRef, cardInterruptor, isCurrentParentRun, false)
		// The global Stop path needs this stream before a synchronous live-row listener
		// can observe the card. If it revokes during the stream event, publish nothing.
		this._setStreamState(threadId, { isRunning: 'tool', interrupt: interruptorPromise, toolInfo: { toolName, toolParams, id: toolId, content: 'interrupted...', rawParams: opts.unvalidatedToolParams, mcpServerName, receiptId } })
		if (!isCurrentParentRun()) { retireActiveToolCardReceipt.call(this, threadId, receiptId); return { interrupted: true } }
		this._updateLatestTool(threadId, runningTool)
		// A row observer can synchronously invoke global Stop. It has already marked
		// this exact receipt Cancelling; settle before returning because no underlying
		// operation has been started yet.
		if (!isCurrentParentRun()) { settleCancelled(); retireActiveToolCardReceipt.call(this, threadId, receiptId); return { interrupted: true } }

		try {
			try {
			if (isBuiltInTool) {
				if (!isCurrentParentRun()) return { interrupted: true }
				const readContext = (() => {
					if (toolName !== 'read_file') return threadId
					if (!instructionSnapshot.model.hasModel) return { ownerThreadId: threadId, maxReadOutputTokens: 0 }
					const baseline = estimateHistoryTokensForReadBudget(this.state.allThreads[threadId]?.messages ?? [])
					return { ownerThreadId: threadId, maxReadOutputTokens: computeMaxReadOutputTokens(instructionSnapshot.model.contextWindow, instructionSnapshot.model.reservedOutputTokens, baseline) }
				})()
				let preparedWrite: Awaited<ReturnType<IToolsService['prepareWriteFile']>> | null = null
				if (toolName === 'write_file') {
					if (!isCurrentParentRun()) return { interrupted: true }
					preparedWrite = await this._toolsService.prepareWriteFile(toolParams as BuiltinToolCallParams['write_file'], threadId)
					if (interrupted || !isCurrentParentRun()) { settleCancelled(); return cancellationOutcome() }
					if (!preparedWrite) throw new Error('Internal error: write_file did not produce a receipt.')
				}
				if (interrupted || !isCurrentParentRun()) { settleCancelled(); return cancellationOutcome() }
				const requiresWriteLease = toolName === 'write_file' || toolName === 'run_command' || toolName === 'run_persistent_command';
				const ioLease = requiresWriteLease && agentRunGeneration !== undefined && this._agentSubagentService?.acquireGroupIo ? await this._agentSubagentService.acquireGroupIo(threadId, agentRunGeneration, 'write') : { release() { } };
				try {
					if (interrupted || !isCurrentParentRun()) { settleCancelled(); return cancellationOutcome() }
					const call = preparedWrite
						? { result: preparedWrite.execute(), interruptTool: undefined }
						: await this._toolsService.callTool[toolName](toolParams as any, readContext)
					const { result, interruptTool: installedInterruptTool } = call
					interruptTool = installedInterruptTool
					if (installedInterruptTool) markToolCardInterruptInstalled.call(this, threadId, receiptId)
					if (interrupted || !isCurrentParentRun()) {
						try { interruptTool?.() } catch { }
						// An installed terminal receipt owns physical cleanup. Retain Cancelling
						// until its result settles so a late-created terminal cannot outlive the row.
						try { await result } catch { }
						settleCancelled(); return cancellationOutcome()
					}

					toolResult = await result
					if (interrupted || !isCurrentParentRun()) { settleCancelled(); return cancellationOutcome() }
				} finally { ioLease.release(); }
			}
			else {
				if (!isCurrentParentRun()) { settleCancelled(); return { interrupted: true } }
				const mcpTools = this._mcpService.getMCPTools()
				const mcpTool = mcpTools?.find(t => t.name === toolName)
				if (!mcpTool) { throw new Error(`MCP tool ${toolName} not found`) }

				if (!isCurrentParentRun()) { settleCancelled(); return { interrupted: true } }
				const ioLease = agentRunGeneration !== undefined && this._agentSubagentService?.acquireGroupIo ? await this._agentSubagentService.acquireGroupIo(threadId, agentRunGeneration, 'write') : { release() { } };
				try {
					if (!isCurrentParentRun()) { settleCancelled(); return { interrupted: true } }
					toolResult = (await this._mcpService.callMCPTool({
						serverName: mcpTool.mcpServerName ?? 'unknown_mcp_server',
						toolName: toolName,
						params: toolParams
					})).result
					if (!isCurrentParentRun()) { settleCancelled(); return cancellationOutcome() }
				} finally { ioLease.release(); }
			}

			if (interrupted || !isCurrentParentRun()) { settleCancelled(); return cancellationOutcome() }
		}
		catch (error) {
			if (!isCurrentParentRun()) { settleCancelled(); return { interrupted: true } }
			if (interrupted) { settleCancelled(); return cancellationOutcome() }

			const errorMessage = getErrorMessage(error)
			this._updateLatestTool(threadId, { role: 'tool', type: 'tool_error', params: toolParams, result: errorMessage, name: toolName, content: errorMessage, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName, ...batchRef })
			return { failure: errorMessage.trim().replace(/\s+/g, ' ').toLowerCase(), validatedParams: toolParams }
		}

		// 4. stringify the result to give to the LLM
		if (!isCurrentParentRun()) return { interrupted: true }
		try {
			const isTerminalCommand = toolName === 'run_command' || toolName === 'run_persistent_command'
			const terminalResult = toolResult as { resolveReason?: { type?: string; exitCode?: number }; result?: string }
			if (isTerminalCommand && terminalResult.resolveReason?.type === 'done' && terminalResult.resolveReason.exitCode !== 0) {
				const content = `${terminalResult.result ?? ''}\n(exit code ${terminalResult.resolveReason.exitCode})`
				this._updateLatestTool(threadId, { role: 'tool', type: 'tool_error', params: toolParams, result: content, name: toolName, content, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName, ...batchRef })
				return { failure: `terminal_exit_${terminalResult.resolveReason.exitCode}`, validatedParams: toolParams }
			}
			if (isBuiltInTool) toolResultStr = this._toolsService.stringOfResult[toolName](toolParams as any, toolResult as any)
			else toolResultStr = this._mcpService.stringifyResult(toolResult as RawMCPToolCall)
		} catch (error) {
			if (!isCurrentParentRun()) return { interrupted: true }
			const errorMessage = this.toolErrMsgs.errWhenStringifying(error)
			this._updateLatestTool(threadId, { role: 'tool', type: 'tool_error', params: toolParams, result: errorMessage, name: toolName, content: errorMessage, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName, ...batchRef })
			return { failure: errorMessage.trim().replace(/\s+/g, ' ').toLowerCase(), validatedParams: toolParams }
		}

		// 5. add to history and keep going
		if (!isCurrentParentRun()) return { interrupted: true }
		if (toolName === 'read_file' && (!isBoundedReadHistory(toolResult as BuiltinToolResultType['read_file'], this._settingsService.state.globalSettings.readFileLimits) || !isBoundedReadHistoryString(toolResultStr, this._settingsService.state.globalSettings.readFileLimits))) {
			if (!isCurrentParentRun()) return { interrupted: true }
			const errorMessage = 'read_file rejected: bounded history validation failed; re-read a smaller continuation.'
			this._updateLatestTool(threadId, { role: 'tool', type: 'tool_error', params: toolParams, result: errorMessage, name: toolName, content: errorMessage, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName, ...batchRef })
			return { failure: errorMessage.trim().replace(/\s+/g, ' ').toLowerCase(), validatedParams: toolParams }
		}
		if (!isCurrentParentRun()) return { interrupted: true }
		this._updateLatestTool(threadId, { role: 'tool', type: 'success', params: toolParams, result: toolResult, name: toolName, content: toolResultStr, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName, ...batchRef })
		return {}
		} finally {
			// The terminal history row carries no live receipt after settlement; only an
			// exact in-flight row remains card-cancellable.
			retireActiveToolCardReceipt.call(this, threadId, receiptId)
		}
	}

	/** Executes one already-planned parent safe-read wave.  It deliberately never
	 * calls `_updateLatestTool`: every visible mutation is addressed by the receipt
	 * and declaration ordinal that was registered before the row became visible. */
	private async _runParentSafeReadWave(threadId: string, calls: readonly NativeBatchRangeCall[], batchId: string, instructionSnapshot: AgentRuntimeTurnSnapshot, agentDelegationAuthority: AgentDelegationTurnAuthority | undefined, agentRunGeneration: number, isCurrentParentRun: () => boolean): Promise<readonly { call: NativeBatchRangeCall; batchRef: BatchCallRef; interrupted?: boolean; receiptCancelled?: boolean; failure?: string; validatedParams?: ToolCallParams<ToolName> }[]> {
		const history = this.state.allThreads[threadId]?.messages ?? [];
		const totalBudget = instructionSnapshot.model.hasModel
			? computeMaxReadOutputTokens(instructionSnapshot.model.contextWindow, instructionSnapshot.model.reservedOutputTokens, estimateHistoryTokensForReadBudget(history))
			: 0;
		const budgets = divideToolWaveOutputBudget(totalBudget, calls.length);
		type Prepared = { call: NativeBatchRangeCall; batchRef: BatchCallRef; params: ToolCallParams<ToolName>; rawParams: RawToolParamsObj; budget: number; receiptId: string; messageIndex: number; interrupted: boolean; cancelledByCard: boolean; published: boolean; interruptTool?: () => void; ledger: ParentSafeReadLedgerEntry };
		type Invalid = { kind: 'invalid'; call: NativeBatchRangeCall; batchRef: BatchCallRef; content: string };
		const results: { call: NativeBatchRangeCall; batchRef: BatchCallRef; interrupted?: boolean; receiptCancelled?: boolean; failure?: string; validatedParams?: ToolCallParams<ToolName> }[] = [];
		const prepared: Prepared[] = [];
		const staged: Array<Prepared | Invalid> = [];
		const messageBase = history.length;
		for (let waveOrdinal = 0; waveOrdinal < calls.length; waveOrdinal++) {
			const call = calls[waveOrdinal]; const batchRef = { batchId, batchOrdinal: call.ordinal };
			if (!isABuiltinToolName(call.name)) { results.push({ call, batchRef, failure: 'safe_read_not_builtin' }); continue; }
			let params: ToolCallParams<ToolName>;
			try { params = this._toolsService.validateParams[call.name](call.rawParams); }
			catch (error) {
				const content = getErrorMessage(error);
				staged.push({ kind: 'invalid', call, batchRef, content });
				results.push({ call, batchRef });
				continue;
			}
			const receiptId = generateUuid();
			const messageIndex = messageBase + waveOrdinal;
			const ledger: ParentSafeReadLedgerEntry = { toolId: call.id, receiptId, batchRef, messageIndex, started: false, interruptInstalled: false, settled: false, cancelled: false };
			const item: Prepared = { call, batchRef, params, rawParams: call.rawParams, budget: budgets[waveOrdinal] ?? 0, receiptId, messageIndex, interrupted: false, cancelledByCard: false, published: false, ledger };
			const cancel = () => { item.cancelledByCard = true; item.ledger.cancelled = true; if (!item.interrupted) { item.interrupted = true; try { item.interruptTool?.(); } catch { } } };
			this._registerActiveToolCardReceipt(threadId, receiptId, call.id, batchRef, cancel, () => isCurrentParentRun() && (this._agentControlGeneration.get(threadId) ?? 0) === agentRunGeneration, false, messageIndex);
			prepared.push(item);
			staged.push(item);
		}
		// Publish all rows in declaration order only after every receipt exists. A
		// synchronous Stop can therefore cancel any member of this wave exactly once.
		for (const item of staged) {
			if ('kind' in item) {
				this._addMessageToThread(threadId, { role: 'tool', type: 'invalid_params', rawParams: item.call.rawParams, result: null, name: item.call.name, content: item.content, id: item.call.id, mcpServerName: undefined, ...item.batchRef });
				continue;
			}
			if (!isCurrentParentRun() || item.interrupted) {
				const exists = (this.state.allThreads[threadId]?.messages ?? []).some(message => message.role === 'tool' && message.id === item.call.id && message.batchId === item.batchRef.batchId && message.batchOrdinal === item.batchRef.batchOrdinal);
				if (!exists) this._addMessageToThread(threadId, { role: 'tool', type: 'skipped', name: item.call.name as ToolName, content: 'Native tool batch was cancelled before this call could start.', result: null, id: item.call.id, rawParams: item.rawParams, mcpServerName: undefined, ...item.batchRef });
				this._retireActiveToolCardReceipt(threadId, item.receiptId);
				results.push(item.cancelledByCard && isCurrentParentRun() ? { call: item.call, batchRef: item.batchRef, receiptCancelled: true } : { call: item.call, batchRef: item.batchRef, interrupted: true });
				continue;
			}
			item.published = true;
			this._addMessageToThread(threadId, { role: 'tool', type: 'running_now', name: item.call.name as ToolName, params: item.params, content: '(value not received yet...)', result: null, id: item.call.id, rawParams: item.rawParams, mcpServerName: undefined, startedAt: Date.now(), receiptId: item.receiptId, cardStopUnavailableReason: 'Stop becomes available once this tool provides its cancellation handle.', ...item.batchRef });
		}
		const first = prepared.find(item => item.published);
		if (first && isCurrentParentRun()) {
			this._setStreamState(threadId, { isRunning: 'tool', interrupt: Promise.resolve(() => { void this.abortRunning(threadId); }), toolInfo: { toolName: first.call.name as ToolName, toolParams: first.params, id: first.call.id, content: 'interrupted...', rawParams: first.rawParams, mcpServerName: undefined, receiptId: first.receiptId } });
		}
		const execute = async (item: Prepared) => {
			const failure = (content: string) => ({ call: item.call, batchRef: item.batchRef, failure: content.trim().replace(/\s+/g, ' ').toLowerCase(), validatedParams: item.params });
			const cancelled = () => item.cancelledByCard && isCurrentParentRun() ? { call: item.call, batchRef: item.batchRef, receiptCancelled: true } : { call: item.call, batchRef: item.batchRef, interrupted: true };
			const settleCancelled = () => this._settleCancelledTool(threadId, item.receiptId, item.call.id, item.call.name as ToolName, item.params, item.rawParams, undefined, item.batchRef);
			try {
				if (!isCurrentParentRun() || item.interrupted) { settleCancelled(); return cancelled(); }
				item.ledger.started = true;
				// This is an operation-scoped lease only. If this parent has no live child
				// group, the service returns a no-op lease and creates no phantom group.
				const groupLease = this._agentSubagentService?.acquireGroupIo ? await this._agentSubagentService.acquireGroupIo(threadId, agentRunGeneration, 'read') : { release() { } };
				try {
				if (!isCurrentParentRun() || item.interrupted) { settleCancelled(); return cancelled(); }
				const context = { ownerThreadId: threadId, maxReadOutputTokens: item.budget };
				const operation = await this._toolsService.callTool[item.call.name as BuiltinToolName](item.params as never, context);
				item.interruptTool = operation.interruptTool;
				if (operation.interruptTool) { item.ledger.interruptInstalled = true; this._markToolCardInterruptInstalled(threadId, item.receiptId); }
				if (!isCurrentParentRun() || item.interrupted) { try { operation.interruptTool?.(); } catch { } try { await operation.result; } catch { } settleCancelled(); return cancelled(); }
				const value = await operation.result;
				if (!isCurrentParentRun() || item.interrupted) { settleCancelled(); return cancelled(); }
				let content: string;
				try { content = this._toolsService.stringOfResult[item.call.name as BuiltinToolName](item.params as never, value as never, context); }
				catch (error) { const message = this.toolErrMsgs.errWhenStringifying(error); this._replaceExactLiveToolCard(threadId, this._activeToolCardReceipts(threadId)!.get(item.receiptId)!, item.receiptId, () => ({ role: 'tool', type: 'tool_error', params: item.params, result: message, name: item.call.name as ToolName, content: message, id: item.call.id, rawParams: item.rawParams, mcpServerName: undefined, ...item.batchRef })); return failure(message); }
				// read_file and search_in_file consume their assigned bound inside the
				// tool service. The remaining safe leaves return UI-friendly raw values,
				// so cap only their model-facing content here while preserving `result`
				// for the visible card. Four UTF-16 code units per token is the same
				// conservative presentation bound used by the read tools.
				if (item.call.name !== 'read_file' && item.call.name !== 'search_in_file') {
					const maxContentChars = Math.max(0, item.budget) * 4;
					if (content.length > maxContentChars) {
						const marker = '\n…[truncated to this tool\'s assigned read budget]';
						content = maxContentChars === 0 ? '' : content.length <= maxContentChars ? content : maxContentChars <= marker.length ? marker.slice(0, maxContentChars) : `${content.slice(0, maxContentChars - marker.length)}${marker}`;
					}
				}
				if (item.call.name === 'read_file' && (!isBoundedReadHistory(value as BuiltinToolResultType['read_file'], this._settingsService.state.globalSettings.readFileLimits) || !isBoundedReadHistoryString(content, this._settingsService.state.globalSettings.readFileLimits))) {
					const message = 'read_file rejected: bounded history validation failed; re-read a smaller continuation.';
					this._replaceExactLiveToolCard(threadId, this._activeToolCardReceipts(threadId)!.get(item.receiptId)!, item.receiptId, () => ({ role: 'tool', type: 'tool_error', params: item.params, result: message, name: item.call.name as ToolName, content: message, id: item.call.id, rawParams: item.rawParams, mcpServerName: undefined, ...item.batchRef })); return failure(message);
				}
				const receipt = this._activeToolCardReceipts(threadId)?.get(item.receiptId);
				if (receipt) this._replaceExactLiveToolCard(threadId, receipt, item.receiptId, () => ({ role: 'tool', type: 'success', params: item.params, result: value as never, name: item.call.name as ToolName, content, id: item.call.id, rawParams: item.rawParams, mcpServerName: undefined, ...item.batchRef }));
				return { call: item.call, batchRef: item.batchRef, validatedParams: item.params };
				} finally { groupLease.release(); }
			} catch (error) {
				if (!isCurrentParentRun() || item.interrupted) { settleCancelled(); return cancelled(); }
				const message = getErrorMessage(error); const receipt = this._activeToolCardReceipts(threadId)?.get(item.receiptId);
				if (receipt) this._replaceExactLiveToolCard(threadId, receipt, item.receiptId, () => ({ role: 'tool', type: 'tool_error', params: item.params, result: message, name: item.call.name as ToolName, content: message, id: item.call.id, rawParams: item.rawParams, mcpServerName: undefined, ...item.batchRef }));
				return failure(message);
			} finally { item.ledger.settled = true; this._retireActiveToolCardReceipt(threadId, item.receiptId); }
		};
		const completed = await Promise.all(prepared.filter(item => item.published).map(execute));
		results.push(...completed);
		return results.sort((a, b) => a.batchRef.batchOrdinal - b.batchRef.batchOrdinal);
	}

	private async _runNativeBatchRange(threadId: string, calls: readonly NativeBatchRangeCall[], batchId: string, instructionSnapshot: AgentRuntimeTurnSnapshot, agentDelegationAuthority: AgentDelegationTurnAuthority | undefined, agentSkillResourceReadAllowed: boolean, agentRunGeneration: number, isCurrentParentRun: () => boolean, accountFailure: (call: NativeBatchRangeCall, mcpServerName: string | undefined, outcome: { failure?: string; validatedParams?: ToolCallParams<ToolName> }, batchRef: BatchCallRef) => boolean): Promise<{ awaitingUserApproval?: boolean; interrupted?: boolean; receiptCancelled?: boolean; circuitOpen?: boolean }> {
		const planned = planToolBatchWaves('parent', calls.map(call => ({ ordinal: call.ordinal, name: call.name })));
		for (const wave of planned) {
			const waveCalls = wave.calls.map(member => calls.find(call => call.ordinal === member.ordinal)!).filter(Boolean);
			if (wave.kind === 'safe_read') {
				const outcomes = await this._runParentSafeReadWave(threadId, waveCalls, batchId, instructionSnapshot, agentDelegationAuthority, agentRunGeneration, isCurrentParentRun);
				for (const outcome of outcomes) {
					if (!isCurrentParentRun() || outcome.interrupted) return { interrupted: true };
					if (outcome.receiptCancelled) { this._terminalizeBatchTailAfter(threadId, outcome.batchRef, 'Native tool batch was cancelled before this call could start.'); return { receiptCancelled: true }; }
					if (accountFailure(outcome.call, undefined, outcome, outcome.batchRef)) return { circuitOpen: true };
				}
				continue;
			}
			const toolCall = waveCalls[0]; const batchRef = { batchId, batchOrdinal: toolCall.ordinal };
			const mcpTool = isAgentSubagentControlName(toolCall.name) || isReadSkillResourceToolName(toolCall.name) ? undefined : this._mcpService.getMCPTools()?.find(tool => tool.name === toolCall.name);
			const outcome = await this._runToolCall(threadId, toolCall.name, toolCall.id, mcpTool?.mcpServerName, { preapproved: false, unvalidatedToolParams: toolCall.rawParams }, instructionSnapshot, agentDelegationAuthority, agentSkillResourceReadAllowed, agentRunGeneration, isCurrentParentRun, batchRef);
			if (!isCurrentParentRun() || outcome.interrupted) return { interrupted: true };
			if (outcome.receiptCancelled) { this._terminalizeBatchTailAfter(threadId, batchRef, 'Native tool batch was cancelled before this call could start.'); return { receiptCancelled: true }; }
			if (outcome.awaitingUserApproval) return { awaitingUserApproval: true };
			if (accountFailure(toolCall, mcpTool?.mcpServerName, outcome, batchRef)) return { circuitOpen: true };
		}
		return {};
	}




	private async _runChatAgent({
		threadId,
		modelSelection,
		modelSelectionOptions,
		callThisToolFirst,
		instructionSnapshot,
		agentDelegationAuthority,
		parentRun,
	}: {
		threadId: string,
		modelSelection: ModelSelection | null,
		modelSelectionOptions: ModelSelectionOptions | undefined,

		callThisToolFirst?: ToolMessage<ToolName> & { type: 'tool_request' }
		instructionSnapshot: AgentRuntimeTurnSnapshot,
		agentDelegationAuthority?: AgentDelegationTurnAuthority,
		parentRun: ParentRunOwnership,
	}) {

		const agentRunGeneration = parentRun.generation
		const isCurrentRun = parentRun.isActive
		let interruptedWhenIdle = false
		const idleInterruptor = Promise.resolve(() => { interruptedWhenIdle = true })
		// _runToolCall does not need setStreamState({idle}) before it, but it needs it after it. (handles its own setStreamState)

		try {
		// above just defines helpers, below starts the actual function
		const { chatMode } = this._settingsService.state.globalSettings // should not change as we loop even if user changes it, so it goes here
		const snapshot = instructionSnapshot;
		// Focused lifecycle receivers deliberately bind the production method to a
		// narrow object. Keep the new scheduler reachable in that harness without
		// changing the production instance path.
		const runNativeBatchRange = (this as unknown as { _runNativeBatchRange?: ChatThreadService['_runNativeBatchRange'] })._runNativeBatchRange ?? ChatThreadService.prototype._runNativeBatchRange
		const isDelegationAuthorityCurrent = () => !!agentDelegationAuthority?.allowed && this._agentDelegationAuthorityOfThread?.get(threadId) === agentDelegationAuthority && (this._agentControlGeneration.get(threadId) ?? 0) === agentDelegationAuthority.generation

		let nMessagesSent = 0
		let shouldSendAnotherMessage = true
		let isRunningWhenEnd: IsRunningType = undefined
		// Parent-run local: successful calls, invalid requests and cancellations never
		// enter it, and a new user turn gets a fresh map.
		const identicalFailures = new Map<string, number>()
		const accountIdenticalFailure = (toolName: ToolName, mcpServerName: string | undefined, failure: string | undefined, validatedParams: ToolCallParams<ToolName> | undefined, rawParams: RawToolParamsObj, batchRef: BatchCallRef | undefined): boolean => {
			if (!failure) return false
			const key = `${toolName.toLowerCase()}|${mcpServerName ?? ''}|${stableToolValue(semanticToolArgs(toolName, validatedParams ?? rawParams))}|${failure}`
			const count = (identicalFailures.get(key) ?? 0) + 1
			identicalFailures.set(key, count)
			if (count < 3) return false
			if (batchRef) this._terminalizeBatchTailAfter(threadId, batchRef, 'Native tool batch was closed after the identical-failure circuit opened.')
			this._setStreamState(threadId, { isRunning: undefined, error: { message: 'The same tool failed three times. Change the request or recover the command before continuing.', fullError: null } })
			return true
		}

		// before enter loop, call tool
		if (callThisToolFirst) {
			const persistedMessages = this.state.allThreads[threadId]?.messages ?? []
			const suppliedCallRef = typeof callThisToolFirst.batchId === 'string' && callThisToolFirst.batchId.length > 0 && Number.isInteger(callThisToolFirst.batchOrdinal) && callThisToolFirst.batchOrdinal! >= 0
				? { batchId: callThisToolFirst.batchId, batchOrdinal: callThisToolFirst.batchOrdinal! }
				: undefined
			const requiresNativeIdentity = requiresNativeToolBatchRowIdentity(persistedMessages, callThisToolFirst)
			const persistedIdentity = requiresNativeIdentity ? validateNativeToolBatchRowIdentity(persistedMessages, callThisToolFirst) : undefined
			const hasSafeApprovalHistory = !requiresNativeIdentity || hasSafeNativeToolBatchApprovalHistory(persistedMessages, callThisToolFirst)
			const invalidPendingBatch = 'The pending native tool batch no longer matches its declaration.'
			if (requiresNativeIdentity && (!hasSafeApprovalHistory || !persistedIdentity || persistedIdentity.rowIndex !== persistedMessages.length - 1)) {
				const index = persistedMessages.indexOf(callThisToolFirst)
				if (index >= 0 && persistedMessages[index] === callThisToolFirst) this._editMessageInThread(threadId, index, skippedPendingToolRow(callThisToolFirst, invalidPendingBatch))
				if (suppliedCallRef) this._terminalizeBatchTailAfter(threadId, suppliedCallRef, invalidPendingBatch)
				this._setStreamState(threadId, { isRunning: undefined, error: { message: invalidPendingBatch, fullError: null } })
				return
			}
			const callRef = persistedIdentity ? { batchId: persistedIdentity.batch.batchId, batchOrdinal: callThisToolFirst.batchOrdinal! } : undefined
			const authoritativeRawParams = persistedIdentity?.call.rawParams ?? callThisToolFirst.rawParams
			let authoritativeValidatedParams = callThisToolFirst.params
			if (persistedIdentity) {
				try {
					authoritativeValidatedParams = isABuiltinToolName(callThisToolFirst.name)
						? this._toolsService.validateParams[callThisToolFirst.name](authoritativeRawParams)
						: authoritativeRawParams as ToolCallParams<ToolName>
				} catch {
					const index = persistedMessages.indexOf(callThisToolFirst)
					if (index >= 0 && persistedMessages[index] === callThisToolFirst) this._editMessageInThread(threadId, index, skippedPendingToolRow(callThisToolFirst, invalidPendingBatch))
					if (callRef) this._terminalizeBatchTailAfter(threadId, callRef, invalidPendingBatch)
					this._setStreamState(threadId, { isRunning: undefined, error: { message: invalidPendingBatch, fullError: null } })
					return
				}
			}
			const current = await this._runToolCall(threadId, callThisToolFirst.name, callThisToolFirst.id, callThisToolFirst.mcpServerName, { preapproved: true, unvalidatedToolParams: authoritativeRawParams, validatedParams: authoritativeValidatedParams }, snapshot, agentDelegationAuthority, chatMode === 'agent', agentRunGeneration, isCurrentRun, callRef)
			if (!isCurrentRun()) return
			if (current.interrupted) {
				this._setStreamState(threadId, undefined)
				return
			}
			if (current.receiptCancelled && callRef) this._terminalizeBatchTailAfter(threadId, callRef, 'Native tool batch was cancelled before this call could start.')
			if (accountIdenticalFailure(callThisToolFirst.name, callThisToolFirst.mcpServerName, current.failure, current.validatedParams, callThisToolFirst.rawParams, callRef)) return
			// An approval is a pause inside a persisted native declaration, not the end
			// of that declaration.  Reconstruct the remaining calls from the immutable
			// assistant row so reload never needs a mutable cursor and cannot replay the
			// already-approved call.
			if (!current.receiptCancelled && callThisToolFirst.batchId !== undefined && callThisToolFirst.batchOrdinal !== undefined) {
				const resumedOrdinal = callThisToolFirst.batchOrdinal;
				const declaration = persistedIdentity?.batch
				if (!declaration || declaration.calls[resumedOrdinal]?.id !== callThisToolFirst.id) {
					this._setStreamState(threadId, { isRunning: undefined, error: { message: 'The pending native tool batch no longer matches its declaration.', fullError: null } })
					return
				}
				const tail = await runNativeBatchRange.call(this, threadId, declaration.calls.slice(resumedOrdinal + 1).map((call, offset) => ({ ...call, ordinal: resumedOrdinal + 1 + offset })), declaration.batchId, snapshot, agentDelegationAuthority, chatMode === 'agent', agentRunGeneration, isCurrentRun, (toolCall, mcpServerName, outcome, tailRef) => accountIdenticalFailure(toolCall.name, mcpServerName, outcome.failure, outcome.validatedParams, toolCall.rawParams, tailRef));
				if (tail.interrupted) { this._setStreamState(threadId, undefined); return }
				if (tail.awaitingUserApproval) { this._setStreamState(threadId, { isRunning: 'awaiting_user' }); return }
				if (tail.circuitOpen) return
			}
		}
		shouldSendAnotherMessage = true
		this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' })  // just decorative, for clarity


		// tool use loop
		while (shouldSendAnotherMessage) {
			if (!isCurrentRun()) return
			// false by default each iteration
			shouldSendAnotherMessage = false
			isRunningWhenEnd = undefined
			nMessagesSent += 1

			this._setStreamState(threadId, { isRunning: 'idle', interrupt: idleInterruptor })
			// A steer becomes model-visible only at this boundary: every preceding tool
			// receipt has settled and the next provider request has not been assembled.
			this._promoteSteerAtSafeBoundary?.(threadId, parentRun)
			// A synchronous history/event observer can Stop or replace this parent while
			// the steer is being claimed. Never assemble a provider request after that.
			if (!isCurrentRun()) return

			const chatMessages = this.state.allThreads[threadId]?.messages ?? []
			const { messages, separateSystemMessage } = await this._convertToLLMMessagesService.prepareLLMChatMessages({
				chatMessages,
				modelSelection,
				chatMode,
				instructionSnapshot: snapshot,
				agentDelegationAllowed: isDelegationAuthorityCurrent(),
			})

			if (!isCurrentRun()) return
			if (interruptedWhenIdle) {
				this._setStreamState(threadId, undefined)
				return
			}

			let shouldRetryLLM = true
			let nAttempts = 0
			while (shouldRetryLLM) {
				if (!isCurrentRun()) return
				shouldRetryLLM = false
				nAttempts += 1

				type ResTypes =
					| { type: 'llmDone', toolCalls: readonly RawToolCallObj[], info: { fullText: string, fullReasoning: string, anthropicReasoning: AnthropicReasoning[] | null } }
					| { type: 'llmError', error?: { message: string; fullError: Error | null; } }
					| { type: 'llmAborted' }

				let providerSettled = false
				let settleProvider: (result: ResTypes) => boolean = () => false
				const messageIsDonePromise = new Promise<ResTypes>(resolve => {
					settleProvider = result => {
						if (providerSettled) return false
						providerSettled = true
						resolve(result)
						return true
					}
				})

				if (!isCurrentRun()) return
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
					onText: ({ fullText, fullReasoning, toolCalls }) => {
						if (providerSettled || !isCurrentRun()) return
						this._setStreamState(threadId, { isRunning: 'LLM', llmInfo: { displayContentSoFar: sanitizeAssistantDisplayContent(fullText, true), reasoningSoFar: fullReasoning, toolCallSoFar: toolCalls?.[0] ?? null, toolCallsSoFar: toolCalls ?? [] }, interrupt: Promise.resolve(() => { if (llmCancelToken) this._llmMessageService.abort(llmCancelToken) }) })
					},
					onFinalMessage: async ({ fullText, fullReasoning, toolCalls, anthropicReasoning, }) => {
						if (providerSettled) return
						if (!isCurrentRun()) { settleProvider({ type: 'llmAborted' }); return }
						settleProvider({ type: 'llmDone', toolCalls: toolCalls ?? [], info: { fullText, fullReasoning, anthropicReasoning } }) // resolve with tool calls
					},
					onError: async (error) => {
						if (providerSettled) return
						if (!isCurrentRun()) { settleProvider({ type: 'llmAborted' }); return }
						settleProvider({ type: 'llmError', error: error })
					},
					onAbort: () => {
						if (providerSettled) return
						if (!isCurrentRun()) { settleProvider({ type: 'llmAborted' }); return }
						// stop the loop to free up the promise, but don't modify state (already handled by whatever stopped it)
						if (!settleProvider({ type: 'llmAborted' })) return
						this._metricsService.capture('Agent Loop Done (Aborted)', { nMessagesSent, chatMode })
					},
				})
				if (!isCurrentRun()) {
					if (llmCancelToken) this._llmMessageService.abort(llmCancelToken)
					return
				}

				// mark as streaming
				if (!llmCancelToken) {
					this._setStreamState(threadId, { isRunning: undefined, error: { message: 'There was an unexpected error when sending your chat message.', fullError: null } })
					break
				}

				this._setStreamState(threadId, { isRunning: 'LLM', llmInfo: { displayContentSoFar: '', reasoningSoFar: '', toolCallSoFar: null }, interrupt: Promise.resolve(() => this._llmMessageService.abort(llmCancelToken)) })
				const llmRes = await messageIsDonePromise // wait for message to complete

				// if something else started running in the meantime
				if (!isCurrentRun() || this.streamState[threadId]?.isRunning !== 'LLM') {
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
						// Keep the first retry observable. It is only stream/UI state: the user
						// message and already-completed tools are never replayed or duplicated.
						this._setStreamState(threadId, { isRunning: 'idle', interrupt: idleInterruptor, retry: { attempt: nAttempts, maxAttempts: CHAT_RETRIES, retryAt: Date.now() + RETRY_DELAY } })
						await timeout(RETRY_DELAY)
						if (!isCurrentRun()) return
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
				const { toolCalls, info } = llmRes
				const validBatch = toolCalls.length === 0 || (toolCalls.every(call => !!call.id && !!call.name) && new Set(toolCalls.map(call => call.id)).size === toolCalls.length)
				if (!validBatch) { this._setStreamState(threadId, { isRunning: undefined, error: { message: 'The provider returned an invalid or duplicate tool-call batch.', fullError: null } }); return }
				const batchId = toolCalls.length ? generateUuid() : undefined
				this._addMessageToThread(threadId, { role: 'assistant', displayContent: info.fullText, reasoning: info.fullReasoning, anthropicReasoning: info.anthropicReasoning, ...(batchId ? { toolBatch: { version: 1 as const, batchId, calls: toolCalls } } : {}) })

				this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' }) // just decorative for clarity

				// The planner keeps serial barriers provider-ordered while allowing only the
				// approved parent safe-read names to share a physical cap-two wave. The next
				// provider request remains behind all declared terminal rows.
				if (toolCalls.length) {
					const batch = await runNativeBatchRange.call(this, threadId, toolCalls.map((call, ordinal) => ({ ...call, ordinal })), batchId!, snapshot, agentDelegationAuthority, chatMode === 'agent', agentRunGeneration, isCurrentRun, (toolCall, mcpServerName, outcome, batchRef) => accountIdenticalFailure(toolCall.name, mcpServerName, outcome.failure, outcome.validatedParams, toolCall.rawParams, batchRef));
					if (!isCurrentRun() || batch.interrupted) { this._setStreamState(threadId, undefined); return }
					if (batch.awaitingUserApproval) { shouldSendAnotherMessage = false; isRunningWhenEnd = 'awaiting_user'; }
					else if (!batch.circuitOpen) shouldSendAnotherMessage = true
					else return

					this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' }) // just decorative, for clarity
				}

			} // end while (attempts)
		} // end while (send message)

		// if awaiting user approval, keep isRunning true, else end isRunning
		if (!isCurrentRun()) return
		this._setStreamState(threadId, { isRunning: isRunningWhenEnd })

		// capture number of messages sent
		this._metricsService.capture('Agent Loop Done', { nMessagesSent, chatMode })
		} finally {
			parentRun.deactivate()
		}
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


	private _wrapRunAgentToNotify(p: Promise<void>, threadId: string, parentRun: ParentRunOwnership): Promise<void> {
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

		return p.then(() => {
			if (!parentRun.isLatest()) return
			if (this.streamState[threadId]?.isRunning !== 'awaiting_user') this._toolsService.invalidateReadReceipts(threadId)
			if (threadId !== this.state.currentThreadId) notify({ error: null })
		}).catch((e) => {
			if (!parentRun.isLatest()) return
			this._toolsService.invalidateReadReceipts(threadId)
			if (threadId !== this.state.currentThreadId) notify({ error: getErrorMessage(e) })
			throw e
		}).finally(() => parentRun.releaseLatest())
	}
	private _trackParentRun(threadId: string, parentRun: ParentRunOwnership, run: Promise<void>): void {
		const wrapped = this._wrapRunAgentToNotify(run, threadId, parentRun)
		let releaseAwaitingApproval!: () => void
		const awaitingApprovalSettled = new Promise<void>(resolve => releaseAwaitingApproval = resolve)
		const settled = wrapped.then(() => undefined, () => undefined).finally(() => {
			const current = this._runQuiescenceOfThread.get(threadId)
			if (current?.runId === parentRun.runId && this.streamState[threadId]?.isRunning === 'awaiting_user') {
				// `_runChatAgent` has returned, but the approval request remains a
				// user-owned logical boundary. Hold FIFO input until it is approved,
				// rejected, or stopped; otherwise a queue drain would reject the row.
				this._runQuiescenceOfThread.set(threadId, { runId: parentRun.runId, generation: parentRun.generation, settled: awaitingApprovalSettled, releaseAwaitingApproval })
				this._releaseUndeliveredSteers(threadId, parentRun)
				return
			}
			// A steer that did not reach a valid tool boundary belongs to the normal
			// FIFO queue once its target parent is truly quiescent. It must never be
			// silently attached to a replacement parent.
			this._releaseUndeliveredSteers(threadId, parentRun)
			if (current?.runId === parentRun.runId) {
				this._runQuiescenceOfThread.delete(threadId)
			}
			void this._drainPendingChatInputs(threadId)
		})
		this._runQuiescenceOfThread.set(threadId, { runId: parentRun.runId, generation: parentRun.generation, settled })
	}
	private _releaseAwaitingApprovalQuiescence(threadId: string, drain = true): void {
		const current = this._runQuiescenceOfThread.get(threadId)
		if (!current?.releaseAwaitingApproval) return
		this._runQuiescenceOfThread.delete(threadId)
		current.releaseAwaitingApproval()
		this._releaseUndeliveredSteers(threadId, current)
		if (drain) void this._drainPendingChatInputs(threadId)
	}
	/**
	 * Unit tests that bind an individual public approval method to a minimal
	 * receiver predate the Unit 5 quiescence registry. Do not make such a
	 * receiver silently emulate a production queue; simply preserve its former
	 * approval behavior when the registry is absent.
	 */
	private _releaseAwaitingApprovalQuiescenceIfTracked(threadId: string, drain = true): void {
		if (!(this as unknown as { _runQuiescenceOfThread?: Map<string, ParentRunQuiescence> })._runQuiescenceOfThread) return
		const release = (this as unknown as { _releaseAwaitingApprovalQuiescence?: (threadId: string, drain?: boolean) => void })._releaseAwaitingApprovalQuiescence ?? ChatThreadService.prototype._releaseAwaitingApprovalQuiescence
		release.call(this, threadId, drain)
	}
	// A few focused service fixtures bind individual production methods onto a
	// deliberately minimal receiver. Keep their historical notification wrapper
	// path while every real ChatThreadService instance registers quiescence before
	// it can accept queued input.
	private _startTrackedParentRun(threadId: string, parentRun: ParentRunOwnership, start: () => Promise<void>): void {
		if ((this as unknown as { _runQuiescenceOfThread?: Map<string, unknown> })._runQuiescenceOfThread) {
			// `_runChatAgent` synchronously publishes its initial idle state before its
			// first await. Install the parent lease first so an event listener that
			// chooses Steer during that publication targets this run rather than
			// treating it as an ordinary Queue item and aborting it.
			let startRun!: () => void
			const run = new Promise<void>((resolve, reject) => {
				startRun = () => {
					try {
						void start().then(resolve, reject)
					} catch (error) {
						reject(error)
					}
				}
			})
			this._trackParentRun(threadId, parentRun, run)
			startRun()
			return
		}
		// Preserve the historical behavior of deliberately minimal prototype
		// fixtures which do not own the Unit 5 registry.
		try {
			void this._wrapRunAgentToNotify(start(), threadId, parentRun)
		} catch (error) {
			void this._wrapRunAgentToNotify(Promise.reject(error), threadId, parentRun)
		}
	}
	private _canDeliverPendingChatInput(record: PendingChatInputRecord): boolean {
		return !this._deletingPendingInputThreads.has(record.threadId)
			&& !!this.state.allThreads[record.threadId]
			&& this._isPendingInputOwnerCurrent(record.ownerProjectRoot, record.trustedAtSubmit)
	}
	private _isAwaitingUser(threadId: string): boolean {
		return this.streamState[threadId]?.isRunning === 'awaiting_user'
	}
	private _releaseUndeliveredSteers(threadId: string, parentRun: Pick<ParentRunOwnership, 'runId' | 'generation'>): void {
		const items = this._pendingChatInputsOfThread.get(threadId) ?? []
		let changed = false
		const next = items.map(item => {
			if (item.runId !== parentRun.runId || item.generation !== parentRun.generation || (item.phase !== 'steering' && item.phase !== 'claiming')) return item
			changed = true
			return this._freezePendingInput({ ...item, mode: 'queue', phase: this._canDeliverPendingChatInput(item) ? 'queued' : 'dormant', runId: undefined, claimId: undefined })
		})
		if (changed) this._setPendingChatInputs(threadId, next)
	}
	private _steerCanBePromotedInRun(record: PendingChatInputRecord): boolean {
		// Normal admission resolves file/skill/agent selections and captures a fresh
		// authority snapshot. A direct in-run append is intentionally restricted to
		// plain text so it cannot bypass any of those gates.
		return record.selections.length === 0 && !record.text.includes('$')
	}
	private _promoteSteerAtSafeBoundary(threadId: string, parentRun: ParentRunOwnership): boolean {
		const initialItems = this._pendingChatInputsOfThread.get(threadId) ?? []
		// Normalize every ineligible steer now. Leaving a later attachment-bearing
		// record in `steering` would strand it if this is the parent's last boundary.
		let normalized = false
		const items = initialItems.map(item => {
			if (item.phase !== 'steering' || item.runId !== parentRun.runId || item.generation !== parentRun.generation) return item
			if (!this._canDeliverPendingChatInput(item)) { normalized = true; return this._freezePendingInput({ ...item, phase: 'dormant', claimId: undefined }) }
			if (!this._steerCanBePromotedInRun(item)) { normalized = true; return this._freezePendingInput({ ...item, mode: 'queue', phase: 'queued', runId: undefined, claimId: undefined }) }
			return item
		})
		if (normalized) this._setPendingChatInputs(threadId, items)
		// `_setPendingChatInputs` emits synchronously. Select only from the latest
		// map after a listener had a chance to reorder, delete, or insert input.
		const currentItems = this._pendingChatInputsOfThread.get(threadId) ?? []
		const record = [...currentItems].sort(comparePendingChatInputs).find(item => item.phase === 'steering' && item.runId === parentRun.runId && item.generation === parentRun.generation)
		if (!record) return false
		const claimed = this._claimPendingChatInput(threadId, record.id, 'steering')
		if (!claimed) return false
		if (!parentRun.isActive() || !this._canDeliverPendingChatInput(claimed) || this._findPendingChatInput(threadId, claimed.id)?.claimId !== claimed.claimId) {
			this._finishPendingChatInputClaim(threadId, claimed, this._canDeliverPendingChatInput(claimed) ? 'queued' : 'dormant')
			return false
		}
		this._addMessageToThread(threadId, { role: 'user', content: claimed.text, displayContent: claimed.text, selections: [], state: defaultMessageState })
		this._finishPendingChatInputClaim(threadId, claimed, 'remove')
		return true
	}
	private _stopAndSendPendingInput(threadId: string, expectedInput: PendingChatInputRecord, active: ParentRunQuiescence | undefined): void {
		const input = this._findPendingChatInput(threadId, expectedInput.id)
		if (input !== expectedInput || input.mode !== 'stop_and_send' || input.phase !== 'queued' || !this._canDeliverPendingChatInput(input)) return
		if (!active) { void this._drainPendingChatInputs(threadId); return }
		const key = `${threadId}\u0000${active.runId}`
		if (this._stopAndSendFlights.has(key)) return
		let completeFlight!: () => void
		// Publish ownership before invoking abortRunning: abort emits synchronously and
		// a reentrant listener must observe this sentinel rather than start a second
		// cancellation for the same parent lease.
		const flight = new Promise<void>(resolve => completeFlight = resolve)
		this._stopAndSendFlights.set(key, flight)
		void (async () => {
			try {
				// A delayed Stop-and-Send belonging to A must never interrupt B.
				if (this._runQuiescenceOfThread.get(threadId)?.runId !== active.runId) return
				await this.abortRunning(threadId)
				await active.settled
				const record = this._findPendingChatInput(threadId, expectedInput.id)
				if (record !== expectedInput || record.mode !== 'stop_and_send' || !this.state.allThreads[threadId] || !this._canDeliverPendingChatInput(record)) return
				void this._drainPendingChatInputs(threadId)
			} catch {
				// Stop is best-effort at this boundary; the retained record stays visible.
			} finally {
				completeFlight()
				if (this._stopAndSendFlights.get(key) === flight) this._stopAndSendFlights.delete(key)
			}
		})()
	}
	private async _drainPendingChatInputs(threadId: string): Promise<void> {
		const startingParentRuns = this._startingParentRunOfThread ?? new Map<string, StartingParentRun>()
		if (this._deletingPendingInputThreads.has(threadId) || this._drainingPendingChatInputs.has(threadId) || this._runQuiescenceOfThread.has(threadId) || startingParentRuns.has(threadId) || this._pendingChatSubmissionOfThread.has(threadId) || this._isAwaitingUser(threadId)) return
		this._drainingPendingChatInputs.add(threadId)
		try {
			while (!this._deletingPendingInputThreads.has(threadId) && this.state.allThreads[threadId] && !this._runQuiescenceOfThread.has(threadId) && !startingParentRuns.has(threadId) && !this._pendingChatSubmissionOfThread.has(threadId) && !this._isAwaitingUser(threadId)) {
				const items = this._pendingChatInputsOfThread.get(threadId) ?? []
				const record = [...items].sort(comparePendingChatInputs).find(item => item.phase === 'queued')
				if (!record) return
				if (!this._canDeliverPendingChatInput(record)) { this._setPendingChatInputs(threadId, items.map(item => item.id === record.id ? this._freezePendingInput({ ...item, phase: 'dormant', claimId: undefined }) : item)); continue }
				const claimed = this._claimPendingChatInput(threadId, record.id, 'queued')
				if (!claimed) continue
				if (!this.state.allThreads[threadId] || !this._canDeliverPendingChatInput(claimed) || this._findPendingChatInput(threadId, claimed.id)?.claimId !== claimed.claimId) return
				let accepted = false
				try { accepted = await this._addUserMessageAndStreamResponse({ userMessage: claimed.text, _chatSelections: this._clonePendingSelections(claimed.selections), threadId }) }
				catch { accepted = false }
				if (!this.state.allThreads[threadId]) return
				// A successful admission already owns the user-history append. Remove its
				// exact claim even if a later owner/trust event arrives, otherwise that
				// same input could be delivered twice on a future drain.
				// Failed admission has not written history or called a provider. It becomes
				// an explicit dormant draft rather than a stranded queued row with no
				// future drain trigger; the user can resume, edit, or delete it.
				this._finishPendingChatInputClaim(threadId, claimed, accepted ? 'remove' : 'dormant')
				if (!accepted) return
				return
			}
		} finally { this._drainingPendingChatInputs.delete(threadId) }
	}

	dismissStreamError(threadId: string): void {
		this._setStreamState(threadId, undefined)
	}


	private async _addUserMessageAndStreamResponse({ userMessage, _chatSelections, threadId, pending }: { userMessage: string, _chatSelections?: StagingSelectionItem[], threadId: string, pending?: PendingChatSubmissionRecord }) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return false // should never happen
		const capturedSelections = [...(_chatSelections ?? thread.state.stagingSelections)]
		const agentSelections = capturedSelections.filter(isAgentDelegationSelection)
		if (agentSelections.length > 1) throw new Error('custom_agent_multiple_selections')
		const agentSelection = agentSelections[0]
		const agentDelegationIntent = !!agentSelection
		// Capture every model-dependent input before any async catalog/instruction resolution.
		const capturedModel = this._currentModelSelectionProps();
		const capturedOverride = capturedModel.modelSelection ? this._settingsService.state.overridesOfModel[capturedModel.modelSelection.providerName]?.[capturedModel.modelSelection.modelName] ?? {} : {};
		const nativeToolFormat = capturedModel.modelSelection ? getModelCapabilities(capturedModel.modelSelection.providerName, capturedModel.modelSelection.modelName, { [capturedModel.modelSelection.providerName]: { [capturedModel.modelSelection.modelName]: capturedOverride } } as never).specialToolFormat : undefined;
		const isAgentChat = this._settingsService.state.globalSettings.chatMode === 'agent';
		let agentDelegationAllowed = isAgentChat && isNativeAgentToolFormat(nativeToolFormat);
		if (isAgentChat && !capturedModel.modelSelection) {
			this._setStreamState(threadId, { isRunning: undefined, error: { message: 'Agent chat requires a selected Chat model with native Agent tools. Select a supported model before sending.', fullError: null } });
			return false;
		}
		if (isAgentChat && !agentDelegationAllowed) {
			this._setStreamState(threadId, { isRunning: undefined, error: { message: 'The selected Chat model does not support native Agent tools. Select a supported model before sending.', fullError: null } });
			return false;
		}
		const priorRun = pending?.priorRun ?? (this.streamState[threadId]?.isRunning ? this.abortRunning(threadId) : undefined)
		if (!pending && !priorRun) this._revokeAgentDelegation(threadId, true)
		const turnGeneration = pending?.generation ?? this._agentControlGeneration.get(threadId)
		if (turnGeneration === undefined) return false
		const isCurrentGeneration = () => this._agentControlGeneration.has(threadId) && this._agentControlGeneration.get(threadId) === turnGeneration
		const isCurrentTurn = () => isCurrentGeneration() && (!pending || this._pendingChatSubmissionOfThread.get(threadId) === pending)
		if (priorRun) await priorRun
		if (!isCurrentTurn()) return false
		const owner = this._workspaceContextService.getWorkspace().folders[0]?.uri
		const roleCatalog = agentDelegationIntent && agentDelegationAllowed ? await this._agentCustomAgentService.getCatalog(owner, owner) : undefined
		if (!isCurrentTurn()) return false
		if (agentSelection?.agentType && (!roleCatalog || roleCatalog.revision !== agentSelection.catalogRevision || roleCatalog.agents.find(role => role.identity === agentSelection.agentType)?.revision !== agentSelection.roleRevision)) {
			this._setStreamState(threadId, { isRunning: undefined, error: { message: `The selected Agent role '${agentSelection.agentType}' changed or is no longer available. Select it again before sending.`, fullError: null } }); return false
		}
		const capturedSettingsState = agentDelegationAllowed ? deepClone(this._settingsService.state) : undefined;
		const capturedSettingsOfProvider = agentDelegationAllowed ? this._llmMessageService.captureSettingsOfProvider() : undefined;
		const capturedOverrides = capturedModel.modelSelection ? { [capturedModel.modelSelection.providerName]: { [capturedModel.modelSelection.modelName]: deepClone(capturedOverride) } } as never : undefined;
		// This must happen before history changes: a task cannot cross a workspace owner boundary.
		const instructionSnapshot = await this._beginInstructionTurn(threadId)
		// A zero depth configuration disables the native child-control surface before
		// the model tool snapshot and parent authority are constructed.
		if (instructionSnapshot.config.agentDelegationLimits.maxDepth === 0 || instructionSnapshot.config.agentDelegationLimits.maxConcurrentThreadsPerSession > instructionSnapshot.config.agentDelegationLimits.maxAcceptedChildren) agentDelegationAllowed = false
		if (!isCurrentTurn()) return false
		// A failed new admission must not leave a previous turn's runtime authority resumable.
		this._purgeInstructionTurn(threadId, false, false)

		// add user's message to chat history
		const instructions = userMessage
		let currSelns: StagingSelectionItem[] = capturedSelections
		const catalog = await this._agentSkillsService.getCatalog(owner, owner, instructionSnapshot.config)
		if (!isCurrentTurn()) return false
		const direct = selectExplicitSkills(catalog, instructions)
		if (!direct.skills) {
			// Direct `$skill` selectors are user input, not an internal exception. Keep the
			// draft and chips untouched; do not read bodies, append history, or call a provider.
			const identity = direct.diagnostic?.identity ?? 'Skill'
			const message = direct.diagnostic?.code === 'skill_ambiguous'
				? `The Skill selector '$${identity}' is ambiguous. Use its qualified identity.`
				: `The Skill selector '$${identity}' was not found. Choose a listed Skill or correct the name.`
			this._setStreamState(threadId, { isRunning: undefined, error: { message, fullError: null } })
			return false
		}
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
		const delegationLimits = instructionSnapshot.config.agentDelegationLimits
		if (instructionSnapshot.config.agentDelegationLimitDiagnostics.length) this._notificationService.notify({ severity: Severity.Warning, message: delegationLimits.maxConcurrentThreadsPerSession > delegationLimits.maxAcceptedChildren ? `Agent child concurrency (${delegationLimits.maxConcurrentThreadsPerSession}) exceeds open capacity (${delegationLimits.maxAcceptedChildren}). Edit the config before delegating.` : `Some Agent child-limit settings were invalid. Check the Agent delegation configuration.` })
		const userMessageContent = agentDelegationIntent && agentDelegationAllowed
			? `${userMessageContentBase}\n\n[User delegation marker: up to ${delegationLimits.maxAcceptedChildren} generic read-only children are available for this turn, with ${delegationLimits.maxConcurrentThreadsPerSession} running concurrently and maximum depth ${delegationLimits.maxDepth}. Named custom agents admitted for this turn (optional exact agent_type): ${roleAd?.text || 'none'}${roleAd?.omitted ? `; ${roleAd.omitted} omitted` : ''}.${agentSelection?.agentType ? ` For this selected role, call spawn_agent with agent_type=${agentSelection.agentType} exactly.` : ''} Call spawn_agent for delegated tasks, then wait_agent for their results; partial child failures do not prevent your synthesis.]`
			: userMessageContentBase
		const currentOwner = this._workspaceContextService.getWorkspace().folders[0]?.uri.toString()
		if (currentOwner !== runtimeSnapshot.ownerProjectRoot || currentOwner !== runtimeSnapshot.runCwd || this._workspaceTrustManagementService.isWorkspaceTrusted() !== runtimeSnapshot.workspaceTrustedAtAdmission) { this._purgeInstructionTurn(threadId, false); throw new Error('skill_owner_or_trust_changed') }
		if (!isCurrentTurn()) return false
		const parentTools = captureParentModelToolSnapshot('agent', this._mcpService.getMCPTools(), agentDelegationAllowed)
		// Delegation may be admitted for the generic profile even when role-catalog
		// capture did not materialize a settings state. Preserve the historical
		// default-deny policy instead of dereferencing an optional capture.
		const autoApprove = capturedSettingsState?.globalSettings?.autoApprove ?? {}
		const agentDelegationAuthority = Object.freeze({ allowed: agentDelegationAllowed, generation: turnGeneration, limits: delegationLimits, runtimeSnapshot, parentTools, autoApprove: Object.freeze({ edits: !!autoApprove.edits, terminal: !!autoApprove.terminal, mcp: !!autoApprove['MCP tools'] }), ...(roleCatalog ? { roles: roleCatalog, settingsState: capturedSettingsState, settingsOfProvider: capturedSettingsOfProvider } : {}) })
		this._agentDelegationAuthorityOfThread.set(threadId, agentDelegationAuthority)
		this._rememberInstructionTurn(threadId, runtimeSnapshot)
		// The public pending-receipt event is synchronous. Hold FIFO admission while
		// it fires, then verify the original generation before history/provider work.
		// Real service instances always own this map; the optional form preserves old
		// narrow prototype fixtures that exercise admission in isolation.
		const startingParentRuns = this._startingParentRunOfThread ?? new Map<string, StartingParentRun>()
		const startingParent: StartingParentRun = Object.freeze({ id: generateUuid(), generation: turnGeneration })
		startingParentRuns.set(threadId, startingParent)
		try {
			if (pending && !this._settlePendingChatSubmission(pending, true)) return false
			if (!isCurrentGeneration() || !this.state.allThreads[threadId]) return false
			const userHistoryElt: ChatMessage = { role: 'user', content: userMessageContent, displayContent: instructions, selections: currSelns, state: defaultMessageState }
			this._addMessageToThread(threadId, userHistoryElt)

			const parentRun = beginParentRunOwnership(threadId, this._parentRunTokenOfThread, this._agentControlGeneration)
			const startTrackedParentRun = (this as unknown as { _startTrackedParentRun?: (threadId: string, parentRun: ParentRunOwnership, start: () => Promise<void>) => void })._startTrackedParentRun ?? ChatThreadService.prototype._startTrackedParentRun
			startTrackedParentRun.call(this, threadId, parentRun,
				() => this._runChatAgent({ threadId, instructionSnapshot: runtimeSnapshot, agentDelegationAuthority, parentRun, ...capturedModel, }),
			)

			// scroll to bottom
			this.state.allThreads[threadId]?.state.mountedInfo?.whenMounted.then(m => {
				m.scrollToBottom()
			})
			return true
		} finally {
			if (startingParentRuns.get(threadId) === startingParent) startingParentRuns.delete(threadId)
		}
	}


	beginUserMessageAndStreamResponse({ userMessage, threadId }: { userMessage: string, threadId: string }): ChatSubmissionReceipt {
		const reject = (): ChatSubmissionReceipt => Object.freeze({ id: '', accepted: false, settled: Promise.resolve(false) })
		const thread = this.state.allThreads[threadId]
		const startingParentRuns = this._startingParentRunOfThread ?? new Map<string, StartingParentRun>()
		if (!thread || this._pendingChatSubmissionOfThread.has(threadId) || startingParentRuns.has(threadId)) return reject()
		const capturedModel = this._currentModelSelectionProps()
		const isAgentChat = this._settingsService.state.globalSettings.chatMode === 'agent'
		if (isAgentChat && !capturedModel.modelSelection) {
			this._setStreamState(threadId, { isRunning: undefined, error: { message: 'Agent chat requires a selected Chat model with native Agent tools. Select a supported model before sending.', fullError: null } })
			return reject()
		}
		if (isAgentChat) {
			const override = this._settingsService.state.overridesOfModel[capturedModel.modelSelection!.providerName]?.[capturedModel.modelSelection!.modelName] ?? {}
			if (!isNativeAgentToolFormat(getModelCapabilities(capturedModel.modelSelection!.providerName, capturedModel.modelSelection!.modelName, { [capturedModel.modelSelection!.providerName]: { [capturedModel.modelSelection!.modelName]: override } } as never).specialToolFormat)) {
				this._setStreamState(threadId, { isRunning: undefined, error: { message: 'The selected Chat model does not support native Agent tools. Select a supported model before sending.', fullError: null } })
				return reject()
			}
		}
		const priorRun = this.streamState[threadId]?.isRunning ? this.abortRunning(threadId) : undefined
		if (!priorRun) this._revokeAgentDelegation(threadId, true)
		const generation = this._agentControlGeneration.get(threadId)
		if (generation === undefined) return reject()
		const pending: PendingChatSubmissionRecord = { id: generateUuid(), threadId, generation, displayContent: userMessage, selections: [...thread.state.stagingSelections], phase: 'preparing', draft: this.getTransientComposerDraft(threadId) || userMessage, composerCleared: false, ...(priorRun ? { priorRun } : {}) }
		this._setPendingChatSubmission(pending)
		const settled = this._addUserMessageAndStreamResponse({ userMessage, _chatSelections: [...pending.selections], threadId, pending }).then(
			accepted => accepted ? (this._pendingChatSubmissionOfThread.get(threadId) === pending ? this._settlePendingChatSubmission(pending, true) : true) : this._settlePendingChatSubmission(pending, false),
			error => {
				const current = this._pendingChatSubmissionOfThread.get(threadId) === pending && this.state.allThreads[threadId] !== undefined && this._agentControlGeneration.get(threadId) === pending.generation
				this._settlePendingChatSubmission(pending, false)
				if (current) this._setStreamState(threadId, { isRunning: undefined, error: { message: getErrorMessage(error), fullError: null } })
				throw error
			},
		)
		return Object.freeze({ id: pending.id, accepted: true, settled })
	}

	async addUserMessageAndStreamResponse({ userMessage, _chatSelections, threadId }: { userMessage: string, _chatSelections?: StagingSelectionItem[], threadId: string }) {
		if (_chatSelections) return this._addUserMessageAndStreamResponse({ userMessage, _chatSelections, threadId });
		return this.beginUserMessageAndStreamResponse({ userMessage, threadId }).settled
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
		if (this._deletingPendingInputThreads.has(threadId)) return
		this._deletingPendingInputThreads.add(threadId)
		try {
			this._setPendingChatInputs(threadId, [])
			this._drainingPendingChatInputs.delete(threadId)
			this._runQuiescenceOfThread.get(threadId)?.releaseAwaitingApproval?.()
			this._runQuiescenceOfThread.delete(threadId)
			this._startingParentRunOfThread?.delete(threadId)
			for (const key of this._stopAndSendFlights.keys()) if (key.startsWith(`${threadId}\u0000`)) this._stopAndSendFlights.delete(key)
			this._cancelPendingChatSubmission(threadId)
			this._revokeAgentDelegation(threadId, true)
			this._parentRunTokenOfThread.delete(threadId)
			this._cancellingToolReceiptsOfThread.delete(threadId)
			this._activeToolCardReceiptsOfThread?.delete(threadId)
			this._agentControlGeneration.delete(threadId)
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
		} finally { this._deletingPendingInputThreads.delete(threadId) }
	}
	override dispose(): void {
		for (const threadId of this._pendingChatSubmissionOfThread.keys()) this._cancelPendingChatSubmission(threadId)
		for (const threadId of Object.keys(this.state.allThreads)) this._revokeAgentDelegation(threadId, true)
		// Dispose is ordinary shutdown. Keep the durable inbox but revoke all live
		// claims so a restart presents every item as an explicitly resumable draft.
		for (const [threadId, records] of this._pendingChatInputsOfThread) this._pendingChatInputsOfThread.set(threadId, records.map(record => this._freezePendingInput({ ...record, phase: 'dormant', claimId: undefined, runId: undefined })))
		for (const quiescence of this._runQuiescenceOfThread.values()) quiescence.releaseAwaitingApproval?.()
		this._agentDelegationAuthorityOfThread.clear(); this._agentControlGeneration.clear(); this._parentRunTokenOfThread.clear(); this._cancellingToolReceiptsOfThread.clear(); this._activeToolCardReceiptsOfThread?.clear(); this._transientComposerDraftOfThread.clear(); this._drainingPendingChatInputs.clear(); this._runQuiescenceOfThread.clear(); this._startingParentRunOfThread?.clear(); this._stopAndSendFlights.clear(); this._deletingPendingInputThreads.clear(); this._storePendingChatInputs(); super.dispose();
	}

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
		const storedMessage = message.role === 'assistant'
			? { ...message, displayContent: sanitizeAssistantDisplayContent(message.displayContent) }
			: message
		const newThreads = {
			...allThreads,
			[oldThread.id]: {
				...oldThread,
				lastModified: new Date().toISOString(),
				messages: [
					...oldThread.messages,
					storedMessage
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
	private _setThreadState(threadId: string, state: Partial<ThreadType['state']>, doNotRefreshMountInfo?: boolean, preservePendingComposerOwnership = false): void {
		const thread = this.state.allThreads[threadId]
		if (!thread) return
		if (!preservePendingComposerOwnership && Object.prototype.hasOwnProperty.call(state, 'stagingSelections')) {
			const pending = this._pendingChatSubmissionOfThread.get(threadId)
			if (pending) pending.composerCleared = false
		}

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
