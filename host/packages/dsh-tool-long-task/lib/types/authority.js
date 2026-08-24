/** Execution-time authority checks for the model-facing long-task tools. */
import { HarnessError } from '@deepseek-ai/dsh-llm';
/** Throw one structured tool-policy failure. */
function reject(message, code = 'LONG_TASK_TOOL_AUTHORITY_REQUIRED') {
    throw new HarnessError(message, code);
}
/** Locate the open turn enclosing a model tool call. */
function openTurn(agent) {
    const events = agent.session.events;
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const boundary = events[index];
        if (boundary?.type === 'turn/end') {
            reject('long-task tools require an open model turn', 'LONG_TASK_TOOL_DRIVER_REQUIRED');
        }
        if (boundary?.type === 'turn/start') {
            return { start: boundary, events: events.slice(index + 1) };
        }
    }
    return reject('long-task tools require an open model turn', 'LONG_TASK_TOOL_DRIVER_REQUIRED');
}
/**
 * Resolve and authenticate the calling agent and its driver boundary.
 * @param ctx - Context carrying the live agent registry.
 * @param exec - Tool execution metadata supplied by the registry.
 * @returns The authenticated agent and its current turn window.
 */
export function longTaskToolExecution(ctx, exec) {
    const agent = exec.agent;
    if (agent === undefined) {
        return reject('long-task tools require a calling agent', 'LONG_TASK_TOOL_AGENT_REQUIRED');
    }
    if (ctx.agents.get(agent.id) !== agent || agent.status !== 'running'
        || ctx.agents.currentInitiator() !== agent) {
        return reject('long-task tools require the exact live calling agent inside its active driver', 'LONG_TASK_TOOL_DRIVER_REQUIRED');
    }
    return { agent, ...openTurn(agent) };
}
/**
 * Whether host-attested human input appears in the current root-agent turn.
 * An omitted `Agent.followup()` / `steer()` source resolves to `user`, so non-human
 * producers must supply their own source rather than inheriting this authority.
 */
function hasDirectHumanInput(ctx, execution) {
    if (!ctx.agents.roots().includes(execution.agent))
        return false;
    return execution.events.some(event => event.type === 'user/message' && event.data.source.kind === 'user');
}
/**
 * Whether this turn is the current task's exact admitted round. Mid-round
 * handoffs bump the task revision without changing the admitted round's
 * identity, so the admitted revision is not part of the match.
 */
function isMatchingLongTaskRound(execution, task) {
    return execution.events.some(event => event.type === 'user/message'
        && event.data.source.kind === 'longTask'
        && event.data.source.taskId === task.id
        && event.data.source.round === task.roundsStarted);
}
/**
 * Require authority originating in a human message accepted by a runtime root.
 * @param ctx - Context carrying the live agent graph.
 * @param execution - Authenticated current tool execution.
 */
export function requireDirectHuman(ctx, execution) {
    if (hasDirectHumanInput(ctx, execution))
        return;
    reject('this long-task operation requires a direct human turn on a top-level agent');
}
/**
 * Require authority to rewrite ledger fields: a direct human turn or the task's
 * current admitted round, whose continuation prompt instructs exactly this
 * rewrite before each seam.
 * @param ctx - Context carrying live agents and long-task state.
 * @param execution - Authenticated current tool execution.
 */
export function requireLedgerWrite(ctx, execution) {
    if (hasDirectHumanInput(ctx, execution))
        return;
    const task = ctx.longTasks.get(execution.agent);
    if (task !== undefined && isMatchingLongTaskRound(execution, task))
        return;
    reject('editing the long-task ledger requires a direct human turn or the current long-task round');
}
/**
 * Resolve completion authority from either direct human input or the exact long-task round.
 * @param ctx - Context carrying live agents and long-task state.
 * @param execution - Authenticated current tool execution.
 * @returns The direct-human or exact-long-task-round authority grant.
 */
export function completionAuthority(ctx, execution) {
    if (hasDirectHumanInput(ctx, execution))
        return { kind: 'direct-human' };
    const task = ctx.longTasks.get(execution.agent);
    if (task !== undefined && isMatchingLongTaskRound(execution, task)) {
        return { kind: 'long-task-round', task };
    }
    return reject('complete and blocked require a direct human turn or the current long-task round');
}
//# sourceMappingURL=authority.js.map