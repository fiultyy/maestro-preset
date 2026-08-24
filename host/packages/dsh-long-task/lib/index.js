import { randomUUID } from "node:crypto";
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { z as z$1 } from "zod";
import { agentEvents } from "@deepseek-ai/dsh-agent";
import { HarnessError } from "@deepseek-ai/dsh-llm";
//#region lib/types/runtime.js
/** Runtime constructors and protocol constants for the long-task domain. */
/** Version of the long-task change embedded in a round-zero message source. */
const LONG_TASK_CHANGE_VERSION = 1;
/**
* Brand a string as a long-task id.
* @param id - raw long-task identifier.
* @returns the same string with the compile-time brand.
*/
function LongTaskId(id) {
	return id;
}
/** Error returned by the long-task domain boundary. */
var LongTaskError = class extends HarnessError {
	/**
	* @param message - human-readable rejection reason.
	* @param code - stable machine-routable classification.
	*/
	constructor(message, code) {
		super(message, code);
	}
};
//#endregion
//#region lib/types/fold.js
/** Pure replay fold and strict decoder for durable long-task changes and handoff traces. */
/** Hard bounds keep the ledger re-readable in seconds, not a full transcript. */
const MAX_CORE = 20;
const MAX_CHECKPOINTS = 100;
const MAX_OPEN_QUESTIONS = 100;
const SNAPSHOT_OPERATIONS = new Set([
	"create",
	"edit",
	"pause",
	"resume",
	"complete",
	"block",
	"handoff"
]);
const PHASES = new Set([
	"active",
	"paused",
	"blocked",
	"complete"
]);
const HANDOFF_REASONS = new Set(["pressure", "overflow"]);
/**
* Build an empty replay accumulator.
* @returns mutable state with no current task or prior ref.
*/
function emptyLongTaskFoldState() {
	return {
		task: void 0,
		roundsStarted: 0,
		createdAt: void 0,
		updatedAt: void 0,
		lastRef: void 0,
		seenTaskIds: /* @__PURE__ */ new Set()
	};
}
/** Whether a value is a JSON record rather than an array. */
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Require one positive safe integer. */
function positiveInteger(value, field) {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`long-task change ${field} must be a positive safe integer`);
	return value;
}
/** Require one non-negative safe integer. */
function nonNegativeInteger(value, field) {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`long-task change ${field} must be a non-negative safe integer`);
	return value;
}
/** Require one non-empty normalized single-line string. */
function normalizedString(value, field) {
	if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()) throw new Error(`long-task change ${field} must be non-empty and normalized`);
	return value;
}
/** Decode one canonical blocker explanation. */
function decodeBlockReason(value) {
	if (!isRecord(value) || Object.keys(value).sort().join(",") !== "code,message") throw new Error("long-task change task.blockedReason must have exactly code and message fields");
	if (typeof value["code"] !== "string" || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value["code"])) throw new Error("long-task change task.blockedReason.code must be lower-kebab-case");
	if (typeof value["message"] !== "string" || value["message"].trim().length === 0 || value["message"] !== value["message"].trim()) throw new Error("long-task change task.blockedReason.message must be non-empty and normalized");
	return {
		code: value["code"],
		message: value["message"]
	};
}
/** Decode a homogeneous non-empty string array with an upper bound. */
function decodeStringList(value, field, max) {
	if (!Array.isArray(value)) throw new Error(`long-task change ${field} must be an array`);
	if (value.length > max) throw new Error(`long-task change ${field} exceeds ${max} entries`);
	return value.map((entry) => normalizedString(entry, `${field} entry`));
}
/** Decode one numbered checkpoint. */
function decodeCheckpoint(value) {
	if (!isRecord(value) || Object.keys(value).sort().join(",") !== "seq,statement,verifiedBy") throw new Error("long-task change checkpoint must have exactly seq, statement, and verifiedBy fields");
	return {
		seq: positiveInteger(value["seq"], "checkpoint.seq"),
		statement: normalizedString(value["statement"], "checkpoint.statement"),
		verifiedBy: normalizedString(value["verifiedBy"], "checkpoint.verifiedBy")
	};
}
/** Decode one numbered open question. */
function decodeOpenQuestion(value) {
	if (!isRecord(value)) throw new Error("long-task change open question must be a record");
	const keys = Object.keys(value).sort().join(",");
	if (keys !== "question,seq,settledBy" && keys !== "closesCheckpoint,question,seq,settledBy") throw new Error("long-task change open question must have seq, question, settledBy, and optional closesCheckpoint fields");
	return {
		seq: positiveInteger(value["seq"], "openQuestion.seq"),
		question: normalizedString(value["question"], "openQuestion.question"),
		settledBy: normalizedString(value["settledBy"], "openQuestion.settledBy"),
		...value["closesCheckpoint"] === void 0 ? {} : { closesCheckpoint: positiveInteger(value["closesCheckpoint"], "openQuestion.closesCheckpoint") }
	};
}
/** Decode a strictly increasing ordinal list with an upper bound. */
function decodeOrdinals(values, field, max) {
	if (values.length > max) throw new Error(`long-task change ${field} exceeds ${max} entries`);
	let previous = 0;
	for (const entry of values) {
		const seq = entry.seq;
		if (seq !== previous + 1) throw new Error(`long-task change ${field} ordinals must be strictly increasing from 1`);
		previous = seq;
	}
}
/** Decode and validate one snapshot. */
function decodeSnapshot(value) {
	if (!isRecord(value)) throw new Error("long-task change task must be a record");
	if (typeof value["id"] !== "string" || value["id"].length === 0) throw new Error("long-task change task.id must be a non-empty string");
	if (typeof value["objective"] !== "string" || value["objective"].trim().length === 0 || value["objective"] !== value["objective"].trim()) throw new Error("long-task change task.objective must be non-empty and normalized");
	if (typeof value["phase"] !== "string" || !PHASES.has(value["phase"])) throw new Error("long-task change task.phase is invalid");
	const phase = value["phase"];
	const core = decodeStringList(value["core"], "task.core", MAX_CORE);
	if (!Array.isArray(value["checkpoints"]) || !Array.isArray(value["openQuestions"])) throw new Error("long-task change task.checkpoints and task.openQuestions must be arrays");
	const checkpoints = value["checkpoints"].map((entry) => decodeCheckpoint(entry));
	const openQuestions = value["openQuestions"].map((entry) => decodeOpenQuestion(entry));
	decodeOrdinals(checkpoints, "task.checkpoints", MAX_CHECKPOINTS);
	decodeOrdinals(openQuestions, "task.openQuestions", MAX_OPEN_QUESTIONS);
	const closedCheckpoints = new Set(openQuestions.filter((q) => q.closesCheckpoint !== void 0).map((q) => q.closesCheckpoint));
	for (const seq of closedCheckpoints) if (!checkpoints.some((c) => c.seq === seq)) throw new Error(`long-task change open question closes unknown checkpoint ${seq}`);
	return {
		id: LongTaskId(value["id"]),
		revision: positiveInteger(value["revision"], "task.revision"),
		objective: value["objective"],
		phase,
		core,
		checkpoints,
		openQuestions,
		next: normalizedString(value["next"], "task.next"),
		maxRounds: positiveInteger(value["maxRounds"], "task.maxRounds"),
		handoffs: nonNegativeInteger(value["handoffs"], "task.handoffs"),
		...phase === "blocked" ? { blockedReason: decodeBlockReason(value["blockedReason"]) } : {}
	};
}
/** Decode and validate one ref. */
function decodeRef(value) {
	if (!isRecord(value) || Object.keys(value).sort().join(",") !== "id,revision") throw new Error("long-task clear tombstone must have exactly id and revision fields");
	if (typeof value["id"] !== "string" || value["id"].length === 0) throw new Error("long-task clear tombstone id must be a non-empty string");
	return {
		id: LongTaskId(value["id"]),
		revision: positiveInteger(value["revision"], "cleared.revision")
	};
}
/**
* Decode a value that declares itself as a long-task change. Unrelated values
* return `undefined`; malformed long-task changes fail replay loudly.
* @param value - candidate source change.
* @returns validated change or `undefined` for another value kind.
*/
function decodeLongTaskChange(value) {
	if (!isRecord(value) || value["kind"] !== "long-task/change") return void 0;
	if (value["version"] !== 1) throw new Error(`unsupported long-task change version ${String(value["version"])}`);
	if (value["operation"] === "clear") {
		const allowed = [
			"cleared",
			"clearedAt",
			"kind",
			"operation",
			"version"
		];
		if (Object.keys(value).sort().join(",") !== allowed.sort().join(",")) throw new Error(`long-task clear change must have exactly ${allowed.sort().join(",")} fields`);
		return {
			kind: "long-task/change",
			version: 1,
			operation: "clear",
			cleared: decodeRef(value["cleared"]),
			clearedAt: nonNegativeInteger(value["clearedAt"], "clearedAt")
		};
	}
	if (typeof value["operation"] !== "string" || !SNAPSHOT_OPERATIONS.has(value["operation"])) throw new Error("long-task change operation is invalid");
	const allowed = [
		"createdAt",
		"kind",
		"operation",
		"roundsStarted",
		"task",
		"updatedAt",
		"version"
	];
	if (Object.keys(value).sort().join(",") !== allowed.sort().join(",")) throw new Error(`long-task snapshot change must have exactly ${allowed.sort().join(",")} fields`);
	const createdAt = nonNegativeInteger(value["createdAt"], "createdAt");
	const updatedAt = nonNegativeInteger(value["updatedAt"], "updatedAt");
	if (updatedAt < createdAt) throw new Error("long-task change updatedAt cannot precede createdAt");
	return {
		kind: "long-task/change",
		version: 1,
		operation: value["operation"],
		task: decodeSnapshot(value["task"]),
		roundsStarted: nonNegativeInteger(value["roundsStarted"], "roundsStarted"),
		createdAt,
		updatedAt
	};
}
/** Narrow model attribution to a valid long-task source. */
function longTaskSource(source) {
	if (source.kind !== "longTask") return void 0;
	if (typeof source.taskId !== "string" || source.taskId.length === 0 || !Number.isSafeInteger(source.revision) || source.revision < 1 || !Number.isSafeInteger(source.round) || source.round < 1) throw new Error("long-task message source is invalid");
	return source;
}
/** Require two snapshots to retain fields that only `edit` may replace. */
function requireSameDefinition(current, next, operation) {
	if (next.objective !== current.objective || next.maxRounds !== current.maxRounds || next.core.join("\n") !== current.core.join("\n") || next.next !== current.next || JSON.stringify(next.checkpoints) !== JSON.stringify(current.checkpoints) || JSON.stringify(next.openQuestions) !== JSON.stringify(current.openQuestions)) throw new Error(`long-task ${operation} cannot change the definition fields`);
}
/** Require one exact next revision of the current task. */
function requireNextRevision(current, next, operation) {
	if (next.id !== current.id || next.revision !== current.revision + 1) throw new Error(`long-task ${operation} must advance the current task by one revision`);
}
/** Validate one non-create snapshot operation against the preceding projection. */
function validateSnapshotTransition(state, change, current) {
	const next = change.task;
	requireNextRevision(current, next, change.operation);
	if (state.updatedAt === void 0) throw new Error("current long-task fold lacks updatedAt");
	if (change.createdAt !== state.createdAt || change.updatedAt < state.updatedAt || change.roundsStarted !== state.roundsStarted) throw new Error(`long-task ${change.operation} does not preserve the current counters and timestamps`);
	switch (change.operation) {
		case "edit":
			if (next.phase !== current.phase || next.handoffs !== current.handoffs || JSON.stringify(next.blockedReason) !== JSON.stringify(current.blockedReason)) throw new Error("long-task edit cannot change phase, handoffs, or blocked reason");
			break;
		case "handoff":
			requireSameDefinition(current, next, change.operation);
			if (current.phase !== "active" || next.phase !== "active" || next.handoffs !== current.handoffs + 1) throw new Error("long-task handoff requires an active task and increments handoffs by exactly one");
			break;
		case "pause":
			requireSameDefinition(current, next, change.operation);
			if (current.phase !== "active" || next.phase !== "paused") throw new Error("long-task pause has an invalid phase transition");
			break;
		case "resume":
			requireSameDefinition(current, next, change.operation);
			if (!new Set([
				"active",
				"paused",
				"blocked"
			]).has(current.phase) || next.phase !== "active" || state.roundsStarted >= next.maxRounds) throw new Error("long-task resume has an invalid phase transition or exhausted round budget");
			break;
		case "complete":
			requireSameDefinition(current, next, change.operation);
			if (current.phase === "complete" || next.phase !== "complete") throw new Error("long-task complete has an invalid phase transition");
			break;
		case "block":
			requireSameDefinition(current, next, change.operation);
			if (current.phase !== "active" || next.phase !== "blocked") throw new Error("long-task block has an invalid phase transition");
			break;
		/* v8 ignore start -- the caller excludes create and LongTaskOperation is closed; these arms retain fail-loud exhaustiveness */
		case "create": throw new Error("long-task create cannot be validated as a current-task transition");
		default:
			change.operation;
			throw new Error("unknown long-task snapshot operation");
	}
}
/**
* Return the revision identity carried by a snapshot or tombstone.
* @param change - decoded long-task mutation.
* @returns stable identity used to reconcile a deferred change with its log event.
*/
function longTaskChangeRef(change) {
	return change.operation === "clear" ? change.cleared : {
		id: change.task.id,
		revision: change.task.revision
	};
}
/**
* Decode a long-task handoff trace value. Unrelated values return `undefined`.
* @param value - candidate trace payload.
* @returns validated trace or `undefined`.
*/
function decodeLongTaskHandoff(value) {
	if (!isRecord(value) || value["kind"] !== "long-task/handoff") return void 0;
	if (value["version"] !== 1) throw new Error(`unsupported long-task handoff version ${String(value["version"])}`);
	const allowed = [
		"at",
		"handoffs",
		"kind",
		"reason",
		"ref",
		"version"
	];
	if (Object.keys(value).sort().join(",") !== allowed.sort().join(",")) throw new Error(`long-task handoff must have exactly ${allowed.sort().join(",")} fields`);
	if (typeof value["reason"] !== "string" || !HANDOFF_REASONS.has(value["reason"])) throw new Error("long-task handoff reason is invalid");
	return {
		kind: "long-task/handoff",
		version: 1,
		ref: decodeRef(value["ref"]),
		handoffs: nonNegativeInteger(value["handoffs"], "handoffs"),
		reason: value["reason"],
		at: nonNegativeInteger(value["at"], "at")
	};
}
/**
* Validate and apply one decoded change to a mutable accumulator.
* @param state - preceding durable long-task projection.
* @param change - decoded full snapshot or clear tombstone.
*/
function applyLongTaskChange(state, change) {
	const ref = longTaskChangeRef(change);
	if (change.operation === "clear") {
		const current = state.task;
		if (current === void 0) throw new Error("long-task clear requires a current task");
		requireNextRevision(current, change.cleared, change.operation);
		if (state.updatedAt === void 0) throw new Error("current long-task fold lacks updatedAt");
		if (change.clearedAt < state.updatedAt) throw new Error("long-task clear timestamp cannot precede the current task update");
		state.task = void 0;
		state.roundsStarted = 0;
		state.createdAt = void 0;
		state.updatedAt = void 0;
		state.lastRef = ref;
		return;
	}
	if (change.operation === "create") {
		if (change.task.revision !== 1 || change.task.phase !== "active" || change.roundsStarted !== 0 || change.task.handoffs !== 0 || state.task !== void 0 && state.task.phase !== "complete" || state.seenTaskIds.has(change.task.id)) throw new Error("long-task create requires a fresh active revision-one task with zero rounds and handoffs");
		state.seenTaskIds.add(change.task.id);
	} else {
		const current = state.task;
		if (current === void 0) throw new Error(`long-task ${change.operation} requires a current task`);
		validateSnapshotTransition(state, change, current);
	}
	state.task = change.task;
	state.roundsStarted = change.roundsStarted;
	state.createdAt = change.createdAt;
	state.updatedAt = change.updatedAt;
	state.lastRef = ref;
}
/**
* Apply one session event to the strict durable long-task fold.
* @param state - mutable fold accumulator.
* @param event - next event in sequence order.
*/
function applyLongTaskEvent(state, event) {
	if (event.type === "long-task/change") {
		const change = decodeLongTaskChange(event.data);
		if (change === void 0) throw new Error(`long-task change at session event ${event.seq} has an invalid kind`);
		applyLongTaskChange(state, change);
		return;
	}
	if (event.type === "long-task/handoff") {
		const trace = decodeLongTaskHandoff(event.data);
		if (trace === void 0) throw new Error(`long-task handoff at session event ${event.seq} has an invalid kind`);
		const current = state.task;
		if (current === void 0 || current.id !== trace.ref.id || current.revision !== trace.ref.revision || current.handoffs !== trace.handoffs) throw new Error(`long-task handoff at session event ${event.seq} does not match the current task`);
		return;
	}
	if (event.type === "user/message") {
		const source = longTaskSource(event.data.source);
		if (source === void 0) return;
		const current = state.task;
		if (current === void 0 || current.phase !== "active" || source.taskId !== current.id || source.revision !== current.revision || source.round !== state.roundsStarted + 1 || source.round > current.maxRounds) throw new Error(`long-task round at session event ${event.seq} is not the next admitted round of the active task`);
		state.roundsStarted = source.round;
	}
}
/**
* Fold current long-task state from a contiguous session event log.
* @param events - session events in sequence order.
* @returns a fresh durable projection; activation is deliberately absent.
*/
function foldLongTask(events) {
	const state = emptyLongTaskFoldState();
	for (const event of events) applyLongTaskEvent(state, event);
	return {
		...state.task === void 0 ? {} : { task: { ...state.task } },
		roundsStarted: state.roundsStarted,
		...state.createdAt === void 0 ? {} : { createdAt: state.createdAt },
		...state.updatedAt === void 0 ? {} : { updatedAt: state.updatedAt },
		...state.lastRef === void 0 ? {} : { lastRef: { ...state.lastRef } }
	};
}
//#endregion
//#region lib/types/render.js
/** Canonical plain-text rendering of the hardcoded long-task ledger. */
/**
* Render the full ledger in its stable five-section form. The model re-reads
* this at every seam; the driver injects it into continuation rounds and the
* context policy folds it into a handoff checkpoint. Bounded by construction:
* core, checkpoints, and open questions are capped by the service.
* @param task - current durable snapshot.
* @returns one deterministic multi-line ledger string.
*/
function renderLongTaskLedger(task) {
	const core = task.core.length === 0 ? ["  (empty)"] : task.core.map((entry, index) => `  [${index < 2 ? "live" : "parked"}] ${entry}`);
	const verified = task.checkpoints.length === 0 ? ["  (none yet)"] : task.checkpoints.map((c) => `  ✓${String(c.seq).padStart(2, "0")} ${c.statement} — verified by: ${c.verifiedBy}`);
	const open = task.openQuestions.length === 0 ? ["  (none)"] : task.openQuestions.map((q) => `  ?${String(q.seq).padStart(2, "0")} ${q.question} — settled by: ${q.settledBy}`);
	return [
		"<long_task_ledger>",
		`Objective: ${task.objective}`,
		`Phase: ${task.phase} | Rounds: ${task.maxRounds} | Handoffs: ${task.handoffs}`,
		"Core:",
		...core,
		"Verified:",
		...verified,
		"Open:",
		...open,
		`Next: ${task.next}`,
		"</long_task_ledger>"
	].join("\n");
}
//#endregion
//#region lib/types/index.js
/**
* Same-session long-task domain: event-sourced hardcoded task state,
* compare-and-set mutations, and process-local continuation activation.
*
* The state is the "hardcoded" ledger — objective, live core entries, numbered
* checkpoints, numbered open questions, and one next action — written by the
* agent at every seam and folded as a session projection rather than a surface
* node. Surface compaction and context handoff therefore fold the conversation
* without touching this exact state.
*
* @module @deepseek-ai/dsh-long-task
*/
/** Wire payload schema of the `longTask` projection (whole task or pre-create/cleared null). */
const longTaskProjectionSchema = z$1.union([z$1.object({
	task: z$1.object({
		id: z$1.string().min(1),
		revision: z$1.number().int().positive(),
		objective: z$1.string().min(1),
		phase: z$1.union([
			z$1.literal("active"),
			z$1.literal("paused"),
			z$1.literal("blocked"),
			z$1.literal("complete")
		]),
		blockedReason: z$1.object({
			code: z$1.string(),
			message: z$1.string()
		}).optional(),
		core: z$1.array(z$1.string()),
		checkpoints: z$1.array(z$1.object({
			seq: z$1.number().int().positive(),
			statement: z$1.string().min(1),
			verifiedBy: z$1.string().min(1)
		})),
		openQuestions: z$1.array(z$1.object({
			seq: z$1.number().int().positive(),
			question: z$1.string().min(1),
			settledBy: z$1.string().min(1),
			closesCheckpoint: z$1.number().int().positive().optional()
		})),
		next: z$1.string().min(1),
		maxRounds: z$1.number().int().positive(),
		handoffs: z$1.number().int().nonnegative()
	}),
	roundsStarted: z$1.number().int().nonnegative(),
	createdAt: z$1.number(),
	updatedAt: z$1.number()
}), z$1.null()]);
/**
* Light last-wins fold of the `longTask` projection unit. Unlike the strict
* replay fold (fold.ts: transition validation, fail-loud on malformed
* changes, Set-typed state), this transition is projection-grade: the state
* is plain JSON (persisted-cache precondition), any non-long-task or malformed
* event returns the same reference (the registry's Object.is gate), and
* correctness of the written change is the write side's job (LongTaskService
* validated it before appending).
* @param state - the projection covering all prior events.
* @param event - the next committed session event.
* @returns the next projection (same reference when the event is not a long-task change).
*/
function applyLongTaskProjection(state, event) {
	if (event.type !== "long-task/change") return state;
	let change;
	try {
		change = decodeLongTaskChange(event.data);
	} catch (_invalidPersistedLongTaskChange) {
		return state;
	}
	if (change === void 0) return state;
	return change.operation === "clear" ? null : {
		task: change.task,
		roundsStarted: change.roundsStarted,
		createdAt: change.createdAt,
		updatedAt: change.updatedAt
	};
}
/** Validate a caller-visible positive safe-integer round cap. */
function resolveMaxRounds(value) {
	if (!Number.isSafeInteger(value) || value < 1) throw new LongTaskError("maxRounds must be a positive safe integer", "LONG_TASK_INVALID_MAX_ROUNDS");
	return value;
}
/** Validate and normalize a required single-line string. */
function resolveRequired(value, code) {
	if (typeof value !== "string" || value.trim().length === 0) throw new LongTaskError(`${code === "LONG_TASK_INVALID_OBJECTIVE" ? "objective" : "next"} must be a non-empty string`, code);
	return value.trim();
}
/** Validate a bounded homogeneous string list. */
function resolveCore(value) {
	if (value.length > 20) throw new LongTaskError("core must hold at most 20 entries", "LONG_TASK_INVALID_CORE");
	return value.map((entry) => {
		if (typeof entry !== "string" || entry.trim().length === 0) throw new LongTaskError("core entries must be non-empty strings", "LONG_TASK_INVALID_CORE");
		return entry.trim();
	});
}
/** Validate numbered checkpoints: positive strictly increasing ordinals. */
function resolveCheckpoints(value) {
	const result = value.map((entry, index) => {
		if (!Number.isSafeInteger(entry.seq) || entry.seq !== index + 1 || entry.statement.trim().length === 0 || entry.verifiedBy.trim().length === 0) throw new LongTaskError("checkpoints require strictly increasing ordinals and non-empty statement/verifiedBy", "LONG_TASK_INVALID_CHECKPOINTS");
		return {
			seq: entry.seq,
			statement: entry.statement.trim(),
			verifiedBy: entry.verifiedBy.trim()
		};
	});
	if (result.length > 100) throw new LongTaskError("checkpoints must hold at most 100 entries", "LONG_TASK_INVALID_CHECKPOINTS");
	return result;
}
/** Validate numbered open questions against the resulting checkpoint ordinals. */
function resolveOpenQuestions(value, checkpoints) {
	const result = value.map((entry, index) => {
		if (!Number.isSafeInteger(entry.seq) || entry.seq !== index + 1 || entry.question.trim().length === 0 || entry.settledBy.trim().length === 0) throw new LongTaskError("openQuestions require strictly increasing ordinals and non-empty question/settledBy", "LONG_TASK_INVALID_OPEN_QUESTIONS");
		return {
			seq: entry.seq,
			question: entry.question.trim(),
			settledBy: entry.settledBy.trim(),
			...entry.closesCheckpoint === void 0 ? {} : { closesCheckpoint: entry.closesCheckpoint }
		};
	});
	if (result.length > 100) throw new LongTaskError("openQuestions must hold at most 100 entries", "LONG_TASK_INVALID_OPEN_QUESTIONS");
	for (const entry of result) if (entry.closesCheckpoint !== void 0 && !checkpoints.some((checkpoint) => checkpoint.seq === entry.closesCheckpoint)) throw new LongTaskError(`open question ${entry.seq} closes an unknown checkpoint`, "LONG_TASK_INVALID_OPEN_QUESTIONS");
	return result;
}
/** Validate and detach one policy-owned blocker explanation. */
function resolveBlockReason(reason) {
	const record = typeof reason === "object" && reason !== null && !Array.isArray(reason) ? reason : void 0;
	const code = record?.["code"];
	const message = record?.["message"];
	if (typeof code !== "string" || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(code) || typeof message !== "string" || message.trim().length === 0) throw new LongTaskError("long-task block reason requires a lower-kebab-case code and a non-empty message", "LONG_TASK_INVALID_BLOCK_REASON");
	return {
		code,
		message: message.trim()
	};
}
/** Materialize deployment defaults and validate one create request. */
function resolveCreateLongTask(request, defaultMaxRounds) {
	const checkpoints = resolveCheckpoints(request.checkpoints ?? []);
	return {
		objective: resolveRequired(request.objective, "LONG_TASK_INVALID_OBJECTIVE"),
		next: resolveRequired(request.next, "LONG_TASK_INVALID_NEXT"),
		maxRounds: resolveMaxRounds(request.maxRounds ?? defaultMaxRounds),
		core: resolveCore(request.core ?? []),
		checkpoints,
		openQuestions: resolveOpenQuestions(request.openQuestions ?? [], checkpoints)
	};
}
/** Validate one edit request and resolve only its present fields. */
function resolveEditLongTask(request) {
	if (request.objective === void 0 && request.next === void 0 && request.maxRounds === void 0 && request.core === void 0 && request.checkpoints === void 0 && request.openQuestions === void 0) throw new LongTaskError("long-task edit requires at least one field", "LONG_TASK_INVALID_EDIT");
	const checkpoints = request.checkpoints === void 0 ? void 0 : resolveCheckpoints(request.checkpoints);
	return {
		...request.objective === void 0 ? {} : { objective: resolveRequired(request.objective, "LONG_TASK_INVALID_OBJECTIVE") },
		...request.next === void 0 ? {} : { next: resolveRequired(request.next, "LONG_TASK_INVALID_NEXT") },
		...request.maxRounds === void 0 ? {} : { maxRounds: resolveMaxRounds(request.maxRounds) },
		...request.core === void 0 ? {} : { core: resolveCore(request.core) },
		...checkpoints === void 0 ? {} : { checkpoints },
		...request.openQuestions === void 0 ? {} : { openQuestions: resolveOpenQuestions(request.openQuestions, checkpoints ?? []) }
	};
}
/** Long-task service (`ctx.longTasks`) backed exclusively by the owning session log. */
var LongTaskService = class extends Service {
	static inject = ["agents"];
	static Config = z.object({ defaultMaxRounds: z.number().default(256) });
	resolved;
	caches = /* @__PURE__ */ new WeakMap();
	constructor(ctx, config = {}) {
		super(ctx, "longTasks");
		this.resolved = { defaultMaxRounds: resolveMaxRounds(config.defaultMaxRounds ?? 256) };
		ctx.on("agent/session-start", ({ agent }) => {
			this.cache(agent.session).activation = "disarmed";
		});
		ctx.inject(["sessionProjections"], (projectionCtx) => {
			projectionCtx.sessionProjections.register({
				key: "longTask",
				stateSchema: longTaskProjectionSchema,
				init: () => null,
				apply: applyLongTaskProjection,
				wire: {
					viewSchema: longTaskProjectionSchema,
					view: (state) => state
				},
				stateVersion: 1
			});
		});
	}
	/**
	* Read the current long task for one exact live agent.
	* @param agent - owning live agent.
	* @returns a fresh view or `undefined` when no task is current.
	* @throws {@link LongTaskError} when the agent is not the registry's live instance.
	*/
	get(agent) {
		this.assertLive(agent);
		const cache = this.cache(agent.session);
		this.sync(agent.session, cache);
		return this.view(cache);
	}
	/**
	* Remove process-local continuation authority without changing durable task
	* phase or revision. Lifecycle owners use this before unloading a driver.
	* @param agent - owning live agent.
	* @returns a fresh disarmed view, or `undefined` when no task is current.
	*/
	disarm(agent) {
		this.assertLive(agent);
		const cache = this.cache(agent.session);
		this.sync(agent.session, cache);
		cache.activation = "disarmed";
		return this.view(cache);
	}
	/**
	* Create and arm a long task. A completed task may be replaced; every other
	* current phase must be cleared or resumed instead.
	* @param agent - owning live agent.
	* @param request - objective, next action, and optional ledger fields and round cap.
	* @returns the created live view.
	*/
	create(agent, request) {
		const spec = resolveCreateLongTask(request, this.resolved.defaultMaxRounds);
		const cache = this.prepareMutation(agent);
		const current = cache.state.task;
		if (current !== void 0 && current.phase !== "complete") throw new LongTaskError(`long task "${current.id}" already exists with phase "${current.phase}"`, "LONG_TASK_ALREADY_EXISTS");
		const now = Date.now();
		const task = {
			id: LongTaskId(`longtask-${randomUUID()}`),
			revision: 1,
			objective: spec.objective,
			phase: "active",
			core: spec.core,
			checkpoints: spec.checkpoints,
			openQuestions: spec.openQuestions,
			next: spec.next,
			maxRounds: spec.maxRounds,
			handoffs: 0
		};
		return this.commitSnapshot(agent, cache, "create", task, 0, now, now, "armed");
	}
	/**
	* Edit ledger fields without changing phase, handoffs, or blocker reason.
	* @param agent - owning live agent.
	* @param ref - expected current revision.
	* @param request - at least one replacement field.
	* @returns the edited view.
	*/
	edit(agent, ref, request) {
		const cache = this.prepareMutation(agent);
		const current = this.expectCurrent(cache, ref);
		const patch = resolveEditLongTask(request);
		const task = {
			...current,
			revision: current.revision + 1,
			...patch
		};
		return this.commitCurrent(agent, cache, "edit", task, cache.activation);
	}
	/**
	* Pause an active task and disarm automatic continuation.
	* @param agent - owning live agent.
	* @param ref - expected current revision.
	* @returns the paused view.
	*/
	pause(agent, ref) {
		return this.transition(agent, ref, "pause", ["active"], "paused", "disarmed");
	}
	/**
	* Resume and arm a stopped task, or rearm an active task after a
	* session-start edge, while its round budget still has capacity.
	* @param agent - owning live agent.
	* @param ref - expected current revision.
	* @returns the active view.
	*/
	resume(agent, ref) {
		const cache = this.prepareMutation(agent);
		const current = this.expectCurrent(cache, ref);
		const resumable = [
			"active",
			"paused",
			"blocked"
		];
		if (!resumable.includes(current.phase)) throw this.transitionError(current, "resume", resumable);
		if (current.phase === "active" && cache.activation === "armed") throw new LongTaskError(`long task "${current.id}" is already active and armed`, "LONG_TASK_INVALID_TRANSITION");
		if (cache.state.roundsStarted >= current.maxRounds) throw new LongTaskError(`long task "${current.id}" exhausted ${current.maxRounds} rounds; increase maxRounds before resuming`, "LONG_TASK_INVALID_TRANSITION");
		return this.commitCurrent(agent, cache, "resume", this.withPhase(current, "active"), "armed");
	}
	/**
	* Mark a current non-complete task complete and disarm it.
	* @param agent - owning live agent.
	* @param ref - expected current revision.
	* @returns the completed view.
	*/
	complete(agent, ref) {
		return this.transition(agent, ref, "complete", [
			"active",
			"paused",
			"blocked"
		], "complete", "disarmed");
	}
	/**
	* Mark an active task blocked and disarm it.
	* @param agent - owning live agent.
	* @param ref - expected current revision.
	* @param reason - policy-owned stable code and human-readable explanation.
	* @returns the blocked view with its durable reason.
	*/
	block(agent, ref, reason) {
		const cache = this.prepareMutation(agent);
		const current = this.expectCurrent(cache, ref);
		if (current.phase !== "active") throw this.transitionError(current, "block", ["active"]);
		return this.commitCurrent(agent, cache, "block", {
			...this.withPhase(current, "blocked"),
			blockedReason: resolveBlockReason(reason)
		}, "disarmed");
	}
	/**
	* Record one context handoff: increment the durable handoff counter and
	* append a non-surface trace event, without changing phase or activation.
	* @param agent - owning live agent.
	* @param ref - expected current revision.
	* @param reason - why the context policy handed the surface off.
	* @returns the updated active view.
	*/
	handoff(agent, ref, reason) {
		const cache = this.prepareMutation(agent);
		const current = this.expectCurrent(cache, ref);
		if (current.phase !== "active") throw this.transitionError(current, "handoff", ["active"]);
		const next = {
			...current,
			revision: current.revision + 1,
			handoffs: current.handoffs + 1
		};
		const view = this.commitCurrent(agent, cache, "handoff", next, cache.activation);
		const trace = {
			kind: "long-task/handoff",
			version: 1,
			ref: {
				id: next.id,
				revision: next.revision
			},
			handoffs: next.handoffs,
			reason,
			at: Date.now()
		};
		agent.session.append("long-task/handoff", trace);
		this.sync(agent.session, cache);
		return view;
	}
	/**
	* Clear the current task while retaining a durable tombstone and history.
	* @param agent - owning live agent.
	* @param ref - expected current revision.
	* @returns the tombstone ref whose revision is one past the cleared snapshot.
	*/
	clear(agent, ref) {
		const cache = this.prepareMutation(agent);
		const current = this.expectCurrent(cache, ref);
		const tombstone = {
			id: current.id,
			revision: current.revision + 1
		};
		const change = {
			kind: "long-task/change",
			version: 1,
			operation: "clear",
			cleared: tombstone,
			clearedAt: this.nextMutationTime(cache)
		};
		this.commit(agent, cache, change, "disarmed");
		return { ...tombstone };
	}
	/** Resolve and validate the cache used by a mutation. */
	prepareMutation(agent) {
		this.assertLive(agent);
		const cache = this.cache(agent.session);
		this.sync(agent.session, cache);
		return cache;
	}
	/** Reject stale or missing current-state refs. */
	expectCurrent(cache, ref) {
		const current = cache.state.task;
		if (current === void 0) throw new LongTaskError("no current long task", "LONG_TASK_NOT_FOUND");
		if (ref.id !== current.id || ref.revision !== current.revision) throw new LongTaskError(`stale long-task ref "${ref.id}" revision ${ref.revision}; current is "${current.id}" revision ${current.revision}`, "LONG_TASK_STALE_REVISION");
		return current;
	}
	/** Enforce exact live-agent identity rather than trusting a matching id. */
	assertLive(agent) {
		if (this.ctx.agents.get(agent.id) !== agent) throw new LongTaskError(`agent "${agent.id}" is not live in this registry`, "LONG_TASK_AGENT_NOT_LIVE");
	}
	/** Return the per-session cache, folding a seed once with activation disarmed. */
	cache(session) {
		let cache = this.caches.get(session);
		if (cache !== void 0) return cache;
		const state = emptyLongTaskFoldState();
		for (const event of session.events) applyLongTaskEvent(state, event);
		cache = {
			state,
			activation: "disarmed",
			observedSeq: session.seq,
			pendingActivation: void 0
		};
		this.caches.set(session, cache);
		return cache;
	}
	/** Incrementally observe durable events and reconcile local activation intent. */
	sync(session, cache) {
		for (const event of session.events.slice(cache.observedSeq)) {
			applyLongTaskEvent(cache.state, event);
			if (event.type === "long-task/change") cache.activation = cache.pendingActivation?.seq === event.seq ? cache.pendingActivation.activation : "disarmed";
			cache.observedSeq += 1;
		}
	}
	/** Build a new revision with one replacement phase. */
	withPhase(current, phase) {
		return {
			...current,
			revision: current.revision + 1,
			phase
		};
	}
	/** Shared validated phase transition. */
	transition(agent, ref, operation, allowed, phase, activation) {
		const cache = this.prepareMutation(agent);
		const current = this.expectCurrent(cache, ref);
		if (!allowed.includes(current.phase)) throw this.transitionError(current, operation, allowed);
		return this.commitCurrent(agent, cache, operation, this.withPhase(current, phase), activation);
	}
	/** Render a stable invalid-transition error. */
	transitionError(current, operation, allowed) {
		return new LongTaskError(`cannot ${operation} long task "${current.id}" from phase "${current.phase}"; expected ${allowed.join(" or ")}`, "LONG_TASK_INVALID_TRANSITION");
	}
	/** Commit a mutation that retains the current task's derived counters/times. */
	commitCurrent(agent, cache, operation, task, activation) {
		const createdAt = cache.state.createdAt;
		if (createdAt === void 0) throw new Error("current long-task cache lacks createdAt");
		return this.commitSnapshot(agent, cache, operation, task, cache.state.roundsStarted, createdAt, this.nextMutationTime(cache), activation);
	}
	/** Clamp a current task's next timestamp across backward wall-clock movement. */
	nextMutationTime(cache) {
		const updatedAt = cache.state.updatedAt;
		if (updatedAt === void 0) throw new Error("current long-task cache lacks updatedAt");
		return Math.max(Date.now(), updatedAt);
	}
	/** Build and commit one full-snapshot mutation. */
	commitSnapshot(agent, cache, operation, task, roundsStarted, createdAt, updatedAt, activation) {
		const change = {
			kind: "long-task/change",
			version: 1,
			operation,
			task,
			roundsStarted,
			createdAt,
			updatedAt
		};
		this.commit(agent, cache, change, activation);
		const view = this.view(cache);
		if (view === void 0) throw new Error("snapshot commit cleared the task unexpectedly");
		return view;
	}
	/** Commit one mutation into the long-task log, cache, and live event stream. */
	commit(agent, cache, change, activation) {
		const ref = longTaskChangeRef(change);
		cache.pendingActivation = {
			seq: agent.session.seq,
			activation
		};
		try {
			agent.session.append("long-task/change", change);
			this.sync(agent.session, cache);
		} finally {
			cache.pendingActivation = void 0;
		}
		const task = this.view(cache);
		const notification = {
			operation: change.operation,
			ref: { ...ref },
			...task === void 0 ? {} : { task }
		};
		agentEvents(this.ctx, agent).emit("long-task/changed", { change: notification });
	}
	/** Build a detached current view. */
	view(cache) {
		const task = cache.state.task;
		const createdAt = cache.state.createdAt;
		const updatedAt = cache.state.updatedAt;
		if (task === void 0) return void 0;
		if (createdAt === void 0 || updatedAt === void 0) throw new Error(`long task "${task.id}" cache lacks timestamps`);
		return {
			...task,
			roundsStarted: cache.state.roundsStarted,
			createdAt,
			updatedAt,
			activation: cache.activation
		};
	}
};
//#endregion
export { LONG_TASK_CHANGE_VERSION, LongTaskError, LongTaskId, LongTaskService, LongTaskService as default, applyLongTaskProjection, decodeLongTaskChange, foldLongTask, longTaskChangeRef, renderLongTaskLedger };
