/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { ButtonHTMLAttributes, FormEvent, FormHTMLAttributes, Fragment, KeyboardEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';


import { useAccessor, useAgentSubagentLiveSnapshot, useChatThreadsState, useChatThreadsStreamState, usePendingChatInputs, usePendingChatSubmission, useSettingsState, useActiveURI, useChildToolApprovals, useCommandBarState } from '../util/services.js';
import { ScrollType } from '../../../../../../../editor/common/editorCommon.js';

import { ChatMarkdownRender, ChatMessageLocation, getApplyBoxId } from '../markdown/ChatMarkdownRender.js';
import { URI } from '../../../../../../../base/common/uri.js';
import { extractEditorsDropData } from '../../../../../../../platform/dnd/browser/dnd.js';
import { IDisposable } from '../../../../../../../base/common/lifecycle.js';
import { ErrorDisplay } from './ErrorDisplay.js';
import { BlockCode, TextAreaFns, VoidInputBox2, VoidSlider, VoidSwitch } from '../util/inputs.js';
import { ModelDropdown, } from '../void-settings-tsx/ModelDropdown.js';
import { PastThreadsList } from './SidebarThreadSelector.js';
import { VOID_CTRL_L_ACTION_ID } from '../../../actionIDs.js';
import { VOID_OPEN_SETTINGS_ACTION_ID } from '../../../voidSettingsPane.js';
import { displayInfoOfProviderName, FeatureName, isFeatureNameDisabled } from '../../../../../../../workbench/contrib/void/common/voidSettingsTypes.js';
import { ICommandService } from '../../../../../../../platform/commands/common/commands.js';
import { WarningBox } from '../void-settings-tsx/WarningBox.js';
import { getModelCapabilities, getIsReasoningEnabledState } from '../../../../common/modelCapabilities.js';
import { AlertTriangle, File, Ban, Check, ChevronRight, Dot, FileIcon, Pencil, Undo, Undo2, X, Flag, Copy as CopyIcon, Info, CirclePlus, Ellipsis, CircleEllipsis, Folder, ALargeSmall, TypeOutline, Text } from 'lucide-react';
import { ChatMessage, StagingSelectionItem, ToolMessage } from '../../../../common/chatThreadServiceTypes.js';
import { AgentSubagentRunView, ChildActivitiesLedger, ChildActivityRecord, ChildToolApprovalView, isActiveChildRun } from '../../../../common/agentSubagents.js';
import { ChatCurrentStatusPresentation, getChatCurrentStatusPresentation } from '../../../../common/chatCurrentStatusPresentation.js';
import { beginChatComposerSubmissionFlight, submitChatComposer, submitInlineChatEdit } from '../../../../common/chatComposerSubmission.js';
import { PendingChatInput, PendingInputMode } from '../../../chatThreadService.js';
import { approvalTypeOfBuiltinToolName, BuiltinToolCallParams, BuiltinToolName, ToolName, LintErrorItem, ToolApprovalType, toolApprovalTypes } from '../../../../common/toolsServiceTypes.js';
import { CopyButton, IconShell1, JumpToFileButton, JumpToTerminalButton, StatusIndicator, useApplyStreamState } from '../markdown/ApplyBlockHoverButtons.js';
import { acceptAllBg, acceptBorder, buttonFontSize, buttonTextColor, rejectAllBg, rejectBg, rejectBorder } from '../../../../common/helpers/colors.js';
import { builtinToolNames, isABuiltinToolName, MAX_TERMINAL_INACTIVE_TIME } from '../../../../common/prompt/prompts.js';
import ErrorBoundary from './ErrorBoundary.js';
import { ToolApprovalTypeSwitch } from '../void-settings-tsx/Settings.js';

import { persistentTerminalNameOfId } from '../../../terminalToolService.js';
import { removeMCPToolNamePrefix } from '../../../../common/mcpServiceTypes.js';
import { applicationToolPresentation, applicationToolRoute, shouldOfferGenericToolApproval } from '../../../../common/applicationToolPresentation.js';
import { assistantMessagePresentation } from '../../../../common/assistantMessagePresentation.js';
import { shouldShowPersistentChatHistory } from '../../../../common/chatHistoryPresentation.js';
import { pendingChatInputFingerprint, pendingChatInputThreadFingerprint } from '../../../../common/pendingChatInputBroker.js';



export const IconX = ({ size, className = '', ...props }: { size: number, className?: string } & React.SVGProps<SVGSVGElement>) => {
	return (
		<svg
			xmlns='http://www.w3.org/2000/svg'
			width={size}
			height={size}
			viewBox='0 0 24 24'
			fill='none'
			stroke='currentColor'
			className={className}
			{...props}
		>
			<path
				strokeLinecap='round'
				strokeLinejoin='round'
				d='M6 18 18 6M6 6l12 12'
			/>
		</svg>
	);
};

const IconArrowUp = ({ size, className = '' }: { size: number, className?: string }) => {
	return (
		<svg
			width={size}
			height={size}
			className={className}
			viewBox="0 0 20 20"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
		>
			<path
				fill="black"
				fillRule="evenodd"
				clipRule="evenodd"
				d="M5.293 9.707a1 1 0 010-1.414l4-4a1 1 0 011.414 0l4 4a1 1 0 01-1.414 1.414L11 7.414V15a1 1 0 11-2 0V7.414L6.707 9.707a1 1 0 01-1.414 0z"
			></path>
		</svg>
	);
};


const IconSquare = ({ size, className = '' }: { size: number, className?: string }) => {
	return (
		<svg
			className={className}
			stroke="black"
			fill="black"
			strokeWidth="0"
			viewBox="0 0 24 24"
			width={size}
			height={size}
			xmlns="http://www.w3.org/2000/svg"
		>
			<rect x="2" y="2" width="20" height="20" rx="4" ry="4" />
		</svg>
	);
};


export const IconWarning = ({ size, className = '' }: { size: number, className?: string }) => {
	return (
		<svg
			className={className}
			stroke="currentColor"
			fill="currentColor"
			strokeWidth="0"
			viewBox="0 0 16 16"
			width={size}
			height={size}
			xmlns="http://www.w3.org/2000/svg"
		>
			<path
				fillRule="evenodd"
				clipRule="evenodd"
				d="M7.56 1h.88l6.54 12.26-.44.74H1.44L1 13.26 7.56 1zM8 2.28L2.28 13H13.7L8 2.28zM8.625 12v-1h-1.25v1h1.25zm-1.25-2V6h1.25v4h-1.25z"
			/>
		</svg>
	);
};


export const IconLoading = ({ className = '' }: { className?: string }) => {

	const [loadingText, setLoadingText] = useState('.');

	useEffect(() => {
		let intervalId;

		// Function to handle the animation
		const toggleLoadingText = () => {
			if (loadingText === '...') {
				setLoadingText('.');
			} else {
				setLoadingText(loadingText + '.');
			}
		};

		// Start the animation loop
		intervalId = setInterval(toggleLoadingText, 300);

		// Cleanup function to clear the interval when component unmounts
		return () => clearInterval(intervalId);
	}, [loadingText, setLoadingText]);

	return <div className={`${className}`}>{loadingText}</div>;

}



// SLIDER ONLY:
const ReasoningOptionSlider = ({ featureName }: { featureName: FeatureName }) => {
	const accessor = useAccessor()

	const voidSettingsService = accessor.get('IVoidSettingsService')
	const voidSettingsState = useSettingsState()

	const modelSelection = voidSettingsState.modelSelectionOfFeature[featureName]
	const overridesOfModel = voidSettingsState.overridesOfModel

	if (!modelSelection) return null

	const { modelName, providerName } = modelSelection
	const { reasoningCapabilities } = getModelCapabilities(providerName, modelName, overridesOfModel)
	const { canTurnOffReasoning, reasoningSlider: reasoningBudgetSlider } = reasoningCapabilities || {}

	const modelSelectionOptions = voidSettingsState.optionsOfModelSelection[featureName][providerName]?.[modelName]
	const isReasoningEnabled = getIsReasoningEnabledState(featureName, providerName, modelName, modelSelectionOptions, overridesOfModel)

	if (canTurnOffReasoning && !reasoningBudgetSlider) { // if it's just a on/off toggle without a power slider
		return <div className='flex items-center gap-x-2'>
			<span className='text-void-fg-3 text-xs pointer-events-none inline-block w-10 pr-1'>Thinking</span>
			<span onClick={(event) => event.stopPropagation()}>
				<VoidSwitch
					ariaLabel={`Thinking for ${featureName}`}
					size='xxs'
					value={isReasoningEnabled}
					onChange={(newVal) => {
						const isOff = canTurnOffReasoning && !newVal
						voidSettingsService.setOptionsOfModelSelection(featureName, modelSelection.providerName, modelSelection.modelName, { reasoningEnabled: !isOff })
					}}
				/>
			</span>
		</div>
	}

	if (reasoningBudgetSlider?.type === 'budget_slider') { // if it's a slider
		const { min: min_, max, default: defaultVal } = reasoningBudgetSlider

		const nSteps = 8 // only used in calculating stepSize, stepSize is what actually matters
		const stepSize = Math.round((max - min_) / nSteps)

		const valueIfOff = min_ - stepSize
		const min = canTurnOffReasoning ? valueIfOff : min_
		const value = isReasoningEnabled ? voidSettingsState.optionsOfModelSelection[featureName][modelSelection.providerName]?.[modelSelection.modelName]?.reasoningBudget ?? defaultVal
			: valueIfOff

		return <div className='flex items-center gap-x-2'>
			<span className='text-void-fg-3 text-xs pointer-events-none inline-block w-10 pr-1'>Thinking</span>
			<VoidSlider
				width={50}
				size='xs'
				min={min}
				max={max}
				step={stepSize}
				value={value}
				onChange={(newVal) => {
					const isOff = canTurnOffReasoning && newVal === valueIfOff
					voidSettingsService.setOptionsOfModelSelection(featureName, modelSelection.providerName, modelSelection.modelName, { reasoningEnabled: !isOff, reasoningBudget: newVal })
				}}
			/>
			<span className='text-void-fg-3 text-xs pointer-events-none'>{isReasoningEnabled ? `${value} tokens` : 'Thinking disabled'}</span>
		</div>
	}

	if (reasoningBudgetSlider?.type === 'effort_slider') {

		const { values, default: defaultVal } = reasoningBudgetSlider

		const min = canTurnOffReasoning ? -1 : 0
		const max = values.length - 1

		const currentEffort = voidSettingsState.optionsOfModelSelection[featureName][modelSelection.providerName]?.[modelSelection.modelName]?.reasoningEffort ?? defaultVal
		const valueIfOff = -1
		const value = isReasoningEnabled && currentEffort ? values.indexOf(currentEffort) : valueIfOff

		const currentEffortCapitalized = currentEffort.charAt(0).toUpperCase() + currentEffort.slice(1, Infinity)

		return <div className='flex items-center gap-x-2'>
			<span className='text-void-fg-3 text-xs pointer-events-none inline-block w-10 pr-1'>Thinking</span>
			<VoidSlider
				width={30}
				size='xs'
				min={min}
				max={max}
				step={1}
				value={value}
				onChange={(newVal) => {
					const isOff = canTurnOffReasoning && newVal === valueIfOff
					voidSettingsService.setOptionsOfModelSelection(featureName, modelSelection.providerName, modelSelection.modelName, { reasoningEnabled: !isOff, reasoningEffort: values[newVal] ?? undefined })
				}}
			/>
			<span className='text-void-fg-3 text-xs pointer-events-none'>{isReasoningEnabled ? `${currentEffortCapitalized}` : 'Thinking disabled'}</span>
		</div>
	}

	return null
}



interface VoidChatAreaProps {
	// Required
	children: React.ReactNode; // This will be the input component

	// Form controls
	onSubmit: () => void;
	onAbort: () => void;
	isStreaming: boolean;
	isDisabled?: boolean;
	divRef?: React.RefObject<HTMLDivElement | null>;

	// UI customization
	className?: string;
	showModelDropdown?: boolean;
	showSelections?: boolean;
	showProspectiveSelections?: boolean;
	loadingIcon?: React.ReactNode;
	statusHelp?: React.ReactNode;
	/** Replaces only this area's normal Send/Stop control for an opt-in consumer. */
	actionSlot?: React.ReactNode;
	showStop?: boolean;
	controlSemantics?: ChatCurrentStatusPresentation['controls'];

	selections?: StagingSelectionItem[]
	setSelections?: (s: StagingSelectionItem[]) => void
	/** Locks only this area's selection editor while an exact async submission owns it. */
	selectionsDisabled?: boolean
	// selections?: any[];
	// onSelectionsChange?: (selections: any[]) => void;

	onClickAnywhere?: () => void;
	// Optional close button
	onClose?: () => void;

	featureName: FeatureName;
}

export const VoidChatArea: React.FC<VoidChatAreaProps> = ({
	children,
	onSubmit,
	onAbort,
	onClose,
	onClickAnywhere,
	divRef,
	isStreaming = false,
	isDisabled = false,
	className = '',
	showModelDropdown = true,
	showSelections = false,
	showProspectiveSelections = false,
	selections,
	setSelections,
	selectionsDisabled = false,
	featureName,
	loadingIcon,
	statusHelp,
	actionSlot,
	showStop,
	controlSemantics,
}) => {
	const shouldShowStop = showStop ?? isStreaming;

	const accessor = useAccessor();
	const chatThreadsService = accessor.get('IChatThreadService');
	const fileService = accessor.get('IFileService');
	const languageService = accessor.get('ILanguageService');

	const [isDraggingOver, setIsDraggingOver] = useState(false);
	const dragCounterRef = useRef(0);

	const handleDragEnter = useCallback((e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		dragCounterRef.current += 1;
		setIsDraggingOver(true);
	}, []);

	const handleDragOver = useCallback((e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		e.dataTransfer.dropEffect = 'copy';
		if (!isDraggingOver) {
			setIsDraggingOver(true);
		}
	}, [isDraggingOver]);

	const handleDragLeave = useCallback((e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		dragCounterRef.current -= 1;
		if (dragCounterRef.current <= 0) {
			dragCounterRef.current = 0;
			setIsDraggingOver(false);
		}
	}, []);

	const handleDrop = useCallback(async (e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		dragCounterRef.current = 0;
		setIsDraggingOver(false);

		let editors = extractEditorsDropData(e.nativeEvent);

		// Fallback: extract directly if extractEditorsDropData returned empty
		if (!editors || editors.length === 0) {
			const fallbackEditors: { resource: URI }[] = [];
			try {
				const rawResources = e.dataTransfer.getData('ResourceURLs');
				if (rawResources) {
					const parsed: string[] = JSON.parse(rawResources);
					for (const p of parsed) {
						fallbackEditors.push({ resource: URI.parse(p) });
					}
				}
			} catch { }

			if (fallbackEditors.length === 0 && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
				for (let i = 0; i < e.dataTransfer.files.length; i++) {
					const f = e.dataTransfer.files[i];
					const p = (f as any).path;
					if (p) {
						fallbackEditors.push({ resource: URI.file(p) });
					}
				}
			}
			editors = fallbackEditors;
		}

		if (!editors || editors.length === 0) return;

		for (const editor of editors) {
			if (!editor.resource) continue;
			const uri = editor.resource;

			let newSelection: StagingSelectionItem;
			try {
				const stat = await fileService.stat(uri);
				if (stat.isDirectory) {
					newSelection = {
						type: 'Folder',
						uri: uri,
						language: undefined,
						state: undefined,
					};
				} else {
					newSelection = {
						type: 'File',
						uri: uri,
						language: languageService.guessLanguageIdByFilepathOrFirstLine(uri) || '',
						state: { wasAddedAsCurrentFile: false },
					};
				}
			} catch {
				newSelection = {
					type: 'File',
					uri: uri,
					language: languageService.guessLanguageIdByFilepathOrFirstLine(uri) || '',
					state: { wasAddedAsCurrentFile: false },
				};
			}

			if (setSelections && selections) {
				const itemKey = `${newSelection.type}:${newSelection.uri.toString()}`;
				const existingIdx = selections.findIndex(s => {
					if (s.type === 'File' || s.type === 'Folder' || s.type === 'CodeSelection') {
						return `${s.type}:${s.uri.toString()}` === itemKey;
					}
					return false;
				});

				if (existingIdx !== -1) {
					const next = [...selections];
					next[existingIdx] = newSelection;
					setSelections(next);
				} else {
					setSelections([...selections, newSelection]);
				}
			} else {
				chatThreadsService.addNewStagingSelection(newSelection);
			}
		}
	}, [extractEditorsDropData, fileService, languageService, setSelections, selections, chatThreadsService]);

	return (
		<div
			ref={divRef}
			className={`
				gap-x-1
                flex flex-col p-2 relative input text-left shrink-0
                rounded-md
                bg-void-bg-1
				transition-all duration-200
				border ${isDraggingOver ? 'border-void-border-1 ring-1 ring-void-border-1' : 'border-void-border-3 focus-within:border-void-border-1 hover:border-void-border-1'}
				max-h-[80vh] overflow-y-auto
                ${className}
            `}
			onClick={(e) => {
				onClickAnywhere?.()
			}}
			onDragEnter={handleDragEnter}
			onDragOver={handleDragOver}
			onDragLeave={handleDragLeave}
			onDrop={handleDrop}
		>
			{isDraggingOver && (
				<div className="absolute inset-0 z-50 rounded-md bg-void-bg-1/90 backdrop-blur-[1px] border-2 border-dashed border-void-border-1 flex flex-col items-center justify-center pointer-events-none transition-all duration-150">
					<CirclePlus size={24} className="text-void-fg-1 mb-1 animate-pulse" />
					<span className="text-xs font-medium text-void-fg-1">Drop files or folders to add</span>
				</div>
			)}
			{/* Selections section */}
			{showSelections && selections && setSelections && (
				<div aria-disabled={selectionsDisabled} className={selectionsDisabled ? 'pointer-events-none opacity-70' : undefined}>
					<SelectedFiles
						type='staging'
						selections={selections}
						setSelections={selectionsDisabled ? () => { } : setSelections}
						showProspectiveSelections={showProspectiveSelections}
					/>
				</div>
			)}

			{/* Input section */}
			<div className="relative w-full">
				{children}

				{/* Close button (X) if onClose is provided */}
				{onClose && (
					<div className='absolute -top-1 -right-1 cursor-pointer z-1'>
						<IconX
							size={12}
							className="stroke-[2] opacity-80 text-void-fg-3 hover:brightness-95"
							onClick={onClose}
						/>
					</div>
				)}
			</div>

			{statusHelp}

			{/* Bottom row */}
			<div className='flex flex-row justify-between items-end gap-1'>
				{showModelDropdown && (
					<div className='flex flex-col gap-y-1'>
						<ReasoningOptionSlider featureName={featureName} />

						<div className='flex items-center flex-wrap gap-x-2 gap-y-1 text-nowrap '>
							<ModelDropdown featureName={featureName} className='text-xs text-void-fg-3 bg-void-bg-1 rounded' />
						</div>
					</div>
				)}

				<div className="flex items-center gap-2">

					{isStreaming && loadingIcon}

					{actionSlot !== undefined ? actionSlot : shouldShowStop ? (
						<ButtonStop
							className={controlSemantics ? 'focus-ring' : ''}
							id={controlSemantics?.stop.id}
							aria-label={controlSemantics?.stop.ariaLabel}
							title={controlSemantics?.stop.title}
							onClick={onAbort}
						/>
					) : (
						<ButtonSubmit
							className={controlSemantics ? 'focus-ring' : ''}
							id={controlSemantics?.send.id}
							aria-label={controlSemantics?.send.ariaLabel}
							title={controlSemantics?.send.title}
							onClick={onSubmit}
							disabled={isDisabled}
						/>
					)}
				</div>

			</div>
		</div>
	);
};




type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement>
const DEFAULT_BUTTON_SIZE = 22;
export const ButtonSubmit = ({ className, disabled, 'aria-label': ariaLabel = 'Send message', title = ariaLabel, ...props }: ButtonProps & Required<Pick<ButtonProps, 'disabled'>>) => {

	return <button
		type='button'
		disabled={disabled}
		aria-label={ariaLabel}
		title={title}
		className={`rounded-full flex-shrink-0 flex-grow-0 flex items-center justify-center
			${disabled ? 'bg-vscode-disabled-fg cursor-default' : 'bg-white cursor-pointer'}
			${className}
		`}
		// data-tooltip-id='void-tooltip'
		// data-tooltip-content={'Send'}
		// data-tooltip-place='left'
		{...props}
	>
		<IconArrowUp size={DEFAULT_BUTTON_SIZE} className="stroke-[2] p-[2px]" />
	</button>
}

export const ButtonStop = ({ className, 'aria-label': ariaLabel = 'Stop response', title = ariaLabel, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => {
	return <button
		aria-label={ariaLabel}
		title={title}
		className={`rounded-full flex-shrink-0 flex-grow-0 cursor-pointer flex items-center justify-center
			bg-white
			${className}
		`}
		type='button'
		{...props}
	>
		<IconSquare size={DEFAULT_BUTTON_SIZE} className="stroke-[3] p-[7px]" />
	</button>
}



const scrollToBottom = (divRef: { current: HTMLElement | null }) => {
	if (divRef.current) {
		divRef.current.scrollTop = divRef.current.scrollHeight;
	}
};



const ScrollToBottomContainer = ({ children, className, style, scrollContainerRef }: { children: React.ReactNode, className?: string, style?: React.CSSProperties, scrollContainerRef: React.MutableRefObject<HTMLDivElement | null> }) => {
	const [isAtBottom, setIsAtBottom] = useState(true); // Start at bottom

	const divRef = scrollContainerRef

	const onScroll = () => {
		const div = divRef.current;
		if (!div) return;

		const isBottom = Math.abs(
			div.scrollHeight - div.clientHeight - div.scrollTop
		) < 4;

		setIsAtBottom(isBottom);
	};

	// When children change (new messages added)
	useEffect(() => {
		if (isAtBottom) {
			scrollToBottom(divRef);
		}
	}, [children, isAtBottom]); // Dependency on children to detect new messages

	// Initial scroll to bottom
	useEffect(() => {
		scrollToBottom(divRef);
	}, []);

	return (
		<div
			ref={divRef}
			onScroll={onScroll}
			className={className}
			style={style}
		>
			{children}
		</div>
	);
};

export const getRelative = (uri: URI, accessor: ReturnType<typeof useAccessor>) => {
	const workspaceContextService = accessor.get('IWorkspaceContextService')
	let path: string
	const isInside = workspaceContextService.isInsideWorkspace(uri)
	if (isInside) {
		const f = workspaceContextService.getWorkspace().folders.find(f => uri.fsPath?.startsWith(f.uri.fsPath))
		if (f) { path = uri.fsPath.replace(f.uri.fsPath, '') }
		else { path = uri.fsPath }
	}
	else {
		path = uri.fsPath
	}
	return path || undefined
}

export const getFolderName = (pathStr: string) => {
	// 'unixify' path
	pathStr = pathStr.replace(/[/\\]+/g, '/') // replace any / or \ or \\ with /
	const parts = pathStr.split('/') // split on /
	// Filter out empty parts (the last element will be empty if path ends with /)
	const nonEmptyParts = parts.filter(part => part.length > 0)
	if (nonEmptyParts.length === 0) return '/' // Root directory
	if (nonEmptyParts.length === 1) return nonEmptyParts[0] + '/' // Only one folder
	// Get the last two parts
	const lastTwo = nonEmptyParts.slice(-2)
	return lastTwo.join('/') + '/'
}

export const getBasename = (pathStr: string, parts: number = 1) => {
	// 'unixify' path
	pathStr = pathStr.replace(/[/\\]+/g, '/') // replace any / or \ or \\ with /
	const allParts = pathStr.split('/') // split on /
	if (allParts.length === 0) return pathStr
	return allParts.slice(-parts).join('/')
}



// Open file utility function
export const voidOpenFileFn = (
	uri: URI,
	accessor: ReturnType<typeof useAccessor>,
	range?: [number, number]
) => {
	const commandService = accessor.get('ICommandService')
	const editorService = accessor.get('ICodeEditorService')

	// Get editor selection from CodeSelection range
	let editorSelection = undefined;

	// If we have a selection, create an editor selection from the range
	if (range) {
		editorSelection = {
			startLineNumber: range[0],
			startColumn: 1,
			endLineNumber: range[1],
			endColumn: Number.MAX_SAFE_INTEGER,
		};
	}

	// open the file
	commandService.executeCommand('vscode.open', uri).then(() => {

		// select the text
		setTimeout(() => {
			if (!editorSelection) return;

			const editor = editorService.getActiveCodeEditor()
			if (!editor) return;

			editor.setSelection(editorSelection)
			editor.revealRange(editorSelection, ScrollType.Immediate)

		}, 50) // needed when document was just opened and needs to initialize

	})

};


export const SelectedFiles = (
	{ type, selections, setSelections, showProspectiveSelections, messageIdx, }:
		| { type: 'past', selections: StagingSelectionItem[]; setSelections?: undefined, showProspectiveSelections?: undefined, messageIdx: number, }
		| { type: 'staging', selections: StagingSelectionItem[]; setSelections: ((newSelections: StagingSelectionItem[]) => void), showProspectiveSelections?: boolean, messageIdx?: number }
) => {

	const accessor = useAccessor()
	const commandService = accessor.get('ICommandService')
	const modelReferenceService = accessor.get('IVoidModelService')




	// state for tracking prospective files
	const { uri: currentURI } = useActiveURI()
	const [recentUris, setRecentUris] = useState<URI[]>([])
	const maxRecentUris = 10
	const maxProspectiveFiles = 3
	useEffect(() => { // handle recent files
		if (!currentURI) return
		setRecentUris(prev => {
			const withoutCurrent = prev.filter(uri => uri.fsPath !== currentURI.fsPath) // remove duplicates
			const withCurrent = [currentURI, ...withoutCurrent]
			return withCurrent.slice(0, maxRecentUris)
		})
	}, [currentURI])
	const [prospectiveSelections, setProspectiveSelections] = useState<StagingSelectionItem[]>([])


	// handle prospective files
	useEffect(() => {
		const computeRecents = async () => {
			const prospectiveURIs = recentUris
				.filter(uri => !selections.find(s => s.type === 'File' && s.uri.fsPath === uri.fsPath))
				.slice(0, maxProspectiveFiles)

			const answer: StagingSelectionItem[] = []
			for (const uri of prospectiveURIs) {
				answer.push({
					type: 'File',
					uri: uri,
					language: (await modelReferenceService.getModelSafe(uri)).model?.getLanguageId() || 'plaintext',
					state: { wasAddedAsCurrentFile: false },
				})
			}
			return answer
		}

		// add a prospective file if type === 'staging' and if the user is in a file, and if the file is not selected yet
		if (type === 'staging' && showProspectiveSelections) {
			computeRecents().then((a) => setProspectiveSelections(a))
		}
		else {
			setProspectiveSelections([])
		}
	}, [recentUris, selections, type, showProspectiveSelections])


	const allSelections = [...selections, ...prospectiveSelections]

	if (allSelections.length === 0) {
		return null
	}

	return (
		<div className='flex items-center flex-wrap text-left relative gap-x-0.5 gap-y-1 pb-0.5'>

			{allSelections.map((selection, i) => {

				const isThisSelectionProspective = i > selections.length - 1

				const thisKey = selection.type === 'CodeSelection' ? selection.type + selection.language + selection.range + selection.state.wasAddedAsCurrentFile + selection.uri.fsPath
					: selection.type === 'File' ? selection.type + selection.language + selection.state.wasAddedAsCurrentFile + selection.uri.fsPath
						: selection.type === 'Folder' ? selection.type + selection.language + selection.state + selection.uri.fsPath
							: selection.type === 'Skill' ? selection.type + selection.identity + selection.catalogRevision
								: selection.type + selection.label

				const SelectionIcon = (
					selection.type === 'File' ? File
						: selection.type === 'Folder' ? Folder
							: selection.type === 'CodeSelection' ? Text
								: File
				)

				return <div // container for summarybox and code
					key={thisKey}
					className={`flex flex-col space-y-[1px]`}
				>
					{/* tooltip for file path */}
					<span className="truncate overflow-hidden text-ellipsis"
						data-tooltip-id='void-tooltip'
						data-tooltip-content={selection.type === 'Skill' ? selection.identity : selection.type === 'Agent' ? selection.agentType ?? 'Agent' : getRelative(selection.uri, accessor)}
						data-tooltip-place='top'
						data-tooltip-delay-show={3000}
					>
						{/* summarybox */}
						<div
							className={`
								flex items-center gap-1 relative
								px-1
								w-fit h-fit
								select-none
								text-xs text-nowrap
								border rounded-sm
								${isThisSelectionProspective ? 'bg-void-bg-1 text-void-fg-3 opacity-80' : 'bg-void-bg-1 hover:brightness-95 text-void-fg-1'}
								${isThisSelectionProspective
									? 'border-void-border-2'
									: 'border-void-border-1'
								}
								hover:border-void-border-1
								transition-all duration-150
							`}
							onClick={() => {
								if (type !== 'staging') return; // (never)
								if (isThisSelectionProspective) { // add prospective selection to selections
									setSelections([...selections, selection])
								}
								else if (selection.type === 'File') { // open files
									voidOpenFileFn(selection.uri, accessor);

									const wasAddedAsCurrentFile = selection.state.wasAddedAsCurrentFile
									if (wasAddedAsCurrentFile) {
										// make it so the file is added permanently, not just as the current file
										const newSelection: StagingSelectionItem = { ...selection, state: { ...selection.state, wasAddedAsCurrentFile: false } }
										setSelections([
											...selections.slice(0, i),
											newSelection,
											...selections.slice(i + 1)
										])
									}
								}
								else if (selection.type === 'CodeSelection') {
									voidOpenFileFn(selection.uri, accessor, selection.range);
								}
								else if (selection.type === 'Folder') {
									// TODO!!! reveal in tree
								}
							}}
						>
							{<SelectionIcon size={10} />}

							{selection.type === 'Skill' ? selection.identity : selection.type === 'Agent' ? selection.agentType ?? 'Agent' : getBasename(selection.uri.fsPath) + (selection.type === 'CodeSelection' ? ` (${selection.range[0]}-${selection.range[1]})` : '')}

							{selection.type === 'File' && selection.state.wasAddedAsCurrentFile && messageIdx === undefined && currentURI?.fsPath === selection.uri.fsPath ?
								<span className={`text-[8px] 'void-opacity-60 text-void-fg-4`}>
									{`(Current File)`}
								</span>
								: null
							}

							{type === 'staging' && !isThisSelectionProspective ? // X button
								<div // box for making it easier to click
									className='cursor-pointer z-1 self-stretch flex items-center justify-center'
									onClick={(e) => {
										e.stopPropagation(); // don't open/close selection
										if (type !== 'staging') return;
										setSelections([...selections.slice(0, i), ...selections.slice(i + 1)])
									}}
								>
									<IconX
										className='stroke-[2]'
										size={10}
									/>
								</div>
								: <></>
							}
						</div>
					</span>
				</div>

			})}
			{type === 'staging' && selections.some(selection => selection.type === 'Agent') ? <div className='basis-full text-xs text-void-fg-3 pt-1'>Agent delegation is explicit: this requests delegation, but does not start a child. The parent decides whether and when to delegate.</div> : null}


		</div>

	)
}


type ToolHeaderParams = {
	icon?: React.ReactNode;
	title: React.ReactNode;
	desc1: React.ReactNode;
	desc1OnClick?: () => void;
	desc2?: React.ReactNode;
	isError?: boolean;
	info?: string;
	desc1Info?: string;
	isRejected?: boolean;
	numResults?: number;
	hasNextPage?: boolean;
	children?: React.ReactNode;
	bottomChildren?: React.ReactNode;
	onClick?: () => void;
	onToggle?: () => void;
	desc2OnClick?: () => void;
	isOpen?: boolean;
	className?: string;
	/** Always-visible active duration; unlike desc1Info this is never tooltip-only. */
	elapsed?: string;
	rightAction?: React.ReactNode;
}

const ToolHeaderWrapper = ({
	icon,
	title,
	desc1,
	desc1OnClick,
	desc1Info,
	desc2,
	numResults,
	hasNextPage,
	children,
	info,
	bottomChildren,
	isError,
	onClick,
	onToggle,
	desc2OnClick,
	isOpen,
	isRejected,
	className, // applies to the main content
	elapsed,
	rightAction,
}: ToolHeaderParams) => {

	const [isOpen_, setIsOpen] = useState(false);
	const isExpanded = isOpen !== undefined ? isOpen : isOpen_
	const childrenId = useId()

	const isDropdown = children !== undefined // null ALLOWS dropdown
	const canToggleDropdown = isDropdown && (isOpen === undefined || onToggle !== undefined)
	const disclosureLabel = `${isExpanded ? 'Hide' : 'Show'} details for ${typeof title === 'string' ? title : 'tool'}`

	const isDesc1Clickable = !!desc1OnClick

	const desc1ClassName = `text-void-fg-4 text-xs italic truncate ml-2
		${isDesc1Clickable ? 'cursor-pointer hover:brightness-125 transition-all duration-150 void-focus-ring' : ''}
	`
	const desc1HTML = isDesc1Clickable ? <button
		type="button"
		className={desc1ClassName}
		onClick={desc1OnClick}
		{...desc1Info ? {
			'data-tooltip-id': 'void-tooltip',
			'data-tooltip-content': desc1Info,
			'data-tooltip-place': 'top',
			'data-tooltip-delay-show': 1000,
		} : {}}
	>{desc1}</button> : <span
		className='text-void-fg-4 text-xs italic truncate ml-2'
		{...desc1Info ? {
			'data-tooltip-id': 'void-tooltip',
			'data-tooltip-content': desc1Info,
			'data-tooltip-place': 'top',
			'data-tooltip-delay-show': 1000,
		} : {}}
	>{desc1}</span>

	return (<div className=''>
		<div className={`w-full border border-void-border-3 rounded px-2 py-1 bg-void-bg-3 overflow-hidden ${className}`}>
			{/* header */}
			<div className={`select-none flex items-center min-h-[24px]`}>
				<div className={`flex items-center w-full gap-x-2 overflow-hidden justify-between ${isRejected ? 'line-through' : ''}`}>
					<div className='ml-1 flex items-center min-w-0 overflow-hidden'>
						{isDropdown && (canToggleDropdown ? <button
							type="button"
							className='flex items-center min-w-0 overflow-hidden cursor-pointer hover:brightness-125 transition-all duration-150 focus-ring'
							onClick={() => onToggle ? onToggle() : setIsOpen(v => !v)}
							aria-expanded={isExpanded}
							aria-controls={childrenId}
							aria-label={disclosureLabel}
						>
							<ChevronRight
								className={`
								text-void-fg-3 mr-0.5 h-4 w-4 flex-shrink-0 transition-transform duration-100 ease-[cubic-bezier(0.4,0,0.2,1)]
								${isExpanded ? 'rotate-90' : ''}
							`}
							/>
							{!onClick && <span className="text-void-fg-3 flex-shrink-0">{title}</span>}
						</button> : <ChevronRight
							className={`
							text-void-fg-3 mr-0.5 h-4 w-4 flex-shrink-0
							${isExpanded ? 'rotate-90' : ''}
						`}
						/>)}
						{onClick ? <button
							type="button"
							className='text-void-fg-3 flex-shrink-0 cursor-pointer hover:brightness-125 transition-all duration-150 focus-ring'
							onClick={onClick}
						>
							{title}
						</button> : (!isDropdown || !canToggleDropdown) && <span className="text-void-fg-3 flex-shrink-0">{title}</span>}
						{!isDesc1Clickable && desc1HTML}
						{isDesc1Clickable && desc1HTML}
					</div>

					{/* right */}
					<div className="flex items-center gap-x-2 flex-shrink-0">

						{info && <CircleEllipsis
							className='ml-2 text-void-fg-4 opacity-60 flex-shrink-0'
							size={14}
							data-tooltip-id='void-tooltip'
							data-tooltip-content={info}
							data-tooltip-place='top-end'
						/>}

						{isError && <AlertTriangle
							className='text-void-warning opacity-90 flex-shrink-0'
							size={14}
							data-tooltip-id='void-tooltip'
							data-tooltip-content={'Error running tool'}
							data-tooltip-place='top'
						/>}
						{isRejected && <Ban
							className='text-void-fg-4 opacity-90 flex-shrink-0'
							size={14}
							data-tooltip-id='void-tooltip'
							data-tooltip-content={'Canceled'}
							data-tooltip-place='top'
						/>}
						{elapsed && <span data-testid='void-tool-elapsed' className="text-void-fg-4 text-xs whitespace-nowrap">{elapsed}</span>}
						{desc2 && (desc2OnClick ? <button type="button" className="text-void-fg-4 text-xs focus-ring" onClick={desc2OnClick}>{desc2}</button> : <span className="text-void-fg-4 text-xs">{desc2}</span>)}
						{numResults !== undefined && (
							<span className="text-void-fg-4 text-xs ml-auto mr-1">
								{`${numResults}${hasNextPage ? '+' : ''} result${numResults !== 1 ? 's' : ''}`}
							</span>
						)}
						{rightAction}
					</div>
				</div>
			</div>
			{/* children */}
			{isDropdown && <div
				id={childrenId}
				hidden={!isExpanded}
				className='py-1 text-void-fg-4 rounded-sm overflow-x-auto'
			>
				{children}
			</div>}
		</div>
		{bottomChildren}
	</div>);
};



const WriteFileTool = ({ toolMessage }: Parameters<ResultWrapper<'write_file'>>[0]) => {
	const accessor = useAccessor()
	const isError = toolMessage.type === 'tool_error'
	const isRejected = toolMessage.type === 'rejected'
	const title = getTitle(toolMessage)
	const { desc1, desc1Info } = toolNameToDesc('write_file', toolMessage.params, accessor)
	const params = toolMessage.params
	const componentParams: ToolHeaderParams = { title, desc1, desc1OnClick: () => voidOpenFileFn(params.uri, accessor), desc1Info, isError, icon: null, isRejected }
	const preview = params.operation === 'create'
		? { operation: 'create', content: params.content }
		: { operation: 'modify', edits: params.edits }
	componentParams.children = <ToolChildrenWrapper className='bg-void-bg-3'><CodeChildren>{JSON.stringify(preview, null, 2)}</CodeChildren></ToolChildrenWrapper>
	if (toolMessage.type === 'success') componentParams.bottomChildren = <BottomChildren title='Result'><CodeChildren>{JSON.stringify(toolMessage.result)}</CodeChildren></BottomChildren>
	if (toolMessage.type === 'tool_error') componentParams.bottomChildren = <BottomChildren title='Error'><CodeChildren>{toolMessage.result}</CodeChildren></BottomChildren>
	return <ToolHeaderWrapper {...componentParams} />
}

const SimplifiedToolHeader = ({
	title,
	children,
}: {
	title: string;
	children?: React.ReactNode;
}) => {
	const [isOpen, setIsOpen] = useState(false);
	const isDropdown = children !== undefined;
	return (
		<div>
			<div className="w-full">
				{/* header */}
				<div
					className={`select-none flex items-center min-h-[24px] ${isDropdown ? 'cursor-pointer' : ''}`}
					onClick={() => {
						if (isDropdown) { setIsOpen(v => !v); }
					}}
				>
					{isDropdown && (
						<ChevronRight
							className={`text-void-fg-3 mr-0.5 h-4 w-4 flex-shrink-0 transition-transform duration-100 ease-[cubic-bezier(0.4,0,0.2,1)] ${isOpen ? 'rotate-90' : ''}`}
						/>
					)}
					<div className="flex items-center w-full overflow-hidden">
						<span className="text-void-fg-3">{title}</span>
					</div>
				</div>
				{/* children */}
				{<div
					className={`overflow-hidden transition-all duration-200 ease-in-out ${isOpen ? 'opacity-100' : 'max-h-0 opacity-0'} text-void-fg-4`}
				>
					{children}
				</div>}
			</div>
		</div>
	);
};




const UserMessageComponent = ({ chatMessage, messageIdx, _scrollToBottom, editable = true }: { chatMessage: ChatMessage & { role: 'user' }, messageIdx: number, _scrollToBottom: (() => void) | null, editable?: boolean }) => {

	const accessor = useAccessor()
	const chatThreadsService = accessor.get('IChatThreadService')

	// global state
	let isBeingEdited = false
	let stagingSelections: StagingSelectionItem[] = []
	let setIsBeingEdited = (_: boolean) => { }
	let setStagingSelections = (_: StagingSelectionItem[]) => { }

	if (editable && messageIdx !== undefined) {
		const _state = chatThreadsService.getCurrentMessageState(messageIdx)
		isBeingEdited = _state.isBeingEdited
		stagingSelections = _state.stagingSelections
		setIsBeingEdited = (v) => chatThreadsService.setCurrentMessageState(messageIdx, { isBeingEdited: v })
		setStagingSelections = (s) => chatThreadsService.setCurrentMessageState(messageIdx, { stagingSelections: s })
	}


	// local state
	const mode: ChatBubbleMode = isBeingEdited ? 'edit' : 'display'
	const [isFocused, setIsFocused] = useState(false)
	const [isHovered, setIsHovered] = useState(false)
	const [isDisabled, setIsDisabled] = useState(false)
	const [isEditSubmissionInFlight, setIsEditSubmissionInFlight] = useState(false)
	const [textAreaRefState, setTextAreaRef] = useState<HTMLTextAreaElement | null>(null)
	const textAreaFnsRef = useRef<TextAreaFns | null>(null)
	const editSubmissionFlight = useRef(false)
	// initialize on first render, and when edit was just enabled
	const _mustInitialize = useRef(true)
	const _justEnabledEdit = useRef(false)
	useEffect(() => {
		const canInitialize = mode === 'edit' && textAreaRefState
		const shouldInitialize = _justEnabledEdit.current || _mustInitialize.current
		if (canInitialize && shouldInitialize) {
			setStagingSelections(
				(chatMessage.selections || []).map(s => { // quick hack so we dont have to do anything more
					if (s.type === 'File') return { ...s, state: { ...s.state, wasAddedAsCurrentFile: false, } }
					else return s
				})
			)

			if (textAreaFnsRef.current)
				textAreaFnsRef.current.setValue(chatMessage.displayContent || '')

			textAreaRefState.focus();

			_justEnabledEdit.current = false
			_mustInitialize.current = false
		}

	}, [chatMessage, mode, _justEnabledEdit, textAreaRefState, textAreaFnsRef.current, _justEnabledEdit.current, _mustInitialize.current])

	const onOpenEdit = () => {
		setIsBeingEdited(true)
		chatThreadsService.setCurrentlyFocusedMessageIdx(messageIdx)
		_justEnabledEdit.current = true
	}
	const onCloseEdit = () => {
		setIsFocused(false)
		setIsHovered(false)
		setIsBeingEdited(false)
		chatThreadsService.setCurrentlyFocusedMessageIdx(undefined)

	}

	const EditSymbol = mode === 'display' ? Pencil : X


	let chatbubbleContents: React.ReactNode
	if (mode === 'display') {
		chatbubbleContents = <>
			<SelectedFiles type='past' messageIdx={messageIdx} selections={chatMessage.selections || []} />
			<span className='px-0.5'>{chatMessage.displayContent}</span>
		</>
	}
	else if (mode === 'edit') {

		const onSubmit = async () => {

			if (isDisabled || editSubmissionFlight.current) return;
			if (!textAreaRefState) return;
			if (messageIdx === undefined) return;
			// cancel any streams on this thread
			const threadId = chatThreadsService.state.currentThreadId
			const userMessage = textAreaRefState.value
			try {
				await submitInlineChatEdit({
					flight: editSubmissionFlight,
					threadId,
					submit: async () => {
						await chatThreadsService.abortRunning(threadId)
						return chatThreadsService.editUserMessageAndStreamResponse({ userMessage, messageIdx, threadId })
					},
					getCurrentThreadId: () => chatThreadsService.state.currentThreadId,
					setInputLocked: locked => {
						setIsEditSubmissionInFlight(locked)
						if (locked) textAreaFnsRef.current?.disable()
						else textAreaFnsRef.current?.enable()
					},
					onAcceptedCurrentThread: async () => {
						await chatThreadsService.focusCurrentChat()
						requestAnimationFrame(() => _scrollToBottom?.())
					},
				})
			} catch (e) {
				console.error('Error while editing message:', e)
				return
			}
		}

		const onAbort = async () => {
			const threadId = chatThreadsService.state.currentThreadId
			await chatThreadsService.abortRunning(threadId)
		}

		const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
			if (editSubmissionFlight.current) return
			if (e.key === 'Escape') {
				onCloseEdit()
			}
			if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
				onSubmit()
			}
		}

		if (!chatMessage.content) { // don't show if empty and not loading (if loading, want to show).
			return null
		}

		chatbubbleContents = <VoidChatArea
			featureName='Chat'
			onSubmit={onSubmit}
			onAbort={onAbort}
			isStreaming={false}
			isDisabled={isDisabled || isEditSubmissionInFlight}
			showSelections={true}
			showProspectiveSelections={false}
			selections={stagingSelections}
			setSelections={setStagingSelections}
			selectionsDisabled={isEditSubmissionInFlight}
		>
			<VoidInputBox2
				enableAtToMention
				ref={setTextAreaRef}
				className='min-h-[81px] max-h-[500px] px-0.5'
				placeholder="Edit your message..."
				onChangeText={(text) => { if (!editSubmissionFlight.current) setIsDisabled(!text) }}
				onFocus={() => {
					setIsFocused(true)
					chatThreadsService.setCurrentlyFocusedMessageIdx(messageIdx);
				}}
				onBlur={() => {
					setIsFocused(false)
				}}
				onKeyDown={onKeyDown}
				fnsRef={textAreaFnsRef}
				multiline={true}
			/>
		</VoidChatArea>
	}

	return <div
		// align chatbubble accoridng to role
		className={`
        relative ml-auto
        ${mode === 'edit' ? 'w-full max-w-full'
				: mode === 'display' ? `self-end w-fit max-w-full whitespace-pre-wrap` : '' // user words should be pre
			}

    `}
		onMouseEnter={() => setIsHovered(true)}
		onMouseLeave={() => setIsHovered(false)}
	>
		<div
			// style chatbubble according to role
			className={`
            text-left rounded-lg max-w-full
            ${mode === 'edit' ? ''
					: mode === 'display' ? 'p-2 flex flex-col bg-void-bg-1 text-void-fg-1 overflow-x-auto cursor-pointer' : ''
				}
        `}
			onClick={() => { if (mode === 'display') { onOpenEdit() } }}
		>
			{chatbubbleContents}
		</div>



		<div
			className="absolute -top-1 -right-1 translate-x-0 -translate-y-0 z-1"
		// data-tooltip-id='void-tooltip'
		// data-tooltip-content='Edit message'
		// data-tooltip-place='left'
		>
			<EditSymbol
				size={18}
				className={`
                    cursor-pointer
                    p-[2px]
                    bg-void-bg-1 border border-void-border-1 rounded-md
                    transition-opacity duration-200 ease-in-out
                    ${isHovered || (isFocused && mode === 'edit') ? 'opacity-100' : 'opacity-0'}
                `}
				onClick={() => {
					if (mode === 'display') {
						onOpenEdit()
					} else if (mode === 'edit') {
						onCloseEdit()
					}
				}}
			/>
		</div>


	</div>

}

const SmallProseWrapper = ({ children }: { children: React.ReactNode }) => {
	return <div className='
text-void-fg-4
prose
prose-sm
break-words
max-w-none
leading-snug
text-[13px]

[&>:first-child]:!mt-0
[&>:last-child]:!mb-0

prose-h1:text-[14px]
prose-h1:my-4

prose-h2:text-[13px]
prose-h2:my-4

prose-h3:text-[13px]
prose-h3:my-3

prose-h4:text-[13px]
prose-h4:my-2

prose-p:my-2
prose-p:leading-snug
prose-hr:my-2

prose-ul:my-2
prose-ul:pl-4
prose-ul:list-outside
prose-ul:list-disc
prose-ul:leading-snug


prose-ol:my-2
prose-ol:pl-4
prose-ol:list-outside
prose-ol:list-decimal
prose-ol:leading-snug

marker:text-inherit

prose-blockquote:pl-2
prose-blockquote:my-2

prose-code:text-void-fg-3
prose-code:text-[12px]
prose-code:before:content-none
prose-code:after:content-none

prose-pre:text-[12px]
prose-pre:p-2
prose-pre:my-2

prose-table:text-[13px]
'>
		{children}
	</div>
}

const ProseWrapper = ({ children }: { children: React.ReactNode }) => {
	return <div className='
text-void-fg-2
prose
prose-sm
break-words
prose-p:block
prose-hr:my-4
prose-pre:my-2
marker:text-inherit
prose-ol:list-outside
prose-ol:list-decimal
prose-ul:list-outside
prose-ul:list-disc
prose-li:my-0
prose-code:before:content-none
prose-code:after:content-none
prose-headings:prose-sm
prose-headings:font-bold

prose-p:leading-normal
prose-ol:leading-normal
prose-ul:leading-normal

max-w-none
'
	>
		{children}
	</div>
}
const AssistantMessageComponent = ({ chatMessage, isCommitted, messageIdx }: { chatMessage: ChatMessage & { role: 'assistant' }, messageIdx: number, isCommitted: boolean }) => {

	const accessor = useAccessor()
	const chatThreadsService = accessor.get('IChatThreadService')

	const { renderDisplay, renderReasoning, hasReasoning, isDoneReasoning, isEmpty } = assistantMessagePresentation(chatMessage, !isCommitted)
	const thread = chatThreadsService.getCurrentThread()


	const chatMessageLocation: ChatMessageLocation = {
		threadId: thread.id,
		messageIdx: messageIdx,
	}

	if (isEmpty) return null

	return <>
		{/* reasoning token */}
		{hasReasoning &&
			<div>
				<ReasoningWrapper isDoneReasoning={isDoneReasoning} isStreaming={!isCommitted}>
					<SmallProseWrapper>
						<ChatMarkdownRender
							string={renderReasoning ?? ''}
							chatMessageLocation={chatMessageLocation}
							isApplyEnabled={false}
							isLinkDetectionEnabled={true}
						/>
					</SmallProseWrapper>
				</ReasoningWrapper>
			</div>
		}

		{/* assistant message */}
		{renderDisplay &&
			<div>
				<ProseWrapper>
					<ChatMarkdownRender
						string={renderDisplay}
						chatMessageLocation={chatMessageLocation}
						isApplyEnabled={true}
						isLinkDetectionEnabled={true}
					/>
				</ProseWrapper>
			</div>
		}
	</>

}

const ReasoningWrapper = ({ isDoneReasoning, isStreaming, children }: { isDoneReasoning: boolean, isStreaming: boolean, children: React.ReactNode }) => {
	const isDone = isDoneReasoning || !isStreaming
	const isWriting = !isDone
	const [isOpen, setIsOpen] = useState(isWriting)
	useEffect(() => {
		if (!isWriting) setIsOpen(false) // if just finished reasoning, close
	}, [isWriting])
	return <ToolHeaderWrapper title='Reasoning' desc1={isWriting ? <IconLoading /> : ''} isOpen={isOpen} onToggle={() => setIsOpen(v => !v)}>
		<ToolChildrenWrapper>
			<div className='!select-text cursor-auto'>
				{children}
			</div>
		</ToolChildrenWrapper>
	</ToolHeaderWrapper>
}




// should either be past or "-ing" tense, not present tense. Eg. when the LLM searches for something, the user expects it to say "I searched for X" or "I am searching for X". Not "I search X".

const loadingTitleWrapper = (item: React.ReactNode): React.ReactNode => {
	return <span className='flex items-center flex-nowrap'>
		{item}
		<IconLoading className='w-3 text-sm' />
	</span>
}

const titleOfBuiltinToolName = {
	'read_file': { done: 'Read file', proposed: 'Read file', running: loadingTitleWrapper('Reading file') },
	'ls_dir': { done: 'Inspected folder', proposed: 'Inspect folder', running: loadingTitleWrapper('Inspecting folder') },
	'get_dir_tree': { done: 'Inspected folder tree', proposed: 'Inspect folder tree', running: loadingTitleWrapper('Inspecting folder tree') },
	'search_pathnames_only': { done: 'Searched by file name', proposed: 'Search by file name', running: loadingTitleWrapper('Searching by file name') },
	'search_for_files': { done: 'Searched', proposed: 'Search', running: loadingTitleWrapper('Searching') },
	'create_file_or_folder': { done: `Created`, proposed: `Create`, running: loadingTitleWrapper(`Creating`) },
	'delete_file_or_folder': { done: `Deleted`, proposed: `Delete`, running: loadingTitleWrapper(`Deleting`) },
	'write_file': { done: `Wrote file`, proposed: 'Write file', running: loadingTitleWrapper('Writing file') },
	'run_command': { done: `Ran terminal`, proposed: 'Run terminal', running: loadingTitleWrapper('Running terminal') },
	'run_persistent_command': { done: `Ran terminal`, proposed: 'Run terminal', running: loadingTitleWrapper('Running terminal') },

	'open_persistent_terminal': { done: `Opened terminal`, proposed: 'Open terminal', running: loadingTitleWrapper('Opening terminal') },
	'kill_persistent_terminal': { done: `Killed terminal`, proposed: 'Kill terminal', running: loadingTitleWrapper('Killing terminal') },

	'read_lint_errors': { done: `Read lint errors`, proposed: 'Read lint errors', running: loadingTitleWrapper('Reading lint errors') },
	'search_in_file': { done: 'Searched in file', proposed: 'Search in file', running: loadingTitleWrapper('Searching in file') },
} as const satisfies Record<BuiltinToolName, { done: any, proposed: any, running: any }>


const getTitle = (toolMessage: Pick<ChatMessage & { role: 'tool' }, 'name' | 'type' | 'mcpServerName'>): React.ReactNode => {
	const t = toolMessage
	const route = applicationToolRoute(t.name, builtinToolNames.includes(t.name as BuiltinToolName))

	// Builtins own their exact presentation before reserved application names.
	if (route === 'builtin') {
		const toolName = t.name as BuiltinToolName
		if (t.type === 'success') return titleOfBuiltinToolName[toolName].done
		if (t.type === 'running_now') return titleOfBuiltinToolName[toolName].running
		return titleOfBuiltinToolName[toolName].proposed
	}
	const application = route === 'application' ? applicationToolPresentation(t.name, t.type, undefined) : undefined
	if (application) return t.type === 'running_now' || t.type === 'tool_request' ? loadingTitleWrapper(application.title) : application.title

	// All remaining names are actual MCP presentation.
	{
		// descriptor of Running or Ran etc
		const descriptor =
			t.type === 'success' ? 'Called'
				: t.type === 'running_now' ? 'Calling'
					: t.type === 'tool_request' ? 'Call'
						: t.type === 'rejected' ? 'Call'
							: t.type === 'invalid_params' ? 'Call'
								: t.type === 'tool_error' ? 'Call'
									: 'Call'


		const title = `${descriptor} ${toolMessage.mcpServerName || 'MCP'}`
		if (t.type === 'running_now' || t.type === 'tool_request')
			return loadingTitleWrapper(title)
		return title
	}

}


const toolNameToDesc = (toolName: BuiltinToolName, _toolParams: BuiltinToolCallParams[BuiltinToolName] | undefined, accessor: ReturnType<typeof useAccessor>): {
	desc1: React.ReactNode,
	desc1Info?: string,
} => {

	if (!_toolParams) {
		return { desc1: '', };
	}

	const x = {
		'read_file': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['read_file']
			return {
				desc1: getBasename(toolParams.uri.fsPath),
				desc1Info: getRelative(toolParams.uri, accessor),
			};
		},
		'ls_dir': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['ls_dir']
			return {
				desc1: getFolderName(toolParams.uri.fsPath),
				desc1Info: getRelative(toolParams.uri, accessor),
			};
		},
		'search_pathnames_only': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['search_pathnames_only']
			return {
				desc1: `"${toolParams.query}"`,
			}
		},
		'search_for_files': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['search_for_files']
			return {
				desc1: `"${toolParams.query}"`,
			}
		},
		'search_in_file': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['search_in_file'];
			return {
				desc1: `"${toolParams.query}"`,
				desc1Info: getRelative(toolParams.uri, accessor),
			};
		},
		'create_file_or_folder': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['create_file_or_folder']
			return {
				desc1: toolParams.isFolder ? getFolderName(toolParams.uri.fsPath) ?? '/' : getBasename(toolParams.uri.fsPath),
				desc1Info: getRelative(toolParams.uri, accessor),
			}
		},
		'delete_file_or_folder': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['delete_file_or_folder']
			return {
				desc1: toolParams.isFolder ? getFolderName(toolParams.uri.fsPath) ?? '/' : getBasename(toolParams.uri.fsPath),
				desc1Info: getRelative(toolParams.uri, accessor),
			}
		},
		'write_file': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['write_file']
			return {
				desc1: getBasename(toolParams.uri.fsPath),
				desc1Info: getRelative(toolParams.uri, accessor),
			}
		},
		'run_command': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['run_command']
			return {
				desc1: `"${toolParams.command}"`,
			}
		},
		'run_persistent_command': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['run_persistent_command']
			return {
				desc1: `"${toolParams.command}"`,
			}
		},
		'open_persistent_terminal': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['open_persistent_terminal']
			return { desc1: '' }
		},
		'kill_persistent_terminal': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['kill_persistent_terminal']
			return { desc1: toolParams.persistentTerminalId }
		},
		'get_dir_tree': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['get_dir_tree']
			return {
				desc1: getFolderName(toolParams.uri.fsPath) ?? '/',
				desc1Info: getRelative(toolParams.uri, accessor),
			}
		},
		'read_lint_errors': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['read_lint_errors']
			return {
				desc1: getBasename(toolParams.uri.fsPath),
				desc1Info: getRelative(toolParams.uri, accessor),
			}
		}
	}

	try {
		return x[toolName]?.() || { desc1: '' }
	}
	catch {
		return { desc1: '' }
	}
}

const ToolRequestAcceptRejectButtons = ({ toolName }: { toolName: ToolName }) => {
	const accessor = useAccessor()
	const chatThreadsService = accessor.get('IChatThreadService')
	const metricsService = accessor.get('IMetricsService')
	const voidSettingsService = accessor.get('IVoidSettingsService')
	const voidSettingsState = useSettingsState()

	const onAccept = useCallback(() => {
		try { // this doesn't need to be wrapped in try/catch anymore
			const threadId = chatThreadsService.state.currentThreadId
			void chatThreadsService.approveLatestToolRequest(threadId).catch(() => undefined)
			metricsService.capture('Tool Request Accepted', {})
		} catch (e) { console.error('Error while approving message in chat:', e) }
	}, [chatThreadsService, metricsService])

	const onReject = useCallback(() => {
		try {
			const threadId = chatThreadsService.state.currentThreadId
			void chatThreadsService.rejectLatestToolRequest(threadId).catch(() => undefined)
		} catch (e) { console.error('Error while approving message in chat:', e) }
		metricsService.capture('Tool Request Rejected', {})
	}, [chatThreadsService, metricsService])

	const approveButton = (
		<button
			type='button'
			aria-label={`Approve ${toolName} tool request`}
			title={`Approve ${toolName} tool request`}
			onClick={onAccept}
			className={`
                px-2 py-1
                bg-[var(--vscode-button-background)]
                text-[var(--vscode-button-foreground)]
                hover:bg-[var(--vscode-button-hoverBackground)]
                rounded
                text-sm font-medium
                focus-ring
            `}
		>
			Approve
		</button>
	)

	const cancelButton = (
		<button
			type='button'
			aria-label={`Reject ${toolName} tool request`}
			title={`Reject ${toolName} tool request`}
			onClick={onReject}
			className={`
                px-2 py-1
                bg-[var(--vscode-button-secondaryBackground)]
                text-[var(--vscode-button-secondaryForeground)]
                hover:bg-[var(--vscode-button-secondaryHoverBackground)]
                rounded
                text-sm font-medium
                focus-ring
            `}
		>
			Cancel
		</button>
	)

	const approvalType = isABuiltinToolName(toolName) ? approvalTypeOfBuiltinToolName[toolName] : 'MCP tools'
	const approvalToggle = approvalType ? <div key={approvalType} className="flex items-center ml-2 gap-x-1">
		<ToolApprovalTypeSwitch size='xs' approvalType={approvalType} desc={`Auto-approve ${approvalType}`} />
	</div> : null

	return <div className="flex gap-2 mx-0.5 items-center">
		{approveButton}
		{cancelButton}
		{approvalToggle}
	</div>
}

export const ToolChildrenWrapper = ({ children, className }: { children: React.ReactNode, className?: string }) => {
	return <div className={`${className ? className : ''} cursor-default select-none`}>
		<div className='px-2 min-w-full overflow-hidden'>
			{children}
		</div>
	</div>
}
export const CodeChildren = ({ children, className }: { children: React.ReactNode, className?: string }) => {
	return <div className={`${className ?? ''} p-1 rounded-sm overflow-auto text-sm`}>
		<div className='!select-text cursor-auto'>
			{children}
		</div>
	</div>
}

export const ListableToolItem = ({ name, onClick, isSmall, className, showDot, ariaLabel }: { name: React.ReactNode, onClick?: () => void, isSmall?: boolean, className?: string, showDot?: boolean, ariaLabel?: string }) => {
	const children = <>
		{showDot === false ? null : <span className="flex-shrink-0"><svg className="w-1 h-1 opacity-60 mr-1.5 fill-current" viewBox="0 0 100 40"><rect x="0" y="15" width="100" height="10" /></svg></span>}
		<span className={`${isSmall ? 'italic text-void-fg-4 flex items-center' : ''}`}>{name}</span>
	</>
	const classes = `
		${onClick ? 'hover:brightness-125 hover:cursor-pointer transition-all duration-200 ' : ''}
		flex items-center flex-nowrap whitespace-nowrap
		${className ? className : ''}
		`

	if (onClick) return <button
		type='button'
		className={`${classes} focus-ring appearance-none border-0 bg-transparent p-0 text-left text-inherit`}
		onClick={onClick}
		aria-label={ariaLabel}
		title={ariaLabel}
	>
		{children}
	</button>

	return <div className={classes}>{children}</div>
}



const LintErrorChildren = ({ lintErrors }: { lintErrors: LintErrorItem[] }) => {
	return <div className="text-xs text-void-fg-4 opacity-80 border-l-2 border-void-warning px-2 py-0.5 flex flex-col gap-0.5 overflow-x-auto whitespace-nowrap">
		{lintErrors.map((error, i) => (
			<div key={i}>Lines {error.startLineNumber}-{error.endLineNumber}: {error.message}</div>
		))}
	</div>
}

const BottomChildren = ({ children, title }: { children: React.ReactNode, title: string }) => {
	const [isOpen, setIsOpen] = useState(false);
	const childrenId = useId();
	if (!children) return null;
	return (
		<div className="w-full px-2 mt-0.5">
			<button
				type="button"
				className="flex items-center cursor-pointer select-none transition-colors duration-150 pl-0 py-0.5 rounded group focus-ring"
				onClick={() => setIsOpen(o => !o)}
				aria-expanded={isOpen}
				aria-controls={childrenId}
				aria-label={`${isOpen ? 'Hide' : 'Show'} ${title} details`}
				style={{ background: 'none' }}
			>
				<ChevronRight
					className={`mr-1 h-3 w-3 flex-shrink-0 transition-transform duration-100 text-void-fg-4 group-hover:text-void-fg-3 ${isOpen ? 'rotate-90' : ''}`}
				/>
				<span className="font-medium text-void-fg-4 group-hover:text-void-fg-3 text-xs">{title}</span>
			</button>
			<div
				id={childrenId}
				hidden={!isOpen}
				className="text-xs pl-4"
			>
				<div className="overflow-x-auto text-void-fg-4 opacity-90 border-l-2 border-void-warning px-2 py-0.5">
					{children}
				</div>
			</div>
		</div>
	);
}



const InvalidTool = ({ toolName, message, mcpServerName }: { toolName: ToolName, message: string, mcpServerName: string | undefined }) => {
	const title = getTitle({ name: toolName, type: 'invalid_params', mcpServerName })
	const application = applicationToolPresentation(toolName, 'invalid_params', undefined, message)
	const desc1 = application?.status ?? 'Invalid parameters'
	const icon = null
	const isError = true
	const componentParams: ToolHeaderParams = { title, desc1, isError, icon }

	componentParams.children = <ToolChildrenWrapper>
		<CodeChildren className='bg-void-bg-3'>
			{application?.error ?? message}
		</CodeChildren>
	</ToolChildrenWrapper>
	return <ToolHeaderWrapper {...componentParams} />
}

const CanceledTool = ({ toolName, mcpServerName }: { toolName: ToolName, mcpServerName: string | undefined }) => {
	const title = getTitle({ name: toolName, type: 'rejected', mcpServerName })
	const desc1 = applicationToolPresentation(toolName, 'interrupted_streaming_tool', undefined)?.status ?? ''
	const icon = null
	const isRejected = true
	const componentParams: ToolHeaderParams = { title, desc1, icon, isRejected }
	return <ToolHeaderWrapper {...componentParams} />
}

/** Refresh only active cards; terminal history never acquires a timer. */
const useLiveElapsed = (startedAt: number | undefined, active: boolean): string | undefined => {
	const [now, setNow] = useState(() => Date.now())
	useEffect(() => {
		if (!active) return
		setNow(Date.now())
		const interval = window.setInterval(() => setNow(Date.now()), 1000)
		return () => window.clearInterval(interval)
	}, [active, startedAt])
	if (!active || startedAt === undefined) return undefined
	const seconds = Math.max(0, Math.floor((now - startedAt) / 1000))
	return seconds >= 60 ? `Elapsed ${Math.floor(seconds / 60)}m ${seconds % 60}s` : `Elapsed ${seconds}s`
}

/** A card Stop is intentionally narrower than the composer Stop: the service validates
 * this opaque receipt against its exact live row before it invokes any interrupt. */
const ToolCardStop = ({ threadId, toolMessage }: { threadId: string; toolMessage: Extract<ToolMessage<ToolName>, { type: 'running_now' }> }) => {
	const chatThreadsService = useAccessor().get('IChatThreadService')
	const isCancelling = toolMessage.lifecycle === 'cancelling'
	const canStop = !isCancelling && !!toolMessage.receiptId && toolMessage.cardStopAvailable === true
	const reason = isCancelling
		? 'Waiting for this tool to stop.'
		: toolMessage.cardStopUnavailableReason ?? 'This live tool does not expose an independent cancellation handle.'
	return <ButtonStop
		data-testid='void-tool-card-stop'
		className='h-5 w-5 !rounded-sm disabled:cursor-default disabled:opacity-50'
		aria-label={canStop ? 'Stop this tool' : isCancelling ? 'Cancelling this tool' : 'Tool Stop unavailable'}
		title={canStop ? 'Stop this tool' : reason}
		disabled={!canStop}
		onClick={event => {
			event.stopPropagation()
			if (canStop && toolMessage.receiptId) chatThreadsService.cancelToolReceipt(threadId, toolMessage.receiptId, toolMessage.id)
		}}
	/>
}

const CommandTool = ({ toolMessage, type, threadId }: { threadId: string } & ({
	toolMessage: Exclude<ToolMessage<'run_command'>, { type: 'invalid_params' }>
	type: 'run_command'
} | {
	toolMessage: Exclude<ToolMessage<'run_persistent_command'>, { type: 'invalid_params' }>
	type: | 'run_persistent_command'
})) => {
	const accessor = useAccessor()

	const commandService = accessor.get('ICommandService')
	const terminalToolsService = accessor.get('ITerminalToolService')
	const toolsService = accessor.get('IToolsService')
	const isError = false
	const title = getTitle(toolMessage)
	const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor)
	const icon = null
	const streamState = useChatThreadsStreamState(threadId)

	const divRef = useRef<HTMLDivElement | null>(null)

	const isRejected = toolMessage.type === 'rejected'
	const isCancelling = toolMessage.type === 'running_now' && toolMessage.lifecycle === 'cancelling'
	const elapsed = useLiveElapsed(toolMessage.startedAt, toolMessage.type === 'running_now')
	const { rawParams, params } = toolMessage
	const componentParams: ToolHeaderParams = {
		title,
		desc1: isCancelling ? 'Cancelling' : desc1,
		desc1Info,
		desc2: toolMessage.type === 'rejected' && toolMessage.content === 'Tool call was interrupted by the user.' ? 'Cancelled' : undefined,
		elapsed,
		rightAction: toolMessage.type === 'running_now' ? <ToolCardStop threadId={threadId} toolMessage={toolMessage} /> : undefined,
		isError,
		icon,
		isRejected,
	}


	useEffect(() => {
		if (streamState?.isRunning !== 'tool' || type !== 'run_command' || toolMessage.type !== 'running_now') return;
		let disposed = false;
		let cleanup: (() => void) | undefined;
		void streamState.interrupt.then(() => {
			if (disposed) return;
			const container = divRef.current;
			const terminal = container && terminalToolsService.getTemporaryTerminal(toolMessage.params.terminalId);
			if (!container || !terminal) return;
			try { terminal.attachToElement(container); terminal.setVisible(true); } catch { return; }
			const resizeObserver = new ResizeObserver((entries) => {
				const size = entries[0].borderBoxSize[0];
				if (typeof terminal.layout === 'function') terminal.layout({ width: size.inlineSize, height: size.blockSize });
			});
			resizeObserver.observe(container);
			cleanup = () => { terminal.detachFromElement(); resizeObserver.disconnect(); };
			if (disposed) cleanup();
		});
		return () => { disposed = true; cleanup?.(); };
	}, [streamState, terminalToolsService, toolMessage.id, toolMessage.type, type]);

	if (toolMessage.type === 'success') {
		const { result } = toolMessage

		// it's unclear that this is a button and not an icon.
		// componentParams.desc2 = <JumpToTerminalButton
		// 	onClick={() => { terminalToolsService.openTerminal(terminalId) }}
		// />

		let msg: string
		if (type === 'run_command') msg = toolsService.stringOfResult['run_command'](toolMessage.params, result)
		else msg = toolsService.stringOfResult['run_persistent_command'](toolMessage.params, result)

		if (type === 'run_persistent_command') {
			componentParams.info = persistentTerminalNameOfId(toolMessage.params.persistentTerminalId)
		}

		componentParams.children = <ToolChildrenWrapper className='whitespace-pre text-nowrap overflow-auto text-sm'>
			<div className='!select-text cursor-auto'>
				<BlockCode initValue={`${msg.trim()}`} language='shellscript' />
			</div>
		</ToolChildrenWrapper>
	}
	else if (toolMessage.type === 'tool_error') {
		const { result } = toolMessage
		componentParams.bottomChildren = <BottomChildren title='Error'>
			<CodeChildren>
				{result}
			</CodeChildren>
		</BottomChildren>
	}
	else if (toolMessage.type === 'running_now' && !isCancelling) {
		if (type === 'run_command')
			componentParams.children = <div ref={divRef} className='relative h-[300px] text-sm' />
	}
	else if (toolMessage.type === 'rejected' || toolMessage.type === 'tool_request') {
	}

	return <>
		<ToolHeaderWrapper {...componentParams} isOpen={type === 'run_command' && toolMessage.type === 'running_now' && !isCancelling ? true : undefined} />
	</>
}

type WrapperProps<T extends ToolName> = { toolMessage: Exclude<ToolMessage<T>, { type: 'invalid_params' }>, messageIdx: number, threadId: string }
const ApplicationToolWrapper = ({ toolMessage }: { toolMessage: any }) => {
	const params = toolMessage.type === 'invalid_params' ? toolMessage.rawParams : toolMessage.params;
	const payload = toolMessage.type === 'invalid_params' ? toolMessage.content : toolMessage.type === 'tool_error' ? (toolMessage.content || toolMessage.result) : toolMessage.type === 'success' ? toolMessage.result : undefined;
	const presentation = applicationToolPresentation(toolMessage.name, toolMessage.type, params, payload);
	if (!presentation) return null;
	const componentParams: ToolHeaderParams = { title: presentation.title, desc1: presentation.status, desc1Info: presentation.paramsDetail, isError: !!presentation.error, isRejected: toolMessage.type === 'rejected' };
	if (presentation.error) componentParams.bottomChildren = <BottomChildren title='Error'><CodeChildren>{presentation.error}</CodeChildren></BottomChildren>;
	if (presentation.resultDetail !== undefined) componentParams.children = <ToolChildrenWrapper><CodeChildren>{presentation.resultDetail}</CodeChildren></ToolChildrenWrapper>;
	return <ToolHeaderWrapper {...componentParams} />;
}
const MCPToolWrapper = ({ toolMessage }: WrapperProps<string>) => {
	const accessor = useAccessor()
	const mcpService = accessor.get('IMCPService')

	const title = getTitle(toolMessage)
	const desc1 = removeMCPToolNamePrefix(toolMessage.name)
	const icon = null


	// Live rows are routed through LiveToolCard before tool-specific renderers.

	const isError = false
	const isRejected = toolMessage.type === 'rejected'
	const { rawParams, params } = toolMessage
	const componentParams: ToolHeaderParams = { title, desc1, isError, icon, isRejected, }

	const paramsStr = JSON.stringify(params, null, 2)
	componentParams.desc2 = <CopyButton codeStr={paramsStr} toolTipName={`Copy inputs: ${paramsStr}`} />

	componentParams.info = !toolMessage.mcpServerName ? 'MCP tool not found' : undefined

	// Add copy inputs button in desc2


	if (toolMessage.type === 'success' || toolMessage.type === 'tool_request') {
		const { result } = toolMessage
		const resultStr = result ? mcpService.stringifyResult(result) : 'null'
		componentParams.children = <ToolChildrenWrapper>
			<SmallProseWrapper>
				<ChatMarkdownRender
					string={`\`\`\`json\n${resultStr}\n\`\`\``}
					chatMessageLocation={undefined}
					isApplyEnabled={false}
					isLinkDetectionEnabled={true}
				/>
			</SmallProseWrapper>
		</ToolChildrenWrapper>
	}
	else if (toolMessage.type === 'tool_error') {
		const { result } = toolMessage
		componentParams.bottomChildren = <BottomChildren title='Error'>
			<CodeChildren>
				{result}
			</CodeChildren>
		</BottomChildren>
	}

	return <ToolHeaderWrapper {...componentParams} />

}

type ResultWrapper<T extends ToolName> = (props: WrapperProps<T>) => React.ReactNode

const builtinToolNameToComponent: { [T in BuiltinToolName]: { resultWrapper: ResultWrapper<T>, } } = {
	'read_file': {
		resultWrapper: ({ toolMessage }) => {
			const accessor = useAccessor()
			const commandService = accessor.get('ICommandService')

			const title = getTitle(toolMessage)

			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor);
			const icon = null

			if (toolMessage.type === 'tool_request') return null // do not show past requests
			// Live rows are routed through LiveToolCard before tool-specific renderers.

			const isError = false
			const isRejected = toolMessage.type === 'rejected'
			const { rawParams, params } = toolMessage
			const componentParams: ToolHeaderParams = { title, desc1, desc1Info, isError, icon, isRejected, }

			let range: [number, number] | undefined = undefined
			if (toolMessage.params.startLine !== null || toolMessage.params.endLine !== null) {
				const start = toolMessage.params.startLine === null ? `1` : `${toolMessage.params.startLine}`
				const end = toolMessage.params.endLine === null ? `` : `${toolMessage.params.endLine}`
				const addStr = `(${start}-${end})`
				componentParams.desc1 += ` ${addStr}`
				range = [params.startLine || 1, params.endLine || 1]
			}

			if (toolMessage.type === 'success') {
				const { result } = toolMessage
				componentParams.onClick = () => { voidOpenFileFn(params.uri, accessor, range) }
				if (result.hasNextPage)
					componentParams.desc2 = result.longLineContinuation ? `(continue line ${result.nextLine} at byte ${result.nextByteOffset})` : `(continue at line ${result.nextLine})`
			}
			else if (toolMessage.type === 'tool_error') {
				const { result } = toolMessage
				// JumpToFileButton removed in favor of FileLinkText
				componentParams.bottomChildren = <BottomChildren title='Error'>
					<CodeChildren>
						{result}
					</CodeChildren>
				</BottomChildren>
			}

			return <ToolHeaderWrapper {...componentParams} />
		},
	},
	'get_dir_tree': {
		resultWrapper: ({ toolMessage }) => {
			const accessor = useAccessor()
			const commandService = accessor.get('ICommandService')

			const title = getTitle(toolMessage)
			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor)
			const icon = null

			if (toolMessage.type === 'tool_request') return null // do not show past requests
			// Live rows are routed through LiveToolCard before tool-specific renderers.

			const isError = false
			const isRejected = toolMessage.type === 'rejected'
			const { rawParams, params } = toolMessage
			const componentParams: ToolHeaderParams = { title, desc1, desc1Info, isError, icon, isRejected, }

			if (params.uri) {
				const rel = getRelative(params.uri, accessor)
				if (rel) componentParams.info = `Only search in ${rel}`
			}

			if (toolMessage.type === 'success') {
				const { result } = toolMessage
				componentParams.children = <ToolChildrenWrapper>
					<SmallProseWrapper>
						<ChatMarkdownRender
							string={`\`\`\`\n${result.str}\n\`\`\``}
							chatMessageLocation={undefined}
							isApplyEnabled={false}
							isLinkDetectionEnabled={true}
						/>
					</SmallProseWrapper>
				</ToolChildrenWrapper>
			}
			else if (toolMessage.type === 'tool_error') {
				const { result } = toolMessage
				componentParams.bottomChildren = <BottomChildren title='Error'>
					<CodeChildren>
						{result}
					</CodeChildren>
				</BottomChildren>
			}

			return <ToolHeaderWrapper {...componentParams} />

		}
	},
	'ls_dir': {
		resultWrapper: ({ toolMessage }) => {
			const accessor = useAccessor()
			const commandService = accessor.get('ICommandService')
			const explorerService = accessor.get('IExplorerService')
			const title = getTitle(toolMessage)
			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor)
			const icon = null

			if (toolMessage.type === 'tool_request') return null // do not show past requests
			// Live rows are routed through LiveToolCard before tool-specific renderers.

			const isError = false
			const isRejected = toolMessage.type === 'rejected'
			const { rawParams, params } = toolMessage
			const componentParams: ToolHeaderParams = { title, desc1, desc1Info, isError, icon, isRejected, }

			if (params.uri) {
				const rel = getRelative(params.uri, accessor)
				if (rel) componentParams.info = `Only search in ${rel}`
			}

			if (toolMessage.type === 'success') {
				const { result } = toolMessage
				componentParams.numResults = result.children?.length
				componentParams.hasNextPage = result.hasNextPage
				componentParams.children = !result.children || (result.children.length ?? 0) === 0 ? undefined
					: <ToolChildrenWrapper>
						{result.children.map((child, i) => (<ListableToolItem key={i}
							name={`${child.name}${child.isDirectory ? '/' : ''}`}
							className='w-full overflow-auto'
							ariaLabel={`Open ${child.isDirectory ? 'folder' : 'file'} ${child.name}`}
							onClick={() => {
								voidOpenFileFn(child.uri, accessor)
								// commandService.executeCommand('workbench.view.explorer'); // open in explorer folders view instead
								// explorerService.select(child.uri, true);
							}}
						/>))}
						{result.hasNextPage &&
							<ListableToolItem name={`Results truncated (${result.itemsRemaining} remaining).`} isSmall={true} className='w-full overflow-auto' />
						}
					</ToolChildrenWrapper>
			}
			else if (toolMessage.type === 'tool_error') {
				const { result } = toolMessage
				componentParams.bottomChildren = <BottomChildren title='Error'>
					<CodeChildren>
						{result}
					</CodeChildren>
				</BottomChildren>
			}

			return <ToolHeaderWrapper {...componentParams} />
		}
	},
	'search_pathnames_only': {
		resultWrapper: ({ toolMessage }) => {
			const accessor = useAccessor()
			const commandService = accessor.get('ICommandService')
			const isError = false
			const isRejected = toolMessage.type === 'rejected'
			const title = getTitle(toolMessage)
			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor)
			const icon = null

			if (toolMessage.type === 'tool_request') return null // do not show past requests
			// Live rows are routed through LiveToolCard before tool-specific renderers.

			const { rawParams, params } = toolMessage
			const componentParams: ToolHeaderParams = { title, desc1, desc1Info, isError, icon, isRejected, }

			if (params.includePattern) {
				componentParams.info = `Only search in ${params.includePattern}`
			}

			if (toolMessage.type === 'success') {
				const { result, rawParams } = toolMessage
				componentParams.numResults = result.uris.length
				componentParams.hasNextPage = result.hasNextPage
				componentParams.children = result.uris.length === 0 ? undefined
					: <ToolChildrenWrapper>
						{result.uris.map((uri, i) => (<ListableToolItem key={i}
							name={getBasename(uri.fsPath)}
							className='w-full overflow-auto'
							ariaLabel={`Open file ${getBasename(uri.fsPath)}`}
							onClick={() => { voidOpenFileFn(uri, accessor) }}
						/>))}
						{result.hasNextPage &&
							<ListableToolItem name={'Results truncated.'} isSmall={true} className='w-full overflow-auto' />
						}

					</ToolChildrenWrapper>
			}
			else if (toolMessage.type === 'tool_error') {
				const { result } = toolMessage
				componentParams.bottomChildren = <BottomChildren title='Error'>
					<CodeChildren>
						{result}
					</CodeChildren>
				</BottomChildren>
			}

			return <ToolHeaderWrapper {...componentParams} />
		}
	},
	'search_for_files': {
		resultWrapper: ({ toolMessage }) => {
			const accessor = useAccessor()
			const commandService = accessor.get('ICommandService')
			const isError = false
			const isRejected = toolMessage.type === 'rejected'
			const title = getTitle(toolMessage)
			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor)
			const icon = null

			if (toolMessage.type === 'tool_request') return null // do not show past requests
			// Live rows are routed through LiveToolCard before tool-specific renderers.

			const { rawParams, params } = toolMessage
			const componentParams: ToolHeaderParams = { title, desc1, desc1Info, isError, icon, isRejected, }

			if (params.searchInFolder || params.isRegex) {
				let info: string[] = []
				if (params.searchInFolder) {
					const rel = getRelative(params.searchInFolder, accessor)
					if (rel) info.push(`Only search in ${rel}`)
				}
				if (params.isRegex) { info.push(`Uses regex search`) }
				componentParams.info = info.join('; ')
			}

			if (toolMessage.type === 'success') {
				const { result, rawParams } = toolMessage
				componentParams.numResults = result.uris.length
				componentParams.hasNextPage = result.hasNextPage
				componentParams.children = result.uris.length === 0 ? undefined
					: <ToolChildrenWrapper>
						{result.uris.map((uri, i) => (<ListableToolItem key={i}
							name={getBasename(uri.fsPath)}
							className='w-full overflow-auto'
							ariaLabel={`Open file ${getBasename(uri.fsPath)}`}
							onClick={() => { voidOpenFileFn(uri, accessor) }}
						/>))}
						{result.hasNextPage &&
							<ListableToolItem name={`Results truncated.`} isSmall={true} className='w-full overflow-auto' />
						}

					</ToolChildrenWrapper>
			}
			else if (toolMessage.type === 'tool_error') {
				const { result } = toolMessage
				componentParams.bottomChildren = <BottomChildren title='Error'>
					<CodeChildren>
						{result}
					</CodeChildren>
				</BottomChildren>
			}
			return <ToolHeaderWrapper {...componentParams} />
		}
	},

	'search_in_file': {
		resultWrapper: ({ toolMessage }) => {
			const accessor = useAccessor();
			const toolsService = accessor.get('IToolsService');
			const title = getTitle(toolMessage);
			const isError = false
			const isRejected = toolMessage.type === 'rejected'
			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor);
			const icon = null;

			if (toolMessage.type === 'tool_request') return null // do not show past requests
			// Live rows are routed through LiveToolCard before tool-specific renderers.

			const { rawParams, params } = toolMessage;
			const componentParams: ToolHeaderParams = { title, desc1, desc1Info, isError, icon, isRejected };

			const infoarr: string[] = []
			const uriStr = getRelative(params.uri, accessor)
			if (uriStr) infoarr.push(uriStr)
			if (params.isRegex) infoarr.push('Uses regex search')
			componentParams.info = infoarr.join('; ')

			if (toolMessage.type === 'success') {
				const { result } = toolMessage; // result is array of snippets
				componentParams.numResults = result.lines.length;
				componentParams.children = result.lines.length === 0 ? undefined :
					<ToolChildrenWrapper>
						<CodeChildren className='bg-void-bg-3'>
							<pre className='font-mono whitespace-pre'>
								{toolsService.stringOfResult['search_in_file'](params, result)}
							</pre>
						</CodeChildren>
					</ToolChildrenWrapper>
			}
			else if (toolMessage.type === 'tool_error') {
				const { result } = toolMessage;
				componentParams.bottomChildren = <BottomChildren title='Error'>
					<CodeChildren>
						{result}
					</CodeChildren>
				</BottomChildren>
			}

			return <ToolHeaderWrapper {...componentParams} />;
		}
	},

	'read_lint_errors': {
		resultWrapper: ({ toolMessage }) => {
			const accessor = useAccessor()
			const commandService = accessor.get('ICommandService')

			const title = getTitle(toolMessage)

			const { uri } = toolMessage.params ?? {}
			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor)
			const icon = null

			if (toolMessage.type === 'tool_request') return null // do not show past requests
			// Live rows are routed through LiveToolCard before tool-specific renderers.

			const isError = false
			const isRejected = toolMessage.type === 'rejected'
			const { rawParams, params } = toolMessage
			const componentParams: ToolHeaderParams = { title, desc1, desc1Info, isError, icon, isRejected, }

			componentParams.info = getRelative(uri, accessor) // full path

			if (toolMessage.type === 'success') {
				const { result } = toolMessage
				componentParams.onClick = () => { voidOpenFileFn(params.uri, accessor) }
				if (result.lintErrors)
					componentParams.children = <LintErrorChildren lintErrors={result.lintErrors} />
				else
					componentParams.children = `No lint errors found.`

			}
			else if (toolMessage.type === 'tool_error') {
				const { result } = toolMessage
				// JumpToFileButton removed in favor of FileLinkText
				componentParams.bottomChildren = <BottomChildren title='Error'>
					<CodeChildren>
						{result}
					</CodeChildren>
				</BottomChildren>
			}

			return <ToolHeaderWrapper {...componentParams} />
		},
	},

	// ---

	'create_file_or_folder': {
		resultWrapper: ({ toolMessage }) => {
			const accessor = useAccessor()
			const commandService = accessor.get('ICommandService')
			const isError = false
			const isRejected = toolMessage.type === 'rejected'
			const title = getTitle(toolMessage)
			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor)
			const icon = null


			const { rawParams, params } = toolMessage
			const componentParams: ToolHeaderParams = { title, desc1, desc1Info, isError, icon, isRejected, }

			componentParams.info = getRelative(params.uri, accessor) // full path

			if (toolMessage.type === 'success') {
				const { result } = toolMessage
				componentParams.onClick = () => { voidOpenFileFn(params.uri, accessor) }
			}
			else if (toolMessage.type === 'rejected') {
				componentParams.onClick = () => { voidOpenFileFn(params.uri, accessor) }
			}
			else if (toolMessage.type === 'tool_error') {
				const { result } = toolMessage
				if (params) { componentParams.onClick = () => { voidOpenFileFn(params.uri, accessor) } }
				componentParams.bottomChildren = <BottomChildren title='Error'>
					<CodeChildren>
						{result}
					</CodeChildren>
				</BottomChildren>
			}
			else if (toolMessage.type === 'running_now') {
				// nothing more is needed
			}
			else if (toolMessage.type === 'tool_request') {
				// nothing more is needed
			}

			return <ToolHeaderWrapper {...componentParams} />
		}
	},
	'delete_file_or_folder': {
		resultWrapper: ({ toolMessage }) => {
			const accessor = useAccessor()
			const commandService = accessor.get('ICommandService')
			const isFolder = toolMessage.params?.isFolder ?? false
			const isError = false
			const isRejected = toolMessage.type === 'rejected'
			const title = getTitle(toolMessage)
			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor)
			const icon = null

			const { rawParams, params } = toolMessage
			const componentParams: ToolHeaderParams = { title, desc1, desc1Info, isError, icon, isRejected, }

			componentParams.info = getRelative(params.uri, accessor) // full path

			if (toolMessage.type === 'success') {
				const { result } = toolMessage
				componentParams.onClick = () => { voidOpenFileFn(params.uri, accessor) }
			}
			else if (toolMessage.type === 'rejected') {
				componentParams.onClick = () => { voidOpenFileFn(params.uri, accessor) }
			}
			else if (toolMessage.type === 'tool_error') {
				const { result } = toolMessage
				if (params) { componentParams.onClick = () => { voidOpenFileFn(params.uri, accessor) } }
				componentParams.bottomChildren = <BottomChildren title='Error'>
					<CodeChildren>
						{result}
					</CodeChildren>
				</BottomChildren>
			}
			else if (toolMessage.type === 'running_now') {
				const { result } = toolMessage
				componentParams.onClick = () => { voidOpenFileFn(params.uri, accessor) }
			}
			else if (toolMessage.type === 'tool_request') {
				const { result } = toolMessage
				componentParams.onClick = () => { voidOpenFileFn(params.uri, accessor) }
			}

			return <ToolHeaderWrapper {...componentParams} />
		}
	},
	'write_file': { resultWrapper: (params) => <WriteFileTool {...params} /> },

	// ---

	'run_command': {
		resultWrapper: (params) => {
			return <CommandTool {...params} type='run_command' />
		}
	},

	'run_persistent_command': {
		resultWrapper: (params) => {
			return <CommandTool {...params} type='run_persistent_command' />
		}
	},
	'open_persistent_terminal': {
		resultWrapper: ({ toolMessage }) => {
			const accessor = useAccessor()
			const terminalToolsService = accessor.get('ITerminalToolService')

			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor)
			const title = getTitle(toolMessage)
			const icon = null

			if (toolMessage.type === 'tool_request') return null // do not show past requests
			// Live rows are routed through LiveToolCard before tool-specific renderers.

			const isError = false
			const isRejected = toolMessage.type === 'rejected'
			const { rawParams, params } = toolMessage
			const componentParams: ToolHeaderParams = { title, desc1, desc1Info, isError, icon, isRejected, }

			const relativePath = params.cwd ? getRelative(URI.file(params.cwd), accessor) : ''
			componentParams.info = relativePath ? `Running in ${relativePath}` : undefined

			if (toolMessage.type === 'success') {
				const { result } = toolMessage
				const { persistentTerminalId } = result
				componentParams.desc1 = persistentTerminalNameOfId(persistentTerminalId)
				componentParams.onClick = () => terminalToolsService.focusPersistentTerminal(persistentTerminalId)
			}
			else if (toolMessage.type === 'tool_error') {
				const { result } = toolMessage
				componentParams.bottomChildren = <BottomChildren title='Error'>
					<CodeChildren>
						{result}
					</CodeChildren>
				</BottomChildren>
			}

			return <ToolHeaderWrapper {...componentParams} />
		},
	},
	'kill_persistent_terminal': {
		resultWrapper: ({ toolMessage }) => {
			const accessor = useAccessor()
			const commandService = accessor.get('ICommandService')
			const terminalToolsService = accessor.get('ITerminalToolService')

			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor)
			const title = getTitle(toolMessage)
			const icon = null

			if (toolMessage.type === 'tool_request') return null // do not show past requests
			// Live rows are routed through LiveToolCard before tool-specific renderers.

			const isError = false
			const isRejected = toolMessage.type === 'rejected'
			const { rawParams, params } = toolMessage
			const componentParams: ToolHeaderParams = { title, desc1, desc1Info, isError, icon, isRejected, }

			if (toolMessage.type === 'success') {
				const { persistentTerminalId } = params
				componentParams.desc1 = persistentTerminalNameOfId(persistentTerminalId)
				componentParams.onClick = () => terminalToolsService.focusPersistentTerminal(persistentTerminalId)
			}
			else if (toolMessage.type === 'tool_error') {
				const { result } = toolMessage
				componentParams.bottomChildren = <BottomChildren title='Error'>
					<CodeChildren>
						{result}
					</CodeChildren>
				</BottomChildren>
			}

			return <ToolHeaderWrapper {...componentParams} />
		},
	},
};


type ChatBubbleMode = 'display' | 'edit'
type ChatBubbleProps = {
	chatMessage: ChatMessage,
	messageIdx: number,
	isCommitted: boolean,
	threadId: string,
	_scrollToBottom: (() => void) | null,
	editable?: boolean,
}

const ChatBubble = (props: ChatBubbleProps) => {
	return <ErrorBoundary>
		<_ChatBubble {...props} />
	</ErrorBoundary>
}

/** One shared live card keeps every tool call visible under its original call id.
 * Completed tool-specific renderers still own their detailed result views. */
const LiveToolCard = ({ threadId, toolMessage }: { threadId: string; toolMessage: Exclude<ToolMessage<ToolName>, { type: 'invalid_params' }> }) => {
	const route = applicationToolRoute(toolMessage.name, isABuiltinToolName(toolMessage.name))
	const application = route === 'application' ? applicationToolPresentation(toolMessage.name, toolMessage.type, toolMessage.params) : undefined
	const title = getTitle(toolMessage)
	const desc1 = toolMessage.lifecycle === 'cancelling' ? 'Cancelling' : application?.status ?? (route === 'mcp' ? removeMCPToolNamePrefix(toolMessage.name) : 'Running')
	const elapsed = useLiveElapsed(toolMessage.startedAt, toolMessage.type === 'running_now')
	return <ToolHeaderWrapper title={title} desc1={desc1} elapsed={elapsed} rightAction={toolMessage.type === 'running_now' ? <ToolCardStop threadId={threadId} toolMessage={toolMessage} /> : undefined} isRejected={false} />
}

export function SkippedToolCard({ toolMessage }: { toolMessage: Extract<ToolMessage<ToolName>, { type: 'skipped' }> }) {
	return <ToolHeaderWrapper title={toolMessage.name} desc1="Skipped" isRejected={true} />
}

/** Production-used early routing seam for terminal rows that intentionally have no
 * validated params. Returning before the typed route prevents URI/command decoders
 * from observing never-executed provider arguments. */
export function renderEarlyToolCard(toolMessage: ToolMessage<ToolName>) {
	return toolMessage.type === 'skipped' ? <SkippedToolCard toolMessage={toolMessage} /> : undefined
}

const _ChatBubble = ({ threadId, chatMessage, isCommitted, messageIdx, _scrollToBottom, editable }: ChatBubbleProps) => {
	const role = chatMessage.role

	if (role === 'user') {
		return <UserMessageComponent
			chatMessage={chatMessage}
			messageIdx={messageIdx}
			_scrollToBottom={_scrollToBottom}
			editable={editable}
		/>
	}
	else if (role === 'assistant') {
		return <AssistantMessageComponent
			chatMessage={chatMessage}
			messageIdx={messageIdx}
			isCommitted={isCommitted}
		/>
	}
	else if (role === 'tool') {
		// A skipped native-batch row was never validated or started. Route it before any
		// tool-specific card so persisted malformed raw arguments cannot be inspected.
		const earlyToolCard = renderEarlyToolCard(chatMessage)
		if (earlyToolCard !== undefined) return earlyToolCard
		const toolName = chatMessage.name
		const isBuiltinTool = isABuiltinToolName(toolName)
		const route = applicationToolRoute(toolName, isBuiltinTool)

		if (chatMessage.type === 'invalid_params') {
			if (route === 'application') return <ApplicationToolWrapper toolMessage={chatMessage} />
			return <InvalidTool toolName={chatMessage.name} message={chatMessage.content} mcpServerName={chatMessage.mcpServerName} />
		}
		if (chatMessage.type === 'running_now' && chatMessage.name !== 'run_command' && chatMessage.name !== 'run_persistent_command') return <LiveToolCard threadId={threadId} toolMessage={chatMessage} />

		const ToolResultWrapper = isBuiltinTool ? builtinToolNameToComponent[toolName]?.resultWrapper as ResultWrapper<ToolName>
			: route === 'application' ? ApplicationToolWrapper as ResultWrapper<ToolName>
				: MCPToolWrapper as ResultWrapper<ToolName>

		if (ToolResultWrapper)
			return <>
				<div>
					<ToolResultWrapper
						toolMessage={chatMessage}
						messageIdx={messageIdx}
						threadId={threadId}
					/>
				</div>
				{shouldOfferGenericToolApproval(route, chatMessage.type) ?
					<div>
						<ToolRequestAcceptRejectButtons toolName={chatMessage.name} />
					</div> : null}
			</>
		return null
	}

	else if (role === 'interrupted_streaming_tool') {
		return <CanceledTool toolName={chatMessage.name} mcpServerName={chatMessage.mcpServerName} />
	}

}

const CommandBarInChat = () => {
	const { stateOfURI: commandBarStateOfURI, sortedURIs: sortedCommandBarURIs } = useCommandBarState()
	const numFilesChanged = sortedCommandBarURIs.length

	const accessor = useAccessor()
	const editCodeService = accessor.get('IEditCodeService')
	const commandService = accessor.get('ICommandService')
	const chatThreadsState = useChatThreadsState()
	const commandBarState = useCommandBarState()
	const chatThreadsStreamState = useChatThreadsStreamState(chatThreadsState.currentThreadId)

	// (
	// 	<IconShell1
	// 		Icon={CopyIcon}
	// 		onClick={copyChatToClipboard}
	// 		data-tooltip-id='void-tooltip'
	// 		data-tooltip-place='top'
	// 		data-tooltip-content='Copy chat JSON'
	// 	/>
	// )

	const [fileDetailsOpenedState, setFileDetailsOpenedState] = useState<'auto-opened' | 'auto-closed' | 'user-opened' | 'user-closed'>('auto-closed');
	const isFileDetailsOpened = fileDetailsOpenedState === 'auto-opened' || fileDetailsOpenedState === 'user-opened';


	useEffect(() => {
		// close the file details if there are no files
		// this converts 'user-closed' to 'auto-closed'
		if (numFilesChanged === 0) {
			setFileDetailsOpenedState('auto-closed')
		}
		// open the file details if it hasnt been closed
		if (numFilesChanged > 0 && fileDetailsOpenedState !== 'user-closed') {
			setFileDetailsOpenedState('auto-opened')
		}
	}, [fileDetailsOpenedState, setFileDetailsOpenedState, numFilesChanged])


	const isFinishedMakingThreadChanges = (
		// there are changed files
		commandBarState.sortedURIs.length !== 0
		// none of the files are streaming
		&& commandBarState.sortedURIs.every(uri => !commandBarState.stateOfURI[uri.fsPath]?.isStreaming)
	)

	// ======== status of agent ========
	// This icon answers the question "is the LLM doing work on this thread?"
	// assume it is single threaded for now
	// green = Running
	// orange = Requires action
	// dark = Done

	const threadStatus = (
		chatThreadsStreamState?.isRunning === 'awaiting_user' ? { title: 'Needs Approval', color: 'yellow', } as const
			: chatThreadsStreamState?.retry ? { title: `Retrying ${chatThreadsStreamState.retry.attempt}/${chatThreadsStreamState.retry.maxAttempts}`, color: 'orange', } as const
			: chatThreadsStreamState?.isRunning ? { title: 'Running', color: 'orange', } as const
				: { title: 'Done', color: 'dark', } as const
	)


	const threadStatusHTML = <StatusIndicator className='mx-1' indicatorColor={threadStatus.color} title={threadStatus.title} />


	// ======== info about changes ========
	// num files changed
	// acceptall + rejectall
	// popup info about each change (each with num changes + acceptall + rejectall of their own)

	const numFilesChangedStr = numFilesChanged === 0 ? 'No files with changes'
		: `${sortedCommandBarURIs.length} file${numFilesChanged === 1 ? '' : 's'} with changes`




	const acceptRejectAllButtons = <div
		// do this with opacity so that the height remains the same at all times
		className={`flex items-center gap-0.5
			${isFinishedMakingThreadChanges ? '' : 'opacity-0 pointer-events-none'}`
		}
	>
		<IconShell1 // RejectAllButtonWrapper
			// text="Reject All"
			// className="text-xs"
			Icon={X}
			onClick={() => {
				sortedCommandBarURIs.forEach(uri => {
					editCodeService.acceptOrRejectAllDiffAreas({
						uri,
						removeCtrlKs: true,
						behavior: "reject",
						_addToHistory: true,
					});
				});
			}}
			data-tooltip-id='void-tooltip'
			data-tooltip-place='top'
			data-tooltip-content='Reject all'
		/>

		<IconShell1 // AcceptAllButtonWrapper
			// text="Accept All"
			// className="text-xs"
			Icon={Check}
			onClick={() => {
				sortedCommandBarURIs.forEach(uri => {
					editCodeService.acceptOrRejectAllDiffAreas({
						uri,
						removeCtrlKs: true,
						behavior: "accept",
						_addToHistory: true,
					});
				});
			}}
			data-tooltip-id='void-tooltip'
			data-tooltip-place='top'
			data-tooltip-content='Accept all'
		/>



	</div>


	// !select-text cursor-auto
	const fileDetailsContent = <div className="px-2 gap-1 w-full overflow-y-auto">
		{sortedCommandBarURIs.map((uri, i) => {
			const basename = getBasename(uri.fsPath)

			const { sortedDiffIds, isStreaming } = commandBarStateOfURI[uri.fsPath] ?? {}
			const isFinishedMakingFileChanges = !isStreaming

			const numDiffs = sortedDiffIds?.length || 0

			const fileStatus = (isFinishedMakingFileChanges
				? { title: 'Done', color: 'dark', } as const
				: { title: 'Running', color: 'orange', } as const
			)

			const fileNameHTML = <div
				className="flex items-center gap-1.5 text-void-fg-3 hover:brightness-125 transition-all duration-200 cursor-pointer"
				onClick={() => voidOpenFileFn(uri, accessor)}
			>
				{/* <FileIcon size={14} className="text-void-fg-3" /> */}
				<span className="text-void-fg-3">{basename}</span>
			</div>




			const detailsContent = <div className='flex px-4'>
				<span className="text-void-fg-3 opacity-80">{numDiffs} diff{numDiffs !== 1 ? 's' : ''}</span>
			</div>

			const acceptRejectButtons = <div
				// do this with opacity so that the height remains the same at all times
				className={`flex items-center gap-0.5
					${isFinishedMakingFileChanges ? '' : 'opacity-0 pointer-events-none'}
				`}
			>
				{/* <JumpToFileButton
					uri={uri}
					data-tooltip-id='void-tooltip'
					data-tooltip-place='top'
					data-tooltip-content='Go to file'
				/> */}
				<IconShell1 // RejectAllButtonWrapper
					Icon={X}
					onClick={() => { editCodeService.acceptOrRejectAllDiffAreas({ uri, removeCtrlKs: true, behavior: "reject", _addToHistory: true, }); }}
					data-tooltip-id='void-tooltip'
					data-tooltip-place='top'
					data-tooltip-content='Reject file'

				/>
				<IconShell1 // AcceptAllButtonWrapper
					Icon={Check}
					onClick={() => { editCodeService.acceptOrRejectAllDiffAreas({ uri, removeCtrlKs: true, behavior: "accept", _addToHistory: true, }); }}
					data-tooltip-id='void-tooltip'
					data-tooltip-place='top'
					data-tooltip-content='Accept file'
				/>

			</div>

			const fileStatusHTML = <StatusIndicator className='mx-1' indicatorColor={fileStatus.color} title={fileStatus.title} />

			return (
				// name, details
				<div key={i} className="flex justify-between items-center">
					<div className="flex items-center">
						{fileNameHTML}
						{detailsContent}
					</div>
					<div className="flex items-center gap-2">
						{acceptRejectButtons}
						{fileStatusHTML}
					</div>
				</div>
			)
			})}
		</div>

	const fileDetailsButton = (
		<button
			className={`flex items-center gap-1 rounded ${numFilesChanged === 0 ? 'cursor-pointer' : 'cursor-pointer hover:brightness-125 transition-all duration-200'}`}
			onClick={() => isFileDetailsOpened ? setFileDetailsOpenedState('user-closed') : setFileDetailsOpenedState('user-opened')}
			type='button'
			disabled={numFilesChanged === 0}
		>
			<svg
				className="transition-transform duration-200 size-3.5"
				style={{
					transform: isFileDetailsOpened ? 'rotate(0deg)' : 'rotate(180deg)',
					transition: 'transform 0.2s cubic-bezier(0.25, 0.1, 0.25, 1)'
				}}
				xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 15 12 9 6 15"></polyline>
			</svg>
			{numFilesChangedStr}
		</button>
	)

	return (
		<>
			{/* file details */}
			<div className='px-2'>
				<div
					className={`
						select-none
						flex w-full rounded-t-lg bg-void-bg-3
						text-void-fg-3 text-xs text-nowrap

						overflow-hidden transition-all duration-200 ease-in-out
						${isFileDetailsOpened ? 'max-h-24' : 'max-h-0'}
					`}
				>
					{fileDetailsContent}
				</div>
			</div>
			{/* main content */}
			<div
				className={`
					select-none
					flex w-full rounded-t-lg bg-void-bg-3
					text-void-fg-3 text-xs text-nowrap
					border-t border-l border-r border-zinc-300/10

					px-2 py-1
					justify-between
				`}
			>
				<div className="flex gap-2 items-center">
					{fileDetailsButton}
				</div>
				<div className="flex gap-2 items-center">
					{acceptRejectAllButtons}
					{threadStatusHTML}
				</div>
			</div>
		</>
	)
}



const ChildToolApprovalPanel = ({ approvals }: { approvals: readonly ChildToolApprovalView[] }) => {
	const chatThreadsService = useAccessor().get('IChatThreadService')
	if (approvals.length === 0) return null;
	return <section className='text-xs mb-1' aria-label='Child tool approvals'>
		{approvals.map(approval => {
			const key = approval.key
			const title = approval.title
			return <div key={approval.structuralKey} className='border border-void-warning rounded-sm px-2 py-1 mt-1' aria-label={`${title}, child ${approval.childShortId}, awaiting approval`}>
				<div className='text-void-fg-1'>{title}</div>
				<div className='text-void-warning' role='status'>Awaiting approval · action required</div>
				<div className='text-void-fg-3'>Child {approval.childShortId} · approval category: {approval.category}</div>
				<pre className='text-void-fg-3 whitespace-pre-wrap break-all overflow-hidden'>{approval.parameters}</pre>
				<div className='flex gap-2 mt-1'>
					<button type='button' className='focus-ring px-2 py-0.5 rounded-sm bg-void-bg-3' aria-label={`Approve ${approval.toolName} for child ${approval.childShortId}`} onClick={() => chatThreadsService.approveChildToolApproval(key)}>Approve</button>
					<button type='button' className='focus-ring px-2 py-0.5 rounded-sm bg-void-bg-3' aria-label={`Reject ${approval.toolName} for child ${approval.childShortId}`} onClick={() => chatThreadsService.rejectChildToolApproval(key)}>Reject</button>
				</div>
			</div>
		})}
	</section>;
};

/** Purely projects durable receipts beside their persisted spawn success row. */
const childActivityInterleavePlan = (messages: readonly ChatMessage[], activities: ChildActivitiesLedger): ReadonlyMap<number, readonly ChildActivityRecord[]> => {
	const plan = new Map<number, ChildActivityRecord[]>();
	for (const record of activities.records) {
		if (record.parentRunId) continue;
		const index = messages.findIndex(message => message.role === 'tool' && message.type === 'success' && message.name === 'spawn_agent' && message.id === record.anchor.toolId && message.batchId === record.anchor.batchId && message.batchOrdinal === record.anchor.batchOrdinal && (message.result as { id?: unknown })?.id === record.childId);
		if (index >= 0) plan.set(index, [...(plan.get(index) ?? []), record]);
	}
	return plan;
};
const ChildActivityCard = ({ root, all, live, ledger }: { root: ChildActivityRecord; all: readonly ChildActivityRecord[]; live: ReadonlyMap<string, AgentSubagentRunView>; ledger: ChildActivitiesLedger }) => {
	const keyOf = (record: ChildActivityRecord) => JSON.stringify([record.generation, record.childId]);
	const view = live.get(keyOf(root)); const status = view?.status ?? root.status; const elapsed = view?.totalMs ?? root.totalMs;
	const renderChildren = (parent: ChildActivityRecord): React.ReactNode => all.filter(record => record.generation === parent.generation && record.parentRunId === parent.childId).map(child => { const current = live.get(keyOf(child)); return <div key={keyOf(child)} className='pl-2 pt-1'>Child {child.childId.slice(0, 8)} · {current?.status ?? child.status} · {current?.totalMs ?? child.totalMs}ms{(current?.summary ?? child.summary) ? ` · ${current?.summary ?? child.summary}` : ''}{renderChildren(child)}</div>; });
	return <details className='border border-void-border-1 rounded-sm px-2 py-1 mt-1 text-xs' data-testid='child-activity-card'>
		<summary className='focus-ring cursor-pointer select-none' aria-label={`Child Activity ${root.childId.slice(0, 8)} ${status}`}>Child Activity{root.role ? ` · ${root.role.name}` : ''} · {root.childId.slice(0, 8)} · {status} · {elapsed}ms</summary>
		<div className='pt-1 text-void-fg-3'>
			{root.role ? <div>{root.role.description}</div> : null}
			<div>Capability: {root.capabilityProfile === 'inherit_parent_write' ? 'Inherited parent profile' : 'Read-only'}; Timing: {view?.queuedMs ?? root.queuedMs}ms queued, {view?.runningMs ?? root.runningMs}ms running, {elapsed}ms total</div>
			{(view?.summary ?? root.summary) ? <div className='pt-1 whitespace-pre-wrap break-words'>{view?.summary ?? root.summary}</div> : null}
			{(view?.resultTruncated ?? root.resultTruncated) ? <div className='text-void-warning'>Result compacted.</div> : null}
			<div className='pt-1'>{renderChildren(root)}</div>
			{ledger.omitted || ledger.retentionSaturated ? <div className='pt-1 text-void-warning'>{ledger.omitted ? `${ledger.omitted} activities omitted. ` : ''}{ledger.retentionSaturated ? 'Retention is saturated.' : ''}</div> : null}
		</div>
	</details>;
};

const pendingInputModeLabel = (mode: PendingInputMode): string => {
	switch (mode) {
		case 'queue': return 'Queue';
		case 'steer': return 'Steer';
		case 'stop_and_send': return 'Stop and send';
	}
}

const pendingInputPhaseLabel = (input: PendingChatInput): string => {
	switch (input.phase) {
		case 'queued': return input.mode === 'stop_and_send' ? 'Stopping and sending' : 'Queued';
		case 'steering': return 'Waiting for a safe boundary';
		case 'claiming': return 'Sending';
		case 'dormant': return 'Ready to resume';
	}
}

const PendingChatInputsPanel = ({
	threadId,
	inputs,
	onEdit,
	onDelete,
	onReorder,
	onResume,
}: {
	threadId: string;
	inputs: readonly PendingChatInput[];
	onEdit: (threadId: string, id: string, expectedFingerprint: string, text: string) => Promise<boolean>;
	onDelete: (threadId: string, id: string, expectedFingerprint: string) => Promise<boolean>;
	onReorder: (threadId: string, id: string, expectedFingerprint: string, expectedThreadFingerprint: string, beforeId?: string) => Promise<boolean>;
	onResume: (threadId: string, id: string, expectedFingerprint: string) => Promise<boolean>;
}) => {
	const [editing, setEditing] = useState<{ id: string; text: string; fingerprint: string } | undefined>()
	const actionFlights = useRef(new Set<string>())
	const [, setActionRevision] = useState(0)
	const runAction = async (id: string, action: () => Promise<boolean>, accepted?: () => void) => {
		if (actionFlights.current.has(id)) return
		actionFlights.current.add(id); setActionRevision(value => value + 1)
		try { if (await action()) accepted?.() }
		catch { /* the service owns the single user-facing backend warning */ }
		finally { actionFlights.current.delete(id); setActionRevision(value => value + 1) }
	}
	if (!inputs.length) return null
	const threadFingerprint = pendingChatInputThreadFingerprint(inputs)
	return <section id='void-chat-pending-inputs' aria-label='Queued messages' className='mb-2 border border-void-border-2 rounded px-2 py-1 text-xs text-void-fg-3' onClick={event => event.stopPropagation()}>
		<div className='font-medium text-void-fg-2 pb-1'>Queued messages</div>
		<div role='list' className='flex flex-col gap-1'>
			{inputs.map((input, index) => {
				const fingerprint = pendingChatInputFingerprint(input)
				const actionInFlight = actionFlights.current.has(input.id)
				const locked = input.phase === 'claiming' || actionInFlight
				const isEditing = editing?.id === input.id
				return <div key={input.id} role='listitem' className='rounded border border-void-border-3 px-2 py-1'>
					<div className='flex flex-wrap items-center gap-x-1 text-void-fg-2'>
						<span>{pendingInputModeLabel(input.mode)}</span><span aria-hidden='true'>·</span><span>{pendingInputPhaseLabel(input)}</span><span aria-hidden='true'>·</span><span>{input.selections.length} selection{input.selections.length === 1 ? '' : 's'}</span>
					</div>
					{isEditing ? <textarea
						aria-label='Edit queued message'
						className='focus-ring mt-1 w-full rounded border border-void-border-2 bg-void-bg-1 px-1 py-0.5 text-void-fg-1'
						value={editing.text}
						disabled={actionInFlight}
						onChange={event => { const text = event.currentTarget.value; setEditing(current => current?.id === input.id ? { ...current, text } : current) }}
						onClick={event => event.stopPropagation()}
					/> : <div className='mt-1 whitespace-pre-wrap break-words text-void-fg-1'>{input.text}</div>}
					<div className='mt-1 flex flex-wrap gap-1'>
						{isEditing ? <>
							<button type='button' disabled={actionInFlight} className='focus-ring rounded border border-void-border-2 px-1 disabled:opacity-50' onClick={() => void runAction(input.id, () => onEdit(threadId, input.id, editing.fingerprint, editing.text), () => setEditing(current => current?.id === input.id ? undefined : current))}>Save</button>
							<button type='button' disabled={actionInFlight} className='focus-ring rounded border border-void-border-2 px-1 disabled:opacity-50' onClick={() => setEditing(undefined)}>Cancel</button>
						</> : <button type='button' disabled={locked} className='focus-ring rounded border border-void-border-2 px-1 disabled:opacity-50' onClick={() => setEditing({ id: input.id, text: input.text, fingerprint })}>Edit</button>}
						<button type='button' disabled={locked} className='focus-ring rounded border border-void-border-2 px-1 disabled:opacity-50' onClick={() => void runAction(input.id, () => onDelete(threadId, input.id, fingerprint), () => setEditing(current => current?.id === input.id ? undefined : current))}>Delete</button>
						<button type='button' disabled={locked || index === 0} className='focus-ring rounded border border-void-border-2 px-1 disabled:opacity-50' onClick={() => void runAction(input.id, () => onReorder(threadId, input.id, fingerprint, threadFingerprint, inputs[index - 1]?.id))}>Move up</button>
						<button type='button' disabled={locked || index === inputs.length - 1} className='focus-ring rounded border border-void-border-2 px-1 disabled:opacity-50' onClick={() => void runAction(input.id, () => onReorder(threadId, input.id, fingerprint, threadFingerprint, inputs[index + 2]?.id))}>Move down</button>
						{input.phase === 'dormant' ? <button type='button' disabled={actionInFlight} className='focus-ring rounded border border-void-border-2 px-1 disabled:opacity-50' onClick={() => void runAction(input.id, () => onResume(threadId, input.id, fingerprint))}>Resume</button> : null}
					</div>
				</div>
			})}
		</div>
	</section>
}

export const LandingSuggestedPrompts = ({ onSubmit, disabled }: { onSubmit: (text: string) => void, disabled: boolean }) => <div className='flex flex-col gap-2 w-full text-nowrap text-void-fg-3 select-none'>
	{[
		'Summarize my codebase',
		'How do types work in Rust?'
	].map((text) => (
		<button
			key={text}
			type='button'
			disabled={disabled}
			className='focus-ring w-full py-1 px-2 rounded text-left text-sm bg-zinc-700/5 hover:bg-zinc-700/10 dark:bg-zinc-300/5 dark:hover:bg-zinc-300/10 cursor-pointer opacity-80 hover:opacity-100 disabled:cursor-default disabled:opacity-50'
			onClick={() => onSubmit(text)}
		>
			{text}
		</button>
	))}
</div>

export const SidebarChat = () => {
	const textAreaRef = useRef<HTMLTextAreaElement | null>(null)
	const textAreaFnsRef = useRef<TextAreaFns | null>(null)

	const accessor = useAccessor()
	const commandService = accessor.get('ICommandService')
	const chatThreadsService = accessor.get('IChatThreadService')

	const settingsState = useSettingsState()
	// ----- HIGHER STATE -----

	// threads state
	const chatThreadsState = useChatThreadsState()

	const currentThread = chatThreadsService.getCurrentThread()
	const threadId = currentThread.id
	const previousMessages = currentThread?.messages ?? []

	const selections = currentThread.state.stagingSelections
	const setSelections = (s: StagingSelectionItem[]) => { chatThreadsService.setCurrentThreadState({ stagingSelections: s }) }

	// stream state
	const currThreadStreamState = useChatThreadsStreamState(chatThreadsState.currentThreadId)
	const pendingSubmission = usePendingChatSubmission(threadId)
	const pendingInputs = usePendingChatInputs(threadId)
	const isRunning = currThreadStreamState?.isRunning
	const { runs: childRuns } = useAgentSubagentLiveSnapshot(currentThread.id)
	const childToolApprovals = useChildToolApprovals(currentThread.id)
	// One live overlay is shared by every history card; cards never subscribe or tick.
	const liveChildRunById = useMemo(() => new Map(childRuns.map(run => [JSON.stringify([run.generation, run.id]), run])), [childRuns])
	const childActivityPlan = useMemo(() => childActivityInterleavePlan(previousMessages, currentThread.childActivities), [previousMessages, currentThread.childActivities])
	const childIsActive = childRuns.some(isActiveChildRun)
	const isAnyRunning = !!isRunning || childIsActive || !!pendingSubmission
	const latestError = currThreadStreamState?.error
	const { displayContentSoFar, toolCallSoFar, toolCallsSoFar, reasoningSoFar } = currThreadStreamState?.llmInfo ?? {}

	// this is just if it's currently being generated, NOT if it's currently running
	const generatingToolCalls = toolCallsSoFar ?? (toolCallSoFar ? [toolCallSoFar] : [])
	const toolIsGenerating = generatingToolCalls.some(tool => !tool.isDone) // show loading for slow tools (right now just edit)

	// ----- SIDEBAR CHAT state (local) -----

	// state of current message
	const initVal = chatThreadsService.getTransientComposerDraft(currentThread.id)
	const [draftEmptiness, setDraftEmptiness] = useState({ threadId, isEmpty: !initVal })
	const instructionsAreEmpty = draftEmptiness.threadId === threadId ? draftEmptiness.isEmpty : !initVal

	const hasDraft = !instructionsAreEmpty
	const chatModelUnavailable = !!isFeatureNameDisabled('Chat', settingsState)
	const currentStatusPresentation = getChatCurrentStatusPresentation({
		parentIsRunning: isRunning,
		retry: currThreadStreamState?.retry,
		childActive: childIsActive,
		hasError: !!latestError,
		hasDraft,
		chatModelUnavailable,
		pendingPreparing: !!pendingSubmission,
	})

	const sidebarRef = useRef<HTMLDivElement>(null)
	const scrollContainerRef = useRef<HTMLDivElement | null>(null)
	const [pendingAction, setPendingAction] = useState<'' | PendingInputMode>('')
	const pendingComposerFlight = useRef(false)
	const [pendingComposerActionInFlight, setPendingComposerActionInFlight] = useState(false)
	const submitPendingComposerInput = useCallback(async (mode: PendingInputMode, forcedText?: string): Promise<boolean> => {
		const releaseFlight = beginChatComposerSubmissionFlight(pendingComposerFlight)
		if (!releaseFlight) return false
		const submissionThreadId = threadId
		const userMessage = forcedText ?? textAreaRef.current?.value ?? chatThreadsService.getTransientComposerDraft(submissionThreadId)
		if (!userMessage.trim() || chatModelUnavailable) { releaseFlight(); return false }
		const capturedSelections = [...selections]
		setPendingComposerActionInFlight(true)
		try {
			return await submitChatComposer({
				threadId: submissionThreadId,
				submit: async () => !!(await chatThreadsService.submitPendingInput({ threadId: submissionThreadId, text: userMessage, mode, selections: capturedSelections })),
				clearSubmittedState: submittedThreadId => {
					const currentSelections = chatThreadsService.state.allThreads[submittedThreadId]?.state.stagingSelections ?? []
					if (chatThreadsService.getTransientComposerDraft(submittedThreadId) !== userMessage || JSON.stringify(currentSelections) !== JSON.stringify(capturedSelections)) return false
					chatThreadsService.clearSubmittedComposerState(submittedThreadId); return true
				},
				getCurrentThreadId: () => chatThreadsService.state.currentThreadId,
				clearCurrentInput: () => {
					textAreaFnsRef.current?.setValue('')
					textAreaRef.current?.focus()
				},
			})
		} finally { releaseFlight(); setPendingComposerActionInFlight(false) }
	}, [chatThreadsService, threadId, selections, chatModelUnavailable])
	const onSubmit = useCallback(async (_forceSubmit?: string) => {
		// Queue/Steer admission owns the ordering slot until its durable broker ACK.
		// Editing remains enabled, but no newer direct send may overtake it.
		if (pendingComposerFlight.current) return
		try {
			// Every UI Send is durable broker admission first. An idle Queue row drains
			// immediately; a renderer closing during preparation leaves a resumable row.
			await submitPendingComposerInput('queue', _forceSubmit)
		} catch (e) {
			console.error('Error while queueing message in chat:', e)
			return
		}

	}, [chatThreadsService, threadId, isAnyRunning, hasDraft, chatModelUnavailable, submitPendingComposerInput])
	const submitSelectedPendingAction = useCallback((mode: PendingInputMode) => {
		void submitPendingComposerInput(mode).catch(error => console.error('Error while queueing message in chat:', error))
	}, [submitPendingComposerInput])

	const onAbort = async () => {
		const threadId = currentThread.id
		await chatThreadsService.abortRunning(threadId)
	}

	const keybindingString = accessor.get('IKeybindingService').lookupKeybinding(VOID_CTRL_L_ACTION_ID)?.getLabel()

	// resolve mount info
	const isResolved = chatThreadsState.allThreads[threadId]?.state.mountedInfo?.mountedIsResolvedRef.current
	useEffect(() => {
		if (isResolved) return
		chatThreadsState.allThreads[threadId]?.state.mountedInfo?._whenMountedResolver?.({
			textAreaRef: textAreaRef,
			scrollToBottom: () => scrollToBottom(scrollContainerRef),
		})

	}, [chatThreadsState, threadId, textAreaRef, scrollContainerRef, isResolved])




	const previousMessagesHTML = useMemo(() => {
		// tool request shows up as Editing... if in progress
		return previousMessages.flatMap((message, i) => {
			const bubble = <ChatBubble
				key={i}
				chatMessage={message}
				messageIdx={i}
				isCommitted={true}
				threadId={threadId}
				_scrollToBottom={() => scrollToBottom(scrollContainerRef)}
			/>;
			const activities = childActivityPlan.get(i) ?? [];
			return [bubble, ...activities.map(activity => <ChildActivityCard key={`child-activity-${activity.generation}-${activity.childId}`} root={activity} all={currentThread.childActivities.records} live={liveChildRunById} ledger={currentThread.childActivities} />)];
		})
	}, [previousMessages, threadId, isRunning, childActivityPlan, currentThread.childActivities.records, liveChildRunById])
	// Activity cards are DOM-only projections, never transcript rows. Keep every
	// ChatBubble index anchored to the persisted message array.
	const pendingMessageHTML = pendingSubmission ? <div data-testid='chat-pending-user' className='pointer-events-none'><ChatBubble key={`pending-${pendingSubmission.id}`} chatMessage={{ role: 'user', content: '', displayContent: pendingSubmission.displayContent, selections: [...pendingSubmission.selections], state: { stagingSelections: [], isBeingEdited: false } }} messageIdx={previousMessages.length} isCommitted={false} threadId={threadId} _scrollToBottom={null} editable={false} /></div> : null
	const hasVisibleConversation = previousMessagesHTML.length > 0 || !!pendingMessageHTML

	const streamingChatIdx = previousMessages.length
	const currStreamingMessageHTML = reasoningSoFar || displayContentSoFar || (isRunning && !(currThreadStreamState?.isRunning === 'idle' && currThreadStreamState.toolInfo?.transient)) ?
		<ChatBubble
			key={'curr-streaming-msg'}
			chatMessage={{
				role: 'assistant',
				displayContent: displayContentSoFar ?? '',
				reasoning: reasoningSoFar ?? '',
				anthropicReasoning: null,
			}}
			messageIdx={streamingChatIdx}
			isCommitted={false}

			threadId={threadId}
			_scrollToBottom={null}
		/> : null


	// the tool currently being generated
	const generatingTool = toolIsGenerating ? generatingToolCalls.filter(tool => !tool.isDone).map((tool, ordinal) => <SimplifiedToolHeader key={`curr-streaming-tool-${tool.id || ordinal}`} title={tool.name === 'write_file' ? 'Writing file' : tool.name} />) : null
	const transientControl = currThreadStreamState?.isRunning === 'idle' && currThreadStreamState.toolInfo?.transient ?
		<LiveToolCard key={`control-${currThreadStreamState.toolInfo.receiptId}`} threadId={threadId} toolMessage={{ role: 'tool', type: 'running_now', name: currThreadStreamState.toolInfo.toolName, params: currThreadStreamState.toolInfo.toolParams, content: currThreadStreamState.toolInfo.content, result: null, id: currThreadStreamState.toolInfo.id, rawParams: currThreadStreamState.toolInfo.rawParams, mcpServerName: currThreadStreamState.toolInfo.mcpServerName, receiptId: currThreadStreamState.toolInfo.receiptId, lifecycle: currThreadStreamState.toolInfo.lifecycle, startedAt: currThreadStreamState.toolInfo.startedAt, cardStopAvailable: false, cardStopUnavailableReason: currThreadStreamState.toolInfo.cardStopUnavailableReason } as any} /> : null

	const messagesHTML = <ScrollToBottomContainer
		key={'messages' + chatThreadsState.currentThreadId} // force rerender on all children if id changes
		scrollContainerRef={scrollContainerRef}
		className={`
			flex flex-col
			px-4 py-4 space-y-4
			w-full h-full
			overflow-x-hidden
			overflow-y-auto
			${!hasVisibleConversation && !displayContentSoFar ? 'hidden' : ''}
		`}
	>
		{/* previous messages */}
		{previousMessagesHTML}
		{pendingMessageHTML}
		{transientControl}
		{currStreamingMessageHTML}

		{/* Generating tool */}
		{generatingTool}

		{/* loading indicator */}
		{isRunning === 'LLM' || isRunning === 'idle' && !toolIsGenerating ? <ProseWrapper>
			{<IconLoading className='opacity-50 text-sm' />}
		</ProseWrapper> : null}


		{/* error message */}
		{latestError === undefined ? null :
			<div className='px-2 my-1'>
				<ErrorDisplay
					message={latestError.message}
					fullError={latestError.fullError}
					onDismiss={() => { chatThreadsService.dismissStreamError(currentThread.id) }}
					showDismiss={true}
				/>

				<WarningBox className='text-sm my-2 mx-4' onClick={() => { commandService.executeCommand(VOID_OPEN_SETTINGS_ACTION_ID) }} text='Open settings' />
			</div>
		}
	</ScrollToBottomContainer>


	const onChangeText = useCallback((newStr: string) => {
		chatThreadsService.setTransientComposerDraft(threadId, newStr)
		const isEmpty = !newStr
		setDraftEmptiness(previous => previous.threadId === threadId && previous.isEmpty === isEmpty ? previous : { threadId, isEmpty })
	}, [chatThreadsService, threadId])
	const onKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229 || e.repeat) return
		if (e.key === 'Enter' && !e.shiftKey) {
			onSubmit()
		} else if (e.key === 'Escape' && currentStatusPresentation.showStop) {
			onAbort()
		}
	}, [onSubmit, onAbort, currentStatusPresentation.showStop])

	const currentStatusHelp = <div
		id={currentStatusPresentation.statusHelp.id}
		className='min-h-5 flex flex-wrap items-center gap-x-1 px-0.5 text-xs text-void-fg-3'
	>
		<span role='status' aria-live='polite' aria-atomic={true} className='text-void-fg-2'>{currentStatusPresentation.announcement}</span>
	</div>
	const busyComposerActions = isAnyRunning ? <div className='flex items-center gap-1' onClick={event => event.stopPropagation()}>
		<button
			type='button'
			id='void-chat-current-queue'
			aria-label='Queue message'
			title='Queue message'
			disabled={!hasDraft || chatModelUnavailable || pendingComposerActionInFlight}
			className='focus-ring rounded border border-void-border-2 px-2 py-0.5 text-xs disabled:cursor-default disabled:opacity-50'
			onClick={() => submitSelectedPendingAction('queue')}
		>Queue</button>
		<select
			id='void-chat-current-actions'
			aria-label='More message actions'
			title='More message actions'
			value={pendingAction}
			disabled={!hasDraft || chatModelUnavailable || pendingComposerActionInFlight}
			className='focus-ring rounded border border-void-border-2 bg-void-bg-1 px-1 py-0.5 text-xs disabled:cursor-default disabled:opacity-50'
			onChange={event => {
				const mode = event.currentTarget.value as '' | PendingInputMode
				setPendingAction('')
				if (mode) submitSelectedPendingAction(mode)
			}}
		>
			<option value='' disabled>More actions</option>
			<option value='queue'>Queue</option>
			<option value='steer'>Steer</option>
			<option value='stop_and_send'>Stop and send</option>
		</select>
		{currentStatusPresentation.showStop ? <ButtonStop
			className={currentStatusPresentation.controls ? 'focus-ring' : ''}
			id={currentStatusPresentation.controls?.stop.id}
			aria-label={currentStatusPresentation.controls?.stop.ariaLabel}
			title={currentStatusPresentation.controls?.stop.title}
			onClick={onAbort}
		/> : null}
	</div> : undefined
	const pendingInputPanel = <PendingChatInputsPanel
		key={`pending-inputs-${threadId}`}
		threadId={threadId}
		inputs={pendingInputs}
		onEdit={(originThreadId, id, fingerprint, text) => chatThreadsService.editPendingInput(originThreadId, id, fingerprint, text)}
		onDelete={(originThreadId, id, fingerprint) => chatThreadsService.deletePendingInput(originThreadId, id, fingerprint)}
		onReorder={(originThreadId, id, fingerprint, threadFingerprint, beforeId) => chatThreadsService.reorderPendingInput(originThreadId, id, fingerprint, threadFingerprint, beforeId)}
		onResume={(originThreadId, id, fingerprint) => chatThreadsService.resumePendingInput(originThreadId, id, fingerprint)}
	/>

	const inputChatArea = <VoidChatArea
		featureName='Chat'
		onSubmit={() => onSubmit()}
		onAbort={onAbort}
		isStreaming={isAnyRunning}
		showStop={currentStatusPresentation.showStop}
		isDisabled={currentStatusPresentation.sendDisabled || pendingComposerActionInFlight}
		statusHelp={currentStatusHelp}
		controlSemantics={currentStatusPresentation.controls}
		actionSlot={busyComposerActions}
		showSelections={true}
		// showProspectiveSelections={previousMessagesHTML.length === 0}
		selections={selections}
		setSelections={setSelections}
		onClickAnywhere={() => { textAreaRef.current?.focus() }}
	>
		<VoidInputBox2
			initValue={initVal}
			enableAtToMention
			ariaLabel={currentStatusPresentation.textarea.ariaLabel}
			ariaDescribedBy={currentStatusPresentation.textarea.ariaDescribedBy}
			className={`focus-ring min-h-[81px] px-0.5 py-0.5`}
			placeholder={`@ to mention, ${keybindingString ? `${keybindingString} to add a selection. ` : ''}Enter instructions...`}
			onChangeText={onChangeText}
			onKeyDown={onKeyDown}
			onFocus={() => { chatThreadsService.setCurrentlyFocusedMessageIdx(undefined) }}
			ref={textAreaRef}
			fnsRef={textAreaFnsRef}
			multiline={true}
		/>

	</VoidChatArea>


	const isLandingPage = previousMessages.length === 0 && !pendingSubmission && pendingInputs.length === 0


	const initiallySuggestedPromptsHTML = <LandingSuggestedPrompts onSubmit={onSubmit} disabled={chatModelUnavailable || pendingComposerActionInFlight} />



	const threadPageInput = <div key={'input' + chatThreadsState.currentThreadId}>
		<div className='px-4'>
			<ChildToolApprovalPanel approvals={childToolApprovals} />
			<CommandBarInChat />
			{pendingInputPanel}
		</div>
		<div className='px-2 pb-2'>
			{inputChatArea}
		</div>
	</div>

	const landingPageInput = <div>
		<div className='pt-8'>
			<div className='px-4'><ChildToolApprovalPanel approvals={childToolApprovals} />{pendingInputPanel}</div>
			{inputChatArea}
		</div>
	</div>

	const chatHistorySection = <ErrorBoundary>
		<div className='pt-8 mb-2 text-void-fg-3 text-root select-none pointer-events-none'>Chat history</div>
		<PastThreadsList />
	</ErrorBoundary>
	const showPersistentChatHistory = shouldShowPersistentChatHistory(isLandingPage ? 'landing' : 'current')

	const landingPageContent = <div
		ref={sidebarRef}
		className='w-full h-full max-h-full flex flex-col overflow-auto px-4'
	>
		<ErrorBoundary>
			{landingPageInput}
		</ErrorBoundary>

		{Object.keys(chatThreadsState.allThreads).length <= 1 &&
			<ErrorBoundary>
				<div className='pt-8 mb-2 text-void-fg-3 text-root select-none pointer-events-none'>Suggestions</div>
				{initiallySuggestedPromptsHTML}
			</ErrorBoundary>}
		{showPersistentChatHistory && chatHistorySection}
	</div>


	// const threadPageContent = <div>
	// 	{/* Thread content */}
	// 	<div className='flex flex-col overflow-hidden'>
	// 		<div className={`overflow-hidden ${previousMessages.length === 0 ? 'h-0 max-h-0 pb-2' : ''}`}>
	// 			<ErrorBoundary>
	// 				{messagesHTML}
	// 			</ErrorBoundary>
	// 		</div>
	// 		<ErrorBoundary>
	// 			{inputForm}
	// 		</ErrorBoundary>
	// 	</div>
	// </div>
	const threadPageContent = <div
		ref={sidebarRef}
		className='w-full h-full flex flex-col overflow-hidden'
	>

		<ErrorBoundary>
			{messagesHTML}
		</ErrorBoundary>
		<ErrorBoundary>
			{threadPageInput}
		</ErrorBoundary>
		{showPersistentChatHistory && <div className='px-4 overflow-auto'>
			{chatHistorySection}
		</div>}
	</div>


	return (
		<Fragment key={threadId} // force rerender when change thread
		>
			{isLandingPage ?
				landingPageContent
				: threadPageContent}
		</Fragment>
	)
}
