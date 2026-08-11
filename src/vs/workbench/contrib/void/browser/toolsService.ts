import { CancellationToken } from '../../../../base/common/cancellation.js'
import { URI } from '../../../../base/common/uri.js'
import { dirname, isEqualOrParent } from '../../../../base/common/resources.js'
import { FileOperationError, FileOperationResult, IFileService, IFileStat } from '../../../../platform/files/common/files.js'
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js'
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js'
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js'
import { QueryBuilder } from '../../../services/search/common/queryBuilder.js'
import { ISearchService } from '../../../services/search/common/search.js'
import { IEditCodeService } from './editCodeServiceInterface.js'
import { ITerminalToolService } from './terminalToolService.js'
import { LintErrorItem, BuiltinToolCallParams, BuiltinToolResultType } from '../common/toolsServiceTypes.js'
import { IVoidModelService } from '../common/voidModelService.js'
import { IVoidSettingsService } from '../common/voidSettingsService.js'
import { EndOfLinePreference } from '../../../../editor/common/model.js'
import { IVoidCommandBarService } from './voidCommandBarService.js'
import { computeDirectoryTree1Deep, IDirectoryStrService, stringifyDirectoryTree1Deep } from '../common/directoryStrService.js'
import { IMarkerService, MarkerSeverity } from '../../../../platform/markers/common/markers.js'
import { timeout } from '../../../../base/common/async.js'
import { RawToolParamsObj } from '../common/sendLLMMessageTypes.js'
import { MAX_CHILDREN_URIs_PAGE, MAX_FILE_CHARS_PAGE, MAX_TERMINAL_BG_COMMAND_TIME, MAX_TERMINAL_INACTIVE_TIME } from '../common/prompt/prompts.js'
import { generateUuid } from '../../../../base/common/uuid.js'
import { isWriteFileReceiptCurrent, planWriteFileModify, WriteFileEdit, WriteFileReceipt } from '../common/writeFilePlanner.js'
import { VSBuffer } from '../../../../base/common/buffer.js'
import { assertReadFilePageMakesProgress, effectiveReadFileLimits, pageReadFileLineSource, pageReadFileLines, ReadReceiptRegistry, validateReadFileRequest } from '../common/readFileReliability.js'
import { IToolsService, ToolExecutionContext } from './toolsServiceInterface.js'
import { AGENT_SUBAGENT_MAX_RESULTS, assertCanonicalAgentChildRawUri, assertCanonicalAgentChildUriPath, canonicalAgentChildUri } from '../common/agentSubagents.js'

export { IToolsService, ToolExecutionContext } from './toolsServiceInterface.js'


// tool use for AI
type PreparedWriteFile = { uri: URI; execute: () => Promise<BuiltinToolResultType['write_file']> }


const isFalsy = (u: unknown) => {
	return !u || u === 'null' || u === 'undefined'
}

const validateStr = (argName: string, value: unknown) => {
	if (value === null) throw new Error(`Invalid LLM output: ${argName} was null.`)
	if (typeof value !== 'string') throw new Error(`Invalid LLM output format: ${argName} must be a string, but its type is "${typeof value}". Full value: ${JSON.stringify(value)}.`)
	return value
}


// We are NOT checking to make sure in workspace
const validateURI = (uriStr: unknown) => {
	if (uriStr === null) throw new Error(`Invalid LLM output: uri was null.`)
	if (typeof uriStr !== 'string') throw new Error(`Invalid LLM output format: Provided uri must be a string, but it's a(n) ${typeof uriStr}. Full value: ${JSON.stringify(uriStr)}.`)

	// Check if it's already a full URI with scheme (e.g., vscode-remote://, file://, etc.)
	// Look for :// pattern which indicates a scheme is present
	// Examples of supported URIs:
	// - vscode-remote://wsl+Ubuntu/home/user/file.txt (WSL)
	// - vscode-remote://ssh-remote+myserver/home/user/file.txt (SSH)
	// - file:///home/user/file.txt (local file with scheme)
	// - /home/user/file.txt (local file path, will be converted to file://)
	// - C:\Users\file.txt (Windows local path, will be converted to file://)
	if (uriStr.includes('://')) {
		try {
			const uri = URI.parse(uriStr)
			return uri
		} catch (e) {
			// If parsing fails, it's a malformed URI
			throw new Error(`Invalid URI format: ${uriStr}. Error: ${e}`)
		}
	} else {
		// No scheme present, treat as file path
		// This handles regular file paths like /home/user/file.txt or C:\Users\file.txt
		const uri = URI.file(uriStr)
		return uri
	}
}

const validateOptionalURI = (uriStr: unknown) => {
	if (isFalsy(uriStr)) return null
	return validateURI(uriStr)
}

const validateOptionalStr = (argName: string, str: unknown) => {
	if (isFalsy(str)) return null
	return validateStr(argName, str)
}


const validatePageNum = (pageNumberUnknown: unknown) => {
	if (!pageNumberUnknown) return 1
	const parsedInt = Number.parseInt(pageNumberUnknown + '')
	if (!Number.isInteger(parsedInt)) throw new Error(`Page number was not an integer: "${pageNumberUnknown}".`)
	if (parsedInt < 1) throw new Error(`Invalid LLM output format: Specified page number must be 1 or greater: "${pageNumberUnknown}".`)
	return parsedInt
}

const validateProposedTerminalId = (terminalIdUnknown: unknown) => {
	if (!terminalIdUnknown) throw new Error(`A value for terminalID must be specified, but the value was "${terminalIdUnknown}"`)
	const terminalId = terminalIdUnknown + ''
	return terminalId
}

const validateBoolean = (b: unknown, opts: { default: boolean }) => {
	if (typeof b === 'string') {
		if (b === 'true') return true
		if (b === 'false') return false
	}
	if (typeof b === 'boolean') {
		return b
	}
	return opts.default
}


const checkIfIsFolder = (uriStr: string) => {
	uriStr = uriStr.trim()
	if (uriStr.endsWith('/') || uriStr.endsWith('\\')) return true
	return false
}

export class ToolsService implements IToolsService {

	readonly _serviceBrand: undefined;

	public validateParams: IToolsService['validateParams'];
	public callTool: IToolsService['callTool'];
	public prepareWriteFile: (params: BuiltinToolCallParams['write_file'], owner?: string) => Promise<PreparedWriteFile | null>;
	public invalidateReadReceipts: (owner: string) => void;
	public stringOfResult: IToolsService['stringOfResult'];

	constructor(
		@IFileService fileService: IFileService,
		@IWorkspaceContextService workspaceContextService: IWorkspaceContextService,
		@ISearchService searchService: ISearchService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IVoidModelService voidModelService: IVoidModelService,
		@IVoidSettingsService private readonly voidSettingsService: IVoidSettingsService,
		@IEditCodeService editCodeService: IEditCodeService,
		@ITerminalToolService private readonly terminalToolService: ITerminalToolService,
		@IVoidCommandBarService private readonly commandBarService: IVoidCommandBarService,
		@IDirectoryStrService private readonly directoryStrService: IDirectoryStrService,
		@IMarkerService private readonly markerService: IMarkerService,
	) {
		const readReceipts = new ReadReceiptRegistry<object>()
		this.invalidateReadReceipts = owner => readReceipts.invalidateOwner(owner)
		const queryBuilder = instantiationService.createInstance(QueryBuilder);
		const validateChildSearchUri = async (uri: URI, child: ToolExecutionContext) => {
			const owner = child.ownerRoot ? canonicalAgentChildUri(child.ownerRoot) : undefined; const target = canonicalAgentChildUri(uri);
			if (owner) { assertCanonicalAgentChildRawUri(owner.toString()); assertCanonicalAgentChildUriPath(owner.path); }
			assertCanonicalAgentChildRawUri(target.toString()); assertCanonicalAgentChildUriPath(target.path);
			if (!owner || target.scheme !== owner.scheme || target.authority !== owner.authority || !isEqualOrParent(target, owner)) throw new Error('agent_child_search_outside_owner');
			if (child.cancellationToken?.isCancellationRequested) throw new Error('agent_child_cancelled');
			let current = owner;
			if ((await fileService.resolve(current)).isSymbolicLink) throw new Error('agent_child_reparse_point');
			if (child.cancellationToken?.isCancellationRequested) throw new Error('agent_child_cancelled');
			for (const segment of target.path.slice(owner.path.length).split('/').filter(Boolean)) {
				current = URI.joinPath(current, segment);
				if ((await fileService.resolve(current)).isSymbolicLink) throw new Error('agent_child_reparse_point');
				if (child.cancellationToken?.isCancellationRequested) throw new Error('agent_child_cancelled');
			}
		};
		const validateChildReadFile = async (uri: URI, child: ToolExecutionContext) => {
			await validateChildSearchUri(uri, child);
			const stat = await fileService.stat(uri);
			if (child.cancellationToken?.isCancellationRequested) throw new Error('agent_child_cancelled');
			if (stat.isSymbolicLink) throw new Error('agent_child_reparse_point');
			if (child.maxFileSize !== undefined && (typeof stat.size !== 'number' || stat.size > child.maxFileSize)) throw new Error('agent_child_file_too_large');
		};
		const validateChildModelSize = (model: { getValueLength(eol?: EndOfLinePreference): number }, child: ToolExecutionContext) => {
			if (child.cancellationToken?.isCancellationRequested) throw new Error('agent_child_cancelled');
			const length = model.getValueLength(EndOfLinePreference.LF);
			if (!Number.isSafeInteger(length) || length < 0 || (child.maxFileSize !== undefined && length > child.maxFileSize)) throw new Error('agent_child_file_too_large');
		};
		this.prepareWriteFile = async (params, owner = 'direct') => {
			if (params.operation === 'create') {
				const ensureCreateTargetIsAvailable = async () => {
					let parent: IFileStat
					try {
						parent = await fileService.resolve(dirname(params.uri))
					}
					catch (error) {
						if (error instanceof FileOperationError && error.fileOperationResult === FileOperationResult.FILE_NOT_FOUND) {
							throw new Error('write_file rejected: the target parent folder does not exist.')
						}
						throw error
					}
					if (!parent.isDirectory) throw new Error('write_file rejected: the target parent is not a folder.')
					try {
						await fileService.resolve(params.uri)
						throw new Error('write_file rejected: target already exists.')
					}
					catch (error) {
						if (!(error instanceof FileOperationError) || error.fileOperationResult !== FileOperationResult.FILE_NOT_FOUND) throw error
					}
				}
				// The execution-time check is intentionally repeated: approval/UI work may await.
				await ensureCreateTargetIsAvailable()
				return {
					uri: params.uri,
					execute: async () => {
						await ensureCreateTargetIsAvailable()
						await fileService.createFile(params.uri, VSBuffer.fromString(params.content), { overwrite: false })
						return { operation: 'create', didChange: true, editCount: 0 }
					}
				}
			}
			if (this.commandBarService.getStreamState(params.uri) === 'streaming') throw new Error(`Another LLM is currently making changes to this file. Please stop streaming for now and ask the user to resume later.`)
			await voidModelService.initializeModel(params.uri)
			const { model } = await voidModelService.getModelSafe(params.uri)
			if (!model) throw new Error('No contents; File does not exist.')
			const canonicalURI = params.uri.toString()
			if (!readReceipts.validate(params.readReceiptId, canonicalURI, owner, model, model.getVersionId())) throw new Error('write_file stale_read: re-read the file before modifying it.')
			const versionId = model.getVersionId()
			const lfText = model.getValue(EndOfLinePreference.LF)
			const plan = planWriteFileModify(lfText, params.edits)
			if (!plan) throw new Error('write_file rejected: each old_text must be a unique, exact whole-line match in the latest file snapshot.')
			const receipt: WriteFileReceipt<typeof model> = { model, versionId, lfText, plan }
			const verifyReceipt = () => {
				const current = voidModelService.getModel(params.uri).model
				if (!current || !readReceipts.validate(params.readReceiptId, canonicalURI, owner, current, current.getVersionId())) throw new Error('write_file stale_read: re-read the file before modifying it.')
				if (!current || !isWriteFileReceiptCurrent(receipt, current, current.getVersionId(), current.getValue(EndOfLinePreference.LF))) {
					throw new Error('write_file rejected: file changed before the edit could be applied.')
				}
			}
			return {
				uri: params.uri,
				execute: async () => {
					verifyReceipt()
					await editCodeService.callBeforeApplyOrEdit(params.uri)
					verifyReceipt()
					const didChange = plan.newText !== lfText
					if (didChange) await editCodeService.applyStructuredWriteFile({ uri: params.uri, newContent: plan.newText })
					return { operation: 'modify', didChange, editCount: params.edits.length }
				}
			}
		}

		this.validateParams = {
			read_file: (params: RawToolParamsObj) => {
				const { uri: uriStr } = params
				const uri = validateURI(uriStr)
				const request = validateReadFileRequest(params)
				return { uri, ...request }
			},
			ls_dir: (params: RawToolParamsObj) => {
				const { uri: uriStr, page_number: pageNumberUnknown } = params

				const uri = validateURI(uriStr)
				const pageNumber = validatePageNum(pageNumberUnknown)
				return { uri, pageNumber }
			},
			get_dir_tree: (params: RawToolParamsObj) => {
				const { uri: uriStr, } = params
				const uri = validateURI(uriStr)
				return { uri }
			},
			search_pathnames_only: (params: RawToolParamsObj) => {
				const {
					query: queryUnknown,
					include_pattern: includeUnknown,
					page_number: pageNumberUnknown
				} = params

				const queryStr = validateStr('query', queryUnknown)
				const pageNumber = validatePageNum(pageNumberUnknown)
				const includePattern = validateOptionalStr('include_pattern', includeUnknown)

				return { query: queryStr, includePattern, pageNumber }

			},
			search_for_files: (params: RawToolParamsObj) => {
				const {
					query: queryUnknown,
					search_in_folder: searchInFolderUnknown,
					is_regex: isRegexUnknown,
					page_number: pageNumberUnknown
				} = params
				const queryStr = validateStr('query', queryUnknown)
				const pageNumber = validatePageNum(pageNumberUnknown)
				const searchInFolder = validateOptionalURI(searchInFolderUnknown)
				const isRegex = validateBoolean(isRegexUnknown, { default: false })
				return {
					query: queryStr,
					isRegex,
					searchInFolder,
					pageNumber
				}
			},
			search_in_file: (params: RawToolParamsObj) => {
				const { uri: uriStr, query: queryUnknown, is_regex: isRegexUnknown } = params;
				const uri = validateURI(uriStr);
				const query = validateStr('query', queryUnknown);
				const isRegex = validateBoolean(isRegexUnknown, { default: false });
				return { uri, query, isRegex };
			},

			read_lint_errors: (params: RawToolParamsObj) => {
				const {
					uri: uriUnknown,
				} = params
				const uri = validateURI(uriUnknown)
				return { uri }
			},

			// ---

			create_file_or_folder: (params: RawToolParamsObj) => {
				const { uri: uriUnknown } = params
				const uri = validateURI(uriUnknown)
				const uriStr = validateStr('uri', uriUnknown)
				const isFolder = checkIfIsFolder(uriStr)
				return { uri, isFolder }
			},

			delete_file_or_folder: (params: RawToolParamsObj) => {
				const { uri: uriUnknown, is_recursive: isRecursiveUnknown } = params
				const uri = validateURI(uriUnknown)
				const isRecursive = validateBoolean(isRecursiveUnknown, { default: false })
				const uriStr = validateStr('uri', uriUnknown)
				const isFolder = checkIfIsFolder(uriStr)
				return { uri, isRecursive, isFolder }
			},

			write_file: (params: RawToolParamsObj) => {
				const assertExactKeys = (allowed: readonly string[]) => {
					for (const key of Object.keys(params)) if (!allowed.includes(key)) throw new Error(`Invalid LLM output: write_file does not allow ${key} for this operation.`)
				}
				const uri = validateURI(params.uri)
				const operation = validateStr('operation', params.operation)
				if (operation === 'create') {
					assertExactKeys(['uri', 'operation', 'content'])
					return { uri, operation, content: validateStr('content', params.content) }
				}
				if (operation !== 'modify' || !Array.isArray(params.edits) || params.edits.length === 0) throw new Error('Invalid LLM output: write_file modify requires a non-empty edits array.')
				assertExactKeys(['uri', 'operation', 'read_receipt_id', 'edits'])
				const edits: WriteFileEdit[] = params.edits.map((edit, index) => {
					if (!edit || typeof edit !== 'object') throw new Error(`Invalid LLM output: edits[${index}] must be an object.`)
					const value = edit as Record<string, unknown>
					for (const key of Object.keys(value)) if (key !== 'old_text' && key !== 'new_text') throw new Error(`Invalid LLM output: edits[${index}] does not allow ${key}.`)
					return { oldText: validateStr(`edits[${index}].old_text`, value.old_text), newText: validateStr(`edits[${index}].new_text`, value.new_text) }
				})
				return { uri, operation, readReceiptId: validateStr('read_receipt_id', params.read_receipt_id), edits }
			},

			// ---

			run_command: (params: RawToolParamsObj) => {
				const { command: commandUnknown, cwd: cwdUnknown } = params
				const command = validateStr('command', commandUnknown)
				const cwd = validateOptionalStr('cwd', cwdUnknown)
				const terminalId = generateUuid()
				return { command, cwd, terminalId }
			},
			run_persistent_command: (params: RawToolParamsObj) => {
				const { command: commandUnknown, persistent_terminal_id: persistentTerminalIdUnknown } = params;
				const command = validateStr('command', commandUnknown);
				const persistentTerminalId = validateProposedTerminalId(persistentTerminalIdUnknown)
				return { command, persistentTerminalId };
			},
			open_persistent_terminal: (params: RawToolParamsObj) => {
				const { cwd: cwdUnknown } = params;
				const cwd = validateOptionalStr('cwd', cwdUnknown)
				// No parameters needed; will open a new background terminal
				return { cwd };
			},
			kill_persistent_terminal: (params: RawToolParamsObj) => {
				const { persistent_terminal_id: terminalIdUnknown } = params;
				const persistentTerminalId = validateProposedTerminalId(terminalIdUnknown);
				return { persistentTerminalId };
			},

		}


		this.callTool = {
			read_file: async ({ uri, startLine, endLine, lineByteOffset }, context = 'direct') => {
				const owner = typeof context === 'string' ? context : context.ownerThreadId
				const child = typeof context === 'string' ? undefined : context.childId ? context : undefined
				if (child) await validateChildReadFile(uri, child)
				await voidModelService.initializeModel(uri)
				if (child) await validateChildReadFile(uri, child)
				const { model } = await voidModelService.getModelSafe(uri)
				if (child) await validateChildReadFile(uri, child)
				if (model === null) { throw new Error(`No contents; File does not exist.`) }
				if (child) validateChildModelSize(model, child)

				if (child?.cancellationToken?.isCancellationRequested) throw new Error('agent_child_cancelled')
				const limits = effectiveReadFileLimits(this.voidSettingsService.state.globalSettings.readFileLimits, typeof context === 'string' ? 0 : context.maxReadOutputTokens)
				const page = child
					? pageReadFileLineSource({ lineCount: model.getLineCount(), totalFileLen: model.getValueLength(EndOfLinePreference.LF), lineAt: line => model.getLineContent(line) }, { startLine, endLine, lineByteOffset }, limits)
					: pageReadFileLines(Array.from({ length: model.getLineCount() }, (_, i) => model.getLineContent(i + 1)), { startLine, endLine, lineByteOffset }, limits)
				assertReadFilePageMakesProgress(page, { startLine, endLine, lineByteOffset })
				if (child) await validateChildReadFile(uri, child)
				const canonicalURI = uri.toString(); const documentVersion = model.getVersionId(); const id = generateUuid()
				readReceipts.add({ id, uri: canonicalURI, version: documentVersion, model, owner })
				return { result: { ...page, receipt: { id, uri: canonicalURI, documentVersion, sourceKind: uri.scheme === 'file' ? 'file' : 'model', requestedRange: { startLine, endLine, lineByteOffset }, returnedRange: { startLine: page.startLine, endLine: page.endLine, nextLine: page.nextLine, nextByteOffset: page.nextByteOffset } } } }
			},

			ls_dir: async ({ uri, pageNumber }, context = '') => {
				const child = typeof context === 'string' ? undefined : context.childId ? context : undefined
				if (child) {
					await validateChildSearchUri(uri, child)
					const stat = await fileService.resolve(uri, { resolveMetadata: true })
					if (child.cancellationToken?.isCancellationRequested) throw new Error('agent_child_cancelled')
					await validateChildSearchUri(uri, child)
					if (stat.isSymbolicLink) throw new Error('agent_child_reparse_point')
					if (!stat.isDirectory) return { result: { children: null, hasNextPage: false, hasPrevPage: false, itemsRemaining: 0 } }
					const safeChildren = [] as NonNullable<BuiltinToolResultType['ls_dir']['children']>
					for (const item of [...(stat.children ?? [])].sort((a, b) => a.resource.toString().localeCompare(b.resource.toString()))) {
						if (child.cancellationToken?.isCancellationRequested) throw new Error('agent_child_cancelled')
						if (item.isSymbolicLink) continue
						try { await validateChildSearchUri(item.resource, child) } catch (error) { if (error instanceof Error && error.message === 'agent_child_cancelled') throw error; continue }
						safeChildren.push({ name: item.name, uri: item.resource, isDirectory: item.isDirectory, isSymbolicLink: false })
					}
					const maxResults = Math.max(1, Math.min(child.maxResults ?? MAX_CHILDREN_URIs_PAGE, MAX_CHILDREN_URIs_PAGE))
					const from = maxResults * (pageNumber - 1); const children = safeChildren.slice(from, from + maxResults)
					return { result: { children, hasNextPage: safeChildren.length > from + maxResults, hasPrevPage: pageNumber > 1, itemsRemaining: Math.max(0, safeChildren.length - (from + maxResults)) } }
				}
				const dirResult = await computeDirectoryTree1Deep(fileService, uri, pageNumber)
				return { result: dirResult }
			},

			get_dir_tree: async ({ uri }) => {
				const str = await this.directoryStrService.getDirectoryStrTool(uri)
				return { result: { str } }
			},

			search_pathnames_only: async ({ query: queryStr, includePattern, pageNumber }, context = '') => {
				const child = typeof context === 'string' ? undefined : context.childId ? context : undefined
				if (child && !child.ownerRoot) throw new Error('agent_child_search_outside_owner')
				const roots = child ? [child.ownerRoot!] : workspaceContextService.getWorkspace().folders.map(f => f.uri)
				const pageSize = child ? Math.max(1, Math.min(child.maxResults ?? AGENT_SUBAGENT_MAX_RESULTS, AGENT_SUBAGENT_MAX_RESULTS)) : MAX_CHILDREN_URIs_PAGE
				if (child) await validateChildSearchUri(roots[0], child)

				const query = queryBuilder.file(roots, {
					filePattern: queryStr,
					includePattern: includePattern ?? undefined,
					sortByScore: true, // makes results 10x better
					...(child ? { ignoreSymlinks: true, maxResults: pageSize, maxFileSize: child.maxFileSize } as any : {}),
				})
				const data = await searchService.fileSearch(query, child?.cancellationToken ?? CancellationToken.None)
				if (child) await validateChildSearchUri(roots[0], child)
				if (child && data.results.length > pageSize) throw new Error('agent_child_search_result_limit')

				const fromIdx = pageSize * (pageNumber - 1)
				const toIdx = pageSize * pageNumber - 1
				const uris = data.results
					.slice(fromIdx, toIdx + 1) // paginate
					.map(({ resource, results }) => resource)
				if (child) for (const uri of uris) await validateChildSearchUri(uri, child)

				const hasNextPage = (data.results.length - 1) - toIdx >= 1
				return { result: { uris, hasNextPage } }
			},

			search_for_files: async ({ query: queryStr, isRegex, searchInFolder, pageNumber }, context = '') => {
				const child = typeof context === 'string' ? undefined : context.childId ? context : undefined
				if (child && !child.ownerRoot) throw new Error('agent_child_search_outside_owner')
				const searchFolders = child ? [searchInFolder ?? child.ownerRoot!] : searchInFolder === null ?
					workspaceContextService.getWorkspace().folders.map(f => f.uri)
					: [searchInFolder]
				const pageSize = child ? Math.max(1, Math.min(child.maxResults ?? AGENT_SUBAGENT_MAX_RESULTS, AGENT_SUBAGENT_MAX_RESULTS)) : MAX_CHILDREN_URIs_PAGE
				if (child) await validateChildSearchUri(searchFolders[0], child)

				const query = queryBuilder.text({
					pattern: queryStr,
					isRegExp: isRegex,
				}, searchFolders, child ? { ignoreSymlinks: true, maxResults: pageSize, maxFileSize: child.maxFileSize } as any : undefined)
				const data = await searchService.textSearch(query, child?.cancellationToken ?? CancellationToken.None)
				if (child) await validateChildSearchUri(searchFolders[0], child)
				if (child && data.results.length > pageSize) throw new Error('agent_child_search_result_limit')

				const fromIdx = pageSize * (pageNumber - 1)
				const toIdx = pageSize * pageNumber - 1
				const uris = data.results
					.slice(fromIdx, toIdx + 1) // paginate
					.map(({ resource, results }) => resource)
				if (child) for (const uri of uris) await validateChildSearchUri(uri, child)

				const hasNextPage = (data.results.length - 1) - toIdx >= 1
				return { result: { queryStr, uris, hasNextPage } }
			},
			search_in_file: async ({ uri, query, isRegex }, context = '') => {
				const child = typeof context === 'string' ? undefined : context.childId ? context : undefined
				if (child && isRegex) throw new Error('agent_child_regex_not_supported')
				if (child) await validateChildReadFile(uri, child)
				await voidModelService.initializeModel(uri);
				if (child) await validateChildReadFile(uri, child)
				const { model } = await voidModelService.getModelSafe(uri);
				if (child) await validateChildReadFile(uri, child)
				if (model === null) { throw new Error(`No contents; File does not exist.`); }
				if (child) validateChildModelSize(model, child)
				const totalLines = model.getLineCount();
				const regex = isRegex ? new RegExp(query) : null;
				const lines: number[] = []
				const boundedMatches: string[] = []; let boundedChars = 0; const maxBoundedChars = child ? Math.max(1, Math.min(MAX_FILE_CHARS_PAGE, child.maxReadOutputTokens * 4)) : 0;
				for (let i = 1; i <= totalLines; i++) {
					if (child?.cancellationToken?.isCancellationRequested) throw new Error('agent_child_cancelled');
					const line = model.getLineContent(i);
					if ((isRegex && regex!.test(line)) || (!isRegex && line.includes(query))) {
						lines.push(i);
						if (child) {
							const separator = boundedMatches.length ? '\n\n' : ''; const prefix = `Line ${i}:\n\`\`\`\n`; const suffix = '\n```'; const available = maxBoundedChars - boundedChars - separator.length;
							if (available <= 0) break;
							const lineBudget = Math.max(0, available - prefix.length - suffix.length); const clipped = line.slice(0, lineBudget); const entry = `${prefix}${clipped}${suffix}`.slice(0, available); boundedMatches.push(entry); boundedChars += separator.length + entry.length;
							if (clipped.length < line.length || lines.length >= Math.max(1, Math.min(child.maxResults ?? AGENT_SUBAGENT_MAX_RESULTS, AGENT_SUBAGENT_MAX_RESULTS))) break;
						}
					}
				}
				if (child) await validateChildReadFile(uri, child)
				return { result: { lines, ...(child ? { boundedContent: boundedMatches.join('\n\n') } : {}) } };
			},

			read_lint_errors: async ({ uri }) => {
				await timeout(1000)
				const { lintErrors } = this._getLintErrors(uri)
				return { result: { lintErrors } }
			},

			// ---

			create_file_or_folder: async ({ uri, isFolder }) => {
				if (isFolder)
					await fileService.createFolder(uri)
				else {
					await fileService.createFile(uri)
				}
				return { result: {} }
			},

			delete_file_or_folder: async ({ uri, isRecursive }) => {
				await fileService.del(uri, { recursive: isRecursive })
				return { result: {} }
			},

			write_file: async (params) => {
				const prepared = await this.prepareWriteFile(params)
				if (!prepared) throw new Error('Internal error: write_file did not produce a receipt.')
				return { result: prepared.execute() }
			},
			// ---
			run_command: async ({ command, cwd, terminalId }) => {
				const { resPromise, interrupt } = await this.terminalToolService.runCommand(command, { type: 'temporary', cwd, terminalId })
				return { result: resPromise, interruptTool: interrupt }
			},
			run_persistent_command: async ({ command, persistentTerminalId }) => {
				const { resPromise, interrupt } = await this.terminalToolService.runCommand(command, { type: 'persistent', persistentTerminalId })
				return { result: resPromise, interruptTool: interrupt }
			},
			open_persistent_terminal: async ({ cwd }) => {
				const persistentTerminalId = await this.terminalToolService.createPersistentTerminal({ cwd })
				return { result: { persistentTerminalId } }
			},
			kill_persistent_terminal: async ({ persistentTerminalId }) => {
				// Close the background terminal by sending exit
				await this.terminalToolService.killPersistentTerminal(persistentTerminalId)
				return { result: {} }
			},
		}


		const nextPageStr = (hasNextPage: boolean) => hasNextPage ? '\n\n(more on next page...)' : ''

		const stringifyLintErrors = (lintErrors: LintErrorItem[]) => {
			return lintErrors
				.map((e, i) => `Error ${i + 1}:\nLines Affected: ${e.startLineNumber}-${e.endLineNumber}\nError message:${e.message}`)
				.join('\n\n')
				.substring(0, MAX_FILE_CHARS_PAGE)
		}

		// given to the LLM after the call for successful tool calls
		this.stringOfResult = {
			read_file: (params, result) => {
				return `${params.uri.fsPath}\n\`\`\`\n${result.fileContents}\n\`\`\`${result.hasNextPage ? `\nTruncated. Continue with next_line=${result.nextLine}${result.nextByteOffset !== undefined ? ` and line_byte_offset=${result.nextByteOffset}` : ''}.` : ''}\nReceipt: ${result.receipt.id}`
			},
			ls_dir: (params, result) => {
				const dirTreeStr = stringifyDirectoryTree1Deep(params, result)
				return dirTreeStr // + nextPageStr(result.hasNextPage) // already handles num results remaining
			},
			get_dir_tree: (params, result) => {
				return result.str
			},
			search_pathnames_only: (params, result, context = '') => {
				const child = typeof context === 'string' ? undefined : context.childId ? context : undefined
				return result.uris.map(uri => child ? uri.toString() : uri.fsPath).join('\n') + nextPageStr(result.hasNextPage)
			},
			search_for_files: (params, result, context = '') => {
				const child = typeof context === 'string' ? undefined : context.childId ? context : undefined
				return result.uris.map(uri => child ? uri.toString() : uri.fsPath).join('\n') + nextPageStr(result.hasNextPage)
			},
			search_in_file: (params, result) => {
				if (result.boundedContent !== undefined) return result.boundedContent
				const { model } = voidModelService.getModel(params.uri)
				if (!model) return '<Error getting string of result>'
				const lines = result.lines.map(n => {
					const lineContent = model.getValueInRange({ startLineNumber: n, startColumn: 1, endLineNumber: n, endColumn: Number.MAX_SAFE_INTEGER }, EndOfLinePreference.LF)
					return `Line ${n}:\n\`\`\`\n${lineContent}\n\`\`\``
				}).join('\n\n');
				return lines;
			},
			read_lint_errors: (params, result) => {
				return result.lintErrors ?
					stringifyLintErrors(result.lintErrors)
					: 'No lint errors found.'
			},
			// ---
			create_file_or_folder: (params, result) => {
				return `URI ${params.uri.fsPath} successfully created.`
			},
			delete_file_or_folder: (params, result) => {
				return `URI ${params.uri.fsPath} successfully deleted.`
			},
			write_file: (params, result) => JSON.stringify({ operation: result.operation, didChange: result.didChange, editCount: result.editCount }),
			run_command: (params, result) => {
				const { resolveReason, result: result_, } = result
				// success
				if (resolveReason.type === 'done') {
					return `${result_}\n(exit code ${resolveReason.exitCode})`
				}
				// normal command
				if (resolveReason.type === 'timeout') {
					return `${result_}\nTerminal command ran, but was automatically killed by Void after ${MAX_TERMINAL_INACTIVE_TIME}s of inactivity and did not finish successfully. To try with more time, open a persistent terminal and run the command there.`
				}
				throw new Error(`Unexpected internal error: Terminal command did not resolve with a valid reason.`)
			},

			run_persistent_command: (params, result) => {
				const { resolveReason, result: result_, } = result
				const { persistentTerminalId } = params
				// success
				if (resolveReason.type === 'done') {
					return `${result_}\n(exit code ${resolveReason.exitCode})`
				}
				// bg command
				if (resolveReason.type === 'timeout') {
					return `${result_}\nTerminal command is running in terminal ${persistentTerminalId}. The given outputs are the results after ${MAX_TERMINAL_BG_COMMAND_TIME} seconds.`
				}
				throw new Error(`Unexpected internal error: Terminal command did not resolve with a valid reason.`)
			},

			open_persistent_terminal: (_params, result) => {
				const { persistentTerminalId } = result;
				return `Successfully created persistent terminal. persistentTerminalId="${persistentTerminalId}"`;
			},
			kill_persistent_terminal: (params, _result) => {
				return `Successfully closed terminal "${params.persistentTerminalId}".`;
			},
		}



	}


	private _getLintErrors(uri: URI): { lintErrors: LintErrorItem[] | null } {
		const lintErrors = this.markerService
			.read({ resource: uri })
			.filter(l => l.severity === MarkerSeverity.Error || l.severity === MarkerSeverity.Warning)
			.slice(0, 100)
			.map(l => ({
				code: typeof l.code === 'string' ? l.code : l.code?.value || '',
				message: (l.severity === MarkerSeverity.Error ? '(error) ' : '(warning) ') + l.message,
				startLineNumber: l.startLineNumber,
				endLineNumber: l.endLineNumber,
			} satisfies LintErrorItem))

		if (!lintErrors.length) return { lintErrors: null }
		return { lintErrors, }
	}


}

registerSingleton(IToolsService, ToolsService, InstantiationType.Eager);
