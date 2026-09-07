/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { chromium } from '@playwright/test';
import { build } from 'tsup';

const read = (filePath: string): string => fs.readFileSync(filePath, 'utf8');
const occurrences = (text: string, value: string): number => text.split(value).length - 1;
const between = (text: string, start: string, end: string): string => {
	const startIndex = text.indexOf(start);
	const endIndex = text.indexOf(end, startIndex + start.length);
	assert.ok(startIndex >= 0 && endIndex > startIndex, `Expected bounded source region: ${start}`);
	return text.slice(startIndex, endIndex);
};
const findJavaScriptFiles = (directory: string): string[] => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? findJavaScriptFiles(path.join(directory, entry.name)) : entry.isFile() && entry.name.endsWith('.js') ? [path.join(directory, entry.name)] : []);

const buildRuntime = async (generatedSidebarPath: string) => {
	const sourceRoot = path.resolve(process.cwd());
	const temporaryRoot = fs.mkdtempSync(path.join(sourceRoot, '.landing-suggestion-button-'));
	assert.ok(temporaryRoot.startsWith(`${sourceRoot}${path.sep}`));
	const entryPath = path.join(temporaryRoot, 'entry.tsx');
	const outDir = path.join(temporaryRoot, 'out');
	const component = between(read(generatedSidebarPath), 'export const LandingSuggestedPrompts =', 'export const SidebarChat =');
	const relativeSidebarPath = path.relative(temporaryRoot, generatedSidebarPath).replaceAll('\\', '/');
	const importPath = relativeSidebarPath.startsWith('.') ? relativeSidebarPath : `./${relativeSidebarPath}`;
	let productionModuleLoads = 0;
	fs.writeFileSync(entryPath, `
		import React, { useState } from 'react';
		import { createRoot } from 'react-dom/client';
		import { flushSync } from 'react-dom';
		import { LandingSuggestedPrompts } from ${JSON.stringify(importPath)};
		const submissions: string[] = []; let formSubmits = 0; let root: ReturnType<typeof createRoot> | undefined; let setDisabled: (disabled: boolean) => void;
		const Harness = () => { const [disabled, updateDisabled] = useState(false); setDisabled = updateDisabled; return <form onSubmit={event => { formSubmits += 1; event.preventDefault(); }}><LandingSuggestedPrompts disabled={disabled} onSubmit={text => submissions.push(text)} /></form>; };
		(window as any).__landingSuggestionButton = { submissions, getFormSubmits: () => formSubmits, mount(node: HTMLElement) { root = createRoot(node); flushSync(() => root!.render(<Harness />)); }, setDisabled(value: boolean) { flushSync(() => setDisabled(value)); }, dispose() { flushSync(() => root?.unmount()); } };
	`, 'utf8');
	try {
		await build({
			entry: { runtime: entryPath }, outDir, format: ['iife'], globalName: 'LandingSuggestionButtonRuntime', splitting: false, clean: true, platform: 'browser', target: 'es2022', silent: true, noExternal: [/^(?!\.).*$/], treeshake: true,
			esbuildPlugins: [{
				name: 'generated-landing-suggestions-only',
				setup(buildContext) {
					buildContext.onLoad({ filter: /[\\/]src2[\\/]sidebar-tsx[\\/]SidebarChat\.tsx$/ }, args => {
						assert.strictEqual(path.resolve(args.path), path.resolve(generatedSidebarPath));
						productionModuleLoads += 1;
						return { contents: `import React from 'react';\n${component}`, loader: 'tsx', resolveDir: path.dirname(args.path) };
					});
				},
			}],
			esbuildOptions(options) { options.outbase = temporaryRoot; },
		});
		assert.strictEqual(productionModuleLoads, 1, 'Expected the runtime bundle to import the generated production landing component exactly once.');
		const outputs = findJavaScriptFiles(outDir);
		assert.strictEqual(outputs.length, 1, 'Expected exactly one scoped landing-suggestion runtime bundle.');
		return { script: read(outputs[0]), dispose: () => fs.rmSync(temporaryRoot, { recursive: true, force: true }) };
	} catch (error) {
		fs.rmSync(temporaryRoot, { recursive: true, force: true });
		throw error;
	}
};

suite('Landing suggestion buttons', function () {
	this.timeout(20_000);

	test('uses native buttons that submit each forced prompt once and disables for unavailable Chat or a pending submission', async () => {
		const root = process.cwd();
		const sourceSidebarPath = path.join(root, 'src', 'vs', 'workbench', 'contrib', 'void', 'browser', 'react', 'src', 'sidebar-tsx', 'SidebarChat.tsx');
		const generatedSidebarPath = path.join(root, 'src', 'vs', 'workbench', 'contrib', 'void', 'browser', 'react', 'src2', 'sidebar-tsx', 'SidebarChat.tsx');
		const generatedStylesPath = path.join(root, 'src', 'vs', 'workbench', 'contrib', 'void', 'browser', 'react', 'src2', 'styles.css');
		const source = read(sourceSidebarPath);
		const sourceComponent = between(source, 'export const LandingSuggestedPrompts =', 'export const SidebarChat =');
		const generatedComponent = between(read(generatedSidebarPath), 'export const LandingSuggestedPrompts =', 'export const SidebarChat =');
		for (const component of [sourceComponent, generatedComponent]) {
			assert.strictEqual(occurrences(component, '<button'), 1);
			assert.strictEqual(occurrences(component, "type='button'"), 1);
			assert.strictEqual(occurrences(component, 'disabled={disabled}'), 1);
			assert.strictEqual(occurrences(component, 'onClick={() => onSubmit(text)}'), 1);
			assert.strictEqual(occurrences(component, "'Summarize my codebase'"), 1);
			assert.strictEqual(occurrences(component, "'How do types work in Rust?'"), 1);
			assert.strictEqual(occurrences(component, 'onKeyDown'), 0);
			assert.strictEqual(occurrences(component, 'text-left'), 1);
			assert.strictEqual(occurrences(component, 'w-full'), 2);
		}
		assert.strictEqual(occurrences(sourceComponent, 'focus-ring'), 1);
		assert.strictEqual(occurrences(generatedComponent, 'void-focus-ring'), 1);
		const sourceCallSite = between(source, 'const initiallySuggestedPromptsHTML =', 'const threadPageInput =');
		assert.strictEqual(sourceCallSite.trim(), 'const initiallySuggestedPromptsHTML = <LandingSuggestedPrompts onSubmit={onSubmit} disabled={chatModelUnavailable || pendingComposerActionInFlight} />');
		assert.strictEqual(occurrences(sourceCallSite, 'currentStatusPresentation.sendDisabled'), 0);

		const runtime = await buildRuntime(generatedSidebarPath);
		let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
		try {
			browser = await chromium.launch({ headless: true });
			const page = await browser.newPage();
			const pageErrors: string[] = [];
			const consoleErrors: string[] = [];
			page.on('pageerror', error => pageErrors.push(error.message));
			page.on('console', message => { if (message.type() === 'error') { consoleErrors.push(message.text()); } });
			await page.setContent('<!doctype html><div class="void-scope" id="root" style="--void-ring-color:#1177cb"></div>');
			await page.addStyleTag({ content: read(generatedStylesPath) });
			await page.addScriptTag({ content: runtime.script });
			await page.locator('#root').evaluate(node => (window as any).__landingSuggestionButton.mount(node));
			const first = page.getByRole('button', { name: 'Summarize my codebase' });
			const second = page.getByRole('button', { name: 'How do types work in Rust?' });
			assert.strictEqual(await first.count(), 1);
			assert.strictEqual(await second.count(), 1);
			assert.deepStrictEqual(await page.locator('button[type=button]').evaluateAll(buttons => buttons.map(button => ({ text: button.textContent, disabled: (button as HTMLButtonElement).disabled }))), [
				{ text: 'Summarize my codebase', disabled: false }, { text: 'How do types work in Rust?', disabled: false },
			]);
			await page.keyboard.press('Tab');
			assert.strictEqual(await first.evaluate(button => document.activeElement === button), true);
			assert.deepStrictEqual(await first.evaluate(button => {
				const style = getComputedStyle(button);
				return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth, outlineOffset: style.outlineOffset, outlineColor: style.outlineColor };
			}), { outlineStyle: 'solid', outlineWidth: '2px', outlineOffset: '2px', outlineColor: 'rgb(17, 119, 203)' });
			await first.press('Enter');
			assert.strictEqual(await page.evaluate(() => (window as any).__landingSuggestionButton.getFormSubmits()), 0);
			await second.press('Space');
			assert.strictEqual(await page.evaluate(() => (window as any).__landingSuggestionButton.getFormSubmits()), 0);
			await first.click();
			assert.strictEqual(await page.evaluate(() => (window as any).__landingSuggestionButton.getFormSubmits()), 0);
			assert.deepStrictEqual(await page.evaluate(() => (window as any).__landingSuggestionButton.submissions), ['Summarize my codebase', 'How do types work in Rust?', 'Summarize my codebase']);
			assert.strictEqual(await page.locator('form').evaluate(form => (form as HTMLFormElement).checkValidity()), true);

			await page.evaluate(() => (window as any).__landingSuggestionButton.setDisabled(true));
			assert.deepStrictEqual(await page.locator('button[type=button]').evaluateAll(buttons => buttons.map(button => (button as HTMLButtonElement).disabled)), [true, true]);
			const beforeDisabledDispatch = await page.evaluate(() => (window as any).__landingSuggestionButton.submissions.length);
			await first.evaluate(button => (button as HTMLButtonElement).click());
			assert.strictEqual(await page.evaluate(() => (window as any).__landingSuggestionButton.getFormSubmits()), 0);
			await first.press('Enter');
			assert.strictEqual(await page.evaluate(() => (window as any).__landingSuggestionButton.getFormSubmits()), 0);
			await first.press('Space');
			assert.strictEqual(await page.evaluate(() => (window as any).__landingSuggestionButton.getFormSubmits()), 0);
			const box = await first.boundingBox();
			assert.ok(box);
			await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
			assert.strictEqual(await page.evaluate(() => (window as any).__landingSuggestionButton.submissions.length), beforeDisabledDispatch);
			assert.strictEqual(await page.evaluate(() => (window as any).__landingSuggestionButton.getFormSubmits()), 0);
			await page.evaluate(() => (window as any).__landingSuggestionButton.dispose());
			assert.deepStrictEqual(pageErrors, []);
			assert.deepStrictEqual(consoleErrors, []);
		} finally {
			try { await browser?.close(); } finally { runtime.dispose(); }
		}
	});
});
