/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { AgentSubagentBudgetView, AgentSubagentDiagnosticsView, AgentSubagentRunView, AgentSubagentStatus, agentSubagentStatusLabel } from './agentSubagents.js';

export type AgentSubagentPresentationRun = Readonly<{
	id: string;
	shortId: string;
	roleName?: string;
	roleDescription?: string;
	capabilityProfile?: AgentSubagentRunView['capabilityProfile'];
	toolPresentation?: AgentSubagentRunView['toolPresentation'];
	status: AgentSubagentStatus;
	schedulerActivity?: AgentSubagentRunView['schedulerActivity'];
	statusLabel: string;
	summary?: string;
	queuedMs: number;
	runningMs: number;
	totalMs: number;
	authority: AgentSubagentRunView['authority'];
	usageLabel: 'Usage unavailable';
	detailsOpen: false;
	technicalDetailsOpen: false;
}>;

export type AgentSubagentPresentation = Readonly<{
	summary: string;
	accepted: number;
	running: number;
	queued: number;
	completed: number;
	failed: number;
	cancelled: number;
	admissionPending: number;
	admissionFailures: number;
	actionRequired: boolean;
	actionRequiredLabel?: string;
	usageLabel: 'Usage unavailable';
	diagnosticsOpen: false;
	budget?: AgentSubagentBudgetView;
	diagnostics?: AgentSubagentDiagnosticsView;
	runs: readonly AgentSubagentPresentationRun[];
}>;

const freeze = <T>(value: T): T => Object.freeze(value);

/** Avoid a previous task's hook state leaking into the render before its effect refreshes. */
export const selectThreadScopedValue = <T>(state: Readonly<{ threadId: string; value: T }>, threadId: string, readCurrent: () => T): T =>
	state.threadId === threadId ? state.value : readCurrent();

/**
 * A deliberately small, UI-only projection. It never creates a group from absent
 * inputs, estimates usage, or changes the service's spawn order.
 */
export const getAgentSubagentPresentation = (
	budget: AgentSubagentBudgetView | undefined,
	runs: readonly AgentSubagentRunView[],
	diagnostics: AgentSubagentDiagnosticsView | undefined,
): AgentSubagentPresentation | undefined => {
	if (!budget && !diagnostics && runs.length === 0) return undefined;
	const counts = { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
	for (const run of runs) counts[run.status]++;
	// Lifecycle `running` includes a parent that has yielded its lease while it
	// waits for a child. The scheduler number is the truthful capacity number.
	const schedulerRunning = runs.filter(run => run.schedulerActivity === undefined ? run.status === 'running' : run.schedulerActivity === 'active').length;
	// Scheduler activity describes a live lease only.  Service views retain the
	// last scheduler marker after a run settles, so terminal and queued rows must
	// continue to present their canonical lifecycle status.
	const activityLabel = (run: AgentSubagentRunView): string => run.status !== 'running' ? agentSubagentStatusLabel(run.status) : run.schedulerActivity === 'waiting_children' ? 'Waiting for child runs' : run.schedulerActivity === 'ready_to_resume' ? 'Ready to resume' : run.schedulerActivity === 'quiescing' ? 'Finishing' : agentSubagentStatusLabel(run.status);
	const admissionStarted = diagnostics?.events.filter(event => event.kind === 'admission_started').length ?? 0;
	const admissionFailures = diagnostics?.events.filter(event => event.kind === 'admission_failed').length ?? 0;
	const admitted = diagnostics?.events.filter(event => event.kind === 'child_queued').length ?? 0;
	// Once the bounded trace has dropped entries, it cannot truthfully establish a
	// pending admission count; retain only the observed failure count.
	const admissionPending = diagnostics?.droppedEvents ? 0 : Math.max(0, admissionStarted - admissionFailures - admitted);
	const presentedRuns = freeze(runs.map(run => freeze({
		id: run.id,
		shortId: run.id.slice(0, 8),
		...(run.roleName ? { roleName: run.roleName } : {}),
		...(run.roleDescription ? { roleDescription: run.roleDescription } : {}),
		...(run.capabilityProfile ? { capabilityProfile: run.capabilityProfile } : {}),
		...(run.toolPresentation ? { toolPresentation: freeze({ toolNames: freeze([...run.toolPresentation.toolNames]), approvals: freeze([...run.toolPresentation.approvals]), undoAvailable: run.toolPresentation.undoAvailable, applicationBoundary: run.toolPresentation.applicationBoundary }) } : {}),
		status: run.status,
		...(run.schedulerActivity ? { schedulerActivity: run.schedulerActivity } : {}),
		statusLabel: activityLabel(run),
		...(run.summary ? { summary: run.summary } : {}),
		queuedMs: run.queuedMs,
		runningMs: run.runningMs,
		totalMs: run.totalMs,
		authority: freeze({
			runtimeRevision: run.authority.runtimeRevision,
			instructionsRevision: run.authority.instructionsRevision,
			catalogRevision: run.authority.catalogRevision,
			...(run.authority.modelFingerprint ? { modelFingerprint: run.authority.modelFingerprint } : {}),
			...(run.authority.roleRevision ? { roleRevision: run.authority.roleRevision } : {}),
			selectedSkills: freeze(run.authority.selectedSkills.map(skill => freeze({ identity: skill.identity, bodyRevision: skill.bodyRevision }))),
		}),
		usageLabel: 'Usage unavailable' as const,
		detailsOpen: false as const,
		technicalDetailsOpen: false as const,
	})));
	const accepted = budget?.accepted ?? runs.length;
	const labels = [
		counts.failed ? `${counts.failed} failed` : undefined,
		admissionFailures ? `${admissionFailures} setup failed` : undefined,
		schedulerRunning ? `${schedulerRunning} running` : undefined,
		counts.queued ? `${counts.queued} queued` : undefined,
		counts.completed ? `${counts.completed} completed` : undefined,
		counts.cancelled ? `${counts.cancelled} cancelled` : undefined,
		admissionPending ? `${admissionPending} preparing` : undefined,
		`${accepted}/${budget?.maxAccepted ?? accepted} accepted`,
	].filter((label): label is string => !!label);
	const actionParts = [counts.failed ? `${counts.failed} child failure${counts.failed === 1 ? '' : 's'}` : undefined, admissionFailures ? `${admissionFailures} setup failure${admissionFailures === 1 ? '' : 's'}` : undefined].filter((label): label is string => !!label);
	const presentedBudget = budget && freeze({ ...budget });
	const presentedDiagnostics = diagnostics && freeze({ ...diagnostics, events: freeze(diagnostics.events.map(event => freeze({ ...event, budget: freeze({ ...event.budget }) }))) });
	const summary = `Child runs · ${labels.join(' · ')}`;
	return freeze({
		summary,
		accepted,
		running: schedulerRunning,
		queued: counts.queued,
		completed: counts.completed,
		failed: counts.failed,
		cancelled: counts.cancelled,
		admissionPending,
		admissionFailures,
		actionRequired: actionParts.length > 0,
		...(actionParts.length ? { actionRequiredLabel: `Action required · ${actionParts.join(' · ')}` } : {}),
		usageLabel: 'Usage unavailable',
		diagnosticsOpen: false,
		...(presentedBudget ? { budget: presentedBudget } : {}),
		...(presentedDiagnostics ? { diagnostics: presentedDiagnostics } : {}),
		runs: presentedRuns,
	});
};
