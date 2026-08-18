import assert from 'assert';
import { parse } from 'smol-toml';
import { URI } from '../../../../../base/common/uri.js';
import { DEFAULT_AGENT_DELEGATION_LIMITS, DEFAULT_PROJECT_DOC_MAX_BYTES, agentConfigSourceDescriptors, agentInstructionChain, appendAgentInstructionDeveloperInstructions, parseAgentConfigSource, projectAgentConfig, resolveAgentInstructions, reviveAgentInstructionTurnSnapshot, stableAgentInstructionRevision } from '../../common/agentInstructions.js';

const encode = (value: string) => new TextEncoder().encode(value);
const source = (uri: string, value: string) => ({ uri, outcome: Object.freeze({ status: 'bytes' as const, bytes: encode(value) }) });
const missing = (uri: string) => ({ uri, outcome: Object.freeze({ status: 'missing' as const }) });
const unreadable = (uri: string) => ({ uri, outcome: Object.freeze({ status: 'unreadable' as const }) });
const config = (max = DEFAULT_PROJECT_DOC_MAX_BYTES) => projectAgentConfig({ developerInstructions: 'developer', projectDocMaxBytes: max });

suite('AGENTS instruction resolver', () => {
	test('discovers the exact root-to-CWD AGENTS.md chain only', () => {
		const root = URI.file('C:/project');
		const chain = agentInstructionChain(root, URI.file('C:/project/nested/deep'));
		assert.deepStrictEqual(chain.map(uri => uri.path), ['/C:/project/AGENTS.md', '/C:/project/nested/AGENTS.md', '/C:/project/nested/deep/AGENTS.md']);
		assert.deepStrictEqual(agentInstructionChain(root, URI.file('C:/outside')), []);
		const unsupported = ['AGENTS.override.md', 'AGENTS.local.md', 'AGENTS.instructions.md', 'AGENT.md', 'AGENT.instructions.md', 'instructions.md', 'CLAUDE.md', 'GEMINI.md', '.github/copilot-instructions.md', '.cursor/rules/project.mdc', '.cursorrules', '.voidrules'];
		assert.strictEqual(unsupported.some(name => chain.some(uri => uri.path.endsWith(`/${name}`))), false);
	});

	test('describes only the eligible config URIs in user-then-project order', () => {
		const userHome = URI.file('C:/home');
		const owner = URI.file('C:/project');
		const userOnly = agentConfigSourceDescriptors(userHome, undefined, true);
		const untrusted = agentConfigSourceDescriptors(userHome, owner, false);
		const trusted = agentConfigSourceDescriptors(userHome, owner, true);
		assert.deepStrictEqual(userOnly.map(item => ({ scope: item.scope, uri: item.uri.toString() })), [{ scope: 'user', uri: URI.joinPath(userHome, '.codex', 'config.toml').toString() }]);
		assert.deepStrictEqual(untrusted.map(item => item.scope), ['user']);
		assert.deepStrictEqual(trusted.map(item => ({ scope: item.scope, uri: item.uri.toString() })), [{ scope: 'user', uri: URI.joinPath(userHome, '.codex', 'config.toml').toString() }, { scope: 'project', uri: URI.joinPath(owner, '.codex', 'config.toml').toString() }]);
		assert.strictEqual(Object.isFrozen(trusted), true);
		assert.strictEqual(Object.isFrozen(trusted[0]), true);
	});

	test('keeps exact source-local provenance while emitting marker-free content', () => {
		const candidates = [missing('file:///workspace/missing/AGENTS.md'), unreadable('file:///workspace/unreadable/AGENTS.md'), source('file:///workspace/empty/AGENTS.md', ''), source('file:///workspace/whitespace/AGENTS.md', ' \n'), { uri: 'file:///workspace/invalid/AGENTS.md', outcome: Object.freeze({ status: 'bytes' as const, bytes: new Uint8Array([0xff]) }) }, source('file:///workspace/root/AGENTS.md', 'root'), source('file:///workspace/nested/AGENTS.md', 'nested')];
		const snapshot = resolveAgentInstructions(config(100), candidates, 'revision');
		assert.strictEqual(snapshot.agentsInstructions, 'root\n\nnested');
		assert.deepStrictEqual(snapshot.provenance, [
			{ uri: 'file:///workspace/missing/AGENTS.md', rawBytes: 0, admittedBytes: 0, skipReason: 'missing', truncated: false },
			{ uri: 'file:///workspace/unreadable/AGENTS.md', rawBytes: 0, admittedBytes: 0, skipReason: 'unreadable', truncated: false },
			{ uri: 'file:///workspace/empty/AGENTS.md', rawBytes: 0, admittedBytes: 0, skipReason: 'empty', truncated: false },
			{ uri: 'file:///workspace/whitespace/AGENTS.md', rawBytes: 2, admittedBytes: 0, skipReason: 'whitespace', truncated: false },
			{ uri: 'file:///workspace/invalid/AGENTS.md', rawBytes: 1, admittedBytes: 0, skipReason: 'invalid_utf8', truncated: false },
			{ uri: 'file:///workspace/root/AGENTS.md', rawBytes: 4, admittedBytes: 4, truncated: false },
			{ uri: 'file:///workspace/nested/AGENTS.md', rawBytes: 6, admittedBytes: 6, truncated: false },
		]);
		assert.strictEqual(/file:\/\/\/|AGENTS\.md|user|project|rawBytes|admittedBytes|skipReason|truncated/.test(snapshot.agentsInstructions), false);
	});

	test('enforces exact byte budgets, separators, UTF-8 boundaries, and zero opt-out', () => {
		const exact = resolveAgentInstructions(config(32768), [source('exact', 'a'.repeat(32768))], 'exact');
		const over = resolveAgentInstructions(config(32768), [source('over', 'a'.repeat(32769))], 'over');
		const combined = resolveAgentInstructions(config(7), [source('one', 'abc'), source('two', 'def')], 'combined');
		const multibyte = resolveAgentInstructions(config(5), [source('multibyte', '\uCC55abc')], 'multibyte');
		const zero = resolveAgentInstructions(config(0), [source('zero', 'content')], 'zero');
		assert.strictEqual(exact.provenance[0].admittedBytes, 32768);
		assert.strictEqual(exact.provenance[0].rawBytes, 32768);
		assert.strictEqual(exact.provenance[0].truncated, false);
		assert.strictEqual(new TextEncoder().encode(over.agentsInstructions).byteLength, 32768);
		assert.strictEqual(over.provenance[0].rawBytes, 32769);
		assert.strictEqual(over.provenance[0].admittedBytes, 32768);
		assert.strictEqual(over.provenance[0].truncated, true);
		assert.strictEqual(combined.agentsInstructions, 'abc\n\nde');
		assert.strictEqual(combined.provenance[1].admittedBytes, 2);
		const separatorOnly = resolveAgentInstructions(config(5), [source('first', 'abc'), source('second', 'def')], 'separator-only');
		assert.strictEqual(separatorOnly.agentsInstructions, 'abc');
		assert.deepStrictEqual(separatorOnly.provenance[1], { uri: 'second', rawBytes: 3, admittedBytes: 0, skipReason: 'budget', truncated: true });
		assert.strictEqual(multibyte.agentsInstructions, '\uCC55ab');
		assert.strictEqual(multibyte.provenance[0].rawBytes, 6);
		assert.strictEqual(multibyte.provenance[0].admittedBytes, 5);
		assert.deepStrictEqual(zero.provenance[0], { uri: 'zero', rawBytes: 7, admittedBytes: 0, skipReason: 'budget', truncated: true });
	});

	test('parses actual TOML allowlist and reports source-local parse states', () => {
		const valid = parseAgentConfigSource('user', 'user', source('ignored', 'developer_instructions = """first\nsecond"""\nproject_doc_max_bytes = 12').outcome, parse);
		const literal = parseAgentConfigSource('project', 'project', source('ignored', "developer_instructions = '''literal\ntext'''\nproject_doc_max_bytes = 9").outcome, parse);
		const wrongRootTypes = parseAgentConfigSource('user', 'wrong-root-types', source('ignored', 'developer_instructions = 2\nproject_doc_max_bytes = -1').outcome, parse);
		const unsafeRootMax = parseAgentConfigSource('user', 'unsafe-root-max', source('ignored', 'project_doc_max_bytes = 9007199254740992').outcome, parse);
		const ignored = parseAgentConfigSource('user', 'ignored', source('ignored', '[complex]\na = [1, 2]\nquoted.key = "ignored"\ndeveloper_instructions = 2\nproject_doc_max_bytes = -1').outcome, parse);
		const invalidUtf8 = parseAgentConfigSource('user', 'utf8', { status: 'bytes', bytes: new Uint8Array([0xff]) }, parse);
		const malformed = parseAgentConfigSource('user', 'malformed', source('ignored', 'developer_instructions = [').outcome, parse);
		assert.deepStrictEqual(valid.projected, { developerInstructions: 'first\nsecond', projectDocMaxBytes: 12 });
		assert.deepStrictEqual(literal.projected, { developerInstructions: 'literal\ntext', projectDocMaxBytes: 9 });
		assert.deepStrictEqual(wrongRootTypes.projected, { developerInstructions: undefined, projectDocMaxBytes: undefined });
		assert.deepStrictEqual(wrongRootTypes.provenance, { uri: 'wrong-root-types', scope: 'user', status: 'loaded', projectedKeys: [] });
		assert.strictEqual(unsafeRootMax.projected, undefined);
		assert.deepStrictEqual(unsafeRootMax.provenance, { uri: 'unsafe-root-max', scope: 'user', status: 'malformed', projectedKeys: [] });
		assert.deepStrictEqual(ignored.projected, { developerInstructions: undefined, projectDocMaxBytes: undefined });
		assert.deepStrictEqual(ignored.provenance, { uri: 'ignored', scope: 'user', status: 'loaded', projectedKeys: [] });
		assert.strictEqual(parseAgentConfigSource('user', 'missing', { status: 'missing' }, parse).provenance.status, 'missing');
		assert.strictEqual(parseAgentConfigSource('user', 'unreadable', { status: 'unreadable' }, parse).provenance.status, 'unreadable');
		assert.strictEqual(invalidUtf8.provenance.status, 'invalid_utf8');
		assert.strictEqual(malformed.provenance.status, 'malformed');
		assert.strictEqual(malformed.projected, undefined);
	});

	test('applies per-key config precedence and preserves source provenance', () => {
		const user = parseAgentConfigSource('user', 'user', source('user', 'developer_instructions = "user"\nproject_doc_max_bytes = 5').outcome, parse);
		const projectDeveloper = parseAgentConfigSource('project', 'project-dev', source('project-dev', 'developer_instructions = "project"').outcome, parse);
		const projectMax = parseAgentConfigSource('project', 'project-max', source('project-max', 'project_doc_max_bytes = 7').outcome, parse);
		const both = parseAgentConfigSource('project', 'both', source('both', 'developer_instructions = "project"\nproject_doc_max_bytes = 7').outcome, parse);
		const developerOnly = projectAgentConfig(user.projected, projectDeveloper.projected, [user.provenance, projectDeveloper.provenance]);
		const maxOnly = projectAgentConfig(user.projected, projectMax.projected, [user.provenance, projectMax.provenance]);
		const overrides = projectAgentConfig(user.projected, both.projected, [user.provenance, both.provenance]);
		const defaults = projectAgentConfig(undefined, undefined);
		assert.deepStrictEqual([developerOnly.developerInstructions, developerOnly.projectDocMaxBytes, developerOnly.developerInstructionsSource, developerOnly.projectDocMaxBytesSource], ['project', 5, 'project', 'user']);
		assert.deepStrictEqual([maxOnly.developerInstructions, maxOnly.projectDocMaxBytes, maxOnly.developerInstructionsSource, maxOnly.projectDocMaxBytesSource], ['user', 7, 'user', 'project']);
		assert.deepStrictEqual([overrides.developerInstructions, overrides.projectDocMaxBytes, overrides.developerInstructionsSource, overrides.projectDocMaxBytesSource], ['project', 7, 'project', 'project']);
		assert.deepStrictEqual([defaults.developerInstructions, defaults.projectDocMaxBytes, defaults.developerInstructionsSource, defaults.projectDocMaxBytesSource], ['', DEFAULT_PROJECT_DOC_MAX_BYTES, 'default', 'default']);
		assert.deepStrictEqual(overrides.configSources.map(item => [item.uri, item.status, item.projectedKeys]), [['user', 'loaded', ['developer_instructions', 'project_doc_max_bytes']], ['both', 'loaded', ['developer_instructions', 'project_doc_max_bytes']]]);
	});

	test('resolves bounded user and trusted-project Agent delegation limits per scalar', () => {
		const user = parseAgentConfigSource('user', 'user', source('user', '[agents]\nmax_accepted_children = 6\nmax_concurrent_threads_per_session = 4\nmax_depth = 2').outcome, parse);
		const project = parseAgentConfigSource('project', 'project', source('project', '[agents]\nmax_accepted_children = 3\nmax_depth = 1').outcome, parse);
		const defaults = projectAgentConfig(undefined, undefined);
		const userOnly = projectAgentConfig(user.projected, undefined, [user.provenance]);
		const merged = projectAgentConfig(user.projected, project.projected, [user.provenance, project.provenance]);
		assert.deepStrictEqual(defaults.agentDelegationLimits, DEFAULT_AGENT_DELEGATION_LIMITS);
		assert.deepStrictEqual(defaults.agentDelegationLimitsSource, { maxAcceptedChildren: 'default', maxConcurrentThreadsPerSession: 'default', maxDepth: 'default' });
		assert.deepStrictEqual(userOnly.agentDelegationLimits, { maxAcceptedChildren: 6, maxConcurrentThreadsPerSession: 4, maxDepth: 2 });
		assert.deepStrictEqual(merged.agentDelegationLimits, { maxAcceptedChildren: 3, maxConcurrentThreadsPerSession: 3, maxDepth: 1 });
		assert.deepStrictEqual(merged.agentDelegationLimitsSource, { maxAcceptedChildren: 'project', maxConcurrentThreadsPerSession: 'user', maxDepth: 'project' });
		assert.deepStrictEqual(merged.agentDelegationLimitDiagnostics, [{ source: 'user', reason: 'max_concurrent_threads_per_session_clamped', code: 'agent_delegation_limits_invalid' }]);
		assert.deepStrictEqual(merged.configSources.map(item => item.projectedKeys), [['agents', 'agents.max_accepted_children', 'agents.max_concurrent_threads_per_session', 'agents.max_depth'], ['agents', 'agents.max_accepted_children', 'agents.max_depth']]);
		assert.strictEqual(Object.isFrozen(merged.agentDelegationLimits), true);
	});

	test('rejects an over-concurrent value in the same Agent table instead of silently clamping it', () => {
		const sameTable = parseAgentConfigSource('user', 'user', source('user', '[agents]\nmax_accepted_children = 2\nmax_concurrent_threads_per_session = 4').outcome, parse);
		const resolved = projectAgentConfig(sameTable.projected, undefined, [sameTable.provenance]);
		assert.strictEqual(sameTable.projected?.agentMaxConcurrentThreadsPerSession, undefined);
		assert.deepStrictEqual(sameTable.projected?.agentDelegationLimitDiagnostics, [{ source: 'user', reason: 'max_concurrent_threads_per_session_exceeds_accepted', code: 'agent_delegation_limits_invalid' }]);
		assert.deepStrictEqual(sameTable.provenance.projectedKeys, ['agents', 'agents.max_accepted_children']);
		assert.deepStrictEqual(resolved.agentDelegationLimits, { maxAcceptedChildren: 2, maxConcurrentThreadsPerSession: 2, maxDepth: 1 });
	});

	test('benignly clamps default concurrency for a project-only accepted-child override and revives it', () => {
		const user = parseAgentConfigSource('user', 'file:///home/.codex/config.toml', { status: 'missing' }, parse);
		const project = parseAgentConfigSource('project', 'file:///workspace/.codex/config.toml', source('project', '[agents]\nmax_accepted_children = 1').outcome, parse);
		const config = projectAgentConfig(undefined, project.projected, [user.provenance, project.provenance], 'file:///workspace', 'file:///workspace');
		const snapshot = resolveAgentInstructions(config, [], stableAgentInstructionRevision(config, []));
		assert.deepStrictEqual(config.agentDelegationLimits, { maxAcceptedChildren: 1, maxConcurrentThreadsPerSession: 1, maxDepth: 1 });
		assert.deepStrictEqual(config.agentDelegationLimitsSource, { maxAcceptedChildren: 'project', maxConcurrentThreadsPerSession: 'default', maxDepth: 'default' });
		assert.deepStrictEqual(config.agentDelegationLimitDiagnostics, []);
		assert.deepStrictEqual(reviveAgentInstructionTurnSnapshot(JSON.parse(JSON.stringify(snapshot))), snapshot);
	});

	test('keeps Agent limit diagnostics bounded and falls back safely for invalid agent tables', () => {
		const invalid = parseAgentConfigSource('user', 'user', source('user', '[agents]\nmax_accepted_children = 0\nmax_concurrent_threads_per_session = 5\nmax_depth = 3\nmax_threads = 1\nunknown_a = 1\nunknown_b = 2\nunknown_c = 3\nunknown_d = 4\nunknown_e = 5\nunknown_f = 6\nunknown_g = 7').outcome, parse);
		const nonObject = parseAgentConfigSource('project', 'project', source('project', 'agents = 2').outcome, parse);
		const resolved = projectAgentConfig(invalid.projected, nonObject.projected, [invalid.provenance, nonObject.provenance]);
		assert.deepStrictEqual(resolved.agentDelegationLimits, DEFAULT_AGENT_DELEGATION_LIMITS);
		assert.strictEqual(invalid.projected?.agentDelegationLimitDiagnostics?.length, 8);
		assert.deepStrictEqual(invalid.projected?.agentDelegationLimitDiagnostics?.slice(0, 4).map(item => item.reason), ['unknown_key', 'unknown_key', 'unknown_key', 'unknown_key']);
		assert.deepStrictEqual(nonObject.projected?.agentDelegationLimitDiagnostics, [{ source: 'project', reason: 'agents_not_object', code: 'agent_delegation_limits_invalid' }]);
		assert.strictEqual(resolved.agentDelegationLimitDiagnostics.length, 8);
		assert.deepStrictEqual(resolved.configSources.map(item => item.projectedKeys), [['agents'], ['agents']]);
	});

	test('uses stable revisions for all snapshot inputs and deeply freezes exposed records', () => {
		const parsed = parseAgentConfigSource('user', 'user', source('user', 'developer_instructions = "developer"').outcome, parse);
		const c = projectAgentConfig(parsed.projected, undefined, [parsed.provenance], 'file:///workspace', 'file:///workspace');
		const candidates = [source('one', 'one')];
		const snapshot = resolveAgentInstructions(c, candidates, stableAgentInstructionRevision(c, candidates));
		assert.strictEqual(stableAgentInstructionRevision(c, candidates), snapshot.revision);
		assert.notStrictEqual(stableAgentInstructionRevision(c, [source('one', 'two')]), snapshot.revision);
		assert.notStrictEqual(stableAgentInstructionRevision(c, [missing('one')]), stableAgentInstructionRevision(c, [unreadable('one')]));
		assert.notStrictEqual(stableAgentInstructionRevision(projectAgentConfig({ developerInstructions: 'other' }, undefined, [parsed.provenance], c.ownerProjectRoot, c.runCwd), candidates), snapshot.revision);
		const otherProvenance = parseAgentConfigSource('user', 'other-user', source('other-user', 'developer_instructions = "developer"').outcome, parse);
		assert.notStrictEqual(stableAgentInstructionRevision(projectAgentConfig(otherProvenance.projected, undefined, [otherProvenance.provenance], c.ownerProjectRoot, c.runCwd), candidates), snapshot.revision);
		const missingProvenance = parseAgentConfigSource('user', 'user', { status: 'missing' }, parse);
		assert.notStrictEqual(stableAgentInstructionRevision(projectAgentConfig(undefined, undefined, [missingProvenance.provenance], c.ownerProjectRoot, c.runCwd), candidates), snapshot.revision);
		assert.notStrictEqual(stableAgentInstructionRevision(projectAgentConfig(parsed.projected, undefined, [parsed.provenance], 'file:///other-root', c.runCwd), candidates), snapshot.revision);
		assert.notStrictEqual(stableAgentInstructionRevision(projectAgentConfig(parsed.projected, undefined, [parsed.provenance], c.ownerProjectRoot, 'file:///other-cwd'), candidates), snapshot.revision);
		assert.notStrictEqual(stableAgentInstructionRevision(projectAgentConfig(parseAgentConfigSource('user', 'user', source('user', '[agents]\nmax_accepted_children = 2').outcome, parse).projected, undefined, [parsed.provenance], c.ownerProjectRoot, c.runCwd), candidates), snapshot.revision);
		assert.strictEqual(Object.isFrozen(c), true);
		assert.strictEqual(Object.isFrozen(c.configSources), true);
		assert.strictEqual(Object.isFrozen(c.configSources[0]), true);
		assert.strictEqual(Object.isFrozen(c.configSources[0].projectedKeys), true);
		assert.strictEqual(Object.isFrozen(snapshot), true);
		assert.strictEqual(snapshot.config, c);
		assert.strictEqual(Object.isFrozen(snapshot.config), true);
		assert.strictEqual(Object.isFrozen(snapshot.provenance), true);
		assert.strictEqual(Object.isFrozen(snapshot.provenance[0]), true);
	});

	test('derives an immutable additive custom-agent authority without losing same-turn AGENTS provenance', () => {
		const roleConfig = projectAgentConfig(
			{ developerInstructions: 'developer' },
			undefined,
			[{ uri: 'file:///home/.codex/config.toml', scope: 'user', status: 'loaded', projectedKeys: ['developer_instructions'] }],
		);
		const base = resolveAgentInstructions(roleConfig, [source('file:///workspace/AGENTS.md', 'same-turn agents')], 'base-revision');
		const derived = appendAgentInstructionDeveloperInstructions(base, 'role developer');
		assert.strictEqual(derived.developerInstructions, 'developer\n\nrole developer');
		assert.strictEqual(derived.config.developerInstructions, derived.developerInstructions);
		assert.strictEqual(derived.agentsInstructions, base.agentsInstructions);
		assert.deepStrictEqual(derived.provenance, base.provenance);
		assert.notStrictEqual(derived.revision, base.revision);
		assert.strictEqual(Object.isFrozen(derived), true);
		assert.strictEqual(Object.isFrozen(derived.config), true);
		assert.strictEqual(reviveAgentInstructionTurnSnapshot(JSON.parse(JSON.stringify(derived)))?.developerInstructions, derived.developerInstructions);
	});

	test('revives a persisted runtime snapshot and rejects corrupt invariants', () => {
		const user = parseAgentConfigSource('user', 'file:///home/.codex/config.toml', source('ignored', 'developer_instructions = "user developer"\nproject_doc_max_bytes = 16').outcome, parse);
		const config = projectAgentConfig(user.projected, undefined, [user.provenance], 'file:///workspace', 'file:///workspace');
		const candidates = [source('file:///workspace/AGENTS.md', 'root agents')];
		const snapshot = resolveAgentInstructions(config, candidates, stableAgentInstructionRevision(config, candidates));
		const persisted = JSON.parse(JSON.stringify(snapshot));
		const revive = (mutate: (raw: ReturnType<typeof JSON.parse>) => void) => { const raw = JSON.parse(JSON.stringify(snapshot)); mutate(raw); return reviveAgentInstructionTurnSnapshot(raw); };
		const revived = reviveAgentInstructionTurnSnapshot(persisted);
		assert.deepStrictEqual(revived, snapshot);
		assert.notStrictEqual(revived, persisted);
		assert.notStrictEqual(revived!.config, persisted.config);
		assert.notStrictEqual(revived!.provenance, persisted.provenance);
		assert.strictEqual(Object.isFrozen(revived!), true);
		assert.strictEqual(Object.isFrozen(revived!.config), true);
		assert.strictEqual(Object.isFrozen(revived!.config.configSources), true);
		assert.strictEqual(Object.isFrozen(revived!.config.configSources[0]), true);
		assert.strictEqual(Object.isFrozen(revived!.config.configSources[0].projectedKeys), true);
		assert.strictEqual(Object.isFrozen(revived!.provenance), true);
		assert.strictEqual(Object.isFrozen(revived!.provenance[0]), true);
		assert.strictEqual(revive(raw => raw.revision = ''), undefined);
		assert.strictEqual(revive(raw => raw.provenance[0].uri = 'not-a-uri'), undefined);
		assert.strictEqual(revive(raw => raw.runCwd = 'file:///other'), undefined);
		assert.strictEqual(revive(raw => raw.config.developerInstructionsSource = 'default'), undefined);
		assert.strictEqual(revive(raw => { delete raw.ownerProjectRoot; delete raw.runCwd; delete raw.config.ownerProjectRoot; delete raw.config.runCwd; raw.config.configSources.push({ ...raw.config.configSources[0], scope: 'project' }); }), undefined);
		assert.strictEqual(revive(raw => raw.config.configSources[0].projectedKeys = ['invalid_key']), undefined);
		assert.strictEqual(revive(raw => raw.config.agentDelegationLimits.maxAcceptedChildren = 9), undefined);
		assert.strictEqual(revive(raw => raw.config.agentDelegationLimitsSource.maxDepth = 'project'), undefined);
		assert.strictEqual(revive(raw => raw.config.configSources[0].projectedKeys = ['developer_instructions', 'developer_instructions']), undefined);
		assert.strictEqual(revive(raw => { raw.provenance[0].admittedBytes = raw.provenance[0].rawBytes + 1; }), undefined);
		assert.strictEqual(revive(raw => { raw.provenance[0].skipReason = 'budget'; raw.provenance[0].truncated = false; }), undefined);
		assert.strictEqual(revive(raw => raw.developerInstructions = 'mismatch'), undefined);
	});
});
