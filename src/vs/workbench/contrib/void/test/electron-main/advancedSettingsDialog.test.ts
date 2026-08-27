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

const buildRuntime = async (generatedSettingsPath: string) => {
	const sourceRoot = path.resolve(process.cwd());
	const temporaryRoot = fs.mkdtempSync(path.join(sourceRoot, '.advanced-settings-dialog-'));
	assert.ok(temporaryRoot.startsWith(`${sourceRoot}${path.sep}`));
	const entryPath = path.join(temporaryRoot, 'entry.tsx');
	const outDir = path.join(temporaryRoot, 'out');
	const component = between(read(generatedSettingsPath), 'const SimpleModelSettingsDialog =', 'export const ModelDump =');
	const relativeSettingsPath = path.relative(temporaryRoot, generatedSettingsPath).replaceAll('\\', '/');
	const importPath = relativeSettingsPath.startsWith('.') ? relativeSettingsPath : `./${relativeSettingsPath}`;
	let productionModuleLoads = 0;
	fs.writeFileSync(entryPath, `
		import React, { useRef, useState } from 'react';
		import { createRoot } from 'react-dom/client';
		import { flushSync } from 'react-dom';
		import { SimpleModelSettingsDialog, advancedSettingsDialogFixture } from ${JSON.stringify(importPath)};
		let closeCount = 0; let mountedRoot: ReturnType<typeof createRoot> | undefined;
		const Harness = () => {
			const [open, setOpen] = useState(false);
			const openerRef = useRef<HTMLButtonElement | null>(null);
			return <><button type="button" onClick={event => { openerRef.current = event.currentTarget; setOpen(true); }}>Open fixture advanced settings</button>{open ? <SimpleModelSettingsDialog isOpen={true} onClose={() => { closeCount += 1; setOpen(false); }} modelInfo={{ modelName: 'gpt-5.6-luna', providerName: 'openAICompatible' as any, type: 'default' }} openerRef={openerRef} /> : null}</>;
		};
		(window as any).__advancedSettingsDialog = {
			persisted: advancedSettingsDialogFixture.persisted, getCloseCount: () => closeCount,
			mount(node: HTMLElement) { mountedRoot = createRoot(node); flushSync(() => mountedRoot!.render(<Harness />)); },
			dispose() { flushSync(() => mountedRoot?.unmount()); },
		};
	`, 'utf8');
	try {
		await build({
			entry: { runtime: entryPath }, outDir, format: ['iife'], globalName: 'AdvancedSettingsDialogRuntime', splitting: false, clean: true, platform: 'browser', target: 'es2022', silent: true, noExternal: [/^(?!\.).*$/], treeshake: true,
			esbuildPlugins: [{
				name: 'generated-advanced-settings-dialog-only',
				setup(buildContext) {
					buildContext.onLoad({ filter: /[\\/]src2[\\/]void-settings-tsx[\\/]Settings\.tsx$/ }, args => {
						assert.strictEqual(path.resolve(args.path), path.resolve(generatedSettingsPath));
						productionModuleLoads += 1;
						return { contents: `
							import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
							const modelOverrideKeys = ['contextWindow', 'temperature'];
							const displayInfoOfProviderName = (_providerName: string) => ({ title: 'OpenAI Compatible' });
							const getModelCapabilities = () => ({ contextWindow: 128, temperature: 1, recognizedModelName: 'Fixture model', isUnrecognizedModel: false });
							const persisted: unknown[] = [];
							const settingsState = { overridesOfModel: {} };
							const settingsStateService = { setOverridesOfModel: async (_providerName: string, _modelName: string, overrides: unknown) => { persisted.push(overrides); } };
							const useAccessor = () => ({ get: (_service: string) => settingsStateService });
							const useSettingsState = () => settingsState;
							const VoidSwitch = ({ ariaLabel, value, onChange }: any) => <button type="button" role="switch" aria-label={ariaLabel} aria-checked={value} onClick={() => onChange(!value)} style={{ width: 16, height: 16 }} />;
							const VoidButtonBgDarken = ({ children, onClick, className }: any) => <button type="button" onClick={onClick} className={className}>{children}</button>;
							const ChatMarkdownRender = () => null;
							const X = () => <span aria-hidden="true">×</span>;
							${component}
							export { SimpleModelSettingsDialog };
							export const advancedSettingsDialogFixture = { persisted };
						`, loader: 'tsx', resolveDir: path.dirname(args.path) };
					});
				},
			}],
			esbuildOptions(options) { options.outbase = temporaryRoot; },
		});
		assert.strictEqual(productionModuleLoads, 1, 'Expected the runtime bundle to import the generated production advanced Settings dialog exactly once.');
		const outputs = findJavaScriptFiles(outDir);
		assert.strictEqual(outputs.length, 1, 'Expected exactly one scoped advanced Settings dialog runtime bundle.');
		return { script: read(outputs[0]), dispose: () => fs.rmSync(temporaryRoot, { recursive: true, force: true }) };
	} catch (error) {
		fs.rmSync(temporaryRoot, { recursive: true, force: true });
		throw error;
	}
};

suite('Advanced Settings dialog', function () {
	this.timeout(60_000);

	test('keeps modal semantics, focus restoration, and override persistence boundaries in the generated Settings dialog', async () => {
		const root = process.cwd();
		const sourceSettingsPath = path.join(root, 'src', 'vs', 'workbench', 'contrib', 'void', 'browser', 'react', 'src', 'void-settings-tsx', 'Settings.tsx');
		const generatedSettingsPath = path.join(root, 'src', 'vs', 'workbench', 'contrib', 'void', 'browser', 'react', 'src2', 'void-settings-tsx', 'Settings.tsx');
		const generatedStylesPath = path.join(root, 'src', 'vs', 'workbench', 'contrib', 'void', 'browser', 'react', 'src2', 'styles.css');
		const source = read(sourceSettingsPath);
		const generated = read(generatedSettingsPath);
		const sourceDialog = between(source, 'const SimpleModelSettingsDialog =', 'export const ModelDump =');
		const generatedDialog = between(generated, 'const SimpleModelSettingsDialog =', 'export const ModelDump =');
		for (const dialog of [sourceDialog, generatedDialog]) {
			assert.strictEqual(occurrences(dialog, 'role="dialog"'), 1);
			assert.strictEqual(occurrences(dialog, 'aria-modal="true"'), 1);
			assert.strictEqual(occurrences(dialog, 'aria-labelledby={headingId}'), 1);
			assert.strictEqual(occurrences(dialog, '<h3 id={headingId}'), 1);
			assert.strictEqual(occurrences(dialog, 'type="button"'), 1);
			assert.strictEqual(occurrences(dialog, 'focus-ring'), 1);
			assert.strictEqual(occurrences(dialog, 'textAreaRef.current?.focus();'), 2);
			assert.strictEqual(occurrences(dialog, 'window.addEventListener(\'keydown\', onKeyDown);'), 1);
			assert.strictEqual(occurrences(dialog, 'window.removeEventListener(\'keydown\', onKeyDown);'), 1);
			assert.strictEqual(occurrences(dialog, 'openerRef.current?.isConnected'), 1);
		}
		const sourceModelDump = between(source, 'export const ModelDump =', 'const ProviderSetting =');
		const generatedModelDump = between(generated, 'export const ModelDump =', 'const ProviderSetting =');
		for (const modelDump of [sourceModelDump, generatedModelDump]) {
			assert.strictEqual(occurrences(modelDump, 'const advancedSettingsOpenerRef = useRef<HTMLButtonElement | null>(null);'), 1);
			assert.strictEqual(occurrences(modelDump, 'advancedSettingsOpenerRef.current = event.currentTarget'), 1);
			assert.strictEqual(occurrences(modelDump, 'openerRef={advancedSettingsOpenerRef}'), 1);
		}
		assert.strictEqual(occurrences(generatedDialog, 'void-focus-ring'), 1);

		const runtime = await buildRuntime(generatedSettingsPath);
		let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
		try {
			browser = await chromium.launch({ headless: true });
			const page = await browser.newPage();
			const pageErrors: string[] = [];
			const consoleErrors: string[] = [];
			page.on('pageerror', error => pageErrors.push(error.message));
			page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
			await page.setContent('<!doctype html><div class="void-scope" id="root" style="--void-ring-color:#1177cb"></div>');
			await page.addStyleTag({ content: read(generatedStylesPath) });
			await page.addScriptTag({ content: runtime.script });
			await page.locator('#root').evaluate(node => (window as any).__advancedSettingsDialog.mount(node));
			const opener = page.getByRole('button', { name: 'Open fixture advanced settings' });
			const closeButton = page.getByRole('button', { name: 'Close advanced settings for OpenAI Compatible / gpt-5.6-luna' });
			const dialog = page.getByRole('dialog');
			const reopen = async ({ keyboard = false }: { keyboard?: boolean } = {}) => {
				try {
					if (keyboard) {
						await opener.focus();
						await opener.press('Enter');
					} else {
						await opener.click();
					}
					await dialog.waitFor({ state: 'visible', timeout: 5_000 });
					assert.strictEqual(await closeButton.evaluate(button => document.activeElement === button), true);
				} catch (error) {
					assert.fail(`${error instanceof Error ? error.message : String(error)}\npage errors: ${JSON.stringify(pageErrors)}\nconsole errors: ${JSON.stringify(consoleErrors)}`);
				}
			};
			const assertReturnedToOpener = async () => page.waitForFunction(() => document.activeElement?.textContent === 'Open fixture advanced settings');
			const closeWithoutPersistence = async (close: () => Promise<void>) => {
				const beforeCloseCount = await page.evaluate(() => (window as any).__advancedSettingsDialog.getCloseCount());
				const beforePersisted = await page.evaluate(() => (window as any).__advancedSettingsDialog.persisted.length);
				await close();
				await dialog.waitFor({ state: 'detached' });
				await assertReturnedToOpener();
				assert.strictEqual(await page.evaluate(() => (window as any).__advancedSettingsDialog.getCloseCount()), beforeCloseCount + 1);
				assert.strictEqual(await page.evaluate(() => (window as any).__advancedSettingsDialog.persisted.length), beforePersisted);
			};

			await reopen({ keyboard: true });
			const headingId = await dialog.getAttribute('aria-labelledby');
			assert.ok(headingId);
			assert.strictEqual(await page.locator(`#${headingId}`).textContent(), 'Change Defaults for gpt-5.6-luna (OpenAI Compatible)');
			assert.strictEqual(await dialog.getAttribute('aria-modal'), 'true');
			assert.deepStrictEqual(await closeButton.evaluate(button => { const style = getComputedStyle(button); return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth, outlineOffset: style.outlineOffset, outlineColor: style.outlineColor }; }), { outlineStyle: 'solid', outlineWidth: '2px', outlineOffset: '2px', outlineColor: 'rgb(17, 119, 203)' });
			await closeWithoutPersistence(() => closeButton.click());

			await reopen();
			await closeWithoutPersistence(() => page.getByRole('button', { name: 'Cancel' }).click());
			await reopen();
			await closeWithoutPersistence(async () => { await page.mouse.click(1, 1); });
			await reopen();
			await closeWithoutPersistence(() => page.keyboard.press('Escape'));

			await reopen();
			const beforeOverrideOff = await page.evaluate(() => (window as any).__advancedSettingsDialog.persisted.length);
			const beforeOverrideOffClose = await page.evaluate(() => (window as any).__advancedSettingsDialog.getCloseCount());
			await page.getByRole('button', { name: 'Save' }).click();
			await dialog.waitFor({ state: 'detached' });
			await assertReturnedToOpener();
			assert.strictEqual(await page.evaluate(() => (window as any).__advancedSettingsDialog.persisted.length), beforeOverrideOff + 1);
			assert.strictEqual(await page.evaluate(() => (window as any).__advancedSettingsDialog.persisted.at(-1)), undefined);
			assert.strictEqual(await page.evaluate(() => (window as any).__advancedSettingsDialog.getCloseCount()), beforeOverrideOffClose + 1);

			await reopen();
			await page.getByRole('switch', { name: 'Override model defaults for OpenAI Compatible / gpt-5.6-luna' }).click();
			const textArea = page.locator('textarea');
			await textArea.fill('{');
			const beforeInvalid = await page.evaluate(() => (window as any).__advancedSettingsDialog.persisted.length);
			await page.getByRole('button', { name: 'Save' }).click();
			assert.strictEqual(await dialog.count(), 1);
			assert.strictEqual(await page.getByText('Invalid JSON').count(), 1);
			assert.strictEqual(await textArea.evaluate(element => document.activeElement === element), true);
			assert.strictEqual(await page.evaluate(() => (window as any).__advancedSettingsDialog.persisted.length), beforeInvalid);
			await textArea.fill('');
			await page.getByRole('button', { name: 'Save' }).click();
			assert.strictEqual(await dialog.count(), 1);
			assert.strictEqual(await textArea.evaluate(element => document.activeElement === element), true);
			assert.strictEqual(await page.evaluate(() => (window as any).__advancedSettingsDialog.persisted.length), beforeInvalid);
			await closeButton.click();
			await dialog.waitFor({ state: 'detached' });

			await reopen();
			await page.getByRole('switch', { name: 'Override model defaults for OpenAI Compatible / gpt-5.6-luna' }).click();
			await page.locator('textarea').fill('{"contextWindow": 200, "temperature": null, "unknown": true}');
			const beforeValid = await page.evaluate(() => (window as any).__advancedSettingsDialog.persisted.length);
			const beforeValidClose = await page.evaluate(() => (window as any).__advancedSettingsDialog.getCloseCount());
			await page.getByRole('button', { name: 'Save' }).click();
			await dialog.waitFor({ state: 'detached' });
			await assertReturnedToOpener();
			assert.strictEqual(await page.evaluate(() => (window as any).__advancedSettingsDialog.persisted.length), beforeValid + 1);
			assert.deepStrictEqual(await page.evaluate(() => (window as any).__advancedSettingsDialog.persisted.at(-1)), { contextWindow: 200 });
			assert.strictEqual(await page.evaluate(() => (window as any).__advancedSettingsDialog.getCloseCount()), beforeValidClose + 1);

			await page.evaluate(() => (window as any).__advancedSettingsDialog.dispose());
			assert.deepStrictEqual(pageErrors, []);
			assert.deepStrictEqual(consoleErrors, []);
		} finally {
			try { await browser?.close(); } finally { runtime.dispose(); }
		}
	});
});
