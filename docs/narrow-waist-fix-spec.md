# §G 全局修订总则(narrow-waist 实施方案修订规格 · sectionId=G)

> 裁决对象: `docs/narrow-waist-implementation-plan.md`(232 行版)。本节全部为**方案文本级**裁决——纯文档修订(T1 票)可完整承载;代码级实施归对应实施票。所有引用锚点已经本起草员在 worktree `/home/yy/tools/maestro-preset-iter` 亲证(2026-08 快照),以**函数名锚点为权威、行号可漂**。无开放问题;报告中给出的二选一均已按其推荐项拍板并附一句理由。

## G.0 [评审 §3④ 勘误表 + E-S01/R-S11(关联)] 引用锚点总则

- **裁决**: 方案全文的行号引用按评审 §3④ 勘误表 14 处 + E-S01 全部重标,格式统一为"函数名/常量名锚点 @ 实测行号",函数名为权威、行号仅参考。勘误后锚点(已亲证):
  - §6A index.js: imports@27-34(仅 store/dedup 两 core 模块)、组装@144-177(全文 228 行);
  - §6A http-intake.js: TYPES@31、validate@84-102、createHttpIntake@117-189、受理落盘行@265、counters@145-158;
  - §6A file-router.js: 配置/counters@61-106、deliverPending@256-283、flush@285-383(dedup 链@336/:353-354);
  - §2.2/§6A core/addressing.js: parseAddress@18-24、aliasIndex@27-35、resolveHostRouting@43-70;
  - §6B session-send: resolve@32-42、parse_ts@45-53、find_entry@56-65、steer_gate@76-100、信封@127-129;
  - §6B cb-send: payload@28-32(body 恒带 `[ref:]` 前缀)、PORT-R1 sig 比对@36-43;
  - §6B message-bridge: TYPES@73、dedup Map@168-176、validate@210-228、判定@215-217;
  - §6D fleet-touch: get_entry@137-141(105-118 是 LEASE_KEYS/fleet_lock);
  - §6D pump.js: digestOf@106-115、parseAddress/aliasIndex@142-159、resolveRouting@171-192、registry@194-239(register/unregister@375-410)、store@287-373、flush 内 dedup@609-617/638-639;
  - §2.1 a2a http-server.js: ROUTER_TYPES@58(:45 是 ROLE_VALUES)、daisDbPath@72、extractRef@76-82、defaultInboxReader@209-218、heavy 阈值@103、heavy 判定@161、dais 调用@171-179;types.rs 枚举@14-33;
  - P4 AGENT_CARD 路径: `shared/maestro-bridge/`(见 G.8)。
- **落点**: plan 全文(§2/§3/§6/P4 各行)。
- **验收断言**: 修订后方案中不再出现勘误表所列 14 处旧锚点(如 `file-router.js:61-106=flush()`、`session-send:21-28`、`fleet-touch:105-118`、`http-server.js:45 ROUTER_TYPES` 字样);每处引用含函数名。

## G.1 [R-S07 + E-B01] §6 加"阶段"列;新设 P3.5;session-send/cb-send 钉死 P3;message-bridge 行改冻结声明;pump 行删过渡改造

**裁决**(单一版本):

1. §6 四张表(§6A/§6B/§6C/§6D)每行最左增"阶段"列,取值 ∈ {P1, P2, P3, P3.5, P4, 不动}。全表分派:

| 表 | 行(锚) | 阶段 |
|---|---|---|
| §6A | index.js import 换源(imports@27-34/组装@144-177) | **P3.5** |
| §6A | http-intake.js(TYPES@31/validate@84-102/受理行@265) | **P3.5** |
| §6A | file-router.js(flush@285-383) | **P3.5** |
| §6A | loopback-sink.js | **不动**(全阶段) |
| §6A | core/addressing.js → re-export(parseAddress@18-24/aliasIndex@27-35) | **P3.5** |
| §6A | core/registry.js → re-export | **P3.5** |
| §6A | core/dedup.js → re-export | **P3.5** |
| §6A | core/store.js → re-export | **P3.5** |
| §6B | bin/session-send 升 v3(+via/ver/ttl、--via;resolve/steer_gate 读共享函数) | **P3** |
| §6B | bin/cb-send v3 升格(旧版留 cb-send.v2) | **P3** |
| §6B | plugins/message-bridge | **无改造**(冻结声明;P4 删除) |
| §6C | a2a http-server.js ①②③+新增④ reader 修复 | **P3** |
| §6D | plugins/orca-callback/pump.js | **过渡期零改动;P4 删除**(改造行删除) |
| §6D | bin/fleet-touch(get_entry@137-141) | **P3**(fleet-resolve 库函数归 P1 交付) |
| §6D | shared/skills/dais-orchestration/SKILL.md(:49-55) | **P3** |
| §6E(新增表) | plugins/callback-bridge/ | **P4** |

2. **新设阶段 P3.5 — host lane 单源化**,插入 §4 的 P3 与 P4 之间,小节文本:

```
### P3.5 — host lane 单源化(生产触碰,需重启窗口;前置: P1(库) + P3(cb-send v3 双跑 ≥1 观察窗))
- 交付: §6A 八行——host-callback-bridge import 换 `_narrow-waist` + core/ 四件原位 re-export;
  bin/dev-sync.sh polyfill 段增 `plugins/_narrow-waist` → `~/.dsh/plugins/_narrow-waist` 同步(§0 约束 5)
- 验证: dev-sync 全量重推 → 重启 :3080 → 外部→DSH 回调冒烟(cb-send ack/done 各 1 条);
  dead.log 零新增;state.json hostBridge.http.counters.failed == 0;死信新 reason 仅限六条基准清单(G.5)
- 回滚: git revert + dev-sync 全量重推 + dev-sync --verify 清零 + 重启 host(§0 约束 5)
- 不动: loopback-sink.js、fleet/registry 格式、a2a 面、bin/、message-bridge
```

   理由(报告二选一"并入 P4 或新设 P3.5"中取 P3.5): P4 已承载 R-B08~R-B13 六条阻断级重写(退役/三面回滚/v4 代差/queen 面),再叠生产最高流量 lane 的 core 换源会让故障归因与回滚粒度双双失效;§6A 是行为保持型改造,值得独立部署观察窗。
3. **session-send 升 v3 钉死 P3**(报告推荐项),与 cb-send 同阶段、共用同一次 bin 镜像重推窗口;P2 的"不动"承诺改写为:"不动(仅限 P2): `bin/session-send`/`bin/cb-send` 在 P2 双跑对拍期间一行不改、不注册 cordis.yml;P3 起按 §6B 行升格"。理由: P2 保持纯新增 adapter 才有可信旧基线,且两个 bin 升格合并到一次镜像重推。
4. **§6B message-bridge 行改造内容整行删除**,改写为冻结声明:"无改造。v1.3 原样运行至 P4 删除;dedup Map(:168-176)/TYPES(:73)/validate(:210-228)/pickRecipient(:414-422) 零改动;dedup 单一化由 host lane 承接;MSGBR] 前缀与四键 canonical line(:305)维持到删除为止(例外清单见 §0 约束 2)。"理由: P4 即删该 532 行插件,任何改造都是短命投资(评审 R-S07 建议项原文)。
5. **§6D pump.js 行的"四处换 import 删内联(~803→~550 行)"整行删除**,改写为:"过渡期零改动——27 项 pump 特有机制(.nw-review-D-raw.md D-F8 清单)天然全保留,该清单转为 P4 callback-bridge 升格时的行为对拍基准;P4 删除 `plugins/orca-callback/`;单源化在 P4 经 callback-bridge/core/ 四文件 re-export `_narrow-waist` 兑现(§6E,内容归 P4 节)。"理由: 改造成果活不过 P4 删目录,两段清单互相拆台(R-B09),取其选项②方向、re-export 移至 P4 兑现。
6. §6C 四点改造(①缺省改 status ②body 纯正文 ③subject 承载 ref ④defaultInboxReader 修复——①②③④内容裁决归 P3 节)阶段归 **P3**;§6D fleet-touch bin 换共享函数归 **P3**;SKILL.md 行归 **P3**。§5C 的第三种归属表述删除(见 G.2)。

- **落点**: plan §4(新增 P3.5 小节、P2"不动"行、P3 交付行点 §6C/§6B 归属)、§6 四表加列与行改写、§1 交付物总览表(P3.5 行、§6E 行)。
- **验收断言**: ①`grep -c "P3.5"` ≥ 5 且 §4 有 P3.5 小节标题;②§6 各表每行"阶段"列非空;③全文无"或 P3 内同步"字样、P2 不动行含"仅限 P2";④message-bridge 行无"dedup 换 createDedupWindow/TYPES 改共享常量"字样;pump 行无"换 import 删内联"字样;⑤P3 交付行含 session-send/cb-send/fleet-touch/SKILL.md,P4 交付行含 callback-bridge/删 orca-callback+message-bridge。

## G.2 [R-S13(阶段面归 G.1)] §5C 风险段:删缓解二,缓解一扩两端 reader 名单

- **裁决**: §5C(232 行版 L217)改写为单一缓解,文本:
  - 缓解二("或 P3 内同步把 session-send 升 v3 统一")**整句删除**——v3 不改 `DSHMSG]` 前缀,"v2→v3"与"有信封行→无信封行"是正交维度,该缓解对分叉无效(评审 R-S13 判维度错配)。
  - 缓解一保留并扩写(原文):"轻/重载分叉的收方 reader 互不相交——轻载线: `bin/session-send` 信封行(:127-129)→ `bin/msg-dedup:4`(消费);重载线: dais body → `plugins/a2a-profile-server/http-server.js` 的 defaultInboxReader/extractRef(:76-82)+ `plugins/a2a-profile-server/executors/dais.js:119-124`。extractRef 天然双格式(`DSHMSG]` json 行 / `[ref:X]` 前缀 / 均不中返 '-'),双格式窗口期零动作。"
- **落点**: plan §6C 末风险段(原 §5C)。
- **验收断言**: 该段无"或 P3 内同步"字样;含 `msg-dedup`、`defaultInboxReader`、`executors/dais.js` 字样各 ≥1 次。

## G.3 [R-B01 + R-S24/D-N3] 词汇表闭集改 18 Signal(增 report)+ 每平面入站白名单常量

- **裁决**:
  1. §2.4 Signal 闭集 **17 → 18**,新增第 18 个 Signal `report`,词汇表新行(原文):

  | 统一 Signal | dais MessageType | DSH type | Orca --type | 语义 |
  |---|---|---|---|---|
  | `report` | — | `report` | — | 中途进度通报/监控告警(event-watchd:259 经 session-send 实发;生产 inbox.log 23 条活跃;OF-006) |

     取"单列第 18 个 Signal"而非"映射 status": `denormalizeType('report','dsh')` 必须原词回译 `'report'`,并入 status 会在回译时改写 wire type、切断 event-watchd 收方按 type 的对账;单列对现网零行为变更。dais/Orca 列为"—"(出站不可译,adapter 拒发并提示,不静默改型)。
  2. §2.4 增**每平面入站白名单常量**(值逐字取自现网点位,禁取 V2_TYPES 顶替——V2_TYPES 7 值不含 status、反多 pong/ask/steer/nack,照做即改行为,D-N3 陷阱):

```
export const DSH_CALLBACK_TYPES  = ['ack','done','ask','report','ping','status']  // 源 http-intake.js:31(host lane 受理面,P3.5 换源时 TYPES := 此常量,值不变)
export const MSGBR_CALLBACK_TYPES = ['ack','done','ping','status']               // 源 message-bridge/index.js:73(P4 前冻结;仅作文档/对拍基准,message-bridge 零改动)
export const A2A_ROUTER_TYPES    = ['notify','steer','ping']                     // 源 a2a http-server.js:58(P3 换源时引用,值不变)
export const CB_SEND_TYPES       = ['ack','done','ping','status']                // 源 bin/cb-send:7 契约注释(v3 升格后值不变)
export const SESSION_SEND_TYPES  = [...V2_TYPES, 'report']                       // 源 session-send:6 文档 7 值 + 线上实发 report(仅文档基准;session-send 无 type 校验代码)
```

  3. P1 验收行(L129"词汇表 17 Signal 全覆盖")改写为:"18 Signal 全覆盖 + 白名单点位全景 ∪ 线上实发类型全覆盖——点位全景: http-intake:31(6 值)/message-bridge:73(4 值)/a2a http-server:58(3 值)/cb-send:7(4 值)/session-send:6(7 值,仅文档)/pump(无白名单);线上实发: inbox.log type 普查(含 report)。每个实测类型经 normalizeType 后 signal 非 null 或显式透传打标。"
- **落点**: plan §2.4(表+常量块)、P1 验收行;库实现在 P1 票(plugins/_narrow-waist/vocabulary.js)。
- **验收断言**: ①修订后方案 §2.4 表含 `report` 行且 Signal 计数表述为 18;②含上述五个常量名与值;③P1 验收行含"点位全景"字样;④vocabulary.test.mjs(P1 票)`normalizeType('report').signal === 'report'`。

## G.4 [R-S33 + R-S09(type/裸行部分)] detectVersion 四态 / normalizeType 三态 / validateEnvelope type 策略

- **裁决**: plan §2.1 的 `parseLine`/`detectVersion` 与 §2.4 的 `normalizeType` 规格替换为(原文):

```
detectVersion(obj)    // → 'v3' | 'v2' | 'legacy' | 'malformed'
  // v3: ver===3;v2: 有 msgid 无 ver;legacy: 无 msgid 无 ver(cb-send 4 键裸行,inbox 主流量);
  // malformed: 非 JSON 对象,或缺 type/from 等必要字段
parseLine(line)       // → {ok, rawVersion: 3|2|null, …}
  // v2 → upgradeV2toV3 补齐后走 v3 路由;
  // legacy → 原样透传(键数不变),ref 从 body '[ref:]' 前缀提取,按旧式 parseAddress 路由(cb-send v1 语义);
  // malformed → {ok:false, errors[]},交应用层处置(file-router/pump 现行为: undertaker 门控死信,逐字保留)
normalizeType(rawType)   // 三态: 已知(18 Signal)→{signal,source};未知非空字符串→{signal:null,source:raw} 透传;
  // 空串/非字符串→{signal:null,source:null}。不做大小写归一("Status"→signal:null——归一会静默改 wire 值)
```

  validateEnvelope 对 type **只校验非空字符串,不查闭集**;闭集校验留在各 intake 应用层白名单常量(G.3)。closed-set 拒收现网先例(http-intake:89-91、http-server:142-144)维持在各 intake,不升入库。
- **落点**: plan §2.1/§2.4;库实现在 P1 票(envelope.js/vocabulary.js);消费侧接入在 P3.5(file-router)。
- **验收断言**(P1 单测): ①`parseLine('{"type":"ack","from":"a@x","to":"b","body":"[ref:r1] hi"}')` → ok 且 rawVersion===null 且 ref==='r1'、输出键数==4;②7 键 v2 样本→rawVersion:2;v3→3;`not json`→ok:false;③`normalizeType('report')`→{signal:'report'};`normalizeType('Status')`→{signal:null,source:'Status'};`normalizeType('')`→{signal:null,source:null};④存量值直通用例: 'direct'/'status' 经 normalizeType 不抛、signal 值符合映射表。

## G.5 [R-S09(ttl/via 部分)+ E-S07] ttl/via 执行规格 + 死信 reason 六条对账基准

- **裁决**: plan §2.1 增导出、§3 的 via/ttl 行补执行规格(原文):

```
enforceHopBudget(envelope, adapterId)   // 入站判定(仅对 v3 信封;v2/legacy 行直接放行)
  // ① via 链(逗号分隔)已含 adapterId → {ok:false, reason:`loop-detected: adapter '<id>' already in via chain '<via>'`}
  // ② ttl-1 后 ≤0            → {ok:false, reason:`ttl-exhausted: ttl=<n> at '<id>' (via='<via>')`}
  // ③ 通过                    → {ok:true, envelope:{…env, ttl: ttl-1}}
appendVia(via, adapterId)               // 出站: 链尾追加;重复段/空段拒绝(validate 同规)
```

  执行规格:
  1. **入站减**: 减跳点 = **转发型 adapter 的入站点**(把信封再投到另一平面的点: a2a http-server 重载分支投递前、P4 后 callback-bridge 汇聚点)。同平面终端消费(host lane 泵消费 inbox 行)不减——"跳"= 跨平面转发;纯生产者(session-send/cb-send)只铸造不判定。createEnvelope 缺省 ttl=5 → 允许经过 4 个转发 adapter,第 5 个入站点判死。
  2. **环回拒发**: 入站点发现 via 链含本 adapterId → 死信(HTTP 受理面同步 4xx + counters.rejected++,文件面直接 dead.log),不投递、不落 inbox。
  3. **死信落点**: 与 unknown-addressee 同构——file-router flush() 死信路径(undertaker 门控,落 `bridge/dead.log`)。
  4. **via 参数解析**(与 session-send `--via` 联动): 逗号分隔、段禁空串、禁重复段;违例 validateEnvelope 报 error(400)。
  5. **死信 reason 对账基准清单**(§6A addressing 行"'dead' reason 措辞逐字保留"条款扩写为): 现有四条逐字保留——`unknown-addressee: "to" field is missing or not a non-empty string` / `unknown-addressee: no registered consumer with sessionId <sid>` / `unknown-addressee: "<name>" is neither a registered sessionId nor a resolvable alias` / `unknown-addressee: alias "<name>" is ambiguous across <N> registered consumers; use <alias>@<sessionId>`——**加** `ttl-exhausted: …`、`loop-detected: …` 共六条为对账基准;新增 reason(如 R-B15 撞名裁决若新增)必须先入清单再上线。
- **落点**: plan §2.1(函数块)/§3(ttl/via 行)/§6A addressing 行;库实现在 P1 票(envelope.js),接入在 P3/P3.5 票。
- **验收断言**: ①P1 单测: ttl=1 入站→reason 前缀 `ttl-exhausted:`;via='a,b' 且 adapterId='b'→`loop-detected:`;ttl=5 第 4 跳过/第 5 跳死;via='a,,b'→validate error;v2/legacy 行经 enforceHopBudget 原样返回;②P3.5 冒烟后 dead.log 新增行(若有)reason 全部可被六条基准 grep 命中。

## G.6 [R-S32 + E-S12] 信封大小预算三档 + 超限行为

- **裁决**: §3 schema 表新增"大小预算"行并附规定(原文):
  - 三档: ①a2a heavy 阈值 256B(http-server.js:103)——§6C② 落地后 body 纯正文、信封头走结构化参数,v3 头不再挤占该档;②单行 ≤4096B(含 `DSHMSG]`/`MSGBR]` 前缀;`shared/maestro-bridge/SKILL.md:68` PTY 上限)——v3 头部净增 ≈25-40B(`,"ver":3,"via":"…","ttl":n`,via 每跳 +len(id)+1),body 预算收窄为 4096 − 头部开销;③HTTP body ≤256KB(http-intake.js:29 / http-server.js:42)——v3 增量可忽略,维持现状不新增校验。
  - 超限行为: **拒、不截断**——发送侧(session-send/cb-send v3)在 serializeLine 后测长,`line.length > 4096` → exit 非 0 + stderr 提示"body exceeds 4KB line budget; write long content to a file and pass the path (SKILL.md:68)";受理侧不新增校验。
  - 对拍用例: 4096 边界样本(body 长度使 v2 行 ≤4096 而 v3 行 >4096)——断言 v3 路拒+提示、v2 路成功,差异为已知收窄。
- **落点**: plan §3(新增行);发送侧测长实现在 P3 票;边界用例进 envelope.test.mjs(P1)与 p3 对拍脚本(P3)。
- **验收断言**: 修订后 §3 含"大小预算"行与 256B/4096B/256KB 三档数值;envelope.test.mjs 含 4095/4097 两枚边界用例;p3-cb-send-a-b-test.sh 含 4096±10 样本。

## G.7 [R-S10 + E-S05 + E-S06] 验收可观测改写(:3081 沙箱 / A2A_DAIS_DB / 24h 可判定断言)

- **裁决**:
  1. 全方案验收统一声明: P2/P3 对拍一律打沙箱 :3081 DSH 面(`/home/yy/tools/dsh-comm-sandbox/run.sh` 支撑,实测在线);生产 :3080 仅 P3.5/P4 冒烟触达(§0 约束 4)。
  2. **P3 验证行改写**(原文):
```
- 验证: 沙箱 :3081(DSH 面, /home/yy/tools/dsh-comm-sandbox/run.sh)+ 沙箱 a2a 面:
  起沙箱 a2a server 前导出 A2A_DAIS_DB="$SB/tmp/a2a-dais.db"(注入点已存在: http-server.js:72 daisDbPath),
  断言全部打该临时库——①新投递行 body NOT LIKE 'DSHMSG]%'(sqlite3 COUNT==0);②message_type ∈ dais 9 值闭集;
  ③subject == ref 可查;④agents/inbox RPC 返回 ref == subject 值。禁止读写生产 ~/.local/state/dais/warp.sqlite。
  orca adapter 投递后 Run inbox 可被 parseLine 解析;cb-send 新旧对拍按通道分列判据(权威见 P3b 节)。
```
  3. **P4 "24h 无回归"改写为可判定断言**(原文):
```
- 24h 可判定断言: (硬门)①~/.dsh/maestro/bridge/dead.log 行数与冒烟基线差 == 0;
  ②state.json hostBridge.http.counters.failed == 冒烟基线(==0);
  ③~/.dsh/plugins/a2a-profile-server/state/*/router-journal.jsonl 24h 无 "delivered":"failed" 行且 mailbox 投递 >0;
  (观测)④file-router counters(state.json hostBridge 镜像): deadCount 零增、deliveredLines 单调增、dedupCount 增幅 ≤ 冒烟期 ×2;
  ⑤五路径冒烟各 ≥1 条 delivered 且 msgid 唯一(inbox.log 采样 + jq 去重断言)。
```
  4. 说明注: §6C 顺带修 daisDbPath 缺省(0 字节 data.sqlite → ~/.local/state/dais/warp.sqlite)的内容裁决归 P3 节;本条只钉"验收断言必须显式指定库路径与环境变量、禁止打生产库"的格式要求。P5 复用同一沙箱 dais 落点(R-S25 归 P5 节)。
- **落点**: plan P3/P4 验证行、P2 验证行(补 :3081 来源句)。
- **验收断言**: 修订后 P3 验证含 `A2A_DAIS_DB` 与 `dsh-comm-sandbox/run.sh` 字样;P4 验证含"dead.log 行数差 == 0"“failed == 冒烟基线”"router-journal"三断言;全文无孤立的"24h 无回归"无判据表述。

## G.8 [R-S17 + R-S18/E-S11] AGENT_CARD 降可选 + 路径修正;downgradeV3toV2 降测试辅助

- **裁决**:
  1. **AGENT_CARD.json 从 §1 交付物总览表与 P4 必交付清单中移除**,降级为"可选附录(P4 后按需)": 默认不做;若启动,路径修正为 `shared/maestro-bridge/AGENT_CARD.json`(与 SKILL.md 同目录;仓内不存在 `shared/skills/maestro-bridge/`——`shared/skills/` 下只有 `dais-orchestration/`),且前置条件 = 先落地一个机读消费者(如 dais/orca adapter 启动时能力发现),否则不创建;可参照 a2a 标准端点 `/.well-known/agent-card.json`(http-server.js:630)。理由: 全仓零消费者,排期性价比低(评审 R-S17 建议项)。
  2. **downgradeV3toV2 从一等导出降为测试辅助**: §2.1 该行标注"(测试辅助: 不进 index.js 桶导出,仅 envelope.js 命名导出供 envelope.test.mjs round-trip 用;无生产调用方——OG5 严格超集下 v2 消费者忽略未知键)"。P2 对拍判据按 R-B05 选项(a)结构等价,不依赖降级器(R-B05 内容归 P2 节)。
- **落点**: plan §1 表、P4 交付行、§2.1。
- **验收断言**: 修订后 P4 交付行无 AGENT_CARD.json 必交付字样(仅可选附录提及,且路径为 `shared/maestro-bridge/`);`grep "shared/skills/maestro-bridge" docs/narrow-waist-implementation-plan.md` 零命中;§2.1 downgrade 行含"测试辅助"。

## G.9 [R-B17/R-S15 机制层 + R-S02 关联] §0 约束 2 显式例外清单(权威裁决 = P3b 节)

- **裁决**: §0 约束 2 追加条款(原文):
```
约束 2 例外清单(载体落盘行允许透传 msgid/v3 字段的平面——权威裁决见 P3b 节[R-B17/R-S02 三选一]):
仅 P3b 节明列的受理落盘行(http-intake.js:265 canonical line 与/或 message-bridge index.js:305 canonical line)
按其裁决开例;清单外载体——SQLite messages 表 schema、session.prompt RPC wire、PTY 字节流、
ORCA-CB]/DSH-RE]/DSHMSG] 前缀行格式——一律不动。凡开例的行,其对拍断言与 MSGBR]/ORCA-CB] 面的
格式影响须同步写入 P3 验收(按通道分列)。本清单是唯一开例通道: 新增例外必须先修订本清单再实施。
```
  理由: 载体一字不动与"msgid 去重主键"存在结构性张力(评审 §4①),例外必须显式枚举、单一权威源(P3b 节),防止"顺手透传"在未评审平面上扩散。
- **落点**: plan §0 约束 2;开例的具体实施(若 P3b 裁透传)归 P3 票。
- **验收断言**: 修订后 §0 约束 2 含"例外清单"条款并逐字引用 P3b 节;P3 验收含按通道分列的对拍判据句。

## G.10 [R-B13 + R-B10(方案级)] §0 新增约束 5"部署面"(dev-sync 三面 + _narrow-waist 同步)

- **裁决**: §0 新增第 5 条约束(原文):
```
5. **部署面**——生产运行面不经仓直接加载,三面全由 bin/dev-sync.sh 推送:
   ①装点 ~/.dsh/.agent-presets/maestro(rsync -a --delete;dev-sync.sh DST@16/推送@57);
   ②bin 镜像 ~/.dsh/maestro/bin(:24/:69,cb-send/session-send 稳定回退路径);
   ③polyfill lane ~/.dsh/plugins/host-callback-bridge(:78-84,自包含单目录 rm -rf+cp -a 拷贝)。
   规定: (a) dev-sync polyfill 段增 plugins/_narrow-waist → ~/.dsh/plugins/_narrow-waist 同步拷贝,
   --verify 报告覆盖之——否则 §6A 的 import '../_narrow-waist/…' 在装点解析为 ENOENT、宿主回调链路静默全断;
   (b) 任何阶段交付触碰 plugins/host-callback-bridge/**、plugins/_narrow-waist/**、bin/**,其交付链必含
   "dev-sync 全量重推",回滚链必含 "git revert + dev-sync 全量重推 + --verify 清零 + 重启 host";
   (c) "git 操作 = 回滚"单独出现即违规——git 只改仓(worktree),不触达任何运行面。
```
  理由: polyfill lane 是自包含单目录拷贝,`_narrow-waist` 不同步则 §6A 换 import 后装点模块不存在(R-B13);回滚不补 dev-sync 三面重推等于没有回滚(R-B10)——两条在此上升为方案级约束,各阶段回滚细则由对应节展开。
- **落点**: plan §0;dev-sync.sh 实际改造(增 `_narrow-waist` 拷贝段)归 P3.5 票;P4 回滚三段式细则归 P4 节。
- **验收断言**: 修订后 §0 有约束 5,含三面路径与 (a)(b)(c);P3.5 交付行引用"dev-sync `_narrow-waist` 同步";全文无"回滚 = git revert …+ 重启 host"而不含 dev-sync 重推的表述(P2/P3 回滚行同步修正)。

---

# NW-SPEC §P1 — 共享库最终 API 规格(最终裁决版)

> sectionId=P1。裁决对象: `plugins/_narrow-waist/` 共享库 envelope/addressing/dedup/vocabulary(+registry 并入 addressing)逐 API。
> 输入: 评审报告 `docs/reports/nw-plan-review-report.md`(R-B*/R-S* 编号,权威)、现方案 `docs/narrow-waist-implementation-plan.md`(232 行版)、D/E 路原始材料、源码亲证(行号可漂,一律函数名锚定)。
> 本节为单一裁决版本,无备选、无开放问题;报告给出的二选一均已拍板并附一句理由。
> 配套实施票: T2(0008)。本节中标注「非 T2」的落点归后续 adapter 票,库规格只负责让这些落点可零改动接入。

## P1.0 模块布局、分发与依赖约束

```
plugins/_narrow-waist/
├── package.json        # {"name":"@maestro/narrow-waist","type":"module","private":true} — 零依赖
├── index.js            # 桶导出(唯一入口)
├── envelope.js         # 信封 v3: 构造/校验/序列化/解析/v2 互转 + 版本四态
├── addressing.js       # agent:// URI + fleet/registry 联合寻址 + 路由裁定(双视角) + registry 读写链
├── dedup.js            # msgid 铸造 + 双键去重窗口
└── vocabulary.js       # 18 Signal 词汇表 + 三平面映射 + 每平面入站白名单常量
测试: envelope.test.mjs / addressing.test.mjs / dedup.test.mjs / vocabulary.test.mjs
```

- [裁决] registry 函数**并入 addressing.js**(不设独立 registry.js/store.js 文件): 寻址读表与注册表写链同域,五文件清单不变;`core/registry.js` 原位 re-export 兼容。理由: preset 目录复制分发下文件数即分发面,收敛到五文件与方案 §2 树一致,且 registry 读写只服务寻址面。
- [裁决] `package.json` 必带 `"type":"module"`: 仓无根 package.json,adapter 以 `../_narrow-waist/*.js` 相对引入时,模块类型由 `_narrow-waist` 最近 package.json 判定;缺它则 .js 按 CJS 解析、import 语法直接炸。理由: message-bridge/host-callback-bridge 各自 package.json 已是同一先例。
- [约束沿用] `node:*` 内建之外零依赖;纯函数 + 显式注入(bridgeDir/fleet/registry/now 均参数),不读环境变量、不触 `~/.dsh`(R-S31 的库侧前提)。

---

## P1.1 dedup.js — 双键去重窗口

### P1.1.1 [R-B16 + R-B03] digest 材料分流 + mark 双记两键

**引用**: R-B16(digestOf 默认 v3 模式对无 msgid 行产出 `from\0undefined` 恒等摘要,60s 窗内同 from 不同消息被误判重吞)、R-B03(升级期双查只规定读侧无"双记",v3 先投只记 msgid → v2 重发双查全 miss → 重复投递)。

**裁决(写进方案 §2.3 的替换文本)**:

```js
forgeMsgid()                       // randomUUID(session-send:123 uuid4 同构)
digestOf(line, parsed)             // 兼容层,body 键(逐字平移 core/dedup.js digestOf):
                                   //   from 非字符串 → sha256(line)  ← from 缺失整行回退
                                   //   否则         → sha256(`${from}\u0000${body}`),body 缺失取 ''
dedupKeys(line, parsed)            // → { msgidKey?: string, digest: string }
                                   //   msgidKey = parsed.msgid 为非空字符串时
                                   //              `m\u0000${from ?? ''}\u0000${msgid}`,否则 undefined
createDedupWindow({ windowMs = 60_000, now = () => Date.now() })
// → { seen(key), mark(key, meta = null), prune(), get size }   ← 四键名不变,meta 进签名(R-S01③)
//   seen(key) → 窗口内命中返回 { deliveredAt, meta },否则 undefined
//   mark(key, meta) → 记 { deliveredAt: now(), meta } 并顺带剪枝
seenAny(win, keys)                 // 双查: keys.msgidKey 先、keys.digest 后 → entry | undefined
markAll(win, keys, meta = null)    // 双记: msgidKey(若存在)+ digest 两键同刻写入(同一时间戳、同一 meta)
```

- **材料分流(R-B16 根除)**: 一条行的去重身份主键材料 = `from\0(parsed.msgid ?? parsed.body)`——有 msgid 用 msgid、无 msgid 用 body;`from` 缺失(非字符串)时整行回退 `sha256(line)`。无 msgid 行的身份键就是 body 键(digest),**任何路径都不存在 `from\0undefined` 材料**。
- **双记(R-B03 根除)**: markAll 在 mark 时同时写入 msgid 键与 body 键。由此四向重放全部命中:
  ① v3 投(记 m:from\0msgid + d:from\0body)→ 同 v3 重发: msgidKey 命中;② v3 投 → 同内容 v2/4 键重发(无 msgid): digest 命中;③ v2/4 键投(只记 digest)→ 同 4 键重发: digest 命中;④ v2 投 → 同内容 v3 重发(新 msgid): digest 命中(与 core 现行为一致,升级窗语义)。
- **调用面兼容**: 现有调用点(`file-router.js` flush 内 `const digest = digestOf(line, value)`、`http-intake.js` 受理面同款)传字符串键、只调 seen/mark 单键——窗口 API 对字符串键行为与 core/dedup.js 逐字一致,原位 re-export 零改动;seenAny/markAll 供 v3 升级后的调用方使用(升级期双查=seenAny;退役后可退回单查,方案 L75 表述保留)。
- **单实例跨面共享不变**: HTTP 受理面与文件消费面共享同一窗口实例(host lane 现状,index.js 组装处单例),库不内建实例、不提供全局单例。

**落点**: 新建 `plugins/_narrow-waist/dedup.js`;兼容基准 = `plugins/host-callback-bridge/core/dedup.js` digestOf()/createDedupWindow()(与 pump.js 内联 digestOf 逐字同源,D-VO2 已核);调用面锚点 file-router.js flush() 内 `digestOf(line, value)`、http-intake.js 受理面 `digestOf(line, payload)`。

**验收断言**:
1. `digestOf(JSON.stringify({from:'a',body:'x'}), {from:'a',body:'x'}) === digestOf(同line, {from:'a',body:'x',msgid:'m1'})`——digest 与 msgid 无关(body 键稳定)。
2. `dedupKeys(line4key, parsed4key).msgidKey === undefined`;`dedupKeys(lineV3, parsedV3).msgidKey === 'm\0a\0<msgid>'`。
3. 无 msgid 行零误判重(R-B16 断言): 同 from 两条**不同 body** 的 4 键行,60s 窗内先后 markAll 后 seenAny 第二条 → undefined(第二条不被判重)。
4. 双向重放(R-B03 断言): 上列 ①②③④ 四场景 seenAny 全部命中(④ 用新 uuid 的 msgid 仍命中)。
5. from 缺失整行回退: `parsed = {body:'x'}` 时 digestOf === sha256(line)(与 core 逐字断言,直接对 core 实现输出比对)。

### P1.1.2 [R-S01] mark 时机、兼容签名、meta、windowMs 默认

**引用**: R-S01①(共享窗口若 seen 时即 mark,wake 失败重试得 208"已投递"而实际未投)、②(digestOf(line,parsed) 与方案 (envelope,mode) 不同构)、③(208 回放 id 语义靠 meta 承载,四键签名漏 meta 实施者会漏接)。

**裁决**:
- ① **mark 时机不变量(写进 §2.3,库侧为文档化契约+单测锁定,不在库内实现状态机)**: `mark/markAll 仅在 pending 行全部目标终态(全部送达或全部死信)后由调用方执行`——即 file-router deliverPending() 的 `attempts.size === 0` 才 mark 语义与 pump 的 wake 成功后 `rt.dedup.set` 语义;`seen/seenAny 绝不隐式 mark、命中不刷新 deliveredAt`。attempts 状态机、退避、死信全部留应用层,不升入库。
- ② **签名兼容层**: 库导出名 `digestOf(line, parsed)` 与 core/ 逐字同构;方案原文"与 core/dedup.js 逐字兼容"表述修正为"摘要材料公式逐字一致 + 保留 (line,parsed) 签名兼容层供原位 re-export";不导出 `(envelope, mode='v3')` 形态(该形态即 R-B16 事故源,废弃)。
- ③ **meta 进返回形状**: `mark(key, meta = null)` / `seen(key) → {deliveredAt, meta}` 写死进签名与文档——message-bridge/http-intake 的 208 回放 `id: prior.meta ?? null` / `prior.id` 依赖此通道;markAll 的两键共享同一 meta。
- **windowMs 默认 60_000**(core 版无默认,pump/message-bridge/http-intake 三处各自传 60s): 缺省值文档化为"对齐三处 60s 窗口",显式传参覆盖。

**落点**: `plugins/_narrow-waist/dedup.js` JSDoc 契约段;调用序锚点 file-router.js deliverPending()(全部终态才 mark)、pump.js flush() wake 成功后 mark、message-bridge index.js 208 应答(prior.id)。

**验收断言**:
1. seen 命中后窗口 `size` 不变、原 entry deliveredAt 不变(隐式 mark 禁止)。
2. mark('k','id-1') 后 seen('k') → `{deliveredAt:Number, meta:'id-1'}`;mark 不传 meta → meta===null。
3. `createDedupWindow({})` 可构造且注入假 clock(`now`)时 61s 过期剪枝、59s 内命中(windowMs 默认与窗口语义)。
4. dedup.test.mjs 内以 core/dedup.js 为 oracle: 同输入下库 digestOf 与 core digestOf 输出逐字节相等(临时 import core 文件比对,只读)。

---

## P1.2 addressing.js — 路由裁定与联合寻址

### P1.2.1 [R-B02 + R-S28] resolveRouting 统一形状: 底层原签名 + 门面双视角

**引用**: R-B02(pump 与 host 两套 resolveRouting 形状不兼容: broadcast 无条件 wake vs 零在册 skip;skip 含义相反;wake 的 sids pump 无而 host 裸解引用)、R-S28(pump 原签名 `(address, self, registry)` self 在第二参,库若换序则 pump 全部调用点错位传参路由全错)。

**裁决(写进方案 §2.2/§6A/§6D 的替换文本)**——三个导出,一个门面:

```js
// ① 底层(泵视角,pump 调用点零改动的前提):
resolveRouting(address, self, registry)
//   原名、原参数序、原判定语义逐字平移 pump.js resolveRouting();
//   唯一增强: 两个 wake 返回追加 sids: [self.sessionId](泵调用点不读该键,零影响)。
//   → { action:'wake', broadcast, sids:[self.sessionId] } | { action:'skip' } | { action:'dead', reason }

// ② 统一门面(新代码一律用它):
resolveRoutingUnified(addr, registry, { self } = {})
//   self 缺省 = 宿主视角(host lane): 判定逻辑与 core/addressing.js resolveHostRouting() 逐字一致
//     - broadcast → sids = Object.keys(registry.consumers)(快照);
//                   空集 → { action:'skip' };非空 → { action:'wake', broadcast:true, sids(全集) }
//     - invalid / qualified / bare 判定与 reason 逐字同 resolveHostRouting,wake 恒带 sids:[目标]
//   self = { sessionId, alias? } = 泵视角: 委托底层①,返回恒带 sids:[self.sessionId]
//     - broadcast → 恒 { action:'wake', broadcast:true, sids:[self.sessionId] }(泵无条件 wake-self)
//   → wake 形状恒含非空 sids 数组(两视角必填);skip 形状恒为 { action:'skip' }(无 sids 键)

// ③ 兼容别名(原位 re-export 用,host lane 调用点零改动):
resolveHostRouting(address, registry)   // = resolveRoutingUnified(address, registry, {}),逐字保留现导出名
```

- **sids 两种形状必填**: 宿主视角 sids=目标全集(含 broadcast 全集);泵视角 sids=只含 self.sessionId。文件消费面据此 `sids.length` 分配 attempts——sids 缺失即 TypeError 静默停摆(R-B02 影响①)在库侧根除。
- **skip 语义按调用方钉死(JSDoc 双句)**: 宿主 lane 的 skip = "广播零在册,该行整体越过,不投递不死信,计数 skippedCount,游标推进";泵的 skip = "该行属其他在册消费者,本消费者越过,游标推进不阻塞自身"。两者都不重试、不落 dead.log。
- **dead reason 四条逐字保留**(死信对账基准,两视角共用同一组字面):
  1. `unknown-addressee: "to" field is missing or not a non-empty string`
  2. `unknown-addressee: no registered consumer with sessionId ${sessionId}`
  3. `unknown-addressee: "${name}" is neither a registered sessionId nor a resolvable alias`
  4. `unknown-addressee: alias "${name}" is ambiguous across ${holders.length} registered consumers; use <alias>@<sessionId>`
- **配套落点(非 T2,归 host-lane adapter 票,此处钉死以防丢)**: file-router.js flush() 内 `routing.sids.length` 处增防御(`routing.sids?.length ?? 0` 视为 skip 并 console.error);host-callback-bridge/index.js 组装处 `router.flush().catch(()=>{})` 的静默 catch 改 `console.error`。方案 §6A 对应行补这两句。

**落点**: 新建 `plugins/_narrow-waist/addressing.js`;兼容基准 = pump.js resolveRouting()(底层)、core/addressing.js resolveHostRouting()(宿主视角);pump 调用点锚点 pump.js flush() 内 `resolveRouting(parseAddress(toValue), {sessionId, alias}, registry)`;host 调用点锚点 file-router.js flush() 内 `resolveHostRouting(parseAddress(toValue), registry)`。

**验收断言**:
1. broadcast/skip 分支(宿主视角): 空 registry + to:'\*' → `{action:'skip'}`;两消费者 registry + to:'\*' → `{action:'wake',broadcast:true,sids}` 且 sids 恰为两 sid 全集。
2. broadcast/skip 分支(泵视角): 同一空 registry,self 给定 + to:'\*' → `{action:'wake',broadcast:true,sids:[self.sessionId]}`(恒 wake-self,不查 registry)。
3. 泵视角 skip 分支: to 指向其他在册 sid → `{action:'skip'}`;to=裸别名唯一持有者=他人 → skip;=self → wake。
4. 四条 dead reason 与 core/addressing.js、pump.js 两处现实现逐字节相等(测试内 import 两文件作 oracle 比对)。
5. 底层签名回归: `resolveRouting({kind:'qualified',alias:'a',sessionId:S}, {sessionId:S2,alias:'a'}, reg)` 语义 = pump 现行为(self 优先/他册 skip/未册 dead reason 2)——参数序陷阱(R-S28)用例化。

### P1.2.2 [R-B15] resolveAddress 跨表撞名 → 显式死信 + ambiguous 标记

**引用**: R-B15(alias 与 fleet code 同名时 `alias 查 registry > fleet code` 优先级导致静默错投、无死信无对账;dead.log 已有 orch1 歧义实证;plane 判定连带错)。

**裁决**: 撞名改**显式死信**而非仅打标记。理由: "错投比拒收危险"(message-bridge 注释原话),`ambiguous:true` 若不拒发只是更可见的错投;死信进 dead.log 才有对账痕迹。

- `resolveAddress(parsed, fleet, registry)` 为**发送侧**联合解析(选 plane/handle),与消费侧 resolveRouting 族分离;成功形状沿用方案 L61: `{ok:true, plane:'dsh'|'orca'|'dais', handle, sessionId, alias}`;失败形状 `{ok:false, reason, ambiguous?}`。
- **判定序(替换方案 L62 优先级行)**:
  1. `broadcast(*)` → `{ok:true, broadcast:true, plane:null, handle:'*'}`(形状合法即通过,展开由 adapter 面;库不猜 plane);
  2. `qualified(alias@sid)` → registry.consumers[sid] 在册 → ok(plane 按条目);否则 fleet 侧按 sessionId 匹配条目 → ok(plane 按条目);否则 `{ok:false, reason:<reason ② 逐字>}`;
  3. `bare N`:
     a. registry.consumers[N] 在册(裸 sessionId)→ ok(plane 判定见下);
     b. **撞名检测**: `fleet.fleet[N]` 为对象(精确 fleet code)**且** aliasIndex(registry).get(N) 非空 → `{ok:false, ambiguous:true, reason:`collision: bare name "${N}" is both a fleet code and a registered alias; use <alias>@<sessionId>`}`;
     c. alias 唯一持有者 → ok(handle=持有者 sid);
     d. alias 多持有者 → `{ok:false, ambiguous:true, reason:<reason ④ 逐字>}`;
     e. fleet code(经 P1.2.3 findFleetEntry 'prefix' 模式)→ ok(handle=entry.sessionId,plane 按条目);
     f. 其余 → `{ok:false, reason:<reason ③ 逐字>}`。
  - 优先级保持 `alias > fleet code`(方案 L62 原序)——撞名由 b 拦截,残余组合无歧义;撞名检测只对 fleet **精确键**,前缀命中不计入(session-send 前缀回退行为须逐字保持,见 P1.2.3)。
- **plane 判定(L63 原文保留)**: sessionId 'session-' 前缀 → 'dsh';fleet 条目 kind='orca-terminal' → 'orca';'ctx_'/'session_' 前缀 → 'dais';缺省 'dsh'。
- **消费侧不引入 fleet**: resolveRouting 族(底层/门面/resolveHostRouting)仍只查 registry,pump/host lane 行为零变化;撞名防线只在发送侧 resolveAddress。

**落点**: 新建 `plugins/_narrow-waist/addressing.js` resolveAddress();撞名证据锚 = `~/.dsh/maestro/bridge/dead.log` orch1 行、session-send 文档注释 fleet code 示例名。

**验收断言**:
1. fleet 含精确 code `orch1` 且 registry 有 alias `orch1`(任意持有数) → resolveAddress 返回 `{ok:false, ambiguous:true}`,reason 逐字等于上列 collision 字面。
2. 同名仅 fleet 侧存在 → 走 e 分支 ok;同名仅 alias 侧唯一持有 → 走 c 分支 ok(撞名不误伤单侧)。
3. 多持有者 alias(d 分支)reason 与 reason ④ 逐字节相等且 ambiguous===true。
4. P1 验收(L129)补句落实: "旧式短码解析结果与 session-send resolve() 一致"用例 + "跨表撞名用例"各 ≥1 条进 addressing.test.mjs。

### P1.2.3 [R-S04 + R-S05] 库内 entry-level 查表函数(exact/prefix 两模式)

**引用**: R-S04(steer 闸查表梯 fleet 精确→前缀与 resolveAddress 全梯不同,混用则 no-entry 放行变 exit 4 拒绝、可拦集合静默扩大;库内须提供独立 entry-level 查表,与路由 resolveAddress 分离)、R-S05(fleet-touch get_entry 仅精确命中否则 die;session-send resolve 含前缀回退——朴素合并破坏 claim/heartbeat/release 零变化)。

**裁决**:

```js
findFleetEntry(fleet, key, { mode = 'prefix' } = {})
// mode 'exact'  : fleet?.fleet?.[key] 为非空对象 → 返回该 entry;否则 undefined。
//                 绝不前缀回退(fleet-touch get_entry 语义;miss 处置(die/exit 1)留调用方)。
// mode 'prefix' : 先精确;miss 后按 Object.entries 迭代序返回第一个
//                 entry.sessionId?.startsWith('session-' + key) 的条目;双 miss → undefined。
//                 (session-send resolve()/find_entry 语义逐字,含迭代序,保证短码解析结果一致)
resolveFleetSessionId(fleet, key)   // 薄包装: findFleetEntry(fleet, key, {mode:'prefix'})?.sessionId ?? undefined
```

- **与路由分离**: findFleetEntry 只回答"条目在不在、是哪条"(entry-level),不判 plane、不做撞名检测、不抛不 exit;resolveAddress/steer 闸/fleet-touch 各自选模式组合。模式默认 'prefix' 仅为对齐 session-send(最常用调用面);fleet-touch 全部命令改调 `{mode:'exact'}`。
- **steer 闸三方联动(R-S04 细节,写进 §6B)**: steer_gate 的属主判定读条目改 `findFleetEntry(fleet, to, {mode:'prefix'})`(与现 find_entry 同梯,行为零变化);exit 4 语义/stderr 文案/fleet-conflicts.jsonl/steer-journal.jsonl 三件套**留应用层逐字复刻**,不升入库(双写一致性归 P2 对拍票,R-S29)。

**落点**: 新建 `plugins/_narrow-waist/addressing.js` findFleetEntry/resolveFleetSessionId;语义 oracle = session-send resolve()/find_entry()、fleet-touch get_entry()。

**验收断言**:
1. exact 模式: fleet 有 `2437` 精确键、另有 sessionId 以 `session-2437…` 开头的其他条目 → findFleetEntry(fleet,'2437',{mode:'exact'}) 只认精确键;删精确键后 exact → undefined(绝不静默命中前缀条目,R-S05 防线)。
2. prefix 模式: 无精确键、唯一前缀命中 → 返回该条目;与 session-send resolve() 同输入输出 sessionId 一致(测试内以固定 fleet fixture 双跑比对)。
3. resolveFleetSessionId 双 miss → undefined(不 exit、不抛——进程退出留调用方)。

### P1.2.4 [R-B04 + R-B14] registry: version 挂顶层沿用 + 写路径并入 v3.6 写链语义

**引用**: R-B04(consumer 条目增 version 与 sanitize 白名单 {alias,pid,armedAt} 不变自相矛盾,字段被每次读改写剥掉,特性自毁)、R-B14(共享库版若沿用 core 的固定 tmp+无链写,同进程多 pump 并发 registerSelf 撞同一 tmp → ENOENT/丢更新,v3.6 修掉的事故复活;反向 core/store.js 已有写链+唯一 tmp)。

**裁决**:

```js
sanitizeConsumers(raw)          // 逐字平移 core/registry.js;白名单三键 {alias,pid,armedAt} 不动
readRegistry(registryPath)      // 逐字平移;顶层 version 字段沿用(下述 R-B04 拍板)
writeRegistryAtomic(registryPath, registry)
//   签名不变;内部 tmp 名改唯一: `${registryPath}.tmp-${process.pid}-${++seq}`(对齐 core/store.js saveState 模式)
registerConsumer(registryPath, version, consumer, { armedAt, pid })   // 签名不变;内部经串行链
unregisterConsumer(registryPath, version, sessionId)                  // 签名不变;内部经串行链
```

- **R-B04 拍板(二选一取后者)**: **沿用顶层 `registry.version` 承载代际,consumer 条目不加 version 字段,sanitize 白名单零变更**。理由: 白名单不动即无"写读不对称自毁"面,pump.js 与两份 core 副本零同步成本,顶层 version 字段现成(pump.js writeRegistryAtomic 前 `current.version = version` 同款)。方案 §6A registry 行"consumer 条目增 version 字段(缺省 null…)"整句**删除**,替换为"代际沿用顶层 registry.version(现状),consumer 条目形状不变"。
- **R-B14 拍板(写链语义)**: 共享库 registry 写路径**并入 pump v3.6 写链语义** = 唯一 tmp 名 + 进程内串行化。实现: 模块级 `Map<resolvedRegistryPath, Promise>` 操作链(register/unregister 的读-改-写全程串行,链语义对齐 pump.js registryOpChain);唯一 tmp 名取代 core 版固定 `${path}.tmp`。方案 §6A L197 现状描述"原子读写"修正为"单次写原子、读改写无链(待并入 v3.6 写链)";§6D pump 全保留清单显式加"registryOpChain 保留(pump 侧内联链与库链等价后可换,见 D-N1)"。
- **签名兼容**: 五函数签名/模块约定与 core/registry.js 逐字一致,`core/registry.js` 原位变 re-export,http-intake.js register 面(pump.js registerSelf/unregisterSelf 同族)零改动。
- **跨进程 LWW 界定(R-S12 库侧承诺范围)**: 进程内串行化+唯一 tmp 只修同进程多 watcher 并发(slots 常态);跨进程 LWW 竞窗与现状相同,不引入 flock(评估结论写进方案 §6A 注记:flock 升级另立票,不阻塞 P1)。

**落点**: 新建 `plugins/_narrow-waist/addressing.js` registry 段;写链 oracle = pump.js registryOpChain/serializeRegistryOp/registerSelf/unregisterSelf;唯一 tmp oracle = core/store.js saveState();被替换缺陷 = core/registry.js writeRegistryAtomic 固定 tmp + register/unregister 裸读改写。

**验收断言**:
1. 并发写不丢条目(R-B14 断言): 同一 temp registryPath 上 20 个并发 registerConsumer(互异 sid)全部 settle 后 readRegistry → 20 条全在、version=最后一次写入值。
2. 唯一 tmp: 并发写期间目录中不出现两个写者争用同一 tmp 路径导致的 ENOENT(断言: 全部操作 reject 数=0;可在测试注入 fsp 代理统计 tmp 名唯一性——tmp 名集合大小 ≥ 并发轮次)。
3. 白名单回归(R-B04 断言): 手工写 registry.json 含 consumer 条目带多余键 `{"alias":"a","pid":1,"armedAt":"t","version":9}` → readRegistry 后该条目恰三键,多余键被剥(白名单行为与 core 逐字一致);顶层 version 字符串保留。
4. sanitizeConsumers 与 core/registry.js 同输入输出深度相等(oracle 比对)。

---

## P1.3 vocabulary.js — 18 Signal 词汇表(终表引用)与映射

### P1.3.1 [R-S06 + R-S24 + R-B01 引用] DAIS_TYPE_MAP 显式 direct 条目、每平面入站白名单、18 Signal 引用

**引用**: R-S06('direct' 与存量值 normalize 方向未定义,DAIS_TYPE_MAP 需显式 direct 条目)、R-S24("TYPES 改共享常量"无匹配常量,V2_TYPES 不含 status 反多 pong/ask/steer/nack,照做即改行为)、R-B01(词汇表漏活类型 report,18 Signal 终表归 G 节)。

**裁决**:
- **18 Signal 终表以 §G 节为准(含 R-B01 新增的第 18 个 Signal `report`),本节引用不重复**;vocabulary.js 的 SIGNALS 常量、DAIS_TYPE_MAP/DSH_TYPE_MAP/ORCA_TYPE_MAP 三张映射、done≠worker_done 裁决全部按 G 节终表逐条实现,T2 验收含"与 G 节终表逐条一致"断言。
- **R-S06 拍板: DAIS_TYPE_MAP 显式 `direct: null` 条目(归 null,不归 status)**。理由: 'direct' 不在 dais 9 值枚举(CLI+DB CHECK 双层拒,R-B06 实测 0 条落库),误译 status 会把"必死的历史发送值"洗成合法语义;显式 null 让 normalizeType('direct') → `{signal:null, source:'direct'}` 有据可查,denormalizeType(signal,'dais') 永不产出 'direct'。
- **normalizeType/denormalizeType 语义(R-S33 词汇半边,终稿随 G 节,envelope 半边见 P1.4)**:
  - `normalizeType(rawType)` → 已知值 → `{signal, source}`;未知但合法字符串 → `{signal:null, source:rawType}` 透传打标(**不抛、不猜**);非字符串 → `{signal:null, source:String(rawType)}`;大小写不归一(各平面枚举全小写,误拼保留原样供应用层白名单拒收)。
  - `denormalizeType(signal, plane)` → 平面原生 type;不可译返回 null(direct 条目保证 dais 面永不返回 'direct')。
  - 闭集校验留应用层各 intake 白名单(见下常量),库不做全局闭集拒绝。
- **R-S24 拍板: 每平面入站白名单常量显式定义并指名**(§6B L207 "TYPES 改共享常量"指名下第一常量;§6A L193 http-intake 并表指名第二常量):

```js
export const DSH_CALLBACK_TYPES = Object.freeze(['ack', 'done', 'ping', 'status'])
//   = message-bridge index.js TYPES 现值 = cb-send 用法契约(type: ack|done|ping|status),值集与顺序逐字
export const DSH_INTAKE_TYPES   = Object.freeze(['ack', 'done', 'ask', 'report', 'ping', 'status'])
//   = host-callback-bridge http-intake.js TYPES 现值(6 值,含 report),值集与顺序逐字
```

  理由: 两常量均"现状字面",任何 adapter 换用后入站面行为零变化——扩面/收面(pong/ask/steer/nack 入回调面)需另立裁决,不在 P1 偷做。

**落点**: 新建 `plugins/_narrow-waist/vocabulary.js`;字面 oracle = message-bridge index.js TYPES、http-intake.js TYPES、dais types.rs 9 值枚举、a2a http-server.js ROUTER_TYPES;18 Signal 终表 = §G 节。

**验收断言**:
1. `normalizeType('direct')` → `{signal:null, source:'direct'}`;`denormalizeType` 对全部 18 Signal 以 'dais' 平面调用,返回值 ∈ dais 9 值枚举 ∪ {null} 且**永不为 'direct'**。
2. 存量值直通用例(R-S06 原文): 'direct'/'report'/'status' 三存量值过 normalizeType 均不抛、不猜 signal(report 按 G 节终表映射,status → status)。
3. `DSH_CALLBACK_TYPES` 与 message-bridge TYPES、`DSH_INTAKE_TYPES` 与 http-intake TYPES 逐元素相等(测试内 import 两插件文件作 oracle);两常量 Object.isFrozen。
4. 18 Signal 全覆盖: SIGNALS 与 G 节终表逐条一致(以 G 节文件为 oracle 的比对用例;G 节合入前以评审报告 R-B01 修复语义为准 report 在表)。

---

## P1.4 envelope.js — 信封与版本四态

### P1.4.1 [R-S33 + R-S18] detectVersion 四态 / parseLine 处置 / downgrade 定位

**引用**: R-S33(v2 识别"有 msgid 无 ver"不覆盖 cb-send 4 键行(无 msgid 无 ver)——inbox 主流量 detectVersion 返 null 处置悬空;normalize 未知 type 四态未定义,词汇半边见 P1.3)、R-S18(downgradeV3toV2 无真实调用场景,过度设计)。

**裁决**:

```js
LINE_PREFIX = 'DSHMSG]'        // session-send:129 来源不变
ENVELOPE_VERSION = 3
V2_TYPES   = Object.freeze(['ping','pong','done','ask','steer','nack','ack'])   // session-send:6 逐字
SIGNALS    = …                 // 18 值,引用 vocabulary.js 同一常量(单一来源,不在 envelope 重复定义)

createEnvelope(opts)           // {from,to,type,ref,body,msgid?,ts?,ver=3,via?,ttl=5}
                               // msgid 缺省 forgeMsgid();ts 缺省 Date.now();七键键序 = v2 原序,新三键尾部追加(OG5)
validateEnvelope(obj)          // → {ok,envelope} | {ok:false,errors[]},不抛;
                               // type 只查非空字符串、不查闭集(闭集校验留应用层白名单,P1.3 常量);未知键不拒
serializeLine(env)             // 'DSHMSG]' + JSON.stringify(env)(JS 紧凑风格)
                               // 注: P2 对拍判据按 R-B05 另裁(前缀+结构等价),本库不复刻 Python 分隔符
parseLine(line)                // → {ok:true, rawVersion, value, ref} | {ok:false}
                               // 识别 'DSHMSG]' 前缀与裸 JSON;ref: v3/v2 取 value.ref ?? null,
                               // legacy4 从 body '[ref:' 前缀提取(cb-send:31 折叠约定)?? value.ref ?? null
detectVersion(obj)             // 四态(R-S33):
                               //   3        — obj.ver === 3
                               //   2        — 无 ver 且 msgid 为非空字符串
                               //   'legacy4'— 无 ver 无 msgid 且 from/to/type/body 四基键齐全(对象)
                               //   null     — 其余(malformed/不构成信封)
upgradeV2toV3(v2, via)         // 补 ver/via/ttl,原字段与键序不动(OG5)
downgradeV3toV2(env)           // 剥 ver/via/ttl → 7 键;定位=测试辅助 + R-B05 修复选项(b)备用,
                               // 不列入生产调用面(R-S18 拍板: 保留导出、JSDoc 标注非生产 API)
```

- **legacy4 处置(R-S33 拍板)**: parseLine 对 legacy4 **原样透传 value**(不补造字段、不改写),rawVersion:'legacy4';路由/寻址按旧式 parseAddress 走(dedup 走 P1.1 body 键)——cb-send 4 键行(inbox 现存主力流量)行为与现状逐字等价。null 态不抛,调用方沿用现 tryParseJson 处置面(非 JSON 行才进 malformed 死信,JSON 但不成信封的行由各面现状逻辑处理)。
- **四态与 dedup 联动**: legacy4/v2 行 dedupKeys 无 msgidKey(身份=body 键);v3 行双键——与 P1.1 材料分流互为表里。

**落点**: 新建 `plugins/_narrow-waist/envelope.js`;oracle = session-send v2 信封构造/`DSHMSG]` 前缀/V2_TYPES 文档、cb-send 4 键 payload + '[ref:' 前缀折叠。

**验收断言**:
1. detectVersion 四态各 ≥1 用例: ver:3→3;{msgid 无 ver}→2;{type,from,to,body} 四键→'legacy4';{type,from} 残件→null。
2. parseLine: 'DSHMSG]{…v2七键}' → rawVersion 2、ref=value.ref;裸 4 键行(无前缀)→ rawVersion 'legacy4'、ref=body '[ref:X] ' 前缀提取值;非 JSON → {ok:false}。
3. round-trip 幂等: createEnvelope→serializeLine→parseLine→serializeLine 二次相等;upgradeV2toV3 后 JSON.parse 键序 = v2 七键原序 + ver/via/ttl 尾部(P2 判据 (a) 的键序基底)。
4. validateEnvelope: type:'Status'(闭集外字符串)→ ok(不拒);type:''→ errors 非空;未知键 ver7 → ok(不拒)。

---

## P1.5 index.js — 桶导出(单一来源)

**裁决**: index.js 仅 re-export 四模块全部公开名(§P1.1-P1.4 列出的每个导出),零逻辑、零副作用、零常量副本(SIGNALS 只在 vocabulary.js 定义,envelope.js 从其 import)。约束: 任何 adapter(`pump.js`/`core/*` re-export 面/新 adapter)只允许从 `../_narrow-waist/index.js` 或具名模块文件引入,禁止复制函数体——「四处同源」在 P1 后收敛为单一物理源(§6 各行"原位变 re-export"的机械形态)。

**验收断言**: `node -e "import('./plugins/_narrow-waist/index.js').then(m=>console.log(Object.keys(m).sort().join(',')))"` 输出 = 本节枚举的全部导出名集合(测试内以名单断言),且 import 无任何文件写副作用。

---

## P1.6 单测清单(四文件;全部 temp 域)

**[R-S31 + P1 验收 L128-129 替换文本]** 四个 `*.test.mjs` 用 node:test;**全部落盘于 `mktemp -d` 注入域**(fleet/registry/bridgeDir 一律参数注入,MAESTRO_FLEET/MAESTRO_STATE 指向 temp),断言 `~/.dsh/maestro/bridge` 与 `~/.dsh/maestro/state` 的 mtime 在测试前后不变(live 零写入,对齐 OF-005 断言风格);测试内 import 生产 core/*.js 文件仅作只读 oracle,不写其目录。

| 文件 | 必含断言(≈用例数) |
|---|---|
| envelope.test.mjs | 四态 detectVersion(4)、parseLine 前缀/裸 JSON/legacy4 ref 提取(3)、round-trip 幂等+键序(2)、v2 七键原样/upgrade 键序(2)、validate 不拒未知键/闭集外 type(2) ≈13 |
| addressing.test.mjs | 宿主 broadcast 空→skip/非空→sids 全集(2)、泵 broadcast 恒 wake-self(1)、泵 skip/qualified/bare 四分支(4)、dead reason 四条 oracle 逐字节(1 组)、底层签名回归 R-S28(1)、撞名 collision+ambiguous(2)、多持有者 alias(1)、findFleetEntry exact/prefix+resolveFleetSessionId(3)、短码解析与 session-send resolve() 一致(1)、registry 并发 20 写不丢+唯一 tmp+白名单回归(3) ≈18 |
| dedup.test.mjs | v3→v3/v3→v2/v2→v2/v2→v3 四向重放(4)、无 msgid 同 from 不同 body 零误判重(1)、from 缺失整行回退 oracle(1)、digestOf 对 core oracle 逐字节(1)、meta 存取/208 prior 通道(2)、seen 不隐式 mark/不刷新(2)、windowMs 默认+假 clock 过期剪枝(2) ≈13 |
| vocabulary.test.mjs | 18 Signal 与 G 节终表逐条一致(1 组)、normalize 已知/未知透传/非字符串(3)、存量值 direct/report/status 直通(3)、denormalize('dais') 永不 'direct' 且 ∈9 值∪null(1)、两白名单常量 oracle+freeze(2) ≈10 |

**验收断言(可执行)**:

```bash
cd /home/yy/tools/maestro-preset-iter
T=$(mktemp -d) && printf '{"fleet":{}}' > "$T/fleet.json"
B0=$(stat -c %Y ~/.dsh/maestro/bridge 2>/dev/null); S0=$(stat -c %Y ~/.dsh/maestro/state 2>/dev/null)
MAESTRO_FLEET="$T/fleet.json" MAESTRO_STATE="$T/state" node --test plugins/_narrow-waist/ && \
B1=$(stat -c %Y ~/.dsh/maestro/bridge 2>/dev/null); S1=$(stat -c %Y ~/.dsh/maestro/state 2>/dev/null)
# 全绿(exit 0)&& [ "$B0" = "$B1" ] && [ "$S0" = "$S1" ] && rm -rf "$T" 成功
```

---

## P1.7 落点汇总(库侧全部新建;锚函数名,行号可漂)

| 裁决 | 新建落点 | 兼容/re-export 面(非 T2) | oracle 源 |
|---|---|---|---|
| R-B03/R-B16/R-S01 | `_narrow-waist/dedup.js` | host-callback-bridge/core/dedup.js | core/dedup.js、file-router flush()、message-bridge 208 |
| R-B02/R-S28 | `_narrow-waist/addressing.js` resolveRouting/resolveRoutingUnified/resolveHostRouting | core/addressing.js、pump.js 调用点 | pump.js resolveRouting、core/addressing.js resolveHostRouting |
| R-B15 | `_narrow-waist/addressing.js` resolveAddress | — (发送侧新面) | dead.log orch1、session-send resolve() |
| R-S04/R-S05 | `_narrow-waist/addressing.js` findFleetEntry/resolveFleetSessionId | session-send/fleet-touch 后续票改调 | session-send find_entry、fleet-touch get_entry |
| R-B04/R-B14 | `_narrow-waist/addressing.js` registry 段 | core/registry.js | pump.js registryOpChain、core/store.js saveState |
| R-S06/R-S24 | `_narrow-waist/vocabulary.js` | message-bridge TYPES、http-intake TYPES 后续票改指名 | message-bridge:73、http-intake TYPES、types.rs |
| R-S33/R-S18 | `_narrow-waist/envelope.js` | — | session-send 信封、cb-send 4 键行 |
| R-S31 | 四 `*.test.mjs` | — | OF-005 temp 域模式 |

---

# 窄腰三件套修订 spec · 节 P2(sectionId=P2)— dsh adapter + 双跑对拍

> 输入基线: 评审报告 `docs/reports/nw-plan-review-report.md`(232 行版方案为评审对象)+ `.nw-review-D-raw.md`/`.nw-review-E-raw.md`;源码锚点均已在 worktree `comm-iter`(HEAD 0665041)亲证,关键行为(non-UTF-8 argv 崩溃点、REFUSED stderr 字节、conflicts 行字节、of002 33/33 绿、:3081 在线)已实测坐实。
> 本节为**最终裁决版**: 单一版本,无开放问题;报告给的二选一均按其推荐项拍板并附一句理由。

## P2.0 阶段边界与总则(承 R-S07/E-B01 裁决)

- P2 = **纯新增**: 全部交付 = `bin/session-send-v3`(dsh adapter,Node 单文件)+ `tests/p2-a-b-test.sh` 两个新文件。`bin/session-send`、`bin/cb-send`、`tests/of002-selftest.py` 一行不改;不注册 agent.cordis.yml;**不跑 `bin/dev-sync.sh`**;不触生产 :3080 与 `~/.dsh`。
- session-send 升 v3 的阶段归属**钉死在 P3**,以切名式落地(与 cb-send"旧版留 `.v2`"同款): P3 时 `bin/session-send → bin/session-send.v2`、`bin/session-send-v3 → bin/session-send`(占原名)。理由(报告 R-S07 推荐项): P2 保持纯新增 adapter 使"一行不改"承诺自洽;切名式令 P2 交付物即 P3 终态,无二次实现。
- 沙箱: `/home/yy/tools/dsh-comm-sandbox/run.sh`(DSH_HOME/MAESTRO_* 全隔离 + `--port 3081`,R-S10 已核实有支撑且当前在线,live 层默认打 127.0.0.1:3081)。

## P2.1 [R-B05] P2 验收判据——采纳报告选项 (a)

**引用**: R-B05(P2 L136"wire payload `content[0].text` 逐字节相等"必然 100% 失败;实测 Python `json.dumps` 分隔符带空格 vs JS `JSON.stringify` 紧凑,第 8 字节起分叉)。

**裁决内容**(整体替换方案 §4-P2 L136"验证"行):

两路(旧 `bin/session-send` 与新 `bin/session-send-v3`)对同一信封输入(七共有字段一致、`--msgid` 两路各自钉死)投递后,比对各自 POST `/api/session.prompt` 的 `payload.content[0].text`:

1. **前缀字节相等**: 两行前 7 字节均恰为 `DSHMSG]`。
2. **七键深度相等(键值与键序)**: 两行各自 `JSON.parse` 后,共有七键 `from,to,type,ref,body,msgid,ts`:
   - `from/to/type/ref/body` 五键逐字 `===`;
   - `msgid` 各等于其侧 `--msgid` 注入值;
   - `ts` 不可注入(旧 bin 无 `--ts` 旗标),断言放宽为: 均为整数且 `|tsA − tsB| ≤ 60_000` ms(两进程启动间隔上界;判据针对**序列化格式**,不针对时钟值);
   - **键序**: `Object.keys(parsed)` 前 7 项两路均恰为 `['from','to','type','ref','body','msgid','ts']`。
3. **新三键只验存在与类型**(仅新 adapter 侧第 8-10 键): `ver === 3`(number)、`via` 为非空 string 且含 `'session-send-v3'`、`ttl` 为 ≥1 整数;且三键尾追于七键之后(`keys.slice(7)` 恰为 `['ver','via','ttl']`)。
4. 字节级差异(Python/JS 分隔符空格差异)**不构成 FAIL**——判据 a 的定义即吸收该差异;`serializeLine` 的键序契约归 T2 库节(P1),adapter **不复刻** Python 空格风格。
5. **非 UTF-8 argv 边界用例**(报告 R-B05 要求补): body 含无效 UTF-8 字节(如 `$(printf 'x\xffy')`)时——旧 bin 在 `session-send:143` `.encode()` 抛 `UnicodeEncodeError`、exit 1、服务端零收到(已实测坐实);新 adapter 因 Node 将 argv 无效字节解码为 U+FFFD 而 rc0、行可 `JSON.parse` 且 `body` 含 `\ufffd`(已实测 Node argv 十六进制 `78 efbfbd 79`)。断言即按此**不对称行为**判定(记录差异为契约,不判 FAIL)。

**拍板理由**: 报告推荐项 (a);选项 (b) 会迫使 JS 复刻 Python 分隔符、污染所有 v3 新行字节格式,选项 (c) 放弃格式纪律。

**文件级落点**: `tests/p2-a-b-test.sh`(断言 M01-M21/K1-K3);方案 §4-P2 L136 验证行按上列 1-5 替换。

**可测验收断言**: P2.5 清单 M 系列 + K1/K2/K3。

## P2.2 [R-S04] steer 闸——库 entry-level 函数 prefix 模式

**引用**: R-S04(find_entry 查表梯与 resolveAddress 全梯不同,混用则 no-entry 放行变 exit 4 拒绝、可拦集合静默扩大;journal 两处落点与 reason 四值被 `tests/of002-selftest.py:124-125,256,285-288` 钉死;`--via` 解析规则需定义)。

**裁决内容**:

1. **查表梯分离**: steer 闸取 fleet 条目**必须**用库 entry-level 函数 `findFleetEntry(key, fleet)`(prefix 模式: fleet 精确命中 → `'session-' + key` 的 sessionId 前缀回退 → `null`),**禁止**以 `resolveAddress` 的路由结果或全梯(含 registry alias/broadcast)替代。出站 `to` 解析同理只用 fleet 梯(`session-` 前缀直通 → fleet 精确 → sessionId 前缀;**registry/broadcast/`agent://` 分支 P2 一律不启用**,P3 接管原名时再开)——保证对拍域内两路行为逐字同构。
2. **journal 两处落点逐字保留**: 冲突行 = `dirname(abspath(fleet_path)) + '/fleet-conflicts.jsonl'`(**abspath 非 realpath**,逐字);审计行 = `${MAESTRO_STATE:-~/.dsh/maestro/state}/steer-journal.jsonl`(缺省链逐字)。
3. **行结构与 reason 四值逐字**: 冲突行键恰 `msgid,from,to,ts`(键序同此,of002:256-259 set 断言);审计行键恰 `msgid,from,to,ts,reason`(of002:285-288);reason ∈ `owner-self | unowned | lease-expired | no-entry`,分支逐字复刻 `steer_gate`(`session-send:90-97`): alive→`owner-self`;entry 为 null→`no-entry`;entry 有 owner 而无有效 expires→`lease-expired`;entry 无 owner→`unowned`;alive 判定 = `owner 非空 && expires 非空 && expires > now`(ts 解析语义 = `parse_ts`: ISO8601 容忍 `Z`、naive 视作 UTC、缺/坏→null)。
4. **exit 4 与 stderr 逐字**(实测基准): 拒绝时 exit 4 + stderr 恰为
   `session-send: steer REFUSED — {to} leased by {owner} until {leaseExpiresAt}; conflict journaled ({conflicts 绝对路径}) msgid={msgid}`
   (em dash `—`;工具名前缀保留 `session-send:` 不改成 `-v3`——上层脚本 grep 依赖,R-S29 定性为依赖契约)。
5. **闸位与触发序逐字**: 仅 `type === 'steer'` 触发;序 = resolve(to) 成功 → 铸 msgid/ts → steer_gate → 信封构造 → POST(复刻 `main` :122-129);非 steer 类型零影响。
6. **`tests/of002-selftest.py` 全程绿**: P2 不改该文件、不改 `bin/session-send`/`bin/fleet-touch`;回归门槛 = 该 selftest 全绿(当前基线 33/33 已实测;它读 `~/.dsh/maestro/bin/` 镜像,P2 不跑 dev-sync → 镜像不漂移)。T3 验收必跑。
7. **`--via` 解析规则**(钉死): 解析与 `--msgid` 同款(独立 flag+值,缺值 → stderr+exit 2);值**禁空串**、按逗号拆分后**禁空段**(如 `a,,b` → exit 2);非空段依序追加;`--via` 可重复出现,依出现序追加;**适配器恒把自身 id `session-send-v3` 追加链尾**(用户未给 `--via` 时链 = 仅自身);信封 `via` 字段 = 逗号拼接 string(§3 契约"adapter 标识链")。P2 无 `--ttl`/`--ver` 旗标(ver=3/ttl=5 为常量)。

**文件级落点**: `bin/session-send-v3`(复刻锚: `bin/session-send` 的 `find_entry`@:56-65 → 库 `findFleetEntry`;`parse_ts`@:45-53;`steer_gate`@:76-100;`resolve`@:32-42 → 库 fleet 梯;参数段 @:105-112 扩 `--via`)。库侧 `findFleetEntry`/fleet 梯为 T2(P1)交付,本节为消费方。

**可测验收断言**: P2.5 清单 G1-G8。

## P2.3 [R-S29] steer 审计三件套双 adapter 双写一致——appendJsonl 键序锁定

**引用**: R-S29/E-S13(P2 起旧 bin 与新 adapter 双跑,两边 append 同一对 jsonl;Python dict 键序 vs JS 对象键序不一致会污染对账工具;exit 4 语义与 stderr 文案是上层脚本依赖契约)。

**裁决内容**(报告二选一拍板: **提炼为库函数**;理由: JS 侧获得单一执行点、P3 切名接管后零再改,"双实现逐字段一致"没有单一权威、只能靠约定):

1. 库(T2 交付)`appendJsonl(path, obj)` 语义: 自动 `mkdirs(dirname(path))` → 追加单行 `JSON.stringify(obj) + '\n'`(**键序锁定序列化**: 调用方按键序构造对象,`JSON.stringify` 保字符串键插入序,库不得排序/重排键)→ flush + fsync。语义对齐旧 bin `append_jsonl`(`session-send:68-73`)。
2. 新 adapter 的冲突行/审计行**一律经库 `appendJsonl`**,构造键序锁定: 冲突行 `msgid,from,to,ts`;审计行 `msgid,from,to,ts,reason`(与旧 bin dict 构造序逐字一致)。
3. 双跑期一致判据 = **行级结构一致,不要求字节相等**(实测 Python 行 `{"msgid": "...", "from": ...}` 带空格、JS 紧凑——与 R-B05 判据 a 同哲学): 两路行各自 `JSON.parse` 后键集合相等、`Object.keys` 顺序一致、值类型一致(msgid=uuid 字符串 / from,to=字符串 / ts=整数 / reason∈四值枚举)、from/to/reason 深度相等。
4. 对拍脚本按 msgid 定位各侧行(两路 `--msgid` 各自钉死)逐对比较;exit 4/stderr 契约归 P2.2 第 4 条。

**文件级落点**: `bin/session-send-v3`(steer 副作用两处调用点);`plugins/_narrow-waist/`(`appendJsonl`,T2 交付);`tests/p2-a-b-test.sh`(G7/G8)。

**可测验收断言**: P2.5 清单 G7/G8。

## P2.4 adapter 出站裁决: v3 原生行,不走 downgrade(联带 R-S18/R-S10/R-S31 邻接)

**引用**: R-S18(downgradeV3toV2 若按判据 a 修判据可降为可选);本节分配注记("adapter 出站不走 downgrade;serializeLine 键序契约归 T2 库,adapter 对拍以判据 a 为准")。

**裁决内容**:

1. 新 adapter 出站 = `serializeLine(createEnvelope({from,to,type,ref,body,msgid,ts,ver:3,via,ttl:5}))` 产 **v3 十键行**(七键序 + `ver,via,ttl` 尾追;键序契约由 T2 库节钉死,本节不重复规定)。**不使用 `downgradeV3toV2` 出站**(R-S18: 降为测试辅助;出站降级会使 v3 字段在 DSH 面永远不出现,§3 超集兼容主张失去现场验证)。理由: 判据 a 已吸收两代序列化差异,无需以降级换可比性。
2. wire 形状逐字复刻旧 bin(`session-send:130-151`): `{type:'client-request', rpcId:<uuid>, method:'session.prompt', payload:{sessionId:<解析值>, mode:'queue', content:[{type:'text', text:line}]}}`;信封 `to` 字段 = 原始 `to` 实参(不经解析改写),`payload.sessionId` = 解析结果——与旧 bin 一致。
3. **port 解析序逐字复刻旧 bin**(:117-121,注意与 loopback-sink `resolveApiPort` 的"显式>env>fleet"序**不同**,以旧 bin 序为准): `port = env DSH_PORT ?? '3080'` → `fleet.port` 存在则覆盖。
4. stdout/stderr/exit 码契约: 成功 stdout 模板逐字 `sent {from} -> {to}({sessionId 前 14 字符}…) type={type} ref={ref}: accepted={True|False}`(布尔 Python 大写风格,保上层 grep);RPC 失败 → stderr `session-send: RPC error: {error 的 JSON}` + exit 1;未知码 → stderr `session-send: unknown code '<key>' (not in fleet.json, not a sessionId prefix)`(单引号,实测逐字)+ exit 1;usage/参数错 → exit 2;fleet 文件不可读 → stderr 单行 + exit 1(非契约面,不要求复刻 traceback)。
5. 库解析两级(防 R-B13 同族镜像 ENOENT): ①`dirname(realpath(argv[1]))/../plugins/_narrow-waist`(仓内/装点内成立);②`${DSH_HOME:-$HOME/.dsh}/.agent-presets/maestro/plugins/_narrow-waist`(bin 镜像副本兜底);皆无 → stderr 一行 + exit 2。零 npm 依赖(仅 `node:*`)。
6. 收方兼容以现有工具实证(不新增交付): `bin/msg-dedup` 对 v3 行按 `]` 切一刀 + `json.loads` 多键忽略——首见 exit 0、同 msgid 重放 exit 3,进对拍断言 K7(零生产外溢: MAESTRO_STATE 指 temp)。

**文件级落点**: `bin/session-send-v3`(整文件);`tests/p2-a-b-test.sh`(K7)。

**可测验收断言**: M 系列/K7 + P2.5 全清单。

## P2.5 [R-B05/R-S10/R-S31 邻接] 对拍脚本 `tests/p2-a-b-test.sh`——OF-005 模式断言清单

**裁决内容**(脚本规格,单一版本):

- **形态**(OF-005 基底,`of005-selftest.py:371-377` 模式): bash + 内嵌 node 生成 stub 与比较器;全 temp 域(`mktemp -d`,`MAESTRO_FLEET`/`MAESTRO_STATE`/`DSH_PORT` 恒指 temp 与 127.0.0.1:0);幂等可重跑、并发安全(无固定端口/路径);每断言原子输出 `[ ok ] <id>` / `[FAIL] <id>: <detail>`;汇总 `p2-a-b-test: N/N 全绿(exit 0)`,有 FAIL → exit 1;env guard: 脚本自设的 `MAESTRO_FLEET`/`MAESTRO_STATE` 若被外部覆盖为非 temp 路径则拒跑(对齐 R-S31"零外溢"断言风格)。
- **stub**: 运行时生成 `$WORK/stub.mjs`——监听 `127.0.0.1:0`,把每个 POST 请求体全文 append 到 `$WORK/wires.jsonl`,应答 `{"result":{"ok":true,"value":{"accepted":true}}}`(of002 `StubHandler` 同款);比较器按 `content[0].text` 内 `msgid` 定位各路 wire(不依赖记录顺序)。
- **旧路基准**: `P2_OLD_BIN` 缺省 = `<repo>/bin/session-send`(仓内旧版,与镜像状态解耦);新路 = `<repo>/bin/session-send-v3`。

**断言清单**(编号 = 脚本 check id,全部可执行):

Hermetic 层(stub 域):
- **M01-M21** 矩阵对拍: 7 type × 3 to 形式 × 两路。type 集 = `ping,pong,done,ask,nack,ack,report`(V2_TYPES 去 steer + R-B01 新增 `report`;steer 归 G 系列);to 形式 = fleet 精确码 / sessionId 前缀 / 完整 sessionId;两路 `--msgid` 各自钉死。每 case 断言 P2.1 判据 1-3 全成立 + wire 形状(`payload.sessionId`=解析值、`mode:'queue'`、`method:'session.prompt'`、content 单元素 text)。含 1 例中文+emoji body(覆盖 `ensure_ascii=False` vs JS 原生)。
- **K1** 键序全局: 全部记录行 `Object.keys` 恒锁定序(旧侧恰七键 / 新侧恰十键)。
- **K2** v3 新三键存在与类型(全部新侧行,P2.1 判据 3)。
- **K3** 非 UTF-8 argv 边界(P2.1 第 5 条;`body=$(printf 'x\xffy')`): 旧 bin exit 1 + stderr 含 `UnicodeEncodeError` + stub 零新增;新 adapter rc0 + 行可 parse + body 含 `\ufffd`。
- **K4** 4KB 边界(R-S32 邻接): body ≈ 3800B ASCII(v3 头膨胀后单行 < 4096B)两路 rc0 且七键深度相等。
- **K5** unknown code: `to='zzzz'` 两路 exit 1 + stderr 逐字含 `unknown code 'zzzz'`。
- **K6** 参数错 exit 2(两路同判): argc≠5 / `--msgid` 缺值 / `--via ''` / `--via 'a,,b'`。
- **K7** 收方兼容: `bin/msg-dedup '<新侧 v3 行>'`(temp MAESTRO_STATE)首见 exit 0、同 msgid 重放 exit 3。
- **G1** 有效他人租约 steer: 两路 exit 4;stub 零新增;两路 stderr **逐字节相等**(各自 msgid 归一后)。
- **G2-G5** 四放行 reason: `owner-self` / `unowned` / `lease-expired` / `no-entry`(直投完整 sessionId)各两路 rc0 + journal 各落 1 行且 reason 匹配。
- **G6** 非 steer 七类型经有主目标: 全 rc0,conflicts/journal 零增长(of002 ⑤ 同款)。
- **G7** 双写一致(R-S29): 按 msgid 逐对比较两路 conflicts/journal 行——键集合、`Object.keys` 顺序、from/to/reason 深度相等、ts 均整数。
- **G8** reason 四值枚举全覆盖 × 两路(汇总 G2-G5)。

Live 层(沙箱,默认 :3081,`P2_LIVE_PORT` 可覆盖):
- **L0** 可达性: 对目标端口 POST session.prompt(bogus sessionId)收到 `server-response`(不可达 → `[FAIL]`,不静默跳过)。
- **L1** 错误契约对拍(恒跑、零宿主副作用): temp fleet `{port:<liveport>}` + 直投 `session-00000000-0000-4000-8000-000000000000` → 两路 exit 1 + stderr 均含 `session-send: RPC error:` 与 `session-not-found`。
- **L2** happy-path(条件): `P2_LIVE_SESSION` 提供真实沙箱会话 id 时两路 rc0 + stdout 含 `accepted=True`(向该会话注入 v2/v3 行各一;沙箱=草稿域,重跑幂等以**断言**为准,不以宿主会话内容为准);未提供 → 打印 `[skip]`,不计 FAIL。

**可测验收断言**: `bash tests/p2-a-b-test.sh` exit 0 且汇总行 N/N 全绿。

## P2.6 文件级落点汇总 + T2 依赖面

| 文件 | 动作 | 锚(行号可漂) |
|---|---|---|
| `bin/session-send-v3` | 新增(~180 行,`#!/usr/bin/env node`) | 复刻 `bin/session-send`: `resolve`@:32-42 / `parse_ts`@:45-53 / `find_entry`@:56-65(→库 `findFleetEntry`)/ `append_jsonl`@:68-73(→库 `appendJsonl`)/ `steer_gate`@:76-100 / `main`@:103-151(参数段扩 `--via`) |
| `tests/p2-a-b-test.sh` | 新增 | OF-005 断言风格(`of005-selftest.py:371-377`);G 系列蓝本 = `of002-selftest.py` ②③⑤(:246-320) |
| `bin/session-send` / `bin/cb-send` / `tests/of002-selftest.py` | **不动**(P2 承诺;of002 33/33 绿为回归门槛) | — |
| `plugins/_narrow-waist/*` | 依赖(T2 交付) | 见下 |
| `docs/narrow-waist-implementation-plan.md` §4-P2 | 修订 | L136 验证行按 P2.1 替换;L135 交付行落实两文件名;"不动"清单保持 |

**T2 依赖面(库导出契约,本节消费;命名以 T2 节权威定义为准,若实名不同仅 import 名变,本节断言零变化)**: `serializeLine`(v3 十键键序 `from,to,type,ref,body,msgid,ts,ver,via,ttl`)、`createEnvelope`、`forgeMsgid`(uuid4 同构)、`findFleetEntry(key, fleet)`(prefix 模式 entry-level,R-S04)、fleet 梯解析(`session-` 直通/精确/前缀;R-S05 参数化 exact|prefix 的 prefix 侧)、`appendJsonl(path, obj)`(键序锁定 + fsync,R-S29)。

---

# P3a — 「dais 重载修复」spec 节 + T4 票草案

> 起草员 sectionId=P3a。输入: 评审报告 `nw-plan-review-report.md`(232 行版方案锚点)+ `.nw-review-D-raw.md`/`.nw-review-E-raw.md` + 源码亲证。
> 亲证基线(全部本节独立复跑/重读坐实,含两处评审未覆盖的新证据):
> - `warp.sqlite`(只读)实测: messages 列名 `sequence/from_handle/to_handle`、`subject TEXT NOT NULL`、`CHECK(message_type IN 9值)`;770 行中 `status|741 + worker_done|29`、`direct` 0 条、`body LIKE 'DSHMSG]%'` 43 条且该 43 条 subject 全部恒 `'route'`;messages 自有 `id`(UNIQUE,`msg_<hex>` 形态)+`sequence` 主键。
> - `http-server.js` 实锚(勘误后): :58 `ROUTER_TYPES=['notify','steer','ping']`、:72 `daisDbPath` 缺省 `~/.local/share/dais/data.sqlite`(0 字节)、:76-82 `extractRef`、:139 `type='notify'` 缺省、:142-144 ROUTER_TYPES 闸、:161 heavy 判定、:163 envelope、:171-179 重载分支(:172 信封行、:175 `'--message-type','direct'`)、:203-207 表假设注释、:208-218 `defaultInboxReader`(:212 列名全错 SQL、:214 行映射)。
> - dais 仓实锚: `crates/ai/src/agent/orchestration/types.rs:14-33` 九值枚举无 direct;`app/src/ai/agent_sdk/orchestration.rs:240-241` CLI from_str 硬拒;`messaging.rs:22-33` 仅 worker_done/heartbeat 有副作用,Status→Ignored;`app/src/persistence/sqlite.rs:654 database_file_path()=state_dir().join("warp.sqlite")`;`runtime_rpc.rs:33` GUI 元数据 `dais-runtime.json` 亦在 state directory。
> - **新证据①(部署面,评审未覆盖)**: 生产 daemon(pid 872932)运行于 `~/.dsh/plugins/a2a-profile-server/daemon.mjs`——`host/install.sh:53` `for p in host-callback-bridge a2a-profile-server` 自包含拷贝,**不在 dev-sync 三面内**;仓内 git revert 不触达该装点。
> - **新证据②(沙箱隔离,只读探针实测)**: `XDG_STATE_HOME=<tmp>/state dais orchestration check-status` → `0 runs` 且在 `<tmp>/state/dais/` 自动创建 `warp.sqlite`(+wal/shm)——真 dais CLI 随 XDG_STATE_HOME 走 state dir、自动建库,且沙箱内无 `dais-runtime.json` → socket 快路不转发生产 GUI(若转发会读到生产 770 行库)。沙箱 dais 实例方案由此**实证可行**。

---

## A. spec 节: 「dais 重载修复」最终裁决版修订规格

### A.0 方案文本级总修订(整节替换稿)

以下为写进 `docs/narrow-waist-implementation-plan.md` 的最终文本(替换原 §6C 全节 L209-217,及 §4 P3 的交付/验证/回滚/不动四行中 dais 相关子句;行号可漂,以锚为准):

**§6C 替换稿:**

> ### C. DSH→dais 重载(反模式消灭)——P3a 修订版
>
> `plugins/a2a-profile-server/http-server.js` 重载分支(heavy 判定 @:161;dais 调用 @:171-179):
>
> - 现状: `line='DSHMSG]'+JSON.stringify(envelope)` 塞 `--body`;`--message-type` 硬编码 `'direct'`——非合法 MessageType(九值枚举无此值,CLI from_str 与 DB CHECK 双层拒),重载路径从未成功: 生产 router-journal 实测 `{'push':30,'denied':3,'mailbox':0}`,真实库 0 条 direct 落库。
> - 改造四点(发/收同文件同提交):
>   ① `--message-type` = `DAIS_MESSAGE_TYPE[type] ?? 'status'`;内联常量 `const DAIS_MESSAGE_TYPE = { notify: 'status', steer: 'status', ping: 'status' }` 置于 :58 `ROUTER_TYPES` 邻近。词汇表(T2)DAIS_TYPE_MAP 同步补 notify/steer/ping→status 三映射,单源语义由对拍测试钉死(内联表与 `denormalizeType(s,'dais')` 逐值一致)。**a2a 面不 import 库**: daemon 运行于 host/install.sh 自包含装点 `~/.dsh/plugins/a2a-profile-server/`,跨目录 `../_narrow-waist/` import 在装点 ENOENT(R-B13 同型陷阱,且该装点不在 dev-sync 任何一面)。缺省与兜底恒 `'status'`——九值中最无害(messaging.rs 对 Status 无生命周期副作用、存量 741 条先例);`'direct'` 一词(含注释)从本文件消失。
>   ② `--body` 由信封行改为 `envelope.body` 纯正文(消灭嵌套;删除 `const line = 'DSHMSG]' + JSON.stringify(envelope)`)。
>   ③ `--subject` 由固定 `'route'` 改为承载 ref: `refSubject(ref)` = `'[ref:' + sanitize(ref) + ']'`——ref 先单行化(剥离/替换 `\r`、`\n` 为空格)再按 UTF-8 字节预算 120 截断(按码点截,不撕裂多字节字符);ref 缺省或 `'-'` → `'[ref:-]'`。subject 恒单行、恒 `[ref:` sigil 包裹(UI 可读单一职责;dais GUI/observatory 直读 subject 列)。
>   ④ 修 defaultInboxReader(原三重断裂,见下)。
> - **v3 字段在 dais 载体落点裁决**: msgid/ver/via/ttl **不在 dais 载体承载**——不编进 subject、不进 body、不模仿信封头;dais messages 行的结构化列(from_handle/to_handle/message_type/subject/body)即其全部协议面。**dais 平面去重权威 = digest 模式**(sha256(from\0body),与 core/dedup.js 现行 material 逐字一致)+ dais 侧 `messages.id` UNIQUE/`sequence` 主键天然幂等;msgid 去重主键只覆盖 DSHMSG] 平面(R-S15 联动,§3 增"各平面去重权威"行: DSHMSG] 文件面=msgid 优先、无 msgid 行退 from\0body digest;HTTP 受理面=四键 canonical 行 digest(from\0body);dais 面=digest(from\0body)+dais UNIQUE id)。
> - **defaultInboxReader 修复**(:208-218):
>   - 路径: `daisDbPath()` 缺省改 `~/.local/state/dais/warp.sqlite`(原 `~/.local/share/dais/data.sqlite` 实测 0 字节空库,真实库在 state 不在 share);`A2A_DAIS_DB` 注入优先级保留(沙箱靠它)。
>   - SQL: `SELECT sequence, from_handle, to_handle, message_type, subject, body FROM messages WHERE to_handle = ? AND read = 0 ORDER BY sequence`(原 `seq/sender/recipient` 列名全错,`no such column` 必抛——agents/inbox RPC 从未工作过)。
>   - 行映射: `{ from: r.from_handle, to: r.to_handle, type: r.message_type, body: r.body, seq: r.sequence, subject: r.subject, ref: refFromSubject(r.subject) ?? extractRef(r.body) }`——from/type/body/seq/ref 键名不变(消费者零破坏),to/subject 为增量键。
>   - `extractRef`(:76-82)**函数体一字不动、legacy 永久保留**(P1-P4 任一阶段不删): 存量 43 条 `DSHMSG]` body 只读不改,且 `[ref:X]` body 前缀仍是 dais→回包现役格式(cb-send/worker 契约)。
>   - :203-207 表假设注释同步为真实 schema(列名 sequence/from_handle/to_handle + subject NOT NULL + CHECK 九值)。
> - 风险: 轻载路径(session-send)仍产 `DSHMSG]` 行而重载不再产——**消费侧双格式兼容为常驻设计**(非窗口期),两线 reader 互不相交,名单见 §6C 末;~~或 P3 内同步把 session-send 升 v3 统一~~(删除该缓解: v3 不改 `DSHMSG]` 前缀,版本维度与信封行维度正交,升 v3 消灭不了分叉;session-send 升格归属由编排另行裁决,不作为本分叉的缓解手段)。
> - 双格式 reader 名单(常驻兼容的全部消费面): 轻载线(`DSHMSG]` 行)= ①DSH 收方会话回合(session.prompt 注入行,agent 按 SKILL 约定读)、②`bin/msg-dedup`(按 `]` 切一刀解析 from/to/msgid);重载线(dais messages 表)= ①`http-server.js` defaultInboxReader(refFromSubject 优先 + extractRef 兜底,agents/inbox RPC)、②`executors/dais.js` parseMailbox + `[ref:X]` body matcher(check-messages 轮询;注: 该 matcher 匹配的是 worker 按 skill 契约写进 body 的 `[ref:X]` 前缀,新旧投递格式均不含此前缀,零回归,不改)、③dais GUI/observatory messages/subject 直读、④dais `check-messages` 消费者(read 权威)。

**§4 P3 四行 dais 子句替换稿:**

> - 交付(增): `http-server.js` 重载分支四点改造 + defaultInboxReader 修复(**单提交**,发/收不可拆)+ `tests/p3-dais-reload-selftest.py`。
> - 验证(a2a 子句替换): **沙箱 dais 实例实测**——`SBX=$(mktemp -d)`;`XDG_STATE_HOME=$SBX/state` 隔离 dais CLI 落库(真 CLI 直投,首次调用自动建库+迁移;沙箱内无 dais-runtime.json → socket 快路不转发生产 GUI),`A2A_DAIS_DB=$SBX/state/dais/warp.sqlite` 供 reader;createRouter 进程内驱动(注入测试桩 registry/journalPath,不启 daemon 不占端口)。断言: ①重载投递成功(send 返回 `delivered:'mailbox'` 且 ackRef 含数字 seq,journal 有 mailbox 行)——"修复已断的重载路径"本身即验收对象;②messages 落库 `message_type` ∈ 九值 CHECK 闭集(notify/steer/ping 三型均 ='status');③body 列不含 `DSHMSG]` 前缀(等于原文);④subject=`[ref:<ref>]` 单行;⑤新旧双格式 ref 解析各自正确;⑥生产 warp.sqlite 零测试句柄污染(测试句柄命名空间 `nw-sbx-*` 前后查零,对生产噪声免疫)。
> - 回滚(dais 子句替换): 仓单提交 `git revert` → **`host/install.sh` 重装面三**(daemon 装点 `~/.dsh/plugins/a2a-profile-server/` 不在 dev-sync 三面,git 不触达运行面)→ `kill $(pgrep -f 'a2a-profile-server/daemon.mjs')` + `nohup node ~/.dsh/plugins/a2a-profile-server/daemon.mjs >/dev/null 2>&1 &` → 冒烟(agents/registry 列表 + 一条轻载 push + journal 无新增 failed)。已落库新格式行按已知降级消费: 旧 extractRef 对纯正文行 ref 恒 `'-'`——消息本体不丢(check-messages 仍可消费、body 完整),ledger ref 对账断链为**已接受的降级损失**,不触发数据修复。
> - 不动(增): dais Rust 源码与 MessageType 枚举、messages schema、`ROUTER_TYPES` 与 :142-144 校验闸、heavy 判定阈值(:103/:161)、`extractRef` 函数体、`executors/dais.js`、生产 daemon 与装点(部署/重启由编排统一执行,不属实施票)。

---

### A.1 [R-B06] `--message-type` 缺省 'status' + DAIS 词汇映射补 notify/steer/ping→status + P3 验收断言改写

- **引用**: R-B06(§2);方案 §6C L215(改造① 缺省 direct)、P3 验收 L143、词汇表 L97-98(dais 列全为"—");联动 R-S06(direct 存量值 normalize 方向,词汇表侧行为归 T2 票)。
- **裁决**(单一版本,见 A.0 §6C①): ①重载分支 message-type 恒由映射产生,`DAIS_MESSAGE_TYPE[type] ?? 'status'`,兜底与缺省统一 `'status'`;②vocabulary.js DAIS_TYPE_MAP 补 notify/steer/ping→status(统一译 status 的理由: messaging.rs:22-33 对 Status 走 Ignored 无生命周期副作用,与真实库 741 条存量 status 先例一致,是九值中最无害值);③a2a 面**内联映射、不 import 库**(拍板理由: 生产 daemon 运行于 install.sh 面三自包含装点,`../_narrow-waist` import 装点 ENOENT——R-B13 同型陷阱且 dev-sync 不覆盖该装点;3 值映射内联 + 对拍测试与库钉死一致,零部署风险的等价单源);④P3 验收断言按 A.0 §4 P3 验证替换稿改写——"沙箱实测投递成功 + messages 落库 message_type ∈ 9 值"成为验收主断言,即把"修复已断的重载路径"(router-journal `mailbox:0`、0 条 direct)本身写成验收。
- **文件级落点**: `plugins/a2a-profile-server/http-server.js`:171-179(重载分支,:175 硬编码 direct 消灭)、内联常量置于 :58 邻近、红线注释 :94-96 与分支注释 :171 同步;`plugins/_narrow-waist/vocabulary.js` DAIS_TYPE_MAP(T2 票落地,本节只裁内容);方案 §6C L215、§4 P3 L143、词汇表 L97-98 三行 dais 列由"—"改"status"。
- **可测验收断言**: (1) 三型投递: notify/steer/ping 各一条 heavy send → `delivered:'mailbox'` + 数字 seq + journal mailbox 行;(2) 落库三行 `message_type` 均 ='status'(九值闭集由 DB CHECK 兜底);(3) 非法 type 拒收不变: `send(type:'direct')` → RouterError `-32602`(ROUTER_TYPES 闸原样);(4) parity: `{notify,steer,ping}` 逐值 `DAIS_MESSAGE_TYPE[t] === denormalizeType(t,'dais')`(selftest import 库断言);(5) `grep -n "'direct'" http-server.js` 零命中(引号字面量;:639 "directory" 不误伤)。

### A.2 [R-B07④] defaultInboxReader 三重断裂修复(路径/列名/SELECT+subject/ref 链)+ 存量 43 条兼容

- **引用**: R-B07 ①②③④中本项=④(reader 侧;①路径 ②列名 ③SELECT 亦在此收敛——评审第④点修复文本即含三者);E-S04(SELECT 无 subject→ref 进 subject 不可见)、E-S06(daisDbPath 指向 0 字节空库)。
- **裁决**(见 A.0 §6C"v3 字段落点"前段与"defaultInboxReader 修复"块): 路径缺省改 `~/.local/state/dais/warp.sqlite`(A2A_DAIS_DB 注入保留);SQL 改真实列名 `sequence/from_handle/to_handle` 且 SELECT 增 `subject`;行映射 ref 解析 = `refFromSubject(subject) ?? extractRef(body)`(新增 helper `refFromSubject` = `/^\[ref:([^\]]*)\]$/` 命中返回捕获组,否则 null→走 extractRef);存量 43 条(subject 恒 `'route'`、body 含 DSHMSG] 行或 `[ref:X]` 前缀)天然落入 fallback 分支,**只读不改、零迁移**;行映射对外键名 from/type/body/seq/ref 不变,新增 to/subject 增量键(agents/inbox 消费者零破坏);:203-207 表假设注释同步真实 schema。
- **文件级落点**: `http-server.js`:72(daisDbPath)、:208-218(defaultInboxReader 重写)、`refFromSubject` 新增于 :82 之后、:203-207(注释)。
- **可测验收断言**: (6) agents/inbox RPC 成功返回(不再 `no such column: seq`);(7) 新格式行 ref = subject 解析值(`send(ref:'LB-002')` → unread 行 ref='LB-002');(8) 旧格式兼容两形态: dais CLI 直投 `body='DSHMSG]{"from":..,"ref":"legacy-ref",..}' + subject='route'` → ref='legacy-ref';直投 `body='[ref:body-pref] hi' + subject='route'` → ref='body-pref';(9) 路径修复静态断言: grep http-server.js 含 `.local/state/dais/warp.sqlite` 且不含 `.local/share/dais/data.sqlite`;(10) 生产存量不动: 沙箱前后生产库 `body LIKE 'DSHMSG]%'` 计数不变(现场快照,不写死 43)。

### A.3 [R-B07 落点二选一 + R-S15] v3 字段在 dais 载体落点: msgid 不承载、dais 平面去重 = digest 模式、subject 单线承载 ref

- **引用**: R-B07⑤(messages 表无 msgid/ver/via/ttl 列,信封行从 body 拿掉后 v3 四字段无落点;修复行给二选一: "承认不承载 msgid、去重退 digest 并写明;或 msgid 编进 subject 如 ref@msgid");R-S15(msgid 主键平面退化——方案应显式声明各平面去重权威)。
- **裁决**(拍板**前者: 不承载 msgid**,即推荐项): msgid/ver/via/ttl 不在 dais 载体承载——不编 subject、不进 body、不造信封头;dais 平面去重权威 = digest 模式 `sha256(from\0body)`(与 core/dedup.js 现行 material 逐字一致;即 R-B16 裁决"msgid 只做 DSHMSG] 平面独立索引"在 dais 平面的自然推论)+ dais `messages.id` UNIQUE/`sequence` 主键天然幂等兜底;subject 单一职责 = ref(单行、`[ref:` sigil、UTF-8 ≤120 字节、ref 缺省→`[ref:-]`)。**拍板理由(一句)**: subject 保持 UI 可读的 ref 单行职责,dais 侧已有自己的 UNIQUE id 幂等面,`ref@msgid` 双载会把 subject 变成协议场并放大单行截断与 GUI/observatory 显示污染。§3 信封表后增"各平面去重权威"行(全文见 A.0 §6C 落点裁决块)。
- **文件级落点**: `http-server.js` 重载分支(`refSubject(ref)` helper,:82 后)、方案 §6C 落点裁决块 + §3 L108 邻近增行。
- **可测验收断言**: (11) `send(ref 缺省)` → subject=`[ref:-]`;(12) `send(ref 含 '\n')` → 投递成功且 `instr(subject, char(10))=0`;(13) `send(ref 300 字节长串)` → subject UTF-8 长度 ≤120;(14) grep 方案修订稿与 http-server.js 无 `ref@msgid` 组合编码;(15) 落库行不含 msgid/ver/via/ttl 任何键(body==原文已由断言 3 覆盖;subject 只匹配 `[ref:…]` 形态)。

### A.4 [R-S13] 轻/重载分叉: 拍板缓解一(消费侧双格式兼容,常驻设计),删除缓解二;两端 reader 名单写明

- **引用**: R-S13(§3⑤;L217 两缓解,评审明言"有效的是缓解一(extractRef 已天然双格式)…拍板缓解一并写明两端 reader 名单,删除缓解二")。
- **裁决**(拍板缓解一、删除缓解二——理由: v3 不改 `DSHMSG]` 前缀,"v2→v3"与"有信封行→无信封行"是正交维度,session-send 升 v3 解不了分叉,保留该句会诱导实施者做无效功): §6C 风险行改为"消费侧双格式兼容为**常驻设计**(非窗口期),两线 reader 互不相交";两端 reader 名单逐点写进方案(轻载线=DSH 回合注入行 + `bin/msg-dedup`;重载线=defaultInboxReader(refFromSubject 优先+extractRef 兜底)、`executors/dais.js` parseMailbox `[ref:X]` body matcher(匹配 worker 按契约写入的 body 前缀,与投递格式无关,零回归,不改)、dais GUI/observatory subject 直读、`check-messages` 消费者)——名单全文见 A.0 §6C 末段;兼容机制唯一承载 = reader 的 ref 双格式链,轻载线零改动。
- **文件级落点**: 方案 §6C 风险行(原 L217)整段替换;`http-server.js` reader(机制已由 A.2 落)。
- **可测验收断言**: (16) 同库注入新旧双格式行各 ≥1,agents/inbox 对两行 ref 各自正确(= 断言 7/8 的归并表述);(17) 轻载线产物格式不动: selftest 断言本轮不触碰 `bin/session-send`(git diff 范围断言,实施票验证段);(18) 文档级断言(归 spec 汇总者核验): 修订稿不再含"P3 内同步把 session-send 升 v3 统一"表述。

### A.5 [R-S08] 回滚顺序: 发送侧改造与 reader 修复同批 revert + 触达运行面(install.sh 面三)

- **引用**: R-S08(§3③;revert http-server.js 后,已写入 SQLite 的新格式消息能否被消费取决于 reader 修复是否同批 revert——回滚顺序需写明);补强证据: R-B10(git 不触达 rsync 部署面)与本节新证据①(生产 daemon 运行于 `~/.dsh/plugins/a2a-profile-server/`——host/install.sh:53 面三自包含拷贝,**不在 dev-sync 三面**)。
- **裁决**(见 A.0 §4 P3 回滚替换稿): ①**同批原子**: 四点改造+reader 修复同在 http-server.js 单文件,T4 收敛为单提交——`git revert` 即发/收同批回退,禁止拆分提交制造"半 revert"(reader 新、writer 旧或反之的中间态不存在);②**回滚顺序四步**: 仓单提交 revert → `host/install.sh` 重装面三(git 不触达 daemon 装点)→ kill+nohup 重启 daemon → 冒烟三查(registry 列表/轻载 push/journal 无新 failed);③**已落库新格式行 = 已接受降级**(E-S04 写死): 回滚后旧 extractRef 对纯正文行 ref 恒 `'-'`,消息本体不丢(check-messages 仍可消费),ref 对账断链不触发数据修复;④正向部署同链路(install.sh 面三 + daemon 重启;dev-sync 不覆盖 a2a 装点),写进 P3 交付行——避免实施者误以为 dev-sync 即部署。
- **文件级落点**: 方案 §4 P3 回滚行(原 L144)与交付行(原 L142);T4 实施记录(回滚演练输出)。
- **可测验收断言**: (19) selftest 幂等可重跑,连跑两遍全绿(OF-005 C11 基底);(20) 流程断言: T4 交付为单提交(发/收同文件同 commit);(21) 回滚演练(脚本化于 selftest `--rollback-drill` 可选段或实施记录留痕): 装点模拟目录 cp 新版→grep 有 `DAIS_MESSAGE_TYPE`→cp 回滚版→grep 零命中 + 旧 reader 对新格式行 ref 返回 `'-'`(已知降级实测留痕)。

### A.6 [R-S10/R-S25 局部] 沙箱 dais 实例方案: XDG_STATE_HOME + A2A_DAIS_DB 双隔离,真 CLI 直投,不动生产 warp.sqlite

- **引用**: R-S10①(沙箱只有 DSH 面、无 dais 实例,P3"SQLite…"库落点未定义)、R-S25(A2A_DAIS_DB 注入点 http-server.js:72 可复用;沙箱实例需落点/环境变量隔离手段);E-S06(生产 daemon env 无 A2A_DAIS_DB、缺省指 0 字节空库)。
- **裁决**(见 A.0 §4 P3 验证替换稿;机制经本节只读探针实证,见文件头新证据②): 沙箱 = `SBX=$(mktemp -d)`;`XDG_STATE_HOME=$SBX/state` 隔离 dais CLI 落库(`persistence/sqlite.rs:654` → `state_dir()` → directories ProjectDirs Linux 走 XDG_STATE_HOME;**实测**: 沙箱内首条命令自动建 `warp.sqlite`+wal/shm)与 socket 快路(`dais-runtime.json` 亦在 state dir,沙箱内不存在 → CLI 直连沙箱库、永不转发生产 GUI——实测 `check-status` 返 `0 runs` 证明未读生产 770 行库);`A2A_DAIS_DB=$SBX/state/dais/warp.sqlite` 隔离 reader;`A2A_DAIS_BIN` 缺省 `~/.local/bin/dais`(真 CLI 直投,messages 无 FK 到 runs,`run_id='router'` 直投合法);router 以 `createRouter({registry: 测试桩, journalPath: $SBX/journal.jsonl})` 进程内驱动(node `--input-type=module`),不启 daemon 不占端口;生产零接触以**句柄命名空间断言**保证(测试句柄一律 `nw-sbx-*` 前缀,前后查生产库零命中——对生产 GUI 常写噪声免疫,行数/mtime 仅记录不断言)。降级预案(仅当 XDG_STATE_HOME 假设在未来 dais 版本失效): A2A_DAIS_BIN 指包装脚本拦截 send-message 改 sqlite3 直写临时库(schema 以实测为准)——首选真 CLI。
- **文件级落点**: `tests/p3-dais-reload-selftest.py`(新建);方案 §4 P3 验证行(原 L143)。
- **可测验收断言**: (22) 生产库 `SELECT COUNT(*) FROM messages WHERE from_handle LIKE 'nw-sbx-%' OR to_handle LIKE 'nw-sbx-%'` 前后均为 0;(23) 沙箱库同句柄计数 = 本轮投递条数且 `MAX(sequence)` 与 ackRef seq 一致;(24) selftest 全部断言原子上报(`[ ok ]/[FAIL]`),非零退出码携带失败,全 temp 域结束打印 SBX 路径。

### A.7 [R-B07③尾/E-S04] extractRef legacy 永久保留

- **引用**: R-B07 修复行尾句("extractRef(body) 标记 legacy 保留");方案 §6C L216;E-S04(回滚后 ref 断链的已知损失正是 extractRef 兜底面)。
- **裁决**: `extractRef`(:76-82)函数体一字不动,P1-P4 任一阶段不删不重构;注释升级为"legacy 永久保留: 存量 43 条 `DSHMSG]` body 的唯一解读器 + `[ref:X]` body 前缀(dais→回包现役契约)的兜底解析;ref 主路径已迁 subject(见 refFromSubject),本函数是 fallback 半边"。它同时是 A.4 双格式兼容与 A.5 回滚降级两个裁决的机制支点。
- **文件级落点**: `http-server.js`:76-82(仅注释,零代码改动)。
- **可测验收断言**: (25) `git diff` 断言 extractRef 函数体行零改动(仅上方注释行允许差异);(26) 断言 8 的两形态即其行为回归测试。

---

# .nw-spec-raw-P3b — 窄腰三件套修订 spec · P3b 节(cb-send v3 + orca adapter)+ T5 票

> 起草: P3b。输入: nw-plan-review-report.md(权威清单)+ narrow-waist-implementation-plan.md(232 行版)+ .nw-review-D-raw.md / .nw-review-E-raw.md + 源码亲证。
> 行号为 2026-08-25 worktree 实测,可漂,**锚函数名为准**。orca-ide CLI 事实为本机实测探针(见 P3b.5)。
> 职责边界: 本节管 §6B(cb-send 行/message-bridge 行)、bin/orca-send 新脚本、tests/p3-cb-send-a-b-test.sh;§6C(dais 面)/§6A(host lane 换源)/§6D(pump)归其他节,本节只输出交叉事实(P3b.7),不开开放问题。

---

# A. spec 节(最终裁决版)

## P3b.1 [R-B17] cb-send v3 双通道 schema——三选一拍板:**受理落盘行透传**

**引用**: R-B17(报告 §2)、E-B03、D-N4;方案 §6B L206、P3 验收 L143、§0 约束 2 L9、§7 L229。

**裁决(单一版本)**:

1. **cb-send v3 载荷 = 单串双通道同构,七键**:
   `{"type":T,"from":F,"to":O,"body":"[ref:<ref>] <body>","ref":R,"msgid":M,"ver":3}`
   - 头四键 `{type,from,to,body}` 与现行四键行**逐字节不动**(python json.dumps 键序/分隔符承旧);
   - 尾部追加三键: `ref`(=CLI 第 4 参,恒携带,`-` 亦原样)、`msgid`(缺省 uuid4;`--msgid` 透传)、`ver`(恒 3);
   - `via`/`ttl` **不入 cb-send 面**——它们是 DSHMSG] v3 信封的跨 adapter 跳跃字段,cb-send 单跳直达无减跳语义(P3 验收原文"新版多 msgid/ver/via/ttl"据此改写,splice 见下);
   - body 恒带 `[ref:<ref>] ` 前缀(R-S03 升格期双写,见 P3b.3)。
2. **受理落盘行透传**: `http-intake.js` handleCallback 的 line 构造由四键白名单重组改为"头四键重组 + 尾部**条件透传** `ref`/`msgid`/`ver`"——payload 携带且类型合法(ref/msgid=非空字符串,ver=字面 2|3 数值)才透传;legacy 四键 POST 受理行**仍恰四键、零幻影键**。
3. **message-bridge canonical line(handle 内,现 :305)同款条件透传**——宿主受理面与会话内 MSGBR] 面两个 HTTP 面 schema 同构。该插件 P4 整文件删除(R-S07 裁决),本改动是 P3→P4 窗口的过渡投资,**上限=三处一行级**(见 P3b.7-3)。
4. **§0 约束 2 开显式例外**(文本见下);ORCA-CB]/MSGBR] **包裹面零改动**(pump makeWake `ORCA-CB] ${line}`、loopback-sink deliver、message-bridge wake `MSGBR] ${line}` 的"前缀+空格+原始行"格式不变——原始行升七键,包裹格式不动)。
5. **否决项理由(各一句)**: 选项②"v3 字段仅文件桥+对拍按通道分列"改动最小,但把 §3"msgid 升为去重主键"在 HTTP 主通道永久判死,且同一命令两通道异构的根病不除;选项③"HTTP 应答 `id: randomUUID()` 回填作 msgid 源"使 msgid 在发送侧/落盘侧两套,`--msgid` 重发保号依旧失效。拍板①: 文件桥(升级后)与受理行同构、双通道 schema 一致,R-B17 指出的"对拍判据两头不成立"从两头同时解除。
6. **键数算术(把评审倾向的"五键"钉死为七键)**: 倾向文案的"五键"=四键+msgid 最小集;本节把 R-S03 裁决的 **ref 双写字段**一并纳入透传集(否则 ref 字段只在文件通道存活,P4 前缀退役时 HTTP 受理行 ref 断链、ledger 对账断),再加 **ver**(R-S33 四态规则"有 ver→v3",否则七键行缺 ver 会被 detectVersion 误判 v2)。故最终透传集={ref,msgid,ver},四键头不动、新键尾部追加,计七键。

**文件级落点**:
- `bin/cb-send` — payload 构造(python 内联,锚: `payload=$(python3 -c '…')`,现 :28-32);用法头注释(:6-16)。
- `bin/cb-send.v2` — **新建**: 旧 cb-send 字节冻结副本(`git show HEAD:bin/cb-send > bin/cb-send.v2` + chmod +x);回滚件 + A/B 旧基线。
- `plugins/host-callback-bridge/http-intake.js` — 锚 handleCallback 内 `const line = JSON.stringify({type, from, to, body})`(现 :265)。
- `plugins/message-bridge/index.js` — 锚 handle 内 `const line = JSON.stringify({ type: payload.type, from: payload.from, to, body: payload.body })`(现 :305)。

**可测验收断言**: P3b.6 通道A A1/A2/A4、通道B B1/B4。

**方案文本 splice(嵌回 narrow-waist-implementation-plan.md)**:
- §0 约束 2 句末追加:
  「(唯一例外,R-B17 裁决: cb-send 受理落盘行 / MSGBR] canonical line / cb-send 文件桥行由四键升七键——头部四键 {type,from,to,body} 逐字节不动,尾部条件追加 ref/msgid/ver;旧四键行永久合法,消费侧按版本四态共存,细则见 §6B。)」
- §6B cb-send 行替换为:
  「| bin/cb-send(升 v3;旧版冻结 bin/cb-send.v2) | payload 四键 {type,from,to,body} | 五参位与降级链不动;新增 --msgid(重发保号)/--ver 2\|3(缺省 3);v3 载荷尾部追加 ref/msgid/ver 三键(七键),body 恒带 [ref:] 前缀(R-S03 双写);HTTP 与文件双通道产出**同构行**——受理落盘行透传(R-B17 裁决①,§0-2 例外);via/ttl 不入 cb-send 面(DSHMSG] 信封专属) |」
- §6B message-bridge 行句末追加:
  「;P3 窗口过渡同步: canonical line 尾部条件透传 ref/msgid/ver、内联 digest 材料条件分流、208 回执带 msgid(与宿主受理面同构,R-B17/R-S02)——P4 本文件整体删除(R-S07),投入上限即此三处一行级」
- §7 不变量 1 的「载体一字不动: inbox.log 行格式」后加注: 「(例外见 §0 约束 2: 受理行七键透传)」。
- P3 验证行 cb-send 子句替换为:
  「cb-send 新旧对拍**按通道分列**: 通道A 文件桥——cb-send.v2 ≡ cb-send --ver 2 逐字节;v3 行四键头与 body 前缀与 v2 行一致、尾部键序 [ref,msgid,ver]、ref 字段==前缀解析值、msgid=uuid4;通道B HTTP——受理行与文件桥行 JSON.parse 后深度相等且键序一致(字节格式随生产者,R-B05 裁决同款);同 msgid 重发→208 且回执带原 msgid;同 from 异 msgid→200;via/ttl 不入 cb-send 面。」

## P3b.2 [R-S02] msgid 进受理面双查键(条件接线)+ 208/200 回执带 msgid

**引用**: R-S02(报告 §3②)、R-B03、R-B16、R-S15;D-N7②(meta 依赖);方案 §2.3 L72-75、§6B L206-207。

**裁决(单一版本)**:

1. **digestKeys 双查双记(R-B03+R-B16 联合落地)**: `core/dedup.js` 新增导出
   `digestKeys(line, parsed) → { primary, secondary|null }`:
   - `parsed.msgid` 为非空字符串 → `primary=sha256(from\0msgid)`、`secondary=sha256(from\0body)`;
   - 否则 → `primary=sha256(from\0body)`、`secondary=null`;
   - from 缺失/非对象 → 整行材料(现行退化分支逐字保留)。
   受理面/文件面调用点: **seen = primary 或 secondary 任一命中即重;mark = 两键同记**(secondary 非 null 时)。
   理由(一句): 单条件分流(msgid??body)修 R-B16 但破 R-B03(v3 先投→v2 重发双 miss→重复投递);双键双记两头成立,且 (from,body) 键逐字保留现行为=对存量四键流量零语义变化。`digestOf` 保留导出(返回值=primary),既有引用不破。
2. **调用点接线(两处同款)**: `http-intake.js` handleCallback(锚 `const digest = digestOf(line, payload)`,现 :266-267)与 `file-router.js` flush(锚 `const digest = digestOf(line, value)`,现 :353-357)改用 digestKeys 双查;`file-router.js` deliverPending 的 `dedup.mark(digest)`(现 :274-275)改双记且 **meta = parsed.msgid ?? null**(208 回放 id/msgid 的数据源)。
3. **回执带 msgid**: 208 应答(现 :272-279)增 `"msgid": prior.meta ?? null`(`id` 字段语义不变);200 应答(现 :295-302)增 `"msgid": payload.msgid ?? null`。
4. **message-bridge 面(过渡)**: 内联 Map digest(现 :286-288)材料条件分流(msgid 非空→`from\0msgid`,否则 `from\0body`;该面 P4 即删、无跨版本双记义务);Map 值增存 `msgid: payload.msgid ?? null`;208(现 :293-300)增 `"msgid": prior.msgid ?? null`。
5. **重发保号生效链(定义)**: `cb-send --msgid M` → 任一 HTTP 面 digest 命中 → 208 且回显 msgid=M;或文件面 flush 时 digest 命中 skip——发送端拿到确定性重放证据,不再依赖 body 巧合。
6. **收方联动事实(预期行为升级,非回归)**: MSGBR]/ORCA-CB] 包裹行携带 msgid 后,`bin/msg-dedup`(按 `']'` 一刀切,对包裹行天然可解析)由"恒 pass"变为**可判重**;窗口文件名 = sanitize(to 全签名)。

**文件级落点**: `plugins/host-callback-bridge/core/dedup.js`(digestOf 保留 + 新增 digestKeys)、`http-intake.js` handleCallback、`file-router.js` flush/deliverPending、`message-bridge/index.js` handle。
注: 本改动在 §6A 换源前落 core/ 本地副本;**T2 库 createDedupWindow/digestOf 必须提供等价语义**(T5 依赖项),§6A 换源后 core/ 变 re-export、下列行为断言不变。

**可测验收断言**: P3b.6 通道B B2/B3/B5/B6/B7/B9。

## P3b.3 [R-S03] ref 双真相——权威=独立字段,升格期双写,前缀 P4 退役

**引用**: R-S03(报告 §3②);方案 §6B L206、§6C L215、§3 表 ref 行。

**裁决(单一版本)**:
1. **cb-send v3 双写**: ref 同时写 (a) 独立字段(尾部键,**权威**)、(b) body 前缀 `[ref:<ref>] `(legacy,P4 退役)。
2. **消费侧解析规则(收方统一,写进 SKILL)**: 优先读 `ref` 字段,缺失回退 body 前缀提取(与 §6C inbox reader"优先 subject、fallback extractRef"同构的"字段优先、编码回退"律)。
3. **对拍断言两处相等**: `envelope.ref == 前缀解析值`(A2/B1)。
4. **P4 退役动作(预告,执行归 P4 节)**: cb-send 停写前缀;受理行 ref 键已在透传集(P3b.1),前缀退役零断链;存量仅前缀行由回退分支覆盖。
5. §6C 的 subject 编码是 dais 面的结构化参数(第三编码),与本节正交;三编码收敛方向 = 字段/结构化参数,前缀与嵌套信封均 legacy。

**文件级落点**: `bin/cb-send` payload 构造;`shared/maestro-bridge/SKILL.md`「第二步: 一条命令回调(cb-send)」节补一行字段说明。

**可测验收断言**: A2(ref==prefix)、B1(受理行 ref 透传)。

## P3b.4 cb-send --msgid/--ver 参数解析边界(规格)

**引用**: R-B17 修复项(--msgid 重发保号)、方案 §6B L206;session-send :104-115 先例。

**裁决(单一版本)**:
1. **语法**: `cb-send [--msgid <id>] [--ver <2|3>] <type> <from> <to> <ref> <body>`。选项**位置无关**(scan-and-delete,与 session-send 同款);删除后位置参数恰 5 个,否则头注释→stderr + exit 2(承现行 :25 语义)。
2. `--msgid`: 必须带值且非空(缺值/空串 → exit 2 `cb-send: --msgid requires a value`);**不做格式强校验**(uuid4 推荐;跨平面 msgid 任意非空 token 透传容忍)。
3. `--ver`: 仅接受 `2`|`3`,缺省 3;其他值 → exit 2。`--ver 2` → 载荷与 cb-send.v2 输出**逐字节一致**(四键+前缀,无 ref/msgid/ver 键);`--ver 2` 与 `--msgid` 同给 → exit 2(冲突,二选一)。
4. 已知局限(与 session-send 一致,文档化不修): 位置参数值以 `--msgid`/`--ver` 起头会被误析;长 body 落文件传路径的既有纪律承接。
5. type 面不变: CLI 不校验 type(受理面白名单裁定,现行契约);PORT-R1 sig 校验/降级链/广播语义零改动。

**文件级落点**: `bin/cb-send` 头部参数解析段(现 :24-32)与用法注释。

**可测验收断言**: A3/A4/A5/A6。

## P3b.5 orca adapter——新脚本 `bin/orca-send`(orchestration send 升格: Run mailbox 优先 / PTY 降 L1 兜底)

**引用**: 方案 §1 adapter 行、P3 交付 L142、§6D;R-B17 关联面;comm-planes-model L54-55(L1/L2);comm-topology「orchestration send 升格为 adapter: 产 v3 信封;优先投结构化 inbox;PTY 仅本面兜底」。

**CLI 实测事实(2026-08-25 orca-ide 探针,供 P1/P3a 交叉引用)**:
- `orchestration send --subject <text> [--to <run:id|dispatch:id|legacy_handle>] [--run <run_id>] [--from <handle>] [--body <text>] [--type <type>] [--task-id <id>] [--dispatch-id <id>] [--outcome <succeeded|failed>] [--json]`;`--subject` 必填;worker_done 强制 `--outcome succeeded|failed`; Prefer --task-id/--dispatch-id over raw --payload。
- `--type` 合法集实测 = {notify, status, question, worker_done, escalation, handoff, dispatch, heartbeat, merge_ready, decision_gate} **恰 10 值 = V3_SIGNAL_TYPES 全集**;ping/ack/done/ask/steer/report/message/text 均被 `invalid_argument` 拒。⇒ **ORCA_TYPE_MAP 修正事实: notify→notify**(方案 §2.4 表 Orca 列"—"系误记),P1 节按此落表——事实输入,非开放问题。
- 读面: `orchestration check [--terminal <h>] [--run <id>] [--peek|--wait|--ack|--types …]`、`orchestration inbox`;PTY: `terminal send --terminal <h> --text <t> [--enter]`。
- CLI 解析约定(承 fleet-probe): `$ORCA_CLI_COMMAND`,缺省 `orca-ide`;**绝不用裸 `orca`**(GNOME 屏幕阅读器)。

**裁决(脚本规格,九条)**:
1. **用法**: `orca-send [--msgid <id>] [--via <id>] [--ttl <n>] [--terminal <handle>] [--outcome <succeeded|failed>] [--task-id <id>] [--dispatch-id <id>] [--json] <from> <to> <type> <ref> <body>`(位置参数序 = session-send 同款 from,to,type,ref,body)。
2. **信封**: T2 库 `createEnvelope({from,to,type,ref,body,msgid,ts,ver:3,via,ttl:5})` + `serializeLine` → `DSHMSG]{...}` 单行;via 缺省 `'orca-send'`(`--via` 逗号追加);ttl 缺省 5。
3. **主路径(L2,Run mailbox 优先)**: `$ORCA orchestration send --from <from> --to <to> --subject <ref> --body <serializeLine(env)> --type <orcaType> --json`;type=worker_done 时 `--outcome/--task-id/--dispatch-id` 透传(--outcome 缺失 exit 2);`--subject` 恒给(ref='-' 亦原样,CLI 必填)。子进程 15s 超时;exit≠0 或 stdout JSON `ok≠true` → 判失败。
4. **to 解析(resolveAddress,plane=orca 才发)**: ① `run:<id>`/`dispatch:<id>` 原样透传 `--to`(不读 fleet);② `term_` 开头 → orca 终端句柄(legacy_handle 形式直投 + PTY 兜底可用);③ 裸短码/别名 → 查 `MAESTRO_FLEET`,条目 `kind='orca-terminal'` → 取 `handle`(同②);非 orca 平面条目/解析失败 → **exit 1**(plane mismatch,提示走 session-send/cb-send),零 CLI 调用;④ `*` → **exit 2**(跨平面广播不等价,拒发)。
5. **PTY 兜底(L1)**: 仅当主路径失败**且**终端句柄可得(②③的 handle 或 `--terminal` 显式)→ `$ORCA terminal send --terminal <handle> --text "ORCA-CB] <bare-json>" --enter --json`;文本 = `'ORCA-CB] ' + JSON.stringify(env)`(**裸 JSON;严禁 ORCA-CB] 叠 DSHMSG] 双前缀**——msg-dedup 按 `']'` 一刀切,双前缀必析败)。主路径失败且无句柄 → exit 1(双路皆败,报两路错误)。
6. **出站 type 翻译(adapter 级,仅作用于 `--type` 参数)**: Orca 原生 10 型**小写直通**;`ack/done/ping/report` → `'status'`(无副作用 store-and-audit,同 R-B06 缺省裁决先例);`pong/nack/ask` → exit 2;`steer` → exit 2 且 stderr 提示改用 `terminal send --interrupt`。**信封 env.type 保留调用方原词**(翻译不回写信封,收方按原词对账)。
7. **库解析链**: `$NW_HOME` > 脚本相对 `../plugins/_narrow-waist` > `${MAESTRO_PRESET:-~/.dsh/.agent-presets/maestro}/plugins/_narrow-waist`(覆盖 仓内/装点/镜像三形态——镜像 `~/.dsh/maestro/bin` 无 lib,靠第三级存活);全败 → exit 1 带指引。
8. **输出与退出码**: 缺省人类可读单行(delivered 路径+msgid);`--json` → 单行 `{ok,delivered:'run-mailbox'|'pty',msgid,runId?,deliveryId?}`。exit 0=任一路径送达;1=双路失败/地址解析失败;2=用法/类型/地址非法。
9. **观测与边界**: 不写自有 journal(a2a router-journal 归属 a2a 面),stdout 即回执;`--body` 单行 ≤4KB(PTY 纪律,超限 exit 2 提示落文件传路径,SKILL 既有纪律承接)。

**文件级落点**: `bin/orca-send`(新建,node 脚本 `#!/usr/bin/env node`);文档面归 P3 集成(USAGE 一行),本票只交付脚本+测试。

**可测验收断言**: P3b.6 通道C O1-O9。

## P3b.6 `tests/p3-cb-send-a-b-test.sh` 断言清单(按通道分列)

**总则**: OF-005 基底——全 temp 域(mktemp -d)、`[ ok ]/[FAIL]` 原子断言、幂等可重跑、零 live 写入(不动 `~/.dsh/maestro/bridge`、不动生产 fleet);依赖 bash/curl/python3/node;exit 0=全绿。
**前置 fixture**: ①temp `MAESTRO_BRIDGE`;②temp `MAESTRO_FLEET`(orca-terminal 条目 + DSH session 条目各一);③mock-orca(`$WORK/mock-orca`: 录 argv 到日志,`orchestration send`/`terminal send` 按 mode 文件返 ok:true/ok:false,`ORCA_CLI_COMMAND` 指向之);④node 受理面 harness(复用 `plugins/host-callback-bridge` 的 `activate({bridgeDir, apiPort→mock 宿主})` + `registerConsumer`,配方照 selftest.mjs makeBridgeDir/makeMockHost)。

**通道A 文件桥(cb-send 本体,bash)**:
- **A1** `cb-send.v2` 与 `cb-send --ver 2`(同参)inbox 落行**逐字节相等**。
- **A2** `cb-send` v3 缺省: 行 JSON 键序恰 `[type,from,to,body,ref,msgid,ver]`;`{type,from,to,body}` 与 v2 行深度相等;body 含 `[ref:R] ` 前缀且与 v2 行 body 逐字节相等;**ref 字段 == 前缀解析值**;ver==3;msgid 匹配 uuid4 形;v3 行字节前缀 = v2 行去尾 `'}'`(同 python 序列化,头四键逐字节不动)。
- **A3** `--msgid <token>` 透传(自定 token 原样出现在行内)。
- **A4** `--msgid` 空值 / `--ver 5` / `--ver 2`+`--msgid` → exit 2、零落行。
- **A5** 非 5 参 → exit 2 打印头注释。
- **A6** 传输选路回归: PORT-R1 拦截 / 404 降级 / 广播跳 sig 三态与旧版一致(由 R1 全绿承接)。

**通道B HTTP 受理面(宿主 lane,node harness,真 cb-send 打真 intake)**:
- **B1** cb-send(HTTP 优先路径)→ 200;应答含 `"msgid":<M>`;inbox 尾行与文件桥行(关 HTTP 面的 cb-send)**JSON.parse 深度相等+键序一致**(字节格式随生产者——受理面 JS 紧凑、文件桥 python 带空格,R-B05 裁决同款);mock 宿主收到的投递文本 == `'ORCA-CB] '+受理行`。
- **B2** 同 payload(`--msgid M`)重发 → **208**;应答 `"msgid"==M`;inbox 零新行;mock 宿主零新投递。
- **B3** 同 from 异 msgid 异 body → 200+新行+新投递(R-B16 零误判重)。
- **B4** legacy 四键裸 POST(curl 手拼,无新键)→ 200;受理行**恰四键**(零幻影键);应答 `"msgid":null`。
- **B5** 同 from 异 body 四键×2 → 均 200+均投递((from,body) 语义键逐字保留)。
- **B6** 跨通道单次投递: B1 的受理行原样直 append inbox(模拟 cb-send 文件桥兜底重放)→ flush → 零新投递(digest 命中 skip)。
- **B7** 升级期双记(R-B03): B1(v3,msgid=M,body=X)投递后,post 同 from 同 body 的四键行(无 msgid)→ flush → 零新投递((from,body) 次键命中)。
- **B8** 语义回归: 坏 type→400;死签名 to→400(unknown-addressee 措辞不变);清空 registry→503——三态与现行一致(载体例外不扩语义)。
- **B9** msg-dedup 联动: `'ORCA-CB] '+受理行` 首跑 exit 0、60s 内重跑 exit 3(R-S02 收方升级生效)。

**通道B' MSGBR] 会话内面(过渡,静态断言)**:
- **C1** message-bridge/index.js canonical line 构造含 msgid/ref 条件透传(源形状 grep 断言;该面 P4 删除,不建动态 harness)。

**通道C Orca 面(mock ORCA_CLI_COMMAND)**:
- **O1** fleet 短码(kind=orca-terminal)→ mock 录得 `orchestration send`: argv 含 `--subject=<ref>`、`--type=status`(type=ack 输入)、`--from`/`--to`;`--body` 以 `DSHMSG]` 开头。
- **O2** `--body` parseLine round-trip: node 用 T2 库 parseLine 解 mock 录得的 --body → {from,to,type(=调用方原词 ack),ref,msgid,ver:3,via:'orca-send',ttl:5} 全字段断言。
- **O3** `--msgid` 透传;缺省 uuid4 形。
- **O4** mock orchestration send 返 ok:false → 降级 PTY: mock 录得 `terminal send --terminal <handle> --enter`;`--text` 形如 `'ORCA-CB] {'`(**裸 JSON,无 DSHMSG] 叠前缀**);剥前缀 parseLine 可解、msgid 一致。
- **O5** `to=run:<id>` 原样透传 `--to`;fleet 文件零读取。
- **O6** to=DSH session 条目 → exit 1,mock 零调用(plane mismatch)。
- **O7** type=steer → exit 2 且 stderr 含 `--interrupt` 提示;type=`Pong` → exit 2(大小写归一后仍拒)。
- **O8** type=worker_done 无 `--outcome` → exit 2;带 `--outcome succeeded` → argv 含之。
- **O9**(live 冒烟,默认 skip,`NW_T5_LIVE_ORCA=1` 才跑): `run-create` 临时 Run → `orca-send status` → `check --peek` → body parseLine 可解+msgid 相符 → 打印 run id 供人工清理;skip 时打印 `[skip] live-orca`。

**回归**:
- **R1** `bash tests/test_cb_send.sh` 全绿(旧断言不回归;其 ⑥ 形状断言用 .get 取值,对新键天然兼容)。
- **R2** `node plugins/host-callback-bridge/selftest.mjs` 全绿(T01-T12 不回归;T04 的 208 用例靠 (from,body) 次键继续命中)。

## P3b.7 交叉事实与边界声明(非开放问题)

1. **ORCA_TYPE_MAP notify 修正**(证据=P3b.5 探针)→ P1 节落表 `notify→notify`;Orca 合法集=V3_SIGNAL_TYPES 恰 10 值。
2. **via/ttl 归属**: DSHMSG] v3 信封面(session-send/orca-send/dais adapter);cb-send 面不携带——P3 验收原文改写 splice 已给(P3b.1)。
3. **message-bridge 过渡投入上限**: 三处一行级(digest 材料 / canonical line / 208+Map 值),P4 删文件;pickRecipient/槽表/D-N7 归 P4 节,本票不碰。
4. **pump.js(orca-callback)内联 dedup 本票不动**: 自有窗口,(from,body) 语义对 v3 行仍正确(同 body 重放命中、异 body 不误判);msgid 精度统一归 §6D 换源。
5. **大小预算(R-S32 关联)**: cb-send v3 行净增 ~90-120 字节(ref/msgid/ver);单行 ≤4KB(PTY)纪律下 body 预算由 ~4090 收窄至 ~3970,SKILL"长内容落文件传路径"承接;受理面上限仍 256KB;orca-send --body 同守 4KB。
6. **部署提醒(归 P3 集成,非本票动作)**: 受理面改动生效需 dev-sync(polyfill lane+装点+bin 镜像)+host 重启;本票验证全在 temp 域,不触生产(约束 4)。

---

# P4 节(最终裁决版)— 退役与部署面

> sectionId=P4 · 修订对象: `docs/narrow-waist-implementation-plan.md`(232 行版)§4-P4(L147-152)、§1 退役表(L20)、§6D(L219-225)中 P4 相关行。
> 输入: `docs/reports/nw-plan-review-report.md`(R-B08~R-B13/R-S14/R-S26/R-S30/R-S05)、`.nw-review-D-raw.md`(D-N1/D-N6/D-F8)、`.nw-review-E-raw.md`(E-S05/E-S14)。
> 本文所有行号均为 2026-08-25 worktree 实测锚点,施工以**函数名/特征行**为准,行号可漂。
> 规则: 每条单一裁决,无备选、无开放问题;报告给出的二选一按其推荐项拍板并附一句理由。

---

## P4.0 P4 后宿主投递栈拓扑声明 [R-S30 + R-B08 联动]

**裁决内容(写进方案 §4-P4 开头,原文级)**:

P4 完成后,投递栈终态为**一常驻 + 一兼容层**:

1. **host-callback-bridge(宿主 lane)= 常驻权威面**: 宿主 boot 即绑定回环 `POST /callback`(优先复用 `bridge/http.port` 记录端口,启动即写,锚 `http-intake.js start()` ~L429-455),并以 fs.watch 消费 `inbox.log`,按 `registry.json` 经 `/api/session.prompt` 唤醒目标会话(`ORCA-CB]` 信封);受理即落 inbox(HTTP-R2 选项 i)。**HTTP 口与 `http.port` 文件的唯一持有者**。部署面 = polyfill lane(`~/.dsh/plugins/` + `polyfill.patch.yml` 行),不在 cordis.yml。
2. **callback-bridge v4(cordis 行)= 会话内兼容层**: 仅 file-inbox 单 source(见 P4.1.2),提供 `bridge_arm`(签名回执 + 会话内泵,per-session 分槽)、`bridge_status`、`bridge_http_status`(deprecated 别名)。其存在意义是 **preset 自包含性**——无 host lane 的部署(裸 preset 安装、沙箱)仍有可用的会话内投递面;在有 host lane 的部署上按 USAGE §3.4 纪律**不再 arm**(POST /register),强 arm 会与 host lane 双消费(重复唤醒、无丢失,USAGE §3.4 已有警告,沿用)。
3. **standby 探活互让逻辑保留不删**(锚 `host-callback-bridge/index.js` resolveStandby ~L131-142): 对旧代际在飞会话(仍持有旧口)护驻一个进程生命周期;P4 重启后 host boot 直接 active。
4. **polyfill.patch.yml 的 host-callback-bridge 行保留**——host lane 是常驻面而非过渡面,polyfill 注册是其正式部署通道,不随 P4 退役。

**拍板理由**: R-S30 给的两形态("v4=会话内兼容层"或"仅 file source")同时采纳为同一裁决的两半——file-only 是兼容层的实现方式;host lane 常驻是 SI-003 已成事实(USAGE §3.4 纪律已在生产运行),P4 只需把拓扑写死并消除第二 HTTP 持有者。

**文件级落点**: 方案 §4-P4 增"拓扑声明"小节(上文 4 条原文);不改任何代码。

**可测验收断言**:
- P4 重启后 `ss -tlnp` 断言 `http.port` 所记端口恰一个监听进程 = host 进程(polyfill lane),无第二监听;
- `grep -c "kind: 'http'" agent.cordis.yml` 中 callback-bridge 行 config 的 sources 恰 1 条 file-inbox、0 条 http(见 P4.7 YAML);
- `~/.dsh/plugins/polyfill.patch.yml` 仍含 `host-callback-bridge/index.js` 行(不退役)。

---

## P4.1 callback-bridge v4 代差升级清单 [R-B08]

v4 现状 = v3.5/v1.0 时代内核,**按现状注册即复活 incident 0003(多会话互杀)与 0005(撞桥)防线**。P4 注册前必须完成以下四件升级(版本指纹 `4.0.0` → `4.1.0`,回执携带新指纹供磁盘对账):

### P4.1.1 sessionId 分槽(incident 0003 防线,必改)

**裁决内容**: `plugins/callback-bridge/index.js` 的单消费者状态改为 per-session 分槽,语义对齐 `orca-callback/pump.js` v3.6 slots 机制(锚 pump.js ~L683-687 `const slots = new Map()`、~L740-761 重复 arm 刷新绑定不换泵):
- `state = { consumer: null, sources: new Map() }`(锚 index.js ~L96-99)改为 `slots = new Map()`(sessionId → `{ agent, alias, canonical, sources }`);
- `armAll()`(锚 ~L101-140)改为 per-slot 实例化: 每会话独立的 `createFileInboxSource` 实例 + **独立 dedup 窗口** + **独立 `createAgentTurnSink` 实例**(对照 pump.js per-slot createPump ~L751);store(bridgeDir 布局与 state.json)进程内共享;
- `sinks/agent-turn.js` 单槽 `bind()`(锚 ~L12-17 `let agent = null`)**不改文件本身**,由 index.js 每 slot 各建一个实例实现多槽;
- `bridge_arm` execute(锚 ~L165-193)按 `agents.requireInitiator().id` 取槽,重复 arm 刷新绑定与别名、绝不复用他人泵;
- `bridge_status` 回执列出全部 slot;`ctx.effect` teardown(锚 ~L211-216)逐槽 stop。

**文件级落点**: `plugins/callback-bridge/index.js`(state/armAll/bridge_arm/bridge_status/effect 五处)、`plugins/callback-bridge/config.test.mjs`(增双 slot 用例)。

**可测验收断言**:
- 新增单测: 会话 A arm → 会话 B arm → 向 A 签名投递,A 收到回合且 B 不收(0003 场景复演,对照 `docs/tickets/0003` 用例形状);
- `bridge_status` 回执含两 slot;A 重复 arm(换 alias)后 A 回执新别名、B 槽不动。

### P4.1.2 生产行仅 file-inbox source,HTTP 面归 host lane(端口互踩整类消除)

**裁决内容**: v4 的 cordis 行 config **显式钉死 file-inbox 单 source**(完整 YAML 见 P4.7),不依赖 DEFAULT_CONFIG 的双 source 缺省。v4 生产永不绑 HTTP 口、永不写 `http.port`。HTTP 受理面(含 200/208 幂等、受理落 inbox)由 host lane 常驻承接(P4.0)。

**拍板理由**(R-B08 给"分槽或仅 file source/HTTP 归 host lane",本节与 P4.1.1 同时采纳而非二选一): 分槽修的是 sink 互杀(file 面同样存在,不可省);file-only 修的是端口互踩(v4 http source `port=0` 随机绑口**覆写** `http.port`,锚 sources/http.js ~L88 + ~L354-359,与宿主 boot 已绑口冲突)——两者正交,缺一即复活对应事故。

**文件级落点**: `agent.cordis.yml`(P4.7 YAML 字面);`plugins/callback-bridge/config.test.mjs`(增"单 source config 解析"断言)。

**可测验收断言**: `normalizeConfig(P4.7 行 config)` 返回 `sources` 恰 1 条 `kind:'file-inbox'`(单测);arm 后 `~/.dsh/maestro/bridge/http.port` 内容与 mtime 不变(部署后实测)。

### P4.1.3 http source types 补 ack/report(潜伏面加固)

**裁决内容**: `plugins/callback-bridge/sources/http.js` 的 `types = ['done','ping','status']`(锚 ~L87)改为 `['ack','done','ask','report','ping','status']`——与 `host-callback-bridge/http-intake.js` TYPES(锚 ~L31,6 值)同集。生产行虽不启用 http source(P4.1.2),该文件仍随插件分发且可在沙箱启用,缺 `ack` 会使一切 `cb-send ack` 在该面 400(R-B08 实证),必须就地修复;`port=0` 缺省与无 sig 行为**保持不动**(生产永不启用,不为死面再投资)。

**文件级落点**: `plugins/callback-bridge/sources/http.js` ~L87 一行;`plugins/callback-bridge/http.test.mjs` 改 types 断言。

**可测验收断言**: http.test.mjs 断言缺省 types 集 = 6 值且含 `ack`/`report`;`type:'ack'` 的 POST 在测试实例上 200。

### P4.1.4 PORT-R1 整体退役 + cb-send 同步改 [R-S14 并入]

**裁决内容**: 采纳 R-B08 修复括号中"明示 PORT-R1 退役并同步改 cb-send"支(弃"补 sig 写入"支)。理由: 唯一 sig 写入方 message-bridge(锚 `message-bridge/index.js` ~L509-516)随 P4 删除;host lane 持口者是 host 进程而非某会话,sessionId 签名语义不再成立;而残留 sig 会使所有定向 cb-send 永久绕开活着的宿主口直落文件桥(cb-send ~L36-43,受理语义与入口去重失效,R-S14 实证)。退役动作四件:
1. 删除文件 `~/.dsh/maestro/bridge/http.port.sig`(部署序列步骤,入退役清单);
2. `bin/cb-send` 删 sig 比对段(锚 `if [ -f "$B/http.port.sig" ]` 块 ~L36-43),头注释 PORT-R1 段(~L18-22)改写为: "跨代际撞桥防线 = host lane 常驻口(boot 即绑,端口复用不漂移)+ 显式 to 失配 404 → 降级文件桥";
3. `shared/maestro-bridge/SKILL.md` ~L41("端口持有者 sig 失配"措辞)与 `USAGE.md` §3.3(~L75-82 PORT-R1 段)同步改为"已退役(P4)";
4. `tests/test_cb_send.sh` 改例: sig 文件存在亦不拦截(回归防复活)。

**可测验收断言**: 部署后 `test ! -f ~/.dsh/maestro/bridge/http.port.sig`;人为重建 sig 文件后定向 cb-send 仍走 HTTP(不拦截);cb-send 单测全绿。

### P4.1.5 双跑期折抵裁决

**裁决内容**: `docs/callback-bridge-design.md` §4.2 的"P2 双跑验证"窗口以 **host lane 常驻期折抵**——生产上 host lane(SI-003)与两旧插件已并存数周,USAGE §3.4 即并存纪律,双跑事实已发生;P4 不再另设双跑窗口,一步切换。design §3.4 承诺的 `bridge_http_status` deprecated 别名保留**两个稳定周期**(自 P4 合入日起算),别名实现见 P4.5。

---

## P4.2 §6D pump.js 改造降级为不实施;callback-bridge/core/ 四文件 re-export 窄腰库 [R-B09 + R-S16 顺带]

**裁决内容**: 采纳报告选项②(推荐项)。
1. **§6D pump.js 行("四处换 import 删内联,~803→~550 行")整行删除**,替换为一句: "`plugins/orca-callback/pump.js` 全文不动,原样活到 P4 删除"。理由: 改造成果活不过 P4 删目录(两段清单互相拆台),且字面执行会物理删掉 v3.6 registryOpChain 写链(R-B14/D-N1),比不作为更糟。
2. **`plugins/callback-bridge/core/` 四文件(addressing.js/dedup.js/registry.js/store.js)改为原位 re-export 窄腰库对应模块**,如 `export { parseAddress, aliasIndex, resolveRouting } from '../../_narrow-waist/addressing.js'`(registry/dedup/store 同理,保持各文件**原有导出名与签名**逐字不变——含 `digestOf(line,parsed)` 兼容层与 pump 序 `resolveRouting(address,self,registry)`,由 P1 库侧按 R-S01②/R-S28 裁决承接)。由此: 三份 core 副本收敛为单一来源;registry 写链串行化/唯一 tmp 语义经库继承(D-N1 修复随之落地);v4 的 file-inbox.js 零改动自动获得库语义。
3. **`sources/file-inbox.js` 的 flush 内一切投递机制零改动**: 退避死信、undertaker、DSH-RE] 回声归档、游标钳位、轮转闸门、at-least-once 游标语义——D-F8 27 项清单属于 pump.js,file-inbox.js 是其平移件,P4 对它只做"内核换源"(经 core/ re-export 自动发生),不做行级改造。
4. **R-S16 顺带裁决**: `plugins/callback-bridge/` 目录**保留**——它不再是"未注册死代码",而是 P4 后的终态会话内兼容层(P4.0)。

**文件级落点**: `plugins/callback-bridge/core/{addressing,dedup,registry,store}.js`(四文件整体替换为 re-export 行,各 ≤10 行)、方案 §6D 表与 §6 新增 E 表(callback-bridge 行: "core/ 四文件 re-export `_narrow-waist`;index.js 分槽;行 config file 单 source")。

**可测验收断言**:
- v4 既有三份单测 `config.test.mjs`/`file-inbox.test.mjs`/`http.test.mjs` **断言零改动**全绿(re-export 兼容性证据);
- `grep -c "function\|=>" plugins/callback-bridge/core/registry.js` 等四文件无本地实现体(纯 re-export);
- 双槽并发 registerSelf 压测(两 slot 交错 flush 20 轮)后 `registry.json` 可解析且两条目俱在(写链继承证据,对照 D-N1 事故形态)。

---

## P4.3 部署与回滚程序补全 [R-B10]

**裁决内容(写进方案 §4-P4,替换 L150-151 原文)**:

**P4 变更收敛为单提交**: 全部 P4 改动(cordis 切行、删两目录、v4 升级、re-export、cb-send sig 段删除、dev-sync、persona/文档)恰一个 commit 落在 master(worktree),提交信息带 `nw-P4` 标记;禁拆多提交(回滚语义依赖单提交)。

**正向部署链(重启前必跑,写入 P4 验证条目)**:
```
① git 单提交合入 master
② bin/dev-sync.sh                # 全量重推: 装点(~/.dsh/.agent-presets/maestro)
                                 #   + bin 镜像(~/.dsh/maestro/bin) + polyfill lane
                                 #   (host-callback-bridge + _narrow-waist, 见 P4.4)
③ bin/dev-sync.sh --verify       # 全部段清零(装点/镜像/polyfill, 见 P4.4)
④ 删 ~/.dsh/maestro/bridge/http.port.sig   # PORT-R1 退役(P4.1.4)
⑤ 安静窗口重启 host              # 唯一重启点; 依赖 cordis 代际, 新会话即 v4 行
⑥ 五路径冒烟 + 24h 观测(见 P4.9)
```

**回滚五步(替换原"git revert + git checkout + 重启"三步)**:
```
① git revert <nw-P4 单提交>       # 弃用 git checkout HEAD~1(隐含单提交假设且只改仓)
② bin/dev-sync.sh                 # 全量重推三部署面——git 只回滚仓,
                                  #   生产 :3080 加载的是装点/polyfill 而非仓
③ bin/dev-sync.sh --verify        # 全部段清零
④ 重启 host(安静窗口)
⑤ 五路径冒烟复验(同 P4.9 断言)
```
回滚后 `http.port.sig` 随旧 message-bridge 复活而恢复语义(旧 cb-send 回流自装点/镜像),无需手工重建——dev-sync 已把旧 cb-send 推回。

**文件级落点**: 方案 §4-P4"交付/验证/回滚"三行重写(上文原文);`docs/reports/.nw-spec-raw-P4.md` 即文本源。

**可测验收断言**: 沙箱回滚演练(见 T6 工作说明)后: `diff -rq` 仓↔装点↔镜像↔polyfill 四面清零;`agent.cordis.yml` 装点副本含 orca-callback/message-bridge 行、无 callback-bridge 行;五路径冒烟全绿。

---

## P4.4 dev-sync polyfill 段增 `_narrow-waist` 同步 [R-B13]

**裁决内容**: `bin/dev-sync.sh` polyfill 段(锚 ~L75-84)扩为拷贝**两个目录**: 先 `rm -rf + cp -a plugins/_narrow-waist → ~/.dsh/plugins/_narrow-waist`,再照旧拷 `host-callback-bridge`(同段内完成,窗口原子性同现状)。`--verify`(锚 ~L27-35)在 mirror drift 段之后**增第四段 "polyfill lane drift"**: `diff -rq` 仓内 `plugins/host-callback-bridge`+`plugins/_narrow-waist` 对 `~/.dsh/plugins/` 对应目录;"清零"口径由"三段清零"改为**全部段清零**。`--polyfill-register` 幂等逻辑不动。

**顺序不变式(写进方案 §6A 表头注)**: 任何使 host-callback-bridge 引用 `../_narrow-waist/…` 的改动上线(含 P4 本批)之前,本条 dev-sync 变更必须已合入并执行——否则装点解析 `~/.dsh/plugins/_narrow-waist/…` ENOENT,宿主 boot 回调链路(SI-003 成果)apply 失败静默全断。

**文件级落点**: `bin/dev-sync.sh` polyfill 段 + --verify 段。

**可测验收断言**: dev-sync 后 `test -d ~/.dsh/plugins/_narrow-waist` 且 `diff -rq plugins/_narrow-waist ~/.dsh/plugins/_narrow-waist` 清零;`--verify` 四段全零;`node -e "import('~/.dsh/plugins/host-callback-bridge/index.js')"` 不抛 ENOENT(装点自包含可解析)。

---

## P4.5 `bridge_http_status` deprecated 别名 + persona/文档同步清单 [R-B11]

**裁决内容**:
1. **别名落地**: `plugins/callback-bridge/index.js` 注册第三个工具 `bridge_http_status` = deprecated 别名: 行为等同 `bridge_status`(查询/分槽回执,**不启动任何 HTTP 监听**——P4.1.2 生产行 file-only),回执首行加 `[deprecated] use bridge_status; the HTTP /callback channel is owned by the resident host lane (USAGE §3.4)`。兑现 `docs/callback-bridge-design.md` ~L174"两个稳定周期"承诺,计时起点 = P4 合入日(在 design §3.4 处标注)。
2. **persona 行改写**(`agent.cordis.yml` ~L100,原文级替换):
   > 1. Session start: register your callback identity — on host-lane deployments (USAGE §3.4) do NOT arm in-session; `POST /register {"sessionId","alias"}` to the port in `bridge/http.port` (the host lane owns the HTTP channel). On bare-preset deployments arm once with `bridge_arm { alias }` (file bridge; `bridge_http_status` is a deprecated alias of `bridge_status`). The receipt signature `<alias>@<sessionId>` is your replyable address for every dispatch you send.
3. **文档同步清单**(逐文件,P4 交付物):
   | 文件:行 | 现状 | 改为 |
   |---|---|---|
   | `agent.cordis.yml:100` | "arm both callback channels (bridge_arm, then bridge_http_status)" | 上文 persona 原文 |
   | `README.md:147` | 会话开场双 arm 指令 | host-lane 纪律(POST /register)/裸 preset 单 `bridge_arm` |
   | `USAGE.md:37`(§3 代码块) | `bridge_arm` + `bridge_http_status` 两行 | 裸 preset: 仅 `bridge_arm`;host lane: 不 arm(指向 §3.4) |
   | `USAGE.md:54`(§3.1) | "重新 bridge_arm + bridge_http_status" | "重新注册(host lane: POST /register;裸 preset: bridge_arm)+ 广播新签名" |
   | `USAGE.md:79`(§3.3) | PORT-R1 修复描述 | 标注"PORT-R1 已于 P4 退役;现防线=host lane 常驻口+404 降级" |
   | `USAGE.md:128`(§3.4) | "旧工具仍在,迁移期尽量不用" | 补终态句: orca-callback/message-bridge 已删;`bridge_http_status`=deprecated 别名 |
   | `USAGE.md:201`(§6.1 表) | message-bridge 行 | 删该行,增 callback-bridge 行(file 兼容层, bridge_arm/bridge_status) |
   | `docs/orch-loop.md:9` | "arm bridge_arm{alias} + bridge_http_status" | "register 签名(host lane: POST /register;裸 preset: bridge_arm{alias});签名落笔 maestro/bridge/orch.signature" |
   | `docs/comm-architecture.md:15,87` | message-bridge/bridge_http_status 标注 | 更新为 "callback-bridge v4(会话内兼容层)/host lane(常驻)";:87 行增"P4 起唯一 HTTP 持有者=host 进程" |
   | `docs/handoff-orch-gen2.md:6,20` | 开场双 arm 指令 | 同 persona 新措辞(评审清单外,grep 亲证存在,一并改) |
   | `skills/orca-bridge/SKILL.md:16,66-67` | bridge_arm 武装/HTTP armed 槽措辞 | 补 host-lane 分支;404 降级语义改指 host lane |
   | `shared/maestro-bridge/SKILL.md:41` | "端口持有者(sig 失配)" 选路描述 | 删 sig 支(并入 P4.1.4) |
   | `plugins/host-callback-bridge/README.md:36` | 对比表"编排会话(bridge_http_status arm)" | 标注该列已于 P4 退役 |
   | `docs/callback-bridge-design.md:174,195` | 别名承诺/清理计划 | 标注:P4 已执行,别名窗口计时起点=合入日 |
   历史事故记录(`docs/tickets/0003/0005` 等)与评审档案(`docs/reports/*`)**不改**。

**可测验收断言**: `grep -rn "bridge_http_status" --exclude-dir=reports --exclude-dir=tickets .` 命中仅剩: v4 别名实现与单测、deprecated 说明、design 标注——persona/USAGE/README/orch-loop/comm-architecture/handoff/skills 指令面**零命中**;别名单测: 调用返回含 `[deprecated]` 且不创建监听。

---

## P4.6 queen-v1 裁决: 显式冻结隔离 [R-B12]

**裁决内容**: 拍板**显式冻结隔离**——queen-v1 分发面零改动。理由: 不动第二生产面最安全;queen-v1 是已安装独立 preset(`~/.dsh/.agent-presets/queen-v1`,自带全套插件副本,pump.js 与仓内逐字节一致),注册行(`agent-presets/queen-v1/agent.cordis.yml` ~L334-343 附近: orca-callback + message-bridge)与安装面(host/install.sh 第 4 面,dev-sync 显式 `--exclude agent-presets`)本就不随 maestro preset 同步,冻结 = 无动作、无风险。具体规定:
1. **不动清单入方案 §4-P4**: `agent-presets/queen-v1/**`、`~/.dsh/.agent-presets/queen-v1/**`、queen 的 bridge 运行面全部零接触;
2. **已知残留风险记录在案**(写进 P4 风险注): queen 会话若 arm 其自带 message-bridge,仍会绑随机口**覆写共享的 `~/.dsh/maestro/bridge/http.port`**(锚 queen 副本 index.js ~L372 同源行为)——与 host lane 端口互踩;queen pump 与 host lane 共享 registry.json 则是既有并存语义(registry 路由双消费者,无互杀);
3. **缓解(运维面,非代码)**: P4 部署序列增 **pre-flight 检查项**——安静窗口判定时确认无 queen armed 会话在飞(`cat ~/.dsh/maestro/bridge/registry.json` 条目 + `ss -tlnp` 对照 http.port 持有进程为 host 进程);若 queen 会话在飞,等待退场或另行排期;24h 观测期内 dead.log 新增行若含 queen 侧 alias,记录归档并按需手工处置(不自动改 queen)。

**文件级落点**: 方案 §4-P4 增"queen-v1: 显式冻结"小节(上文 3 条)+ 不动清单一行。

**可测验收断言**: P4 前后 `diff -rq agent-presets/queen-v1 <基线快照>` 零差异;部署记录含 pre-flight 检查输出(registry 条目快照 + 端口持有者进程名);24h 断言(P4.9)不含 queen 侧新增死信。

---

## P4.7 v4 行完整 YAML 字面 + 行为面差异表 [R-S26]

**裁决内容**: cordis.yml 切行 = 删 orca-callback 块(~L354-362,含说明注释)与 message-bridge 块(~L364-370),原位替换为下述**完整 YAML 字面**(等价性不押在 DEFAULT_CONFIG 未成文缺省上;D-N6):

```yaml
# ── callback-bridge(会话内回调兼容层,窄腰终态)─────────────────────────────
#
# orca-callback(pump v3.6)+ message-bridge(v1.3)的收敛终态: 共享内核已提炼为
# plugins/_narrow-waist(core/ 四文件原位 re-export)。file-inbox 单 source——
# HTTP /callback 与 bridge/http.port 的唯一持有者是宿主 host-callback-bridge
# lane(polyfill 注册,见 USAGE §3.4),会话内不再绑口。per-session 分槽
# (incident 0003 防线保留);bridge_status 查询;bridge_http_status 为
# deprecated 别名(两个稳定周期后移除)。host lane 部署下按 USAGE §3.4 无需
# arm(POST /register);本行服务裸 preset 自包含场景。
- id: callback-bridge
  name: './plugins/callback-bridge/index.js'
  config:
    bridgeDir: null                # 解析: env MAESTRO_BRIDGE > 此处 > ~/.dsh/maestro/bridge
    aliasEnv: 'MAESTRO_BRIDGE_ALIAS'
    sink:
      messagePrefix: 'ORCA-CB]'
      pluginId: '@maestro/callback-bridge'
    engine:
      dedupWindowMs: 60000
      maxWakeFailures: 3
      retryDelayMs: 2000
    sources:
      - kind: 'file-inbox'
        file: 'inbox.log'
        echoPrefix: 'DSH-RE]'
        rotateMaxBytes: 1048576
        rotateMaxLines: 1000
```

(config.test.mjs 增例: 该字面解析结果 sources 恰 1 条 file-inbox——显式 config 覆盖双 source 缺省。)

**默认双 source 与被删两插件行为面差异表**(附进方案 §4-P4):

| 行为面 | orca-callback v3.6(删) | message-bridge v1.3(删) | v4 DEFAULT 双 source(生产不用) | 裁决后 v4 行(终态) |
|---|---|---|---|---|
| HTTP /callback 监听 | 无 | 127.0.0.1 随机口;写 http.port+sig | http source port=0 随机绑口**覆写 http.port**,不写 sig→与 host lane 互踩 | **不监听**;唯一持有者=host lane(P4.0) |
| type 白名单 | 无 | ack\|done\|ping\|status | done\|ping\|status(**缺 ack**,cb-send ack 必 400) | file 面无白名单;http source 缺省修 6 值(P4.1.3,潜伏面) |
| 消费者槽位 | per-session slots(0003 防线) | per-session slots(0003 防线) | 单槽 state.consumer+sink 单绑定(0003 复活) | **per-session 分槽**(P4.1.1) |
| registry 写链 | registryOpChain 串行化(v3.6) | 不写 registry(内存槽表) | core 无链裸读改写(ENOENT/丢更新,D-N1) | core/ re-export 窄腰库,写链随库继承(P4.2) |
| 唤醒前缀 | ORCA-CB] | MSGBR] | ORCA-CB](统一) | ORCA-CB];**MSGBR] 随 message-bridge 退役消失** |
| 208 幂等 | —(file 泵 dedup 窗) | HTTP 200/208(from,body) | http source 200/208 | HTTP 208 由 host lane 承接;file 面 dedup 窗保留 |
| 死信 | dead.log(v3.6 措辞) | 无(HTTP 4xx 同步拒) | file 面死信 | 措辞逐字保留(对账基准) |
| 撞桥防线 | — | PORT-R1 sig 旁挂 | 无 sig→防线缺失 | **PORT-R1 退役**(P4.1.4);防线=host lane 常驻口+404 降级 |

**可测验收断言**: 装点 `agent.cordis.yml` 与上述字面逐字节一致(dev-sync 后 diff);上表每一行有对应单测/实测断言兜底(各分项验收汇总)。

---

## P4.8 AGENT_CARD.json 降级 [R-S17/E-S11 顺带]

**裁决内容**: `AGENT_CARD.json` 从 P4 必选交付物中**移除**,降为可选附录(默认不做)。理由: 全仓零现存消费者、无先例(仅 a2a 标准端点 `/.well-known/agent-card.json` 可参照),且 P4 关键路径已重——排期性价比不支持;原方案路径 `shared/skills/maestro-bridge/` 本身也是错的(实为 `shared/maestro-bridge/`)。若未来做,先定义消费者并落 `shared/maestro-bridge/AGENT_CARD.json`。

**文件级落点**: 方案 §1 退役表(L20)与 §4-P4 交付行删 AGENT_CARD 字样,加一句"降级为可选附录,默认不实施"。

**可测验收断言**: P4 单提交 diff 中无 AGENT_CARD 相关文件(不做即不留半成品)。

---

## P4.9 冒烟五路径 + 24h 可判定断言 [R-S05 + E-S05]

**裁决内容(替换方案 L150"24h 无回归"为可判定断言)**:

**五路径冒烟**(P4 重启完成后立即,生产 :3080;脚本 `tests/p4-smoke.sh`,OF-005 模式: `[ ok ]/[FAIL]` 原子断言、幂等可重跑;基线 = 每步执行前采集 dead.log 行数与 state.json counters):

| # | 路径 | 命令(示例) | 断言 |
|---|---|---|---|
| ① | 外部→DSH 回调 | `cb-send status ext@p4smoke <orch签名> p4-smoke-1 'external->dsh'` | stdout 含 `http 200`(host lane 口);state.json `hostBridge.http.counters.delivered` +1;目标会话出 `ORCA-CB]` 回合;dead.log 零新增。**重发同 payload → `http 208`、duplicates +1、delivered 不变**(去重窗生效) |
| ② | DSH→DSH 直发 | `bin/session-send <from码> <to码> ping 'p4-smoke-2'` | 对端会话收到行;窄腰 `parseLine` 解析 ok(脚本内嵌 node 断言);msgid 唯一(同 ref 二发不产生第二次回合);dead.log 零新增 |
| ③ | DSH→dais 重载 | 经 a2a 面向 dais handle 投一条 | `~/.dsh/plugins/a2a-profile-server/state/*/router-journal.jsonl` 新增行 `delivered∈{push,mailbox}` 且**无 `failed`**;dead.log 零新增 |
| ④ | Orca→DSH | Orca 终端 `cb-send ack <term> <orch签名> p4-smoke-4 'turn started'` | 同①(200/208 + 回合唤醒 + dead.log 零新增) |
| ⑤ | DSH→Orca | `bin/session-send`/fleet 面向 verified Orca 终端发一条 | 终端 `terminal read --cursor` 可见该行;fleet 条目仍 verified;dead.log 零新增 |

每条共同断言: 信封行可解析、投递不产生新死信、去重窗幂等。

**24h 可判定断言**(冒烟完成时刻采集基线,24h 后比对):
1. `wc -l < ~/.dsh/maestro/bridge/dead.log` == 基线(**零新增行**);
2. state.json `hostBridge.http.counters.failed` == 基线值 且 file-router `counters.deadCount` 不变(**failed 冻结在冒烟基线**);
3. a2a `router-journal.jsonl` 无新增 `"failed"`(delivered 分布健康)。
附加采样: 五路径冒烟样本行在 inbox.log(+rotated)与 state.json 仍可查、msgid 唯一。

**文件级落点**: 新增 `tests/p4-smoke.sh` + `tests/p4-watch.sh`(基线采集/比对,读 state.json 与 dead.log/router-journal);方案 §4-P4 验证行替换为上文。

**可测验收断言**: `tests/p4-smoke.sh` 幂等重跑全绿;24h 后 `tests/p4-watch.sh check <基线文件>` 退出码 0。

---

## P4.10 方案 §4-P4 四行重写汇总(交付/验证/回滚/不动)

- **交付**: P4.1 v4 升级四件 + P4.2 core/ re-export;cordis 切行(P4.7 字面);删 `plugins/orca-callback/` 与 `plugins/message-bridge/`;`bridge_http_status` 别名 + P4.5 文档同步清单;PORT-R1 退役四件(P4.1.4);dev-sync `_narrow-waist` 同步 + --verify 增段(P4.4);queen 冻结记录 + pre-flight(P4.6);`tests/p4-smoke.sh`/`p4-watch.sh`(P4.9)。AGENT_CARD 降级不做(P4.8)。
- **验证**: 正向部署链六步(P4.3)+ 五路径冒烟 + 24h 三断言(P4.9)。
- **回滚**: 五步(P4.3),单提交 revert + dev-sync 全量重推 + --verify 清零 + 安静窗口重启 + 冒烟复验。
- **不动**: fleet/registry 格式、ledger.db schema、dais/Orca 运行时、`plugins/host-callback-bridge/` 逻辑(仅部署重推)、`plugins/callback-bridge/sources/file-inbox.js` 投递机制(P4.2.3)、`agent-presets/queen-v1/**` 与其装点(P4.6)、`~/.dsh/maestro/bridge/` 历史数据(inbox/rotated/dead/echo/游标)、polyfill.patch.yml 注册行(P4.0.4)。

---

# P5 — dais router 到达事件(最终裁决版 spec 节)

> 替换原方案 `docs/narrow-waist-implementation-plan.md`(232 行版)§5.3(L176-184)整节;§5.1 裁决记录与 §5.2 三面映射表的 dais 行经评审确认继续有效,不动。
> 引用基线: `docs/reports/nw-plan-review-report.md`(下称"报告")。源码锚点已按 /home/yy/warpdotdev/dais @ main(be8d9cf3)逐处亲证,行号可漂、**函数名为锚**。
> 对应票: T7(0013),`docs/tickets/0013-nw-t7-dais-router-event.md`。

## P5.0 范围与不动域(先钉死)

本节只改一件事: dais GUI 进程内 router 线程如何被唤醒——盲轮询 `thread::sleep` → 到达事件 Condvar wait(timeout 兜底)。效果主张(原方案 L179)细化为: 编排生命周期消息(尤其 block_settle 自动入队的 worker_done,原方案漏列的落库点、评审指认的最大受益者)从 500ms~2s 盲轮询延迟变为"落库即触发"。

不动域(违者即越界):
- MessageType 枚举(types.rs 9 值)与 SQLite schema(`crates/persistence/migrations/` 零改动——messages 表 `read`/`created_at`/`delivered_at` 列现成可用);
- delivery.rs 投递正确性逻辑(指针格式/500ms split-submit/flight 闸/watermark/"CR 之后才 mark_delivered"次序)、idle_detector、prompt_injection(B 链)、messaging.rs reconciliation;
- `drain_inbox`/`mark_messages_read`/`get_undelivered_unread`/`mark_delivered` 的语义与实现;
- 两个生产调用方零改动: `app/src/ai/agent_sdk/orchestration.rs`(send-message)与 `app/src/ai/orchestration/block_settle.rs`(worker_done)——这正是挂点收口在 store 层的意义(见 P5.1)。

## P5.1 [报告 §4.⑦「Condvar 改造点范围——不完备,漏一处生产落库点」(L229-232)+ 总裁决表 P5 行(L263)] 裁决: notify 单一挂点 = `DieselOrchestrationStore::enqueue_message` 成功返回处

**裁决内容(写进方案的具体规定)**:

1. notify 收口在 store 层,不在任何调用方: `crates/ai/src/agent/orchestration/store.rs` 的 `fn enqueue_message`(:1119-1160)内,`last_insert_rowid()` 取得成功之后、`Ok(seq)` 返回之前,调用一次 `arrival::notify_message_arrived()`;任何 Err 路径(insert 失败/seq 查询失败)不 notify。
2. 单一挂点即全覆盖——生产调用面恰两处,加测试调用面,全部经此函数:
   - ① `app/src/ai/agent_sdk/orchestration.rs:243`(SendMessage → GUI 转发的 send-message);
   - ② `app/src/ai/orchestration/block_settle.rs:95`(worker shell block 结算自动入队 worker_done 给 orchestrator——评审确认原方案漏此落库点,notify 只挂 send-message 路径时该消息类仍走盲轮询,效果主张对最关键消息类静默失效);
   - 测试面 router.rs:282 / delivery.rs:242,370 / store.rs:1593-1596 同样触发 notify——无 waiter 时代价为零,无害。
3. trait 零改动: `OrchestrationStore::enqueue_message`(mod.rs:82-90)签名与文档不动,notify 是 Diesel 实现的内部行为;未来新增任何入队面(新 CLI 子命令、新结算路径)自动携带事件——评审"一劳永逸覆盖两处及未来新增入队面"即指此。
4. **GUI/CLI 进程架构论证(进程内 Condvar 为何成立)**:
   - router 线程仅 GUI 进程持有: `app/src/lib.rs:1169-1217`,`is_cli_mode = matches!(launch_mode, LaunchMode::CommandLine)` guard,`FeatureFlag::Orchestration && !is_cli_mode` 才 `MessageRouter::spawn()`;serve 模式同样不跑 router(runtime_rpc.rs:122-132 自证 "Serve mode does not run a router")。
   - CLI 的 send-message 默认经 socket fast-path 转发进 GUI 进程执行: `agent_sdk/orchestration.rs:25-33` `try_socket_fast_path`(unix)→ runtime_rpc "orchestration" 分派(:348)→ `RpcDispatcher` 在 GUI 进程内调同一 `execute_command`(:141-149 注释自证 "the GUI process executes forwarded commands with the exact same semantics as a local CLI invocation")。GUI 在场时 enqueue 与 router 同进程,进程内 Condvar 必然可达。
   - block_settle 由 shell_event_bridge 驱动(shell_event_bridge.rs:276),亦在 GUI 进程。
   - **headless(CLI 直写 DB,无 GUI)不受影响**: fast-path 传输失败降级 direct-DB(orchestration.rs:681),CLI 进程自己 enqueue——该进程无 router 线程,notify 落在无 waiter 的 Condvar 上 = no-op;headless 本无推送面,行为与现状一致。

**文件级落点**: store.rs `enqueue_message` 尾部(+1 行调用+2 行注释);新文件 arrival.rs(见 P5.2);两调用方文件零改动。

**可测验收断言**: E4(见 P5.3)——断言 `enqueue_message` 成功后 arrival 代际恰 +1、失败入队代际不变,把"单一挂点"固化为回归断言(防未来把 notify 挪回调用方或误删)。

## P5.2 [报告 §4.⑦ + 原方案 L178「notify 丢失兜底 = 保留轮询间隔作 wait timeout——正确性不依赖事件」] 裁决: 到达 hub 规格(arrival.rs)与 Condvar wait_timeout 兜底

**裁决内容**:

1. 新文件 `crates/ai/src/agent/orchestration/arrival.rs`(进程全局到达 hub,约 70 行含单测),mod.rs 增 `pub mod arrival;`。API 钉死:

```rust
static HUB: OnceLock<(Mutex<u64>, Condvar)> = OnceLock::new();  // 进程全局模式参照 delivery.rs REGISTRY(:67-71)

pub fn notify_message_arrived() -> u64;   // 代际 +1 + notify_all,返回新代际
pub fn current_arrival() -> u64;          // 读当前代际(wait 前检查点)
pub fn wait_for_arrival(last_seen: u64, timeout: Duration) -> (u64, bool);
                                           // 阻塞至代际 > last_seen 或超时,返回(最新代际, 是否超时)
                                           // 先查后等: 进入 wait 前代已推进则立即返回——闭"周期进行中 notify 落空"窗
pub fn wake_all();                         // 不推进代际的广播,仅供 shutdown/Drop 唤醒
```

   为什么进程全局而非 store 实例字段: router 持专用连接的 store clone(lib.rs:1176-1186,router.rs 头注"Owns its own DB connection"),enqueue 调用方(RpcDispatcher/block_settle)各持别的 clone——通知必须跨 clone,OnceLock 静态是仓内既有范式(delivery.rs REGISTRY)。
2. **拍板: 采用 u64 单调代际 counter(而非裸 `Mutex<()>+Condvar`)——二选一取 counter**。理由: notify 落空窗不是微秒级——router 单周期含 push_pending,而 `deliver_pending` 内嵌 500ms split-submit sleep(delivery.rs:182),周期进行中到达的 enqueue 在裸 Condvar 下必然丢事件,恰在 P5 要消灭的忙路径上使"落库即触发"失效;counter + 先查后等以约 15 行代价闭掉该窗,且不引入任何正确性依赖(丢失场景仍由 timeout 兜底覆盖)。
3. router.rs 线程循环改造(spawn 闭包内 :98-127): `thread::sleep(sleep)`(:126)替换为 `let (gen, timed_out) = arrival::wait_for_arrival(last_seen, sleep); last_seen = gen;`。循环体(push_pending + drain_and_route)逐行不动;醒来先查 shutdown flag 再跑(现状 :99 已如此,保留)。`last_seen` 初始 0(代际单调,启动前积压消息会使首 wait 立即醒——顺带把启动期积压即时段化,无害)。
4. 退避映射钉死(与现状逐周期等价 + 一条新规则):

| 本轮 drain_and_route 结果 | wait 结果 | 下一周期 sleep 基值 | empty_count |
|---|---|---|---|
| Ok(true)(处理了消息) | 任意 | POLL_INTERVAL(500ms) | 重置 0(同现状) |
| Ok(false)(空轮) | Timeout 到期 | 阶梯: count<3 → 500ms,≥3 → 2000ms(同现状 :111-118) | +1(同现状) |
| Ok(false)(空轮) | Arrival/Wake/虚假唤醒 | 阶梯(按当前 count) | **不变**(新规则: 事件空轮不加深退避) |
| Err | 任意 | BACKOFF_INTERVAL(2000ms) | 不变(同现状 :120-124) |

   新规则理由: 事件唤醒后的空轮是并发消费(check-messages 拉链 / waiter claim)所致,不是"邮箱空"的证据,不应加深退避;也不清零——防外部高频 enqueue 把事件风暴打成忙轮询,即原方案 L179"退避态不被事件放大负载(唤醒≠加速空转)"的精确化。虚假唤醒归入 Arrival 列处理(多跑一轮幂等周期,无害)。
5. shutdown 交互: `MessageRouter::shutdown()`(:235-238)与 `Drop`(:254-267)在置 shutdown flag 后调用 `arrival::wake_all()`,wait 立即返回、循环顶检出 flag 退出;join 最坏等待从 ≤2s 降为毫秒级。shutdown 其余语义(2s join 超时、超时 detach)保留。
6. **正确性不依赖事件(兜底规格原文)**: 任何 notify 丢失、虚假唤醒、wake_all 竞态的最坏后果 = 退化为现状盲轮询——消息仍在一个 wait timeout(POLL 或 BACKOFF)内被 push/route。事件只是提前量,不是正确性条件。hub 不持有 DB 状态、不参与任何事务,与 SQLite 写路径零耦合。

**文件级落点**: arrival.rs(新);mod.rs(+1 行);router.rs `spawn` 闭包循环 + `shutdown`/`Drop`;store.rs `enqueue_message` 尾部(P5.1)。

**可测验收断言**: E1/E2/E3(见 P5.3)+ arrival.rs 自带单测三条(先 notify 后 wait 立即返回;wait 超时返回原代际;wake_all 不推进代际)。

## P5.3 [报告 §4.⑦「不变量四条——全部可测,但方案未把断言列成测试」(L238-241)] 裁决: 四不变量 + 事件机制断言清单(逐条单测用例)

可测性基础(报告已核实,均亲证): PushPlane.executor 是 `Arc<dyn PtyExecutor>` 可注入 MockPtyExecutor(executor.rs:25-35 trait,mod.rs:34 导出);signal_probe 是 `Arc<dyn Fn(&str)->IdleSignal>` 可注入 Busy/Idle;store 有 `in_memory()`(store.rs:114,router.rs 测试已在用);drain_inbox/read/delivered_at 直查可断言。以下用例全部进 router.rs / arrival.rs 的 `#[cfg(test)]`,全部 in_memory store、零外溢(R-S31 同款纪律):

- **INV-1「指针写成功才落 delivered_at,失败路径不动库」** `router_invariant_pointer_write_failure_leaves_null`: in_memory store + `register_dispatch("ctx_inv1")` + seed 2 条消息 + 注入恒败 executor(`write_to_pty` 返 Err,照抄 delivery.rs:315-322 FailExec 模式)+ probe=Idle;跑一轮 `push_pending`;断言 `get_undelivered_unread("ctx_inv1")` 长度仍 2(delivered_at 全 NULL)——消息不丢,留给下轮或拉链。(delivery.rs:301 已有 deliver_pending 级同款,本用例补 router 入口级。)
- **INV-2「pending 以 SQLite 为准,内存 watermark 只防重复注入」** `router_invariant_watermark_loss_no_leak_no_dup`: seed 消息 A → Mock executor + Idle probe 成功投递(delivered_at 落)→ `unregister_dispatch`+`register_dispatch`(模拟重启/重绑丢 watermark)→ seed 消息 B → 再跑一轮;断言: A 的指针行在 executor.writes 中恰 1 条(不重——A 的 delivered_at 已落,DB 侧过滤)、B 恰 1 条(不漏),轮末 `get_undelivered_unread` 清空。
- **INV-3「idle 闸不跳过——事件只提前尝试,Busy 仍不注入」** `router_invariant_event_wake_busy_zero_injection`: seed 消息 + probe 恒返 Busy(以 title="claude working" 构造 IdleSignal)→ 显式调 `arrival::notify_message_arrived()` 触发事件唤醒 → 跑一轮 push_pending;断言 executor.writes 为空、`get_undelivered_unread` 长度 1(零注入,DB 不动)。
- **INV-4「拉链仍是权威消费者」** `router_invariant_push_not_consume_pull_authoritative`: seed status 与 worker_done 各 1 条(to=测试 handle)→ push 投递成功后直查断言两行 `read==0`(push 只落 delivered_at,不消费)→ 再 `drain_inbox(handle)` 断言返回 2 行且此后 `read==1`。消费权与结算权在拉链,push 永不代劳。
- **E1 事件唤醒时效** `router_event_wake_beats_poll_interval`: in_memory store + spawn 真 router 线程(带 Mock executor + Idle probe);`store.enqueue_message(...)` 落库(内部自动 notify),等 executor.writes 出现指针行;断言 enqueue 返回 → 指针行的耗时 **≤450ms**(击败一个 POLL_INTERVAL=500ms 周期;事件路径理想值毫秒级,450ms 为 CI 慢机余量)。
- **E2 notify 丢失兜底** `router_missed_notify_timeout_fallback_delivers`: 全程不显式 notify(hub 无事件),消息落库后断言在 wait timeout 上界内(**≤2.5s**,覆盖最深 BACKOFF 态 + 处理余量)仍被投递——证明正确性不依赖事件。
- **E3 shutdown 即时唤醒** `router_shutdown_wakes_wait_immediately`: router 处于 BACKOFF 态 wait 中调用 `shutdown()`;断言 join 在 **≤200ms** 返回(现状最坏 2s)。
- **E4 单一挂点回归闸** `store_enqueue_notifies_arrival_hub`: 断言一次成功 `enqueue_message` 使 `current_arrival()` 恰 +1;构造失败入队(如坏 DB 句柄/失败 insert)断言代际不变——把 P5.1 挂点裁决固化为回归断言。

**可测验收断言(可执行)**: `cargo test -p ai agent::orchestration` 全绿,含上述 8 例新增 + 既有 router/delivery/store 全部用例零回归;arrival.rs 三条自测全绿。

## P5.4 [R-S22(报告 L173、§4.⑦"两个注意"① L236)] 排序注记: P5 收益对 C 节(T4)单向依赖,独立并行性不受影响

**裁决内容(写进方案的注记原文)**:
- P5 的延迟改善对象是"dais 内指针注入"(router→PTY)。经 a2a 重载路径进入 dais 的外部消息现状 100% 投递失败(R-B06/E-B02: `--message-type direct` 非法枚举 + 生产 router-journal 实测 `{'push':30,'denied':3,'mailbox':0}`)——**C 节修复票(T4)合入前,P5 对该外部路径的端到端收益无可感知对象;T4 先行后 P5 收益才对 a2a 重载路径成立**。
- P5 对 dais 内生生命周期消息(block_settle.rs:95 的 worker_done——恰是评审指认的最大受益者)的收益**独立于 T4 成立**;故 T7 验收全部走 dais 内生消息面(单测 + 沙箱 send-message),不依赖 T4 进度。
- 反向无依赖: C 节验收不依赖 P5。仓与部署轴层面零交集(C 改 maestro-preset 的 http-server.js,部署轴 = host dev-sync;P5 改 dais 仓 Rust,部署轴 = dais-build),T7 与 T2-T6 可全并行,回滚互不牵连。
- 协同注记(报告 §4.⑦"两个注意"②): T4 若做沙箱 dais 验证,与本节共用沙箱实例手段(P5.5);T4 的对拍若含时延断言,只允许引用与二进制代无关的上界(如"≤2s 轮询上界"),或显式注明基线随 P5 上线而变化。

## P5.5 [R-S25(报告 L142)] 验证手段: 单测时效断言(主判据) + 沙箱新旧二进制双跑(辅) + SQLite 直查观测

**裁决内容**:

1. **主判据在单测层(确定性、可进 CI)**: E1/E2(见 P5.3)——事件路径 ≤450ms 击败一个轮询周期;无事件时 ≤2.5s 兜底投递。不需要 GUI、不需要真实 PTY。
2. **沙箱双跑(半集成,验证真实二进制接线 + 量端到端延迟)**,落点与隔离手段钉死:
   - 沙箱根: `mktemp -d`(脚本自建自清,零残留)。**隔离 = 独立 HOME 启动**: dais 库路径经 `warp_core::paths::state_dir()`(paths.rs:144-154,XDG/HOME 派生)→ `persistence::database_file_path()`(sqlite.rs:654-658)落 `$SBX/.local/state/.../warp.sqlite`;runtime RPC 元数据 `dais-runtime.json` 同目录派生(runtime_rpc.rs:37-41)——故 CLI 用同一 `HOME=$SBX` 调用即自动 fast-path 进沙箱 GUI,不触生产 socket、生产库与在跑生产 GUI。
   - 双跑脚本 `script/p5-router-ab-delay.sh`(新): ①备份旧二进制(`cp target/release/dais dais-pre-p5.bak`,当前 target 即基线);②构建新二进制(必须带 orchestration feature: 直接 `cargo build --release -p warp --features orchestration`,或先跑 `~/.local/bin/dais-build`——其自带 sentinel 断言);③对每个二进制: `HOME=$SBX <binary> &` 起 GUI(启动等待上限 90s,判据 = `dais-runtime.json` 出现 + 日志含 "orchestration message router started",lib.rs:1210)→ `HOME=$SBX` CLI 连发 N≥20 条 `dais orchestration send-message <run> probe orchestrator status <subj> <body>`。
   - **主观测量 = read 位翻转时延(50ms 轮询)**: 直查沙箱库 `SELECT read FROM messages WHERE sequence=?`(send-message 回显 seq)至翻 1,记录 enqueue 返回 → 翻转耗时。理由: GUI router 只 drain "orchestrator" 邮箱(lib.rs:1199),read 位由 drain_inbox 事务翻转(store.rs:1170-1185),无需终端、无需 push 面、粒度 50ms、无日志格式依赖。
   - **辅助观测量 = delivered_at−created_at(按报告建议直查 SQLite)**: `SELECT (julianday(delivered_at)-julianday(created_at))*86400000 FROM messages WHERE delivered_at IS NOT NULL`。注记: 两列均 `DEFAULT CURRENT_TIMESTAMP` 秒级量化(migration 2026-08-13-000000 up.sql :14/:40-41),差值 ±1s 粒度,只作方向性辅助;且需沙箱 GUI 内绑定 idle 终端才落 delivered_at(best-effort,绑定失败记 SKIPPED 不判负)。
   - 判定: 新二进制 read 翻转中位 **≤200ms**;旧二进制中位 **≥400ms** 且样本呈 500ms/2000ms 阶梯分布。双跑记录落 `docs/p5-router-ab-delay-report.md`(dais 仓)。
3. A2A_DAIS_DB 复用注记: 该注入点属 a2a profile server 读库面(http-server.js:72,T4 域),P5 验证不经 a2a 面;T4 若需把 a2a 指到沙箱库,可 `A2A_DAIS_DB=$SBX/.local/state/.../warp.sqlite` 复用同一沙箱实例。

**可测验收断言**: 双跑脚本 exit 0(两条中位判据均满足);`~/.local/bin/dais-build --assert-current` PASS(sentinel 计数 0,orchestration feature 在场);生产库 `~/.local/state/dais/warp.sqlite` mtime 全程不变(R-S31 同款零外溢纪律,脚本内断言)。

## P5.6 部署轴与 P4 错窗

**裁决内容**: P5 部署 = dais 平面短暂下线(dais-build 重建 + resident GUI 重启),与 P4 的 DSH host 重启(:3080)是**两个不同部署轴**。规定: ①两窗口**不得重叠**——同时下线会使"外部→DSH 回调"与"dais 编排投递"两观测面同时失明,回归不可归因;②两窗口间保留 ≥30min 观测缓冲,先后顺序不限(P5 不依赖 P1-P4 任何阶段,可先行部署);③P1-P3 与 P5 无部署冲突(P3 改 a2a 插件 JS 面,部署轴 = host dev-sync,不触 dais 二进制)。

## P5.7 回滚

**裁决内容**: 回滚 = dais 仓 `git revert`(P5 变更单提交收敛)→ `~/.local/bin/dais-build` 重建旧版(sentinel 断言随跑)→ 重启 resident GUI → 沙箱冒烟(老行为回归确证: read 翻转回到 500ms~2s 阶梯)。快速通道: 部署前已备份的 `dais-pre-p5.bak` 可直接 exec,不等重建。与 maestro-preset 四阶段零耦合、互不牵连;沙箱 `mktemp -d` 自清,无残留面;DB schema 未动,新旧二进制对同一库完全兼容,回滚无数据面动作。
