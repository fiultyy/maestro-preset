/** Execution-time authority checks for the model-facing long-task tools. */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { LongTaskView } from '@deepseek-ai/dsh-long-task';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
type TurnStartEvent = Extract<SessionEvent, {
    type: 'turn/start';
}>;
/** Current open turn plus the events accepted after its start boundary. */
export interface LongTaskToolExecution {
    readonly agent: Agent;
    readonly start: TurnStartEvent;
    readonly events: readonly SessionEvent[];
}
/** Hard authority granted to one state-changing call. */
export type LongTaskToolAuthority = {
    readonly kind: 'direct-human';
} | {
    readonly kind: 'long-task-round';
    readonly task: LongTaskView;
};
/**
 * Resolve and authenticate the calling agent and its driver boundary.
 * @param ctx - Context carrying the live agent registry.
 * @param exec - Tool execution metadata supplied by the registry.
 * @returns The authenticated agent and its current turn window.
 */
export declare function longTaskToolExecution(ctx: Context, exec: ToolRunContext): LongTaskToolExecution;
/**
 * Require authority originating in a human message accepted by a runtime root.
 * @param ctx - Context carrying the live agent graph.
 * @param execution - Authenticated current tool execution.
 */
export declare function requireDirectHuman(ctx: Context, execution: LongTaskToolExecution): void;
/**
 * Require authority to rewrite ledger fields: a direct human turn or the task's
 * current admitted round, whose continuation prompt instructs exactly this
 * rewrite before each seam.
 * @param ctx - Context carrying live agents and long-task state.
 * @param execution - Authenticated current tool execution.
 */
export declare function requireLedgerWrite(ctx: Context, execution: LongTaskToolExecution): void;
/**
 * Resolve completion authority from either direct human input or the exact long-task round.
 * @param ctx - Context carrying live agents and long-task state.
 * @param execution - Authenticated current tool execution.
 * @returns The direct-human or exact-long-task-round authority grant.
 */
export declare function completionAuthority(ctx: Context, execution: LongTaskToolExecution): LongTaskToolAuthority;
export {};
//# sourceMappingURL=authority.d.ts.map