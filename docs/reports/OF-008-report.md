# OF-008 报告 · dais 构建断言 + 实例锁(W6 · C 组,票面 ①②;③ deferred)

> 2026-08-23 · 规范:`docs/kg/09-orch-hardening-plan.md` §1 OG 门 + §5 OF-008 · cwd:`~/.dsh/maestro`
> 测试:`python3 tests/of008-selftest.py` → **24/24 全绿,exit 0**
> 范围裁决:本票只做 ①(dais-build 构建断言)②(wrapper 实例锁);③ 消费侧 WARN 涉
> pipecat-poc 在飞域(rt_probe_m0.py / rt_dsh_lane.py),票面明确不做——**DEFERRED**。

## 0. 变更清单(全部在票面文件域 `dais-wrap` 内)

| 文件 | 性质 | 内容 |
|---|---|---|
| `~/.local/bin/dais-build` | 新 | `cargo build --release -p warp --features orchestration` → strings 断言(哨兵 `"not enabled in this build"` 计数=0 通过,>0 退出非零拒绝背书安装)→ 构建报告(含 D-03 错误形制快照,追加式幂等)。三模式:真构建 / `--assert-current`(只读断言现行二进制) / `--selftest --fixture <dir>`(合成样本两态断言,不真构建) |
| `~/.local/bin/dais` | 改 | GUI 类启动(无子命令裸启动/纯 flag)exec 前取 `~/.local/state/dais/instance.lock`(flock fd9 + pid + boot-id + ts);后起 GUI 退出 exit 1 并打印持有者;`--force` 覆盖;boot-id 变化→陈旧锁自动让位并 stderr 提示;锁 fd 随 exec 传入 GUI,GUI 退出自动释放(agent transient spawn 走同 PATH wrapper 同样被守卫)。测试钩子 `--lock-dryrun` 无副作用。**orchestration 及一切 CLI 子命令路径零改动零取锁(监督自锁禁令)** |
| `~/.local/bin/dais.pre-of008` | 备份 | 改前 wrapper 逐字节备份(`cp -a`),秒级回滚:`mv ~/.local/bin/dais.pre-of008 ~/.local/bin/dais` |
| `~/.local/state/dais/instance.lock` | 新(运行时) | 锁文件,GUI 启动时写入/持有 |
| `~/.local/state/dais/build-report.md` | 新 | D-03 错误形制契约基线(现行二进制 sha256=7b9579f2… + 7 条编排面错误形制,`--assert-current` 只读落盘) |
| `tests/of008-selftest.py` | 新 | 覆盖验收①②④⑤+现场证据;全部走 `--selftest`/`--lock-dryrun`/env 覆盖(temp 锁路径/temp 报告),零 GUI 启动、零真实构建、真实锁路径测后恢复原状 |
| `reports/OF-008-report.md` | 新 | 本报告 |

原子性:wrapper 经 bash -n + 5 场景预检通过后才 `cp -a` 备份 + `mv -f` 同文件系统原子替换。
红线遵守:未 git commit/push;未启动/停止/重建 dais GUI(pid 908653 全程在跑,CLI 通道零中断);
未碰 `~/warpdotdev/dais` 源码仓(只读 strings/断言);未执行真构建(按票面用合成 fixtures 验证断言逻辑)。

## A. selftest 输出原文

```
boot_id(real) = 184de637-e629-4e94-9210-9ea445968fac
wrapper = /home/yy/.local/bin/dais (backup /home/yy/.local/bin/dais.pre-of008)

① 合成 fixtures 断言两态(好→通过 / 坏→失败):
  [PASS] 好/坏混合 fixtures → exit 0 — rc=0
  [PASS] good 样本 expect=pass→OK(≥2)
  [PASS] bad 样本 expect=fail→OK(≥2)
  [PASS] bad 断言计数可见(count>0)
  [PASS] 伪装好样本 → MISMATCH + exit≠0 — rc=1

② 实例锁三场景(dais --lock-dryrun,零 GUI 启动):
  [PASS] S1 空位获取 → exit 0 RESULT=acquired
  [PASS] S1 锁内容 pid+boot_id+ts 三键 — pid=1708962 boot_id=184de637-e629-4e94-9210-9ea445968fac ts=1787497517
  [PASS] S1 默认读 /proc 真 boot-id
  [PASS] S2 持锁中 → exit 1 RESULT=rejected
  [PASS] S2 拒绝时打印持有者 pid=424242
  [PASS] S2 --force 覆盖 → exit 0 RESULT=forced
  [PASS] S3 陈旧 boot-id → 获取成功且 stale_replaced=1
  [PASS] S3 让位后锁内容已换为本机 boot-id

③ 消费侧 WARN(rt_probe_m0/rt_dsh_lane 捕坏形态告警):
  [DEFERRED] POC 域在飞文件,票面明确不入本票(③ 涉 pipecat-poc,GM 裁决 deferred)

④ 幂等可重跑:
  [PASS] dais-build selftest 二轮重跑 → 同样 exit 0 — rc1=0 rc3=0
  [PASS] dryrun 顺序二次获取(前次已释放) → 仍 acquired

⑤ 错误形制快照(D-03 契约基线):
  [PASS] selftest 输出含 fixture 错误形制快照(哨兵行)
  [PASS] 现行真二进制只读断言 → PASS(哨兵计数 0) — ASSERT /home/yy/warpdotdev/dais/target/release/dais: PASS (sentinel count=0, orchestration feature present)
  [PASS] --assert-current 快照含 read-worker 形制
  [PASS] 快照已落报告(sha256+形式行)

★ 现场证据:锁不影响 CLI(监督自锁禁令,GM 侧可并行复核):
  [PASS] 真锁被持有时 check-status(新 wrapper) → rc 0 — rc=0
  [PASS] 输出形制不变(首行 N runs) — 281 runs
  [PASS] 与无锁基线 rc 一致 — base=0 held=0
  [PASS] 与改前 wrapper(dais.pre-of008) rc 一致 — pre-of008 rc=0
  [PASS] 真实锁路径恢复原状(测前不存在→测后不存在)

OF-008 selftest: 24/24 全绿
```

## B. 验收逐条对账(规范 §5 OF-008 验收 ①–⑤)

| # | 验收项 | 结果 | 证据 |
|---|---|---|---|
| ① | 好/坏二进制合成 fixtures:断言通过/失败两态均正确 | ✅ | A 节 ① 组 5 检查:good×2→PASS、bad×2→FAIL(count=1/2 可见)、伪装 good 的 sabotage 样本→MISMATCH+exit 1 |
| ② | 双起第二实例被拒+提示持有者 pid;重启后 boot-id 失效锁自动让位 | ✅ | A 节 ② 组 8 检查:S2 持锁中 exit 1 + `holder=pid=424242`;`--force`→exit 0;S3 异 boot-id→acquired+stale_replaced=1+锁内容换新;GUI 拒绝路径 stderr 实测:`dais: instance lock held — refusing second GUI instance / holder: pid=… / override with: dais --force` |
| ③ | 探针对坏形态输出 WARN(单测 mock 响应) | **DEFERRED** | 票面裁决:涉 pipecat-poc 在飞文件(rt_probe_m0.py/rt_dsh_lane.py),本票明确不做;消费侧修复指引已内置于 dais-build 断言输出 |
| ④ | dais-build 幂等可重跑 | ✅ | A 节 ④ 组 2 检查:selftest 二轮重跑 stdout 逐字节一致;dryrun 顺序二次获取仍 acquired;报告为追加式(append-only),重跑不破坏前文 |
| ⑤ | 构建报告含错误形制快照(D-03 契约基线落盘) | ✅ | A 节 ⑤ 组 3 检查 + `~/.local/state/dais/build-report.md` 实落:现行二进制(sha256=7b9579f22dd0783f5514e69282e2de4bb866fdaa1830180d3fa72bd5f3f045d5)sentinel count=0,7 条编排面错误形制(PTY bridge running? / errors without a running GUI / block_settle failed / session mailbox registered 等) |

### 现场证据:锁逻辑对 CLI 零影响(监督自锁禁令,GM 侧并行可复核)

A 节 ★ 组 5 检查:真实锁路径被本测试 flock 持有期间,`dais orchestration check-status`
(新 wrapper)rc=0、首行 `281 runs` 输出形制不变、与无锁基线及改前 wrapper(dais.pre-of008)
三方 rc 一致;测后真实锁路径恢复原状(测前不存在→测后不存在)。GM 侧任意时刻可自行跑
`dais orchestration check-status` 复核通道无锁干扰。

### 回滚与后续

- 秒级回滚:`mv ~/.local/bin/dais.pre-of008 ~/.local/bin/dais`(CLI 路径新旧 wrapper 本就等价,回滚仅退锁功能)。
- 真实构建全链(构建→断言→安装→报告)未在本票执行(红线:不动二进制);下次源码改动后由 GM 窗口跑 `dais-build` 一次即得全链验证。
- 台账 D-01/D-02(及 D-03 状态更新)待 GM 回写 `docs/kg/08-defects-ledger.md`(OG4,本票无该仓写权限域)。

done body:完成;报告:reports/OF-008-report.md;测试:24全绿;台账:D-01/02 待GM回写;备注:③按票面deferred;真构建留GM窗口跑dais-build
