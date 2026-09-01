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
		this.timeout(40_000);
		const sidebarPath = path.join(process.cwd(), 'src', 'vs', 'workbench', 'contrib', 'void', 'browser', 'react', 'src2', 'sidebar-tsx', 'SidebarChat.tsx');
		const servicesPath = path.join(process.cwd(), 'src', 'vs', 'workbench', 'contrib', 'void', 'browser', 'react', 'src2', 'util', 'services.tsx');
		const source = read(sidebarPath); assert.ok(source.includes('childActivityInterleavePlan')); assert.ok(source.includes('messageIdx={previousMessages.length}')); assert.ok(source.includes('streamingChatIdx = previousMessages.length'));
		const runtime = await buildChildActivityHistoryRuntime(sidebarPath, servicesPath); let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
		try {
			browser = await chromium.launch({ headless: true }); const page = await browser.newPage(); const errors: string[] = []; const consoleErrors: string[] = []; page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
			await page.setContent('<!doctype html><div id="root"></div>'); await page.addScriptTag({ content: runtime.script }); assert.strictEqual(await page.evaluate(() => typeof (window as any).__childActivityHistory?.mount), 'function', `history runtime failed before registration: ${errors.join('\n')}`); await page.locator('#root').evaluate(node => (window as any).__childActivityHistory.mount(node));
			assert.deepStrictEqual(await page.locator('main > *').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-message') ?? node.getAttribute('data-testid'))), ['0', '1', 'child-activity-card', '2']); assert.strictEqual(await page.locator('[data-testid=child-activity-card]').count(), 1); assert.strictEqual(await page.locator('text=RAW_TRANSCRIPT').count(), 0); const approvals = page.locator('[aria-label="Child tool approvals"]'); assert.strictEqual(await approvals.count(), 1); assert.strictEqual(await page.getByRole('button', { name: 'Approve write_file for child root' }).count(), 1); assert.strictEqual(await page.locator('text=Child Run').count(), 0); assert.strictEqual(await approvals.getByText('LIVE_PROGRESS').count(), 0); assert.strictEqual(await page.locator('[aria-live=polite]').count(), 0); assert.strictEqual(await page.locator('[data-testid=child-activity-card] [aria-live]').count(), 0);
			const card = page.locator('[data-testid=child-activity-card]'); const summary = card.locator('summary'); assert.strictEqual(await page.evaluate(() => (window as any).__childActivityHistory.timers()), 1); assert.deepStrictEqual(await page.evaluate(() => (window as any).__childActivityHistory.listeners()), { run: 2, diagnostics: 1, persistence: 1 }); assert.strictEqual(await card.evaluate(node => (node as HTMLDetailsElement).open), false); await summary.focus(); await summary.click(); assert.strictEqual(await card.evaluate(node => (node as HTMLDetailsElement).open), true); await summary.press('Enter'); assert.strictEqual(await card.evaluate(node => (node as HTMLDetailsElement).open), false); await summary.press(' '); assert.strictEqual(await card.evaluate(node => (node as HTMLDetailsElement).open), true); assert.strictEqual(await summary.evaluate(node => document.activeElement === node), true); assert.ok((await card.textContent())?.includes('LIVE_PROGRESS')); assert.ok((await card.textContent())?.includes('NESTED_LIVE'));
			await page.evaluate(() => (window as any).__childActivityHistory.advance(1_000)); assert.ok((await card.textContent())?.includes('1010ms')); assert.strictEqual(await page.evaluate(() => (window as any).__childActivityHistory.storageWrites()), 0);
			await page.evaluate(() => (window as any).__childActivityHistory.settle()); assert.strictEqual(await page.evaluate(() => (window as any).__childActivityHistory.sameCard()), true); assert.ok((await card.textContent())?.includes('DURABLE_TERMINAL')); assert.strictEqual(await page.locator('text=LIVE_PROGRESS').count(), 0); assert.strictEqual(await page.evaluate(() => (window as any).__childActivityHistory.storageWrites()), 1); assert.strictEqual(await page.evaluate(() => (window as any).__childActivityHistory.timers()), 0); await page.evaluate(() => (window as any).__childActivityHistory.dispose()); assert.strictEqual(await page.evaluate(() => (window as any).__childActivityHistory.timers()), 0); assert.deepStrictEqual(await page.evaluate(() => (window as any).__childActivityHistory.listeners()), { run: 0, diagnostics: 0, persistence: 0 }); assert.deepStrictEqual(errors, []); assert.deepStrictEqual(consoleErrors, []);
		} finally { await browser?.close(); runtime.dispose(); }
	});
});
