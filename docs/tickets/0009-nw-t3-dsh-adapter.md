# 0009 — nw-T3: P2 dsh adapter(session-send-v3)+ 双跑对拍全绿

> 状态: DISPATCHED
> 依据: 评审报告 R-B05(验收判据,采纳选项 a)/R-S04(steer 闸 entry-level 函数+`--via` 规则)/R-S29(appendJsonl 键序锁定)/R-S07(P2 纯新增,session-send 升 v3 钉死 P3)/R-S10(沙箱 :3081 支撑)/R-S18(downgrade 不用于出站);spec 节 = `docs/reports/.nw-spec-raw-P2.md`(P2.0-P2.6,本票的唯一权威规格)。

## 目标

P2 阶段交付 dsh 平面窄腰 adapter: 新增 `bin/session-send-v3`(调 `_narrow-waist` 库 serializeLine/createEnvelope/findFleetEntry/appendJsonl 投 `/api/session.prompt`,steer 闸保留应用层、语义逐字),与旧 `bin/session-send` 在沙箱 :3081 双跑,`tests/p2-a-b-test.sh` 按 OF-005 模式全绿——证明 v3 出站在 DSH 面与 v2 逐字段等价(判据 a)、steer 审计三件套双写一致、旧路零改动。

## 交付物(文件级清单)

1. `bin/session-send-v3` — 新增,Node 单文件,`#!/usr/bin/env node`,仅 `node:*` 依赖;实现按 spec P2.2/P2.4 全部条款(含库解析两级、`--msgid`/`--via` 解析、port 序=旧 bin 序、stderr/stdout/exit 码契约逐字)。
2. `tests/p2-a-b-test.sh` — 新增,可执行(`chmod +x`),按 spec P2.5: hermetic(M01-M21/K1-K7/G1-G8)+ live(L0/L1,L2 条件)。
3. 无其他文件改动(见"禁止")。

## 验收断言(可执行)

1. `bash tests/p2-a-b-test.sh` → exit 0,输出含 `p2-a-b-test: N/N 全绿(exit 0)`;断言集 = spec P2.5 清单逐条(M01-M21、K1-K7、G1-G8、L0-L1;L2 在 `P2_LIVE_SESSION` 提供时一并跑)。
2. `python3 tests/of002-selftest.py` → 全绿(当前基线 33/33;旧 bin 回归门槛)。跑前 `diff bin/session-send ~/.dsh/maestro/bin/session-send` 无差异;若镜像已漂移,记录差异、以仓内为准,**不修镜像**。
3. `git status --porcelain` 恰两个新增文件(`bin/session-send-v3`、`tests/p2-a-b-test.sh`);`git diff HEAD -- bin/session-send bin/cb-send tests/of002-selftest.py` 为空。
4. 连续重跑 `bash tests/p2-a-b-test.sh` 两次均全绿(幂等);两次运行后 `~/.dsh/maestro/bridge/`、`~/.dsh/maestro/state/`、`~/.dsh/maestro/fleet.json` mtime 与内容不变(零生产外溢,对齐 R-S31 精神)。
5. K3(非 UTF-8 argv 不对称)/K4(4KB 边界)/G1(stderr 逐字节相等,msgid 归一)/G7(双写行结构一致)四条关键断言单列可见于脚本输出。

## 依赖与顺序

- **依赖 T2**(P1 库 `plugins/_narrow-waist/`): `serializeLine`/`createEnvelope`/`forgeMsgid`/`findFleetEntry`/fleet 梯/`appendJsonl` 导出可用(spec P2.6 依赖面)。T2 未 done 前可先落脚本骨架与 stub 并写 M 系列比较器,断言联调以 T2 done 为前置;若 T2 实名与 P2.6 不同,仅改 import 名。
- 与 T4+(dais/orca/cb-send、退役、P5)无依赖,可并行。
- 内部顺序: adapter 骨架+库解析 → hermetic M/K → G(共享 temp fleet/state)→ live L。

## 回报契约

开工第一动作: ~/.dsh/maestro/bin/cb-send ack impl@omp nw-planner@orca-main nw-T3 'turn started';完成后(≤300字摘要): cb-send done impl@omp nw-planner@orca-main nw-T3 '<结论;产物路径;剩余>';被阻塞: cb-send ask。done 只发一次。

## 工作目录注记

仓 = /home/yy/tools/maestro-preset-iter(master 的 linked worktree);产物一律写该 worktree;不碰 /home/yy/tools/maestro-preset 主检出,不动生产 ~/.dsh。

## 工作说明

- **adapter**(spec P2.2/P2.4 逐条): stderr/stdout/exit 码契约逐字复刻(REFUSED 模板含 em dash、`session-send:` 前缀不改名、`unknown code '<key>'` 单引号、成功行 `accepted=True/False` 大写);steer 闸用库 `findFleetEntry`(prefix 模式),**不得**用 `resolveAddress` 路由结果替代;`to` 解析 P2 只启用 fleet 梯(registry/broadcast/agent:// 不启用);`--via` 规则见 P2.2 第 7 条(禁空串/禁空段/逗号拆分追加/自身 id 恒追加链尾);port 序 = `DSH_PORT ?? '3080'` → `fleet.port` 覆盖(旧 bin 序,非 loopback-sink 序);库解析两级(自身 realpath 相对 → `${DSH_HOME:-~/.dsh}/.agent-presets/maestro/plugins/_narrow-waist` 兜底)。
- **对拍脚本**(spec P2.5): stub.mjs 运行时生成、按 msgid 定位 wire;G 系列场景蓝本 = `tests/of002-selftest.py` ②③⑤(同款 fleet 构造/租约操作,可直接手写 fleet.json 的 owner+leaseExpiresAt,不必依赖 fleet-touch);conflicts/journal 落点 = temp fleet 目录与 temp MAESTRO_STATE。
- **沙箱**: live 层目标 127.0.0.1:3081(`/home/yy/tools/dsh-comm-sandbox/run.sh`;已在线,`ss -tln | grep 3081` 确认,不可达先起 run.sh)。L2 需要真实沙箱会话 id 时经 `P2_LIVE_SESSION` 传入(可在沙箱 GUI 开一个草稿会话);拿不到就跑 L0/L1,L2 计 skip 不失败。
- **禁止**: 改 `bin/session-send`/`bin/cb-send`/`tests/of002-selftest.py`;跑 `bin/dev-sync.sh`;注册/修改 agent.cordis.yml 或任何 patch yml;触生产 :3080 与 `~/.dsh`(沙箱目录 `/home/yy/tools/dsh-comm-sandbox` 除外——只读 run.sh/端口,L2 注入仅限沙箱草稿会话);引入 npm 依赖。
