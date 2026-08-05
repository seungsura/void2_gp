/*---------------------------------------------------------------------------------------------
 *  OpenAI-compatible stream diagnostics. Deliberately excludes request content and secrets.
 *--------------------------------------------------------------------------------------------*/

export type OpenAICompatibleStreamDiagnostics = {
	endpoint: string;
	model: string;
	chatMode: string | null;
	toolCount: number;
	toolSchemaDialect: 'none' | 'flat' | 'oneOf-or-composition' | 'other';
	dispatchStarted: boolean;
	responseHeadersReceived: boolean;
	httpStatus: number | undefined;
	requestId: string | undefined;
	firstParsedStreamEvent: boolean;
};

const compositionKeys = new Set(['oneOf', 'anyOf', 'allOf', 'not']);

export const redactOpenAICompatibleEndpoint = (endpoint: string): string => {
	try {
		const url = new URL(endpoint);
		return `${url.origin}${url.pathname}`;
	} catch {
		return '<invalid-endpoint>';
	}
};

export const classifyOpenAICompatibleToolSchemaDialect = (tools: readonly unknown[] | undefined): OpenAICompatibleStreamDiagnostics['toolSchemaDialect'] => {
	if (!tools || tools.length === 0) return 'none';
	const schemas = tools.map(tool => (tool && typeof tool === 'object' ? (tool as { function?: { parameters?: unknown } }).function?.parameters : undefined));
	if (schemas.some(schema => !schema || typeof schema !== 'object' || Array.isArray(schema))) return 'other';
	if (schemas.some(schema => Object.keys(schema as object).some(key => compositionKeys.has(key)))) return 'oneOf-or-composition';
	return schemas.every(schema => (schema as { type?: unknown }).type === 'object') ? 'flat' : 'other';
};

export const isPrematureStreamClose = (error: unknown): boolean => {
	const seen = new Set<unknown>();
	let current: unknown = error;
	while (current && typeof current === 'object' && !seen.has(current)) {
		seen.add(current);
		if ((current as { code?: unknown }).code === 'ERR_STREAM_PREMATURE_CLOSE') return true;
		current = (current as { cause?: unknown }).cause;
	}
	return false;
};

const value = (input: string | number | undefined | null) => input === undefined || input === null || input === '' ? 'unknown' : String(input);

export const formatPrematureStreamCloseMessage = (diagnostics: OpenAICompatibleStreamDiagnostics): string => {
	const phase = diagnostics.responseHeadersReceived
		? diagnostics.firstParsedStreamEvent ? 'after-first-parsed-stream-event' : 'after-response-headers-before-first-parsed-stream-event'
		: diagnostics.dispatchStarted ? 'after-dispatch-before-response-headers' : 'before-dispatch';
	return `OpenAI-compatible stream closed prematurely (endpoint=${diagnostics.endpoint}, model=${diagnostics.model}, chatMode=${value(diagnostics.chatMode)}, toolCount=${diagnostics.toolCount}, dialect=${diagnostics.toolSchemaDialect}, phase=${phase}, status=${value(diagnostics.httpStatus)}, requestId=${value(diagnostics.requestId)}). This does not identify a schema cause; compare proxy request validation, upstream behavior, and SSE relay behavior with an A/B fixture.`;
};
