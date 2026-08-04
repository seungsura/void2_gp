/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { pageReadFileLines, ReadReceiptRegistry, validateReadFileRequest } from '../../common/readFileReliability.js';

suite('Void read_file reliability', () => {
	test('uses 1-based inclusive line ranges and deterministic EOF cases', () => {
		const page = pageReadFileLines(['one', 'two', 'three'], { startLine: 2, endLine: 3, lineByteOffset: 0 });
		assert.strictEqual(page.fileContents, 'two\nthree'); assert.strictEqual(page.endLine, 3); assert.strictEqual(page.eof, true);
		assert.strictEqual(pageReadFileLines([], { startLine: 1, endLine: null, lineByteOffset: 0 }).eof, true);
		assert.strictEqual(pageReadFileLines(['x'], { startLine: 2, endLine: null, lineByteOffset: 0 }).nextLine, null);
	});
	test('accepts only legacy page one', () => {
		assert.deepStrictEqual(validateReadFileRequest({ page_number: 1 }), { startLine: 1, endLine: null, lineByteOffset: 0 });
		assert.throws(() => validateReadFileRequest({ page_number: 2 }), /next_line/);
	});
	test('stops at the first line/byte boundary and preserves CRLF-independent logical lines', () => {
		const page = pageReadFileLines(['aa', 'bb', 'cc'], { startLine: 1, endLine: null, lineByteOffset: 0 }, { maxLines: 2, maxBytes: 100, maxTokens: 100 });
		assert.strictEqual(page.fileContents, 'aa\nbb'); assert.strictEqual(page.nextLine, 3); assert.strictEqual(page.truncated, true);
	});
	test('continues oversized UTF-8 lines without splitting Korean or emoji', () => {
		const line = '한🙂e\u0301끝'.repeat(300); const first = pageReadFileLines([line], { startLine: 1, endLine: null, lineByteOffset: 0 }, { maxLines: 1, maxBytes: 1024, maxTokens: 10000 });
		assert.strictEqual(first.longLineContinuation, true); assert.ok(first.nextByteOffset! > 0);
		const second = pageReadFileLines([line], { startLine: 1, endLine: null, lineByteOffset: first.nextByteOffset! }, { maxLines: 1, maxBytes: 128 * 1024, maxTokens: 24000 });
		assert.strictEqual(first.fileContents + second.fileContents, line);
		assert.throws(() => pageReadFileLines([line], { startLine: 1, endLine: null, lineByteOffset: 1 }), /boundary/);
	});
	test('binds receipts to owner, identity, and version', () => {
		const registry = new ReadReceiptRegistry<object>(); const model = {}; registry.add({ id: 'r', uri: 'file:///a', owner: 'thread', model, version: 1 });
		assert.strictEqual(registry.validate('r', 'file:///a', 'thread', model, 1), true);
		assert.strictEqual(registry.validate('r', 'file:///a', 'other', model, 1), false);
		assert.strictEqual(registry.validate('r', 'file:///a', 'thread', model, 2), false);
	});
});
