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
const snapshot = (selected: string[] = [], owner = 'file:///workspace') => {
	const value = catalog(owner);
	return createAgentRuntimeTurnSnapshot(instructions(owner), value, skillAdvertisement(value, 10_000), selected.map(identity => { const skill = value.skills.find(item => item.identity === identity)!; return { identity, skillRoot: skill.provenance.skillRoot, bodyRevision: skill.bodyRevision, body: skillText(identity) }; }), { hasModel: true, providerName: 'openAI', modelName: 'gpt-4.1', contextWindow: 10_000, reservedOutputTokens: 1_000, modelSelectionOptions: { reasoningEnabled: true }, selectedModelOverrides: { temperature: .2 } }, true);
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
	const service = new AgentSubagentService(llm, tools, file, workspace, trust, converter, skills);
	service.onDidChangeRun(event => events.push(event));
	return { service, providerCalls, converterCalls, toolCalls, invalidations, events, liveSettings, setOwner: (value: string) => owner = value, setTrusted: (value: boolean) => trusted = value, aborts: () => aborts };
};
const final = (options: any, text = 'done') => queueMicrotask(() => options.onFinalMessage({ fullText: text, fullReasoning: '', anthropicReasoning: null }));
const toolThenFinal = (tool: { id: string; name: string; rawParams: Record<string, unknown> }) => (options: any, turn: number) => { queueMicrotask(() => turn === 1 ? options.onFinalMessage({ fullText: 'tool', fullReasoning: '', anthropicReasoning: null, toolCall: tool }) : options.onFinalMessage({ fullText: 'done', fullReasoning: '', anthropicReasoning: null })); return `request-${turn}`; };

suite('Void AgentSubagentService', () => {
	test('reserves pending admission, cancels it, then permits a clean spawn', async () => {
		let release!: () => void; let entered!: () => void; const started = new Promise<void>(resolve => entered = resolve);
		const f = fixture({ readSkillBody: async () => { entered(); await new Promise<void>(resolve => release = resolve); return { body: skillText('demo') }; }, send: options => { final(options); return 'request'; } });
		const first = f.service.spawn('parent', '$demo inspect', snapshot()); await started;
		await assert.rejects(() => f.service.spawn('parent', '$demo again', snapshot()), /agent_child_already_active/);
		f.service.cancelParent('parent'); release(); await assert.rejects(first, /agent_child_cancelled/);
		const next = await f.service.spawn('parent', 'plain inspect', snapshot()); assert.ok(next.id); f.service.interrupt('parent', next.id);
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
		const first = await f.service.wait('parent', 0); const second = await f.service.wait('parent', 0); assert.strictEqual(first.deliverSummary, true); assert.ok(first.receipt?.summary); assert.strictEqual(second.deliverSummary, false); assert.strictEqual(second.receipt?.summary, '');
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
