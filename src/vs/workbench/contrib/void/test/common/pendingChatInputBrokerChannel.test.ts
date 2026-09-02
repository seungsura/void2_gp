/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { PendingChatInputBrokerChannel, registerPendingChatInputBrokerChannel } from '../../electron-main/pendingChatInputBrokerChannel.js';
import { PendingChatInputInitializeResult, PendingChatInputMutationResult, PendingChatInputNamespace, PendingChatInputSnapshot, PENDING_CHAT_INPUT_BROKER_CHANNEL_NAME, pendingChatInputThreadStorageKey } from '../../common/pendingChatInputBroker.js';

suite('Void pending chat input broker main channel', () => {
	test('uses application-machine storage, filters namespace events, and releases the exact connection', async () => {
		const values = new Map<string, string>(); const writes: Array<{ scope: StorageScope; target: StorageTarget }> = [];
		values.set(pendingChatInputThreadStorageKey('task'), JSON.stringify({ version: 1, revision: 1, thread: { id: 'task', messages: [] } }));
		const storage: any = {
			whenReady: Promise.resolve(),
			get(key: string, scope: StorageScope) { assert.strictEqual(scope, StorageScope.APPLICATION); return values.get(key); },
			store(key: string, value: string, scope: StorageScope, target: StorageTarget) { writes.push({ scope, target }); values.set(key, value); },
			storeAll(entries: Array<{ key: string; value: string; scope: StorageScope; target: StorageTarget }>) { for (const entry of entries) { writes.push({ scope: entry.scope, target: entry.target }); values.set(entry.key, entry.value); } },
			remove(key: string, scope: StorageScope) { assert.strictEqual(scope, StorageScope.APPLICATION); values.delete(key); },
			keys(scope: StorageScope) { assert.strictEqual(scope, StorageScope.APPLICATION); return [...values.keys()]; },
			async flush() { },
		};
		const channel = new PendingChatInputBrokerChannel(storage);
		try {
			const a: PendingChatInputNamespace = { profileId: 'profile-a', workspaceIdentity: 'workspace-a' };
			const b: PendingChatInputNamespace = { profileId: 'profile-b', workspaceIdentity: 'workspace-a' };
			const c: PendingChatInputNamespace = { profileId: 'profile-a', workspaceIdentity: 'workspace-b' };
			const init = await channel.call<PendingChatInputInitializeResult>('window:1', 'initializeNamespace', { namespace: a, knownThreadIds: ['task'], deliveredPendingInputIds: {} }); assert.ok(init.ok);
			const live = await channel.call<PendingChatInputInitializeResult>('window:2', 'initializeNamespace', { namespace: a, knownThreadIds: ['task'], deliveredPendingInputIds: {} }); assert.ok(live.ok);
			let aEvents = 0; let bEvents = 0; let cEvents = 0; const childEvents: string[] = [];
			const aListener = channel.listen<PendingChatInputSnapshot>('listener:a', 'onDidChange', a)(() => aEvents++);
			const bListener = channel.listen<PendingChatInputSnapshot>('listener:b', 'onDidChange', b)(() => bEvents++);
			const cListener = channel.listen<PendingChatInputSnapshot>('listener:c', 'onDidChange', c)(() => cEvents++);
			const childListener = channel.listen<{ threadId: string }>('listener:child', 'onDidChangeChildGroup', a)(event => childEvents.push(event.threadId));
			try {
				const submitted = await channel.call<PendingChatInputMutationResult>('window:1', 'submit', { sessionId: init.value.sessionId, threadId: 'task', text: 'queued', selections: [], mode: 'queue', phase: 'queued', ownerProjectRoot: undefined, trustedAtSubmit: true, generation: 0 }); assert.ok(submitted.ok);
				assert.strictEqual(aEvents, 1); assert.strictEqual(bEvents, 0); assert.strictEqual(cEvents, 0);
				const synced = await channel.call<PendingChatInputMutationResult>('window:1', 'syncActiveChildGroup', { sessionId: init.value.sessionId, threadId: 'task', sourceRunId: 'run', sourceGeneration: 0, sourceRevision: 1, generation: 0, childIds: ['child'] }); assert.ok(synced.ok); assert.deepStrictEqual(childEvents, ['task']);
				assert.ok(writes.length > 0); assert.ok(writes.every(write => write.scope === StorageScope.APPLICATION && write.target === StorageTarget.MACHINE));
				const key = pendingChatInputThreadStorageKey('task'); const expectedRaw = values.get(key)!; const nextRaw = JSON.stringify({ version: 1, revision: 2, thread: { id: 'task', messages: [{ role: 'assistant', displayContent: 'persisted' }] } });
				const committed = await channel.call<PendingChatInputMutationResult<string>>('window:1', 'commitThreadRecord', { sessionId: init.value.sessionId, threadId: 'task', expectedRaw, nextRaw }); assert.ok(committed.ok); assert.strictEqual(values.get(key), nextRaw); assert.deepStrictEqual(writes.at(-1), { scope: StorageScope.APPLICATION, target: StorageTarget.USER });
				await channel.releaseConnection('window:1'); assert.strictEqual(aEvents, 2); assert.strictEqual(bEvents, 0); assert.strictEqual(cEvents, 0); assert.deepStrictEqual(childEvents, ['task', 'task']);
				const stale = await channel.call<PendingChatInputMutationResult>('window:1', 'heartbeat', { sessionId: init.value.sessionId }); assert.ok(!stale.ok && stale.reason === 'not_initialized');
				const survivor = await channel.call<PendingChatInputMutationResult>('window:2', 'heartbeat', { sessionId: live.value.sessionId }); assert.ok(survivor.ok); assert.strictEqual(survivor.snapshot.records[0].phase, 'dormant');
			} finally { aListener.dispose(); bListener.dispose(); cListener.dispose(); childListener.dispose(); }
		} finally { channel.dispose(); }
	});

	test('registration forwards removed connection context, reports rejection, and stops after disposal', async () => {
		const storage: any = { whenReady: Promise.resolve(), get() { return undefined; }, store() { }, storeAll() { }, remove() { }, keys() { return []; }, async flush() { } };
		const channel = new PendingChatInputBrokerChannel(storage); const removed = new Emitter<any>(); const registered: Array<{ name: string; value: unknown }> = []; const contexts: string[] = []; const errors: unknown[] = [];
		(channel as any).releaseConnection = async (ctx: string) => { contexts.push(ctx); if (ctx === 'bad') throw new Error('release failed'); };
		const registration = registerPendingChatInputBrokerChannel({ registerChannel(name: string, value: unknown) { registered.push({ name, value }); }, onDidRemoveConnection: removed.event } as any, channel, error => errors.push(error));
		try {
			assert.deepStrictEqual(registered, [{ name: PENDING_CHAT_INPUT_BROKER_CHANNEL_NAME, value: channel }]);
			removed.fire({ ctx: 'window:1' }); removed.fire({ ctx: 'bad' }); await Promise.resolve(); await Promise.resolve();
			assert.deepStrictEqual(contexts, ['window:1', 'bad']); assert.strictEqual(errors.length, 1);
			registration.dispose(); removed.fire({ ctx: 'after-dispose' }); await Promise.resolve(); assert.deepStrictEqual(contexts, ['window:1', 'bad']);
		} finally { registration.dispose(); removed.dispose(); channel.dispose(); }
	});
});
