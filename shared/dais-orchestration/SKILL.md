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

# Dais Orchestration — 用法速查

**第一条命令永远是 PATH 引导**（DSH/cron/spawned shell 缺这些目录）：

```bash
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"
```

## 30 秒任务：给 dais 面派一个 worker 并让它回调你

```bash
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"
RUN=$(dais orchestration create-run --objective "<目标>" | tail -1)
TASK=$(dais orchestration create-task "$RUN" "<任务描述>" | tail -1)
# prompt 里嵌回调契约(把 <MY-SIG> 换成你的签名,如 smk3@session-xxxx):
P="<任务正文>。完成后用 bash 执行两行:
~/.dsh/maestro/bin/cb-send ping <你的ID> <MY-SIG> <ref> '<一句话>'
~/.dsh/maestro/bin/cb-send done <你的ID> <MY-SIG> <ref> '<摘要≤300字>'"
worker-up "$TASK" <项目绝对路径> omp-dais "$P"    # 一条命令: 开pane→绑定→起harness→派任务
```

回调会**原生唤醒你的回合**(ORCA-CB] 前缀注入),无需轮询。收 ping+done 即收口:
`dais orchestration transition-worker <ctx> succeeded`(ctx 见 worker-up 回显)。
清理: `dais orchestration close-terminal <pane> --force`。

## 命令速查

### 消息
```bash
dais orchestration send-message <run_id> <from> <to> --message-type status --subject "<短>" --body "<内容>"
dais orchestration check-messages <handle> [--wait --timeout-ms 120000 --type T]   # 拉取即已读
dais orchestration inject-prompt <dispatch_id-or-session_handle> "<text>"          # 全文进 idle TUI;忙则 --force
```

### 监督任务
```bash
dais orchestration create-run --objective "<text>"                                # → run_<id>
dais orchestration create-task <run_id> "<spec>" [--dep t_..]                      # → task_<id>
dais orchestration start-worker <task_id> --session session_<sid>                  # → ctx_<id>,指名绑定(勿用 assign)
dais orchestration transition-worker <dispatch_id> <state>                         # 9态; 结算=succeeded/failed
dais orchestration check-status [--run-id <rid>]
dais orchestration gc-runs                                                        # GC 已完结 run
```

### Worker 终端
```bash
dais orchestration read-worker <dispatch_id> [--lines 40] [--after <cursor>]       # 游标在 stderr
dais orchestration scan-wait-blocked <dispatch_id>                                 # 诊断卡死
dais orchestration answer <dispatch_id> --text "<t>" --enter                       # 应答交互提示
```

### 项目/终端(开测试终端前先 project-add)
```bash
dais orchestration project-add <abs_path>; dais orchestration project-remove <abs_path> [--force]
dais orchestration new-terminal <project_path> [--cwd <dir>]                       # → session_<sid>
dais orchestration close-terminal <session_sid> [--force]                          # 测完必关
```

## 硬规则

- **供给 worker 只用 `worker-up` 或 `start-worker --session <sid>`**。裸 `start-worker`+`assign` 是坑: assign 绑"人聚焦的 pane", 错绑后 ctx 注入/读取死 `no terminal view registered`。
- `worker_done`/`heartbeat` 的 body 必须是 JSON(`{"task_id","dispatch_id","outcome"}`); 其余 7 类纯文本。
- inject-prompt 只进 idle TUI(标题判), 忙则报错——等 8-10s 或 `scan-wait-blocked` 诊断。
- 回调收不到先看 `tail -3 ~/.dsh/maestro/bridge/dead.log`: `unknown-addressee`=目标不在册; `ambiguous`=撞名,改全签名 `<alias>@<sessionId>`。
- dais GUI 必须活着(`pgrep -af dais`); 死了面全部不可用。

## 别名(注入即起 harness)

`omp-dais` / `cc-dais` / `pi-dais` — 每 shell 已武装,注入别名名即启动对应 harness。模型选择归用户 config, 别名零干预。
