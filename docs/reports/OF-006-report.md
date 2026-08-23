# OF-006 报告 · relay 泛化为事件守护 event-watchd(W6 · B 组 · 分期:①②面落地,③④留位)

> 2026-08-23 · 规范:`docs/kg/09-orch-hardening-plan.md` §1 OG 门 + §4 OF-006 · cwd:`~/.dsh/maestro`
> 测试:`python3 tests/of006-selftest.py` → **27/27 全绿,exit 0**
> 分期裁决:本票=①文件落地面 + ②进程活性面;③SLA(patch 位 OF-005)/④租约(patch 位 OF-002)
> 两面留接口+NotImplemented 提示,不实现不崩溃——票面任务书明确。

## 0. 变更清单(全部在票面文件域 `bin-watchd`+`doc-maestro` 内)

| 文件 | 性质 | 内容 |
|---|---|---|
| `bin/event-watchd` | 新 | 回合制外常驻守护(常驻循环/`--once` 单轮两模式)。`--config watch.json` 声明式四看守面:①文件面(glob→事件;首轮基线不报,新文件=file-landed、增长=file-grew 字节位点;事件后位点推进,同内容重放零回声——OF-001 base 语义同源)②进程面(存活+CPU 生命周期均值≤cpu_max+日志 mtime 陈旧≥stale_min 双条件与判定,单条件不触发;连续挂死 latch 只报一次,条件解除复位;僵尸/缺席进程不判定)③④留位(逐项 WATCHD-STUB NotImplemented,不进事件流不投递)。事件出口 stdout / session-send(DSHMSG report,信封 v2 自带 msgid);自续期(--max-rounds 到期边界有活动[事件/存活目标]→WATCHD-RENEW 顺延,无活动→WATCHD-EXIT 退场,D-09 ②);owner 失联→`state/alerts.log` 落单行 JSON(升级终点,不做递归监督);单实例 flock(exit 3 打印持有者);SIGTERM/SIGINT 优雅退出(≤0.5s 打断分片 sleep,位点落盘 tmp+rename 原子) |
| `state/watch/`、`state/alerts.log` | 新(运行时) | 位点/latch state 与告警面;`state/` 与 `*.log` 均已 gitignore |
| `orch-loop.md` | 改 | 新增「relay→watchd 迁移指南」节:文件面平移三步(glob 改 config/notify owner/nohup 起停)+进程面直接新增说明 |
| `tests/of006-selftest.py` | 新 | 覆盖任务书①②⑤+③④留位+自续期+owner 失联;全 temp 域(state/alerts/config/fleet),DSHMSG 仅投 stub HTTP server 或死端口,零真实 sessionId,守护目标=测试 Popen 的 sleep/合成进程 |
| `reports/OF-006-report.md` | 新 | 本报告 |

红线遵守:未 git commit/push;未碰 session-send/fleet-touch/ledger/wave-checkpoint(仅调用 session-send,
且经 MAESTRO_FLEET=temp 副本指向 stub/死端口);未监视任何真实在飞 worker/relay/GM 会话(守护目标全为合成进程);
未启动真实常驻实例(测试内常驻均 SIGTERM 收口,无残留)。

实现要点(踩坑记录):
- 僵尸陷阱:被杀目标进程在父进程未收尸前 /proc 仍在 → "存活"误判致自续期永续;已加 /proc stat 状态判定(Z/X=死)。
- 事件类型固定 file-landed/file-grew:per-watch 自定义类型名会让增长事件被误标,弃用,类型即协议。

## A. selftest 输出原文

```

① 文件面(基线/落地/零回声/增长 + DSHMSG 达 owner 含 msgid):
  [PASS] 首轮基线:无事件
  [PASS] 新文件 → file-landed 事件
  [PASS] 同内容重放 → 零回声(位点已推进)
  [PASS] 文件增长 → file-grew 事件(字节位点)
  [PASS] state 位点推进=当前文件大小 — state={'/tmp/of006-ns1505i6/ev/seed.jsonl': 8, '/tmp/of006-ns1505i6/ev/new.jsonl': 16}
  [PASS] send 模式首轮基线投递 0 条
  [PASS] 事件经 session-send DSHMSG 达 owner(1 条) — n=1
  [PASS] 信封含 msgid(uuid4 形制,可去重)
  [PASS] 信封路由正确 from=watchd to=orch1 type=report

② 进程面(低 CPU+旧 mtime 双条件命中;单条件不误报;latch;缺席不崩):
  [PASS] 双条件命中 → process-hung(仅 dual) — ['WATCHD-EVENT process-hung watch=dual face=process pid=1766426 cpu=0.00%<=5.0% log_age=30m>=10.0m (dual-condition hit)']
  [PASS] 单条件A(低CPU+新日志)不误报
  [PASS] 单条件B(高CPU+旧日志)不误报
  [PASS] 进程缺席不判定不崩溃
  [PASS] 连续挂死 latch 只报一次(重放无事件)
  [PASS] 条件解除 → latch 复位不再报

③④ 留位(sla/lease → NotImplemented 提示,不崩溃不投递):
  [PASS] sla/lease → WATCHD-STUB NotImplemented ×2
  [PASS] 留位不投递 DSHMSG(stub 零记录)

⑤ 单实例锁 + SIGTERM 优雅退出(无残留进程/锁):
  [PASS] 常驻实例持锁时后起 --once → exit 3 + 打印持有者 — rc=3
  [PASS] SIGTERM → 优雅退出 WATCHD-SHUTDOWN exit 0 — rc=0
  [PASS] 无残留进程(poll 与 rc 一致=已收尸)
  [PASS] 锁随进程退出自动释放(随后 --once 正常)

★ 自续期(D-09 ②):max_rounds 边界有活动→顺延;无活动→退场:
  [PASS] 存活目标 → 到期边界 WATCHD-RENEW 顺延 — poll=None
  [PASS] 活动消失 → WATCHD-EXIT 退场(非杀) — rc=0
  [PASS] 退场后无残留

★ owner 失联升级终点(投递失败 → alerts.log):
  [PASS] 投递失败 → WATCHD-WARN + daemon 不崩(rc 0)
  [PASS] alerts.log 落单行 JSON 告警(≥1 行) — n=1
  [PASS] 告警行含 ts/event/error=owner unreachable

OF-006 selftest: 27/27 全绿
```
## B. 验收逐条对账(规范 §4 OF-006 验收;任务书编号↔规范编号双视图)

| 任务书# | 规范验收# | 验收项 | 结果 | 证据 |
|---|---|---|---|---|
| ① | 验收①(文件面部分) | 合成场景触发且 DSHMSG 达 owner(msgid 可去重) | ✅ | A 节 ① 组 9 检查:基线不报→落地事件→零回声→增长事件+位点=文件大小;stub fleet 收到 1 条 DSHMSG report,信封含 uuid4 形制 msgid、from=watchd/to=orch1 路由正确 |
| ② | 验收② | 挂死判定:假进程低 CPU+旧 mtime 双条件命中;单条件不误报 | ✅ | A 节 ② 组 6 检查:sleep 假进程 cpu=0.00%≤5% + log_age=30m≥10m → process-hung(仅 dual);单条件A(低CPU新日志)/单条件B(高CPU旧日志)零事件;latch 重放只报一次;条件解除复位 |
| ③④ | 验收①(SLA/租约面部分) | 留位 patch:接口+NotImplemented 提示 | ✅ 留位 | A 节 ③④ 组 2 检查:WATCHD-STUB NotImplemented ×2、exit 0 不崩溃、不投递 DSHMSG;patch 位文档化(③=OF-005 tickets ttl,④=OF-002 fleet lease) |
| ⑤ | 验收④ | 单实例锁(flock)+ SIGTERM 优雅退出无残留 | ✅ | A 节 ⑤ 组 4 检查:常驻持锁时后起 --once exit 3+打印持有者 pid;SIGTERM→WATCHD-SHUTDOWN exit 0;进程收尸;锁随退出释放 |
| — | 验收③(本票 adapted) | 自续期:①②有活动票→寿命顺延(规范原文=在飞票续期,SLA 面 deferred 故按任务书以①②活动为据) | ✅ | A 节 ★ 组 3 检查:存活目标→WATCHD-RENEW;活动消失→WATCHD-EXIT reason=max-rounds-reached exit 0;无残留 |
| — | 验收⑤ | owner 失联场景 alerts.log 落行 | ✅ | A 节 ★ 组 3 检查:死端口 fleet 投递失败→WATCHD-WARN+daemon 不崩;alerts.log 单行 JSON 含 ts/event/error=owner unreachable |

### 后续

- ③SLA 面 patch:OF-005 tickets DAG 合入后补(消费 dispatched/running 超 ttl → 事件);④租约面:OF-002 数据即绪,随 ③ 一并 patch。
- live 值守(规范"验证形式"的 live 半边):留 GM 窗口对一轮真票起常驻实例验证——本票按红线未起真实值守。
- 台账 D-09 ①②面(主体解)待 GM 回写 `docs/kg/08-defects-ledger.md`(OG4)。

## A2. 复验(2026-08-23 GM 跟进后,连续两跑)

GM 并发复跑曾见 process 面 FAIL×3(双条件命中/单条件B误报/RENEW 边界)。定位=测试载荷敏感,
非 daemon 缺陷,两处加固:
- 加固 a) 单条件B spinner 阈值改动态(实测 lifetime CPU 一半):满载并发复跑时 spinner 可被饿
  到 <50%,固定阈值既误报单条件B又连带双条件计数=2;
- 加固 b) RENEW 边界由固定 sleep 1.0s 改轮询(≤5s):满载下 daemon 轮次变慢会错过固定窗口。

加固后本地连续两跑均 **27/27 全绿,exit 0,零残留 daemon**:

```
RUN 1: OF-006 selftest: 27/27 全绿(exit 0)
RUN 2: [info] spinner lifetime cpu=96.4% → 动态阈值 cpu_max=48.18%
       OF-006 selftest: 27/27 全绿(exit 0)
```

(完整输出见 tests/of006-selftest.py 现场重跑;A 节原文为首轮全绿存档,检查项与复验完全一致。)

done body:复验全绿;报告:reports/OF-006-report.md;测试:27全绿×2连跑;台账:D-09①② 待GM回写;备注:并发复跑载荷敏感已加固;③④留位
