import * as assert from 'assert';
import { anthropicTools, geminiTools, openAITools } from '../../electron-main/llmMessage/sendLLMMessage.impl.js';
import { availableTools, chat_systemMessage } from '../../common/prompt/prompts.js';
import { extractXMLToolsWrapper } from '../../electron-main/llmMessage/extractGrammar.js';
import { isNativeAgentToolFormat, validateAgentSubagentControlParams } from '../../common/agentSubagents.js';


suite('Void selected Skill resource production serialization', () => {
	test('serializes no-marker native Agent authority through every production provider path', () => {
		const authority = isNativeAgentToolFormat('openai-style'); assert.strictEqual(authority, true); assert.strictEqual(isNativeAgentToolFormat(undefined), false);
		const emitted = [openAITools('agent', undefined, 'default-parent', authority)!.map(tool => tool.function.name), anthropicTools('agent', undefined, 'default-parent', authority)!.map(tool => tool.name), geminiTools('agent', undefined, 'default-parent', authority)![0].functionDeclarations!.map(tool => tool.name)];
		for (const names of emitted) for (const name of ['spawn_agent', 'wait_agent', 'interrupt_agent']) assert.ok(names.includes(name));
	});
	test('serializes bounded wait_agent targets through every parent provider path and omits controls for children', () => {
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
		assert.ok(targets); assert.strictEqual(targets.minItems, '1'); assert.strictEqual(targets.maxItems, '4'); assert.strictEqual(targets.items?.type, 'STRING'); assert.strictEqual(targets.items?.maxLength, '256');
		assert.deepStrictEqual(openAIToolset.find(tool => tool.function.name === 'spawn_agent')!.function.parameters, spawnRegistry.schema);
		const anthropicSpawn = anthropicToolset.find(tool => tool.name === 'spawn_agent')!; assert.ok('input_schema' in anthropicSpawn); if ('input_schema' in anthropicSpawn) assert.deepStrictEqual(anthropicSpawn.input_schema, spawnRegistry.schema);
		const geminiAgentType = geminiToolset.find(tool => tool.name === 'spawn_agent')!.parameters?.properties?.agent_type as any; assert.strictEqual(geminiAgentType.type, 'STRING');
		const xml = chat_systemMessage({ workspaceFolders: ['C:\\workspace'], openedURIs: [], activeURI: undefined, persistentTerminalIDs: [], directoryStr: '', chatMode: 'agent', mcpTools: undefined, includeXMLToolDefinitions: true, agentDelegationAllowed: true });
		assert.ok(xml.includes('<targets>')); assert.ok(xml.includes('one to four distinct direct-child ids')); assert.ok(xml.includes('<agent_type>'));
		assert.strictEqual(openAITools('agent', undefined, 'default-parent', false)!.some(tool => tool.function.name === 'spawn_agent'), false);
		assert.strictEqual(anthropicTools('agent', undefined, 'default-parent', false)!.some(tool => tool.name === 'spawn_agent'), false);
		assert.strictEqual(geminiTools('agent', undefined, 'default-parent', false)![0].functionDeclarations!.some(tool => tool.name === 'spawn_agent'), false);
		const ordinaryXml = chat_systemMessage({ workspaceFolders: ['C:\\workspace'], openedURIs: [], activeURI: undefined, persistentTerminalIDs: [], directoryStr: '', chatMode: 'agent', mcpTools: undefined, includeXMLToolDefinitions: true, agentDelegationAllowed: false });
		assert.strictEqual(ordinaryXml.includes('spawn_agent'), false);
		assert.strictEqual(availableTools('agent', undefined, 'read-only-child')!.some(tool => tool.name === 'wait_agent'), false);
	});

	test('normalizes only valid XML wait fields before strict shared validation', () => {
		let tool: any; const wrapper = extractXMLToolsWrapper(() => { }, params => { tool = params.toolCall; }, 'agent', undefined, 'default-parent', true);
		wrapper.newOnFinalMessage({ fullText: '<wait_agent><timeout_ms>1000</timeout_ms><targets>["a","b"]</targets></wait_agent>', fullReasoning: '', anthropicReasoning: null } as any);
		assert.deepStrictEqual(tool.rawParams, { timeout_ms: 1000, targets: ['a', 'b'] }); assert.deepStrictEqual(validateAgentSubagentControlParams('wait_agent', tool.rawParams), { name: 'wait_agent', timeoutMs: 1000, targets: ['a', 'b'] });
		let malformed: any; const malformedWrapper = extractXMLToolsWrapper(() => { }, params => { malformed = params.toolCall; }, 'agent', undefined, 'default-parent', true);
		malformedWrapper.newOnFinalMessage({ fullText: '<wait_agent><timeout_ms>01</timeout_ms><targets>not-json</targets></wait_agent>', fullReasoning: '', anthropicReasoning: null } as any);
		assert.throws(() => validateAgentSubagentControlParams('wait_agent', malformed.rawParams), /wait_agent_invalid_params/);
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
