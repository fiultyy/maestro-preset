# 0008 — nw-T2: P1 窄腰共享库 `plugins/_narrow-waist/`(五文件+四测试全绿)

> 状态: DISPATCHED
> 依据: 评审报告 R-B02/R-B03/R-B04/R-B14/R-B15/R-B16/R-B01/R-S01/R-S04/R-S05/R-S06/R-S24/R-S28/R-S31/R-S33/R-S18;spec 节 = `docs/reports/.nw-spec-raw-P1.md`(P1.0-P1.7,本票的唯一权威规格,含逐 API 签名与验收断言);18 Signal 终表以 fix-spec §G 节为准。

## 目标

交付窄腰共享库 `plugins/_narrow-waist/`: dedup/addressing/vocabulary/envelope/index 五文件 + 四个 node:test 单测,全部断言(spec P1.1-P1.6 逐条)全绿、temp 域零生产外溢。本票**纯新建**,不改任何现存文件——core/*/pump.js/message-bridge 的 re-export 换接归后续 adapter 票(T3/T5/T6)。

## 交付物(文件级清单)

1. `plugins/_narrow-waist/package.json` — `{"name":"@maestro/narrow-waist","type":"module","private":true}`,零依赖(P1.0)。
2. `plugins/_narrow-waist/dedup.js` — forgeMsgid/digestOf/dedupKeys/createDedupWindow(seen/mark/prune/size,meta 进签名)/seenAny/markAll,材料分流 `from\0(msgid??body)` + 双记(P1.1.1),mark 时机不变量 JSDoc 契约 + windowMs 默认 60_000(P1.1.2)。
3. `plugins/_narrow-waist/addressing.js` — ①resolveRouting(底层,泵视角原签名原参数序)②resolveRoutingUnified(门面双视角,sids 必填)③resolveHostRouting(兼容别名);resolveAddress 发送侧联合解析+撞名显式死信(判定序 1-3 abcdef);findFleetEntry(exact/prefix 双模式)/resolveFleetSessionId;registry 段五函数(sanitize 白名单三键不动、顶层 version 沿用、写链=唯一 tmp+进程内串行化)(P1.2.1-P1.2.4)。
4. `plugins/_narrow-waist/vocabulary.js` — SIGNALS 18 值(含 report,以 §G 终表为准)、DAIS_TYPE_MAP(显式 `direct:null`)/DSH_TYPE_MAP/ORCA_TYPE_MAP、normalizeType(未知透传不抛不猜)/denormalizeType(dais 面永不产出 'direct')、DSH_CALLBACK_TYPES/DSH_INTAKE_TYPES 两冻结白名单常量(P1.3)。
5. `plugins/_narrow-waist/envelope.js` — LINE_PREFIX/ENVELOPE_VERSION=3/V2_TYPES 七值、createEnvelope(键序=v2 原序+新三键尾部)/validateEnvelope(不查闭集、未知键不拒)/serializeLine/parseLine(legacy4 原样透传+ref '[ref:' 提取)/detectVersion 四态/upgradeV2toV3/downgradeV3toV2(JSDoc 标注非生产 API)(P1.4)。
6. `plugins/_narrow-waist/index.js` — 桶导出,零逻辑零副作用零常量副本(SIGNALS 只在 vocabulary.js 定义)(P1.5)。
7. 四个 `plugins/_narrow-waist/*.test.mjs`(envelope≈13/addressing≈18/dedup≈13/vocabulary≈10 用例,清单=P1.6 表逐条;oracle 比对=测试内只读 import 生产 core/*.js、pump.js、session-send 相关面)(P1.6)。

## 验收断言(可执行)

1. `T=$(mktemp -d) && printf '{"fleet":{}}' > "$T/fleet.json" && MAESTRO_FLEET="$T/fleet.json" MAESTRO_STATE="$T/state" node --test plugins/_narrow-waist/` → exit 0 全绿;前后 `~/.dsh/maestro/bridge`、`~/.dsh/maestro/state` mtime 不变;收尾 `rm -rf "$T"`。
2. P1.1-P1.4 各节"验收断言"编号逐条有对应用例(关键: dedup 四向重放全命中、无 msgid 同 from 不同 body 零误判重、digestOf 对 core 逐字节、撞名 collision 死信、并发 20 写不丢+唯一 tmp、白名单剥多余键、dead reason 四条双 oracle 逐字节、R-S28 参数序回归、detectVersion 四态、两白名单常量 oracle+freeze、18 Signal 与 §G 终表逐条一致)。
3. `node -e "import('./plugins/_narrow-waist/index.js').then(m=>console.log(Object.keys(m).sort().join(',')))"` 输出 = P1.1-P1.4 枚举的全部导出名集合,且 import 无文件写副作用。
4. `git status --porcelain` 恰上列新建文件(目录内 10 个);`git diff HEAD` 对现存文件零改动。
5. 连续重跑验收 1 两次均全绿(幂等)。

## 依赖与顺序

- **软依赖 T1**: 18 Signal 终表以 fix-spec §G 节(`docs/narrow-waist-fix-spec.md`)为准——该文件已在仓,T2 可直接用;T1 若修订 §G 表述,语义以含 `report` 的 18 值为准不回退。
- T3/T5(T4 除外)依赖本票导出面;本票不依赖任何实施票,可与 T1 并行。
- 内部顺序: envelope+dedup(无相互依赖)→ vocabulary(需 §G 表)→ addressing(最大)→ index 桶导出 → 四测试。

## 回报契约

开工第一动作: ~/.dsh/maestro/bin/cb-send ack impl@omp nw-planner@orca-main nw-T2 'turn started';完成后(≤300字摘要): cb-send done impl@omp nw-planner@orca-main nw-T2 '<结论;产物路径;剩余>';被阻塞: cb-send ask。done 只发一次。

## 工作目录注记

仓 = /home/yy/tools/maestro-preset-iter(master 的 linked worktree);产物一律写该 worktree;不碰 /home/yy/tools/maestro-preset 主检出,不动生产 ~/.dsh(测试只读 oracle import 例外)。

## 工作说明

- **兼容基准逐字平移**: digestOf/窗口四键 ← `plugins/host-callback-bridge/core/dedup.js`;resolveRouting 底层 ← `plugins/orca-callback/pump.js`;resolveHostRouting/dead reason 四条 ← `plugins/host-callback-bridge/core/addressing.js`;registry 五函数 ← `core/registry.js`(唯一 tmp ← `core/store.js` saveState 模式,写链 ← pump.js registryOpChain 语义);V2_TYPES/LINE_PREFIX ← `bin/session-send`;白名单两常量 ← message-bridge index.js TYPES、http-intake.js TYPES。行号可漂,一律函数名锚定。
- **明确不做**(归后续票): core/registry.js、core/dedup.js、core/addressing.js 原位 re-export;pump.js/message-bridge/http-intake 换 import;file-router sids 防御与 flush 静默 catch 改造(P1.2.1 配套落点,非 T2);steer 闸/fleet-touch 改调 findFleetEntry;flock。
- **禁止**: 改任何现存文件;引入 npm 依赖(`node:*` 之外);测试触碰 live `~/.dsh`(只读 import oracle 除外);跑 dev-sync.sh;注册/修改 agent.cordis.yml 或任何 patch yml。
