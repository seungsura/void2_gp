/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { EventLLMMessageOnTextParams, EventLLMMessageOnErrorParams, EventLLMMessageOnFinalMessageParams, ServiceSendLLMMessageParams, MainSendLLMMessageParams, MainLLMMessageAbortParams, ServiceModelListParams, EventModelListOnSuccessParams, EventModelListOnErrorParams, MainModelListParams, OllamaModelResponse, OpenaiCompatibleModelResponse, } from './sendLLMMessageTypes.js';

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IVoidSettingsService } from './voidSettingsService.js';
import { IMCPService } from './mcpService.js';
import { deepClone } from '../../../../base/common/objects.js';
import { SettingsOfProvider } from './voidSettingsTypes.js';

// calls channel to implement features
export const ILLMMessageService = createDecorator<ILLMMessageService>('llmMessageService');

export interface ILLMMessageService {
	readonly _serviceBrand: undefined;
	sendLLMMessage: (params: ServiceSendLLMMessageParams) => string | null;
	captureSettingsOfProvider: () => SettingsOfProvider;
	abort: (requestId: string) => void;
	ollamaList: (params: ServiceModelListParams<OllamaModelResponse>) => void;
	openAICompatibleList: (params: ServiceModelListParams<OpenaiCompatibleModelResponse>) => void;
}


// open this file side by side with llmMessageChannel
export class LLMMessageService extends Disposable implements ILLMMessageService {

	readonly _serviceBrand: undefined;
	private readonly channel: IChannel // LLMMessageChannel

	// sendLLMMessage
	private readonly llmMessageHooks = {
		onText: {} as { [eventId: string]: ((params: EventLLMMessageOnTextParams) => void) },
		onFinalMessage: {} as { [eventId: string]: ((params: EventLLMMessageOnFinalMessageParams) => void) },
		onError: {} as { [eventId: string]: ((params: EventLLMMessageOnErrorParams) => void) },
		onAbort: {} as { [eventId: string]: (() => void) }, // NOT sent over the channel, result is instant when we call .abort()
	}
	private readonly suppressErrorLogOfRequestId: { [requestId: string]: true | undefined } = {}

	// list hooks
	private readonly listHooks = {
		ollama: {
			success: {} as { [eventId: string]: ((params: EventModelListOnSuccessParams<OllamaModelResponse>) => void) },
			error: {} as { [eventId: string]: ((params: EventModelListOnErrorParams<OllamaModelResponse>) => void) },
		},
		openAICompat: {
			success: {} as { [eventId: string]: ((params: EventModelListOnSuccessParams<OpenaiCompatibleModelResponse>) => void) },
			error: {} as { [eventId: string]: ((params: EventModelListOnErrorParams<OpenaiCompatibleModelResponse>) => void) },
		}
	} satisfies {
		[providerName in 'ollama' | 'openAICompat']: {
			success: { [eventId: string]: ((params: EventModelListOnSuccessParams<any>) => void) },
			error: { [eventId: string]: ((params: EventModelListOnErrorParams<any>) => void) },
		}
	}

	constructor(
		@IMainProcessService private readonly mainProcessService: IMainProcessService, // used as a renderer (only usable on client side)
		@IVoidSettingsService private readonly voidSettingsService: IVoidSettingsService,
		// @INotificationService private readonly notificationService: INotificationService,
		@IMCPService private readonly mcpService: IMCPService,
	) {
		super()

		// const service = ProxyChannel.toService<LLMMessageChannel>(mainProcessService.getChannel('void-channel-sendLLMMessage')); // lets you call it like a service
		// see llmMessageChannel.ts
		this.channel = this.mainProcessService.getChannel('void-channel-llmMessage')

		// .listen sets up an IPC channel and takes a few ms, so we set up listeners immediately and add hooks to them instead
		// llm
		this._register((this.channel.listen('onText_sendLLMMessage') satisfies Event<EventLLMMessageOnTextParams>)(e => {
			this.llmMessageHooks.onText[e.requestId]?.(e)
		}))
		this._register((this.channel.listen('onFinalMessage_sendLLMMessage') satisfies Event<EventLLMMessageOnFinalMessageParams>)(e => {
			this.llmMessageHooks.onFinalMessage[e.requestId]?.(e);
			this._clearChannelHooks(e.requestId)
		}))
		this._register((this.channel.listen('onError_sendLLMMessage') satisfies Event<EventLLMMessageOnErrorParams>)(e => {
			const suppressErrorLog = this.suppressErrorLogOfRequestId[e.requestId] === true;
			this.llmMessageHooks.onError[e.requestId]?.(e);
			this._clearChannelHooks(e.requestId);
			if (!suppressErrorLog) console.error('Error in LLMMessageService:', JSON.stringify(e))
		}))
		// .list()
		this._register((this.channel.listen('onSuccess_list_ollama') satisfies Event<EventModelListOnSuccessParams<OllamaModelResponse>>)(e => {
			this._settleListHook('ollama', 'success', e.requestId, e)
		}))
		this._register((this.channel.listen('onError_list_ollama') satisfies Event<EventModelListOnErrorParams<OllamaModelResponse>>)(e => {
			this._settleListHook('ollama', 'error', e.requestId, e)
		}))
		this._register((this.channel.listen('onSuccess_list_openAICompatible') satisfies Event<EventModelListOnSuccessParams<OpenaiCompatibleModelResponse>>)(e => {
			this._settleListHook('openAICompat', 'success', e.requestId, e)
		}))
		this._register((this.channel.listen('onError_list_openAICompatible') satisfies Event<EventModelListOnErrorParams<OpenaiCompatibleModelResponse>>)(e => {
			this._settleListHook('openAICompat', 'error', e.requestId, e)
		}))

	}

	sendLLMMessage(params: ServiceSendLLMMessageParams) {
		const { onText, onFinalMessage, onError, onAbort, modelSelection, settingsOfProviderOverride, ...proxyParams } = params;

		// throw an error if no model/provider selected (this should usually never be reached, the UI should check this first, but might happen in cases like Apply where we haven't built much UI/checks yet, good practice to have check logic on backend)
		if (modelSelection === null) {
			const message = `Please add a provider in Void's Settings.`
			onError({ message, fullError: null })
			return null
		}

		if (params.messagesType === 'chatMessages' && (params.messages?.length ?? 0) === 0) {
			const message = `No messages detected.`
			onError({ message, fullError: null })
			return null
		}

		const settingsOfProvider = settingsOfProviderOverride ?? this.voidSettingsService.state.settingsOfProvider

		// A read-only child has no MCP authority. Do not even enumerate the live MCP
		// registry for it: later provider filtering is a defense in depth, not the
		// browser-side serialization boundary.
		const mcpTools = params.messagesType === 'chatMessages' && (params.toolExecutionProfile === 'read-only-child' || params.toolExecutionProfile === 'inherited-parent-write-child' || params.requestProfile === 'ghost-chat')
			? []
			: this.mcpService.getMCPTools()

		// add state for request id
		const requestId = generateUuid();
		this.llmMessageHooks.onText[requestId] = onText
		this.llmMessageHooks.onFinalMessage[requestId] = onFinalMessage
		this.llmMessageHooks.onError[requestId] = onError
		this.llmMessageHooks.onAbort[requestId] = onAbort // used internally only
		if (params.requestProfile === 'ghost-chat') this.suppressErrorLogOfRequestId[requestId] = true

		// params will be stripped of all its functions over the IPC channel
		this.channel.call('sendLLMMessage', {
			...proxyParams,
			requestId,
			settingsOfProvider,
			modelSelection,
			mcpTools,
		} satisfies MainSendLLMMessageParams);

		return requestId
	}

	captureSettingsOfProvider(): SettingsOfProvider {
		return deepClone(this.voidSettingsService.state.settingsOfProvider)
	}

	abort(requestId: string) {
		this.llmMessageHooks.onAbort[requestId]?.() // calling the abort hook here is instant (doesn't go over a channel)
		this.channel.call('abort', { requestId } satisfies MainLLMMessageAbortParams);
		this._clearChannelHooks(requestId)
	}


	ollamaList = (params: ServiceModelListParams<OllamaModelResponse>) => {
		const { onSuccess, onError, ...proxyParams } = params

		const { settingsOfProvider } = this.voidSettingsService.state

		// add state for request id
		const requestId_ = generateUuid();
		this.listHooks.ollama.success[requestId_] = onSuccess
		this.listHooks.ollama.error[requestId_] = onError

		this._callModelList('ollama', 'ollamaList', requestId_, {
			...proxyParams,
			settingsOfProvider,
			providerName: 'ollama',
			requestId: requestId_,
		} satisfies MainModelListParams<OllamaModelResponse>)
	}


	openAICompatibleList = (params: ServiceModelListParams<OpenaiCompatibleModelResponse>) => {
		const { onSuccess, onError, ...proxyParams } = params

		const { settingsOfProvider } = this.voidSettingsService.state

		// add state for request id
		const requestId_ = generateUuid();
		this.listHooks.openAICompat.success[requestId_] = onSuccess
		this.listHooks.openAICompat.error[requestId_] = onError

		this._callModelList('openAICompat', 'openAICompatibleList', requestId_, {
			...proxyParams,
			settingsOfProvider,
			requestId: requestId_,
		} satisfies MainModelListParams<OpenaiCompatibleModelResponse>)
	}

	private _callModelList(provider: 'ollama' | 'openAICompat', command: 'ollamaList' | 'openAICompatibleList', requestId: string, params: MainModelListParams<OllamaModelResponse | OpenaiCompatibleModelResponse>): void {
		try {
			void this.channel.call(command, params).then(undefined, error => this._settleListHook(provider, 'error', requestId, { error }));
		} catch (error) {
			this._settleListHook(provider, 'error', requestId, { error });
		}
	}

	private _settleListHook(provider: 'ollama' | 'openAICompat', outcome: 'success' | 'error', requestId: string, params: unknown): void {
		const callbacks = this.listHooks[provider][outcome] as Record<string, ((value: unknown) => void) | undefined>;
		try {
			callbacks[requestId]?.(params);
		} finally {
			this._clearChannelHooks(requestId);
		}
	}

	private _clearChannelHooks(requestId: string) {
		delete this.llmMessageHooks.onText[requestId]
		delete this.llmMessageHooks.onFinalMessage[requestId]
		delete this.llmMessageHooks.onError[requestId]
		delete this.llmMessageHooks.onAbort[requestId]
		delete this.suppressErrorLogOfRequestId[requestId]

		delete this.listHooks.ollama.success[requestId]
		delete this.listHooks.ollama.error[requestId]

		delete this.listHooks.openAICompat.success[requestId]
		delete this.listHooks.openAICompat.error[requestId]
	}

	override dispose(): void {
		const requestIds = new Set([
			...Object.keys(this.llmMessageHooks.onText),
			...Object.keys(this.llmMessageHooks.onFinalMessage),
			...Object.keys(this.llmMessageHooks.onError),
			...Object.keys(this.llmMessageHooks.onAbort),
			...Object.keys(this.suppressErrorLogOfRequestId),
			...Object.keys(this.listHooks.ollama.success),
			...Object.keys(this.listHooks.ollama.error),
			...Object.keys(this.listHooks.openAICompat.success),
			...Object.keys(this.listHooks.openAICompat.error),
		]);
		for (const requestId of requestIds) this._clearChannelHooks(requestId);
		super.dispose();
	}
}

registerSingleton(ILLMMessageService, LLMMessageService, InstantiationType.Eager);
