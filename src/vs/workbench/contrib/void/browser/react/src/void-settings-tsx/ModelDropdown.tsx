/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------*/

import { corporateOpenAICompatibleModelName } from '../../../../../../../workbench/contrib/void/common/modelCapabilities.js';
import { FeatureName } from '../../../../../../../workbench/contrib/void/common/voidSettingsTypes.js';

/** The corporate product has one fixed non-FIM model; this is intentionally not a selector. */
export const ModelDropdown = ({ featureName, className }: { featureName: FeatureName, className: string }) => {
	if (featureName === 'Autocomplete') {
		return <span className={className} data-testid='void-corporate-model-unavailable' aria-label='Autocomplete unavailable because the corporate model does not support fill in the middle'>Autocomplete unavailable (no FIM)</span>;
	}

	return <span className={className} data-testid='void-corporate-model-display' aria-label={`${featureName} fixed model ${corporateOpenAICompatibleModelName}`}>{corporateOpenAICompatibleModelName}</span>;
}
