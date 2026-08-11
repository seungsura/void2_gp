/*---------------------------------------------------------------------------------------------
 *  AGENTS.md instruction snapshots. This module is deliberately DI-free so admission rules
 *  can be tested with byte fixtures instead of a workbench file service.
 *--------------------------------------------------------------------------------------------*/
import { URI } from '../../../../base/common/uri.js';
import { isEqualOrParent } from '../../../../base/common/resources.js';

export const DEFAULT_PROJECT_DOC_MAX_BYTES = 32 * 1024;

export type AgentInstructionsConfig = Readonly<{
	developerInstructions: string;
	projectDocMaxBytes: number;
	developerInstructionsSource: 'user' | 'project' | 'default';
	projectDocMaxBytesSource: 'user' | 'project' | 'default';
	configSources: readonly AgentConfigSourceProvenance[];
	ownerProjectRoot?: string;
	runCwd?: string;
}>;
export type AgentConfigSourceProvenance = Readonly<{
	uri: string;
	scope: 'user' | 'project';
	status: 'loaded' | 'missing' | 'unreadable' | 'invalid_utf8' | 'malformed';
	projectedKeys: readonly ('developer_instructions' | 'project_doc_max_bytes')[];
}>;
export type ParsedAgentConfigSource = Readonly<{ projected?: ParsedAgentConfig; provenance: AgentConfigSourceProvenance }>;
export type AgentConfigSourceDescriptor = Readonly<{ scope: 'user' | 'project'; uri: URI }>;

export const agentConfigSourceDescriptors = (userHome: URI, ownerRoot: URI | undefined, trusted: boolean): readonly AgentConfigSourceDescriptor[] => Object.freeze([
	Object.freeze({ scope: 'user' as const, uri: URI.joinPath(userHome, '.codex', 'config.toml') }),
	...(ownerRoot && trusted ? [Object.freeze({ scope: 'project' as const, uri: URI.joinPath(ownerRoot, '.codex', 'config.toml') })] : []),
]);

export type AgentInstructionSourceProvenance = Readonly<{
	uri: string;
	rawBytes: number;
	admittedBytes: number;
	skipReason?: 'missing' | 'empty' | 'whitespace' | 'unreadable' | 'invalid_utf8' | 'budget';
	truncated: boolean;
}>;

export type AgentInstructionTurnSnapshot = Readonly<{
	revision: string;
	config: AgentInstructionsConfig;
	ownerProjectRoot: string | undefined;
	runCwd: string | undefined;
	developerInstructions: string;
	agentsInstructions: string;
	provenance: readonly AgentInstructionSourceProvenance[];
}>;

export type AgentInstructionReadOutcome = Readonly<{ status: 'bytes'; bytes: Uint8Array } | { status: 'missing' | 'unreadable' }>;
export type AgentInstructionCandidate = Readonly<{ uri: string; outcome: AgentInstructionReadOutcome }>;

/** Exact AGENTS candidates from root through CWD; empty means CWD is outside the owner. */
export const agentInstructionChain = (root: URI, cwd: URI): readonly URI[] => {
	if (root.scheme !== cwd.scheme || root.authority !== cwd.authority || !isEqualOrParent(cwd, root)) return Object.freeze([]);
	const rootParts = root.path.split('/').filter(Boolean);
	const cwdParts = cwd.path.split('/').filter(Boolean);
	const result: URI[] = [URI.joinPath(root, 'AGENTS.md')];
	let current = root;
	for (const part of cwdParts.slice(rootParts.length)) {
		current = URI.joinPath(current, part);
		result.push(URI.joinPath(current, 'AGENTS.md'));
	}
	return Object.freeze(result);
};

export type ParsedAgentConfig = Readonly<{ developerInstructions?: string; projectDocMaxBytes?: number }>;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export const projectDocMaxBytes = (value: unknown): number | undefined =>
	typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** `0` is an explicit opt-out: no AGENTS bytes are admitted, while provenance remains available. */
export const projectAgentConfig = (
	user: ParsedAgentConfig | undefined,
	project: ParsedAgentConfig | undefined = undefined,
	configSources: readonly AgentConfigSourceProvenance[] = [],
	ownerProjectRoot?: string,
	runCwd?: string,
): AgentInstructionsConfig => Object.freeze({
	developerInstructions: project?.developerInstructions ?? user?.developerInstructions ?? '',
	projectDocMaxBytes: project?.projectDocMaxBytes ?? user?.projectDocMaxBytes ?? DEFAULT_PROJECT_DOC_MAX_BYTES,
	developerInstructionsSource: project?.developerInstructions !== undefined ? 'project' : user?.developerInstructions !== undefined ? 'user' : 'default',
	projectDocMaxBytesSource: project?.projectDocMaxBytes !== undefined ? 'project' : user?.projectDocMaxBytes !== undefined ? 'user' : 'default',
	configSources: Object.freeze(configSources.map(source => Object.freeze({ ...source, projectedKeys: Object.freeze([...source.projectedKeys]) }))),
	ownerProjectRoot,
	runCwd,
});

export const projectAgentConfigProjection = (value: unknown): ParsedAgentConfig => {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return Object.freeze({});
	const record = value as Record<string, unknown>;
	return Object.freeze({
		developerInstructions: typeof record.developer_instructions === 'string' ? record.developer_instructions : undefined,
		projectDocMaxBytes: projectDocMaxBytes(record.project_doc_max_bytes),
	});
};

export const parseAgentConfigSource = (
	scope: 'user' | 'project',
	uri: string,
	outcome: AgentInstructionReadOutcome,
	parseToml: (text: string) => unknown,
): ParsedAgentConfigSource => {
	const provenance = (status: AgentConfigSourceProvenance['status'], projected?: ParsedAgentConfig): AgentConfigSourceProvenance => Object.freeze({
		uri,
		scope,
		status,
		projectedKeys: Object.freeze([
			...(projected?.developerInstructions !== undefined ? ['developer_instructions'] as const : []),
			...(projected?.projectDocMaxBytes !== undefined ? ['project_doc_max_bytes'] as const : []),
		]),
	});
	if (outcome.status !== 'bytes') return Object.freeze({ provenance: provenance(outcome.status) });
	let text: string;
	try {
		text = new TextDecoder('utf-8', { fatal: true }).decode(outcome.bytes);
	}
	catch {
		return Object.freeze({ provenance: provenance('invalid_utf8') });
	}
	try {
		const projected = projectAgentConfigProjection(parseToml(text));
		return Object.freeze({ projected, provenance: provenance('loaded', projected) });
	}
	catch {
		return Object.freeze({ provenance: provenance('malformed') });
	}
};

const utf8PrefixLength = (bytes: Uint8Array, max: number): number => {
	let end = Math.min(bytes.byteLength, max);
	while (end > 0) {
		try {
			decoder.decode(bytes.slice(0, end));
			return end;
		}
		catch {
			end--;
		}
	}
	return 0;
};

export const assembleAgentInstructionText = (snapshot: AgentInstructionTurnSnapshot): string =>
	[snapshot.developerInstructions, snapshot.agentsInstructions].filter(Boolean).join('\n\n');

export type AgentInstructionAuthorityRoute = Readonly<{
	roleMessages: readonly Readonly<{ role: 'developer' | 'system'; content: string }>[];
	separateSystemMessage?: string;
	userFallbackSystemMessage?: string;
}>;

export const routeAgentInstructionAuthority = (
	instructionText: string,
	generatedSystemText: string,
	supports: false | 'system-role' | 'developer-role' | 'separated',
): AgentInstructionAuthorityRoute => {
	const texts = [instructionText, generatedSystemText].filter(Boolean);
	const freeze = (value: AgentInstructionAuthorityRoute): AgentInstructionAuthorityRoute => Object.freeze({
		...value,
		roleMessages: Object.freeze(value.roleMessages.map(message => Object.freeze(message))),
	});
	if (supports === 'developer-role' || supports === 'system-role') {
		return freeze({ roleMessages: texts.map(content => ({ role: supports === 'developer-role' ? 'developer' as const : 'system' as const, content })) });
	}
	const combined = texts.join('\n\n') || undefined;
	return supports === 'separated'
		? freeze({ roleMessages: [], separateSystemMessage: combined })
		: freeze({ roleMessages: [], userFallbackSystemMessage: combined });
};

/** Task-local lifecycle: a rejected config load is sticky for the task, avoiding an implicit reload. */
export class AgentInstructionTaskSession {
	private configPromise: Promise<AgentInstructionsConfig> | undefined;
	constructor(
		private readonly loadConfig: () => Promise<AgentInstructionsConfig>,
		private readonly loadTurn: (config: AgentInstructionsConfig) => Promise<AgentInstructionTurnSnapshot>,
	) { }
	beginTopLevelTurn(): Promise<AgentInstructionTurnSnapshot> {
		this.configPromise ??= this.loadConfig();
		return this.configPromise.then(config => this.loadTurn(config));
	}
}

export const inheritAgentInstructionTurnSnapshot = (snapshot: AgentInstructionTurnSnapshot): AgentInstructionTurnSnapshot => snapshot;

export const reviveAgentInstructionTurnSnapshot = (value: unknown): AgentInstructionTurnSnapshot | undefined => {
	const object = (candidate: unknown): Record<string, unknown> | undefined =>
		candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate as Record<string, unknown> : undefined;
	const sourceKeys = new Set(['developer_instructions', 'project_doc_max_bytes']);
	const configStatuses = new Set(['loaded', 'missing', 'unreadable', 'invalid_utf8', 'malformed']);
	const skipReasons = new Set(['missing', 'empty', 'whitespace', 'unreadable', 'invalid_utf8', 'budget']);
	const uri = (candidate: unknown): string | undefined => {
		if (typeof candidate !== 'string' || !candidate) return undefined;
		try {
			URI.parse(candidate, true);
			return candidate;
		}
		catch {
			return undefined;
		}
	};

	const root = object(value);
	const config = root && object(root.config);
	if (
		!root
		|| !config
		|| typeof root.revision !== 'string'
		|| !root.revision
		|| typeof root.developerInstructions !== 'string'
		|| typeof root.agentsInstructions !== 'string'
	) return undefined;

	const owner = root.ownerProjectRoot;
	const cwd = root.runCwd;
	if (!((owner === undefined && cwd === undefined) || (uri(owner) && owner === cwd && uri(cwd)))) return undefined;

	if (
		typeof config.developerInstructions !== 'string'
		|| config.developerInstructions !== root.developerInstructions
		|| !Number.isSafeInteger(config.projectDocMaxBytes)
		|| (config.projectDocMaxBytes as number) < 0
		|| !['user', 'project', 'default'].includes(config.developerInstructionsSource as string)
		|| !['user', 'project', 'default'].includes(config.projectDocMaxBytesSource as string)
		|| config.ownerProjectRoot !== owner
		|| config.runCwd !== cwd
		|| !Array.isArray(config.configSources)
		|| !Array.isArray(root.provenance)
	) return undefined;

	const revivedConfigSources: AgentConfigSourceProvenance[] = [];
	for (const raw of config.configSources) {
		const source = object(raw);
		if (
			!source
			|| !uri(source.uri)
			|| !['user', 'project'].includes(source.scope as string)
			|| !configStatuses.has(source.status as string)
			|| !Array.isArray(source.projectedKeys)
			|| new Set(source.projectedKeys).size !== source.projectedKeys.length
			|| !source.projectedKeys.every(key => sourceKeys.has(key as string))
			|| (source.status !== 'loaded' && source.projectedKeys.length > 0)
		) return undefined;
		revivedConfigSources.push(Object.freeze({
			uri: source.uri as string,
			scope: source.scope as 'user' | 'project',
			status: source.status as AgentConfigSourceProvenance['status'],
			projectedKeys: Object.freeze([...source.projectedKeys] as ('developer_instructions' | 'project_doc_max_bytes')[]),
		}));
	}
	if (
		!revivedConfigSources.length
		|| revivedConfigSources[0].scope !== 'user'
		|| revivedConfigSources.length > 2
		|| (revivedConfigSources[1] && (revivedConfigSources[1].scope !== 'project' || !owner))
	) return undefined;

	const provenance: AgentInstructionSourceProvenance[] = [];
	for (const raw of root.provenance) {
		const source = object(raw);
		if (
			!source
			|| !uri(source.uri)
			|| !Number.isSafeInteger(source.rawBytes)
			|| !Number.isSafeInteger(source.admittedBytes)
			|| (source.rawBytes as number) < 0
			|| (source.admittedBytes as number) < 0
			|| (source.admittedBytes as number) > (source.rawBytes as number)
			|| typeof source.truncated !== 'boolean'
			|| (source.skipReason !== undefined && !skipReasons.has(source.skipReason as string))
		) return undefined;
		const rawBytes = source.rawBytes as number;
		const admittedBytes = source.admittedBytes as number;
		const skipReason = source.skipReason as string | undefined;
		if (
			(['missing', 'unreadable', 'empty'].includes(skipReason ?? '') && !(rawBytes === 0 && admittedBytes === 0 && !source.truncated))
			|| (['whitespace', 'invalid_utf8'].includes(skipReason ?? '') && !(rawBytes > 0 && admittedBytes === 0 && !source.truncated))
			|| (skipReason === 'budget' && !(rawBytes > 0 && admittedBytes === 0 && source.truncated))
			|| (!skipReason && !(rawBytes > 0 && admittedBytes > 0 && source.truncated === (admittedBytes < rawBytes)))
		) return undefined;
		provenance.push(Object.freeze({
			uri: source.uri as string,
			rawBytes,
			admittedBytes,
			...(skipReason === undefined ? {} : { skipReason: skipReason as AgentInstructionSourceProvenance['skipReason'] }),
			truncated: source.truncated,
		}));
	}

	const loaded = (scope: 'user' | 'project', key: string) =>
		revivedConfigSources.some(source => source.scope === scope && source.status === 'loaded' && source.projectedKeys.includes(key as never));
	const expected = (key: string) => loaded('project', key) ? 'project' : loaded('user', key) ? 'user' : 'default';
	if (
		config.developerInstructionsSource !== expected('developer_instructions')
		|| config.projectDocMaxBytesSource !== expected('project_doc_max_bytes')
		|| (config.developerInstructionsSource === 'default' && config.developerInstructions !== '')
		|| (config.projectDocMaxBytesSource === 'default' && config.projectDocMaxBytes !== DEFAULT_PROJECT_DOC_MAX_BYTES)
	) return undefined;

	const revivedConfig: AgentInstructionsConfig = Object.freeze({
		developerInstructions: config.developerInstructions as string,
		projectDocMaxBytes: config.projectDocMaxBytes as number,
		developerInstructionsSource: config.developerInstructionsSource as AgentInstructionsConfig['developerInstructionsSource'],
		projectDocMaxBytesSource: config.projectDocMaxBytesSource as AgentInstructionsConfig['projectDocMaxBytesSource'],
		configSources: Object.freeze(revivedConfigSources),
		ownerProjectRoot: owner as string | undefined,
		runCwd: cwd as string | undefined,
	});
	return Object.freeze({
		revision: root.revision,
		config: revivedConfig,
		ownerProjectRoot: owner as string | undefined,
		runCwd: cwd as string | undefined,
		developerInstructions: root.developerInstructions,
		agentsInstructions: root.agentsInstructions,
		provenance: Object.freeze(provenance),
	});
};

export const resolveAgentInstructions = (
	config: AgentInstructionsConfig,
	candidates: readonly AgentInstructionCandidate[],
	revision: string,
): AgentInstructionTurnSnapshot => {
	let remaining = config.projectDocMaxBytes;
	const contents: string[] = [];
	const provenance: AgentInstructionSourceProvenance[] = [];
	for (const candidate of candidates) {
		const rawBytes = candidate.outcome.status === 'bytes' ? candidate.outcome.bytes.byteLength : 0;
		if (candidate.outcome.status !== 'bytes') {
			provenance.push(Object.freeze({ uri: candidate.uri, rawBytes, admittedBytes: 0, skipReason: candidate.outcome.status, truncated: false }));
			continue;
		}
		const bytes = candidate.outcome.bytes;
		let text: string;
		try {
			text = decoder.decode(bytes);
		}
		catch {
			provenance.push(Object.freeze({ uri: candidate.uri, rawBytes, admittedBytes: 0, skipReason: 'invalid_utf8', truncated: false }));
			continue;
		}
		if (rawBytes === 0) {
			provenance.push({ uri: candidate.uri, rawBytes, admittedBytes: 0, skipReason: 'empty', truncated: false });
			continue;
		}
		if (!text.trim()) {
			provenance.push({ uri: candidate.uri, rawBytes, admittedBytes: 0, skipReason: 'whitespace', truncated: false });
			continue;
		}
		const separator = contents.length === 0 ? 0 : 2;
		if (remaining <= separator) {
			provenance.push({ uri: candidate.uri, rawBytes, admittedBytes: 0, skipReason: 'budget', truncated: true });
			continue;
		}
		const allowed = Math.min(rawBytes, remaining - separator);
		const admittedBytes = utf8PrefixLength(bytes, allowed);
		if (admittedBytes === 0) {
			provenance.push({ uri: candidate.uri, rawBytes, admittedBytes, skipReason: 'budget', truncated: true });
			continue;
		}
		contents.push(decoder.decode(bytes.slice(0, admittedBytes)));
		remaining -= separator + admittedBytes;
		provenance.push({ uri: candidate.uri, rawBytes, admittedBytes, truncated: admittedBytes !== rawBytes });
	}
	return Object.freeze({
		revision,
		config,
		ownerProjectRoot: config.ownerProjectRoot,
		runCwd: config.runCwd,
		developerInstructions: config.developerInstructions,
		agentsInstructions: contents.join('\n\n'),
		provenance: Object.freeze(provenance.map(source => Object.freeze(source))),
	});
};

export const stableAgentInstructionRevision = (config: AgentInstructionsConfig, candidates: readonly AgentInstructionCandidate[]): string => {
	let hash = 2166136261;
	const add = (value: string) => {
		for (const byte of encoder.encode(value)) hash = Math.imul(hash ^ byte, 16777619);
	};
	add(`${config.developerInstructions}\0${config.projectDocMaxBytes}\0${config.developerInstructionsSource}\0${config.projectDocMaxBytesSource}\0${config.ownerProjectRoot ?? ''}\0${config.runCwd ?? ''}`);
	for (const source of config.configSources) add(`\0${source.uri}\0${source.scope}\0${source.status}\0${source.projectedKeys.join(',')}`);
	for (const candidate of candidates) {
		add(`\0${candidate.uri}\0${candidate.outcome.status}`);
		if (candidate.outcome.status === 'bytes') {
			for (const byte of candidate.outcome.bytes) hash = Math.imul(hash ^ byte, 16777619);
		}
	}
	return `agents-${(hash >>> 0).toString(16)}`;
};
