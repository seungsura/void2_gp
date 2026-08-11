/*---------------------------------------------------------------------------------------------
 *  Browser I/O for Phase 2 Skills. Enabled extensions come from IExtensionService; this
 *  service never scans caches, VSIX files, or marketplaces on its own.
 *--------------------------------------------------------------------------------------------*/
import { URI } from '../../../../base/common/uri.js';
import { isEqualOrParent } from '../../../../base/common/resources.js';
import { FileOperationError, FileOperationResult, IFileService, IFileStat } from '../../../../platform/files/common/files.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { AgentSkillCatalog, createSkillCatalog, rebuildAgentSkillCatalog, resolveSkillResourceSegments, SkillCandidate, SkillDiagnostic } from '../common/agentSkills.js';
import { AgentInstructionsConfig } from '../common/agentInstructions.js';

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const pluginName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const freeze = <T>(value: T): T => Object.freeze(value);

export type BundledSkillRootProvider = () => readonly URI[];
/** Production defaults deliberately inject no bundled roots. */
export const noBundledSkillRoots: BundledSkillRootProvider = () => freeze([]);

export interface IAgentSkillsService {
	readonly _serviceBrand: undefined;
	getCatalog(ownerRoot: URI | undefined, cwd: URI | undefined, config?: AgentInstructionsConfig): Promise<AgentSkillCatalog>;
	readSkillBody(skillRoot: string, expectedRevision: string): Promise<{ body?: string; diagnostic?: SkillDiagnostic }>;
	readSkillResource(skillRoot: string, expectedRevision: string, resourcePath: string): Promise<{ body?: string; diagnostic?: SkillDiagnostic }>;
}
export const IAgentSkillsService = createDecorator<IAgentSkillsService>('voidAgentSkillsService');

type ReadResult = { bytes?: Uint8Array; missing: boolean };
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
	private async _stat(uri: URI): Promise<StatResult> { try { return { stat: await this.fileService.resolve(uri), missing: false }; } catch (error) { return { missing: this._missing(error) }; } }
	private async _read(uri: URI): Promise<ReadResult> { try { return { bytes: (await this.fileService.readFile(uri)).value.buffer.slice(), missing: false }; } catch (error) { return { missing: this._missing(error) }; } }
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
	private async _readSafeFile(root: URI, segments: readonly string[]): Promise<ReadResult> {
		if (!segments.length) return { missing: false };
		const parent = await this._safeDirectory(root, segments.slice(0, -1));
		if (!parent.stat) return { missing: parent.missing };
		const target = URI.joinPath(root, ...segments);
		const stat = await this._stat(target);
		if (!stat.stat) return { missing: stat.missing };
		if (!stat.stat.isFile || stat.stat.isSymbolicLink) return { missing: false };
		return this._read(target);
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
	async readSkillResource(skillRoot: string, expectedRevision: string, resourcePath: string): Promise<{ body?: string; diagnostic?: SkillDiagnostic }> {
		const segments = resolveSkillResourceSegments(resourcePath); if (!segments) return freeze({ diagnostic: this._diagnostic('skill_resource_outside_root', skillRoot) });
		const body = await this.readSkillBody(skillRoot, expectedRevision); if (!body.body) return freeze({ diagnostic: body.diagnostic });
		const read = await this._readAdmitted(skillRoot, expectedRevision, segments); if (!read.bytes) return freeze(read);
		try { return freeze({ body: decoder.decode(read.bytes) }); } catch { return freeze({ diagnostic: this._diagnostic('skill_resource_unreadable', skillRoot) }); }
	}
}
registerSingleton(IAgentSkillsService, AgentSkillsService as unknown as new (...services: any[]) => IAgentSkillsService, InstantiationType.Eager);
