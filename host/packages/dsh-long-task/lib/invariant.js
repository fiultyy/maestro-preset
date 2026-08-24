import "@deepseek-ai/dsh-llm";
//#region lib/types/runtime.js
/**
* Brand a string as a long-task id.
* @param id - raw long-task identifier.
* @returns the same string with the compile-time brand.
*/
function LongTaskId(id) {
	return id;
}
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
//#endregion
//#region lib/types/invariant.js
/** Package-owned durable long-task-stream invariants. @module @deepseek-ai/dsh-long-task/invariant */
const PACKAGE_NAME = "@deepseek-ai/dsh-long-task";
/** Cordis companion plugin name. */
const name = "long-task-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/** Copy the independent fold before validating one candidate event. */
function cloneState(state) {
	return {
		task: state.task,
		roundsStarted: state.roundsStarted,
		createdAt: state.createdAt,
		updatedAt: state.updatedAt,
		lastRef: state.lastRef,
		seenTaskIds: new Set(state.seenTaskIds)
	};
}
/** Apply one event through the strict long-task decoder and attribute failures. */
function applyChecked(state, event, fail) {
	try {
		applyLongTaskEvent(state, event);
	} catch (error) {
		/* v8 ignore next -- the strict long-task decoder throws Error instances */
		const message = error instanceof Error ? error.message : String(error);
		fail(`session event ${event.seq} violates the durable long-task stream: ${message}`);
	}
}
/** Install an independent incremental fold over every attached session. */
const install = Object.assign((ctx, fail) => {
	const states = /* @__PURE__ */ new WeakMap();
	const staged = /* @__PURE__ */ new WeakMap();
	const seed = (session) => {
		const state = emptyLongTaskFoldState();
		for (const event of session.events) applyChecked(state, event, fail);
		states.set(session, state);
		return state;
	};
	/* v8 ignore next -- session/event always follows list() or session/created seeding */
	const stateFor = (session) => states.get(session) ?? seed(session);
	for (const session of ctx.sessions.list()) seed(session);
	ctx.on("session/created", (session) => {
		seed(session);
	}, { global: true });
	ctx.on("internal/dispatch", (_mode, eventName, args) => {
		if (eventName !== "session/event") return;
		const [session, event] = args;
		const state = cloneState(stateFor(session));
		applyChecked(state, event, fail);
		staged.set(event, {
			session,
			state
		});
	}, { global: true });
	ctx.on("session/event", (session, event) => {
		const candidate = staged.get(event);
		/* v8 ignore next 2 -- internal/dispatch stages the exact callback arguments */
		if (candidate === void 0 || candidate.session !== session) return fail("session/event reached publication without matching long-task-fold validation");
		staged.delete(event);
		states.set(session, candidate.state);
	}, { global: true });
}, { inject: ["sessions"] });
/**
* Register the long-task-stream invariant companion.
* @param ctx - Cordis context carrying the invariant service.
* @returns the installed registration's disposer after setup succeeds.
*/
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//#endregion
export { apply, inject, name };
