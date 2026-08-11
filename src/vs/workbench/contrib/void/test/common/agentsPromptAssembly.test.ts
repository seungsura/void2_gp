import assert from 'assert';
import { assembleAgentInstructionText, projectAgentConfig, resolveAgentInstructions, routeAgentInstructionAuthority } from '../../common/agentInstructions.js';

const snapshot = (developerInstructions: string, agentsInstructions: string) => {
	const config = projectAgentConfig({ developerInstructions, projectDocMaxBytes: 100 });
	const candidates = agentsInstructions ? [{ uri: 'file:///project/AGENTS.md', outcome: Object.freeze({ status: 'bytes' as const, bytes: new TextEncoder().encode(agentsInstructions) }) }] : [];
	return resolveAgentInstructions(config, candidates, 'turn');
};

suite('AGENTS prompt assembly', () => {
	test('assembles developer instructions before AGENTS content without markers', () => {
		assert.strictEqual(assembleAgentInstructionText(snapshot('developer', 'agents')), 'developer\n\nagents');
		assert.strictEqual(assembleAgentInstructionText(snapshot('developer', '')), 'developer');
		assert.strictEqual(assembleAgentInstructionText(snapshot('', 'agents')), 'agents');
		assert.strictEqual(assembleAgentInstructionText(snapshot('', '')), '');
		assert.strictEqual(assembleAgentInstructionText(snapshot('developer', 'agents')).includes('file:///'), false);
	});

	test('routes exact authority plans and deeply freezes route messages', () => {
		const developer = routeAgentInstructionAuthority('instructions', 'generated', 'developer-role');
		const system = routeAgentInstructionAuthority('instructions', 'generated', 'system-role');
		const separated = routeAgentInstructionAuthority('instructions', 'generated', 'separated');
		const fallback = routeAgentInstructionAuthority('instructions', 'generated', false);
		assert.deepStrictEqual(developer.roleMessages, [{ role: 'developer', content: 'instructions' }, { role: 'developer', content: 'generated' }]);
		assert.deepStrictEqual(system.roleMessages, [{ role: 'system', content: 'instructions' }, { role: 'system', content: 'generated' }]);
		assert.deepStrictEqual(separated, { roleMessages: [], separateSystemMessage: 'instructions\n\ngenerated' });
		assert.deepStrictEqual(fallback, { roleMessages: [], userFallbackSystemMessage: 'instructions\n\ngenerated' });
		assert.strictEqual(Object.isFrozen(developer.roleMessages), true);
		assert.strictEqual(Object.isFrozen(developer.roleMessages[0]), true);
	});

	test('preserves generated-only and instruction-only authority behavior', () => {
		assert.deepStrictEqual(routeAgentInstructionAuthority('', 'generated', 'developer-role').roleMessages, [{ role: 'developer', content: 'generated' }]);
		assert.deepStrictEqual(routeAgentInstructionAuthority('instructions', '', 'system-role').roleMessages, [{ role: 'system', content: 'instructions' }]);
		assert.strictEqual(routeAgentInstructionAuthority('', '', 'separated').separateSystemMessage, undefined);
		assert.strictEqual(routeAgentInstructionAuthority('', '', false).userFallbackSystemMessage, undefined);
	});

	test('uses only the supplied snapshot and does not synthesize legacy instruction strings', () => {
		const approved = assembleAgentInstructionText(snapshot('approved developer', 'approved agents'));
		const legacyVoidRules = '.voidrules';
		const legacyGlobal = 'fake global AI Instructions';
		const legacyDisable = 'Disable system message';
		assert.strictEqual(approved.includes(legacyVoidRules), false);
		assert.strictEqual(approved.includes(legacyGlobal), false);
		assert.strictEqual(approved.includes(legacyDisable), false);
	});

	test('uses the developer-role plan required for gpt-4.1 logical wire ordering', () => {
		const route = routeAgentInstructionAuthority(assembleAgentInstructionText(snapshot('developer instruction', 'AGENTS instruction')), 'generated internal system', 'developer-role');
		assert.deepStrictEqual(route.roleMessages, [{ role: 'developer', content: 'developer instruction\n\nAGENTS instruction' }, { role: 'developer', content: 'generated internal system' }]);
	});
});
