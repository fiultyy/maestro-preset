# OF-010 验收回报单

- **ref**: OF-010 · **执行者**: of010(GM 派发 worker) · **完成时间**: 2026-08-23
- **判定**: PASS
- **代码范围**: `bin/ledger`(改:终态迁移挂单向投影钩子 + pending 补投表)、`bin/wave-checkpoint`(改:追加后同步投影,lazy 复用 ledger 同一钩子)、`tests/of010-selftest.py`(新)、`reports/OF-010-report.md`(本单)
- **规范依据**: `pipecat-poc/docs/kg/09-orch-hardening-plan.md` §4 OF-010 + §1 OG 门

## A. selftest 输出原文

```
$ cd /home/yy/.dsh/maestro && python3 tests/of010-selftest.py; echo "EXIT=$?"
OF-010 selftest · ledger=/home/yy/.dsh/maestro/bin/ledger · wave-checkpoint=/home/yy/.dsh/maestro/bin/wave-checkpoint · python=3.12.3
[ ok ] C1_终态投影
[ ok ] C2_拒写与补投
[ ok ] C3_无活跃静默跳过
[ ok ] C4_wave勾稽一致
[ ok ] C5_无反向写
OF-010 selftest: 5/5 全绿(exit 0)
EXIT=0
```

回归(改 bin/ledger 与 bin/wave-checkpoint 后全量复跑):

```
OF-005 selftest: 13/13 全绿(exit 0)
OF-007 selftest: 5/5 全绿(exit 0)
```

全程 temp 域:db/carryover/checkpoint 均临时路径,live `ledger.db` 与真实 `state/` 零触碰(红线:ticket 投影用 temp db 测)。

## B. 验收①–⑤逐条勾稽

| # | 验收(规范 §4) | 达成 | 证据 |
|---|---|---|---|
| ① | 票终态迁移后 longtask checkpoint 含该票号+终态 | [x] | C1:四终态(done/merged/rejected/rolled-back)各迁移后,承接件 `state/longtask-carryover.md`(temp)Checkpoints 表含 `F1 已收口(state=done)` 等行,verifiedBy=票号;非终态迁移(running/blocked)零投影;env 与 marker 文件两种激活方式均验;序号=journal `projected` 计数递增(DB 为源,不读承接件) |
| ② | 拒写不阻塞主流程,journal 落 WARN,后续补投成功 | [x] | C2:chmod 444 拒写 → `ticket state R1 done` rc=0、stdout 契约原样(`R1 running -> done`)、stderr WARN、DB state=done、ticket_events 落 `project-warn` 行、pending 队列=1;复权后下一次终态迁移先补投 R1 再投新行、pending 清空、journal 落 `补投` 行;路径非法变体(父路径为普通文件)同语义 |
| ③ | 无活跃 longtask 时静默跳过零报错 | [x] | C3:无 env 无 marker → 终态迁移与 wave 追加均 rc=0、stderr 空、承接件不创建、pending/projected/project-warn 全零计数 |
| ④ | wave-checkpoint 行与 checkpoint 摘要勾稽一致 | [x] | C4:两次 wave 追加后,JSONL `--tail 1` 的 tickets 映射与承接件 `wave=W6 round=N 票态: id=state;…` 行逐票相等(解析比对);verifiedBy=`wave-checkpoint round=N` 与 round 勾稽;终态行与 wave 行序号连续 |
| ⑤ | 全链无反向写 | [x] | C5:(a)承接件内容零回流 token(DSHMSG/session-send/MAESTRO_/UPDATE/INSERT/sqlite3/ledger/exec/prompt 逐一断言不存在);(b)行为证:外部塞入伪造指令哨兵行后,maestro 继续正常迁移+投影,DB 票态不受影响、哨兵行 append-only 保留、新行照常追加——承接件永不被 ledger/wave-checkpoint 读回(序号取自 DB journal 而非文件行数,即"不读回"的结构性证明) |

## C. 通道选择理由(b 文件承接件为主,a loopback 不做)

- **b(文件承接件)落地**:`state/longtask-carryover.md`,形制仿 ledger-carryover-round6 的 Checkpoints 表(`| # | 陈述 | verifiedBy |`);O_APPEND+单 write+fsync 原子追加;服务端损坏时的权威承接面,不依赖 longtask 活着。
- **a(loopback API)不做的理由**:①longtask 服务端坏过一次(round 14–16 事故,规范 §0 治法=身份/状态/守望下沉机械层,文件面即机械层);②本票窗口 session-send 属 OF-006 在制冲突域(红线);③方向纪律下最小暴露面——loopback 注入会话存在"承接会话回写 maestro"的误用诱因,文件单向面无此面。
- **激活面**:env `MAESTRO_LONGTASK_SESSION` 或 `<maestro>/state/longtask-session` 标记文件(GM 在 longtask 会话存活期间创建);承接件路径可用 `MAESTRO_LONGTASK_CARRYOVER` 覆盖(测试/迁移用)。
- **Objective/goal 本体零自动改写**:投影只落事实行,无任何 goal 写入路径。

## D. OG 门勾稽

- **OG1 兼容不破**:OF-005 13/13 + OF-007 5/5 回归全绿——既有 ticket 子命令 stdout/stderr 契约在投影成功/静默跳过两态下逐字节不变(WARN 仅失败态走 stderr);`session-send`/`fleet-touch`/`event-watchd` 零触碰(红线遵守)。
- **OG2 冒烟自带**:selftest 5 用例;三票联跑输出见 A。
- **OG3 红线继承**:未 commit/push;live ledger.db 零写入(本票无 live 票据迁移需求);pipecat-poc 仓未动。
- **OG4 台账回写**:主题 B 收口(含 OF-005/007/010 三票)由 GM 统一回写。
- **OG5**:不涉信封;ticket_projection_pending 为纯新增表,旧读者零影响。

## E. 偏差与备注

1. **规范① live 冒烟**:任务书红线限定"ticket 投影用 temp db 测"且 live tickets 表现为空(node 镜像非 tickets 面)→ live 冒烟未执行,等价证据=temp 全链 C1;GM 首次以 `ledger ticket` 录入真实票并终态迁移时自然触发(届时建 `state/longtask-session` 即激活)。
2. **中间终态也投影**:done→merged 链上每个终态各投一行事实(事件流语义,非状态快照);C1 断言按此口径。
3. **承接件永不读回的实现**:行序号取自 DB journal `projected` 计数而非文件内容;文件首建时补表头,之后纯 O_APPEND。若文件被外部截断/清空,重建时补表头、序号从 journal 续(不重不漏于 DB 面)。
4. **重复投递窗口**:journal 落行与文件追加同事务边界外——极端态(文件写成功后 DB 提交失败)可能产生承接件重复行,DB journal 面不重不漏;渲染侧去重依据 seq 列。
5. **pending 双失败**:承接件拒写且 pending 落库亦失败时,第二次 WARN 后放弃本次投影(不无限重试);下次终态迁移/wave 追加重新尝试。
PASS;报告:reports/OF-010-report.md;测试:5全绿;台账:主题B待GM回写;备注:通道b承接件;pending补投;三票回归绿
