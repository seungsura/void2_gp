/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { getAgentSubagentPresentation } from '../../common/agentSubagentPresentation.js';

const budget = (overrides: Record<string, unknown> = {}) => ({ accepted: 0, running: 0, queued: 0, maxAccepted: 4, maxConcurrent: 2, providerSends: 0, maxProviderSends: 64, resultChars: 0, maxResultChars: 32_000, deadlineMsRemaining: 240_000, usage: null, ...overrides }) as any;
const run = (status: string, id = 'child-abcdefgh') => ({ id, status, queuedMs: 1, runningMs: 2, totalMs: 3, authority: { runtimeRevision: 'runtime', instructionsRevision: 'instructions', catalogRevision: 'catalog', selectedSkills: [] }, usage: null }) as any;
const diagnostics = (events: any[] = []) => ({ parentId: 'parent', generation: 1, elapsedMs: 4, events, droppedEvents: 0, completed: 0, failed: 0, cancelled: 0, usage: null }) as any;
const event = (kind: string) => ({ sequence: 1, parentId: 'parent', generation: 1, kind, timestamp: 1, elapsedMs: 0, budget: { accepted: 0, running: 0, queued: 0, providerSends: 0, resultChars: 0 } });

suite('Void AgentSubagentPresentation', () => {
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
		assert.strictEqual(value.summary, 'Child runs · 1 running · 1 queued · 2/4 accepted'); assert.strictEqual(value.summary.includes('usage'), false);
	});
	test('reports completed runs without action required', () => {
		const value = getAgentSubagentPresentation(budget({ accepted: 1 }), [run('completed')], diagnostics())!;
		assert.strictEqual(value.completed, 1); assert.strictEqual(value.actionRequired, false);
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
	test('preserves spawn order', () => {
		const value = getAgentSubagentPresentation(budget({ accepted: 2 }), [run('queued', 'child-second'), run('running', 'child-first')], diagnostics())!;
		assert.deepStrictEqual(value.runs.map(child => child.id), ['child-second', 'child-first']);
	});
});
