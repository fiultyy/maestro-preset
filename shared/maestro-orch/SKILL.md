---
name: maestro-orch
description: >-
  DSH maestro orchestrator's single entry skill: entry routing across planes —
  Orca orchestration mailbox (orthodox chain run-create → dispatch --inject →
  worker_done callback wake → ack → worker-release; completion wait is
  callback-only, check --wait retired; terminal send only as
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

**唯一派发指令集 = `~/.dsh/maestro/bin/orch-dag`**(原子序:seat-open → run → task [--deps] → seat → wait → close)。结构化派发、多票 DAG、worker_done 账、ask 应答全部只走它;ledger node+ticket 双写内建于每个原子子命令,无绕过旗标;缺参数 exit 2 不推断。**手拼原生 `orca orchestration`、legacy `orch`、dais worker-up 一律不得用于新派发**(历史兼容,仅排障时阅读下文)。

| 我要… | 入口 |
|---|---|
| 结构化派发 / worker_done 账 / 多票 DAG / ask 应答 | **orch-dag**(唯一;子命令表见下) |
| 跨面向回报(Orca 终端/dais pane/cron/任意进程 → 编排席) | **cb-send**(契约模板下;load skill `cb-send`) |
| 记账/汇报 | **内部调用** | ledger(下) |
| 桥死了/注册丢了 | **内部调用** | bridge-rearm(下) |

### orch-dag 原子子命令(唯一指令集)

```bash
orch-dag seat-open --project <path>                    # 编排席终端幂等创建/复用(缓存 handle)
orch-dag run "<objective>"                             # 幂等建/续 Run
orch-dag task <REF> --title <t> --spec <s> [--deps R1,R2]   # Orca task + ticket 环原子建;deps 屏障=Orca task_not_startable 硬拒绝
orch-dag seat <REF> [--name <worktree>]                # worker-start(固定 omp × new-top-level)+ ticket/node dispatched 双写
orch-dag wait [--timeout-ms MS]                        # 收尾排水(完成信号本体=回调,见「回调单车道」): worker_done→ack+release+票转 running(复验待关账);question exit2/escalation exit3/超时 exit4
orch-dag reply --msg <id> --body <t>                   # question 应答
orch-dag close <REF> <done|rejected|rolled-back|blocked> --outcome "<≤300字>"   # 复验后关账(唯一终态入口)
orch-dag status [--ref R]                              # run/task/dispatch + ticket + node 并排(只读)
```

**与 Orca 自带 `orchestration` skill 的关系**: 官方 stub 只管发现;orch-dag 是编排席固化的唯一工作流封装。旗标细节以 `skills get orchestration` 动态加载为准——但那是排障/核对 orch-dag 行为用的参考,**不是第二条派发路径**。

## 完成等待 — 回调单车道(ORCH-WAKE 契约,ADR-0001)

**完成等待唯一手段 = 回调**: worker_done 原生唤醒编排席回合(orchestration 面)/ `cb-send done`(降级与跨面)。**`check --wait` 已从操作面退役**——阻塞等待循环不再出现在任何契约;`check --peek` 仅作只读诊断(**已废弃**标记),不消费、不作等待手段。前置硬门: `orch dispatch`(含 `--dry-run`)要求本席在 `bridge/registry.json` 有在册 consumer,未武装即拒并给 arm 指引——无回信地址的派工,其完成信号必然丢失(BRIDGE-WAKE 断腿同源)。

多 worker 异步收件语义(桥 inbox,凭据: ORCH-WAKE 事故定界):

- **持久 FIFO**: 回调帧落盘 `<maestro>/bridge/` 持久队列,编排席离线不丢,重挂后按序排水。
- **at-least-once + 去重**: 同一 delivery 可能投递多次;按 deliveryId 记账幂等(`state/orch-deliveries.json` / orch-dag 账),重复帧不二次收尾、不二次记账。
- **乱序无害**: 票完成帧先于开工帧到达亦无碍——账本按现态幂等再水化(done 不回退 running;已 running/done 对重复 running 帧跳过)。
- **join 屏障 = 票 deps,不是等待循环**: 多票汇合靠 `orch-dag task <R> --deps R1,R2`(Orca task_not_startable 硬拒绝);绝不手写轮询/睡眠等下游。

## orch 高抽象入口(历史兼容 — 勿用于新派发)

`~/.dsh/maestro/bin/orch` 把正统链封装为编排席级动作,并硬机制强制 ledger 记账(规则7/8)+node/ticket 状态机+deliveryId 幂等;**默认零实弹**(测试经 `ORCH_BIN` 注 stub,`--dry-run` 打印命令序列):

```bash
orch dispatch --spec <file|-> --to <handle> --new-run "<objective>" --ref <LK-ID> [--json] [--dry-run]   # run→task→dispatch→建账(含 tickets 环)
orch wait  [--run <run_id>]         # 完成等待=回调唯一(check --wait 已退役);本步收尾: done→ack+release+记账;escalation→ack+release,exit3;question→不动,exit2;超时→exit4 检查点
orch reply  --msg <id> --body <t> [--run <run_id>]   # 应答 question;成功后重挂 wait
orch status [--run r] [--ref r] [--json]             # run/task/ctx+ledger 节点并排(离线)
# wait/status 进门兼收 running 帧(worker hook sidecar <maestro>/orch-hooks/running.log):
# ticket-running → dispatch 节点 dispatched→running(幂等,现态非 dispatched 跳过)
orch selftest                       # 离线全链自测(fake stub,58 断言,含 S18 bridge 武装硬门)
```

细节(`--force` 重复派发/`--no-ticket`/退出码表/状态机表)看 `orch --help` 与源码头注;首次实弹冒烟归编排席。

## Orca 面 — 编排邮箱正统链(历史:orch-dag 的内部实现参考,禁止 agent 手拼派发)

**红线**: 本机调 Orca CLI 一律 `ORCA=/opt/Orca/resources/bin/orca-ide`(每会话解析一次,全程复用)。**绝对禁止裸调 `orca`** —— 本机(Linux 非 Orca 终端)裸 `orca` 解析到 GNOME 读屏器 `/usr/bin/orca`,会挂起语音会话。

正统链(实战 4 票全绿;单票全自动 ~13-15 分钟;链序固化,旗标以动态 guide 为准):

```bash
ORCA orchestration run-create ...                                      # → run_<id>
ORCA orchestration task-create <run_id> ...                            # → task_<id>
ORCA orchestration dispatch --inject --to <terminal-handle> --task <task_id>
# 完成等待 = 回调唯一: worker_done 原生唤醒编排席回合,不轮询(check --wait 已退役)
ORCA orchestration check --ack <deliveryId>            # 仅对已收到的 delivery 结算
ORCA orchestration worker-release --dispatch <ctx>
# ORCA orchestration check --peek: 已废弃,只读诊断 —— 仅排障看未读,不消费、不作等待手段
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
