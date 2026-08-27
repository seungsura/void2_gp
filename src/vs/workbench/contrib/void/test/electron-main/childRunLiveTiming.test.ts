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
			getRunViews(id: string) { calls.runs++; return [{ id, status: states[id], totalMs: now, queuedMs: now, runningMs: now }]; },
			getBudgetView(id: string) { calls.budget++; return { parentId: id, deadlineMsRemaining: 10000 - now }; },
			getDiagnosticsView(id: string) { calls.diagnostics++; return { parentId: id, elapsedMs: now }; },
			onDidChangeRun(listener: any) { return listen(runListeners, listener); }, onDidChangeDiagnostics(listener: any) { return listen(diagnosticsListeners, listener); },
		};
		const generic = new Proxy({ state: {}, streamState: {}, getColorTheme: () => ({ type: 'dark' }) }, { get(target, key) { if (key in target) return (target as any)[key]; if (typeof key === 'string' && key.startsWith('onDidChange')) return () => ({ dispose() {} }); return () => undefined; } });
		_registerServices({ get(identifier: any) { return String(identifier).includes('voidAgentSubagentService') ? child : generic; } } as any);
		const timers = new Map<number, () => void>(); const cleared: number[] = []; let nextTimer = 1;
		window.setInterval = ((callback: TimerHandler) => { const id = nextTimer++; timers.set(id, callback as () => void); return id; }) as typeof window.setInterval;
		window.clearInterval = ((id: number) => { cleared.push(id); timers.delete(id); }) as typeof window.clearInterval;
		let updateThread!: (id: string) => void; let root: ReturnType<typeof createRoot> | undefined;
		const Harness = () => { const [threadId, setThreadId] = useState('A'); updateThread = setThreadId; const value = useAgentSubagentLiveSnapshot(threadId); const run = value.runs[0]; return <output id="snapshot">{threadId + ':' + run?.status + ':' + run?.totalMs + ':' + value.budget?.deadlineMsRemaining + ':' + value.diagnostics?.elapsedMs}</output>; };
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

suite('Child Run live timing', function () {
	this.timeout(20_000);
	test('refreshes the three views together while active and clears its only timer', async () => {
		const servicesPath = path.join(process.cwd(), 'src', 'vs', 'workbench', 'contrib', 'void', 'browser', 'react', 'src2', 'util', 'services.tsx');
		const runtime = await buildRuntime(servicesPath); let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
		try {
			browser = await chromium.launch({ headless: true }); const page = await browser.newPage(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
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
			assert.strictEqual(await fixture.activeTimers(), 1); assert.deepStrictEqual(await fixture.listenerCounts(), { run: 1, diagnostics: 1 }); assert.strictEqual(await page.locator('#snapshot').textContent(), 'A:running:0:10000:0'); assert.deepStrictEqual(await fixture.calls(), { runs: 2, budget: 2, diagnostics: 2 });
			await fixture.advance(1_000); assert.strictEqual(await page.locator('#snapshot').textContent(), 'A:running:1000:9000:1000'); assert.deepStrictEqual(await fixture.calls(), { runs: 3, budget: 3, diagnostics: 3 });
			await fixture.emitRun('B'); assert.deepStrictEqual(await fixture.calls(), { runs: 3, budget: 3, diagnostics: 3 });
			await fixture.emitDiagnostics('A'); await fixture.emitRun('A'); assert.strictEqual(await fixture.activeTimers(), 1); assert.deepStrictEqual(await fixture.calls(), { runs: 5, budget: 5, diagnostics: 5 });
			await fixture.completeA(); assert.strictEqual(await fixture.activeTimers(), 0); await fixture.advance(1_000); assert.strictEqual(await page.locator('#snapshot').textContent(), 'A:completed:1000:9000:1000');
			await fixture.setThread('B'); assert.strictEqual(await page.locator('#snapshot').textContent(), 'B:queued:2000:8000:2000'); assert.strictEqual(await fixture.activeTimers(), 1); assert.deepStrictEqual(await fixture.listenerCounts(), { run: 1, diagnostics: 1 });
			const callsBeforeStaleEvent = await fixture.calls(); await fixture.emitDiagnostics('A'); assert.deepStrictEqual(await fixture.calls(), callsBeforeStaleEvent);
			await fixture.dispose(); assert.strictEqual(await fixture.activeTimers(), 0); assert.deepStrictEqual(await fixture.listenerCounts(), { run: 0, diagnostics: 0 }); assert.ok((await fixture.cleared()).length >= 2); assert.deepStrictEqual(errors, []);
		} finally { await browser?.close(); runtime.dispose(); }
	});
});
