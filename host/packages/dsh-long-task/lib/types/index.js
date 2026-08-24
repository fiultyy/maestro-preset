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
import { randomUUID } from 'node:crypto';
import { Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { z as zod } from 'zod';
import { agentEvents } from '@deepseek-ai/dsh-agent';
import { applyLongTaskEvent, decodeLongTaskChange, emptyLongTaskFoldState, longTaskChangeRef, } from "./fold.js";
import { LONG_TASK_CHANGE_VERSION, LongTaskError, LongTaskId, } from "./runtime.js";
export { LONG_TASK_CHANGE_VERSION, LongTaskError, LongTaskId } from "./runtime.js";
export { decodeLongTaskChange, foldLongTask, longTaskChangeRef } from "./fold.js";
export { renderLongTaskLedger } from "./render.js";
/** Wire payload schema of the `longTask` projection (whole task or pre-create/cleared null). */
const longTaskProjectionSchema = zod.union([
    zod.object({
        task: zod.object({
            id: zod.string().min(1),
            revision: zod.number().int().positive(),
            objective: zod.string().min(1),
            phase: zod.union([zod.literal('active'), zod.literal('paused'), zod.literal('blocked'), zod.literal('complete')]),
            blockedReason: zod.object({ code: zod.string(), message: zod.string() }).optional(),
            core: zod.array(zod.string()),
            checkpoints: zod.array(zod.object({
                seq: zod.number().int().positive(),
                statement: zod.string().min(1),
                verifiedBy: zod.string().min(1),
            })),
            openQuestions: zod.array(zod.object({
                seq: zod.number().int().positive(),
                question: zod.string().min(1),
                settledBy: zod.string().min(1),
                closesCheckpoint: zod.number().int().positive().optional(),
            })),
            next: zod.string().min(1),
            maxRounds: zod.number().int().positive(),
            handoffs: zod.number().int().nonnegative(),
        }),
        roundsStarted: zod.number().int().nonnegative(),
        createdAt: zod.number(),
        updatedAt: zod.number(),
    }),
    zod.null(),
]);
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
export function applyLongTaskProjection(state, event) {
    if (event.type !== 'long-task/change')
        return state;
    let change;
    try {
        change = decodeLongTaskChange(event.data);
    }
    catch (_invalidPersistedLongTaskChange) {
        return state;
    }
    if (change === undefined)
        return state;
    return change.operation === 'clear'
        ? null
        : {
            task: change.task,
            roundsStarted: change.roundsStarted,
            createdAt: change.createdAt,
            updatedAt: change.updatedAt,
        };
}
/** Validate a caller-visible positive safe-integer round cap. */
function resolveMaxRounds(value) {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new LongTaskError('maxRounds must be a positive safe integer', 'LONG_TASK_INVALID_MAX_ROUNDS');
    }
    return value;
}
/** Validate and normalize a required single-line string. */
function resolveRequired(value, code) {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new LongTaskError(`${code === 'LONG_TASK_INVALID_OBJECTIVE' ? 'objective' : 'next'} must be a non-empty string`, code);
    }
    return value.trim();
}
/** Validate a bounded homogeneous string list. */
function resolveCore(value) {
    if (value.length > 20)
        throw new LongTaskError('core must hold at most 20 entries', 'LONG_TASK_INVALID_CORE');
    return value.map((entry) => {
        if (typeof entry !== 'string' || entry.trim().length === 0) {
            throw new LongTaskError('core entries must be non-empty strings', 'LONG_TASK_INVALID_CORE');
        }
        return entry.trim();
    });
}
/** Validate numbered checkpoints: positive strictly increasing ordinals. */
function resolveCheckpoints(value) {
    const result = value.map((entry, index) => {
        if (!Number.isSafeInteger(entry.seq) || entry.seq !== index + 1
            || entry.statement.trim().length === 0
            || entry.verifiedBy.trim().length === 0) {
            throw new LongTaskError('checkpoints require strictly increasing ordinals and non-empty statement/verifiedBy', 'LONG_TASK_INVALID_CHECKPOINTS');
        }
        return { seq: entry.seq, statement: entry.statement.trim(), verifiedBy: entry.verifiedBy.trim() };
    });
    if (result.length > 100)
        throw new LongTaskError('checkpoints must hold at most 100 entries', 'LONG_TASK_INVALID_CHECKPOINTS');
    return result;
}
/** Validate numbered open questions against the resulting checkpoint ordinals. */
function resolveOpenQuestions(value, checkpoints) {
    const result = value.map((entry, index) => {
        if (!Number.isSafeInteger(entry.seq) || entry.seq !== index + 1
            || entry.question.trim().length === 0
            || entry.settledBy.trim().length === 0) {
            throw new LongTaskError('openQuestions require strictly increasing ordinals and non-empty question/settledBy', 'LONG_TASK_INVALID_OPEN_QUESTIONS');
        }
        return {
            seq: entry.seq,
            question: entry.question.trim(),
            settledBy: entry.settledBy.trim(),
            ...entry.closesCheckpoint === undefined ? {} : { closesCheckpoint: entry.closesCheckpoint },
        };
    });
    if (result.length > 100)
        throw new LongTaskError('openQuestions must hold at most 100 entries', 'LONG_TASK_INVALID_OPEN_QUESTIONS');
    for (const entry of result) {
        if (entry.closesCheckpoint !== undefined
            && !checkpoints.some(checkpoint => checkpoint.seq === entry.closesCheckpoint)) {
            throw new LongTaskError(`open question ${entry.seq} closes an unknown checkpoint`, 'LONG_TASK_INVALID_OPEN_QUESTIONS');
        }
    }
    return result;
}
/** Validate and detach one policy-owned blocker explanation. */
function resolveBlockReason(reason) {
    const record = typeof reason === 'object' && reason !== null && !Array.isArray(reason)
        ? reason
        : undefined;
    const code = record?.['code'];
    const message = record?.['message'];
    if (typeof code !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(code)
        || typeof message !== 'string' || message.trim().length === 0) {
        throw new LongTaskError('long-task block reason requires a lower-kebab-case code and a non-empty message', 'LONG_TASK_INVALID_BLOCK_REASON');
    }
    return { code, message: message.trim() };
}
/** Materialize deployment defaults and validate one create request. */
function resolveCreateLongTask(request, defaultMaxRounds) {
    const checkpoints = resolveCheckpoints(request.checkpoints ?? []);
    return {
        objective: resolveRequired(request.objective, 'LONG_TASK_INVALID_OBJECTIVE'),
        next: resolveRequired(request.next, 'LONG_TASK_INVALID_NEXT'),
        maxRounds: resolveMaxRounds(request.maxRounds ?? defaultMaxRounds),
        core: resolveCore(request.core ?? []),
        checkpoints,
        openQuestions: resolveOpenQuestions(request.openQuestions ?? [], checkpoints),
    };
}
/** Validate one edit request and resolve only its present fields. */
function resolveEditLongTask(request) {
    if (request.objective === undefined && request.next === undefined && request.maxRounds === undefined
        && request.core === undefined && request.checkpoints === undefined && request.openQuestions === undefined) {
        throw new LongTaskError('long-task edit requires at least one field', 'LONG_TASK_INVALID_EDIT');
    }
    const checkpoints = request.checkpoints === undefined ? undefined : resolveCheckpoints(request.checkpoints);
    return {
        ...request.objective === undefined ? {} : { objective: resolveRequired(request.objective, 'LONG_TASK_INVALID_OBJECTIVE') },
        ...request.next === undefined ? {} : { next: resolveRequired(request.next, 'LONG_TASK_INVALID_NEXT') },
        ...request.maxRounds === undefined ? {} : { maxRounds: resolveMaxRounds(request.maxRounds) },
        ...request.core === undefined ? {} : { core: resolveCore(request.core) },
        ...checkpoints === undefined ? {} : { checkpoints },
        ...request.openQuestions === undefined
            ? {}
            : { openQuestions: resolveOpenQuestions(request.openQuestions, checkpoints ?? []) },
    };
}
/** Long-task service (`ctx.longTasks`) backed exclusively by the owning session log. */
export class LongTaskService extends Service {
    static inject = ['agents'];
    static Config = z.object({
        defaultMaxRounds: z.number().default(256),
    });
    resolved;
    caches = new WeakMap();
    constructor(ctx, config = {}) {
        super(ctx, 'longTasks');
        this.resolved = {
            defaultMaxRounds: resolveMaxRounds(config.defaultMaxRounds ?? 256),
        };
        ctx.on('agent/session-start', ({ agent }) => {
            this.cache(agent.session).activation = 'disarmed';
        });
        // The `longTask` projection unit: last-wins fold of long-task/change whole
        // values (see applyLongTaskProjection).
        ctx.inject(['sessionProjections'], (projectionCtx) => {
            projectionCtx.sessionProjections.register({
                key: 'longTask',
                stateSchema: longTaskProjectionSchema,
                init: () => null,
                apply: applyLongTaskProjection,
                wire: { viewSchema: longTaskProjectionSchema, view: state => state },
                stateVersion: 1,
            });
        });
    }
    /**
     * Read the current long task for one exact live agent.
     * @param agent - owning live agent.
     * @returns a fresh view or `undefined` when no task is current.
     * @throws {@link LongTaskError} when the agent is not the registry's live instance.
     */
    get(agent) {
        this.assertLive(agent);
        const cache = this.cache(agent.session);
        this.sync(agent.session, cache);
        return this.view(cache);
    }
    /**
     * Remove process-local continuation authority without changing durable task
     * phase or revision. Lifecycle owners use this before unloading a driver.
     * @param agent - owning live agent.
     * @returns a fresh disarmed view, or `undefined` when no task is current.
     */
    disarm(agent) {
        this.assertLive(agent);
        const cache = this.cache(agent.session);
        this.sync(agent.session, cache);
        cache.activation = 'disarmed';
        return this.view(cache);
    }
    /**
     * Create and arm a long task. A completed task may be replaced; every other
     * current phase must be cleared or resumed instead.
     * @param agent - owning live agent.
     * @param request - objective, next action, and optional ledger fields and round cap.
     * @returns the created live view.
     */
    create(agent, request) {
        const spec = resolveCreateLongTask(request, this.resolved.defaultMaxRounds);
        const cache = this.prepareMutation(agent);
        const current = cache.state.task;
        if (current !== undefined && current.phase !== 'complete') {
            throw new LongTaskError(`long task "${current.id}" already exists with phase "${current.phase}"`, 'LONG_TASK_ALREADY_EXISTS');
        }
        const now = Date.now();
        const task = {
            id: LongTaskId(`longtask-${randomUUID()}`),
            revision: 1,
            objective: spec.objective,
            phase: 'active',
            core: spec.core,
            checkpoints: spec.checkpoints,
            openQuestions: spec.openQuestions,
            next: spec.next,
            maxRounds: spec.maxRounds,
            handoffs: 0,
        };
        return this.commitSnapshot(agent, cache, 'create', task, 0, now, now, 'armed');
    }
    /**
     * Edit ledger fields without changing phase, handoffs, or blocker reason.
     * @param agent - owning live agent.
     * @param ref - expected current revision.
     * @param request - at least one replacement field.
     * @returns the edited view.
     */
    edit(agent, ref, request) {
        const cache = this.prepareMutation(agent);
        const current = this.expectCurrent(cache, ref);
        const patch = resolveEditLongTask(request);
        const task = {
            ...current,
            revision: current.revision + 1,
            ...patch,
        };
        return this.commitCurrent(agent, cache, 'edit', task, cache.activation);
    }
    /**
     * Pause an active task and disarm automatic continuation.
     * @param agent - owning live agent.
     * @param ref - expected current revision.
     * @returns the paused view.
     */
    pause(agent, ref) {
        return this.transition(agent, ref, 'pause', ['active'], 'paused', 'disarmed');
    }
    /**
     * Resume and arm a stopped task, or rearm an active task after a
     * session-start edge, while its round budget still has capacity.
     * @param agent - owning live agent.
     * @param ref - expected current revision.
     * @returns the active view.
     */
    resume(agent, ref) {
        const cache = this.prepareMutation(agent);
        const current = this.expectCurrent(cache, ref);
        const resumable = ['active', 'paused', 'blocked'];
        if (!resumable.includes(current.phase)) {
            throw this.transitionError(current, 'resume', resumable);
        }
        if (current.phase === 'active' && cache.activation === 'armed') {
            throw new LongTaskError(`long task "${current.id}" is already active and armed`, 'LONG_TASK_INVALID_TRANSITION');
        }
        if (cache.state.roundsStarted >= current.maxRounds) {
            throw new LongTaskError(`long task "${current.id}" exhausted ${current.maxRounds} rounds; increase maxRounds before resuming`, 'LONG_TASK_INVALID_TRANSITION');
        }
        return this.commitCurrent(agent, cache, 'resume', this.withPhase(current, 'active'), 'armed');
    }
    /**
     * Mark a current non-complete task complete and disarm it.
     * @param agent - owning live agent.
     * @param ref - expected current revision.
     * @returns the completed view.
     */
    complete(agent, ref) {
        return this.transition(agent, ref, 'complete', ['active', 'paused', 'blocked'], 'complete', 'disarmed');
    }
    /**
     * Mark an active task blocked and disarm it.
     * @param agent - owning live agent.
     * @param ref - expected current revision.
     * @param reason - policy-owned stable code and human-readable explanation.
     * @returns the blocked view with its durable reason.
     */
    block(agent, ref, reason) {
        const cache = this.prepareMutation(agent);
        const current = this.expectCurrent(cache, ref);
        if (current.phase !== 'active') {
            throw this.transitionError(current, 'block', ['active']);
        }
        return this.commitCurrent(agent, cache, 'block', { ...this.withPhase(current, 'blocked'), blockedReason: resolveBlockReason(reason) }, 'disarmed');
    }
    /**
     * Record one context handoff: increment the durable handoff counter and
     * append a non-surface trace event, without changing phase or activation.
     * @param agent - owning live agent.
     * @param ref - expected current revision.
     * @param reason - why the context policy handed the surface off.
     * @returns the updated active view.
     */
    handoff(agent, ref, reason) {
        const cache = this.prepareMutation(agent);
        const current = this.expectCurrent(cache, ref);
        if (current.phase !== 'active') {
            throw this.transitionError(current, 'handoff', ['active']);
        }
        const next = {
            ...current,
            revision: current.revision + 1,
            handoffs: current.handoffs + 1,
        };
        const view = this.commitCurrent(agent, cache, 'handoff', next, cache.activation);
        const trace = {
            kind: 'long-task/handoff',
            version: 1,
            ref: { id: next.id, revision: next.revision },
            handoffs: next.handoffs,
            reason,
            at: Date.now(),
        };
        agent.session.append('long-task/handoff', trace);
        this.sync(agent.session, cache);
        return view;
    }
    /**
     * Clear the current task while retaining a durable tombstone and history.
     * @param agent - owning live agent.
     * @param ref - expected current revision.
     * @returns the tombstone ref whose revision is one past the cleared snapshot.
     */
    clear(agent, ref) {
        const cache = this.prepareMutation(agent);
        const current = this.expectCurrent(cache, ref);
        const tombstone = { id: current.id, revision: current.revision + 1 };
        const change = {
            kind: 'long-task/change',
            version: LONG_TASK_CHANGE_VERSION,
            operation: 'clear',
            cleared: tombstone,
            clearedAt: this.nextMutationTime(cache),
        };
        this.commit(agent, cache, change, 'disarmed');
        return { ...tombstone };
    }
    /** Resolve and validate the cache used by a mutation. */
    prepareMutation(agent) {
        this.assertLive(agent);
        const cache = this.cache(agent.session);
        this.sync(agent.session, cache);
        return cache;
    }
    /** Reject stale or missing current-state refs. */
    expectCurrent(cache, ref) {
        const current = cache.state.task;
        if (current === undefined)
            throw new LongTaskError('no current long task', 'LONG_TASK_NOT_FOUND');
        if (ref.id !== current.id || ref.revision !== current.revision) {
            throw new LongTaskError(`stale long-task ref "${ref.id}" revision ${ref.revision}; current is "${current.id}" revision ${current.revision}`, 'LONG_TASK_STALE_REVISION');
        }
        return current;
    }
    /** Enforce exact live-agent identity rather than trusting a matching id. */
    assertLive(agent) {
        if (this.ctx.agents.get(agent.id) !== agent) {
            throw new LongTaskError(`agent "${agent.id}" is not live in this registry`, 'LONG_TASK_AGENT_NOT_LIVE');
        }
    }
    /** Return the per-session cache, folding a seed once with activation disarmed. */
    cache(session) {
        let cache = this.caches.get(session);
        if (cache !== undefined)
            return cache;
        const state = emptyLongTaskFoldState();
        for (const event of session.events)
            applyLongTaskEvent(state, event);
        cache = {
            state,
            activation: 'disarmed',
            observedSeq: session.seq,
            pendingActivation: undefined,
        };
        this.caches.set(session, cache);
        return cache;
    }
    /** Incrementally observe durable events and reconcile local activation intent. */
    sync(session, cache) {
        for (const event of session.events.slice(cache.observedSeq)) {
            applyLongTaskEvent(cache.state, event);
            if (event.type === 'long-task/change') {
                cache.activation = cache.pendingActivation?.seq === event.seq
                    ? cache.pendingActivation.activation
                    : 'disarmed';
            }
            cache.observedSeq += 1;
        }
    }
    /** Build a new revision with one replacement phase. */
    withPhase(current, phase) {
        return {
            ...current,
            revision: current.revision + 1,
            phase,
        };
    }
    /** Shared validated phase transition. */
    transition(agent, ref, operation, allowed, phase, activation) {
        const cache = this.prepareMutation(agent);
        const current = this.expectCurrent(cache, ref);
        if (!allowed.includes(current.phase))
            throw this.transitionError(current, operation, allowed);
        return this.commitCurrent(agent, cache, operation, this.withPhase(current, phase), activation);
    }
    /** Render a stable invalid-transition error. */
    transitionError(current, operation, allowed) {
        return new LongTaskError(`cannot ${operation} long task "${current.id}" from phase "${current.phase}"; expected ${allowed.join(' or ')}`, 'LONG_TASK_INVALID_TRANSITION');
    }
    /** Commit a mutation that retains the current task's derived counters/times. */
    commitCurrent(agent, cache, operation, task, activation) {
        const createdAt = cache.state.createdAt;
        if (createdAt === undefined)
            throw new Error('current long-task cache lacks createdAt');
        return this.commitSnapshot(agent, cache, operation, task, cache.state.roundsStarted, createdAt, this.nextMutationTime(cache), activation);
    }
    /** Clamp a current task's next timestamp across backward wall-clock movement. */
    nextMutationTime(cache) {
        const updatedAt = cache.state.updatedAt;
        if (updatedAt === undefined)
            throw new Error('current long-task cache lacks updatedAt');
        return Math.max(Date.now(), updatedAt);
    }
    /** Build and commit one full-snapshot mutation. */
    commitSnapshot(agent, cache, operation, task, roundsStarted, createdAt, updatedAt, activation) {
        const change = {
            kind: 'long-task/change',
            version: LONG_TASK_CHANGE_VERSION,
            operation,
            task,
            roundsStarted,
            createdAt,
            updatedAt,
        };
        this.commit(agent, cache, change, activation);
        const view = this.view(cache);
        if (view === undefined)
            throw new Error('snapshot commit cleared the task unexpectedly');
        return view;
    }
    /** Commit one mutation into the long-task log, cache, and live event stream. */
    commit(agent, cache, change, activation) {
        const ref = longTaskChangeRef(change);
        cache.pendingActivation = { seq: agent.session.seq, activation };
        try {
            agent.session.append('long-task/change', change);
            this.sync(agent.session, cache);
        }
        finally {
            cache.pendingActivation = undefined;
        }
        const task = this.view(cache);
        const notification = {
            operation: change.operation,
            ref: { ...ref },
            ...task === undefined ? {} : { task },
        };
        agentEvents(this.ctx, agent).emit('long-task/changed', { change: notification });
    }
    /** Build a detached current view. */
    view(cache) {
        const task = cache.state.task;
        const createdAt = cache.state.createdAt;
        const updatedAt = cache.state.updatedAt;
        if (task === undefined)
            return undefined;
        if (createdAt === undefined || updatedAt === undefined) {
            throw new Error(`long task "${task.id}" cache lacks timestamps`);
        }
        return {
            ...task,
            roundsStarted: cache.state.roundsStarted,
            createdAt,
            updatedAt,
            activation: cache.activation,
        };
    }
}
export default LongTaskService;
//# sourceMappingURL=index.js.map