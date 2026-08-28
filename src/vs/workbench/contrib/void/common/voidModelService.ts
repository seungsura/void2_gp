import { Disposable, IReference } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { IResolvedTextEditorModel, ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';

type VoidModelType = {
	model: ITextModel | null;
	editorModel: IResolvedTextEditorModel | null;
};

export interface IVoidModelService {
	readonly _serviceBrand: undefined;
	initializeModel(uri: URI): Promise<void>;
	getModel(uri: URI): VoidModelType;
	getModelFromFsPath(fsPath: string): VoidModelType;
	getModelSafe(uri: URI): Promise<VoidModelType>;
	saveModel(uri: URI): Promise<void>;

}

export const IVoidModelService = createDecorator<IVoidModelService>('voidVoidModelService');

class VoidModelService extends Disposable implements IVoidModelService {
	_serviceBrand: undefined;
	static readonly ID = 'voidVoidModelService';
	/** The resolver can canonicalise file URIs (notably on case-insensitive file
	 * systems).  Keep both a stable identity key and one shared creation promise so
	 * two simultaneous first reads never acquire competing strong references. */
	private readonly _modelRefOfURI = new Map<string, IReference<IResolvedTextEditorModel>>();
	/** `IResolvedTextEditorModel` does not promise a URI. Preserve the admitted URI
	 * alongside its reference for legacy fsPath lookup instead of reaching into an
	 * implementation-only `resource` field. */
	private readonly _fsPathOfModelKey = new Map<string, string>();
	private readonly _initializingModelOfURI = new Map<string, Promise<void>>();
	private _disposed = false;

	constructor(
		@ITextModelService private readonly _textModelService: ITextModelService,
		@ITextFileService private readonly _textFileService: ITextFileService,
		@IUriIdentityService private readonly _uriIdentityService: IUriIdentityService,
	) {
		super();
	}

	saveModel = async (uri: URI) => {
		await this._textFileService.save(uri, { // we want [our change] -> [save] so it's all treated as one change.
			skipSaveParticipants: true // avoid triggering extensions etc (if they reformat the page, it will add another item to the undo stack)
		})
	}

	initializeModel = async (uri: URI) => {
		const key = this._uriIdentityService.extUri.getComparisonKey(uri);
		if (this._modelRefOfURI.has(key)) return;
		const inFlight = this._initializingModelOfURI.get(key);
		if (inFlight) return inFlight;
		const initialize = (async () => {
			try {
				const editorModelRef = await this._textModelService.createModelReference(uri);
				// A service disposal must not leak a reference that resolved afterwards.
				if (this._disposed) editorModelRef.dispose();
				else if (!this._modelRefOfURI.has(key)) { this._modelRefOfURI.set(key, editorModelRef); this._fsPathOfModelKey.set(key, uri.fsPath); }
				else editorModelRef.dispose();
			} catch (error) {
				// Failures are deliberately not cached: a transient resolver error can be retried.
				console.log('InitializeModel error:', error);
			} finally {
				this._initializingModelOfURI.delete(key);
			}
		})();
		this._initializingModelOfURI.set(key, initialize);
		return initialize;
	};

	getModelFromFsPath = (fsPath: string): VoidModelType => {
		const key = [...this._fsPathOfModelKey.entries()].find(([, path]) => path === fsPath)?.[0];
		const editorModelRef = key === undefined ? undefined : this._modelRefOfURI.get(key);
		if (!editorModelRef) {
			return { model: null, editorModel: null };
		}

		const model = editorModelRef.object.textEditorModel;

		if (!model) {
			return { model: null, editorModel: editorModelRef.object };
		}

		return { model, editorModel: editorModelRef.object };
	};

	getModel = (uri: URI) => {
		const editorModelRef = this._modelRefOfURI.get(this._uriIdentityService.extUri.getComparisonKey(uri));
		if (!editorModelRef) return { model: null, editorModel: null };
		const model = editorModelRef.object.textEditorModel;
		return { model, editorModel: editorModelRef.object };
	}


	getModelSafe = async (uri: URI): Promise<VoidModelType> => {
		if (!this._modelRefOfURI.has(this._uriIdentityService.extUri.getComparisonKey(uri))) await this.initializeModel(uri);
		return this.getModel(uri);

	};

	override dispose() {
		this._disposed = true;
		super.dispose();
		for (const ref of this._modelRefOfURI.values()) {
			ref.dispose(); // release reference to allow disposal
		}
		this._modelRefOfURI.clear();
		this._fsPathOfModelKey.clear();
	}
}

registerSingleton(IVoidModelService, VoidModelService, InstantiationType.Eager);
