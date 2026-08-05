/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

export type WriteFileEditorTransaction = {
	write(): void;
	markStreamingComplete(): void;
	refreshDiffs(): void;
	shouldAutoAccept: boolean;
	autoAccept(): Promise<void>;
	finishAndSave(): Promise<void>;
};

export const runWriteFileEditorTransaction = async (transaction: WriteFileEditorTransaction): Promise<void> => {
	transaction.write();
	transaction.markStreamingComplete();
	transaction.refreshDiffs();
	if (transaction.shouldAutoAccept) await transaction.autoAccept();
	await transaction.finishAndSave();
};

export const restoreWriteFileEditorSnapshot = async ({
	restore,
	save,
}: {
	restore(): Promise<void>;
	save?: () => Promise<void>;
}): Promise<void> => {
	await restore();
	if (save) await save();
};
