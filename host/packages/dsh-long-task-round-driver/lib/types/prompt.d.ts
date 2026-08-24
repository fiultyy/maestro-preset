/** Model-visible continuation prompt for one same-session long-task round. */
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { LongTaskView } from '@deepseek-ai/dsh-long-task';
/**
 * Render the complete long-task round instruction retained in session history.
 * It re-reads the hardcoded ledger at the seam (this round) so the model
 * continues from exact state rather than from drifted conversation memory.
 * @param task - exact active long-task revision being admitted.
 * @param round - next positive round number.
 * @returns a fresh one-block prompt for `Agent.followup()`.
 */
export declare function renderLongTaskRoundPrompt(task: LongTaskView, round: number): ContentBlock[];
//# sourceMappingURL=prompt.d.ts.map