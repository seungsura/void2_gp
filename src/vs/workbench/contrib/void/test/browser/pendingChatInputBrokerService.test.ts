/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { IDisposable } from '../../../../../base/common/lifecycle.js';
import { PendingChatInputBrokerService } from '../../browser/pendingChatInputBrokerService.js';
import { PendingChatInputInitializeResult, PendingChatInputSnapshot } from '../../common/pendingChatInputBroker.js';

class TestPendingChatInputBrokerService extends PendingChatInputBrokerService {
	heartbeatCallback: (() => void) | undefined;
	protected override scheduleHeartbeat(callback: () => void): IDisposable { this.heartbeatCallback = callback; return { dispose: () => { this.heartbeatCallback = undefined; } }; }
}

const createHarness = (call: (command: string, request: unknown) => Promise<unknown>) => {
	let legacy = '{"version":1,"records":[]}'; let removals = 0;
	const childChanges = new Emitter<unknown>();
	const channel = { listen: (event: string) => event === 'onDidChangeChildGroup' ? childChanges.event : Event.None, call };
	const service = new TestPendingChatInputBrokerService(
		{ getChannel: () => channel } as never,
		{ get: () => legacy, remove: () => { removals++; legacy = undefined as unknown as string; } } as never,
		{ getWorkspace: () => ({ id: 'workspace', folders: [], transient: false }) } as never,
		{ currentProfile: { id: 'profile' } } as never,
	);
	const snapshot = (revision = 1): PendingChatInputSnapshot => Object.freeze({ namespace: service.namespace, revision, records: Object.freeze([]) });
	return { service, snapshot, fireChild: (event: unknown) => childChanges.fire(event), disposeChildEmitter: () => childChanges.dispose(), get removals() { return removals; } };
};

const request = Object.freeze({ knownThreadIds: Object.freeze(['task']), deliveredPendingInputIds: Object.freeze({ task: Object.freeze([] as string[]) }) });

suite('Void pending chat input renderer broker proxy', () => {
	test('preserves legacy on malformed initialize response, releases the issued session, and retries', async () => {
		let initializeCalls = 0; let releases = 0; let valid = false; let harness: ReturnType<typeof createHarness>;
		harness = createHarness(async command => {
			if (command === 'releaseSession') { releases++; return undefined; }
			assert.strictEqual(command, 'initializeNamespace'); initializeCalls++;
			return valid
				? { ok: true, snapshot: harness.snapshot(initializeCalls), value: { sessionId: `session-${initializeCalls}`, removeLegacy: true } }
				: { ok: true, snapshot: { ...harness.snapshot(), records: [{ malformed: true }] }, value: { sessionId: 'issued-malformed', removeLegacy: true } };
		});
		const malformed = await harness.service.initializeNamespace(request); assert.ok(!malformed.ok && malformed.reason === 'backend_unavailable'); assert.strictEqual(harness.removals, 0); assert.strictEqual(releases, 1);
		valid = true; const retried = await harness.service.initializeNamespace(request); assert.ok(retried.ok); assert.strictEqual(initializeCalls, 2); assert.strictEqual(harness.removals, 1); harness.service.dispose();
	});

	test('invalidates a malformed heartbeat response and reopens only on a later explicit operation', async () => {
		let initializeCalls = 0; let harness: ReturnType<typeof createHarness>;
		harness = createHarness(async command => {
			if (command === 'initializeNamespace') { initializeCalls++; return { ok: true, snapshot: harness.snapshot(initializeCalls), value: { sessionId: `session-${initializeCalls}`, removeLegacy: false } }; }
			if (command === 'heartbeat') return { ok: true, snapshot: { ...harness.snapshot(initializeCalls + 1), records: [null] } };
			if (command === 'reconcileDeliveredPendingInputIds') return { ok: true, snapshot: harness.snapshot(initializeCalls + 1), value: undefined };
			if (command === 'releaseSession') return undefined;
			throw new Error(`unexpected ${command}`);
		});
		assert.ok((await harness.service.initializeNamespace(request)).ok); harness.service.heartbeatCallback?.(); await Promise.resolve(); await Promise.resolve();
		const reopened = await harness.service.reconcileDeliveredPendingInputIds({ task: [] }); assert.ok(reopened.ok); assert.strictEqual(initializeCalls, 2); harness.service.dispose();
	});

	test('releases a late initialize session after dispose and never removes legacy', async () => {
		let resolveInitialize!: (result: PendingChatInputInitializeResult) => void; let releases = 0; let harness: ReturnType<typeof createHarness>;
		harness = createHarness(command => {
			if (command === 'releaseSession') { releases++; return Promise.resolve(undefined); }
			return new Promise(resolve => resolveInitialize = resolve as (result: PendingChatInputInitializeResult) => void);
		});
		const initializing = harness.service.initializeNamespace(request); harness.service.dispose();
		resolveInitialize(Object.freeze({ ok: true, snapshot: harness.snapshot(), value: Object.freeze({ sessionId: 'late-session', removeLegacy: true }) }));
		const result = await initializing; assert.ok(!result.ok && result.reason === 'backend_unavailable'); assert.strictEqual(releases, 1); assert.strictEqual(harness.removals, 0);
	});

	test('forwards exact child-group sync and rejects malformed child events at the renderer boundary', async () => {
		const calls: Array<{ command: string; request: any }> = []; let harness: ReturnType<typeof createHarness>;
		harness = createHarness(async (command, raw) => {
			const request = raw as any; calls.push({ command, request });
			if (command === 'initializeNamespace') return { ok: true, snapshot: harness.snapshot(), value: { sessionId: 'session', removeLegacy: false } };
			if (command === 'syncActiveChildGroup') return { ok: true, snapshot: harness.snapshot(2), value: undefined };
			if (command === 'releaseSession') return undefined;
			throw new Error(`unexpected ${command}`);
		});
		const events: string[] = []; const listener = harness.service.onDidChangeChildGroup(event => events.push(event.threadId));
		assert.ok((await harness.service.initializeNamespace(request)).ok);
		harness.fireChild(null); harness.fireChild({ threadId: '' }); harness.fireChild({ threadId: 'x'.repeat(513) }); harness.fireChild({ threadId: 'task' }); assert.deepStrictEqual(events, ['task']);
		assert.ok((await harness.service.syncActiveChildGroup('task', 'parent-run', 4, 9, 4, ['a', 'b'])).ok);
		const sync = calls.find(call => call.command === 'syncActiveChildGroup')!; assert.deepStrictEqual(sync.request, { sessionId: 'session', threadId: 'task', sourceRunId: 'parent-run', sourceGeneration: 4, sourceRevision: 9, generation: 4, childIds: ['a', 'b'] });
		listener.dispose(); harness.service.dispose(); harness.disposeChildEmitter();
	});
});
