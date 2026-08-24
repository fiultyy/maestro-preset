import { isDeepStrictEqual } from "node:util";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { renderLongTaskLedger } from "@deepseek-ai/dsh-long-task";
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
//#region lib/types/index.js
/**
* Same-session long-task round driver over public agent, session, and
* long-task services.
* @module @deepseek-ai/dsh-long-task-round-driver
*/
const name = "long-task-round-driver";
const inject = [
	"agents",
	"longTasks",
	"sessions"
];
/** Whether a source identifies an automatic, positive-numbered long-task round. */
function isLongTaskRoundSource(source) {
	return source.kind === "longTask" && source.round > 0;
}
/** Compare a source to one reserved identity. */
function sameRound(source, round) {
	return source.taskId === round.taskId && source.revision === round.revision && source.round === round.round;
}
/** Compare the complete queued record to the driver's reservation. */
function sameQueued(content, source, attempt) {
	return isLongTaskRoundSource(source) && sameRound(source, attempt) && isDeepStrictEqual(content, attempt.content);
}
/** Exact current ref for a view. */
function longTaskRef(task) {
	return {
		id: task.id,
		revision: task.revision
	};
}
/** Human-readable unexpected values for logs. */
function renderThrown(value) {
	return value instanceof Error ? value.message : String(value);
}
/** Install automatic same-session continuation and its race fences. */
function apply(ctx) {
	const states = /* @__PURE__ */ new Map();
	/** Create state for an exact currently live agent. */
	function stateFor(agent) {
		const existing = states.get(agent);
		if (existing !== void 0) return existing;
		const state = {
			agent,
			attempt: void 0,
			competingQueued: false,
			needsCheckpoint: false,
			requested: false,
			run: void 0,
			stopping: false
		};
		states.set(agent, state);
		return state;
	}
	/** Read only when the exact Agent remains live. */
	function currentTask(state) {
		if (ctx.agents.get(state.agent.id) !== state.agent) return void 0;
		return ctx.longTasks.get(state.agent);
	}
	/** Whether this exact lifecycle is quiescent with no competing prompt. */
	function readyToDrive(state) {
		return ctx.fiber.state === 2 && !state.stopping && ctx.agents.get(state.agent.id) === state.agent && state.agent.status === "idle" && !state.competingQueued;
	}
	/** Recheck every condition that an awaited checkpoint may have changed. */
	function readyAfterCheckpoint(state) {
		return readyToDrive(state) && !state.needsCheckpoint;
	}
	/** Remove automatic authority while preserving the durable phase. */
	function disarm(state) {
		try {
			if (currentTask(state)?.activation === "armed") ctx.longTasks.disarm(state.agent);
		} catch (error) {
			ctx.logger.warn(`long-task-round-driver: could not disarm agent "${state.agent.id}": ${renderThrown(error)}`);
		}
	}
	/** Preserve claimed step context when this driver drops only its own round. */
	function restoreOtherClaimed(agent, messages, messageId) {
		const retained = messages.filter((message) => message.id !== messageId && !(message.source.kind === "longTask" && message.source.round === 0));
		for (const message of retained.toReversed()) {
			if (agent.inbox.nextStep.some((candidate) => candidate.id === message.id) || agent.inbox.nextTurn.some((candidate) => candidate.id === message.id)) continue;
			agent.inbox.prepend("next-step", message);
		}
	}
	/** Process admitted work at quiescence, then reserve at most one next round. */
	async function drive(state) {
		const { agent } = state;
		if (!readyToDrive(state)) return;
		if (state.needsCheckpoint) {
			state.needsCheckpoint = false;
			try {
				await ctx.sessions.flush(agent.session);
			} catch (error) {
				ctx.logger.warn(`long-task-round-driver: durability checkpoint failed for agent "${agent.id}": ${renderThrown(error)}`);
				disarm(state);
				return;
			}
			if (!readyAfterCheckpoint(state)) return;
		}
		if (state.attempt !== void 0) {
			state.attempt = void 0;
			state.needsCheckpoint = true;
			state.requested = true;
			return;
		}
		const task = currentTask(state);
		if (task === void 0 || task.phase !== "active" || task.activation !== "armed") return;
		if (task.roundsStarted >= task.maxRounds) {
			ctx.longTasks.block(agent, longTaskRef(task), {
				code: "round-limit",
				message: `Long task reached its configured limit of ${task.maxRounds} rounds.`
			});
			return;
		}
		const round = task.roundsStarted + 1;
		const content = renderLongTaskRoundPrompt(task, round);
		const message = createUserMessage({
			content,
			source: {
				kind: "longTask",
				taskId: task.id,
				revision: task.revision,
				round
			}
		});
		state.attempt = {
			taskId: task.id,
			revision: task.revision,
			round,
			messageId: message.id,
			content,
			phase: "queued",
			cancelled: false,
			stale: false
		};
		try {
			agent.followup(message);
		} catch (error) {
			state.attempt = void 0;
			ctx.logger.warn(`long-task-round-driver: could not queue round ${round} for agent "${agent.id}": ${renderThrown(error)}`);
			const latest = currentTask(state);
			if (latest !== void 0 && latest.id === task.id && latest.revision === task.revision && latest.phase === "active" && latest.activation === "armed") ctx.longTasks.block(agent, longTaskRef(latest), {
				code: "queue-failed",
				message: `Could not queue long-task round ${round}: ${renderThrown(error)}`
			});
		}
	}
	/** Coalesce triggers onto one agent-local serialized driver. */
	function requestDrive(state) {
		if (state.stopping) return;
		state.requested = true;
		if (state.run !== void 0) return;
		let run;
		try {
			run = ctx.agents.withoutInitiator(async () => {
				while (state.requested && !state.stopping) {
					state.requested = false;
					try {
						await drive(state);
					} catch (error) {
						ctx.logger.warn(`long-task-round-driver: driver failed for agent "${state.agent.id}": ${renderThrown(error)}`);
						disarm(state);
					}
				}
			});
		} catch (error) {
			ctx.logger.warn(`long-task-round-driver: could not start driver for agent "${state.agent.id}": ${renderThrown(error)}`);
			disarm(state);
			return;
		}
		state.run = run;
		const retire = () => {
			state.run = void 0;
			if (state.requested && !state.stopping) requestDrive(state);
		};
		run.then(retire, (error) => {
			ctx.logger.warn(`long-task-round-driver: driver task rejected for agent "${state.agent.id}": ${renderThrown(error)}`);
			disarm(state);
			retire();
		});
	}
	ctx.effect(function* () {
		ctx.on("agent/error", ({ agent }) => {
			disarm(stateFor(agent));
		});
		ctx.on("agent/created", ({ agent }) => {
			stateFor(agent);
		});
		ctx.on("agent/disposed", ({ agent }) => {
			states.delete(agent);
		});
		ctx.on("agent/session-start", ({ agent }) => {
			const state = stateFor(agent);
			state.attempt = void 0;
			state.competingQueued = false;
			state.needsCheckpoint = false;
		});
		ctx.on("agent/status", ({ agent, status }) => {
			const state = stateFor(agent);
			if (status === "idle") {
				state.competingQueued = false;
				const attempt = state.attempt;
				const task = currentTask(state);
				if ((attempt?.phase === "queued" || attempt?.phase === "claimed" || attempt?.cancelled) && task?.phase === "active" && task.activation === "armed") {
					state.attempt = void 0;
					try {
						ctx.longTasks.pause(agent, longTaskRef(task));
					} catch (error) {
						ctx.logger.warn(`long-task-round-driver: could not pause cancelled task for agent "${agent.id}": ${renderThrown(error)}`);
						disarm(state);
					}
				}
				requestDrive(state);
			}
		});
		ctx.on("long-task/changed", ({ agent }) => {
			const state = stateFor(agent);
			state.needsCheckpoint = true;
			requestDrive(state);
		});
		ctx.on("agent/inbox/inserted", ({ agent, message }) => {
			if (!agent.inbox.nextTurn.some((candidate) => candidate.id === message.id)) return;
			const state = stateFor(agent);
			const attempt = state.attempt;
			if (attempt !== void 0 && sameQueued(message.content, message.source, attempt)) return;
			state.competingQueued = true;
			if (attempt?.phase === "queued") attempt.stale = true;
		});
		ctx.on("agent/inbox/claimed", ({ agent, message }) => {
			const attempt = stateFor(agent).attempt;
			if (attempt !== void 0 && sameQueued(message.content, message.source, attempt)) attempt.phase = "claimed";
		});
		ctx.on("agent/inbox/discarded", ({ agent, message }) => {
			const attempt = stateFor(agent).attempt;
			if (attempt !== void 0 && sameQueued(message.content, message.source, attempt)) attempt.cancelled = true;
		});
		ctx.on("session/event", (session, event) => {
			const agent = ctx.agents.get(session.id);
			if (agent === void 0 || agent.session !== session) return;
			const state = stateFor(agent);
			switch (event.type) {
				case "user/message":
					if (state.attempt !== void 0 && event.data.id === state.attempt.messageId) state.attempt.phase = "admitted";
					return;
				case "turn/end":
					if (event.data.reason.kind === "max-tokens") {
						disarm(state);
						return;
					}
					if (event.data.reason.kind !== "aborted") return;
					if (state.attempt?.phase === "claimed" || state.attempt?.phase === "admitted") state.attempt.cancelled = true;
					else disarm(state);
					return;
				default: return;
			}
		});
		/** Fail closed unless the queued prompt still owns the exact live revision. */
		function validReservation(state, content, source) {
			const attempt = state.attempt;
			const task = currentTask(state);
			return ctx.fiber.state === 2 && !state.stopping && attempt !== void 0 && attempt.phase === "claimed" && !attempt.stale && sameQueued(content, source, attempt) && task !== void 0 && task.id === source.taskId && task.revision === source.revision && task.phase === "active" && task.activation === "armed" && source.round === task.roundsStarted + 1;
		}
		ctx.on("agent/pre-step", async ({ agent, messages, signal }, next) => {
			const submitted = messages.find((message) => isLongTaskRoundSource(message.source));
			if (submitted === void 0) return next();
			const { content, source } = submitted;
			const state = stateFor(agent);
			let valid = false;
			try {
				valid = validReservation(state, content, source);
			} catch (error) {
				ctx.logger.warn(`long-task-round-driver: pre-step check failed for agent "${agent.id}": ${renderThrown(error)}`);
				disarm(state);
			}
			if (!valid) {
				const attempt = state.attempt;
				if (attempt !== void 0 && sameRound(source, attempt)) {
					attempt.stale = true;
					state.attempt = void 0;
				}
				restoreOtherClaimed(agent, messages, submitted.id);
				requestDrive(state);
				return { kind: "reject" };
			}
			let decision;
			try {
				decision = await next();
			} catch (error) {
				if (signal.aborted) throw error;
				state.attempt = void 0;
				requestDrive(state);
				throw error;
			}
			if (signal.aborted) {
				if (decision.kind === "enter") restoreOtherClaimed(agent, decision.messages, submitted.id);
				return decision;
			}
			if (decision.kind === "reject") {
				state.attempt = void 0;
				const task = currentTask(state);
				if (task !== void 0 && task.id === source.taskId && task.revision === source.revision && task.phase === "active" && task.activation === "armed") ctx.longTasks.block(agent, longTaskRef(task), {
					code: "prompt-rejected",
					message: "Long-task round was rejected before entering its step."
				});
				return decision;
			}
			try {
				valid = validReservation(state, content, source);
			} catch (error) {
				ctx.logger.warn(`long-task-round-driver: post-decision check failed for agent "${agent.id}": ${renderThrown(error)}`);
				disarm(state);
				valid = false;
			}
			if (!valid) {
				state.attempt = void 0;
				restoreOtherClaimed(agent, decision.messages, submitted.id);
				requestDrive(state);
				return { kind: "reject" };
			}
			return decision;
		});
		for (const agent of ctx.agents.list()) disarm(stateFor(agent));
		yield async () => {
			const waits = [];
			for (const state of states.values()) {
				state.stopping = true;
				disarm(state);
				const attempt = state.attempt;
				if (attempt !== void 0) {
					attempt.stale = true;
					/* v8 ignore next -- followup reserves the live agent before publishing a queued attempt */
					if (state.agent.status === "running") {
						state.agent.cancel({ kind: "parent" });
						waits.push(state.agent.whenIdle());
					}
				}
				if (state.run !== void 0) waits.push(state.run);
			}
			await Promise.allSettled(waits);
			states.clear();
		};
	}, "long-task-round-driver lifecycle");
}
//#endregion
export { apply, inject, name, renderLongTaskRoundPrompt };
