/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

export const submitChatComposer = async ({
	threadId,
	submit,
	clearSubmittedState,
	getCurrentThreadId,
	clearCurrentInput,
}: {
	threadId: string;
	submit: () => Promise<boolean> | { accepted: boolean; settled: Promise<boolean> };
	clearSubmittedState: (threadId: string) => boolean | void;
	getCurrentThreadId: () => string;
	clearCurrentInput: () => void;
}) => {
	const receipt = submit();
	if ('then' in receipt) {
		const admitted = await receipt;
		if (!admitted) return false;
		const cleared = clearSubmittedState(threadId) !== false;
		if (cleared && getCurrentThreadId() === threadId) clearCurrentInput();
		return true;
	}
	if (!receipt.accepted) return false;
	const cleared = clearSubmittedState(threadId) !== false;
	if (cleared && getCurrentThreadId() === threadId) clearCurrentInput();
	return receipt.settled;
};

export type ChatComposerSubmissionFlight = { current: boolean };

/** One durable broker admission owns the composer ordering slot. The caller may
 * continue editing while it is held, but Queue, Steer, Stop-and-Send and ordinary
 * Send all share this exact synchronous fence. */
export const beginChatComposerSubmissionFlight = (flight: ChatComposerSubmissionFlight): (() => void) | undefined => {
	if (flight.current) return undefined;
	flight.current = true;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		flight.current = false;
	};
};

/** Inline history edits use the same synchronous admission shape, but keep their
 * textarea mounted until the service has committed and verified the edit. A late
 * success may focus only the originating thread. */
export const submitInlineChatEdit = async ({
	flight,
	threadId,
	submit,
	getCurrentThreadId,
	onAcceptedCurrentThread,
	setInputLocked,
}: {
	flight: ChatComposerSubmissionFlight;
	threadId: string;
	submit: () => Promise<boolean>;
	getCurrentThreadId: () => string;
	onAcceptedCurrentThread: () => void | Promise<void>;
	setInputLocked?: (locked: boolean) => void;
}): Promise<boolean> => {
	const releaseFlight = beginChatComposerSubmissionFlight(flight);
	if (!releaseFlight) return false;
	setInputLocked?.(true);
	try {
		const accepted = await submit();
		if (!accepted) return false;
		if (getCurrentThreadId() === threadId) await onAcceptedCurrentThread();
		return true;
	} finally {
		setInputLocked?.(false);
		releaseFlight();
	}
};
