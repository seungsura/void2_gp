import assert from 'assert';
import { resolveSkillResourceSegments } from '../../common/agentSkills.js';

suite('Agent Skill resource containment', () => {
	test('returns the exact relative target segments', () => assert.deepStrictEqual(resolveSkillResourceSegments('references/guide.md'), ['references', 'guide.md']));
	test('rejects traversal and absolute paths', () => { for (const path of ['../x', 'a/../x', '/x', 'C:/x']) assert.strictEqual(resolveSkillResourceSegments(path), undefined); });
	test('rejects backslashes and encoded separators or traversal', () => { for (const path of ['a\\b', 'a%2fb', 'a%5cb', '%2e%2e/x']) assert.strictEqual(resolveSkillResourceSegments(path), undefined); });
	test('rejects normalization inputs without a fallback target', () => { for (const path of ['a//b', './a', 'a/.', '', '%']) assert.strictEqual(resolveSkillResourceSegments(path), undefined); });
});
