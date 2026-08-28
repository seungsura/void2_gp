/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt in the project root.
 *--------------------------------------------------------------------------------------*/

/**
 * Model-declared native tool batches are planned locally.  This intentionally has no
 * model-facing representation: it only decides which declarations are eligible for a
 * bounded read wave.  Every other call is a serial barrier.
 */
export const parentSafeReadToolNames = Object.freeze([
	'read_file', 'ls_dir', 'get_dir_tree', 'search_pathnames_only', 'search_for_files', 'search_in_file', 'read_lint_errors',
] as const);
export const childSafeReadToolNames = Object.freeze([
	'read_file', 'ls_dir', 'search_pathnames_only', 'search_for_files', 'search_in_file',
] as const);

export type BatchExecutor = 'parent' | 'child';
export type ToolBatchPlanKind = 'safe_read' | 'barrier';
export type ToolBatchPlanCall = Readonly<{ ordinal: number; name: string }>;
export type ToolBatchWave = Readonly<{ kind: ToolBatchPlanKind; calls: readonly ToolBatchPlanCall[] }>;

const isSafeRead = (executor: BatchExecutor, name: string): boolean =>
	(executor === 'parent' ? parentSafeReadToolNames : childSafeReadToolNames).includes(name as never);

/** Split at barriers and apply the physical read cap to each same-kind wave. */
export const planToolBatchWaves = (executor: BatchExecutor, calls: readonly ToolBatchPlanCall[], maxConcurrentReads = 2): readonly ToolBatchWave[] => {
	const cap = Number.isFinite(maxConcurrentReads) ? Math.max(1, Math.min(2, Math.floor(maxConcurrentReads))) : 2;
	const result: ToolBatchWave[] = [];
	let reads: ToolBatchPlanCall[] = [];
	const flushReads = () => { if (reads.length) { result.push(Object.freeze({ kind: 'safe_read', calls: Object.freeze(reads) })); reads = []; } };
	for (const call of calls) {
		const immutable = Object.freeze({ ordinal: call.ordinal, name: call.name });
		if (!isSafeRead(executor, immutable.name)) { flushReads(); result.push(Object.freeze({ kind: 'barrier', calls: Object.freeze([immutable]) })); continue; }
		reads.push(immutable);
		if (reads.length === cap) flushReads();
	}
	flushReads();
	return Object.freeze(result);
};

/** A deterministic quotient/remainder split; earlier declaration ordinals receive the remainder. */
export const divideToolWaveOutputBudget = (total: number, count: number): readonly number[] => {
	const safeTotal = Number.isSafeInteger(total) ? Math.max(0, total) : 0;
	const safeCount = Number.isSafeInteger(count) ? Math.max(0, count) : 0;
	if (safeCount === 0) return Object.freeze([]);
	const quotient = Math.floor(safeTotal / safeCount);
	const remainder = safeTotal % safeCount;
	return Object.freeze(Array.from({ length: safeCount }, (_, ordinal) => quotient + (ordinal < remainder ? 1 : 0)));
};
