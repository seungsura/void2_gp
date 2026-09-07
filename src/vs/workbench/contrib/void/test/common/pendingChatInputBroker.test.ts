/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import {
	PendingChatInputAuthority,
	PendingChatInputBrokerCore,
	PendingChatInputBrokerStorage,
	PendingChatInputNamespace,
	PENDING_CHAT_INPUT_APPEND_LEASE_TIMEOUT_MS,
	PENDING_CHAT_INPUT_GLOBAL_MUTATION_KEY,
	PENDING_CHAT_INPUT_SESSION_TIMEOUT_MS,
	pendingChatInputChatStorageFingerprint,
	pendingChatInputFingerprint,
	pendingChatInputMutationReceiptKey,
	pendingChatInputSelectionsFingerprint,
	pendingChatInputThreadFingerprint,
	pendingChatInputThreadStorageKey,
} from '../../common/pendingChatInputBroker.js';

class MemoryStorage implements PendingChatInputBrokerStorage {
	readonly whenReady = Promise.resolve();
	readonly values = new Map<string, string>();
	readonly chronology: string[] = [];
	flushes = 0;
	failFlushes = 0;
	failStores = 0;
	get(key: string) { return this.values.get(key); }
	store(key: string, value: string) { if (this.failStores-- > 0) throw new Error('store failed'); this.chronology.push(`store:${key}`); this.values.set(key, value); }
	storeUser(key: string, value: string) { this.store(key, value); }
	storeAll(entries: readonly Readonly<{ key: string; value: string }>[]) { if (this.failStores-- > 0) throw new Error('store failed'); this.chronology.push('storeAll'); for (const entry of entries) this.values.set(entry.key, entry.value); }
	remove(key: string) { this.values.delete(key); }
	removeUser(key: string) { this.remove(key); }
	keys(_target: 'machine' | 'user') { return [...this.values.keys()]; }
	async flush() { this.flushes++; this.chronology.push('flush'); if (this.failFlushes-- > 0) throw new Error('flush failed'); }
}

class ControlledFlushStorage extends MemoryStorage {
	private block = false;
	private reachedResolve: (() => void) | undefined;
	private releaseResolve: (() => void) | undefined;
	blockNextFlush(): Readonly<{ reached: Promise<void>; release: () => void }> {
		this.block = true;
		const reached = new Promise<void>(resolve => this.reachedResolve = resolve);
		return Object.freeze({ reached, release: () => this.releaseResolve?.() });
	}
	override async flush() {
		await super.flush();
		if (!this.block) return;
		this.block = false; this.reachedResolve?.();
		await new Promise<void>(resolve => this.releaseResolve = resolve);
		this.reachedResolve = undefined; this.releaseResolve = undefined;
	}
}

const namespace: PendingChatInputNamespace = Object.freeze({ profileId: 'profile-a', workspaceIdentity: '{"kind":"folder","id":"workspace","uri":"file:///workspace"}' });
const authority: PendingChatInputAuthority = Object.freeze({ threadExists: true, ownerProjectRoot: 'file:///workspace', workspaceTrusted: true, generation: 0 });
const delivered = Object.freeze({ task: Object.freeze([] as string[]) });
const installThreadAnchor = (core: PendingChatInputBrokerCore, threadId: string) => {
	const storage = (core as unknown as { storage: MemoryStorage }).storage; const key = pendingChatInputThreadStorageKey(threadId);
	if (!storage.get(key)) storage.storeUser(key, JSON.stringify({ version: 1, revision: 1, thread: { id: threadId, messages: [] } }));
};
const initialize = (core: PendingChatInputBrokerCore, ctx: string, ns = namespace, legacyRaw?: string) => { installThreadAnchor(core, 'task'); return core.initializeNamespace(ctx, { namespace: ns, knownThreadIds: ['task'], deliveredPendingInputIds: delivered, ...(legacyRaw === undefined ? {} : { legacyRaw }) }); };
const submit = (core: PendingChatInputBrokerCore, ctx: string, sessionId: string, text: string, mode: 'queue' | 'steer' = 'queue', phase: 'queued' | 'steering' = 'queued') => core.submit(ctx, { sessionId, threadId: 'task', text, selections: [], mode, phase, ownerProjectRoot: 'file:///workspace', trustedAtSubmit: true, generation: 0, ...(phase === 'steering' ? { runId: 'run' } : {}) });
const fingerprint = (entries: readonly Readonly<{ key: string; value: string | undefined }>[]) => pendingChatInputChatStorageFingerprint(entries);
const threadDeletionPlan = (storage: MemoryStorage, threadId = 'task') => {
	const key = pendingChatInputThreadStorageKey(threadId); const baseline = storage.get(key);
	let revision = 0; try { revision = Number((JSON.parse(baseline ?? '') as { revision?: unknown }).revision) || 0; } catch { /* start at one */ }
	const expectedRaw = JSON.stringify({ version: 1, revision: revision + 1, deleted: true });
	return { key, expectedRaw, evidence: Object.freeze({ baselineFingerprint: fingerprint([{ key, value: baseline }]), expectedFingerprint: fingerprint([{ key, value: expectedRaw }]) }) };
};
const namespaceNoopEvidence = (storage: MemoryStorage) => {
	const entries = [...storage.values].filter(([key]) => key.startsWith('void.chatThreadStorageIII.') && key !== 'void.chatThreadStorageIII.migrationComplete').map(([key, value]) => ({ key, value }));
	const value = fingerprint(entries); return Object.freeze({ baselineFingerprint: value, expectedFingerprint: value });
};
const commitPlan = async (storage: MemoryStorage, leaseId: string, writes: readonly Readonly<{ key: string; value: string }>[]) => { for (const write of writes) storage.store(write.key, write.value); storage.store(pendingChatInputMutationReceiptKey(leaseId), leaseId); await storage.flush(); };
const historyEnvelope = (threadId: string, pendingInputId: string, text: string) => JSON.stringify({ version: 1, revision: 2, thread: { id: threadId, messages: [{ role: 'user', pendingInputId, displayContent: text, pendingInputSelectionsFingerprint: pendingChatInputSelectionsFingerprint([]) }] } });

suite('Void pending chat input main-process broker', () => {
	test('serializes two-window submit, assigns unique FIFO rows, and flushes before broadcast', async () => {
		let id = 0; const storage = new MemoryStorage(); const core = new PendingChatInputBrokerCore(storage, () => 100, () => `id-${++id}`);
		const a = await initialize(core, 'window:1'); const b = await initialize(core, 'window:2'); assert.ok(a.ok && b.ok);
		const revisions: number[] = []; core.onDidChange(snapshot => { assert.strictEqual(storage.chronology.at(-1), 'flush'); revisions.push(snapshot.revision); });
		const [one, two] = await Promise.all([submit(core, 'window:1', a.value.sessionId, 'one'), submit(core, 'window:2', b.value.sessionId, 'two')]);
		assert.ok(one.ok && two.ok); assert.deepStrictEqual(two.snapshot.records.map(record => record.text), ['one', 'two']); assert.deepStrictEqual(two.snapshot.records.map(record => record.order), [0, 1]); assert.notStrictEqual(two.snapshot.records[0].id, two.snapshot.records[1].id); assert.strictEqual(revisions.length, 2);
	});

	test('does not broadcast or acknowledge a mutation before its storage flush settles', async () => {
		let id = 0; const storage = new ControlledFlushStorage(); const core = new PendingChatInputBrokerCore(storage, () => 100, () => `id-${++id}`); const init = await initialize(core, 'window:1'); assert.ok(init.ok);
		const gate = storage.blockNextFlush(); let settled = false; let events = 0; core.onDidChange(() => events++);
		const operation = submit(core, 'window:1', init.value.sessionId, 'blocked').then(result => { settled = true; return result; });
		await gate.reached; await Promise.resolve(); assert.strictEqual(settled, false); assert.strictEqual(events, 0);
		gate.release(); const result = await operation; assert.ok(result.ok); assert.strictEqual(settled, true); assert.strictEqual(events, 1);
	});

	test('keeps a live window from claiming another window active row and makes close-before-claim dormant', async () => {
		const storage = new MemoryStorage(); let id = 0; const core = new PendingChatInputBrokerCore(storage, () => 100, () => `id-${++id}`);
		const w1 = await initialize(core, 'window:1'); const w2 = await initialize(core, 'window:2'); assert.ok(w1.ok && w2.ok);
		const added = await submit(core, 'window:2', w2.value.sessionId, 'from w2'); assert.ok(added.ok);
		const foreign = await core.claimNextQueued('window:1', w1.value.sessionId, 'task', authority, []); assert.ok(foreign.ok); assert.strictEqual(foreign.value, undefined); assert.strictEqual(foreign.snapshot.records[0].phase, 'queued');
		await core.releaseConnection('window:2'); assert.strictEqual(w1.ok && (await core.heartbeat('window:1', w1.value.sessionId)).snapshot!.records[0].phase, 'dormant');
		const dormant = (await core.heartbeat('window:1', w1.value.sessionId)).snapshot!.records[0]; const resumed = await core.resume('window:1', w1.value.sessionId, 'task', dormant.id, pendingChatInputFingerprint(dormant), authority); assert.ok(resumed.ok);
		const claim = await core.claimNextQueued('window:1', w1.value.sessionId, 'task', authority, []); assert.ok(claim.ok && claim.value); assert.strictEqual(claim.value.record.id, dormant.id);
	});

	test('cold main restart normalizes queued, steering, and claiming survivors to dormant without volatile owners', async () => {
		const storage = new MemoryStorage(); let id = 0; const core = new PendingChatInputBrokerCore(storage, () => 100, () => `id-${++id}`); const init = await initialize(core, 'window:1'); assert.ok(init.ok);
		await submit(core, 'window:1', init.value.sessionId, 'queue'); await submit(core, 'window:1', init.value.sessionId, 'steer', 'steer', 'steering'); const claim = await core.claimNextQueued('window:1', init.value.sessionId, 'task', authority, []); assert.ok(claim.ok && claim.value);
		core.dispose(); const restarted = new PendingChatInputBrokerCore(storage, () => 200, () => `restart-${++id}`); const after = await initialize(restarted, 'window:3'); assert.ok(after.ok); assert.deepStrictEqual(after.snapshot.records.map(record => record.phase), ['dormant', 'dormant']); assert.ok(after.snapshot.records.every(record => record.claimId === undefined && record.runId === undefined));
		const stored = [...storage.values.values()].map(value => { try { return JSON.parse(value) as { version?: number; records?: Array<{ phase?: string; runId?: string; claimId?: string }> }; } catch { return undefined; } }).find(value => value?.version === 2);
		assert.ok(stored?.records); assert.ok(stored.records.every(record => record.phase === 'dormant' && record.runId === undefined && record.claimId === undefined));
	});

	test('durably prunes cold v2 rows whose chat no longer exists before initialization acknowledges', async () => {
		const storage = new MemoryStorage(); let id = 0;
		const first = new PendingChatInputBrokerCore(storage, () => 100, () => `id-${++id}`); const opened = await initialize(first, 'window:1'); assert.ok(opened.ok);
		assert.ok((await submit(first, 'window:1', opened.value.sessionId, 'orphan')).ok); first.dispose();
		const restarted = new PendingChatInputBrokerCore(storage, () => 200, () => `id-${++id}`);
		const compacted = await restarted.initializeNamespace('window:2', { namespace, knownThreadIds: ['different-task'], deliveredPendingInputIds: {} });
		assert.ok(compacted.ok); assert.strictEqual(compacted.snapshot.records.length, 0);
		restarted.dispose();
		const verified = await initialize(new PendingChatInputBrokerCore(storage, () => 300, () => `id-${++id}`), 'window:3');
		assert.ok(verified.ok); assert.strictEqual(verified.snapshot.records.length, 0);
	});

	test('does not recompact a live namespace from a stale reconnect projection', async () => {
		const storage = new MemoryStorage(); let id = 0;
		const core = new PendingChatInputBrokerCore(storage, () => 100, () => `id-${++id}`);
		const first = await initialize(core, 'window:1'); assert.ok(first.ok);
		installThreadAnchor(core, 'later-task'); const b = await core.submit('window:1', { sessionId: first.value.sessionId, threadId: 'later-task', text: 'later', selections: [], mode: 'queue', phase: 'queued', ownerProjectRoot: 'file:///workspace', trustedAtSubmit: true, generation: 0 });
		assert.ok(b.ok); await core.releaseConnection('window:1');
		const reopened = await core.initializeNamespace('window:2', { namespace, knownThreadIds: ['task'], deliveredPendingInputIds: delivered });
		assert.ok(reopened.ok); assert.deepStrictEqual(reopened.snapshot.records.map(record => [record.threadId, record.phase]), [['later-task', 'dormant']]);
		core.dispose();
		const cold = await new PendingChatInputBrokerCore(storage, () => 200, () => `id-${++id}`).initializeNamespace('window:3', { namespace, knownThreadIds: ['task'], deliveredPendingInputIds: delivered });
		assert.ok(cold.ok); assert.strictEqual(cold.snapshot.records.length, 0);
	});

	test('authorizes one exact append lease, settles durably, and blocks stale settlement', async () => {
		const storage = new MemoryStorage(); let id = 0; const core = new PendingChatInputBrokerCore(storage, () => 100, () => `id-${++id}`); const init = await initialize(core, 'window:1'); assert.ok(init.ok); await submit(core, 'window:1', init.value.sessionId, 'queue');
		const claim = await core.claimNextQueued('window:1', init.value.sessionId, 'task', authority, []); assert.ok(claim.ok && claim.value); const lease = await core.authorizeAppend('window:1', init.value.sessionId, 'task', claim.value.record.id, claim.value.record.claimId!, claim.value.fingerprint, authority, 'run', 0); assert.ok(lease.ok);
		const plan = threadDeletionPlan(storage); const blocked = await core.deleteThreadRecords('window:1', init.value.sessionId, 'task', plan.evidence); assert.ok(!blocked.ok && blocked.reason === 'append_in_progress');
		storage.store(pendingChatInputThreadStorageKey('task'), historyEnvelope('task', claim.value.record.id, claim.value.record.text));
		const settled = await core.verifyHistoryAndSettle('window:1', init.value.sessionId, 'task', claim.value.record.id, claim.value.record.claimId!, lease.value.leaseId); assert.ok(settled.ok); assert.strictEqual(settled.snapshot.records.length, 0);
		const stale = await core.verifyHistoryAndSettle('window:1', init.value.sessionId, 'task', claim.value.record.id, claim.value.record.claimId!, lease.value.leaseId); assert.ok(!stale.ok && stale.reason === 'conflict');
	});

	test('blocks destructive prepare behind an unleased cross-namespace claim and reopens after exact settlement or abort', async () => {
		let id = 0; const storage = new MemoryStorage(); const core = new PendingChatInputBrokerCore(storage, () => 100, () => `id-${++id}`);
		const first = await initialize(core, 'window:1');
		const otherNamespace = Object.freeze({ profileId: namespace.profileId, workspaceIdentity: '{"kind":"folder","id":"other","uri":"file:///other"}' });
		const second = await initialize(core, 'window:2', otherNamespace); assert.ok(first.ok && second.ok);
		const added = await submit(core, 'window:1', first.value.sessionId, 'claim before preparation'); assert.ok(added.ok);
		const claim = await core.claimNextQueued('window:1', first.value.sessionId, 'task', authority, []); assert.ok(claim.ok && claim.value);
		const plan = threadDeletionPlan(storage);
		const blocked = await Promise.all([
			core.deleteThreadRecords('window:1', first.value.sessionId, 'task', plan.evidence),
			core.deleteThreadRecords('window:2', second.value.sessionId, 'task', plan.evidence),
			core.clearNamespace('window:1', first.value.sessionId, namespaceNoopEvidence(storage)),
			core.clearNamespace('window:2', second.value.sessionId, namespaceNoopEvidence(storage)),
		]);
		for (const result of blocked) assert.ok(!result.ok && result.reason === 'append_in_progress');
		assert.ok((await core.settleClaim('window:1', first.value.sessionId, 'task', claim.value.record.id, claim.value.record.claimId!, undefined, 'queued')).ok);
		const preparedDelete = await core.deleteThreadRecords('window:2', second.value.sessionId, 'task', plan.evidence); assert.ok(preparedDelete.ok); assert.strictEqual(preparedDelete.snapshot.records.length, 0);
		assert.ok((await core.abortThreadDeletion('window:2', second.value.sessionId, 'task', preparedDelete.value.leaseId)).ok);
		const reclaimed = await core.claimNextQueued('window:1', first.value.sessionId, 'task', authority, []); assert.ok(reclaimed.ok && reclaimed.value); assert.strictEqual(reclaimed.value.record.id, added.value.id);
		assert.ok((await core.settleClaim('window:1', first.value.sessionId, 'task', reclaimed.value.record.id, reclaimed.value.record.claimId!, undefined, 'queued')).ok);
		const preparedClear = await core.clearNamespace('window:2', second.value.sessionId, namespaceNoopEvidence(storage)); assert.ok(preparedClear.ok); assert.strictEqual(preparedClear.snapshot.records.length, 0);
		assert.ok((await core.abortNamespaceClear('window:2', second.value.sessionId, preparedClear.value.leaseId)).ok);
		const afterAbort = await core.claimNextQueued('window:1', first.value.sessionId, 'task', authority, []); assert.ok(afterAbort.ok && afterAbort.value); assert.strictEqual(afterAbort.value.record.id, added.value.id);
	});

	test('prepares thread deletion without removing rows and commits them only on exact finalize', async () => {
		let id = 0; const storage = new MemoryStorage(); const core = new PendingChatInputBrokerCore(storage, () => 100, () => `id-${++id}`);
		const one = await initialize(core, 'window:1'); const two = await initialize(core, 'window:2'); assert.ok(one.ok && two.ok);
		assert.ok((await submit(core, 'window:1', one.value.sessionId, 'preserve until chat tombstone')).ok);
		const plan = threadDeletionPlan(storage); const prepared = await core.deleteThreadRecords('window:1', one.value.sessionId, 'task', plan.evidence); assert.ok(prepared.ok); assert.strictEqual(prepared.snapshot.records.length, 1);
		const foreign = await submit(core, 'window:2', two.value.sessionId, 'blocked during tombstone'); assert.ok(!foreign.ok && foreign.reason === 'conflict');
		await commitPlan(storage, prepared.value.leaseId, [{ key: plan.key, value: plan.expectedRaw }]);
		const committed = await core.finalizeThreadDeletion('window:1', one.value.sessionId, 'task', prepared.value.leaseId); assert.ok(committed.ok); assert.strictEqual(committed.snapshot.records.length, 0);
		const repeated = await core.finalizeThreadDeletion('window:1', one.value.sessionId, 'task', prepared.value.leaseId); assert.ok(repeated.ok); assert.strictEqual(repeated.snapshot.records.length, 0);
		const afterTombstone = await submit(core, 'window:2', two.value.sessionId, 'after tombstone'); assert.ok(!afterTombstone.ok && afterTombstone.reason === 'conflict');
	});

	test('retries an exact namespace finalize after flush failure and lost acknowledgement', async () => {
		let id = 0; const storage = new MemoryStorage(); const core = new PendingChatInputBrokerCore(storage, () => 100, () => `id-${++id}`);
		const one = await initialize(core, 'window:1'); assert.ok(one.ok); assert.ok((await submit(core, 'window:1', one.value.sessionId, 'preserved')).ok);
		const prepared = await core.clearNamespace('window:1', one.value.sessionId, namespaceNoopEvidence(storage)); assert.ok(prepared.ok); assert.strictEqual(prepared.snapshot.records.length, 1);
		await commitPlan(storage, prepared.value.leaseId, []);
		storage.failFlushes = 1;
		const failed = await core.finalizeNamespaceClear('window:1', one.value.sessionId, prepared.value.leaseId); assert.ok(!failed.ok && failed.reason === 'backend_unavailable'); assert.strictEqual(failed.snapshot!.records.length, 1);
		const retried = await core.finalizeNamespaceClear('window:1', one.value.sessionId, prepared.value.leaseId); assert.ok(retried.ok); assert.strictEqual(retried.snapshot.records.length, 0);
		await core.releaseConnection('window:1'); const two = await initialize(core, 'window:2'); assert.ok(two.ok);
		const lostAckRetry = await core.finalizeNamespaceClear('window:2', two.value.sessionId, prepared.value.leaseId); assert.ok(lostAckRetry.ok); assert.strictEqual(lostAckRetry.snapshot.records.length, 0);
	});

	test('aborts a failed thread deletion prepare without changing rows or leaving a fence', async () => {
		let id = 0; const storage = new MemoryStorage(); const core = new PendingChatInputBrokerCore(storage, () => 100, () => `id-${++id}`);
		const one = await initialize(core, 'window:1'); const two = await initialize(core, 'window:2'); assert.ok(one.ok && two.ok); assert.ok((await submit(core, 'window:1', one.value.sessionId, 'keep')).ok);
		const plan = threadDeletionPlan(storage); const prepared = await core.deleteThreadRecords('window:1', one.value.sessionId, 'task', plan.evidence); assert.ok(prepared.ok);
		const aborted = await core.abortThreadDeletion('window:1', one.value.sessionId, 'task', prepared.value.leaseId); assert.ok(aborted.ok); assert.strictEqual(aborted.snapshot.records.length, 1);
		assert.ok((await submit(core, 'window:2', two.value.sessionId, 'unblocked')).ok);
		storage.failFlushes = 1; const failed = await core.clearNamespace('window:1', one.value.sessionId, namespaceNoopEvidence(storage)); assert.ok(!failed.ok && failed.reason === 'backend_unavailable');
		assert.strictEqual((await core.heartbeat('window:1', one.value.sessionId)).snapshot!.records.length, 2);
	});

	test('keeps orphaned thread and namespace mutation barriers until bounded expiry', async () => {
		let now = 100; let id = 0; const storage = new MemoryStorage(); const core = new PendingChatInputBrokerCore(storage, () => now, () => `id-${++id}`);
		const one = await initialize(core, 'window:1'); const two = await initialize(core, 'window:2'); assert.ok(one.ok && two.ok);
		const threadPlan = threadDeletionPlan(storage); const threadLease = await core.deleteThreadRecords('window:1', one.value.sessionId, 'task', threadPlan.evidence); assert.ok(threadLease.ok); await core.releaseConnection('window:1');
		assert.ok(!(await submit(core, 'window:2', two.value.sessionId, 'blocked by orphan thread lease')).ok);
		now += PENDING_CHAT_INPUT_APPEND_LEASE_TIMEOUT_MS + 1; await core.expireSessions(now); assert.ok((await submit(core, 'window:2', two.value.sessionId, 'thread lease expired')).ok);
		const reopened = await initialize(core, 'window:3'); assert.ok(reopened.ok); const namespaceLease = await core.clearNamespace('window:3', reopened.value.sessionId, namespaceNoopEvidence(storage)); assert.ok(namespaceLease.ok); await core.releaseConnection('window:3');
		assert.ok(!(await submit(core, 'window:2', two.value.sessionId, 'blocked by orphan namespace lease')).ok);
		now += PENDING_CHAT_INPUT_APPEND_LEASE_TIMEOUT_MS + 1; await core.expireSessions(now); assert.ok((await submit(core, 'window:2', two.value.sessionId, 'namespace lease expired')).ok);
	});

	test('renews a live slow mutation with heartbeat and bounds it after owner disconnect', async () => {
		let now = 0; let id = 0; const storage = new MemoryStorage(); const core = new PendingChatInputBrokerCore(storage, () => now, () => `id-${++id}`);
		const one = await initialize(core, 'window:1'); const two = await initialize(core, 'window:2'); assert.ok(one.ok && two.ok);
		const prepared = await core.clearNamespace('window:1', one.value.sessionId, namespaceNoopEvidence(storage)); assert.ok(prepared.ok);
		now = PENDING_CHAT_INPUT_APPEND_LEASE_TIMEOUT_MS - 1; assert.ok((await core.heartbeat('window:1', one.value.sessionId)).ok);
		now = PENDING_CHAT_INPUT_APPEND_LEASE_TIMEOUT_MS * 2 - 2;
		const stillBlocked = await submit(core, 'window:2', two.value.sessionId, 'must wait for slow import'); assert.ok(!stillBlocked.ok && stillBlocked.reason === 'conflict');
		await core.releaseConnection('window:1');
		now += PENDING_CHAT_INPUT_APPEND_LEASE_TIMEOUT_MS + 1; await core.expireSessions(now);
		assert.ok((await submit(core, 'window:2', two.value.sessionId, 'orphan lease expired')).ok);
	});

	test('expires only the exact append lease and fences its stale timer after settlement', async () => {
		let now = 100; let id = 0; const storage = new MemoryStorage(); const core = new PendingChatInputBrokerCore(storage, () => now, () => `id-${++id}`); const init = await initialize(core, 'window:1'); assert.ok(init.ok); await submit(core, 'window:1', init.value.sessionId, 'queue'); const claim = await core.claimNextQueued('window:1', init.value.sessionId, 'task', authority, []); assert.ok(claim.ok && claim.value); const lease = await core.authorizeAppend('window:1', init.value.sessionId, 'task', claim.value.record.id, claim.value.record.claimId!, claim.value.fingerprint, authority, 'run', 0); assert.ok(lease.ok);
		now += PENDING_CHAT_INPUT_APPEND_LEASE_TIMEOUT_MS + 1; await core.expireSessions(now); const after = await core.heartbeat('window:1', init.value.sessionId); assert.ok(after.ok); assert.strictEqual(after.snapshot.records[0].phase, 'dormant');
		const stale = await core.verifyHistoryAndSettle('window:1', init.value.sessionId, 'task', claim.value.record.id, claim.value.record.claimId!, lease.value.leaseId); assert.ok(!stale.ok);
	});

	test('imports legacy once across profiles and later stale raw is cleanup-only', async () => {
		const legacyRecord = { id: 'legacy', threadId: 'task', text: 'legacy', draft: 'legacy', selections: [], mode: 'queue', order: 0, createdAt: 1, ownerProjectRoot: 'file:///workspace', trustedAtSubmit: true, generation: 0, phase: 'claiming', claimId: 'old' };
		const raw = JSON.stringify({ version: 1, records: [legacyRecord] }); const storage = new MemoryStorage(); const core = new PendingChatInputBrokerCore(storage); const first = await initialize(core, 'window:1', namespace, raw); assert.ok(first.ok); assert.strictEqual(first.value.removeLegacy, true); assert.strictEqual(first.snapshot.records[0].phase, 'dormant');
		const otherProfile = Object.freeze({ ...namespace, profileId: 'profile-b' }); const second = await initialize(core, 'window:2', otherProfile, raw); assert.ok(second.ok); assert.strictEqual(second.value.removeLegacy, true); assert.strictEqual(second.snapshot.records.length, 0);
	});

	test('isolates profile and workspace namespaces', async () => {
		const storage = new MemoryStorage(); const core = new PendingChatInputBrokerCore(storage); const one = await initialize(core, 'window:1'); const other = await initialize(core, 'window:2', { profileId: 'profile-b', workspaceIdentity: namespace.workspaceIdentity }); assert.ok(one.ok && other.ok); await submit(core, 'window:1', one.value.sessionId, 'only a'); assert.strictEqual((await core.heartbeat('window:2', other.value.sessionId)).snapshot!.records.length, 0);
	});

	test('admits exactly one simultaneous submit into the final global capacity slot', async () => {
		let id = 0; const storage = new MemoryStorage(); const core = new PendingChatInputBrokerCore(storage, () => 100 + id, () => `id-${++id}`);
		const one = await initialize(core, 'window:1'); const two = await initialize(core, 'window:2'); assert.ok(one.ok && two.ok);
		for (let index = 0; index < 31; index++) assert.ok((await submit(core, 'window:1', one.value.sessionId, `row ${index}`)).ok);
		const [a, b] = await Promise.all([submit(core, 'window:1', one.value.sessionId, 'last-a'), submit(core, 'window:2', two.value.sessionId, 'last-b')]);
		assert.strictEqual(Number(a.ok) + Number(b.ok), 1); const rejected = a.ok ? b : a; assert.ok(!rejected.ok); assert.strictEqual(rejected.reason, 'full');
		const snapshot = (await core.heartbeat('window:1', one.value.sessionId)).snapshot!; assert.strictEqual(snapshot.records.length, 32);
	});

	test('rejects reorder that would rebase another live owner or a claiming row', async () => {
		let id = 0; const storage = new MemoryStorage(); const core = new PendingChatInputBrokerCore(storage, () => 100, () => `id-${++id}`);
		const one = await initialize(core, 'window:1'); const two = await initialize(core, 'window:2'); assert.ok(one.ok && two.ok);
		const a = await submit(core, 'window:1', one.value.sessionId, 'a'); const b = await submit(core, 'window:2', two.value.sessionId, 'b'); assert.ok(a.ok && b.ok);
		const foreign = await core.reorder('window:1', one.value.sessionId, 'task', a.value.id, pendingChatInputFingerprint(a.value), pendingChatInputThreadFingerprint([a.value, b.value])); assert.ok(!foreign.ok && foreign.reason === 'conflict');
		await core.releaseConnection('window:2');
		const claimed = await core.claimNextQueued('window:1', one.value.sessionId, 'task', authority, []); assert.ok(claimed.ok && claimed.value);
		const latest = (await core.heartbeat('window:1', one.value.sessionId)).snapshot!.records; const claimingRecord = latest.find(record => record.id === b.value.id)!; const claiming = await core.reorder('window:1', one.value.sessionId, 'task', b.value.id, pendingChatInputFingerprint(claimingRecord), pendingChatInputThreadFingerprint(latest)); assert.ok(!claiming.ok && claiming.reason === 'conflict');
	});

	test('rejects submit order overflow rebase while another session owns the thread row', async () => {
		const legacy = JSON.stringify({ version: 1, records: [{ id: 'max', threadId: 'task', text: 'max', draft: 'max', selections: [], mode: 'queue', order: Number.MAX_SAFE_INTEGER, createdAt: 1, ownerProjectRoot: 'file:///workspace', trustedAtSubmit: true, generation: 0, phase: 'queued' }] });
		let id = 0; const storage = new MemoryStorage(); const core = new PendingChatInputBrokerCore(storage, () => 100, () => `id-${++id}`);
		const one = await initialize(core, 'window:1', namespace, legacy); const two = await initialize(core, 'window:2'); assert.ok(one.ok && two.ok);
		const dormant = one.snapshot.records[0]; assert.ok((await core.resume('window:1', one.value.sessionId, 'task', dormant.id, pendingChatInputFingerprint(dormant), authority)).ok);
		const blocked = await submit(core, 'window:2', two.value.sessionId, 'must not rebase'); assert.ok(!blocked.ok && blocked.reason === 'conflict'); assert.strictEqual(blocked.snapshot!.records[0].order, Number.MAX_SAFE_INTEGER);
	});

	test('keeps an append-leased delivered row and requires the exact live lease to remove it', async () => {
		let now = 100; let id = 0; const storage = new MemoryStorage(); const core = new PendingChatInputBrokerCore(storage, () => now, () => `id-${++id}`); const init = await initialize(core, 'window:1'); assert.ok(init.ok);
		await submit(core, 'window:1', init.value.sessionId, 'leased'); const claim = await core.claimNextQueued('window:1', init.value.sessionId, 'task', authority, []); assert.ok(claim.ok && claim.value);
		const preLeaseRemove = await core.verifyHistoryAndSettle('window:1', init.value.sessionId, 'task', claim.value.record.id, claim.value.record.claimId!, 'missing'); assert.ok(!preLeaseRemove.ok && preLeaseRemove.reason === 'conflict');
		const lease = await core.authorizeAppend('window:1', init.value.sessionId, 'task', claim.value.record.id, claim.value.record.claimId!, claim.value.fingerprint, authority, 'run', 0); assert.ok(lease.ok);
		const reconcile = await core.reconcileDeliveredPendingInputIds('window:1', init.value.sessionId, { task: [claim.value.record.id] }); assert.ok(reconcile.ok); assert.strictEqual(reconcile.snapshot.records.length, 1);
		const claimScan = await core.claimNextQueued('window:1', init.value.sessionId, 'task', authority, [claim.value.record.id]); assert.ok(claimScan.ok); assert.strictEqual(claimScan.snapshot.records.length, 1);
		now += PENDING_CHAT_INPUT_APPEND_LEASE_TIMEOUT_MS + 1;
		const expired = await core.verifyHistoryAndSettle('window:1', init.value.sessionId, 'task', claim.value.record.id, claim.value.record.claimId!, lease.value.leaseId); assert.ok(!expired.ok && expired.reason === 'conflict'); assert.strictEqual(expired.snapshot!.records[0].phase, 'dormant'); assert.strictEqual(expired.snapshot!.records[0].runId, undefined);
	});

	test('abandons an exact live append lease to dormant after local history append failure', async () => {
		let id = 0; const storage = new MemoryStorage(); const core = new PendingChatInputBrokerCore(storage, () => 100, () => `id-${++id}`); const init = await initialize(core, 'window:1'); assert.ok(init.ok);
		await submit(core, 'window:1', init.value.sessionId, 'append fails'); const claim = await core.claimNextQueued('window:1', init.value.sessionId, 'task', authority, []); assert.ok(claim.ok && claim.value);
		const lease = await core.authorizeAppend('window:1', init.value.sessionId, 'task', claim.value.record.id, claim.value.record.claimId!, claim.value.fingerprint, authority, 'run', 0); assert.ok(lease.ok);
		const wrong = await core.settleClaim('window:1', init.value.sessionId, 'task', claim.value.record.id, claim.value.record.claimId!, 'wrong-lease', 'dormant'); assert.ok(!wrong.ok && wrong.reason === 'conflict');
		const abandoned = await core.settleClaim('window:1', init.value.sessionId, 'task', claim.value.record.id, claim.value.record.claimId!, lease.value.leaseId, 'dormant'); assert.ok(abandoned.ok); assert.strictEqual(abandoned.snapshot.records[0].phase, 'dormant'); assert.strictEqual(abandoned.snapshot.records[0].claimId, undefined);
	});

	test('suspends only the resuming session active row when generation changes during its acknowledgement', async () => {
		const storage = new MemoryStorage(); let id = 0; const core = new PendingChatInputBrokerCore(storage, () => 100, () => `id-${++id}`); const init = await initialize(core, 'window:1'); assert.ok(init.ok);
		const added = await submit(core, 'window:1', init.value.sessionId, 'resume race'); assert.ok(added.ok); await core.releaseConnection('window:1');
		const reopened = await initialize(core, 'window:2'); assert.ok(reopened.ok); const dormant = reopened.snapshot.records[0];
		const resumed = await core.resume('window:2', reopened.value.sessionId, 'task', dormant.id, pendingChatInputFingerprint(dormant), authority); assert.ok(resumed.ok);
		const active = resumed.snapshot.records[0]; const suspended = await core.suspend('window:2', reopened.value.sessionId, 'task', active.id, pendingChatInputFingerprint(active));
		assert.ok(suspended.ok); assert.strictEqual(suspended.snapshot.records[0].phase, 'dormant'); assert.strictEqual(suspended.snapshot.records[0].runId, undefined);
	});

	test('fails closed on generation drift and incoherent phase-mode-run tuples', async () => {
		let id = 0; const storage = new MemoryStorage(); const core = new PendingChatInputBrokerCore(storage, () => 100, () => `id-${++id}`); const init = await initialize(core, 'window:1'); assert.ok(init.ok);
		const invalid = await core.submit('window:1', { sessionId: init.value.sessionId, threadId: 'task', text: 'bad', selections: [], mode: 'queue', phase: 'steering', ownerProjectRoot: 'file:///workspace', trustedAtSubmit: true, generation: 0, runId: 'run' }); assert.ok(!invalid.ok && invalid.reason === 'invalid_request');
		await submit(core, 'window:1', init.value.sessionId, 'generation'); const drifted = await core.claimNextQueued('window:1', init.value.sessionId, 'task', { ...authority, generation: 1 }, []); assert.ok(drifted.ok && !drifted.value); assert.strictEqual(drifted.snapshot.records[0].phase, 'dormant');
	});

	test('closes a run before acknowledgement and converts a stale steer submit to FIFO queue', async () => {
		let id = 0; const storage = new MemoryStorage(); const core = new PendingChatInputBrokerCore(storage, () => 100, () => `id-${++id}`); const init = await initialize(core, 'window:1'); assert.ok(init.ok);
		const first = await submit(core, 'window:1', init.value.sessionId, 'before close', 'steer', 'steering'); assert.ok(first.ok);
		const closed = await core.closeRunAndReleaseSteers('window:1', init.value.sessionId, 'task', 'run', 0, authority); assert.ok(closed.ok); assert.strictEqual(closed.snapshot.records[0].phase, 'queued');
		const stale = await submit(core, 'window:1', init.value.sessionId, 'after close', 'steer', 'steering'); assert.ok(stale.ok); assert.strictEqual(stale.value.mode, 'queue'); assert.strictEqual(stale.value.phase, 'queued'); assert.strictEqual(stale.value.runId, undefined);
	});

	test('keeps an exact active same-generation steer while rejecting closed run identities', async () => {
		let id = 0; const storage = new MemoryStorage(); const core = new PendingChatInputBrokerCore(storage, () => 100, () => `id-${++id}`); const init = await initialize(core, 'window:1'); assert.ok(init.ok);
		const steering = (text: string, runId: string) => core.submit('window:1', { sessionId: init.value.sessionId, threadId: 'task', text, selections: [], mode: 'steer', phase: 'steering', ownerProjectRoot: 'file:///workspace', trustedAtSubmit: true, generation: 0, runId });
		assert.ok((await core.closeRunAndReleaseSteers('window:1', init.value.sessionId, 'task', 'run-a', 0, authority)).ok);
		const active = await core.authorizeDirectHistoryAppend('window:1', init.value.sessionId, 'task', 'active B', [], 'run-b', 0); assert.ok(active.ok);
		const current = await steering('current B', 'run-b'); assert.ok(current.ok); assert.strictEqual(current.value.mode, 'steer'); assert.strictEqual(current.value.phase, 'steering');
		const lateA = await steering('late A while B active', 'run-a'); assert.ok(lateA.ok); assert.strictEqual(lateA.value.mode, 'queue'); assert.strictEqual(lateA.value.phase, 'queued');
		storage.storeUser(pendingChatInputThreadStorageKey('task'), historyEnvelope('task', active.value.pendingInputId, 'active B'));
		assert.ok((await core.verifyDirectHistoryAndRelease('window:1', init.value.sessionId, 'task', active.value.leaseId)).ok);
		assert.ok((await core.closeRunAndReleaseSteers('window:1', init.value.sessionId, 'task', 'run-b', 0, authority)).ok);
		const lateAfterClose = await steering('late A after B close', 'run-a'); assert.ok(lateAfterClose.ok); assert.strictEqual(lateAfterClose.value.mode, 'queue'); assert.strictEqual(lateAfterClose.value.phase, 'queued');
	});

	test('rolls migration storage back on flush failure and imports once on retry', async () => {
		const legacy = JSON.stringify({ version: 1, records: [{ id: 'legacy', threadId: 'task', text: 'legacy', draft: 'legacy', selections: [], mode: 'queue', order: 0, createdAt: 1, ownerProjectRoot: 'file:///workspace', trustedAtSubmit: true, generation: 0, phase: 'queued' }] });
		const storage = new MemoryStorage(); storage.failFlushes = 1; const core = new PendingChatInputBrokerCore(storage);
		const failed = await initialize(core, 'window:1', namespace, legacy); assert.ok(!failed.ok && failed.reason === 'backend_unavailable'); assert.deepStrictEqual([...storage.values.keys()], [pendingChatInputThreadStorageKey('task')]);
		const retried = await initialize(core, 'window:1', namespace, legacy); assert.ok(retried.ok); assert.strictEqual(retried.snapshot.records.length, 1); assert.strictEqual(retried.snapshot.records[0].phase, 'dormant');
	});

	test('keeps live ownership coherent when a demotion flush fails and retries safely', async () => {
		let id = 0; const storage = new MemoryStorage(); const core = new PendingChatInputBrokerCore(storage, () => 100, () => `id-${++id}`); const one = await initialize(core, 'window:1'); const two = await initialize(core, 'window:2'); assert.ok(one.ok && two.ok);
		assert.ok((await submit(core, 'window:2', two.value.sessionId, 'owned')).ok); storage.failFlushes = 1;
		await assert.rejects(() => core.releaseConnection('window:2'));
		const foreign = await core.claimNextQueued('window:1', one.value.sessionId, 'task', authority, []); assert.ok(foreign.ok && !foreign.value); assert.strictEqual(foreign.snapshot.records[0].phase, 'queued');
		await core.releaseConnection('window:2'); const after = await core.heartbeat('window:1', one.value.sessionId); assert.ok(after.ok); assert.strictEqual(after.snapshot.records[0].phase, 'dormant');
	});

	test('rechecks heartbeat inside the namespace queue before expiring a candidate session', async () => {
		let now = 0; let id = 0; const storage = new ControlledFlushStorage(); const core = new PendingChatInputBrokerCore(storage, () => now, () => `id-${++id}`); const init = await initialize(core, 'window:1'); assert.ok(init.ok);
		const gate = storage.blockNextFlush(); const submission = submit(core, 'window:1', init.value.sessionId, 'queued'); await gate.reached;
		now = 90_001; const expiry = core.expireSessions(now); const heartbeat = core.heartbeat('window:1', init.value.sessionId); gate.release();
		assert.ok((await submission).ok); assert.ok((await heartbeat).ok); await expiry;
		const alive = await core.heartbeat('window:1', init.value.sessionId); assert.ok(alive.ok); assert.strictEqual(alive.snapshot.records[0].phase, 'queued');
	});

	test('does not publish duplicate record identity when UUID generation collides', async () => {
		const storage = new MemoryStorage(); const core = new PendingChatInputBrokerCore(storage, () => 100, () => 'same-id'); const init = await initialize(core, 'window:1'); assert.ok(init.ok);
		const first = await submit(core, 'window:1', init.value.sessionId, 'one'); assert.ok(first.ok);
		const second = await submit(core, 'window:1', init.value.sessionId, 'two'); assert.ok(!second.ok && second.reason === 'backend_unavailable'); assert.strictEqual(second.snapshot!.records.length, 1);
	});

	test('rejects colliding session identity without transferring the first window authority', async () => {
		const storage = new MemoryStorage(); const core = new PendingChatInputBrokerCore(storage, () => 100, () => 'same-session');
		const first = await initialize(core, 'window:1'); assert.ok(first.ok); const second = await initialize(core, 'window:2'); assert.ok(!second.ok && second.reason === 'backend_unavailable');
		assert.ok((await core.heartbeat('window:1', first.value.sessionId)).ok);
	});

	test('rejects a generated claim id that breaks the exact reserved envelope bound', async () => {
		const ids = ['session', 'record', 'x'.repeat(70_000)]; const storage = new MemoryStorage(); const core = new PendingChatInputBrokerCore(storage, () => 100, () => ids.shift()!);
		const init = await initialize(core, 'window:1'); assert.ok(init.ok); assert.ok((await submit(core, 'window:1', init.value.sessionId, 'row')).ok);
		const claim = await core.claimNextQueued('window:1', init.value.sessionId, 'task', authority, []); assert.ok(!claim.ok && claim.reason === 'backend_unavailable'); assert.strictEqual(claim.snapshot!.records[0].phase, 'queued');
	});

	test('commits one exact thread-record CAS and returns authoritative bytes to a stale writer', async () => {
		let id = 0; const storage = new MemoryStorage(); const core = new PendingChatInputBrokerCore(storage, () => 100, () => `id-${++id}`);
		const one = await initialize(core, 'window:1'); const two = await initialize(core, 'window:2'); assert.ok(one.ok && two.ok);
		const key = pendingChatInputThreadStorageKey('task'); const baseline = storage.get(key)!;
		const winnerRaw = JSON.stringify({ version: 1, revision: 2, thread: { id: 'task', messages: [{ role: 'assistant', displayContent: 'winner' }] } });
		const winner = await core.commitThreadRecord('window:1', one.value.sessionId, 'task', baseline, winnerRaw); assert.ok(winner.ok); assert.strictEqual(storage.get(key), winnerRaw);
		const staleRaw = JSON.stringify({ version: 1, revision: 2, thread: { id: 'task', messages: [{ role: 'assistant', displayContent: 'stale' }] } });
		const stale = await core.commitThreadRecord('window:2', two.value.sessionId, 'task', baseline, staleRaw); assert.ok(!stale.ok && stale.reason === 'conflict'); assert.strictEqual(stale.authoritativeRaw, winnerRaw); assert.strictEqual(storage.get(key), winnerRaw);
		const skippedRevision = await core.commitThreadRecord('window:1', one.value.sessionId, 'task', winnerRaw, JSON.stringify({ version: 1, revision: 4, thread: { id: 'task', messages: [] } })); assert.ok(!skippedRevision.ok && skippedRevision.reason === 'conflict');
	});

	test('serializes application-global CAS across workspace namespaces', async () => {
		let id = 0; const storage = new ControlledFlushStorage(); const core = new PendingChatInputBrokerCore(storage, () => 100, () => `id-${++id}`);
		const one = await initialize(core, 'window:1');
		const otherNamespace = Object.freeze({ profileId: namespace.profileId, workspaceIdentity: '{"kind":"folder","id":"other","uri":"file:///other"}' });
		const two = await initialize(core, 'window:2', otherNamespace); assert.ok(one.ok && two.ok);
		const key = pendingChatInputThreadStorageKey('task'); const baseline = storage.get(key)!;
		const firstRaw = JSON.stringify({ version: 1, revision: 2, thread: { id: 'task', messages: [{ role: 'assistant', displayContent: 'first' }] } });
		const secondRaw = JSON.stringify({ version: 1, revision: 2, thread: { id: 'task', messages: [{ role: 'assistant', displayContent: 'second' }] } });
		const gate = storage.blockNextFlush(); const first = core.commitThreadRecord('window:1', one.value.sessionId, 'task', baseline, firstRaw); await gate.reached;
		let secondSettled = false; const second = core.commitThreadRecord('window:2', two.value.sessionId, 'task', baseline, secondRaw).then(result => { secondSettled = true; return result; });
		await Promise.resolve(); assert.strictEqual(secondSettled, false); gate.release();
		const [winner, loser] = await Promise.all([first, second]); assert.ok(winner.ok); assert.ok(!loser.ok && loser.reason === 'conflict'); assert.strictEqual(loser.authoritativeRaw, firstRaw); assert.strictEqual(storage.get(key), firstRaw);
	});

	test('serializes destructive prepare across workspace namespaces', async () => {
		let id = 0; const storage = new ControlledFlushStorage(); const core = new PendingChatInputBrokerCore(storage, () => 100, () => `id-${++id}`);
		const one = await initialize(core, 'window:1');
		const otherNamespace = Object.freeze({ profileId: namespace.profileId, workspaceIdentity: '{"kind":"folder","id":"other","uri":"file:///other"}' });
		const two = await initialize(core, 'window:2', otherNamespace); assert.ok(one.ok && two.ok);
		const plan = threadDeletionPlan(storage); const gate = storage.blockNextFlush(); const first = core.deleteThreadRecords('window:1', one.value.sessionId, 'task', plan.evidence); await gate.reached;
		let secondSettled = false; const second = core.deleteThreadRecords('window:2', two.value.sessionId, 'task', plan.evidence).then(result => { secondSettled = true; return result; });
		await Promise.resolve(); assert.strictEqual(secondSettled, false); gate.release();
		const [winner, loser] = await Promise.all([first, second]); assert.ok(winner.ok); assert.ok(!loser.ok && loser.reason === 'conflict');
		assert.ok((await core.abortThreadDeletion('window:1', one.value.sessionId, 'task', winner.value.leaseId)).ok);
	});

	test('blocks every foreign-namespace history and inbox mutation behind one persisted global replacement', async () => {
		let id = 0; const storage = new MemoryStorage(); const core = new PendingChatInputBrokerCore(storage, () => 100, () => `id-${++id}`);
		const one = await initialize(core, 'window:1');
		const otherNamespace = Object.freeze({ profileId: namespace.profileId, workspaceIdentity: '{"kind":"folder","id":"other","uri":"file:///other"}' });
		const two = await initialize(core, 'window:2', otherNamespace); assert.ok(one.ok && two.ok);
		const prepared = await core.clearNamespace('window:1', one.value.sessionId, namespaceNoopEvidence(storage)); assert.ok(prepared.ok);
		const key = pendingChatInputThreadStorageKey('task'); const baseline = storage.get(key)!;
		const nextRaw = JSON.stringify({ version: 1, revision: 2, thread: { id: 'task', messages: [{ role: 'assistant', displayContent: 'must not cross replacement' }] } });
		const cas = await core.commitThreadRecord('window:2', two.value.sessionId, 'task', baseline, nextRaw);
		const direct = await core.authorizeDirectHistoryAppend('window:2', two.value.sessionId, 'task', 'must remain a draft', [], 'foreign-run', 0);
		const queued = await submit(core, 'window:2', two.value.sessionId, 'must not enter broker');
		const competingDelete = await core.deleteThreadRecords('window:2', two.value.sessionId, 'task', threadDeletionPlan(storage).evidence);
		for (const result of [cas, direct, queued, competingDelete]) assert.ok(!result.ok && result.reason === 'conflict');
		assert.strictEqual(storage.get(key), baseline);
		assert.ok((await core.abortNamespaceClear('window:1', one.value.sessionId, prepared.value.leaseId)).ok);
	});

	test('serializes claim and direct history writers for one thread across windows and ordinals', async () => {
		let id = 0; const storage = new MemoryStorage(); const core = new PendingChatInputBrokerCore(storage, () => 100, () => `id-${++id}`);
		const one = await initialize(core, 'window:1'); const two = await initialize(core, 'window:2'); assert.ok(one.ok && two.ok);
		assert.ok((await submit(core, 'window:1', one.value.sessionId, 'first')).ok); assert.ok((await submit(core, 'window:1', one.value.sessionId, 'second')).ok);
		const first = await core.claimNextQueued('window:1', one.value.sessionId, 'task', authority, []); assert.ok(first.ok && first.value);
		const firstLease = await core.authorizeAppend('window:1', one.value.sessionId, 'task', first.value.record.id, first.value.record.claimId!, first.value.fingerprint, authority, 'run', 0); assert.ok(firstLease.ok);
		const held = await core.claimNextQueued('window:1', one.value.sessionId, 'task', authority, []); assert.ok(held.ok); assert.strictEqual(held.value, undefined); assert.strictEqual(held.snapshot.records.find(record => record.text === 'second')?.phase, 'queued');
		const foreignDirect = await core.authorizeDirectHistoryAppend('window:2', two.value.sessionId, 'task', 'foreign', [], 'other-run', 0); assert.ok(!foreignDirect.ok && foreignDirect.reason === 'append_in_progress');
		storage.storeUser(pendingChatInputThreadStorageKey('task'), historyEnvelope('task', first.value.record.id, first.value.record.text));
		assert.ok((await core.verifyHistoryAndSettle('window:1', one.value.sessionId, 'task', first.value.record.id, first.value.record.claimId!, firstLease.value.leaseId)).ok);
		assert.ok((await core.closeRunAndReleaseSteers('window:1', one.value.sessionId, 'task', 'run', 0, authority)).ok);
		const second = await core.claimNextQueued('window:1', one.value.sessionId, 'task', authority, []); assert.ok(second.ok && second.value);
		const secondLease = await core.authorizeAppend('window:1', one.value.sessionId, 'task', second.value.record.id, second.value.record.claimId!, second.value.fingerprint, authority, 'run', 0); assert.ok(secondLease.ok);
	});

	test('binds Stop-and-Send to the admitted run and blocks a replacement direct writer from overtaking it', async () => {
		let id = 0; const storage = new MemoryStorage(); const core = new PendingChatInputBrokerCore(storage, () => 100, () => `id-${++id}`);
		const one = await initialize(core, 'window:1'); const two = await initialize(core, 'window:2'); assert.ok(one.ok && two.ok);
		const active = await core.authorizeDirectHistoryAppend('window:1', one.value.sessionId, 'task', 'active', [], 'old-run', 0); assert.ok(active.ok);
		const stop = await core.submit('window:2', { sessionId: two.value.sessionId, threadId: 'task', text: 'after old', selections: [], mode: 'stop_and_send', phase: 'queued', ownerProjectRoot: 'file:///workspace', trustedAtSubmit: true, generation: 0 });
		assert.ok(stop.ok); assert.strictEqual(stop.value.targetRunId, 'old-run'); assert.strictEqual(stop.value.targetGeneration, 0); assert.strictEqual(stop.value.generation, 1);
		storage.storeUser(pendingChatInputThreadStorageKey('task'), historyEnvelope('task', active.value.pendingInputId, 'active'));
		assert.ok((await core.verifyDirectHistoryAndRelease('window:1', one.value.sessionId, 'task', active.value.leaseId)).ok);
		assert.ok((await core.closeRunAndReleaseSteers('window:1', one.value.sessionId, 'task', 'old-run', 0, authority)).ok);
		const replacement = await core.authorizeDirectHistoryAppend('window:1', one.value.sessionId, 'task', 'replacement', [], 'replacement-run', 1); assert.ok(!replacement.ok && replacement.reason === 'append_in_progress');
		const claimed = await core.claimNextQueued('window:2', two.value.sessionId, 'task', { ...authority, generation: 1 }, []); assert.ok(claimed.ok && claimed.value); assert.strictEqual(claimed.value.record.id, stop.value.id);
		assert.strictEqual(claimed.value.record.targetRunId, 'old-run');
	});

	test('holds an authoritative approval across windows and releases FIFO exactly once after terminal history', async () => {
		let id = 0; const storage = new MemoryStorage(); const core = new PendingChatInputBrokerCore(storage, () => 100, () => `id-${++id}`);
		const one = await initialize(core, 'window:1'); const two = await initialize(core, 'window:2'); assert.ok(one.ok && two.ok);
		const direct = await core.authorizeDirectHistoryAppend('window:1', one.value.sessionId, 'task', 'seed', [], 'run', 0); assert.ok(direct.ok);
		const user = { role: 'user', pendingInputId: direct.value.pendingInputId, displayContent: 'seed', pendingInputSelectionsFingerprint: direct.value.selectionsFingerprint };
		const approval = { role: 'tool', type: 'tool_request', id: 'tool-1', name: 'read_file', params: {}, rawParams: {}, result: null, batchId: 'batch', batchOrdinal: 0 };
		const key = pendingChatInputThreadStorageKey('task'); storage.storeUser(key, JSON.stringify({ version: 1, revision: 2, thread: { id: 'task', messages: [user] } }));
		assert.ok((await core.verifyDirectHistoryAndRelease('window:1', one.value.sessionId, 'task', direct.value.leaseId)).ok);
		storage.storeUser(key, JSON.stringify({ version: 1, revision: 3, thread: { id: 'task', messages: [user, approval] } }));
		assert.ok((await core.holdApproval('window:1', one.value.sessionId, 'task', 'run', 0, { toolId: 'tool-1', name: 'read_file', batchId: 'batch', batchOrdinal: 0 })).ok);
		assert.ok((await core.closeRunAndReleaseSteers('window:1', one.value.sessionId, 'task', 'run', 0, authority, true)).ok);
		const queued = await submit(core, 'window:2', two.value.sessionId, 'after approval'); assert.ok(queued.ok);
		const held = await core.claimNextQueued('window:2', two.value.sessionId, 'task', authority, []); assert.ok(held.ok); assert.strictEqual(held.value, undefined); assert.strictEqual(held.snapshot.records[0].phase, 'queued');
		assert.ok(!(await core.authorizeDirectHistoryAppend('window:2', two.value.sessionId, 'task', 'overtake', [], 'other', 0)).ok);
		const premature = await core.closeRunAndReleaseSteers('window:1', one.value.sessionId, 'task', 'run', 0, authority); assert.ok(!premature.ok && premature.reason === 'conflict');
		storage.storeUser(key, JSON.stringify({ version: 1, revision: 4, thread: { id: 'task', messages: [user, { ...approval, type: 'rejected' }] } }));
		assert.ok((await core.closeRunAndReleaseSteers('window:1', one.value.sessionId, 'task', 'run', 0, authority)).ok);
		const claimed = await core.claimNextQueued('window:2', two.value.sessionId, 'task', authority, []); assert.ok(claimed.ok && claimed.value); assert.strictEqual(claimed.value.record.id, queued.value.id);
	});

	test('reattaches a restored approval only from authoritative tool-request history', async () => {
		let id = 0; const storage = new MemoryStorage(); const first = new PendingChatInputBrokerCore(storage, () => 100, () => `id-${++id}`); const opened = await initialize(first, 'window:1'); assert.ok(opened.ok);
		const key = pendingChatInputThreadStorageKey('task'); storage.storeUser(key, JSON.stringify({ version: 1, revision: 2, thread: { id: 'task', messages: [{ role: 'tool', type: 'tool_request', id: 'tool-1', name: 'read_file', params: {}, rawParams: {}, result: null }] } })); first.dispose();
		const restarted = new PendingChatInputBrokerCore(storage, () => 200, () => `restart-${++id}`); const w3 = await initialize(restarted, 'window:3'); const w4 = await initialize(restarted, 'window:4'); assert.ok(w3.ok && w4.ok);
		const held = await restarted.holdApproval('window:3', w3.value.sessionId, 'task', 'restored-run', 0, { toolId: 'tool-1', name: 'read_file' }); assert.ok(held.ok);
		const foreign = await restarted.authorizeDirectHistoryAppend('window:4', w4.value.sessionId, 'task', 'blocked', [], 'foreign', 0); assert.ok(!foreign.ok && foreign.reason === 'append_in_progress');
		const tampered = await restarted.holdApproval('window:4', w4.value.sessionId, 'task', 'other', 0, { toolId: 'tool-2', name: 'read_file' }); assert.ok(!tampered.ok);
	});

	test('treats renderer delivered ids as hints and removes only an authoritative exact payload', async () => {
		let id = 0; const storage = new MemoryStorage(); const core = new PendingChatInputBrokerCore(storage, () => 100, () => `id-${++id}`); const init = await initialize(core, 'window:1'); assert.ok(init.ok);
		const added = await submit(core, 'window:1', init.value.sessionId, 'exact text'); assert.ok(added.ok); const key = pendingChatInputThreadStorageKey('task');
		let result = await core.reconcileDeliveredPendingInputIds('window:1', init.value.sessionId, { task: [added.value.id] }); assert.ok(result.ok); assert.strictEqual(result.snapshot.records.length, 1);
		storage.storeUser(key, JSON.stringify({ version: 1, revision: 2, thread: { id: 'task', messages: [{ role: 'user', pendingInputId: added.value.id, displayContent: 'exact text' }] } }));
		result = await core.reconcileDeliveredPendingInputIds('window:1', init.value.sessionId, { task: [added.value.id] }); assert.ok(result.ok); assert.strictEqual(result.snapshot.records.length, 1);
		storage.storeUser(key, JSON.stringify({ version: 1, revision: 3, thread: { id: 'task', messages: [{ role: 'user', pendingInputId: added.value.id, displayContent: 'exact text', pendingInputSelectionsFingerprint: 'tampered' }] } }));
		result = await core.reconcileDeliveredPendingInputIds('window:1', init.value.sessionId, { task: [added.value.id] }); assert.ok(result.ok); assert.strictEqual(result.snapshot.records.length, 1);
		storage.storeUser(key, historyEnvelope('task', added.value.id, added.value.text));
		result = await core.reconcileDeliveredPendingInputIds('window:1', init.value.sessionId, { task: [added.value.id] }); assert.ok(result.ok); assert.strictEqual(result.snapshot.records.length, 0);
	});

	test('binds original selection provenance while allowing visible Skill enrichment', async () => {
		let id = 0; const storage = new MemoryStorage(); const core = new PendingChatInputBrokerCore(storage, () => 100, () => `id-${++id}`); const init = await initialize(core, 'window:1'); assert.ok(init.ok);
		const added = await submit(core, 'window:1', init.value.sessionId, 'skill input'); assert.ok(added.ok); const claim = await core.claimNextQueued('window:1', init.value.sessionId, 'task', authority, []); assert.ok(claim.ok && claim.value);
		const lease = await core.authorizeAppend('window:1', init.value.sessionId, 'task', claim.value.record.id, claim.value.record.claimId!, claim.value.fingerprint, authority, 'run', 0); assert.ok(lease.ok);
		const enrichedSelection = { type: 'Skill', identity: 'reader', catalogRevision: 'catalog', bodyRevision: 'body', skillRoot: 'file:///skill', description: 'read only' };
		storage.storeUser(pendingChatInputThreadStorageKey('task'), JSON.stringify({ version: 1, revision: 2, thread: { id: 'task', messages: [{ role: 'user', pendingInputId: added.value.id, displayContent: added.value.text, selections: [enrichedSelection], pendingInputSelectionsFingerprint: pendingChatInputSelectionsFingerprint([]) }] } }));
		const settled = await core.verifyHistoryAndSettle('window:1', init.value.sessionId, 'task', claim.value.record.id, claim.value.record.claimId!, lease.value.leaseId); assert.ok(settled.ok); assert.strictEqual(settled.value.kind, 'exact');
	});

	test('keeps malformed shared mutation evidence fail-closed without compacting broker rows', async () => {
		const storage = new MemoryStorage(); storage.store(PENDING_CHAT_INPUT_GLOBAL_MUTATION_KEY, '{broken'); let id = 0; const core = new PendingChatInputBrokerCore(storage, () => 100, () => `id-${++id}`);
		const initialized = await initialize(core, 'window:1'); assert.ok(initialized.ok); assert.match(initialized.value.warning ?? '', /blocked/); assert.strictEqual(storage.get(PENDING_CHAT_INPUT_GLOBAL_MUTATION_KEY), '{broken');
		const blocked = await submit(core, 'window:1', initialized.value.sessionId, 'must remain blocked'); assert.ok(!blocked.ok && blocked.reason === 'conflict'); assert.strictEqual(storage.get(PENDING_CHAT_INPUT_GLOBAL_MUTATION_KEY), '{broken');
	});

	test('clears closed-run generations when application chat history is replaced', async () => {
		let id = 0; const storage = new MemoryStorage(); const core = new PendingChatInputBrokerCore(storage, () => 100, () => `id-${++id}`); const init = await initialize(core, 'window:1'); assert.ok(init.ok);
		assert.ok((await core.closeRunAndReleaseSteers('window:1', init.value.sessionId, 'task', 'old-run', 0, authority)).ok);
		const prepared = await core.clearNamespace('window:1', init.value.sessionId, namespaceNoopEvidence(storage)); assert.ok(prepared.ok);
		await commitPlan(storage, prepared.value.leaseId, []); assert.ok((await core.finalizeNamespaceClear('window:1', init.value.sessionId, prepared.value.leaseId)).ok);
		const fresh = await core.submit('window:1', { sessionId: init.value.sessionId, threadId: 'task', text: 'fresh steer', selections: [], mode: 'steer', phase: 'steering', ownerProjectRoot: 'file:///workspace', trustedAtSubmit: true, generation: 0, runId: 'fresh-run' });
		assert.ok(fresh.ok); assert.strictEqual(fresh.value.mode, 'steer'); assert.strictEqual(fresh.value.phase, 'steering'); assert.strictEqual(fresh.value.runId, 'fresh-run');
	});

	test('holds later claims and direct history behind the first live same-thread broker row', async () => {
		let id = 0; const storage = new MemoryStorage(); const core = new PendingChatInputBrokerCore(storage, () => 100, () => `id-${++id}`);
		const first = await initialize(core, 'window:1'); const second = await initialize(core, 'window:2'); assert.ok(first.ok && second.ok);
		const a = await submit(core, 'window:1', first.value.sessionId, 'first'); assert.ok(a.ok);
		const claimedA = await core.claimNextQueued('window:1', first.value.sessionId, 'task', authority, []); assert.ok(claimedA.ok && claimedA.value);
		const sameSessionLater = await submit(core, 'window:1', first.value.sessionId, 'same-session later');
		const otherSessionLater = await submit(core, 'window:2', second.value.sessionId, 'other-session later'); assert.ok(sameSessionLater.ok && otherSessionLater.ok);
		const sameHeld = await core.claimNextQueued('window:1', first.value.sessionId, 'task', authority, []); const otherHeld = await core.claimNextQueued('window:2', second.value.sessionId, 'task', authority, []);
		assert.ok(sameHeld.ok && otherHeld.ok); assert.strictEqual(sameHeld.value, undefined); assert.strictEqual(otherHeld.value, undefined);
		const directWhileClaimed = await core.authorizeDirectHistoryAppend('window:2', second.value.sessionId, 'task', 'direct overtake', [], 'direct-run', 0); assert.ok(!directWhileClaimed.ok && directWhileClaimed.reason === 'append_in_progress');
		assert.ok((await core.settleClaim('window:1', first.value.sessionId, 'task', claimedA.value.record.id, claimedA.value.record.claimId!, undefined, 'dormant')).ok);
		const directWhileQueued = await core.authorizeDirectHistoryAppend('window:2', second.value.sessionId, 'task', 'queued overtake', [], 'direct-run', 0); assert.ok(!directWhileQueued.ok && directWhileQueued.reason === 'append_in_progress');
		assert.ok((await core.delete('window:1', first.value.sessionId, 'task', a.value.id, pendingChatInputFingerprint((await core.heartbeat('window:1', first.value.sessionId)).snapshot!.records.find(record => record.id === a.value.id)!))).ok);
		const claimedSame = await core.claimNextQueued('window:1', first.value.sessionId, 'task', authority, []); assert.ok(claimedSame.ok && claimedSame.value?.record.id === sameSessionLater.value.id);
		assert.ok((await core.settleClaim('window:1', first.value.sessionId, 'task', claimedSame.value.record.id, claimedSame.value.record.claimId!, undefined, 'dormant')).ok);
		const dormantSame = (await core.heartbeat('window:1', first.value.sessionId)).snapshot!.records.find(record => record.id === sameSessionLater.value.id)!;
		assert.ok((await core.delete('window:1', first.value.sessionId, 'task', dormantSame.id, pendingChatInputFingerprint(dormantSame))).ok);
		const claimedOther = await core.claimNextQueued('window:2', second.value.sessionId, 'task', authority, []); assert.ok(claimedOther.ok && claimedOther.value?.record.id === otherSessionLater.value.id);
		assert.ok((await core.settleClaim('window:2', second.value.sessionId, 'task', claimedOther.value.record.id, claimedOther.value.record.claimId!, undefined, 'dormant')).ok);
		const dormantOther = (await core.heartbeat('window:2', second.value.sessionId)).snapshot!.records.find(record => record.id === otherSessionLater.value.id)!;
		assert.ok((await core.delete('window:2', second.value.sessionId, 'task', dormantOther.id, pendingChatInputFingerprint(dormantOther))).ok);
		const direct = await core.authorizeDirectHistoryAppend('window:2', second.value.sessionId, 'task', 'after FIFO', [], 'direct-run', 0); assert.ok(direct.ok);
		assert.ok((await core.abandonDirectHistoryAppend('window:2', second.value.sessionId, 'task', direct.value.leaseId)).ok);
	});

	test('keeps a blank-thread anchor and accepted row visible as dormant across window and main restart', async () => {
		let id = 0; const storage = new MemoryStorage(); const core = new PendingChatInputBrokerCore(storage, () => 100, () => `id-${++id}`); const opened = await initialize(core, 'window:2'); assert.ok(opened.ok);
		const anchor = await core.authorizeThreadAnchor('window:2', opened.value.sessionId, 'blank'); assert.ok(anchor.ok); const leaseId = anchor.value.leaseId; assert.ok(leaseId); const key = pendingChatInputThreadStorageKey('blank');
		storage.storeUser(key, JSON.stringify({ version: 1, revision: 1, thread: { id: 'blank', messages: [] }, pendingInputAnchorLeaseId: leaseId })); await storage.flush();
		assert.ok((await core.verifyThreadAnchorAndRelease('window:2', opened.value.sessionId, 'blank', leaseId)).ok);
		const existing = await core.authorizeThreadAnchor('window:2', opened.value.sessionId, 'blank'); assert.ok(existing.ok); assert.strictEqual(existing.value.existing, true); assert.strictEqual(existing.value.leaseId, undefined);
		const accepted = await core.submit('window:2', { sessionId: opened.value.sessionId, threadId: 'blank', text: 'survive close', selections: [], mode: 'queue', phase: 'queued', ownerProjectRoot: 'file:///workspace', trustedAtSubmit: true, generation: 0 }); assert.ok(accepted.ok);
		await core.releaseConnection('window:2'); const third = await core.initializeNamespace('window:3', { namespace, knownThreadIds: ['task', 'blank'], deliveredPendingInputIds: { task: [], blank: [] } }); assert.ok(third.ok); assert.deepStrictEqual(third.snapshot.records.map(record => [record.threadId, record.phase]), [['blank', 'dormant']]); assert.ok(storage.get(key));
		core.dispose(); const restarted = new PendingChatInputBrokerCore(storage, () => 200, () => `restart-${++id}`); const cold = await restarted.initializeNamespace('window:4', { namespace, knownThreadIds: ['task', 'blank'], deliveredPendingInputIds: { task: [], blank: [] } }); assert.ok(cold.ok); assert.deepStrictEqual(cold.snapshot.records.map(record => [record.threadId, record.phase]), [['blank', 'dormant']]);
	});

	test('removes only the final unreferenced temporary blank anchor when its last row is deleted', async () => {
		let id = 0; const storage = new MemoryStorage(); const core = new PendingChatInputBrokerCore(storage, () => 100, () => `id-${++id}`);
		const namespaceB: PendingChatInputNamespace = Object.freeze({ profileId: namespace.profileId, workspaceIdentity: '{"kind":"folder","id":"workspace-b","uri":"file:///workspace-b"}' });
		const first = await initialize(core, 'window:1');
		const second = await core.initializeNamespace('window:2', { namespace: namespaceB, knownThreadIds: ['task', 'blank'], deliveredPendingInputIds: { task: [], blank: [] } });
		assert.ok(first.ok && second.ok);
		const installTemporaryAnchor = async (threadId: string) => {
			const authorized = await core.authorizeThreadAnchor('window:1', first.value.sessionId, threadId); assert.ok(authorized.ok && authorized.value.leaseId);
			const key = pendingChatInputThreadStorageKey(threadId); storage.storeUser(key, JSON.stringify({ version: 1, revision: 1, thread: { id: threadId, messages: [] }, pendingInputAnchorLeaseId: authorized.value.leaseId })); await storage.flush();
			assert.ok((await core.verifyThreadAnchorAndRelease('window:1', first.value.sessionId, threadId, authorized.value.leaseId)).ok);
			return key;
		};
		const key = await installTemporaryAnchor('blank');
		const a = await core.submit('window:1', { sessionId: first.value.sessionId, threadId: 'blank', text: 'workspace a', selections: [], mode: 'queue', phase: 'queued', ownerProjectRoot: 'file:///workspace', trustedAtSubmit: true, generation: 0 });
		const b = await core.submit('window:2', { sessionId: second.value.sessionId, threadId: 'blank', text: 'workspace b', selections: [], mode: 'queue', phase: 'queued', ownerProjectRoot: 'file:///workspace-b', trustedAtSubmit: true, generation: 0 });
		assert.ok(a.ok && b.ok);
		assert.ok((await core.delete('window:1', first.value.sessionId, 'blank', a.value.id, pendingChatInputFingerprint(a.value))).ok); assert.ok(storage.get(key), 'another namespace row must retain the shared anchor');
		assert.ok((await core.delete('window:2', second.value.sessionId, 'blank', b.value.id, pendingChatInputFingerprint(b.value))).ok); assert.strictEqual(storage.get(key), undefined, 'the final row delete must remove its exact temporary empty anchor');
		for (const suffix of ['one', 'two']) {
			const threadId = `blank-${suffix}`; const repeatedKey = await installTemporaryAnchor(threadId);
			const row = await core.submit('window:1', { sessionId: first.value.sessionId, threadId, text: suffix, selections: [], mode: 'queue', phase: 'queued', ownerProjectRoot: 'file:///workspace', trustedAtSubmit: true, generation: 0 }); assert.ok(row.ok);
			assert.ok((await core.delete('window:1', first.value.sessionId, threadId, row.value.id, pendingChatInputFingerprint(row.value))).ok); assert.strictEqual(storage.get(repeatedKey), undefined);
		}
		assert.strictEqual(storage.keys('user').some(candidate => candidate.includes('blank-one') || candidate.includes('blank-two')), false);
	});

	test('atomically transfers an exact parent owner to its physical child group and freezes cross-window Stop targets', async () => {
		let id = 0; const storage = new MemoryStorage(); const core = new PendingChatInputBrokerCore(storage, () => 100, () => `id-${++id}`);
		const first = await initialize(core, 'window:1'); const second = await initialize(core, 'window:2');
		const foreignNamespace: PendingChatInputNamespace = Object.freeze({ profileId: namespace.profileId, workspaceIdentity: '{"kind":"folder","id":"foreign","uri":"file:///foreign"}' });
		const foreign = await initialize(core, 'window:3', foreignNamespace); assert.ok(first.ok && second.ok && foreign.ok);
		const direct = await core.authorizeDirectHistoryAppend('window:1', first.value.sessionId, 'task', 'parent', [], 'parent-run', 0); assert.ok(direct.ok);
		storage.storeUser(pendingChatInputThreadStorageKey('task'), historyEnvelope('task', direct.value.pendingInputId, 'parent'));
		assert.ok((await core.verifyDirectHistoryAndRelease('window:1', first.value.sessionId, 'task', direct.value.leaseId)).ok);
		assert.ok((await core.syncActiveChildGroup('window:1', first.value.sessionId, 'task', 'parent-run', 0, 1, 0, ['child-a', 'child-b'])).ok);
		const identity = Object.freeze({ sourceRevision: 1, generation: 0, childIds: Object.freeze(['child-a', 'child-b']) });
		assert.ok((await core.closeRunAndReleaseSteers('window:1', first.value.sessionId, 'task', 'parent-run', 0, authority, false, identity)).ok);

		const stop = await core.submit('window:2', { sessionId: second.value.sessionId, threadId: 'task', text: 'stop children', selections: [], mode: 'stop_and_send', phase: 'queued', ownerProjectRoot: 'file:///workspace', trustedAtSubmit: true, generation: 0 });
		assert.ok(stop.ok); assert.strictEqual(stop.value.targetChildGeneration, 0); assert.deepStrictEqual(stop.value.targetChildIds, ['child-a', 'child-b']); assert.strictEqual(stop.value.generation, 1);
		const stopFingerprint = pendingChatInputFingerprint(stop.value);
		// Lost close ACK is retried against the already-transferred exact child owner.
		// It must not normalize or erase the Stop tuple admitted after the first close.
		assert.ok((await core.closeRunAndReleaseSteers('window:1', first.value.sessionId, 'task', 'parent-run', 0, authority, false, identity)).ok);
		const afterRetry = (await core.heartbeat('window:2', second.value.sessionId)).snapshot!.records.find(record => record.id === stop.value.id)!;
		assert.strictEqual(pendingChatInputFingerprint(afterRetry), stopFingerprint);

		const foreignStop = await core.submit('window:3', { sessionId: foreign.value.sessionId, threadId: 'task', text: 'cannot stop foreign children', selections: [], mode: 'stop_and_send', phase: 'queued', ownerProjectRoot: 'file:///foreign', trustedAtSubmit: true, generation: 0 });
		assert.ok(!foreignStop.ok && foreignStop.reason === 'append_in_progress');
		const held = await core.claimNextQueued('window:2', second.value.sessionId, 'task', { ...authority, generation: 1 }, []); assert.ok(held.ok); assert.strictEqual(held.value, undefined);
		assert.ok(!(await core.authorizeDirectHistoryAppend('window:2', second.value.sessionId, 'task', 'overtake', [], 'other-run', 1)).ok);
		const deletion = await core.deleteThreadRecords('window:2', second.value.sessionId, 'task', threadDeletionPlan(storage).evidence); assert.ok(!deletion.ok && deletion.reason === 'append_in_progress');
		const clearing = await core.clearNamespace('window:2', second.value.sessionId, namespaceNoopEvidence(storage)); assert.ok(!clearing.ok && clearing.reason === 'append_in_progress');

		const stale = await core.syncActiveChildGroup('window:1', first.value.sessionId, 'task', 'parent-run', 0, 1, undefined, []); assert.ok(!stale.ok && stale.reason === 'conflict');
		const foreignClear = await core.syncActiveChildGroup('window:2', second.value.sessionId, 'task', 'parent-run', 0, 2, undefined, []); assert.ok(!foreignClear.ok && foreignClear.reason === 'conflict');
		assert.ok((await core.syncActiveChildGroup('window:1', first.value.sessionId, 'task', 'parent-run', 0, 2, undefined, [])).ok);
		const claimed = await core.claimNextQueued('window:2', second.value.sessionId, 'task', { ...authority, generation: 1 }, []); assert.ok(claimed.ok && claimed.value); assert.strictEqual(claimed.value.record.id, stop.value.id);
	});

	test('renews a child owner with its live session and publishes a revisioned wake on bounded expiry', async () => {
		let now = 0; let id = 0; const storage = new MemoryStorage(); const core = new PendingChatInputBrokerCore(storage, () => now, () => `id-${++id}`);
		const first = await initialize(core, 'window:1'); const second = await initialize(core, 'window:2'); assert.ok(first.ok && second.ok);
		const direct = await core.authorizeDirectHistoryAppend('window:1', first.value.sessionId, 'task', 'parent', [], 'parent-run', 0); assert.ok(direct.ok);
		storage.storeUser(pendingChatInputThreadStorageKey('task'), historyEnvelope('task', direct.value.pendingInputId, 'parent'));
		assert.ok((await core.verifyDirectHistoryAndRelease('window:1', first.value.sessionId, 'task', direct.value.leaseId)).ok);
		assert.ok((await core.syncActiveChildGroup('window:1', first.value.sessionId, 'task', 'parent-run', 0, 1, 0, ['child'])).ok);
		assert.ok((await core.closeRunAndReleaseSteers('window:1', first.value.sessionId, 'task', 'parent-run', 0, authority, false, { sourceRevision: 1, generation: 0, childIds: ['child'] })).ok);
		const queued = await submit(core, 'window:2', second.value.sessionId, 'held while child drains'); assert.ok(queued.ok);
		const childEvents: string[] = []; const revisions: number[] = []; core.onDidChangeChildGroup(event => childEvents.push(event.threadId)); core.onDidChange(snapshot => revisions.push(snapshot.revision));
		now = 40_000; assert.ok((await core.heartbeat('window:1', first.value.sessionId)).ok); assert.ok((await core.heartbeat('window:2', second.value.sessionId)).ok);
		now = PENDING_CHAT_INPUT_SESSION_TIMEOUT_MS + 1; await core.expireSessions(now);
		const held = await core.claimNextQueued('window:2', second.value.sessionId, 'task', authority, []); assert.ok(held.ok); assert.strictEqual(held.value, undefined);
		now = 40_000 + PENDING_CHAT_INPUT_SESSION_TIMEOUT_MS + 1; await core.expireSessions(now);
		assert.ok(childEvents.includes('task')); assert.ok(revisions.length > 0, 'child expiry must publish a broker revision even when no row changes');
		const reopened = await initialize(core, 'window:3'); assert.ok(reopened.ok); const dormant = reopened.snapshot.records.find(record => record.id === queued.value.id)!; assert.strictEqual(dormant.phase, 'dormant');
		assert.ok((await core.resume('window:3', reopened.value.sessionId, 'task', dormant.id, pendingChatInputFingerprint(dormant), authority)).ok);
		const claimed = await core.claimNextQueued('window:3', reopened.value.sessionId, 'task', authority, []); assert.ok(claimed.ok && claimed.value?.record.id === queued.value.id);
	});

	test('reattaches a live physical child group after main restart and accepts an idempotent empty replay', async () => {
		let id = 0; const storage = new MemoryStorage(); const firstCore = new PendingChatInputBrokerCore(storage, () => 100, () => `id-${++id}`); const first = await initialize(firstCore, 'window:1'); assert.ok(first.ok); firstCore.dispose();
		const restarted = new PendingChatInputBrokerCore(storage, () => 200, () => `restart-${++id}`); const owner = await initialize(restarted, 'window:1'); const foreign = await initialize(restarted, 'window:2'); assert.ok(owner.ok && foreign.ok);
		assert.ok((await restarted.syncActiveChildGroup('window:1', owner.value.sessionId, 'task', 'old-parent', 3, 7, 3, ['still-running'])).ok);
		assert.ok(!(await restarted.authorizeDirectHistoryAppend('window:2', foreign.value.sessionId, 'task', 'blocked', [], 'foreign-run', 3)).ok);
		assert.ok((await restarted.syncActiveChildGroup('window:1', owner.value.sessionId, 'task', 'old-parent', 3, 8, undefined, [])).ok);
		assert.ok((await restarted.syncActiveChildGroup('window:1', owner.value.sessionId, 'task', 'old-parent', 3, 8, undefined, [])).ok);
		const direct = await restarted.authorizeDirectHistoryAppend('window:2', foreign.value.sessionId, 'task', 'after release', [], 'foreign-run', 3); assert.ok(direct.ok);
	});
});
