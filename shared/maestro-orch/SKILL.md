---
name: maestro-orch
description: >-
  DSH maestro orchestrator's single entry skill: entry routing across planes —
  Orca orchestration mailbox (orthodox chain run-create → dispatch --inject →
  check --wait worker_done → ack → worker-release; terminal send only as
  degraded fallback with cb-send contract), dais lane (worker-up three-step,
  full CLI table delegated to dais-orchestration), cross-plane callbacks
  (cb-send) — plus internal calls (signature, ledger, bridge re-arm). Use when
  you are the DSH maestro orchestrator session and need to dispatch work, drive
  terminals, or settle tasks.
---

# maestro-orch — DSH 编排者总入口(路由→命令→参数)

你是 DSH maestro 编排会话。**第一条 bash 永远先 PATH 引导**(spawned shell 缺目录):

```bash
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"
```

你的注册签名 `<alias>@<sessionId>`(session-spawn 自动注册,`cat ~/.dsh/maestro/bridge/registry` 可验)。

## 路由仲裁 — 任何派发先过这张表

| 我要… | 走哪面 | 入口 |
|---|---|---|
| **一次调用完成派发/收尾+自动记账**(dispatch/wait/reply/status;ledger+状态机硬机制) | **orch CLI** | `~/.dsh/maestro/bin/orch`(下节"orch 高抽象入口");免拼底层链 |
| 结构化派发 / 要 worker_done 账 / 多票 DAG / ask 应答 | **Orca 编排面(正统)** | 下节"编排邮箱正统链" |
| 派活给 dais GUI 里的终端 worker | **dais 面** | worker-up 三步链(下);全表 load skill `dais-orchestration` |
| 跨面向回报(Orca 终端/dais pane/cron/任意进程 → 编排席) | **cb-send** | 契约模板(下);全表 load skill `cb-send` |
| 记账/汇报 | **内部调用** | ledger(下) |
| 桥死了/注册丢了 | **内部调用** | bridge-rearm(下) |

**与 Orca 自带 `orchestration` skill 的关系**: 官方 stub 只管发现;本节是编排席固化的工作流(链序/禁令/票面工艺),**不缓存命令表**——旗标细节以 `skills get orchestration` 动态加载为准,与本节冲突时动态 guide 赢。

## orch 高抽象入口 — 一次调用 = 一个生命周期动作(债#9×#11)

`~/.dsh/maestro/bin/orch` 把正统链封装为编排席级动作,并硬机制强制 ledger 记账(规则7/8)+node/ticket 状态机+deliveryId 幂等;**默认零实弹**(测试经 `ORCH_BIN` 注 stub,`--dry-run` 打印命令序列):

```bash
orch dispatch --spec <file|-> --to <handle> --new-run "<objective>" --ref <LK-ID> [--json] [--dry-run]   # run→task→dispatch→建账(含 tickets 环)
orch wait  [--run <run_id>]         # check --wait+自动收尾: done→ack+release+记账;escalation→ack+release,exit3;question→不动,exit2;超时→exit4 检查点
orch reply  --msg <id> --body <t> [--run <run_id>]   # 应答 question;成功后重挂 wait
orch status [--run r] [--ref r] [--json]             # run/task/ctx+ledger 节点并排(离线)
orch selftest                       # 离线全链自测(fake stub,43 断言)
```

细节(`--force` 重复派发/`--no-ticket`/退出码表/状态机表)看 `orch --help` 与源码头注;首次实弹冒烟归编排席。

## Orca 面 — 编排邮箱正统链(派发主路径)

**红线**: 本机调 Orca CLI 一律 `ORCA=/opt/Orca/resources/bin/orca-ide`(每会话解析一次,全程复用)。**绝对禁止裸调 `orca`** —— 本机(Linux 非 Orca 终端)裸 `orca` 解析到 GNOME 读屏器 `/usr/bin/orca`,会挂起语音会话。

正统链(实战 4 票全绿;单票全自动 ~13-15 分钟;链序固化,旗标以动态 guide 为准):

```bash
ORCA orchestration run-create ...                                      # → run_<id>
ORCA orchestration task-create <run_id> ...                            # → task_<id>
ORCA orchestration dispatch --inject --to <terminal-handle> --task <task_id>
ORCA orchestration check --wait --types worker_done,escalation,question  # 滚动收件
#   question → orchestration reply 应答;escalation 逐条处置;超时=检查点,续滚
ORCA orchestration check --ack <deliveryId>
ORCA orchestration worker-release --dispatch <ctx>
```

- worker_done 原生结算 task/dispatch,**勿再补 `task-update --status completed`**(重复结算)。
- 编排邮箱 send/check/ask/reply 走会话邮箱,**永不触终端输入**;要把字节打进终端 TUI 才轮到 `terminal send`。
- 官方分界句(orca-ide guide 原文): "Use `orchestration dispatch --inject` to deliver a tracked task, or `terminal send` when an existing agent needs a free-form prompt." → **terminal send 降级条件**: 仅当 dispatch 不可用(目标非 recognized agent / `agent_unconfigured`,inject 链断)或裸 shell 自由注字。降级票无 worker_done 账,走下面的 cb-send 契约兜底;**不要建 Run/Task 壳事后伪装 orchestrated**。

### recognized agent 判定与 inject 断链退化(原 orchestration-guide 已并入)

- ✅ **recognized** = Orca agent-first 起的 terminal(`worktree create --agent <id>` / `worker-start --agent <id>`,claude/codex/omp/pi 等):可 `dispatch --inject` / `worker-start --terminal`。
- ❌ **非 recognized** = 裸 agent CLI 直起的 TUI(`omp --resume <session>` 等):进程活着、能 terminal send 交互,但 Orca 不认——inject 链整条断,`dispatch --inject`/`worker-start --terminal` 报 `agent_unconfigured`("not running a recognized agent")。
- 判定来源: `ORCA worktree ps --json` 的 `agents[].agentType`(**有值=recognized**);`terminal list --json` 的 `agentType` 常为 null,**不可单独判定**。
- `agent_unconfigured` 唯一正确退化: `terminal send --text "<ASCII prompt>" --enter` + 手动监督——**无 dispatch provenance、无 worker_done**;严禁建 Run/Task 壳事后 `task-update` 伪装 orchestrated;要真 lifecycle 就 `worker-start --worktree <tracked> --agent <id>` 起 recognized agent,别复用裸 TUI。
- terminal send 踩坑: 多字节 UTF-8 会失效、turn 提交键因 TUI 而异——降级注入正文尽量 ASCII;裸 git worktree 不在 Orca 树,其上 tab UI 不可见。
- "开 N 个终端执行 X"决策树浓缩: 要监督/多票 DAG/等结果→本节正统链;只发一句/读回复不等→terminal send/read;全交接所有权(不等不盯不追踪)→orca-cli handoff。终端创建走 `ORCA terminal create`(tracked worktree 才可见)。

**串行批票面工艺(两条实战教训)**:

1. **基线禁 stamp 绝对 sha** —— 串行逐票落地会前移 HEAD,第二批起必然停题;票面基线一律写"本批线性链规则"(第 N 票基于第 N-1 票落定后的链头),不写 commit sha。
2. **报文计数纪律** —— 文件数 = `git show --name-only | wc -l`,处数 = grep 行数,**两数分开写**;混写即验收歧义(R31/R32 连续混写笔误教训)。

### 降级通道 — terminal send + cb-send 契约(仅上列降级条件才用)

`terminal send` 末尾必嵌,照抄改尖括号:

```
[ref:<ref>] <任务正文>

—— 回调契约(收到本消息后必须执行)——
1) 回合一开始:
   ~/.dsh/maestro/bin/cb-send ack <你的ID> <MY-SIG> <ref> "turn started"
2) 完成时:
   ~/.dsh/maestro/bin/cb-send done <你的ID> <MY-SIG> <ref> "<摘要≤300字>"
   (cb-send 不在时兜底: printf '%s\n' '{"type":"ack","from":"<你的ID>","to":"<MY-SIG>","body":"[ref:<ref>] turn started"}' >> ~/.dsh/maestro/bridge/inbox.log)
3) 契约行丢失: load skill `cb-send`
```

`<MY-SIG>` = 你的注册签名 `<alias>@<sessionId>`。**必须写全签名**。

**签名三禁令(派发前自检;IDX-1 事故锚: 他线编排跑 bridge-rearm --sync 看到 registry 唯一活体签名,派单直接照抄,from+回调双双指向别人)**:

1. **派发前必自注册签名**——`bridge-rearm`(无参,只自注册不改册)或 `bridge_arm` 注册本席;未注册先注册,再派发。
2. **禁止使用 registry 既存他人签名**——registry/`--sync` 输出里看到的别的 `<alias>@<sessionId>` 是**别的编排者**的活体签名,照抄即冒名(回调全数错投给被冒名者)。
3. **`session-send` 的 from 必为本席码/本席 sessionId**——绝不填他人 alias/sessionId(承投回信会送进别人回合)。

**新编排线首动作纪律(IDX-5 事故③锚: 38c3 换址后从未 arm,回调 3 小时无人消费)**——新起的编排线,回合第一个动作 = `bridge_arm`(或 `bridge-rearm` 自注册)武装本席;不 arm = 注册只是死条目,发向本线的回调全部失联,直到你 arm 为止。

降级场景速查:

| 我要… | 怎么做 | 传什么 |
|---|---|---|
| 派任务并等回报 | `terminal send` + 末尾嵌上面的契约模板 | 见模板 |
| 报"对方已开工/已完成" | 等回调(原生唤醒你的回合,不轮询) | ACK→节点 running;DONE→收口 |
| **收到回调** | **先 `ref-guard <ref> --sender <from>` 验账(IDX-2):命中三账 nodes/tickets/flows 才信;未知 exit 1,`--nack` 自动回告 'unknown-ref rejected'** | 未派发的 ref 拒收:不落账、不派生动作 |
| 回调超时(~10 分钟) | 机械校验: `terminal read --cursor` / `terminal wait --for tui-idle` | 握手协作,机械校验仲裁 |
| 派大文本 | 拆段或落文件传路径 | 见规则 4 |
| 换 pane 里的 harness | `answer <sid> --text "/quit" --enter` 再注入新别名 | — |

### 双报禁令(Orca 面)

- 经 `dispatch --inject` 建账的票: **完成信号 = 原生 worker_done,只此一路**。
- `cb-send done` 仅作编排面 CLI 不可用时的**兜底**;双通道**择一,勿双发**。
- worker_done 已自动结算 → **勿再补 task-update**;收尾按需 `worker-start --terminal` 复用终端或 `worker-release` 归还。

## dais 面 — worker-up 三步链

```bash
dais orchestration new-terminal <项目绝对路径>          # → session_<sid>
dais orchestration start-worker <task_id> --session session_<sid>   # 必须 --session → ctx_<id>
dais orchestration inject-prompt <ctx或session> "<全文>"  # 目标须 idle
```

prompt 里必须嵌 cb-send 回调契约(命令见 `cb-send` skill)。收到 done → `dais orchestration transition-worker <ctx_id> succeeded` 收口,然后 close-terminal。**完整命令面(send-message/check-messages/read-worker/scan-wait-blocked/answer/建 run-task)→ load skill `dais-orchestration`**,本技能不重复。

## 内部调用 — ledger(账本)

库: `~/.dsh/maestro/ledger.db`。工具: `L="python3 ~/.dsh/maestro/bin/ledger"`(sync/log 脚本在本技能 `scripts/ledger/`)。

| 我要… | 调什么 | 传什么 |
|---|---|---|
| 登记项目 | `$L project <path> <name>` | 幂等 |
| 派发后记账 | `$L node <project_key> <node_id> <kind> <status> <event_type> <source> <detail> [refs_json]` | kind: worktree\|task\|dispatch\|handoff\|p2p\|job;refs 是 JSON(`{"dispatch":"ctx_..","run":"run_.."}`) |
| 只追加事件 | `$L event <project_key> <node_id> <event_type> <detail>` | 收果/进展补记 |
| 汇报查询 | `$L report` | 汇报从账本来,不凭记忆 |

## 内部调用 — bridge-rearm(桥/注册修复)

| 我要… | 调什么 | 传什么 |
|---|---|---|
| 宿主重启后重建桥注册 | `~/.dsh/maestro/bin/bridge-rearm --sync` | `--sync` 权威清扫死条目 |
| 只自注册不改册 | `bridge-rearm`(无参) | — |

## 规则

1. **降级派发(terminal send)→ 必须嵌契约**(terminal send 没有投递语义,别靠读终端输出确认);编排面 dispatch 票不需要,worker_done 即账。
2. **回调原生唤醒回合,不轮询**;超时才机械校验。
3. **判定对方产出 → 三闸**: 排除回合前已存在的命中行;关键词用本轮独有词(ref 号/新产物名);命中后再等一次 tui-idle 才收口。
4. **大文本折叠陷阱**: 派发后 45s 未消费 → 补一个空 `--enter`;**绝不连发两次 Enter**(第二次撤销粘贴,正文被撤回)。单行 ~4KB 上限。
5. **双报禁令**: Orca 面 dispatch 票 = worker_done 唯一(cb-send done 仅 CLI 不可用兜底,择一勿双发,勿补 task-update);FULL HANDOFF 不嵌契约(已放弃监督);dais 面已有 worker_done,不叠第二套——dais 面用 `worker-up`(见 dais-orchestration skill)。
6. 死信 `wake failed … session-not-found` = 目标会话死了,等它 re-arm,别重投。
7. **每次派发 → 必须记账**(node 置 dispatched + dispatched 事件)。
8. **每次收果(回调/扫描)→ 必须更新**(状态 done/failed/blocked + ≤300 字 outcome)。账本写失败不阻塞编排: 记一笔继续,下轮 sweep 对账。
