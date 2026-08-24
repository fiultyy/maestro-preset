/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-long-task-context-policy`.
 * @module @deepseek-ai/dsh-long-task-context-policy/invariant
 */
const PACKAGE_NAME = '@deepseek-ai/dsh-long-task-context-policy';
/** Cordis companion plugin name. */
export const name = 'long-task-context-policy-invariant';
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants'];
/**
 * No runtime invariant: this policy owns no independent event protocol; the handoff events it
 * requests are validated by the long-task domain, and threshold behavior is package-tested.
 */
const install = () => { };
/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
/* jscpd:ignore-end */
//# sourceMappingURL=invariant.js.map