/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ChatHistoryChildOverview, ChatHistoryParentActivity, ChatHistoryThreadMetadata, getChatHistoryPresentation, hasActionRequiredChild, shouldShowPersistentChatHistory } from '../../common/chatHistoryPresentation.js';

const thread = (id: string, overrides: Partial<ChatHistoryThreadMetadata> = {}): ChatHistoryThreadMetadata => ({ id, title: `Chat ${id}`, messageCount: 1, lastModified: '2026-08-12T00:00:00.000Z', ...overrides });
const parent = (overrides: ChatHistoryParentActivity = {}): Readonly<Record<string, ChatHistoryParentActivity | undefined>> => ({ a: overrides });
const child = (overrides: ChatHistoryChildOverview): Readonly<Record<string, ChatHistoryChildOverview | undefined>> => ({ a: overrides });

suite('Void ChatHistoryPresentation', () => {
	test('shows persistent Chat history on landing but not below the current Chat composer', () => {
		assert.strictEqual(shouldShowPersistentChatHistory('landing'), true);
		assert.strictEqual(shouldShowPersistentChatHistory('current'), false);
	});
	test('returns an empty frozen list for no visible chats', () => assert.ok(Object.isFrozen(getChatHistoryPresentation([], '', {}, {}))));
	test('filters zero-message chats and sorts descending by modification time', () => {
		const value = getChatHistoryPresentation([thread('old', { lastModified: '2026-08-10T00:00:00.000Z' }), thread('empty', { messageCount: 0 }), thread('new', { lastModified: '2026-08-11T00:00:00.000Z' })], '', {}, {});
		assert.deepStrictEqual(value.map(row => row.id), ['new', 'old']);
	});
	test('marks the current chat independently from its status', () => {
		const value = getChatHistoryPresentation([thread('a')], 'a', parent({ isRunning: 'LLM' }), {} )[0];
		assert.strictEqual(value.selected, true); assert.strictEqual(value.status, 'Running'); assert.strictEqual(value.canDelete, false); assert.ok(value.ariaLabel.includes('Current'));
	});
	test('only exposes Delete for inactive previous chats and freezes the policy result', () => {
		const previous = getChatHistoryPresentation([thread('a')], '', {}, {});
		const current = getChatHistoryPresentation([thread('a')], 'a', {}, {});
		const error = getChatHistoryPresentation([thread('a')], '', parent({ hasError: true }), {});
		const actionRequired = getChatHistoryPresentation([thread('a')], '', {}, child({ actionRequired: true, running: false, queued: false }));
		const needsApproval = getChatHistoryPresentation([thread('a')], '', parent({ isRunning: 'awaiting_user' }), {});
		const running = getChatHistoryPresentation([thread('a')], '', parent({ isRunning: 'LLM' }), {});
		const queued = getChatHistoryPresentation([thread('a')], '', {}, child({ actionRequired: false, running: false, queued: true }));
		assert.strictEqual(previous[0].canDelete, true);
		assert.strictEqual(current[0].canDelete, false);
		assert.strictEqual(error[0].canDelete, true);
		assert.strictEqual(actionRequired[0].canDelete, false);
		assert.strictEqual(needsApproval[0].canDelete, false);
		assert.strictEqual(running[0].canDelete, false);
		assert.strictEqual(queued[0].canDelete, false);
		assert.ok(Object.isFrozen(previous)); assert.ok(Object.isFrozen(previous[0]));
	});
	test('keeps Delete hidden when Error masks raw parent or child activity', () => {
		for (const isRunning of ['LLM', 'tool', 'awaiting_user', 'idle'] as const) {
			const value = getChatHistoryPresentation([thread('a')], '', parent({ hasError: true, isRunning }), {} )[0];
			assert.strictEqual(value.status, 'Error'); assert.strictEqual(value.canDelete, false, `parent ${isRunning}`);
		}
		for (const overview of [
			{ actionRequired: true, running: false, queued: false },
			{ actionRequired: false, running: true, queued: false },
			{ actionRequired: false, running: false, queued: true },
		] as const) {
			const value = getChatHistoryPresentation([thread('a')], '', parent({ hasError: true }), child(overview))[0];
			assert.strictEqual(value.status, 'Error'); assert.strictEqual(value.canDelete, false, JSON.stringify(overview));
		}
	});
	test('maps each status and omits completed or cancelled child badges', () => {
		assert.strictEqual(getChatHistoryPresentation([thread('a')], '', parent({ hasError: true }), {})[0].status, 'Error');
		assert.strictEqual(getChatHistoryPresentation([thread('a')], '', {}, child({ actionRequired: true, running: false, queued: false }))[0].status, 'Action required');
		assert.strictEqual(getChatHistoryPresentation([thread('a')], '', parent({ isRunning: 'awaiting_user' }), {})[0].status, 'Needs approval');
		assert.strictEqual(getChatHistoryPresentation([thread('a')], '', parent({ isRunning: 'idle' }), {})[0].status, 'Running');
		assert.strictEqual(getChatHistoryPresentation([thread('a')], '', {}, child({ actionRequired: false, running: false, queued: true }))[0].status, 'Queued');
		assert.strictEqual(getChatHistoryPresentation([thread('a')], '', {}, child({ actionRequired: false, running: false, queued: false }))[0].status, undefined, 'completed child');
		assert.strictEqual(getChatHistoryPresentation([thread('a')], '', {}, child({ actionRequired: false, running: false, queued: false }))[0].status, undefined, 'cancelled child');
	});
	test('uses the documented priority and freezes nested output', () => {
		const error = getChatHistoryPresentation([thread('a')], '', parent({ hasError: true, isRunning: 'awaiting_user' }), child({ actionRequired: true, running: true, queued: true }));
		const actionRequired = getChatHistoryPresentation([thread('a')], '', parent({ isRunning: 'awaiting_user' }), child({ actionRequired: true, running: true, queued: true }));
		const needsApproval = getChatHistoryPresentation([thread('a')], '', parent({ isRunning: 'awaiting_user' }), child({ actionRequired: false, running: true, queued: true }));
		const running = getChatHistoryPresentation([thread('a')], '', {}, child({ actionRequired: false, running: true, queued: true }));
		assert.strictEqual(error[0].status, 'Error'); assert.strictEqual(actionRequired[0].status, 'Action required'); assert.strictEqual(needsApproval[0].status, 'Needs approval'); assert.strictEqual(running[0].status, 'Running');
		assert.ok(Object.isFrozen(error)); assert.ok(Object.isFrozen(error[0]));
	});
	test('does not treat a cancelled admission failure as action required', () => {
		assert.strictEqual(hasActionRequiredChild([], { events: [{ kind: 'admission_failed', diagnostic: 'cancelled' }] }), false);
		assert.strictEqual(hasActionRequiredChild([], { events: [{ kind: 'admission_failed', diagnostic: 'provider_error' }] }), true);
		assert.strictEqual(hasActionRequiredChild([{ status: 'failed' }], { events: [] }), true);
	});
});
