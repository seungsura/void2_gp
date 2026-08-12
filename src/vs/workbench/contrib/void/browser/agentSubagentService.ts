/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
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
import { AgentRuntimeTurnSnapshot, admitProtectedAgentAuthority, createAgentRuntimeTurnSnapshot, selectExplicitSkills, skillAdvertisement } from '../common/agentSkills.js';
import { AGENT_SUBAGENT_MAX_ACCEPTED, AGENT_SUBAGENT_MAX_AGGREGATE_RESULT_CHARS, AGENT_SUBAGENT_MAX_CONCURRENT, AGENT_SUBAGENT_MAX_GROUP_PROVIDER_SENDS, AGENT_SUBAGENT_MAX_GROUP_RUN_MS, AGENT_SUBAGENT_MAX_RESULTS, AgentSubagentBudgetView, AgentSubagentLifecycle, AgentSubagentReceipt, AgentSubagentRunView, AgentSubagentStatus } from '../common/agentSubagents.js';
import { ILLMMessageService } from '../common/sendLLMMessageService.js';
import { assertCanonicalAgentChildRawUri, assertCanonicalAgentChildUriPath, assertCanonicalReadOnlyChildRawPaths, assertExactReadOnlyChildRawKeys, canonicalAgentChildUri, isToolAllowedByProfile } from '../common/agentSubagents.js';
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
import { appendAgentInstructionDeveloperInstructions } from '../common/agentInstructions.js';

const MAX_CHILD_TURNS = 16;
const MAX_CHILD_SUMMARY = 8_000;
const MAX_CHILD_RUN_MS = 120_000;

type ChildRun = { readonly id: string; readonly parentId: string; readonly generation: number; readonly message: string; readonly snapshot: AgentRuntimeTurnSnapshot; readonly lifecycle: AgentSubagentLifecycle; readonly cancellation: CancellationTokenSource; readonly settingsOfProvider: SettingsOfProvider; readonly role?: { name: string; description: string; revision: string }; requestId?: string; timeoutHandle?: ReturnType<typeof setTimeout>; summary: string };
type ChildGroup = { readonly parentId: string; readonly generation: number; readonly runs: ChildRun[]; readonly admissions: Set<CancellationTokenSource>; readonly deadlineAt: number; cancellation: boolean; accepted: number; providerSends: number; resultChars: number; admissionChain: Promise<void>; deadline?: ReturnType<typeof setTimeout> };
export const IAgentSubagentService = createDecorator<IAgentSubagentService>('voidAgentSubagentService');
export type AgentSubagentRunChangeEvent = Readonly<
	{ parentId: string; id: string; status: AgentSubagentStatus; removed?: false }
	| { parentId: string; id: string; removed: true }
>;
export type AgentSubagentWaitChild = Readonly<{ id: string; status: AgentSubagentStatus; roleName?: string; roleDescription?: string; usage: null }>;
export type AgentSubagentWaitResult = Readonly<{ id?: string; status?: AgentSubagentStatus; children: readonly AgentSubagentWaitChild[]; receipt?: AgentSubagentReceipt; receipts?: readonly AgentSubagentReceipt[]; budget: AgentSubagentBudgetView; deliverSummary: boolean; timedOut: boolean }>;
export interface IAgentSubagentService {
	readonly _serviceBrand: undefined;
	spawn(parentId: string, message: string, snapshot: AgentRuntimeTurnSnapshot, agentType?: string, admittedRoles?: CustomAgentCatalog, admittedSettingsState?: IVoidSettingsService['state'], admittedSettingsOfProvider?: SettingsOfProvider, generation?: number): Promise<{ id: string; status: AgentSubagentStatus }>;
	wait(parentId: string, timeoutMs: number, targets?: readonly string[], generation?: number): Promise<AgentSubagentWaitResult>;
	interrupt(parentId: string, target: string, generation?: number): { id?: string; status: AgentSubagentStatus; receipt?: AgentSubagentReceipt };
	cancelParent(parentId: string): void;
	forgetParent(parentId: string): void;
	getRunView(parentId: string): AgentSubagentRunView | undefined;
	getRunViews(parentId: string): readonly AgentSubagentRunView[];
	getBudgetView(parentId: string): AgentSubagentBudgetView | undefined;
	readonly onDidChangeRun: Event<AgentSubagentRunChangeEvent>;
}

/** Deliberately in-memory: Thread persistence never contains child transcripts or restart work. */
export class AgentSubagentService extends Disposable implements IAgentSubagentService {
	readonly _serviceBrand: undefined;
	private readonly groups = new Map<string, ChildGroup>();
	private readonly _onDidChangeRun = this._register(new Emitter<AgentSubagentRunChangeEvent>());
	readonly onDidChangeRun = this._onDidChangeRun.event;

	constructor(@ILLMMessageService private readonly llm: ILLMMessageService, @IToolsService private readonly tools: IToolsService, @IFileService private readonly fileService: IFileService, @IWorkspaceContextService private readonly workspace: IWorkspaceContextService, @IWorkspaceTrustManagementService private readonly trust: IWorkspaceTrustManagementService, @IConvertToLLMMessageService private readonly converter: IConvertToLLMMessageService, @IAgentSkillsService private readonly skills: IAgentSkillsService, @IAgentCustomAgentService private readonly customAgents: IAgentCustomAgentService, @IVoidSettingsService private readonly settings: IVoidSettingsService) { super(); }

	async spawn(parentId: string, message: string, parent: AgentRuntimeTurnSnapshot, agentType?: string, admittedRoles?: CustomAgentCatalog, admittedSettingsState?: IVoidSettingsService['state'], admittedSettingsOfProvider?: SettingsOfProvider, generation = 0) {
		let group = this.groups.get(parentId);
		if (group && group.generation !== generation) { this.forgetParent(parentId); group = undefined; }
		if (!group) { group = { parentId, generation, runs: [], admissions: new Set(), deadlineAt: Date.now() + AGENT_SUBAGENT_MAX_GROUP_RUN_MS, cancellation: false, accepted: 0, providerSends: 0, resultChars: 0, admissionChain: Promise.resolve() }; this.groups.set(parentId, group); group.deadline = setTimeout(() => this.cancelGroup(group!, 'Child group exceeded its bounded run duration.'), AGENT_SUBAGENT_MAX_GROUP_RUN_MS); }
		if (group.cancellation) throw new Error('agent_child_cancelled');
		if (group.accepted + group.admissions.size >= AGENT_SUBAGENT_MAX_ACCEPTED) throw new Error('agent_child_limit_reached');
		if (!parent.model.hasModel) throw new Error('agent_child_model_missing');
		const parentModel = parent.model;
		if (!providerNames.includes(parent.model.providerName as never)) throw new Error('agent_child_provider_invalid');
		if (!parent.ownerProjectRoot || !parent.runCwd || parent.ownerProjectRoot !== parent.runCwd || !this.matchesParent(parent)) throw new Error('agent_child_owner_or_trust_changed');
		const parentOwnerProjectRoot = parent.ownerProjectRoot;
		const settingsOfProvider = admittedSettingsOfProvider ?? this.llm.captureSettingsOfProvider();
		const capturedState = admittedSettingsState ?? deepClone(this.settings.state); // compatibility fallback for direct callers; top-level admission supplies the frozen state
		// Reserve before asynchronous role/Skill work. Chaining makes admission order deterministic.
		const admission = new CancellationTokenSource(); group.admissions.add(admission);
		const admittedGroup = group;
		const admissionWork = async () => { try {
			const catalogAtAdmission = agentType ? admittedRoles : undefined;
			if (admission.token.isCancellationRequested) throw new Error('agent_child_cancelled');
			if (!this.matchesParent(parent)) throw new Error('agent_child_owner_or_trust_changed');
			const role = agentType ? catalogAtAdmission?.agents.find(candidate => candidate.identity === agentType) : undefined;
			if (agentType && !role) throw new Error('custom_agent_not_found');
			const roleModel = role && (role.model || role.modelReasoningEffort) ? this.roleRuntimeModel(parentModel, role.model, role.modelReasoningEffort, capturedState) : parentModel;
			const effectiveCatalog = role ? Object.freeze({ ...parent.catalog, skills: applyCustomAgentSkillRules(parent.catalog.skills, role.skillRules) }) : parent.catalog;
			const explicit = selectExplicitSkills(effectiveCatalog, message);
			if (explicit.diagnostic) throw new Error(explicit.diagnostic.code);
			const bodies = await Promise.all((explicit.skills ?? []).map(async skill => { const read = await this.awaitAdmission(admission, this.skills.readSkillBody(skill.provenance.skillRoot, skill.bodyRevision)); if (admission.token.isCancellationRequested) throw new Error('agent_child_cancelled'); if (!this.matchesParent(parent)) throw new Error('agent_child_owner_or_trust_changed'); if (!read.body || read.diagnostic) throw new Error(read.diagnostic?.code ?? 'skill_body_unreadable'); return { identity: skill.identity, skillRoot: skill.provenance.skillRoot, bodyRevision: skill.bodyRevision, body: read.body }; }));
			if (admission.token.isCancellationRequested || admittedGroup.cancellation) throw new Error('agent_child_cancelled');
			if (!this.matchesParent(parent)) throw new Error('agent_child_owner_or_trust_changed');
			if (role) { const currentCatalog = await this.awaitAdmission(admission, this.customAgents.getCatalog(URI.parse(parentOwnerProjectRoot))); const current = currentCatalog.agents.find(candidate => candidate.identity === role.identity); if (!current || currentCatalog.revision !== catalogAtAdmission!.revision || current.revision !== role.revision) throw new Error('custom_agent_stale'); if (!this.matchesParent(parent)) throw new Error('agent_child_owner_or_trust_changed'); }
			if (admission.token.isCancellationRequested || admittedGroup.cancellation) throw new Error('agent_child_cancelled');
			const snapshot = role ? createAgentRuntimeTurnSnapshot(appendAgentInstructionDeveloperInstructions(parent.instructions, role.developerInstructions), effectiveCatalog, skillAdvertisement(effectiveCatalog, roleModel.contextWindow), bodies, roleModel, parent.workspaceTrustedAtAdmission) : createAgentRuntimeTurnSnapshot(parent.instructions, parent.catalog, skillAdvertisement(parent.catalog, parentModel.contextWindow), bodies, parentModel, parent.workspaceTrustedAtAdmission);
			admitProtectedAgentAuthority(snapshot, false);
			const run: ChildRun = { id: generateUuid(), parentId, generation, message, snapshot, lifecycle: new AgentSubagentLifecycle(), cancellation: new CancellationTokenSource(), settingsOfProvider, ...(role ? { role: { name: role.name, description: role.description, revision: role.revision } } : {}), summary: '' };
			admittedGroup.runs.push(run); admittedGroup.accepted++; admittedGroup.admissions.delete(admission); admission.dispose();
			this._onDidChangeRun.fire({ parentId, id: run.id, status: run.lifecycle.status });
			this.promote(admittedGroup);
			return { id: run.id, status: run.lifecycle.status };
		} catch (error) { admittedGroup.admissions.delete(admission); admission.dispose(); throw error; } };
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
			run.timeoutHandle = setTimeout(() => { const requestId = run.requestId; run.cancellation.cancel(); if (this.settle(run, 'failed', 'Child exceeded its bounded run duration.') && requestId) this.llm.abort(requestId); }, MAX_CHILD_RUN_MS);
			this._onDidChangeRun.fire({ parentId: run.parentId, id: run.id, status: run.lifecycle.status });
			const model = run.snapshot.model;
			if (!model.hasModel) { this.settle(run, 'failed', 'Child model is unavailable.'); return; }
			if (!providerNames.includes(model.providerName as never)) { this.settle(run, 'failed', 'Child provider is invalid.'); return; }
			const modelSelection: ModelSelection = { providerName: model.providerName as ModelSelection['providerName'], modelName: model.modelName };
			if (!run.snapshot.ownerProjectRoot || !run.snapshot.runCwd || run.snapshot.ownerProjectRoot !== run.snapshot.runCwd) { this.settle(run, 'failed', 'Child owner is unavailable.'); return; }
			const owner = URI.parse(run.snapshot.ownerProjectRoot);
			const history: ChatMessage[] = [{ role: 'user', content: message, displayContent: message, selections: [], state: { stagingSelections: [], isBeingEdited: false } }];
			for (let turn = 0; turn < MAX_CHILD_TURNS && !run.cancellation.token.isCancellationRequested; turn++) {
			const prepared = await this.converter.prepareLLMChatMessages({ chatMessages: history, chatMode: 'agent', modelSelection, instructionSnapshot: run.snapshot, toolExecutionProfile: 'read-only-child', childRoot: owner.toString(), agentDelegationAllowed: false });
			if (!this.isCurrent(run)) { this.settle(run, 'cancelled', 'Child owner or trust changed.'); return; }
			const group = this.groups.get(run.parentId); if (!group || group.generation !== run.generation || group.providerSends >= AGENT_SUBAGENT_MAX_GROUP_PROVIDER_SENDS) { this.settle(run, 'failed', 'Child group provider-send budget exceeded.'); return; } group.providerSends++;
			const response = await new Promise<{ text?: string; tool?: { id: string; name: string; rawParams: Record<string, unknown> }; error?: string }>(resolve => {
				let resolved = false;
				const finish = (value: { text?: string; tool?: { id: string; name: string; rawParams: Record<string, unknown> }; error?: string }) => { if (!resolved) { resolved = true; resolve(value); } };
				const requestId = this.llm.sendLLMMessage({ messagesType: 'chatMessages', messages: prepared.messages, separateSystemMessage: prepared.separateSystemMessage, chatMode: 'agent', toolExecutionProfile: 'read-only-child', agentDelegationAllowed: false, settingsOfProviderOverride: run.settingsOfProvider, modelSelection, modelSelectionOptions: model.modelSelectionOptions as never, overridesOfModel: { [modelSelection.providerName]: { [model.modelName]: model.selectedModelOverrides } } as never, logging: { loggingName: 'Agent child', loggingExtras: { childId: run.id, turn } }, onText: () => {}, onFinalMessage: ({ fullText, toolCall }) => finish(toolCall ? { text: fullText, tool: { id: toolCall.id, name: toolCall.name, rawParams: toolCall.rawParams } } : { text: fullText }), onError: ({ message: error }) => finish({ error }), onAbort: () => finish({ error: 'Child cancelled.' }) });
				run.requestId = requestId ?? undefined;
				if (!requestId) finish({ error: 'Child provider request was not started.' });
			});
			if (!this.isCurrent(run)) { this.settle(run, 'cancelled', 'Child cancelled or owner changed.'); return; }
			if (response.error) { this.settle(run, run.cancellation.token.isCancellationRequested ? 'cancelled' : 'failed', response.error); return; }
			history.push({ role: 'assistant', displayContent: response.text ?? '', reasoning: '', anthropicReasoning: null });
			if (!response.tool) { this.settle(run, 'completed', (response.text ?? '').slice(0, MAX_CHILD_SUMMARY)); return; }
			if (!isToolAllowedByProfile('read-only-child', response.tool.name) || !Object.prototype.hasOwnProperty.call(this.tools.validateParams, response.tool.name)) { history.push({ role: 'tool', type: 'tool_error', content: 'The requested tool is not authorized for this read-only child.', id: response.tool.id, rawParams: response.tool.rawParams, mcpServerName: undefined, name: response.tool.name, params: response.tool.rawParams, result: 'The requested tool is not authorized for this read-only child.' }); continue; }
			try {
				if (!this.isCurrent(run)) throw new Error('agent_child_owner_or_trust_changed');
				assertExactReadOnlyChildRawKeys(response.tool.name, response.tool.rawParams);
				assertCanonicalReadOnlyChildRawPaths(response.tool.name, response.tool.rawParams);
				const params = (this.tools.validateParams as Record<string, (raw: Record<string, unknown>) => unknown>)[response.tool.name](response.tool.rawParams);
				await this.assertContainedRead(params as Record<string, unknown>, owner);
				if (!this.isCurrent(run)) throw new Error('agent_child_owner_or_trust_changed');
				const maxReadOutputTokens = Math.max(256, Math.min(8192, model.contextWindow - model.reservedOutputTokens));
				const toolContext = { ownerThreadId: run.id, maxReadOutputTokens, childId: run.id, ownerRoot: owner, cancellationToken: run.cancellation.token, maxResults: AGENT_SUBAGENT_MAX_RESULTS, maxFileSize: 1024 * 1024 };
				const call = await (this.tools.callTool as Record<string, (params: unknown, context?: unknown) => Promise<{ result: Promise<unknown> }>>)[response.tool.name](params, toolContext);
				const result = await call.result;
				if (!this.isCurrent(run)) throw new Error('agent_child_owner_or_trust_changed');
				await this.assertContainedRead(params as Record<string, unknown>, owner);
				await this.assertContainedSearchResults(response.tool.name, result, owner);
				if (!this.isCurrent(run)) throw new Error('agent_child_owner_or_trust_changed');
				const rawPrintable = (this.tools.stringOfResult as Record<string, (params: unknown, result: unknown, context?: unknown) => string>)[response.tool.name](params, result, toolContext); const maxPrintableChars = maxReadOutputTokens * 4; const marker = '\n[child tool output truncated]'; const printable = rawPrintable.length <= maxPrintableChars ? rawPrintable : `${rawPrintable.slice(0, maxPrintableChars - marker.length)}${marker}`;
				history.push({ role: 'tool', type: 'success', content: printable, id: response.tool.id, rawParams: response.tool.rawParams, mcpServerName: undefined, name: response.tool.name, params: params as never, result: result as never });
			} catch (error) { if (!this.isCurrent(run)) { this.settle(run, 'cancelled', 'Child cancelled or owner changed.'); return; } const content = `The read-only tool call failed: ${error instanceof Error ? error.message : String(error)}`; history.push({ role: 'tool', type: 'tool_error', content, id: response.tool.id, rawParams: response.tool.rawParams, mcpServerName: undefined, name: response.tool.name, params: response.tool.rawParams, result: content }); }
			}
			this.settle(run, run.cancellation.token.isCancellationRequested ? 'cancelled' : 'failed', run.cancellation.token.isCancellationRequested ? 'Child cancelled.' : 'Child exceeded its bounded tool turn limit.');
		} catch (error) {
			this.settleRunFailure(run, error);
		}
	}
	private settleRunFailure(run: ChildRun, error: unknown): void { const cancelled = run.lifecycle.status === 'cancelled' || run.cancellation.token.isCancellationRequested; const detail = error instanceof Error ? error.message : String(error); this.settle(run, cancelled ? 'cancelled' : 'failed', cancelled ? 'Child cancelled.' : `Child failed: ${detail}`); }
	private matchesParent(snapshot: AgentRuntimeTurnSnapshot): boolean { return this.workspace.getWorkspace().folders[0]?.uri.toString() === snapshot.ownerProjectRoot && this.trust.isWorkspaceTrusted() === snapshot.workspaceTrustedAtAdmission; }
	private isCurrent(run: ChildRun): boolean { const group = this.groups.get(run.parentId); return run.lifecycle.status === 'running' && !run.cancellation.token.isCancellationRequested && !!group && group.generation === run.generation && group.runs.includes(run) && !group.cancellation && this.matchesParent(run.snapshot); }
	private promote(group: ChildGroup): void { if (group.cancellation) return; while (group.runs.filter(run => run.lifecycle.status === 'running').length < AGENT_SUBAGENT_MAX_CONCURRENT) { const next = group.runs.find(run => run.lifecycle.status === 'queued'); if (!next) return; void this.run(next, next.message).catch(error => this.settleRunFailure(next, error)); } }
	private settle(run: ChildRun, status: Exclude<AgentSubagentStatus, 'queued' | 'running'>, summary: string): boolean { const group = this.groups.get(run.parentId); const bounded = group ? summary.slice(0, Math.max(0, Math.min(MAX_CHILD_SUMMARY, AGENT_SUBAGENT_MAX_AGGREGATE_RESULT_CHARS - group.resultChars))) : summary.slice(0, MAX_CHILD_SUMMARY); const settled = run.lifecycle.settle(status, run.id, bounded); if (settled) { if (group && group.generation === run.generation) group.resultChars += bounded.length; if (run.timeoutHandle !== undefined) { clearTimeout(run.timeoutHandle); run.timeoutHandle = undefined; } run.summary = bounded; this.tools.invalidateReadReceipts(run.id); run.requestId = undefined; run.cancellation.dispose(); this._onDidChangeRun.fire({ parentId: run.parentId, id: run.id, status }); if (group && group.generation === run.generation) this.promote(group); } return settled; }
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

	async wait(parentId: string, timeoutMs: number, targets?: readonly string[], generation = 0): Promise<AgentSubagentWaitResult> {
		const group = this.groups.get(parentId); if (!group || group.generation !== generation) throw new Error('agent_child_not_found');
		if (targets && (targets.length < 1 || targets.length > AGENT_SUBAGENT_MAX_ACCEPTED || new Set(targets).size !== targets.length || targets.some(target => typeof target !== 'string' || !target.trim() || target.length > 256))) throw new Error('wait_agent_invalid_params');
		if (targets) for (const id of targets) if (!group.runs.some(candidate => candidate.id === id)) throw new Error('agent_child_not_direct');
		const selected = targets ? group.runs.filter(run => targets.includes(run.id)) : [...group.runs];
		if (!selected.length) throw new Error('agent_child_not_found');
		let values = selected.map(run => run.lifecycle.receipt(true)); let timedOut = false;
		if (!values.some(value => value.deliverSummary) && selected.some(run => run.lifecycle.status === 'queued' || run.lifecycle.status === 'running')) { timedOut = await new Promise<boolean>(resolve => { let done = false; let handle: ReturnType<typeof setTimeout>; const finish = (timeout: boolean) => { if (done) return; done = true; clearTimeout(handle); listener.dispose(); resolve(timeout); }; const listener = this.onDidChangeRun(event => { if (event.parentId === parentId && selected.some(run => run.id === event.id && (event.removed || event.status !== 'queued' && event.status !== 'running'))) finish(false); }); handle = setTimeout(() => finish(true), timeoutMs); }); values = selected.map(run => run.lifecycle.receipt(true)); }
		const newlyDelivered = values.filter(value => value.deliverSummary && value.receipt).map(value => value.receipt!); timedOut = timedOut && newlyDelivered.length === 0;
		const legacy = selected.length === 1 ? { id: selected[0].id, status: selected[0].lifecycle.status } : newlyDelivered.length === 1 ? { id: newlyDelivered[0].id, status: newlyDelivered[0].status } : {};
		return { ...legacy, children: Object.freeze(selected.map(run => Object.freeze({ id: run.id, status: run.lifecycle.status, ...(run.role ? { roleName: run.role.name, roleDescription: run.role.description } : {}), usage: null }))), ...(newlyDelivered.length === 1 ? { receipt: newlyDelivered[0] } : { receipts: Object.freeze(newlyDelivered) }), budget: this.budget(group), deliverSummary: newlyDelivered.length > 0, timedOut };
	}
	private view(run: ChildRun): AgentSubagentRunView { return Object.freeze({ id: run.id, status: run.lifecycle.status, ...(run.summary ? { summary: run.summary } : {}), ...(run.role ? { roleName: run.role.name, roleDescription: run.role.description } : {}), usage: null }); }
	getRunViews(parentId: string): readonly AgentSubagentRunView[] { return Object.freeze((this.groups.get(parentId)?.runs ?? []).map(run => this.view(run))); }
	getRunView(parentId: string): AgentSubagentRunView | undefined { return this.getRunViews(parentId)[0]; }
	private budget(group: ChildGroup): AgentSubagentBudgetView { return Object.freeze({ accepted: group.accepted, running: group.runs.filter(run => run.lifecycle.status === 'running').length, queued: group.runs.filter(run => run.lifecycle.status === 'queued').length, maxAccepted: AGENT_SUBAGENT_MAX_ACCEPTED, maxConcurrent: AGENT_SUBAGENT_MAX_CONCURRENT, providerSends: group.providerSends, maxProviderSends: AGENT_SUBAGENT_MAX_GROUP_PROVIDER_SENDS, resultChars: group.resultChars, maxResultChars: AGENT_SUBAGENT_MAX_AGGREGATE_RESULT_CHARS, deadlineMsRemaining: Math.max(0, group.deadlineAt - Date.now()), usage: null }); }
	getBudgetView(parentId: string): AgentSubagentBudgetView | undefined { const group = this.groups.get(parentId); return group && this.budget(group); }
	interrupt(parentId: string, target: string, generation = 0) { const group = this.groups.get(parentId); const run = group?.generation === generation ? group.runs.find(candidate => candidate.id === target) : undefined; if (!run) throw new Error('agent_child_not_direct'); const requestId = run.requestId; run.cancellation.cancel(); if (this.settle(run, 'cancelled', 'Child cancelled by parent.') && requestId) this.llm.abort(requestId); const value = run.lifecycle.receipt(false); return { id: run.id, status: run.lifecycle.status, receipt: value.receipt }; }
	private cancelGroup(group: ChildGroup, summary: string): void { if (group.cancellation) return; group.cancellation = true; if (group.deadline) clearTimeout(group.deadline); for (const admission of group.admissions) { admission.cancel(); admission.dispose(); } group.admissions.clear(); for (const run of group.runs) if (run.lifecycle.status === 'queued' || run.lifecycle.status === 'running') { const requestId = run.requestId; run.cancellation.cancel(); if (this.settle(run, 'cancelled', summary) && requestId) this.llm.abort(requestId); } }
	cancelParent(parentId: string) { const group = this.groups.get(parentId); if (group) this.cancelGroup(group, 'Child cancelled by parent.'); }
	forgetParent(parentId: string) { const group = this.groups.get(parentId); if (!group) return; this.cancelGroup(group, 'Child cancelled by parent.'); this.groups.delete(parentId); for (const run of group.runs) this._onDidChangeRun.fire({ parentId, id: run.id, removed: true }); }
	override dispose(): void { for (const parentId of [...this.groups.keys()]) this.forgetParent(parentId); this.groups.clear(); super.dispose(); }
}
registerSingleton(IAgentSubagentService, AgentSubagentService, InstantiationType.Eager);
