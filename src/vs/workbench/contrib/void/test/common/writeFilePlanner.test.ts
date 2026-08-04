/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { planWriteFileModify } from '../../common/writeFilePlanner.js';

suite('Void write_file planner', () => {
	test('creates one result from multiple exact whole-line replacements', () => {
		const plan = planWriteFileModify('one\ntwo\nthree\n', [
			{ oldText: 'one', newText: 'ONE' },
			{ oldText: 'three', newText: 'THREE' },
		]);
		assert.deepStrictEqual(plan?.newText, 'ONE\ntwo\nTHREE\n');
	});

	test('rejects ambiguous, partial, overlapping, and malformed edits before mutation', () => {
		assert.strictEqual(planWriteFileModify('same\nsame\n', [{ oldText: 'same', newText: 'x' }]), null);
		assert.strictEqual(planWriteFileModify('prefix value\n', [{ oldText: 'value', newText: 'x' }]), null);
		assert.strictEqual(planWriteFileModify('a\nb\n', [{ oldText: 'a\nb', newText: 'x' }, { oldText: 'b', newText: 'y' }]), null);
		assert.strictEqual(planWriteFileModify('text\n', []), null);
	});

	test('allows only the empty-snapshot create-like modify exception and preserves BOM/CRLF data', () => {
		assert.deepStrictEqual(planWriteFileModify('', [{ oldText: '', newText: 'created' }])?.newText, 'created');
		assert.strictEqual(planWriteFileModify('not empty', [{ oldText: '', newText: 'x' }]), null);
		assert.deepStrictEqual(planWriteFileModify('\uFEFFa\r\nb\r\n', [{ oldText: 'a\r\nb', newText: 'x' }])?.newText, '\uFEFFx\r\n');
	});

	test('treats conflict marker strings as ordinary payload', () => {
		const plan = planWriteFileModify('<<<<<<<\n=======\n>>>>>>>\n', [{ oldText: '=======', newText: 'marker' }]);
		assert.deepStrictEqual(plan?.newText, '<<<<<<<\nmarker\n>>>>>>>\n');
	});
});
