/** Package-owned durable long-task-stream invariants. @module @deepseek-ai/dsh-long-task/invariant */
import type { Context } from '@deepseek-ai/cordis';
/** Cordis companion plugin name. */
export declare const name = "long-task-invariant";
/** Service required before the companion can reserve package ownership. */
export declare const inject: string[];
/**
 * Register the long-task-stream invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export declare const apply: (ctx: Context) => Promise<() => void>;
//# sourceMappingURL=invariant.d.ts.map