/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { availableTools } from '../../common/prompt/prompts.js';

suite('Void terminal tool instructions', () => {
	test('expose the write_file-first contract through production agent tools', () => {
		const tools = availableTools('agent', undefined);
		assert.ok(tools);

		for (const name of ['run_command', 'run_persistent_command']) {
			const description = tools.find(tool => tool.name === name)?.description;
			assert.ok(description, `Expected production ${name} description.`);
			assert.match(description, /Use write_file whenever you create or modify files/);
			assert.match(description, /do not use terminal commands to work around this requirement/);
			assert.match(description, /Terminal commands are allowed for formatters and large-scale mechanical transformations/);
			assert.doesNotMatch(description, /Do not edit any files with this tool/);
		}
	});
});
