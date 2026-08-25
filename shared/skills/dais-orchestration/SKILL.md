---
name: dais-orchestration
description: >-
  Drive agents through dais's orchestration plane (`dais orchestration ...`):
  send messages into any terminal's session mailbox, block on typed replies,
  inject full prompts with bracketed paste, run supervised task DAGs
  (create-run/create-task/start-worker), auto-settle via block-driven
  worker_done, read worker terminal tails with cursors, scan for wait-blocked
  signals, answer interactive prompts, and manage decision gates. Use when the
  user says "direct send", "inject prompt", "poke terminal", "message another
  agent", "drive the other harness", "cross-harness", "session mailbox", or
  "dais orchestration". Use plain terminal send for one-off shell input with
  no mailbox semantics.
---

# Dais Orchestration (cross-harness turn driving + supervised runs)

The dais orchestration plane is the stable external surface of the dais
terminal app: 18 CLI subcommands over a SQLite-backed message bus, reachable
as `dais orchestration <sub>`. Capability contract: see
`docs/orchestration-capabilities.md` in the dais repo (audited 2026-08-22).

## When to use / not use

- Use: durable message + guaranteed pull by the target agent; blocking wait
  for a typed reply; injecting a full task prompt into an idle agent TUI.
- Use: supervised runs with DAG deps, circuit breakers, decision gates,
  block-driven auto `worker_done` (no completion polling needed).
- Use: reading a busy worker's terminal tail incrementally; detecting what a
  worker is stuck on (`scan-wait-blocked`); answering its prompts.
- Not use: one-off shell keystrokes with no reply tracking — plain terminal
  send is cheaper.

## Prerequisites

- dais GUI app running (router + PTY bridge live in the GUI process; CLIs
  share its SQLite at `~/.local/state/dais/warp.sqlite`, WAL + 2s
  busy_timeout, safe for multi-process reads).
- Any bootstrapped terminal pane auto-registers a session mailbox
  `session_<sid>` (shell exit → unregister). Find `<sid>` in the GUI log
  `Shell is bootstrapped with session_id SessionId(<sid>)`. Cross-harness
  direct send to ANY pane needs no run/task entities.
- Runtime detection: `~/.local/state/dais/dais-runtime.json`
  (`{socket_path, pid, mode}`) — CLI forwards commands to the GUI over the
  runtime socket (L2) transparently, falling back to direct DB when the GUI
  is down; outputs are byte-identical either way. (Pre-2026-08-23 binaries
  used the filename `zap-runtime.json`.)

## Message semantics (read first)

- 9 message types; only `worker_done` and `heartbeat` have lifecycle side
  effects, and their bodies MUST be JSON objects with fixed fields:
  `worker_done` → `{"task_id","dispatch_id","outcome":"succeeded|failed"}`
  (bad JSON/fields = structured Rejected, stays undeliverable);
  `heartbeat` → `{"dispatch_id"}`. Other 7 types are store-and-audit only.
- Handles: `ctx_<id>` (dispatch mailbox, from start-worker / assign),
  `session_<sid>` (any terminal), `orchestrator` (GUI router's own mailbox —
  single consumer; CLI pulls are REJECTED while the GUI lives; never route
  critical messages there from outside).
- Push (pointer-only, GUI process): router wakes on enqueue arrival events
  (P5 Condvar; the former sleep interval is kept only as wait-timeout
  fallback, no polling-misalignment tail); at
  an idle edge (title/alt-screen/silence heuristics; never on Unknown) it
  writes one pointer line + a lone CR 500 ms later. Bodies are never pushed —
  `check-messages` pull is the only authoritative consumption.
- Waiter mutual exclusion: a live `--wait` claim hides its claimed types from
  push; claims carry ~15 s TTL refreshed while polling — dead waiters
  self-heal.
- Retire on exit: pane shell exit unregisters its mailbox and retires the
  dispatch binding; a reborn pane never receives stale input.

## Commands

### Cross-harness messaging

  # durable message into the target's turn (body = what the agent reads)
  dais orchestration send-message <run_id> <from> <to> \
    --message-type status --subject "<short>" --body "<content>"
  # → enqueued seq=N

  # pull (marks read) / block on a typed reply (timeout is NOT an error;
  # a same-filter final re-read always follows; --type filter is client-side,
  # non-matching rows stay unread)
  dais orchestration check-messages <handle> [--wait --timeout-ms 120000 --type T]

  # full prompt into an idle agent TUI: bracketed-paste frame + lone CR after
  # 500 ms; refuses Working/Permission/unreadable titles unless --force
  dais orchestration inject-prompt <dispatch_id-or-session_handle> "<text>" [--force]

### Supervised runs (DAG + settlement)

  dais orchestration create-run --objective "<text>"            # → run_<id>
  dais orchestration create-task <run_id> "<spec>" [--dep t_..] # → task_<id>
  dais orchestration start-worker <task_id> [--command "<cmd>"] # → ctx_<id>
  dais orchestration assign <dispatch_id>   # bind dispatch to the active pane

  # block settlement: with --command, the shell block that exactly matches
  # the command auto-enqueues worker_done (exit 0=succeeded) — no polling.
  dais orchestration mark-ready <dispatch_id>            # worker ready triple
  dais orchestration fail-dispatch <dispatch_id> "<err>" # circuit breaker ++
  dais orchestration promote-tasks <run_id>              # deps done → ready
  dais orchestration transition-worker <dispatch_id> <state>  # 9-state machine
  dais orchestration check-status [--run-id <rid>]

### Worker terminal interaction

  # rendered tail, 64KB cap; --after gives only newer lines;
  # machine cursor arrives on STDERR as `cursor: <n>` — do not mix streams
  dais orchestration read-worker <dispatch_id> [--lines 40] [--after <cursor>]

  # classify a stuck worker: codex-update/cwd/model-migration/hooks-review/
  # trust-workspace/interactive-prompt/permission-prompt
  dais orchestration scan-wait-blocked <dispatch_id>

  # answer an interactive prompt: text→500ms→CR, or interrupt (Ctrl-C)
  dais orchestration answer <dispatch_id> [--text "<t>"] [--enter|--interrupt]

### Decision gates

  dais orchestration create-gate <task_id> --question "<q>" --option "<o>"...
  dais orchestration resolve-gate <gate_id> <resolution>   # unblock
  dais orchestration expire-gate <gate_id>                 # task → failed

### Projects, worktrees, terminals (v2, 2026-08-23)

  # project registry: machine-parseable `path<TAB>added<TAB>opened` lines;
  # add is idempotent (existing → "exists (refreshed)"); remove refuses while
  # tabs reference the project (reports them) — --force reclaims those tabs
  # FULLY (kills resident harness process groups → closes tabs → mailbox
  # retires → then deletes the project row; never orphans into "ungrouped")
  dais orchestration project-list
  dais orchestration project-add <abs_path>
  dais orchestration project-remove <abs_path> [--force]

  # worktrees live at `<project>/../<repo>-<name>` (new branch <name> from
  # HEAD); created worktrees auto-register as projects; remove --force has the
  # same full-reclaim semantics (order vs project-remove is idempotent)
  dais orchestration worktree-create <project_path> <name>   # → worktree path
  dais orchestration worktree-list [<project_path>]
  dais orchestration worktree-remove <path> [--force]

  # open a new terminal tab in a project's active window (GUI main thread via
  # runtime RPC; needs a running GUI). Waits on the authoritative session
  # registration (~12 s window) and prints the session mailbox handle.
  # Harness selection is NOT a parameter: aliases (omp-dais/cc-dais/pi-dais)
  # are armed in every new shell bootstrap — start one by injecting the alias
  # name into the returned session, e.g. inject-prompt session_<sid> "omp-dais"
  dais orchestration new-terminal <project_path> [--cwd <dir>]  # → session_<sid>

  # close a single terminal tab: --force interrupts a lingering harness
  # (Ctrl-C) and shuts the PTY down first; the session mailbox retires on
  # shell exit (shell_event_bridge) — always close test tabs, never leave them
  dais orchestration close-terminal <session_sid> [--force]

### Transparent harness aliases (armed per-shell, not orchestration commands)

  cc-dais / omp-dais / pi-dais — plain `cc`/`omp`/`pi` plus transparent proxy
  through the local gateway (127.0.0.1:8787). Model selection is 100% the
  user's own CLI config (alias injects zero --model); omp redirects via
  ZHIPU_CODING_PLAN_BASE_URL with per-endpoint catalog cache isolation, so
  gateway runs never poison the direct catalog (and upstream model additions
  appear automatically via dynamic discovery). pi-dais env redirection is a
  documented no-op until pi adopts the same env convention.

## Failure modes

- Target busy → message stays pending (`read=0 AND delivered_at IS NULL`);
  pushed at the next idle edge. Safe to re-send.
- `no terminal view registered` → pane not assigned/bootstrapped; find the
  session id in the GUI log, use `assign` or the `session_<sid>` handle.
- CLI says GUI alive but command stalls → L2 socket path from
  dais-runtime.json; a stale PID makes CLI fall back to direct DB silently.
- Headless box → `dais serve` runs the RPC endpoint without GPUI; push
  (pointer) delivery is absent — only the pull path works there.
- Observing without side effects: read `warp.sqlite` directly
  (runs/tasks/dispatch_contexts/worker_dispatches/messages/deliveries/
  decision_gates/worker_terminal_archives/orchestration_waiters); read-worker
  also archives each tail snapshot into worker_terminal_archives.
- Injected commands run without a TTY in their context (`tty` prints "not a
  tty") — never build identity from tty/$PPID inside injected payloads; tag
  them externally per pane instead.
- An idle agent TUI still swallows later injections as prompts (OSC 777 stop
  events carry the query). To replace a pane's harness: `answer <sid> --text
  "/quit" --enter`, then inject the new alias.
