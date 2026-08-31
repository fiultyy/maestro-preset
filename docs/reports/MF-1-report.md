# MF-1 报告 — 持票死视图接线（dispatch-ticket 派发三环 SOP）

**席位**: 9b8b · **日期**: 2026-08-31 · **状态**: 完成（待编排验收）

## 问题

pm-web 席位卡「持票(lease)」按票面 `lease_owner` 计数（app.js:184），但全台账 81 票仅 3 张手工挂过 lease；官方派发工具 `bin/dispatch-ticket` 落账只走 `ledger node+event`（grep lease=0），派发链路从不产生 lease → 持票视图恒 0（死视图）。

## 两套账关系与勾稽设计

- **node 账**（per-repo `projects/nodes/events`）：dispatch-ticket 既有落账路径，project 按 repo 路径解析，票号即 node_id；
- **tickets 票账**（`tickets` 表 = /op/tickets 数据面 = pm-web 持票计数唯一准绳）：与 node 账互不相通——LK-ID 派发走 node 账时票面无对应票（实测库内 `LK-*`=0），lease 无处可挂。

**勾稽**：派发即建票——票面无票先 `ticket add`（state=dispatched 与派发同刻，refs 带 terminal/worker/deliverable 溯源），再 `ticket lease <票> <worker>` 挂执行席位。以 /op/tickets 持票计数为准绳。

## 改动（红线内：bin/gates/docs；service.mjs 与 public/ 零改；未 push）

1. **bin/dispatch-ticket**：落账后第三环 `ticket_ledger()`（list 预检→无票 add→lease）；失败 WARN-continue 不回滚已发派发；重派幂等（lease 随执行席位迁移）；`--worker` 建议传 fleet 席位码才入席位卡计数。顺修 `ledger()` 建了 env 未传子进程的死代码。
2. **gates/mf-1-lease-gate.mjs**（新，16 断言）：A 静态接线+dry-run 契约不变+SOP 在册；B 真实库只读不变式「dispatched/running 全持票，豁免=显式白名单（无席位纯记录票），违例=0」；C HOME 重定向沙箱+mock orca 全链路功能证（三环落账/事件留痕/契约头/幂等）。
3. **docs/orch-fleet-conventions.md**：派发协议节补「落账三环 SOP」段（claim+state+lease）。

## 回归（④）

既有 10 门全绿：pm001-007(88+13) / pm008(18) / pm009(28) / pmw2-1-live(4) / pmw2-1(54) / pmw2-2(35) / pmw2-3(63) / pmw2-4(40) / pmw2-g(16) / pmw2-f(22)；新增 mf-1-lease-gate 16/16；of003-selftest 12/12；`bin/dev-sync.sh --verify` 五段清零。证据：`~/.dsh/maestro/logs/pm-host-service/gates/*/mf1-reg/`。

## 已知语义（不动，供裁量）

pm-web 持票计数不过滤票态——done 票 lease 未释放会持续计数；若要「在手持票」语义需 done 时 `--release` 或 UI 过滤活跃态，属后续票。
