---
name: maestro-orch
description: >-
  DSH maestro orchestrator's single entry skill: entry routing across planes —
  Orca orchestration mailbox (orthodox chain run-create → dispatch --inject →
  worker_done callback wake → ack → worker-release; completion wait is
  callback-only, blocking waits retired; terminal send only as
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

**唯一派发指令集 = `~/.dsh/maestro/bin/orch` 的 dag 族**(原子序:dag-seat-open → dag-run → dag-task [--deps] → dag-seat → (回调) dag-settle → dag-close)。结构化派发、多票 DAG、worker_done 账、ask 应答全部只走它;ledger node+ticket 双写内建于每个原子子命令,无绕过旗标;缺参数 exit 2 不推断;派发链四命令(dag-seat-open/run/task/seat)全路径过 bridge 武装硬门——未武装即拒。**手拼原生 `orca orchestration`、退役的 `orch-dag` 壳(运行只打印退役提示)、dais worker-up 一律不得用于新派发**(历史兼容,仅排障时阅读下文)。编票 DAG 前先过「编票前 grill 门」(ADR-014,下节)——拍板后才进原子序。

| 我要… | 入口 |
|---|---|
| 结构化派发 / worker_done 账 / 多票 DAG / ask 应答 | **orch dag 族**(唯一;子命令表见下) |
| 跨面向回报(Orca 终端/dais pane/cron/任意进程 → 编排席) | **cb-send**(契约模板下;load skill `cb-send`) |
| 记账/汇报 | **内部调用** | ledger(下) |
| 桥死了/注册丢了 | **内部调用** | bridge-rearm(下) |

### 编票前 grill 门(ADR-014,派发规划期用户确认)

**supervised-run 编票 DAG 之前**,先把流程需要的**选择性**做成交互选项 grill 用户,拍板后才进原子序(第一原子命令即 dag-seat-open)。两层表述(用户裁决 #127:三票全走 session subagent 未经确认,即契约无名暗道): **指令面唯一(orch)≠ 执行车道唯一(grill 定)**——dag 族是唯一指令集(ADR-013 定谳,不动摇),执行车道(orca dag 族席位链 / 编排席 session subagent / dais 面 / 其他 harness)是真实决策变量——车道多元,都是正确路径,契约不硬编码单车道,由 grill 交互选项拍板定道。

- **触发阈值(分级)**: 多票 DAG / 跨车道派发 / 含高危动作(触及生产、敏感数据、不可逆删除)→ 必 grill;单票轻修 → 一句话快速确认(车道+验收过目即可),不逐票开选项盘。
- **必 grill 维度**: ① 执行车道(车道多元,见上)② agent harness 倾向 ③ 工作树隔离策略 ④ 票面勾稽深度(lease/refs/run 关联)⑤ 验收标准 ⑥ 高危确认门项。
- **留痕**: grill 问答结果落票面 refs 或 ledger 事件——事后审计可查「当时为什么选这条道」;未留痕视为未 grill。
- **门只定道,不改指令面**: grill 拍板的是执行车道,结构化派发指令集仍唯一(dag 族);本门是编票前置确认步骤,不构成第二条派发路径。

### orch dag 族原子子命令(唯一指令集)

```bash
orch dag-seat-open --project <path> [--base-branch B]        # 编排席终端幂等创建/复用(缓存 handle;--base-branch=worker-start 显式基点双保险)
orch dag-run "<objective>"                             # 幂等建/续 Run
orch dag-task <REF> --title <t> --spec <s> --orch-sig <sig> [--deps R1,R2]   # Orca task + ticket 环原子建;deps 屏障=Orca task_not_startable 硬拒绝(本地未建依赖先行 fail-loud)
orch dag-seat <REF> [--name <worktree>]                # worker-start(固定 omp × new-top-level)+ ticket/node dispatched 双写
# 信封口径(HOOK-ENVELOPE,#133 A′): dag-task 落 task 文本首行自动构造 DSHMSG 派票信封
#   {"from":"<编排席签名>","to":"-","type":"dispatch","ref":"<票REF>","msgid":"<uuid4>","ver":3}
#   ——消费端 ups 钩 NR==1 只认首行 → 落 inflight(5 列含 FROM)→ turn_end 配对回 ticket-done(to=信封 FROM,来路即目标);
#   --orch-sig 必传(SIG-MANDATE,issue#1): <alias>@<sessionId> 直接定信封 from,或 env ORCH_SIG;零静默回落——
#   seat 落态/bridge 签名文件/orch-p0 兜底全废止(多席共册末写者胜=错绑源);缺席 exit 2 附获取法:
#   dsh 席 = echo $DSH_SESSION_ID;任意面 = bridge_arm 后查 ~/.dsh/maestro/bridge/registry.json 自己的注册行。
# 完成等待 = 回调唯一(见「回调单车道」): worker_done 原生唤醒编排席回合;收讫记账:
orch dag-settle <REF> [--outcome "<≤300字>"] [--dispatch <ctx>]   # 票/node → running「复验待关账」;重复回调幂等
orch dag-close <REF> <end|rejected|rolled-back|blocked> --outcome "<≤300字>"   # 复验后关账(唯一终态入口,手工;done=旧别名兼容)
# END 语义(END-RENAME,2026-09-10 用户裁定): worker=oneshot,一回合即回执;票态/回执 end=「回合结束,待复验」≠全部完成。
# 编排者收 end 必复验;复验不过两条路:①改单(票改 dag 更新,跑新插票) ②幂等重跑 end 票(票 end→running 合法,node 保持 end 终态、重结算幂等跳过)。真完成=close。
# 帧事件名 ticket-done 为线协议史料名,语义同 end,不追改;cb-send end 为正名(done 透传仍合法=同义)。
orch dag-status [--ref R] [--json]                     # seat/run/refs + Orca task 并排(只读)
# 票面卫生(CONTRACT-HYGIENE): 测试票(非真实派发目的的 ledger ticket)即建即拒——dag-close rejected 关账,理由必填(outcome/note);生产 ledger 禁留无主测试票
# 册面卫生(NOGUESS-ORCH 收口): 编排席使命终局(链收官/会话退役)必须撤 bridge 册(删 ~/.dsh/maestro/bridge/registry.json 里**本席那一行**;册是共享的,只动自己的行)——僵尸行留册=新 agent 无信封猜主错绑源+测试流量误涌(2026-09-10 活体:三席未撤册)
```

**与 Orca 自带 `orchestration` skill 的关系**: 官方 stub 只管发现;orch dag 族是编排席固化的唯一工作流封装。旗标细节以 `skills get orchestration` 动态加载为准——但那是排障/核对 dag 族行为用的参考,**不是第二条派发路径**。

## 完成等待 — 回调单车道(ORCH-WAKE 契约,ADR-013)

**完成等待唯一手段 = 回调**: worker_done 原生唤醒编排席回合(orchestration 面)/ `cb-send end`(降级与跨面)。**阻塞式 check 等待(--wait)已从代码与契约双双退役**——阻塞等待循环不出现在任何活代码;`check --peek` 仅作只读诊断(**已废弃, deprecated**),不消费、不作等待手段;收讫结算: dag 票用 `orch dag-settle`,正统链票用 `orch settle`(非阻塞,结算回调唤醒携带的 delivery 文档)。前置硬门: 派发路径(`orch dispatch` 与 dag 族四派发命令,含 `--dry-run`)要求本席在 `bridge/registry.json` 有在册 consumer,未武装即拒并给 arm 指引——无回信地址的派工,其完成信号必然丢失(BRIDGE-WAKE 断腿同源)。

> SLA 告警分态语义注记(#122,SLA-TTL,只增不改): event-watchd 的 sla 面对非终态票分态+依赖感知老化——dispatched/running 维持墙钟计龄到 ttl 告警(不变);blocked 票若存在非终态 deps(∈ dispatched/running/blocked)属设计内依赖屏障,不计龄不告警;deps 全终态(ledger TICKET_TERMINAL 同源)/无 deps/dep 票不可查视为真停摆或账本滞后,照常计龄到 ttl 告警——编排席收到 blocked 票 sla-overdue 即账本态滞后信号,优先核对票 deps 现态。

多 worker 异步收件语义(桥 inbox,凭据: ORCH-WAKE 事故定界):

- **持久 FIFO**: 回调帧落盘 `<maestro>/bridge/` 持久队列,编排席离线不丢,重挂后按序排水。
- **at-least-once + 去重**: 同一 delivery 可能投递多次;按 deliveryId 记账幂等(`state/orch-deliveries.json` / dag 票现态幂等),重复帧不二次收尾、不二次记账。
- **乱序无害**: 票完成帧先于开工帧到达亦无碍——账本按现态幂等再水化(end 不回退 running;已 running/end 对重复 running 帧跳过)。
- **join 屏障 = 票 deps,不是等待循环**: 多票汇合靠 `orch dag-task <R> --deps R1,R2`(Orca task_not_startable 硬拒绝);绝不手写轮询/睡眠等下游。

## orch 其余子命令(正统链单票派发 + 收讫/应答/视图)

`~/.dsh/maestro/bin/orch` 除 dag 族外,还承载正统链单票封装与收尾工具,硬机制强制 ledger 记账(规则7/8)+node/ticket 状态机+deliveryId 幂等;**默认零实弹**(测试经 `ORCH_BIN` 注 stub,`--dry-run` 打印命令序列):

```bash
orch dispatch --spec <file|-> --to <handle> --new-run "<objective>" --ref <LK-ID> [--json] [--dry-run]   # run→task→dispatch→建账(含 tickets 环;前置武装硬门)
orch settle [--run r] (--payload-file <f> | --payload -)   # 回调收讫结算(非阻塞): worker_done→ack+release+记账 end;escalation→ack+release exit3;question→不动 exit2
orch reply  --msg <id> --body <t> [--run <run_id>]   # 应答 question;完成信号仍走回调
orch status [--run r] [--ref r] [--json]             # run/task/ctx+ledger 节点并排(离线)
# status/settle 进门兼收 running 帧(worker hook sidecar <maestro>/orch-hooks/running.log):
# ticket-running → dispatch 节点 dispatched→running(幂等,现态非 dispatched 跳过)
orch selftest                       # 离线全链自测(fake stub,110 断言,含 S18 武装硬门 + S19-S26 dag 族全链)
```

细节(`--force` 重复派发/`--no-ticket`/退出码表/状态机表)看 `orch --help` 与源码头注;首次实弹冒烟归编排席。

## Orca 面 — 编排邮箱正统链(dag 族与 dispatch 的内部实现参考,禁止 agent 手拼派发)

**红线**: 本机调 Orca CLI 一律 `ORCA=/opt/Orca/resources/bin/orca-ide`(每会话解析一次,全程复用)。**绝对禁止裸调 `orca`** —— 本机(Linux 非 Orca 终端)裸 `orca` 解析到 GNOME 读屏器 `/usr/bin/orca`,会挂起语音会话。

正统链(实战 4 票全绿;单票全自动 ~13-15 分钟;链序固化,旗标以动态 guide 为准):

```bash
ORCA orchestration run-create ...                                      # → run_<id>
ORCA orchestration task-create <run_id> ...                            # → task_<id>
ORCA orchestration dispatch --inject --to <terminal-handle> --task <task_id>
# 完成等待 = 回调唯一: worker_done 原生唤醒编排席回合,不轮询(阻塞式 check 等待已退役)
ORCA orchestration check --ack <deliveryId>            # 仅对已收到的 delivery 结算
ORCA orchestration worker-release --dispatch <ctx>
# ORCA orchestration check --peek: 已退役(deprecated),只读诊断 —— 仅排障看未读,不消费、不作等待手段
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
3. **派单 prompt 最小化** —— prompt 只带:任务目标 + 指针(skill/票面 spec 文件) + 回执目标签名,三行式;契约(原子序/签名必传/票面卫生/回执模板)一律靠本 SKILL 与 preset 承载,**不内嵌进 prompt 重复**——重复即漂移源(t₀ 决策 #3 spec 文件化的延伸,2026-09-10 用户裁定)。
4. **证据分级汇报** —— 结论性汇报按三级标注:**已验证**(本席亲跑取证)/**复验**(独立方取证后本席核对)/**采信**(他方自报未复核);无标注视为采信。

### 降级通道 — terminal send + cb-send 契约(仅上列降级条件才用)

`terminal send` 末尾必嵌,照抄改尖括号:

```
[ref:<ref>] <任务正文>

—— 回调契约(收到本消息后必须执行)——
1) 回合一开始:
   ~/.dsh/maestro/bin/cb-send ack <你的ID> <MY-SIG> <ref> "turn started"
2) 完成时:
   ~/.dsh/maestro/bin/cb-send end <你的ID> <MY-SIG> <ref> "<摘要≤300字>"
   (cb-send 不在时兜底: printf '%s\n' '{"type":"ack","from":"<你的ID>","to":"<MY-SIG>","body":"[ref:<ref>] turn started"}' >> ~/.dsh/maestro/bridge/inbox.log)
3) 契约行丢失: load skill `cb-send`
```

`<MY-SIG>` = 你的注册签名 `<alias>@<sessionId>`。**必须写全签名**。

**签名三禁令(派发前自检;IDX-1 事故锚: 他线编排跑 bridge-rearm --sync 看到 registry 唯一活体签名,派单直接照抄,from+回调双双指向别人)**:

1. **派发前必自注册签名**——`bridge-rearm`(无参,只自注册不改册)或 `bridge_arm` 注册本席;未注册先注册,再派发。
2. **禁止使用 registry 既存他人签名**——registry/`--sync` 输出里看到的别的 `<alias>@<sessionId>` 是**别的编排者**的活体签名,照抄即冒名(回调全数错投给被冒名者)。
3. **`session-send` 的 from 必为本席码/本席 sessionId**——绝不填他人 alias/sessionId(承投回信会送进别人回合)。

**新编排线首动作纪律(IDX-5 事故③锚: 38c3 换址后从未 arm,回调 3 小时无人消费)**——新起的编排线,回合第一个动作 = `bridge_arm`(或 `bridge-rearm` 自注册)武装本席;不 arm = 注册只是死条目,发向本线的回调全部失联,直到你 arm 为止。

**武装别名纪律(ALIAS-UNIQ, 2026-09-10)**——`bridge_arm` **必带显式职能别名**(`bridge_arm { alias: "<职能>-<线名>" }`,如 maestro-gdi/maestro-audit);**禁无参武装**——全局默认 preset=maestro 会令无参注册的别名恒为裸 `maestro`,多席共册全撞名(活体: 新 agent ping 按别名找 maestro 全部涌向最早在册席)。撞名=猜主错绑源。

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
- `cb-send end` 仅作编排面 CLI 不可用时的**兜底**;双通道**择一,勿双发**。
- worker_done 已自动结算 → **勿再补 task-update**;收尾按需 `worker-start --terminal` 复用终端或 `worker-release` 归还。

## dais 面 — worker-up 三步链

```bash
dais orchestration new-terminal <项目绝对路径>          # → session_<sid>
dais orchestration start-worker <task_id> --session session_<sid>   # 必须 --session → ctx_<id>
dais orchestration inject-prompt <ctx或session> "<全文>"  # 目标须 idle
```

prompt 里必须嵌 cb-send 回调契约(命令见 `cb-send` skill)。收到 end → `dais orchestration transition-worker <ctx_id> succeeded` 收口,然后 close-terminal。**完整命令面(send-message/check-messages/read-worker/scan-wait-blocked/answer/建 run-task)→ load skill `dais-orchestration`**,本技能不重复。

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
5. **双报禁令**: Orca 面 dispatch 票 = worker_done 唯一(cb-send end 仅 CLI 不可用兜底,择一勿双发,勿补 task-update);FULL HANDOFF 不嵌契约(已放弃监督);dais 面已有 worker_done,不叠第二套——dais 面用 `worker-up`(见 dais-orchestration skill)。
6. 死信 `wake failed … session-not-found` = 目标会话死了,等它 re-arm,别重投。
7. **每次派发 → 必须记账**(node 置 dispatched + dispatched 事件)。
8. **每次收果(回调/扫描)→ 必须更新**(状态 end/failed/blocked + ≤300 字 outcome)。账本写失败不阻塞编排: 记一笔继续,下轮 sweep 对账。

### 模板速查(一页照抄;2026-09-10 整合自 降级通道/dais 附录/reply.sh)

**① DSHMSG 派票信封**(dag-task 自动注入 task 文本首行;手工勿拼——派票一律走 dag 族):

    DSHMSG]{"from":"<alias>@<sessionId>","to":"-","type":"dispatch","ref":"<票REF>","msgid":"<uuid4>","ver":3}

**② 降级派发 = terminal send + cb-send 契约**(一条命令;`--enter`=回车提交;正文尽量 ASCII;`$ORCA`=orca/orca-ide 按车道):

    $ORCA terminal send --terminal <handle> --json --enter --text "[ref:<ref>] <任务正文>

    —— 回调契约(收到本消息后必须执行)——
    1) 回合一开始:
       ~/.dsh/maestro/bin/cb-send ack <你的ID> <MY-SIG> <ref> "turn started"
    2) 完成时:
       ~/.dsh/maestro/bin/cb-send end <你的ID> <MY-SIG> <ref> "<摘要≤300字>"
       (cb-send 不在时兜底: printf '%s\n' '{"type":"ack","from":"<你的ID>","to":"<MY-SIG>","body":"[ref:<ref>] turn started"}' >> ~/.dsh/maestro/bridge/inbox.log)
    3) 契约行丢失: load skill cb-send"

**③ 回执回信**(scripts/reply.sh 同款;`DSH-RE]` 前缀=保留字):

    $ORCA terminal send --terminal <handle> --text "DSH-RE] <msg>" --enter --json

**④ dais 面**:

| 动作 | 模板 |
|---|---|
| 起 harness | `dais orchestration inject-prompt session_<sid> <omp-dais\|cc-dais\|pi-dais> --force` |
| 应答交互提示 | `dais orchestration answer <ctx_id> --text "<答案>" --enter` |
| 换 pane 里 harness | `answer <sid> --text "/quit" --enter` 再注入新别名 |

**⑤ 回车/键位坑(--enter 族通用)**: terminal send 多字节 UTF-8 会失效→正文尽量 ASCII;turn 提交键因 TUI 而异;大文本派发 45s 未消费→补一个空 `--enter`,**绝不连发两次**(第二次撤销粘贴,正文被撤回);单行 ~4KB 上限。
