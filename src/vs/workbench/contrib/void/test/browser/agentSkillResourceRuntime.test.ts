import * as assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ChatThreadService } from '../../browser/chatThreadService.js';
import { ConvertToLLMMessageService } from '../../browser/convertToLLMMessageService.js';
import { AgentRuntimeTurnSnapshot, createAgentRuntimeTurnSnapshot, createSkillCatalog, skillAdvertisement } from '../../common/agentSkills.js';
import { projectAgentConfig, resolveAgentInstructions, stableAgentInstructionRevision } from '../../common/agentInstructions.js';

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
		_instructionTurnOfThread: new Map([['parent', runtimeSnapshot]]), _agentInstructionSessionOfThread: new Map(), _agentControlGeneration: new Map([['parent', 0]]), _agentDelegationAuthorityOfThread: new Map(),
		_workspaceContextService: { getWorkspace: () => ({ folders: owner ? [{ uri: URI.parse(owner) }] : [] }) }, _workspaceTrustManagementService: { isWorkspaceTrusted: () => trusted },
		_agentSkillsService: { readSkillResource: async (selection: unknown, resourcePath: string, options: unknown) => { serviceCalls.push({ selection, resourcePath, options }); return { body: 'RESOURCE\n' }; } },
		_convertToLLMMessagesService: { prepareLLMChatMessages: async (options: unknown) => { conversionCalls.push(options); return { messages: [], separateSystemMessage: undefined }; } },
		_toolsService: { validateParams: new Proxy({}, { get() { throw new Error('builtin lookup'); } }) }, _mcpService: { getMCPTools() { throw new Error('MCP lookup'); } },
		_agentSubagentService: { cancelParent() { }, forgetParent() { } },
		_addMessageToThread(_threadId: string, message: any) { messages.push(message); },
		_updateLatestTool(_threadId: string, message: any) { if (messages[messages.length - 1]?.role === 'tool') messages[messages.length - 1] = message; else messages.push(message); },
		_setStreamState(threadId: string, state: any) { value.streamState[threadId] = state; },
		_purgeInstructionTurn(threadId: string) { purges++; value._instructionTurnOfThread.delete(threadId); },
	};
	return { value, messages, serviceCalls, conversionCalls, runtimeSnapshot, setTrusted: (next: boolean) => trusted = next, setOwner: (next: string) => owner = next, purges: () => purges };
};
const run = (value: any, runtimeSnapshot: AgentRuntimeTurnSnapshot, raw: Record<string, unknown>, allowed = true) =>
	(ChatThreadService.prototype as any)._runToolCall.call(value, 'parent', 'read_skill_resource', 'provider-tool-id', 'spoofed-mcp', { preapproved: false, unvalidatedToolParams: raw }, runtimeSnapshot, undefined, allowed, value._agentControlGeneration.get('parent') ?? 0);

suite('Void selected Skill resource Chat runtime', () => {
	test('routes before builtin/MCP/approval and returns exact text from the captured selected descriptor', async () => {
		const f = fixture(); const result = await run(f.value, f.runtimeSnapshot, { skill: 'demo', resource_path: 'references/guide.md' });
		assert.deepStrictEqual(result, {}); assert.strictEqual(f.serviceCalls.length, 1); assert.strictEqual(f.serviceCalls[0].selection, f.runtimeSnapshot.selected[0]); assert.strictEqual(f.serviceCalls[0].resourcePath, 'references/guide.md');
		assert.ok(f.serviceCalls[0].options.maxResourceBytes > 0); assert.strictEqual(f.serviceCalls[0].options.token.isCancellationRequested, false); assert.strictEqual(f.conversionCalls.length, 1);
		assert.strictEqual(f.messages.length, 1); assert.strictEqual(f.messages[0].type, 'success'); assert.strictEqual(f.messages[0].content, 'RESOURCE\n'); assert.strictEqual(f.messages[0].result, 'RESOURCE\n'); assert.strictEqual(f.messages[0].id, 'provider-tool-id'); assert.strictEqual(f.messages[0].mcpServerName, undefined);
	});

	test('rejects unavailable, malformed, outside, and unknown identities before service side effects', async () => {
		for (const [raw, allowed, expected] of [
			[{ skill: 'demo', resource_path: 'a' }, false, 'read_skill_resource_not_available'],
			[{ skill: 'demo', resource_path: 'a', extra: true }, true, 'read_skill_resource_invalid_params'],
			[{ skill: 'demo', resource_path: '../a' }, true, 'skill_resource_outside_root'],
			[{ skill: 'missing', resource_path: 'a' }, true, 'skill_not_selected'],
		] as const) {
			const f = fixture(); const result = await run(f.value, f.runtimeSnapshot, raw, allowed); assert.deepStrictEqual(result, {}); assert.strictEqual(f.serviceCalls.length, 0); assert.strictEqual(f.messages.length, 1); assert.ok(f.messages[0].content.includes(expected)); assert.strictEqual(f.messages[0].mcpServerName, undefined);
		}
	});

	test('turns every read diagnostic and oversize body into one failure while retaining the same turn', async () => {
		for (const code of ['skill_resource_not_found', 'skill_stale', 'skill_resource_unreadable', 'skill_invalid_utf8']) {
			const f = fixture(); f.value._agentSkillsService.readSkillResource = async () => { f.serviceCalls.push(code); return { diagnostic: { code } }; };
			const result = await run(f.value, f.runtimeSnapshot, { skill: 'demo', resource_path: 'references/a' }); assert.deepStrictEqual(result, {}); assert.strictEqual(f.messages.length, 1); assert.strictEqual(f.messages[0].type, 'tool_error'); assert.ok(f.messages[0].content.includes(code)); assert.strictEqual(f.value._instructionTurnOfThread.get('parent'), f.runtimeSnapshot); assert.deepStrictEqual(f.runtimeSnapshot.selected.map(item => item.identity), ['demo', 'other']);
		}
		const small = fixture(snapshot(1024)); small.value._agentSkillsService.readSkillResource = async () => ({ body: 'never-partially-returned' }); const result = await run(small.value, small.runtimeSnapshot, { skill: 'demo', resource_path: 'references/a' }); assert.deepStrictEqual(result, {}); assert.strictEqual(small.messages.length, 1); assert.strictEqual(small.messages[0].type, 'tool_error'); assert.ok(small.messages[0].content.includes('skill_resource_context_admission_failed')); assert.strictEqual(small.messages[0].content.includes('never-partially-returned'), false); assert.strictEqual(small.value._instructionTurnOfThread.get('parent'), small.runtimeSnapshot);
		const conversion = fixture(); conversion.value._convertToLLMMessagesService.prepareLLMChatMessages = async () => { throw new Error('prospective history cannot fit'); }; await run(conversion.value, conversion.runtimeSnapshot, { skill: 'demo', resource_path: 'references/a' }); assert.strictEqual(conversion.messages.length, 1); assert.strictEqual(conversion.messages[0].type, 'tool_error'); assert.strictEqual(conversion.messages[0].content, 'skill_resource_context_admission_failed');
	});

	test('captures the model/history budget before the asynchronous read and never recomputes it', async () => {
		const f = fixture(snapshot(1100)); let release!: (value: { body: string }) => void; f.value._agentSkillsService.readSkillResource = () => new Promise(resolve => release = resolve);
		const pending = run(f.value, f.runtimeSnapshot, { skill: 'demo', resource_path: 'references/a' }); await Promise.resolve();
		f.value.state.allThreads.parent.messages.push({ role: 'user', content: 'x'.repeat(20_000) }); release({ body: 'fits-in-captured-budget' });
		assert.deepStrictEqual(await pending, {}); assert.strictEqual(f.messages[f.messages.length - 1].type, 'success');
	});

	test('Stop settles the running tool once and drops the late resource completion', async () => {
		const prompt = fixture(); let releasePrompt!: (value: { body: string }) => void; prompt.value._agentSkillsService.readSkillResource = () => new Promise(resolve => releasePrompt = resolve);
		const promptlySettled = run(prompt.value, prompt.runtimeSnapshot, { skill: 'demo', resource_path: 'references/a' }); await Promise.resolve();
		await ChatThreadService.prototype.abortRunning.call(prompt.value, 'parent'); assert.deepStrictEqual(await promptlySettled, { interrupted: true }); releasePrompt({ body: 'IGNORED-AFTER-SETTLEMENT' }); await Promise.resolve();
		assert.strictEqual(prompt.messages.length, 1); assert.strictEqual(prompt.messages[0].type, 'rejected');
		const f = fixture(); let release!: (value: { body: string }) => void; f.value._agentSkillsService.readSkillResource = () => new Promise(resolve => release = resolve);
		const pending = run(f.value, f.runtimeSnapshot, { skill: 'demo', resource_path: 'references/a' }); await Promise.resolve();
		const stopping = ChatThreadService.prototype.abortRunning.call(f.value, 'parent'); release({ body: 'LATE-SUCCESS' });
		await stopping; assert.deepStrictEqual(await pending, { interrupted: true }); assert.strictEqual(f.messages.some(message => message.type === 'success' || message.content === 'LATE-SUCCESS'), false); assert.strictEqual(f.messages.length, 1); assert.strictEqual(f.messages[0].type, 'rejected');
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
	});

	test('reserves MCP server-name lookup for the application tool', () => {
		const value: any = { _mcpService: { getMCPTools() { throw new Error('must not inspect MCP'); } } };
		assert.strictEqual((ChatThreadService.prototype as any)._computeMCPServerOfToolName.call(value, 'read_skill_resource'), undefined);
	});
});
