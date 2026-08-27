import * as assert from 'assert';
import { createServer, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { LLMMessageChannel } from '../../electron-main/sendLLMMessageChannel.js';
import { sendLLMMessage } from '../../electron-main/llmMessage/sendLLMMessage.js';
import { sendLLMMessageToProviderImplementation } from '../../electron-main/llmMessage/sendLLMMessage.impl.js';
import { corporateOpenAICompatibleEndpoint, corporateOpenAICompatibleModelName, corporateOpenAICompatibleWireModelName } from '../../common/modelCapabilities.js';

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
const emptyToolParams = (requestId: string, endpoint: string) => ({
	requestId,
	messagesType: 'chatMessages',
	messages: [
		{ role: 'user', content: 'use fixture_tool' },
		{ role: 'assistant', content: '', tool_calls: [{ type: 'function', id: 'tool-1', function: { name: 'fixture_tool', arguments: '{"value":"alpha"}' } }] },
		{ role: 'tool', tool_call_id: 'tool-1', content: 'alpha' },
	],
	separateSystemMessage: undefined,
	chatMode: 'agent',
	logging: { loggingName: 'Empty assistant tool loopback' },
	settingsOfProvider: { openAICompatible: { endpoint, apiKey: 'fixture-key', headersJSON: '{}' } },
	modelSelection: { providerName: 'openAICompatible', modelName: 'gpt-4.1' },
	modelSelectionOptions: undefined,
	overridesOfModel: undefined,
	mcpTools: [],
	toolExecutionProfile: undefined,
	agentDelegationAllowed: false,
}) as any;
const corporateParams = (requestId: string) => ({
	requestId,
	messagesType: 'chatMessages',
	messages: [{ role: 'user', content: 'corporate loopback fixture' }],
	separateSystemMessage: undefined,
	chatMode: 'agent',
	logging: { loggingName: 'Corporate loopback' },
	settingsOfProvider: { openAICompatible: { endpoint: corporateOpenAICompatibleEndpoint, apiKey: '', headersJSON: '{}' } },
	modelSelection: { providerName: 'openAICompatible', modelName: corporateOpenAICompatibleModelName },
	modelSelectionOptions: undefined,
	overridesOfModel: undefined,
	mcpTools: [],
	toolExecutionProfile: undefined,
	agentDelegationAllowed: false,
}) as any;
const metrics = { capture() { } } as any;

const restoreEnvironment = (key: string, value: string | undefined) => {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
};

const replaceProcessResourcesPath = (resourcesPath: string | undefined) => {
	const target = process as NodeJS.Process & { resourcesPath?: string };
	const descriptor = Object.getOwnPropertyDescriptor(target, 'resourcesPath');
	if (descriptor && !descriptor.configurable) throw new Error('The test process resources path must be configurable.');
	Object.defineProperty(target, 'resourcesPath', { configurable: true, enumerable: descriptor?.enumerable ?? false, writable: true, value: resourcesPath });
	return () => {
		if (descriptor) Object.defineProperty(target, 'resourcesPath', descriptor);
		else Reflect.deleteProperty(target, 'resourcesPath');
	};
};

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

	test('ghost wrapper emits no external metrics or raw console error while preserving its error callback', async () => {
		const implementation = sendLLMMessageToProviderImplementation.openAICompatible; const original = implementation.sendChat;
		const captured: any[] = []; const consoleErrors: unknown[][] = []; let callbackMessage = '';
		const originalConsoleError = console.error;
		implementation.sendChat = async options => { options.onError({ message: 'raw private ghost failure', fullError: new Error('raw private ghost failure') }); };
		console.error = (...args: unknown[]) => { consoleErrors.push(args); };
		try {
			await sendLLMMessage({
				...ghostParams('private-error'),
				abortRef: { current: null },
				onText: () => { },
				onFinalMessage: () => assert.fail('unexpected final'),
				onError: ({ message }: { message: string }) => callbackMessage = message,
			} as any, { capture: (event: string, values: any) => captured.push({ event, values }) } as any);
			assert.strictEqual(callbackMessage, 'raw private ghost failure');
			assert.deepStrictEqual(captured, []);
			assert.deepStrictEqual(consoleErrors, []);
		}
		finally {
			console.error = originalConsoleError;
			implementation.sendChat = original;
		}
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

	test('OpenAI-Compatible loopback preserves native empty assistant tool-call content and reasoning-only response', async () => {
		let requestBody: any;
		let requestCount = 0;
		const server = createServer((request, response) => {
			const chunks: Buffer[] = [];
			request.on('data', chunk => chunks.push(Buffer.from(chunk)));
			request.on('end', () => {
				requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
				const assistant = requestBody.messages.find((message: any) => message.role === 'assistant' && message.tool_calls?.length === 1);
				response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'x-request-id': 'empty-tool-loopback' });
				const write = (delta: any, finish_reason: string | null = null) => response.write(`data: ${JSON.stringify({ id: 'chatcmpl-empty-tool', object: 'chat.completion.chunk', created: 0, model: 'gpt-4.1', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
				requestCount++;
				if (requestCount === 1) {
					write({ role: 'assistant', content: assistant.content, reasoning_content: 'loopback reasoning' });
					write({}, 'stop');
				}
				else if (requestCount === 2) {
					write({ tool_calls: [{ index: 1, id: 'tool-b', function: { name: 'tool_b', arguments: '{"b":' } }] });
					write({ tool_calls: [{ index: 0, id: 'tool-a', function: { name: 'tool_a', arguments: '{"a":' } }] });
					write({ tool_calls: [{ index: 1, id: 'tool-b', function: { arguments: '2}' } }] });
					write({ tool_calls: [{ index: 0, id: 'tool-a', function: { arguments: '1}' } }] }, 'tool_calls');
				}
				else {
					write({ tool_calls: [{ index: 0, id: 'first', function: { name: 'tool_a', arguments: '{}' } }] });
					write({ tool_calls: [{ index: 0, id: 'conflict', function: { arguments: '' } }] }, 'tool_calls');
				}
				response.end('data: [DONE]\n\n');
			});
		});
		await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
		try {
			const address = server.address() as AddressInfo;
			const channel = new LLMMessageChannel(metrics);
			let finalText: string | undefined;
			let finalReasoning: string | undefined;
			const final = new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error('empty tool loopback timed out')), 2_000);
				channel.listen(undefined, 'onFinalMessage_sendLLMMessage')(event => {
					if (event.requestId !== 'empty-tool-loopback') return;
					clearTimeout(timer);
					finalText = event.fullText;
					finalReasoning = event.fullReasoning;
					resolve();
				});
			});
			(channel as any)._callSendLLMMessage(emptyToolParams('empty-tool-loopback', `http://127.0.0.1:${address.port}/v1`));
			await final;
			const assistant = requestBody.messages.find((message: any) => message.role === 'assistant' && message.tool_calls?.length === 1);
			assert.deepStrictEqual(assistant, { role: 'assistant', content: '', tool_calls: [{ type: 'function', id: 'tool-1', function: { name: 'fixture_tool', arguments: '{"value":"alpha"}' } }] });
			assert.strictEqual(finalText, '');
			assert.strictEqual(finalReasoning, 'loopback reasoning');
			assert.strictEqual((channel as any)._infoOfRunningRequest['empty-tool-loopback'], undefined);
			const successChannel = new LLMMessageChannel(metrics);
			const successfulTools = await new Promise<any[]>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error('interleaved tool loopback timed out')), 2_000);
				successChannel.listen(undefined, 'onFinalMessage_sendLLMMessage')(event => {
					if (event.requestId !== 'interleaved-tools') return;
					clearTimeout(timer); resolve(event.toolCalls);
				});
				successChannel.listen(undefined, 'onError_sendLLMMessage')(event => event.requestId === 'interleaved-tools' && reject(new Error(event.message)));
				(successChannel as any)._callSendLLMMessage(emptyToolParams('interleaved-tools', `http://127.0.0.1:${address.port}/v1`));
			});
			assert.deepStrictEqual(successfulTools.map(tool => [tool.id, tool.name, tool.rawParams]), [['tool-a', 'tool_a', { a: 1 }], ['tool-b', 'tool_b', { b: 2 }]]);
			const conflictChannel = new LLMMessageChannel(metrics);
			let conflictFinals = 0;
			const conflictMessage = await new Promise<string>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error('conflicting tool loopback timed out')), 2_000);
				conflictChannel.listen(undefined, 'onFinalMessage_sendLLMMessage')(event => { if (event.requestId === 'conflicting-tools') conflictFinals++; });
				conflictChannel.listen(undefined, 'onError_sendLLMMessage')(event => {
					if (event.requestId !== 'conflicting-tools') return;
					clearTimeout(timer); resolve(event.message);
				});
				(conflictChannel as any)._callSendLLMMessage(emptyToolParams('conflicting-tools', `http://127.0.0.1:${address.port}/v1`));
			});
			assert.match(conflictMessage, /conflicting tool-call batch/);
			assert.strictEqual(conflictFinals, 0);
		}
		finally {
			server.closeAllConnections?.();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	test('corporate Luna profile resolves packaged credentials after test overrides and preserves the fixed wire contract', async () => {
		const expectedAuthorizations: string[] = [];
		const requests: Array<{ path: string; body: any; authorized: boolean }> = [];
		const server = createServer((request, response) => {
			const chunks: Buffer[] = [];
			request.on('data', chunk => chunks.push(Buffer.from(chunk)));
			request.on('end', () => {
				const expectedAuthorization = expectedAuthorizations.shift();
				requests.push({
					path: request.url ?? '',
					body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
					authorized: request.headers.authorization === expectedAuthorization,
				});
				response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
				response.write(`data: ${JSON.stringify({ id: 'chatcmpl-corporate', object: 'chat.completion.chunk', created: 0, model: corporateOpenAICompatibleWireModelName, choices: [{ index: 0, delta: { role: 'assistant', content: 'ready' }, finish_reason: null }] })}\n\n`);
				response.write(`data: ${JSON.stringify({ id: 'chatcmpl-corporate', object: 'chat.completion.chunk', created: 0, model: corporateOpenAICompatibleWireModelName, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
				response.end('data: [DONE]\n\n');
			});
		});
		await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
		const originalEndpoint = process.env.VOID_CORPORATE_TEST_ENDPOINT;
		const originalKey = process.env.VOID_CORPORATE_API_KEY;
		const originalPath = process.env.VOID_CORPORATE_API_KEY_PATH;
		const credentialDirectory = await mkdtemp(join(tmpdir(), 'void-corporate-credential-fixture-'));
		const explicitCredentialPath = join(credentialDirectory, 'explicit-credential.txt');
		const resourcesPath = join(credentialDirectory, 'resources');
		await mkdir(join(resourcesPath, 'app', '.corporate'), { recursive: true });
		await writeFile(join(resourcesPath, 'app', '.corporate', 'API_KEY'), 'packaged-fixture-key\n', 'utf8');
		await writeFile(explicitCredentialPath, 'explicit-fixture-key\n', 'utf8');
		const restoreResourcesPath = replaceProcessResourcesPath(resourcesPath);
		try {
			const address = server.address() as AddressInfo;
			process.env.VOID_CORPORATE_TEST_ENDPOINT = `http://127.0.0.1:${address.port}`;
			delete process.env.VOID_CORPORATE_API_KEY;
			delete process.env.VOID_CORPORATE_API_KEY_PATH;

			const send = async (requestId: string, expectedCredential: string) => {
				expectedAuthorizations.push(`Bearer ${expectedCredential}`);
				const channel = new LLMMessageChannel(metrics);
				const completed = new Promise<void>(resolve => channel.listen(undefined, 'onFinalMessage_sendLLMMessage')(event => event.requestId === requestId && resolve()));
				(channel as any)._callSendLLMMessage(corporateParams(requestId));
				await completed;
			};

			await send('corporate-packaged', 'packaged-fixture-key');
			process.env.VOID_CORPORATE_API_KEY_PATH = explicitCredentialPath;
			await send('corporate-explicit', 'explicit-fixture-key');
			process.env.VOID_CORPORATE_API_KEY = 'environment-fixture-key';
			await send('corporate-environment', 'environment-fixture-key');

			assert.strictEqual(expectedAuthorizations.length, 0);
			assert.strictEqual(requests.length, 3);
			assert.ok(requests.every(request => request.authorized));
			assert.ok(requests.every(request => request.path === '/chat/completions'));
			assert.ok(requests.every(request => request.body.model === corporateOpenAICompatibleWireModelName));
			assert.ok(requests.every(request => request.body.stream === true));
		}
		finally {
			restoreEnvironment('VOID_CORPORATE_TEST_ENDPOINT', originalEndpoint);
			restoreEnvironment('VOID_CORPORATE_API_KEY', originalKey);
			restoreEnvironment('VOID_CORPORATE_API_KEY_PATH', originalPath);
			restoreResourcesPath();
			await rm(credentialDirectory, { recursive: true, force: true });
			server.closeAllConnections?.();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	test('corporate profile fails before network dispatch when no external credential is available', async () => {
		let requests = 0;
		const server = createServer((request, response) => { requests++; request.resume(); response.end(); });
		await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
		const originalEndpoint = process.env.VOID_CORPORATE_TEST_ENDPOINT;
		const originalKey = process.env.VOID_CORPORATE_API_KEY;
		const originalPath = process.env.VOID_CORPORATE_API_KEY_PATH;
		const resourcesPath = await mkdtemp(join(tmpdir(), 'void-corporate-empty-resources-'));
		const restoreResourcesPath = replaceProcessResourcesPath(resourcesPath);
		try {
			const address = server.address() as AddressInfo;
			process.env.VOID_CORPORATE_TEST_ENDPOINT = `http://127.0.0.1:${address.port}`;
			delete process.env.VOID_CORPORATE_API_KEY;
			delete process.env.VOID_CORPORATE_API_KEY_PATH;
			let error = '';
			await sendLLMMessage({ ...corporateParams('corporate-missing-key'), abortRef: { current: null }, onText: () => { }, onFinalMessage: () => assert.fail('unexpected final'), onError: ({ message }: { message: string }) => error = message } as any, metrics);
			assert.strictEqual(error, 'Error: Corporate provider credential is unavailable.');
			assert.strictEqual(requests, 0);
		}
		finally {
			restoreEnvironment('VOID_CORPORATE_TEST_ENDPOINT', originalEndpoint);
			restoreEnvironment('VOID_CORPORATE_API_KEY', originalKey);
			restoreEnvironment('VOID_CORPORATE_API_KEY_PATH', originalPath);
			restoreResourcesPath();
			await rm(resourcesPath, { recursive: true, force: true });
			server.closeAllConnections?.();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	test('corporate production smoke permits one fake loopback request without changing ordinary calls', async () => {
		let requests = 0;
		let failNextSmokeRequest = false;
		const server = createServer((request, response) => {
			requests++;
			request.resume();
			if (failNextSmokeRequest) {
				failNextSmokeRequest = false;
				response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
				response.end('{"error":{"message":"fixture failure"}}');
				return;
			}
			response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
			response.write(`data: ${JSON.stringify({ id: 'chatcmpl-corporate-smoke', object: 'chat.completion.chunk', created: 0, model: corporateOpenAICompatibleWireModelName, choices: [{ index: 0, delta: { role: 'assistant', content: 'ready' }, finish_reason: null }] })}\n\n`);
			response.write(`data: ${JSON.stringify({ id: 'chatcmpl-corporate-smoke', object: 'chat.completion.chunk', created: 0, model: corporateOpenAICompatibleWireModelName, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
			response.end('data: [DONE]\n\n');
		});
		await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
		const originalEndpoint = process.env.VOID_CORPORATE_TEST_ENDPOINT;
		const originalKey = process.env.VOID_CORPORATE_API_KEY;
		const originalPath = process.env.VOID_CORPORATE_API_KEY_PATH;
		const originalSmoke = process.env.VOID_CORPORATE_PRODUCTION_SMOKE;
		const runtime = globalThis as typeof globalThis & { __voidCorporateProductionSmokeCounters?: { requests: number; completed: number; nativeAgentToolSchema: boolean } };
		const originalCounters = runtime.__voidCorporateProductionSmokeCounters;
		const send = async (requestId: string) => {
			let finals = 0;
			let error = '';
			await sendLLMMessage({ ...corporateParams(requestId), abortRef: { current: null }, onText: () => { }, onFinalMessage: () => finals++, onError: ({ message }: { message: string }) => error = message } as any, metrics);
			return { finals, error };
		};
		try {
			const address = server.address() as AddressInfo;
			process.env.VOID_CORPORATE_TEST_ENDPOINT = `http://127.0.0.1:${address.port}`;
			process.env.VOID_CORPORATE_API_KEY = 'corporate-production-smoke-fake-key';
			delete process.env.VOID_CORPORATE_API_KEY_PATH;
			delete process.env.VOID_CORPORATE_PRODUCTION_SMOKE;
			Reflect.deleteProperty(runtime, '__voidCorporateProductionSmokeCounters');

			assert.deepStrictEqual(await send('ordinary-corporate-first'), { finals: 1, error: '' });
			assert.deepStrictEqual(await send('ordinary-corporate-second'), { finals: 1, error: '' });
			assert.strictEqual(requests, 2);
			assert.strictEqual(runtime.__voidCorporateProductionSmokeCounters, undefined);

			process.env.VOID_CORPORATE_PRODUCTION_SMOKE = '1';
			failNextSmokeRequest = true;
			const failed = await send('corporate-production-smoke-no-retry');
			assert.strictEqual(failed.finals, 0);
			assert.notStrictEqual(failed.error, '');
			assert.strictEqual(requests, 3);
			assert.deepStrictEqual(runtime.__voidCorporateProductionSmokeCounters, { requests: 1, completed: 0, nativeAgentToolSchema: true });

			Reflect.deleteProperty(runtime, '__voidCorporateProductionSmokeCounters');
			assert.deepStrictEqual(await send('corporate-production-smoke-first'), { finals: 1, error: '' });
			assert.deepStrictEqual(runtime.__voidCorporateProductionSmokeCounters, { requests: 1, completed: 1, nativeAgentToolSchema: true });
			const rejected = await send('corporate-production-smoke-second');
			assert.strictEqual(rejected.finals, 0);
			assert.notStrictEqual(rejected.error, '');
			assert.strictEqual(requests, 4);
			assert.deepStrictEqual(runtime.__voidCorporateProductionSmokeCounters, { requests: 1, completed: 1, nativeAgentToolSchema: true });
		}
		finally {
			restoreEnvironment('VOID_CORPORATE_TEST_ENDPOINT', originalEndpoint);
			restoreEnvironment('VOID_CORPORATE_API_KEY', originalKey);
			restoreEnvironment('VOID_CORPORATE_API_KEY_PATH', originalPath);
			restoreEnvironment('VOID_CORPORATE_PRODUCTION_SMOKE', originalSmoke);
			if (originalCounters === undefined) Reflect.deleteProperty(runtime, '__voidCorporateProductionSmokeCounters');
			else runtime.__voidCorporateProductionSmokeCounters = originalCounters;
			server.closeAllConnections?.();
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
