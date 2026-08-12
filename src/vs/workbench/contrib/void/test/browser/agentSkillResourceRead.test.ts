import * as assert from 'assert';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { URI } from '../../../../../base/common/uri.js';
import { FileOperationError, FileOperationResult } from '../../../../../platform/files/common/files.js';
import { AgentSkillsService } from '../../browser/agentSkillsService.js';
import { AgentSkillSelection, skillBodyRevision } from '../../common/agentSkills.js';

const encoder = new TextEncoder();
type Node = { dir?: true; data?: Uint8Array; link?: true; unreadable?: true };

class Files {
	readonly nodes = new Map<string, Node>();
	readonly operations: string[] = [];
	readonly afterRead = new Map<string, () => void>();
	private key(path: string) { return /^[a-z][a-z0-9+.-]*:/i.test(path) ? path : `file://${path}`; }
	dir(path: string, extra: Node = {}) { this.nodes.set(this.key(path), { dir: true, ...extra }); }
	put(path: string, value: string | Uint8Array, extra: Node = {}) { this.nodes.set(this.key(path), { data: typeof value === 'string' ? encoder.encode(value) : value, ...extra }); }
	async resolve(resource: URI): Promise<any> {
		const key = resource.toString(); this.operations.push(`stat:${key}`); const node = this.nodes.get(key);
		if (!node) throw new FileOperationError('missing', FileOperationResult.FILE_NOT_FOUND);
		if (node.unreadable) throw new Error('unreadable');
		const prefix = `${key}/`;
		const children = [...this.nodes.entries()].filter(([child]) => child.startsWith(prefix) && !child.slice(prefix.length).includes('/')).map(([child, value]) => ({ resource: URI.parse(child), isDirectory: !!value.dir, isFile: !value.dir, isSymbolicLink: !!value.link }));
		return { resource, isDirectory: !!node.dir, isFile: !node.dir, isSymbolicLink: !!node.link, size: node.data?.byteLength ?? 0, children };
	}
	async readFile(resource: URI, options?: { limits?: { size?: number } }, token: CancellationToken = CancellationToken.None): Promise<any> {
		const key = resource.toString(); this.operations.push(`read:${key}`); const node = this.nodes.get(key);
		if (!node || node.dir) throw new FileOperationError('missing', FileOperationResult.FILE_NOT_FOUND);
		if (node.unreadable) throw new Error('unreadable');
		if (token.isCancellationRequested) throw new Error('cancelled');
		if (options?.limits?.size !== undefined && node.data!.byteLength > options.limits.size) throw new FileOperationError('too large', FileOperationResult.FILE_TOO_LARGE);
		const bytes = node.data!; this.afterRead.get(key)?.();
		return { value: { buffer: bytes } };
	}
}

const skillBody = (body = 'body') => `---\nname: demo\ndescription: demo description\n---\n${body}`;
const selection = (body = skillBody()): AgentSkillSelection => Object.freeze({ identity: 'demo', skillRoot: 'file:///skills/demo', bodyRevision: skillBodyRevision(body), body });
const options = (maxResourceBytes = 1024, token: CancellationToken = CancellationToken.None) => ({ maxResourceBytes, token });
const fixture = () => {
	const files = new Files();
	for (const path of ['/home', '/skills', '/skills/demo', '/skills/demo/references', '/other', '/other/demo', '/other/demo/references']) files.dir(path);
	const body = skillBody(); files.put('/skills/demo/SKILL.md', body); files.put('/other/demo/SKILL.md', body); files.put('/other/demo/references/guide.md', 'FALLBACK-MUST-NOT-BE-READ');
	const service = new AgentSkillsService(files as never, { userHome: async () => URI.parse('file:///home') } as never, { isWorkspaceTrusted: () => true } as never, { extensions: [], whenInstalledExtensionsRegistered: async () => { } } as never);
	return { files, service, body };
};

suite('Void restart-safe selected Skill resource read', () => {
	test('reads exact UTF-8 text without catalog admission, wrapper, receipt, or fallback', async () => {
		const { files, service, body } = fixture(); const resource = '첫 줄\nlast\n'; files.put('/skills/demo/references/guide.md', resource);
		assert.deepStrictEqual(await service.readSkillResource(selection(body), 'references/guide.md', options()), { body: resource });
		assert.strictEqual(files.operations.some(operation => operation.includes('/other/demo/')), false);
	});

	test('validates the captured body and revision against the current exact SKILL.md after restart', async () => {
		const { files, service, body } = fixture(); files.put('/skills/demo/references/guide.md', 'resource');
		const captured = selection(body); files.put('/skills/demo/SKILL.md', skillBody('changed'));
		assert.strictEqual((await service.readSkillResource(captured, 'references/guide.md', options())).diagnostic?.code, 'skill_stale');
		files.put('/skills/demo/SKILL.md', body); const tampered = { ...captured, body: `${body}tampered` };
		const before = files.operations.length; assert.strictEqual((await service.readSkillResource(tampered, 'references/guide.md', options())).diagnostic?.code, 'skill_stale'); assert.strictEqual(files.operations.length, before);
	});

	test('fails missing, outside, symlink, unreadable, and invalid UTF-8 reads independently with no fallback', async () => {
		const { files, service, body } = fixture(); const captured = selection(body);
		const beforeOutside = files.operations.length; assert.strictEqual((await service.readSkillResource(captured, '../guide.md', options())).diagnostic?.code, 'skill_resource_outside_root'); assert.strictEqual(files.operations.length, beforeOutside);
		assert.strictEqual((await service.readSkillResource(captured, 'references/missing.md', options())).diagnostic?.code, 'skill_resource_not_found');
		files.put('/skills/demo/references/link.md', 'link', { link: true }); assert.strictEqual((await service.readSkillResource(captured, 'references/link.md', options())).diagnostic?.code, 'skill_resource_unreadable');
		files.put('/skills/demo/references/unreadable.md', 'no', { unreadable: true }); assert.strictEqual((await service.readSkillResource(captured, 'references/unreadable.md', options())).diagnostic?.code, 'skill_resource_unreadable');
		files.put('/skills/demo/references/invalid.md', new Uint8Array([0xff])); assert.strictEqual((await service.readSkillResource(captured, 'references/invalid.md', options())).diagnostic?.code, 'skill_resource_unreadable');
		files.put('/skills/demo/references/good.md', 'still-good'); assert.strictEqual((await service.readSkillResource(captured, 'references/good.md', options())).body, 'still-good');
		assert.strictEqual(files.operations.some(operation => operation.includes('/other/demo/references/guide.md')), false);
	});

	test('fails closed when SKILL.md is missing, unreadable, invalid UTF-8, or rooted through a reparse point', async () => {
		for (const [kind, expected] of [['missing', 'skill_resource_not_found'], ['unreadable', 'skill_resource_unreadable'], ['invalid', 'skill_invalid_utf8'], ['reparse', 'skill_resource_unreadable']] as const) {
			const { files, service, body } = fixture(); files.put('/skills/demo/references/guide.md', 'resource');
			if (kind === 'missing') files.nodes.delete('file:///skills/demo/SKILL.md');
			else if (kind === 'unreadable') files.put('/skills/demo/SKILL.md', body, { unreadable: true });
			else if (kind === 'invalid') files.put('/skills/demo/SKILL.md', new Uint8Array([0xff]));
			else files.dir('/skills/demo', { link: true });
			assert.strictEqual((await service.readSkillResource(selection(body), 'references/guide.md', options())).diagnostic?.code, expected);
		}
	});

	test('uses pre-stat and read limits atomically for resources and changed huge SKILL.md', async () => {
		const { files, service, body } = fixture(); const captured = selection(body);
		files.put('/skills/demo/references/large.md', '0123456789');
		const before = files.operations.length; const result = await service.readSkillResource(captured, 'references/large.md', options(4));
		assert.strictEqual(result.diagnostic?.code, 'skill_resource_context_admission_failed');
		assert.strictEqual(files.operations.slice(before).some(operation => operation === 'read:file:///skills/demo/references/large.md'), false);
		files.put('/skills/demo/SKILL.md', `${body}${'x'.repeat(100)}`);
		const hugeSkill = await service.readSkillResource(captured, 'references/large.md', options(1024));
		assert.strictEqual(hugeSkill.diagnostic?.code, 'skill_resource_context_admission_failed');
	});

	test('cancels before I/O and rejects ancestor or target transitions to reparse points after read', async () => {
		const cancelledFixture = fixture(); const cancellation = new CancellationTokenSource(); cancellation.cancel();
		const before = cancelledFixture.files.operations.length;
		assert.strictEqual((await cancelledFixture.service.readSkillResource(selection(cancelledFixture.body), 'references/guide.md', options(1024, cancellation.token))).body, undefined);
		assert.strictEqual(cancelledFixture.files.operations.length, before); cancellation.dispose();
		for (const transition of ['ancestor', 'target'] as const) {
			const { files, service, body } = fixture(); files.put('/skills/demo/references/guide.md', 'OUTSIDE-BYTES-MUST-NOT-RETURN');
			files.afterRead.set('file:///skills/demo/references/guide.md', () => transition === 'ancestor' ? files.dir('/skills/demo/references', { link: true }) : files.put('/skills/demo/references/guide.md', 'link', { link: true }));
			const result = await service.readSkillResource(selection(body), 'references/guide.md', options());
			assert.strictEqual(result.body, undefined); assert.strictEqual(result.diagnostic?.code, 'skill_resource_unreadable');
		}
	});
});
