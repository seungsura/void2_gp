/*---------------------------------------------------------------------------------------------
 *  Task/session config and per-top-level-turn AGENTS.md snapshots for Chat/Agent.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { FileOperationError, FileOperationResult, IFileService } from '../../../../platform/files/common/files.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
// Browser/static ESM and packaged resources/app both require this relative production-dependency path.
import { parse } from '../../../../../../node_modules/smol-toml/dist/index.js';
import { AgentInstructionCandidate, AgentInstructionReadOutcome, AgentInstructionsConfig, AgentInstructionTurnSnapshot, ParsedAgentConfigSource, agentConfigSourceDescriptors, agentInstructionChain, parseAgentConfigSource, projectAgentConfig, resolveAgentInstructions, stableAgentInstructionRevision } from '../common/agentInstructions.js';

export interface IAgentInstructionsService {
	readonly _serviceBrand: undefined;
	beginTaskSession(): Promise<AgentInstructionsConfig>;
	beginTopLevelTurn(config: AgentInstructionsConfig): Promise<AgentInstructionTurnSnapshot>;
}

export const IAgentInstructionsService = createDecorator<IAgentInstructionsService>('voidAgentInstructionsService');

class AgentInstructionsService implements IAgentInstructionsService {
	_serviceBrand: undefined;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IWorkspaceTrustManagementService private readonly workspaceTrustManagementService: IWorkspaceTrustManagementService,
	) { }

	private _ownerRoot(): URI | undefined {
		// Phase 1 deliberately selects one deterministic owner. Multi-root merging is not implicit.
		return this.workspaceContextService.getWorkspace().folders[0]?.uri;
	}

	private async _read(uri: URI): Promise<AgentInstructionReadOutcome> {
		try { return Object.freeze({ status: 'bytes', bytes: (await this.fileService.readFile(uri)).value.buffer.slice() }); } catch (error) { return Object.freeze({ status: error instanceof FileOperationError && error.fileOperationResult === FileOperationResult.FILE_NOT_FOUND ? 'missing' : 'unreadable' }); }
	}

	private async _parseConfig(scope: 'user' | 'project', uri: URI): Promise<ParsedAgentConfigSource> {
		return parseAgentConfigSource(scope, uri.toString(), await this._read(uri), parse);
	}

	async beginTaskSession(): Promise<AgentInstructionsConfig> {
		const userRoot = await this.pathService.userHome();
		const owner = this._ownerRoot();
		const descriptors = agentConfigSourceDescriptors(userRoot, owner, this.workspaceTrustManagementService.isWorkspaceTrusted());
		const results = await Promise.all(descriptors.map(descriptor => this._parseConfig(descriptor.scope, descriptor.uri)));
		const user = results.find(result => result.provenance.scope === 'user')!;
		const project = results.find(result => result.provenance.scope === 'project');
		return projectAgentConfig(user.projected, project?.projected, [user.provenance, ...(project ? [project.provenance] : [])], owner?.toString(), owner?.toString());
	}

	async beginTopLevelTurn(config: AgentInstructionsConfig): Promise<AgentInstructionTurnSnapshot> {
		const owner = config.ownerProjectRoot ? URI.parse(config.ownerProjectRoot) : undefined;
		const runCwd = config.runCwd ? URI.parse(config.runCwd) : undefined;
		// The generic root-to-CWD chain is intentionally represented as an ordered candidate list.
		// Phase 1 fixes CWD to the owner root, so it contains exactly the root candidate.
		const candidates: AgentInstructionCandidate[] = owner && runCwd ? await Promise.all(agentInstructionChain(owner, runCwd).map(async uri => ({ uri: uri.toString(), outcome: await this._read(uri) }))) : [];
		return resolveAgentInstructions(config, candidates, stableAgentInstructionRevision(config, candidates));
	}
}

registerSingleton(IAgentInstructionsService, AgentInstructionsService, InstantiationType.Eager);
