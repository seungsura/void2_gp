/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

export type AutomaticSuggestionEnvironment = Readonly<{
	isBuilt: boolean;
	isExtensionDevelopment: boolean;
}>;

const isRetainedDevelopmentEnvironment = (environment: AutomaticSuggestionEnvironment): boolean =>
	!environment.isBuilt || environment.isExtensionDevelopment;

export const isGhostChatDevelopmentEnvironment = (environment: AutomaticSuggestionEnvironment): boolean =>
	isRetainedDevelopmentEnvironment(environment);

export const isSelectionHelperDevelopmentEnvironment = (environment: AutomaticSuggestionEnvironment): boolean =>
	isRetainedDevelopmentEnvironment(environment);
