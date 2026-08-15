# @maestro/callback-bridge

通用回调桥插件(P1 内核平移完成)。把 orca-callback(文件桥 v3.5)与 message-bridge(HTTP v1.0)抽象为
共享内核 + 传输 source + 回合 sink。设计文档: docs/callback-bridge-design.md;打包规范: docs/PACKAGING.md。

> 状态: P1,未注册进 agent.cordis.yml。生产两插件零接触。注册与切换见设计 §4.2 P2/P3。

## 模块

| 文件 | 职责 | 平移来源 |
|---|---|---|
| index.js | apply(ctx, config): config 归一 → 内核+source 装配 → 工具注册(bridge_arm/bridge_status) | 骨架 + pump.js:698-756 |
| core/addressing.js | parseAddress / aliasIndex / resolveRouting(纯函数) | pump.js:127-187 |
| core/registry.js | sanitizeConsumers / readRegistry / writeRegistryAtomic / registerConsumer / unregisterConsumer | pump.js:189-226,363-392 |
| core/dedup.js | digestOf / createDedupWindow(跨 source 共享去重) | pump.js:101-110,445-450 + message-bridge |
| core/store.js | createBridgeStore(paths / readState / saveState 分节合并写) | pump.js:274-360 |
| sources/file-inbox.js | createFileInboxSource: watch/游标/at-least-once/退避/死信/回声/轮转闸门 | pump.js:378-658 |
| sources/http.js | createHttpSource: 回环 HTTP + 状态码契约 + HTTP-R1 路由 | message-bridge/index.js |
| sinks/agent-turn.js | createAgentTurnSink: idle→followup / busy→inject,前缀/插件名可配 | pump.js:666-684 |

## 接口契约

- createBridgeStore({ bridgeDir }) → { paths, readState, saveState }
- createDedupWindow({ windowMs, now }) → { seen(digest), mark(digest, meta), prune, size }
- createFileInboxSource({ store, consumer, router, dedup, sink, version, echoPrefix, rotateMaxBytes, rotateMaxLines, dedupWindowMs, maxWakeFailures, retryDelayMs, now }) → { id, start, stop, status, flush, dispose, snapshot, paths }
- createHttpSource({ store, consumer, router, dedup, sink, version, basePath, portFile, bind, maxBodyBytes, types, port, now, dedupWindowMs }) → { id, start, stop, status, port }
- createAgentTurnSink(agents, { messagePrefix, pluginId }) → { bind, deliver, bound, sessionId }

## 4 个开决策点(已拍板)

1. HTTP-R1(HTTP 缺省 to): to 并入 router。缺省(缺失/空)→ 本绑定消费者投递,但在册消费者 ≥2 → 400 附 details(把 v1.0 单消费者隐式假设显式化)。显式 to → resolveRouting: wake→200/208、skip(他人)→404、dead(无法寻址)→400 附 reason(HTTP 是请求级同步契约,不写 dead.log——dead.log 是 file-inbox 传输特性)。
2. HTTP-R2(http.state 合并): 采纳建议,合并。http 计数写入主 state.json 的 consumers.<sid>.http 分节(与 file-inbox 平铺计数互不覆盖,双方非破坏性分节合并);移除独立 http.state.json;保留 http.port 端口发现文件。
3. 前缀统一: 采纳。MSGBR] 退役,统一 ORCA-CB] (config.sink.messagePrefix)。已知下游无按前缀 grep 脚本。
4. 多 host 端口: P1 保持单 http.port(不引入 pid 后缀);端口文件路径已做成 config 项(portFile),P2 双跑期若观测到覆写冲突,按需加 pid 后缀(一行改动)。

## 运行测试

    node --test plugins/callback-bridge/*.test.mjs

## 完成判据(勾完才可注册行)

- [ ] 平移映射表全部行平移,12+7 例旧测试移植全绿,config 归一/双 source 用例全绿
- [ ] 设计 §4.3 验收判据 5 条全过
- [ ] apply 契约冒烟(假 ctx+假 agent)idle→followup/忙→inject 断言
- [ ] agent.cordis.yml 注册 + host 重启(代际规则,设计 §2 事实 5)
