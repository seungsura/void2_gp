/*---------------------------------------------------------------------------------------------
 *  Bounded, line-safe read_file pagination helpers.
 *--------------------------------------------------------------------------------------------*/

export const READ_FILE_DEFAULTS = { maxLines: 2000, maxBytes: 64 * 1024, maxTokens: 12000 } as const;
export const READ_FILE_LIMITS = { maxLines: 4000, maxBytes: 128 * 1024, maxTokens: 24000 } as const;
export type ReadFileLimits = { maxLines: number; maxBytes: number; maxTokens: number };
export type ReadFileRequest = { startLine: number | null; endLine: number | null; lineByteOffset: number };
export type ReadFilePage = { fileContents: string; totalFileLen: number; totalNumLines: number; hasNextPage: boolean; startLine: number; endLine: number | null; nextLine: number | null; nextByteOffset?: number; truncated: boolean; eof: boolean; longLineContinuation: boolean };

const encoder = new TextEncoder();
const tokenEstimate = (s: string) => Math.ceil(s.length / 4);
export const clampReadFileLimits = (value: Partial<ReadFileLimits> | undefined): ReadFileLimits => ({
	maxLines: clampInt(value?.maxLines, READ_FILE_DEFAULTS.maxLines, 1, READ_FILE_LIMITS.maxLines),
	maxBytes: clampInt(value?.maxBytes, READ_FILE_DEFAULTS.maxBytes, 1024, READ_FILE_LIMITS.maxBytes),
	maxTokens: clampInt(value?.maxTokens, READ_FILE_DEFAULTS.maxTokens, 1, READ_FILE_LIMITS.maxTokens),
});
export const effectiveReadFileLimits = (configured: Partial<ReadFileLimits> | undefined, maxReadOutputTokens: number): ReadFileLimits => ({ ...clampReadFileLimits(configured), maxTokens: Math.max(0, Math.min(clampReadFileLimits(configured).maxTokens, maxReadOutputTokens)) });
export const computeMaxReadOutputTokens = (contextWindow: number, reservedOutputTokens: number, baselineEstimatedTokens: number) => Math.max(0, contextWindow - reservedOutputTokens - baselineEstimatedTokens - 1024);
const clampInt = (value: unknown, fallback: number, min: number, max: number) => typeof value === 'number' && Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback;

export const validateReadFileRequest = (params: Record<string, unknown>): ReadFileRequest => {
	const number = (key: string, fallback: number | null) => {
		const value = params[key]; if (value === undefined || value === null || value === '') return fallback;
		if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`Invalid LLM output: ${key} must be an integer.`); return value;
	};
	if (params.page_number !== undefined) {
		if (params.page_number === 1) { /* explicit first-page compatibility alias */ }
		else throw new Error('read_file page_number >= 2 is no longer supported; use next_line and line_byte_offset from the prior result.');
	}
	const startLine = number('start_line', 1); const endLine = number('end_line', null); const lineByteOffset = number('line_byte_offset', 0)!;
	if (startLine! < 1 || (endLine !== null && endLine < startLine!) || lineByteOffset < 0) throw new Error('Invalid read_file range. start_line is 1-based, end_line is inclusive, and line_byte_offset is non-negative.');
	return { startLine, endLine, lineByteOffset };
};

export const pageReadFileLines = (lines: readonly string[], request: ReadFileRequest, limits_: Partial<ReadFileLimits> = {}): ReadFilePage => {
	const limits = { ...clampReadFileLimits(limits_), maxTokens: limits_.maxTokens === 0 ? 0 : clampReadFileLimits(limits_).maxTokens }; const totalNumLines = lines.length; const totalFileLen = lines.join('\n').length;
	const start = request.startLine ?? 1; const last = Math.min(request.endLine ?? totalNumLines, totalNumLines);
	if (start > totalNumLines || totalNumLines === 0) return { fileContents: '', totalFileLen, totalNumLines, hasNextPage: false, startLine: start, endLine: null, nextLine: null, truncated: false, eof: true, longLineContinuation: false };
	const first = lines[start - 1]; const firstBytes = encoder.encode(first);
	if (request.lineByteOffset > 0 && (request.lineByteOffset >= firstBytes.length || !isUtf8Boundary(first, request.lineByteOffset))) throw new Error('Invalid read_file line_byte_offset: it must be within the requested line at a UTF-8 code-point boundary.');
	let content = ''; let usedBytes = 0; let line = start; let offset = request.lineByteOffset;
	for (; line <= last; line++) {
		const source = lines[line - 1]; const bytes = encoder.encode(source); const prefix = line === start ? offset : 0;
		const visible = prefix === 0 ? source : new TextDecoder().decode(bytes.slice(prefix));
		const newlineBytes = line < totalNumLines ? 1 : 0;
		if (encoder.encode(visible).length + newlineBytes > limits.maxBytes || tokenEstimate(visible) > limits.maxTokens) {
			const separator = line > start ? '\n' : '';
			// The preceding normal line has already reserved this separator in usedBytes.
			const available = Math.min(limits.maxBytes - usedBytes, Math.max(0, limits.maxTokens * 4 - (content + separator).length));
			if (available <= 0) break;
			const consumed = validUtf8Prefix(source, prefix, available); if (consumed <= prefix) break;
			const part = new TextDecoder().decode(bytes.slice(prefix, consumed)); content += separator + part;
			return { fileContents: content, totalFileLen, totalNumLines, hasNextPage: true, startLine: start, endLine: line, nextLine: line, nextByteOffset: consumed, truncated: true, eof: false, longLineContinuation: true };
		}
		if (line > start && (usedBytes + encoder.encode(visible).length + newlineBytes > limits.maxBytes || tokenEstimate(content + '\n' + visible) > limits.maxTokens) || line - start >= limits.maxLines) break;
		content += (line === start ? '' : '\n') + visible; usedBytes += encoder.encode(visible).length + newlineBytes;
	}
	const eof = line > last || line > totalNumLines; const nextLine = eof ? null : line;
	return { fileContents: content, totalFileLen, totalNumLines, hasNextPage: !eof, startLine: start, endLine: content === '' ? null : line - 1, nextLine, truncated: !eof, eof, longLineContinuation: false };
};

/**
 * A truncated non-EOF page is usable only when its continuation cursor moves
 * beyond the caller's requested position. Returning it as a success otherwise
 * invites an infinite retry loop when the chat has no remaining read budget.
 */
export const assertReadFilePageMakesProgress = (page: ReadFilePage, request: ReadFileRequest): void => {
	if (!page.truncated || page.eof) return;
	const requestedLine = request.startLine ?? 1;
	const lineAdvanced = page.nextLine !== null && page.nextLine > requestedLine;
	const byteAdvanced = page.nextByteOffset !== undefined && page.nextByteOffset > request.lineByteOffset;
	if (lineAdvanced || byteAdvanced) return;
	throw new Error('read_file context_exhausted: output/context budget could not return a progressing page. Use search_in_file, a targeted range, or retry in a new task.');
};
const isUtf8Boundary = (text: string, offset: number) => encoder.encode(new TextDecoder().decode(encoder.encode(text).slice(0, offset))).length === offset;
const validUtf8Prefix = (text: string, start: number, count: number) => { const bytes = encoder.encode(text); let end = Math.min(bytes.length, start + count); while (end > start && !isUtf8Boundary(text, end)) end--; return end; };

export type ReadReceipt<T> = { id: string; uri: string; version: number; model: T; owner: string };
export class ReadReceiptRegistry<T> { private readonly receipts = new Map<string, ReadReceipt<T>>(); add(receipt: ReadReceipt<T>) { this.receipts.set(receipt.id, receipt); return receipt; } validate(id: string, uri: string, owner: string, model: T, version: number) { const r = this.receipts.get(id); return !!r && r.uri === uri && r.owner === owner && r.model === model && r.version === version; } invalidateModel(model: T) { for (const [id, r] of this.receipts) if (r.model === model) this.receipts.delete(id); } invalidateOwner(owner: string) { for (const [id, r] of this.receipts) if (r.owner === owner) this.receipts.delete(id); } }
export const isBoundedReadHistory = (page: ReadFilePage, limits: Partial<ReadFileLimits> = {}) => encoder.encode(page.fileContents).length <= clampReadFileLimits(limits).maxBytes;
export const isBoundedReadHistoryString = (content: string, limits: Partial<ReadFileLimits> = {}) => encoder.encode(content).length <= clampReadFileLimits(limits).maxBytes + 1024;
