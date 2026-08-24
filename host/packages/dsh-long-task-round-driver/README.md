# @deepseek-ai/dsh-long-task-round-driver

Race-fenced same-session continuation for the long-task domain. When the agent is idle and an active task is armed, it admits the next round with a prompt that re-reads the full hardcoded ledger — the J-Space "re-read at every seam" discipline — so the model continues from exact state rather than drifted conversation memory.

## Behavior

The driver mirrors the goal round driver's scheduling fences: it reserves one round identity, queues it through `Agent.followup()`, checkpoints durability between rounds, and rejects the step if the reserved prompt no longer owns the exact live revision. It blocks an exhausted task with `round-limit`, disarms on `agent/error` or a max-tokens turn, and pauses a cancelled active task.

## Model Experience

### Continuation round prompt

#### What the model sees

Each admitted round carries the rendered ledger (`<long_task_ledger>` with objective, phase, core, checkpoints, open questions, and next) plus the instruction to make progress, verify it, rewrite the ledger through `update_long_task`, and mark completion only with evidence.

#### Token effect

Conditional: one bounded prompt per admitted round; the ledger is capped by the domain service so the prompt stays re-readable.

#### KV Cache effect

Append-only: the round prompt is a user message appended to the surface; it does not replace earlier request tokens.

## Known Limitations and Deferred Work

- **No token/currency budget** — rounds continue until `maxRounds` or a block; the context policy owns surface bounds separately.
- **Single round per idle** — the driver admits at most one round per quiescence; parallel round fan-out is intentionally absent.
