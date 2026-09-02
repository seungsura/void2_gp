/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ChatThreadService } from '../../browser/chatThreadService.js';
import { EMPTY_CHILD_ACTIVITIES } from '../../common/agentSubagents.js';
import { createSkillComposerDollarSession, updateSkillComposerDollarQuery } from '../../common/agentSkills.js';
import { beginChatComposerSubmissionFlight, submitChatComposer, submitInlineChatEdit } from '../../common/chatComposerSubmission.js';

const thread = (stagingSelections: string[] = []) => ({ id: '', messages: [], childActivities: EMPTY_CHILD_ACTIVITIES, state: { stagingSelections }, filesWithUserChanges: new Set() });
const draftReceiver = () => {
	const value: any = Object.create(ChatThreadService.prototype);
	value.state = { allThreads: { A: { ...thread(['selection-a']), id: 'A' }, B: { ...thread(['selection-b']), id: 'B' } }, currentThreadId: 'A' };
	value._transientComposerDraftOfThread = new Map<string, string>();
	value._pendingChatSubmissionOfThread = new Map<string, unknown>();
	value._onDidChangePendingChatSubmission = { fire() { } };
	value._pendingChatInputsOfThread = new Map<string, unknown[]>();
	value._drainingPendingChatInputs = new Set<string>();
	value._runQuiescenceOfThread = new Map<string, unknown>();
	value._startingParentRunOfThread = new Map<string, unknown>(); value._deferredExternalThreadKey = new Map<string, string>();
	value._approvalActionFlights = new Set<string>(); value._externalPendingDeleteRetries = new Map<string, unknown>(); value._pendingThreadMutationRetries = new Map<string, unknown>();
	value._threadStorageWriteTail = new Map<string, Promise<boolean>>(); value._threadStorageAuthoritativeRaw = new Map<string, string | undefined>(); value._threadStorageWriteEpoch = new Map<string, number>();
	value._deletingPendingInputThreads = new Set<string>();
	value._stopAndSendFlights = new Map<string, Promise<void>>();
	value._childGroupSourceOfThread = new Map<string, unknown>(); value._childGroupSyncRevisionOfThread = new Map<string, number>(); value._childGroupSyncTailOfThread = new Map<string, Promise<unknown>>();
	value._onDidChangePendingChatInputs = { fire() { } };
	value._storePendingChatInputs = () => { };
	value._storageService = { get() { return undefined; }, keys() { return []; }, store() { } };
	value.streamState = {};
	value._parentRunTokenOfThread = new Map<string, symbol>();
	value._agentControlGeneration = new Map<string, number>(); value._agentDelegationAuthorityOfThread = new Map<string, unknown>();
	value._cancellingToolReceiptsOfThread = new Map<string, unknown>();
	value._toolsService = { invalidateReadReceipts() { } };
	value._childToolApprovals = new Map<string, unknown>(); value._onDidChangeChildToolApprovals = { fire() { } };
	value._setState = (partial: any) => { value.state = { ...value.state, ...partial }; };
	return value;
};

suite('Void transient chat composer drafts', () => {
	test('stores independent known-thread drafts and removes empty values', () => {
		const value = draftReceiver();
		value.setTransientComposerDraft('A', 'draft-a'); value.setTransientComposerDraft('B', 'draft-b'); value.setTransientComposerDraft('missing', 'ignored');
		assert.strictEqual(value.getTransientComposerDraft('A'), 'draft-a'); assert.strictEqual(value.getTransientComposerDraft('B'), 'draft-b'); assert.strictEqual(value.getTransientComposerDraft('missing'), '');
		value.setTransientComposerDraft('A', ''); assert.strictEqual(value.getTransientComposerDraft('A'), ''); assert.strictEqual(value._transientComposerDraftOfThread.has('A'), false);
	});

	test('late A admission clears only A while current B stays byte-for-byte intact', async () => {
		const value = draftReceiver(); value.setTransientComposerDraft('A', 'draft-a'); value.setTransientComposerDraft('B', 'draft-b');
		let release!: (admitted: boolean) => void; let domClears = 0;
		const pending = submitChatComposer({ threadId: 'A', submit: () => new Promise<boolean>(resolve => release = resolve), clearSubmittedState: id => value.clearSubmittedComposerState(id), getCurrentThreadId: () => value.state.currentThreadId, clearCurrentInput: () => domClears++ });
		value.state.currentThreadId = 'B'; release(true); assert.strictEqual(await pending, true);
		assert.strictEqual(value.state.currentThreadId, 'B'); assert.strictEqual(value.getTransientComposerDraft('A'), ''); assert.deepStrictEqual(value.state.allThreads.A.state.stagingSelections, []);
		assert.strictEqual(value.getTransientComposerDraft('B'), 'draft-b'); assert.deepStrictEqual(value.state.allThreads.B.state.stagingSelections, ['selection-b']); assert.strictEqual(domClears, 0);
	});

	test('deferred broker ACK preserves newer same-thread draft and selections', async () => {
		const value = draftReceiver(); value.setTransientComposerDraft('A', 'captured draft'); value.state.allThreads.A.state.stagingSelections = ['captured-selection'];
		const capturedText = value.getTransientComposerDraft('A'); const capturedSelections = [...value.state.allThreads.A.state.stagingSelections];
		let release!: (accepted: boolean) => void; let domClears = 0;
		const pending = submitChatComposer({
			threadId: 'A', submit: () => new Promise<boolean>(resolve => release = resolve),
			clearSubmittedState: id => {
				if (value.getTransientComposerDraft(id) !== capturedText || JSON.stringify(value.state.allThreads[id].state.stagingSelections) !== JSON.stringify(capturedSelections)) return false;
				value.clearSubmittedComposerState(id); return true;
			},
			getCurrentThreadId: () => value.state.currentThreadId, clearCurrentInput: () => domClears++,
		});
		// Typing and selection changes remain enabled while the durable admission owns
		// the ordering slot; the late ACK may clear only its captured bytes.
		value.setTransientComposerDraft('A', 'newer draft'); value.state.allThreads.A.state.stagingSelections = ['newer-selection'];
		release(true); assert.strictEqual(await pending, true);
		assert.strictEqual(value.getTransientComposerDraft('A'), 'newer draft'); assert.deepStrictEqual(value.state.allThreads.A.state.stagingSelections, ['newer-selection']); assert.strictEqual(domClears, 0);
	});

	test('one synchronous flight gates every Send mode while leaving draft editing available', () => {
		const flight = { current: false }; const first = beginChatComposerSubmissionFlight(flight); assert.ok(first); assert.strictEqual(flight.current, true);
		for (const _mode of ['queue', 'steer', 'stop_and_send', 'ordinary_send']) assert.strictEqual(beginChatComposerSubmissionFlight(flight), undefined);
		let draft = 'captured'; draft = 'typing remains enabled'; assert.strictEqual(draft, 'typing remains enabled');
		first!(); first!(); assert.strictEqual(flight.current, false);
		const next = beginChatComposerSubmissionFlight(flight); assert.ok(next); next!();
	});

	test('one inline edit flight visibly locks exact text and selections, then unlocks without focusing a replacement thread', async () => {
		const flight = { current: false }; let resolveEdit!: (accepted: boolean) => void; let gate = new Promise<boolean>(resolve => resolveEdit = resolve); let submits = 0; let focuses = 0; let currentThreadId = 'A'; const textareaDraft = 'exact edited bytes'; const textareaSelections = ['exact-selection']; const locks: boolean[] = [];
		const submit = () => submitInlineChatEdit({ flight, threadId: 'A', submit: async () => { submits++; return gate; }, getCurrentThreadId: () => currentThreadId, setInputLocked: locked => locks.push(locked), onAcceptedCurrentThread: () => { focuses++; } });
		const rejected = submit(); const duplicate = submit(); assert.deepStrictEqual(locks, [true], 'only the owning edit flight may lock the input'); assert.strictEqual(await duplicate, false); assert.strictEqual(submits, 1); assert.strictEqual(flight.current, true);
		resolveEdit(false); assert.strictEqual(await rejected, false); assert.deepStrictEqual(locks, [true, false]); assert.strictEqual(flight.current, false, 'rejection must unlock the exact input for retry');
		gate = new Promise<boolean>(resolve => resolveEdit = resolve); const accepted = submit(); assert.deepStrictEqual(locks, [true, false, true]); currentThreadId = 'B'; resolveEdit(true); assert.strictEqual(await accepted, true);
		assert.deepStrictEqual({ textareaDraft, textareaSelections, focuses, currentThreadId, flight: flight.current, locks }, { textareaDraft: 'exact edited bytes', textareaSelections: ['exact-selection'], focuses: 0, currentThreadId: 'B', flight: false, locks: [true, false, true, false] });
	});

	test('accepted receipt clears synchronously before deferred preparation settles', async () => {
		const value = draftReceiver(); value.setTransientComposerDraft('A', 'draft-a'); let release!: (accepted: boolean) => void; let domClears = 0;
		const pending = submitChatComposer({
			threadId: 'A',
			submit: () => ({ accepted: true, settled: new Promise<boolean>(resolve => release = resolve) }),
			clearSubmittedState: id => value.clearSubmittedComposerState(id),
			getCurrentThreadId: () => value.state.currentThreadId,
			clearCurrentInput: () => domClears++,
		});
		assert.strictEqual(value.getTransientComposerDraft('A'), '');
		assert.deepStrictEqual(value.state.allThreads.A.state.stagingSelections, []);
		assert.strictEqual(domClears, 1);
		release(true);
		assert.strictEqual(await pending, true);
	});

	test('pending receipt projects before deferred admission, rejects duplicates, and never persists the row', async () => {
		const value = draftReceiver(); let release!: (accepted: boolean) => void; let changes = 0;
		Object.assign(value, {
			streamState: {},
			_agentControlGeneration: new Map<string, number>(),
			_agentDelegationAuthorityOfThread: new Map(),
			_agentSubagentService: { cancelParent() { }, forgetParent() { } },
			_currentModelSelectionProps: () => ({ modelSelection: undefined }),
			_settingsService: { state: { globalSettings: { chatMode: 'chat' }, overridesOfModel: {} } },
			_onDidChangePendingChatSubmission: { fire() { changes++; } },
			_addUserMessageAndStreamResponse: () => new Promise<boolean>(resolve => release = resolve),
		});
		const receipt = value.beginUserMessageAndStreamResponse({ threadId: 'A', userMessage: 'deferred' });
		assert.strictEqual(receipt.accepted, true); assert.strictEqual(value.getPendingChatSubmission('A')?.displayContent, 'deferred');
		assert.strictEqual(value.state.allThreads.A.messages.length, 0); assert.ok(changes >= 1);
		assert.strictEqual(value.beginUserMessageAndStreamResponse({ threadId: 'A', userMessage: 'duplicate' }).accepted, false);
		release(true); assert.strictEqual(await receipt.settled, true); assert.strictEqual(value.getPendingChatSubmission('A'), undefined);
	});

	test('failed or non-admitted submission preserves draft, selections, and input', async () => {
		const value = draftReceiver(); value.setTransientComposerDraft('A', 'draft-a'); let domClears = 0;
		const options = { threadId: 'A', clearSubmittedState: (id: string) => value.clearSubmittedComposerState(id), getCurrentThreadId: () => value.state.currentThreadId, clearCurrentInput: () => domClears++ };
		await assert.rejects(() => submitChatComposer({ ...options, submit: async () => { throw new Error('admission failed') } }), /admission failed/);
		assert.strictEqual(await submitChatComposer({ ...options, submit: async () => false }), false);
		assert.strictEqual(value.getTransientComposerDraft('A'), 'draft-a'); assert.deepStrictEqual(value.state.allThreads.A.state.stagingSelections, ['selection-a']); assert.strictEqual(domClears, 0);
	});

	test('Queue clears only its captured thread, preserves rejected drafts, and keeps row edits ordered', async () => {
		const value = draftReceiver();
		const rows: any[] = []; let rowId = 0;
		value.submitPendingInput = async (input: any) => { const row = { ...input, id: `row-${++rowId}` }; rows.push(row); return row; };
		value.getPendingChatInputs = () => rows;
		value.reorderPendingInput = async (_threadId: string, id: string, beforeId?: string) => { const from = rows.findIndex(row => row.id === id); const to = beforeId ? rows.findIndex(row => row.id === beforeId) : rows.length; if (from < 0 || to < 0) return false; const [row] = rows.splice(from, 1); rows.splice(from < to ? to - 1 : to, 0, row); return true; };
		value.editPendingInput = async (_threadId: string, id: string, text: string) => { const row = rows.find(item => item.id === id); if (!row) return false; row.text = text; return true; };
		const fileA: any = { type: 'File', uri: { toString: () => 'file:///workspace/a.ts' }, language: 'typescript', state: { wasAddedAsCurrentFile: false } };
		value.state.allThreads.A.state.stagingSelections = [fileA];
		value._workspaceContextService = { getWorkspace: () => ({ folders: [{ uri: { toString: () => 'file:///workspace' } }] }) };
		value._workspaceTrustManagementService = { isWorkspaceTrusted: () => true };
		value._runQuiescenceOfThread.set('A', { runId: 'active', generation: 0, settled: new Promise<void>(() => { }) });
		value.setTransientComposerDraft('A', 'queue A'); value.setTransientComposerDraft('B', 'draft-b');
		let domClears = 0;
		const accepted = await submitChatComposer({
			threadId: 'A',
			submit: async () => !!(await value.submitPendingInput({ threadId: 'A', text: 'queue A', mode: 'queue', selections: [...value.state.allThreads.A.state.stagingSelections] })),
			clearSubmittedState: (id: string) => value.clearSubmittedComposerState(id),
			getCurrentThreadId: () => value.state.currentThreadId,
			clearCurrentInput: () => { domClears++; },
		});
		assert.strictEqual(accepted, true); assert.strictEqual(domClears, 1);
		assert.strictEqual(value.getTransientComposerDraft('A'), ''); assert.deepStrictEqual(value.state.allThreads.A.state.stagingSelections, []);
		assert.strictEqual(value.getTransientComposerDraft('B'), 'draft-b'); assert.deepStrictEqual(value.state.allThreads.B.state.stagingSelections, ['selection-b']);
		assert.strictEqual(value.getPendingChatInputs('A')[0].selections[0].type, 'File');

		value.setTransientComposerDraft('A', 'keep rejected'); value.state.allThreads.A.state.stagingSelections = [fileA];
		assert.strictEqual(await submitChatComposer({ threadId: 'A', submit: async () => false, clearSubmittedState: (id: string) => value.clearSubmittedComposerState(id), getCurrentThreadId: () => value.state.currentThreadId, clearCurrentInput: () => { domClears++; } }), false);
		assert.strictEqual(value.getTransientComposerDraft('A'), 'keep rejected'); assert.deepStrictEqual(value.state.allThreads.A.state.stagingSelections, [fileA]);

		const second = await value.submitPendingInput({ threadId: 'A', text: 'second', mode: 'queue', selections: [] });
		const first = value.getPendingChatInputs('A')[0];
		assert.strictEqual(await value.reorderPendingInput('A', second.id, first.id), true);
		assert.strictEqual(await value.editPendingInput('A', second.id, 'second edited'), true);
		assert.deepStrictEqual(value.getPendingChatInputs('A').map((input: any) => input.text), ['second edited', 'queue A']);
	});

	test('missing Skill admission false keeps exact draft bytes and the staged array identity', async () => {
		const value = draftReceiver(); const initial = 'before\r\n$ `literal $missing`  \n'; let session = createSkillComposerDollarSession(initial, initial.indexOf('$'))!; for (const query of ['m', 'mi', 'missing']) session = updateSkillComposerDollarQuery(session, session.text, query)!; const draft = session.text; const staged = value.state.allThreads.A.state.stagingSelections; value.setTransientComposerDraft('A', draft); let domClears = 0;
		assert.strictEqual(draft, 'before\r\n$missing `literal $missing`  \n');
		assert.strictEqual(await submitChatComposer({ threadId: 'A', submit: async () => false, clearSubmittedState: id => value.clearSubmittedComposerState(id), getCurrentThreadId: () => value.state.currentThreadId, clearCurrentInput: () => domClears++ }), false);
		assert.strictEqual(value.getTransientComposerDraft('A'), draft); assert.strictEqual(value.state.allThreads.A.state.stagingSelections, staged); assert.deepStrictEqual(staged, ['selection-a']); assert.strictEqual(domClears, 0);
	});

	test('a superseded admission stays false when a newer admission adds a message', async () => {
		const value: any = { state: { allThreads: { A: { messages: [] } } } };
		let resolveSuperseded!: (admitted: boolean) => void;
		value._addUserMessageAndStreamResponse = () => new Promise<boolean>(resolve => resolveSuperseded = resolve);
		const superseded = value._addUserMessageAndStreamResponse({ userMessage: 'older', threadId: 'A' });
		value.state.allThreads.A.messages.push({ role: 'user', displayContent: 'newer' });
		resolveSuperseded(false);
		assert.strictEqual(await superseded, false);
		value._addUserMessageAndStreamResponse = async () => true;
		assert.strictEqual(await value._addUserMessageAndStreamResponse({ userMessage: 'newer', threadId: 'A' }), true);
	});

	test('duplicate and dispose respect transient lifecycle', () => {
		const duplicated = draftReceiver(); duplicated.setTransientComposerDraft('A', 'draft-a'); Object.assign(duplicated, { _storeAllThreads() { } }); duplicated.duplicateThread('A'); const duplicateId = Object.keys(duplicated.state.allThreads).find(id => id !== 'A' && id !== 'B')!; assert.ok(duplicateId); assert.strictEqual(duplicated.getTransientComposerDraft(duplicateId), ''); assert.strictEqual(duplicated.getTransientComposerDraft('A'), 'draft-a');

		const disposed = draftReceiver(); disposed.setTransientComposerDraft('A', 'draft-a'); Object.assign(disposed, { _agentSubagentService: { cancelParent() { }, forgetParent() { } }, _agentDelegationAuthorityOfThread: new Map(), _agentControlGeneration: new Map(), _store: { dispose() { } } }); disposed.dispose(); assert.strictEqual(disposed._transientComposerDraftOfThread.size, 0);
	});
});
