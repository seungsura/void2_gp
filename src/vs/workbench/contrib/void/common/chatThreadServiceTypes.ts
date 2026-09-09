/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { AnthropicReasoning, RawToolCallObj, RawToolParamsObj } from './sendLLMMessageTypes.js';
import { ToolCallParams, ToolName, ToolResult } from './toolsServiceTypes.js';

/**
 * Finds an enabled option from a candidate index without depending on any UI framework.
 * `startIndex` is included in the search, so callers can use it for both reset and movement.
 */
export const getEnabledOptionIndex = <T>(
	options: readonly T[],
	isDisabled: (option: T) => boolean,
	startIndex: number,
	direction: -1 | 1,
	wrap: boolean,
): number | undefined => {
	for (let attempts = 0, index = startIndex; attempts < options.length; attempts++, index += direction) {
		if (wrap) {
			index = ((index % options.length) + options.length) % options.length;
		} else if (index < 0 || index >= options.length) {
			return undefined;
		}

		if (!isDisabled(options[index])) {
			return index;
		}
	}

	return undefined;
};

export type ToolMessage<T extends ToolName> = {
	role: 'tool';
	content: string; // give this result to LLM (string of value)
	id: string;
	rawParams: RawToolParamsObj;
	mcpServerName: string | undefined; // the server name at the time of the call
	/** Not persisted as a requirement: older stored tool records simply omit it. */
	lifecycle?: 'cancelling';
	startedAt?: number;
	/** Private execution receipt for a live card. Completed history intentionally omits it. */
	receiptId?: string;
	/** Card-local cancellation is only enabled after an exact underlying interrupt exists. */
	cardStopAvailable?: boolean;
	/** A truthful explanation when an independently cancellable receipt does not exist. */
	cardStopUnavailableReason?: string;
	/** Immutable identity inside a native provider multi-call declaration. */
	batchId?: string;
	batchOrdinal?: number;
} & (
		// in order of events:
		| { type: 'invalid_params', result: null, name: T, }

		| { type: 'tool_request', result: null, name: T, params: ToolCallParams<T>, }  // params were validated, awaiting user

		| { type: 'running_now', result: null, name: T, params: ToolCallParams<T>, }

		| { type: 'tool_error', result: string, name: T, params: ToolCallParams<T>, } // error when tool was running
		| { type: 'success', result: Awaited<ToolResult<T>>, name: T, params: ToolCallParams<T>, }
		| { type: 'rejected', result: null, name: T, params: ToolCallParams<T> }
		| { type: 'skipped', result: null, name: T }
) // user rejected

export type DecorativeCanceledTool = {
	role: 'interrupted_streaming_tool';
	name: ToolName;
	mcpServerName: string | undefined; // the server name at the time of the call
}

/** Persisted inter-agent context. This is deliberately not a user turn. */
export type AgentChatMessage = {
	role: 'agent';
	sourceId: string;
	kind: 'message' | 'completion';
	sequence: number;
	relatedSequence?: number;
	status?: 'completed' | 'failed' | 'cancelled';
	content: string;
	createdAt: number;
}


// WARNING: changing this format is a big deal!!!!!! need to migrate old format to new format on users' computers so people don't get errors.
export type ChatMessage =
	| {
		role: 'user';
		/** Durable inbox provenance. It is not model-visible content. */
		pendingInputId?: string;
		/** Canonical fingerprint of the submitted attachment snapshot; never model-visible. */
		pendingInputSelectionsFingerprint?: string;
		content: string; // content displayed to the LLM on future calls; allowed to be empty without fabricating display text
		displayContent: string; // content displayed to user  - allowed to be '', will be ignored
		selections: StagingSelectionItem[] | null; // the user's selection
		state: {
			stagingSelections: StagingSelectionItem[];
			isBeingEdited: boolean;
		}
	} | {
		role: 'assistant';
		displayContent: string; // content received from LLM; allowed to be empty while reasoning remains visible
		reasoning: string; // reasoning from the LLM, used for step-by-step thinking

		anthropicReasoning: AnthropicReasoning[] | null; // anthropic reasoning
		/** Persisted once before any call in the native declaration executes. */
		toolBatch?: { version: 1; batchId: string; calls: readonly RawToolCallObj[] };
	}
	| AgentChatMessage
	| ToolMessage<ToolName>
	| DecorativeCanceledTool

export const AGENT_DELEGATION_SELECTION_LABEL = 'Void application-level read-only' as const;

// one of the square items that indicates a selection in a chat bubble
export type StagingSelectionItem = {
	type: 'File';
	uri: URI;
	language: string;
	state: { wasAddedAsCurrentFile: boolean; };
} | {
	type: 'CodeSelection';
	range: [number, number];
	uri: URI;
	language: string;
	state: { wasAddedAsCurrentFile: boolean; };
} | {
	type: 'Folder';
	uri: URI;
	language?: undefined;
	state?: undefined;
} | {
	/** Inert user-authority marker; the parent must call spawn_agent explicitly. */
	type: 'Agent';
	label: typeof AGENT_DELEGATION_SELECTION_LABEL;
	/** Optional exact role intent captured from the bounded custom-agent catalog. */
	agentType?: string;
	catalogRevision?: string;
	roleRevision?: string;
	state?: undefined;
} | {
	// A Skill is not a File selection: its immutable catalog/body revisions prevent a stale
	// metadata chip from silently resolving to another on-disk Skill at submission time.
	type: 'Skill';
	identity: string;
	catalogRevision: string;
	bodyRevision: string;
	skillRoot: string;
	description: string;
	state?: undefined;
}

export const isAgentDelegationSelection = (value: unknown): value is Extract<StagingSelectionItem, { type: 'Agent' }> => {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (record.type !== 'Agent' || record.label !== AGENT_DELEGATION_SELECTION_LABEL || record.state !== undefined || !Object.keys(record).every(key => key === 'type' || key === 'label' || key === 'state' || key === 'agentType' || key === 'catalogRevision' || key === 'roleRevision')) return false;
	const named = record.agentType !== undefined || record.catalogRevision !== undefined || record.roleRevision !== undefined;
	return !named || (typeof record.agentType === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(record.agentType) && typeof record.catalogRevision === 'string' && !!record.catalogRevision && typeof record.roleRevision === 'string' && !!record.roleRevision);
};


// a link to a symbol (an underlined link to a piece of code)
export type CodespanLocationLink = {
	uri: URI, // we handle serialization for this
	displayText: string,
	selection?: { // store as JSON so dont have to worry about serialization
		startLineNumber: number
		startColumn: number,
		endLineNumber: number
		endColumn: number,
	} | undefined
} | null
