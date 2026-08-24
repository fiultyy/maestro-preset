/** Pure replay fold and strict decoder for durable long-task changes and handoff traces. */
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { LongTaskRef, LongTaskSnapshot } from './types.ts';
import type { FoldedLongTask, LongTaskChangeMeta, LongTaskHandoffMeta } from './domain.ts';
/** Mutable accumulator kept private to the pure fold. */
export interface LongTaskFoldState {
    task: LongTaskSnapshot | undefined;
    roundsStarted: number;
    createdAt: number | undefined;
    updatedAt: number | undefined;
    lastRef: LongTaskRef | undefined;
    seenTaskIds: Set<LongTaskSnapshot['id']>;
}
/**
 * Build an empty replay accumulator.
 * @returns mutable state with no current task or prior ref.
 */
export declare function emptyLongTaskFoldState(): LongTaskFoldState;
/**
 * Decode a value that declares itself as a long-task change. Unrelated values
 * return `undefined`; malformed long-task changes fail replay loudly.
 * @param value - candidate source change.
 * @returns validated change or `undefined` for another value kind.
 */
export declare function decodeLongTaskChange(value: unknown): LongTaskChangeMeta | undefined;
/**
 * Return the revision identity carried by a snapshot or tombstone.
 * @param change - decoded long-task mutation.
 * @returns stable identity used to reconcile a deferred change with its log event.
 */
export declare function longTaskChangeRef(change: LongTaskChangeMeta): LongTaskRef;
/**
 * Decode a long-task handoff trace value. Unrelated values return `undefined`.
 * @param value - candidate trace payload.
 * @returns validated trace or `undefined`.
 */
export declare function decodeLongTaskHandoff(value: unknown): LongTaskHandoffMeta | undefined;
/**
 * Validate and apply one decoded change to a mutable accumulator.
 * @param state - preceding durable long-task projection.
 * @param change - decoded full snapshot or clear tombstone.
 */
export declare function applyLongTaskChange(state: LongTaskFoldState, change: LongTaskChangeMeta): void;
/**
 * Apply one session event to the strict durable long-task fold.
 * @param state - mutable fold accumulator.
 * @param event - next event in sequence order.
 */
export declare function applyLongTaskEvent(state: LongTaskFoldState, event: SessionEvent): void;
/**
 * Fold current long-task state from a contiguous session event log.
 * @param events - session events in sequence order.
 * @returns a fresh durable projection; activation is deliberately absent.
 */
export declare function foldLongTask(events: readonly SessionEvent[]): FoldedLongTask;
//# sourceMappingURL=fold.d.ts.map