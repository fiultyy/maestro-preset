/**
 * Model-facing `get_long_task`, `create_long_task`, and `update_long_task`
 * tools over the persisted same-session long-task domain.
 * @module @deepseek-ai/dsh-tool-long-task
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "tool-long-task";
export declare const inject: string[];
/** Tool policy has no settings; the empty schema rejects unknown keys. */
export interface Config {
}
export declare const Config: z<Config>;
/** Register the three long-task tools and their shared discipline section. */
export declare function apply(ctx: Context, _config: Config): void;
//# sourceMappingURL=index.d.ts.map