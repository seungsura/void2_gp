/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// registered in app.ts
// code convention is to make a service responsible for this stuff, and not a channel, but having fewer files is simpler...

import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { EventLLMMessageOnTextParams, EventLLMMessageOnErrorParams, EventLLMMessageOnFinalMessageParams, MainSendLLMMessageParams, AbortRef, SendLLMMessageParams, MainLLMMessageAbortParams, ModelListParams, EventModelListOnSuccessParams, EventModelListOnErrorParams, OllamaModelResponse, OpenaiCompatibleModelResponse, MainModelListParams, } from '../common/sendLLMMessageTypes.js';
import { sendLLMMessage } from './llmMessage/sendLLMMessage.js'
import { IMetricsService } from '../common/metricsService.js';
import { sendLLMMessageToProviderImplementation } from './llmMessage/sendLLMMessage.impl.js';

// NODE IMPLEMENTATION - calls actual sendLLMMessage() and returns listeners to it

export class LLMMessageChannel implements IServerChannel {

	// sendLLMMessage
	private readonly llmMessageEmitters = {
		onText: new Emitter<EventLLMMessageOnTextParams>(),
		onFinalMessage: new Emitter<EventLLMMessageOnFinalMessageParams>(),
		onError: new Emitter<EventLLMMessageOnErrorParams>(),
	}

	// aborters for above
	private readonly _infoOfRunningRequest: Record<string, { abortRef: AbortRef; abortRequested: boolean; settled: boolean }> = {}


	// list
	private readonly listEmitters = {
		ollama: {
			success: new Emitter<EventModelListOnSuccessParams<OllamaModelResponse>>(),
			error: new Emitter<EventModelListOnErrorParams<OllamaModelResponse>>(),
		},
		openaiCompat: {
			success: new Emitter<EventModelListOnSuccessParams<OpenaiCompatibleModelResponse>>(),
			error: new Emitter<EventModelListOnErrorParams<OpenaiCompatibleModelResponse>>(),
		},
	} satisfies {
		[providerName in 'ollama' | 'openaiCompat']: {
			success: Emitter<EventModelListOnSuccessParams<any>>,
			error: Emitter<EventModelListOnErrorParams<any>>,
		}
	}

	// stupidly, channels can't take in @IService
	constructor(
		private readonly metricsService: IMetricsService,
		private readonly send: typeof sendLLMMessage = sendLLMMessage,
	) { }

	// browser uses this to listen for changes
	listen(_: unknown, event: string): Event<any> {
		// text
		if (event === 'onText_sendLLMMessage') return this.llmMessageEmitters.onText.event;
		else if (event === 'onFinalMessage_sendLLMMessage') return this.llmMessageEmitters.onFinalMessage.event;
		else if (event === 'onError_sendLLMMessage') return this.llmMessageEmitters.onError.event;
		// list
		else if (event === 'onSuccess_list_ollama') return this.listEmitters.ollama.success.event;
		else if (event === 'onError_list_ollama') return this.listEmitters.ollama.error.event;
		else if (event === 'onSuccess_list_openAICompatible') return this.listEmitters.openaiCompat.success.event;
		else if (event === 'onError_list_openAICompatible') return this.listEmitters.openaiCompat.error.event;

		else throw new Error(`Event not found: ${event}`);
	}

	// browser uses this to call (see this.channel.call() in llmMessageService.ts for all usages)
	async call(_: unknown, command: string, params: any): Promise<any> {
		try {
			if (command === 'sendLLMMessage') {
				this._callSendLLMMessage(params)
			}
			else if (command === 'abort') {
				await this._callAbort(params)
			}
			else if (command === 'ollamaList') {
				this._callOllamaList(params)
			}
			else if (command === 'openAICompatibleList') {
				this._callOpenAICompatibleList(params)
			}
			else {
				throw new Error(`Void sendLLM: command "${command}" not recognized.`)
			}
		}
		catch (e) {
			console.log('llmMessageChannel: Call Error:', e)
		}
	}

	// the only place sendLLMMessage is actually called
	private _callSendLLMMessage(params: MainSendLLMMessageParams) {
		const { requestId } = params;
		if (requestId in this._infoOfRunningRequest) return;
		let currentAborter: (() => void) | null = null;
		const record = { abortRef: {} as AbortRef, abortRequested: false, settled: false };
		Object.defineProperty(record.abortRef, 'current', { enumerable: true, get: () => currentAborter, set: (value: (() => void) | null) => { currentAborter = value; if (record.abortRequested) { currentAborter?.(); currentAborter = null; } } });
		this._infoOfRunningRequest[requestId] = record;
		const finish = () => { if (record.settled) return false; record.settled = true; if (this._infoOfRunningRequest[requestId] === record) delete this._infoOfRunningRequest[requestId]; return true; };

		const mainThreadParams: SendLLMMessageParams = {
			...params,
			onText: (p) => {
				if (!record.settled) this.llmMessageEmitters.onText.fire({ requestId, ...p });
			},
			onFinalMessage: (p) => {
				if (finish()) this.llmMessageEmitters.onFinalMessage.fire({ requestId, ...p });
			},
			onError: (p) => {
				console.log('sendLLM: firing err');
				if (finish()) this.llmMessageEmitters.onError.fire({ requestId, ...p });
			},
			abortRef: record.abortRef,
		}
		void this.send(mainThreadParams, this.metricsService).finally(() => { if (record.abortRequested) record.abortRef.current?.(); finish(); });
		if (record.abortRequested) record.abortRef.current?.();
	}

	private _callAbort(params: MainLLMMessageAbortParams) {
		const { requestId } = params;
		const record = this._infoOfRunningRequest[requestId]; if (!record) return;
		record.abortRequested = true; record.abortRef.current?.(); record.settled = true;
		if (this._infoOfRunningRequest[requestId] === record) delete this._infoOfRunningRequest[requestId];
	}





	_callOllamaList = (params: MainModelListParams<OllamaModelResponse>) => {
		const { requestId } = params
		const emitters = this.listEmitters.ollama
		const mainThreadParams: ModelListParams<OllamaModelResponse> = {
			...params,
			onSuccess: (p) => { emitters.success.fire({ requestId, ...p }); },
			onError: (p) => { emitters.error.fire({ requestId, ...p }); },
		}
		sendLLMMessageToProviderImplementation.ollama.list(mainThreadParams)
	}

	_callOpenAICompatibleList = (params: MainModelListParams<OpenaiCompatibleModelResponse>) => {
		const { requestId, providerName } = params
		const emitters = this.listEmitters.openaiCompat
		const mainThreadParams: ModelListParams<OpenaiCompatibleModelResponse> = {
			...params,
			onSuccess: (p) => { emitters.success.fire({ requestId, ...p }); },
			onError: (p) => { emitters.error.fire({ requestId, ...p }); },
		}
		sendLLMMessageToProviderImplementation[providerName].list(mainThreadParams)
	}





}
