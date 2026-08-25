/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ChatThreadService } from '../../browser/chatThreadService.js';
import { ConvertToLLMMessageService } from '../../browser/convertToLLMMessageService.js';
import { projectAgentConfig, resolveAgentInstructions, stableAgentInstructionRevision } from '../../common/agentInstructions.js';
import { createSkillCatalog } from '../../common/agentSkills.js';
import { assistantMessagePresentation, INTERNAL_EMPTY_MESSAGE_SENTINEL, sanitizeAssistantDisplayContent } from '../../common/assistantMessagePresentation.js';
import { PENDING_CHAT_INPUT_STORAGE_KEY, THREAD_STORAGE_KEY } from '../../common/storageKeys.js';
import { StorageScope } from '../../../../../platform/storage/common/storage.js';
import { URI } from '../../../../../base/common/uri.js';
import { Severity } from '../../../../../platform/notification/common/notification.js';
import { TerminalToolService } from '../../browser/terminalToolService.js';

const bytes = (value: string) => new TextEncoder().encode(value);

const instructionSnapshot = () => {
	const config = projectAgentConfig(
		{ developerInstructions: 'deterministic local fixture' },
		undefined,
		[],
		'file:///workspace',
		'file:///workspace',
	);
	const candidates = [{ uri: 'file:///workspace/AGENTS.md', outcome: Object.freeze({ status: 'bytes' as const, bytes: bytes('fixture instructions') }) }];
	return Object.freeze({
		...resolveAgentInstructions(config, candidates, stableAgentInstructionRevision(config, candidates)),
		model: Object.freeze({
			hasModel: true as const,
			providerName: 'openAICompatible' as const,
			modelName: 'gpt-4.1',
			contextWindow: 10_000,
			reservedOutputTokens: 1_000,
			modelSelectionOptions: Object.freeze({ reasoningEnabled: true }),
			selectedModelOverrides: Object.freeze({ specialToolFormat: 'openai-style' as const }),
		}),
	});
};

type TestParentRun = Readonly<{ token: symbol; runId: string; generation: number; isLatest: () => boolean; isActive: () => boolean; deactivate: () => void; releaseLatest: () => void }>;
type ParentRunFixture = { _agentControlGeneration: Map<string, number>; _parentRunTokenOfThread: Map<string, symbol> };
type TestMessage = { role: string; content?: string; displayContent?: string; reasoning?: string; type?: string };
type TestToolMutation = { type?: string };
type TestLLMInfo = { displayContentSoFar: string; reasoningSoFar: string; toolCallSoFar: unknown };
type TestStream = { isRunning?: string; llmInfo?: TestLLMInfo; toolInfo?: { toolName: string; toolParams: unknown; id: string; content: string; rawParams: unknown; mcpServerName?: string }; interrupt?: Promise<() => void> | 'not_needed'; error?: unknown };
type TestStreamRecord = Record<string, TestStream | undefined>;
type TestProviderCallbacks = {
	onText(value: { fullText: string; fullReasoning: string; toolCall?: unknown }): void;
	onFinalMessage(value: { fullText: string; fullReasoning: string; toolCall?: { name: string; id: string; rawParams: Record<string, unknown> }; anthropicReasoning: null }): Promise<void>;
	onError(error: { message: string; fullError: Error | null }): Promise<void>;
	onAbort(): void;
};
type TestNotification = { severity: Severity; message: string };
type TestBuiltinSetup = { execute: () => Promise<unknown> } | { result: Promise<unknown>; interruptTool: () => void };
type TestRunChatOptions = {
	threadId: string;
	modelSelection: { providerName: 'openAI' | 'openAICompatible'; modelName: string } | null;
	modelSelectionOptions: unknown;
	instructionSnapshot: ReturnType<typeof instructionSnapshot>;
	callThisToolFirst?: { role: 'tool'; type: 'tool_request'; name: 'read_file'; id: string; params: Record<string, unknown>; rawParams: Record<string, unknown>; content: string; result: null; mcpServerName: undefined };
};
type TestToolCallResult = { awaitingUserApproval?: boolean; interrupted?: boolean };
interface ChatLifecycleTestAdapter {
	_runChatAgent(this: unknown, options: TestRunChatOptions & { parentRun: TestParentRun }): Promise<void>;
	_runToolCall(this: unknown, threadId: string, toolName: string, toolId: string, mcpServerName: string | undefined, options: { preapproved: true; unvalidatedToolParams: Record<string, unknown>; validatedParams: Record<string, unknown> }, snapshot: ReturnType<typeof instructionSnapshot>, authority: undefined, skillReadAllowed: boolean, generation: number, isActive: () => boolean): Promise<TestToolCallResult>;
	_wrapRunAgentToNotify(this: unknown, promise: Promise<void>, threadId: string, parentRun: TestParentRun): Promise<void>;
	_revokeAgentDelegation(this: unknown, threadId: string, forget?: boolean): void;
	abortRunning(this: unknown, threadId: string): Promise<void>;
}
const chatLifecycle = ChatThreadService.prototype as unknown as ChatLifecycleTestAdapter;
let nextTestParentRunId = 0;

const llmInfoOf = (stream: TestStream | undefined): TestLLMInfo => {
	if (!stream?.llmInfo) throw new Error('Expected an LLM stream fixture.');
	return stream.llmInfo;
};

const beginTestParentRun = (receiver: ParentRunFixture, threadId: string): TestParentRun => {
	const token = Symbol('test-parent-run');
	const runId = `test-parent-${++nextTestParentRunId}`;
	const generation = receiver._agentControlGeneration.get(threadId) ?? 0;
	let active = true;
	receiver._parentRunTokenOfThread.set(threadId, token);
	const isLatest = () => receiver._parentRunTokenOfThread.get(threadId) === token && (receiver._agentControlGeneration.get(threadId) ?? 0) === generation;
	return { token, runId, generation, isLatest, isActive: () => active && isLatest(), deactivate: () => { active = false; }, releaseLatest: () => { if (isLatest()) receiver._parentRunTokenOfThread.delete(threadId); } };
};

const standaloneParentRun = (isLatest: () => boolean): TestParentRun => ({ token: Symbol('standalone-parent-run'), runId: 'standalone-parent-run', generation: 0, isLatest, isActive: isLatest, deactivate() { }, releaseLatest() { } });

const runChatAgent = (receiver: ParentRunFixture, options: TestRunChatOptions) => {
	const parentRun = beginTestParentRun(receiver, options.threadId);
	return chatLifecycle._runChatAgent.call(receiver, { ...options, parentRun });
};

const deferred = <T>() => {
	let resolve: (value: T) => void = () => { throw new Error('deferred resolve was not initialized'); };
	let reject: (error: Error) => void = () => { throw new Error('deferred reject was not initialized'); };
	const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
	return { promise, resolve, reject };
};

const flushMicrotasks = async (): Promise<void> => {
	await Promise.resolve();
	await Promise.resolve();
};

const createPendingInboxReceiver = (options?: { storage?: Map<string, string>; owner?: string | undefined; trusted?: boolean }) => {
	const storage = options?.storage ?? new Map<string, string>();
	const context = { owner: options?.owner ?? 'file:///workspace', trusted: options?.trusted ?? true };
	const messages: any[] = [];
	const deliveries: string[] = [];
	const storageScopes: unknown[] = [];
	const pendingEvents: string[] = [];
	const receiver: any = {
		state: { allThreads: { task: { id: 'task', messages, state: { stagingSelections: [], linksOfMessageIdx: {} }, filesWithUserChanges: new Set<string>() } }, currentThreadId: 'task' },
		streamState: {},
		_pendingChatInputsOfThread: new Map(),
		_drainingPendingChatInputs: new Set(),
		_runQuiescenceOfThread: new Map(),
		_stopAndSendFlights: new Map(),
		_deletingPendingInputThreads: new Set(),
		_pendingChatSubmissionOfThread: new Map(),
		_cancellingToolReceiptsOfThread: new Map(),
		_agentInstructionSessionOfThread: new Map(),
		_instructionTurnOfThread: new Map(),
		_transientComposerDraftOfThread: new Map(),
		_agentControlGeneration: new Map([['task', 0]]),
		_parentRunTokenOfThread: new Map(),
		_workspaceContextService: { getWorkspace: () => ({ folders: context.owner ? [{ uri: URI.parse(context.owner) }] : [] }) },
		_workspaceTrustManagementService: { isWorkspaceTrusted: () => context.trusted },
		_storageService: {
			store(key: string, value: string, scope: unknown) { storage.set(key, value); storageScopes.push(scope); },
			get(key: string, _scope: unknown) { return storage.get(key); },
		},
		_onDidChangePendingChatSubmission: { fire() { } },
		_onDidChangePendingChatInputs: { fire(event: { threadId: string }) { pendingEvents.push(event.threadId); } },
		_addMessageToThread(_threadId: string, message: any) { messages.push(message); },
		_updateLatestTool(_threadId: string, message: any) { if (messages.length) messages[messages.length - 1] = message; else messages.push(message); },
		_addUserMessageAndStreamResponse: async ({ userMessage }: { userMessage: string }) => { deliveries.push(userMessage); return true; },
		_setStreamState(threadId: string, value: unknown) { this.streamState[threadId] = value; },
		_revokeAgentDelegation() { },
		_toolsService: { invalidateReadReceipts() { } },
		toolErrMsgs: { rejected: 'Rejected', interrupted: 'Interrupted', errWhenStringifying: () => 'stringify failed' },
		_storeAllThreads() { },
		_setState(partial: unknown) { this.state = { ...this.state, ...(partial as object) }; },
	};
	Object.setPrototypeOf(receiver, ChatThreadService.prototype);
	return { receiver, context, storage, storageScopes, pendingEvents, messages, deliveries };
};

suite('Assistant message lifecycle', () => {
	test('a delayed provider final from an aborted run cannot append into a newer LLM run', async () => {
		const snapshot = instructionSnapshot();
		const callbacks: TestProviderCallbacks[] = [];
		const messages: TestMessage[] = [];
		const streamState: TestStreamRecord = {};
		const receiver = {
			state: { allThreads: { task: { messages, state: {}, filesWithUserChanges: new Set<string>() } }, currentThreadId: 'task' },
			streamState,
			_agentControlGeneration: new Map([['task', 0]]),
			_parentRunTokenOfThread: new Map<string, symbol>(),
			_agentDelegationAuthorityOfThread: new Map(),
			_settingsService: { state: { globalSettings: { chatMode: 'agent' } } },
			_convertToLLMMessagesService: { prepareLLMChatMessages: async () => ({ messages: [], separateSystemMessage: false }) },
			_llmMessageService: { sendLLMMessage: (options: TestProviderCallbacks) => { callbacks.push(options); return `request-${callbacks.length}`; }, abort() { } },
			_mcpService: { getMCPTools: () => [] },
			_metricsService: { capture() { } },
			_setStreamState(threadId: string, value: TestStream | undefined) { streamState[threadId] = value; },
			_addMessageToThread(_threadId: string, message: TestMessage) { messages.push(message); },
		};
		const run = () => runChatAgent(receiver, { threadId: 'task', modelSelection: { providerName: 'openAICompatible', modelName: 'gpt-4.1' }, modelSelectionOptions: snapshot.model.modelSelectionOptions, instructionSnapshot: snapshot });
		const runA = run();
		await Promise.resolve();
		assert.strictEqual(callbacks.length, 1);
		receiver._agentControlGeneration.set('task', 1);
		const runB = run();
		await Promise.resolve();
		assert.strictEqual(callbacks.length, 2);
		callbacks[1].onText({ fullText: 'B partial', fullReasoning: 'B reasoning', toolCall: undefined });
		assert.strictEqual(llmInfoOf(streamState.task).displayContentSoFar, 'B partial');
		callbacks[0].onText({ fullText: 'A stale partial', fullReasoning: 'A reasoning', toolCall: undefined });
		await callbacks[0].onFinalMessage({ fullText: 'A stale result', fullReasoning: '', anthropicReasoning: null });
		await runA;
		assert.deepStrictEqual(llmInfoOf(streamState.task), { displayContentSoFar: 'B partial', reasoningSoFar: 'B reasoning', toolCallSoFar: null });
		assert.strictEqual(messages.length, 0);
		await callbacks[1].onFinalMessage({ fullText: 'B result', fullReasoning: '', anthropicReasoning: null });
		await runB;
		assert.deepStrictEqual(messages.map(message => message.displayContent), ['B result']);
	});

	test('a same-generation approval continuation owns a new parent-run token', async () => {
		const snapshot = instructionSnapshot(); const callbacks: TestProviderCallbacks[] = []; const messages: TestMessage[] = []; const streamState: TestStreamRecord = {};
		const receiver = {
			state: { allThreads: { task: { messages, state: {}, filesWithUserChanges: new Set<string>() } }, currentThreadId: 'task' }, streamState,
			_agentControlGeneration: new Map([['task', 4]]), _parentRunTokenOfThread: new Map<string, symbol>(), _agentDelegationAuthorityOfThread: new Map(),
			_settingsService: { state: { globalSettings: { chatMode: 'agent' } } }, _convertToLLMMessagesService: { prepareLLMChatMessages: async () => ({ messages: [], separateSystemMessage: false }) },
			_llmMessageService: { sendLLMMessage: (options: TestProviderCallbacks) => { callbacks.push(options); return `request-${callbacks.length}`; }, abort() { } }, _mcpService: { getMCPTools: () => [] }, _metricsService: { capture() { } },
			_setStreamState(threadId: string, value: TestStream | undefined) { streamState[threadId] = value; }, _addMessageToThread(_threadId: string, message: TestMessage) { messages.push(message); },
		};
		const run = () => runChatAgent(receiver, { threadId: 'task', modelSelection: { providerName: 'openAICompatible', modelName: 'gpt-4.1' }, modelSelectionOptions: snapshot.model.modelSelectionOptions, instructionSnapshot: snapshot });
		const runA = run(); await Promise.resolve(); const runB = run(); await Promise.resolve(); assert.strictEqual(callbacks.length, 2);
		callbacks[1].onText({ fullText: 'continuation partial', fullReasoning: '', toolCall: undefined }); callbacks[0].onText({ fullText: 'stale A', fullReasoning: '', toolCall: undefined });
		await callbacks[0].onFinalMessage({ fullText: 'stale A', fullReasoning: '', anthropicReasoning: null }); await runA;
		assert.strictEqual(llmInfoOf(streamState.task).displayContentSoFar, 'continuation partial'); assert.strictEqual(messages.length, 0);
		await callbacks[1].onFinalMessage({ fullText: 'continuation complete', fullReasoning: '', anthropicReasoning: null }); await runB;
		assert.deepStrictEqual(messages.map(message => message.displayContent), ['continuation complete']);
	});

	test('a stale preapproved-tool continuation cannot clear its replacement run', async () => {
		const snapshot = instructionSnapshot(); const callbacks: TestProviderCallbacks[] = []; const streamState: TestStreamRecord = {}; let releaseTool: () => void = () => { throw new Error('tool was not entered'); };
		const receiver = {
			state: { allThreads: { task: { messages: [], state: {}, filesWithUserChanges: new Set<string>() } }, currentThreadId: 'task' }, streamState,
			_agentControlGeneration: new Map([['task', 4]]), _parentRunTokenOfThread: new Map<string, symbol>(), _agentDelegationAuthorityOfThread: new Map(),
			_settingsService: { state: { globalSettings: { chatMode: 'agent' } } }, _convertToLLMMessagesService: { prepareLLMChatMessages: async () => ({ messages: [], separateSystemMessage: false }) },
			_llmMessageService: { sendLLMMessage: (options: TestProviderCallbacks) => { callbacks.push(options); return `request-${callbacks.length}`; }, abort() { } }, _mcpService: { getMCPTools: () => [] }, _metricsService: { capture() { } },
			_runToolCall: async () => { await new Promise<void>(resolve => releaseTool = resolve); return { interrupted: false }; }, _setStreamState(threadId: string, value: TestStream | undefined) { streamState[threadId] = value; }, _addMessageToThread() { },
		};
		const runA = runChatAgent(receiver, { threadId: 'task', modelSelection: { providerName: 'openAICompatible', modelName: 'gpt-4.1' }, modelSelectionOptions: snapshot.model.modelSelectionOptions, instructionSnapshot: snapshot, callThisToolFirst: { role: 'tool', type: 'tool_request', name: 'read_file', id: 'tool-a', params: {}, rawParams: {}, content: '', result: null, mcpServerName: undefined } });
		await Promise.resolve(); const runB = runChatAgent(receiver, { threadId: 'task', modelSelection: { providerName: 'openAICompatible', modelName: 'gpt-4.1' }, modelSelectionOptions: snapshot.model.modelSelectionOptions, instructionSnapshot: snapshot });
		await Promise.resolve(); callbacks[0].onText({ fullText: 'B partial', fullReasoning: '', toolCall: undefined }); releaseTool(); await runA;
		assert.strictEqual(llmInfoOf(streamState.task).displayContentSoFar, 'B partial'); await callbacks[0].onFinalMessage({ fullText: 'B final', fullReasoning: '', anthropicReasoning: null }); await runB;
	});

	test('a restored pending approval resumes with the default generation when no map entry exists', async () => {
		const snapshot = instructionSnapshot(); const messages: TestMessage[] = []; const streamState: TestStreamRecord = {}; let toolRuns = 0;
		const receiver = { state: { allThreads: { task: { messages, state: {}, filesWithUserChanges: new Set<string>() } }, currentThreadId: 'task' }, streamState, _agentControlGeneration: new Map<string, number>(), _parentRunTokenOfThread: new Map<string, symbol>(), _agentDelegationAuthorityOfThread: new Map(), _settingsService: { state: { globalSettings: { chatMode: 'agent' } } }, _convertToLLMMessagesService: { prepareLLMChatMessages: async () => ({ messages: [], separateSystemMessage: false }) }, _runToolCall: async () => { toolRuns++; return { interrupted: false }; }, _llmMessageService: { sendLLMMessage: (options: TestProviderCallbacks) => { queueMicrotask(() => void options.onFinalMessage({ fullText: 'resumed', fullReasoning: '', anthropicReasoning: null })); return 'resumed-request'; }, abort() { } }, _mcpService: { getMCPTools: () => [] }, _metricsService: { capture() { } }, _setStreamState(threadId: string, value: TestStream | undefined) { streamState[threadId] = value; }, _addMessageToThread(_threadId: string, message: TestMessage) { messages.push(message); } };
		await runChatAgent(receiver, { threadId: 'task', modelSelection: { providerName: 'openAICompatible', modelName: 'gpt-4.1' }, modelSelectionOptions: snapshot.model.modelSelectionOptions, instructionSnapshot: snapshot, callThisToolFirst: { role: 'tool', type: 'tool_request', name: 'read_file', id: 'restored-tool', params: {}, rawParams: {}, content: '', result: null, mcpServerName: undefined } });
		assert.strictEqual(toolRuns, 1); assert.deepStrictEqual(messages.map(message => message.displayContent), ['resumed']);
	});

	test('a stale generic MCP settlement cannot mutate replacement history or stream', async () => {
		for (const settlement of ['resolve', 'reject'] as const) {
			const pendingMCP = deferred<{ result: { ok: boolean } }>();
			const mutations: TestToolMutation[] = [];
			const replacement = { isRunning: 'LLM', llmInfo: { displayContentSoFar: `B-${settlement}`, reasoningSoFar: 'B', toolCallSoFar: null }, interrupt: Promise.resolve(() => { }) };
			const streamState: TestStreamRecord = {};
			let current = true;
			let stringifyCalls = 0;
			const receiver = {
				state: { allThreads: { task: { messages: [], state: {}, filesWithUserChanges: new Set<string>() } } },
				streamState,
				_mcpService: { getMCPTools: () => [{ name: 'deferred_mcp', mcpServerName: 'fixture' }], callMCPTool: () => pendingMCP.promise, stringifyResult: () => { stringifyCalls++; return 'late-success'; } },
				_updateLatestTool(_threadId: string, message: TestToolMutation) { mutations.push(message); },
				_setStreamState(threadId: string, value: TestStream | undefined) { streamState[threadId] = value; },
			};
			const run = chatLifecycle._runToolCall.call(receiver, 'task', 'deferred_mcp', `tool-${settlement}`, 'fixture', { preapproved: true, unvalidatedToolParams: {}, validatedParams: {} }, instructionSnapshot(), undefined, false, 0, () => current);
			await Promise.resolve();
			assert.strictEqual(mutations.length, 1);
			current = false;
			streamState.task = replacement;
			if (settlement === 'resolve') pendingMCP.resolve({ result: { ok: true } });
			else pendingMCP.reject(new Error('late MCP rejection'));
			assert.deepStrictEqual(await run, { interrupted: true });
			assert.strictEqual(mutations.length, 1);
			assert.strictEqual(mutations.some(message => message.type === 'success' || message.type === 'tool_error'), false);
			assert.strictEqual(stringifyCalls, 0);
			assert.strictEqual(streamState.task, replacement);
		}
	});

	test('built-in setup cancellation settles before deferred prepare or call handles and preserves a newer run', async () => {
		for (const setupKind of ['prepare-write', 'call-handle'] as const) {
			const setup = deferred<TestBuiltinSetup>();
			const mutations: TestToolMutation[] = [];
			const streamState: TestStreamRecord = {};
			let executeCalls = 0;
			let interruptCalls = 0;
			const receiver = {
				state: { allThreads: { task: { messages: [], state: {}, filesWithUserChanges: new Set<string>() } } },
				streamState,
				_parentRunTokenOfThread: new Map<string, symbol>(),
				_agentControlGeneration: new Map([['task', 0]]),
				_agentDelegationAuthorityOfThread: new Map(),
				_childToolApprovals: new Map(),
				_onDidChangeChildToolApprovals: { fire() { } },
				_agentSubagentService: { cancelParent() { }, forgetParent() { } },
				_toolsService: {
					invalidateReadReceipts(_threadId: string) { },
					prepareWriteFile: () => setup.promise,
					callTool: { run_command: () => setup.promise },
					stringOfResult: { run_command: () => { throw new Error('stale result was stringified'); } },
				},
				_mcpService: { getMCPTools: () => [] },
				toolErrMsgs: { interrupted: 'Tool call was interrupted by the user.' },
				_updateLatestTool(_threadId: string, message: TestToolMutation) { mutations.push(message); },
				_setStreamState(threadId: string, value: TestStream | undefined) { streamState[threadId] = value; },
			};
			Object.setPrototypeOf(receiver, ChatThreadService.prototype);
			const parentRun = beginTestParentRun(receiver, 'task');
			const toolName = setupKind === 'prepare-write' ? 'write_file' : 'run_command';
			const run = chatLifecycle._runToolCall.call(receiver, 'task', toolName, `tool-${setupKind}`, undefined, { preapproved: true, unvalidatedToolParams: {}, validatedParams: {} }, instructionSnapshot(), undefined, false, parentRun.generation, parentRun.isActive);
			await Promise.resolve();
			assert.strictEqual(streamState.task?.isRunning, 'tool');
			const abort = chatLifecycle.abortRunning.call(receiver, 'task');
			const abortSettled = await Promise.race([abort.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 1_000))]);
			assert.strictEqual(abortSettled, true);
			const replacementRun = beginTestParentRun(receiver, 'task');
			const replacement = { isRunning: 'LLM', llmInfo: { displayContentSoFar: `B-${setupKind}`, reasoningSoFar: 'B', toolCallSoFar: null }, interrupt: Promise.resolve(() => { }) };
			streamState.task = replacement;
			const mutationsAfterAbort = mutations.length;
			if (setupKind === 'prepare-write') setup.resolve({ execute: () => { executeCalls++; return Promise.resolve({}); } });
			else setup.resolve({ result: Promise.resolve({}), interruptTool: () => { interruptCalls++; } });
			assert.deepStrictEqual(await run, { interrupted: true });
			assert.strictEqual(executeCalls, 0);
			assert.strictEqual(interruptCalls, setupKind === 'call-handle' ? 1 : 0);
			assert.strictEqual(mutations.length, mutationsAfterAbort);
			assert.strictEqual(streamState.task, replacement);
			assert.strictEqual(replacementRun.isActive(), true);
			replacementRun.deactivate(); replacementRun.releaseLatest();
		}
	});

	test('run completion notifications preserve current effects and suppress stale effects', async () => {
		const invalidations: string[] = [];
		const notifications: TestNotification[] = [];
		const receiver = {
			state: { allThreads: { task: { messages: [{ role: 'user', displayContent: 'fixture request' }] } }, currentThreadId: 'other' },
			streamState: {},
			_agentControlGeneration: new Map([['task', 0]]),
			_parentRunTokenOfThread: new Map<string, symbol>(),
			_agentDelegationAuthorityOfThread: new Map(),
			_childToolApprovals: new Map(),
			_onDidChangeChildToolApprovals: { fire() { } },
			_agentSubagentService: { cancelParent() { }, forgetParent() { } },
			_toolsService: { invalidateReadReceipts: (threadId: string) => invalidations.push(threadId) },
			_notificationService: { notify: (notification: TestNotification) => notifications.push(notification) },
		};
		Object.setPrototypeOf(receiver, ChatThreadService.prototype);
		const wrap = (promise: Promise<void>, isLatest: () => boolean) => chatLifecycle._wrapRunAgentToNotify.call(receiver, promise, 'task', standaloneParentRun(isLatest));
		const sameGenerationA = beginTestParentRun(receiver, 'task'); const sameGenerationPending = deferred<void>(); const staleSameGeneration = chatLifecycle._wrapRunAgentToNotify.call(receiver, sameGenerationPending.promise, 'task', sameGenerationA); const sameGenerationB = beginTestParentRun(receiver, 'task'); sameGenerationPending.resolve(undefined); await staleSameGeneration; assert.strictEqual(invalidations.length, 0); assert.strictEqual(notifications.length, 0); sameGenerationB.deactivate(); sameGenerationB.releaseLatest();
		for (const settlement of ['resolve', 'reject'] as const) {
			const pending = deferred<void>(); const oldRun = beginTestParentRun(receiver, 'task'); const wrapped = chatLifecycle._wrapRunAgentToNotify.call(receiver, pending.promise, 'task', oldRun);
			chatLifecycle._revokeAgentDelegation.call(receiver, 'task'); assert.strictEqual(invalidations.length, 1); const replacement = beginTestParentRun(receiver, 'task');
			if (settlement === 'resolve') pending.resolve(undefined); else pending.reject(new Error('stale revoked failure'));
			await wrapped; assert.strictEqual(invalidations.length, 1); assert.strictEqual(notifications.length, 0); replacement.deactivate(); replacement.releaseLatest(); invalidations.length = 0;
		}
		for (const settlement of ['resolve', 'reject'] as const) {
			const pending = deferred<void>(); let current = true; const wrapped = wrap(pending.promise, () => current); current = false;
			if (settlement === 'resolve') pending.resolve(undefined); else pending.reject(new Error('stale failure'));
			await wrapped;
		}
		assert.strictEqual(invalidations.length, 0); assert.strictEqual(notifications.length, 0);
		await wrap(Promise.resolve(), () => true);
		assert.deepStrictEqual(invalidations, ['task']); assert.strictEqual(notifications.length, 1); assert.strictEqual(notifications[0].severity, Severity.Info); assert.strictEqual(notifications[0].message, 'A new Chat result is ready.');
		await assert.rejects(wrap(Promise.reject(new Error('current failure')), () => true), /current failure/);
		assert.deepStrictEqual(invalidations, ['task', 'task']); assert.strictEqual(notifications.length, 2); assert.strictEqual(notifications[1].severity, Severity.Warning); assert.ok(notifications[1].message.includes('current failure'));
	});

	test('a completed provider attempt ignores every late or duplicate callback without changing current effects', async () => {
		const snapshot = instructionSnapshot(); const callbacks: TestProviderCallbacks[] = []; const messages: TestMessage[] = [{ role: 'user', content: 'fixture request', displayContent: 'fixture request' }]; const streamState: TestStreamRecord = {}; const metrics: string[] = []; const invalidations: string[] = []; const notifications: TestNotification[] = [];
		const receiver = {
			state: { allThreads: { task: { messages, state: {}, filesWithUserChanges: new Set<string>() } }, currentThreadId: 'other' }, streamState,
			_agentControlGeneration: new Map([['task', 0]]), _parentRunTokenOfThread: new Map<string, symbol>(), _agentDelegationAuthorityOfThread: new Map(),
			_settingsService: { state: { globalSettings: { chatMode: 'agent' } } }, _convertToLLMMessagesService: { prepareLLMChatMessages: async () => ({ messages: [], separateSystemMessage: false }) },
			_llmMessageService: { sendLLMMessage: (options: TestProviderCallbacks) => { callbacks.push(options); return 'current-request'; }, abort() { } }, _mcpService: { getMCPTools: () => [] },
			_metricsService: { capture: (name: string) => metrics.push(name) }, _toolsService: { invalidateReadReceipts: (threadId: string) => invalidations.push(threadId) }, _notificationService: { notify: (notification: TestNotification) => notifications.push(notification) },
			_setStreamState(threadId: string, value: TestStream | undefined) { streamState[threadId] = value; }, _addMessageToThread(_threadId: string, message: TestMessage) { messages.push(message); },
		};
		const parentRun = beginTestParentRun(receiver, 'task');
		const running = chatLifecycle._runChatAgent.call(receiver, { threadId: 'task', modelSelection: { providerName: 'openAICompatible', modelName: 'gpt-4.1' }, modelSelectionOptions: snapshot.model.modelSelectionOptions, instructionSnapshot: snapshot, parentRun });
		const wrapped = chatLifecycle._wrapRunAgentToNotify.call(receiver, running, 'task', parentRun);
		await Promise.resolve(); assert.strictEqual(callbacks.length, 1); callbacks[0].onText({ fullText: 'current partial', fullReasoning: 'current reasoning', toolCall: undefined }); await callbacks[0].onFinalMessage({ fullText: 'current final', fullReasoning: 'current reasoning', anthropicReasoning: null }); await wrapped;
		const finalStream = streamState.task; const finalHistory = JSON.stringify(messages); const finalMetrics = [...metrics];
		callbacks[0].onText({ fullText: 'late text', fullReasoning: 'late reasoning', toolCall: undefined }); await callbacks[0].onFinalMessage({ fullText: 'duplicate final', fullReasoning: '', anthropicReasoning: null }); await callbacks[0].onError({ message: 'duplicate error', fullError: null }); callbacks[0].onAbort(); await Promise.resolve();
		assert.strictEqual(streamState.task, finalStream); assert.strictEqual(JSON.stringify(messages), finalHistory); assert.deepStrictEqual(metrics, finalMetrics); assert.deepStrictEqual(metrics, ['Agent Loop Done']); assert.deepStrictEqual(invalidations, ['task']); assert.strictEqual(notifications.length, 1); assert.strictEqual(notifications[0].severity, Severity.Info); assert.strictEqual(receiver._parentRunTokenOfThread.has('task'), false);
	});

	test('request conversion through deterministic local echo never stores or renders the internal empty sentinel', async () => {
		const snapshot = instructionSnapshot();
		const thread: any = {
			id: 'task',
			createdAt: '2026-08-18T00:00:00.000Z',
			lastModified: '2026-08-18T00:00:00.000Z',
			messages: [
				{ role: 'user', content: 'inspect the file', displayContent: 'inspect the file' },
				{ role: 'assistant', displayContent: '', reasoning: 'reasoning before the tool', anthropicReasoning: null },
				{ role: 'tool', type: 'success', name: 'fixture_tool', params: { value: 'alpha' }, content: 'alpha', id: 'tool-1', rawParams: { value: 'alpha' }, result: 'alpha', mcpServerName: 'fixture-server' },
			],
			state: {},
			filesWithUserChanges: new Set<string>(),
		};
		const converter = new ConvertToLLMMessageService(
			{ getModels: () => [] } as never,
			{ getWorkspace: () => ({ folders: [] }) } as never,
			{ activeEditor: undefined } as never,
			{ getAllDirectoriesStr: async () => '' } as never,
			{ listPersistentTerminalIds: () => [] } as never,
			{ state: { overridesOfModel: { openAICompatible: { 'gpt-4.1': { specialToolFormat: 'openai-style' } } }, globalSettings: {}, optionsOfModelSelection: { Chat: { openAICompatible: { 'gpt-4.1': { reasoningEnabled: true } } } } } } as never,
			{ getMCPTools: () => [] } as never,
		);
		(converter as any)._generateChatMessagesSystemMessage = async () => 'local fixture system';

		let requestContent: unknown;
		let echoedFullText: unknown;
		let serializedThreads = '';
		const streamDisplays: string[] = [];
		const streamState: Record<string, any> = {};
		const receiver: any = {
			state: { allThreads: { task: thread }, currentThreadId: 'task' },
			streamState,
			_agentControlGeneration: new Map([['task', 0]]),
			_parentRunTokenOfThread: new Map<string, symbol>(),
			_agentDelegationAuthorityOfThread: new Map(),
			_settingsService: { state: { globalSettings: { chatMode: 'agent' } } },
			_convertToLLMMessagesService: converter,
			_llmMessageService: {
				sendLLMMessage: (options: any) => {
					const toolAssistant = options.messages.find((message: any) => message.role === 'assistant' && message.tool_calls?.length === 1);
					requestContent = toolAssistant?.content;
					echoedFullText = requestContent;
					queueMicrotask(() => {
						options.onText({ fullText: echoedFullText, fullReasoning: 'local provider reasoning', toolCall: undefined });
						void options.onFinalMessage({ fullText: echoedFullText, fullReasoning: 'local provider reasoning', anthropicReasoning: null });
					});
					return 'local-echo-request';
				},
				abort() { },
			},
			_mcpService: { getMCPTools: () => [] },
			_metricsService: { capture() { } },
			_setStreamState(threadId: string, value: any) { streamState[threadId] = value; if (value?.llmInfo) streamDisplays.push(value.llmInfo.displayContentSoFar); },
			_storageService: { store(key: string, value: string) { assert.strictEqual(key, THREAD_STORAGE_KEY); serializedThreads = value; } },
			_storeAllThreads(threads: any) { return (ChatThreadService.prototype as any)._storeAllThreads.call(this, threads); },
			_setState(value: any) { this.state = { ...this.state, ...value }; },
			_addMessageToThread(threadId: string, message: any) {
				return (ChatThreadService.prototype as any)._addMessageToThread.call(this, threadId, message);
			},
		};

		await runChatAgent(receiver, {
			threadId: 'task',
			modelSelection: { providerName: 'openAICompatible', modelName: 'gpt-4.1' },
			modelSelectionOptions: snapshot.model.modelSelectionOptions,
			instructionSnapshot: snapshot,
		});

		const stored = receiver.state.allThreads.task.messages.at(-1);
		assert.strictEqual(stored.role, 'assistant');
		const persisted = JSON.parse(serializedThreads).task.messages.at(-1);
		const presentation = assistantMessagePresentation(stored);
		assert.deepStrictEqual({
			requestContent,
			echoedFullText,
			storedDisplayContent: stored.displayContent,
			persistedDisplayContent: persisted.displayContent,
			visibleDisplay: presentation.renderDisplay,
			reasoning: presentation.renderReasoning,
		}, {
			requestContent: '',
			echoedFullText: '',
			storedDisplayContent: '',
			persistedDisplayContent: '',
			visibleDisplay: '',
			reasoning: 'local provider reasoning',
		});
		assert.strictEqual(presentation.isEmpty, false);
		assert.strictEqual(presentation.hasReasoning, true);
		assert.deepStrictEqual(streamDisplays, ['', '']);
	});

	test('native OpenAI and OpenAI-Compatible preserve dialect-native empty tool-call content', async () => {
		const converter = new ConvertToLLMMessageService(
			{ getModels: () => [] } as never,
			{ getWorkspace: () => ({ folders: [] }) } as never,
			{ activeEditor: undefined } as never,
			{ getAllDirectoriesStr: async () => '' } as never,
			{ listPersistentTerminalIds: () => [] } as never,
			{ state: { overridesOfModel: {}, globalSettings: {}, optionsOfModelSelection: { Chat: { openAI: {}, openAICompatible: {} } } } } as never,
			{ getMCPTools: () => [] } as never,
		);
		(converter as any)._generateChatMessagesSystemMessage = async () => 'matrix system';
		const history: any[] = [
			{ role: 'user', content: 'use a tool', displayContent: 'use a tool' },
			{ role: 'assistant', displayContent: '', reasoning: 'reasoning before tool', anthropicReasoning: null },
			{ role: 'tool', type: 'success', name: 'fixture_tool', params: { value: 'alpha' }, content: 'alpha', id: 'tool-1', rawParams: { value: 'alpha' }, result: 'alpha', mcpServerName: 'fixture-server' },
		];
		for (const providerName of ['openAI', 'openAICompatible'] as const) {
			const result = await converter.prepareLLMChatMessages({ chatMessages: history, chatMode: 'agent', modelSelection: { providerName, modelName: 'gpt-4.1' }, instructionSnapshot: instructionSnapshot() as never });
			const assistant: any = result.messages.find((message: any) => message.role === 'assistant');
			assert.strictEqual(assistant.content, '');
			assert.deepStrictEqual(assistant.tool_calls, [{ type: 'function', id: 'tool-1', function: { name: 'fixture_tool', arguments: '{"value":"alpha"}' } }]);
			assert.strictEqual(JSON.stringify(result.messages).includes(INTERNAL_EMPTY_MESSAGE_SENTINEL), false);
		}
	});

	test('Anthropic, Gemini, and XML retain tool-only native blocks without fake text', async () => {
		const converter = new ConvertToLLMMessageService(
			{ getModels: () => [] } as never,
			{ getWorkspace: () => ({ folders: [] }) } as never,
			{ activeEditor: undefined } as never,
			{ getAllDirectoriesStr: async () => '' } as never,
			{ listPersistentTerminalIds: () => [] } as never,
			{ state: { overridesOfModel: {}, globalSettings: {}, optionsOfModelSelection: { Chat: { anthropic: {}, gemini: {}, openAICompatible: {} } } } } as never,
			{ getMCPTools: () => [] } as never,
		);
		(converter as any)._generateChatMessagesSystemMessage = async () => 'matrix system';
		const history: any[] = [
			{ role: 'user', content: 'use a tool', displayContent: 'use a tool' },
			{ role: 'assistant', displayContent: '', reasoning: 'reasoning before tool', anthropicReasoning: null },
			{ role: 'tool', type: 'success', name: 'fixture_tool', params: { value: 'alpha' }, content: 'alpha', id: 'tool-1', rawParams: { value: 'alpha' }, result: 'alpha', mcpServerName: 'fixture-server' },
		];
		const anthropic = await converter.prepareLLMChatMessages({ chatMessages: history, chatMode: 'agent', modelSelection: { providerName: 'anthropic', modelName: 'claude-sonnet-4-0' }, instructionSnapshot: instructionSnapshot() as never });
		const anthropicAssistant: any = anthropic.messages.find((message: any) => message.role === 'assistant');
		assert.deepStrictEqual(anthropicAssistant.content, [{ type: 'tool_use', id: 'tool-1', name: 'fixture_tool', input: { value: 'alpha' } }]);

		const gemini = await converter.prepareLLMChatMessages({ chatMessages: history, chatMode: 'agent', modelSelection: { providerName: 'gemini', modelName: 'gemini-2.0-flash' }, instructionSnapshot: instructionSnapshot() as never });
		const geminiAssistant: any = gemini.messages.find((message: any) => message.role === 'model');
		assert.deepStrictEqual(geminiAssistant.parts, [{ functionCall: { id: 'tool-1', name: 'fixture_tool', args: { value: 'alpha' } } }]);

		const xml = await converter.prepareLLMChatMessages({ chatMessages: history, chatMode: 'agent', modelSelection: { providerName: 'openAICompatible', modelName: 'fixture-xml-model' }, instructionSnapshot: instructionSnapshot() as never });
		const xmlAssistant: any = xml.messages.find((message: any) => message.role === 'assistant');
		assert.strictEqual(typeof xmlAssistant.content, 'string');
		assert.strictEqual(/<fixture_tool>/.test(xmlAssistant.content), true);
		assert.strictEqual(/<value>alpha<\/value>/.test(xmlAssistant.content), true);
		for (const result of [anthropic, gemini, xml]) assert.strictEqual(JSON.stringify(result.messages).includes(INTERNAL_EMPTY_MESSAGE_SENTINEL), false);
	});

	test('general reasoning-only history stays empty across every provider dialect', async () => {
		const converter = new ConvertToLLMMessageService(
			{ getModels: () => [] } as never,
			{ getWorkspace: () => ({ folders: [] }) } as never,
			{ activeEditor: undefined } as never,
			{ getAllDirectoriesStr: async () => '' } as never,
			{ listPersistentTerminalIds: () => [] } as never,
			{ state: { overridesOfModel: {}, globalSettings: {}, optionsOfModelSelection: { Chat: { openAI: {}, openAICompatible: {}, anthropic: {}, gemini: {} } } } } as never,
			{ getMCPTools: () => [] } as never,
		);
		(converter as any)._generateChatMessagesSystemMessage = async () => 'matrix system';
		const history: any[] = [
			{ role: 'user', content: 'first', displayContent: 'first' },
			{ role: 'assistant', displayContent: '', reasoning: 'kept in the UI', anthropicReasoning: null },
			{ role: 'user', content: 'continue', displayContent: 'continue' },
		];
		const routes = [
			{ providerName: 'openAI', modelName: 'gpt-4.1' },
			{ providerName: 'openAICompatible', modelName: 'gpt-4.1' },
			{ providerName: 'anthropic', modelName: 'claude-sonnet-4-0' },
			{ providerName: 'gemini', modelName: 'gemini-2.0-flash' },
			{ providerName: 'openAICompatible', modelName: 'fixture-xml-model' },
		] as const;
		for (const modelSelection of routes) {
			const result = await converter.prepareLLMChatMessages({ chatMessages: history, chatMode: 'agent', modelSelection, instructionSnapshot: instructionSnapshot() as never });
			assert.strictEqual(JSON.stringify(result.messages).includes(INTERNAL_EMPTY_MESSAGE_SENTINEL), false);
			assert.strictEqual(result.messages.some((message: any) => message.role === 'assistant' || message.role === 'model'), false);
		}
		const presentation = assistantMessagePresentation({ displayContent: '', reasoning: 'kept in the UI' });
		assert.deepStrictEqual({ display: presentation.renderDisplay, reasoning: presentation.renderReasoning, empty: presentation.isEmpty }, { display: '', reasoning: 'kept in the UI', empty: false });
	});

	test('stream, abort, storage migration, and presentation fence only the exact legacy sentinel', async () => {
		for (let length = 0; length <= INTERNAL_EMPTY_MESSAGE_SENTINEL.length; length++) {
			assert.strictEqual(sanitizeAssistantDisplayContent(INTERNAL_EMPTY_MESSAGE_SENTINEL.slice(0, length), true), '');
		}
		for (const legitimate of [`before ${INTERNAL_EMPTY_MESSAGE_SENTINEL}`, `${INTERNAL_EMPTY_MESSAGE_SENTINEL} after`, '(empty messenger)']) {
			assert.strictEqual(sanitizeAssistantDisplayContent(legitimate, true), legitimate);
			assert.strictEqual(assistantMessagePresentation({ displayContent: legitimate, reasoning: '' }).renderDisplay, legitimate);
		}

		let serializedThreads = '';
		const thread: any = { id: 'task', messages: [], state: {}, filesWithUserChanges: new Set<string>() };
		const receiver: any = {
			state: { allThreads: { task: thread }, currentThreadId: 'task' },
			streamState: { task: { isRunning: 'LLM', llmInfo: { displayContentSoFar: INTERNAL_EMPTY_MESSAGE_SENTINEL, reasoningSoFar: 'abort reasoning', toolCallSoFar: null }, interrupt: Promise.resolve(() => { }) } },
			_revokeAgentDelegation() { },
			_storageService: { store(_key: string, value: string) { serializedThreads = value; } },
			_storeAllThreads(threads: any) { return (ChatThreadService.prototype as any)._storeAllThreads.call(this, threads); },
			_setState(value: any) { this.state = { ...this.state, ...value }; },
			_setStreamState(threadId: string, value: any) { this.streamState[threadId] = value; },
			_addMessageToThread(threadId: string, message: any) { return (ChatThreadService.prototype as any)._addMessageToThread.call(this, threadId, message); },
		};
		await ChatThreadService.prototype.abortRunning.call(receiver, 'task');
		const aborted = receiver.state.allThreads.task.messages.at(-1);
		assert.deepStrictEqual({ display: aborted.displayContent, reasoning: aborted.reasoning, visible: assistantMessagePresentation(aborted).renderDisplay }, { display: '', reasoning: 'abort reasoning', visible: '' });
		assert.strictEqual(JSON.parse(serializedThreads).task.messages.at(-1).displayContent, '');

		const legacy = JSON.stringify({ task: { id: 'task', messages: [{ role: 'assistant', displayContent: INTERNAL_EMPTY_MESSAGE_SENTINEL, reasoning: 'legacy reasoning', anthropicReasoning: null }, { role: 'assistant', displayContent: `keep ${INTERNAL_EMPTY_MESSAGE_SENTINEL}`, reasoning: '', anthropicReasoning: null }], state: {} } });
		const migrated = (ChatThreadService.prototype as any)._convertThreadDataFromStorage.call({}, legacy);
		assert.deepStrictEqual(migrated.task.messages.map((message: any) => message.displayContent), ['', `keep ${INTERNAL_EMPTY_MESSAGE_SENTINEL}`]);
	});

	test('terminal cancellation latches before connection, creation, and send without leaks', async () => {
		const makeService = (connected: Promise<void>, create: () => Promise<any>) => {
			const service: any = new TerminalToolService({ whenConnected: connected, instances: [], onDidCreateInstance: () => ({ dispose() { } }) } as any, {} as any);
			service._createTerminal = create;
			return service;
		};
		const connection = deferred<void>(); let created = 0;
		const beforeConnection = makeService(connection.promise, async () => { created++; throw new Error('must not create after pre-connect cancellation'); });
		const early = await beforeConnection.runCommand('echo early', { type: 'temporary', cwd: null, terminalId: 'early' }); early.interrupt(); early.interrupt();
		assert.deepStrictEqual(await early.resPromise, { result: '', resolveReason: { type: 'cancelled' } }); assert.strictEqual(created, 0); connection.resolve();

		const createGate = deferred<any>(); const createEntered = deferred<void>(); let disposeCount = 0; let sendCount = 0;
		const lateCreate = makeService(Promise.resolve(), () => { createEntered.resolve(); return createGate.promise; });
		const createdCall = await lateCreate.runCommand('echo late', { type: 'temporary', cwd: null, terminalId: 'late' }); await createEntered.promise; createdCall.interrupt();
		let lateCreateSettled = false; void createdCall.resPromise.then(() => lateCreateSettled = true); await Promise.resolve(); assert.strictEqual(lateCreateSettled, false);
		createGate.resolve({ dispose: () => { disposeCount++; }, capabilities: { get: () => undefined, onDidAddCapability: () => ({ dispose() { } }) }, sendText: async () => { sendCount++; }, onData: () => ({ dispose() { } }) });
		assert.deepStrictEqual(await createdCall.resPromise, { result: '', resolveReason: { type: 'cancelled' } }); assert.strictEqual(disposeCount, 1); assert.strictEqual(sendCount, 0);

		const sendGate = deferred<void>(); const sendEntered = deferred<void>(); let listenerDisposals = 0; let sendDisposals = 0;
		const capability = { onCommandFinished: () => ({ dispose: () => { listenerDisposals++; } }) };
		const duringSend = makeService(Promise.resolve(), async () => ({ dispose: () => { sendDisposals++; }, capabilities: { get: () => capability, onDidAddCapability: () => ({ dispose() { } }) }, sendText: () => { sendEntered.resolve(); return sendGate.promise; }, onData: () => ({ dispose() { } }) }));
		const sending = await duringSend.runCommand('echo sending', { type: 'temporary', cwd: null, terminalId: 'sending' }); await sendEntered.promise; sending.interrupt(); sending.interrupt();
		assert.deepStrictEqual(await sending.resPromise, { result: '', resolveReason: { type: 'cancelled' } }); assert.strictEqual(listenerDisposals, 1); assert.strictEqual(sendDisposals, 1);

		let capabilityDisposals = 0; let capabilitySendCalls = 0; const capabilityEntered = deferred<void>();
		const waitingCapability = makeService(Promise.resolve(), async () => ({ dispose() { sendDisposals++; }, capabilities: { get: () => undefined, onDidAddCapability: () => { capabilityEntered.resolve(); return { dispose: () => { capabilityDisposals++; } }; } }, sendText: async () => { capabilitySendCalls++; }, onData: () => ({ dispose() { } }) }));
		const capabilityCall = await waitingCapability.runCommand('echo capability', { type: 'temporary', cwd: null, terminalId: 'capability' }); await capabilityEntered.promise; capabilityCall.interrupt();
		assert.deepStrictEqual(await capabilityCall.resPromise, { result: '', resolveReason: { type: 'cancelled' } }); assert.strictEqual(capabilityDisposals, 1); assert.strictEqual(capabilitySendCalls, 0);

		let persistentDisposals = 0; let finished: ((value: any) => void) | undefined;
		const persistent = makeService(Promise.resolve(), async () => { throw new Error('persistent must not create'); });
		persistent.terminalService.setActiveInstance = () => { }; persistent.terminalService.focusActiveInstance = async () => { };
		persistent.persistentTerminalInstanceOfId.p = { dispose: () => { persistentDisposals++; }, capabilities: { get: () => ({ onCommandFinished: (listener: any) => { finished = listener; return { dispose() { } }; } }), onDidAddCapability: () => ({ dispose() { } }) }, sendText: async () => { }, onData: () => ({ dispose() { } }) };
		const persistentCall = await persistent.runCommand('echo done', { type: 'persistent', persistentTerminalId: 'p' }); for (let i = 0; i < 4 && !finished; i++) await Promise.resolve(); finished!({ exitCode: 0, getOutput: () => 'done' });
		assert.strictEqual((await persistentCall.resPromise).resolveReason.type, 'done'); persistentCall.interrupt(); assert.strictEqual(persistentDisposals, 0);
	});

	test('a terminal nonzero exit produces one visible tool error and one model-facing result', async () => {
		const messages: any[] = [];
		const receiver: any = {
			state: { allThreads: { task: { messages, state: {}, filesWithUserChanges: new Set<string>() } } }, streamState: {},
			_toolsService: {
				callTool: { run_command: async () => ({ result: Promise.resolve({ result: 'stderr output', resolveReason: { type: 'done', exitCode: 7 } }), interruptTool: () => { } }) },
				stringOfResult: { run_command: () => { throw new Error('must not stringify a nonzero terminal result as success'); } },
			},
			_updateLatestTool(_threadId: string, message: any) { if (messages.length) messages[messages.length - 1] = message; else messages.push(message); },
			_setStreamState(threadId: string, value: any) { this.streamState[threadId] = value; },
		};
		const result = await chatLifecycle._runToolCall.call(receiver, 'task', 'run_command', 'terminal-7', undefined, { preapproved: true, unvalidatedToolParams: {}, validatedParams: {} }, instructionSnapshot(), undefined, false, 0, () => true);
		assert.strictEqual((result as any).failure, 'terminal_exit_7');
		assert.strictEqual(messages.length, 1);
		assert.deepStrictEqual({ type: messages[0].type, id: messages[0].id, result: messages[0].result }, { type: 'tool_error', id: 'terminal-7', result: 'stderr output\n(exit code 7)' });
	});

	test('same provider tool ids settle their own cancelled receipts across replacement runs', async () => {
		const first = deferred<any>(); const second = deferred<any>(); const messages: any[] = []; let call = 0; let current = true; let interrupts = 0;
		const receiver: any = {
			state: { allThreads: { task: { messages, state: {}, filesWithUserChanges: new Set<string>() } } }, streamState: {},
			_cancellingToolReceiptsOfThread: new Map(), toolErrMsgs: { interrupted: 'Tool call was interrupted by the user.' }, _revokeAgentDelegation() { current = false; },
			_toolsService: { callTool: { run_command: async () => ({ result: (++call === 1 ? first : second).promise, interruptTool: () => { interrupts++; } }) }, stringOfResult: { run_command: () => { throw new Error('cancelled command must not stringify'); } } },
			_updateLatestTool(_threadId: string, message: any) { const last = messages.at(-1); if (last?.role === 'tool' && last.type !== 'invalid_params') messages[messages.length - 1] = message; else messages.push(message); },
			_editMessageInThread(_threadId: string, index: number, message: any) { messages[index] = message; },
			_setStreamState(threadId: string, value: any) { this.streamState[threadId] = value; },
		}; Object.setPrototypeOf(receiver, ChatThreadService.prototype);
		const start = () => chatLifecycle._runToolCall.call(receiver, 'task', 'run_command', 'same', undefined, { preapproved: true, unvalidatedToolParams: {}, validatedParams: {} }, instructionSnapshot(), undefined, false, 0, () => current);
		const runA = start(); await Promise.resolve(); await chatLifecycle.abortRunning.call(receiver, 'task');
		assert.deepStrictEqual({ type: messages[0].type, lifecycle: messages[0].lifecycle, interrupts }, { type: 'running_now', lifecycle: 'cancelling', interrupts: 1 });
		messages.push({ role: 'assistant', displayContent: 'replacement', reasoning: '', anthropicReasoning: null }); current = true;
		const runB = start(); await Promise.resolve(); await chatLifecycle.abortRunning.call(receiver, 'task');
		first.resolve({ result: '', resolveReason: { type: 'cancelled' } }); await runA;
		assert.strictEqual(messages[0].type, 'rejected');
		assert.strictEqual(messages.at(-1).type, 'running_now');
		second.resolve({ result: '', resolveReason: { type: 'cancelled' } }); await runB;
		assert.strictEqual(messages.at(-1).type, 'rejected');
		assert.strictEqual(interrupts, 2);
	});

	test('stops the parent loop after three identical normalized tool failures without a fourth provider send', async () => {
		const snapshot = instructionSnapshot(); const messages: any[] = [{ role: 'user', content: 'start', displayContent: 'start' }]; const streamState: any = {}; let sends = 0; let toolRuns = 0;
		const receiver: any = {
			state: { allThreads: { task: { messages, state: {}, filesWithUserChanges: new Set<string>() } } }, streamState,
			_agentControlGeneration: new Map([['task', 0]]), _parentRunTokenOfThread: new Map(), _agentDelegationAuthorityOfThread: new Map(),
			_settingsService: { state: { globalSettings: { chatMode: 'agent' } } }, _convertToLLMMessagesService: { prepareLLMChatMessages: async () => ({ messages: [], separateSystemMessage: false }) },
			_llmMessageService: { sendLLMMessage: (options: any) => { const n = ++sends; queueMicrotask(() => void options.onFinalMessage({ fullText: '', fullReasoning: '', toolCall: { name: 'run_command', id: `provider-${n}`, rawParams: n % 2 ? { command: 'false', terminalId: `generated-${n}`, cwd: null } : { cwd: null, terminalId: `generated-${n}`, command: 'false' } }, anthropicReasoning: null })); return `request-${n}`; }, abort() { } },
			_mcpService: { getMCPTools: () => [] }, _metricsService: { capture() { } }, _setStreamState(threadId: string, value: any) { streamState[threadId] = value; }, _addMessageToThread(_threadId: string, message: any) { messages.push(message); },
			_runToolCall: async () => ({ failure: 'terminal_exit_1', validatedParams: { command: 'false', cwd: null, terminalId: `validated-${++toolRuns}` }, interrupted: false }),
		};
		await runChatAgent(receiver, { threadId: 'task', modelSelection: { providerName: 'openAICompatible', modelName: 'gpt-4.1' }, modelSelectionOptions: snapshot.model.modelSelectionOptions, instructionSnapshot: snapshot });
		assert.strictEqual(sends, 3); assert.strictEqual(toolRuns, 3); assert.strictEqual(streamState.task.error.message, 'The same tool failed three times. Change the request or recover the command before continuing.');
	});

	test('different failures, different arguments, and successful calls do not trip the failure circuit', async () => {
		const snapshot = instructionSnapshot();
		for (const [label, outcomes] of [
			['different failures', [{ failure: 'terminal_exit_1', params: { command: 'false', cwd: null, terminalId: 'a' } }, { failure: 'terminal_exit_2', params: { command: 'false', cwd: null, terminalId: 'b' } }, { failure: 'terminal_exit_3', params: { command: 'false', cwd: null, terminalId: 'c' } }]],
			['different arguments', [{ failure: 'terminal_exit_1', params: { command: 'false-a', cwd: null, terminalId: 'a' } }, { failure: 'terminal_exit_1', params: { command: 'false-b', cwd: null, terminalId: 'b' } }, { failure: 'terminal_exit_1', params: { command: 'false-c', cwd: null, terminalId: 'c' } }]],
			['successful calls', [{ params: { command: 'false', cwd: null, terminalId: 'a' } }, { params: { command: 'false', cwd: null, terminalId: 'b' } }, { params: { command: 'false', cwd: null, terminalId: 'c' } }]],
		] as const) {
			const streamState: any = {}; let sends = 0; let runs = 0;
			const receiver: any = { state: { allThreads: { task: { messages: [{ role: 'user', content: label }], state: {}, filesWithUserChanges: new Set<string>() } } }, streamState, _agentControlGeneration: new Map([['task', 0]]), _parentRunTokenOfThread: new Map(), _agentDelegationAuthorityOfThread: new Map(), _settingsService: { state: { globalSettings: { chatMode: 'agent' } } }, _convertToLLMMessagesService: { prepareLLMChatMessages: async () => ({ messages: [], separateSystemMessage: false }) }, _llmMessageService: { sendLLMMessage: (options: any) => { const n = ++sends; queueMicrotask(() => void options.onFinalMessage({ fullText: '', fullReasoning: '', toolCall: n <= 3 ? { name: 'run_command', id: `${label}-${n}`, rawParams: outcomes[n - 1].params } : undefined, anthropicReasoning: null })); return `request-${n}`; }, abort() { } }, _mcpService: { getMCPTools: () => [] }, _metricsService: { capture() { } }, _setStreamState(id: string, value: any) { streamState[id] = value; }, _addMessageToThread() { }, _runToolCall: async () => { const outcome = outcomes[runs++]; return { interrupted: false, ...(outcome.failure ? { failure: outcome.failure } : {}), validatedParams: outcome.params }; } };
			await runChatAgent(receiver, { threadId: 'task', modelSelection: { providerName: 'openAICompatible', modelName: 'gpt-4.1' }, modelSelectionOptions: snapshot.model.modelSelectionOptions, instructionSnapshot: snapshot });
			assert.strictEqual(sends, 4, label); assert.strictEqual(runs, 3, label); assert.strictEqual(streamState.task.error, undefined, label);
		}
	});

	test('publishes first provider retry before retrying without replaying user or tool effects', async () => {
		const snapshot = instructionSnapshot(); const messages: any[] = [{ role: 'user', content: 'original', displayContent: 'original' }]; const states: any[] = []; let sends = 0; let toolEffects = 0; const started = Date.now();
		const receiver: any = { state: { allThreads: { task: { messages, state: {}, filesWithUserChanges: new Set<string>() } } }, streamState: {}, _agentControlGeneration: new Map([['task', 0]]), _parentRunTokenOfThread: new Map(), _agentDelegationAuthorityOfThread: new Map(), _settingsService: { state: { globalSettings: { chatMode: 'agent' } } }, _convertToLLMMessagesService: { prepareLLMChatMessages: async () => ({ messages: [], separateSystemMessage: false }) }, _llmMessageService: { sendLLMMessage: (options: any) => { const n = ++sends; queueMicrotask(() => n === 1 ? void options.onError({ message: 'transient', fullError: null }) : void options.onFinalMessage({ fullText: 'recovered', fullReasoning: '', anthropicReasoning: null })); return `request-${n}`; }, abort() { } }, _mcpService: { getMCPTools: () => [] }, _metricsService: { capture() { } }, _setStreamState(id: string, value: any) { this.streamState[id] = value; states.push(value); }, _addMessageToThread(_id: string, message: any) { messages.push(message); }, _runToolCall: async () => { toolEffects++; return {}; } };
		await runChatAgent(receiver, { threadId: 'task', modelSelection: { providerName: 'openAICompatible', modelName: 'gpt-4.1' }, modelSelectionOptions: snapshot.model.modelSelectionOptions, instructionSnapshot: snapshot });
		const retry = states.find(state => state?.isRunning === 'idle' && state.retry)?.retry;
		assert.deepStrictEqual({ attempt: retry?.attempt, maxAttempts: retry?.maxAttempts }, { attempt: 1, maxAttempts: 3 }); assert.ok(retry.retryAt >= started + 2_400);
		assert.strictEqual(sends, 2); assert.strictEqual(toolEffects, 0); assert.strictEqual(messages.filter(message => message.role === 'user').length, 1); assert.strictEqual(messages.at(-1).displayContent, 'recovered');
	});

	test('keeps queued input FIFO, atomically claims admission, and keeps it out of history until delivery', async () => {
		const { receiver, deliveries, messages, storageScopes } = createPendingInboxReceiver();
		const active = { runId: 'parent-a', generation: 0, settled: new Promise<void>(() => { }) };
		receiver._runQuiescenceOfThread.set('task', active);
		const first = receiver.submitPendingInput({ threadId: 'task', text: 'first', mode: 'queue' });
		const second = receiver.submitPendingInput({ threadId: 'task', text: 'second', mode: 'queue' });
		const third = receiver.submitPendingInput({ threadId: 'task', text: 'third', mode: 'queue' });
		assert.ok(first && second && third);
		assert.strictEqual(receiver.reorderPendingInput('task', third.id, first.id), true);
		assert.strictEqual(receiver.editPendingInput('task', third.id, 'third edited'), true);
		assert.deepStrictEqual(receiver.getPendingChatInputs('task').map((input: any) => input.text), ['third edited', 'first', 'second']);
		assert.ok(storageScopes.length > 0 && storageScopes.every(scope => scope === StorageScope.WORKSPACE));
		assert.deepStrictEqual(messages, []);
		assert.deepStrictEqual(deliveries, []);

		const admission = deferred<boolean>();
		receiver._addUserMessageAndStreamResponse = async (args: any) => { (deliveries as any).push(args.userMessage); return admission.promise; };
		receiver._runQuiescenceOfThread.delete('task');
		const draining = receiver._drainPendingChatInputs('task');
		await flushMicrotasks();
		assert.deepStrictEqual(deliveries, ['third edited']);
		assert.strictEqual(receiver.getPendingChatInputs('task')[0].phase, 'claiming');
		assert.deepStrictEqual(messages, []);
		admission.resolve(true);
		await draining;
		assert.deepStrictEqual(receiver.getPendingChatInputs('task').map((input: any) => input.text), ['first', 'second']);
		await receiver._drainPendingChatInputs('task');
		await receiver._drainPendingChatInputs('task');
		assert.deepStrictEqual(deliveries, ['third edited', 'first', 'second']);
		assert.deepStrictEqual(receiver.getPendingChatInputs('task'), []);
	});

	test('restores workspace-scoped pending inputs dormant, safely revives selections, and fails closed on trust changes', async () => {
		const persisted = new Map<string, string>();
		const source = createPendingInboxReceiver({ storage: persisted });
		source.receiver._runQuiescenceOfThread.set('task', { runId: 'parent-a', generation: 0, settled: new Promise<void>(() => { }) });
		const pending = source.receiver.submitPendingInput({
			threadId: 'task',
			text: 'resume this',
			mode: 'queue',
			selections: [{ type: 'File', uri: URI.parse('file:///workspace/safe.txt'), language: 'typescript', state: { wasAddedAsCurrentFile: false } }],
		});
		assert.ok(pending);
		const envelope = JSON.parse(persisted.get(PENDING_CHAT_INPUT_STORAGE_KEY)!);
		assert.strictEqual(envelope.version, 1);
		assert.strictEqual(envelope.records.length, 1);

		const restarted = createPendingInboxReceiver({ storage: persisted });
		restarted.receiver._restorePendingChatInputs();
		const restored = restarted.receiver.getPendingChatInputs('task');
		assert.strictEqual(restored.length, 1);
		assert.strictEqual(restored[0].phase, 'dormant');
		assert.ok(URI.isUri(restored[0].selections[0].uri));
		assert.deepStrictEqual(restarted.deliveries, []);

		const untrusted = createPendingInboxReceiver({ storage: persisted, trusted: false });
		untrusted.receiver._restorePendingChatInputs();
		assert.strictEqual(untrusted.receiver.getPendingChatInputs('task')[0].phase, 'dormant');
		assert.strictEqual(untrusted.receiver.resumePendingInput('task', pending.id), false);
		assert.deepStrictEqual(untrusted.deliveries, []);

		assert.strictEqual(restarted.receiver.resumePendingInput('task', pending.id), true);
		await flushMicrotasks();
		assert.deepStrictEqual(restarted.deliveries, ['resume this']);
		assert.deepStrictEqual(restarted.receiver.getPendingChatInputs('task'), []);
	});

	test('keeps a failed queued admission as an explicit dormant draft without history or provider mutation', async () => {
		const { receiver, messages, deliveries } = createPendingInboxReceiver();
		let admissions = 0;
		receiver._addUserMessageAndStreamResponse = async ({ userMessage }: { userMessage: string }) => { admissions++; deliveries.push(userMessage); return false; };
		const pending = receiver.submitPendingInput({ threadId: 'task', text: 'needs correction', mode: 'queue' });
		assert.ok(pending);
		await flushMicrotasks();
		assert.strictEqual(admissions, 1);
		assert.deepStrictEqual(messages, []);
		assert.deepStrictEqual(receiver.getPendingChatInputs('task').map((input: any) => ({ text: input.text, phase: input.phase })), [{ text: 'needs correction', phase: 'dormant' }]);
	});

	test('holds queued input through an awaiting approval and drains only after that approval settles', async () => {
		const { receiver, messages, deliveries } = createPendingInboxReceiver();
		messages.push({ role: 'tool', type: 'tool_request', id: 'approval-a', name: 'run_command', params: { command: 'echo hold' }, rawParams: { command: 'echo hold' }, content: '(Awaiting user permission...)', result: null });
		receiver.streamState.task = { isRunning: 'awaiting_user' };
		const parentRun = beginTestParentRun(receiver, 'task');
		(ChatThreadService.prototype as any)._trackParentRun.call(receiver, 'task', parentRun, Promise.resolve());
		await new Promise<void>(resolve => setTimeout(resolve, 0));
		assert.ok(receiver._runQuiescenceOfThread.get('task')?.releaseAwaitingApproval);

		const queued = receiver.submitPendingInput({ threadId: 'task', text: 'after approval', mode: 'queue' });
		assert.ok(queued);
		await flushMicrotasks();
		assert.deepStrictEqual(deliveries, []);
		assert.strictEqual(receiver.streamState.task.isRunning, 'awaiting_user');
		assert.strictEqual(messages.at(-1).type, 'tool_request');

		receiver.rejectLatestToolRequest('task', false);
		await flushMicrotasks(); await flushMicrotasks();
		assert.deepStrictEqual(deliveries, ['after approval']);
		assert.strictEqual(messages.at(-1).type, 'rejected');
		assert.deepStrictEqual(receiver.getPendingChatInputs('task'), []);
	});

	test('holds Queue behind a restored awaiting approval with no live parent lease', async () => {
		const { receiver, messages, deliveries } = createPendingInboxReceiver();
		messages.push({ role: 'tool', type: 'tool_request', id: 'restored-approval', name: 'run_command', params: { command: 'echo hold' }, rawParams: { command: 'echo hold' }, content: '(Awaiting user permission...)', result: null });
		receiver.streamState.task = { isRunning: 'awaiting_user' };
		assert.strictEqual(receiver._runQuiescenceOfThread.has('task'), false);
		const queued = receiver.submitPendingInput({ threadId: 'task', text: 'after restored approval', mode: 'queue' });
		assert.ok(queued);
		await flushMicrotasks();
		assert.deepStrictEqual(deliveries, []);
		assert.strictEqual(messages.at(-1).type, 'tool_request');

		receiver.rejectLatestToolRequest('task', false);
		await flushMicrotasks(); await flushMicrotasks();
		assert.deepStrictEqual(deliveries, ['after restored approval']);
		assert.strictEqual(messages.at(-1).type, 'rejected');
	});

	test('does not drain Queue around a pending direct submission before it settles', async () => {
		const { receiver, deliveries } = createPendingInboxReceiver();
		receiver._runQuiescenceOfThread.set('task', { runId: 'parent-a', generation: 0, settled: new Promise<void>(() => { }) });
		const queued = receiver.submitPendingInput({ threadId: 'task', text: 'must wait for direct submit', mode: 'queue' });
		assert.ok(queued);
		const direct: any = { id: 'direct-b', threadId: 'task', generation: 1, displayContent: 'direct', selections: [], phase: 'preparing', draft: 'direct', composerCleared: false };
		receiver._pendingChatSubmissionOfThread.set('task', direct);
		receiver._runQuiescenceOfThread.delete('task');
		await receiver._drainPendingChatInputs('task');
		assert.deepStrictEqual(deliveries, []);

		receiver._settlePendingChatSubmission(direct, false);
		await flushMicrotasks();
		assert.deepStrictEqual(deliveries, ['must wait for direct submit']);
		assert.deepStrictEqual(receiver.getPendingChatInputs('task'), []);
	});

	test('holds a reentrant Queue event until successful pending admission installs its parent lease', async () => {
		const thread: any = { id: 'task', messages: [], state: { stagingSelections: [], linksOfMessageIdx: {} }, filesWithUserChanges: new Set<string>() };
		const turnConfig = projectAgentConfig({ developerInstructions: 'queue receipt fixture' }, undefined, [{ uri: 'file:///home/.codex/config.toml', scope: 'user', status: 'loaded', projectedKeys: ['developer_instructions'] }], 'file:///workspace', 'file:///workspace');
		const instructionTurn = resolveAgentInstructions(turnConfig, [{ uri: 'file:///workspace/AGENTS.md', outcome: Object.freeze({ status: 'bytes' as const, bytes: bytes('agents') }) }], stableAgentInstructionRevision(turnConfig, [{ uri: 'file:///workspace/AGENTS.md', outcome: Object.freeze({ status: 'bytes' as const, bytes: bytes('agents') }) }]));
		const runGate = deferred<void>();
		let providerStarts = 0;
		const receiver: any = {
			state: { allThreads: { task: thread }, currentThreadId: 'task' },
			streamState: {},
			_settingsService: { state: { globalSettings: { chatMode: 'normal' }, overridesOfModel: { openAICompatible: { 'gpt-4.1': {} } } } },
			_currentModelSelectionProps: () => ({ modelSelection: { providerName: 'openAICompatible', modelName: 'gpt-4.1' }, modelSelectionOptions: {} }),
			_beginInstructionTurn: async () => instructionTurn, _purgeInstructionTurn() { }, _rememberInstructionTurn() { },
			_workspaceContextService: { getWorkspace: () => ({ folders: [{ uri: URI.parse('file:///workspace') }] }) }, _workspaceTrustManagementService: { isWorkspaceTrusted: () => true },
			_agentSkillsService: { getCatalog: async () => createSkillCatalog([]), readSkillBody: async () => ({}) }, _directoryStringService: {}, _fileService: {},
			_mcpService: { getMCPTools: () => [] }, _notificationService: { notify() { } },
			_agentControlGeneration: new Map([['task', 0]]), _agentDelegationAuthorityOfThread: new Map(), _parentRunTokenOfThread: new Map(),
			_pendingChatSubmissionOfThread: new Map(), _pendingChatInputsOfThread: new Map(), _drainingPendingChatInputs: new Set(), _runQuiescenceOfThread: new Map(), _startingParentRunOfThread: new Map(), _deletingPendingInputThreads: new Set(), _stopAndSendFlights: new Map(), _transientComposerDraftOfThread: new Map(),
			_onDidChangePendingChatInputs: { fire() { } }, _storePendingChatInputs() { }, _onDidChangePendingChatSubmission: { fire() { } },
			_setStreamState(threadId: string, value: any) { this.streamState[threadId] = value; }, _addMessageToThread(_threadId: string, message: any) { thread.messages.push(message); },
			_runChatAgent() { providerStarts++; return runGate.promise; }, _wrapRunAgentToNotify: (run: Promise<void>) => run,
		};
		Object.setPrototypeOf(receiver, ChatThreadService.prototype);
		const pending: any = { id: 'pending-b', threadId: 'task', generation: 0, displayContent: 'B', selections: [], phase: 'preparing', draft: 'B', composerCleared: false };
		receiver._pendingChatSubmissionOfThread.set('task', pending);
		let queued: any;
		receiver._onDidChangePendingChatSubmission = { fire() {
			if (!receiver._pendingChatSubmissionOfThread.has('task') && !queued) queued = receiver.submitPendingInput({ threadId: 'task', text: 'Q from receipt event', mode: 'queue' });
		} };
		const admitted = await (ChatThreadService.prototype as any)._addUserMessageAndStreamResponse.call(receiver, { userMessage: 'B', threadId: 'task', pending });
		assert.strictEqual(admitted, true);
		assert.strictEqual(providerStarts, 1);
		assert.deepStrictEqual(thread.messages.filter((message: any) => message.role === 'user').map((message: any) => message.displayContent), ['B']);
		assert.strictEqual(queued?.phase, 'queued');
		assert.strictEqual(receiver._startingParentRunOfThread.has('task'), false);
		assert.ok(receiver._runQuiescenceOfThread.has('task'));
		assert.strictEqual(receiver.getPendingChatInputs('task')[0].text, 'Q from receipt event');
		receiver.deletePendingInput('task', queued.id);
		runGate.resolve();
		await flushMicrotasks();
	});

	test('registers a parent lease before synchronous start events can submit Steer', async () => {
		const { receiver, deliveries, messages } = createPendingInboxReceiver();
		const parentRun = beginTestParentRun(receiver, 'task');
		const started = deferred<void>();
		let submitted: any;
		const setStreamState = receiver._setStreamState.bind(receiver);
		receiver._setStreamState = (threadId: string, value: any) => {
			setStreamState(threadId, value);
			if (value?.isRunning === 'idle' && !submitted) {
				submitted = receiver.submitPendingInput({ threadId, text: 'steer at initial idle', mode: 'steer' });
			}
		};
		// Keep the test focused on the starter/lease ordering rather than the
		// notification bridge's unrelated UI side effects.
		receiver._wrapRunAgentToNotify = (run: Promise<void>) => run;
		(ChatThreadService.prototype as any)._startTrackedParentRun.call(receiver, 'task', parentRun, () => {
			receiver._setStreamState('task', { isRunning: 'idle', interrupt: 'not_needed' });
			return started.promise;
		});
		assert.ok(submitted);
		assert.strictEqual(submitted.phase, 'steering');
		assert.strictEqual(receiver._runQuiescenceOfThread.get('task')?.runId, parentRun.runId);
		assert.deepStrictEqual(messages, []);
		assert.deepStrictEqual(deliveries, []);

		started.resolve();
		await flushMicrotasks(); await flushMicrotasks();
		assert.deepStrictEqual(deliveries, ['steer at initial idle']);
	});

	test('re-reads steer records after a synchronous pending-input listener changes their order', () => {
		const { receiver, messages } = createPendingInboxReceiver();
		const parentRun = beginTestParentRun(receiver, 'task');
		receiver._runQuiescenceOfThread.set('task', { runId: parentRun.runId, generation: parentRun.generation, settled: new Promise<void>(() => { }) });
		receiver.submitPendingInput({ threadId: 'task', text: 'attachment fallback', mode: 'steer', selections: [{ type: 'File', uri: URI.parse('file:///workspace/attached.ts'), language: 'typescript', state: { wasAddedAsCurrentFile: false } }] });
		const stale = receiver.submitPendingInput({ threadId: 'task', text: 'stale steer', mode: 'steer' });
		let reentered = false;
		receiver._onDidChangePendingChatInputs = { fire() {
			if (reentered) return;
			reentered = true;
			receiver.deletePendingInput('task', stale.id);
			receiver.submitPendingInput({ threadId: 'task', text: 'replacement steer', mode: 'steer' });
		} };
		(ChatThreadService.prototype as any)._promoteSteerAtSafeBoundary.call(receiver, 'task', parentRun);
		assert.deepStrictEqual(messages.filter(message => message.role === 'user').map(message => message.displayContent), ['replacement steer']);
	});

	test('promotes plain steering only after a tool settles and falls attachment steering back to FIFO', async () => {
		const { receiver, messages } = createPendingInboxReceiver();
		const snapshot = instructionSnapshot();
		const callbacks: any[] = [];
		const toolEntered = deferred<void>();
		const toolSettled = deferred<void>();
		receiver._settingsService = { state: { globalSettings: { chatMode: 'agent' } } };
		receiver._convertToLLMMessagesService = { prepareLLMChatMessages: async () => ({ messages: [], separateSystemMessage: false }) };
		receiver._llmMessageService = {
			sendLLMMessage(options: any) { callbacks.push(options); return `request-${callbacks.length}`; },
			abort() { },
		};
		receiver._mcpService = { getMCPTools: () => [] };
		receiver._metricsService = { capture() { } };
		receiver._runToolCall = async () => { toolEntered.resolve(); await toolSettled.promise; return { interrupted: false }; };
		const parentRun = beginTestParentRun(receiver, 'task');
		receiver._runQuiescenceOfThread.set('task', { runId: parentRun.runId, generation: parentRun.generation, settled: new Promise<void>(() => { }) });
		const run = chatLifecycle._runChatAgent.call(receiver, { threadId: 'task', modelSelection: { providerName: 'openAICompatible', modelName: 'gpt-4.1' }, modelSelectionOptions: snapshot.model.modelSelectionOptions, instructionSnapshot: snapshot, parentRun });
		await flushMicrotasks();
		assert.strictEqual(callbacks.length, 1);
		const plain = receiver.submitPendingInput({ threadId: 'task', text: 'steer after tool', mode: 'steer' });
		const attached = receiver.submitPendingInput({ threadId: 'task', text: 'queue attachment safely', mode: 'steer', selections: [{ type: 'File', uri: URI.parse('file:///workspace/attached.ts'), language: 'typescript', state: { wasAddedAsCurrentFile: false } }] });
		assert.strictEqual(plain.phase, 'steering');
		assert.strictEqual(attached.phase, 'steering');
		await callbacks[0].onFinalMessage({ fullText: '', fullReasoning: '', toolCall: { name: 'read_file', id: 'tool-a', rawParams: {} }, anthropicReasoning: null });
		await toolEntered.promise;
		assert.strictEqual(messages.filter(message => message.role === 'user').length, 0);
		toolSettled.resolve(undefined);
		await flushMicrotasks();
		assert.strictEqual(callbacks.length, 2);
		assert.deepStrictEqual(messages.filter(message => message.role === 'user').map(message => message.displayContent), ['steer after tool']);
		const fallback = receiver.getPendingChatInputs('task').find((input: any) => input.id === attached.id);
		assert.deepStrictEqual({ mode: fallback?.mode, phase: fallback?.phase }, { mode: 'queue', phase: 'queued' });
		await callbacks[1].onFinalMessage({ fullText: 'done', fullReasoning: '', anthropicReasoning: null });
		await run;
	});

	test('Stop-and-Send captures old quiescence and cannot abort or deliver across a replacement run', async () => {
		const { receiver, deliveries } = createPendingInboxReceiver();
		const oldSettled = deferred<void>();
		const oldRun = { runId: 'parent-a', generation: 0, settled: oldSettled.promise };
		receiver._runQuiescenceOfThread.set('task', oldRun);
		let stops = 0;
		receiver.abortRunning = async () => { stops++; };
		const queued = receiver.submitPendingInput({ threadId: 'task', text: 'send only after old terminal settles', mode: 'stop_and_send' });
		assert.ok(queued);
		await flushMicrotasks();
		assert.strictEqual(stops, 1);
		assert.deepStrictEqual(deliveries, []);

		receiver._runQuiescenceOfThread.set('task', { runId: 'parent-b', generation: 1, settled: new Promise<void>(() => { }) });
		oldSettled.resolve(undefined);
		await flushMicrotasks();
		assert.strictEqual(stops, 1);
		assert.deepStrictEqual(deliveries, []);
		assert.strictEqual(receiver.getPendingChatInputs('task')[0].id, queued.id);

		receiver._runQuiescenceOfThread.delete('task');
		await receiver._drainPendingChatInputs('task');
		assert.deepStrictEqual(deliveries, ['send only after old terminal settles']);
	});

	test('reentrant pending-input events cannot requeue a deleted thread or double-stop one parent lease', async () => {
		const deleting = createPendingInboxReceiver();
		deleting.receiver._runQuiescenceOfThread.set('task', { runId: 'parent-a', generation: 0, settled: new Promise<void>(() => { }) });
		const original = deleting.receiver.submitPendingInput({ threadId: 'task', text: 'delete me', mode: 'queue' });
		assert.ok(original);
		let requeued: unknown;
		deleting.receiver._onDidChangePendingChatInputs = { fire() { requeued = deleting.receiver.submitPendingInput({ threadId: 'task', text: 'must not survive delete', mode: 'queue' }); } };
		deleting.receiver.deleteThread('task');
		assert.strictEqual(requeued, undefined);
		assert.strictEqual(deleting.receiver.state.allThreads.task, undefined);
		assert.deepStrictEqual(deleting.receiver.getPendingChatInputs('task'), []);

		const stopping = createPendingInboxReceiver();
		stopping.receiver._runQuiescenceOfThread.set('task', { runId: 'parent-a', generation: 0, settled: new Promise<void>(() => { }) });
		let aborts = 0; let reentered = false;
		stopping.receiver.abortRunning = async () => { aborts++; };
		stopping.receiver._onDidChangePendingChatInputs = { fire() {
			if (!reentered) {
				reentered = true;
				stopping.receiver.submitPendingInput({ threadId: 'task', text: 'reentrant stop', mode: 'stop_and_send' });
			}
		} };
		stopping.receiver.submitPendingInput({ threadId: 'task', text: 'initial stop', mode: 'stop_and_send' });
		await flushMicrotasks();
		assert.strictEqual(aborts, 1);
	});
});
