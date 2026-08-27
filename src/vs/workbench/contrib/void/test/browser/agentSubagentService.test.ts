import assert from 'assert';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { URI } from '../../../../../base/common/uri.js';
import { Event } from '../../../../../base/common/event.js';
import { getSingletonServiceDescriptors } from '../../../../../platform/instantiation/common/extensions.js';
import { TestDialogService } from '../../../../../platform/dialogs/test/common/testDialogService.js';
import { TestNotificationService } from '../../../../../platform/notification/test/common/testNotificationService.js';
import { UndoRedoService } from '../../../../../platform/undoRedo/common/undoRedoService.js';
import { createTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { AgentSubagentService } from '../../browser/agentSubagentService.js';
import { ChatThreadService } from '../../browser/chatThreadService.js';
import { ConvertToLLMMessageService } from '../../browser/convertToLLMMessageService.js';
import { ToolsService } from '../../browser/toolsService.js';
import '../../browser/editCodeService.js';
import { IEditCodeService } from '../../browser/editCodeServiceInterface.js';
import { assembleProtectedAgentAuthority, createAgentRuntimeTurnSnapshot, createSkillCatalog, skillAdvertisement } from '../../common/agentSkills.js';
import { projectAgentConfig, resolveAgentInstructions, stableAgentInstructionRevision } from '../../common/agentInstructions.js';
import { assertCanonicalAgentChildRawUri, readOnlyChildToolNames } from '../../common/agentSubagents.js';
import { availableTools, captureParentModelToolSnapshot, InternalToolInfo } from '../../common/prompt/prompts.js';
import { IMCPService } from '../../common/mcpService.js';
import { INTERNAL_EMPTY_MESSAGE_SENTINEL } from '../../common/assistantMessagePresentation.js';

const bytes = (value: string) => new TextEncoder().encode(value);
const skillText = (name: string) => `---\nname: ${name}\ndescription: ${name}\n---\nbody-${name}`;
const instructions = (owner = 'file:///workspace', limits?: { maxAcceptedChildren?: number; maxConcurrentThreadsPerSession?: number; maxDepth?: number }) => {
	const projectedKeys: any[] = ['developer_instructions']; if (limits) projectedKeys.push('agents'); if (limits?.maxAcceptedChildren !== undefined) projectedKeys.push('agents.max_accepted_children'); if (limits?.maxConcurrentThreadsPerSession !== undefined) projectedKeys.push('agents.max_concurrent_threads_per_session'); if (limits?.maxDepth !== undefined) projectedKeys.push('agents.max_depth');
	const config = projectAgentConfig({ developerInstructions: 'developer', ...(limits?.maxAcceptedChildren === undefined ? {} : { agentMaxAcceptedChildren: limits.maxAcceptedChildren }), ...(limits?.maxConcurrentThreadsPerSession === undefined ? {} : { agentMaxConcurrentThreadsPerSession: limits.maxConcurrentThreadsPerSession }), ...(limits?.maxDepth === undefined ? {} : { agentMaxDepth: limits.maxDepth }) }, undefined, [{ uri: 'file:///home/.codex/config.toml', scope: 'user', status: 'loaded', projectedKeys }], owner, owner);
	const candidates = [{ uri: URI.joinPath(URI.parse(owner), 'AGENTS.md').toString(), outcome: Object.freeze({ status: 'bytes' as const, bytes: bytes('agents') }) }];
	return resolveAgentInstructions(config, candidates, stableAgentInstructionRevision(config, candidates));
};
const catalog = (owner = 'file:///workspace') => {
	const root = URI.joinPath(URI.parse(owner), '.agents/skills');
	return createSkillCatalog(['demo', 'other'].map((name, rank) => ({ source: 'repository' as const, rank, root: root.toString(), skillRoot: URI.joinPath(root, name).toString(), directoryName: name, bytes: bytes(skillText(name)) })));
};
const snapshot = (selected: string[] = [], owner = 'file:///workspace', modelName = 'gpt-4.1', limits?: { maxAcceptedChildren?: number; maxConcurrentThreadsPerSession?: number; maxDepth?: number }) => {
	const value = catalog(owner);
	return createAgentRuntimeTurnSnapshot(instructions(owner, limits), value, skillAdvertisement(value, 10_000), selected.map(identity => { const skill = value.skills.find(item => item.identity === identity)!; return { identity, skillRoot: skill.provenance.skillRoot, bodyRevision: skill.bodyRevision, body: skillText(identity) }; }), { hasModel: true, providerName: 'openAI', modelName, contextWindow: 10_000, reservedOutputTokens: 1_000, modelSelectionOptions: { reasoningEnabled: true }, selectedModelOverrides: { temperature: .2 } }, true);
};

type FixtureOverrides = {
	owner?: string;
	trusted?: boolean;
	liveSettings?: any;
	readSkillBody?: (root: string, revision: string) => Promise<any>;
	readSkillResource?: (selection: any, path: string, options: any) => Promise<any>;
	resolve?: (uri: URI) => Promise<any>;
	prepare?: (options: any) => Promise<any>;
	send?: (options: any, turn: number) => string | null;
	abort?: (request?: string) => void;
	callTool?: (name: string, params: any, context: any) => Promise<any>;
	stringOfResult?: (name: string, params: any, result: any, context: any) => string;
	customCatalog?: any;
	settingsState?: any;
	broker?: any;
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
	const requests = new Map<string, any[]>();
	const llm: any = {
		captureSettingsOfProvider: () => JSON.parse(JSON.stringify(liveSettings)),
		sendLLMMessage(options: any) { providerCalls.push(options); const request = overrides.send?.(options, providerCalls.length) ?? `request-${providerCalls.length}`; if (request) { const values = requests.get(request) ?? []; values.push(options); requests.set(request, values); } return request; },
		abort(request?: string) { aborts++; overrides.abort?.(request); requests.get(request ?? '')?.shift()?.onAbort(); },
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
	const skills: any = { readSkillBody: overrides.readSkillBody ?? (async (root: string) => ({ body: skillText(root.endsWith('/other') ? 'other' : 'demo') })), readSkillResource: overrides.readSkillResource ?? (async () => ({ body: '' })) };
	const customAgents: any = { getCatalog: async () => overrides.customCatalog ?? ({ revision: 'empty', agents: [], diagnostics: [] }) };
	const settings: any = { state: overrides.settingsState ?? { settingsOfProvider: liveSettings, optionsOfModelSelection: { Chat: { openAI: {} } }, overridesOfModel: {} } };
	const broker = overrides.broker ?? { execute: async () => ({ ok: true as const, content: 'brokered' }), async cancel() { } };
	const service = new AgentSubagentService(llm, tools, file, workspace, trust, converter, skills, customAgents, settings);
	service.onDidChangeRun(event => events.push(event));
	return { service, customAgents, settings, broker, providerCalls, converterCalls, toolCalls, invalidations, events, liveSettings, setOwner: (value: string) => owner = value, setTrusted: (value: boolean) => trusted = value, aborts: () => aborts };
};
const final = (options: any, text = 'done') => queueMicrotask(() => options.onFinalMessage({ fullText: text, fullReasoning: '', anthropicReasoning: null }));
const toolThenFinal = (tool: { id: string; name: string; rawParams: Record<string, unknown> }) => (options: any, turn: number) => { queueMicrotask(() => turn === 1 ? options.onFinalMessage({ fullText: 'tool', fullReasoning: '', anthropicReasoning: null, toolCall: tool }) : options.onFinalMessage({ fullText: 'done', fullReasoning: '', anthropicReasoning: null })); return `request-${turn}`; };
const bindManualApproval = (receiver: any) => {
	receiver._parentRunTokenOfThread ??= new Map();
	receiver._toolsService ??= {}; receiver._toolsService.invalidateReadReceipts ??= (_threadId: string) => { };
	receiver._childToolApprovals = new Map(); receiver._onDidChangeChildToolApprovals = { fire() { } };
	for (const name of ['_awaitChildToolApproval', '_cancelChildToolApproval', '_cancelChildToolApprovalsForParent', '_decideChildToolApproval', 'approveChildToolApproval', 'rejectChildToolApproval', 'getChildToolApprovals'] as const) receiver[name] = (...args: any[]) => (ChatThreadService.prototype as any)[name].call(receiver, ...args);
};

suite('Void AgentSubagentService', () => {
	test('removes the exact empty sentinel from child continuation history, outbound request, and summary', async () => {
		const f = fixture({
			callTool: async () => ({ entries: [] }),
			send: (options, turn) => {
				queueMicrotask(() => options.onFinalMessage(turn === 1
					? { fullText: INTERNAL_EMPTY_MESSAGE_SENTINEL, fullReasoning: '', anthropicReasoning: null, toolCall: { id: 'tool-1', name: 'ls_dir', rawParams: { uri: 'file:///workspace' } } }
					: { fullText: INTERNAL_EMPTY_MESSAGE_SENTINEL, fullReasoning: '', anthropicReasoning: null }));
				return `sentinel-${turn}`;
			},
		});
		const converter = new ConvertToLLMMessageService(
			{ getModels: () => [] } as never,
			{ getWorkspace: () => ({ folders: [] }) } as never,
			{ activeEditor: undefined } as never,
			{ getAllDirectoriesStr: async () => '' } as never,
			{ listPersistentTerminalIds: () => [] } as never,
			{ state: { overridesOfModel: {}, globalSettings: {}, optionsOfModelSelection: { Chat: { openAI: {} } } } } as never,
			{ getMCPTools: () => [] } as never,
		);
		(converter as any)._generateChatMessagesSystemMessage = async () => 'child fixture system';
		const injected = await converter.prepareLLMChatMessages({
			chatMessages: [
				{ role: 'user', content: 'inspect', displayContent: 'inspect', selections: [], state: { stagingSelections: [], isBeingEdited: false } },
				{ role: 'assistant', displayContent: INTERNAL_EMPTY_MESSAGE_SENTINEL, reasoning: '', anthropicReasoning: null },
				{ role: 'tool', type: 'success', content: '[]', id: 'injected-tool', rawParams: { uri: 'file:///workspace' }, mcpServerName: undefined, name: 'ls_dir', params: { uri: 'file:///workspace' }, result: [] },
			] as any,
			chatMode: 'agent',
			modelSelection: { providerName: 'openAI', modelName: 'gpt-4.1' },
			instructionSnapshot: snapshot(),
		});
		assert.strictEqual(JSON.stringify(injected.messages).includes(INTERNAL_EMPTY_MESSAGE_SENTINEL), false);
		assert.strictEqual((injected.messages.find((message: any) => message.role === 'assistant') as any).content, '');
		const converted: any[] = [];
		(f.service as any).converter = { prepareLLMChatMessages: async (options: any) => { const value = await converter.prepareLLMChatMessages(options); converted.push({ history: options.chatMessages, value }); return value; } };

		await f.service.spawn('sentinel-child', 'inspect', snapshot());
		const waited = await f.service.wait('sentinel-child', 1_000);
		assert.strictEqual(f.providerCalls.length, 2);
		assert.strictEqual(converted.length, 2);
		assert.strictEqual(JSON.stringify(converted).includes(INTERNAL_EMPTY_MESSAGE_SENTINEL), false);
		assert.strictEqual(JSON.stringify(f.providerCalls[1].messages).includes(INTERNAL_EMPTY_MESSAGE_SENTINEL), false);
		const outboundAssistant = f.providerCalls[1].messages.find((message: any) => message.role === 'assistant');
		assert.strictEqual(outboundAssistant.content, '');
		assert.deepStrictEqual(outboundAssistant.tool_calls, [{ type: 'function', id: 'tool-1', function: { name: 'ls_dir', arguments: '{"uri":"file:///workspace"}' } }]);
		assert.strictEqual(f.service.getRunView('sentinel-child')?.summary, undefined);
		assert.strictEqual(waited.receipt?.summary, '');

		const surrounding = `keep ${INTERNAL_EMPTY_MESSAGE_SENTINEL} as text`;
		const preserved = fixture({ send: options => { final(options, surrounding); return 'surrounding'; } });
		await preserved.service.spawn('surrounding-child', 'inspect', snapshot());
		const preservedWait = await preserved.service.wait('surrounding-child', 1_000);
		assert.strictEqual(preservedWait.receipt?.summary, surrounding);
	});

	test('broker cancellation before write preparation settles without a mutation', async () => {
		const runtime = snapshot(); const parentTools = captureParentModelToolSnapshot('agent', [], true); const authority: any = Object.freeze({ allowed: true, generation: 4, runtimeSnapshot: runtime, parentTools, autoApprove: Object.freeze({ edits: true, terminal: true, mcp: true }) });
		let prepared = 0, executed = 0, releasePrepare!: (value: any) => void; const prepare = new Promise<any>(resolve => releasePrepare = resolve);
		const receiver: any = { state: { allThreads: { parent: { messages: [], state: {}, filesWithUserChanges: new Set() } } }, _instructionTurnOfThread: new Map([['parent', runtime]]), _agentDelegationAuthorityOfThread: new Map([['parent', authority]]), _agentControlGeneration: new Map([['parent', 4]]), _workspaceContextService: { getWorkspace: () => ({ folders: [{ uri: URI.parse('file:///workspace') }] }) }, _workspaceTrustManagementService: { isWorkspaceTrusted: () => true }, _mcpService: { getMCPTools: () => [], callMCPTool() { throw new Error('must_not_run'); }, stringifyResult: () => '' }, _toolsService: { validateParams: { write_file: (raw: any) => raw }, prepareWriteFile: async () => { prepared++; return prepare; }, stringOfResult: { write_file: () => 'written' } } };
		const broker = (ChatThreadService.prototype as any)._createAgentSubagentToolBroker.call(receiver, 'parent', authority);
		const write = parentTools.tools.find(tool => tool.name === 'write_file')!; const request: any = Object.freeze({ parentId: 'parent', generation: 4, childId: 'child', toolId: 'write', name: 'write_file', tool: write, rawParams: Object.freeze({ uri: 'file:///workspace/a', content: 'gamma' }), snapshotRevision: parentTools.revision, maxReadOutputTokens: 10, cancellationToken: { isCancellationRequested: false } });
		const pending = broker.execute(request); await Promise.resolve(); const acknowledgement = broker.cancel(request); let acknowledged = false; void acknowledgement.then(() => acknowledged = true); await Promise.resolve(); assert.strictEqual(prepared, 1); assert.strictEqual(acknowledged, false); releasePrepare({ execute: async () => { executed++; return {}; } }); assert.strictEqual((await pending).ok, false); await acknowledgement; assert.strictEqual(executed, 0, 'cancellation before execute must create no mutation or Undo element');
	});

	test('broker rejects invalid frozen builtin params before publishing approval', async () => {
		const runtime = snapshot(); const parentTools = captureParentModelToolSnapshot('agent', [], true); const authority: any = Object.freeze({ allowed: true, generation: 4, runtimeSnapshot: runtime, parentTools, autoApprove: Object.freeze({ edits: false, terminal: false, mcp: false }) });
		let validations = 0, prepared = 0;
		const receiver: any = { state: { allThreads: { parent: { messages: [], state: {}, filesWithUserChanges: new Set() } } }, _instructionTurnOfThread: new Map([['parent', runtime]]), _agentDelegationAuthorityOfThread: new Map([['parent', authority]]), _agentControlGeneration: new Map([['parent', 4]]), _workspaceContextService: { getWorkspace: () => ({ folders: [{ uri: URI.parse('file:///workspace') }] }) }, _workspaceTrustManagementService: { isWorkspaceTrusted: () => true }, _mcpService: { getMCPTools: () => [], stringifyResult: () => '' }, _toolsService: { validateParams: { write_file: () => { validations++; throw new Error('invalid write'); } }, prepareWriteFile: async () => { prepared++; return undefined; }, stringOfResult: { write_file: () => '' } } };
		const broker = (ChatThreadService.prototype as any)._createAgentSubagentToolBroker.call(receiver, 'parent', authority);
		const write = parentTools.tools.find(tool => tool.name === 'write_file')!; const request: any = Object.freeze({ parentId: 'parent', generation: 4, childId: 'child', toolId: 'write-invalid', name: 'write_file', tool: write, rawParams: Object.freeze({}), snapshotRevision: parentTools.revision, maxReadOutputTokens: 10, cancellationToken: { isCancellationRequested: false } });
		assert.deepStrictEqual(await broker.execute(request), { ok: false, error: 'invalid_params' }); assert.strictEqual(validations, 1); assert.strictEqual(prepared, 0);
	});

	test('broker manually approves or rejects validated edit, terminal, and MCP calls exactly once', async () => {
		const runtime = snapshot(); const mcp = { name: 'captured_mcp', description: 'Captured.', mcpServerName: 'server-a', params: {}, schema: { type: 'object' } }; const parentTools = captureParentModelToolSnapshot('agent', [mcp], true); const authority: any = Object.freeze({ allowed: true, generation: 4, runtimeSnapshot: runtime, parentTools, autoApprove: Object.freeze({ edits: false, terminal: false, mcp: false }) });
		const validations: string[] = []; let writes = 0, terminals = 0, mcpCalls = 0;
		const receiver: any = { state: { allThreads: { parent: { messages: [], state: {}, filesWithUserChanges: new Set() } } }, _instructionTurnOfThread: new Map([['parent', runtime]]), _agentDelegationAuthorityOfThread: new Map([['parent', authority]]), _agentControlGeneration: new Map([['parent', 4]]), _workspaceContextService: { getWorkspace: () => ({ folders: [{ uri: URI.parse('file:///workspace') }] }) }, _workspaceTrustManagementService: { isWorkspaceTrusted: () => true }, _mcpService: { getMCPTools: () => [mcp], async callMCPTool() { mcpCalls++; return { result: { ok: true } }; }, stringifyResult: () => 'mcp-result' }, _toolsService: { validateParams: { write_file: (raw: any) => { validations.push('write'); return raw; }, run_command: (raw: any) => { validations.push('terminal'); return raw; } }, prepareWriteFile: async () => ({ execute: async () => { writes++; return {}; } }), callTool: { run_command: async () => { terminals++; return { result: {} }; } }, stringOfResult: { write_file: () => '', run_command: () => 'terminal-result' } } };
		bindManualApproval(receiver); const broker = (ChatThreadService.prototype as any)._createAgentSubagentToolBroker.call(receiver, 'parent', authority); const request = (name: string, toolId: string, rawParams: any) => Object.freeze({ parentId: 'parent', generation: 4, childId: 'child', toolId, name, tool: parentTools.tools.find(tool => tool.name === name)!, rawParams: Object.freeze(rawParams), snapshotRevision: parentTools.revision, maxReadOutputTokens: 10, cancellationToken: { isCancellationRequested: false } });
		for (const item of [request('write_file', 'write', { uri: 'file:///workspace/a', content: 'x' }), request('run_command', 'terminal', { command: 'dir' }), request('captured_mcp', 'mcp', {})]) { const pending = broker.execute(item); await Promise.resolve(); const approval = [...receiver._childToolApprovals.values()][0].view; assert.strictEqual(receiver.rejectChildToolApproval(approval.key), true); assert.strictEqual(receiver.rejectChildToolApproval(approval.key), false); assert.deepStrictEqual(await pending, { ok: false, error: 'rejected' }); }
		const approved = request('write_file', 'write-approved', { uri: 'file:///workspace/a', content: 'x' }); const approvedPending = broker.execute(approved); await Promise.resolve(); const approval = [...receiver._childToolApprovals.values()][0].view; assert.strictEqual(receiver.approveChildToolApproval(approval.key), true); assert.deepStrictEqual((await approvedPending).ok, true); assert.strictEqual(receiver.approveChildToolApproval(approval.key), false);
		for (const item of [request('run_command', 'terminal-approved', { command: 'dir' }), request('captured_mcp', 'mcp-approved', {})]) { const pending = broker.execute(item); await Promise.resolve(); const view = [...receiver._childToolApprovals.values()][0].view; assert.strictEqual(receiver.approveChildToolApproval(view.key), true); assert.strictEqual((await pending).ok, true); }
		assert.deepStrictEqual(validations, ['write', 'terminal', 'write', 'terminal']); assert.strictEqual(writes, 1); assert.strictEqual(terminals, 1); assert.strictEqual(mcpCalls, 1);
	});

	test('manual approval is frozen per turn, survives task switching, and cancellation or revocation removes it', async () => {
		const runtime = snapshot(); const parentTools = captureParentModelToolSnapshot('agent', [], true); const liveAutoApprove = { edits: false, terminal: false, mcp: false }; const authority: any = Object.freeze({ allowed: true, generation: 4, runtimeSnapshot: runtime, parentTools, autoApprove: Object.freeze({ ...liveAutoApprove }) }); let terminals = 0;
		const receiver: any = { state: { allThreads: { parent: { messages: [], state: {}, filesWithUserChanges: new Set() }, other: { messages: [], state: {}, filesWithUserChanges: new Set() } }, currentThreadId: 'parent' }, _setState(value: any) { this.state = { ...this.state, ...value }; }, _instructionTurnOfThread: new Map([['parent', runtime]]), _agentDelegationAuthorityOfThread: new Map([['parent', authority]]), _agentControlGeneration: new Map([['parent', 4]]), _workspaceContextService: { getWorkspace: () => ({ folders: [{ uri: URI.parse('file:///workspace') }] }) }, _workspaceTrustManagementService: { isWorkspaceTrusted: () => true }, _mcpService: { getMCPTools: () => [], stringifyResult: () => '' }, _toolsService: { validateParams: { run_command: (raw: any) => raw }, callTool: { run_command: async () => { terminals++; return { result: {} }; } }, stringOfResult: { run_command: () => 'done' } }, _agentSubagentService: { cancelParent() { }, forgetParent() { } } };
		bindManualApproval(receiver); const broker = (ChatThreadService.prototype as any)._createAgentSubagentToolBroker.call(receiver, 'parent', authority); const tool = parentTools.tools.find(tool => tool.name === 'run_command')!; const request = (toolId: string): any => Object.freeze({ parentId: 'parent', generation: 4, childId: 'child', toolId, name: 'run_command', tool, rawParams: Object.freeze({ command: 'dir' }), snapshotRevision: parentTools.revision, maxReadOutputTokens: 10, cancellationToken: { isCancellationRequested: false } });
		const pending = broker.execute(request('frozen-manual')); await Promise.resolve(); liveAutoApprove.terminal = true; assert.strictEqual(receiver.getChildToolApprovals('parent').length, 1); assert.strictEqual(receiver.getChildToolApprovals('other').length, 0); (ChatThreadService.prototype as any).switchToThread.call(receiver, 'other'); assert.strictEqual(receiver.state.currentThreadId, 'other'); assert.strictEqual(receiver.getChildToolApprovals('parent').length, 1); const cancellation = broker.cancel(request('frozen-manual')); assert.deepStrictEqual(await pending, { ok: false, error: 'cancelled' }); await cancellation; assert.strictEqual(receiver.getChildToolApprovals('parent').length, 0); assert.strictEqual(terminals, 0);
		const pendingRevoked = broker.execute(request('revoked')); await Promise.resolve(); assert.strictEqual(receiver.getChildToolApprovals('parent').length, 1); (ChatThreadService.prototype as any)._revokeAgentDelegation.call(receiver, 'parent'); assert.deepStrictEqual(await pendingRevoked, { ok: false, error: 'cancelled' }); assert.strictEqual(receiver.getChildToolApprovals('parent').length, 0);
		const autoAuthority: any = Object.freeze({ ...authority, generation: 6, autoApprove: Object.freeze({ edits: false, terminal: true, mcp: false }) }); receiver._instructionTurnOfThread.set('parent', runtime); receiver._agentDelegationAuthorityOfThread.set('parent', autoAuthority); receiver._agentControlGeneration.set('parent', 6); liveAutoApprove.terminal = false; const autoBroker = (ChatThreadService.prototype as any)._createAgentSubagentToolBroker.call(receiver, 'parent', autoAuthority); const autoRequest: any = Object.freeze({ ...request('auto'), generation: 6 }); assert.strictEqual((await autoBroker.execute(autoRequest)).ok, true); assert.strictEqual(receiver.getChildToolApprovals('parent').length, 0); assert.strictEqual(terminals, 1);
	});

	test('broker rejects concurrent and settled exact replay with one terminal side effect and interrupt', async () => {
		const runtime = snapshot(); const parentTools = captureParentModelToolSnapshot('agent', [], true); const authority: any = Object.freeze({ allowed: true, generation: 4, runtimeSnapshot: runtime, parentTools, autoApprove: Object.freeze({ edits: true, terminal: true, mcp: true }) });
		let calls = 0, interrupts = 0, release!: (value: unknown) => void; const result = new Promise<unknown>(resolve => release = resolve);
		const receiver: any = { state: { allThreads: { parent: { messages: [], state: {}, filesWithUserChanges: new Set() } } }, _instructionTurnOfThread: new Map([['parent', runtime]]), _agentDelegationAuthorityOfThread: new Map([['parent', authority]]), _agentControlGeneration: new Map([['parent', 4]]), _workspaceContextService: { getWorkspace: () => ({ folders: [{ uri: URI.parse('file:///workspace') }] }) }, _workspaceTrustManagementService: { isWorkspaceTrusted: () => true }, _mcpService: { getMCPTools: () => [], stringifyResult: () => '' }, _toolsService: { validateParams: { run_command: (raw: any) => raw }, callTool: { run_command: async () => { calls++; return { result, interruptTool: () => { interrupts++; } }; } }, stringOfResult: { run_command: () => 'done' } } };
		const broker = (ChatThreadService.prototype as any)._createAgentSubagentToolBroker.call(receiver, 'parent', authority); const tool = parentTools.tools.find(tool => tool.name === 'run_command')!; const request = (raw: any = {}) => Object.freeze({ parentId: 'parent', generation: 4, childId: 'child', toolId: 'same-tool', name: 'run_command', tool, rawParams: Object.freeze(raw), snapshotRevision: parentTools.revision, maxReadOutputTokens: 10, cancellationToken: { isCancellationRequested: false } });
		const first = broker.execute(request()); await Promise.resolve(); assert.deepStrictEqual(await broker.execute(request()), { ok: false, error: 'tool_replayed' }); assert.strictEqual(calls, 1);
		const cancelled = broker.cancel(request()); await Promise.resolve(); assert.strictEqual(interrupts, 1); release({}); assert.deepStrictEqual(await first, { ok: false, error: 'cancelled' }); await cancelled;
		assert.deepStrictEqual(await broker.execute(request()), { ok: false, error: 'tool_replayed' }); assert.strictEqual(calls, 1); assert.strictEqual(interrupts, 1);
	});

	test('broker terminal cancellation interrupts exactly once and acknowledges only after its result settles', async () => {
		const runtime = snapshot(); const parentTools = captureParentModelToolSnapshot('agent', [], true); const authority: any = Object.freeze({ allowed: true, generation: 4, runtimeSnapshot: runtime, parentTools, autoApprove: Object.freeze({ edits: true, terminal: true, mcp: true }) });
		let interrupts = 0, release!: (value: unknown) => void; const result = new Promise<unknown>(resolve => release = resolve);
		const receiver: any = { state: { allThreads: { parent: { messages: [], state: {}, filesWithUserChanges: new Set() } } }, _instructionTurnOfThread: new Map([['parent', runtime]]), _agentDelegationAuthorityOfThread: new Map([['parent', authority]]), _agentControlGeneration: new Map([['parent', 4]]), _workspaceContextService: { getWorkspace: () => ({ folders: [{ uri: URI.parse('file:///workspace') }] }) }, _workspaceTrustManagementService: { isWorkspaceTrusted: () => true }, _mcpService: { getMCPTools: () => [], stringifyResult: () => '' }, _toolsService: { validateParams: { run_command: (raw: any) => raw }, callTool: { run_command: async () => ({ result, interruptTool: () => { interrupts++; } }) }, stringOfResult: { run_command: () => 'done' } } };
		const broker = (ChatThreadService.prototype as any)._createAgentSubagentToolBroker.call(receiver, 'parent', authority); const tool = parentTools.tools.find(tool => tool.name === 'run_command')!; const request: any = Object.freeze({ parentId: 'parent', generation: 4, childId: 'child', toolId: 'terminal', name: 'run_command', tool, rawParams: Object.freeze({ command: 'dir' }), snapshotRevision: parentTools.revision, maxReadOutputTokens: 10, cancellationToken: { isCancellationRequested: false } });
		const pending = broker.execute(request); await Promise.resolve(); const acknowledgement = broker.cancel(request); let acknowledged = false; void acknowledgement.then(() => acknowledged = true); await Promise.resolve(); assert.strictEqual(interrupts, 1); assert.strictEqual(acknowledged, false); release({}); assert.deepStrictEqual(await pending, { ok: false, error: 'cancelled' }); await acknowledgement; assert.strictEqual(interrupts, 1);
	});

	test('broker MCP cancellation acknowledges only after the MCP settlement and fences its late result', async () => {
		const runtime = snapshot(); const mcp = { name: 'captured_mcp', description: 'Captured.', mcpServerName: 'server-a', params: {}, schema: { type: 'object' } }; const parentTools = captureParentModelToolSnapshot('agent', [mcp], true); const authority: any = Object.freeze({ allowed: true, generation: 4, runtimeSnapshot: runtime, parentTools, autoApprove: Object.freeze({ edits: true, terminal: true, mcp: true }) });
		let release!: (value: any) => void; const settlement = new Promise<any>(resolve => release = resolve);
		const receiver: any = { state: { allThreads: { parent: { messages: [], state: {}, filesWithUserChanges: new Set() } } }, _instructionTurnOfThread: new Map([['parent', runtime]]), _agentDelegationAuthorityOfThread: new Map([['parent', authority]]), _agentControlGeneration: new Map([['parent', 4]]), _workspaceContextService: { getWorkspace: () => ({ folders: [{ uri: URI.parse('file:///workspace') }] }) }, _workspaceTrustManagementService: { isWorkspaceTrusted: () => true }, _mcpService: { getMCPTools: () => [mcp], callMCPTool: () => settlement, stringifyResult: () => 'late' }, _toolsService: { validateParams: {}, callTool: {}, stringOfResult: {} } };
		const broker = (ChatThreadService.prototype as any)._createAgentSubagentToolBroker.call(receiver, 'parent', authority); const tool = parentTools.tools.find(tool => tool.name === 'captured_mcp')!; const request: any = Object.freeze({ parentId: 'parent', generation: 4, childId: 'child', toolId: 'mcp', name: 'captured_mcp', tool, rawParams: Object.freeze({}), snapshotRevision: parentTools.revision, maxReadOutputTokens: 10, cancellationToken: { isCancellationRequested: false } });
		const pending = broker.execute(request); await Promise.resolve(); const acknowledgement = broker.cancel(request); let acknowledged = false; void acknowledgement.then(() => acknowledged = true); await Promise.resolve(); assert.strictEqual(acknowledged, false); release({ result: { ok: true } }); assert.deepStrictEqual(await pending, { ok: false, error: 'cancelled' }); await acknowledgement;
	});

	test('MCPService.getMCPTools preserves the exact production inputSchema for a captured child tool', () => {
		const descriptor = getSingletonServiceDescriptors().find(([id]) => id === IMCPService)?.[1];
		assert.ok(descriptor, 'MCP service must be registered before its production schema can be captured');
		const mcp = Object.create(descriptor.ctor.prototype) as { state: any; getMCPTools(): any[] | undefined };
		const schema = Object.freeze({ type: 'object', properties: { exact: { type: 'string', description: 'Do not widen.' } }, required: ['exact'], additionalProperties: false });
		mcp.state = { mcpServerOfName: { 'server-a': { tools: [{ name: 'schema_mcp', description: 'Schema.', inputSchema: schema }] } }, error: undefined };
		const tools = mcp.getMCPTools();
		assert.ok(tools);
		const parentTools = captureParentModelToolSnapshot('agent', tools, true);
		const entry = parentTools.tools.find(tool => tool.name === 'schema_mcp')!;
		assert.strictEqual(tools![0].schema, schema); assert.deepStrictEqual(entry.schema, schema); assert.strictEqual(entry.kind, 'mcp'); assert.strictEqual(entry.mcpServerName, 'server-a');
	});

	test('real child write_file broker uses a child receipt, editor transaction, save, and one Undo element', async () => {
		const uri = URI.parse('file:///workspace/note.txt');
		const model = createTextModel('alpha\nbeta', null, undefined, uri);
		const undoRedo = new UndoRedoService(new TestDialogService(), new TestNotificationService());
		const saved: Uint8Array[] = [];
		const voidModels: any = {
			initializeModel: async () => { }, getModelSafe: async () => ({ model }), getModel: () => ({ model }),
			saveModel: async () => { saved.push(new TextEncoder().encode(model.getValue())); },
		};
		const editDescriptor = getSingletonServiceDescriptors().find(([id]) => id === IEditCodeService)?.[1];
		assert.ok(editDescriptor, 'editCodeService side-effect registration must be loaded');
		const editCode = new editDescriptor.ctor(
			{ listCodeEditors: () => [], onCodeEditorAdd: Event.None }, { getModels: () => [model], onModelAdded: Event.None }, undoRedo,
			{}, { addConsistentItemToURI: () => 'none', removeConsistentItemFromURI: () => { } }, { createInstance: () => ({}), invokeFunction: () => undefined },
			{ addToEditor: () => 'none', removeFromEditor: () => { } }, { capture: () => { } }, new TestNotificationService(),
			{ state: { globalSettings: { autoAcceptLLMChanges: false } } }, voidModels, {},
		);
		const safeFile: any = { resolve: async (value: URI) => ({ resource: value, isSymbolicLink: false, isDirectory: true }), stat: async (value: URI) => ({ resource: value, isSymbolicLink: false, size: model.getValueLength() }) };
		const tools = new ToolsService(safeFile, { getWorkspace: () => ({ folders: [{ uri: URI.parse('file:///workspace') }] }) } as never, {} as never, { search: async () => ({ ok: false, code: 'search_backend_unavailable', trace: 'terminal-fallback-unavailable' }) } as never, { createInstance: () => ({}) } as never, voidModels, { state: { globalSettings: {} } } as never, editCode, {} as never, { getStreamState: () => undefined } as never, {} as never, { read: () => [] } as never);
		const childContext: any = { ownerThreadId: 'child', childId: 'child', ownerRoot: URI.parse('file:///workspace'), maxReadOutputTokens: 1024, maxFileSize: 1_048_576, maxResults: 100 };
		const read = await tools.callTool.read_file({ uri, startLine: 1, endLine: null, lineByteOffset: 0 }, childContext);
		const receipt = (await read.result).receipt.id;
		const params: any = { uri, operation: 'modify', readReceiptId: receipt, edits: [{ oldText: 'beta', newText: 'gamma' }] };
		await assert.rejects(() => tools.prepareWriteFile(params, 'wrong-parent'), /stale_read/);
		const runtime = snapshot(); const parentTools = captureParentModelToolSnapshot('agent', [], true);
		const authority: any = Object.freeze({ allowed: true, generation: 4, runtimeSnapshot: runtime, parentTools, autoApprove: Object.freeze({ edits: false, terminal: false, mcp: false }) });
		const approvalEvents: number[] = []; const receiver: any = { state: { allThreads: { parent: { messages: [], state: {}, filesWithUserChanges: new Set() } } }, streamState: {}, _instructionTurnOfThread: new Map([['parent', runtime]]), _agentDelegationAuthorityOfThread: new Map([['parent', authority]]), _agentControlGeneration: new Map([['parent', 4]]), _workspaceContextService: { getWorkspace: () => ({ folders: [{ uri: URI.parse('file:///workspace') }] }) }, _workspaceTrustManagementService: { isWorkspaceTrusted: () => true }, _mcpService: { getMCPTools: () => [], stringifyResult: () => '' }, _toolsService: tools };
		bindManualApproval(receiver); receiver._onDidChangeChildToolApprovals = { fire: () => approvalEvents.push(receiver._childToolApprovals.size) };
		const broker = (ChatThreadService.prototype as any)._createAgentSubagentToolBroker.call(receiver, 'parent', authority);
		const write = parentTools.tools.find(tool => tool.name === 'write_file')!;
		const request = (toolId: string): any => Object.freeze({ parentId: 'parent', generation: 4, childId: 'child', toolId, name: 'write_file', tool: write, rawParams: Object.freeze({ uri: uri.toString(), operation: 'modify', read_receipt_id: receipt, edits: [{ old_text: 'beta', new_text: 'gamma' }] }), snapshotRevision: parentTools.revision, maxReadOutputTokens: 1024, cancellationToken: { isCancellationRequested: false } });
		const rejectedPending = broker.execute(request('write-reject')); await Promise.resolve(); const rejectedView = [...receiver._childToolApprovals.values()][0].view; assert.strictEqual(receiver.rejectChildToolApproval(rejectedView.key), true); assert.strictEqual(receiver.approveChildToolApproval(rejectedView.key), false); assert.deepStrictEqual(await rejectedPending, { ok: false, error: 'rejected' }); assert.strictEqual(model.getValue(), 'alpha\nbeta'); assert.strictEqual(saved.length, 0); assert.strictEqual(undoRedo.getElements(uri).past.length, 0);
		const pending = broker.execute(request('write-approve')); await Promise.resolve(); const approvalView = [...receiver._childToolApprovals.values()][0].view; for (const field of ['parentId', 'generation', 'childId', 'toolId', 'snapshotRevision'] as const) { const wrong = { ...approvalView.key, [field]: field === 'generation' ? 5 : `${approvalView.key[field]}-wrong` }; assert.strictEqual(receiver.approveChildToolApproval(wrong), false); assert.strictEqual(receiver._childToolApprovals.size, 1); } assert.strictEqual(receiver.approveChildToolApproval(approvalView.key), true); assert.strictEqual(receiver.rejectChildToolApproval(approvalView.key), false); const result = await pending;
		assert.deepStrictEqual(result, { ok: true, content: JSON.stringify({ operation: 'modify', didChange: true, editCount: 1 }), result: { operation: 'modify', didChange: true, editCount: 1 } });
		assert.deepStrictEqual(approvalEvents, [1, 0, 1, 0]); assert.strictEqual(receiver.state.allThreads.parent.messages.length, 0); assert.deepStrictEqual(receiver.streamState, {});
		assert.strictEqual(model.getValue(), 'alpha\ngamma'); assert.deepStrictEqual([...saved.at(-1)!], [...new TextEncoder().encode('alpha\ngamma')]); assert.strictEqual(undoRedo.getElements(uri).past.length, 1);
		await undoRedo.undo(uri);
		assert.strictEqual(model.getValue(), 'alpha\nbeta'); assert.deepStrictEqual([...saved.at(-1)!], [...new TextEncoder().encode('alpha\nbeta')]);
		model.dispose(); editCode.dispose();
	});

	test('real ChatThread inherited-write spawn routes an auto-approved captured MCP tool without parent contamination', async () => {
		const role: any = { identity: 'writer', name: 'writer', description: 'Write.', developerInstructions: 'role developer', model: 'o4-mini', modelReasoningEffort: 'medium', capabilityProfile: 'inherit_parent_write', revision: 'role-1', skillRules: [{ selector: 'demo', enabled: true }] };
		const roles: any = { revision: 'roles-1', agents: [role], diagnostics: [] }; const capturedMcp: any = { name: 'captured_mcp', description: 'Captured mutation.', mcpServerName: 'server-a', params: {}, schema: { type: 'object' } }; let mcpCalls = 0; let releaseMcp!: (value: any) => void; let markMcpCalled!: () => void; const mcpSettlement = new Promise<any>(resolve => releaseMcp = resolve); const mcpCalled = new Promise<void>(resolve => markMcpCalled = resolve);
		const f = fixture({ liveSettings: { openAI: { apiKey: 'captured-key', endpoint: 'https://captured.invalid', _didFillInProviderSettings: true, models: [{ modelName: 'gpt-4.1', isHidden: false, type: 'default' }, { modelName: 'o4-mini', isHidden: false, type: 'default' }] } }, customCatalog: roles, send: toolThenFinal({ id: 'captured-call', name: 'captured_mcp', rawParams: { change: 'one' } }) });
		const messages: any[] = []; let admitted: any; const thread: any = { messages, state: { stagingSelections: [] }, filesWithUserChanges: new Set<string>() };
		const receiver: any = { state: { allThreads: { parent: thread }, currentThreadId: 'parent' }, streamState: {}, _agentControlGeneration: new Map(), _parentRunTokenOfThread: new Map<string, symbol>(), _agentDelegationAuthorityOfThread: new Map(), _agentInstructionSessionOfThread: new Map(), _instructionTurnOfThread: new Map(), _agentSubagentService: f.service, _revokeAgentDelegation(threadId: string, forget = false) { return (ChatThreadService.prototype as any)._revokeAgentDelegation.call(this, threadId, forget); }, _createAgentSubagentToolBroker(threadId: string, authority: any) { return (ChatThreadService.prototype as any)._createAgentSubagentToolBroker.call(this, threadId, authority); }, _agentCustomAgentService: { getCatalog: async () => roles }, _currentModelSelectionProps: () => ({ modelSelection: { providerName: 'openAI', modelName: 'gpt-4.1' }, modelSelectionOptions: {} }), _settingsService: { state: { globalSettings: { chatMode: 'agent', autoApprove: { 'MCP tools': true } }, settingsOfProvider: f.liveSettings, optionsOfModelSelection: { Chat: { openAI: { 'o4-mini': { reasoningEnabled: true, reasoningEffort: 'medium' } } } }, overridesOfModel: { openAI: { 'gpt-4.1': { specialToolFormat: 'openai-style' }, 'o4-mini': { temperature: .7 } } } } }, _llmMessageService: { captureSettingsOfProvider: () => f.liveSettings }, _beginInstructionTurn: async () => instructions(), _purgeInstructionTurn() { }, _workspaceContextService: { getWorkspace: () => ({ folders: [{ uri: URI.parse('file:///workspace') }] }) }, _workspaceTrustManagementService: { isWorkspaceTrusted: () => true }, _agentSkillsService: { getCatalog: async () => catalog(), readSkillBody: async (root: string) => ({ body: skillText(root.endsWith('/other') ? 'other' : 'demo') }) }, _directoryStringService: {}, _fileService: {}, _rememberInstructionTurn(threadId: string, runtimeSnapshot: any) { this._instructionTurnOfThread.set(threadId, runtimeSnapshot); }, _addMessageToThread: (_: string, message: any) => messages.push(message), _runChatAgent: async ({ agentDelegationAuthority }: any) => { admitted = agentDelegationAuthority; }, _wrapRunAgentToNotify: (promise: Promise<void>) => promise, _toolsService: { invalidateReadReceipts() { }, validateParams: {} }, _mcpService: { getMCPTools: () => [capturedMcp], callMCPTool() { mcpCalls++; markMcpCalled(); return mcpSettlement; }, stringifyResult: () => 'captured' } };
		bindManualApproval(receiver);
		const selection = { type: 'Agent', label: 'Void application-level read-only', agentType: 'writer', catalogRevision: 'roles-1', roleRevision: 'role-1', state: undefined } as const;
		await (ChatThreadService.prototype as any)._addUserMessageAndStreamResponse.call(receiver, { userMessage: '$demo inspect', _chatSelections: [selection], threadId: 'parent' });
		assert.strictEqual(f.service.getRunView('parent'), undefined); assert.strictEqual(admitted?.allowed, true); assert.strictEqual(receiver.streamState.parent?.toolInfo, undefined);
		const generation = receiver._agentControlGeneration.get('parent'); receiver._agentDelegationAuthorityOfThread.set('parent', admitted);
		await (ChatThreadService.prototype as any)._runToolCall.call(receiver, 'parent', 'spawn_agent', 'spawn-id', undefined, { preapproved: false, unvalidatedToolParams: { message: '$demo inspect', agent_type: 'writer' } }, snapshot(), admitted, false, undefined, () => true);
		await Promise.race([mcpCalled, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('captured_mcp_timeout')), 1_000))]); assert.strictEqual(messages.some(message => message.role === 'tool' && (message.type === 'invalid_params' || /agent_delegation_not_authorized/.test(message.content))), false, JSON.stringify(messages)); const child = f.service.getRunView('parent')!; assert.strictEqual(child.roleName, 'writer'); assert.strictEqual(child.capabilityProfile, 'inherit_parent_write'); assert.ok(f.events.some(event => event.id === child.id)); assert.strictEqual(f.providerCalls[0].modelSelection.modelName, 'o4-mini'); assert.strictEqual(f.providerCalls[0].modelSelectionOptions.reasoningEffort, 'medium'); assert.strictEqual(mcpCalls, 1);
		await (ChatThreadService.prototype as any)._runToolCall.call(receiver, 'parent', 'wait_agent', 'wait-id', undefined, { preapproved: false, unvalidatedToolParams: { timeout_ms: 0, targets: [child.id] } }, snapshot(), admitted, false, undefined, () => true);
		assert.strictEqual(receiver._agentControlGeneration.get('parent'), generation); await (ChatThreadService.prototype as any)._runToolCall.call(receiver, 'parent', 'interrupt_agent', 'interrupt-id', undefined, { preapproved: false, unvalidatedToolParams: { target: child.id } }, snapshot(), admitted, false, undefined, () => true); releaseMcp({ result: { ok: true } }); await Promise.resolve(); assert.strictEqual(messages.some(message => message.role === 'tool' && message.type === 'invalid_params'), false, JSON.stringify(messages)); assert.strictEqual(f.service.getRunView('parent')?.status, 'cancelled'); assert.strictEqual(receiver.streamState.parent?.toolInfo, undefined); assert.strictEqual(messages.some(message => message.role === 'tool' && message.type === 'tool_request'), false);
	});
	test('keeps a bounded local diagnostic timeline separate from model-facing wait results', async () => {
		const f = fixture({ send: options => { final(options); return 'request'; } }); const changes: any[] = []; f.service.onDidChangeDiagnostics(event => changes.push(event));
		const child = await f.service.spawn('trace', '$demo inspect', snapshot(['demo'])); const result = await f.service.wait('trace', 1_000, [child.id]); const diagnostics = f.service.getDiagnosticsView('trace')!;
		assert.ok(diagnostics.events.some(event => event.kind === 'group_created')); assert.ok(diagnostics.events.some(event => event.kind === 'admission_started')); assert.ok(diagnostics.events.some(event => event.kind === 'child_queued' && event.childId === child.id)); assert.ok(diagnostics.events.some(event => event.kind === 'child_running' && event.childId === child.id)); assert.ok(diagnostics.events.some(event => event.kind === 'provider_send' && event.childId === child.id)); assert.strictEqual(diagnostics.events.filter(event => event.kind === 'child_completed' && event.childId === child.id).length, 1);
		assert.deepStrictEqual(diagnostics.events.map(event => event.sequence), diagnostics.events.map((_event, index) => index + 1)); assert.ok(diagnostics.events.every(event => event.elapsedMs >= 0)); assert.strictEqual(JSON.stringify(result).includes('diagnostics'), false); assert.ok(changes.length > 0);
		const view = f.service.getRunView('trace')!; assert.ok(view.queuedMs >= 0 && view.runningMs >= 0 && view.totalMs >= 0); assert.strictEqual(JSON.stringify(view.authority).includes('body-demo'), false); assert.strictEqual(JSON.stringify(view.authority).includes('file:///workspace'), false);
		const group = (f.service as any).groups.get('trace'); for (let index = 0; index < 130; index++) (f.service as any).trace(group, 'provider_send', undefined); const capped = f.service.getDiagnosticsView('trace')!; assert.strictEqual(capped.events.length, 128); assert.strictEqual(capped.droppedEvents, 9);
		f.service.forgetParent('trace'); assert.strictEqual(f.service.getDiagnosticsView('trace'), undefined);
	});

	test('records normalized failed admission without retaining a forgotten ledger', async () => {
		const f = fixture({ readSkillBody: async () => ({ diagnostic: { code: 'skill_stale' } }) }); await assert.rejects(() => f.service.spawn('admission-trace', '$demo inspect', snapshot()), /skill_stale/);
		const diagnostics = f.service.getDiagnosticsView('admission-trace')!; const failed = diagnostics.events.find(event => event.kind === 'admission_failed'); assert.strictEqual(failed?.diagnostic, 'skill_unavailable'); assert.strictEqual(JSON.stringify(failed).includes('skill_stale'), false);
		f.service.forgetParent('admission-trace'); assert.strictEqual(f.service.getDiagnosticsView('admission-trace'), undefined);
	});
	test('reserves four admissions, starts two, queues FIFO, and refunds terminal open capacity', async () => {
		const f = fixture({ send: () => 'request' });
		const children = await Promise.all(['one', 'two', 'three', 'four'].map(message => f.service.spawn('parent', message, snapshot())));
		assert.strictEqual(f.providerCalls.length, 2); assert.deepStrictEqual(f.service.getRunViews('parent').map(view => view.status), ['running', 'running', 'queued', 'queued']); assert.deepStrictEqual(f.service.getBudgetView('parent') && { maxAccepted: f.service.getBudgetView('parent')!.maxAccepted, maxConcurrent: f.service.getBudgetView('parent')!.maxConcurrent }, { maxAccepted: 4, maxConcurrent: 2 });
		await assert.rejects(() => f.service.spawn('parent', 'five', snapshot()), /agent_child_limit_reached/);
		f.service.interrupt('parent', children[0].id);
		await new Promise(resolve => setTimeout(resolve, 0)); // cancellation waits for the aborted provider promise to quiesce before freeing its scheduler slot.
		assert.strictEqual(f.providerCalls.length, 3); assert.deepStrictEqual(f.service.getRunViews('parent').map(view => view.status), ['cancelled', 'running', 'running', 'queued']);
		f.service.interrupt('parent', children[1].id);
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.strictEqual(f.providerCalls.length, 4); assert.deepStrictEqual(f.service.getRunViews('parent').map(view => view.status), ['cancelled', 'cancelled', 'running', 'running']);
		assert.deepStrictEqual(f.converterCalls.slice(0, 4).map(call => call.chatMessages[0].content), ['one', 'two', 'three', 'four']);
		await f.service.spawn('parent', 'five-after-terminal', snapshot());
	});

	test('freezes configured child limits per group generation and exposes them in the budget', async () => {
		const f = fixture({ send: () => 'request' });
		const one = snapshot([], 'file:///workspace', 'gpt-4.1', { maxAcceptedChildren: 1, maxConcurrentThreadsPerSession: 1, maxDepth: 1 });
		const eight = snapshot([], 'file:///workspace', 'gpt-4.1', { maxAcceptedChildren: 8, maxConcurrentThreadsPerSession: 4, maxDepth: 2 });
		await f.service.spawn('configured', 'one', one, undefined, undefined, undefined, undefined, 3);
		assert.deepStrictEqual(f.service.getBudgetView('configured') && { maxAccepted: f.service.getBudgetView('configured')!.maxAccepted, maxConcurrent: f.service.getBudgetView('configured')!.maxConcurrent }, { maxAccepted: 1, maxConcurrent: 1 });
		await assert.rejects(() => f.service.spawn('configured', 'live-change-must-not-expand', eight, undefined, undefined, undefined, undefined, 3), /agent_child_limit_reached/);
		await f.service.spawn('configured', 'new-generation-one', eight, undefined, undefined, undefined, undefined, 4);
		await Promise.all(['two', 'three', 'four'].map(message => f.service.spawn('configured', message, eight, undefined, undefined, undefined, undefined, 4)));
		assert.deepStrictEqual(f.service.getBudgetView('configured') && { accepted: f.service.getBudgetView('configured')!.accepted, maxAccepted: f.service.getBudgetView('configured')!.maxAccepted, maxConcurrent: f.service.getBudgetView('configured')!.maxConcurrent }, { accepted: 4, maxAccepted: 8, maxConcurrent: 4 });
		assert.strictEqual(f.providerCalls.length, 5);
	});

	test('gates nested child controls by remaining depth while sharing one root group budget', async () => {
		let calls = 0;
		const f = fixture({ send: options => { calls++; if (calls === 1) queueMicrotask(() => options.onFinalMessage({ fullText: 'delegate', fullReasoning: '', anthropicReasoning: null, toolCall: { id: 'nested-spawn', name: 'spawn_agent', rawParams: { message: 'grandchild' } } })); else queueMicrotask(() => options.onFinalMessage({ fullText: 'done', fullReasoning: '', anthropicReasoning: null })); return `request-${calls}`; } });
		await f.service.spawn('depth-two', 'top', snapshot([], 'file:///workspace', 'gpt-4.1', { maxAcceptedChildren: 2, maxConcurrentThreadsPerSession: 2, maxDepth: 2 }));
		await new Promise(resolve => setTimeout(resolve, 0));
		const runs = f.service.getRunViews('depth-two'); const top = runs.find(run => run.depth === 1)!; const nested = runs.find(run => run.depth === 2)!;
		assert.deepStrictEqual({ parentRunId: top.parentRunId, depth: top.depth, remainingDepth: top.remainingDepth }, { parentRunId: undefined, depth: 1, remainingDepth: 1 });
		assert.deepStrictEqual({ parentRunId: nested.parentRunId, depth: nested.depth, remainingDepth: nested.remainingDepth }, { parentRunId: top.id, depth: 2, remainingDepth: 0 });
		assert.strictEqual(f.providerCalls.some(call => call.agentDelegationAllowed === true), true); assert.strictEqual(f.providerCalls.some(call => call.agentDelegationAllowed === false), true);
		assert.strictEqual(f.converterCalls.some(call => call.agentDelegationAllowed === true), true); assert.strictEqual(f.converterCalls.some(call => call.agentDelegationAllowed === false), true);
		assert.deepStrictEqual(f.service.getBudgetView('depth-two') && { accepted: f.service.getBudgetView('depth-two')!.accepted, maxAccepted: f.service.getBudgetView('depth-two')!.maxAccepted, maxConcurrent: f.service.getBudgetView('depth-two')!.maxConcurrent }, { accepted: 0, maxAccepted: 2, maxConcurrent: 2 });
		await assert.rejects(() => f.service.wait('depth-two', 0, [nested.id]), /agent_child_not_direct/); assert.throws(() => f.service.interrupt('depth-two', nested.id), /agent_child_not_direct/);

		let depthOneCalls = 0; const shallow = fixture({ send: options => { depthOneCalls++; if (depthOneCalls === 1) queueMicrotask(() => options.onFinalMessage({ fullText: 'deny', fullReasoning: '', anthropicReasoning: null, toolCall: { id: 'denied-spawn', name: 'spawn_agent', rawParams: { message: 'not admitted' } } })); else queueMicrotask(() => options.onFinalMessage({ fullText: 'done', fullReasoning: '', anthropicReasoning: null })); return `request-${depthOneCalls}`; } });
		await shallow.service.spawn('depth-one', 'top', snapshot([], 'file:///workspace', 'gpt-4.1', { maxAcceptedChildren: 1, maxConcurrentThreadsPerSession: 1, maxDepth: 1 })); await new Promise(resolve => setTimeout(resolve, 0));
		assert.strictEqual(shallow.service.getRunViews('depth-one').length, 1); assert.strictEqual(shallow.providerCalls.every(call => call.agentDelegationAllowed === false), true); assert.strictEqual(shallow.converterCalls.every(call => call.agentDelegationAllowed === false), true);
	});

	test('keeps a generic child read-only when the parent captured write-capable tools', async () => {
		const live = [{ name: 'parent_mcp', description: 'Captured parent MCP.', schema: { type: 'object', properties: { query: { type: 'string', description: 'original' } } }, params: { query: { description: 'query' } }, mcpServerName: 'parent-server' }];
		const parentTools = captureParentModelToolSnapshot('agent', live, true);
		const f = fixture({ send: options => { final(options); return 'request'; } });
		await f.service.spawn('generic-profile', 'inspect', snapshot(), undefined, undefined, undefined, undefined, 0, parentTools);
		await f.service.wait('generic-profile', 1_000);
		const view = f.service.getRunView('generic-profile')!;
		assert.strictEqual(view.capabilityProfile, 'read_only'); assert.strictEqual(view.toolPresentation, undefined);
		assert.strictEqual(f.converterCalls[0].toolExecutionProfile, 'read-only-child'); assert.strictEqual(f.providerCalls[0].toolExecutionProfile, 'read-only-child');
		assert.deepStrictEqual(availableTools('agent', undefined, f.providerCalls[0].toolExecutionProfile, false, parentTools)!.map(tool => tool.name), [...readOnlyChildToolNames]);
	});

	test('uses the exact frozen parent snapshot only for an admitted inherit-parent-write role', async () => {
		const live = [{ name: 'parent_mcp', description: 'Captured parent MCP.', schema: { type: 'object', properties: { query: { type: 'string', description: 'original' } } }, params: { query: { description: 'query' } }, mcpServerName: 'parent-server' }];
		const parentTools = captureParentModelToolSnapshot('agent', live, false);
		const role: any = { identity: 'writer', name: 'writer', description: 'Write with parent authority.', developerInstructions: 'write only through the parent profile', capabilityProfile: 'inherit_parent_write', revision: 'writer-1', skillRules: [] };
		const roles: any = { revision: 'roles-1', agents: [role], diagnostics: [] };
		const f = fixture({ customCatalog: roles, send: options => { final(options); return 'request'; } });
		await f.service.spawn('writer-profile', 'update', snapshot(), 'writer', roles, undefined, undefined, 0, parentTools, f.broker);
		await f.service.wait('writer-profile', 1_000);
		const view = f.service.getRunView('writer-profile')!;
		assert.strictEqual(view.capabilityProfile, 'inherit_parent_write'); assert.deepStrictEqual(view.toolPresentation?.toolNames, parentTools.tools.map(tool => tool.name)); assert.strictEqual(view.toolPresentation?.applicationBoundary, 'no_os_sandbox');
		assert.strictEqual(f.converterCalls[0].toolExecutionProfile, 'inherited-parent-write-child'); assert.strictEqual(f.converterCalls[0].frozenToolSnapshot, parentTools); assert.strictEqual(f.providerCalls[0].frozenToolSnapshot, parentTools);
	});

	test('requires the parent broker and routes only a captured inherited tool through its frozen revision', async () => {
		const live = [{ name: 'captured_mcp', description: 'Captured MCP.', schema: { type: 'object' }, params: {}, mcpServerName: 'captured-server' }]; const parentTools = captureParentModelToolSnapshot('agent', live, false);
		const role: any = { identity: 'writer', name: 'writer', description: 'Write.', developerInstructions: 'writer', capabilityProfile: 'inherit_parent_write', revision: 'writer-1', skillRules: [] }; const roles: any = { revision: 'roles-1', agents: [role], diagnostics: [] };
		const denied = fixture({ customCatalog: roles }); await assert.rejects(() => denied.service.spawn('broker-required', 'update', snapshot(), 'writer', roles, undefined, undefined, 0, parentTools), /custom_agent_capability_profile_not_authorized/); assert.strictEqual(denied.providerCalls.length, 0);
		const seen: any[] = []; const f = fixture({ customCatalog: roles, broker: { execute: async (request: any) => { seen.push(request); return { ok: true, content: 'applied', result: { receipt: 'one' } }; }, async cancel() { } }, send: toolThenFinal({ id: 'captured-call', name: 'captured_mcp', rawParams: { change: 'one' } }) });
		await f.service.spawn('brokered', 'update', snapshot(), 'writer', roles, undefined, undefined, 0, parentTools, f.broker); await f.service.wait('brokered', 1_000);
		const captured = parentTools.tools.find(tool => tool.name === 'captured_mcp')!;
		assert.deepStrictEqual(seen.map(request => ({ name: request.name, snapshotRevision: request.snapshotRevision, childId: typeof request.childId, toolName: request.tool.name, server: request.tool.mcpServerName, revision: request.tool.revision })), [{ name: 'captured_mcp', snapshotRevision: parentTools.revision, childId: 'string', toolName: 'captured_mcp', server: 'captured-server', revision: captured.revision }]); assert.strictEqual(f.converterCalls[1].chatMessages.some((message: any) => message.role === 'tool' && message.content === 'applied'), true);
	});

	test('serializes mutation-capable children while read-only work continues, including a cancelled deferred broker', async () => {
		const parentTools = captureParentModelToolSnapshot('agent', [{ name: 'captured_mcp', description: 'Captured MCP.', schema: { type: 'object' }, params: {}, mcpServerName: 'captured-server' }], false);
		const role: any = { identity: 'writer', name: 'writer', description: 'Write.', developerInstructions: 'writer', capabilityProfile: 'inherit_parent_write', revision: 'writer-1', skillRules: [] }; const roles: any = { revision: 'roles-1', agents: [role], diagnostics: [] };
		let release!: (value: any) => void; let acknowledge!: () => void; let cancels = 0; const deferred = new Promise<any>(resolve => release = resolve); const cancelAck = new Promise<void>(resolve => acknowledge = resolve);
		let sends = 0; const f = fixture({ customCatalog: roles, broker: { execute: () => deferred, cancel: async () => { cancels++; await cancelAck; } }, send: options => { sends++; if (sends === 1) queueMicrotask(() => options.onFinalMessage({ fullText: 'write', fullReasoning: '', anthropicReasoning: null, toolCall: { id: 'm1-tool', name: 'captured_mcp', rawParams: {} } })); else if (sends === 2) queueMicrotask(() => options.onFinalMessage({ fullText: 'read done', fullReasoning: '', anthropicReasoning: null })); else queueMicrotask(() => options.onFinalMessage({ fullText: 'write done', fullReasoning: '', anthropicReasoning: null })); return `request-${sends}`; } });
		const limits = { maxAcceptedChildren: 3, maxConcurrentThreadsPerSession: 2, maxDepth: 1 };
		const m1 = await f.service.spawn('mutation', 'm1', snapshot([], 'file:///workspace', 'gpt-4.1', limits), 'writer', roles, undefined, undefined, 0, parentTools, f.broker);
		await f.service.spawn('mutation', 'read', snapshot([], 'file:///workspace', 'gpt-4.1', limits));
		const m2 = await f.service.spawn('mutation', 'm2', snapshot([], 'file:///workspace', 'gpt-4.1', limits), 'writer', roles, undefined, undefined, 0, parentTools, f.broker);
		await new Promise(resolve => setTimeout(resolve, 0)); assert.strictEqual(f.providerCalls.length, 2); assert.strictEqual(f.service.getRunViews('mutation').find(run => run.id === m2.id)?.status, 'queued');
		f.service.interrupt('mutation', m1.id); assert.strictEqual(cancels, 1); assert.strictEqual(f.providerCalls.length, 2); // M2 cannot pass the old generation's broker tombstone.
		release({ ok: true, content: 'late', result: {} }); await new Promise(resolve => setTimeout(resolve, 0)); assert.strictEqual(f.providerCalls.length, 2); assert.strictEqual(f.service.getRunViews('mutation').find(run => run.id === m1.id)?.status, 'cancelled');
		acknowledge(); await new Promise(resolve => setTimeout(resolve, 0));
		assert.strictEqual(f.providerCalls.length, 3); assert.strictEqual(f.converterCalls.filter(call => call.chatMessages.some((message: any) => message.content === 'late')).length, 0); assert.ok(f.service.getBudgetView('mutation')!.running <= 2);
	});

	test('broker cancellation acknowledgement releases a terminal writer even when execute never settles', async () => {
		const parentTools = captureParentModelToolSnapshot('agent', [{ name: 'captured_mcp', description: 'Captured MCP.', schema: { type: 'object' }, params: {}, mcpServerName: 'captured-server' }], false);
		const role: any = { identity: 'writer', name: 'writer', description: 'Write.', developerInstructions: 'writer', capabilityProfile: 'inherit_parent_write', revision: 'writer-1', skillRules: [] }; const roles: any = { revision: 'roles-1', agents: [role], diagnostics: [] };
		let acknowledge!: () => void; const ack = new Promise<void>(resolve => acknowledge = resolve); const never = new Promise<any>(() => { }); let sends = 0;
		const f = fixture({ customCatalog: roles, broker: { execute: () => never, cancel: () => ack }, send: options => { sends++; queueMicrotask(() => sends === 1 ? options.onFinalMessage({ fullText: 'write', fullReasoning: '', anthropicReasoning: null, toolCall: { id: 'write', name: 'captured_mcp', rawParams: {} } }) : final(options)); return `request-${sends}`; } });
		const first = await f.service.spawn('ack-generation', 'first', snapshot([], 'file:///workspace', 'gpt-4.1', { maxAcceptedChildren: 2, maxConcurrentThreadsPerSession: 1, maxDepth: 1 }), 'writer', roles, undefined, undefined, 0, parentTools, f.broker);
		await new Promise(resolve => setTimeout(resolve, 0)); f.service.interrupt('ack-generation', first.id); assert.strictEqual(f.service.getBudgetView('ack-generation')!.running, 0);
		await f.service.spawn('ack-generation', 'next', snapshot([], 'file:///workspace', 'gpt-4.1', { maxAcceptedChildren: 2, maxConcurrentThreadsPerSession: 1, maxDepth: 1 }), 'writer', roles, undefined, undefined, 1, parentTools, f.broker);
		await new Promise(resolve => setTimeout(resolve, 0)); assert.strictEqual(sends, 1, 'new generation must remain behind the old mutation tombstone');
		acknowledge(); await new Promise(resolve => setTimeout(resolve, 0)); assert.strictEqual(sends, 2, 'acknowledgement, not execute settlement, releases the writer lease');
	});

	test('does not yield a parent scheduler slot for a targetless wait with no direct child', async () => {
		let sends = 0; const f = fixture({ send: options => { sends++; queueMicrotask(() => sends === 1 ? options.onFinalMessage({ fullText: 'wait', fullReasoning: '', anthropicReasoning: null, toolCall: { id: 'wait', name: 'wait_agent', rawParams: { timeout_ms: 0 } } }) : final(options)); return `request-${sends}`; } });
		await f.service.spawn('no-direct-wait', 'top', snapshot()); await f.service.wait('no-direct-wait', 1_000);
		assert.strictEqual(sends, 2); assert.strictEqual(f.service.getRunView('no-direct-wait')?.status, 'completed'); assert.strictEqual(f.service.getRunView('no-direct-wait')?.schedulerActivity, 'quiescing');
	});

	test('admits empty Skill resources and preserves the prospective read budget before history append', async () => {
		const parentTools = captureParentModelToolSnapshot('agent', undefined, false);
		assert.ok(parentTools.tools.some(tool => tool.name === 'read_skill_resource'));
		const role: any = { identity: 'writer', name: 'writer', description: 'Write.', developerInstructions: 'writer', capabilityProfile: 'inherit_parent_write', revision: 'writer-1', skillRules: [] }; const roles: any = { revision: 'roles-1', agents: [role], diagnostics: [] };
		const reads: any[] = []; const f = fixture({ customCatalog: roles, readSkillResource: async (_selection, path, options) => { reads.push({ path, options }); return { body: '' }; }, send: toolThenFinal({ id: 'skill-read', name: 'read_skill_resource', rawParams: { skill: 'demo', resource_path: 'README.md' } }) });
		await f.service.spawn('empty-resource', '$demo read', snapshot(['demo']), 'writer', roles, undefined, undefined, 0, parentTools, f.broker); await f.service.wait('empty-resource', 1_000);
		assert.strictEqual(reads.length, 1); assert.ok(reads[0].options.maxResourceBytes >= 0); assert.ok(f.converterCalls.some(call => call.chatMessages.some((message: any) => message.role === 'tool' && message.name === 'read_skill_resource' && message.content === '')));
	});

	test('keeps child Skill-resource failures inside the frozen selected manifest and does not dispatch a broker call', async () => {
		const parentTools = captureParentModelToolSnapshot('agent', undefined, false);
		const role: any = { identity: 'writer', name: 'writer', description: 'Write.', developerInstructions: 'writer', capabilityProfile: 'inherit_parent_write', revision: 'writer-1', skillRules: [] }; const roles: any = { revision: 'roles-1', agents: [role], diagnostics: [] };
		for (const [raw, read, expected] of [
			[{ skill: 'demo', resource_path: 'a', extra: true }, undefined, 'read_skill_resource_invalid_params'],
			[{ skill: 'demo', resource_path: '../a' }, undefined, 'skill_resource_outside_root'],
			[{ skill: 'other', resource_path: 'a' }, undefined, 'skill_not_selected'],
			[{ skill: 'demo', resource_path: 'a' }, async () => ({ diagnostic: { code: 'skill_stale' } }), 'skill_stale'],
		] as const) {
			let brokerCalls = 0; const f = fixture({ customCatalog: roles, ...(read ? { readSkillResource: read as any } : {}), broker: { execute: async () => { brokerCalls++; return { ok: true, content: 'must-not-run' }; }, async cancel() { } }, send: toolThenFinal({ id: 'resource', name: 'read_skill_resource', rawParams: raw as any }) });
			await f.service.spawn(`resource-${expected}`, '$demo inspect', snapshot(['demo']), 'writer', roles, undefined, undefined, 0, parentTools, f.broker); await f.service.wait(`resource-${expected}`, 1_000);
			assert.strictEqual(brokerCalls, 0); assert.ok(f.converterCalls.some(call => call.chatMessages.some((message: any) => message.role === 'tool' && message.type === 'tool_error' && message.content === expected)));
		}
	});

	test('yields a nested parent wait slot so maxConcurrent one completes without a deadlock', async () => {
		let sends = 0; const f = fixture({ send: options => { sends++; if (sends === 1) queueMicrotask(() => options.onFinalMessage({ fullText: 'spawn', fullReasoning: '', anthropicReasoning: null, toolCall: { id: 'spawn', name: 'spawn_agent', rawParams: { message: 'child' } } })); else if (sends === 2) queueMicrotask(() => options.onFinalMessage({ fullText: 'wait', fullReasoning: '', anthropicReasoning: null, toolCall: { id: 'wait', name: 'wait_agent', rawParams: { timeout_ms: 1000 } } })); else queueMicrotask(() => options.onFinalMessage({ fullText: 'done', fullReasoning: '', anthropicReasoning: null })); return `request-${sends}`; } });
		await f.service.spawn('yield', 'top', snapshot([], 'file:///workspace', 'gpt-4.1', { maxAcceptedChildren: 2, maxConcurrentThreadsPerSession: 1, maxDepth: 2 }));
		const done = await Promise.race([f.service.wait('yield', 1_000), new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('nested_wait_deadlock')), 1_100))]);
		assert.strictEqual(done.status, 'completed'); assert.strictEqual(f.providerCalls.length, 4); assert.ok(f.service.getBudgetView('yield')!.running <= 1);
	});

	test('reports waiting and ready scheduler activity while a timed nested wait holds the only active lease', async () => {
		let sends = 0; let releaseNested!: () => void; const nestedStarted = new Promise<void>(resolve => releaseNested = resolve); let nestedOptions: any;
		const f = fixture({ send: options => { sends++; if (sends === 1) queueMicrotask(() => options.onFinalMessage({ fullText: 'spawn', fullReasoning: '', anthropicReasoning: null, toolCall: { id: 'spawn', name: 'spawn_agent', rawParams: { message: 'nested' } } })); else if (sends === 2) queueMicrotask(() => options.onFinalMessage({ fullText: 'wait', fullReasoning: '', anthropicReasoning: null, toolCall: { id: 'wait', name: 'wait_agent', rawParams: { timeout_ms: 5 } } })); else if (sends === 3) { nestedOptions = options; releaseNested(); } else queueMicrotask(() => options.onFinalMessage({ fullText: 'parent done', fullReasoning: '', anthropicReasoning: null })); return `request-${sends}`; } });
		const activities: Array<{ id: string; activity: string | undefined; running: number }> = [];
		f.service.onDidChangeRun(event => { const view = f.service.getRunViews('scheduler-timeout').find(run => run.id === event.id); activities.push({ id: event.id, activity: view?.schedulerActivity, running: f.service.getBudgetView('scheduler-timeout')?.running ?? -1 }); });
		await f.service.spawn('scheduler-timeout', 'top', snapshot([], 'file:///workspace', 'gpt-4.1', { maxAcceptedChildren: 2, maxConcurrentThreadsPerSession: 1, maxDepth: 2 }));
		await nestedStarted;
		await new Promise(resolve => setTimeout(resolve, 15));
		const views = f.service.getRunViews('scheduler-timeout'); const parent = views.find(run => run.depth === 1)!; const nested = views.find(run => run.depth === 2)!;
		assert.ok(activities.some(value => value.id === parent.id && value.activity === 'waiting_children'));
		assert.ok(activities.some(value => value.id === parent.id && value.activity === 'ready_to_resume' && value.running === 1));
		assert.strictEqual(f.service.getRunViews('scheduler-timeout').find(run => run.id === nested.id)?.schedulerActivity, 'active'); assert.strictEqual(f.service.getBudgetView('scheduler-timeout')?.running, 1); assert.ok(activities.every(value => value.running <= 1));
		nestedOptions.onFinalMessage({ fullText: 'nested done', fullReasoning: '', anthropicReasoning: null });
		await f.service.wait('scheduler-timeout', 1_000, [parent.id]);
		assert.ok(activities.some(value => value.id === parent.id && value.activity === 'active' && value.running === 1)); assert.strictEqual(f.service.getBudgetView('scheduler-timeout')?.running, 0); assert.strictEqual(sends, 4);
	});

	test('rejects a nested inherited-write role from a read-only parent before a row, provider call, or quota reservation', async () => {
		const parentTools = captureParentModelToolSnapshot('agent', undefined, true);
		const role: any = { identity: 'writer', name: 'writer', description: 'Write with parent authority.', developerInstructions: 'writer', capabilityProfile: 'inherit_parent_write', revision: 'writer-1', skillRules: [] };
		const roles: any = { revision: 'roles-1', agents: [role], diagnostics: [] };
		let sends = 0;
		const f = fixture({ send: options => { sends++; queueMicrotask(() => sends === 1 ? options.onFinalMessage({ fullText: 'try elevation', fullReasoning: '', anthropicReasoning: null, toolCall: { id: 'nested-writer', name: 'spawn_agent', rawParams: { message: 'write', agent_type: 'writer' } } }) : options.onFinalMessage({ fullText: 'done', fullReasoning: '', anthropicReasoning: null })); return `request-${sends}`; } });
		await f.service.spawn('no-elevation', 'top', snapshot([], 'file:///workspace', 'gpt-4.1', { maxAcceptedChildren: 2, maxConcurrentThreadsPerSession: 2, maxDepth: 2 }), undefined, roles, undefined, undefined, 0, parentTools);
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.strictEqual(sends, 2); assert.strictEqual(f.service.getRunViews('no-elevation').length, 1); assert.strictEqual(f.service.getBudgetView('no-elevation')?.accepted, 0); assert.strictEqual(f.service.getBudgetView('no-elevation')?.running, 0); assert.strictEqual(f.service.getRunView('no-elevation')?.capabilityProfile, 'read_only');
	});

	test('retains one captured profile for inherited parent and nested child after live registry drift', async () => {
		const capturedSchema = { type: 'object', properties: { query: { type: 'string', description: 'original' } } };
		const live: InternalToolInfo[] = [{ name: 'captured_mcp', description: 'Captured MCP.', schema: capturedSchema, params: { query: { description: 'query' } }, mcpServerName: 'captured-server' }];
		const parentTools = captureParentModelToolSnapshot('agent', live, true);
		const role: any = { identity: 'writer', name: 'writer', description: 'Write with parent authority.', developerInstructions: 'writer', capabilityProfile: 'inherit_parent_write', revision: 'writer-1', skillRules: [] };
		const roles: any = { revision: 'roles-1', agents: [role], diagnostics: [] };
		let sends = 0;
		const f = fixture({ customCatalog: roles, send: options => { sends++; queueMicrotask(() => sends === 1 ? options.onFinalMessage({ fullText: 'delegate', fullReasoning: '', anthropicReasoning: null, toolCall: { id: 'nested-writer', name: 'spawn_agent', rawParams: { message: 'nested', agent_type: 'writer' } } }) : options.onFinalMessage({ fullText: 'done', fullReasoning: '', anthropicReasoning: null })); return `request-${sends}`; } });
		await f.service.spawn('frozen-inherited-tree', 'top', snapshot([], 'file:///workspace', 'gpt-4.1', { maxAcceptedChildren: 2, maxConcurrentThreadsPerSession: 2, maxDepth: 2 }), 'writer', roles, undefined, undefined, 0, parentTools, f.broker);
		live[0].name = 'live_replaced'; capturedSchema.properties.query.description = 'mutated'; live.push({ name: 'late_mcp', description: 'Late.', params: { query: { description: 'query' } }, mcpServerName: 'late-server' });
		await new Promise(resolve => setTimeout(resolve, 0));
		const views = f.service.getRunViews('frozen-inherited-tree'); assert.strictEqual(views.length, 2); assert.ok(views.every(view => view.capabilityProfile === 'inherit_parent_write'));
		assert.strictEqual(parentTools.tools.find(tool => tool.name === 'captured_mcp')?.schema?.properties && (parentTools.tools.find(tool => tool.name === 'captured_mcp')!.schema!.properties as any).query.description, 'original');
		assert.ok(f.converterCalls.every(call => call.frozenToolSnapshot === parentTools && call.toolExecutionProfile === 'inherited-parent-write-child')); assert.ok(f.providerCalls.every(call => call.frozenToolSnapshot === parentTools && call.toolExecutionProfile === 'inherited-parent-write-child'));
		assert.ok(f.providerCalls.every(call => availableTools('agent', [{ name: 'live_replaced', description: 'live', params: {} }], call.toolExecutionProfile, call.agentDelegationAllowed, call.frozenToolSnapshot)!.some(tool => tool.name === 'late_mcp') === false));
	});

	test('cancels a nested subtree from its direct root parent and fences late child completion', async () => {
		let sends = 0; const pending: any[] = []; const f = fixture({ send: options => { sends++; if (sends === 1) queueMicrotask(() => options.onFinalMessage({ fullText: 'delegate', fullReasoning: '', anthropicReasoning: null, toolCall: { id: 'spawn', name: 'spawn_agent', rawParams: { message: 'nested' } } })); else pending.push(options); return `request-${sends}`; } });
		await f.service.spawn('tree', 'top', snapshot([], 'file:///workspace', 'gpt-4.1', { maxAcceptedChildren: 2, maxConcurrentThreadsPerSession: 2, maxDepth: 2 })); await new Promise(resolve => setTimeout(resolve, 0));
		const top = f.service.getRunViews('tree').find(run => run.depth === 1)!; const nested = f.service.getRunViews('tree').find(run => run.depth === 2)!;
		f.service.interrupt('tree', top.id);
		assert.deepStrictEqual(f.service.getRunViews('tree').map(run => run.status), ['cancelled', 'cancelled']);
		for (const options of pending) options.onFinalMessage({ fullText: 'late', fullReasoning: '', anthropicReasoning: null });
		assert.deepStrictEqual(f.service.getRunViews('tree').map(run => run.status), ['cancelled', 'cancelled']); assert.ok(f.aborts() >= 2); assert.throws(() => f.service.interrupt('tree', nested.id), /agent_child_not_direct/);
	});

	test('cancels a deferred nested admission with its parent before it can append or dispatch', async () => {
		let release!: () => void, entered!: () => void; const deferred = new Promise<void>(resolve => release = resolve); const started = new Promise<void>(resolve => entered = resolve); let sends = 0;
		const f = fixture({ readSkillBody: async () => { entered(); await deferred; return { body: skillText('demo') }; }, send: options => { sends++; if (sends === 1) queueMicrotask(() => options.onFinalMessage({ fullText: 'delegate', fullReasoning: '', anthropicReasoning: null, toolCall: { id: 'spawn', name: 'spawn_agent', rawParams: { message: '$demo nested' } } })); return `request-${sends}`; } });
		await f.service.spawn('deferred-tree', 'top', snapshot([], 'file:///workspace', 'gpt-4.1', { maxAcceptedChildren: 2, maxConcurrentThreadsPerSession: 2, maxDepth: 2 })); await started;
		const top = f.service.getRunViews('deferred-tree')[0]; assert.strictEqual(sends, 1);
		f.service.interrupt('deferred-tree', top.id); release(); await new Promise(resolve => setTimeout(resolve, 0));
		assert.deepStrictEqual(f.service.getRunViews('deferred-tree').map(run => run.status), ['cancelled']); assert.strictEqual(sends, 1); assert.strictEqual(f.service.getBudgetView('deferred-tree')?.accepted, 0);
	});

	test('failed admission releases its reservation without a row or event', async () => {
		const f = fixture({ readSkillBody: async () => ({ diagnostic: { code: 'skill_stale' } }), send: () => 'request' });
		await assert.rejects(() => f.service.spawn('admission-release', '$demo bad', snapshot()), /skill_stale/);
		assert.deepStrictEqual(f.service.getRunViews('admission-release'), []); assert.deepStrictEqual(f.events, []);
		(f.service as any).skills.readSkillBody = async () => ({ body: skillText('demo') });
		await Promise.all(['1', '2', '3', '4'].map(message => f.service.spawn('admission-release', message, snapshot())));
		assert.strictEqual(f.service.getBudgetView('admission-release')?.accepted, 4); await assert.rejects(() => f.service.spawn('admission-release', '5', snapshot()), /agent_child_limit_reached/);
	});

	test('returns terminal open capacity while retaining terminal rows and rejects depth zero before a row or provider call', async () => {
		const f = fixture({ send: options => { queueMicrotask(() => options.onFinalMessage({ fullText: 'done', fullReasoning: '', anthropicReasoning: null })); return 'request'; } });
		await assert.rejects(() => f.service.spawn('depth-zero', 'nope', snapshot([], 'file:///workspace', 'gpt-4.1', { maxAcceptedChildren: 32, maxConcurrentThreadsPerSession: 16, maxDepth: 0 })), /agent_child_depth_exhausted/);
		assert.strictEqual(f.service.getRunViews('depth-zero').length, 0); assert.strictEqual(f.providerCalls.length, 0);
		for (let index = 0; index < 100; index++) { await f.service.spawn('sequential', String(index), snapshot([], 'file:///workspace', 'gpt-4.1', { maxAcceptedChildren: 32, maxConcurrentThreadsPerSession: 16, maxDepth: 4 })); await f.service.wait('sequential', 1_000); }
		assert.strictEqual(f.service.getRunViews('sequential').length, 100); assert.strictEqual(f.service.getBudgetView('sequential')?.accepted, 0); assert.strictEqual(f.service.getBudgetView('sequential')?.maxConcurrent, 16);
	});

	test('bounds retained terminal child results without closing sequential admission capacity', async () => {
		const terminalText = 'x'.repeat(12_000);
		const f = fixture({ send: options => { final(options, terminalText); return 'request'; } });
		const limits = { maxAcceptedChildren: 32, maxConcurrentThreadsPerSession: 16, maxDepth: 4 };
		const children: string[] = [];
		const receipts: any[] = [];
		for (let index = 0; index < 100; index++) {
			const child = await f.service.spawn('result-retention', `child-${index}`, snapshot([], 'file:///workspace', 'gpt-4.1', limits));
			children.push(child.id);
			const terminal = await f.service.wait('result-retention', 1_000, [child.id]);
			assert.strictEqual(terminal.deliverSummary, true);
			receipts.push(terminal.receipt);
		}
		await new Promise(resolve => setTimeout(resolve, 0));
		const budget = f.service.getBudgetView('result-retention')!;
		assert.deepStrictEqual({ accepted: budget.accepted, maxAccepted: budget.maxAccepted, maxConcurrent: budget.maxConcurrent, maxResultChars: budget.maxResultChars }, { accepted: 0, maxAccepted: 32, maxConcurrent: 16, maxResultChars: 256_000 });
		assert.strictEqual(budget.resultChars, 1_200_000);
		assert.strictEqual(budget.retainedResultChars, 256_000);
		assert.strictEqual(budget.retainedResultChars <= budget.maxResultChars, true);
		assert.strictEqual(budget.truncatedResultCount, 79);
		assert.strictEqual(receipts.filter(receipt => receipt.resultTruncated).length, 79);
		assert.strictEqual(receipts[0].summary.length, 8_000);
		assert.strictEqual(receipts[21].summary.length, 4_000);
		assert.deepStrictEqual(receipts.at(-1), { id: children.at(-1), status: 'completed', summary: '', resultTruncated: true, usage: null });
		const views = f.service.getRunViews('result-retention');
		assert.strictEqual(views.length, 100);
		assert.strictEqual(views[0].summary?.length, 12_000);
		assert.strictEqual(views[21].summary?.length, 4_000);
		assert.strictEqual(views.filter(view => view.resultTruncated).length, 79);
		assert.strictEqual(views.at(-1)?.summary, undefined);
		const group = (f.service as any).groups.get('result-retention');
		assert.strictEqual(Object.isFrozen(group.runs[0].terminalView), true);
		assert.strictEqual(Object.hasOwn(group.runs[0], 'snapshot'), false);
		assert.strictEqual(Object.hasOwn(group.runs[0], 'settingsOfProvider'), false);
		assert.strictEqual(Object.hasOwn(group.runs[0], 'parentTools'), false);
		const repeated = await f.service.wait('result-retention', 0, [children.at(-1)!]);
		assert.strictEqual(repeated.deliverSummary, false);
		assert.strictEqual(group.runs.at(-1).lifecycle.receipt(false).receipt?.resultTruncated, true);
		f.service.forgetParent('result-retention');
		assert.strictEqual(f.service.getBudgetView('result-retention'), undefined);
		assert.strictEqual(f.service.getRunViews('result-retention').length, 0);
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
		const repeated = await f.service.wait('wait-group', 0, [two.id, one.id]); assert.strictEqual(repeated.deliverSummary, false); assert.deepStrictEqual(repeated.children.map(child => child.id), [one.id, two.id]); assert.strictEqual(JSON.stringify(repeated.children).includes('Child cancelled by parent.'), false); assert.strictEqual(repeated.timedOut, false); assert.strictEqual(repeated.budget.maxResultChars, 32_000); assert.strictEqual(repeated.budget.usage, null); assert.strictEqual('deadlineMsRemaining' in repeated.budget, false); assert.strictEqual('maxChildTurns' in repeated.budget, false); assert.strictEqual('maxChildRunMs' in repeated.budget, false);
		const active = await f.service.spawn('wait-group-active', 'active', snapshot()); const timedOut = await f.service.wait('wait-group-active', 0, [active.id]); assert.strictEqual(timedOut.timedOut, true); f.service.interrupt('wait-group-active', active.id);
		for (const targets of [[], [one.id, one.id], [' ', two.id], ['x'.repeat(257)]]) await assert.rejects(() => f.service.wait('wait-group', 0, targets), /wait_agent_invalid_params|agent_child_not_direct/);
	});

	test('generation reset forgets quota and old ids cannot be interrupted in a new group', async () => {
		const f = fixture({ send: () => 'request' }); const old = await f.service.spawn('generation', 'old', snapshot(), undefined, undefined, undefined, undefined, 1); f.service.forgetParent('generation'); const fresh = await f.service.spawn('generation', 'fresh', snapshot(), undefined, undefined, undefined, undefined, 2);
		assert.deepStrictEqual(f.service.getRunViews('generation').map(view => view.id), [fresh.id]); assert.throws(() => f.service.interrupt('generation', old.id, 2), /agent_child_not_direct/);
	});

	test('enforces provider/result budgets and the shared cancellation path structurally', async () => {
		const f = fixture({ send: () => 'request' }); const child = await f.service.spawn('ledger', 'inspect', snapshot()); const group = (f.service as any).groups.get('ledger');
		for (let attempt = 0; attempt < 10 && f.providerCalls.length === 0; attempt++) await Promise.resolve(); assert.strictEqual(f.service.getBudgetView('ledger')?.activeProviderSends, 1); group.budgetLimits = Object.freeze({ ...group.budgetLimits, maxProviderSends: 1 }); const blocked = await f.service.spawn('ledger', 'blocked', snapshot()); const blockedResult = await f.service.wait('ledger', 1_000, [blocked.id]); assert.strictEqual(f.providerCalls.length, 1); assert.strictEqual(blockedResult.status, 'failed'); assert.strictEqual(f.service.getRunViews('ledger').find(view => view.id === blocked.id)?.status, 'failed'); assert.strictEqual(f.service.getDiagnosticsView('ledger')?.events.find(event => event.kind === 'child_failed' && event.childId === blocked.id)?.diagnostic, 'budget_exhausted'); f.service.interrupt('ledger', child.id);
		const capped = await Promise.all(['1', '2', '3', '4'].map(message => f.service.spawn('result-cap', message, snapshot()))); const budgetGroup = (f.service as any).groups.get('result-cap'); for (const id of capped.map(child => child.id)) { const run = budgetGroup.runs.find((candidate: any) => candidate.id === id); (f.service as any).settle(run, 'completed', 'x'.repeat(10_000)); } assert.strictEqual(budgetGroup.resultChars, 32_000); assert.deepStrictEqual(budgetGroup.runs.map((run: any) => run.summary.length), [8_000, 8_000, 8_000, 8_000]);
		const exhausted = await f.service.spawn('result-cap', 'failed-and-cancelled', snapshot()); const exhaustedRun = budgetGroup.runs.find((candidate: any) => candidate.id === exhausted.id); (f.service as any).settle(exhaustedRun, 'cancelled', 'Child cancelled by parent.'); const exhaustedView = f.service.getRunViews('result-cap').find(view => view.id === exhausted.id)!; assert.strictEqual(exhaustedView.status, 'cancelled'); assert.strictEqual(exhaustedView.summary, undefined); assert.strictEqual(exhaustedView.resultTruncated, true); assert.strictEqual(f.service.getDiagnosticsView('result-cap')?.events.find(event => event.childId === exhausted.id && event.kind === 'child_cancelled')?.diagnostic, 'cancelled');
		const exhaustedFailure = await f.service.spawn('result-cap', 'failed-after-retention', snapshot()); const exhaustedFailureRun = budgetGroup.runs.find((candidate: any) => candidate.id === exhaustedFailure.id); (f.service as any).settle(exhaustedFailureRun, 'failed', 'provider failed'); const failedView = f.service.getRunViews('result-cap').find(view => view.id === exhaustedFailure.id)!; assert.strictEqual(failedView.status, 'failed'); assert.strictEqual(failedView.summary, undefined); assert.strictEqual(failedView.resultTruncated, true);
		let entered!: () => void; const enteredRead = new Promise<void>(resolve => entered = resolve); const admissionCancellation = fixture({ readSkillBody: async () => { entered(); return new Promise<any>(() => { }); } }); const pending = admissionCancellation.service.spawn('admission-cancel', '$demo inspect', snapshot()); await enteredRead; (admissionCancellation.service as any).cancelGroup((admissionCancellation.service as any).groups.get('admission-cancel'), 'cancelled'); await assert.rejects(pending, /agent_child_cancelled/); assert.deepStrictEqual(admissionCancellation.service.getRunViews('admission-cancel'), []); assert.strictEqual(admissionCancellation.providerCalls.length, 0);
		const providerOccupancy: Array<[number, number]> = []; let manyTurns: ReturnType<typeof fixture>; manyTurns = fixture({ send: (options, turn) => { providerOccupancy.push([manyTurns.service.getBudgetView('many-turns')!.activeProviderSends, 0]); queueMicrotask(() => { options.onFinalMessage(turn <= 17 ? { fullText: `tool-${turn}`, fullReasoning: '', anthropicReasoning: null, toolCall: { id: `tool-${turn}`, name: 'ls_dir', rawParams: { uri: 'file:///workspace' } } } : { fullText: 'complete', fullReasoning: '', anthropicReasoning: null }); providerOccupancy[providerOccupancy.length - 1][1] = manyTurns.service.getBudgetView('many-turns')!.activeProviderSends; }); return `many-${turn}`; } }); await manyTurns.service.spawn('many-turns', 'inspect', snapshot()); const manyResult = await manyTurns.service.wait('many-turns', 1_000); assert.strictEqual(manyResult.status, 'completed'); assert.strictEqual(manyTurns.providerCalls.length, 18); assert.deepStrictEqual(providerOccupancy, Array.from({ length: 18 }, () => [1, 0])); assert.strictEqual(manyResult.budget.providerSends, 18); assert.strictEqual(manyResult.budget.activeProviderSends, 0);
		const noRequest = fixture({ send: () => '' }); await noRequest.service.spawn('no-request', 'inspect', snapshot()); const noRequestResult = await noRequest.service.wait('no-request', 1_000); assert.strictEqual(noRequestResult.status, 'failed'); assert.strictEqual(noRequestResult.budget.providerSends, 1); assert.strictEqual(noRequestResult.budget.activeProviderSends, 0);
		const providerError = fixture({ send: options => { queueMicrotask(() => options.onError({ message: 'provider error' })); return 'provider-error'; } }); await providerError.service.spawn('provider-error', 'inspect', snapshot()); const providerErrorResult = await providerError.service.wait('provider-error', 1_000); assert.strictEqual(providerErrorResult.status, 'failed'); assert.strictEqual(providerErrorResult.budget.providerSends, 1); assert.strictEqual(providerErrorResult.budget.activeProviderSends, 0);
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
		const roles: any = { revision: 'roles', agents: [role], diagnostics: [] }; const child = await f.service.spawn('parent', 'inspect', snapshot(), 'reader', roles);
		assert.strictEqual(f.service.getRunView('parent')?.id, child.id); assert.strictEqual(f.service.getRunView('parent')?.roleName, 'reader');
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
		const makeRealTools = (fileService: any, voidModelService: any, searchService: any = {}, queryBuilder: any = {}) => new ToolsService(fileService, { getWorkspace: () => ({ folders: [{ uri: owner }] }) } as never, searchService, { search: async () => ({ ok: false, code: 'search_backend_unavailable', trace: 'terminal-fallback-unavailable' }) } as never, { createInstance: () => queryBuilder } as never, voidModelService, { state: { globalSettings: {} } } as never, {} as never, {} as never, {} as never, {} as never, { read: () => [] } as never);
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
		const overLimitResults = Array.from({ length: 102 }, (_, index) => ({ resource: URI.parse(`file:///workspace/${index}`), results: [] }));
		const cappedTools = makeRealTools(safeFile, { initializeModel: async () => { }, getModelSafe: async () => ({ model: null }) }, { fileSearch: async () => ({ results: overLimitResults }) }, queryBuilder);
		const cappedCall = await cappedTools.callTool.search_pathnames_only({ query: 'a', includePattern: null, pageNumber: 1 }, childContext);
		await assert.rejects(Promise.resolve(cappedCall.result), /agent_child_search_result_limit/); assert.strictEqual(fileQueryOptions.ignoreSymlinks, true); assert.strictEqual(fileQueryOptions.maxResults, 101); assert.strictEqual(fileQueryOptions.maxFileSize, 1_048_576);
		const outsideSearch = makeRealTools(safeFile, { initializeModel: async () => { }, getModelSafe: async () => ({ model: null }) }, { fileSearch: async () => ({ results: [{ resource: URI.parse('file:///outside/a'), results: [] }] }) }, queryBuilder);
		const outsideSearchCall = await outsideSearch.callTool.search_pathnames_only({ query: 'a', includePattern: null, pageNumber: 1 }, childContext);
		await assert.rejects(Promise.resolve(outsideSearchCall.result), /agent_child_search_outside_owner/);
		const searchCancellation = new CancellationTokenSource();
		try {
			const cancelledSearch = makeRealTools(safeFile, { initializeModel: async () => { }, getModelSafe: async () => ({ model: null }) }, { fileSearch: async () => { searchCancellation.cancel(); return { results: [] }; } }, queryBuilder);
			const cancelledSearchCall = await cancelledSearch.callTool.search_pathnames_only({ query: 'a', includePattern: null, pageNumber: 1 }, { ...childContext, cancellationToken: searchCancellation.token });
			await assert.rejects(Promise.resolve(cancelledSearchCall.result), /agent_child_cancelled/);
		} finally { searchCancellation.dispose(); }
		let blockedFileBackend = 0; let blockedTextBackend = 0;
		const blockedRootTools = makeRealTools({ ...safeFile, resolve: async (uri: URI) => ({ resource: uri, isSymbolicLink: uri.toString() === owner.toString() }) }, { initializeModel: async () => { }, getModelSafe: async () => ({ model: null }) }, { fileSearch: async () => { blockedFileBackend++; return { results: [] }; }, textSearch: async () => { blockedTextBackend++; return { results: [] }; } }, { file: () => ({}), text: () => ({}) });
		const blockedPathnameCall = await blockedRootTools.callTool.search_pathnames_only({ query: 'a', includePattern: null, pageNumber: 1 }, childContext);
		await assert.rejects(Promise.resolve(blockedPathnameCall.result), /agent_child_reparse_point/);
		const blockedContentCall = await blockedRootTools.callTool.search_for_files({ query: 'a', isRegex: false, searchInFolder: null, pageNumber: 1 }, childContext);
		await assert.rejects(Promise.resolve(blockedContentCall.result), /agent_child_reparse_point/); assert.strictEqual(blockedFileBackend, 0); assert.strictEqual(blockedTextBackend, 0);
		let blockedSubfolderBackend = 0;
		const blockedSubfolderTools = makeRealTools({ ...safeFile, resolve: async (uri: URI) => ({ resource: uri, isSymbolicLink: uri.path === '/workspace/sub' }) }, { initializeModel: async () => { }, getModelSafe: async () => ({ model: null }) }, { textSearch: async () => { blockedSubfolderBackend++; return { results: [] }; } }, { file: () => ({}), text: () => ({}) });
		const blockedSubfolderCall = await blockedSubfolderTools.callTool.search_for_files({ query: 'a', isRegex: false, searchInFolder: URI.parse('file:///workspace/sub'), pageNumber: 1 }, childContext);
		await assert.rejects(Promise.resolve(blockedSubfolderCall.result), /agent_child_reparse_point/); assert.strictEqual(blockedSubfolderBackend, 0);
		let fileRootSwapped = false; let textRootSwapped = false;
		const swappedFileTools = makeRealTools({ ...safeFile, resolve: async (uri: URI) => ({ resource: uri, isSymbolicLink: fileRootSwapped && uri.toString() === owner.toString() }) }, { initializeModel: async () => { }, getModelSafe: async () => ({ model: null }) }, { fileSearch: async () => { fileRootSwapped = true; return { results: [] }; } }, { file: () => ({}), text: () => ({}) });
		const swappedFileCall = await swappedFileTools.callTool.search_pathnames_only({ query: 'a', includePattern: null, pageNumber: 1 }, childContext);
		await assert.rejects(Promise.resolve(swappedFileCall.result), /agent_child_reparse_point/);
		const swappedTextTools = makeRealTools({ ...safeFile, resolve: async (uri: URI) => ({ resource: uri, isSymbolicLink: textRootSwapped && uri.path === '/workspace/sub' }) }, { initializeModel: async () => { }, getModelSafe: async () => ({ model: null }) }, { textSearch: async () => { textRootSwapped = true; return { results: [] }; } }, { file: () => ({}), text: () => ({}) });
		const swappedTextCall = await swappedTextTools.callTool.search_for_files({ query: 'a', isRegex: false, searchInFolder: URI.parse('file:///workspace/sub'), pageNumber: 1 }, childContext);
		await assert.rejects(Promise.resolve(swappedTextCall.result), /agent_child_reparse_point/);
		const textRoots: string[][] = []; const textOptions: any[] = [];
		const textQueryBuilder = { file: () => ({}), text: (_pattern: unknown, roots: URI[], options: unknown) => { textRoots.push(roots.map(uri => uri.toString())); textOptions.push(options); return {}; } };
		const narrowedSearch = makeRealTools(safeFile, { initializeModel: async () => { }, getModelSafe: async () => ({ model: null }) }, { textSearch: async () => ({ results: [] }) }, textQueryBuilder);
		const narrowedSubfolderCall = await narrowedSearch.callTool.search_for_files({ query: 'a', isRegex: false, searchInFolder: URI.parse('file:///workspace/sub'), pageNumber: 1 }, childContext);
		await Promise.resolve(narrowedSubfolderCall.result);
		const narrowedRootCall = await narrowedSearch.callTool.search_for_files({ query: 'a', isRegex: false, searchInFolder: null, pageNumber: 1 }, childContext);
		await Promise.resolve(narrowedRootCall.result);
		assert.deepStrictEqual(textRoots, [['file:///workspace/sub'], ['file:///workspace']]); assert.strictEqual(textOptions.every(options => options.ignoreSymlinks === true && options.maxResults === 101 && options.maxFileSize === 1_048_576), true);
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
		assert.strictEqual(f.service.getRunView('parent')?.status, 'cancelled'); assert.strictEqual(f.events.filter(event => event.status === 'cancelled').length, 1); assert.strictEqual(f.aborts(), 1); assert.strictEqual(f.service.getBudgetView('parent')?.activeProviderSends, 0); assert.deepStrictEqual(f.invalidations, [child.id]);
		let abortThrowOptions: any; const abortThrow = fixture({ send: options => { abortThrowOptions = options; return 'abort-throw'; }, abort: () => { throw new Error('abort exploded'); } }); const abortThrowChild = await abortThrow.service.spawn('abort-throw', 'inspect', snapshot()); assert.doesNotThrow(() => abortThrow.service.interrupt('abort-throw', abortThrowChild.id)); abortThrowOptions.onFinalMessage({ fullText: 'late', fullReasoning: '', anthropicReasoning: null }); await new Promise(resolve => setTimeout(resolve, 0)); assert.strictEqual(abortThrow.service.getRunView('abort-throw')?.status, 'cancelled'); assert.strictEqual(abortThrow.events.filter(event => event.status === 'cancelled').length, 1); assert.strictEqual(abortThrow.service.getBudgetView('abort-throw')?.activeProviderSends, 0); assert.strictEqual((abortThrow.service as any).groups.get('abort-throw').runs[0].released, true); assert.deepStrictEqual(abortThrow.invalidations, [abortThrowChild.id]);
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
			await failure.service.spawn(parentId, 'inspect', snapshot()); const failed = await failure.service.wait(parentId, 1_000); assert.strictEqual(failed.status, 'failed'); assert.ok(/exploded/.test(failed.receipt?.summary ?? '')); assert.strictEqual(failure.events.filter(event => event.status === 'failed').length, 1); assert.strictEqual(failure.toolCalls.length, 0); assert.strictEqual(failure.invalidations.length, 1); assert.strictEqual(failure.service.getBudgetView(parentId)?.activeProviderSends, 0);
		}
	});

	test('a fresh service has no restart replay and forgetParent removes transient terminal state', async () => {
		const first = fixture({ send: options => { final(options); return 'request'; } }); await first.service.spawn('parent', 'inspect', snapshot()); await first.service.wait('parent', 1_000); assert.ok(first.service.getRunView('parent'));
		const terminalViews: Array<unknown> = []; const terminalListener = first.service.onDidChangeRun(event => { if (event.parentId === 'parent') terminalViews.push(first.service.getRunView('parent')); });
		const restarted = fixture(); assert.strictEqual(restarted.service.getRunView('parent'), undefined); first.service.forgetParent('parent'); assert.strictEqual(first.service.getRunView('parent'), undefined); assert.strictEqual(terminalViews.at(-1), undefined); assert.strictEqual(first.events.at(-1).removed, true); terminalListener.dispose();
		const active = fixture(); const child = await active.service.spawn('active', 'inspect', snapshot()); for (let i = 0; i < 10 && active.providerCalls.length === 0; i++) await Promise.resolve(); assert.strictEqual(active.providerCalls.length, 1); const activeViews: Array<unknown> = []; const activeListener = active.service.onDidChangeRun(event => { if (event.parentId === 'active') activeViews.push(active.service.getRunView('active')); }); active.service.forgetParent('active'); assert.strictEqual(active.service.getRunView('active'), undefined); assert.strictEqual(activeViews.at(-1), undefined); assert.strictEqual(active.events.at(-1).removed, true); assert.strictEqual(active.aborts(), 1); assert.deepStrictEqual(active.invalidations, [child.id]); activeListener.dispose();
		first.service.dispose(); active.service.dispose(); restarted.service.dispose();
	});

	test('shows deferred wait control without contaminating persisted parent history', async () => {
		let release!: () => void; const gate = new Promise<void>(resolve => release = resolve); const messages: any[] = []; const streamState: any = {}; const authority: any = { allowed: true, generation: 1 };
		const receiver: any = { state: { allThreads: { parent: { messages } } }, streamState, _agentDelegationAuthorityOfThread: new Map([['parent', authority]]), _agentControlGeneration: new Map([['parent', 1]]), _agentSubagentService: { wait: async () => { await gate; return { id: 'child', status: 'completed', deliverSummary: true }; } }, _setStreamState(id: string, state: any) { streamState[id] = state; }, _addMessageToThread(_id: string, message: any) { messages.push(message); } };
		const pending = (ChatThreadService.prototype as any)._runToolCall.call(receiver, 'parent', 'wait_agent', 'wait-provider-id', undefined, { preapproved: false, unvalidatedToolParams: { timeout_ms: 0 } }, { ownerProjectRoot: 'file:///workspace' }, authority, false, 1, () => true);
		await Promise.resolve();
		assert.strictEqual(streamState.parent.isRunning, 'idle'); assert.strictEqual(streamState.parent.toolInfo.transient, true); assert.strictEqual(streamState.parent.toolInfo.toolName, 'wait_agent'); assert.strictEqual(streamState.parent.toolInfo.id, 'wait-provider-id'); assert.ok(streamState.parent.toolInfo.receiptId); assert.deepStrictEqual(messages, []);
		release(); await pending;
		assert.strictEqual(messages.length, 1); const terminal = (messages as any)[0]; assert.deepStrictEqual({ type: terminal.type, id: terminal.id }, { type: 'success', id: 'wait-provider-id' }); assert.strictEqual(streamState.parent.toolInfo, undefined);
	});

	test('keeps deferred wait control Cancelling until its private receipt settles', async () => {
		let release!: () => void; const gate = new Promise<void>(resolve => release = resolve); const messages: any[] = []; const streamState: any = {}; const authority: any = { allowed: true, generation: 1 }; let cancelParent = 0;
		const receiver: any = {
			state: { allThreads: { parent: { messages } } }, streamState,
			_agentDelegationAuthorityOfThread: new Map([['parent', authority]]), _agentControlGeneration: new Map([['parent', 1]]),
			_agentSubagentService: { wait: async () => { await gate; return { id: 'child', status: 'cancelled', deliverSummary: false }; }, cancelParent: () => { cancelParent++; } },
			_setStreamState(id: string, state: any) { streamState[id] = state; }, _addMessageToThread(_id: string, message: any) { messages.push(message); },
			_revokeAgentDelegation(id: string) { this._agentDelegationAuthorityOfThread.delete(id); this._agentControlGeneration.delete(id); this._agentSubagentService.cancelParent(id); },
		};
		const pending = (ChatThreadService.prototype as any)._runToolCall.call(receiver, 'parent', 'wait_agent', 'overlapping-provider-id', undefined, { preapproved: false, unvalidatedToolParams: { timeout_ms: 0 } }, { ownerProjectRoot: 'file:///workspace' }, authority, false, 1, () => true);
		await Promise.resolve();
		const receiptId = streamState.parent.toolInfo.receiptId;
		await (ChatThreadService.prototype as any).abortRunning.call(receiver, 'parent');
		assert.strictEqual(cancelParent, 1); assert.strictEqual(streamState.parent.toolInfo.receiptId, receiptId); assert.strictEqual(streamState.parent.toolInfo.lifecycle, 'cancelling'); assert.deepStrictEqual(messages, []);
		release(); assert.deepStrictEqual(await pending, { interrupted: true });
		assert.strictEqual(streamState.parent.toolInfo, undefined); assert.deepStrictEqual(messages, []);
	});

	test('classifies validated child-control execution failures without confusing malformed input', async () => {
		const authority: any = { allowed: true, generation: 1 }; const messages: any[] = []; const streamState: any = {};
		const receiver: any = { state: { allThreads: { parent: { messages } } }, streamState, _agentDelegationAuthorityOfThread: new Map([['parent', authority]]), _agentControlGeneration: new Map([['parent', 1]]), _agentSubagentService: { wait: async () => { throw new Error('child wait backend failed'); } }, _setStreamState(id: string, state: any) { streamState[id] = state; }, _addMessageToThread(_id: string, message: any) { messages.push(message); } };
		const failed = await (ChatThreadService.prototype as any)._runToolCall.call(receiver, 'parent', 'wait_agent', 'valid-id', undefined, { preapproved: false, unvalidatedToolParams: { timeout_ms: 0 } }, { ownerProjectRoot: 'file:///workspace' }, authority, false, 1, () => true);
		assert.deepStrictEqual(failed, { failure: 'error: child wait backend failed', validatedParams: { timeout_ms: 0 } }); assert.deepStrictEqual({ type: messages[0].type, id: messages[0].id, params: messages[0].params }, { type: 'tool_error', id: 'valid-id', params: { timeout_ms: 0 } }); assert.strictEqual(streamState.parent.toolInfo, undefined);
		const malformed = await (ChatThreadService.prototype as any)._runToolCall.call(receiver, 'parent', 'wait_agent', 'bad-id', undefined, { preapproved: false, unvalidatedToolParams: { timeout_ms: -1 } }, { ownerProjectRoot: 'file:///workspace' }, authority, false, 1, () => true);
		assert.deepStrictEqual(malformed, {}); assert.deepStrictEqual({ type: messages[1].type, id: messages[1].id }, { type: 'invalid_params', id: 'bad-id' });
	});
});
