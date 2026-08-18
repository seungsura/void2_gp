/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import { ChatMessage } from './chatThreadServiceTypes.js';

export type AssistantMessagePresentation = Readonly<{
	renderDisplay: string;
	renderReasoning: string | null;
	hasReasoning: boolean;
	isDoneReasoning: boolean;
	isEmpty: boolean;
}>;

export const INTERNAL_EMPTY_MESSAGE_SENTINEL = '(empty message)';

export const sanitizeAssistantDisplayContent = (content: string, streaming = false): string => {
	if (content === INTERNAL_EMPTY_MESSAGE_SENTINEL) return '';
	if (streaming && INTERNAL_EMPTY_MESSAGE_SENTINEL.startsWith(content)) return '';
	return content;
};

export const assistantMessagePresentation = (
	message: Pick<ChatMessage & { role: 'assistant' }, 'displayContent' | 'reasoning'>,
	streaming = false,
): AssistantMessagePresentation => {
	const renderReasoning = message.reasoning?.trim() || null;
	const renderDisplay = sanitizeAssistantDisplayContent(message.displayContent, streaming);
	return Object.freeze({
		renderDisplay,
		renderReasoning,
		hasReasoning: !!renderReasoning,
		isDoneReasoning: !!renderDisplay,
		isEmpty: !renderDisplay && !message.reasoning,
	});
};
