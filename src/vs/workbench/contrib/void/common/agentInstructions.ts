/*---------------------------------------------------------------------------------------------
 *  AGENTS.md instruction snapshots. This module is deliberately DI-free so admission rules
 *  can be tested with byte fixtures instead of a workbench file service.
 *--------------------------------------------------------------------------------------------*/
import { URI } from '../../../../base/common/uri.js';
import { isEqualOrParent } from '../../../../base/common/resources.js';

export const DEFAULT_PROJECT_DOC_MAX_BYTES = 32 * 1024;
export const DEFAULT_AGENT_DELEGATION_LIMITS = Object.freeze({ maxAcceptedChildren: 4, maxConcurrentThreadsPerSession: 2, maxDepth: 1 });
const MAX_AGENT_DELEGATION_LIMIT_DIAGNOSTICS = 8;

export type AgentDelegationLimits = Readonly<{
	maxAcceptedChildren: number;
	maxConcurrentThreadsPerSession: number;
	maxDepth: number;
}>;
export type AgentDelegationLimitDiagnostic = Readonly<{
	source: 'user' | 'project';
	reason: 'agents_not_object' | 'unknown_key' | 'max_accepted_children_invalid' | 'max_concurrent_threads_per_session_invalid' | 'max_concurrent_threads_per_session_exceeds_accepted' | 'max_concurrent_threads_per_session_clamped' | 'max_depth_invalid';
	code: 'agent_delegation_limits_invalid';
}>;

export type AgentInstructionsConfig = Readonly<{
	developerInstructions: string;
	projectDocMaxBytes: number;
	developerInstructionsSource: 'user' | 'project' | 'default';
	projectDocMaxBytesSource: 'user' | 'project' | 'default';
	agentDelegationLimits: AgentDelegationLimits;
	agentDelegationLimitsSource: Readonly<{ maxAcceptedChildren: 'user' | 'project' | 'default'; maxConcurrentThreadsPerSession: 'user' | 'project' | 'default'; maxDepth: 'user' | 'project' | 'default' }>;
	agentDelegationLimitDiagnostics: readonly AgentDelegationLimitDiagnostic[];
	configSources: readonly AgentConfigSourceProvenance[];
	ownerProjectRoot?: string;
	runCwd?: string;
	skillConfigRules: readonly SkillConfigRule[];
	skillConfigDiagnostics: readonly SkillConfigDiagnostic[];
}>;
export type SkillConfigRule = Readonly<{ selector: Readonly<{ kind: 'name' | 'path'; value: string }>; enabled: boolean; source: 'user' | 'project' }>;
export type SkillConfigDiagnostic = Readonly<{ source: 'user' | 'project'; index: number; reason: 'skills_not_object' | 'config_not_array' | 'entry_not_object' | 'unknown_key' | 'enabled_invalid' | 'selector_xor' | 'name_empty' | 'path_not_absolute_skill'; code: 'skill_config_invalid' }>;
export type AgentConfigSourceProvenance = Readonly<{
	uri: string;
	scope: 'user' | 'project';
	status: 'loaded' | 'missing' | 'unreadable' | 'invalid_utf8' | 'malformed';
	projectedKeys: readonly ('developer_instructions' | 'project_doc_max_bytes' | 'skills.config' | 'agents' | 'agents.max_accepted_children' | 'agents.max_concurrent_threads_per_session' | 'agents.max_depth')[];
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
	/** Named-child constraints, separate from the original config and its provenance. */
	additionalDeveloperInstructions?: string;
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

export type ParsedAgentConfig = Readonly<{
	developerInstructions?: string;
	projectDocMaxBytes?: number;
	agentMaxAcceptedChildren?: number;
	agentMaxConcurrentThreadsPerSession?: number;
	agentMaxDepth?: number;
	agentDelegationLimitDiagnostics?: readonly AgentDelegationLimitDiagnostic[];
	agentsConfigPresent?: boolean;
	skillConfigRules?: readonly SkillConfigRule[];
	skillConfigDiagnostics?: readonly SkillConfigDiagnostic[];
	skillsConfigPresent?: boolean;
}>;

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
): AgentInstructionsConfig => {
	const maxAcceptedChildren = project?.agentMaxAcceptedChildren ?? user?.agentMaxAcceptedChildren ?? DEFAULT_AGENT_DELEGATION_LIMITS.maxAcceptedChildren;
	const configuredConcurrent = project?.agentMaxConcurrentThreadsPerSession ?? user?.agentMaxConcurrentThreadsPerSession ?? DEFAULT_AGENT_DELEGATION_LIMITS.maxConcurrentThreadsPerSession;
	const maxAcceptedChildrenSource = project?.agentMaxAcceptedChildren !== undefined ? 'project' : user?.agentMaxAcceptedChildren !== undefined ? 'user' : 'default';
	const maxConcurrentThreadsPerSessionSource = project?.agentMaxConcurrentThreadsPerSession !== undefined ? 'project' : user?.agentMaxConcurrentThreadsPerSession !== undefined ? 'user' : 'default';
	// A default concurrency follows a smaller explicitly configured open capacity.
	// An explicit conflicting value remains visible and is rejected at admission; it
	// must never be silently rewritten into a different user setting.
	const maxConcurrentThreadsPerSession = maxConcurrentThreadsPerSessionSource === 'default' ? Math.min(configuredConcurrent, maxAcceptedChildren) : configuredConcurrent;
	const limitDiagnostics = [...(user?.agentDelegationLimitDiagnostics ?? []), ...(project?.agentDelegationLimitDiagnostics ?? [])];
	if (configuredConcurrent > maxAcceptedChildren && maxConcurrentThreadsPerSessionSource !== 'default' && !limitDiagnostics.some(diagnostic => diagnostic.source === maxConcurrentThreadsPerSessionSource && diagnostic.reason === 'max_concurrent_threads_per_session_exceeds_accepted')) limitDiagnostics.push(Object.freeze({ source: maxConcurrentThreadsPerSessionSource, reason: 'max_concurrent_threads_per_session_exceeds_accepted', code: 'agent_delegation_limits_invalid' }));
	return Object.freeze({
		developerInstructions: project?.developerInstructions ?? user?.developerInstructions ?? '',
		projectDocMaxBytes: project?.projectDocMaxBytes ?? user?.projectDocMaxBytes ?? DEFAULT_PROJECT_DOC_MAX_BYTES,
		developerInstructionsSource: project?.developerInstructions !== undefined ? 'project' : user?.developerInstructions !== undefined ? 'user' : 'default',
		projectDocMaxBytesSource: project?.projectDocMaxBytes !== undefined ? 'project' : user?.projectDocMaxBytes !== undefined ? 'user' : 'default',
		agentDelegationLimits: Object.freeze({ maxAcceptedChildren, maxConcurrentThreadsPerSession, maxDepth: project?.agentMaxDepth ?? user?.agentMaxDepth ?? DEFAULT_AGENT_DELEGATION_LIMITS.maxDepth }),
		agentDelegationLimitsSource: Object.freeze({ maxAcceptedChildren: maxAcceptedChildrenSource, maxConcurrentThreadsPerSession: maxConcurrentThreadsPerSessionSource, maxDepth: project?.agentMaxDepth !== undefined ? 'project' : user?.agentMaxDepth !== undefined ? 'user' : 'default' }),
		agentDelegationLimitDiagnostics: Object.freeze(limitDiagnostics.slice(0, MAX_AGENT_DELEGATION_LIMIT_DIAGNOSTICS)),
		configSources: Object.freeze(configSources.map(source => Object.freeze({ ...source, projectedKeys: Object.freeze([...source.projectedKeys]) }))),
		ownerProjectRoot,
		runCwd,
		skillConfigRules: Object.freeze([...(user?.skillConfigRules ?? []), ...(project?.skillConfigRules ?? [])]),
		skillConfigDiagnostics: Object.freeze([...(user?.skillConfigDiagnostics ?? []), ...(project?.skillConfigDiagnostics ?? [])]),
	});
};

export const projectAgentConfigProjection = (value: unknown): ParsedAgentConfig => {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return Object.freeze({});
	const record = value as Record<string, unknown>;
	const agentDiagnostics: AgentDelegationLimitDiagnostic[] = [];
	const agentsTablePresent = record.agents !== undefined;
	const agentsTable = record.agents && typeof record.agents === 'object' && !Array.isArray(record.agents) ? record.agents as Record<string, unknown> : undefined;
	const agentDiagnostic = (reason: AgentDelegationLimitDiagnostic['reason']) => {
		if (agentDiagnostics.length < MAX_AGENT_DELEGATION_LIMIT_DIAGNOSTICS) agentDiagnostics.push(Object.freeze({ source: 'user', reason, code: 'agent_delegation_limits_invalid' }));
	};
	if (agentsTablePresent && !agentsTable) agentDiagnostic('agents_not_object');
	const strictLimit = (key: 'max_accepted_children' | 'max_concurrent_threads_per_session' | 'max_depth', min: number, reason: AgentDelegationLimitDiagnostic['reason']): number | undefined => {
		if (!agentsTable || agentsTable[key] === undefined) return undefined;
		const raw = agentsTable[key];
		if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < min) { agentDiagnostic(reason); return undefined; }
		return raw;
	};
	if (agentsTable) for (const key of Object.keys(agentsTable)) if (!['max_accepted_children', 'max_concurrent_threads_per_session', 'max_depth'].includes(key)) agentDiagnostic('unknown_key');
	const agentMaxAcceptedChildren = strictLimit('max_accepted_children', 1, 'max_accepted_children_invalid');
	const agentMaxConcurrentThreadsPerSession = strictLimit('max_concurrent_threads_per_session', 1, 'max_concurrent_threads_per_session_invalid');
	if (agentMaxAcceptedChildren !== undefined && agentMaxConcurrentThreadsPerSession !== undefined && agentMaxConcurrentThreadsPerSession > agentMaxAcceptedChildren) agentDiagnostic('max_concurrent_threads_per_session_exceeds_accepted');
	const agentMaxDepth = strictLimit('max_depth', 0, 'max_depth_invalid');
	const rules: SkillConfigRule[] = []; const diagnostics: SkillConfigDiagnostic[] = [];
	const skillTablePresent = record.skills !== undefined;
	const skillTable = record.skills && typeof record.skills === 'object' && !Array.isArray(record.skills) ? record.skills as Record<string, unknown> : undefined;
	if (skillTablePresent && !skillTable) diagnostics.push(Object.freeze({ source: 'user', index: -1, reason: 'skills_not_object', code: 'skill_config_invalid' }));
	const rawConfig = skillTable?.config;
	if (rawConfig !== undefined && !Array.isArray(rawConfig)) diagnostics.push(Object.freeze({ source: 'user', index: -1, reason: 'config_not_array', code: 'skill_config_invalid' }));
	if (Array.isArray(rawConfig)) for (const [index, item] of rawConfig.entries()) {
		const entry = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : undefined;
		const keys = entry ? Object.keys(entry) : []; const name = typeof entry?.name === 'string' ? entry.name.trim() : undefined; const path = typeof entry?.path === 'string' ? entry.path : undefined;
		const diagnostic = (reason: SkillConfigDiagnostic['reason']) => diagnostics.push(Object.freeze({ source: 'user', index, reason, code: 'skill_config_invalid' }));
		if (!entry) { diagnostic('entry_not_object'); continue; }
		if (keys.some(key => !['name', 'path', 'enabled'].includes(key))) { diagnostic('unknown_key'); continue; }
		if (typeof entry.enabled !== 'boolean') { diagnostic('enabled_invalid'); continue; }
		if (!!name === !!path) { diagnostic('selector_xor'); continue; }
		if (name !== undefined && !name) { diagnostic('name_empty'); continue; }
		if (path !== undefined && (!/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(path) || !/SKILL\.md$/i.test(path))) { diagnostic('path_not_absolute_skill'); continue; }
		rules.push(Object.freeze({ selector: Object.freeze(name ? { kind: 'name' as const, value: name } : { kind: 'path' as const, value: path! }), enabled: entry.enabled, source: 'user' }));
	}
	return Object.freeze({
		developerInstructions: typeof record.developer_instructions === 'string' ? record.developer_instructions : undefined,
		projectDocMaxBytes: projectDocMaxBytes(record.project_doc_max_bytes),
		...(agentsTablePresent ? {
			agentMaxAcceptedChildren,
			agentMaxConcurrentThreadsPerSession,
			agentMaxDepth,
			agentDelegationLimitDiagnostics: Object.freeze(agentDiagnostics),
			agentsConfigPresent: true,
		} : {}),
		...(skillTablePresent ? { skillConfigRules: Object.freeze(rules), skillConfigDiagnostics: Object.freeze(diagnostics), skillsConfigPresent: true } : {}),
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
			...(projected?.agentsConfigPresent ? ['agents'] as const : []),
			...(projected?.agentMaxAcceptedChildren !== undefined ? ['agents.max_accepted_children'] as const : []),
			...(projected?.agentMaxConcurrentThreadsPerSession !== undefined ? ['agents.max_concurrent_threads_per_session'] as const : []),
			...(projected?.agentMaxDepth !== undefined ? ['agents.max_depth'] as const : []),
			...(projected?.skillsConfigPresent ? ['skills.config'] as const : []),
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
		const base = projectAgentConfigProjection(parseToml(text));
		const projected: ParsedAgentConfig = Object.freeze({ ...base,
			...(base.agentsConfigPresent ? { agentDelegationLimitDiagnostics: Object.freeze((base.agentDelegationLimitDiagnostics ?? []).map(diagnostic => Object.freeze({ ...diagnostic, source: scope }))) } : {}),
			...(base.skillsConfigPresent ? { skillConfigRules: Object.freeze((base.skillConfigRules ?? []).map(rule => Object.freeze({ ...rule, source: scope }))), skillConfigDiagnostics: Object.freeze((base.skillConfigDiagnostics ?? []).map(diagnostic => Object.freeze({ ...diagnostic, source: scope }))) } : {}),
		});
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
	[snapshot.developerInstructions, snapshot.additionalDeveloperInstructions, snapshot.agentsInstructions].filter(Boolean).join('\n\n');

/**
 * A named child adds constraints to the already-admitted Task/session authority; it never
 * replaces it. Keep the original AGENTS text and provenance intact, while deriving a fresh
 * immutable revision so the runtime snapshot fingerprint cannot be confused with its parent.
 */
export const appendAgentInstructionDeveloperInstructions = (snapshot: AgentInstructionTurnSnapshot, additionalInstructions: string): AgentInstructionTurnSnapshot => {
	const parent = reviveAgentInstructionTurnSnapshot(snapshot);
	if (!parent || typeof additionalInstructions !== 'string' || !additionalInstructions.trim()) throw new Error('agent_instruction_snapshot_invalid');
	const additionalDeveloperInstructions = [parent.additionalDeveloperInstructions, additionalInstructions].filter(Boolean).join('\n\n');
	let value = 2166136261;
	for (const byte of encoder.encode(`${parent.revision}\0${additionalDeveloperInstructions}`)) value = Math.imul(value ^ byte, 16777619);
	const derived = Object.freeze({
		...parent,
		revision: `agents-${(value >>> 0).toString(16)}`,
		additionalDeveloperInstructions,
	});
	const revived = reviveAgentInstructionTurnSnapshot(derived);
	if (!revived) throw new Error('agent_instruction_snapshot_invalid');
	return revived;
};

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
	getConfig(): Promise<AgentInstructionsConfig> { this.configPromise ??= this.loadConfig(); return this.configPromise; }
}

export const inheritAgentInstructionTurnSnapshot = (snapshot: AgentInstructionTurnSnapshot): AgentInstructionTurnSnapshot => snapshot;

export const reviveAgentInstructionTurnSnapshot = (value: unknown): AgentInstructionTurnSnapshot | undefined => {
	const object = (candidate: unknown): Record<string, unknown> | undefined =>
		candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate as Record<string, unknown> : undefined;
	const sourceKeys = new Set(['developer_instructions', 'project_doc_max_bytes', 'skills.config', 'agents', 'agents.max_accepted_children', 'agents.max_concurrent_threads_per_session', 'agents.max_depth']);
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
		|| (root.additionalDeveloperInstructions !== undefined && (typeof root.additionalDeveloperInstructions !== 'string' || !root.additionalDeveloperInstructions.trim()))
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
		|| !object(config.agentDelegationLimits)
		|| !object(config.agentDelegationLimitsSource)
		|| !Array.isArray(config.agentDelegationLimitDiagnostics)
		|| config.ownerProjectRoot !== owner
		|| config.runCwd !== cwd
		|| !Array.isArray(config.configSources)
		|| !Array.isArray(config.skillConfigRules)
		|| !Array.isArray(config.skillConfigDiagnostics)
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
			projectedKeys: Object.freeze([...source.projectedKeys] as ('developer_instructions' | 'project_doc_max_bytes' | 'skills.config' | 'agents' | 'agents.max_accepted_children' | 'agents.max_concurrent_threads_per_session' | 'agents.max_depth')[]),
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

	const rawLimits = object(config.agentDelegationLimits)!;
	const rawLimitSources = object(config.agentDelegationLimitsSource)!;
	const limitNames = ['maxAcceptedChildren', 'maxConcurrentThreadsPerSession', 'maxDepth'] as const;
	const limitsValid = Number.isSafeInteger(rawLimits.maxAcceptedChildren) && (rawLimits.maxAcceptedChildren as number) >= 1
		&& Number.isSafeInteger(rawLimits.maxConcurrentThreadsPerSession) && (rawLimits.maxConcurrentThreadsPerSession as number) >= 1
		&& Number.isSafeInteger(rawLimits.maxDepth) && (rawLimits.maxDepth as number) >= 0
		&& Object.keys(rawLimits).length === 3 && Object.keys(rawLimitSources).length === 3
		&& limitNames.every(name => ['user', 'project', 'default'].includes(rawLimitSources[name] as string));
	if (!limitsValid) return undefined;
	const limitSourceKey: Record<typeof limitNames[number], string> = { maxAcceptedChildren: 'agents.max_accepted_children', maxConcurrentThreadsPerSession: 'agents.max_concurrent_threads_per_session', maxDepth: 'agents.max_depth' };
	if (!limitNames.every(name => rawLimitSources[name] === expected(limitSourceKey[name]))) return undefined;
	if ((rawLimitSources.maxAcceptedChildren === 'default' && rawLimits.maxAcceptedChildren !== DEFAULT_AGENT_DELEGATION_LIMITS.maxAcceptedChildren)
		|| (rawLimitSources.maxConcurrentThreadsPerSession === 'default' && rawLimits.maxConcurrentThreadsPerSession !== Math.min(DEFAULT_AGENT_DELEGATION_LIMITS.maxConcurrentThreadsPerSession, rawLimits.maxAcceptedChildren as number))
		|| (rawLimitSources.maxDepth === 'default' && rawLimits.maxDepth !== DEFAULT_AGENT_DELEGATION_LIMITS.maxDepth)) return undefined;
	const reviveLimitDiagnostic = (raw: unknown): AgentDelegationLimitDiagnostic | undefined => {
		const diagnostic = object(raw); const reasons = new Set(['agents_not_object', 'unknown_key', 'max_accepted_children_invalid', 'max_concurrent_threads_per_session_invalid', 'max_concurrent_threads_per_session_exceeds_accepted', 'max_concurrent_threads_per_session_clamped', 'max_depth_invalid']);
		if (!diagnostic || Object.keys(diagnostic).length !== 3 || !['user', 'project'].includes(diagnostic.source as string) || !reasons.has(diagnostic.reason as string) || diagnostic.code !== 'agent_delegation_limits_invalid') return undefined;
		return Object.freeze({ source: diagnostic.source as 'user' | 'project', reason: diagnostic.reason as AgentDelegationLimitDiagnostic['reason'], code: 'agent_delegation_limits_invalid' });
	};
	const limitDiagnostics = config.agentDelegationLimitDiagnostics.map(reviveLimitDiagnostic);
	if (limitDiagnostics.length > MAX_AGENT_DELEGATION_LIMIT_DIAGNOSTICS * 2 || limitDiagnostics.some(diagnostic => !diagnostic) || (limitDiagnostics as (AgentDelegationLimitDiagnostic | undefined)[]).some(diagnostic => !loaded(diagnostic!.source, 'agents'))) return undefined;

	const reviveRule = (raw: unknown): SkillConfigRule | undefined => {
		const rule = object(raw); const selector = object(rule?.selector);
		if (!rule || !selector || Object.keys(rule).length !== 3 || Object.keys(selector).length !== 2 || typeof rule.enabled !== 'boolean' || !['user', 'project'].includes(rule.source as string) || !['name', 'path'].includes(selector.kind as string) || typeof selector.value !== 'string' || !selector.value) return undefined;
		if (selector.kind === 'name' && selector.value !== selector.value.trim()) return undefined;
		if (selector.kind === 'path' && (!/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(selector.value as string) || !/SKILL\.md$/i.test(selector.value as string))) return undefined;
		return Object.freeze({ selector: Object.freeze({ kind: selector.kind as 'name' | 'path', value: selector.value as string }), enabled: rule.enabled, source: rule.source as 'user' | 'project' });
	};
	const reviveDiagnostic = (raw: unknown): SkillConfigDiagnostic | undefined => {
		const diagnostic = object(raw); const reasons = new Set(['skills_not_object', 'config_not_array', 'entry_not_object', 'unknown_key', 'enabled_invalid', 'selector_xor', 'name_empty', 'path_not_absolute_skill']);
		if (!diagnostic || Object.keys(diagnostic).length !== 4 || !['user', 'project'].includes(diagnostic.source as string) || !Number.isSafeInteger(diagnostic.index) || (diagnostic.index as number) < -1 || !reasons.has(diagnostic.reason as string) || diagnostic.code !== 'skill_config_invalid') return undefined;
		return Object.freeze({ source: diagnostic.source as 'user' | 'project', index: diagnostic.index as number, reason: diagnostic.reason as SkillConfigDiagnostic['reason'], code: 'skill_config_invalid' });
	};
	const rules = config.skillConfigRules.map(reviveRule); const diagnostics = config.skillConfigDiagnostics.map(reviveDiagnostic);
	if (rules.some(rule => !rule) || diagnostics.some(diagnostic => !diagnostic)) return undefined;
	const loadedSkillsConfig = (scope: 'user' | 'project') => revivedConfigSources.some(source => source.scope === scope && source.status === 'loaded' && source.projectedKeys.includes('skills.config'));
	if ((rules as (SkillConfigRule | undefined)[]).some(rule => !loadedSkillsConfig(rule!.source)) || (diagnostics as (SkillConfigDiagnostic | undefined)[]).some(diagnostic => !loadedSkillsConfig(diagnostic!.source))) return undefined;
	const revivedConfig: AgentInstructionsConfig = Object.freeze({
		developerInstructions: config.developerInstructions as string,
		projectDocMaxBytes: config.projectDocMaxBytes as number,
		developerInstructionsSource: config.developerInstructionsSource as AgentInstructionsConfig['developerInstructionsSource'],
		projectDocMaxBytesSource: config.projectDocMaxBytesSource as AgentInstructionsConfig['projectDocMaxBytesSource'],
		agentDelegationLimits: Object.freeze({ maxAcceptedChildren: rawLimits.maxAcceptedChildren as number, maxConcurrentThreadsPerSession: rawLimits.maxConcurrentThreadsPerSession as number, maxDepth: rawLimits.maxDepth as number }),
		agentDelegationLimitsSource: Object.freeze({ maxAcceptedChildren: rawLimitSources.maxAcceptedChildren as 'user' | 'project' | 'default', maxConcurrentThreadsPerSession: rawLimitSources.maxConcurrentThreadsPerSession as 'user' | 'project' | 'default', maxDepth: rawLimitSources.maxDepth as 'user' | 'project' | 'default' }),
		agentDelegationLimitDiagnostics: Object.freeze(limitDiagnostics as AgentDelegationLimitDiagnostic[]),
		configSources: Object.freeze(revivedConfigSources),
		ownerProjectRoot: owner as string | undefined,
		runCwd: cwd as string | undefined,
		skillConfigRules: Object.freeze(rules as SkillConfigRule[]),
		skillConfigDiagnostics: Object.freeze(diagnostics as SkillConfigDiagnostic[]),
	});
	return Object.freeze({
		revision: root.revision,
		config: revivedConfig,
		ownerProjectRoot: owner as string | undefined,
		runCwd: cwd as string | undefined,
		developerInstructions: root.developerInstructions,
		...(root.additionalDeveloperInstructions === undefined ? {} : { additionalDeveloperInstructions: root.additionalDeveloperInstructions as string }),
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
	add(`${config.developerInstructions}\0${config.projectDocMaxBytes}\0${config.developerInstructionsSource}\0${config.projectDocMaxBytesSource}\0${config.agentDelegationLimits.maxAcceptedChildren}:${config.agentDelegationLimits.maxConcurrentThreadsPerSession}:${config.agentDelegationLimits.maxDepth}\0${config.agentDelegationLimitsSource.maxAcceptedChildren}:${config.agentDelegationLimitsSource.maxConcurrentThreadsPerSession}:${config.agentDelegationLimitsSource.maxDepth}\0${config.agentDelegationLimitDiagnostics.map(diagnostic => `${diagnostic.source}:${diagnostic.reason}:${diagnostic.code}`).join(',')}\0${config.ownerProjectRoot ?? ''}\0${config.runCwd ?? ''}\0${config.skillConfigRules.map(rule => `${rule.source}:${rule.selector.kind}:${rule.selector.value}:${rule.enabled}`).join(',')}\0${config.skillConfigDiagnostics.map(diagnostic => `${diagnostic.source}:${diagnostic.index}:${diagnostic.reason}:${diagnostic.code}`).join(',')}`);
	for (const source of config.configSources) add(`\0${source.uri}\0${source.scope}\0${source.status}\0${source.projectedKeys.join(',')}`);
	for (const candidate of candidates) {
		add(`\0${candidate.uri}\0${candidate.outcome.status}`);
		if (candidate.outcome.status === 'bytes') {
			for (const byte of candidate.outcome.bytes) hash = Math.imul(hash ^ byte, 16777619);
		}
	}
	return `agents-${(hash >>> 0).toString(16)}`;
};
