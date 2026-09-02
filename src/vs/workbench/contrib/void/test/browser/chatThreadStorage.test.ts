/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for details.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ChatThreadService } from '../../browser/chatThreadService.js';
import { EMPTY_CHILD_ACTIVITIES } from '../../common/agentSubagents.js';
import { THREAD_STORAGE_KEY, THREAD_STORAGE_MIGRATION_COMPLETE_KEY, THREAD_STORAGE_RECORD_PREFIX } from '../../common/storageKeys.js';
import { URI } from '../../../../../base/common/uri.js';

/** An application-storage hub deliberately gives every window its own cache. */
class SharedApplicationStorageHub {
	private readonly values = new Map<string, string>();
	private readonly clients: HubClient[] = [];
	client(): HubClient { const client = new HubClient(this); this.clients.push(client); return client; }
	write(sender: HubClient, key: string, value: string): void { this.values.set(key, value); sender.cache.set(key, value); }
	remove(sender: HubClient, key: string): void { this.values.delete(key); sender.cache.delete(key); }
	compareAndWrite(sender: HubClient, key: string, expectedRaw: string | undefined, nextRaw: string): { ok: true; value: string } | { ok: false; reason: 'conflict'; authoritativeRaw: string | undefined } {
		const authoritativeRaw = this.values.get(key);
		if (authoritativeRaw !== expectedRaw) return { ok: false, reason: 'conflict', authoritativeRaw };
		this.values.set(key, nextRaw);
		sender.cache.set(key, nextRaw);
		return { ok: true, value: nextRaw };
	}
	deliver(client: HubClient, key: string): void { const value = this.values.get(key); if (value === undefined) client.cache.delete(key); else client.cache.set(key, value); }
	keys(): string[] { return [...this.values.keys()]; }
}
class HubClient {
	readonly cache = new Map<string, string>();
	constructor(private readonly hub: SharedApplicationStorageHub) { }
	get(key: string): string | undefined { return this.cache.get(key); }
	store(key: string, value: string): void { this.hub.write(this, key, value); }
	remove(key: string): void { this.hub.remove(this, key); }
	commit(key: string, expectedRaw: string | undefined, nextRaw: string) { return this.hub.compareAndWrite(this, key, expectedRaw, nextRaw); }
	keys(): string[] { return this.hub.keys(); }
	catchUp(key: string): void { this.hub.deliver(this, key); }
}

const thread = (id: string, messages: any[] = []) => ({ id, createdAt: '2026-01-01T00:00:00.000Z', lastModified: '2026-01-01T00:00:00.000Z', messages, childActivities: EMPTY_CHILD_ACTIVITIES, filesWithUserChanges: new Set<string>(), state: { stagingSelections: [], focusedMessageIdx: undefined, linksOfMessageIdx: {} } });
const receiver = (client: HubClient, currentThreadId = 'A') => {
	const value: any = Object.create(ChatThreadService.prototype);
	value.state = { allThreads: {}, currentThreadId };
	value.streamState = {};
	value._localEmptyThreadId = undefined;
	value._pendingChatSubmissionOfThread = new Map(); value._pendingChatInputsOfThread = new Map(); value._drainingPendingChatInputs = new Set(); value._runQuiescenceOfThread = new Map(); value._startingParentRunOfThread = new Map(); value._deferredExternalThreadKey = new Map(); value._stopAndSendFlights = new Map(); value._deletingPendingInputThreads = new Set();
	value._threadStorageWriteTail = new Map(); value._threadStorageAuthoritativeRaw = new Map(); value._threadStorageWriteEpoch = new Map(); value._pendingNamespaceMutation = false; value._approvalActionFlights = new Set(); value._externalPendingDeleteRetries = new Map(); value._pendingThreadMutationRetries = new Map(); value._pendingDeliveredReconcileRequested = 0; value._pendingDeliveredReconcileFlight = undefined; value._pendingDeliveredReconcileRetry = undefined;
	value._agentDelegationAuthorityOfThread = new Map(); value._agentControlGeneration = new Map(); value._parentRunTokenOfThread = new Map(); value._cancellingToolReceiptsOfThread = new Map(); value._activeToolCardReceiptsOfThread = new Map(); value._agentInstructionSessionOfThread = new Map(); value._instructionTurnOfThread = new Map(); value._transientComposerDraftOfThread = new Map();
	value._childGroupSourceOfThread = new Map(); value._childGroupSyncRevisionOfThread = new Map(); value._childGroupSyncTailOfThread = new Map();
	value._childToolApprovals = new Map(); value._onDidChangeChildToolApprovals = { fire() { } };
	value._onDidChangePendingChatInputs = { fire() { } }; value._onDidChangePendingChatSubmission = { fire() { } }; value._onDidChangeStreamState = { fire() { value.streamEvents++; } }; value.streamEvents = 0; value._notificationService = { info(message: string) { value.notifications.push(message); }, notify(entry: { message: string }) { value.notifications.push(entry.message); } }; value.notifications = [];
	value._storePendingChatInputs = () => { }; value.forgotParents = []; value._agentSubagentService = { getRunViews: () => [], getCoordinationRunViews: () => [], cancelParent() { }, forgetParent(id: string) { value.forgotParents.push(id); } }; value._toolsService = { invalidateReadReceipts() { } };
	value._workspaceContextService = { getWorkspace: () => ({ folders: [] }) }; value._workspaceTrustManagementService = { isWorkspaceTrusted: () => true };
	value._onDidChangeCurrentThread = { fire() { value.externalEvents++; } };
	value.externalEvents = 0;
	value._storageService = {
		get(key: string) { return client.get(key); }, store(key: string, raw: string) { client.store(key, raw); },
		keys() { return client.keys(); },
		async flush() { },
	};
	const snapshot = { namespace: { profileId: 'profile', workspaceId: 'workspace' }, revision: 0, records: [] };
	value._pendingInputBrokerTestSeam = {
		initializeNamespace: async () => ({ ok: true, snapshot, value: {} }),
		reconcileDeliveredPendingInputIds: async () => ({ ok: true, snapshot, value: undefined }),
		commitThreadRecord: async (id: string, expectedRaw: string | undefined, nextRaw: string) => client.commit(key(id), expectedRaw, nextRaw),
		authorizeThreadAnchor: async () => ({ ok: true, snapshot, value: { existing: false, leaseId: 'anchor-lease' } }),
		verifyThreadAnchorAndRelease: async (id: string, leaseId: string) => {
			const raw = client.get(key(id));
			try { const parsed = JSON.parse(raw ?? 'null'); return parsed?.deleted !== true && parsed?.pendingInputAnchorLeaseId === leaseId ? { ok: true, snapshot, value: raw } : { ok: false, reason: 'conflict', snapshot }; }
			catch { return { ok: false, reason: 'conflict', snapshot }; }
		},
		abandonThreadAnchor: async () => ({ ok: true, snapshot, value: undefined }),
		closeRunAndReleaseSteers: async () => ({ ok: true, snapshot, value: undefined }),
		clearNamespace: async () => ({ ok: true, snapshot, value: { leaseId: 'namespace-lease' } }),
		finalizeNamespaceClear: async () => ({ ok: true, snapshot, value: undefined }),
		abortNamespaceClear: async () => ({ ok: true, snapshot, value: undefined }),
		deleteThreadRecords: async (id: string) => ({ ok: true, snapshot, value: { leaseId: `thread-${id}` } }),
		finalizeThreadDeletion: async (id: string) => { value._pendingChatInputsOfThread.delete(id); return { ok: true, snapshot, value: undefined }; },
	};
	value._pendingInputBrokerReady = Promise.resolve(true);
	value._drainPendingChatInputs = async () => { };
	value._register = () => undefined;
	value.setStateCalls = 0; value._setState = (partial: any) => { value.setStateCalls++; value.state = { ...value.state, ...partial }; };
	value._runToolCall = () => { throw new Error('external storage must not run tools'); };
	value._llmMessageService = { sendLLMMessage() { throw new Error('external storage must not call provider'); } };
	return value;
};
const key = (id: string) => `${THREAD_STORAGE_RECORD_PREFIX}${encodeURIComponent(id)}`;
const settleWrites = async (value: any) => assert.strictEqual(await (ChatThreadService.prototype as any)._awaitAllThreadStorageWrites.call(value), true);
const eventually = async (predicate: () => boolean, message: string) => { for (let attempt = 0; attempt < 100; attempt++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 0)); } assert.fail(message); };

suite('Void per-thread chat storage', () => {
	test('materializes only a pending-input blank anchor before broker admission', async () => {
		const hub = new SharedApplicationStorageHub(); const client = hub.client(); const w = receiver(client, 'blank'); const blank = thread('blank'); w.state.allThreads = { blank }; w._localEmptyThreadId = 'blank';
		assert.strictEqual(hub.keys().filter(item => item.startsWith(THREAD_STORAGE_RECORD_PREFIX)).length, 0);
		assert.strictEqual(await w._materializePendingInputThreadAnchor('blank'), 'anchor-lease');
		const raw = JSON.parse(client.get(key('blank'))!); assert.strictEqual(raw.deleted, undefined); assert.strictEqual(raw.thread.id, 'blank'); assert.strictEqual(raw.pendingInputAnchorLeaseId, 'anchor-lease');
	});

	test('materializes a File, Skill, and Agent selected blank with composer selections stripped and never re-anchors an existing record', async () => {
		const hub = new SharedApplicationStorageHub(); const client = hub.client(); const w = receiver(client, 'blank'); const blank: any = thread('blank'); blank.state.stagingSelections = [
			{ type: 'File', uri: URI.parse('file:///workspace/file.ts'), language: 'typescript', state: { wasAddedAsCurrentFile: false } },
			{ type: 'Skill', identity: 'reader', catalogRevision: 'catalog', bodyRevision: 'body', skillRoot: 'file:///skill', description: 'read' },
			{ type: 'Agent', label: 'Void application-level read-only', agentType: 'reader', catalogRevision: 'roles', roleRevision: 'role', state: undefined },
		]; w.state.allThreads = { blank }; w._localEmptyThreadId = 'blank';
		assert.strictEqual(await w._materializePendingInputThreadAnchor('blank'), 'anchor-lease'); const firstRaw = client.get(key('blank'))!; assert.deepStrictEqual(JSON.parse(firstRaw).thread.state.stagingSelections, []);
		let authorizations = 0; w._pendingInputBrokerTestSeam.authorizeThreadAnchor = async () => { authorizations++; return { ok: true, snapshot: { namespace: {}, revision: 0, records: [] }, value: { existing: true } }; };
		assert.strictEqual(await w._materializePendingInputThreadAnchor('blank'), undefined); assert.strictEqual(authorizations, 0); assert.strictEqual(client.get(key('blank')), firstRaw);
	});

	test('drops only an externally removed unused temporary anchor and independently re-anchors two local drafts', async () => {
		const hub = new SharedApplicationStorageHub(); const source = hub.client(); const observing = hub.client(); const anchorRaw = JSON.stringify({ version: 1, revision: 1, thread: thread('anchor'), pendingInputAnchorLeaseId: 'lease' }); source.store(key('anchor'), anchorRaw); observing.catchUp(key('anchor'));
		const w = receiver(observing, 'own-blank'); w.state.allThreads = { 'own-blank': thread('own-blank') }; w._localEmptyThreadId = 'own-blank'; w._transientComposerDraftOfThread.set('own-blank', 'my other draft'); w._applyExternalThreadRecord(key('anchor')); assert.ok(w.state.allThreads.anchor);
		source.remove(key('anchor')); observing.catchUp(key('anchor')); w._applyExternalThreadRecord(key('anchor')); assert.strictEqual(w.state.allThreads.anchor, undefined); assert.strictEqual(w.notifications.length, 0);
		source.store(key('edited'), JSON.stringify({ version: 1, revision: 1, thread: thread('edited'), pendingInputAnchorLeaseId: 'lease-2' })); observing.catchUp(key('edited')); w._applyExternalThreadRecord(key('edited')); w._transientComposerDraftOfThread.set('edited', 'keep me'); w.state.allThreads.edited.state.stagingSelections = [{ type: 'File', uri: URI.parse('file:///workspace/keep.ts'), language: 'typescript', state: { wasAddedAsCurrentFile: false } }]; source.remove(key('edited')); observing.catchUp(key('edited')); w._applyExternalThreadRecord(key('edited'));
		assert.ok(w.state.allThreads.edited); assert.strictEqual(w.getTransientComposerDraft('edited'), 'keep me'); assert.strictEqual(w._localEmptyThreadId, 'own-blank'); assert.strictEqual(w._threadStorageAuthoritativeRaw.get('edited'), undefined);
		const reauthorized: string[] = []; w._pendingInputBrokerTestSeam.authorizeThreadAnchor = async (threadId: string) => ({ ok: true, snapshot: { namespace: {}, revision: 0, records: [] }, value: { existing: false, leaseId: `re-anchor-${threadId}` } });
		const verify = w._pendingInputBrokerTestSeam.verifyThreadAnchorAndRelease; w._pendingInputBrokerTestSeam.verifyThreadAnchorAndRelease = async (threadId: string, leaseId: string) => { reauthorized.push(threadId); return verify(threadId, leaseId); };
		assert.strictEqual(await w._materializePendingInputThreadAnchor('edited'), 're-anchor-edited'); assert.strictEqual(await w._materializePendingInputThreadAnchor('own-blank'), 're-anchor-own-blank'); assert.deepStrictEqual(reauthorized.sort(), ['edited', 'own-blank']);
		assert.strictEqual(w.getTransientComposerDraft('edited'), 'keep me'); assert.strictEqual(w.getTransientComposerDraft('own-blank'), 'my other draft'); assert.deepStrictEqual(w.state.allThreads.edited.state.stagingSelections.map((item: any) => item.type), ['File']); assert.deepStrictEqual(JSON.parse(observing.get(key('edited'))!).thread.state.stagingSelections, []); assert.deepStrictEqual(JSON.parse(observing.get(key('own-blank'))!).thread.state.stagingSelections, []);
	});

	test('adopts the authoritative CAS winner and rejects a stale same-thread write', async () => {
		const hub = new SharedApplicationStorageHub(); const c1 = hub.client(); const baseline = JSON.stringify({ version: 1, revision: 1, thread: thread('A', [{ role: 'user', content: 'base' }]) }); c1.store(key('A'), baseline);
		const c2 = hub.client(); c2.catchUp(key('A')); const w1 = receiver(c1, 'A'); const w2 = receiver(c2, 'A'); w1.state.allThreads = { A: thread('A', [{ role: 'user', content: 'base' }]) }; w2.state.allThreads = { A: thread('A', [{ role: 'user', content: 'base' }]) };
		w1._storeAllThreads({ A: thread('A', [{ role: 'user', content: 'winner' }]) }); assert.strictEqual(await w1._awaitAllThreadStorageWrites(), true);
		w2._storeAllThreads({ A: thread('A', [{ role: 'user', content: 'stale' }]) }); assert.strictEqual(await w2._awaitAllThreadStorageWrites(), false);
		assert.strictEqual(w2.state.allThreads.A.messages[0].content, 'winner'); assert.strictEqual(w2.notifications.length, 1);
	});

	test('keeps unrelated A and B across stale delayed delivery, and restores exact history', async () => {
		const hub = new SharedApplicationStorageHub(); const c1 = hub.client(); const c2 = hub.client(); const w1 = receiver(c1, 'A'); const w2 = receiver(c2, 'B');
		w1._storeAllThreads({ A: thread('A', [{ role: 'user', content: 'A' }]) }); w1.state.allThreads = { A: thread('A', [{ role: 'user', content: 'A' }]) }; await settleWrites(w1);
		w2._storeAllThreads({ B: thread('B', [{ role: 'user', content: 'B' }, { role: 'assistant', displayContent: 'B answer' }]) }); w2.state.allThreads = { B: thread('B', [{ role: 'user', content: 'B' }, { role: 'assistant', displayContent: 'B answer' }]) }; await settleWrites(w2);
		// W1 settles A before and after receiving B. Its stale map has no B.
		w1._storeAllThreads({ A: thread('A', [{ role: 'user', content: 'A' }, { role: 'assistant', displayContent: 'A answer' }]) }); w1.state.allThreads.A = thread('A', [{ role: 'user', content: 'A' }, { role: 'assistant', displayContent: 'A answer' }]); await settleWrites(w1);
		c1.catchUp(key('B')); w1._applyExternalThreadRecord(key('B'));
		assert.strictEqual(w1.state.currentThreadId, 'A'); assert.strictEqual(w1.state.allThreads.B.messages.length, 2);
		w1._storeAllThreads({ ...w1.state.allThreads, A: thread('A', [{ role: 'user', content: 'A' }, { role: 'assistant', displayContent: 'A final' }]) }); await settleWrites(w1);
		const c3 = hub.client(); for (const storageKey of hub.keys()) c3.catchUp(storageKey); const w3 = receiver(c3); const restored = w3._readAllThreads();
		assert.deepStrictEqual(Object.keys(restored).sort(), ['A', 'B']); assert.strictEqual(restored.B.messages[1].displayContent, 'B answer');
	});

	test('blank views are local, while persisted empty history remains history', async () => {
		const hub = new SharedApplicationStorageHub(); const w1 = receiver(hub.client()); const w2 = receiver(hub.client());
		w1.openNewThread(); w2.openNewThread(); assert.notStrictEqual(w1.state.currentThreadId, w2.state.currentThreadId);
		w1._storeAllThreads(w1.state.allThreads); assert.strictEqual(hub.keys().filter(k => k.startsWith(THREAD_STORAGE_RECORD_PREFIX)).length, 0);
		const persisted = thread('old-empty'); w1._storeThreadRecord('old-empty', persisted); await settleWrites(w1); const c3 = hub.client(); for (const storageKey of hub.keys()) c3.catchUp(storageKey); const w3 = receiver(c3); w3.state.allThreads = w3._readAllThreads(); w3.openNewThread();
		assert.notStrictEqual(w3.state.currentThreadId, 'old-empty'); assert.ok(w3.state.allThreads['old-empty']);
	});

	test('repeated replacement plans never tombstone local-only blank ids', () => {
		const hub = new SharedApplicationStorageHub(); const client = hub.client(); const w = receiver(client, 'blank-1'); const first: any = thread('blank-1'); first.state.stagingSelections = [{ type: 'Skill', identity: 'reader', catalogRevision: 'catalog', bodyRevision: 'body', skillRoot: 'file:///skill', description: 'read' }]; w._localEmptyThreadId = 'blank-1'; w.state.allThreads = { 'blank-1': first };
		assert.deepStrictEqual(w._buildThreadReplacementPlan({}).writes, []);
		const second = thread('blank-2'); w._localEmptyThreadId = 'blank-2'; w.state.allThreads = { 'blank-2': second }; assert.deepStrictEqual(w._buildThreadReplacementPlan({}).writes, []); assert.deepStrictEqual(hub.keys().filter(item => item.startsWith(THREAD_STORAGE_RECORD_PREFIX)), []);
	});

	test('tombstones prevent stale unrelated writes from resurrecting B', async () => {
		const hub = new SharedApplicationStorageHub(); const c1 = hub.client(); const c2 = hub.client(); const w1 = receiver(c1, 'A'); const w2 = receiver(c2, 'B');
		const initial = { A: thread('A', [{ role: 'user', content: 'A' }]), B: thread('B', [{ role: 'user', content: 'B' }]) }; w1._storeAllThreads(initial); w1.state.allThreads = initial; await settleWrites(w1);
		for (const storageKey of hub.keys()) c2.catchUp(storageKey); w2.state.allThreads = { B: thread('B', [{ role: 'user', content: 'B' }]) }; w2._storeAllThreads({}); w2.state.allThreads = {}; await settleWrites(w2);
		w1._storeAllThreads({ ...w1.state.allThreads, A: thread('A', [{ role: 'user', content: 'A2' }]) }); await settleWrites(w1);
		const c3 = hub.client(); for (const storageKey of hub.keys()) c3.catchUp(storageKey); const w3 = receiver(c3); assert.deepStrictEqual(Object.keys(w3._readAllThreads()), ['A']);
	});

	test('fences active same-thread changes and ignores malformed external records', () => {
		const hub = new SharedApplicationStorageHub(); const client = hub.client(); const w = receiver(client, 'A'); w.state.allThreads = { A: thread('A', [{ role: 'user', content: 'local' }]) };
		w.streamState = { A: { isRunning: 'LLM' } }; client.store(key('A'), JSON.stringify({ version: 1, revision: 1, thread: thread('A', [{ role: 'user', content: 'external' }]) })); w._applyExternalThreadRecord(key('A'));
		assert.strictEqual(w.state.allThreads.A.messages[0].content, 'local'); assert.strictEqual(w.externalEvents, 0); assert.strictEqual(w.setStateCalls, 0);
		client.store(`${THREAD_STORAGE_RECORD_PREFIX}%`, '{not-json'); assert.doesNotThrow(() => w._applyExternalThreadRecord(`${THREAD_STORAGE_RECORD_PREFIX}%`));
		client.store(key('bad'), JSON.stringify({ version: 2, revision: 1, thread: thread('bad') })); assert.doesNotThrow(() => w._applyExternalThreadRecord(key('bad'))); assert.strictEqual(w.state.allThreads.bad, undefined);
	});

	test('applies an idle selected tombstone to a fresh local blank without leaving a dangling current id', async () => {
		const hub = new SharedApplicationStorageHub(); const client = hub.client(); const w = receiver(client, 'A'); w.state.allThreads = { A: thread('A') }; w.streamState.A = { error: new Error('stale') }; w._transientComposerDraftOfThread.set('A', 'draft'); w._instructionTurnOfThread.set('A', {}); w._pendingChatInputsOfThread.set('A', [{}]);
		client.store(key('A'), JSON.stringify({ version: 1, revision: 2, deleted: true })); w._applyExternalThreadRecord(key('A'));
		assert.ok(w.state.allThreads[w.state.currentThreadId]); assert.notStrictEqual(w.state.currentThreadId, 'A'); assert.strictEqual(w.getCurrentThread().id, w.state.currentThreadId); assert.strictEqual(w.state.allThreads.A, undefined); assert.strictEqual(w.streamState.A, undefined); assert.strictEqual(w.streamEvents, 1); assert.strictEqual(w.externalEvents, 1); assert.strictEqual(w._transientComposerDraftOfThread.has('A'), false); assert.strictEqual(w._instructionTurnOfThread.has('A'), false); await eventually(() => !w._pendingChatInputsOfThread.has('A'), 'main-authoritative tombstone cleanup did not update the projection'); assert.strictEqual(JSON.parse(client.get(key('A'))!).deleted, true); assert.strictEqual(w.notifications.length, 1);
		w._applyExternalThreadRecord(key('A')); assert.strictEqual(w.streamEvents, 1); assert.strictEqual(w.externalEvents, 1); assert.strictEqual(w.notifications.length, 1);
	});

	test('reuses its existing unmaterialized local blank after selected external delete', () => {
		const hub = new SharedApplicationStorageHub(); const client = hub.client(); const w = receiver(client, 'A'); const blank = thread('local-blank'); w._localEmptyThreadId = blank.id; w.state.allThreads = { A: thread('A'), [blank.id]: blank };
		client.store(key('A'), JSON.stringify({ version: 1, revision: 1, deleted: true })); w._applyExternalThreadRecord(key('A'));
		assert.strictEqual(w.state.currentThreadId, blank.id); assert.deepStrictEqual(Object.keys(w.state.allThreads), [blank.id]);
	});

	test('defers an active tombstone until quiescence, then clears local metadata exactly once', async () => {
		const hub = new SharedApplicationStorageHub(); const client = hub.client(); const w = receiver(client, 'A'); w.state.allThreads = { A: thread('A') }; w.streamState = { A: { isRunning: 'tool' } }; w._transientComposerDraftOfThread.set('A', 'draft'); w._instructionTurnOfThread.set('A', {}); w._pendingChatInputsOfThread.set('A', [{}]);
		client.store(key('A'), JSON.stringify({ version: 1, revision: 2, deleted: true })); w._applyExternalThreadRecord(key('A')); assert.ok(w.state.allThreads.A); assert.strictEqual(w._deferredExternalThreadKey.get('A'), key('A'));
		w.streamState = {}; w._applyDeferredExternalThreadRecordIfQuiescent('A'); assert.strictEqual(w.state.allThreads.A, undefined); assert.ok(w.state.allThreads[w.state.currentThreadId]); assert.strictEqual(w._deferredExternalThreadKey.has('A'), false); await eventually(() => !w._pendingChatInputsOfThread.has('A'), 'deferred tombstone cleanup did not update the projection'); assert.strictEqual(w._instructionTurnOfThread.has('A'), false); assert.deepStrictEqual(w.forgotParents, ['A']); assert.strictEqual(w.notifications.length, 1);
	});

	test('restored approval without a live lease reconciles the latest deferred record before any Queue drain', () => {
		const hub = new SharedApplicationStorageHub(); const client = hub.client(); const w = receiver(client, 'A'); w.state.allThreads = { A: thread('A', [{ role: 'user', content: 'local' }]) };
		let drains = 0; w._drainPendingChatInputs = () => { drains++; return Promise.resolve(); };
		client.store(key('A'), JSON.stringify({ version: 1, revision: 2, thread: thread('A', [{ role: 'user', content: 'latest' }]) })); w._deferredExternalThreadKey.set('A', key('A'));
		(ChatThreadService.prototype as any)._releaseAwaitingApprovalQuiescence.call(w, 'A');
		assert.strictEqual(w.state.allThreads.A.messages[0].content, 'latest'); assert.strictEqual(drains, 1);
		client.store(key('A'), JSON.stringify({ version: 1, revision: 3, deleted: true })); w._deferredExternalThreadKey.set('A', key('A'));
		(ChatThreadService.prototype as any)._releaseAwaitingApprovalQuiescence.call(w, 'A');
		assert.strictEqual(w.state.allThreads.A, undefined); assert.strictEqual(drains, 1); assert.strictEqual(w.notifications.length, 1);
	});

	test('registers only external per-thread storage events', () => {
		const hub = new SharedApplicationStorageHub(); const client = hub.client(); const w = receiver(client, 'A'); let listener: ((event: any) => void) | undefined;
		w._storageService.onDidChangeValue = () => (next: (event: any) => void) => { listener = next; return { dispose() { } }; };
		client.store(key('B'), JSON.stringify({ version: 1, revision: 1, thread: thread('B', [{ role: 'user', content: 'remote' }]) })); w._registerExternalThreadStorageListener();
		listener!({ external: false, key: key('B') }); assert.strictEqual(w.state.allThreads.B, undefined);
		listener!({ external: true, key: 'not-a-thread-record' }); assert.strictEqual(w.state.allThreads.B, undefined);
		listener!({ external: true, key: key('B') }); assert.strictEqual(w.state.allThreads.B.messages[0].content, 'remote');
	});

	test('merges a selected idle thread while retaining its local composer and mount ownership', () => {
		const hub = new SharedApplicationStorageHub(); const client = hub.client(); const w = receiver(client, 'A'); const mountedInfo: any = { local: true };
		w._transientComposerDraftOfThread.set('A', 'transient draft');
		w.state.allThreads = { A: { ...thread('A', [{ role: 'user', content: 'old' }]), state: { ...thread('A').state, stagingSelections: ['local-draft'], focusedMessageIdx: 0, mountedInfo } } };
		client.store(key('A'), JSON.stringify({ version: 1, revision: 2, thread: thread('A', [{ role: 'user', content: 'remote' }]) })); w._applyExternalThreadRecord(key('A'));
		assert.strictEqual(w.state.currentThreadId, 'A'); assert.strictEqual(w.state.allThreads.A.messages[0].content, 'remote'); assert.deepStrictEqual(w.state.allThreads.A.state.stagingSelections, ['local-draft']); assert.strictEqual(w.state.allThreads.A.state.focusedMessageIdx, 0); assert.strictEqual(w.state.allThreads.A.state.mountedInfo, mountedInfo); assert.strictEqual(w._transientComposerDraftOfThread.get('A'), 'transient draft'); assert.strictEqual(w.setStateCalls, 0);
	});

	test('fences a background-running thread even when another thread is selected', () => {
		const hub = new SharedApplicationStorageHub(); const client = hub.client(); const w = receiver(client, 'A'); w.state.allThreads = { A: thread('A'), B: thread('B', [{ role: 'user', content: 'local B' }]) }; w.streamState = { B: { isRunning: 'tool' } };
		client.store(key('B'), JSON.stringify({ version: 1, revision: 1, thread: thread('B', [{ role: 'user', content: 'remote B' }]) })); w._applyExternalThreadRecord(key('B'));
		assert.strictEqual(w.state.allThreads.B.messages[0].content, 'local B'); assert.strictEqual(w.setStateCalls, 0);
	});

	test('imports the legacy aggregate without dropping URI, message, or child fields', () => {
		const hub = new SharedApplicationStorageHub(); const client = hub.client(); const legacy = thread('legacy', [{ role: 'user', content: 'keep', state: { uri: URI.parse('file:///legacy.ts') } }]); client.store(THREAD_STORAGE_KEY, JSON.stringify({ legacy }));
		const w = receiver(client); const restored = w._readAllThreads(); assert.strictEqual(restored.legacy.messages[0].content, 'keep'); assert.strictEqual(restored.legacy.messages[0].state.uri.scheme, 'file'); assert.deepStrictEqual(restored.legacy.childActivities.records, []);
	});

	test('resumes a crashed partial migration by retaining untouched legacy threads', async () => {
		const hub = new SharedApplicationStorageHub(); const client = hub.client(); client.store(THREAD_STORAGE_KEY, JSON.stringify({ A: thread('A', [{ role: 'user', content: 'legacy A' }]), B: thread('B', [{ role: 'user', content: 'legacy B' }]) }));
		const crashed = receiver(client); crashed._storeThreadRecord('A', thread('A', [{ role: 'user', content: 'v3 A' }])); await settleWrites(crashed);
		const resumed = receiver(client); const merged = resumed._readAllThreads(); assert.strictEqual(merged.A.messages[0].content, 'v3 A'); assert.strictEqual(merged.B.messages[0].content, 'legacy B');
		resumed._storeAllThreads(merged); await settleWrites(resumed); await resumed._completeLegacyThreadStorageMigration(); assert.strictEqual(client.get(THREAD_STORAGE_MIGRATION_COMPLETE_KEY), '1');
	});

	test('does not write the migration marker when a later per-thread import fails', async () => {
		const hub = new SharedApplicationStorageHub(); const client = hub.client(); client.store(THREAD_STORAGE_KEY, JSON.stringify({ A: thread('A'), B: thread('B') })); const w = receiver(client); const merged = w._readAllThreads(); const original = w._storeThreadRecord; let writes = 0;
		w._storeThreadRecord = (id: string, value: any) => { if (++writes === 2) throw new Error('B write failed'); return original.call(w, id, value); };
		assert.throws(() => w._migrateLegacyThreadStorage(merged), /B write failed/); await settleWrites(w); assert.strictEqual(client.get(THREAD_STORAGE_MIGRATION_COMPLETE_KEY), undefined);
		const resumed = receiver(client); const restored = resumed._readAllThreads(); assert.ok(restored.A); assert.ok(restored.B); resumed._migrateLegacyThreadStorage(restored); await settleWrites(resumed); await Promise.resolve(); await Promise.resolve(); assert.strictEqual(client.get(THREAD_STORAGE_MIGRATION_COMPLETE_KEY), '1');
	});

	test('keeps an approval-held deferred record until the approval lease releases, then reads latest bytes', async () => {
		const hub = new SharedApplicationStorageHub(); const client = hub.client(); const w = receiver(client, 'A'); w.state.allThreads = { A: thread('A', [{ role: 'user', content: 'local' }]) }; const release = () => { }; w._runQuiescenceOfThread.set('A', { runId: 'run', generation: 1, settled: Promise.resolve(), releaseAwaitingApproval: release });
		client.store(key('A'), JSON.stringify({ version: 1, revision: 1, thread: thread('A', [{ role: 'user', content: 'first' }]) })); w._applyExternalThreadRecord(key('A')); client.store(key('A'), JSON.stringify({ version: 1, revision: 2, thread: thread('A', [{ role: 'user', content: 'latest' }]) })); w._releaseAwaitingApprovalQuiescence('A', false); assert.ok(w.state.allThreads.A); assert.ok(w._deferredExternalThreadKey.has('A')); w._runQuiescenceOfThread.set('A', { runId: 'replacement', generation: 2, settled: Promise.resolve(), releaseAwaitingApproval: release }); w._releaseAwaitingApprovalQuiescence('A');
		await eventually(() => w.state.allThreads.A?.messages[0]?.content === 'latest' && !w._deferredExternalThreadKey.has('A'), 'approval release did not consume the deferred authoritative record');
		assert.strictEqual(w.state.allThreads.A.messages[0].content, 'latest'); assert.strictEqual(w._deferredExternalThreadKey.has('A'), false);
	});

	test('uses a live v3 record and matching v3 tombstone over the incomplete legacy baseline', async () => {
		const hub = new SharedApplicationStorageHub(); const client = hub.client(); client.store(THREAD_STORAGE_KEY, JSON.stringify({ A: thread('A', [{ role: 'user', content: 'legacy A' }]), B: thread('B', [{ role: 'user', content: 'legacy B' }]) }));
		const w = receiver(client); w._storeThreadRecord('A', thread('A', [{ role: 'user', content: 'override A' }])); w._storeThreadTombstone('B'); await settleWrites(w);
		const restored = receiver(client)._readAllThreads(); assert.strictEqual(restored.A.messages[0].content, 'override A'); assert.strictEqual(restored.B, undefined);
	});

	test('uses only v3 records after the migration marker is complete', async () => {
		const hub = new SharedApplicationStorageHub(); const client = hub.client(); client.store(THREAD_STORAGE_KEY, JSON.stringify({ legacyOnly: thread('legacyOnly') })); const w = receiver(client); w._storeThreadRecord('A', thread('A')); await settleWrites(w); client.store(THREAD_STORAGE_MIGRATION_COMPLETE_KEY, '1');
		const restored = receiver(client)._readAllThreads(); assert.deepStrictEqual(Object.keys(restored), ['A']);
	});

	test('malformed and unrelated v3 tombstones do not suppress legacy, but a matching tombstone does', () => {
		const hub = new SharedApplicationStorageHub(); const client = hub.client(); const legacy = thread('legacy'); client.store(THREAD_STORAGE_KEY, JSON.stringify({ legacy })); client.store(`${THREAD_STORAGE_RECORD_PREFIX}%`, '{broken');
		const malformedOnly = receiver(client); assert.ok(malformedOnly._readAllThreads().legacy);
		client.store(key('gone'), JSON.stringify({ version: 1, revision: 1, deleted: true })); const unrelated = receiver(client); assert.ok(unrelated._readAllThreads().legacy);
		client.store(key('legacy'), JSON.stringify({ version: 1, revision: 1, deleted: true })); const tombstoned = receiver(client); assert.deepStrictEqual(tombstoned._readAllThreads(), {});
	});

	test('instruction snapshot upsert and purge change only its serialized thread record', async () => {
		const hub = new SharedApplicationStorageHub(); const client = hub.client(); const w = receiver(client); w.state.allThreads = { A: thread('A') };
		const snapshot: any = { ownerProjectRoot: 'file:///workspace', runCwd: 'file:///workspace', workspaceTrustedAtAdmission: true };
		w._rememberInstructionTurn('A', snapshot); await settleWrites(w); let stored: any;
		const observer = hub.client(); observer.catchUp(key('A')); stored = JSON.parse(observer.get(key('A'))!); assert.deepStrictEqual(stored.thread.state.agentInstructionTurnSnapshot, snapshot);
		w._purgeInstructionTurn('A', false, false); await settleWrites(w); observer.catchUp(key('A')); stored = JSON.parse(observer.get(key('A'))!); assert.strictEqual(stored.thread.state.agentInstructionTurnSnapshot, undefined);
	});

	test('reset writes tombstones before its new blank view and a delivered tombstone fences stale resurrection', async () => {
		const hub = new SharedApplicationStorageHub(); const c1 = hub.client(); const c2 = hub.client(); const w1 = receiver(c1, 'A'); const w2 = receiver(c2, 'A');
		c1.store(THREAD_STORAGE_KEY, JSON.stringify({ A: thread('A', [{ role: 'user', content: 'old' }]), B: thread('B', [{ role: 'user', content: 'legacy unseen' }]) })); w1._didReadLegacyThreadStorage = true; const initial = { A: thread('A', [{ role: 'user', content: 'old' }]) }; w1._storeAllThreads(initial); w1.state.allThreads = initial; await settleWrites(w1);
		for (const storageKey of hub.keys()) c2.catchUp(storageKey); w2.state.allThreads = { A: thread('A', [{ role: 'user', content: 'stale' }]) };
		assert.strictEqual(await w1.resetState(), true); c2.catchUp(key('A')); w2._storeAllThreads({ A: thread('A', [{ role: 'user', content: 'stale later' }]) });
		assert.strictEqual(await w2._awaitAllThreadStorageWrites(), false, 'the delivered tombstone must reject the stale writer instead of silently acknowledging it');
		const c3 = hub.client(); for (const storageKey of hub.keys()) c3.catchUp(storageKey); const w3 = receiver(c3); assert.deepStrictEqual(w3._readAllThreads(), {});
	});

	test('an exact global replacement may import a reset tombstone id while ordinary stale CAS remains terminal', async () => {
		const hub = new SharedApplicationStorageHub(); const c1 = hub.client(); const c2 = hub.client(); const w1 = receiver(c1, 'A'); const exported = thread('A', [{ role: 'user', content: 'exported' }]); w1.state.allThreads = { A: exported }; w1._storeThreadRecord('A', exported); await settleWrites(w1);
		c2.catchUp(key('A')); const stale = receiver(c2, 'A'); stale.state.allThreads = { A: thread('A', [{ role: 'user', content: 'stale' }]) };
		assert.strictEqual(await w1.resetState(), true); const tombstone = c1.get(key('A'))!; assert.strictEqual(JSON.parse(tombstone).deleted, true);
		assert.strictEqual(await w1.dangerousSetState({ allThreads: { A: exported }, currentThreadId: 'A' }), true); assert.strictEqual(JSON.parse(c1.get(key('A'))!).thread.messages[0].content, 'exported');
		stale._storeThreadRecord('A', thread('A', [{ role: 'user', content: 'stale resurrection' }])); assert.strictEqual(await stale._awaitAllThreadStorageWrites(), false); assert.strictEqual(JSON.parse(c1.get(key('A'))!).thread.messages[0].content, 'exported');
	});
});
