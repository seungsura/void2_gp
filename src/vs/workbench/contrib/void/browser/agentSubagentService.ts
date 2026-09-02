/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { URI } from '../../../../base/common/uri.js';
import { deepClone } from '../../../../base/common/objects.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { AgentRuntimeTurnSnapshot, admitProtectedAgentAuthority, admitSkillResourceContext, assembleProtectedAgentAuthority, createAgentRuntimeTurnSnapshot, isReadSkillResourceToolName, selectExplicitSkills, skillAdvertisement, validateReadSkillResourceToolParams } from '../common/agentSkills.js';
import { AGENT_SUBAGENT_MAX_GROUP_PROVIDER_SENDS, AGENT_SUBAGENT_MAX_MESSAGE_CHARS, AGENT_SUBAGENT_MAX_RESULTS, AGENT_SUBAGENT_MAX_TRACE_EVENTS, AGENT_SUBAGENT_MAX_WAIT_TARGETS, AgentSubagentBudgetView, AgentSubagentDiagnosticsView, AgentSubagentLifecycle, AgentSubagentReceipt, AgentSubagentRunView, AgentSubagentStatus, AgentSubagentToolBroker, AgentSubagentToolBrokerRequest, AgentSubagentToolSnapshot, AgentSubagentTraceDiagnostic, AgentSubagentTraceEvent, AgentSubagentTraceKind, ToolExecutionProfile, isAgentSubagentControlName, isMutationCapableSnapshot, validateAgentSubagentControlParams } from '../common/agentSubagents.js';
import { ILLMMessageService } from '../common/sendLLMMessageService.js';
import { assertCanonicalAgentChildRawUri, assertCanonicalAgentChildUriPath, assertCanonicalReadOnlyChildRawPaths, assertExactReadOnlyChildRawKeys, canonicalAgentChildUri, readOnlyChildToolNames } from '../common/agentSubagents.js';
import { divideToolWaveOutputBudget, planToolBatchWaves } from '../common/toolBatchPlanner.js';
import { IToolsService } from './toolsServiceInterface.js';
import { IConvertToLLMMessageService } from './convertToLLMMessageService.js';
import { IAgentSkillsService } from './agentSkillsService.js';
import { IAgentCustomAgentService } from './agentCustomAgentService.js';
import { applyCustomAgentSkillRules } from '../common/agentCustomAgents.js';
import { CustomAgentCatalog } from '../common/agentCustomAgents.js';
import { ChatMessage } from '../common/chatThreadServiceTypes.js';
import { isEqualOrParent } from '../../../../base/common/resources.js';
import { ModelSelection, providerNames, SettingsOfProvider } from '../common/voidSettingsTypes.js';
import { IVoidSettingsService } from '../common/voidSettingsService.js';
import { getModelCapabilities, getReservedOutputTokenSpace } from '../common/modelCapabilities.js';
import { AgentDelegationLimits, appendAgentInstructionDeveloperInstructions } from '../common/agentInstructions.js';
import { computeMaxReadOutputTokens } from '../common/readFileReliability.js';
import { closeNativeToolBatchForProspectiveAdmission, estimateHistoryTokensForReadBudget, protectedSkillResourceHistoryLength } from './convertToLLMMessageService.js';
import { isABuiltinToolName } from '../common/prompt/prompts.js';
import { sanitizeAssistantDisplayContent } from '../common/assistantMessagePresentation.js';

const DEFAULT_CHILD_SUMMARY_CHARS = 8_000;
const safeProduct = (value: number, factor: number) => value > Math.floor(Number.MAX_SAFE_INTEGER / factor) ? Number.MAX_SAFE_INTEGER : value * factor;
const budgetFor = (limits: AgentDelegationLimits) => { const scale = Math.max(1, Math.ceil(limits.maxAcceptedChildren / 4)); return Object.freeze({ maxProviderSends: Math.min(Number.MAX_SAFE_INTEGER, safeProduct(AGENT_SUBAGENT_MAX_GROUP_PROVIDER_SENDS, scale)), maxResultChars: Math.min(Number.MAX_SAFE_INTEGER, safeProduct(32_000, scale)), maxChildSummaryChars: Math.min(32_000, safeProduct(DEFAULT_CHILD_SUMMARY_CHARS, scale)) }); };

type ChildSchedulerActivity = 'active' | 'waiting_children' | 'ready_to_resume' | 'quiescing';
type ChildRun = { readonly id: string; readonly parentId: string; readonly generation: number; readonly parentRunId: string | undefined; readonly depth: number; readonly remainingDepth: number; readonly budgetLimits: ReturnType<typeof budgetFor>; readonly message: string; readonly snapshot: AgentRuntimeTurnSnapshot; readonly lifecycle: AgentSubagentLifecycle; readonly cancellation: CancellationTokenSource; readonly settingsOfProvider: SettingsOfProvider; readonly admittedRoles: CustomAgentCatalog | undefined; readonly admittedSettingsState: IVoidSettingsService['state']; readonly toolExecutionProfile: ToolExecutionProfile; readonly parentTools?: AgentSubagentToolSnapshot; readonly broker?: AgentSubagentToolBroker; readonly mutationCapable: boolean; brokerRequest?: AgentSubagentToolBrokerRequest; brokerExecute?: Promise<unknown>; brokerCancelPromise?: Promise<void>; brokerCancelled: boolean; released: boolean; capacityReleased: boolean; providerLeaseRelease?: () => void; providerResponseFinish?: () => void; readonly activeDirectInterrupts: Set<() => void>; readonly acceptedAt: number; startedAt?: number; settledAt?: number; readonly role?: { name: string; description: string; revision: string; capabilityProfile: 'read_only' | 'inherit_parent_write' }; requestId?: string; summary: string; resultTruncated: boolean; terminalView?: AgentSubagentRunView; schedulerActive: boolean; schedulerActivity: ChildSchedulerActivity; yielded: boolean; resume?: () => void; runPromise?: Promise<void> };
export type AgentSubagentGroupIoKind = 'read' | 'write';
export type AgentSubagentGroupIoLease = Readonly<{ release(): void }>;
type GroupIoWaiter = { readonly kind: AgentSubagentGroupIoKind; readonly resolve: (lease: AgentSubagentGroupIoLease) => void; cancelled: boolean; listener?: { dispose(): void } };
type GroupIoDrainWaiter = { readonly resolve: (lease: AgentSubagentGroupIoLease) => void; cancelled: boolean; listener?: { dispose(): void } };
type ChildGroup = { readonly parentId: string; readonly generation: number; readonly createdAt: number; readonly limits: AgentDelegationLimits; readonly budgetLimits: ReturnType<typeof budgetFor>; readonly runs: ChildRun[]; readonly admissions: Map<CancellationTokenSource, string | undefined>; cancellation: boolean; accepted: number; providerSends: number; activeProviderSends: number; resultChars: number; retainedResultChars: number; truncatedResultCount: number; traceSequence: number; readonly traceEvents: AgentSubagentTraceEvent[]; droppedTraceEvents: number; admissionChain: Promise<void>; readonly ioQueue: GroupIoWaiter[]; activeIoReads: number; activeIoWriter: boolean };
export const IAgentSubagentService = createDecorator<IAgentSubagentService>('voidAgentSubagentService');
export type AgentSubagentRunChangeEvent = Readonly<
	{ parentId: string; generation: number; id: string; status: AgentSubagentStatus; removed?: false }
	| { parentId: string; generation: number; id: string; removed: true }
	| { parentId: string; generation: number; id: string; coordinationReleased: true }
>;
export type AgentSubagentDiagnosticsChangeEvent = Readonly<{ parentId: string; generation: number }>;
export type AgentSubagentCoordinationRunView = Readonly<{ id: string; generation: number; released: boolean }>;
export type AgentSubagentWaitChild = Readonly<{ id: string; status: AgentSubagentStatus; roleName?: string; roleDescription?: string; usage: null }>;
export type AgentSubagentWaitResult = Readonly<{ id?: string; status?: AgentSubagentStatus; children: readonly AgentSubagentWaitChild[]; receipt?: AgentSubagentReceipt; receipts?: readonly AgentSubagentReceipt[]; budget: AgentSubagentBudgetView; deliverSummary: boolean; timedOut: boolean }>;
export interface IAgentSubagentService {
	readonly _serviceBrand: undefined;
	spawn(parentId: string, message: string, snapshot: AgentRuntimeTurnSnapshot, agentType?: string, admittedRoles?: CustomAgentCatalog, admittedSettingsState?: IVoidSettingsService['state'], admittedSettingsOfProvider?: SettingsOfProvider, generation?: number, parentTools?: AgentSubagentToolSnapshot, broker?: AgentSubagentToolBroker): Promise<{ id: string; status: AgentSubagentStatus }>;
	wait(parentId: string, timeoutMs: number, targets?: readonly string[], generation?: number): Promise<AgentSubagentWaitResult>;
	interrupt(parentId: string, target: string, generation?: number): { id?: string; status: AgentSubagentStatus; receipt?: AgentSubagentReceipt };
	cancelParent(parentId: string): void;
	forgetParent(parentId: string): void;
	/** Same-parent read/write coordinator. Missing groups deliberately yield a no-op lease. */
	acquireGroupIo(parentId: string, generation: number, kind: AgentSubagentGroupIoKind, token?: CancellationToken): Promise<AgentSubagentGroupIoLease>;
	getRunView(parentId: string): AgentSubagentRunView | undefined;
	getRunViews(parentId: string): readonly AgentSubagentRunView[];
	/** Physical child executions remain present through terminal cancellation until all provider/tool/broker I/O is released. */
	getCoordinationRunViews(parentId: string): readonly AgentSubagentCoordinationRunView[];
	getBudgetView(parentId: string): AgentSubagentBudgetView | undefined;
	getDiagnosticsView(parentId: string): AgentSubagentDiagnosticsView | undefined;
	readonly onDidChangeRun: Event<AgentSubagentRunChangeEvent>;
	readonly onDidChangeDiagnostics: Event<AgentSubagentDiagnosticsChangeEvent>;
}

/** Deliberately in-memory: Thread persistence never contains child transcripts or restart work. */
export class AgentSubagentService extends Disposable implements IAgentSubagentService {
	readonly _serviceBrand: undefined;
	private readonly groups = new Map<string, ChildGroup>();
	private readonly coordinationRuns = new Map<string, Set<ChildRun>>();
	/** Active physical I/O survives a forgotten generation until its operation drains. */
	private readonly activeGroupIo = new Map<string, number>();
	/** Parent-only callers have no ChildGroup to queue on, but must still wait for an old drain. */
	private readonly groupIoDrainWaiters = new Map<string, Set<GroupIoDrainWaiter>>();
	/** Kept outside a generation so a forgotten, still-running writer cannot overlap a new generation. */
	private readonly mutationOwners = new Map<string, string>();
	private readonly _onDidChangeRun = this._register(new Emitter<AgentSubagentRunChangeEvent>());
	readonly onDidChangeRun = this._onDidChangeRun.event;
	private readonly _onDidChangeDiagnostics = this._register(new Emitter<AgentSubagentDiagnosticsChangeEvent>());
	readonly onDidChangeDiagnostics = this._onDidChangeDiagnostics.event;

	constructor(@ILLMMessageService private readonly llm: ILLMMessageService, @IToolsService private readonly tools: IToolsService, @IFileService private readonly fileService: IFileService, @IWorkspaceContextService private readonly workspace: IWorkspaceContextService, @IWorkspaceTrustManagementService private readonly trust: IWorkspaceTrustManagementService, @IConvertToLLMMessageService private readonly converter: IConvertToLLMMessageService, @IAgentSkillsService private readonly skills: IAgentSkillsService, @IAgentCustomAgentService private readonly customAgents: IAgentCustomAgentService, @IVoidSettingsService private readonly settings: IVoidSettingsService) { super(); }

	async spawn(parentId: string, message: string, parent: AgentRuntimeTurnSnapshot, agentType?: string, admittedRoles?: CustomAgentCatalog, admittedSettingsState?: IVoidSettingsService['state'], admittedSettingsOfProvider?: SettingsOfProvider, generation = 0, parentTools?: AgentSubagentToolSnapshot, broker?: AgentSubagentToolBroker) {
		return this.spawnWithin(parentId, message, parent, agentType, admittedRoles, admittedSettingsState, admittedSettingsOfProvider, generation, undefined, parentTools, broker);
	}
	private async spawnWithin(parentId: string, message: string, parent: AgentRuntimeTurnSnapshot, agentType: string | undefined, admittedRoles: CustomAgentCatalog | undefined, admittedSettingsState: IVoidSettingsService['state'] | undefined, admittedSettingsOfProvider: SettingsOfProvider | undefined, generation: number, parentRun?: ChildRun, parentTools?: AgentSubagentToolSnapshot, broker?: AgentSubagentToolBroker) {
		if (parent.instructions.config.agentDelegationLimits.maxDepth === 0) throw new Error('agent_child_depth_exhausted');
		if (parent.instructions.config.agentDelegationLimits.maxConcurrentThreadsPerSession > parent.instructions.config.agentDelegationLimits.maxAcceptedChildren) throw new Error('agent_child_concurrency_exceeds_capacity');
		let group = this.groups.get(parentId);
		if (group && group.generation !== generation) { this.forgetParent(parentId); group = undefined; }
		if (!group) { if (parentRun) throw new Error('agent_child_group_missing'); const createdAt = Date.now(); const limits = Object.freeze({ ...parent.instructions.config.agentDelegationLimits }); const budgetLimits = budgetFor(limits); group = { parentId, generation, createdAt, limits, budgetLimits, runs: [], admissions: new Map(), cancellation: false, accepted: 0, providerSends: 0, activeProviderSends: 0, resultChars: 0, retainedResultChars: 0, truncatedResultCount: 0, traceSequence: 0, traceEvents: [], droppedTraceEvents: 0, admissionChain: Promise.resolve(), ioQueue: [], activeIoReads: 0, activeIoWriter: false }; this.groups.set(parentId, group); this.trace(group, 'group_created'); }
		if (group.cancellation) throw new Error('agent_child_cancelled');
		if (parentRun && (parentRun.parentId !== parentId || parentRun.generation !== generation || parentRun.lifecycle.status !== 'running' || parentRun.remainingDepth <= 0 || !group.runs.includes(parentRun))) throw new Error('agent_child_depth_exhausted');
		if (group.accepted + group.admissions.size >= group.limits.maxAcceptedChildren) throw new Error('agent_child_limit_reached');
		if (!parent.model.hasModel) throw new Error('agent_child_model_missing');
		const parentModel = parent.model;
		if (!providerNames.includes(parent.model.providerName as never)) throw new Error('agent_child_provider_invalid');
		if (!parent.ownerProjectRoot || !parent.runCwd || parent.ownerProjectRoot !== parent.runCwd || !this.matchesParent(parent)) throw new Error('agent_child_owner_or_trust_changed');
		const parentOwnerProjectRoot = parent.ownerProjectRoot;
		const settingsOfProvider = admittedSettingsOfProvider ?? this.llm.captureSettingsOfProvider();
		const capturedState = admittedSettingsState ?? deepClone(this.settings.state); // compatibility fallback for direct callers; top-level admission supplies the frozen state
		// Reserve before asynchronous role/Skill work. Chaining makes admission order deterministic.
		const admission = new CancellationTokenSource(); group.admissions.set(admission, parentRun?.id);
		this.trace(group, 'admission_started');
		const admittedGroup = group;
		const admissionWork = async () => { try {
			const catalogAtAdmission = agentType ? admittedRoles : undefined;
			if (admission.token.isCancellationRequested) throw new Error('agent_child_cancelled');
			if (!this.matchesParent(parent)) throw new Error('agent_child_owner_or_trust_changed');
			const role = agentType ? catalogAtAdmission?.agents.find(candidate => candidate.identity === agentType) : undefined;
			if (agentType && !role) throw new Error('custom_agent_not_found');
			const roleModel = role && (role.model || role.modelReasoningEffort) ? this.roleRuntimeModel(parentModel, role.model, role.modelReasoningEffort, capturedState) : parentModel;
			const toolExecutionProfile: ToolExecutionProfile = role?.capabilityProfile === 'inherit_parent_write' ? 'inherited-parent-write-child' : 'read-only-child';
			const effectiveParentTools = parentRun?.parentTools ?? parentTools;
			const effectiveBroker = parentRun?.broker ?? broker;
			if (toolExecutionProfile === 'inherited-parent-write-child' && (!effectiveParentTools || !effectiveBroker || (parentRun && parentRun.toolExecutionProfile !== 'inherited-parent-write-child'))) throw new Error('custom_agent_capability_profile_not_authorized');
			const effectiveCatalog = role ? Object.freeze({ ...parent.catalog, skills: applyCustomAgentSkillRules(parent.catalog.skills, role.skillRules) }) : parent.catalog;
			const explicit = selectExplicitSkills(effectiveCatalog, message);
			if (explicit.diagnostic) throw new Error(explicit.diagnostic.code);
			const bodies = await Promise.all((explicit.skills ?? []).map(async skill => { const read = await this.awaitAdmission(admission, this.skills.readSkillBody(skill.provenance.skillRoot, skill.bodyRevision)); if (admission.token.isCancellationRequested) throw new Error('agent_child_cancelled'); if (!this.matchesParent(parent)) throw new Error('agent_child_owner_or_trust_changed'); if (!read.body || read.diagnostic) throw new Error(read.diagnostic?.code ?? 'skill_body_unreadable'); return { identity: skill.identity, skillRoot: skill.provenance.skillRoot, bodyRevision: skill.bodyRevision, body: read.body }; }));
			if (admission.token.isCancellationRequested || admittedGroup.cancellation || (parentRun && !this.isCurrent(parentRun))) throw new Error('agent_child_cancelled');
			if (!this.matchesParent(parent)) throw new Error('agent_child_owner_or_trust_changed');
			if (role) { const currentCatalog = await this.awaitAdmission(admission, this.customAgents.getCatalog(URI.parse(parentOwnerProjectRoot))); const current = currentCatalog.agents.find(candidate => candidate.identity === role.identity); if (!current || currentCatalog.revision !== catalogAtAdmission!.revision || current.revision !== role.revision) throw new Error('custom_agent_stale'); if (!this.matchesParent(parent)) throw new Error('agent_child_owner_or_trust_changed'); }
			if (admission.token.isCancellationRequested || admittedGroup.cancellation) throw new Error('agent_child_cancelled');
			const snapshot = role ? createAgentRuntimeTurnSnapshot(appendAgentInstructionDeveloperInstructions(parent.instructions, role.developerInstructions), effectiveCatalog, skillAdvertisement(effectiveCatalog, roleModel.contextWindow), bodies, roleModel, parent.workspaceTrustedAtAdmission) : createAgentRuntimeTurnSnapshot(parent.instructions, parent.catalog, skillAdvertisement(parent.catalog, parentModel.contextWindow), bodies, parentModel, parent.workspaceTrustedAtAdmission);
			// Only the inherited profile has the application resource reader. Keep the
			// manifest and the protected-context admission calculation in lockstep with
			// the model-facing profile: a read-only child must neither see nor reserve it.
			admitProtectedAgentAuthority(snapshot, toolExecutionProfile === 'inherited-parent-write-child');
			const run: ChildRun = { id: generateUuid(), parentId, generation, parentRunId: parentRun?.id, depth: parentRun ? parentRun.depth + 1 : 1, remainingDepth: parentRun ? parentRun.remainingDepth - 1 : admittedGroup.limits.maxDepth - 1, budgetLimits: admittedGroup.budgetLimits, message, snapshot, lifecycle: new AgentSubagentLifecycle(), cancellation: new CancellationTokenSource(), settingsOfProvider, admittedRoles, admittedSettingsState: capturedState, toolExecutionProfile, ...(effectiveParentTools ? { parentTools: effectiveParentTools } : {}), ...(effectiveBroker ? { broker: effectiveBroker } : {}), mutationCapable: toolExecutionProfile === 'inherited-parent-write-child' && isMutationCapableSnapshot(effectiveParentTools), brokerCancelled: false, released: false, capacityReleased: false, activeDirectInterrupts: new Set(), acceptedAt: Date.now(), ...(role ? { role: { name: role.name, description: role.description, revision: role.revision, capabilityProfile: role.capabilityProfile } } : {}), summary: '', resultTruncated: false, schedulerActive: false, schedulerActivity: 'ready_to_resume', yielded: false };
			admittedGroup.runs.push(run); admittedGroup.accepted++; admittedGroup.admissions.delete(admission); admission.dispose();
			const coordinated = this.coordinationRuns.get(parentId) ?? new Set<ChildRun>(); coordinated.add(run); this.coordinationRuns.set(parentId, coordinated);
			this.trace(admittedGroup, 'child_queued', run);
			this._onDidChangeRun.fire({ parentId, generation: run.generation, id: run.id, status: run.lifecycle.status });
			this.promote(admittedGroup);
			return { id: run.id, status: run.lifecycle.status };
		} catch (error) { admittedGroup.admissions.delete(admission); admission.dispose(); this.trace(admittedGroup, 'admission_failed', undefined, undefined, this.diagnostic(error)); throw error; } };
		const result = admittedGroup.admissionChain.then(admissionWork, admissionWork);
		admittedGroup.admissionChain = result.then(() => undefined, () => undefined);
		return result;
	}
	private async awaitAdmission<T>(admission: CancellationTokenSource, work: Promise<T>): Promise<T> { if (admission.token.isCancellationRequested) throw new Error('agent_child_cancelled'); let listener: { dispose(): void } | undefined; try { return await Promise.race([work, new Promise<T>((_resolve, reject) => listener = admission.token.onCancellationRequested(() => reject(new Error('agent_child_cancelled'))))]); } finally { listener?.dispose(); } }
	private roleRuntimeModel(parent: Extract<AgentRuntimeTurnSnapshot['model'], { hasModel: true }>, modelName: string | undefined, effort: string | undefined, state: IVoidSettingsService['state']): Omit<Extract<AgentRuntimeTurnSnapshot['model'], { hasModel: true }>, 'fingerprint'> {
		if (!modelName) {
			if (effort) {
				const capabilities = getModelCapabilities(parent.providerName as keyof SettingsOfProvider, parent.modelName, { [parent.providerName]: { [parent.modelName]: parent.selectedModelOverrides } } as never);
				const reasoning = capabilities.reasoningCapabilities; const slider = reasoning && reasoning.reasoningSlider;
				if (!reasoning || !reasoning.supportsReasoning || !slider || slider.type !== 'effort_slider' || !slider.values.includes(effort)) throw new Error('custom_agent_invalid_reasoning_effort');
			}
			return { hasModel: true, providerName: parent.providerName, modelName: parent.modelName, contextWindow: parent.contextWindow, reservedOutputTokens: parent.reservedOutputTokens, modelSelectionOptions: { ...parent.modelSelectionOptions, ...(effort ? { reasoningEnabled: true, reasoningEffort: effort } : {}) }, selectedModelOverrides: parent.selectedModelOverrides };
		}
		const provider = parent.providerName as keyof SettingsOfProvider;
		const providerSettings = state.settingsOfProvider[provider];
		if (!providerSettings?._didFillInProviderSettings || !providerSettings.models.some(item => item.modelName === modelName && !item.isHidden)) throw new Error('custom_agent_model_unavailable');
		const overrides = state.overridesOfModel[provider]?.[modelName] ?? {};
		const capabilities = getModelCapabilities(provider, modelName, state.overridesOfModel);
		if (!['openai-style', 'anthropic-style', 'gemini-style'].includes(capabilities.specialToolFormat ?? '')) throw new Error('custom_agent_model_unsupported_for_agent');
		const options = { ...(state.optionsOfModelSelection.Chat[provider]?.[modelName] ?? {}) };
		if (effort) { const reasoning = capabilities.reasoningCapabilities; const slider = reasoning && reasoning.reasoningSlider; if (!reasoning || !reasoning.supportsReasoning || !slider || slider.type !== 'effort_slider' || !slider.values.includes(effort)) throw new Error('custom_agent_invalid_reasoning_effort'); Object.assign(options, { reasoningEnabled: true, reasoningEffort: effort }); }
		const reserve = getReservedOutputTokenSpace(provider, modelName, { isReasoningEnabled: effort ? true : options.reasoningEnabled ?? true, overridesOfModel: state.overridesOfModel }) ?? 4096;
		return { hasModel: true, providerName: parent.providerName, modelName, contextWindow: capabilities.contextWindow, reservedOutputTokens: Math.max(Math.ceil(capabilities.contextWindow / 2), reserve), modelSelectionOptions: options, selectedModelOverrides: overrides as never };
	}

	private async run(run: ChildRun, message: string): Promise<void> {
		try {
			if (!run.lifecycle.start()) return;
			run.startedAt = Date.now(); const groupAtStart = this.groups.get(run.parentId); if (groupAtStart?.generation === run.generation) this.trace(groupAtStart, 'child_running', run);
			this._onDidChangeRun.fire({ parentId: run.parentId, generation: run.generation, id: run.id, status: run.lifecycle.status });
			const model = run.snapshot.model;
			if (!model.hasModel) { this.settle(run, 'failed', 'Child model is unavailable.'); return; }
			if (!providerNames.includes(model.providerName as never)) { this.settle(run, 'failed', 'Child provider is invalid.'); return; }
			const modelSelection: ModelSelection = { providerName: model.providerName as ModelSelection['providerName'], modelName: model.modelName };
			if (!run.snapshot.ownerProjectRoot || !run.snapshot.runCwd || run.snapshot.ownerProjectRoot !== run.snapshot.runCwd) { this.settle(run, 'failed', 'Child owner is unavailable.'); return; }
			const owner = URI.parse(run.snapshot.ownerProjectRoot);
			const history: ChatMessage[] = [{ role: 'user', content: message, displayContent: message, selections: [], state: { stagingSelections: [], isBeingEdited: false } }];
			for (let turn = 0; !run.cancellation.token.isCancellationRequested; turn++) {
			const prepared = await this.converter.prepareLLMChatMessages({ chatMessages: history, chatMode: 'agent', modelSelection, instructionSnapshot: run.snapshot, toolExecutionProfile: run.toolExecutionProfile, childRoot: owner.toString(), agentDelegationAllowed: run.remainingDepth > 0, frozenToolSnapshot: run.parentTools });
			if (!this.isCurrent(run) || !run.schedulerActive || (run.mutationCapable && this.mutationOwners.get(run.parentId) !== run.id)) { this.settle(run, 'cancelled', 'Child owner or scheduler changed.'); return; }
			const group = this.groups.get(run.parentId); if (!group || group.generation !== run.generation) { this.settle(run, 'cancelled', 'Child group changed.'); return; }
			const releaseProviderSend = this.acquireProviderSend(run, group); if (!releaseProviderSend) { this.settle(run, 'failed', 'Child group provider-send capacity is full.'); return; }
			let response: { text?: string; tool?: { id: string; name: string; rawParams: Record<string, unknown> }; tools?: readonly { id: string; name: string; rawParams: Record<string, unknown> }[]; error?: string };
			try { response = await new Promise<{ text?: string; tools?: readonly { id: string; name: string; rawParams: Record<string, unknown> }[]; error?: string }>(resolve => {
				let resolved = false;
				const finish = (value: { text?: string; tools?: readonly { id: string; name: string; rawParams: Record<string, unknown> }[]; error?: string }) => { if (!resolved) { resolved = true; releaseProviderSend(); resolve(value); } };
				run.providerResponseFinish = () => finish({ error: 'Child cancelled.' });
				try {
					const requestId = this.llm.sendLLMMessage({ messagesType: 'chatMessages', messages: prepared.messages, separateSystemMessage: prepared.separateSystemMessage, chatMode: 'agent', toolExecutionProfile: run.toolExecutionProfile, frozenToolSnapshot: run.parentTools, agentDelegationAllowed: run.remainingDepth > 0, settingsOfProviderOverride: run.settingsOfProvider, modelSelection, modelSelectionOptions: model.modelSelectionOptions as never, overridesOfModel: { [modelSelection.providerName]: { [modelSelection.modelName]: model.selectedModelOverrides } } as never, logging: { loggingName: 'Agent child', loggingExtras: { childId: run.id, turn, depth: run.depth } }, onText: () => {}, onFinalMessage: ({ fullText, toolCalls }) => finish(toolCalls?.length ? { text: fullText, tools: toolCalls.map(tool => ({ id: tool.id, name: tool.name, rawParams: tool.rawParams })) } : { text: fullText }), onError: ({ message: error }) => finish({ error }), onAbort: () => finish({ error: 'Child cancelled.' }) });
					run.requestId = requestId ?? undefined;
					if (!requestId) finish({ error: 'Child provider request was not started.' });
					else if (run.cancellation.token.isCancellationRequested) { this.llm.abort(requestId); finish({ error: 'Child cancelled.' }); }
				} catch (error) { finish({ error: error instanceof Error ? error.message : String(error) }); }
			}); } finally { run.requestId = undefined; run.providerResponseFinish = undefined; releaseProviderSend(); }
			if (!this.isCurrent(run)) { this.settle(run, 'cancelled', 'Child cancelled or owner changed.'); return; }
			if (response.error) { this.settle(run, run.cancellation.token.isCancellationRequested ? 'cancelled' : 'failed', response.error); return; }
			const responseText = sanitizeAssistantDisplayContent(response.text ?? '');
			// The provider object is transport-owned and can be mutated by a late stream
			// callback. Capture each declaration before either history or execution awaits.
			const responseTools = (response.tools ?? []).map(responseTool => Object.freeze({ ...responseTool, rawParams: Object.freeze(deepClone(responseTool.rawParams)) }));
			if (responseTools.some(tool => !tool.id || !tool.name) || new Set(responseTools.map(tool => tool.id)).size !== responseTools.length) {
				this.settle(run, 'failed', 'Child provider returned an invalid or duplicate tool-call batch.');
				return;
			}
			const childBatchId = responseTools.length ? generateUuid() : undefined;
			history.push({ role: 'assistant', displayContent: responseText, reasoning: '', anthropicReasoning: null, ...(childBatchId ? { toolBatch: { version: 1 as const, batchId: childBatchId, calls: responseTools.map(tool => ({ ...tool, isDone: true, doneParams: [] })) } } : {}) });
			if (!responseTools.length) { this.settle(run, 'completed', responseText.slice(0, this.groupBudget(run).maxChildSummaryChars)); return; }
			const childPlan = planToolBatchWaves('child', responseTools.map((tool, ordinal) => ({ ordinal, name: tool.name })));
			// Barriers preserve provider order. Direct safe reads use the exact-five
			// planner wave and append their terminal rows only after the whole wave drains.
			for (let batchOrdinal = 0; batchOrdinal < responseTools.length; batchOrdinal++) {
			const responseTool = responseTools[batchOrdinal];
			const batchRef = { batchId: childBatchId!, batchOrdinal };
			// Each declared call owns its immutable response record. Reusing response.tool
			// races a later streamed/provider mutation against this child receipt.
			const tool = responseTool;
			if (isAgentSubagentControlName(tool.name)) {
				try {
					const control = validateAgentSubagentControlParams(tool.name, tool.rawParams);
					let result: object;
					if (control.name === 'spawn_agent') result = await this.spawnWithin(run.parentId, control.message, run.snapshot, control.agentType, run.admittedRoles, run.admittedSettingsState, run.settingsOfProvider, run.generation, run, run.parentTools, run.broker);
					else if (control.name === 'wait_agent') {
						// Validate direct targets before yielding. The timer and receipt settle while
						// this run is not consuming a scheduler slot; only the next provider turn
						// waits for reacquisition.
						this.assertWaitTargets(run.parentId, run.id, control.targets, run.generation);
						await this.yieldForChildren(run);
						result = await this.waitFor(run.parentId, run.id, control.timeoutMs, control.targets, run.generation);
						// Timeout/receipt completion is observable before this parent competes
						// for a scheduler (and possible mutation) lease again.
						this.setSchedulerActivity(run, false, 'ready_to_resume');
						history.push({ role: 'tool', type: 'success', content: JSON.stringify(result), id: tool.id, rawParams: tool.rawParams, mcpServerName: undefined, name: tool.name, params: tool.rawParams, result: result as never, ...batchRef });
						await this.reacquire(run);
						if (!this.isCurrent(run)) { this.settle(run, 'cancelled', 'Child cancelled or owner changed.'); return; }
						continue;
					}
					else result = this.interruptFor(run.parentId, run.id, control.target, run.generation);
					if (!this.isCurrent(run)) { this.settle(run, 'cancelled', 'Child cancelled or owner changed.'); return; }
					history.push({ role: 'tool', type: 'success', content: JSON.stringify(result), id: tool.id, rawParams: tool.rawParams, mcpServerName: undefined, name: tool.name, params: tool.rawParams, result: result as never, ...batchRef });
				} catch (error) {
					const content = `The child-control call failed: ${error instanceof Error ? error.message : String(error)}`;
					history.push({ role: 'tool', type: 'tool_error', content, id: tool.id, rawParams: tool.rawParams, mcpServerName: undefined, name: tool.name, params: tool.rawParams, result: content, ...batchRef });
				}
				continue;
			}
			if (run.toolExecutionProfile === 'inherited-parent-write-child' && !(readOnlyChildToolNames as readonly string[]).includes(tool.name)) {
				const capturedEntries = run.parentTools?.tools.filter(entry => entry.name === tool.name) ?? [];
				const captured = capturedEntries.length === 1 ? capturedEntries[0] : undefined;
				if (!captured || !run.broker) { const content = !captured ? 'The requested tool is absent from this child\'s frozen parent capability snapshot.' : 'The inherited parent tool broker is unavailable.'; history.push({ role: 'tool', type: 'tool_error', content, id: tool.id, rawParams: tool.rawParams, mcpServerName: captured?.mcpServerName, name: tool.name, params: tool.rawParams, result: content, ...batchRef }); continue; }
				if (isReadSkillResourceToolName(tool.name)) {
					try {
						const params = validateReadSkillResourceToolParams(tool.rawParams); const selection = run.snapshot.selected.find(item => item.identity === params.skill);
						if (!selection) throw new Error('skill_not_selected');
						const maxReadOutputTokens = run.snapshot.model.hasModel ? computeMaxReadOutputTokens(run.snapshot.model.contextWindow, run.snapshot.model.reservedOutputTokens, estimateHistoryTokensForReadBudget(history)) : 0;
						const exactInputBudgetChars = run.snapshot.model.hasModel ? Math.max(0, run.snapshot.model.contextWindow - run.snapshot.model.reservedOutputTokens) * 4 : 0;
						const protectedCharsRemaining = Math.max(0, exactInputBudgetChars - assembleProtectedAgentAuthority(run.snapshot, true).length - protectedSkillResourceHistoryLength(history));
						const maxResourceChars = Math.min(maxReadOutputTokens * 4, protectedCharsRemaining);
						const maxResourceBytes = maxResourceChars > 0 ? Math.min(Number.MAX_SAFE_INTEGER, maxResourceChars * 3 + 3) : 0;
						// Resource bytes are local read I/O, but formatting/prospective conversion
						// must not retain the reader lease. A cancelled queued acquisition returns
						// a no-op lease, so fence again before the physical read starts.
						const resourceLease = await this.acquireGroupIo(run.parentId, run.generation, 'read', run.cancellation.token);
						let read: Awaited<ReturnType<IAgentSkillsService['readSkillResource']>>;
						try {
							if (!this.isCurrent(run)) throw new Error('agent_child_cancelled');
							read = await this.skills.readSkillResource(selection, params.resourcePath, { maxResourceBytes, token: run.cancellation.token });
							if (!this.isCurrent(run)) throw new Error('agent_child_cancelled');
						} finally { resourceLease.release(); }
						if (read.body === undefined) throw new Error(read.diagnostic?.code ?? 'skill_resource_unreadable');
						const content = admitSkillResourceContext(read.body, maxReadOutputTokens);
						const success: ChatMessage & { role: 'tool' } = { role: 'tool', type: 'success', content, id: tool.id, rawParams: tool.rawParams, mcpServerName: undefined, name: tool.name, params: tool.rawParams, result: content as never, ...batchRef };
						try {
							const prospective = closeNativeToolBatchForProspectiveAdmission([...history, success], batchRef);
							await this.converter.prepareLLMChatMessages({ chatMessages: prospective, chatMode: 'agent', modelSelection, instructionSnapshot: run.snapshot, toolExecutionProfile: run.toolExecutionProfile, childRoot: owner.toString(), agentDelegationAllowed: run.remainingDepth > 0, frozenToolSnapshot: run.parentTools });
						} catch { throw new Error('skill_resource_context_admission_failed'); }
						if (!this.isCurrent(run)) { this.settle(run, 'cancelled', 'Child cancelled or owner changed.'); return; }
						history.push(success);
					} catch (error) { if (!this.isCurrent(run)) { this.settle(run, 'cancelled', 'Child cancelled or owner changed.'); return; } const content = error instanceof Error ? error.message : 'skill_resource_unreadable'; history.push({ role: 'tool', type: 'tool_error', content, id: tool.id, rawParams: tool.rawParams, mcpServerName: undefined, name: tool.name, params: tool.rawParams, result: content, ...batchRef }); }
					continue;
				}
				const maxReadOutputTokens = run.snapshot.model.hasModel ? computeMaxReadOutputTokens(run.snapshot.model.contextWindow, run.snapshot.model.reservedOutputTokens, estimateHistoryTokensForReadBudget(history)) : 0;
				const request: AgentSubagentToolBrokerRequest = Object.freeze({ parentId: run.parentId, generation: run.generation, childId: run.id, batchId: batchRef.batchId, batchOrdinal: batchRef.batchOrdinal, toolId: tool.id, name: tool.name, tool: captured, rawParams: Object.freeze({ ...tool.rawParams }), snapshotRevision: run.parentTools!.revision, maxReadOutputTokens, cancellationToken: run.cancellation.token });
				run.brokerRequest = request;
				try {
					const execute = run.broker.execute(request); run.brokerExecute = execute;
					const brokered = await execute;
					run.brokerExecute = undefined;
					if (!this.isCurrent(run) || run.brokerRequest !== request) { this.settle(run, 'cancelled', 'Child cancelled or owner changed.'); return; }
					run.brokerRequest = undefined;
					if (brokered.ok) history.push({ role: 'tool', type: 'success', content: brokered.content, id: tool.id, rawParams: tool.rawParams, mcpServerName: captured.mcpServerName, name: tool.name, params: tool.rawParams, result: brokered.result as never, ...batchRef });
					else history.push({ role: 'tool', type: 'tool_error', content: brokered.error, id: tool.id, rawParams: tool.rawParams, mcpServerName: captured.mcpServerName, name: tool.name, params: tool.rawParams, result: brokered.error, ...batchRef });
				} catch { run.brokerExecute = undefined; if (!this.isCurrent(run) || run.brokerRequest !== request) { this.settle(run, 'cancelled', 'Child cancelled or owner changed.'); return; } run.brokerRequest = undefined; const content = 'execution_failed'; history.push({ role: 'tool', type: 'tool_error', content, id: tool.id, rawParams: tool.rawParams, mcpServerName: captured.mcpServerName, name: tool.name, params: tool.rawParams, result: content, ...batchRef }); }
				continue;
			}
			const safeWave = childPlan.find(wave => wave.kind === 'safe_read' && wave.calls[0]?.ordinal === batchOrdinal);
			if (safeWave) {
				const members = safeWave.calls.map(member => responseTools[member.ordinal]);
				const rows = await this.runChildSafeReadWave(run, owner, history, childBatchId!, members, safeWave.calls.map(member => member.ordinal));
				if (!this.isCurrent(run)) { this.settle(run, 'cancelled', 'Child cancelled or owner changed.'); return; }
				history.push(...rows);
				batchOrdinal += members.length - 1;
				continue;
			}
			if (!(readOnlyChildToolNames as readonly string[]).includes(tool.name) || !Object.prototype.hasOwnProperty.call(this.tools.validateParams, tool.name)) { history.push({ role: 'tool', type: 'tool_error', content: 'The requested tool is not authorized for this read-only child.', id: tool.id, rawParams: tool.rawParams, mcpServerName: undefined, name: tool.name, params: tool.rawParams, result: 'The requested tool is not authorized for this read-only child.', ...batchRef }); continue; }
			try {
				if (!this.isCurrent(run)) throw new Error('agent_child_owner_or_trust_changed');
				if (run.toolExecutionProfile === 'inherited-parent-write-child') {
					// A same-name MCP or duplicate frozen entry must not fall through to the
					// local read registry: inherited authority is the complete snapshot.
					const exact = run.parentTools?.tools.filter(entry => entry.name === tool.name) ?? [];
					if (exact.length !== 1 || exact[0].kind !== 'builtin' || exact[0].mcpServerName || !(readOnlyChildToolNames as readonly string[]).includes(tool.name) || !isABuiltinToolName(tool.name)) throw new Error('tool_stale');
				}
				assertExactReadOnlyChildRawKeys(tool.name, tool.rawParams);
				assertCanonicalReadOnlyChildRawPaths(tool.name, tool.rawParams);
				const params = (this.tools.validateParams as Record<string, (raw: Record<string, unknown>) => unknown>)[tool.name](tool.rawParams);
				await this.assertContainedRead(params as Record<string, unknown>, owner);
				if (!this.isCurrent(run)) throw new Error('agent_child_owner_or_trust_changed');
				const maxReadOutputTokens = run.snapshot.model.hasModel ? computeMaxReadOutputTokens(run.snapshot.model.contextWindow, run.snapshot.model.reservedOutputTokens, estimateHistoryTokensForReadBudget(history)) : 0;
				const toolContext = { ownerThreadId: run.id, maxReadOutputTokens, childId: run.id, ownerRoot: owner, cancellationToken: run.cancellation.token, maxResults: AGENT_SUBAGENT_MAX_RESULTS, maxFileSize: 1024 * 1024 };
				const call = await (this.tools.callTool as Record<string, (params: unknown, context?: unknown) => Promise<{ result: Promise<unknown> }>>)[tool.name](params, toolContext);
				const result = await call.result;
				if (!this.isCurrent(run)) throw new Error('agent_child_owner_or_trust_changed');
				await this.assertContainedRead(params as Record<string, unknown>, owner);
				await this.assertContainedSearchResults(tool.name, result, owner);
				if (!this.isCurrent(run)) throw new Error('agent_child_owner_or_trust_changed');
				const rawPrintable = (this.tools.stringOfResult as Record<string, (params: unknown, result: unknown, context?: unknown) => string>)[tool.name](params, result, toolContext); const maxPrintableChars = maxReadOutputTokens * 4; const marker = '\n[child tool output truncated]'; const printable = rawPrintable.length <= maxPrintableChars ? rawPrintable : `${rawPrintable.slice(0, maxPrintableChars - marker.length)}${marker}`;
				history.push({ role: 'tool', type: 'success', content: printable, id: tool.id, rawParams: tool.rawParams, mcpServerName: undefined, name: tool.name, params: params as never, result: result as never, ...batchRef });
			} catch (error) { if (!this.isCurrent(run)) { this.settle(run, 'cancelled', 'Child cancelled or owner changed.'); return; } const content = `The read-only tool call failed: ${error instanceof Error ? error.message : String(error)}`; history.push({ role: 'tool', type: 'tool_error', content, id: tool.id, rawParams: tool.rawParams, mcpServerName: undefined, name: tool.name, params: tool.rawParams, result: content, ...batchRef }); }
			}
			}
			if (run.cancellation.token.isCancellationRequested) this.settle(run, 'cancelled', 'Child cancelled.');
		} catch (error) {
			this.settleRunFailure(run, error);
		} finally {
			this.releaseExecution(run);
		}
	}
	private settleRunFailure(run: ChildRun, error: unknown): void { const cancelled = run.lifecycle.status === 'cancelled' || run.cancellation.token.isCancellationRequested; const detail = error instanceof Error ? error.message : String(error); this.settle(run, cancelled ? 'cancelled' : 'failed', cancelled ? 'Child cancelled.' : `Child failed: ${detail}`); }
	private async runChildSafeReadWave(run: ChildRun, owner: URI, history: readonly ChatMessage[], batchId: string, tools: readonly Readonly<{ id: string; name: string; rawParams: Record<string, unknown> }>[], ordinals: readonly number[]): Promise<ChatMessage[]> {
		const total = run.snapshot.model.hasModel ? computeMaxReadOutputTokens(run.snapshot.model.contextWindow, run.snapshot.model.reservedOutputTokens, estimateHistoryTokensForReadBudget(history)) : 0;
		const budgets = divideToolWaveOutputBudget(total, tools.length);
		type Prepared = { tool: Readonly<{ id: string; name: string; rawParams: Record<string, unknown> }>; ordinal: number; params: unknown; budget: number };
		const prepared: Prepared[] = []; const rows: Array<{ ordinal: number; row: ChatMessage }> = [];
		for (let index = 0; index < tools.length; index++) {
			const tool = tools[index]; const ordinal = ordinals[index]; const batchRef = { batchId, batchOrdinal: ordinal };
			try {
				if (!this.isCurrent(run)) throw new Error('agent_child_owner_or_trust_changed');
				if (run.toolExecutionProfile === 'inherited-parent-write-child') { const exact = run.parentTools?.tools.filter(entry => entry.name === tool.name) ?? []; if (exact.length !== 1 || exact[0].kind !== 'builtin' || exact[0].mcpServerName || !isABuiltinToolName(tool.name)) throw new Error('tool_stale'); }
				assertExactReadOnlyChildRawKeys(tool.name, tool.rawParams); assertCanonicalReadOnlyChildRawPaths(tool.name, tool.rawParams);
				const params = (this.tools.validateParams as Record<string, (raw: Record<string, unknown>) => unknown>)[tool.name](tool.rawParams);
				await this.assertContainedRead(params as Record<string, unknown>, owner); prepared.push({ tool, ordinal, params, budget: budgets[index] ?? 0 });
			} catch (error) { const content = `The read-only tool call failed: ${error instanceof Error ? error.message : String(error)}`; rows.push({ ordinal, row: { role: 'tool', type: 'tool_error', content, id: tool.id, rawParams: tool.rawParams, mcpServerName: undefined, name: tool.name, params: tool.rawParams, result: content, ...batchRef } }); }
		}
		const completed = await Promise.all(prepared.map(async item => {
			const tool = item.tool; const batchRef = { batchId, batchOrdinal: item.ordinal };
			try {
				const lease = await this.acquireGroupIo(run.parentId, run.generation, 'read', run.cancellation.token);
				try {
					if (!this.isCurrent(run)) throw new Error('agent_child_cancelled');
					const context = { ownerThreadId: run.id, maxReadOutputTokens: item.budget, childId: run.id, ownerRoot: owner, cancellationToken: run.cancellation.token, maxResults: AGENT_SUBAGENT_MAX_RESULTS, maxFileSize: 1024 * 1024 };
					const call = await (this.tools.callTool as Record<string, (params: unknown, context?: unknown) => Promise<{ result: Promise<unknown>; interruptTool?: () => void }>>)[tool.name](item.params, context);
					// `callTool` setup itself can race Stop. Its returned operation has already
					// started, so interrupt and drain it before this wave can settle or release
					// its I/O lease; never publish it as a normal active child handle.
					if (!this.isCurrent(run) || run.cancellation.token.isCancellationRequested) { try { call.interruptTool?.(); } catch { } try { await call.result; } catch { } throw new Error('agent_child_cancelled'); }
					const interrupt = call.interruptTool; if (interrupt) run.activeDirectInterrupts.add(interrupt);
					try {
						const result = await call.result; if (!this.isCurrent(run)) throw new Error('agent_child_cancelled');
						await this.assertContainedRead(item.params as Record<string, unknown>, owner); await this.assertContainedSearchResults(tool.name, result, owner);
						const raw = (this.tools.stringOfResult as Record<string, (params: unknown, result: unknown, context?: unknown) => string>)[tool.name](item.params, result, context); const limit = Math.max(0, item.budget) * 4; const marker = '\n[child tool output truncated]'; const content = raw.length <= limit ? raw : limit === 0 ? '' : limit <= marker.length ? marker.slice(0, limit) : `${raw.slice(0, limit - marker.length)}${marker}`;
						return { ordinal: item.ordinal, row: { role: 'tool', type: 'success', content, id: tool.id, rawParams: tool.rawParams, mcpServerName: undefined, name: tool.name, params: item.params as never, result: result as never, ...batchRef } as ChatMessage };
					} finally { if (interrupt) run.activeDirectInterrupts.delete(interrupt); }
				} finally { lease.release(); }
			} catch (error) { const content = `The read-only tool call failed: ${error instanceof Error ? error.message : String(error)}`; return { ordinal: item.ordinal, row: { role: 'tool', type: 'tool_error', content, id: tool.id, rawParams: tool.rawParams, mcpServerName: undefined, name: tool.name, params: tool.rawParams, result: content, ...batchRef } as ChatMessage }; }
		}));
		rows.push(...completed); return rows.sort((a, b) => a.ordinal - b.ordinal).map(item => item.row);
	}
	private matchesParent(snapshot: AgentRuntimeTurnSnapshot): boolean { return this.workspace.getWorkspace().folders[0]?.uri.toString() === snapshot.ownerProjectRoot && this.trust.isWorkspaceTrusted() === snapshot.workspaceTrustedAtAdmission; }
	private isCurrent(run: ChildRun): boolean { if (run.terminalView) return false; const group = this.groups.get(run.parentId); return run.lifecycle.status === 'running' && !run.cancellation.token.isCancellationRequested && !!group && group.generation === run.generation && group.runs.includes(run) && !group.cancellation && this.matchesParent(run.snapshot); }
	/** A terminal child can still hold an external broker tombstone, but never a scheduler slot. */
	private activeCount(group: ChildGroup): number { return group.runs.filter(run => run.schedulerActive && (run.lifecycle.status === 'queued' || run.lifecycle.status === 'running')).length; }
	private mayAcquireMutation(run: ChildRun): boolean { return !run.mutationCapable || !this.mutationOwners.has(run.parentId) || this.mutationOwners.get(run.parentId) === run.id; }
	/** Scheduler activity is observable independently from lifecycle status. */
	private setSchedulerActivity(run: ChildRun, schedulerActive: boolean, schedulerActivity: ChildSchedulerActivity, emit = true): void {
		const changed = run.schedulerActive !== schedulerActive || run.schedulerActivity !== schedulerActivity;
		run.schedulerActive = schedulerActive;
		run.schedulerActivity = schedulerActivity;
		if (!changed || !emit) return;
		this._onDidChangeRun.fire({ parentId: run.parentId, generation: run.generation, id: run.id, status: run.lifecycle.status });
		const group = this.groups.get(run.parentId);
		if (group?.generation === run.generation) this._onDidChangeDiagnostics.fire({ parentId: run.parentId, generation: group.generation });
	}
	private activate(run: ChildRun): boolean { if (!this.mayAcquireMutation(run)) return false; if (run.mutationCapable) this.mutationOwners.set(run.parentId, run.id); this.setSchedulerActivity(run, true, 'active'); run.yielded = false; return true; }
	private promote(group: ChildGroup): void {
		if (group.cancellation) return;
		while (this.activeCount(group) < group.limits.maxConcurrentThreadsPerSession) {
			const next = group.runs.find(run => (run.lifecycle.status === 'queued' || run.lifecycle.status === 'running' && run.yielded && !!run.resume) && !run.schedulerActive && this.mayAcquireMutation(run));
			if (!next || !this.activate(next)) return;
			if (next.lifecycle.status === 'queued') next.runPromise = Promise.resolve().then(() => this.run(next, next.message)).catch(error => this.settleRunFailure(next, error));
			else { const resume = next.resume; next.resume = undefined; resume?.(); }
		}
	}
	private async yieldForChildren(run: ChildRun): Promise<void> {
		if (!run.schedulerActive || run.requestId || run.brokerRequest) throw new Error('agent_child_wait_not_quiescent');
		this.setSchedulerActivity(run, false, 'waiting_children'); run.yielded = true;
		if (this.mutationOwners.get(run.parentId) === run.id) this.mutationOwners.delete(run.parentId);
		const group = this.groups.get(run.parentId); if (group) this.promote(group);
	}
	private async reacquire(run: ChildRun): Promise<void> {
		if (!this.isCurrent(run)) throw new Error('agent_child_cancelled');
		if (run.schedulerActive) return;
		await new Promise<void>((resolve, reject) => {
			let listener: { dispose(): void } | undefined;
			run.resume = () => { listener?.dispose(); resolve(); };
			listener = run.cancellation.token.onCancellationRequested(() => { listener?.dispose(); reject(new Error('agent_child_cancelled')); });
			const group = this.groups.get(run.parentId); if (!group) { listener.dispose(); reject(new Error('agent_child_cancelled')); return; }
			this.promote(group);
		});
		if (!this.isCurrent(run) || !run.schedulerActive) throw new Error('agent_child_cancelled');
	}
	private releaseExecution(run: ChildRun): void {
		if (run.released) return;
		// A terminal writer is intentionally not shown as Running, but its mutation
		// tombstone remains until the parent broker has acknowledged cancellation.
		if (run.brokerCancelPromise) { void run.brokerCancelPromise.then(() => this.releaseExecution(run), () => { /* fail closed: retain the tombstone */ }); return; }
		run.released = true; this.setSchedulerActivity(run, false, 'quiescing', false); run.yielded = false; run.resume = undefined;
		if (this.mutationOwners.get(run.parentId) === run.id) this.mutationOwners.delete(run.parentId);
		run.cancellation.dispose();
		if (run.lifecycle.status !== 'queued' && run.lifecycle.status !== 'running') this.compactTerminalRun(run);
		const coordinated = this.coordinationRuns.get(run.parentId); coordinated?.delete(run); if (coordinated?.size === 0) this.coordinationRuns.delete(run.parentId);
		this._onDidChangeRun.fire({ parentId: run.parentId, generation: run.generation, id: run.id, coordinationReleased: true });
		const diagnosticsGroup = this.groups.get(run.parentId); if (diagnosticsGroup?.generation === run.generation) this._onDidChangeDiagnostics.fire({ parentId: run.parentId, generation: diagnosticsGroup.generation });
		const group = this.groups.get(run.parentId); if (group) this.promote(group);
	}
	private compactTerminalRun(run: ChildRun): void {
		if (!run.terminalView) return;
		for (const key of ['message', 'snapshot', 'settingsOfProvider', 'admittedRoles', 'admittedSettingsState', 'parentTools', 'broker', 'brokerRequest', 'brokerExecute', 'runPromise'] as const) Reflect.deleteProperty(run as object, key);
	}
	private cancelBroker(run: ChildRun): void {
		if (!run.brokerRequest || run.brokerCancelled) return;
		run.brokerCancelled = true;
		try {
			const acknowledgement = run.broker!.cancel(run.brokerRequest);
			run.brokerCancelPromise = acknowledgement.then(() => {
				run.brokerCancelPromise = undefined;
				// The broker acknowledgement is the authoritative external quiescence
				// boundary: execute may never settle after cancellation.
				this.releaseExecution(run);
			}, () => { /* fail closed: retain the mutation tombstone */ return new Promise<void>(() => { }); });
		} catch { run.brokerCancelPromise = new Promise<void>(() => { }); }
	}
	/** One provider request owns one lease. Terminal child capacity is separate from this live occupancy. */
	private acquireProviderSend(run: ChildRun, group: ChildGroup): (() => void) | undefined {
		if (group.activeProviderSends >= group.budgetLimits.maxProviderSends) return undefined;
		let released = false;
		group.providerSends++;
		group.activeProviderSends++;
		this.trace(group, 'provider_send', run);
		const release = () => {
			if (released) return;
			released = true;
			if (run.providerLeaseRelease === release) run.providerLeaseRelease = undefined;
			group.activeProviderSends = Math.max(0, group.activeProviderSends - 1);
			this._onDidChangeDiagnostics.fire({ parentId: group.parentId, generation: group.generation });
		};
		run.providerLeaseRelease = release;
		return release;
	}
	private groupBudget(run: ChildRun) { return this.groups.get(run.parentId)?.budgetLimits ?? run.budgetLimits; }
	private settle(run: ChildRun, status: Exclude<AgentSubagentStatus, 'queued' | 'running'>, summary: string): boolean {
		const group = this.groups.get(run.parentId);
		// The terminal view has historically retained the scaled per-child summary
		// ceiling (up to 32k). Receipts remain independently capped at 8k for the
		// parent/model boundary; aggregate retention applies to the terminal view.
		const terminalSummary = summary.slice(0, group?.budgetLimits.maxChildSummaryChars ?? DEFAULT_CHILD_SUMMARY_CHARS);
		let retainedSummary = terminalSummary;
		let resultTruncated = false;
		if (group?.generation === run.generation) {
			const available = Math.max(0, group.budgetLimits.maxResultChars - group.retainedResultChars);
			if (retainedSummary.length > available) {
				retainedSummary = retainedSummary.slice(0, available);
				resultTruncated = true;
			}
		}
		const settled = run.lifecycle.settle(status, run.id, retainedSummary.slice(0, AGENT_SUBAGENT_MAX_MESSAGE_CHARS), resultTruncated);
		if (!settled) return false;
		this.setSchedulerActivity(run, false, 'quiescing', false);
		this.cancelBroker(run);
		run.settledAt = Date.now();
		if (group?.generation === run.generation) {
			group.resultChars = Math.min(Number.MAX_SAFE_INTEGER, group.resultChars + terminalSummary.length);
			group.retainedResultChars = Math.min(Number.MAX_SAFE_INTEGER, group.retainedResultChars + retainedSummary.length);
			if (resultTruncated) group.truncatedResultCount = Math.min(Number.MAX_SAFE_INTEGER, group.truncatedResultCount + 1);
			if (!run.capacityReleased) {
				run.capacityReleased = true;
				group.accepted = Math.max(0, group.accepted - 1);
			}
			this.trace(group, status === 'completed' ? 'child_completed' : status === 'failed' ? 'child_failed' : 'child_cancelled', run, status, this.terminalDiagnostic(status, summary, resultTruncated));
		}
		run.summary = retainedSummary;
		run.resultTruncated = resultTruncated;
		run.terminalView = this.createRunView(run);
		this.tools.invalidateReadReceipts(run.id);
		this._onDidChangeRun.fire({ parentId: run.parentId, generation: run.generation, id: run.id, status });
		if (!run.runPromise) this.releaseExecution(run);
		if (group?.generation === run.generation) this.promote(group);
		return true;
	}
	private trace(group: ChildGroup, kind: AgentSubagentTraceKind, run?: ChildRun, status?: Exclude<AgentSubagentStatus, 'queued' | 'running'>, diagnostic?: AgentSubagentTraceDiagnostic): void {
		const timestamp = Date.now(); const budget = this.traceBudget(group); const event: AgentSubagentTraceEvent = Object.freeze({ sequence: ++group.traceSequence, parentId: group.parentId, generation: group.generation, ...(run ? { childId: run.id } : {}), kind, timestamp, elapsedMs: Math.max(0, timestamp - group.createdAt), ...(status ? { status } : {}), ...(diagnostic ? { diagnostic } : {}), budget: Object.freeze(budget) });
		if (group.traceEvents.length >= AGENT_SUBAGENT_MAX_TRACE_EVENTS) group.droppedTraceEvents++; else group.traceEvents.push(event);
		this._onDidChangeDiagnostics.fire({ parentId: group.parentId, generation: group.generation });
	}
	private traceBudget(group: ChildGroup) { return { accepted: group.accepted, running: this.activeCount(group), queued: group.runs.filter(run => run.lifecycle.status === 'queued').length, providerSends: group.providerSends, resultChars: group.resultChars }; }
	private diagnostic(error: unknown): AgentSubagentTraceDiagnostic { const code = error instanceof Error ? error.message : ''; if (code.includes('cancel')) return 'cancelled'; if (code.includes('model_missing')) return 'model_missing'; if (code.includes('provider_invalid')) return 'provider_invalid'; if (code.includes('owner') || code.includes('trust')) return 'owner_changed'; if (code.includes('role') || code.includes('custom_agent')) return code.includes('stale') ? 'role_stale' : 'role_not_found'; if (code.includes('skill')) return 'skill_unavailable'; if (code.includes('budget') || code.includes('limit')) return 'budget_exhausted'; if (code.includes('provider')) return 'provider_error'; return 'unknown'; }
	private terminalDiagnostic(status: Exclude<AgentSubagentStatus, 'queued' | 'running'>, summary: string, resultTruncated = false): AgentSubagentTraceDiagnostic | undefined { if (status === 'cancelled') return 'cancelled'; if (resultTruncated) return 'result_retention_truncated'; if (status === 'completed') return undefined; if (summary.includes('provider-send capacity')) return 'budget_exhausted'; if (summary.includes('timeout')) return 'timeout'; if (summary.includes('provider')) return 'provider_error'; return 'unknown'; }
	private async assertContainedRead(params: Record<string, unknown>, owner: URI): Promise<void> {
		const raw = params.uri ?? params.searchInFolder;
		if (!raw) return;
		await this.assertContainedUri(raw as URI, owner);
	}
	private async assertContainedSearchResults(toolName: string, result: unknown, owner: URI): Promise<void> {
		if (toolName === 'search_in_file') {
			const lines = result && typeof result === 'object' && Array.isArray((result as { lines?: unknown }).lines) ? (result as { lines: unknown[] }).lines : undefined;
			if (!lines || lines.length > AGENT_SUBAGENT_MAX_RESULTS || lines.some(line => !Number.isSafeInteger(line) || (line as number) < 1)) throw new Error('agent_child_search_result_invalid');
			return;
		}
		if (toolName !== 'search_pathnames_only' && toolName !== 'search_for_files') return;
		const uris = result && typeof result === 'object' && Array.isArray((result as { uris?: unknown }).uris) ? (result as { uris: unknown[] }).uris : undefined;
		if (!uris || uris.length > AGENT_SUBAGENT_MAX_RESULTS) throw new Error('agent_child_search_result_invalid');
		for (const uri of uris) {
			if (!(uri instanceof URI)) throw new Error('agent_child_search_result_invalid');
			await this.assertContainedUri(uri, owner);
		}
	}
	private async assertContainedUri(uri: URI, owner: URI): Promise<void> {
		const canonicalOwner = canonicalAgentChildUri(owner); const canonicalUri = canonicalAgentChildUri(uri);
		assertCanonicalAgentChildRawUri(canonicalOwner.toString()); assertCanonicalAgentChildUriPath(canonicalOwner.path); assertCanonicalAgentChildRawUri(canonicalUri.toString()); assertCanonicalAgentChildUriPath(canonicalUri.path);
		if (canonicalUri.scheme !== canonicalOwner.scheme || canonicalUri.authority !== canonicalOwner.authority || !isEqualOrParent(canonicalUri, canonicalOwner)) throw new Error('agent_child_path_outside_owner');
		if ((await this.fileService.resolve(canonicalOwner)).isSymbolicLink) throw new Error('agent_child_reparse_point');
		const relative = canonicalUri.path.slice(canonicalOwner.path.length).split('/').filter(Boolean);
		let current = canonicalOwner;
		for (const segment of relative) {
			current = URI.joinPath(current, segment);
			const stat = await this.fileService.resolve(current);
			if (stat.isSymbolicLink) throw new Error('agent_child_reparse_point');
		}
		const after = await this.fileService.resolve(canonicalUri);
		if (after.isSymbolicLink) throw new Error('agent_child_reparse_point');
	}
	async acquireGroupIo(parentId: string, generation: number, kind: AgentSubagentGroupIoKind, token?: CancellationToken): Promise<AgentSubagentGroupIoLease> {
		const group = this.groups.get(parentId);
		// A parent can safely use this API before it has spawned a child.  Do not create
		// a group merely to serialize that parent-only operation.
		if (!group || group.generation !== generation || group.cancellation) return this.waitForGroupIoDrain(parentId, token);
		if (token?.isCancellationRequested) return this.noopIoLease;
		return new Promise<AgentSubagentGroupIoLease>(resolve => {
			const waiter: GroupIoWaiter = { kind, resolve, cancelled: false };
			if (token) waiter.listener = token.onCancellationRequested(() => {
				if (waiter.cancelled) return;
				waiter.cancelled = true;
				const index = group.ioQueue.indexOf(waiter); if (index >= 0) group.ioQueue.splice(index, 1);
				waiter.listener?.dispose(); resolve(this.noopIoLease); this.pumpGroupIo(group);
			});
			group.ioQueue.push(waiter); this.pumpGroupIo(group);
		});
	}
	private readonly noopIoLease: AgentSubagentGroupIoLease = Object.freeze({ release() { } });
	private waitForGroupIoDrain(parentId: string, token?: CancellationToken): Promise<AgentSubagentGroupIoLease> {
		if ((this.activeGroupIo.get(parentId) ?? 0) === 0 || token?.isCancellationRequested) return Promise.resolve(this.noopIoLease);
		return new Promise<AgentSubagentGroupIoLease>(resolve => {
			const waiter: GroupIoDrainWaiter = { resolve, cancelled: false };
			if (token) waiter.listener = token.onCancellationRequested(() => {
				if (waiter.cancelled) return;
				waiter.cancelled = true;
				const waiters = this.groupIoDrainWaiters.get(parentId);
				waiters?.delete(waiter);
				if (waiters?.size === 0) this.groupIoDrainWaiters.delete(parentId);
				waiter.listener?.dispose();
				resolve(this.noopIoLease);
			});
			const waiters = this.groupIoDrainWaiters.get(parentId) ?? new Set<GroupIoDrainWaiter>(); waiters.add(waiter); this.groupIoDrainWaiters.set(parentId, waiters);
		});
	}
	private releaseGroupIoDrainWaiters(parentId: string): void {
		const waiters = this.groupIoDrainWaiters.get(parentId); if (!waiters) return;
		this.groupIoDrainWaiters.delete(parentId); for (const waiter of waiters) { waiter.listener?.dispose(); waiter.resolve(this.noopIoLease); }
	}
	private pumpGroupIo(group: ChildGroup): void {
		if (group.cancellation || group.activeIoWriter) return;
		const localActive = group.activeIoReads + (group.activeIoWriter ? 1 : 0);
		// A forgotten old generation has no map entry but can still be physically
		// draining. Do not let a new generation overlap it merely because its queue is
		// fresh; old queued waiters are cancelled separately by cancelGroupIo.
		if ((this.activeGroupIo.get(group.parentId) ?? 0) > localActive) return;
		while (group.ioQueue[0]?.cancelled) group.ioQueue.shift();
		const head = group.ioQueue[0]; if (!head) return;
		if (head.kind === 'write') {
			if (group.activeIoReads !== 0) return;
			group.ioQueue.shift(); group.activeIoWriter = true; this.grantGroupIo(group, head); return;
		}
		// FIFO writer preference: only the contiguous head readers may run. A writer
		// behind them prevents every later reader from overtaking it.
		while (group.activeIoReads < 2 && group.ioQueue[0]?.kind === 'read') {
			const reader = group.ioQueue.shift()!;
			if (reader.cancelled) continue;
			group.activeIoReads++; this.grantGroupIo(group, reader);
		}
	}
	private grantGroupIo(group: ChildGroup, waiter: GroupIoWaiter): void {
		waiter.listener?.dispose();
		this.activeGroupIo.set(group.parentId, (this.activeGroupIo.get(group.parentId) ?? 0) + 1);
		let released = false;
		const release = () => {
			if (released) return; released = true;
			if (waiter.kind === 'write') group.activeIoWriter = false;
			else group.activeIoReads = Math.max(0, group.activeIoReads - 1);
			const remaining = Math.max(0, (this.activeGroupIo.get(group.parentId) ?? 1) - 1);
			if (remaining === 0) { this.activeGroupIo.delete(group.parentId); this.releaseGroupIoDrainWaiters(group.parentId); } else this.activeGroupIo.set(group.parentId, remaining);
			this.pumpGroupIo(group);
			const current = this.groups.get(group.parentId); if (current && current !== group) this.pumpGroupIo(current);
		};
		waiter.resolve(Object.freeze({ release }));
	}
	private cancelGroupIo(group: ChildGroup): void {
		for (const waiter of group.ioQueue.splice(0)) { waiter.cancelled = true; waiter.listener?.dispose(); waiter.resolve(this.noopIoLease); }
	}

	async wait(parentId: string, timeoutMs: number, targets?: readonly string[], generation = 0): Promise<AgentSubagentWaitResult> {
		return this.waitFor(parentId, undefined, timeoutMs, targets, generation);
	}
	private assertWaitTargets(parentId: string, directParentRunId: string | undefined, targets: readonly string[] | undefined, generation: number): void {
		const group = this.groups.get(parentId); if (!group || group.generation !== generation) throw new Error('agent_child_not_found');
		const direct = group.runs.filter(candidate => candidate.parentRunId === directParentRunId);
		if (!targets) { if (!direct.length) throw new Error('agent_child_not_found'); return; }
		if (targets.some(id => !direct.some(candidate => candidate.id === id))) throw new Error('agent_child_not_direct');
	}
	private async waitFor(parentId: string, directParentRunId: string | undefined, timeoutMs: number, targets: readonly string[] | undefined, generation: number): Promise<AgentSubagentWaitResult> {
		const group = this.groups.get(parentId); if (!group || group.generation !== generation) throw new Error('agent_child_not_found');
		if (targets && (targets.length < 1 || targets.length > AGENT_SUBAGENT_MAX_WAIT_TARGETS || new Set(targets).size !== targets.length || targets.some(target => typeof target !== 'string' || !target.trim() || target.length > 256))) throw new Error('wait_agent_invalid_params');
		const direct = group.runs.filter(candidate => candidate.parentRunId === directParentRunId);
		if (targets) for (const id of targets) if (!direct.some(candidate => candidate.id === id)) throw new Error('agent_child_not_direct');
		const selected = targets ? direct.filter(run => targets.includes(run.id)) : direct;
		if (!selected.length) throw new Error('agent_child_not_found');
		let values = selected.map(run => run.lifecycle.receipt(true)); let timedOut = false;
		if (!values.some(value => value.deliverSummary) && selected.some(run => run.lifecycle.status === 'queued' || run.lifecycle.status === 'running')) { timedOut = await new Promise<boolean>(resolve => { let done = false; let handle: ReturnType<typeof setTimeout>; const finish = (timeout: boolean) => { if (done) return; done = true; clearTimeout(handle); listener.dispose(); resolve(timeout); }; const listener = this.onDidChangeRun(event => { if (event.parentId === parentId && selected.some(run => run.id === event.id && (('removed' in event && event.removed) || ('status' in event && event.status !== 'queued' && event.status !== 'running')))) finish(false); }); handle = setTimeout(() => finish(true), timeoutMs); }); values = selected.map(run => run.lifecycle.receipt(true)); }
		const newlyDelivered = values.filter(value => value.deliverSummary && value.receipt).map(value => value.receipt!); timedOut = timedOut && newlyDelivered.length === 0;
		for (const receipt of newlyDelivered) this.trace(group, 'receipt_delivered', group.runs.find(run => run.id === receipt.id), receipt.status);
		const legacy = selected.length === 1 ? { id: selected[0].id, status: selected[0].lifecycle.status } : newlyDelivered.length === 1 ? { id: newlyDelivered[0].id, status: newlyDelivered[0].status } : {};
		return { ...legacy, children: Object.freeze(selected.map(run => Object.freeze({ id: run.id, status: run.lifecycle.status, ...(run.role ? { roleName: run.role.name, roleDescription: run.role.description } : {}), usage: null }))), ...(newlyDelivered.length === 1 ? { receipt: newlyDelivered[0] } : { receipts: Object.freeze(newlyDelivered) }), budget: this.budget(group), deliverSummary: newlyDelivered.length > 0, timedOut };
	}
	private view(run: ChildRun): AgentSubagentRunView { return run.terminalView ?? this.createRunView(run); }
	private createRunView(run: ChildRun): AgentSubagentRunView {
		const now = Date.now();
		const startedAt = run.startedAt ?? now;
		const endedAt = run.settledAt ?? now;
		const inherited = run.toolExecutionProfile === 'inherited-parent-write-child';
		const approvals = inherited ? [...new Set(run.parentTools?.tools.flatMap(tool => tool.approval ? [tool.approval] : []) ?? [])] : [];
		const undoAvailable = !!run.parentTools?.tools.some(tool => tool.kind === 'builtin' && tool.name === 'write_file' && tool.approval === 'edits');
		return Object.freeze({
			id: run.id,
			generation: run.generation,
			...(run.parentRunId ? { parentRunId: run.parentRunId } : {}),
			depth: run.depth,
			remainingDepth: run.remainingDepth,
			status: run.lifecycle.status,
			schedulerActivity: run.schedulerActivity,
			...(run.summary ? { summary: run.summary } : {}),
			...(run.resultTruncated ? { resultTruncated: true as const } : {}),
			...(run.role ? { roleName: run.role.name, roleDescription: run.role.description } : {}),
			capabilityProfile: inherited ? 'inherit_parent_write' : 'read_only',
			...(inherited ? { toolPresentation: Object.freeze({ toolNames: Object.freeze(run.parentTools?.tools.map(tool => tool.name) ?? []), approvals: Object.freeze(approvals), undoAvailable, applicationBoundary: 'no_os_sandbox' as const }) } : {}),
			queuedMs: Math.max(0, startedAt - run.acceptedAt),
			runningMs: Math.max(0, endedAt - startedAt),
			totalMs: Math.max(0, endedAt - run.acceptedAt),
			authority: Object.freeze({ runtimeRevision: run.snapshot.revision, instructionsRevision: run.snapshot.instructions.revision, catalogRevision: run.snapshot.catalog.revision, ...(run.snapshot.model.hasModel ? { modelFingerprint: run.snapshot.model.fingerprint } : {}), ...(run.role ? { roleRevision: run.role.revision } : {}), selectedSkills: Object.freeze(run.snapshot.selected.map(skill => Object.freeze({ identity: skill.identity, bodyRevision: skill.bodyRevision }))) }),
			usage: null,
		});
	}
	getRunViews(parentId: string): readonly AgentSubagentRunView[] { return Object.freeze((this.groups.get(parentId)?.runs ?? []).map(run => this.view(run))); }
	getRunView(parentId: string): AgentSubagentRunView | undefined { return this.getRunViews(parentId)[0]; }
	getCoordinationRunViews(parentId: string): readonly AgentSubagentCoordinationRunView[] { return Object.freeze([...(this.coordinationRuns.get(parentId) ?? [])].map(run => Object.freeze({ id: run.id, generation: run.generation, released: run.released }))); }
	private budget(group: ChildGroup): AgentSubagentBudgetView { return Object.freeze({ accepted: group.accepted, running: this.activeCount(group), queued: group.runs.filter(run => run.lifecycle.status === 'queued').length, maxAccepted: group.limits.maxAcceptedChildren, maxConcurrent: group.limits.maxConcurrentThreadsPerSession, providerSends: group.providerSends, activeProviderSends: group.activeProviderSends, maxProviderSends: group.budgetLimits.maxProviderSends, resultChars: group.resultChars, retainedResultChars: group.retainedResultChars, maxResultChars: group.budgetLimits.maxResultChars, truncatedResultCount: group.truncatedResultCount, maxChildSummaryChars: group.budgetLimits.maxChildSummaryChars, usage: null }); }
	getBudgetView(parentId: string): AgentSubagentBudgetView | undefined { const group = this.groups.get(parentId); return group && this.budget(group); }
	getDiagnosticsView(parentId: string): AgentSubagentDiagnosticsView | undefined { const group = this.groups.get(parentId); if (!group) return undefined; const counts = { completed: 0, failed: 0, cancelled: 0 }; for (const run of group.runs) if (run.lifecycle.status === 'completed') counts.completed++; else if (run.lifecycle.status === 'failed') counts.failed++; else if (run.lifecycle.status === 'cancelled') counts.cancelled++; return Object.freeze({ parentId: group.parentId, generation: group.generation, elapsedMs: Math.max(0, Date.now() - group.createdAt), events: Object.freeze([...group.traceEvents]), droppedEvents: group.droppedTraceEvents, ...counts, usage: null }); }
	interrupt(parentId: string, target: string, generation = 0) { return this.interruptFor(parentId, undefined, target, generation); }
	private interruptFor(parentId: string, directParentRunId: string | undefined, target: string, generation: number) { const group = this.groups.get(parentId); const run = group?.generation === generation ? group.runs.find(candidate => candidate.id === target && candidate.parentRunId === directParentRunId) : undefined; if (!run) throw new Error('agent_child_not_direct'); this.cancelRunTree(group!, run, 'Child cancelled by parent.'); const value = run.lifecycle.receipt(false); return { id: run.id, status: run.lifecycle.status, receipt: value.receipt }; }
	private cancelRunTree(group: ChildGroup, run: ChildRun, summary: string): void { for (const child of group.runs.filter(candidate => candidate.parentRunId === run.id)) this.cancelRunTree(group, child, summary); for (const [admission, ownerRunId] of group.admissions) if (ownerRunId === run.id) { admission.cancel(); admission.dispose(); group.admissions.delete(admission); } this.cancelRun(run, summary); }
	private cancelRun(run: ChildRun, summary: string, status: 'cancelled' | 'failed' = 'cancelled'): void {
		if (run.lifecycle.status !== 'queued' && run.lifecycle.status !== 'running') return;
		// Fence first; abort/provider cancellation and broker cancellation happen before any lease is released.
		run.cancellation.cancel();
		for (const interrupt of [...run.activeDirectInterrupts]) { try { interrupt(); } catch { } }
		const requestId = run.requestId; if (requestId) { try { this.llm.abort(requestId); } catch { /* cancellation is already fenced; continue local settlement */ } }
		run.providerResponseFinish?.();
		run.providerLeaseRelease?.();
		this.cancelBroker(run);
		this.settle(run, status, summary);
		if (!run.runPromise) this.releaseExecution(run); // queued/yielded children have no in-flight provider or broker promise.
	}
	private cancelGroup(group: ChildGroup, summary: string): void { if (group.cancellation) return; group.cancellation = true; this.cancelGroupIo(group); this.trace(group, 'group_cancelled', undefined, undefined, 'cancelled'); for (const admission of group.admissions.keys()) { admission.cancel(); admission.dispose(); } group.admissions.clear(); for (const run of group.runs) this.cancelRun(run, summary); }
	cancelParent(parentId: string) { const group = this.groups.get(parentId); if (group) this.cancelGroup(group, 'Child cancelled by parent.'); }
	forgetParent(parentId: string) { const group = this.groups.get(parentId); if (!group) return; this.cancelGroup(group, 'Child cancelled by parent.'); this.groups.delete(parentId); this._onDidChangeDiagnostics.fire({ parentId, generation: group.generation }); for (const run of group.runs) this._onDidChangeRun.fire({ parentId, generation: run.generation, id: run.id, removed: true }); }
	override dispose(): void { for (const parentId of [...this.groups.keys()]) this.forgetParent(parentId); this.groups.clear(); this.coordinationRuns.clear(); super.dispose(); }
}
registerSingleton(IAgentSubagentService, AgentSubagentService, InstantiationType.Eager);
