/** Package-owned long-task round prompt invariants. @module @deepseek-ai/dsh-long-task-round-driver/invariant */
import { isDeepStrictEqual } from 'node:util';
import { foldLongTask } from '@deepseek-ai/dsh-long-task';
import { renderLongTaskRoundPrompt } from "./prompt.js";
const PACKAGE_NAME = '@deepseek-ai/dsh-long-task-round-driver';
/** Cordis companion plugin name. */
export const name = 'long-task-round-driver-invariant';
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants'];
/** Attribute strict long-task-fold failures to this companion's reconstruction. */
function foldChecked(events, fail) {
    try {
        return foldLongTask(events);
    }
    catch (error) {
        /* v8 ignore next -- the strict long-task decoder throws Error instances */
        const message = error instanceof Error ? error.message : String(error);
        return fail(`cannot reconstruct the long task before a continuation message: ${message}`);
    }
}
/** Recreate the live-shaped view consumed by the package's pure prompt renderer. */
function longTaskView(folded, source, fail) {
    const task = folded.task;
    if (task === undefined || folded.createdAt === undefined || folded.updatedAt === undefined
        || task.phase !== 'active' || task.id !== source.taskId || task.revision !== source.revision
        || source.round !== folded.roundsStarted + 1 || source.round > task.maxRounds) {
        return fail(`long-task round ${source.round} cannot be reconstructed from the preceding durable task state`);
    }
    return {
        ...task,
        roundsStarted: folded.roundsStarted,
        createdAt: folded.createdAt,
        updatedAt: folded.updatedAt,
        activation: 'armed',
    };
}
/** Validate one package-owned continuation message against its durable prefix. */
function validateEvent(prior, event, fail) {
    if (event.type !== 'user/message')
        return;
    const source = event.data.source;
    if (source.kind !== 'longTask' || source.round <= 0)
        return;
    const expected = renderLongTaskRoundPrompt(longTaskView(foldChecked(prior, fail), source, fail), source.round);
    if (!isDeepStrictEqual(event.data.content, expected)) {
        fail(`long-task round ${source.round} content does not match the package-owned continuation prompt`);
    }
}
/** Check existing sessions and every candidate event before Session publishes it. */
const install = Object.assign((ctx, fail) => {
    for (const session of ctx.sessions.list()) {
        const prior = [];
        for (const event of session.events) {
            validateEvent(prior, event, fail);
            prior.push(event);
        }
    }
    /* jscpd:ignore-start -- package companions share dispatch and registration plumbing */
    ctx.on('internal/dispatch', (_mode, eventName, args) => {
        if (eventName !== 'session/event')
            return;
        const [session, event] = args;
        validateEvent(session.events, event, fail);
    }, { global: true });
}, { inject: ['sessions'] });
/**
 * Register the long-task-round-driver invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
/* jscpd:ignore-end */
//# sourceMappingURL=invariant.js.map