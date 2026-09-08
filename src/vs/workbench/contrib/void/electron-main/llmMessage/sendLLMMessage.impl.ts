/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// disable foreign import complaints
/* eslint-disable */
import Anthropic from '@anthropic-ai/sdk';
import { Ollama } from 'ollama';
import OpenAI, { ClientOptions, AzureOpenAI } from 'openai';
import * as fs from 'fs';
import * as path from 'path';
import { MistralCore } from '@mistralai/mistralai/core.js';
import { fimComplete } from '@mistralai/mistralai/funcs/fimComplete.js';
import { Tool as GeminiTool, FunctionDeclaration, GoogleGenAI, ThinkingConfig, Schema, Type } from '@google/genai';
import { GoogleAuth } from 'google-auth-library'
/* eslint-enable */

import { AnthropicLLMChatMessage, GeminiLLMChatMessage, LLMChatMessage, LLMFIMMessage, LLMRequestProfile, ModelListParams, OllamaModelResponse, OnError, OnFinalMessage, OnText, RawToolCallObj, RawToolParamsObj } from '../../common/sendLLMMessageTypes.js';
import { ChatMode, displayInfoOfProviderName, ModelSelectionOptions, OverridesOfModel, ProviderName, SettingsOfProvider } from '../../common/voidSettingsTypes.js';
import { corporateOpenAICompatibleEndpoint, getSendableReasoningInfo, getModelCapabilities, getProviderCapabilities, defaultProviderSettings, getReservedOutputTokenSpace, isCorporateOpenAICompatibleEndpoint, wireModelNameFor } from '../../common/modelCapabilities.js';
import { extractReasoningWrapper, extractXMLToolsWrapper } from './extractGrammar.js';
import { availableTools, InternalToolInfo } from '../../common/prompt/prompts.js';
import { AgentSubagentToolSnapshot, ToolExecutionProfile } from '../../common/agentSubagents.js';
import { classifyOpenAICompatibleToolSchemaDialect, formatPrematureStreamCloseMessage, isPrematureStreamClose, OpenAICompatibleStreamDiagnostics, redactOpenAICompatibleEndpoint } from './openAICompatibleDiagnostics.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { ToolName } from '../../common/toolsServiceTypes.js';

const getGoogleApiKey = async () => {
	// module‑level singleton
	const auth = new GoogleAuth({ scopes: `https://www.googleapis.com/auth/cloud-platform` });
	const key = await auth.getAccessToken()
	if (!key) throw new Error(`Google API failed to generate a key.`)
	return key
}




type InternalCommonMessageParams = {
	onText: OnText;
	onFinalMessage: OnFinalMessage;
	onError: OnError;
	providerName: ProviderName;
	settingsOfProvider: SettingsOfProvider;
	modelSelectionOptions: ModelSelectionOptions | undefined;
	overridesOfModel: OverridesOfModel | undefined;
	modelName: string;
	_setAborter: (aborter: () => void) => void;
}

type SendChatParams_Internal = InternalCommonMessageParams & {
	messages: LLMChatMessage[];
	separateSystemMessage: string | undefined;
	chatMode: ChatMode | null;
	mcpTools: InternalToolInfo[] | undefined;
	toolExecutionProfile?: ToolExecutionProfile;
	frozenToolSnapshot?: AgentSubagentToolSnapshot;
	agentDelegationAllowed?: boolean;
	requestProfile?: LLMRequestProfile;
}
type SendFIMParams_Internal = InternalCommonMessageParams & { messages: LLMFIMMessage; separateSystemMessage: string | undefined; }
export type ListParams_Internal<ModelResponse> = ModelListParams<ModelResponse>


const invalidApiKeyMessage = (providerName: ProviderName) => `Invalid ${displayInfoOfProviderName(providerName).title} API key.`

// ------------ OPENAI-COMPATIBLE (HELPERS) ------------



const parseHeadersJSON = (s: string | undefined): Record<string, string | null | undefined> | undefined => {
	if (!s) return undefined
	try {
		return JSON.parse(s)
	} catch (e) {
		throw new Error(`Error parsing OpenAI-Compatible headers: ${s} is not a valid JSON.`)
	}
}

const corporateCredentialUnavailableMessage = 'Corporate provider credential is unavailable.';

type CorporateProductionSmokeCounters = { requests: number; completed: number; nativeAgentToolSchema: boolean };
type RuntimeFetch = (this: unknown, ...args: any[]) => Promise<any>;
type OpenAIClientWithRuntimeFetch = { fetch: RuntimeFetch };

const corporateProductionSmokeClients = new WeakSet<OpenAI>();
const corporateProductionSmokeNativeToolNames = new Set(['read_file', 'write_file', 'run_command', 'spawn_agent', 'wait_agent', 'list_agents', 'send_message', 'interrupt_agent']);

const getCorporateProductionSmokeCounters = () => {
	if (process.env.VOID_CORPORATE_PRODUCTION_SMOKE !== '1') return undefined;
	const runtime = globalThis as typeof globalThis & { __voidCorporateProductionSmokeCounters?: CorporateProductionSmokeCounters };
	return runtime.__voidCorporateProductionSmokeCounters ??= { requests: 0, completed: 0, nativeAgentToolSchema: false };
};

const configureCorporateProductionSmokeClient = (client: OpenAI) => {
	const counters = getCorporateProductionSmokeCounters();
	if (!counters) return;
	const clientWithFetch = client as unknown as OpenAIClientWithRuntimeFetch;
	const originalFetch = clientWithFetch.fetch;
	clientWithFetch.fetch = function (this: unknown, ...args: any[]) {
		if (counters.requests >= 1) return Promise.reject(new Error('Corporate production smoke permits one request.'));
		counters.requests += 1;
		return originalFetch.apply(this, args);
	};
	corporateProductionSmokeClients.add(client);
};

const corporateTestEndpoint = () => {
	const candidate = process.env.VOID_CORPORATE_TEST_ENDPOINT;
	if (!candidate) return undefined;
	try {
		const endpoint = new URL(candidate);
		const isLoopback = endpoint.hostname === '127.0.0.1' || endpoint.hostname === 'localhost' || endpoint.hostname === '[::1]' || endpoint.hostname === '::1';
		const isBareOrigin = (endpoint.pathname === '/' || endpoint.pathname === '') && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash;
		return endpoint.protocol === 'http:' && isLoopback && isBareOrigin ? endpoint.origin : undefined;
	}
	catch {
		return undefined;
	}
}

const readNonEmptyCredential = async (credentialPath: string | undefined) => {
	if (!credentialPath) return undefined;
	try {
		const credential = (await fs.promises.readFile(credentialPath, 'utf8')).trim();
		return credential || undefined;
	}
	catch {
		return undefined;
	}
}

const resolveCorporateCredential = async () => {
	const environmentCredential = process.env.VOID_CORPORATE_API_KEY?.trim();
	if (environmentCredential) return environmentCredential;

	const explicitCredential = await readNonEmptyCredential(process.env.VOID_CORPORATE_API_KEY_PATH);
	if (explicitCredential) return explicitCredential;

	const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
	const packagedCredential = await readNonEmptyCredential(resourcesPath ? path.join(resourcesPath, 'app', '.corporate', 'API_KEY') : undefined);
	if (packagedCredential) return packagedCredential;

	const companionCredential = await readNonEmptyCredential(path.join(path.dirname(process.execPath), 'API_KEY'));
	if (companionCredential) return companionCredential;

	throw new Error(corporateCredentialUnavailableMessage);
}

const newOpenAICompatibleSDK = async ({ settingsOfProvider, providerName, includeInPayload }: { settingsOfProvider: SettingsOfProvider, providerName: ProviderName, includeInPayload?: { [s: string]: any } }) => {
	const commonPayloadOpts: ClientOptions = {
		dangerouslyAllowBrowser: true,
		...includeInPayload,
	}
	if (providerName === 'openAI') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ apiKey: thisConfig.apiKey, ...commonPayloadOpts })
	}
	else if (providerName === 'ollama') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: `${thisConfig.endpoint}/v1`, apiKey: 'noop', ...commonPayloadOpts })
	}
	else if (providerName === 'vLLM') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: `${thisConfig.endpoint}/v1`, apiKey: 'noop', ...commonPayloadOpts })
	}
	else if (providerName === 'liteLLM') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: `${thisConfig.endpoint}/v1`, apiKey: 'noop', ...commonPayloadOpts })
	}
	else if (providerName === 'lmStudio') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: `${thisConfig.endpoint}/v1`, apiKey: 'noop', ...commonPayloadOpts })
	}
	else if (providerName === 'openRouter') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({
			baseURL: 'https://openrouter.ai/api/v1',
			apiKey: thisConfig.apiKey,
			defaultHeaders: {
				'HTTP-Referer': 'https://voideditor.com', // Optional, for including your app on openrouter.ai rankings.
				'X-Title': 'Void', // Optional. Shows in rankings on openrouter.ai.
			},
			...commonPayloadOpts,
		})
	}
	else if (providerName === 'googleVertex') {
		// https://cloud.google.com/vertex-ai/generative-ai/docs/multimodal/call-vertex-using-openai-library
		const thisConfig = settingsOfProvider[providerName]
		const baseURL = `https://${thisConfig.region}-aiplatform.googleapis.com/v1/projects/${thisConfig.project}/locations/${thisConfig.region}/endpoints/${'openapi'}`
		const apiKey = await getGoogleApiKey()
		return new OpenAI({ baseURL: baseURL, apiKey: apiKey, ...commonPayloadOpts })
	}
	else if (providerName === 'microsoftAzure') {
		// https://learn.microsoft.com/en-us/rest/api/aifoundry/model-inference/get-chat-completions/get-chat-completions?view=rest-aifoundry-model-inference-2024-05-01-preview&tabs=HTTP
		//  https://github.com/openai/openai-node?tab=readme-ov-file#microsoft-azure-openai
		const thisConfig = settingsOfProvider[providerName]
		const endpoint = `https://${thisConfig.project}.openai.azure.com/`;
		const apiVersion = thisConfig.azureApiVersion ?? '2024-04-01-preview';
		const options = { endpoint, apiKey: thisConfig.apiKey, apiVersion };
		return new AzureOpenAI({ ...options, ...commonPayloadOpts });
	}
	else if (providerName === 'awsBedrock') {
		/**
		  * We treat Bedrock as *OpenAI-compatible only through a proxy*:
		  *   • LiteLLM default → http://localhost:4000/v1
		  *   • Bedrock-Access-Gateway → https://<api-id>.execute-api.<region>.amazonaws.com/openai/
		  *
		  * The native Bedrock runtime endpoint
		  *   https://bedrock-runtime.<region>.amazonaws.com
		  * is **NOT** OpenAI-compatible, so we do *not* fall back to it here.
		  */
		const { endpoint, apiKey } = settingsOfProvider.awsBedrock

		// ① use the user-supplied proxy if present
		// ② otherwise default to local LiteLLM
		let baseURL = endpoint || 'http://localhost:4000/v1'

		// Normalize: make sure we end with “/v1”
		if (!baseURL.endsWith('/v1'))
			baseURL = baseURL.replace(/\/+$/, '') + '/v1'

		return new OpenAI({ baseURL, apiKey, ...commonPayloadOpts })
	}


	else if (providerName === 'deepseek') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: 'https://api.deepseek.com/v1', apiKey: thisConfig.apiKey, ...commonPayloadOpts })
	}
	else if (providerName === 'openAICompatible') {
		const thisConfig = settingsOfProvider[providerName]
		if (isCorporateOpenAICompatibleEndpoint(thisConfig.endpoint)) {
			const apiKey = await resolveCorporateCredential()
			const client = new OpenAI({ baseURL: corporateTestEndpoint() ?? corporateOpenAICompatibleEndpoint, apiKey, ...commonPayloadOpts, ...(getCorporateProductionSmokeCounters() ? { maxRetries: 0 } : {}) })
			configureCorporateProductionSmokeClient(client)
			return client
		}
		const headers = parseHeadersJSON(thisConfig.headersJSON)
		return new OpenAI({ baseURL: thisConfig.endpoint, apiKey: thisConfig.apiKey, defaultHeaders: headers, ...commonPayloadOpts })
	}
	else if (providerName === 'groq') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: 'https://api.groq.com/openai/v1', apiKey: thisConfig.apiKey, ...commonPayloadOpts })
	}
	else if (providerName === 'xAI') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: 'https://api.x.ai/v1', apiKey: thisConfig.apiKey, ...commonPayloadOpts })
	}
	else if (providerName === 'mistral') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: 'https://api.mistral.ai/v1', apiKey: thisConfig.apiKey, ...commonPayloadOpts })
	}

	else throw new Error(`Void providerName was invalid: ${providerName}.`)
}


const _sendOpenAICompatibleFIM = async ({ messages: { prefix, suffix, stopTokens }, onFinalMessage, onError, settingsOfProvider, modelName: modelName_, _setAborter, providerName, overridesOfModel }: SendFIMParams_Internal) => {

	const {
		modelName,
		supportsFIM,
		additionalOpenAIPayload,
	} = getModelCapabilities(providerName, modelName_, overridesOfModel)
	if (!supportsFIM) {
		if (modelName === modelName_)
			onError({ message: `Model ${modelName} does not support FIM.`, fullError: null })
		else
			onError({ message: `Model ${modelName_} (${modelName}) does not support FIM.`, fullError: null })
		return
	}

	const openai = await newOpenAICompatibleSDK({ providerName, settingsOfProvider, includeInPayload: additionalOpenAIPayload })
	openai.completions
		.create({
			model: modelName,
			prompt: prefix,
			suffix: suffix,
			stop: stopTokens,
			max_tokens: 300,
		})
		.then(async response => {
			const fullText = response.choices[0]?.text
			onFinalMessage({ fullText, fullReasoning: '', anthropicReasoning: null });
		})
		.catch(error => {
			if (error instanceof OpenAI.APIError && error.status === 401) { onError({ message: invalidApiKeyMessage(providerName), fullError: error }); }
			else { onError({ message: error + '', fullError: error }); }
		})
}


const toOpenAICompatibleTool = (toolInfo: InternalToolInfo) => {
	const { name, description, params } = toolInfo

	const paramsWithType: { [s: string]: { description: string; type: 'string' } } = {}
	for (const key in params) { paramsWithType[key] = { ...params[key], type: 'string' } }

	return {
		type: 'function',
		function: {
			name: name,
			// strict: true, // strict mode - https://platform.openai.com/docs/guides/function-calling?api-mode=chat
			description: description,
			parameters: toolInfo.schema ?? {
				type: 'object',
				properties: params,
				// required: Object.keys(params), // in strict mode, all params are required and additionalProperties is false
				// additionalProperties: false,
			},
		}
	} satisfies OpenAI.Chat.Completions.ChatCompletionTool
}

export const openAITools = (chatMode: ChatMode | null, mcpTools: InternalToolInfo[] | undefined, toolExecutionProfile: ToolExecutionProfile = 'default-parent', agentDelegationAllowed = false, frozenToolSnapshot?: AgentSubagentToolSnapshot) => {
	const allowedTools = availableTools(chatMode, mcpTools, toolExecutionProfile, agentDelegationAllowed, frozenToolSnapshot)
	if (!allowedTools || Object.keys(allowedTools).length === 0) return null

	const openAITools: OpenAI.Chat.Completions.ChatCompletionTool[] = []
	for (const t in allowedTools ?? {}) {
		openAITools.push(toOpenAICompatibleTool(allowedTools[t]))
	}
	return openAITools
}


// convert LLM tool call to our tool format
const rawToolCallObjOfParamsStr = (name: string, toolParamsStr: string, id: string): RawToolCallObj | null => {
	let input: unknown
	try { input = JSON.parse(toolParamsStr) }
	catch (e) { return null }

	if (input === null) return null
	if (typeof input !== 'object' || Array.isArray(input)) return null

	const rawParams = input as RawToolParamsObj
	return { id, name, rawParams, doneParams: Object.keys(rawParams), isDone: true }
}


const rawToolCallObjOfAnthropicParams = (toolBlock: Anthropic.Messages.ToolUseBlock): RawToolCallObj | null => {
	const { id, name, input } = toolBlock

	if (input === null) return null
	if (typeof input !== 'object' || Array.isArray(input)) return null

	const rawParams = input as RawToolParamsObj
	return { id, name, rawParams, doneParams: Object.keys(rawParams), isDone: true }
}


// ------------ OPENAI-COMPATIBLE ------------

const GHOST_CHAT_MAX_COMPLETION_TOKENS = 256

const _sendOpenAICompatibleChat = async ({ messages, onText, onFinalMessage, onError, settingsOfProvider, modelSelectionOptions, modelName: modelName_, _setAborter, providerName, chatMode, separateSystemMessage, overridesOfModel, mcpTools, toolExecutionProfile, frozenToolSnapshot, agentDelegationAllowed, requestProfile }: SendChatParams_Internal) => {
	const isGhostChat = requestProfile === 'ghost-chat'
	const {
		modelName,
		specialToolFormat,
		reasoningCapabilities,
		additionalOpenAIPayload,
	} = getModelCapabilities(providerName, modelName_, overridesOfModel)
	if (chatMode === 'agent' && specialToolFormat !== 'openai-style') {
		onError({ message: 'Agent mode requires a native tool-calling model; XML tool fallback is disabled.', fullError: null })
		return
	}

	const { providerReasoningIOSettings } = getProviderCapabilities(providerName)

	// reasoning
	const { canIOReasoning, openSourceThinkTags } = reasoningCapabilities || {}
	const reasoningInfo = getSendableReasoningInfo('Chat', providerName, modelName_, modelSelectionOptions, overridesOfModel) // user's modelName_ here

	const includeInPayload = isGhostChat ? {} : {
		...providerReasoningIOSettings?.input?.includeInPayload?.(reasoningInfo),
		...additionalOpenAIPayload
	}

	// tools
	const potentialTools = isGhostChat ? null : openAITools(chatMode, mcpTools, toolExecutionProfile, agentDelegationAllowed, frozenToolSnapshot)
	const nativeToolsObj = potentialTools && specialToolFormat === 'openai-style' ?
		{ tools: potentialTools } as const
		: {}

	// instance
	const openai: OpenAI = await newOpenAICompatibleSDK({ providerName, settingsOfProvider, includeInPayload })
	if (providerName === 'microsoftAzure') {
		// Required to select the model
		(openai as AzureOpenAI).deploymentName = modelName;
	}
	if (corporateProductionSmokeClients.has(openai)) {
		const counters = getCorporateProductionSmokeCounters();
		if (counters) counters.nativeAgentToolSchema = specialToolFormat === 'openai-style' && !!potentialTools?.some(tool => corporateProductionSmokeNativeToolNames.has(tool.function.name));
	}
	const options = {
		model: wireModelNameFor(providerName, modelName),
		messages: messages as any,
		stream: true,
		...nativeToolsObj,
		...(isGhostChat ? {} : additionalOpenAIPayload),
		...(isGhostChat ? { reasoning_effort: 'none', max_completion_tokens: GHOST_CHAT_MAX_COMPLETION_TOKENS } : {})
		// max_completion_tokens: maxTokens,
	} as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming

	// open source models - manually parse think tokens
	const { needsManualParse: needsManualReasoningParse, nameOfFieldInDelta: nameOfReasoningFieldInDelta } = providerReasoningIOSettings?.output ?? {}
	const manuallyParseReasoning = needsManualReasoningParse && canIOReasoning && openSourceThinkTags
	if (manuallyParseReasoning) {
		const { newOnText, newOnFinalMessage } = extractReasoningWrapper(onText, onFinalMessage, openSourceThinkTags)
		onText = newOnText
		onFinalMessage = newOnFinalMessage
	}

	// manually parse out tool results if XML
	if (!isGhostChat && !specialToolFormat) {
		const { newOnText, newOnFinalMessage } = extractXMLToolsWrapper(onText, onFinalMessage, chatMode, mcpTools, toolExecutionProfile, agentDelegationAllowed, frozenToolSnapshot)
		onText = newOnText
		onFinalMessage = newOnFinalMessage
	}

	let fullReasoningSoFar = ''
	let fullTextSoFar = ''

	const streamedTools = new Map<number, { name: string; id: string; params: string; idConflict: boolean }>()
	let sawInvalidToolIndex = false
	const requestController = new AbortController()
	_setAborter(() => requestController.abort())

	const consumeResponse = async (response: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk> & { controller: AbortController }, diagnostics: OpenAICompatibleStreamDiagnostics | undefined) => {
			_setAborter(() => {
				requestController.abort()
				response.controller.abort()
			})
			// when receive text
			for await (const chunk of response) {
				diagnostics && (diagnostics.firstParsedStreamEvent = true);
				// message
				const newText = chunk.choices[0]?.delta?.content ?? ''
				fullTextSoFar += newText

				// tool call
				for (const tool of chunk.choices[0]?.delta?.tool_calls ?? []) {
					const index = tool.index
					if (!Number.isInteger(index) || index < 0) { sawInvalidToolIndex = true; continue }
					const current = streamedTools.get(index) ?? { name: '', id: '', params: '', idConflict: false }
					current.name += tool.function?.name ?? ''
					current.params += tool.function?.arguments ?? ''
					if (tool.id) {
						if (!current.id) current.id = tool.id
						else if (current.id !== tool.id) current.idConflict = true
					}
					streamedTools.set(index, current)
				}


				// reasoning
				let newReasoning = ''
				if (nameOfReasoningFieldInDelta) {
					// @ts-ignore
					newReasoning = (chunk.choices[0]?.delta?.[nameOfReasoningFieldInDelta] || '') + ''
					fullReasoningSoFar += newReasoning
				}

				// call onText
				onText({
					fullText: fullTextSoFar,
					fullReasoning: fullReasoningSoFar,
					toolCalls: [...streamedTools.entries()].sort(([a], [b]) => a - b).filter(([, tool]) => !!tool.name).map(([, tool]) => ({ name: tool.name as ToolName, rawParams: {}, isDone: false, doneParams: [], id: tool.id })),
				})

			}
			// on final
			if (!fullTextSoFar && !fullReasoningSoFar && streamedTools.size === 0) {
				onError({ message: 'Void: Response from model was empty.', fullError: null })
				return false
			}
			else {
				const toolCalls = [...streamedTools.entries()].sort(([a], [b]) => a - b).map(([, tool]) => rawToolCallObjOfParamsStr(tool.name, tool.params, tool.id)).filter((tool): tool is RawToolCallObj => !!tool)
				const indexes = [...streamedTools.keys()].sort((a, b) => a - b)
				const contiguous = indexes.every((index, ordinal) => index === ordinal)
				if (sawInvalidToolIndex || !contiguous || [...streamedTools.values()].some(tool => tool.idConflict) || toolCalls.length !== streamedTools.size || new Set(toolCalls.map(tool => tool.id)).size !== toolCalls.length || toolCalls.some(tool => !tool.id)) { onError({ message: 'Void: provider returned an invalid, gapped, duplicate, or conflicting tool-call batch.', fullError: null }); return false }
				onFinalMessage({ fullText: fullTextSoFar, fullReasoning: fullReasoningSoFar, anthropicReasoning: null, toolCalls });
				return true
			}
	}
	const onErrorFromStream = (error: any, diagnostics: OpenAICompatibleStreamDiagnostics | undefined) => {
			if (diagnostics && isPrematureStreamClose(error)) {
				onError({ message: formatPrematureStreamCloseMessage(diagnostics), fullError: error });
				return;
			}
			if (error instanceof OpenAI.APIError && error.status === 401) { onError({ message: invalidApiKeyMessage(providerName), fullError: error }); }
			else { onError({ message: error + '', fullError: error }); }
	}

	if (providerName === 'openAICompatible') {
		const diagnostics: OpenAICompatibleStreamDiagnostics = {
			endpoint: redactOpenAICompatibleEndpoint(openai.baseURL),
			model: modelName,
			chatMode,
			toolCount: potentialTools?.length ?? 0,
			toolSchemaDialect: classifyOpenAICompatibleToolSchemaDialect(potentialTools ?? undefined),
			dispatchAttempted: true,
			responseHeadersReceived: false,
			httpStatus: undefined,
			requestId: undefined,
			firstParsedStreamEvent: false,
		};
		try {
			const { data: response, response: rawResponse, request_id } = await openai.chat.completions.create(options, { signal: requestController.signal }).withResponse()
			diagnostics.responseHeadersReceived = true;
			diagnostics.httpStatus = rawResponse.status;
			diagnostics.requestId = request_id ?? undefined;
			const completed = await consumeResponse(response, diagnostics);
			if (completed && corporateProductionSmokeClients.has(openai)) {
				const counters = getCorporateProductionSmokeCounters();
				if (counters) counters.completed += 1;
			}
		}
		catch (error) {
			onErrorFromStream(error, diagnostics)
		}
	}
	else {
		try {
			const response = await openai.chat.completions.create(options, { signal: requestController.signal })
			await consumeResponse(response, undefined)
		}
		catch (error) {
			onErrorFromStream(error, undefined)
		}
	}
}



type OpenAIModel = {
	id: string;
	created: number;
	object: 'model';
	owned_by: string;
}
const _openaiCompatibleList = async ({ onSuccess: onSuccess_, onError: onError_, settingsOfProvider, providerName }: ListParams_Internal<OpenAIModel>) => {
	const onSuccess = ({ models }: { models: OpenAIModel[] }) => {
		onSuccess_({ models })
	}
	const onError = ({ error }: { error: string }) => {
		onError_({ error })
	}
	try {
		const openai = await newOpenAICompatibleSDK({ providerName, settingsOfProvider })
		openai.models.list()
			.then(async (response) => {
				const models: OpenAIModel[] = []
				models.push(...response.data)
				while (response.hasNextPage()) {
					models.push(...(await response.getNextPage()).data)
				}
				onSuccess({ models })
			})
			.catch((error) => {
				onError({ error: error + '' })
			})
	}
	catch (error) {
		onError({ error: error + '' })
	}
}




// ------------ ANTHROPIC (HELPERS) ------------
const toAnthropicTool = (toolInfo: InternalToolInfo) => {
	const { name, description, params } = toolInfo
	const paramsWithType: { [s: string]: { description: string; type: 'string' } } = {}
	for (const key in params) { paramsWithType[key] = { ...params[key], type: 'string' } }
	return {
		name: name,
		description: description,
		input_schema: toolInfo.schema ? {
			...toolInfo.schema,
			type: 'object',
		} : {
			type: 'object',
			properties: paramsWithType,
			// required: Object.keys(params),
		},
	} satisfies Anthropic.Messages.Tool
}

export const anthropicTools = (chatMode: ChatMode | null, mcpTools: InternalToolInfo[] | undefined, toolExecutionProfile: ToolExecutionProfile = 'default-parent', agentDelegationAllowed = false, frozenToolSnapshot?: AgentSubagentToolSnapshot) => {
	const allowedTools = availableTools(chatMode, mcpTools, toolExecutionProfile, agentDelegationAllowed, frozenToolSnapshot)
	if (!allowedTools || Object.keys(allowedTools).length === 0) return null

	const anthropicTools: Anthropic.Messages.ToolUnion[] = []
	for (const t in allowedTools ?? {}) {
		anthropicTools.push(toAnthropicTool(allowedTools[t]))
	}
	return anthropicTools
}



// ------------ ANTHROPIC ------------
type AnthropicToolPreview = { name: ToolName; id: string; partialJson: string };

/**
 * The streamed Anthropic preview is deliberately separate from final-message
 * parsing.  A provider can interleave JSON deltas for several `tool_use`
 * blocks, so a single accumulated name/JSON string would silently turn two
 * calls into one misleading preview.
 */
export const createAnthropicToolPreviewAccumulator = () => {
	const callsByContentIndex = new Map<number, AnthropicToolPreview>();
	const contentIndexById = new Map<string, number>();
	let malformed = false;

	const start = (contentIndex: unknown, block: { type?: unknown; name?: unknown; id?: unknown }): boolean => {
		if (!Number.isInteger(contentIndex) || (contentIndex as number) < 0 || block.type !== 'tool_use' || typeof block.name !== 'string' || !block.name || typeof block.id !== 'string' || !block.id) {
			malformed = true;
			return false;
		}
		const index = contentIndex as number;
		if (callsByContentIndex.has(index) || contentIndexById.has(block.id)) {
			malformed = true;
			return false;
		}
		callsByContentIndex.set(index, { name: block.name as ToolName, id: block.id, partialJson: '' });
		contentIndexById.set(block.id, index);
		return true;
	};

	const appendJson = (contentIndex: unknown, partialJson: unknown): boolean => {
		if (malformed || !Number.isInteger(contentIndex) || (contentIndex as number) < 0 || typeof partialJson !== 'string') {
			malformed = true;
			return false;
		}
		const call = callsByContentIndex.get(contentIndex as number);
		if (!call) {
			malformed = true;
			return false;
		}
		call.partialJson += partialJson;
		return true;
	};

	return {
		start,
		appendJson,
		get malformed() { return malformed; },
		preview: (): AnthropicToolPreview[] => [...callsByContentIndex.entries()].sort(([left], [right]) => left - right).map(([, call]) => ({ ...call })),
	};
};

const sendAnthropicChat = async ({ messages, providerName, onText, onFinalMessage, onError, settingsOfProvider, modelSelectionOptions, overridesOfModel, modelName: modelName_, _setAborter, separateSystemMessage, chatMode, mcpTools, toolExecutionProfile, frozenToolSnapshot, agentDelegationAllowed }: SendChatParams_Internal) => {
	const {
		modelName,
		specialToolFormat,
	} = getModelCapabilities(providerName, modelName_, overridesOfModel)
	if (chatMode === 'agent' && specialToolFormat !== 'anthropic-style') {
		onError({ message: 'Agent mode requires a native tool-calling model; XML tool fallback is disabled.', fullError: null })
		return
	}

	const thisConfig = settingsOfProvider.anthropic
	const { providerReasoningIOSettings } = getProviderCapabilities(providerName)

	// reasoning
	const reasoningInfo = getSendableReasoningInfo('Chat', providerName, modelName_, modelSelectionOptions, overridesOfModel) // user's modelName_ here
	const includeInPayload = providerReasoningIOSettings?.input?.includeInPayload?.(reasoningInfo) || {}

	// anthropic-specific - max tokens
	const maxTokens = getReservedOutputTokenSpace(providerName, modelName_, { isReasoningEnabled: !!reasoningInfo?.isReasoningEnabled, overridesOfModel })

	// tools
	const potentialTools = anthropicTools(chatMode, mcpTools, toolExecutionProfile, agentDelegationAllowed, frozenToolSnapshot)
	const nativeToolsObj = potentialTools && specialToolFormat === 'anthropic-style' ?
		{ tools: potentialTools, tool_choice: { type: 'auto' } } as const
		: {}


	// instance
	const anthropic = new Anthropic({
		apiKey: thisConfig.apiKey,
		dangerouslyAllowBrowser: true
	});

	const stream = anthropic.messages.stream({
		system: separateSystemMessage ?? undefined,
		messages: messages as AnthropicLLMChatMessage[],
		model: modelName,
		max_tokens: maxTokens ?? 4_096, // anthropic requires this
		...includeInPayload,
		...nativeToolsObj,

	})

	// manually parse out tool results if XML
	if (!specialToolFormat) {
		const { newOnText, newOnFinalMessage } = extractXMLToolsWrapper(onText, onFinalMessage, chatMode, mcpTools, toolExecutionProfile, agentDelegationAllowed, frozenToolSnapshot)
		onText = newOnText
		onFinalMessage = newOnFinalMessage
	}

	// when receive text
	let fullText = ''
	let fullReasoning = ''

	const toolPreview = createAnthropicToolPreviewAccumulator()
	let malformedToolPreviewReported = false
	const rejectMalformedToolPreview = () => {
		if (malformedToolPreviewReported) return
		malformedToolPreviewReported = true
		onError({ message: 'Void: provider returned an invalid or duplicate streamed tool-call batch.', fullError: null })
	}

	const runOnText = () => {
		if (toolPreview.malformed) return
		onText({
			fullText,
			fullReasoning,
			toolCalls: toolPreview.preview().map(tool => ({ name: tool.name, rawParams: {}, isDone: false, doneParams: [], id: tool.id })),
		})
	}
	// there are no events for tool_use, it comes in at the end
	stream.on('streamEvent', e => {
		// start block
		if (e.type === 'content_block_start') {
			if (e.content_block.type === 'text') {
				if (fullText) fullText += '\n\n' // starting a 2nd text block
				fullText += e.content_block.text
				runOnText()
			}
			else if (e.content_block.type === 'thinking') {
				if (fullReasoning) fullReasoning += '\n\n' // starting a 2nd reasoning block
				fullReasoning += e.content_block.thinking
				runOnText()
			}
			else if (e.content_block.type === 'redacted_thinking') {
				console.log('delta', e.content_block.type)
				if (fullReasoning) fullReasoning += '\n\n' // starting a 2nd reasoning block
				fullReasoning += '[redacted_thinking]'
				runOnText()
			}
			else if (e.content_block.type === 'tool_use') {
				if (toolPreview.start(e.index, e.content_block)) runOnText()
				else rejectMalformedToolPreview()
			}
		}

		// delta
		else if (e.type === 'content_block_delta') {
			if (e.delta.type === 'text_delta') {
				fullText += e.delta.text
				runOnText()
			}
			else if (e.delta.type === 'thinking_delta') {
				fullReasoning += e.delta.thinking
				runOnText()
			}
			else if (e.delta.type === 'input_json_delta') { // tool use
				if (toolPreview.appendJson(e.index, e.delta.partial_json)) runOnText()
				else rejectMalformedToolPreview()
			}
		}
	})

	// on done - (or when error/fail) - this is called AFTER last streamEvent
	stream.on('finalMessage', (response) => {
		if (toolPreview.malformed) { rejectMalformedToolPreview(); return }
		const anthropicReasoning = response.content.filter(c => c.type === 'thinking' || c.type === 'redacted_thinking')
		const tools = response.content.filter(c => c.type === 'tool_use')
		// console.log('TOOLS!!!!!!', JSON.stringify(tools, null, 2))
		// console.log('TOOLS!!!!!!', JSON.stringify(response, null, 2))
		const toolCalls = tools.map(rawToolCallObjOfAnthropicParams).filter((tool): tool is RawToolCallObj => !!tool)
		if (toolCalls.length !== tools.length || new Set(toolCalls.map(tool => tool.id)).size !== toolCalls.length || toolCalls.some(tool => !tool.id)) { onError({ message: 'Void: provider returned an invalid or duplicate tool-call batch.', fullError: null }); return }
		onFinalMessage({ fullText, fullReasoning, anthropicReasoning, toolCalls })
	})
	// on error
	stream.on('error', (error) => {
		if (error instanceof Anthropic.APIError && error.status === 401) { onError({ message: invalidApiKeyMessage(providerName), fullError: error }) }
		else { onError({ message: error + '', fullError: error }) }
	})
	_setAborter(() => stream.controller.abort())
}



// ------------ MISTRAL ------------
// https://docs.mistral.ai/api/#tag/fim
const sendMistralFIM = ({ messages, onFinalMessage, onError, settingsOfProvider, overridesOfModel, modelName: modelName_, _setAborter, providerName }: SendFIMParams_Internal) => {
	const { modelName, supportsFIM } = getModelCapabilities(providerName, modelName_, overridesOfModel)
	if (!supportsFIM) {
		if (modelName === modelName_)
			onError({ message: `Model ${modelName} does not support FIM.`, fullError: null })
		else
			onError({ message: `Model ${modelName_} (${modelName}) does not support FIM.`, fullError: null })
		return
	}

	const mistral = new MistralCore({ apiKey: settingsOfProvider.mistral.apiKey })
	fimComplete(mistral,
		{
			model: modelName,
			prompt: messages.prefix,
			suffix: messages.suffix,
			stream: false,
			maxTokens: 300,
			stop: messages.stopTokens,
		})
		.then(async response => {

			// unfortunately, _setAborter() does not exist
			let content = response?.ok ? response.value.choices?.[0]?.message?.content ?? '' : '';
			const fullText = typeof content === 'string' ? content
				: content.map(chunk => (chunk.type === 'text' ? chunk.text : '')).join('')

			onFinalMessage({ fullText, fullReasoning: '', anthropicReasoning: null });
		})
		.catch(error => {
			onError({ message: error + '', fullError: error });
		})
}


// ------------ OLLAMA ------------
const newOllamaSDK = ({ endpoint }: { endpoint: string }) => {
	// if endpoint is empty, normally ollama will send to 11434, but we want it to fail - the user should type it in
	if (!endpoint) throw new Error(`Ollama Endpoint was empty (please enter ${defaultProviderSettings.ollama.endpoint} in Void if you want the default url).`)
	const ollama = new Ollama({ host: endpoint })
	return ollama
}

const ollamaList = async ({ onSuccess: onSuccess_, onError: onError_, settingsOfProvider }: ListParams_Internal<OllamaModelResponse>) => {
	const onSuccess = ({ models }: { models: OllamaModelResponse[] }) => {
		onSuccess_({ models })
	}
	const onError = ({ error }: { error: string }) => {
		onError_({ error })
	}
	try {
		const thisConfig = settingsOfProvider.ollama
		const ollama = newOllamaSDK({ endpoint: thisConfig.endpoint })
		ollama.list()
			.then((response) => {
				const { models } = response
				onSuccess({ models })
			})
			.catch((error) => {
				onError({ error: error + '' })
			})
	}
	catch (error) {
		onError({ error: error + '' })
	}
}

const sendOllamaFIM = ({ messages, onFinalMessage, onError, settingsOfProvider, modelName, _setAborter }: SendFIMParams_Internal) => {
	const thisConfig = settingsOfProvider.ollama
	const ollama = newOllamaSDK({ endpoint: thisConfig.endpoint })

	let fullText = ''
	ollama.generate({
		model: modelName,
		prompt: messages.prefix,
		suffix: messages.suffix,
		options: {
			stop: messages.stopTokens,
			num_predict: 300, // max tokens
			// repeat_penalty: 1,
		},
		raw: true,
		stream: true, // stream is not necessary but lets us expose the
	})
		.then(async stream => {
			_setAborter(() => stream.abort())
			for await (const chunk of stream) {
				const newText = chunk.response
				fullText += newText
			}
			onFinalMessage({ fullText, fullReasoning: '', anthropicReasoning: null })
		})
		// when error/fail
		.catch((error) => {
			onError({ message: error + '', fullError: error })
		})
}

// ---------------- GEMINI NATIVE IMPLEMENTATION ----------------

/** Gemini uses its own enum values and supports anyOf rather than JSON Schema oneOf. */
const toGeminiSchema = (schema: Record<string, unknown>): Schema => {
	const typeOf: Record<string, Type> = { object: Type.OBJECT, array: Type.ARRAY, string: Type.STRING, number: Type.NUMBER, integer: Type.INTEGER, boolean: Type.BOOLEAN };
	const converted: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(schema)) {
		if (key === 'type' && typeof value === 'string') converted.type = typeOf[value] ?? value;
		else if (key === 'properties' && value && typeof value === 'object') converted.properties = Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, child]) => [name, toGeminiSchema(child as Record<string, unknown>)]));
		else if (key === 'items' && value && typeof value === 'object') converted.items = toGeminiSchema(value as Record<string, unknown>);
		else if (key === 'oneOf') converted.anyOf = (value as Record<string, unknown>[]).map(child => toGeminiSchema(child));
		else if (key === 'const') converted.enum = [value];
		else if (['minItems', 'maxItems', 'minLength', 'maxLength', 'maxProperties', 'minProperties'].includes(key) && typeof value === 'number') converted[key] = String(value);
		else if (key !== 'additionalProperties' && key !== 'not') converted[key] = value;
	}
	return converted as Schema;
}

const toGeminiFunctionDecl = (toolInfo: InternalToolInfo) => {
	const { name, description, params } = toolInfo
	return {
		name,
		description,
		parameters: toolInfo.schema ? toGeminiSchema(toolInfo.schema) : {
			type: Type.OBJECT,
			properties: Object.entries(params).reduce((acc, [key, value]) => {
				acc[key] = {
					type: Type.STRING,
					description: value.description
				};
				return acc;
			}, {} as Record<string, Schema>)
		}
	} satisfies FunctionDeclaration
}

export const geminiTools = (chatMode: ChatMode | null, mcpTools: InternalToolInfo[] | undefined, toolExecutionProfile: ToolExecutionProfile = 'default-parent', agentDelegationAllowed = false, frozenToolSnapshot?: AgentSubagentToolSnapshot): GeminiTool[] | null => {
	const allowedTools = availableTools(chatMode, mcpTools, toolExecutionProfile, agentDelegationAllowed, frozenToolSnapshot)
	if (!allowedTools || Object.keys(allowedTools).length === 0) return null
	const functionDecls: FunctionDeclaration[] = []
	for (const t in allowedTools ?? {}) {
		functionDecls.push(toGeminiFunctionDecl(allowedTools[t]))
	}
	const tools: GeminiTool = { functionDeclarations: functionDecls, }
	return [tools]
}



// Implementation for Gemini using Google's native API
type GeminiToolPreview = { name: string; params: string; id: string };

/**
 * Gemini does not consistently supply function-call IDs.  An ID-bearing call
 * can be retransmitted verbatim in a later chunk, but an id-less call in any
 * later nonempty chunk cannot be distinguished from a second declaration.
 */
export const createGeminiToolCallAccumulator = () => {
	const calls: GeminiToolPreview[] = [];
	const callsByProviderId = new Map<string, GeminiToolPreview>();
	let sawNonemptyChunk = false;
	let malformed = false;

	const consumeChunk = (functionCalls: readonly { id?: unknown; name?: unknown; args?: unknown }[] | undefined): boolean => {
		if (malformed || !functionCalls?.length) return !malformed;
		const isLaterNonemptyChunk = sawNonemptyChunk;
		sawNonemptyChunk = true;
		const idsInThisChunk = new Set<string>();
		for (const functionCall of functionCalls) {
			if (typeof functionCall.name !== 'string' || !functionCall.name) { malformed = true; return false; }
			let params: string;
			try { params = JSON.stringify(functionCall.args ?? {}); }
			catch { malformed = true; return false; }
			if (typeof params !== 'string') { malformed = true; return false; }
			if (typeof functionCall.id === 'string' && functionCall.id) {
				if (idsInThisChunk.has(functionCall.id)) { malformed = true; return false; }
				idsInThisChunk.add(functionCall.id);
				const previous = callsByProviderId.get(functionCall.id);
				if (previous) {
					if (previous.name !== functionCall.name || previous.params !== params) { malformed = true; return false; }
					continue; // demonstrable retransmission
				}
				const call = { name: functionCall.name, params, id: functionCall.id };
				callsByProviderId.set(functionCall.id, call);
				calls.push(call);
			}
			else {
				if (isLaterNonemptyChunk) { malformed = true; return false; }
				calls.push({ name: functionCall.name, params, id: generateUuid() });
			}
		}
		return true;
	};

	return {
		consumeChunk,
		get malformed() { return malformed; },
		calls: (): GeminiToolPreview[] => calls.map(call => ({ ...call })),
	};
};

const sendGeminiChat = async ({
	messages,
	separateSystemMessage,
	onText,
	onFinalMessage,
	onError,
	settingsOfProvider,
	overridesOfModel,
	modelName: modelName_,
	_setAborter,
	providerName,
	modelSelectionOptions,
	chatMode,
	mcpTools,
	toolExecutionProfile,
	frozenToolSnapshot,
	agentDelegationAllowed,
}: SendChatParams_Internal) => {

	if (providerName !== 'gemini') throw new Error(`Sending Gemini chat, but provider was ${providerName}`)

	const thisConfig = settingsOfProvider[providerName]

	const {
		modelName,
		specialToolFormat,
		// reasoningCapabilities,
	} = getModelCapabilities(providerName, modelName_, overridesOfModel)
	if (chatMode === 'agent' && specialToolFormat !== 'gemini-style') {
		onError({ message: 'Agent mode requires a native tool-calling model; XML tool fallback is disabled.', fullError: null })
		return
	}

	// const { providerReasoningIOSettings } = getProviderCapabilities(providerName)

	// reasoning
	// const { canIOReasoning, openSourceThinkTags, } = reasoningCapabilities || {}
	const reasoningInfo = getSendableReasoningInfo('Chat', providerName, modelName_, modelSelectionOptions, overridesOfModel) // user's modelName_ here
	// const includeInPayload = providerReasoningIOSettings?.input?.includeInPayload?.(reasoningInfo) || {}

	const thinkingConfig: ThinkingConfig | undefined = !reasoningInfo?.isReasoningEnabled ? undefined
		: reasoningInfo.type === 'budget_slider_value' ?
			{ thinkingBudget: reasoningInfo.reasoningBudget }
			: undefined

	// tools
	const potentialTools = geminiTools(chatMode, mcpTools, toolExecutionProfile, agentDelegationAllowed, frozenToolSnapshot)
	const toolConfig = potentialTools && specialToolFormat === 'gemini-style' ?
		potentialTools
		: undefined

	// instance
	const genAI = new GoogleGenAI({ apiKey: thisConfig.apiKey });


	// manually parse out tool results if XML
	if (!specialToolFormat) {
		const { newOnText, newOnFinalMessage } = extractXMLToolsWrapper(onText, onFinalMessage, chatMode, mcpTools, toolExecutionProfile, agentDelegationAllowed, frozenToolSnapshot)
		onText = newOnText
		onFinalMessage = newOnFinalMessage
	}

	// when receive text
	let fullReasoningSoFar = ''
	let fullTextSoFar = ''

	const streamedCalls = createGeminiToolCallAccumulator()


	genAI.models.generateContentStream({
		model: modelName,
		config: {
			systemInstruction: separateSystemMessage,
			thinkingConfig: thinkingConfig,
			tools: toolConfig,
		},
		contents: messages as GeminiLLMChatMessage[],
	})
		.then(async (stream) => {
			_setAborter(() => { stream.return(fullTextSoFar); });

			// Process the stream
			for await (const chunk of stream) {
				// message
				const newText = chunk.text ?? ''
				fullTextSoFar += newText

				// tool call
				streamedCalls.consumeChunk(chunk.functionCalls)

				// (do not handle reasoning yet)

				// call onText
				onText({
					fullText: fullTextSoFar,
					fullReasoning: fullReasoningSoFar,
					toolCalls: streamedCalls.calls().map(tool => ({ name: tool.name as ToolName, rawParams: {}, isDone: false, doneParams: [], id: tool.id })),
				})
			}

			// on final
			if (!fullTextSoFar && !fullReasoningSoFar && streamedCalls.calls().length === 0) {
				onError({ message: 'Void: Response from model was empty.', fullError: null })
			} else {
				const calls = streamedCalls.calls()
				const toolCalls = calls.map(tool => rawToolCallObjOfParamsStr(tool.name, tool.params, tool.id)).filter((tool): tool is RawToolCallObj => !!tool)
				if (streamedCalls.malformed || toolCalls.length !== calls.length || new Set(toolCalls.map(tool => tool.id)).size !== toolCalls.length || toolCalls.some(tool => !tool.id)) { onError({ message: 'Void: provider returned an invalid, duplicate, or ambiguous id-less tool-call batch.', fullError: null }); return }
				onFinalMessage({ fullText: fullTextSoFar, fullReasoning: fullReasoningSoFar, anthropicReasoning: null, toolCalls });
			}
		})
		.catch(error => {
			const message = error?.message
			if (typeof message === 'string') {

				if (error.message?.includes('API key')) {
					onError({ message: invalidApiKeyMessage(providerName), fullError: error });
				}
				else if (error?.message?.includes('429')) {
					onError({ message: 'Rate limit reached. ' + error, fullError: error });
				}
				else
					onError({ message: error + '', fullError: error });
			}
			else {
				onError({ message: error + '', fullError: error });
			}
		})
};



type CallFnOfProvider = {
	[providerName in ProviderName]: {
		sendChat: (params: SendChatParams_Internal) => Promise<void>;
		sendFIM: ((params: SendFIMParams_Internal) => void) | null;
		list: ((params: ListParams_Internal<any>) => void) | null;
	}
}

export const sendLLMMessageToProviderImplementation = {
	anthropic: {
		sendChat: sendAnthropicChat,
		sendFIM: null,
		list: null,
	},
	openAI: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: null,
		list: null,
	},
	xAI: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: null,
		list: null,
	},
	gemini: {
		sendChat: (params) => sendGeminiChat(params),
		sendFIM: null,
		list: null,
	},
	mistral: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: (params) => sendMistralFIM(params),
		list: null,
	},
	ollama: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: sendOllamaFIM,
		list: ollamaList,
	},
	openAICompatible: {
		sendChat: (params) => _sendOpenAICompatibleChat(params), // using openai's SDK is not ideal (your implementation might not do tools, reasoning, FIM etc correctly), talk to us for a custom integration
		sendFIM: (params) => _sendOpenAICompatibleFIM(params),
		list: null,
	},
	openRouter: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: (params) => _sendOpenAICompatibleFIM(params),
		list: null,
	},
	vLLM: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: (params) => _sendOpenAICompatibleFIM(params),
		list: (params) => _openaiCompatibleList(params),
	},
	deepseek: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: null,
		list: null,
	},
	groq: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: null,
		list: null,
	},

	lmStudio: {
		// lmStudio has no suffix parameter in /completions, so sendFIM might not work
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: (params) => _sendOpenAICompatibleFIM(params),
		list: (params) => _openaiCompatibleList(params),
	},
	liteLLM: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: (params) => _sendOpenAICompatibleFIM(params),
		list: null,
	},
	googleVertex: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: null,
		list: null,
	},
	microsoftAzure: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: null,
		list: null,
	},
	awsBedrock: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: null,
		list: null,
	},

} satisfies CallFnOfProvider




/*
FIM info (this may be useful in the future with vLLM, but in most cases the only way to use FIM is if the provider explicitly supports it):

qwen2.5-coder https://ollama.com/library/qwen2.5-coder/blobs/e94a8ecb9327
<|fim_prefix|>{{ .Prompt }}<|fim_suffix|>{{ .Suffix }}<|fim_middle|>

codestral https://ollama.com/library/codestral/blobs/51707752a87c
[SUFFIX]{{ .Suffix }}[PREFIX] {{ .Prompt }}

deepseek-coder-v2 https://ollama.com/library/deepseek-coder-v2/blobs/22091531faf0
<｜fim▁begin｜>{{ .Prompt }}<｜fim▁hole｜>{{ .Suffix }}<｜fim▁end｜>

starcoder2 https://ollama.com/library/starcoder2/blobs/3b190e68fefe
<file_sep>
<fim_prefix>
{{ .Prompt }}<fim_suffix>{{ .Suffix }}<fim_middle>
<|end_of_text|>

codegemma https://ollama.com/library/codegemma:2b/blobs/48d9a8140749
<|fim_prefix|>{{ .Prompt }}<|fim_suffix|>{{ .Suffix }}<|fim_middle|>

*/
