# @deepseek-ai/dsh-long-task-context-policy

Context-budget handoff policy for long tasks. At every step boundary it prices the current request surface through the singleton token meter and compares it against an effective attention window; above `handoffRatio` it hands the task state to a fresh surface rather than relying on a large model's late-attention capacity.

## Config

```yaml
- id: long-task-context-policy
  name: '@deepseek-ai/dsh-long-task-context-policy'
  config:
    handoffRatio: 1.0
    attentionWindow: 200000
```

- `handoffRatio` — hand off the surface once the effective window is this fraction full. A number in `(0, 1]`; defaults to `0.8`.
- `attentionWindow` — optional hard token cap used as the effective window instead of the provider's reported context window. Set it to keep a long task inside the attention-reliable prefix of a large-context model. When omitted, the policy resolves the routed model's reported capacity.
- `auto` — enable automatic step-boundary listeners; defaults to `true`.

## Behavior

The policy listens to `agent/pre-step` and, after the compaction seam's own pressure pass, compares `tokenMeter.measure(session).totalTokens` against `effectiveWindow * handoffRatio`. Below the threshold it does nothing. At or above it:

1. If a `longTasks` service is present and the current task is active, it records a handoff: `ctx.longTasks.handoff(agent, ref, 'pressure')` increments the durable counter and appends a `long-task/handoff` trace. The ledger is a projection and stays exact.
2. It delegates to `ctx.compaction.compactIfNeeded(agent, 'context-overflow', signal)` to fold the surface down hard. The next request starts from the folded surface plus the re-injected ledger.

Gentle pressure compaction below the handoff threshold is the compaction seam's job: configure `compaction-basic` `thresholdRatio` below `handoffRatio` (for example `0.6`) so folding begins before the hard reset is needed.

## Model Experience

### Context-budget handoff

#### What the model sees

The policy does not add prompt prose. Its effect is a folded surface and a re-injected ledger on the next round; the `handoffs` counter is visible through `get_long_task`.

#### Token effect

Indirectly, through `ctx.compaction`: the handoff triggers a context-overflow compaction that replaces a surface range with one summary node, shrinking the request surface.

#### KV Cache effect

Replacing: the context-overflow compaction shadows an earlier surface range, so the next request's prefix differs from the one before the handoff.

## Known Limitations and Deferred Work

- **Compaction-seam dependency** — without a `ctx.compaction` backend the policy records the handoff but cannot reset the surface; it logs a warning and continues.
- **Heuristic window** — `attentionWindow` is a deployment choice, not a measured attention bound; the policy cannot observe a model's effective attention span directly.
- **No proactive scheduling** — the policy reacts at step boundaries; a single oversized retained unit or request envelope is not repairable through surface compaction.
