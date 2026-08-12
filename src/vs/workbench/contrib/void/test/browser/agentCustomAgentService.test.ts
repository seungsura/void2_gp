import * as assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { AgentCustomAgentService } from '../../browser/agentCustomAgentService.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';

const bytes = (value: string) => new TextEncoder().encode(value);
const role = (name: string, description = 'Read.') => `name = "${name}"\ndescription = "${description}"\ndeveloper_instructions = "Inspect only."`;
const stat = (uri: URI, children: any[] = [], isFile = false, isSymbolicLink = false): any => ({ resource: uri, name: uri.path.split('/').pop()!, isDirectory: !isFile, isFile, isSymbolicLink, children, size: 100 });

const fixture = (files: Record<string, string>, trusted = true, owner: URI | undefined = URI.parse('file:///workspace')) => {
	const home = URI.parse('file:///home'); const entries = new Map<string, any>();
	const addDirs = (file: URI) => { let current = URI.parse(`${file.scheme}://${file.authority || ''}/`); for (const part of file.path.split('/').filter(Boolean).slice(0, -1)) { current = URI.joinPath(current, part); if (!entries.has(current.toString())) entries.set(current.toString(), stat(current)); } };
	for (const [key] of Object.entries(files)) { const uri = URI.parse(key); addDirs(uri); entries.set(uri.toString(), stat(uri, [], true)); }
	for (const entry of entries.values()) if (entry.isDirectory) entry.children = [...entries.values()].filter((child: any) => child.resource.path.startsWith(entry.resource.path.endsWith('/') ? entry.resource.path : `${entry.resource.path}/`) && child.resource.path.slice((entry.resource.path.endsWith('/') ? entry.resource.path : `${entry.resource.path}/`).length).split('/').length === 1);
	const fileService: any = { resolve: async (uri: URI) => { const value = entries.get(uri.toString()); if (!value) { const error: any = new Error('missing'); error.fileOperationResult = 1; throw error; } return value; }, readFile: async (uri: URI, opts: any, token: any) => { if (token?.isCancellationRequested) throw new Error('cancelled'); assert.deepStrictEqual(opts, { limits: { size: 128 * 1024 } }); const value = files[uri.toString()]; const entry = entries.get(uri.toString()); if (value === undefined || !entry) throw new Error('missing'); return { value: { buffer: bytes(value) } }; } };
	const workspace: any = { getWorkspace: () => ({ folders: owner ? [{ uri: owner }] : [] }) }; const trust: any = { isWorkspaceTrusted: () => trusted };
	return { service: new AgentCustomAgentService(fileService, { userHome: async () => home } as any, trust, workspace), entries, fileService, workspace, trust, home };
};

suite('Void AgentCustomAgentService', () => {
	test('discovers a user role without a workspace', async () => {
		const f = fixture({ 'file:///home/.codex/agents/user.toml': role('user-reader') }, true, undefined);
		assert.deepStrictEqual((await f.service.getCatalog(undefined)).agents.map(agent => agent.identity), ['user-reader']);
	});
	test('uses trusted project winner and excludes project roles when untrusted', async () => {
		const files = { 'file:///home/.codex/agents/user.toml': role('reader', 'User'), 'file:///workspace/.codex/agents/project.toml': role('reader', 'Project') };
		const trusted = fixture(files); assert.strictEqual((await trusted.service.getCatalog(URI.parse('file:///workspace'))).agents[0].description, 'Project');
		const untrusted = fixture(files, false); assert.strictEqual((await untrusted.service.getCatalog(URI.parse('file:///workspace'))).agents[0].description, 'User');
	});
	test('rejects reparse and invalid UTF-8/TOML candidates without admitting siblings', async () => {
		const f = fixture({ 'file:///home/.codex/agents/good.toml': role('good'), 'file:///home/.codex/agents/bad.toml': 'name = [' });
		f.entries.get('file:///home/.codex/agents/good.toml').isSymbolicLink = true;
		const catalog = await f.service.getCatalog(undefined); assert.strictEqual(catalog.agents.length, 0); assert.ok(catalog.diagnostics.length >= 1);
	});
	test('fails closed on cancellation and owner/trust drift', async () => {
		const f = fixture({ 'file:///home/.codex/agents/user.toml': role('user') }); const token = new CancellationTokenSource(); token.cancel();
		assert.strictEqual((await f.service.getCatalog(URI.parse('file:///workspace'), URI.parse('file:///workspace'), token.token)).agents.length, 0);
		f.workspace.getWorkspace = () => ({ folders: [{ uri: URI.parse('file:///changed') }] }); assert.strictEqual((await f.service.getCatalog(URI.parse('file:///workspace'))).agents.length, 0);
	});
});
