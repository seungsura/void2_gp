/**
 * The model-facing write_file contract deliberately plans against one immutable
 * snapshot.  This module has no editor or filesystem dependencies so a failed
 * plan cannot accidentally mutate a workspace.
 */
export type WriteFileEdit = { oldText: string; newText: string };

export type WriteFilePlan = {
	newText: string;
	edits: readonly { start: number; end: number; newText: string }[];
};

const isLineStart = (text: string, offset: number) => offset === 0 || (offset === 1 && text.charCodeAt(0) === 0xFEFF) || text.charCodeAt(offset - 1) === 10;
const isLineEnd = (text: string, offset: number) => offset === text.length || text.charCodeAt(offset) === 10 || (text.charCodeAt(offset) === 13 && text.charCodeAt(offset + 1) === 10);

/** Returns null instead of a partial plan for every invalid or ambiguous edit. */
export const planWriteFileModify = (lfText: string, edits: readonly WriteFileEdit[]): WriteFilePlan | null => {
	if (edits.length === 0) return null;
	const planned: { start: number; end: number; newText: string }[] = [];

	for (const edit of edits) {
		if (typeof edit.oldText !== 'string' || typeof edit.newText !== 'string') return null;
		if (edit.oldText === '') {
			if (lfText !== '' || edits.length !== 1) return null;
			planned.push({ start: 0, end: 0, newText: edit.newText });
			continue;
		}

		let matchStart = -1;
		let matches = 0;
		for (let start = lfText.indexOf(edit.oldText); start !== -1; start = lfText.indexOf(edit.oldText, start + 1)) {
			const end = start + edit.oldText.length;
			if (isLineStart(lfText, start) && isLineEnd(lfText, end)) {
				matchStart = start;
				matches++;
			}
		}
		if (matches !== 1) return null;
		planned.push({ start: matchStart, end: matchStart + edit.oldText.length, newText: edit.newText });
	}

	const ordered = [...planned].sort((a, b) => a.start - b.start);
	for (let i = 1; i < ordered.length; i++) if (ordered[i - 1].end > ordered[i].start) return null;

	let newText = lfText;
	for (const edit of [...ordered].reverse()) newText = newText.slice(0, edit.start) + edit.newText + newText.slice(edit.end);
	return { newText, edits: ordered };
};
