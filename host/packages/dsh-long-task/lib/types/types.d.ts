/**
 * Pure types of the long-task domain: the ONE home of the `longTask`
 * projection-key declaration plus the durable payload vocabulary it carries,
 * free of host-side imports (cordis events, dsh-agent, dsh-llm, the service).
 * Two namespace projections serve it — `./types` for host consumers,
 * `./client` (the client half-entry's re-export) for client aggregates — with
 * zero content duplication. Host-coupled domain vocabulary (message sources,
 * events, fold shapes) lives in ./domain.ts.
 *
 * The snapshot is the "hardcoded" task state: a bounded, fixed-schema ledger
 * (objective, live core entries, numbered checkpoints, numbered open
 * questions, one next action) that the agent rewrites at every seam. It is a
 * session projection — not a surface node — so surface compaction and context
 * handoff fold the conversation without ever touching this exact state.
 *
 * @module @deepseek-ai/dsh-long-task/types
 */
import type { Branded } from '@deepseek-ai/dsh-brand';
/** Identifies one long task across its durable revisions. */
export type LongTaskId = Branded<'LongTaskId'>;
/** Compare-and-set identity for one exact long-task revision. */
export interface LongTaskRef {
    /** Stable long-task identity. */
    readonly id: LongTaskId;
    /** Positive revision; every durable mutation increments it. */
    readonly revision: number;
}
/** Durable lifecycle phase. */
export type LongTaskPhase = 'active' | 'paused' | 'blocked' | 'complete';
/** Machine-routable and human-readable explanation for a blocked task. */
export interface LongTaskBlockReason {
    /** Stable lower-kebab-case classification chosen by the blocking policy. */
    readonly code: string;
    /** Non-empty explanation shown to humans and models. */
    readonly message: string;
}
/** One numbered, append-only verified result a later step may rely on. */
export interface Checkpoint {
    /** Stable positive ordinal, never reused. */
    readonly seq: number;
    /** What now holds. */
    readonly statement: string;
    /** What verified it, including coverage. */
    readonly verifiedBy: string;
}
/** One numbered open question and the cheapest thing that would settle it. */
export interface OpenQuestion {
    /** Stable positive ordinal, retired after the question closes. */
    readonly seq: number;
    /** The unsettled question. */
    readonly question: string;
    /** What would settle it. */
    readonly settledBy: string;
    /** Checkpoint ordinal the question closed against, present once closed. */
    readonly closesCheckpoint?: number;
}
/** Full durable state written by every non-clear long-task mutation. */
export interface LongTaskSnapshot extends LongTaskRef {
    /** One testable completion condition: what "done" means. */
    readonly objective: string;
    /** Durable lifecycle phase. */
    readonly phase: LongTaskPhase;
    /** Present exactly while `phase` is `blocked`. */
    readonly blockedReason?: LongTaskBlockReason;
    /** Broadcast hub entries; the first two are live, the rest parked. */
    readonly core: readonly string[];
    /** Numbered, append-only verified results. */
    readonly checkpoints: readonly Checkpoint[];
    /** Numbered open questions, closed against a checkpoint. */
    readonly openQuestions: readonly OpenQuestion[];
    /** The single next action; never empty. */
    readonly next: string;
    /** Total admitted round cap. */
    readonly maxRounds: number;
    /** Context handoffs (surface resets) recorded so far. */
    readonly handoffs: number;
}
/** Input whose omitted values are resolved by the service configuration. */
export interface CreateLongTaskRequest {
    /** What "done" means. */
    readonly objective: string;
    /** The first next action. */
    readonly next: string;
    /** Total admitted round cap; omitted resolves to the deployment default. */
    readonly maxRounds?: number;
    /** Initial hub entries. */
    readonly core?: readonly string[];
    /** Initial numbered checkpoints. */
    readonly checkpoints?: readonly Checkpoint[];
    /** Initial numbered open questions. */
    readonly openQuestions?: readonly OpenQuestion[];
}
/** Fields changed by an edit; at least one must be present. */
export interface EditLongTaskRequest {
    readonly objective?: string;
    readonly next?: string;
    readonly maxRounds?: number;
    readonly core?: readonly string[];
    readonly checkpoints?: readonly Checkpoint[];
    readonly openQuestions?: readonly OpenQuestion[];
}
/** Whether this live process may automatically continue an active task. */
export type LongTaskActivation = 'armed' | 'disarmed';
/** Current long-task projection, including values derived from the session log. */
export interface LongTaskView extends LongTaskSnapshot {
    /** Highest admitted round number for this task. */
    readonly roundsStarted: number;
    /** Epoch milliseconds of the create mutation. */
    readonly createdAt: number;
    /** Epoch milliseconds of the latest mutation. */
    readonly updatedAt: number;
    /** Process-local continuation eligibility; never persisted. */
    readonly activation: LongTaskActivation;
}
/**
 * The `longTask` projection value: the current durable task with its replay
 * counters, exactly as the latest `long-task/change` event carried them.
 * Activation is process-local (never persisted) and deliberately absent —
 * the projection reflects durable phase only.
 */
export interface LongTaskProjection {
    /** Current durable task snapshot (the CAS ref for mutations rides on it). */
    readonly task: LongTaskSnapshot;
    /** Highest admitted round number for this task. */
    readonly roundsStarted: number;
    /** Epoch milliseconds of the create mutation. */
    readonly createdAt: number;
    /** Epoch milliseconds of the latest mutation. */
    readonly updatedAt: number;
}
declare module '@deepseek-ai/dsh-session-projection/types' {
    interface SessionProjectionMap {
        /**
         * The session's current long task (the latest `long-task/change` whole
         * value), or `null` before the first create and after a clear tombstone.
         * Whole-value rule: every change carries the complete post-change state,
         * so the fold is last-wins.
         */
        longTask: LongTaskProjection | null;
    }
}
//# sourceMappingURL=types.d.ts.map