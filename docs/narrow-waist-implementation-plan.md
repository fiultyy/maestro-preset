# 窄腰三件套实施方案

> 三路调研(PhasePlanner/LibDesigner/MigrationPlan)汇编 + 两处现场核实(dais CLI 参数面、MessageType 枚举)。
> 可视化对照: `docs/assets/comm-topology.html`(三视图: 网格实态 / 逐跳现状 vs 窄腰升级 / 窄腰分层)。

## 0. 已裁决约束(不可协商)

1. **无独立服务进程**——腰 = 共享库 + 查表文件 + 协议约定,骑在各平面既有常驻落点(host-callback-bridge 进程 / dais router 线程 / Orca 运行时)。ZeroMQ 式"库而非守护进程"。
2. **统一信封,不统一载体**——载体(inbox.log 行格式 / ORCA-CB] 前缀 / session.prompt RPC wire / SQLite messages 表 / PTY)一字不动。
3. **零推倒**——现有资产升格: DSHMSG] v2→v3(严格超集)、fleet.json+registry.json→寻址解析层、core/ 四模块从桥内提炼、三套 type 方言→词汇表、skill 手册→Agent Card。
4. 生产 DSH :3080 每阶段零风险,一切先沙箱(:3081 / dsh-comm-sandbox)验证;回滚 = 不部署该阶段。

## 1. 交付物总览

| 类别 | 交付物 | 阶段 |
|---|---|---|
| 共享库 | `plugins/_narrow-waist/`(envelope/addressing/dedup/vocabulary/index + 单测) | P1 |
| adapter | dsh(session-send 链路) / dais(a2a 重载) / orca(orchestration send) / cb-send 升格 | P2/P3 |
| 对拍 | `tests/p2-a-b-test.sh`、`tests/p3-cb-send-a-b-test.sh`(OF-005/VO-005 基底模式) | P2/P3 |
| 退役 | cordis.yml 切行、旧插件目录删除、bridge_http_status 退役、AGENT_CARD.json | P4 |

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
export const LINE_PREFIX = 'DSHMSG]'      // 来源: bin/session-send:129
export const ENVELOPE_VERSION = 3
export const V2_TYPES = ['ping','pong','done','ask','steer','nack','ack']   // session-send:6
export const V3_SIGNAL_TYPES = ['worker_done','heartbeat','escalation','dispatch',
  'status','question','handoff','decision_gate','merge_ready','notify']
  // 来源: dais types.rs:14-27(9 种,strum serialize,已现场核实) + a2a http-server.js:45 ROUTER_TYPES(notify)

createEnvelope(opts)            // {from,to,type,ref,body,msgid,ts,ver=3,via,ttl=5};msgid 缺省 randomUUID
validateEnvelope(obj)           // → {ok,envelope} | {ok:false,errors[]},不抛
serializeLine(env)              // → 'DSHMSG]'+JSON 单行
parseLine(line)                 // 识别 DSHMSG] 前缀与裸 JSON;v2(有 msgid 无 ver)打标 rawVersion:2
upgradeV2toV3(v2, via)          // 补 ver/via/ttl,原字段与键序不动(OG5)
downgradeV3toV2(env)            // 剥 ver/via/ttl → 7 键
detectVersion(obj)              // → 2|3|null
```

### 2.2 addressing.js

```js
parseAgentUri(uri)      // 'agent://id' | 'agent://id@session-…' | 'agent://*' | 裸旧式 → 结构化
resolveAddress(parsed, fleet, registry)
  // → {ok, plane:'dsh'|'orca'|'dais', handle, sessionId, alias} | {ok:false, reason}
  // 优先级: broadcast(*) > qualified(id@sid) > alias 查 registry > fleet code > 裸旧式兼容路径
  // plane 判定: 'session-' 前缀→dsh;fleet 条目 kind='orca-terminal'→orca;'ctx_'/'session_'→dais;缺省 dsh
parseAddress(to)        // 旧式保留导出(host-callback-bridge/core/addressing.js:4-16 原文)
aliasIndex(registry)    // 保留导出(core/addressing.js:20-30)
```

### 2.3 dedup.js

```js
forgeMsgid()                    // randomUUID(session-send:123 同构)
digestOf(envelope, mode='v3')   // v3: sha256(from\0msgid);v2: sha256(from\0body)——与 core/dedup.js 逐字兼容
createDedupWindow({windowMs=60_000})   // {seen,mark,prune,size};v3 主路径 msgid 索引
```
升级期双查: 先 msgid 命中再 digest 命中;窗口期结束(退役后)可去双查。

### 2.4 vocabulary.js

统一 Signal 枚举(17 值)+ 三张静态映射 + 双向查表:

```js
normalizeType(rawType)            // 任意平面 type → {signal, source}
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
| `dispatch`/`question`/`handoff`/`decision_gate`/`merge_ready` | 同名 | —(可译 ask) | 同名 | dais/Orca 原生 |
| `notify` | — | `notify` | — | a2a router 专用轻载 |
| `ping`/`pong`/`ack`/`nack`/`ask`/`steer` | — | 同名 | — | DSH 独有(steer 带 OF-002 租约闸) |

翻译责任在 adapter 出站侧: Signal.WORKER_DONE→dais 发 `worker_done`、→DSH 发 `done`。

## 3. 信封 v3 Schema(v2 对照)

| 字段 | v2 | v3 | 说明 |
|---|---|---|---|
| from/to/type/ref/body | ✅ | ✅ | 不变;v3 的 to 建议 agent:// URI,裸串仍兼容 |
| type 枚举 | 7 值 | 17 值 | +10 信号词汇 |
| msgid | ✅ uuid4 | ✅ | 升为去重主键(from+msgid) |
| ts | ✅ epoch ms | ✅ | 不变 |
| **ver** | ❌ | ✅ 3 | 版本标识;v2 识别规则 = 有 msgid 无 ver |
| **via** | ❌ | ✅ string | adapter 标识链(逗号分隔),防套娃 |
| **ttl** | ❌ | ✅ 5 | 剩余跳数,每过一 adapter 减 1,≤0 死信 |

兼容策略(OG5"只增不改"): v3 = v2 严格超集,7 键保留键序不变,新 3 键追加尾部。
v2 消费者按 `]`+json.loads 解析忽略未知键即兼容;v3 消费者收 v2 由 `upgradeV2toV3` 补齐。

## 4. 阶段规划

```
P1(库: 信封+寻址+去重+词汇表,纯函数) ─→ P2(dsh adapter + A/B 对拍) ─→ P3(dais/orca/cb-send adapter) ─→ P4(退役+Agent Card)
```

### P1 — 库落地(零生产接触)

- 交付: `plugins/_narrow-waist/` 五文件 + `envelope.test.mjs`/`addressing.test.mjs`/`dedup.test.mjs`/`vocabulary.test.mjs`
- 验证: temp 域跑单测(`MAESTRO_FLEET=/tmp/... node --test`)全绿
- 验收: v2 示例信封解析 ver='2' 原字段原样;v3 round-trip 幂等;`agent://` 解析含 broadcast/qualified/bare 各分支;旧式短码解析结果与 session-send `resolve()` 一致;词汇表 17 Signal 全覆盖
- 回滚: 删目录即回滚,不注册 cordis.yml,不触 :3080
- 不动: 所有 bin/、所有 plugins/ 现有文件、agent.cordis.yml、fleet/registry 格式;零 npm 依赖

### P2 — dsh adapter + 双跑对拍

- 交付: adapter(调 serializeLine+resolveAddress 投 `/api/session.prompt`,steer 闸保留应用层)+ `tests/p2-a-b-test.sh`
- 验证: 沙箱 :3081 双跑——同一批信封(7 type × from/to 形式)分别走旧 `bin/session-send` 与新 adapter,比对 wire payload `content[0].text` 逐字节相等;非属主 steer 两路均拒 exit 4
- 回滚: 停用新 adapter,旧 bin 原样继续服务
- 不动: `bin/session-send`/`bin/cb-send` 一行不改,不注册 cordis.yml

### P3 — dais / orca / cb-send adapter

- 交付: dais adapter(反模式消灭)、orca adapter(Run mailbox 优先,PTY 降 L1 兜底)、cb-send v3 升格(旧版留 `cb-send.v2`)+ 对拍脚本
- 验证: 沙箱 a2a 投递后 SQLite messages 表 **body 列不含 `DSHMSG]` 前缀**、message_type 为词汇表映射值;orca adapter 投递后 Run inbox 可被 parseLine 解析;cb-send 新旧对拍逐字段一致(新版多 msgid/ver/via/ttl)
- 回滚: dais = revert http-server.js 单文件;orca = revert 新增脚本;cb-send = `mv cb-send.v2 cb-send`
- 不动: dais Rust 源码(9 MessageType 枚举不改)、Orca 运行时、fleet/registry 格式、任何 cordis.yml 注册

### P4 — 旧路径退役 + Agent Card(唯一需重启 host 的阶段,选安静窗口)

- 交付: cordis.yml 切行(删 orca-callback/message-bridge 行,增 callback-bridge v4 行);删 `plugins/orca-callback/`(pump.js 803 行)与 `plugins/message-bridge/`;`bridge_http_status` 退役;`shared/skills/maestro-bridge/AGENT_CARD.json`(SKILL.md 机读子集)
- 验证: 生产 :3080 重启后五条路径全链冒烟(外部→DSH 回调 / DSH→DSH 直发 / DSH→dais 重载 / Orca→DSH / DSH→Orca),每条信封可解析、msgid 唯一、去重窗生效;24h 无回归
- 回滚: `git revert` cordis.yml + `git checkout HEAD~1 -- plugins/…` 恢复旧目录 + 重启 host(代际回退)
- 不动: fleet/registry 格式、ledger.db schema、dais/Orca 运行时

对拍基底 = OF-005-report.md(VO-005)模式: 全 temp 域、`[ ok ]/[FAIL]` 原子断言、幂等可重跑、零副作用、并发安全。

## 5. 逐文件改造清单

### A. 外部→DSH 回调入口(host-callback-bridge)

| 文件 | 现状 | 改造 |
|---|---|---|
| index.js:98-137 | import core/ 四模块闭包组装 | import 换 `_narrow-waist`;组装传 adapter 配置;resolveBridgeDir/log/probePort/standby 不动(~170→~120 行) |
| http-intake.js:7-8,41,119-186 | TYPES 白名单 6 值硬编码;validate 四字段 | import 换源;TYPES 并入词汇表常量;validate 对 v3 字段宽容(未知键不拒);`line=JSON.stringify({type,from,to,body})` **不变**(载体) |
| file-router.js:61-106 | flush(): parseAddress→resolveHostRouting→dedup 链 | 换窄腰统一路由函数;`sink.deliver()` 不变;轮转闸门留宿主 lane |
| loopback-sink.js:46-66 | wire=session.prompt + `ORCA-CB]` 前缀 | **整文件不动**(载体+DSH RPC 非腰部管辖);resolveApiPort 可选复用 resolveFleetCode |
| core/addressing.js 全文 | 三导出(与 pump.js:127-187 同源) | 提炼进库 + `parseAddress` 增 agent:// 分支;`resolveHostRouting` 泛化为 `resolveRouting(addr,registry,{self})`;原位变 re-export;**'dead' reason 措辞逐字保留**(死信对账基准) |
| core/registry.js 全文 | 原子读写(与 pump.js:189-226 同源) | 提炼进库;consumer 条目增 version 字段(缺省 null 不影响路由);sanitize 白名单逻辑不变;原位 re-export |
| core/dedup.js 全文 | digestOf+窗口(与 pump.js:101-110 同源) | 提炼进库 + forgeMsgid + msgid 索引;原位 re-export |
| core/store.js 全文 | 目录布局+state 原子写 | 提炼进库;paths 布局/hostBridge 分节名不变;原位 re-export |

### B. DSH→DSH 直发

| 文件 | 现状 | 改造 |
|---|---|---|
| bin/session-send:21-28,44-60,83-92,127-129 | resolve()/steer_gate()/v2 信封构造 | resolve() 提炼进库(fleet-resolve DNS 角色);steer_gate 留应用层但读 fleet 改共享函数;信封构造升 v3(+via/ver/ttl,`DSHMSG]` 前缀不变);新增 `--via` 参数 |
| bin/cb-send:38-41 | payload={type,from,to,body} | 增 msgid(uuid4)与可选 `--msgid`(重发保号)/`--ver 3`;HTTP 与文件双通道协议不变 |
| plugins/message-bridge/index.js:164-175,221-240 | 内联 dedup Map;TYPES 白名单同源 | dedup 换 createDedupWindow(60s 对齐);TYPES 改共享常量;pickRecipient 内存槽表路由**留应用层**(与 registry.json 两张表分工不变);MSGBR] 前缀保留 |

### C. DSH→dais 重载(反模式消灭)

`plugins/a2a-profile-server/http-server.js` 重载分支(160-186):

- 现状: `line='DSHMSG]'+JSON.stringify(envelope)` 塞进 `--body`(信封嵌 body 的分层缺失);`--message-type` 硬编码 `'direct'`。
- **已现场核实**: `dais orchestration send-message` 为 `send-message [OPTIONS] --message-type <T> --subject <S> --body <B> <RUN_ID> <FROM> <TO>`——from/to **本就是位置参数,当前代码已在结构化传递**。
- 改造收窄为三点: ① `--message-type` 由硬编码 `'direct'` 改为词汇表 `denormalizeType(signal,'dais')`(缺省 direct);② `--body` 由信封行改为 `envelope.body` 纯正文;③ `--subject` 由固定 `'route'` 改为承载 `ref`。信封头字段(from/to/type/ref)全部升格为消息结构化参数——消灭嵌套。
- extractRef(body) 标记 legacy 保留(存量 SQLite 43 条 `DSHMSG]` body 只读不改,inbox reader 仍需解析旧格式)。
- 风险: 轻载路径(session-send)仍产 `DSHMSG]` 行而重载不再产——回合消费侧双格式兼容一个窗口期,或 P3 内同步把 session-send 升 v3 统一。

### D. Orca 双向

| 文件 | 现状 | 改造 |
|---|---|---|
| plugins/orca-callback/pump.js(803 行) | parseAddress/registry/dedup/state 四处与 core/ 同源内联 | 四处换 import 删内联(~803→~550 行);flush() 路由换窄腰统一函数;slots 分槽(incident 0003 防线)、per-consumer 游标、ORCA-CB] 前缀、bridge_arm 注册全保留 |
| bin/fleet-touch:105-118 | get_entry() 与 session-send resolve() 各自内联 | 合并提炼进库 fleet-resolve;claim/heartbeat/release/sweep/flock 零变化 |
| shared/skills/dais-orchestration/SKILL.md:50-55 | 9 MessageType 约定 | 增词汇表交叉引用与重载路径升格说明;映射必须与 C 实现 `denormalizeType` 逐条一致 |

## 6. 不变量(全阶段)

1. 载体一字不动: inbox.log 行格式 / `ORCA-CB]`、`MSGBR]`、`DSHMSG]` 前缀 / session.prompt RPC wire / SQLite messages 表 schema / PTY 字节流。
2. fleet.json / registry.json / ledger.db 格式零变化(腰部只读消费)。
3. steer 租约闸(OF-002)、slots 分槽、per-consumer 游标、轮转闸门 = 应用层策略,不升入腰部。
4. `node:*` 内建之外零依赖;v2→v3 严格 OG5 超集,任一阶段中止旧路径可独立续跑。
