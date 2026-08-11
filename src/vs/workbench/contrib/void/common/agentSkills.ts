/*---------------------------------------------------------------------------------------------
 *  Strict, metadata-only Agent Skills catalog helpers. File-system access intentionally lives
 *  in the browser service so this module remains deterministic and fixture-friendly.
 *--------------------------------------------------------------------------------------------*/
import type * as YAML from 'yaml';
import { URI } from '../../../../base/common/uri.js';
// @ts-ignore -- yaml's browser entry intentionally has no separate declaration file.
import * as YAMLRuntime from '../../../../../../node_modules/yaml/browser/index.js';
import { AgentInstructionTurnSnapshot, reviveAgentInstructionTurnSnapshot } from './agentInstructions.js';
const parse: typeof YAML.parse = YAMLRuntime.parse as typeof YAML.parse;

export type SkillSource = 'repository' | 'user' | 'bundled' | 'plugin';
export type SkillDiagnostic = Readonly<{ code: string; detail?: string; identity?: string }>;
export type SkillProvenance = Readonly<{ source: SkillSource; rank: number; root: string; skillRoot: string; pluginName?: string }>;
export type AgentSkill = Readonly<{
	identity: string;
	name: string;
	description: string;
	provenance: SkillProvenance;
	bodyRevision: string;
	implicit: boolean;
}>;
export type AgentSkillCatalog = Readonly<{ revision: string; skills: readonly AgentSkill[]; diagnostics: readonly SkillDiagnostic[] }>;
export type SkillCandidate = Readonly<{ source: SkillSource; rank: number; root: string; skillRoot: string; directoryName: string; bytes: Uint8Array; pluginName?: string; openaiMetadata?: Uint8Array }>;

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();
const skillName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const freeze = <T>(value: T): T => Object.freeze(value);
const hash = (parts: readonly (string | Uint8Array)[]): string => {
	let value = 2166136261;
	for (const part of parts) for (const byte of typeof part === 'string' ? encoder.encode(part) : part) value = Math.imul(value ^ byte, 16777619);
	return `skills-${(value >>> 0).toString(16)}`;
};
export const skillBodyRevision = (body: string): string => hash([body]);

/** Pure containment check; the browser service owns the eventual file read and missing-file semantics. */
export const resolveSkillResourceSegments = (resourcePath: string): readonly string[] | undefined => {
	if (!resourcePath || resourcePath.includes('\\') || resourcePath.startsWith('/') || /^[A-Za-z]:/.test(resourcePath) || /%2f|%5c/i.test(resourcePath)) return undefined;
	try { resourcePath = decodeURIComponent(resourcePath); } catch { return undefined; }
	const segments = resourcePath.split('/');
	return segments.some(segment => !segment || segment === '.' || segment === '..') ? undefined : freeze(segments);
};

export const strictSkillFromCandidate = (candidate: SkillCandidate): { skill?: AgentSkill; diagnostics: readonly SkillDiagnostic[] } => {
	let text: string;
	try { text = decoder.decode(candidate.bytes); }
	catch { return freeze({ diagnostics: freeze([{ code: 'skill_invalid_utf8', detail: candidate.skillRoot }]) }); }
	// The YAML parser must only receive the frontmatter, never the Markdown body.
	const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
	let document: unknown;
	try { document = frontmatter === undefined ? undefined : parse(frontmatter); }
	catch { return freeze({ diagnostics: freeze([{ code: 'skill_invalid_frontmatter', detail: candidate.skillRoot }]) }); }
	if (!document || typeof document !== 'object' || Array.isArray(document)) return freeze({ diagnostics: freeze([{ code: 'skill_invalid_frontmatter', detail: candidate.skillRoot }]) });
	const record = document as Record<string, unknown>;
	const name = record.name;
	const description = record.description;
	if (typeof name !== 'string' || name.length < 1 || name.length > 64 || !skillName.test(name) || name !== candidate.directoryName) return freeze({ diagnostics: freeze([{ code: 'skill_invalid_name', detail: candidate.skillRoot }]) });
	if (typeof description !== 'string' || description.length < 1 || description.length > 1024 || !description.trim()) return freeze({ diagnostics: freeze([{ code: 'skill_invalid_description', detail: candidate.skillRoot }]) });
	let implicit = true;
	const diagnostics: SkillDiagnostic[] = [];
	if (candidate.openaiMetadata !== undefined) {
		try {
			const metadata = parse(decoder.decode(candidate.openaiMetadata));
			if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('metadata_not_mapping');
			const policy = (metadata as Record<string, unknown>).policy;
			if (policy !== undefined) {
				if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new Error('policy_not_mapping');
				const allowed = (policy as Record<string, unknown>).allow_implicit_invocation;
				if (allowed !== undefined && typeof allowed !== 'boolean') throw new Error('implicit_not_boolean');
				if (typeof allowed === 'boolean') implicit = allowed;
			}
		} catch { diagnostics.push(freeze({ code: 'skill_optional_metadata_invalid', detail: candidate.skillRoot })); }
	}
	const identity = candidate.pluginName ? `${candidate.pluginName}:${name}` : name;
	return freeze({ skill: freeze({ identity, name, description, provenance: freeze({ source: candidate.source, rank: candidate.rank, root: candidate.root, skillRoot: candidate.skillRoot, ...(candidate.pluginName ? { pluginName: candidate.pluginName } : {}) }), bodyRevision: hash([candidate.bytes]), implicit }), diagnostics: freeze(diagnostics) });
};

/** Build-facing seam: core bundled descriptors are fatal, optional metadata remains fail-open. */
export const validateBundledSkillCandidates = (candidates: readonly SkillCandidate[]): { valid: boolean; diagnostics: readonly SkillDiagnostic[] } => {
	const diagnostics: SkillDiagnostic[] = [];
	for (const candidate of candidates) {
		const result = strictSkillFromCandidate(candidate);
		diagnostics.push(...result.diagnostics);
		if (!result.skill) diagnostics.push(freeze({ code: 'skill_bundled_invalid', detail: candidate.skillRoot }));
	}
	return freeze({ valid: !diagnostics.some(diagnostic => diagnostic.code === 'skill_bundled_invalid'), diagnostics: freeze(diagnostics) });
};

const compareSkills = (a: AgentSkill, b: AgentSkill): number => a.provenance.rank - b.provenance.rank || a.provenance.root.localeCompare(b.provenance.root) || a.provenance.skillRoot.localeCompare(b.provenance.skillRoot) || a.identity.localeCompare(b.identity);

export const createSkillCatalog = (candidates: readonly SkillCandidate[]): AgentSkillCatalog => {
	const skills: AgentSkill[] = [], diagnostics: SkillDiagnostic[] = [];
	for (const candidate of candidates) {
		const result = strictSkillFromCandidate(candidate);
		if (result.skill) skills.push(result.skill);
		diagnostics.push(...result.diagnostics);
	}
	skills.sort(compareSkills);
	return freeze({ revision: hash(skills.flatMap(skill => [skill.identity, skill.description, skill.bodyRevision, String(skill.provenance.rank), skill.provenance.skillRoot])), skills: freeze(skills), diagnostics: freeze(diagnostics) });
};
/** Rebuild after policy filtering; never retain mutable storage/service objects in a snapshot. */
export const rebuildAgentSkillCatalog = (skills: readonly AgentSkill[], diagnostics: readonly SkillDiagnostic[]): AgentSkillCatalog => {
	const rebuilt: AgentSkill[] = [];
	for (const skill of skills) {
		if (!skillName.test(skill.name) || skill.name.length > 64 || typeof skill.identity !== 'string' || typeof skill.description !== 'string' || !skill.description.trim() || skill.description.length > 1024 || typeof skill.bodyRevision !== 'string' || !skill.bodyRevision || !skill.provenance || !['repository', 'user', 'bundled', 'plugin'].includes(skill.provenance.source) || !Number.isSafeInteger(skill.provenance.rank) || skill.provenance.rank < 0 || !skill.provenance.root || !skill.provenance.skillRoot) throw new Error('skill_catalog_invalid');
		if ((skill.provenance.source === 'plugin') !== !!skill.provenance.pluginName || (skill.provenance.pluginName && skill.identity !== `${skill.provenance.pluginName}:${skill.name}`)) throw new Error('skill_catalog_invalid');
		rebuilt.push(freeze({ ...skill, provenance: freeze({ ...skill.provenance }) }));
	}
	const rebuiltDiagnostics = diagnostics.map(diagnostic => freeze({ ...diagnostic }));
	rebuilt.sort(compareSkills);
	return freeze({ revision: hash([...rebuilt.flatMap(skill => [skill.identity, skill.name, skill.description, skill.bodyRevision, skill.provenance.source, String(skill.provenance.rank), skill.provenance.root, skill.provenance.skillRoot, skill.implicit ? '1' : '0']), ...rebuiltDiagnostics.flatMap(diagnostic => [diagnostic.code, diagnostic.detail ?? '', diagnostic.identity ?? ''])]), skills: freeze(rebuilt), diagnostics: freeze(rebuiltDiagnostics) });
};

export const resolveSkillSelector = (catalog: AgentSkillCatalog, selector: string): { skill?: AgentSkill; diagnostic?: SkillDiagnostic } => {
	const exact = catalog.skills.filter(skill => skill.identity === selector);
	if (selector.includes(':')) return exact.length === 1 ? freeze({ skill: exact[0] }) : exact.length === 0 ? freeze({ diagnostic: freeze({ code: 'skill_not_found', identity: selector }) }) : freeze({ diagnostic: freeze({ code: 'skill_ambiguous', identity: selector }) });
	const bare = catalog.skills.filter(skill => skill.name === selector);
	return bare.length === 1 ? freeze({ skill: bare[0] }) : bare.length === 0 ? freeze({ diagnostic: freeze({ code: 'skill_not_found', identity: selector }) }) : freeze({ diagnostic: freeze({ code: 'skill_ambiguous', identity: selector }) });
};

/** `$qualified-skill` tokens are direct invocations; the first occurrence wins. */
export const explicitSkillSelectors = (text: string): readonly string[] => {
	const selected: string[] = []; const seen = new Set<string>();
	for (const match of text.matchAll(/\$([a-z0-9]+(?:-[a-z0-9]+)*(?::[a-z0-9]+(?:-[a-z0-9]+)*)?)/g)) {
		const selector = match[1]; if (!seen.has(selector)) { seen.add(selector); selected.push(selector); }
	}
	return freeze(selected);
};

export const selectExplicitSkills = (catalog: AgentSkillCatalog, text: string): { skills?: readonly AgentSkill[]; diagnostic?: SkillDiagnostic } => {
	const selected: AgentSkill[] = [];
	for (const selector of explicitSkillSelectors(text)) { const result = resolveSkillSelector(catalog, selector); if (!result.skill) return freeze({ diagnostic: result.diagnostic }); selected.push(result.skill); }
	return freeze({ skills: freeze(selected) });
};

export type SkillAdvertisement = Readonly<{ text: string; used: number; limit: number; omitted: number; diagnostic?: SkillDiagnostic }>;
export type AgentRuntimeTurnSnapshot = Readonly<{
	schemaVersion: 2;
	revision: string;
	instructions: AgentInstructionTurnSnapshot;
	catalog: AgentSkillCatalog;
	advertisement: SkillAdvertisement;
	selected: readonly Readonly<{ identity: string; skillRoot: string; bodyRevision: string; body: string }> [];
	model: RuntimeModel;
	ownerProjectRoot: string | undefined;
	runCwd: string | undefined;
	workspaceTrustedAtAdmission: boolean;
}>;
export type RuntimeModelOptions = Readonly<{ reasoningEnabled?: boolean; reasoningBudget?: number; reasoningEffort?: string }>;
export type RuntimeJsonValue = null | boolean | number | string | readonly RuntimeJsonValue[] | Readonly<{ [key: string]: RuntimeJsonValue }>;
export type RuntimeModel = Readonly<{ hasModel: false; fingerprint: string }> | Readonly<{ hasModel: true; providerName: string; modelName: string; contextWindow: number; reservedOutputTokens: number; modelSelectionOptions: RuntimeModelOptions; selectedModelOverrides: Readonly<{ [key: string]: RuntimeJsonValue }>; fingerprint: string }>;
const jsonClone = (value: unknown): RuntimeJsonValue | undefined => {
	if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
	if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
	if (Array.isArray(value)) { const items = value.map(jsonClone); return items.some(item => item === undefined) ? undefined : Object.freeze(items as RuntimeJsonValue[]); }
	if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
	const result: Record<string, RuntimeJsonValue> = {}; for (const key of Object.keys(value).sort()) { const item = jsonClone((value as Record<string, unknown>)[key]); if (item === undefined) return undefined; result[key] = item; } return Object.freeze(result);
};
const normalizeRuntimeModelOptions = (value: unknown): RuntimeModelOptions | undefined => {
	if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
	const options = value as Record<string, unknown>;
	if (Object.keys(options).some(key => !['reasoningEnabled', 'reasoningBudget', 'reasoningEffort'].includes(key))) return undefined;
	if (options.reasoningEnabled !== undefined && typeof options.reasoningEnabled !== 'boolean') return undefined;
	if (options.reasoningBudget !== undefined && (!Number.isFinite(options.reasoningBudget) || (options.reasoningBudget as number) < 0)) return undefined;
	if (options.reasoningEffort !== undefined && (typeof options.reasoningEffort !== 'string' || !options.reasoningEffort)) return undefined;
	return freeze({
		...(options.reasoningEnabled === undefined ? {} : { reasoningEnabled: options.reasoningEnabled as boolean }),
		...(options.reasoningBudget === undefined ? {} : { reasoningBudget: options.reasoningBudget as number }),
		...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort as string }),
	});
};
const canonicalJson = (value: RuntimeJsonValue): string => typeof value === 'object' && value !== null ? Array.isArray(value) ? `[${value.map(canonicalJson).join(',')}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Readonly<{ [key: string]: RuntimeJsonValue }>)[key])}`).join(',')}}` : JSON.stringify(value);
export const runtimeModelFingerprint = (model: Omit<Extract<RuntimeModel, { hasModel: true }>, 'fingerprint' | 'hasModel'>): string => hash([model.providerName, model.modelName, String(model.contextWindow), String(model.reservedOutputTokens), canonicalJson(model.modelSelectionOptions as RuntimeJsonValue), canonicalJson(model.selectedModelOverrides)]);
export const createAgentRuntimeTurnSnapshot = (instructions: AgentInstructionTurnSnapshot, catalog: AgentSkillCatalog, _advertisement: SkillAdvertisement, selected: readonly Readonly<{ identity: string; skillRoot: string; bodyRevision: string; body: string }> [], model: Omit<Extract<RuntimeModel, { hasModel: true }>, 'fingerprint'> | { hasModel: false }, workspaceTrustedAtAdmission: boolean): AgentRuntimeTurnSnapshot => {
	if (typeof workspaceTrustedAtAdmission !== 'boolean') throw new Error('skill_runtime_trust_invalid');
	const revivedInstructions = reviveAgentInstructionTurnSnapshot(instructions);
	if (!revivedInstructions) throw new Error('agent_instruction_snapshot_invalid');
	const rebuiltCatalog = rebuildAgentSkillCatalog(catalog.skills, catalog.diagnostics);
	const identities = new Set<string>();
	for (const item of selected) if (identities.has(item.identity) || skillBodyRevision(item.body) !== item.bodyRevision || !rebuiltCatalog.skills.some(skill => skill.identity === item.identity && skill.provenance.skillRoot === item.skillRoot && skill.bodyRevision === item.bodyRevision)) throw new Error('skill_runtime_selection_invalid'); else identities.add(item.identity);
	const frozenSelected = Object.freeze(selected.map(item => Object.freeze({ ...item })));
	const overrides = model.hasModel ? jsonClone(model.selectedModelOverrides) : undefined;
	const options = model.hasModel ? normalizeRuntimeModelOptions(model.modelSelectionOptions) : undefined;
	if (model.hasModel && (typeof model.providerName !== 'string' || !model.providerName || typeof model.modelName !== 'string' || !model.modelName || !Number.isSafeInteger(model.contextWindow) || model.contextWindow < 0 || !Number.isSafeInteger(model.reservedOutputTokens) || model.reservedOutputTokens < 0 || !options || !overrides || Array.isArray(overrides) || typeof overrides !== 'object')) throw new Error('skill_runtime_model_invalid');
	const normalizedModel: RuntimeModel = model.hasModel ? freeze({ ...model, modelSelectionOptions: options!, selectedModelOverrides: overrides as Readonly<{ [key: string]: RuntimeJsonValue }>, fingerprint: runtimeModelFingerprint({ ...model, modelSelectionOptions: options!, selectedModelOverrides: overrides as Readonly<{ [key: string]: RuntimeJsonValue }> }) }) : freeze({ hasModel: false, fingerprint: hash(['no-model']) });
	const advertisement = skillAdvertisement(rebuiltCatalog, normalizedModel.hasModel ? normalizedModel.contextWindow : undefined);
	const revision = hash([revivedInstructions.revision, rebuiltCatalog.revision, advertisement.text, ...frozenSelected.flatMap(item => [item.identity, item.skillRoot, item.bodyRevision, item.body]), normalizedModel.fingerprint, workspaceTrustedAtAdmission ? 'trusted' : 'untrusted']);
	return freeze({ schemaVersion: 2, revision, instructions: revivedInstructions, catalog: rebuiltCatalog, advertisement, selected: frozenSelected, model: normalizedModel, ownerProjectRoot: revivedInstructions.ownerProjectRoot, runCwd: revivedInstructions.runCwd, workspaceTrustedAtAdmission });
};
export const reviveAgentRuntimeTurnSnapshot = (value: unknown): AgentRuntimeTurnSnapshot | undefined => {
	const object = (candidate: unknown): Record<string, unknown> | undefined => candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate as Record<string, unknown> : undefined;
	const isUri = (candidate: unknown): candidate is string => { if (typeof candidate !== 'string' || !candidate) return false; try { const uri = URI.parse(candidate, true); return !!uri.scheme && (uri.path.startsWith('/') || !!uri.authority); } catch { return false; } };
	const raw = object(value); if (!raw || raw.schemaVersion !== 2 || typeof raw.workspaceTrustedAtAdmission !== 'boolean' || !Array.isArray(raw.selected) || !object(raw.catalog) || !object(raw.advertisement) || !object(raw.model)) return undefined;
	const instructions = reviveAgentInstructionTurnSnapshot(raw.instructions); if (!instructions || raw.ownerProjectRoot !== instructions.ownerProjectRoot || raw.runCwd !== instructions.runCwd) return undefined;
	const rawCatalog = raw.catalog as Record<string, unknown>; if (!Array.isArray(rawCatalog.skills) || !Array.isArray(rawCatalog.diagnostics) || typeof rawCatalog.revision !== 'string') return undefined;
	const skills: AgentSkill[] = [];
	for (const value of rawCatalog.skills) {
		const entry = object(value); const provenance = object(entry?.provenance); if (!entry || !provenance || typeof entry.identity !== 'string' || typeof entry.name !== 'string' || !skillName.test(entry.name) || entry.name.length > 64 || typeof entry.description !== 'string' || !entry.description.trim() || entry.description.length > 1024 || typeof entry.bodyRevision !== 'string' || !entry.bodyRevision || typeof entry.implicit !== 'boolean' || !['repository', 'user', 'bundled', 'plugin'].includes(provenance.source as string) || !Number.isSafeInteger(provenance.rank) || (provenance.rank as number) < 0 || !isUri(provenance.root) || !isUri(provenance.skillRoot) || (provenance.pluginName !== undefined && typeof provenance.pluginName !== 'string')) return undefined;
		const source = provenance.source as SkillSource; const pluginName = provenance.pluginName as string | undefined;
		if ((source === 'plugin') !== !!pluginName || (pluginName && (!skillName.test(pluginName) || entry.identity !== `${pluginName}:${entry.name}`)) || (!pluginName && entry.identity !== entry.name)) return undefined;
		skills.push({ identity: entry.identity, name: entry.name, description: entry.description, bodyRevision: entry.bodyRevision, implicit: entry.implicit, provenance: { source, rank: provenance.rank as number, root: provenance.root as string, skillRoot: provenance.skillRoot as string, ...(pluginName ? { pluginName } : {}) } });
	}
	const diagnostics: SkillDiagnostic[] = [];
	for (const value of rawCatalog.diagnostics) { const entry = object(value); if (!entry || typeof entry.code !== 'string' || (entry.detail !== undefined && typeof entry.detail !== 'string') || (entry.identity !== undefined && typeof entry.identity !== 'string')) return undefined; diagnostics.push({ code: entry.code, ...(entry.detail === undefined ? {} : { detail: entry.detail }), ...(entry.identity === undefined ? {} : { identity: entry.identity }) }); }
	let catalog: AgentSkillCatalog; try { catalog = rebuildAgentSkillCatalog(skills, diagnostics); } catch { return undefined; }
	if (catalog.revision !== rawCatalog.revision) return undefined;
	const rawModel = raw.model as Record<string, unknown>; let model: Omit<Extract<RuntimeModel, { hasModel: true }>, 'fingerprint'> | { hasModel: false };
	if (rawModel.hasModel === false) model = { hasModel: false };
	else {
		const options = normalizeRuntimeModelOptions(rawModel.modelSelectionOptions); const overrides = jsonClone(rawModel.selectedModelOverrides); if (rawModel.hasModel !== true || typeof rawModel.providerName !== 'string' || !rawModel.providerName || typeof rawModel.modelName !== 'string' || !rawModel.modelName || !Number.isSafeInteger(rawModel.contextWindow) || (rawModel.contextWindow as number) < 0 || !Number.isSafeInteger(rawModel.reservedOutputTokens) || (rawModel.reservedOutputTokens as number) < 0 || !options || !overrides || Array.isArray(overrides) || typeof overrides !== 'object') return undefined;
		model = { hasModel: true, providerName: rawModel.providerName, modelName: rawModel.modelName, contextWindow: rawModel.contextWindow as number, reservedOutputTokens: rawModel.reservedOutputTokens as number, modelSelectionOptions: options, selectedModelOverrides: overrides as Readonly<{ [key: string]: RuntimeJsonValue }> };
	}
	const expectedAdvertisement = skillAdvertisement(catalog, model.hasModel ? model.contextWindow : undefined); const rawAd = raw.advertisement as Record<string, unknown>;
	if (rawAd.text !== expectedAdvertisement.text || rawAd.used !== expectedAdvertisement.used || rawAd.limit !== expectedAdvertisement.limit || rawAd.omitted !== expectedAdvertisement.omitted || JSON.stringify(rawAd.diagnostic ?? null) !== JSON.stringify(expectedAdvertisement.diagnostic ?? null)) return undefined;
	const selected: { identity: string; skillRoot: string; bodyRevision: string; body: string }[] = []; const identities = new Set<string>();
	for (const value of raw.selected) { const entry = object(value); if (!entry || typeof entry.identity !== 'string' || typeof entry.skillRoot !== 'string' || typeof entry.bodyRevision !== 'string' || typeof entry.body !== 'string' || skillBodyRevision(entry.body) !== entry.bodyRevision || identities.has(entry.identity) || !catalog.skills.some(skill => skill.identity === entry.identity && skill.provenance.skillRoot === entry.skillRoot && skill.bodyRevision === entry.bodyRevision)) return undefined; identities.add(entry.identity); selected.push({ identity: entry.identity, skillRoot: entry.skillRoot, bodyRevision: entry.bodyRevision, body: entry.body }); }
	const revived = createAgentRuntimeTurnSnapshot(instructions, catalog, expectedAdvertisement, selected, model, raw.workspaceTrustedAtAdmission as boolean);
	return raw.revision === revived.revision && rawModel.fingerprint === revived.model.fingerprint ? revived : undefined;
};
export const skillAdvertisement = (catalog: AgentSkillCatalog, contextWindow: number | undefined): SkillAdvertisement => {
	const limit = contextWindow === undefined ? 8000 : Math.max(0, Math.floor(contextWindow * 0.02 * 4));
	const lines: string[] = []; let used = 0; let omitted = 0;
	for (const skill of catalog.skills.filter(skill => skill.implicit)) {
		const prefix = `- identity=${skill.identity}; name=${skill.name}; source=${skill.provenance.source}; root=${skill.provenance.skillRoot}; description=`;
		const available = limit - used - (lines.length ? 1 : 0) - prefix.length;
		if (available < 0) { omitted++; continue; }
		const description = skill.description.length > available ? skill.description.slice(0, available) : skill.description;
		const line = prefix + description;
		if (line.length + used + (lines.length ? 1 : 0) > limit) { omitted++; continue; }
		lines.push(line); used += line.length + (lines.length === 1 ? 0 : 1);
	}
	return freeze({ text: lines.join('\n'), used, limit, omitted, ...(omitted ? { diagnostic: freeze({ code: 'skill_catalog_omitted', detail: `budget:${used}/${limit}; omitted:${omitted}` }) } : {}) });
};

/** Authority is immutable and admitted before history mutation; bodies remain byte-for-byte text. */
export const assembleProtectedAgentAuthority = (snapshot: AgentRuntimeTurnSnapshot): string => [snapshot.instructions.developerInstructions, snapshot.instructions.agentsInstructions, ...snapshot.selected.map(selection => selection.body), snapshot.advertisement.text].filter(Boolean).join('\n\n');
export const admitProtectedAgentAuthority = (snapshot: AgentRuntimeTurnSnapshot): string => {
	const authority = assembleProtectedAgentAuthority(snapshot);
	if (!snapshot.model.hasModel) { if (snapshot.selected.length) throw new Error('skill_context_admission_failed'); return authority; }
	if (authority.length > Math.max(0, snapshot.model.contextWindow - snapshot.model.reservedOutputTokens) * 4) throw new Error('skill_context_admission_failed');
	return authority;
};
