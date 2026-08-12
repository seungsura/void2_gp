import assert from 'assert';
import { resolveSkillResourceSegments } from '../../common/agentSkills.js';

suite('Agent Skill resource containment', () => {
	test('returns the exact relative target segments', () => assert.deepStrictEqual(resolveSkillResourceSegments('references/guide.md'), ['references', 'guide.md']));
	test('rejects traversal, absolute, drive, and URI paths before and after decoding', () => { for (const path of ['../x', 'a/../x', '/x', '%2Fx', 'C:/x', 'C%3A/x', 'file:x', 'file%3Ax']) assert.strictEqual(resolveSkillResourceSegments(path), undefined); });
	test('rejects backslashes and encoded separators or traversal', () => { for (const path of ['a\\b', 'a%2fb', 'a%5cb', 'a%252fb', '%2e%2e/x']) assert.strictEqual(resolveSkillResourceSegments(path), undefined); });
	test('rejects raw and encoded query or fragment syntax', () => { for (const path of ['a?x', 'a#x', 'a%3Fx', 'a%23x']) assert.strictEqual(resolveSkillResourceSegments(path), undefined); });
	test('rejects normalization inputs without a fallback target', () => { for (const path of ['a//b', './a', 'a/.', '', '%']) assert.strictEqual(resolveSkillResourceSegments(path), undefined); });
});
