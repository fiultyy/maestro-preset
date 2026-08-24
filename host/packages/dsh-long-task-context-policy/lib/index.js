import z from "@deepseek-ai/schemastery";
//#region lib/types/index.js
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
const name = "long-task-context-policy";
const inject = ["llm", "tokenMeter"];
const Config = z.object({
	handoffRatio: z.number(),
	attentionWindow: z.number().step(1).min(1),
	auto: z.boolean()
});
const DEFAULT_HANDOFF_RATIO = .8;
/**
* Resolve and validate config, failing loud on unknown or invalid keys.
* @param config - untrusted plugin configuration after Loader normalization.
* @returns detached validated policy.
*/
function resolveConfig(config = {}) {
	for (const key of Object.keys(config)) if (key !== "handoffRatio" && key !== "attentionWindow" && key !== "auto") throw new Error(`Config: unknown key "${key}"`);
	const handoffRatio = config.handoffRatio ?? DEFAULT_HANDOFF_RATIO;
	if (typeof handoffRatio !== "number" || !Number.isFinite(handoffRatio) || handoffRatio <= 0 || handoffRatio > 1) throw new Error(`Config: handoffRatio (${String(handoffRatio)}) must be a number in (0, 1]`);
	const attentionWindow = config.attentionWindow;
	if (attentionWindow !== void 0 && (!Number.isInteger(attentionWindow) || attentionWindow < 1)) throw new Error(`Config: attentionWindow (${String(attentionWindow)}) must be a positive integer`);
	const auto = config.auto ?? true;
	if (typeof auto !== "boolean") throw new Error("Config: auto must be a boolean");
	return {
		handoffRatio,
		attentionWindow,
		auto
	};
}
/** Resolve the durable routed provider/model target for the latest request. */
function routedTarget(session) {
	const config = session.requestHeader()?.config;
	if (config === void 0 || config.provider.length === 0 || config.model.length === 0) return;
	return {
		provider: config.provider,
		model: config.model
	};
}
/** Human-readable unexpected values for logs. */
function renderThrown(value) {
	return value instanceof Error ? value.message : String(value);
}
/** Install automatic step-boundary handoff enforcement. */
function apply(ctx, config) {
	const resolved = resolveConfig(config);
	if (!resolved.auto) return;
	const warnedTargets = /* @__PURE__ */ new Set();
	/** Resolve the effective window: the hard cap when set, else the routed model's capacity. */
	async function effectiveWindow(agent, signal) {
		if (resolved.attentionWindow !== void 0) return resolved.attentionWindow;
		const target = routedTarget(agent.session);
		if (target === void 0) return void 0;
		const key = `${target.provider}/${target.model}`;
		try {
			return (await ctx.llm.resolveModelInfo(target.provider, target.model, signal)).context?.contextWindow;
		} catch (error) {
			if (!warnedTargets.has(key)) {
				warnedTargets.add(key);
				ctx.logger.warn(`long-task-context-policy: could not resolve context window for ${key}: ${renderThrown(error)}`);
			}
			return;
		}
	}
	/** Record one handoff on the active task, then fold the surface hard. */
	async function handoff(agent, signal) {
		const longTasks = ctx.get("longTasks");
		if (longTasks !== void 0) {
			let task;
			try {
				task = longTasks.get(agent);
			} catch (error) {
				ctx.logger.warn(`long-task-context-policy: could not read long task: ${renderThrown(error)}`);
			}
			if (task !== void 0 && task.phase === "active") try {
				longTasks.handoff(agent, {
					id: task.id,
					revision: task.revision
				}, "pressure");
			} catch (error) {
				ctx.logger.warn(`long-task-context-policy: could not record handoff: ${renderThrown(error)}`);
			}
		}
		const compaction = ctx.get("compaction");
		if (compaction === void 0) {
			ctx.logger.warn("long-task-context-policy: no ctx.compaction backend; skipping the surface reset");
			return;
		}
		await compaction.compactIfNeeded(agent, "context-overflow", signal);
	}
	ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
		if (signal.aborted) return next();
		try {
			const window = await effectiveWindow(agent, signal);
			if (window === void 0) return await next();
			if (ctx.tokenMeter.measure(agent.session).totalTokens < Math.floor(window * resolved.handoffRatio)) return await next();
			await handoff(agent, signal);
		} catch (error) {
			ctx.logger.warn(`long-task-context-policy: handoff failed: ${renderThrown(error)}; continuing the turn`);
		}
		return next();
	});
}
//#endregion
export { Config, apply, inject, name, resolveConfig };
