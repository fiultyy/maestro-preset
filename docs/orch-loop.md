# orch-loop — terminal-send + cb-send 派发闭环约定(gen3 增量,2026-08-17)

> 与 handoff-orch-gen2.md 互补:gen2 是 zap 时代 orca-run 形态;本文是 **terminal-send 直派 + 桥回调** 形态,
> 首次全链实证于 dsh-lark 项目(2026-08-17,larkbiz-001 派发 + v4 票制)。

## 全链(八步,2026-08-23 嵌 checkpoint)

```
1 arm      register 签名(host lane: POST /register;裸 preset: bridge_arm{alias});签名落笔 maestro/bridge/orch.signature
2 probe    fleet-probe <termid>(自动读 orch.signature)→ 回调回合验证 from==termid → fleet verified + ledger p2p 节点
3 ticket   docs/tickets.md v4 规范:目标/方案/路径/验证目标/验证形式/回报物(done body 模板);B 表票内预填
4 dispatch bin/dispatch-ticket <LK-ID> --repo R --terminal T   # 读票+组契约+send+ledger 一体
5 ack      MSGBR 回调 → ledger event(progress) + node running(+ 候选: 刷 fleet lastSeenAt)
6 done     核验报告文件与 done body 一致 → bin/verify-report(待建)抽查 ≥2 项 B 证据(重跑单测/grep 用例)
           → ledger review pass|fail|rework → tickets.md 票打 ☑/打回(-R1 新 ref)
7 wave     下一波;波次批准时全部票先建 ledger pending 节点(消 ticket↔ledger 双账)
8 checkpoint 回合收尾:bin/wave-checkpoint --wave <W> --notes "..." → state/wave-checkpoints.jsonl
           单行 JSON {round,ts,wave,tickets:[{id,state}],git:{head},env:{dais,orca},notes};
           原子追加(O_APPEND+单 write+fsync);round 从上一行读(首行=1);跳号仅 WARN 不阻断
```

## 断点续传(OF-007,新编排者会话重建波次视图)

```bash
bin/wave-checkpoint --tail 1
bin/wave-checkpoint --tail 1 | jq '{round, wave, head: .git.head, tickets: [.tickets[] | {(.id): .state}] | add}'
```

末 1 行即含 id/state/git head 三字段,可直接重建波次视图;文件不存在 → stderr 提示 exit 1
(视为新编排域,首条 round=1)。tickets 面读 `MAESTRO_LEDGER` 指向库,无 tickets 表旧库 → 空集容错(OF-005 同模式)。

## 控制消息两段式(OF-003,编排环契约增量)

> steer 面的细化契约(OF-002 闸放行之后的收方义务);派发任务的 ack/done 契约(第 5 步)不变。

```
控制消息两段式(two-phase steer,OF-003):
steer 发出后,收方回合首动作 = `session-send <self> <from> ack <ref> 'steer-accepted'`(已读将执行)
或 `session-send <self> <from> nack <ref> 'busy:queued'`(正忙: 消息保留、入列,下回合首处理)。
nack busy 语义钉死 = 不丢不重: 消息由收方回合队列持有,下回合首先处理;同 msgid(OF-001 信封)
重复投递由 bin/msg-dedup 在去重窗口拦截(exit 3),收方零重复执行。类型复用现有 ack/nack,不新增。
无契约旧 peer: 发送方零阻塞——不等待 ack/nack,发送即返回;未回 ack 不构成失败,不重发、不升级,
沿用"机械核查为仲裁"原则(回调逾期才触发人工核查)。
```

补充: ①收方 `<self>`/`<from>` 用 fleet 短码或完整 sessionId 皆可(session-send 双兼容);
②steer 本身受 OF-002 属主租约闸保护——非属主 steer 在**发送侧**即被拒(exit 4 +
fleet-conflicts.jsonl 落冲突行),两段式契约只处理"闸已放行"的消息;
③派发模板(bin/dispatch-ticket 生成的 prompt 头部)自动携带本契约。

## Artifact 路径表

| 物 | 路径 | 所有者 |
|---|---|---|
| 票 | `<repo>/docs/tickets.md` | **编排者(agent 只读)** |
| 回报 | `<repo>/docs/reports/LK-00X-report.md`(脚手架 `TEMPLATE.md`) | worker(F 节留空) |
| 契约模板 | `~/.dsh/maestro/templates/dispatch-preamble.md` | 编排者 |
| 舰队 | `~/.dsh/maestro/fleet.json` | 编排者 |
| 账本 | `~/.dsh/maestro/ledger.db`(助手 `bin/ledger`) | 编排者 |
| 签名 | `~/.dsh/maestro/bridge/orch.signature`(arm 时更新) | 编排者 |

## 已证机制(keep)

- 一探三验 probe 两次一次过(cold omp 两台);
- ack/done 契约嵌入派发首行 → MSGBR 原生回调驱动回合,零轮询;
- ledger 生命周期 dispatched→running(ack)→done→reviewed;
- 票 v4 三件套(验证目标/验证形式/回报物)+ G1–G4 + 报告模板 + F 审查节。

## 机制债(迭代队列)

| # | 债 | 状态 |
|---|---|---|
| 1 | bin/ledger 替代手 SQL | ✅ 2026-08-17 |
| 2 | bin/dispatch-ticket 派发一体化 | ✅ 2026-08-17 |
| 3 | orch.signature 持久化 + fleet-probe 回退读文件 | ✅ 2026-08-17 |
| 4 | bin/verify-report 审查半自动化 | ✅ 2026-08-17 SI-001 reviewed-pass(19 selftest + dogfood 实证) |
| 5 | 波次批准→全票 ledger pending(消双账) | ✅ 2026-08-17 首例(Wave 1 批准时) |
| 6 | ack/done 回调顺带刷 fleet lastSeenAt | ✅ 2026-08-17 fleet-touch(7 selftest + 真实首写,termid/code 双路径) |
| 7 | terminal_handle_stale 剧本:fleet 条目置 stale + 替换 handle 重 probe,禁双发 | ⏳ 首次遇到时落笔 |
| 8 | 监督回路唤醒源纪律:goal 自动轮≠巡检 ticker(2026-08-22 回归:cockpit-slow 监督逐轮 busy-poll → 用户纠偏 → 本文件固化条款) | ✅ 2026-08-22 |

## 监督回路唤醒源纪律(2026-08-22 固化,机制债 #8)

> 回归教训: 给监督派发武装 goal 自动轮 → 每轮一个前台回合 → 每回合顺手一遍巡检
> (terminal list + job_output + progress 事件)= 从回调驱动退化成逐轮 busy-poll。
> 派发侧"零轮询"(第 33 行)早已固化,缺的是**编排者自身唤醒源**条款 —— 本节补上。

监督派发(从派出到 done/ask 收口)只允许以下唤醒源,其余时间零主动读终端:

| 唤醒源 | 用途 | 说明 |
|---|---|---|
| MSGBR/ORCA-CB 回调(ack/done/ask) | **主通道** | 契约已嵌入派发首行,原生驱动回合 |
| 单发看门狗后台作业(`terminal wait --for tui-idle`) | 兜底"忘发 done" | 只在触发通知时动;触发后按需重装载(阶段间隙会误触发,重装载而非升级) |
| 白名单巡检触发 | 机械核验 | 仅四种: 用户问 / 回调到 / 看门狗触发 / 回调逾期 ~10min(握手规则 4 的机械核验) |

**禁止**: `create_goal` 给监督派发武装自动轮 —— goal_rounds 会变成巡检 ticker;
已武装的在下一回合立即 `update_goal pause`。goal 仅用于: 无回调通道的裸任务、
或用户点名要自动续跑的长目标。

**ledger 事件纪律**: 只落真信号(dispatched / ack / done / ask / 带产物证据的阶段迁移,
如"排查转入修复,工作区出现 model.rs 改动"),不落逐轮 progress 噪音。

## relay→watchd 迁移指南(OF-006,2026-08-23)

> relay 的"轮询文件→回报事件"职责已泛化为 `bin/event-watchd`(回合制外常驻守护,
> 治 D-09:VO-007 挂死 2h 零告警 + relay 固定寿命手工 re-arm)。本票分期:①文件面+②进程面
> 已可用;③SLA 面(patch 位=OF-005)/④租约面(patch 位=OF-002)留位 NotImplemented。

迁移三步(relay 面改 watchd,零代码):

1. **文件面平移**:relay 现行 glob 面改写成 watch.json 的 `faces.file` 条目
   (`{"name": "<旧 relay 名>", "glob": "<同一路径>"}`);首轮基线不报、位点推进、
   同内容重放零回声——语义与 OF-001 base 推进同源,旧 relay 的回报幂等口径不变。
2. **值守投递**:`notify: "session-send"` + `owner: {from: "watchd", "to": "<orch 码>"}`,
   事件即 DSHMSG report(信封 v2,自带 msgid 可去重);投递失败(owner 失联)自动升级
   `state/alerts.log` 落行——替代 relay 的"回报失败无人知"。
3. **起停**:`nohup ~/.dsh/maestro/bin/event-watchd --config watch.json &`;
   单实例 flock(后起 exit 3);SIGTERM/SIGINT 优雅退出;`--max-rounds N` 到期边界
   有活动(事件/存活目标)自续期,替代 60 轮寿命手工 re-arm。

进程面可直接新增(无需等 relay):worker/pytest 级长任务给 `faces.process` 条目
(pid 或 pattern + cpu_max + stale_min + log 路径),低 CPU 且日志陈旧双条件命中
→ process-hung 事件直达 owner(单条件不误报)。

自测:`python3 tests/of006-selftest.py`(27 项,全 temp 域零真实投递)。

## host 重启后通信恢复三步(2026-08-26 增;缺此步 = 全 fleet 回调断路)

:3080 重启(systemd restart / 崩溃 / 机器重启)会**杀死全部在册桥消费者**
(`bridge/registry.json` 各条目的 pid 全变死)。重启后各 lane 编排会话不 re-arm,
worker 的 ack/done 全部死信(`unknown-addressee` / `wake failed session-not-found`)。
恢复三步:

1. **re-arm**: 编排会话回合内调 `bridge_arm`(callback-bridge v4),或 lane 的常驻面
   `POST /register {"sessionId","alias"}`(host lane 口 = `bridge/http.port`);
2. **清死条目**: 程序化取 key(`registry.json` consumers 里 `kill -0 pid` 失败的)
   → `POST /unregister {"sessionId"}`。**注意: unregister 对错 key 也回 `ok:true`**
   (静默 no-op),必须复读 registry 确认已删;手抄 sessionId 必错,用脚本取;
3. **验活**: `cb-send ping <self> <alias>@<sessionId> <ref> 're-arm probe'`,回音到
   且 `dead.log` 零新增才算通。

判据速查: `bridge/state.json` 是 host 泵状态;`registry.json` 是唯一路由表(file-router
逐行重读,外部清理即时生效);`dead.log` 每行带 reason,是排障第一入口。

## 纪律

- 自迭代路径分治(坑六):bin/skills 先 .dsh,验收后 sync maestro-preset,**合入待用户定**;
- 派发不双发(stale handle 只用替换);worker 慢≠失败,15–60 分钟常态;
- 打回必新 ref(`LK-00X-R1`),F 节留痕;报告不合模板 = 未完成。
