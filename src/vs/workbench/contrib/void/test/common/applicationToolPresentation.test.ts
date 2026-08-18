import assert from 'assert';
import { applicationToolPresentation, applicationToolRoute, isApplicationToolName, shouldOfferGenericToolApproval } from '../../common/applicationToolPresentation.js';

suite('Application tool presentation', () => {
	test('classifies the four reserved application names with exact titles', () => {
		const expected = { read_skill_resource: 'Read Skill resource', spawn_agent: 'Start child Agent', wait_agent: 'Wait for child Agent', interrupt_agent: 'Interrupt child Agent' } as const;
		for (const [name, title] of Object.entries(expected)) { assert.strictEqual(isApplicationToolName(name), true); assert.strictEqual(applicationToolPresentation(name, 'success', {}, {})!.title, title); }
	});
	test('uses exact status labels for every persisted application state', () => {
		const titles = { read_skill_resource: 'Read Skill resource', spawn_agent: 'Start child Agent', wait_agent: 'Wait for child Agent', interrupt_agent: 'Interrupt child Agent' } as const;
		const statuses = { running_now: 'Running', success: 'Completed', tool_error: 'Failed', rejected: 'Rejected', invalid_params: 'Invalid request', interrupted_streaming_tool: 'Cancelled', tool_request: 'Requested' } as const;
		for (const [name, title] of Object.entries(titles)) for (const [type, status] of Object.entries(statuses)) {
			const value = applicationToolPresentation(name, type, { name, type }, `${name}:${type}`)!;
			assert.deepStrictEqual([value.title, value.status], [title, status], `${name}/${type}`);
			if (type === 'invalid_params' || type === 'tool_error') assert.strictEqual(value.error, `${name}:${type}`, `${name}/${type}/error`);
		}
	});
	test('separates bounded params, success result, and exact error payloads', () => {
		const success = applicationToolPresentation('read_skill_resource', 'success', { skill: 'demo', resource_path: 'guide.md' }, 'resource body')!;
		assert.deepStrictEqual(success, { title: 'Read Skill resource', status: 'Completed', paramsDetail: '{"skill":"demo","resource_path":"guide.md"}', resultDetail: 'resource body' });
		const invalid = applicationToolPresentation('wait_agent', 'invalid_params', { ids: 'bad' }, 'wait_agent_invalid_params')!;
		assert.strictEqual(invalid.paramsDetail, '{"ids":"bad"}'); assert.strictEqual(invalid.error, 'wait_agent_invalid_params'); assert.strictEqual(invalid.resultDetail, undefined);
		const failure = applicationToolPresentation('interrupt_agent', 'tool_error', { id: 'child' }, 'child_not_found')!;
		assert.strictEqual(failure.error, 'child_not_found'); assert.strictEqual(failure.resultDetail, undefined);
	});
	test('contains undefined, circular, and long values without throwing', () => {
		const circular: any = {}; circular.self = circular;
		const value = applicationToolPresentation('read_skill_resource', 'success', circular, { long: 'x'.repeat(500) })!;
		assert.strictEqual(value.paramsDetail, '[unavailable]'); assert.strictEqual(value.resultDetail!.length, 240); assert.strictEqual(value.resultDetail!.endsWith('...'), true);
		const emptySuccess = applicationToolPresentation('read_skill_resource', 'success', '', '')!; assert.strictEqual(emptySuccess.paramsDetail, '[empty]'); assert.strictEqual(emptySuccess.resultDetail, '[empty]');
		assert.strictEqual(applicationToolPresentation('spawn_agent', 'tool_error', {}, '')!.error, '[empty]');
		assert.strictEqual(applicationToolPresentation('read_skill_resource', 'success', undefined, undefined)!.resultDetail, '[undefined]');
		const cancelled = applicationToolPresentation('wait_agent', 'interrupted_streaming_tool', '', '')!; assert.strictEqual(cancelled.status, 'Cancelled'); assert.strictEqual(cancelled.paramsDetail, '[empty]'); assert.strictEqual(cancelled.resultDetail, undefined); assert.strictEqual(cancelled.error, undefined);
	});
	test('routes builtin then application then MCP and offers generic approval only outside application tools', () => {
		assert.strictEqual(applicationToolRoute('read_file', true), 'builtin'); assert.strictEqual(applicationToolRoute('spawn_agent', false), 'application'); assert.strictEqual(applicationToolRoute('mcp__server__real_tool', false), 'mcp');
		assert.strictEqual(shouldOfferGenericToolApproval('application', 'tool_request'), false); assert.strictEqual(shouldOfferGenericToolApproval('mcp', 'tool_request'), true); assert.strictEqual(shouldOfferGenericToolApproval('builtin', 'tool_request'), true); assert.strictEqual(shouldOfferGenericToolApproval('mcp', 'success'), false);
	});
	test('leaves a real MCP name completely unchanged for the MCP renderer', () => {
		assert.strictEqual(isApplicationToolName('mcp__server__real_tool'), false);
		assert.strictEqual(applicationToolPresentation('mcp__server__real_tool', 'tool_request', { exact: true }, { untouched: true }), undefined);
	});
});
