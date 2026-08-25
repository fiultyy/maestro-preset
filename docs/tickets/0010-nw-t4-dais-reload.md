# T4(0010) — dais 重载路径修复: message-type 合法化 + inbox reader 三重断裂修复 + 沙箱 dais 实测

> file = `docs/tickets/0010-nw-t4-dais-reload.md` · 状态: DISPATCHED

**依据**: 评审报告 `nw-plan-review-report.md` R-B06(direct 非法枚举/词汇映射缺失/重载路径已断)、R-B07(④ reader 三重断裂 + v3 字段落点)、R-S13(缓解一拍板)、R-S08(回滚顺序)、R-S10/R-S25(沙箱 dais 落点);spec 节 P3a(`docs/reports/.nw-spec-raw-P3a.md` A.0-A.7);方案 §6C/§4 P3 修订版(见 spec A.0 替换稿)。

**目标**: 把 a2a 重载路径从"从未工作过的死路"(生产 router-journal `{'push':30,'denied':3,'mailbox':0}`;真实库 0 条 direct 落库)修成**沙箱可实测投递成功**的新格式路径(纯 body + 结构化信封头 + subject 承载 ref + message_type 合法值);同时修复 agents/inbox reader 的三重断裂(路径指 0 字节空库/SQL 列名全错/SELECT 缺 subject);以 XDG_STATE_HOME+A2A_DAIS_DB 双隔离沙箱 dais 实例完成 P3 验收;全程零生产接触。

**交付物(文件级清单)**:
1. `plugins/a2a-profile-server/http-server.js` — 单提交四处改造:
   - :72 `daisDbPath()` 缺省 `~/.local/state/dais/warp.sqlite`(`A2A_DAIS_DB` 优先级不变);
   - :58 邻近新增 `const DAIS_MESSAGE_TYPE = { notify: 'status', steer: 'status', ping: 'status' }`;:171-179 重载分支: `--message-type` 改 `DAIS_MESSAGE_TYPE[type] ?? 'status'`、`--body` 改纯 `body`(删 `'DSHMSG]'+JSON.stringify(envelope)` 行)、`--subject` 改 `refSubject(ref)`;分支注释与红线注释(:94-96)同步;
   - :82 后新增 `refSubject(ref)`(`'[ref:'+单行化+UTF-8≤120 截断(ref)+']'`,缺省/'-'→`'[ref:-]'`)与 `refFromSubject(subject)`(`/^\[ref:([^\]]*)\]$/`);:76-82 extractRef 函数体零改动、注释升 legacy 永久保留;
   - :208-218 `defaultInboxReader` 重写(SQL `SELECT sequence, from_handle, to_handle, message_type, subject, body FROM messages WHERE to_handle = ? AND read = 0 ORDER BY sequence`;行映射 `{from: r.from_handle, to: r.to_handle, type: r.message_type, body: r.body, seq: r.sequence, subject: r.subject, ref: refFromSubject(r.subject) ?? extractRef(r.body)}`);:203-207 注释同步真实 schema。
2. `tests/p3-dais-reload-selftest.py` — 沙箱验证脚本(OF-005 基底: 全 temp 域、`[ ok ]/[FAIL]` 原子断言、幂等可重跑、句柄命名空间 `nw-sbx-*` 隔离断言;驱动方式见工作说明)。
3. `docs/tickets/0010-nw-t4-dais-reload.md` — 本票 + 实施记录回填(含回滚演练留痕)。

**验收断言(可执行,selftest 承载;编号与 spec A.1-A.7 对应)**:
1. 三型投递: notify/steer/ping 各一条 heavy(多行 body)send → `delivered:'mailbox'` + ackRef 含数字 seq + `$SBX/journal.jsonl` 各一行 `delivered:'mailbox'`。
2. 落库: 沙箱库三行 `message_type` 均 =`'status'`(九值 CHECK 闭集兜底)。
3. body 纯净化: 三行 body 与发送原文逐字节相等(不以 `DSHMSG]` 开头、无信封键)。
4. 拒收不变: `send(type:'direct')` → RouterError `rpcCode===-32602` 且文案含 `invalid type`。
5. parity: `{notify,steer,ping}` 逐值 `DAIS_MESSAGE_TYPE[t] === denormalizeType(t,'dais')`(selftest import `plugins/_narrow-waist/vocabulary.js`)。
6. `grep -n "'direct'" plugins/a2a-profile-server/http-server.js` 零命中。
7. agents/inbox RPC(`A2A_DAIS_DB` 指沙箱库)成功返回 unread 行,无 `no such column`。
8. 新格式 ref: `send(ref:'LB-002')` → unread 行 `ref==='LB-002'`、`subject==='[ref:LB-002]'`。
9. 旧格式兼容两形态(dais CLI 直投,subject 均 `'route'`): body=`DSHMSG]{"from":"x","to":"y","ref":"legacy-ref",…}` → ref=`'legacy-ref'`;body=`[ref:body-pref] hi` → ref=`'body-pref'`。
10. 路径静态断言: http-server.js 含 `.local/state/dais/warp.sqlite`、不含 `.local/share/dais/data.sqlite`。
11. subject 约束: ref 缺省 → `[ref:-]`;ref 含 `\n` → 投递成功且 subject 无换行;ref 300 字节 → subject UTF-8 ≤120。
12. 生产零接触: 前后各查 `SELECT COUNT(*) FROM messages WHERE from_handle LIKE 'nw-sbx-%' OR to_handle LIKE 'nw-sbx-%'` 于 `~/.local/state/dais/warp.sqlite`(只读)均 = 0;`body LIKE 'DSHMSG]%'` 计数前后不变;沙箱库 `nw-sbx-*` 计数 = 投递条数。
13. 幂等: selftest 连跑两遍全绿;失败以非零退出码上报;结束打印 SBX 路径。
14. 单提交: 发/收改造同一 commit(git log 验证);extractRef 函数体 diff 零改动。

**依赖与顺序**: 依赖 T2(库: `plugins/_narrow-waist/vocabulary.js` 落地 DAIS_TYPE_MAP notify/steer/ping→status 与 `denormalizeType`)——断言 5 import 该库,须 T2 合入后开工;本票零运行时库依赖(内联映射),T2 仅阻塞测试不阻塞改造。不依赖 T3/orca、不依赖 dais 仓任何改动(P5 轴零交集)。部署(install.sh 面三重装 + daemon 重启)与生产切流**不属本票**,由编排验收后统一执行。

**回报契约**: 开工第一动作: ~/.dsh/maestro/bin/cb-send ack impl@omp nw-planner@orca-main nw-T4 'turn started';完成后(≤300字摘要): cb-send done impl@omp nw-planner@orca-main nw-T4 '<结论;产物路径;剩余>';被阻塞: cb-send ask。done 只发一次。

**工作目录注记**: 仓 = /home/yy/tools/maestro-preset-iter(master 的 linked worktree);产物一律写该 worktree;不碰 /home/yy/tools/maestro-preset 主检出,不动生产 ~/.dsh。

**工作说明**:
- 沙箱机制(已实证,勿另造轮子): `SBX=$(mktemp -d)`;`export XDG_STATE_HOME=$SBX/state`(真 dais CLI 落库自动建 `state/dais/warp.sqlite`+迁移;沙箱内无 `dais-runtime.json` → socket 快路不转发生产 GUI——探针 `check-status` 返 `0 runs` 已证);`export A2A_DAIS_DB=$SBX/state/dais/warp.sqlite`;dais 二进制用缺省 `~/.local/bin/dais`。selftest 为 Python 驱动 + node 桥: 以 `node --input-type=module --eval`(cwd=仓根,env 继承)import `plugins/a2a-profile-server/http-server.js` 的 `createRouter`,注入桩 registry(`{agents: async () => [{code:'nw-sbx-orch', mailbox:'nw-sbx-orch@session-x', project:'nw'}, {code:'nw-sbx-w1', mailbox:'nw-sbx-w1', project:'nw'}]}`)与 `journalPath=$SBX/journal.jsonl`,heavy body 用多行文本;落库/reader 断言由 Python 侧 `sqlite3`(只读 URI `file:…?mode=ro`)直查沙箱库与生产库。若未来 dais 版本 XDG_STATE_HOME 失效(断言 12 红、沙箱库缺文件): 降级 A2A_DAIS_BIN 指包装脚本拦截 send-message 改 sqlite3 直写,并在实施记录注明。
- 代码要点: `refSubject` 截断按码点(`Array.from` 后接回再测 `Buffer.byteLength ≤120`);`DAIS_MESSAGE_TYPE[type] ?? 'status'` 的 `??` 分支为防御位(type 已过 ROUTER_TYPES 闸,理论不可达);行映射新增 to/subject 为增量键,勿动 from/type/body/seq/ref 键名;heavy 判定(:161)与 ROUTER_TYPES(:58/:142-144)零改动。
- 禁区: 不 import `../_narrow-waist`(装点 ENOENT,见 spec A.1③);不动 `bin/session-send`/`bin/cb-send`(轻载线,A.4 裁决);不动 dais 仓源码与 MessageType 枚举;不动 messages schema;不改 `executors/dais.js`;不碰生产 daemon 与 `~/.dsh`(生产库仅只读快照);不把测试句柄用于生产库写入。
- 回滚演练(交付前做一次并留痕): cp 仓内新版 http-server.js 至 `$SBX/install-sim/` 模拟装点 → grep `DAIS_MESSAGE_TYPE` 命中 → 换回 git revert 版 → grep 零命中 + 用旧 reader 逻辑(临时脚本复刻原 :212 SQL + extractRef)读一条新格式行 → ref 返回 `'-'`(已接受降级,E-S04/R-S08 实证)。结果记入实施记录。
- 实施记录回填: 改造 diff 摘要、selftest 输出全量、生产库前后快照数值、回滚演练输出、残余风险(如有)。

---

*P3a 起草完毕。断言编号 1-26 在 spec(A.1-A.7)与 ticket(重排 1-14)间映射: ticket1-14 ⊇ spec(1)-(26) 的可执行子集;spec(17)(18)(20)(21) 为文档/流程级断言,分别归 ticket 工作说明的禁区条款、spec 汇总者核验、单提交验证与回滚演练留痕承载。*
