# @deepseek-ai/dsh-tool-long-task

Model-facing `get_long_task`, `create_long_task`, and `update_long_task` tools over the persisted same-session long-task domain, plus a discipline prompt section that tells the model to re-read and rewrite the hardcoded ledger at every seam.

## Config

The tool takes no settings; the empty schema rejects unknown keys.

## Tools

- `get_long_task` — read the current task: id/revision, objective, phase, live core entries, numbered checkpoints, numbered open questions, the single next action, round and handoff counters, blocker reason, and activation.
- `create_long_task` — create one task from a direct human request. `objective` and `next` are required; `core`, `checkpoints`, and `open_questions` are optional and numbered in array order.
- `update_long_task` — update the exact revision. `edit` replaces only the ledger fields passed and requires a direct human turn or the current long-task round; `pause` / `resume` / `clear` require a direct human turn; `complete` / `blocked` require a direct human turn or the current long-task round. `clear` discards the current task while the durable log retains the clear tombstone; subsequent reads return `task: null`.

## Model Experience

### Long-task tools

#### What the model sees

The discipline section instructs the model to keep the ledger bounded — one objective, at most two live core entries, numbered checkpoints with what verified them, numbered open questions each with what would settle it, and one next action that is never empty — and to re-read it at every seam.

#### Token effect

Conditional: the three tool schemas and the discipline section add a fixed instruction cost; tool results carry the current ledger only when called.

#### KV Cache effect

Append-only: the section and tool schemas join the system prompt once and are stable across turns.

## Known Limitations and Deferred Work

- **No browser UI** — ledger state is surfaced through tool results and a future client projection, not a dedicated panel.
- **Wholesale field replacement** — `edit` replaces the passed `core`, `checkpoints`, and `open_questions` lists rather than appending; the model must pass the complete desired list.
