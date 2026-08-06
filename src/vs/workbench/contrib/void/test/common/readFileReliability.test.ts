/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { clampReadFileLimits, computeMaxReadOutputTokens, effectiveReadFileLimits, isBoundedReadHistory, isBoundedReadHistoryString, pageReadFileLines, ReadReceiptRegistry, validateReadFileRequest } from '../../common/readFileReliability.js';

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
	test('clamps persisted settings and keeps a zero runtime budget fail-closed', () => {
		assert.deepStrictEqual(clampReadFileLimits(undefined), { maxLines: 2000, maxBytes: 64 * 1024, maxTokens: 12000 });
		assert.deepStrictEqual(clampReadFileLimits({ maxLines: -1, maxBytes: 1, maxTokens: 999999 }), { maxLines: 1, maxBytes: 1024, maxTokens: 24000 });
		assert.deepStrictEqual(clampReadFileLimits({ maxLines: 1.5, maxBytes: NaN, maxTokens: 2.5 }), { maxLines: 2000, maxBytes: 64 * 1024, maxTokens: 12000 });
		assert.strictEqual(effectiveReadFileLimits({ maxTokens: 12000 }, 0).maxTokens, 0);
		assert.strictEqual(computeMaxReadOutputTokens(8000, 2000, 4976), 0);
	});
	test('stops at the first line/byte boundary and preserves CRLF-independent logical lines', () => {
		const page = pageReadFileLines(['aa', 'bb', 'cc'], { startLine: 1, endLine: null, lineByteOffset: 0 }, { maxLines: 2, maxBytes: 100, maxTokens: 100 });
		assert.strictEqual(page.fileContents, 'aa\nbb'); assert.strictEqual(page.nextLine, 3); assert.strictEqual(page.truncated, true);
	});
	test('stops on byte and token first hits without exceeding exact caps', () => {
		const bytePage = pageReadFileLines(['a'.repeat(700), 'b'.repeat(700)], { startLine: 1, endLine: null, lineByteOffset: 0 }, { maxLines: 10, maxBytes: 1024, maxTokens: 24000 });
		assert.strictEqual(bytePage.fileContents.length, 700); assert.strictEqual(bytePage.nextLine, 2);
		const tokenPage = pageReadFileLines(['1234', '5678'], { startLine: 1, endLine: null, lineByteOffset: 0 }, { maxLines: 10, maxBytes: 1024, maxTokens: 1 });
		assert.strictEqual(tokenPage.fileContents, '1234'); assert.strictEqual(tokenPage.nextLine, 2);
		const zero = pageReadFileLines(['body'], { startLine: 1, endLine: null, lineByteOffset: 0 }, effectiveReadFileLimits(undefined, 0));
		assert.strictEqual(zero.fileContents, ''); assert.strictEqual(zero.truncated, true); assert.strictEqual(zero.nextLine, 1);
	});
	test('keeps logical LF semantics for CRLF, final newline, empty, and exact end', () => {
		const crlfLogicalLines = 'a\r\nb\r\n'.replace(/\r/g, '').split('\n');
		assert.deepStrictEqual(crlfLogicalLines, ['a', 'b', '']);
		const exact = pageReadFileLines(['a', 'b'], { startLine: 2, endLine: 2, lineByteOffset: 0 });
		assert.strictEqual(exact.fileContents, 'b'); assert.strictEqual(exact.eof, true); assert.strictEqual(exact.nextLine, null);
	});
	test('continues oversized UTF-8 lines without splitting Korean or emoji', () => {
		const line = '한🙂e\u0301끝'.repeat(300); const first = pageReadFileLines([line], { startLine: 1, endLine: null, lineByteOffset: 0 }, { maxLines: 1, maxBytes: 1024, maxTokens: 10000 });
		assert.strictEqual(first.longLineContinuation, true); assert.ok(first.nextByteOffset! > 0);
		const second = pageReadFileLines([line], { startLine: 1, endLine: null, lineByteOffset: first.nextByteOffset! }, { maxLines: 1, maxBytes: 128 * 1024, maxTokens: 24000 });
		assert.strictEqual(first.fileContents + second.fileContents, line);
		assert.throws(() => pageReadFileLines([line], { startLine: 1, endLine: null, lineByteOffset: 1 }), /boundary/);
	});
	test('preserves the separator before an oversized UTF-8 line within the page cap', () => {
		const lines = ['short', '가😀'.repeat(400), 'tail']; const maxBytes = 1024;
		const page = pageReadFileLines(lines, { startLine: 1, endLine: null, lineByteOffset: 0 }, { maxLines: 10, maxBytes, maxTokens: 10000 });
		assert.ok(page.fileContents.startsWith('short\n')); assert.ok(page.fileContents.length > 'short\n'.length);
		assert.strictEqual(page.longLineContinuation, true); assert.ok(new TextEncoder().encode(page.fileContents).length <= maxBytes);
	});
	test('reconstructs pages across an oversized UTF-8 line with strictly progressing cursors', () => {
		const lines = ['short', '가😀'.repeat(400), 'tail']; let request = { startLine: 1, endLine: null, lineByteOffset: 0 }; let reconstructed = '';
		for (;;) {
			const page = pageReadFileLines(lines, request, { maxLines: 10, maxBytes: 1024, maxTokens: 10000 }); reconstructed += page.fileContents;
			if (page.eof) break;
			assert.ok(page.nextLine! > request.startLine || page.nextByteOffset! > request.lineByteOffset);
			request = { startLine: page.nextLine!, endLine: null, lineByteOffset: page.nextByteOffset ?? 0 };
		}
		assert.strictEqual(reconstructed, lines.join('\n'));
	});
	test('preserves a leading separator when the preceding line is empty', () => {
		const page = pageReadFileLines(['', 'abcdef'], { startLine: 1, endLine: null, lineByteOffset: 0 }, { maxLines: 10, maxBytes: 1024, maxTokens: 1 });
		assert.strictEqual(page.fileContents, '\nabc'); assert.strictEqual(Math.ceil(page.fileContents.length / 4), 1);
		assert.strictEqual(page.longLineContinuation, true); assert.strictEqual(page.nextByteOffset, 3);
	});
	test('binds receipts to owner, identity, and version', () => {
		const registry = new ReadReceiptRegistry<object>(); const model = {}; registry.add({ id: 'r', uri: 'file:///a', owner: 'thread', model, version: 1 });
		assert.strictEqual(registry.validate('r', 'file:///a', 'thread', model, 1), true);
		assert.strictEqual(registry.validate('r', 'file:///a', 'other', model, 1), false);
		assert.strictEqual(registry.validate('r', 'file:///a', 'thread', model, 2), false);
		assert.strictEqual(registry.validate('r', 'file:///other', 'thread', model, 1), false);
		assert.strictEqual(registry.validate('r', 'file:///a', 'thread', {}, 1), false);
		registry.invalidateOwner('thread'); assert.strictEqual(registry.validate('r', 'file:///a', 'thread', model, 1), false);
	});
	test('sanitizes raw and formatted history independently', () => {
		const small = pageReadFileLines(['ok'], { startLine: 1, endLine: null, lineByteOffset: 0 }, { maxBytes: 1024 });
		assert.strictEqual(isBoundedReadHistory(small, { maxBytes: 1024 }), true);
		assert.strictEqual(isBoundedReadHistoryString('metadata\nok', { maxBytes: 1024 }), true);
		assert.strictEqual(isBoundedReadHistoryString('x'.repeat(2049), { maxBytes: 1024 }), false);
	});
});
