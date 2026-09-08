import * as assert from 'assert';
import { admitSkillResourceContext, assembleProtectedAgentAuthority, createAgentRuntimeTurnSnapshot, createSkillCatalog, readSkillResourceToolSchema, skillAdvertisement, validateReadSkillResourceToolParams } from '../../common/agentSkills.js';
import { projectAgentConfig, resolveAgentInstructions, stableAgentInstructionRevision } from '../../common/agentInstructions.js';
import { readOnlyChildToolNames } from '../../common/agentSubagents.js';
import { availableTools } from '../../common/prompt/prompts.js';

const encoder = new TextEncoder();
const instructionSnapshot = () => {
	const config = projectAgentConfig({ developerInstructions: 'developer' }, undefined, [{ uri: 'file:///home/.codex/config.toml', scope: 'user', status: 'loaded', projectedKeys: ['developer_instructions'] }], 'file:///workspace', 'file:///workspace');
	return resolveAgentInstructions(config, [], stableAgentInstructionRevision(config, []));
};

suite('Void selected Skill resource application tool', () => {
	test('publishes one flat closed tool only to the parent Agent registry and reserves its MCP collision', () => {
		const collision = { name: 'read_skill_resource', description: 'colliding MCP tool', params: {}, mcpServerName: 'collision' };
		const remote = { name: 'remote_read', description: 'remote', params: {}, mcpServerName: 'remote' };
		const parent = availableTools('agent', [collision, remote], 'default-parent')!;
		assert.strictEqual(parent.filter(tool => tool.name === 'read_skill_resource').length, 1);
		assert.strictEqual(parent.find(tool => tool.name === 'read_skill_resource')!.mcpServerName, undefined);
		assert.ok(parent.some(tool => tool.name === 'remote_read'));
		const childTools = availableTools('agent', [collision, remote], 'read-only-child')!.map(tool => tool.name);
		assert.deepStrictEqual(childTools, [...readOnlyChildToolNames, 'wait_agent', 'list_agents', 'send_message', 'interrupt_agent']);
		for (const forbidden of ['read_skill_resource', 'remote_read']) assert.strictEqual(childTools.includes(forbidden), false);
		for (const mode of ['normal', 'gather', null] as const) assert.strictEqual(availableTools(mode, [collision, remote])?.some(tool => tool.name === 'read_skill_resource') ?? false, false);
	});

	test('uses the exact two-string compatibility schema without composition', () => {
		assert.deepStrictEqual(readSkillResourceToolSchema, {
			type: 'object', additionalProperties: false, required: ['skill', 'resource_path'], properties: {
				skill: { type: 'string', description: 'The exact identity of a Skill selected in this top-level turn.' },
				resource_path: { type: 'string', description: 'A relative path below that selected Skill root. Absolute paths and traversal are forbidden.' },
			},
		});
		const visit = (value: unknown) => {
			if (!value || typeof value !== 'object') return;
			for (const [key, child] of Object.entries(value)) { assert.strictEqual(['oneOf', 'anyOf', 'allOf', 'if', 'then', 'else', 'const', 'minLength'].includes(key), false); visit(child); }
		};
		visit(availableTools('agent', undefined)!.find(tool => tool.name === 'read_skill_resource')!.schema);
	});

	test('validates exact non-empty identity and confined relative path before dispatch', () => {
		assert.deepStrictEqual(validateReadSkillResourceToolParams({ skill: 'plugin:demo', resource_path: 'references/guide.md' }), { skill: 'plugin:demo', resourcePath: 'references/guide.md' });
		for (const raw of [
			{}, { skill: 'demo' }, { resource_path: 'a' }, { skill: '', resource_path: 'a' }, { skill: ' ', resource_path: 'a' },
			{ skill: 'demo', resource_path: '' }, { skill: 'demo', resource_path: '../a' }, { skill: 'demo', resource_path: '/a' },
			{ skill: 'demo', resource_path: 'C:/a' }, { skill: 'demo', resource_path: 'C%3A/a' }, { skill: 'demo', resource_path: 'file%3Aa' },
			{ skill: 'demo', resource_path: 'a\\b' }, { skill: 'demo', resource_path: 'a%2fb' }, { skill: 'demo', resource_path: 'a%252fb' },
			{ skill: 'demo', resource_path: 'a?query' }, { skill: 'demo', resource_path: 'a%3Fquery' }, { skill: 'demo', resource_path: 'a#fragment' }, { skill: 'demo', resource_path: 'a%23fragment' },
			{ skill: 'demo', resource_path: 'a', extra: true },
		]) assert.throws(() => validateReadSkillResourceToolParams(raw));
	});

	test('keeps exact selected bodies and exposes only exact identities for hidden and catalog-omitted selections', () => {
		const pluginBody = '---\nname: demo\ndescription: plugin demo description\n---\nUse references/guide.md exactly.\n';
		const omittedBody = '---\nname: omitted\ndescription: omitted description\n---\nomitted body\n';
		const catalog = createSkillCatalog([
			{ source: 'plugin', pluginName: 'plugin-one', rank: 0, root: 'file:///plugins/one/skills', skillRoot: 'file:///plugins/one/skills/demo', directoryName: 'demo', bytes: encoder.encode(pluginBody), openaiMetadata: encoder.encode('policy:\n  allow_implicit_invocation: false') },
			{ source: 'user', rank: 1, root: 'file:///skills', skillRoot: 'file:///skills/omitted', directoryName: 'omitted', bytes: encoder.encode(omittedBody) },
		]);
		const snapshot = createAgentRuntimeTurnSnapshot(instructionSnapshot(), catalog, skillAdvertisement(catalog, 20), catalog.skills.map(skill => ({ identity: skill.identity, skillRoot: skill.provenance.skillRoot, bodyRevision: skill.bodyRevision, body: skill.name === 'demo' ? pluginBody : omittedBody })), { hasModel: true, providerName: 'openAI', modelName: 'gpt-4.1', contextWindow: 20, reservedOutputTokens: 0, modelSelectionOptions: {}, selectedModelOverrides: {} }, true);
		const authority = assembleProtectedAgentAuthority(snapshot);
		const childAuthority = assembleProtectedAgentAuthority(snapshot, false);
		assert.strictEqual(snapshot.advertisement.text, ''); assert.strictEqual(snapshot.advertisement.omitted, 1);
		assert.strictEqual(authority.split(pluginBody).length - 1, 1); assert.strictEqual(authority.split(omittedBody).length - 1, 1);
		assert.ok(authority.includes('Selected Skill identities for read_skill_resource (use one exact value):\nplugin-one:demo\nomitted'));
		assert.strictEqual(childAuthority.split(pluginBody).length - 1, 1); assert.strictEqual(childAuthority.split(omittedBody).length - 1, 1); assert.strictEqual(childAuthority.includes('read_skill_resource'), false);
		assert.strictEqual(authority.includes('file:///'), false); assert.strictEqual(authority.includes('<skill>'), false); assert.strictEqual(authority.includes('<path>'), false);
		assert.strictEqual(JSON.stringify(availableTools('agent', undefined)).includes('RESOURCE-SECRET'), false);
		assert.strictEqual(JSON.stringify(snapshot).includes('RESOURCE-SECRET'), false);
	});

	test('admits an exact resource atomically or returns the dedicated context failure', () => {
		assert.strictEqual(admitSkillResourceContext('exact\ntext', 3), 'exact\ntext');
		assert.throws(() => admitSkillResourceContext('12345', 1), /skill_resource_context_admission_failed/);
		assert.throws(() => admitSkillResourceContext('x', 0), /skill_resource_context_admission_failed/);
	});
});
