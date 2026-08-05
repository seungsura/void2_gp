/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { assertReadFilePageMakesProgress, effectiveReadFileLimits, pageReadFileLines } from '../../common/readFileReliability.js';

suite('Void read_file forward progress', () => {
	test('rejects a zero-budget truncated page without a continuation cursor', () => {
		const request = { startLine: 1, endLine: null, lineByteOffset: 0 };
		const page = pageReadFileLines(['body'], request, effectiveReadFileLimits(undefined, 0));
		assert.strictEqual(page.truncated, true);
		assert.strictEqual(page.eof, false);
		assert.throws(() => assertReadFilePageMakesProgress(page, request), /read_file context_exhausted/);
	});

	test('accepts line progress, UTF-8 byte progress, and EOF', () => {
		const lineRequest = { startLine: 1, endLine: null, lineByteOffset: 0 };
		const linePage = pageReadFileLines(['one', 'two'], lineRequest, { maxLines: 1, maxBytes: 1024, maxTokens: 100 });
		assert.doesNotThrow(() => assertReadFilePageMakesProgress(linePage, lineRequest));

		const byteRequest = { startLine: 1, endLine: null, lineByteOffset: 0 };
		const bytePage = pageReadFileLines(['가'.repeat(600)], byteRequest, { maxLines: 1, maxBytes: 1024, maxTokens: 10000 });
		assert.ok(bytePage.nextByteOffset! > byteRequest.lineByteOffset);
		assert.doesNotThrow(() => assertReadFilePageMakesProgress(bytePage, byteRequest));

		const eofPage = pageReadFileLines(['done'], lineRequest, { maxLines: 1, maxBytes: 1024, maxTokens: 100 });
		assert.strictEqual(eofPage.eof, true);
		assert.doesNotThrow(() => assertReadFilePageMakesProgress(eofPage, lineRequest));
	});
});
