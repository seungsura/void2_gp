/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
import { isSingleFolderWorkspaceIdentifier, isWorkspaceIdentifier, IWorkspaceContextService, toWorkspaceIdentifier } from '../../../../platform/workspace/common/workspace.js';
import { IUserDataProfileService } from '../../../services/userDataProfile/common/userDataProfile.js';
import { StagingSelectionItem } from '../common/chatThreadServiceTypes.js';
import { PENDING_CHAT_INPUT_STORAGE_KEY } from '../common/storageKeys.js';
import {
	PendingChatInput,
	PendingChatInputApprovalIdentity,
	PendingChatInputAppendLease,
	PendingChatInputDirectAppendLease,
	PendingChatInputThreadAnchorLease,
	PendingChatInputAuthority,
	PendingChatInputBrokerInitializeRequest,
	PendingChatInputBrokerSubmitRequest,
	PendingChatInputClaim,
	PendingChatInputChildGroupEvent,
	PendingChatInputChildGroupIdentity,
	PendingChatInputInitializeResult,
	PendingChatInputHistoryInspection,
	PendingChatInputMutationEvidence,
	PendingChatInputMutationResult,
	PendingChatInputMutationLease,
	PendingChatInputNamespace,
	PendingChatInputSnapshot,
	PENDING_CHAT_INPUT_BROKER_CHANNEL_NAME,
	PENDING_CHAT_INPUT_HEARTBEAT_MS,
	pendingChatInputsFit,
	revivePendingChatInput,
} from '../common/pendingChatInputBroker.js';

export interface IPendingChatInputBrokerService {
	readonly _serviceBrand: undefined;
	readonly namespace: PendingChatInputNamespace;
	readonly snapshot: PendingChatInputSnapshot | undefined;
	readonly onDidChange: Event<PendingChatInputSnapshot>;
	readonly onDidChangeChildGroup: Event<PendingChatInputChildGroupEvent>;
	initializeNamespace(request: Omit<PendingChatInputBrokerInitializeRequest, 'namespace' | 'legacyRaw'>): Promise<PendingChatInputInitializeResult>;
	syncActiveChildGroup(threadId: string, sourceRunId: string, sourceGeneration: number, sourceRevision: number, generation: number | undefined, childIds: readonly string[]): Promise<PendingChatInputMutationResult>;
	submit(request: Omit<PendingChatInputBrokerSubmitRequest, 'sessionId'>): Promise<PendingChatInputMutationResult<PendingChatInput>>;
	edit(threadId: string, id: string, fingerprint: string, text: string, selections?: readonly StagingSelectionItem[]): Promise<PendingChatInputMutationResult>;
	delete(threadId: string, id: string, fingerprint: string): Promise<PendingChatInputMutationResult>;
	reorder(threadId: string, id: string, fingerprint: string, threadFingerprint: string, beforeId?: string): Promise<PendingChatInputMutationResult>;
	resume(threadId: string, id: string, fingerprint: string, authority: PendingChatInputAuthority): Promise<PendingChatInputMutationResult>;
	suspend(threadId: string, id: string, fingerprint: string): Promise<PendingChatInputMutationResult>;
	claimNextQueued(threadId: string, authority: PendingChatInputAuthority, deliveredIds: readonly string[]): Promise<PendingChatInputMutationResult<PendingChatInputClaim | undefined>>;
	claimSteerAtBoundary(threadId: string, runId: string, generation: number, authority: PendingChatInputAuthority, deliveredIds: readonly string[]): Promise<PendingChatInputMutationResult<PendingChatInputClaim | undefined>>;
	authorizeAppend(threadId: string, id: string, claimId: string, fingerprint: string, authority: PendingChatInputAuthority, runId: string, generation: number): Promise<PendingChatInputMutationResult<PendingChatInputAppendLease>>;
	authorizeDirectHistoryAppend(threadId: string, text: string, selections: readonly StagingSelectionItem[], runId: string, generation: number): Promise<PendingChatInputMutationResult<PendingChatInputDirectAppendLease>>;
	verifyDirectHistoryAndRelease(threadId: string, leaseId: string): Promise<PendingChatInputMutationResult<PendingChatInputHistoryInspection>>;
	abandonDirectHistoryAppend(threadId: string, leaseId: string): Promise<PendingChatInputMutationResult>;
	authorizeThreadAnchor(threadId: string): Promise<PendingChatInputMutationResult<PendingChatInputThreadAnchorLease>>;
	verifyThreadAnchorAndRelease(threadId: string, leaseId: string): Promise<PendingChatInputMutationResult>;
	abandonThreadAnchor(threadId: string, leaseId: string): Promise<PendingChatInputMutationResult>;
	inspectAppendHistory(threadId: string, id: string, claimId: string, leaseId: string | undefined): Promise<PendingChatInputMutationResult<PendingChatInputHistoryInspection>>;
	verifyHistoryAndSettle(threadId: string, id: string, claimId: string, leaseId: string): Promise<PendingChatInputMutationResult<PendingChatInputHistoryInspection>>;
	settleClaim(threadId: string, id: string, claimId: string, leaseId: string | undefined, result: 'queued' | 'dormant'): Promise<PendingChatInputMutationResult>;
	validateHistoryRun(threadId: string, runId: string, generation: number): Promise<PendingChatInputMutationResult>;
	holdApproval(threadId: string, runId: string, generation: number, approval: PendingChatInputApprovalIdentity): Promise<PendingChatInputMutationResult>;
	closeRunAndReleaseSteers(threadId: string, runId: string, generation: number, authority: PendingChatInputAuthority, retainApproval?: boolean, childGroup?: PendingChatInputChildGroupIdentity): Promise<PendingChatInputMutationResult>;
	reconcileDeliveredPendingInputIds(delivered: Readonly<Record<string, readonly string[]>>): Promise<PendingChatInputMutationResult>;
	commitThreadRecord(threadId: string, expectedRaw: string | undefined, nextRaw: string): Promise<PendingChatInputMutationResult<string>>;
	deleteThreadRecords(threadId: string, evidence: PendingChatInputMutationEvidence): Promise<PendingChatInputMutationResult<PendingChatInputMutationLease>>;
	finalizeThreadDeletion(threadId: string, leaseId: string): Promise<PendingChatInputMutationResult>;
	abortThreadDeletion(threadId: string, leaseId: string): Promise<PendingChatInputMutationResult>;
	clearNamespace(evidence: PendingChatInputMutationEvidence): Promise<PendingChatInputMutationResult<PendingChatInputMutationLease>>;
	finalizeNamespaceClear(leaseId: string): Promise<PendingChatInputMutationResult>;
	abortNamespaceClear(leaseId: string): Promise<PendingChatInputMutationResult>;
}

export const IPendingChatInputBrokerService = createDecorator<IPendingChatInputBrokerService>('voidPendingChatInputBrokerService');

const workspaceIdentity = (workspaceContextService: IWorkspaceContextService): string => {
	const identifier = toWorkspaceIdentifier(workspaceContextService.getWorkspace());
	if (isSingleFolderWorkspaceIdentifier(identifier)) return JSON.stringify({ kind: 'folder', id: identifier.id, uri: identifier.uri.toString() });
	if (isWorkspaceIdentifier(identifier)) return JSON.stringify({ kind: 'workspace', id: identifier.id, configPath: identifier.configPath.toString() });
	return JSON.stringify({ kind: 'empty', id: identifier.id });
};

export class PendingChatInputBrokerService extends Disposable implements IPendingChatInputBrokerService {
	readonly _serviceBrand: undefined;
	readonly namespace: PendingChatInputNamespace;
	private readonly channel: IChannel;
	private _snapshot: PendingChatInputSnapshot | undefined;
	private sessionId: string | undefined;
	private initializePromise: Promise<PendingChatInputInitializeResult> | undefined;
	private initializeRequest: Omit<PendingChatInputBrokerInitializeRequest, 'namespace' | 'legacyRaw'> | undefined;
	private heartbeat: IDisposable | undefined;
	private disposed = false;
	private readonly _onDidChange = this._register(new Emitter<PendingChatInputSnapshot>());
	readonly onDidChange: Event<PendingChatInputSnapshot> = this._onDidChange.event;
	private readonly _onDidChangeChildGroup = this._register(new Emitter<PendingChatInputChildGroupEvent>());
	readonly onDidChangeChildGroup: Event<PendingChatInputChildGroupEvent> = this._onDidChangeChildGroup.event;
	get snapshot(): PendingChatInputSnapshot | undefined { return this._snapshot; }

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
		@IStorageService private readonly storageService: IStorageService,
		@IWorkspaceContextService workspaceContextService: IWorkspaceContextService,
		@IUserDataProfileService userDataProfileService: IUserDataProfileService,
	) {
		super();
		this.namespace = Object.freeze({ profileId: userDataProfileService.currentProfile.id, workspaceIdentity: workspaceIdentity(workspaceContextService) });
		this.channel = mainProcessService.getChannel(PENDING_CHAT_INPUT_BROKER_CHANNEL_NAME);
		// Subscribe before initialization so no flushed state between snapshot read and
		// listener installation can be missed.
		this._register(this.channel.listen<PendingChatInputSnapshot>('onDidChange', this.namespace)(snapshot => this.applySnapshot(snapshot, false)));
		this._register(this.channel.listen<PendingChatInputChildGroupEvent>('onDidChangeChildGroup', this.namespace)(event => {
			if (event && typeof event === 'object' && typeof event.threadId === 'string' && !!event.threadId && event.threadId.length <= 512) this._onDidChangeChildGroup.fire(Object.freeze({ threadId: event.threadId }));
		}));
		this._register(toDisposable(() => { this.disposed = true; this.heartbeat?.dispose(); this.heartbeat = undefined; const sessionId = this.sessionId; this.sessionId = undefined; this.initializePromise = undefined; if (sessionId) void this.channel.call('releaseSession', { sessionId }).catch(error => console.error('Pending chat input broker release failed:', error)); }));
	}

	private applySnapshot(snapshot: PendingChatInputSnapshot | undefined, allowEqualInitial: boolean): boolean {
		if (!snapshot || snapshot.namespace.profileId !== this.namespace.profileId || snapshot.namespace.workspaceIdentity !== this.namespace.workspaceIdentity || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 || !Array.isArray(snapshot.records)) return false;
		const records = snapshot.records.map(record => revivePendingChatInput(record, false, false));
		if (records.some(record => !record) || !pendingChatInputsFit(records as PendingChatInput[]) || new Set(records.map(record => JSON.stringify([record!.threadId, record!.id]))).size !== records.length) return false;
		if (this._snapshot && (snapshot.revision < this._snapshot.revision || (snapshot.revision === this._snapshot.revision && !allowEqualInitial))) return true;
		const validated = Object.freeze({ namespace: this.namespace, revision: snapshot.revision, records: Object.freeze(records as PendingChatInput[]) });
		this._snapshot = validated;
		this._onDidChange.fire(validated);
		return true;
	}
	protected scheduleHeartbeat(callback: () => void): IDisposable { const handle = setInterval(callback, PENDING_CHAT_INPUT_HEARTBEAT_MS); return toDisposable(() => clearInterval(handle)); }
	private invalidateSession(): void { this.sessionId = undefined; this.initializePromise = undefined; this.heartbeat?.dispose(); this.heartbeat = undefined; }
	private async ready(): Promise<string | undefined> { if (this.disposed) return undefined; if (!this.sessionId && this.initializeRequest) await this.initializeNamespace(this.initializeRequest); return this.sessionId; }
	private isResult<T>(result: unknown): result is PendingChatInputMutationResult<T> {
		if (!result || typeof result !== 'object' || typeof (result as { ok?: unknown }).ok !== 'boolean') return false;
		if ((result as { ok: boolean }).ok) return !!(result as { snapshot?: unknown }).snapshot;
		return ['invalid_request', 'not_initialized', 'backend_unavailable', 'full', 'conflict', 'owner_or_trust_changed', 'append_in_progress'].includes(String((result as { reason?: unknown }).reason));
	}
	private async call<T>(command: string, request: Record<string, unknown>): Promise<PendingChatInputMutationResult<T>> {
		const sessionId = await this.ready();
		if (!sessionId) return Object.freeze({ ok: false, reason: 'not_initialized' });
		try {
			const result = await this.channel.call<PendingChatInputMutationResult<T>>(command, { ...request, sessionId });
			if (!this.isResult<T>(result) || (result.snapshot && !this.applySnapshot(result.snapshot, false))) throw new Error('pending_input_response_invalid');
			if (!result.ok && result.reason === 'not_initialized') this.invalidateSession();
			return result;
		} catch { this.invalidateSession(); return Object.freeze({ ok: false, reason: 'backend_unavailable', ...(this._snapshot ? { snapshot: this._snapshot } : {}) }); }
	}

	initializeNamespace(request: Omit<PendingChatInputBrokerInitializeRequest, 'namespace' | 'legacyRaw'>): Promise<PendingChatInputInitializeResult> {
		if (this.disposed) return Promise.resolve(Object.freeze({ ok: false, reason: 'not_initialized' }));
		this.initializeRequest = request;
		if (this.initializePromise) return this.initializePromise;
		const legacyRaw = this.storageService.get(PENDING_CHAT_INPUT_STORAGE_KEY, StorageScope.WORKSPACE);
		const current = this.channel.call<PendingChatInputInitializeResult>('initializeNamespace', { ...request, namespace: this.namespace, ...(legacyRaw === undefined ? {} : { legacyRaw }) }).then(async result => {
			if (!this.isResult(result)) throw new Error('pending_input_initialize_response_invalid');
			if (!result.ok) { this.initializePromise = undefined; return result; }
			if (!result.value || typeof result.value.sessionId !== 'string' || !result.value.sessionId || typeof result.value.removeLegacy !== 'boolean' || (result.value.warning !== undefined && typeof result.value.warning !== 'string')) throw new Error('pending_input_initialize_response_invalid');
			if (this.disposed) { await this.channel.call('releaseSession', { sessionId: result.value.sessionId }).catch(() => undefined); throw new Error('pending_input_service_disposed'); }
			if (!this.applySnapshot(result.snapshot, true)) { await this.channel.call('releaseSession', { sessionId: result.value.sessionId }).catch(() => undefined); throw new Error('pending_input_initialize_response_invalid'); }
			this.sessionId = result.value.sessionId;
			if (result.value.removeLegacy) this.storageService.remove(PENDING_CHAT_INPUT_STORAGE_KEY, StorageScope.WORKSPACE);
			this.heartbeat?.dispose();
			this.heartbeat = this.scheduleHeartbeat(() => {
				const sessionId = this.sessionId;
				if (sessionId) void this.channel.call<PendingChatInputMutationResult>('heartbeat', { sessionId }).then(result => {
					if (!this.isResult(result) || (result.snapshot && !this.applySnapshot(result.snapshot, false)) || (!result.ok && result.reason === 'not_initialized')) this.invalidateSession();
				}, () => this.invalidateSession()).catch(() => this.invalidateSession());
			});
			return result;
		}).catch(() => { this.invalidateSession(); return Object.freeze({ ok: false, reason: 'backend_unavailable' } as const); });
		this.initializePromise = current;
		return current;
	}
	submit(request: Omit<PendingChatInputBrokerSubmitRequest, 'sessionId'>): Promise<PendingChatInputMutationResult<PendingChatInput>> { return this.call('submit', request as unknown as Record<string, unknown>); }
	syncActiveChildGroup(threadId: string, sourceRunId: string, sourceGeneration: number, sourceRevision: number, generation: number | undefined, childIds: readonly string[]): Promise<PendingChatInputMutationResult> { return this.call('syncActiveChildGroup', { threadId, sourceRunId, sourceGeneration, sourceRevision, ...(generation === undefined ? {} : { generation }), childIds }); }
	edit(threadId: string, id: string, fingerprint: string, text: string, selections?: readonly StagingSelectionItem[]): Promise<PendingChatInputMutationResult> { return this.call('edit', { threadId, id, fingerprint, text, ...(selections ? { selections } : {}) }); }
	delete(threadId: string, id: string, fingerprint: string): Promise<PendingChatInputMutationResult> { return this.call('delete', { threadId, id, fingerprint }); }
	reorder(threadId: string, id: string, fingerprint: string, threadFingerprint: string, beforeId?: string): Promise<PendingChatInputMutationResult> { return this.call('reorder', { threadId, id, fingerprint, threadFingerprint, ...(beforeId === undefined ? {} : { beforeId }) }); }
	resume(threadId: string, id: string, fingerprint: string, authority: PendingChatInputAuthority): Promise<PendingChatInputMutationResult> { return this.call('resume', { threadId, id, fingerprint, authority }); }
	suspend(threadId: string, id: string, fingerprint: string): Promise<PendingChatInputMutationResult> { return this.call('suspend', { threadId, id, fingerprint }); }
	claimNextQueued(threadId: string, authority: PendingChatInputAuthority, deliveredIds: readonly string[]): Promise<PendingChatInputMutationResult<PendingChatInputClaim | undefined>> { return this.call('claimNextQueued', { threadId, authority, deliveredIds }); }
	claimSteerAtBoundary(threadId: string, runId: string, generation: number, authority: PendingChatInputAuthority, deliveredIds: readonly string[]): Promise<PendingChatInputMutationResult<PendingChatInputClaim | undefined>> { return this.call('claimSteerAtBoundary', { threadId, runId, generation, authority, deliveredIds }); }
	authorizeAppend(threadId: string, id: string, claimId: string, fingerprint: string, authority: PendingChatInputAuthority, runId: string, generation: number): Promise<PendingChatInputMutationResult<PendingChatInputAppendLease>> { return this.call('authorizeAppend', { threadId, id, claimId, fingerprint, authority, runId, generation }); }
	authorizeDirectHistoryAppend(threadId: string, text: string, selections: readonly StagingSelectionItem[], runId: string, generation: number): Promise<PendingChatInputMutationResult<PendingChatInputDirectAppendLease>> { return this.call('authorizeDirectHistoryAppend', { threadId, text, selections, runId, generation }); }
	verifyDirectHistoryAndRelease(threadId: string, leaseId: string): Promise<PendingChatInputMutationResult<PendingChatInputHistoryInspection>> { return this.call('verifyDirectHistoryAndRelease', { threadId, leaseId }); }
	abandonDirectHistoryAppend(threadId: string, leaseId: string): Promise<PendingChatInputMutationResult> { return this.call('abandonDirectHistoryAppend', { threadId, leaseId }); }
	authorizeThreadAnchor(threadId: string): Promise<PendingChatInputMutationResult<PendingChatInputThreadAnchorLease>> { return this.call('authorizeThreadAnchor', { threadId }); }
	verifyThreadAnchorAndRelease(threadId: string, leaseId: string): Promise<PendingChatInputMutationResult> { return this.call('verifyThreadAnchorAndRelease', { threadId, leaseId }); }
	abandonThreadAnchor(threadId: string, leaseId: string): Promise<PendingChatInputMutationResult> { return this.call('abandonThreadAnchor', { threadId, leaseId }); }
	inspectAppendHistory(threadId: string, id: string, claimId: string, leaseId: string | undefined): Promise<PendingChatInputMutationResult<PendingChatInputHistoryInspection>> { return this.call('inspectAppendHistory', { threadId, id, claimId, leaseId }); }
	verifyHistoryAndSettle(threadId: string, id: string, claimId: string, leaseId: string): Promise<PendingChatInputMutationResult<PendingChatInputHistoryInspection>> { return this.call('verifyHistoryAndSettle', { threadId, id, claimId, leaseId }); }
	settleClaim(threadId: string, id: string, claimId: string, leaseId: string | undefined, result: 'queued' | 'dormant'): Promise<PendingChatInputMutationResult> { return this.call('settleClaim', { threadId, id, claimId, leaseId, result }); }
	validateHistoryRun(threadId: string, runId: string, generation: number): Promise<PendingChatInputMutationResult> { return this.call('validateHistoryRun', { threadId, runId, generation }); }
	holdApproval(threadId: string, runId: string, generation: number, approval: PendingChatInputApprovalIdentity): Promise<PendingChatInputMutationResult> { return this.call('holdApproval', { threadId, runId, generation, approval }); }
	closeRunAndReleaseSteers(threadId: string, runId: string, generation: number, authority: PendingChatInputAuthority, retainApproval = false, childGroup?: PendingChatInputChildGroupIdentity): Promise<PendingChatInputMutationResult> { return this.call('closeRunAndReleaseSteers', { threadId, runId, generation, authority, retainApproval, ...(childGroup ? { childGroup } : {}) }); }
	reconcileDeliveredPendingInputIds(delivered: Readonly<Record<string, readonly string[]>>): Promise<PendingChatInputMutationResult> { return this.call('reconcileDeliveredPendingInputIds', { delivered }); }
	commitThreadRecord(threadId: string, expectedRaw: string | undefined, nextRaw: string): Promise<PendingChatInputMutationResult<string>> { return this.call('commitThreadRecord', { threadId, ...(expectedRaw === undefined ? {} : { expectedRaw }), nextRaw }); }
	deleteThreadRecords(threadId: string, evidence: PendingChatInputMutationEvidence): Promise<PendingChatInputMutationResult<PendingChatInputMutationLease>> { return this.call('deleteThreadRecords', { threadId, evidence }); }
	finalizeThreadDeletion(threadId: string, leaseId: string): Promise<PendingChatInputMutationResult> { return this.call('finalizeThreadDeletion', { threadId, leaseId }); }
	abortThreadDeletion(threadId: string, leaseId: string): Promise<PendingChatInputMutationResult> { return this.call('abortThreadDeletion', { threadId, leaseId }); }
	clearNamespace(evidence: PendingChatInputMutationEvidence): Promise<PendingChatInputMutationResult<PendingChatInputMutationLease>> { return this.call('clearNamespace', { evidence }); }
	finalizeNamespaceClear(leaseId: string): Promise<PendingChatInputMutationResult> { return this.call('finalizeNamespaceClear', { leaseId }); }
	abortNamespaceClear(leaseId: string): Promise<PendingChatInputMutationResult> { return this.call('abortNamespaceClear', { leaseId }); }
}

registerSingleton(IPendingChatInputBrokerService, PendingChatInputBrokerService, InstantiationType.Eager);
