/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ChatThreadService } from '../../browser/chatThreadService.js';
import { createSkillComposerDollarSession, updateSkillComposerDollarQuery } from '../../common/agentSkills.js';
import { submitChatComposer } from '../../common/chatComposerSubmission.js';

const thread = (stagingSelections: string[] = []) => ({ id: '', messages: [], state: { stagingSelections }, filesWithUserChanges: new Set() });
const draftReceiver = () => {
	const value: any = Object.create(ChatThreadService.prototype);
	value.state = { allThreads: { A: { ...thread(['selection-a']), id: 'A' }, B: { ...thread(['selection-b']), id: 'B' } }, currentThreadId: 'A' };
	value._transientComposerDraftOfThread = new Map<string, string>();
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

	test('failed or non-admitted submission preserves draft, selections, and input', async () => {
		const value = draftReceiver(); value.setTransientComposerDraft('A', 'draft-a'); let domClears = 0;
		const options = { threadId: 'A', clearSubmittedState: (id: string) => value.clearSubmittedComposerState(id), getCurrentThreadId: () => value.state.currentThreadId, clearCurrentInput: () => domClears++ };
		await assert.rejects(() => submitChatComposer({ ...options, submit: async () => { throw new Error('admission failed') } }), /admission failed/);
		assert.strictEqual(await submitChatComposer({ ...options, submit: async () => false }), false);
		assert.strictEqual(value.getTransientComposerDraft('A'), 'draft-a'); assert.deepStrictEqual(value.state.allThreads.A.state.stagingSelections, ['selection-a']); assert.strictEqual(domClears, 0);
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
		const superseded = ChatThreadService.prototype.addUserMessageAndStreamResponse.call(value, { userMessage: 'older', threadId: 'A' });
		value.state.allThreads.A.messages.push({ role: 'user', displayContent: 'newer' });
		resolveSuperseded(false);
		assert.strictEqual(await superseded, false);
		value._addUserMessageAndStreamResponse = async () => true;
		assert.strictEqual(await ChatThreadService.prototype.addUserMessageAndStreamResponse.call(value, { userMessage: 'newer', threadId: 'A' }), true);
	});

	test('delete, destructive replacement, reset, duplicate, and dispose respect transient lifecycle', () => {
		const deleted = draftReceiver(); deleted.setTransientComposerDraft('A', 'draft-a'); Object.assign(deleted, { _agentSubagentService: { forgetParent() { } }, _agentDelegationAuthorityOfThread: new Map(), _agentControlGeneration: new Map(), _agentInstructionSessionOfThread: new Map(), _instructionTurnOfThread: new Map(), _toolsService: { invalidateReadReceipts() { } }, _storeAllThreads() { } }); deleted.deleteThread('A'); assert.strictEqual(deleted._transientComposerDraftOfThread.has('A'), false);

		const replaced = draftReceiver(); replaced.setTransientComposerDraft('A', 'draft-a'); Object.assign(replaced, { _agentSubagentService: { forgetParent() { } }, _agentDelegationAuthorityOfThread: new Map(), _agentControlGeneration: new Map(), _agentInstructionSessionOfThread: new Map(), _restoreInstructionTurns() { }, _onDidChangeCurrentThread: { fire() { } } }); replaced.dangerousSetState({ allThreads: {}, currentThreadId: 'replacement' }); assert.strictEqual(replaced._transientComposerDraftOfThread.size, 0);

		const reset = draftReceiver(); reset.setTransientComposerDraft('A', 'draft-a'); Object.assign(reset, { _agentSubagentService: { forgetParent() { } }, _agentDelegationAuthorityOfThread: new Map(), _agentControlGeneration: new Map(), _agentInstructionSessionOfThread: new Map(), _instructionTurnOfThread: new Map(), openNewThread() { }, _onDidChangeCurrentThread: { fire() { } } }); reset.resetState(); assert.strictEqual(reset._transientComposerDraftOfThread.size, 0);

		const duplicated = draftReceiver(); duplicated.setTransientComposerDraft('A', 'draft-a'); Object.assign(duplicated, { _storeAllThreads() { } }); duplicated.duplicateThread('A'); const duplicateId = Object.keys(duplicated.state.allThreads).find(id => id !== 'A' && id !== 'B')!; assert.ok(duplicateId); assert.strictEqual(duplicated.getTransientComposerDraft(duplicateId), ''); assert.strictEqual(duplicated.getTransientComposerDraft('A'), 'draft-a');

		const disposed = draftReceiver(); disposed.setTransientComposerDraft('A', 'draft-a'); Object.assign(disposed, { _agentSubagentService: { cancelParent() { }, forgetParent() { } }, _agentDelegationAuthorityOfThread: new Map(), _agentControlGeneration: new Map(), _store: { dispose() { } } }); disposed.dispose(); assert.strictEqual(disposed._transientComposerDraftOfThread.size, 0);
	});
});
