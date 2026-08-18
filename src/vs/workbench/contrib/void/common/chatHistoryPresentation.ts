/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

export type ChatHistoryThreadMetadata = Readonly<{ id: string; title: string; messageCount: number; lastModified: string }>;
export type ChatHistoryParentActivity = Readonly<{ isRunning?: 'LLM' | 'tool' | 'awaiting_user' | 'idle'; hasError?: boolean }>;
export type ChatHistoryChildOverview = Readonly<{ running: boolean; queued: boolean; actionRequired: boolean }>;
export type ChatHistoryChildRun = Readonly<{ status: string }>;
export type ChatHistoryChildDiagnostics = Readonly<{ events: readonly Readonly<{ kind: string; diagnostic?: string }>[] }>;
export type ChatHistoryStatus = 'Error' | 'Action required' | 'Needs approval' | 'Running' | 'Queued';
export type ChatHistoryRow = Readonly<{ id: string; title: string; messageCount: number; lastModified: string; selected: boolean; status?: ChatHistoryStatus; canDelete: boolean; ariaLabel: string }>;

export type ChatHistorySurface = 'landing' | 'current';

export const shouldShowPersistentChatHistory = (surface: ChatHistorySurface): boolean => surface === 'landing';

const statusFor = (parent: ChatHistoryParentActivity | undefined, child: ChatHistoryChildOverview | undefined): ChatHistoryStatus | undefined => {
	if (parent?.hasError) return 'Error';
	if (child?.actionRequired) return 'Action required';
	if (parent?.isRunning === 'awaiting_user') return 'Needs approval';
	if (parent?.isRunning === 'LLM' || parent?.isRunning === 'tool' || parent?.isRunning === 'idle' || child?.running) return 'Running';
	if (child?.queued) return 'Queued';
	return undefined;
};

/** List-only admission state: a stopped admission is cancellation, not an action request. */
export const hasActionRequiredChild = (runs: readonly ChatHistoryChildRun[], diagnostics: ChatHistoryChildDiagnostics | undefined): boolean =>
	runs.some(run => run.status === 'failed') || diagnostics?.events.some(event => event.kind === 'admission_failed' && event.diagnostic !== 'cancelled') === true;

export const getChatHistoryPresentation = (
	threads: readonly ChatHistoryThreadMetadata[],
	currentThreadId: string,
	parentActivityById: Readonly<Record<string, ChatHistoryParentActivity | undefined>>,
	childOverviewById: Readonly<Record<string, ChatHistoryChildOverview | undefined>>,
): readonly ChatHistoryRow[] => Object.freeze(
	threads
		.filter(thread => thread.messageCount > 0)
		.slice()
		.sort((left, right) => Date.parse(right.lastModified) - Date.parse(left.lastModified) || left.id.localeCompare(right.id))
		.map(thread => {
			const selected = thread.id === currentThreadId;
			const parentActivity = parentActivityById[thread.id];
			const childOverview = childOverviewById[thread.id];
			const status = statusFor(parentActivity, childOverview);
			const canDelete = !selected
				&& parentActivity?.isRunning === undefined
				&& childOverview?.running !== true
				&& childOverview?.queued !== true
				&& childOverview?.actionRequired !== true;
			const ariaLabel = `${thread.title}, ${thread.messageCount} messages, ${selected ? 'Current' : 'Previous chat'}${status ? `, ${status}` : ''}`;
			return Object.freeze({ ...thread, selected, ...(status ? { status } : {}), canDelete, ariaLabel });
		}),
);
