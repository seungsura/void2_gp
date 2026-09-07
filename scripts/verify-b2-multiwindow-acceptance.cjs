/*---------------------------------------------------------------------------------------------
 *  Development-only B2 acceptance: real Electron windows with a loopback fake provider.
 *--------------------------------------------------------------------------------------------*/
'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('@playwright/test');
const { attachPageListeners, getChatComposer, launchEnvironment, startFakeServer, waitVisible, writeFixtureWorkspace } = require('./verify-packaged-void-ui-smoke.cjs');

const timeoutMs = 75_000;
const ownerReleaseTimeoutMs = 120_000;
const initialText = 'B2_WINDOW_HISTORY_TOKEN';
const queuedText = 'B2_QUEUED_ONCE_TOKEN';

function sleep(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }
function waitWithDeadline(promise, label) { return Promise.race([promise, sleep(timeoutMs).then(() => { throw new Error(label); })]); }
async function eventually(predicate, label) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) { if (await predicate()) return; await sleep(100); }
	throw new Error(label);
}
async function waitForOwnerRelease(locator, label) {
	const started = Date.now(); await locator.waitFor({ state: 'visible', timeout: ownerReleaseTimeoutMs });
	console.log(`B2 diagnostic: ${label} observed after ${Date.now() - started}ms`);
}
function requireFile(file, label) { if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`${label} is unavailable: ${file}`); return file; }
function makeDirectory(root, leaf) { const value = path.join(root, leaf); fs.mkdirSync(value, { recursive: true }); return value; }
function launchArguments(sourceRoot, workspace, userData, extensions, logs, crash) {
	return [sourceRoot, workspace, `--user-data-dir=${userData}`, `--extensions-dir=${extensions}`, `--logsPath=${logs}`, `--crash-reporter-directory=${crash}`, '--disable-extensions', '--disable-gpu', '--disable-background-networking', '--disable-component-update', '--no-proxy-server', '--disable-telemetry', '--disable-workspace-trust', '--disable-updates', '--use-inmemory-secretstorage', '--skip-release-notes', '--skip-welcome', '--no-cached-data', '--enable-smoke-test-driver'];
}
async function selectFixtureAgent(page, composer) {
	await composer.click(); await page.keyboard.type('@');
	const agent = page.getByRole('option', { name: 'Agent', exact: true }); await waitVisible(agent, 'Agent picker option'); await agent.click();
	const fixture = page.getByRole('option', { name: 'fixture-reader', exact: true }); await waitVisible(fixture, 'fixture-reader picker option'); await fixture.click(); await fixture.waitFor({ state: 'hidden', timeout: timeoutMs });
}
async function openWorkspaceWindow(app, executablePath, args, env, cwd, errors, pages, label) {
	const context = app.context(); const nextPage = context.waitForEvent('page', { timeout: timeoutMs }); const stderr = []; const stdout = [];
	const cli = childProcess.spawn(executablePath, ['--new-window', ...args], { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
	cli.stdout.on('data', chunk => stdout.push(String(chunk))); cli.stderr.on('data', chunk => stderr.push(String(chunk)));
	let exit; cli.once('close', (code, signal) => { exit = { code, signal }; }); cli.once('error', error => errors.push({ source: `${label}-cli`, message: error.message }));
	try { const page = await nextPage; attachPageListeners(page, { errors }, pages); await page.waitForLoadState('domcontentloaded').catch(() => undefined); return page; }
	catch (error) { throw new Error(`${label} did not open a new window; cli=${JSON.stringify(exit)}; stdout=${stdout.join('').slice(0, 500)}; stderr=${stderr.join('').slice(0, 500)}; ${error instanceof Error ? error.message : String(error)}`); }
}
async function launchApp(executablePath, args, env, cwd, errors, pages) {
	const app = await _electron.launch({ executablePath, args, env, cwd });
	try {
		const context = app.context(); context.on('page', page => attachPageListeners(page, { errors }, pages));
		for (const page of context.pages()) attachPageListeners(page, { errors }, pages);
		const page = await app.firstWindow({ timeout: timeoutMs }); attachPageListeners(page, { errors }, pages); return { app, page };
	} catch (error) { await app.close().catch(() => undefined); throw error; }
}
async function closeApp(app) { await app.close(); }
function removeSuccessfulRunRoot(root) {
	const temporaryRoot = path.resolve(os.tmpdir()); const resolvedRoot = path.resolve(root);
	if (path.dirname(resolvedRoot) !== temporaryRoot || !path.basename(resolvedRoot).startsWith('void-b2-electron-')) throw new Error('Refusing to remove an unexpected B2 temporary root.');
	fs.rmSync(resolvedRoot, { recursive: true, force: true });
}
async function main() {
	const sourceRoot = process.cwd(); const executablePath = requireFile(path.join(sourceRoot, '.build', 'electron', 'Void.exe'), 'development Void executable'); requireFile(path.join(sourceRoot, 'out', 'main.js'), 'development entrypoint');
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'void-b2-electron-')); const workspaceA = makeDirectory(root, 'workspace-a'); const workspaceB = makeDirectory(root, 'workspace-b'); const userData = makeDirectory(root, 'user-data'); const extensions = makeDirectory(root, 'extensions'); const logs = makeDirectory(root, 'logs'); const crash = makeDirectory(root, 'crash'); const home = makeDirectory(root, 'home'); makeDirectory(makeDirectory(home, '.void-editor'), 'extensions'); writeFixtureWorkspace(workspaceA, 'fake'); writeFixtureWorkspace(workspaceB, 'fake');
	const transport = { requests: 0, pathExact: false, wireModelGpt41: false, parentAgentsMarker: false, parentConfigMarker: false, parentSpawnAgentControlTool: false, childRequests: 0, childRoleMarker: false, childReadOnlyToolsExact: false, childControlToolsAbsent: false };
	const fakeServer = await startFakeServer({ transport }); const env = launchEnvironment('fake', home, fakeServer.endpoint, sourceRoot); const argsA = launchArguments(sourceRoot, workspaceA, userData, extensions, logs, crash); const argsB = launchArguments(sourceRoot, workspaceB, userData, extensions, logs, crash); const errors = []; const pages = new WeakSet(); let first; let second; let third; let success = false; let stage = 'launch W1';
	try {
		first = await launchApp(executablePath, argsA, env, root, errors, pages); const composer = getChatComposer(first.page); const send = first.page.getByRole('button', { name: 'Send message', exact: true }); await waitVisible(composer, 'W1 composer'); await selectFixtureAgent(first.page, composer); await composer.fill(initialText); await send.click(); stage = 'wait W1 child request'; await waitWithDeadline(fakeServer.waitForChild(), 'W1 did not reach the held fake child request.');
		stage = 'queue durable W1 input'; await composer.fill(queuedText); const queue = first.page.locator('#void-chat-current-queue[aria-label="Queue message"]'); await waitVisible(queue, 'W1 Queue message'); await queue.press('Enter'); await first.page.locator('section[aria-label="Queued messages"]').getByText(queuedText, { exact: true }).waitFor({ state: 'visible', timeout: timeoutMs }); console.log('B2 stage: W1 durable queue admitted');
		stage = 'open W2 workspace-B isolation'; second = { app: first.app, page: await openWorkspaceWindow(first.app, executablePath, argsB, env, root, errors, pages, 'W2 workspace-B') }; await waitVisible(getChatComposer(second.page), 'W2 workspace-B composer'); assert.strictEqual(await second.page.locator('section[aria-label="Queued messages"]').count(), 0, 'W2 workspace-B exposed workspace-A pending input before owner closure'); assert.strictEqual(fakeServer.requestSummaries().filter(summary => summary.userText.includes(queuedText)).length, 0, 'W2 workspace-B consumed workspace-A pending input before owner closure'); console.log('B2 stage: W2 workspace-B started without A pending delivery');
		stage = 'close W1 and prove W2 cannot consume A pending input'; await first.page.close(); const historyB = second.page.locator('[role="group"][aria-label="Chat history"]'); if (await historyB.count()) { const sharedHistoryRow = historyB.locator('[data-chat-history-thread-id]').filter({ hasText: initialText }); if (await sharedHistoryRow.count()) await sharedHistoryRow.click(); } await eventually(async () => (await second.page.locator('section[aria-label="Queued messages"]').count()) === 0 && fakeServer.requestSummaries().filter(summary => summary.userText.includes(queuedText)).length === 0, 'W2 workspace-B consumed or exposed workspace-A pending input after owner closure'); assert.strictEqual(await second.page.getByRole('button', { name: 'Resume', exact: true }).count(), 0, 'W2 workspace-B exposed a Resume action for workspace-A pending input'); console.log('B2 stage: W2 workspace-B did not consume A pending input after W1 closed');
		stage = 'open W3 workspace-A'; third = { app: first.app, page: await openWorkspaceWindow(first.app, executablePath, argsA, env, root, errors, pages, 'W3 workspace-A') }; const restartHistory = third.page.locator('[role="group"][aria-label="Chat history"]'); await waitVisible(restartHistory, 'W3 workspace-A history'); const restartThread = restartHistory.locator('[data-chat-history-thread-id]').filter({ hasText: initialText }); await waitVisible(restartThread, 'W3 persisted history row'); await restartThread.click(); const restartQueued = third.page.locator('section[aria-label="Queued messages"]'); await waitVisible(restartQueued, 'W3 persisted queued message'); await waitForOwnerRelease(restartQueued.getByText('Ready to resume', { exact: true }), 'W3 dormant pending state'); const resume = restartQueued.getByRole('button', { name: 'Resume', exact: true }); assert.strictEqual(await resume.count(), 1, 'W3 did not restore exactly one Resume action'); console.log('B2 stage: W3 workspace-A restored one dormant Resume');
		await closeApp(first.app); first = undefined; second = undefined; third = undefined;
		stage = 'restart W4 workspace-A and restore durable pending state'; third = await launchApp(executablePath, argsA, env, root, errors, pages); const resumedHistory = third.page.locator('[role="group"][aria-label="Chat history"]'); await waitVisible(resumedHistory, 'W4 workspace-A history'); const resumedThread = resumedHistory.locator('[data-chat-history-thread-id]').filter({ hasText: initialText }); await waitVisible(resumedThread, 'W4 persisted history row'); await resumedThread.click(); const resumedQueued = third.page.locator('section[aria-label="Queued messages"]'); await waitVisible(resumedQueued, 'W4 persisted queued message'); assert.match(await resumedQueued.innerText(), /Ready to resume/, 'W4 did not restore dormant pending state'); const resumed = resumedQueued.getByRole('button', { name: 'Resume', exact: true }); assert.strictEqual(await resumed.count(), 1, 'W4 did not restore exactly one Resume action'); console.log('B2 stage: W4 restart retained one dormant Resume');
		stage = 'resume durable W4 input once'; await resumed.click(); await eventually(() => fakeServer.requestSummaries().filter(summary => summary.userText.includes(queuedText)).length === 1, 'W4 Resume did not send the durable queue exactly once'); await waitVisible(third.page.getByText('Void smoke fixture completed.', { exact: true }), 'W4 resumed fake response'); await third.page.locator('#void-chat-current-stop:visible').waitFor({ state: 'hidden', timeout: timeoutMs }); await resumedQueued.waitFor({ state: 'hidden', timeout: timeoutMs }); console.log('B2 stage: W4 resume delivered once and settled');
		stage = 'restart W5 and delete resumed history'; await closeApp(third.app); third = undefined; const fourth = await launchApp(executablePath, argsA, env, root, errors, pages); try { await waitVisible(getChatComposer(fourth.page), 'W5 composer'); const fourthHistory = fourth.page.locator('[role="group"][aria-label="Chat history"]'); await waitVisible(fourthHistory, 'W5 chat history'); const fourthThread = fourthHistory.locator('[data-chat-history-thread-id]').filter({ hasText: initialText }); await waitVisible(fourthThread, 'W5 resumed history row'); assert.strictEqual(fakeServer.requestSummaries().filter(summary => summary.userText.includes(queuedText)).length, 1, 'restart redelivered the already resumed queue'); const deleteButton = fourthHistory.getByRole('button', { name: /Delete chat:/ }); await waitVisible(deleteButton, 'W5 delete chat'); await deleteButton.click(); const confirmDelete = fourthHistory.getByRole('button', { name: /Confirm delete:/ }); await waitVisible(confirmDelete, 'W5 confirm delete'); await confirmDelete.click(); await fourthThread.waitFor({ state: 'hidden', timeout: timeoutMs }); } finally { await closeApp(fourth.app); }
		stage = 'restart W6 and verify deletion tombstone'; const fifth = await launchApp(executablePath, argsA, env, root, errors, pages); try { await waitVisible(getChatComposer(fifth.page), 'W6 composer'); await waitVisible(fifth.page.locator('[role="group"][aria-label="Chat history"]'), 'W6 chat history'); assert.strictEqual(await fifth.page.locator('[data-chat-history-thread-id]').filter({ hasText: initialText }).count(), 0, 'deleted thread tombstone reappeared after restart'); console.log('B2 stage: W6 preserved deletion tombstone'); } finally { await closeApp(fifth.app); }
		assert.deepStrictEqual(errors, [], `Electron reported errors: ${errors.map(error => JSON.stringify(error)).join('; ')}`); success = true; console.log('B2 actual Electron multi-window acceptance: 1 W1/W2/W3/restart/tombstone scenario passing');
	} finally {
		if (third) await closeApp(third.app).catch(() => undefined); if (first) await closeApp(first.app).catch(() => undefined); await fakeServer.close().catch(() => undefined);
		if (success) removeSuccessfulRunRoot(root); else console.error(`B2 acceptance retained diagnostics at ${root}; stage=${stage}; providerRequests=${fakeServer.requestSummaries().length}; rendererErrors=${JSON.stringify(errors)}`);
	}
}

void main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
