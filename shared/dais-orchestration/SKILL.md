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

# dais-orchestration — 目的→命令→参数

**第一条 bash 永远先 PATH 引导**(DSH/cron/spawned shell 缺目录,跳过即后面全 command not found):

```bash
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"
```

## 目的 → 命令

| 我要… | 调什么 | 传什么 |
|---|---|---|
| 派 worker 干活并等回报 | `worker-up <task_id> <项目绝对路径> [harness] [prompt]`(harness∈omp-dais\|cc-dais\|pi-dais,缺省 omp-dais) | prompt 里嵌回调契约(见 maestro-bridge skill);回显 pane/dispatch |
| 开新终端 | `dais orchestration new-terminal <项目绝对路径>` | 项目须已 project-add;→ `session_<sid>` |
| 建 run/task | `create-run --objective "<目标>"` → `create-task <run_id> "<任务描述>" [--dep t_..]` | → run_<id> / task_<id>,各取输出末行 |
| worker 绑到指定终端 | `start-worker <task_id> --session session_<sid>` | **必须带 --session**;→ ctx_<id> |
| 收口任务 | `transition-worker <ctx_id> succeeded`(或 failed) | worker_done 自动结算,手动只是兜底 |
| 查状态 | `check-status [--run-id <rid>]` | — |
| 给某终端发消息 | `send-message <run_id> <from> <to> --message-type status --subject "<短>" --body "<内容>"` | to=ctx_<id> 或 session_<sid> |
| 等回复 | `check-messages <handle> [--wait --timeout-ms 120000 --type T]` | 拉取即已读 |
| 注入整段 prompt | `inject-prompt <ctx或session_handle> "<全文>"` | 目标须 idle,否则报错(等 8-10s 或 --force) |
| 看 worker 输出 | `read-worker <ctx_id> [--lines 40] [--after <cursor>]` | 游标在 stderr |
| 诊断卡死 | `scan-wait-blocked <ctx_id>` | — |
| 应答交互提示 | `answer <ctx_id> --text "<答案>" --enter` | — |
| 注册测试项目 | `project-add <绝对路径>`(测完 `project-remove <路径> --force`) | — |
| 关测试终端 | `close-terminal <session_sid> --force` | 测完必关 |

## 规则

1. **要给 dais 派 worker → 必须走 worker-up(或 start-worker --session <sid>)**。裸 start-worker+assign 会绑错 pane(绑"人最后聚焦的"),之后 ctx 注入/读取必死 `no terminal view registered`。
2. **要自动结算 → 必须在 start-worker 时 `--command <哨兵命令>`**(worker-up 已自动配好并在 prompt 尾部注入);worker 在终端跑完哨兵命令即 block 自动结算(exit 0=succeeded)。**手动 send-message 发 worker_done 不触发结算**(纯审计事件)——没配哨兵就 `transition-worker <ctx> succeeded` 收口。
3. **worker_done/heartbeat 的 body 必须是 JSON**(上表字段);其余 7 类消息类型纯文本。
4. **要回调编排者 → prompt 里必须嵌 cb-send 契约**(命令见 maestro-bridge skill),否则 worker 无从回报。
5. **回调没到 → 先 `tail -3 ~/.dsh/maestro/bridge/dead.log`**: `unknown-addressee`=目标不在册;`ambiguous`=撞名改全签名;`session-not-found`=目标会话死了。
6. dais GUI 必须活着(`pgrep -af dais`),死了整个面不可用。
7. 测试产物(临时项目/终端)测完必须清理: `close-terminal --force` + `project-remove --force`。

## 30 秒完整配方

```bash
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"
RUN=$(dais orchestration create-run --objective "<目标>" | tail -1)
TASK=$(dais orchestration create-task "$RUN" "<任务>" | tail -1)
P="<任务正文>。完成后 bash 执行:
~/.dsh/maestro/bin/cb-send ping <worker-ID> <编排者签名> <ref> '<一句话>'
~/.dsh/maestro/bin/cb-send done <worker-ID> <编排者签名> <ref> '<摘要>'"
worker-up "$TASK" /tmp/my-proj omp-dais "$P"    # 开pane→绑定→起harness→派任务,一条命令
# 回调原生唤醒你的回合; 收到后:
dais orchestration transition-worker <ctx> succeeded
dais orchestration close-terminal <pane> --force
```
