import * as assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { AGENT_SUBAGENT_DEFAULT_WAIT_MS, AgentSubagentLifecycle, agentSubagentStatusLabel, agentSubagentToolSchemas, assertCanonicalAgentChildRawUri, assertCanonicalAgentChildUriPath, assertCanonicalReadOnlyChildRawPaths, assertExactReadOnlyChildRawKeys, isActiveChildRun, isToolAllowedByProfile, readOnlyChildToolNames, validateAgentSubagentControlParams } from '../../common/agentSubagents.js';
import { AGENT_DELEGATION_SELECTION_LABEL, isAgentDelegationSelection, StagingSelectionItem } from '../../common/chatThreadServiceTypes.js';
import { availableTools, chat_systemMessage, messageOfSelection } from '../../common/prompt/prompts.js';
import { LLMMessageService } from '../../common/sendLLMMessageService.js';

suite('Void agent subagents', () => {
	test('uses an exact read-only profile and flat conservative control schemas', () => {
		assert.deepStrictEqual([...readOnlyChildToolNames], ['read_file', 'ls_dir', 'search_pathnames_only', 'search_for_files', 'search_in_file']);
		assert.strictEqual(isToolAllowedByProfile('read-only-child', 'read_file'), true);
		assert.strictEqual(isToolAllowedByProfile('read-only-child', 'write_file'), false);
		assert.strictEqual(isToolAllowedByProfile('read-only-child', 'run_command'), false);
		assert.deepStrictEqual(agentSubagentToolSchemas.spawn_agent, {
			type: 'object', additionalProperties: false, required: ['message'], properties: { message: { type: 'string', minLength: 1, maxLength: 8000 }, agent_type: { type: 'string', minLength: 1, maxLength: 64 } },
		});
	});

	test('derives exact child and parent registries from production availableTools', () => {
		const fakeMcp = [{ name: 'remote_mutation', description: 'no', params: {}, mcpServerName: 'remote' }, ...(['spawn_agent', 'wait_agent', 'interrupt_agent'] as const).map(name => ({ name, description: 'colliding MCP tool', params: {}, mcpServerName: 'remote' }))];
		assert.deepStrictEqual(availableTools('agent', fakeMcp, 'read-only-child')?.map(tool => tool.name), [...readOnlyChildToolNames]);
		const unselectedParent = availableTools('agent', fakeMcp)!.map(tool => tool.name);
		for (const name of ['spawn_agent', 'wait_agent', 'interrupt_agent']) assert.strictEqual(unselectedParent.includes(name), false);
		assert.ok(unselectedParent.includes('remote_mutation'));
		const parent = availableTools('agent', fakeMcp, 'default-parent', true)!.map(tool => tool.name);
		for (const name of ['spawn_agent', 'wait_agent', 'interrupt_agent', 'remote_mutation']) assert.ok(parent.includes(name));
		for (const name of ['spawn_agent', 'wait_agent', 'interrupt_agent']) assert.strictEqual(parent.filter(candidate => candidate === name).length, 1);

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
			assert.ok(/Void application-level read-only — terminal disabled, no OS sandbox/.test(xml)); assert.strictEqual(xml.includes(root), true); assert.strictEqual(xml.includes('C:\\workspace'), false); for (const name of readOnlyChildToolNames) assert.ok(new RegExp(`<${name}>`).test(xml)); for (const forbidden of ['run_command', 'write_file', 'remote_mutation', 'spawn_agent', 'get_dir_tree', 'read_lint_errors']) assert.strictEqual(xml.includes(`<${forbidden}>`), false);
		}
		const unselectedParent = chat_systemMessage({ workspaceFolders: ['C:\\workspace'], openedURIs: [], activeURI: undefined, persistentTerminalIDs: [], directoryStr: '', chatMode: 'agent', mcpTools: [], includeXMLToolDefinitions: true });
		assert.strictEqual(unselectedParent.includes('<spawn_agent>'), false);
		const selectedParent = chat_systemMessage({ workspaceFolders: ['C:\\workspace'], openedURIs: [], activeURI: undefined, persistentTerminalIDs: [], directoryStr: '', chatMode: 'agent', mcpTools: [], includeXMLToolDefinitions: true, agentDelegationAllowed: true });
		for (const name of ['spawn_agent', 'wait_agent', 'interrupt_agent']) assert.ok(selectedParent.includes(`<${name}>`));
	});

	test('rejects unknown control fields before dispatch and defaults a safe wait', () => {
		assert.deepStrictEqual(validateAgentSubagentControlParams('wait_agent', {}), { name: 'wait_agent', timeoutMs: AGENT_SUBAGENT_DEFAULT_WAIT_MS });
		assert.throws(() => validateAgentSubagentControlParams('spawn_agent', { message: 'x', model: 'override' }), /spawn_agent_invalid_params/);
		assert.throws(() => validateAgentSubagentControlParams('wait_agent', { timeout_ms: 30001 }), /wait_agent_invalid_params/);
		assert.throws(() => validateAgentSubagentControlParams('interrupt_agent', { target: 'child', extra: true }), /interrupt_agent_invalid_params/);
	});

	test('enforces control boundary matrix', () => {
		assert.deepStrictEqual(validateAgentSubagentControlParams('wait_agent', { timeout_ms: 0 }), { name: 'wait_agent', timeoutMs: 0 }); assert.deepStrictEqual(validateAgentSubagentControlParams('wait_agent', { timeout_ms: 30000 }), { name: 'wait_agent', timeoutMs: 30000 });
		assert.deepStrictEqual(validateAgentSubagentControlParams('wait_agent', { targets: ['one', 'two'] }), { name: 'wait_agent', timeoutMs: AGENT_SUBAGENT_DEFAULT_WAIT_MS, targets: ['one', 'two'] });
		for (const raw of [{ targets: [] }, { targets: ['one', 'one'] }, { targets: ['1', '2', '3', '4', '5'] }, { targets: ['one', 2] }]) assert.throws(() => validateAgentSubagentControlParams('wait_agent', raw), /wait_agent_invalid_params/);
		for (const raw of [{ timeout_ms: -1 }, { timeout_ms: 30001 }, { timeout_ms: 1.5 }, { timeout_ms: Number.POSITIVE_INFINITY }, { timeout_ms: '1' }]) assert.throws(() => validateAgentSubagentControlParams('wait_agent', raw), /wait_agent_invalid_params/);
		assert.deepStrictEqual(validateAgentSubagentControlParams('spawn_agent', { message: 'x', agent_type: 'reader_1' }), { name: 'spawn_agent', message: 'x', agentType: 'reader_1' });
		for (const raw of [{}, { message: ' ' }, { message: 'x'.repeat(8001) }, { message: 'x', agent_type: '../path' }]) assert.throws(() => validateAgentSubagentControlParams('spawn_agent', raw), /spawn_agent_invalid_params/);
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
