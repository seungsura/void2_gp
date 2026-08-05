/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { restoreWriteFileEditorSnapshot, runWriteFileEditorTransaction } from '../../common/writeFileEditorTransaction.js';

suite('Void write_file editor transaction', () => {
	test('writes, publishes the diff, and waits for save', async () => {
		const calls: string[] = [];
		await runWriteFileEditorTransaction({
			write: () => { calls.push('write'); },
			markStreamingComplete: () => { calls.push('stream-complete'); },
			refreshDiffs: () => { calls.push('refresh-diffs'); },
			shouldAutoAccept: false,
			autoAccept: async () => { calls.push('auto-accept'); },
			finishAndSave: async () => { calls.push('finish-and-save'); },
		});

		assert.deepStrictEqual(calls, ['write', 'stream-complete', 'refresh-diffs', 'finish-and-save']);
	});

	test('auto-accepts before capturing the saved after snapshot', async () => {
		const calls: string[] = [];
		await runWriteFileEditorTransaction({
			write: () => { calls.push('write'); },
			markStreamingComplete: () => { calls.push('stream-complete'); },
			refreshDiffs: () => { calls.push('refresh-diffs'); },
			shouldAutoAccept: true,
			autoAccept: async () => { calls.push('auto-accept'); },
			finishAndSave: async () => { calls.push('finish-and-save'); },
		});

		assert.deepStrictEqual(calls, ['write', 'stream-complete', 'refresh-diffs', 'auto-accept', 'finish-and-save']);
	});

	test('saves after restoring a structured write snapshot', async () => {
		const calls: string[] = [];
		await restoreWriteFileEditorSnapshot({
			restore: async () => { calls.push('restore'); },
			save: async () => { calls.push('save'); },
		});

		assert.deepStrictEqual(calls, ['restore', 'save']);
	});
});
