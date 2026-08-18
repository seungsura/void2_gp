/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as path from '../../../../base/common/path.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import {
	CONTROLLED_SEARCH_MAX_STDERR_BYTES,
	CONTROLLED_SEARCH_MAX_STDOUT_BYTES,
	CONTROLLED_SEARCH_TIMEOUT_MS,
	ControlledSearchRequest,
	ControlledSearchResult,
	controlledSearchFailure,
	validateControlledSearchRequest,
} from '../common/controlledSearchFallback.js';

export const CONTROLLED_SEARCH_POWERSHELL_WRAPPER = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
try {
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $rg = Get-Command -Name 'rg.exe' -CommandType Application -ErrorAction Stop | Select-Object -First 1
    if ($null -eq $rg) { exit 127 }
    $arguments = [Collections.Generic.List[string]]::new()
    if ($request.kind -eq 'pathname') {
        foreach ($value in @('--files', '--hidden', '--case-sensitive', '--no-require-git', '--no-config', '--no-messages')) { $arguments.Add($value) }
		if ($null -ne $request.maxFileSize) { $arguments.Add('--max-filesize'); $arguments.Add([string]$request.maxFileSize) }
    } else {
		foreach ($value in @('--files-with-matches', '--hidden', '--no-require-git', '--no-config', '--no-messages', '--color', 'never', '--ignore-case')) { $arguments.Add($value) }
        if (-not [bool]$request.isRegex) { $arguments.Add('--fixed-strings') }
		if ($null -ne $request.maxFileSize) { $arguments.Add('--max-filesize'); $arguments.Add([string]$request.maxFileSize) }
    }
    if ($null -ne $request.include) { $arguments.Add('-g'); $arguments.Add([string]$request.include) }
    $arguments.Add('--')
    if ($request.kind -eq 'content') { $arguments.Add([string]$request.query) }
    foreach ($root in $request.roots) { $arguments.Add([string]$root) }
    $emitted = 0
	$queryCharacters = ([string]$request.query).ToCharArray()
	& $rg.Source @arguments | Where-Object {
		if ($request.kind -eq 'pathname' -and $queryCharacters.Length -gt 0) {
			$candidate = [string]$_
			$offset = 0
			foreach ($queryCharacter in $queryCharacters) {
				$matchIndex = $candidate.IndexOf([string]$queryCharacter, $offset, [StringComparison]::OrdinalIgnoreCase)
				if ($matchIndex -lt 0) { return $false }
				$offset = $matchIndex + 1
			}
			return $true
		}
		return $true
	} | Select-Object -Skip ([int]$request.skipResults) -First ([int]$request.maxResults) | ForEach-Object {
        $emitted++
        [Console]::Out.WriteLine([string]$_)
    }
    $exitCode = $LASTEXITCODE
    if ($exitCode -eq 0 -or $exitCode -eq 1 -or $emitted -ge [int]$request.maxResults) { exit 0 }
    exit 2
} catch [System.Management.Automation.CommandNotFoundException] {
    exit 127
} catch {
    exit 126
}
`.trim();

export const CONTROLLED_SEARCH_POWERSHELL_ARGS = Object.freeze([
	'-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
	'-EncodedCommand', Buffer.from(CONTROLLED_SEARCH_POWERSHELL_WRAPPER, 'utf16le').toString('base64'),
]);

export interface ControlledSearchChildProcess {
	readonly pid?: number;
	readonly stdin: NodeJS.WritableStream;
	readonly stdout: NodeJS.ReadableStream;
	readonly stderr: NodeJS.ReadableStream;
	on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): this;
	on(event: 'close', listener: (code: number | null) => void): this;
}

export type ControlledSearchSpawn = (command: string, args: readonly string[], options: childProcess.SpawnOptions) => ControlledSearchChildProcess;
export type ControlledSearchKillTree = (pid: number) => void;
export type ControlledSearchStat = (target: string) => Promise<fs.Stats>;

const defaultSpawn: ControlledSearchSpawn = (command, args, options) => childProcess.spawn(command, [...args], options) as ControlledSearchChildProcess;

export const killControlledSearchProcessTree: ControlledSearchKillTree = pid => {
	if (!Number.isSafeInteger(pid) || pid <= 0) return;
	if (process.platform === 'win32') {
		const killer = childProcess.spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
		killer.on('error', () => { /* the original PID may already have been reused */ });
		killer.unref();
		return;
	}
	try { process.kill(pid, 'SIGKILL'); } catch { /* the process already settled */ }
};

const isContainedPath = (candidate: string, root: string) => {
	const relative = path.relative(root, candidate);
	return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

const validateRoots = async (request: ControlledSearchRequest, statPath: ControlledSearchStat): Promise<readonly string[] | undefined> => {
	const roots: string[] = [];
	for (const value of request.roots) {
		if (!path.isAbsolute(value)) return undefined;
		const root = path.normalize(path.resolve(value));
		let stat: fs.Stats;
		try { stat = await statPath(root); } catch { return undefined; }
		if (!stat.isDirectory()) return undefined;
		roots.push(root);
	}
	return Object.freeze(roots);
};

const validateResultPaths = async (stdout: Buffer, roots: readonly string[], statPath: ControlledSearchStat, shouldContinue: () => boolean): Promise<readonly string[] | undefined> => {
	const seen = new Set<string>();
	const paths: string[] = [];
	for (const rawLine of stdout.toString('utf8').split(/\r?\n/)) {
		if (!shouldContinue()) return undefined;
		if (!rawLine) continue;
		const candidate = path.normalize(path.isAbsolute(rawLine) ? path.resolve(rawLine) : roots.length === 1 ? path.resolve(roots[0], rawLine) : '');
		if (!candidate || !roots.some(root => isContainedPath(candidate, root))) return undefined;
		let stat: fs.Stats;
		try { stat = await statPath(candidate); } catch { return undefined; }
		if (!shouldContinue()) return undefined;
		if (!stat.isFile() || seen.has(candidate)) continue;
		seen.add(candidate);
		paths.push(candidate);
	}
	for (const root of roots) {
		if (!shouldContinue()) return undefined;
		try { if (!(await statPath(root)).isDirectory()) return undefined; } catch { return undefined; }
		if (!shouldContinue()) return undefined;
	}
	return Object.freeze(paths);
};

export class ControlledSearchFallbackChannel implements IServerChannel {
	constructor(
		private readonly spawnProcess: ControlledSearchSpawn = defaultSpawn,
		private readonly killTree: ControlledSearchKillTree = killControlledSearchProcessTree,
		private readonly timeoutMs = CONTROLLED_SEARCH_TIMEOUT_MS,
		private readonly statPath: ControlledSearchStat = fs.promises.stat,
	) { }

	listen<T>(_ctx: unknown, _event: string): Event<T> { return Event.None; }

	async call<T>(_ctx: unknown, command: string, rawRequest?: unknown, cancellationToken = CancellationToken.None): Promise<T> {
		if (command !== 'search') return controlledSearchFailure('search_request_invalid') as T;
		const request = validateControlledSearchRequest(rawRequest);
		if (!request) return controlledSearchFailure('search_request_invalid') as T;
		if (cancellationToken.isCancellationRequested) return controlledSearchFailure('search_cancelled') as T;
		return await new Promise<ControlledSearchResult>(resolve => {
			let child: ControlledSearchChildProcess | undefined;
			let settled = false;
			let killed = false;
			let processClosed = false;
			let stdoutBytes = 0;
			let stderrBytes = 0;
			const stdout: Buffer[] = [];
			let timer: ReturnType<typeof setTimeout> | undefined;
			let cancellationListener: { dispose(): void } = { dispose() { } };
			const finish = (result: ControlledSearchResult) => {
				if (settled) return;
				settled = true;
				if (timer !== undefined) clearTimeout(timer);
				cancellationListener.dispose();
				resolve(result);
			};
			const killOnce = () => {
				if (killed || processClosed || !child) return;
				killed = true;
				if (typeof child.pid === 'number') { try { this.killTree(child.pid); } catch { /* cancellation still settles */ } }
			};
			const failAndKill = (code: Parameters<typeof controlledSearchFailure>[0]) => {
				finish(controlledSearchFailure(code));
				killOnce();
			};
			cancellationListener = cancellationToken.onCancellationRequested(() => {
				finish(controlledSearchFailure('search_cancelled'));
				killOnce();
			});
			timer = setTimeout(() => {
				finish(controlledSearchFailure('search_timeout'));
				killOnce();
			}, Math.max(1, Math.min(this.timeoutMs, CONTROLLED_SEARCH_TIMEOUT_MS)));
			if (settled) { cancellationListener.dispose(); clearTimeout(timer); }
			void (async () => {
				const roots = await validateRoots(request, this.statPath);
				if (settled) return;
				if (!roots) { finish(controlledSearchFailure('search_request_invalid')); return; }
				if (cancellationToken.isCancellationRequested) { finish(controlledSearchFailure('search_cancelled')); return; }
				const normalizedRequest: ControlledSearchRequest = Object.freeze({ ...request, roots });
				try {
					child = this.spawnProcess('powershell.exe', CONTROLLED_SEARCH_POWERSHELL_ARGS, { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
				} catch {
					finish(controlledSearchFailure('search_backend_unavailable'));
					return;
				}
				if (settled) { killOnce(); return; }
				child.stdout.on('data', data => {
					if (settled) return;
					const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
					stdoutBytes += buffer.byteLength;
					if (stdoutBytes > CONTROLLED_SEARCH_MAX_STDOUT_BYTES) { failAndKill('search_output_limit'); return; }
					stdout.push(buffer);
				});
				child.stderr.on('data', data => {
					if (settled || stderrBytes >= CONTROLLED_SEARCH_MAX_STDERR_BYTES) return;
					const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
					stderrBytes = Math.min(CONTROLLED_SEARCH_MAX_STDERR_BYTES, stderrBytes + buffer.byteLength);
				});
				child.stdin.on('error', () => failAndKill('search_backend_unavailable'));
				child.stdout.on('error', () => failAndKill('search_failed'));
				child.stderr.on('error', () => { /* stderr is bounded internal diagnostics only */ });
				child.on('error', () => { processClosed = true; finish(controlledSearchFailure('search_backend_unavailable')); });
				child.on('close', code => {
					processClosed = true;
					if (settled) return;
					if (code === 127 || code === 126 || code === null) { finish(controlledSearchFailure('search_backend_unavailable')); return; }
					if (code !== 0) { finish(controlledSearchFailure('search_failed')); return; }
					void validateResultPaths(Buffer.concat(stdout), roots, this.statPath, () => !settled).then(paths => {
						if (!paths) { finish(controlledSearchFailure('search_failed')); return; }
						finish(Object.freeze({ ok: true, paths, hasMore: paths.length >= request.maxResults, trace: 'terminal-fallback' }));
					}, () => finish(controlledSearchFailure('search_failed')));
				});
				try { child.stdin.end(JSON.stringify(normalizedRequest)); } catch { failAndKill('search_backend_unavailable'); }
			})().catch(() => failAndKill('search_request_invalid'));
		}) as T;
	}
}
