/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { isWriteFileReceiptCurrent, planWriteFileModify, WriteFileReceipt } from '../../common/writeFilePlanner.js';

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
		assert.strictEqual(planWriteFileModify('same\n', [{ oldText: 'same', newText: 'same' }]), null);
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

	test('requires the prepared model identity, version, and LF snapshot at mutation time', () => {
		const model = {};
		const plan = planWriteFileModify('before\n', [{ oldText: 'before', newText: 'after' }]);
		assert.ok(plan);
		const receipt: WriteFileReceipt<object> = { model, versionId: 7, lfText: 'before\n', plan: plan! };
		assert.strictEqual(isWriteFileReceiptCurrent(receipt, model, 7, 'before\n'), true);
		assert.strictEqual(isWriteFileReceiptCurrent(receipt, {}, 7, 'before\n'), false);
		assert.strictEqual(isWriteFileReceiptCurrent(receipt, model, 8, 'before\n'), false);
		assert.strictEqual(isWriteFileReceiptCurrent(receipt, model, 7, 'changed\n'), false);
	});
});
