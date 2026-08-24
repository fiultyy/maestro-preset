/**
 * Model-facing `get_long_task`, `create_long_task`, and `update_long_task`
 * tools over the persisted same-session long-task domain.
 * @module @deepseek-ai/dsh-tool-long-task
 */
import z from '@deepseek-ai/schemastery';
import { LongTaskId } from '@deepseek-ai/dsh-long-task';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { completionAuthority, longTaskToolExecution, requireDirectHuman, requireLedgerWrite, } from "./authority.js";
export const name = 'tool-long-task';
export const inject = ['agents', 'longTasks', 'tools', 'systemPrompt'];
export const Config = z.object({});
const UPDATE_ACTIONS = ['edit', 'pause', 'resume', 'complete', 'blocked', 'clear'];
const CREATE_DESCRIPTION = 'Create one persisted same-session long task when the current direct human request is a '
    + 'long-running objective that needs hardcoded, re-readable state across many steps. Provide '
    + 'one testable objective and one next action. Do not use this for routine single-turn work. '
    + 'Execution rejects non-human and subagent authority.';
const GET_DESCRIPTION = 'Read the current same-session long task: its exact id/revision, objective, phase, live core '
    + 'entries, numbered checkpoints, numbered open questions, the single next action, round and '
    + 'handoff counters, blocker reason, and continuation activation. Call this before updating it, '
    + 'and re-read it at each seam so the hardcoded ledger stays authoritative.';
const UPDATE_DESCRIPTION = 'Update the exact current long-task revision. pause, resume, and clear require a direct '
    + 'top-level human request. During an automatic continuation round of the current task, '
    + 'edit, complete, and blocked are also allowed. edit replaces only the ledger fields you '
    + 'pass. clear discards the current task while retaining the durable history tombstone. Keep the ledger '
    + 'bounded: at most two live core entries, numbered checkpoints you may rely on, and numbered '
    + 'open questions each stating what would settle them. Never leave next empty.';
const CHECKPOINT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        statement: { type: 'string', required: true },
        verifiedBy: { type: 'string', required: true },
    },
};
const OPEN_QUESTION_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        question: { type: 'string', required: true },
        settledBy: { type: 'string', required: true },
        closesCheckpoint: { type: 'integer' },
    },
};
/** Output item schemas add the ordinal the tool assigns to input entries. */
const OUTPUT_CHECKPOINT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        seq: { type: 'integer', required: true },
        statement: { type: 'string', required: true },
        verifiedBy: { type: 'string', required: true },
    },
};
const OUTPUT_OPEN_QUESTION_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        seq: { type: 'integer', required: true },
        question: { type: 'string', required: true },
        settledBy: { type: 'string', required: true },
        closesCheckpoint: { type: 'integer' },
    },
};
const TASK_VALUE_SCHEMA = {
    oneOf: [
        { type: 'object', additionalProperties: false, properties: { task: { type: 'null', required: true } } },
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                task: {
                    type: 'object',
                    additionalProperties: false,
                    required: true,
                    properties: {
                        id: { type: 'string', required: true },
                        revision: { type: 'integer', required: true },
                        objective: { type: 'string', required: true },
                        phase: { type: 'string', required: true, enum: ['active', 'paused', 'blocked', 'complete'] },
                        core: { type: 'array', required: true, items: { type: 'string' } },
                        checkpoints: { type: 'array', required: true, items: OUTPUT_CHECKPOINT_SCHEMA },
                        openQuestions: { type: 'array', required: true, items: OUTPUT_OPEN_QUESTION_SCHEMA },
                        next: { type: 'string', required: true },
                        maxRounds: { type: 'integer', required: true },
                        handoffs: { type: 'integer', required: true },
                        roundsStarted: { type: 'integer', required: true },
                        blockedReason: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                code: { type: 'string', required: true },
                                message: { type: 'string', required: true },
                            },
                        },
                    },
                },
                activation: { type: 'string', required: true, enum: ['armed', 'disarmed'] },
            },
        },
    ],
};
/** Discipline guidance injected as a stable prompt section. */
const GUIDANCE = 'Use long-task tools for one long-running completion objective whose state you '
    + 'keep as a hardcoded ledger, not as conversation memory. Re-read the ledger with '
    + 'get_long_task at every seam (each round or context switch) and rewrite it through '
    + 'update_long_task before you rely on the conversation. Keep it bounded: one testable '
    + 'objective, at most two live core entries (park the rest), numbered checkpoints with what '
    + 'verified them, numbered open questions each with what would settle it, and one next action '
    + 'that is never empty. The ledger is state, not a transcript: drop reasoning, drafts, and logs.';
/** Stable compact model result. */
function longTaskValue(task) {
    if (task === undefined)
        return { task: null };
    return {
        task: {
            id: task.id,
            revision: task.revision,
            objective: task.objective,
            phase: task.phase,
            core: [...task.core],
            checkpoints: task.checkpoints.map(c => ({ ...c })),
            openQuestions: task.openQuestions.map(q => ({ ...q })),
            next: task.next,
            maxRounds: task.maxRounds,
            handoffs: task.handoffs,
            roundsStarted: task.roundsStarted,
            ...task.blockedReason === undefined ? {} : {
                blockedReason: { code: task.blockedReason.code, message: task.blockedReason.message },
            },
        },
        activation: task.activation,
    };
}
/** Reusable canonical output declaration for all three long-task controls. */
const LONG_TASK_OUTPUT = {
    schema: TASK_VALUE_SCHEMA,
    render: (_args, value) => [{
            type: 'text',
            text: JSON.stringify(value),
        }],
};
/** Generic, args-only pending presentation shared by the tools. */
function present(title, kind, rawInput) {
    return { card: 'generic', title, kind, ...rawInput === undefined ? {} : { rawInput } };
}
/** Build the exact compare-and-set ref from model arguments. */
function longTaskRef(taskId, revision) {
    if (taskId.length === 0 || taskId !== taskId.trim()
        || !Number.isSafeInteger(revision) || revision < 1) {
        throw new HarnessError('task_id must be non-empty and revision must be a positive safe integer', 'LONG_TASK_TOOL_INVALID_UPDATE');
    }
    return { id: LongTaskId(taskId), revision };
}
/** Number checkpoint inputs from 1 in array order. */
function numberCheckpoints(items) {
    if (items === undefined)
        return undefined;
    return items.map((item, index) => ({
        seq: index + 1,
        statement: item.statement,
        verifiedBy: item.verifiedBy,
    }));
}
/** Number open-question inputs from 1 in array order. */
function numberOpenQuestions(items) {
    if (items === undefined)
        return undefined;
    return items.map((item, index) => ({
        seq: index + 1,
        question: item.question,
        settledBy: item.settledBy,
        ...item.closesCheckpoint === undefined ? {} : { closesCheckpoint: item.closesCheckpoint },
    }));
}
/** Whether optional text is meaningful rather than a strict-schema empty filler. */
function hasText(value) {
    return value !== undefined && value !== '';
}
/** Whether an optional round cap is meaningful rather than a strict-schema zero filler. */
function hasRoundCap(value) {
    return value !== undefined && value !== 0;
}
/** Register the three long-task tools and their shared discipline section. */
export function apply(ctx, _config) {
    ctx.systemPrompt.section({
        name: 'tool:long-task',
        order: 114,
        text: GUIDANCE,
    });
    ctx.tools.register(defineTool({
        name: 'get_long_task',
        description: GET_DESCRIPTION,
        parameters: {},
        output: LONG_TASK_OUTPUT,
        execute(_args, exec) {
            const execution = longTaskToolExecution(ctx, exec);
            return Promise.resolve(longTaskValue(ctx.longTasks.get(execution.agent)));
        },
        presentCall: () => present('Read current long task', 'read'),
    }));
    ctx.tools.register(defineTool({
        name: 'create_long_task',
        description: CREATE_DESCRIPTION,
        parameters: {
            objective: { type: 'string', required: true, description: 'One testable completion condition: what "done" means.' },
            next: { type: 'string', required: true, description: 'The single first next action.' },
            max_rounds: { type: 'number', description: 'Optional positive safe-integer limit on automatic continuation rounds.' },
            core: { type: 'array', items: { type: 'string' }, description: 'Initial broadcast hub entries; at most two stay live.' },
            checkpoints: { type: 'array', items: CHECKPOINT_SCHEMA, description: 'Initial numbered verified results.' },
            open_questions: { type: 'array', items: OPEN_QUESTION_SCHEMA, description: 'Initial numbered open questions.' },
        },
        output: LONG_TASK_OUTPUT,
        execute(args, exec) {
            const execution = longTaskToolExecution(ctx, exec);
            requireDirectHuman(ctx, execution);
            const checkpoints = numberCheckpoints(args.checkpoints);
            const openQuestions = numberOpenQuestions(args.open_questions);
            const task = ctx.longTasks.create(execution.agent, {
                objective: args.objective,
                next: args.next,
                ...args.max_rounds === undefined ? {} : { maxRounds: args.max_rounds },
                ...args.core === undefined ? {} : { core: args.core },
                ...checkpoints === undefined ? {} : { checkpoints },
                ...openQuestions === undefined ? {} : { openQuestions },
            });
            return Promise.resolve(longTaskValue(task));
        },
        presentCall: args => present('Create long task', 'other', args.objective),
    }));
    ctx.tools.register(defineTool({
        name: 'update_long_task',
        description: UPDATE_DESCRIPTION,
        parameters: {
            task_id: { type: 'string', required: true, description: 'Exact id returned by get_long_task.' },
            revision: { type: 'number', required: true, description: 'Exact positive revision returned by get_long_task.' },
            action: { type: 'string', required: true, enum: UPDATE_ACTIONS, description: 'edit | pause | resume | complete | blocked | clear' },
            objective: { type: 'string', description: 'Replacement objective; valid only with action edit.' },
            next: { type: 'string', description: 'Replacement single next action; valid only with action edit.' },
            max_rounds: { type: 'number', description: 'Replacement round cap; valid only with action edit.' },
            core: { type: 'array', items: { type: 'string' }, description: 'Replacement hub entries; valid only with action edit.' },
            checkpoints: { type: 'array', items: CHECKPOINT_SCHEMA, description: 'Replacement numbered checkpoints; valid only with action edit.' },
            open_questions: { type: 'array', items: OPEN_QUESTION_SCHEMA, description: 'Replacement numbered open questions; valid only with action edit.' },
            blocked_reason: { type: 'string', description: 'Concrete blocking condition; required only with action blocked.' },
        },
        output: LONG_TASK_OUTPUT,
        execute(args, exec) {
            const execution = longTaskToolExecution(ctx, exec);
            const ref = longTaskRef(args.task_id, args.revision);
            const checkpoints = numberCheckpoints(args.checkpoints);
            const openQuestions = numberOpenQuestions(args.open_questions);
            const edits = {
                ...hasText(args.objective) ? { objective: args.objective } : {},
                ...hasText(args.next) ? { next: args.next } : {},
                ...hasRoundCap(args.max_rounds) ? { maxRounds: args.max_rounds } : {},
                ...args.core === undefined ? {} : { core: args.core },
                ...checkpoints === undefined ? {} : { checkpoints },
                ...openQuestions === undefined ? {} : { openQuestions },
            };
            const hasEditFields = Object.keys(edits).length > 0;
            if (args.action === 'edit') {
                requireLedgerWrite(ctx, execution);
                if (hasText(args.blocked_reason)) {
                    throw new HarnessError('blocked_reason is valid only with action blocked', 'LONG_TASK_TOOL_INVALID_UPDATE');
                }
                const task = ctx.longTasks.edit(execution.agent, ref, edits);
                return Promise.resolve(longTaskValue(task));
            }
            if (args.action === 'pause' || args.action === 'resume') {
                requireDirectHuman(ctx, execution);
                if (hasEditFields || hasText(args.blocked_reason)) {
                    throw new HarnessError('ledger fields are valid only with action edit; blocked_reason is valid only with action blocked', 'LONG_TASK_TOOL_INVALID_UPDATE');
                }
                const task = args.action === 'pause'
                    ? ctx.longTasks.pause(execution.agent, ref)
                    : ctx.longTasks.resume(execution.agent, ref);
                return Promise.resolve(longTaskValue(task));
            }
            if (args.action === 'clear') {
                requireDirectHuman(ctx, execution);
                if (hasEditFields || hasText(args.blocked_reason)) {
                    throw new HarnessError('ledger fields are valid only with action edit; blocked_reason is valid only with action blocked', 'LONG_TASK_TOOL_INVALID_UPDATE');
                }
                ctx.longTasks.clear(execution.agent, ref);
                return Promise.resolve(longTaskValue(undefined));
            }
            completionAuthority(ctx, execution);
            if (hasEditFields) {
                throw new HarnessError('ledger fields are valid only with action edit', 'LONG_TASK_TOOL_INVALID_UPDATE');
            }
            if (args.action === 'complete') {
                if (hasText(args.blocked_reason)) {
                    throw new HarnessError('blocked_reason is valid only with action blocked', 'LONG_TASK_TOOL_INVALID_UPDATE');
                }
                return Promise.resolve(longTaskValue(ctx.longTasks.complete(execution.agent, ref)));
            }
            if (args.blocked_reason === undefined || args.blocked_reason.trim().length === 0) {
                throw new HarnessError('blocked_reason is required with action blocked', 'LONG_TASK_TOOL_INVALID_UPDATE');
            }
            const message = args.blocked_reason.trim();
            return Promise.resolve(longTaskValue(ctx.longTasks.block(execution.agent, ref, {
                code: 'model-reported',
                message,
            })));
        },
        presentCall: args => present('Update long task', 'other', args.action),
    }));
}
//# sourceMappingURL=index.js.map