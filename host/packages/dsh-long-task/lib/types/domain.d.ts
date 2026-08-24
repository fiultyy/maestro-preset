/**
 * Host-side vocabulary of the long-task domain: live views, durable change
 * payloads, message attribution, replay folds, and the scoped
 * `long-task/changed` event. Kept separate from ./types.ts (the pure
 * client-safe outlet) because these declarations pull dsh-agent, dsh-llm, and
 * cordis into the program — the one-program-per-side layout forbids that on
 * client aggregates.
 * @module @deepseek-ai/dsh-long-task
 */
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { LongTaskId, LongTaskRef, LongTaskSnapshot, LongTaskView } from './types.ts';
/** Long-task state-changing verbs recorded in the durable source change. */
export type LongTaskOperation = 'create' | 'edit' | 'pause' | 'resume' | 'complete' | 'block' | 'clear' | 'handoff';
/** Why a context policy reset the surface while the durable ledger stayed exact. */
export type LongTaskHandoffReason = 'pressure' | 'overflow';
/** Full-snapshot long-task mutation committed by a durable `long-task/change` event. */
export interface LongTaskSnapshotChangeMeta {
    readonly kind: 'long-task/change';
    readonly version: 1;
    readonly operation: Exclude<LongTaskOperation, 'clear'>;
    readonly task: LongTaskSnapshot;
    readonly roundsStarted: number;
    readonly createdAt: number;
    readonly updatedAt: number;
}
/** Tombstone retained when the current long task is cleared. */
export interface LongTaskClearChangeMeta {
    readonly kind: 'long-task/change';
    readonly version: 1;
    readonly operation: 'clear';
    readonly cleared: LongTaskRef;
    readonly clearedAt: number;
}
/** Durable change union carried by the long-task domain's own session event. */
export type LongTaskChangeMeta = LongTaskSnapshotChangeMeta | LongTaskClearChangeMeta;
/**
 * Trace record appended when a context policy hands the task state to a fresh
 * surface: log-only and non-surface, it names the exact snapshot ref, the new
 * handoff count, and why. The rendered ledger is reconstructable from the
 * matching `long-task/change` snapshot; this event pins the reason and time.
 */
export interface LongTaskHandoffMeta {
    readonly kind: 'long-task/handoff';
    readonly version: 1;
    readonly ref: LongTaskRef;
    readonly handoffs: number;
    readonly reason: LongTaskHandoffReason;
    readonly at: number;
}
/** Message attribution for admitted continuation rounds. */
export interface LongTaskMessageSource {
    readonly kind: 'longTask';
    readonly taskId: LongTaskId;
    readonly revision: number;
    /** Positive admitted continuation round. */
    readonly round: number;
}
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        longTask: LongTaskMessageSource;
    }
}
declare module '@deepseek-ai/dsh-session/types' {
    interface SessionEventMap {
        /**
         * Complete post-mutation long-task state or clear tombstone.
         */
        'long-task/change': LongTaskChangeMeta;
        /**
         * Trace of one context handoff: log-only, non-surface, whole-value.
         */
        'long-task/handoff': LongTaskHandoffMeta;
    }
}
/** Pure replay fold of durable long-task facts. */
export interface FoldedLongTask {
    /** Current task, absent after a clear or before the first create. */
    readonly task?: LongTaskSnapshot;
    /** Highest admitted round for the current task. */
    readonly roundsStarted: number;
    /** Current task creation time, absent without a current task. */
    readonly createdAt?: number;
    /** Current task mutation time, absent without a current task. */
    readonly updatedAt?: number;
    /** Latest mutation ref, including a clear tombstone. */
    readonly lastRef?: LongTaskRef;
}
/** Live notification after one durable long-task mutation commits. */
export interface LongTaskChanged {
    readonly operation: LongTaskOperation;
    readonly ref: LongTaskRef;
    /** Absent for a clear tombstone. */
    readonly task?: LongTaskView;
}
/** Stable error codes for rejected long-task reads and mutations. */
export type LongTaskErrorCode = 'LONG_TASK_AGENT_NOT_LIVE' | 'LONG_TASK_NOT_FOUND' | 'LONG_TASK_ALREADY_EXISTS' | 'LONG_TASK_STALE_REVISION' | 'LONG_TASK_INVALID_OBJECTIVE' | 'LONG_TASK_INVALID_NEXT' | 'LONG_TASK_INVALID_MAX_ROUNDS' | 'LONG_TASK_INVALID_CORE' | 'LONG_TASK_INVALID_CHECKPOINTS' | 'LONG_TASK_INVALID_OPEN_QUESTIONS' | 'LONG_TASK_INVALID_BLOCK_REASON' | 'LONG_TASK_INVALID_EDIT' | 'LONG_TASK_INVALID_TRANSITION';
declare module '@deepseek-ai/cordis' {
    interface Events {
        /**
         * Long-task mutation accepted by one live agent. The matching
         * `long-task/change` session event has already committed. Listener
         * failures are contained. Scope-filtered dispatch (`@deepseek-ai/dsh-scope`):
         * agent-scoped listeners receive only that agent.
         * @param payload.agent - agent whose session owns the task.
         * @param payload.change - fresh current projection or clear tombstone.
         * @mode emit
         */
        'long-task/changed'(this: import('@deepseek-ai/dsh-scope').Scoped<Agent>, payload: {
            agent: Agent;
            change: LongTaskChanged;
        }): void;
    }
}
//# sourceMappingURL=domain.d.ts.map