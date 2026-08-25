# 窄腰三件套实施方案

> 三路调研(PhasePlanner/LibDesigner/MigrationPlan)汇编 + 两处现场核实(dais CLI 参数面、MessageType 枚举)。
> 可视化对照: `docs/assets/comm-topology.html`(三视图: 网格实态 / 逐跳现状 vs 窄腰升级 / 窄腰分层)。
> 修订(2026-08-25): 按评审报告 `docs/reports/nw-plan-review-report.md` 与修订规格 §G.0–§G.10 落稿——§6 阶段列与 P3.5 新设、词汇表 18 Signal 与每平面白名单、detectVersion 四态/ttl-via 执行规格/大小预算、验收可观测断言化、AGENT_CARD/downgrade 降级、§0 例外清单与部署面约束、全文锚点按函数名重标。

## 0. 已裁决约束(不可协商)

1. **无独立服务进程**——腰 = 共享库 + 查表文件 + 协议约定,骑在各平面既有常驻落点(host-callback-bridge 进程 / dais router 线程 / Orca 运行时)。ZeroMQ 式"库而非守护进程"。
2. **统一信封,不统一载体**——载体(inbox.log 行格式 / ORCA-CB] 前缀 / session.prompt RPC wire / SQLite messages 表 / PTY)一字不动。
   约束 2 例外清单(载体落盘行允许透传 msgid/v3 字段的平面——权威裁决见 P3b 节[R-B17/R-S02 三选一]):
   仅 P3b 节明列的受理落盘行(http-intake.js 受理落盘行@265 canonical line 与/或 message-bridge index.js canonical line@305)
   按其裁决开例;清单外载体——SQLite messages 表 schema、session.prompt RPC wire、PTY 字节流、
   ORCA-CB]/DSH-RE]/DSHMSG] 前缀行格式——一律不动。凡开例的行,其对拍断言与 MSGBR]/ORCA-CB] 面的
   格式影响须同步写入 P3 验收(按通道分列)。本清单是唯一开例通道: 新增例外必须先修订本清单再实施。
3. **零推倒**——现有资产升格: DSHMSG] v2→v3(严格超集)、fleet.json+registry.json→寻址解析层、core/ 四模块从桥内提炼、三套 type 方言→词汇表、skill 手册→Agent Card(降可选附录,见 P4 节)。
4. 生产 DSH :3080 每阶段零风险: P2/P3 对拍一律打沙箱 :3081 DSH 面(`/home/yy/tools/dsh-comm-sandbox/run.sh`);生产 :3080 仅 P3.5/P4 冒烟触达;回滚 = 不部署该阶段(部署面细则见约束 5)。
5. **部署面**——生产运行面不经仓直接加载,三面全由 bin/dev-sync.sh 推送:
   ①装点 ~/.dsh/.agent-presets/maestro(rsync -a --delete;dev-sync.sh DST@16/推送@57);
   ②bin 镜像 ~/.dsh/maestro/bin(:24/:69,cb-send/session-send 稳定回退路径);
   ③polyfill lane ~/.dsh/plugins/host-callback-bridge(:78-84,自包含单目录 rm -rf+cp -a 拷贝)。
   规定: (a) dev-sync polyfill 段增 plugins/_narrow-waist → ~/.dsh/plugins/_narrow-waist 同步拷贝,
   --verify 报告覆盖之——否则 §6A 的 import '../_narrow-waist/…' 在装点解析为 ENOENT、宿主回调链路静默全断;
   (b) 任何阶段交付触碰 plugins/host-callback-bridge/**、plugins/_narrow-waist/**、bin/**,其交付链必含
   "dev-sync 全量重推",回滚链必含 "git revert + dev-sync 全量重推 + --verify 清零 + 重启 host";
   (c) "git 操作 = 回滚"单独出现即违规——git 只改仓(worktree),不触达任何运行面。

## 1. 交付物总览

| 类别 | 交付物 | 阶段 |
|---|---|---|
| 共享库 | `plugins/_narrow-waist/`(envelope/addressing/dedup/vocabulary/index + 单测) | P1 |
| adapter | dsh(session-send 链路) / dais(a2a 重载) / orca(orchestration send) / cb-send 升格 | P2/P3 |
| 对拍 | `tests/p2-a-b-test.sh`、`tests/p3-cb-send-a-b-test.sh`(OF-005/VO-005 基底模式) | P2/P3 |
| 单源化 | host-callback-bridge import 换 `_narrow-waist` + core/ 四件原位 re-export(§6A 八行) | P3.5 |
| 单源化(§6E) | callback-bridge/core/ 四文件 re-export `_narrow-waist`(v4 注册前) | P4 |
| 退役 | cordis.yml 切行、旧插件目录删除、bridge_http_status 退役 | P4 |
| 触发机制 | dais router 盲轮询→到达事件唤醒(router.rs Condvar,见 §5) | P5(独立轴) |

AGENT_CARD.json 不在必交付清单——降级为可选附录(P4 后按需,见 P4 节)。

包选址: `plugins/_narrow-waist/`,前缀 `_` = 非 DSH 插件(无 apply/inject),纯库。
**分发选型依据**: preset 是目录复制分发,`node_modules` 不可达(mount.ts 裸名排除),4 个 adapter 以相对路径 `import ... from '../_narrow-waist/envelope.js'` 引入——与现有 plugins/ 分发方式一致,零 npm 依赖。

## 2. 共享库 API 设计

```
plugins/_narrow-waist/
├── index.js           # 桶导出
├── envelope.js        # 信封 v3: 构造/校验/序列化/解析/v2 互转
├── addressing.js      # agent:// URI 解析 + fleet/registry 联合查表
├── dedup.js           # msgid 铸造 + 窗口去重
└── vocabulary.js      # 信号词汇表(三方 type → 统一 Signal)
```

### 2.1 envelope.js

```js
export const LINE_PREFIX = 'DSHMSG]'      // 来源: bin/session-send 信封@127-129
export const ENVELOPE_VERSION = 3
export const V2_TYPES = ['ping','pong','done','ask','steer','nack','ack']   // session-send:6
export const V3_SIGNAL_TYPES = ['worker_done','heartbeat','escalation','dispatch',
  'status','question','handoff','decision_gate','merge_ready','notify']
  // 来源: dais types.rs 枚举@14-33(9 种,strum serialize,已现场核实) + a2a http-server.js ROUTER_TYPES@58(notify)

createEnvelope(opts)            // {from,to,type,ref,body,msgid,ts,ver=3,via,ttl=5};msgid 缺省 randomUUID
validateEnvelope(obj)           // → {ok,envelope} | {ok:false,errors[]},不抛;对 type 只校验非空字符串、不查闭集
                                //   (closed-set 拒收留在各 intake 应用层白名单常量,见 §2.4;
                                //   现网先例 http-intake validate@84-102、a2a http-server@142-144 维持原位,不升入库)
serializeLine(env)              // → 'DSHMSG]'+JSON 单行
parseLine(line)                 // → {ok, rawVersion: 3|2|null, …}
                                //   v2 → upgradeV2toV3 补齐后走 v3 路由;
                                //   legacy → 原样透传(键数不变),ref 从 body '[ref:]' 前缀提取,按旧式 parseAddress 路由(cb-send v1 语义);
                                //   malformed → {ok:false, errors[]},交应用层处置(file-router/pump 现行为: undertaker 门控死信,逐字保留)
upgradeV2toV3(v2, via)          // 补 ver/via/ttl,原字段与键序不动(OG5)
downgradeV3toV2(env)            // 剥 ver/via/ttl → 7 键
                                //   (测试辅助: 不进 index.js 桶导出,仅 envelope.js 命名导出供 envelope.test.mjs round-trip 用;
                                //    无生产调用方——OG5 严格超集下 v2 消费者忽略未知键)
detectVersion(obj)              // → 'v3' | 'v2' | 'legacy' | 'malformed'
                                //   v3: ver===3;v2: 有 msgid 无 ver;legacy: 无 msgid 无 ver(cb-send 4 键裸行,inbox 主流量);
                                //   malformed: 非 JSON 对象,或缺 type/from 等必要字段
enforceHopBudget(envelope, adapterId)   // 入站判定(仅对 v3 信封;v2/legacy 行直接放行)
                                //   ① via 链(逗号分隔)已含 adapterId → {ok:false, reason:`loop-detected: adapter '<id>' already in via chain '<via>'`}
                                //   ② ttl-1 后 ≤0 → {ok:false, reason:`ttl-exhausted: ttl=<n> at '<id>' (via='<via>')`}
                                //   ③ 通过 → {ok:true, envelope:{…env, ttl: ttl-1}}
appendVia(via, adapterId)               // 出站: 链尾追加;重复段/空段拒绝(validate 同规)
```

### 2.2 addressing.js

```js
parseAgentUri(uri)      // 'agent://id' | 'agent://id@session-…' | 'agent://*' | 裸旧式 → 结构化
resolveAddress(parsed, fleet, registry)
  // → {ok, plane:'dsh'|'orca'|'dais', handle, sessionId, alias} | {ok:false, reason}
  // 优先级: broadcast(*) > qualified(id@sid) > alias 查 registry > fleet code > 裸旧式兼容路径
  // plane 判定: 'session-' 前缀→dsh;fleet 条目 kind='orca-terminal'→orca;'ctx_'/'session_'→dais;缺省 dsh
parseAddress(to)        // 旧式保留导出(host-callback-bridge/core/addressing.js parseAddress@18-24 原文)
aliasIndex(registry)    // 保留导出(core/addressing.js aliasIndex@27-35)
```

(resolveRouting 形状泛化、resolveAddress 撞名裁决——库 API 细则归 P1 节。)

### 2.3 dedup.js

```js
forgeMsgid()                    // randomUUID(session-send:123 同构)
digestOf(envelope, mode='v3')   // v3: sha256(from\0msgid);v2: sha256(from\0body)——与 core/dedup.js 逐字兼容
createDedupWindow({windowMs=60_000})   // {seen,mark,prune,size};v3 主路径 msgid 索引
```
升级期双查: 先 msgid 命中再 digest 命中;窗口期结束(退役后)可去双查。
(digest 材料分流/双记/mark 时机/meta 签名——库 API 细则归 P1 节。)

### 2.4 vocabulary.js

统一 Signal 枚举(18 值)+ 三张静态映射 + 双向查表:

```js
normalizeType(rawType)            // 三态: 已知(18 Signal)→{signal,source};未知非空字符串→{signal:null,source:raw} 透传;
                                  // 空串/非字符串→{signal:null,source:null}。不做大小写归一("Status"→signal:null——归一会静默改 wire 值)
denormalizeType(signal, plane)    // Signal → 目标平面原生 type;不可译返回 null
DAIS_TYPE_MAP / DSH_TYPE_MAP / ORCA_TYPE_MAP
```

**关键裁决——有意区分 done 与 worker_done**(否决"合并为 done"的损耗方案):

| 统一 Signal | dais MessageType | DSH type | Orca --type | 语义 |
|---|---|---|---|---|
| `done` | — | `done` | — | cb-send 回调摘要(body 纯文本 ≤300 字) |
| `worker_done` | `worker_done` | —(adapter 出站译为 `done`) | `worker_done` | 编排生命周期(body=JSON {task_id,dispatch_id,outcome}) |
| `heartbeat` | `heartbeat` | — | `heartbeat` | 心跳续命(dais 有副作用) |
| `escalation` | `escalation` | — | `escalation` | 异常上抛,三平面同源零冲突 |
| `status` | `status` | `status` | — | 进度汇报(语义近似,统一 STATUS) |
| `report` | — | `report` | — | 中途进度通报/监控告警(event-watchd:259 经 session-send 实发;生产 inbox.log 23 条活跃;OF-006) |
| `dispatch`/`question`/`handoff`/`decision_gate`/`merge_ready` | 同名 | —(可译 ask) | 同名 | dais/Orca 原生 |
| `notify` | — | `notify` | — | a2a router 专用轻载 |
| `ping`/`pong`/`ack`/`nack`/`ask`/`steer` | — | 同名 | — | DSH 独有(steer 带 OF-002 租约闸) |

`report` 取"单列第 18 个 Signal"而非"映射 status": `denormalizeType('report','dsh')` 必须原词回译 `'report'`,并入 status 会在回译时改写 wire type、切断 event-watchd 收方按 type 的对账;单列对现网零行为变更。dais/Orca 列为"—"(出站不可译,adapter 拒发并提示,不静默改型)。

**每平面入站白名单常量**(值逐字取自现网点位,禁取 V2_TYPES 顶替——V2_TYPES 7 值不含 status、反多 pong/ask/steer/nack,照做即改行为):

```js
export const DSH_CALLBACK_TYPES  = ['ack','done','ask','report','ping','status']  // 源 http-intake.js TYPES@31(host lane 受理面,P3.5 换源时 TYPES := 此常量,值不变)
export const MSGBR_CALLBACK_TYPES = ['ack','done','ping','status']               // 源 message-bridge/index.js TYPES@73(P4 前冻结;仅作文档/对拍基准,message-bridge 零改动)
export const A2A_ROUTER_TYPES    = ['notify','steer','ping']                     // 源 a2a http-server.js ROUTER_TYPES@58(P3 换源时引用,值不变)
export const CB_SEND_TYPES       = ['ack','done','ping','status']                // 源 bin/cb-send:7 契约注释(v3 升格后值不变)
export const SESSION_SEND_TYPES  = [...V2_TYPES, 'report']                       // 源 session-send:6 文档 7 值 + 线上实发 report(仅文档基准;session-send 无 type 校验代码)
```

翻译责任在 adapter 出站侧: Signal.WORKER_DONE→dais 发 `worker_done`、→DSH 发 `done`。

## 3. 信封 v3 Schema(v2 对照)

| 字段 | v2 | v3 | 说明 |
|---|---|---|---|
| from/to/type/ref/body | ✅ | ✅ | 不变;v3 的 to 建议 agent:// URI,裸串仍兼容 |
| type 枚举 | 7 值 | 18 值 | +11 信号词汇(§2.4) |
| msgid | ✅ uuid4 | ✅ | 升为去重主键(from+msgid);各平面去重权威与载体开例面见 §0 约束 2 例外清单 |
| ts | ✅ epoch ms | ✅ | 不变 |
| **ver** | ❌ | ✅ 3 | 版本标识;v2 识别规则 = 有 msgid 无 ver |
| **via** | ❌ | ✅ string | adapter 标识链(逗号分隔),防套娃(执行规格见下) |
| **ttl** | ❌ | ✅ 5 | 剩余跳数,≤0 死信(执行规格见下) |
| **大小预算** | 单行 ≤4096B(惯例) | 三档 256B / 4096B / 256KB | 超限拒、不截断(细则见下) |

兼容策略(OG5"只增不改"): v3 = v2 严格超集,7 键保留键序不变,新 3 键追加尾部。
v2 消费者按 `]`+json.loads 解析忽略未知键即兼容;v3 消费者收 v2 由 `upgradeV2toV3` 补齐。

**ttl/via 执行规格**:

1. **入站减**: 减跳点 = **转发型 adapter 的入站点**(把信封再投到另一平面的点: a2a http-server 重载分支投递前、P4 后 callback-bridge 汇聚点)。同平面终端消费(host lane 泵消费 inbox 行)不减——"跳"= 跨平面转发;纯生产者(session-send/cb-send)只铸造不判定。createEnvelope 缺省 ttl=5 → 允许经过 4 个转发 adapter,第 5 个入站点判死。
2. **环回拒发**: 入站点发现 via 链含本 adapterId → 死信(HTTP 受理面同步 4xx + counters.rejected++,文件面直接 dead.log),不投递、不落 inbox。
3. **死信落点**: 与 unknown-addressee 同构——file-router flush() 死信路径(undertaker 门控,落 `bridge/dead.log`)。
4. **via 参数解析**(与 session-send `--via` 联动): 逗号分隔、段禁空串、禁重复段;违例 validateEnvelope 报 error(400)。

**死信 reason 六条对账基准**(§6A addressing 行"'dead' reason 措辞逐字保留"条款的扩写;新增 reason(如撞名裁决若新增)必须先入清单再上线):
现有四条逐字保留——`unknown-addressee: "to" field is missing or not a non-empty string` / `unknown-addressee: no registered consumer with sessionId <sid>` / `unknown-addressee: "<name>" is neither a registered sessionId nor a resolvable alias` / `unknown-addressee: alias "<name>" is ambiguous across <N> registered consumers; use <alias>@<sessionId>`——**加** `ttl-exhausted: …`、`loop-detected: …` 共六条为对账基准。

**信封大小预算三档与超限行为**:
- 三档: ①a2a heavy 阈值 256B(http-server.js:103)——§6C② 落地后 body 纯正文、信封头走结构化参数,v3 头不再挤占该档;②单行 ≤4096B(含 `DSHMSG]`/`MSGBR]` 前缀;`shared/maestro-bridge/SKILL.md:68` PTY 上限)——v3 头部净增 ≈25-40B(`,"ver":3,"via":"…","ttl":n`,via 每跳 +len(id)+1),body 预算收窄为 4096 − 头部开销;③HTTP body ≤256KB(http-intake.js:29 / http-server.js:42)——v3 增量可忽略,维持现状不新增校验。
- 超限行为: **拒、不截断**——发送侧(session-send/cb-send v3)在 serializeLine 后测长,`line.length > 4096` → exit 非 0 + stderr 提示"body exceeds 4KB line budget; write long content to a file and pass the path (SKILL.md:68)";受理侧不新增校验。
- 对拍用例: 4096 边界样本(body 长度使 v2 行 ≤4096 而 v3 行 >4096)——断言 v3 路拒+提示、v2 路成功,差异为已知收窄(边界用例进 envelope.test.mjs 与 p3 对拍脚本)。

## 4. 阶段规划

```
P1(库: 信封+寻址+去重+词汇表,纯函数) ─→ P2(dsh adapter + A/B 对拍) ─→ P3(dais/orca/cb-send/session-send adapter) ─→ P3.5(host lane 单源化) ─→ P4(退役)

P5(dais router 轮询→到达事件,独立部署轴,可与 P1-P4 任意并行,见 §5)
```

### P1 — 库落地(零生产接触)

- 交付: `plugins/_narrow-waist/` 五文件 + `envelope.test.mjs`/`addressing.test.mjs`/`dedup.test.mjs`/`vocabulary.test.mjs`
- 验证: temp 域跑单测(`MAESTRO_FLEET=/tmp/... node --test`)全绿;全部单测在 mktemp -d 桥目录下运行,断言 `~/.dsh/maestro/bridge` mtime 不变(零外溢)
- 验收: v2 示例信封解析 ver='2' 原字段原样;v3 round-trip 幂等;`agent://` 解析含 broadcast/qualified/bare 各分支;旧式短码解析结果与 session-send `resolve()` 一致;18 Signal 全覆盖 + 白名单点位全景 ∪ 线上实发类型全覆盖——点位全景: http-intake:31(6 值)/message-bridge:73(4 值)/a2a http-server:58(3 值)/cb-send:7(4 值)/session-send:6(7 值,仅文档)/pump(无白名单);线上实发: inbox.log type 普查(含 report)。每个实测类型经 normalizeType 后 signal 非 null 或显式透传打标
- 回滚: 删目录即回滚,不注册 cordis.yml,不触 :3080
- 不动: 所有 bin/、所有 plugins/ 现有文件、agent.cordis.yml、fleet/registry 格式;零 npm 依赖

### P2 — dsh adapter + 双跑对拍

- 交付: adapter(调 serializeLine+resolveAddress 投 `/api/session.prompt`,steer 闸保留应用层)+ `tests/p2-a-b-test.sh`
- 验证: 沙箱 :3081 DSH 面(`/home/yy/tools/dsh-comm-sandbox/run.sh`)双跑——同一批信封(7 type × from/to 形式)分别走旧 `bin/session-send` 与新 adapter,比对 wire payload `content[0].text` 逐字节相等;非属主 steer 两路均拒 exit 4
- 回滚: 停用新 adapter,旧 bin 原样继续服务(本阶段零运行面部署;任何 dev-sync 重推发生后,回滚按 §0 约束 5(b): git revert + 全量重推 + --verify 清零)
- 不动(仅限 P2): `bin/session-send`/`bin/cb-send` 在 P2 双跑对拍期间一行不改、不注册 cordis.yml;P3 起按 §6B 行升格

### P3 — dais / orca / cb-send / session-send adapter

- 交付: dais adapter(§6C ①②③④,反模式消灭)、orca adapter(Run mailbox 优先,PTY 降 L1 兜底)、session-send 升 v3(§6B:+via/ver/ttl、`--via`)、cb-send v3 升格(旧版留 `cb-send.v2`)、fleet-touch 换共享 fleet-resolve(§6D)、dais-orchestration SKILL.md 交叉引用(§6D)+ 对拍脚本;交付链含 dev-sync 全量重推(bin 镜像,§0 约束 5(b))
- 验证: 沙箱 :3081(DSH 面, /home/yy/tools/dsh-comm-sandbox/run.sh)+ 沙箱 a2a 面:
  起沙箱 a2a server 前导出 A2A_DAIS_DB="$SB/tmp/a2a-dais.db"(注入点已存在: http-server.js daisDbPath@72),
  断言全部打该临时库——①新投递行 body NOT LIKE 'DSHMSG]%'(sqlite3 COUNT==0);②message_type ∈ dais 9 值闭集;
  ③subject == ref 可查;④agents/inbox RPC 返回 ref == subject 值。禁止读写生产 ~/.local/state/dais/warp.sqlite。
  orca adapter 投递后 Run inbox 可被 parseLine 解析;cb-send 新旧对拍按通道分列判据(权威见 P3b 节)。
- 回滚: dais = revert http-server.js 单文件;orca = revert 新增脚本;cb-send/session-send/fleet-touch = git revert + `bin/dev-sync.sh` 全量重推 + `--verify` 清零(bin 镜像面,§0 约束 5(b))
- 不动: dais Rust 源码(9 MessageType 枚举不改)、Orca 运行时、fleet/registry 格式、任何 cordis.yml 注册

### P3.5 — host lane 单源化(生产触碰,需重启窗口;前置: P1(库) + P3(cb-send v3 双跑 ≥1 观察窗))
- 交付: §6A 八行——host-callback-bridge import 换 `_narrow-waist` + core/ 四件原位 re-export;
  bin/dev-sync.sh polyfill 段增 `plugins/_narrow-waist` → `~/.dsh/plugins/_narrow-waist` 同步(§0 约束 5)
- 验证: dev-sync 全量重推 → 重启 :3080 → 外部→DSH 回调冒烟(cb-send ack/done 各 1 条);
  dead.log 零新增;state.json hostBridge.http.counters.failed == 0;死信新 reason 仅限六条基准清单(§3)
- 回滚: git revert + dev-sync 全量重推 + dev-sync --verify 清零 + 重启 host(§0 约束 5)
- 不动: loopback-sink.js、fleet/registry 格式、a2a 面、bin/、message-bridge

### P4 — 旧路径退役(唯一需重启 host 的阶段,选安静窗口)

- 交付: cordis.yml 切行(删 orca-callback/message-bridge 行,增 callback-bridge v4 行);删 `plugins/orca-callback/`(pump.js 803 行)与 `plugins/message-bridge/`;`bridge_http_status` 退役(deprecated 别名过渡与 persona/文档同步清单入交付);callback-bridge/core/ 四文件 re-export `_narrow-waist`(§6E;v4 代差修复细则归 P4 节)
- 验证: 生产 :3080 重启后五条路径全链冒烟(外部→DSH 回调 / DSH→DSH 直发 / DSH→dais 重载 / Orca→DSH / DSH→Orca),每条信封可解析、msgid 唯一、去重窗生效;交付链含 dev-sync 全量重推(§0 约束 5(b))
- 24h 可判定断言: (硬门)①~/.dsh/maestro/bridge/dead.log 行数与冒烟基线差 == 0;
  ②state.json hostBridge.http.counters.failed == 冒烟基线(==0);
  ③~/.dsh/plugins/a2a-profile-server/state/*/router-journal.jsonl 24h 无 "delivered":"failed" 行且 mailbox 投递 >0;
  (观测)④file-router counters(state.json hostBridge 镜像): deadCount 零增、deliveredLines 单调增、dedupCount 增幅 ≤ 冒烟期 ×2;
  ⑤五路径冒烟各 ≥1 条 delivered 且 msgid 唯一(inbox.log 采样 + jq 去重断言)。
- 回滚: git revert(P4 变更收敛为单提交)+ `bin/dev-sync.sh` 全量重推 + `--verify` 三段清零 + 重启 host + 五路径冒烟(§0 约束 5(b);三段式细则归 P4 节)
- 不动: fleet/registry 格式、ledger.db schema、dais/Orca 运行时
- AGENT_CARD.json(可选附录,P4 后按需): 默认不做;若启动,路径 `shared/maestro-bridge/AGENT_CARD.json`(与 SKILL.md 同目录),且前置条件 = 先落地一个机读消费者(如 dais/orca adapter 启动时能力发现),否则不创建;可参照 a2a 标准端点 `/.well-known/agent-card.json`(http-server.js:630)。

对拍基底 = OF-005-report.md(VO-005)模式: 全 temp 域、`[ ok ]/[FAIL]` 原子断言、幂等可重跑、零副作用、并发安全。

## 5. 统一投递机制: 到达事件 + 指针直发 + 拉结算

三面共同语义一句话:**推只负责"叫一声",正文永远躺库里,消费权与结算权都在收方**——
持久队列 + 到达事件触发 + idle 闸 + 指针直发 + agent 拉取权威结算。

### 5.1 裁决记录(防反复)

- **拒绝"到达即直发正文 steer"**: read 闭环只有拉链拥有(`check-messages` 是 authoritative consumer,delivery.rs 头注释)。直注正文进对话: 不标 read → 同一消息双消费;发送时标 read → PTY 写失败消息永久丢。正确性模型原文: *"No failure path mutates the DB except a successful pointer write"*——指针写成功才落 `delivered_at`,任何失败路径不动库。且外部 harness 终端(Claude Code/ccr…)只有 PTY 字节流,busy 时无 queue 契约,直注=打断/污染进行中 turn。
- **结构化 turn 插入仅对 DSH 收方存在**: 宿主拥有运行时,`session.prompt mode:'queue'` = "queue appends a turn; steer interrupts the running one"(client/contract/session.ts:38)。队列天然串行,busy 零干扰——DSH 面即统一形态的完全体。
- **B 链整段注入仅限 dispatch**: prompt_injection.rs(bracketed paste + 500ms + 单独 `\r`)只用于编排器驱动全程、主动接受打断的场景,不用于普通消息。
- **指针行不承正文**: 正文永远在 SQLite,PTY 只搬 ~40 字节指针(`format_message_pointer`);长度风险与 PTY 丢字节风险与消息大小解耦。

### 5.2 三面映射(现状 vs 差距)

| 平面 | 持久队列 | 到达触发 | idle 闸 | 推形态 | 拉结算 | 差距 |
|---|---|---|---|---|---|---|
| DSH | 宿主持久 turn 队列 | ✅ 到达即入列 | 不需要(queue 不打断) | 结构化插 turn 即投递 | 回合驱动即消费 | 无——统一形态完全体 |
| dais | SQLite `read=0 AND delivered_at IS NULL` | ❌ router 线程盲轮询: POLL 500ms,空转 3 次退避 2s(router.rs:27-29,105-127) | ✅ idle_detector(title 主路径 + alt-screen/precmd/静默多信号融合) | A 链指针行注入 PTY | `check-messages` 权威标 read | **唯一差距: 轮询→到达事件** |
| Orca | Run mailbox 运行时存储 | 同源(dais delivery.rs 注释: 移植自 Orca deliverPendingMessagesForLeaf) | ✅ | 指针推 | `check/inbox` + `check --wait --types worker_done,escalation,question` 阻塞会合 | 随其运行时同构同步 |

### 5.3 P5 改造: dais router 轮询→到达事件(独立阶段,可与 P1-P4 并行)

- **改造点(唯一)**: `crates/ai/src/agent/orchestration/router.rs` router 线程的 `thread::sleep(POLL_INTERVAL)` 盲等改为 Condvar wait + notify:`send-message` 落库成功后 notify 立即跑一轮 `push_pending + drain_and_route`;notify 丢失兜底 = 保留轮询间隔作 wait timeout——**正确性不依赖事件,事件只消延迟**。
- **效果**: 指针注入延迟 500ms~2s(轮询间隔+退避)→ 落库即触发;退避态不被事件放大负载(唤醒≠加速空转)。
- **不变量(必须保持)**: ①指针写成功才落 `delivered_at`,失败路径不动库;②pending 判定仍以 SQLite 为准,内存 watermark 只防重复注入;③idle 闸不跳过——事件只提前尝试,Busy 仍不注入;④拉链仍是权威消费者。
- **范围**: 不动 MessageType 枚举、不动 SQLite schema、不动 idle_detector、不动 B 链;落库点加一次 notify 调用。
- **验证**: dais 单测(Condvar 唤醒 + notify 丢失兜底路径)+ 沙箱 dais 实例新旧二进制双跑,量 arrival→指针行出现延迟;dais-build 重建+断言后部署 resident。
- **回滚**: dais 独立仓库独立二进制,git revert + dais-build 旧版重建;与 maestro-preset 四阶段零耦合。
- **部署轴**: 需 dais 平面短暂下线(重建 resident),与 P4 的 DSH host 重启是**两个不同部署轴**,窗口错开。

## 6. 逐文件改造清单(阶段列 ∈ {P1, P2, P3, P3.5, P4, 不动, 无改造, 过渡期零改动})

### A. 外部→DSH 回调入口(host-callback-bridge)— 阶段 P3.5(loopback-sink 全阶段不动)

| 阶段 | 文件(锚,函数名为权威) | 现状 | 改造 |
|---|---|---|---|
| P3.5 | index.js(imports@27-34,仅引 store/dedup 两 core 模块;组装@144-177;全文 228 行) | import core 闭包组装 | import 换 `_narrow-waist`;组装传 adapter 配置;resolveBridgeDir/log/probePort/standby 不动 |
| P3.5 | http-intake.js(TYPES@31;validate@84-102;createHttpIntake@117-189;受理落盘行@265;counters@145-158) | TYPES 白名单 6 值硬编码;validate 四字段 | import 换源;TYPES := DSH_CALLBACK_TYPES(§2.4,值不变);validate 对 v3 字段宽容(未知键不拒);受理落盘行 `JSON.stringify({type,from,to,body})` **不变**(载体;开例裁决见 §0 约束 2 例外清单与 P3b 节) |
| P3.5 | file-router.js(配置/counters@61-106;deliverPending@256-283;flush@285-383,dedup 链@336/@353-354) | flush(): parseAddress→resolveHostRouting→dedup 链 | 换窄腰统一路由函数;`sink.deliver()` 不变;轮转闸门留宿主 lane |
| 不动 | loopback-sink.js(wire@46-66) | wire=session.prompt + `ORCA-CB]` 前缀 | **整文件不动**(全阶段;载体+DSH RPC 非腰部管辖);resolveApiPort 可选复用 resolveFleetCode |
| P3.5 | core/addressing.js(parseAddress@18-24;aliasIndex@27-35;resolveHostRouting@43-70) | 三导出(与 pump.js parseAddress/aliasIndex@142-159 同源) | 提炼进库 + `parseAddress` 增 agent:// 分支;`resolveHostRouting` 泛化(形状/撞名裁决归 P1 节);原位变 re-export;**'dead' reason 措辞逐字保留**(六条对账基准见 §3) |
| P3.5 | core/registry.js | 原子读写(与 pump.js registry@194-239 同源;单次写原子、读改写无链) | 提炼进库;原位 re-export(version 字段与 sanitize 白名单相容性、写链并入裁决归 P1 节) |
| P3.5 | core/dedup.js | digestOf+窗口(与 pump.js digestOf@106-115 同源) | 提炼进库;原位 re-export(材料分流/双记/mark 时机裁决归 P1 节) |
| P3.5 | core/store.js | 目录布局+state 原子写 | 提炼进库;paths 布局/hostBridge 分节名不变;原位 re-export |

### B. DSH→DSH 直发 — 阶段 P3(message-bridge 无改造,P4 删除)

| 阶段 | 文件(锚,函数名为权威) | 现状 | 改造 |
|---|---|---|---|
| P3 | bin/session-send(resolve@32-42;parse_ts@45-53;find_entry@56-65;steer_gate@76-100;信封@127-129) | resolve()/steer_gate()/v2 信封构造 | 信封构造升 v3(+via/ver/ttl,`DSHMSG]` 前缀不变);新增 `--via` 参数;resolve() 提炼进库(fleet-resolve DNS 角色),steer_gate 读共享函数(语义与审计三件套锁定归 P2 节) |
| P3 | bin/cb-send(payload@28-32,body 恒带 `[ref:]` 前缀;PORT-R1 sig 比对@36-43) | payload={type,from,to,body} | 增 msgid(uuid4)与可选 `--msgid`(重发保号)/`--ver 3`;HTTP 主通道 v3 字段落点三选一归 P3b 节裁决,对拍判据按通道分列 |
| 无改造(冻结;P4 删除) | plugins/message-bridge(TYPES@73;dedup Map@168-176;validate@210-228;判定@215-217) | 内联 dedup Map;TYPES 白名单;pickRecipient 内存槽表路由 | 无改造。v1.3 原样运行至 P4 删除;dedup Map(@168-176)/TYPES(@73)/validate(@210-228)/pickRecipient(@414-422) 零改动;dedup 单一化由 host lane 承接;MSGBR] 前缀与四键 canonical line(@305)维持到删除为止(例外清单见 §0 约束 2) |

### C. DSH→dais 重载(反模式消灭)— 阶段 P3

`plugins/a2a-profile-server/http-server.js` 重载分支(heavy 阈值@103;heavy 判定@161;dais 调用@171-179;ROUTER_TYPES@58;daisDbPath@72;extractRef@76-82;defaultInboxReader@209-218):

- 现状: `line='DSHMSG]'+JSON.stringify(envelope)` 塞进 `--body`(信封嵌 body 的分层缺失);`--message-type` 硬编码 `'direct'`。
- **已现场核实**: `dais orchestration send-message` 为 `send-message [OPTIONS] --message-type <T> --subject <S> --body <B> <RUN_ID> <FROM> <TO>`——from/to **本就是位置参数,当前代码已在结构化传递**。
- 改造四点: ① `--message-type` 由硬编码 `'direct'` 改为词汇表 `denormalizeType(signal,'dais')`,缺省改 `'status'`;② `--body` 由信封行改为 `envelope.body` 纯正文;③ `--subject` 由固定 `'route'` 改为承载 `ref`;④ 新增 defaultInboxReader 修复(库路径/SQL 列名/SELECT 增 subject;ref 解析改"优先 subject、fallback extractRef";v3 字段落点二选一)。①~④ 内容细则与验收归 P3 节(R-B06/R-B07)。信封头字段(from/to/type/ref)全部升格为消息结构化参数——消灭嵌套。
- extractRef(body) 标记 legacy 保留(存量 SQLite 43 条 `DSHMSG]` body 只读不改,inbox reader 仍需解析旧格式)。
- 风险: 轻载路径(session-send)仍产 `DSHMSG]` 行而重载不再产——轻/重载分叉的收方 reader 互不相交——轻载线: `bin/session-send` 信封行(@127-129)→ `bin/msg-dedup:4`(消费);重载线: dais body → `plugins/a2a-profile-server/http-server.js` 的 defaultInboxReader/extractRef(@76-82)+ `plugins/a2a-profile-server/executors/dais.js:119-124`。extractRef 天然双格式(`DSHMSG]` json 行 / `[ref:X]` 前缀 / 均不中返 '-'),双格式窗口期零动作。

### D. Orca 双向 — pump 过渡期零改动(P4 删除);其余 P3

| 阶段 | 文件(锚,函数名为权威) | 现状 | 改造 |
|---|---|---|---|
| 过渡期零改动;P4 删除 | plugins/orca-callback/pump.js(803 行;digestOf@106-115;parseAddress/aliasIndex@142-159;resolveRouting@171-192;registry@194-239,register/unregister@375-410;store@287-373;flush 内 dedup@609-617/638-639) | 四组核心函数与 core/ 同源内联;27 项 pump 特有机制 | **过渡期零改动**——27 项 pump 特有机制(.nw-review-D-raw.md D-F8 清单)天然全保留,该清单转为 P4 callback-bridge 升格时的行为对拍基准;P4 删除 `plugins/orca-callback/`;单源化在 P4 经 callback-bridge/core/ 四文件 re-export `_narrow-waist` 兑现(§6E,内容归 P4 节) |
| P3 | bin/fleet-touch(get_entry@137-141;LEASE_KEYS/fleet_lock@105-118) | get_entry() 与 session-send resolve() 各自内联 | 合并提炼进库 fleet-resolve(exact/prefix 参数化);claim/heartbeat/release/sweep/flock 零变化 |
| P3 | shared/skills/dais-orchestration/SKILL.md(@49-55) | 9 MessageType 约定 | 增词汇表交叉引用与重载路径升格说明;映射必须与 C 实现 `denormalizeType` 逐条一致 |

### E. callback-bridge 单源化(v4 注册前)— 阶段 P4

| 阶段 | 文件(锚,函数名为权威) | 现状 | 改造 |
|---|---|---|---|
| P4 | plugins/callback-bridge/(version 4.0.0;core/ 四件与 host-callback-bridge/core/ 逐字同源) | 未注册死代码;第三份 core 副本 | 注册前 core/ 四文件改 re-export `_narrow-waist`;v4 代差修复(单消费者/sink 重绑/types 丢 ack/http.port.sig/端口覆写)与 cordis 行 config 形态、P4 后投递栈拓扑——内容裁决归 P4 节(R-B08/R-S26/R-S30) |

## 7. 不变量(全阶段)

1. 载体一字不动: inbox.log 行格式 / `ORCA-CB]`、`MSGBR]`、`DSHMSG]` 前缀 / session.prompt RPC wire / SQLite messages 表 schema / PTY 字节流(唯一开例通道 = §0 约束 2 例外清单)。
2. fleet.json / registry.json / ledger.db 格式零变化(腰部只读消费)。
3. steer 租约闸(OF-002)、slots 分槽、per-consumer 游标、轮转闸门 = 应用层策略,不升入腰部。
4. `node:*` 内建之外零依赖;v2→v3 严格 OG5 超集,任一阶段中止旧路径可独立续跑。
