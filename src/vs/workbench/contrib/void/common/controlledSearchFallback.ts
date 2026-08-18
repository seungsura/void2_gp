/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';

export const CONTROLLED_SEARCH_CHANNEL_NAME = 'void-channel-controlled-search';

export const CONTROLLED_SEARCH_MAX_ROOTS = 16;
export const CONTROLLED_SEARCH_MAX_QUERY_CHARS = 16 * 1024;
export const CONTROLLED_SEARCH_MAX_INCLUDE_CHARS = 4 * 1024;
export const CONTROLLED_SEARCH_MAX_RESULTS = 501;
export const CONTROLLED_SEARCH_MAX_SKIP_RESULTS = 1_000_000;
export const CONTROLLED_SEARCH_MAX_FILE_BYTES = 16 * 1024 * 1024 * 1024;
export const CONTROLLED_SEARCH_MAX_STDOUT_BYTES = 64 * 1024;
export const CONTROLLED_SEARCH_MAX_STDERR_BYTES = 8 * 1024;
export const CONTROLLED_SEARCH_TIMEOUT_MS = 10_000;

export type SearchBackendTrace = 'bundled-rg' | 'terminal-fallback' | 'terminal-fallback-unavailable';
export type ControlledSearchKind = 'pathname' | 'content';
export type ControlledSearchErrorCode =
	| 'search_backend_unavailable'
	| 'search_cancelled'
	| 'search_timeout'
	| 'search_output_limit'
	| 'search_failed'
	| 'search_request_invalid';

export type ControlledSearchRequest = Readonly<{
	kind: ControlledSearchKind;
	roots: readonly string[];
	query: string;
	isRegex: boolean;
	include: string | null;
	maxResults: number;
	skipResults: number;
	maxFileSize: number | null;
}>;

export type ControlledSearchResult =
	| Readonly<{ ok: true; paths: readonly string[]; hasMore: boolean; trace: 'terminal-fallback' }>
	| Readonly<{ ok: false; code: ControlledSearchErrorCode; trace: 'terminal-fallback' | 'terminal-fallback-unavailable' }>;

export class ControlledSearchError extends Error {
	constructor(readonly code: ControlledSearchErrorCode, readonly trace: SearchBackendTrace = code === 'search_backend_unavailable' ? 'terminal-fallback-unavailable' : 'terminal-fallback') {
		super(code);
		this.name = 'ControlledSearchError';
	}
}

const exactKeys = (value: Record<string, unknown>, expected: readonly string[]) => {
	const actual = Object.keys(value);
	return actual.length === expected.length && actual.every(key => expected.includes(key));
};

const boundedString = (value: unknown, max: number, allowEmpty: boolean) =>
	typeof value === 'string' && value.length <= max && (allowEmpty || value.length > 0) && !/[\0\r\n]/.test(value);

const boundedQuery = (value: unknown) =>
	typeof value === 'string' && value.length <= CONTROLLED_SEARCH_MAX_QUERY_CHARS && !/[\0\r\n]/.test(value);

export const validateControlledSearchRequest = (value: unknown): ControlledSearchRequest | undefined => {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	if (!exactKeys(raw, ['kind', 'roots', 'query', 'isRegex', 'include', 'maxResults', 'skipResults', 'maxFileSize'])) return undefined;
	if (raw.kind !== 'pathname' && raw.kind !== 'content') return undefined;
	if (!Array.isArray(raw.roots) || raw.roots.length < 1 || raw.roots.length > CONTROLLED_SEARCH_MAX_ROOTS || raw.roots.some(root => !boundedString(root, 32 * 1024, false))) return undefined;
	if (!boundedQuery(raw.query) || typeof raw.isRegex !== 'boolean') return undefined;
	if (raw.include !== null && !boundedString(raw.include, CONTROLLED_SEARCH_MAX_INCLUDE_CHARS, false)) return undefined;
	if (!Number.isSafeInteger(raw.maxResults) || (raw.maxResults as number) < 1 || (raw.maxResults as number) > CONTROLLED_SEARCH_MAX_RESULTS) return undefined;
	if (!Number.isSafeInteger(raw.skipResults) || (raw.skipResults as number) < 0 || (raw.skipResults as number) > CONTROLLED_SEARCH_MAX_SKIP_RESULTS) return undefined;
	if (raw.maxFileSize !== null && (!Number.isSafeInteger(raw.maxFileSize) || (raw.maxFileSize as number) < 1 || (raw.maxFileSize as number) > CONTROLLED_SEARCH_MAX_FILE_BYTES)) return undefined;
	return Object.freeze({
		kind: raw.kind,
		roots: Object.freeze([...(raw.roots as string[])]),
		query: raw.query as string,
		isRegex: raw.isRegex,
		include: raw.include as string | null,
		maxResults: raw.maxResults as number,
		skipResults: raw.skipResults as number,
		maxFileSize: raw.maxFileSize as number | null,
	});
};

export const controlledSearchFailure = (code: ControlledSearchErrorCode): ControlledSearchResult => Object.freeze({ ok: false, code, trace: code === 'search_backend_unavailable' ? 'terminal-fallback-unavailable' : 'terminal-fallback' });

const controlledSearchErrorCodes = new Set<ControlledSearchErrorCode>(['search_backend_unavailable', 'search_cancelled', 'search_timeout', 'search_output_limit', 'search_failed', 'search_request_invalid']);

export const validateControlledSearchResult = (value: unknown, maxResults: number): ControlledSearchResult | undefined => {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	if (raw.ok === true) {
		if (!exactKeys(raw, ['ok', 'paths', 'hasMore', 'trace']) || raw.trace !== 'terminal-fallback' || typeof raw.hasMore !== 'boolean') return undefined;
		if (!Array.isArray(raw.paths) || raw.paths.length > maxResults || raw.paths.some(item => !boundedString(item, 32 * 1024, false))) return undefined;
		const aggregateBytes = (raw.paths as string[]).reduce((total, item, index) => total + VSBuffer.fromString(item).byteLength + (index ? 1 : 0), 0);
		if (aggregateBytes > CONTROLLED_SEARCH_MAX_STDOUT_BYTES) return undefined;
		return Object.freeze({ ok: true, paths: Object.freeze([...(raw.paths as string[])]), hasMore: raw.hasMore, trace: raw.trace });
	}
	if (raw.ok !== false || !exactKeys(raw, ['ok', 'code', 'trace']) || typeof raw.code !== 'string' || !controlledSearchErrorCodes.has(raw.code as ControlledSearchErrorCode)) return undefined;
	const expectedTrace = raw.code === 'search_backend_unavailable' ? 'terminal-fallback-unavailable' : 'terminal-fallback';
	if (raw.trace !== expectedTrace) return undefined;
	return controlledSearchFailure(raw.code as ControlledSearchErrorCode);
};
