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
import { buildGhostChatPrompt, captureGhostChatSnapshot, GhostChatService, isGhostChatDevelopmentEnvironment, isGhostChatSnapshotCurrent, validateGhostChatInsertion } from '../../browser/ghostChatService.js';

const context = (triggerKind: InlineCompletionTriggerKind): InlineCompletionContext => ({
	triggerKind,
	selectedSuggestionInfo: undefined,
	includeInlineEdits: false,
	includeInlineCompletions: true,
});

const fixture = (timeoutMs = 1_000, initialReadOnly = false) => {
	const disposables = new DisposableStore();
	const model = disposables.add(createTextModel('const value = foo;', 'typescript'));
	let position = new Position(1, model.getLineMaxColumn(1) - 1);
	let selection = Selection.fromPositions(position);
	let selections = [selection];
	const selectionEmitter = disposables.add(new Emitter<any>());
	const modelEmitter = disposables.add(new Emitter<any>());
	const configurationEmitter = disposables.add(new Emitter<any>());
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
	const service = disposables.add(new GhostChatService(languageFeatures as any, llm as any, codeEditors as any, commands as any));
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
		setBeforeRequestId(value: (() => void) | undefined) { beforeRequestId = value; },
		setProviderToken(value: CancellationToken) { providerToken = value; },
	};
};

const flushAsync = async () => {
	await Promise.resolve();
	await Promise.resolve();
};

suite('Void Ghost Chat manual gate', () => {
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
