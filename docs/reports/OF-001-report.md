# OF-001 报告 · DSHMSG 信封 v2:msgid + 收方去重(A.1,顺带 D-10)

> 2026-08-23 · 规范:`docs/kg/09-orch-hardening-plan.md` §3 OF-001 + §1 OG 门 · 域:`~/.dsh/maestro`
> 测试:`python3 tests/of001-selftest.py` → **25/25 全绿,exit 0**

## 0. 变更清单(全部在票面文件域内)

| 文件 | 性质 | 内容 |
|---|---|---|
| `bin/session-send` | 改 | 信封 v2:增 `msgid`(uuid4,`--msgid <id>` 可透传保号)与 `ts`(epoch ms);老 5 参调用输出/退出码逐字节兼容;零参 usage 仍 exit 2 |
| `bin/msg-dedup` | 新 | 收方回合首动作去重助手:DSHMSG 行或 `from msgid to` 三参;60s 窗口同 `(from,msgid)` → exit 3,新消息记录后 exit 0;老信封(无 msgid)exit 0 透传;窗口 >1000 行截半 GC(temp+rename) |
| `state/dedup/` | 新 | 运行时目录,首用自动创建(gitignore `state/` 已覆盖) |
| `orch-fleet-conventions.md` | 增 | 信封节补 v2 说明;新增「Relay 契约:事件回报后原子推进基线」节(diff/回报/原子推进/零回声四步,验收④) |
| `tests/of001-selftest.py` | 新 | temp fleet 副本 + 本地 stub HTTP server(模拟 `/api/session.prompt` 应答 `{"result":{"ok":true,"value":{"accepted":true}}}`),覆盖验收①–⑤ |
| `reports/OF-001-report.md` | 新 | 本报告 |

红线遵守:未 git commit/push;未改 pipecat-poc 仓任何文件(规范文件只读);live `fleet.json` 只读(selftest 复制为 temp 副本并重写 port 指向 stub,零真实 DSH 流量);除最后 done 回程外未向真实 sessionId 发消息。

## A. selftest 输出原文

```
① 旧 5 参调用兼容(输出/退出码逐字节一致 + 信封多 msgid/ts):
  [PASS] exit 0(旧参调用) — rc=0
  [PASS] stdout 与现行格式逐字节一致 — sent orch1 -> 2437(session-2437ab…) type=done ref=r1: accepted=True
  [PASS] 信封新增 msgid(uuid4) — f3185395-6781…
  [PASS] 信封新增 ts(epoch ms,当前时刻) — ts=1787497062958
  [PASS] 零参调用 → usage + exit 2(与现行一致)
② 同 msgid 重发 → msg-dedup exit 3(重复 steer 丢弃演示):
  [PASS] 重发保号:--msgid 透传送达
  [PASS] 收方首见该 steer → exit 0 放行 — rc=0
  [PASS] 重复投递(网络重试/relay 回声) → exit 3 丢弃 — msg-dedup: DUPLICATE from=orch1 msgid=24f678e0-fdec-4862-9656-f74f3910457c age=45ms (window 60000ms) — drop
  [PASS] 三参直查形式同键 → exit 3
  [PASS] 窗口过期(61s 前同键) → exit 0 放行 — rc=0
  [PASS] v2 前老信封(无 msgid) → exit 0 透传不误伤
③ 去重窗口 GC(灌 1001 行合成数据 → 截半):
  [PASS] GC 后新消息 exit 0 — rc=0
  [PASS] 1001 行 → 501 行(保留最近 500 + 新 1) — lines=501
  [PASS] 保留的是最近一半(m-501 起,最早 501 行被截) — m-501
  [PASS] GC 后窗口去重仍生效(同键 → exit 3)
④ relay mock:base 原子推进后同事件重放零回报(D-10):
  [PASS] 首轮全量回报 4 事件(2 report + 2 git) — sent=4 reports=['OFX-1-report.md', 'OFX-2-report.md'] git=['c1', 'c2']
  [PASS] 位点文件落盘且 base 已推进 — {"reports.base": "OFX-2-report.md", "git.base": "c2", "ts": 1787497064154}
  [PASS] 同事件重放(零新落地) → 零回报 — sent=0
  [PASS] 新增落地只报增量(1 report + 1 git) — sent=2
  [PASS] base 跟随推进至最新位点
  [PASS] stub 总请求数 = 1(①)+1(②)+4+0+2 = 8,无回声流量 — total=8
⑤ 信封仍单行 JSON,老消费者解析不拒收(OG5):
  [PASS] 全部信封单行 + DSHMSG] 前缀 — n=8
  [PASS] 老消费者解析(']' 切一刀 + json.loads + 只读老键)全部成功
  [PASS] 老键字节序保持(新键只追加在尾部) — DSHMSG]{"from": "orch1", "to": "2437", "type": "done", "ref": "r1", "body": "hel…
  [PASS] v2 键(msgid/ts)全量在位,与老键共存

OF-001 selftest: 25/25 全绿
EXIT=0
```

## B. 验收逐条对照

| 验收(规范原文) | 结论 | 证据 |
|---|---|---|
| ① 零参调用兼容:输出/退出码与现行一致,信封多 msgid+ts 两键 | ✅ | 旧 5 参调用 stdout 与现行格式逐字节一致(`sent orch1 -> 2437(session-2437ab…) type=done ref=r1: accepted=True`),exit 0;零参 → usage+exit 2;信封增 `msgid`(uuid4)/`ts`(epoch ms),老键与键序不变(OG1/OG5) |
| ② 同 msgid 重发 → `msg-dedup` exit 3,收方 doctrine 演示丢弃一次重复 steer | ✅ | `--msgid` 透传保号送达;收方对同一信封行首见 exit 0、重放 exit 3(DUPLICATE … age=45ms — drop)——即重复 steer 丢弃演示;三参直查同键同判;窗口外(61s)/老信封(无 msgid)不误伤 |
| ③ 窗口文件 GC 生效(灌 1001 行合成数据验证截半) | ✅ | 1001 行 → 501 行(保留最近 500+新 1,首行 m-501 即最早 501 行被截);截半后同键去重仍 exit 3;重写走 temp+rename |
| ④ relay mock 场景:base 推进后同事件重放零回报 | ✅ | mock 按 `orch-fleet-conventions.md` 新契约四步实现:首轮全量 4 事件 → 位点 `{"reports.base":"OFX-2-report.md","git.base":"c2"}` 落盘(temp+rename) → 同事件重放 sent=0 → 新增落地只报增量(1 report+1 git)且 base 跟随推进;stub 总请求数恰 8,零回声流量 |
| ⑤ 信封仍单行 JSON,老消费者解析不拒收(OG5) | ✅ | 8 封全部单行 + `DSHMSG]` 前缀;`]` 切一刀+json.loads 全解析成功;老键字节序保持(新键只追加尾部);msgid/ts 全量在位 |

## C. OG 门对照

- **OG1 兼容不破**:新能力全以追加键/可选参数落地(`--msgid`);旧 5 参与零参行为逐字节验证(①)。
- **OG2 冒烟自带**:本 selftest 即 temp 域(temp fleet 副本 + stub HTTP server + temp state)自动证据。
- **OG3 红线继承**:未碰 dais 二进制仓、未 push、未碰 VO 在飞文件(pipecat-poc 仓零改动)。
- **OG4 台账回写**:D-10 回写归 GM(done body 已注明「待GM回写」;本报告即勾稽证据)。
- **OG5 信封只增不改**:老键名/顺序/序列化格式不变,新键 msgid/ts 追加尾部;老消费者忽略未知键(⑤)。

## D. 边界与备注

1. `msg-dedup` 窗口按收方码 `<to>.jsonl` 分文件;`to` 含路径字符时经白名单替换消毒。崩溃半写行 load 时跳过不致命。
2. relay 契约落文档(`orch-fleet-conventions.md`),mock 实现内嵌于 selftest 作验收演示;现行 relay(2d62)迁移属后续票面(OF-006 泛化时收口),本轮未触碰。
3. git status 中 `bin/ledger` 存在本票开工前已有的域内改动(非本票触碰,保持原样,由 GM 合并时甄别)。

done 通过;报告:reports/OF-001-report.md;测试:25全绿;台账:D-10 待GM回写;备注:信封v2只增不改,双道防线治回声
