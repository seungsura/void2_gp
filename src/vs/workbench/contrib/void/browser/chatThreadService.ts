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
import { THREAD_STORAGE_KEY, THREAD_STORAGE_MIGRATION_COMPLETE_KEY, THREAD_STORAGE_RECORD_PREFIX } from '../common/storageKeys.js';
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
import { AgentSubagentRunView, AgentSubagentToolBroker, AgentSubagentToolBrokerRequest, AgentSubagentToolSnapshot, ChildActivitiesLedger, ChildActivityRecord, EMPTY_CHILD_ACTIVITIES, ChildToolApprovalKey, ChildToolApprovalView, childToolApprovalStructuralKey, createChildToolApprovalView, isActiveChildRun, isAgentSubagentControlName, isNativeAgentToolFormat, normalizeChildActivities, readOnlyChildToolNames, validateAgentSubagentControlParams } from '../common/agentSubagents.js';
import { IAgentSubagentService } from './agentSubagentService.js';
import { IAgentCustomAgentService } from './agentCustomAgentService.js';
import { CustomAgentCatalog, customAgentAdvertisement } from '../common/agentCustomAgents.js';
import { sanitizeAssistantDisplayContent } from '../common/assistantMessagePresentation.js';
import { divideToolWaveOutputBudget, parentSafeReadToolNames, planToolBatchWaves } from '../common/toolBatchPlanner.js';
import { comparePendingChatInputs, isPendingChatInputThreadStorageKey, PendingChatInput, PendingChatInputApprovalIdentity, PendingChatInputAuthority, PendingChatInputChildGroupIdentity, PendingChatInputClaim, PendingChatInputHistoryInspection, PendingChatInputMutationEvidence, PendingChatInputMutationResult, PendingInputMode, pendingChatInputChatStorageFingerprint, pendingChatInputFingerprint, pendingChatInputMutationReceiptKey, pendingChatInputThreadFingerprint, pendingChatInputThreadStorageKey, PENDING_CHAT_INPUT_THREAD_ANCHOR_FIELD } from '../common/pendingChatInputBroker.js';
import { IPendingChatInputBrokerService } from './pendingChatInputBrokerService.js';

export type { PendingChatInput, PendingInputMode } from '../common/pendingChatInputBroker.js';
export { PENDING_CHAT_INPUT_MAX_RECORDS, PENDING_CHAT_INPUT_MAX_SERIALIZED_BYTES } from '../common/pendingChatInputBroker.js';


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
const pendingApprovalIdentity = (message: ToolMessage<ToolName> & { type: 'tool_request' }): PendingChatInputApprovalIdentity => Object.freeze({
	toolId: message.id,
	name: message.name,
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
const resumeParentRunOwnership = (threadId: string, runId: string, generation: number, tokens: Map<string, symbol>, generations: Map<string, number>): ParentRunOwnership | undefined => {
	if (!runId || generations.get(threadId) !== generation) return undefined
	const token = Symbol('parent-run-resume')
	let active = true
	tokens.set(threadId, token)
	const isLatest = () => tokens.get(threadId) === token && generations.get(threadId) === generation
	return Object.freeze({ token, runId, generation, isLatest, isActive: () => active && isLatest(), deactivate: () => { active = false }, releaseLatest: () => { if (isLatest()) tokens.delete(threadId) } })
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
type PendingChatInputRecord = PendingChatInput;
type ParentRunQuiescence = {
	runId: string;
	generation: number;
	settled: Promise<void>;
	/** Present only while an approval-request row holds the logical turn open. */
	releaseAwaitingApproval?: () => void;
	/** Exact main-process close retry, shared by every local terminal observer. */
	closing?: Promise<boolean>;
};
type StartingParentRun = Readonly<{ id: string; generation: number }>;

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
	/** Separate durable child receipt ledger; never supplied to a provider. */
	childActivities: ChildActivitiesLedger;
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

type ThreadStorageEnvelope = {
	version: 1;
	revision: number;
	deleted?: true;
	thread?: ThreadType;
	pendingInputAnchorLeaseId?: string;
}

type ThreadStorageMutationPlan = Readonly<{
	writes: readonly Readonly<{ key: string; raw: string }>[];
	evidence: PendingChatInputMutationEvidence;
	fingerprintKeys?: readonly string[];
}>;

type UserMessageEditPlan = Readonly<{
	messageIdx: number;
	messages: readonly ChatMessage[];
	childActivities: ChildActivitiesLedger;
	target: ChatMessage & { role: 'user' };
}>;


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
		childActivities: EMPTY_CHILD_ACTIVITIES,
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
	submitPendingInput(input: { threadId: string; text: string; mode: PendingInputMode; selections?: readonly StagingSelectionItem[] }): Promise<PendingChatInput | undefined>;
	resumePendingInput(threadId: string, id: string, expectedFingerprint: string): Promise<boolean>;
	deletePendingInput(threadId: string, id: string, expectedFingerprint: string): Promise<boolean>;
	editPendingInput(threadId: string, id: string, expectedFingerprint: string, text: string, selections?: readonly StagingSelectionItem[]): Promise<boolean>;
	reorderPendingInput(threadId: string, id: string, expectedFingerprint: string, expectedThreadFingerprint: string, beforeId?: string): Promise<boolean>;
	onDidChangeChildToolApprovals: Event<void>;
	getChildToolApprovals(parentId: string): readonly ChildToolApprovalView[];
	approveChildToolApproval(key: ChildToolApprovalKey): boolean;
	rejectChildToolApproval(key: ChildToolApprovalKey): boolean;

	getCurrentThread(): ThreadType;
	openNewThread(): void;
	switchToThread(threadId: string): void;

	// thread selector
	deleteThread(threadId: string): Promise<boolean>;
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

	dangerousSetState: (newState: ThreadsState) => Promise<boolean>;
	resetState: () => Promise<boolean>;

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
	editUserMessageAndStreamResponse({ userMessage, messageIdx, threadId }: { userMessage: string, messageIdx: number, threadId: string }): Promise<boolean>;

	// call to add a message
	addUserMessageAndStreamResponse({ userMessage, threadId }: { userMessage: string, threadId: string }): Promise<boolean>;
	beginUserMessageAndStreamResponse({ userMessage, threadId }: { userMessage: string, threadId: string }): ChatSubmissionReceipt;

	// approve/reject
	approveLatestToolRequest(threadId: string): Promise<void>;
	rejectLatestToolRequest(threadId: string): Promise<void>;

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
	/** The blank view belongs to this service until a durable change materializes it. */
	private _localEmptyThreadId: string | undefined;
	private _didReadLegacyThreadStorage = false;

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
		@IPendingChatInputBrokerService private readonly _pendingChatInputBrokerService: IPendingChatInputBrokerService,
	) {
		super()
		this.state = { allThreads: {}, currentThreadId: null as unknown as string } // default state

		const readThreads = this._readAllThreads() || {}

		const allThreads = readThreads
		// Keep the empty initial state while importing legacy records so each
		// imported thread is written as its own record rather than as a map.
		if (this._didReadLegacyThreadStorage) this._migrateLegacyThreadStorage(allThreads)
		this.state = { allThreads, currentThreadId: null as unknown as string }
		this._restoreInstructionTurns(allThreads)
		this._register(this._pendingChatInputBrokerService.onDidChange(snapshot => this._applyPendingChatInputSnapshot(snapshot.records)))
		this._register(this._pendingChatInputBrokerService.onDidChangeChildGroup(event => { setTimeout(() => this._wakePendingChatInputs(event.threadId), 0) }))
		this._registerExternalThreadStorageListener()
		this._register(this._agentSubagentService.onDidChangeRun(event => {
			this._applyChildActivityEvent(event.parentId, event.generation, event.id)
			const source = this._childGroupSourceOfThread.get(event.parentId) ?? this._runQuiescenceOfThread.get(event.parentId)
			if (!source) { setTimeout(() => this._wakePendingChatInputs(event.parentId), 0); return }
			void this._syncActiveChildGroup(event.parentId, source).then(result => {
				if (!result.ok) return
				if (!result.identity.childIds.length && this._runQuiescenceOfThread.get(event.parentId)?.runId !== source.runId) this._childGroupSourceOfThread.delete(event.parentId)
				this._wakePendingChatInputs(event.parentId)
			})
			if ('status' in event && event.status !== 'queued' && event.status !== 'running') this._scheduleAgentMailboxContinuation(event.parentId, event.generation, source)
			else if ('mailboxTarget' in event && event.mailboxTarget === event.parentId) this._scheduleAgentMailboxContinuation(event.parentId, event.generation, source)
		}));

		// always be in a thread
		this.openNewThread()
		this._pendingInputBrokerReady = this._initializePendingInputBroker()

	}

	// Config is task/session scoped; a turn snapshot is deliberately refreshed only for a user turn.
	private readonly _agentInstructionSessionOfThread = new Map<string, AgentInstructionTaskSessionRecord>();
	private readonly _instructionTurnOfThread = new Map<string, AgentRuntimeTurnSnapshot>();
	private readonly _agentControlGeneration = new Map<string, number>();
	private readonly _agentMailboxContinuationScheduled = new Set<string>();
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
	/**
	 * Every ordinary B1 thread-record write is serialized through Electron main.
	 * The renderer map is still the immediate UI projection, but it is never the
	 * compare-and-swap authority.  A conflict advances the epoch, invalidating all
	 * already queued stale writes before the authoritative record is adopted.
	 */
	private readonly _threadStorageWriteTail = new Map<string, Promise<boolean>>();
	private readonly _threadStorageAuthoritativeRaw = new Map<string, string | undefined>();
	private readonly _threadStorageWriteEpoch = new Map<string, number>();
	private _pendingInputBrokerReady: Promise<boolean> = Promise.resolve(false);
	private _pendingDeliveredReconcileFlight: Promise<void> | undefined;
	private _pendingDeliveredReconcileRetry: ReturnType<typeof setTimeout> | undefined;
	private _pendingDeliveredReconcileRequested = 0;
	private _pendingNamespaceFinalizeRetry: ReturnType<typeof setTimeout> | undefined;
	private _pendingNamespaceFinalizeLeaseId: string | undefined;
	private readonly _drainingPendingChatInputs = new Set<string>();
	private readonly _runQuiescenceOfThread = new Map<string, ParentRunQuiescence>();
	private readonly _childGroupSourceOfThread = new Map<string, Readonly<{ runId: string; generation: number }>>();
	private readonly _childGroupSyncRevisionOfThread = new Map<string, number>();
	private readonly _childGroupSyncTailOfThread = new Map<string, Promise<Readonly<{ ok: boolean; identity: PendingChatInputChildGroupIdentity }>>>();
	/** Closes the receipt-success event seam before a real parent lease exists. */
	private readonly _startingParentRunOfThread = new Map<string, StartingParentRun>();
	private readonly _approvalActionFlights = new Set<string>();
	/** Latest external record held while this window still owns a live turn. */
	private readonly _deferredExternalThreadKey = new Map<string, string>();
	private readonly _deletingPendingInputThreads = new Set<string>();
	private readonly _externalPendingDeleteRetries = new Map<string, { handle: ReturnType<typeof setTimeout>; attempt: number }>();
	private readonly _pendingThreadMutationRetries = new Map<string, ReturnType<typeof setTimeout>>();
	private _pendingNamespaceMutation = false;
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
		this._applyDeferredExternalThreadRecordIfQuiescent(pending.threadId)
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
	private _pendingBroker(): IPendingChatInputBrokerService {
		if (this._pendingChatInputBrokerService) return this._pendingChatInputBrokerService
		// Explicit prototype-fixture seam. Production construction always injects the
		// eager broker service; there is deliberately no renderer-local fallback.
		const seam = (this as unknown as { _pendingInputBrokerTestSeam?: IPendingChatInputBrokerService })._pendingInputBrokerTestSeam
		if (seam) return seam
		throw new Error('pending_input_broker_unavailable')
	}
	private _applyPendingChatInputSnapshot(records: readonly PendingChatInput[]): void {
		const previousThreads = new Set(this._pendingChatInputsOfThread.keys())
		const next = new Map<string, PendingChatInputRecord[]>()
		for (const record of records) { const items = next.get(record.threadId) ?? []; items.push(record); next.set(record.threadId, items) }
		this._pendingChatInputsOfThread.clear()
		for (const [threadId, items] of next) this._pendingChatInputsOfThread.set(threadId, items.sort(comparePendingChatInputs))
		for (const threadId of new Set([...previousThreads, ...next.keys()])) {
			this._onDidChangePendingChatInputs.fire({ threadId })
			// Main broadcasts before the mutation promise resumes, so defer one task:
			// submit can install its volatile owner first. A close-only revision then
			// wakes the owning renderer's FIFO without a third user action.
			setTimeout(() => this._wakePendingChatInputs(threadId), 0)
		}
		this._scheduleDeliveredPendingReconcile()
	}
	private _deliveredPendingInputIds(): Readonly<Record<string, readonly string[]>> {
		return Object.freeze(Object.fromEntries(Object.entries(this.state.allThreads).map(([threadId, thread]) => [threadId, Object.freeze((thread?.messages ?? []).flatMap(message => message.role === 'user' && message.pendingInputId ? [message.pendingInputId] : []))])))
	}
	private async _initializePendingInputBroker(): Promise<boolean> {
		const broker = this._pendingBroker()
		const deliveredPendingInputIds = this._deliveredPendingInputIds()
		const result = await broker.initializeNamespace({ knownThreadIds: Object.keys(this.state.allThreads), deliveredPendingInputIds })
		if (!result.ok) { this._warnPendingMutation(result, 'initialize'); return false }
		if (result.value.warning) this._warnPendingInbox(result.value.warning)
		const reconciled = await broker.reconcileDeliveredPendingInputIds(deliveredPendingInputIds)
		if (!reconciled.ok) { this._warnPendingMutation(reconciled, 'reconcile'); return false }
		for (const [threadId, source] of this._childGroupSourceOfThread) if (!(await this._syncActiveChildGroup(threadId, source, true)).ok) return false
		for (const threadId of Object.keys(this.state.allThreads)) void this._drainPendingChatInputs(threadId)
		return true
	}
	private async _ensurePendingInputBrokerReady(warn = true): Promise<boolean> {
		await this._pendingInputBrokerReady
		const result = await this._pendingBroker().initializeNamespace({ knownThreadIds: Object.keys(this.state.allThreads), deliveredPendingInputIds: this._deliveredPendingInputIds() })
		if (!result.ok) return warn ? this._warnPendingMutation(result, 'initialize') : false
		return true
	}
	private _scheduleDeliveredPendingReconcile(attempt = 0): void {
		this._pendingDeliveredReconcileRequested++
		if (this._pendingDeliveredReconcileFlight) return
		if (this._pendingDeliveredReconcileRetry) { clearTimeout(this._pendingDeliveredReconcileRetry); this._pendingDeliveredReconcileRetry = undefined }
		let retry = false
		let completedRequest = 0
		const flight = (async () => {
			while (true) {
				const observedRequest = this._pendingDeliveredReconcileRequested
				completedRequest = observedRequest
				const delivered = this._deliveredPendingInputIds()
				const intersects = [...this._pendingChatInputsOfThread.entries()].some(([threadId, records]) => {
					const ids = new Set(delivered[threadId] ?? []); return records.some(record => ids.has(record.id))
				})
				if (intersects) {
					if (!await this._ensurePendingInputBrokerReady()) { retry = true; return }
					const result = await this._pendingBroker().reconcileDeliveredPendingInputIds(this._deliveredPendingInputIds())
					if (!result.ok) { retry = true; return }
				}
				if (observedRequest === this._pendingDeliveredReconcileRequested) return
			}
		})().catch(() => { retry = true })
		this._pendingDeliveredReconcileFlight = flight
		void flight.finally(() => {
			if (this._pendingDeliveredReconcileFlight === flight) this._pendingDeliveredReconcileFlight = undefined
			if (retry && !this._pendingDeliveredReconcileRetry) this._pendingDeliveredReconcileRetry = setTimeout(() => { this._pendingDeliveredReconcileRetry = undefined; this._scheduleDeliveredPendingReconcile(attempt + 1) }, Math.min(2_000, 100 * 2 ** Math.min(attempt, 5)))
			else if (!retry && completedRequest !== this._pendingDeliveredReconcileRequested) this._scheduleDeliveredPendingReconcile()
		})
	}
	private _scheduleNamespaceFinalizeRetry(leaseId: string, attempt = 0, onCommitted?: () => void): void {
		if (this._pendingNamespaceFinalizeLeaseId && this._pendingNamespaceFinalizeLeaseId !== leaseId) return
		this._pendingNamespaceFinalizeLeaseId = leaseId
		if (this._pendingNamespaceFinalizeRetry) return
		this._pendingNamespaceFinalizeRetry = setTimeout(() => {
			this._pendingNamespaceFinalizeRetry = undefined
			void this._classifyNamespaceMutation(leaseId).then(outcome => {
				if (outcome === 'ambiguous') { this._scheduleNamespaceFinalizeRetry(leaseId, attempt + 1, onCommitted); return }
				if (this._pendingNamespaceFinalizeLeaseId !== leaseId) return
				if (outcome === 'committed') onCommitted?.()
				this._pendingNamespaceFinalizeLeaseId = undefined
				this._pendingNamespaceMutation = false
				this._scheduleDeliveredPendingReconcile()
				for (const threadId of Object.keys(this.state.allThreads)) void this._drainPendingChatInputs(threadId)
			}, () => this._scheduleNamespaceFinalizeRetry(leaseId, attempt + 1, onCommitted))
		}, Math.min(2_000, 100 * 2 ** Math.min(attempt, 5)))
	}
	private _currentPendingInputOwner(): string | undefined { return this._workspaceContextService.getWorkspace().folders[0]?.uri.toString() }
	private _isPendingInputOwnerCurrent(ownerProjectRoot: string | undefined, trustedAtSubmit: boolean): boolean {
		return ownerProjectRoot === this._currentPendingInputOwner() && trustedAtSubmit === this._workspaceTrustManagementService.isWorkspaceTrusted()
	}
	private _pendingInputAuthority(threadId: string, generation = this._agentControlGeneration.get(threadId) ?? 0): PendingChatInputAuthority {
		return Object.freeze({ threadExists: !!this.state.allThreads[threadId], ownerProjectRoot: this._currentPendingInputOwner(), workspaceTrusted: this._workspaceTrustManagementService.isWorkspaceTrusted(), generation })
	}
	private _warnPendingInbox(message: string): void { this._notificationService.notify({ severity: Severity.Warning, message }) }
	private _warnPendingMutation(result: PendingChatInputMutationResult<unknown>, operation: 'initialize' | 'reconcile' | 'submit' | 'edit' | 'delete' | 'reorder' | 'resume' | 'clear'): false {
		if (result.ok) return false
		const message = result.reason === 'full'
			? operation === 'edit' ? 'Pending inbox is full. The existing draft was unchanged.' : 'Pending inbox is full. Your draft was kept in the composer.'
			: result.reason === 'owner_or_trust_changed' ? 'This pending input no longer matches the current task, workspace, or trust state. It was kept as a dormant draft.'
				: result.reason === 'append_in_progress' ? 'A pending input is being saved to chat history. Wait for it to settle and try again.'
					: result.reason === 'conflict' ? 'This pending input changed in another Void window. Review the latest row and try again.'
						: 'The pending inbox backend is unavailable. Your current draft and chat were left unchanged.'
		this._warnPendingInbox(message)
		return false
	}
	private _findPendingChatInput(threadId: string, id: string): PendingChatInputRecord | undefined {
		return this._pendingChatInputsOfThread.get(threadId)?.find(record => record.id === id)
	}
	private _activeChildRuns(threadId: string): readonly AgentSubagentRunView[] {
		return this._agentSubagentService.getRunViews(threadId).filter(isActiveChildRun)
	}
	private _coordinationChildRuns(threadId: string): readonly Readonly<{ id: string; generation: number; released: boolean }>[] {
		const service = this._agentSubagentService as IAgentSubagentService & { getCoordinationRunViews?: (parentId: string) => readonly Readonly<{ id: string; generation: number; released: boolean }>[] }
		if (service.getCoordinationRunViews) return service.getCoordinationRunViews(threadId).filter(view => !view.released)
		// Production always exposes the physical coordination view. The fallback keeps
		// focused prototype fixtures aligned without pretending terminal rows are live.
		return this._activeChildRuns(threadId).map(view => Object.freeze({ id: view.id, generation: view.generation, released: false }))
	}
	private _syncActiveChildGroup(threadId: string, source: Pick<ParentRunQuiescence, 'runId' | 'generation'>, brokerAlreadyReady = false): Promise<Readonly<{ ok: boolean; identity: PendingChatInputChildGroupIdentity }>> {
		const receiver = this as unknown as {
			_childGroupSyncRevisionOfThread?: Map<string, number>;
			_childGroupSyncTailOfThread?: Map<string, Promise<Readonly<{ ok: boolean; identity: PendingChatInputChildGroupIdentity }>>>;
		}
		const revisions = receiver._childGroupSyncRevisionOfThread ??= new Map<string, number>()
		const tails = receiver._childGroupSyncTailOfThread ??= new Map<string, Promise<Readonly<{ ok: boolean; identity: PendingChatInputChildGroupIdentity }>>>()
		const previous = tails.get(threadId) ?? Promise.resolve(Object.freeze({ ok: true, identity: Object.freeze({ sourceRevision: revisions.get(threadId) ?? 0, childIds: Object.freeze([] as string[]) }) }))
		const run = previous.catch(() => Object.freeze({ ok: false, identity: Object.freeze({ sourceRevision: revisions.get(threadId) ?? 0, childIds: Object.freeze([] as string[]) }) })).then(async () => {
			while (true) {
				const views = this._coordinationChildRuns(threadId)
				if (views.some(view => view.generation !== source.generation)) return Object.freeze({ ok: false, identity: Object.freeze({ sourceRevision: revisions.get(threadId) ?? 0, childIds: Object.freeze([] as string[]) }) })
				const childIds = Object.freeze(views.map(view => view.id).sort((a, b) => a.localeCompare(b)))
				if (new Set(childIds).size !== childIds.length) return Object.freeze({ ok: false, identity: Object.freeze({ sourceRevision: revisions.get(threadId) ?? 0, childIds: Object.freeze([] as string[]) }) })
				const sourceRevision = (revisions.get(threadId) ?? 0) + 1
				if (!Number.isSafeInteger(sourceRevision)) return Object.freeze({ ok: false, identity: Object.freeze({ sourceRevision: revisions.get(threadId) ?? 0, childIds: Object.freeze([] as string[]) }) })
				const identity: PendingChatInputChildGroupIdentity = Object.freeze({ sourceRevision, ...(childIds.length ? { generation: source.generation } : {}), childIds })
				if (!await this._awaitThreadStorageWrites(threadId) || (!brokerAlreadyReady && !await this._ensurePendingInputBrokerReady(false))) return Object.freeze({ ok: false, identity })
				const broker = this._pendingBroker() as IPendingChatInputBrokerService & { syncActiveChildGroup?: IPendingChatInputBrokerService['syncActiveChildGroup'] }
				if (typeof broker.syncActiveChildGroup !== 'function') { revisions.set(threadId, sourceRevision); return Object.freeze({ ok: true, identity }) }
				const result = await broker.syncActiveChildGroup(threadId, source.runId, source.generation, sourceRevision, identity.generation, identity.childIds)
				if (!result.ok) { this._warnPendingMutation(result, 'reconcile'); return Object.freeze({ ok: false, identity }) }
				revisions.set(threadId, sourceRevision)
				const current = this._coordinationChildRuns(threadId)
				if (current.every(view => view.generation === source.generation)
					&& current.length === childIds.length
					&& current.map(view => view.id).sort((a, b) => a.localeCompare(b)).every((id, index) => id === childIds[index])) return Object.freeze({ ok: true, identity })
				// A real child event advanced while this ACK was in flight. Publish the
				// newer complete set before any close/drain boundary is allowed to pass.
			}
		})
		tails.set(threadId, run)
		const clearTail = () => { if (tails.get(threadId) === run) tails.delete(threadId) }
		void run.then(clearTail, clearTail)
		return run
	}
	async submitPendingInput({ threadId, text, mode, selections }: { threadId: string; text: string; mode: PendingInputMode; selections?: readonly StagingSelectionItem[] }): Promise<PendingChatInput | undefined> {
		await this._ensurePendingInputBrokerReady()
		const thread = this.state.allThreads[threadId]
		if (this._pendingNamespaceMutation || !thread || this._deletingPendingInputThreads.has(threadId) || !text.trim()) return undefined
		if (!await this._awaitThreadStorageWrites(threadId)) { this._warnPendingInbox('This chat changed in another Void window. Review it before sending again.'); return undefined }
		const anchorLeaseId = await this._materializePendingInputThreadAnchor(threadId)
		if (anchorLeaseId === null) return undefined
		const active = this._runQuiescenceOfThread.get(threadId)
		const activeChildren = active ? [] : this._coordinationChildRuns(threadId)
		const childStopGeneration = activeChildren.length ? activeChildren[0].generation : undefined
		const childStopIds = childStopGeneration === undefined || activeChildren.some(view => view.generation !== childStopGeneration)
			? undefined
			: [...new Set(activeChildren.map(view => view.id))].sort((left, right) => left.localeCompare(right))
		const effectiveMode: PendingInputMode = mode === 'steer' && !active ? 'queue' : mode
		const phase = effectiveMode === 'steer' && active ? 'steering' as const : 'queued' as const
		// Stop-and-Send is the one admission that deliberately fences the captured
		// parent generation before delivering its replacement turn. Queue and Steer
		// retain the current generation; the replacement row must instead match the
		// single generation bump performed by `abortRunning` after the old turn has
		// terminalized. This keeps the exact same-window row deliverable without
		// weakening the independent cross-window owner/generation checks.
		const generation = effectiveMode === 'stop_and_send' && active ? active.generation + 1 : effectiveMode === 'stop_and_send' && childStopGeneration !== undefined && childStopIds?.length ? childStopGeneration + 1 : active?.generation ?? (this._agentControlGeneration.get(threadId) ?? 0)
		if (!Number.isSafeInteger(generation)) { if (anchorLeaseId) await this._pendingBroker().abandonThreadAnchor(threadId, anchorLeaseId).catch(() => undefined); this._warnPendingInbox('This chat reached its run generation limit. Start a new task before sending again.'); return undefined }
		const result = await this._pendingBroker().submit({ threadId, text, selections: selections ?? thread.state.stagingSelections, mode: effectiveMode, phase, ownerProjectRoot: this._currentPendingInputOwner(), trustedAtSubmit: this._workspaceTrustManagementService.isWorkspaceTrusted(), generation, ...(phase === 'steering' ? { runId: active!.runId } : {}), ...(effectiveMode === 'stop_and_send' && active ? { targetRunId: active.runId, targetGeneration: active.generation } : {}), ...(effectiveMode === 'stop_and_send' && !active && childStopGeneration !== undefined && childStopIds?.length ? { targetChildGeneration: childStopGeneration, targetChildIds: childStopIds } : {}) })
		if (!result.ok) { if (anchorLeaseId) await this._pendingBroker().abandonThreadAnchor(threadId, anchorLeaseId).catch(() => undefined); return this._warnPendingMutation(result, 'submit') || undefined }
		const record = result.value
		if (phase === 'steering') {
			const current = this._runQuiescenceOfThread.get(threadId)
			if (!current || current.runId !== active!.runId || current.generation !== active!.generation) {
				const released = await this._pendingBroker().closeRunAndReleaseSteers(threadId, active!.runId, active!.generation, this._pendingInputAuthority(threadId, active!.generation))
				if (!released.ok) this._warnPendingMutation(released, 'reconcile')
				void this._drainPendingChatInputs(threadId)
				return record
			}
		}
		if (effectiveMode === 'stop_and_send') {
			this._wakePendingChatInputs(threadId, record)
		}
		else if (phase === 'queued') void this._drainPendingChatInputs(threadId)
		return record
	}
	async deletePendingInput(threadId: string, id: string, expectedFingerprint: string): Promise<boolean> {
		await this._ensurePendingInputBrokerReady()
		if (this._pendingNamespaceMutation) return false
		const record = this._findPendingChatInput(threadId, id); if (!record || pendingChatInputFingerprint(record) !== expectedFingerprint) return this._warnPendingMutation({ ok: false, reason: 'conflict' }, 'delete')
		const result = await this._pendingBroker().delete(threadId, id, expectedFingerprint); return result.ok || this._warnPendingMutation(result, 'delete')
	}
	async editPendingInput(threadId: string, id: string, expectedFingerprint: string, text: string, selections?: readonly StagingSelectionItem[]): Promise<boolean> {
		await this._ensurePendingInputBrokerReady()
		if (this._pendingNamespaceMutation) return false
		const record = this._findPendingChatInput(threadId, id); if (!record || pendingChatInputFingerprint(record) !== expectedFingerprint) return this._warnPendingMutation({ ok: false, reason: 'conflict' }, 'edit')
		if (!text.trim()) return false
		const result = await this._pendingBroker().edit(threadId, id, expectedFingerprint, text, selections); return result.ok || this._warnPendingMutation(result, 'edit')
	}
	async reorderPendingInput(threadId: string, id: string, expectedFingerprint: string, expectedThreadFingerprint: string, beforeId?: string): Promise<boolean> {
		await this._ensurePendingInputBrokerReady()
		if (this._pendingNamespaceMutation) return false
		const records = this.getPendingChatInputs(threadId); const record = records.find(candidate => candidate.id === id)
		if (!record || pendingChatInputFingerprint(record) !== expectedFingerprint || pendingChatInputThreadFingerprint(records) !== expectedThreadFingerprint) return this._warnPendingMutation({ ok: false, reason: 'conflict' }, 'reorder')
		const result = await this._pendingBroker().reorder(threadId, id, expectedFingerprint, expectedThreadFingerprint, beforeId); return result.ok || this._warnPendingMutation(result, 'reorder')
	}
	async resumePendingInput(threadId: string, id: string, expectedFingerprint: string): Promise<boolean> {
		await this._ensurePendingInputBrokerReady()
		if (this._pendingNamespaceMutation) return false
		const record = this._findPendingChatInput(threadId, id)
		if (!record || pendingChatInputFingerprint(record) !== expectedFingerprint) return this._warnPendingMutation({ ok: false, reason: 'conflict' }, 'resume')
		if (record.phase !== 'dormant' || this._deletingPendingInputThreads.has(threadId)) return false
		const currentGeneration = this._agentControlGeneration.get(threadId)
		if (currentGeneration !== undefined && currentGeneration !== record.generation) return this._warnPendingMutation({ ok: false, reason: 'owner_or_trust_changed' }, 'resume')
		const result = await this._pendingBroker().resume(threadId, id, expectedFingerprint, this._pendingInputAuthority(threadId, record.generation))
		if (!result.ok) return this._warnPendingMutation(result, 'resume')
		const latestGeneration = this._agentControlGeneration.get(threadId)
		if (latestGeneration !== undefined && latestGeneration !== record.generation) {
			const resumed = this._findPendingChatInput(threadId, id)
			if (resumed?.phase === 'queued') { const suspended = await this._pendingBroker().suspend(threadId, id, pendingChatInputFingerprint(resumed)); if (!suspended.ok) this._warnPendingMutation(suspended, 'reconcile') }
			return false
		}
		if (latestGeneration === undefined) this._agentControlGeneration.set(threadId, record.generation)
		void this._drainPendingChatInputs(threadId)
		return true
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
		const state = { ...thread.state }
		delete state.agentInstructionTurnSnapshot
		const allThreads = { ...this.state.allThreads, [threadId]: { ...thread, state } }
		// Persist security metadata removal before a later provider or tool action.
		this._storeAllThreads?.(allThreads)
		this.state = { ...this.state, allThreads }
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
		const allThreads = { ...this.state.allThreads, [threadId]: { ...thread, state: { ...thread.state, agentInstructionTurnSnapshot: snapshot } } }
		this._storeAllThreads(allThreads)
		this.state = { ...this.state, allThreads }
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



	private _adoptCommittedNamespaceState(newState: ThreadsState): void {
		for (const threadId of Object.keys(this.state.allThreads)) this._deletingPendingInputThreads.add(threadId)
		for (const threadId of this._pendingChatSubmissionOfThread.keys()) this._cancelPendingChatSubmission(threadId)
		for (const threadId of Object.keys(this.state.allThreads)) this._revokeAgentDelegation(threadId, true)
		this._agentControlGeneration.clear(); this._parentRunTokenOfThread.clear(); this._cancellingToolReceiptsOfThread.clear(); this._activeToolCardReceiptsOfThread?.clear(); this._agentInstructionSessionOfThread.clear(); this._transientComposerDraftOfThread.clear(); this._deferredExternalThreadKey.clear(); this._childGroupSourceOfThread.clear(); this._childGroupSyncRevisionOfThread.clear(); this._childGroupSyncTailOfThread.clear()
		for (const quiescence of this._runQuiescenceOfThread.values()) quiescence.releaseAwaitingApproval?.()
		this._drainingPendingChatInputs.clear(); this._runQuiescenceOfThread.clear(); this._startingParentRunOfThread?.clear(); this._approvalActionFlights.clear(); this._stopAndSendFlights.clear()
		this._restoreInstructionTurns(newState.allThreads); this.state = newState; this._deletingPendingInputThreads.clear(); this._onDidChangeCurrentThread.fire()
	}
	private _adoptCommittedResetState(): void {
		for (const threadId of Object.keys(this.state.allThreads)) this._deletingPendingInputThreads.add(threadId)
		for (const threadId of this._pendingChatSubmissionOfThread.keys()) this._cancelPendingChatSubmission(threadId)
		for (const threadId of Object.keys(this.state.allThreads)) this._revokeAgentDelegation(threadId, true)
		this._agentControlGeneration.clear(); this._parentRunTokenOfThread.clear(); this._cancellingToolReceiptsOfThread.clear(); this._activeToolCardReceiptsOfThread?.clear(); this._agentInstructionSessionOfThread.clear(); this._instructionTurnOfThread.clear(); this._transientComposerDraftOfThread.clear(); this._deferredExternalThreadKey.clear(); this._childGroupSourceOfThread.clear(); this._childGroupSyncRevisionOfThread.clear(); this._childGroupSyncTailOfThread.clear()
		for (const quiescence of this._runQuiescenceOfThread.values()) quiescence.releaseAwaitingApproval?.()
		this._drainingPendingChatInputs.clear(); this._runQuiescenceOfThread.clear(); this._startingParentRunOfThread?.clear(); this._approvalActionFlights.clear(); this._stopAndSendFlights.clear()
		this.state = { allThreads: {}, currentThreadId: null as unknown as string }; this._deletingPendingInputThreads.clear(); this.openNewThread(); this._onDidChangeCurrentThread.fire()
	}
	private async _classifyNamespaceMutation(leaseId: string): Promise<'committed' | 'aborted' | 'ambiguous'> {
		try { if ((await this._pendingBroker().finalizeNamespaceClear(leaseId)).ok) return 'committed' } catch { /* authoritative retry below */ }
		try { if ((await this._pendingBroker().abortNamespaceClear(leaseId)).ok) return 'aborted' } catch { /* persisted intent remains fenced */ }
		return 'ambiguous'
	}
	async dangerousSetState(newState: ThreadsState): Promise<boolean> {
		if (this._pendingNamespaceMutation) return false
		this._pendingNamespaceMutation = true
		let brokerLeaseId: string | undefined
		let storagePlan: ThreadStorageMutationPlan | undefined
		let storageCommitted = false
		let brokerFinalized = false
		let recoveryPending = false
		try {
			await this._ensurePendingInputBrokerReady()
			if (!await this._awaitAllThreadStorageWrites()) throw new Error('chat_import_pending_write_failed')
			const before = this.state.allThreads
			for (const thread of Object.values(newState.allThreads)) if (thread) thread.childActivities = normalizeChildActivities((thread as { childActivities?: unknown }).childActivities, true)
			storagePlan = this._buildThreadReplacementPlan(newState.allThreads)
			const cleared = await this._pendingBroker().clearNamespace(storagePlan.evidence)
			if (!cleared.ok) return this._warnPendingMutation(cleared, 'clear')
			brokerLeaseId = cleared.value.leaseId
			await this._commitThreadStorageMutation(storagePlan, brokerLeaseId)
			if (!this._isThreadReplacementDurable(before, newState.allThreads)) throw new Error('chat_import_storage_readback_failed')
			storageCommitted = true
			this._adoptCommittedNamespaceState(newState)
			const finalized = await this._pendingBroker().finalizeNamespaceClear(brokerLeaseId)
			if (!finalized.ok) { this._warnPendingMutation(finalized, 'reconcile'); this._scheduleNamespaceFinalizeRetry(brokerLeaseId); return false }
			brokerFinalized = true
			return true
		} catch {
			if (brokerLeaseId && !storageCommitted) {
				const outcome = await this._classifyNamespaceMutation(brokerLeaseId)
				if (outcome === 'committed') { storageCommitted = true; brokerFinalized = true; if (storagePlan) this._adoptThreadStorageMutationPlan(storagePlan); this._adoptCommittedNamespaceState(newState); return true }
				if (outcome === 'ambiguous') { recoveryPending = true; this._scheduleNamespaceFinalizeRetry(brokerLeaseId, 0, () => { if (storagePlan) this._adoptThreadStorageMutationPlan(storagePlan); this._adoptCommittedNamespaceState(newState) }) }
			}
			else if (brokerLeaseId) { recoveryPending = true; this._scheduleNamespaceFinalizeRetry(brokerLeaseId) }
			return this._warnPendingMutation({ ok: false, reason: 'backend_unavailable' }, 'clear')
		}
		finally {
			this._deletingPendingInputThreads.clear()
			if ((!storageCommitted && !recoveryPending) || brokerFinalized) {
				this._pendingNamespaceMutation = false
				this._scheduleDeliveredPendingReconcile()
				for (const threadId of Object.keys(this.state.allThreads)) void this._drainPendingChatInputs(threadId)
			}
		}
	}
	async resetState(): Promise<boolean> {
		if (this._pendingNamespaceMutation) return false
		this._pendingNamespaceMutation = true
		let brokerLeaseId: string | undefined
		let storagePlan: ThreadStorageMutationPlan | undefined
		let storageCommitted = false
		let brokerFinalized = false
		let recoveryPending = false
		try {
			await this._ensurePendingInputBrokerReady()
			if (!await this._awaitAllThreadStorageWrites()) throw new Error('chat_reset_pending_write_failed')
			storagePlan = this._buildThreadReplacementPlan({})
			const cleared = await this._pendingBroker().clearNamespace(storagePlan.evidence)
			if (!cleared.ok) return this._warnPendingMutation(cleared, 'clear')
			brokerLeaseId = cleared.value.leaseId
			// Commit the shared chat reset before removing any broker row or local draft.
			await this._commitThreadStorageMutation(storagePlan, brokerLeaseId)
			if (!this._areStoredThreadsTombstoned()) throw new Error('chat_reset_storage_readback_failed')
			storageCommitted = true
			this._adoptCommittedResetState()
			const finalized = await this._pendingBroker().finalizeNamespaceClear(brokerLeaseId)
			if (!finalized.ok) { this._warnPendingMutation(finalized, 'reconcile'); this._scheduleNamespaceFinalizeRetry(brokerLeaseId); return false }
			brokerFinalized = true
			return true
		} catch {
			if (brokerLeaseId && !storageCommitted) {
				const outcome = await this._classifyNamespaceMutation(brokerLeaseId)
				if (outcome === 'committed') { storageCommitted = true; brokerFinalized = true; if (storagePlan) this._adoptThreadStorageMutationPlan(storagePlan); this._adoptCommittedResetState(); return true }
				if (outcome === 'ambiguous') { recoveryPending = true; this._scheduleNamespaceFinalizeRetry(brokerLeaseId, 0, () => { if (storagePlan) this._adoptThreadStorageMutationPlan(storagePlan); this._adoptCommittedResetState() }) }
			}
			else if (brokerLeaseId) { recoveryPending = true; this._scheduleNamespaceFinalizeRetry(brokerLeaseId) }
			return this._warnPendingMutation({ ok: false, reason: 'backend_unavailable' }, 'clear')
		}
		finally {
			this._deletingPendingInputThreads.clear()
			if ((!storageCommitted && !recoveryPending) || brokerFinalized) {
				this._pendingNamespaceMutation = false
				this._scheduleDeliveredPendingReconcile()
				for (const threadId of Object.keys(this.state.allThreads)) void this._drainPendingChatInputs(threadId)
			}
		}
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
			legacyThread.childActivities = normalizeChildActivities((legacyThread as { childActivities?: unknown }).childActivities, true);
		}

		return threads;
	}

	private _readAllThreads(): ChatThreads | null {
		const records = new Map<string, ThreadStorageEnvelope>()
		for (const key of this._storageService.keys(StorageScope.APPLICATION, StorageTarget.USER)) {
			if (!key.startsWith(THREAD_STORAGE_RECORD_PREFIX)) continue
			const id = this._threadIdFromStorageKey(key)
			const envelope = id && this._readThreadEnvelope(key, id)
			if (!id || !envelope) continue
			records.set(id, envelope)
		}
		const legacy = this._storageService.get(THREAD_STORAGE_KEY, StorageScope.APPLICATION)
		const migrationComplete = this._storageService.get(THREAD_STORAGE_MIGRATION_COMPLETE_KEY, StorageScope.APPLICATION) === '1'
		if (migrationComplete || !legacy) return this._threadsFromStorageRecords(records)
		this._didReadLegacyThreadStorage = true
		const threads = this._convertThreadDataFromStorage(legacy)
		// Before the marker is durable, a crash may have written only a prefix of
		// the migration. Overlay those records so they win, while untouched legacy
		// ids remain visible and can be imported on this restart.
		for (const [id, envelope] of records) {
			if (envelope.deleted) delete threads[id]
			else if (envelope.thread) threads[id] = envelope.thread
		}
		return threads
	}
	private _threadsFromStorageRecords(records: ReadonlyMap<string, ThreadStorageEnvelope>): ChatThreads {
		const threads: ChatThreads = {}
		for (const [id, envelope] of records) if (!envelope.deleted && envelope.thread) threads[id] = envelope.thread
		return threads
	}
	private async _completeLegacyThreadStorageMigration(): Promise<void> {
		this._storageService.store(THREAD_STORAGE_MIGRATION_COMPLETE_KEY, '1', StorageScope.APPLICATION, StorageTarget.USER)
		await this._storageService.flush()
	}
	private _migrateLegacyThreadStorage(threads: ChatThreads): void {
		this._storeAllThreads(threads)
		// Never make the aggregate migration marker durable before every per-thread
		// CAS has settled. A failed/stale record leaves the legacy aggregate available
		// for the next startup instead of publishing a partial migration.
		void this._awaitAllThreadStorageWrites().then(ok => ok ? this._completeLegacyThreadStorageMigration() : undefined).catch(() => undefined)
	}
	private _registerExternalThreadStorageListener(): void {
		this._register(this._storageService.onDidChangeValue(StorageScope.APPLICATION, undefined, this._store)(event => {
			if (event.external && event.key.startsWith(THREAD_STORAGE_RECORD_PREFIX)) this._applyExternalThreadRecord(event.key)
		}))
	}

	private _storeAllThreads(threads: ChatThreads) {
		// Call sites build an immutable candidate map. Persist just the changed
		// record, so a stale map can never overwrite unrelated threads.
		const before = this.state?.allThreads ?? {}
		const ids = new Set([...Object.keys(before), ...Object.keys(threads)])
		for (const id of ids) {
			const previous = before[id]
			const next = threads[id]
			if (previous === next) continue
			if (!next) { if (previous) this._storeThreadTombstone(id); continue }
			if (this._isUnmaterializedEmptyThread(next)) continue
			this._storeThreadRecord(id, next)
		}
	}

	private _threadStorageKey(id: string): string { return pendingChatInputThreadStorageKey(id) }
	private _threadIdFromStorageKey(key: string): string | undefined {
		if (!key.startsWith(THREAD_STORAGE_RECORD_PREFIX)) return undefined
		try { const id = decodeURIComponent(key.slice(THREAD_STORAGE_RECORD_PREFIX.length)); return id && this._threadStorageKey(id) === key ? id : undefined } catch { return undefined }
	}
	private _isUnmaterializedEmptyThread(thread: ThreadType): boolean {
		return thread.id === this._localEmptyThreadId && thread.messages.length === 0 && thread.childActivities.records.length === 0 && thread.state.stagingSelections.length === 0 && Object.keys(thread.state.linksOfMessageIdx).length === 0 && !thread.state.agentInstructionTurnSnapshot
	}
	private _isPendingInputAnchorCandidate(thread: ThreadType): boolean {
		// `_localEmptyThreadId` is only the UI's preferred reusable blank. More than
		// one window-local blank can legitimately carry an unsent draft. Admission
		// is therefore structural and the authoritative B1 absence/tombstone check in
		// `_materializePendingInputThreadAnchor` decides whether this exact thread may
		// be materialized.
		return thread.messages.length === 0 && thread.childActivities.records.length === 0 && Object.keys(thread.state.linksOfMessageIdx).length === 0 && !thread.state.agentInstructionTurnSnapshot
	}
	private async _materializePendingInputThreadAnchor(threadId: string): Promise<string | undefined | null> {
		const thread = this.state.allThreads[threadId]
		if (!thread) return null
		const knownRaw = this._currentThreadStorageRaw(threadId)
		const known = this._parseThreadEnvelopeRaw(knownRaw, threadId)
		if (known && !known.deleted) return undefined
		if (!this._isPendingInputAnchorCandidate(thread)) return undefined
		const authorized = await this._pendingBroker().authorizeThreadAnchor(threadId)
		if (!authorized.ok) { this._warnPendingMutation(authorized, 'submit'); return null }
		if (authorized.value.existing) return undefined
		const leaseId = authorized.value.leaseId
		if (!leaseId) { this._warnPendingMutation({ ok: false, reason: 'backend_unavailable' }, 'submit'); return null }
		try {
			const key = this._threadStorageKey(threadId)
			const current = this._readThreadEnvelope(key, threadId)
			if (current?.deleted) throw new Error('pending_input_anchor_tombstoned')
			// The broker row owns the submitted File/Skill/@Agent selections.  The
			// temporary B1 anchor deliberately strips renderer-only composer state so a
			// reload cannot duplicate those selections into the next unsent draft.
			const anchorThread: ThreadType = { ...thread, state: { ...thread.state, stagingSelections: [], focusedMessageIdx: undefined, mountedInfo: undefined } }
			const envelope: ThreadStorageEnvelope = { version: 1, revision: (current?.revision ?? 0) + 1, thread: anchorThread, [PENDING_CHAT_INPUT_THREAD_ANCHOR_FIELD]: leaseId }
			const raw = JSON.stringify(envelope)
			this._storageService.store(key, raw, StorageScope.APPLICATION, StorageTarget.USER)
			await this._storageService.flush()
			const verified = await this._pendingBroker().verifyThreadAnchorAndRelease(threadId, leaseId)
			if (!verified.ok) throw new Error('pending_input_anchor_verification_failed')
			this._threadStorageAuthoritativeRaw.set(threadId, raw)
			return leaseId
		} catch {
			await this._pendingBroker().abandonThreadAnchor(threadId, leaseId).catch(() => undefined)
			this._warnPendingMutation({ ok: false, reason: 'backend_unavailable' }, 'submit')
			return null
		}
	}
	private _parseThreadEnvelopeRaw(raw: string | undefined, id: string): ThreadStorageEnvelope | undefined {
		if (!raw) return undefined
		try {
			const parsed = JSON.parse(raw) as ThreadStorageEnvelope
			if (!parsed || parsed.version !== 1 || !Number.isSafeInteger(parsed.revision) || parsed.revision < 1 || (parsed.deleted !== true && !parsed.thread)) return undefined
			if (parsed.deleted) return { version: 1, revision: parsed.revision, deleted: true }
			const thread = this._convertThreadDataFromStorage(JSON.stringify({ [id]: parsed.thread }))[id]
			return thread?.id === id ? { version: 1, revision: parsed.revision, thread, ...(typeof parsed.pendingInputAnchorLeaseId === 'string' ? { pendingInputAnchorLeaseId: parsed.pendingInputAnchorLeaseId } : {}) } : undefined
		} catch { return undefined }
	}
	private _readThreadEnvelope(key: string, id: string): ThreadStorageEnvelope | undefined {
		const raw = this._threadStorageAuthoritativeRaw.has(id) ? this._threadStorageAuthoritativeRaw.get(id) : this._storageService.get(key, StorageScope.APPLICATION)
		return this._parseThreadEnvelopeRaw(raw, id)
	}
	private _threadStorageRawEntries(includeLastCas = true): ReadonlyMap<string, string> {
		const entries = new Map<string, string>()
		for (const key of this._storageService.keys(StorageScope.APPLICATION, StorageTarget.USER)) {
			if (!isPendingChatInputThreadStorageKey(key)) continue
			const raw = this._storageService.get(key, StorageScope.APPLICATION)
			if (raw !== undefined) entries.set(key, raw)
		}
		if (includeLastCas) for (const [id, raw] of this._threadStorageAuthoritativeRaw) {
			const key = this._threadStorageKey(id)
			if (raw === undefined) entries.delete(key); else entries.set(key, raw)
		}
		return entries
	}
	private _storageFingerprint(entries: ReadonlyMap<string, string>, keys?: readonly string[]): string {
		const selected = keys ?? [...entries.keys()]
		return pendingChatInputChatStorageFingerprint(selected.map(key => ({ key, value: entries.get(key) })))
	}
	private _buildThreadReplacementPlan(after: ChatThreads): ThreadStorageMutationPlan {
		const beforeEntries = this._threadStorageRawEntries()
		const expected = new Map(beforeEntries)
		const writes: { key: string; raw: string }[] = []
		const ids = new Set<string>([...Object.keys(this.state.allThreads), ...Object.keys(after)])
		const legacyIds = new Set<string>()
		for (const key of beforeEntries.keys()) { const id = this._threadIdFromStorageKey(key); if (id) ids.add(id) }
		// A reset/import can race the one-time aggregate migration. Include every
		// still-live legacy id in the replacement transaction so an unseen legacy
		// thread cannot reappear after the new state has committed.
		if (this._storageService.get(THREAD_STORAGE_MIGRATION_COMPLETE_KEY, StorageScope.APPLICATION) !== '1') {
			const legacyRaw = this._storageService.get(THREAD_STORAGE_KEY, StorageScope.APPLICATION)
			if (legacyRaw) {
				try { for (const id of Object.keys(this._convertThreadDataFromStorage(legacyRaw))) { ids.add(id); legacyIds.add(id) } }
				catch { throw new Error('chat_replacement_legacy_state_invalid') }
			}
		}
		for (const id of ids) {
			const key = this._threadStorageKey(id)
			const current = this._readThreadEnvelope(key, id)
			const intended = after[id]
			const isPureLocalBlank = !beforeEntries.has(key) && !legacyIds.has(id)
				&& !!this.state.allThreads[id] && this._isPendingInputAnchorCandidate(this.state.allThreads[id]!)
			let raw: string | undefined
			if (intended && !(isPureLocalBlank && this._isPendingInputAnchorCandidate(intended))) {
				// A normal per-thread CAS treats a tombstone as terminal.  The one
				// exception is this application-global replacement transaction: its
				// persisted intent binds the exact tombstoned baseline and the exact live
				// replacement fingerprint while every ordinary history writer is fenced.
				// This is what makes Reset -> import the same exported ids reversible
				// without allowing a stale window to resurrect a deleted chat.
				raw = JSON.stringify({ version: 1, revision: (current?.revision ?? 0) + 1, thread: intended } satisfies ThreadStorageEnvelope)
			}
			else if (beforeEntries.has(key) || (!isPureLocalBlank && this.state.allThreads[id]) || legacyIds.has(id)) raw = JSON.stringify({ version: 1, revision: (current?.revision ?? 0) + 1, deleted: true } satisfies ThreadStorageEnvelope)
			if (raw !== undefined && raw !== beforeEntries.get(key)) { expected.set(key, raw); writes.push({ key, raw }) }
		}
		return Object.freeze({ writes: Object.freeze(writes), evidence: Object.freeze({ baselineFingerprint: this._storageFingerprint(beforeEntries), expectedFingerprint: this._storageFingerprint(expected) }) })
	}
	private _buildThreadDeletionPlan(id: string): ThreadStorageMutationPlan {
		const key = this._threadStorageKey(id)
		const beforeEntries = this._threadStorageRawEntries()
		const current = this._readThreadEnvelope(key, id)
		const raw = JSON.stringify({ version: 1, revision: (current?.revision ?? 0) + 1, deleted: true } satisfies ThreadStorageEnvelope)
		const expected = new Map(beforeEntries); expected.set(key, raw)
		return Object.freeze({ writes: Object.freeze([{ key, raw }]), fingerprintKeys: Object.freeze([key]), evidence: Object.freeze({ baselineFingerprint: this._storageFingerprint(beforeEntries, [key]), expectedFingerprint: this._storageFingerprint(expected, [key]) }) })
	}
	private async _commitThreadStorageMutation(plan: ThreadStorageMutationPlan, leaseId: string): Promise<void> {
		for (const write of plan.writes) this._storageService.store(write.key, write.raw, StorageScope.APPLICATION, StorageTarget.USER)
		this._storageService.store(pendingChatInputMutationReceiptKey(leaseId), leaseId, StorageScope.APPLICATION, StorageTarget.MACHINE)
		await this._storageService.flush()
		// These bytes were written through IStorageService immediately above. Read
		// that post-flush cache directly: overlaying the last per-thread CAS response
		// here would compare the transaction against its own stale predecessor and
		// make every reset/delete after a normal CAS fail spuriously.
		if (this._storageFingerprint(this._threadStorageRawEntries(false), plan.fingerprintKeys) !== plan.evidence.expectedFingerprint) throw new Error('chat_mutation_storage_readback_failed')
		this._adoptThreadStorageMutationPlan(plan)
	}
	private _adoptThreadStorageMutationPlan(plan: ThreadStorageMutationPlan): void {
		for (const write of plan.writes) { const id = this._threadIdFromStorageKey(write.key); if (id) this._threadStorageAuthoritativeRaw.set(id, write.raw) }
	}
	private _currentThreadStorageRaw(id: string): string | undefined {
		return this._threadStorageAuthoritativeRaw.has(id)
			? this._threadStorageAuthoritativeRaw.get(id)
			: this._storageService.get(this._threadStorageKey(id), StorageScope.APPLICATION)
	}
	private _advanceThreadStorageWriteEpoch(id: string): number {
		const next = (this._threadStorageWriteEpoch.get(id) ?? 0) + 1
		this._threadStorageWriteEpoch.set(id, next)
		return next
	}
	private _adoptAuthoritativeThreadRaw(id: string, raw: string | undefined): void {
		this._threadStorageAuthoritativeRaw.set(id, raw)
		if (raw === undefined) return
		const envelope = this._parseThreadEnvelopeRaw(raw, id)
		if (!envelope) return
		this._consumeThreadEnvelope(id, envelope, true)
	}
	/** A main-authoritative CAS rejection is a parent-run boundary.  Cancel the
	 * physical operations without publishing another stale history row, revoke the
	 * exact generation, and let the queued write adopt the winner afterwards. */
	private _fenceThreadStorageConflict(threadId: string): void {
		const interrupt = this.streamState[threadId]?.interrupt
		for (const receipt of this._activeToolCardReceipts(threadId)?.values() ?? []) {
			if (receipt.cancelling) continue
			receipt.cancelling = true
			try { receipt.cancel() } catch { /* the generation fence still rejects settlement */ }
		}
		this._revokeAgentDelegation(threadId)
		void Promise.resolve(interrupt).then(value => { if (typeof value === 'function') value() }, () => undefined)
		this._setStreamState(threadId, { isRunning: undefined, error: { message: 'This chat changed in another Void window. The stale run was stopped before it could continue.', fullError: null } })
	}
	private _queueThreadStorageWrite(id: string, nextThread: ThreadType | undefined): Promise<boolean> {
		const epoch = this._threadStorageWriteEpoch.get(id) ?? 0
		const previous = this._threadStorageWriteTail.get(id) ?? Promise.resolve(true)
		const task = previous.then(async previousSucceeded => {
			if (!previousSucceeded || (this._threadStorageWriteEpoch.get(id) ?? 0) !== epoch) return false
			if (!await this._ensurePendingInputBrokerReady()) return false
			const expectedRaw = this._currentThreadStorageRaw(id)
			const current = this._parseThreadEnvelopeRaw(expectedRaw, id)
			if (expectedRaw !== undefined && !current) return false
			if (current?.deleted && nextThread) {
				this._advanceThreadStorageWriteEpoch(id)
				this._adoptAuthoritativeThreadRaw(id, expectedRaw)
				this._warnPendingInbox('This chat was deleted in another Void window. Your stale local change was not saved.')
				return false
			}
			if ((current?.revision ?? 0) >= Number.MAX_SAFE_INTEGER) return false
			const nextRaw = JSON.stringify(nextThread
				? { version: 1, revision: (current?.revision ?? 0) + 1, thread: nextThread } satisfies ThreadStorageEnvelope
				: { version: 1, revision: (current?.revision ?? 0) + 1, deleted: true } satisfies ThreadStorageEnvelope)
			const committed = await this._pendingBroker().commitThreadRecord(id, expectedRaw, nextRaw)
			if (!committed.ok) {
				this._advanceThreadStorageWriteEpoch(id)
				this._fenceThreadStorageConflict(id)
				this._adoptAuthoritativeThreadRaw(id, committed.authoritativeRaw)
				this._warnPendingMutation(committed, 'reconcile')
				return false
			}
			this._threadStorageAuthoritativeRaw.set(id, committed.value)
			return true
		}, () => false).catch(() => false)
		this._threadStorageWriteTail.set(id, task)
		void task.finally(() => {
			if (this._threadStorageWriteTail.get(id) !== task) return
			this._threadStorageWriteTail.delete(id)
			this._applyDeferredExternalThreadRecordIfQuiescent(id)
		})
		return task
	}
	private async _awaitThreadStorageWrites(id: string): Promise<boolean> {
		// Production constructs the map eagerly. Prototype lifecycle fixtures bind
		// this method to a narrow receiver and have no persistence work to await.
		const tails = (this as unknown as { _threadStorageWriteTail?: Map<string, Promise<boolean>> })._threadStorageWriteTail
		return await (tails?.get(id) ?? Promise.resolve(true))
	}
	private async _awaitAllThreadStorageWrites(): Promise<boolean> {
		const tails = [...((this as unknown as { _threadStorageWriteTail?: Map<string, Promise<boolean>> })._threadStorageWriteTail?.values() ?? [])]
		return (await Promise.all(tails)).every(Boolean)
	}
	private _storeThreadRecord(id: string, thread: ThreadType): void { void this._queueThreadStorageWrite(id, thread) }
	private _storeThreadTombstone(id: string): void { void this._queueThreadStorageWrite(id, undefined) }
	private _isThreadTombstoneDurable(id: string): boolean { return this._readThreadEnvelope(this._threadStorageKey(id), id)?.deleted === true }
	private _threadFromBrokerHistoryInspection(threadId: string, inspection: PendingChatInputHistoryInspection): ThreadType | undefined {
		if (!inspection.envelopeRaw) return undefined
		try {
			const parsed = JSON.parse(inspection.envelopeRaw) as ThreadStorageEnvelope
			if (!parsed || parsed.version !== 1 || parsed.deleted || !parsed.thread) return undefined
			const thread = this._convertThreadDataFromStorage(JSON.stringify({ [threadId]: parsed.thread }))[threadId]
			if (thread?.id !== threadId) return undefined
			;(this as unknown as { _threadStorageAuthoritativeRaw?: Map<string, string | undefined> })._threadStorageAuthoritativeRaw?.set(threadId, inspection.envelopeRaw)
			return thread
		} catch { return undefined }
	}
	private _adoptDurablePendingInputThread(threadId: string, durable: ThreadType): boolean {
		const local = this.state.allThreads[threadId]
		if (!local || durable.id !== threadId) return false
		const thread = { ...durable, state: { ...durable.state, mountedInfo: local.state.mountedInfo, stagingSelections: local.state.stagingSelections, focusedMessageIdx: local.state.focusedMessageIdx } }
		this.state = { ...this.state, allThreads: { ...this.state.allThreads, [threadId]: thread } }
		this._onDidChangeCurrentThread.fire()
		return true
	}
	private _removeUnpersistedPendingInputMessage(threadId: string, pendingInputId: string): void {
		const thread = this.state.allThreads[threadId]; if (!thread) return
		const index = thread.messages.findIndex(message => message.role === 'user' && message.pendingInputId === pendingInputId)
		if (index < 0) return
		const messages = [...thread.messages.slice(0, index), ...thread.messages.slice(index + 1)]
		this.state = { ...this.state, allThreads: { ...this.state.allThreads, [threadId]: { ...thread, messages } } }
		this._onDidChangeCurrentThread.fire()
	}
	private _isThreadReplacementDurable(before: ChatThreads, after: ChatThreads): boolean {
		for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
			const intended = after[id]
			if (!intended) { if (before[id] && !this._isThreadTombstoneDurable(id)) return false; continue }
			if (this._isUnmaterializedEmptyThread(intended)) continue
			const envelope = this._readThreadEnvelope(this._threadStorageKey(id), id)
			if (!envelope?.thread || envelope.thread.id !== id || this._threadStorageFingerprint(envelope.thread) !== this._threadStorageFingerprint(intended)) return false
		}
		return true
	}
	private _threadStorageFingerprint(thread: ThreadType): string {
		const state = { ...thread.state }
		delete state.mountedInfo
		const projected = { ...thread, state }
		// Compare the bytes' logical storage projection, not incidental in-memory
		// shape. JSON legitimately omits optional `undefined` fields and converts
		// URI/Set-backed values before the next window revives them; treating those
		// representation changes as a conflict makes an otherwise exact import fail
		// its own post-flush readback.
		try {
			const normalized = this._convertThreadDataFromStorage(JSON.stringify({ [thread.id]: projected }))[thread.id]
			return stableToolValue(normalized ?? projected)
		} catch {
			return stableToolValue(projected)
		}
	}
	private _areStoredThreadsTombstoned(): boolean {
		for (const key of this._storageService.keys(StorageScope.APPLICATION, StorageTarget.USER)) {
			const id = this._threadIdFromStorageKey(key)
			if (id && !this._isThreadTombstoneDurable(id)) return false
		}
		return true
	}
	private _applyExternalThreadRecord(key: string): void {
		const id = this._threadIdFromStorageKey(key); if (!id) return
		if (this._isThreadLocallyActive(id) || this._threadStorageWriteTail.has(id)) { this._deferredExternalThreadKey.set(id, key); return }
		this._consumeExternalThreadRecord(key, id)
	}
	private _isThreadLocallyActive(id: string): boolean {
		return !!this.streamState[id]?.isRunning || this._pendingChatSubmissionOfThread?.has(id) || this._runQuiescenceOfThread?.has(id) || this._startingParentRunOfThread?.has(id) || this._parentRunTokenOfThread?.has(id)
	}
	private _applyDeferredExternalThreadRecordIfQuiescent(id: string): void {
		const key = this._deferredExternalThreadKey.get(id)
		if (!key || this._isThreadLocallyActive(id) || this._threadStorageWriteTail.has(id)) return
		this._deferredExternalThreadKey.delete(id)
		this._consumeExternalThreadRecord(key, id, true)
	}
	private _consumeExternalThreadRecord(key: string, id: string, wasActiveConflict = false): void {
		const raw = this._storageService.get(key, StorageScope.APPLICATION)
		// An external storage event is itself the authority update. Do not parse it
		// through `_readThreadEnvelope`, which intentionally prefers the last CAS
		// response and would otherwise replay that stale raw forever after the first
		// cross-window change.
		if (raw === undefined) {
			const previousRaw = this._threadStorageAuthoritativeRaw.get(id)
			const previous = this._parseThreadEnvelopeRaw(previousRaw, id)
			const local = this.state.allThreads[id]
			const isExactTemporaryAnchor = !!previous?.pendingInputAnchorLeaseId && !!previous.thread
				&& previous.thread.messages.length === 0 && previous.thread.childActivities.records.length === 0
				&& Object.keys(previous.thread.state.linksOfMessageIdx).length === 0 && !previous.thread.state.agentInstructionTurnSnapshot
			if (!isExactTemporaryAnchor) return
			// The authoritative anchor is gone even if this renderer has since typed a
			// local draft.  Retire the cached raw first so a later Send can authorize a
			// new anchor instead of being rejected forever against a phantom record.
			this._threadStorageAuthoritativeRaw.set(id, undefined)
			if (!local) return
			const isLocalBlank = local.messages.length === 0 && local.childActivities.records.length === 0
				&& Object.keys(local.state.linksOfMessageIdx).length === 0 && !local.state.agentInstructionTurnSnapshot
			const hasLocalComposer = !!(this._transientComposerDraftOfThread.get(id) ?? '').trim() || local.state.stagingSelections.length > 0
			if (!isLocalBlank || hasLocalComposer) {
				this._onDidChangeCurrentThread.fire()
				return
			}
			const allThreads = { ...this.state.allThreads }; delete allThreads[id]
			if (this.state.currentThreadId === id) {
				const blank = newThreadObject(); this._localEmptyThreadId = blank.id
				this.state = { allThreads: { ...allThreads, [blank.id]: blank }, currentThreadId: blank.id }
			} else this.state = { ...this.state, allThreads }
			this._onDidChangeCurrentThread.fire()
			return
		}
		const envelope = this._parseThreadEnvelopeRaw(raw, id); if (!envelope) return
		this._threadStorageAuthoritativeRaw.set(id, raw)
		this._consumeThreadEnvelope(id, envelope, wasActiveConflict)
	}
	private _consumeThreadEnvelope(id: string, envelope: ThreadStorageEnvelope, wasActiveConflict = false): void {
		const allThreads = { ...this.state.allThreads }
		if (envelope.deleted) {
			// A delivered tombstone is terminal. Replaying the same storage event must
			// not repeatedly clear state, fire stream listeners, or notify the user.
			if (!allThreads[id] && this.state.currentThreadId !== id) return
			delete allThreads[id]
			this._clearExternallyDeletedThreadMetadata(id)
			if (this.state.currentThreadId === id) {
				const existing = this._localEmptyThreadId && allThreads[this._localEmptyThreadId] && this._isUnmaterializedEmptyThread(allThreads[this._localEmptyThreadId]!) ? allThreads[this._localEmptyThreadId]! : undefined
				const blank = existing ?? newThreadObject(); this._localEmptyThreadId = blank.id
				this.state = { allThreads: existing ? allThreads : { ...allThreads, [blank.id]: blank }, currentThreadId: blank.id }
				this._scheduleExternalPendingDelete(id)
				this._notificationService.info('This chat was deleted in another window.')
				this._onDidChangeCurrentThread.fire(); return
			}
			if (wasActiveConflict) this._notificationService.info('This chat was deleted in another window.')
		}
		else if (envelope.thread) {
			const local = allThreads[id]
			// History is shared; mounted controls and composer ownership are not.
			allThreads[id] = local ? { ...envelope.thread, state: { ...envelope.thread.state, mountedInfo: local.state.mountedInfo, stagingSelections: local.state.stagingSelections, focusedMessageIdx: local.state.focusedMessageIdx } } : envelope.thread
		}
		else return
		// Do not use _setState: it rebuilds mount data and settles interrupted runs.
		this.state = { ...this.state, allThreads }
		if (envelope.deleted) this._scheduleExternalPendingDelete(id)
		this._scheduleDeliveredPendingReconcile()
		this._onDidChangeCurrentThread.fire()
	}
	private _clearExternallyDeletedThreadMetadata(threadId: string): void {
		this._setStreamState(threadId, undefined)
		this.clearTransientComposerDraft(threadId)
		this._pendingChatSubmissionOfThread.delete(threadId)
		this._drainingPendingChatInputs.delete(threadId); this._startingParentRunOfThread.delete(threadId); this._runQuiescenceOfThread.delete(threadId); this._parentRunTokenOfThread.delete(threadId); this._deferredExternalThreadKey.delete(threadId); this._childGroupSourceOfThread.delete(threadId); this._childGroupSyncRevisionOfThread.delete(threadId); this._childGroupSyncTailOfThread.delete(threadId)
		for (const key of this._stopAndSendFlights.keys()) if (key.startsWith(`${threadId}\u0000`)) this._stopAndSendFlights.delete(key)
		this._agentInstructionSessionOfThread.delete(threadId); this._instructionTurnOfThread.delete(threadId); this._revokeAgentDelegation(threadId, true); this._agentControlGeneration.delete(threadId)
		this._cancellingToolReceiptsOfThread.delete(threadId); this._activeToolCardReceiptsOfThread?.delete(threadId)
	}
	private _scheduleExternalPendingDelete(threadId: string, attempt = 0): void {
		if (this.state.allThreads[threadId] || this._externalPendingDeleteRetries.has(threadId)) return
		const handle = setTimeout(() => {
			this._externalPendingDeleteRetries.delete(threadId)
			void this._deleteExternallyRemovedPendingInputs(threadId, attempt)
		}, attempt === 0 ? 0 : Math.min(2_000, 100 * 2 ** Math.min(attempt, 5)))
		this._externalPendingDeleteRetries.set(threadId, { handle, attempt })
	}
	private async _deleteExternallyRemovedPendingInputs(threadId: string, attempt: number): Promise<void> {
		let leaseId: string | undefined
		let storagePlan: ThreadStorageMutationPlan | undefined
		try {
			await this._ensurePendingInputBrokerReady()
			if (this.state.allThreads[threadId]) return
			if (!await this._awaitThreadStorageWrites(threadId)) { this._scheduleExternalPendingDelete(threadId, attempt + 1); return }
			storagePlan = this._buildThreadDeletionPlan(threadId)
			const deleted = await this._pendingBroker().deleteThreadRecords(threadId, storagePlan.evidence)
			if (!deleted.ok) { this._scheduleExternalPendingDelete(threadId, attempt + 1); return }
			leaseId = deleted.value.leaseId
			await this._commitThreadStorageMutation(storagePlan, leaseId)
			const finalized = await this._pendingBroker().finalizeThreadDeletion(threadId, leaseId)
			if (!finalized.ok) this._scheduleExternalPendingDelete(threadId, attempt + 1)
		} catch {
			if (leaseId) {
				const outcome = await this._classifyThreadDeletion(threadId, leaseId)
				if (outcome === 'committed') { if (storagePlan) this._adoptThreadStorageMutationPlan(storagePlan); return }
				if (outcome === 'ambiguous') { this._scheduleThreadDeletionResolution(threadId, leaseId, () => { if (storagePlan) this._adoptThreadStorageMutationPlan(storagePlan) }); return }
			}
			this._scheduleExternalPendingDelete(threadId, attempt + 1)
		}
	}
	private async _clearPendingRowsAfterDurableTombstone(threadId: string): Promise<void> {
		if (!await this._awaitThreadStorageWrites(threadId)) return
		if (!this._isThreadTombstoneDurable(threadId)) return
		const storagePlan = this._buildThreadDeletionPlan(threadId)
		const prepared = await this._pendingBroker().deleteThreadRecords(threadId, storagePlan.evidence)
		if (!prepared.ok) return
		try {
			await this._commitThreadStorageMutation(storagePlan, prepared.value.leaseId)
			const finalized = await this._pendingBroker().finalizeThreadDeletion(threadId, prepared.value.leaseId)
			if (!finalized.ok) this._scheduleThreadDeletionResolution(threadId, prepared.value.leaseId, () => undefined)
		} catch {
			const outcome = await this._classifyThreadDeletion(threadId, prepared.value.leaseId)
			if (outcome === 'committed') this._adoptThreadStorageMutationPlan(storagePlan)
			if (outcome === 'ambiguous') this._scheduleThreadDeletionResolution(threadId, prepared.value.leaseId, () => this._adoptThreadStorageMutationPlan(storagePlan))
		}
	}
	private async _classifyThreadDeletion(threadId: string, leaseId: string): Promise<'committed' | 'aborted' | 'ambiguous'> {
		try { if ((await this._pendingBroker().finalizeThreadDeletion(threadId, leaseId)).ok) return 'committed' } catch { /* authoritative retry below */ }
		try { if ((await this._pendingBroker().abortThreadDeletion(threadId, leaseId)).ok) return 'aborted' } catch { /* persisted intent remains fenced */ }
		return 'ambiguous'
	}
	private _scheduleThreadDeletionResolution(threadId: string, leaseId: string, onCommitted: () => void, attempt = 0): void {
		if (this._pendingThreadMutationRetries.has(threadId)) return
		const handle = setTimeout(() => {
			this._pendingThreadMutationRetries.delete(threadId)
			void this._classifyThreadDeletion(threadId, leaseId).then(outcome => {
				if (outcome === 'ambiguous') { this._scheduleThreadDeletionResolution(threadId, leaseId, onCommitted, attempt + 1); return }
				if (outcome === 'committed') onCommitted()
				this._deletingPendingInputThreads.delete(threadId); this._scheduleDeliveredPendingReconcile()
				if (outcome === 'aborted' && this.state.allThreads[threadId]) this._wakePendingChatInputs(threadId)
			}, () => this._scheduleThreadDeletionResolution(threadId, leaseId, onCommitted, attempt + 1))
		}, Math.min(2_000, 100 * 2 ** Math.min(attempt, 5)))
		this._pendingThreadMutationRetries.set(threadId, handle)
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

	private _activityFromView(view: AgentSubagentRunView, anchor: ChildActivityRecord['anchor']): ChildActivityRecord {
		const status = view.status; const roleDescription = view.roleDescription?.trim(); const summary = status !== 'queued' && status !== 'running' ? view.summary?.trim().slice(0, 8000).trim() : undefined;
		return Object.freeze({ generation: view.generation, childId: view.id, ...(view.parentRunId ? { parentRunId: view.parentRunId } : {}), depth: view.depth, status, ...(view.roleName && roleDescription ? { role: Object.freeze({ name: view.roleName, description: roleDescription }) } : {}), capabilityProfile: view.capabilityProfile ?? 'read_only', ...(summary ? { summary } : {}), ...(status !== 'queued' && status !== 'running' && view.resultTruncated ? { resultTruncated: true as const } : {}), queuedMs: view.queuedMs, runningMs: view.runningMs, totalMs: view.totalMs, anchor });
	}
	/** The only history tree we may bind is the exact spawned root and its descendants. */
	private _selectChildActivitySubtree(views: readonly AgentSubagentRunView[], root: AgentSubagentRunView): readonly AgentSubagentRunView[] {
		const selected = new Set<string>([root.id]);
		const sameGeneration = views.filter(view => view.generation === root.generation);
		for (let changed = true; changed;) {
			changed = false;
			for (const view of sameGeneration) if (view.parentRunId && selected.has(view.parentRunId) && !selected.has(view.id)) { selected.add(view.id); changed = true; }
		}
		return sameGeneration.filter(view => selected.has(view.id));
	}
	private _applyChildActivityEvent(threadId: string, generation: number, childId: string): void {
		const thread = this.state.allThreads[threadId]; if (!thread) return;
		const views = this._agentSubagentService.getRunViews(threadId);
		const view = views.find(run => run.generation === generation && run.id === childId); if (!view) return;
		let existing = thread.childActivities.records.find(record => record.generation === generation && record.childId === childId);
		if (!existing) {
			// A nested run may be born after the root success receipt. It becomes durable
			// only when every live ancestor reaches an already anchored root.
			let cursor: AgentSubagentRunView | undefined = view; const chain: AgentSubagentRunView[] = []; const seen = new Set<string>();
			while (cursor && !seen.has(cursor.id)) { seen.add(cursor.id); chain.push(cursor); cursor = cursor.parentRunId ? views.find(candidate => candidate.generation === generation && candidate.id === cursor!.parentRunId) : undefined; }
			if (cursor) return; // corrupt cyclic live ancestry has no durable anchor
			const rootView = chain[chain.length - 1];
			const rootRecord = rootView && !rootView.parentRunId ? thread.childActivities.records.find(record => record.generation === generation && record.childId === rootView.id && !record.parentRunId) : undefined;
			if (!rootRecord) return; // unanchored, stale, deleted or incomplete ancestry stays inert
			const additions = chain.reverse().filter(candidate => !thread.childActivities.records.some(record => record.generation === generation && record.childId === candidate.id)).map(candidate => this._activityFromView(candidate, rootRecord.anchor));
			if (!additions.length) return;
			this._replaceChildActivities(threadId, normalizeChildActivities({ ...thread.childActivities, records: [...thread.childActivities.records, ...additions] }));
			return;
		}
		// Lifecycle receipts are monotonic: the first terminal receipt is durable and
		// a late queued/running or competing terminal notification cannot revise it.
		const terminal = (status: ChildActivityRecord['status']) => status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'interrupted';
		if (terminal(existing.status)) return;
		const next = this._activityFromView(view, existing.anchor);
		if (existing.status === 'running' && next.status === 'queued') return;
		const records = thread.childActivities.records.map(record => record === existing ? next : record);
		this._replaceChildActivities(threadId, normalizeChildActivities({ ...thread.childActivities, records }));
	}
	private _replaceChildActivities(threadId: string, childActivities: ChildActivitiesLedger): void {
		const thread = this.state.allThreads[threadId]; if (!thread || thread.childActivities === childActivities) return;
		const allThreads = { ...this.state.allThreads, [threadId]: { ...thread, childActivities, lastModified: new Date().toISOString() } };
		this._storeAllThreads(allThreads); this._setState({ allThreads });
	}
	private _appendSpawnSuccessAndBind(threadId: string, success: ChatMessage, result: { id: string }, anchor: ChildActivityRecord['anchor']): void {
		const thread = this.state.allThreads[threadId]; if (!thread) return;
		const views = this._agentSubagentService.getRunViews(threadId); const root = views.find(view => view.id === result.id && !view.parentRunId);
		const records = root ? [...thread.childActivities.records, ...this._selectChildActivitySubtree(views, root).filter(view => !thread.childActivities.records.some(record => record.generation === view.generation && record.childId === view.id)).map(view => this._activityFromView(view, anchor))] : thread.childActivities.records;
		const next = { ...thread, lastModified: new Date().toISOString(), messages: [...thread.messages, success], childActivities: normalizeChildActivities({ ...thread.childActivities, records }) };
		const allThreads = { ...this.state.allThreads, [threadId]: next }; this._storeAllThreads(allThreads); this._setState({ allThreads });
	}
	private _pruneChildActivitiesForMessages(thread: ThreadType, messages: readonly ChatMessage[]): ChildActivitiesLedger {
		const anchorOf = (message: ChatMessage) => message.role === 'tool' && message.type === 'success' && message.name === 'spawn_agent' && !!(message.result as any)?.id ? JSON.stringify([message.id, message.batchId, message.batchOrdinal, (message.result as any).id]) : undefined;
		const anchors = new Set(messages.map(anchorOf).filter((anchor): anchor is string => !!anchor));
		const removedSpawnSuccess = thread.messages.map(anchorOf).some(anchor => !!anchor && !anchors.has(anchor));
		const roots = new Set(thread.childActivities.records.filter(record => !record.parentRunId && !anchors.has(JSON.stringify([record.anchor.toolId, record.anchor.batchId, record.anchor.batchOrdinal, record.childId]))).map(record => record.childId));
		if (!roots.size && !removedSpawnSuccess) return thread.childActivities;
		const removed = new Set(roots); for (let index = 0; index < thread.childActivities.records.length; index++) { const record = thread.childActivities.records[index]; if (record.parentRunId && removed.has(record.parentRunId)) removed.add(record.childId); }
		// Omission/saturation has no per-root provenance. A successful-spawn history
		// rewrite therefore starts a fresh metadata epoch rather than attaching an old
		// global warning to an unrelated future child receipt.
		return normalizeChildActivities({ ...thread.childActivities, records: thread.childActivities.records.filter(record => !removed.has(record.childId)), omitted: 0, retentionSaturated: false });
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
			// Stop can close a later physical safe-read wave before that wave reaches its
			// own validation pass. Preserve the deterministic invalid-params outcome for
			// exactly those parent safe-read declarations; barriers remain unstarted skips.
			if (isABuiltinToolName(call.name) && parentSafeReadToolNames.includes(call.name as never)) {
				try { this._toolsService.validateParams[call.name](call.rawParams); }
				catch (error) {
					this._addMessageToThread(threadId, { role: 'tool', type: 'invalid_params', rawParams: call.rawParams, result: null, name: call.name, content: getErrorMessage(error), id: call.id, mcpServerName: undefined, batchId, batchOrdinal });
					continue;
				}
			}
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

	async approveLatestToolRequest(threadId: string): Promise<void> {
		const releaseAwaitingApproval = (this as unknown as { _releaseAwaitingApprovalQuiescenceIfTracked?: (threadId: string, drain?: boolean) => void })._releaseAwaitingApprovalQuiescenceIfTracked ?? ChatThreadService.prototype._releaseAwaitingApprovalQuiescenceIfTracked
		const flights = (this as unknown as { _approvalActionFlights?: Set<string> })._approvalActionFlights ?? new Set<string>()
		if (flights.has(threadId)) return
		const thread = this.state.allThreads[threadId]
		if (!thread) { releaseAwaitingApproval.call(this, threadId); return } // should never happen

		const lastMsg = thread.messages[thread.messages.length - 1]
		if (!(lastMsg.role === 'tool' && lastMsg.type === 'tool_request')) { releaseAwaitingApproval.call(this, threadId); return } // should never happen
		flights.add(threadId)
		const paused = this._runQuiescenceOfThread.get(threadId)
		const parentRun = paused
			? resumeParentRunOwnership(threadId, paused.runId, paused.generation, this._parentRunTokenOfThread, this._agentControlGeneration)
			: beginParentRunOwnership(threadId, this._parentRunTokenOfThread, this._agentControlGeneration)
		if (!parentRun) { flights.delete(threadId); return }
		const closeHeldApproval = async () => {
			if (!await this._awaitThreadStorageWrites(threadId)) { parentRun.deactivate(); parentRun.releaseLatest(); return }
			if (!await this._releaseUndeliveredSteers(threadId, parentRun)) { parentRun.deactivate(); parentRun.releaseLatest(); return }
			releaseAwaitingApproval.call(this, threadId, false)
			parentRun.deactivate(); parentRun.releaseLatest()
			this._applyDeferredExternalThreadRecordIfQuiescent(threadId); void this._drainPendingChatInputs(threadId)
		}
		try {
			const held = await this._pendingBroker().holdApproval(threadId, parentRun.runId, parentRun.generation, pendingApprovalIdentity(lastMsg))
			if (!held.ok) { this._warnPendingMutation(held, 'reconcile'); parentRun.deactivate(); parentRun.releaseLatest(); return }
			const callThisToolFirst: ToolMessage<ToolName> = lastMsg
			const snapshot = this._instructionTurnOfThread.get(threadId)
			const currentOwner = this._workspaceContextService.getWorkspace().folders[0]?.uri.toString()
			if (!snapshot || snapshot.ownerProjectRoot !== currentOwner || snapshot.runCwd !== currentOwner || snapshot.workspaceTrustedAtAdmission !== this._workspaceTrustManagementService.isWorkspaceTrusted()) {
				this._purgeInstructionTurn(threadId)
				const content = 'This tool request cannot resume because the current workspace or trust context no longer matches its instruction snapshot. Send a new message in a new task to continue.'
				this._updateLatestTool(threadId, { role: 'tool', type: 'rejected', params: lastMsg.params, name: lastMsg.name, content, result: null, id: lastMsg.id, rawParams: lastMsg.rawParams, mcpServerName: lastMsg.mcpServerName, ...(lastMsg.batchId === undefined || lastMsg.batchOrdinal === undefined ? {} : { batchId: lastMsg.batchId, batchOrdinal: lastMsg.batchOrdinal }) })
				if (lastMsg.batchId) this._terminalizeBatchTail(threadId, lastMsg.batchId, content)
				this._setStreamState(threadId, undefined); await closeHeldApproval(); return
			}
			const admittedModel = snapshot.model
			const currentProps = this._currentModelSelectionProps(); const selectedModel = currentProps.modelSelection
			const currentContext = selectedModel ? getModelCapabilities(selectedModel.providerName, selectedModel.modelName, this._settingsService.state.overridesOfModel).contextWindow : 0
			const currentReserve = selectedModel ? Math.max(Math.ceil(currentContext / 2), getReservedOutputTokenSpace(selectedModel.providerName, selectedModel.modelName, { isReasoningEnabled: getIsReasoningEnabledState('Chat', selectedModel.providerName, selectedModel.modelName, currentProps.modelSelectionOptions, this._settingsService.state.overridesOfModel), overridesOfModel: this._settingsService.state.overridesOfModel }) ?? 4096) : 0
			const currentOverride = selectedModel ? this._settingsService.state.overridesOfModel[selectedModel.providerName]?.[selectedModel.modelName] ?? {} : {};
			if (!admittedModel.hasModel || !selectedModel || selectedModel.providerName !== admittedModel.providerName || selectedModel.modelName !== admittedModel.modelName || runtimeModelFingerprint({ providerName: selectedModel.providerName, modelName: selectedModel.modelName, contextWindow: currentContext, reservedOutputTokens: currentReserve, modelSelectionOptions: currentProps.modelSelectionOptions ?? {}, selectedModelOverrides: currentOverride as never }) !== admittedModel.fingerprint) {
				this._purgeInstructionTurn(threadId)
				const content = 'This tool request cannot resume because its admitted model changed. Send a new message.'
				this._updateLatestTool(threadId, { role: 'tool', type: 'rejected', params: lastMsg.params, name: lastMsg.name, content, result: null, id: lastMsg.id, rawParams: lastMsg.rawParams, mcpServerName: lastMsg.mcpServerName, ...(lastMsg.batchId === undefined || lastMsg.batchOrdinal === undefined ? {} : { batchId: lastMsg.batchId, batchOrdinal: lastMsg.batchOrdinal }) })
				if (lastMsg.batchId) this._terminalizeBatchTail(threadId, lastMsg.batchId, content)
				this._setStreamState(threadId, undefined); await closeHeldApproval(); return
			}
			// The continuation reuses the paused main run identity. No foreign Queue or
			// direct history writer can enter in the approval gap.
			releaseAwaitingApproval.call(this, threadId, false)
			const startTrackedParentRun = (this as unknown as { _startTrackedParentRun?: (threadId: string, parentRun: ParentRunOwnership, start: () => Promise<void>) => void })._startTrackedParentRun ?? ChatThreadService.prototype._startTrackedParentRun
			startTrackedParentRun.call(this, threadId, parentRun, () => this._runChatAgent({ callThisToolFirst, threadId, instructionSnapshot: snapshot, modelSelection: { providerName: admittedModel.providerName as ModelSelection['providerName'], modelName: admittedModel.modelName }, modelSelectionOptions: admittedModel.modelSelectionOptions as ModelSelectionOptions, agentDelegationAuthority: this._agentDelegationAuthorityOfThread?.get(threadId), parentRun }))
		} finally { flights.delete(threadId) }
	}
	async rejectLatestToolRequest(threadId: string, revoke = true): Promise<void> {
		const releaseAwaitingApproval = (this as unknown as { _releaseAwaitingApprovalQuiescenceIfTracked?: (threadId: string, drain?: boolean) => void })._releaseAwaitingApprovalQuiescenceIfTracked ?? ChatThreadService.prototype._releaseAwaitingApprovalQuiescenceIfTracked
		const flights = (this as unknown as { _approvalActionFlights?: Set<string> })._approvalActionFlights ?? new Set<string>()
		if (flights.has(threadId)) return
		const thread = this.state.allThreads[threadId]
		if (!thread) { releaseAwaitingApproval.call(this, threadId); return } // should never happen

		const lastMsg = thread.messages[thread.messages.length - 1]

		let params: ToolCallParams<ToolName>
		if (lastMsg.role === 'tool' && lastMsg.type === 'tool_request') {
			params = lastMsg.params
		}
		else { releaseAwaitingApproval.call(this, threadId); return }
		flights.add(threadId)
		const paused = this._runQuiescenceOfThread.get(threadId)
		const parentRun = paused
			? resumeParentRunOwnership(threadId, paused.runId, paused.generation, this._parentRunTokenOfThread, this._agentControlGeneration)
			: beginParentRunOwnership(threadId, this._parentRunTokenOfThread, this._agentControlGeneration)
		if (!parentRun) { flights.delete(threadId); return }
		try {
			const held = await this._pendingBroker().holdApproval(threadId, parentRun.runId, parentRun.generation, pendingApprovalIdentity(lastMsg))
			if (!held.ok) { this._warnPendingMutation(held, 'reconcile'); parentRun.deactivate(); parentRun.releaseLatest(); return }
			if (revoke) this._revokeAgentDelegation(threadId)

			const { name, id, rawParams, mcpServerName } = lastMsg

			const errorMessage = this.toolErrMsgs.rejected
			this._updateLatestTool(threadId, { role: 'tool', type: 'rejected', params: params, name: name, content: errorMessage, result: null, id, rawParams, mcpServerName, ...(lastMsg.batchId === undefined || lastMsg.batchOrdinal === undefined ? {} : { batchId: lastMsg.batchId, batchOrdinal: lastMsg.batchOrdinal }) })
			if (lastMsg.batchId) this._terminalizeBatchTail(threadId, lastMsg.batchId, errorMessage)
			this._setStreamState(threadId, undefined)
			if (!await this._awaitThreadStorageWrites(threadId)) { this._setStreamState(threadId, { isRunning: 'awaiting_user' }); parentRun.deactivate(); parentRun.releaseLatest(); return }
			if (!await this._releaseUndeliveredSteers(threadId, parentRun)) { parentRun.deactivate(); parentRun.releaseLatest(); return }
			releaseAwaitingApproval.call(this, threadId, false)
			parentRun.deactivate(); parentRun.releaseLatest()
			// `revoke=false` is the paused-approval branch of abortRunning.  The
			// replacement Stop-and-Send row is stamped with the next generation, so
			// draining here (before abort advances the fence) would claim and demote it
			// as stale.  The caller completes revocation, then the exact Stop flight
			// drains once under the new generation.
			if (revoke) { this._applyDeferredExternalThreadRecordIfQuiescent(threadId); void this._drainPendingChatInputs(threadId) }
		} finally { flights.delete(threadId) }
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
		// A paused approval still owns the old generation in both renderer and main.
		// Terminalize and close that exact hold before revocation advances the local
		// generation; doing this in the opposite order makes resumeParentRunOwnership
		// reject the cancellation and leaves Stop-and-Send waiting forever.
		const approvalAtAbort = this.streamState[threadId]?.isRunning === 'awaiting_user' ? this._runQuiescenceOfThread.get(threadId) : undefined
		if (approvalAtAbort?.releaseAwaitingApproval) {
			await this.rejectLatestToolRequest(threadId, false)
			if (this._runQuiescenceOfThread.get(threadId) === approvalAtAbort) throw new Error('pending_approval_cancellation_not_settled')
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
			const resourceAuthorityFailure = () => {
				const cancelling = this._cancellingToolReceiptsOfThread.get(threadId);
				if (cancelling?.delete(receiptId) && cancelling.size === 0) this._cancellingToolReceiptsOfThread.delete(threadId);
				if (sameRememberedSnapshot()) this._purgeInstructionTurn(threadId);
				this._updateLatestTool(threadId, { role: 'tool', type: 'tool_error', params: applicationParams, result: 'skill_owner_or_trust_changed', name: toolName, content: 'skill_owner_or_trust_changed', id: toolId, rawParams: applicationParams, mcpServerName: undefined, ...batchRef });
				return { interrupted: true as const };
			};
			const interruptorPromise = Promise.resolve(interruptor);
			registerActiveToolCardReceipt.call(this, threadId, receiptId, toolId, batchRef, cardInterruptor, () => isCurrentParentRun() && sameGeneration(), true);
			// Establish global-Stop authority before publishing the live card. `_updateLatestTool`
			// notifies synchronously, so an observer can otherwise revoke this parent while
			// it still looks idle and leave the just-published row without a settlement path.
			this._setStreamState(threadId, { isRunning: 'tool', interrupt: interruptorPromise, toolInfo: { toolName, toolParams: applicationParams, id: toolId, content: 'interrupted...', rawParams: applicationParams, mcpServerName: undefined, receiptId } });
			if (!isCurrentParentRun()) { readCancellation.dispose(); retireActiveToolCardReceipt.call(this, threadId, receiptId); return { interrupted: true }; }
			this._updateLatestTool(threadId, { role: 'tool', type: 'running_now', name: toolName, params: applicationParams, content: '(value not received yet...)', result: null, id: toolId, rawParams: applicationParams, mcpServerName: undefined, startedAt: Date.now(), receiptId, cardStopAvailable: true, ...batchRef });
			if (!isCurrentParentRun()) { settleCancelled(); readCancellation.dispose(); retireActiveToolCardReceipt.call(this, threadId, receiptId); return { interrupted: true }; }
			try {
				// A Skill resource is a filesystem read, so it participates in the same
				// parent/child reader lane, but only for the actual service call. Conversion
				// and prospective admission deliberately run after this lease is released.
				const resourceLease = agentRunGeneration !== undefined && this._agentSubagentService?.acquireGroupIo
					? await this._agentSubagentService.acquireGroupIo(threadId, agentRunGeneration, 'read', readCancellation.token)
					: { release() { } };
				let read: Awaited<ReturnType<IAgentSkillsService['readSkillResource']>>;
				let transferredResourceLease = false;
				try {
					if (interrupted || !isCurrentParentRun() || !sameGeneration()) return cancellationOutcome();
					if (!sameResourceAuthority()) return resourceAuthorityFailure();
					const cancelled = Object.freeze({ cancelled: true as const });
					const cancellationRace = new Promise<typeof cancelled>(resolve => readCancellation.token.onCancellationRequested(() => resolve(cancelled)));
					const resourceRead = this._agentSkillsService.readSkillResource(selection, params.resourcePath, { maxResourceBytes, token: readCancellation.token });
					const settledRead = await Promise.race([resourceRead, cancellationRace]);
					if ('cancelled' in settledRead) {
						// The UI/card can settle promptly, but the underlying local file read can
						// ignore cancellation. Keep the group reader leased until that physical
						// promise drains, and consume a late rejection without publishing it.
						transferredResourceLease = true;
						const releaseTransferredLease = () => { try { resourceLease.release(); } catch { } };
						void resourceRead.then(releaseTransferredLease, releaseTransferredLease);
						return cancellationOutcome();
					}
					if ('cancelled' in settledRead || interrupted || !isCurrentParentRun() || !sameGeneration()) return cancellationOutcome();
					if (!sameResourceAuthority()) return resourceAuthorityFailure();
					read = settledRead;
				} finally { if (!transferredResourceLease) resourceLease.release(); }
				if (!sameResourceAuthority()) {
					return resourceAuthorityFailure();
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
					return resourceAuthorityFailure();
				}
				this._updateLatestTool(threadId, successMessage);
				return {};
			} catch (error) {
				if (interrupted || !isCurrentParentRun() || !sameGeneration()) return cancellationOutcome();
				if (!sameResourceAuthority()) {
					return resourceAuthorityFailure();
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
				? { message: control.message, ...(control.agentType === undefined ? {} : { agent_type: control.agentType }), ...(control.model === undefined ? {} : { model: control.model }), ...(control.reasoningEffort === undefined ? {} : { reasoning_effort: control.reasoningEffort }), fork_turns: typeof control.forkTurns === 'number' ? String(control.forkTurns) : control.forkTurns }
				: control.name === 'wait_agent'
					? { timeout_ms: control.timeoutMs, ...(control.targets === undefined ? {} : { targets: [...control.targets] }) }
					: control.name === 'list_agents' ? { ...(control.target ? { target: control.target } : {}) }
						: control.name === 'send_message' ? { target: control.target, message: control.message }
							: { target: control.target };
			const receiptId = generateUuid();
			this._setStreamState?.(threadId, { isRunning: 'idle', interrupt: Promise.resolve(() => { }), toolInfo: { toolName, toolParams: validatedParams as never, id: toolId, content: '(child control in progress...)', rawParams: opts.unvalidatedToolParams, mcpServerName: undefined, receiptId, transient: true, startedAt: Date.now(), cardStopUnavailableReason: 'This child control can only be stopped with the parent run, so this card cannot stop it independently.' } });
			const clearTransient = () => { const state = this.streamState[threadId]; if (state?.isRunning === 'idle' && state.toolInfo?.transient && state.toolInfo.receiptId === receiptId) this._setStreamState?.(threadId, { isRunning: 'idle', interrupt: 'not_needed' }); };
			try {
				let result: object;
				if (control.name === 'spawn_agent') result = await this._agentSubagentService.spawn(threadId, control.message, instructionSnapshot, control.agentType, agentDelegationAuthority.roles, agentDelegationAuthority.settingsState, agentDelegationAuthority.settingsOfProvider, controlGeneration, agentDelegationAuthority.parentTools, this._createAgentSubagentToolBroker?.(threadId, agentDelegationAuthority), control.model, control.reasoningEffort, control.forkTurns, this.state.allThreads[threadId]?.messages ?? []);
				else if (control.name === 'wait_agent') result = await this._agentSubagentService.wait(threadId, control.timeoutMs, control.targets, controlGeneration);
				else if (control.name === 'list_agents') result = this._agentSubagentService.list(threadId, control.target, controlGeneration);
				else if (control.name === 'send_message') result = this._agentSubagentService.sendMessage(threadId, control.target, control.message, controlGeneration);
				else result = this._agentSubagentService.interrupt(threadId, control.target, controlGeneration);
				if (!isControlCurrent()) return { interrupted: true };
				clearTransient();
				const content = JSON.stringify(result);
				if (!isControlCurrent()) return { interrupted: true };
				const success = { role: 'tool' as const, type: 'success' as const, rawParams: opts.unvalidatedToolParams, result: result as never, name: toolName, params: validatedParams as never, content, id: toolId, mcpServerName: undefined, ...batchRef };
				// The row is persisted before binding. This makes the success row the sole
				// durable root anchor without altering provider-visible message order.
				if (control.name === 'spawn_agent' && typeof (result as { id?: unknown }).id === 'string') this._appendSpawnSuccessAndBind(threadId, success, result as { id: string }, Object.freeze({ toolId, ...(batchRef ? { batchId: batchRef.batchId, batchOrdinal: batchRef.batchOrdinal } : {}) })); else this._addMessageToThread(threadId, success);
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
		const operationCancellation = new CancellationTokenSource()
		const interruptor = () => { if (interrupted) return; interrupted = true; try { operationCancellation.cancel() } catch { } try { interruptTool?.() } catch { } }
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
		if (!isCurrentParentRun()) { operationCancellation.dispose(); retireActiveToolCardReceipt.call(this, threadId, receiptId); return { interrupted: true } }
		this._updateLatestTool(threadId, runningTool)
		// A row observer can synchronously invoke global Stop. It has already marked
		// this exact receipt Cancelling; settle before returning because no underlying
		// operation has been started yet.
		if (!isCurrentParentRun()) { settleCancelled(); operationCancellation.dispose(); retireActiveToolCardReceipt.call(this, threadId, receiptId); return { interrupted: true } }

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
				// Keep parent mutations in the same exclusive lane as inherited child
				// mutations. The approval registry is the authoritative full edit/terminal
				// set; read-only builtins and application controls stay outside it.
				const requiresWriteLease = !!approvalTypeOfBuiltinToolName[toolName];
				const ioLease = requiresWriteLease && agentRunGeneration !== undefined && this._agentSubagentService?.acquireGroupIo ? await this._agentSubagentService.acquireGroupIo(threadId, agentRunGeneration, 'write', operationCancellation.token) : { release() { } };
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
				const ioLease = agentRunGeneration !== undefined && this._agentSubagentService?.acquireGroupIo ? await this._agentSubagentService.acquireGroupIo(threadId, agentRunGeneration, 'write', operationCancellation.token) : { release() { } };
				try {
					if (interrupted || !isCurrentParentRun()) { settleCancelled(); return cancellationOutcome() }
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
			operationCancellation.dispose()
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
		type Prepared = { call: NativeBatchRangeCall; batchRef: BatchCallRef; params: ToolCallParams<ToolName>; rawParams: RawToolParamsObj; budget: number; receiptId: string; messageIndex: number; interrupted: boolean; cancelledByCard: boolean; published: boolean; interruptTool?: () => void; cancellation: CancellationTokenSource; ledger: ParentSafeReadLedgerEntry };
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
			const item: Prepared = { call, batchRef, params, rawParams: call.rawParams, budget: budgets[waveOrdinal] ?? 0, receiptId, messageIndex, interrupted: false, cancelledByCard: false, published: false, cancellation: new CancellationTokenSource(), ledger };
			const cancel = () => { item.cancelledByCard = true; item.ledger.cancelled = true; if (!item.interrupted) { item.interrupted = true; try { item.cancellation.cancel(); } catch { } try { item.interruptTool?.(); } catch { } } };
			this._registerActiveToolCardReceipt(threadId, receiptId, call.id, batchRef, cancel, () => isCurrentParentRun() && (this._agentControlGeneration.get(threadId) ?? 0) === agentRunGeneration, false, messageIndex);
			prepared.push(item);
			staged.push(item);
		}
		const publishInvalid = (item: Invalid) => {
			// A re-entrant global Stop may materialize a skipped placeholder for a
			// declaration before this already-validated malformed call is published.
			// Preserve one durable tuple. A skipped row at this exact staged tuple can
			// only have been materialized by re-entrant cancellation before this loop
			// reaches the already-validated malformed declaration.
			const messages = this.state.allThreads[threadId]?.messages ?? [];
			const index = messages.findIndex(message => message.role === 'tool' && message.id === item.call.id && message.batchId === item.batchRef.batchId && message.batchOrdinal === item.batchRef.batchOrdinal);
			const invalid = { role: 'tool' as const, type: 'invalid_params' as const, rawParams: item.call.rawParams, result: null, name: item.call.name, content: item.content, id: item.call.id, mcpServerName: undefined, ...item.batchRef };
			if (index < 0) this._addMessageToThread(threadId, invalid);
			else if (messages[index].role === 'tool' && messages[index].type === 'skipped') this._editMessageInThread(threadId, index, invalid);
		};
		// Publish all rows in declaration order only after every receipt exists. A
		// synchronous Stop can therefore cancel any member of this wave exactly once.
		for (const item of staged) {
			if ('kind' in item) {
				publishInvalid(item);
				continue;
			}
			if (!isCurrentParentRun() || item.interrupted) {
				const exists = (this.state.allThreads[threadId]?.messages ?? []).some(message => message.role === 'tool' && message.id === item.call.id && message.batchId === item.batchRef.batchId && message.batchOrdinal === item.batchRef.batchOrdinal);
				if (!exists) this._addMessageToThread(threadId, { role: 'tool', type: 'skipped', name: item.call.name as ToolName, content: 'Native tool batch was cancelled before this call could start.', result: null, id: item.call.id, rawParams: item.rawParams, mcpServerName: undefined, ...item.batchRef });
				item.cancellation.dispose();
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
				const groupLease = this._agentSubagentService?.acquireGroupIo ? await this._agentSubagentService.acquireGroupIo(threadId, agentRunGeneration, 'read', item.cancellation.token) : { release() { } };
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
			} finally { item.cancellation.dispose(); item.ledger.settled = true; this._retireActiveToolCardReceipt(threadId, item.receiptId); }
		};
		const completed = await Promise.all(prepared.filter(item => item.published).map(execute));
		// `abortRunning` can be re-entered by a message listener and finish its
		// declaration-tail terminalization only after the first publication pass.
		// Re-upsert the immutable staged diagnosis before this wave returns.
		for (const item of staged) if ('kind' in item) publishInvalid(item);
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
		const awaitThreadStorageWrites = (this as unknown as { _awaitThreadStorageWrites?: ChatThreadService['_awaitThreadStorageWrites'] })._awaitThreadStorageWrites ?? ChatThreadService.prototype._awaitThreadStorageWrites
		const currentThreadStorageRaw = (this as unknown as { _currentThreadStorageRaw?: ChatThreadService['_currentThreadStorageRaw'] })._currentThreadStorageRaw
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
		messageLoop: while (shouldSendAnotherMessage) {
			if (!isCurrentRun()) return
			// false by default each iteration
			shouldSendAnotherMessage = false
			isRunningWhenEnd = undefined
			nMessagesSent += 1

			this._setStreamState(threadId, { isRunning: 'idle', interrupt: idleInterruptor })
			// A steer becomes model-visible only at this boundary: every preceding tool
			// receipt has settled and the next provider request has not been assembled.
			await this._promoteSteerAtSafeBoundary(threadId, parentRun)
			// A synchronous history/event observer can Stop or replace this parent while
			// the steer is being claimed. Never assemble a provider request after that.
			if (!isCurrentRun()) return
			const agentMailbox = this._agentSubagentService.peekParentMailbox(threadId, agentRunGeneration)
			if (agentMailbox.messages.length) { const content = agentMailbox.messages.join('\n\n'); this._addMessageToThread(threadId, { role: 'user', content, displayContent: content, selections: [], state: defaultMessageState }) }
			if (!isCurrentRun()) return
			if (!await awaitThreadStorageWrites.call(this, threadId)) {
				this._setStreamState(threadId, { isRunning: undefined, error: { message: 'This chat changed in another Void window. Review the latest history before continuing.', fullError: null } })
				return
			}
			if (agentMailbox.messages.length && !this._agentSubagentService.ackParentMailbox(threadId, agentRunGeneration, agentMailbox)) return
			// Conversion is asynchronous. Remember the exact authoritative B1 bytes it
			// observed so a child/history mutation that lands during conversion or main
			// run validation cannot be overtaken by provider dispatch.
			const preparedAgainstRaw = currentThreadStorageRaw?.call(this, threadId)

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

				if (!await awaitThreadStorageWrites.call(this, threadId) || !isCurrentRun()) return
				const runValidated = await this._pendingBroker().validateHistoryRun(threadId, parentRun.runId, parentRun.generation)
				if (!runValidated.ok || !isCurrentRun()) { if (!runValidated.ok) this._warnPendingMutation(runValidated, 'reconcile'); return }
				if (currentThreadStorageRaw && currentThreadStorageRaw.call(this, threadId) !== preparedAgainstRaw) {
					// Rebuild provider context from the newly durable history. Nothing has been
					// sent yet, so this is a local retry rather than a provider retry.
					shouldSendAnotherMessage = true
					continue messageLoop
				}
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
				// The provider declaration is the durable authority for every following
				// tool row. Never begin a mutation/terminal/MCP side effect while its CAS
				// is unresolved or has lost to another window.
				if (!await awaitThreadStorageWrites.call(this, threadId) || !isCurrentRun()) return

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
		const messages = [
			...oldThread.messages.slice(0, messageIdx),
			newMessage,
			...oldThread.messages.slice(messageIdx + 1, Infinity),
		];
		const newThreads = {
			...allThreads,
			[oldThread.id]: {
				...oldThread,
				lastModified: new Date().toISOString(),
				messages,
				childActivities: this._pruneChildActivitiesForMessages(oldThread, messages),
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
		this._childGroupSourceOfThread.set(threadId, Object.freeze({ runId: parentRun.runId, generation: parentRun.generation }))
		const wrapped = this._wrapRunAgentToNotify(run, threadId, parentRun)
		let releaseAwaitingApproval!: () => void
		const awaitingApprovalSettled = new Promise<void>(resolve => releaseAwaitingApproval = resolve)
		const settled = wrapped.then(() => undefined, () => undefined).finally(async () => {
			const current = this._runQuiescenceOfThread.get(threadId)
			// Final assistant/tool/child rows remain protected by the main history-run
			// owner until their exact CAS tail settles.  A foreign writer or destructive
			// transaction cannot overtake the terminal row.
			await this._awaitThreadStorageWrites(threadId)
			const latest = this.state.allThreads[threadId]?.messages.at(-1)
			if (current?.runId === parentRun.runId && latest?.role === 'tool' && latest.type === 'tool_request') {
				// A continuation CAS can lose before it replaces the persisted approval.
				// Restore the same paused identity instead of minting a new run against the
				// retained main owner; the user can retry Approve or Reject exactly once.
				this._setStreamState(threadId, { isRunning: 'awaiting_user' })
				this._runQuiescenceOfThread.set(threadId, { runId: parentRun.runId, generation: parentRun.generation, settled: awaitingApprovalSettled, releaseAwaitingApproval })
				const held = await this._pendingBroker().holdApproval(threadId, parentRun.runId, parentRun.generation, pendingApprovalIdentity(latest))
				if (!held.ok) {
					this._warnPendingMutation(held, 'reconcile')
					return
				}
				// `_runChatAgent` has returned, but the approval request remains a
				// user-owned logical boundary. Hold FIFO input until it is approved,
				// rejected, or stopped; otherwise a queue drain would reject the row.
				if (!await this._releaseUndeliveredSteers(threadId, parentRun, true)) return
				return
			}
			// A steer that did not reach a valid tool boundary belongs to the normal
			// FIFO queue once its target parent is truly quiescent. It must never be
			// silently attached to a replacement parent.
			// Close the renderer target before awaiting the main-process close. A
			// reentrant submit after main linearization must observe Queue locally,
			// while the broker independently converts any stale Steer request.
			if (!await this._releaseUndeliveredSteers(threadId, parentRun)) return
			if (this._runQuiescenceOfThread.get(threadId)?.runId === parentRun.runId) this._runQuiescenceOfThread.delete(threadId)
			this._applyDeferredExternalThreadRecordIfQuiescent(threadId)
			this._wakePendingChatInputs(threadId)
		})
		this._runQuiescenceOfThread.set(threadId, { runId: parentRun.runId, generation: parentRun.generation, settled })
	}
	private _releaseAwaitingApprovalQuiescence(threadId: string, drain = true): void {
		const current = this._runQuiescenceOfThread.get(threadId)
		if (!current) {
			if (drain) { this._applyDeferredExternalThreadRecordIfQuiescent(threadId); if (this.state.allThreads[threadId]) void this._drainPendingChatInputs(threadId) }
			return
		}
		if (!current.releaseAwaitingApproval) return
		if (!drain) {
			this._runQuiescenceOfThread.delete(threadId)
			current.releaseAwaitingApproval()
			return
		}
		if (current.closing) return
		current.closing = (async () => {
			if (!await this._awaitThreadStorageWrites(threadId)) return false
			return this._releaseUndeliveredSteers(threadId, current)
		})()
		void current.closing.then(closed => {
			if (!closed || this._runQuiescenceOfThread.get(threadId) !== current) return
			this._runQuiescenceOfThread.delete(threadId)
			current.releaseAwaitingApproval?.()
			// `drain=false` immediately continues the same logical turn with a
			// replacement parent run. Keep a deferred remote delete fenced until that
			// continuation reaches a final quiescence boundary.
			this._applyDeferredExternalThreadRecordIfQuiescent(threadId); this._wakePendingChatInputs(threadId)
		})
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
	private _scheduleAgentMailboxContinuation(threadId: string, generation: number, capturedSource?: Readonly<{ runId: string; generation: number }>): void {
		const key = `${threadId}:${generation}`; if (this._agentMailboxContinuationScheduled.has(key)) return;
		this._agentMailboxContinuationScheduled.add(key);
		setTimeout(() => void (async () => {
			let parentRun: ParentRunOwnership | undefined;
			let directLeaseId: string | undefined;
			let brokerRunOpened = false;
			const closeAbortedRun = async () => {
				if (directLeaseId) { await this._pendingBroker().abandonDirectHistoryAppend(threadId, directLeaseId).catch(() => undefined); directLeaseId = undefined; }
				if (brokerRunOpened && parentRun) await this._releaseUndeliveredSteers(threadId, parentRun).catch(() => undefined);
				parentRun?.deactivate(); parentRun?.releaseLatest();
			};
			try {
				const quiescence = this._runQuiescenceOfThread.get(threadId); if (quiescence) await quiescence.settled;
				if ((this._agentControlGeneration.get(threadId) ?? -1) !== generation || this._parentRunTokenOfThread.has(threadId) || this._startingParentRunOfThread.has(threadId) || this._pendingChatSubmissionOfThread.has(threadId) || this._isAwaitingUser(threadId)) return;
				const source = this._childGroupSourceOfThread.get(threadId) ?? capturedSource; const authority = this._agentDelegationAuthorityOfThread.get(threadId); const thread = this.state.allThreads[threadId];
				if (!source || source.generation !== generation || !authority?.allowed || authority.generation !== generation || !thread || authority.runtimeSnapshot.ownerProjectRoot !== this._workspaceContextService.getWorkspace().folders[0]?.uri.toString() || authority.runtimeSnapshot.workspaceTrustedAtAdmission !== this._workspaceTrustManagementService.isWorkspaceTrusted()) return;
				const model = authority.runtimeSnapshot.model; if (!model.hasModel) return;
				const childSync = await this._syncActiveChildGroup(threadId, source); if (!childSync.ok) return;
				parentRun = resumeParentRunOwnership(threadId, source.runId, generation, this._parentRunTokenOfThread, this._agentControlGeneration); if (!parentRun) return;
				const mailbox = this._agentSubagentService.peekParentMailbox(threadId, generation); if (!mailbox.messages.length) { parentRun.deactivate(); parentRun.releaseLatest(); return; }
				const content = mailbox.messages.join('\n\n'); const authorized = await this._pendingBroker().authorizeDirectHistoryAppend(threadId, content, [], parentRun.runId, generation);
				if (!authorized.ok) { this._warnPendingMutation(authorized, 'reconcile'); parentRun.deactivate(); parentRun.releaseLatest(); return; }
				directLeaseId = authorized.value.leaseId; brokerRunOpened = true;
				if (!parentRun.isActive()) { await closeAbortedRun(); return; }
				this._addMessageToThread(threadId, { role: 'user', pendingInputId: authorized.value.pendingInputId, pendingInputSelectionsFingerprint: authorized.value.selectionsFingerprint, content, displayContent: content, selections: [], state: defaultMessageState });
				const durable = await this._awaitThreadStorageWrites(threadId); const verified = durable ? await this._pendingBroker().verifyDirectHistoryAndRelease(threadId, directLeaseId) : undefined;
				if (!verified?.ok) { await closeAbortedRun(); return; }
				directLeaseId = undefined;
				const mailboxAcked = this._agentSubagentService.ackParentMailbox(threadId, generation, mailbox);
				if (!parentRun.isActive() || this._pendingChatSubmissionOfThread.has(threadId) || !mailboxAcked) { await closeAbortedRun(); return; }
				const continuationRun = parentRun;
				this._startTrackedParentRun(threadId, continuationRun, () => this._runChatAgent({ threadId, instructionSnapshot: authority.runtimeSnapshot, agentDelegationAuthority: authority, parentRun: continuationRun, modelSelection: { providerName: model.providerName as ModelSelection['providerName'], modelName: model.modelName }, modelSelectionOptions: model.modelSelectionOptions as ModelSelectionOptions }));
				brokerRunOpened = false;
			} catch { await closeAbortedRun(); }
			finally { this._agentMailboxContinuationScheduled.delete(key); }
		})(), 0);
	}
	private _canDeliverPendingChatInput(record: PendingChatInputRecord): boolean {
		return !this._deletingPendingInputThreads.has(record.threadId)
			&& !!this.state.allThreads[record.threadId]
			&& this._isPendingInputOwnerCurrent(record.ownerProjectRoot, record.trustedAtSubmit)
	}
	private _isAwaitingUser(threadId: string): boolean {
		return this.streamState[threadId]?.isRunning === 'awaiting_user'
	}
	private async _releaseUndeliveredSteers(threadId: string, parentRun: Pick<ParentRunOwnership, 'runId' | 'generation'>, retainApproval = false): Promise<boolean> {
		let attempt = 0
		let warned = false
		while (this.state.allThreads[threadId] && !(this as unknown as { _store?: { isDisposed?: boolean } })._store?.isDisposed) {
			let result: PendingChatInputMutationResult | undefined
			try {
				if (!await this._ensurePendingInputBrokerReady(false)) throw new Error('pending_input_broker_unavailable')
				const childSync = await this._syncActiveChildGroup(threadId, parentRun, true)
				// No local await may separate the complete child-set acknowledgement from
				// issuing the exact close. A synchronous child admission event would first
				// advance the local coordination view; a main-side sync that wins this race
				// changes the source revision and makes this close retry instead of opening
				// a parent->child ownership gap.
				if (childSync.ok) result = await this._pendingBroker().closeRunAndReleaseSteers(threadId, parentRun.runId, parentRun.generation, this._pendingInputAuthority(threadId, parentRun.generation), retainApproval, childSync.identity)
			} catch { /* retry the exact idempotent close */ }
			if (result?.ok) {
				if (!retainApproval && !this._coordinationChildRuns(threadId).length) this._childGroupSourceOfThread.delete(threadId)
				return true
			}
			if (!warned) { this._warnPendingMutation(result ?? { ok: false, reason: 'backend_unavailable' }, 'reconcile'); warned = true }
			if (result && result.reason !== 'backend_unavailable' && result.reason !== 'not_initialized' && result.reason !== 'append_in_progress') return false
			const delay = (this as unknown as { _pendingRunCloseRetryDelay?: (attempt: number) => Promise<void> })._pendingRunCloseRetryDelay
			if (delay) await delay(attempt++)
			else await new Promise<void>(resolve => setTimeout(resolve, Math.min(2_000, 100 * 2 ** Math.min(attempt++, 5))))
		}
		return false
	}
	private _deliveredPendingInputIdsForThread(threadId: string): readonly string[] { return this._deliveredPendingInputIds()[threadId] ?? [] }
	private async _settleUnappendedClaim(claim: PendingChatInputClaim, result: 'queued' | 'dormant' = 'dormant'): Promise<boolean> {
		const current = this._findPendingChatInput(claim.record.threadId, claim.record.id)
		if (!current || current.phase !== 'claiming' || current.claimId !== claim.record.claimId) return false
		const settled = await this._pendingBroker().settleClaim(claim.record.threadId, claim.record.id, claim.record.claimId!, undefined, result)
		if (!settled.ok) this._warnPendingMutation(settled, 'reconcile')
		return settled.ok
	}
	private async _promoteSteerAtSafeBoundary(threadId: string, parentRun: ParentRunOwnership): Promise<boolean> {
		await this._ensurePendingInputBrokerReady()
		if (this._pendingNamespaceMutation) return false
		const claimed = await this._pendingBroker().claimSteerAtBoundary(threadId, parentRun.runId, parentRun.generation, this._pendingInputAuthority(threadId, parentRun.generation), this._deliveredPendingInputIdsForThread(threadId))
		if (!claimed.ok) { this._warnPendingMutation(claimed, 'reconcile'); return false }
		const claim = claimed.value
		if (!claim) return false
		if (!parentRun.isActive() || !this._canDeliverPendingChatInput(claim.record)) { await this._settleUnappendedClaim(claim, this._canDeliverPendingChatInput(claim.record) ? 'queued' : 'dormant'); return false }
		const authorized = await this._pendingBroker().authorizeAppend(threadId, claim.record.id, claim.record.claimId!, claim.fingerprint, this._pendingInputAuthority(threadId, parentRun.generation), parentRun.runId, parentRun.generation)
		if (!authorized.ok) { await this._settleUnappendedClaim(claim); return false }
		if (!parentRun.isActive() || this._agentControlGeneration.get(threadId) !== parentRun.generation || !this.state.allThreads[threadId] || !this._canDeliverPendingChatInput(claim.record)) {
			await this._pendingBroker().settleClaim(threadId, claim.record.id, claim.record.claimId!, authorized.value.leaseId, 'dormant')
			return false
		}
		if (!await this._awaitThreadStorageWrites(threadId)) { await this._pendingBroker().settleClaim(threadId, claim.record.id, claim.record.claimId!, authorized.value.leaseId, 'dormant'); return false }
		const inspected = await this._pendingBroker().inspectAppendHistory(threadId, claim.record.id, claim.record.claimId!, authorized.value.leaseId)
		if (!inspected.ok) { await this._pendingBroker().settleClaim(threadId, claim.record.id, claim.record.claimId!, authorized.value.leaseId, 'dormant'); return false }
		const beforeAppend = inspected.value
		if (beforeAppend.kind === 'exact') {
			const durableThread = this._threadFromBrokerHistoryInspection(threadId, beforeAppend)
			if (!durableThread || !this._adoptDurablePendingInputThread(threadId, durableThread) || !parentRun.isActive() || this._agentControlGeneration.get(threadId) !== parentRun.generation || !this._canDeliverPendingChatInput(claim.record)) {
				await this._pendingBroker().settleClaim(threadId, claim.record.id, claim.record.claimId!, authorized.value.leaseId, 'dormant'); return false
			}
			const recovered = await this._pendingBroker().verifyHistoryAndSettle(threadId, claim.record.id, claim.record.claimId!, authorized.value.leaseId)
			const recoveredThread = recovered.ok ? this._threadFromBrokerHistoryInspection(threadId, recovered.value) : undefined
			if (!recovered.ok || !recoveredThread || !this._adoptDurablePendingInputThread(threadId, recoveredThread)) { await this._pendingBroker().settleClaim(threadId, claim.record.id, claim.record.claimId!, authorized.value.leaseId, 'dormant'); this._scheduleDeliveredPendingReconcile(); return false }
			return parentRun.isActive() && this._canDeliverPendingChatInput(claim.record)
		}
		if (beforeAppend.kind !== 'zero') {
			await this._pendingBroker().settleClaim(threadId, claim.record.id, claim.record.claimId!, authorized.value.leaseId, 'dormant')
			await this._clearPendingRowsAfterDurableTombstone(threadId); this._scheduleDeliveredPendingReconcile(); return false
		}
		let historyDurable = false
		try {
			const latestThread = this._threadFromBrokerHistoryInspection(threadId, beforeAppend)
			if (latestThread && !this._adoptDurablePendingInputThread(threadId, latestThread)) throw new Error('pending_input_history_recovery_failed')
			this._addMessageToThread(threadId, { role: 'user', pendingInputId: claim.record.id, pendingInputSelectionsFingerprint: authorized.value.selectionsFingerprint, content: claim.record.text, displayContent: claim.record.text, selections: [...claim.record.selections], state: defaultMessageState })
			if (!await this._awaitThreadStorageWrites(threadId)) throw new Error('pending_input_history_write_failed')
			historyDurable = true
			const verified = await this._pendingBroker().verifyHistoryAndSettle(threadId, claim.record.id, claim.record.claimId!, authorized.value.leaseId)
			const verifiedThread = verified.ok ? this._threadFromBrokerHistoryInspection(threadId, verified.value) : undefined
			if (!verified.ok || verified.value.kind !== 'exact' || !verifiedThread || !this._adoptDurablePendingInputThread(threadId, verifiedThread)) throw new Error('pending_input_history_not_durable')
		} catch {
			if (!historyDurable) this._removeUnpersistedPendingInputMessage(threadId, claim.record.id)
			await this._pendingBroker().settleClaim(threadId, claim.record.id, claim.record.claimId!, authorized.value.leaseId, 'dormant')
			if (historyDurable) this._scheduleDeliveredPendingReconcile()
			else await this._clearPendingRowsAfterDurableTombstone(threadId)
			return false
		}
		return parentRun.isActive() && this._canDeliverPendingChatInput(claim.record)
	}
	private _wakePendingChatInputs(threadId: string, expected?: PendingChatInputRecord): void {
		const stop = expected?.mode === 'stop_and_send' && expected.phase === 'queued'
			? this._findPendingChatInput(threadId, expected.id)
			: this.getPendingChatInputs(threadId).find(record => record.mode === 'stop_and_send' && record.phase === 'queued')
		const active = this._runQuiescenceOfThread.get(threadId)
		if (!stop) { void this._drainPendingChatInputs(threadId); return }
		if (active) {
			if (stop.targetRunId === active.runId && stop.targetGeneration === active.generation) this._stopAndSendPendingInput(threadId, stop, active)
			// A targetless row or a row bound to an older run is ordinary queued work
			// behind this exact replacement.  Never retarget a delayed snapshot.
			return
		}
		if (stop.targetChildGeneration !== undefined && stop.targetChildIds?.length) {
			const activeChildren = this._coordinationChildRuns(threadId)
			const targetIds = new Set(stop.targetChildIds)
			const captured = activeChildren.filter(view => view.generation === stop.targetChildGeneration && targetIds.has(view.id))
			const foreign = activeChildren.some(view => view.generation !== stop.targetChildGeneration || !targetIds.has(view.id))
			if (captured.length && !foreign) { this._stopAndSendChildInput(threadId, stop); return }
			// The captured child group already ended. A later child/run must not be
			// cancelled by this delayed broker event; ordinary Queue ordering holds it.
			if (activeChildren.length) return
		}
		const generation = this._agentControlGeneration.get(threadId) ?? stop.targetGeneration ?? stop.generation
		if (generation <= stop.generation) this._agentControlGeneration.set(threadId, stop.generation)
		void this._drainPendingChatInputs(threadId)
	}
	private _stopAndSendChildInput(threadId: string, expectedInput: PendingChatInputRecord): void {
		const expectedFingerprint = pendingChatInputFingerprint(expectedInput)
		const matchesExpected = (record: PendingChatInputRecord | undefined) => !!record && record.id === expectedInput.id && record.mode === 'stop_and_send' && record.phase === 'queued' && pendingChatInputFingerprint(record) === expectedFingerprint
		const input = this._findPendingChatInput(threadId, expectedInput.id)
		if (!matchesExpected(input) || !this._canDeliverPendingChatInput(input!) || input!.targetChildGeneration === undefined || !input!.targetChildIds?.length) return
		const targetIds = new Set(input!.targetChildIds)
		const activeChildren = this._coordinationChildRuns(threadId)
		const captured = activeChildren.filter(view => view.generation === input!.targetChildGeneration && targetIds.has(view.id))
		if (!captured.length || activeChildren.some(view => view.generation !== input!.targetChildGeneration || !targetIds.has(view.id))) { this._wakePendingChatInputs(threadId, input); return }
		const key = `${threadId}\u0000child:${input!.targetChildGeneration}:${input!.targetChildIds.join(',')}`
		if (this._stopAndSendFlights.has(key)) return
		let completeFlight!: () => void
		const flight = new Promise<void>(resolve => completeFlight = resolve)
		this._stopAndSendFlights.set(key, flight)
		void (async () => {
			try {
				const generation = this._agentControlGeneration.get(threadId)
				if (generation !== undefined && generation !== input!.targetChildGeneration) return
				if (generation === undefined) this._agentControlGeneration.set(threadId, input!.targetChildGeneration!)
				await this.abortRunning(threadId)
				if (this._coordinationChildRuns(threadId).some(view => view.generation === input!.targetChildGeneration && targetIds.has(view.id))) return
				const record = this._findPendingChatInput(threadId, expectedInput.id)
				if (!matchesExpected(record) || !this.state.allThreads[threadId] || !this._canDeliverPendingChatInput(record!)) return
				void this._drainPendingChatInputs(threadId)
			} catch {
				// The durable row remains visible and a later child/run event may retry.
			} finally {
				completeFlight()
				if (this._stopAndSendFlights.get(key) === flight) {
					this._stopAndSendFlights.delete(key)
					const latest = this._findPendingChatInput(threadId, expectedInput.id)
					if (latest?.phase === 'queued' && pendingChatInputFingerprint(latest) !== expectedFingerprint) setTimeout(() => this._wakePendingChatInputs(threadId, latest), 0)
				}
			}
		})()
	}
	private _stopAndSendPendingInput(threadId: string, expectedInput: PendingChatInputRecord, active: ParentRunQuiescence | undefined): void {
		const matchesExpected = (record: PendingChatInputRecord | undefined) => !!record && record.id === expectedInput.id && record.mode === 'stop_and_send' && record.phase === 'queued' && pendingChatInputFingerprint(record) === pendingChatInputFingerprint(expectedInput)
		const input = this._findPendingChatInput(threadId, expectedInput.id)
		if (!matchesExpected(input) || !this._canDeliverPendingChatInput(input!)) return
		if (!active || input!.targetRunId !== active.runId || input!.targetGeneration !== active.generation) { this._wakePendingChatInputs(threadId, input); return }
		const key = `${threadId}\u0000${active.runId}`
		if (this._stopAndSendFlights.has(key)) return
		let completeFlight!: () => void
		const flight = new Promise<void>(resolve => completeFlight = resolve)
		this._stopAndSendFlights.set(key, flight)
		void (async () => {
			const expectedFingerprint = pendingChatInputFingerprint(expectedInput)
			try {
				if (this._runQuiescenceOfThread.get(threadId)?.runId !== active.runId) return
				await this.abortRunning(threadId)
				await active.settled
				const record = this._findPendingChatInput(threadId, expectedInput.id)
				if (!matchesExpected(record) || !this.state.allThreads[threadId] || !this._canDeliverPendingChatInput(record!)) return
				void this._drainPendingChatInputs(threadId)
			} catch {
				// Stop is best-effort at this boundary; the authoritative row stays visible.
			} finally {
				completeFlight()
				if (this._stopAndSendFlights.get(key) === flight) {
					this._stopAndSendFlights.delete(key)
					// A remote/local Edit or Move can legitimately replace the row while
					// the exact old parent is stopping. Its snapshot wake was coalesced by
					// this flight, so re-evaluate only the newer authoritative identity.
					// Deletion deliberately schedules nothing and the stale payload is
					// never delivered.
					const latest = this._findPendingChatInput(threadId, expectedInput.id)
					if (latest?.phase === 'queued' && pendingChatInputFingerprint(latest) !== expectedFingerprint) setTimeout(() => this._wakePendingChatInputs(threadId, latest), 0)
				}
			}
		})()
	}
	private async _drainPendingChatInputs(threadId: string): Promise<void> {
		await this._ensurePendingInputBrokerReady()
		if (this._pendingNamespaceMutation) return
		const childSource = this._childGroupSourceOfThread.get(threadId)
		if (childSource) {
			const childSync = await this._syncActiveChildGroup(threadId, childSource)
			if (!childSync.ok || childSync.identity.childIds.length) return
			if (this._runQuiescenceOfThread.get(threadId)?.runId !== childSource.runId) this._childGroupSourceOfThread.delete(threadId)
		}
		const startingParentRuns = this._startingParentRunOfThread ?? new Map<string, StartingParentRun>()
		if (this._deletingPendingInputThreads.has(threadId) || this._drainingPendingChatInputs.has(threadId) || this._runQuiescenceOfThread.has(threadId) || startingParentRuns.has(threadId) || this._pendingChatSubmissionOfThread.has(threadId) || this._isAwaitingUser(threadId) || this._coordinationChildRuns(threadId).length > 0) return
		this._drainingPendingChatInputs.add(threadId)
		try {
			if (this._deletingPendingInputThreads.has(threadId) || !this.state.allThreads[threadId]) return
			const claimed = await this._pendingBroker().claimNextQueued(threadId, this._pendingInputAuthority(threadId), this._deliveredPendingInputIdsForThread(threadId))
			if (!claimed.ok) { this._warnPendingMutation(claimed, 'reconcile'); return }
			const claim = claimed.value
			if (!claim) return
			if (!this.state.allThreads[threadId] || !this._canDeliverPendingChatInput(claim.record)) { await this._settleUnappendedClaim(claim); return }
			let accepted = false
			try { accepted = await this._addUserMessageAndStreamResponse({ userMessage: claim.record.text, _chatSelections: [...claim.record.selections], threadId, pendingInputId: claim.record.id, pendingInputClaim: claim }) }
			catch { accepted = false }
			if (!accepted) await this._settleUnappendedClaim(claim)
		} finally {
			this._drainingPendingChatInputs.delete(threadId)
			if (!this.state.allThreads[threadId]) this._scheduleExternalPendingDelete(threadId)
		}
	}

	dismissStreamError(threadId: string): void {
		this._setStreamState(threadId, undefined)
	}


	private async _addUserMessageAndStreamResponse({ userMessage, _chatSelections, threadId, pending, pendingInputId, pendingInputClaim, messageEdit }: { userMessage: string, _chatSelections?: StagingSelectionItem[], threadId: string, pending?: PendingChatSubmissionRecord, pendingInputId?: string, pendingInputClaim?: PendingChatInputClaim, messageEdit?: UserMessageEditPlan }) {
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
		// Broker-claimed Queue/Steer/Stop-and-Send rows already carry the exact
		// generation chosen at durable admission. Revoking again here advances past
		// that row (most visibly after a paused approval Stop-and-Send) and makes the
		// just-claimed input stale. Only the legacy non-broker direct-call seam owns a
		// fresh generation boundary at this point.
		if (!pending && !pendingInputClaim && !priorRun) this._revokeAgentDelegation(threadId, true)
		const turnGeneration = pending?.generation ?? pendingInputClaim?.record.generation ?? this._agentControlGeneration.get(threadId)
		if (turnGeneration === undefined) return false
		if (pendingInputClaim && !this._agentControlGeneration.has(threadId)) this._agentControlGeneration.set(threadId, turnGeneration)
		const isCurrentGeneration = () => this._agentControlGeneration.has(threadId) && this._agentControlGeneration.get(threadId) === turnGeneration
		const isCurrentPendingInput = () => {
			if (!pendingInputId) return true
			const claimed = pendingInputClaim?.record
			if (!claimed || claimed.id !== pendingInputId || claimed.threadId !== threadId || claimed.phase !== 'claiming' || typeof claimed.claimId !== 'string' || !claimed.claimId) return false
			const current = this._findPendingChatInput(threadId, pendingInputId)
			return current?.phase === 'claiming'
				&& current.claimId === claimed.claimId
				&& current.generation === claimed.generation
				&& current.ownerProjectRoot === claimed.ownerProjectRoot
				&& current.trustedAtSubmit === claimed.trustedAtSubmit
				&& this._canDeliverPendingChatInput(current)
		}
		const isCurrentTurn = () => isCurrentGeneration() && (!pending || this._pendingChatSubmissionOfThread.get(threadId) === pending) && isCurrentPendingInput()
		if (priorRun) await priorRun
		if (!isCurrentTurn()) return false
		if (pendingInputClaim) {
			if (!await this._awaitThreadStorageWrites(threadId)) { await this._settleUnappendedClaim(pendingInputClaim); return false }
			const inspected = await this._pendingBroker().inspectAppendHistory(threadId, pendingInputClaim.record.id, pendingInputClaim.record.claimId!, undefined)
			if (!inspected.ok) { await this._settleUnappendedClaim(pendingInputClaim); return false }
			const beforePreparation = inspected.value
			if (beforePreparation.kind === 'exact' || beforePreparation.kind === 'zero' && beforePreparation.envelopeRaw) {
				const durableThread = this._threadFromBrokerHistoryInspection(threadId, beforePreparation)
				if (!durableThread || !this._adoptDurablePendingInputThread(threadId, durableThread) || !isCurrentTurn()) return false
			}
			else if (beforePreparation.kind !== 'zero') {
				await this._settleUnappendedClaim(pendingInputClaim); await this._clearPendingRowsAfterDurableTombstone(threadId); this._scheduleDeliveredPendingReconcile(); return false
			}
		}
		const owner = this._workspaceContextService.getWorkspace().folders[0]?.uri
		// Custom roles are part of the native Agent control surface, rather than an
		// effect of selecting an Agent chip. A marker still carries exact parent
		// intent, but a marker-free Agent turn must retain the catalog so a later
		// explicit spawn_agent(agent_type) can resolve an advertised role.
		const roleCatalog = agentDelegationAllowed ? await this._agentCustomAgentService.getCatalog(owner, owner) : undefined
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
		const userMessageContent = agentDelegationAllowed
			? `${userMessageContentBase}\n\n[${agentDelegationIntent ? 'User delegation marker' : 'Native Agent controls'}: up to ${delegationLimits.maxAcceptedChildren} generic read-only children are available for this turn, with ${delegationLimits.maxConcurrentThreadsPerSession} running concurrently and maximum depth ${delegationLimits.maxDepth}. Named custom agents admitted for this turn (optional exact agent_type): ${roleAd?.text || 'none'}${roleAd?.omitted ? `; ${roleAd.omitted} omitted` : ''}.${agentSelection?.agentType ? ` For this selected role, call spawn_agent with agent_type=${agentSelection.agentType} exactly.` : ''} After spawn_agent, continue useful main work before wait_agent. Use list_agents to inspect retained results, send_message for active same-group coordination, and interrupt_agent for a selected active target. Late child completions are delivered at a safe model boundary; partial child failures do not prevent your synthesis.]`
			: userMessageContentBase
		const currentOwner = this._workspaceContextService.getWorkspace().folders[0]?.uri.toString()
		if (currentOwner !== runtimeSnapshot.ownerProjectRoot || currentOwner !== runtimeSnapshot.runCwd || this._workspaceTrustManagementService.isWorkspaceTrusted() !== runtimeSnapshot.workspaceTrustedAtAdmission) { this._purgeInstructionTurn(threadId, false); throw new Error('skill_owner_or_trust_changed') }
		if (!isCurrentTurn()) return false
		const parentTools = captureParentModelToolSnapshot('agent', this._mcpService.getMCPTools(), agentDelegationAllowed)
		// Delegation may be admitted for the generic profile even when role-catalog
		// capture did not materialize a settings state. Preserve the historical
		// default-deny policy instead of dereferencing an optional capture.
		const autoApprove = capturedSettingsState?.globalSettings?.autoApprove ?? {}
		const agentDelegationAuthority = Object.freeze({ allowed: agentDelegationAllowed, generation: turnGeneration, limits: delegationLimits, runtimeSnapshot, parentTools, autoApprove: Object.freeze({ edits: !!autoApprove.edits, terminal: !!autoApprove.terminal, mcp: !!autoApprove['MCP tools'] }), ...(agentDelegationAllowed && roleCatalog ? { roles: roleCatalog, settingsState: capturedSettingsState, settingsOfProvider: capturedSettingsOfProvider } : {}) })
		this._agentDelegationAuthorityOfThread.set(threadId, agentDelegationAuthority)
		this._rememberInstructionTurn(threadId, runtimeSnapshot)
		// The public pending-receipt event is synchronous. Hold FIFO admission while
		// it fires, then verify the original generation before history/provider work.
		// Real service instances always own this map; the optional form preserves old
		// narrow prototype fixtures that exercise admission in isolation.
		const startingParentRuns = this._startingParentRunOfThread ?? new Map<string, StartingParentRun>()
		const startingParent: StartingParentRun = Object.freeze({ id: generateUuid(), generation: turnGeneration })
		startingParentRuns.set(threadId, startingParent)
		const parentRun = beginParentRunOwnership(threadId, this._parentRunTokenOfThread, this._agentControlGeneration)
		let parentRunStarted = false
		try {
			const claimedRecord = pendingInputClaim?.record
			const directAuthorized = !claimedRecord ? await this._pendingBroker().authorizeDirectHistoryAppend(threadId, instructions, currSelns, parentRun.runId, parentRun.generation) : undefined
			if (directAuthorized && !directAuthorized.ok) return false
			if (pending && !this._settlePendingChatSubmission(pending, true)) { if (directAuthorized?.ok) await this._pendingBroker().abandonDirectHistoryAppend(threadId, directAuthorized.value.leaseId); return false }
			// A direct pending receipt is intentionally removed by settlement above.
			// Queue admission has a separate exact-claim/provenance fence that must
			// remain current through the final history append boundary.
			if (!isCurrentGeneration() || !isCurrentPendingInput() || !this.state.allThreads[threadId]) return false
			const authorized = claimedRecord
				? await this._pendingBroker().authorizeAppend(threadId, claimedRecord.id, claimedRecord.claimId!, pendingInputClaim!.fingerprint, this._pendingInputAuthority(threadId, turnGeneration), parentRun.runId, parentRun.generation)
				: undefined
			if (authorized && !authorized.ok) { await this._settleUnappendedClaim(pendingInputClaim!); return false }
			if (!isCurrentGeneration() || !this.state.allThreads[threadId] || (claimedRecord && !this._canDeliverPendingChatInput(claimedRecord))) {
				if (authorized?.ok) await this._pendingBroker().settleClaim(threadId, claimedRecord!.id, claimedRecord!.claimId!, authorized.value.leaseId, 'dormant')
				if (directAuthorized?.ok) await this._pendingBroker().abandonDirectHistoryAppend(threadId, directAuthorized.value.leaseId)
				return false
			}
			const historyInputId = pendingInputId ?? (directAuthorized?.ok ? directAuthorized.value.pendingInputId : undefined)
			const historySelectionsFingerprint = authorized?.ok ? authorized.value.selectionsFingerprint : directAuthorized?.ok ? directAuthorized.value.selectionsFingerprint : undefined
			const userHistoryElt: ChatMessage = { role: 'user', ...(historyInputId ? { pendingInputId: historyInputId, ...(historySelectionsFingerprint ? { pendingInputSelectionsFingerprint: historySelectionsFingerprint } : {}) } : {}), content: userMessageContent, displayContent: instructions, selections: currSelns, state: defaultMessageState }
			let appendedPendingHistory = false
			let pendingHistoryDurable = false
			try {
				if (authorized?.ok) {
					if (!await this._awaitThreadStorageWrites(threadId)) throw new Error('pending_input_history_prior_write_failed')
					const inspected = await this._pendingBroker().inspectAppendHistory(threadId, claimedRecord!.id, claimedRecord!.claimId!, authorized.value.leaseId)
					if (!inspected.ok) throw new Error('pending_input_history_inspection_failed')
					const beforeAppend = inspected.value
					if (beforeAppend.kind === 'exact') {
						const durableThread = this._threadFromBrokerHistoryInspection(threadId, beforeAppend)
						if (!durableThread || !this._adoptDurablePendingInputThread(threadId, durableThread)) throw new Error('pending_input_history_recovery_failed')
						pendingHistoryDurable = true
					}
					else if (beforeAppend.kind === 'zero') {
						const durableThread = this._threadFromBrokerHistoryInspection(threadId, beforeAppend)
						if (durableThread && !this._adoptDurablePendingInputThread(threadId, durableThread)) throw new Error('pending_input_history_recovery_failed')
						this._addMessageToThread(threadId, userHistoryElt); appendedPendingHistory = true
					}
					else throw new Error('pending_input_history_corrupt')
					if (!await this._awaitThreadStorageWrites(threadId)) throw new Error('pending_input_history_write_failed')
					pendingHistoryDurable = true
					const verified = await this._pendingBroker().verifyHistoryAndSettle(threadId, claimedRecord!.id, claimedRecord!.claimId!, authorized.value.leaseId)
					const verifiedThread = verified.ok ? this._threadFromBrokerHistoryInspection(threadId, verified.value) : undefined
					if (!verified.ok || verified.value.kind !== 'exact' || !verifiedThread || !this._adoptDurablePendingInputThread(threadId, verifiedThread)) throw new Error('pending_input_history_not_durable')
				}
				else {
					if (messageEdit) {
						const current = this.state.allThreads[threadId]
						if (!current || current.messages !== messageEdit.messages || current.childActivities !== messageEdit.childActivities || current.messages[messageEdit.messageIdx] !== messageEdit.target) throw new Error('direct_history_edit_changed')
						const prefix = current.messages.slice(0, messageEdit.messageIdx)
						const editedThread: ThreadType = {
							...current,
							lastModified: new Date().toISOString(),
							messages: [...prefix, userHistoryElt],
							childActivities: this._pruneChildActivitiesForMessages(current, prefix),
							state: { ...current.state, focusedMessageIdx: undefined },
						}
						// The direct lease is the ordering fence, while the main-owned CAS is the
						// stale-writer fence. Do not adopt the speculative edit locally until both
						// the CAS and authoritative history verification succeed.
						if (!await this._queueThreadStorageWrite(threadId, editedThread)) throw new Error('direct_history_edit_write_failed')
					}
					else this._addMessageToThread(threadId, userHistoryElt)
					if (directAuthorized?.ok) {
						if (!messageEdit && !await this._awaitThreadStorageWrites(threadId)) throw new Error('direct_history_write_failed')
						const verified = await this._pendingBroker().verifyDirectHistoryAndRelease(threadId, directAuthorized.value.leaseId)
						const verifiedThread = verified.ok ? this._threadFromBrokerHistoryInspection(threadId, verified.value) : undefined
						if (!verified.ok || verified.value.kind !== 'exact' || !verifiedThread || !this._adoptDurablePendingInputThread(threadId, verifiedThread)) throw new Error('direct_history_not_durable')
					}
				}
			} catch {
				if (authorized?.ok) {
					if (appendedPendingHistory && !pendingHistoryDurable) this._removeUnpersistedPendingInputMessage(threadId, claimedRecord!.id)
					await this._pendingBroker().settleClaim(threadId, claimedRecord!.id, claimedRecord!.claimId!, authorized.value.leaseId, 'dormant')
					if (pendingHistoryDurable) this._scheduleDeliveredPendingReconcile()
					else await this._clearPendingRowsAfterDurableTombstone(threadId)
				}
				if (directAuthorized?.ok) {
					await this._pendingBroker().abandonDirectHistoryAppend(threadId, directAuthorized.value.leaseId).catch(() => undefined)
				}
				return false
			}
			if (authorized?.ok) {
				if (!isCurrentGeneration() || !this.state.allThreads[threadId] || !this._canDeliverPendingChatInput(claimedRecord!)) return false
			}

			const startTrackedParentRun = (this as unknown as { _startTrackedParentRun?: (threadId: string, parentRun: ParentRunOwnership, start: () => Promise<void>) => void })._startTrackedParentRun ?? ChatThreadService.prototype._startTrackedParentRun
			startTrackedParentRun.call(this, threadId, parentRun,
				() => this._runChatAgent({ threadId, instructionSnapshot: runtimeSnapshot, agentDelegationAuthority, parentRun, ...capturedModel, }),
			)
			parentRunStarted = true

			// scroll to bottom
			this.state.allThreads[threadId]?.state.mountedInfo?.whenMounted.then(m => {
				m.scrollToBottom()
			})
			return true
		} finally {
			if (!parentRunStarted) {
				parentRun.deactivate(); parentRun.releaseLatest()
				await this._releaseUndeliveredSteers(threadId, parentRun).catch(() => undefined)
			}
			if (startingParentRuns.get(threadId) === startingParent) {
				startingParentRuns.delete(threadId)
				if (!parentRunStarted) this._applyDeferredExternalThreadRecordIfQuiescent(threadId)
			}
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

	async editUserMessageAndStreamResponse({ userMessage, messageIdx, threadId }: { userMessage: string, messageIdx: number, threadId: string }): Promise<boolean> {

		const thread = this.state.allThreads[threadId]
		if (!thread) return false // should never happen

		const target = thread.messages?.[messageIdx]
		if (target?.role !== 'user') {
			throw new Error(`Error: editing a message with role !=='user'`)
		}

		const currSelns = target.state.stagingSelections || []
		return this._addUserMessageAndStreamResponse({
			userMessage,
			_chatSelections: currSelns,
			threadId,
			messageEdit: Object.freeze({ messageIdx, messages: thread.messages, childActivities: thread.childActivities, target }),
		})
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
		// Only this window's unmaterialized blank view is reusable. Persisted
		// empty history belongs to another window (or an earlier session).
		const { allThreads: currentThreads } = this.state
		if (this._localEmptyThreadId && currentThreads[this._localEmptyThreadId] && this._isUnmaterializedEmptyThread(currentThreads[this._localEmptyThreadId]!)) { this.switchToThread(this._localEmptyThreadId); return }
		// otherwise, start a new thread
		const newThread = newThreadObject()
		this._localEmptyThreadId = newThread.id

		// update state
		const newThreads: ChatThreads = {
			...currentThreads,
			[newThread.id]: newThread
		}
		this._storeAllThreads(newThreads)
		this._setState({ allThreads: newThreads, currentThreadId: newThread.id })
	}


	private _adoptCommittedThreadDeletion(threadId: string): void {
		if (!this.state.allThreads[threadId]) return
		const newThreads = { ...this.state.allThreads }; delete newThreads[threadId]
		this._drainingPendingChatInputs.delete(threadId); this._runQuiescenceOfThread.get(threadId)?.releaseAwaitingApproval?.(); this._runQuiescenceOfThread.delete(threadId); this._startingParentRunOfThread?.delete(threadId); this._childGroupSourceOfThread.delete(threadId); this._childGroupSyncRevisionOfThread.delete(threadId); this._childGroupSyncTailOfThread.delete(threadId)
		for (const key of this._stopAndSendFlights.keys()) if (key.startsWith(`${threadId}\u0000`)) this._stopAndSendFlights.delete(key)
		this._cancelPendingChatSubmission(threadId); this._revokeAgentDelegation(threadId, true); this._parentRunTokenOfThread.delete(threadId); this._cancellingToolReceiptsOfThread.delete(threadId); this._activeToolCardReceiptsOfThread?.delete(threadId); this._agentControlGeneration.delete(threadId); this.clearTransientComposerDraft(threadId); this._deferredExternalThreadKey.delete(threadId); this._agentInstructionSessionOfThread.delete(threadId); this._instructionTurnOfThread.delete(threadId); this._toolsService.invalidateReadReceipts(threadId)
		this._setState({ ...this.state, allThreads: newThreads })
	}
	async deleteThread(threadId: string): Promise<boolean> {
		if (this._pendingNamespaceMutation || this._deletingPendingInputThreads.has(threadId)) return false
		this._deletingPendingInputThreads.add(threadId)
		let brokerLeaseId: string | undefined
		let storagePlan: ThreadStorageMutationPlan | undefined
		let storageCommitted = false
		let recoveryPending = false
		try {
			await this._ensurePendingInputBrokerReady()
			if (!await this._awaitThreadStorageWrites(threadId)) throw new Error('chat_delete_pending_write_failed')
			storagePlan = this._buildThreadDeletionPlan(threadId)
			const deleted = await this._pendingBroker().deleteThreadRecords(threadId, storagePlan.evidence)
			if (!deleted.ok) return this._warnPendingMutation(deleted, 'clear')
			brokerLeaseId = deleted.value.leaseId
			await this._commitThreadStorageMutation(storagePlan, brokerLeaseId)
			if (!this._isThreadTombstoneDurable(threadId)) throw new Error('chat_delete_storage_readback_failed')
			storageCommitted = true
			this._adoptCommittedThreadDeletion(threadId)
			const finalized = await this._pendingBroker().finalizeThreadDeletion(threadId, brokerLeaseId)
			if (!finalized.ok) {
				const outcome = await this._classifyThreadDeletion(threadId, brokerLeaseId)
				if (outcome !== 'committed') { recoveryPending = true; this._warnPendingMutation(finalized, 'reconcile'); this._scheduleThreadDeletionResolution(threadId, brokerLeaseId, () => { if (storagePlan) this._adoptThreadStorageMutationPlan(storagePlan); this._adoptCommittedThreadDeletion(threadId) }); return false }
			}
			return true
		} catch {
			if (brokerLeaseId && !storageCommitted) {
				const outcome = await this._classifyThreadDeletion(threadId, brokerLeaseId)
				if (outcome === 'committed') { storageCommitted = true; if (storagePlan) this._adoptThreadStorageMutationPlan(storagePlan); this._adoptCommittedThreadDeletion(threadId); return true }
				if (outcome === 'ambiguous') { recoveryPending = true; this._scheduleThreadDeletionResolution(threadId, brokerLeaseId, () => { if (storagePlan) this._adoptThreadStorageMutationPlan(storagePlan); this._adoptCommittedThreadDeletion(threadId) }) }
			}
			return this._warnPendingMutation({ ok: false, reason: 'backend_unavailable' }, 'clear')
		}
		finally {
			if (!recoveryPending) this._deletingPendingInputThreads.delete(threadId)
			if (!storageCommitted && !recoveryPending) { this._scheduleDeliveredPendingReconcile(); if (this.state.allThreads[threadId]) this._wakePendingChatInputs(threadId) }
		}
	}
	override dispose(): void {
		for (const threadId of this._pendingChatSubmissionOfThread.keys()) this._cancelPendingChatSubmission(threadId)
		for (const threadId of Object.keys(this.state.allThreads)) this._revokeAgentDelegation(threadId, true)
		// Electron-main owns exact-session disconnect recovery. This renderer must
		// not rewrite the shared cache or another window's records during dispose.
		for (const quiescence of this._runQuiescenceOfThread.values()) quiescence.releaseAwaitingApproval?.()
		for (const retry of this._externalPendingDeleteRetries.values()) clearTimeout(retry.handle)
		if (this._pendingDeliveredReconcileRetry) clearTimeout(this._pendingDeliveredReconcileRetry)
		this._pendingDeliveredReconcileRetry = undefined
		if (this._pendingNamespaceFinalizeRetry) clearTimeout(this._pendingNamespaceFinalizeRetry)
		this._pendingNamespaceFinalizeRetry = undefined; this._pendingNamespaceFinalizeLeaseId = undefined
		for (const retry of this._pendingThreadMutationRetries.values()) clearTimeout(retry)
		this._pendingThreadMutationRetries.clear(); this._externalPendingDeleteRetries.clear(); this._agentDelegationAuthorityOfThread.clear(); this._agentControlGeneration.clear(); this._parentRunTokenOfThread.clear(); this._cancellingToolReceiptsOfThread.clear(); this._activeToolCardReceiptsOfThread?.clear(); this._transientComposerDraftOfThread.clear(); this._deferredExternalThreadKey.clear(); this._drainingPendingChatInputs.clear(); this._runQuiescenceOfThread.clear(); this._startingParentRunOfThread?.clear(); this._approvalActionFlights.clear(); this._stopAndSendFlights.clear(); this._deletingPendingInputThreads.clear(); this._childGroupSourceOfThread.clear(); this._childGroupSyncRevisionOfThread.clear(); this._childGroupSyncTailOfThread.clear(); super.dispose();
	}

	duplicateThread(threadId: string) {
		const { allThreads: currentThreads } = this.state
		const threadToDuplicate = currentThreads[threadId]
		if (!threadToDuplicate) return
		const newThread = {
			...deepClone(threadToDuplicate),
			id: generateUuid(),
			childActivities: normalizeChildActivities({ ...threadToDuplicate.childActivities, records: threadToDuplicate.childActivities.records.map(record => record.status === 'queued' || record.status === 'running' ? { ...record, status: 'interrupted' } : record) }),
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
