/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { SearchError, SearchErrorCode, serializeSearchError } from '../common/search.js';

const unavailableExecutableCodes = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOEXEC']);

export const isBundledRipgrepMissingError = (error: unknown): error is NodeJS.ErrnoException =>
	error instanceof Error && unavailableExecutableCodes.has((error as NodeJS.ErrnoException).code ?? '');

export const bundledRipgrepMissingError = () => serializeSearchError(new SearchError('Bundled ripgrep executable is unavailable.', SearchErrorCode.rgBinaryMissing));

export const classifyBundledRipgrepSpawnError = (error: unknown): Error => {
	if (isBundledRipgrepMissingError(error)) return bundledRipgrepMissingError();
	return error instanceof Error ? error : new Error('Bundled ripgrep process failed.');
};

export const assertBundledRipgrepAvailable = (executablePath: string): void => {
	try { fs.accessSync(executablePath, fs.constants.F_OK | fs.constants.X_OK); }
	catch (error) {
		if (isBundledRipgrepMissingError(error)) throw bundledRipgrepMissingError();
		throw error;
	}
};
