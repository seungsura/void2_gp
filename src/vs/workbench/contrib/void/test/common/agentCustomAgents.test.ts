import * as assert from 'assert';
import { applyCustomAgentSkillRules, createCustomAgentCatalog, customAgentAdvertisement, CustomAgentPickerRequestOwner, loadCustomAgentPickerDescriptors } from '../../common/agentCustomAgents.js';

const candidate = (scope: 'user' | 'project', uri: string, parsed: unknown, text = ''): any => ({ scope, uri, filename: 'file-name', text, parsed });
const valid = (name = 'researcher'): any => ({ name, description: 'Reads source carefully.', developer_instructions: 'Only inspect.' });

suite('Void custom agents', () => {
	test('strictly admits declared identity without filename repair', () => {
		const catalog = createCustomAgentCatalog([candidate('user', 'file:///u/.codex/agents/arbitrary.toml', valid('researcher'), 'a')]);
		assert.deepStrictEqual(catalog.agents.map(agent => agent.identity), ['researcher']);
	});
	test('rejects unknown keys, write sandbox, mcp, and invalid UTF/parser candidates independently', () => {
		for (const parsed of [{ ...valid(), extra: true }, { ...valid(), sandbox_mode: 'workspace-write' }, { ...valid(), mcp_servers: {} }, { name: 'x' }]) {
			const catalog = createCustomAgentCatalog([candidate('user', `file:///u/${JSON.stringify(parsed)}.toml`, parsed)]);
			assert.strictEqual(catalog.agents.length, 0); assert.strictEqual(catalog.diagnostics.length, 1);
		}
	});
	test('project overrides user while duplicate identities in a scope fail closed', () => {
		const overridden = createCustomAgentCatalog([candidate('user', 'file:///u/a.toml', valid(), 'u'), candidate('project', 'file:///p/a.toml', { ...valid(), description: 'Project.' }, 'p')]);
		assert.strictEqual(overridden.agents.length, 1); assert.strictEqual(overridden.agents[0].provenance.scope, 'project');
		const duplicate = createCustomAgentCatalog([candidate('user', 'file:///u/a.toml', valid(), 'a'), candidate('user', 'file:///u/b.toml', valid(), 'b')]);
		assert.strictEqual(duplicate.agents.length, 0); assert.ok(duplicate.diagnostics.some(diagnostic => diagnostic.code === 'custom_agent_duplicate_identity'));
		const userDuplicateProjectWinner = createCustomAgentCatalog([candidate('user', 'file:///u/a.toml', valid(), 'a'), candidate('user', 'file:///u/b.toml', valid(), 'b'), candidate('project', 'file:///p/a.toml', valid(), 'p')]);
		assert.deepStrictEqual(userDuplicateProjectWinner.agents.map(agent => agent.provenance.scope), ['project']);
		const projectDuplicateUserFallback = createCustomAgentCatalog([candidate('user', 'file:///u/a.toml', valid(), 'u'), candidate('project', 'file:///p/a.toml', valid(), 'a'), candidate('project', 'file:///p/b.toml', valid(), 'b')]);
		assert.deepStrictEqual(projectDuplicateUserFallback.agents.map(agent => agent.provenance.scope), ['user']);
	});
	test('applies only exact typed skill rules in deterministic order', () => {
		assert.deepStrictEqual(applyCustomAgentSkillRules([{ identity: 'one' }, { identity: 'two' }], [{ selector: 'one', enabled: false }, { selector: 'two', enabled: true }]).map(item => item.identity), ['two']);
	});
	test('keeps a deterministic whole-entry bounded role advertisement', () => {
		const catalog = createCustomAgentCatalog(Array.from({ length: 10 }, (_, i) => candidate('user', `file:///u/${i}.toml`, { ...valid(`role${i}`), description: 'x'.repeat(80) }, String(i))));
		const ad = customAgentAdvertisement(catalog, 200); assert.ok(ad.text.length <= 200); assert.ok(ad.omitted > 0); assert.strictEqual(ad.text.includes('role0'), true); assert.strictEqual(ad.text.includes('role9'), false);
	});
	test('builds bounded picker descriptors from the canonical catalog and contains loader failure', async () => {
		const catalog = createCustomAgentCatalog(Array.from({ length: 10 }, (_, i) => candidate('user', `file:///u/${i}.toml`, valid(`role${i}`), String(i))), Array.from({ length: 10 }, (_, i) => ({ code: `diagnostic${i}`, detail: 'x' })));
		const descriptors = await loadCustomAgentPickerDescriptors(async () => catalog); assert.strictEqual(descriptors[0].kind, 'generic'); assert.strictEqual(descriptors.filter(item => item.kind === 'role').length, 10); assert.strictEqual(descriptors.filter(item => item.kind === 'diagnostic').length, 8); assert.ok(descriptors.find(item => item.kind === 'role' && item.catalogRevision === catalog.revision && item.roleRevision));
		assert.deepStrictEqual(await loadCustomAgentPickerDescriptors(async () => { throw new Error('no'); }), [{ kind: 'diagnostic', identity: 'custom-agent-catalog-unavailable', disabled: true }]);
	});
	test('cancels superseded and closed picker requests', () => {
		const owner = new CustomAgentPickerRequestOwner(); const first = owner.begin(); const second = owner.begin(); assert.strictEqual(first.token.isCancellationRequested, true); assert.strictEqual(owner.isCurrent(first.key), false); assert.strictEqual(owner.isCurrent(second.key), true); owner.cancel(); assert.strictEqual(second.token.isCancellationRequested, true); assert.strictEqual(owner.isCurrent(second.key), false);
	});
});
