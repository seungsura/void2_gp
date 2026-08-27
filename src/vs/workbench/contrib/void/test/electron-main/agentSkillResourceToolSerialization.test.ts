import * as assert from 'assert';
import { anthropicTools, geminiTools, openAITools } from '../../electron-main/llmMessage/sendLLMMessage.impl.js';
import { availableTools, captureParentModelToolSnapshot, chat_systemMessage } from '../../common/prompt/prompts.js';
import { extractXMLToolsWrapper } from '../../electron-main/llmMessage/extractGrammar.js';
import { isNativeAgentToolFormat, validateAgentSubagentControlParams } from '../../common/agentSubagents.js';


suite('Void selected Skill resource production serialization', () => {
	test('serializes no-marker native Agent authority through every production provider path', () => {
		const authority = isNativeAgentToolFormat('openai-style'); assert.strictEqual(authority, true); assert.strictEqual(isNativeAgentToolFormat(undefined), false);
		const emitted = [openAITools('agent', undefined, 'default-parent', authority)!.map(tool => tool.function.name), anthropicTools('agent', undefined, 'default-parent', authority)!.map(tool => tool.name), geminiTools('agent', undefined, 'default-parent', authority)![0].functionDeclarations!.map(tool => tool.name)];
		for (const names of emitted) for (const name of ['spawn_agent', 'wait_agent', 'interrupt_agent']) assert.ok(names.includes(name));
	});
	test('serializes bounded wait_agent targets through every provider path and gates child controls by depth authority', () => {
		const registry = availableTools('agent', undefined, 'default-parent', true)!.find(tool => tool.name === 'wait_agent')!;
		const spawnRegistry = availableTools('agent', undefined, 'default-parent', true)!.find(tool => tool.name === 'spawn_agent')!;
		const openAIToolset = openAITools('agent', undefined, 'default-parent', true)!;
		const anthropicToolset = anthropicTools('agent', undefined, 'default-parent', true)!;
		const geminiToolset = geminiTools('agent', undefined, 'default-parent', true)![0].functionDeclarations!;
		const openAI = openAIToolset.find(tool => tool.function.name === 'wait_agent')!;
		const anthropic = anthropicToolset.find(tool => tool.name === 'wait_agent')!;
		const gemini = geminiToolset.find(tool => tool.name === 'wait_agent')!;
		assert.deepStrictEqual(openAI.function.parameters, registry.schema);
		assert.ok('input_schema' in anthropic); if ('input_schema' in anthropic) assert.deepStrictEqual(anthropic.input_schema, registry.schema);
		const targets = gemini.parameters?.properties?.targets as any;
		assert.ok(targets); assert.strictEqual(targets.minItems, '1'); assert.strictEqual(targets.maxItems, '8'); assert.strictEqual(targets.items?.type, 'STRING'); assert.strictEqual(targets.items?.maxLength, '256');
		assert.deepStrictEqual(openAIToolset.find(tool => tool.function.name === 'spawn_agent')!.function.parameters, spawnRegistry.schema);
		const anthropicSpawn = anthropicToolset.find(tool => tool.name === 'spawn_agent')!; assert.ok('input_schema' in anthropicSpawn); if ('input_schema' in anthropicSpawn) assert.deepStrictEqual(anthropicSpawn.input_schema, spawnRegistry.schema);
		const geminiAgentType = geminiToolset.find(tool => tool.name === 'spawn_agent')!.parameters?.properties?.agent_type as any; assert.strictEqual(geminiAgentType.type, 'STRING');
		const xml = chat_systemMessage({ workspaceFolders: ['C:\\workspace'], openedURIs: [], activeURI: undefined, persistentTerminalIDs: [], directoryStr: '', chatMode: 'agent', mcpTools: undefined, includeXMLToolDefinitions: true, agentDelegationAllowed: true });
		assert.ok(xml.includes('<targets>')); assert.ok(xml.includes('direct-child ids within the protocol limit')); assert.ok(xml.includes('<agent_type>'));
		assert.strictEqual(openAITools('agent', undefined, 'default-parent', false)!.some(tool => tool.function.name === 'spawn_agent'), false);
		assert.strictEqual(anthropicTools('agent', undefined, 'default-parent', false)!.some(tool => tool.name === 'spawn_agent'), false);
		assert.strictEqual(geminiTools('agent', undefined, 'default-parent', false)![0].functionDeclarations!.some(tool => tool.name === 'spawn_agent'), false);
		const ordinaryXml = chat_systemMessage({ workspaceFolders: ['C:\\workspace'], openedURIs: [], activeURI: undefined, persistentTerminalIDs: [], directoryStr: '', chatMode: 'agent', mcpTools: undefined, includeXMLToolDefinitions: true, agentDelegationAllowed: false });
		assert.strictEqual(ordinaryXml.includes('spawn_agent'), false);
		for (const emittedChild of [openAITools('agent', undefined, 'read-only-child', true)!.map(tool => tool.function.name), anthropicTools('agent', undefined, 'read-only-child', true)!.map(tool => tool.name), geminiTools('agent', undefined, 'read-only-child', true)![0].functionDeclarations!.map(tool => tool.name)]) for (const name of ['spawn_agent', 'wait_agent', 'interrupt_agent']) assert.ok(emittedChild.includes(name));
		assert.strictEqual(availableTools('agent', undefined, 'read-only-child')!.some(tool => tool.name === 'wait_agent'), false);
		assert.strictEqual(availableTools('agent', undefined, 'read-only-child', true)!.filter(tool => tool.name === 'wait_agent').length, 1);
	});

	test('serializes an immutable inherited parent profile through native and XML paths', () => {
		const live = [{ name: 'captured_mcp', description: 'Captured MCP.', schema: { type: 'object', properties: { query: { type: 'string', description: 'original' } } }, params: { query: { description: 'q' } }, mcpServerName: 'captured-server' }];
		const snapshot = captureParentModelToolSnapshot('agent', live, true); const revision = snapshot.revision;
		(live[0].schema!.properties.query as any).description = 'mutated'; live[0].params.query.description = 'mutated';
		assert.ok(Object.isFrozen(snapshot)); assert.ok(snapshot.tools.some(tool => tool.name === 'write_file' && tool.approval === 'edits'));
		const captured = snapshot.tools.find(tool => tool.name === 'captured_mcp')!; assert.strictEqual(captured.schema?.properties && (captured.schema.properties as any).query.description, 'original'); assert.strictEqual(captured.params.query.description, 'q'); assert.strictEqual(snapshot.revision, revision);
		assert.ok(snapshot.tools.some(tool => tool.name === 'captured_mcp' && tool.kind === 'mcp' && tool.mcpServerName === 'captured-server'));
		const sets = [openAITools('agent', [{ name: 'live_other', description: 'live', params: {} }], 'inherited-parent-write-child', true, snapshot)!.map(tool => tool.function.name), anthropicTools('agent', undefined, 'inherited-parent-write-child', true, snapshot)!.map(tool => tool.name), geminiTools('agent', undefined, 'inherited-parent-write-child', true, snapshot)![0].functionDeclarations!.map(tool => tool.name)];
		for (const names of sets) { assert.ok(names.includes('write_file')); assert.ok(names.includes('captured_mcp')); assert.strictEqual(names.includes('live_other'), false); for (const control of ['spawn_agent', 'wait_agent', 'interrupt_agent']) assert.ok(names.includes(control)); }
		const xml = chat_systemMessage({ workspaceFolders: ['C:\workspace'], openedURIs: [], activeURI: undefined, persistentTerminalIDs: [], directoryStr: '', chatMode: 'agent', mcpTools: undefined, includeXMLToolDefinitions: true, toolExecutionProfile: 'inherited-parent-write-child', agentDelegationAllowed: true, frozenToolSnapshot: snapshot });
		assert.ok(xml.includes('<write_file>')); assert.ok(xml.includes('<captured_mcp>')); assert.ok(xml.includes('no OS sandbox'));
		let capturedCall: any; const inheritedWrapper = extractXMLToolsWrapper(() => { }, params => { capturedCall = params.toolCall; }, 'agent', [{ name: 'live_replaced', description: 'Live only.', params: {} }], 'inherited-parent-write-child', true, snapshot);
		inheritedWrapper.newOnFinalMessage({ fullText: '<captured_mcp><query>needle</query></captured_mcp>', fullReasoning: '', anthropicReasoning: null } as any);
		assert.strictEqual(capturedCall.name, 'captured_mcp'); assert.deepStrictEqual(capturedCall.rawParams, { query: 'needle' });
		let liveOnly: any; const liveOnlyWrapper = extractXMLToolsWrapper(() => { }, params => { liveOnly = params.toolCall; }, 'agent', [{ name: 'live_replaced', description: 'Live only.', params: {} }], 'inherited-parent-write-child', true, snapshot);
		liveOnlyWrapper.newOnFinalMessage({ fullText: '<live_replaced></live_replaced>', fullReasoning: '', anthropicReasoning: null } as any);
		assert.strictEqual(liveOnly, undefined);
	});

	test('normalizes only valid XML wait fields before strict shared validation', () => {
		let tool: any; const wrapper = extractXMLToolsWrapper(() => { }, params => { tool = params.toolCall; }, 'agent', undefined, 'default-parent', true);
		wrapper.newOnFinalMessage({ fullText: '<wait_agent><timeout_ms>1000</timeout_ms><targets>["a","b"]</targets></wait_agent>', fullReasoning: '', anthropicReasoning: null } as any);
		assert.deepStrictEqual(tool.rawParams, { timeout_ms: 1000, targets: ['a', 'b'] }); assert.deepStrictEqual(validateAgentSubagentControlParams('wait_agent', tool.rawParams), { name: 'wait_agent', timeoutMs: 1000, targets: ['a', 'b'] });
		let malformed: any; const malformedWrapper = extractXMLToolsWrapper(() => { }, params => { malformed = params.toolCall; }, 'agent', undefined, 'default-parent', true);
		malformedWrapper.newOnFinalMessage({ fullText: '<wait_agent><timeout_ms>01</timeout_ms><targets>not-json</targets></wait_agent>', fullReasoning: '', anthropicReasoning: null } as any);
		assert.throws(() => validateAgentSubagentControlParams('wait_agent', malformed.rawParams), /wait_agent_invalid_params/);
	});

	test('normalizes only canonical XML page numbers for paginated tools', () => {
		const parse = (fullText: string) => { let tool: any; const wrapper = extractXMLToolsWrapper(() => { }, params => { tool = params.toolCall; }, 'agent', undefined); wrapper.newOnFinalMessage({ fullText, fullReasoning: '', anthropicReasoning: null } as any); return tool; };
		assert.deepStrictEqual([
			parse('<ls_dir><uri>C:\\workspace</uri><page_number>2</page_number></ls_dir>'),
			parse('<search_pathnames_only><query>needle</query><page_number>2</page_number></search_pathnames_only>'),
			parse('<search_for_files><query>needle</query><page_number>2</page_number></search_for_files>'),
		].map(call => [call.name, call.rawParams.page_number]), [['ls_dir', 2], ['search_pathnames_only', 2], ['search_for_files', 2]]);
		for (const malformed of ['01', '0', '2junk', '2e1', '1.5']) {
			let tool: any; const malformedWrapper = extractXMLToolsWrapper(() => { }, params => { tool = params.toolCall; }, 'agent', undefined);
			malformedWrapper.newOnFinalMessage({ fullText: `<search_pathnames_only><query>needle</query><page_number>${malformed}</page_number></search_pathnames_only>`, fullReasoning: '', anthropicReasoning: null } as any);
			assert.strictEqual(tool.rawParams.page_number, malformed, `${malformed} remains a string for shared runtime rejection`);
		}
		let unsafe: any; const unsafeWrapper = extractXMLToolsWrapper(() => { }, params => { unsafe = params.toolCall; }, 'agent', undefined);
		unsafeWrapper.newOnFinalMessage({ fullText: '<search_for_files><query>needle</query><page_number>9007199254740992</page_number></search_for_files>', fullReasoning: '', anthropicReasoning: null } as any);
		assert.strictEqual(unsafe.rawParams.page_number, 9007199254740992);
	});

	test('round-trips the shared flat registry through OpenAI and Anthropic', () => {
		const registry = availableTools('agent', undefined)!.find(tool => tool.name === 'read_skill_resource')!;
		const openAI = openAITools('agent', undefined)!.find(tool => tool.function.name === 'read_skill_resource')!;
		const anthropic = anthropicTools('agent', undefined)!.find(tool => tool.name === 'read_skill_resource')!;
		assert.deepStrictEqual(openAI.function.parameters, registry.schema);
		assert.ok('input_schema' in anthropic);
		if (!('input_schema' in anthropic)) return;
		assert.deepStrictEqual(anthropic.input_schema, registry.schema);
	});

	test('serializes the production Gemini declaration without numeric minLength', () => {
		const declaration = geminiTools('agent', undefined)![0].functionDeclarations!.find(tool => tool.name === 'read_skill_resource')!;
		const serialized = JSON.stringify(declaration.parameters);
		assert.strictEqual(serialized.includes('minLength'), false);
		assert.deepStrictEqual(declaration.parameters?.required, ['skill', 'resource_path']);
		assert.ok(declaration.parameters?.properties?.skill);
		assert.ok(declaration.parameters?.properties?.resource_path);
		assert.strictEqual(Object.prototype.hasOwnProperty.call(declaration.parameters ?? {}, 'additionalProperties'), false);
	});

	test('publishes the same parent-only application tool through production XML definitions', () => {
		const xml = chat_systemMessage({ workspaceFolders: ['C:\\workspace'], openedURIs: [], activeURI: undefined, persistentTerminalIDs: [], directoryStr: '', chatMode: 'agent', mcpTools: [{ name: 'read_skill_resource', description: 'collision', params: {}, mcpServerName: 'collision' }], includeXMLToolDefinitions: true });
		assert.strictEqual((xml.match(/\d+\. read_skill_resource/g) ?? []).length, 1);
		assert.ok(xml.includes('<read_skill_resource>'));
		assert.ok(xml.includes('<skill>'));
		assert.ok(xml.includes('<resource_path>'));
		const child = chat_systemMessage({ workspaceFolders: ['C:\\workspace'], openedURIs: [], activeURI: undefined, persistentTerminalIDs: [], directoryStr: '', chatMode: 'agent', mcpTools: undefined, includeXMLToolDefinitions: true, toolExecutionProfile: 'read-only-child' });
		assert.strictEqual(child.includes('read_skill_resource'), false);
	});
});
