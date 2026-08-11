import assert from 'assert';
import { AgentInstructionTaskSession, AgentInstructionsConfig, AgentInstructionTurnSnapshot, inheritAgentInstructionTurnSnapshot, projectAgentConfig, resolveAgentInstructions, stableAgentInstructionRevision } from '../../common/agentInstructions.js';

const makeConfig = (developerInstructions = 'developer', ownerProjectRoot = 'file:///root', runCwd = ownerProjectRoot) => projectAgentConfig({ developerInstructions, projectDocMaxBytes: 100 }, undefined, [], ownerProjectRoot, runCwd);
const makeTurn = (text: string, config: AgentInstructionsConfig): AgentInstructionTurnSnapshot => {
	const candidates = [{ uri: 'file:///root/AGENTS.md', outcome: Object.freeze({ status: 'bytes' as const, bytes: new TextEncoder().encode(text) }) }];
	return resolveAgentInstructions(config, candidates, stableAgentInstructionRevision(config, candidates));
};

suite('AGENTS instruction lifecycle', () => {
	test('loads config once per task and reloads two explicit top-level turns with the same identity', async () => {
		let configLoads = 0;
		let turnLoads = 0;
		const loaded = makeConfig();
		const seen: AgentInstructionsConfig[] = [];
		const session = new AgentInstructionTaskSession(async () => { configLoads++; return loaded; }, async config => { turnLoads++; seen.push(config); return makeTurn(`turn-${turnLoads}`, config); });
		await session.beginTopLevelTurn();
		await session.beginTopLevelTurn();
		assert.strictEqual(configLoads, 1);
		assert.strictEqual(turnLoads, 2);
		assert.strictEqual(seen[0], loaded);
		assert.strictEqual(seen[1], loaded);
	});

	test('passes one exact snapshot through provider, tool, retry, and child paths', async () => {
		let turnLoads = 0;
		const session = new AgentInstructionTaskSession(async () => makeConfig(), async config => { turnLoads++; return makeTurn('turn', config); });
		const snapshot = await session.beginTopLevelTurn();
		const provider = (turn: AgentInstructionTurnSnapshot) => turn;
		const tool = (turn: AgentInstructionTurnSnapshot) => turn;
		const retry = (turn: AgentInstructionTurnSnapshot) => turn;
		assert.strictEqual(provider(snapshot), snapshot);
		assert.strictEqual(tool(snapshot), snapshot);
		assert.strictEqual(retry(snapshot), snapshot);
		assert.strictEqual(inheritAgentInstructionTurnSnapshot(snapshot), snapshot);
		assert.strictEqual(inheritAgentInstructionTurnSnapshot(snapshot).revision, snapshot.revision);
		assert.strictEqual(turnLoads, 1);
	});

	test('refreshes mutable AGENTS data only on a new top-level turn', async () => {
		let text = 'first';
		const session = new AgentInstructionTaskSession(async () => makeConfig(), async config => makeTurn(text, config));
		const first = await session.beginTopLevelTurn();
		text = 'second';
		const second = await session.beginTopLevelTurn();
		assert.strictEqual(first.agentsInstructions, 'first');
		assert.strictEqual(second.agentsInstructions, 'second');
		assert.notStrictEqual(first.revision, second.revision);
	});

	test('holds task config roots and values while a new task observes mutable input', async () => {
		let developer = 'one';
		let owner = 'file:///one';
		const createSession = () => new AgentInstructionTaskSession(async () => makeConfig(developer, owner), async config => makeTurn('agents', config));
		const firstTask = createSession();
		const first = await firstTask.beginTopLevelTurn();
		developer = 'two';
		owner = 'file:///two';
		const sameTask = await firstTask.beginTopLevelTurn();
		const nextTask = await createSession().beginTopLevelTurn();
		assert.strictEqual(first.developerInstructions, 'one');
		assert.strictEqual(sameTask.developerInstructions, 'one');
		assert.strictEqual(nextTask.developerInstructions, 'two');
		assert.strictEqual(first.ownerProjectRoot, 'file:///one');
		assert.strictEqual(sameTask.ownerProjectRoot, 'file:///one');
		assert.strictEqual(nextTask.ownerProjectRoot, 'file:///two');
	});

	test('shares concurrent initial config work and keeps a rejected config sticky', async () => {
		let configLoads = 0;
		let turnLoads = 0;
		const concurrent = new AgentInstructionTaskSession(async () => { configLoads++; return makeConfig(); }, async config => { turnLoads++; return makeTurn(`${turnLoads}`, config); });
		const [first, second] = await Promise.all([concurrent.beginTopLevelTurn(), concurrent.beginTopLevelTurn()]);
		let rejectedLoads = 0;
		const rejected = new AgentInstructionTaskSession(async () => { rejectedLoads++; throw new Error('config failed'); }, async config => makeTurn('never', config));
		await assert.rejects(() => rejected.beginTopLevelTurn(), /config failed/);
		await assert.rejects(() => rejected.beginTopLevelTurn(), /config failed/);
		assert.strictEqual(configLoads, 1);
		assert.strictEqual(turnLoads, 2);
		assert.notStrictEqual(first, second);
		assert.strictEqual(rejectedLoads, 1);
	});

	test('deeply freezes config, snapshots, provenance arrays, and provenance items', async () => {
		const session = new AgentInstructionTaskSession(async () => makeConfig(), async config => makeTurn('agents', config));
		const snapshot = await session.beginTopLevelTurn();
		assert.strictEqual(Object.isFrozen(snapshot), true);
		assert.strictEqual(Object.isFrozen(snapshot.config), true);
		assert.strictEqual(Object.isFrozen(snapshot.config.configSources), true);
		assert.strictEqual(Object.isFrozen(snapshot.provenance), true);
		assert.strictEqual(Object.isFrozen(snapshot.provenance[0]), true);
	});
});
