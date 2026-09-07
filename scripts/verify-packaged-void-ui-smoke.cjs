/*---------------------------------------------------------------------------------------------
 *  Packaged Void UI smoke: isolated extracted-app acceptance.
 *--------------------------------------------------------------------------------------------*/
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const { _electron } = require('@playwright/test');

const FAKE_KEY = 'void-ui-smoke-fake-key';
const timeoutMs = 75_000;
const closeTimeoutMs = 5_000;
const readonlyChildTools = ['ls_dir', 'read_file', 'search_for_files', 'search_in_file', 'search_pathnames_only'];
const fakeAssertions = [
	'fixed-start-without-onboarding',
	'fixed-visible-luna-model',
	'chat-empty-send-disabled',
	'settings-project-delegation-and-defaults',
	'child-agent-project-instructions',
	'child-running-and-completed',
	'queue-and-steer-during-live-tool',
	'receipt-local-terminal-stop',
	'renderer-clean-close',
];
const productionAssertions = [
	'fixed-start-without-onboarding',
	'production-single-completed-request',
	'renderer-clean-close',
];
let activeEvidence;
let evidencePath;
let evidenceWritten = false;

function argument(name) {
	const index = process.argv.indexOf(name);
	if (index < 0 || index + 1 >= process.argv.length) throw new Error(`Missing required argument: ${name}`);
	return process.argv[index + 1];
}
function hasArgument(name) { return process.argv.includes(name); }
function sanitize(value) {
	return String(value).replaceAll(FAKE_KEY, '[redacted]').replace(/(?:sk-|Bearer\s+)[A-Za-z0-9._-]+/gi, '[redacted]').replace(/[\r\n]+/g, ' ').slice(0, 500);
}
function assertRegularPath(value, label) {
	const resolved = path.resolve(value);
	if (!fs.existsSync(resolved) || fs.lstatSync(resolved).isSymbolicLink()) throw new Error(`${label} is unavailable.`);
	return resolved;
}
function assertRegularDirectory(value, label) {
	const resolved = assertRegularPath(value, label);
	if (!fs.lstatSync(resolved).isDirectory()) throw new Error(`${label} is unavailable.`);
	return resolved;
}
function assertRegularFile(value, label) {
	const resolved = assertRegularPath(value, label);
	if (!fs.lstatSync(resolved).isFile()) throw new Error(`${label} is unavailable.`);
	return resolved;
}
function samePath(left, right) {
	const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
	return normalize(left) === normalize(right);
}
function isWithin(root, value) {
	const relative = path.relative(path.resolve(root), path.resolve(value));
	return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
function assertDisjoint(root, value, label) {
	if (isWithin(root, value) || isWithin(value, root)) throw new Error(`${label} must be outside the development source.`);
}
function assertContained(root, value, label) {
	const resolvedRoot = path.resolve(root);
	const resolvedValue = path.resolve(value);
	const relative = path.relative(resolvedRoot, resolvedValue);
	if (relative === '' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`${label} is outside the smoke workspace.`);
	return resolvedValue;
}
function makeDirectory(root, leaf) {
	const target = assertContained(root, path.join(root, leaf), leaf);
	fs.mkdirSync(target, { recursive: true });
	return assertRegularPath(target, leaf);
}
function assertFreshDevelopmentRunRoot(value, developmentAppRoot) {
	const runRoot = assertRegularDirectory(value, 'development run root');
	const temporaryRoot = assertRegularDirectory(os.tmpdir(), 'OS temporary directory');
	assertContained(temporaryRoot, runRoot, 'development run root');
	assertDisjoint(developmentAppRoot, runRoot, 'development run root');
	if (fs.readdirSync(runRoot).length !== 0) throw new Error('Development run root must be empty.');
	return runRoot;
}
function sleep(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }
function expectedAssertions(mode) { return mode === 'fake' ? fakeAssertions : productionAssertions; }
function newEvidence(mode, development = false) {
	const evidence = {
		kind: 'void-packaged-ui-smoke', schemaVersion: 2, mode, pass: false, assertions: [], errors: [], mainStderr: [],
		close: { attempted: false, completed: false, error: null },
		launch: { isolated: true, provider: 'openAICompatible', network: mode === 'fake' ? 'loopback fake endpoint only' : 'packaged provider one-request smoke', credentials: mode === 'fake' ? 'fake key redacted' : 'packaged resolver only' },
		transport: mode === 'fake'
			? { requests: 0, pathExact: false, wireModelGpt41: false, parentAgentsMarker: false, parentConfigMarker: false, parentSpawnAgentControlTool: false, childRequests: 0, childRoleMarker: false, childReadOnlyToolsExact: false, childControlToolsAbsent: false }
			: { requests: 0, completed: 0, nativeAgentToolSchema: false },
	};
	if (development) evidence.launch.provenance = 'development-source-app fake-only';
	return evidence;
}
function writeEvidence(evidence) {
	if (evidenceWritten || !evidencePath) return;
	const temporary = `${evidencePath}.tmp-${process.pid}`;
	try { fs.writeFileSync(temporary, JSON.stringify(evidence), { encoding: 'utf8', flag: 'wx' }); fs.renameSync(temporary, evidencePath); evidenceWritten = true; }
	catch (error) { try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { } console.error(`Unable to write packaged UI evidence: ${sanitize(error)}`); process.exitCode = 1; }
}
function addError(evidence, source, error) { evidence.errors.push({ source, message: sanitize(error) }); }
function recordMainStderrLine(evidence, line) {
	const message = sanitize(line).trim();
	if (message.length === 0) return;
	if (evidence.mainStderr.length < 20) evidence.mainStderr.push(message);
	const dep0168 = /^\(node:\d+\) \[DEP0168\] DeprecationWarning: Uncaught N-API callback exception detected/;
	const watcher = /^\[main .*UtilityProcess id: \d+, type: fileWatcher, pid: <none>\]: unable to kill the process$/;
	const disposable = /^Error: Trying to add a disposable to a DisposableStore that has already been disposed of\./;
	const isolatedPackagedSmokeJumpList = evidence.kind === 'void-packaged-ui-smoke' && evidence.launch.isolated === true && /^\[\d+:\d+\/\d+\.\d+:ERROR:electron_api_app\.cc\(\d+\)\] Failed to begin Jump List transaction\.$/.test(message);
	if (dep0168.test(message) || isolatedPackagedSmokeJumpList || (evidence.close.attempted && (watcher.test(message) || disposable.test(message)))) return;
	if (/\b(?:ReferenceError|TypeError|SyntaxError|Unhandled|uncaught|fatal|ERR_[A-Z_]+)\b|\bError:|\bunable to kill\b/i.test(message)) addError(evidence, 'main-stderr', message);
}
function createMainStderrRecorder(evidence) {
	const decoder = new StringDecoder('utf8'); let pending = ''; let discard = false;
	const acceptText = value => {
		let text = value;
		if (discard) { const newline = text.indexOf('\n'); if (newline < 0) return; discard = false; text = text.slice(newline + 1); }
		pending += text;
		let newline = pending.indexOf('\n');
		while (newline >= 0) { const line = pending.slice(0, newline).replace(/\r$/, ''); pending = pending.slice(newline + 1); recordMainStderrLine(evidence, line); newline = pending.indexOf('\n'); }
		if (pending.length > 16_384) { addError(evidence, 'main-stderr', 'stderr line exceeded 16384 characters'); pending = ''; discard = true; }
	};
	return { accept: chunk => acceptText(typeof chunk === 'string' ? chunk : decoder.write(chunk)), flush: () => { acceptText(decoder.end()); if (!discard && pending.length) recordMainStderrLine(evidence, pending.replace(/\r$/, '')); pending = ''; discard = false; } };
}
function waitForMainProcessOutput(child) {
	const processClosed = child.exitCode !== null ? Promise.resolve() : new Promise(resolve => child.once('close', resolve));
	const stderrEnded = !child.stderr || child.stderr.readableEnded ? Promise.resolve() : new Promise(resolve => { child.stderr.once('end', resolve); child.stderr.once('close', resolve); });
	return Promise.all([processClosed, stderrEnded]).then(() => undefined);
}
function attachPageListeners(page, evidence, attachedPages) {
	if (attachedPages.has(page)) return;
	attachedPages.add(page);
	page.on('pageerror', error => addError(evidence, 'renderer-pageerror', error));
	page.on('console', message => { if (message.type() === 'error') addError(evidence, 'renderer-console', message.text()); });
}

function contentText(content) {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	return content.map(part => typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '').join('\n');
}
function requestSummary(payload) {
	const messages = Array.isArray(payload?.messages) ? payload.messages : [];
	const instructions = messages.filter(message => message && (message.role === 'developer' || message.role === 'system')).map(message => contentText(message.content)).join('\n');
	const userText = messages.filter(message => message?.role === 'user').map(message => contentText(message.content)).join('\n');
	const tools = Array.isArray(payload?.tools) ? payload.tools.map(tool => typeof tool?.function?.name === 'string' ? tool.function.name : '').filter(Boolean).sort() : [];
	return { modelIsWire: payload?.model === 'gpt-4.1', hasAgentsMarker: instructions.includes('VOID_SMOKE_AGENTS_MARKER'), hasConfigMarker: instructions.includes('VOID_SMOKE_CONFIG_MARKER'), hasRoleMarker: instructions.includes('VOID_SMOKE_ROLE_MARKER'), looksLikeFixtureChild: instructions.includes('fixture-reader'), taskRequestsTerminal: userText.includes('VOID_SMOKE_TERMINAL'), userText, tools };
}
function completionChunk(delta, finishReason = null) { return { id: 'void-smoke', object: 'chat.completion.chunk', created: 0, model: 'gpt-4.1', choices: [{ index: 0, delta, finish_reason: finishReason }] }; }
function writeSse(response, events) {
	response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
	for (const event of events) response.write(`data: ${event === '[DONE]' ? event : JSON.stringify(event)}\n\n`);
	response.end();
}
function writeText(response, text) { writeSse(response, [completionChunk({ role: 'assistant', content: text }), completionChunk({}, 'stop'), '[DONE]']); }
function writeTool(response, id, name, params) {
	writeSse(response, [completionChunk({ role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(params) } }] }), completionChunk({}, 'tool_calls'), '[DONE]']);
}
function readJsonRequest(request) {
	return new Promise((resolve, reject) => {
		let body = ''; let rejected = false;
		request.setEncoding('utf8');
		request.on('data', part => { if (rejected) return; body += part; if (body.length > 1_000_000) { rejected = true; body = ''; reject(new Error('Fake smoke request exceeded bounded fixture size.')); } });
		request.once('error', reject);
		request.once('end', () => { if (rejected) return; try { resolve(JSON.parse(body)); } catch { reject(new Error('Fake smoke request was not JSON.')); } finally { body = ''; } });
	});
}
async function startFakeServer(evidence) {
	let parentPhase = 0; let terminalIssued = false; let childResponse; let childHeldResolve; const requestSummaries = [];
	const childHeld = new Promise(resolve => { childHeldResolve = resolve; });
	const server = http.createServer(async (request, response) => {
		try {
			evidence.transport.requests += 1;
			if (request.method !== 'POST' || request.url !== '/chat/completions') { response.writeHead(404).end(); return; }
			const summary = requestSummary(await readJsonRequest(request)); requestSummaries.push(summary);
			evidence.transport.pathExact = true;
			evidence.transport.wireModelGpt41 ||= summary.modelIsWire;
			evidence.transport.parentAgentsMarker ||= summary.hasAgentsMarker;
			evidence.transport.parentConfigMarker ||= summary.hasConfigMarker;
			evidence.transport.parentSpawnAgentControlTool ||= summary.tools.includes('spawn_agent');
			const isChild = summary.hasRoleMarker || summary.looksLikeFixtureChild;
			if (isChild) {
				evidence.transport.childRequests += 1;
				evidence.transport.childRoleMarker = summary.hasRoleMarker;
				evidence.transport.childReadOnlyToolsExact = summary.tools.join('|') === readonlyChildTools.join('|');
				evidence.transport.childControlToolsAbsent = !summary.tools.some(name => ['spawn_agent', 'wait_agent', 'interrupt_agent', 'run_command', 'run_persistent_command'].includes(name));
				if (childResponse) throw new Error('Fake smoke received more than one held child request.');
				childResponse = response; childHeldResolve(); return;
			}
			if (summary.taskRequestsTerminal && !terminalIssued) { terminalIssued = true; writeTool(response, 'smoke-terminal-tool', 'run_command', { command: 'ping -n 30 127.0.0.1 > nul', cwd: '.' }); return; }
			if (parentPhase === 0) { parentPhase = 1; writeTool(response, 'smoke-spawn-tool', 'spawn_agent', { message: 'Inspect the fixture as the selected role.', agent_type: 'fixture-reader' }); return; }
			if (parentPhase === 1) { parentPhase = 2; writeTool(response, 'smoke-wait-tool', 'wait_agent', { timeout_ms: 5000 }); return; }
			writeText(response, 'Void smoke fixture completed.');
		} catch (error) {
			if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
			response.end('fixture failure'); addError(evidence, 'fake-loopback', error);
		}
	});
	await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('Fake smoke server did not bind ephemeral loopback.');
	return {
		endpoint: `http://127.0.0.1:${address.port}`,
		requestSummaries: () => [...requestSummaries],
		waitForChild: () => childHeld,
		releaseChild: () => { if (!childResponse) throw new Error('Child completion was requested before provider request arrived.'); const response = childResponse; childResponse = undefined; writeText(response, 'Fixture reader completed.'); },
		close: async () => { if (childResponse) { childResponse.destroy(); childResponse = undefined; } server.closeAllConnections?.(); await new Promise(resolve => server.close(() => resolve())); },
	};
}
function writeFixtureWorkspace(workspace, mode) {
	fs.writeFileSync(assertContained(workspace, path.join(workspace, 'README.md'), 'workspace fixture'), '# Void smoke fixture\n', 'utf8');
	if (mode !== 'fake') return;
	const codex = makeDirectory(workspace, '.codex'); const agents = makeDirectory(codex, 'agents');
	fs.writeFileSync(assertContained(workspace, path.join(workspace, 'AGENTS.md'), 'AGENTS.md'), 'VOID_SMOKE_AGENTS_MARKER\n', 'utf8');
	fs.writeFileSync(assertContained(codex, path.join(codex, 'config.toml'), 'fixture config'), 'developer_instructions = "VOID_SMOKE_CONFIG_MARKER"\n\n[agents]\nmax_accepted_children = 5\nmax_concurrent_threads_per_session = 2\nmax_depth = 1\n', 'utf8');
	fs.writeFileSync(assertContained(agents, path.join(agents, 'fixture-reader.toml'), 'fixture role'), 'name = "fixture-reader"\ndescription = "Read the fixture only."\ndeveloper_instructions = "VOID_SMOKE_ROLE_MARKER"\nsandbox_mode = "read-only"\ncapability_profile = "read_only"\n', 'utf8');
}
function launchEnvironment(mode, home, fakeEndpoint, developmentAppRoot) {
	const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData'), LOCALAPPDATA: path.join(home, 'AppData', 'Local') };
	for (const key of ['VOID_CORPORATE_TEST_ENDPOINT', 'VOID_CORPORATE_API_KEY', 'VOID_CORPORATE_API_KEY_PATH', 'VOID_CORPORATE_PRODUCTION_SMOKE', 'DEBUG', 'OPENAI_LOG', 'NODE_DEBUG']) delete env[key];
	if (mode === 'fake') {
		env.VOID_CORPORATE_TEST_ENDPOINT = fakeEndpoint;
		env.VOID_CORPORATE_API_KEY = FAKE_KEY;
		if (developmentAppRoot) {
			delete env.ELECTRON_RUN_AS_NODE;
			env.NODE_ENV = 'development';
			env.VSCODE_DEV = '1';
			env.VSCODE_CLI = '1';
		}
	} else env.VOID_CORPORATE_PRODUCTION_SMOKE = '1';
	return env;
}
async function waitVisible(locator, label) { await locator.waitFor({ state: 'visible', timeout: timeoutMs }); if (!(await locator.isVisible())) throw new Error(`${label} was not visible.`); }
function getChatComposer(page) { return page.getByRole('combobox', { name: 'Chat message', exact: true }); }
async function waitForCurrentRunToSettle(page) {
	await page.locator('#void-chat-current-stop:visible').waitFor({ state: 'hidden', timeout: timeoutMs });
}
async function waitForEnabledCurrentSend(page) { await waitVisible(page.locator('#void-chat-current-send:not([disabled])'), 'enabled current Send'); }
async function assertNoOnboarding(page) {
	const onboarding = page.getByRole('button', { name: 'Get Started', exact: true });
	if (await onboarding.count() > 0 && await onboarding.first().isVisible().catch(() => false)) throw new Error('Fixed product rendered onboarding.');
}
async function openVoidSettings(page) {
	await page.keyboard.press('Control+Shift+P');
	const commandBox = page.getByPlaceholder('Type the name of a command to run.'); await waitVisible(commandBox, 'Command Palette');
	await commandBox.fill('>Void: Open Settings');
	await page.keyboard.press('Enter');
}
async function assertSettings(page) {
	await openVoidSettings(page);
	const general = page.getByRole('button', { name: 'General', exact: true }); if (await general.count()) await general.click();
	const heading = page.getByRole('heading', { name: 'Agent delegation', exact: true }); await waitVisible(heading, 'Agent delegation settings');
	const text = await heading.locator('..').innerText();
	for (const required of ['Open children', '5', 'Concurrent children', '2', 'Maximum depth', '1', 'project']) if (!text.includes(required)) throw new Error(`Agent delegation settings did not show ${required}.`);
	const featureOptions = page.getByRole('button', { name: 'Feature Options', exact: true }); await waitVisible(featureOptions, 'Feature Options settings'); await featureOptions.click();
	for (const label of ['Auto-approve edits', 'Auto-approve terminal', 'Auto-approve MCP tools']) { const checkbox = page.getByRole('switch', { name: label, exact: true }); await waitVisible(checkbox, label); if (!(await checkbox.isChecked())) throw new Error(`${label} was not enabled by defaults.`); }
	const autoAccept = page.getByRole('switch', { name: 'Auto-accept LLM changes', exact: true }); await waitVisible(autoAccept, 'Auto-accept LLM changes'); if (await autoAccept.isChecked()) throw new Error('Auto-accept LLM changes was enabled by defaults.');
}
async function assertFixedAgentOnlyComposer(luna) {
	const composerOptions = luna.locator('..');
	const modeSelector = composerOptions.getByRole('button', { name: /^(Chat|Gather|Agent)$/ });
	for (let index = 0; index < await modeSelector.count(); index++) {
		if (await modeSelector.nth(index).isVisible().catch(() => false)) throw new Error('Fixed Agent-only product rendered a Chat mode selector.');
	}
}
async function selectFixtureAgent(page, chat) {
	await chat.click(); await page.keyboard.type('@');
	const agent = page.getByRole('option', { name: 'Agent', exact: true }); await waitVisible(agent, 'Agent picker option');
	if (await agent.getAttribute('aria-selected') !== 'false') throw new Error('Agent click regression did not begin on a non-highlighted option.');
	await agent.click();
	const fixtureRole = page.getByRole('option', { name: 'fixture-reader', exact: true }); await waitVisible(fixtureRole, 'fixture-reader picker option');
	if (await fixtureRole.getAttribute('aria-selected') !== 'false') throw new Error('Fixture role click regression did not begin on a non-highlighted option.');
	await fixtureRole.click();
	await fixtureRole.waitFor({ state: 'hidden', timeout: timeoutMs });
}
async function runFakeAcceptance(page, evidence, fakeServer) {
	await assertNoOnboarding(page); evidence.assertions.push('fixed-start-without-onboarding');
	const luna = page.getByTestId('void-corporate-model-display'); await waitVisible(luna, 'Fixed Luna model label'); if ((await luna.innerText()).trim() !== 'gpt-5.6-luna') throw new Error('Fixed model label was not gpt-5.6-luna.'); await assertFixedAgentOnlyComposer(luna); evidence.assertions.push('fixed-visible-luna-model');
	const chat = getChatComposer(page); const send = page.getByRole('button', { name: 'Send message', exact: true }); await waitVisible(chat, 'Chat composer'); await waitVisible(send, 'Chat send'); if (!(await send.isDisabled())) throw new Error('Empty Chat Send control was enabled.'); evidence.assertions.push('chat-empty-send-disabled');
	await assertSettings(page); evidence.assertions.push('settings-project-delegation-and-defaults');
	await waitVisible(chat, 'Chat composer after Settings'); await selectFixtureAgent(page, chat); await chat.fill('Inspect the fixture with the selected Agent.'); await send.click(); await fakeServer.waitForChild();
	if (!evidence.transport.pathExact || !evidence.transport.wireModelGpt41 || !evidence.transport.parentAgentsMarker || !evidence.transport.parentConfigMarker || !evidence.transport.parentSpawnAgentControlTool || evidence.transport.childRequests !== 1 || !evidence.transport.childRoleMarker || !evidence.transport.childReadOnlyToolsExact || !evidence.transport.childControlToolsAbsent) throw new Error('Fixed route, project instructions, parent control, or read-only child tool contract did not reach fake provider.');
	evidence.assertions.push('child-agent-project-instructions');
	const childActivity = page.getByTestId('child-activity-card'); await waitVisible(childActivity, 'Child Activity card'); const childSummary = childActivity.locator('summary[aria-label^="Child Activity "]'); await waitVisible(childSummary, 'Child Activity summary');
	if (!/running/i.test(await childSummary.innerText())) throw new Error('Child Activity did not remain visibly running before held response settled.');
	fakeServer.releaseChild(); await waitVisible(childActivity.locator('summary[aria-label^="Child Activity "]').filter({ hasText: /completed/i }), 'completed Child Activity'); if (await childActivity.count() !== 1) throw new Error('Child Activity history was duplicated.'); evidence.assertions.push('child-running-and-completed'); await waitForCurrentRunToSettle(page);
	const terminalCommand = '"ping -n 30 127.0.0.1 > nul"';
	await chat.fill('VOID_SMOKE_TERMINAL'); await waitForEnabledCurrentSend(page); await chat.press('Enter'); const terminalCard = page.getByText(terminalCommand, { exact: true }).locator('xpath=ancestor::div[contains(@class, "border-void-border-3")][1]'); await waitVisible(terminalCard, 'Terminal card'); const terminalStop = terminalCard.getByRole('button', { name: 'Stop this tool', exact: true }); await waitVisible(terminalStop, 'Terminal card Stop'); if (await terminalStop.isDisabled()) throw new Error('Terminal card Stop was not independently enabled.');
	await page.waitForTimeout(1_050); const elapsed = page.getByTestId('void-tool-elapsed').last(); await waitVisible(elapsed, 'Visible tool elapsed'); if (!/Elapsed\s+\d+s/.test(await elapsed.innerText())) throw new Error('Live tool elapsed text was not rendered.');
	await chat.fill('VOID_SMOKE_QUEUE'); await page.getByRole('button', { name: 'Queue message', exact: true }).press('Enter');
	const pending = page.locator('section[aria-label="Queued messages"]'); await waitVisible(pending, 'Queued messages'); await waitVisible(pending.getByText('VOID_SMOKE_QUEUE', { exact: true }), 'queued fixture message'); await page.waitForFunction(element => element instanceof HTMLTextAreaElement && element.value === '', await chat.elementHandle());
	await chat.fill('VOID_SMOKE_STEER'); await page.getByRole('combobox', { name: 'More message actions', exact: true }).selectOption('steer'); await waitVisible(pending.getByText('VOID_SMOKE_STEER', { exact: true }), 'steered fixture message'); const pendingText = await pending.innerText(); if (!pendingText.includes('Queue') || !pendingText.includes('Steer')) throw new Error(`Queue and Steer were not retained while terminal was live: ${pendingText.slice(0, 500)}`); evidence.assertions.push('queue-and-steer-during-live-tool');
	await terminalStop.press('Enter');
	await terminalStop.waitFor({ state: 'hidden', timeout: timeoutMs });
	await terminalCard.getByText('Cancelled', { exact: true }).waitFor({ state: 'visible', timeout: timeoutMs });
	evidence.assertions.push('receipt-local-terminal-stop');
}
async function runProductionAcceptance(page, electronApp, evidence) {
	await assertNoOnboarding(page); evidence.assertions.push('fixed-start-without-onboarding');
	const luna = page.getByTestId('void-corporate-model-display'); await waitVisible(luna, 'Fixed Luna model label'); if ((await luna.innerText()).trim() !== 'gpt-5.6-luna') throw new Error('Fixed model label was not gpt-5.6-luna.'); await assertFixedAgentOnlyComposer(luna);
	const chat = getChatComposer(page); const send = page.getByRole('button', { name: 'Send message', exact: true }); await waitVisible(chat, 'Chat composer'); await chat.fill('Reply with exactly OK. Do not use tools.'); await send.click();
	let counters;
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		counters = await electronApp.evaluate(() => {
			const value = globalThis.__voidCorporateProductionSmokeCounters;
			return value ? { requests: Number(value.requests), completed: Number(value.completed), nativeAgentToolSchema: value.nativeAgentToolSchema === true } : undefined;
		});
		if (counters?.requests === 1 && counters?.completed === 1 && counters?.nativeAgentToolSchema === true) break;
		await sleep(100);
	}
	if (!counters || counters.requests !== 1 || counters.completed !== 1 || counters.nativeAgentToolSchema !== true) throw new Error('Production smoke did not record one completed native-tool request.');
	await waitVisible(page.getByText('OK', { exact: true }).last(), 'Production smoke exact response');
	evidence.transport = counters; evidence.assertions.push('production-single-completed-request');
}
async function launchAndExercise(mode, evidence, runRoot, exe, developmentAppRoot) {
	const workspace = makeDirectory(runRoot, `${mode}-workspace`); const userData = makeDirectory(runRoot, `${mode}-user-data`); const extensions = makeDirectory(runRoot, `${mode}-extensions`); const logs = makeDirectory(runRoot, `${mode}-logs`); const crash = makeDirectory(runRoot, `${mode}-crash`); const home = makeDirectory(runRoot, `${mode}-home`);
	if (mode === 'fake') { const editorHome = makeDirectory(home, '.void-editor'); makeDirectory(editorHome, 'extensions'); }
	writeFixtureWorkspace(workspace, mode);
	let fakeServer; let electronApp; let mainOutput = Promise.resolve(); const stderr = createMainStderrRecorder(evidence);
	try {
		if (mode === 'fake') fakeServer = await startFakeServer(evidence);
		const launchArguments = [...(developmentAppRoot ? [developmentAppRoot] : []), workspace, `--user-data-dir=${userData}`, `--extensions-dir=${extensions}`, `--logsPath=${logs}`, `--crash-reporter-directory=${crash}`, '--disable-extensions', '--disable-gpu', '--disable-background-networking', '--disable-component-update', '--no-proxy-server', '--disable-telemetry', '--disable-workspace-trust', '--disable-updates', '--use-inmemory-secretstorage', '--skip-release-notes', '--skip-welcome', '--no-cached-data', '--enable-smoke-test-driver'];
		const launchOptions = { executablePath: exe, args: launchArguments, env: launchEnvironment(mode, home, fakeServer?.endpoint, developmentAppRoot) };
		if (developmentAppRoot) launchOptions.cwd = runRoot;
		electronApp = await _electron.launch(launchOptions);
		const pages = new WeakSet(); const context = electronApp.context(); context.on('page', page => attachPageListeners(page, evidence, pages)); for (const page of context.pages()) attachPageListeners(page, evidence, pages);
		const child = electronApp.process(); if (child.stderr) child.stderr.on('data', stderr.accept); mainOutput = waitForMainProcessOutput(child);
		const page = await electronApp.firstWindow({ timeout: timeoutMs }); attachPageListeners(page, evidence, pages);
		if (mode === 'fake') await runFakeAcceptance(page, evidence, fakeServer); else await runProductionAcceptance(page, electronApp, evidence);
		evidence.assertions.push('renderer-clean-close');
	} finally {
		if (electronApp) { evidence.close.attempted = true; try { await electronApp.close(); evidence.close.completed = true; } catch (error) { evidence.close.error = sanitize(error); } }
		const settled = await Promise.race([mainOutput.then(() => true), sleep(closeTimeoutMs).then(() => false)]); if (!settled) addError(evidence, 'main-stderr', `Main process or stderr did not settle within ${closeTimeoutMs}ms after close.`); stderr.flush();
		if (fakeServer) await fakeServer.close().catch(error => addError(evidence, 'fake-loopback-close', error));
	}
}
function resolveLaunchContract(mode) {
	const hasDevelopmentAppRoot = hasArgument('--development-app-root');
	const hasDevelopmentRunRoot = hasArgument('--development-run-root');
	if (mode !== 'fake' && (hasDevelopmentAppRoot || hasDevelopmentRunRoot)) throw new Error('Development launch flags are fake-only.');
	if (hasDevelopmentAppRoot !== hasDevelopmentRunRoot) throw new Error('Development app and run roots must be supplied together.');
	const smokeRoot = assertRegularPath(argument('--smoke-root'), 'smoke root');
	if (!hasDevelopmentAppRoot) {
		const resolvedEvidencePath = assertContained(smokeRoot, argument('--evidence'), 'evidence path');
		if (fs.existsSync(resolvedEvidencePath)) throw new Error('Evidence path must be absent before launch.');
		const productRoot = assertRegularPath(argument('--product-root'), 'extracted product root');
		assertContained(smokeRoot, productRoot, 'extracted product root');
		const exe = assertRegularPath(argument('--exe'), 'Void executable');
		if (path.dirname(exe) !== productRoot) throw new Error('Void executable was not the immediate extracted product child.');
		return { smokeRoot, runRoot: smokeRoot, productRoot, exe, evidencePath: resolvedEvidencePath, developmentAppRoot: undefined };
	}
	if (hasArgument('--product-root') || hasArgument('--exe')) throw new Error('Development launch derives the product root and executable.');
	const developmentAppRoot = assertRegularDirectory(argument('--development-app-root'), 'development app root');
	assertRegularFile(path.join(developmentAppRoot, 'package.json'), 'development package manifest');
	assertRegularFile(path.join(developmentAppRoot, 'out', 'main.js'), 'development entrypoint');
	if (!samePath(smokeRoot, path.join(developmentAppRoot, '.build'))) throw new Error('Development smoke root must be the source build directory.');
	assertRegularDirectory(smokeRoot, 'development build root');
	const productRoot = assertRegularDirectory(path.join(smokeRoot, 'electron'), 'development product root');
	const exe = assertRegularFile(path.join(productRoot, 'Void.exe'), 'development Void executable');
	const runRoot = assertFreshDevelopmentRunRoot(argument('--development-run-root'), developmentAppRoot);
	const resolvedEvidencePath = assertContained(runRoot, argument('--evidence'), 'evidence path');
	if (fs.existsSync(resolvedEvidencePath)) throw new Error('Evidence path must be absent before launch.');
	return { smokeRoot, runRoot, productRoot, exe, evidencePath: resolvedEvidencePath, developmentAppRoot };
}
async function main() {
	const mode = argument('--mode'); if (mode !== 'fake' && mode !== 'production') throw new Error('Smoke mode must be fake or production.');
	const development = mode === 'fake' && hasArgument('--development-app-root') && hasArgument('--development-run-root');
	const evidence = newEvidence(mode, development); activeEvidence = evidence;
	try {
		const launch = resolveLaunchContract(mode); evidencePath = launch.evidencePath;
		await launchAndExercise(mode, evidence, launch.runRoot, launch.exe, launch.developmentAppRoot);
	} catch (error) { addError(evidence, 'assertion', error); }
	finally { const expected = expectedAssertions(mode); evidence.pass = evidence.assertions.length === expected.length && expected.every((value, index) => evidence.assertions[index] === value) && evidence.errors.length === 0 && evidence.close.attempted && evidence.close.completed; writeEvidence(evidence); }
	if (!evidence.pass) process.exitCode = 1;
}
module.exports = { assertSettings, attachPageListeners, getChatComposer, launchEnvironment, startFakeServer, waitVisible, writeFixtureWorkspace };
if (require.main === module) {
	process.on('unhandledRejection', error => { if (!activeEvidence) return; activeEvidence.pass = false; addError(activeEvidence, 'unhandled-rejection', error); writeEvidence(activeEvidence); process.exitCode = 1; });
	void main().catch(error => { const evidence = activeEvidence ?? newEvidence('fake'); evidence.pass = false; addError(evidence, 'helper', error); writeEvidence(evidence); process.exitCode = 1; });
}
