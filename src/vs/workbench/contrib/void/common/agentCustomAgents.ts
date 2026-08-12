/*---------------------------------------------------------------------------------------------
 * Strict, metadata-only custom-agent helpers. Discovery and file I/O live in the browser.
 *--------------------------------------------------------------------------------------------*/
export type CustomAgentDiagnostic = Readonly<{ code: string; detail: string; identity?: string }>;
export type CustomAgentSkillRule = Readonly<{ selector: string; enabled: boolean }>;
export type CustomAgent = Readonly<{ identity: string; name: string; description: string; developerInstructions: string; model?: string; modelReasoningEffort?: string; skillRules?: readonly CustomAgentSkillRule[]; revision: string; provenance: Readonly<{ scope: 'user' | 'project'; uri: string }> }>;
export type CustomAgentCatalog = Readonly<{ revision: string; agents: readonly CustomAgent[]; diagnostics: readonly CustomAgentDiagnostic[] }>;
export type CustomAgentCandidate = Readonly<{ scope: 'user' | 'project'; uri: string; filename: string; text: string; parsed: unknown }>;

const encoder = new TextEncoder();
const hash = (values: readonly string[]): string => { let n = 2166136261; for (const value of values) for (const byte of encoder.encode(value)) n = Math.imul(n ^ byte, 16777619); return `agents-${(n >>> 0).toString(16)}`; };
const identity = /^[a-z][a-z0-9_-]{0,63}$/;
const effort = new Set(['low', 'medium', 'high', 'xhigh']);
const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const freeze = <T>(value: T): T => Object.freeze(value);

export const strictCustomAgent = (candidate: CustomAgentCandidate): { agent?: CustomAgent; diagnostics: readonly CustomAgentDiagnostic[] } => {
	const invalid = (code: string, name?: string) => freeze({ diagnostics: freeze([{ code, detail: candidate.uri, ...(name ? { identity: name } : {}) }]) });
	const raw = object(candidate.parsed); if (!raw) return invalid('custom_agent_invalid_toml');
	const allowed = ['name', 'description', 'developer_instructions', 'model', 'model_reasoning_effort', 'sandbox_mode', 'mcp_servers', 'skills'];
	if (Object.keys(raw).some(key => !allowed.includes(key))) return invalid('custom_agent_unknown_key');
	const name = raw.name, description = raw.description, instructions = raw.developer_instructions;
	// Filename is discovery-only. It must never repair or redefine the declared identity.
	if (typeof name !== 'string' || !identity.test(name)) return invalid('custom_agent_invalid_name', typeof name === 'string' ? name : undefined);
	if (typeof description !== 'string' || !description.trim() || description.length > 1024) return invalid('custom_agent_invalid_description', name);
	if (typeof instructions !== 'string' || !instructions.trim() || instructions.length > 65536) return invalid('custom_agent_invalid_developer_instructions', name);
	if (raw.model !== undefined && (typeof raw.model !== 'string' || !raw.model.trim())) return invalid('custom_agent_invalid_model', name);
	if (raw.model_reasoning_effort !== undefined && (typeof raw.model_reasoning_effort !== 'string' || !effort.has(raw.model_reasoning_effort))) return invalid('custom_agent_invalid_reasoning_effort', name);
	if (raw.sandbox_mode !== undefined && raw.sandbox_mode !== 'read-only') return invalid('custom_agent_sandbox_not_read_only', name);
	if (raw.mcp_servers !== undefined) return invalid('custom_agent_mcp_unsupported', name);
	let skillRules: CustomAgentSkillRule[] | undefined;
	if (raw.skills !== undefined) { const skills = object(raw.skills); const config = skills && skills.config; if (!skills || Object.keys(skills).some(key => key !== 'config') || !Array.isArray(config)) return invalid('custom_agent_invalid_skills', name); skillRules = []; for (const value of config) { const rule = object(value); if (!rule || Object.keys(rule).some(key => key !== 'name' && key !== 'enabled') || typeof rule.name !== 'string' || !rule.name || typeof rule.enabled !== 'boolean') return invalid('custom_agent_invalid_skills', name); skillRules.push(freeze({ selector: rule.name, enabled: rule.enabled })); } }
	const revision = hash([candidate.scope, candidate.uri, candidate.text]);
	return freeze({ agent: freeze({ identity: name, name, description, developerInstructions: instructions, ...(raw.model ? { model: raw.model as string } : {}), ...(raw.model_reasoning_effort ? { modelReasoningEffort: raw.model_reasoning_effort as string } : {}), ...(skillRules ? { skillRules: freeze(skillRules) } : {}), revision, provenance: freeze({ scope: candidate.scope, uri: candidate.uri }) }), diagnostics: freeze([]) });
};

export const createCustomAgentCatalog = (candidates: readonly CustomAgentCandidate[], diagnostics: readonly CustomAgentDiagnostic[] = []): CustomAgentCatalog => {
	const found: CustomAgent[] = [], all = [...diagnostics]; for (const candidate of candidates) { const result = strictCustomAgent(candidate); all.push(...result.diagnostics); if (result.agent) found.push(result.agent); }
	const invalid = new Set<string>(); for (const [key, group] of Object.entries(found.reduce<Record<string, CustomAgent[]>>((map, item) => { const key = `${item.provenance.scope}\0${item.identity}`; (map[key] ??= []).push(item); return map; }, {}))) if (group.length > 1) { invalid.add(key); all.push(freeze({ code: 'custom_agent_duplicate_identity', detail: key, identity: group[0].identity })); }
	const usable = found.filter(item => !invalid.has(`${item.provenance.scope}\0${item.identity}`)).sort((a, b) => a.identity.localeCompare(b.identity) || a.provenance.scope.localeCompare(b.provenance.scope));
	const winners = usable.filter(item => item.provenance.scope === 'project' || !usable.some(other => other.identity === item.identity && other.provenance.scope === 'project'));
	return freeze({ revision: hash([...winners.flatMap(item => [item.identity, item.revision]), ...all.flatMap(item => [item.code, item.detail])]), agents: freeze(winners), diagnostics: freeze(all) });
};

export const applyCustomAgentSkillRules = <T extends { identity: string }>(catalog: readonly T[], rules: readonly CustomAgentSkillRule[] | undefined): readonly T[] => !rules ? catalog : catalog.filter(skill => { let enabled = true; for (const rule of rules) if (rule.selector === skill.identity) enabled = rule.enabled; return enabled; });

/** Model-facing metadata is bounded separately from the complete transient admission catalog. */
export const customAgentAdvertisement = (catalog: CustomAgentCatalog, maxChars = 2_000): Readonly<{ text: string; omitted: number }> => {
	const lines: string[] = []; let used = 0; let omitted = 0;
	for (const agent of catalog.agents) { const line = `${agent.identity}: ${agent.description}`; if (used + line.length + (lines.length ? 2 : 0) > maxChars) { omitted++; continue; } lines.push(line); used += line.length + (lines.length ? 2 : 0); }
	return freeze({ text: lines.join('; '), omitted });
};
