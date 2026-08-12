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
import { AGENT_SUBAGENT_MAX_RESULTS, AgentSubagentLifecycle, AgentSubagentReceipt, AgentSubagentRunView, AgentSubagentStatus } from '../common/agentSubagents.js';
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

type ChildRun = { readonly id: string; readonly parentId: string; readonly snapshot: AgentRuntimeTurnSnapshot; readonly lifecycle: AgentSubagentLifecycle; readonly cancellation: CancellationTokenSource; readonly settingsOfProvider: SettingsOfProvider; readonly role?: { name: string; description: string; revision: string }; requestId?: string; timeoutHandle?: ReturnType<typeof setTimeout>; summary: string };
export const IAgentSubagentService = createDecorator<IAgentSubagentService>('voidAgentSubagentService');
export type AgentSubagentRunChangeEvent = Readonly<
	{ parentId: string; id: string; status: AgentSubagentStatus; removed?: false }
	| { parentId: string; id: string; removed: true }
>;
export interface IAgentSubagentService {
	readonly _serviceBrand: undefined;
	spawn(parentId: string, message: string, snapshot: AgentRuntimeTurnSnapshot, agentType?: string, admittedRoles?: CustomAgentCatalog, admittedSettingsState?: IVoidSettingsService['state'], admittedSettingsOfProvider?: SettingsOfProvider): Promise<{ id: string; status: AgentSubagentStatus }>;
	wait(parentId: string, timeoutMs: number): Promise<{ id?: string; status: AgentSubagentStatus; receipt?: AgentSubagentReceipt; deliverSummary: boolean }>;
	interrupt(parentId: string, target: string): { id?: string; status: AgentSubagentStatus; receipt?: AgentSubagentReceipt };
	cancelParent(parentId: string): void;
	forgetParent(parentId: string): void;
	getRunView(parentId: string): AgentSubagentRunView | undefined;
	readonly onDidChangeRun: Event<AgentSubagentRunChangeEvent>;
}

/** Deliberately in-memory: Thread persistence never contains child transcripts or restart work. */
export class AgentSubagentService extends Disposable implements IAgentSubagentService {
	readonly _serviceBrand: undefined;
	private readonly runs = new Map<string, ChildRun>();
	private readonly pending = new Map<string, CancellationTokenSource>();
	private readonly _onDidChangeRun = this._register(new Emitter<AgentSubagentRunChangeEvent>());
	readonly onDidChangeRun = this._onDidChangeRun.event;

	constructor(@ILLMMessageService private readonly llm: ILLMMessageService, @IToolsService private readonly tools: IToolsService, @IFileService private readonly fileService: IFileService, @IWorkspaceContextService private readonly workspace: IWorkspaceContextService, @IWorkspaceTrustManagementService private readonly trust: IWorkspaceTrustManagementService, @IConvertToLLMMessageService private readonly converter: IConvertToLLMMessageService, @IAgentSkillsService private readonly skills: IAgentSkillsService, @IAgentCustomAgentService private readonly customAgents: IAgentCustomAgentService, @IVoidSettingsService private readonly settings: IVoidSettingsService) { super(); }

	async spawn(parentId: string, message: string, parent: AgentRuntimeTurnSnapshot, agentType?: string, admittedRoles?: CustomAgentCatalog, admittedSettingsState?: IVoidSettingsService['state'], admittedSettingsOfProvider?: SettingsOfProvider) {
		const active = this.runs.get(parentId);
		if (this.pending.has(parentId) || (active && (active.lifecycle.status === 'queued' || active.lifecycle.status === 'running'))) throw new Error('agent_child_already_active');
		if (!parent.model.hasModel) throw new Error('agent_child_model_missing');
		if (!providerNames.includes(parent.model.providerName as never)) throw new Error('agent_child_provider_invalid');
		if (!parent.ownerProjectRoot || !parent.runCwd || parent.ownerProjectRoot !== parent.runCwd || !this.matchesParent(parent)) throw new Error('agent_child_owner_or_trust_changed');
		const settingsOfProvider = admittedSettingsOfProvider ?? this.llm.captureSettingsOfProvider();
		const capturedState = admittedSettingsState ?? deepClone(this.settings.state); // compatibility fallback for direct callers; top-level admission supplies the frozen state
		const admission = new CancellationTokenSource(); this.pending.set(parentId, admission);
		try {
			const catalogAtAdmission = agentType ? admittedRoles : undefined;
			if (admission.token.isCancellationRequested || !this.matchesParent(parent)) throw new Error('agent_child_owner_or_trust_changed');
			const role = agentType ? catalogAtAdmission?.agents.find(candidate => candidate.identity === agentType) : undefined;
			if (agentType && !role) throw new Error('custom_agent_not_found');
			const roleModel = role && (role.model || role.modelReasoningEffort) ? this.roleRuntimeModel(parent.model, role.model, role.modelReasoningEffort, capturedState) : parent.model;
			const effectiveCatalog = role ? Object.freeze({ ...parent.catalog, skills: applyCustomAgentSkillRules(parent.catalog.skills, role.skillRules) }) : parent.catalog;
			const explicit = selectExplicitSkills(effectiveCatalog, message);
			if (explicit.diagnostic) throw new Error(explicit.diagnostic.code);
			const bodies = await Promise.all((explicit.skills ?? []).map(async skill => { const read = await this.skills.readSkillBody(skill.provenance.skillRoot, skill.bodyRevision); if (admission.token.isCancellationRequested) throw new Error('agent_child_cancelled'); if (!this.matchesParent(parent)) throw new Error('agent_child_owner_or_trust_changed'); if (!read.body || read.diagnostic) throw new Error(read.diagnostic?.code ?? 'skill_body_unreadable'); return { identity: skill.identity, skillRoot: skill.provenance.skillRoot, bodyRevision: skill.bodyRevision, body: read.body }; }));
			if (admission.token.isCancellationRequested || this.pending.get(parentId) !== admission) throw new Error('agent_child_cancelled');
			if (!this.matchesParent(parent)) throw new Error('agent_child_owner_or_trust_changed');
			if (role) { const currentCatalog = await this.customAgents.getCatalog(URI.parse(parent.ownerProjectRoot)); const current = currentCatalog.agents.find(candidate => candidate.identity === role.identity); if (!current || currentCatalog.revision !== catalogAtAdmission!.revision || current.revision !== role.revision) throw new Error('custom_agent_stale'); if (!this.matchesParent(parent)) throw new Error('agent_child_owner_or_trust_changed'); }
			if (admission.token.isCancellationRequested || this.pending.get(parentId) !== admission) throw new Error('agent_child_cancelled');
			const snapshot = role ? createAgentRuntimeTurnSnapshot(appendAgentInstructionDeveloperInstructions(parent.instructions, role.developerInstructions), effectiveCatalog, skillAdvertisement(effectiveCatalog, roleModel.contextWindow), bodies, roleModel, parent.workspaceTrustedAtAdmission) : createAgentRuntimeTurnSnapshot(parent.instructions, parent.catalog, skillAdvertisement(parent.catalog, parent.model.contextWindow), bodies, parent.model, parent.workspaceTrustedAtAdmission);
			admitProtectedAgentAuthority(snapshot, false);
			const run: ChildRun = { id: generateUuid(), parentId, snapshot, lifecycle: new AgentSubagentLifecycle(), cancellation: new CancellationTokenSource(), settingsOfProvider, ...(role ? { role: { name: role.name, description: role.description, revision: role.revision } } : {}), summary: '' };
			this.runs.set(parentId, run); this.pending.delete(parentId); admission.dispose();
			this._onDidChangeRun.fire({ parentId, id: run.id, status: run.lifecycle.status });
			void this.run(run, message).catch(error => this.settleRunFailure(run, error));
			return { id: run.id, status: run.lifecycle.status };
		} catch (error) { if (this.pending.get(parentId) === admission) this.pending.delete(parentId); admission.dispose(); throw error; }
	}
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
	private isCurrent(run: ChildRun): boolean { return !run.cancellation.token.isCancellationRequested && this.runs.get(run.parentId) === run && this.matchesParent(run.snapshot); }
	private settle(run: ChildRun, status: Exclude<AgentSubagentStatus, 'queued' | 'running'>, summary: string): boolean { const settled = run.lifecycle.settle(status, run.id, summary); if (settled) { if (run.timeoutHandle !== undefined) { clearTimeout(run.timeoutHandle); run.timeoutHandle = undefined; } run.summary = summary.slice(0, MAX_CHILD_SUMMARY); this.tools.invalidateReadReceipts(run.id); run.requestId = undefined; run.cancellation.dispose(); this._onDidChangeRun.fire({ parentId: run.parentId, id: run.id, status }); } return settled; }
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

	async wait(parentId: string, timeoutMs: number) {
		const run = this.runs.get(parentId); if (!run) throw new Error('agent_child_not_found');
		if (run.lifecycle.status === 'queued' || run.lifecycle.status === 'running') await new Promise<void>(resolve => { let done = false; let handle: ReturnType<typeof setTimeout>; const finish = () => { if (done) return; done = true; clearTimeout(handle); listener.dispose(); resolve(); }; const listener = this.onDidChangeRun(event => { if (event.parentId === parentId && (event.removed || (event.status !== 'queued' && event.status !== 'running'))) finish(); }); handle = setTimeout(finish, timeoutMs); });
		const value = run.lifecycle.receipt(true); return { id: run.id, status: run.lifecycle.status, receipt: value.receipt, deliverSummary: value.deliverSummary };
	}
	getRunView(parentId: string): AgentSubagentRunView | undefined { const run = this.runs.get(parentId); return run ? Object.freeze({ id: run.id, status: run.lifecycle.status, ...(run.summary ? { summary: run.summary } : {}), ...(run.role ? { roleName: run.role.name, roleDescription: run.role.description } : {}), usage: null }) : undefined; }
	interrupt(parentId: string, target: string) { const run = this.runs.get(parentId); if (!run || run.id !== target) throw new Error('agent_child_not_direct'); const requestId = run.requestId; run.cancellation.cancel(); if (this.settle(run, 'cancelled', 'Child cancelled by parent.') && requestId) this.llm.abort(requestId); const value = run.lifecycle.receipt(false); return { id: run.id, status: run.lifecycle.status, receipt: value.receipt }; }
	cancelParent(parentId: string) { const pending = this.pending.get(parentId); if (pending) { this.pending.delete(parentId); pending.cancel(); pending.dispose(); } const run = this.runs.get(parentId); if (run && (run.lifecycle.status === 'queued' || run.lifecycle.status === 'running')) this.interrupt(parentId, run.id); }
	forgetParent(parentId: string) { const run = this.runs.get(parentId); this.cancelParent(parentId); if (run && this.runs.delete(parentId)) this._onDidChangeRun.fire({ parentId, id: run.id, removed: true }); }
	override dispose(): void { for (const parentId of [...this.pending.keys(), ...this.runs.keys()]) this.forgetParent(parentId); this.pending.clear(); this.runs.clear(); super.dispose(); }
}
registerSingleton(IAgentSubagentService, AgentSubagentService, InstantiationType.Eager);
