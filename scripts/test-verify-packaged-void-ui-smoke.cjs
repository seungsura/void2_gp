/*---------------------------------------------------------------------------------------------
 *  Cost-free contract checks for packaged Void UI smoke settings assertions.
 *--------------------------------------------------------------------------------------------*/
'use strict';

const assert = require('node:assert/strict');
const { assertSettings } = require('./verify-packaged-void-ui-smoke.cjs');

function locator({ checked = false, text = '', visible = true } = {}) {
	return {
		async waitFor() { if (!visible) throw new Error('not visible'); },
		async isVisible() { return visible; },
		async isChecked() { return checked; },
		async innerText() { return text; },
		async click() { },
		async fill() { },
		async count() { return visible ? 1 : 0; },
		locator() { return locator({ text }); },
	};
}

function pageWithDefaults(defaults) {
	const agentText = 'Open children 5 Concurrent children 2 Maximum depth 1 project';
	return {
		keyboard: { async press() { } },
		getByPlaceholder() { return locator(); },
		getByRole(role, options) {
			if (role === 'heading' && options.name === 'Agent delegation') return locator({ text: agentText });
			if (role === 'switch') return locator({ checked: defaults[options.name], visible: Object.hasOwn(defaults, options.name) });
			return locator();
		},
	};
}

async function assertRejects(defaults, message) {
	await assert.rejects(() => assertSettings(pageWithDefaults(defaults)), new RegExp(message));
}

async function main() {
	const defaults = { 'Auto-approve edits': true, 'Auto-approve terminal': true, 'Auto-approve MCP tools': true, 'Auto-accept LLM changes': false };
	await assertSettings(pageWithDefaults(defaults));
	await assertRejects({ ...defaults, 'Auto-accept LLM changes': true }, 'Auto-accept LLM changes was enabled by defaults');
	for (const label of ['Auto-approve edits', 'Auto-approve terminal', 'Auto-approve MCP tools']) await assertRejects({ ...defaults, [label]: false }, `${label} was not enabled by defaults`);
	const missingAutoAccept = { ...defaults }; delete missingAutoAccept['Auto-accept LLM changes'];
	await assertRejects(missingAutoAccept, 'not visible');
	console.log('packaged UI smoke settings fixture: 6 passing');
}

void main();
