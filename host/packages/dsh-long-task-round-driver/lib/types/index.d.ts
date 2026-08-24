/**
 * Same-session long-task round driver over public agent, session, and
 * long-task services.
 * @module @deepseek-ai/dsh-long-task-round-driver
 */
import type { Context } from '@deepseek-ai/cordis';
export { renderLongTaskRoundPrompt } from './prompt.ts';
export declare const name = "long-task-round-driver";
export declare const inject: string[];
/** Install automatic same-session continuation and its race fences. */
export declare function apply(ctx: Context): void;
//# sourceMappingURL=index.d.ts.map