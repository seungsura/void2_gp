import * as assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ChatThreadService } from '../../browser/chatThreadService.js';
import { createSkillCatalog } from '../../common/agentSkills.js';
import { projectAgentConfig, resolveAgentInstructions, stableAgentInstructionRevision } from '../../common/agentInstructions.js';

const instructionSnapshot = (limits?: { maxAcceptedChildren?: number; maxConcurrentThreadsPerSession?: number; maxDepth?: number }, diagnostics: any[] = []) => { const projectedKeys: any[] = ['developer_instructions']; if (limits || diagnostics.length) projectedKeys.push('agents'); if (limits?.maxAcceptedChildren !== undefined) projectedKeys.push('agents.max_accepted_children'); if (limits?.maxConcurrentThreadsPerSession !== undefined) projectedKeys.push('agents.max_concurrent_threads_per_session'); if (limits?.maxDepth !== undefined) projectedKeys.push('agents.max_depth'); const config = projectAgentConfig({ developerInstructions: 'developer', ...(limits?.maxAcceptedChildren === undefined ? {} : { agentMaxAcceptedChildren: limits.maxAcceptedChildren }), ...(limits?.maxConcurrentThreadsPerSession === undefined ? {} : { agentMaxConcurrentThreadsPerSession: limits.maxConcurrentThreadsPerSession }), ...(limits?.maxDepth === undefined ? {} : { agentMaxDepth: limits.maxDepth }), ...(diagnostics.length ? { agentDelegationLimitDiagnostics: diagnostics, agentsConfigPresent: true } : {}) }, undefined, [{ uri: 'file:///home/.codex/config.toml', scope: 'user', status: 'loaded', projectedKeys }], 'file:///workspace', 'file:///workspace'); const candidates: any[] = []; return resolveAgentInstructions(config, candidates, stableAgentInstructionRevision(config, candidates)); };
const eventually = async (predicate: () => boolean, message: string) => { for (let attempt = 0; attempt < 100; attempt++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 0)); } assert.fail(message); };

type Authority = Readonly<{ allowed: boolean; generation: number; limits?: Readonly<{ maxAcceptedChildren: number; maxConcurrentThreadsPerSession: number; maxDepth: number }> }>;
type AdmissionRole = Readonly<{ identity: string; revision: string; description: string }>;
type AdmissionCatalog = Readonly<{ revision: string; agents: readonly AdmissionRole[]; diagnostics: readonly unknown[] }>;
type AdmissionMessage = { content?: string; displayContent?: string };
type AdmissionStream = { isRunning?: string; llmInfo?: { displayContentSoFar: string; reasoningSoFar: string; toolCallSoFar: null }; interrupt?: Promise<() => void>; error?: { message: string; fullError: Error | null } };
type AdmissionSelection = Readonly<{ type: 'Agent'; label: 'Void application-level read-only'; agentType: string; catalogRevision: string; roleRevision: string; state: undefined }>;
interface AdmissionLifecycleAdapter {
	_addUserMessageAndStreamResponse(this: unknown, options: { userMessage: string; _chatSelections: readonly AdmissionSelection[]; threadId: string }): Promise<boolean>;
	_revokeAgentDelegation(this: unknown, threadId: string, forget?: boolean): void;
}
const admissionLifecycle = ChatThreadService.prototype as unknown as AdmissionLifecycleAdapter;
const runTool = (receiver: any, name: string, id: string, rawParams: Record<string, unknown>, options?: { authority?: Authority; install?: boolean }) => {
	const generation = receiver._agentControlGeneration.get('parent') ?? 0;
	const authority = options && Object.prototype.hasOwnProperty.call(options, 'authority') ? options.authority : Object.freeze({ allowed: true, generation });
	if (authority && options?.install !== false) receiver._agentDelegationAuthorityOfThread.set('parent', authority);
	return (ChatThreadService.prototype as any)._runToolCall.call(receiver, 'parent', name, id, 'spoofed-mcp', { preapproved: false, unvalidatedToolParams: rawParams }, { ownerProjectRoot: 'file:///workspace' }, authority, false, undefined, () => true);
};
const bindApprovals = (value: any) => { value._childToolApprovals ??= new Map(); value._onDidChangeChildToolApprovals ??= { fire() { } }; for (const name of ['_cancelChildToolApproval', '_cancelChildToolApprovalsForParent', '_decideChildToolApproval', 'getChildToolApprovals'] as const) value[name] ??= (...args: any[]) => (ChatThreadService.prototype as any)[name].call(value, ...args); };
const revoke = function (this: any, threadId: string, forget = false) { this._parentRunTokenOfThread ??= new Map(); this._toolsService ??= {}; this._toolsService.invalidateReadReceipts ??= (_threadId: string) => { }; bindApprovals(this); return (ChatThreadService.prototype as any)._revokeAgentDelegation.call(this, threadId, forget); };
const hydrateLifecycle = (value: any) => {
	value._parentRunTokenOfThread ??= new Map();
	value._pendingChatSubmissionOfThread ??= new Map();
	value._pendingChatInputsOfThread ??= new Map();
	value._drainingPendingChatInputs ??= new Set();
	value._runQuiescenceOfThread ??= new Map();
	value._startingParentRunOfThread ??= new Map();
	value._threadStorageWriteTail ??= new Map();
	value._threadStorageAuthoritativeRaw ??= new Map();
	value._threadStorageWriteEpoch ??= new Map();
	value._deletingPendingInputThreads ??= new Set();
	value._deferredExternalThreadKey ??= new Map();
	value._approvalActionFlights ??= new Set();
	value._externalPendingDeleteRetries ??= new Map();
	value._pendingThreadMutationRetries ??= new Map();
	value._stopAndSendFlights ??= new Map();
	value._cancellingToolReceiptsOfThread ??= new Map();
	value._activeToolCardReceiptsOfThread ??= new Map();
	value._childGroupSourceOfThread ??= new Map();
	value._childGroupSyncRevisionOfThread ??= new Map();
	value._childGroupSyncTailOfThread ??= new Map();
	value._onDidChangePendingChatInputs ??= { fire() { } };
	value._notificationService ??= { notify() { }, info() { } };
	if (!Object.prototype.hasOwnProperty.call(value, '_storePendingChatInputs')) value._storePendingChatInputs = () => { };
	if (!Object.prototype.hasOwnProperty.call(value, '_setStreamState')) value._setStreamState = (threadId: string, state: unknown) => { value.streamState[threadId] = state; };
	Object.setPrototypeOf(value, ChatThreadService.prototype);
	return value;
};
/** Revoke/late-result fixtures exercise the production destructive control flow,
 * while this exact seam keeps their concern independent from the separately tested
 * storage transaction. The transaction-focused test below retains real planning,
 * writes, flush/readback, finalize and abort behavior. */
const installDestructiveLifecycleSeam = (value: any) => {
	const snapshot = { namespace: { profileId: 'profile', workspaceId: 'workspace' }, revision: 0, records: [] };
	value._pendingNamespaceMutation = false;
	value._pendingInputBrokerReady = Promise.resolve(true);
	value._pendingInputBrokerTestSeam = {
		initializeNamespace: async () => ({ ok: true, snapshot, value: {} }),
		clearNamespace: async () => ({ ok: true, snapshot, value: { leaseId: 'namespace-lease' } }),
		finalizeNamespaceClear: async () => ({ ok: true, snapshot, value: undefined }),
		abortNamespaceClear: async () => ({ ok: true, snapshot, value: undefined }),
		deleteThreadRecords: async (threadId: string) => ({ ok: true, snapshot, value: { leaseId: `thread-${threadId}` } }),
		finalizeThreadDeletion: async () => ({ ok: true, snapshot, value: undefined }),
		abortThreadDeletion: async () => ({ ok: true, snapshot, value: undefined }),
	};
	const evidence = Object.freeze({ baselineFingerprint: 'fixture-baseline', expectedFingerprint: 'fixture-expected' });
	value._buildThreadReplacementPlan = () => ({ writes: [], evidence });
	value._buildThreadDeletionPlan = () => ({ writes: [], evidence });
	value._commitThreadStorageMutation = async () => { };
	value._isThreadReplacementDurable = () => true;
	value._areStoredThreadsTombstoned = () => true;
	value._isThreadTombstoneDurable = () => true;
	value._scheduleNamespaceFinalizeRetry = () => { };
	value._scheduleDeliveredPendingReconcile = () => { };
	value._scheduleExternalPendingDelete = () => { };
	value._drainPendingChatInputs = async () => { };
	value.clearTransientComposerDraft ??= () => { };
	value._restoreInstructionTurns ??= () => { };
	value._setState ??= (patch: any) => { value.state = { ...value.state, ...patch }; };
	value.openNewThread = () => { value.state = { ...value.state, allThreads: {}, currentThreadId: 'replacement' }; };
	return value;
};
const installAdmissionPersistenceSeam = (value: any) => {
	const snapshot = { namespace: { profileId: 'profile', workspaceId: 'workspace' }, revision: 0, records: [] };
	let nextId = 0;
	const broker = {
		authorizeDirectHistoryAppend: async () => ({ ok: true, snapshot, value: { leaseId: `direct-lease-${++nextId}`, pendingInputId: `direct-input-${nextId}`, selectionsFingerprint: 'fixture-selections' } }),
		verifyDirectHistoryAndRelease: async () => ({ ok: true, snapshot, value: { kind: 'exact', envelopeRaw: '{}' } }),
		abandonDirectHistoryAppend: async () => ({ ok: true, snapshot, value: undefined }),
	};
	value._pendingBroker = () => broker;
	value._awaitThreadStorageWrites = async () => true;
	value._threadFromBrokerHistoryInspection = (threadId: string) => value.state.allThreads[threadId];
	value._adoptDurablePendingInputThread = () => true;
	value._releaseUndeliveredSteers = async () => { };
	return value;
};
/** Plain receivers deliberately use the production private helpers, while retaining
 * their own store/state spies; this avoids duplicating lifecycle logic in a test. */
const childActivityFixture = (value: any) => {
	for (const name of ['_activityFromView', '_selectChildActivitySubtree'] as const) value[name] ??= (...args: any[]) => (ChatThreadService.prototype as any)[name].call(value, ...args);
	return value;
};
const receiver = () => { const messages: any[] = []; const calls: any[] = []; return { messages, calls, value: hydrateLifecycle({ state: { allThreads: { parent: {} }, currentThreadId: 'parent' }, streamState: {}, _agentInstructionSessionOfThread: new Map(), _instructionTurnOfThread: new Map(), _agentControlGeneration: new Map(), _agentDelegationAuthorityOfThread: new Map(), _transientComposerDraftOfThread: new Map(), _revokeAgentDelegation: revoke, _agentCustomAgentService: { getCatalog: async () => ({ revision: 'roles', agents: [], diagnostics: [] }) }, _agentSubagentService: { spawn: async (...args: any[]) => { calls.push(['spawn', args]); return { id: 'child', status: 'queued' }; }, wait: async () => { calls.push(['wait']); return { id: 'child', status: 'running', deliverSummary: false }; }, interrupt: () => { calls.push(['interrupt']); return { id: 'child', status: 'cancelled' }; }, forgetParent: (id: string) => calls.push([`forget:${id}`]) }, _toolsService: { invalidateReadReceipts(_threadId: string) { }, validateParams: new Proxy({}, { get() { throw new Error('builtin lookup'); } }) }, _mcpService: { getMCPTools() { throw new Error('MCP lookup'); } }, _addMessageToThread: (_: string, message: any) => messages.push(message), openNewThread() { }, _onDidChangeCurrentThread: { fire() { } } }) }; };

suite('Void agent subagent Chat runtime routing', () => {
	test('atomically appends the unchanged spawn success row and its pre-settled child tree', () => {
		const writes: any[] = []; const states: any[] = [];
		const root: any = { id: 'child', generation: 4, depth: 1, status: 'completed', capabilityProfile: 'read_only', queuedMs: 1, runningMs: 2, totalMs: 3, authority: {} };
		const nested: any = { ...root, id: 'nested', parentRunId: 'child', depth: 2 };
		const thread: any = { id: 'parent', messages: [{ role: 'user', content: 'x' }], childActivities: { version: 1, records: [], omitted: 0, retentionSaturated: false }, state: {}, filesWithUserChanges: new Set() };
		const fake: any = childActivityFixture({ state: { allThreads: { parent: thread }, currentThreadId: 'parent' }, _agentSubagentService: { getRunViews: () => [root, nested] }, _storeAllThreads: (value: any) => writes.push(value), _setState: (value: any) => states.push(value) });
		(ChatThreadService.prototype as any)._appendSpawnSuccessAndBind.call(fake, 'parent', { role: 'tool', type: 'success', name: 'spawn_agent', id: 'tool', result: { id: 'child' }, content: '{}', rawParams: {}, params: { message: 'x' }, mcpServerName: undefined }, { id: 'child' }, { toolId: 'tool' });
		assert.strictEqual(writes.length, 1); assert.strictEqual(states.length, 1); assert.strictEqual(writes[0].parent.messages.length, 2); assert.strictEqual(writes[0].parent.messages[1].id, 'tool'); assert.deepStrictEqual(writes[0].parent.childActivities.records.map((row: any) => row.childId), ['child', 'nested']);
	});
	test('persists a changed child ledger once and skips an identical ledger', () => {
		const empty: any = { version: 1, records: [], omitted: 0, retentionSaturated: false }; const changed: any = { version: 1, records: [{ generation: 1, childId: 'child', depth: 1, status: 'completed', capabilityProfile: 'read_only', queuedMs: 0, runningMs: 1, totalMs: 1, anchor: { toolId: 'spawn' } }], omitted: 0, retentionSaturated: false }; const thread: any = { id: 'parent', messages: [], childActivities: empty, lastModified: 'old', state: {}, filesWithUserChanges: new Set() }; const writes: any[] = []; const states: any[] = [];
		const fake: any = { state: { allThreads: { parent: thread } }, _storeAllThreads: (value: any) => writes.push(value), _setState: (value: any) => { states.push(value); fake.state = { ...fake.state, ...value }; } };
		(ChatThreadService.prototype as any)._replaceChildActivities.call(fake, 'parent', changed); assert.strictEqual(writes.length, 1); assert.strictEqual(states.length, 1); (ChatThreadService.prototype as any)._replaceChildActivities.call(fake, 'parent', changed); assert.strictEqual(writes.length, 1); assert.strictEqual(states.length, 1);
	});
	test('binds only the exact spawned root subtree, including its exact batch tuple', () => {
		const writes: any[] = []; const states: any[] = [];
		const rootA: any = { id: 'A', generation: 4, depth: 1, status: 'running', capabilityProfile: 'read_only', queuedMs: 0, runningMs: 1, totalMs: 1, authority: {} };
		const childA: any = { ...rootA, id: 'A-1', parentRunId: 'A', depth: 2 }; const rootB: any = { ...rootA, id: 'B' }; const childB: any = { ...rootA, id: 'B-1', parentRunId: 'B', depth: 2 };
		const thread: any = { id: 'parent', messages: [], childActivities: { version: 1, records: [], omitted: 0, retentionSaturated: false }, state: {}, filesWithUserChanges: new Set() };
		const fake: any = childActivityFixture({ state: { allThreads: { parent: thread } }, _agentSubagentService: { getRunViews: () => [rootA, childA, rootB, childB] }, _storeAllThreads: (value: any) => writes.push(value), _setState: (value: any) => states.push(value) });
		(ChatThreadService.prototype as any)._appendSpawnSuccessAndBind.call(fake, 'parent', { role: 'tool', type: 'success', name: 'spawn_agent', id: 'spawn-A', batchId: 'batch-A', batchOrdinal: 3, result: { id: 'A' }, content: '{}', rawParams: {}, params: { message: 'x' }, mcpServerName: undefined }, { id: 'A' }, { toolId: 'spawn-A', batchId: 'batch-A', batchOrdinal: 3 });
		assert.strictEqual(writes.length, 1); assert.strictEqual(states.length, 1); assert.deepStrictEqual(writes[0].parent.childActivities.records.map((row: any) => row.childId), ['A', 'A-1']); assert.deepStrictEqual(writes[0].parent.childActivities.records.map((row: any) => row.anchor), [{ toolId: 'spawn-A', batchId: 'batch-A', batchOrdinal: 3 }, { toolId: 'spawn-A', batchId: 'batch-A', batchOrdinal: 3 }]);
	});
	test('late nested activity joins an anchored ancestor chain and unrelated roots remain inert', () => {
		const root: any = { generation: 6, childId: 'root', depth: 1, status: 'running', capabilityProfile: 'read_only', queuedMs: 0, runningMs: 1, totalMs: 1, anchor: { toolId: 'spawn' } };
		const parent: any = { id: 'root', generation: 6, depth: 1, status: 'running', capabilityProfile: 'read_only', queuedMs: 0, runningMs: 2, totalMs: 2, authority: {} }; const nested: any = { ...parent, id: 'nested', parentRunId: 'root', depth: 2, runningMs: 3, totalMs: 3 }; const other: any = { ...parent, id: 'other', depth: 1 };
		const thread: any = { id: 'parent', childActivities: { version: 1, records: [root], omitted: 0, retentionSaturated: false }, messages: [], state: {}, filesWithUserChanges: new Set() }; const writes: any[] = [];
		const fake: any = childActivityFixture({ state: { allThreads: { parent: thread } }, _agentSubagentService: { getRunViews: () => [parent, nested, other] }, _replaceChildActivities(_id: string, ledger: any) { thread.childActivities = ledger; writes.push(ledger); } });
		(ChatThreadService.prototype as any)._applyChildActivityEvent.call(fake, 'parent', 6, 'nested'); assert.deepStrictEqual(thread.childActivities.records.map((row: any) => row.childId), ['root', 'nested']); (ChatThreadService.prototype as any)._applyChildActivityEvent.call(fake, 'parent', 6, 'other'); assert.strictEqual(writes.length, 1);
	});
	test('cyclic live ancestry is inert and cannot loop or create a durable receipt', () => {
		const thread: any = { id: 'parent', childActivities: { version: 1, records: [], omitted: 0, retentionSaturated: false }, messages: [], state: {}, filesWithUserChanges: new Set() };
		const a: any = { id: 'a', parentRunId: 'b', generation: 9, depth: 2, status: 'running', capabilityProfile: 'read_only', queuedMs: 0, runningMs: 1, totalMs: 1 }; const b: any = { ...a, id: 'b', parentRunId: 'a' }; const fake: any = { state: { allThreads: { parent: thread } }, _agentSubagentService: { getRunViews: () => [a, b] }, _replaceChildActivities() { throw new Error('cyclic activity must be inert'); } };
		assert.doesNotThrow(() => (ChatThreadService.prototype as any)._applyChildActivityEvent.call(fake, 'parent', 9, 'a')); assert.deepStrictEqual(thread.childActivities.records, []);
	});
	test('current lifecycle events update once, then the first terminal receipt absorbs all late notifications', () => {
		const initial: any = { generation: 2, childId: 'child', depth: 1, status: 'queued', capabilityProfile: 'read_only', queuedMs: 0, runningMs: 0, totalMs: 0, anchor: { toolId: 'tool' } };
		const thread: any = { id: 'parent', childActivities: { version: 1, records: [initial], omitted: 0, retentionSaturated: false }, messages: [], state: {}, filesWithUserChanges: new Set() }; const writes: any[] = [];
		let view: any = { id: 'child', generation: 2, depth: 1, status: 'running', roleName: 'reader', roleDescription: ' durable role\n', capabilityProfile: 'read_only', queuedMs: 0, runningMs: 1, totalMs: 1 };
		const fake: any = childActivityFixture({ state: { allThreads: { parent: thread } }, _agentSubagentService: { getRunViews: () => [view] }, _replaceChildActivities(_id: string, ledger: any) { thread.childActivities = ledger; writes.push(ledger); } });
		(ChatThreadService.prototype as any)._applyChildActivityEvent.call(fake, 'parent', 2, 'child'); view = { ...view, status: 'completed', runningMs: 2, totalMs: 2, summary: ' first terminal\n' }; (ChatThreadService.prototype as any)._applyChildActivityEvent.call(fake, 'parent', 2, 'child'); view = { ...view, status: 'running', runningMs: 3, totalMs: 3 }; (ChatThreadService.prototype as any)._applyChildActivityEvent.call(fake, 'parent', 2, 'child'); view = { ...view, status: 'failed', runningMs: 4, totalMs: 4, summary: 'competing' }; (ChatThreadService.prototype as any)._applyChildActivityEvent.call(fake, 'parent', 2, 'child'); (ChatThreadService.prototype as any)._applyChildActivityEvent.call(fake, 'parent', 1, 'child');
		assert.strictEqual(writes.length, 2); assert.strictEqual(thread.childActivities.records[0].status, 'completed'); assert.strictEqual(thread.childActivities.records[0].summary, 'first terminal'); assert.strictEqual(thread.childActivities.records[0].role.description, 'durable role');
	});
	test('storage normalization and destructive lifecycle keep durable activity inert', async () => {
		const active: any = { generation: 1, childId: 'child', depth: 1, status: 'running', capabilityProfile: 'read_only', queuedMs: 0, runningMs: 1, totalMs: 1, anchor: { toolId: 'tool' } };
		const service: any = { _storageService: { get: () => JSON.stringify({ parent: { id: 'parent', messages: [], childActivities: { version: 1, records: [active], omitted: 0, retentionSaturated: false }, state: {}, filesWithUserChanges: [] } }) } };
		assert.doesNotThrow(() => (ChatThreadService.prototype as any)._convertThreadDataFromStorage.call(service, JSON.stringify({ parent: { id: 'parent', messages: [], childActivities: { version: 1, records: [active], omitted: 0, retentionSaturated: false }, state: {}, filesWithUserChanges: [] } })));
		const restored = (ChatThreadService.prototype as any)._convertThreadDataFromStorage.call(service, JSON.stringify({ parent: { id: 'parent', messages: [], childActivities: { version: 1, records: [active], omitted: 0, retentionSaturated: false }, state: {}, filesWithUserChanges: [] } }));
		assert.strictEqual(restored.parent.childActivities.records[0].status, 'interrupted'); assert.doesNotThrow(() => (ChatThreadService.prototype as any)._convertThreadDataFromStorage.call(service, JSON.stringify({ parent: { id: 'parent', messages: [], childActivities: { bad: true }, state: {}, filesWithUserChanges: [] } })));
		const destructiveReceiver = (failure?: 'flush-after-write' | 'before-write') => {
			const storage = new Map<string, string>(); const chronology: string[] = []; const brokerRows = ['queued']; let providerOrToolEffects = 0;
			const snapshot = { namespace: { profileId: 'profile', workspaceId: 'workspace' }, revision: 0, records: [] };
			const currentThread: any = { id: 'parent', createdAt: 'before', lastModified: 'before', messages: [{ role: 'user', content: 'before', displayContent: 'before' }], childActivities: { version: 1, records: [], omitted: 0, retentionSaturated: false }, state: { stagingSelections: [], focusedMessageIdx: undefined, linksOfMessageIdx: {} }, filesWithUserChanges: new Set<string>() };
			const replacement: any = hydrateLifecycle({ state: { allThreads: { parent: currentThread }, currentThreadId: 'parent' }, streamState: {}, _pendingNamespaceMutation: false, _pendingInputBrokerReady: Promise.resolve(true), _agentInstructionSessionOfThread: new Map(), _instructionTurnOfThread: new Map(), _agentControlGeneration: new Map(), _agentDelegationAuthorityOfThread: new Map(), _transientComposerDraftOfThread: new Map(), _revokeAgentDelegation: revoke, _agentSubagentService: { forgetParent() { } }, _toolsService: { invalidateReadReceipts() { } }, _onDidChangeCurrentThread: { fire() { } }, _restoreInstructionTurns() { }, _storePendingChatInputs() { }, _scheduleDeliveredPendingReconcile() { }, _drainPendingChatInputs: async () => { }, _notificationService: { notify() { } }, _storageService: { get: (key: string) => storage.get(key), keys: () => [...storage.keys()], store: (key: string, raw: string) => { chronology.push(`store:${key}`); if (failure === 'before-write' && key.startsWith('void.chatThreadStorageIII.')) throw new Error('injected pre-write failure'); storage.set(key, raw); }, flush: async () => { chronology.push('flush'); if (failure === 'flush-after-write') throw new Error('injected flush failure'); } } });
			replacement._pendingInputBrokerTestSeam = {
				initializeNamespace: async () => ({ ok: true, snapshot, value: {} }),
				clearNamespace: async () => { chronology.push('prepare'); return { ok: true, snapshot, value: { leaseId: 'namespace-lease' } }; },
				finalizeNamespaceClear: async () => { chronology.push('finalize'); assert.ok([...storage.keys()].some(key => key.startsWith('void.chatThreadStorageIII.'))); brokerRows.length = 0; return { ok: true, snapshot, value: undefined }; },
				abortNamespaceClear: async () => { chronology.push('abort'); return { ok: true, snapshot, value: undefined }; },
			};
			replacement._runToolCall = () => { providerOrToolEffects++; }; replacement._llmMessageService = { sendLLMMessage() { providerOrToolEffects++; } };
			return { replacement, storage, chronology, brokerRows, effects: () => providerOrToolEffects };
		};
		const queued = { ...active, childId: 'queued', status: 'queued', runningMs: 0, totalMs: 0, anchor: { toolId: 'queued-tool' } };
		const nextState: any = { allThreads: { parent: { id: 'parent', createdAt: 'now', lastModified: 'now', messages: [], childActivities: { version: 1, records: [queued, active], omitted: 0, retentionSaturated: false }, state: { stagingSelections: [], focusedMessageIdx: undefined, linksOfMessageIdx: {} }, filesWithUserChanges: new Set<string>() } }, currentThreadId: 'parent' };
		const success = destructiveReceiver(); assert.strictEqual(await ChatThreadService.prototype.dangerousSetState.call(success.replacement, nextState), true);
		assert.deepStrictEqual(success.replacement.state.allThreads.parent.childActivities.records.map((row: any) => row.status), ['interrupted', 'interrupted']); assert.deepStrictEqual(success.brokerRows, []); assert.strictEqual(success.effects(), 0); assert.ok(success.chronology.indexOf('prepare') < success.chronology.indexOf('flush')); assert.ok(success.chronology.indexOf('flush') < success.chronology.indexOf('finalize'));
		const uncertain = destructiveReceiver('flush-after-write'); assert.strictEqual(await ChatThreadService.prototype.dangerousSetState.call(uncertain.replacement, nextState), true); assert.deepStrictEqual(uncertain.brokerRows, []); assert.ok(uncertain.chronology.includes('finalize')); assert.ok(!uncertain.chronology.includes('abort')); assert.strictEqual(uncertain.effects(), 0);
		const failed = destructiveReceiver('before-write'); const failedState = { ...nextState, allThreads: { parent: { ...nextState.allThreads.parent, childActivities: { version: 1, records: [queued], omitted: 0, retentionSaturated: false } } } };
		assert.strictEqual(await ChatThreadService.prototype.dangerousSetState.call(failed.replacement, failedState), false); assert.deepStrictEqual(failed.brokerRows, ['queued']); assert.ok(failed.chronology.indexOf('finalize') < failed.chronology.indexOf('abort')); assert.strictEqual(failed.effects(), 0); assert.strictEqual(failed.replacement.state.allThreads.parent.id, 'parent');
	});
	test('editing a transcript slice prunes only the removed spawn anchor subtree', () => {
		const root: any = { generation: 1, childId: 'root', depth: 1, status: 'completed', capabilityProfile: 'read_only', queuedMs: 0, runningMs: 1, totalMs: 1, anchor: { toolId: 'spawn' } };
		const child: any = { ...root, childId: 'nested', parentRunId: 'root', depth: 2 };
		const keep: any = { ...root, childId: 'keep', anchor: { toolId: 'keep-spawn' } };
		const thread: any = { messages: [{ role: 'tool', type: 'success', name: 'spawn_agent', id: 'spawn', result: { id: 'root' } }, { role: 'tool', type: 'success', name: 'spawn_agent', id: 'keep-spawn', result: { id: 'keep' } }], childActivities: { version: 1, records: [root, child, keep], omitted: 3, retentionSaturated: true } };
		const messages: any[] = [thread.messages[1]];
		const pruned = (ChatThreadService.prototype as any)._pruneChildActivitiesForMessages.call({}, thread, messages);
		assert.deepStrictEqual(pruned.records.map((record: any) => record.childId), ['keep']); assert.strictEqual(pruned.omitted, 0); assert.strictEqual(pruned.retentionSaturated, false);
		const unrelated: any = { id: 'unrelated', generation: 2, depth: 1, status: 'completed', capabilityProfile: 'read_only', queuedMs: 0, runningMs: 1, totalMs: 1, authority: {} }; const writes: any[] = [];
		const fake: any = childActivityFixture({ state: { allThreads: { parent: { ...thread, messages, childActivities: pruned } } }, _agentSubagentService: { getRunViews: () => [unrelated] }, _storeAllThreads: (value: any) => writes.push(value), _setState() { } });
		(ChatThreadService.prototype as any)._appendSpawnSuccessAndBind.call(fake, 'parent', { role: 'tool', type: 'success', name: 'spawn_agent', id: 'unrelated-spawn', result: { id: 'unrelated' } }, { id: 'unrelated' }, { toolId: 'unrelated-spawn' });
		assert.deepStrictEqual(writes[0].parent.childActivities.records.map((record: any) => record.childId), ['keep', 'unrelated']); assert.strictEqual(writes[0].parent.childActivities.omitted, 0); assert.strictEqual(writes[0].parent.childActivities.retentionSaturated, false);
		const emptyPruned = (ChatThreadService.prototype as any)._pruneChildActivitiesForMessages.call({}, { messages: [thread.messages[0]], childActivities: { version: 1, records: [], omitted: 33, retentionSaturated: true } }, []);
		assert.deepStrictEqual(emptyPruned.records, []); assert.strictEqual(emptyPruned.omitted, 0); assert.strictEqual(emptyPruned.retentionSaturated, false);
		const retainedSaturated: any = { version: 1, records: [], omitted: 33, retentionSaturated: true }; const retained = (ChatThreadService.prototype as any)._pruneChildActivitiesForMessages.call({}, { messages: [thread.messages[0]], childActivities: retainedSaturated }, [thread.messages[0]]);
		assert.strictEqual(retained, retainedSaturated);
	});
	test('duplicating makes active activity inert and deleted tasks cannot be resurrected by late events', () => {
		const active: any = { generation: 1, childId: 'child', depth: 1, status: 'running', capabilityProfile: 'read_only', queuedMs: 0, runningMs: 1, totalMs: 1, anchor: { toolId: 'spawn' } };
		const original: any = { id: 'original', messages: [], childActivities: { version: 1, records: [active], omitted: 0, retentionSaturated: false }, state: {}, filesWithUserChanges: new Set() };
		const duplicate: any = { state: { allThreads: { original }, currentThreadId: 'original' }, _storeAllThreads() { }, _setState(value: any) { this.state = { ...this.state, ...value }; } };
		(ChatThreadService.prototype as any).duplicateThread.call(duplicate, 'original'); const copy = Object.values(duplicate.state.allThreads).find((thread: any) => thread.id !== 'original') as any;
		assert.strictEqual(copy.childActivities.records[0].status, 'interrupted');
		const deleted: any = { state: { allThreads: {}, currentThreadId: 'gone' }, _agentSubagentService: { getRunViews: () => [{ id: 'child', generation: 1, status: 'completed' }] }, _replaceChildActivities() { throw new Error('late event recreated deleted task'); } };
		assert.doesNotThrow(() => (ChatThreadService.prototype as any)._applyChildActivityEvent.call(deleted, 'gone', 1, 'child'));
	});
	test('generic and named Agent selections replace each other with the latest exact intent', () => {
		let selections: any[] = []; const receiver: any = { getCurrentFocusedMessageIdx: () => undefined, getCurrentThreadState: () => ({ stagingSelections: selections }), setCurrentThreadState: ({ stagingSelections }: any) => selections = stagingSelections };
		const generic = { type: 'Agent', label: 'Void application-level read-only', state: undefined } as const; const named = { type: 'Agent', label: 'Void application-level read-only', agentType: 'reader', catalogRevision: 'catalog', roleRevision: 'role', state: undefined } as const;
		ChatThreadService.prototype.addNewStagingSelection.call(receiver, generic); ChatThreadService.prototype.addNewStagingSelection.call(receiver, named); assert.strictEqual(selections.length, 1); assert.strictEqual(selections[0].agentType, 'reader');
		selections = []; ChatThreadService.prototype.addNewStagingSelection.call(receiver, named); ChatThreadService.prototype.addNewStagingSelection.call(receiver, generic); assert.strictEqual(selections.length, 1); assert.strictEqual(selections[0].agentType, undefined);
	});
	test('routes controls before builtin/MCP and preserves the parent tool id', async () => {
		const fixture = receiver(); const stores: any[] = []; fixture.value.state.allThreads.parent = { id: 'parent', messages: [], childActivities: { version: 1, records: [], omitted: 0, retentionSaturated: false }, state: {}, filesWithUserChanges: new Set() }; fixture.value._agentSubagentService.getRunViews = () => [{ id: 'child', generation: 0, depth: 1, status: 'queued', capabilityProfile: 'read_only', queuedMs: 0, runningMs: 0, totalMs: 0, authority: {} }]; fixture.value._storeAllThreads = (value: any) => stores.push(value); fixture.value._setState = (value: any) => { fixture.value.state = { ...fixture.value.state, ...value }; };
		await runTool(fixture.value, 'spawn_agent', 'provider-tool-id', { message: 'inspect' }); assert.strictEqual(fixture.calls[0][0], 'spawn'); assert.strictEqual(fixture.calls[0][1][3], undefined); assert.strictEqual(stores.length, 1); assert.strictEqual(stores[0].parent.messages.length, 1); assert.strictEqual(stores[0].parent.messages[0].id, 'provider-tool-id'); assert.strictEqual(stores[0].parent.messages[0].mcpServerName, undefined);
	});
	test('routes spawn through the exact success receipt and atomically persists its anchor', async () => {
		const fixture = receiver(); const stores: any[] = []; const states: any[] = []; fixture.value.state.allThreads.parent = { id: 'parent', messages: [], childActivities: { version: 1, records: [], omitted: 0, retentionSaturated: false }, state: {}, filesWithUserChanges: new Set() }; fixture.value._agentSubagentService.getRunViews = () => [{ id: 'child', generation: 0, depth: 1, status: 'queued', capabilityProfile: 'read_only', queuedMs: 0, runningMs: 0, totalMs: 0, authority: {} }]; fixture.value._storeAllThreads = (value: any) => stores.push(value); fixture.value._setState = (value: any) => { states.push(value); fixture.value.state = { ...fixture.value.state, ...value }; };
		await runTool(fixture.value, 'spawn_agent', 'provider-tool-id', { message: 'inspect' }); assert.strictEqual(fixture.calls[0][0], 'spawn'); assert.strictEqual(fixture.calls[0][1][3], undefined); assert.strictEqual(stores.length, 1); assert.strictEqual(states.length, 1); const saved = stores[0].parent; assert.strictEqual(saved.messages[0].type, 'success'); assert.strictEqual(saved.messages[0].id, 'provider-tool-id'); assert.deepStrictEqual(saved.messages[0].rawParams, { message: 'inspect' }); assert.deepStrictEqual(saved.childActivities.records[0].anchor, { toolId: 'provider-tool-id' });
	});
	test('fails closed without exact current authority and rejects unknown fields before state', async () => {
		const fixture = receiver();
		await runTool(fixture.value, 'spawn_agent', 'absent-id', { message: 'inspect' }, { authority: undefined, install: false });
		assert.deepStrictEqual(fixture.calls, []); assert.ok(/agent_delegation_not_authorized/.test(fixture.messages.pop().content));
		fixture.value._agentControlGeneration.set('parent', 1);
		const stale = Object.freeze({ allowed: true, generation: 0 });
		await runTool(fixture.value, 'spawn_agent', 'stale-id', { message: 'inspect' }, { authority: stale });
		assert.deepStrictEqual(fixture.calls, []); assert.ok(/agent_delegation_not_authorized/.test(fixture.messages.pop().content));
		await runTool(fixture.value, 'spawn_agent', 'bad-id', { message: 'inspect', unexpected: 'override' });
		assert.deepStrictEqual(fixture.calls, []); assert.strictEqual(fixture.messages[0].type, 'invalid_params'); assert.strictEqual(fixture.messages[0].id, 'bad-id');
	});
	test('generation drift and reset during deferred wait drop every late tool result', async () => {
		const fixture = receiver(); let release!: () => void; fixture.value._agentSubagentService.wait = async () => { fixture.calls.push('wait'); await new Promise<void>(resolve => release = resolve); return { id: 'child', status: 'completed', deliverSummary: true }; }; const pending = runTool(fixture.value, 'wait_agent', 'wait-id', { timeout_ms: 30000 }); await Promise.resolve(); fixture.value._agentControlGeneration.set('parent', 1); release(); assert.deepStrictEqual(await pending, { interrupted: true }); assert.deepStrictEqual(fixture.messages, []);
		const resetFixture = receiver(); installDestructiveLifecycleSeam(resetFixture.value); let releaseReset!: () => void; resetFixture.value._agentSubagentService.wait = async () => { resetFixture.calls.push('wait'); await new Promise<void>(resolve => releaseReset = resolve); return { id: 'child', status: 'completed', deliverSummary: true }; }; const resetPending = runTool(resetFixture.value, 'wait_agent', 'reset-wait-id', { timeout_ms: 30000 }); await eventually(() => typeof releaseReset === 'function', 'deferred wait did not start'); resetFixture.value._cancellingToolReceiptsOfThread.set('parent', new Map()); resetFixture.value._activeToolCardReceiptsOfThread.set('parent', new Map()); assert.strictEqual(await ChatThreadService.prototype.resetState.call(resetFixture.value), true); releaseReset(); assert.deepStrictEqual(await resetPending, { interrupted: true }); assert.deepStrictEqual(resetFixture.messages, []); assert.deepStrictEqual(resetFixture.calls, ['wait', ['forget:parent']]); assert.strictEqual(resetFixture.value._agentDelegationAuthorityOfThread.size, 0); assert.strictEqual(resetFixture.value._agentControlGeneration.size, 0); assert.strictEqual(resetFixture.value._cancellingToolReceiptsOfThread.size, 0); assert.strictEqual(resetFixture.value._activeToolCardReceiptsOfThread.size, 0); assert.strictEqual(resetFixture.value._deletingPendingInputThreads.size, 0);
	});
	test('generation drift also drops a deferred control rejection', async () => { const fixture = receiver(); let reject!: (error: Error) => void; fixture.value._agentSubagentService.wait = () => { fixture.calls.push('wait'); return new Promise((_resolve, rejectPromise) => reject = rejectPromise); }; const pending = runTool(fixture.value, 'wait_agent', 'wait-error-id', { timeout_ms: 30000 }); await Promise.resolve(); fixture.value._agentControlGeneration.set('parent', 1); reject(new Error('late')); assert.deepStrictEqual(await pending, { interrupted: true }); assert.deepStrictEqual(fixture.messages, []); });
	test('late completion reopens the broker history run before provider validation and a newer generation fences it', async () => {
		const build = (generation: number) => { const messages: any[] = []; let acked = 0, synced = 0, authorized = 0, verified = 0, validated = 0, started = 0, providerRequests = 0; let historyRunOpen = false; const runtimeSnapshot: any = { ownerProjectRoot: 'file:///workspace', workspaceTrustedAtAdmission: true, model: { hasModel: true, providerName: 'openAI', modelName: 'gpt-4.1', modelSelectionOptions: {} } }; const broker = {
			authorizeDirectHistoryAppend: async (_threadId: string, content: string, selections: readonly unknown[], runId: string, runGeneration: number) => { authorized++; assert.strictEqual(synced, 1); assert.strictEqual(content, '[Child child completed] result'); assert.deepStrictEqual(selections, []); assert.strictEqual(runId, 'run'); assert.strictEqual(runGeneration, 1); historyRunOpen = true; return { ok: true, value: { leaseId: 'mailbox-lease', pendingInputId: 'mailbox-input', selectionsFingerprint: 'mailbox-selections' } }; },
			verifyDirectHistoryAndRelease: async (_threadId: string, leaseId: string) => { verified++; assert.strictEqual(leaseId, 'mailbox-lease'); assert.strictEqual(messages[0].pendingInputId, 'mailbox-input'); assert.strictEqual(messages[0].pendingInputSelectionsFingerprint, 'mailbox-selections'); return { ok: true, value: { kind: 'exact' } }; },
			abandonDirectHistoryAppend: async () => ({ ok: true }), validateHistoryRun: async (_threadId: string, runId: string, runGeneration: number) => { validated++; return { ok: historyRunOpen && runId === 'run' && runGeneration === 1 }; },
		}; const value: any = {
			_agentMailboxContinuationScheduled: new Set(), _runQuiescenceOfThread: new Map(), _agentControlGeneration: new Map([['parent', generation]]), _parentRunTokenOfThread: new Map(), _startingParentRunOfThread: new Map(), _pendingChatSubmissionOfThread: new Map(), _childGroupSourceOfThread: new Map([['parent', { runId: 'run', generation: 1 }]]), _agentDelegationAuthorityOfThread: new Map([['parent', { allowed: true, generation: 1, runtimeSnapshot }]]), state: { allThreads: { parent: { messages } } },
			_workspaceContextService: { getWorkspace: () => ({ folders: [{ uri: URI.parse('file:///workspace') }] }) }, _workspaceTrustManagementService: { isWorkspaceTrusted: () => true }, _isAwaitingUser: () => false,
			_syncActiveChildGroup: async () => { await Promise.resolve(); synced++; return { ok: true, identity: { sourceRevision: 2, generation: 1, childIds: ['other-active-child'] } }; },
			_agentSubagentService: { peekParentMailbox: () => ({ messages: ['[Child child completed] result'], parentMessageCount: 0, completionSequences: [1] }), ackParentMailbox: () => { acked++; return true; } }, _addMessageToThread: (_id: string, message: any) => messages.push(message), _awaitThreadStorageWrites: async () => true,
			_pendingBroker: () => broker, _warnPendingMutation() { }, _releaseUndeliveredSteers: async () => { historyRunOpen = false; return true; },
			_startTrackedParentRun: (_id: string, _run: any, start: () => Promise<void>) => { started++; void start(); }, _runChatAgent: async ({ parentRun }: any) => { const valid = await broker.validateHistoryRun('parent', parentRun.runId, parentRun.generation); if (valid.ok) providerRequests++; },
		}; return { value, messages, counts: () => ({ acked, synced, authorized, verified, validated, started, providerRequests }) }; };
		const accepted = build(1); (ChatThreadService.prototype as any)._scheduleAgentMailboxContinuation.call(accepted.value, 'parent', 1, { runId: 'run', generation: 1 }); await new Promise(resolve => setTimeout(resolve, 10)); assert.strictEqual(accepted.messages.length, 1); assert.deepStrictEqual(accepted.counts(), { acked: 1, synced: 1, authorized: 1, verified: 1, validated: 1, started: 1, providerRequests: 1 });
		const stopped = build(2); (ChatThreadService.prototype as any)._scheduleAgentMailboxContinuation.call(stopped.value, 'parent', 1, { runId: 'run', generation: 1 }); await new Promise(resolve => setTimeout(resolve, 10)); assert.strictEqual(stopped.messages.length, 0); assert.deepStrictEqual(stopped.counts(), { acked: 0, synced: 0, authorized: 0, verified: 0, validated: 0, started: 0, providerRequests: 0 });
	});
	test('Stop and destructive state replacement revoke and forget active children', async () => { let cancelled = 0; const forgotten: string[] = []; const fake: any = installDestructiveLifecycleSeam(hydrateLifecycle({ _revokeAgentDelegation: revoke, _agentControlGeneration: new Map(), _agentDelegationAuthorityOfThread: new Map([['parent', Object.freeze({ allowed: true, generation: 0 })]]), _agentInstructionSessionOfThread: new Map(), _instructionTurnOfThread: new Map(), _transientComposerDraftOfThread: new Map(), _agentSubagentService: { cancelParent: () => cancelled++, forgetParent: (id: string) => forgotten.push(id) }, _toolsService: { invalidateReadReceipts(_threadId: string) { } }, state: { allThreads: { parent: {} }, currentThreadId: 'parent' }, streamState: {}, _setStreamState() { }, _restoreInstructionTurns() { }, _onDidChangeCurrentThread: { fire() { } } })); await ChatThreadService.prototype.abortRunning.call(fake, 'parent'); assert.strictEqual(cancelled, 1); assert.strictEqual(fake._agentControlGeneration.get('parent'), 1); assert.strictEqual(fake._agentDelegationAuthorityOfThread.has('parent'), false); fake._agentDelegationAuthorityOfThread.set('parent', Object.freeze({ allowed: true, generation: 1 })); fake._cancellingToolReceiptsOfThread.set('parent', new Map()); fake._activeToolCardReceiptsOfThread.set('parent', new Map()); assert.strictEqual(await ChatThreadService.prototype.dangerousSetState.call(fake, { allThreads: {}, currentThreadId: 'replacement' }), true); assert.deepStrictEqual(forgotten, ['parent']); assert.strictEqual(fake._agentDelegationAuthorityOfThread.size, 0); assert.strictEqual(fake._agentControlGeneration.size, 0); assert.strictEqual(fake._cancellingToolReceiptsOfThread.size, 0); assert.strictEqual(fake._activeToolCardReceiptsOfThread.size, 0); });
	test('central revoke is one-shot for purge, delete, replacement, reset, and dispose; switching tasks is non-destructive', async () => {
		const make = (threads: Record<string, any> = { parent: { state: {} }, other: { state: {} } }) => {
			const cancelled: string[] = [], forgotten: string[] = [];
			const value: any = hydrateLifecycle({ _revokeAgentDelegation: revoke, _agentControlGeneration: new Map([['parent', 4], ['other', 7]]), _agentDelegationAuthorityOfThread: new Map<string, Authority>([['parent', Object.freeze({ allowed: true, generation: 4 })], ['other', Object.freeze({ allowed: true, generation: 7 })]]), _agentInstructionSessionOfThread: new Map(Object.keys(threads).map(id => [id, {}])), _instructionTurnOfThread: new Map(Object.keys(threads).map(id => [id, {}])), _transientComposerDraftOfThread: new Map(), clearTransientComposerDraft(threadId: string) { this._transientComposerDraftOfThread.delete(threadId); }, _agentSubagentService: { cancelParent: (id: string) => cancelled.push(id), forgetParent: (id: string) => forgotten.push(id) }, _toolsService: { invalidateReadReceipts() { } }, _storeAllThreads() { }, _setState(patch: any) { this.state = { ...this.state, ...patch }; }, _restoreInstructionTurns() { }, _onDidChangeCurrentThread: { fire() { } }, _store: { dispose() { } }, openNewThread() { }, state: { allThreads: threads, currentThreadId: 'parent' } });
			return { value, cancelled, forgotten };
		};
		const switched = make(); ChatThreadService.prototype.switchToThread.call(switched.value, 'other'); assert.deepStrictEqual(switched.cancelled, []); assert.deepStrictEqual(switched.forgotten, []); assert.strictEqual(switched.value.state.currentThreadId, 'other');
		const purged = make({ parent: { state: {} } }); (ChatThreadService.prototype as any)._purgeInstructionTurn.call(purged.value, 'parent'); assert.deepStrictEqual(purged.cancelled, ['parent']); assert.strictEqual(purged.value._agentControlGeneration.get('parent'), 5);
		const deleted = make({ parent: { state: {} } }); installDestructiveLifecycleSeam(deleted.value); deleted.value._cancellingToolReceiptsOfThread.set('parent', new Map()); deleted.value._activeToolCardReceiptsOfThread.set('parent', new Map()); assert.strictEqual(await ChatThreadService.prototype.deleteThread.call(deleted.value, 'parent'), true); assert.deepStrictEqual(deleted.forgotten, ['parent']); assert.strictEqual(deleted.value._agentControlGeneration.has('parent'), false); assert.strictEqual(deleted.value._cancellingToolReceiptsOfThread.has('parent'), false); assert.strictEqual(deleted.value._activeToolCardReceiptsOfThread.has('parent'), false);
		const replaced = make({ parent: { state: {} }, other: { state: {} } }); installDestructiveLifecycleSeam(replaced.value); assert.strictEqual(await ChatThreadService.prototype.dangerousSetState.call(replaced.value, { allThreads: {}, currentThreadId: 'replacement' }), true); assert.deepStrictEqual(replaced.forgotten.sort(), ['other', 'parent']); assert.strictEqual(replaced.value._agentControlGeneration.size, 0);
		const reset = make({ parent: { state: {} }, other: { state: {} } }); installDestructiveLifecycleSeam(reset.value); assert.strictEqual(await ChatThreadService.prototype.resetState.call(reset.value), true); assert.deepStrictEqual(reset.forgotten.sort(), ['other', 'parent']); assert.strictEqual(reset.value._agentControlGeneration.size, 0);
		const disposed = make({ parent: { state: {} }, other: { state: {} } }); ChatThreadService.prototype.dispose.call(disposed.value); assert.deepStrictEqual(disposed.forgotten.sort(), ['other', 'parent']); assert.strictEqual(disposed.value._agentControlGeneration.size, 0);
	});
	test('native Agent routes admit custom roles without a marker, freeze configured limits, and never auto-spawn', async () => {
		let spawned = 0, catalogReads = 0; const messages: any[] = []; const warnings: any[] = []; const authorities: any[] = []; const catalog = createSkillCatalog([]); const role = { identity: 'project-reader', revision: 'role-1', description: 'Project winner' }; const thread: any = { messages, state: { stagingSelections: [], mountedInfo: undefined }, filesWithUserChanges: new Set<string>() };
		const fake: any = { state: { allThreads: { parent: thread } }, streamState: {}, _agentControlGeneration: new Map(), _agentDelegationAuthorityOfThread: new Map(), _agentSubagentService: { cancelParent() { }, forgetParent() { }, spawn() { spawned++; } }, _agentCustomAgentService: { getCatalog: async () => { catalogReads++; return { revision: 'roles', agents: [role], diagnostics: [] }; } }, _currentModelSelectionProps: () => ({ modelSelection: { providerName: 'openAI', modelName: 'gpt-4.1' }, modelSelectionOptions: {} }), _settingsService: { state: { globalSettings: { chatMode: 'agent' }, overridesOfModel: { openAI: { 'gpt-4.1': {} } } } }, _llmMessageService: { captureSettingsOfProvider: () => ({ frozen: true }) }, _beginInstructionTurn: async () => instructionSnapshot({ maxAcceptedChildren: 1, maxConcurrentThreadsPerSession: 1, maxDepth: 1 }, [{ source: 'user', reason: 'max_depth_invalid', code: 'agent_delegation_limits_invalid' }]), _purgeInstructionTurn() { }, _workspaceContextService: { getWorkspace: () => ({ folders: [{ uri: URI.parse('file:///workspace') }] }) }, _workspaceTrustManagementService: { isWorkspaceTrusted: () => true }, _agentSkillsService: { getCatalog: async () => catalog, readSkillBody: async () => ({}) }, _directoryStringService: {}, _fileService: {}, _notificationService: { notify: (warning: any) => warnings.push(warning) }, _rememberInstructionTurn() { }, _addMessageToThread: (_: string, message: any) => messages.push(message), _runChatAgent: async ({ agentDelegationAuthority }: any) => { authorities.push(agentDelegationAuthority); }, _wrapRunAgentToNotify: (promise: Promise<void>) => promise };
		fake._revokeAgentDelegation = revoke; fake._mcpService = { getMCPTools: () => [] }; installAdmissionPersistenceSeam(fake);
		await (ChatThreadService.prototype as any)._addUserMessageAndStreamResponse.call(fake, { userMessage: 'plain', _chatSelections: [], threadId: 'parent' });
		assert.strictEqual(catalogReads, 1);
		await (ChatThreadService.prototype as any)._addUserMessageAndStreamResponse.call(fake, { userMessage: 'inspect', _chatSelections: [{ type: 'Agent', label: 'Void application-level read-only', state: undefined }], threadId: 'parent' });
		await (ChatThreadService.prototype as any)._addUserMessageAndStreamResponse.call(fake, { userMessage: 'malformed', _chatSelections: [{ type: 'Agent', label: 'Agent', state: undefined } as any], threadId: 'parent' });
		const delegatedContent = messages.map(message => message.content).join('\n'); assert.strictEqual(spawned, 0); assert.strictEqual(catalogReads, 3); assert.strictEqual(messages.length, 3); assert.ok(delegatedContent.includes('project-reader')); assert.ok(delegatedContent.includes('spawn_agent')); assert.ok(delegatedContent.includes('up to 1')); assert.ok(delegatedContent.includes('1 running concurrently')); assert.ok(delegatedContent.includes('maximum depth 1')); assert.ok(delegatedContent.includes('wait_agent')); assert.strictEqual(messages[0].content.includes('spawn_agent'), true); assert.strictEqual(messages[0].content.includes('User delegation marker'), false); assert.strictEqual(messages[1].content.includes('User delegation marker'), true); assert.strictEqual(messages[2].content.includes('User delegation marker'), false);
		assert.deepStrictEqual(authorities.map(authority => authority.allowed), [true, true, true]); assert.deepStrictEqual(authorities[0].limits, { maxAcceptedChildren: 1, maxConcurrentThreadsPerSession: 1, maxDepth: 1 }); assert.strictEqual(messages[0].content.includes('User delegation marker'), false); assert.ok(authorities[0].generation < authorities[1].generation && authorities[1].generation < authorities[2].generation); assert.strictEqual(fake._agentDelegationAuthorityOfThread.get('parent'), authorities[2]); assert.strictEqual(warnings.length, 3); assert.ok(warnings.every(warning => warning.message === 'Some Agent child-limit settings were invalid. Check the Agent delegation configuration.')); assert.strictEqual(warnings.some(warning => /\.toml|file:\/\//.test(warning.message)), false);
		assert.strictEqual(authorities[0].roles.agents[0], role); assert.deepStrictEqual(authorities[0].settingsState, fake._settingsService.state); assert.deepStrictEqual(authorities[0].settingsOfProvider, { frozen: true });
		const routed = receiver(); routed.value._agentControlGeneration.set('parent', authorities[0].generation); await runTool(routed.value, 'spawn_agent', 'marker-free-role', { message: 'inspect', agent_type: 'project-reader' }, { authority: authorities[0] }); assert.strictEqual(routed.calls[0][0], 'spawn'); assert.strictEqual(routed.calls[0][1][3], 'project-reader'); assert.strictEqual(routed.calls[0][1][4], authorities[0].roles); assert.deepStrictEqual(routed.calls[0][1][5], authorities[0].settingsState); assert.deepStrictEqual(routed.calls[0][1][6], authorities[0].settingsOfProvider);
	});
	test('a named Agent role is exact parent intent, never an automatic child', async () => {
		let spawned = 0; const messages: any[] = []; const authorities: any[] = []; const catalog = createSkillCatalog([]); const role = { identity: 'project-reader', revision: 'role-1', description: 'Project reader' };
		const fake: any = { state: { allThreads: { parent: { messages, state: { stagingSelections: [], mountedInfo: undefined }, filesWithUserChanges: new Set<string>() } } }, streamState: {}, _agentControlGeneration: new Map(), _agentDelegationAuthorityOfThread: new Map(), _agentSubagentService: { cancelParent() { }, forgetParent() { }, spawn() { spawned++; } }, _agentCustomAgentService: { getCatalog: async () => ({ revision: 'catalog-1', agents: [role], diagnostics: [] }) }, _currentModelSelectionProps: () => ({ modelSelection: { providerName: 'openAI', modelName: 'gpt-4.1' }, modelSelectionOptions: {} }), _settingsService: { state: { globalSettings: { chatMode: 'agent' }, overridesOfModel: { openAI: { 'gpt-4.1': {} } } } }, _llmMessageService: { captureSettingsOfProvider: () => ({}) }, _beginInstructionTurn: async () => instructionSnapshot(), _purgeInstructionTurn() { }, _workspaceContextService: { getWorkspace: () => ({ folders: [{ uri: URI.parse('file:///workspace') }] }) }, _workspaceTrustManagementService: { isWorkspaceTrusted: () => true }, _agentSkillsService: { getCatalog: async () => catalog, readSkillBody: async () => ({}) }, _directoryStringService: {}, _fileService: {}, _rememberInstructionTurn() { }, _addMessageToThread: (_: string, message: any) => messages.push(message), _runChatAgent: async ({ agentDelegationAuthority }: any) => { authorities.push(agentDelegationAuthority); }, _wrapRunAgentToNotify: (promise: Promise<void>) => promise };
		const selection = { type: 'Agent', label: 'Void application-level read-only', agentType: 'project-reader', catalogRevision: 'catalog-1', roleRevision: 'role-1', state: undefined } as const;
		fake._revokeAgentDelegation = revoke; fake._mcpService = { getMCPTools: () => [] }; installAdmissionPersistenceSeam(fake);
		await (ChatThreadService.prototype as any)._addUserMessageAndStreamResponse.call(fake, { userMessage: 'inspect', _chatSelections: [selection], threadId: 'parent' });
		assert.strictEqual(spawned, 0); assert.strictEqual(authorities.length, 1); assert.strictEqual(authorities[0].roles.revision, 'catalog-1'); assert.ok(messages[0].content.includes('spawn_agent with agent_type=project-reader exactly'));
		const routed = receiver(); const namedStores: any[] = []; routed.value.state.allThreads.parent = { id: 'parent', messages: [], childActivities: { version: 1, records: [], omitted: 0, retentionSaturated: false }, state: {}, filesWithUserChanges: new Set() }; routed.value._agentSubagentService.getRunViews = () => [{ id: 'child', generation: 0, depth: 1, status: 'queued', capabilityProfile: 'read_only', roleName: 'project-reader', roleDescription: 'Project reader', queuedMs: 0, runningMs: 0, totalMs: 0, authority: {} }]; routed.value._storeAllThreads = (value: any) => namedStores.push(value); routed.value._setState = (value: any) => { routed.value.state = { ...routed.value.state, ...value }; }; const authority = Object.freeze({ allowed: true, generation: 0, roles: { revision: 'catalog-1', agents: [role], diagnostics: [] }, settingsState: {}, settingsOfProvider: {} });
		await runTool(routed.value, 'spawn_agent', 'named-spawn', { message: 'inspect', agent_type: 'project-reader' }, { authority: authority as Authority });
		assert.strictEqual(routed.calls[0][0], 'spawn'); assert.strictEqual(routed.calls[0][1][3], 'project-reader'); assert.strictEqual(namedStores.length, 1); assert.strictEqual(namedStores[0].parent.messages[0].type, 'success'); assert.strictEqual(namedStores[0].parent.childActivities.records[0].role?.name, 'project-reader');
	});
	test('a stale named Agent role stops before history or provider send', async () => {
		let runs = 0, forgotten = 0; const streamState: any = {}, authority = Object.freeze({ allowed: true, generation: 7 }); const fake: any = { state: { allThreads: { parent: { messages: [], state: { stagingSelections: [] }, filesWithUserChanges: new Set<string>() } } }, streamState, _agentControlGeneration: new Map([['parent', 7]]), _agentDelegationAuthorityOfThread: new Map([['parent', authority]]), _agentSubagentService: { forgetParent() { forgotten++; }, cancelParent() { } }, _agentCustomAgentService: { getCatalog: async () => ({ revision: 'catalog-2', agents: [], diagnostics: [] }) }, _currentModelSelectionProps: () => ({ modelSelection: { providerName: 'openAI', modelName: 'gpt-4.1' }, modelSelectionOptions: {} }), _settingsService: { state: { globalSettings: { chatMode: 'agent' }, overridesOfModel: { openAI: { 'gpt-4.1': {} } } } }, _llmMessageService: { captureSettingsOfProvider: () => ({}) }, _beginInstructionTurn: async () => instructionSnapshot(), _purgeInstructionTurn() { }, _workspaceContextService: { getWorkspace: () => ({ folders: [{ uri: URI.parse('file:///workspace') }] }) }, _workspaceTrustManagementService: { isWorkspaceTrusted: () => true }, _agentSkillsService: { getCatalog: async () => createSkillCatalog([]), readSkillBody: async () => ({}) }, _directoryStringService: {}, _fileService: {}, _runChatAgent: () => { runs++; return Promise.resolve(); }, _setStreamState: (threadId: string, value: any) => streamState[threadId] = value };
		fake._revokeAgentDelegation = revoke;
		const result = await (ChatThreadService.prototype as any)._addUserMessageAndStreamResponse.call(fake, { userMessage: 'inspect', _chatSelections: [{ type: 'Agent', label: 'Void application-level read-only', agentType: 'project-reader', catalogRevision: 'catalog-1', roleRevision: 'role-1', state: undefined }], threadId: 'parent' });
		assert.strictEqual(result, false); assert.strictEqual(runs, 0); assert.strictEqual(forgotten, 1); assert.strictEqual(fake._agentControlGeneration.get('parent'), 8); assert.strictEqual(fake._agentDelegationAuthorityOfThread.has('parent'), false); assert.strictEqual(fake.state.allThreads.parent.messages.length, 0); assert.ok(/changed or is no longer available/.test(streamState.parent.error.message));
	});
	test('a deferred custom-role catalog starts only after revocation and cannot admit a superseded turn', async () => {
		const messages: AdmissionMessage[] = [];
		const streamState: Record<string, AdmissionStream | undefined> = { parent: { isRunning: 'LLM', llmInfo: { displayContentSoFar: '', reasoningSoFar: '', toolCallSoFar: null }, interrupt: Promise.resolve(() => { }) } };
		const role: AdmissionRole = { identity: 'project-reader', revision: 'role-1', description: 'Project reader' };
		const catalog: AdmissionCatalog = { revision: 'catalog-1', agents: [role], diagnostics: [] };
		let catalogCalls = 0;
		let releaseFirstCatalog: (value: AdmissionCatalog) => void = () => { throw new Error('catalog was not entered'); };
		let catalogEntered: () => void = () => { throw new Error('catalog was not entered'); };
		const firstCatalogEntered = new Promise<void>(resolve => catalogEntered = resolve);
		const firstCatalog = new Promise<AdmissionCatalog>(resolve => releaseFirstCatalog = resolve);
		const fake = {
			state: { allThreads: { parent: { messages, state: { stagingSelections: [] }, filesWithUserChanges: new Set<string>() } } },
			streamState,
			_agentControlGeneration: new Map([['parent', 0]]),
			_parentRunTokenOfThread: new Map<string, symbol>(),
			_agentDelegationAuthorityOfThread: new Map(),
			_agentSubagentService: { cancelParent() { }, forgetParent() { } },
			_toolsService: { invalidateReadReceipts(_threadId: string) { } },
			_cancelChildToolApprovalsForParent(_threadId: string) { },
			_revokeAgentDelegation(threadId: string, forget = false) { admissionLifecycle._revokeAgentDelegation.call(this, threadId, forget); },
			async abortRunning(threadId: string) { this._revokeAgentDelegation(threadId); this._setStreamState(threadId, undefined); },
			_agentCustomAgentService: { getCatalog: async () => { catalogCalls++; if (catalogCalls === 1) { catalogEntered(); return firstCatalog; } return catalog; } },
			_currentModelSelectionProps: () => ({ modelSelection: { providerName: 'openAI', modelName: 'gpt-4.1' }, modelSelectionOptions: {} }),
			_settingsService: { state: { globalSettings: { chatMode: 'agent' }, overridesOfModel: { openAI: { 'gpt-4.1': {} } } } },
			_llmMessageService: { captureSettingsOfProvider: () => ({}) },
			_beginInstructionTurn: async () => instructionSnapshot(),
			_purgeInstructionTurn() { },
			_workspaceContextService: { getWorkspace: () => ({ folders: [{ uri: URI.parse('file:///workspace') }] }) },
			_workspaceTrustManagementService: { isWorkspaceTrusted: () => true },
			_agentSkillsService: { getCatalog: async () => createSkillCatalog([]), readSkillBody: async () => ({}) },
			_directoryStringService: {}, _fileService: {}, _mcpService: { getMCPTools: () => [] },
			_rememberInstructionTurn() { },
			_addMessageToThread(_threadId: string, message: AdmissionMessage) { messages.push(message); },
			_runChatAgent: async (_options: unknown) => { },
			_wrapRunAgentToNotify: (promise: Promise<void>) => promise,
			_releaseUndeliveredSteers: async () => { },
			_setStreamState(threadId: string, value: AdmissionStream | undefined) { streamState[threadId] = value; },
		};
		installAdmissionPersistenceSeam(fake);
		const selection: AdmissionSelection = { type: 'Agent', label: 'Void application-level read-only', agentType: 'project-reader', catalogRevision: 'catalog-1', roleRevision: 'role-1', state: undefined };
		const first = admissionLifecycle._addUserMessageAndStreamResponse.call(fake, { userMessage: 'first', _chatSelections: [selection], threadId: 'parent' });
		await firstCatalogEntered;
		assert.strictEqual(fake._agentControlGeneration.get('parent'), 1); assert.strictEqual(streamState.parent, undefined); assert.strictEqual(messages.length, 0);
		await admissionLifecycle._addUserMessageAndStreamResponse.call(fake, { userMessage: 'second', _chatSelections: [selection], threadId: 'parent' });
		assert.strictEqual(fake._agentControlGeneration.get('parent'), 2); releaseFirstCatalog(catalog); assert.strictEqual(await first, false); assert.deepStrictEqual(messages.map(message => message.displayContent), ['second']);
	});
	test('mixed generic and named Agent selections are rejected before history or provider send in either order', async () => {
		for (const selections of [[{ type: 'Agent', label: 'Void application-level read-only', state: undefined }, { type: 'Agent', label: 'Void application-level read-only', agentType: 'project-reader', catalogRevision: 'catalog-1', roleRevision: 'role-1', state: undefined }], [{ type: 'Agent', label: 'Void application-level read-only', agentType: 'project-reader', catalogRevision: 'catalog-1', roleRevision: 'role-1', state: undefined }, { type: 'Agent', label: 'Void application-level read-only', state: undefined }]] as const) {
			let runs = 0; const fake: any = { state: { allThreads: { parent: { messages: [], state: { stagingSelections: [] } } } }, streamState: {}, _agentControlGeneration: new Map(), _agentDelegationAuthorityOfThread: new Map(), _agentSubagentService: { forgetParent() { } }, _runChatAgent: () => { runs++; return Promise.resolve(); } };
			await assert.rejects(() => (ChatThreadService.prototype as any)._addUserMessageAndStreamResponse.call(fake, { userMessage: 'inspect', _chatSelections: selections, threadId: 'parent' }), /custom_agent_multiple_selections/);
			assert.strictEqual(runs, 0); assert.strictEqual(fake.state.allThreads.parent.messages.length, 0);
		}
	});
	test('an unsupported no-marker Agent route is diagnosed before any provider send', async () => {
		const streamState: any = {}; let runs = 0; const fake: any = { state: { allThreads: { parent: { state: { stagingSelections: [] } } }, globalSettings: { chatMode: 'agent' } }, streamState, _agentControlGeneration: new Map(), _agentDelegationAuthorityOfThread: new Map(), _agentSubagentService: { forgetParent() { } }, _currentModelSelectionProps: () => ({ modelSelection: { providerName: 'openAICompatible', modelName: 'custom-plain' }, modelSelectionOptions: {} }), _settingsService: { state: { globalSettings: { chatMode: 'agent' }, overridesOfModel: {} } }, _setStreamState: (threadId: string, value: any) => streamState[threadId] = value, _runChatAgent: () => { runs++; return Promise.resolve(); } };
		const result = await (ChatThreadService.prototype as any)._addUserMessageAndStreamResponse.call(fake, { userMessage: 'delegate', _chatSelections: [], threadId: 'parent' });
		assert.strictEqual(result, false); assert.strictEqual(runs, 0); assert.ok(/does not support native Agent tools/.test(streamState.parent.error.message));
	});
	test('a no-model Agent route is diagnosed before any provider send', async () => {
		const streamState: any = {}; let runs = 0; const fake: any = { state: { allThreads: { parent: { state: { stagingSelections: [] } } }, globalSettings: { chatMode: 'agent' } }, streamState, _agentControlGeneration: new Map(), _agentDelegationAuthorityOfThread: new Map(), _agentSubagentService: { forgetParent() { } }, _currentModelSelectionProps: () => ({ modelSelection: null, modelSelectionOptions: undefined }), _settingsService: { state: { globalSettings: { chatMode: 'agent' }, overridesOfModel: {} } }, _setStreamState: (threadId: string, value: any) => streamState[threadId] = value, _runChatAgent: () => { runs++; return Promise.resolve(); } };
		const result = await (ChatThreadService.prototype as any)._addUserMessageAndStreamResponse.call(fake, { userMessage: 'delegate', _chatSelections: [], threadId: 'parent' });
		assert.strictEqual(result, false); assert.strictEqual(runs, 0); assert.ok(/selected Chat model/.test(streamState.parent.error.message));
	});
});
