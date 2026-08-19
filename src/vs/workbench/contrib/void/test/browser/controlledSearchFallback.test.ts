/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { URI } from '../../../../../base/common/uri.js';
import { SearchError, SearchErrorCode } from '../../../../services/search/common/search.js';
import { ControlledSearchFallbackService } from '../../browser/controlledSearchFallbackService.js';
import { ToolsService } from '../../browser/toolsService.js';
import { ControlledSearchError, ControlledSearchRequest, ControlledSearchResult } from '../../common/controlledSearchFallback.js';

const root = URI.file('/workspace');
const first = URI.file('/workspace/alpha.txt');

const missing = () => new SearchError('bundled rg missing', SearchErrorCode.rgBinaryMissing);

const toolsFixture = (options: {
	root?: URI;
	fileSearch?: (query: unknown, token: CancellationToken) => Promise<any>;
	textSearch?: (query: unknown, token: CancellationToken) => Promise<any>;
	fallback?: (request: ControlledSearchRequest, token: CancellationToken) => Promise<ControlledSearchResult>;
	resolve?: (uri: URI) => Promise<any>;
} = {}) => {
	const workspaceRoot = options.root ?? root; const fallbackRequests: ControlledSearchRequest[] = []; const fallbackTokens: CancellationToken[] = [];
	const fallback = {
		search: async (request: ControlledSearchRequest, token: CancellationToken) => {
			fallbackRequests.push(request); fallbackTokens.push(token);
			return options.fallback?.(request, token) ?? { ok: true, paths: [first.fsPath], hasMore: false, trace: 'terminal-fallback' };
		},
	};
	const fileService = {
		resolve: options.resolve ?? (async (uri: URI) => ({ resource: uri, isDirectory: uri.toString() === workspaceRoot.toString(), isSymbolicLink: false })),
		stat: async (uri: URI) => ({ resource: uri, isDirectory: false, isSymbolicLink: false, size: 1 }),
	};
	const model = { getLineCount: () => 1, getLineContent: () => 'in-process needle', getValueLength: () => 17, getVersionId: () => 1 };
	const service = new ToolsService(
		fileService as never,
		{ getWorkspace: () => ({ folders: [{ uri: workspaceRoot }] }) } as never,
		{
			fileSearch: options.fileSearch ?? (async () => ({ results: [{ resource: first }], messages: [] })),
			textSearch: options.textSearch ?? (async () => ({ results: [{ resource: first }], messages: [] })),
		} as never,
		fallback as never,
		{ createInstance: () => ({ file: (_roots: unknown, query: unknown) => query, text: (pattern: unknown, _roots: unknown, options: unknown) => ({ pattern, options }) }) } as never,
		{ initializeModel: async () => { }, getModelSafe: async () => ({ model }), getModel: () => ({ model }) } as never,
		{ state: { globalSettings: { readFileLimits: {} } } } as never,
		{} as never, {} as never, {} as never, {} as never, { read: () => [] } as never,
	);
	return { service, fallbackRequests, fallbackTokens };
};

const pathname = async (service: ToolsService, pageNumber = 1) => {
	const call = await service.callTool.search_pathnames_only({ query: 'alpha', includePattern: null, pageNumber });
	return { call, result: await call.result };
};

const content = async (service: ToolsService, isRegex = false) => {
	const call = await service.callTool.search_for_files({ query: 'alpha', isRegex, searchInFolder: null, pageNumber: 1 });
	return { call, result: await call.result };
};

suite('Void controlled Search browser facade and ToolsService', () => {
	test('facade validates requests/results and forwards the exact IPC cancellation token', async () => {
		let capturedToken: CancellationToken | undefined; let calls = 0; let response: unknown = { ok: true, paths: [first.fsPath], hasMore: false, trace: 'terminal-fallback' };
		const channel = { call: async (_command: string, request: ControlledSearchRequest, token: CancellationToken) => { calls++; capturedToken = token; return response; } };
		const facade = new ControlledSearchFallbackService({ getChannel: () => channel } as never);
		const source = new CancellationTokenSource(); const request: ControlledSearchRequest = { kind: 'pathname', roots: [root.fsPath], query: 'alpha', isRegex: false, include: null, maxResults: 2, skipResults: 0, maxFileSize: 1024 };
		assert.deepStrictEqual(await facade.search(request, source.token), { ok: true, paths: [first.fsPath], hasMore: false, trace: 'terminal-fallback' });
		assert.strictEqual(calls, 1); assert.strictEqual(capturedToken, source.token);
		response = { ok: true, paths: ['a'.repeat(24_000), 'b'.repeat(24_000), 'c'.repeat(24_000)], hasMore: false, trace: 'terminal-fallback' };
		assert.deepStrictEqual(await facade.search(request, source.token), { ok: false, code: 'search_failed', trace: 'terminal-fallback' }); assert.strictEqual(calls, 2);
		assert.deepStrictEqual(await facade.search({ ...request, roots: [] }, source.token), { ok: false, code: 'search_request_invalid', trace: 'terminal-fallback' }); assert.strictEqual(calls, 2);
		source.cancel(); assert.deepStrictEqual(await facade.search(request, source.token), { ok: false, code: 'search_cancelled', trace: 'terminal-fallback' }); assert.strictEqual(calls, 2); source.dispose();
	});

	test('keeps bundled rg primary for pathname and content results with an internal trace', async () => {
		const fixture = toolsFixture();
		assert.deepStrictEqual((await pathname(fixture.service)).result, { uris: [first], hasNextPage: false, backendTrace: 'bundled-rg' });
		assert.deepStrictEqual((await content(fixture.service)).result, { uris: [first], hasNextPage: false, backendTrace: 'bundled-rg' });
		assert.strictEqual(fixture.fallbackRequests.length, 0);
	});

	test('falls back exactly once only for the precise bundled-rg missing code and normalizes page zero', async () => {
		const pathnameFixture = toolsFixture({ fileSearch: async () => { throw missing(); } });
		assert.strictEqual((await pathname(pathnameFixture.service, 0)).result.backendTrace, 'terminal-fallback');
		assert.strictEqual(pathnameFixture.fallbackRequests.length, 1); assert.strictEqual(pathnameFixture.fallbackRequests[0].skipResults, 0); assert.strictEqual(pathnameFixture.fallbackRequests[0].kind, 'pathname');
		const contentFixture = toolsFixture({ textSearch: async () => { throw missing(); } });
		assert.strictEqual((await content(contentFixture.service)).result.backendTrace, 'terminal-fallback');
		assert.strictEqual(contentFixture.fallbackRequests.length, 1); assert.strictEqual(contentFixture.fallbackRequests[0].kind, 'content');
	});

	test('does not fallback for generic, regex, cancellation, or zero-result outcomes', async () => {
		for (const error of [new Error('generic'), new SearchError('bad regex', SearchErrorCode.regexParseError)]) {
			const fixture = toolsFixture({ textSearch: async () => { throw error; } });
			const call = await fixture.service.callTool.search_for_files({ query: '[', isRegex: true, searchInFolder: null, pageNumber: 1 });
			await assert.rejects(Promise.resolve(call.result), (error: unknown) => error instanceof Error);
			assert.strictEqual(fixture.fallbackRequests.length, 0);
		}
		const empty = toolsFixture({ fileSearch: async () => ({ results: [], messages: [] }) }); assert.deepStrictEqual((await pathname(empty.service)).result.uris, []); assert.strictEqual(empty.fallbackRequests.length, 0);
		let cancelled = false; const cancellation = toolsFixture({ fileSearch: async (_query, token) => new Promise((_resolve, reject) => token.onCancellationRequested(() => { cancelled = true; reject(new SearchError('cancelled', SearchErrorCode.canceled)); })) });
		const call = await cancellation.service.callTool.search_pathnames_only({ query: 'alpha', includePattern: null, pageNumber: 1 }); call.interruptTool?.(); await assert.rejects(Promise.resolve(call.result)); assert.strictEqual(cancelled, true); assert.strictEqual(cancellation.fallbackRequests.length, 0);
	});

	test('reports both backends unavailable without exposing a command or arbitrary error', async () => {
		const fixture = toolsFixture({ fileSearch: async () => { throw missing(); }, fallback: async () => ({ ok: false, code: 'search_backend_unavailable', trace: 'terminal-fallback-unavailable' }) });
		const call = await fixture.service.callTool.search_pathnames_only({ query: 'private-query', includePattern: null, pageNumber: 1 });
		await assert.rejects(Promise.resolve(call.result), (error: unknown) => error instanceof ControlledSearchError && error.code === 'search_backend_unavailable' && error.message === 'search_backend_unavailable' && error.trace === 'terminal-fallback-unavailable');
		assert.strictEqual(fixture.fallbackRequests.length, 1);
	});

	test('validates local roots before fallback and validates returned paths after it', async () => {
		const remote = toolsFixture({ root: URI.parse('vscode-remote://fixture/workspace'), fileSearch: async () => { throw missing(); } });
		const remoteCall = await remote.service.callTool.search_pathnames_only({ query: 'alpha', includePattern: null, pageNumber: 1 }); await assert.rejects(Promise.resolve(remoteCall.result), /search_backend_unavailable/); assert.strictEqual(remote.fallbackRequests.length, 0);
		const escaped = toolsFixture({ fileSearch: async () => { throw missing(); }, fallback: async () => ({ ok: true, paths: [URI.file('/outside.txt').fsPath], hasMore: false, trace: 'terminal-fallback' }) });
		const escapedCall = await escaped.service.callTool.search_pathnames_only({ query: 'alpha', includePattern: null, pageNumber: 1 }); await assert.rejects(Promise.resolve(escapedCall.result), /search_failed/);
	});

	test('linked cancellation fences a fallback result during asynchronous child path validation', async () => {
		let validationStarted!: () => void; let releaseValidation!: () => void; let gated = false;
		const started = new Promise<void>(resolve => validationStarted = resolve); const gate = new Promise<void>(resolve => releaseValidation = resolve);
		const fixture = toolsFixture({
			fileSearch: async () => { throw missing(); },
			resolve: async uri => {
				if (!gated && uri.toString() === first.toString()) { gated = true; validationStarted(); await gate; }
				return { resource: uri, isDirectory: uri.toString() === root.toString(), isSymbolicLink: false };
			},
		});
		const context = { ownerThreadId: 'parent', childId: 'child', ownerRoot: root, maxReadOutputTokens: 100, maxResults: 2, maxFileSize: 1024 };
		const call = await fixture.service.callTool.search_pathnames_only({ query: 'alpha', includePattern: null, pageNumber: 1 }, context);
		await started; call.interruptTool?.(); releaseValidation();
		await assert.rejects(Promise.resolve(call.result), (error: unknown) => error instanceof ControlledSearchError && error.code === 'search_cancelled');
	});

	test('fails closed instead of silently truncating parent output and keeps fallback trace out of model text', async () => {
		const longPaths = ['a', 'b', 'c'].map(character => URI.file(`/workspace/${character.repeat(32_000)}.txt`).fsPath);
		const fixture = toolsFixture({ fileSearch: async () => { throw missing(); }, fallback: async () => ({ ok: true, paths: longPaths, hasMore: false, trace: 'terminal-fallback' }) });
		const call = await fixture.service.callTool.search_pathnames_only({ query: 'alpha', includePattern: null, pageNumber: 1 }); await assert.rejects(Promise.resolve(call.result), (error: unknown) => error instanceof ControlledSearchError && error.code === 'search_output_limit' && error.trace === 'terminal-fallback');
		const visible = fixture.service.stringOfResult.search_pathnames_only({ query: 'alpha', includePattern: null, pageNumber: 1 }, { uris: [first], hasNextPage: false, backendTrace: 'terminal-fallback' }); assert.strictEqual(visible.includes('terminal-fallback'), false);
	});

	test('child primary requests bounded lookahead and supports exact-full and page-two results', async () => {
		const files = ['a', 'b', 'c', 'd', 'e'].map(name => URI.file(`/workspace/${name}.txt`)); const maxResults: number[] = [];
		const fixture = toolsFixture({ fileSearch: async (query: any) => { maxResults.push(query.maxResults); return { results: files.slice(0, query.maxResults).map(resource => ({ resource })), messages: [] }; } });
		const context = { ownerThreadId: 'parent', childId: 'child', ownerRoot: root, maxReadOutputTokens: 100, maxResults: 2, maxFileSize: 1024 };
		const firstPageCall = await fixture.service.callTool.search_pathnames_only({ query: '', includePattern: null, pageNumber: 1 }, context); const firstPage = await firstPageCall.result;
		assert.deepStrictEqual(firstPage.uris, files.slice(0, 2)); assert.strictEqual(firstPage.hasNextPage, true); assert.strictEqual(maxResults[0], 3);
		const secondPageCall = await fixture.service.callTool.search_pathnames_only({ query: '', includePattern: null, pageNumber: 2 }, context); const secondPage = await secondPageCall.result;
		assert.deepStrictEqual(secondPage.uris, files.slice(2, 4)); assert.strictEqual(secondPage.hasNextPage, true); assert.strictEqual(maxResults[1], 5);
		const exact = toolsFixture({ fileSearch: async (query: any) => ({ results: files.slice(0, query.maxResults - 1).map(resource => ({ resource })), messages: [] }) }); const exactCall = await exact.service.callTool.search_pathnames_only({ query: '', includePattern: null, pageNumber: 1 }, context); assert.strictEqual((await exactCall.result).hasNextPage, false);
	});

	test('text primary limitHit never reports a false terminal or empty later page', async () => {
		const fixture = toolsFixture({ textSearch: async () => ({ results: [{ resource: first }], messages: [], limitHit: true }) });
		const context = { ownerThreadId: 'parent', childId: 'child', ownerRoot: root, maxReadOutputTokens: 100, maxResults: 2, maxFileSize: 1024 };
		const firstPageCall = await fixture.service.callTool.search_for_files({ query: 'alpha', isRegex: false, searchInFolder: null, pageNumber: 1 }, context);
		assert.deepStrictEqual(await firstPageCall.result, { uris: [first], hasNextPage: true, backendTrace: 'bundled-rg' });
		const laterPageCall = await fixture.service.callTool.search_for_files({ query: 'alpha', isRegex: false, searchInFolder: null, pageNumber: 2 }, context);
		await assert.rejects(Promise.resolve(laterPageCall.result), (error: unknown) => error instanceof ControlledSearchError && error.code === 'search_output_limit' && error.trace === 'bundled-rg');
	});

	test('parent interrupt owns the primary token while search_in_file remains in-process', async () => {
		let cancelled = false;
		const fixture = toolsFixture({ fileSearch: async (_query, token) => new Promise((_resolve, reject) => token.onCancellationRequested(() => { cancelled = true; reject(new SearchError('cancelled', SearchErrorCode.canceled)); })) });
		const pending = await fixture.service.callTool.search_pathnames_only({ query: 'alpha', includePattern: null, pageNumber: 1 }); assert.strictEqual(typeof pending.interruptTool, 'function'); pending.interruptTool?.(); await assert.rejects(Promise.resolve(pending.result)); assert.strictEqual(cancelled, true); assert.strictEqual(fixture.fallbackRequests.length, 0);
		const local = await fixture.service.callTool.search_in_file({ uri: first, query: 'needle', isRegex: false }); assert.deepStrictEqual(await local.result, { lines: [1] }); assert.strictEqual(fixture.fallbackRequests.length, 0);
	});
});
