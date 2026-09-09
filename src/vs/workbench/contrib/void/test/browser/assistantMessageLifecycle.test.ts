/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ChatThreadService } from '../../browser/chatThreadService.js';
import { closeNativeToolBatchForProspectiveAdmission, ConvertToLLMMessageService } from '../../browser/convertToLLMMessageService.js';
import { projectAgentConfig, resolveAgentInstructions, stableAgentInstructionRevision } from '../../common/agentInstructions.js';
import { createSkillCatalog } from '../../common/agentSkills.js';
import { EMPTY_CHILD_ACTIVITIES } from '../../common/agentSubagents.js';
import { assistantMessagePresentation, INTERNAL_EMPTY_MESSAGE_SENTINEL, sanitizeAssistantDisplayContent } from '../../common/assistantMessagePresentation.js';
import { PendingChatInputBrokerCore, PendingChatInputBrokerStorage, PendingChatInputMutationResult, PendingChatInputNamespace, PendingChatInputSnapshot, pendingChatInputFingerprint, pendingChatInputSelectionsFingerprint, pendingChatInputThreadFingerprint, pendingChatInputThreadStorageKey } from '../../common/pendingChatInputBroker.js';
import { THREAD_STORAGE_RECORD_PREFIX } from '../../common/storageKeys.js';
import { URI } from '../../../../../base/common/uri.js';
import { Severity } from '../../../../../platform/notification/common/notification.js';
import { TerminalToolService } from '../../browser/terminalToolService.js';
import { divideToolWaveOutputBudget, planToolBatchWaves } from '../../common/toolBatchPlanner.js';

const bytes = (value: string) => new TextEncoder().encode(value);

const instructionSnapshot = () => {
	const config = projectAgentConfig(
		{ developerInstructions: 'deterministic local fixture' },
		undefined,
		[],
		'file:///workspace',
		'file:///workspace',
	);
	const candidates = [{ uri: 'file:///workspace/AGENTS.md', outcome: Object.freeze({ status: 'bytes' as const, bytes: bytes('fixture instructions') }) }];
	return Object.freeze({
		...resolveAgentInstructions(config, candidates, stableAgentInstructionRevision(config, candidates)),
		model: Object.freeze({
			hasModel: true as const,
			providerName: 'openAICompatible' as const,
			modelName: 'gpt-4.1',
			contextWindow: 10_000,
			reservedOutputTokens: 1_000,
			modelSelectionOptions: Object.freeze({ reasoningEnabled: true }),
			selectedModelOverrides: Object.freeze({ specialToolFormat: 'openai-style' as const }),
		}),
	});
};

type TestParentRun = Readonly<{ token: symbol; runId: string; generation: number; isLatest: () => boolean; isActive: () => boolean; deactivate: () => void; releaseLatest: () => void }>;
type ParentRunFixture = { _agentControlGeneration: Map<string, number>; _parentRunTokenOfThread: Map<string, symbol> };
type TestMessage = { role: string; content?: string; displayContent?: string; reasoning?: string; type?: string };
type TestToolMutation = { type?: string };
type TestLLMInfo = { displayContentSoFar: string; reasoningSoFar: string; toolCallSoFar: unknown };
type TestStream = { isRunning?: string; llmInfo?: TestLLMInfo; toolInfo?: { toolName: string; toolParams: unknown; id: string; content: string; rawParams: unknown; mcpServerName?: string }; interrupt?: Promise<() => void> | 'not_needed'; error?: unknown };
type TestStreamRecord = Record<string, TestStream | undefined>;
type TestProviderCallbacks = {
	onText(value: { fullText: string; fullReasoning: string; toolCalls?: readonly unknown[] }): void;
	onFinalMessage(value: { fullText: string; fullReasoning: string; toolCalls?: readonly { name: string; id: string; rawParams: Record<string, unknown> }[]; anthropicReasoning: null }): Promise<void>;
	onError(error: { message: string; fullError: Error | null }): Promise<void>;
	onAbort(): void;
};
type TestNotification = { severity: Severity; message: string };
type TestBuiltinSetup = { execute: () => Promise<unknown> } | { result: Promise<unknown>; interruptTool: () => void };
type TestRunChatOptions = {
	threadId: string;
	modelSelection: { providerName: 'openAI' | 'openAICompatible'; modelName: string } | null;
	modelSelectionOptions: unknown;
	instructionSnapshot: ReturnType<typeof instructionSnapshot>;
	callThisToolFirst?: { role: 'tool'; type: 'tool_request'; name: 'read_file' | 'run_command'; id: string; params: Record<string, unknown>; rawParams: Record<string, unknown>; content: string; result: null; mcpServerName: undefined; batchId?: string; batchOrdinal?: number };
};
type TestToolCallResult = { awaitingUserApproval?: boolean; interrupted?: boolean; receiptCancelled?: boolean; failure?: string; validatedParams?: Record<string, unknown> };
interface ChatLifecycleTestAdapter {
	_runChatAgent(this: unknown, options: TestRunChatOptions & { parentRun: TestParentRun }): Promise<void>;
	_runToolCall(this: unknown, threadId: string, toolName: string, toolId: string, mcpServerName: string | undefined, options: { preapproved: true; unvalidatedToolParams: Record<string, unknown>; validatedParams: Record<string, unknown> }, snapshot: ReturnType<typeof instructionSnapshot>, authority: undefined, skillReadAllowed: boolean, generation: number, isActive: () => boolean, batchRef?: { batchId: string; batchOrdinal: number }): Promise<TestToolCallResult>;
	_wrapRunAgentToNotify(this: unknown, promise: Promise<void>, threadId: string, parentRun: TestParentRun): Promise<void>;
	_revokeAgentDelegation(this: unknown, threadId: string, forget?: boolean): void;
	abortRunning(this: unknown, threadId: string): Promise<void>;
	cancelToolReceipt(this: unknown, threadId: string, receiptId: string, toolId: string): boolean;
	_runParentSafeReadWave(this: unknown, threadId: string, calls: readonly { id: string; name: string; rawParams: Record<string, unknown>; ordinal: number }[], batchId: string, snapshot: ReturnType<typeof instructionSnapshot>, authority: undefined, generation: number, isCurrent: () => boolean): Promise<readonly TestToolCallResult[]>;
	_runNativeBatchRange(this: unknown, threadId: string, calls: readonly { id: string; name: string; rawParams: Record<string, unknown>; ordinal: number }[], batchId: string, snapshot: ReturnType<typeof instructionSnapshot>, authority: undefined, skillReadAllowed: boolean, generation: number, isCurrent: () => boolean, accountFailure: (call: { id: string; name: string; rawParams: Record<string, unknown>; ordinal: number }, server: undefined, outcome: TestToolCallResult, batchRef: { batchId: string; batchOrdinal: number }) => boolean): Promise<TestToolCallResult>;
}
const chatLifecycle = ChatThreadService.prototype as unknown as ChatLifecycleTestAdapter;
let nextTestParentRunId = 0;

const llmInfoOf = (stream: TestStream | undefined): TestLLMInfo => {
	if (!stream?.llmInfo) throw new Error('Expected an LLM stream fixture.');
	return stream.llmInfo;
};

const beginTestParentRun = (receiver: ParentRunFixture, threadId: string): TestParentRun => {
	const token = Symbol('test-parent-run');
	const runId = `test-parent-${++nextTestParentRunId}`;
	const generation = receiver._agentControlGeneration.get(threadId) ?? 0;
	let active = true;
	receiver._parentRunTokenOfThread.set(threadId, token);
	const isLatest = () => receiver._parentRunTokenOfThread.get(threadId) === token && (receiver._agentControlGeneration.get(threadId) ?? 0) === generation;
	return { token, runId, generation, isLatest, isActive: () => active && isLatest(), deactivate: () => { active = false; }, releaseLatest: () => { if (isLatest()) receiver._parentRunTokenOfThread.delete(threadId); } };
};

const standaloneParentRun = (isLatest: () => boolean): TestParentRun => ({ token: Symbol('standalone-parent-run'), runId: 'standalone-parent-run', generation: 0, isLatest, isActive: isLatest, deactivate() { }, releaseLatest() { } });

const prepareRunChatAgentReceiver = (receiver: ParentRunFixture) => {
	const fixture = receiver as unknown as Record<string, any>;
	fixture._pendingChatInputsOfThread ??= new Map();
	fixture._pendingInputBrokerReady ??= Promise.resolve(true);
	fixture._pendingNamespaceMutation ??= false;
	fixture._deletingPendingInputThreads ??= new Set();
	fixture._workspaceContextService ??= { getWorkspace: () => ({ folders: [] }) };
	fixture._workspaceTrustManagementService ??= { isWorkspaceTrusted: () => true };
	fixture._notificationService ??= { notify() { } };
	fixture._onDidChangePendingChatInputs ??= { fire() { } };
	fixture._pendingInputBrokerTestSeam ??= {
		initializeNamespace: async () => ({ ok: true, snapshot: { namespace: { profileId: 'test', workspaceIdentity: 'test' }, revision: 0, records: [] }, value: { sessionId: 'test', removeLegacy: false } }),
		claimSteerAtBoundary: async () => ({ ok: true, snapshot: { namespace: { profileId: 'test', workspaceIdentity: 'test' }, revision: 0, records: [] }, value: undefined }),
		validateHistoryRun: async () => ({ ok: true, snapshot: { namespace: { profileId: 'test', workspaceIdentity: 'test' }, revision: 0, records: [] }, value: undefined }),
		holdApproval: async () => ({ ok: true, snapshot: { namespace: { profileId: 'test', workspaceIdentity: 'test' }, revision: 0, records: [] }, value: undefined }),
		closeRunAndReleaseSteers: async () => ({ ok: true, snapshot: { namespace: { profileId: 'test', workspaceIdentity: 'test' }, revision: 0, records: [] }, value: undefined }),
		reconcileDeliveredPendingInputIds: async () => ({ ok: true, snapshot: { namespace: { profileId: 'test', workspaceIdentity: 'test' }, revision: 0, records: [] }, value: undefined }),
	};
	fixture._pendingBroker ??= () => fixture._pendingInputBrokerTestSeam;
	fixture._promoteSteerAtSafeBoundary ??= async () => false;
	fixture._awaitThreadStorageWrites ??= async () => true;
	fixture._agentSubagentService ??= {};
	fixture._agentSubagentService.peekParentMailbox ??= () => ({ events: Object.freeze([]), parentMessageSequences: Object.freeze([]), completionSequences: Object.freeze([]) });
	fixture._agentSubagentService.ackParentMailbox ??= () => true;
	fixture._agentSubagentService.hasPendingRequired ??= () => false;
	fixture._agentSubagentService.waitForRequired ??= async () => { };
	fixture._appendAgentMailboxEvents ??= (...args: any[]) => (ChatThreadService.prototype as any)._appendAgentMailboxEvents.apply(fixture, args);
	fixture._wakeAgentWaitForPendingSteer ??= () => false;
	fixture._warnPendingMutation ??= () => false;
	return fixture;
};

const runChatAgent = (receiver: ParentRunFixture, options: TestRunChatOptions) => {
	prepareRunChatAgentReceiver(receiver);
	const parentRun = beginTestParentRun(receiver, options.threadId);
	return chatLifecycle._runChatAgent.call(receiver, { ...options, parentRun });
};

const deferred = <T>() => {
	let resolve: (value: T) => void = () => { throw new Error('deferred resolve was not initialized'); };
	let reject: (error: Error) => void = () => { throw new Error('deferred reject was not initialized'); };
	const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
	return { promise, resolve, reject };
};

const flushMicrotasks = async (): Promise<void> => {
	await Promise.resolve();
	await Promise.resolve();
};

class LifecycleBrokerStorage implements PendingChatInputBrokerStorage {
	readonly whenReady = Promise.resolve();
	readonly values = new Map<string, string>();
	flushes = 0;
	failFlushes = 0;
	failMutationCommitFlushes = 0;
	failUserStores = 0;
	get(key: string) { return this.values.get(key); }
	store(key: string, value: string) { this.values.set(key, value); }
	storeUser(key: string, value: string) { if (this.failUserStores > 0) { this.failUserStores--; throw new Error('fixture user store failed'); } this.values.set(key, value); }
	storeAll(entries: readonly Readonly<{ key: string; value: string }>[]) { for (const entry of entries) this.values.set(entry.key, entry.value); }
	remove(key: string) { this.values.delete(key); }
	removeUser(key: string) { this.values.delete(key); }
	keys(_target: 'machine' | 'user') { return [...this.values.keys()]; }
	async flush() { this.flushes++; if (this.failFlushes-- > 0) throw new Error('fixture flush failed'); if (this.failMutationCommitFlushes > 0 && [...this.values.keys()].some(key => key.startsWith('void.pendingChatInputBrokerV2.chatMutation.'))) { this.failMutationCommitFlushes--; throw new Error('fixture mutation commit flush failed'); } }
}

const lifecycleNamespace: PendingChatInputNamespace = Object.freeze({ profileId: 'profile', workspaceIdentity: 'workspace' });
const lifecycleThread = (id = 'task') => ({
	id,
	createdAt: '2026-01-01T00:00:00.000Z',
	lastModified: '2026-01-01T00:00:00.000Z',
	messages: [] as any[],
	childActivities: EMPTY_CHILD_ACTIVITIES,
	state: { stagingSelections: [] as any[], focusedMessageIdx: undefined, linksOfMessageIdx: {} },
	filesWithUserChanges: new Set<string>(),
});

const successfulSnapshotResult = <T>(snapshot: PendingChatInputSnapshot, value: T): PendingChatInputMutationResult<T> => Object.freeze({ ok: true, snapshot, value });

const createLifecycleBrokerClient = ({ core, ctx, apply }: { core: PendingChatInputBrokerCore; ctx: string; apply: (snapshot: PendingChatInputSnapshot) => void }) => {
	let sessionId: string | undefined;
	let snapshot: PendingChatInputSnapshot | undefined;
	const accept = <T>(result: PendingChatInputMutationResult<T>): PendingChatInputMutationResult<T> => { if (result.snapshot) { snapshot = result.snapshot; apply(result.snapshot); } return result; };
	core.onDidChange(changed => { if (changed.namespace.profileId === lifecycleNamespace.profileId && changed.namespace.workspaceIdentity === lifecycleNamespace.workspaceIdentity) { snapshot = changed; apply(changed); } });
	const sid = () => { if (!sessionId) throw new Error('lifecycle_broker_not_initialized'); return sessionId; };
	const client: any = {
		namespace: lifecycleNamespace,
		get snapshot() { return snapshot; },
		onDidChange: () => ({ dispose() { } }),
		onDidChangeChildGroup: core.onDidChangeChildGroup,
		async initializeNamespace(request: any) {
			if (sessionId && snapshot) return successfulSnapshotResult(snapshot, { sessionId, removeLegacy: false });
			const result = await core.initializeNamespace(ctx, { ...request, namespace: lifecycleNamespace });
			if (result.ok) sessionId = result.value.sessionId;
			return accept(result);
		},
		submit: async (request: any) => accept(await core.submit(ctx, { ...request, sessionId: sid() })),
		syncActiveChildGroup: async (threadId: string, sourceRunId: string, sourceGeneration: number, sourceRevision: number, generation: number | undefined, childIds: readonly string[]) => accept(await core.syncActiveChildGroup(ctx, sid(), threadId, sourceRunId, sourceGeneration, sourceRevision, generation, childIds)),
		edit: async (threadId: string, id: string, fingerprint: string, text: string, selections?: readonly any[]) => accept(await core.edit(ctx, sid(), threadId, id, fingerprint, text, selections)),
		delete: async (threadId: string, id: string, fingerprint: string) => accept(await core.delete(ctx, sid(), threadId, id, fingerprint)),
		reorder: async (threadId: string, id: string, fingerprint: string, threadFingerprint: string, beforeId?: string) => accept(await core.reorder(ctx, sid(), threadId, id, fingerprint, threadFingerprint, beforeId)),
		resume: async (threadId: string, id: string, fingerprint: string, authority: any) => accept(await core.resume(ctx, sid(), threadId, id, fingerprint, authority)),
		suspend: async (threadId: string, id: string, fingerprint: string) => accept(await core.suspend(ctx, sid(), threadId, id, fingerprint)),
		claimNextQueued: async (threadId: string, authority: any, deliveredIds: readonly string[]) => accept(await core.claimNextQueued(ctx, sid(), threadId, authority, deliveredIds)),
		claimSteerAtBoundary: async (threadId: string, runId: string, generation: number, authority: any, deliveredIds: readonly string[]) => accept(await core.claimSteerAtBoundary(ctx, sid(), threadId, runId, generation, authority, deliveredIds)),
		authorizeAppend: async (threadId: string, id: string, claimId: string, fingerprint: string, authority: any, runId: string, generation: number) => accept(await core.authorizeAppend(ctx, sid(), threadId, id, claimId, fingerprint, authority, runId, generation)),
		authorizeDirectHistoryAppend: async (threadId: string, text: string, selections: readonly any[], runId: string, generation: number) => accept(await core.authorizeDirectHistoryAppend(ctx, sid(), threadId, text, selections, runId, generation)),
		verifyDirectHistoryAndRelease: async (threadId: string, leaseId: string) => accept(await core.verifyDirectHistoryAndRelease(ctx, sid(), threadId, leaseId)),
		abandonDirectHistoryAppend: async (threadId: string, leaseId: string) => accept(await core.abandonDirectHistoryAppend(ctx, sid(), threadId, leaseId)),
		inspectAppendHistory: async (threadId: string, id: string, claimId: string, leaseId?: string) => accept(await core.inspectAppendHistory(ctx, sid(), threadId, id, claimId, leaseId)),
		verifyHistoryAndSettle: async (threadId: string, id: string, claimId: string, leaseId: string) => accept(await core.verifyHistoryAndSettle(ctx, sid(), threadId, id, claimId, leaseId)),
		settleClaim: async (threadId: string, id: string, claimId: string, leaseId: string | undefined, result: 'queued' | 'dormant') => accept(await core.settleClaim(ctx, sid(), threadId, id, claimId, leaseId, result)),
		validateHistoryRun: async (threadId: string, runId: string, generation: number) => accept(await core.validateHistoryRun(ctx, sid(), threadId, runId, generation)),
		holdApproval: async (threadId: string, runId: string, generation: number, approval: any) => accept(await core.holdApproval(ctx, sid(), threadId, runId, generation, approval)),
		closeRunAndReleaseSteers: async (threadId: string, runId: string, generation: number, authority: any, retainApproval = false, childGroup?: any) => accept(await core.closeRunAndReleaseSteers(ctx, sid(), threadId, runId, generation, authority, retainApproval, childGroup)),
		reconcileDeliveredPendingInputIds: async (delivered: any) => accept(await core.reconcileDeliveredPendingInputIds(ctx, sid(), delivered)),
		commitThreadRecord: async (threadId: string, expectedRaw: string | undefined, nextRaw: string) => accept(await core.commitThreadRecord(ctx, sid(), threadId, expectedRaw, nextRaw)),
		authorizeThreadAnchor: async (threadId: string) => accept(await core.authorizeThreadAnchor(ctx, sid(), threadId)),
		verifyThreadAnchorAndRelease: async (threadId: string, leaseId: string) => accept(await core.verifyThreadAnchorAndRelease(ctx, sid(), threadId, leaseId)),
		abandonThreadAnchor: async (threadId: string, leaseId: string) => accept(await core.abandonThreadAnchor(ctx, sid(), threadId, leaseId)),
		deleteThreadRecords: async (threadId: string, evidence: any) => accept(await core.deleteThreadRecords(ctx, sid(), threadId, evidence)),
		finalizeThreadDeletion: async (threadId: string, leaseId: string) => accept(await core.finalizeThreadDeletion(ctx, sid(), threadId, leaseId)),
		abortThreadDeletion: async (threadId: string, leaseId: string) => accept(await core.abortThreadDeletion(ctx, sid(), threadId, leaseId)),
		clearNamespace: async (evidence: any) => accept(await core.clearNamespace(ctx, sid(), evidence)),
		finalizeNamespaceClear: async (leaseId: string) => accept(await core.finalizeNamespaceClear(ctx, sid(), leaseId)),
		abortNamespaceClear: async (leaseId: string) => accept(await core.abortNamespaceClear(ctx, sid(), leaseId)),
		async release() { if (!sessionId) return; await core.releaseConnection(ctx); sessionId = undefined; },
	};
	return client;
};

const eventually = async (condition: () => boolean, message: string): Promise<void> => {
	for (let index = 0; index < 100; index++) { if (condition()) return; await new Promise<void>(resolve => setTimeout(resolve, 0)); }
	throw new Error(message);
};

const createPendingInboxReceiver = (options?: {
	storage?: LifecycleBrokerStorage;
	core?: PendingChatInputBrokerCore;
	ctx?: string;
	thread?: ReturnType<typeof lifecycleThread>;
	blank?: boolean;
	owner?: string | undefined;
	trusted?: boolean;
	instructionGate?: Promise<void>;
	providerGate?: Promise<void>;
}) => {
	const storage = options?.storage ?? new LifecycleBrokerStorage();
	let generated = 0;
	const core = options?.core ?? new PendingChatInputBrokerCore(storage, () => 100, () => `lifecycle-${++generated}`);
	const context = { owner: options?.owner ?? 'file:///workspace', trusted: options?.trusted ?? true };
	const thread = options?.thread ?? lifecycleThread();
	const key = pendingChatInputThreadStorageKey(thread.id);
	if (!options?.blank && !storage.get(key)) storage.storeUser(key, JSON.stringify({ version: 1, revision: 1, thread }));
	const warnings: string[] = [];
	const pendingEvents: string[] = [];
	let providerStarts = 0;
	const turnConfig = projectAgentConfig(
		{ developerInstructions: 'pending lifecycle fixture' },
		undefined,
		[{ uri: 'file:///home/.codex/config.toml', scope: 'user', status: 'loaded', projectedKeys: ['developer_instructions'] }],
		context.owner,
		context.owner,
	);
	const candidates = [{ uri: `${context.owner}/AGENTS.md`, outcome: Object.freeze({ status: 'bytes' as const, bytes: bytes('agents') }) }];
	const instructionTurn = resolveAgentInstructions(turnConfig, candidates, stableAgentInstructionRevision(turnConfig, candidates));
	let receiver: any;
	const client = createLifecycleBrokerClient({ core, ctx: options?.ctx ?? 'window:1', apply: snapshot => {
		if (receiver) (ChatThreadService.prototype as any)._applyPendingChatInputSnapshot.call(receiver, snapshot.records);
	} });
	receiver = {
		state: { allThreads: { [thread.id]: thread }, currentThreadId: thread.id },
		streamState: {},
		_pendingInputBrokerTestSeam: client,
		_pendingInputBrokerReady: Promise.resolve(true),
		_pendingChatInputsOfThread: new Map(),
		_pendingDeliveredReconcileRequested: 0,
		_pendingDeliveredReconcileFlight: undefined,
		_pendingDeliveredReconcileRetry: undefined,
		_pendingNamespaceMutation: false,
		_pendingNamespaceFinalizeLeaseId: undefined,
		_drainingPendingChatInputs: new Set(),
		_runQuiescenceOfThread: new Map(),
		_startingParentRunOfThread: new Map(),
		_stopAndSendFlights: new Map(),
		_approvalActionFlights: new Set(),
		_deletingPendingInputThreads: new Set(),
		_pendingChatSubmissionOfThread: new Map(),
		_cancellingToolReceiptsOfThread: new Map(),
		_agentInstructionSessionOfThread: new Map(),
		_instructionTurnOfThread: new Map(),
		_transientComposerDraftOfThread: new Map(),
		_agentControlGeneration: new Map([[thread.id, 0]]),
		_childGroupSourceOfThread: new Map(),
		_childGroupSyncRevisionOfThread: new Map(),
		_childGroupSyncTailOfThread: new Map(),
		_agentDelegationAuthorityOfThread: new Map(),
		_parentRunTokenOfThread: new Map(),
		_deferredExternalThreadKey: new Map(),
		_threadStorageWriteTail: new Map(),
		_threadStorageAuthoritativeRaw: new Map(),
		_threadStorageWriteEpoch: new Map(),
		_externalPendingDeleteRetries: new Map(),
		_pendingThreadMutationRetries: new Map(),
		_localEmptyThreadId: options?.blank ? thread.id : 'not-the-fixture-thread',
		_workspaceContextService: { getWorkspace: () => ({ folders: context.owner ? [{ uri: URI.parse(context.owner) }] : [] }) },
		_workspaceTrustManagementService: { isWorkspaceTrusted: () => context.trusted },
		_storageService: {
			store(storageKey: string, value: string) { storage.storeUser(storageKey, value); },
			get(storageKey: string) { return storage.get(storageKey); },
			remove(storageKey: string) { storage.removeUser(storageKey); },
			keys() { return storage.keys('user'); },
			flush() { return storage.flush(); },
		},
		_settingsService: { state: { globalSettings: { chatMode: 'normal', autoApprove: {} }, overridesOfModel: { openAICompatible: { 'gpt-4.1': {} } } } },
		_currentModelSelectionProps: () => ({ modelSelection: { providerName: 'openAICompatible', modelName: 'gpt-4.1' }, modelSelectionOptions: {} }),
		_beginInstructionTurn: async () => { if (options?.instructionGate) await options.instructionGate; return instructionTurn; },
		_purgeInstructionTurn() { },
		_rememberInstructionTurn() { },
		_agentSkillsService: { getCatalog: async () => createSkillCatalog([]), readSkillBody: async () => ({}) },
		_directoryStringService: {},
		_fileService: {},
		_mcpService: { getMCPTools: () => [] },
		_llmMessageService: { captureSettingsOfProvider: () => ({}), abort() { } },
		_notificationService: { notify(notification: { message: string }) { warnings.push(notification.message); } },
		toolErrMsgs: { rejected: 'Tool call was rejected by the user.', interrupted: 'Tool call was interrupted by the user.' },
		_toolsService: { invalidateReadReceipts() { } },
		_agentSubagentService: { getRunViews: () => [], wakeParentWait: () => false, cancelParent() { }, forgetParent() { } },
		_childToolApprovals: new Map(),
		_onDidChangeChildToolApprovals: { fire() { } },
		_onDidChangePendingChatSubmission: { fire() { } },
		_onDidChangePendingChatInputs: { fire(event: { threadId: string }) { pendingEvents.push(event.threadId); } },
		_onDidChangeCurrentThread: { fire() { } },
		_onDidChangeStreamState: { fire() { } },
		_scheduleDeliveredPendingReconcile() { },
		_setStreamState(threadId: string, value: unknown) { this.streamState[threadId] = value; },
		// `_updateLatestTool` is a constructor-installed arrow function in the real
		// service, so this prototype receiver needs the same exact latest-receipt
		// replacement seam for approval lifecycle tests.
		_updateLatestTool(threadId: string, tool: any) {
			const messages = this.state.allThreads[threadId]?.messages ?? [];
			for (let index = messages.length - 1; index >= 0; index--) {
				const message = messages[index];
				if (message.role === 'tool' && message.id === tool.id && message.batchId === tool.batchId && message.batchOrdinal === tool.batchOrdinal && (message.type === 'running_now' || message.type === 'tool_request')) {
					this._editMessageInThread(threadId, index, tool); return;
				}
			}
			this._addMessageToThread(threadId, tool);
		},
		_revokeAgentDelegation() { },
		_setState(partial: unknown) { this.state = { ...this.state, ...(partial as object) }; },
		_wrapRunAgentToNotify: (run: Promise<void>) => run,
		_runChatAgent: async () => { providerStarts++; if (options?.providerGate) await options.providerGate; },
	};
	Object.setPrototypeOf(receiver, ChatThreadService.prototype);
	const addUserMessageAndStreamResponse = (ChatThreadService.prototype as any)._addUserMessageAndStreamResponse;
	receiver._addUserMessageAndStreamResponse = async (...args: any[]) => {
		try { return await addUserMessageAndStreamResponse.call(receiver, ...args); }
		catch (error) { warnings.push(`delivery fixture error: ${error instanceof Error ? error.message : String(error)}`); throw error; }
	};
	return { receiver, client, core, context, storage, pendingEvents, warnings, get providerStarts() { return providerStarts; } };
};

/** Install the same main-owned history run boundary that a production user turn
 * acquires after its durable user row. Child-group close tests must not bypass
 * that ownership transition with a renderer-only quiescence fixture. */
const establishLifecycleHistoryRun = async (fixture: ReturnType<typeof createPendingInboxReceiver>, runId: string, generation: number): Promise<void> => {
	const direct = await fixture.client.authorizeDirectHistoryAppend('task', 'parent', [], runId, generation); assert.ok(direct.ok);
	const thread = { ...fixture.receiver.state.allThreads.task, messages: [{ role: 'user', pendingInputId: direct.value.pendingInputId, pendingInputSelectionsFingerprint: direct.value.selectionsFingerprint, content: 'parent', displayContent: 'parent', selections: [], state: {} }] };
	const raw = JSON.stringify({ version: 1, revision: 2, thread }); fixture.storage.storeUser(pendingChatInputThreadStorageKey('task'), raw); fixture.receiver._threadStorageAuthoritativeRaw.set('task', raw); fixture.receiver.state.allThreads.task = thread;
	assert.ok((await fixture.client.verifyDirectHistoryAndRelease('task', direct.value.leaseId)).ok);
};

suite('Assistant message lifecycle', () => {
	test('a delayed provider final from an aborted run cannot append into a newer LLM run', async () => {
		const snapshot = instructionSnapshot();
		const callbacks: TestProviderCallbacks[] = [];
		const messages: TestMessage[] = [];
		const streamState: TestStreamRecord = {};
		const receiver = {
			state: { allThreads: { task: { messages, state: {}, filesWithUserChanges: new Set<string>() } }, currentThreadId: 'task' },
			streamState,
			_agentControlGeneration: new Map([['task', 0]]),
			_parentRunTokenOfThread: new Map<string, symbol>(),
			_agentDelegationAuthorityOfThread: new Map(),
			_settingsService: { state: { globalSettings: { chatMode: 'agent' } } },
			_convertToLLMMessagesService: { prepareLLMChatMessages: async () => ({ messages: [], separateSystemMessage: false }) },
			_llmMessageService: { sendLLMMessage: (options: TestProviderCallbacks) => { callbacks.push(options); return `request-${callbacks.length}`; }, abort() { } },
			_mcpService: { getMCPTools: () => [] },
			_metricsService: { capture() { } },
			_setStreamState(threadId: string, value: TestStream | undefined) { streamState[threadId] = value; },
			_addMessageToThread(_threadId: string, message: TestMessage) { messages.push(message); },
		};
		const run = () => runChatAgent(receiver, { threadId: 'task', modelSelection: { providerName: 'openAICompatible', modelName: 'gpt-4.1' }, modelSelectionOptions: snapshot.model.modelSelectionOptions, instructionSnapshot: snapshot });
		const runA = run();
		await eventually(() => callbacks.length === 1, 'first provider send was not reached');
		receiver._agentControlGeneration.set('task', 1);
		const runB = run();
		await eventually(() => callbacks.length === 2, 'replacement provider send was not reached');
		callbacks[1].onText({ fullText: 'B partial', fullReasoning: 'B reasoning', toolCalls: undefined });
		assert.strictEqual(llmInfoOf(streamState.task).displayContentSoFar, 'B partial');
		callbacks[0].onText({ fullText: 'A stale partial', fullReasoning: 'A reasoning', toolCalls: undefined });
		await callbacks[0].onFinalMessage({ fullText: 'A stale result', fullReasoning: '', anthropicReasoning: null });
		await runA;
		assert.deepStrictEqual(llmInfoOf(streamState.task), { displayContentSoFar: 'B partial', reasoningSoFar: 'B reasoning', toolCallSoFar: null, toolCallsSoFar: [] });
		assert.strictEqual(messages.length, 0);
		await callbacks[1].onFinalMessage({ fullText: 'B result', fullReasoning: '', anthropicReasoning: null });
		await runB;
		assert.deepStrictEqual(messages.map(message => message.displayContent), ['B result']);
	});

	test('rebuilds provider context when durable history changes during async conversion', async () => {
		const conversionGate = deferred<void>();
		const messages: any[] = [{ role: 'user', displayContent: 'original', content: 'original' }];
		let raw = 'thread-revision-1'; let conversions = 0; let sends = 0; let sentMessages: any[] | undefined;
		const receiver: any = {
			state: { allThreads: { task: { messages, state: {}, filesWithUserChanges: new Set<string>() } }, currentThreadId: 'task' },
			streamState: {}, _agentControlGeneration: new Map([['task', 0]]), _parentRunTokenOfThread: new Map(), _agentDelegationAuthorityOfThread: new Map(),
			_settingsService: { state: { globalSettings: { chatMode: 'agent' } } },
			_currentThreadStorageRaw: () => raw,
			_convertToLLMMessagesService: { prepareLLMChatMessages: async ({ chatMessages }: any) => {
				conversions++;
				const projected = chatMessages.map((message: any) => ({ role: message.role, content: message.displayContent ?? message.content }));
				if (conversions === 1) await conversionGate.promise;
				return { messages: projected, separateSystemMessage: false };
			} },
			_llmMessageService: { sendLLMMessage: (options: any) => { sends++; sentMessages = options.messages; queueMicrotask(() => void options.onFinalMessage({ fullText: 'done', fullReasoning: '', anthropicReasoning: null })); return 'request'; }, abort() { } },
			_mcpService: { getMCPTools: () => [] }, _metricsService: { capture() { } },
			_setStreamState(threadId: string, value: any) { this.streamState[threadId] = value; },
			_addMessageToThread(_threadId: string, message: any) { messages.push(message); },
		};
		const run = runChatAgent(receiver, { threadId: 'task', modelSelection: { providerName: 'openAICompatible', modelName: 'gpt-4.1' }, modelSelectionOptions: {}, instructionSnapshot: instructionSnapshot() });
		await eventually(() => conversions === 1, 'conversion did not start');
		messages.push({ role: 'user', displayContent: 'new durable turn', content: 'new durable turn' }); raw = 'thread-revision-2'; conversionGate.resolve(undefined);
		await run;
		assert.strictEqual(conversions, 2); assert.strictEqual(sends, 1);
		assert.deepStrictEqual(sentMessages?.map(message => message.content), ['original', 'new durable turn']);
	});

	test('holds native tool side effects behind the durable provider declaration', async () => {
		for (const conflict of [false, true]) {
			const declarationGate = deferred<void>(); const messages: any[] = []; let waits = 0; let sends = 0; let toolRuns = 0;
			const receiver: any = {
				state: { allThreads: { task: { messages, state: {}, filesWithUserChanges: new Set<string>() } }, currentThreadId: 'task' },
				streamState: {}, _agentControlGeneration: new Map([['task', 0]]), _parentRunTokenOfThread: new Map(), _agentDelegationAuthorityOfThread: new Map(),
				_settingsService: { state: { globalSettings: { chatMode: 'agent' } } },
				_convertToLLMMessagesService: { prepareLLMChatMessages: async () => ({ messages: [], separateSystemMessage: false }) },
				_awaitThreadStorageWrites: async () => { waits++; if (waits === 3) { await declarationGate.promise; return !conflict; } return true; },
				_llmMessageService: { sendLLMMessage: (options: any) => { const send = ++sends; queueMicrotask(() => void options.onFinalMessage(send === 1 ? { fullText: '', fullReasoning: '', toolCalls: [{ name: 'run_command', id: `tool-${conflict}`, rawParams: { command: 'echo test', terminalId: 'terminal' } }], anthropicReasoning: null } : { fullText: 'done', fullReasoning: '', anthropicReasoning: null })); return `request-${send}`; }, abort() { } },
				_mcpService: { getMCPTools: () => [] }, _metricsService: { capture() { } },
				_setStreamState(threadId: string, value: any) { this.streamState[threadId] = value; }, _addMessageToThread(_threadId: string, message: any) { messages.push(message); },
				_runToolCall: async () => { toolRuns++; return {}; },
			};
			const run = runChatAgent(receiver, { threadId: 'task', modelSelection: { providerName: 'openAICompatible', modelName: 'gpt-4.1' }, modelSelectionOptions: {}, instructionSnapshot: instructionSnapshot() });
			await eventually(() => waits === 3, 'declaration durability wait was not reached'); assert.strictEqual(toolRuns, 0);
			declarationGate.resolve(undefined); await run;
			assert.strictEqual(toolRuns, conflict ? 0 : 1); assert.strictEqual(sends, conflict ? 1 : 2);
		}
	});

	test('a same-generation approval continuation owns a new parent-run token', async () => {
		const snapshot = instructionSnapshot(); const callbacks: TestProviderCallbacks[] = []; const messages: any[] = []; const streamState: TestStreamRecord = {}; const firstTool = deferred<void>(); const executionOrder: string[] = [];
		const receiver = {
			state: { allThreads: { task: { messages, state: {}, filesWithUserChanges: new Set<string>() } }, currentThreadId: 'task' }, streamState,
			_agentControlGeneration: new Map([['task', 4]]), _parentRunTokenOfThread: new Map<string, symbol>(), _agentDelegationAuthorityOfThread: new Map(),
			_settingsService: { state: { globalSettings: { chatMode: 'agent' } } }, _convertToLLMMessagesService: { prepareLLMChatMessages: async () => ({ messages: [], separateSystemMessage: false }) },
			_llmMessageService: { sendLLMMessage: (options: TestProviderCallbacks) => { callbacks.push(options); return `request-${callbacks.length}`; }, abort() { } }, _mcpService: { getMCPTools: () => [] }, _metricsService: { capture() { } },
			_setStreamState(threadId: string, value: TestStream | undefined) { streamState[threadId] = value; }, _addMessageToThread(_threadId: string, message: TestMessage) { messages.push(message); },
			_runToolCall: async (_threadId: string, _name: string, id: string, _mcp: unknown, _options: unknown, _snapshot: unknown, _authority: unknown, _skill: boolean, _generation: number, _current: () => boolean, batchRef: { batchId: string; batchOrdinal: number }) => { executionOrder.push(id); if (id === 'batch-a') await firstTool.promise; messages.push({ role: 'tool', type: 'success', id, name: 'read_file', params: {}, rawParams: {}, content: id, result: id, ...batchRef }); return { interrupted: false }; },
		};
		const run = () => runChatAgent(receiver, { threadId: 'task', modelSelection: { providerName: 'openAICompatible', modelName: 'gpt-4.1' }, modelSelectionOptions: snapshot.model.modelSelectionOptions, instructionSnapshot: snapshot });
		const runA = run(); await eventually(() => callbacks.length === 1, 'first provider send was not reached'); const runB = run(); await eventually(() => callbacks.length === 2, 'continuation provider send was not reached');
		callbacks[1].onText({ fullText: 'continuation partial', fullReasoning: '', toolCalls: undefined }); callbacks[0].onText({ fullText: 'stale A', fullReasoning: '', toolCalls: undefined });
		await callbacks[0].onFinalMessage({ fullText: 'stale A', fullReasoning: '', anthropicReasoning: null }); await runA;
		assert.strictEqual(llmInfoOf(streamState.task).displayContentSoFar, 'continuation partial'); assert.strictEqual(messages.length, 0);
		const final = callbacks[1].onFinalMessage({ fullText: 'continuation complete', fullReasoning: '', toolCalls: [{ name: 'run_command', id: 'batch-a', rawParams: {} }, { name: 'run_command', id: 'batch-b', rawParams: {} }], anthropicReasoning: null });
		await flushMicrotasks(); await flushMicrotasks(); assert.deepStrictEqual(executionOrder, ['batch-a']); assert.strictEqual(callbacks.length, 2);
		firstTool.resolve(); await final; await eventually(() => callbacks.length === 3, 'post-batch provider continuation was not reached'); assert.deepStrictEqual(executionOrder, ['batch-a', 'batch-b']);
		await callbacks[2].onFinalMessage({ fullText: 'continuation after batch', fullReasoning: '', anthropicReasoning: null }); await runB;
		const declaration = messages.find(message => message.role === 'assistant' && message.toolBatch);
		assert.deepStrictEqual({ calls: declaration.toolBatch.calls.map((call: any) => call.id), rows: messages.filter(message => message.role === 'tool').map(message => [message.id, message.batchId === declaration.toolBatch.batchId, message.batchOrdinal]) }, { calls: ['batch-a', 'batch-b'], rows: [['batch-a', true, 0], ['batch-b', true, 1]] });
	});

	test('a stale preapproved-tool continuation cannot clear its replacement run', async () => {
		const snapshot = instructionSnapshot(); const callbacks: TestProviderCallbacks[] = []; const streamState: TestStreamRecord = {}; let toolEntered = false; let releaseTool: () => void = () => { throw new Error('tool was not entered'); };
		const receiver = {
			state: { allThreads: { task: { messages: [], state: {}, filesWithUserChanges: new Set<string>() } }, currentThreadId: 'task' }, streamState,
			_agentControlGeneration: new Map([['task', 4]]), _parentRunTokenOfThread: new Map<string, symbol>(), _agentDelegationAuthorityOfThread: new Map(),
			_settingsService: { state: { globalSettings: { chatMode: 'agent' } } }, _convertToLLMMessagesService: { prepareLLMChatMessages: async () => ({ messages: [], separateSystemMessage: false }) },
			_llmMessageService: { sendLLMMessage: (options: TestProviderCallbacks) => { callbacks.push(options); return `request-${callbacks.length}`; }, abort() { } }, _mcpService: { getMCPTools: () => [] }, _metricsService: { capture() { } },
			_runToolCall: async () => { toolEntered = true; await new Promise<void>(resolve => releaseTool = resolve); return { interrupted: false }; }, _setStreamState(threadId: string, value: TestStream | undefined) { streamState[threadId] = value; }, _addMessageToThread() { },
		};
		const runA = runChatAgent(receiver, { threadId: 'task', modelSelection: { providerName: 'openAICompatible', modelName: 'gpt-4.1' }, modelSelectionOptions: snapshot.model.modelSelectionOptions, instructionSnapshot: snapshot, callThisToolFirst: { role: 'tool', type: 'tool_request', name: 'read_file', id: 'tool-a', params: {}, rawParams: {}, content: '', result: null, mcpServerName: undefined } });
		await eventually(() => toolEntered, 'preapproved tool was not entered'); const runB = runChatAgent(receiver, { threadId: 'task', modelSelection: { providerName: 'openAICompatible', modelName: 'gpt-4.1' }, modelSelectionOptions: snapshot.model.modelSelectionOptions, instructionSnapshot: snapshot });
		await eventually(() => callbacks.length === 1, 'replacement provider send was not reached'); callbacks[0].onText({ fullText: 'B partial', fullReasoning: '', toolCalls: undefined }); releaseTool(); await runA;
		assert.strictEqual(llmInfoOf(streamState.task).displayContentSoFar, 'B partial'); await callbacks[0].onFinalMessage({ fullText: 'B final', fullReasoning: '', anthropicReasoning: null }); await runB;
	});

	test('a restored pending approval resumes with the default generation when no map entry exists', async () => {
		const snapshot = instructionSnapshot(); const messages: TestMessage[] = []; const streamState: TestStreamRecord = {}; let toolRuns = 0;
		const receiver = { state: { allThreads: { task: { messages, state: {}, filesWithUserChanges: new Set<string>() } }, currentThreadId: 'task' }, streamState, _agentControlGeneration: new Map<string, number>(), _parentRunTokenOfThread: new Map<string, symbol>(), _agentDelegationAuthorityOfThread: new Map(), _settingsService: { state: { globalSettings: { chatMode: 'agent' } } }, _convertToLLMMessagesService: { prepareLLMChatMessages: async () => ({ messages: [], separateSystemMessage: false }) }, _runToolCall: async () => { toolRuns++; return { interrupted: false }; }, _llmMessageService: { sendLLMMessage: (options: TestProviderCallbacks) => { queueMicrotask(() => void options.onFinalMessage({ fullText: 'resumed', fullReasoning: '', anthropicReasoning: null })); return 'resumed-request'; }, abort() { } }, _mcpService: { getMCPTools: () => [] }, _metricsService: { capture() { } }, _setStreamState(threadId: string, value: TestStream | undefined) { streamState[threadId] = value; }, _addMessageToThread(_threadId: string, message: TestMessage) { messages.push(message); } };
		await runChatAgent(receiver, { threadId: 'task', modelSelection: { providerName: 'openAICompatible', modelName: 'gpt-4.1' }, modelSelectionOptions: snapshot.model.modelSelectionOptions, instructionSnapshot: snapshot, callThisToolFirst: { role: 'tool', type: 'tool_request', name: 'read_file', id: 'restored-tool', params: {}, rawParams: {}, content: '', result: null, mcpServerName: undefined } });
		assert.strictEqual(toolRuns, 1); assert.deepStrictEqual(messages.map(message => message.displayContent), ['resumed']);
	});

	test('a stale generic MCP settlement cannot mutate replacement history or stream', async () => {
		for (const settlement of ['resolve', 'reject'] as const) {
			const pendingMCP = deferred<{ result: { ok: boolean } }>();
			const mutations: TestToolMutation[] = [];
			const replacement = { isRunning: 'LLM', llmInfo: { displayContentSoFar: `B-${settlement}`, reasoningSoFar: 'B', toolCallSoFar: null }, interrupt: Promise.resolve(() => { }) };
			const streamState: TestStreamRecord = {};
			let current = true;
			let stringifyCalls = 0;
			const receiver = {
				state: { allThreads: { task: { messages: [], state: {}, filesWithUserChanges: new Set<string>() } } },
				streamState,
				_mcpService: { getMCPTools: () => [{ name: 'deferred_mcp', mcpServerName: 'fixture' }], callMCPTool: () => pendingMCP.promise, stringifyResult: () => { stringifyCalls++; return 'late-success'; } },
				_updateLatestTool(_threadId: string, message: TestToolMutation) { mutations.push(message); },
				_setStreamState(threadId: string, value: TestStream | undefined) { streamState[threadId] = value; },
			};
			Object.setPrototypeOf(receiver, ChatThreadService.prototype);
			const run = chatLifecycle._runToolCall.call(receiver, 'task', 'deferred_mcp', `tool-${settlement}`, 'fixture', { preapproved: true, unvalidatedToolParams: {}, validatedParams: {} }, instructionSnapshot(), undefined, false, 0, () => current);
			await Promise.resolve();
			assert.strictEqual(mutations.length, 1);
			current = false;
			streamState.task = replacement;
			if (settlement === 'resolve') pendingMCP.resolve({ result: { ok: true } });
			else pendingMCP.reject(new Error('late MCP rejection'));
			assert.deepStrictEqual(await run, { interrupted: true });
			assert.strictEqual(mutations.length, 1);
			assert.strictEqual(mutations.some(message => message.type === 'success' || message.type === 'tool_error'), false);
			assert.strictEqual(stringifyCalls, 0);
			assert.strictEqual(streamState.task, replacement);
		}
	});

	test('built-in setup cancellation settles before deferred prepare or call handles and preserves a newer run', async () => {
		for (const setupKind of ['prepare-write', 'call-handle'] as const) {
			const setup = deferred<TestBuiltinSetup>();
			const mutations: TestToolMutation[] = [];
			const streamState: TestStreamRecord = {};
			let executeCalls = 0;
			let interruptCalls = 0;
			const receiver = {
				state: { allThreads: { task: { messages: [], state: {}, filesWithUserChanges: new Set<string>() } } },
				streamState,
				_parentRunTokenOfThread: new Map<string, symbol>(),
				_agentControlGeneration: new Map([['task', 0]]),
				_agentDelegationAuthorityOfThread: new Map(),
				_childToolApprovals: new Map(),
				_onDidChangeChildToolApprovals: { fire() { } },
				_agentSubagentService: { cancelParent() { }, forgetParent() { } },
				_toolsService: {
					invalidateReadReceipts(_threadId: string) { },
					prepareWriteFile: () => setup.promise,
					callTool: { run_command: () => setup.promise },
					stringOfResult: { run_command: () => { throw new Error('stale result was stringified'); } },
				},
				_mcpService: { getMCPTools: () => [] },
				toolErrMsgs: { interrupted: 'Tool call was interrupted by the user.' },
				_updateLatestTool(_threadId: string, message: TestToolMutation) { mutations.push(message); },
				_setStreamState(threadId: string, value: TestStream | undefined) { streamState[threadId] = value; },
			};
			Object.setPrototypeOf(receiver, ChatThreadService.prototype);
			const parentRun = beginTestParentRun(receiver, 'task');
			const toolName = setupKind === 'prepare-write' ? 'write_file' : 'run_command';
			const run = chatLifecycle._runToolCall.call(receiver, 'task', toolName, `tool-${setupKind}`, undefined, { preapproved: true, unvalidatedToolParams: {}, validatedParams: {} }, instructionSnapshot(), undefined, false, parentRun.generation, parentRun.isActive);
			await Promise.resolve();
			assert.strictEqual(streamState.task?.isRunning, 'tool');
			const abort = chatLifecycle.abortRunning.call(receiver, 'task');
			const abortSettled = await Promise.race([abort.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 1_000))]);
			assert.strictEqual(abortSettled, true);
			const replacementRun = beginTestParentRun(receiver, 'task');
			const replacement = { isRunning: 'LLM', llmInfo: { displayContentSoFar: `B-${setupKind}`, reasoningSoFar: 'B', toolCallSoFar: null }, interrupt: Promise.resolve(() => { }) };
			streamState.task = replacement;
			const mutationsAfterAbort = mutations.length;
			if (setupKind === 'prepare-write') setup.resolve({ execute: () => { executeCalls++; return Promise.resolve({}); } });
			else setup.resolve({ result: Promise.resolve({}), interruptTool: () => { interruptCalls++; } });
			assert.deepStrictEqual(await run, { interrupted: true });
			assert.strictEqual(executeCalls, 0);
			assert.strictEqual(interruptCalls, setupKind === 'call-handle' ? 1 : 0);
			assert.strictEqual(mutations.length, mutationsAfterAbort);
			assert.strictEqual(streamState.task, replacement);
			assert.strictEqual(replacementRun.isActive(), true);
			replacementRun.deactivate(); replacementRun.releaseLatest();
		}
	});

	test('run completion notifications preserve current effects and suppress stale effects', async () => {
		const invalidations: string[] = [];
		const notifications: TestNotification[] = [];
		const receiver = {
			state: { allThreads: { task: { messages: [{ role: 'user', displayContent: 'fixture request' }] } }, currentThreadId: 'other' },
			streamState: {},
			_agentControlGeneration: new Map([['task', 0]]),
			_parentRunTokenOfThread: new Map<string, symbol>(),
			_agentDelegationAuthorityOfThread: new Map(),
			_childToolApprovals: new Map(),
			_onDidChangeChildToolApprovals: { fire() { } },
			_agentSubagentService: { cancelParent() { }, forgetParent() { } },
			_toolsService: { invalidateReadReceipts: (threadId: string) => invalidations.push(threadId) },
			_notificationService: { notify: (notification: TestNotification) => notifications.push(notification) },
		};
		Object.setPrototypeOf(receiver, ChatThreadService.prototype);
		const wrap = (promise: Promise<void>, isLatest: () => boolean) => chatLifecycle._wrapRunAgentToNotify.call(receiver, promise, 'task', standaloneParentRun(isLatest));
		const sameGenerationA = beginTestParentRun(receiver, 'task'); const sameGenerationPending = deferred<void>(); const staleSameGeneration = chatLifecycle._wrapRunAgentToNotify.call(receiver, sameGenerationPending.promise, 'task', sameGenerationA); const sameGenerationB = beginTestParentRun(receiver, 'task'); sameGenerationPending.resolve(undefined); await staleSameGeneration; assert.strictEqual(invalidations.length, 0); assert.strictEqual(notifications.length, 0); sameGenerationB.deactivate(); sameGenerationB.releaseLatest();
		for (const settlement of ['resolve', 'reject'] as const) {
			const pending = deferred<void>(); const oldRun = beginTestParentRun(receiver, 'task'); const wrapped = chatLifecycle._wrapRunAgentToNotify.call(receiver, pending.promise, 'task', oldRun);
			chatLifecycle._revokeAgentDelegation.call(receiver, 'task'); assert.strictEqual(invalidations.length, 1); const replacement = beginTestParentRun(receiver, 'task');
			if (settlement === 'resolve') pending.resolve(undefined); else pending.reject(new Error('stale revoked failure'));
			await wrapped; assert.strictEqual(invalidations.length, 1); assert.strictEqual(notifications.length, 0); replacement.deactivate(); replacement.releaseLatest(); invalidations.length = 0;
		}
		for (const settlement of ['resolve', 'reject'] as const) {
			const pending = deferred<void>(); let current = true; const wrapped = wrap(pending.promise, () => current); current = false;
			if (settlement === 'resolve') pending.resolve(undefined); else pending.reject(new Error('stale failure'));
			await wrapped;
		}
		assert.strictEqual(invalidations.length, 0); assert.strictEqual(notifications.length, 0);
		await wrap(Promise.resolve(), () => true);
		assert.deepStrictEqual(invalidations, ['task']); assert.strictEqual(notifications.length, 1); assert.strictEqual(notifications[0].severity, Severity.Info); assert.strictEqual(notifications[0].message, 'A new Chat result is ready.');
		await assert.rejects(wrap(Promise.reject(new Error('current failure')), () => true), /current failure/);
		assert.deepStrictEqual(invalidations, ['task', 'task']); assert.strictEqual(notifications.length, 2); assert.strictEqual(notifications[1].severity, Severity.Warning); assert.ok(notifications[1].message.includes('current failure'));
	});

	test('a completed provider attempt ignores every late or duplicate callback without changing current effects', async () => {
		const snapshot = instructionSnapshot(); const callbacks: TestProviderCallbacks[] = []; const messages: TestMessage[] = [{ role: 'user', content: 'fixture request', displayContent: 'fixture request' }]; const streamState: TestStreamRecord = {}; const metrics: string[] = []; const invalidations: string[] = []; const notifications: TestNotification[] = [];
		const receiver = {
			state: { allThreads: { task: { messages, childActivities: { version: 1, records: [{ generation: 1, childId: 'ledger-child', depth: 1, status: 'completed', capabilityProfile: 'read_only', summary: 'RAW_CHILD_LEDGER_SENTINEL', queuedMs: 0, runningMs: 1, totalMs: 1, anchor: { toolId: 'ledger-tool' } }], omitted: 0, retentionSaturated: false }, state: {}, filesWithUserChanges: new Set<string>() } }, currentThreadId: 'other' }, streamState,
			_agentControlGeneration: new Map([['task', 0]]), _parentRunTokenOfThread: new Map<string, symbol>(), _agentDelegationAuthorityOfThread: new Map(),
			_settingsService: { state: { globalSettings: { chatMode: 'agent' } } }, _convertToLLMMessagesService: { prepareLLMChatMessages: async ({ chatMessages }: any) => { assert.strictEqual(chatMessages, messages); assert.strictEqual(JSON.stringify(chatMessages).includes('RAW_CHILD_LEDGER_SENTINEL'), false); return { messages: [], separateSystemMessage: false }; } },
			_llmMessageService: { sendLLMMessage: (options: TestProviderCallbacks) => { callbacks.push(options); return 'current-request'; }, abort() { } }, _mcpService: { getMCPTools: () => [] },
			_metricsService: { capture: (name: string) => metrics.push(name) }, _toolsService: { invalidateReadReceipts: (threadId: string) => invalidations.push(threadId) }, _notificationService: { notify: (notification: TestNotification) => notifications.push(notification) },
			_setStreamState(threadId: string, value: TestStream | undefined) { streamState[threadId] = value; }, _addMessageToThread(_threadId: string, message: TestMessage) { messages.push(message); },
		};
		prepareRunChatAgentReceiver(receiver); const parentRun = beginTestParentRun(receiver, 'task');
		const running = chatLifecycle._runChatAgent.call(receiver, { threadId: 'task', modelSelection: { providerName: 'openAICompatible', modelName: 'gpt-4.1' }, modelSelectionOptions: snapshot.model.modelSelectionOptions, instructionSnapshot: snapshot, parentRun });
		const wrapped = chatLifecycle._wrapRunAgentToNotify.call(receiver, running, 'task', parentRun);
		await eventually(() => callbacks.length === 1, 'provider send was not reached'); callbacks[0].onText({ fullText: 'current partial', fullReasoning: 'current reasoning', toolCalls: undefined }); await callbacks[0].onFinalMessage({ fullText: 'current final', fullReasoning: 'current reasoning', anthropicReasoning: null }); await wrapped;
		const finalStream = streamState.task; const finalHistory = JSON.stringify(messages); const finalMetrics = [...metrics];
		callbacks[0].onText({ fullText: 'late text', fullReasoning: 'late reasoning', toolCalls: undefined }); await callbacks[0].onFinalMessage({ fullText: 'duplicate final', fullReasoning: '', anthropicReasoning: null }); await callbacks[0].onError({ message: 'duplicate error', fullError: null }); callbacks[0].onAbort(); await Promise.resolve();
		assert.strictEqual(streamState.task, finalStream); assert.strictEqual(JSON.stringify(messages), finalHistory); assert.deepStrictEqual(metrics, finalMetrics); assert.deepStrictEqual(metrics, ['Agent Loop Done']); assert.deepStrictEqual(invalidations, ['task']); assert.strictEqual(notifications.length, 1); assert.strictEqual(notifications[0].severity, Severity.Info); assert.strictEqual(receiver._parentRunTokenOfThread.has('task'), false);
	});

	test('request conversion through deterministic local echo never stores or renders the internal empty sentinel', async () => {
		const snapshot = instructionSnapshot();
		const thread: any = {
			id: 'task',
			createdAt: '2026-08-18T00:00:00.000Z',
			lastModified: '2026-08-18T00:00:00.000Z',
			messages: [
				{ role: 'user', content: 'inspect the file', displayContent: 'inspect the file' },
				{ role: 'assistant', displayContent: '', reasoning: 'reasoning before the tool', anthropicReasoning: null },
				{ role: 'tool', type: 'success', name: 'fixture_tool', params: { value: 'alpha' }, content: 'alpha', id: 'tool-1', rawParams: { value: 'alpha' }, result: 'alpha', mcpServerName: 'fixture-server' },
			],
			state: {},
			filesWithUserChanges: new Set<string>(),
		};
		const converter = new ConvertToLLMMessageService(
			{ getModels: () => [] } as never,
			{ getWorkspace: () => ({ folders: [] }) } as never,
			{ activeEditor: undefined } as never,
			{ getAllDirectoriesStr: async () => '' } as never,
			{ listPersistentTerminalIds: () => [] } as never,
			{ state: { overridesOfModel: { openAICompatible: { 'gpt-4.1': { specialToolFormat: 'openai-style' } } }, globalSettings: {}, optionsOfModelSelection: { Chat: { openAICompatible: { 'gpt-4.1': { reasoningEnabled: true } } } } } } as never,
			{ getMCPTools: () => [] } as never,
		);
		(converter as any)._generateChatMessagesSystemMessage = async () => 'local fixture system';

		let requestContent: unknown;
		let echoedFullText: unknown;
		let serializedThreads = '';
		const streamDisplays: string[] = [];
		const streamState: Record<string, any> = {};
		const receiver: any = {
			state: { allThreads: { task: thread }, currentThreadId: 'task' },
			streamState,
			_agentControlGeneration: new Map([['task', 0]]),
			_parentRunTokenOfThread: new Map<string, symbol>(),
			_agentDelegationAuthorityOfThread: new Map(),
			_settingsService: { state: { globalSettings: { chatMode: 'agent' } } },
			_convertToLLMMessagesService: converter,
			_llmMessageService: {
				sendLLMMessage: (options: any) => {
					const toolAssistant = options.messages.find((message: any) => message.role === 'assistant' && message.tool_calls?.length === 1);
					requestContent = toolAssistant?.content;
					echoedFullText = requestContent;
					queueMicrotask(() => {
						options.onText({ fullText: echoedFullText, fullReasoning: 'local provider reasoning', toolCalls: undefined });
						void options.onFinalMessage({ fullText: echoedFullText, fullReasoning: 'local provider reasoning', anthropicReasoning: null });
					});
					return 'local-echo-request';
				},
				abort() { },
			},
			_mcpService: { getMCPTools: () => [] },
			_metricsService: { capture() { } },
			_setStreamState(threadId: string, value: any) { streamState[threadId] = value; if (value?.llmInfo) streamDisplays.push(value.llmInfo.displayContentSoFar); },
			_storageService: { get() { return undefined; }, keys() { return []; }, store(key: string, value: string) { assert.strictEqual(key, `${THREAD_STORAGE_RECORD_PREFIX}task`); serializedThreads = value; } },
			_isUnmaterializedEmptyThread() { return false; },
			_threadStorageKey: (ChatThreadService.prototype as any)._threadStorageKey, _readThreadEnvelope: (ChatThreadService.prototype as any)._readThreadEnvelope, _storeThreadRecord: (ChatThreadService.prototype as any)._storeThreadRecord,
			_queueThreadStorageWrite(_threadId: string, nextThread: any) {
				const nextRaw = JSON.stringify({ version: 1, revision: 1, thread: nextThread });
				this._storageService.store(`${THREAD_STORAGE_RECORD_PREFIX}task`, nextRaw);
				return Promise.resolve(true);
			},
			_storeAllThreads(threads: any) { return (ChatThreadService.prototype as any)._storeAllThreads.call(this, threads); },
			_setState(value: any) { this.state = { ...this.state, ...value }; },
			_addMessageToThread(threadId: string, message: any) {
				return (ChatThreadService.prototype as any)._addMessageToThread.call(this, threadId, message);
			},
		};

		await runChatAgent(receiver, {
			threadId: 'task',
			modelSelection: { providerName: 'openAICompatible', modelName: 'gpt-4.1' },
			modelSelectionOptions: snapshot.model.modelSelectionOptions,
			instructionSnapshot: snapshot,
		});

		const stored = receiver.state.allThreads.task.messages.at(-1);
		assert.strictEqual(stored.role, 'assistant');
		const persisted = JSON.parse(serializedThreads).thread.messages.at(-1);
		const presentation = assistantMessagePresentation(stored);
		assert.deepStrictEqual({
			requestContent,
			echoedFullText,
			storedDisplayContent: stored.displayContent,
			persistedDisplayContent: persisted.displayContent,
			visibleDisplay: presentation.renderDisplay,
			reasoning: presentation.renderReasoning,
		}, {
			requestContent: '',
			echoedFullText: '',
			storedDisplayContent: '',
			persistedDisplayContent: '',
			visibleDisplay: '',
			reasoning: 'local provider reasoning',
		});
		assert.strictEqual(presentation.isEmpty, false);
		assert.strictEqual(presentation.hasReasoning, true);
		assert.deepStrictEqual(streamDisplays, ['', '']);
	});

	test('native OpenAI and OpenAI-Compatible preserve dialect-native empty tool-call content', async () => {
		const converter = new ConvertToLLMMessageService(
			{ getModels: () => [] } as never,
			{ getWorkspace: () => ({ folders: [] }) } as never,
			{ activeEditor: undefined } as never,
			{ getAllDirectoriesStr: async () => '' } as never,
			{ listPersistentTerminalIds: () => [] } as never,
			{ state: { overridesOfModel: {}, globalSettings: {}, optionsOfModelSelection: { Chat: { openAI: {}, openAICompatible: {} } } } } as never,
			{ getMCPTools: () => [] } as never,
		);
		(converter as any)._generateChatMessagesSystemMessage = async () => 'matrix system';
		const history: any[] = [
			{ role: 'user', content: 'use a tool', displayContent: 'use a tool' },
			{ role: 'assistant', displayContent: '', reasoning: 'reasoning before tool', anthropicReasoning: null, toolBatch: { version: 1, batchId: 'native-batch', calls: [{ id: 'tool-1', name: 'fixture_tool', rawParams: { value: 'alpha' } }, { id: 'tool-2', name: 'fixture_tool', rawParams: { value: 'beta' } }] } },
			{ role: 'tool', type: 'success', name: 'fixture_tool', params: { value: 'alpha' }, content: 'alpha', id: 'tool-1', rawParams: { value: 'alpha' }, result: 'alpha', mcpServerName: 'fixture-server', batchId: 'native-batch', batchOrdinal: 0 },
			{ role: 'tool', type: 'success', name: 'fixture_tool', params: { value: 'beta' }, content: 'beta', id: 'tool-2', rawParams: { value: 'beta' }, result: 'beta', mcpServerName: 'fixture-server', batchId: 'native-batch', batchOrdinal: 1 },
		];
		for (const providerName of ['openAI', 'openAICompatible'] as const) {
			const result = await converter.prepareLLMChatMessages({ chatMessages: history, chatMode: 'agent', modelSelection: { providerName, modelName: 'gpt-4.1' }, instructionSnapshot: instructionSnapshot() as never });
			const assistant: any = result.messages.find((message: any) => message.role === 'assistant');
			assert.strictEqual(assistant.content, '');
			assert.deepStrictEqual(assistant.tool_calls, [{ type: 'function', id: 'tool-1', function: { name: 'fixture_tool', arguments: '{"value":"alpha"}' } }, { type: 'function', id: 'tool-2', function: { name: 'fixture_tool', arguments: '{"value":"beta"}' } }]);
			assert.deepStrictEqual(result.messages.filter((message: any) => message.role === 'tool').map((message: any) => message.tool_call_id), ['tool-1', 'tool-2']);
			for (const internal of ['toolBatch', 'batchId', 'batchOrdinal', 'native-batch']) assert.strictEqual(JSON.stringify(result.messages).includes(internal), false);
			assert.strictEqual(JSON.stringify(result.messages).includes(INTERNAL_EMPTY_MESSAGE_SENTINEL), false);
		}
		await assert.rejects(() => converter.prepareLLMChatMessages({ chatMessages: history.slice(0, -1), chatMode: 'agent', modelSelection: { providerName: 'openAI', modelName: 'gpt-4.1' }, instructionSnapshot: instructionSnapshot() as never }), /native_tool_batch_unclosed/);
		const skipped = [...history.slice(0, 2), { role: 'tool', type: 'success', name: 'fixture_tool', params: { value: 'alpha' }, content: 'alpha', id: 'tool-1', rawParams: { value: 'alpha' }, result: 'alpha', mcpServerName: 'fixture-server', batchId: 'native-batch', batchOrdinal: 0 }, { role: 'tool', type: 'skipped', name: 'fixture_tool', content: 'cancelled before start', id: 'tool-2', rawParams: { value: 'beta' }, result: null, mcpServerName: 'fixture-server', batchId: 'native-batch', batchOrdinal: 1 }];
		const skippedResult = await converter.prepareLLMChatMessages({ chatMessages: skipped, chatMode: 'agent', modelSelection: { providerName: 'openAI', modelName: 'gpt-4.1' }, instructionSnapshot: instructionSnapshot() as never }); assert.deepStrictEqual(skippedResult.messages.filter((message: any) => message.role === 'tool').map((message: any) => message.tool_call_id), ['tool-1', 'tool-2']);
		const resourceBatch: any[] = [
			{ role: 'user', content: 'admit a resource', displayContent: 'admit a resource' },
			{ role: 'assistant', displayContent: '', reasoning: '', anthropicReasoning: null, toolBatch: { version: 1, batchId: 'resource-batch', calls: [{ id: 'resource-0', name: 'read_skill_resource', rawParams: { skill: 'demo', resource_path: 'guide.md' } }, { id: 'later-1', name: 'fixture_tool', rawParams: { value: 'later' } }] } },
			{ role: 'tool', type: 'success', name: 'read_skill_resource', params: { skill: 'demo', resourcePath: 'guide.md' }, content: 'resource body', id: 'resource-0', rawParams: { resource_path: 'guide.md', skill: 'demo' }, result: 'resource body', mcpServerName: undefined, batchId: 'resource-batch', batchOrdinal: 0 },
		];
		const prospectiveResource = closeNativeToolBatchForProspectiveAdmission(resourceBatch, { batchId: 'resource-batch', batchOrdinal: 0 });
		assert.deepStrictEqual(prospectiveResource.filter(message => message.role === 'tool').map((message: any) => [message.id, message.type, Object.prototype.hasOwnProperty.call(message, 'params')]), [['resource-0', 'success', true], ['later-1', 'skipped', false]]);
		assert.strictEqual(resourceBatch.length, 3, 'prospective closure must not mutate live history');
		const prospectiveResult = await converter.prepareLLMChatMessages({ chatMessages: prospectiveResource, chatMode: 'agent', modelSelection: { providerName: 'openAI', modelName: 'gpt-4.1' }, instructionSnapshot: instructionSnapshot() as never });
		assert.deepStrictEqual(prospectiveResult.messages.filter((message: any) => message.role === 'tool').map((message: any) => message.tool_call_id), ['resource-0', 'later-1']);
		for (const corrupt of [
			[history[0], { ...history[1], toolBatch: { ...history[1].toolBatch, version: 2 } }, ...history.slice(2)],
			[history[0], { ...history[1], toolBatch: { ...history[1].toolBatch, calls: [{ ...history[1].toolBatch.calls[0] }, { ...history[1].toolBatch.calls[0] }] } }, ...history.slice(2)],
			[history[0], history[1], history[2], { ...history[3], batchOrdinal: 0 }],
			[history[0], history[1], history[2], { ...history[3], name: 'other_tool' }],
			[history[0], history[1], history[2], { ...history[3], rawParams: { value: 'different' } }],
			[history[0], { ...history[1], toolBatch: { ...history[1].toolBatch, calls: [{ ...history[1].toolBatch.calls[0], rawParams: { value: Number.POSITIVE_INFINITY } }, history[1].toolBatch.calls[1]] } }, ...history.slice(2)],
			[history[0], history[1], { ...history[2], batchId: undefined }, history[3]],
			[history[0], history[1], history[2], { role: 'user', content: 'interleaved', displayContent: 'interleaved' }, history[3]],
			[...history, { ...history[2], batchId: 'orphan', batchOrdinal: 0 }],
			[...history, { ...history[1], displayContent: 'reused', toolBatch: { ...history[1].toolBatch, calls: [{ id: 'tool-3', name: 'fixture_tool', rawParams: { value: 'gamma' } }] } }, { ...history[2], id: 'tool-3', batchOrdinal: 0 }],
		]) await assert.rejects(() => converter.prepareLLMChatMessages({ chatMessages: corrupt as any, chatMode: 'agent', modelSelection: { providerName: 'openAI', modelName: 'gpt-4.1' }, instructionSnapshot: instructionSnapshot() as never }), /native_tool_batch_(invalid_declaration|unclosed)/);
		const sparseCalls: any[] = [{ id: 'tool-1', name: 'fixture_tool', rawParams: { value: 'alpha' } }]; sparseCalls.length = 2;
		for (const malformedBatch of [
			null, 7, { version: 1, batchId: 'native-batch', calls: null }, { version: 1, batchId: 'native-batch', calls: {} }, { version: 1, batchId: 'native-batch', calls: 'not-an-array' },
			{ version: 1, batchId: 'native-batch', calls: [null] }, { version: 1, batchId: 'native-batch', calls: [3] }, { version: 1, batchId: 'native-batch', calls: ['call'] }, { version: 1, batchId: 'native-batch', calls: sparseCalls },
			{ version: 1, batchId: 3, calls: [{ id: 'tool-1', name: 'fixture_tool', rawParams: { value: 'alpha' } }] }, { version: 1, batchId: 'native-batch', calls: [{ id: 3, name: 'fixture_tool', rawParams: { value: 'alpha' } }] }, { version: 1, batchId: 'native-batch', calls: [{ id: 'tool-1', name: 3, rawParams: { value: 'alpha' } }] },
			{ version: 1, batchId: 'native-batch', calls: [{ id: 'tool-1', name: 'fixture_tool', rawParams: null }] },
		]) {
			await assert.rejects(() => converter.prepareLLMChatMessages({ chatMessages: [history[0], { ...history[1], toolBatch: malformedBatch }, ...history.slice(2)] as any, chatMode: 'agent', modelSelection: { providerName: 'openAI', modelName: 'gpt-4.1' }, instructionSnapshot: instructionSnapshot() as never }), /native_tool_batch_(invalid_declaration|unclosed)/, 'malformed persisted batch must use a deterministic contract error');
		}
	});

	test('Anthropic, Gemini, and XML retain tool-only native blocks without fake text', async () => {
		const converter = new ConvertToLLMMessageService(
			{ getModels: () => [] } as never,
			{ getWorkspace: () => ({ folders: [] }) } as never,
			{ activeEditor: undefined } as never,
			{ getAllDirectoriesStr: async () => '' } as never,
			{ listPersistentTerminalIds: () => [] } as never,
			{ state: { overridesOfModel: {}, globalSettings: {}, optionsOfModelSelection: { Chat: { anthropic: {}, gemini: {}, openAICompatible: {} } } } } as never,
			{ getMCPTools: () => [] } as never,
		);
		(converter as any)._generateChatMessagesSystemMessage = async () => 'matrix system';
		const history: any[] = [
			{ role: 'user', content: 'use a tool', displayContent: 'use a tool' },
			{ role: 'assistant', displayContent: '', reasoning: 'reasoning before tool', anthropicReasoning: null, toolBatch: { version: 1, batchId: 'native-batch', calls: [{ id: 'tool-1', name: 'fixture_tool', rawParams: { value: 'alpha' } }, { id: 'tool-2', name: 'fixture_tool', rawParams: { value: 'beta' } }] } },
			{ role: 'tool', type: 'success', name: 'fixture_tool', params: { value: 'alpha' }, content: 'alpha', id: 'tool-1', rawParams: { value: 'alpha' }, result: 'alpha', mcpServerName: 'fixture-server', batchId: 'native-batch', batchOrdinal: 0 },
			{ role: 'tool', type: 'success', name: 'fixture_tool', params: { value: 'beta' }, content: 'beta', id: 'tool-2', rawParams: { value: 'beta' }, result: 'beta', mcpServerName: 'fixture-server', batchId: 'native-batch', batchOrdinal: 1 },
		];
		const anthropic = await converter.prepareLLMChatMessages({ chatMessages: history, chatMode: 'agent', modelSelection: { providerName: 'anthropic', modelName: 'claude-sonnet-4-0' }, instructionSnapshot: instructionSnapshot() as never });
		const anthropicAssistant: any = anthropic.messages.find((message: any) => message.role === 'assistant');
		assert.deepStrictEqual(anthropicAssistant.content, [{ type: 'tool_use', id: 'tool-1', name: 'fixture_tool', input: { value: 'alpha' } }, { type: 'tool_use', id: 'tool-2', name: 'fixture_tool', input: { value: 'beta' } }]);
		const anthropicResults: any = anthropic.messages.filter((message: any) => message.role === 'user').at(-1);
		assert.deepStrictEqual(anthropicResults?.content, [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'alpha' }, { type: 'tool_result', tool_use_id: 'tool-2', content: 'beta' }]);

		const gemini = await converter.prepareLLMChatMessages({ chatMessages: history, chatMode: 'agent', modelSelection: { providerName: 'gemini', modelName: 'gemini-2.0-flash' }, instructionSnapshot: instructionSnapshot() as never });
		const geminiAssistant: any = gemini.messages.find((message: any) => message.role === 'model');
		assert.deepStrictEqual(geminiAssistant.parts, [{ functionCall: { id: 'tool-1', name: 'fixture_tool', args: { value: 'alpha' } } }, { functionCall: { id: 'tool-2', name: 'fixture_tool', args: { value: 'beta' } } }]);
		const geminiResults: any = gemini.messages.filter((message: any) => message.role === 'user').at(-1);
		assert.deepStrictEqual(geminiResults?.parts, [{ functionResponse: { id: 'tool-1', name: 'fixture_tool', response: { output: 'alpha' } } }, { functionResponse: { id: 'tool-2', name: 'fixture_tool', response: { output: 'beta' } } }]);

		const xml = await converter.prepareLLMChatMessages({ chatMessages: history, chatMode: 'agent', modelSelection: { providerName: 'openAICompatible', modelName: 'fixture-xml-model' }, instructionSnapshot: instructionSnapshot() as never });
		const xmlAssistant: any = xml.messages.find((message: any) => message.role === 'assistant');
		assert.strictEqual(typeof xmlAssistant.content, 'string');
		assert.strictEqual((xmlAssistant.content.match(/<fixture_tool>/g) ?? []).length, 1);
		assert.strictEqual(/<value>alpha<\/value>/.test(xmlAssistant.content), true);
		for (const result of [anthropic, gemini, xml]) {
			assert.strictEqual(JSON.stringify(result.messages).includes(INTERNAL_EMPTY_MESSAGE_SENTINEL), false);
			for (const internal of ['toolBatch', 'batchId', 'batchOrdinal', 'native-batch']) assert.strictEqual(JSON.stringify(result.messages).includes(internal), false);
		}
	});

	test('serializes attributed agent events as assistant-side provider context', async () => {
		const converter = new ConvertToLLMMessageService(
			{ getModels: () => [] } as never, { getWorkspace: () => ({ folders: [] }) } as never, { activeEditor: undefined } as never, { getAllDirectoriesStr: async () => '' } as never, { listPersistentTerminalIds: () => [] } as never,
			{ state: { overridesOfModel: { openAICompatible: { 'fixture-xml-model': { specialToolFormat: 'openai-style' } } }, globalSettings: {}, optionsOfModelSelection: { Chat: { anthropic: {}, gemini: {}, openAICompatible: {} } } } } as never, { getMCPTools: () => [] } as never,
		);
		(converter as any)._generateChatMessagesSystemMessage = async () => 'agent event system';
		const body = 'ATTRIBUTED_CHILD_RESULT'; const history: any[] = [{ role: 'user', content: 'start', displayContent: 'start' }, { role: 'agent', sourceId: 'child-1', kind: 'completion', sequence: 3, status: 'completed', content: body, createdAt: 1 }];
		const results = [
			await converter.prepareLLMChatMessages({ chatMessages: history, chatMode: 'agent', modelSelection: { providerName: 'anthropic', modelName: 'claude-sonnet-4-0' }, instructionSnapshot: instructionSnapshot() as never }),
			await converter.prepareLLMChatMessages({ chatMessages: history, chatMode: 'agent', modelSelection: { providerName: 'gemini', modelName: 'gemini-2.0-flash' }, instructionSnapshot: instructionSnapshot() as never }),
			await converter.prepareLLMChatMessages({ chatMessages: history, chatMode: 'agent', modelSelection: { providerName: 'openAICompatible', modelName: 'fixture-xml-model' }, instructionSnapshot: instructionSnapshot() as never }),
		];
		for (const result of results) {
			const wire = JSON.stringify(result.messages); assert.strictEqual(wire.includes(body), true); assert.strictEqual(result.messages.some((message: any) => message.role === 'user' && JSON.stringify(message).includes(body)), false); assert.strictEqual(wire.includes('child-1'), true); assert.strictEqual(wire.includes('completion'), true);
		}
	});

	test('general reasoning-only history stays empty across every provider dialect', async () => {
		const converter = new ConvertToLLMMessageService(
			{ getModels: () => [] } as never,
			{ getWorkspace: () => ({ folders: [] }) } as never,
			{ activeEditor: undefined } as never,
			{ getAllDirectoriesStr: async () => '' } as never,
			{ listPersistentTerminalIds: () => [] } as never,
			{ state: { overridesOfModel: {}, globalSettings: {}, optionsOfModelSelection: { Chat: { openAI: {}, openAICompatible: {}, anthropic: {}, gemini: {} } } } } as never,
			{ getMCPTools: () => [] } as never,
		);
		(converter as any)._generateChatMessagesSystemMessage = async () => 'matrix system';
		const history: any[] = [
			{ role: 'user', pendingInputId: 'provider-invisible-pending-provenance', content: 'first', displayContent: 'first' },
			{ role: 'assistant', displayContent: '', reasoning: 'kept in the UI', anthropicReasoning: null },
			{ role: 'user', content: 'continue', displayContent: 'continue' },
		];
		const routes = [
			{ providerName: 'openAI', modelName: 'gpt-4.1' },
			{ providerName: 'openAICompatible', modelName: 'gpt-4.1' },
			{ providerName: 'anthropic', modelName: 'claude-sonnet-4-0' },
			{ providerName: 'gemini', modelName: 'gemini-2.0-flash' },
			{ providerName: 'openAICompatible', modelName: 'fixture-xml-model' },
		] as const;
		for (const modelSelection of routes) {
			const result = await converter.prepareLLMChatMessages({ chatMessages: history, chatMode: 'agent', modelSelection, instructionSnapshot: instructionSnapshot() as never });
			const serialized = JSON.stringify(result.messages);
			assert.strictEqual(serialized.includes(INTERNAL_EMPTY_MESSAGE_SENTINEL), false);
			assert.strictEqual(serialized.includes('pendingInputId'), false);
			assert.strictEqual(serialized.includes('provider-invisible-pending-provenance'), false);
			assert.strictEqual(result.messages.some((message: any) => message.role === 'assistant' || message.role === 'model'), false);
		}
		const presentation = assistantMessagePresentation({ displayContent: '', reasoning: 'kept in the UI' });
		assert.deepStrictEqual({ display: presentation.renderDisplay, reasoning: presentation.renderReasoning, empty: presentation.isEmpty }, { display: '', reasoning: 'kept in the UI', empty: false });
	});

	test('stream, abort, storage migration, and presentation fence only the exact legacy sentinel', async () => {
		for (let length = 0; length <= INTERNAL_EMPTY_MESSAGE_SENTINEL.length; length++) {
			assert.strictEqual(sanitizeAssistantDisplayContent(INTERNAL_EMPTY_MESSAGE_SENTINEL.slice(0, length), true), '');
		}
		for (const legitimate of [`before ${INTERNAL_EMPTY_MESSAGE_SENTINEL}`, `${INTERNAL_EMPTY_MESSAGE_SENTINEL} after`, '(empty messenger)']) {
			assert.strictEqual(sanitizeAssistantDisplayContent(legitimate, true), legitimate);
			assert.strictEqual(assistantMessagePresentation({ displayContent: legitimate, reasoning: '' }).renderDisplay, legitimate);
		}

		let serializedThreads = '';
		const thread: any = { id: 'task', messages: [{ role: 'user', pendingInputId: 'persisted-pending-provenance', content: 'queued content', displayContent: 'queued content', selections: [], state: {} }], state: {}, filesWithUserChanges: new Set<string>() };
		const receiver: any = {
			state: { allThreads: { task: thread }, currentThreadId: 'task' },
			streamState: { task: { isRunning: 'LLM', llmInfo: { displayContentSoFar: INTERNAL_EMPTY_MESSAGE_SENTINEL, reasoningSoFar: 'abort reasoning', toolCallSoFar: null }, interrupt: Promise.resolve(() => { }) } },
			_revokeAgentDelegation() { },
			_storageService: { get() { return undefined; }, keys() { return []; }, store(_key: string, value: string) { serializedThreads = value; } },
			_isUnmaterializedEmptyThread() { return false; },
			_queueThreadStorageWrite(_id: string, nextThread: unknown) { serializedThreads = JSON.stringify({ version: 1, revision: 1, thread: nextThread }); return Promise.resolve(true); },
			_threadStorageKey: (ChatThreadService.prototype as any)._threadStorageKey, _readThreadEnvelope: (ChatThreadService.prototype as any)._readThreadEnvelope, _storeThreadRecord: (ChatThreadService.prototype as any)._storeThreadRecord,
			_storeAllThreads(threads: any) { return (ChatThreadService.prototype as any)._storeAllThreads.call(this, threads); },
			_setState(value: any) { this.state = { ...this.state, ...value }; },
			_setStreamState(threadId: string, value: any) { this.streamState[threadId] = value; },
			_addMessageToThread(threadId: string, message: any) { return (ChatThreadService.prototype as any)._addMessageToThread.call(this, threadId, message); },
		};
		await ChatThreadService.prototype.abortRunning.call(receiver, 'task');
		const aborted = receiver.state.allThreads.task.messages.at(-1);
		assert.deepStrictEqual({ display: aborted.displayContent, reasoning: aborted.reasoning, visible: assistantMessagePresentation(aborted).renderDisplay }, { display: '', reasoning: 'abort reasoning', visible: '' });
			assert.strictEqual(JSON.parse(serializedThreads).thread.messages.at(-1).displayContent, '');
			assert.strictEqual(JSON.parse(serializedThreads).thread.messages[0].pendingInputId, 'persisted-pending-provenance');
			const restoredWithProvenance = (ChatThreadService.prototype as any)._convertThreadDataFromStorage.call({}, JSON.stringify({ task: JSON.parse(serializedThreads).thread }));
		assert.strictEqual(restoredWithProvenance.task.messages[0].pendingInputId, 'persisted-pending-provenance');

		const legacy = JSON.stringify({ task: { id: 'task', messages: [{ role: 'assistant', displayContent: INTERNAL_EMPTY_MESSAGE_SENTINEL, reasoning: 'legacy reasoning', anthropicReasoning: null }, { role: 'assistant', displayContent: `keep ${INTERNAL_EMPTY_MESSAGE_SENTINEL}`, reasoning: '', anthropicReasoning: null }], state: {} } });
		const migrated = (ChatThreadService.prototype as any)._convertThreadDataFromStorage.call({}, legacy);
		assert.deepStrictEqual(migrated.task.messages.map((message: any) => message.displayContent), ['', `keep ${INTERNAL_EMPTY_MESSAGE_SENTINEL}`]);
	});

	test('terminal cancellation latches before connection, creation, and send without leaks', async () => {
		const makeService = (connected: Promise<void>, create: () => Promise<any>) => {
			const service: any = new TerminalToolService({ whenConnected: connected, instances: [], onDidCreateInstance: () => ({ dispose() { } }) } as any, {} as any);
			service._createTerminal = create;
			return service;
		};
		const connection = deferred<void>(); let created = 0;
		const beforeConnection = makeService(connection.promise, async () => { created++; throw new Error('must not create after pre-connect cancellation'); });
		const early = await beforeConnection.runCommand('echo early', { type: 'temporary', cwd: null, terminalId: 'early' }); early.interrupt(); early.interrupt();
		assert.deepStrictEqual(await early.resPromise, { result: '', resolveReason: { type: 'cancelled' } }); assert.strictEqual(created, 0); connection.resolve();

		const createGate = deferred<any>(); const createEntered = deferred<void>(); let disposeCount = 0; let sendCount = 0;
		const lateCreate = makeService(Promise.resolve(), () => { createEntered.resolve(); return createGate.promise; });
		const createdCall = await lateCreate.runCommand('echo late', { type: 'temporary', cwd: null, terminalId: 'late' }); await createEntered.promise; createdCall.interrupt();
		let lateCreateSettled = false; void createdCall.resPromise.then(() => lateCreateSettled = true); await Promise.resolve(); assert.strictEqual(lateCreateSettled, false);
		createGate.resolve({ dispose: () => { disposeCount++; }, capabilities: { get: () => undefined, onDidAddCapability: () => ({ dispose() { } }) }, sendText: async () => { sendCount++; }, onData: () => ({ dispose() { } }) });
		assert.deepStrictEqual(await createdCall.resPromise, { result: '', resolveReason: { type: 'cancelled' } }); assert.strictEqual(disposeCount, 1); assert.strictEqual(sendCount, 0);

		const sendGate = deferred<void>(); const sendEntered = deferred<void>(); let listenerDisposals = 0; let sendDisposals = 0;
		const capability = { onCommandFinished: () => ({ dispose: () => { listenerDisposals++; } }) };
		const duringSend = makeService(Promise.resolve(), async () => ({ dispose: () => { sendDisposals++; }, capabilities: { get: () => capability, onDidAddCapability: () => ({ dispose() { } }) }, sendText: () => { sendEntered.resolve(); return sendGate.promise; }, onData: () => ({ dispose() { } }) }));
		const sending = await duringSend.runCommand('echo sending', { type: 'temporary', cwd: null, terminalId: 'sending' }); await sendEntered.promise; sending.interrupt(); sending.interrupt();
		assert.deepStrictEqual(await sending.resPromise, { result: '', resolveReason: { type: 'cancelled' } }); assert.strictEqual(listenerDisposals, 1); assert.strictEqual(sendDisposals, 1);

		let capabilityDisposals = 0; let capabilitySendCalls = 0; const capabilityEntered = deferred<void>();
		const waitingCapability = makeService(Promise.resolve(), async () => ({ dispose() { sendDisposals++; }, capabilities: { get: () => undefined, onDidAddCapability: () => { capabilityEntered.resolve(); return { dispose: () => { capabilityDisposals++; } }; } }, sendText: async () => { capabilitySendCalls++; }, onData: () => ({ dispose() { } }) }));
		const capabilityCall = await waitingCapability.runCommand('echo capability', { type: 'temporary', cwd: null, terminalId: 'capability' }); await capabilityEntered.promise; capabilityCall.interrupt();
		assert.deepStrictEqual(await capabilityCall.resPromise, { result: '', resolveReason: { type: 'cancelled' } }); assert.strictEqual(capabilityDisposals, 1); assert.strictEqual(capabilitySendCalls, 0);

		let persistentDisposals = 0; let finished: ((value: any) => void) | undefined;
		const persistent = makeService(Promise.resolve(), async () => { throw new Error('persistent must not create'); });
		persistent.terminalService.setActiveInstance = () => { }; persistent.terminalService.focusActiveInstance = async () => { };
		persistent.persistentTerminalInstanceOfId.p = { dispose: () => { persistentDisposals++; }, capabilities: { get: () => ({ onCommandFinished: (listener: any) => { finished = listener; return { dispose() { } }; } }), onDidAddCapability: () => ({ dispose() { } }) }, sendText: async () => { }, onData: () => ({ dispose() { } }) };
		const persistentCall = await persistent.runCommand('echo done', { type: 'persistent', persistentTerminalId: 'p' }); for (let i = 0; i < 4 && !finished; i++) await Promise.resolve(); finished!({ exitCode: 0, getOutput: () => 'done' });
		assert.strictEqual((await persistentCall.resPromise).resolveReason.type, 'done'); persistentCall.interrupt(); assert.strictEqual(persistentDisposals, 0);
	});

	test('a terminal nonzero exit produces one visible tool error and one model-facing result', async () => {
		const messages: any[] = [];
		const receiver: any = {
			state: { allThreads: { task: { messages, state: {}, filesWithUserChanges: new Set<string>() } } }, streamState: {},
			_toolsService: {
				callTool: { run_command: async () => ({ result: Promise.resolve({ result: 'stderr output', resolveReason: { type: 'done', exitCode: 7 } }), interruptTool: () => { } }) },
				stringOfResult: { run_command: () => { throw new Error('must not stringify a nonzero terminal result as success'); } },
			},
			_updateLatestTool(_threadId: string, message: any) { if (messages.length) messages[messages.length - 1] = message; else messages.push(message); },
			_editMessageInThread(_threadId: string, index: number, message: any) { messages[index] = message; },
			_setStreamState(threadId: string, value: any) { this.streamState[threadId] = value; },
		};
		Object.setPrototypeOf(receiver, ChatThreadService.prototype);
		const result = await chatLifecycle._runToolCall.call(receiver, 'task', 'run_command', 'terminal-7', undefined, { preapproved: true, unvalidatedToolParams: {}, validatedParams: {} }, instructionSnapshot(), undefined, false, 0, () => true);
		assert.strictEqual((result as any).failure, 'terminal_exit_7');
		assert.strictEqual(messages.length, 1);
		assert.deepStrictEqual({ type: messages[0].type, id: messages[0].id, result: messages[0].result }, { type: 'tool_error', id: 'terminal-7', result: 'stderr output\n(exit code 7)' });
	});

	test('same provider tool ids settle their own cancelled receipts across replacement runs', async () => {
		const first = deferred<any>(); const second = deferred<any>(); const messages: any[] = []; let call = 0; let current = true; let interrupts = 0;
		const receiver: any = {
			state: { allThreads: { task: { messages, state: {}, filesWithUserChanges: new Set<string>() } } }, streamState: {},
			_cancellingToolReceiptsOfThread: new Map(), toolErrMsgs: { interrupted: 'Tool call was interrupted by the user.' }, _revokeAgentDelegation() { current = false; },
			_toolsService: { callTool: { run_command: async () => ({ result: (++call === 1 ? first : second).promise, interruptTool: () => { interrupts++; } }) }, stringOfResult: { run_command: () => { throw new Error('cancelled command must not stringify'); } } },
			_updateLatestTool(_threadId: string, message: any) { const last = messages.at(-1); if (last?.role === 'tool' && last.type !== 'invalid_params') messages[messages.length - 1] = message; else messages.push(message); },
			_editMessageInThread(_threadId: string, index: number, message: any) { messages[index] = message; },
			_setStreamState(threadId: string, value: any) { this.streamState[threadId] = value; },
		}; Object.setPrototypeOf(receiver, ChatThreadService.prototype);
		const start = () => chatLifecycle._runToolCall.call(receiver, 'task', 'run_command', 'same', undefined, { preapproved: true, unvalidatedToolParams: {}, validatedParams: {} }, instructionSnapshot(), undefined, false, 0, () => current);
		const runA = start(); await Promise.resolve(); await chatLifecycle.abortRunning.call(receiver, 'task');
		assert.deepStrictEqual({ type: messages[0].type, lifecycle: messages[0].lifecycle, interrupts }, { type: 'running_now', lifecycle: 'cancelling', interrupts: 1 });
		messages.push({ role: 'assistant', displayContent: 'replacement', reasoning: '', anthropicReasoning: null }); current = true;
		const runB = start(); await Promise.resolve(); await chatLifecycle.abortRunning.call(receiver, 'task');
		first.resolve({ result: '', resolveReason: { type: 'cancelled' } }); await runA;
		assert.strictEqual(messages[0].type, 'rejected');
		assert.strictEqual(messages.at(-1).type, 'running_now');
		second.resolve({ result: '', resolveReason: { type: 'cancelled' } }); await runB;
		assert.strictEqual(messages.at(-1).type, 'rejected');
		assert.strictEqual(interrupts, 2);

		const mcpPending = deferred<{ result: { late: true } }>(); const mcpMessages: any[] = []; const mcpStream: any = {}; let mcpCurrent = true;
		const mcpReceiver: any = {
			state: { allThreads: { task: { messages: mcpMessages, state: {}, filesWithUserChanges: new Set<string>() } } }, streamState: mcpStream,
			_activeToolCardReceiptsOfThread: new Map(), _cancellingToolReceiptsOfThread: new Map(), toolErrMsgs: { interrupted: 'Tool call was interrupted by the user.' },
			_revokeAgentDelegation() { mcpCurrent = false; }, _toolsService: { callTool: {}, stringOfResult: {} },
			_mcpService: { getMCPTools: () => [{ name: 'fixture_mcp', mcpServerName: 'fixture' }], callMCPTool: () => mcpPending.promise, stringifyResult: () => { throw new Error('a stopped MCP result must not stringify'); } },
			_updateLatestTool(_threadId: string, message: any) { if (mcpMessages.length) mcpMessages[mcpMessages.length - 1] = message; else mcpMessages.push(message); },
			_editMessageInThread(_threadId: string, index: number, message: any) { mcpMessages[index] = message; }, _setStreamState(threadId: string, value: any) { mcpStream[threadId] = value; },
		}; Object.setPrototypeOf(mcpReceiver, ChatThreadService.prototype);
		const mcpRun = chatLifecycle._runToolCall.call(mcpReceiver, 'task', 'fixture_mcp', 'same', 'fixture', { preapproved: true, unvalidatedToolParams: {}, validatedParams: {} }, instructionSnapshot(), undefined, false, 0, () => mcpCurrent, { batchId: 'mcp-batch', batchOrdinal: 0 });
		await flushMicrotasks(); await chatLifecycle.abortRunning.call(mcpReceiver, 'task'); assert.deepStrictEqual({ type: mcpMessages[0].type, lifecycle: mcpMessages[0].lifecycle }, { type: 'running_now', lifecycle: 'cancelling' });
		mcpPending.resolve({ result: { late: true } }); assert.deepStrictEqual(await mcpRun, { interrupted: true });
		assert.deepStrictEqual({ type: mcpMessages[0].type, batchId: mcpMessages[0].batchId, batchOrdinal: mcpMessages[0].batchOrdinal }, { type: 'rejected', batchId: 'mcp-batch', batchOrdinal: 0 });
	});

	test('card Stop owns one exact live receipt without revoking a parent or sibling', async () => {
		const first = deferred<any>(); const replacement = deferred<any>(); const sibling = deferred<any>();
		const messages: any[] = []; const otherMessages: any[] = []; const streamState: any = {};
		const interrupts = { first: 0, replacement: 0, sibling: 0 }; let stringifyCalls = 0; let revocations = 0; let reentrantStop: boolean | undefined;
		const receiver: any = {
			state: {
				allThreads: {
					task: { messages, state: {}, filesWithUserChanges: new Set<string>() },
					other: { messages: otherMessages, state: {}, filesWithUserChanges: new Set<string>() },
				},
			},
			streamState,
			_activeToolCardReceiptsOfThread: new Map(),
			_cancellingToolReceiptsOfThread: new Map(),
			toolErrMsgs: { interrupted: 'Tool call was interrupted by the user.' },
			_revokeAgentDelegation() { revocations++; },
			_toolsService: {
				callTool: {
					run_command: async (params: any) => {
						const key = params.command as keyof typeof interrupts;
						const result = key === 'first' ? first.promise : key === 'replacement' ? replacement.promise : sibling.promise;
						return { result, interruptTool: () => { interrupts[key]++; } };
					},
				},
				stringOfResult: { run_command: () => { stringifyCalls++; return 'finished'; } },
			},
			_updateLatestTool(threadId: string, message: any) {
				const target = threadId === 'task' ? messages : otherMessages;
				let liveIndex = -1; for (let index = target.length - 1; index >= 0; index--) { const candidate = target[index]; if (candidate.role === 'tool' && candidate.id === message.id && candidate.batchId === message.batchId && candidate.batchOrdinal === message.batchOrdinal && (candidate.type === 'running_now' || candidate.type === 'tool_request')) { liveIndex = index; break; } }
				if (liveIndex >= 0) target[liveIndex] = message;
				else target.push(message);
			},
			_editMessageInThread(threadId: string, index: number, message: any) {
				const target = threadId === 'task' ? messages : otherMessages;
				target[index] = message;
				if (threadId === 'task' && message.lifecycle === 'cancelling' && reentrantStop === undefined) reentrantStop = chatLifecycle.cancelToolReceipt.call(receiver, 'task', message.receiptId, message.id);
			},
			_setStreamState(threadId: string, value: any) { streamState[threadId] = value; },
		};
		Object.setPrototypeOf(receiver, ChatThreadService.prototype);
		const start = (threadId: 'task' | 'other', command: keyof typeof interrupts) => chatLifecycle._runToolCall.call(receiver, threadId, 'run_command', 'same-provider-id', undefined, { preapproved: true, unvalidatedToolParams: { command, terminalId: command }, validatedParams: { command, terminalId: command } }, instructionSnapshot(), undefined, false, 0, () => true);

		const runFirst = start('task', 'first'); const runSibling = start('other', 'sibling');
		await flushMicrotasks();
		const firstReceipt = messages[0].receiptId as string;
		assert.ok(firstReceipt);
		assert.strictEqual(chatLifecycle.cancelToolReceipt.call(receiver, 'other', firstReceipt, 'same-provider-id'), false);
		assert.strictEqual(chatLifecycle.cancelToolReceipt.call(receiver, 'task', 'wrong-receipt', 'same-provider-id'), false);
		assert.strictEqual(chatLifecycle.cancelToolReceipt.call(receiver, 'task', firstReceipt, 'same-provider-id'), true);
		assert.strictEqual(reentrantStop, false);
		assert.deepStrictEqual({ lifecycle: messages[0].lifecycle, first: interrupts.first, sibling: interrupts.sibling, revocations }, { lifecycle: 'cancelling', first: 1, sibling: 0, revocations: 0 });
		assert.strictEqual(chatLifecycle.cancelToolReceipt.call(receiver, 'task', firstReceipt, 'same-provider-id'), false);
		first.resolve({ result: 'late success must not render', resolveReason: { type: 'cancelled' } });
		assert.deepStrictEqual(await runFirst, { receiptCancelled: true });
		assert.deepStrictEqual({ type: messages[0].type, result: messages[0].result, stringifyCalls }, { type: 'rejected', result: null, stringifyCalls: 0 });

		const runReplacement = start('task', 'replacement'); await flushMicrotasks();
		const replacementReceipt = messages.at(-1).receiptId as string;
		assert.notStrictEqual(replacementReceipt, firstReceipt);
		assert.strictEqual(chatLifecycle.cancelToolReceipt.call(receiver, 'task', firstReceipt, 'same-provider-id'), false);
		assert.strictEqual(interrupts.replacement, 0);
		assert.strictEqual(chatLifecycle.cancelToolReceipt.call(receiver, 'task', replacementReceipt, 'same-provider-id'), true);
		replacement.resolve({ result: '', resolveReason: { type: 'cancelled' } });
		assert.deepStrictEqual(await runReplacement, { receiptCancelled: true });
		assert.strictEqual(messages.at(-1).type, 'rejected');

		sibling.resolve({ result: 'unrelated finished', resolveReason: { type: 'done', exitCode: 0 } });
		await runSibling;
		assert.strictEqual(otherMessages[0].type, 'success');
		assert.strictEqual(interrupts.sibling, 0);

		// Unit 8B parent safe waves: plan cap/tie-breaking, ordinal publication, exact
		// card/global Stop fencing, and model-content budgeting all remain within this
		// existing lifecycle declaration so the release gate stays at 35 tests.
		assert.deepStrictEqual(planToolBatchWaves('parent', [
			{ ordinal: 7, name: 'ls_dir' }, { ordinal: 5, name: 'read_file' }, { ordinal: 4, name: 'run_command' }, { ordinal: 3, name: 'search_for_files' },
		], Number.POSITIVE_INFINITY).map(wave => [wave.kind, wave.calls.map(call => call.ordinal)]), [['safe_read', [7, 5]], ['barrier', [4]], ['safe_read', [3]]]);
		assert.deepStrictEqual(divideToolWaveOutputBudget(7, 3), [3, 2, 2]);
		assert.deepStrictEqual(divideToolWaveOutputBudget(Number.NaN, 3), [0, 0, 0]);

		const makeSafeReceiver = (declarations: any[], leaves: Record<string, ReturnType<typeof deferred<any>>>, stopWhenFirstPublished = false) => {
			const safeMessages: any[] = [
				{ role: 'user', content: 'parent safe wave', displayContent: 'parent safe wave' },
				{ role: 'assistant', displayContent: '', reasoning: '', anthropicReasoning: null, toolBatch: { version: 1, batchId: 'safe-batch', calls: declarations.map(({ id, name, rawParams }) => ({ id, name, rawParams })) } },
			];
			let safeCurrent = true; let didStop = false; const safeStarts: string[] = []; const safeInterrupts: string[] = []; const safeStream: any = {}; const safeStreamEvents: any[] = [];
			const safeReceiver: any = {
				state: { allThreads: { task: { messages: safeMessages, state: {}, filesWithUserChanges: new Set<string>() } } }, streamState: safeStream,
				_agentControlGeneration: new Map([['task', 0]]), _activeToolCardReceiptsOfThread: new Map(), _cancellingToolReceiptsOfThread: new Map(),
				toolErrMsgs: { interrupted: 'interrupted', errWhenStringifying: () => 'stringify failed' },
				_toolsService: {
					validateParams: { ls_dir: (raw: any) => { if (raw.invalid) throw new Error('invalid ls_dir'); return { key: raw.key }; } },
					callTool: { ls_dir: async (params: any) => { safeStarts.push(params.key); const leaf = leaves[params.key]; if (!leaf) throw new Error(`missing leaf ${params.key}`); return { result: leaf.promise, interruptTool: () => safeInterrupts.push(params.key) }; } },
					stringOfResult: { ls_dir: (_params: any, value: any) => value.content },
				},
				_settingsService: { state: { globalSettings: { readFileLimits: {} } } }, _mcpService: { getMCPTools: () => [] },
				_revokeAgentDelegation() { safeCurrent = false; this._agentControlGeneration.set('task', 1); },
				_addMessageToThread(threadId: string, message: any) { safeMessages.push(message); if (stopWhenFirstPublished && !didStop && message.role === 'tool' && message.type === 'running_now') { didStop = true; void chatLifecycle.abortRunning.call(safeReceiver, threadId); } },
				_editMessageInThread(_threadId: string, index: number, message: any) { safeMessages[index] = message; },
				_setStreamState(threadId: string, value: any) { safeStream[threadId] = value; safeStreamEvents.push(value); },
			};
			Object.setPrototypeOf(safeReceiver, ChatThreadService.prototype);
			return { safeReceiver, safeMessages, safeStarts, safeInterrupts, safeStreamEvents, isCurrent: () => safeCurrent };
		};

		const mixedA = deferred<any>(); const mixedC = deferred<any>();
		const mixed = makeSafeReceiver([
			{ id: 'mixed-a', name: 'ls_dir', rawParams: { key: 'mixed-a' }, ordinal: 0 },
			{ id: 'mixed-invalid', name: 'ls_dir', rawParams: { key: 'mixed-invalid', invalid: true }, ordinal: 1 },
			{ id: 'mixed-c', name: 'ls_dir', rawParams: { key: 'mixed-c' }, ordinal: 2 },
		], { 'mixed-a': mixedA, 'mixed-c': mixedC });
		const mixedRun = chatLifecycle._runParentSafeReadWave.call(mixed.safeReceiver, 'task', mixed.safeMessages[1].toolBatch.calls.map((call: any, ordinal: number) => ({ ...call, ordinal })), 'safe-batch', instructionSnapshot(), undefined, 0, mixed.isCurrent);
		await flushMicrotasks();
		assert.deepStrictEqual(mixed.safeMessages.filter(message => message.role === 'tool').map(message => [message.id, message.type, message.batchOrdinal]), [['mixed-a', 'running_now', 0], ['mixed-invalid', 'invalid_params', 1], ['mixed-c', 'running_now', 2]]);
		assert.strictEqual(chatLifecycle.cancelToolReceipt.call(mixed.safeReceiver, 'task', mixed.safeMessages[2].receiptId, 'mixed-a'), true, 'valid A must retain its own ordinal row despite an invalid sibling');
		mixedC.resolve({ content: 'C complete' }); mixedA.resolve({ content: 'A late after card Stop' });
		await mixedRun;
		assert.deepStrictEqual(mixed.safeMessages.filter(message => message.role === 'tool').map(message => [message.id, message.type, message.batchOrdinal]), [['mixed-a', 'rejected', 0], ['mixed-invalid', 'invalid_params', 1], ['mixed-c', 'success', 2]]);

		const mixedStop = makeSafeReceiver([
			{ id: 'mixed-stop-invalid-before', name: 'ls_dir', rawParams: { key: 'mixed-stop-invalid-before', invalid: true }, ordinal: 0 },
			{ id: 'mixed-stop-live', name: 'ls_dir', rawParams: { key: 'mixed-stop-live' }, ordinal: 1 },
			{ id: 'mixed-stop-invalid-after-a', name: 'ls_dir', rawParams: { key: 'mixed-stop-invalid-after-a', invalid: true }, ordinal: 2 },
			{ id: 'mixed-stop-invalid-after-b', name: 'ls_dir', rawParams: { key: 'mixed-stop-invalid-after-b', invalid: true }, ordinal: 3 },
			{ id: 'mixed-stop-tail', name: 'ls_dir', rawParams: { key: 'mixed-stop-tail' }, ordinal: 4 },
		], {}, true);
		const mixedStopRun = chatLifecycle._runNativeBatchRange.call(mixedStop.safeReceiver, 'task', mixedStop.safeMessages[1].toolBatch.calls.map((call: any, ordinal: number) => ({ ...call, ordinal })), 'safe-batch', instructionSnapshot(), undefined, true, 0, mixedStop.isCurrent, () => false);
		await flushMicrotasks(); assert.deepStrictEqual(await mixedStopRun, { interrupted: true });
			const mixedStopRows = mixedStop.safeMessages.filter(message => message.role === 'tool'); assert.deepStrictEqual(mixedStopRows.map(message => [message.id, message.type, message.batchOrdinal]), [['mixed-stop-invalid-before', 'invalid_params', 0], ['mixed-stop-live', 'rejected', 1], ['mixed-stop-invalid-after-a', 'invalid_params', 2], ['mixed-stop-invalid-after-b', 'invalid_params', 3], ['mixed-stop-tail', 'skipped', 4]]); assert.strictEqual(new Set(mixedStopRows.map(message => `${message.id}/${message.batchId}/${message.batchOrdinal}`)).size, 5); assert.deepStrictEqual(mixedStop.safeStarts, []);

		const capA = deferred<any>(); const capB = deferred<any>(); const capC = deferred<any>();
		const capped = makeSafeReceiver([
			{ id: 'cap-a', name: 'ls_dir', rawParams: { key: 'cap-a' }, ordinal: 0 }, { id: 'cap-b', name: 'ls_dir', rawParams: { key: 'cap-b' }, ordinal: 1 }, { id: 'cap-c', name: 'ls_dir', rawParams: { key: 'cap-c' }, ordinal: 2 },
		], { 'cap-a': capA, 'cap-b': capB, 'cap-c': capC });
		const cappedRun = chatLifecycle._runNativeBatchRange.call(capped.safeReceiver, 'task', capped.safeMessages[1].toolBatch.calls.map((call: any, ordinal: number) => ({ ...call, ordinal })), 'safe-batch', instructionSnapshot(), undefined, true, 0, capped.isCurrent, () => false);
		await flushMicrotasks(); assert.deepStrictEqual(capped.safeStarts, ['cap-a', 'cap-b']);
		capB.resolve({ content: 'B complete first' }); await flushMicrotasks(); assert.deepStrictEqual(capped.safeStarts, ['cap-a', 'cap-b']);
		capA.resolve({ content: 'A complete second' }); await flushMicrotasks(); await flushMicrotasks(); assert.deepStrictEqual(capped.safeStarts, ['cap-a', 'cap-b', 'cap-c']);
		capC.resolve({ content: 'C complete' }); await cappedRun;
		assert.deepStrictEqual(capped.safeMessages.filter(message => message.role === 'tool').map(message => [message.id, message.type, message.content]), [['cap-a', 'success', 'A complete second'], ['cap-b', 'success', 'B complete first'], ['cap-c', 'success', 'C complete']]);

		const cardA = deferred<any>(); const cardB = deferred<any>(); const cardC = deferred<any>();
		const cardStopped = makeSafeReceiver([
			{ id: 'card-a', name: 'ls_dir', rawParams: { key: 'card-a' }, ordinal: 0 }, { id: 'card-b', name: 'ls_dir', rawParams: { key: 'card-b' }, ordinal: 1 }, { id: 'card-c', name: 'ls_dir', rawParams: { key: 'card-c' }, ordinal: 2 },
		], { 'card-a': cardA, 'card-b': cardB, 'card-c': cardC });
		const cardRun = chatLifecycle._runNativeBatchRange.call(cardStopped.safeReceiver, 'task', cardStopped.safeMessages[1].toolBatch.calls.map((call: any, ordinal: number) => ({ ...call, ordinal })), 'safe-batch', instructionSnapshot(), undefined, true, 0, cardStopped.isCurrent, () => false);
		await flushMicrotasks(); const cardAReceipt = cardStopped.safeMessages.find(message => message.id === 'card-a').receiptId;
		assert.strictEqual(chatLifecycle.cancelToolReceipt.call(cardStopped.safeReceiver, 'task', cardAReceipt, 'card-a'), true);
		cardB.resolve({ content: 'active sibling wins' }); cardA.resolve({ content: 'cancelled A' });
		await cardRun;
		assert.deepStrictEqual({ starts: cardStopped.safeStarts, rows: cardStopped.safeMessages.filter(message => message.role === 'tool').map(message => [message.id, message.type, message.batchOrdinal]) }, { starts: ['card-a', 'card-b'], rows: [['card-a', 'rejected', 0], ['card-b', 'success', 1], ['card-c', 'skipped', 2]] });

		const oversizedLeaf = deferred<any>(); const oversized = makeSafeReceiver([{ id: 'oversized', name: 'ls_dir', rawParams: { key: 'oversized' }, ordinal: 0 }], { oversized: oversizedLeaf });
		const oversizedRun = chatLifecycle._runParentSafeReadWave.call(oversized.safeReceiver, 'task', oversized.safeMessages[1].toolBatch.calls.map((call: any, ordinal: number) => ({ ...call, ordinal })), 'safe-batch', instructionSnapshot(), undefined, 0, oversized.isCurrent);
		await flushMicrotasks(); const rawOversizedResult = { content: 'x'.repeat(100_000), entries: ['still on the UI result object'] }; oversizedLeaf.resolve(rawOversizedResult); await oversizedRun;
		const oversizedRow = oversized.safeMessages.find(message => message.id === 'oversized');
		assert.deepStrictEqual({ result: oversizedRow.result, bounded: oversizedRow.content.length < rawOversizedResult.content.length, marker: oversizedRow.content.includes('truncated to this tool\'s assigned read budget') }, { result: rawOversizedResult, bounded: true, marker: true });

		const stopA = deferred<any>(); const stopB = deferred<any>(); const stopC = deferred<any>();
		const globallyStopped = makeSafeReceiver([
			{ id: 'stop-a', name: 'ls_dir', rawParams: { key: 'stop-a' }, ordinal: 0 }, { id: 'stop-b', name: 'ls_dir', rawParams: { key: 'stop-b' }, ordinal: 1 }, { id: 'stop-c', name: 'ls_dir', rawParams: { key: 'stop-c' }, ordinal: 2 },
		], { 'stop-a': stopA, 'stop-b': stopB, 'stop-c': stopC }, true);
		const stoppedRun = chatLifecycle._runNativeBatchRange.call(globallyStopped.safeReceiver, 'task', globallyStopped.safeMessages[1].toolBatch.calls.map((call: any, ordinal: number) => ({ ...call, ordinal })), 'safe-batch', instructionSnapshot(), undefined, true, 0, globallyStopped.isCurrent, () => false);
		await flushMicrotasks(); stopA.resolve({ content: 'late A' }); stopB.resolve({ content: 'late B' });
		assert.deepStrictEqual(await stoppedRun, { interrupted: true });
		assert.deepStrictEqual({ starts: globallyStopped.safeStarts, interrupts: globallyStopped.safeInterrupts.sort(), rows: globallyStopped.safeMessages.filter(message => message.role === 'tool').map(message => [message.id, message.type, message.batchOrdinal]), staleToolProjection: globallyStopped.safeStreamEvents.some(event => event?.isRunning === 'tool'), active: globallyStopped.safeReceiver._activeToolCardReceiptsOfThread.size }, { starts: [], interrupts: [], rows: [['stop-a', 'rejected', 0], ['stop-b', 'skipped', 1], ['stop-c', 'skipped', 2]], staleToolProjection: false, active: 0 });

		const activeA = deferred<any>(); const activeB = deferred<any>(); const activeC = deferred<any>();
		const activeStopped = makeSafeReceiver([
			{ id: 'active-a', name: 'ls_dir', rawParams: { key: 'active-a' }, ordinal: 0 }, { id: 'active-b', name: 'ls_dir', rawParams: { key: 'active-b' }, ordinal: 1 }, { id: 'active-c', name: 'ls_dir', rawParams: { key: 'active-c' }, ordinal: 2 },
		], { 'active-a': activeA, 'active-b': activeB, 'active-c': activeC });
		const activeRun = chatLifecycle._runNativeBatchRange.call(activeStopped.safeReceiver, 'task', activeStopped.safeMessages[1].toolBatch.calls.map((call: any, ordinal: number) => ({ ...call, ordinal })), 'safe-batch', instructionSnapshot(), undefined, true, 0, activeStopped.isCurrent, () => false);
		await flushMicrotasks(); assert.deepStrictEqual(activeStopped.safeStarts, ['active-a', 'active-b']);
		await chatLifecycle.abortRunning.call(activeStopped.safeReceiver, 'task');
		activeA.resolve({ content: 'late active A' }); activeB.resolve({ content: 'late active B' });
		assert.deepStrictEqual(await activeRun, { interrupted: true });
		assert.deepStrictEqual({ interrupts: activeStopped.safeInterrupts.sort(), rows: activeStopped.safeMessages.filter(message => message.role === 'tool').map(message => [message.id, message.type, message.batchOrdinal]), active: activeStopped.safeReceiver._activeToolCardReceiptsOfThread.size }, { interrupts: ['active-a', 'active-b'], rows: [['active-a', 'rejected', 0], ['active-b', 'rejected', 1], ['active-c', 'skipped', 2]], active: 0 });

		// A fresh parent receipt waiting behind an old physical generation must be
		// cancellable without releasing that old operation or starting a new one.
		const orphanCoordinator = () => {
			let oldPhysicalActive = true; let queued = 0; let realLeases = 1; const tokens: any[] = [];
			const acquireGroupIo = (_parentId: string, _generation: number, _kind: 'read' | 'write', token?: any) => {
				tokens.push(token);
				if (!oldPhysicalActive) { realLeases += 1; let released = false; return Promise.resolve({ release() { if (!released) { released = true; realLeases -= 1; } } }); }
				return new Promise<{ release(): void }>(resolve => {
					queued += 1; let settled = false; let listener: { dispose(): void } | undefined;
					const settleNoop = () => { if (settled) return; settled = true; queued -= 1; listener?.dispose(); resolve({ release() { } }); };
					if (token?.isCancellationRequested) settleNoop(); else listener = token?.onCancellationRequested(settleNoop);
				});
			};
			return {
				acquireGroupIo, cancelParent() { }, forgetParent() { }, tokens,
				oldLease: { release() { if (!oldPhysicalActive) return; oldPhysicalActive = false; realLeases -= 1; } },
				state: () => ({ oldPhysicalActive, queued, realLeases }),
			};
		};
		const safeOrphan = orphanCoordinator(); const orphanSafe = makeSafeReceiver([{ id: 'orphan-safe', name: 'ls_dir', rawParams: { key: 'orphan-safe' }, ordinal: 0 }], {});
		orphanSafe.safeReceiver._agentSubagentService = safeOrphan;
		const orphanSafeRun = chatLifecycle._runParentSafeReadWave.call(orphanSafe.safeReceiver, 'task', orphanSafe.safeMessages[1].toolBatch.calls.map((call: any, ordinal: number) => ({ ...call, ordinal })), 'safe-batch', instructionSnapshot(), undefined, 0, orphanSafe.isCurrent);
		await flushMicrotasks(); assert.deepStrictEqual({ starts: orphanSafe.safeStarts, state: safeOrphan.state(), token: safeOrphan.tokens[0]?.isCancellationRequested }, { starts: [], state: { oldPhysicalActive: true, queued: 1, realLeases: 1 }, token: false });
		await chatLifecycle.abortRunning.call(orphanSafe.safeReceiver, 'task'); assert.deepStrictEqual(await orphanSafeRun, [{ call: { id: 'orphan-safe', name: 'ls_dir', rawParams: { key: 'orphan-safe' }, ordinal: 0 }, batchRef: { batchId: 'safe-batch', batchOrdinal: 0 }, interrupted: true }]);
		assert.deepStrictEqual({ starts: orphanSafe.safeStarts, state: safeOrphan.state(), token: safeOrphan.tokens[0]?.isCancellationRequested }, { starts: [], state: { oldPhysicalActive: true, queued: 0, realLeases: 1 }, token: true }); safeOrphan.oldLease.release(); assert.deepStrictEqual(safeOrphan.state(), { oldPhysicalActive: false, queued: 0, realLeases: 0 });

		const directOrphan = orphanCoordinator(); const directMessages: any[] = []; const directStream: any = {}; let directCurrent = true; let directCalls = 0;
		const directReceiver: any = {
			state: { allThreads: { task: { messages: directMessages, state: {}, filesWithUserChanges: new Set<string>() } } }, streamState: directStream,
			_agentControlGeneration: new Map([['task', 0]]), _activeToolCardReceiptsOfThread: new Map(), _cancellingToolReceiptsOfThread: new Map(), _agentSubagentService: directOrphan,
			toolErrMsgs: { interrupted: 'interrupted', errWhenStringifying: () => 'must not stringify' }, _mcpService: { getMCPTools: () => [] },
			_revokeAgentDelegation() { directCurrent = false; this._agentControlGeneration.set('task', 1); },
			_toolsService: { callTool: { run_command: async () => { directCalls += 1; return { result: Promise.resolve({}), interruptTool: undefined }; } }, stringOfResult: { run_command: () => 'done' } },
			_updateLatestTool(_threadId: string, message: any) { const index = directMessages.findIndex(candidate => candidate.role === 'tool' && candidate.id === message.id && candidate.type === 'running_now'); if (index >= 0) directMessages[index] = message; else directMessages.push(message); },
			_editMessageInThread(_threadId: string, index: number, message: any) { directMessages[index] = message; }, _setStreamState(threadId: string, state: any) { directStream[threadId] = state; },
		};
		Object.setPrototypeOf(directReceiver, ChatThreadService.prototype);
		const orphanDirectRun = chatLifecycle._runToolCall.call(directReceiver, 'task', 'run_command', 'orphan-direct', undefined, { preapproved: true, unvalidatedToolParams: { command: 'echo orphan', terminalId: 'orphan' }, validatedParams: { command: 'echo orphan', terminalId: 'orphan' } }, instructionSnapshot(), undefined, false, 0, () => directCurrent);
		await flushMicrotasks(); assert.deepStrictEqual({ calls: directCalls, state: directOrphan.state(), token: directOrphan.tokens[0]?.isCancellationRequested }, { calls: 0, state: { oldPhysicalActive: true, queued: 1, realLeases: 1 }, token: false });
		await chatLifecycle.abortRunning.call(directReceiver, 'task'); assert.deepStrictEqual(await orphanDirectRun, { interrupted: true });
		assert.deepStrictEqual({ calls: directCalls, state: directOrphan.state(), token: directOrphan.tokens[0]?.isCancellationRequested }, { calls: 0, state: { oldPhysicalActive: true, queued: 0, realLeases: 1 }, token: true }); directOrphan.oldLease.release(); assert.deepStrictEqual(directOrphan.state(), { oldPhysicalActive: false, queued: 0, realLeases: 0 });

		// An operation-level direct MCP interrupt keeps its parent current, so it
		// specifically exercises the post-acquire `interrupted` fence.
		const mcpOrphan = orphanCoordinator(); const mcpMessages: any[] = []; const mcpStream: any = {}; let mcpCurrent = true; let mcpCalls = 0;
		const mcpReceiver: any = {
			state: { allThreads: { task: { messages: mcpMessages, state: {}, filesWithUserChanges: new Set<string>() } } }, streamState: mcpStream,
			_agentControlGeneration: new Map([['task', 0]]), _activeToolCardReceiptsOfThread: new Map(), _cancellingToolReceiptsOfThread: new Map(), _agentSubagentService: mcpOrphan,
			toolErrMsgs: { interrupted: 'interrupted', errWhenStringifying: () => 'must not stringify' },
			_mcpService: { getMCPTools: () => [{ name: 'orphan_mcp', mcpServerName: 'orphan-server' }], callMCPTool: async () => { mcpCalls += 1; return { result: {} }; }, stringifyResult: () => 'must not stringify' },
			_toolsService: { callTool: {}, stringOfResult: {} },
			_updateLatestTool(_threadId: string, message: any) { const index = mcpMessages.findIndex(candidate => candidate.role === 'tool' && candidate.id === message.id && candidate.type === 'running_now'); if (index >= 0) mcpMessages[index] = message; else mcpMessages.push(message); },
			_editMessageInThread(_threadId: string, index: number, message: any) { mcpMessages[index] = message; }, _setStreamState(threadId: string, state: any) { mcpStream[threadId] = state; },
		};
		Object.setPrototypeOf(mcpReceiver, ChatThreadService.prototype);
		const orphanMcpRun = chatLifecycle._runToolCall.call(mcpReceiver, 'task', 'orphan_mcp', 'orphan-mcp', 'orphan-server', { preapproved: true, unvalidatedToolParams: { value: 'orphan' }, validatedParams: { value: 'orphan' } }, instructionSnapshot(), undefined, false, 0, () => mcpCurrent);
		await flushMicrotasks(); assert.deepStrictEqual({ calls: mcpCalls, state: mcpOrphan.state(), token: mcpOrphan.tokens[0]?.isCancellationRequested }, { calls: 0, state: { oldPhysicalActive: true, queued: 1, realLeases: 1 }, token: false });
		const mcpInterrupt = await mcpStream.task.interrupt; mcpInterrupt(); assert.deepStrictEqual(await orphanMcpRun, { interrupted: true });
		assert.deepStrictEqual({ current: mcpCurrent, calls: mcpCalls, state: mcpOrphan.state(), token: mcpOrphan.tokens[0]?.isCancellationRequested }, { current: true, calls: 0, state: { oldPhysicalActive: true, queued: 0, realLeases: 1 }, token: true }); mcpOrphan.oldLease.release(); assert.deepStrictEqual(mcpOrphan.state(), { oldPhysicalActive: false, queued: 0, realLeases: 0 });

		// Every approval-registry edit/terminal builtin must wait behind same-parent
		// reads. This deliberately exercises the four former omissions too, while
		// keeping prepareWriteFile outside the operation-scoped writer lease.
		const writerMessages: any[] = []; const writerStarts: string[] = []; let activeReaders = 0; let activeWriter = false; const queuedWriters: Array<(lease: { release(): void }) => void> = [];
		const pumpWriters = () => {
			if (activeReaders !== 0 || activeWriter || queuedWriters.length === 0) return;
			activeWriter = true; const grant = queuedWriters.shift()!; let released = false;
			grant({ release() { if (released) return; released = true; activeWriter = false; pumpWriters(); } });
		};
		const ioCoordinator = {
			async acquireGroupIo(_parentId: string, _generation: number, kind: 'read' | 'write') {
				if (kind === 'read') { activeReaders += 1; let released = false; return { release() { if (released) return; released = true; activeReaders -= 1; pumpWriters(); } }; }
				return new Promise<{ release(): void }>(resolve => { queuedWriters.push(resolve); pumpWriters(); });
			},
		};
		const heldReadA = await ioCoordinator.acquireGroupIo('task', 0, 'read'); const heldReadB = await ioCoordinator.acquireGroupIo('task', 0, 'read');
		const writerNames = ['create_file_or_folder', 'delete_file_or_folder', 'write_file', 'run_command', 'run_persistent_command', 'open_persistent_terminal', 'kill_persistent_terminal'] as const;
		const writerParams: Record<string, any> = {
			create_file_or_folder: { uri: URI.parse('file:///workspace/create.txt'), isFolder: false }, delete_file_or_folder: { uri: URI.parse('file:///workspace/delete.txt'), isRecursive: false, isFolder: false }, write_file: { uri: URI.parse('file:///workspace/write.txt'), operation: 'create', content: 'text' },
			run_command: { command: 'echo command', cwd: null, terminalId: 'command' }, run_persistent_command: { command: 'echo persistent', persistentTerminalId: 'persistent' }, open_persistent_terminal: { cwd: null }, kill_persistent_terminal: { persistentTerminalId: 'persistent' },
		};
		const writerReceiver: any = {
			state: { allThreads: { task: { messages: writerMessages, state: {}, filesWithUserChanges: new Set<string>() } } }, streamState: {}, _activeToolCardReceiptsOfThread: new Map(), _cancellingToolReceiptsOfThread: new Map(), _agentSubagentService: ioCoordinator,
			toolErrMsgs: { interrupted: 'interrupted', errWhenStringifying: () => 'stringify failed' }, _mcpService: { getMCPTools: () => [] },
			_toolsService: {
				prepareWriteFile: async () => ({ execute: async () => { writerStarts.push('write_file'); return {}; } }),
				callTool: Object.fromEntries(writerNames.filter(name => name !== 'write_file').map(name => [name, async () => { writerStarts.push(name); return { result: Promise.resolve({}), interruptTool: undefined }; }])),
				stringOfResult: new Proxy({}, { get: () => () => 'done' }),
			},
			_setStreamState(threadId: string, state: any) { this.streamState[threadId] = state; },
			_updateLatestTool(_threadId: string, message: any) { const index = writerMessages.findIndex(candidate => candidate.role === 'tool' && candidate.id === message.id && candidate.type === 'running_now'); if (index >= 0) writerMessages[index] = message; else writerMessages.push(message); },
			_editMessageInThread(_threadId: string, index: number, message: any) { writerMessages[index] = message; },
		};
		Object.setPrototypeOf(writerReceiver, ChatThreadService.prototype);
		const writerRuns = writerNames.map(name => chatLifecycle._runToolCall.call(writerReceiver, 'task', name, `writer-${name}`, undefined, { preapproved: true, unvalidatedToolParams: writerParams[name], validatedParams: writerParams[name] }, instructionSnapshot(), undefined, false, 0, () => true));
		await flushMicrotasks(); assert.deepStrictEqual(writerStarts, []); heldReadA.release(); await flushMicrotasks(); assert.deepStrictEqual(writerStarts, []); heldReadB.release(); await Promise.all(writerRuns);
		assert.deepStrictEqual([...writerStarts].sort(), [...writerNames].sort()); assert.strictEqual(writerStarts.length, writerNames.length);
	});

	test('card Stop rejects a stale parent receipt before touching its live row', () => {
		let interrupts = 0;
		const row: any = { role: 'tool', type: 'running_now', name: 'run_command', params: { command: 'stale', terminalId: 'stale' }, content: '', result: null, id: 'same-provider-id', rawParams: {}, mcpServerName: undefined, receiptId: 'stale-receipt', cardStopAvailable: true };
		const receiver: any = {
			state: { allThreads: { task: { messages: [row], state: {}, filesWithUserChanges: new Set<string>() } } },
			_activeToolCardReceiptsOfThread: new Map([['task', new Map([['stale-receipt', { toolId: 'same-provider-id', messageIndex: 0, cancel: () => { interrupts++; }, isCurrent: () => false, interruptInstalled: true, cancelling: false }]])]]),
			_cancellingToolReceiptsOfThread: new Map(),
		};
		Object.setPrototypeOf(receiver, ChatThreadService.prototype);
		assert.strictEqual(chatLifecycle.cancelToolReceipt.call(receiver, 'task', 'stale-receipt', 'same-provider-id'), false);
		assert.strictEqual(interrupts, 0);
		assert.deepStrictEqual({ lifecycle: row.lifecycle, available: row.cardStopAvailable }, { lifecycle: undefined, available: true });
	});

	test('global Stop published synchronously with a live row settles that exact receipt before tool setup', async () => {
		const messages: any[] = []; const streamState: any = {}; let current = true; let toolCalls = 0; let stop: Promise<void> | undefined;
		const receiver: any = {
			state: { allThreads: { task: { messages, state: {}, filesWithUserChanges: new Set<string>() } } },
			streamState,
			_activeToolCardReceiptsOfThread: new Map(),
			_cancellingToolReceiptsOfThread: new Map(),
			toolErrMsgs: { interrupted: 'Tool call was interrupted by the user.' },
			_revokeAgentDelegation() { current = false; },
			_toolsService: {
				callTool: { run_command: async () => { toolCalls++; throw new Error('tool setup must not start after synchronous Stop'); } },
				stringOfResult: { run_command: () => { throw new Error('cancelled tool must not stringify'); } },
			},
			_updateLatestTool(threadId: string, message: any) {
				if (messages.length) messages[messages.length - 1] = message; else messages.push(message);
				if (message.type === 'running_now' && !message.lifecycle && !stop) stop = chatLifecycle.abortRunning.call(receiver, threadId);
			},
			_editMessageInThread(_threadId: string, index: number, message: any) { messages[index] = message; },
			_setStreamState(threadId: string, value: any) { streamState[threadId] = value; },
		};
		Object.setPrototypeOf(receiver, ChatThreadService.prototype);
		const result = await chatLifecycle._runToolCall.call(receiver, 'task', 'run_command', 'publish-stop', undefined, { preapproved: true, unvalidatedToolParams: { command: 'echo stale', terminalId: 'publish-stop' }, validatedParams: { command: 'echo stale', terminalId: 'publish-stop' } }, instructionSnapshot(), undefined, false, 0, () => current);
		await stop;
		assert.deepStrictEqual(result, { interrupted: true });
		assert.deepStrictEqual({ calls: toolCalls, type: messages[0].type, lifecycle: messages[0].lifecycle, receipt: messages[0].receiptId, stream: streamState.task }, { calls: 0, type: 'rejected', lifecycle: undefined, receipt: undefined, stream: undefined });
	});

	test('receipt-local cancellation continues the parent loop without entering the failure circuit', async () => {
		const snapshot = instructionSnapshot(); const streamState: any = {}; let sends = 0; let toolCalls = 0;
		const receiver: any = {
			state: { allThreads: { task: { messages: [{ role: 'user', content: 'continue after cancellation' }], state: {}, filesWithUserChanges: new Set<string>() } } },
			streamState,
			_agentControlGeneration: new Map([['task', 0]]), _parentRunTokenOfThread: new Map(), _agentDelegationAuthorityOfThread: new Map(),
			_settingsService: { state: { globalSettings: { chatMode: 'agent' } } },
			_convertToLLMMessagesService: { prepareLLMChatMessages: async () => ({ messages: [], separateSystemMessage: false }) },
			_llmMessageService: {
				sendLLMMessage: (options: any) => { const call = ++sends; queueMicrotask(() => void options.onFinalMessage({ fullText: call === 1 ? '' : 'continued', fullReasoning: '', toolCalls: call === 1  ? [{ name: 'run_command', id: 'same', rawParams: { command: 'cancelled', terminalId: 'terminal' } }] : undefined, anthropicReasoning: null })); return `provider-${call}`; },
				abort() { },
			},
			_mcpService: { getMCPTools: () => [] }, _metricsService: { capture() { } },
			_setStreamState(threadId: string, value: any) { streamState[threadId] = value; },
			_addMessageToThread() { }, _terminalizeBatchTailAfter(...args: any[]) { return (ChatThreadService.prototype as any)._terminalizeBatchTailAfter.call(this, ...args); },
			_runToolCall: async () => { toolCalls++; return { receiptCancelled: true }; },
		};
		await runChatAgent(receiver, { threadId: 'task', modelSelection: { providerName: 'openAICompatible', modelName: 'gpt-4.1' }, modelSelectionOptions: snapshot.model.modelSelectionOptions, instructionSnapshot: snapshot });
		assert.deepStrictEqual({ sends, toolCalls, error: streamState.task.error }, { sends: 2, toolCalls: 1, error: undefined });

		for (const cancelledAt of ['current', 'tail'] as const) {
			const batchId = `restored-${cancelledAt}`;
			const calls = [
				{ name: 'run_command', id: `${cancelledAt}-0`, rawParams: { command: 'echo approved', terminalId: `${cancelledAt}-0` } },
				{ name: 'run_command', id: `${cancelledAt}-1`, rawParams: { command: 'echo tail', terminalId: `${cancelledAt}-1` } },
				{ name: 'write_file', id: `${cancelledAt}-2`, rawParams: { malformed: true } },
			];
			const params = { command: 'echo approved', terminalId: `${cancelledAt}-0` };
			const messages: any[] = [
				{ role: 'user', content: 'resume persisted batch', displayContent: 'resume persisted batch' },
				{ role: 'assistant', displayContent: '', reasoning: '', anthropicReasoning: null, toolBatch: { version: 1, batchId, calls } },
				{ role: 'tool', type: 'tool_request', name: 'run_command', params, content: '(Awaiting user permission...)', result: null, id: calls[0].id, rawParams: calls[0].rawParams, mcpServerName: undefined, batchId, batchOrdinal: 0 },
			];
			const resumedStream: any = {}; const executed: string[] = []; let resumedSends = 0;
			const resumed: any = {
				state: { allThreads: { task: { messages, state: {}, filesWithUserChanges: new Set<string>() } } }, streamState: resumedStream,
				_agentControlGeneration: new Map([['task', 0]]), _parentRunTokenOfThread: new Map(), _agentDelegationAuthorityOfThread: new Map(),
				_settingsService: { state: { globalSettings: { chatMode: 'agent' } } }, _convertToLLMMessagesService: { prepareLLMChatMessages: async () => ({ messages: [], separateSystemMessage: false }) },
				_toolsService: { validateParams: { run_command: (raw: any) => ({ command: raw.command, terminalId: raw.terminalId }) } },
				_llmMessageService: { sendLLMMessage: (options: any) => { resumedSends++; queueMicrotask(() => void options.onFinalMessage({ fullText: 'continued once', fullReasoning: '', anthropicReasoning: null })); return 'continued-request'; }, abort() { } },
				_mcpService: { getMCPTools: () => [] }, _metricsService: { capture() { } }, _computeMCPServerOfToolName: () => undefined,
				_setStreamState(id: string, value: any) { resumedStream[id] = value; }, _addMessageToThread(_id: string, message: any) { messages.push(message); }, _editMessageInThread(_id: string, index: number, message: any) { messages[index] = message; },
				_terminalizeBatchTailAfter(...args: any[]) { return (ChatThreadService.prototype as any)._terminalizeBatchTailAfter.call(this, ...args); },
				_runToolCall: async (_id: string, name: string, toolId: string, _mcp: unknown, options: any, _snapshot: unknown, _authority: unknown, _skill: boolean, _generation: number, _current: () => boolean, batchRef: { batchId: string; batchOrdinal: number }) => {
					executed.push(toolId);
					const currentIndex = messages.findIndex(message => message.role === 'tool' && message.id === toolId && message.batchId === batchRef.batchId && message.batchOrdinal === batchRef.batchOrdinal);
					const terminal = { role: 'tool', type: cancelledAt === 'tail' && batchRef.batchOrdinal === 0 ? 'success' : 'rejected', name, params: options.validatedParams ?? options.unvalidatedToolParams, content: cancelledAt === 'tail' && batchRef.batchOrdinal === 0 ? 'approved' : 'cancelled', result: cancelledAt === 'tail' && batchRef.batchOrdinal === 0 ? 'approved' : null, id: toolId, rawParams: options.unvalidatedToolParams, mcpServerName: undefined, ...batchRef };
					if (currentIndex >= 0) messages[currentIndex] = terminal; else messages.push(terminal);
					return cancelledAt === 'current' || batchRef.batchOrdinal === 1 ? { receiptCancelled: true } : {};
				},
			};
			await runChatAgent(resumed, { threadId: 'task', modelSelection: { providerName: 'openAICompatible', modelName: 'gpt-4.1' }, modelSelectionOptions: snapshot.model.modelSelectionOptions, instructionSnapshot: snapshot, callThisToolFirst: messages[2] });
			assert.deepStrictEqual(executed, cancelledAt === 'current' ? [`${cancelledAt}-0`] : [`${cancelledAt}-0`, `${cancelledAt}-1`]);
			assert.strictEqual(resumedSends, 1);
			const rows = messages.filter(message => message.role === 'tool');
			assert.deepStrictEqual(rows.map(message => [message.id, message.type, message.batchOrdinal]), cancelledAt === 'current'
				? [['current-0', 'rejected', 0], ['current-1', 'skipped', 1], ['current-2', 'skipped', 2]]
				: [['tail-0', 'success', 0], ['tail-1', 'rejected', 1], ['tail-2', 'skipped', 2]]);
			assert.strictEqual(rows.filter(message => message.type === 'skipped').every(message => !Object.prototype.hasOwnProperty.call(message, 'params')), true);
			assert.strictEqual(resumedStream.task.error, undefined);
		}

		const corruptDeclaration = { role: 'assistant', displayContent: '', reasoning: '', anthropicReasoning: null, toolBatch: { version: 1, batchId: 'corrupt-batch', calls: [
			{ name: 'run_command', id: 'corrupt-0', rawParams: { command: 'echo prior', terminalId: 'corrupt-0' } },
			{ name: 'run_command', id: 'corrupt-1', rawParams: { command: 'echo approved', terminalId: 'corrupt-1' } },
			{ name: 'run_command', id: 'corrupt-2', rawParams: { command: 'echo tail', terminalId: 'corrupt-2' } },
		] } };
		const corruptPrior = { role: 'tool', type: 'success', name: 'run_command', params: { command: 'echo prior', terminalId: 'corrupt-0' }, content: 'prior', result: 'prior', id: 'corrupt-0', rawParams: { command: 'echo prior', terminalId: 'corrupt-0' }, mcpServerName: undefined, batchId: 'corrupt-batch', batchOrdinal: 0 };
		const corruptPending = { role: 'tool', type: 'tool_request', name: 'run_command', params: { command: 'echo approved', terminalId: 'corrupt-1' }, content: '(Awaiting user permission...)', result: null, id: 'corrupt-1', rawParams: { command: 'echo approved', terminalId: 'corrupt-1' }, mcpServerName: undefined, batchId: 'corrupt-batch', batchOrdinal: 1 };
		const corruptHistories: Array<{ label: string; messages: any[] }> = [
			{ label: 'duplicate declaration', messages: [{ role: 'user', content: 'corrupt', displayContent: 'corrupt' }, corruptDeclaration, corruptPrior, { ...corruptDeclaration }, { ...corruptPending }] },
			{ label: 'wrong call name', messages: [{ role: 'user', content: 'corrupt', displayContent: 'corrupt' }, corruptDeclaration, corruptPrior, { ...corruptPending, name: 'write_file' }] },
			{ label: 'raw argument mismatch', messages: [{ role: 'user', content: 'corrupt', displayContent: 'corrupt' }, corruptDeclaration, corruptPrior, { ...corruptPending, rawParams: { command: 'echo changed', terminalId: 'corrupt-1' } }] },
			{ label: 'missing prior row', messages: [{ role: 'user', content: 'corrupt', displayContent: 'corrupt' }, corruptDeclaration, { ...corruptPending }] },
			{ label: 'interleaved prior rows', messages: [{ role: 'user', content: 'corrupt', displayContent: 'corrupt' }, corruptDeclaration, corruptPrior, { role: 'user', content: 'interleaved', displayContent: 'interleaved' }, { ...corruptPending }] },
			{ label: 'partial batch identity', messages: [{ role: 'user', content: 'corrupt', displayContent: 'corrupt' }, corruptDeclaration, corruptPrior, { ...corruptPending, batchOrdinal: undefined }] },
			{ label: 'erased batch identity', messages: [{ role: 'user', content: 'corrupt', displayContent: 'corrupt' }, corruptDeclaration, corruptPrior, { ...corruptPending, batchId: undefined, batchOrdinal: undefined }] },
			{ label: 'legacy approval after unrelated corrupt native history', messages: [{ role: 'user', content: 'corrupt', displayContent: 'corrupt' }, corruptDeclaration, { role: 'user', content: 'legacy follows corruption', displayContent: 'legacy follows corruption' }, { ...corruptPending, id: 'legacy-pending', batchId: undefined, batchOrdinal: undefined }] },
		];
		for (const { label, messages } of corruptHistories) {
			const rejectedStream: any = {}; let rejectedRuns = 0; let rejectedConversions = 0; let rejectedSends = 0;
			const rejected: any = {
				state: { allThreads: { task: { messages, state: {}, filesWithUserChanges: new Set<string>() } } }, streamState: rejectedStream,
				_agentControlGeneration: new Map([['task', 0]]), _parentRunTokenOfThread: new Map(), _agentDelegationAuthorityOfThread: new Map(),
				_settingsService: { state: { globalSettings: { chatMode: 'agent' } } },
				_convertToLLMMessagesService: { prepareLLMChatMessages: async () => { rejectedConversions++; return { messages: [], separateSystemMessage: false }; } },
				_llmMessageService: { sendLLMMessage: () => { rejectedSends++; throw new Error('corrupt approval must not send'); }, abort() { } },
				_mcpService: { getMCPTools: () => [] }, _metricsService: { capture() { } }, _computeMCPServerOfToolName: () => undefined,
				_setStreamState(id: string, value: any) { rejectedStream[id] = value; }, _editMessageInThread(_id: string, index: number, message: any) { messages[index] = message; }, _addMessageToThread(_id: string, message: any) { messages.push(message); },
				_terminalizeBatchTailAfter(...args: any[]) { return (ChatThreadService.prototype as any)._terminalizeBatchTailAfter.call(this, ...args); },
				_runToolCall: async () => { rejectedRuns++; return {}; },
			};
			const pending = messages.at(-1);
			await runChatAgent(rejected, { threadId: 'task', modelSelection: { providerName: 'openAICompatible', modelName: 'gpt-4.1' }, modelSelectionOptions: snapshot.model.modelSelectionOptions, instructionSnapshot: snapshot, callThisToolFirst: pending });
			const settled = messages.find(message => message.id === pending.id);
			const shouldCloseTail = pending.batchId !== undefined && pending.batchOrdinal !== undefined;
			assert.deepStrictEqual({ label, rejectedRuns, rejectedConversions, rejectedSends, type: settled.type, hasParams: Object.prototype.hasOwnProperty.call(settled, 'params'), tail: messages.find(message => message.id === 'corrupt-2')?.type, error: rejectedStream.task.error.message }, { label, rejectedRuns: 0, rejectedConversions: 0, rejectedSends: 0, type: 'skipped', hasParams: false, tail: label === 'duplicate declaration' ? undefined : shouldCloseTail ? 'skipped' : undefined, error: 'The pending native tool batch no longer matches its declaration.' });
		}

		const restoreState = (messages: any[]) => {
			const streamState: any = {};
			const receiver: any = {
				state: { allThreads: { task: { id: 'task', messages, state: {}, filesWithUserChanges: new Set<string>() } }, currentThreadId: 'task' }, streamState,
				_onDidChangeCurrentThread: { fire() { } },
				_setStreamState(id: string, value: any) { streamState[id] = value; }, _editMessageInThread(_id: string, index: number, message: any) { messages[index] = message; }, _addMessageToThread(_id: string, message: any) { messages.push(message); },
				_updateLatestTool(_id: string, message: any) { const index = messages.findIndex(candidate => candidate.role === 'tool' && candidate.id === message.id && candidate.batchId === message.batchId && candidate.batchOrdinal === message.batchOrdinal && (candidate.type === 'running_now' || candidate.type === 'tool_request')); if (index >= 0) messages[index] = message; else messages.push(message); },
				_computeMCPServerOfToolName: () => undefined,
				_terminalizeBatchTail(...args: any[]) { return (ChatThreadService.prototype as any)._terminalizeBatchTail.call(this, ...args); },
				_terminalizeBatchTailAfter(...args: any[]) { return (ChatThreadService.prototype as any)._terminalizeBatchTailAfter.call(this, ...args); },
			};
			(ChatThreadService.prototype as any)._setState.call(receiver, { allThreads: receiver.state.allThreads, currentThreadId: 'task' }, true);
			return streamState;
		};
		const restoredCorrupt: any[] = [{ role: 'user', content: 'restore corrupt', displayContent: 'restore corrupt' }, corruptDeclaration, corruptPrior, { ...corruptPending, rawParams: { command: 'echo changed', terminalId: 'corrupt-1' } }];
		const restoredCorruptStream = restoreState(restoredCorrupt);
		assert.deepStrictEqual({ rows: restoredCorrupt.filter(message => message.role === 'tool').map(message => [message.id, message.type, Object.prototype.hasOwnProperty.call(message, 'params')]), stream: restoredCorruptStream.task }, { rows: [['corrupt-0', 'success', true], ['corrupt-1', 'skipped', false], ['corrupt-2', 'skipped', false]], stream: undefined });
		const reloadBatchId = 'reload-two-running'; const reloadCalls = ['reload-a', 'reload-b', 'reload-c'].map((id, ordinal) => ({ id, name: 'run_command', rawParams: { command: `echo ${id}`, terminalId: id }, ordinal }));
		const restoredTwoRunning: any[] = [{ role: 'user', content: 'reload two running', displayContent: 'reload two running' }, { role: 'assistant', displayContent: '', reasoning: '', anthropicReasoning: null, toolBatch: { version: 1, batchId: reloadBatchId, calls: reloadCalls } }, ...reloadCalls.slice(0, 2).map(call => ({ role: 'tool', type: 'running_now', name: call.name, params: { command: call.rawParams.command, terminalId: call.rawParams.terminalId }, content: 'running', result: null, id: call.id, rawParams: call.rawParams, mcpServerName: undefined, batchId: reloadBatchId, batchOrdinal: call.ordinal }))];
		const restoredTwoRunningStream = restoreState(restoredTwoRunning);
		assert.deepStrictEqual({ rows: restoredTwoRunning.filter(message => message.role === 'tool').map(message => [message.id, message.type, message.batchOrdinal]), contiguous: restoredTwoRunning.filter(message => message.role === 'tool').map(message => message.batchOrdinal), stream: restoredTwoRunningStream.task }, { rows: [['reload-a', 'rejected', 0], ['reload-b', 'rejected', 1], ['reload-c', 'skipped', 2]], contiguous: [0, 1, 2], stream: undefined });
		const validLegacyPending = { role: 'tool', type: 'tool_request', name: 'run_command', params: { command: 'echo legacy', terminalId: 'legacy' }, content: '(Awaiting user permission...)', result: null, id: 'legacy', rawParams: { command: 'echo legacy', terminalId: 'legacy' }, mcpServerName: undefined };
		const healthyClosedBatch = { role: 'assistant', displayContent: '', reasoning: '', anthropicReasoning: null, toolBatch: { version: 1, batchId: 'closed-before-legacy', calls: [{ name: 'run_command', id: 'closed-0', rawParams: { command: 'echo closed', terminalId: 'closed-0' } }] } };
		const restoredLegacy: any[] = [{ role: 'user', content: 'closed then legacy', displayContent: 'closed then legacy' }, healthyClosedBatch, { role: 'tool', type: 'success', name: 'run_command', params: { command: 'echo closed', terminalId: 'closed-0' }, content: 'closed', result: 'closed', id: 'closed-0', rawParams: { command: 'echo closed', terminalId: 'closed-0' }, mcpServerName: undefined, batchId: 'closed-before-legacy', batchOrdinal: 0 }, validLegacyPending];
		const restoredLegacyStream = restoreState(restoredLegacy);
		assert.deepStrictEqual({ type: restoredLegacy.at(-1).type, stream: restoredLegacyStream.task }, { type: 'tool_request', stream: { isRunning: 'awaiting_user' } }, 'a healthy closed native batch must not poison a later legacy approval');

		const sparseShapeCalls: any[] = [{ id: 'shape-0', name: 'run_command', rawParams: { command: 'echo shape', terminalId: 'shape-0' } }]; sparseShapeCalls.length = 2;
		const malformedShapeCases: ReadonlyArray<readonly [string, unknown]> = [
			['toolBatch null', null], ['toolBatch number', 7], ['calls null', { version: 1, batchId: 'shape-batch', calls: null }], ['calls object', { version: 1, batchId: 'shape-batch', calls: {} }],
			['calls string', { version: 1, batchId: 'shape-batch', calls: 'not-an-array' }], ['sparse calls', { version: 1, batchId: 'shape-batch', calls: sparseShapeCalls }], ['call null', { version: 1, batchId: 'shape-batch', calls: [null] }], ['call number', { version: 1, batchId: 'shape-batch', calls: [5] }],
			['numeric batch id', { version: 1, batchId: 5, calls: [{ id: 'shape-0', name: 'run_command', rawParams: { command: 'echo shape', terminalId: 'shape-0' } }] }],
			['numeric call id', { version: 1, batchId: 'shape-batch', calls: [{ id: 5, name: 'run_command', rawParams: { command: 'echo shape', terminalId: 'shape-0' } }] }],
			['numeric call name', { version: 1, batchId: 'shape-batch', calls: [{ id: 'shape-0', name: 5, rawParams: { command: 'echo shape', terminalId: 'shape-0' } }] }],
		];
		for (const [label, toolBatch] of malformedShapeCases) {
			const makeMessages = () => [{ role: 'user', content: label, displayContent: label }, { role: 'assistant', displayContent: '', reasoning: '', anthropicReasoning: null, toolBatch }, { role: 'tool', type: 'tool_request', name: 'run_command', params: { command: 'echo shape', terminalId: 'shape-0' }, content: '(Awaiting user permission...)', result: null, id: 'shape-0', rawParams: { command: 'echo shape', terminalId: 'shape-0' }, mcpServerName: undefined, batchId: 'shape-batch', batchOrdinal: 0 }];
			const resumeMessages: any[] = makeMessages(); const resumeStream: any = {}; let shapeRuns = 0; let shapeConversions = 0; let shapeSends = 0;
			const resumeReceiver: any = {
				state: { allThreads: { task: { messages: resumeMessages, state: {}, filesWithUserChanges: new Set<string>() } } }, streamState: resumeStream,
				_agentControlGeneration: new Map([['task', 0]]), _parentRunTokenOfThread: new Map(), _agentDelegationAuthorityOfThread: new Map(), _settingsService: { state: { globalSettings: { chatMode: 'agent' } } },
				_convertToLLMMessagesService: { prepareLLMChatMessages: async () => { shapeConversions++; return { messages: [], separateSystemMessage: false }; } }, _llmMessageService: { sendLLMMessage: () => { shapeSends++; throw new Error('malformed shape must not send'); }, abort() { } },
				_mcpService: { getMCPTools: () => [] }, _metricsService: { capture() { } }, _computeMCPServerOfToolName: () => undefined, _setStreamState(id: string, value: any) { resumeStream[id] = value; }, _editMessageInThread(_id: string, index: number, message: any) { resumeMessages[index] = message; }, _addMessageToThread(_id: string, message: any) { resumeMessages.push(message); },
				_terminalizeBatchTailAfter(...args: any[]) { return (ChatThreadService.prototype as any)._terminalizeBatchTailAfter.call(this, ...args); }, _runToolCall: async () => { shapeRuns++; return {}; },
			};
			await runChatAgent(resumeReceiver, { threadId: 'task', modelSelection: { providerName: 'openAICompatible', modelName: 'gpt-4.1' }, modelSelectionOptions: snapshot.model.modelSelectionOptions, instructionSnapshot: snapshot, callThisToolFirst: resumeMessages[2] });
			assert.deepStrictEqual({ label, shapeRuns, shapeConversions, shapeSends, rows: resumeMessages.filter(message => message.role === 'tool').map(message => [message.type, Object.prototype.hasOwnProperty.call(message, 'params')]), error: resumeStream.task.error.message }, { label, shapeRuns: 0, shapeConversions: 0, shapeSends: 0, rows: [['skipped', false]], error: 'The pending native tool batch no longer matches its declaration.' });

			const restoredShape: any[] = makeMessages();
			assert.doesNotThrow(() => restoreState(restoredShape), `${label} must restore without a TypeError`);
			assert.deepStrictEqual(restoredShape.filter(message => message.role === 'tool').map(message => [message.type, Object.prototype.hasOwnProperty.call(message, 'params')]), [['skipped', false]], `${label} restore must settle only the persisted row without guessing a malformed tail`);
		}

		const makeUnrelatedMalformedTarget = () => [
			{ role: 'user', content: 'unrelated malformed native declaration', displayContent: 'unrelated malformed native declaration' },
			{ role: 'assistant', displayContent: '', reasoning: '', anthropicReasoning: null, toolBatch: { version: 1, batchId: 'other', calls: null } },
			{ role: 'assistant', displayContent: '', reasoning: '', anthropicReasoning: null, toolBatch: { version: 1, batchId: 'target', calls: [{ id: 'target-0', name: 'run_command', rawParams: { command: 'echo target', terminalId: 'target-0' } }] } },
			{ role: 'tool', type: 'tool_request', name: 'run_command', params: { command: 'echo target', terminalId: 'target-0' }, content: '(Awaiting user permission...)', result: null, id: 'target-0', rawParams: { command: 'echo target', terminalId: 'target-0' }, mcpServerName: undefined, batchId: 'target', batchOrdinal: 0 },
		];
		const unrelatedResumeMessages: any[] = makeUnrelatedMalformedTarget(); const unrelatedStream: any = {}; let unrelatedRuns = 0; let unrelatedConversions = 0; let unrelatedSends = 0;
		const unrelatedResume: any = {
			state: { allThreads: { task: { messages: unrelatedResumeMessages, state: {}, filesWithUserChanges: new Set<string>() } } }, streamState: unrelatedStream,
			_agentControlGeneration: new Map([['task', 0]]), _parentRunTokenOfThread: new Map(), _agentDelegationAuthorityOfThread: new Map(), _settingsService: { state: { globalSettings: { chatMode: 'agent' } } },
			_convertToLLMMessagesService: { prepareLLMChatMessages: async () => { unrelatedConversions++; return { messages: [], separateSystemMessage: false }; } }, _llmMessageService: { sendLLMMessage: () => { unrelatedSends++; throw new Error('unrelated malformed declaration must not send'); }, abort() { } },
			_mcpService: { getMCPTools: () => [] }, _metricsService: { capture() { } }, _computeMCPServerOfToolName: () => undefined, _setStreamState(id: string, value: any) { unrelatedStream[id] = value; }, _editMessageInThread(_id: string, index: number, message: any) { unrelatedResumeMessages[index] = message; }, _addMessageToThread(_id: string, message: any) { unrelatedResumeMessages.push(message); },
			_terminalizeBatchTailAfter(...args: any[]) { return (ChatThreadService.prototype as any)._terminalizeBatchTailAfter.call(this, ...args); }, _runToolCall: async () => { unrelatedRuns++; return {}; },
		};
		await runChatAgent(unrelatedResume, { threadId: 'task', modelSelection: { providerName: 'openAICompatible', modelName: 'gpt-4.1' }, modelSelectionOptions: snapshot.model.modelSelectionOptions, instructionSnapshot: snapshot, callThisToolFirst: unrelatedResumeMessages[3] });
		assert.deepStrictEqual({ unrelatedRuns, unrelatedConversions, unrelatedSends, target: unrelatedResumeMessages.at(-1), error: unrelatedStream.task.error.message }, { unrelatedRuns: 0, unrelatedConversions: 0, unrelatedSends: 0, target: { role: 'tool', type: 'skipped', name: 'run_command', content: 'The pending native tool batch no longer matches its declaration.', result: null, id: 'target-0', rawParams: { command: 'echo target', terminalId: 'target-0' }, mcpServerName: undefined, batchId: 'target', batchOrdinal: 0 }, error: 'The pending native tool batch no longer matches its declaration.' });
		const unrelatedRestored: any[] = makeUnrelatedMalformedTarget(); const unrelatedRestoredStream = restoreState(unrelatedRestored);
		assert.deepStrictEqual({ target: unrelatedRestored.at(-1), stream: unrelatedRestoredStream.task }, { target: { role: 'tool', type: 'skipped', name: 'run_command', content: 'Native tool batch could not be resumed after restart.', result: null, id: 'target-0', rawParams: { command: 'echo target', terminalId: 'target-0' }, mcpServerName: undefined, batchId: 'target', batchOrdinal: 0 }, stream: undefined });
		const unclosedBeforeTarget: any[] = [
			{ role: 'user', content: 'unclosed other batch', displayContent: 'unclosed other batch' },
			{ role: 'assistant', displayContent: '', reasoning: '', anthropicReasoning: null, toolBatch: { version: 1, batchId: 'other-open', calls: [{ id: 'other-0', name: 'run_command', rawParams: { command: 'echo other', terminalId: 'other-0' } }] } },
			{ role: 'tool', type: 'tool_request', name: 'run_command', params: { command: 'echo other', terminalId: 'other-0' }, content: '(Awaiting user permission...)', result: null, id: 'other-0', rawParams: { command: 'echo other', terminalId: 'other-0' }, mcpServerName: undefined, batchId: 'other-open', batchOrdinal: 0 },
			{ role: 'assistant', displayContent: '', reasoning: '', anthropicReasoning: null, toolBatch: { version: 1, batchId: 'target-open', calls: [{ id: 'target-open-0', name: 'run_command', rawParams: { command: 'echo target', terminalId: 'target-open-0' } }] } },
			{ role: 'tool', type: 'tool_request', name: 'run_command', params: { command: 'echo target', terminalId: 'target-open-0' }, content: '(Awaiting user permission...)', result: null, id: 'target-open-0', rawParams: { command: 'echo target', terminalId: 'target-open-0' }, mcpServerName: undefined, batchId: 'target-open', batchOrdinal: 0 },
		];
		const unclosedStream: any = {}; let unclosedRuns = 0; let unclosedConversions = 0; let unclosedSends = 0;
		const unclosedReceiver: any = { state: { allThreads: { task: { messages: unclosedBeforeTarget, state: {}, filesWithUserChanges: new Set<string>() } } }, streamState: unclosedStream, _agentControlGeneration: new Map([['task', 0]]), _parentRunTokenOfThread: new Map(), _agentDelegationAuthorityOfThread: new Map(), _settingsService: { state: { globalSettings: { chatMode: 'agent' } } }, _convertToLLMMessagesService: { prepareLLMChatMessages: async () => { unclosedConversions++; return { messages: [], separateSystemMessage: false }; } }, _llmMessageService: { sendLLMMessage: () => { unclosedSends++; throw new Error('unclosed prior native batch must not send'); }, abort() { } }, _mcpService: { getMCPTools: () => [] }, _metricsService: { capture() { } }, _computeMCPServerOfToolName: () => undefined, _setStreamState(id: string, value: any) { unclosedStream[id] = value; }, _editMessageInThread(_id: string, index: number, message: any) { unclosedBeforeTarget[index] = message; }, _addMessageToThread(_id: string, message: any) { unclosedBeforeTarget.push(message); }, _terminalizeBatchTailAfter(...args: any[]) { return (ChatThreadService.prototype as any)._terminalizeBatchTailAfter.call(this, ...args); }, _runToolCall: async () => { unclosedRuns++; return {}; } };
		await runChatAgent(unclosedReceiver, { threadId: 'task', modelSelection: { providerName: 'openAICompatible', modelName: 'gpt-4.1' }, modelSelectionOptions: snapshot.model.modelSelectionOptions, instructionSnapshot: snapshot, callThisToolFirst: unclosedBeforeTarget.at(-1) });
		assert.deepStrictEqual({ unclosedRuns, unclosedConversions, unclosedSends, target: unclosedBeforeTarget.at(-1).type, hasParams: Object.prototype.hasOwnProperty.call(unclosedBeforeTarget.at(-1), 'params') }, { unclosedRuns: 0, unclosedConversions: 0, unclosedSends: 0, target: 'skipped', hasParams: false });

		const pausedMessages: any[] = [
			{ role: 'user', content: 'two closed native batches before approval', displayContent: 'two closed native batches before approval' },
			{ role: 'assistant', displayContent: '', reasoning: '', anthropicReasoning: null, toolBatch: { version: 1, batchId: 'closed-one', calls: [{ id: 'closed-one-0', name: 'run_command', rawParams: { command: 'echo one', terminalId: 'closed-one-0' } }] } },
			{ role: 'tool', type: 'success', name: 'run_command', params: { command: 'echo one', terminalId: 'closed-one-0' }, content: 'one', result: 'one', id: 'closed-one-0', rawParams: { command: 'echo one', terminalId: 'closed-one-0' }, mcpServerName: undefined, batchId: 'closed-one', batchOrdinal: 0 },
			{ role: 'assistant', displayContent: '', reasoning: '', anthropicReasoning: null, toolBatch: { version: 1, batchId: 'closed-two', calls: [{ id: 'closed-two-0', name: 'run_command', rawParams: { command: 'echo two', terminalId: 'closed-two-0' } }] } },
			{ role: 'tool', type: 'success', name: 'run_command', params: { command: 'echo two', terminalId: 'closed-two-0' }, content: 'two', result: 'two', id: 'closed-two-0', rawParams: { command: 'echo two', terminalId: 'closed-two-0' }, mcpServerName: undefined, batchId: 'closed-two', batchOrdinal: 0 },
			{ role: 'user', content: 'pause on the second native call', displayContent: 'pause on the second native call' },
		];
		const pausedStream: any = {}; const pausedRuns: string[] = []; const completedRuns: string[] = []; const approvedParams: any[] = []; let pausedSends = 0; let pausedConversions = 0;
		const pausedCalls = [
			{ name: 'run_command', id: 'pause-0', rawParams: { command: 'echo complete', terminalId: 'pause-0' } },
			{ name: 'run_command', id: 'pause-1', rawParams: { command: 'echo approve', terminalId: 'pause-1' } },
			{ name: 'run_command', id: 'pause-2', rawParams: { command: 'echo must-not-run', terminalId: 'pause-2' } },
		];
		const paused: any = {
			state: { allThreads: { task: { messages: pausedMessages, state: {}, filesWithUserChanges: new Set<string>() } } }, streamState: pausedStream,
			_agentControlGeneration: new Map([['task', 0]]), _parentRunTokenOfThread: new Map(), _agentDelegationAuthorityOfThread: new Map(),
			_settingsService: { state: { globalSettings: { chatMode: 'agent' } } },
			_toolsService: { validateParams: { run_command: (raw: any) => ({ command: raw.command, terminalId: raw.terminalId }) } },
			_convertToLLMMessagesService: { prepareLLMChatMessages: async () => { pausedConversions++; return { messages: [], separateSystemMessage: false }; } },
			_llmMessageService: { sendLLMMessage: (options: any) => { const send = ++pausedSends; queueMicrotask(() => void options.onFinalMessage(send === 1 ? { fullText: '', fullReasoning: '', toolCalls: pausedCalls, anthropicReasoning: null } : { fullText: 'continued after approval', fullReasoning: '', anthropicReasoning: null })); return `pause-provider-${send}`; }, abort() { } },
			_mcpService: { getMCPTools: () => [] }, _metricsService: { capture() { } },
			_setStreamState(id: string, value: any) { pausedStream[id] = value; }, _addMessageToThread(_id: string, message: any) { pausedMessages.push(message); },
			_runToolCall: async (_id: string, name: string, toolId: string, _mcp: unknown, options: any, _snapshot: unknown, _authority: unknown, _skill: boolean, _generation: number, _current: () => boolean, batchRef: { batchId: string; batchOrdinal: number }) => {
				pausedRuns.push(toolId);
				if (options.preapproved) approvedParams.push(options.validatedParams);
				const awaiting = batchRef.batchOrdinal === 1 && !options.preapproved;
				if (!awaiting) completedRuns.push(toolId);
				const terminal = { role: 'tool', type: awaiting ? 'tool_request' : 'success', name, params: options.validatedParams ?? options.unvalidatedToolParams, content: awaiting ? '(Awaiting user permission...)' : 'completed', result: awaiting ? null : 'completed', id: toolId, rawParams: options.unvalidatedToolParams, mcpServerName: undefined, ...batchRef };
				const existing = pausedMessages.findIndex(message => message.role === 'tool' && message.id === toolId && message.batchId === batchRef.batchId && message.batchOrdinal === batchRef.batchOrdinal);
				if (existing >= 0) pausedMessages[existing] = terminal; else pausedMessages.push(terminal);
				return awaiting ? { awaitingUserApproval: true } : {};
			},
		};
		await runChatAgent(paused, { threadId: 'task', modelSelection: { providerName: 'openAICompatible', modelName: 'gpt-4.1' }, modelSelectionOptions: snapshot.model.modelSelectionOptions, instructionSnapshot: snapshot });
		assert.deepStrictEqual({ sends: pausedSends, conversions: pausedConversions, runs: pausedRuns, running: pausedStream.task.isRunning }, { sends: 1, conversions: 1, runs: ['pause-0', 'pause-1'], running: 'awaiting_user' });
		assert.deepStrictEqual(pausedMessages.filter(message => message.role === 'tool' && message.id.startsWith('pause-')).map(message => [message.id, message.type, message.batchOrdinal]), [['pause-0', 'success', 0], ['pause-1', 'tool_request', 1]]);
		const pausedApproval = pausedMessages.find(message => message.role === 'tool' && message.id === 'pause-1');
		pausedApproval.rawParams = { terminalId: 'pause-1', command: 'echo approve' };
		pausedApproval.params = { terminalId: 'poisoned', command: 'echo must-not-run' };
		await runChatAgent(paused, { threadId: 'task', modelSelection: { providerName: 'openAICompatible', modelName: 'gpt-4.1' }, modelSelectionOptions: snapshot.model.modelSelectionOptions, instructionSnapshot: snapshot, callThisToolFirst: pausedApproval });
		assert.deepStrictEqual({ sends: pausedSends, conversions: pausedConversions, runs: pausedRuns, completedRuns }, { sends: 2, conversions: 2, runs: ['pause-0', 'pause-1', 'pause-1', 'pause-2'], completedRuns: ['pause-0', 'pause-1', 'pause-2'] });
		assert.deepStrictEqual(approvedParams, [{ command: 'echo approve', terminalId: 'pause-1' }], 'resume must revalidate declaration-bound raw arguments instead of trusting persisted params');
		assert.deepStrictEqual(pausedMessages.filter(message => message.role === 'tool' && message.id.startsWith('pause-')).map(message => [message.id, message.type, message.batchOrdinal]), [['pause-0', 'success', 0], ['pause-1', 'success', 1], ['pause-2', 'success', 2]]);
	});

	test('stops the parent loop after three identical normalized tool failures without a fourth provider send', async () => {
		const snapshot = instructionSnapshot(); const messages: any[] = [{ role: 'user', content: 'start', displayContent: 'start' }]; const streamState: any = {}; let sends = 0; let toolRuns = 0;
		const receiver: any = {
			state: { allThreads: { task: { messages, state: {}, filesWithUserChanges: new Set<string>() } } }, streamState,
			_agentControlGeneration: new Map([['task', 0]]), _parentRunTokenOfThread: new Map(), _agentDelegationAuthorityOfThread: new Map(),
			_settingsService: { state: { globalSettings: { chatMode: 'agent' } } }, _convertToLLMMessagesService: { prepareLLMChatMessages: async () => ({ messages: [], separateSystemMessage: false }) },
			_llmMessageService: { sendLLMMessage: (options: any) => { const n = ++sends; queueMicrotask(() => void options.onFinalMessage({ fullText: '', fullReasoning: '', toolCalls: [{ name: 'run_command', id: `provider-${n}`, rawParams: n % 2 ? { command: 'false', terminalId: `generated-${n}`, cwd: null } : { cwd: null, terminalId: `generated-${n}`, command: 'false' } }], anthropicReasoning: null })); return `request-${n}`; }, abort() { } },
			_mcpService: { getMCPTools: () => [] }, _metricsService: { capture() { } }, _setStreamState(threadId: string, value: any) { streamState[threadId] = value; }, _addMessageToThread(_threadId: string, message: any) { messages.push(message); }, _terminalizeBatchTailAfter(...args: any[]) { return (ChatThreadService.prototype as any)._terminalizeBatchTailAfter.call(this, ...args); },
			_runToolCall: async () => ({ failure: 'terminal_exit_1', validatedParams: { command: 'false', cwd: null, terminalId: `validated-${++toolRuns}` }, interrupted: false }),
		};
		await runChatAgent(receiver, { threadId: 'task', modelSelection: { providerName: 'openAICompatible', modelName: 'gpt-4.1' }, modelSelectionOptions: snapshot.model.modelSelectionOptions, instructionSnapshot: snapshot });
		assert.strictEqual(sends, 3); assert.strictEqual(toolRuns, 3); assert.strictEqual(streamState.task.error.message, 'The same tool failed three times. Change the request or recover the command before continuing.');

		const batchId = 'resumed-identical-failures';
		const calls = Array.from({ length: 4 }, (_, index) => ({ name: 'run_command', id: `resumed-failure-${index}`, rawParams: { command: 'false', cwd: null, terminalId: `raw-${index}` } }));
		const resumedMessages: any[] = [
			{ role: 'user', content: 'resume failures', displayContent: 'resume failures' },
			{ role: 'assistant', displayContent: '', reasoning: '', anthropicReasoning: null, toolBatch: { version: 1, batchId, calls } },
			{ role: 'tool', type: 'tool_request', name: 'run_command', params: { command: 'false', cwd: null, terminalId: 'validated-0' }, content: '(Awaiting user permission...)', result: null, id: calls[0].id, rawParams: calls[0].rawParams, mcpServerName: undefined, batchId, batchOrdinal: 0 },
		];
		const resumedState: any = {}; let resumedSends = 0; let resumedRuns = 0;
		const resumed: any = {
			state: { allThreads: { task: { messages: resumedMessages, state: {}, filesWithUserChanges: new Set<string>() } } }, streamState: resumedState,
			_agentControlGeneration: new Map([['task', 0]]), _parentRunTokenOfThread: new Map(), _agentDelegationAuthorityOfThread: new Map(),
			_settingsService: { state: { globalSettings: { chatMode: 'agent' } } }, _convertToLLMMessagesService: { prepareLLMChatMessages: async () => ({ messages: [], separateSystemMessage: false }) },
			_toolsService: { validateParams: { run_command: (raw: any) => ({ command: raw.command, cwd: raw.cwd, terminalId: raw.terminalId }) } },
			_llmMessageService: { sendLLMMessage: () => { resumedSends++; throw new Error('provider must not run after resumed identical-failure circuit'); }, abort() { } },
			_mcpService: { getMCPTools: () => [] }, _metricsService: { capture() { } }, _computeMCPServerOfToolName: () => undefined,
			_setStreamState(id: string, value: any) { resumedState[id] = value; }, _addMessageToThread(_id: string, message: any) { resumedMessages.push(message); }, _editMessageInThread(_id: string, index: number, message: any) { resumedMessages[index] = message; },
			_terminalizeBatchTailAfter(...args: any[]) { return (ChatThreadService.prototype as any)._terminalizeBatchTailAfter.call(this, ...args); },
			_runToolCall: async (_id: string, name: string, toolId: string, _mcp: unknown, options: any, _snapshot: unknown, _authority: unknown, _skill: boolean, _generation: number, _current: () => boolean, batchRef: { batchId: string; batchOrdinal: number }) => {
				resumedRuns++; const validatedParams = { command: 'false', cwd: null, terminalId: `validated-${batchRef.batchOrdinal}` };
				const terminal = { role: 'tool', type: 'tool_error', name, params: validatedParams, content: 'terminal failed', result: 'terminal failed', id: toolId, rawParams: options.unvalidatedToolParams, mcpServerName: undefined, ...batchRef };
				const existing = resumedMessages.findIndex(message => message.role === 'tool' && message.id === toolId && message.batchId === batchRef.batchId && message.batchOrdinal === batchRef.batchOrdinal);
				if (existing >= 0) resumedMessages[existing] = terminal; else resumedMessages.push(terminal);
				return { failure: 'terminal_exit_1', validatedParams };
			},
		};
		await runChatAgent(resumed, { threadId: 'task', modelSelection: { providerName: 'openAICompatible', modelName: 'gpt-4.1' }, modelSelectionOptions: snapshot.model.modelSelectionOptions, instructionSnapshot: snapshot, callThisToolFirst: resumedMessages[2] });
		assert.strictEqual(resumedRuns, 3); assert.strictEqual(resumedSends, 0); assert.strictEqual(resumedState.task.error.message, 'The same tool failed three times. Change the request or recover the command before continuing.');
		assert.deepStrictEqual(resumedMessages.filter(message => message.role === 'tool').map(message => [message.id, message.type, message.batchOrdinal]), [['resumed-failure-0', 'tool_error', 0], ['resumed-failure-1', 'tool_error', 1], ['resumed-failure-2', 'tool_error', 2], ['resumed-failure-3', 'skipped', 3]]);
		assert.strictEqual(Object.prototype.hasOwnProperty.call(resumedMessages.at(-1), 'params'), false);
	});

	test('different failures, different arguments, and successful calls do not trip the failure circuit', async () => {
		const snapshot = instructionSnapshot();
		for (const [label, outcomes] of [
			['different failures', [{ failure: 'terminal_exit_1', params: { command: 'false', cwd: null, terminalId: 'a' } }, { failure: 'terminal_exit_2', params: { command: 'false', cwd: null, terminalId: 'b' } }, { failure: 'terminal_exit_3', params: { command: 'false', cwd: null, terminalId: 'c' } }]],
			['different arguments', [{ failure: 'terminal_exit_1', params: { command: 'false-a', cwd: null, terminalId: 'a' } }, { failure: 'terminal_exit_1', params: { command: 'false-b', cwd: null, terminalId: 'b' } }, { failure: 'terminal_exit_1', params: { command: 'false-c', cwd: null, terminalId: 'c' } }]],
			['successful calls', [{ params: { command: 'false', cwd: null, terminalId: 'a' } }, { params: { command: 'false', cwd: null, terminalId: 'b' } }, { params: { command: 'false', cwd: null, terminalId: 'c' } }]],
		] as const) {
			const streamState: any = {}; let sends = 0; let runs = 0;
			const receiver: any = { state: { allThreads: { task: { messages: [{ role: 'user', content: label }], state: {}, filesWithUserChanges: new Set<string>() } } }, streamState, _agentControlGeneration: new Map([['task', 0]]), _parentRunTokenOfThread: new Map(), _agentDelegationAuthorityOfThread: new Map(), _settingsService: { state: { globalSettings: { chatMode: 'agent' } } }, _convertToLLMMessagesService: { prepareLLMChatMessages: async () => ({ messages: [], separateSystemMessage: false }) }, _llmMessageService: { sendLLMMessage: (options: any) => { const n = ++sends; queueMicrotask(() => void options.onFinalMessage({ fullText: '', fullReasoning: '', toolCalls: n <= 3 ? [{ name: 'run_command', id: `${label}-${n}`, rawParams: outcomes[n - 1].params }] : undefined, anthropicReasoning: null })); return `request-${n}`; }, abort() { } }, _mcpService: { getMCPTools: () => [] }, _metricsService: { capture() { } }, _setStreamState(id: string, value: any) { streamState[id] = value; }, _addMessageToThread() { }, _runToolCall: async () => { const outcome = outcomes[runs++]; return { interrupted: false, ...(outcome.failure ? { failure: outcome.failure } : {}), validatedParams: outcome.params }; } };
			await runChatAgent(receiver, { threadId: 'task', modelSelection: { providerName: 'openAICompatible', modelName: 'gpt-4.1' }, modelSelectionOptions: snapshot.model.modelSelectionOptions, instructionSnapshot: snapshot });
			assert.strictEqual(sends, 4, label); assert.strictEqual(runs, 3, label); assert.strictEqual(streamState.task.error, undefined, label);
		}
	});

	test('publishes first provider retry before retrying without replaying user or tool effects', async () => {
		const snapshot = instructionSnapshot(); const messages: any[] = [{ role: 'user', content: 'original', displayContent: 'original' }]; const states: any[] = []; let sends = 0; let toolEffects = 0; const started = Date.now();
		const receiver: any = { state: { allThreads: { task: { messages, state: {}, filesWithUserChanges: new Set<string>() } } }, streamState: {}, _agentControlGeneration: new Map([['task', 0]]), _parentRunTokenOfThread: new Map(), _agentDelegationAuthorityOfThread: new Map(), _settingsService: { state: { globalSettings: { chatMode: 'agent' } } }, _convertToLLMMessagesService: { prepareLLMChatMessages: async () => ({ messages: [], separateSystemMessage: false }) }, _llmMessageService: { sendLLMMessage: (options: any) => { const n = ++sends; queueMicrotask(() => n === 1 ? void options.onError({ message: 'transient', fullError: null }) : void options.onFinalMessage({ fullText: 'recovered', fullReasoning: '', anthropicReasoning: null })); return `request-${n}`; }, abort() { } }, _mcpService: { getMCPTools: () => [] }, _metricsService: { capture() { } }, _setStreamState(id: string, value: any) { this.streamState[id] = value; states.push(value); }, _addMessageToThread(_id: string, message: any) { messages.push(message); }, _runToolCall: async () => { toolEffects++; return {}; } };
		await runChatAgent(receiver, { threadId: 'task', modelSelection: { providerName: 'openAICompatible', modelName: 'gpt-4.1' }, modelSelectionOptions: snapshot.model.modelSelectionOptions, instructionSnapshot: snapshot });
		const retry = states.find(state => state?.isRunning === 'idle' && state.retry)?.retry;
		assert.deepStrictEqual({ attempt: retry?.attempt, maxAttempts: retry?.maxAttempts }, { attempt: 1, maxAttempts: 3 }); assert.ok(retry.retryAt >= started + 2_400);
		assert.strictEqual(sends, 2); assert.strictEqual(toolEffects, 0); assert.strictEqual(messages.filter(message => message.role === 'user').length, 1); assert.strictEqual(messages.at(-1).displayContent, 'recovered');
	});

	test('persists an idle blank-thread Send before preparation and exposes it dormant after the sending window closes', async () => {
		const storage = new LifecycleBrokerStorage(); let ids = 0; const core = new PendingChatInputBrokerCore(storage, () => 100, () => `journey-${++ids}`);
		const instructionGate = deferred<void>();
		const second = createPendingInboxReceiver({ storage, core, ctx: 'window:2', blank: true, instructionGate: instructionGate.promise });
		const accepted = await second.receiver.submitPendingInput({ threadId: 'task', text: 'survive second window', mode: 'queue', selections: [] });
		assert.ok(accepted);
		await eventually(() => second.receiver.getPendingChatInputs('task')[0]?.phase === 'claiming', 'second window did not claim its durable input');
		assert.strictEqual(second.providerStarts, 0);
		await second.client.release();
		await eventually(() => second.receiver.getPendingChatInputs('task')[0]?.phase === 'dormant', 'disconnect did not demote the exact input');
		const raw = storage.get(pendingChatInputThreadStorageKey('task'))!;
		const restoredThread = JSON.parse(raw).thread;
		const third = createPendingInboxReceiver({ storage, core, ctx: 'window:3', thread: restoredThread });
		await third.receiver._ensurePendingInputBrokerReady();
		assert.deepStrictEqual(third.receiver.getPendingChatInputs('task').map((row: any) => [row.text, row.phase]), [['survive second window', 'dormant']]);
		assert.strictEqual(third.providerStarts, 0);
		const dormant = third.receiver.getPendingChatInputs('task')[0]; assert.strictEqual(await third.receiver.resumePendingInput('task', accepted.id, pendingChatInputFingerprint(dormant)), true);
		await eventually(() => third.providerStarts === 1 && third.receiver.getPendingChatInputs('task').length === 0, 'third window did not settle the resumed input').catch(error => { throw new Error(`${error instanceof Error ? error.message : String(error)}; ${third.warnings.join('; ')}`); });
		assert.deepStrictEqual(third.receiver.state.allThreads.task.messages.filter((message: any) => message.role === 'user').map((message: any) => [message.displayContent, message.pendingInputId]), [['survive second window', accepted.id]]);
		instructionGate.resolve(undefined); await flushMicrotasks(); await flushMicrotasks();
		assert.strictEqual(second.providerStarts, 0);
	});

	test('establishes the exact claimed generation for the first same-window idle Send', async () => {
		const fixture = createPendingInboxReceiver({ blank: true });
		fixture.receiver._agentControlGeneration.delete('task');
		const accepted = await fixture.receiver.submitPendingInput({ threadId: 'task', text: 'first idle send', mode: 'queue', selections: [] });
		assert.ok(accepted);
		await eventually(() => fixture.providerStarts === 1 && fixture.receiver.getPendingChatInputs('task').length === 0, 'first idle Send did not settle and enter the provider once');
		assert.strictEqual(fixture.receiver._agentControlGeneration.get('task'), accepted.generation);
		assert.deepStrictEqual(fixture.receiver.state.allThreads.task.messages.filter((message: any) => message.role === 'user').map((message: any) => [message.displayContent, message.pendingInputId]), [['first idle send', accepted.id]]);
	});

	test('recovers one authoritative history row without appending it twice before provider continuation', async () => {
		const fixture = createPendingInboxReceiver();
		fixture.receiver._runQuiescenceOfThread.set('task', { runId: 'hold', generation: 0, settled: new Promise<void>(() => { }) });
		const accepted = await fixture.receiver.submitPendingInput({ threadId: 'task', text: 'already durable', mode: 'queue', selections: [] });
		assert.ok(accepted);
		const thread = { ...fixture.receiver.state.allThreads.task, messages: [{ role: 'user', content: 'already durable', displayContent: 'already durable', pendingInputId: accepted.id, pendingInputSelectionsFingerprint: pendingChatInputSelectionsFingerprint([]), state: { stagingSelections: [], isBeingEdited: false } }] };
		fixture.storage.storeUser(pendingChatInputThreadStorageKey('task'), JSON.stringify({ version: 1, revision: 2, thread }));
		fixture.receiver._runQuiescenceOfThread.delete('task');
		await fixture.receiver._drainPendingChatInputs('task');
		await eventually(() => fixture.providerStarts === 1, 'recovered row did not continue once');
		assert.strictEqual(fixture.receiver.state.allThreads.task.messages.filter((message: any) => message.pendingInputId === accepted.id).length, 1);
		assert.deepStrictEqual(fixture.receiver.getPendingChatInputs('task'), []);
	});

	test('fails closed on missing, tampered, or duplicate pending-input history provenance', async () => {
		for (const kind of ['missing', 'tampered', 'duplicate'] as const) {
			const fixture = createPendingInboxReceiver();
			fixture.receiver._runQuiescenceOfThread.set('task', { runId: 'hold', generation: 0, settled: new Promise<void>(() => { }) });
			const accepted = await fixture.receiver.submitPendingInput({ threadId: 'task', text: `corrupt ${kind}`, mode: 'queue', selections: [] }); assert.ok(accepted);
			const base: any = { role: 'user', content: accepted.text, displayContent: accepted.text, pendingInputId: accepted.id, state: { stagingSelections: [], isBeingEdited: false } };
			if (kind !== 'missing') base.pendingInputSelectionsFingerprint = kind === 'tampered' ? 'wrong' : pendingChatInputSelectionsFingerprint([]);
			const messages = kind === 'duplicate' ? [base, { ...base }] : [base];
			fixture.storage.storeUser(pendingChatInputThreadStorageKey('task'), JSON.stringify({ version: 1, revision: 2, thread: { ...fixture.receiver.state.allThreads.task, messages } }));
			fixture.receiver._runQuiescenceOfThread.delete('task'); await fixture.receiver._drainPendingChatInputs('task');
			assert.strictEqual(fixture.providerStarts, 0, kind);
			await eventually(() => fixture.receiver.getPendingChatInputs('task')[0]?.phase === 'dormant', `${kind} corrupt history claim did not settle dormant`);
		}
	});

	test('keeps broker FIFO authoritative through async edit and reorder before draining exactly once each', async () => {
		const fixture = createPendingInboxReceiver();
		fixture.receiver._runQuiescenceOfThread.set('task', { runId: 'hold', generation: 0, settled: new Promise<void>(() => { }) });
		const first = await fixture.receiver.submitPendingInput({ threadId: 'task', text: 'first', mode: 'queue', selections: [] });
		const second = await fixture.receiver.submitPendingInput({ threadId: 'task', text: 'second', mode: 'queue', selections: [] });
		const third = await fixture.receiver.submitPendingInput({ threadId: 'task', text: 'third', mode: 'queue', selections: [] });
		assert.ok(first && second && third);
		const before = fixture.receiver.getPendingChatInputs('task'); const thirdFingerprint = pendingChatInputFingerprint(before.find((row: any) => row.id === third.id)); const threadFingerprint = pendingChatInputThreadFingerprint(before);
		assert.strictEqual(await fixture.receiver.reorderPendingInput('task', third.id, thirdFingerprint, threadFingerprint, first.id), true);
		const reorderedThird = fixture.receiver.getPendingChatInputs('task').find((row: any) => row.id === third.id); assert.strictEqual(await fixture.receiver.editPendingInput('task', third.id, pendingChatInputFingerprint(reorderedThird), 'third edited', []), true);
		assert.deepStrictEqual(fixture.receiver.getPendingChatInputs('task').map((row: any) => row.text), ['third edited', 'first', 'second']);
		fixture.receiver._runQuiescenceOfThread.delete('task'); await fixture.receiver._drainPendingChatInputs('task');
		await eventually(() => fixture.providerStarts === 3 && fixture.receiver.getPendingChatInputs('task').length === 0, 'FIFO did not drain all rows');
		assert.deepStrictEqual(fixture.receiver.state.allThreads.task.messages.filter((message: any) => message.role === 'user').map((message: any) => message.displayContent), ['third edited', 'first', 'second']);
	});

	test('restores a fenced message edit and lets the foreign Queue owner drain once', async () => {
		const childActivities = { version: 1 as const, records: [{ generation: 0, childId: 'old-child', depth: 1, status: 'completed' as const, capabilityProfile: 'read_only' as const, summary: 'old child summary', queuedMs: 0, runningMs: 1, totalMs: 1, anchor: { toolId: 'old-spawn' } }], omitted: 0, retentionSaturated: false };
		const thread = { ...lifecycleThread(), messages: [{ role: 'user', content: 'old question', displayContent: 'old question', selections: [], state: { stagingSelections: [] } }, { role: 'assistant', displayContent: 'old answer', reasoning: '', anthropicReasoning: null }] as any[], childActivities };
		const storage = new LifecycleBrokerStorage(); let ids = 0; const core = new PendingChatInputBrokerCore(storage, () => 100, () => `edit-fence-${++ids}`);
		const first = createPendingInboxReceiver({ storage, core, ctx: 'window:1', thread }); const second = createPendingInboxReceiver({ storage, core, ctx: 'window:2', thread });
		await first.receiver._ensurePendingInputBrokerReady(); await second.receiver._ensurePendingInputBrokerReady();
		second.receiver._wakePendingChatInputs = () => { }; second.receiver._drainPendingChatInputs = async () => { };
		const submitted = await second.client.submit({ threadId: 'task', text: 'foreign FIFO', selections: [], mode: 'queue', phase: 'queued', ownerProjectRoot: 'file:///workspace', trustedAtSubmit: true, generation: 0 }); assert.ok(submitted.ok);
		const beforeRaw = storage.get(pendingChatInputThreadStorageKey('task'))!; const messagesBefore = first.receiver.state.allThreads.task.messages; const childActivitiesBefore = first.receiver.state.allThreads.task.childActivities;
		assert.strictEqual(await first.receiver.editUserMessageAndStreamResponse({ userMessage: 'edited retry text', messageIdx: 0, threadId: 'task' }), false);
		assert.strictEqual(first.providerStarts, 0); const afterRejectedEdit = JSON.parse(storage.get(pendingChatInputThreadStorageKey('task'))!); const beforeRejectedEdit = JSON.parse(beforeRaw);
		assert.deepStrictEqual(afterRejectedEdit.thread.messages, beforeRejectedEdit.thread.messages); assert.deepStrictEqual(afterRejectedEdit.thread.childActivities, beforeRejectedEdit.thread.childActivities);
		assert.strictEqual(first.receiver.state.allThreads.task.messages, messagesBefore); assert.strictEqual(first.receiver.state.allThreads.task.childActivities, childActivitiesBefore);
		assert.deepStrictEqual(first.receiver.state.allThreads.task.messages.map((message: any) => message.displayContent), ['old question', 'old answer']); assert.deepStrictEqual(first.receiver.state.allThreads.task.childActivities, childActivities);
		assert.deepStrictEqual(first.receiver.getPendingChatInputs('task').map((row: any) => [row.text, row.phase]), [['foreign FIFO', 'queued']]);
		await (ChatThreadService.prototype as any)._drainPendingChatInputs.call(second.receiver, 'task');
		await eventually(() => second.providerStarts === 1 && second.receiver.getPendingChatInputs('task').length === 0, 'foreign Queue owner did not drain exactly once');
		assert.deepStrictEqual(second.receiver.state.allThreads.task.messages.filter((message: any) => message.role === 'user').map((message: any) => message.displayContent), ['old question', 'foreign FIFO']);
	});

	test('commits one successful message edit only after its direct lease and prunes the old tail ledger', async () => {
		const thread = { ...lifecycleThread(), messages: [{ role: 'user', content: 'old question', displayContent: 'old question', selections: [], state: { stagingSelections: [] } }, { role: 'assistant', displayContent: 'old answer', reasoning: '', anthropicReasoning: null }] as any[], childActivities: { version: 1 as const, records: [{ generation: 0, childId: 'old-child', depth: 1, status: 'completed' as const, capabilityProfile: 'read_only' as const, summary: 'old child summary', queuedMs: 0, runningMs: 1, totalMs: 1, anchor: { toolId: 'old-spawn' } }], omitted: 0, retentionSaturated: false }, state: { ...lifecycleThread().state, focusedMessageIdx: 0 } };
		const fixture = createPendingInboxReceiver({ thread: thread as any }); await fixture.receiver._ensurePendingInputBrokerReady();
		assert.strictEqual(await fixture.receiver.editUserMessageAndStreamResponse({ userMessage: 'edited question', messageIdx: 0, threadId: 'task' }), true);
		await eventually(() => fixture.providerStarts === 1, 'edited turn did not start exactly one provider');
		const durable = JSON.parse(fixture.storage.get(pendingChatInputThreadStorageKey('task'))!).thread;
		assert.deepStrictEqual(durable.messages.map((message: any) => [message.role, message.displayContent]), [['user', 'edited question']]); assert.deepStrictEqual(durable.childActivities.records, []); assert.strictEqual(durable.state.focusedMessageIdx, undefined);
		assert.deepStrictEqual(fixture.receiver.state.allThreads.task.messages.map((message: any) => [message.role, message.displayContent]), [['user', 'edited question']]); assert.strictEqual(fixture.providerStarts, 1);
	});

	test('adopts a deferred external winner after a rejected direct edit tears down its starting marker', async () => {
		const fixture = createPendingInboxReceiver(); await fixture.receiver._ensurePendingInputBrokerReady(); const key = pendingChatInputThreadStorageKey('task');
		fixture.receiver.state.allThreads.task.messages = [{ role: 'user', content: 'old', displayContent: 'old', selections: [], state: { stagingSelections: [] } }]; const baseline = JSON.stringify({ version: 1, revision: 2, thread: fixture.receiver.state.allThreads.task }); fixture.storage.storeUser(key, baseline); fixture.receiver._threadStorageAuthoritativeRaw.set('task', baseline);
		const winner = { ...fixture.receiver.state.allThreads.task, messages: [{ role: 'user', content: 'winner', displayContent: 'winner', selections: [], state: { stagingSelections: [] } }] }; const winnerRaw = JSON.stringify({ version: 1, revision: 3, thread: winner });
		fixture.client.authorizeDirectHistoryAppend = async () => {
			fixture.storage.storeUser(key, winnerRaw); (ChatThreadService.prototype as any)._applyExternalThreadRecord.call(fixture.receiver, key);
			return { ok: false, reason: 'append_in_progress', snapshot: fixture.client.snapshot };
		};
		assert.strictEqual(await fixture.receiver.editUserMessageAndStreamResponse({ userMessage: 'must stay in editor', messageIdx: 0, threadId: 'task' }), false);
		assert.deepStrictEqual(fixture.receiver.state.allThreads.task.messages.map((message: any) => message.displayContent), ['winner']); assert.strictEqual(fixture.receiver._deferredExternalThreadKey.has('task'), false); assert.strictEqual(fixture.providerStarts, 0);
	});

	test('fences a stale active tool on CAS conflict and adopts the winner without late history', async () => {
		const storage = new LifecycleBrokerStorage(); let ids = 0; const core = new PendingChatInputBrokerCore(storage, () => 100, () => `cas-${++ids}`);
		const first = createPendingInboxReceiver({ storage, core, ctx: 'window:1' }); const second = createPendingInboxReceiver({ storage, core, ctx: 'window:2' });
		await first.receiver._ensurePendingInputBrokerReady(); await second.receiver._ensurePendingInputBrokerReady();
		const baseline = storage.get(pendingChatInputThreadStorageKey('task'))!;
		first.receiver._threadStorageAuthoritativeRaw.set('task', baseline); second.receiver._threadStorageAuthoritativeRaw.set('task', baseline);
		let cancellations = 0; let interrupts = 0;
		second.receiver._activeToolCardReceiptsOfThread = new Map([['task', new Map([['receipt', { cancelling: false, cancel: () => { cancellations++; } }]])]]);
		second.receiver.streamState.task = { isRunning: 'tool', interrupt: Promise.resolve(() => { interrupts++; }) };
		delete second.receiver._revokeAgentDelegation;
		(ChatThreadService.prototype as any)._addMessageToThread.call(first.receiver, 'task', { role: 'assistant', displayContent: 'winner', reasoning: '', anthropicReasoning: null });
		assert.strictEqual(await first.receiver._awaitThreadStorageWrites('task'), true);
		(ChatThreadService.prototype as any)._addMessageToThread.call(second.receiver, 'task', { role: 'assistant', displayContent: 'stale', reasoning: '', anthropicReasoning: null });
		assert.strictEqual(await second.receiver._awaitThreadStorageWrites('task'), false);
		await eventually(() => interrupts === 1, 'CAS conflict did not interrupt the stale operation');
		const durable = JSON.parse(storage.get(pendingChatInputThreadStorageKey('task'))!).thread;
		assert.strictEqual(cancellations, 1); assert.strictEqual(second.receiver._agentControlGeneration.get('task'), 1);
		assert.deepStrictEqual(durable.messages.map((message: any) => message.displayContent), ['winner']);
		assert.deepStrictEqual(second.receiver.state.allThreads.task.messages.map((message: any) => message.displayContent), ['winner']);
	});

	test('keeps rendered pending-action base tokens across async readiness and rejects stale mutations', async () => {
		const fixture = createPendingInboxReceiver(); fixture.receiver._runQuiescenceOfThread.set('task', { runId: 'hold', generation: 0, settled: new Promise<void>(() => { }) });
		const rows = [] as any[]; for (const text of ['edit', 'delete', 'move', 'resume']) { const row = await fixture.receiver.submitPendingInput({ threadId: 'task', text, mode: 'queue', selections: [] }); assert.ok(row); rows.push(row); }
		const gateReady = () => { const gate = deferred<void>(); fixture.receiver._ensurePendingInputBrokerReady = async () => { await gate.promise; return true; }; return gate; };
		let current = fixture.receiver.getPendingChatInputs('task').find((row: any) => row.id === rows[0].id); let gate = gateReady(); const staleEdit = fixture.receiver.editPendingInput('task', current.id, pendingChatInputFingerprint(current), 'stale edit', []); const remoteEdit = await fixture.client.edit('task', current.id, pendingChatInputFingerprint(current), 'remote edit', []); assert.ok(remoteEdit.ok); gate.resolve(undefined); assert.strictEqual(await staleEdit, false);
		current = fixture.receiver.getPendingChatInputs('task').find((row: any) => row.id === rows[1].id); gate = gateReady(); const staleDelete = fixture.receiver.deletePendingInput('task', current.id, pendingChatInputFingerprint(current)); assert.ok((await fixture.client.edit('task', current.id, pendingChatInputFingerprint(current), 'remote before delete', [])).ok); gate.resolve(undefined); assert.strictEqual(await staleDelete, false);
		current = fixture.receiver.getPendingChatInputs('task').find((row: any) => row.id === rows[2].id); const base = pendingChatInputThreadFingerprint(fixture.receiver.getPendingChatInputs('task')); gate = gateReady(); const staleMove = fixture.receiver.reorderPendingInput('task', current.id, pendingChatInputFingerprint(current), base, rows[0].id); const other = fixture.receiver.getPendingChatInputs('task').find((row: any) => row.id === rows[3].id); assert.ok((await fixture.client.edit('task', other.id, pendingChatInputFingerprint(other), 'remote invalidates order base', [])).ok); gate.resolve(undefined); assert.strictEqual(await staleMove, false);
		current = fixture.receiver.getPendingChatInputs('task').find((row: any) => row.id === rows[3].id); assert.ok((await fixture.client.suspend('task', current.id, pendingChatInputFingerprint(current))).ok); current = fixture.receiver.getPendingChatInputs('task').find((row: any) => row.id === rows[3].id); gate = gateReady(); const staleResume = fixture.receiver.resumePendingInput('task', current.id, pendingChatInputFingerprint(current)); assert.ok((await fixture.client.edit('task', current.id, pendingChatInputFingerprint(current), 'remote dormant edit', [])).ok); gate.resolve(undefined); assert.strictEqual(await staleResume, false);
		assert.strictEqual(fixture.providerStarts, 0); assert.ok(fixture.warnings.filter(message => message.includes('changed in another Void window')).length >= 4); assert.deepStrictEqual(fixture.receiver.getPendingChatInputs('task').map((row: any) => row.text), ['remote edit', 'remote before delete', 'move', 'remote dormant edit']);
	});

	test('promotes one exact Steer only at a live parent safe boundary and settles durable history first', async () => {
		const fixture = createPendingInboxReceiver(); await fixture.receiver._ensurePendingInputBrokerReady();
		const parentRun = beginTestParentRun(fixture.receiver, 'task'); fixture.receiver._runQuiescenceOfThread.set('task', { runId: parentRun.runId, generation: parentRun.generation, settled: new Promise<void>(() => { }) });
		const steer = await fixture.receiver.submitPendingInput({ threadId: 'task', text: 'steer at boundary', mode: 'steer', selections: [] }); assert.ok(steer); assert.strictEqual(steer.phase, 'steering');
		assert.strictEqual(await (ChatThreadService.prototype as any)._promoteSteerAtSafeBoundary.call(fixture.receiver, 'task', parentRun), true);
		assert.deepStrictEqual(fixture.receiver.state.allThreads.task.messages.filter((message: any) => message.role === 'user').map((message: any) => message.displayContent), ['steer at boundary']);
		assert.deepStrictEqual(fixture.receiver.getPendingChatInputs('task'), []);
	});

	test('closes a terminal parent before ACK and converts its undelivered Steer to ordinary FIFO', async () => {
		const fixture = createPendingInboxReceiver(); await fixture.receiver._ensurePendingInputBrokerReady();
		const parentRun = beginTestParentRun(fixture.receiver, 'task'); await establishLifecycleHistoryRun(fixture, parentRun.runId, parentRun.generation); fixture.receiver._runQuiescenceOfThread.set('task', { runId: parentRun.runId, generation: parentRun.generation, settled: Promise.resolve() });
		const steer = await fixture.receiver.submitPendingInput({ threadId: 'task', text: 'release after close', mode: 'steer', selections: [] }); assert.ok(steer);
		fixture.receiver._runQuiescenceOfThread.delete('task'); await (ChatThreadService.prototype as any)._releaseUndeliveredSteers.call(fixture.receiver, 'task', parentRun);
		assert.deepStrictEqual(fixture.receiver.getPendingChatInputs('task').map((row: any) => [row.mode, row.phase]), [['queue', 'queued']]);
		await fixture.receiver._drainPendingChatInputs('task'); await eventually(() => fixture.providerStarts === 1, 'released Steer did not drain');
	});

	test('retains terminal quiescence and retries an exact close after pre-execution failure or lost ACK', async () => {
		for (const lostAfterExecution of [false, true]) {
			const fixture = createPendingInboxReceiver(); await fixture.receiver._ensurePendingInputBrokerReady(); const runGate = deferred<void>(); const retryGate = deferred<void>();
			const parentRun = beginTestParentRun(fixture.receiver, 'task'); await establishLifecycleHistoryRun(fixture, parentRun.runId, parentRun.generation); const originalClose = fixture.client.closeRunAndReleaseSteers.bind(fixture.client); let calls = 0; let effective = 0; const closeRunIds: string[] = [];
			fixture.client.closeRunAndReleaseSteers = async (...args: any[]) => {
				calls++; closeRunIds.push(args[1]);
				if (calls === 1 && !lostAfterExecution) return { ok: false, reason: 'backend_unavailable' };
				const result = await originalClose(...args); if (result.ok && effective === 0) effective++;
				return calls === 1 ? { ok: false, reason: 'backend_unavailable', snapshot: result.snapshot } : result;
			};
			fixture.receiver._pendingRunCloseRetryDelay = async () => retryGate.promise;
			(ChatThreadService.prototype as any)._trackParentRun.call(fixture.receiver, 'task', parentRun, runGate.promise);
			const queued = await fixture.receiver.submitPendingInput({ threadId: 'task', text: `after ${lostAfterExecution ? 'lost' : 'pre'} close`, mode: 'queue', selections: [] }); assert.ok(queued); runGate.resolve(undefined);
			await eventually(() => calls === 1, 'first close attempt did not occur'); assert.strictEqual(fixture.receiver._runQuiescenceOfThread.get('task')?.runId, parentRun.runId); assert.strictEqual(fixture.providerStarts, 0);
			retryGate.resolve(undefined); await eventually(() => closeRunIds.filter(runId => runId === parentRun.runId).length === 2 && fixture.providerStarts === 1 && !fixture.receiver._runQuiescenceOfThread.has('task'), 'exact close retry did not release FIFO once');
			assert.deepStrictEqual({ originalCloses: closeRunIds.filter(runId => runId === parentRun.runId).length, effective, rows: fixture.receiver.getPendingChatInputs('task').length, providers: fixture.providerStarts }, { originalCloses: 2, effective: 1, rows: 0, providers: 1 });
		}
	});

	test('keeps a disconnected dormant row blocked when workspace trust no longer matches', async () => {
		const storage = new LifecycleBrokerStorage(); let ids = 0; const core = new PendingChatInputBrokerCore(storage, () => 100, () => `trust-${++ids}`);
		const first = createPendingInboxReceiver({ storage, core, ctx: 'window:1' }); first.receiver._runQuiescenceOfThread.set('task', { runId: 'hold', generation: 0, settled: new Promise<void>(() => { }) });
		const row = await first.receiver.submitPendingInput({ threadId: 'task', text: 'do not cross trust', mode: 'queue', selections: [] }); assert.ok(row); await first.client.release();
		const second = createPendingInboxReceiver({ storage, core, ctx: 'window:2', trusted: false }); await second.receiver._ensurePendingInputBrokerReady();
		assert.strictEqual(second.receiver.getPendingChatInputs('task')[0]?.phase, 'dormant');
		assert.strictEqual(await second.receiver.resumePendingInput('task', row.id, pendingChatInputFingerprint(row)), false); assert.strictEqual(second.providerStarts, 0);
	});

	test('rolls back a failed blank-thread anchor and keeps the unsent composer draft', async () => {
		const storage = new LifecycleBrokerStorage(); const fixture = createPendingInboxReceiver({ storage, blank: true }); await fixture.receiver._ensurePendingInputBrokerReady();
		fixture.receiver.setTransientComposerDraft('task', 'keep exact draft'); storage.failFlushes = 1;
		assert.strictEqual(await fixture.receiver.submitPendingInput({ threadId: 'task', text: 'keep exact draft', mode: 'queue', selections: [] }), undefined);
		assert.strictEqual(fixture.receiver.getTransientComposerDraft('task'), 'keep exact draft'); assert.deepStrictEqual(fixture.receiver.getPendingChatInputs('task'), []);
		assert.strictEqual(storage.get(pendingChatInputThreadStorageKey('task')), undefined);
	});

	test('does not clear draft or create a local row when the broker persistence ACK fails', async () => {
		const storage = new LifecycleBrokerStorage(); const fixture = createPendingInboxReceiver({ storage }); await fixture.receiver._ensurePendingInputBrokerReady();
		fixture.receiver.setTransientComposerDraft('task', 'retry me'); storage.failFlushes = 1;
		assert.strictEqual(await fixture.receiver.submitPendingInput({ threadId: 'task', text: 'retry me', mode: 'queue', selections: [] }), undefined);
		assert.strictEqual(fixture.receiver.getTransientComposerDraft('task'), 'retry me'); assert.deepStrictEqual(fixture.receiver.getPendingChatInputs('task'), []); assert.strictEqual(fixture.providerStarts, 0);
	});

	test('persists assistant, tool, and child-activity mutations in one per-thread CAS order', async () => {
		const fixture = createPendingInboxReceiver(); await fixture.receiver._ensurePendingInputBrokerReady();
		(ChatThreadService.prototype as any)._addMessageToThread.call(fixture.receiver, 'task', { role: 'assistant', displayContent: 'assistant', reasoning: '', anthropicReasoning: null });
		(ChatThreadService.prototype as any)._addMessageToThread.call(fixture.receiver, 'task', { role: 'tool', type: 'success', name: 'read_file', id: 'tool', params: {}, rawParams: {}, content: 'tool', result: 'tool', mcpServerName: undefined });
		(ChatThreadService.prototype as any)._replaceChildActivities.call(fixture.receiver, 'task', Object.freeze({ version: 1, records: Object.freeze([]), omitted: 1, retentionSaturated: false }));
		assert.strictEqual(await fixture.receiver._awaitThreadStorageWrites('task'), true);
		const durable = JSON.parse(fixture.storage.get(pendingChatInputThreadStorageKey('task'))!).thread;
		assert.deepStrictEqual(durable.messages.map((message: any) => [message.role, message.displayContent ?? message.content]), [['assistant', 'assistant'], ['tool', 'tool']]);
		assert.deepStrictEqual({ omitted: durable.childActivities.omitted, saturated: durable.childActivities.retentionSaturated }, { omitted: 1, saturated: false });
	});

	test('coalesces a second delivered-history intersection that arrives during the first reconcile flight', async () => {
		const first = deferred<void>(); let calls = 0;
		const row = (id: string) => ({ id, threadId: 'task', text: id, draft: id, selections: [], mode: 'queue', order: id === 'a' ? 0 : 1, createdAt: 1, ownerProjectRoot: 'file:///workspace', trustedAtSubmit: true, generation: 0, phase: 'dormant' });
		const receiver: any = Object.create(ChatThreadService.prototype); receiver.state = { allThreads: { task: { messages: [{ role: 'user', pendingInputId: 'a' }] } } }; receiver._pendingChatInputsOfThread = new Map([['task', [row('a'), row('b')]]]); receiver._pendingDeliveredReconcileRequested = 0; receiver._pendingDeliveredReconcileFlight = undefined; receiver._pendingDeliveredReconcileRetry = undefined; receiver._ensurePendingInputBrokerReady = async () => true;
		receiver._pendingInputBrokerTestSeam = { reconcileDeliveredPendingInputIds: async () => { calls++; if (calls === 1) { await first.promise; receiver._pendingChatInputsOfThread.set('task', [row('b')]); } else receiver._pendingChatInputsOfThread.clear(); return { ok: true, value: undefined }; } };
		(ChatThreadService.prototype as any)._scheduleDeliveredPendingReconcile.call(receiver); await flushMicrotasks();
		receiver.state.allThreads.task.messages.push({ role: 'user', pendingInputId: 'b' }); (ChatThreadService.prototype as any)._scheduleDeliveredPendingReconcile.call(receiver); first.resolve(undefined);
		await eventually(() => calls === 2 && receiver._pendingChatInputsOfThread.size === 0, 'coalesced intersection was lost');
	});

	test('holds Queue while approval is unresolved and drains once after the boundary clears', async () => {
		const fixture = createPendingInboxReceiver(); fixture.receiver.streamState.task = { isRunning: 'awaiting_user' };
		const row = await fixture.receiver.submitPendingInput({ threadId: 'task', text: 'after approval', mode: 'queue', selections: [] }); assert.ok(row); await flushMicrotasks(); assert.strictEqual(fixture.providerStarts, 0);
		fixture.receiver.streamState.task = undefined; await fixture.receiver._drainPendingChatInputs('task'); await eventually(() => fixture.providerStarts === 1, 'Queue did not wake after approval');
	});

	test('Stop-and-Send advances after its captured run closes before ACK and drains once', async () => {
		const fixture = createPendingInboxReceiver(); const old = { runId: 'old', generation: 0, settled: Promise.resolve() }; fixture.receiver._runQuiescenceOfThread.set('task', old); let aborts = 0; fixture.receiver.abortRunning = async () => { aborts++; };
		const productionWake = (ChatThreadService.prototype as any)._wakePendingChatInputs; fixture.receiver._wakePendingChatInputs = () => { };
		const row = await fixture.receiver.submitPendingInput({ threadId: 'task', text: 'after closed old run', mode: 'stop_and_send', selections: [] }); assert.ok(row); assert.deepStrictEqual([row.targetRunId, row.targetGeneration, row.generation], ['old', 0, 1]);
		fixture.receiver._runQuiescenceOfThread.delete('task'); fixture.receiver._wakePendingChatInputs = productionWake; productionWake.call(fixture.receiver, 'task', row);
		await eventually(() => fixture.providerStarts === 1 && fixture.receiver.getPendingChatInputs('task').length === 0, 'closed-target Stop row did not advance and drain'); assert.strictEqual(aborts, 0); assert.strictEqual(fixture.receiver._agentControlGeneration.get('task'), 1);
	});

	test('a delayed Stop-and-Send snapshot never retargets a replacement run', async () => {
		const fixture = createPendingInboxReceiver(); fixture.receiver._runQuiescenceOfThread.set('task', { runId: 'old', generation: 0, settled: Promise.resolve() }); let aborts = 0; fixture.receiver.abortRunning = async () => { aborts++; };
		const productionWake = (ChatThreadService.prototype as any)._wakePendingChatInputs; fixture.receiver._wakePendingChatInputs = () => { };
		const row = await fixture.receiver.submitPendingInput({ threadId: 'task', text: 'do not abort replacement', mode: 'stop_and_send', selections: [] }); assert.ok(row);
		fixture.receiver._runQuiescenceOfThread.set('task', { runId: 'replacement', generation: 1, settled: Promise.resolve() }); fixture.receiver._agentControlGeneration.set('task', 1); fixture.receiver._wakePendingChatInputs = productionWake;
		(ChatThreadService.prototype as any)._applyPendingChatInputSnapshot.call(fixture.receiver, [row]); await new Promise(resolve => setTimeout(resolve, 0)); assert.strictEqual(aborts, 0); assert.strictEqual(fixture.providerStarts, 0);
		fixture.receiver._runQuiescenceOfThread.delete('task'); productionWake.call(fixture.receiver, 'task', row); await eventually(() => fixture.providerStarts === 1 && fixture.receiver.getPendingChatInputs('task').length === 0, 'replacement-close Stop row did not drain'); assert.strictEqual(aborts, 0);
	});

	test('holds Queue and targetless Steer behind child-only work, then wakes on child terminal', async () => {
		const fixture = createPendingInboxReceiver(); const childViews: any[] = [{ id: 'child-a', generation: 0, status: 'running' }];
		fixture.receiver._agentSubagentService = { getRunViews: () => childViews, cancelParent() { }, forgetParent() { } };
		const queued = await fixture.receiver.submitPendingInput({ threadId: 'task', text: 'after child queue', mode: 'queue', selections: [] });
		const steer = await fixture.receiver.submitPendingInput({ threadId: 'task', text: 'after child steer', mode: 'steer', selections: [] });
		assert.ok(queued && steer); assert.deepStrictEqual([steer.mode, steer.phase], ['queue', 'queued']); await flushMicrotasks(); assert.strictEqual(fixture.providerStarts, 0);
		childViews[0].status = 'completed'; (ChatThreadService.prototype as any)._wakePendingChatInputs.call(fixture.receiver, 'task');
		await eventually(() => fixture.providerStarts === 2 && fixture.receiver.getPendingChatInputs('task').length === 0, 'child terminal did not release queued FIFO');
		assert.deepStrictEqual(fixture.receiver.state.allThreads.task.messages.filter((message: any) => message.role === 'user').map((message: any) => message.displayContent), ['after child queue', 'after child steer']);
	});

	test('wakes a root Agent wait for only the exact persisted Steer run and generation', async () => {
		const fixture = createPendingInboxReceiver(); const active = { runId: 'waiting-parent', generation: 4, settled: new Promise<void>(() => { }) }; fixture.receiver._runQuiescenceOfThread.set('task', active); fixture.receiver._agentControlGeneration.set('task', 4);
		const wakes: Array<[string, number]> = []; fixture.receiver._agentSubagentService = { getRunViews: () => [], wakeParentWait: (threadId: string, generation: number) => { wakes.push([threadId, generation]); return true; }, cancelParent() { }, forgetParent() { } };
		const steer = await fixture.receiver.submitPendingInput({ threadId: 'task', text: 'new evidence while waiting', mode: 'steer', selections: [] }); assert.ok(steer); assert.deepStrictEqual([steer.phase, steer.runId, steer.generation], ['steering', active.runId, active.generation]);
		await eventually(() => wakes.length === 1, 'persisted Steer did not wake the root wait');
		assert.strictEqual((ChatThreadService.prototype as any)._wakeAgentWaitForPendingSteer.call(fixture.receiver, 'task', 4), true); assert.deepStrictEqual(wakes, [['task', 4], ['task', 4]]);
		fixture.receiver._runQuiescenceOfThread.set('task', { runId: 'replacement', generation: 5, settled: Promise.resolve() });
		assert.strictEqual((ChatThreadService.prototype as any)._wakeAgentWaitForPendingSteer.call(fixture.receiver, 'task', 4), false); assert.deepStrictEqual(wakes, [['task', 4], ['task', 4]]);
	});

	test('child-only Stop-and-Send cancels only its captured group and never a later child', async () => {
		for (const delayedReplacement of [false, true]) {
			const fixture = createPendingInboxReceiver(); await fixture.receiver._ensurePendingInputBrokerReady(); let cancels = 0; let coordination: any[] = [{ id: 'old-child', generation: 0, released: false }];
			const source = { runId: `child-parent-${delayedReplacement}`, generation: 0 }; await establishLifecycleHistoryRun(fixture, source.runId, source.generation); fixture.receiver._childGroupSourceOfThread.set('task', source);
			fixture.receiver._agentSubagentService = { getCoordinationRunViews: () => coordination, getRunViews: () => coordination.map(view => ({ ...view, status: 'running' })), cancelParent() { cancels++; coordination = []; }, forgetParent() { } };
			assert.strictEqual(await fixture.receiver._releaseUndeliveredSteers('task', source), true, 'the production child-only path starts from an atomically transferred main owner');
			delete fixture.receiver._revokeAgentDelegation;
			const originalSubmit = fixture.client.submit.bind(fixture.client); const gate = deferred<void>(); let entered = false;
			if (delayedReplacement) fixture.client.submit = async (request: any) => { entered = true; await gate.promise; return originalSubmit(request); };
			const submitted = fixture.receiver.submitPendingInput({ threadId: 'task', text: delayedReplacement ? 'after newer child' : 'replace child', mode: 'stop_and_send', selections: [] });
			if (delayedReplacement) {
				await eventually(() => entered, 'child Stop submit did not reach broker gate'); coordination = [{ id: 'new-child', generation: 1, released: false }]; fixture.receiver._agentControlGeneration.set('task', 1); gate.resolve(undefined);
			}
			const row = await submitted; assert.ok(row); assert.deepStrictEqual([row.targetChildGeneration, row.targetChildIds], [0, ['old-child']]);
			if (delayedReplacement) {
				await flushMicrotasks(); assert.deepStrictEqual({ cancels, providers: fixture.providerStarts }, { cancels: 0, providers: 0 }); coordination = []; (ChatThreadService.prototype as any)._wakePendingChatInputs.call(fixture.receiver, 'task');
			}
			await eventually(() => fixture.providerStarts === 1 && fixture.receiver.getPendingChatInputs('task').length === 0, 'child Stop row did not drain exactly once');
			assert.strictEqual(cancels, delayedReplacement ? 0 : 1);
		}
	});

	test('holds a foreign-window Queue behind the transferred physical child owner and wakes once after release', async () => {
		const storage = new LifecycleBrokerStorage(); let ids = 0; const core = new PendingChatInputBrokerCore(storage, () => 100, () => `cross-child-${++ids}`);
		const first = createPendingInboxReceiver({ storage, core, ctx: 'window:1' }); const second = createPendingInboxReceiver({ storage, core, ctx: 'window:2' });
		await first.receiver._ensurePendingInputBrokerReady(); await second.receiver._ensurePendingInputBrokerReady();
		const direct = await first.client.authorizeDirectHistoryAppend('task', 'parent', [], 'parent-run', 0); assert.ok(direct.ok);
		const parentThread = { ...first.receiver.state.allThreads.task, messages: [{ role: 'user', pendingInputId: direct.value.pendingInputId, pendingInputSelectionsFingerprint: direct.value.selectionsFingerprint, content: 'parent', displayContent: 'parent', selections: [], state: {} }] };
		storage.storeUser(pendingChatInputThreadStorageKey('task'), JSON.stringify({ version: 1, revision: 2, thread: parentThread })); assert.ok((await first.client.verifyDirectHistoryAndRelease('task', direct.value.leaseId)).ok);
		let coordination = [{ id: 'physical-child', generation: 0, released: false }];
		first.receiver._agentSubagentService = { getCoordinationRunViews: () => coordination, getRunViews: () => [{ id: 'physical-child', generation: 0, status: 'running' }], cancelParent() { }, forgetParent() { } };
		const source = { runId: 'parent-run', generation: 0 }; first.receiver._childGroupSourceOfThread.set('task', source);
		assert.strictEqual(await first.receiver._releaseUndeliveredSteers('task', source), true, 'parent close must atomically transfer to the child owner');
		const queued = await second.receiver.submitPendingInput({ threadId: 'task', text: 'after foreign child', mode: 'queue', selections: [] }); assert.ok(queued);
		await flushMicrotasks(); await new Promise(resolve => setTimeout(resolve, 0)); assert.strictEqual(second.providerStarts, 0); assert.strictEqual(second.receiver.getPendingChatInputs('task')[0]?.phase, 'queued');
		coordination = []; const released = await first.receiver._syncActiveChildGroup('task', source); assert.ok(released.ok); assert.strictEqual(released.identity.childIds.length, 0);
		await eventually(() => second.providerStarts === 1 && second.receiver.getPendingChatInputs('task').length === 0, 'foreign Queue did not wake exactly once after physical child release');
		assert.deepStrictEqual(second.receiver.state.allThreads.task.messages.filter((message: any) => message.role === 'user').map((message: any) => message.displayContent), ['parent', 'after foreign child']);
	});

	test('main-stamped foreign-window Stop cancels only the exact owner child group and never a later child id', async () => {
		for (const replaceBeforeWake of [false, true]) {
			const storage = new LifecycleBrokerStorage(); let ids = 0; const core = new PendingChatInputBrokerCore(storage, () => 100, () => `cross-stop-${replaceBeforeWake}-${++ids}`);
			const first = createPendingInboxReceiver({ storage, core, ctx: 'window:1' }); const second = createPendingInboxReceiver({ storage, core, ctx: 'window:2' });
			await first.receiver._ensurePendingInputBrokerReady(); await second.receiver._ensurePendingInputBrokerReady();
			const direct = await first.client.authorizeDirectHistoryAppend('task', 'parent', [], 'parent-run', 0); assert.ok(direct.ok);
			const parentThread = { ...first.receiver.state.allThreads.task, messages: [{ role: 'user', pendingInputId: direct.value.pendingInputId, pendingInputSelectionsFingerprint: direct.value.selectionsFingerprint, content: 'parent', displayContent: 'parent', selections: [], state: {} }] };
			storage.storeUser(pendingChatInputThreadStorageKey('task'), JSON.stringify({ version: 1, revision: 2, thread: parentThread })); assert.ok((await first.client.verifyDirectHistoryAndRelease('task', direct.value.leaseId)).ok);
			let coordination = [{ id: 'old-child', generation: 0, released: false }]; let cancels = 0;
			const source = { runId: 'parent-run', generation: 0 }; first.receiver._childGroupSourceOfThread.set('task', source);
			first.receiver._agentSubagentService = { getCoordinationRunViews: () => coordination, getRunViews: () => coordination.map(view => ({ ...view, status: 'running' })), cancelParent() { }, forgetParent() { } };
			assert.strictEqual(await first.receiver._releaseUndeliveredSteers('task', source), true);
			const productionWake = (ChatThreadService.prototype as any)._wakePendingChatInputs; if (replaceBeforeWake) first.receiver._wakePendingChatInputs = () => { };
			first.receiver.abortRunning = async () => { cancels++; coordination = []; const empty = await first.receiver._syncActiveChildGroup('task', source); assert.ok(empty.ok); };
			const stopped = await second.receiver.submitPendingInput({ threadId: 'task', text: 'replace physical child', mode: 'stop_and_send', selections: [] }); assert.ok(stopped); assert.deepStrictEqual([stopped.targetChildGeneration, stopped.targetChildIds], [0, ['old-child']]);
			if (replaceBeforeWake) {
				await new Promise(resolve => setTimeout(resolve, 0)); coordination = [{ id: 'new-child', generation: 0, released: false }]; const changed = await first.receiver._syncActiveChildGroup('task', source); assert.ok(changed.ok);
				first.receiver._wakePendingChatInputs = productionWake; productionWake.call(first.receiver, 'task', stopped); await flushMicrotasks(); assert.deepStrictEqual({ cancels, providers: second.providerStarts }, { cancels: 0, providers: 0 });
				coordination = []; assert.ok((await first.receiver._syncActiveChildGroup('task', source)).ok);
			}
			await eventually(() => second.providerStarts === 1 && second.receiver.getPendingChatInputs('task').length === 0, 'cross-window child Stop did not settle exactly once');
			assert.strictEqual(cancels, replaceBeforeWake ? 0 : 1); assert.strictEqual(first.providerStarts, 0);
		}
	});

	test('re-evaluates an edited or reordered Stop row after the captured abort flight and ignores deletion', async () => {
		for (const deleted of [false, true]) {
			const fixture = createPendingInboxReceiver(); const settled = deferred<void>(); const abortGate = deferred<void>(); const abortEntered = deferred<void>();
			fixture.receiver._runQuiescenceOfThread.set('task', { runId: 'old', generation: 0, settled: settled.promise }); let aborts = 0;
			fixture.receiver.abortRunning = async () => { aborts++; abortEntered.resolve(undefined); await abortGate.promise; fixture.receiver._runQuiescenceOfThread.delete('task'); fixture.receiver._agentControlGeneration.set('task', 1); settled.resolve(undefined); };
			const other = deleted ? undefined : await fixture.receiver.submitPendingInput({ threadId: 'task', text: 'other queued', mode: 'queue', selections: [] }); const stop = await fixture.receiver.submitPendingInput({ threadId: 'task', text: 'old stop text', mode: 'stop_and_send', selections: [] }); assert.ok(stop && (deleted || other)); await abortEntered.promise;
			if (deleted) { const removed = await fixture.client.delete('task', stop.id, pendingChatInputFingerprint(fixture.receiver.getPendingChatInputs('task').find((row: any) => row.id === stop.id))); assert.ok(removed.ok); }
			else {
				let latest = fixture.receiver.getPendingChatInputs('task').find((row: any) => row.id === stop.id); assert.ok((await fixture.client.edit('task', stop.id, pendingChatInputFingerprint(latest), 'latest stop text', [])).ok);
				latest = fixture.receiver.getPendingChatInputs('task').find((row: any) => row.id === stop.id); const rows = fixture.receiver.getPendingChatInputs('task'); assert.ok((await fixture.client.reorder('task', stop.id, pendingChatInputFingerprint(latest), pendingChatInputThreadFingerprint(rows), other!.id)).ok);
				const obsolete = fixture.receiver.getPendingChatInputs('task').find((row: any) => row.id === other!.id); assert.ok((await fixture.client.delete('task', other!.id, pendingChatInputFingerprint(obsolete))).ok);
			}
			abortGate.resolve(undefined);
			await eventually(() => fixture.receiver.getPendingChatInputs('task').length === 0 && fixture.providerStarts === (deleted ? 0 : 1), 'changed Stop flight did not settle latest authoritative rows');
			const delivered = fixture.receiver.state.allThreads.task.messages.filter((message: any) => message.role === 'user').map((message: any) => message.displayContent); assert.strictEqual(delivered.includes('old stop text'), false); if (!deleted) assert.strictEqual(delivered[0], 'latest stop text'); assert.strictEqual(aborts, 1);
		}
	});

	test('Stop-and-Send terminalizes a paused approval before generation revocation and drains once', async () => {
		const fixture = createPendingInboxReceiver(); await fixture.receiver._ensurePendingInputBrokerReady();
		const approval = { role: 'tool', type: 'tool_request', name: 'read_file', params: { uri: URI.parse('file:///workspace/a.txt') }, content: '(Awaiting user permission...)', result: null, id: 'approval-tool', rawParams: { uri: 'file:///workspace/a.txt' }, mcpServerName: undefined };
		fixture.receiver.state.allThreads.task.messages = [approval];
		const approvalRaw = JSON.stringify({ version: 1, revision: 2, thread: fixture.receiver.state.allThreads.task });
		fixture.storage.storeUser(pendingChatInputThreadStorageKey('task'), approvalRaw);
		// This fixture injects the already-durable approval after broker startup. Keep
		// the renderer CAS projection aligned with that authoritative B1 envelope so
		// rejecting the approval tests Stop ordering rather than an artificial stale
		// writer conflict.
		fixture.receiver._threadStorageAuthoritativeRaw.set('task', approvalRaw);
		// The common broker suite owns the cross-window approval barrier. This
		// lifecycle fixture isolates renderer chronology while keeping every queue,
		// claim, append and provider transition on the real core.
		const approvalSnapshot = () => fixture.client.snapshot ?? { namespace: lifecycleNamespace, revision: 0, records: [] }; let holds = 0; const closedRunIds: string[] = [];
		fixture.client.holdApproval = async () => { holds++; return { ok: true, snapshot: approvalSnapshot(), value: undefined }; };
		fixture.client.closeRunAndReleaseSteers = async (_threadId: string, runId: string) => { closedRunIds.push(runId); return { ok: true, snapshot: approvalSnapshot(), value: undefined }; };
		const paused = deferred<void>(); fixture.receiver.streamState.task = { isRunning: 'awaiting_user' };
		fixture.receiver._runQuiescenceOfThread.set('task', { runId: 'paused-run', generation: 0, settled: paused.promise, releaseAwaitingApproval: () => paused.resolve(undefined) });
		// Use the production generation fence rather than the general lifecycle fixture's
		// no-op revocation seam: this is the ordering that formerly deadlocked.
		delete fixture.receiver._revokeAgentDelegation;
		const row = await fixture.receiver.submitPendingInput({ threadId: 'task', text: 'replace approval', mode: 'stop_and_send', selections: [] }); assert.ok(row); assert.strictEqual(row.generation, 1);
		await eventually(() => fixture.providerStarts === 1 && fixture.receiver.getPendingChatInputs('task').length === 0, 'paused approval Stop-and-Send did not settle and drain');
		const messages = fixture.receiver.state.allThreads.task.messages;
		assert.strictEqual(messages.filter((message: any) => message.id === 'approval-tool' && message.type === 'rejected').length, 1);
		assert.strictEqual(messages.filter((message: any) => message.pendingInputId === row.id).length, 1);
		// The paused owner closes exactly once before the replacement generation is
		// admitted. The replacement parent later closes its own distinct run normally.
		assert.deepStrictEqual({ generation: fixture.receiver._agentControlGeneration.get('task'), holds, pausedCloses: closedRunIds.filter(id => id === 'paused-run').length, replacementCloses: closedRunIds.filter(id => id !== 'paused-run').length }, { generation: 1, holds: 1, pausedCloses: 1, replacementCloses: 1 });
	});

	test('restores the same approval identity after a failed continuation and rejects it once', async () => {
		const fixture = createPendingInboxReceiver(); await fixture.receiver._ensurePendingInputBrokerReady();
		const approval: any = { role: 'tool', type: 'tool_request', name: 'read_file', params: { uri: URI.parse('file:///workspace/retry.txt') }, content: '(Awaiting user permission...)', result: null, id: 'retry-approval', rawParams: { uri: 'file:///workspace/retry.txt' }, mcpServerName: undefined };
		fixture.receiver.state.allThreads.task.messages = [approval];
		const approvalRaw = JSON.stringify({ version: 1, revision: 2, thread: fixture.receiver.state.allThreads.task }); fixture.storage.storeUser(pendingChatInputThreadStorageKey('task'), approvalRaw); fixture.receiver._threadStorageAuthoritativeRaw.set('task', approvalRaw);
		const snapshot = () => fixture.client.snapshot ?? { namespace: lifecycleNamespace, revision: 0, records: [] }; let holds = 0; let closes = 0;
		fixture.client.holdApproval = async () => { holds++; return { ok: true, snapshot: snapshot(), value: undefined }; };
		fixture.client.closeRunAndReleaseSteers = async (_threadId: string, _runId: string, _generation: number, _authority: any, retainApproval = false) => { if (!retainApproval) closes++; return { ok: true, snapshot: snapshot(), value: undefined }; };
		const parentRun = beginTestParentRun(fixture.receiver, 'task');
		(ChatThreadService.prototype as any)._trackParentRun.call(fixture.receiver, 'task', parentRun, Promise.resolve());
		await eventually(() => !!fixture.receiver._runQuiescenceOfThread.get('task')?.releaseAwaitingApproval, 'approval identity was not restored');
		const restored = fixture.receiver._runQuiescenceOfThread.get('task'); assert.deepStrictEqual([restored.runId, restored.generation], [parentRun.runId, parentRun.generation]);
		await fixture.receiver.rejectLatestToolRequest('task');
		await eventually(() => fixture.receiver.state.allThreads.task.messages[0]?.type === 'rejected', 'restored approval was not rejectable');
		assert.deepStrictEqual({ holds, closes, quiescence: fixture.receiver._runQuiescenceOfThread.has('task') }, { holds: 2, closes: 1, quiescence: false });
	});

	test('classifies destructive flush uncertainty through the persisted main journal', async () => {
		const committed = createPendingInboxReceiver(); await committed.receiver._ensurePendingInputBrokerReady(); committed.receiver._runQuiescenceOfThread.set('task', { runId: 'hold', generation: 0, settled: new Promise<void>(() => { }) });
		const pending = await committed.receiver.submitPendingInput({ threadId: 'task', text: 'must clear only after commit', mode: 'queue', selections: [] }); assert.ok(pending); committed.receiver._runQuiescenceOfThread.delete('task'); committed.storage.failMutationCommitFlushes = 1;
		const replacement = lifecycleThread('replacement'); assert.strictEqual(await committed.receiver.dangerousSetState({ allThreads: { replacement }, currentThreadId: 'replacement' }), true); assert.deepStrictEqual(Object.keys(committed.receiver.state.allThreads), ['replacement']); assert.deepStrictEqual(committed.receiver.getPendingChatInputs('task'), []);
		const replacementAfterRecovery = { ...replacement, messages: [{ role: 'user', content: 'first post-recovery write', displayContent: 'first post-recovery write' }] }; committed.receiver._storeThreadRecord('replacement', replacementAfterRecovery); assert.strictEqual(await committed.receiver._awaitThreadStorageWrites('replacement'), true, 'committed classification must adopt the exact replacement raw before the next CAS'); assert.strictEqual(JSON.parse(committed.storage.get(pendingChatInputThreadStorageKey('replacement'))!).thread.messages[0].displayContent, 'first post-recovery write');

		const aborted = createPendingInboxReceiver(); await aborted.receiver._ensurePendingInputBrokerReady(); aborted.receiver._runQuiescenceOfThread.set('task', { runId: 'hold', generation: 0, settled: new Promise<void>(() => { }) }); const preserved = await aborted.receiver.submitPendingInput({ threadId: 'task', text: 'preserve on baseline', mode: 'queue', selections: [] }); assert.ok(preserved); aborted.storage.failUserStores = 1;
		assert.strictEqual(await aborted.receiver.dangerousSetState({ allThreads: { replacement: lifecycleThread('replacement') }, currentThreadId: 'replacement' }), false); assert.ok(aborted.receiver.state.allThreads.task); assert.strictEqual(aborted.receiver.getPendingChatInputs('task')[0]?.id, preserved.id); assert.strictEqual(aborted.receiver._pendingNamespaceMutation, false);

		const ambiguous = createPendingInboxReceiver(); await ambiguous.receiver._ensurePendingInputBrokerReady(); const extra = lifecycleThread('extra'); ambiguous.receiver.state.allThreads.extra = extra; ambiguous.storage.storeUser(pendingChatInputThreadStorageKey('extra'), JSON.stringify({ version: 1, revision: 1, thread: extra })); let mutationWrites = 0; const originalStore = ambiguous.receiver._storageService.store.bind(ambiguous.receiver._storageService); ambiguous.receiver._storageService.store = (key: string, value: string, ...rest: any[]) => { if (key.startsWith('void.chatThreadStorageIII.') && ++mutationWrites === 2) throw new Error('partial replacement write'); return originalStore(key, value, ...rest); }; ambiguous.receiver._scheduleNamespaceFinalizeRetry = () => { };
		assert.strictEqual(await ambiguous.receiver.resetState(), false); assert.strictEqual(ambiguous.receiver._pendingNamespaceMutation, true); assert.ok(ambiguous.receiver.state.allThreads.task);

		const deleted = createPendingInboxReceiver(); await deleted.receiver._ensurePendingInputBrokerReady(); deleted.storage.failMutationCommitFlushes = 1; assert.strictEqual(await deleted.receiver.deleteThread('task'), true); assert.strictEqual(deleted.receiver.state.allThreads.task, undefined); assert.deepStrictEqual(deleted.receiver.getPendingChatInputs('task'), []);

		const resetRecovered = createPendingInboxReceiver(); await resetRecovered.receiver._ensurePendingInputBrokerReady(); const exported = resetRecovered.receiver.state.allThreads.task; resetRecovered.storage.failMutationCommitFlushes = 1; assert.strictEqual(await resetRecovered.receiver.resetState(), true); assert.strictEqual(await resetRecovered.receiver.dangerousSetState({ allThreads: { task: exported }, currentThreadId: 'task' }), true, 'a journal-resolved reset tombstone must remain importable by the exact global transaction');
		const afterImport = { ...exported, messages: [{ role: 'user', content: 'after import', displayContent: 'after import' }] }; resetRecovered.receiver._storeThreadRecord('task', afterImport); assert.strictEqual(await resetRecovered.receiver._awaitThreadStorageWrites('task'), true); assert.strictEqual(JSON.parse(resetRecovered.storage.get(pendingChatInputThreadStorageKey('task'))!).thread.messages[0].displayContent, 'after import');
	});

	test('holds a required-child provisional stream until attributed synthesis', async () => {
		const gate = deferred<void>(); let required = true; let mailbox: any[] = []; const callbacks: TestProviderCallbacks[] = []; const prepared: any[][] = [];
		const snapshot = instructionSnapshot(); const messages: any[] = [{ role: 'user', content: 'start', displayContent: 'start', selections: [], state: { stagingSelections: [], isBeingEdited: false } }]; const streamState: TestStreamRecord = {};
		const receiver: any = {
			state: { allThreads: { task: { messages, state: {}, filesWithUserChanges: new Set() } } }, streamState,
			_agentControlGeneration: new Map([['task', 0]]), _parentRunTokenOfThread: new Map(), _agentDelegationAuthorityOfThread: new Map(), _settingsService: { state: { globalSettings: { chatMode: 'agent' } } },
			_agentSubagentService: { hasPendingRequired: () => required, waitForRequired: () => gate.promise, peekParentMailbox: () => ({ events: mailbox, parentMessageSequences: mailbox.filter(event => event.kind === 'message').map(event => event.sequence), completionSequences: mailbox.filter(event => event.kind === 'completion').map(event => event.sequence) }), ackParentMailbox: () => { mailbox = []; return true; } },
			_convertToLLMMessagesService: { prepareLLMChatMessages: async ({ chatMessages }: any) => { prepared.push(chatMessages.map((message: any) => ({ ...message }))); return { messages: chatMessages, separateSystemMessage: false }; } },
			_llmMessageService: { sendLLMMessage: (options: TestProviderCallbacks) => { callbacks.push(options); return `request-${callbacks.length}`; }, abort() { } }, _mcpService: { getMCPTools: () => [] }, _metricsService: { capture() { } },
			_setStreamState(threadId: string, value: TestStream | undefined) { streamState[threadId] = value; }, _addMessageToThread(_threadId: string, message: any) { messages.push(message); }, _editMessageInThread(_threadId: string, index: number, message: any) { messages[index] = message; },
		};
		receiver._appendAgentMailboxEvents = (...args: any[]) => (ChatThreadService.prototype as any)._appendAgentMailboxEvents.apply(receiver, args);
		const running = runChatAgent(receiver, { threadId: 'task', modelSelection: { providerName: 'openAICompatible', modelName: 'gpt-4.1' }, modelSelectionOptions: snapshot.model.modelSelectionOptions, instructionSnapshot: snapshot });
		await eventually(() => callbacks.length === 1, 'first provider request missing'); callbacks[0].onText({ fullText: 'PREMATURE', fullReasoning: 'draft', toolCalls: undefined }); assert.strictEqual(llmInfoOf(streamState.task).displayContentSoFar, ''); assert.strictEqual(JSON.stringify(messages).includes('PREMATURE'), false);
		await callbacks[0].onFinalMessage({ fullText: 'PREMATURE', fullReasoning: 'draft', anthropicReasoning: null }); await flushMicrotasks(); assert.strictEqual(messages.some(message => message.role === 'assistant' && message.displayContent === 'PREMATURE'), false);
		mailbox = [{ role: 'agent', sourceId: 'child-1', kind: 'completion', sequence: 7, status: 'completed', content: 'CHILD_RESULT', createdAt: 1 }]; required = false; gate.resolve(undefined);
		await eventually(() => callbacks.length === 2, 'required completion did not create synthesis request'); assert.deepStrictEqual(prepared[1].filter(message => message.role === 'agent').map(message => [message.sourceId, message.kind, message.content]), [['child-1', 'completion', 'CHILD_RESULT']]);
		await callbacks[1].onFinalMessage({ fullText: 'FINAL', fullReasoning: '', anthropicReasoning: null }); await running; assert.strictEqual(messages.filter(message => message.role === 'assistant' && message.displayContent === 'FINAL').length, 1); assert.strictEqual(messages.some(message => message.role === 'assistant' && message.displayContent === 'PREMATURE'), false);
	});

});
