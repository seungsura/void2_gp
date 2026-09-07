/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { chromium } from '@playwright/test';
import { build } from 'tsup';

const read = (filePath: string): string => fs.readFileSync(filePath, 'utf8');
const between = (text: string, start: string, end: string): string => {
	const startIndex = text.indexOf(start); const endIndex = text.indexOf(end, startIndex + start.length);
	assert.ok(startIndex >= 0 && endIndex > startIndex, `Expected bounded source region: ${start}`);
	return text.slice(startIndex, endIndex);
};
const findJavaScriptFiles = (directory: string): string[] => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? findJavaScriptFiles(path.join(directory, entry.name)) : entry.isFile() && entry.name.endsWith('.js') ? [path.join(directory, entry.name)] : []);

const buildRuntime = async (servicesPath: string) => {
	const sourceRoot = path.resolve(process.cwd());
	const temporaryRoot = fs.mkdtempSync(path.join(sourceRoot, '.child-run-live-timing-'));
	assert.ok(temporaryRoot.startsWith(`${sourceRoot}${path.sep}`));
	const entry = path.join(temporaryRoot, 'entry.tsx');
	const outDir = path.join(temporaryRoot, 'out');
	const relative = path.relative(temporaryRoot, servicesPath).replaceAll('\\', '/');
	fs.writeFileSync(entry, `
		import React, { useState } from 'react';
		import { createRoot } from 'react-dom/client';
		import { flushSync } from 'react-dom';
		import { _registerServices, useAgentSubagentLiveSnapshot } from ${JSON.stringify(relative.startsWith('.') ? relative : './' + relative)};
		const runListeners = new Set<(event: any) => void>(); const diagnosticsListeners = new Set<(event: any) => void>();
		const listen = (set: Set<any>, listener: any) => { set.add(listener); return { dispose: () => set.delete(listener) }; };
		let now = 0; const states: Record<string, 'queued' | 'running' | 'completed'> = { A: 'running', B: 'queued' }; const calls = { runs: 0, budget: 0, diagnostics: 0 };
		const child = {
			getRunViews(id: string) { calls.runs++; return id === 'C' ? [] : [{ id, status: states[id], totalMs: now, queuedMs: now, runningMs: now }]; },
			getBudgetView(id: string) { calls.budget++; return { parentId: id, activeProviderSends: id === 'A' ? 1 : 0, maxProviderSends: 64, providerSends: id === 'A' ? 2 : 3 }; },
			getDiagnosticsView(id: string) { calls.diagnostics++; return { parentId: id, elapsedMs: now }; },
			onDidChangeRun(listener: any) { return listen(runListeners, listener); }, onDidChangeDiagnostics(listener: any) { return listen(diagnosticsListeners, listener); },
		};
		const generic = new Proxy({ state: {}, streamState: {}, getColorTheme: () => ({ type: 'dark' }) }, { get(target, key) { if (key in target) return (target as any)[key]; if (typeof key === 'string' && key.startsWith('onDidChange')) return () => ({ dispose() {} }); return () => undefined; } });
		_registerServices({ get(identifier: any) { return String(identifier).includes('voidAgentSubagentService') ? child : generic; } } as any);
		const timers = new Map<number, () => void>(); const cleared: number[] = []; let nextTimer = 1;
		window.setInterval = ((callback: TimerHandler) => { const id = nextTimer++; timers.set(id, callback as () => void); return id; }) as typeof window.setInterval;
		window.clearInterval = ((id: number) => { cleared.push(id); timers.delete(id); }) as typeof window.clearInterval;
		let updateThread!: (id: string) => void; let root: ReturnType<typeof createRoot> | undefined;
		const Harness = () => { const [threadId, setThreadId] = useState('A'); updateThread = setThreadId; const value = useAgentSubagentLiveSnapshot(threadId); const run = value.runs[0]; return <output id="snapshot">{threadId + ':' + run?.status + ':' + run?.totalMs + ':' + value.budget?.activeProviderSends + '/' + value.budget?.maxProviderSends + ':' + value.budget?.providerSends + ':' + value.diagnostics?.elapsedMs}</output>; };
		(window as any).__childRunTiming = {
			calls, cleared, mount(node: HTMLElement) { root = createRoot(node); flushSync(() => root!.render(<Harness />)); },
			advance(ms: number) { now += ms; for (const callback of [...timers.values()]) callback(); },
			emitRun(id: string) { for (const listener of [...runListeners]) listener({ parentId: id }); }, emitDiagnostics(id: string) { for (const listener of [...diagnosticsListeners]) listener({ parentId: id }); },
			setState(id: string, state: 'queued' | 'running' | 'completed') { states[id] = state; }, setThread(id: string) { flushSync(() => updateThread(id)); }, activeTimers() { return timers.size; }, listenerCounts() { return { run: runListeners.size, diagnostics: diagnosticsListeners.size }; }, dispose() { flushSync(() => root?.unmount()); },
		};
	`, 'utf8');
	try {
		await build({ entry: { runtime: entry }, outDir, format: ['iife'], globalName: 'ChildRunTimingRuntime', splitting: false, clean: true, platform: 'browser', target: 'es2022', silent: true, noExternal: [/^(?!\.).*$/], treeshake: true, esbuildOptions(options) { options.outbase = temporaryRoot; } });
		const outputs = findJavaScriptFiles(outDir); assert.strictEqual(outputs.length, 1);
		return { script: read(outputs[0]), dispose: () => fs.rmSync(temporaryRoot, { recursive: true, force: true }) };
	} catch (error) { fs.rmSync(temporaryRoot, { recursive: true, force: true }); throw error; }
};

const buildSkippedToolCardRuntime = async (sidebarPath: string) => {
	const sourceRoot = path.resolve(process.cwd());
	const temporaryRoot = fs.mkdtempSync(path.join(sourceRoot, '.skipped-tool-card-'));
	assert.ok(temporaryRoot.startsWith(`${sourceRoot}${path.sep}`));
	const entry = path.join(temporaryRoot, 'entry.tsx'); const outDir = path.join(temporaryRoot, 'out');
	const component = between(read(sidebarPath), 'export function SkippedToolCard', 'const _ChatBubble =');
	assert.strictEqual(component.includes('.params'), false); assert.strictEqual(component.includes('rawParams'), false); assert.strictEqual(component.includes('applicationToolRoute'), false);
	fs.writeFileSync(entry, `
		import React from 'react';
		import { createRoot } from 'react-dom/client';
		import { flushSync } from 'react-dom';
		type ToolName = string;
		type ToolMessage<T extends ToolName> = { type: 'skipped'; name: T } | { type: 'other'; name: T; params: unknown };
		const ToolHeaderWrapper = ({ title, desc1, isRejected }: { title: string; desc1: string; isRejected: boolean }) => <article data-tool-card="skipped" data-rejected={String(isRejected)}><strong>{title}</strong><span>{desc1}</span></article>;
		${component}
		const rows = [
			{ role: 'tool', type: 'skipped', name: 'write_file', result: null, content: 'never executed', id: 'write-skipped', rawParams: { uri: { malformed: true }, edits: 'not-an-array' }, mcpServerName: undefined, batchId: 'safe-batch', batchOrdinal: 0 },
			{ role: 'tool', type: 'skipped', name: 'run_command', result: null, content: 'never executed', id: 'command-skipped', rawParams: { command: { malformed: true }, terminalId: null }, mcpServerName: undefined, batchId: 'safe-batch', batchOrdinal: 1 },
		] as const;
		let root: ReturnType<typeof createRoot> | undefined;
		const Harness = () => <>{rows.map(row => <React.Fragment key={row.id}>{renderEarlyToolCard(row as any) ?? <article data-tool-card="typed">typed route</article>}</React.Fragment>)}</>;
		(window as any).__skippedToolCard = { mount(node: HTMLElement) { root = createRoot(node); flushSync(() => root!.render(<Harness />)); }, hasParams: () => rows.map(row => Object.prototype.hasOwnProperty.call(row, 'params')), rawParamKinds: () => rows.map(row => typeof row.rawParams), dispose() { flushSync(() => root?.unmount()); } };
	`, 'utf8');
	try {
		await build({ entry: { runtime: entry }, outDir, format: ['iife'], globalName: 'SkippedToolCardRuntime', splitting: false, clean: true, platform: 'browser', target: 'es2022', silent: true, noExternal: [/^(?!\.).*$/], treeshake: true, esbuildOptions(options) { options.outbase = temporaryRoot; } });
		const outputs = findJavaScriptFiles(outDir); assert.strictEqual(outputs.length, 1);
		return { script: read(outputs[0]), dispose: () => fs.rmSync(temporaryRoot, { recursive: true, force: true }) };
	} catch (error) { fs.rmSync(temporaryRoot, { recursive: true, force: true }); throw error; }
};

/** Mount only the production history/approval regions. The surrounding Sidebar is
 * intentionally not duplicated: its message renderer is represented by stable
 * persisted-row markers so card insertion can be checked without a fake card. */
const buildChildActivityHistoryRuntime = async (sidebarPath: string, servicesPath: string) => {
	const sourceRoot = path.resolve(process.cwd()); const temporaryRoot = fs.mkdtempSync(path.join(sourceRoot, '.child-activity-history-'));
	assert.ok(temporaryRoot.startsWith(`${sourceRoot}${path.sep}`));
	const entry = path.join(temporaryRoot, 'entry.tsx'); const outDir = path.join(temporaryRoot, 'out'); const sidebar = read(sidebarPath); const relativeServices = path.relative(temporaryRoot, servicesPath).replaceAll('\\', '/');
	const approvalPanel = between(sidebar, 'const ChildToolApprovalPanel =', 'const childActivityInterleavePlan =');
	const history = between(sidebar, 'const childActivityInterleavePlan =', 'const pendingInputModeLabel =');
	fs.writeFileSync(entry, `
		import React, { useState } from 'react'; import { createRoot } from 'react-dom/client'; import { flushSync } from 'react-dom'; import { _registerServices, useAgentSubagentLiveSnapshot } from ${JSON.stringify(relativeServices.startsWith('.') ? relativeServices : './' + relativeServices)};
		type AgentSubagentPresentation = any; type ChildToolApprovalView = any; type ChatMessage = any; type ChildActivitiesLedger = any; type ChildActivityRecord = any; type AgentSubagentRunView = any; type PendingInputMode = any;
		const runListeners = new Set<(event: any) => void>(); const diagnosticListeners = new Set<(event: any) => void>(); const listen = (set: Set<any>, listener: any) => { set.add(listener); return { dispose: () => set.delete(listener) }; }; let now = 0; let settled = false; let storageWrites = 0;
		const authority = { runtimeRevision: 'runtime', instructionsRevision: 'instructions', catalogRevision: 'catalog', selectedSkills: [] };
		const child = { getRunViews(id: string) { return id !== 'thread-1' || settled ? [] : [{ id: 'root', generation: 8, depth: 1, status: 'running', queuedMs: 10, runningMs: now, totalMs: now + 10, summary: 'LIVE_PROGRESS', shortId: 'root', statusLabel: 'Running', authority }, { id: 'nested', parentRunId: 'root', generation: 8, depth: 2, status: 'running', queuedMs: 10, runningMs: now, totalMs: now + 10, summary: 'NESTED_LIVE', shortId: 'nested', statusLabel: 'Running', authority }]; }, getBudgetView() { return undefined; }, getDiagnosticsView() { return undefined; }, onDidChangeRun(listener: any) { return listen(runListeners, listener); }, onDidChangeDiagnostics(listener: any) { return listen(diagnosticListeners, listener); } };
		const generic = new Proxy({ state: {}, streamState: {}, getColorTheme: () => ({ type: 'dark' }) }, { get(target, key) { if (key in target) return (target as any)[key]; if (typeof key === 'string' && key.startsWith('onDidChange')) return () => ({ dispose() {} }); return () => undefined; } }); _registerServices({ get(identifier: any) { return String(identifier).includes('voidAgentSubagentService') ? child : generic; } } as any);
		const timers = new Map<number, () => void>(); let nextTimer = 0; window.setInterval = ((callback: TimerHandler) => { const id = ++nextTimer; timers.set(id, callback as () => void); return id; }) as any; window.clearInterval = ((id: number) => timers.delete(id)) as any;
		const useAccessor = () => ({ get: () => ({ approveChildToolApproval() {}, rejectChildToolApproval() {} }) });
		${approvalPanel}
		${history}
		const messages: any[] = [
			{ role: 'assistant', content: 'before' },
			{ role: 'tool', type: 'success', name: 'spawn_agent', id: 'spawn', batchId: 'b', batchOrdinal: 2, result: { id: 'root' }, content: 'spawn receipt' },
			{ role: 'assistant', content: 'after' },
		];
		const invalid: any = { generation: 8, childId: 'RAW_TRANSCRIPT', depth: 1, status: 'completed', capabilityProfile: 'read_only', queuedMs: 0, runningMs: 1, totalMs: 1, summary: 'RAW_TRANSCRIPT', anchor: { toolId: 'missing', batchId: 'b', batchOrdinal: 0 } };
		const base: any = { generation: 8, childId: 'root', depth: 1, status: 'running', capabilityProfile: 'read_only', queuedMs: 10, runningMs: 0, totalMs: 10, role: { name: 'reader', description: 'durable role' }, anchor: { toolId: 'spawn', batchId: 'b', batchOrdinal: 2 } };
		const nested: any = { ...base, childId: 'nested', parentRunId: 'root', depth: 2, role: undefined, anchor: { toolId: 'spawn', batchId: 'b', batchOrdinal: 2 } };
		let root: ReturnType<typeof createRoot> | undefined; let original: Element | null = null; let setDurable!: (value: boolean) => void; let persistenceActive = true;
		const persistence = child.onDidChangeRun((event: any) => { if (persistenceActive && event.parentId === 'thread-1' && settled) { storageWrites++; flushSync(() => setDurable(true)); } });
		const approvals = [{ key: 'approval-key', structuralKey: 'approval-structural-key', title: 'write_file', childShortId: 'root', category: 'File changes', parameters: '{"uri":"fixture.txt"}', toolName: 'write_file' }];
		const Harness = () => { const [durableSettled, set] = useState(false); setDurable = set; const snapshot = useAgentSubagentLiveSnapshot('thread-1'); const durable = { version: 1, records: [durableSettled ? { ...base, status: 'completed', runningMs: 80, totalMs: 90, summary: 'DURABLE_TERMINAL' } : base, nested, invalid], omitted: 0, retentionSaturated: false }; const live = new Map(snapshot.runs.map((view: any) => [JSON.stringify([view.generation, view.id]), view])); const plan = childActivityInterleavePlan(messages, durable); return <><ChildToolApprovalPanel approvals={approvals} /><main>{messages.flatMap((message, index) => [<div key={'m'+index} data-message={index}>{message.content}</div>, ...(plan.get(index) ?? []).map((record: any) => <ChildActivityCard key={record.childId} root={record} all={durable.records} live={live} ledger={durable} />)])}</main></>; };
		(window as any).__childActivityHistory = { mount(node: HTMLElement) { root = createRoot(node); flushSync(() => root!.render(<Harness />)); original = document.querySelector('[data-testid=child-activity-card]'); }, advance(ms: number) { now += ms; for (const callback of [...timers.values()]) callback(); }, settle() { settled = true; for (const listener of [...runListeners]) listener({ parentId: 'thread-1' }); }, sameCard() { return original === document.querySelector('[data-testid=child-activity-card]'); }, timers() { return timers.size; }, listeners() { return { run: runListeners.size, diagnostics: diagnosticListeners.size, persistence: persistenceActive ? 1 : 0 }; }, storageWrites() { return storageWrites; }, dispose() { flushSync(() => root?.unmount()); persistenceActive = false; persistence.dispose(); } };
	`, 'utf8');
	try { await build({ entry: { runtime: entry }, outDir, format: ['iife'], globalName: 'ChildActivityHistoryRuntime', splitting: false, clean: true, platform: 'browser', target: 'es2022', silent: true, noExternal: [/^(?!\.).*$/], treeshake: true, esbuildOptions(options) { options.outbase = temporaryRoot; } }); const outputs = findJavaScriptFiles(outDir); assert.strictEqual(outputs.length, 1); return { script: read(outputs[0]), dispose: () => fs.rmSync(temporaryRoot, { recursive: true, force: true }) }; }
	catch (error) { fs.rmSync(temporaryRoot, { recursive: true, force: true }); throw error; }
};

/** Bundles the exported production SidebarChat unchanged while replacing only its
 * external dependencies with a deterministic browser fixture. This exercises the
 * real landing/current branches and their real child approval/activity call sites. */
const buildMountedSidebarRuntime = async (sidebarPath: string) => {
	const sourceRoot = path.resolve(process.cwd()); const temporaryRoot = fs.mkdtempSync(path.join(sourceRoot, '.mounted-sidebar-chat-'));
	assert.ok(temporaryRoot.startsWith(`${sourceRoot}${path.sep}`));
	const entry = path.join(temporaryRoot, 'entry.tsx'); const outDir = path.join(temporaryRoot, 'out');
	const relativeSidebar = path.relative(temporaryRoot, sidebarPath).replaceAll('\\', '/'); const importPath = relativeSidebar.startsWith('.') ? relativeSidebar : `./${relativeSidebar}`;
	let sidebarLoads = 0; const dependencyLoads = new Map<string, number>();
	fs.writeFileSync(entry, `
		import React from 'react'; import { createRoot } from 'react-dom/client'; import { flushSync } from 'react-dom'; import { SidebarChat } from ${JSON.stringify(importPath)};
		const approvals: unknown[] = []; const rejections: unknown[] = [];
		const approvalKey = Object.freeze({ parentId: 'thread-current', generation: 7, childId: 'child-root', batchId: 'batch-1', batchOrdinal: 0, toolId: 'write-tool-1', snapshotRevision: 'snapshot-r1' });
		const approval = Object.freeze({ key: approvalKey, structuralKey: JSON.stringify(['thread-current', 7, 'child-root', 'batch-1', 0, 'write-tool-1', 'snapshot-r1']), title: 'write_file', childShortId: 'child-ro', toolKind: 'builtin', category: 'edits', parameters: '{"uri":"fixture.txt"}', toolName: 'write_file', status: 'awaiting' });
		const mountedInfo = { mountedIsResolvedRef: { current: true } };
		const landingThread: any = { id: 'thread-landing', messages: [], state: { stagingSelections: [], mountedInfo }, childActivities: { version: 1, records: [], omitted: 0, retentionSaturated: false } };
		const receipt: any = { role: 'tool', type: 'success', name: 'spawn_agent', id: 'spawn-receipt', batchId: 'batch-1', batchOrdinal: 0, params: {}, rawParams: {}, result: { id: 'child-root' }, content: 'spawn receipt' };
		const durable: any = { generation: 7, childId: 'child-root', depth: 1, status: 'completed', capabilityProfile: 'read_only', queuedMs: 5, runningMs: 85, totalMs: 90, summary: 'DURABLE_DONE', role: { name: 'reader', description: 'Reads the workspace' }, anchor: { toolId: 'spawn-receipt', batchId: 'batch-1', batchOrdinal: 0 } };
		const currentThread: any = { id: 'thread-current', messages: [receipt], state: { stagingSelections: [], mountedInfo }, childActivities: { version: 1, records: [durable], omitted: 0, retentionSaturated: false } };
		const activeRun: any = { id: 'child-root', generation: 7, depth: 1, status: 'running', queuedMs: 10, runningMs: 1240, totalMs: 1250, summary: 'LIVE_OVERLAY', shortId: 'child-ro', statusLabel: 'Running', capabilityProfile: 'read_only', authority: { runtimeRevision: 'r', instructionsRevision: 'i', catalogRevision: 'c', selectedSkills: [] } };
		const fixture: any = { mode: 'landing', approval, approvals, rejections, landingThread, currentThread, activeRun };
		const service: any = { state: { currentThreadId: 'thread-landing' }, getCurrentThread: () => fixture.mode === 'landing' ? landingThread : currentThread, getTransientComposerDraft: () => '', setCurrentThreadState() {}, setTransientComposerDraft() {}, setCurrentlyFocusedMessageIdx() {}, clearSubmittedComposerState() {}, submitPendingInput: () => false, beginUserMessageAndStreamResponse: () => Promise.resolve(), abortRunning: () => Promise.resolve(), dismissStreamError() {}, editPendingInput: () => false, deletePendingInput: () => false, reorderPendingInput: () => false, resumePendingInput: () => false, approveChildToolApproval: (key: unknown) => approvals.push(key), rejectChildToolApproval: (key: unknown) => rejections.push(key) };
		fixture.service = service; (globalThis as any).__sidebarChatFixtureState = fixture;
		let root: ReturnType<typeof createRoot> | undefined; const render = () => { service.state.currentThreadId = fixture.mode === 'landing' ? landingThread.id : currentThread.id; flushSync(() => root!.render(<SidebarChat key={fixture.mode} />)); };
		(window as any).__mountedSidebarChat = { approvals, rejections, approvalKey, approvalIdentity: () => approvals[0] === approvalKey, rejectionIdentity: () => rejections[0] === approvalKey, keyFrozen: () => Object.isFrozen(approvalKey), mount(node: HTMLElement) { root = createRoot(node); render(); }, setMode(mode: 'landing' | 'current') { fixture.mode = mode; render(); }, dispose() { flushSync(() => root?.unmount()); } };
	`, 'utf8');
	const modules: Record<string, string> = {
		'../util/services.js': `
			const state = () => (globalThis as any).__sidebarChatFixtureState;
			const generic = new Proxy({}, { get: (_target, key) => typeof key === 'string' && key.startsWith('onDidChange') ? () => ({ dispose() {} }) : () => undefined });
			export const useAccessor = () => ({ get(id: string) { if (id === 'IChatThreadService') return state().service; if (id === 'ICommandService') return { executeCommand: () => Promise.resolve() }; if (id === 'IKeybindingService') return { lookupKeybinding: () => undefined }; if (id === 'IEditCodeService') return { acceptOrRejectAllDiffAreas() {} }; if (id === 'IVoidSettingsService') return { setOptionsOfModelSelection() {} }; return generic; } });
			export const useChatThreadsState = () => { const thread = state().mode === 'landing' ? state().landingThread : state().currentThread; return { currentThreadId: thread.id, allThreads: { [thread.id]: thread } }; };
			export const useChatThreadsStreamState = () => undefined; export const usePendingChatInputs = () => []; export const usePendingChatSubmission = () => undefined;
			export const useSettingsState = () => ({ modelSelectionOfFeature: { Chat: undefined }, optionsOfModelSelection: { Chat: {} }, overridesOfModel: {} }); export const useActiveURI = () => ({});
			export const useAgentSubagentLiveSnapshot = () => ({ runs: [state().activeRun], budget: undefined, diagnostics: undefined }); export const useChildToolApprovals = () => [state().approval]; export const useCommandBarState = () => ({ stateOfURI: {}, sortedURIs: [] });
		`,
		'../../../../../../../editor/common/editorCommon.js': `export const ScrollType = { Immediate: 0 };`,
		'../markdown/ChatMarkdownRender.js': `import React from 'react'; export const ChatMarkdownRender = ({ markdown }: any) => <span>{markdown}</span>; export const ChatMessageLocation = {}; export const getApplyBoxId = () => 'apply-box';`,
		'../../../../../../../base/common/uri.js': `export class URI { fsPath = ''; static file(value: string) { const uri = new URI(); uri.fsPath = value; return uri; } }`,
		'../../../../../../../base/common/lifecycle.js': `export type IDisposable = { dispose(): void };`,
		'./ErrorDisplay.js': `import React from 'react'; export const ErrorDisplay = ({ message }: any) => <div>{message}</div>;`,
		'../util/inputs.js': `import React from 'react'; export type TextAreaFns = { setValue(value: string): void }; export const VoidInputBox2 = React.forwardRef<HTMLTextAreaElement, any>(({ initValue, ariaLabel, ariaDescribedBy, onChangeText, onKeyDown, onFocus }: any, ref) => <textarea ref={ref} defaultValue={initValue} aria-label={ariaLabel} aria-describedby={ariaDescribedBy} onChange={event => onChangeText?.(event.currentTarget.value)} onKeyDown={onKeyDown} onFocus={onFocus} />); export const BlockCode = ({ children }: any) => <pre>{children}</pre>; export const VoidSlider = () => null; export const VoidSwitch = () => null;`,
		'../void-settings-tsx/ModelDropdown.js': `import React from 'react'; export const ModelDropdown = () => <span data-testid='model-dropdown'>gpt-5.6-luna</span>;`,
		'./SidebarThreadSelector.js': `import React from 'react'; export const PastThreadsList = () => <div>Past threads</div>;`,
		'../../../actionIDs.js': `export const VOID_CTRL_L_ACTION_ID = 'void.ctrl-l';`,
		'../../../voidSettingsPane.js': `export const VOID_OPEN_SETTINGS_ACTION_ID = 'void.open-settings';`,
		'../../../../../../../workbench/contrib/void/common/voidSettingsTypes.js': `export type FeatureName = string; export const displayInfoOfProviderName = () => ({ title: 'OpenAI Compatible' }); export const isFeatureNameDisabled = () => false;`,
		'../../../../../../../platform/commands/common/commands.js': `export type ICommandService = any;`,
		'../void-settings-tsx/WarningBox.js': `import React from 'react'; export const WarningBox = ({ text }: any) => <div>{text}</div>;`,
		'../../../../common/modelCapabilities.js': `export const getModelCapabilities = () => ({ reasoningCapabilities: undefined }); export const getIsReasoningEnabledState = () => false;`,
		'lucide-react': `import React from 'react'; const Icon = ({ size: _size, ...props }: any) => <span aria-hidden='true' {...props} />; export { Icon as AlertTriangle, Icon as File, Icon as Ban, Icon as Check, Icon as ChevronRight, Icon as Dot, Icon as FileIcon, Icon as Pencil, Icon as Undo, Icon as Undo2, Icon as X, Icon as Flag, Icon as Copy, Icon as Info, Icon as CirclePlus, Icon as Ellipsis, Icon as CircleEllipsis, Icon as Folder, Icon as ALargeSmall, Icon as TypeOutline, Icon as Text };`,
		'../../../../common/chatThreadServiceTypes.js': `export type ChatMessage = any; export type StagingSelectionItem = any; export type ToolMessage<T = any> = any;`,
		'../../../../common/agentSubagents.js': `export type AgentSubagentRunView = any; export type ChildActivitiesLedger = any; export type ChildActivityRecord = any; export type ChildToolApprovalView = any; export const isActiveChildRun = (run: any) => run.status === 'queued' || run.status === 'running';`,
		'../../../../common/chatCurrentStatusPresentation.js': `export type ChatCurrentStatusPresentation = any; export const canSubmitChatCurrent = () => false; export const getChatCurrentStatusPresentation = ({ childActive }: any) => ({ kind: childActive ? 'running' : 'idle', liveLabel: childActive ? 'Running' : undefined, detail: childActive ? 'Esc to stop' : 'Enter to send', announcement: childActive ? 'Running · Esc to stop' : 'Enter to send', showStop: childActive, sendDisabled: childActive, textarea: { ariaLabel: 'Chat message', ariaDescribedBy: 'status-help' }, statusHelp: { id: 'status-help' }, controls: { send: { id: 'send', ariaLabel: 'Send message', title: 'Send message' }, stop: { id: 'stop', ariaLabel: 'Stop active child run', title: 'Stop active child run' } } });`,
		'../../../../common/chatComposerSubmission.js': `export const beginChatComposerSubmissionFlight = () => () => {}; export const submitChatComposer = async ({ submit }: any) => submit(); export const submitInlineChatEdit = async ({ submit }: any) => submit();`,
		'../../../chatThreadService.js': `export type PendingChatInput = any; export type PendingInputMode = 'queue' | 'steer' | 'stop_and_send';`,
		'../../../../common/toolsServiceTypes.js': `export type BuiltinToolCallParams = any; export type BuiltinToolName = string; export type ToolName = string; export type LintErrorItem = any; export type ToolApprovalType = string; export const approvalTypeOfBuiltinToolName = () => undefined; export const toolApprovalTypes: string[] = [];`,
		'../markdown/ApplyBlockHoverButtons.js': `import React from 'react'; export const CopyButton = () => null; export const JumpToFileButton = () => null; export const JumpToTerminalButton = () => null; export const StatusIndicator = ({ title }: any) => <span>{title}</span>; export const IconShell1 = ({ Icon, ...props }: any) => <button type='button' {...props}>{Icon ? <Icon /> : null}</button>; export const useApplyStreamState = () => undefined;`,
		'../../../../common/helpers/colors.js': `export const acceptAllBg = ''; export const acceptBorder = ''; export const buttonFontSize = ''; export const buttonTextColor = ''; export const rejectAllBg = ''; export const rejectBg = ''; export const rejectBorder = '';`,
		'../../../../common/prompt/prompts.js': `export const builtinToolNames: string[] = []; export const isABuiltinToolName = () => false; export const MAX_TERMINAL_INACTIVE_TIME = 1000;`,
		'./ErrorBoundary.js': `import React from 'react'; export default function ErrorBoundary({ children }: any) { return <>{children}</>; }`,
		'../void-settings-tsx/Settings.js': `import React from 'react'; export const ToolApprovalTypeSwitch = () => null;`,
		'../../../terminalToolService.js': `export const persistentTerminalNameOfId = (id: string) => id;`,
		'../../../../common/mcpServiceTypes.js': `export const removeMCPToolNamePrefix = (name: string) => name;`,
		'../../../../common/applicationToolPresentation.js': `export const applicationToolRoute = (name: string) => name === 'spawn_agent' ? 'application' : 'mcp'; export const applicationToolPresentation = (name: string) => name === 'spawn_agent' ? { title: 'Start child Agent', status: 'Completed', resultDetail: 'spawn receipt' } : undefined; export const shouldOfferGenericToolApproval = () => false;`,
		'../../../../common/assistantMessagePresentation.js': `export const assistantMessagePresentation = () => ({ displayContent: '', reasoning: undefined });`,
		'../../../../common/chatHistoryPresentation.js': `export const shouldShowPersistentChatHistory = () => false;`,
		'../../../../../../../platform/dnd/browser/dnd.js': `export const extractEditorsDropData = () => [];`,
		'../../../../common/pendingChatInputBroker.js': `export const pendingChatInputFingerprint = (input: unknown) => JSON.stringify(input); export const pendingChatInputThreadFingerprint = (inputs: unknown) => JSON.stringify(inputs);`,
	};
	try {
		await build({
			entry: { runtime: entry }, outDir, format: ['iife'], globalName: 'MountedSidebarChatRuntime', splitting: false, clean: true, platform: 'browser', target: 'es2022', silent: true, noExternal: [/^(?!\.).*$/], treeshake: true,
			esbuildPlugins: [{ name: 'mounted-sidebar-chat-dependencies', setup(buildContext) {
				buildContext.onLoad({ filter: /[\\/]src2[\\/]sidebar-tsx[\\/]SidebarChat\.tsx$/ }, args => { assert.strictEqual(path.resolve(args.path), path.resolve(sidebarPath)); sidebarLoads += 1; return undefined; });
				buildContext.onResolve({ filter: /.*/ }, args => { if (path.resolve(args.importer) !== path.resolve(sidebarPath) || args.path === 'react' || args.path === 'react/jsx-runtime') return undefined; assert.ok(Object.hasOwn(modules, args.path), `Missing mounted SidebarChat dependency shim: ${args.path}`); return { path: args.path, namespace: 'mounted-sidebar-dependency' }; });
				buildContext.onLoad({ filter: /.*/, namespace: 'mounted-sidebar-dependency' }, args => { dependencyLoads.set(args.path, (dependencyLoads.get(args.path) ?? 0) + 1); return { contents: modules[args.path], loader: 'tsx', resolveDir: sourceRoot }; });
			} }], esbuildOptions(options) { options.outbase = temporaryRoot; },
		});
		assert.strictEqual(sidebarLoads, 1, 'Expected the actual exported generated SidebarChat module exactly once.'); assert.ok(dependencyLoads.size >= 20, `Expected broad dependency isolation for SidebarChat, got ${dependencyLoads.size}.`);
		const outputs = findJavaScriptFiles(outDir); assert.strictEqual(outputs.length, 1); return { script: read(outputs[0]), dispose: () => fs.rmSync(temporaryRoot, { recursive: true, force: true }) };
	} catch (error) { fs.rmSync(temporaryRoot, { recursive: true, force: true }); throw error; }
};

/** Mounts the production PastThreadsList together with the production pending-row
 * panel.  The fake service only supplies eventful state; admission, filtering,
 * ordering, selection, and the Resume affordance remain the shipped React code. */
const buildPendingHistoryRuntime = async (selectorPath: string, sidebarPath: string) => {
	const sourceRoot = path.resolve(process.cwd()); const temporaryRoot = fs.mkdtempSync(path.join(sourceRoot, '.pending-history-'));
	assert.ok(temporaryRoot.startsWith(`${sourceRoot}${path.sep}`));
	const entry = path.join(temporaryRoot, 'entry.tsx'); const outDir = path.join(temporaryRoot, 'out');
	const selectorImport = path.relative(temporaryRoot, selectorPath).replaceAll('\\', '/');
	const sidebar = read(sidebarPath); const pendingRegion = between(sidebar, 'const pendingInputModeLabel =', 'export const LandingSuggestedPrompts =');
	fs.writeFileSync(entry, `
		import React, { useEffect, useRef, useState } from 'react'; import { createRoot } from 'react-dom/client'; import { flushSync } from 'react-dom'; import { PastThreadsList } from ${JSON.stringify(selectorImport.startsWith('.') ? selectorImport : './' + selectorImport)};
		type PendingInputMode = 'queue' | 'steer' | 'stop_and_send'; type PendingChatInput = any;
		const pendingChatInputFingerprint = (value: any) => JSON.stringify(value); const pendingChatInputThreadFingerprint = (values: any[]) => JSON.stringify(values);
		${pendingRegion}
		const mountedInfo = { mountedIsResolvedRef: { current: true } }; const empty = (id: string) => ({ id, createdAt: '2026-01-01T00:00:00.000Z', lastModified: '2026-01-01T00:00:00.000Z', messages: [], childActivities: { version: 1, records: [], omitted: 0, retentionSaturated: false }, filesWithUserChanges: new Set(), state: { stagingSelections: [], linksOfMessageIdx: {}, mountedInfo } });
		const state: any = { currentThreadId: 'unused', allThreads: { unused: empty('unused'), pending: empty('pending') } }; const pending: Record<string, any[]> = { pending: [] }; const pendingListeners = new Set<(event: any) => void>(); const stateListeners = new Set<() => void>(); const resumeCalls: string[] = []; const editCalls: any[] = []; let resolveEdit: ((accepted: boolean) => void) | undefined;
		const service: any = { state, getPendingChatInputs(id: string) { return pending[id] ?? []; }, onDidChangePendingChatInputs(listener: any) { pendingListeners.add(listener); return { dispose: () => pendingListeners.delete(listener) }; }, switchToThread(id: string) { state.currentThreadId = id; for (const listener of [...stateListeners]) listener(); }, async deleteThread() { return false; }, async editPendingInput(threadId: string, id: string, fingerprint: string, text: string) { editCalls.push({ threadId, id, fingerprint, text }); return new Promise<boolean>(resolve => resolveEdit = resolve); }, async deletePendingInput() { return false; }, async reorderPendingInput() { return false; }, async resumePendingInput(threadId: string, id: string) { resumeCalls.push(threadId + ':' + id); pending[threadId] = (pending[threadId] ?? []).filter(row => row.id !== id); for (const listener of [...pendingListeners]) listener({ threadId }); return true; } };
		(globalThis as any).__pendingHistoryFixture = { service, state, pending, pendingListeners, stateListeners };
		const useCurrentState = () => { const [, setRevision] = useState(0); useEffect(() => { const listener = () => setRevision(value => value + 1); stateListeners.add(listener); return () => { stateListeners.delete(listener); }; }, []); return state; };
		const Harness = () => { const current = useCurrentState(); const [, setPendingRevision] = useState(0); useEffect(() => { const listener = () => setPendingRevision(value => value + 1); pendingListeners.add(listener); return () => { pendingListeners.delete(listener); }; }, []); const inputs = service.getPendingChatInputs(current.currentThreadId); return <><PastThreadsList /><PendingChatInputsPanel threadId={current.currentThreadId} inputs={inputs} onEdit={service.editPendingInput} onDelete={service.deletePendingInput} onReorder={service.reorderPendingInput} onResume={service.resumePendingInput} /></>; };
		let root: ReturnType<typeof createRoot> | undefined; (window as any).__pendingHistory = { mount(node: HTMLElement) { root = createRoot(node); flushSync(() => root!.render(<Harness />)); }, admit() { pending.pending = [{ id: 'pending-1', threadId: 'pending', text: 'PRIVATE_PENDING_TEXT', draft: 'PRIVATE_PENDING_TEXT', selections: [], mode: 'queue', phase: 'dormant', order: 0, createdAt: Date.parse('2026-09-01T00:00:00.000Z'), ownerProjectRoot: 'file:///workspace', trustedAtSubmit: true, generation: 0 }]; for (const listener of [...pendingListeners]) listener({ threadId: 'pending' }); }, resolveEdit(accepted: boolean) { const resolve = resolveEdit; resolveEdit = undefined; resolve?.(accepted); }, editCalls, listeners() { return { pending: pendingListeners.size, state: stateListeners.size }; }, resumeCalls, dispose() { flushSync(() => root?.unmount()); } };
	`, 'utf8');
	const modules: Record<string, string> = {
		'../util/services.js': `import { useEffect, useState } from 'react'; const fixture = () => (globalThis as any).__pendingHistoryFixture; export const useAccessor = () => ({ get: () => fixture().service }); export const useChatThreadsState = () => { const [, setRevision] = useState(0); useEffect(() => { const listener = () => setRevision((value: number) => value + 1); fixture().stateListeners.add(listener); return () => fixture().stateListeners.delete(listener); }, []); return fixture().state; }; export const useFullChatThreadsStreamState = () => ({}); export const useVisibleThreadChildOverviews = () => ({});`,
		'../markdown/ApplyBlockHoverButtons.js': `import React from 'react'; export const IconShell1 = ({ Icon, ...props }: any) => <button {...props}>{Icon ? <Icon /> : null}</button>;`,
		'lucide-react': `import React from 'react'; const Icon = () => <span aria-hidden='true' />; export { Icon as Check, Icon as CircleAlert, Icon as Copy, Icon as LoaderCircle, Icon as MessageCircleQuestion, Icon as Trash2, Icon as X };`,
	};
	try {
		await build({ entry: { runtime: entry }, outDir, format: ['iife'], globalName: 'PendingHistoryRuntime', splitting: false, clean: true, platform: 'browser', target: 'es2022', silent: true, noExternal: [/^(?!\.).*$/], treeshake: true, esbuildPlugins: [{ name: 'pending-history-dependencies', setup(buildContext) {
			buildContext.onResolve({ filter: /.*/ }, args => { if (path.resolve(args.importer) !== path.resolve(selectorPath) || !Object.hasOwn(modules, args.path)) return undefined; return { path: args.path, namespace: 'pending-history-dependency' }; });
			buildContext.onLoad({ filter: /.*/, namespace: 'pending-history-dependency' }, args => ({ contents: modules[args.path], loader: 'tsx', resolveDir: sourceRoot }));
		} }], esbuildOptions(options) { options.outbase = temporaryRoot; } });
		const outputs = findJavaScriptFiles(outDir); assert.strictEqual(outputs.length, 1); return { script: read(outputs[0]), dispose: () => fs.rmSync(temporaryRoot, { recursive: true, force: true }) };
	} catch (error) { fs.rmSync(temporaryRoot, { recursive: true, force: true }); throw error; }
};

suite('Child Run live timing', function () {
	this.timeout(20_000);
	test('refreshes the three views together while active and clears its only timer', async () => {
		const servicesPath = path.join(process.cwd(), 'src', 'vs', 'workbench', 'contrib', 'void', 'browser', 'react', 'src2', 'util', 'services.tsx');
		const sourceSidebarPath = path.join(process.cwd(), 'src', 'vs', 'workbench', 'contrib', 'void', 'browser', 'react', 'src', 'sidebar-tsx', 'SidebarChat.tsx'); const generatedSidebarPath = path.join(process.cwd(), 'src', 'vs', 'workbench', 'contrib', 'void', 'browser', 'react', 'src2', 'sidebar-tsx', 'SidebarChat.tsx');
		for (const sidebarPath of [sourceSidebarPath, generatedSidebarPath]) {
			const sidebar = read(sidebarPath); assert.ok(sidebar.includes('const ChildToolApprovalPanel =')); assert.strictEqual(sidebar.includes('ChildRunPanel'), false); assert.strictEqual(sidebar.includes('Provider requests:'), false); assert.strictEqual(sidebar.includes('Result retention:'), false);
			for (const stale of ['maxChildTurns', 'maxChildRunMs', 'deadlineMsRemaining', 'group deadline', 'Child diagnostics']) assert.strictEqual(sidebar.includes(stale), false, `${path.basename(sidebarPath)} retains ${stale}`);
			const toolBranch = sidebar.indexOf("role === 'tool'"); const earlyRoute = sidebar.indexOf('renderEarlyToolCard(chatMessage)', toolBranch); const applicationRoute = sidebar.indexOf('applicationToolRoute(toolName', toolBranch);
			assert.ok(toolBranch >= 0 && earlyRoute > toolBranch && applicationRoute > earlyRoute, `${path.basename(sidebarPath)} must route skipped rows before typed tool routing`);
		}
		const skippedRuntime = await buildSkippedToolCardRuntime(generatedSidebarPath); const runtime = await buildRuntime(servicesPath); let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
		try {
			browser = await chromium.launch({ headless: true }); const page = await browser.newPage(); const errors: string[] = []; const consoleErrors: string[] = []; page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
			await page.setContent('<!doctype html><div id="skipped-root"></div>'); await page.addScriptTag({ content: skippedRuntime.script }); await page.locator('#skipped-root').evaluate(node => (window as any).__skippedToolCard.mount(node));
			assert.deepStrictEqual(await page.locator('[data-tool-card="skipped"]').evaluateAll(cards => cards.map(card => ({ text: card.textContent, rejected: card.getAttribute('data-rejected') }))), [{ text: 'write_fileSkipped', rejected: 'true' }, { text: 'run_commandSkipped', rejected: 'true' }]);
			assert.strictEqual(await page.locator('[data-tool-card="typed"]').count(), 0);
			assert.deepStrictEqual(await page.evaluate(() => (window as any).__skippedToolCard.hasParams()), [false, false]); assert.deepStrictEqual(await page.evaluate(() => (window as any).__skippedToolCard.rawParamKinds()), ['object', 'object']); await page.evaluate(() => (window as any).__skippedToolCard.dispose());
			await page.setContent('<!doctype html><div id="root"></div>'); await page.addScriptTag({ content: runtime.script }); await page.locator('#root').evaluate(node => (window as any).__childRunTiming.mount(node));
			const fixture = {
				activeTimers: () => page.evaluate(() => (window as any).__childRunTiming.activeTimers()),
				calls: () => page.evaluate(() => (window as any).__childRunTiming.calls),
				cleared: () => page.evaluate(() => (window as any).__childRunTiming.cleared),
				listenerCounts: () => page.evaluate(() => (window as any).__childRunTiming.listenerCounts()),
				advance: (milliseconds: number) => page.evaluate(milliseconds => (window as any).__childRunTiming.advance(milliseconds), milliseconds),
				emitRun: (threadId: string) => page.evaluate(threadId => (window as any).__childRunTiming.emitRun(threadId), threadId),
				emitDiagnostics: (threadId: string) => page.evaluate(threadId => (window as any).__childRunTiming.emitDiagnostics(threadId), threadId),
				completeA: () => page.evaluate(() => { const fixture = (window as any).__childRunTiming; fixture.setState('A', 'completed'); fixture.emitRun('A'); }),
				setThread: (threadId: string) => page.evaluate(threadId => (window as any).__childRunTiming.setThread(threadId), threadId),
				dispose: () => page.evaluate(() => (window as any).__childRunTiming.dispose()),
			};
			assert.strictEqual(await fixture.activeTimers(), 1); assert.deepStrictEqual(await fixture.listenerCounts(), { run: 1, diagnostics: 1 }); assert.strictEqual(await page.locator('#snapshot').textContent(), 'A:running:0:1/64:2:0'); assert.deepStrictEqual(await fixture.calls(), { runs: 2, budget: 2, diagnostics: 2 });
			await fixture.advance(1_000); assert.strictEqual(await page.locator('#snapshot').textContent(), 'A:running:1000:1/64:2:1000'); assert.deepStrictEqual(await fixture.calls(), { runs: 3, budget: 3, diagnostics: 3 });
			await fixture.emitRun('B'); assert.deepStrictEqual(await fixture.calls(), { runs: 3, budget: 3, diagnostics: 3 });
			await fixture.emitDiagnostics('A'); await fixture.emitRun('A'); assert.strictEqual(await fixture.activeTimers(), 1); assert.deepStrictEqual(await fixture.calls(), { runs: 5, budget: 5, diagnostics: 5 });
			await fixture.completeA(); assert.strictEqual(await fixture.activeTimers(), 0); await fixture.advance(1_000); assert.strictEqual(await page.locator('#snapshot').textContent(), 'A:completed:1000:1/64:2:1000');
			await fixture.setThread('C'); assert.strictEqual(await page.locator('#snapshot').textContent(), 'C:undefined:undefined:0/64:3:2000'); assert.strictEqual(await fixture.activeTimers(), 0); assert.deepStrictEqual(await fixture.listenerCounts(), { run: 1, diagnostics: 1 });
			await fixture.setThread('B'); assert.strictEqual(await page.locator('#snapshot').textContent(), 'B:queued:2000:0/64:3:2000'); assert.strictEqual(await fixture.activeTimers(), 1); assert.deepStrictEqual(await fixture.listenerCounts(), { run: 1, diagnostics: 1 });
			const callsBeforeStaleEvent = await fixture.calls(); await fixture.emitDiagnostics('A'); assert.deepStrictEqual(await fixture.calls(), callsBeforeStaleEvent);
			await fixture.dispose(); assert.strictEqual(await fixture.activeTimers(), 0); assert.deepStrictEqual(await fixture.listenerCounts(), { run: 0, diagnostics: 0 }); assert.ok((await fixture.cleared()).length >= 2); assert.deepStrictEqual(errors, []); assert.deepStrictEqual(consoleErrors, []);
		} finally { await browser?.close(); runtime.dispose(); skippedRuntime.dispose(); }
	});
	test('keeps a durable child card beside its exact spawn receipt without changing transcript indices', async function () {
		this.timeout(60_000);
		const sidebarPath = path.join(process.cwd(), 'src', 'vs', 'workbench', 'contrib', 'void', 'browser', 'react', 'src2', 'sidebar-tsx', 'SidebarChat.tsx');
		const servicesPath = path.join(process.cwd(), 'src', 'vs', 'workbench', 'contrib', 'void', 'browser', 'react', 'src2', 'util', 'services.tsx');
		const source = read(sidebarPath); assert.ok(source.includes('childActivityInterleavePlan')); assert.ok(source.includes('messageIdx={previousMessages.length}')); assert.ok(source.includes('streamingChatIdx = previousMessages.length'));
		const mountedSidebarRuntime = await buildMountedSidebarRuntime(sidebarPath); const runtime = await buildChildActivityHistoryRuntime(sidebarPath, servicesPath); let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
		try {
			browser = await chromium.launch({ headless: true }); const page = await browser.newPage(); const errors: string[] = []; const consoleErrors: string[] = []; page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
			await page.setContent('<!doctype html><div id="sidebar-root"></div>'); await page.addScriptTag({ content: mountedSidebarRuntime.script }); assert.strictEqual(await page.evaluate(() => typeof (window as any).__mountedSidebarChat?.mount), 'function', `mounted SidebarChat runtime failed before registration: ${errors.join('\n')}`); await page.locator('#sidebar-root').evaluate(node => (window as any).__mountedSidebarChat.mount(node));
			const staleComposerDetails = ['Child Run', 'Provider requests:', 'Result retention:', 'Child diagnostics', 'Usage unavailable', 'frozen profile', 'technical metadata'];
			const landingApproval = page.locator('[aria-label="Child tool approvals"]'); assert.strictEqual(await landingApproval.count(), 1); assert.strictEqual(await landingApproval.evaluate(node => node.parentElement?.children.length), 1, 'Landing composer ancillary area must contain only the pending approval surface.');
			for (const stale of staleComposerDetails) assert.strictEqual(await page.getByText(stale, { exact: false }).count(), 0, `Landing SidebarChat leaked composer child progress: ${stale}`);
			const exactApprovalKey = { parentId: 'thread-current', generation: 7, childId: 'child-root', batchId: 'batch-1', batchOrdinal: 0, toolId: 'write-tool-1', snapshotRevision: 'snapshot-r1' };
			await page.getByRole('button', { name: 'Approve write_file for child child-ro' }).click(); assert.deepStrictEqual(await page.evaluate(() => (window as any).__mountedSidebarChat.approvals), [exactApprovalKey]); assert.deepStrictEqual(await page.evaluate(() => (window as any).__mountedSidebarChat.rejections), []); assert.strictEqual(await page.evaluate(() => (window as any).__mountedSidebarChat.approvalIdentity()), true); assert.strictEqual(await page.evaluate(() => (window as any).__mountedSidebarChat.keyFrozen()), true);
			await page.evaluate(() => (window as any).__mountedSidebarChat.setMode('current'));
			const currentApproval = page.locator('[aria-label="Child tool approvals"]'); assert.strictEqual(await currentApproval.count(), 1); for (const stale of staleComposerDetails) assert.strictEqual(await page.getByText(stale, { exact: false }).count(), 0, `Current SidebarChat leaked composer child progress: ${stale}`);
			const mountedCard = page.locator('[data-testid=child-activity-card]'); assert.strictEqual(await mountedCard.count(), 1); assert.ok((await mountedCard.evaluate(node => node.previousElementSibling?.textContent))?.includes('Start child Agent'), 'Durable card must be the next transcript element after the exact spawn receipt.');
			const mountedSummary = mountedCard.locator('summary'); assert.strictEqual(await mountedSummary.getAttribute('aria-label'), 'Child Activity child-ro running'); assert.ok((await mountedSummary.textContent())?.includes('1250ms')); await mountedSummary.click(); assert.ok((await mountedCard.textContent())?.includes('LIVE_OVERLAY')); assert.ok((await mountedCard.textContent())?.includes('1240ms running')); assert.strictEqual((await mountedCard.textContent())?.includes('DURABLE_DONE'), false); assert.strictEqual((await mountedCard.textContent())?.includes('90ms total'), false);
			await page.getByRole('button', { name: 'Reject write_file for child child-ro' }).click(); assert.deepStrictEqual(await page.evaluate(() => (window as any).__mountedSidebarChat.rejections), [exactApprovalKey]); assert.strictEqual(await page.evaluate(() => (window as any).__mountedSidebarChat.rejectionIdentity()), true); await page.evaluate(() => (window as any).__mountedSidebarChat.dispose());
			await page.setContent('<!doctype html><div id="root"></div>'); await page.addScriptTag({ content: runtime.script }); assert.strictEqual(await page.evaluate(() => typeof (window as any).__childActivityHistory?.mount), 'function', `history runtime failed before registration: ${errors.join('\n')}`); await page.locator('#root').evaluate(node => (window as any).__childActivityHistory.mount(node));
			assert.deepStrictEqual(await page.locator('main > *').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-message') ?? node.getAttribute('data-testid'))), ['0', '1', 'child-activity-card', '2']); assert.strictEqual(await page.locator('[data-testid=child-activity-card]').count(), 1); assert.strictEqual(await page.locator('text=RAW_TRANSCRIPT').count(), 0); const approvals = page.locator('[aria-label="Child tool approvals"]'); assert.strictEqual(await approvals.count(), 1); assert.strictEqual(await page.getByRole('button', { name: 'Approve write_file for child root' }).count(), 1); assert.strictEqual(await page.locator('text=Child Run').count(), 0); assert.strictEqual(await approvals.getByText('LIVE_PROGRESS').count(), 0); assert.strictEqual(await page.locator('[aria-live=polite]').count(), 0); assert.strictEqual(await page.locator('[data-testid=child-activity-card] [aria-live]').count(), 0);
			const card = page.locator('[data-testid=child-activity-card]'); const summary = card.locator('summary'); assert.strictEqual(await page.evaluate(() => (window as any).__childActivityHistory.timers()), 1); assert.deepStrictEqual(await page.evaluate(() => (window as any).__childActivityHistory.listeners()), { run: 2, diagnostics: 1, persistence: 1 }); assert.strictEqual(await card.evaluate(node => (node as HTMLDetailsElement).open), false); await summary.focus(); await summary.click(); assert.strictEqual(await card.evaluate(node => (node as HTMLDetailsElement).open), true); await summary.press('Enter'); assert.strictEqual(await card.evaluate(node => (node as HTMLDetailsElement).open), false); await summary.press(' '); assert.strictEqual(await card.evaluate(node => (node as HTMLDetailsElement).open), true); assert.strictEqual(await summary.evaluate(node => document.activeElement === node), true); assert.ok((await card.textContent())?.includes('LIVE_PROGRESS')); assert.ok((await card.textContent())?.includes('NESTED_LIVE'));
			await page.evaluate(() => (window as any).__childActivityHistory.advance(1_000)); assert.ok((await card.textContent())?.includes('1010ms')); assert.strictEqual(await page.evaluate(() => (window as any).__childActivityHistory.storageWrites()), 0);
			await page.evaluate(() => (window as any).__childActivityHistory.settle()); assert.strictEqual(await page.evaluate(() => (window as any).__childActivityHistory.sameCard()), true); assert.ok((await card.textContent())?.includes('DURABLE_TERMINAL')); assert.strictEqual(await page.locator('text=LIVE_PROGRESS').count(), 0); assert.strictEqual(await page.evaluate(() => (window as any).__childActivityHistory.storageWrites()), 1); assert.strictEqual(await page.evaluate(() => (window as any).__childActivityHistory.timers()), 0); await page.evaluate(() => (window as any).__childActivityHistory.dispose()); assert.strictEqual(await page.evaluate(() => (window as any).__childActivityHistory.timers()), 0); assert.deepStrictEqual(await page.evaluate(() => (window as any).__childActivityHistory.listeners()), { run: 0, diagnostics: 0, persistence: 0 }); assert.deepStrictEqual(errors, []); assert.deepStrictEqual(consoleErrors, []);
		} finally { await browser?.close(); runtime.dispose(); mountedSidebarRuntime.dispose(); }
	});
	test('shows a W3 dormant zero-message chat on broker events and exposes the exact Resume action', async function () {
		this.timeout(60_000);
		const selectorPath = path.join(process.cwd(), 'src', 'vs', 'workbench', 'contrib', 'void', 'browser', 'react', 'src', 'sidebar-tsx', 'SidebarThreadSelector.tsx');
		const sidebarPath = path.join(process.cwd(), 'src', 'vs', 'workbench', 'contrib', 'void', 'browser', 'react', 'src', 'sidebar-tsx', 'SidebarChat.tsx');
		const runtime = await buildPendingHistoryRuntime(selectorPath, sidebarPath); let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
		try {
			browser = await chromium.launch({ headless: true }); const page = await browser.newPage(); const errors: string[] = []; const consoleErrors: string[] = []; page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
			await page.setContent('<!doctype html><div id="root"></div>'); await page.addScriptTag({ content: runtime.script }); await page.locator('#root').evaluate(node => (window as any).__pendingHistory.mount(node));
			const history = page.locator('[role="group"][aria-label="Chat history"]'); assert.strictEqual(await history.count(), 1, `mounted history missing: ${await page.locator('body').innerHTML()}\n${errors.join('\n')}`); assert.strictEqual(await page.locator('[data-chat-history-thread-id]').count(), 0, 'an unused blank anchor must stay hidden'); assert.strictEqual((await history.textContent())?.includes('PRIVATE_PENDING_TEXT'), false);
			await page.evaluate(() => (window as any).__pendingHistory.admit()); const pendingRow = page.locator('[data-chat-history-thread-id="pending"]'); await pendingRow.waitFor(); assert.ok((await pendingRow.getAttribute('aria-label'))?.includes('0 messages')); assert.ok((await pendingRow.getAttribute('aria-label'))?.includes('Pending')); assert.strictEqual((await history.textContent())?.includes('PRIVATE_PENDING_TEXT'), false, 'the history row must not leak pending content'); assert.strictEqual(await page.getByRole('button', { name: /Duplicate chat:/ }).count(), 0, 'a pending-only blank must not offer Duplicate');
			await pendingRow.click(); const resume = page.getByRole('button', { name: 'Resume' }); await resume.waitFor(); assert.ok((await page.getByRole('region', { name: 'Queued messages' }).textContent())?.includes('Ready to resume'));
			await page.getByRole('button', { name: 'Edit' }).click(); const queuedEdit = page.getByRole('textbox', { name: 'Edit queued message' }); await queuedEdit.fill('VISIBLE_CAPTURED_EDIT'); const queuedRow = queuedEdit.locator('xpath=ancestor::*[@role="listitem"][1]'); const saveQueuedEdit = queuedRow.getByRole('button', { name: 'Save' }); assert.strictEqual(await saveQueuedEdit.count(), 1, `queued edit row lost its Save action: ${await queuedRow.innerHTML()}`); await saveQueuedEdit.click(); await page.waitForFunction(() => (document.querySelector('textarea[aria-label="Edit queued message"]') as HTMLTextAreaElement | null)?.disabled === true); assert.strictEqual(await queuedEdit.inputValue(), 'VISIBLE_CAPTURED_EDIT'); await page.keyboard.type('MUST_NOT_MUTATE'); assert.strictEqual(await queuedEdit.inputValue(), 'VISIBLE_CAPTURED_EDIT', 'a deferred queued Save must visibly lock its exact textarea'); assert.deepStrictEqual(await page.evaluate(() => (window as any).__pendingHistory.editCalls.map((call: any) => call.text)), ['VISIBLE_CAPTURED_EDIT']);
			await page.evaluate(() => (window as any).__pendingHistory.resolveEdit(false)); await page.waitForFunction(() => (document.querySelector('textarea[aria-label="Edit queued message"]') as HTMLTextAreaElement | null)?.disabled === false); assert.strictEqual(await queuedEdit.inputValue(), 'VISIBLE_CAPTURED_EDIT', 'rejection must unlock without clearing the visible edit'); await queuedRow.getByRole('button', { name: 'Cancel' }).click();
			await resume.click(); await page.waitForFunction(() => document.querySelector('[data-chat-history-thread-id="pending"]') === null); assert.deepStrictEqual(await page.evaluate(() => (window as any).__pendingHistory.resumeCalls), ['pending:pending-1']); assert.strictEqual(await page.locator('[data-chat-history-thread-id]').count(), 0);
			await page.evaluate(() => (window as any).__pendingHistory.dispose()); assert.deepStrictEqual(await page.evaluate(() => (window as any).__pendingHistory.listeners()), { pending: 0, state: 0 }); assert.deepStrictEqual(errors, []); assert.deepStrictEqual(consoleErrors, []);
		} finally { await browser?.close(); runtime.dispose(); }
	});
});
