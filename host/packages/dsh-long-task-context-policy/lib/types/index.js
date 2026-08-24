/**
 * Context-budget handoff policy for long tasks.
 *
 * At every step boundary it prices the current request surface through the
 * singleton token meter and compares it against an effective attention window.
 * Above `handoffRatio` it hands the task state to a fresh surface: it records
 * a durable `long-task/handoff` trace and increments the task's handoff counter
 * (the hardcoded ledger is a projection and stays exact), then forces a
 * context-overflow compaction so the next request starts from a folded surface
 * plus the re-injected ledger. Gentle pressure compaction below the handoff
 * threshold is the compaction seam's job (`compaction-basic` `thresholdRatio`);
 * this policy owns only the harder "reset the surface, keep the state" path.
 *
 * @module @deepseek-ai/dsh-long-task-context-policy
 */
import z from '@deepseek-ai/schemastery';
export const name = 'long-task-context-policy';
export const inject = ['llm', 'tokenMeter'];
export const Config = z.object({
    handoffRatio: z.number(),
    attentionWindow: z.number().step(1).min(1),
    auto: z.boolean(),
});
const DEFAULT_HANDOFF_RATIO = 0.8;
/**
 * Resolve and validate config, failing loud on unknown or invalid keys.
 * @param config - untrusted plugin configuration after Loader normalization.
 * @returns detached validated policy.
 */
export function resolveConfig(config = {}) {
    for (const key of Object.keys(config)) {
        if (key !== 'handoffRatio' && key !== 'attentionWindow' && key !== 'auto') {
            throw new Error(`Config: unknown key "${key}"`);
        }
    }
    const handoffRatio = config.handoffRatio ?? DEFAULT_HANDOFF_RATIO;
    if (typeof handoffRatio !== 'number' || !Number.isFinite(handoffRatio) || handoffRatio <= 0 || handoffRatio > 1) {
        throw new Error(`Config: handoffRatio (${String(handoffRatio)}) must be a number in (0, 1]`);
    }
    const attentionWindow = config.attentionWindow;
    if (attentionWindow !== undefined && (!Number.isInteger(attentionWindow) || attentionWindow < 1)) {
        throw new Error(`Config: attentionWindow (${String(attentionWindow)}) must be a positive integer`);
    }
    const auto = config.auto ?? true;
    if (typeof auto !== 'boolean')
        throw new Error('Config: auto must be a boolean');
    return { handoffRatio, attentionWindow, auto };
}
/** Resolve the durable routed provider/model target for the latest request. */
function routedTarget(session) {
    const config = session.requestHeader()?.config;
    if (config === undefined || config.provider.length === 0 || config.model.length === 0) {
        return undefined;
    }
    return { provider: config.provider, model: config.model };
}
/** Human-readable unexpected values for logs. */
function renderThrown(value) {
    return value instanceof Error ? value.message : String(value);
}
/** Install automatic step-boundary handoff enforcement. */
export function apply(ctx, config) {
    const resolved = resolveConfig(config);
    if (!resolved.auto)
        return;
    const warnedTargets = new Set();
    /** Resolve the effective window: the hard cap when set, else the routed model's capacity. */
    async function effectiveWindow(agent, signal) {
        if (resolved.attentionWindow !== undefined)
            return resolved.attentionWindow;
        const target = routedTarget(agent.session);
        if (target === undefined)
            return undefined;
        const key = `${target.provider}/${target.model}`;
        try {
            const info = await ctx.llm.resolveModelInfo(target.provider, target.model, signal);
            return info.context?.contextWindow;
        }
        catch (error) {
            if (!warnedTargets.has(key)) {
                warnedTargets.add(key);
                ctx.logger.warn(`long-task-context-policy: could not resolve context window for ${key}: ${renderThrown(error)}`);
            }
            return undefined;
        }
    }
    /** Record one handoff on the active task, then fold the surface hard. */
    async function handoff(agent, signal) {
        const longTasks = ctx.get('longTasks');
        if (longTasks !== undefined) {
            let task;
            try {
                task = longTasks.get(agent);
            }
            catch (error) {
                ctx.logger.warn(`long-task-context-policy: could not read long task: ${renderThrown(error)}`);
            }
            if (task !== undefined && task.phase === 'active') {
                try {
                    longTasks.handoff(agent, { id: task.id, revision: task.revision }, 'pressure');
                }
                catch (error) {
                    ctx.logger.warn(`long-task-context-policy: could not record handoff: ${renderThrown(error)}`);
                }
            }
        }
        const compaction = ctx.get('compaction');
        if (compaction === undefined) {
            ctx.logger.warn('long-task-context-policy: no ctx.compaction backend; skipping the surface reset');
            return;
        }
        await compaction.compactIfNeeded(agent, 'context-overflow', signal);
    }
    ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
        if (signal.aborted)
            return next();
        try {
            const window = await effectiveWindow(agent, signal);
            if (window === undefined)
                return await next();
            const measurement = ctx.tokenMeter.measure(agent.session);
            if (measurement.totalTokens < Math.floor(window * resolved.handoffRatio))
                return await next();
            await handoff(agent, signal);
        }
        catch (error) {
            ctx.logger.warn(`long-task-context-policy: handoff failed: ${renderThrown(error)}; continuing the turn`);
        }
        return next();
    });
}
//# sourceMappingURL=index.js.map