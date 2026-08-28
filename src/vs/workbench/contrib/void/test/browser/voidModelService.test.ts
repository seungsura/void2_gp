/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { getSingletonServiceDescriptors } from '../../../../../platform/instantiation/common/extensions.js';
import { IVoidModelService } from '../../common/voidModelService.js';

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void };
const deferred = <T>(): Deferred<T> => {
	let resolve!: (value: T) => void;
	return { promise: new Promise<T>(next => resolve = next), resolve };
};

suite('Void model reference initialization', () => {
	test('retries a synchronous resolver failure, coalesces canonical URIs, and disposes a late reference', async () => {
		const descriptor = getSingletonServiceDescriptors().find(([id]) => id === IVoidModelService)?.[1];
		assert.ok(descriptor, 'VoidModelService must be registered before this runtime fixture');
		const identity = { extUri: { getComparisonKey: (uri: URI) => uri.toString().toLowerCase() } };
		const fileService = { save: async () => { } };
		let calls = 0;
		const retryReference = { object: { textEditorModel: { uri: URI.parse('file:///workspace/retry.ts') } }, dispose() { } };
		const retryResolver = { createModelReference: () => { calls += 1; if (calls === 1) throw new Error('synchronous resolver failure'); return Promise.resolve(retryReference); } };
		const retry = new descriptor!.ctor(retryResolver, fileService, identity) as IVoidModelService & { dispose(): void };
		const originalLog = console.log;
		console.log = () => { };
		const retryUri = URI.parse('file:///workspace/retry.ts');
		try { assert.strictEqual((await retry.getModelSafe(retryUri)).editorModel, null); } finally { console.log = originalLog; }
		assert.strictEqual((await retry.getModelSafe(retryUri)).editorModel, retryReference.object);
		assert.strictEqual(calls, 2);
		assert.strictEqual(retry.getModel(URI.parse('file:///WORKSPACE/RETRY.ts')).editorModel, retryReference.object);

		const coalesced = deferred<typeof retryReference>(); let coalescedCalls = 0;
		const coalescedResolver = { createModelReference: async () => { coalescedCalls += 1; return coalesced.promise; } };
		const shared = new descriptor!.ctor(coalescedResolver, fileService, identity) as IVoidModelService & { dispose(): void };
		const first = shared.initializeModel(URI.parse('file:///workspace/Case.ts'));
		const second = shared.initializeModel(URI.parse('file:///WORKSPACE/case.ts'));
		await Promise.resolve(); assert.strictEqual(coalescedCalls, 1);
		coalesced.resolve(retryReference); await Promise.all([first, second]);
		assert.strictEqual(shared.getModel(URI.parse('file:///workspace/case.ts')).editorModel, retryReference.object);

		const late = deferred<typeof retryReference>(); let lateDisposed = 0;
		const lateReference = { object: { textEditorModel: { uri: URI.parse('file:///workspace/late.ts') } }, dispose() { lateDisposed += 1; } };
		const lateResolver = { createModelReference: async () => late.promise };
		const disposed = new descriptor!.ctor(lateResolver, fileService, identity) as IVoidModelService & { dispose(): void };
		const pending = disposed.initializeModel(URI.parse('file:///workspace/late.ts'));
		await Promise.resolve(); disposed.dispose(); late.resolve(lateReference); await pending;
		assert.strictEqual(lateDisposed, 1);
		assert.strictEqual(disposed.getModel(URI.parse('file:///workspace/late.ts')).editorModel, null);
		retry.dispose(); shared.dispose();
	});
});
