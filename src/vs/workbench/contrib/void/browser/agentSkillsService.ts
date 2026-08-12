/*---------------------------------------------------------------------------------------------
 *  Browser I/O for Phase 2 Skills. Enabled extensions come from IExtensionService; this
 *  service never scans caches, VSIX files, or marketplaces on its own.
 *--------------------------------------------------------------------------------------------*/
import { URI } from '../../../../base/common/uri.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { isEqualOrParent } from '../../../../base/common/resources.js';
import { FileOperationError, FileOperationResult, IFileService, IFileStat } from '../../../../platform/files/common/files.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { AgentSkillCatalog, AgentSkillSelection, createSkillCatalog, rebuildAgentSkillCatalog, resolveSkillResourceSegments, SkillCandidate, SkillDiagnostic, skillBodyRevision } from '../common/agentSkills.js';
import { AgentInstructionsConfig } from '../common/agentInstructions.js';

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();
const pluginName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const freeze = <T>(value: T): T => Object.freeze(value);

export type BundledSkillRootProvider = () => readonly URI[];
/** Production defaults deliberately inject no bundled roots. */
export const noBundledSkillRoots: BundledSkillRootProvider = () => freeze([]);

export interface IAgentSkillsService {
	readonly _serviceBrand: undefined;
	getCatalog(ownerRoot: URI | undefined, cwd: URI | undefined, config?: AgentInstructionsConfig): Promise<AgentSkillCatalog>;
	readSkillBody(skillRoot: string, expectedRevision: string): Promise<{ body?: string; diagnostic?: SkillDiagnostic }>;
	readSkillResource(selection: AgentSkillSelection, resourcePath: string, options: AgentSkillResourceReadOptions): Promise<{ body?: string; diagnostic?: SkillDiagnostic }>;
}
export const IAgentSkillsService = createDecorator<IAgentSkillsService>('voidAgentSkillsService');

export type AgentSkillResourceReadOptions = Readonly<{ maxResourceBytes: number; token: CancellationToken }>;
type ReadResult = { bytes?: Uint8Array; missing: boolean; tooLarge?: boolean; cancelled?: boolean };
type StatResult = { stat?: IFileStat; missing: boolean };

export class AgentSkillsService implements IAgentSkillsService {
	_serviceBrand: undefined;
	private readonly admitted = new Map<string, SkillCandidate>();
	constructor(
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@IWorkspaceTrustManagementService private readonly workspaceTrustManagementService: IWorkspaceTrustManagementService,
		@IExtensionService private readonly extensionService: IExtensionService,
		private readonly bundledRoots: BundledSkillRootProvider = noBundledSkillRoots,
	) { }
	private _missing(error: unknown): boolean { return error instanceof FileOperationError && error.fileOperationResult === FileOperationResult.FILE_NOT_FOUND; }
	private _tooLarge(error: unknown): boolean { return error instanceof FileOperationError && error.fileOperationResult === FileOperationResult.FILE_TOO_LARGE; }
	private async _stat(uri: URI): Promise<StatResult> { try { return { stat: await this.fileService.resolve(uri), missing: false }; } catch (error) { return { missing: this._missing(error) }; } }
	private async _read(uri: URI, maxBytes?: number, token: CancellationToken = CancellationToken.None): Promise<ReadResult> {
		if (token.isCancellationRequested) return { missing: false, cancelled: true };
		try { return { bytes: (await this.fileService.readFile(uri, maxBytes === undefined ? undefined : { limits: { size: maxBytes } }, token)).value.buffer.slice(), missing: false }; }
		catch (error) { return { missing: this._missing(error), ...(this._tooLarge(error) ? { tooLarge: true } : {}), ...(token.isCancellationRequested ? { cancelled: true } : {}) }; }
	}
	private _diagnostic(code: string, detail: string): SkillDiagnostic { return freeze({ code, detail }); }
	private async _safeDirectory(root: URI, segments: readonly string[] = []): Promise<StatResult> {
		let current = root;
		let result = await this._stat(current);
		if (!result.stat || !result.stat.isDirectory || result.stat.isSymbolicLink) return result;
		for (const segment of segments) {
			current = URI.joinPath(current, segment); result = await this._stat(current);
			if (!result.stat || !result.stat.isDirectory || result.stat.isSymbolicLink) return result;
		}
		return result;
	}
	private async _readSafeFile(root: URI, segments: readonly string[], maxBytes?: number, token: CancellationToken = CancellationToken.None): Promise<ReadResult> {
		if (!segments.length) return { missing: false };
		if (token.isCancellationRequested) return { missing: false, cancelled: true };
		const parent = await this._safeDirectory(root, segments.slice(0, -1));
		if (!parent.stat || !parent.stat.isDirectory || parent.stat.isSymbolicLink) return { missing: parent.missing };
		const target = URI.joinPath(root, ...segments);
		const stat = await this._stat(target);
		if (!stat.stat) return { missing: stat.missing };
		if (!stat.stat.isFile || stat.stat.isSymbolicLink) return { missing: false };
		if (maxBytes !== undefined && typeof stat.stat.size === 'number' && stat.stat.size > maxBytes) return { missing: false, tooLarge: true };
		const read = await this._read(target, maxBytes, token);
		if (!read.bytes) return read;
		if (token.isCancellationRequested) return { missing: false, cancelled: true };
		// A directory or target can become a symlink/junction while readFile awaits.
		// Re-walk the exact root and every ancestor and re-stat the target before
		// admitting any bytes across the Skill-root boundary.
		const parentAfterRead = await this._safeDirectory(root, segments.slice(0, -1));
		if (!parentAfterRead.stat || !parentAfterRead.stat.isDirectory || parentAfterRead.stat.isSymbolicLink) return { missing: parentAfterRead.missing };
		const targetAfterRead = await this._stat(target);
		if (!targetAfterRead.stat || !targetAfterRead.stat.isFile || targetAfterRead.stat.isSymbolicLink) return { missing: targetAfterRead.missing };
		return read;
	}
	private async _skillCandidates(root: URI, source: SkillCandidate['source'], rank: number, plugin?: string): Promise<{ candidates: SkillCandidate[]; diagnostics: SkillDiagnostic[] }> {
		const checked = await this._safeDirectory(root);
		if (!checked.stat) return checked.missing ? { candidates: [], diagnostics: [] } : { candidates: [], diagnostics: [this._diagnostic('skill_source_invalid', root.toString())] };
		if (!checked.stat.isDirectory || checked.stat.isSymbolicLink) return { candidates: [], diagnostics: [this._diagnostic('skill_source_invalid', root.toString())] };
		const candidates: SkillCandidate[] = []; const diagnostics: SkillDiagnostic[] = [];
		for (const child of [...(checked.stat.children ?? [])].sort((a, b) => a.resource.toString().localeCompare(b.resource.toString()))) {
			if (!child.isDirectory) continue;
			const skillRoot = child.resource;
			if (child.isSymbolicLink) { diagnostics.push(this._diagnostic('skill_candidate_invalid', skillRoot.toString())); continue; }
			const skill = await this._readSafeFile(skillRoot, ['SKILL.md']);
			if (!skill.bytes) { diagnostics.push(this._diagnostic('skill_candidate_invalid', skillRoot.toString())); continue; }
			const metadata = await this._readSafeFile(skillRoot, ['agents', 'openai.yaml']);
			if (!metadata.bytes && !metadata.missing) diagnostics.push(this._diagnostic('skill_optional_metadata_invalid', skillRoot.toString()));
			candidates.push({ source, rank, root: root.toString(), skillRoot: skillRoot.toString(), directoryName: skillRoot.path.split('/').filter(Boolean).pop()!, bytes: skill.bytes, ...(plugin ? { pluginName: plugin } : {}), ...(metadata.bytes ? { openaiMetadata: metadata.bytes } : {}) });
		}
		return { candidates, diagnostics };
	}
	private async _pluginCandidates(plugins: readonly URI[], startRank: number): Promise<{ candidates: SkillCandidate[]; diagnostics: SkillDiagnostic[] }> {
		const candidates: SkillCandidate[] = []; const diagnostics: SkillDiagnostic[] = [];
		for (const [index, extensionRoot] of [...plugins].sort((a, b) => a.toString().localeCompare(b.toString())).entries()) {
			const invalid = () => diagnostics.push(this._diagnostic('plugin_skill_manifest_invalid', extensionRoot.toString()));
			const extension = await this._safeDirectory(extensionRoot);
			if (!extension.stat || !extension.stat.isDirectory || extension.stat.isSymbolicLink) { invalid(); continue; }
			const manifest = await this._readSafeFile(extensionRoot, ['.codex-plugin', 'plugin.json']);
			if (manifest.missing) continue;
			let value: unknown;
			try { value = manifest.bytes ? JSON.parse(decoder.decode(manifest.bytes)) : undefined; } catch { value = undefined; }
			if (!value || typeof value !== 'object' || Array.isArray(value)) { invalid(); continue; }
			const record = value as Record<string, unknown>; const name = record.name;
			if (typeof name !== 'string' || !pluginName.test(name) || record.skills !== './skills/') { invalid(); continue; }
			const root = URI.joinPath(extensionRoot, 'skills');
			const skillsDirectory = await this._safeDirectory(extensionRoot, ['skills']);
			if (!isEqualOrParent(root, extensionRoot) || !skillsDirectory.stat || !skillsDirectory.stat.isDirectory || skillsDirectory.stat.isSymbolicLink) { invalid(); continue; }
			const found = await this._skillCandidates(root, 'plugin', startRank + index, name);
			candidates.push(...found.candidates); diagnostics.push(...found.diagnostics);
		}
		return { candidates, diagnostics };
	}
	private _enabled(skill: { identity: string; provenance: { skillRoot: string } }, config: AgentInstructionsConfig | undefined): boolean {
		let enabled = true;
		for (const rule of config?.skillConfigRules ?? []) {
			const file = URI.joinPath(URI.parse(skill.provenance.skillRoot), 'SKILL.md');
			const pathMatches = rule.selector.kind === 'path' && (rule.selector.value.toLowerCase() === file.fsPath.toLowerCase() || rule.selector.value === file.toString());
			if ((rule.selector.kind === 'name' && rule.selector.value === skill.identity) || pathMatches) enabled = rule.enabled;
		}
		return enabled;
	}
	private _configForCurrentTrust(config: AgentInstructionsConfig | undefined): AgentInstructionsConfig | undefined {
		if (!config || this.workspaceTrustManagementService.isWorkspaceTrusted()) return config;
		return freeze({
			...config,
			skillConfigRules: freeze(config.skillConfigRules.filter(rule => rule.source === 'user')),
			skillConfigDiagnostics: freeze(config.skillConfigDiagnostics.filter(diagnostic => diagnostic.source === 'user')),
		});
	}
	async getCatalog(ownerRoot: URI | undefined, cwd: URI | undefined, config?: AgentInstructionsConfig): Promise<AgentSkillCatalog> {
		const candidates: SkillCandidate[] = []; const diagnostics: SkillDiagnostic[] = []; let rank = 0;
		const repositoryDiscoveryEnabled = this.workspaceTrustManagementService.isWorkspaceTrusted() && !!ownerRoot && !!cwd && isEqualOrParent(cwd, ownerRoot);
		if (repositoryDiscoveryEnabled && ownerRoot && cwd) {
			const ownerParts = ownerRoot.path.split('/').filter(Boolean); const cwdParts = cwd.path.split('/').filter(Boolean); let current = ownerRoot;
			for (const part of [undefined, ...cwdParts.slice(ownerParts.length)]) { if (part) current = URI.joinPath(current, part); const found = await this._skillCandidates(URI.joinPath(current, '.agents', 'skills'), 'repository', rank++); candidates.push(...found.candidates); diagnostics.push(...found.diagnostics); }
		}
		const home = await this.pathService.userHome(); { const found = await this._skillCandidates(URI.joinPath(home, '.agents', 'skills'), 'user', rank++); candidates.push(...found.candidates); diagnostics.push(...found.diagnostics); }
		for (const root of [...this.bundledRoots()].sort((a, b) => a.toString().localeCompare(b.toString()))) { const found = await this._skillCandidates(root, 'bundled', rank++); candidates.push(...found.candidates); diagnostics.push(...found.diagnostics); }
		await this.extensionService.whenInstalledExtensionsRegistered();
		const plugins = await this._pluginCandidates(this.extensionService.extensions.map(extension => extension.extensionLocation), rank); candidates.push(...plugins.candidates); diagnostics.push(...plugins.diagnostics);
		if (repositoryDiscoveryEnabled && !this.workspaceTrustManagementService.isWorkspaceTrusted()) return this.getCatalog(undefined, undefined, config);
		const applicableConfig = this._configForCurrentTrust(config);
		const catalog = createSkillCatalog(candidates); const enabled = catalog.skills.filter(skill => this._enabled(skill, applicableConfig));
		const result = rebuildAgentSkillCatalog(enabled, [...catalog.diagnostics, ...diagnostics, ...(applicableConfig?.skillConfigDiagnostics ?? []).map(diagnostic => ({ code: diagnostic.code, detail: diagnostic.source }))]);
		for (const candidate of candidates) if (result.skills.some(skill => skill.provenance.skillRoot === candidate.skillRoot && skill.bodyRevision === createSkillCatalog([candidate]).skills[0]?.bodyRevision)) this.admitted.set(`${candidate.skillRoot}\0${createSkillCatalog([candidate]).skills[0]?.bodyRevision}`, freeze({ ...candidate }));
		return result;
	}
	private async _readAdmitted(skillRoot: string, revision: string, resource: readonly string[]): Promise<{ bytes?: Uint8Array; diagnostic?: SkillDiagnostic }> {
		const candidate = this.admitted.get(`${skillRoot}\0${revision}`); if (!candidate) return { diagnostic: this._diagnostic('skill_not_found', skillRoot) };
		let root: URI; try { root = URI.parse(skillRoot, true); } catch { return { diagnostic: this._diagnostic('skill_not_found', skillRoot) }; }
		const bytes = await this._readSafeFile(root, resource);
		if (!bytes.bytes) return { diagnostic: this._diagnostic(bytes.missing ? 'skill_resource_not_found' : 'skill_resource_unreadable', skillRoot) };
		return { bytes: bytes.bytes };
	}
	async readSkillBody(skillRoot: string, expectedRevision: string): Promise<{ body?: string; diagnostic?: SkillDiagnostic }> {
		const read = await this._readAdmitted(skillRoot, expectedRevision, ['SKILL.md']); if (!read.bytes) return freeze(read);
		const original = this.admitted.get(`${skillRoot}\0${expectedRevision}`)!;
		let body: string;
		try { body = decoder.decode(read.bytes); } catch { return freeze({ diagnostic: this._diagnostic('skill_invalid_utf8', skillRoot) }); }
		const current: SkillCandidate = { ...original, bytes: read.bytes };
		const validated = createSkillCatalog([current]).skills[0];
		if (!validated || validated.bodyRevision !== expectedRevision) return freeze({ diagnostic: this._diagnostic('skill_stale', skillRoot) });
		return freeze({ body });
	}
	async readSkillResource(selection: AgentSkillSelection, resourcePath: string, options: AgentSkillResourceReadOptions): Promise<{ body?: string; diagnostic?: SkillDiagnostic }> {
		const detail = typeof selection?.skillRoot === 'string' ? selection.skillRoot : '';
		const segments = resolveSkillResourceSegments(resourcePath); if (!segments) return freeze({ diagnostic: this._diagnostic('skill_resource_outside_root', detail) });
		if (!selection || typeof selection.identity !== 'string' || !selection.identity || typeof selection.skillRoot !== 'string' || !selection.skillRoot || typeof selection.bodyRevision !== 'string' || !selection.bodyRevision || typeof selection.body !== 'string' || skillBodyRevision(selection.body) !== selection.bodyRevision) return freeze({ diagnostic: this._diagnostic('skill_stale', detail) });
		if (!options || !Number.isSafeInteger(options.maxResourceBytes) || options.maxResourceBytes < 0 || !options.token) return freeze({ diagnostic: this._diagnostic('skill_resource_context_admission_failed', detail) });
		let root: URI;
		try { root = URI.parse(selection.skillRoot, true); } catch { return freeze({ diagnostic: this._diagnostic('skill_resource_not_found', detail) }); }
		if (!root.scheme || (!root.path.startsWith('/') && !root.authority)) return freeze({ diagnostic: this._diagnostic('skill_resource_not_found', detail) });
		const expectedSkillBytes = Math.min(Number.MAX_SAFE_INTEGER, encoder.encode(selection.body).byteLength + 3);
		const currentSkill = await this._readSafeFile(root, ['SKILL.md'], expectedSkillBytes, options.token);
		if (currentSkill.tooLarge) return freeze({ diagnostic: this._diagnostic('skill_resource_context_admission_failed', detail) });
		if (!currentSkill.bytes) return freeze({ diagnostic: this._diagnostic(currentSkill.missing ? 'skill_resource_not_found' : 'skill_resource_unreadable', detail) });
		let currentBody: string;
		try { currentBody = decoder.decode(currentSkill.bytes); } catch { return freeze({ diagnostic: this._diagnostic('skill_invalid_utf8', detail) }); }
		if (currentBody !== selection.body || skillBodyRevision(currentBody) !== selection.bodyRevision) return freeze({ diagnostic: this._diagnostic('skill_stale', detail) });
		const read = await this._readSafeFile(root, segments, options.maxResourceBytes, options.token);
		if (read.tooLarge) return freeze({ diagnostic: this._diagnostic('skill_resource_context_admission_failed', detail) });
		if (!read.bytes) return freeze({ diagnostic: this._diagnostic(read.missing ? 'skill_resource_not_found' : 'skill_resource_unreadable', detail) });
		try { return freeze({ body: decoder.decode(read.bytes) }); } catch { return freeze({ diagnostic: this._diagnostic('skill_resource_unreadable', detail) }); }
	}
}
registerSingleton(IAgentSkillsService, AgentSkillsService as unknown as new (...services: any[]) => IAgentSkillsService, InstantiationType.Eager);
