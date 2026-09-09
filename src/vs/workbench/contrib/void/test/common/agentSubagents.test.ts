import * as assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { AGENT_SUBAGENT_DEFAULT_WAIT_MS, AGENT_SUBAGENT_MAX_WAIT_MS, AgentSubagentLifecycle, agentSubagentStatusLabel, agentSubagentToolSchemas, assertCanonicalAgentChildRawUri, assertCanonicalAgentChildUriPath, assertCanonicalReadOnlyChildRawPaths, assertExactReadOnlyChildRawKeys, childToolApprovalStructuralKey, createChildToolApprovalView, isActiveChildRun, isPureAgentWaitTimeoutResult, isToolAllowedByProfile, normalizeChildActivities, readOnlyChildToolNames, validateAgentSubagentControlParams } from '../../common/agentSubagents.js';
import { AGENT_DELEGATION_SELECTION_LABEL, isAgentDelegationSelection, StagingSelectionItem } from '../../common/chatThreadServiceTypes.js';
import { availableTools, chat_systemMessage, messageOfSelection } from '../../common/prompt/prompts.js';
import { LLMMessageService } from '../../common/sendLLMMessageService.js';

suite('Void agent subagents', () => {
	test('projects a bounded immutable child-tool approval with a collision-safe tuple key', () => {
		const request: any = { parentId: 'a|b', generation: 2, childId: 'child-123456789', batchId: 'batch|id', batchOrdinal: 3, toolId: 'tool|id', snapshotRevision: 'rev', name: `remote-${'t'.repeat(200)}`, tool: { kind: 'mcp', mcpServerName: `server-${'s'.repeat(200)}`, approval: 'MCP tools' }, rawParams: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [index === 0 ? 'a' : `z${index.toString().padStart(2, '0')}`, 'x'.repeat(10_000)])) };
		const view = createChildToolApprovalView(request);
		assert.strictEqual(view.structuralKey, childToolApprovalStructuralKey(view.key)); assert.strictEqual(view.childShortId, 'child-12'); assert.strictEqual(view.toolName.length, 128); assert.strictEqual(view.mcpServerName?.length, 128); assert.strictEqual(view.title, `MCP tool — ${view.mcpServerName} / ${view.toolName}`); assert.strictEqual(view.status, 'awaiting'); assert.strictEqual(view.parameters.length <= 4096, true); assert.strictEqual(JSON.parse(view.parameters).truncated, true); assert.ok(Object.isFrozen(view)); assert.ok(Object.isFrozen(view.key));
		assert.notStrictEqual(childToolApprovalStructuralKey({ ...view.key, parentId: 'a', childId: 'b|child-123456789' }), view.structuralKey); assert.notStrictEqual(childToolApprovalStructuralKey({ ...view.key, batchOrdinal: 4 }), view.structuralKey);
		const builtin = createChildToolApprovalView({ ...request, name: 'write_file', tool: { kind: 'builtin', approval: 'edits' }, rawParams: { z: 1, a: 2 } }); assert.strictEqual(builtin.title, 'Built-in tool — write_file'); assert.strictEqual(builtin.parameters, '{"a":2,"z":1}'); assert.throws(() => createChildToolApprovalView({ ...request, tool: { kind: 'skill_resource', approval: undefined } }));
	});
	test('uses an exact read-only profile and flat conservative control schemas', () => {
		assert.deepStrictEqual([...readOnlyChildToolNames], ['read_file', 'ls_dir', 'search_pathnames_only', 'search_for_files', 'search_in_file']);
		assert.strictEqual(isToolAllowedByProfile('read-only-child', 'read_file'), true);
		assert.strictEqual(isToolAllowedByProfile('read-only-child', 'write_file'), false);
		assert.strictEqual(isToolAllowedByProfile('read-only-child', 'run_command'), false);
		assert.deepStrictEqual(agentSubagentToolSchemas.spawn_agent, {
			type: 'object', additionalProperties: false, required: ['message'], properties: { message: { type: 'string', minLength: 1, maxLength: 8000 }, agent_type: { type: 'string', minLength: 1, maxLength: 64 }, model: { type: 'string', minLength: 1, maxLength: 256 }, reasoning_effort: { type: 'string', minLength: 1, maxLength: 64 }, fork_turns: { type: 'string', minLength: 1, maxLength: 16 }, background: { type: 'boolean' } },
		});
	});

	test('keeps child orchestration controls exact and excludes Plan-like tool surfaces', () => {
		const delegationControls = ['spawn_agent', 'wait_agent', 'list_agents', 'send_message', 'interrupt_agent'];
		assert.deepStrictEqual(Object.keys(agentSubagentToolSchemas), delegationControls);
		const fakeMcp = [{ name: 'remote_mutation', description: 'no', params: {}, mcpServerName: 'remote' }, ...(delegationControls.map(name => ({ name, description: 'colliding MCP tool', params: {}, mcpServerName: 'remote' })))];
		const childRegistry = availableTools('agent', fakeMcp, 'read-only-child')!.map(tool => tool.name);
		const delegatedChildRegistry = availableTools('agent', fakeMcp, 'read-only-child', true)!.map(tool => tool.name);
		assert.deepStrictEqual(childRegistry, [...readOnlyChildToolNames, 'wait_agent', 'list_agents', 'send_message', 'interrupt_agent']);
		assert.deepStrictEqual(delegatedChildRegistry, [...readOnlyChildToolNames, ...delegationControls]);
		const controlText = availableTools('agent', fakeMcp, 'read-only-child', true)!.filter(tool => ['spawn_agent', 'wait_agent'].includes(tool.name)).map(tool => `${tool.description}\n${JSON.stringify(tool.params)}`).join('\n');
		assert.strictEqual(/four|two|one to eight/i.test(controlText), false);
		assert.match(controlText, /omit timeout_ms/); assert.match(controlText, /instead of repeatedly polling/);
		const unselectedParent = availableTools('agent', fakeMcp)!.map(tool => tool.name);
		for (const name of delegationControls) assert.strictEqual(unselectedParent.includes(name), false);
		assert.ok(unselectedParent.includes('remote_mutation'));
		const parent = availableTools('agent', fakeMcp, 'default-parent', true)!.map(tool => tool.name);
		for (const name of [...delegationControls, 'remote_mutation']) assert.ok(parent.includes(name));
		for (const name of delegationControls) assert.strictEqual(parent.filter(candidate => candidate === name).length, 1);

		const calls: Array<{ command: string; params: any }> = []; let mcpReads = 0; let allowMcpRead = false;
		const channel = { listen: () => () => ({ dispose() { } }), call: (command: string, params: any) => { calls.push({ command, params }); return Promise.resolve(); } };
		const service = new LLMMessageService({ getChannel: () => channel } as never, { state: { settingsOfProvider: {} } } as never, { getMCPTools: () => { mcpReads++; if (!allowMcpRead) throw new Error('child_must_not_read_live_mcp'); return fakeMcp; } } as never);
		const base: any = { messagesType: 'chatMessages', messages: [{ role: 'user', content: 'inspect' }], separateSystemMessage: undefined, chatMode: 'agent', logging: { loggingName: 'test' }, modelSelection: { providerName: 'openAI', modelName: 'fixture' }, modelSelectionOptions: undefined, overridesOfModel: undefined, onText() { }, onFinalMessage() { }, onError() { }, onAbort() { } };
		const childRequest = service.sendLLMMessage({ ...base, toolExecutionProfile: 'read-only-child' });
		assert.strictEqual(mcpReads, 0); assert.deepStrictEqual(calls.find(call => call.command === 'sendLLMMessage')?.params.mcpTools, []);
		allowMcpRead = true;
		const parentRequest = service.sendLLMMessage({ ...base, toolExecutionProfile: 'default-parent', agentDelegationAllowed: true });
		assert.strictEqual(mcpReads, 1); assert.strictEqual(calls.filter(call => call.command === 'sendLLMMessage')[1].params.mcpTools, fakeMcp); assert.strictEqual(calls.filter(call => call.command === 'sendLLMMessage')[1].params.agentDelegationAllowed, true);
		if (childRequest) service.abort(childRequest); if (parentRequest) service.abort(parentRequest); service.dispose();
	});

	test('keeps every production child schema flat, exact, scalar, and composition-free', () => {
		for (const tool of availableTools('agent', undefined, 'read-only-child')!) { const schema = tool.schema as any; assert.strictEqual(schema.type, 'object'); assert.strictEqual(schema.additionalProperties, false); const serialized = JSON.stringify(schema); for (const forbidden of ['oneOf', 'anyOf', 'allOf', 'const']) assert.strictEqual(serialized.includes(`"${forbidden}"`), false); for (const property of Object.values(schema.properties) as any[]) assert.strictEqual(Array.isArray(property.type), false); }
	});

	test('rejects unknown child raw keys before legacy validation', () => {
		assert.doesNotThrow(() => assertExactReadOnlyChildRawKeys('read_file', { uri: 'file:///workspace/a' }));
		for (const [name, raw] of [['read_file', { uri: 'x', extra: true }], ['search_for_files', { query: 'x', cwd: 'outside' }], ['write_file', { uri: 'x' }]] as const) assert.throws(() => assertExactReadOnlyChildRawKeys(name, raw), /agent_child_unknown_tool_field/);
		for (const [name, raw] of [
			['read_file', { uri: 'file:///workspace/../outside' }],
			['read_file', { uri: 'file:///workspace/%2e%2e/outside' }],
			['search_in_file', { uri: 'file:///workspace/a%2Fb', query: 'x' }],
			['search_for_files', { query: 'x', search_in_folder: 'file:///workspace\\outside' }],
		] as const) assert.throws(() => assertCanonicalReadOnlyChildRawPaths(name, raw), /agent_child_path_not_canonical/);
		assert.throws(() => assertCanonicalReadOnlyChildRawPaths('search_in_file', { uri: 'file:///workspace/a', query: '(a+)+$', is_regex: true }), /agent_child_regex_not_supported/);
		assert.doesNotThrow(() => assertCanonicalReadOnlyChildRawPaths('search_for_files', { query: 'x', search_in_folder: '' }));
		const driveRoot = URI.file('C:\\'); const driveChild = URI.joinPath(driveRoot, 'child.txt');
		for (const uri of [driveRoot, driveChild]) { assert.doesNotThrow(() => assertCanonicalAgentChildRawUri(uri.toString())); assert.doesNotThrow(() => assertCanonicalAgentChildUriPath(uri.path)); }
	});

	test('builds exact child XML security authority without terminal, write, MCP, or controls', () => {
		const roots = [URI.file('C:\\workspace').toString(), URI.parse('vscode-remote://ssh-remote+example/workspace').toString()];
		for (const root of roots) {
			const xml = chat_systemMessage({ workspaceFolders: [root], openedURIs: [], activeURI: undefined, persistentTerminalIDs: [], directoryStr: `Root hint: ${root} (use read tools; no recursive overview was injected).`, chatMode: 'agent', mcpTools: [{ name: 'remote_mutation', description: 'no', params: {} }], includeXMLToolDefinitions: true, toolExecutionProfile: 'read-only-child' });
			assert.ok(/Void application-level read-only — terminal disabled, no OS sandbox/.test(xml)); assert.strictEqual(xml.includes(root), true); assert.strictEqual(xml.includes('C:\\workspace'), false); for (const name of readOnlyChildToolNames) assert.ok(new RegExp(`<${name}>`).test(xml)); for (const forbidden of ['run_command', 'write_file', 'remote_mutation', 'spawn_agent', 'get_dir_tree', 'read_lint_errors', 'plan', 'update_plan', 'todowrite']) assert.strictEqual(xml.includes(`<${forbidden}>`), false);
		}
		const delegatedChild = chat_systemMessage({ workspaceFolders: ['C:\\workspace'], openedURIs: [], activeURI: undefined, persistentTerminalIDs: [], directoryStr: '', chatMode: 'agent', mcpTools: [], includeXMLToolDefinitions: true, toolExecutionProfile: 'read-only-child', agentDelegationAllowed: true });
		for (const name of ['spawn_agent', 'wait_agent', 'list_agents', 'send_message', 'interrupt_agent']) assert.ok(delegatedChild.includes(`<${name}>`));
		for (const name of ['plan', 'update_plan', 'todowrite']) assert.strictEqual(delegatedChild.includes(`<${name}>`), false);
		const unselectedParent = chat_systemMessage({ workspaceFolders: ['C:\\workspace'], openedURIs: [], activeURI: undefined, persistentTerminalIDs: [], directoryStr: '', chatMode: 'agent', mcpTools: [], includeXMLToolDefinitions: true });
		assert.strictEqual(unselectedParent.includes('<spawn_agent>'), false);
		const selectedParent = chat_systemMessage({ workspaceFolders: ['C:\\workspace'], openedURIs: [], activeURI: undefined, persistentTerminalIDs: [], directoryStr: '', chatMode: 'agent', mcpTools: [], includeXMLToolDefinitions: true, agentDelegationAllowed: true });
		for (const name of ['spawn_agent', 'wait_agent', 'list_agents', 'send_message', 'interrupt_agent']) assert.ok(selectedParent.includes(`<${name}>`));
	});

	test('rejects unknown control fields before dispatch and defaults a safe wait', () => {
		assert.deepStrictEqual(validateAgentSubagentControlParams('wait_agent', {}), { name: 'wait_agent', timeoutMs: AGENT_SUBAGENT_DEFAULT_WAIT_MS });
		assert.deepStrictEqual(validateAgentSubagentControlParams('spawn_agent', { message: 'x', model: 'override' }), { name: 'spawn_agent', message: 'x', model: 'override', forkTurns: 'none', background: false });
		assert.strictEqual(AGENT_SUBAGENT_DEFAULT_WAIT_MS, 3_600_000); assert.strictEqual(AGENT_SUBAGENT_MAX_WAIT_MS, 3_600_000);
		assert.throws(() => validateAgentSubagentControlParams('wait_agent', { timeout_ms: 3_600_001 }), /wait_agent_invalid_params/);
		assert.throws(() => validateAgentSubagentControlParams('interrupt_agent', { target: 'child', extra: true }), /interrupt_agent_invalid_params/);
	});

	test('enforces control boundary matrix', () => {
		assert.deepStrictEqual(validateAgentSubagentControlParams('wait_agent', { timeout_ms: 0 }), { name: 'wait_agent', timeoutMs: 0 }); assert.deepStrictEqual(validateAgentSubagentControlParams('wait_agent', { timeout_ms: 3_600_000 }), { name: 'wait_agent', timeoutMs: 3_600_000 });
		assert.deepStrictEqual(validateAgentSubagentControlParams('wait_agent', { targets: ['one', 'two'] }), { name: 'wait_agent', timeoutMs: AGENT_SUBAGENT_DEFAULT_WAIT_MS, targets: ['one', 'two'] });
		assert.deepStrictEqual(validateAgentSubagentControlParams('wait_agent', { targets: ['1', '2', '3', '4', '5', '6', '7', '8'] }), { name: 'wait_agent', timeoutMs: AGENT_SUBAGENT_DEFAULT_WAIT_MS, targets: ['1', '2', '3', '4', '5', '6', '7', '8'] });
		for (const raw of [{ targets: [] }, { targets: ['one', 'one'] }, { targets: ['1', '2', '3', '4', '5', '6', '7', '8', '9'] }, { targets: ['one', 2] }]) assert.throws(() => validateAgentSubagentControlParams('wait_agent', raw), /wait_agent_invalid_params/);
		for (const raw of [{ timeout_ms: -1 }, { timeout_ms: 3_600_001 }, { timeout_ms: 1.5 }, { timeout_ms: Number.POSITIVE_INFINITY }, { timeout_ms: '1' }]) assert.throws(() => validateAgentSubagentControlParams('wait_agent', raw), /wait_agent_invalid_params/);
		assert.deepStrictEqual(validateAgentSubagentControlParams('spawn_agent', { message: 'x', agent_type: 'reader_1', reasoning_effort: 'high', fork_turns: '3', background: true }), { name: 'spawn_agent', message: 'x', agentType: 'reader_1', reasoningEffort: 'high', forkTurns: 3, background: true });
		assert.deepStrictEqual(validateAgentSubagentControlParams('list_agents', {}), { name: 'list_agents' }); assert.deepStrictEqual(validateAgentSubagentControlParams('send_message', { target: 'child', message: 'steer' }), { name: 'send_message', target: 'child', message: 'steer' });
		for (const raw of [{}, { message: ' ' }, { message: 'x'.repeat(8001) }, { message: 'x', agent_type: '../path' }, { message: 'x', fork_turns: '0' }, { message: 'x', fork_turns: 2 }, { message: 'x', background: 'false' }]) assert.throws(() => validateAgentSubagentControlParams('spawn_agent', raw), /spawn_agent_invalid_params/);
	});
	test('hides only a pure pending wait timeout result', () => {
		const pure = { timedOut: true, deliverSummary: false, children: [{ id: 'child', status: 'running', completion: 'pending', usage: null }], receipts: [], budget: {} };
		assert.strictEqual(isPureAgentWaitTimeoutResult(pure), true);
		for (const result of [{ ...pure, timedOut: false }, { ...pure, deliverSummary: true }, { ...pure, receipt: { id: 'child' } }, { ...pure, receipts: [{ id: 'child' }] }, { ...pure, children: [{ status: 'completed', completion: 'delivered_now' }] }, { ...pure, children: [{ status: 'running', completion: 'already_delivered' }] }, { ...pure, children: [] }, null]) assert.strictEqual(isPureAgentWaitTimeoutResult(result), false);
	});

	test('settles once and delivers a terminal summary at most once', () => {
		const lifecycle = new AgentSubagentLifecycle();
		assert.strictEqual(lifecycle.start(), true);
		assert.strictEqual(lifecycle.settle('cancelled', 'child-1', 'cancelled by parent'), true);
		assert.strictEqual(lifecycle.settle('completed', 'child-1', 'late provider result'), false);
		assert.deepStrictEqual(lifecycle.receipt(true), { receipt: { id: 'child-1', status: 'cancelled', summary: 'cancelled by parent', usage: null }, deliverSummary: true });
		assert.strictEqual(lifecycle.receipt(true).deliverSummary, false);
		assert.strictEqual(lifecycle.receipt(true).receipt?.summary, '');
	});

	test('bounds terminal summaries and completion wins cancellation race once', () => { const lifecycle = new AgentSubagentLifecycle(); lifecycle.start(); assert.strictEqual(lifecycle.settle('completed', 'id', 'x'.repeat(9000)), true); assert.strictEqual(lifecycle.settle('cancelled', 'id', 'late'), false); const receipt = lifecycle.receipt(true).receipt!; assert.strictEqual(receipt.summary.length, 8000); assert.strictEqual(receipt.usage, null); });
	test('keeps explicit aggregate-result compaction on the terminal receipt only', () => { const lifecycle = new AgentSubagentLifecycle(); lifecycle.start(); lifecycle.settle('completed', 'id', '', true); const receipt = lifecycle.receipt(true).receipt!; assert.strictEqual(receipt.resultTruncated, true); assert.strictEqual(lifecycle.receipt(false).receipt?.resultTruncated, true); });

	test('normalizes only canonical child activity receipts and interrupts reload-active rows', () => {
		const record = { generation: 1, childId: 'child-a', depth: 1, status: 'running', capabilityProfile: 'read_only', queuedMs: 2, runningMs: 3, totalMs: 5, anchor: { toolId: 'tool-a' } };
		const parsed = normalizeChildActivities({ version: 1, records: [record], omitted: 0, retentionSaturated: false }, true);
		assert.strictEqual(parsed.records[0].status, 'interrupted'); assert.ok(Object.isFrozen(parsed));
		for (const bad of [null, [], { version: 1, records: [], omitted: 0, retentionSaturated: false, extra: true }, { version: 1, records: [{ ...record, childId: 1 }], omitted: 0, retentionSaturated: false }, { version: 1, records: [{ ...record, status: 'unknown' }], omitted: 0, retentionSaturated: false }, { version: 1, records: [{ ...record, parentRunId: 'missing', depth: 2 }], omitted: 0, retentionSaturated: false }]) assert.strictEqual(normalizeChildActivities(bad).records.length, 0);
	});
	test('omits malformed present optional receipt fields without treating them as absent', () => {
		const base = { generation: 1, childId: 'child-a', depth: 1, status: 'completed', capabilityProfile: 'read_only', queuedMs: 0, runningMs: 1, totalMs: 1, anchor: { toolId: 'tool-a' } };
		const parse = (record: any) => normalizeChildActivities({ version: 1, records: [record], omitted: 0, retentionSaturated: false });
		assert.strictEqual(parse(base).records.length, 1);
		for (const patch of [{ parentRunId: 7 }, { parentRunId: null }, { parentRunId: undefined }, { parentRunId: '' }, { parentRunId: 'x'.repeat(257) }, { role: undefined }, { summary: 7 }, { summary: null }, { summary: undefined }, { summary: '' }, { summary: 'x'.repeat(8001) }, { resultTruncated: undefined }, { anchor: { toolId: 'tool-a', batchId: 7, batchOrdinal: 0 } }, { anchor: { toolId: 'tool-a', batchId: undefined, batchOrdinal: 0 } }, { anchor: { toolId: 'tool-a', batchId: 'batch', batchOrdinal: null } }, { anchor: { toolId: 'tool-a', batchId: '', batchOrdinal: 0 } }]) assert.strictEqual(parse({ ...base, ...patch }).records.length, 0);
		const child = { ...base, childId: 'child-b', parentRunId: 'child-a', depth: 2 }; const parseTree = (record: any) => normalizeChildActivities({ version: 1, records: [base, record], omitted: 0, retentionSaturated: false }); assert.strictEqual(parseTree(child).records.length, 2); assert.deepStrictEqual(parseTree({ ...child, anchor: { toolId: 'other-tool' } }).records.map(record => record.childId), ['child-a']);
	});
	test('fails closed on duplicate activity identities and retains bounded UTF-8 receipts', () => {
		const row = (id: string, status: string = 'completed') => ({ generation: 1, childId: id, depth: 1, status, capabilityProfile: 'read_only', summary: '한'.repeat(8000), queuedMs: 0, runningMs: 1, totalMs: 1, anchor: { toolId: `tool-${id}` } });
		assert.strictEqual(normalizeChildActivities({ version: 1, records: [row('same'), row('same')], omitted: 0, retentionSaturated: false }).records.length, 0);
		const retained = normalizeChildActivities({ version: 1, records: Array.from({ length: 33 }, (_, i) => row(`child-${i}`)), omitted: 0, retentionSaturated: false });
		assert.ok(retained.records.length <= 32); assert.ok(new TextEncoder().encode(JSON.stringify(retained)).byteLength <= 64 * 1024); assert.ok(retained.omitted > 0);
		assert.ok(retained.records.some(record => record.resultTruncated)); assert.ok(retained.records.filter(record => record.resultTruncated).every(record => !Object.prototype.hasOwnProperty.call(record, 'summary'))); assert.deepStrictEqual(normalizeChildActivities(retained), retained);
	});
	test('never slices active activity receipts and evicts only whole terminal root trees', () => {
		const row = (childId: string, status: 'queued' | 'running' | 'completed', parentRunId?: string, depth = parentRunId ? 2 : 1, summary?: string) => ({ generation: 9, childId, ...(parentRunId ? { parentRunId } : {}), depth, status, capabilityProfile: 'read_only', ...(summary ? { summary } : {}), queuedMs: 0, runningMs: 1, totalMs: 1, anchor: { toolId: `tool-${parentRunId ?? childId}` } });
		const active = normalizeChildActivities({ version: 1, records: Array.from({ length: 33 }, (_, index) => row(`active-${index}`, index % 2 ? 'queued' : 'running')), omitted: 0, retentionSaturated: false });
		assert.deepStrictEqual(active.records, []); assert.strictEqual(active.omitted, 33); assert.strictEqual(active.retentionSaturated, true);
		const exact = normalizeChildActivities({ version: 1, records: Array.from({ length: 32 }, (_, index) => row(`exact-${index}`, 'running')), omitted: 7, retentionSaturated: false });
		assert.deepStrictEqual(exact.records.map(record => record.childId), Array.from({ length: 32 }, (_, index) => `exact-${index}`)); assert.strictEqual(exact.omitted, 7); assert.strictEqual(exact.retentionSaturated, false);
		const wide = (index: number) => ({ generation: 10, childId: `${'한'.repeat(254)}${index.toString().padStart(2, '0')}`, depth: 1, status: 'running', capabilityProfile: 'read_only', role: { name: 'r'.repeat(64), description: '한'.repeat(1024) }, queuedMs: 0, runningMs: 1, totalMs: 1, anchor: { toolId: '한'.repeat(256), batchId: '한'.repeat(256), batchOrdinal: index } });
		const wideRaw = { version: 1, records: Array.from({ length: 32 }, (_, index) => wide(index)), omitted: 0, retentionSaturated: false }; assert.ok(new TextEncoder().encode(JSON.stringify(wideRaw)).byteLength > 64 * 1024);
		const largeActive = normalizeChildActivities(wideRaw);
		assert.deepStrictEqual(largeActive.records, []); assert.strictEqual(largeActive.omitted, 32); assert.strictEqual(largeActive.retentionSaturated, true);
		const terminalTree = normalizeChildActivities({ version: 1, records: [row('old', 'completed', undefined, 1, '한'.repeat(8000)), row('old-child', 'completed', 'old', 2, '한'.repeat(8000)), ...Array.from({ length: 31 }, (_, index) => row(`new-${index}`, 'running'))], omitted: 0, retentionSaturated: false });
		assert.ok(!terminalTree.records.some(record => record.childId === 'old')); assert.ok(!terminalTree.records.some(record => record.childId === 'old-child')); assert.deepStrictEqual(terminalTree.records.map(record => record.childId), Array.from({ length: 31 }, (_, index) => `new-${index}`)); assert.strictEqual(terminalTree.omitted, 2);
		const activeDescendant = normalizeChildActivities({ version: 1, records: [row('terminal-root', 'completed'), row('still-running', 'running', 'terminal-root'), ...Array.from({ length: 31 }, (_, index) => row(`running-${index}`, 'running'))], omitted: 0, retentionSaturated: false });
		assert.deepStrictEqual(activeDescendant.records, []); assert.strictEqual(activeDescendant.omitted, 33); assert.strictEqual(activeDescendant.retentionSaturated, true);
	});
	test('permits provider tuple reuse across generations but not within one persisted batch row', () => {
		const root = (childId: string) => ({ generation: 1, childId, depth: 1, status: 'completed', capabilityProfile: 'read_only', queuedMs: 0, runningMs: 1, totalMs: 1, anchor: { toolId: 'spawn', batchId: 'batch', batchOrdinal: 0 } });
		assert.deepStrictEqual(normalizeChildActivities({ version: 1, records: [root('one'), root('two')], omitted: 0, retentionSaturated: false }).records, []);
		const nested = normalizeChildActivities({ version: 1, records: [root('one'), { ...root('nested'), childId: 'nested', parentRunId: 'one', depth: 2 }], omitted: 0, retentionSaturated: false }); assert.deepStrictEqual(nested.records.map(record => record.childId), ['one', 'nested']);
		const laterGeneration = normalizeChildActivities({ version: 1, records: [root('one'), { ...root('two'), generation: 2 }], omitted: 0, retentionSaturated: false }); assert.deepStrictEqual(laterGeneration.records.map(record => record.childId), ['one', 'two']);
	});

	test('presents transient child status without coercing usage', () => {
		const running = { id: 'child', status: 'running' as const, usage: null };
		assert.strictEqual(isActiveChildRun(running), true); assert.strictEqual(agentSubagentStatusLabel('failed'), 'Failed'); assert.strictEqual(running.usage, null);
	});

	test('presents every status and marks only queued/running active', () => { for (const [status, label, active] of [['queued', 'Queued', true], ['running', 'Running', true], ['completed', 'Completed', false], ['failed', 'Failed', false], ['cancelled', 'Cancelled', false]] as const) { assert.strictEqual(agentSubagentStatusLabel(status), label); assert.strictEqual(isActiveChildRun({ id: 'id', status, usage: null }), active); } });

	test('supports a stable URI-less inert Agent selection', () => {
		const selection: StagingSelectionItem = { type: 'Agent', label: AGENT_DELEGATION_SELECTION_LABEL };
		assert.deepStrictEqual(selection, { type: 'Agent', label: AGENT_DELEGATION_SELECTION_LABEL });
		assert.strictEqual(isAgentDelegationSelection(selection), true);
		assert.strictEqual(isAgentDelegationSelection({ ...selection, label: 'Agent' }), false);
		assert.strictEqual(isAgentDelegationSelection({ ...selection, extra: true }), false);
	});

	test('accepts a frozen named role but rejects partial or malformed role intent', () => {
		const named = { type: 'Agent', label: AGENT_DELEGATION_SELECTION_LABEL, agentType: 'project-reader', catalogRevision: 'catalog-1', roleRevision: 'role-1', state: undefined } as const;
		assert.strictEqual(isAgentDelegationSelection(named), true);
		assert.strictEqual(isAgentDelegationSelection({ ...named, roleRevision: undefined }), false);
		assert.strictEqual(isAgentDelegationSelection({ ...named, agentType: 'Project Reader' }), false);
	});

	test('gives URI-less Agent no selection content or authority', async () => { const selection: StagingSelectionItem = { type: 'Agent', label: AGENT_DELEGATION_SELECTION_LABEL }; assert.strictEqual(await messageOfSelection(selection, {} as never), ''); });
});
