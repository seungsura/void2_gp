/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import * as http from 'http';
import { AddressInfo } from 'net';
import OpenAI from 'openai';
import { availableTools } from '../../common/prompt/prompts.js';
import { classifyOpenAICompatibleToolSchemaDialect, formatPrematureStreamCloseMessage, isPrematureStreamClose, OpenAICompatibleStreamDiagnostics, redactOpenAICompatibleEndpoint } from '../../electron-main/llmMessage/openAICompatibleDiagnostics.js';

type Scenario = 'success' | 'close-before-first-event' | 'close-after-first-event';
type CapturedRequest = { body: Record<string, unknown> };

const flatTool = { type: 'function', function: { name: 'flat_tool', description: 'synthetic', parameters: { type: 'object', properties: { value: { type: 'string' } } } } } as const;
const syntheticComposedSchemaTool = {
	type: 'function', function: {
		name: 'synthetic_composed_tool', description: 'Synthetic composed-schema diagnostics regression fixture; it is not the current write_file schema.', parameters: {
			oneOf: [
				{ type: 'object', additionalProperties: false, required: ['uri', 'operation', 'read_receipt_id', 'edits'], properties: { uri: { type: 'string' }, operation: { type: 'string', const: 'modify', enum: ['modify'] }, read_receipt_id: { type: 'string' }, edits: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['old_text', 'new_text'], properties: { old_text: { type: 'string' }, new_text: { type: 'string' } } } } } },
				{ type: 'object', additionalProperties: false, required: ['uri', 'operation', 'content'], properties: { uri: { type: 'string' }, operation: { type: 'string', const: 'create', enum: ['create'] }, content: { type: 'string' } } },
			],
		},
	}
} as const;

const writeFileToolInfo = availableTools('agent', undefined)?.find(tool => tool.name === 'write_file');
if (!writeFileToolInfo?.schema) throw new Error('Expected the production write_file schema in agent tools.');
const productionWriteFileTool = { type: 'function', function: { name: writeFileToolInfo.name, description: writeFileToolInfo.description, parameters: writeFileToolInfo.schema } };

const withTimeout = async <T>(promise: Promise<T>, milliseconds = 2_000): Promise<T> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('local fixture timed out')), milliseconds); })]);
	} finally {
		if (timer) clearTimeout(timer);
	}
};

const startServer = async () => {
	const captured: CapturedRequest[] = [];
	const sockets = new Set<import('net').Socket>();
	const server = http.createServer((request, response) => {
		let text = '';
		request.on('data', chunk => text += chunk);
		request.on('end', () => {
			const body = JSON.parse(text) as Record<string, unknown>;
			captured.push({ body });
			const scenario = body.model as Scenario;
			response.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': `req-${scenario}` });
			response.flushHeaders();
			if (scenario === 'close-before-first-event') {
				setImmediate(() => response.socket?.destroy());
				return;
			}
			const event = `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] })}\n\n`;
			response.write(event);
			if (scenario === 'close-after-first-event') {
				setImmediate(() => response.socket?.destroy());
				return;
			}
			response.end('data: [DONE]\n\n');
		});
	});
	server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
	await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
	const port = (server.address() as AddressInfo).port;
	return {
		captured,
		client: new OpenAI({ apiKey: 'fixture-dummy-key', baseURL: `http://127.0.0.1:${port}/v1`, maxRetries: 0, timeout: 2_000 }),
		endpoint: `http://127.0.0.1:${port}/v1`,
		close: async () => {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>(resolve => server.close(() => resolve()));
		},
	};
};

const requestStream = async (client: OpenAI, model: Scenario, tools?: readonly unknown[]) => {
	const { data: stream, response, request_id } = await client.chat.completions.create({ model, messages: [{ role: 'user', content: 'fixture' }], stream: true, ...(tools ? { tools: tools as OpenAI.Chat.Completions.ChatCompletionTool[] } : {}) }).withResponse();
	let firstParsedStreamEvent = false;
	try {
		for await (const _ of stream) firstParsedStreamEvent = true;
		return { error: undefined, firstParsedStreamEvent, response, requestId: request_id ?? undefined };
	} catch (error) {
		return { error, firstParsedStreamEvent, response, requestId: request_id ?? undefined };
	}
};

suite('OpenAI-compatible local streaming regression fixture', () => {
	test('serializes the production flat write_file schema and synthetic composed diagnostics fixture over local SSE', async () => {
		const fixture = await startServer();
		try {
			await withTimeout(requestStream(fixture.client, 'success'));
			await withTimeout(requestStream(fixture.client, 'success', [flatTool]));
			await withTimeout(requestStream(fixture.client, 'success', [productionWriteFileTool]));
			await withTimeout(requestStream(fixture.client, 'success', [syntheticComposedSchemaTool]));
			assert.strictEqual(fixture.captured.length, 4);
			const [noTools, flat, productionWriteFile, composed] = fixture.captured.map(request => request.body);
			assert.strictEqual(noTools.stream, true); assert.strictEqual(noTools.tools, undefined);
			assert.strictEqual(flat.stream, true); assert.strictEqual((flat.tools as unknown[]).length, 1); assert.strictEqual(classifyOpenAICompatibleToolSchemaDialect(flat.tools as unknown[]), 'flat');
			assert.strictEqual(productionWriteFile.stream, true); assert.strictEqual((productionWriteFile.tools as unknown[]).length, 1); assert.strictEqual(classifyOpenAICompatibleToolSchemaDialect(productionWriteFile.tools as unknown[]), 'flat');
			const productionParameters = ((productionWriteFile.tools as { function: { parameters: { required: string[]; properties: { operation: { enum: string[] } } } } }[])[0]).function.parameters;
			assert.deepStrictEqual(productionParameters.required, ['uri', 'operation']);
			assert.deepStrictEqual(productionParameters.properties.operation.enum, ['create', 'modify']);
			assert.strictEqual(composed.stream, true); assert.strictEqual((composed.tools as unknown[]).length, 1); assert.strictEqual(classifyOpenAICompatibleToolSchemaDialect(composed.tools as unknown[]), 'oneOf-or-composition');
			const parameters = ((composed.tools as { function: { parameters: { oneOf: unknown[] } } }[])[0]).function.parameters;
			assert.strictEqual(parameters.oneOf.length, 2);
			assert.strictEqual(((parameters.oneOf[0] as { properties: { operation: { const: string } } }).properties.operation.const), 'modify');
		} finally {
			await fixture.close();
		}
	});
	test('reports local premature closes before and after the first parsed event', async () => {
		const fixture = await startServer();
		try {
			for (const expected of [{ model: 'close-before-first-event' as const, phase: 'after-response-headers-before-first-parsed-stream-event' }, { model: 'close-after-first-event' as const, phase: 'after-first-parsed-stream-event' }]) {
				const result = await withTimeout(requestStream(fixture.client, expected.model, [syntheticComposedSchemaTool]));
				assert.ok(result.error); assert.strictEqual(isPrematureStreamClose(result.error), true);
				const diagnostics: OpenAICompatibleStreamDiagnostics = { endpoint: redactOpenAICompatibleEndpoint(fixture.endpoint), model: 'fixture', chatMode: 'agent', toolCount: 1, toolSchemaDialect: 'oneOf-or-composition', dispatchAttempted: true, responseHeadersReceived: true, httpStatus: result.response.status, requestId: result.requestId, firstParsedStreamEvent: result.firstParsedStreamEvent };
				const message = formatPrematureStreamCloseMessage(diagnostics);
				assert.match(message, new RegExp(expected.phase)); assert.match(message, /status=200/); assert.match(message, new RegExp(`requestId=req-${expected.model}`));
			}
		} finally {
			await fixture.close();
		}
	});
});
