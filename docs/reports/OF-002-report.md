# OF-002 报告 — fleet 属主租约 + steer 闸(顺带 D-07 存量清理)

> 票: docs/kg/09-orch-hardening-plan.md §3 OF-002 · 基线 1ebc155(OF-001 已合入)
> 执行: of002 · 2026-08-23 · 改动在 working tree 待 GM 统一提交
> 文件域: bin/fleet-touch · bin/session-send · tests/of002-selftest.py(new) · 本报告
> 未触碰: bin/ledger(OF-005 在制品)、真实 fleet.json(全程只读)、pipecat-poc 仓

## 0. 交付物与机制摘要

| 文件 | 变更 |
|---|---|
| `bin/fleet-touch` | 新增四子命令 `claim/heartbeat/release/sweep`(首 token 分派,旧 `<code> [--status]` 路径零变化);所有写动作(含旧 touch)经 flock 串行 读-改-写 |
| `bin/session-send` | resolve 后新增控制面闸:仅 `type=steer` 受检;owner 有效且≠from → exit 4 + 冲突行;否则放行 + 审计行 |
| `tests/of002-selftest.py` | temp 域全场景 selftest(33 检查) |

- **租约键**: `owner` / `leaseExpiresAt` / `heartbeatAt` + 辅键 `leaseTtlMin`(heartbeat 续期需知道原 ttl;claim 时落,release 一并清——比规范"+3 键"多一个纯辅键,additive,老消费者不受影响)
- **claim 语义**: 他人有效租约在身 → 拒(exit 1);过期可接管;同人重复 claim = 刷新
- **steer 闸**: 冲突行落 `<fleet 目录>/fleet-conflicts.jsonl`(键恰 = `msgid/from/to/ts`,复用 OF-001 msgid;.gitignore 已有该文件条目);放行审计行落 `$MAESTRO_STATE/steer-journal.jsonl`(`reason=owner-self|unowned|lease-expired|no-entry`;state/ gitignored)
- **sweep(D-07)**: `status=active` 且 lastSeenAt/heartbeatAt 较新者陈旧 `>--days`(默认 7)→ retired;**dry-run 为默认零写入**,`--apply` 才动真;两时间戳皆缺的条目保守跳过
- **原子性**: temp+rename(单次写原子,不撕裂)+ flock `$MAESTRO_STATE/<basename>.lock`(读-改-写原子,并发不丢更新;锁文件独立 inode 不随 os.replace 换代)。touch 也纳入锁:否则 touch(编排者每回合调)与 claim 并发会整文件 last-writer-wins 丢租约键——对既有调用方仅增串行,stdout/退出码逐字节不变

## A. selftest 输出原文

`cd /home/yy/.dsh/maestro && python3 tests/of002-selftest.py`(exit 0):

```
① claim/heartbeat/release 原子读写(temp+rename+flock,并发不丢不撕):
  [PASS] claim rc0 — claimed tgt1: owner=ownr1 ttl=30min leaseExpiresAt=2026-08-23T15:38:07+00:00
  [PASS] claim 写齐 owner/leaseExpiresAt/heartbeatAt(+leaseTtlMin) — expires in 30.0min
  [PASS] 他人有效租约 claim → rc1 拒绝且键不变 — fleet-touch: lease conflict: tgt1 held by ownr1 until 2026-08-23T15:38:07+00:00(有效租约在身,claim 被拒;先 release 或待过期接管)
  [PASS] heartbeat 无租约 → rc1 — fleet-touch: no lease on h001(heartbeat 需先 claim)
  [PASS] heartbeat 续期(leaseExpiresAt 前移,heartbeatAt 刷新) — heartbeat h001: owner=ownr1 renewed ttl=10min leaseExpiresAt=2026-08-23T15:18:08+00:00
  [PASS] release 清四键 — released tgt1: cleared ['owner', 'leaseExpiresAt', 'heartbeatAt', 'leaseTtlMin']
  [PASS] release 幂等(rc0) — released tgt1: no lease (nothing to clear)
  [PASS] 过期租约可被接管(claim takeover) — claimed exp3: owner=intr9 ttl=5min leaseExpiresAt=2026-08-23T15:13:09+00:00
  [PASS] 并发 10 写全部 rc0 — [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  [PASS] 并发 claim 四键全落地(读-改-写不丢失) — {"c001": "w1", "c002": "w2", "c003": "w3", "c004": "w4"}
  [PASS] 并发 release/heartbeat 与 touch 互不覆盖 — {"r001": true, "h001": "ownr1", "exp3": true}
  [PASS] 并发期间读者循环 JSON 恒可解析(1530 reads) — fails=0
  [PASS] 无 .fleet-touch- 临时残留 — []
  [PASS] 旧路径 touch 输出格式不变(OG1) — touched aa11: lastSeenAt=2026-08-23T15:08:09+00:00 status unchanged
② owner 有效 + 非 owner steer → 拒(exit 4)+冲突行:
  [PASS] exit 4 拒绝 — rc=4
  [PASS] 消息未发出(stub 零新增)
  [PASS] stderr 标注 REFUSED/属主 — session-send: steer REFUSED — tgt1 leased by ownr1 until 2026-08-23T15:38:09+00:00; conflict journaled (/tmp/of002-selftest-vrppzehk/fleet-conflicts.jsonl) msgid=d407b42a-862f-4b14-ac08-d5f517d8434a
  [PASS] fleet-conflicts.jsonl 落行,键恰=msgid/from/to/ts — {"msgid": "d407b42a-862f-4b14-ac08-d5f517d8434a", "from": "intr9", "to": "tgt1", "ts": 1787497689950}
  [PASS] 二次 steer 再拒,冲突行累计 2 且 msgid 各异
③ 三态放行(owner 本人/无主/过期/直投):
  [PASS] owner 本人 steer 放行 rc0
  [PASS] journal 行 reason=owner-self — {"msgid": "dfbdba3e-9f6b-44bc-b7e4-caebcbba1aad", "from": "ownr1", "to": "tgt1", "ts": 1787497690160, "reason": "owner-self"}
  [PASS] 无主 steer 放行(reason=unowned)
  [PASS] 过期租约 steer 放行(reason=lease-expired)
  [PASS] 直投 sessionId(无 fleet 条目)放行(reason=no-entry)
  [PASS] journal 行键齐(msgid/from/to/ts/reason)且四 reason 各一行
④ sweep dry-run/apply(D-07):
  [PASS] dry-run 列出 stl1/stl2 且零写入(sha 不变) — sweep[dry-run]: stl1 stale=10.0d freshest=lastSeenAt=2026-08-13T15:08:07+00:00 -> would retire | sweep[dry-run]: stl2 stale=9.0d freshest=heartbeatAt=2026-08-14T15:08:07+00:00 -> would retire | sweep[dry-run]: 2 candidates (status active only, > 7d) — 零写入,--apply 才动真
  [PASS] --apply 后 stl1/stl2 retired — sweep[apply]: retired 2 entries (status active only, > 7d)
  [PASS] frsh(新鲜)/nots(无时间戳)/term_x(非 active)/gon9(已 retired)不动
  [PASS] apply 后 dry-run 0 候选 — sweep[dry-run]: 0 candidates (status active only, > 7d) — 零写入,--apply 才动真
⑤ 任务型消息不受闸影响(有效他人租约在场):
  [PASS] 七类型经有主目标全放行 rc0 — [0, 0, 0, 0, 0, 0, 0]
  [PASS] 全部送达 stub(7 封)
  [PASS] conflicts/journal 不随任务型增长
  [PASS] 闭环: release 后同 sender steer 放行(reason=unowned)

OF-002 selftest: 33/33 全绿
```

## B. 验收逐条(§3 OF-002 验收 ①–⑤)

| # | 验收 | 证据 |
|---|---|---|
| ① | claim/heartbeat/release 原子读写(temp+rename,并发双写不撕裂) | selftest §①:单动作键读写正确(含他人有效租约 claim 拒、过期接管、heartbeat 无租约 rc1、release 幂等);并发 10 写(4 claim + 3 heartbeat + 1 release + 2 touch)全 rc0、四 claim 键全落地(flock 读-改-写无丢失)、1530 次并发读者 JSON 恒可解析(不撕裂)、无临时残留 |
| ② | owner 有效时非 owner steer 被拒且 conflict journal 落行 | selftest §②:exit 4、stub 零新增(消息未发出)、`fleet-conflicts.jsonl` 落行且键恰 = msgid/from/to/ts(msgid 复用 OF-001 信封,ts=epoch ms)、二次拒累计 2 行 msgid 各异 |
| ③ | owner 本人/无主/过期三种放行 | selftest §③:owner-self / unowned / lease-expired 三态 rc0 放行并各落 steer-journal 审计行(另覆盖直投 sessionId 无条目 = no-entry 第四态) |
| ④ | sweep dry-run 列表 + --apply 后条目 retired | selftest §④:dry-run 列 stl1/stl2 且 sha 不变(零写入);--apply 后二者 retired;新鲜/无时间戳/非 active/已 retired 四类不动;复扫 0 候选 |
| ⑤ | 任务型消息不受闸影响 | selftest §⑤:done/ask/ack/report/ping/pong/nack 七类型经"有效他人租约"目标全 rc0 送达,conflicts/journal 零增长;另证 release 后 steer 恢复放行(闸状态机闭环) |

## C. OG 门核对

- **OG1 兼容不破**: `fleet-touch --selftest`(SI-001)7/7;`tests/of001-selftest.py` 25/25(含信封字节序/输出逐字节断言);新能力全部为新子命令/新键,旧参数路径 stdout/退出码不变(selftest §① 末行专项断言)
- **OG2 冒烟自带**: 本报告 A 节 selftest(合成 fleet + 本地 stub HTTP,零真实流量);D 节 live 只读 dry-run
- **OG3 红线继承**: 未 commit/push;真实 fleet.json 全程只读(dry-run 不加锁不写入);未碰 bin/ledger 与他人 in-flight 文件
- **OG4 台账回写**: D-07 由 GM 回写(本票不直改 pipecat-poc 仓台账),done body 已带 `台账:D-07 待GM回写`
- **OG5 信封只增不改**: 信封构造零改动(仅 msgid/ts 提前求值,字节序不变);fleet 条目新键只增

## D. live 只读演示(真实 fleet,零写入)

```
$ python3 bin/fleet-touch sweep --fleet ~/.dsh/maestro/fleet.json --days 7
sweep[dry-run]: 0 candidates (status active only, > 7d) — 零写入,--apply 才动真
$ python3 bin/fleet-touch sweep --fleet ~/.dsh/maestro/fleet.json --days 3
sweep[dry-run]: 0 candidates (status active only, > 3d) — 零写入,--apply 才动真
```

现行 fleet 无 >3 天陈旧 active 条目(成员心跳新鲜,D-07 现阶段无可清存量;机制就绪,后续 GM 视情 `--apply`)。dry-run 不写文件、不加锁,exit 0。

## E. 设计注记与已知边界

1. **leaseTtlMin 辅键**: heartbeat 续期需原 ttl;存于条目、release 同清。替代方案(heartbeat 每次显式 `--ttl-min` 或固定魔法值)更脆,故取 +1 键。
2. **闸只认字面 owner**: `--owner` 存什么、`from` 是什么就比什么(推荐 fleet 短码两边一致);owner 存全 sessionId 而发送方用短码会视为非 owner——用法纪律问题,已在 fleet-touch `--owner` help 注明"属主标识(fleet 短码)"。
3. **fail-open**: leaseExpiresAt 缺/坏/过期一律放行(不因新键缺失误伤存量流量,与 OG1 同向)。
4. **steer-journal.jsonl**: 规范未命名的放行审计面,落 `$MAESTRO_STATE/`(gitignored);冲突面按规范钉在 `<fleet 目录>/fleet-conflicts.jsonl`。
5. **touch 纳入 flock**: 对既有调用方仅增串行(锁文件 `$MAESTRO_STATE/fleet.json.lock`,gitignored);换取 claim/touch 并发不丢更新。
6. **并发写者跨机不保证**: flock 仅本机;当前 maestro 单机域,跨机需另议(非本票范围)。

---
done body:通过;报告:reports/OF-002-report.md;测试:33全绿;台账:D-07 待GM回写;备注:租约三动作+steer闸+sweep;touch经flock保原子
