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
import { CancellationToken } from '../../../../base/common/cancellation.js';

export type ToolExecutionProfile = 'default-parent' | 'read-only-child' | 'inherited-parent-write-child';

/**
 * A child never re-enumerates the live parent registry. This is the immutable,
 * model-facing record captured at top-level admission. `approval` is descriptive
 * only; the parent broker remains the authoritative execution boundary.
 */
export type AgentSubagentToolSnapshotEntry = Readonly<{ name: string; description: string; schema?: Readonly<Record<string, unknown>>; params: Readonly<Record<string, Readonly<{ description: string }>>>; kind: 'builtin' | 'mcp' | 'skill_resource'; mcpServerName?: string; approval?: 'edits' | 'terminal' | 'MCP tools'; revision: string }>;
export type AgentSubagentToolSnapshot = Readonly<{ revision: string; tools: readonly AgentSubagentToolSnapshotEntry[] }>;

/**
 * The child executor never receives a live parent registry.  An inherited-profile
 * call crosses this narrow, one-shot boundary back to its owning parent instead.
 * The exact immutable snapshot entry is carried with the request so a broker
 * cannot accidentally re-resolve a similarly named live tool. `cancel` is an
 * acknowledgement: it resolves only once the external operation is quiescent.
 */
export type AgentSubagentToolBrokerRequest = Readonly<{ parentId: string; generation: number; childId: string; batchId: string; batchOrdinal: number; toolId: string; name: string; tool: AgentSubagentToolSnapshotEntry; rawParams: Readonly<Record<string, unknown>>; snapshotRevision: string; maxReadOutputTokens: number; cancellationToken: CancellationToken }>;
export type AgentSubagentToolBrokerResult = Readonly<{ ok: true; content: string; result?: unknown }> | Readonly<{ ok: false; error: string }>;
/** This exact tuple is the only authority a child-tool approval can address. */
export type ChildToolApprovalKey = Readonly<{ parentId: string; generation: number; childId: string; batchId: string; batchOrdinal: number; toolId: string; snapshotRevision: string }>;
export type ChildToolApprovalView = Readonly<{ key: ChildToolApprovalKey; structuralKey: string; childShortId: string; title: string; toolName: string; toolKind: 'builtin' | 'mcp'; mcpServerName?: string; category: 'edits' | 'terminal' | 'MCP tools'; parameters: string; status: 'awaiting' }>;
/** JSON tuple avoids ambiguity inherent in delimiter-concatenated IDs. */
export const childToolApprovalStructuralKey = (key: ChildToolApprovalKey): string => JSON.stringify([key.parentId, key.generation, key.childId, key.batchId, key.batchOrdinal, key.toolId, key.snapshotRevision]);
const boundedApprovalValue = (value: unknown, depth = 0): unknown => {
	if (depth > 3) return '[truncated]';
	if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
	if (typeof value === 'string') return value.length > 512 ? `${value.slice(0, 512)}...` : value;
	if (Array.isArray(value)) return value.slice(0, 20).map(item => boundedApprovalValue(item, depth + 1));
	if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).slice(0, 20).map(([name, item]) => [name, boundedApprovalValue(item, depth + 1)]));
	return String(value).slice(0, 512);
};
const boundedApprovalParameters = (value: unknown): string => {
	const parameters = JSON.stringify(boundedApprovalValue(value));
	if (parameters.length <= 4096) return parameters;
	let preview = parameters.slice(0, 4000); let bounded = JSON.stringify({ truncated: true, preview });
	while (bounded.length > 4096) { preview = preview.slice(0, Math.max(0, preview.length - (bounded.length - 4096))); bounded = JSON.stringify({ truncated: true, preview }); }
	return bounded;
};
export const createChildToolApprovalView = (request: AgentSubagentToolBrokerRequest): ChildToolApprovalView => {
	if ((request.tool.kind !== 'builtin' && request.tool.kind !== 'mcp') || !request.tool.approval || (request.tool.kind === 'mcp' && !request.tool.mcpServerName)) throw new Error('child_tool_approval_not_presentable');
	const key = Object.freeze({ parentId: request.parentId, generation: request.generation, childId: request.childId, batchId: request.batchId, batchOrdinal: request.batchOrdinal, toolId: request.toolId, snapshotRevision: request.snapshotRevision });
	const parameters = boundedApprovalParameters(request.rawParams);
	const toolName = request.name.slice(0, 128); const mcpServerName = request.tool.mcpServerName?.slice(0, 128); const toolKind = request.tool.kind === 'mcp' ? 'mcp' as const : 'builtin' as const;
	const title = toolKind === 'mcp' ? `MCP tool — ${mcpServerName} / ${toolName}` : `Built-in tool — ${toolName}`;
	return Object.freeze({ key, structuralKey: childToolApprovalStructuralKey(key), childShortId: request.childId.slice(0, 8), title, toolName, toolKind, ...(toolKind === 'mcp' && mcpServerName ? { mcpServerName } : {}), category: request.tool.approval as ChildToolApprovalView['category'], parameters, status: 'awaiting' });
};
export interface AgentSubagentToolBroker {
	execute(request: AgentSubagentToolBrokerRequest): Promise<AgentSubagentToolBrokerResult>;
	cancel(request: AgentSubagentToolBrokerRequest): Promise<void>;
}

export const isMutationCapableSnapshot = (snapshot: AgentSubagentToolSnapshot | undefined): boolean =>
	!!snapshot?.tools.some(tool => tool.kind === 'mcp' || tool.approval === 'edits' || tool.approval === 'terminal' || tool.approval === 'MCP tools');

/** The parent exposes child controls only through these tested native provider serializers. */
export const isNativeAgentToolFormat = (format: unknown): format is 'openai-style' | 'anthropic-style' | 'gemini-style' =>
	format === 'openai-style' || format === 'anthropic-style' || format === 'gemini-style';

export const readOnlyChildToolNames = Object.freeze([
	'read_file', 'ls_dir', 'search_pathnames_only', 'search_for_files', 'search_in_file',
] as const);

export const isToolAllowedByProfile = (profile: ToolExecutionProfile, name: string): boolean =>
	profile === 'default-parent' || profile === 'inherited-parent-write-child' || (readOnlyChildToolNames as readonly string[]).includes(name);

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
export type AgentSubagentBudgetView = Readonly<{ accepted: number; running: number; queued: number; maxAccepted: number; maxConcurrent: number; providerSends: number; activeProviderSends: number; maxProviderSends: number; resultChars: number; retainedResultChars: number; maxResultChars: number; truncatedResultCount: number; maxChildSummaryChars: number; usage: null }>;
/** Scheduler state is intentionally separate from terminal status: a timed-out wait may be ready to resume but still queued behind another lease. */
export type AgentSubagentRunView = Readonly<{ id: string; parentRunId?: string; depth: number; remainingDepth: number; status: AgentSubagentStatus; schedulerActivity: 'active' | 'waiting_children' | 'ready_to_resume' | 'quiescing'; summary?: string; resultTruncated?: true; roleName?: string; roleDescription?: string; capabilityProfile?: 'read_only' | 'inherit_parent_write'; toolPresentation?: Readonly<{ toolNames: readonly string[]; approvals: readonly string[]; undoAvailable: boolean; applicationBoundary: 'no_os_sandbox' }>; queuedMs: number; runningMs: number; totalMs: number; authority: Readonly<{ runtimeRevision: string; instructionsRevision: string; catalogRevision: string; modelFingerprint?: string; roleRevision?: string; selectedSkills: readonly Readonly<{ identity: string; bodyRevision: string }>[] }>; usage: null }>;
export type AgentSubagentTraceKind = 'group_created' | 'admission_started' | 'admission_failed' | 'child_queued' | 'child_running' | 'provider_send' | 'child_completed' | 'child_failed' | 'child_cancelled' | 'receipt_delivered' | 'group_cancelled';
export type AgentSubagentTraceEvent = Readonly<{ sequence: number; parentId: string; generation: number; childId?: string; kind: AgentSubagentTraceKind; timestamp: number; elapsedMs: number; status?: Exclude<AgentSubagentStatus, 'queued' | 'running'>; diagnostic?: AgentSubagentTraceDiagnostic; budget: Readonly<{ accepted: number; running: number; queued: number; providerSends: number; resultChars: number }> }>;
export type AgentSubagentTraceDiagnostic = 'cancelled' | 'model_missing' | 'provider_invalid' | 'owner_changed' | 'role_not_found' | 'role_stale' | 'skill_unavailable' | 'budget_exhausted' | 'provider_error' | 'result_retention_truncated' | 'timeout' | 'unknown';
export type AgentSubagentDiagnosticsView = Readonly<{ parentId: string; generation: number; elapsedMs: number; events: readonly AgentSubagentTraceEvent[]; droppedEvents: number; completed: number; failed: number; cancelled: number; usage: null }>;
export const isActiveChildRun = <T extends { readonly status: AgentSubagentStatus }>(view: T | undefined): boolean => view?.status === 'queued' || view?.status === 'running';
export const agentSubagentStatusLabel = (status: AgentSubagentStatus): string => ({ queued: 'Queued', running: 'Running', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled' })[status];
export type AgentSubagentControlName = 'spawn_agent' | 'wait_agent' | 'interrupt_agent';

export const AGENT_SUBAGENT_MAX_MESSAGE_CHARS = 8_000;
export const AGENT_SUBAGENT_MAX_WAIT_MS = 30_000;
export const AGENT_SUBAGENT_DEFAULT_WAIT_MS = 10_000;
export const AGENT_SUBAGENT_MAX_RESULTS = 100;
export const AGENT_SUBAGENT_MAX_CONCURRENT = 2;
export const AGENT_SUBAGENT_MAX_ACCEPTED = 4;
/** Protocol ceiling; a turn's configured accepted-child limit can be lower. */
export const AGENT_SUBAGENT_MAX_WAIT_TARGETS = 8;
export const AGENT_SUBAGENT_MAX_GROUP_PROVIDER_SENDS = 64;
export const AGENT_SUBAGENT_MAX_AGGREGATE_RESULT_CHARS = 32_000;
/** UI-only transient trace; it is intentionally absent from model-facing wait receipts. */
export const AGENT_SUBAGENT_MAX_TRACE_EVENTS = 128;

const flatObject = (properties: Record<string, unknown>, required: readonly string[] = []) => ({
	type: 'object', additionalProperties: false, ...(required.length ? { required: [...required] } : {}), properties,
});
const deepFreeze = <T>(value: T): T => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item); Object.freeze(value); } return value; };

/** Flat schemas are intentionally dialect-conservative. Runtime validation below is authoritative. */
export const agentSubagentToolSchemas = deepFreeze({
	spawn_agent: flatObject({ message: { type: 'string', minLength: 1, maxLength: AGENT_SUBAGENT_MAX_MESSAGE_CHARS }, agent_type: { type: 'string', minLength: 1, maxLength: 64 } }, ['message']),
	wait_agent: flatObject({ timeout_ms: { type: 'integer', minimum: 0, maximum: AGENT_SUBAGENT_MAX_WAIT_MS }, targets: { type: 'array', minItems: 1, maxItems: AGENT_SUBAGENT_MAX_WAIT_TARGETS, items: { type: 'string', minLength: 1, maxLength: 256 } } }),
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
		if (targets !== undefined && (!Array.isArray(targets) || targets.length < 1 || targets.length > AGENT_SUBAGENT_MAX_WAIT_TARGETS || targets.some(target => typeof target !== 'string' || !target.trim() || target.length > 256) || new Set(targets).size !== targets.length)) throw new Error('wait_agent_invalid_params');
		return { name, timeoutMs: timeoutMs as number, ...(targets === undefined ? {} : { targets: Object.freeze([...targets]) }) };
	}
	if (!exactKeys(raw, ['target']) || typeof raw.target !== 'string' || !raw.target.trim() || raw.target.length > 256) throw new Error('interrupt_agent_invalid_params');
	return { name, target: raw.target };
};

export const isAgentSubagentControlName = (name: string): name is AgentSubagentControlName =>
	name === 'spawn_agent' || name === 'wait_agent' || name === 'interrupt_agent';

export type AgentSubagentReceipt = Readonly<{ id: string; status: Exclude<AgentSubagentStatus, 'queued' | 'running'>; summary: string; resultTruncated?: true; usage: null }>;

/** A small CAS-like state holder: completion/interrupt/late callbacks cannot settle twice. */
export class AgentSubagentLifecycle {
	private _status: AgentSubagentStatus = 'queued';
	private _receipt: AgentSubagentReceipt | undefined;
	private _terminalDelivered = false;

	get status(): AgentSubagentStatus { return this._status; }
	start(): boolean { if (this._status !== 'queued') return false; this._status = 'running'; return true; }
	settle(status: Exclude<AgentSubagentStatus, 'queued' | 'running'>, id: string, summary: string, resultTruncated = false): boolean {
		if (this._receipt) return false;
		this._status = status;
		this._receipt = Object.freeze({ id, status, summary: summary.slice(0, AGENT_SUBAGENT_MAX_MESSAGE_CHARS), ...(resultTruncated ? { resultTruncated: true as const } : {}), usage: null });
		return true;
	}
	receipt(deliverSummary: boolean): { receipt: AgentSubagentReceipt | undefined; deliverSummary: boolean } {
		const shouldDeliver = !!this._receipt && deliverSummary && !this._terminalDelivered;
		if (shouldDeliver) this._terminalDelivered = true;
		return { receipt: this._receipt && (shouldDeliver ? this._receipt : Object.freeze({ ...this._receipt, summary: '' })), deliverSummary: shouldDeliver };
	}
}
