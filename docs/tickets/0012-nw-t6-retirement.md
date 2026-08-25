# 0012 — T6 · P4 退役与部署面: 双插件退役、callback-bridge v4 上位、全链部署与回滚演练

> 状态: DISPATCHED

## 依据

评审报告 `docs/reports/nw-plan-review-report.md`: R-B08(v4 代差: 分槽/file-only/types/sig-退役)、R-B09(§6D pump 改造降级+core re-export)、R-B10(回滚不触达三部署面)、R-B11(bridge_http_status 别名+persona/文档同步)、R-B12(queen-v1 决策)、R-B13(polyfill lane ENOENT)、R-S14(sig 清理)、R-S26(v4 行 YAML+差异表)、R-S30(投递栈拓扑)、R-S05/E-S05(冒烟与 24h 可观测判据)、R-S16/R-S17(顺带裁决)。spec 节: 修订方案 §4-P4(P4.0~P4.10,全文见 `docs/reports/.nw-spec-raw-P4.md`)。

## 目标

在 T3/T4/T5 全验收后的窄腰终态上,完成 P4 退役与部署: orca-callback/message-bridge 双插件退役,callback-bridge v4(分槽修复+file 单 source+core re-export 窄腰库)上位为会话内兼容层,host lane 确立为常驻唯一 HTTP 持有者;PORT-R1 整体退役;dev-sync 增 `_narrow-waist` 同步;persona/全文档同步;queen-v1 显式冻结;全部变更收敛单提交,沙箱先演练正向部署+回滚,再于安静窗口执行生产切换,五路径冒烟+24h 可判定观测收口。

## 交付物(文件级清单)

1. `plugins/callback-bridge/index.js` — 分槽改造(state→slots Map、armAll per-slot 实例化、bridge_arm 按 initiator 取槽、bridge_status 列槽、teardown 逐槽)+ 注册 `bridge_http_status` deprecated 别名 + version → `4.1.0`。
2. `plugins/callback-bridge/sources/http.js` — types 缺省改 6 值 `['ack','done','ask','report','ping','status']`(潜伏面加固,生产不启用)。
3. `plugins/callback-bridge/core/{addressing,dedup,registry,store}.js` — 四文件整体替换为 `_narrow-waist` re-export(原导出名/签名逐字保留)。
4. `plugins/callback-bridge/{config,file-inbox,http}.test.mjs` — 既有断言零改动;新增: 双 slot 用例、单 source config 解析用例、types 6 值用例、别名用例、双槽并发 registerSelf 压测。
5. `agent.cordis.yml` — 删 orca-callback/message-bridge 两块(含注释),按 spec P4.7 逐字增 callback-bridge v4 块;persona L100 按 P4.5 原文改写。
6. 删除目录 `plugins/orca-callback/`、`plugins/message-bridge/`(git rm)。
7. `bin/cb-send` — 删 sig 比对段(~L36-43),头注释 PORT-R1 段改写;`tests/test_cb_send.sh` 改例(sig 存在不拦截)。
8. `bin/dev-sync.sh` — polyfill 段增 `_narrow-waist` 拷贝;`--verify` 增第四段 polyfill lane drift;清零口径改"全部段清零"。
9. 文档同步(P4.5 清单 14 处): `README.md:147`、`USAGE.md:37/54/79/128/201`、`docs/orch-loop.md:9`、`docs/comm-architecture.md:15,87`、`docs/handoff-orch-gen2.md:6,20`、`skills/orca-bridge/SKILL.md:16,66-67`、`shared/maestro-bridge/SKILL.md:41`、`plugins/host-callback-bridge/README.md:36`、`docs/callback-bridge-design.md:174,195`(别名计时起点+P4 已执行标注)。
10. 新增 `tests/p4-smoke.sh`(五路径冒烟,OF-005 模式)与 `tests/p4-watch.sh`(24h 基线采集/比对)。
11. 方案文本: `docs/narrow-waist-implementation-plan.md` §4-P4/§6D/§1 按 P4.0~P4.10 落笔(含拓扑声明、queen 冻结小节、AGENT_CARD 降级句)。
12. 部署记录: `docs/reports/` 下 P4 部署与回滚演练记录(pre-flight 输出、--verify 输出、冒烟与 24h 断言输出)。

## 验收断言(可执行)

1. `node --test plugins/callback-bridge/` 全绿,且既有三份单测无断言改动(git diff 仅增例)。
2. 双 slot: 会话 A arm→B arm→投 A 签名,A 收回合 B 不收;A 重 arm 换别名回执更新、B 槽不动。
3. `normalizeConfig(P4.7 config).sources` 恰 1 条 file-inbox;arm 后 `~/.dsh/maestro/bridge/http.port` mtime 不变。
4. `grep -rn "bridge_http_status" --exclude-dir=reports --exclude-dir=tickets .` 指令面(persona/USAGE/README/orch-loop/comm-architecture/handoff/skills)零命中;别名调用回执含 `[deprecated]` 且零监听创建。
5. `test ! -f ~/.dsh/maestro/bridge/http.port.sig`;人为重建 sig 后定向 cb-send 仍走 HTTP。
6. dev-sync 后: `diff -rq plugins/_narrow-waist ~/.dsh/plugins/_narrow-waist` 清零;`--verify` 全部段清零;装点 import host-callback-bridge 不抛 ENOENT。
7. P4 前后 `agent-presets/queen-v1/` 零 diff;部署记录含 pre-flight(registry 快照+端口持有进程)。
8. 沙箱演练: 正向部署→五路径冒烟全绿→回滚五步→装点 cordis 复含旧两行、无 v4 行→冒烟复验全绿。
9. 生产: 安静窗口单提交部署后 `tests/p4-smoke.sh` 全绿;24h 后 `tests/p4-watch.sh check` 退出码 0(dead.log 零新增 / counters.failed==基线 / router-journal 无 failed)。
10. P4 单提交恰一个(`git log --grep nw-P4 --oneline | wc -l` == 1),diff 无 AGENT_CARD 文件。

## 依赖与顺序

- 前置: T3/T4/T5 全部 done 且验收断言全绿(窄腰库 P1 终版已合入并含 registry v3.6 写链语义、adapter 面与对拍已验收)——P4 的 core/ re-export 依赖库终版 API。
- 本票内部顺序: 仓内实施(交付物 1-11)→ 单提交 → 沙箱演练(正向+回滚)→ cb-send ask 请示安静窗口 → 生产切换(P4.3 部署链①-⑤)→ 冒烟+24h 观测 → done。
- 与 P5 零耦合(dais 轴),窗口错开。

## 回报契约

开工第一动作: ~/.dsh/maestro/bin/cb-send ack impl@omp nw-planner@orca-main nw-T6 'turn started';完成后(≤300字摘要): cb-send done impl@omp nw-planner@orca-main nw-T6 '<结论;产物路径;剩余>';被阻塞: cb-send ask。done 只发一次。

## 工作目录注记

仓 = /home/yy/tools/maestro-preset-iter(master 的 linked worktree);产物一律写该 worktree;不碰 /home/yy/tools/maestro-preset 主检出,不动生产 ~/.dsh。

## 工作说明

1. 开工先读: spec P4 节(`docs/reports/.nw-spec-raw-P4.md`)、评审报告 R-B08~R-B13/R-S14/R-S26/R-S30、`docs/tickets/0003/0005`(事故语义)、USAGE §3.3/§3.4。
2. 仓内实施按交付物清单;v4 分槽对照 pump.js slots 语义(勿自创);core/ re-export 保持原导出名与签名,兼容性以"既有单测零改动全绿"为准。
3. 全部改动收敛为**一个** commit(标记 `nw-P4`);commit 前跑全量单测 + `tests/test_cb_send.sh`。
4. 沙箱演练(不动生产): 以 `DSH_HOME=$(mktemp -d)` + `/home/yy/tools/dsh-comm-sandbox/run.sh` 模式起隔离面,完整走 P4.3 正向部署链①-⑥ 与回滚五步①-⑤,采齐验收断言 6/8 的输出入部署记录。生产 `~/.dsh` 在演练段零接触。
5. 生产切换前 `cb-send ask` 请示安静窗口(条件: 无在飞编排派发、无 queen armed 会话——pre-flight: registry.json 条目快照 + `ss -tlnp` 确认 http.port 持有者为 host 进程);获准后按 P4.3 执行,含删除 `http.port.sig`。
6. 冒烟用五路径脚本;24h 观测期内在 dead.log/counters/router-journal 任一断言破线时,先按 P4.3 回滚五步止血再排查,不等观测期满。
7. 遇规格与现场不符(行号漂移按锚函数定位;语义冲突): cb-send ask,勿自行改规格。
