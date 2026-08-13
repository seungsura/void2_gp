import * as assert from 'assert';
import { createServer, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { LLMMessageChannel } from '../../electron-main/sendLLMMessageChannel.js';
import { sendLLMMessage } from '../../electron-main/llmMessage/sendLLMMessage.js';
import { sendLLMMessageToProviderImplementation } from '../../electron-main/llmMessage/sendLLMMessage.impl.js';

const params = (requestId: string) => ({ requestId, messagesType: 'chatMessages', messages: [{ role: 'user', content: 'fixture' }], separateSystemMessage: undefined, chatMode: 'agent', logging: { loggingName: 'fixture' }, settingsOfProvider: {}, modelSelection: { providerName: 'openAI', modelName: 'fixture' }, modelSelectionOptions: undefined, overridesOfModel: undefined, mcpTools: undefined }) as any;
const ghostParams = (requestId: string, endpoint = 'http://127.0.0.1:1/v1') => ({
	requestId,
	requestProfile: 'ghost-chat',
	messagesType: 'chatMessages',
	messages: [{ role: 'user', content: 'Return insertion text only.\n<PREFIX>foo</PREFIX><CURSOR><SUFFIX>;</SUFFIX>' }],
	separateSystemMessage: undefined,
	chatMode: null,
	logging: { loggingName: 'Ghost Chat' },
	settingsOfProvider: { openAICompatible: { endpoint, apiKey: 'fixture-key', headersJSON: '{}' } },
	modelSelection: { providerName: 'openAICompatible', modelName: 'gpt-4.1' },
	modelSelectionOptions: undefined,
	overridesOfModel: undefined,
	mcpTools: [],
	toolExecutionProfile: undefined,
	agentDelegationAllowed: false,
}) as any;
const metrics = { capture() { } } as any;

suite('Void LLM message channel lifecycle', () => {
	test('immediate abort returns without awaiting setup and invokes a late aborter', async () => {
		let release!: () => void; let lateAbort = 0; let captured: any;
		const send = async (value: any) => { captured = value; await new Promise<void>(resolve => release = resolve); };
		const channel = new LLMMessageChannel(metrics, send as never); (channel as any)._callSendLLMMessage(params('early'));
		(channel as any)._callAbort({ requestId: 'early' }); assert.strictEqual((channel as any)._infoOfRunningRequest.early, undefined);
		captured.abortRef.current = () => lateAbort++; assert.strictEqual(lateAbort, 1); release();
	});

	test('final cleans request once and drops duplicate terminal callbacks', () => {
		let captured: any; let finals = 0; let texts = 0; const channel = new LLMMessageChannel(metrics, (async (value: any) => { captured = value; }) as never); channel.listen(undefined, 'onFinalMessage_sendLLMMessage')(() => finals++); channel.listen(undefined, 'onText_sendLLMMessage')(() => texts++); (channel as any)._callSendLLMMessage(params('final'));
		const result = { fullText: 'done', fullReasoning: '', anthropicReasoning: null }; captured.onFinalMessage(result); captured.onFinalMessage(result); captured.onText({ fullText: 'late', fullReasoning: '' }); assert.strictEqual(finals, 1); assert.strictEqual(texts, 0); assert.strictEqual((channel as any)._infoOfRunningRequest.final, undefined);
	});

	test('error cleans request once and later abort is idempotent', () => {
		let captured: any; let errors = 0; const channel = new LLMMessageChannel(metrics, (async (value: any) => { captured = value; }) as never); channel.listen(undefined, 'onError_sendLLMMessage')(() => errors++); (channel as any)._callSendLLMMessage(params('error'));
		captured.onError({ message: 'failed', fullError: null }); captured.onError({ message: 'late', fullError: null }); (channel as any)._callAbort({ requestId: 'error' }); assert.strictEqual(errors, 1); assert.strictEqual((channel as any)._infoOfRunningRequest.error, undefined);
	});

	test('real wrapper invokes a late provider aborter once and drops late callbacks', async () => {
		const implementation = sendLLMMessageToProviderImplementation.openAI; const original = implementation.sendChat;
		let release!: () => void; let providerAborts = 0; let finals = 0; let texts = 0; let errors = 0;
		implementation.sendChat = async options => { await new Promise<void>(resolve => release = resolve); options._setAborter(() => providerAborts++); options.onText({ fullText: 'late', fullReasoning: '' }); options.onFinalMessage({ fullText: 'late', fullReasoning: '', anthropicReasoning: null }); options.onError({ message: 'late', fullError: null }); };
		try {
			const abortRef: any = { current: null }; const call = sendLLMMessage({ ...params('wrapper'), abortRef, onText: () => texts++, onFinalMessage: () => finals++, onError: () => errors++ } as any, metrics);
			assert.strictEqual(typeof abortRef.current, 'function'); abortRef.current(); release(); await call; abortRef.current();
			assert.strictEqual(providerAborts, 1); assert.strictEqual(texts, 0); assert.strictEqual(finals, 0); assert.strictEqual(errors, 0);
		} finally { implementation.sendChat = original; }
	});

	test('real wrapper records a finite nonnegative completion duration', async () => {
		const implementation = sendLLMMessageToProviderImplementation.openAI; const original = implementation.sendChat; const captured: any[] = []; let finals = 0;
		implementation.sendChat = async options => { options.onFinalMessage({ fullText: 'done', fullReasoning: '', anthropicReasoning: null }); };
		try {
			await sendLLMMessage({ ...params('duration'), abortRef: { current: null }, onText: () => { }, onFinalMessage: () => finals++, onError: () => assert.fail('unexpected error') } as any, { capture: (event: string, values: any) => captured.push({ event, values }) } as any);
			const received = captured.find(event => event.event === 'fixture - Received Full Message'); assert.strictEqual(finals, 1); assert.strictEqual(typeof received?.values.duration, 'number'); assert.ok(Number.isFinite(received.values.duration)); assert.ok(received.values.duration >= 0);
		} finally { implementation.sendChat = original; }
	});

	test('ghost-chat profile fails closed on provider or model mismatch before dispatch', async () => {
		const implementation = sendLLMMessageToProviderImplementation.openAICompatible; const original = implementation.sendChat;
		let dispatches = 0;
		implementation.sendChat = async () => { dispatches++; };
		try {
			for (const mismatch of [
				{ modelSelection: { providerName: 'openAI', modelName: 'gpt-4.1' } },
				{ modelSelection: { providerName: 'openAICompatible', modelName: 'not-gpt-4.1' } },
			]) {
				let error = '';
				await sendLLMMessage({ ...ghostParams('mismatch'), ...mismatch, abortRef: { current: null }, onText: () => { }, onFinalMessage: () => assert.fail('unexpected final'), onError: ({ message }: { message: string }) => error = message } as any, metrics);
				assert.match(error, /Ghost Chat request rejected/);
			}
			assert.strictEqual(dispatches, 0);
		}
		finally { implementation.sendChat = original; }
	});

	test('ghost-chat loopback serializes fixed body and keeps channel record until SSE terminal', async () => {
		let requestPath = '';
		let requestBody: any;
		let response: ServerResponse | undefined;
		let released = false;
		let requestReceivedResolve!: () => void;
		const requestReceived = new Promise<void>(resolve => requestReceivedResolve = resolve);
		const server = createServer((request, serverResponse) => {
			const chunks: Buffer[] = [];
			request.on('data', chunk => chunks.push(Buffer.from(chunk)));
			request.on('end', () => {
				requestPath = request.url ?? '';
				requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
				response = serverResponse;
				serverResponse.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'x-request-id': 'ghost-loopback' });
				serverResponse.write(`data: ${JSON.stringify({ id: 'chatcmpl-ghost', object: 'chat.completion.chunk', created: 0, model: 'gpt-4.1', choices: [{ index: 0, delta: { role: 'assistant', content: 'bar' }, finish_reason: null }] })}\n\n`);
				requestReceivedResolve();
			});
		});
		await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
		const release = () => {
			if (released || !response) return;
			released = true;
			response.write(`data: ${JSON.stringify({ id: 'chatcmpl-ghost', object: 'chat.completion.chunk', created: 0, model: 'gpt-4.1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
			response.end('data: [DONE]\n\n');
		};

		try {
			const address = server.address() as AddressInfo;
			const channel = new LLMMessageChannel(metrics);
			let finalText = '';
			const final = new Promise<void>(resolve => channel.listen(undefined, 'onFinalMessage_sendLLMMessage')(event => {
				if (event.requestId !== 'ghost-loopback') return;
				finalText = event.fullText;
				resolve();
			}));
			(channel as any)._callSendLLMMessage(ghostParams('ghost-loopback', `http://127.0.0.1:${address.port}/v1`));
			await requestReceived;
			await new Promise(resolve => setTimeout(resolve, 10));

			assert.strictEqual(requestPath, '/v1/chat/completions');
			assert.strictEqual(requestBody.model, 'gpt-4.1');
			assert.strictEqual(requestBody.stream, true);
			assert.strictEqual(requestBody.reasoning_effort, 'none');
			assert.strictEqual(requestBody.max_completion_tokens, 256);
			assert.deepStrictEqual(requestBody.messages, ghostParams('body').messages);
			assert.strictEqual(Object.prototype.hasOwnProperty.call(requestBody, 'tools'), false);
			assert.strictEqual(Object.prototype.hasOwnProperty.call(requestBody, 'tool_choice'), false);
			assert.ok((channel as any)._infoOfRunningRequest['ghost-loopback'], 'record must survive while the SSE stream is still open');

			release();
			await final;
			assert.strictEqual(finalText, 'bar');
			assert.strictEqual((channel as any)._infoOfRunningRequest['ghost-loopback'], undefined);
		}
		finally {
			release();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	test('abort before response headers closes the transport once without terminal emission', async () => {
		let requestReceivedResolve!: () => void;
		let transportClosedResolve!: () => void;
		const requestReceived = new Promise<void>(resolve => requestReceivedResolve = resolve);
		const transportClosed = new Promise<void>(resolve => transportClosedResolve = resolve);
		let transportCloseCount = 0;
		let response: ServerResponse | undefined;
		const server = createServer((request, serverResponse) => {
			response = serverResponse;
			serverResponse.once('close', () => {
				transportCloseCount += 1;
				transportClosedResolve();
			});
			request.resume();
			request.once('end', requestReceivedResolve);
			// Intentionally do not send response headers. Cancellation must reach the
			// SDK request rather than waiting for a streaming response controller.
		});
		await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });

		try {
			const address = server.address() as AddressInfo;
			const channel = new LLMMessageChannel(metrics);
			let texts = 0;
			let finals = 0;
			let errors = 0;
			channel.listen(undefined, 'onText_sendLLMMessage')(() => texts++);
			channel.listen(undefined, 'onFinalMessage_sendLLMMessage')(() => finals++);
			channel.listen(undefined, 'onError_sendLLMMessage')(() => errors++);
			(channel as any)._callSendLLMMessage(ghostParams('ghost-delayed', `http://127.0.0.1:${address.port}/v1`));
			await requestReceived;
			assert.ok((channel as any)._infoOfRunningRequest['ghost-delayed']);

			(channel as any)._callAbort({ requestId: 'ghost-delayed' });
			(channel as any)._callAbort({ requestId: 'ghost-delayed' });
			assert.strictEqual((channel as any)._infoOfRunningRequest['ghost-delayed'], undefined);
			await Promise.race([
				transportClosed,
				new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error('transport did not close after abort')), 1_000)),
			]);
			await new Promise(resolve => setTimeout(resolve, 20));
			assert.strictEqual(transportCloseCount, 1);
			assert.strictEqual(texts, 0);
			assert.strictEqual(finals, 0);
			assert.strictEqual(errors, 0);
		}
		finally {
			response?.destroy();
			server.closeAllConnections?.();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});
});
