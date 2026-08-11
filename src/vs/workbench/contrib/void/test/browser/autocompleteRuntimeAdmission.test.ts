/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { AutocompleteService } from '../../browser/autocompleteService.js';

suite('Void legacy FIM autocomplete runtime admission', () => {
	test('fails closed before reading a model or preparing and sending a FIM request', async () => {
		let modelTouched = 0;
		let prepareCalls = 0;
		let sendCalls = 0;
		const poisonedModel = new Proxy({}, {
			get() {
				modelTouched += 1;
				throw new Error('retired autocomplete must not read the editor model');
			},
		});
		const receiver = {
			_settingsService: {
				state: {
					globalSettings: { enableAutocomplete: true },
					modelSelectionOfFeature: new Proxy({}, {
						get() {
							throw new Error('retired autocomplete must not select a model');
						},
					}),
				},
			},
			_convertToLLMMessageService: {
				prepareFIMMessage() {
					prepareCalls += 1;
					throw new Error('retired autocomplete must not prepare a FIM request');
				},
			},
			_llmMessageService: {
				sendLLMMessage() {
					sendCalls += 1;
					throw new Error('retired autocomplete must not send a FIM request');
				},
			},
		};

		const result = await AutocompleteService.prototype._provideInlineCompletionItems.call(receiver as never, poisonedModel as never, {} as never);

		assert.deepStrictEqual(result, []);
		assert.strictEqual(modelTouched, 0);
		assert.strictEqual(prepareCalls, 0);
		assert.strictEqual(sendCalls, 0);
	});
});
