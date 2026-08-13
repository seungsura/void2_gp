/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { Position } from '../../../../editor/common/core/position.js';
import { Range } from '../../../../editor/common/core/range.js';
import { ISelection } from '../../../../editor/common/core/selection.js';
import { EditorOption } from '../../../../editor/common/config/editorOptions.js';
import { InlineCompletion, InlineCompletionContext, InlineCompletions, InlineCompletionsProvider, InlineCompletionTriggerKind } from '../../../../editor/common/languages.js';
import { EndOfLinePreference, ITextModel } from '../../../../editor/common/model.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IsDevelopmentContext } from '../../../../platform/contextkey/common/contextkeys.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILLMMessageService } from '../common/sendLLMMessageService.js';
import { IVoidSettingsService } from '../common/voidSettingsService.js';

export const GHOST_CHAT_COMMAND_ID = 'void.ghostChat.generateInternal';
export const GHOST_CHAT_ACCEPT_COMMAND_ID = 'void.ghostChat.acceptInternal';
export const GHOST_CHAT_PREFIX_MAX_CHARS = 12_000;
export const GHOST_CHAT_SUFFIX_MAX_CHARS = 4_000;
export const GHOST_CHAT_INSERT_MAX_CHARS = 1_000;
export const GHOST_CHAT_TIMEOUT_MS = 15_000;
export const GHOST_CHAT_DEBOUNCE_DELAY_MS = 750;
export const GHOST_CHAT_LIFECYCLE_RECORD_LIMIT = 64;
export const isGhostChatDevelopmentEnvironment = (environment: Pick<IEnvironmentService, 'isBuilt' | 'isExtensionDevelopment'>): boolean => !environment.isBuilt || !!environment.isExtensionDevelopment;

const INLINE_SUGGEST_TRIGGER_COMMAND_ID = 'editor.action.inlineSuggest.trigger';
const INLINE_SUGGEST_HIDE_COMMAND_ID = 'editor.action.inlineSuggest.hide';
const PROMPT_HEADER = [
	'Complete the code at <CURSOR>.',
	'Return only the exact plain text to insert at the cursor.',
	'Do not return Markdown, code fences, explanations, surrounding code, or edits outside the cursor.',
	'Return exactly one line.',
].join(' ');

type GhostChatSelectionSnapshot = Readonly<{
	selectionStartLineNumber: number;
	selectionStartColumn: number;
	positionLineNumber: number;
	positionColumn: number;
}>;

export type GhostChatSnapshot = Readonly<{
	generation: number;
	uri: string;
	version: number;
	position: Readonly<{ lineNumber: number; column: number }>;
	selection: GhostChatSelectionSnapshot;
	prefix: string;
	suffix: string;
}>;

export type GhostChatValidationResult =
	| Readonly<{ ok: true; text: string }>
	| Readonly<{ ok: false; reason: 'empty' | 'too-long' | 'multiline' | 'fenced' | 'control' | 'context-marker' | 'duplicate-context' }>;

type GhostChatInlineCompletion = InlineCompletion & Readonly<{ ghostChatGeneration: number }>;

type GhostChatInlineCompletions = InlineCompletions<GhostChatInlineCompletion> & Readonly<{ generation: number }>;

type GhostChatCurrentSingleCaret = Readonly<{
	model: ITextModel;
	position: Position;
	selection: ISelection;
}>;

type ArmedRequest = Readonly<{
	editor: ICodeEditor;
	snapshot: GhostChatSnapshot;
}>;

type ActiveRequest = {
	readonly editor: ICodeEditor;
	readonly model: ITextModel;
	readonly snapshot: GhostChatSnapshot;
	readonly disposables: DisposableStore;
	readonly resolve: (result: GhostChatInlineCompletions) => void;
	requestId: string | null;
	timeout: ReturnType<typeof setTimeout> | undefined;
	cancelRequested: boolean;
	abortSent: boolean;
	settled: boolean;
	staleSuppressedRecorded: boolean;
};

type GhostChatLifecycleRecord = {
	readonly generation: number;
	readonly requestStartedAtMs: number;
	completionReady: boolean;
	shown: boolean;
	terminalUserActionRecorded: boolean;
};

export type GhostChatDiagnosticsView = Readonly<{
	requestCount: number;
	shownCount: number;
	acceptedCount: number;
	rejectedCount: number;
	emptyCount: number;
	invalidCount: number;
	errorCount: number;
	staleSuppressedCount: number;
	staleDisplayedCount: 0;
	abortCount: number;
	timeoutCount: number;
	retryCount: 0;
	activeRequests: number;
	maxConcurrentRequests: number;
	requestBytes: number;
	estimatedRequestTokens: number;
	lastFirstSuggestionLatencyMs: number | null;
	totalFirstSuggestionLatencyMs: number;
	maxFirstSuggestionLatencyMs: number;
	cancelToTransportCloseMs: null;
}>;

const emptyCompletions = (generation: number): GhostChatInlineCompletions => ({ items: [], generation });

const selectionSnapshot = (selection: ISelection): GhostChatSelectionSnapshot => ({
	selectionStartLineNumber: selection.selectionStartLineNumber,
	selectionStartColumn: selection.selectionStartColumn,
	positionLineNumber: selection.positionLineNumber,
	positionColumn: selection.positionColumn,
});

const selectionMatches = (snapshot: GhostChatSelectionSnapshot, selection: ISelection): boolean =>
	snapshot.selectionStartLineNumber === selection.selectionStartLineNumber
	&& snapshot.selectionStartColumn === selection.selectionStartColumn
	&& snapshot.positionLineNumber === selection.positionLineNumber
	&& snapshot.positionColumn === selection.positionColumn;

export const getGhostChatCurrentSingleCaret = (editor: ICodeEditor): GhostChatCurrentSingleCaret | undefined => {
	const model = editor.getModel();
	const position = editor.getPosition();
	const primarySelection = editor.getSelection();
	const selections = editor.getSelections();
	if (!model || !position || !primarySelection || !selections || selections.length !== 1) return undefined;
	const onlySelection = selections[0];
	if (!Range.isEmpty(onlySelection) || !selectionMatches(selectionSnapshot(primarySelection), onlySelection)) return undefined;
	if (position.lineNumber !== primarySelection.positionLineNumber || position.column !== primarySelection.positionColumn) return undefined;
	return { model, position, selection: primarySelection };
};

const boundedPrefixAndSuffix = (model: ITextModel, position: Position): Readonly<{ prefix: string; suffix: string }> => {
	const offset = model.getOffsetAt(position);
	const prefixStart = model.getPositionAt(Math.max(0, offset - GHOST_CHAT_PREFIX_MAX_CHARS));
	const suffixEnd = model.getPositionAt(Math.min(model.getValueLength(), offset + GHOST_CHAT_SUFFIX_MAX_CHARS));
	return {
		prefix: model.getValueInRange(Range.fromPositions(prefixStart, position), EndOfLinePreference.LF),
		suffix: model.getValueInRange(Range.fromPositions(position, suffixEnd), EndOfLinePreference.LF),
	};
};

export const captureGhostChatSnapshot = (model: ITextModel, position: Position, selection: ISelection, generation: number): GhostChatSnapshot => {
	const { prefix, suffix } = boundedPrefixAndSuffix(model, position);
	return {
		generation,
		uri: model.uri.toString(),
		version: model.getVersionId(),
		position: { lineNumber: position.lineNumber, column: position.column },
		selection: selectionSnapshot(selection),
		prefix,
		suffix,
	};
};

export const buildGhostChatPrompt = (snapshot: Pick<GhostChatSnapshot, 'prefix' | 'suffix'>): string => {
	const prefix = snapshot.prefix.slice(-GHOST_CHAT_PREFIX_MAX_CHARS);
	const suffix = snapshot.suffix.slice(0, GHOST_CHAT_SUFFIX_MAX_CHARS);
	return `${PROMPT_HEADER}\n\n<PREFIX>\n${prefix}\n</PREFIX>\n<CURSOR>\n<SUFFIX>\n${suffix}\n</SUFFIX>`;
};

export const validateGhostChatInsertion = (rawText: string, snapshot: Pick<GhostChatSnapshot, 'prefix' | 'suffix'>): GhostChatValidationResult => {
	if (rawText.trim().length === 0) return { ok: false, reason: 'empty' };
	if (rawText.length > GHOST_CHAT_INSERT_MAX_CHARS) return { ok: false, reason: 'too-long' };
	if (rawText.includes('\r') || rawText.includes('\n')) return { ok: false, reason: 'multiline' };
	if (/```|~~~/.test(rawText)) return { ok: false, reason: 'fenced' };
	if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(rawText)) return { ok: false, reason: 'control' };
	if (/<\/?(?:prefix|suffix)>|<cursor>|<\|ghost_cursor\|>/i.test(rawText)) return { ok: false, reason: 'context-marker' };
	if (snapshot.prefix.endsWith(rawText) || snapshot.suffix.startsWith(rawText)) return { ok: false, reason: 'duplicate-context' };

	const prefixTail = snapshot.prefix.slice(-Math.min(32, snapshot.prefix.length));
	const suffixHead = snapshot.suffix.slice(0, Math.min(32, snapshot.suffix.length));
	if ((prefixTail.length >= 8 && rawText.startsWith(prefixTail)) || (suffixHead.length >= 8 && rawText.endsWith(suffixHead))) {
		return { ok: false, reason: 'duplicate-context' };
	}
	return { ok: true, text: rawText };
};

export const isGhostChatSnapshotCurrent = (
	snapshot: GhostChatSnapshot,
	generation: number,
	model: ITextModel,
	position: Position | null,
	selection: ISelection | null,
): boolean => {
	if (generation !== snapshot.generation || !position || !selection) return false;
	if (model.uri.toString() !== snapshot.uri || model.getVersionId() !== snapshot.version) return false;
	if (position.lineNumber !== snapshot.position.lineNumber || position.column !== snapshot.position.column) return false;
	if (!selectionMatches(snapshot.selection, selection)) return false;
	const current = boundedPrefixAndSuffix(model, position);
	return current.prefix === snapshot.prefix && current.suffix === snapshot.suffix;
};

export interface IGhostChatService {
	readonly _serviceBrand: undefined;
	triggerManual(): Promise<void>;
	getDiagnosticsView(): GhostChatDiagnosticsView;
}

export const IGhostChatService = createDecorator<IGhostChatService>('ghostChatService');

export class GhostChatService extends Disposable implements IGhostChatService {
	readonly _serviceBrand: undefined;

	private generation = 0;
	private armed: ArmedRequest | undefined;
	private active: ActiveRequest | undefined;
	private timeoutMs = GHOST_CHAT_TIMEOUT_MS;
	private didDispose = false;
	private ghostChatEnabled: boolean;
	private readonly lifecycleRecords = new Map<number, GhostChatLifecycleRecord>();
	private readonly lifecycleOrder: number[] = [];
	private readonly diagnostics = {
		requestCount: 0,
		shownCount: 0,
		acceptedCount: 0,
		rejectedCount: 0,
		emptyCount: 0,
		invalidCount: 0,
		errorCount: 0,
		staleSuppressedCount: 0,
		abortCount: 0,
		timeoutCount: 0,
		activeRequests: 0,
		maxConcurrentRequests: 0,
		requestBytes: 0,
		lastFirstSuggestionLatencyMs: null as number | null,
		totalFirstSuggestionLatencyMs: 0,
		maxFirstSuggestionLatencyMs: 0,
	};

	constructor(
		@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
		@ILLMMessageService private readonly llmMessageService: ILLMMessageService,
		@ICodeEditorService private readonly codeEditorService: ICodeEditorService,
		@ICommandService private readonly commandService: ICommandService,
		@IVoidSettingsService private readonly voidSettingsService: IVoidSettingsService,
	) {
		super();
		this.ghostChatEnabled = !!this.voidSettingsService.state.globalSettings.enableGhostChat;
		const thisService = this;
		const provider: InlineCompletionsProvider<GhostChatInlineCompletions> = {
			get debounceDelayMs(): number | undefined { return thisService.ghostChatEnabled ? GHOST_CHAT_DEBOUNCE_DELAY_MS : undefined; },
			provideInlineCompletions: (model, position, context, token) => this.provideInlineCompletions(model, position, context, token),
			handleItemDidShow: (completions, item) => this.handleItemDidShow(completions as GhostChatInlineCompletions, item as GhostChatInlineCompletion),
			handleRejection: (completions, item) => this.handleRejection(completions as GhostChatInlineCompletions, item as GhostChatInlineCompletion),
			// Native disposal is not an acceptance or rejection signal.
			freeInlineCompletions: () => { },
		};
		this._register(languageFeaturesService.inlineCompletionsProvider.register('*', provider));
		this._register(this.voidSettingsService.onDidChangeState(() => {
			const wasEnabled = this.ghostChatEnabled;
			this.ghostChatEnabled = !!this.voidSettingsService.state.globalSettings.enableGhostChat;
			if (!wasEnabled || this.ghostChatEnabled) return;
			this.invalidateActive();
			void this.commandService.executeCommand(INLINE_SUGGEST_HIDE_COMMAND_ID).then(undefined, () => { });
		}));
	}

	async triggerManual(): Promise<void> {
		if (this.didDispose) return;
		this.invalidateActive();
		await this.commandService.executeCommand(INLINE_SUGGEST_HIDE_COMMAND_ID);
		if (this.didDispose) return;

		// Hiding native inline completions is asynchronous and can change the active
		// editor or its state. Admission and the snapshot must use the post-hide state.
		const editor = this.codeEditorService.getActiveCodeEditor();
		if (!editor || editor.getOption(EditorOption.readOnly)) return;
		const current = getGhostChatCurrentSingleCaret(editor);
		if (!current) return;

		const snapshot = captureGhostChatSnapshot(current.model, current.position, current.selection, this.generation);
		this.armed = { editor, snapshot };
		try {
			await this.commandService.executeCommand(INLINE_SUGGEST_TRIGGER_COMMAND_ID);
		}
		finally {
			if (this.armed?.snapshot === snapshot) this.armed = undefined;
		}
	}

	private provideInlineCompletions(model: ITextModel, position: Position, context: InlineCompletionContext, token: CancellationToken): Promise<GhostChatInlineCompletions> | GhostChatInlineCompletions {
		if (this.didDispose) return emptyCompletions(this.generation);
		if (context.triggerKind === InlineCompletionTriggerKind.Automatic) {
			return this.provideAutomaticInlineCompletions(model, position, token);
		}
		if (context.triggerKind !== InlineCompletionTriggerKind.Explicit) return emptyCompletions(this.generation);
		const armed = this.armed;
		if (!armed || armed.editor !== this.codeEditorService.getActiveCodeEditor()) return emptyCompletions(this.generation);
		this.armed = undefined;
		const current = getGhostChatCurrentSingleCaret(armed.editor);
		if (!current || armed.editor.getOption(EditorOption.readOnly)) return emptyCompletions(this.generation);
		if (current.model !== model || current.position.lineNumber !== position.lineNumber || current.position.column !== position.column || !isGhostChatSnapshotCurrent(armed.snapshot, this.generation, model, position, current.selection)) {
			return emptyCompletions(this.generation);
		}
		if (token.isCancellationRequested) {
			this.generation += 1;
			return emptyCompletions(this.generation);
		}
		return this.startRequest(armed.editor, model, armed.snapshot, token);
	}

	private provideAutomaticInlineCompletions(model: ITextModel, position: Position, token: CancellationToken): Promise<GhostChatInlineCompletions> | GhostChatInlineCompletions {
		if (!this.ghostChatEnabled || !this.voidSettingsService.state.globalSettings.enableGhostChat || token.isCancellationRequested) {
			return emptyCompletions(this.generation);
		}

		let editor = this.codeEditorService.getActiveCodeEditor();
		let current = editor ? getGhostChatCurrentSingleCaret(editor) : undefined;
		if (!editor || editor.getOption(EditorOption.readOnly) || !current || current.model !== model
			|| current.position.lineNumber !== position.lineNumber || current.position.column !== position.column) {
			return emptyCompletions(this.generation);
		}

		// Native debounce has completed at this point. Invalidate the predecessor
		// before taking the request snapshot so automatic work is strictly max-one.
		this.invalidateActive();
		if (!this.ghostChatEnabled || !this.voidSettingsService.state.globalSettings.enableGhostChat || token.isCancellationRequested) {
			return emptyCompletions(this.generation);
		}
		editor = this.codeEditorService.getActiveCodeEditor();
		current = editor ? getGhostChatCurrentSingleCaret(editor) : undefined;
		if (!editor || editor.getOption(EditorOption.readOnly) || !current || current.model !== model
			|| current.position.lineNumber !== position.lineNumber || current.position.column !== position.column) {
			return emptyCompletions(this.generation);
		}

		const snapshot = captureGhostChatSnapshot(model, current.position, current.selection, this.generation);
		return this.startRequest(editor, model, snapshot, token);
	}

	private startRequest(editor: ICodeEditor, model: ITextModel, snapshot: GhostChatSnapshot, token: CancellationToken): Promise<GhostChatInlineCompletions> {
		return new Promise<GhostChatInlineCompletions>(resolve => {
			const prompt = buildGhostChatPrompt(snapshot);
			const session: ActiveRequest = {
				editor,
				model,
				snapshot,
				disposables: new DisposableStore(),
				resolve,
				requestId: null,
				timeout: undefined,
				cancelRequested: false,
				abortSent: false,
				settled: false,
				staleSuppressedRecorded: false,
			};
			this.active = session;
			this.recordRequestStart(snapshot.generation, prompt);

			session.disposables.add(model.onDidChangeContent(() => this.cancelSession(session)));
			session.disposables.add(editor.onDidChangeCursorSelection(() => this.cancelSession(session)));
			session.disposables.add(editor.onDidChangeModel(() => this.cancelSession(session)));
			session.disposables.add(editor.onDidChangeConfiguration(event => {
				if (event.hasChanged(EditorOption.readOnly)) this.cancelSession(session);
			}));
			session.disposables.add(token.onCancellationRequested(() => this.cancelSession(session)));
			session.timeout = setTimeout(() => this.timeoutSession(session), this.timeoutMs);

			let requestId: string | null;
			try {
				requestId = this.llmMessageService.sendLLMMessage({
					messagesType: 'chatMessages',
					messages: [{ role: 'user', content: prompt }],
					separateSystemMessage: undefined,
					chatMode: null,
					requestProfile: 'ghost-chat',
					modelSelection: { providerName: 'openAICompatible', modelName: 'gpt-4.1' },
					modelSelectionOptions: undefined,
					overridesOfModel: undefined,
					agentDelegationAllowed: false,
					logging: { loggingName: 'Ghost Chat' },
					onText: () => { },
					onFinalMessage: ({ fullText }) => this.finishWithResult(session, fullText),
					onError: () => this.finishWithError(session),
					onAbort: () => this.settle(session, emptyCompletions(session.snapshot.generation)),
				});
			}
			catch {
				this.finishWithError(session);
				return;
			}
			session.requestId = requestId;
			if (session.cancelRequested) this.abortIfPossible(session);
			if (requestId === null && !session.settled) this.finishWithError(session);
		});
	}

	private finishWithResult(session: ActiveRequest, fullText: string): void {
		if (session.settled) {
			if (session.cancelRequested) this.recordStaleSuppressed(session);
			return;
		}
		const current = getGhostChatCurrentSingleCaret(session.editor);
		const isCurrent = this.active === session
			&& !this.didDispose
			&& session.editor === this.codeEditorService.getActiveCodeEditor()
			&& !session.editor.getOption(EditorOption.readOnly)
			&& !!current
			&& current.model === session.model
			&& isGhostChatSnapshotCurrent(session.snapshot, this.generation, session.model, current.position, current.selection);
		if (!isCurrent) {
			this.recordStaleSuppressed(session);
			this.settle(session, emptyCompletions(session.snapshot.generation));
			return;
		}

		const validation = validateGhostChatInsertion(fullText, session.snapshot);
		if (!validation.ok) {
			if (validation.reason === 'empty') this.diagnostics.emptyCount += 1;
			else this.diagnostics.invalidCount += 1;
			this.settle(session, emptyCompletions(session.snapshot.generation));
			return;
		}
		const { lineNumber, column } = session.snapshot.position;
		const generation = session.snapshot.generation;
		const lifecycleRecord = this.lifecycleRecords.get(generation);
		if (lifecycleRecord) lifecycleRecord.completionReady = true;
		this.settle(session, {
			generation,
			items: [{
				insertText: validation.text,
				range: new Range(lineNumber, column, lineNumber, column),
				command: { id: GHOST_CHAT_ACCEPT_COMMAND_ID, title: 'Record Ghost Chat acceptance', arguments: [generation] },
				ghostChatGeneration: generation,
			} satisfies GhostChatInlineCompletion],
		});
	}

	private finishWithError(session: ActiveRequest): void {
		if (session.settled) return;
		this.diagnostics.errorCount += 1;
		this.settle(session, emptyCompletions(session.snapshot.generation));
	}

	private timeoutSession(session: ActiveRequest): void {
		if (session.settled || session.cancelRequested) return;
		this.diagnostics.timeoutCount += 1;
		this.cancelSession(session);
	}

	private invalidateActive(): void {
		this.generation += 1;
		this.armed = undefined;
		if (this.active) this.cancelSession(this.active, false);
	}

	private cancelSession(session: ActiveRequest, advanceGeneration = true): void {
		if (session.cancelRequested) return;
		session.cancelRequested = true;
		if (advanceGeneration && this.generation === session.snapshot.generation) this.generation += 1;
		this.abortIfPossible(session);
		this.settle(session, emptyCompletions(session.snapshot.generation));
	}

	private abortIfPossible(session: ActiveRequest): void {
		if (!session.cancelRequested || session.abortSent || session.requestId === null) return;
		session.abortSent = true;
		this.diagnostics.abortCount += 1;
		try {
			this.llmMessageService.abort(session.requestId);
		}
		catch { }
	}

	private settle(session: ActiveRequest, result: GhostChatInlineCompletions): void {
		if (session.settled) return;
		session.settled = true;
		if (session.timeout !== undefined) clearTimeout(session.timeout);
		session.disposables.dispose();
		if (this.active === session) this.active = undefined;
		this.diagnostics.activeRequests = Math.max(0, this.diagnostics.activeRequests - 1);
		session.resolve(result);
	}

	private recordRequestStart(generation: number, prompt: string): void {
		this.diagnostics.requestCount += 1;
		this.diagnostics.activeRequests += 1;
		this.diagnostics.maxConcurrentRequests = Math.max(this.diagnostics.maxConcurrentRequests, this.diagnostics.activeRequests);
		this.diagnostics.requestBytes += VSBuffer.fromString(prompt).byteLength;

		this.lifecycleRecords.set(generation, {
			generation,
			requestStartedAtMs: Date.now(),
			completionReady: false,
			shown: false,
			terminalUserActionRecorded: false,
		});
		this.lifecycleOrder.push(generation);
		while (this.lifecycleOrder.length > GHOST_CHAT_LIFECYCLE_RECORD_LIMIT) {
			const oldest = this.lifecycleOrder.shift();
			if (oldest !== undefined) this.lifecycleRecords.delete(oldest);
		}
	}

	private recordStaleSuppressed(session: ActiveRequest): void {
		if (session.staleSuppressedRecorded) return;
		session.staleSuppressedRecorded = true;
		this.diagnostics.staleSuppressedCount += 1;
	}

	private handleItemDidShow(completions: GhostChatInlineCompletions, item: GhostChatInlineCompletion): void {
		if (completions.generation !== item.ghostChatGeneration) return;
		const record = this.lifecycleRecords.get(item.ghostChatGeneration);
		if (!record || !record.completionReady || record.shown) return;
		record.shown = true;
		const latency = Math.max(0, Date.now() - record.requestStartedAtMs);
		this.diagnostics.shownCount += 1;
		this.diagnostics.lastFirstSuggestionLatencyMs = latency;
		this.diagnostics.totalFirstSuggestionLatencyMs += latency;
		this.diagnostics.maxFirstSuggestionLatencyMs = Math.max(this.diagnostics.maxFirstSuggestionLatencyMs, latency);
	}

	private handleRejection(completions: GhostChatInlineCompletions, item: GhostChatInlineCompletion): void {
		if (completions.generation !== item.ghostChatGeneration) return;
		const record = this.lifecycleRecords.get(item.ghostChatGeneration);
		if (!record || !record.completionReady || record.terminalUserActionRecorded) return;
		record.terminalUserActionRecorded = true;
		this.diagnostics.rejectedCount += 1;
	}

	recordAcceptance(generation: number): void {
		const record = this.lifecycleRecords.get(generation);
		if (!record || !record.completionReady || record.terminalUserActionRecorded) return;
		record.terminalUserActionRecorded = true;
		this.diagnostics.acceptedCount += 1;
	}

	getDiagnosticsView(): GhostChatDiagnosticsView {
		return Object.freeze({
			requestCount: this.diagnostics.requestCount,
			shownCount: this.diagnostics.shownCount,
			acceptedCount: this.diagnostics.acceptedCount,
			rejectedCount: this.diagnostics.rejectedCount,
			emptyCount: this.diagnostics.emptyCount,
			invalidCount: this.diagnostics.invalidCount,
			errorCount: this.diagnostics.errorCount,
			staleSuppressedCount: this.diagnostics.staleSuppressedCount,
			staleDisplayedCount: 0,
			abortCount: this.diagnostics.abortCount,
			timeoutCount: this.diagnostics.timeoutCount,
			retryCount: 0,
			activeRequests: this.diagnostics.activeRequests,
			maxConcurrentRequests: this.diagnostics.maxConcurrentRequests,
			requestBytes: this.diagnostics.requestBytes,
			estimatedRequestTokens: Math.ceil(this.diagnostics.requestBytes / 4),
			lastFirstSuggestionLatencyMs: this.diagnostics.lastFirstSuggestionLatencyMs,
			totalFirstSuggestionLatencyMs: this.diagnostics.totalFirstSuggestionLatencyMs,
			maxFirstSuggestionLatencyMs: this.diagnostics.maxFirstSuggestionLatencyMs,
			cancelToTransportCloseMs: null,
		});
	}

	override dispose(): void {
		if (this.didDispose) return;
		this.didDispose = true;
		this.invalidateActive();
		super.dispose();
	}
}

registerSingleton(IGhostChatService, GhostChatService, InstantiationType.Eager);

CommandsRegistry.registerCommand(GHOST_CHAT_ACCEPT_COMMAND_ID, (accessor, generation: unknown) => {
	if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 0) return;
	(accessor.get(IGhostChatService) as GhostChatService).recordAcceptance(generation);
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: GHOST_CHAT_COMMAND_ID,
			f1: true,
			title: localize2('voidGhostChatGenerateInternal', 'Void: Generate Ghost Text (Internal)'),
			precondition: IsDevelopmentContext,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		if (!isGhostChatDevelopmentEnvironment(accessor.get(IEnvironmentService))) return;
		await accessor.get(IGhostChatService).triggerManual();
	}
});
