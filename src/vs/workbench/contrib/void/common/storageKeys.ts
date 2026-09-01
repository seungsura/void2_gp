/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// past values:
// 'void.settingsServiceStorage'
// 'void.settingsServiceStorageI' // 1.0.2

// 1.0.3
export const VOID_SETTINGS_STORAGE_KEY = 'void.settingsServiceStorageII'


// past values:
// 'void.chatThreadStorage'
// 'void.chatThreadStorageI' // 1.0.2

// 1.0.3
export const THREAD_STORAGE_KEY = 'void.chatThreadStorageII'

// 1.0.4. Individual records avoid a stale window replacing unrelated history.
export const THREAD_STORAGE_RECORD_PREFIX = 'void.chatThreadStorageIII.'

// Deliberately separate from model-visible chat history. Pending busy-composer input
// survives a restart as dormant work and is never replayed automatically.
export const PENDING_CHAT_INPUT_STORAGE_KEY = 'void.pendingChatInputStorageI'



export const OPT_OUT_KEY = 'void.app.optOutAll'
