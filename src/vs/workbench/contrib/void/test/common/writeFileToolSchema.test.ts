/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { availableTools } from '../../common/prompt/prompts.js';

const containsCompositionOrConst = (value: unknown): boolean => {
	if (!value || typeof value !== 'object') return false;
	for (const [key, child] of Object.entries(value)) {
		if (key === 'oneOf' || key === 'anyOf' || key === 'allOf' || key === 'if' || key === 'then' || key === 'else' || key === 'const') return true;
		if (containsCompositionOrConst(child)) return true;
	}
	return false;
};

suite('Void write_file model-facing schema', () => {
	test('uses the flat agent schema while leaving branch enforcement to the runtime', () => {
		const writeFile = availableTools('agent', undefined)?.find(tool => tool.name === 'write_file');
		assert.ok(writeFile?.schema);
		const schema = writeFile.schema as { type: string; additionalProperties: boolean; required: string[]; properties: Record<string, { type: string; enum?: string[]; minItems?: number; additionalProperties?: boolean; required?: string[]; items?: { type: string; additionalProperties: boolean; required: string[] } }> };

		assert.strictEqual(schema.type, 'object');
		assert.strictEqual(schema.additionalProperties, false);
		assert.deepStrictEqual(schema.required, ['uri', 'operation']);
		assert.deepStrictEqual(schema.properties.operation.enum, ['create', 'modify']);
		assert.strictEqual(schema.properties.content.type, 'string');
		assert.strictEqual(schema.properties.read_receipt_id.type, 'string');
		assert.strictEqual(schema.properties.edits.type, 'array');
		assert.strictEqual(schema.properties.edits.minItems, 1);
		assert.strictEqual(schema.properties.edits.items?.type, 'object');
		assert.strictEqual(schema.properties.edits.items?.additionalProperties, false);
		assert.deepStrictEqual(schema.properties.edits.items?.required, ['old_text', 'new_text']);
		assert.strictEqual(containsCompositionOrConst(schema), false);
	});
});
