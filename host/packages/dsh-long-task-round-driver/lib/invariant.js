import { isDeepStrictEqual } from "node:util";
import { foldLongTask, renderLongTaskLedger } from "@deepseek-ai/dsh-long-task";
//#region lib/types/prompt.js
/** Model-visible continuation prompt for one same-session long-task round. */
/**
* Render the complete long-task round instruction retained in session history.
* It re-reads the hardcoded ledger at the seam (this round) so the model
* continues from exact state rather than from drifted conversation memory.
* @param task - exact active long-task revision being admitted.
* @param round - next positive round number.
* @returns a fresh one-block prompt for `Agent.followup()`.
*/
function renderLongTaskRoundPrompt(task, round) {
	return [{
		type: "text",
		text: `<long_task_round>
Round: ${round}/${task.maxRounds}\n\n${renderLongTaskLedger(task)}\n\nRe-read the ledger above as your authoritative state. Continue the objective in this same session; inspect the workspace, tool results, and durable session state instead of assuming earlier narration is still current. Make concrete progress, verify it, then rewrite the ledger through update_long_task before the seam: keep at most two live core entries, append numbered checkpoints with what verified them, close open questions against checkpoints, and name one next action. If the objective is fully achieved with evidence, read it and mark it complete. If work remains, leave it active for the next round.
</long_task_round>`
	}];
}
//#endregion
//#region lib/types/invariant.js
/** Package-owned long-task round prompt invariants. @module @deepseek-ai/dsh-long-task-round-driver/invariant */
const PACKAGE_NAME = "@deepseek-ai/dsh-long-task-round-driver";
/** Cordis companion plugin name. */
const name = "long-task-round-driver-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/** Attribute strict long-task-fold failures to this companion's reconstruction. */
function foldChecked(events, fail) {
	try {
		return foldLongTask(events);
	} catch (error) {
		return fail(`cannot reconstruct the long task before a continuation message: ${error instanceof Error ? error.message : String(error)}`);
	}
}
/** Recreate the live-shaped view consumed by the package's pure prompt renderer. */
function longTaskView(folded, source, fail) {
	const task = folded.task;
	if (task === void 0 || folded.createdAt === void 0 || folded.updatedAt === void 0 || task.phase !== "active" || task.id !== source.taskId || task.revision !== source.revision || source.round !== folded.roundsStarted + 1 || source.round > task.maxRounds) return fail(`long-task round ${source.round} cannot be reconstructed from the preceding durable task state`);
	return {
		...task,
		roundsStarted: folded.roundsStarted,
		createdAt: folded.createdAt,
		updatedAt: folded.updatedAt,
		activation: "armed"
	};
}
/** Validate one package-owned continuation message against its durable prefix. */
function validateEvent(prior, event, fail) {
	if (event.type !== "user/message") return;
	const source = event.data.source;
	if (source.kind !== "longTask" || source.round <= 0) return;
	const expected = renderLongTaskRoundPrompt(longTaskView(foldChecked(prior, fail), source, fail), source.round);
	if (!isDeepStrictEqual(event.data.content, expected)) fail(`long-task round ${source.round} content does not match the package-owned continuation prompt`);
}
/** Check existing sessions and every candidate event before Session publishes it. */
const install = Object.assign((ctx, fail) => {
	for (const session of ctx.sessions.list()) {
		const prior = [];
		for (const event of session.events) {
			validateEvent(prior, event, fail);
			prior.push(event);
		}
	}
	ctx.on("internal/dispatch", (_mode, eventName, args) => {
		if (eventName !== "session/event") return;
		const [session, event] = args;
		validateEvent(session.events, event, fail);
	}, { global: true });
}, { inject: ["sessions"] });
/**
* Register the long-task-round-driver invariant companion.
* @param ctx - Cordis context carrying the invariant service.
* @returns the installed registration's disposer after setup succeeds.
*/
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//#endregion
export { apply, inject, name };
