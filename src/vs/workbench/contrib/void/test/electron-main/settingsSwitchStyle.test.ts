/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { chromium } from '@playwright/test';
import { build } from 'tsup';
import * as ts from 'typescript';

const occurrences = (text: string, value: string): number => text.split(value).length - 1;
const read = (filePath: string): string => fs.readFileSync(filePath, 'utf8');

const between = (text: string, start: string, end: string): string => {
	const startIndex = text.indexOf(start);
	const endIndex = text.indexOf(end, startIndex + start.length);
	assert.ok(startIndex >= 0 && endIndex > startIndex, `Expected bounded source region: ${start}`);
	return text.slice(startIndex, endIndex);
};

type StyleInjectionContract = Readonly<{
	css: string;
	program: string;
	helperIndex: number;
	callIndex: number;
	mountInitializationIndex: number;
	mountExportIndex: number;
}>;

const getStyleInjectionContract = (bundle: string): StyleInjectionContract => {
	const sourceFile = ts.createSourceFile('void-settings-entry.js', bundle, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
	const helpers: ts.FunctionDeclaration[] = [];
	const calls: ts.CallExpression[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isFunctionDeclaration(node) && node.name?.text === 'styleInject') { helpers.push(node); }
		if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'styleInject') { calls.push(node); }
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	assert.strictEqual(helpers.length, 1, 'Expected exactly one styleInject helper.');
	assert.strictEqual(calls.length, 1, 'Expected exactly one styleInject invocation.');
	assert.strictEqual(calls[0].arguments.length, 1, 'Expected a single-argument styleInject invocation.');
	assert.ok(ts.isStringLiteralLike(calls[0].arguments[0]), 'Expected an injected CSS string literal.');
	const helperIndex = helpers[0].getStart(sourceFile);
	const callIndex = calls[0].getStart(sourceFile);
	const mountInitializationIndex = bundle.indexOf('mountVoidSettings =');
	const mountExportIndex = bundle.indexOf('export { mountVoidSettings }');
	assert.ok(callIndex < mountInitializationIndex, 'Expected style injection before mount initialization.');
	assert.ok(mountInitializationIndex < mountExportIndex, 'Expected mount initialization before the exported entry point.');
	return Object.freeze({ css: calls[0].arguments[0].text, program: `${helpers[0].getText(sourceFile)}\n${calls[0].getText(sourceFile)}`, helperIndex, callIndex, mountInitializationIndex, mountExportIndex });
};

const findJavaScriptFiles = (directory: string): string[] => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
	const candidate = path.join(directory, entry.name);
	return entry.isDirectory() ? findJavaScriptFiles(candidate) : entry.isFile() && entry.name.endsWith('.js') ? [candidate] : [];
});

const buildVoidSwitchRuntimeBundle = async (generatedInputsPath: string): Promise<{ script: string; dispose: () => void }> => {
	const generatedInputs = read(generatedInputsPath);
	const component = between(generatedInputs, 'export const VoidSwitch =', 'export const VoidCheckBox =');
	const sourceRoot = path.resolve(process.cwd());
	const temporaryRoot = fs.mkdtempSync(path.join(sourceRoot, '.slice8-runtime-'));
	assert.ok(path.resolve(temporaryRoot).startsWith(`${sourceRoot}${path.sep}`), 'Expected a scoped runtime directory beneath the source root.');
	const entryPath = path.join(temporaryRoot, 'runtime-entry.tsx');
	const outputDirectory = path.join(temporaryRoot, 'out');
	let productionModuleLoads = 0;
	const relativeInputsPath = path.relative(temporaryRoot, generatedInputsPath).replaceAll('\\', '/');
	const importPath = relativeInputsPath.startsWith('.') ? relativeInputsPath : `./${relativeInputsPath}`;
	fs.writeFileSync(entryPath, `
		import React, { useState } from 'react';
		import { createRoot } from 'react-dom/client';
		import { flushSync } from 'react-dom';
		import { VoidSwitch } from ${JSON.stringify(importPath)};

		const changes: boolean[] = [];
		let setDisabledState: ((value: boolean) => void) | undefined;
		let mountedRoot: ReturnType<typeof createRoot> | undefined;
		const Harness = () => {
			const [value, setValue] = useState(false);
			const [disabled, setDisabled] = useState(false);
			setDisabledState = setDisabled;
			return <VoidSwitch value={value} disabled={disabled} size="md" ariaLabel="Enable fixture" onChange={(nextValue) => { changes.push(nextValue); setValue(nextValue); }} />;
		};
		(window as any).__voidSwitchFixture = {
			changes,
			mount(container: HTMLElement) {
				(window as any).__voidSwitchOrder.push('mount');
				mountedRoot = createRoot(container);
				flushSync(() => mountedRoot!.render(<Harness />));
			},
			setDisabled(value: boolean) { flushSync(() => setDisabledState!(value)); },
			dispose() { flushSync(() => mountedRoot?.unmount()); },
		};
	`, 'utf8');
	try {
		await build({
			entry: { runtime: entryPath },
			outDir: outputDirectory,
			format: ['iife'],
			globalName: 'VoidSwitchRuntimeFixture',
			splitting: false,
			clean: true,
			platform: 'browser',
			target: 'es2022',
			silent: true,
			noExternal: [/^(?!\.).*$/],
			treeshake: true,
			esbuildPlugins: [{
				name: 'production-void-switch-only',
				setup(buildContext) {
					buildContext.onLoad({ filter: /[\\/]src2[\\/]util[\\/]inputs\.tsx$/ }, args => {
						assert.strictEqual(path.resolve(args.path), path.resolve(generatedInputsPath));
						productionModuleLoads += 1;
						return { contents: `import React from 'react';\n${component}`, loader: 'tsx', resolveDir: path.dirname(args.path) };
					});
				},
			}],
			esbuildOptions(options) { options.outbase = temporaryRoot; },
		});
		assert.strictEqual(productionModuleLoads, 1, 'Expected the runtime bundle to import the generated production VoidSwitch exactly once.');
		const outputFiles = findJavaScriptFiles(outputDirectory);
		assert.strictEqual(outputFiles.length, 1, 'Expected one scoped VoidSwitch runtime bundle.');
		return {
			script: read(outputFiles[0]),
			dispose: () => {
				const resolvedTemporaryRoot = path.resolve(temporaryRoot);
				assert.ok(resolvedTemporaryRoot.startsWith(`${sourceRoot}${path.sep}.slice8-runtime-`), 'Refusing to remove a runtime fixture outside the validated source-root prefix.');
				fs.rmSync(resolvedTemporaryRoot, { recursive: true, force: true });
			},
		};
	} catch (error) {
		const resolvedTemporaryRoot = path.resolve(temporaryRoot);
		if (resolvedTemporaryRoot.startsWith(`${sourceRoot}${path.sep}.slice8-runtime-`)) { fs.rmSync(resolvedTemporaryRoot, { recursive: true, force: true }); }
		throw error;
	}
};

suite('Void Settings switch style delivery', function () {
	this.timeout(20_000);

	const root = process.cwd();
	const reactRoot = path.join(root, 'src', 'vs', 'workbench', 'contrib', 'void', 'browser', 'react');
	const sourceEntryPath = path.join(reactRoot, 'src', 'void-settings-tsx', 'index.tsx');
	const sourceInputsPath = path.join(reactRoot, 'src', 'util', 'inputs.tsx');
	const sourceStylesPath = path.join(reactRoot, 'src', 'styles.css');
	const generatedEntryPath = path.join(reactRoot, 'src2', 'void-settings-tsx', 'index.tsx');
	const generatedInputsPath = path.join(reactRoot, 'src2', 'util', 'inputs.tsx');
	const generatedStylesPath = path.join(reactRoot, 'src2', 'styles.css');
	const settingsBundlePath = path.join(reactRoot, 'out', 'void-settings-tsx', 'index.js');

	test('keeps the native input as the sole interaction owner and imports scoped styles at the independent entry', () => {
		const entry = read(sourceEntryPath);
		const component = between(read(sourceInputsPath), 'export const VoidSwitch =', 'export const VoidCheckBox =');
		const styles = read(sourceStylesPath);
		const styleImport = "import '../styles.css'";

		assert.strictEqual(occurrences(entry, styleImport), 1);
		assert.ok(entry.indexOf(styleImport) < entry.indexOf("import { Settings } from './Settings.js'"));
		assert.ok(entry.indexOf(styleImport) < entry.indexOf('export const mountVoidSettings'));
		assert.strictEqual(occurrences(component, 'type="checkbox"'), 1);
		assert.strictEqual(occurrences(component, 'role="switch"'), 1);
		assert.strictEqual(occurrences(component, 'aria-label={ariaLabel}'), 1);
		assert.strictEqual(occurrences(component, 'checked={value}'), 1);
		assert.strictEqual(occurrences(component, 'disabled={disabled}'), 1);
		assert.strictEqual(occurrences(component, 'onChange={(e) => onChange(e.currentTarget.checked)}'), 1);
		assert.strictEqual(occurrences(component, '<span'), 2);
		assert.strictEqual(occurrences(component, 'aria-hidden="true"'), 1);
		assert.strictEqual(occurrences(component, 'switch-track pointer-events-none'), 1);
		assert.strictEqual(occurrences(styles, '.void-switch-input:focus-visible + .void-switch-track'), 1);
	});

	test('emits one scoped prefix and one style injection in the generated Settings entry', () => {
		const entry = read(generatedEntryPath);
		const generatedInputs = read(generatedInputsPath);
		const component = between(generatedInputs, 'export const VoidSwitch =', 'export const VoidCheckBox =');
		const generatedStyles = read(generatedStylesPath);
		const bundle = read(settingsBundlePath);
		const styleImport = "import '../styles.css'";

		assert.strictEqual(occurrences(entry, styleImport), 1);
		assert.ok(entry.indexOf(styleImport) < entry.indexOf("import { Settings } from './Settings.js'"));
		assert.strictEqual(occurrences(component, 'void-switch-input'), 1);
		assert.strictEqual(occurrences(component, 'void-switch-track'), 1);
		assert.strictEqual(occurrences(component, 'void-opacity-0'), 1);
		assert.strictEqual(occurrences(component, 'void-pointer-events-none'), 1);
		assert.strictEqual(occurrences(component, 'void-void-switch'), 0);
		assert.doesNotMatch(component, /(?:^|[\s"'`])switch-(?:input|track)(?:[\s"'`])/m);
		assert.strictEqual(occurrences(generatedStyles, '.void-scope .void-opacity-0 {'), 1);
		assert.strictEqual(occurrences(generatedStyles, '.void-switch-input:focus-visible + .void-switch-track'), 1);
		const injection = getStyleInjectionContract(bundle);
		assert.strictEqual(occurrences(injection.css, '.void-scope .void-opacity-0 {'), 1);
		assert.strictEqual(occurrences(injection.css, '.void-switch-input:focus-visible + .void-switch-track'), 1);
		assert.ok(injection.helperIndex < injection.callIndex);
		assert.ok(injection.callIndex < injection.mountInitializationIndex);
		assert.ok(injection.mountInitializationIndex < injection.mountExportIndex);
	});

	test('executes Settings CSS before the actual VoidSwitch React mount and preserves visual, interaction, and forced-colors semantics', async () => {
		const injection = getStyleInjectionContract(read(settingsBundlePath));
		const runtime = await buildVoidSwitchRuntimeBundle(generatedInputsPath);
		let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
		try {
			browser = await chromium.launch({ headless: true });
			const page = await browser.newPage();
			await page.setContent(`<!doctype html><html><body>
				<div class="void-scope" id="settings-root" style="--void-ring-color:#1177cb"></div>
			</body></html>`);
			await page.evaluate(() => {
				(window as unknown as { __voidSwitchOrder: string[] }).__voidSwitchOrder = [];
				const appendChild = document.head.appendChild.bind(document.head);
				document.head.appendChild = (<T extends Node>(node: T): T => {
					if (node instanceof HTMLStyleElement) { (window as unknown as { __voidSwitchOrder: string[] }).__voidSwitchOrder.push('style'); }
					return appendChild(node) as T;
				}) as typeof document.head.appendChild;
			});
			assert.strictEqual(await page.locator('head style').count(), 0);
			await page.addScriptTag({ content: injection.program });
			assert.strictEqual(await page.locator('head style').count(), 1);
			assert.strictEqual(await page.locator('head style').textContent(), injection.css);
			await page.addScriptTag({ content: runtime.script });
			await page.locator('#settings-root').evaluate(rootNode => (window as any).__voidSwitchFixture.mount(rootNode));
			assert.deepStrictEqual(await page.evaluate(() => (window as unknown as { __voidSwitchOrder: string[] }).__voidSwitchOrder), ['style', 'mount']);
			assert.strictEqual(await page.locator('head style').count(), 1, 'The runtime component bundle must not inject a second stylesheet.');

			const inspect = async () => page.getByRole('switch', { name: 'Enable fixture' }).evaluate((input) => {
				const track = input.nextElementSibling as HTMLElement;
				const knob = track.firstElementChild as HTMLElement;
				const inputStyle = getComputedStyle(input);
				const trackStyle = getComputedStyle(track);
				const knobStyle = getComputedStyle(knob);
				const trackRect = track.getBoundingClientRect();
				const knobRect = knob.getBoundingClientRect();
				return {
					input: { opacity: inputStyle.opacity, appearance: inputStyle.appearance, checked: (input as HTMLInputElement).checked, disabled: (input as HTMLInputElement).disabled },
					track: { backgroundColor: trackStyle.backgroundColor, opacity: trackStyle.opacity, pointerEvents: trackStyle.pointerEvents, display: trackStyle.display, visibility: trackStyle.visibility, width: trackRect.width, height: trackRect.height },
					knob: { backgroundColor: knobStyle.backgroundColor, opacity: knobStyle.opacity, transform: knobStyle.transform, display: knobStyle.display, visibility: knobStyle.visibility, width: knobRect.width, height: knobRect.height },
					forcedColors: matchMedia('(forced-colors: active)').matches,
				};
			});

			assert.strictEqual(await page.getByRole('switch', { name: 'Enable fixture' }).count(), 1);
			assert.deepStrictEqual(await page.locator('#settings-root').evaluate((rootNode) => [
				rootNode.querySelectorAll('input[type=checkbox][role=switch]').length,
				rootNode.querySelectorAll('.void-switch-track').length,
				rootNode.querySelectorAll('.void-switch-track > span').length,
				rootNode.querySelectorAll('.void-switch-input + .void-switch-track').length,
			]), [1, 1, 1, 1]);

			const normalUnchecked = await inspect();
			assert.deepStrictEqual(normalUnchecked.input, { opacity: '0', appearance: 'auto', checked: false, disabled: false });
			assert.strictEqual(normalUnchecked.track.pointerEvents, 'none');
			await page.getByRole('switch', { name: 'Enable fixture' }).click();
			const normalChecked = await inspect();
			assert.strictEqual(normalChecked.input.checked, true);
			assert.notStrictEqual(normalChecked.track.backgroundColor, normalUnchecked.track.backgroundColor);
			assert.notStrictEqual(normalChecked.knob.transform, normalUnchecked.knob.transform);
			assert.deepStrictEqual(await page.evaluate(() => (window as any).__voidSwitchFixture.changes), [true]);
			await page.getByRole('switch', { name: 'Enable fixture' }).press('Space');
			assert.deepStrictEqual(await page.evaluate(() => (window as any).__voidSwitchFixture.changes), [true, false]);

			await page.locator('#settings-root').evaluate((rootNode) => rootNode.classList.add('void-dark'));
			const darkUnchecked = await inspect();
			assert.deepStrictEqual(darkUnchecked.input, { opacity: '0', appearance: 'auto', checked: false, disabled: false });
			await page.getByRole('switch', { name: 'Enable fixture' }).click();
			const darkChecked = await inspect();
			assert.notStrictEqual(darkChecked.track.backgroundColor, darkUnchecked.track.backgroundColor);
			assert.notStrictEqual(darkChecked.knob.transform, darkUnchecked.knob.transform);

			await page.getByRole('switch', { name: 'Enable fixture' }).focus();
			const outlinedElements = await page.locator('#settings-root *').evaluateAll(elements => elements.filter(element => {
				const style = getComputedStyle(element);
				return style.outlineStyle !== 'none' && style.outlineWidth !== '0px';
			}).map(element => element.className));
			assert.strictEqual(outlinedElements.length, 1);
			assert.ok(String(outlinedElements[0]).includes('void-switch-track'));

			await page.evaluate(() => (window as any).__voidSwitchFixture.setDisabled(true));
			const disabled = await inspect();
			assert.strictEqual(disabled.input.disabled, true);
			assert.strictEqual(disabled.track.opacity, '0.25');
			const changesBeforeDisabledClick = await page.evaluate(() => (window as any).__voidSwitchFixture.changes.length);
			await page.getByRole('switch', { name: 'Enable fixture' }).evaluate(input => (input as HTMLInputElement).click());
			assert.strictEqual(await page.evaluate(() => (window as any).__voidSwitchFixture.changes.length), changesBeforeDisabledClick);

			await page.evaluate(() => (window as any).__voidSwitchFixture.setDisabled(false));
			await page.emulateMedia({ forcedColors: 'active' });
			const forcedColors = await inspect();
			// This is Chromium forced-colors media emulation; Windows OS High Contrast remains final-package manual evidence.
			assert.strictEqual(forcedColors.forcedColors, true);
			assert.strictEqual(forcedColors.input.opacity, '0');
			assert.strictEqual(forcedColors.input.appearance, 'auto');
			for (const visual of [forcedColors.track, forcedColors.knob]) {
				assert.ok(visual.width > 0 && visual.height > 0);
				assert.notStrictEqual(visual.display, 'none');
				assert.strictEqual(visual.visibility, 'visible');
				assert.ok(Number(visual.opacity) > 0);
			}
			await page.evaluate(() => (window as any).__voidSwitchFixture.dispose());
		} finally {
			try {
				await browser?.close();
			} finally {
				runtime.dispose();
			}
		}
	});
});
