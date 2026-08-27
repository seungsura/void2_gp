/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { getAgentSubagentPresentation, selectThreadScopedValue } from '../../common/agentSubagentPresentation.js';

const budget = (overrides: Record<string, unknown> = {}) => ({ accepted: 0, running: 0, queued: 0, maxAccepted: 4, maxConcurrent: 2, providerSends: 0, activeProviderSends: 0, maxProviderSends: 64, resultChars: 0, retainedResultChars: 0, maxResultChars: 32_000, truncatedResultCount: 0, maxChildSummaryChars: 8_000, usage: null, ...overrides }) as any;
const run = (status: string, id = 'child-abcdefgh') => ({ id, status, queuedMs: 1, runningMs: 2, totalMs: 3, authority: { runtimeRevision: 'runtime', instructionsRevision: 'instructions', catalogRevision: 'catalog', selectedSkills: [] }, usage: null }) as any;
const diagnostics = (events: any[] = []) => ({ parentId: 'parent', generation: 1, elapsedMs: 4, events, droppedEvents: 0, completed: 0, failed: 0, cancelled: 0, usage: null }) as any;
const event = (kind: string) => ({ sequence: 1, parentId: 'parent', generation: 1, kind, timestamp: 1, elapsedMs: 0, budget: { accepted: 0, running: 0, queued: 0, providerSends: 0, resultChars: 0 } });

suite('Void AgentSubagentPresentation', () => {
	test('returns the current task value for arrays, undefined, and objects without invoking stale callbacks', () => {
		const stale = () => { throw new Error('stale callback must not run'); };
		assert.deepStrictEqual(selectThreadScopedValue({ threadId: 'old', value: ['old'] }, 'new', () => ['new']), ['new']);
		assert.strictEqual(selectThreadScopedValue({ threadId: 'old', value: undefined }, 'new', () => undefined), undefined);
		assert.deepStrictEqual(selectThreadScopedValue<Record<string, boolean>>({ threadId: 'old', value: { old: true } }, 'new', () => ({ current: true })), { current: true });
		assert.deepStrictEqual(selectThreadScopedValue({ threadId: 'current', value: ['current'] }, 'current', stale), ['current']);
	});
	test('is absent only when no group data exists', () => {
		assert.strictEqual(getAgentSubagentPresentation(undefined, [], undefined), undefined);
		assert.ok(getAgentSubagentPresentation(budget(), [], undefined));
	});
	test('reports pending admission from trace counts', () => {
		const value = getAgentSubagentPresentation(budget(), [], diagnostics([event('admission_started')]))!;
		assert.strictEqual(value.admissionPending, 1); assert.ok(value.summary.includes('1 preparing'));
		const dropped = diagnostics([event('admission_started')]); dropped.droppedEvents = 1;
		assert.strictEqual(getAgentSubagentPresentation(budget(), [], dropped)!.admissionPending, 0);
	});
	test('keeps active counts and capacity compact without usage in the header', () => {
		const value = getAgentSubagentPresentation(budget({ accepted: 2 }), [run('running'), run('queued', 'child-b')], diagnostics())!;
		assert.strictEqual(value.summary, 'Child runs · 1 running · 1 queued · 2/4 open capacity'); assert.strictEqual(value.summary.includes('usage'), false);
	});
	test('counts scheduler-active leases and labels waiting and ready child rows truthfully', () => {
		const value = getAgentSubagentPresentation(budget({ accepted: 2, running: 1 }), [{ ...run('running', 'parent'), schedulerActivity: 'waiting_children' }, { ...run('running', 'nested'), schedulerActivity: 'active' }], diagnostics())!;
		assert.strictEqual(value.running, 1); assert.ok(value.summary.includes('1 running')); assert.strictEqual(value.runs[0].statusLabel, 'Waiting for child runs'); assert.strictEqual(value.runs[1].statusLabel, 'Running');
		const ready = getAgentSubagentPresentation(budget({ accepted: 1, running: 0 }), [{ ...run('running'), schedulerActivity: 'ready_to_resume' }], diagnostics())!;
		assert.strictEqual(ready.running, 0); assert.strictEqual(ready.runs[0].statusLabel, 'Ready to resume');
	});
	test('uses scheduler activity labels only for running service views', () => {
		const value = getAgentSubagentPresentation(budget({ accepted: 4 }), [
			{ ...run('queued', 'queued-child'), schedulerActivity: 'ready_to_resume' },
			{ ...run('completed', 'completed-child'), schedulerActivity: 'quiescing' },
			{ ...run('failed', 'failed-child'), schedulerActivity: 'quiescing' },
			{ ...run('cancelled', 'cancelled-child'), schedulerActivity: 'quiescing' },
			{ ...run('running', 'waiting-child'), schedulerActivity: 'waiting_children' },
			{ ...run('running', 'ready-child'), schedulerActivity: 'ready_to_resume' },
			{ ...run('running', 'finishing-child'), schedulerActivity: 'quiescing' },
		], diagnostics())!;
		assert.deepStrictEqual(value.runs.map(child => child.statusLabel), [
			'Queued', 'Completed', 'Failed', 'Cancelled', 'Waiting for child runs', 'Ready to resume', 'Finishing',
		]);
	});
	test('reports completed runs without action required', () => {
		const value = getAgentSubagentPresentation(budget({ accepted: 1 }), [run('completed')], diagnostics())!;
		assert.strictEqual(value.completed, 1); assert.strictEqual(value.actionRequired, false);
	});
	test('keeps aggregate result compaction visible on the matching terminal row', () => {
		const value = getAgentSubagentPresentation(budget({ retainedResultChars: 32_000, maxResultChars: 32_000, truncatedResultCount: 1 }), [{ ...run('completed'), resultTruncated: true }], diagnostics())!;
		assert.strictEqual(value.budget?.truncatedResultCount, 1);
		assert.strictEqual(value.runs[0].resultTruncated, true);
	});
	test('makes failed runs and failed admission action required', () => {
		const failed = getAgentSubagentPresentation(budget({ accepted: 1 }), [{ ...run('failed'), summary: 'Provider request failed.' }], diagnostics())!;
		const admission = getAgentSubagentPresentation(budget(), [], diagnostics([event('admission_started'), event('admission_failed')]))!;
		assert.strictEqual(failed.actionRequired, true); assert.strictEqual(failed.actionRequiredLabel, 'Action required · 1 child failure'); assert.ok(failed.summary.includes('1 failed')); assert.strictEqual(failed.runs[0].summary, 'Provider request failed.'); assert.strictEqual(admission.actionRequiredLabel, 'Action required · 1 setup failure'); assert.ok(admission.summary.includes('1 setup failed'));
	});
	test('does not make cancellation action required', () => {
		const value = getAgentSubagentPresentation(budget({ accepted: 1 }), [run('cancelled')], diagnostics())!;
		assert.strictEqual(value.cancelled, 1); assert.strictEqual(value.actionRequired, false);
	});
	test('defaults child and technical disclosures closed', () => {
		const value = getAgentSubagentPresentation(budget(), [run('running')], diagnostics())!;
		assert.strictEqual(value.diagnosticsOpen, false); assert.strictEqual(value.runs[0].detailsOpen, false); assert.strictEqual(value.runs[0].technicalDetailsOpen, false);
	});
	test('truthfully retains unavailable usage and freezes the output', () => {
		const value = getAgentSubagentPresentation(budget(), [run('completed')], diagnostics([event('child_completed')]))!;
		assert.strictEqual(value.usageLabel, 'Usage unavailable'); assert.strictEqual(value.runs[0].usageLabel, 'Usage unavailable');
		assert.strictEqual(Object.isFrozen(value), true); assert.strictEqual(Object.isFrozen(value.runs), true); assert.strictEqual(Object.isFrozen(value.runs[0]), true); assert.strictEqual(Object.isFrozen(value.budget), true); assert.strictEqual(Object.isFrozen(value.diagnostics), true); assert.strictEqual(Object.isFrozen(value.diagnostics!.events), true); assert.strictEqual(Object.isFrozen(value.diagnostics!.events[0] ?? {}), true); assert.strictEqual(Object.isFrozen(value.runs[0].authority), true);
	});
	test('shows generic child IDs once and named roles with their IDs', () => {
		const generic = getAgentSubagentPresentation(budget({ accepted: 1 }), [run('completed')], diagnostics())!.runs[0];
		const named = getAgentSubagentPresentation(budget({ accepted: 1 }), [{ ...run('completed', 'child-12345678'), roleName: 'reviewer' }], diagnostics())!.runs[0];
		assert.strictEqual(generic.roleName, undefined); assert.strictEqual(generic.shortId, 'child-ab'); assert.strictEqual(named.roleName, 'reviewer'); assert.strictEqual(named.shortId, 'child-12');
	});
	test('projects immutable inherited tools, approvals, Undo, and the no-OS-sandbox boundary', () => {
		const value = getAgentSubagentPresentation(budget({ accepted: 1 }), [{ ...run('completed'), capabilityProfile: 'inherit_parent_write', toolPresentation: { toolNames: ['read_file', 'write_file', 'captured_mcp'], approvals: ['edits', 'MCP tools'], undoAvailable: true, applicationBoundary: 'no_os_sandbox' } }], diagnostics())!.runs[0];
		assert.deepStrictEqual(value.toolPresentation?.toolNames, ['read_file', 'write_file', 'captured_mcp']); assert.deepStrictEqual(value.toolPresentation?.approvals, ['edits', 'MCP tools']); assert.strictEqual(value.toolPresentation?.undoAvailable, true); assert.strictEqual(value.toolPresentation?.applicationBoundary, 'no_os_sandbox');
	});
	test('keeps the read-only presentation distinct from inherited tool details', () => {
		const value = getAgentSubagentPresentation(budget({ accepted: 1 }), [{ ...run('completed'), capabilityProfile: 'read_only' }], diagnostics())!.runs[0];
		assert.strictEqual(value.capabilityProfile, 'read_only'); assert.strictEqual(value.toolPresentation, undefined);
	});
	test('preserves spawn order', () => {
		const value = getAgentSubagentPresentation(budget({ accepted: 2 }), [run('queued', 'child-second'), run('running', 'child-first')], diagnostics())!;
		assert.deepStrictEqual(value.runs.map(child => child.id), ['child-second', 'child-first']);
	});
});
