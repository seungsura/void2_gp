import assert from 'assert';
import { SkillCandidate, validateBundledSkillCandidates } from '../../common/agentSkills.js';
const bytes = (text: string) => new TextEncoder().encode(text);
const candidate = (body: string, metadata?: string): SkillCandidate => ({ source: 'bundled', rank: 0, root: 'file:///bundle', skillRoot: 'file:///bundle/demo', directoryName: 'demo', bytes: bytes(body), ...(metadata === undefined ? {} : { openaiMetadata: bytes(metadata) }) });

suite('Agent Skill bundled build validation', () => {
	test('accepts valid bundled candidates', () => { const result = validateBundledSkillCandidates([candidate('---\nname: demo\ndescription: Demo\n---\nBody')]); assert.strictEqual(result.valid, true); assert.deepStrictEqual(result.diagnostics, []); });
	test('makes invalid core fatal while optional metadata remains fail-open', () => { const core = validateBundledSkillCandidates([candidate('bad')]); const optional = validateBundledSkillCandidates([candidate('---\nname: demo\ndescription: Demo\n---\nBody', '[')]); assert.strictEqual(core.valid, false); assert.strictEqual(core.diagnostics.some(item => item.code === 'skill_bundled_invalid'), true); assert.strictEqual(optional.valid, true); assert.strictEqual(optional.diagnostics[0].code, 'skill_optional_metadata_invalid'); });
});
