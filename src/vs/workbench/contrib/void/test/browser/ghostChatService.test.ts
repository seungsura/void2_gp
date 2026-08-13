/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { Selection } from '../../../../../editor/common/core/selection.js';
import { InlineCompletionContext, InlineCompletionTriggerKind } from '../../../../../editor/common/languages.js';
import { createTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { _util } from '../../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../../common/contributions.js';
import { buildGhostChatPrompt, captureGhostChatSnapshot, GHOST_CHAT_ACCEPT_COMMAND_ID, GHOST_CHAT_DEBOUNCE_DELAY_MS, GHOST_CHAT_LIFECYCLE_RECORD_LIMIT, GhostChatService, GhostChatStartupContribution, IGhostChatService, isGhostChatDevelopmentEnvironment, isGhostChatSnapshotCurrent, validateGhostChatInsertion } from '../../browser/ghostChatService.js';
import { LLMMessageService } from '../../common/sendLLMMessageService.js';
import { defaultGlobalSettings } from '../../common/voidSettingsTypes.js';

const context = (triggerKind: InlineCompletionTriggerKind): InlineCompletionContext => ({
	triggerKind,
	selectedSuggestionInfo: undefined,
	includeInlineEdits: false,
	includeInlineCompletions: true,
});

const fixture = (timeoutMs = 1_000, initialReadOnly = false, initialGhostChatEnabled = false) => {
	const disposables = new DisposableStore();
	const model = disposables.add(createTextModel('const value = foo;', 'typescript'));
	let position = new Position(1, model.getLineMaxColumn(1) - 1);
	let selection = Selection.fromPositions(position);
	let selections = [selection];
	const selectionEmitter = disposables.add(new Emitter<any>());
	const modelEmitter = disposables.add(new Emitter<any>());
	const configurationEmitter = disposables.add(new Emitter<any>());
	const settingsEmitter = disposables.add(new Emitter<void>());
	let readOnly = initialReadOnly;
	const editor = {
		getModel: () => model,
		getPosition: () => position,
		getSelection: () => selection,
		getSelections: () => selections,
		onDidChangeCursorSelection: selectionEmitter.event,
		onDidChangeModel: modelEmitter.event,
		onDidChangeConfiguration: configurationEmitter.event,
		getOption: () => readOnly,
		setPosition(next: Position) {
			position = next;
			selection = Selection.fromPositions(next);
			selections = [selection];
			selectionEmitter.fire({});
		},
		setSelection(next: Selection) {
			selection = next;
			selections = [next];
			position = next.getPosition();
			selectionEmitter.fire({});
		},
		setSelections(next: Selection[]) {
			selections = next;
			selection = next[0];
			position = selection.getPosition();
			selectionEmitter.fire({});
		},
		setReadOnly(value: boolean) {
			readOnly = value;
			configurationEmitter.fire({ hasChanged: () => true });
		},
	};

	let provider: any;
	const languageFeatures = {
		inlineCompletionsProvider: {
			register(_selector: unknown, value: unknown) {
				provider = value;
				return { dispose() { } };
			},
		},
	};

	const requests: { id: string; params: any }[] = [];
	const aborts: string[] = [];
	let beforeRequestId: (() => void) | undefined;
	const llm = {
		sendLLMMessage(params: any) {
			const id = `request-${requests.length + 1}`;
			requests.push({ id, params });
			beforeRequestId?.();
			return id;
		},
		abort(id: string) {
			aborts.push(id);
			requests.find(request => request.id === id)?.params.onAbort();
		},
	};

	const results: any[] = [];
	const commandIds: string[] = [];
	let providerToken = CancellationToken.None;
	const commands = {
		async executeCommand(id: string) {
			commandIds.push(id);
			if (id === 'editor.action.inlineSuggest.hide') return;
			assert.strictEqual(id, 'editor.action.inlineSuggest.trigger');
			const result = await provider.provideInlineCompletions(model, position, context(InlineCompletionTriggerKind.Explicit), providerToken);
			results.push(result);
		},
	};
	const codeEditors = { getActiveCodeEditor: () => editor };
	const settings = {
		state: { globalSettings: { enableGhostChat: initialGhostChatEnabled } },
		onDidChangeState: settingsEmitter.event,
	};
	const service = disposables.add(new GhostChatService(languageFeatures as any, llm as any, codeEditors as any, commands as any, settings as any));
	(service as any).timeoutMs = timeoutMs;

	return {
		disposables,
		model,
		editor,
		service,
		requests,
		aborts,
		results,
		commandIds,
		provider: () => provider,
		setGhostChatEnabled(value: boolean) {
			settings.state.globalSettings.enableGhostChat = value;
			settingsEmitter.fire();
		},
		fireUnrelatedSettingsChange() { settingsEmitter.fire(); },
		setBeforeRequestId(value: (() => void) | undefined) { beforeRequestId = value; },
		setProviderToken(value: CancellationToken) { providerToken = value; },
	};
};

const flushAsync = async () => {
	await Promise.resolve();
	await Promise.resolve();
};

suite('Void Ghost Chat manual gate', () => {
	test('startup contribution consumes the singleton at BlockRestore', () => {
		const registry = WorkbenchContributionsRegistry.INSTANCE as unknown as {
			contributionsByPhase: Map<WorkbenchPhase, Array<{ id: string | undefined; ctor: unknown }>>;
		};
		const registration = registry.contributionsByPhase
			.get(WorkbenchPhase.BlockRestore)
			?.find(candidate => candidate.id === GhostChatStartupContribution.ID);
		assert.ok(registration);
		assert.strictEqual(registration.ctor, GhostChatStartupContribution);

		const dependencies = _util.getServiceDependencies(GhostChatStartupContribution);
		assert.strictEqual(dependencies.length, 1);
		assert.strictEqual(dependencies[0].id, IGhostChatService);
		assert.strictEqual(dependencies[0].index, 0);
	});

	test('Ghost Chat is separately default-off and the provider owns the exact native debounce', () => {
		const f = fixture();
		try {
			assert.strictEqual(defaultGlobalSettings.enableGhostChat, false);
			assert.strictEqual(f.provider().debounceDelayMs, undefined, 'disabled Ghost must not delay other inline providers');
			f.setGhostChatEnabled(true);
			assert.strictEqual(f.provider().debounceDelayMs, GHOST_CHAT_DEBOUNCE_DELAY_MS);
			f.setGhostChatEnabled(false);
			assert.strictEqual(f.provider().debounceDelayMs, undefined);
			assert.strictEqual(GHOST_CHAT_DEBOUNCE_DELAY_MS, 750);
			assert.strictEqual(GHOST_CHAT_LIFECYCLE_RECORD_LIMIT, 64);
		}
		finally { f.disposables.dispose(); }
	});

	test('renderer suppresses only Ghost raw error JSON while both error callbacks still run', () => {
		const disposables = new DisposableStore();
		const emitters = new Map<string, Emitter<any>>();
		const calls: Array<{ command: string; params: any }> = [];
		const channel = {
			listen(event: string) {
				let emitter = emitters.get(event);
				if (!emitter) {
					emitter = disposables.add(new Emitter<any>());
					emitters.set(event, emitter);
				}
				return emitter.event;
			},
			call(command: string, params: any) {
				calls.push({ command, params });
				return Promise.resolve();
			},
		};
		const service = disposables.add(new LLMMessageService(
			{ getChannel: () => channel } as never,
			{ state: { settingsOfProvider: {} } } as never,
			{ getMCPTools: () => [] } as never,
		));
		const base: any = {
			messagesType: 'chatMessages', messages: [{ role: 'user', content: 'fixture' }], separateSystemMessage: undefined,
			chatMode: null, logging: { loggingName: 'fixture' }, modelSelection: { providerName: 'openAICompatible', modelName: 'gpt-4.1' },
			modelSelectionOptions: undefined, overridesOfModel: undefined, onText() { }, onFinalMessage() { }, onAbort() { },
		};
		let ordinaryErrors = 0;
		let ghostErrors = 0;
		const consoleErrors: unknown[][] = [];
		const originalConsoleError = console.error;
		console.error = (...args: unknown[]) => { consoleErrors.push(args); };
		try {
			service.sendLLMMessage({ ...base, onError: () => ordinaryErrors++ });
			service.sendLLMMessage({ ...base, requestProfile: 'ghost-chat', onError: () => ghostErrors++ });
			const sends = calls.filter(call => call.command === 'sendLLMMessage');
			assert.strictEqual(sends.length, 2);
			const errorEmitter = emitters.get('onError_sendLLMMessage');
			assert.ok(errorEmitter);
			errorEmitter!.fire({ requestId: sends[0].params.requestId, message: 'ordinary raw error', fullError: null });
			errorEmitter!.fire({ requestId: sends[1].params.requestId, message: 'private ghost raw error', fullError: new Error('private ghost raw error') });
			assert.strictEqual(ordinaryErrors, 1);
			assert.strictEqual(ghostErrors, 1);
			assert.strictEqual(consoleErrors.length, 1);
			assert.ok(JSON.stringify(consoleErrors[0]).includes('ordinary raw error'));
			assert.strictEqual(JSON.stringify(consoleErrors).includes('private ghost raw error'), false);
		}
		finally {
			console.error = originalConsoleError;
			disposables.dispose();
		}
	});

	test('only an armed explicit request dispatches; automatic triggers dispatch zero', async () => {
		const f = fixture();
		try {
			const unarmedExplicit = await f.provider().provideInlineCompletions(f.model, f.editor.getPosition(), context(InlineCompletionTriggerKind.Explicit), CancellationToken.None);
			const automatic = await f.provider().provideInlineCompletions(f.model, f.editor.getPosition(), context(InlineCompletionTriggerKind.Automatic), CancellationToken.None);
			assert.deepStrictEqual(unarmedExplicit.items, []);
			assert.deepStrictEqual(automatic.items, []);
			assert.strictEqual(f.requests.length, 0);

			const call = f.service.triggerManual();
			await flushAsync();
			assert.strictEqual(f.requests.length, 1);
			assert.deepStrictEqual(f.commandIds, ['editor.action.inlineSuggest.hide', 'editor.action.inlineSuggest.trigger']);
			const sent = f.requests[0].params;
			assert.strictEqual(sent.requestProfile, 'ghost-chat');
			assert.deepStrictEqual(sent.modelSelection, { providerName: 'openAICompatible', modelName: 'gpt-4.1' });
			assert.strictEqual(sent.chatMode, null);
			assert.strictEqual(sent.modelSelectionOptions, undefined);
			assert.strictEqual(sent.overridesOfModel, undefined);
			assert.strictEqual(sent.messages.length, 1);
			sent.onFinalMessage({ fullText: 'bar', fullReasoning: '', anthropicReasoning: null });
			await call;

			assert.strictEqual(f.results.length, 1);
			assert.strictEqual(f.results[0].items[0].insertText, 'bar');
			const range = f.results[0].items[0].range;
			assert.strictEqual(range.startLineNumber, range.endLineNumber);
			assert.strictEqual(range.startColumn, range.endColumn);
		}
		finally { f.disposables.dispose(); }
	});

	test('enabled automatic admission captures current provider state and dispatches once', async () => {
		const f = fixture(1_000, false, true);
		try {
			const call = f.provider().provideInlineCompletions(f.model, f.editor.getPosition(), context(InlineCompletionTriggerKind.Automatic), CancellationToken.None);
			assert.strictEqual(f.requests.length, 1);
			f.requests[0].params.onFinalMessage({ fullText: 'bar', fullReasoning: '', anthropicReasoning: null });
			const result = await call;
			assert.strictEqual(result.items[0].insertText, 'bar');
			assert.strictEqual(result.items[0].command.id, GHOST_CHAT_ACCEPT_COMMAND_ID);
			assert.strictEqual(f.service.getDiagnosticsView().requestCount, 1);
		}
		finally { f.disposables.dispose(); }
	});

	test('each admitted automatic request aborts its predecessor once and stays max-one', async () => {
		const f = fixture(1_000, false, true);
		try {
			const first = f.provider().provideInlineCompletions(f.model, f.editor.getPosition(), context(InlineCompletionTriggerKind.Automatic), CancellationToken.None);
			const second = f.provider().provideInlineCompletions(f.model, f.editor.getPosition(), context(InlineCompletionTriggerKind.Automatic), CancellationToken.None);
			assert.strictEqual(f.requests.length, 2);
			assert.deepStrictEqual(f.aborts, ['request-1']);
			f.requests[1].params.onFinalMessage({ fullText: 'new', fullReasoning: '', anthropicReasoning: null });
			assert.deepStrictEqual((await first).items, []);
			assert.strictEqual((await second).items[0].insertText, 'new');
			const diagnostics = f.service.getDiagnosticsView();
			assert.strictEqual(diagnostics.activeRequests, 0);
			assert.strictEqual(diagnostics.maxConcurrentRequests, 1);
			assert.strictEqual(diagnostics.abortCount, 1);
		}
		finally { f.disposables.dispose(); }
	});

	test('only the enabled-to-off setting transition hides and aborts automatic work', async () => {
		const f = fixture(1_000, false, true);
		try {
			const call = f.provider().provideInlineCompletions(f.model, f.editor.getPosition(), context(InlineCompletionTriggerKind.Automatic), CancellationToken.None);
			f.fireUnrelatedSettingsChange();
			assert.deepStrictEqual(f.aborts, []);
			f.setGhostChatEnabled(false);
			assert.deepStrictEqual(f.aborts, ['request-1']);
			assert.ok(f.commandIds.includes('editor.action.inlineSuggest.hide'));
			assert.deepStrictEqual((await call).items, []);
			const afterOff = await f.provider().provideInlineCompletions(f.model, f.editor.getPosition(), context(InlineCompletionTriggerKind.Automatic), CancellationToken.None);
			assert.deepStrictEqual(afterOff.items, []);
			assert.strictEqual(f.requests.length, 1);
		}
		finally { f.disposables.dispose(); }
	});

	test('manual admission requires an empty selection and writable editor', async () => {
		const selected = fixture();
		const readOnly = fixture(1_000, true);
		try {
			selected.editor.setSelection(new Selection(1, 1, 1, 3));
			await selected.service.triggerManual();
			await readOnly.service.triggerManual();
			assert.strictEqual(selected.requests.length, 0);
			assert.strictEqual(readOnly.requests.length, 0);
		}
		finally { selected.disposables.dispose(); readOnly.disposables.dispose(); }
	});

	test('multiple empty cursors produce no manual request and no ghost result', async () => {
		const f = fixture();
		try {
			f.editor.setSelections([
				Selection.fromPositions(new Position(1, 2)),
				Selection.fromPositions(new Position(1, 5)),
			]);
			await f.service.triggerManual();
			assert.strictEqual(f.requests.length, 0);
			assert.strictEqual(f.results.length, 0);
			assert.deepStrictEqual(f.commandIds, ['editor.action.inlineSuggest.hide']);
		}
		finally { f.disposables.dispose(); }
	});

	test('internal action execution environment is fail-closed in a built product', () => {
		assert.strictEqual(isGhostChatDevelopmentEnvironment({ isBuilt: true, isExtensionDevelopment: false } as any), false);
		assert.strictEqual(isGhostChatDevelopmentEnvironment({ isBuilt: false, isExtensionDevelopment: false } as any), true);
		assert.strictEqual(isGhostChatDevelopmentEnvironment({ isBuilt: true, isExtensionDevelopment: true } as any), true);
	});

	test('snapshot records generation, URI, version, caret, selection, prefix and suffix and goes stale on document change', () => {
		const f = fixture();
		try {
			const position = f.editor.getPosition();
			const snapshot = captureGhostChatSnapshot(f.model, position, f.editor.getSelection(), 7);
			assert.strictEqual(snapshot.generation, 7);
			assert.strictEqual(snapshot.uri, f.model.uri.toString());
			assert.strictEqual(snapshot.version, f.model.getVersionId());
			assert.deepStrictEqual(snapshot.position, { lineNumber: position.lineNumber, column: position.column });
			assert.strictEqual(snapshot.prefix.endsWith('foo'), true);
			assert.strictEqual(snapshot.suffix, ';');
			assert.strictEqual(isGhostChatSnapshotCurrent(snapshot, 7, f.model, position, f.editor.getSelection()), true);
			f.model.setValue('const changed = true;');
			assert.strictEqual(isGhostChatSnapshotCurrent(snapshot, 7, f.model, position, f.editor.getSelection()), false);
		}
		finally { f.disposables.dispose(); }
	});

	test('document changes cancel, advance the generation and fence late results', async () => {
		const f = fixture();
		try {
			const first = f.service.triggerManual();
			await flushAsync();
			const firstRequest = f.requests[0];
			f.model.setValue('const changed = true;');
			await first;
			assert.deepStrictEqual(f.aborts, [firstRequest.id]);
			assert.deepStrictEqual(f.results[0].items, []);
			firstRequest.params.onFinalMessage({ fullText: 'late', fullReasoning: '', anthropicReasoning: null });
			assert.deepStrictEqual(f.results[0].items, []);

			f.editor.setPosition(new Position(1, f.model.getLineMaxColumn(1)));
			const second = f.service.triggerManual();
			await flushAsync();
			f.requests[1].params.onFinalMessage({ fullText: ' // valid', fullReasoning: '', anthropicReasoning: null });
			await second;
			assert.strictEqual(f.results[1].items[0].insertText, ' // valid');
			assert.ok(f.results[1].generation > f.results[0].generation);
		}
		finally { f.disposables.dispose(); }
	});

	test('same-caret retrigger hides native cache, dispatches request two and fences request one', async () => {
		const f = fixture();
		try {
			const first = f.service.triggerManual();
			await flushAsync();
			const firstRequest = f.requests[0];
			const second = f.service.triggerManual();
			await flushAsync();

			assert.strictEqual(f.requests.length, 2);
			assert.deepStrictEqual(f.commandIds, [
				'editor.action.inlineSuggest.hide',
				'editor.action.inlineSuggest.trigger',
				'editor.action.inlineSuggest.hide',
				'editor.action.inlineSuggest.trigger',
			]);
			assert.deepStrictEqual(f.aborts, [firstRequest.id]);
			firstRequest.params.onFinalMessage({ fullText: 'old', fullReasoning: '', anthropicReasoning: null });
			f.requests[1].params.onFinalMessage({ fullText: 'new', fullReasoning: '', anthropicReasoning: null });
			await Promise.all([first, second]);
			assert.deepStrictEqual(f.results[0].items, []);
			assert.strictEqual(f.results[1].items[0].insertText, 'new');
			assert.ok(f.results[1].generation > f.results[0].generation);
		}
		finally { f.disposables.dispose(); }
	});

	test('native show, rejection, free and post-edit command have distinct idempotent semantics', async () => {
		const accepted = fixture();
		const rejected = fixture();
		try {
			const acceptedCall = accepted.service.triggerManual();
			await flushAsync();
			accepted.requests[0].params.onFinalMessage({ fullText: 'accepted', fullReasoning: '', anthropicReasoning: null });
			await acceptedCall;
			const acceptedCompletions = accepted.results[0];
			const acceptedItem = acceptedCompletions.items[0];
			accepted.provider().handleItemDidShow(acceptedCompletions, acceptedItem, 'accepted');
			accepted.provider().handleItemDidShow(acceptedCompletions, acceptedItem, 'accepted');
			accepted.provider().freeInlineCompletions(acceptedCompletions);

			// Native full acceptance applies the edit before invoking this internal command.
			accepted.model.setValue('const value = fooaccepted;');
			const acceptCommand = CommandsRegistry.getCommand(GHOST_CHAT_ACCEPT_COMMAND_ID);
			assert.ok(acceptCommand);
			const accessor = { get: () => accepted.service } as any;
			acceptCommand!.handler(accessor, ...(acceptedItem.command.arguments ?? []));
			acceptCommand!.handler(accessor, ...(acceptedItem.command.arguments ?? []));
			assert.deepStrictEqual(
				{ shown: accepted.service.getDiagnosticsView().shownCount, accepted: accepted.service.getDiagnosticsView().acceptedCount },
				{ shown: 1, accepted: 1 },
			);
			assert.notStrictEqual(accepted.service.getDiagnosticsView().lastFirstSuggestionLatencyMs, null);
			assert.ok(accepted.service.getDiagnosticsView().totalFirstSuggestionLatencyMs >= 0);
			assert.ok(accepted.service.getDiagnosticsView().maxFirstSuggestionLatencyMs >= 0);

			const rejectedCall = rejected.service.triggerManual();
			await flushAsync();
			rejected.requests[0].params.onFinalMessage({ fullText: 'rejected', fullReasoning: '', anthropicReasoning: null });
			await rejectedCall;
			const rejectedCompletions = rejected.results[0];
			const rejectedItem = rejectedCompletions.items[0];
			rejected.provider().handleItemDidShow(rejectedCompletions, rejectedItem, 'rejected');
			rejected.provider().freeInlineCompletions(rejectedCompletions);
			assert.strictEqual(rejected.service.getDiagnosticsView().acceptedCount, 0, 'free must not imply acceptance');
			rejected.provider().handleRejection(rejectedCompletions, rejectedItem);
			rejected.provider().handleRejection(rejectedCompletions, rejectedItem);
			assert.strictEqual(rejected.service.getDiagnosticsView().rejectedCount, 1);
		}
		finally { accepted.disposables.dispose(); rejected.disposables.dispose(); }
	});

	test('diagnostics are frozen scalar-only copies and count empty, invalid, error and stale suppression', async () => {
		const f = fixture();
		try {
			const emptyCall = f.service.triggerManual();
			await flushAsync();
			f.requests[0].params.onFinalMessage({ fullText: '', fullReasoning: '', anthropicReasoning: null });
			await emptyCall;

			const invalidCall = f.service.triggerManual();
			await flushAsync();
			f.requests[1].params.onFinalMessage({ fullText: 'one\ntwo', fullReasoning: '', anthropicReasoning: null });
			await invalidCall;

			const errorCall = f.service.triggerManual();
			await flushAsync();
			f.requests[2].params.onError({ message: 'private failure', fullError: new Error('private failure') });
			await errorCall;

			const staleCall = f.service.triggerManual();
			await flushAsync();
			f.editor.setPosition(new Position(1, 2));
			await staleCall;
			f.requests[3].params.onFinalMessage({ fullText: 'late private completion', fullReasoning: '', anthropicReasoning: null });

			const view = f.service.getDiagnosticsView();
			assert.strictEqual(Object.isFrozen(view), true);
			assert.strictEqual(view.requestCount, 4);
			assert.strictEqual(view.emptyCount, 1);
			assert.strictEqual(view.invalidCount, 1);
			assert.strictEqual(view.errorCount, 1);
			assert.strictEqual(view.staleSuppressedCount, 1);
			assert.strictEqual(view.staleDisplayedCount, 0);
			assert.strictEqual(view.retryCount, 0);
			assert.strictEqual(view.activeRequests, 0);
			assert.strictEqual(view.maxConcurrentRequests, 1);
			assert.ok(view.requestBytes > 0);
			assert.strictEqual(view.estimatedRequestTokens, Math.ceil(view.requestBytes / 4));
			assert.strictEqual(view.cancelToTransportCloseMs, null);
			assert.ok(Object.values(view).every(value => value === null || typeof value === 'number'), 'diagnostics must contain no prompt, completion, URI, error, or other string');
			assert.notStrictEqual(view, f.service.getDiagnosticsView());
			assert.throws(() => { (view as any).requestCount = 99; });
		}
		finally { f.disposables.dispose(); }
	});

	test('cancellation before request id is latched and aborts the late id once', async () => {
		const f = fixture();
		try {
			f.setBeforeRequestId(() => f.model.setValue('changed before id'));
			await f.service.triggerManual();
			assert.strictEqual(f.requests.length, 1);
			assert.deepStrictEqual(f.aborts, ['request-1']);
			assert.deepStrictEqual(f.results[0].items, []);
		}
		finally { f.disposables.dispose(); }
	});

	test('caret and selection changes after request id abort once', async () => {
		const f = fixture();
		try {
			const caretCall = f.service.triggerManual();
			await flushAsync();
			f.editor.setPosition(new Position(1, 2));
			await caretCall;
			assert.deepStrictEqual(f.aborts, ['request-1']);

			const selectionCall = f.service.triggerManual();
			await flushAsync();
			f.editor.setSelection(new Selection(1, 1, 1, 3));
			await selectionCall;
			assert.deepStrictEqual(f.aborts, ['request-1', 'request-2']);
		}
		finally { f.disposables.dispose(); }
	});

	test('a real inline-provider cancellation token aborts the active request', async () => {
		const f = fixture();
		const cancellation = new CancellationTokenSource();
		try {
			f.setProviderToken(cancellation.token);
			const call = f.service.triggerManual();
			await flushAsync();
			assert.strictEqual(f.requests.length, 1);
			cancellation.cancel();
			await call;
			assert.deepStrictEqual(f.aborts, ['request-1']);
			assert.deepStrictEqual(f.results[0].items, []);
		}
		finally { cancellation.dispose(); f.disposables.dispose(); }
	});

	test('disposing the service clears state and aborts the active request once', async () => {
		const f = fixture();
		try {
			const call = f.service.triggerManual();
			await flushAsync();
			assert.strictEqual(f.requests.length, 1);
			f.service.dispose();
			f.service.dispose();
			await call;
			assert.deepStrictEqual(f.aborts, ['request-1']);
			assert.deepStrictEqual(f.results[0].items, []);
		}
		finally { f.disposables.dispose(); }
	});

	test('timeout aborts and settles an empty result', async () => {
		const f = fixture(5);
		try {
			await f.service.triggerManual();
			assert.deepStrictEqual(f.aborts, ['request-1']);
			assert.deepStrictEqual(f.results[0].items, []);
			assert.strictEqual(f.service.getDiagnosticsView().timeoutCount, 1);
			assert.strictEqual(f.service.getDiagnosticsView().abortCount, 1);
		}
		finally { f.disposables.dispose(); }
	});

	test('bounded prompt asks for insertion text only and local validation rejects unsafe output', () => {
		const snapshot = { prefix: 'const answer = ', suffix: ';' };
		const prompt = buildGhostChatPrompt({ prefix: 'x'.repeat(20_000), suffix: 'y'.repeat(20_000) });
		assert.ok(prompt.length < 17_000);
		assert.ok(prompt.includes('Return only the exact plain text to insert at the cursor.'));
		assert.deepStrictEqual(validateGhostChatInsertion('', snapshot), { ok: false, reason: 'empty' });
		assert.deepStrictEqual(validateGhostChatInsertion('```ts', snapshot), { ok: false, reason: 'fenced' });
		assert.deepStrictEqual(validateGhostChatInsertion('one\ntwo', snapshot), { ok: false, reason: 'multiline' });
		assert.deepStrictEqual(validateGhostChatInsertion(';', snapshot), { ok: false, reason: 'duplicate-context' });
		assert.deepStrictEqual(validateGhostChatInsertion('<CURSOR>outside', snapshot), { ok: false, reason: 'context-marker' });
		assert.deepStrictEqual(validateGhostChatInsertion('42', snapshot), { ok: true, text: '42' });
	});
});
