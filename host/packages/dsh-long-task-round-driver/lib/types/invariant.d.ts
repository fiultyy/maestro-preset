/** Package-owned long-task round prompt invariants. @module @deepseek-ai/dsh-long-task-round-driver/invariant */
import type { Context } from '@deepseek-ai/cordis';
/** Cordis companion plugin name. */
export declare const name = "long-task-round-driver-invariant";
/** Service required before the companion can reserve package ownership. */
export declare const inject: string[];
/**
 * Register the long-task-round-driver invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export declare const apply: (ctx: Context) => Promise<() => void>;
//# sourceMappingURL=invariant.d.ts.map