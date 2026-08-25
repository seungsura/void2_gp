/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { IChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { LLMMessageService } from '../../common/sendLLMMessageService.js';

type ModelListEvent = { requestId: string; models?: readonly unknown[]; error?: unknown };

const hookCardinality = (service: LLMMessageService): number => {
	const hooks = (service as any).listHooks;
	return Object.keys(hooks.ollama.success).length
		+ Object.keys(hooks.ollama.error).length
		+ Object.keys(hooks.openAICompat.success).length
		+ Object.keys(hooks.openAICompat.error).length;
};

const createFixture = () => {
	const emitters = new Map<string, Emitter<ModelListEvent>>();
	const calls: Array<{ command: string; params: any }> = [];
	let call = (_command: string, _params: unknown): Promise<unknown> => Promise.resolve();
	const channel: IChannel = {
		listen<T>(event: string) {
			let emitter = emitters.get(event);
			if (!emitter) { emitter = new Emitter<ModelListEvent>(); emitters.set(event, emitter); }
			return emitter.event as any;
		},
		call<T>(command: string, params?: unknown): Promise<T> {
			calls.push({ command, params });
			return call(command, params) as Promise<T>;
		},
	};
	const service = new LLMMessageService(
		{ getChannel: () => channel } as never,
		{ state: { settingsOfProvider: {} } } as never,
		{ getMCPTools: () => [] } as never,
	);
	return {
		service,
		calls,
		setCall(value: typeof call) { call = value; },
		emit(event: string, value: ModelListEvent) { emitters.get(event)?.fire(value); },
	};
};

suite('Void LLMMessageService model-list hook lifecycle', () => {
	test('returns list-hook cardinality to baseline after 100 successful and 100 failed refreshes', () => {
		const fixture = createFixture();
		const baseline = hookCardinality(fixture.service);
		let successes = 0;
		let failures = 0;
		for (let index = 0; index < 100; index++) {
			const ollama = index % 2 === 0;
			if (ollama) fixture.service.ollamaList({ providerName: 'ollama', onSuccess: () => successes++, onError: () => failures++ });
			else fixture.service.openAICompatibleList({ providerName: 'vLLM', onSuccess: () => successes++, onError: () => failures++ });
			const requestId = fixture.calls.at(-1)!.params.requestId;
			const event = ollama ? 'onSuccess_list_ollama' : 'onSuccess_list_openAICompatible';
			fixture.emit(event, { requestId, models: [] });
			fixture.emit(event, { requestId, models: [] });
		}
		for (let index = 0; index < 100; index++) {
			const ollama = index % 2 === 0;
			if (ollama) fixture.service.ollamaList({ providerName: 'ollama', onSuccess: () => successes++, onError: () => failures++ });
			else fixture.service.openAICompatibleList({ providerName: 'vLLM', onSuccess: () => successes++, onError: () => failures++ });
			const requestId = fixture.calls.at(-1)!.params.requestId;
			const event = ollama ? 'onError_list_ollama' : 'onError_list_openAICompatible';
			fixture.emit(event, { requestId, error: 'refresh failed' });
			fixture.emit(event, { requestId, error: 'late duplicate' });
		}
		assert.strictEqual(successes, 100);
		assert.strictEqual(failures, 100);
		assert.strictEqual(hookCardinality(fixture.service), baseline);
		fixture.service.dispose();
	});

	test('cleans model-list hooks after call rejection, callback failure, and disposal', async () => {
		const fixture = createFixture();
		const baseline = hookCardinality(fixture.service);
		let rejected = 0;
		fixture.setCall(() => Promise.reject(new Error('channel rejected')));
		fixture.service.ollamaList({ providerName: 'ollama', onSuccess: () => assert.fail('unexpected success'), onError: ({ error }) => { rejected++; assert.strictEqual((error as Error).message, 'channel rejected'); } });
		await Promise.resolve();
		await Promise.resolve();
		assert.strictEqual(rejected, 1);
		assert.strictEqual(hookCardinality(fixture.service), baseline);

		fixture.setCall(() => Promise.resolve());
		fixture.service.openAICompatibleList({ providerName: 'vLLM', onSuccess: () => { throw new Error('callback failed'); }, onError: () => assert.fail('unexpected error') });
		const callbackRequest = fixture.calls.at(-1)!.params.requestId;
		assert.throws(() => (fixture.service as any)._settleListHook('openAICompat', 'success', callbackRequest, { requestId: callbackRequest, models: [] }), /callback failed/);
		assert.strictEqual(hookCardinality(fixture.service), baseline);

		fixture.service.ollamaList({ providerName: 'ollama', onSuccess: () => assert.fail('unexpected success'), onError: () => assert.fail('unexpected error') });
		assert.ok(hookCardinality(fixture.service) > baseline);
		fixture.service.dispose();
		assert.strictEqual(hookCardinality(fixture.service), baseline);
	});
});
