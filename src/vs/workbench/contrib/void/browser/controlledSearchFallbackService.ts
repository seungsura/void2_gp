/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import {
	CONTROLLED_SEARCH_CHANNEL_NAME,
	ControlledSearchRequest,
	ControlledSearchResult,
	controlledSearchFailure,
	validateControlledSearchRequest,
	validateControlledSearchResult,
} from '../common/controlledSearchFallback.js';

export interface IControlledSearchFallbackService {
	readonly _serviceBrand: undefined;
	search(request: ControlledSearchRequest, token: CancellationToken): Promise<ControlledSearchResult>;
}

export const IControlledSearchFallbackService = createDecorator<IControlledSearchFallbackService>('controlledSearchFallbackService');

export class ControlledSearchFallbackService implements IControlledSearchFallbackService {
	readonly _serviceBrand: undefined;
	private readonly channel: IChannel;

	constructor(@IMainProcessService mainProcessService: IMainProcessService) {
		this.channel = mainProcessService.getChannel(CONTROLLED_SEARCH_CHANNEL_NAME);
	}

	async search(request: ControlledSearchRequest, token: CancellationToken): Promise<ControlledSearchResult> {
		const validatedRequest = validateControlledSearchRequest(request);
		if (!validatedRequest) return controlledSearchFailure('search_request_invalid');
		if (token.isCancellationRequested) return controlledSearchFailure('search_cancelled');
		try {
			const raw = await this.channel.call('search', validatedRequest, token);
			return validateControlledSearchResult(raw, validatedRequest.maxResults) ?? controlledSearchFailure('search_failed');
		} catch {
			return controlledSearchFailure(token.isCancellationRequested ? 'search_cancelled' : 'search_backend_unavailable');
		}
	}
}

registerSingleton(IControlledSearchFallbackService, ControlledSearchFallbackService, InstantiationType.Eager);
