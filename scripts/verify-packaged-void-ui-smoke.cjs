/*---------------------------------------------------------------------------------------------
 *  Packaged Void UI smoke: isolated, local-only, and intentionally non-sending.
 *--------------------------------------------------------------------------------------------*/
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const { _electron } = require('@playwright/test');

const FAKE_KEY = 'void-ui-smoke-fake-key';
const LOOPBACK_ENDPOINT = 'http://127.0.0.1:9/v1';
const timeoutMs = 45_000;
const quiescenceMs = 500;
const expectedAssertions = [
	'onboarding-openai-compatible-loopback',
	'chat-empty-history-send-disabled',
	'chat-draft-send-enabled-without-send',
];
let activeEvidence;
let evidencePath;
let evidenceWritten = false;

function argument(name) { const index = process.argv.indexOf(name); if (index < 0 || index + 1 >= process.argv.length) throw new Error(`Missing required argument: ${name}`); return process.argv[index + 1]; }
function sanitize(value) { return String(value).replaceAll(FAKE_KEY, '[redacted]').replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]').replace(/[\r\n]+/g, ' ').slice(0, 500); }
function assertRegularPath(value, label) { const resolved = path.resolve(value); if (fs.lstatSync(resolved).isSymbolicLink()) throw new Error(`${label} must not be a reparse point: ${resolved}`); return resolved; }
function assertContained(root, value, label) { const resolvedRoot = path.resolve(root); const resolvedValue = path.resolve(value); const relative = path.relative(resolvedRoot, resolvedValue); if (relative === '' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`${label} escapes the isolated smoke root`); return resolvedValue; }
function makeDirectory(root, leaf) { const target = assertContained(root, path.join(root, leaf), leaf); fs.mkdirSync(target, { recursive: true }); return assertRegularPath(target, leaf); }
function sleep(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }

function writeEvidence(evidence) {
	if (evidenceWritten || !evidencePath) return;
	const temporary = `${evidencePath}.tmp-${process.pid}`;
	try {
		fs.writeFileSync(temporary, JSON.stringify(evidence), { encoding: 'utf8', flag: 'wx' });
		fs.renameSync(temporary, evidencePath);
		evidenceWritten = true;
	} catch (error) {
		try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { }
		console.error(`Unable to write packaged UI evidence: ${sanitize(error)}`);
		process.exitCode = 1;
	}
}

function recordMainStderrLine(evidence, line) {
	const message = sanitize(line).trim();
	if (message.length === 0) return;
	if (evidence.mainStderr.length < 20) evidence.mainStderr.push(message);
	const dep0168Diagnostic = /^\(node:\d+\) \[DEP0168\] DeprecationWarning: Uncaught N-API callback exception detected, please run node with option --force-node-api-uncaught-exceptions-policy=true to handle those exceptions properly\.(?: \(Use `Void --trace-deprecation \.\.\.` to show where the warning was created\))?$/;
	const shutdownFileWatcherDiagnostic = /^\[main \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[UtilityProcess id: \d+, type: fileWatcher, pid: <none>\]: unable to kill the process$/;
	const shutdownDisposableDiagnostic = /^Error: Trying to add a disposable to a DisposableStore that has already been disposed of\. The added object will be leaked!(?:\s+at\s+.+)?$/;
	if (dep0168Diagnostic.test(message)) return;
	if (evidence.close.attempted && (shutdownFileWatcherDiagnostic.test(message) || shutdownDisposableDiagnostic.test(message))) return;
	if (/\b(?:ReferenceError|TypeError|SyntaxError|Unhandled|uncaught|fatal|ERR_[A-Z_]+)\b|\bError:|\bunable to kill\b/i.test(message)) {
		evidence.errors.push({ source: 'main-stderr', message });
	}
}

function createMainStderrRecorder(evidence) {
	const maxPendingCharacters = 16_384;
	const decoder = new StringDecoder('utf8');
	let pending = '';
	let discardingOversizedLine = false;
	const acceptText = value => {
		let text = value;
		if (discardingOversizedLine) {
			const newline = text.indexOf('\n');
			if (newline < 0) return;
			discardingOversizedLine = false;
			text = text.slice(newline + 1);
		}
		pending += text;
		let newline = pending.indexOf('\n');
		while (newline >= 0) {
			const line = pending.slice(0, newline).replace(/\r$/, '');
			pending = pending.slice(newline + 1);
			recordMainStderrLine(evidence, line);
			newline = pending.indexOf('\n');
		}
		if (pending.length > maxPendingCharacters) {
			const diagnostic = `${sanitize(pending.slice(0, maxPendingCharacters))} [stderr line exceeded ${maxPendingCharacters} characters]`;
			if (evidence.mainStderr.length < 20) evidence.mainStderr.push(diagnostic);
			evidence.errors.push({ source: 'main-stderr', message: diagnostic });
			pending = '';
			discardingOversizedLine = true;
		}
	};
	const accept = chunk => acceptText(typeof chunk === 'string' ? chunk : decoder.write(chunk));
	const flush = () => {
		acceptText(decoder.end());
		if (!discardingOversizedLine && pending.length > 0) recordMainStderrLine(evidence, pending.replace(/\r$/, ''));
		pending = '';
		discardingOversizedLine = false;
	};
	return { accept, flush };
}

function waitForMainProcessOutput(child) {
	const processClosed = child.exitCode !== null
		? Promise.resolve()
		: new Promise(resolve => child.once('close', resolve));
	const stderrEnded = !child.stderr || child.stderr.readableEnded
		? Promise.resolve()
		: new Promise(resolve => { child.stderr.once('end', resolve); child.stderr.once('close', resolve); });
	return Promise.all([processClosed, stderrEnded]).then(() => undefined);
}

function attachPageListeners(page, evidence, attachedPages) {
	if (attachedPages.has(page)) return;
	attachedPages.add(page);
	page.on('pageerror', error => evidence.errors.push({ source: 'renderer-pageerror', message: sanitize(error) }));
	page.on('console', message => { if (message.type() === 'error') evidence.errors.push({ source: 'renderer-console', message: sanitize(message.text()) }); });
}

async function main() {
	const evidence = { kind: 'void-packaged-ui-smoke', pass: false, assertions: [], errors: [], mainStderr: [], close: { attempted: false, completed: false, error: null }, launch: { isolated: true, provider: 'openAICompatible', endpoint: LOOPBACK_ENDPOINT, network: 'loopback fake endpoint only', credentials: 'fake key redacted' } };
	activeEvidence = evidence;
	let electronApp;
	let mainProcessOutputSettled = Promise.resolve();
	const mainStderrRecorder = createMainStderrRecorder(evidence);
	try {
		const smokeRoot = assertRegularPath(argument('--smoke-root'), 'smoke root');
		evidencePath = assertContained(smokeRoot, argument('--evidence'), 'evidence path');
		if (fs.existsSync(evidencePath)) throw new Error('Evidence path must be absent before launch.');
		const productRoot = assertRegularPath(argument('--product-root'), 'extracted product root');
		assertContained(smokeRoot, productRoot, 'extracted product root');
		const exe = assertRegularPath(argument('--exe'), 'Void executable');
		if (path.dirname(exe) !== productRoot) throw new Error('Void executable is not the exact immediate child of the extracted product root.');
		const workspace = makeDirectory(smokeRoot, 'ui-workspace'); const userData = makeDirectory(smokeRoot, 'ui-user-data'); const extensions = makeDirectory(smokeRoot, 'ui-extensions'); const logs = makeDirectory(smokeRoot, 'ui-logs'); const crash = makeDirectory(smokeRoot, 'ui-crash');
		fs.writeFileSync(assertContained(workspace, path.join(workspace, 'README.md'), 'workspace fixture'), '# Void UI smoke\n', 'utf8');
		evidence.launch.paths = { product: 'stage-local-extracted-portable-root', workspace: 'isolated', userData: 'isolated', extensions: 'isolated', logs: 'isolated', crash: 'isolated' };
		electronApp = await _electron.launch({ executablePath: exe, args: [workspace, `--user-data-dir=${userData}`, `--extensions-dir=${extensions}`, `--logsPath=${logs}`, `--crash-reporter-directory=${crash}`, '--disable-extensions', '--disable-gpu', '--disable-background-networking', '--disable-component-update', '--no-proxy-server', '--disable-telemetry', '--disable-workspace-trust', '--disable-updates', '--use-inmemory-secretstorage', '--skip-release-notes', '--skip-welcome', '--no-cached-data', '--enable-smoke-test-driver'] });
		const attachedPages = new WeakSet();
		const context = electronApp.context();
		context.on('page', page => attachPageListeners(page, evidence, attachedPages));
		for (const page of context.pages()) attachPageListeners(page, evidence, attachedPages);
		const child = electronApp.process();
		if (child.stderr) child.stderr.on('data', mainStderrRecorder.accept);
		mainProcessOutputSettled = waitForMainProcessOutput(child);
		const page = await electronApp.firstWindow({ timeout: timeoutMs });
		attachPageListeners(page, evidence, attachedPages);
		const getStarted = page.getByRole('button', { name: 'Get Started', exact: true });
		await getStarted.waitFor({ state: 'visible', timeout: timeoutMs });
		const overlayFromGetStarted = getStarted.locator('xpath=ancestor::div[contains(@class,"fixed") and contains(@class,"pointer-events-auto")][1]');
		await overlayFromGetStarted.waitFor({ state: 'visible', timeout: timeoutMs });
		const overlayHandle = await overlayFromGetStarted.elementHandle();
		if (!overlayHandle) throw new Error('Onboarding overlay was unavailable before setup.');
		const overlay = page.locator('xpath=//div[contains(@class,"fixed") and contains(@class,"pointer-events-auto")]');
		if (await overlay.count() !== 1) throw new Error('Expected exactly one fixed onboarding overlay.');
		await getStarted.click();
		await overlay.getByRole('button', { name: 'Cloud/Other', exact: true }).click();
		await overlay.getByPlaceholder('baseURL (https://my-website.com/v1)', { exact: true }).fill(LOOPBACK_ENDPOINT);
		await overlay.getByPlaceholder('API Key (sk-key...)', { exact: true }).fill(FAKE_KEY);
		await overlay.getByPlaceholder('Custom Headers ({ "X-Request-Id": "..." })', { exact: true }).fill('{}');
		await overlay.getByRole('button', { name: 'Add a model', exact: true }).click();
		const modelForm = overlay.locator('form').filter({ has: page.getByPlaceholder('Model Name', { exact: true }) });
		await modelForm.getByRole('button').first().click();
		await overlay.getByText('OpenAI-Compatible', { exact: true }).last().click();
		await modelForm.getByPlaceholder('Model Name', { exact: true }).fill('gpt-4.1');
		await modelForm.getByRole('button', { name: 'Add', exact: true }).click();
		await overlay.getByText('Added', { exact: true }).waitFor({ state: 'visible', timeout: timeoutMs });
		await overlay.getByText('gpt-4.1', { exact: true }).waitFor({ state: 'visible', timeout: timeoutMs });
		await overlay.getByRole('button', { name: 'Next', exact: true }).click();
		const enterVoid = overlay.getByRole('button', { name: 'Enter the Void', exact: true });
		await enterVoid.waitFor({ state: 'visible', timeout: timeoutMs });
		await enterVoid.click();
		await page.waitForFunction(element => getComputedStyle(element).pointerEvents === 'none', overlayHandle, { timeout: timeoutMs });
		evidence.assertions.push(expectedAssertions[0]);
		const chat = page.getByRole('textbox', { name: 'Chat message' }); const send = page.getByRole('button', { name: 'Send message' });
		await chat.waitFor({ state: 'visible', timeout: timeoutMs }); await page.getByRole('group', { name: 'Chat history' }).waitFor({ state: 'visible', timeout: timeoutMs }); await page.getByText('No previous chats yet.', { exact: true }).waitFor({ state: 'visible', timeout: timeoutMs });
		if (!(await send.isDisabled())) throw new Error('Empty Chat Send control was enabled.'); evidence.assertions.push(expectedAssertions[1]);
		await chat.fill('Void packaged UI smoke draft'); if (await send.isDisabled()) throw new Error('Draft Chat Send control remained disabled after onboarding.'); evidence.assertions.push(expectedAssertions[2]);
		await sleep(quiescenceMs);
	} catch (error) {
		evidence.errors.push({ source: 'assertion', message: sanitize(error) });
	} finally {
		if (electronApp) { evidence.close.attempted = true; try { await electronApp.close(); evidence.close.completed = true; } catch (error) { evidence.close.error = sanitize(error); } }
		const outputSettled = await Promise.race([mainProcessOutputSettled.then(() => true), sleep(5_000).then(() => false)]);
		if (!outputSettled) evidence.errors.push({ source: 'main-stderr', message: 'Main process or stderr did not settle within 5000ms after close.' });
		mainStderrRecorder.flush();
		evidence.pass = evidence.assertions.length === expectedAssertions.length && expectedAssertions.every((value, index) => evidence.assertions[index] === value) && evidence.errors.length === 0 && evidence.close.attempted && evidence.close.completed;
		writeEvidence(evidence);
	}
	if (!evidence.pass) process.exitCode = 1;
}

process.on('unhandledRejection', error => { if (!activeEvidence) return; activeEvidence.pass = false; activeEvidence.errors.push({ source: 'unhandled-rejection', message: sanitize(error) }); writeEvidence(activeEvidence); process.exitCode = 1; });
void main().catch(error => { const evidence = activeEvidence ?? { kind: 'void-packaged-ui-smoke', pass: false, assertions: [], errors: [], mainStderr: [], close: { attempted: false, completed: false, error: null }, launch: { isolated: true, provider: 'openAICompatible', endpoint: LOOPBACK_ENDPOINT, network: 'loopback fake endpoint only', credentials: 'fake key redacted' } }; evidence.pass = false; evidence.errors.push({ source: 'helper', message: sanitize(error) }); writeEvidence(evidence); process.exitCode = 1; });
