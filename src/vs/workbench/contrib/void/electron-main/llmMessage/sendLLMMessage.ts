/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { SendLLMMessageParams, OnText, OnFinalMessage, OnError } from '../../common/sendLLMMessageTypes.js';
import { IMetricsService } from '../../common/metricsService.js';
import { displayInfoOfProviderName } from '../../common/voidSettingsTypes.js';
import { sendLLMMessageToProviderImplementation } from './sendLLMMessage.impl.js';
import { StopWatch } from '../../../../../base/common/stopwatch.js';


export const sendLLMMessage = async ({
	messagesType,
	messages: messages_,
	onText: onText_,
	onFinalMessage: onFinalMessage_,
	onError: onError_,
	abortRef: abortRef_,
	logging: { loggingName, loggingExtras },
	settingsOfProvider,
	modelSelection,
	modelSelectionOptions,
	overridesOfModel,
	chatMode,
	separateSystemMessage,
	mcpTools,
	toolExecutionProfile,
	frozenToolSnapshot,
	agentDelegationAllowed,
	requestProfile,
}: SendLLMMessageParams,

	metricsService: IMetricsService
) => {


	const { providerName, modelName } = modelSelection
	const isGhostChatRequest = requestProfile === 'ghost-chat'

	// only captures number of messages and message "shape", no actual code, instructions, prompts, etc
	const captureLLMEvent = (eventId: string, extras?: object) => {
		if (isGhostChatRequest) return

		metricsService.capture(eventId, {
			providerName,
			modelName,
			customEndpointURL: settingsOfProvider[providerName]?.endpoint,
			numModelsAtEndpoint: settingsOfProvider[providerName]?.models?.length,
			...messagesType === 'chatMessages' ? {
				numMessages: messages_?.length,
			} : messagesType === 'FIMMessage' ? {
				prefixLength: messages_.prefix.length,
				suffixLength: messages_.suffix.length,
			} : {},
			...loggingExtras,
			...extras,
		})
	}
	const submitTime = StopWatch.create()

	let _fullTextSoFar = ''
	let _aborter: (() => void) | null = null
	let _didAbort = false
	// A child may be cancelled while provider setup is still asynchronous. Latch it,
	// fence callbacks first, and invoke a late provider aborter once without retaining it.
	let _setAborter = (fn: () => void) => { if (_didAbort) { try { fn() } catch { } return } _aborter = fn }

	const onText: OnText = (params) => {
		const { fullText } = params
		if (_didAbort) return
		onText_(params)
		_fullTextSoFar = fullText
	}

	const onFinalMessage: OnFinalMessage = (params) => {
		const { fullText, fullReasoning, toolCalls } = params
		if (_didAbort) return
		captureLLMEvent(`${loggingName} - Received Full Message`, { messageLength: fullText.length, reasoningLength: fullReasoning?.length, duration: submitTime.elapsed(), toolCallNames: toolCalls?.map(call => call.name) })
		onFinalMessage_(params)
	}

	const onError: OnError = ({ message: errorMessage, fullError }) => {
		if (_didAbort) return
		if (!isGhostChatRequest) console.error('sendLLMMessage onError:', errorMessage)

		// handle failed to fetch errors, which give 0 information by design
		if (errorMessage === 'TypeError: fetch failed')
			errorMessage = `Failed to fetch from ${displayInfoOfProviderName(providerName).title}. This likely means you specified the wrong endpoint in Void's Settings, or your local model provider like Ollama is powered off.`

		captureLLMEvent(`${loggingName} - Error`, { error: errorMessage })
		onError_({ message: errorMessage, fullError })
	}

	// we should NEVER call onAbort internally, only from the outside
	const onAbort = () => {
		if (_didAbort) return
		_didAbort = true
		captureLLMEvent(`${loggingName} - Abort`, { messageLengthSoFar: _fullTextSoFar.length })
		try { _aborter?.() } // aborter sometimes automatically throws an error
		catch (e) { }
		_aborter = null
	}
	abortRef_.current = onAbort

	if (requestProfile === 'ghost-chat') {
		const isSingleUserMessage = messagesType === 'chatMessages'
			&& messages_.length === 1
			&& messages_[0].role === 'user'
			&& 'content' in messages_[0]
			&& typeof messages_[0].content === 'string'
		const isGhostChatContract = providerName === 'openAICompatible'
			&& modelName === 'gpt-4.1'
			&& isSingleUserMessage
			&& chatMode === null
			&& separateSystemMessage === undefined
			&& Array.isArray(mcpTools) && mcpTools.length === 0
			&& toolExecutionProfile === undefined
			&& agentDelegationAllowed !== true
			&& modelSelectionOptions === undefined
			&& overridesOfModel === undefined
		if (!isGhostChatContract) {
			onError({ message: 'Ghost Chat request rejected: provider, model, message, or authority profile did not match the fixed internal contract.', fullError: null })
			return
		}
	}


	if (messagesType === 'chatMessages')
		captureLLMEvent(`${loggingName} - Sending Message`, {})
	else if (messagesType === 'FIMMessage')
		captureLLMEvent(`${loggingName} - Sending FIM`, { prefixLen: messages_?.prefix?.length, suffixLen: messages_?.suffix?.length })


	try {
		const implementation = sendLLMMessageToProviderImplementation[providerName]
		if (!implementation) {
			onError({ message: `Error: Provider "${providerName}" not recognized.`, fullError: null })
			return
		}
		const { sendFIM, sendChat } = implementation
		if (messagesType === 'chatMessages') {
			await sendChat({ messages: messages_, onText, onFinalMessage, onError, settingsOfProvider, modelSelectionOptions, overridesOfModel, modelName, _setAborter, providerName, separateSystemMessage, chatMode, mcpTools, toolExecutionProfile, frozenToolSnapshot, agentDelegationAllowed, requestProfile })
			return
		}
		if (messagesType === 'FIMMessage') {
			if (sendFIM) {
				await sendFIM({ messages: messages_, onText, onFinalMessage, onError, settingsOfProvider, modelSelectionOptions, overridesOfModel, modelName, _setAborter, providerName, separateSystemMessage })
				return
			}
			onError({ message: `Error running Autocomplete with ${providerName} - ${modelName}.`, fullError: null })
			return
		}
		onError({ message: `Error: Message type "${messagesType}" not recognized.`, fullError: null })
		return
	}

	catch (error) {
		if (error instanceof Error) { onError({ message: error + '', fullError: error }) }
		else { onError({ message: `Unexpected Error in sendLLMMessage: ${error}`, fullError: error }); }
		// ; (_aborter as any)?.()
		// _didAbort = true
	}



}
