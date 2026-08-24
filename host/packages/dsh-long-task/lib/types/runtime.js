/** Runtime constructors and protocol constants for the long-task domain. */
import { HarnessError } from '@deepseek-ai/dsh-llm';
/** Version of the long-task change embedded in a round-zero message source. */
export const LONG_TASK_CHANGE_VERSION = 1;
/** Version of the long-task handoff trace event. */
export const LONG_TASK_HANDOFF_VERSION = 1;
/**
 * Brand a string as a long-task id.
 * @param id - raw long-task identifier.
 * @returns the same string with the compile-time brand.
 */
export function LongTaskId(id) {
    return id;
}
/** Error returned by the long-task domain boundary. */
export class LongTaskError extends HarnessError {
    /**
     * @param message - human-readable rejection reason.
     * @param code - stable machine-routable classification.
     */
    // Keep the constructor to narrow HarnessError's string code at this boundary.
    // oxlint-disable-next-line typescript/no-useless-constructor -- type-only narrowing
    constructor(message, code) {
        super(message, code);
    }
}
//# sourceMappingURL=runtime.js.map