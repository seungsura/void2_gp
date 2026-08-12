/*---------------------------------------------------------------------------------------------
 * Direct custom-agent discovery with bounded, strict file admission.
 *--------------------------------------------------------------------------------------------*/
import { URI } from '../../../../base/common/uri.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IFileService, FileOperationError, FileOperationResult, IFileStat } from '../../../../platform/files/common/files.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { parse } from '../../../../../../node_modules/smol-toml/dist/index.js';
import { CustomAgentCatalog, CustomAgentCandidate, CustomAgentDiagnostic, createCustomAgentCatalog } from '../common/agentCustomAgents.js';

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const MAX_AGENT_BYTES = 128 * 1024;
export const IAgentCustomAgentService = createDecorator<IAgentCustomAgentService>('voidAgentCustomAgentService');
export interface IAgentCustomAgentService { readonly _serviceBrand: undefined; getCatalog(owner: URI | undefined, cwd?: URI | undefined, token?: CancellationToken): Promise<CustomAgentCatalog>; }
type StatResult = { stat?: IFileStat; missing: boolean };
export class AgentCustomAgentService implements IAgentCustomAgentService {
	_serviceBrand: undefined;
	constructor(@IFileService private readonly files: IFileService, @IPathService private readonly paths: IPathService, @IWorkspaceTrustManagementService private readonly trust: IWorkspaceTrustManagementService, @IWorkspaceContextService private readonly workspace: IWorkspaceContextService) { }
	private missing(error: unknown): boolean { return error instanceof FileOperationError && error.fileOperationResult === FileOperationResult.FILE_NOT_FOUND; }
	private async stat(uri: URI): Promise<StatResult> { try { return { stat: await this.files.resolve(uri), missing: false }; } catch (error) { return { missing: this.missing(error) }; } }
	private async safeDirectory(root: URI, segments: readonly string[] = []): Promise<StatResult> {
		let current = root; let checked = await this.stat(current); if (!checked.stat || !checked.stat.isDirectory || checked.stat.isSymbolicLink) return checked;
		for (const segment of segments) { current = URI.joinPath(current, segment); checked = await this.stat(current); if (!checked.stat || !checked.stat.isDirectory || checked.stat.isSymbolicLink) return checked; }
		return checked;
	}
	private async safeFile(root: URI, segments: readonly string[], token: CancellationToken): Promise<{ bytes?: Uint8Array; missing: boolean; cancelled?: boolean }> {
		if (token.isCancellationRequested) return { missing: false, cancelled: true };
		const parent = await this.safeDirectory(root, segments.slice(0, -1)); if (!parent.stat || !parent.stat.isDirectory || parent.stat.isSymbolicLink) return { missing: parent.missing };
		const file = URI.joinPath(root, ...segments); const checked = await this.stat(file); if (!checked.stat || !checked.stat.isFile || checked.stat.isSymbolicLink || (typeof checked.stat.size === 'number' && checked.stat.size > MAX_AGENT_BYTES)) return { missing: checked.missing };
		let content; try { content = await this.files.readFile(file, { limits: { size: MAX_AGENT_BYTES } }, token); } catch { return { missing: false, ...(token.isCancellationRequested ? { cancelled: true } : {}) }; }
		if (token.isCancellationRequested) return { missing: false, cancelled: true };
		return { bytes: content.value.buffer.slice(), missing: false };
	}
	private current(owner: URI | undefined, cwd: URI | undefined, trusted: boolean): boolean { return (!owner || this.workspace.getWorkspace().folders[0]?.uri.toString() === owner.toString()) && (!owner || !cwd || cwd.toString() === owner.toString()) && this.trust.isWorkspaceTrusted() === trusted; }
	private async discover(root: URI, scope: 'user' | 'project', current: () => boolean, token: CancellationToken): Promise<{ candidates: CustomAgentCandidate[]; diagnostics: CustomAgentDiagnostic[] }> {
		const diagnostics: CustomAgentDiagnostic[] = []; const checked = await this.safeDirectory(root); if (!current() || token.isCancellationRequested) return { candidates: [], diagnostics: [{ code: 'custom_agent_owner_or_trust_changed', detail: root.toString() }] };
		if (!checked.stat) return checked.missing ? { candidates: [], diagnostics } : { candidates: [], diagnostics: [{ code: 'custom_agent_source_unreadable', detail: root.toString() }] };
		if (!checked.stat.isDirectory || checked.stat.isSymbolicLink) return { candidates: [], diagnostics: [{ code: 'custom_agent_source_invalid', detail: root.toString() }] };
		const candidates: CustomAgentCandidate[] = [];
		for (const child of [...(checked.stat.children ?? [])].sort((a, b) => a.resource.toString().localeCompare(b.resource.toString()))) {
			if (!child.isFile || child.isSymbolicLink || !child.name.endsWith('.toml')) continue; const filename = child.name.slice(0, -5); const read = await this.safeFile(root, [child.name], token);
			if (!current() || token.isCancellationRequested) return { candidates: [], diagnostics: [{ code: 'custom_agent_owner_or_trust_changed', detail: root.toString() }] };
			if (!read.bytes) { diagnostics.push({ code: read.cancelled ? 'custom_agent_cancelled' : 'custom_agent_unreadable_or_invalid', detail: child.resource.toString(), identity: filename }); continue; }
			try { const text = decoder.decode(read.bytes); candidates.push({ scope, uri: child.resource.toString(), filename, text, parsed: parse(text) }); } catch { diagnostics.push({ code: 'custom_agent_unreadable_or_invalid', detail: child.resource.toString(), identity: filename }); }
		}
		return { candidates, diagnostics };
	}
	async getCatalog(owner: URI | undefined, cwd: URI | undefined = owner, token: CancellationToken = CancellationToken.None): Promise<CustomAgentCatalog> {
		const trusted = this.trust.isWorkspaceTrusted(); const current = () => this.current(owner, cwd, trusted); const home = await this.paths.userHome(); if (!current() || token.isCancellationRequested) return createCustomAgentCatalog([], [{ code: 'custom_agent_owner_or_trust_changed', detail: owner?.toString() ?? '' }]);
		// Validate the complete source chain before discovery, not only its terminal directory.
		const userChain = await this.safeDirectory(home, ['.codex', 'agents']); if (!current() || token.isCancellationRequested) return createCustomAgentCatalog([], [{ code: 'custom_agent_owner_or_trust_changed', detail: owner?.toString() ?? '' }]);
		const user = userChain.stat ? await this.discover(URI.joinPath(home, '.codex', 'agents'), 'user', current, token) : { candidates: [], diagnostics: userChain.missing ? [] : [{ code: 'custom_agent_source_invalid', detail: URI.joinPath(home, '.codex', 'agents').toString() }] }; if (!current() || token.isCancellationRequested) return createCustomAgentCatalog([], [...user.diagnostics, { code: 'custom_agent_owner_or_trust_changed', detail: owner?.toString() ?? '' }]);
		const projectChain = owner && trusted ? await this.safeDirectory(owner, ['.codex', 'agents']) : undefined; if (!current() || token.isCancellationRequested) return createCustomAgentCatalog([], [...user.diagnostics, { code: 'custom_agent_owner_or_trust_changed', detail: owner?.toString() ?? '' }]);
		const project = owner && trusted && projectChain?.stat ? await this.discover(URI.joinPath(owner, '.codex', 'agents'), 'project', current, token) : { candidates: [], diagnostics: projectChain && !projectChain.missing ? [{ code: 'custom_agent_source_invalid', detail: URI.joinPath(owner!, '.codex', 'agents').toString() }] : [] as CustomAgentDiagnostic[] };
		if (!current() || token.isCancellationRequested) return createCustomAgentCatalog([], [...user.diagnostics, ...project.diagnostics, { code: 'custom_agent_owner_or_trust_changed', detail: owner?.toString() ?? '' }]);
		return createCustomAgentCatalog([...user.candidates, ...project.candidates], [...user.diagnostics, ...project.diagnostics]);
	}
}
registerSingleton(IAgentCustomAgentService, AgentCustomAgentService, InstantiationType.Eager);
