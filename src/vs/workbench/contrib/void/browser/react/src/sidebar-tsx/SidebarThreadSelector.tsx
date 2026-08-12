/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { useMemo, useState } from 'react';
import { IconShell1 } from '../markdown/ApplyBlockHoverButtons.js';
import { useAccessor, useChatThreadsState, useFullChatThreadsStreamState, useVisibleThreadChildOverviews } from '../util/services.js';
import { Check, CircleAlert, Copy, LoaderCircle, MessageCircleQuestion, Trash2, X } from 'lucide-react';
import { ThreadType } from '../../../chatThreadService.js';
import { ChatHistoryThreadMetadata, getChatHistoryPresentation } from '../../../../common/chatHistoryPresentation.js';


const numInitialThreads = 3

export const PastThreadsList = ({ className = '' }: { className?: string }) => {
	const [showAll, setShowAll] = useState(false);

	const threadsState = useChatThreadsState()
	const streamState = useFullChatThreadsStreamState()
	const { allThreads, currentThreadId } = threadsState

	const metadata = useMemo(() => Object.values(allThreads).filter((thread): thread is ThreadType => !!thread).map(toMetadata), [allThreads]);
	const parentActivityById = useMemo(() => Object.fromEntries(Object.entries(streamState).map(([id, state]) => [id, { isRunning: state?.isRunning, hasError: !!state?.error }])), [streamState]);
	const orderedRows = useMemo(() => getChatHistoryPresentation(metadata, currentThreadId, parentActivityById, {}), [metadata, currentThreadId, parentActivityById]);
	const visibleThreadIds = (showAll ? orderedRows : orderedRows.slice(0, numInitialThreads)).map(row => row.id);
	const childOverviewById = useVisibleThreadChildOverviews(visibleThreadIds);
	const rows = useMemo(() => getChatHistoryPresentation(metadata, currentThreadId, parentActivityById, childOverviewById), [metadata, currentThreadId, parentActivityById, childOverviewById]);
	const displayRows = showAll ? rows : rows.slice(0, numInitialThreads);
	const hasMoreThreads = rows.length > numInitialThreads;

	return (
		<div className={`flex flex-col mb-2 gap-2 w-full text-nowrap text-void-fg-3 select-none relative ${className}`}>
			{displayRows.length === 0 ? <div className='p-1 text-sm'>No previous chats yet.</div> : displayRows.map(row => <PastThreadElement key={row.id} row={row} />)}

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

const DuplicateButton = ({ threadId }: { threadId: string }) => {
	const accessor = useAccessor()
	const chatThreadsService = accessor.get('IChatThreadService')
	return <IconShell1
		Icon={Copy}
		type='button'
		aria-label='Duplicate chat'
		title='Duplicate chat'
		className='focus-ring size-[11px]'
		onClick={() => { chatThreadsService.duplicateThread(threadId); }}
		data-tooltip-id='void-tooltip'
		data-tooltip-place='top'
		data-tooltip-content='Duplicate thread'
	>
	</IconShell1>

}

const TrashButton = ({ threadId }: { threadId: string }) => {

	const accessor = useAccessor()
	const chatThreadsService = accessor.get('IChatThreadService')


	const [isTrashPressed, setIsTrashPressed] = useState(false)

	return (isTrashPressed ?
		<div className='flex flex-nowrap text-nowrap gap-1'>
			<IconShell1
				Icon={X}
				type='button' aria-label='Cancel delete' title='Cancel delete' className='focus-ring size-[11px]'
				onClick={() => { setIsTrashPressed(false); }}
				data-tooltip-id='void-tooltip'
				data-tooltip-place='top'
				data-tooltip-content='Cancel'
			/>
			<IconShell1
				Icon={Check}
				type='button' aria-label='Confirm delete' title='Confirm delete' className='focus-ring size-[11px]'
				onClick={() => { chatThreadsService.deleteThread(threadId); setIsTrashPressed(false); }}
				data-tooltip-id='void-tooltip'
				data-tooltip-place='top'
				data-tooltip-content='Confirm'
			/>
		</div>
		: <IconShell1
			Icon={Trash2}
			type='button' aria-label='Delete chat' title='Delete chat' className='focus-ring size-[11px]'
			onClick={() => { setIsTrashPressed(true); }}
			data-tooltip-id='void-tooltip'
			data-tooltip-place='top'
			data-tooltip-content='Delete thread'
		/>
	)
}

const PastThreadElement = ({ row }: { row: ReturnType<typeof getChatHistoryPresentation>[number] }) => {


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
		<button type='button' className='focus-ring min-w-0 flex-1 text-left' aria-current={row.selected ? 'page' : undefined} aria-label={row.ariaLabel} onClick={() => chatThreadsService.switchToThread(row.id)}>
			<span className='flex items-center gap-2 min-w-0 overflow-hidden'><span className='truncate overflow-hidden text-ellipsis'>{row.title}</span>{row.selected ? <span className='text-xs'>Current</span> : null}</span>
			<span className='min-w-0 flex flex-wrap items-center gap-x-1 gap-y-0.5 whitespace-normal text-xs opacity-60'><span>{row.messageCount} {row.messageCount === 1 ? 'message' : 'messages'}</span><span>{formatDate(new Date(row.lastModified))}</span>{row.status ? <><span aria-hidden='true'>{statusIcon}</span><span>{row.status}</span></> : null}</span>
		</button>
		<div className='flex items-center gap-x-1'><DuplicateButton threadId={row.id} /><TrashButton threadId={row.id} /></div>
	</div>
}
