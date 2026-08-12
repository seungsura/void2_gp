import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { AgentSubagentService } from '../../browser/agentSubagentService.js';
import { ToolsService } from '../../browser/toolsService.js';
import { assembleProtectedAgentAuthority, createAgentRuntimeTurnSnapshot, createSkillCatalog, skillAdvertisement } from '../../common/agentSkills.js';
import { projectAgentConfig, resolveAgentInstructions, stableAgentInstructionRevision } from '../../common/agentInstructions.js';
import { assertCanonicalAgentChildRawUri, readOnlyChildToolNames } from '../../common/agentSubagents.js';
import { availableTools } from '../../common/prompt/prompts.js';

const bytes = (value: string) => new TextEncoder().encode(value);
const skillText = (name: string) => `---\nname: ${name}\ndescription: ${name}\n---\nbody-${name}`;
const instructions = (owner = 'file:///workspace') => {
	const config = projectAgentConfig({ developerInstructions: 'developer' }, undefined, [{ uri: 'file:///home/.codex/config.toml', scope: 'user', status: 'loaded', projectedKeys: ['developer_instructions'] }], owner, owner);
	const candidates = [{ uri: URI.joinPath(URI.parse(owner), 'AGENTS.md').toString(), outcome: Object.freeze({ status: 'bytes' as const, bytes: bytes('agents') }) }];
	return resolveAgentInstructions(config, candidates, stableAgentInstructionRevision(config, candidates));
};
const catalog = (owner = 'file:///workspace') => {
	const root = URI.joinPath(URI.parse(owner), '.agents/skills');
	return createSkillCatalog(['demo', 'other'].map((name, rank) => ({ source: 'repository' as const, rank, root: root.toString(), skillRoot: URI.joinPath(root, name).toString(), directoryName: name, bytes: bytes(skillText(name)) })));
};
const snapshot = (selected: string[] = [], owner = 'file:///workspace', modelName = 'gpt-4.1') => {
	const value = catalog(owner);
	return createAgentRuntimeTurnSnapshot(instructions(owner), value, skillAdvertisement(value, 10_000), selected.map(identity => { const skill = value.skills.find(item => item.identity === identity)!; return { identity, skillRoot: skill.provenance.skillRoot, bodyRevision: skill.bodyRevision, body: skillText(identity) }; }), { hasModel: true, providerName: 'openAI', modelName, contextWindow: 10_000, reservedOutputTokens: 1_000, modelSelectionOptions: { reasoningEnabled: true }, selectedModelOverrides: { temperature: .2 } }, true);
};

type FixtureOverrides = {
	owner?: string;
	trusted?: boolean;
	liveSettings?: any;
	readSkillBody?: (root: string, revision: string) => Promise<any>;
	resolve?: (uri: URI) => Promise<any>;
	prepare?: (options: any) => Promise<any>;
	send?: (options: any, turn: number) => string | null;
	callTool?: (name: string, params: any, context: any) => Promise<any>;
	stringOfResult?: (name: string, params: any, result: any, context: any) => string;
	customCatalog?: any;
	settingsState?: any;
};
const fixture = (overrides: FixtureOverrides = {}) => {
	const providerCalls: any[] = [];
	const converterCalls: any[] = [];
	const toolCalls: any[] = [];
	const invalidations: string[] = [];
	const events: any[] = [];
	let aborts = 0;
	let owner = overrides.owner ?? 'file:///workspace';
	let trusted = overrides.trusted ?? true;
	const liveSettings = overrides.liveSettings ?? { openAI: { apiKey: 'captured-key', endpoint: 'https://captured.invalid', models: [] } };
	const llm: any = {
		captureSettingsOfProvider: () => JSON.parse(JSON.stringify(liveSettings)),
		sendLLMMessage(options: any) { providerCalls.push(options); return overrides.send?.(options, providerCalls.length) ?? `request-${providerCalls.length}`; },
		abort() { aborts++; },
	};
	const parseParams = (name: string, raw: any) => ({ ...raw, ...(typeof raw.uri === 'string' ? { uri: URI.parse(raw.uri) } : {}), ...(typeof raw.search_in_folder === 'string' ? { searchInFolder: raw.search_in_folder === '' ? null : URI.parse(raw.search_in_folder) } : {}), ...(name === 'search_pathnames_only' ? { includePattern: raw.include_pattern ?? null, pageNumber: raw.page_number ?? 1 } : {}), ...(name === 'search_for_files' ? { isRegex: raw.is_regex ?? false, pageNumber: raw.page_number ?? 1 } : {}), ...(name === 'search_in_file' ? { isRegex: raw.is_regex ?? false } : {}) });
	const names = ['read_file', 'ls_dir', 'search_pathnames_only', 'search_for_files', 'search_in_file'];
	const validateParams: Record<string, (raw: any) => any> = {};
	const callTool: Record<string, (params: any, context: any) => Promise<any>> = {};
	const stringOfResult: Record<string, (_params: any, result: any, context?: any) => string> = {};
	for (const name of names) {
		validateParams[name] = raw => parseParams(name, raw);
		callTool[name] = async (params, context) => { toolCalls.push({ name, params, context }); const result = await (overrides.callTool?.(name, params, context) ?? {}); return { result: Promise.resolve(result) }; };
		stringOfResult[name] = (params: any, result: any, context?: any) => overrides.stringOfResult?.(name, params, result, context) ?? JSON.stringify(result);
	}
	const tools: any = { validateParams, callTool, stringOfResult, invalidateReadReceipts: (id: string) => invalidations.push(id) };
	const file: any = { resolve: overrides.resolve ?? (async (uri: URI) => ({ resource: uri, isSymbolicLink: false })) };
	const workspace: any = { getWorkspace: () => ({ folders: [{ uri: URI.parse(owner) }] }) };
	const trust: any = { isWorkspaceTrusted: () => trusted };
	const converter: any = { prepareLLMChatMessages: async (options: any) => { converterCalls.push({ ...options, chatMessages: options.chatMessages.map((message: any) => ({ ...message })) }); return overrides.prepare?.(options) ?? { messages: [{ role: 'user', content: 'prepared' }], separateSystemMessage: 'protected' }; } };
	const skills: any = { readSkillBody: overrides.readSkillBody ?? (async (root: string) => ({ body: skillText(root.endsWith('/other') ? 'other' : 'demo') })) };
	const customAgents: any = { getCatalog: async () => overrides.customCatalog ?? ({ revision: 'empty', agents: [], diagnostics: [] }) };
	const settings: any = { state: overrides.settingsState ?? { settingsOfProvider: liveSettings, optionsOfModelSelection: { Chat: { openAI: {} } }, overridesOfModel: {} } };
	const service = new AgentSubagentService(llm, tools, file, workspace, trust, converter, skills, customAgents, settings);
	service.onDidChangeRun(event => events.push(event));
	return { service, customAgents, settings, providerCalls, converterCalls, toolCalls, invalidations, events, liveSettings, setOwner: (value: string) => owner = value, setTrusted: (value: boolean) => trusted = value, aborts: () => aborts };
};
const final = (options: any, text = 'done') => queueMicrotask(() => options.onFinalMessage({ fullText: text, fullReasoning: '', anthropicReasoning: null }));
const toolThenFinal = (tool: { id: string; name: string; rawParams: Record<string, unknown> }) => (options: any, turn: number) => { queueMicrotask(() => turn === 1 ? options.onFinalMessage({ fullText: 'tool', fullReasoning: '', anthropicReasoning: null, toolCall: tool }) : options.onFinalMessage({ fullText: 'done', fullReasoning: '', anthropicReasoning: null })); return `request-${turn}`; };

suite('Void AgentSubagentService', () => {
	test('reserves four admissions, starts two, queues FIFO, and never refunds terminal quota', async () => {
		const f = fixture({ send: () => 'request' });
		const children = await Promise.all(['one', 'two', 'three', 'four'].map(message => f.service.spawn('parent', message, snapshot())));
		assert.strictEqual(f.providerCalls.length, 2); assert.deepStrictEqual(f.service.getRunViews('parent').map(view => view.status), ['running', 'running', 'queued', 'queued']);
		await assert.rejects(() => f.service.spawn('parent', 'five', snapshot()), /agent_child_limit_reached/);
		f.service.interrupt('parent', children[0].id);
		await Promise.resolve();
		assert.strictEqual(f.providerCalls.length, 3); assert.deepStrictEqual(f.service.getRunViews('parent').map(view => view.status), ['cancelled', 'running', 'running', 'queued']);
		f.service.interrupt('parent', children[1].id);
		await Promise.resolve();
		assert.strictEqual(f.providerCalls.length, 4); assert.deepStrictEqual(f.service.getRunViews('parent').map(view => view.status), ['cancelled', 'cancelled', 'running', 'running']);
		assert.deepStrictEqual(f.converterCalls.slice(0, 4).map(call => call.chatMessages[0].content), ['one', 'two', 'three', 'four']);
		await assert.rejects(() => f.service.spawn('parent', 'still-five', snapshot()), /agent_child_limit_reached/);
	});

	test('failed admission releases its reservation without a row or event', async () => {
		const f = fixture({ readSkillBody: async () => ({ diagnostic: { code: 'skill_stale' } }), send: () => 'request' });
		await assert.rejects(() => f.service.spawn('admission-release', '$demo bad', snapshot()), /skill_stale/);
		assert.deepStrictEqual(f.service.getRunViews('admission-release'), []); assert.deepStrictEqual(f.events, []);
		(f.service as any).skills.readSkillBody = async () => ({ body: skillText('demo') });
		await Promise.all(['1', '2', '3', '4'].map(message => f.service.spawn('admission-release', message, snapshot())));
		assert.strictEqual(f.service.getBudgetView('admission-release')?.accepted, 4); await assert.rejects(() => f.service.spawn('admission-release', '5', snapshot()), /agent_child_limit_reached/);
	});

	test('cancels a hung admission promptly without creating a row or provider request', async () => {
		let entered!: () => void; const enteredRead = new Promise<void>(resolve => entered = resolve); const f = fixture({ readSkillBody: async () => { entered(); return new Promise<any>(() => { }); } }); const pending = f.service.spawn('hung-admission', '$demo inspect', snapshot());
		await enteredRead; f.service.cancelParent('hung-admission'); await assert.rejects(Promise.race([pending, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('admission_timeout')), 100))]), /agent_child_cancelled/);
		assert.deepStrictEqual(f.service.getRunViews('hung-admission'), []); assert.strictEqual(f.providerCalls.length, 0);
	});

	test('isolates failures, promotes FIFO, supports queued interruption, and cancels an entire retained group', async () => {
		let sends = 0; const f = fixture({ send: options => { sends++; if (sends === 1) queueMicrotask(() => options.onError({ message: 'first failed' })); return `request-${sends}`; } });
		const children = await Promise.all(['one', 'two', 'three', 'four'].map(message => f.service.spawn('phase5', message, snapshot())));
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.strictEqual(f.service.getRunViews('phase5')[0].status, 'failed'); assert.strictEqual(f.providerCalls.length, 3); // failure promoted child three
		f.service.interrupt('phase5', children[3].id); assert.strictEqual(f.service.getRunViews('phase5')[3].status, 'cancelled'); assert.strictEqual(f.providerCalls.length, 3);
		f.service.cancelParent('phase5'); assert.deepStrictEqual(f.service.getRunViews('phase5').map(view => view.status), ['failed', 'cancelled', 'cancelled', 'cancelled']); assert.strictEqual(f.aborts(), 2);
	});

	test('wait preserves terminal summaries once, waits past an already-delivered terminal, and exposes bounded budget', async () => {
		const f = fixture({ send: () => 'request' }); const [one, two] = await Promise.all(['one', 'two'].map(message => f.service.spawn('wait-group', message, snapshot())));
		f.service.interrupt('wait-group', one.id); const first = await f.service.wait('wait-group', 0, [one.id]); assert.strictEqual(first.deliverSummary, true);
		const pending = f.service.wait('wait-group', 1_000, [one.id, two.id]); await new Promise(resolve => setTimeout(resolve, 0)); f.service.interrupt('wait-group', two.id); const next = await pending;
		assert.strictEqual(next.deliverSummary, true); assert.strictEqual(next.receipt?.id, two.id); assert.deepStrictEqual(next.children.map(child => child.id), [one.id, two.id]);
		const repeated = await f.service.wait('wait-group', 0, [two.id, one.id]); assert.strictEqual(repeated.deliverSummary, false); assert.deepStrictEqual(repeated.children.map(child => child.id), [one.id, two.id]); assert.strictEqual(JSON.stringify(repeated.children).includes('Child cancelled by parent.'), false); assert.strictEqual(repeated.timedOut, false); assert.strictEqual(repeated.budget.maxResultChars, 32_000); assert.strictEqual(repeated.budget.usage, null); assert.ok(repeated.budget.deadlineMsRemaining >= 0);
		const active = await f.service.spawn('wait-group-active', 'active', snapshot()); const timedOut = await f.service.wait('wait-group-active', 0, [active.id]); assert.strictEqual(timedOut.timedOut, true); f.service.interrupt('wait-group-active', active.id);
		for (const targets of [[], [one.id, one.id], [' ', two.id], ['x'.repeat(257)]]) await assert.rejects(() => f.service.wait('wait-group', 0, targets), /wait_agent_invalid_params|agent_child_not_direct/);
	});

	test('generation reset forgets quota and old ids cannot be interrupted in a new group', async () => {
		const f = fixture({ send: () => 'request' }); const old = await f.service.spawn('generation', 'old', snapshot(), undefined, undefined, undefined, undefined, 1); f.service.forgetParent('generation'); const fresh = await f.service.spawn('generation', 'fresh', snapshot(), undefined, undefined, undefined, undefined, 2);
		assert.deepStrictEqual(f.service.getRunViews('generation').map(view => view.id), [fresh.id]); assert.throws(() => f.service.interrupt('generation', old.id, 2), /agent_child_not_direct/);
	});

	test('enforces provider/result budgets and the shared cancellation path structurally', async () => {
		const f = fixture({ send: () => 'request' }); const child = await f.service.spawn('ledger', 'inspect', snapshot()); const group = (f.service as any).groups.get('ledger');
		group.providerSends = 64; f.service.interrupt('ledger', child.id); const blocked = await f.service.spawn('ledger', 'blocked', snapshot()); await new Promise(resolve => setTimeout(resolve, 0)); assert.strictEqual(f.providerCalls.length, 1); assert.strictEqual(f.service.getRunViews('ledger').find(view => view.id === blocked.id)?.status, 'failed');
		const capped = await Promise.all(['1', '2', '3', '4'].map(message => f.service.spawn('result-cap', message, snapshot()))); const budgetGroup = (f.service as any).groups.get('result-cap'); for (const id of capped.map(child => child.id)) { const run = budgetGroup.runs.find((candidate: any) => candidate.id === id); (f.service as any).settle(run, 'completed', 'x'.repeat(10_000)); } assert.strictEqual(budgetGroup.resultChars, 32_000); assert.deepStrictEqual(budgetGroup.runs.map((run: any) => run.summary.length), [8_000, 8_000, 8_000, 8_000]);
		let entered!: () => void; const enteredRead = new Promise<void>(resolve => entered = resolve); const deadline = fixture({ readSkillBody: async () => { entered(); return new Promise<any>(() => { }); } }); const pending = deadline.service.spawn('deadline', '$demo inspect', snapshot()); await enteredRead; (deadline.service as any).cancelGroup((deadline.service as any).groups.get('deadline'), 'deadline'); await assert.rejects(pending, /agent_child_cancelled/); assert.deepStrictEqual(deadline.service.getRunViews('deadline'), []); assert.strictEqual(deadline.providerCalls.length, 0);
	});

	test('rejects a two-Skill admission atomically without a run, event, or provider call', async () => {
		const f = fixture({ readSkillBody: async root => root.endsWith('/other') ? { diagnostic: { code: 'skill_stale' } } : { body: skillText('demo') } });
		await assert.rejects(() => f.service.spawn('parent', '$demo $other inspect', snapshot()), /skill_stale/);
		assert.strictEqual(f.service.getRunView('parent'), undefined); assert.deepStrictEqual(f.events, []); assert.strictEqual(f.providerCalls.length, 0);
	});

	test('uses only delegated private history/Skills and freezes model plus provider settings at spawn', async () => {
		let release!: () => void; const converterGate = new Promise<void>(resolve => release = resolve);
		const f = fixture({ prepare: async () => { await converterGate; return { messages: [{ role: 'user', content: 'prepared' }], separateSystemMessage: 'protected' }; }, send: options => { final(options); return 'request'; } });
		const child = await f.service.spawn('parent', '$other delegated task', snapshot(['demo']));
		f.liveSettings.openAI.apiKey = 'mutated-key'; f.liveSettings.openAI.endpoint = 'https://mutated.invalid'; release();
		const terminal = await f.service.wait('parent', 1_000); assert.strictEqual(terminal.status, 'completed');
		const first = f.converterCalls[0]; assert.strictEqual(first.chatMessages.length, 1); assert.strictEqual(first.chatMessages[0].content, '$other delegated task');
		assert.deepStrictEqual(first.instructionSnapshot.selected.map((item: any) => item.identity), ['other']); assert.strictEqual(first.instructionSnapshot.selected.some((item: any) => item.body.includes('body-demo')), false);
		const childAuthority = assembleProtectedAgentAuthority(first.instructionSnapshot, false); assert.strictEqual(childAuthority.split(skillText('other')).length - 1, 1); assert.strictEqual(childAuthority.includes('read_skill_resource'), false);
		assert.deepStrictEqual(availableTools('agent', undefined, 'read-only-child')!.map(tool => tool.name), [...readOnlyChildToolNames]);
		assert.deepStrictEqual(first.instructionSnapshot.model, snapshot().model); assert.strictEqual(first.toolExecutionProfile, 'read-only-child'); assert.strictEqual(first.childRoot, 'file:///workspace');
		assert.strictEqual(f.providerCalls[0].settingsOfProviderOverride.openAI.apiKey, 'captured-key'); assert.strictEqual(f.providerCalls[0].settingsOfProviderOverride.openAI.endpoint, 'https://captured.invalid'); assert.strictEqual(f.providerCalls[0].modelSelectionOptions.reasoningEnabled, true); assert.strictEqual(f.providerCalls[0].overridesOfModel.openAI['gpt-4.1'].temperature, .2); assert.strictEqual(f.service.getRunView('parent')?.id, child.id);
		for (const owner of [URI.file('C:\\workspace').toString(), 'vscode-remote://ssh-remote%2Bexample/workspace']) {
			const rootFixture = fixture({ owner, send: options => { final(options); return 'request'; } });
			await rootFixture.service.spawn(`parent-${owner}`, 'inspect', snapshot([], owner));
			await rootFixture.service.wait(`parent-${owner}`, 1_000);
			assert.strictEqual(rootFixture.converterCalls[0].childRoot, URI.parse(owner).toString());
			assert.strictEqual(rootFixture.converterCalls[0].childRoot.includes('\\'), false);
			assert.strictEqual(rootFixture.converterCalls[0].childRoot.startsWith(URI.parse(owner).scheme + ':'), true);
		}
	});

	test('adopts an admitted same-provider role model and freezes target transport options', async () => {
		const liveSettings: any = { openAI: { apiKey: 'captured-key', endpoint: 'https://captured.invalid', _didFillInProviderSettings: true, models: [{ modelName: 'gpt-4.1', isHidden: false, type: 'default' }, { modelName: 'gpt-4.1-mini', isHidden: false, type: 'default' }] } };
		const role: any = { identity: 'reader', name: 'reader', description: 'Read.', developerInstructions: 'role developer', model: 'gpt-4.1-mini', revision: 'role-1', skillRules: [] };
		const state: any = { settingsOfProvider: liveSettings, optionsOfModelSelection: { Chat: { openAI: { 'gpt-4.1-mini': { reasoningEnabled: false } } } }, overridesOfModel: { openAI: { 'gpt-4.1-mini': { temperature: .7 } } } };
		const f = fixture({ liveSettings, customCatalog: { revision: 'roles', agents: [role], diagnostics: [] }, settingsState: state, send: options => { final(options); return 'request'; } });
		const roles: any = { revision: 'roles', agents: [role], diagnostics: [] }; await f.service.spawn('parent', 'inspect', snapshot(), 'reader', roles);
		liveSettings.openAI.models[1].isHidden = true; state.optionsOfModelSelection.Chat.openAI['gpt-4.1-mini'].reasoningEnabled = true;
		await f.service.wait('parent', 1000);
		assert.strictEqual(f.providerCalls[0].modelSelection.modelName, 'gpt-4.1-mini'); assert.strictEqual(f.providerCalls[0].overridesOfModel.openAI['gpt-4.1-mini'].temperature, .7); assert.strictEqual(f.providerCalls[0].modelSelectionOptions.reasoningEnabled, false);
		assert.strictEqual(f.converterCalls[0].instructionSnapshot.instructions.developerInstructions, 'developer\n\nrole developer'); assert.strictEqual(f.converterCalls[0].instructionSnapshot.instructions.agentsInstructions, 'agents'); assert.notStrictEqual(f.converterCalls[0].instructionSnapshot.revision, snapshot().revision); assert.strictEqual(f.service.getRunView('parent')?.roleName, 'reader'); f.service.forgetParent('parent'); assert.strictEqual(f.service.getRunView('parent'), undefined); assert.strictEqual(f.events.some((event: any) => event.removed), true);
	});

	test('inherits the admitted parent model for effort-only roles despite live settings mutation', async () => {
		const liveSettings: any = { openAI: { apiKey: 'parent-key', endpoint: 'https://parent.invalid', _didFillInProviderSettings: true, models: [{ modelName: 'o3', isHidden: false, type: 'default' }] } };
		const role: any = { identity: 'reader', name: 'reader', description: 'Read.', developerInstructions: 'role developer', modelReasoningEffort: 'high', revision: 'role-1', skillRules: [] };
		const f = fixture({ liveSettings, customCatalog: { revision: 'roles', agents: [role], diagnostics: [] }, send: options => { final(options); return 'request'; } });
		const parent = snapshot([], 'file:///workspace', 'o3'); const parentModel = parent.model as any;
		const admittedState = JSON.parse(JSON.stringify(f.settings.state)); const admittedTransport = JSON.parse(JSON.stringify(liveSettings));
		await f.service.spawn('parent', 'inspect', parent, 'reader', { revision: 'roles', agents: [role], diagnostics: [] }, admittedState, admittedTransport);
		liveSettings.openAI.apiKey = 'mutated-key'; liveSettings.openAI.endpoint = 'https://mutated.invalid'; liveSettings.openAI.models[0].isHidden = true;
		f.settings.state.optionsOfModelSelection.Chat.openAI.o3 = { reasoningEnabled: false, reasoningEffort: 'low' };
		f.settings.state.overridesOfModel.openAI = { o3: { temperature: .9 } };
		await f.service.wait('parent', 1_000);
		const call = f.providerCalls[0]; assert.strictEqual(call.settingsOfProviderOverride.openAI.apiKey, 'parent-key'); assert.strictEqual(call.settingsOfProviderOverride.openAI.endpoint, 'https://parent.invalid'); assert.deepStrictEqual(call.overridesOfModel.openAI.o3, parentModel.selectedModelOverrides); assert.strictEqual(call.modelSelectionOptions.reasoningEnabled, true); assert.strictEqual(call.modelSelectionOptions.reasoningEffort, 'high');
		const inherited = f.converterCalls[0].instructionSnapshot.model; assert.strictEqual(inherited.contextWindow, parentModel.contextWindow); assert.strictEqual(inherited.reservedOutputTokens, parentModel.reservedOutputTokens); assert.deepStrictEqual(inherited.selectedModelOverrides, parentModel.selectedModelOverrides);
	});

	test('rejects effort-only roles when the inherited parent cannot accept the requested effort', async () => {
		const role: any = { identity: 'reader', name: 'reader', description: 'Read.', developerInstructions: 'role developer', modelReasoningEffort: 'high', revision: 'role-1', skillRules: [] };
		const f = fixture({ customCatalog: { revision: 'roles', agents: [role], diagnostics: [] } });
		await assert.rejects(() => f.service.spawn('parent', 'inspect', snapshot(), 'reader', { revision: 'roles', agents: [role], diagnostics: [] }), /custom_agent_invalid_reasoning_effort/); assert.strictEqual(f.providerCalls.length, 0);
	});

	test('inherits the parent model byte-for-byte when a role omits model and effort', async () => {
		const role: any = { identity: 'reader', name: 'reader', description: 'Read.', developerInstructions: 'role developer', revision: 'role-1', skillRules: [] };
		const f = fixture({ customCatalog: { revision: 'roles', agents: [role], diagnostics: [] }, send: options => { final(options); return 'request'; } }); const parent = snapshot();
		await f.service.spawn('parent', 'inspect', parent, 'reader', { revision: 'roles', agents: [role], diagnostics: [] }); await f.service.wait('parent', 1_000);
		assert.strictEqual(JSON.stringify(f.converterCalls[0].instructionSnapshot.model), JSON.stringify(parent.model));
	});

	test('rejects unknown, changed, or deleted roles before provider dispatch', async () => {
		let catalog: any = { revision: 'r1', agents: [{ identity: 'reader', name: 'reader', description: 'd', developerInstructions: 'd', revision: 'one' }], diagnostics: [] };
		const f = fixture({ customCatalog: catalog });
		await assert.rejects(() => f.service.spawn('unknown', 'inspect', snapshot(), 'missing', catalog), /custom_agent_not_found/);
		catalog = { revision: 'r2', agents: [], diagnostics: [] }; (f as any).service.customAgents.getCatalog = async () => catalog;
		await assert.rejects(() => f.service.spawn('changed', 'inspect', snapshot(), 'reader', { revision: 'r1', agents: [{ identity: 'reader', name: 'reader', description: 'd', developerInstructions: 'd', revision: 'one' }], diagnostics: [] } as any), /custom_agent_stale/);
		assert.strictEqual(f.providerCalls.length, 0);
	});

	test('rejects unavailable role models and invalid effort before provider dispatch', async () => {
		const base: any = { identity: 'reader', name: 'reader', description: 'd', developerInstructions: 'd', revision: 'one', skillRules: [] };
		for (const role of [{ ...base, model: 'missing' }, { ...base, model: 'gpt-4.1', modelReasoningEffort: 'xhigh' }]) {
			const f = fixture({ customCatalog: { revision: role.revision, agents: [role], diagnostics: [] } });
			await assert.rejects(() => f.service.spawn(`p-${role.model}`, 'inspect', snapshot(), 'reader', { revision: role.revision, agents: [role], diagnostics: [] })); assert.strictEqual(f.providerCalls.length, 0);
		}
	});

	test('filters disabled role Skills and rejects their explicit selection before dispatch', async () => {
		const role: any = { identity: 'reader', name: 'reader', description: 'd', developerInstructions: 'd', revision: 'one', skillRules: [{ selector: 'demo', enabled: false }] };
		const catalog: any = { revision: 'r1', agents: [role], diagnostics: [] }; const f = fixture({ customCatalog: catalog });
		await assert.rejects(() => f.service.spawn('role-skill', '$demo inspect', snapshot(), 'reader', catalog), /skill_not_found/); assert.strictEqual(f.providerCalls.length, 0);
	});

	test('admits multiple role-selected bodies atomically and never partially launches', async () => {
		const role: any = { identity: 'reader', name: 'reader', description: 'd', developerInstructions: 'developer', revision: 'one', skillRules: [] }; const roles: any = { revision: 'r1', agents: [role], diagnostics: [] };
		const good = fixture({ customCatalog: roles, send: options => { final(options); return 'request'; } }); await good.service.spawn('multi-good', '$demo $other inspect', snapshot(), 'reader', roles); await good.service.wait('multi-good', 1000); assert.strictEqual(good.providerCalls.length, 1);
		const bad = fixture({ customCatalog: roles, readSkillBody: async root => root.endsWith('/other') ? { diagnostic: { code: 'skill_stale' } } : { body: skillText('demo') } }); await assert.rejects(() => bad.service.spawn('multi-bad', '$demo $other inspect', snapshot(), 'reader', roles), /skill_stale/); assert.strictEqual(bad.providerCalls.length, 0); assert.strictEqual(bad.service.getRunView('multi-bad'), undefined);
	});

	test('cancellation during deferred final role recheck cannot install a child', async () => {
		let release!: () => void; let reads = 0; const role: any = { identity: 'reader', name: 'reader', description: 'd', developerInstructions: 'developer', revision: 'one', skillRules: [] }; const roles: any = { revision: 'r1', agents: [role], diagnostics: [] };
		const f = fixture({ customCatalog: roles, send: options => { final(options); return 'request'; } }); f.customAgents.getCatalog = async () => { if (++reads === 1) await new Promise<void>(resolve => release = resolve); return roles; };
		const pending = f.service.spawn('cancel-final', 'inspect', snapshot(), 'reader', roles); while (reads < 1) await new Promise<void>(resolve => setTimeout(resolve, 0)); f.service.cancelParent('cancel-final'); release(); await assert.rejects(pending, /agent_child_cancelled/); assert.strictEqual(f.providerCalls.length, 0); assert.strictEqual(f.service.getRunView('cancel-final'), undefined);
	});

	test('preserves exact provider tool ids for success and tool_error turns', async () => {
		for (const shouldFail of [false, true]) {
			const id = shouldFail ? 'provider-error-id' : 'provider-success-id';
			const f = fixture({ callTool: async () => { if (shouldFail) throw new Error('read failed'); return { text: 'x'.repeat(50_000) }; }, send: toolThenFinal({ id, name: 'read_file', rawParams: { uri: 'file:///workspace/a' } }) });
			await f.service.spawn(`parent-${id}`, 'inspect', snapshot()); await f.service.wait(`parent-${id}`, 1_000);
			const toolMessage = f.converterCalls[1].chatMessages.find((message: any) => message.role === 'tool'); assert.strictEqual(toolMessage.id, id); assert.strictEqual(toolMessage.type, shouldFail ? 'tool_error' : 'success'); assert.strictEqual(f.toolCalls.length, 1); if (!shouldFail) { assert.ok(toolMessage.content.length <= 8192 * 4); assert.ok(toolMessage.content.endsWith('[child tool output truncated]')); }
		}
	});

	test('never dispatches write, terminal, MCP, child-control, or unknown tools', async () => {
		for (const name of ['write_file', 'run_command', 'mcp_remote', 'spawn_agent', 'unknown_tool']) {
			const f = fixture({ send: toolThenFinal({ id: `id-${name}`, name, rawParams: {} }) });
			await f.service.spawn(`parent-${name}`, 'inspect', snapshot()); await f.service.wait(`parent-${name}`, 1_000);
			assert.strictEqual(f.toolCalls.length, 0); const toolMessage = f.converterCalls[1].chatMessages.find((message: any) => message.role === 'tool'); assert.strictEqual(toolMessage.id, `id-${name}`); assert.strictEqual(toolMessage.type, 'tool_error');
		}
	});

	test('rejects outside/reparse direct paths and outside search results before model visibility', async () => {
		const cases: Array<{ name: string; rawParams: any; resolve?: (uri: URI) => Promise<any>; callTool?: FixtureOverrides['callTool'] }> = [
			{ name: 'read_file', rawParams: { uri: 'file:///outside/a' } },
			{ name: 'read_file', rawParams: { uri: 'file:///workspace/../outside' } },
			{ name: 'read_file', rawParams: { uri: 'file:///workspace/%2e%2e/outside' } },
			{ name: 'read_file', rawParams: { uri: 'file://other/workspace/a' } },
			{ name: 'read_file', rawParams: { uri: 'file:///workspace/link/a' }, resolve: async uri => ({ resource: uri, isSymbolicLink: uri.path.includes('/link') }) },
			{ name: 'search_in_file', rawParams: { uri: 'file:///workspace/a', query: '(a+)+$', is_regex: true } },
			{ name: 'search_pathnames_only', rawParams: { query: 'a' }, callTool: async () => ({ uris: [URI.parse('file:///outside/a')], hasNextPage: false }) },
		];
		for (const [index, item] of cases.entries()) {
			const f = fixture({ resolve: item.resolve, callTool: item.callTool, send: toolThenFinal({ id: `read-${index}`, name: item.name, rawParams: item.rawParams }) });
			await f.service.spawn(`parent-path-${index}`, 'inspect', snapshot()); await f.service.wait(`parent-path-${index}`, 1_000);
			const toolMessage = f.converterCalls[1].chatMessages.find((message: any) => message.role === 'tool'); assert.strictEqual(toolMessage.type, 'tool_error');
			if (!item.callTool) assert.strictEqual(f.toolCalls.length, 0); else assert.strictEqual(f.providerCalls[1].messages.some((message: any) => String(message.content).includes('file:///outside/a')), false);
		}
		const driveOwner = URI.file('C:\\'); const driveTarget = URI.joinPath(driveOwner, 'child.txt');
		const driveService = fixture({ owner: driveOwner.toString(), callTool: async () => ({ text: 'safe' }), send: toolThenFinal({ id: 'drive-read', name: 'read_file', rawParams: { uri: driveTarget.toString() } }) });
		await driveService.service.spawn('drive-parent', 'inspect', snapshot([], driveOwner.toString())); await driveService.service.wait('drive-parent', 1_000); assert.strictEqual(driveService.toolCalls.length, 1); assert.strictEqual(driveService.service.getRunView('drive-parent')?.status, 'completed');
		const emptyFolderService = fixture({ callTool: async () => ({ queryStr: 'a', uris: [], hasNextPage: false }), send: toolThenFinal({ id: 'empty-folder', name: 'search_for_files', rawParams: { query: 'a', search_in_folder: '' } }) });
		await emptyFolderService.service.spawn('empty-folder-parent', 'inspect', snapshot()); await emptyFolderService.service.wait('empty-folder-parent', 1_000); assert.strictEqual(emptyFolderService.toolCalls.length, 1); assert.strictEqual(emptyFolderService.toolCalls[0].params.searchInFolder, null); assert.strictEqual(emptyFolderService.service.getRunView('empty-folder-parent')?.status, 'completed');

		const owner = URI.parse('file:///workspace'); const target = URI.parse('file:///workspace/a');
		const safeFile = { resolve: async (uri: URI) => ({ resource: uri, isSymbolicLink: false }), stat: async (uri: URI) => ({ resource: uri, isSymbolicLink: false, size: 12 }) };
		const makeRealTools = (fileService: any, voidModelService: any, searchService: any = {}, queryBuilder: any = {}) => new ToolsService(fileService, { getWorkspace: () => ({ folders: [{ uri: owner }] }) } as never, searchService, { createInstance: () => queryBuilder } as never, voidModelService, { state: { globalSettings: {} } } as never, {} as never, {} as never, {} as never, {} as never, { read: () => [] } as never);
		const childContext = { ownerThreadId: 'child', childId: 'child', ownerRoot: owner, maxReadOutputTokens: 1024, maxFileSize: 1_048_576, maxResults: 100 } as const;
		let initializes = 0;
		const oversizedTools = makeRealTools({ ...safeFile, stat: async (uri: URI) => ({ resource: uri, isSymbolicLink: false, size: 1_048_577 }) }, { initializeModel: async () => { initializes++; }, getModelSafe: async () => ({ model: null }) });
		await assert.rejects(() => oversizedTools.callTool.read_file({ uri: target, startLine: null, endLine: null, lineByteOffset: 0 }, childContext), /agent_child_file_too_large/); assert.strictEqual(initializes, 0);

		for (const invalid of [URI.parse('file:///workspace/../outside'), URI.parse('file://other/workspace/a'), URI.parse('file:///workspace/a%2Fb')]) {
			const tools = makeRealTools(safeFile, { initializeModel: async () => { initializes++; }, getModelSafe: async () => ({ model: null }) });
			await assert.rejects(() => tools.callTool.read_file({ uri: invalid, startLine: null, endLine: null, lineByteOffset: 0 }, childContext), /agent_child_(?:path_not_canonical|search_outside_owner)/);
		}
		const intermediateReparse = makeRealTools({ ...safeFile, resolve: async (uri: URI) => ({ resource: uri, isSymbolicLink: uri.path === '/workspace/link' }) }, { initializeModel: async () => { initializes++; }, getModelSafe: async () => ({ model: null }) });
		await assert.rejects(() => intermediateReparse.callTool.read_file({ uri: URI.parse('file:///workspace/link/a'), startLine: null, endLine: null, lineByteOffset: 0 }, childContext), /agent_child_reparse_point/);

		let statCalls = 0; let modelReads = 0;
		const growthTools = makeRealTools({ ...safeFile, stat: async (uri: URI) => ({ resource: uri, isSymbolicLink: false, size: ++statCalls === 1 ? 1 : 1_048_577 }) }, { initializeModel: async () => { }, getModelSafe: async () => { modelReads++; return { model: null }; } });
		await assert.rejects(() => growthTools.callTool.read_file({ uri: target, startLine: null, endLine: null, lineByteOffset: 0 }, childContext), /agent_child_file_too_large/); assert.strictEqual(modelReads, 0);

		let getValueCalls = 0; const lines = ['alpha', 'needle', 'omega'];
		const lineModel = { getLineCount: () => lines.length, getValueLength: () => lines.join('\n').length, getLineContent: (line: number) => lines[line - 1], getVersionId: () => 1, getValue: () => { getValueCalls++; throw new Error('full materialization forbidden'); } };
		const lineTools = makeRealTools(safeFile, { initializeModel: async () => { }, getModelSafe: async () => ({ model: lineModel }), getModel: () => ({ model: lineModel }) });
		const read = await lineTools.callTool.read_file({ uri: target, startLine: 1, endLine: null, lineByteOffset: 0 }, childContext); assert.strictEqual((await read.result).fileContents, 'alpha\nneedle\nomega'); assert.strictEqual(getValueCalls, 0);
		const driveRead = await lineTools.callTool.read_file({ uri: driveTarget, startLine: 1, endLine: null, lineByteOffset: 0 }, { ...childContext, ownerRoot: driveOwner }); assert.strictEqual((await driveRead.result).fileContents, 'alpha\nneedle\nomega');
		const canonicalSearchUris = [URI.file('C:\\workspace\\a.ts'), URI.parse('vscode-remote://ssh-remote+example/workspace/a.ts')];
		for (const name of ['search_pathnames_only', 'search_for_files'] as const) {
			const params = name === 'search_pathnames_only' ? { query: 'a', includePattern: null, pageNumber: 1 } : { query: 'a', isRegex: false, searchInFolder: null, pageNumber: 1 };
			const childText = lineTools.stringOfResult[name](params as never, { uris: canonicalSearchUris, hasNextPage: false, ...(name === 'search_for_files' ? { queryStr: 'a' } : {}) } as never, childContext);
			assert.deepStrictEqual(childText.split('\n'), canonicalSearchUris.map(uri => uri.toString())); for (const value of childText.split('\n')) { assert.strictEqual(value.includes('\\'), false); assert.doesNotThrow(() => assertCanonicalAgentChildRawUri(value)); assert.strictEqual(URI.parse(value).toString(), value); }
			const parentText = lineTools.stringOfResult[name](params as never, { uris: canonicalSearchUris, hasNextPage: false, ...(name === 'search_for_files' ? { queryStr: 'a' } : {}) } as never); assert.deepStrictEqual(parentText.split('\n'), canonicalSearchUris.map(uri => uri.fsPath));
		}
		for (const root of [URI.file('C:\\workspace'), URI.parse('vscode-remote://ssh-remote+example/workspace')]) {
			const resultUri = URI.joinPath(root, 'a.ts'); const canonicalRoot = root.toString();
			const roundTrip = fixture({ owner: canonicalRoot, callTool: async () => ({ uris: [resultUri], hasNextPage: false }), stringOfResult: (name, params, result, context) => (lineTools.stringOfResult as any)[name](params, result, context), send: toolThenFinal({ id: `round-trip-${root.scheme}`, name: 'search_pathnames_only', rawParams: { query: 'a' } }) });
			await roundTrip.service.spawn(`round-trip-${canonicalRoot}`, 'inspect', snapshot([], canonicalRoot)); await roundTrip.service.wait(`round-trip-${canonicalRoot}`, 1_000); const toolMessage = roundTrip.converterCalls[1].chatMessages.find((message: any) => message.role === 'tool'); assert.strictEqual(toolMessage.content, resultUri.toString()); assert.doesNotThrow(() => assertCanonicalAgentChildRawUri(toolMessage.content)); assert.strictEqual(URI.parse(toolMessage.content).toString(), resultUri.toString());
		}
		const literal = await lineTools.callTool.search_in_file({ uri: target, query: 'needle', isRegex: false }, childContext); assert.deepStrictEqual((await literal.result).lines, [2]); assert.strictEqual(getValueCalls, 0);
		await assert.rejects(() => lineTools.callTool.search_in_file({ uri: target, query: '(a+)+$', isRegex: true }, childContext), /agent_child_regex_not_supported/);
		let oversizedModelLineReads = 0; const oversizedModel = { ...lineModel, getValueLength: () => 1_048_577, getLineContent: () => { oversizedModelLineReads++; return 'secret'; } };
		const oversizedModelTools = makeRealTools(safeFile, { initializeModel: async () => { }, getModelSafe: async () => ({ model: oversizedModel }) });
		await assert.rejects(() => oversizedModelTools.callTool.search_in_file({ uri: target, query: 'secret', isRegex: false }, childContext), /agent_child_file_too_large/); assert.strictEqual(oversizedModelLineReads, 0);
		const hugeLine = `needle${'x'.repeat(100_000)}`; const hugeLineModel = { ...lineModel, getLineCount: () => 1, getValueLength: () => hugeLine.length, getLineContent: () => hugeLine, getValueInRange: () => { throw new Error('child formatter reread live model'); } };
		const hugeLineTools = makeRealTools(safeFile, { initializeModel: async () => { }, getModelSafe: async () => ({ model: hugeLineModel }), getModel: () => ({ model: hugeLineModel }) }); const tinyContext = { ...childContext, maxReadOutputTokens: 32 };
		const hugeMatchCall = await hugeLineTools.callTool.search_in_file({ uri: target, query: 'needle', isRegex: false }, tinyContext); const hugeMatch = await hugeMatchCall.result; const hugeMatchText = hugeLineTools.stringOfResult.search_in_file({ uri: target, query: 'needle', isRegex: false }, hugeMatch); assert.ok(hugeMatchText.includes('Line 1')); assert.ok(hugeMatchText.length <= 128);

		const iterationCancellation: any = { isCancellationRequested: false };
		const cancellingModel = { ...lineModel, getLineContent: (line: number) => { if (line === 1) iterationCancellation.isCancellationRequested = true; return lines[line - 1]; } };
		const cancellingTools = makeRealTools(safeFile, { initializeModel: async () => { }, getModelSafe: async () => ({ model: cancellingModel }) });
		await assert.rejects(() => cancellingTools.callTool.search_in_file({ uri: target, query: 'absent', isRegex: false }, { ...childContext, cancellationToken: iterationCancellation }), /agent_child_cancelled/);

		let fileQueryOptions: any; const queryBuilder = { file: (_roots: URI[], options: any) => { fileQueryOptions = options; return options; }, text: () => ({}) };
		const overLimitResults = Array.from({ length: 101 }, (_, index) => ({ resource: URI.parse(`file:///workspace/${index}`), results: [] }));
		const cappedTools = makeRealTools(safeFile, { initializeModel: async () => { }, getModelSafe: async () => ({ model: null }) }, { fileSearch: async () => ({ results: overLimitResults }) }, queryBuilder);
		await assert.rejects(() => cappedTools.callTool.search_pathnames_only({ query: 'a', includePattern: null, pageNumber: 1 }, childContext), /agent_child_search_result_limit/); assert.strictEqual(fileQueryOptions.ignoreSymlinks, true); assert.strictEqual(fileQueryOptions.maxResults, 100); assert.strictEqual(fileQueryOptions.maxFileSize, 1_048_576);
		const outsideSearch = makeRealTools(safeFile, { initializeModel: async () => { }, getModelSafe: async () => ({ model: null }) }, { fileSearch: async () => ({ results: [{ resource: URI.parse('file:///outside/a'), results: [] }] }) }, queryBuilder);
		await assert.rejects(() => outsideSearch.callTool.search_pathnames_only({ query: 'a', includePattern: null, pageNumber: 1 }, childContext), /agent_child_search_outside_owner/);
		const searchCancellation: any = { isCancellationRequested: false };
		const cancelledSearch = makeRealTools(safeFile, { initializeModel: async () => { }, getModelSafe: async () => ({ model: null }) }, { fileSearch: async () => { searchCancellation.isCancellationRequested = true; return { results: [] }; } }, queryBuilder);
		await assert.rejects(() => cancelledSearch.callTool.search_pathnames_only({ query: 'a', includePattern: null, pageNumber: 1 }, { ...childContext, cancellationToken: searchCancellation }), /agent_child_cancelled/);
		let blockedFileBackend = 0; let blockedTextBackend = 0;
		const blockedRootTools = makeRealTools({ ...safeFile, resolve: async (uri: URI) => ({ resource: uri, isSymbolicLink: uri.toString() === owner.toString() }) }, { initializeModel: async () => { }, getModelSafe: async () => ({ model: null }) }, { fileSearch: async () => { blockedFileBackend++; return { results: [] }; }, textSearch: async () => { blockedTextBackend++; return { results: [] }; } }, { file: () => ({}), text: () => ({}) });
		await assert.rejects(() => blockedRootTools.callTool.search_pathnames_only({ query: 'a', includePattern: null, pageNumber: 1 }, childContext), /agent_child_reparse_point/);
		await assert.rejects(() => blockedRootTools.callTool.search_for_files({ query: 'a', isRegex: false, searchInFolder: null, pageNumber: 1 }, childContext), /agent_child_reparse_point/); assert.strictEqual(blockedFileBackend, 0); assert.strictEqual(blockedTextBackend, 0);
		let blockedSubfolderBackend = 0;
		const blockedSubfolderTools = makeRealTools({ ...safeFile, resolve: async (uri: URI) => ({ resource: uri, isSymbolicLink: uri.path === '/workspace/sub' }) }, { initializeModel: async () => { }, getModelSafe: async () => ({ model: null }) }, { textSearch: async () => { blockedSubfolderBackend++; return { results: [] }; } }, { file: () => ({}), text: () => ({}) });
		await assert.rejects(() => blockedSubfolderTools.callTool.search_for_files({ query: 'a', isRegex: false, searchInFolder: URI.parse('file:///workspace/sub'), pageNumber: 1 }, childContext), /agent_child_reparse_point/); assert.strictEqual(blockedSubfolderBackend, 0);
		let fileRootSwapped = false; let textRootSwapped = false;
		const swappedFileTools = makeRealTools({ ...safeFile, resolve: async (uri: URI) => ({ resource: uri, isSymbolicLink: fileRootSwapped && uri.toString() === owner.toString() }) }, { initializeModel: async () => { }, getModelSafe: async () => ({ model: null }) }, { fileSearch: async () => { fileRootSwapped = true; return { results: [] }; } }, { file: () => ({}), text: () => ({}) });
		await assert.rejects(() => swappedFileTools.callTool.search_pathnames_only({ query: 'a', includePattern: null, pageNumber: 1 }, childContext), /agent_child_reparse_point/);
		const swappedTextTools = makeRealTools({ ...safeFile, resolve: async (uri: URI) => ({ resource: uri, isSymbolicLink: textRootSwapped && uri.path === '/workspace/sub' }) }, { initializeModel: async () => { }, getModelSafe: async () => ({ model: null }) }, { textSearch: async () => { textRootSwapped = true; return { results: [] }; } }, { file: () => ({}), text: () => ({}) });
		await assert.rejects(() => swappedTextTools.callTool.search_for_files({ query: 'a', isRegex: false, searchInFolder: URI.parse('file:///workspace/sub'), pageNumber: 1 }, childContext), /agent_child_reparse_point/);
		const textRoots: string[][] = []; const textOptions: any[] = [];
		const textQueryBuilder = { file: () => ({}), text: (_pattern: unknown, roots: URI[], options: unknown) => { textRoots.push(roots.map(uri => uri.toString())); textOptions.push(options); return {}; } };
		const narrowedSearch = makeRealTools(safeFile, { initializeModel: async () => { }, getModelSafe: async () => ({ model: null }) }, { textSearch: async () => ({ results: [] }) }, textQueryBuilder);
		await narrowedSearch.callTool.search_for_files({ query: 'a', isRegex: false, searchInFolder: URI.parse('file:///workspace/sub'), pageNumber: 1 }, childContext);
		await narrowedSearch.callTool.search_for_files({ query: 'a', isRegex: false, searchInFolder: null, pageNumber: 1 }, childContext);
		assert.deepStrictEqual(textRoots, [['file:///workspace/sub'], ['file:///workspace']]); assert.strictEqual(textOptions.every(options => options.ignoreSymlinks === true && options.maxResults === 100 && options.maxFileSize === 1_048_576), true);
	});

	test('passes a unique receipt owner/cancellation fence and invalidates it exactly once', async () => {
		const f = fixture({ callTool: async () => ({ text: 'ok' }), send: toolThenFinal({ id: 'read-id', name: 'read_file', rawParams: { uri: 'file:///workspace/a' } }) });
		const child = await f.service.spawn('parent', 'inspect', snapshot()); await f.service.wait('parent', 1_000);
		assert.strictEqual(f.toolCalls[0].context.ownerThreadId, child.id); assert.strictEqual(f.toolCalls[0].context.childId, child.id); assert.strictEqual(f.toolCalls[0].context.ownerRoot.toString(), 'file:///workspace'); assert.ok(f.toolCalls[0].context.cancellationToken); assert.deepStrictEqual(f.invalidations, [child.id]);
	});

	test('interrupt wins a late final with one terminal event, abort, and invalidation', async () => {
		let pendingOptions: any; const f = fixture({ send: options => { pendingOptions = options; return 'request'; } });
		const child = await f.service.spawn('parent', 'inspect', snapshot()); f.service.interrupt('parent', child.id);
		pendingOptions.onFinalMessage({ fullText: 'late', fullReasoning: '', anthropicReasoning: null }); await Promise.resolve();
		assert.strictEqual(f.service.getRunView('parent')?.status, 'cancelled'); assert.strictEqual(f.events.filter(event => event.status === 'cancelled').length, 1); assert.strictEqual(f.aborts(), 1); assert.deepStrictEqual(f.invalidations, [child.id]);
	});

	test('wait timeout is non-mutating; terminal summary delivers once; targets are direct', async () => {
		const f = fixture({ send: () => 'request' }); await assert.rejects(() => f.service.wait('missing', 0), /agent_child_not_found/);
		const child = await f.service.spawn('parent', 'inspect', snapshot()); const listenerBaseline = (f.service as any)._onDidChangeRun._size; for (let i = 0; i < 20; i++) { const waiting = await f.service.wait('parent', 0); assert.strictEqual(waiting.status, 'running'); } assert.strictEqual((f.service as any)._onDidChangeRun._size, listenerBaseline); assert.strictEqual(f.service.getRunView('parent')?.status, 'running');
		assert.throws(() => f.service.interrupt('parent', 'not-direct'), /agent_child_not_direct/); f.service.interrupt('parent', child.id);
		const first = await f.service.wait('parent', 0); const second = await f.service.wait('parent', 0); assert.strictEqual(first.deliverSummary, true); assert.ok(first.receipt?.summary); assert.strictEqual(second.deliverSummary, false); assert.strictEqual(second.receipt, undefined);
	});

	test('owner/trust drift across awaited boundaries cancels without provider/tool leakage', async () => {
		let releaseSkill!: () => void; const skillGate = new Promise<void>(resolve => releaseSkill = resolve); const admission = fixture({ readSkillBody: async () => { await skillGate; return { body: skillText('demo') }; } });
		const pending = admission.service.spawn('admission', '$demo inspect', snapshot()); admission.setTrusted(false); releaseSkill(); await assert.rejects(pending, /agent_child_owner_or_trust_changed/); assert.strictEqual(admission.providerCalls.length, 0); assert.strictEqual(admission.service.getRunView('admission'), undefined);
		let releaseConverter!: () => void; const converterGate = new Promise<void>(resolve => releaseConverter = resolve); const running = fixture({ prepare: async () => { await converterGate; return { messages: [{ role: 'user', content: 'prepared' }], separateSystemMessage: 'protected' }; } });
		await running.service.spawn('running', 'inspect', snapshot()); running.setOwner('file:///other'); releaseConverter(); const terminal = await running.service.wait('running', 1_000); assert.strictEqual(terminal.status, 'cancelled'); assert.strictEqual(running.providerCalls.length, 0); assert.strictEqual(running.toolCalls.length, 0);
		for (const [parentId, failure] of [['converter-failure', fixture({ prepare: async () => { throw new Error('converter exploded'); } })], ['send-failure', fixture({ send: () => { throw new Error('send exploded'); } })]] as const) {
			await failure.service.spawn(parentId, 'inspect', snapshot()); const failed = await failure.service.wait(parentId, 1_000); assert.strictEqual(failed.status, 'failed'); assert.ok(/exploded/.test(failed.receipt?.summary ?? '')); assert.strictEqual(failure.events.filter(event => event.status === 'failed').length, 1); assert.strictEqual(failure.toolCalls.length, 0); assert.strictEqual(failure.invalidations.length, 1);
		}
	});

	test('a fresh service has no restart replay and forgetParent removes transient terminal state', async () => {
		const first = fixture({ send: options => { final(options); return 'request'; } }); await first.service.spawn('parent', 'inspect', snapshot()); await first.service.wait('parent', 1_000); assert.ok(first.service.getRunView('parent'));
		const terminalViews: Array<unknown> = []; const terminalListener = first.service.onDidChangeRun(event => { if (event.parentId === 'parent') terminalViews.push(first.service.getRunView('parent')); });
		const restarted = fixture(); assert.strictEqual(restarted.service.getRunView('parent'), undefined); first.service.forgetParent('parent'); assert.strictEqual(first.service.getRunView('parent'), undefined); assert.strictEqual(terminalViews.at(-1), undefined); assert.strictEqual(first.events.at(-1).removed, true); terminalListener.dispose();
		const active = fixture(); const child = await active.service.spawn('active', 'inspect', snapshot()); for (let i = 0; i < 10 && active.providerCalls.length === 0; i++) await Promise.resolve(); assert.strictEqual(active.providerCalls.length, 1); const activeViews: Array<unknown> = []; const activeListener = active.service.onDidChangeRun(event => { if (event.parentId === 'active') activeViews.push(active.service.getRunView('active')); }); active.service.forgetParent('active'); assert.strictEqual(active.service.getRunView('active'), undefined); assert.strictEqual(activeViews.at(-1), undefined); assert.strictEqual(active.events.at(-1).removed, true); assert.strictEqual(active.aborts(), 1); assert.deepStrictEqual(active.invalidations, [child.id]); activeListener.dispose();
		first.service.dispose(); active.service.dispose(); restarted.service.dispose();
	});
});
