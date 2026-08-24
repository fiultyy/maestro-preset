/** Runtime constructors and protocol constants for the long-task domain. */
import { HarnessError } from '@deepseek-ai/dsh-llm';
import type { LongTaskId as LongTaskIdType } from './types.ts';
import type { LongTaskErrorCode } from './domain.ts';
/** Version of the long-task change embedded in a round-zero message source. */
export declare const LONG_TASK_CHANGE_VERSION = 1;
/** Version of the long-task handoff trace event. */
export declare const LONG_TASK_HANDOFF_VERSION = 1;
/**
 * Brand a string as a long-task id.
 * @param id - raw long-task identifier.
 * @returns the same string with the compile-time brand.
 */
export declare function LongTaskId(id: string): LongTaskIdType;
/** Error returned by the long-task domain boundary. */
export declare class LongTaskError extends HarnessError {
    /**
     * @param message - human-readable rejection reason.
     * @param code - stable machine-routable classification.
     */
    constructor(message: string, code: LongTaskErrorCode);
}
//# sourceMappingURL=runtime.d.ts.map