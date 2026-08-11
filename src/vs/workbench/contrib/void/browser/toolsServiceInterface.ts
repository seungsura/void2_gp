/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { RawToolParamsObj } from '../common/sendLLMMessageTypes.js';
import { BuiltinToolCallParams, BuiltinToolName, BuiltinToolResultType } from '../common/toolsServiceTypes.js';

export type ToolExecutionContext = {
	ownerThreadId: string;
	maxReadOutputTokens: number;
	childId?: string;
	ownerRoot?: URI;
	cancellationToken?: CancellationToken;
	maxResults?: number;
	maxFileSize?: number;
};

type ValidateBuiltinParams = { [T in BuiltinToolName]: (params: RawToolParamsObj) => BuiltinToolCallParams[T] };
type CallBuiltinTool = { [T in BuiltinToolName]: (params: BuiltinToolCallParams[T], context?: string | ToolExecutionContext) => Promise<{ result: BuiltinToolResultType[T] | Promise<BuiltinToolResultType[T]>; interruptTool?: () => void }> };
type BuiltinToolResultToString = { [T in BuiltinToolName]: (params: BuiltinToolCallParams[T], result: Awaited<BuiltinToolResultType[T]>, context?: string | ToolExecutionContext) => string };
type PreparedWriteFile = { uri: URI; execute: () => Promise<BuiltinToolResultType['write_file']> };

export interface IToolsService {
	readonly _serviceBrand: undefined;
	validateParams: ValidateBuiltinParams;
	callTool: CallBuiltinTool;
	prepareWriteFile: (params: BuiltinToolCallParams['write_file'], owner?: string) => Promise<PreparedWriteFile | null>;
	invalidateReadReceipts: (owner: string) => void;
	stringOfResult: BuiltinToolResultToString;
}

/** Lightweight token kept separate from the implementation's UI dependency graph. */
export const IToolsService = createDecorator<IToolsService>('ToolsService');
