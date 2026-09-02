/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { useEffect, useMemo, useRef, useState } from 'react';
import { IconShell1 } from '../markdown/ApplyBlockHoverButtons.js';
import { useAccessor, useChatThreadsState, useFullChatThreadsStreamState, useVisibleThreadChildOverviews } from '../util/services.js';
import { Check, CircleAlert, Copy, LoaderCircle, MessageCircleQuestion, Trash2, X } from 'lucide-react';
import { ThreadType } from '../../../chatThreadService.js';
import { ChatHistoryThreadMetadata, getChatHistoryPresentation } from '../../../../common/chatHistoryPresentation.js';


const numInitialThreads = 3

export const PastThreadsList = ({ className = '' }: { className?: string }) => {
	const [showAll, setShowAll] = useState(false);
	const listRef = useRef<HTMLDivElement>(null);
	const accessor = useAccessor();
	const chatThreadsService = accessor.get('IChatThreadService');
	const [pendingRevision, setPendingRevision] = useState(0);
	useEffect(() => { const disposable = chatThreadsService.onDidChangePendingChatInputs(() => setPendingRevision(revision => revision + 1)); return () => disposable.dispose(); }, [chatThreadsService]);

	const threadsState = useChatThreadsState()
	const streamState = useFullChatThreadsStreamState()
	const { allThreads, currentThreadId } = threadsState

	const metadata = useMemo(() => Object.values(allThreads).filter((thread): thread is ThreadType => !!thread).map(toMetadata), [allThreads]);
	const parentActivityById = useMemo(() => Object.fromEntries(Object.entries(streamState).map(([id, state]) => [id, { isRunning: state?.isRunning, hasError: !!state?.error }])), [streamState]);
	const pendingOverviewById = useMemo(() => Object.fromEntries(metadata.flatMap(({ id }) => {
		const records = chatThreadsService.getPendingChatInputs(id);
		if (records.length === 0) return [];
		return [[id, { count: records.length, latestCreatedAt: Math.max(...records.map(record => record.createdAt)), dormant: records.some(record => record.phase === 'dormant'), active: records.some(record => record.phase !== 'dormant') }]];
	})), [chatThreadsService, metadata, pendingRevision]);
	const orderedRows = useMemo(() => getChatHistoryPresentation(metadata, currentThreadId, parentActivityById, {}, pendingOverviewById), [metadata, currentThreadId, parentActivityById, pendingOverviewById]);
	const visibleThreadIds = (showAll ? orderedRows : orderedRows.slice(0, numInitialThreads)).map(row => row.id);
	const childOverviewById = useVisibleThreadChildOverviews(visibleThreadIds);
	const rows = useMemo(() => getChatHistoryPresentation(metadata, currentThreadId, parentActivityById, childOverviewById, pendingOverviewById), [metadata, currentThreadId, parentActivityById, childOverviewById, pendingOverviewById]);
	const displayRows = showAll ? rows : rows.slice(0, numInitialThreads);
	const hasMoreThreads = rows.length > numInitialThreads;
	const deleteThreadAndMoveFocus = async (threadId: string): Promise<boolean> => {
		const deletedIndex = displayRows.findIndex(row => row.id === threadId);
		const nextFocusId = displayRows[deletedIndex + 1]?.id ?? displayRows[deletedIndex - 1]?.id;
		if (!await chatThreadsService.deleteThread(threadId)) return false;
		requestAnimationFrame(() => {
			const list = listRef.current;
			if (!list) return;
			const nextRow = nextFocusId
				? Array.from(list.querySelectorAll<HTMLButtonElement>('button[data-chat-history-thread-id]')).find(button => button.dataset.chatHistoryThreadId === nextFocusId)
				: undefined;
			(nextRow ?? list).focus();
		});
		return true;
	};

	return (
		<div ref={listRef} role='group' aria-label='Chat history' tabIndex={-1} className={`focus-ring flex flex-col mb-2 gap-2 w-full text-nowrap text-void-fg-3 select-none relative ${className}`}>
			{displayRows.length === 0 ? <div className='p-1 text-sm'>No previous chats yet.</div> : displayRows.map((row, index) => <PastThreadElement key={row.id} row={row} position={index + 1} onConfirmDelete={deleteThreadAndMoveFocus} />)}

			{hasMoreThreads && !showAll && (
				<button type='button' aria-expanded={false} className="focus-ring text-left text-void-fg-3 opacity-80 hover:opacity-100 hover:brightness-115 p-1 text-xs" onClick={() => setShowAll(true)}>Show {rows.length - numInitialThreads} more...</button>
			)}
			{hasMoreThreads && showAll && (
				<button type='button' aria-expanded={true} className="focus-ring text-left text-void-fg-3 opacity-80 hover:opacity-100 hover:brightness-115 p-1 text-xs" onClick={() => setShowAll(false)}>Show less</button>
			)}
		</div>
	);
};





// Format date to display as today, yesterday, or date
const formatDate = (date: Date) => {
	const now = new Date();
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const yesterday = new Date(today);
	yesterday.setDate(yesterday.getDate() - 1);

	if (date >= today) {
		return 'Today';
	} else if (date >= yesterday) {
		return 'Yesterday';
	} else {
		return `${date.toLocaleString('default', { month: 'short' })} ${date.getDate()}`;
	}
};

const toMetadata = (thread: ThreadType): ChatHistoryThreadMetadata => {
	const firstUserMessage = thread.messages.find(message => message.role === 'user');
	const title = firstUserMessage?.role === 'user' ? firstUserMessage.displayContent || 'Untitled chat' : 'Untitled chat';
	return { id: thread.id, title, messageCount: thread.messages.filter(message => message.role === 'assistant' || message.role === 'user').length, lastModified: thread.lastModified };
};

const DuplicateButton = ({ threadId, chatTitle, position }: { threadId: string; chatTitle: string; position: number }) => {
	const accessor = useAccessor()
	const chatThreadsService = accessor.get('IChatThreadService')
	const accessibleName = `Duplicate chat: ${chatTitle}, row ${position}`;
	return <IconShell1
		Icon={Copy}
		type='button'
		aria-label={accessibleName}
		title={accessibleName}
		className='focus-ring size-[11px]'
		onClick={() => { chatThreadsService.duplicateThread(threadId); }}
		data-tooltip-id='void-tooltip'
		data-tooltip-place='top'
		data-tooltip-content={accessibleName}
	>
	</IconShell1>

}

const TrashButton = ({ threadId, chatTitle, position, onConfirmDelete }: { threadId: string; chatTitle: string; position: number; onConfirmDelete: (threadId: string) => Promise<boolean> }) => {
	const [isTrashPressed, setIsTrashPressed] = useState(false)
	const [isDeleting, setIsDeleting] = useState(false)
	const controlsRef = useRef<HTMLDivElement>(null)
	const focusAfterSwapRef = useRef(false)

	useEffect(() => {
		if (!focusAfterSwapRef.current) return;
		focusAfterSwapRef.current = false;
		controlsRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
	}, [isTrashPressed]);

	const swapControlsAndMoveFocus = (pressed: boolean) => {
		focusAfterSwapRef.current = true;
		setIsTrashPressed(pressed);
	};

	const deleteName = `Delete chat: ${chatTitle}, row ${position}`;
	const cancelName = `Cancel delete: ${chatTitle}, row ${position}`;
	const confirmName = `Confirm delete: ${chatTitle}, row ${position}`;

	return <div ref={controlsRef} className='flex flex-nowrap text-nowrap gap-1'>
		{isTrashPressed ? <>
			<IconShell1
				Icon={X}
				type='button' aria-label={cancelName} title={cancelName} className='focus-ring size-[11px]'
				onClick={() => { swapControlsAndMoveFocus(false); }}
				data-tooltip-id='void-tooltip'
				data-tooltip-place='top'
				data-tooltip-content={cancelName}
			/>
			<IconShell1
				Icon={Check}
				type='button' aria-label={confirmName} title={confirmName} className='focus-ring size-[11px]'
				disabled={isDeleting}
				onClick={() => { if (isDeleting) return; setIsDeleting(true); void onConfirmDelete(threadId).then(deleted => { if (!deleted) setIsDeleting(false) }, () => setIsDeleting(false)); }}
				data-tooltip-id='void-tooltip'
				data-tooltip-place='top'
				data-tooltip-content={confirmName}
			/>
		</> : <IconShell1
			Icon={Trash2}
			type='button' aria-label={deleteName} title={deleteName} className='focus-ring size-[11px]'
			onClick={() => { swapControlsAndMoveFocus(true); }}
			data-tooltip-id='void-tooltip'
			data-tooltip-place='top'
			data-tooltip-content={deleteName}
		/>
		}
	</div>
}

const PastThreadElement = ({ row, position, onConfirmDelete }: { row: ReturnType<typeof getChatHistoryPresentation>[number]; position: number; onConfirmDelete: (threadId: string) => Promise<boolean> }) => {


	const accessor = useAccessor()
	const chatThreadsService = accessor.get('IChatThreadService')

	// const settingsState = useSettingsState()
	// const convertService = accessor.get('IConvertToLLMMessageService')
	// const chatMode = settingsState.globalSettings.chatMode
	// const modelSelection = settingsState.modelSelectionOfFeature?.Chat ?? null
	// const copyChatButton = <CopyButton
	// 	codeStr={async () => {
	// 		const { messages } = await convertService.prepareLLMChatMessages({
	// 			chatMessages: currentThread.messages,
	// 			chatMode,
	// 			modelSelection,
	// 		})
	// 		return JSON.stringify(messages, null, 2)
	// 	}}
	// 	toolTipName={modelSelection === null ? 'Copy As Messages Payload' : `Copy As ${displayInfoOfProviderName(modelSelection.providerName).title} Payload`}
	// />


	// const currentThread = chatThreadsService.getCurrentThread()
	// const copyChatButton2 = <CopyButton
	// 	codeStr={async () => {
	// 		return JSON.stringify(currentThread.messages, null, 2)
	// 	}}
	// 	toolTipName={`Copy As Void Chat`}
	// />

	const statusIcon = row.status === 'Running' ? <LoaderCircle aria-hidden='true' className='animate-spin flex-shrink-0' size={14} /> : row.status === 'Needs approval' ? <MessageCircleQuestion aria-hidden='true' className='flex-shrink-0' size={14} /> : row.status === 'Error' || row.status === 'Action required' ? <CircleAlert aria-hidden='true' className='flex-shrink-0' size={14} /> : null;
	return <div className='flex items-center gap-1 py-1 px-2 rounded text-sm bg-zinc-700/5 hover:bg-zinc-700/10 dark:bg-zinc-300/5 dark:hover:bg-zinc-300/10 opacity-80 hover:opacity-100'>
		<button type='button' className='focus-ring min-w-0 flex-1 text-left' data-chat-history-thread-id={row.id} aria-current={row.selected ? 'page' : undefined} aria-label={row.ariaLabel} onClick={() => chatThreadsService.switchToThread(row.id)}>
			<span className='flex items-center gap-2 min-w-0 overflow-hidden'><span className='truncate overflow-hidden text-ellipsis'>{row.title}</span>{row.selected ? <span className='text-xs'>Current</span> : null}</span>
			<span className='min-w-0 flex flex-wrap items-center gap-x-1 gap-y-0.5 whitespace-normal text-xs opacity-60'><span>{row.messageCount} {row.messageCount === 1 ? 'message' : 'messages'}</span><span>{formatDate(new Date(row.lastModified))}</span>{row.status ? <><span aria-hidden='true'>{statusIcon}</span><span>{row.status}</span></> : null}</span>
		</button>
		<div className='flex items-center gap-x-1'>{row.messageCount > 0 ? <DuplicateButton threadId={row.id} chatTitle={row.title} position={position} /> : null}{row.canDelete ? <TrashButton threadId={row.id} chatTitle={row.title} position={position} onConfirmDelete={onConfirmDelete} /> : null}</div>
	</div>
}
