import assert from 'assert';
import { ChatThreadService } from '../../browser/chatThreadService.js';
import { ConvertToLLMMessageService } from '../../browser/convertToLLMMessageService.js';
import { projectAgentConfig, resolveAgentInstructions, stableAgentInstructionRevision } from '../../common/agentInstructions.js';
import { createAgentRuntimeTurnSnapshot, createSkillCatalog, skillAdvertisement } from '../../common/agentSkills.js';
import { getIsReasoningEnabledState, getModelCapabilities, getReservedOutputTokenSpace } from '../../common/modelCapabilities.js';

const snapshot = () => {
	const config = projectAgentConfig({ developerInstructions: 'developer instruction', projectDocMaxBytes: 100 }, undefined, [{ uri: 'file:///home/.codex/config.toml', scope: 'user', status: 'loaded', projectedKeys: ['developer_instructions', 'project_doc_max_bytes'] }], 'file:///workspace', 'file:///workspace');
	const candidates = [{ uri: 'file:///workspace/AGENTS.md', outcome: Object.freeze({ status: 'bytes' as const, bytes: new TextEncoder().encode('AGENTS instruction') }) }];
	return resolveAgentInstructions(config, candidates, stableAgentInstructionRevision(config, candidates));
};
const runtimeSnapshot = (trusted = true) => {
	const catalog = createSkillCatalog([]);
	return createAgentRuntimeTurnSnapshot(snapshot(), catalog, skillAdvertisement(catalog, undefined), [], { hasModel: false }, trusted);
};
const projectRuntimeSnapshot = () => { const catalog = createSkillCatalog([{ source: 'repository' as const, rank: 0, root: 'file:///workspace', skillRoot: 'file:///workspace/.agents/skills/demo', directoryName: 'demo', bytes: new TextEncoder().encode('---\nname: demo\ndescription: demo\n---\nbody') }]); return createAgentRuntimeTurnSnapshot(snapshot(), catalog, skillAdvertisement(catalog, undefined), [], { hasModel: false }, true); };
const approvalModel = { providerName: 'openAI' as const, modelName: 'gpt-4.1' };
const approvalOptions = {};
const approvalOverrides = { openAI: { 'gpt-4.1': {} } } as never;
const approvalRuntimeSnapshot = () => { const catalog = createSkillCatalog([]); const contextWindow = getModelCapabilities(approvalModel.providerName, approvalModel.modelName, approvalOverrides).contextWindow; const reserve = Math.max(contextWindow / 2, getReservedOutputTokenSpace(approvalModel.providerName, approvalModel.modelName, { isReasoningEnabled: getIsReasoningEnabledState('Chat', approvalModel.providerName, approvalModel.modelName, approvalOptions, approvalOverrides), overridesOfModel: approvalOverrides }) ?? 4096); return createAgentRuntimeTurnSnapshot(snapshot(), catalog, skillAdvertisement(catalog, contextWindow), [], { hasModel: true, ...approvalModel, contextWindow, reservedOutputTokens: reserve, modelSelectionOptions: approvalOptions, selectedModelOverrides: {} }, true); };

const pendingTool = () => ({ role: 'tool', type: 'tool_request', name: 'read_file', params: {}, content: 'approval requested', result: null, id: 'tool-1', rawParams: {}, mcpServerName: undefined });

const runtimeHelpers = ChatThreadService.prototype as unknown as {
	_beginInstructionTurn: (threadId: string) => Promise<unknown>;
	_purgeInstructionTurn: (threadId: string, removeSession?: boolean) => void;
	_rememberInstructionTurn: (threadId: string, snapshot: unknown) => void;
};
const beginInstructionTurn = runtimeHelpers._beginInstructionTurn;
const purgeInstructionTurn = runtimeHelpers._purgeInstructionTurn;
const rememberInstructionTurn = runtimeHelpers._rememberInstructionTurn;
const revokeAgentDelegation = (ChatThreadService.prototype as unknown as { _revokeAgentDelegation: (threadId: string, forget?: boolean) => void })._revokeAgentDelegation;
const delegationLifecycleFixture = () => ({
	_revokeAgentDelegation: revokeAgentDelegation,
	_cancelChildToolApprovalsForParent() { },
	_agentControlGeneration: new Map<string, number>(),
	_parentRunTokenOfThread: new Map<string, symbol>(),
	_agentDelegationAuthorityOfThread: new Map<string, unknown>(),
	_agentSubagentService: { cancelParent() { }, forgetParent() { } },
	_toolsService: { invalidateReadReceipts(_threadId: string) { } },
});
const nonAgentSettingsFixture = () => ({ state: { overridesOfModel: {}, globalSettings: { chatMode: 'chat' } } });

suite('AGENTS instruction runtime paths', () => {
	test('restores a persisted snapshot and resumes approval with that exact revived turn', () => {
		const persisted = JSON.parse(JSON.stringify(approvalRuntimeSnapshot()));
		const thread = { messages: [pendingTool()], state: { stagingSelections: [], focusedMessageIdx: undefined, linksOfMessageIdx: {}, agentInstructionTurnSnapshot: persisted }, filesWithUserChanges: new Set<string>() };
		let resumed: unknown;
		const receiver = {
			...delegationLifecycleFixture(),
			_purgeInstructionTurn: purgeInstructionTurn,
			_instructionTurnOfThread: new Map<string, unknown>(),
			_workspaceContextService: { getWorkspace: () => ({ folders: [{ uri: { toString: () => 'file:///workspace' } }] }) },
			_workspaceTrustManagementService: { isWorkspaceTrusted: () => true },
			state: { allThreads: { task: thread } },
			_runChatAgent(options: unknown) { resumed = options; return Promise.resolve(); },
			_updateLatestTool() { },
			_setStreamState() { },
			_wrapRunAgentToNotify() { },
			_settingsService: { state: { overridesOfModel: approvalOverrides } },
			_currentModelSelectionProps() { return { modelSelection: approvalModel, modelSelectionOptions: approvalOptions }; },
		};
		const restore = (ChatThreadService.prototype as unknown as { _restoreInstructionTurns: (threads: unknown) => void })._restoreInstructionTurns;
		restore.call(receiver, receiver.state.allThreads);
		const revived = receiver._instructionTurnOfThread.get('task');
		ChatThreadService.prototype.approveLatestToolRequest.call(receiver as never, 'task');
		assert.notStrictEqual(revived, persisted);
		assert.strictEqual((resumed as { instructionSnapshot: unknown }).instructionSnapshot, revived);
		assert.strictEqual(((resumed as { instructionSnapshot: { revision: string } }).instructionSnapshot).revision, approvalRuntimeSnapshot().revision);
	});

	test('fails closed when a pending approval lacks or has a corrupt persisted snapshot', () => {
		for (const persisted of [undefined, { revision: '' }]) {
			const thread = { messages: [pendingTool()], state: { stagingSelections: [], focusedMessageIdx: undefined, linksOfMessageIdx: {}, agentInstructionTurnSnapshot: persisted }, filesWithUserChanges: new Set<string>() };
			let runCalls = 0;
			let rejected: unknown;
			let cleared = false;
			const receiver = {
				...delegationLifecycleFixture(),
				_purgeInstructionTurn: purgeInstructionTurn,
				_instructionTurnOfThread: new Map<string, unknown>(),
				_workspaceContextService: { getWorkspace: () => ({ folders: [{ uri: { toString: () => 'file:///workspace' } }] }) },
				_workspaceTrustManagementService: { isWorkspaceTrusted: () => true },
				state: { allThreads: { task: thread } },
				_runChatAgent() { runCalls++; return Promise.resolve(); },
				_wrapRunAgentToNotify() { },
				_currentModelSelectionProps() { return {}; },
				_updateLatestTool(_threadId: string, tool: unknown) { rejected = tool; },
				_setStreamState(_threadId: string, state: unknown) { cleared = state === undefined; },
			};
			const restore = (ChatThreadService.prototype as unknown as { _restoreInstructionTurns: (threads: unknown) => void })._restoreInstructionTurns;
			restore.call(receiver, receiver.state.allThreads);
			ChatThreadService.prototype.approveLatestToolRequest.call(receiver as never, 'task');
			assert.strictEqual(runCalls, 0);
			assert.strictEqual((rejected as { type: string }).type, 'rejected');
			assert.strictEqual(cleared, true);
		}
	});

	test('purges a cross-workspace snapshot and fails its pending approval closed', () => {
		const thread = { messages: [pendingTool()], state: { stagingSelections: [], focusedMessageIdx: undefined, linksOfMessageIdx: {}, agentInstructionTurnSnapshot: JSON.parse(JSON.stringify(runtimeSnapshot(false))) }, filesWithUserChanges: new Set<string>() };
		let runs = 0;
		let rejected: unknown;
		let cleared = false;
		const receiver = {
			...delegationLifecycleFixture(),
			_purgeInstructionTurn: purgeInstructionTurn,
			_instructionTurnOfThread: new Map<string, unknown>(),
			_workspaceContextService: { getWorkspace: () => ({ folders: [{ uri: { toString: () => 'file:///workspace-b' } }] }) },
			_workspaceTrustManagementService: { isWorkspaceTrusted: () => true },
			state: { allThreads: { task: thread } },
			_runChatAgent() { runs++; return Promise.resolve(); },
			_wrapRunAgentToNotify() { },
			_currentModelSelectionProps() { return {}; },
			_updateLatestTool(_threadId: string, tool: unknown) { rejected = tool; },
			_setStreamState(_threadId: string, state: unknown) { cleared = state === undefined; },
		};
		const restore = (ChatThreadService.prototype as unknown as { _restoreInstructionTurns: (threads: unknown) => void })._restoreInstructionTurns;
		restore.call(receiver, receiver.state.allThreads);
		assert.strictEqual(thread.state.agentInstructionTurnSnapshot, undefined);
		assert.strictEqual(thread.messages.length, 1);
		assert.strictEqual(receiver._instructionTurnOfThread.has('task'), false);
		ChatThreadService.prototype.approveLatestToolRequest.call(receiver as never, 'task');
		assert.strictEqual(runs, 0);
		assert.strictEqual((rejected as { type: string }).type, 'rejected');
		assert.strictEqual(cleared, true);
	});

	test('purges trusted project snapshot after workspace trust is downgraded and rejects its approval', () => {
		const persisted = JSON.parse(JSON.stringify(projectRuntimeSnapshot()));
		const thread = { messages: [pendingTool()], state: { stagingSelections: [], focusedMessageIdx: undefined, linksOfMessageIdx: {}, agentInstructionTurnSnapshot: persisted }, filesWithUserChanges: new Set<string>() };
		let runCalls = 0;
		let rejected: unknown;
		let cleared = false;
		const receiver = {
			...delegationLifecycleFixture(),
			_purgeInstructionTurn: purgeInstructionTurn,
			_agentInstructionSessionOfThread: new Map<string, unknown>(), _instructionTurnOfThread: new Map<string, unknown>(),
			_workspaceContextService: { getWorkspace: () => ({ folders: [{ uri: { toString: () => 'file:///workspace' } }] }) }, _workspaceTrustManagementService: { isWorkspaceTrusted: () => false },
			state: { allThreads: { task: thread } }, _runChatAgent() { runCalls++; return Promise.resolve(); }, _wrapRunAgentToNotify() { }, _currentModelSelectionProps() { return {}; },
			_updateLatestTool(_threadId: string, tool: unknown) { rejected = tool; }, _setStreamState(_threadId: string, state: unknown) { cleared = state === undefined; },
		};
		const restore = (ChatThreadService.prototype as unknown as { _restoreInstructionTurns: (threads: unknown) => void })._restoreInstructionTurns;
		restore.call(receiver, { task: thread });
		assert.strictEqual(thread.state.agentInstructionTurnSnapshot, undefined);
		assert.strictEqual(receiver._instructionTurnOfThread.has('task'), false);
		ChatThreadService.prototype.approveLatestToolRequest.call(receiver as never, 'task');
		assert.strictEqual(runCalls, 0);
		assert.strictEqual((rejected as { type: string }).type, 'rejected');
		assert.strictEqual(cleared, true);
	});

	test('fails a workspace-owner drift before user history, config, or provider work', async () => {
		const thread = { messages: [{ role: 'user', content: 'existing' }], state: { stagingSelections: [] }, filesWithUserChanges: new Set<string>() };
		let configCalls = 0;
		let turnCalls = 0;
		let providerCalls = 0;
		let stored = 0;
		const receiver = {
			...delegationLifecycleFixture(),
			_beginInstructionTurn: beginInstructionTurn, _purgeInstructionTurn: purgeInstructionTurn,
			_agentInstructionSessionOfThread: new Map([['task', { ownerProjectRoot: 'file:///workspace-a', trustedAtStart: true, session: {} }]]),
			_instructionTurnOfThread: new Map<string, unknown>(), state: { allThreads: { task: thread } },
			_workspaceContextService: { getWorkspace: () => ({ folders: [{ uri: { toString: () => 'file:///workspace-b' } }] }) }, _workspaceTrustManagementService: { isWorkspaceTrusted: () => true },
			_agentInstructionsService: { beginTaskSession() { configCalls++; return Promise.resolve({}); }, beginTopLevelTurn() { turnCalls++; return Promise.resolve(snapshot()); } },
			_settingsService: nonAgentSettingsFixture(),
			_storeAllThreads() { stored++; }, _runChatAgent() { providerCalls++; return Promise.resolve(); }, _wrapRunAgentToNotify() { }, _currentModelSelectionProps() { return {}; },
			_directoryStringService: {}, _fileService: {}, streamState: {},
		};
		const add = (ChatThreadService.prototype as unknown as { _addUserMessageAndStreamResponse: (options: unknown) => Promise<void> })._addUserMessageAndStreamResponse;
		await assert.rejects(() => add.call(receiver, { userMessage: 'must not be stored', threadId: 'task' }), /different workspace/);
		await assert.rejects(() => add.call(receiver, { userMessage: 'must not be stored either', threadId: 'task' }), /different workspace/);
		assert.strictEqual(thread.messages.length, 1);
		assert.strictEqual(configCalls, 0);
		assert.strictEqual(turnCalls, 0);
		assert.strictEqual(providerCalls, 0);
		assert.strictEqual((receiver._agentInstructionSessionOfThread.get('task') as { ownerProjectRoot: string }).ownerProjectRoot, 'file:///workspace-a');
		assert.strictEqual(stored, 2);
	});

	test('fails closed when the workspace owner changes while a turn snapshot is loading', async () => {
		const originalSnapshot = snapshot();
		const thread = { messages: [{ role: 'user', content: 'existing' }], state: { stagingSelections: [] } as { stagingSelections: never[]; agentInstructionTurnSnapshot?: unknown }, filesWithUserChanges: new Set<string>() };
		let owner = 'file:///workspace';
		let configCalls = 0;
		let turnCalls = 0;
		let providerCalls = 0;
		let stored = 0;
		let turnStarted!: () => void;
		let finishTurn!: (value: typeof originalSnapshot) => void;
		const started = new Promise<void>(resolve => { turnStarted = resolve; });
		const delayedTurn = new Promise<typeof originalSnapshot>(resolve => { finishTurn = resolve; });
		const receiver = {
			...delegationLifecycleFixture(),
			_beginInstructionTurn: beginInstructionTurn, _purgeInstructionTurn: purgeInstructionTurn,
			_agentInstructionSessionOfThread: new Map<string, unknown>(), _instructionTurnOfThread: new Map<string, unknown>(), state: { allThreads: { task: thread } },
			_workspaceContextService: { getWorkspace: () => ({ folders: [{ uri: { toString: () => owner } }] }) }, _workspaceTrustManagementService: { isWorkspaceTrusted: () => true },
			_agentInstructionsService: {
				beginTaskSession() { configCalls++; return Promise.resolve(originalSnapshot.config); },
				beginTopLevelTurn() { turnCalls++; turnStarted(); return delayedTurn; },
			},
			_settingsService: nonAgentSettingsFixture(),
			_storeAllThreads() { stored++; }, _runChatAgent() { providerCalls++; return Promise.resolve(); }, _wrapRunAgentToNotify() { }, _currentModelSelectionProps() { return {}; },
			_directoryStringService: {}, _fileService: {}, streamState: {},
		};
		const add = (ChatThreadService.prototype as unknown as { _addUserMessageAndStreamResponse: (options: unknown) => Promise<void> })._addUserMessageAndStreamResponse;
		const pending = add.call(receiver, { userMessage: 'must not be stored', threadId: 'task' });
		await started;
		owner = 'file:///workspace-b';
		finishTurn(originalSnapshot);
		await assert.rejects(pending, /different workspace/);
		await assert.rejects(() => add.call(receiver, { userMessage: 'must still not be stored', threadId: 'task' }), /different workspace/);
		assert.strictEqual(thread.messages.length, 1);
		assert.strictEqual(configCalls, 1);
		assert.strictEqual(turnCalls, 1);
		assert.strictEqual(providerCalls, 0);
		assert.strictEqual(thread.state.agentInstructionTurnSnapshot, undefined);
		assert.strictEqual(receiver._instructionTurnOfThread.has('task'), false);
		assert.strictEqual((receiver._agentInstructionSessionOfThread.get('task') as { ownerProjectRoot: string }).ownerProjectRoot, 'file:///workspace');
		assert.strictEqual(stored, 2);
	});

	test('restarts a trusted task session as user-only after trust is downgraded', async () => {
		let trusted = true;
		let configCalls = 0;
		const loadedConfigs: unknown[] = [];
		const trustedConfig = projectAgentConfig(undefined, { developerInstructions: 'project' }, [{ uri: 'file:///workspace/.codex/config.toml', scope: 'project', status: 'loaded', projectedKeys: ['developer_instructions'] }], 'file:///workspace', 'file:///workspace');
		const userConfig = projectAgentConfig({ developerInstructions: 'user' }, undefined, [{ uri: 'file:///home/.codex/config.toml', scope: 'user', status: 'loaded', projectedKeys: ['developer_instructions'] }], 'file:///workspace', 'file:///workspace');
		const thread = { messages: [], state: {}, filesWithUserChanges: new Set<string>() };
		const receiver = {
			_purgeInstructionTurn: purgeInstructionTurn, _rememberInstructionTurn: rememberInstructionTurn,
			_agentInstructionSessionOfThread: new Map<string, unknown>(), _instructionTurnOfThread: new Map<string, unknown>(), state: { allThreads: { task: thread } }, _storeAllThreads() { },
			_workspaceContextService: { getWorkspace: () => ({ folders: [{ uri: { toString: () => 'file:///workspace' } }] }) }, _workspaceTrustManagementService: { isWorkspaceTrusted: () => trusted },
			_agentInstructionsService: { beginTaskSession() { configCalls++; return Promise.resolve(trusted ? trustedConfig : userConfig); }, beginTopLevelTurn(config: unknown) { loadedConfigs.push(config); return Promise.resolve(snapshot()); } },
		};
		await beginInstructionTurn.call(receiver, 'task');
		trusted = false;
		await beginInstructionTurn.call(receiver, 'task');
		assert.strictEqual(configCalls, 2);
		assert.strictEqual((loadedConfigs[0] as { configSources: { scope: string }[] }).configSources[0].scope, 'project');
		assert.strictEqual((loadedConfigs[1] as { configSources: { scope: string }[] }).configSources[0].scope, 'user');
	});

	test('routes gpt-4.1 Chat authority through the production converter and excludes simple/FIM instructions', async () => {
		const poison = 'legacy global AI Instructions must never be read';
		const globalSettings = Object.defineProperty({}, 'aiInstructions', { get() { throw new Error(poison); } });
		const settings = { state: { overridesOfModel: {}, globalSettings, optionsOfModelSelection: { Chat: { openAI: { 'gpt-4.1': undefined } }, 'Ctrl+K': { openAI: { 'gpt-4.1': undefined } } } } };
		const converter = new ConvertToLLMMessageService(
			{ getModels: () => [] } as never,
			{ getWorkspace: () => ({ folders: [] }) } as never,
			{ activeEditor: undefined } as never,
			{ getAllDirectoriesStr: async () => 'directory listing' } as never,
			{ listPersistentTerminalIds: () => [] } as never,
			settings as never,
			{ getMCPTools: () => [] } as never,
		);
		(converter as unknown as { _generateChatMessagesSystemMessage: () => Promise<string> })._generateChatMessagesSystemMessage = async () => 'generated internal system';
		const modelSelection = { providerName: 'openAI', modelName: 'gpt-4.1' };
		const legacy = Object.assign(Object.create({ schemaVersion: 2 }), snapshot());
		const chat = await converter.prepareLLMChatMessages({ chatMessages: [{ role: 'user', content: 'hello' }] as never, chatMode: 'agent' as never, modelSelection: modelSelection as never, instructionSnapshot: legacy });
		const simple = converter.prepareLLMSimpleMessages({ simpleMessages: [{ role: 'user', content: 'simple user' }] as never, systemMessage: 'simple system', modelSelection: modelSelection as never, featureName: 'Ctrl+K' as never });
		const fim = converter.prepareFIMMessage({ messages: { prefix: 'prefix', suffix: 'suffix', stopTokens: ['stop'] } });
		const developerMessages = chat.messages.slice(0, 2).map(message => {
			if (message.role !== 'developer') throw new Error('Expected a developer message');
			return { role: message.role, content: message.content };
		});
		assert.deepStrictEqual(developerMessages, [{ role: 'developer', content: 'developer instruction\n\nAGENTS instruction' }, { role: 'developer', content: 'generated internal system' }]);
		assert.deepStrictEqual(chat.messages[2], { role: 'user', content: 'hello' });
		assert.strictEqual(JSON.stringify(simple).includes('developer instruction'), false);
		assert.strictEqual(JSON.stringify(simple).includes('AGENTS instruction'), false);
		assert.strictEqual(JSON.stringify(simple).includes('.voidrules'), false);
		assert.deepStrictEqual(fim, { prefix: 'prefix', suffix: 'suffix', stopTokens: ['stop'] });
	});

	test('keeps one immutable instruction snapshot through retry and tool-loop sends', async () => {
		const instructionSnapshot = Object.freeze(runtimeSnapshot());
		const thread = { messages: [{ role: 'user', content: 'start' }] as unknown[], state: {}, filesWithUserChanges: new Set<string>() };
		const preparedMessages: unknown[][] = [];
		const preparedSnapshots: unknown[] = [];
		const sentMessages: unknown[] = [];
		const metrics: unknown[] = [];
		let preparation = 0;
		let sends = 0;
		let toolCalls = 0;
		const streamState: Record<string, unknown> = {};
		const receiver = {
			state: { allThreads: { task: thread }, overridesOfModel: {} },
			_agentControlGeneration: new Map<string, number>(),
			_parentRunTokenOfThread: new Map<string, symbol>(),
			streamState,
			_settingsService: { state: { globalSettings: { chatMode: 'agent' }, overridesOfModel: {} } },
			_setStreamState(threadId: string, value: unknown) { streamState[threadId] = value; },
			_convertToLLMMessagesService: {
				prepareLLMChatMessages: async ({ chatMessages, instructionSnapshot: receivedSnapshot }: { chatMessages: unknown[]; instructionSnapshot: unknown }) => {
					preparedSnapshots.push(receivedSnapshot);
					assert.strictEqual(chatMessages, thread.messages);
					const messages = [{ role: 'user', content: `prepared-${preparation++}` }];
					preparedMessages.push(messages);
					return { messages, separateSystemMessage: undefined };
				},
			},
			_llmMessageService: {
				sendLLMMessage: (options: { messages: unknown; onError: (error: { message: string; fullError: Error | null }) => Promise<void>; onFinalMessage: (result: { fullText: string; fullReasoning: string; toolCalls?: readonly unknown[]; anthropicReasoning: null }) => Promise<void> }) => {
					sentMessages.push(options.messages);
					sends++;
					if (sends === 1) {
						void options.onError({ message: 'transient', fullError: null });
					} else if (sends === 2) {
						void options.onFinalMessage({ fullText: 'tool', fullReasoning: '', toolCalls: [{ name: 'read_file', id: 'tool-1', rawParams: {} }], anthropicReasoning: null });
					} else {
						void options.onFinalMessage({ fullText: 'done', fullReasoning: '', anthropicReasoning: null });
					}
					return `send-${sends}`;
				},
				abort() { },
			},
			_mcpService: { getMCPTools: () => [{ name: 'read_file', mcpServerName: 'local' }] },
			async _runToolCall() { toolCalls++; return { awaitingUserApproval: false, interrupted: false }; },
			_addMessageToThread(_threadId: string, message: unknown) { thread.messages.push(message); },
			_metricsService: { capture: (...args: unknown[]) => metrics.push(args) },
		};

		const token = Symbol('instruction-runtime-parent-run'); let active = true; receiver._parentRunTokenOfThread.set('task', token); const isLatest = () => receiver._parentRunTokenOfThread.get('task') === token && (receiver._agentControlGeneration.get('task') ?? 0) === 0; const parentRun = { token, generation: 0, isLatest, isActive: () => active && isLatest(), deactivate: () => { active = false; }, releaseLatest: () => { if (isLatest()) receiver._parentRunTokenOfThread.delete('task'); } };
		const run = (ChatThreadService.prototype as unknown as { _runChatAgent: (options: unknown) => Promise<void> })._runChatAgent;
		await run.call(receiver, { threadId: 'task', modelSelection: null, modelSelectionOptions: undefined, instructionSnapshot, parentRun });

		assert.strictEqual(sends, 3);
		assert.strictEqual(preparedMessages.length, 2);
		assert.strictEqual(toolCalls, 1);
		assert.strictEqual(sentMessages[0], sentMessages[1]);
		assert.strictEqual(sentMessages[0], preparedMessages[0]);
		assert.strictEqual(sentMessages[2], preparedMessages[1]);
		assert.notStrictEqual(preparedMessages[0], preparedMessages[1]);
		assert.strictEqual(preparedSnapshots.length, 2);
		assert.strictEqual(preparedSnapshots[0], instructionSnapshot);
		assert.strictEqual(preparedSnapshots[1], instructionSnapshot);
		assert.deepStrictEqual(metrics, [['Agent Loop Done', { nMessagesSent: 2, chatMode: 'agent' }]]);
	});
});
