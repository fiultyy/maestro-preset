# @deepseek-ai/dsh-long-task

Event-sourced same-session long-task state: a bounded, fixed-schema ledger (`objective`, live `core` entries, numbered `checkpoints`, numbered `openQuestions`, one `next` action) written by the agent at every seam and retained as a session projection. Because the ledger is a projection and not a surface node, surface compaction and context handoff fold the conversation without touching this exact state. The [long-task-domain Agent Note](../../../.agents/notes/implemented/feature/2026-08-22-hardcoded-long-task-state.md) owns the design rationale.

## Config

```yaml
- id: long-task
  name: '@deepseek-ai/dsh-long-task'
  config:
    defaultMaxRounds: 256
```

`defaultMaxRounds` must be a positive safe integer. `create()` materializes this deployment default internally; a request-level value overrides it.

## Service contract

`ctx.longTasks` accepts only the exact live `Agent` instance registered under its id. `get()` returns a detached `LongTaskView`; mutations use a `LongTaskRef { id, revision }` compare-and-set fence and reject stale refs. The service exposes create, edit, pause, resume, complete, block, clear, and handoff verbs. `disarm()` is the lifecycle-only exception: it removes process-local continuation authority without writing a revision.

At most one task is current. Creation produces an active revision-one task and arms it; `objective` and `next` are both required, matching the ledger's "never empty next action" rule. `edit` replaces only the ledger fields passed and cannot change phase, handoffs, or blocker reason. `handoff` increments the durable handoff counter by exactly one on an active task and appends a non-surface `long-task/handoff` trace; it does not pause or disarm. Pause, completion, blocking, and clear disarm activation. A block records a policy-owned lower-kebab-case code plus a normalized explanation. Resume accepts a stopped phase or a disarmed active task only while the round cap has remaining capacity; it clears any former blocker reason.

Every mutation appends a durable `long-task/change` event carrying the complete post-mutation snapshot; clear uses a revisioned tombstone. Strict replay rejects malformed shapes, discontinuous revisions, illegal transitions, non-monotonic timestamps, non-sequential admitted rounds, and handoff traces that do not match the current task. Mutation timestamps clamp against the preceding update when wall time moves backward.

Activation is never persisted. A fresh cache and every `agent/session-start` edge disarm it. A continuation driver calls `disarm()` before unload; a later explicit resume mutation must arm continuation.

The separately published `./invariant` companion maintains an independent fold of each attached session and rejects a violating stream before the candidate event enters the durable log.

## Model Experience

### Long-task state

#### What the model sees

Long-task mutations do not inject model context. The model reads and rewrites the ledger through `get_long_task` / `update_long_task`, and a continuation driver renders the ledger into each round prompt. The ledger is state, not a transcript: reasoning, drafts, and logs do not belong in it.

#### Token effect

Long-task change events add no model tokens by themselves. Tool results and scheduled continuation prompts account for their own visible state.

#### KV Cache effect

There is no KV-cache effect until another component exposes the ledger in model-visible input.

## Known Limitations and Deferred Work

- **State, not scheduling** — this package does not decide when an active task continues; that belongs to the round driver and the context policy.
- **Round-count budget only** — `maxRounds` does not meter tokens, currency, wall time, or provider quotas.
- **One current task** — parallel objectives are intentionally absent; history remains in the session log after replacement or clear.
- **Trusted in-process producers** — a plugin with direct `Session` access can append counterfeit `long-task/change` data; strict replay detects malformed or inconsistent records and leaves access failed at that record until repaired.
