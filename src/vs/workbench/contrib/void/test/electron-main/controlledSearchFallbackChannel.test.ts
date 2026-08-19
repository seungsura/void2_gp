/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import {
	CONTROLLED_SEARCH_MAX_STDOUT_BYTES,
	ControlledSearchRequest,
} from '../../common/controlledSearchFallback.js';
import {
	CONTROLLED_SEARCH_POWERSHELL_ARGS,
	CONTROLLED_SEARCH_POWERSHELL_WRAPPER,
	ControlledSearchChildProcess,
	ControlledSearchFallbackChannel,
} from '../../electron-main/controlledSearchFallbackChannel.js';
import { classifyBundledRipgrepSpawnError, isBundledRipgrepMissingError } from '../../../../services/search/node/ripgrepBinaryAvailability.js';
import { deserializeSearchError, SearchErrorCode } from '../../../../services/search/common/search.js';
import { FileSearchProcessKillScope } from '../../../../services/search/node/fileSearch.js';

class FixtureChild extends EventEmitter implements ControlledSearchChildProcess {
	readonly pid = 4242;
	readonly stdin = new PassThrough();
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
}

const pathnameRequest = (root: string, overrides: Partial<ControlledSearchRequest> = {}): ControlledSearchRequest => Object.freeze({
	kind: 'pathname', roots: Object.freeze([root]), query: 'needle', isRegex: false, include: null,
	maxResults: 2, skipResults: 0, maxFileSize: 1024, ...overrides,
});

const runWithChild = (root: string, configure: (child: FixtureChild, stdin: () => string) => void, options: { timeoutMs?: number; kill?: (child: FixtureChild) => void; stat?: (target: string) => Promise<fs.Stats> } = {}) => {
	const child = new FixtureChild(); let input = ''; let kills = 0; let didSpawn!: () => void;
	const spawned = new Promise<void>(resolve => didSpawn = resolve);
	child.stdin.on('data', chunk => input += Buffer.from(chunk).toString('utf8'));
	child.stdin.once('finish', () => configure(child, () => input));
	const channel = new ControlledSearchFallbackChannel(
		(command, args, spawnOptions) => {
			assert.strictEqual(command, 'powershell.exe');
			assert.deepStrictEqual(args, CONTROLLED_SEARCH_POWERSHELL_ARGS);
			assert.strictEqual(spawnOptions.shell, false);
			didSpawn();
			return child;
		},
		() => { kills++; options.kill?.(child); },
		options.timeoutMs ?? 1_000,
		options.stat ?? fs.promises.stat,
	);
	return { child, channel, spawned, kills: () => kills };
};

suite('Void controlled Search electron-main channel', () => {
	let root = '';
	let first = '';
	let second = '';

	suiteSetup(async () => {
		root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'void-controlled-search-'));
		first = path.join(root, 'alpha.txt'); second = path.join(root, 'beta.txt');
		await fs.promises.writeFile(first, 'alpha'); await fs.promises.writeFile(second, 'beta');
	});

	suiteTeardown(async () => { if (root) await fs.promises.rm(root, { recursive: true, force: true }); });

	test('uses one fixed wrapper and passes literal, regex, roots, and options only through stdin and rg argv', async () => {
		const query = 'private [a-z]+ query'; let parsed: ControlledSearchRequest | undefined;
		const fixture = runWithChild(root, (child, stdin) => {
			parsed = JSON.parse(stdin());
			child.stdout.write(`${path.basename(first)}\n`); child.emit('close', 0);
		});
		const result = await fixture.channel.call<any>(undefined, 'search', pathnameRequest(root, { kind: 'content', query, isRegex: true, include: '*.txt' }));
		assert.strictEqual(CONTROLLED_SEARCH_POWERSHELL_ARGS.some(argument => argument.includes(query) || argument.includes(root)), false);
		assert.match(CONTROLLED_SEARCH_POWERSHELL_WRAPPER, /ConvertFrom-Json/);
		assert.match(CONTROLLED_SEARCH_POWERSHELL_WRAPPER, /Collections\.Generic\.List\[string\]/);
		assert.match(CONTROLLED_SEARCH_POWERSHELL_WRAPPER, /Get-Command -Name 'rg\.exe' -CommandType Application/);
		assert.match(CONTROLLED_SEARCH_POWERSHELL_WRAPPER, /--fixed-strings/);
		assert.strictEqual(CONTROLLED_SEARCH_POWERSHELL_WRAPPER.includes('$request.isRegex'), true);
		assert.strictEqual(CONTROLLED_SEARCH_POWERSHELL_WRAPPER.includes("$arguments.Add('--iglob')"), false);
		assert.match(CONTROLLED_SEARCH_POWERSHELL_WRAPPER, /& \$rg\.Source @arguments \| Where-Object/);
		assert.strictEqual(CONTROLLED_SEARCH_POWERSHELL_WRAPPER.includes('$candidates ='), false);
		assert.strictEqual(parsed?.query, query); assert.strictEqual(parsed?.roots[0], root); assert.strictEqual(parsed?.include, '*.txt');
		assert.deepStrictEqual(result, { ok: true, paths: [first], hasMore: false, trace: 'terminal-fallback' });
		assert.strictEqual(fixture.kills(), 0);
	});

	test('executes the fixed PowerShell wrapper with system rg for pathname AND include and content search', async function () {
		this.timeout(5_000);
		if (process.platform !== 'win32') return;
		const pathnameMatch = path.join(root, 'search-probe-alpha.txt');
		const pathnameExcluded = path.join(root, 'search-probe-alpha.ts');
		const contentMatch = path.join(root, 'content-probe.md');
		const contentExcluded = path.join(root, 'content-probe.txt');
		const privateQuery = 'PRIVATE-CONTENT-NEEDLE-7F31';
		await Promise.all([
			fs.promises.writeFile(pathnameMatch, 'pathname'),
			fs.promises.writeFile(pathnameExcluded, 'pathname'),
			fs.promises.writeFile(contentMatch, privateQuery),
			fs.promises.writeFile(contentExcluded, privateQuery),
		]);
		const channel = new ControlledSearchFallbackChannel();
		const pathnameResult = await channel.call<any>(undefined, 'search', pathnameRequest(root, { query: 's-p-a', include: '*.txt', maxResults: 10, maxFileSize: 4_096 }));
		assert.deepStrictEqual(pathnameResult, { ok: true, paths: [pathnameMatch], hasMore: false, trace: 'terminal-fallback' });
		const contentResult = await channel.call<any>(undefined, 'search', pathnameRequest(root, { kind: 'content', query: privateQuery, include: '*.md', maxResults: 10, maxFileSize: 4_096 }));
		assert.deepStrictEqual(contentResult, { ok: true, paths: [contentMatch], hasMore: false, trace: 'terminal-fallback' });
		for (const result of [pathnameResult, contentResult]) {
			assert.strictEqual(Object.keys(result).sort().join(','), 'hasMore,ok,paths,trace');
			assert.strictEqual(JSON.stringify(result).includes('powershell.exe'), false);
			assert.strictEqual(JSON.stringify(result).includes('rg.exe'), false);
			assert.strictEqual(JSON.stringify(result).includes(privateQuery), false);
		}
	});

	test('normalizes unique contained files and preserves a lookahead result without leaking diagnostics', async () => {
		const fixture = runWithChild(root, child => {
			child.stderr.write('private diagnostic');
			child.stdout.write(`${first}\n${first}\n${second}\n`); child.emit('close', 0);
		});
		const result = await fixture.channel.call<any>(undefined, 'search', pathnameRequest(root));
		assert.deepStrictEqual(result, { ok: true, paths: [first, second], hasMore: true, trace: 'terminal-fallback' });
		assert.strictEqual(JSON.stringify(result).includes('private diagnostic'), false);
	});

	test('rejects malformed requests and escaped result paths before any usable response', async () => {
		let spawns = 0;
		const channel = new ControlledSearchFallbackChannel(() => { spawns++; throw new Error('must not spawn'); });
		assert.deepStrictEqual(await channel.call<any>(undefined, 'search', { kind: 'pathname' }), { ok: false, code: 'search_request_invalid', trace: 'terminal-fallback' });
		for (const query of ['line one\nline two', 'line one\rline two']) {
			assert.deepStrictEqual(await channel.call<any>(undefined, 'search', pathnameRequest(root, { kind: 'content', query })), { ok: false, code: 'search_request_invalid', trace: 'terminal-fallback' });
		}
		assert.strictEqual(spawns, 0);
		const outside = path.join(path.dirname(root), 'outside.txt'); await fs.promises.writeFile(outside, 'outside');
		try {
			const fixture = runWithChild(root, child => { child.stdout.write(`${outside}\n`); child.emit('close', 0); });
			assert.deepStrictEqual(await fixture.channel.call<any>(undefined, 'search', pathnameRequest(root)), { ok: false, code: 'search_failed', trace: 'terminal-fallback' });
		} finally { await fs.promises.rm(outside, { force: true }); }
	});

	test('maps PowerShell or system rg absence to one bounded unavailable result', async () => {
		const synchronous = new ControlledSearchFallbackChannel(() => { throw Object.assign(new Error('secret executable path'), { code: 'ENOENT' }); });
		assert.deepStrictEqual(await synchronous.call<any>(undefined, 'search', pathnameRequest(root)), { ok: false, code: 'search_backend_unavailable', trace: 'terminal-fallback-unavailable' });
		const fixture = runWithChild(root, child => { child.stderr.write('private path'); child.emit('close', 127); });
		const result = await fixture.channel.call<any>(undefined, 'search', pathnameRequest(root));
		assert.deepStrictEqual(result, { ok: false, code: 'search_backend_unavailable', trace: 'terminal-fallback-unavailable' });
		assert.strictEqual(Object.keys(result).sort().join(','), 'code,ok,trace');
	});

	test('classifies only exact executable-unavailable codes as bundled-rg missing', () => {
		for (const code of ['ENOENT', 'EACCES', 'EPERM', 'ENOEXEC']) {
			const error = Object.assign(new Error('private executable detail'), { code });
			assert.strictEqual(isBundledRipgrepMissingError(error), true);
			assert.strictEqual(deserializeSearchError(classifyBundledRipgrepSpawnError(error)).code, SearchErrorCode.rgBinaryMissing);
		}
		for (const code of ['EINVAL', 'EIO', undefined]) assert.strictEqual(isBundledRipgrepMissingError(Object.assign(new Error('ordinary failure'), { code })), false);
	});

	test('keeps bundled filename-search cancellation isolated between request scopes', () => {
		const firstScope = new FileSearchProcessKillScope(); const secondScope = new FileSearchProcessKillScope(); let firstKills = 0; let secondKills = 0;
		const unregisterFirst = firstScope.register(() => firstKills++); const unregisterSecond = secondScope.register(() => secondKills++);
		try {
			firstScope.cancel(); assert.strictEqual(firstKills, 1); assert.strictEqual(secondKills, 0);
			secondScope.cancel(); assert.strictEqual(firstKills, 1); assert.strictEqual(secondKills, 1);
		} finally { unregisterFirst(); unregisterSecond(); }
	});

	test('cancellation and timeout settle during a slow root preflight without spawning', async () => {
		for (const mode of ['cancel', 'timeout'] as const) {
			let release!: (value: fs.Stats) => void; const stat = () => new Promise<fs.Stats>(resolve => release = resolve);
			const source = new CancellationTokenSource(); let spawns = 0;
			const channel = new ControlledSearchFallbackChannel(() => { spawns++; throw new Error('late spawn'); }, () => assert.fail('no process exists'), mode === 'timeout' ? 1 : 1_000, stat);
			const pending = channel.call<any>(undefined, 'search', pathnameRequest(root), source.token);
			if (mode === 'cancel') source.cancel();
			assert.deepStrictEqual(await pending, { ok: false, code: mode === 'cancel' ? 'search_cancelled' : 'search_timeout', trace: 'terminal-fallback' }); assert.strictEqual(spawns, 0);
			release(await fs.promises.stat(root)); source.dispose();
		}
	});

	test('IPC-owned cancellation wins a synchronous kill-close race and kills the process tree once', async () => {
		const source = new CancellationTokenSource();
		const fixture = runWithChild(root, () => { }, { kill: child => child.emit('close', 0) });
		const pending = fixture.channel.call<any>(undefined, 'search', pathnameRequest(root), source.token);
		await fixture.spawned; source.cancel();
		assert.deepStrictEqual(await pending, { ok: false, code: 'search_cancelled', trace: 'terminal-fallback' });
		assert.strictEqual(fixture.kills(), 1); source.cancel(); assert.strictEqual(fixture.kills(), 1); source.dispose();
	});

	test('timeout wins a synchronous kill-close race and settles only once', async () => {
		const rootStats = await fs.promises.stat(root);
		const fixture = runWithChild(root, () => { }, { timeoutMs: 1, kill: child => child.emit('close', 0), stat: async () => rootStats });
		const pending = fixture.channel.call<any>(undefined, 'search', pathnameRequest(root));
		await fixture.spawned;
		assert.deepStrictEqual(await pending, { ok: false, code: 'search_timeout', trace: 'terminal-fallback' });
		assert.strictEqual(fixture.kills(), 1);
	});

	test('stdout cap wins a synchronous kill-close race while stderr stays internal', async () => {
		const fixture = runWithChild(root, child => {
			child.stderr.write(Buffer.alloc(16 * 1024, 120));
			child.stdout.write(Buffer.alloc(CONTROLLED_SEARCH_MAX_STDOUT_BYTES + 1, 120));
		}, { kill: child => child.emit('close', 0) });
		assert.deepStrictEqual(await fixture.channel.call<any>(undefined, 'search', pathnameRequest(root)), { ok: false, code: 'search_output_limit', trace: 'terminal-fallback' });
		assert.strictEqual(fixture.kills(), 1);
	});

	test('stream and process errors settle once without surfacing raw error text', async () => {
		const stdout = runWithChild(root, child => child.stdout.emit('error', new Error('raw stdout')), { kill: child => child.emit('close', 0) });
		assert.deepStrictEqual(await stdout.channel.call<any>(undefined, 'search', pathnameRequest(root)), { ok: false, code: 'search_failed', trace: 'terminal-fallback' });
		assert.strictEqual(stdout.kills(), 1);
		const processError = runWithChild(root, child => child.emit('error', Object.assign(new Error('raw spawn'), { code: 'ENOENT' })));
		assert.deepStrictEqual(await processError.channel.call<any>(undefined, 'search', pathnameRequest(root)), { ok: false, code: 'search_backend_unavailable', trace: 'terminal-fallback-unavailable' });
	});

	test('stdin EPIPE settles unavailable and kills once instead of becoming an unhandled error', async () => {
		const fixture = runWithChild(root, child => child.stdin.emit('error', Object.assign(new Error('private EPIPE'), { code: 'EPIPE' })), { kill: child => child.emit('close', 0) });
		assert.deepStrictEqual(await fixture.channel.call<any>(undefined, 'search', pathnameRequest(root)), { ok: false, code: 'search_backend_unavailable', trace: 'terminal-fallback-unavailable' });
		assert.strictEqual(fixture.kills(), 1);
	});

	test('a synchronous stdin write failure settles before one process-tree kill', async () => {
		const fixture = runWithChild(root, () => { }, { kill: child => child.emit('close', 0) });
		(fixture.child.stdin as any).end = () => { throw new Error('private synchronous write failure'); };
		assert.deepStrictEqual(await fixture.channel.call<any>(undefined, 'search', pathnameRequest(root)), { ok: false, code: 'search_backend_unavailable', trace: 'terminal-fallback-unavailable' });
		assert.strictEqual(fixture.kills(), 1);
	});

	test('cancellation during post-close path validation never kills a closed or reused PID', async () => {
		const source = new CancellationTokenSource(); let statCalls = 0; let validationStarted!: () => void; let releaseValidation!: () => void;
		const started = new Promise<void>(resolve => validationStarted = resolve); const gate = new Promise<void>(resolve => releaseValidation = resolve);
		const fixture = runWithChild(root, child => { child.stdout.write(`${first}\n`); child.emit('close', 0); }, { stat: async target => { statCalls++; if (statCalls === 2) { validationStarted(); await gate; } return fs.promises.stat(target); } });
		const pending = fixture.channel.call<any>(undefined, 'search', pathnameRequest(root), source.token); await started; source.cancel();
		assert.deepStrictEqual(await pending, { ok: false, code: 'search_cancelled', trace: 'terminal-fallback' }); assert.strictEqual(fixture.kills(), 0);
		releaseValidation(); source.dispose();
	});
});
