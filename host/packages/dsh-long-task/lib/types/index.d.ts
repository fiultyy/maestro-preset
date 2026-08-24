/**
 * Same-session long-task domain: event-sourced hardcoded task state,
 * compare-and-set mutations, and process-local continuation activation.
 *
 * The state is the "hardcoded" ledger — objective, live core entries, numbered
 * checkpoints, numbered open questions, and one next action — written by the
 * agent at every seam and folded as a session projection rather than a surface
 * node. Surface compaction and context handoff therefore fold the conversation
 * without touching this exact state.
 *
 * @module @deepseek-ai/dsh-long-task
 */
import { Context, Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { CreateLongTaskRequest, EditLongTaskRequest, LongTaskBlockReason, LongTaskProjection, LongTaskRef, LongTaskView } from './types.ts';
import type { LongTaskHandoffReason } from './domain.ts';
export type * from './types.ts';
export type * from './domain.ts';
export { LONG_TASK_CHANGE_VERSION, LongTaskError, LongTaskId } from './runtime.ts';
export { decodeLongTaskChange, foldLongTask, longTaskChangeRef } from './fold.ts';
export { renderLongTaskLedger } from './render.ts';
declare module '@deepseek-ai/cordis' {
    interface Context {
        longTasks: LongTaskService;
    }
}
/**
 * Light last-wins fold of the `longTask` projection unit. Unlike the strict
 * replay fold (fold.ts: transition validation, fail-loud on malformed
 * changes, Set-typed state), this transition is projection-grade: the state
 * is plain JSON (persisted-cache precondition), any non-long-task or malformed
 * event returns the same reference (the registry's Object.is gate), and
 * correctness of the written change is the write side's job (LongTaskService
 * validated it before appending).
 * @param state - the projection covering all prior events.
 * @param event - the next committed session event.
 * @returns the next projection (same reference when the event is not a long-task change).
 */
export declare function applyLongTaskProjection(state: LongTaskProjection | null, event: SessionEvent): LongTaskProjection | null;
/** Deployment defaults for long-task creation. */
export interface Config {
    /** Total rounds used when a create request omits its own cap. */
    defaultMaxRounds?: number;
}
/** Resolved defaults. */
export interface ResolvedConfig {
    /** Validated positive safe-integer default round cap. */
    defaultMaxRounds: number;
}
/** Long-task service (`ctx.longTasks`) backed exclusively by the owning session log. */
export declare class LongTaskService extends Service {
    static inject: string[];
    static Config: z<Config>;
    private readonly resolved;
    private readonly caches;
    constructor(ctx: Context, config?: Config);
    /**
     * Read the current long task for one exact live agent.
     * @param agent - owning live agent.
     * @returns a fresh view or `undefined` when no task is current.
     * @throws {@link LongTaskError} when the agent is not the registry's live instance.
     */
    get(agent: Agent): LongTaskView | undefined;
    /**
     * Remove process-local continuation authority without changing durable task
     * phase or revision. Lifecycle owners use this before unloading a driver.
     * @param agent - owning live agent.
     * @returns a fresh disarmed view, or `undefined` when no task is current.
     */
    disarm(agent: Agent): LongTaskView | undefined;
    /**
     * Create and arm a long task. A completed task may be replaced; every other
     * current phase must be cleared or resumed instead.
     * @param agent - owning live agent.
     * @param request - objective, next action, and optional ledger fields and round cap.
     * @returns the created live view.
     */
    create(agent: Agent, request: CreateLongTaskRequest): LongTaskView;
    /**
     * Edit ledger fields without changing phase, handoffs, or blocker reason.
     * @param agent - owning live agent.
     * @param ref - expected current revision.
     * @param request - at least one replacement field.
     * @returns the edited view.
     */
    edit(agent: Agent, ref: LongTaskRef, request: EditLongTaskRequest): LongTaskView;
    /**
     * Pause an active task and disarm automatic continuation.
     * @param agent - owning live agent.
     * @param ref - expected current revision.
     * @returns the paused view.
     */
    pause(agent: Agent, ref: LongTaskRef): LongTaskView;
    /**
     * Resume and arm a stopped task, or rearm an active task after a
     * session-start edge, while its round budget still has capacity.
     * @param agent - owning live agent.
     * @param ref - expected current revision.
     * @returns the active view.
     */
    resume(agent: Agent, ref: LongTaskRef): LongTaskView;
    /**
     * Mark a current non-complete task complete and disarm it.
     * @param agent - owning live agent.
     * @param ref - expected current revision.
     * @returns the completed view.
     */
    complete(agent: Agent, ref: LongTaskRef): LongTaskView;
    /**
     * Mark an active task blocked and disarm it.
     * @param agent - owning live agent.
     * @param ref - expected current revision.
     * @param reason - policy-owned stable code and human-readable explanation.
     * @returns the blocked view with its durable reason.
     */
    block(agent: Agent, ref: LongTaskRef, reason: LongTaskBlockReason): LongTaskView;
    /**
     * Record one context handoff: increment the durable handoff counter and
     * append a non-surface trace event, without changing phase or activation.
     * @param agent - owning live agent.
     * @param ref - expected current revision.
     * @param reason - why the context policy handed the surface off.
     * @returns the updated active view.
     */
    handoff(agent: Agent, ref: LongTaskRef, reason: LongTaskHandoffReason): LongTaskView;
    /**
     * Clear the current task while retaining a durable tombstone and history.
     * @param agent - owning live agent.
     * @param ref - expected current revision.
     * @returns the tombstone ref whose revision is one past the cleared snapshot.
     */
    clear(agent: Agent, ref: LongTaskRef): LongTaskRef;
    /** Resolve and validate the cache used by a mutation. */
    private prepareMutation;
    /** Reject stale or missing current-state refs. */
    private expectCurrent;
    /** Enforce exact live-agent identity rather than trusting a matching id. */
    private assertLive;
    /** Return the per-session cache, folding a seed once with activation disarmed. */
    private cache;
    /** Incrementally observe durable events and reconcile local activation intent. */
    private sync;
    /** Build a new revision with one replacement phase. */
    private withPhase;
    /** Shared validated phase transition. */
    private transition;
    /** Render a stable invalid-transition error. */
    private transitionError;
    /** Commit a mutation that retains the current task's derived counters/times. */
    private commitCurrent;
    /** Clamp a current task's next timestamp across backward wall-clock movement. */
    private nextMutationTime;
    /** Build and commit one full-snapshot mutation. */
    private commitSnapshot;
    /** Commit one mutation into the long-task log, cache, and live event stream. */
    private commit;
    /** Build a detached current view. */
    private view;
}
export default LongTaskService;
//# sourceMappingURL=index.d.ts.map