/** Model-visible continuation prompt for one same-session long-task round. */
import { renderLongTaskLedger } from '@deepseek-ai/dsh-long-task';
/**
 * Render the complete long-task round instruction retained in session history.
 * It re-reads the hardcoded ledger at the seam (this round) so the model
 * continues from exact state rather than from drifted conversation memory.
 * @param task - exact active long-task revision being admitted.
 * @param round - next positive round number.
 * @returns a fresh one-block prompt for `Agent.followup()`.
 */
export function renderLongTaskRoundPrompt(task, round) {
    return [{
            type: 'text',
            text: '<long_task_round>\n'
                + `Round: ${round}/${task.maxRounds}\n\n`
                + `${renderLongTaskLedger(task)}\n\n`
                + 'Re-read the ledger above as your authoritative state. Continue the objective in this same '
                + 'session; inspect the workspace, tool results, and durable session state instead of assuming '
                + 'earlier narration is still current. Make concrete progress, verify it, then rewrite the '
                + 'ledger through update_long_task before the seam: keep at most two live core entries, append '
                + 'numbered checkpoints with what verified them, close open questions against checkpoints, and '
                + 'name one next action. If the objective is fully achieved with evidence, read it and mark it '
                + 'complete. If work remains, leave it active for the next round.\n'
                + '</long_task_round>',
        }];
}
//# sourceMappingURL=prompt.js.map