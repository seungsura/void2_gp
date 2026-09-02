/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { StringSHA1 } from '../../../../base/common/hash.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { isAgentDelegationSelection, StagingSelectionItem } from './chatThreadServiceTypes.js';
import { THREAD_STORAGE_MIGRATION_COMPLETE_KEY, THREAD_STORAGE_RECORD_PREFIX } from './storageKeys.js';

export const PENDING_CHAT_INPUT_BROKER_CHANNEL_NAME = 'void-channel-pending-chat-inputs';
export const PENDING_CHAT_INPUT_MAX_RECORDS = 32;
export const PENDING_CHAT_INPUT_MAX_SERIALIZED_BYTES = 64 * 1024;
export const PENDING_CHAT_INPUT_LEGACY_IMPORT_MAX_RECORDS = 256;
export const PENDING_CHAT_INPUT_RAW_RESTORE_MAX_BYTES = 512 * 1024;
export const PENDING_CHAT_INPUT_SESSION_TIMEOUT_MS = 90_000;
export const PENDING_CHAT_INPUT_HEARTBEAT_MS = 15_000;
export const PENDING_CHAT_INPUT_APPEND_LEASE_TIMEOUT_MS = 30_000;
export const PENDING_CHAT_INPUT_CLAIM_ID_RESERVE = '00000000-0000-0000-0000-000000000000';
export const PENDING_CHAT_INPUT_MUTATION_RECEIPT_PREFIX = 'void.pendingChatInputBrokerV2.chatMutation.';
export const PENDING_CHAT_INPUT_GLOBAL_MUTATION_KEY = 'void.pendingChatInputBrokerV2.globalMutation';
export const PENDING_CHAT_INPUT_THREAD_ANCHOR_FIELD = 'pendingInputAnchorLeaseId';

export type PendingInputMode = 'queue' | 'steer' | 'stop_and_send';
export type PendingChatInputPhase = 'queued' | 'steering' | 'claiming' | 'dormant';

export type PendingChatInput = Readonly<{
	id: string;
	threadId: string;
	text: string;
	draft: string;
	selections: readonly StagingSelectionItem[];
	mode: PendingInputMode;
	order: number;
	createdAt: number;
	ownerProjectRoot: string | undefined;
	trustedAtSubmit: boolean;
	generation: number;
	runId?: string;
	targetRunId?: string;
	targetGeneration?: number;
	targetChildGeneration?: number;
	targetChildIds?: readonly string[];
	claimId?: string;
	phase: PendingChatInputPhase;
}>;

export type PendingChatInputNamespace = Readonly<{ profileId: string; workspaceIdentity: string }>;
export type PendingChatInputSnapshot = Readonly<{
	namespace: PendingChatInputNamespace;
	revision: number;
	records: readonly PendingChatInput[];
}>;
export type PendingChatInputChildGroupEvent = Readonly<{ threadId: string }>;
export type PendingChatInputAuthority = Readonly<{
	threadExists: boolean;
	ownerProjectRoot: string | undefined;
	workspaceTrusted: boolean;
	generation: number;
}>;
export type PendingChatInputFailureReason = 'invalid_request' | 'not_initialized' | 'backend_unavailable' | 'full' | 'conflict' | 'owner_or_trust_changed' | 'append_in_progress';
export type PendingChatInputMutationResult<T = undefined> = Readonly<
	| { ok: true; snapshot: PendingChatInputSnapshot; value: T }
	| { ok: false; reason: PendingChatInputFailureReason; snapshot?: PendingChatInputSnapshot; authoritativeRaw?: string }
>;
export type PendingChatInputInitializeResult = PendingChatInputMutationResult<Readonly<{
	sessionId: string;
	removeLegacy: boolean;
	warning?: string;
	recovery?: Readonly<{ kind: 'thread-delete' | 'namespace-clear'; leaseId: string; threadId?: string }>;
}>>;
export type PendingChatInputClaim = Readonly<{ record: PendingChatInput; fingerprint: string }>;
export type PendingChatInputAppendLease = Readonly<{ record: PendingChatInput; claimId: string; leaseId: string; selectionsFingerprint: string }>;
export type PendingChatInputDirectAppendLease = Readonly<{ leaseId: string; pendingInputId: string; selectionsFingerprint: string }>;
export type PendingChatInputThreadAnchorLease = Readonly<{ existing: boolean; leaseId?: string }>;
export type PendingChatInputMutationLease = Readonly<{ leaseId: string }>;
export type PendingChatInputHistoryInspection = Readonly<{ kind: 'zero' | 'exact' | 'invalid' | 'tombstone'; envelopeRaw?: string }>;
export type PendingChatInputMutationEvidence = Readonly<{ baselineFingerprint: string; expectedFingerprint: string }>;
export type PendingChatInputApprovalIdentity = Readonly<{ toolId: string; name: string; batchId?: string; batchOrdinal?: number }>;
export type PendingChatInputChildGroupIdentity = Readonly<{ sourceRevision: number; generation?: number; childIds: readonly string[] }>;

export interface PendingChatInputBrokerStorage {
	readonly whenReady: Promise<void>;
	get(key: string): string | undefined;
	store(key: string, value: string): void;
	storeAll?(entries: readonly Readonly<{ key: string; value: string }>[]): void;
	remove(key: string): void;
	storeUser(key: string, value: string): void;
	removeUser(key: string): void;
	keys(target: 'machine' | 'user'): readonly string[];
	flush(): Promise<void>;
}

export interface PendingChatInputBrokerInitializeRequest {
	readonly namespace: PendingChatInputNamespace;
	readonly legacyRaw?: string;
	readonly knownThreadIds: readonly string[];
	readonly deliveredPendingInputIds: Readonly<Record<string, readonly string[]>>;
}

export interface PendingChatInputBrokerSubmitRequest {
	readonly sessionId: string;
	readonly threadId: string;
	readonly text: string;
	readonly selections: readonly StagingSelectionItem[];
	readonly mode: PendingInputMode;
	readonly phase: 'queued' | 'steering';
	readonly ownerProjectRoot: string | undefined;
	readonly trustedAtSubmit: boolean;
	readonly generation: number;
	readonly runId?: string;
	readonly targetRunId?: string;
	readonly targetGeneration?: number;
	readonly targetChildGeneration?: number;
	readonly targetChildIds?: readonly string[];
}

export interface PendingChatInputBrokerServiceShape {
	readonly onDidChange: Event<PendingChatInputSnapshot>;
	readonly onDidChangeChildGroup: Event<PendingChatInputChildGroupEvent>;
	initializeNamespace(request: PendingChatInputBrokerInitializeRequest): Promise<PendingChatInputInitializeResult>;
	heartbeat(sessionId: string): Promise<PendingChatInputMutationResult>;
	syncActiveChildGroup(sessionId: string, threadId: string, sourceRunId: string, sourceGeneration: number, sourceRevision: number, generation: number | undefined, childIds: readonly string[]): Promise<PendingChatInputMutationResult>;
	submit(request: PendingChatInputBrokerSubmitRequest): Promise<PendingChatInputMutationResult<PendingChatInput>>;
	edit(sessionId: string, threadId: string, id: string, fingerprint: string, text: string, selections?: readonly StagingSelectionItem[]): Promise<PendingChatInputMutationResult>;
	delete(sessionId: string, threadId: string, id: string, fingerprint: string): Promise<PendingChatInputMutationResult>;
	reorder(sessionId: string, threadId: string, id: string, fingerprint: string, threadFingerprint: string, beforeId?: string): Promise<PendingChatInputMutationResult>;
	resume(sessionId: string, threadId: string, id: string, fingerprint: string, authority: PendingChatInputAuthority): Promise<PendingChatInputMutationResult>;
	suspend(sessionId: string, threadId: string, id: string, fingerprint: string): Promise<PendingChatInputMutationResult>;
	claimNextQueued(sessionId: string, threadId: string, authority: PendingChatInputAuthority, deliveredIds: readonly string[]): Promise<PendingChatInputMutationResult<PendingChatInputClaim | undefined>>;
	claimSteerAtBoundary(sessionId: string, threadId: string, runId: string, generation: number, authority: PendingChatInputAuthority, deliveredIds: readonly string[]): Promise<PendingChatInputMutationResult<PendingChatInputClaim | undefined>>;
	authorizeAppend(sessionId: string, threadId: string, id: string, claimId: string, fingerprint: string, authority: PendingChatInputAuthority, runId: string, generation: number): Promise<PendingChatInputMutationResult<PendingChatInputAppendLease>>;
	authorizeDirectHistoryAppend(sessionId: string, threadId: string, text: string, selections: readonly StagingSelectionItem[], runId: string, generation: number): Promise<PendingChatInputMutationResult<PendingChatInputDirectAppendLease>>;
	verifyDirectHistoryAndRelease(sessionId: string, threadId: string, leaseId: string): Promise<PendingChatInputMutationResult<PendingChatInputHistoryInspection>>;
	abandonDirectHistoryAppend(sessionId: string, threadId: string, leaseId: string): Promise<PendingChatInputMutationResult>;
	authorizeThreadAnchor(sessionId: string, threadId: string): Promise<PendingChatInputMutationResult<PendingChatInputThreadAnchorLease>>;
	verifyThreadAnchorAndRelease(sessionId: string, threadId: string, leaseId: string): Promise<PendingChatInputMutationResult>;
	abandonThreadAnchor(sessionId: string, threadId: string, leaseId: string): Promise<PendingChatInputMutationResult>;
	inspectAppendHistory(sessionId: string, threadId: string, id: string, claimId: string, leaseId: string | undefined): Promise<PendingChatInputMutationResult<PendingChatInputHistoryInspection>>;
	verifyHistoryAndSettle(sessionId: string, threadId: string, id: string, claimId: string, leaseId: string): Promise<PendingChatInputMutationResult<PendingChatInputHistoryInspection>>;
	settleClaim(sessionId: string, threadId: string, id: string, claimId: string, leaseId: string | undefined, result: 'queued' | 'dormant'): Promise<PendingChatInputMutationResult>;
	validateHistoryRun(sessionId: string, threadId: string, runId: string, generation: number): Promise<PendingChatInputMutationResult>;
	holdApproval(sessionId: string, threadId: string, runId: string, generation: number, approval: PendingChatInputApprovalIdentity): Promise<PendingChatInputMutationResult>;
	closeRunAndReleaseSteers(sessionId: string, threadId: string, runId: string, generation: number, authority: PendingChatInputAuthority, retainApproval?: boolean, childGroup?: PendingChatInputChildGroupIdentity): Promise<PendingChatInputMutationResult>;
	reconcileDeliveredPendingInputIds(sessionId: string, delivered: Readonly<Record<string, readonly string[]>>): Promise<PendingChatInputMutationResult>;
	commitThreadRecord(sessionId: string, threadId: string, expectedRaw: string | undefined, nextRaw: string): Promise<PendingChatInputMutationResult<string>>;
	deleteThreadRecords(sessionId: string, threadId: string, evidence: PendingChatInputMutationEvidence): Promise<PendingChatInputMutationResult<PendingChatInputMutationLease>>;
	finalizeThreadDeletion(sessionId: string, threadId: string, leaseId: string): Promise<PendingChatInputMutationResult>;
	abortThreadDeletion(sessionId: string, threadId: string, leaseId: string): Promise<PendingChatInputMutationResult>;
	clearNamespace(sessionId: string, evidence: PendingChatInputMutationEvidence): Promise<PendingChatInputMutationResult<PendingChatInputMutationLease>>;
	finalizeNamespaceClear(sessionId: string, leaseId: string): Promise<PendingChatInputMutationResult>;
	abortNamespaceClear(sessionId: string, leaseId: string): Promise<PendingChatInputMutationResult>;
	releaseSession(sessionId: string): Promise<PendingChatInputMutationResult>;
}

type StoredMutation = Readonly<(({ kind: 'thread-delete'; leaseId: string; threadId: string } | { kind: 'namespace-clear'; leaseId: string }) & PendingChatInputMutationEvidence) & { originNamespace: PendingChatInputNamespace }>;
type StoredCompletedMutation = Readonly<StoredMutation & { outcome: 'committed' }>;
type StoredEnvelope = Readonly<{ version: 2; namespace: PendingChatInputNamespace; revision: number; records: readonly unknown[] }>;
type StoredGlobalMutationEnvelope = Readonly<{ version: 1; mutation?: StoredMutation; completedMutation?: StoredCompletedMutation }>;
type NamespaceState = {
	readonly namespace: PendingChatInputNamespace;
	revision: number;
	records: PendingChatInput[];
	tail: Promise<void>;
	loaded: boolean;
	hadStoredEnvelope: boolean;
	initialProjectionCompacted: boolean;
	loadWarning?: string;
};
type SessionState = { readonly id: string; readonly ctx: string; readonly namespaceKey: string; lastHeartbeat: number };
type ClaimOwner = { readonly sessionId: string; readonly claimId: string; readonly threadId: string; leaseId?: string; leaseExpiresAt?: number };
type MutationOwner = { readonly sessionId: string; readonly leaseId: string; expiresAt: number };
type HistoryWriteOwner = Readonly<{ kind: 'claim' | 'direct' | 'anchor'; leaseId: string; text?: string; selectionsFingerprint?: string; pendingInputId?: string }>;
type ActiveChildGroup = Readonly<{ sourceRevision: number; generation: number; childIds: readonly string[] }>;
type HistoryRunOwner = {
	readonly kind: 'run' | 'child' | 'anchor';
	readonly sessionId: string;
	readonly namespaceKey: string;
	readonly threadId: string;
	expiresAt: number;
	runId?: string;
	generation?: number;
	write?: HistoryWriteOwner;
	approvalKey?: string;
	childGroup?: ActiveChildGroup;
	childSourceRevision?: number;
	sourceRunId?: string;
	sourceGeneration?: number;
};
type ClosedRunIdentity = Readonly<{ runId: string; generation: number }>;

const isPlainObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isNonemptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const isPendingInputMode = (value: unknown): value is PendingInputMode => value === 'queue' || value === 'steer' || value === 'stop_and_send';
const isPhase = (value: unknown): value is PendingChatInputPhase => value === 'queued' || value === 'steering' || value === 'claiming' || value === 'dormant';
const cloneSelection = (selection: StagingSelectionItem): StagingSelectionItem => {
	switch (selection.type) {
		case 'File': return { ...selection, uri: URI.revive(selection.uri), state: { ...selection.state } };
		case 'CodeSelection': return { ...selection, uri: URI.revive(selection.uri), range: [...selection.range] as [number, number], state: { ...selection.state } };
		case 'Folder': return { ...selection, uri: URI.revive(selection.uri) };
		case 'Agent': return { ...selection };
		case 'Skill': return { ...selection };
	}
};
const freezeRecord = (record: PendingChatInput): PendingChatInput => Object.freeze({ ...record, selections: Object.freeze(record.selections.map(cloneSelection)), ...(record.targetChildIds ? { targetChildIds: Object.freeze([...record.targetChildIds]) } : {}) });

export const revivePendingChatSelection = (value: unknown): StagingSelectionItem | undefined => {
	if (!isPlainObject(value)) return undefined;
	const reviveUri = (candidate: unknown): URI | undefined => {
		if (URI.isUri(candidate)) return URI.revive(candidate);
		if (!isPlainObject(candidate) || candidate.$mid !== 1 || typeof candidate.scheme !== 'string' || typeof candidate.path !== 'string') return undefined;
		try { return URI.revive(candidate as never); } catch { return undefined; }
	};
	if (value.type === 'File') {
		const uri = reviveUri(value.uri);
		if (!uri || typeof value.language !== 'string' || !isPlainObject(value.state) || typeof value.state.wasAddedAsCurrentFile !== 'boolean') return undefined;
		return { type: 'File', uri, language: value.language, state: { wasAddedAsCurrentFile: value.state.wasAddedAsCurrentFile } };
	}
	if (value.type === 'CodeSelection') {
		const uri = reviveUri(value.uri);
		if (!uri || typeof value.language !== 'string' || !Array.isArray(value.range) || value.range.length !== 2 || !value.range.every(Number.isSafeInteger) || !isPlainObject(value.state) || typeof value.state.wasAddedAsCurrentFile !== 'boolean') return undefined;
		return { type: 'CodeSelection', uri, language: value.language, range: [value.range[0] as number, value.range[1] as number], state: { wasAddedAsCurrentFile: value.state.wasAddedAsCurrentFile } };
	}
	if (value.type === 'Folder') {
		const uri = reviveUri(value.uri);
		return uri ? { type: 'Folder', uri } : undefined;
	}
	if (value.type === 'Agent') return isAgentDelegationSelection(value) ? { ...value } : undefined;
	if (value.type === 'Skill' && isNonemptyString(value.identity) && isNonemptyString(value.catalogRevision) && isNonemptyString(value.bodyRevision) && isNonemptyString(value.skillRoot) && typeof value.description === 'string') {
		return { type: 'Skill', identity: value.identity, catalogRevision: value.catalogRevision, bodyRevision: value.bodyRevision, skillRoot: value.skillRoot, description: value.description };
	}
	return undefined;
};

export const revivePendingChatInput = (value: unknown, forceDormant = false, normalizeClaiming = forceDormant): PendingChatInput | undefined => {
	if (!isPlainObject(value)) return undefined;
	const selections = Array.isArray(value.selections) ? value.selections.map(revivePendingChatSelection) : [];
	if (!Array.isArray(value.selections) || selections.some(selection => !selection)) return undefined;
	if (!isNonemptyString(value.id) || !isNonemptyString(value.threadId) || typeof value.text !== 'string' || !value.text.trim() || !isPendingInputMode(value.mode)
		|| !Number.isSafeInteger(value.order) || (value.order as number) < 0 || !Number.isSafeInteger(value.createdAt) || (value.createdAt as number) < 0
		|| (value.ownerProjectRoot !== undefined && typeof value.ownerProjectRoot !== 'string') || typeof value.trustedAtSubmit !== 'boolean'
		|| !Number.isSafeInteger(value.generation) || (value.generation as number) < 0 || (value.runId !== undefined && typeof value.runId !== 'string')
		|| (value.targetRunId !== undefined && typeof value.targetRunId !== 'string') || (value.targetGeneration !== undefined && (!Number.isSafeInteger(value.targetGeneration) || (value.targetGeneration as number) < 0))
		|| (value.targetChildGeneration !== undefined && (!Number.isSafeInteger(value.targetChildGeneration) || (value.targetChildGeneration as number) < 0))
		|| (value.targetChildIds !== undefined && !Array.isArray(value.targetChildIds))
		|| !isPhase(value.phase) || (value.claimId !== undefined && typeof value.claimId !== 'string')) return undefined;
	const childIds = Array.isArray(value.targetChildIds) ? value.targetChildIds : undefined;
	const childIdsValid = !!childIds && childIds.length > 0 && childIds.length <= 256 && childIds.every((id, index) => isNonemptyString(id) && id.length <= 256 && (index === 0 || (childIds[index - 1] as string).localeCompare(id) < 0));
	const hasParentStopTarget = isNonemptyString(value.targetRunId) && Number.isSafeInteger(value.targetGeneration) && (value.targetGeneration as number) >= 0 && (value.targetGeneration as number) < Number.MAX_SAFE_INTEGER && value.generation === (value.targetGeneration as number) + 1 && value.targetChildGeneration === undefined && value.targetChildIds === undefined;
	const hasChildStopTarget = value.targetRunId === undefined && value.targetGeneration === undefined && Number.isSafeInteger(value.targetChildGeneration) && (value.targetChildGeneration as number) >= 0 && (value.targetChildGeneration as number) < Number.MAX_SAFE_INTEGER && childIdsValid && value.generation === (value.targetChildGeneration as number) + 1;
	const hasStopTarget = hasParentStopTarget || hasChildStopTarget;
	const hasNoStopTarget = value.targetRunId === undefined && value.targetGeneration === undefined && value.targetChildGeneration === undefined && value.targetChildIds === undefined;
	const storedTupleIsValid = value.phase === 'dormant'
		? hasNoStopTarget && value.runId === undefined && value.claimId === undefined
		: (value.phase === 'queued' && value.mode !== 'steer' && value.runId === undefined && value.claimId === undefined && (value.mode === 'stop_and_send' ? hasNoStopTarget || hasStopTarget : hasNoStopTarget))
			|| (value.phase === 'steering' && value.mode === 'steer' && isNonemptyString(value.runId) && value.claimId === undefined && hasNoStopTarget)
			|| (value.phase === 'claiming' && isNonemptyString(value.claimId) && (value.mode === 'steer' ? isNonemptyString(value.runId) : value.runId === undefined) && (value.mode === 'stop_and_send' ? hasNoStopTarget || hasStopTarget : hasNoStopTarget));
	if (!storedTupleIsValid) return undefined;
	const phase = forceDormant || (normalizeClaiming && value.phase === 'claiming') ? 'dormant' : value.phase as PendingChatInputPhase;
	return freezeRecord({ id: value.id, threadId: value.threadId, text: value.text, draft: typeof value.draft === 'string' ? value.draft : value.text, selections: selections as StagingSelectionItem[], mode: value.mode, order: value.order as number, createdAt: value.createdAt as number, ownerProjectRoot: value.ownerProjectRoot as string | undefined, trustedAtSubmit: value.trustedAtSubmit, generation: value.generation as number, ...(typeof value.runId === 'string' && (phase === 'steering' || phase === 'claiming') ? { runId: value.runId } : {}), ...(phase !== 'dormant' && hasParentStopTarget ? { targetRunId: value.targetRunId, targetGeneration: value.targetGeneration as number } : {}), ...(phase !== 'dormant' && hasChildStopTarget ? { targetChildGeneration: value.targetChildGeneration as number, targetChildIds: childIds as string[] } : {}), ...(phase === 'claiming' && isNonemptyString(value.claimId) ? { claimId: value.claimId } : {}), phase });
};

const canonicalValue = (value: unknown): string => {
	if (value instanceof URI) return JSON.stringify(value.toJSON());
	if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? '[undefined]';
	if (Array.isArray(value)) return `[${value.map(canonicalValue).join(',')}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalValue(record[key])}`).join(',')}}`;
};
export const pendingChatInputFingerprint = (record: PendingChatInput): string => canonicalValue(record);
export const pendingChatInputThreadFingerprint = (records: readonly PendingChatInput[]): string => sha1(canonicalValue([...records].sort(comparePendingChatInputs).map(record => [record.id, pendingChatInputFingerprint(record)])));
export const pendingChatInputSelectionsFingerprint = (selections: readonly StagingSelectionItem[]): string => sha1(canonicalValue(selections.map(cloneSelection)));
export const comparePendingChatInputs = (a: PendingChatInput, b: PendingChatInput): number => a.order - b.order || a.createdAt - b.createdAt || a.id.localeCompare(b.id);
export const comparePendingChatInputsGlobally = (a: PendingChatInput, b: PendingChatInput): number => a.createdAt - b.createdAt || a.threadId.localeCompare(b.threadId) || comparePendingChatInputs(a, b);
export const pendingChatInputEnvelopeBytes = (records: readonly PendingChatInput[], reserveClaim = false): number => {
	const serialized = [...records].sort(comparePendingChatInputsGlobally).map(record => ({ ...record, selections: record.selections.map(cloneSelection), ...(reserveClaim ? { phase: 'claiming' as const, claimId: PENDING_CHAT_INPUT_CLAIM_ID_RESERVE } : {}) }));
	return new TextEncoder().encode(JSON.stringify({ version: 1, records: serialized })).byteLength;
};
export const pendingChatInputsFit = (records: readonly PendingChatInput[]): boolean => records.length <= PENDING_CHAT_INPUT_MAX_RECORDS && pendingChatInputEnvelopeBytes(records, true) <= PENDING_CHAT_INPUT_MAX_SERIALIZED_BYTES;

const namespaceKey = (namespace: PendingChatInputNamespace): string => JSON.stringify([namespace.profileId, namespace.workspaceIdentity]);
const sha1 = (value: string): string => { const hash = new StringSHA1(); hash.update(value); return hash.digest(); };
const storageKey = (namespace: PendingChatInputNamespace): string => `void.pendingChatInputBrokerV2.${sha1(namespaceKey(namespace))}`;
const migrationKey = (namespace: PendingChatInputNamespace): string => `void.pendingChatInputBrokerV2.legacy.${sha1(namespace.workspaceIdentity)}`;
const recordKey = (threadId: string, id: string): string => JSON.stringify([threadId, id]);
export const pendingChatInputThreadStorageKey = (threadId: string): string => `${THREAD_STORAGE_RECORD_PREFIX}${encodeURIComponent(threadId)}`;
export const pendingChatInputMutationReceiptKey = (leaseId: string): string => `${PENDING_CHAT_INPUT_MUTATION_RECEIPT_PREFIX}${encodeURIComponent(leaseId)}`;
export const isPendingChatInputThreadStorageKey = (key: string): boolean => {
	if (!key.startsWith(THREAD_STORAGE_RECORD_PREFIX) || key === THREAD_STORAGE_MIGRATION_COMPLETE_KEY) return false;
	try { const id = decodeURIComponent(key.slice(THREAD_STORAGE_RECORD_PREFIX.length)); return isNonemptyString(id) && pendingChatInputThreadStorageKey(id) === key; } catch { return false; }
};
export const pendingChatInputChatStorageFingerprint = (entries: readonly Readonly<{ key: string; value: string | undefined }>[]): string => sha1(JSON.stringify([...entries].sort((a, b) => a.key.localeCompare(b.key)).map(entry => [entry.key, entry.value ?? null])));
const isStorageFingerprint = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
const validMutationEvidence = (value: unknown): value is PendingChatInputMutationEvidence => isPlainObject(value) && isStorageFingerprint(value.baselineFingerprint) && isStorageFingerprint(value.expectedFingerprint);
const validNamespace = (value: unknown): value is PendingChatInputNamespace => isPlainObject(value) && isNonemptyString(value.profileId) && isNonemptyString(value.workspaceIdentity);
const validAuthority = (value: unknown): value is PendingChatInputAuthority => isPlainObject(value) && typeof value.threadExists === 'boolean' && (value.ownerProjectRoot === undefined || typeof value.ownerProjectRoot === 'string') && typeof value.workspaceTrusted === 'boolean' && Number.isSafeInteger(value.generation) && (value.generation as number) >= 0;
const validApprovalIdentity = (value: unknown): value is PendingChatInputApprovalIdentity => isPlainObject(value)
	&& isNonemptyString(value.toolId) && isNonemptyString(value.name)
	&& ((value.batchId === undefined && value.batchOrdinal === undefined) || (isNonemptyString(value.batchId) && Number.isSafeInteger(value.batchOrdinal) && (value.batchOrdinal as number) >= 0));
const validChildGroupIdentity = (value: unknown): value is PendingChatInputChildGroupIdentity => isPlainObject(value)
	&& Number.isSafeInteger(value.sourceRevision) && (value.sourceRevision as number) >= 0
	&& Array.isArray(value.childIds) && value.childIds.length <= 256
	&& value.childIds.every((id, index) => isNonemptyString(id) && id.length <= 256 && (index === 0 || (value.childIds as string[])[index - 1]!.localeCompare(id) < 0))
	&& (value.childIds.length > 0
		? Number.isSafeInteger(value.generation) && (value.generation as number) >= 0 && (value.generation as number) < Number.MAX_SAFE_INTEGER
		: value.generation === undefined);
const approvalIdentityKey = (value: PendingChatInputApprovalIdentity): string => JSON.stringify([value.toolId, value.name, value.batchId ?? null, value.batchOrdinal ?? null]);
const reviveStoredMutation = (value: unknown): StoredMutation | undefined => {
	if (!isPlainObject(value) || !isNonemptyString(value.leaseId) || !isStorageFingerprint(value.baselineFingerprint) || !isStorageFingerprint(value.expectedFingerprint) || !validNamespace(value.originNamespace)) return undefined;
	const evidence = { baselineFingerprint: value.baselineFingerprint, expectedFingerprint: value.expectedFingerprint };
	const originNamespace = Object.freeze({ ...value.originNamespace });
	if (value.kind === 'namespace-clear') return Object.freeze({ kind: 'namespace-clear', leaseId: value.leaseId, originNamespace, ...evidence });
	if (value.kind === 'thread-delete' && isNonemptyString(value.threadId)) return Object.freeze({ kind: 'thread-delete', leaseId: value.leaseId, threadId: value.threadId, originNamespace, ...evidence });
	return undefined;
};
const reviveCompletedMutation = (value: unknown): StoredCompletedMutation | undefined => {
	if (!isPlainObject(value) || value.outcome !== 'committed') return undefined;
	const mutation = reviveStoredMutation(value);
	return mutation ? Object.freeze({ ...mutation, outcome: 'committed' }) : undefined;
};

export class PendingChatInputBrokerCore {
	private readonly states = new Map<string, NamespaceState>();
	private readonly sessions = new Map<string, SessionState>();
	private readonly sessionOfContext = new Map<string, string>();
	private readonly claimOwners = new Map<string, ClaimOwner>();
	private readonly recordOwners = new Map<string, string>();
	private readonly historyRunOwners = new Map<string, HistoryRunOwner>();
	private readonly namespaceMutationOwners = new Map<string, MutationOwner>();
	private readonly threadMutationOwners = new Map<string, MutationOwner>();
	// Retain the most recent completed opaque transaction per key so a renderer can
	// safely retry finalize after an IPC acknowledgement is lost. A retry may use a
	// replacement session in the same frozen namespace, but it still needs the exact
	// unguessable lease issued by prepare.
	private readonly completedNamespaceMutations = new Map<string, string>();
	private readonly completedThreadMutations = new Map<string, string>();
	private globalMutation: StoredMutation | undefined;
	private completedGlobalMutation: StoredCompletedMutation | undefined;
	private globalMutationLoaded: Promise<void> | undefined;
	private globalMutationLoadError: string | undefined;
	private operationTail: Promise<void> = Promise.resolve();
	private readonly closedRunGenerationOfThread = new Map<string, number>();
	private readonly closedRunIdentityOfThread = new Map<string, ClosedRunIdentity>();
	private migrationTail: Promise<void> = Promise.resolve();
	private readonly _onDidChange = new Emitter<PendingChatInputSnapshot>();
	readonly onDidChange = this._onDidChange.event;
	private readonly _onDidChangeChildGroup = new Emitter<PendingChatInputChildGroupEvent>();
	readonly onDidChangeChildGroup = this._onDidChangeChildGroup.event;

	constructor(
		private readonly storage: PendingChatInputBrokerStorage,
		private readonly now: () => number = Date.now,
		private readonly uuid: () => string = generateUuid,
	) { }

	private snapshot(state: NamespaceState): PendingChatInputSnapshot {
		return Object.freeze({ namespace: Object.freeze({ ...state.namespace }), revision: state.revision, records: Object.freeze([...state.records].sort(comparePendingChatInputsGlobally).map(freezeRecord)) });
	}
	private failed<T>(reason: PendingChatInputFailureReason, state?: NamespaceState): PendingChatInputMutationResult<T> { return Object.freeze({ ok: false, reason, ...(state ? { snapshot: this.snapshot(state) } : {}) }); }
	private session(ctx: string, sessionId: unknown): { session: SessionState; state: NamespaceState } | undefined {
		if (!isNonemptyString(sessionId)) return undefined;
		const session = this.sessions.get(sessionId);
		if (!session || session.ctx !== ctx || this.sessionOfContext.get(ctx) !== sessionId) return undefined;
		const state = this.states.get(session.namespaceKey);
		return state?.loaded ? { session, state } : undefined;
	}
	private enqueue<T>(state: NamespaceState, operation: () => Promise<T>): Promise<T> {
		void state;
		return this.enqueueOperation(operation);
	}
	private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.operationTail.then(operation, operation);
		this.operationTail = result.then(() => undefined, () => undefined);
		return result;
	}
	private async persist(state: NamespaceState, records: readonly PendingChatInput[], removeUserIfExact?: Readonly<{ key: string; expectedRaw: string }>): Promise<PendingChatInputSnapshot> {
		if (!Number.isSafeInteger(state.revision) || state.revision >= Number.MAX_SAFE_INTEGER) throw new Error('pending_input_revision_overflow');
		const nextRevision = state.revision + 1;
		const envelope: StoredEnvelope = { version: 2, namespace: state.namespace, revision: nextRevision, records: [...records].sort(comparePendingChatInputsGlobally).map(record => ({ ...record, selections: record.selections.map(cloneSelection) })) };
		const key = storageKey(state.namespace);
		const previous = this.storage.get(key);
		let removedUserRaw: string | undefined;
		try {
			this.storage.store(key, JSON.stringify(envelope));
			if (removeUserIfExact && this.storage.get(removeUserIfExact.key) === removeUserIfExact.expectedRaw) {
				removedUserRaw = removeUserIfExact.expectedRaw;
				this.storage.removeUser(removeUserIfExact.key);
			}
			await this.storage.flush();
		}
		catch (error) {
			if (previous === undefined) this.storage.remove(key); else this.storage.store(key, previous);
			if (removedUserRaw !== undefined) this.storage.storeUser(removeUserIfExact!.key, removedUserRaw);
			try { await this.storage.flush(); } catch { /* preserve original failure */ }
			throw error;
		}
		state.records = [...records].map(freezeRecord);
		state.revision = nextRevision;
		const snapshot = this.snapshot(state);
		this._onDidChange.fire(snapshot);
		return snapshot;
	}
	private parseRecords(values: readonly unknown[], forceDormant: boolean, knownThreads?: ReadonlySet<string>, delivered?: ReadonlyMap<string, ReadonlySet<string>>, normalizeClaiming = forceDormant): { records: PendingChatInput[]; omitted: boolean } {
		let omitted = values.length > PENDING_CHAT_INPUT_LEGACY_IMPORT_MAX_RECORDS;
		const revived: PendingChatInput[] = [];
		for (const value of values.slice(0, PENDING_CHAT_INPUT_LEGACY_IMPORT_MAX_RECORDS)) {
			const record = revivePendingChatInput(value, forceDormant, normalizeClaiming);
			if (!record || (knownThreads && !knownThreads.has(record.threadId)) || this.isAuthoritativelyDelivered(record, delivered)) { if (!record) omitted = true; continue; }
			revived.push(record);
		}
		revived.sort(comparePendingChatInputsGlobally);
		const seen = new Set<string>(); const accepted: PendingChatInput[] = [];
		for (const record of revived) { const key = recordKey(record.threadId, record.id); if (seen.has(key) || !pendingChatInputsFit([...accepted, record])) { omitted = true; continue; } seen.add(key); accepted.push(record); }
		return { records: accepted, omitted };
	}
	private parseLegacy(raw: string | undefined, knownThreadIds: readonly string[], deliveredValues: Readonly<Record<string, readonly string[]>>): { records: PendingChatInput[]; warning?: string } {
		if (!raw) return { records: [] };
		if (raw.length > PENDING_CHAT_INPUT_RAW_RESTORE_MAX_BYTES || new TextEncoder().encode(raw).byteLength > PENDING_CHAT_INPUT_RAW_RESTORE_MAX_BYTES) return { records: [], warning: 'Pending inputs were discarded because stored inbox data was too large.' };
		try {
			const parsed = JSON.parse(raw) as unknown;
			const values = Array.isArray(parsed) ? parsed : isPlainObject(parsed) && parsed.version === 1 && Array.isArray(parsed.records) ? parsed.records : undefined;
			if (!values) return { records: [], warning: 'Pending inputs were discarded because stored inbox data was invalid.' };
			const known = new Set(knownThreadIds.filter(isNonemptyString));
			const delivered = new Map(Object.entries(deliveredValues).filter(([threadId, ids]) => isNonemptyString(threadId) && Array.isArray(ids)).map(([threadId, ids]) => [threadId, new Set(ids.filter(isNonemptyString))]));
			const result = this.parseRecords(values, true, known, delivered);
			return { records: result.records, ...(result.omitted ? { warning: 'Some pending inputs were discarded because the stored inbox was invalid or over its limit.' } : {}) };
		} catch { return { records: [], warning: 'Pending inputs were discarded because stored inbox data was invalid.' }; }
	}
	private inspectAppendHistoryValue(threadId: string, pendingInputId: string, expectedDisplayText: string, expectedSelectionsFingerprint: string): PendingChatInputHistoryInspection {
		const raw = this.storage.get(pendingChatInputThreadStorageKey(threadId));
		if (raw === undefined) return Object.freeze({ kind: 'zero' });
		try {
			const envelope = JSON.parse(raw) as unknown;
			if (!isPlainObject(envelope) || envelope.version !== 1 || !Number.isSafeInteger(envelope.revision) || (envelope.revision as number) < 1) return Object.freeze({ kind: 'invalid' });
			if (envelope.deleted === true) return Object.freeze({ kind: 'tombstone' });
			if (!isPlainObject(envelope.thread) || envelope.thread.id !== threadId || !Array.isArray(envelope.thread.messages)) return Object.freeze({ kind: 'invalid' });
			const matches = envelope.thread.messages.filter(message => isPlainObject(message) && message.role === 'user' && message.pendingInputId === pendingInputId);
			if (matches.length === 0) return Object.freeze({ kind: 'zero', envelopeRaw: raw });
			if (matches.length !== 1 || matches[0].displayContent !== expectedDisplayText || matches[0].pendingInputSelectionsFingerprint !== expectedSelectionsFingerprint) return Object.freeze({ kind: 'invalid' });
			return Object.freeze({ kind: 'exact', envelopeRaw: raw });
		} catch { return Object.freeze({ kind: 'invalid' }); }
	}
	private inspectPendingRecordHistory(record: PendingChatInput): PendingChatInputHistoryInspection {
		return this.inspectAppendHistoryValue(record.threadId, record.id, record.text, pendingChatInputSelectionsFingerprint(record.selections));
	}
	private authoritativePendingApprovalKey(threadId: string): string | undefined {
		const raw = this.storage.get(pendingChatInputThreadStorageKey(threadId)); if (!raw) return undefined;
		try {
			const envelope = JSON.parse(raw) as unknown;
			if (!isPlainObject(envelope) || envelope.version !== 1 || envelope.deleted === true || !isPlainObject(envelope.thread) || envelope.thread.id !== threadId || !Array.isArray(envelope.thread.messages)) return undefined;
			const message = envelope.thread.messages.at(-1);
			if (!isPlainObject(message) || message.role !== 'tool' || message.type !== 'tool_request') return undefined;
			const identity = { toolId: message.id, name: message.name, ...(message.batchId === undefined ? {} : { batchId: message.batchId }), ...(message.batchOrdinal === undefined ? {} : { batchOrdinal: message.batchOrdinal }) };
			return validApprovalIdentity(identity) ? approvalIdentityKey(identity) : undefined;
		} catch { return undefined; }
	}
	private hasAuthoritativeThreadAnchor(threadId: string): boolean {
		const raw = this.storage.get(pendingChatInputThreadStorageKey(threadId));
		if (raw === undefined) return false;
		try {
			const envelope = JSON.parse(raw) as unknown;
			return isPlainObject(envelope) && envelope.version === 1 && Number.isSafeInteger(envelope.revision) && (envelope.revision as number) >= 1
				&& envelope.deleted !== true && isPlainObject(envelope.thread) && envelope.thread.id === threadId && Array.isArray(envelope.thread.messages);
		} catch { return false; }
	}
	private anchorLeaseOfThreadEnvelope(threadId: string): string | undefined {
		const raw = this.storage.get(pendingChatInputThreadStorageKey(threadId));
		if (!raw) return undefined;
		try { const envelope = JSON.parse(raw) as unknown; return isPlainObject(envelope) && isNonemptyString(envelope[PENDING_CHAT_INPUT_THREAD_ANCHOR_FIELD]) ? envelope[PENDING_CHAT_INPUT_THREAD_ANCHOR_FIELD] : undefined; }
		catch { return undefined; }
	}
	private async clearThreadAnchorMarker(threadId: string, leaseId: string, removeEmpty: boolean): Promise<void> {
		const key = pendingChatInputThreadStorageKey(threadId); const raw = this.storage.get(key);
		if (!raw) return;
		try {
			const envelope = JSON.parse(raw) as unknown;
			if (!isPlainObject(envelope) || envelope[PENDING_CHAT_INPUT_THREAD_ANCHOR_FIELD] !== leaseId) return;
			const thread = isPlainObject(envelope.thread) ? envelope.thread : undefined;
			if (removeEmpty && thread?.id === threadId && Array.isArray(thread.messages) && thread.messages.length === 0) this.storage.removeUser(key);
			else { const next = { ...envelope }; delete next[PENDING_CHAT_INPUT_THREAD_ANCHOR_FIELD]; this.storage.storeUser(key, JSON.stringify(next)); }
			await this.storage.flush();
		} catch { /* a later cold initialize retries marker recovery */ }
	}
	private brokerStorageContainsThread(threadId: string): boolean {
		for (const key of this.storage.keys('machine').filter(candidate => this.isBrokerEnvelopeKey(candidate))) {
			const raw = this.storage.get(key); if (!raw) continue;
			try { const parsed = JSON.parse(raw) as unknown; if (isPlainObject(parsed) && Array.isArray(parsed.records) && parsed.records.some(record => isPlainObject(record) && record.threadId === threadId)) return true; }
			catch { /* malformed broker data is handled by its namespace load */ }
		}
		return false;
	}
	private brokerStorageContainsActiveThreadRecord(threadId: string): boolean {
		for (const key of this.storage.keys('machine').filter(candidate => this.isBrokerEnvelopeKey(candidate))) {
			const raw = this.storage.get(key); if (!raw) continue;
			try {
				const parsed = JSON.parse(raw) as unknown;
				if (!isPlainObject(parsed) || !Array.isArray(parsed.records)) return true;
				if (parsed.records.some(record => isPlainObject(record) && record.threadId === threadId && (record.phase === 'queued' || record.phase === 'steering' || record.phase === 'claiming'))) return true;
			} catch { return true; }
		}
		return false;
	}
	private brokerStorageContainsOtherThreadRecord(state: NamespaceState, removed: PendingChatInput): boolean {
		const currentKey = storageKey(state.namespace);
		for (const key of this.storage.keys('machine').filter(candidate => this.isBrokerEnvelopeKey(candidate))) {
			const raw = this.storage.get(key); if (!raw) continue;
			try {
				const parsed = JSON.parse(raw) as unknown;
				if (!isPlainObject(parsed) || !Array.isArray(parsed.records)) return true;
				if (parsed.records.some(record => isPlainObject(record) && record.threadId === removed.threadId && !(key === currentKey && record.id === removed.id))) return true;
			} catch { return true; }
		}
		return false;
	}
	private unreferencedEmptyAnchorCleanup(state: NamespaceState, removed: PendingChatInput): Readonly<{ key: string; expectedRaw: string }> | undefined {
		if (this.brokerStorageContainsOtherThreadRecord(state, removed)) return undefined;
		const key = pendingChatInputThreadStorageKey(removed.threadId); const raw = this.storage.get(key); if (!raw) return undefined;
		try {
			const envelope = JSON.parse(raw) as unknown;
			const thread = isPlainObject(envelope) && isPlainObject(envelope.thread) ? envelope.thread : undefined;
			return isPlainObject(envelope) && isNonemptyString(envelope[PENDING_CHAT_INPUT_THREAD_ANCHOR_FIELD]) && envelope.deleted !== true
				&& thread?.id === removed.threadId && Array.isArray(thread.messages) && thread.messages.length === 0
				? Object.freeze({ key, expectedRaw: raw }) : undefined;
		} catch { return undefined; }
	}
	private async reconcileOrphanThreadAnchors(): Promise<void> {
		let changed = false;
		for (const key of this.storage.keys('user').filter(isPendingChatInputThreadStorageKey)) {
			let threadId: string;
			try { threadId = decodeURIComponent(key.slice(THREAD_STORAGE_RECORD_PREFIX.length)); } catch { continue; }
			const leaseId = this.anchorLeaseOfThreadEnvelope(threadId); if (!leaseId) continue;
			const active = this.historyRunOwners.get(threadId);
			if (active?.write?.kind === 'anchor' && active.write.leaseId === leaseId && active.expiresAt > this.now()) continue;
			const raw = this.storage.get(key); if (!raw) continue;
			try {
				const envelope = JSON.parse(raw) as unknown; if (!isPlainObject(envelope)) continue;
				const thread = isPlainObject(envelope.thread) ? envelope.thread : undefined;
				if (!this.brokerStorageContainsThread(threadId) && thread?.id === threadId && Array.isArray(thread.messages) && thread.messages.length === 0) this.storage.removeUser(key);
				else { const next = { ...envelope }; delete next[PENDING_CHAT_INPUT_THREAD_ANCHOR_FIELD]; this.storage.storeUser(key, JSON.stringify(next)); }
				changed = true;
			} catch { /* invalid chat storage remains fail-closed for submit */ }
		}
		if (changed) await this.storage.flush();
	}
	private isAuthoritativelyDelivered(record: PendingChatInput, delivered?: ReadonlyMap<string, ReadonlySet<string>>): boolean {
		return !!delivered?.get(record.threadId)?.has(record.id) && this.inspectPendingRecordHistory(record).kind === 'exact';
	}
	private mutationStorageFingerprint(mutation: StoredMutation): string {
		const keys = mutation.kind === 'thread-delete'
			? [pendingChatInputThreadStorageKey(mutation.threadId)]
			: this.storage.keys('user').filter(isPendingChatInputThreadStorageKey);
		return pendingChatInputChatStorageFingerprint(keys.map(key => ({ key, value: this.storage.get(key) })));
	}
	private mutationStorageState(mutation: StoredMutation): 'baseline' | 'expected' | 'ambiguous' {
		const fingerprint = this.mutationStorageFingerprint(mutation);
		const hasReceipt = this.storage.get(pendingChatInputMutationReceiptKey(mutation.leaseId)) === mutation.leaseId;
		if (fingerprint === mutation.expectedFingerprint && (mutation.expectedFingerprint !== mutation.baselineFingerprint || hasReceipt)) return 'expected';
		return fingerprint === mutation.baselineFingerprint && !hasReceipt ? 'baseline' : 'ambiguous';
	}
	private isBrokerEnvelopeKey(key: string): boolean { return /^void\.pendingChatInputBrokerV2\.[0-9a-f]{40}$/.test(key); }
	private async loadGlobalMutation(): Promise<void> {
		if (this.globalMutationLoaded) return this.globalMutationLoaded;
		const loading = (async () => {
			await this.storage.whenReady;
			this.globalMutationLoadError = undefined;
			const raw = this.storage.get(PENDING_CHAT_INPUT_GLOBAL_MUTATION_KEY);
			if (!raw) { this.globalMutation = undefined; this.completedGlobalMutation = undefined; return; }
			let mutation: StoredMutation | undefined;
			let completed: StoredCompletedMutation | undefined;
			try {
				const parsed = JSON.parse(raw) as unknown;
				if (!isPlainObject(parsed) || parsed.version !== 1) throw new Error('invalid');
				mutation = parsed.mutation === undefined ? undefined : reviveStoredMutation(parsed.mutation);
				completed = parsed.completedMutation === undefined ? undefined : reviveCompletedMutation(parsed.completedMutation);
				if ((parsed.mutation !== undefined && !mutation) || (parsed.completedMutation !== undefined && !completed) || (mutation && completed)) throw new Error('invalid');
				this.globalMutation = mutation; this.completedGlobalMutation = completed;
			} catch {
				// A malformed persisted transaction is a durable fail-closed barrier. Do
				// not treat it as "no mutation" and overwrite the only recovery evidence.
				this.globalMutation = undefined; this.completedGlobalMutation = undefined;
				this.globalMutationLoadError = 'Pending-input cleanup is blocked because its shared chat transaction record is invalid.';
				return;
			}
			if (!mutation) return;
			try {
				const status = this.mutationStorageState(mutation);
				if (status !== 'ambiguous') await this.resolveGlobalMutation(status === 'expected');
			} catch {
				// Keep the parsed intent and retry on the next explicit initialize. Any
				// broker mutation remains blocked in the meantime.
				this.globalMutationLoadError = 'Pending-input cleanup is blocked until its shared chat transaction can be recovered.';
			}
		})();
		this.globalMutationLoaded = loading;
		await loading;
		if (this.globalMutationLoadError && this.globalMutationLoaded === loading) this.globalMutationLoaded = undefined;
	}
	private async persistGlobalIntent(mutation: StoredMutation): Promise<void> {
		const previous = this.storage.get(PENDING_CHAT_INPUT_GLOBAL_MUTATION_KEY);
		try { this.storage.store(PENDING_CHAT_INPUT_GLOBAL_MUTATION_KEY, JSON.stringify({ version: 1, mutation } satisfies StoredGlobalMutationEnvelope)); await this.storage.flush(); }
		catch (error) { if (previous === undefined) this.storage.remove(PENDING_CHAT_INPUT_GLOBAL_MUTATION_KEY); else this.storage.store(PENDING_CHAT_INPUT_GLOBAL_MUTATION_KEY, previous); try { await this.storage.flush(); } catch { /* preserve original */ } throw error; }
		this.globalMutation = mutation; this.completedGlobalMutation = undefined;
		this.globalMutationLoadError = undefined;
	}
	private async resolveGlobalMutation(committed: boolean): Promise<void> {
		const mutation = this.globalMutation;
		if (!mutation) return;
		const updates: { key: string; value: string; namespace: PendingChatInputNamespace; revision: number; records: PendingChatInput[] }[] = [];
		if (committed) {
			for (const key of this.storage.keys('machine').filter(candidate => this.isBrokerEnvelopeKey(candidate))) {
				const raw = this.storage.get(key); if (!raw) continue;
				try {
					const parsed = JSON.parse(raw) as unknown;
					if (!isPlainObject(parsed) || parsed.version !== 2 || !validNamespace(parsed.namespace) || !Number.isSafeInteger(parsed.revision) || !Array.isArray(parsed.records)) continue;
					const records = this.parseRecords(parsed.records, false).records;
					const next = mutation.kind === 'namespace-clear' ? [] : records.filter(record => record.threadId !== mutation.threadId);
					if (next.length === records.length) continue;
					const revision = parsed.revision as number; if (revision >= Number.MAX_SAFE_INTEGER) throw new Error('revision_overflow');
					const value = JSON.stringify({ version: 2, namespace: parsed.namespace, revision: revision + 1, records: next.map(record => ({ ...record, selections: record.selections.map(cloneSelection) })) } satisfies StoredEnvelope);
					updates.push({ key, value, namespace: parsed.namespace, revision: revision + 1, records: next });
				} catch (error) { if (error instanceof Error && error.message === 'revision_overflow') throw error; }
			}
		}
		const completed = committed ? Object.freeze({ ...mutation, outcome: 'committed' as const }) : undefined;
		const globalValue = JSON.stringify({ version: 1, ...(completed ? { completedMutation: completed } : {}) } satisfies StoredGlobalMutationEnvelope);
		const writes = [...updates.map(update => ({ key: update.key, value: update.value })), { key: PENDING_CHAT_INPUT_GLOBAL_MUTATION_KEY, value: globalValue }];
		const previous = new Map(writes.map(write => [write.key, this.storage.get(write.key)]));
		try { if (this.storage.storeAll) this.storage.storeAll(writes); else for (const write of writes) this.storage.store(write.key, write.value); await this.storage.flush(); }
		catch (error) { for (const [key, value] of previous) { if (value === undefined) this.storage.remove(key); else this.storage.store(key, value); } try { await this.storage.flush(); } catch { /* preserve original */ } throw error; }
		this.globalMutation = undefined; this.completedGlobalMutation = completed;
		this.globalMutationLoadError = undefined;
		for (const update of updates) {
			const loaded = this.states.get(namespaceKey(update.namespace)); if (!loaded?.loaded) continue;
			const removed = loaded.records.filter(record => !update.records.some(next => next.threadId === record.threadId && next.id === record.id));
			loaded.records = update.records.map(freezeRecord); loaded.revision = update.revision;
			for (const record of removed) { const key = this.ownerKey(loaded, record.threadId, record.id); this.claimOwners.delete(key); this.recordOwners.delete(key); }
			this._onDidChange.fire(this.snapshot(loaded));
		}
		this.namespaceMutationOwners.clear(); this.threadMutationOwners.clear();
		this.storage.remove(pendingChatInputMutationReceiptKey(mutation.leaseId)); try { await this.storage.flush(); } catch { /* completion receipt already durable */ }
	}
	private async loadState(namespace: PendingChatInputNamespace): Promise<NamespaceState> {
		await this.loadGlobalMutation();
		const key = namespaceKey(namespace);
		const existing = this.states.get(key);
		if (existing?.loaded) return existing;
		const state = existing ?? { namespace: Object.freeze({ ...namespace }), revision: 0, records: [], tail: Promise.resolve(), loaded: false, hadStoredEnvelope: false, initialProjectionCompacted: false };
		this.states.set(key, state);
		await this.storage.whenReady;
		const raw = this.storage.get(storageKey(namespace));
		state.hadStoredEnvelope = raw !== undefined;
		if (raw) {
			let normalizePersistedState = false;
			try {
				if (raw.length > PENDING_CHAT_INPUT_RAW_RESTORE_MAX_BYTES || new TextEncoder().encode(raw).byteLength > PENDING_CHAT_INPUT_RAW_RESTORE_MAX_BYTES) throw new Error('oversized');
				const parsed = JSON.parse(raw) as unknown;
				if (!isPlainObject(parsed) || parsed.version !== 2 || !validNamespace(parsed.namespace) || namespaceKey(parsed.namespace) !== namespaceKey(namespace) || !Number.isSafeInteger(parsed.revision) || (parsed.revision as number) < 0 || !Array.isArray(parsed.records)) throw new Error('invalid');
				// No renderer session survives an Electron-main restart. Every retained
				// row therefore becomes an explicit dormant draft and cannot auto-send.
				const normalized = this.parseRecords(parsed.records, true);
				state.revision = parsed.revision as number; state.records = normalized.records;
				if (normalized.omitted) state.loadWarning = 'Some pending inputs were discarded because stored broker data was invalid or over its limit.';
				const normalizedBytes = JSON.stringify(state.records.map(record => ({ ...record, selections: record.selections.map(cloneSelection) })));
				normalizePersistedState = normalized.omitted || JSON.stringify(parsed.records) !== normalizedBytes;
			} catch { state.revision = 0; state.records = []; state.loadWarning = 'Pending inputs were discarded because stored broker data was invalid.'; normalizePersistedState = true; }
			if (normalizePersistedState && !this.globalMutation && !this.globalMutationLoadError) await this.persist(state, state.records);
		}
		state.loaded = true;
		return state;
	}

	async initializeNamespace(ctx: string, request: PendingChatInputBrokerInitializeRequest): Promise<PendingChatInputInitializeResult> {
		if (!isNonemptyString(ctx) || !isPlainObject(request) || !validNamespace(request.namespace)
			|| !Array.isArray(request.knownThreadIds) || request.knownThreadIds.some(threadId => !isNonemptyString(threadId))
			|| !isPlainObject(request.deliveredPendingInputIds) || Object.entries(request.deliveredPendingInputIds).some(([threadId, ids]) => !isNonemptyString(threadId) || !Array.isArray(ids) || ids.some(id => !isNonemptyString(id)))
			|| (request.legacyRaw !== undefined && typeof request.legacyRaw !== 'string')) return this.failed('invalid_request');
		let release!: () => void; const previous = this.migrationTail; this.migrationTail = new Promise<void>(resolve => release = resolve);
		await previous;
		try {
			const state = await this.loadState(request.namespace);
			return await this.enqueue(state, async () => {
				const existingSessionId = this.sessionOfContext.get(ctx);
				const existingSession = existingSessionId ? this.sessions.get(existingSessionId) : undefined;
				if (existingSession && existingSession.namespaceKey !== namespaceKey(request.namespace)) return this.failed('invalid_request', state);
				if (existingSession) existingSession.lastHeartbeat = this.now();
				let removeLegacy = false; let warning: string | undefined = state.loadWarning;
				const sharedMutationBlocked = !!this.globalMutation || !!this.globalMutationLoadError;
				if (sharedMutationBlocked) {
					warning = this.globalMutationLoadError ?? 'Pending-input cleanup is paused because shared chat storage only partially matches the prepared operation.';
					// Recovery must be able to reconnect, but an unresolved application-wide
					// transaction may not compact, migrate, or otherwise rewrite inbox rows.
					const sessionId = existingSession?.id ?? this.uuid();
					if (!isNonemptyString(sessionId) || (!existingSession && this.sessions.has(sessionId))) return this.failed('backend_unavailable', state);
					const session: SessionState = existingSession ?? { id: sessionId, ctx, namespaceKey: namespaceKey(request.namespace), lastHeartbeat: this.now() };
					this.sessions.set(sessionId, session); this.sessionOfContext.set(ctx, sessionId);
					const recovery = this.globalMutation ? Object.freeze({ kind: this.globalMutation.kind, leaseId: this.globalMutation.leaseId, ...(this.globalMutation.kind === 'thread-delete' ? { threadId: this.globalMutation.threadId } : {}) }) : undefined;
					return Object.freeze({ ok: true, snapshot: this.snapshot(state), value: Object.freeze({ sessionId, removeLegacy: false, warning, ...(recovery ? { recovery } : {}) }) });
				}
				await this.reconcileOrphanThreadAnchors();
				const knownThreads = new Set(request.knownThreadIds);
				const delivered = new Map(Object.entries(request.deliveredPendingInputIds).map(([threadId, ids]) => [threadId, new Set(ids)]));
				// Only the first renderer projection after an Electron-main cold load may
				// prune durable v2 rows. A later window/reconnect can have a stale chat map
				// and must not delete another live window's newly-created thread.
				const compacted = state.initialProjectionCompacted ? { records: state.records, omitted: false } : this.parseRecords(state.records, false, knownThreads, delivered, false);
				const compactedChanged = !state.initialProjectionCompacted && (compacted.omitted || canonicalValue(state.records) !== canonicalValue(compacted.records));
				if (compacted.omitted) warning = 'Some pending inputs were discarded because their chat history was unavailable, already delivered, invalid, or over its limit.';
				const marker = migrationKey(request.namespace);
				const markerValue = this.storage.get(marker);
				if (markerValue !== request.namespace.workspaceIdentity) {
					const imported = state.hadStoredEnvelope ? { records: compacted.records, ...(compacted.omitted ? { warning } : {}) } : this.parseLegacy(request.legacyRaw, request.knownThreadIds, request.deliveredPendingInputIds);
					warning = imported.warning ?? warning;
					const previousEnvelope = this.storage.get(storageKey(request.namespace)); const previousMarker = this.storage.get(marker);
					const revision = state.revision >= Number.MAX_SAFE_INTEGER ? state.revision : state.revision + 1;
					if (revision >= Number.MAX_SAFE_INTEGER && state.revision >= Number.MAX_SAFE_INTEGER) return this.failed('backend_unavailable', state);
					const envelope = JSON.stringify({ version: 2, namespace: request.namespace, revision, records: imported.records });
					try {
						if (this.storage.storeAll) this.storage.storeAll([{ key: storageKey(request.namespace), value: envelope }, { key: marker, value: request.namespace.workspaceIdentity }]);
						else { this.storage.store(storageKey(request.namespace), envelope); this.storage.store(marker, request.namespace.workspaceIdentity); }
						await this.storage.flush();
					} catch {
						if (previousEnvelope === undefined) this.storage.remove(storageKey(request.namespace)); else this.storage.store(storageKey(request.namespace), previousEnvelope);
						if (previousMarker === undefined) this.storage.remove(marker); else this.storage.store(marker, previousMarker);
						try { await this.storage.flush(); } catch { /* preserve original failure */ }
						return this.failed('backend_unavailable', state);
					}
					state.revision = revision; state.records = [...imported.records].map(freezeRecord); state.hadStoredEnvelope = true; removeLegacy = request.legacyRaw !== undefined;
				}
				else {
					removeLegacy = request.legacyRaw !== undefined;
					if (compactedChanged) await this.persist(state, compacted.records);
				}
				state.initialProjectionCompacted = true;
				const sessionId = existingSession?.id ?? this.uuid();
				if (!isNonemptyString(sessionId) || (!existingSession && this.sessions.has(sessionId))) return this.failed('backend_unavailable', state);
				const session: SessionState = existingSession ?? { id: sessionId, ctx, namespaceKey: namespaceKey(request.namespace), lastHeartbeat: this.now() };
				this.sessions.set(sessionId, session); this.sessionOfContext.set(ctx, sessionId);
				const recovery = this.globalMutation ? Object.freeze({ kind: this.globalMutation.kind, leaseId: this.globalMutation.leaseId, ...(this.globalMutation.kind === 'thread-delete' ? { threadId: this.globalMutation.threadId } : {}) }) : undefined;
				return Object.freeze({ ok: true, snapshot: this.snapshot(state), value: Object.freeze({ sessionId, removeLegacy, ...(warning ? { warning } : {}), ...(recovery ? { recovery } : {}) }) });
			});
		} catch { return this.failed('backend_unavailable'); }
		finally { release(); }
	}

	private authorityMatches(record: PendingChatInput, authority: PendingChatInputAuthority): boolean { return authority.threadExists && record.ownerProjectRoot === authority.ownerProjectRoot && record.trustedAtSubmit === authority.workspaceTrusted && record.generation === authority.generation; }
	private deliveredSet(values: readonly string[]): ReadonlySet<string> { return new Set(Array.isArray(values) ? values.filter(isNonemptyString) : []); }
	private async mutate<T>(ctx: string, sessionId: string, fn: (state: NamespaceState, session: SessionState) => Promise<PendingChatInputMutationResult<T>>): Promise<PendingChatInputMutationResult<T>> {
		const found = this.session(ctx, sessionId); if (!found) return this.failed('not_initialized');
		return this.enqueue(found.state, async () => { const current = this.session(ctx, sessionId); if (!current || current.state !== found.state) return this.failed('not_initialized', found.state); try { return await fn(found.state, found.session); } catch { return this.failed('backend_unavailable', found.state); } });
	}
	private ownerKey(state: NamespaceState, threadId: string, id: string): string { return `${namespaceKey(state.namespace)}\u0000${recordKey(threadId, id)}`; }
	private threadMutationKey(state: NamespaceState, threadId: string): string { return `${namespaceKey(state.namespace)}\u0000${threadId}`; }
	private runGenerationKey(state: NamespaceState, threadId: string): string { return this.threadMutationKey(state, threadId); }
	private activeMutationOwner(map: Map<string, MutationOwner>, key: string): MutationOwner | undefined {
		const owner = map.get(key);
		if (owner && owner.expiresAt <= this.now()) { map.delete(key); return undefined; }
		return owner;
	}
	private mutationBlocked(state: NamespaceState, threadId?: string): boolean {
		if (this.globalMutationLoadError) return true;
		if (this.globalMutation && (this.globalMutation.kind === 'namespace-clear' || threadId === undefined || this.globalMutation.threadId === threadId)) return true;
		if (this.activeMutationOwner(this.namespaceMutationOwners, namespaceKey(state.namespace))) return true;
		return threadId !== undefined && !!this.activeMutationOwner(this.threadMutationOwners, this.threadMutationKey(state, threadId));
	}
	private newMutationOwner(sessionId: string): MutationOwner | undefined {
		const leaseId = this.uuid();
		return isNonemptyString(leaseId) ? { sessionId, leaseId, expiresAt: this.now() + PENDING_CHAT_INPUT_APPEND_LEASE_TIMEOUT_MS } : undefined;
	}
	private activeHistoryOwner(threadId: string): HistoryRunOwner | undefined {
		const owner = this.historyRunOwners.get(threadId);
		if (owner && owner.kind !== 'child' && !owner.childGroup && owner.expiresAt <= this.now()) { this.historyRunOwners.delete(threadId); return undefined; }
		return owner;
	}
	private historyRunOwner(session: SessionState, threadId: string, runId: string, generation: number): HistoryRunOwner | undefined {
		if (!isNonemptyString(runId) || !Number.isSafeInteger(generation) || generation < 0) return undefined;
		const current = this.activeHistoryOwner(threadId);
		if (current) return current.kind === 'run' && current.sessionId === session.id && current.runId === runId && current.generation === generation ? current : undefined;
		const owner: HistoryRunOwner = { kind: 'run', sessionId: session.id, namespaceKey: session.namespaceKey, threadId, runId, generation, expiresAt: this.now() + PENDING_CHAT_INPUT_APPEND_LEASE_TIMEOUT_MS };
		this.historyRunOwners.set(threadId, owner);
		return owner;
	}
	private clearExactHistoryWrite(threadId: string, sessionId: string, leaseId: string): boolean {
		const owner = this.historyRunOwners.get(threadId);
		if (!owner || owner.sessionId !== sessionId || owner.write?.leaseId !== leaseId) return false;
		owner.write = undefined;
		if (owner.kind === 'anchor') this.historyRunOwners.delete(threadId);
		return true;
	}
	private hasAnyHistoryOwner(threadId?: string): boolean {
		for (const [candidate, owner] of this.historyRunOwners) {
			if (owner.kind !== 'child' && !owner.childGroup && owner.expiresAt <= this.now()) { this.historyRunOwners.delete(candidate); continue; }
			if (threadId === undefined || candidate === threadId) return true;
		}
		return false;
	}
	private hasAnyClaimOwner(threadId?: string): boolean {
		for (const owner of this.claimOwners.values()) if (threadId === undefined || owner.threadId === threadId) return true;
		return false;
	}
	private fireChildGroupChanges(threadIds: ReadonlySet<string>): void {
		for (const threadId of threadIds) this._onDidChangeChildGroup.fire(Object.freeze({ threadId }));
	}
	private activeChildGroupForNamespace(state: NamespaceState, threadId: string): ActiveChildGroup | undefined {
		const owner = this.activeHistoryOwner(threadId);
		if (!owner || owner.namespaceKey !== namespaceKey(state.namespace)) return undefined;
		return owner.kind === 'child'
			? owner.generation !== undefined && owner.childGroup ? owner.childGroup : undefined
			: owner.kind === 'run' ? owner.childGroup : undefined;
	}
	private activeChildGroupForThread(threadId: string): ActiveChildGroup | undefined {
		const owner = this.activeHistoryOwner(threadId);
		return owner?.kind === 'child' ? owner.childGroup : owner?.kind === 'run' ? owner.childGroup : undefined;
	}
	private hasAnyActiveChildGroup(threadId?: string): boolean {
		for (const [candidate, owner] of this.historyRunOwners) if ((threadId === undefined || candidate === threadId) && (owner.kind === 'child' || owner.kind === 'run' && !!owner.childGroup)) return true;
		return false;
	}
	private renewOperationLeases(state: NamespaceState, sessionId: string): void {
		const now = this.now(); const deadline = now + PENDING_CHAT_INPUT_APPEND_LEASE_TIMEOUT_MS;
		for (const [key, owner] of this.claimOwners) {
			if (owner.sessionId === sessionId && owner.leaseId && owner.leaseExpiresAt !== undefined && owner.leaseExpiresAt > now && key.startsWith(`${namespaceKey(state.namespace)}\u0000`)) owner.leaseExpiresAt = deadline;
		}
		const namespaceOwner = this.namespaceMutationOwners.get('global');
		if (namespaceOwner?.sessionId === sessionId && namespaceOwner.expiresAt > now) namespaceOwner.expiresAt = deadline;
		for (const owner of this.threadMutationOwners.values()) if (owner.sessionId === sessionId && owner.expiresAt > now) owner.expiresAt = deadline;
		for (const owner of this.historyRunOwners.values()) if (owner.sessionId === sessionId && owner.expiresAt > now) owner.expiresAt = now + (owner.kind === 'child' || owner.childGroup ? PENDING_CHAT_INPUT_SESSION_TIMEOUT_MS : PENDING_CHAT_INPUT_APPEND_LEASE_TIMEOUT_MS);
	}
	private currentRecord(state: NamespaceState, threadId: string, id: string, fingerprint?: string): PendingChatInput | undefined { const record = state.records.find(candidate => candidate.threadId === threadId && candidate.id === id); return record && (fingerprint === undefined || pendingChatInputFingerprint(record) === fingerprint) ? record : undefined; }

	heartbeat(ctx: string, sessionId: string): Promise<PendingChatInputMutationResult> { return this.mutate(ctx, sessionId, async (state, session) => { session.lastHeartbeat = this.now(); this.renewOperationLeases(state, session.id); return Object.freeze({ ok: true, snapshot: this.snapshot(state), value: undefined }); }); }
	syncActiveChildGroup(ctx: string, sessionId: string, threadId: string, sourceRunId: string, sourceGeneration: number, sourceRevision: number, generation: number | undefined, childIds: readonly string[]): Promise<PendingChatInputMutationResult> {
		return this.mutate(ctx, sessionId, async (state, session) => {
			if (!isNonemptyString(threadId) || threadId.length > 512 || !isNonemptyString(sourceRunId) || sourceRunId.length > 512 || !Number.isSafeInteger(sourceGeneration) || sourceGeneration < 0 || !Number.isSafeInteger(sourceRevision) || sourceRevision < 0 || !Array.isArray(childIds) || childIds.length > 256
				|| childIds.some((id, index) => !isNonemptyString(id) || id.length > 256 || (index > 0 && childIds[index - 1]!.localeCompare(id) >= 0))
				|| (childIds.length ? !Number.isSafeInteger(generation) || generation! < 0 || generation! >= Number.MAX_SAFE_INTEGER : generation !== undefined)) return this.failed('invalid_request', state);
			if (this.mutationBlocked(state, threadId)) return this.failed('conflict', state);
			const owner = this.activeHistoryOwner(threadId);
			if (!owner) {
				// Electron-main restart intentionally loses volatile run ownership. The
				// renderer that still owns the physical child executions republishes the
				// complete set before any drain. Empty replay is harmless/idempotent; a
				// nonempty set reinstalls the same session-bound exclusion owner.
				if (!childIds.length) return Object.freeze({ ok: true, snapshot: this.snapshot(state), value: undefined });
				const group = Object.freeze({ sourceRevision, generation: generation!, childIds: Object.freeze([...childIds]) });
				this.historyRunOwners.set(threadId, { kind: 'child', sessionId: session.id, namespaceKey: namespaceKey(state.namespace), threadId, sourceRunId, sourceGeneration, childSourceRevision: sourceRevision, childGroup: group, generation: group.generation, expiresAt: this.now() + PENDING_CHAT_INPUT_SESSION_TIMEOUT_MS });
				this._onDidChangeChildGroup.fire(Object.freeze({ threadId }));
				return Object.freeze({ ok: true, snapshot: this.snapshot(state), value: undefined });
			}
			if (owner.sessionId !== session.id || owner.namespaceKey !== namespaceKey(state.namespace)) return this.failed('conflict', state);
			const sourceMatches = owner.kind === 'run'
				? owner.runId === sourceRunId && owner.generation === sourceGeneration
				: owner.kind === 'child' && owner.sourceRunId === sourceRunId && owner.sourceGeneration === sourceGeneration;
			if (!sourceMatches || owner.kind === 'anchor') return this.failed('conflict', state);
			const cursor = owner.kind === 'run' ? owner.childSourceRevision : owner.childGroup?.sourceRevision;
			if (cursor !== undefined && sourceRevision < cursor) return this.failed('conflict', state);
			const exactCurrent = childIds.length
				? !!owner.childGroup && owner.childGroup.sourceRevision === sourceRevision && owner.childGroup.generation === generation && owner.childGroup.childIds.length === childIds.length && owner.childGroup.childIds.every((id, index) => id === childIds[index])
				: !owner.childGroup && cursor === sourceRevision;
			if (cursor === sourceRevision) return exactCurrent ? Object.freeze({ ok: true, snapshot: this.snapshot(state), value: undefined }) : this.failed('conflict', state);
			if (childIds.length) {
				owner.childSourceRevision = sourceRevision;
				owner.childGroup = Object.freeze({ sourceRevision, generation: generation!, childIds: Object.freeze([...childIds]) });
				owner.expiresAt = this.now() + PENDING_CHAT_INPUT_SESSION_TIMEOUT_MS;
				this._onDidChangeChildGroup.fire(Object.freeze({ threadId }));
				return Object.freeze({ ok: true, snapshot: this.snapshot(state), value: undefined });
			}
			const releasesChildOwner = owner.kind === 'child';
			owner.childSourceRevision = sourceRevision;
			owner.childGroup = undefined;
			if (releasesChildOwner) {
				// The empty acknowledgement is the physical child-execution release
				// boundary. Publish one ordered broker revision before reopening FIFO.
				const snapshot = await this.persist(state, state.records);
				this.historyRunOwners.delete(threadId);
				this._onDidChangeChildGroup.fire(Object.freeze({ threadId }));
				return Object.freeze({ ok: true, snapshot, value: undefined });
			}
			owner.expiresAt = this.now() + PENDING_CHAT_INPUT_APPEND_LEASE_TIMEOUT_MS;
			this._onDidChangeChildGroup.fire(Object.freeze({ threadId }));
			return Object.freeze({ ok: true, snapshot: this.snapshot(state), value: undefined });
		});
	}
	submit(ctx: string, request: PendingChatInputBrokerSubmitRequest): Promise<PendingChatInputMutationResult<PendingChatInput>> {
		return this.mutate(ctx, request?.sessionId, async (state, session) => {
			if (!isPlainObject(request) || !isNonemptyString(request.threadId) || typeof request.text !== 'string' || !request.text.trim() || !Array.isArray(request.selections) || request.selections.some(selection => !revivePendingChatSelection(selection)) || !isPendingInputMode(request.mode) || (request.phase !== 'queued' && request.phase !== 'steering') || (request.ownerProjectRoot !== undefined && typeof request.ownerProjectRoot !== 'string') || typeof request.trustedAtSubmit !== 'boolean' || !Number.isSafeInteger(request.generation) || request.generation < 0 || (request.runId !== undefined && typeof request.runId !== 'string') || (request.targetRunId !== undefined && typeof request.targetRunId !== 'string') || (request.targetGeneration !== undefined && (!Number.isSafeInteger(request.targetGeneration) || request.targetGeneration < 0)) || (request.targetChildGeneration !== undefined && (!Number.isSafeInteger(request.targetChildGeneration) || request.targetChildGeneration < 0)) || (request.targetChildIds !== undefined && !Array.isArray(request.targetChildIds))) return this.failed('invalid_request', state);
			if (this.mutationBlocked(state, request.threadId)) return this.failed('conflict', state);
			await this.storage.flush();
			if (!this.hasAuthoritativeThreadAnchor(request.threadId)) return this.failed('conflict', state);
			const anchorOwner = this.activeHistoryOwner(request.threadId);
			// Queue admission does not write chat history and may occur while another
			// window owns the live parent run. Only a still-materializing blank anchor is
			// session-exclusive; claim/delivery remains blocked by the run owner.
			if (anchorOwner?.write?.kind === 'anchor' && (anchorOwner.sessionId !== session.id || this.anchorLeaseOfThreadEnvelope(request.threadId) !== anchorOwner.write.leaseId)) return this.failed('append_in_progress', state);
			let sameThread = state.records.filter(record => record.threadId === request.threadId).sort(comparePendingChatInputs); let maxOrder = sameThread.reduce((max, record) => Math.max(max, record.order), -1); let records = state.records;
			if (maxOrder >= Number.MAX_SAFE_INTEGER) {
				if (sameThread.some(record => record.phase === 'claiming' || !this.sessionOwnsActiveRecord(state, session.id, record))) return this.failed('conflict', state);
				const rebased = new Map(sameThread.map((record, order) => [record.id, freezeRecord({ ...record, order })])); records = state.records.map(record => record.threadId === request.threadId ? rebased.get(record.id)! : record); maxOrder = sameThread.length - 1;
			}
			const requestedChildIds = Array.isArray(request.targetChildIds) ? request.targetChildIds : undefined;
			const requestedChildIdsValid = !!requestedChildIds && requestedChildIds.length > 0 && requestedChildIds.length <= 256 && requestedChildIds.every((id, index) => isNonemptyString(id) && id.length <= 256 && (index === 0 || requestedChildIds[index - 1]!.localeCompare(id) < 0));
			const requestedTargetIsAbsent = request.targetRunId === undefined && request.targetGeneration === undefined && request.targetChildGeneration === undefined && request.targetChildIds === undefined;
			const requestedParentTargetIsValid = isNonemptyString(request.targetRunId) && Number.isSafeInteger(request.targetGeneration) && request.targetGeneration! >= 0 && request.targetGeneration! < Number.MAX_SAFE_INTEGER && request.generation === request.targetGeneration! + 1 && request.targetChildGeneration === undefined && request.targetChildIds === undefined;
			const requestedChildTargetIsValid = request.targetRunId === undefined && request.targetGeneration === undefined && Number.isSafeInteger(request.targetChildGeneration) && request.targetChildGeneration! >= 0 && request.targetChildGeneration! < Number.MAX_SAFE_INTEGER && requestedChildIdsValid && request.generation === request.targetChildGeneration! + 1;
			const requestedTargetIsValid = requestedParentTargetIsValid || requestedChildTargetIsValid;
			const tupleIsValid = request.phase === 'steering'
				? request.mode === 'steer' && isNonemptyString(request.runId) && requestedTargetIsAbsent
				: request.mode !== 'steer' && request.runId === undefined && (request.mode === 'stop_and_send' ? requestedTargetIsAbsent || requestedTargetIsValid : requestedTargetIsAbsent);
			if (!tupleIsValid) return this.failed('invalid_request', state);
			let targetRunId = requestedParentTargetIsValid ? request.targetRunId : undefined;
			let targetGeneration = requestedParentTargetIsValid ? request.targetGeneration : undefined;
			let targetChildGeneration = requestedChildTargetIsValid ? request.targetChildGeneration : undefined;
			let targetChildIds: readonly string[] | undefined = requestedChildTargetIsValid ? requestedChildIds : undefined;
			const childHistoryOwner = this.activeHistoryOwner(request.threadId);
			const namespaceChildGroup = this.activeChildGroupForNamespace(state, request.threadId);
			const globalChildGroup = this.activeChildGroupForThread(request.threadId);
			let staleChildTarget = false;
			if (requestedChildTargetIsValid) {
				const exactOwnedGroup = childHistoryOwner?.sessionId === session.id && !!namespaceChildGroup
					&& namespaceChildGroup.generation === request.targetChildGeneration
					&& namespaceChildGroup.childIds.length === requestedChildIds!.length
					&& namespaceChildGroup.childIds.every((id, index) => id === requestedChildIds![index]);
				if (!exactOwnedGroup) { targetChildGeneration = undefined; targetChildIds = undefined; staleChildTarget = true; }
			}
			// A renderer in another window may know that the task is running without
			// owning its local quiescence object. Bind Stop-and-Send to the exact main
			// owner at admission; never infer a target from a later snapshot.
			if (request.mode === 'stop_and_send' && request.phase === 'queued' && !targetRunId && !targetChildIds) {
				const owner = this.activeHistoryOwner(request.threadId);
				if (owner?.kind === 'run' && owner.runId && Number.isSafeInteger(owner.generation) && owner.generation! >= 0 && owner.generation! < Number.MAX_SAFE_INTEGER) { targetRunId = owner.runId; targetGeneration = owner.generation; }
				else if (!staleChildTarget && namespaceChildGroup) { targetChildGeneration = namespaceChildGroup.generation; targetChildIds = namespaceChildGroup.childIds; }
				else if (!staleChildTarget && globalChildGroup) return this.failed('append_in_progress', state);
			}
			const recordGeneration = targetRunId ? targetGeneration! + 1 : targetChildGeneration !== undefined ? targetChildGeneration + 1 : staleChildTarget && namespaceChildGroup ? namespaceChildGroup.generation : request.generation;
			// A close operation is main-authoritative. If a renderer submitted with a
			// stale run snapshot after close linearized but before its ACK resumed, keep
			// the user input by atomically converting it to an ordinary FIFO row.
			const staleSteer = request.phase === 'steering' && request.generation <= (this.closedRunGenerationOfThread.get(this.runGenerationKey(state, request.threadId)) ?? -1);
			const mode: PendingInputMode = staleSteer ? 'queue' : request.mode;
			const phase: 'queued' | 'steering' = staleSteer ? 'queued' : request.phase;
			const id = this.uuid();
			if (!isNonemptyString(id) || state.records.some(candidate => candidate.threadId === request.threadId && candidate.id === id)) return this.failed('backend_unavailable', state);
			const record = freezeRecord({ id, threadId: request.threadId, text: request.text, draft: request.text, selections: request.selections.map(selection => revivePendingChatSelection(selection)!), mode, order: maxOrder + 1, createdAt: this.now(), ownerProjectRoot: request.ownerProjectRoot, trustedAtSubmit: request.trustedAtSubmit, generation: recordGeneration, ...(!staleSteer && request.runId ? { runId: request.runId } : {}), ...(targetRunId ? { targetRunId, targetGeneration } : {}), ...(targetChildIds ? { targetChildGeneration, targetChildIds } : {}), phase });
			const next = [...records, record]; if (!pendingChatInputsFit(next)) return this.failed('full', state);
			const snapshot = await this.persist(state, next); this.recordOwners.set(this.ownerKey(state, record.threadId, record.id), request.sessionId);
			if (anchorOwner?.write?.kind === 'anchor') {
				// Keep the marker until the first exact history CAS removes it.  Clearing
				// it here would create a new main-storage revision which the admitting
				// renderer has not observed yet, making its first user-history CAS stale.
				// If the renderer exits first, the durable broker row makes the marked
				// blank anchor intentional; cold orphan reconciliation strips it safely.
				this.historyRunOwners.delete(request.threadId);
			}
			return Object.freeze({ ok: true, snapshot, value: record });
		});
	}
	private sessionOwnsActiveRecord(state: NamespaceState, sessionId: string, record: PendingChatInput): boolean { return record.phase === 'dormant' || this.recordOwners.get(this.ownerKey(state, record.threadId, record.id)) === sessionId; }
	edit(ctx: string, sessionId: string, threadId: string, id: string, fingerprint: string, text: string, selections?: readonly StagingSelectionItem[]): Promise<PendingChatInputMutationResult> { return this.mutate(ctx, sessionId, async (state, session) => { if (this.mutationBlocked(state, threadId)) return this.failed('conflict', state); const record = this.currentRecord(state, threadId, id, fingerprint); if (!record || record.phase === 'claiming' || !this.sessionOwnsActiveRecord(state, session.id, record)) return this.failed('conflict', state); if (typeof text !== 'string' || !text.trim() || (selections !== undefined && (!Array.isArray(selections) || selections.some(selection => !revivePendingChatSelection(selection))))) return this.failed('invalid_request', state); const replacement = freezeRecord({ ...record, text, draft: text, ...(selections ? { selections: selections.map(selection => revivePendingChatSelection(selection)!) } : {}) }); const next = state.records.map(candidate => candidate === record ? replacement : candidate); if (!pendingChatInputsFit(next)) return this.failed('full', state); return Object.freeze({ ok: true, snapshot: await this.persist(state, next), value: undefined }); }); }
	delete(ctx: string, sessionId: string, threadId: string, id: string, fingerprint: string): Promise<PendingChatInputMutationResult> { return this.mutate(ctx, sessionId, async (state, session) => { if (this.mutationBlocked(state, threadId)) return this.failed('conflict', state); const record = this.currentRecord(state, threadId, id, fingerprint); if (!record || record.phase === 'claiming' || !this.sessionOwnsActiveRecord(state, session.id, record)) return this.failed('conflict', state); const next = state.records.filter(candidate => candidate !== record); const cleanup = !next.some(candidate => candidate.threadId === threadId) ? this.unreferencedEmptyAnchorCleanup(state, record) : undefined; const snapshot = await this.persist(state, next, cleanup); this.recordOwners.delete(this.ownerKey(state, record.threadId, record.id)); return Object.freeze({ ok: true, snapshot, value: undefined }); }); }
	reorder(ctx: string, sessionId: string, threadId: string, id: string, fingerprint: string, threadFingerprint: string, beforeId?: string): Promise<PendingChatInputMutationResult> {
		return this.mutate(ctx, sessionId, async (state, session) => {
			if (this.mutationBlocked(state, threadId)) return this.failed('conflict', state);
			const items = state.records.filter(record => record.threadId === threadId).sort(comparePendingChatInputs);
			if (!isNonemptyString(threadFingerprint) || pendingChatInputThreadFingerprint(items) !== threadFingerprint) return this.failed('conflict', state);
			const index = items.findIndex(record => record.id === id && pendingChatInputFingerprint(record) === fingerprint && record.phase !== 'claiming' && this.sessionOwnsActiveRecord(state, session.id, record));
			if (index < 0 || (beforeId !== undefined && !isNonemptyString(beforeId))) return this.failed('conflict', state);
			// Reordering rebases every same-thread ordinal and therefore changes every
			// fingerprint. Never mutate a claiming row or another live window's row.
			if (items.some(record => record.phase === 'claiming' || !this.sessionOwnsActiveRecord(state, session.id, record))) return this.failed('conflict', state);
			const [item] = items.splice(index, 1);
			const target = beforeId === undefined ? items.length : items.findIndex(record => record.id === beforeId);
			if (target < 0) return this.failed('conflict', state);
			items.splice(target, 0, item);
			const rebased = new Map(items.map((record, order) => [record.id, freezeRecord({ ...record, order })]));
			const next = state.records.map(record => record.threadId === threadId ? rebased.get(record.id)! : record);
			return Object.freeze({ ok: true, snapshot: await this.persist(state, next), value: undefined });
		});
	}
	resume(ctx: string, sessionId: string, threadId: string, id: string, fingerprint: string, authority: PendingChatInputAuthority): Promise<PendingChatInputMutationResult> { return this.mutate(ctx, sessionId, async (state, session) => { if (this.mutationBlocked(state, threadId)) return this.failed('conflict', state); if (!validAuthority(authority)) return this.failed('invalid_request', state); const record = this.currentRecord(state, threadId, id, fingerprint); if (!record || record.phase !== 'dormant') return this.failed('conflict', state); if (!this.authorityMatches(record, authority)) return this.failed('owner_or_trust_changed', state); const next = state.records.map(candidate => candidate === record ? freezeRecord({ ...record, mode: 'queue', phase: 'queued', runId: undefined, claimId: undefined, targetRunId: undefined, targetGeneration: undefined, targetChildGeneration: undefined, targetChildIds: undefined }) : candidate); const snapshot = await this.persist(state, next); this.recordOwners.set(this.ownerKey(state, record.threadId, record.id), session.id); return Object.freeze({ ok: true, snapshot, value: undefined }); }); }
	suspend(ctx: string, sessionId: string, threadId: string, id: string, fingerprint: string): Promise<PendingChatInputMutationResult> { return this.mutate(ctx, sessionId, async (state, session) => { if (this.mutationBlocked(state, threadId)) return this.failed('conflict', state); const record = this.currentRecord(state, threadId, id, fingerprint); if (!record || record.phase === 'dormant' || record.phase === 'claiming' || !this.sessionOwnsActiveRecord(state, session.id, record)) return this.failed('conflict', state); const next = state.records.map(candidate => candidate === record ? freezeRecord({ ...record, phase: 'dormant', runId: undefined, claimId: undefined, targetRunId: undefined, targetGeneration: undefined, targetChildGeneration: undefined, targetChildIds: undefined }) : candidate); const snapshot = await this.persist(state, next); this.recordOwners.delete(this.ownerKey(state, record.threadId, record.id)); return Object.freeze({ ok: true, snapshot, value: undefined }); }); }

	private clearOwnerKeys(keys: ReadonlySet<string>): void {
		for (const key of keys) { this.claimOwners.delete(key); this.recordOwners.delete(key); }
	}
	private deliveredRecords(state: NamespaceState, threadId: string, delivered: ReadonlySet<string>): PendingChatInput[] {
		return state.records.filter(record => record.threadId === threadId && delivered.has(record.id) && !this.claimOwners.get(this.ownerKey(state, record.threadId, record.id))?.leaseId && this.inspectPendingRecordHistory(record).kind === 'exact');
	}
	private async claim(state: NamespaceState, session: SessionState, records: readonly PendingChatInput[], record: PendingChatInput, cleanupKeys: ReadonlySet<string> = new Set()): Promise<PendingChatInputMutationResult<PendingChatInputClaim>> {
		const key = this.ownerKey(state, record.threadId, record.id); if (this.recordOwners.get(key) !== session.id) return this.failed('conflict', state) as PendingChatInputMutationResult<PendingChatInputClaim>;
		const claimId = this.uuid();
		if (!isNonemptyString(claimId)) return this.failed('backend_unavailable', state) as PendingChatInputMutationResult<PendingChatInputClaim>;
		const claimed = freezeRecord({ ...record, phase: 'claiming', claimId });
		const next = records.map(candidate => candidate.threadId === record.threadId && candidate.id === record.id ? claimed : candidate);
		if (!pendingChatInputsFit(next) || pendingChatInputEnvelopeBytes(next) > PENDING_CHAT_INPUT_MAX_SERIALIZED_BYTES) return this.failed('backend_unavailable', state) as PendingChatInputMutationResult<PendingChatInputClaim>;
		const snapshot = await this.persist(state, next);
		this.clearOwnerKeys(cleanupKeys);
		this.recordOwners.set(key, session.id);
		this.claimOwners.set(key, { sessionId: session.id, claimId, threadId: record.threadId });
		return Object.freeze({ ok: true, snapshot, value: Object.freeze({ record: claimed, fingerprint: pendingChatInputFingerprint(claimed) }) });
	}
	claimNextQueued(ctx: string, sessionId: string, threadId: string, authority: PendingChatInputAuthority, deliveredIds: readonly string[]): Promise<PendingChatInputMutationResult<PendingChatInputClaim | undefined>> {
		return this.mutate(ctx, sessionId, async (state, session) => {
			if (!isNonemptyString(threadId) || !validAuthority(authority) || !Array.isArray(deliveredIds) || deliveredIds.some(id => !isNonemptyString(id))) return this.failed('invalid_request', state);
			if (this.mutationBlocked(state, threadId)) return this.failed('conflict', state);
			const delivered = this.deliveredSet(deliveredIds);
			if (delivered.size) await this.storage.flush();
			const removed = this.deliveredRecords(state, threadId, delivered);
			const cleanupKeys = new Set(removed.map(record => this.ownerKey(state, record.threadId, record.id)));
			let next = state.records.filter(record => !removed.includes(record));
			let changed = removed.length > 0;
			// Claiming is itself a delivery decision. Keep FIFO rows queued while any
			// exact parent/approval history owner still protects this thread; otherwise a
			// foreign window would claim and then demote the row on append conflict.
			if (this.activeHistoryOwner(threadId) || this.authoritativePendingApprovalKey(threadId) || this.hasAnyClaimOwner(threadId) || this.hasAnyActiveChildGroup(threadId)) {
				const snapshot = changed ? await this.persist(state, next) : this.snapshot(state);
				if (changed) this.clearOwnerKeys(cleanupKeys);
				return Object.freeze({ ok: true, snapshot, value: undefined });
			}
			const queued = next.filter(record => record.threadId === threadId && record.phase === 'queued').sort(comparePendingChatInputs);
			for (const record of queued) {
				const ownerKey = this.ownerKey(state, record.threadId, record.id);
				const owner = this.recordOwners.get(ownerKey);
				if (owner !== session.id) {
					if (owner && this.sessions.has(owner)) {
						const snapshot = changed ? await this.persist(state, next) : this.snapshot(state);
						if (changed) this.clearOwnerKeys(cleanupKeys);
						return Object.freeze({ ok: true, snapshot, value: undefined });
					}
					cleanupKeys.add(ownerKey);
					next = next.map(candidate => candidate.threadId === record.threadId && candidate.id === record.id ? freezeRecord({ ...record, phase: 'dormant', claimId: undefined, runId: undefined, targetRunId: undefined, targetGeneration: undefined, targetChildGeneration: undefined, targetChildIds: undefined }) : candidate);
					changed = true;
					continue;
				}
				if (!this.authorityMatches(record, authority)) {
					cleanupKeys.add(ownerKey);
					next = next.map(candidate => candidate.threadId === record.threadId && candidate.id === record.id ? freezeRecord({ ...record, phase: 'dormant', claimId: undefined, runId: undefined, targetRunId: undefined, targetGeneration: undefined, targetChildGeneration: undefined, targetChildIds: undefined }) : candidate);
					changed = true;
					continue;
				}
				return this.claim(state, session, next, record, cleanupKeys);
			}
			const snapshot = changed ? await this.persist(state, next) : this.snapshot(state);
			if (changed) this.clearOwnerKeys(cleanupKeys);
			return Object.freeze({ ok: true, snapshot, value: undefined });
		});
	}
	claimSteerAtBoundary(ctx: string, sessionId: string, threadId: string, runId: string, generation: number, authority: PendingChatInputAuthority, deliveredIds: readonly string[]): Promise<PendingChatInputMutationResult<PendingChatInputClaim | undefined>> {
		return this.mutate(ctx, sessionId, async (state, session) => {
			if (!isNonemptyString(threadId) || !isNonemptyString(runId) || !Number.isSafeInteger(generation) || generation < 0 || !validAuthority(authority) || authority.generation !== generation || !Array.isArray(deliveredIds) || deliveredIds.some(id => !isNonemptyString(id))) return this.failed('invalid_request', state);
			if (this.mutationBlocked(state, threadId)) return this.failed('conflict', state);
			if (this.hasAnyClaimOwner(threadId) || this.hasAnyActiveChildGroup(threadId)) return Object.freeze({ ok: true, snapshot: this.snapshot(state), value: undefined });
			const delivered = this.deliveredSet(deliveredIds);
			if (delivered.size) await this.storage.flush();
			const removed = this.deliveredRecords(state, threadId, delivered);
			const cleanupKeys = new Set(removed.map(record => this.ownerKey(state, record.threadId, record.id)));
			let next = state.records.filter(record => !removed.includes(record));
			let changed = removed.length > 0;
			const candidates = next.filter(record => record.threadId === threadId && record.phase === 'steering' && record.runId === runId && record.generation === generation).sort(comparePendingChatInputs);
			let eligible: PendingChatInput | undefined;
			for (const record of candidates) {
				const ownerKey = this.ownerKey(state, record.threadId, record.id);
				const owner = this.recordOwners.get(ownerKey);
				if (owner !== session.id) {
					if (owner && this.sessions.has(owner)) continue;
					cleanupKeys.add(ownerKey);
					next = next.map(candidate => candidate.threadId === record.threadId && candidate.id === record.id ? freezeRecord({ ...record, phase: 'dormant', claimId: undefined, runId: undefined, targetRunId: undefined, targetGeneration: undefined, targetChildGeneration: undefined, targetChildIds: undefined }) : candidate);
					changed = true;
					continue;
				}
				if (!this.authorityMatches(record, authority)) {
					cleanupKeys.add(ownerKey);
					next = next.map(candidate => candidate.threadId === record.threadId && candidate.id === record.id ? freezeRecord({ ...record, phase: 'dormant', claimId: undefined, runId: undefined, targetRunId: undefined, targetGeneration: undefined, targetChildGeneration: undefined, targetChildIds: undefined }) : candidate);
					changed = true;
					continue;
				}
				if (record.selections.length || record.text.includes('$')) {
					next = next.map(candidate => candidate.threadId === record.threadId && candidate.id === record.id ? freezeRecord({ ...record, mode: 'queue', phase: 'queued', runId: undefined, claimId: undefined }) : candidate);
					changed = true;
					continue;
				}
				if (!eligible) eligible = record;
			}
			if (eligible) return this.claim(state, session, next, eligible, cleanupKeys);
			const snapshot = changed ? await this.persist(state, next) : this.snapshot(state);
			if (changed) this.clearOwnerKeys(cleanupKeys);
			return Object.freeze({ ok: true, snapshot, value: undefined });
		});
	}
	authorizeAppend(ctx: string, sessionId: string, threadId: string, id: string, claimId: string, fingerprint: string, authority: PendingChatInputAuthority, runId: string, generation: number): Promise<PendingChatInputMutationResult<PendingChatInputAppendLease>> {
		return this.mutate(ctx, sessionId, async (state, session) => {
			if (!validAuthority(authority) || !isNonemptyString(runId) || !Number.isSafeInteger(generation) || generation < 0 || authority.generation !== generation) return this.failed('invalid_request', state);
			if (this.mutationBlocked(state, threadId)) return this.failed('conflict', state);
			if (this.hasAnyActiveChildGroup(threadId)) return this.failed('append_in_progress', state);
			const record = this.currentRecord(state, threadId, id, fingerprint);
			const key = this.ownerKey(state, threadId, id);
			const owner = this.claimOwners.get(key);
			if (!record || record.phase !== 'claiming' || record.claimId !== claimId || !owner || owner.sessionId !== session.id || owner.claimId !== claimId) return this.failed('conflict', state);
			if (!this.authorityMatches(record, authority)) return this.failed('owner_or_trust_changed', state);
			if (owner.leaseId) {
				if (owner.leaseExpiresAt !== undefined && owner.leaseExpiresAt <= this.now()) {
					const next = state.records.map(candidate => candidate === record ? freezeRecord({ ...record, phase: 'dormant', claimId: undefined, runId: undefined, targetRunId: undefined, targetGeneration: undefined, targetChildGeneration: undefined, targetChildIds: undefined }) : candidate);
					await this.persist(state, next); this.claimOwners.delete(key); this.recordOwners.delete(key);
				}
				return this.failed('conflict', state);
			}
			const leaseId = this.uuid();
			if (!isNonemptyString(leaseId)) return this.failed('backend_unavailable', state);
			const historyOwner = this.historyRunOwner(session, threadId, runId, generation);
			if (!historyOwner || historyOwner.write) return this.failed('append_in_progress', state);
			owner.leaseId = leaseId;
			owner.leaseExpiresAt = this.now() + PENDING_CHAT_INPUT_APPEND_LEASE_TIMEOUT_MS;
			const selectionsFingerprint = pendingChatInputSelectionsFingerprint(record.selections);
			historyOwner.write = Object.freeze({ kind: 'claim', leaseId, text: record.text, selectionsFingerprint, pendingInputId: record.id });
			historyOwner.expiresAt = owner.leaseExpiresAt;
			return Object.freeze({ ok: true, snapshot: this.snapshot(state), value: Object.freeze({ record, claimId, leaseId, selectionsFingerprint }) });
		});
	}
	authorizeDirectHistoryAppend(ctx: string, sessionId: string, threadId: string, text: string, selections: readonly StagingSelectionItem[], runId: string, generation: number): Promise<PendingChatInputMutationResult<PendingChatInputDirectAppendLease>> {
		return this.mutate(ctx, sessionId, async (state, session) => {
			if (!isNonemptyString(threadId) || typeof text !== 'string' || !text.trim() || !Array.isArray(selections) || selections.some(selection => !revivePendingChatSelection(selection)) || !isNonemptyString(runId) || !Number.isSafeInteger(generation) || generation < 0) return this.failed('invalid_request', state);
			if (this.mutationBlocked(state, threadId)) return this.failed('conflict', state);
			if (this.brokerStorageContainsActiveThreadRecord(threadId) || this.hasAnyActiveChildGroup(threadId)) return this.failed('append_in_progress', state);
			const leaseId = this.uuid(); if (!isNonemptyString(leaseId)) return this.failed('backend_unavailable', state);
			const historyOwner = this.historyRunOwner(session, threadId, runId, generation);
			if (!historyOwner || historyOwner.write) return this.failed('append_in_progress', state);
			const selectionsFingerprint = pendingChatInputSelectionsFingerprint(selections);
			historyOwner.write = Object.freeze({ kind: 'direct', leaseId, text, selectionsFingerprint, pendingInputId: leaseId });
			historyOwner.expiresAt = this.now() + PENDING_CHAT_INPUT_APPEND_LEASE_TIMEOUT_MS;
			return Object.freeze({ ok: true, snapshot: this.snapshot(state), value: Object.freeze({ leaseId, pendingInputId: leaseId, selectionsFingerprint }) });
		});
	}
	verifyDirectHistoryAndRelease(ctx: string, sessionId: string, threadId: string, leaseId: string): Promise<PendingChatInputMutationResult<PendingChatInputHistoryInspection>> {
		return this.mutate(ctx, sessionId, async (state, session) => {
			const owner = this.activeHistoryOwner(threadId); const write = owner?.write;
			if (!owner || owner.sessionId !== session.id || write?.kind !== 'direct' || write.leaseId !== leaseId || owner.expiresAt <= this.now() || !write.text || !write.selectionsFingerprint || !write.pendingInputId) return this.failed('conflict', state);
			await this.storage.flush(); const inspection = this.inspectAppendHistoryValue(threadId, write.pendingInputId, write.text, write.selectionsFingerprint);
			if (inspection.kind !== 'exact') return Object.freeze({ ok: false, reason: 'conflict', snapshot: this.snapshot(state) });
			this.clearExactHistoryWrite(threadId, session.id, leaseId);
			return Object.freeze({ ok: true, snapshot: this.snapshot(state), value: inspection });
		});
	}
	abandonDirectHistoryAppend(ctx: string, sessionId: string, threadId: string, leaseId: string): Promise<PendingChatInputMutationResult> {
		return this.mutate(ctx, sessionId, async (state, session) => {
			const owner = this.activeHistoryOwner(threadId);
			if (!owner || owner.sessionId !== session.id || owner.write?.kind !== 'direct' || owner.write.leaseId !== leaseId) return this.failed('conflict', state);
			this.clearExactHistoryWrite(threadId, session.id, leaseId);
			return Object.freeze({ ok: true, snapshot: this.snapshot(state), value: undefined });
		});
	}
	authorizeThreadAnchor(ctx: string, sessionId: string, threadId: string): Promise<PendingChatInputMutationResult<PendingChatInputThreadAnchorLease>> {
		return this.mutate(ctx, sessionId, async (state, session) => {
			if (!isNonemptyString(threadId)) return this.failed('invalid_request', state);
			if (this.mutationBlocked(state, threadId)) return this.failed('conflict', state);
			await this.storage.flush();
			// The main cache is the cross-window authority.  A previously materialized
			// blank (including one whose first pending row is still preparing) must not
			// be re-anchored and must not acquire a second history-write lease.
			if (this.hasAuthoritativeThreadAnchor(threadId)) return Object.freeze({ ok: true, snapshot: this.snapshot(state), value: Object.freeze({ existing: true }) });
			if (this.storage.get(pendingChatInputThreadStorageKey(threadId)) !== undefined || this.activeHistoryOwner(threadId)) return this.failed('conflict', state);
			const leaseId = this.uuid(); if (!isNonemptyString(leaseId)) return this.failed('backend_unavailable', state);
			this.historyRunOwners.set(threadId, { kind: 'anchor', sessionId: session.id, namespaceKey: session.namespaceKey, threadId, expiresAt: this.now() + PENDING_CHAT_INPUT_APPEND_LEASE_TIMEOUT_MS, write: Object.freeze({ kind: 'anchor', leaseId }) });
			return Object.freeze({ ok: true, snapshot: this.snapshot(state), value: Object.freeze({ existing: false, leaseId }) });
		});
	}
	verifyThreadAnchorAndRelease(ctx: string, sessionId: string, threadId: string, leaseId: string): Promise<PendingChatInputMutationResult> {
		return this.mutate(ctx, sessionId, async (state, session) => {
			const owner = this.activeHistoryOwner(threadId);
			if (!owner || owner.sessionId !== session.id || owner.write?.kind !== 'anchor' || owner.write.leaseId !== leaseId) return this.failed('conflict', state);
			await this.storage.flush();
			if (!this.hasAuthoritativeThreadAnchor(threadId) || this.anchorLeaseOfThreadEnvelope(threadId) !== leaseId) return this.failed('conflict', state);
			owner.expiresAt = this.now() + PENDING_CHAT_INPUT_APPEND_LEASE_TIMEOUT_MS;
			return Object.freeze({ ok: true, snapshot: this.snapshot(state), value: undefined });
		});
	}
	abandonThreadAnchor(ctx: string, sessionId: string, threadId: string, leaseId: string): Promise<PendingChatInputMutationResult> {
		return this.mutate(ctx, sessionId, async (state, session) => {
			const owner = this.activeHistoryOwner(threadId);
			if (!owner || owner.sessionId !== session.id || owner.write?.kind !== 'anchor' || owner.write.leaseId !== leaseId) return this.failed('conflict', state);
			this.historyRunOwners.delete(threadId);
			await this.clearThreadAnchorMarker(threadId, leaseId, true);
			return Object.freeze({ ok: true, snapshot: this.snapshot(state), value: undefined });
		});
	}
	inspectAppendHistory(ctx: string, sessionId: string, threadId: string, id: string, claimId: string, leaseId: string | undefined): Promise<PendingChatInputMutationResult<PendingChatInputHistoryInspection>> {
		return this.mutate(ctx, sessionId, async (state, session) => {
			if (!isNonemptyString(threadId) || !isNonemptyString(id) || !isNonemptyString(claimId) || (leaseId !== undefined && !isNonemptyString(leaseId))) return this.failed('invalid_request', state);
			const record = this.currentRecord(state, threadId, id); const owner = this.claimOwners.get(this.ownerKey(state, threadId, id));
			const historyOwner = this.activeHistoryOwner(threadId);
			const liveHistoryWriteMatches = leaseId === undefined || (historyOwner?.sessionId === session.id && historyOwner.write?.kind === 'claim' && historyOwner.write.leaseId === leaseId && historyOwner.write.pendingInputId === id);
			const liveLeaseMatches = owner?.leaseId === undefined ? leaseId === undefined : owner.leaseId === leaseId && owner.leaseExpiresAt !== undefined && owner.leaseExpiresAt > this.now();
			if (!record || record.phase !== 'claiming' || record.claimId !== claimId || !owner || owner.sessionId !== session.id || owner.claimId !== claimId || !liveLeaseMatches || !liveHistoryWriteMatches) return this.failed('conflict', state);
			await this.storage.flush();
			return Object.freeze({ ok: true, snapshot: this.snapshot(state), value: this.inspectPendingRecordHistory(record) });
		});
	}
	verifyHistoryAndSettle(ctx: string, sessionId: string, threadId: string, id: string, claimId: string, leaseId: string): Promise<PendingChatInputMutationResult<PendingChatInputHistoryInspection>> {
		return this.mutate(ctx, sessionId, async (state, session) => {
			if (this.mutationBlocked(state, threadId) || !isNonemptyString(threadId) || !isNonemptyString(id) || !isNonemptyString(claimId) || !isNonemptyString(leaseId)) return this.failed('conflict', state);
			const record = this.currentRecord(state, threadId, id); const key = this.ownerKey(state, threadId, id); const owner = this.claimOwners.get(key);
			const historyOwner = this.activeHistoryOwner(threadId);
			if (record?.phase === 'claiming' && record.claimId === claimId && owner?.sessionId === session.id && owner.claimId === claimId && owner.leaseId === leaseId
				&& (owner.leaseExpiresAt === undefined || owner.leaseExpiresAt <= this.now() || !historyOwner)) {
				const snapshot = await this.persist(state, state.records.map(candidate => candidate === record ? freezeRecord({ ...record, phase: 'dormant', claimId: undefined, runId: undefined, targetRunId: undefined, targetGeneration: undefined, targetChildGeneration: undefined, targetChildIds: undefined }) : candidate));
				this.claimOwners.delete(key); this.recordOwners.delete(key); this.clearExactHistoryWrite(threadId, session.id, leaseId);
				return Object.freeze({ ok: false, reason: 'conflict', snapshot });
			}
			if (!record || record.phase !== 'claiming' || record.claimId !== claimId || !owner || owner.sessionId !== session.id || owner.claimId !== claimId || owner.leaseId !== leaseId || owner.leaseExpiresAt === undefined
				|| historyOwner?.sessionId !== session.id || historyOwner.write?.kind !== 'claim' || historyOwner.write.leaseId !== leaseId || historyOwner.write.pendingInputId !== id) return this.failed('conflict', state);
			await this.storage.flush();
			const inspection = this.inspectPendingRecordHistory(record);
			if (inspection.kind !== 'exact') return Object.freeze({ ok: false, reason: 'conflict', snapshot: this.snapshot(state) });
			const snapshot = await this.persist(state, state.records.filter(candidate => candidate !== record));
			this.claimOwners.delete(key); this.recordOwners.delete(key);
			this.clearExactHistoryWrite(threadId, session.id, leaseId);
			return Object.freeze({ ok: true, snapshot, value: inspection });
		});
	}
	settleClaim(ctx: string, sessionId: string, threadId: string, id: string, claimId: string, leaseId: string | undefined, result: 'queued' | 'dormant'): Promise<PendingChatInputMutationResult> {
		return this.mutate(ctx, sessionId, async (state, session) => {
			if (this.mutationBlocked(state, threadId)) return this.failed('conflict', state);
			const record = this.currentRecord(state, threadId, id);
			const key = this.ownerKey(state, threadId, id);
			const owner = this.claimOwners.get(key);
			if (!record || record.phase !== 'claiming' || record.claimId !== claimId || !owner || owner.sessionId !== session.id || owner.claimId !== claimId || (result !== 'queued' && result !== 'dormant')) return this.failed('conflict', state);
			if (owner.leaseId && owner.leaseExpiresAt !== undefined && owner.leaseExpiresAt <= this.now()) {
				const expired = state.records.map(candidate => candidate === record ? freezeRecord({ ...record, phase: 'dormant', claimId: undefined, runId: undefined, targetRunId: undefined, targetGeneration: undefined, targetChildGeneration: undefined, targetChildIds: undefined }) : candidate);
				await this.persist(state, expired); this.claimOwners.delete(key); this.recordOwners.delete(key);
				return this.failed('conflict', state);
			}
			const historyOwner = this.activeHistoryOwner(threadId);
			const hasExactLiveLease = isNonemptyString(leaseId) && owner.leaseId === leaseId && owner.leaseExpiresAt !== undefined && owner.leaseExpiresAt > this.now()
				&& historyOwner?.sessionId === session.id && historyOwner.write?.kind === 'claim' && historyOwner.write.leaseId === leaseId && historyOwner.write.pendingInputId === id;
			const validLease = result === 'dormant'
					? (owner.leaseId === undefined ? leaseId === undefined : hasExactLiveLease)
					: leaseId === undefined && owner.leaseId === undefined;
			if (!validLease) return this.failed('conflict', state);
			const next = state.records.map(candidate => candidate === record ? freezeRecord({ ...record, mode: result === 'queued' ? 'queue' : record.mode, phase: result, claimId: undefined, runId: undefined, targetRunId: undefined, targetGeneration: undefined, targetChildGeneration: undefined, targetChildIds: undefined }) : candidate);
			const snapshot = await this.persist(state, next);
			this.claimOwners.delete(key);
			if (hasExactLiveLease) this.clearExactHistoryWrite(threadId, session.id, leaseId!);
			if (result === 'dormant') this.recordOwners.delete(key); else this.recordOwners.set(key, session.id);
			return Object.freeze({ ok: true, snapshot, value: undefined });
		});
	}
	validateHistoryRun(ctx: string, sessionId: string, threadId: string, runId: string, generation: number): Promise<PendingChatInputMutationResult> {
		return this.mutate(ctx, sessionId, async (state, session) => {
			if (!isNonemptyString(threadId) || !isNonemptyString(runId) || !Number.isSafeInteger(generation) || generation < 0 || this.mutationBlocked(state, threadId)) return this.failed('conflict', state);
			const owner = this.activeHistoryOwner(threadId);
			if (!owner || owner.kind !== 'run' || owner.sessionId !== session.id || owner.runId !== runId || owner.generation !== generation || owner.write) return this.failed('conflict', state);
			return Object.freeze({ ok: true, snapshot: this.snapshot(state), value: undefined });
		});
	}
	holdApproval(ctx: string, sessionId: string, threadId: string, runId: string, generation: number, approval: PendingChatInputApprovalIdentity): Promise<PendingChatInputMutationResult> {
		return this.mutate(ctx, sessionId, async (state, session) => {
			if (!isNonemptyString(threadId) || !isNonemptyString(runId) || !Number.isSafeInteger(generation) || generation < 0 || !validApprovalIdentity(approval)) return this.failed('invalid_request', state);
			if (this.mutationBlocked(state, threadId)) return this.failed('conflict', state);
			await this.storage.flush();
			const key = approvalIdentityKey(approval);
			if (this.authoritativePendingApprovalKey(threadId) !== key) return this.failed('conflict', state);
			const current = this.activeHistoryOwner(threadId);
			if (current && (current.kind !== 'run' || current.sessionId !== session.id || current.runId !== runId || current.generation !== generation || current.write || (current.approvalKey && current.approvalKey !== key))) return this.failed('append_in_progress', state);
			const owner: HistoryRunOwner = current ?? { kind: 'run', sessionId: session.id, namespaceKey: session.namespaceKey, threadId, runId, generation, expiresAt: this.now() + PENDING_CHAT_INPUT_APPEND_LEASE_TIMEOUT_MS };
			owner.approvalKey = key; owner.expiresAt = this.now() + PENDING_CHAT_INPUT_APPEND_LEASE_TIMEOUT_MS; this.historyRunOwners.set(threadId, owner);
			return Object.freeze({ ok: true, snapshot: this.snapshot(state), value: undefined });
		});
	}
	closeRunAndReleaseSteers(ctx: string, sessionId: string, threadId: string, runId: string, generation: number, authority: PendingChatInputAuthority, retainApproval = false, childGroup?: PendingChatInputChildGroupIdentity): Promise<PendingChatInputMutationResult> {
		return this.mutate(ctx, sessionId, async (state, session) => {
			if (!isNonemptyString(threadId) || !isNonemptyString(runId) || !Number.isSafeInteger(generation) || generation < 0 || !validAuthority(authority) || authority.generation !== generation || typeof retainApproval !== 'boolean' || (childGroup !== undefined && !validChildGroupIdentity(childGroup))) return this.failed('invalid_request', state);
			if (this.mutationBlocked(state, threadId)) return this.failed('conflict', state);
			const historyOwner = this.activeHistoryOwner(threadId);
			const runKey = this.runGenerationKey(state, threadId);
			const completed = this.closedRunIdentityOfThread.get(runKey);
			const sameCompletedRun = !retainApproval && completed?.runId === runId && completed.generation === generation;
			const currentChild = historyOwner?.kind === 'run' || historyOwner?.kind === 'child' ? historyOwner.childGroup : undefined;
			const currentChildRevision = historyOwner?.kind === 'run' || historyOwner?.kind === 'child' ? historyOwner.childSourceRevision : undefined;
			const childIdentityMatches = childGroup === undefined
				? !currentChild
				: currentChildRevision === childGroup.sourceRevision
					&& (childGroup.childIds.length === 0
						? !currentChild
						: !!currentChild && currentChild.generation === childGroup.generation && currentChild.childIds.length === childGroup.childIds.length && currentChild.childIds.every((id, index) => id === childGroup.childIds[index]));
			if (sameCompletedRun && (!historyOwner || historyOwner.kind === 'child' && historyOwner.sourceRunId === runId && historyOwner.sourceGeneration === generation && childIdentityMatches)) return Object.freeze({ ok: true, snapshot: this.snapshot(state), value: undefined });
			if (historyOwner?.kind === 'child') return this.failed('append_in_progress', state);
			if (historyOwner && (historyOwner.kind !== 'run' || historyOwner.sessionId !== session.id || historyOwner.runId !== runId || historyOwner.generation !== generation)) return this.failed('conflict', state);
			if (!childIdentityMatches) return this.failed('conflict', state);
			if (historyOwner?.write) return this.failed('append_in_progress', state);
			if (retainApproval && (!historyOwner || !historyOwner.approvalKey || this.authoritativePendingApprovalKey(threadId) !== historyOwner.approvalKey)) return this.failed('conflict', state);
			if (!retainApproval && historyOwner?.approvalKey && this.authoritativePendingApprovalKey(threadId) === historyOwner.approvalKey) return this.failed('conflict', state);
			const claimKeys = new Set<string>();
			const dormantKeys = new Set<string>();
			const next = state.records.map(record => {
				// A Stop-and-Send row is bound to the run that existed at admission.
				// If a different replacement run legitimately reaches its close boundary,
				// the old target is gone: keep the text as ordinary queued work at the
				// replacement generation and never retarget/abort that replacement.
				if (record.threadId === threadId && record.mode === 'stop_and_send' && record.phase === 'queued' && record.targetRunId && record.targetRunId !== runId && record.targetGeneration !== undefined && record.targetGeneration <= generation) {
					return freezeRecord({ ...record, generation, targetRunId: undefined, targetGeneration: undefined });
				}
				if (record.threadId === threadId && record.mode === 'stop_and_send' && record.phase === 'queued' && record.targetChildGeneration !== undefined && record.targetChildGeneration <= generation) {
					return freezeRecord({ ...record, generation, targetChildGeneration: undefined, targetChildIds: undefined });
				}
				if (record.threadId !== threadId || record.runId !== runId || record.generation !== generation || (record.phase !== 'steering' && record.phase !== 'claiming')) return record;
				const ownerKey = this.ownerKey(state, record.threadId, record.id);
				const owner = this.claimOwners.get(ownerKey);
				if (this.recordOwners.get(ownerKey) !== session.id || (record.phase === 'claiming' && owner?.sessionId !== session.id) || owner?.leaseId) return record;
				if (record.phase === 'claiming') claimKeys.add(ownerKey);
				const deliverable = this.authorityMatches(record, authority);
				if (!deliverable) dormantKeys.add(ownerKey);
				return freezeRecord({ ...record, mode: 'queue', phase: deliverable ? 'queued' : 'dormant', runId: undefined, claimId: undefined });
			});
			// Even a no-Steer close publishes a revisioned wakeup. Another window may
			// own an ordinary queued row that was correctly held behind this run.
			const snapshot = await this.persist(state, next);
			for (const key of claimKeys) this.claimOwners.delete(key);
			for (const key of dormantKeys) this.recordOwners.delete(key);
			this.closedRunGenerationOfThread.set(runKey, Math.max(generation, this.closedRunGenerationOfThread.get(runKey) ?? -1));
			if (!retainApproval) {
				this.closedRunIdentityOfThread.set(runKey, Object.freeze({ runId, generation }));
				if (childGroup?.childIds.length) {
					const group = Object.freeze({ sourceRevision: childGroup.sourceRevision, generation: childGroup.generation!, childIds: Object.freeze([...childGroup.childIds]) });
					this.historyRunOwners.set(threadId, { kind: 'child', sessionId: session.id, namespaceKey: namespaceKey(state.namespace), threadId, sourceRunId: runId, sourceGeneration: generation, childSourceRevision: childGroup.sourceRevision, childGroup: group, generation: group.generation, expiresAt: this.now() + PENDING_CHAT_INPUT_SESSION_TIMEOUT_MS });
					this._onDidChangeChildGroup.fire(Object.freeze({ threadId }));
				}
				else if (historyOwner?.sessionId === session.id) this.historyRunOwners.delete(threadId);
			}
			return Object.freeze({ ok: true, snapshot, value: undefined });
		});
	}
	reconcileDeliveredPendingInputIds(ctx: string, sessionId: string, deliveredValues: Readonly<Record<string, readonly string[]>>): Promise<PendingChatInputMutationResult> { return this.mutate(ctx, sessionId, async state => { if (!isPlainObject(deliveredValues) || Object.entries(deliveredValues).some(([threadId, ids]) => !isNonemptyString(threadId) || !Array.isArray(ids) || ids.some(id => !isNonemptyString(id)))) return this.failed('invalid_request', state); if (this.mutationBlocked(state) || Object.keys(deliveredValues).some(threadId => this.mutationBlocked(state, threadId))) return this.failed('conflict', state); const delivered = new Map(Object.entries(deliveredValues).map(([threadId, ids]) => [threadId, this.deliveredSet(ids)])); if (delivered.size) await this.storage.flush(); const removed = state.records.filter(record => delivered.get(record.threadId)?.has(record.id) && !this.claimOwners.get(this.ownerKey(state, record.threadId, record.id))?.leaseId && this.inspectPendingRecordHistory(record).kind === 'exact'); if (!removed.length) return Object.freeze({ ok: true, snapshot: this.snapshot(state), value: undefined }); const next = state.records.filter(record => !removed.includes(record)); const snapshot = await this.persist(state, next); for (const record of removed) { const key = this.ownerKey(state, record.threadId, record.id); this.claimOwners.delete(key); this.recordOwners.delete(key); } return Object.freeze({ ok: true, snapshot, value: undefined }); }); }
	commitThreadRecord(ctx: string, sessionId: string, threadId: string, expectedRaw: string | undefined, nextRaw: string): Promise<PendingChatInputMutationResult<string>> {
		return this.mutate(ctx, sessionId, async (state, session) => {
			if (!isNonemptyString(threadId) || (expectedRaw !== undefined && typeof expectedRaw !== 'string') || typeof nextRaw !== 'string' || !nextRaw) return this.failed('invalid_request', state);
			if (this.mutationBlocked(state, threadId)) return this.failed('conflict', state);
			const owner = this.activeHistoryOwner(threadId);
			if (owner && owner.sessionId !== session.id) return this.failed('append_in_progress', state);
			let nextEnvelope: Record<string, unknown>;
			try {
				const envelope = JSON.parse(nextRaw) as unknown; if (!isPlainObject(envelope)) return this.failed('invalid_request', state); nextEnvelope = envelope;
				if (envelope.version !== 1 || !Number.isSafeInteger(envelope.revision) || (envelope.revision as number) < 1
					|| (envelope.deleted === true ? envelope.thread !== undefined : !isPlainObject(envelope.thread) || envelope.thread.id !== threadId || !Array.isArray(envelope.thread.messages))) return this.failed('invalid_request', state);
			} catch { return this.failed('invalid_request', state); }
			const key = pendingChatInputThreadStorageKey(threadId); const current = this.storage.get(key);
			if (current !== expectedRaw) return Object.freeze({ ok: false, reason: 'conflict', snapshot: this.snapshot(state), ...(current === undefined ? {} : { authoritativeRaw: current }) });
			let currentRevision = 0; let currentDeleted = false;
			if (current !== undefined) {
				try {
					const envelope = JSON.parse(current) as unknown;
					if (!isPlainObject(envelope) || envelope.version !== 1 || !Number.isSafeInteger(envelope.revision) || (envelope.revision as number) < 1
						|| (envelope.deleted === true ? envelope.thread !== undefined : !isPlainObject(envelope.thread) || envelope.thread.id !== threadId || !Array.isArray(envelope.thread.messages))) return Object.freeze({ ok: false, reason: 'conflict', snapshot: this.snapshot(state), authoritativeRaw: current });
					currentRevision = envelope.revision as number; currentDeleted = envelope.deleted === true;
				} catch { return Object.freeze({ ok: false, reason: 'conflict', snapshot: this.snapshot(state), authoritativeRaw: current }); }
			}
			if (currentRevision >= Number.MAX_SAFE_INTEGER || nextEnvelope.revision !== currentRevision + 1 || (currentDeleted && nextEnvelope.deleted !== true)) return Object.freeze({ ok: false, reason: 'conflict', snapshot: this.snapshot(state), ...(current === undefined ? {} : { authoritativeRaw: current }) });
			try { this.storage.storeUser(key, nextRaw); await this.storage.flush(); }
			catch {
				if (current === undefined) this.storage.removeUser(key); else this.storage.storeUser(key, current);
				try { await this.storage.flush(); } catch { /* preserve original */ }
				// The renderer must fence its active generation and restore the exact
				// pre-CAS bytes even when the storage write itself failed.
				return Object.freeze({ ok: false, reason: 'backend_unavailable' as const, snapshot: this.snapshot(state), ...(current === undefined ? {} : { authoritativeRaw: current }) });
			}
			return Object.freeze({ ok: true, snapshot: this.snapshot(state), value: nextRaw });
		});
	}
	private globalThreadMutationKey(threadId: string): string { return `global\u0000${threadId}`; }
	deleteThreadRecords(ctx: string, sessionId: string, threadId: string, evidence: PendingChatInputMutationEvidence): Promise<PendingChatInputMutationResult<PendingChatInputMutationLease>> {
		return this.mutate(ctx, sessionId, async (state, session) => {
			if (!isNonemptyString(threadId) || !validMutationEvidence(evidence)) return this.failed('invalid_request', state);
			const deliveryInProgress = this.hasAnyHistoryOwner(threadId) || this.hasAnyClaimOwner(threadId);
			if (this.globalMutation || this.mutationBlocked(state, threadId) || deliveryInProgress) return this.failed(deliveryInProgress ? 'append_in_progress' : 'conflict', state);
			const probe: StoredMutation = Object.freeze({ kind: 'thread-delete', leaseId: 'probe', threadId, originNamespace: state.namespace, ...evidence });
			if (this.mutationStorageFingerprint(probe) !== evidence.baselineFingerprint) return this.failed('conflict', state);
			const owner = this.newMutationOwner(session.id); if (!owner) return this.failed('backend_unavailable', state);
			// This is a prepare barrier only. Chat history/tombstone durability is the
			// commit record; pending rows remain byte-for-byte intact until finalize.
			const key = this.globalThreadMutationKey(threadId); const mutation: StoredMutation = Object.freeze({ kind: 'thread-delete', leaseId: owner.leaseId, threadId, originNamespace: state.namespace, ...evidence });
			this.completedThreadMutations.delete(key); this.threadMutationOwners.set(key, owner);
			try { await this.persistGlobalIntent(mutation); return Object.freeze({ ok: true, snapshot: this.snapshot(state), value: Object.freeze({ leaseId: owner.leaseId }) }); }
			catch (error) { this.threadMutationOwners.delete(key); throw error; }
		});
	}
	finalizeThreadDeletion(ctx: string, sessionId: string, threadId: string, leaseId: string): Promise<PendingChatInputMutationResult> {
		return this.mutate(ctx, sessionId, async state => {
			if (!isNonemptyString(threadId) || !isNonemptyString(leaseId)) return this.failed('invalid_request', state);
			const key = this.globalThreadMutationKey(threadId);
			if (this.completedThreadMutations.get(key) === leaseId || (this.completedGlobalMutation?.kind === 'thread-delete' && this.completedGlobalMutation.threadId === threadId && this.completedGlobalMutation.leaseId === leaseId)) return Object.freeze({ ok: true, snapshot: this.snapshot(state), value: undefined });
			const owner = this.activeMutationOwner(this.threadMutationOwners, key);
			const mutation = this.globalMutation;
			if ((owner && owner.leaseId !== leaseId) || mutation?.kind !== 'thread-delete' || mutation.leaseId !== leaseId || mutation.threadId !== threadId || this.mutationStorageState(mutation) !== 'expected') return this.failed('conflict', state);
			if (this.hasAnyHistoryOwner(threadId) || this.hasAnyClaimOwner(threadId)) return this.failed('append_in_progress', state);
			await this.resolveGlobalMutation(true); const snapshot = this.snapshot(state);
			this.completedThreadMutations.set(key, leaseId);
			this.closedRunGenerationOfThread.delete(this.runGenerationKey(state, threadId));
			return Object.freeze({ ok: true, snapshot, value: undefined });
		});
	}
	abortThreadDeletion(ctx: string, sessionId: string, threadId: string, leaseId: string): Promise<PendingChatInputMutationResult> {
		return this.mutate(ctx, sessionId, async (state, session) => {
			if (!isNonemptyString(threadId) || !isNonemptyString(leaseId)) return this.failed('invalid_request', state);
			const key = this.globalThreadMutationKey(threadId); const owner = this.activeMutationOwner(this.threadMutationOwners, key); const mutation = this.globalMutation;
			if ((owner && (owner.sessionId !== session.id || owner.leaseId !== leaseId)) || mutation?.kind !== 'thread-delete' || mutation.leaseId !== leaseId || mutation.threadId !== threadId || this.mutationStorageState(mutation) !== 'baseline') return this.failed('conflict', state);
			await this.resolveGlobalMutation(false); return Object.freeze({ ok: true, snapshot: this.snapshot(state), value: undefined });
		});
	}
	clearNamespace(ctx: string, sessionId: string, evidence: PendingChatInputMutationEvidence): Promise<PendingChatInputMutationResult<PendingChatInputMutationLease>> {
		return this.mutate(ctx, sessionId, async (state, session) => {
			if (!validMutationEvidence(evidence)) return this.failed('invalid_request', state);
			const deliveryInProgress = this.hasAnyHistoryOwner() || this.hasAnyClaimOwner();
			if (this.globalMutation || this.mutationBlocked(state) || deliveryInProgress) return this.failed(deliveryInProgress ? 'append_in_progress' : 'conflict', state);
			const probe: StoredMutation = Object.freeze({ kind: 'namespace-clear', leaseId: 'probe', originNamespace: state.namespace, ...evidence });
			if (this.mutationStorageFingerprint(probe) !== evidence.baselineFingerprint) return this.failed('conflict', state);
			const owner = this.newMutationOwner(session.id); if (!owner) return this.failed('backend_unavailable', state);
			const key = 'global'; const mutation: StoredMutation = Object.freeze({ kind: 'namespace-clear', leaseId: owner.leaseId, originNamespace: state.namespace, ...evidence });
			this.completedNamespaceMutations.delete(key); this.namespaceMutationOwners.set(key, owner);
			try { await this.persistGlobalIntent(mutation); return Object.freeze({ ok: true, snapshot: this.snapshot(state), value: Object.freeze({ leaseId: owner.leaseId }) }); }
			catch (error) { this.namespaceMutationOwners.delete(key); throw error; }
		});
	}
	finalizeNamespaceClear(ctx: string, sessionId: string, leaseId: string): Promise<PendingChatInputMutationResult> {
		return this.mutate(ctx, sessionId, async state => {
			if (!isNonemptyString(leaseId)) return this.failed('invalid_request', state);
			const key = 'global';
			if (this.completedNamespaceMutations.get(key) === leaseId || (this.completedGlobalMutation?.kind === 'namespace-clear' && this.completedGlobalMutation.leaseId === leaseId)) return Object.freeze({ ok: true, snapshot: this.snapshot(state), value: undefined });
			const owner = this.activeMutationOwner(this.namespaceMutationOwners, key);
			const mutation = this.globalMutation;
			if ((owner && owner.leaseId !== leaseId) || mutation?.kind !== 'namespace-clear' || mutation.leaseId !== leaseId || this.mutationStorageState(mutation) !== 'expected') return this.failed('conflict', state);
			if (this.hasAnyHistoryOwner() || this.hasAnyClaimOwner()) return this.failed('append_in_progress', state);
			await this.resolveGlobalMutation(true); const snapshot = this.snapshot(state);
			this.completedNamespaceMutations.set(key, leaseId);
			// Namespace replacement is application-global because the B1 thread store is
			// application-global.  Old per-namespace run tombstones must not downgrade a
			// fresh Steer for a reused thread id after import/reset.
			this.closedRunGenerationOfThread.clear();
			return Object.freeze({ ok: true, snapshot, value: undefined });
		});
	}
	abortNamespaceClear(ctx: string, sessionId: string, leaseId: string): Promise<PendingChatInputMutationResult> {
		return this.mutate(ctx, sessionId, async (state, session) => {
			if (!isNonemptyString(leaseId)) return this.failed('invalid_request', state);
			const key = 'global'; const owner = this.activeMutationOwner(this.namespaceMutationOwners, key); const mutation = this.globalMutation;
			if ((owner && (owner.sessionId !== session.id || owner.leaseId !== leaseId)) || mutation?.kind !== 'namespace-clear' || mutation.leaseId !== leaseId || this.mutationStorageState(mutation) !== 'baseline') return this.failed('conflict', state);
			await this.resolveGlobalMutation(false); return Object.freeze({ ok: true, snapshot: this.snapshot(state), value: undefined });
		});
	}

	private async releaseSessionInState(state: NamespaceState, sessionId: string): Promise<PendingChatInputSnapshot> {
		const mutation = this.globalMutation;
		if (mutation) {
			const owner = mutation.kind === 'namespace-clear' ? this.namespaceMutationOwners.get('global') : this.threadMutationOwners.get(this.globalThreadMutationKey(mutation.threadId));
			if (owner?.sessionId === sessionId && this.mutationStorageState(mutation) === 'expected') await this.resolveGlobalMutation(true);
		}
		const releasedKeys = new Set<string>();
		const next = state.records.map(record => {
			const key = this.ownerKey(state, record.threadId, record.id);
			if (this.recordOwners.get(key) !== sessionId) return record;
			releasedKeys.add(key);
			return freezeRecord({ ...record, phase: 'dormant', claimId: undefined, runId: undefined, targetRunId: undefined, targetGeneration: undefined, targetChildGeneration: undefined, targetChildIds: undefined });
		});
		const childThreads = new Set<string>();
		for (const [threadId, owner] of this.historyRunOwners) if (owner.sessionId === sessionId && (owner.kind === 'child' || !!owner.childGroup)) childThreads.add(threadId);
		const snapshot = releasedKeys.size || childThreads.size ? await this.persist(state, next) : this.snapshot(state);
		this.clearOwnerKeys(releasedKeys);
		for (const [threadId, owner] of this.historyRunOwners) if (owner.sessionId === sessionId) {
			this.historyRunOwners.delete(threadId);
			if (owner.write?.kind === 'anchor') await this.clearThreadAnchorMarker(threadId, owner.write.leaseId, true);
		}
		this.fireChildGroupChanges(childThreads);
		return snapshot;
	}
	async releaseSession(ctx: string, sessionId: string): Promise<PendingChatInputMutationResult> { const found = this.session(ctx, sessionId); if (!found) return this.failed('not_initialized'); return this.enqueue(found.state, async () => { const snapshot = await this.releaseSessionInState(found.state, sessionId); this.sessions.delete(sessionId); if (this.sessionOfContext.get(ctx) === sessionId) this.sessionOfContext.delete(ctx); return Object.freeze({ ok: true, snapshot, value: undefined }); }); }
	async releaseConnection(ctx: string): Promise<void> { const sessionId = this.sessionOfContext.get(ctx); if (sessionId) await this.releaseSession(ctx, sessionId); }
	private async expireAppendLeasesInState(state: NamespaceState, now: number): Promise<boolean> {
		const expiredKeys = new Set<string>();
		const next = state.records.map(record => {
			const key = this.ownerKey(state, record.threadId, record.id); const owner = this.claimOwners.get(key);
			if (record.phase !== 'claiming' || !owner?.leaseId || owner.leaseExpiresAt === undefined || owner.leaseExpiresAt > now) return record;
			expiredKeys.add(key);
			return freezeRecord({ ...record, phase: 'dormant', claimId: undefined, runId: undefined, targetRunId: undefined, targetGeneration: undefined, targetChildGeneration: undefined, targetChildIds: undefined });
		});
		if (!expiredKeys.size) return false;
		await this.persist(state, next);
		this.clearOwnerKeys(expiredKeys);
		return true;
	}
	private async expireAppendLeases(now: number): Promise<void> { for (const state of this.states.values()) await this.enqueue(state, () => this.expireAppendLeasesInState(state, now).then(() => undefined)); }
	private async expireHistoryRunLeases(now: number): Promise<void> {
		for (const [threadId, owner] of [...this.historyRunOwners]) {
			if (owner.expiresAt > now) continue;
			if (owner.kind === 'child') {
				const state = this.states.get(owner.namespaceKey);
				if (state?.loaded) await this.persist(state, state.records);
				this.historyRunOwners.delete(threadId);
				this._onDidChangeChildGroup.fire(Object.freeze({ threadId }));
				continue;
			}
			this.historyRunOwners.delete(threadId);
			if (owner.write?.kind === 'anchor') await this.clearThreadAnchorMarker(threadId, owner.write.leaseId, true);
		}
	}
	private async expireMutations(now: number): Promise<void> {
		const mutation = this.globalMutation; if (!mutation) return;
		const owner = mutation.kind === 'namespace-clear' ? this.namespaceMutationOwners.get('global') : this.threadMutationOwners.get(this.globalThreadMutationKey(mutation.threadId));
		if (owner && owner.expiresAt > now) return;
		const mutationState = this.mutationStorageState(mutation);
		if (mutationState !== 'ambiguous') await this.resolveGlobalMutation(mutationState === 'expected');
	}
	private async expireSessionIfStale(sessionId: string, now: number): Promise<void> {
		const session = this.sessions.get(sessionId); const state = session ? this.states.get(session.namespaceKey) : undefined;
		if (!session || !state) return;
		await this.enqueue(state, async () => {
			const current = this.sessions.get(sessionId);
			if (!current || current !== session || now - current.lastHeartbeat < PENDING_CHAT_INPUT_SESSION_TIMEOUT_MS) return;
			await this.releaseSessionInState(state, sessionId);
			this.sessions.delete(sessionId);
			if (this.sessionOfContext.get(current.ctx) === sessionId) this.sessionOfContext.delete(current.ctx);
		});
	}
	async expireSessions(now = this.now()): Promise<void> {
		await this.enqueueOperation(async () => { await this.expireMutations(now); await this.expireHistoryRunLeases(now); }); await this.expireAppendLeases(now); const candidates = [...this.sessions.keys()]; for (const sessionId of candidates) await this.expireSessionIfStale(sessionId, now);
	}
	dispose(): void { this.threadMutationOwners.clear(); this.namespaceMutationOwners.clear(); this.historyRunOwners.clear(); this.completedThreadMutations.clear(); this.completedNamespaceMutations.clear(); this.closedRunGenerationOfThread.clear(); this.closedRunIdentityOfThread.clear(); this._onDidChange.dispose(); this._onDidChangeChildGroup.dispose(); }
}

export const pendingChatInputBrokerEventForNamespace = (event: Event<PendingChatInputSnapshot>, namespace: PendingChatInputNamespace): Event<PendingChatInputSnapshot> => Event.filter(event, snapshot => snapshot.namespace.profileId === namespace.profileId && snapshot.namespace.workspaceIdentity === namespace.workspaceIdentity);
