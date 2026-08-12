import * as assert from 'assert';
import { LLMMessageChannel } from '../../electron-main/sendLLMMessageChannel.js';
import { sendLLMMessage } from '../../electron-main/llmMessage/sendLLMMessage.js';
import { sendLLMMessageToProviderImplementation } from '../../electron-main/llmMessage/sendLLMMessage.impl.js';

const params = (requestId: string) => ({ requestId, messagesType: 'chatMessages', messages: [{ role: 'user', content: 'fixture' }], separateSystemMessage: undefined, chatMode: 'agent', logging: { loggingName: 'fixture' }, settingsOfProvider: {}, modelSelection: { providerName: 'openAI', modelName: 'fixture' }, modelSelectionOptions: undefined, overridesOfModel: undefined, mcpTools: undefined }) as any;
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
});
