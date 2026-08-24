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
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "long-task-context-policy";
export declare const inject: string[];
/** Policy configuration; `auto` defaults to true. */
export interface Config {
    /**
     * Hand off the surface once the effective window is this fraction full.
     * A value in `(0, 1]`. Defaults to `0.8`.
     */
    handoffRatio?: number;
    /**
     * Optional hard token cap used as the effective window instead of the
     * provider's reported context window. Set this to keep a long task inside
     * the attention-reliable prefix of a large-context model rather than relying
     * on its full, late-attention capacity.
     */
    attentionWindow?: number;
    /** Enable automatic step-boundary handoff listeners. Defaults to `true`. */
    auto?: boolean;
}
export declare const Config: z<Config>;
/** Resolved validated policy. */
interface ResolvedConfig {
    readonly handoffRatio: number;
    readonly attentionWindow: number | undefined;
    readonly auto: boolean;
}
/**
 * Resolve and validate config, failing loud on unknown or invalid keys.
 * @param config - untrusted plugin configuration after Loader normalization.
 * @returns detached validated policy.
 */
export declare function resolveConfig(config?: Config): ResolvedConfig;
/** Install automatic step-boundary handoff enforcement. */
export declare function apply(ctx: Context, config: Config): void;
export {};
//# sourceMappingURL=index.d.ts.map