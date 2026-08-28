import * as assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ChatThreadService } from '../../browser/chatThreadService.js';
import { ConvertToLLMMessageService } from '../../browser/convertToLLMMessageService.js';
import { AgentRuntimeTurnSnapshot, createAgentRuntimeTurnSnapshot, createSkillCatalog, skillAdvertisement } from '../../common/agentSkills.js';
import { projectAgentConfig, resolveAgentInstructions, stableAgentInstructionRevision } from '../../common/agentInstructions.js';
import { captureParentModelToolSnapshot } from '../../common/prompt/prompts.js';

const encoder = new TextEncoder();
const skillBody = (name: string) => `---\nname: ${name}\ndescription: ${name} description\n---\nbody-${name}`;
const instructions = () => {
	const config = projectAgentConfig({ developerInstructions: 'developer' }, undefined, [{ uri: 'file:///home/.codex/config.toml', scope: 'user', status: 'loaded', projectedKeys: ['developer_instructions'] }], 'file:///workspace', 'file:///workspace');
	return resolveAgentInstructions(config, [], stableAgentInstructionRevision(config, []));
};
const snapshotFor = (providerName: any, modelName: string, contextWindow = 10_000): AgentRuntimeTurnSnapshot => {
	const catalog = createSkillCatalog(['demo', 'other'].map((name, rank) => ({ source: 'user' as const, rank, root: 'file:///skills', skillRoot: `file:///skills/${name}`, directoryName: name, bytes: encoder.encode(skillBody(name)) })));
	return createAgentRuntimeTurnSnapshot(instructions(), catalog, skillAdvertisement(catalog, contextWindow), catalog.skills.map(skill => ({ identity: skill.identity, skillRoot: skill.provenance.skillRoot, bodyRevision: skill.bodyRevision, body: skillBody(skill.name) })), { hasModel: true, providerName, modelName, contextWindow, reservedOutputTokens: 0, modelSelectionOptions: {}, selectedModelOverrides: {} }, true);
};
const snapshot = (contextWindow = 10_000): AgentRuntimeTurnSnapshot => snapshotFor('openAI', 'gpt-4.1', contextWindow);

const fixture = (runtimeSnapshot = snapshot()) => {
	const messages: any[] = []; const serviceCalls: any[] = []; const conversionCalls: any[] = []; let trusted = true; let owner = 'file:///workspace'; let purges = 0;
	const thread = { messages, state: {} };
	const value: any = {
		state: { allThreads: { parent: thread }, currentThreadId: 'parent' }, streamState: {},
		_instructionTurnOfThread: new Map([['parent', runtimeSnapshot]]), _agentInstructionSessionOfThread: new Map(), _agentControlGeneration: new Map([['parent', 0]]), _parentRunTokenOfThread: new Map(), _agentDelegationAuthorityOfThread: new Map(), _cancellingToolReceiptsOfThread: new Map(),
		_workspaceContextService: { getWorkspace: () => ({ folders: owner ? [{ uri: URI.parse(owner) }] : [] }) }, _workspaceTrustManagementService: { isWorkspaceTrusted: () => trusted },
		_agentSkillsService: { readSkillResource: async (selection: unknown, resourcePath: string, options: unknown) => { serviceCalls.push({ selection, resourcePath, options }); return { body: 'RESOURCE\n' }; } },
		_convertToLLMMessagesService: { prepareLLMChatMessages: async (options: unknown) => { conversionCalls.push(options); return { messages: [], separateSystemMessage: undefined }; } },
		_toolsService: { invalidateReadReceipts(_threadId: string) { }, validateParams: new Proxy({}, { get() { throw new Error('builtin lookup'); } }) }, _mcpService: { getMCPTools() { throw new Error('MCP lookup'); } },
		_agentSubagentService: { cancelParent() { }, forgetParent() { }, async acquireGroupIo() { return { release() { } }; } },
		_cancelChildToolApprovalsForParent() { },
		_addMessageToThread(_threadId: string, message: any) { messages.push(message); },
		_updateLatestTool(_threadId: string, message: any) { if (messages[messages.length - 1]?.role === 'tool') messages[messages.length - 1] = message; else messages.push(message); },
		_editMessageInThread(_threadId: string, index: number, message: any) { messages[index] = message; },
		_setStreamState(threadId: string, state: any) { value.streamState[threadId] = state; },
		_purgeInstructionTurn(threadId: string) { purges++; value._instructionTurnOfThread.delete(threadId); },
		toolErrMsgs: { rejected: 'Tool call was rejected by the user.', interrupted: 'Tool call was interrupted by the user.' },
	};
	Object.setPrototypeOf(value, ChatThreadService.prototype);
	value._revokeAgentDelegation = (threadId: string, forget = false) => (ChatThreadService.prototype as any)._revokeAgentDelegation.call(value, threadId, forget);
	return { value, messages, serviceCalls, conversionCalls, runtimeSnapshot, setTrusted: (next: boolean) => trusted = next, setOwner: (next: string) => owner = next, purges: () => purges };
};
const run = (value: any, runtimeSnapshot: AgentRuntimeTurnSnapshot, raw: Record<string, unknown>, allowed = true, toolId = 'provider-tool-id', batchRef?: { batchId: string; batchOrdinal: number }) =>
	(ChatThreadService.prototype as any)._runToolCall.call(value, 'parent', 'read_skill_resource', toolId, 'spoofed-mcp', { preapproved: false, unvalidatedToolParams: raw }, runtimeSnapshot, undefined, allowed, value._agentControlGeneration.get('parent') ?? 0, () => true, batchRef);

suite('Void selected Skill resource Chat runtime', () => {
	test('routes before builtin/MCP/approval and returns exact text from the captured selected descriptor', async () => {
		const f = fixture(); const result = await run(f.value, f.runtimeSnapshot, { skill: 'demo', resource_path: 'references/guide.md' });
		assert.deepStrictEqual(result, {}); assert.strictEqual(f.serviceCalls.length, 1); assert.strictEqual(f.serviceCalls[0].selection, f.runtimeSnapshot.selected[0]); assert.strictEqual(f.serviceCalls[0].resourcePath, 'references/guide.md');
		assert.ok(f.serviceCalls[0].options.maxResourceBytes > 0); assert.strictEqual(f.serviceCalls[0].options.token.isCancellationRequested, false); assert.strictEqual(f.conversionCalls.length, 1);
		assert.strictEqual(f.messages.length, 1); assert.strictEqual(f.messages[0].type, 'success'); assert.strictEqual(f.messages[0].content, 'RESOURCE\n'); assert.strictEqual(f.messages[0].result, 'RESOURCE\n'); assert.strictEqual(f.messages[0].id, 'provider-tool-id'); assert.strictEqual(f.messages[0].mcpServerName, undefined);

		const batch = fixture(); const batchId = 'parent-resource-first'; const calls = [
			{ id: 'resource-0', name: 'read_skill_resource', rawParams: { skill: 'demo', resource_path: 'first.md' } },
			{ id: 'resource-1', name: 'read_skill_resource', rawParams: { skill: 'demo', resource_path: 'second.md' } },
		];
		batch.messages.push({ role: 'assistant', displayContent: '', reasoning: '', anthropicReasoning: null, toolBatch: { version: 1, batchId, calls } }, { role: 'tool', type: 'tool_request', name: 'read_skill_resource', params: { skill: 'demo', resourcePath: 'first.md' }, content: '(Awaiting user permission...)', result: null, id: calls[0].id, rawParams: calls[0].rawParams, mcpServerName: undefined, batchId, batchOrdinal: 0 });
		assert.deepStrictEqual(await run(batch.value, batch.runtimeSnapshot, calls[0].rawParams, true, calls[0].id, { batchId, batchOrdinal: 0 }), {});
		const firstProspective = batch.conversionCalls[0].chatMessages.filter((message: any) => message.role === 'tool');
		assert.deepStrictEqual(firstProspective.map((message: any) => [message.id, message.type, Object.prototype.hasOwnProperty.call(message, 'params')]), [['resource-0', 'success', true], ['resource-1', 'skipped', false]]);
		assert.deepStrictEqual(batch.messages.filter((message: any) => message.role === 'tool').map((message: any) => [message.id, message.type]), [['resource-0', 'success']], 'prospective skipped tail must not persist');
		batch.messages.push({ role: 'tool', type: 'tool_request', name: 'read_skill_resource', params: { skill: 'demo', resourcePath: 'second.md' }, content: '(Awaiting user permission...)', result: null, id: calls[1].id, rawParams: calls[1].rawParams, mcpServerName: undefined, batchId, batchOrdinal: 1 });
		assert.deepStrictEqual(await run(batch.value, batch.runtimeSnapshot, calls[1].rawParams, true, calls[1].id, { batchId, batchOrdinal: 1 }), {});
		assert.deepStrictEqual(batch.messages.filter((message: any) => message.role === 'tool').map((message: any) => [message.id, message.type, message.batchOrdinal]), [['resource-0', 'success', 0], ['resource-1', 'success', 1]]);
		assert.deepStrictEqual(batch.serviceCalls.map(call => call.resourcePath), ['first.md', 'second.md']);
	});

	test('rejects unavailable, malformed, outside, and unknown identities before service side effects', async () => {
		for (const [raw, allowed, expected, expectedResult] of [
			[{ skill: 'demo', resource_path: 'a' }, false, 'read_skill_resource_not_available', {}],
			[{ skill: 'demo', resource_path: 'a', extra: true }, true, 'read_skill_resource_invalid_params', {}],
			[{ skill: 'demo', resource_path: '../a' }, true, 'skill_resource_outside_root', {}],
			[{ skill: 'missing', resource_path: 'a' }, true, 'skill_not_selected', { failure: 'skill_not_selected', validatedParams: { skill: 'missing', resourcePath: 'a' } }],
		] as const) {
			const f = fixture(); const result = await run(f.value, f.runtimeSnapshot, raw, allowed); assert.deepStrictEqual(result, expectedResult); assert.strictEqual(f.serviceCalls.length, 0); assert.strictEqual(f.messages.length, 1); assert.ok(f.messages[0].content.includes(expected)); assert.strictEqual(f.messages[0].mcpServerName, undefined);
		}
	});

	test('turns every read diagnostic and oversize body into one failure while retaining the same turn', async () => {
		const expectedParams = { skill: 'demo', resourcePath: 'references/a' };
		for (const code of ['skill_resource_not_found', 'skill_stale', 'skill_resource_unreadable', 'skill_invalid_utf8']) {
			const f = fixture(); f.value._agentSkillsService.readSkillResource = async () => { f.serviceCalls.push(code); return { diagnostic: { code } }; };
			const result = await run(f.value, f.runtimeSnapshot, { skill: 'demo', resource_path: 'references/a' }); assert.deepStrictEqual(result, { failure: `error: ${code}`, validatedParams: expectedParams }); assert.strictEqual(f.messages.length, 1); assert.strictEqual(f.messages[0].type, 'tool_error'); assert.ok(f.messages[0].content.includes(code)); assert.strictEqual(f.value._instructionTurnOfThread.get('parent'), f.runtimeSnapshot); assert.deepStrictEqual(f.runtimeSnapshot.selected.map(item => item.identity), ['demo', 'other']);
		}
		const small = fixture(snapshot(1024)); small.value._agentSkillsService.readSkillResource = async () => ({ body: 'never-partially-returned' }); const smallResult = await run(small.value, small.runtimeSnapshot, { skill: 'demo', resource_path: 'references/a' }); assert.deepStrictEqual(smallResult, { failure: 'skill_resource_context_admission_failed', validatedParams: expectedParams }); assert.strictEqual(small.messages.length, 1); assert.strictEqual(small.messages[0].type, 'tool_error'); assert.ok(small.messages[0].content.includes('skill_resource_context_admission_failed')); assert.strictEqual(small.messages[0].content.includes('never-partially-returned'), false); assert.strictEqual(small.value._instructionTurnOfThread.get('parent'), small.runtimeSnapshot);
		const conversion = fixture(); conversion.value._convertToLLMMessagesService.prepareLLMChatMessages = async () => { throw new Error('prospective history cannot fit'); }; const conversionResult = await run(conversion.value, conversion.runtimeSnapshot, { skill: 'demo', resource_path: 'references/a' }); assert.deepStrictEqual(conversionResult, { failure: 'skill_resource_context_admission_failed', validatedParams: expectedParams }); assert.strictEqual(conversion.messages.length, 1); assert.strictEqual(conversion.messages[0].type, 'tool_error'); assert.strictEqual(conversion.messages[0].content, 'skill_resource_context_admission_failed');
	});

	test('captures the model/history budget before the asynchronous read and never recomputes it', async () => {
		const f = fixture(snapshot(1100)); let release!: (value: { body: string }) => void; f.value._agentSkillsService.readSkillResource = () => new Promise(resolve => release = resolve);
		const pending = run(f.value, f.runtimeSnapshot, { skill: 'demo', resource_path: 'references/a' }); await Promise.resolve();
		const receiptId = f.messages[0]?.receiptId; const receipt = f.value._activeToolCardReceiptsOfThread?.get('parent')?.get(receiptId); assert.strictEqual(f.messages[0]?.type, 'running_now'); assert.strictEqual(typeof receiptId, 'string'); assert.deepStrictEqual({ toolId: receipt?.toolId, messageIndex: receipt?.messageIndex, interruptInstalled: receipt?.interruptInstalled, cancelling: receipt?.cancelling }, { toolId: 'provider-tool-id', messageIndex: 0, interruptInstalled: true, cancelling: false });
		f.value.state.allThreads.parent.messages.push({ role: 'user', content: 'x'.repeat(20_000) }); release({ body: 'fits-in-captured-budget' });
		assert.deepStrictEqual(await pending, {}); assert.strictEqual(f.messages[f.messages.length - 1].type, 'success'); assert.strictEqual(f.value._activeToolCardReceiptsOfThread?.get('parent'), undefined);

		// The resource byte read holds the shared reader lane, but a writer becomes
		// eligible before the deliberately deferred prospective conversion completes.
		const coordinated = fixture(); let releaseResource!: (value: { body: string }) => void; let resourceStarted!: () => void; const resourceStartedPromise = new Promise<void>(resolve => resourceStarted = resolve); const resource = new Promise<{ body: string }>(resolve => releaseResource = resolve);
		let releaseConversion!: () => void; let conversionStarted!: () => void; const conversionStartedPromise = new Promise<void>(resolve => conversionStarted = resolve); const conversion = new Promise<void>(resolve => releaseConversion = resolve);
		let activeReaders = 0; let grantWriter: ((lease: { release(): void }) => void) | undefined;
		coordinated.value._agentSubagentService = {
			cancelParent() { }, forgetParent() { },
			async acquireGroupIo(_parentId: string, _generation: number, kind: 'read' | 'write') {
				if (kind === 'read') { activeReaders += 1; return { release() { activeReaders -= 1; if (activeReaders === 0) grantWriter?.({ release() { } }); } }; }
				if (activeReaders === 0) return { release() { } };
				return new Promise<{ release(): void }>(resolve => grantWriter = resolve);
			},
		};
		coordinated.value._agentSkillsService.readSkillResource = () => { resourceStarted(); return resource; };
		coordinated.value._convertToLLMMessagesService.prepareLLMChatMessages = async () => { conversionStarted(); await conversion; return { messages: [], separateSystemMessage: undefined }; };
		const coordinatedRun = run(coordinated.value, coordinated.runtimeSnapshot, { skill: 'demo', resource_path: 'references/coordinated.md' }); await resourceStartedPromise;
		let writerGranted = false; const writer = coordinated.value._agentSubagentService.acquireGroupIo('parent', 0, 'write').then((lease: { release(): void }) => { writerGranted = true; return lease; }); await Promise.resolve(); assert.strictEqual(writerGranted, false);
		releaseResource({ body: 'RESOURCE' }); await conversionStartedPromise; await Promise.resolve(); assert.strictEqual(writerGranted, true, 'writer acquires immediately after resource I/O, not after conversion'); (await writer).release(); releaseConversion(); assert.deepStrictEqual(await coordinatedRun, {});

		const stale = fixture(); let grantRead!: (lease: { release(): void }) => void; let staleReads = 0;
		stale.value._agentSubagentService = { cancelParent() { }, forgetParent() { }, acquireGroupIo: () => new Promise<{ release(): void }>(resolve => grantRead = resolve) };
		stale.value._agentSkillsService.readSkillResource = async () => { staleReads += 1; return { body: 'must not read' }; };
		const staleRun = run(stale.value, stale.runtimeSnapshot, { skill: 'demo', resource_path: 'references/stale.md' }); await Promise.resolve(); stale.value._agentControlGeneration.set('parent', 1); grantRead({ release() { } });
		assert.deepStrictEqual(await staleRun, { interrupted: true }); assert.strictEqual(staleReads, 0); assert.strictEqual(stale.conversionCalls.length, 0); assert.strictEqual(stale.messages.some(message => message.type === 'success'), false);
	});

	test('Stop settles the running tool once and drops the late resource completion', async () => {
		const prompt = fixture(); let releasePrompt!: (value: { body: string }) => void; prompt.value._agentSkillsService.readSkillResource = () => new Promise(resolve => releasePrompt = resolve);
		const promptlySettled = run(prompt.value, prompt.runtimeSnapshot, { skill: 'demo', resource_path: 'references/a' }); await Promise.resolve();
		const promptReceiptId = prompt.messages[0]?.receiptId; assert.strictEqual(prompt.messages[0]?.type, 'running_now'); assert.strictEqual(typeof promptReceiptId, 'string'); assert.strictEqual(prompt.value._activeToolCardReceiptsOfThread?.get('parent')?.get(promptReceiptId)?.interruptInstalled, true);
		await ChatThreadService.prototype.abortRunning.call(prompt.value, 'parent'); assert.deepStrictEqual(await promptlySettled, { interrupted: true }); releasePrompt({ body: 'IGNORED-AFTER-SETTLEMENT' }); await Promise.resolve();
		assert.strictEqual(prompt.messages.length, 1); assert.strictEqual(prompt.messages[0].type, 'rejected'); assert.strictEqual(prompt.messages[0].content, 'Tool call was interrupted by the user.'); assert.strictEqual(prompt.value._activeToolCardReceiptsOfThread?.get('parent'), undefined); assert.strictEqual(prompt.value._cancellingToolReceiptsOfThread.get('parent'), undefined);
		const f = fixture(); let release!: (value: { body: string }) => void; f.value._agentSkillsService.readSkillResource = () => new Promise(resolve => release = resolve);
		const pending = run(f.value, f.runtimeSnapshot, { skill: 'demo', resource_path: 'references/a' }); await Promise.resolve();
		const stopping = ChatThreadService.prototype.abortRunning.call(f.value, 'parent'); release({ body: 'LATE-SUCCESS' });
		await stopping; assert.deepStrictEqual(await pending, { interrupted: true }); assert.strictEqual(f.messages.some(message => message.type === 'success' || message.content === 'LATE-SUCCESS'), false); assert.strictEqual(f.messages.length, 1); assert.strictEqual(f.messages[0].type, 'rejected'); assert.strictEqual(f.value._activeToolCardReceiptsOfThread?.get('parent'), undefined); assert.strictEqual(f.value._cancellingToolReceiptsOfThread.get('parent'), undefined);
	});

	test('fails closed before and after the read when owner or trust drifts', async () => {
		const before = fixture(); before.setOwner('file:///other'); assert.deepStrictEqual(await run(before.value, before.runtimeSnapshot, { skill: 'demo', resource_path: 'references/a' }), { interrupted: true }); assert.strictEqual(before.serviceCalls.length, 0); assert.strictEqual(before.purges(), 1); assert.strictEqual(before.messages.length, 1); assert.ok(before.messages[0].content.includes('skill_owner_or_trust_changed'));
		const after = fixture(); let release!: (value: { body: string }) => void; after.value._agentSkillsService.readSkillResource = () => new Promise(resolve => release = resolve); const pending = run(after.value, after.runtimeSnapshot, { skill: 'demo', resource_path: 'references/a' }); await Promise.resolve(); after.setTrusted(false); release({ body: 'LATE-SUCCESS' }); assert.deepStrictEqual(await pending, { interrupted: true }); assert.strictEqual(after.purges(), 1); assert.strictEqual(after.messages.length, 1); assert.strictEqual(after.messages[0].type, 'tool_error'); assert.strictEqual(after.messages[0].content, 'skill_owner_or_trust_changed');
	});

	test('fails closed when owner or trust drifts during prospective resource conversion', async () => {
		for (const drift of ['owner', 'trust'] as const) {
			const f = fixture(); let entered!: () => void; let release!: () => void; const converting = new Promise<void>(resolve => entered = resolve); const gate = new Promise<void>(resolve => release = resolve);
			f.value._convertToLLMMessagesService.prepareLLMChatMessages = async () => { entered(); await gate; return { messages: [], separateSystemMessage: undefined }; };
			const pending = run(f.value, f.runtimeSnapshot, { skill: 'demo', resource_path: 'references/a' }); await converting;
			if (drift === 'owner') f.setOwner('file:///other'); else f.setTrusted(false);
			release(); assert.deepStrictEqual(await pending, { interrupted: true }); assert.strictEqual(f.purges(), 1); assert.strictEqual(f.messages.length, 1); assert.strictEqual(f.messages[0].type, 'tool_error'); assert.strictEqual(f.messages[0].content, 'skill_owner_or_trust_changed');
		}
	});

	test('drops read resolution and rejection after a same-turn generation replacement', async () => {
		for (const outcome of ['resolve', 'reject'] as const) {
			const f = fixture(); let release!: (value: { body: string }) => void; let reject!: (error: Error) => void;
			f.value._agentSkillsService.readSkillResource = () => new Promise((res, rej) => { release = res; reject = rej; });
			const pending = run(f.value, f.runtimeSnapshot, { skill: 'demo', resource_path: 'references/a' }); await Promise.resolve();
			f.value._agentControlGeneration.set('parent', 1); f.messages.push({ role: 'user', content: 'NEW-TURN-MUST-REMAIN' });
			if (outcome === 'resolve') release({ body: 'OLD-SUCCESS' }); else reject(new Error('OLD-FAILURE'));
			assert.deepStrictEqual(await pending, { interrupted: true }); assert.strictEqual(f.messages[f.messages.length - 1].content, 'NEW-TURN-MUST-REMAIN'); assert.strictEqual(f.messages.some(message => message.content === 'OLD-SUCCESS' || message.content === 'OLD-FAILURE'), false);
		}
	});

	test('keeps every successful selected resource exact through production native and XML conversions or fails atomically', async () => {
		const converter = new ConvertToLLMMessageService({ getModels: () => [] } as never, { getWorkspace: () => ({ folders: [] }) } as never, { activeEditor: undefined } as never, { getAllDirectoriesStr: async () => '' } as never, { listPersistentTerminalIds: () => [] } as never, { state: { overridesOfModel: {}, globalSettings: {}, optionsOfModelSelection: {} } } as never, { getMCPTools: () => [] } as never);
		(converter as any)._generateChatMessagesSystemMessage = async () => 'generated-system';
		const resourceA = `RESOURCE-A-${'a'.repeat(1200)}\n`;
		const resourceB = `RESOURCE-B-${'b'.repeat(1200)}\n`;
		const routes = [
			{ providerName: 'openAI', modelName: 'gpt-4.1', kind: 'native' },
			{ providerName: 'anthropic', modelName: 'claude-3-7-sonnet-20250219', kind: 'native' },
			{ providerName: 'gemini', modelName: 'gemini-2.0-flash-lite', kind: 'native' },
			{ providerName: 'openAI', modelName: 'unrecognized-xml-model', kind: 'xml' },
		] as const;
		const stringsOf = (value: unknown): string[] => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(stringsOf) : value && typeof value === 'object' ? Object.values(value).flatMap(stringsOf) : [];
		for (const route of routes) {
			const runtimeSnapshot = snapshotFor(route.providerName, route.modelName, 10_000);
			const chatMessages: any[] = [
				{ role: 'user', content: 'history'.repeat(9_000) },
				{ role: 'assistant', displayContent: 'call a', reasoning: '', anthropicReasoning: null },
				{ role: 'tool', type: 'success', name: 'read_skill_resource', id: 'a', rawParams: { skill: 'demo', resource_path: 'a' }, params: { skill: 'demo', resource_path: 'a' }, result: resourceA, content: resourceA, mcpServerName: undefined },
				{ role: 'assistant', displayContent: 'call b', reasoning: '', anthropicReasoning: null },
				{ role: 'tool', type: 'success', name: 'read_skill_resource', id: 'b', rawParams: { skill: 'demo', resource_path: 'b' }, params: { skill: 'demo', resource_path: 'b' }, result: resourceB, content: resourceB, mcpServerName: undefined },
			];
			const converted = await converter.prepareLLMChatMessages({ chatMessages, chatMode: 'agent', modelSelection: { providerName: route.providerName, modelName: route.modelName } as never, instructionSnapshot: runtimeSnapshot });
			const strings = stringsOf(converted); for (const resource of [resourceA, resourceB]) assert.strictEqual(route.kind === 'native' ? strings.includes(resource) : strings.some(value => value.includes(resource)), true);
			chatMessages[4] = { ...chatMessages[4], result: 'x'.repeat(50_000), content: 'x'.repeat(50_000) };
			await assert.rejects(() => converter.prepareLLMChatMessages({ chatMessages, chatMode: 'agent', modelSelection: { providerName: route.providerName, modelName: route.modelName } as never, instructionSnapshot: runtimeSnapshot }), /skill_resource_context_admission_failed/);
		}
		const childSnapshot = snapshotFor('openAI', 'gpt-4.1');
		const childConverted = await converter.prepareLLMChatMessages({ chatMessages: [{ role: 'user', content: 'delegated read' } as any], chatMode: 'agent', modelSelection: { providerName: 'openAI', modelName: 'gpt-4.1' }, instructionSnapshot: childSnapshot, toolExecutionProfile: 'read-only-child', childRoot: 'file:///workspace' });
		const childStrings = stringsOf(childConverted); for (const body of [skillBody('demo'), skillBody('other')]) assert.strictEqual(childStrings.some(value => value.includes(body)), true);
		assert.strictEqual(JSON.stringify(childConverted).includes('read_skill_resource'), false);
		const rootHintConverter = new ConvertToLLMMessageService({ getModels: () => [] } as never, { getWorkspace: () => ({ folders: [] }) } as never, { activeEditor: undefined } as never, { getAllDirectoriesStr: async () => '' } as never, { listPersistentTerminalIds: () => [] } as never, { state: { overridesOfModel: {}, globalSettings: {}, optionsOfModelSelection: {} } } as never, { getMCPTools: () => [] } as never);
		const inheritedSystem = await (rootHintConverter as any)._generateChatMessagesSystemMessage('agent', undefined, 'inherited-parent-write-child', 'file:///workspace', false, captureParentModelToolSnapshot('agent', undefined, false));
		assert.strictEqual(inheritedSystem.includes('captured parent tool profile'), true); assert.strictEqual(inheritedSystem.includes('to inspect only the captured workspace root'), false);
	});

	test('serializes optional spawn_agent.agent_type only for the delegated parent XML fallback', async () => {
		const converter = new ConvertToLLMMessageService({ getModels: () => [] } as never, { getWorkspace: () => ({ folders: [{ uri: URI.parse('file:///workspace') }] }) } as never, { activeEditor: undefined } as never, { getAllDirectoriesStr: async () => '' } as never, { listPersistentTerminalIds: () => [] } as never, { state: { overridesOfModel: {}, globalSettings: {}, optionsOfModelSelection: {} } } as never, { getMCPTools: () => [] } as never);
		const route = { providerName: 'openAI', modelName: 'unrecognized-xml-model' } as const;
		const runtimeSnapshot = snapshotFor(route.providerName, route.modelName, 10_000);
		const delegated = await converter.prepareLLMChatMessages({ chatMessages: [{ role: 'user', content: 'delegate' } as any], chatMode: 'agent', modelSelection: route as never, instructionSnapshot: runtimeSnapshot, agentDelegationAllowed: true });
		const delegatedText = JSON.stringify(delegated); assert.strictEqual(delegatedText.includes('spawn_agent'), true); assert.strictEqual(delegatedText.includes('agent_type'), true);
		const ordinary = await converter.prepareLLMChatMessages({ chatMessages: [{ role: 'user', content: 'ordinary' } as any], chatMode: 'agent', modelSelection: route as never, instructionSnapshot: runtimeSnapshot, agentDelegationAllowed: false });
		assert.strictEqual(JSON.stringify(ordinary).includes('spawn_agent'), false);
	});

	test('reserves MCP server-name lookup for the application tool', () => {
		const value: any = { _mcpService: { getMCPTools() { throw new Error('must not inspect MCP'); } } };
		assert.strictEqual((ChatThreadService.prototype as any)._computeMCPServerOfToolName.call(value, 'read_skill_resource'), undefined);
	});
});
