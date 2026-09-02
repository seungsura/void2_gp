/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IChannelServer, IConnectionHub, IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IApplicationStorageMainService } from '../../../../platform/storage/electron-main/storageMainService.js';
import {
	PendingChatInputBrokerCore,
	PendingChatInputBrokerInitializeRequest,
	PendingChatInputBrokerStorage,
	PendingChatInputNamespace,
	PENDING_CHAT_INPUT_BROKER_CHANNEL_NAME,
	PENDING_CHAT_INPUT_APPEND_LEASE_TIMEOUT_MS,
	PENDING_CHAT_INPUT_SESSION_TIMEOUT_MS,
	pendingChatInputBrokerEventForNamespace,
} from '../common/pendingChatInputBroker.js';

type BrokerCall = Readonly<Record<string, unknown>>;

const isNamespace = (value: unknown): value is PendingChatInputNamespace => {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return typeof record.profileId === 'string' && !!record.profileId && typeof record.workspaceIdentity === 'string' && !!record.workspaceIdentity;
};

export class PendingChatInputBrokerChannel extends Disposable implements IServerChannel<string> {
	readonly core: PendingChatInputBrokerCore;

	constructor(applicationStorage: IApplicationStorageMainService, core?: PendingChatInputBrokerCore) {
		super();
		const storage: PendingChatInputBrokerStorage = {
			whenReady: applicationStorage.whenReady,
			get: key => applicationStorage.get(key, StorageScope.APPLICATION),
			store: (key, value) => applicationStorage.store(key, value, StorageScope.APPLICATION, StorageTarget.MACHINE),
			storeAll: entries => applicationStorage.storeAll(entries.map(entry => ({ ...entry, scope: StorageScope.APPLICATION, target: StorageTarget.MACHINE })), false),
			remove: key => applicationStorage.remove(key, StorageScope.APPLICATION),
			storeUser: (key, value) => applicationStorage.store(key, value, StorageScope.APPLICATION, StorageTarget.USER),
			removeUser: key => applicationStorage.remove(key, StorageScope.APPLICATION),
			keys: target => applicationStorage.keys(StorageScope.APPLICATION, target === 'machine' ? StorageTarget.MACHINE : StorageTarget.USER),
			flush: () => applicationStorage.flush(),
		};
		this.core = core ?? new PendingChatInputBrokerCore(storage);
		const timer = setInterval(() => { void this.core.expireSessions().catch(error => console.error('Pending chat input broker expiry failed:', error)); }, Math.max(1_000, Math.floor(Math.min(PENDING_CHAT_INPUT_SESSION_TIMEOUT_MS, PENDING_CHAT_INPUT_APPEND_LEASE_TIMEOUT_MS) / 3)));
		this._register(toDisposable(() => { clearInterval(timer); this.core.dispose(); }));
	}

	listen<T>(ctx: string, event: string, arg?: unknown): Event<T> {
		if (typeof ctx !== 'string' || !ctx) return Event.None;
		if (event === 'onDidChangeChildGroup') return this.core.onDidChangeChildGroup as Event<T>;
		if (event !== 'onDidChange' || !isNamespace(arg)) return Event.None;
		return pendingChatInputBrokerEventForNamespace(this.core.onDidChange, arg) as Event<T>;
	}

	async call<T>(ctx: string, command: string, arg?: BrokerCall): Promise<T> {
		const request = arg ?? {};
			switch (command) {
			case 'initializeNamespace': return await this.core.initializeNamespace(ctx, request as unknown as PendingChatInputBrokerInitializeRequest) as T;
			case 'heartbeat': return await this.core.heartbeat(ctx, request.sessionId as string) as T;
			case 'syncActiveChildGroup': return await this.core.syncActiveChildGroup(ctx, request.sessionId as string, request.threadId as string, request.sourceRunId as string, request.sourceGeneration as number, request.sourceRevision as number, request.generation as number | undefined, request.childIds as never) as T;
			case 'submit': return await this.core.submit(ctx, request as never) as T;
			case 'edit': return await this.core.edit(ctx, request.sessionId as string, request.threadId as string, request.id as string, request.fingerprint as string, request.text as string, request.selections as never) as T;
			case 'delete': return await this.core.delete(ctx, request.sessionId as string, request.threadId as string, request.id as string, request.fingerprint as string) as T;
			case 'reorder': return await this.core.reorder(ctx, request.sessionId as string, request.threadId as string, request.id as string, request.fingerprint as string, request.threadFingerprint as string, request.beforeId as string | undefined) as T;
			case 'resume': return await this.core.resume(ctx, request.sessionId as string, request.threadId as string, request.id as string, request.fingerprint as string, request.authority as never) as T;
			case 'suspend': return await this.core.suspend(ctx, request.sessionId as string, request.threadId as string, request.id as string, request.fingerprint as string) as T;
			case 'claimNextQueued': return await this.core.claimNextQueued(ctx, request.sessionId as string, request.threadId as string, request.authority as never, request.deliveredIds as never) as T;
			case 'claimSteerAtBoundary': return await this.core.claimSteerAtBoundary(ctx, request.sessionId as string, request.threadId as string, request.runId as string, request.generation as number, request.authority as never, request.deliveredIds as never) as T;
			case 'authorizeAppend': return await this.core.authorizeAppend(ctx, request.sessionId as string, request.threadId as string, request.id as string, request.claimId as string, request.fingerprint as string, request.authority as never, request.runId as string, request.generation as number) as T;
			case 'authorizeDirectHistoryAppend': return await this.core.authorizeDirectHistoryAppend(ctx, request.sessionId as string, request.threadId as string, request.text as string, request.selections as never, request.runId as string, request.generation as number) as T;
			case 'verifyDirectHistoryAndRelease': return await this.core.verifyDirectHistoryAndRelease(ctx, request.sessionId as string, request.threadId as string, request.leaseId as string) as T;
			case 'abandonDirectHistoryAppend': return await this.core.abandonDirectHistoryAppend(ctx, request.sessionId as string, request.threadId as string, request.leaseId as string) as T;
			case 'authorizeThreadAnchor': return await this.core.authorizeThreadAnchor(ctx, request.sessionId as string, request.threadId as string) as T;
			case 'verifyThreadAnchorAndRelease': return await this.core.verifyThreadAnchorAndRelease(ctx, request.sessionId as string, request.threadId as string, request.leaseId as string) as T;
			case 'abandonThreadAnchor': return await this.core.abandonThreadAnchor(ctx, request.sessionId as string, request.threadId as string, request.leaseId as string) as T;
			case 'inspectAppendHistory': return await this.core.inspectAppendHistory(ctx, request.sessionId as string, request.threadId as string, request.id as string, request.claimId as string, request.leaseId as string | undefined) as T;
			case 'verifyHistoryAndSettle': return await this.core.verifyHistoryAndSettle(ctx, request.sessionId as string, request.threadId as string, request.id as string, request.claimId as string, request.leaseId as string) as T;
			case 'settleClaim': return await this.core.settleClaim(ctx, request.sessionId as string, request.threadId as string, request.id as string, request.claimId as string, request.leaseId as string | undefined, request.result as never) as T;
			case 'validateHistoryRun': return await this.core.validateHistoryRun(ctx, request.sessionId as string, request.threadId as string, request.runId as string, request.generation as number) as T;
			case 'holdApproval': return await this.core.holdApproval(ctx, request.sessionId as string, request.threadId as string, request.runId as string, request.generation as number, request.approval as never) as T;
			case 'closeRunAndReleaseSteers': return await this.core.closeRunAndReleaseSteers(ctx, request.sessionId as string, request.threadId as string, request.runId as string, request.generation as number, request.authority as never, request.retainApproval === true, request.childGroup as never) as T;
			case 'reconcileDeliveredPendingInputIds': return await this.core.reconcileDeliveredPendingInputIds(ctx, request.sessionId as string, request.delivered as never) as T;
			case 'commitThreadRecord': return await this.core.commitThreadRecord(ctx, request.sessionId as string, request.threadId as string, request.expectedRaw as string | undefined, request.nextRaw as string) as T;
			case 'deleteThreadRecords': return await this.core.deleteThreadRecords(ctx, request.sessionId as string, request.threadId as string, request.evidence as never) as T;
			case 'finalizeThreadDeletion': return await this.core.finalizeThreadDeletion(ctx, request.sessionId as string, request.threadId as string, request.leaseId as string) as T;
			case 'abortThreadDeletion': return await this.core.abortThreadDeletion(ctx, request.sessionId as string, request.threadId as string, request.leaseId as string) as T;
			case 'clearNamespace': return await this.core.clearNamespace(ctx, request.sessionId as string, request.evidence as never) as T;
			case 'finalizeNamespaceClear': return await this.core.finalizeNamespaceClear(ctx, request.sessionId as string, request.leaseId as string) as T;
			case 'abortNamespaceClear': return await this.core.abortNamespaceClear(ctx, request.sessionId as string, request.leaseId as string) as T;
			case 'releaseSession': return await this.core.releaseSession(ctx, request.sessionId as string) as T;
			default: throw new Error(`Pending chat input broker command not found: ${command}`);
		}
	}

	releaseConnection(ctx: string): Promise<void> { return this.core.releaseConnection(ctx); }
}

export const registerPendingChatInputBrokerChannel = (
	server: Pick<IChannelServer<string> & IConnectionHub<string>, 'registerChannel' | 'onDidRemoveConnection'>,
	channel: PendingChatInputBrokerChannel,
	onDisconnectError: (error: unknown) => void,
): IDisposable => {
	server.registerChannel(PENDING_CHAT_INPUT_BROKER_CHANNEL_NAME, channel);
	return server.onDidRemoveConnection(connection => {
		void channel.releaseConnection(connection.ctx).catch(onDisconnectError);
	});
};
