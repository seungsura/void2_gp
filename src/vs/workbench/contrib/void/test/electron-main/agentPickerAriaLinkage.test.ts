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

const between = (text: string, start: string, end: string): string => {
	const startIndex = text.indexOf(start);
	const endIndex = text.indexOf(end, startIndex + start.length);
	assert.ok(startIndex >= 0 && endIndex > startIndex, `Expected bounded generated component region: ${start}`);
	return text.slice(startIndex, endIndex);
};

const findJavaScriptFiles = (directory: string): string[] => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
	const candidate = path.join(directory, entry.name);
	return entry.isDirectory() ? findJavaScriptFiles(candidate) : entry.isFile() && entry.name.endsWith('.js') ? [candidate] : [];
});

const buildPickerRuntime = async (generatedInputsPath: string): Promise<{ script: string; dispose: () => void }> => {
	const component = between(read(generatedInputsPath), 'export const VoidInputBox2 =', 'export const VoidSimpleInputBox =');
	const sourceRoot = path.resolve(process.cwd());
	const temporaryRoot = fs.mkdtempSync(path.join(sourceRoot, '.picker-aria-runtime-'));
	assert.ok(path.resolve(temporaryRoot).startsWith(`${sourceRoot}${path.sep}`), 'Expected a scoped runtime directory beneath the source root.');
	const entryPath = path.join(temporaryRoot, 'runtime-entry.tsx');
	const outputDirectory = path.join(temporaryRoot, 'out');
	const relativeAgentSkillsPath = path.relative(temporaryRoot, path.join(sourceRoot, 'src', 'vs', 'workbench', 'contrib', 'void', 'common', 'agentSkills.ts')).replaceAll('\\', '/');
	const relativeCustomAgentsPath = path.relative(temporaryRoot, path.join(sourceRoot, 'src', 'vs', 'workbench', 'contrib', 'void', 'common', 'agentCustomAgents.ts')).replaceAll('\\', '/');
	const agentSkillsImport = relativeAgentSkillsPath.startsWith('.') ? relativeAgentSkillsPath : `./${relativeAgentSkillsPath}`;
	const customAgentsImport = relativeCustomAgentsPath.startsWith('.') ? relativeCustomAgentsPath : `./${relativeCustomAgentsPath}`;
	fs.writeFileSync(entryPath, `
		import React, { forwardRef, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
		import { createRoot } from 'react-dom/client';
		import { flushSync } from 'react-dom';
		import { beginSkillPickerQuery, canSelectSkillPickerQuery, closeSkillComposerDollarSession, createSkillComposerDollarSession, initialSkillPickerQueryState, isSkillComposerDollarQueryCharacter, isSkillComposerMenuRoot, replaceSkillComposerDollarSelection, settleSkillPickerQuery, skillComposerDollarEnterAction, skillComposerMenuPath, skillComposerTriggerAtCursor, updateSkillComposerDollarQuery } from ${JSON.stringify(agentSkillsImport)};
		import { CustomAgentPickerRequestOwner } from ${JSON.stringify(customAgentsImport)};
		type Option = any;
		type StagingSelectionItem = any;
		type TextAreaFns = { setValue: (v: string) => void, enable: () => void, disable: () => void };
		type InputBox2Props = { initValue?: string | null; placeholder: string; multiline: boolean; enableAtToMention?: boolean; fnsRef?: { current: null | TextAreaFns }; className?: string; onChangeText?: (value: string) => void; onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void; onFocus?: (e: React.FocusEvent<HTMLTextAreaElement>) => void; onBlur?: (e: React.FocusEvent<HTMLTextAreaElement>) => void; onChangeHeight?: (newHeight: number) => void; ariaLabel?: string; ariaDescribedBy?: string; };
		const useAccessor = () => (window as any).__voidPickerAccessor;
		const asCssVariable = () => '';
		const inputBackground = '', inputForeground = '';
		const ChevronRight = () => <span />;
		const AGENT_DELEGATION_SELECTION_LABEL = 'Void application-level read-only';
		const getEnabledOptionIndex = (options: Option[], disabled: (option: Option) => boolean, start: number, step: number, periodic: boolean) => { for (let offset = 0; offset < options.length; offset++) { const candidate = periodic ? (start + offset * step + options.length * 4) % options.length : start + offset * step; if (candidate < 0 || candidate >= options.length) break; if (!disabled(options[candidate])) return candidate; } return undefined; };
		const getOptionsAtPath = (_accessor: unknown, optionPath: string[], optionText: string) => (window as any).__voidPickerOptions(optionPath, optionText);
		const autoUpdate = () => undefined;
		const offset = (..._args: unknown[]) => ({});
		const flip = (..._args: unknown[]) => ({});
		const shift = (..._args: unknown[]) => ({});
		const size = (..._args: unknown[]) => ({});
		const useFloating = () => { const reference = useRef<any>(null), floating = useRef<any>(null); return { x: 0, y: 0, strategy: 'fixed', refs: { reference, floating, setReference: (value: any) => reference.current = value, setFloating: (value: any) => floating.current = value }, update: () => undefined }; };
		${component}
		let root: ReturnType<typeof createRoot> | undefined;
		const pickerFns: { current: TextAreaFns | null } = { current: null };
		const selected: any[] = [];
		const Harness = () => <><VoidInputBox2 ariaLabel="Picker" placeholder="Picker" multiline enableAtToMention fnsRef={pickerFns} /><VoidInputBox2 ariaLabel="Plain" placeholder="Plain" multiline /></>;
		(window as any).__voidPickerFixture = { selected, mount(container: HTMLElement) { (window as any).__voidPickerAccessor = { get(name: string) { return name === 'IChatThreadService' ? { addNewStagingSelection(value: unknown) { selected.push(value); }, popStagingSelections() {} } : { guessLanguageIdByFilepathOrFirstLine() { return 'plaintext'; } }; } }; root = createRoot(container); flushSync(() => root!.render(<Harness />)); }, enable() { flushSync(() => pickerFns.current?.enable()); }, disable() { flushSync(() => pickerFns.current?.disable()); }, dispose() { flushSync(() => root?.unmount()); } };
	`, 'utf8');
	try {
		await build({ entry: { runtime: entryPath }, outDir: outputDirectory, format: ['iife'], globalName: 'VoidPickerAriaRuntime', splitting: false, clean: true, platform: 'browser', target: 'es2022', silent: true, noExternal: [/^(?!\.).*$/], treeshake: true, esbuildOptions(options) { options.outbase = temporaryRoot; } });
		const outputFiles = findJavaScriptFiles(outputDirectory);
		assert.strictEqual(outputFiles.length, 1, 'Expected one scoped picker runtime bundle.');
		return { script: read(outputFiles[0]), dispose: () => fs.rmSync(temporaryRoot, { recursive: true, force: true }) };
	} catch (error) {
		fs.rmSync(temporaryRoot, { recursive: true, force: true });
		throw error;
	}
};

suite('Void Agent and Skills picker ARIA linkage', function () {
	this.timeout(20_000);

	test('keeps picker IDREFs live only for mounted selectable rows without changing pointer selection', async () => {
		const root = process.cwd();
		const sourceInputsPath = path.join(root, 'src', 'vs', 'workbench', 'contrib', 'void', 'browser', 'react', 'src', 'util', 'inputs.tsx');
		const generatedInputsPath = path.join(root, 'src', 'vs', 'workbench', 'contrib', 'void', 'browser', 'react', 'src2', 'util', 'inputs.tsx');
		for (const candidate of [read(sourceInputsPath), read(generatedInputsPath)]) {
			assert.ok(candidate.includes('const pickerListboxId = useId();'));
			assert.ok(candidate.includes("'aria-controls': pickerListboxId"));
			assert.ok(candidate.includes('id={`${pickerListboxId}-option-${oIdx}`}'));
		}
		const runtime = await buildPickerRuntime(generatedInputsPath);
		let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
		const pageErrors: string[] = [], consoleErrors: string[] = [];
		try {
			browser = await chromium.launch({ headless: true });
			const page = await browser.newPage();
			page.on('pageerror', error => pageErrors.push(error.message));
			page.on('console', message => { if (message.type() === 'error') { consoleErrors.push(message.text()); } });
			await page.setContent('<!doctype html><div id="root"></div>');
			await page.addScriptTag({ content: runtime.script });
			await page.evaluate(() => (window as any).__voidPickerFixture.mount(document.querySelector('#root')));
			await page.evaluate(() => {
				const pending: Array<{ path: string[]; query: string; resolve: (options: unknown[]) => void }> = [];
				(window as any).__voidPickerOptions = (path: string[], query: string) => new Promise(resolve => pending.push({ path, query, resolve }));
				(window as any).__voidPickerPending = pending;
			});

			const picker = page.getByRole('combobox', { name: 'Picker' });
			assert.strictEqual(await picker.count(), 1);
			assert.deepStrictEqual(await page.getByLabel('Plain').evaluate(element => ({ role: element.getAttribute('role'), expanded: element.getAttribute('aria-expanded'), controls: element.getAttribute('aria-controls'), active: element.getAttribute('aria-activedescendant') })), { role: null, expanded: null, controls: null, active: null });
			assert.deepStrictEqual(await picker.evaluate(element => ({ expanded: element.getAttribute('aria-expanded'), controls: element.getAttribute('aria-controls'), active: element.getAttribute('aria-activedescendant') })), { expanded: 'false', controls: null, active: null });

			await picker.evaluate(element => { const textarea = element as HTMLTextAreaElement; textarea.value = '@'; textarea.setSelectionRange(1, 1); textarea.dispatchEvent(new InputEvent('input', { bubbles: true, data: '@', inputType: 'insertText' })); });
			await page.waitForFunction(() => (window as any).__voidPickerPending.length === 1);
			await page.evaluate(() => (window as any).__voidPickerPending.shift().resolve([
				{ fullName: 'first', abbreviatedName: 'First role', iconInMenu: () => null, leafNodeType: 'Agent', agentType: 'first', catalogRevision: 'c', roleRevision: 'r' },
				{ fullName: 'second', abbreviatedName: 'Second role', iconInMenu: () => null, leafNodeType: 'Agent', agentType: 'second', catalogRevision: 'c', roleRevision: 'r' },
				{ fullName: 'disabled', abbreviatedName: 'Disabled', iconInMenu: () => null, leafNodeType: 'Agent', disabled: true, agentType: 'disabled', catalogRevision: 'c', roleRevision: 'r' },
			]));
			const listbox = page.getByRole('listbox');
			await listbox.waitFor();
			await page.waitForFunction(() => document.querySelector('[aria-label="Picker"]')?.getAttribute('aria-activedescendant') !== null);
			const firstId = await picker.getAttribute('aria-activedescendant');
			const listboxId = await picker.getAttribute('aria-controls');
			assert.ok(firstId && listboxId);
			assert.strictEqual(await listbox.getAttribute('id'), listboxId);
			assert.strictEqual(await page.locator(`#${firstId}`).getAttribute('role'), 'option');
			assert.strictEqual(await page.locator(`#${firstId}`).getAttribute('aria-disabled'), 'false');
			await picker.press('ArrowDown');
			const secondId = await picker.getAttribute('aria-activedescendant');
			assert.ok(secondId && secondId !== firstId);
			assert.strictEqual(await picker.getAttribute('aria-controls'), listboxId, 'Changing the highlighted row must not replace the listbox ID.');
			assert.strictEqual(await page.locator(`#${secondId}`).getAttribute('aria-selected'), 'true');
			assert.strictEqual(await listbox.evaluate(element => getComputedStyle(element.parentElement!).position), 'fixed');
			await page.getByRole('option', { name: /First role/ }).click();
			assert.deepStrictEqual(await page.evaluate(() => (window as any).__voidPickerFixture.selected.map((entry: any) => entry.agentType)), ['first']);
			await picker.evaluate(element => { const textarea = element as HTMLTextAreaElement; textarea.value = '@'; textarea.setSelectionRange(1, 1); textarea.dispatchEvent(new InputEvent('input', { bubbles: true, data: '@', inputType: 'insertText' })); });
			await page.waitForFunction(() => (window as any).__voidPickerPending.length === 1);
			await page.evaluate(() => (window as any).__voidPickerPending.shift().resolve([{ fullName: 'only-disabled', abbreviatedName: 'Only disabled', iconInMenu: () => null, leafNodeType: 'Agent', disabled: true, agentType: 'disabled', catalogRevision: 'c', roleRevision: 'r' }]));
			await page.getByRole('listbox').waitFor();
			assert.strictEqual(await picker.getAttribute('aria-activedescendant'), null, 'An all-disabled menu must not point at an unselectable option.');
			await page.evaluate(() => (window as any).__voidPickerFixture.disable());
			assert.deepStrictEqual(await picker.evaluate(element => ({ expanded: element.getAttribute('aria-expanded'), controls: element.getAttribute('aria-controls'), active: element.getAttribute('aria-activedescendant') })), { expanded: 'false', controls: null, active: null });
			assert.strictEqual(await page.getByRole('listbox').count(), 1, 'Disabling preserves the existing popup lifecycle while detaching ARIA linkage.');
			await page.evaluate(() => (window as any).__voidPickerFixture.enable());
			await picker.press('Escape');

			await picker.evaluate(element => { const textarea = element as HTMLTextAreaElement; textarea.value = '$'; textarea.setSelectionRange(1, 1); textarea.dispatchEvent(new InputEvent('input', { bubbles: true, data: '$', inputType: 'insertText' })); });
			await page.waitForFunction(() => (window as any).__voidPickerPending.length === 1);
			await page.evaluate(() => (window as any).__voidPickerPending.shift().resolve([{ fullName: 'valid', abbreviatedName: 'Valid Skill', iconInMenu: () => null, leafNodeType: 'Skill', skill: { identity: 'valid', provenance: { skillRoot: 'file:///valid' }, bodyRevision: 'r' }, catalogRevision: 'c' }]));
			await page.getByRole('listbox').waitFor();
			await page.waitForFunction(() => document.querySelector('[aria-label="Picker"]')?.getAttribute('aria-activedescendant') !== null);
			const skillControls = await picker.getAttribute('aria-controls');
			const skillActive = await picker.getAttribute('aria-activedescendant');
			assert.ok(skillControls && skillActive);
			assert.strictEqual(await page.locator(`#${skillControls}`).getAttribute('role'), 'listbox');
			assert.strictEqual(await page.locator(`#${skillActive}`).getAttribute('aria-selected'), 'true');
			await picker.press('Escape');
			await picker.evaluate(element => { const textarea = element as HTMLTextAreaElement; textarea.value = '$'; textarea.setSelectionRange(1, 1); textarea.dispatchEvent(new InputEvent('input', { bubbles: true, data: '$', inputType: 'insertText' })); });
			await page.waitForFunction(() => (window as any).__voidPickerPending.length === 1);
			await picker.press('Escape');
			await page.evaluate(() => (window as any).__voidPickerPending.shift().resolve([{ fullName: 'late', abbreviatedName: 'Late Skill', iconInMenu: () => null, leafNodeType: 'Skill', skill: { identity: 'late', provenance: { skillRoot: 'file:///late' }, bodyRevision: 'r' }, catalogRevision: 'c' }]));
			await page.waitForTimeout(20);
			assert.deepStrictEqual(await picker.evaluate(element => ({ expanded: element.getAttribute('aria-expanded'), controls: element.getAttribute('aria-controls'), active: element.getAttribute('aria-activedescendant'), focused: document.activeElement === element })), { expanded: 'false', controls: null, active: null, focused: true });
			assert.strictEqual(await page.getByRole('listbox').count(), 0);
			assert.deepStrictEqual(pageErrors, []);
			assert.deepStrictEqual(consoleErrors, []);
		} catch (error: unknown) {
			throw new Error(`Picker ARIA runtime failed: ${error instanceof Error ? error.message : String(error)}; pageErrors=${JSON.stringify(pageErrors)}; consoleErrors=${JSON.stringify(consoleErrors)}`);
		} finally {
			try { await browser?.close(); } finally { runtime.dispose(); }
		}
	});
});
