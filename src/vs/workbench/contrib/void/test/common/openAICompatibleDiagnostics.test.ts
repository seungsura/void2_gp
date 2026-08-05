/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { classifyOpenAICompatibleToolSchemaDialect, formatPrematureStreamCloseMessage, isPrematureStreamClose, redactOpenAICompatibleEndpoint } from '../../electron-main/llmMessage/openAICompatibleDiagnostics.js';

suite('OpenAI-compatible streaming diagnostics', () => {
	test('redacts endpoint userinfo, query, and hash', () => {
		assert.strictEqual(redactOpenAICompatibleEndpoint('https://user:secret@example.test/v1?api_key=secret#fragment'), 'https://example.test/v1');
		assert.strictEqual(redactOpenAICompatibleEndpoint('not a URL'), '<invalid-endpoint>');
	});
	test('classifies only schema shape, not values', () => {
		assert.strictEqual(classifyOpenAICompatibleToolSchemaDialect(undefined), 'none');
		assert.strictEqual(classifyOpenAICompatibleToolSchemaDialect([{ function: { parameters: { type: 'object', properties: { secret: { type: 'string', description: 'prompt value' } } } } }]), 'flat');
		assert.strictEqual(classifyOpenAICompatibleToolSchemaDialect([{ function: { parameters: { oneOf: [{ type: 'object', properties: { operation: { const: 'modify' } } }] } } }]), 'oneOf-or-composition');
		assert.strictEqual(classifyOpenAICompatibleToolSchemaDialect([{ function: { parameters: { type: 'array' } } }]), 'other');
	});
	test('detects direct and nested premature close codes', () => {
		assert.strictEqual(isPrematureStreamClose({ code: 'ERR_STREAM_PREMATURE_CLOSE' }), true);
		assert.strictEqual(isPrematureStreamClose({ cause: { cause: { code: 'ERR_STREAM_PREMATURE_CLOSE' } } }), true);
		assert.strictEqual(isPrematureStreamClose({ code: 'ECONNRESET' }), false);
	});
	test('formats phases without endpoint secrets, prompts, or tool values', () => {
		const before = formatPrematureStreamCloseMessage({ endpoint: 'https://example.test/v1', model: 'gpt-4.1', chatMode: 'agent', toolCount: 3, toolSchemaDialect: 'oneOf-or-composition', dispatchAttempted: true, responseHeadersReceived: false, httpStatus: undefined, requestId: undefined, firstParsedStreamEvent: false });
		const after = formatPrematureStreamCloseMessage({ endpoint: 'https://example.test/v1', model: 'gpt-4.1', chatMode: 'agent', toolCount: 3, toolSchemaDialect: 'oneOf-or-composition', dispatchAttempted: true, responseHeadersReceived: true, httpStatus: 200, requestId: 'req_123', firstParsedStreamEvent: true });
		assert.match(before, /after-sdk-dispatch-attempt-before-response-headers/);
		assert.match(after, /after-first-parsed-stream-event/);
		assert.match(after, /status=200/);
		assert.match(after, /requestId=req_123/);
		assert.ok(!after.includes('secret') && !after.includes('prompt value') && !after.includes('modify'));
	});
});
