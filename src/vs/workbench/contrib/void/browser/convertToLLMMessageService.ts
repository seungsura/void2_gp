import { Disposable } from '../../../../base/common/lifecycle.js';
import { deepClone } from '../../../../base/common/objects.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ChatMessage } from '../common/chatThreadServiceTypes.js';
import { getIsReasoningEnabledState, getReservedOutputTokenSpace, getModelCapabilities } from '../common/modelCapabilities.js';
import { reParsedToolXMLString, chat_systemMessage } from '../common/prompt/prompts.js';
import { AnthropicLLMChatMessage, AnthropicReasoning, GeminiLLMChatMessage, LLMChatMessage, LLMFIMMessage, OpenAILLMChatMessage, RawToolParamsObj } from '../common/sendLLMMessageTypes.js';
import { IVoidSettingsService } from '../common/voidSettingsService.js';
import { ChatMode, FeatureName, ModelSelection, ProviderName } from '../common/voidSettingsTypes.js';
import { IDirectoryStrService } from '../common/directoryStrService.js';
import { ITerminalToolService } from './terminalToolService.js';
import { ToolName } from '../common/toolsServiceTypes.js';
import { IMCPService } from '../common/mcpService.js';
import { AgentInstructionTurnSnapshot, assembleAgentInstructionText, routeAgentInstructionAuthority } from '../common/agentInstructions.js';
import { AgentRuntimeTurnSnapshot, assembleProtectedAgentAuthority, isReadSkillResourceToolName } from '../common/agentSkills.js';
import { AgentSubagentToolSnapshot, ToolExecutionProfile } from '../common/agentSubagents.js';
import { sanitizeAssistantDisplayContent } from '../common/assistantMessagePresentation.js';

type SimpleLLMMessage = {
	role: 'tool';
	content: string;
	id: string;
	name: ToolName;
	rawParams: RawToolParamsObj;
	/** Durable native batch identity used only to group provider result blocks. */
	batchId?: string;
	batchOrdinal?: number;
	/** Exact selected-Skill resource evidence; generic history trimming must not alter it. */
	protectedSkillResource?: boolean;
} | {
	role: 'user';
	content: string;
} | {
	role: 'assistant';
	content: string;
	anthropicReasoning: AnthropicReasoning[] | null;
	toolBatch?: { version: 1; batchId: string; calls: readonly { id: string; name: ToolName; rawParams: RawToolParamsObj }[] };
}



export const CHARS_PER_TOKEN = 4 // assume abysmal chars per token
const TRIM_TO_LEN = 120

// This deliberately mirrors the conservative character estimator used by prepareMessages.
// It is state-free so tool execution can derive a bound without serializing or mutating history.
export const estimateHistoryTokensForReadBudget = (history: readonly unknown[]) => Math.ceil(JSON.stringify(history).length / CHARS_PER_TOKEN)
export const protectedSkillResourceHistoryLength = (history: readonly ChatMessage[]) => history.reduce((total, message) => total + (message.role === 'tool' && message.type === 'success' && isReadSkillResourceToolName(message.name) ? message.content.length : 0), 0)

/** A native assistant declaration must be complete before a later provider turn can
 * serialize it. This keeps a cancelled/reloaded/approval-paused batch from becoming
 * an invalid provider transcript. Batch bookkeeping itself never crosses the wire. */
const assertClosedNativeToolBatches = (messages: readonly ChatMessage[]): void => {
	for (const message of messages) {
		if (message.role !== 'assistant' || !message.toolBatch) continue
		const { batchId, calls } = message.toolBatch
		if (!batchId || calls.length === 0 || calls.some(call => !call.id || !call.name) || new Set(calls.map(call => call.id)).size !== calls.length) throw new Error('native_tool_batch_invalid_declaration')
		const rows = messages.filter((candidate): candidate is Extract<ChatMessage, { role: 'tool' }> => candidate.role === 'tool' && candidate.batchId === batchId)
		if (rows.length !== calls.length) throw new Error('native_tool_batch_unclosed')
		for (const [batchOrdinal, call] of calls.entries()) {
			const matching = rows.filter(row => row.batchOrdinal === batchOrdinal && row.id === call.id)
			if (matching.length !== 1 || !['success', 'tool_error', 'rejected', 'invalid_params'].includes(matching[0].type)) throw new Error('native_tool_batch_unclosed')
		}
	}
}




// convert messages as if about to send to openai
/*
reference - https://platform.openai.com/docs/guides/function-calling#function-calling-steps
openai MESSAGE (role=assistant):
"tool_calls":[{
	"type": "function",
	"id": "call_12345xyz",
	"function": {
	"name": "get_weather",
	"arguments": "{\"latitude\":48.8566,\"longitude\":2.3522}"
}]

openai RESPONSE (role=user):
{   "role": "tool",
	"tool_call_id": tool_call.id,
	"content": str(result)    }

also see
openai on prompting - https://platform.openai.com/docs/guides/reasoning#advice-on-prompting
openai on developer system message - https://cdn.openai.com/spec/model-spec-2024-05-08.html#follow-the-chain-of-command
*/


const prepareMessages_openai_tools = (messages: SimpleLLMMessage[]): AnthropicOrOpenAILLMMessage[] => {

	const newMessages: OpenAILLMChatMessage[] = [];

	for (let i = 0; i < messages.length; i += 1) {
		const currMsg = messages[i]

		if (currMsg.role === 'assistant') {
			newMessages.push({ role: 'assistant', content: currMsg.content, ...(currMsg.toolBatch ? { tool_calls: currMsg.toolBatch.calls.map(call => ({ type: 'function' as const, id: call.id, function: { name: call.name, arguments: JSON.stringify(call.rawParams) } })) } : {}) })
			continue
		}
		if (currMsg.role !== 'tool') {
			newMessages.push(currMsg)
			continue
		}

		// edit previous assistant message to have called the tool
		const prevMsg = 0 <= i - 1 && i - 1 <= newMessages.length ? newMessages[i - 1] : undefined
		if (prevMsg?.role === 'assistant' && !prevMsg.tool_calls?.length) {
			prevMsg.tool_calls = [{
				type: 'function',
				id: currMsg.id,
				function: {
					name: currMsg.name,
					arguments: JSON.stringify(currMsg.rawParams)
				}
			}]
		}

		// add the tool
		newMessages.push({
			role: 'tool',
			tool_call_id: currMsg.id,
			content: currMsg.content,
		})
	}
	return newMessages

}



// convert messages as if about to send to anthropic
/*
https://docs.anthropic.com/en/docs/build-with-claude/tool-use#tool-use-examples
anthropic MESSAGE (role=assistant):
"content": [{
	"type": "text",
	"text": "<thinking>I need to call the get_weather function, and the user wants SF, which is likely San Francisco, CA.</thinking>"
}, {
	"type": "tool_use",
	"id": "toolu_01A09q90qw90lq917835lq9",
	"name": "get_weather",
	"input": { "location": "San Francisco, CA", "unit": "celsius" }
}]
anthropic RESPONSE (role=user):
"content": [{
	"type": "tool_result",
	"tool_use_id": "toolu_01A09q90qw90lq917835lq9",
	"content": "15 degrees"
}]


Converts:
assistant: ...content
tool: (id, name, params)
->
assistant: ...content, call(name, id, params)
user: ...content, result(id, content)
*/

type AnthropicOrOpenAILLMMessage = AnthropicLLMChatMessage | OpenAILLMChatMessage

const prepareMessages_anthropic_tools = (messages: SimpleLLMMessage[], supportsAnthropicReasoning: boolean): AnthropicOrOpenAILLMMessage[] => {
	const newMessages: AnthropicLLMChatMessage[] = [];

	for (let i = 0; i < messages.length; i += 1) {
		const currMsg = messages[i]

		// add anthropic reasoning
		if (currMsg.role === 'assistant') {
			if (currMsg.anthropicReasoning && supportsAnthropicReasoning) {
				const content = currMsg.content
				newMessages.push({
					role: 'assistant',
					content: [...(content ? [...currMsg.anthropicReasoning, { type: 'text' as const, text: content }] : currMsg.anthropicReasoning), ...(currMsg.toolBatch?.calls.map(call => ({ type: 'tool_use' as const, id: call.id, name: call.name, input: call.rawParams })) ?? [])]
				})
			}
			else {
				newMessages.push({
					role: 'assistant',
					content: currMsg.toolBatch ? [...(currMsg.content ? [{ type: 'text' as const, text: currMsg.content }] : []), ...currMsg.toolBatch.calls.map(call => ({ type: 'tool_use' as const, id: call.id, name: call.name, input: call.rawParams }))] : currMsg.content,
					// strip away anthropicReasoning
				})
			}
			continue
		}

		if (currMsg.role === 'user') {
			newMessages.push({
				role: 'user',
				content: currMsg.content,
			})
			continue
		}

		if (currMsg.role === 'tool') {
			// add anthropic tools
			const toolRows: Extract<SimpleLLMMessage, { role: 'tool' }>[] = [currMsg]
			if (currMsg.batchId !== undefined) {
				while (i + 1 < messages.length) {
					const next = messages[i + 1]
					if (next.role !== 'tool' || next.batchId !== currMsg.batchId) break
					i += 1
					toolRows.push(next)
				}
			}
			const prevMsg = newMessages.at(-1)

			// make it so the assistant called the tool
			if (prevMsg?.role === 'assistant' && !(Array.isArray(prevMsg.content) && prevMsg.content.some(part => part.type === 'tool_use'))) {
				if (typeof prevMsg.content === 'string') prevMsg.content = prevMsg.content ? [{ type: 'text', text: prevMsg.content }] : []
				for (const tool of toolRows) prevMsg.content.push({ type: 'tool_use', id: tool.id, name: tool.name, input: tool.rawParams })
			}

			// Native batches require one ordered user result block. Legacy singleton rows
			// retain their existing one-result message shape.
			newMessages.push({
				role: 'user',
				content: toolRows.map(tool => ({ type: 'tool_result' as const, tool_use_id: tool.id, content: tool.content }))
			})
			continue
		}

	}

	// we just removed the tools
	return newMessages as AnthropicLLMChatMessage[]
}


const prepareMessages_XML_tools = (messages: SimpleLLMMessage[], supportsAnthropicReasoning: boolean): AnthropicOrOpenAILLMMessage[] => {

	const llmChatMessages: AnthropicOrOpenAILLMMessage[] = [];
	for (let i = 0; i < messages.length; i += 1) {

		const c = messages[i]
		const next = 0 <= i + 1 && i + 1 <= messages.length - 1 ? messages[i + 1] : null

		if (c.role === 'assistant') {
			// if called a tool (message after it), re-add its XML to the message
			// alternatively, could just hold onto the original output, but this way requires less piping raw strings everywhere
			let content: AnthropicOrOpenAILLMMessage['content'] = c.content
			if (next?.role === 'tool') {
				content = `${content}\n\n${reParsedToolXMLString(next.name, next.rawParams)}`
			}

			// anthropic reasoning
			if (c.anthropicReasoning && supportsAnthropicReasoning) {
				content = content ? [...c.anthropicReasoning, { type: 'text' as const, text: content }] : c.anthropicReasoning
			}
			llmChatMessages.push({
				role: 'assistant',
				content
			})
		}
		// add user or tool to the previous user message
		else if (c.role === 'user' || c.role === 'tool') {
			if (c.role === 'tool')
				c.content = `<${c.name}_result>\n${c.content}\n</${c.name}_result>`

			if (llmChatMessages.length === 0 || llmChatMessages[llmChatMessages.length - 1].role !== 'user')
				llmChatMessages.push({
					role: 'user',
					content: c.content
				})
			else
				llmChatMessages[llmChatMessages.length - 1].content += '\n\n' + c.content
		}
	}
	return llmChatMessages
}


// --- CHAT ---

export const trimProtectedMutableContent = (content: string, targetLength: number): string => {
	const target = Math.max(0, Math.floor(targetLength))
	if (content.length <= target) return content
	if (target <= '...'.length) return content.slice(0, target)
	return content.slice(0, target - '...'.length).trim() + '...'
}

const prepareOpenAIOrAnthropicMessages = ({
	messages: messages_,
	systemMessage,
	agentInstructions,
	supportsSystemMessage,
	specialToolFormat,
	supportsAnthropicReasoning,
	contextWindow,
	reservedOutputTokenSpace,
	protectedSkillAuthority = false,
}: {
	messages: SimpleLLMMessage[],
	systemMessage: string,
	agentInstructions?: string,
	supportsSystemMessage: false | 'system-role' | 'developer-role' | 'separated',
	specialToolFormat: 'openai-style' | 'anthropic-style' | undefined,
	supportsAnthropicReasoning: boolean,
	contextWindow: number,
	reservedOutputTokenSpace: number | null | undefined,
	protectedSkillAuthority?: boolean,
}): { messages: AnthropicOrOpenAILLMMessage[], separateSystemMessage: string | undefined } => {

	reservedOutputTokenSpace = protectedSkillAuthority ? reservedOutputTokenSpace ?? 0 : Math.max(
		contextWindow * 1 / 2, // reserve at least 1/4 of the token window length
		reservedOutputTokenSpace ?? 4_096 // defaults to 4096
	)
	let messages: (SimpleLLMMessage | { role: 'system', content: string; protectedSkillAuthority?: boolean; protectedSkillResource?: boolean })[] = deepClone(messages_)

	// ================ system message ================
	// A COMPLETE HACK: last message is system message for context purposes

	// Both protected envelope entries participate in context trimming before conversion.
	messages.unshift({ role: 'system', content: systemMessage })
	if (agentInstructions) messages.unshift({ role: 'system', content: agentInstructions, protectedSkillAuthority: true })

	// ================ trim ================
	messages = messages.map(m => ({ ...m, content: m.role !== 'tool' && !('protectedSkillAuthority' in m && m.protectedSkillAuthority) ? m.content.trim() : m.content }))

	type MesType = (typeof messages)[0]

	// ================ fit into context ================

	// the higher the weight, the higher the desire to truncate - TRIM HIGHEST WEIGHT MESSAGES
	const alreadyTrimmedIdxes = new Set<number>()
	const weight = (message: MesType, messages: MesType[], idx: number) => {
		const base = message.content.length

		let multiplier: number
		multiplier = 1 + (messages.length - 1 - idx) / messages.length // slow rampdown from 2 to 1 as index increases
		if (message.role === 'user') {
			multiplier *= 1
		}
		else if (message.role === 'system') {
			multiplier *= .01 // very low weight
		}
		else {
			multiplier *= 10 // llm tokens are far less valuable than user tokens
		}

		// any already modified message should not be trimmed again
		if (alreadyTrimmedIdxes.has(idx)) {
			multiplier = 0
		}
		// 1st and last messages should be very low weight
		if (idx <= 1 || idx >= messages.length - 1 - 3) {
			multiplier *= .05
		}
		return base * multiplier
	}

	const _findLargestByWeight = (messages_: MesType[]) => {
		let largestIndex = -1
		let largestWeight = -Infinity
		for (let i = 0; i < messages.length; i += 1) {
			const m = messages[i]
			if (protectedSkillAuthority && (('protectedSkillAuthority' in m && m.protectedSkillAuthority) || ('protectedSkillResource' in m && m.protectedSkillResource))) continue
			const w = weight(m, messages_, i)
			if (w > largestWeight) {
				largestWeight = w
				largestIndex = i
			}
		}
		return largestIndex
	}

	let totalLen = 0
	for (const m of messages) { totalLen += m.content.length }
	const exactInputBudget = Math.max(0, (contextWindow - reservedOutputTokenSpace) * CHARS_PER_TOKEN)
	const protectedResourceLength = protectedSkillAuthority ? messages.reduce((total, message) => total + ('protectedSkillResource' in message && message.protectedSkillResource ? message.content.length : 0), 0) : 0
	const protectedLength = protectedSkillAuthority ? messages.reduce((total, message) => total + ((('protectedSkillAuthority' in message && message.protectedSkillAuthority) || ('protectedSkillResource' in message && message.protectedSkillResource)) ? message.content.length : 0), 0) : 0
	if (protectedSkillAuthority && protectedLength > exactInputBudget) throw new Error(protectedResourceLength ? 'skill_resource_context_admission_failed' : 'skill_context_admission_failed')
	const mutableBudget = protectedSkillAuthority ? exactInputBudget - protectedLength : 0
	const mutableLength = protectedSkillAuthority ? totalLen - protectedLength : totalLen
	const charsNeedToTrim = (protectedSkillAuthority ? mutableLength - mutableBudget : totalLen - Math.max(
		(contextWindow - reservedOutputTokenSpace) * CHARS_PER_TOKEN, // can be 0, in which case charsNeedToTrim=everything, bad
		5_000 // ensure we don't trim at least 5k chars (just a random small value)
	))


	// <----------------------------------------->
	// 0                      |    |             |
	//                        |    contextWindow |
	//                     contextWindow - maxOut|putTokens
	//                                          totalLen
	let remainingCharsToTrim = charsNeedToTrim
	let i = 0

	while (remainingCharsToTrim > 0) {
		i += 1
		if (!protectedSkillAuthority && i > 100) break

		const trimIdx = _findLargestByWeight(messages)
		if (trimIdx < 0) throw new Error('skill_context_admission_failed')
		const m = messages[trimIdx]
		if (('protectedSkillAuthority' in m && m.protectedSkillAuthority) || ('protectedSkillResource' in m && m.protectedSkillResource)) { alreadyTrimmedIdxes.add(trimIdx); continue }

		// if can finish here, do
		const minimumLength = protectedSkillAuthority ? 0 : TRIM_TO_LEN
		const numCharsWillTrim = m.content.length - minimumLength
		if (numCharsWillTrim <= 0) throw new Error('skill_context_admission_failed')
		if (numCharsWillTrim > remainingCharsToTrim) {
			const targetLength = m.content.length - remainingCharsToTrim
			m.content = protectedSkillAuthority
				? trimProtectedMutableContent(m.content, targetLength)
				// Preserve the legacy non-Skills trimming behavior outside protected Chat admission.
				: m.content.slice(0, targetLength - '...'.length).trim() + '...'
			break
		}

		remainingCharsToTrim -= numCharsWillTrim
		m.content = minimumLength ? m.content.substring(0, minimumLength - '...'.length) + '...' : ''
		alreadyTrimmedIdxes.add(trimIdx)
	}

	// ================ system message hack ================
	const newInstructionMsg = agentInstructions ? messages.shift()!.content : ''
	const newSysMsg = messages.shift()!.content
	const authorityRoute = routeAgentInstructionAuthority(newInstructionMsg, newSysMsg, supportsSystemMessage);


	// ================ tools and anthropicReasoning ================
	// SYSTEM MESSAGE HACK: we shifted (removed) the system message role, so now SimpleLLMMessage[] is valid

	let llmChatMessages: AnthropicOrOpenAILLMMessage[] = []
	if (!specialToolFormat) { // XML tool behavior
		llmChatMessages = prepareMessages_XML_tools(messages as SimpleLLMMessage[], supportsAnthropicReasoning)
	}
	else if (specialToolFormat === 'anthropic-style') {
		llmChatMessages = prepareMessages_anthropic_tools(messages as SimpleLLMMessage[], supportsAnthropicReasoning)
	}
	else if (specialToolFormat === 'openai-style') {
		llmChatMessages = prepareMessages_openai_tools(messages as SimpleLLMMessage[])
	}
	llmChatMessages = llmChatMessages.filter(message => {
		if (message.role !== 'assistant') return true
		if ('tool_calls' in message && message.tool_calls?.length) return true
		if (typeof message.content === 'string') return message.content.length > 0
		return message.content.some(part => part.type !== 'text' || !!part.text)
	})
	const llmMessages = llmChatMessages


	// ================ system message add as first llmMessage ================

	let separateSystemMessageStr: string | undefined = undefined

	// if supports system message
	if (supportsSystemMessage) {
		if (supportsSystemMessage === 'separated')
			separateSystemMessageStr = authorityRoute.separateSystemMessage
		else if (supportsSystemMessage === 'system-role')
			llmMessages.unshift(...authorityRoute.roleMessages.map(message => ({ ...message })))
		else if (supportsSystemMessage === 'developer-role')
			llmMessages.unshift(...authorityRoute.roleMessages.map(message => ({ ...message })))
	}
	// if does not support system message
	else {
		const newFirstMessage = {
			role: 'user',
			content: `<SYSTEM_MESSAGE>\n${authorityRoute.userFallbackSystemMessage ?? ''}\n</SYSTEM_MESSAGE>\n${llmMessages[0].content}`
		} as const
		llmMessages.splice(0, 1) // delete first message
		llmMessages.unshift(newFirstMessage) // add new first message
	}

	// Keep source-generated system context separate from user/project instruction authority.
	// Developer-capable Chat Completions routes receive this as a developer message.

	return {
		messages: llmMessages,
		separateSystemMessage: separateSystemMessageStr,
	} as const
}




type GeminiUserPart = (GeminiLLMChatMessage & { role: 'user' })['parts'][0]
type GeminiModelPart = (GeminiLLMChatMessage & { role: 'model' })['parts'][0]
const prepareGeminiMessages = (messages: AnthropicLLMChatMessage[]) => {
	const toolNames = new Map<string, ToolName>()
	const messages2: GeminiLLMChatMessage[] = messages.map((m): GeminiLLMChatMessage | null => {
		if (m.role === 'assistant') {
			if (typeof m.content === 'string') {
				return { role: 'model', parts: [{ text: m.content }] }
			}
			else {
				const parts: GeminiModelPart[] = m.content.map((c): GeminiModelPart | null => {
					if (c.type === 'text') {
						return { text: c.text }
					}
					else if (c.type === 'tool_use') {
						toolNames.set(c.id, c.name)
						return { functionCall: { id: c.id, name: c.name, args: c.input } }
					}
					else return null
				}).filter(m => !!m)
				return { role: 'model', parts, }
			}
		}
		else if (m.role === 'user') {
			if (typeof m.content === 'string') {
				return { role: 'user', parts: [{ text: m.content }] } satisfies GeminiLLMChatMessage
			}
			else {
				const parts: GeminiUserPart[] = m.content.map((c): GeminiUserPart | null => {
					if (c.type === 'text') {
						return { text: c.text }
					}
					else if (c.type === 'tool_result') {
						const name = toolNames.get(c.tool_use_id)
						if (!name) return null
						return { functionResponse: { id: c.tool_use_id, name, response: { output: c.content } } }
					}
					else return null
				}).filter(m => !!m)
				return { role: 'user', parts, }
			}

		}
		else return null
	}).filter(m => !!m)

	return messages2
}


const prepareMessages = (params: {
	messages: SimpleLLMMessage[],
	systemMessage: string,
	agentInstructions?: string,
	supportsSystemMessage: false | 'system-role' | 'developer-role' | 'separated',
	specialToolFormat: 'openai-style' | 'anthropic-style' | 'gemini-style' | undefined,
	supportsAnthropicReasoning: boolean,
	contextWindow: number,
	reservedOutputTokenSpace: number | null | undefined,
	protectedSkillAuthority?: boolean,
	providerName: ProviderName
}): { messages: LLMChatMessage[], separateSystemMessage: string | undefined } => {

	const specialFormat = params.specialToolFormat // this is just for ts stupidness

	// if need to convert to gemini style of messaes, do that (treat as anthropic style, then convert to gemini style)
	if (params.providerName === 'gemini' || specialFormat === 'gemini-style') {
		const res = prepareOpenAIOrAnthropicMessages({ ...params, specialToolFormat: specialFormat === 'gemini-style' ? 'anthropic-style' : undefined })
		const messages = res.messages as AnthropicLLMChatMessage[]
		const messages2 = prepareGeminiMessages(messages)
		return { messages: messages2, separateSystemMessage: res.separateSystemMessage }
	}

	return prepareOpenAIOrAnthropicMessages({ ...params, specialToolFormat: specialFormat })
}




export interface IConvertToLLMMessageService {
	readonly _serviceBrand: undefined;
	prepareLLMSimpleMessages: (opts: { simpleMessages: SimpleLLMMessage[], systemMessage: string, modelSelection: ModelSelection | null, featureName: FeatureName }) => { messages: LLMChatMessage[], separateSystemMessage: string | undefined }
	prepareLLMChatMessages: (opts: { chatMessages: ChatMessage[], chatMode: ChatMode, modelSelection: ModelSelection | null, instructionSnapshot: AgentRuntimeTurnSnapshot | AgentInstructionTurnSnapshot, toolExecutionProfile?: ToolExecutionProfile, childRoot?: string, agentDelegationAllowed?: boolean, frozenToolSnapshot?: AgentSubagentToolSnapshot }) => Promise<{ messages: LLMChatMessage[], separateSystemMessage: string | undefined }>
	prepareFIMMessage(opts: { messages: LLMFIMMessage, }): { prefix: string, suffix: string, stopTokens: string[] }
}

export const IConvertToLLMMessageService = createDecorator<IConvertToLLMMessageService>('ConvertToLLMMessageService');


export class ConvertToLLMMessageService extends Disposable implements IConvertToLLMMessageService {
	_serviceBrand: undefined;

	constructor(
		@IModelService private readonly modelService: IModelService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IEditorService private readonly editorService: IEditorService,
		@IDirectoryStrService private readonly directoryStrService: IDirectoryStrService,
		@ITerminalToolService private readonly terminalToolService: ITerminalToolService,
		@IVoidSettingsService private readonly voidSettingsService: IVoidSettingsService,
		@IMCPService private readonly mcpService: IMCPService,
	) {
		super()
	}

	// system message
	private _generateChatMessagesSystemMessage = async (chatMode: ChatMode, specialToolFormat: 'openai-style' | 'anthropic-style' | 'gemini-style' | undefined, toolExecutionProfile: ToolExecutionProfile = 'default-parent', childRoot?: string, agentDelegationAllowed = false, frozenToolSnapshot?: AgentSubagentToolSnapshot) => {
		if (toolExecutionProfile === 'read-only-child' || toolExecutionProfile === 'inherited-parent-write-child') { const capabilityHint = toolExecutionProfile === 'read-only-child' ? 'use read tools' : 'use the captured parent tool profile'; return chat_systemMessage({ workspaceFolders: childRoot ? [childRoot] : [], openedURIs: [], activeURI: undefined, persistentTerminalIDs: [], directoryStr: childRoot ? `Root hint: ${childRoot} (${capabilityHint}; no recursive overview was injected).` : 'No root.', chatMode, mcpTools: undefined, includeXMLToolDefinitions: !specialToolFormat, toolExecutionProfile, agentDelegationAllowed, frozenToolSnapshot }); }
		const workspaceFolders = this.workspaceContextService.getWorkspace().folders.map(f => f.uri.fsPath)

		const openedURIs = this.modelService.getModels().filter(m => m.isAttachedToEditor()).map(m => m.uri.fsPath) || [];
		const activeURI = this.editorService.activeEditor?.resource?.fsPath;

		const directoryStr = await this.directoryStrService.getAllDirectoriesStr({
			cutOffMessage: chatMode === 'agent' || chatMode === 'gather' ?
				`...Directories string cut off, use tools to read more...`
				: `...Directories string cut off, ask user for more if necessary...`
		})

		const includeXMLToolDefinitions = !specialToolFormat

		const mcpTools = this.mcpService.getMCPTools()

		const persistentTerminalIDs = this.terminalToolService.listPersistentTerminalIds()
		const systemMessage = chat_systemMessage({ workspaceFolders, openedURIs, directoryStr, activeURI, persistentTerminalIDs, chatMode, mcpTools, includeXMLToolDefinitions, agentDelegationAllowed })
		return systemMessage
	}




	// --- LLM Chat messages ---

	private _chatMessagesToSimpleMessages(chatMessages: ChatMessage[]): SimpleLLMMessage[] {
		const simpleLLMMessages: SimpleLLMMessage[] = []

		for (const m of chatMessages) {
			if (m.role === 'interrupted_streaming_tool') continue
			if (m.role === 'assistant') {
				simpleLLMMessages.push({
					role: m.role,
					content: sanitizeAssistantDisplayContent(m.displayContent),
					anthropicReasoning: m.anthropicReasoning,
					toolBatch: m.toolBatch,
				})
			}
			else if (m.role === 'tool') {
				simpleLLMMessages.push({
					role: m.role,
					content: m.content,
					name: m.name,
					id: m.id,
					rawParams: m.rawParams,
					batchId: m.batchId,
					batchOrdinal: m.batchOrdinal,
					protectedSkillResource: m.type === 'success' && isReadSkillResourceToolName(m.name),
				})
			}
			else if (m.role === 'user') {
				simpleLLMMessages.push({
					role: m.role,
					content: m.content,
				})
			}
		}
		return simpleLLMMessages
	}

	prepareLLMSimpleMessages: IConvertToLLMMessageService['prepareLLMSimpleMessages'] = ({ simpleMessages, systemMessage, modelSelection, featureName }) => {
		if (modelSelection === null) return { messages: [], separateSystemMessage: undefined }

		const { overridesOfModel } = this.voidSettingsService.state

		const { providerName, modelName } = modelSelection
		const {
			specialToolFormat,
			contextWindow,
			supportsSystemMessage,
		} = getModelCapabilities(providerName, modelName, overridesOfModel)

		const modelSelectionOptions = this.voidSettingsService.state.optionsOfModelSelection[featureName][modelSelection.providerName]?.[modelSelection.modelName]


		const isReasoningEnabled = getIsReasoningEnabledState(featureName, providerName, modelName, modelSelectionOptions, overridesOfModel)
		const reservedOutputTokenSpace = getReservedOutputTokenSpace(providerName, modelName, { isReasoningEnabled, overridesOfModel })

		const { messages, separateSystemMessage } = prepareMessages({
			messages: simpleMessages,
			systemMessage,
			supportsSystemMessage,
			specialToolFormat,
			supportsAnthropicReasoning: providerName === 'anthropic',
			contextWindow,
			reservedOutputTokenSpace,
			providerName,
		})
		return { messages, separateSystemMessage };
	}
	prepareLLMChatMessages: IConvertToLLMMessageService['prepareLLMChatMessages'] = async ({ chatMessages, chatMode, modelSelection, instructionSnapshot, toolExecutionProfile = 'default-parent', childRoot, agentDelegationAllowed = false, frozenToolSnapshot }) => {
		if (modelSelection === null) return { messages: [], separateSystemMessage: undefined }
		const runtimeCandidate = instructionSnapshot as unknown as Record<string, unknown>
		const runtime = Object.prototype.hasOwnProperty.call(runtimeCandidate, 'schemaVersion') && runtimeCandidate.schemaVersion === 2 ? instructionSnapshot as AgentRuntimeTurnSnapshot : undefined
		if (runtime && (!runtime.model.hasModel || modelSelection.providerName !== runtime.model.providerName || modelSelection.modelName !== runtime.model.modelName)) throw new Error('skill_runtime_model_mismatch')
		const overridesOfModel = runtime ? { [modelSelection.providerName]: { [modelSelection.modelName]: runtime.model.hasModel ? runtime.model.selectedModelOverrides : {} } } as never : this.voidSettingsService.state.overridesOfModel

		const { providerName, modelName } = modelSelection
		const {
			specialToolFormat,
			contextWindow: liveContextWindow,
			supportsSystemMessage,
		} = getModelCapabilities(providerName, modelName, overridesOfModel)

		const fullSystemMessage = await this._generateChatMessagesSystemMessage(chatMode, specialToolFormat, toolExecutionProfile, childRoot, agentDelegationAllowed, frozenToolSnapshot)
		const systemMessage = fullSystemMessage;

		const modelSelectionOptions = runtime?.model.hasModel ? runtime.model.modelSelectionOptions : this.voidSettingsService.state.optionsOfModelSelection['Chat'][modelSelection.providerName]?.[modelSelection.modelName]

		const agentInstructions = runtime ? assembleProtectedAgentAuthority(runtime, toolExecutionProfile !== 'read-only-child') : assembleAgentInstructionText(instructionSnapshot as AgentInstructionTurnSnapshot);
		const isReasoningEnabled = getIsReasoningEnabledState('Chat', providerName, modelName, modelSelectionOptions, overridesOfModel)
		const contextWindow = runtime?.model.hasModel ? runtime.model.contextWindow : liveContextWindow
		const reservedOutputTokenSpace = runtime?.model.hasModel ? runtime.model.reservedOutputTokens : getReservedOutputTokenSpace(providerName, modelName, { isReasoningEnabled, overridesOfModel })
		assertClosedNativeToolBatches(chatMessages)
		const llmMessages = this._chatMessagesToSimpleMessages(chatMessages)

		const { messages, separateSystemMessage } = prepareMessages({
			messages: llmMessages,
			systemMessage,
			agentInstructions,
			supportsSystemMessage,
			specialToolFormat,
			supportsAnthropicReasoning: providerName === 'anthropic',
			contextWindow,
			reservedOutputTokenSpace,
			protectedSkillAuthority: !!runtime,
			providerName,
		})
		return { messages, separateSystemMessage };
	}


	// --- FIM ---

	prepareFIMMessage: IConvertToLLMMessageService['prepareFIMMessage'] = ({ messages }) => {
		const prefix = messages.prefix

		const suffix = messages.suffix
		const stopTokens = messages.stopTokens
		return { prefix, suffix, stopTokens }
	}


}


registerSingleton(IConvertToLLMMessageService, ConvertToLLMMessageService, InstantiationType.Eager);








/*
Gemini has this, but they're openai-compat so we don't need to implement this
gemini request:
{   "role": "assistant",
	"content": null,
	"function_call": {
		"name": "get_weather",
		"arguments": {
			"latitude": 48.8566,
			"longitude": 2.3522
		}
	}
}

gemini response:
{   "role": "assistant",
	"function_response": {
		"name": "get_weather",
			"response": {
			"temperature": "15°C",
				"condition": "Cloudy"
		}
	}
}
*/
