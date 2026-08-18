/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { CONTROLLED_SEARCH_MAX_STDOUT_BYTES, ControlledSearchKind, ControlledSearchRequest, controlledSearchFailure } from '../common/controlledSearchFallback.js';
import { ControlledSearchFallbackChannel } from './controlledSearchFallbackChannel.js';
import { isBundledRipgrepMissingError } from '../../../services/search/node/ripgrepBinaryAvailability.js';

type ProbeOptions = Readonly<{ root: string; query: string; kind: ControlledSearchKind; bundledRipgrep: string }>;

const readOptions = (): ProbeOptions | undefined => {
	const values = new Map<string, string>();
	for (let index = 2; index < process.argv.length; index += 2) {
		const name = process.argv[index]; const value = process.argv[index + 1];
		if (!name?.startsWith('--') || value === undefined || values.has(name)) return undefined;
		values.set(name, value);
	}
	if (values.size !== 4) return undefined;
	const root = values.get('--root'); const query = values.get('--query'); const kind = values.get('--kind'); const bundledRipgrep = values.get('--bundled-rg');
	if (!root || !query || (kind !== 'pathname' && kind !== 'content') || !bundledRipgrep) return undefined;
	const normalizedRoot = path.resolve(root); const normalizedExecutable = path.resolve(bundledRipgrep);
	const requiredSuffix = path.normalize(path.join('resources', 'app', 'node_modules', '@vscode', 'ripgrep', 'bin', 'rg.exe'));
	if (!path.isAbsolute(root) || !path.isAbsolute(bundledRipgrep) || !normalizedExecutable.endsWith(requiredSuffix)) return undefined;
	return Object.freeze({ root: normalizedRoot, query, kind, bundledRipgrep: normalizedExecutable });
};

const parsePaths = (text: string, root: string): readonly string[] | undefined => {
	const seen = new Set<string>(); const results: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		if (!line) continue;
		const candidate = path.normalize(path.isAbsolute(line) ? path.resolve(line) : path.resolve(root, line));
		const relative = path.relative(root, candidate);
		if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
		try { if (!fs.statSync(candidate).isFile()) return undefined; } catch { return undefined; }
		if (!seen.has(candidate)) { seen.add(candidate); results.push(candidate); }
	}
	return Object.freeze(results);
};

const runBundled = (options: ProbeOptions): readonly string[] | 'missing' | undefined => {
	try { fs.accessSync(options.bundledRipgrep, fs.constants.F_OK | fs.constants.X_OK); } catch (error) { return isBundledRipgrepMissingError(error) ? 'missing' : undefined; }
	const args = options.kind === 'pathname'
		? ['--files', '--hidden', '--case-sensitive', '--no-require-git', '--no-config', '--no-messages', '--iglob', `*${options.query}*`, '--', options.root]
		: ['--files-with-matches', '--hidden', '--no-require-git', '--no-config', '--no-messages', '--color', 'never', '--ignore-case', '--fixed-strings', '--', options.query, options.root];
	const result = childProcess.spawnSync(options.bundledRipgrep, args, { windowsHide: true, shell: false, encoding: 'utf8', maxBuffer: CONTROLLED_SEARCH_MAX_STDOUT_BYTES, timeout: 10_000 });
	if (result.error) return isBundledRipgrepMissingError(result.error) ? 'missing' : undefined;
	if (result.status !== 0 && result.status !== 1) return undefined;
	return parsePaths(typeof result.stdout === 'string' ? result.stdout : result.stdout.toString('utf8'), options.root);
};

const main = async () => {
	const options = readOptions();
	if (!options) { process.stdout.write(JSON.stringify(controlledSearchFailure('search_request_invalid'))); process.exitCode = 2; return; }
	const bundled = runBundled(options);
	if (bundled !== 'missing') {
		if (!bundled) { process.stdout.write(JSON.stringify({ ok: false, code: 'search_failed', trace: 'bundled-rg' })); process.exitCode = 2; return; }
		process.stdout.write(JSON.stringify({ ok: true, paths: bundled, hasMore: false, trace: 'bundled-rg' })); return;
	}
	const request: ControlledSearchRequest = Object.freeze({ kind: options.kind, roots: Object.freeze([options.root]), query: options.query, isRegex: false, include: null, maxResults: 11, skipResults: 0, maxFileSize: 1024 * 1024 });
	const result = await new ControlledSearchFallbackChannel().call<any>(undefined, 'search', request, CancellationToken.None);
	process.stdout.write(JSON.stringify(result));
	if (!result.ok) process.exitCode = 2;
};

void main().catch(() => {
	process.stdout.write(JSON.stringify({ ok: false, code: 'search_failed', trace: 'terminal-fallback' }));
	process.exitCode = 2;
});
