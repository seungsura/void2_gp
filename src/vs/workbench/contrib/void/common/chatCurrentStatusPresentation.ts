/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

export type ChatCurrentParentRunning = 'LLM' | 'tool' | 'awaiting_user' | 'idle';
export type ChatCurrentStatusKind = 'idle' | 'unavailable' | 'running' | 'awaiting_user' | 'error';
export type ChatCurrentLiveLabel = 'Running' | 'Needs approval' | 'Error';

export type ChatCurrentStatusInput = Readonly<{
	parentIsRunning?: ChatCurrentParentRunning;
	childActive: boolean;
	hasError: boolean;
	hasDraft: boolean;
	chatModelUnavailable: boolean;
}>;

export type ChatCurrentSubmitInput = Readonly<{
	busy: boolean;
	hasDraft: boolean;
	chatModelUnavailable: boolean;
	forcedText?: string;
}>;

export type ChatCurrentControlSemantics = Readonly<{
	id: string;
	ariaLabel: string;
	title: string;
}>;

export type ChatCurrentStatusPresentation = Readonly<{
	kind: ChatCurrentStatusKind;
	liveLabel?: ChatCurrentLiveLabel;
	detail: string;
	announcement: string;
	showStop: boolean;
	sendDisabled: boolean;
	textarea: Readonly<{
		ariaLabel: 'Chat message';
		ariaDescribedBy: string;
	}>;
	statusHelp: Readonly<{
		id: string;
	}>;
	controls: Readonly<{
		send: ChatCurrentControlSemantics;
		stop: ChatCurrentControlSemantics;
	}>;
}>;

export const CHAT_CURRENT_STATUS_HELP_ID = 'void-chat-current-status-help';
export const CHAT_CURRENT_SEND_CONTROL_ID = 'void-chat-current-send';
export const CHAT_CURRENT_STOP_CONTROL_ID = 'void-chat-current-stop';

const freeze = <T>(value: T): T => Object.freeze(value);

const textarea = freeze({
	ariaLabel: 'Chat message' as const,
	ariaDescribedBy: CHAT_CURRENT_STATUS_HELP_ID,
});

const statusHelp = freeze({ id: CHAT_CURRENT_STATUS_HELP_ID });

const controls = freeze({
	send: freeze({ id: CHAT_CURRENT_SEND_CONTROL_ID, ariaLabel: 'Send message', title: 'Send message' }),
	stop: freeze({ id: CHAT_CURRENT_STOP_CONTROL_ID, ariaLabel: 'Stop current run', title: 'Stop current run' }),
});

const withDraftDetail = (detail: string, hasDraft: boolean): string =>
	hasDraft ? `${detail} · Draft is not sent yet` : detail;

const withActiveChildStopDetail = (detail: string, childActive: boolean): string =>
	childActive ? `${detail} · Esc to stop active child` : detail;

export const canSubmitChatCurrent = (input: ChatCurrentSubmitInput): boolean =>
	!input.busy
	&& !input.chatModelUnavailable
	&& (input.hasDraft || (input.forcedText !== undefined && input.forcedText.length > 0));

/**
 * Pure UI projection for the current chat composer. Runtime admission remains
 * authoritative in the chat service and submit handler.
 */
export const getChatCurrentStatusPresentation = (input: ChatCurrentStatusInput): ChatCurrentStatusPresentation => {
	const parentStoppable = input.parentIsRunning === 'LLM' || input.parentIsRunning === 'tool' || input.parentIsRunning === 'idle';
	const stoppable = parentStoppable || input.childActive;
	const busy = input.parentIsRunning !== undefined || input.childActive;

	let kind: ChatCurrentStatusKind;
	let liveLabel: ChatCurrentLiveLabel | undefined;
	let detail: string;

	if (input.hasError) {
		kind = 'error';
		liveLabel = 'Error';
		detail = withActiveChildStopDetail('Review the message above', input.childActive);
	} else if (input.parentIsRunning === 'awaiting_user') {
		kind = 'awaiting_user';
		liveLabel = 'Needs approval';
		detail = withActiveChildStopDetail(withDraftDetail('Review the request above', input.hasDraft), input.childActive);
	} else if (stoppable) {
		kind = 'running';
		liveLabel = 'Running';
		detail = withDraftDetail('Esc to stop', input.hasDraft);
	} else if (input.chatModelUnavailable) {
		kind = 'unavailable';
		detail = 'Choose a Chat model to send';
	} else {
		kind = 'idle';
		detail = 'Enter to send · Shift+Enter for new line';
	}

	const presentedControls = input.childActive && (kind === 'awaiting_user' || kind === 'error')
		? freeze({
			send: controls.send,
			stop: freeze({ id: CHAT_CURRENT_STOP_CONTROL_ID, ariaLabel: 'Stop active child run', title: 'Stop active child run' }),
		})
		: controls;
	const announcement = liveLabel ? `${liveLabel} · ${detail}` : detail;

	return freeze({
		kind,
		...(liveLabel ? { liveLabel } : {}),
		detail,
		announcement,
		showStop: stoppable,
		sendDisabled: !canSubmitChatCurrent({ busy, hasDraft: input.hasDraft, chatModelUnavailable: input.chatModelUnavailable }),
		textarea,
		statusHelp,
		controls: presentedControls,
	});
};
