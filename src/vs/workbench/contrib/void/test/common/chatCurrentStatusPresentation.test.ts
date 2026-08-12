/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { canSubmitChatCurrent, ChatCurrentStatusInput, getChatCurrentStatusPresentation } from '../../common/chatCurrentStatusPresentation.js';

const present = (overrides: Partial<ChatCurrentStatusInput> = {}) => getChatCurrentStatusPresentation({
	parentIsRunning: undefined,
	childActive: false,
	hasError: false,
	hasDraft: true,
	chatModelUnavailable: false,
	...overrides,
});

suite('Void ChatCurrentStatusPresentation', () => {
	test('maps all five status kinds with exact base copy', () => {
		const idle = present();
		const unavailable = present({ chatModelUnavailable: true });
		const running = present({ parentIsRunning: 'LLM', hasDraft: false });
		const awaiting = present({ parentIsRunning: 'awaiting_user', hasDraft: false });
		const error = present({ hasError: true });

		assert.deepStrictEqual([idle.kind, unavailable.kind, running.kind, awaiting.kind, error.kind], ['idle', 'unavailable', 'running', 'awaiting_user', 'error']);
		assert.deepStrictEqual([idle.liveLabel, unavailable.liveLabel, running.liveLabel, awaiting.liveLabel, error.liveLabel], [undefined, undefined, 'Running', 'Needs approval', 'Error']);
		assert.strictEqual(idle.detail, 'Enter to send · Shift+Enter for new line');
		assert.strictEqual(unavailable.detail, 'Choose a Chat model to send');
		assert.strictEqual(running.detail, 'Esc to stop');
		assert.strictEqual(awaiting.detail, 'Review the request above');
		assert.strictEqual(error.detail, 'Review the message above');
	});

	test('uses error, awaiting, running, unavailable, idle priority', () => {
		assert.strictEqual(present({ hasError: true, parentIsRunning: 'awaiting_user', childActive: true, chatModelUnavailable: true }).kind, 'error');
		assert.strictEqual(present({ parentIsRunning: 'awaiting_user', childActive: true, chatModelUnavailable: true }).kind, 'awaiting_user');
		assert.strictEqual(present({ parentIsRunning: 'tool', chatModelUnavailable: true }).kind, 'running');
		assert.strictEqual(present({ chatModelUnavailable: true }).kind, 'unavailable');
		assert.strictEqual(present().kind, 'idle');
	});

	test('adds draft-not-sent copy only to running and awaiting states', () => {
		assert.strictEqual(present({ parentIsRunning: 'idle' }).detail, 'Esc to stop · Draft is not sent yet');
		assert.strictEqual(present({ parentIsRunning: 'awaiting_user' }).detail, 'Review the request above · Draft is not sent yet');
		assert.strictEqual(present({ hasError: true }).detail, 'Review the message above');
	});

	test('shows disabled Send and no Stop while only awaiting approval', () => {
		const value = present({ parentIsRunning: 'awaiting_user' });
		assert.strictEqual(value.showStop, false);
		assert.strictEqual(value.sendDisabled, true);
	});

	test('shows Stop for child-only activity', () => {
		const value = present({ childActive: true, hasDraft: false });
		assert.strictEqual(value.kind, 'running');
		assert.strictEqual(value.showStop, true);
		assert.strictEqual(value.sendDisabled, true);
	});

	test('disables Send when the Chat model is unavailable', () => {
		const value = present({ chatModelUnavailable: true });
		assert.strictEqual(value.showStop, false);
		assert.strictEqual(value.sendDisabled, true);
	});

	test('disables idle Send without a draft and enables it with a draft', () => {
		assert.strictEqual(present({ hasDraft: false }).sendDisabled, true);
		assert.strictEqual(present({ hasDraft: true }).sendDisabled, false);
	});

	test('authoritatively gates draft and forced submissions', () => {
		assert.strictEqual(canSubmitChatCurrent({ busy: false, hasDraft: false, chatModelUnavailable: true, forcedText: 'Summarize my codebase' }), false, 'unavailable model blocks forced suggestion');
		assert.strictEqual(canSubmitChatCurrent({ busy: true, hasDraft: true, chatModelUnavailable: false, forcedText: 'Forced' }), false, 'busy blocks forced text and draft');
		assert.strictEqual(canSubmitChatCurrent({ busy: false, hasDraft: false, chatModelUnavailable: false }), false, 'empty input without force');
		assert.strictEqual(canSubmitChatCurrent({ busy: false, hasDraft: false, chatModelUnavailable: false, forcedText: 'Forced' }), true, 'nonempty force without draft');
		assert.strictEqual(canSubmitChatCurrent({ busy: false, hasDraft: true, chatModelUnavailable: false }), true, 'idle draft');
	});

	test('keeps awaiting priority while allowing an active child to be stopped', () => {
		const value = present({ parentIsRunning: 'awaiting_user', childActive: true });
		assert.strictEqual(value.kind, 'awaiting_user');
		assert.strictEqual(value.showStop, true);
		assert.strictEqual(value.sendDisabled, true);
		assert.strictEqual(value.detail, 'Review the request above · Draft is not sent yet · Esc to stop active child');
		assert.deepStrictEqual(value.controls.stop, { id: 'void-chat-current-stop', ariaLabel: 'Stop active child run', title: 'Stop active child run' });
		assert.strictEqual(Object.isFrozen(value.controls), true);
		assert.strictEqual(Object.isFrozen(value.controls.stop), true);
	});

	test('keeps error primary while exposing an active-child stop', () => {
		const value = present({ hasError: true, childActive: true });
		assert.strictEqual(value.kind, 'error');
		assert.strictEqual(value.detail, 'Review the message above · Esc to stop active child');
		assert.deepStrictEqual(value.controls.stop, { id: 'void-chat-current-stop', ariaLabel: 'Stop active child run', title: 'Stop active child run' });
	});

	test('freezes top-level and nested output with exact control labels', () => {
		const value = present();
		assert.strictEqual(value.textarea.ariaLabel, 'Chat message');
		assert.strictEqual(value.textarea.ariaDescribedBy, 'void-chat-current-status-help');
		assert.deepStrictEqual(value.controls.send, { id: 'void-chat-current-send', ariaLabel: 'Send message', title: 'Send message' });
		assert.deepStrictEqual(value.controls.stop, { id: 'void-chat-current-stop', ariaLabel: 'Stop current run', title: 'Stop current run' });
		assert.strictEqual(Object.isFrozen(value), true);
		assert.strictEqual(Object.isFrozen(value.textarea), true);
		assert.strictEqual(Object.isFrozen(value.statusHelp), true);
		assert.strictEqual(Object.isFrozen(value.controls), true);
		assert.strictEqual(Object.isFrozen(value.controls.send), true);
		assert.strictEqual(Object.isFrozen(value.controls.stop), true);
	});
});
