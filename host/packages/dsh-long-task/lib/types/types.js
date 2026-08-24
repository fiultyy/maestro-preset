/**
 * Pure types of the long-task domain: the ONE home of the `longTask`
 * projection-key declaration plus the durable payload vocabulary it carries,
 * free of host-side imports (cordis events, dsh-agent, dsh-llm, the service).
 * Two namespace projections serve it — `./types` for host consumers,
 * `./client` (the client half-entry's re-export) for client aggregates — with
 * zero content duplication. Host-coupled domain vocabulary (message sources,
 * events, fold shapes) lives in ./domain.ts.
 *
 * The snapshot is the "hardcoded" task state: a bounded, fixed-schema ledger
 * (objective, live core entries, numbered checkpoints, numbered open
 * questions, one next action) that the agent rewrites at every seam. It is a
 * session projection — not a surface node — so surface compaction and context
 * handoff fold the conversation without ever touching this exact state.
 *
 * @module @deepseek-ai/dsh-long-task/types
 */
export {};
//# sourceMappingURL=types.js.map