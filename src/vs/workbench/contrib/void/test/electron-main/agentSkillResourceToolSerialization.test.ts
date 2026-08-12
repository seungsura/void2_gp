import * as assert from 'assert';
import { anthropicTools, geminiTools, openAITools } from '../../electron-main/llmMessage/sendLLMMessage.impl.js';
import { availableTools, chat_systemMessage } from '../../common/prompt/prompts.js';

suite('Void selected Skill resource production serialization', () => {
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
