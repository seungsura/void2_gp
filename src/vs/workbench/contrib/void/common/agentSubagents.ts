/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * The Phase 3 child-agent contract deliberately lives in common code.  Providers, XML
 * prompts and the browser executor all consume this same profile; registering a tool is
 * never by itself permission for a child to execute it.
 */
import { URI } from '../../../../base/common/uri.js';

export type ToolExecutionProfile = 'default-parent' | 'read-only-child';

export const readOnlyChildToolNames = Object.freeze([
	'read_file', 'ls_dir', 'search_pathnames_only', 'search_for_files', 'search_in_file',
] as const);

export const isToolAllowedByProfile = (profile: ToolExecutionProfile, name: string): boolean =>
	profile === 'default-parent' || (readOnlyChildToolNames as readonly string[]).includes(name);

const childRawKeys: Readonly<Record<string, readonly string[]>> = Object.freeze({
	read_file: Object.freeze(['uri', 'start_line', 'end_line', 'line_byte_offset']), ls_dir: Object.freeze(['uri', 'page_number']),
	search_pathnames_only: Object.freeze(['query', 'include_pattern', 'page_number']), search_for_files: Object.freeze(['query', 'search_in_folder', 'is_regex', 'page_number']), search_in_file: Object.freeze(['uri', 'query', 'is_regex']),
});
/** This gate must run before the permissive legacy builtin validators. */
export const assertExactReadOnlyChildRawKeys = (name: string, raw: Record<string, unknown>): void => {
	const allowed = childRawKeys[name];
	if (!allowed || Object.keys(raw).some(key => !allowed.includes(key))) throw new Error('agent_child_unknown_tool_field');
};

export const assertCanonicalAgentChildRawUri = (value: unknown): void => {
	if (typeof value !== 'string' || !value || value.includes('\\') || /%(?:2e|2f|5c)/i.test(value) || /(?:^|\/)\.{1,2}(?:\/|$|[?#])/i.test(value)) throw new Error('agent_child_path_not_canonical');
};

/** URI constructors may retain drive-letter casing that their canonical string does not. */
export const canonicalAgentChildUri = (uri: URI): URI => URI.parse(uri.toString());

export const assertCanonicalAgentChildUriPath = (path: string): void => {
	if (!path.startsWith('/') || path.includes('\\')) throw new Error('agent_child_path_not_canonical');
	if (path === '/' || /^\/[A-Za-z]:\/$/.test(path)) return;
	if (path.split('/').slice(1).some(segment => !segment || segment === '.' || segment === '..')) throw new Error('agent_child_path_not_canonical');
};

export const assertCanonicalReadOnlyChildRawPaths = (name: string, raw: Record<string, unknown>): void => {
	if (name === 'read_file' || name === 'ls_dir' || name === 'search_in_file') assertCanonicalAgentChildRawUri(raw.uri);
	if (name === 'search_for_files' && raw.search_in_folder !== undefined && raw.search_in_folder !== '') assertCanonicalAgentChildRawUri(raw.search_in_folder);
	if (name === 'search_in_file' && raw.is_regex !== undefined && raw.is_regex !== false) throw new Error('agent_child_regex_not_supported');
};

export type AgentSubagentStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type AgentSubagentBudgetView = Readonly<{ accepted: number; running: number; queued: number; maxAccepted: number; maxConcurrent: number; providerSends: number; maxProviderSends: number; resultChars: number; maxResultChars: number; deadlineMsRemaining: number; usage: null }>;
export type AgentSubagentRunView = Readonly<{ id: string; status: AgentSubagentStatus; summary?: string; roleName?: string; roleDescription?: string; usage: null }>;
export const isActiveChildRun = (view: AgentSubagentRunView | undefined): boolean => view?.status === 'queued' || view?.status === 'running';
export const agentSubagentStatusLabel = (status: AgentSubagentStatus): string => ({ queued: 'Queued', running: 'Running', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled' })[status];
export type AgentSubagentControlName = 'spawn_agent' | 'wait_agent' | 'interrupt_agent';

export const AGENT_SUBAGENT_MAX_MESSAGE_CHARS = 8_000;
export const AGENT_SUBAGENT_MAX_WAIT_MS = 30_000;
export const AGENT_SUBAGENT_DEFAULT_WAIT_MS = 10_000;
export const AGENT_SUBAGENT_MAX_RESULTS = 100;
export const AGENT_SUBAGENT_MAX_CONCURRENT = 2;
export const AGENT_SUBAGENT_MAX_ACCEPTED = 4;
export const AGENT_SUBAGENT_MAX_GROUP_PROVIDER_SENDS = 64;
export const AGENT_SUBAGENT_MAX_GROUP_RUN_MS = 240_000;
export const AGENT_SUBAGENT_MAX_AGGREGATE_RESULT_CHARS = 32_000;

const flatObject = (properties: Record<string, unknown>, required: readonly string[] = []) => ({
	type: 'object', additionalProperties: false, ...(required.length ? { required: [...required] } : {}), properties,
});
const deepFreeze = <T>(value: T): T => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item); Object.freeze(value); } return value; };

/** Flat schemas are intentionally dialect-conservative. Runtime validation below is authoritative. */
export const agentSubagentToolSchemas = deepFreeze({
	spawn_agent: flatObject({ message: { type: 'string', minLength: 1, maxLength: AGENT_SUBAGENT_MAX_MESSAGE_CHARS }, agent_type: { type: 'string', minLength: 1, maxLength: 64 } }, ['message']),
	wait_agent: flatObject({ timeout_ms: { type: 'integer', minimum: 0, maximum: AGENT_SUBAGENT_MAX_WAIT_MS }, targets: { type: 'array', minItems: 1, maxItems: AGENT_SUBAGENT_MAX_ACCEPTED, items: { type: 'string', minLength: 1, maxLength: 256 } } }),
	interrupt_agent: flatObject({ target: { type: 'string', minLength: 1, maxLength: 256 } }, ['target']),
});

/** Native providers must receive the same strict five read tools as the XML grammar. */
export const readOnlyChildBuiltinSchemas: Readonly<Record<string, Record<string, unknown>>> = deepFreeze({
	read_file: flatObject({ uri: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' }, line_byte_offset: { type: 'integer', minimum: 0 } }, ['uri']),
	ls_dir: flatObject({ uri: { type: 'string' }, page_number: { type: 'integer', minimum: 1 } }, ['uri']),
	search_pathnames_only: flatObject({ query: { type: 'string' }, include_pattern: { type: 'string' }, page_number: { type: 'integer', minimum: 1 } }, ['query']),
	search_for_files: flatObject({ query: { type: 'string' }, search_in_folder: { type: 'string' }, is_regex: { type: 'boolean' }, page_number: { type: 'integer', minimum: 1 } }, ['query']),
	search_in_file: flatObject({ uri: { type: 'string' }, query: { type: 'string' }, is_regex: { type: 'boolean', description: 'Read-only child supports literal search only; omit this field or use false.' } }, ['uri', 'query']),
});

export type AgentSubagentControlParams =
	| { readonly name: 'spawn_agent'; readonly message: string; readonly agentType?: string }
	| { readonly name: 'wait_agent'; readonly timeoutMs: number; readonly targets?: readonly string[] }
	| { readonly name: 'interrupt_agent'; readonly target: string };

const isPlainObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key));

/** Reject unknown fields before dispatch; callers must not fall through to a normal registry lookup. */
export const validateAgentSubagentControlParams = (name: AgentSubagentControlName, raw: unknown): AgentSubagentControlParams => {
	if (!isPlainObject(raw)) throw new Error('agent_control_invalid_params');
	if (name === 'spawn_agent') {
		if (!exactKeys(raw, ['message', 'agent_type']) || typeof raw.message !== 'string' || !raw.message.trim() || raw.message.length > AGENT_SUBAGENT_MAX_MESSAGE_CHARS || (raw.agent_type !== undefined && (typeof raw.agent_type !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(raw.agent_type)))) throw new Error('spawn_agent_invalid_params');
		return { name, message: raw.message, ...(raw.agent_type === undefined ? {} : { agentType: raw.agent_type as string }) };
	}
	if (name === 'wait_agent') {
		if (!exactKeys(raw, ['timeout_ms', 'targets'])) throw new Error('wait_agent_invalid_params');
		const timeoutMs = raw.timeout_ms === undefined ? AGENT_SUBAGENT_DEFAULT_WAIT_MS : raw.timeout_ms;
		if (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) < 0 || (timeoutMs as number) > AGENT_SUBAGENT_MAX_WAIT_MS) throw new Error('wait_agent_invalid_params');
		const targets = raw.targets;
		if (targets !== undefined && (!Array.isArray(targets) || targets.length < 1 || targets.length > AGENT_SUBAGENT_MAX_ACCEPTED || targets.some(target => typeof target !== 'string' || !target.trim() || target.length > 256) || new Set(targets).size !== targets.length)) throw new Error('wait_agent_invalid_params');
		return { name, timeoutMs: timeoutMs as number, ...(targets === undefined ? {} : { targets: Object.freeze([...targets]) }) };
	}
	if (!exactKeys(raw, ['target']) || typeof raw.target !== 'string' || !raw.target.trim() || raw.target.length > 256) throw new Error('interrupt_agent_invalid_params');
	return { name, target: raw.target };
};

export const isAgentSubagentControlName = (name: string): name is AgentSubagentControlName =>
	name === 'spawn_agent' || name === 'wait_agent' || name === 'interrupt_agent';

export type AgentSubagentReceipt = Readonly<{ id: string; status: Exclude<AgentSubagentStatus, 'queued' | 'running'>; summary: string; usage: null }>;

/** A small CAS-like state holder: completion/interrupt/late callbacks cannot settle twice. */
export class AgentSubagentLifecycle {
	private _status: AgentSubagentStatus = 'queued';
	private _receipt: AgentSubagentReceipt | undefined;
	private _terminalDelivered = false;

	get status(): AgentSubagentStatus { return this._status; }
	start(): boolean { if (this._status !== 'queued') return false; this._status = 'running'; return true; }
	settle(status: Exclude<AgentSubagentStatus, 'queued' | 'running'>, id: string, summary: string): boolean {
		if (this._receipt) return false;
		this._status = status;
		this._receipt = Object.freeze({ id, status, summary: summary.slice(0, AGENT_SUBAGENT_MAX_MESSAGE_CHARS), usage: null });
		return true;
	}
	receipt(deliverSummary: boolean): { receipt: AgentSubagentReceipt | undefined; deliverSummary: boolean } {
		const shouldDeliver = !!this._receipt && deliverSummary && !this._terminalDelivered;
		if (shouldDeliver) this._terminalDelivered = true;
		return { receipt: this._receipt && (shouldDeliver ? this._receipt : Object.freeze({ ...this._receipt, summary: '' })), deliverSummary: shouldDeliver };
	}
}
