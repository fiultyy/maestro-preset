# orch-loop — terminal-send + cb-send 派发闭环约定(gen3 增量,2026-08-17)

> 与 handoff-orch-gen2.md 互补:gen2 是 zap 时代 orca-run 形态;本文是 **terminal-send 直派 + 桥回调** 形态,
> 首次全链实证于 dsh-lark 项目(2026-08-17,larkbiz-001 派发 + v4 票制)。

## 全链(七步)

```
1 arm      bridge_arm{alias} + bridge_http_status;签名落笔 maestro/bridge/orch.signature
2 probe    fleet-probe <termid>(自动读 orch.signature)→ 回调回合验证 from==termid → fleet verified + ledger p2p 节点
3 ticket   docs/tickets.md v4 规范:目标/方案/路径/验证目标/验证形式/回报物(done body 模板);B 表票内预填
4 dispatch bin/dispatch-ticket <LK-ID> --repo R --terminal T   # 读票+组契约+send+ledger 一体
5 ack      MSGBR 回调 → ledger event(progress) + node running(+ 候选: 刷 fleet lastSeenAt)
6 done     核验报告文件与 done body 一致 → bin/verify-report(待建)抽查 ≥2 项 B 证据(重跑单测/grep 用例)
           → ledger review pass|fail|rework → tickets.md 票打 ☑/打回(-R1 新 ref)
7 wave     下一波;波次批准时全部票先建 ledger pending 节点(消 ticket↔ledger 双账)
```

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

## 纪律

- 自迭代路径分治(坑六):bin/skills 先 .dsh,验收后 sync maestro-preset,**合入待用户定**;
- 派发不双发(stale handle 只用替换);worker 慢≠失败,15–60 分钟常态;
- 打回必新 ref(`LK-00X-R1`),F 节留痕;报告不合模板 = 未完成。
