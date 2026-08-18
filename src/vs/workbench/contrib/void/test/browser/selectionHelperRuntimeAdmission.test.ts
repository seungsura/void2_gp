/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { SelectionHelperContribution } from '../../browser/voidSelectionHelperWidget.js';
import { isGhostChatDevelopmentEnvironment, isSelectionHelperDevelopmentEnvironment } from '../../common/automaticSuggestionEnvironment.js';

suite('Void selection helper runtime admission', () => {
	test('built production omits both Settings surfaces and returns before selection helper side effects despite persisted true', () => {
		const production = { isBuilt: true, isExtensionDevelopment: false };
		const development = { isBuilt: false, isExtensionDevelopment: false };
		const extensionDevelopment = { isBuilt: true, isExtensionDevelopment: true };
		assert.strictEqual(isGhostChatDevelopmentEnvironment(production), false);
		assert.strictEqual(isSelectionHelperDevelopmentEnvironment(production), false);
		assert.strictEqual(isGhostChatDevelopmentEnvironment(development), true);
		assert.strictEqual(isSelectionHelperDevelopmentEnvironment(development), true);
		assert.strictEqual(isGhostChatDevelopmentEnvironment(extensionDevelopment), true);
		assert.strictEqual(isSelectionHelperDevelopmentEnvironment(extensionDevelopment), true);

		const effects = {
			invokeFunction: 0,
			addOverlay: 0,
			removeOverlay: 0,
			selectionListeners: 0,
			blurListeners: 0,
			scrollListeners: 0,
			layoutListeners: 0,
			rerenders: 0,
		};
		const disposable = () => ({ dispose() { } });
		const editor = {
			addOverlayWidget() { effects.addOverlay += 1; },
			removeOverlayWidget() { effects.removeOverlay += 1; },
			onDidChangeCursorSelection() { effects.selectionListeners += 1; return disposable(); },
			onDidBlurEditorText() { effects.blurListeners += 1; return disposable(); },
			onDidScrollChange() { effects.scrollListeners += 1; return disposable(); },
			onDidLayoutChange() { effects.layoutListeners += 1; return disposable(); },
		};
		const instantiation = {
			invokeFunction() {
				effects.invokeFunction += 1;
				effects.rerenders += 1;
			},
		};
		const settings = { state: { globalSettings: { showInlineSuggestions: true } } };
		const contribution = new SelectionHelperContribution(editor as any, instantiation as any, settings as any, production as any);
		assert.strictEqual((contribution as any)._rootHTML, undefined, 'production must not create a visible helper root');
		assert.strictEqual((contribution as any)._showScheduler, undefined, 'production must not create its show scheduler');
		contribution.dispose();
		assert.strictEqual(settings.state.globalSettings.showInlineSuggestions, true, 'persisted data remains unchanged and ignored');
		assert.deepStrictEqual(effects, {
			invokeFunction: 0,
			addOverlay: 0,
			removeOverlay: 0,
			selectionListeners: 0,
			blurListeners: 0,
			scrollListeners: 0,
			layoutListeners: 0,
			rerenders: 0,
		});
	});
});
