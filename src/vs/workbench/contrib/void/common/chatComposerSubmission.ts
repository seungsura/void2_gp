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
	clearSubmittedState: (threadId: string) => void;
	getCurrentThreadId: () => string;
	clearCurrentInput: () => void;
}) => {
	const receipt = submit();
	if ('then' in receipt) {
		const admitted = await receipt;
		if (!admitted) return false;
		clearSubmittedState(threadId);
		if (getCurrentThreadId() === threadId) clearCurrentInput();
		return true;
	}
	if (!receipt.accepted) return false;
	clearSubmittedState(threadId);
	if (getCurrentThreadId() === threadId) clearCurrentInput();
	return receipt.settled;
};
