# callback-bridge — orca-callback 的抽象与 DSH 插件打包设计

> 版本: draft-1 · 2026-08-15 · 作者会话: aa0a(接 DSHMSG 无编号直请)
> 对象: 把 `plugins/orca-callback`(文件桥泵 v3.5)与 `plugins/message-bridge`(HTTP 直发 v1.0)抽象为一个通用回调桥插件 **@maestro/callback-bridge**,并确定其 DSH 插件打包形态。
> 证据约定: DSH 仓库引用 = `packages/...` 相对 `/home/yy/tools/deepseek-harness`(只读,rev 47f9438); preset 引用 = `~/.dsh/.agent-presets/maestro/` 下相对路径。

---

## 1. 现状盘点(抽象的输入)

### 1.1 消费侧(本设计的合并对象)

| 件 | 位置 | 职责 | 关键实现锚点 |
|---|---|---|---|
| 文件桥泵 v3.5 | `plugins/orca-callback/pump.js`(759 行) | fs.watch 桥 inbox,游标顺序消费 → wake | `createPump` 纯核心 :245;flush 主循环 :516;apply :661 |
| HTTP 直发 v1.0 | `plugins/message-bridge/index.js` | 回环微服务 POST /callback → wake | `createBridgeService(config)` 可注入核心(见 v3.4 报告 §2) |

两者共享的语义(重复实现,抽象的主要收益点):
- **Sink 同构**: `agents.requireInitiator()` → idle→`followup` / 忙→`inject`,消息加醒目前缀(`ORCA-CB] ` / `MSGBR] `)+ `source:{kind:'plugin',…,form:'notice'}`(pump.js:666-684);
- **60s (from,body) 去重窗口**(pump.js:71 / message-bridge `DEDUP_WINDOW_MS`);
- **原子 state 写**(tmp+rename)与版本指纹回执;
- **工具注册形态**: `ctx.tools.register` + `output.render`(pump.js:698-716)。

仅文件桥有的语义(HTTP 侧无对应): per-consumer 游标 at-least-once、wake 失败 2s 退避×3→死信、`DSH-RE]` 回声分离、malformed→dead.log、1MB/1000 行轮转(全消费者到尾闸门)、多消费者 registry + 寻址(`<alias>@<sid>`/裸 sid/裸别名/`*` 广播)+ undertaker 唯一死信(pump.js:137-187, 463-476)。

仅 HTTP 侧有的语义: 请求级同步校验(400+details)、208 幂等重放应答、403/404/405/413 路由守卫、端口发现文件 `bridge/http.port`。**为什么是独立微服务而非 /api 拦截**: headless bundle 无 connection 服务可注入、ClientRequest RPC 信封与裸 JSON 契约不匹配(message-bridge/index.js:12-21 头注释)——该结论继续有效。

### 1.2 生产侧与旁路(不在抽象范围,边界要写清)

- `skills/orca-bridge/`(SKILL.md + reply.sh + watch.sh): 桥 pane 的建立(cat >> inbox.log)、回声回执通道 —— **skill 平面,保持 Orca 专属**;
- `maestro/bin/session-send`: fleet 码 → 回环 `/api/session.prompt` 直发 RPC,不经桥 —— 独立传输,保持现状;
- `fleet.json`/`ledger.db`: 编排域数据,无关。

### 1.3 注册方式(现状)

`agent.cordis.yml` 两行相对路径插件(注释块见该文件 "orca callback pump" / "message-bridge 直发回调端点" 节):
```yaml
- id: orca-callback
  name: './plugins/orca-callback/pump.js'
- id: message-bridge
  name: './plugins/message-bridge/index.js'
```
插件模块契约: `export const version` + `export const inject = ['agents','tools']` + `export function apply(ctx, config?)`——cordis 行的 `config:` 字段即第二参(佐证: harness fixture `packages/preset/agent-presets/tests/fixtures/plugins/contribute.js` 的 `apply(ctx, config)`)。现状两个插件都**未吃 config**,靠环境变量(`MAESTRO_BRIDGE`/`MAESTRO_BRIDGE_ALIAS`)——这是打包设计要修正的点。

---

## 2. DSH 插件打包面(权威事实,决定"能怎么打包")

来自 harness 源码 `packages/preset/agent-presets/`(README + src/mount.ts + src/discovery.ts):

1. **preset 是唯一第三方插件平面**。preset = 目录 + `agent.cordis.yml`;roster 每进程挂载一次(standing scope),会话按 scope 父链加入;插件行注册的工具/提示段落落在 preset 层,覆盖所有加入的 agent。
2. **行名解析三通道**(mount.ts:81-92 `PresetTree.import`):
   - `'./x.js'` 相对 → 相对 **preset 目录**(组合 baseUrl)——插件随 preset 目录走;
   - 裸包名 → 从**宿主组合基**(harness 安装树)解析,用户目录的 node_modules 上溯**不可达** harness 依赖 → **第三方 npm 裸名不可用**;
   - 绝对路径 → file URL,任意磁盘位置可用。
3. **插件行不得向 root realm 发布服务**;要么 `isolate` realm 隔离,要么属宿主平面。callback-bridge 只消费 `agents`/`tools`、不发布服务 → 无需 realm(与现状一致)。
4. **preset 是输入不是持久化目标**(mount.ts:110-111 `write()` no-op);**authoring 只读复制**(`copy()` 整目录拷贝,symlink 解引用、自包含)。
5. **代际(generation)以 agent.cordis.yml 的 stamp(mtime+size)为键**: 改插件 .js 不动 yml → 新会话仍用旧代际的已导入模块;改 yml(哪怕注释)→ 新会话开新代际重导入;**运行中会话永远保持加入时的代际**。同进程 ESM 缓存之下,换插件代码的确定性途径是**重启 host 进程**(README "…or the process restarts")。
6. **发现根**: shipped/配置根 + `<dshHome>/.agent-presets`(discovery.ts:41 `USER_PRESET_DIR`);`~/.dsh/.agent-presets` 即用户根,maestro preset 位于此。
7. **信任模型**: user preset 与 shell 访问同权(README "Trust")——插件代码本身无额外沙箱,这本来就是 maestro 的运行前提。

### 2.1 打包方案决策矩阵

| 方案 | 形态 | 现在可行 | 代价/风险 | 判定 |
|---|---|---|---|---|
| **A. preset 本地插件(相对路径 + 行 config)** | `plugins/callback-bridge/` + 一行 `name: './plugins/callback-bridge/index.js'` + `config:` | ✅(现行机制) | 升级 = 改 preset 目录;复制 preset 即复制插件(自包含) | **推荐,本文 §4 展开** |
| B. 绝对路径共享 | `name: /home/yy/.dsh/.../callback-bridge/index.js` | ✅(mount.ts:82) | 跨机不可移植;`copy()` 复制的是引用不是代码;破坏 preset 自包含语义 | 仅多 preset 临时共享,不作主形态 |
| C. npm 裸名 | `name: '@maestro/callback-bridge'` | ❌ | 裸名从宿主组合基解析;需把包装进 harness 安装树(侵入、升级即丢) | 排除 |
| D. 上游仓库包 | 进 `packages/*` + base 组合 | ❌(仓库红线只读) | 上游评审/发版成本 | **长期归宿**:语义稳定后按 DSH 插件规范上游化,届时裸名解析天然成立 |
| E. 动态插件平面(cordis-dynamic) | 运行时挂载 patch | 技术上可 | 为运行时组装设计,常驻回调泵用它属过度设计 | 排除 |

**结论: A 落地,D 记录为上游化路径。** 理由: A 是现行机制零新依赖;盘面目录(bridgeDir)与 skill 契约不动;上游化前需要真实多 preset 需求来验证接口,现在只有 maestro 一个消费者。

---

## 3. 抽象设计

### 3.1 分层与模块边界

核心判断: **共享的是"内核语义",不是"一条投递管线"**。文件桥的 at-least-once 游标/轮转/死信是传输特性(HTTP 是请求同步应答,调用方自负责重试),不该塞进通用引擎;HTTP 的状态码契约也是传输特性。抽象为"共享内核 + 传输策略":

```
        ┌─ Sources(传输适配)───────────────────────────────┐
        │ file-inbox: fs.watch + cursor + rotation + dead   │
        │ http:       loopback POST /callback + 状态码       │
        │ (future: unix-socket / websocket / exec)          │
        └───────────────┬───────────────────────────────────┘
                        │ raw record(line / request body)
        ┌───────────────▼───────────────┐
        │ Codec: 前缀分派(DSH-RE]→echo)  │
        │ JSON 解析 → Envelope 校验       │
        └───────────────┬───────────────┘
                        │ Envelope {type,from,to,body}
        ┌───────────────▼───────────────────────────────────┐
        │ 共享内核(core/):                                   │
        │  addressing: parseAddress/resolveRouting(纯函数)    │
        │  registry:  consumers 原子读改写                    │
        │  dedup:     (from,body) 窗口                        │
        │  store:     bridgeDir 布局 + state.json 原子写       │
        │  policy:    wake 失败策略钩子(文件=退避×3死信,        │
        │             http=抛错→500 由调用方重试)              │
        └───────────────┬───────────────────────────────────┘
                        │ wake(envelope, info)
        ┌───────────────▼───────────────┐
        │ Sink: agent-turn              │
        │ idle→followup / busy→inject    │
        │ + 前缀 + source 元数据          │
        └───────────────────────────────┘
```

### 3.2 目录与契约(scaffold 已落盘,见 §5)

```
plugins/callback-bridge/
  package.json            # @maestro/callback-bridge, type:module
  index.js                # apply(ctx, config):配置归一 → 内核+source 装配 → 工具注册
  core/
    addressing.js         # parseAddress / resolveRouting / aliasIndex(自 pump.js:127-187 平移,纯函数)
    registry.js           # registry.json 原子读改写(pump.js:189-226)
    dedup.js              # (from,body) sha256 窗口(pump.js:101-110, 445-450)
    store.js              # bridgeDir 路径布局 + state.json per-consumer 分节(pump.js:274-360)
  sources/
    file-inbox.js         # createFileInboxSource: watch+游标+轮转+死信+回声(pump.js:378-658 平移)
    http.js               # createHttpSource: 状态码契约(message-bridge 平移)
  sinks/
    agent-turn.js         # createAgentTurnSink(pump.js:666-684 一般化:前缀/插件名可配)
```

**模块接口**(TypeScript 记法,实现为 JSDoc 注释的 ESM):
```ts
interface Source { id: string; start(): Promise<void>; stop(): Promise<void>; status(): object }
interface Codec    { decode(raw: string): { kind:'message'; envelope:Envelope }
                                     | { kind:'echo'; raw:string }
                                     | { kind:'malformed'; reason:string; raw:string } }
interface Envelope { type:string; from:string; to?:string; body:string }
interface Router   { resolve(to:string|undefined, self:ConsumerRef, registry:Registry):
                       { action:'wake'|'skip'|'dead'; broadcast?:boolean; reason?:string } }
interface Sink     { deliver(line:string, info:WakeInfo): void }   // 抛错 = 投递失败
interface ConsumerRef { sessionId:string; alias?:string }
```

### 3.3 行 config schema(agent.cordis.yml → apply(ctx, config))

```yaml
- id: callback-bridge
  name: './plugins/callback-bridge/index.js'
  config:
    bridgeDir: '~/.dsh/maestro/bridge'      # 优先级: 环境变量 MAESTRO_BRIDGE > 此值 > 内置默认
    aliasEnv: 'MAESTRO_BRIDGE_ALIAS'        # bridge_arm 缺省别名的环境变量名
    sink:
      messagePrefix: 'ORCA-CB]'             # 醒目行前缀(两通道统一,MSGBR] 退役)
      pluginId: '@maestro/callback-bridge'  # source.plugin 元数据
    engine:
      dedupWindowMs: 60000                  # 两通道共享窗口
      maxWakeFailures: 3                    # 仅 file-inbox 路径使用
      retryDelayMs: 2000
    sources:
      - kind: 'file-inbox'
        file: 'inbox.log'
        echoPrefix: 'DSH-RE]'
        rotateMaxBytes: 1048576
        rotateMaxLines: 1000
      - kind: 'http'
        basePath: '/callback'
        portFile: 'http.port'
        bind: '127.0.0.1'
        maxBodyBytes: 262144
```
归一规则: 未知 source kind → 行加载失败(fail-loud,符合 preset "row 未达 usable 即拒");未知顶层键忽略(前向兼容)。**config 缺省 = 现两插件行为逐字段等价**(迁移零行为差)。

### 3.4 工具面(对模型契约)

- `bridge_arm { alias? }` — 签名与 v3.5 完全一致(向后兼容);回执升级为 v4 指纹 + 生效 config 摘要 + 各 source 状态;
- `bridge_status` — 新增: registry 在册消费者 / 各 source 健康(HTTP 端口、file 游标)/ 计数器。迁移期保留 `bridge_http_status` 为 deprecated 别名,两个稳定周期后移除。

### 3.5 明确不抽象的(边界)

- 生产侧 skill(orca-bridge pane/reply.sh)——Orca 专属流程,不是插件;
- session-send 直发 RPC——已最小;
- `to` 的语义: 文件桥 v3.5 的多消费者寻址语义**整体保留**;HTTP 通道并入同一 router(见 §6 决策点 HTTP-R1)。

---

## 4. 打包与迁移(方案 A 落地)

### 4.1 磁盘与契约兼容承诺

`bridgeDir` 布局**逐文件不变**: `inbox.log[.1]`、`.cursor.<sessionId>`、`registry.json`、`state.json`(consumers 分节)、`dead.log`、`echo.log`、`http.port`、`http.state.json`。v3.5 → v4 为 drop-in: 游标/注册表/计数延续,无迁移步骤。生产侧(skill 的 ack 签名 `<alias>@<sessionId>`、DSHMSG/ORCA-CB 行格式)零改动。

### 4.2 分阶段

1. **P1 骨架+内核平移**: 建 `plugins/callback-bridge/`,addressing/registry/dedup/store 自 pump.js 平移(纯函数,行号对照表见 scaffold README);测试 = 移植 pump.test.mjs 12 例 + message-bridge 7 例 + 新增 config 归一/双 source 用例。**此阶段不注册行,生产两插件照跑。**
2. **P2 双跑验证**: agent.cordis.yml 增 `callback-bridge` 行(file-inbox source 先行,http source 关闭),与旧泵**分消费者**实测: 同 bridgeDir 下新旧并册,验证 registry/state 并发写与轮转闸门互认。
3. **P3 切换**: 移除旧行,开启 http source,注册 `bridge_status`。按 §2.5 代际规则,**切换需重启 host 进程**(同进程 ESM 缓存 + 运行中会话保持旧代际);选安静窗口,重启后旧会话代际自然消亡。
4. **P4 清理**: 删 `plugins/orca-callback`、`plugins/message-bridge` 目录与 `bridge_http_status` 别名;skills/orca-bridge SKILL.md 回执措辞更新为 bridge_arm v4。

### 4.3 测试与验收

- 内核纯函数单测(注入 bridgeDir/now/wake——沿用 v3.4 报告 §4.2 的模式);
- HTTP source 真实 listen+fetch 三态(200/208/400)+ 守卫(403/404/405/413/503/500);
- apply 契约冒烟: 假 ctx(agents.requireInitiator/tools.register/effect)+ 假 agent,断言 idle→followup/忙→inject、前缀、source 元数据、config 归一;
- 兼容金样: v3.5 产生的 registry/state 快照 → v4 读取续写 → 快照 diff 仅增量。
- 验收判据(可勾选):
  - [ ] config 缺省时,新旧插件对同一 inbox 序列的 wake 序列逐条相同(脚本对拍);
  - [ ] 双 source 并存,HTTP 投递与文件投递共享 dedup(同 (from,body) 跨通道 60s 内只 wake 一次);
  - [ ] v3.5 registry.json/state.json 直接被 v4 续写,无迁移脚本;
  - [ ] bridge_arm 回执含 v4 指纹与 config 摘要;bridge_status 输出两 source 健康;
  - [ ] 移除旧行并重启后,生产桥回声/死信/轮转行为与 v3.5 逐项一致(12 例单测全绿即证)。

### 4.4 上游化路径(方案 D,记录)

语义稳定 + 出现第二个 preset 消费者后: 按 harness 插件包规范(`packages/*` + tsconfig + tests)重写为 `@deepseek-ai/dsh-callback-bridge` 进宿主组合,届时行名裸包名解析成立(mount.ts:87-91),preset 行退为纯 config。本设计的接口(§3.2)即按该终点形状裁剪: 内核不依赖 preset 目录、不依赖 maestro 约定(仅 bridgeDir 布局是环境契约)。

---

## 5. 本次落盘物

| 文件 | 性质 |
|---|---|
| `~/.dsh/.agent-presets/maestro/docs/callback-bridge-design.md` | 本设计文档 |
| `~/.dsh/maestro/dev/callback-bridge/package.json` | scaffold(0.1.0-scaffold;已移出 preset 分发树,避免半成品随包发布) |
| `~/.dsh/maestro/dev/callback-bridge/index.js` | apply/config 归一/工具注册骨架,内核调用点留 TODO(port) |
| `.../core/*.js, sources/*.js, sinks/*.js` | 接口级骨架 + 平移注释(pump.js 行号对照) |
| `.../README.md` | 平移映射表 + 验收清单 |

**未动**: 生产两插件、agent.cordis.yml、skills/orca-bridge、bridge 目录——P1 前提是零生产接触。

## 6. 开决策点(交实现者/评审)

- **HTTP-R1**: HTTP 通道 `to` 并入 router 后,缺省 `to`(现状"仅记录")如何处置? 建议: 缺省 → 唯一在册消费者即投递,多在册则 400 附 details(把 v1.0 的单消费者隐式假设显式化);需拍板。
- **HTTP-R2**: `http.state.json` 是否并入主 `state.json` consumers 分节(建议并,减少一个观测文件;保留 port 文件)。
- **前缀统一**: `MSGBR] ` 退役统一为 `ORCA-CB] ` 会改变会话内可见行前缀——若下游有按前缀 grep 的脚本需先扫一遍(已知: 无)。
- **多 host 实例**: v3.5 事故后 registry 已按 sessionId 精确路由;HTTP 端口文件单实例假设仍在(第二实例随机端口会覆写 http.port)——P2 双跑期顺带验证,必要时 port 文件带 pid 后缀。

---

## 7. 现场坑补充(一): headless 借壳纪律(field-pitfalls 沉淀)

回调桥的投递端(cb-send / terminal send)有两类执行环境: 持有 `ORCA_TERMINAL_HANDLE`
的活终端 agent,与 headless 进程(cron/脚本/无 Orca 终端的会话)。headless 要驱动
终端时**必须有活跃终端的 sender**——`terminal send` 只认活 handle。由此立三条纪律
(与 USAGE §11 同源,此处记设计侧依据):

1. **借壳必须注明"票不投壳"**: headless 借某终端壳发消息/回调时,票据归属(from/ref
   收口记账)一律写 headless 自己的 agent ID,**不落在被借的壳上**。桥按 `from` 路由
   与去重(§3.1 envelope),票投到壳会把账记到壳名下——账本错账、fleet 码表误登记、
   (from,body) 去重窗口也被壳的旧消息占位。
2. **最佳实践: 专用壳**: 常驻 headless 编排单开一个专用终端做 sender(定位同桥
   pane: 只是投递通道),不借在役 worker/交互终端——不污染对方输入流、不抢对方
   回合,sender 生命周期也归自己管,不会被回收后回调断流。
3. **借壳是应急通道**: 用完即还,壳内不留长任务;壳 handle 失效(Orca 重启)按
   orca-bridge SKILL 建桥步骤重建专用壳。

设计含义(记入未来 @maestro/callback-bridge 的文档面): Sink 的 `source` 元数据与
envelope `from` 是**两回事**——借壳投递时 source 指向壳通道,from 必须仍是真实
headless agent;两字段不得合并简化。

---

## 8. 现场坑补充(二): most-recent-armer 兜底的误投风险与 alias 稳定性(field-pitfalls 沉淀)

**现场**: DSH host 重启后,编排者 sessionId 漂移(9a173a3d→1737c79e)。重启前派发的
回调契约里嵌的是旧签名 `orch1@9a173a3d…`——重启后 registry 中没有任何消费者占这个
地址,它成了**幽灵地址**。对端 cb-send 带显式 `to` 投递,桥找不到匹配槽,走了
**most-recent-armer 兜底**(投给最近一次 arm 的消费者);当时同机另有一个编排会话在
册,消息实投 session-313e6f7f——**跨编排串话**,真正的编排者永远等不到 ACK/DONE。

### 8.1 显式 to 失配时兜底策略的安全边界

most-recent-armer 兜底在单编排常态下是善意设计(冷 agent 拿旧地址也能投到人),但
它的安全边界止于"**缺省 to** 的善意补全"——**显式 `to` 找不到槽时,兜底必须反转**:

- **显式 to + 无匹配槽** → 拒收进死信(dead.log / 400 附 details "ghost address"),
  让发送端拿到明确失败去刷新签名,而不是桥替发送端**猜一个收件人**。误投比丢票更
  危险: 丢票可重试,误投会造成跨编排串话+账本错账,且双方都难察觉;
- **缺省 to**(调用方没写)才允许"唯一在册消费者即投递,多在册则拒"——与 §6 HTTP-R1
  的显式化方向同源;
- 由此立决策点 **ADDR-R1**: 收紧兜底,显式 to 失配改判死信/400,仅缺省 to 保留
  唯一消费者规则。

### 8.2 alias 稳定性: 会话内稳定,跨重启不保证

`<alias>@<sessionId>` 把会话生命周期钉进了回调契约,而 host 重启恰恰换 sessionId。
alias 的正确模型是:**会话内稳定,跨重启不保证**——

- alias(如 orch1)在一个会话生命周期内不变,可作会话内简写寻址;
- host 重启后新会话可复用同名 alias,且新旧两个编排会话可能**并存**(旧会话残留
  registry、新会话已 re-arm)——此时同 alias 双槽,alias 单独无法寻址,必须带
  sessionId;
- 决策点 **alias 代际(epoch)**: registry 为 alias 维护换代计数,同 alias 重 arm 视为
  换代,旧 `<alias>@<旧sid>` 立即标 stale(undertaker 清理),bridge_arm 回执与 probe
  应答带 epoch——对端可检测"我拿的地址是上一代"并主动请求刷新。

**运行纪律(已落 USAGE §3.1)**: host 重启后编排者必须重新 `bridge_arm` +
`bridge_http_status`,并向所有在飞 worker 广播新签名——协议层修复(ADDR-R1/epoch)
落地前,这是唯一可靠防线。与 §6 HTTP-R1/多 host 实例条目同源(地址寻址在多消费者
场景下的退化),P2 双跑期一并验证。
