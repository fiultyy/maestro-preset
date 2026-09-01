# @maestro/host-callback-bridge

宿主 boot 回调桥插件(SI-003): 把 maestro 回调链路的载体从"编排 agent 会话"
搬到"host 进程",实现飞书级确定性——host 进程即触发载体。

## 尸检背景(2026-08-17 host 重启事故)

旧链路(`bridge_arm` / HTTP 口)随编排 agent 会话存亡: host 重启后 registry 清空、
HTTP 死口、inbox 积压 3 行——投递依赖"agent 记得重 arm"(记忆性触发)+ 曾用 bash
后台轮询兜底,两者都是反模式。

## 架构

```
宿主 boot(dsh --profile web --patch polyfill.patch.yml)
  └─ apply(ctx) → activate({ bridgeDir })
       ├─ standby 探活: http.port 记录端口被监听?(一次性 TCP 探测,非轮询)
       │    是(迁移窗: 旧会话内 message-bridge 仍持有链路)→ 全程待机零干扰
       │    否(下次 host boot 必然如此)→ 全量接管 ↓
       ├─ HTTP 受理面(http-intake.js): 127.0.0.1:port POST /callback
       │    受理 = 同步 append inbox.log(HTTP-R2 选项(i)),cb-send 协议零变更
       │    另有 POST /register、POST /unregister、GET /status
       ├─ 文件消费面(file-router.js): fs.watch(inbox.log) 事件驱动(禁轮询)
       │    全局游标 at-least-once;首次接管从 legacy 消费者最大游标续
       │    路由: registry.json → 单播/广播;malformed/unknown → dead.log
       │    投递失败退避 ×maxWakeFailures → dead.log;轮转 1MB/1000 行
       └─ 投递(loopback-sink.js): /api/session.prompt mode:'queue'
            text = "ORCA-CB] {inbox 行}"(信封复用 v3.5/v3.6 会话内 sink 格式)
            sessionId 是持久路由键 → 重启后的驻留会话被原生唤醒
```

## 与旧链路的关系

| 面 | 旧(会话内插件) | 新(本插件) |
|---|---|---|
| HTTP 端口持有者 | ~~编排会话(bridge_http_status arm)~~ 已于 P4 退役 | host 进程(boot 即绑) |
| registry 写入 | bridge_arm(会话内工具) | POST /register(或编排者手写 registry.json) |
| 文件消费 | 每会话一泵(游标分立) | host 单路由(全局游标) |
| 会话角色 | 拥有链路+消费回合 | **只消费回合** |
| host 重启后 | 死口+积压,靠记忆重 arm | 零手动动作,自动接管 |

迁移窗护驻(standby): 本插件被 HMR 热载入**运行中** host 时,旧面仍在监听
http.port 记录端口——插件待机(不绑端口不盯文件,零干扰在飞编排);下次 host
boot 旧面随进程消亡、端口必然空闲,自动全量接管。检测是一次性事件探活。

## 部署(路径分治)

- **源码(唯一源头)**: maestro-preset 仓 `plugins/host-callback-bridge/`
- **运行面(自包含副本)**: `~/.dsh/plugins/host-callback-bridge/`(`bin/dev-sync.sh`
  正向同步时自动 rsync) + `~/.dsh/plugins/polyfill.patch.yml` 插入行
- **红线**: DSH 本体零改动;宿主 boot 经 `run-web.sh --patch` 已有机制装载。

## 文件面单一权威(IDX-5)

2026-09 现场实证(事故①): dsh v4 起宿主原生 callback-bridge 为 armed 会话各挂一个
文件 watcher(`.cursor.session-<sid>` 自带游标),与本插件的 file-router
(`.cursor.host-bridge`)对同一 `inbox.log` 并行消费——同一行双投给目标会话、且
polyfill 侧把原生道已投的行误记成 ghost dead-letter。裁决:一行同时段只允许一个
消费者。

**两个候选方案**(判据: 每行恰好一次):

1. *polyfill file-router 唯一游标权威 + 宿主 arm 侧仅槽登记不消费* —— 需要 dsh
   本体 arm 语义改动(armed 不起 watcher)。本票红线禁改 DSH 本体、禁重启装点,
   该方案落地即超纲。
2. *polyfill 让渡文件面(ceded),HTTP 受理面照旧,消费交宿主原生 per-session
   watcher* —— 纯配置开关(env `MAESTRO_BRIDGE_FILE_DELIVERY=ceded`,或 activate
   option `fileDelivery:'ceded'`),零 DSH 改动,重启时生效。

**采纳方案 2**。代价与缓解:

- 覆盖损失: 会话不 arm 就没人消费它的 inbox 行(方案 1 无此洞)。缓解 = IDX-5
  Task D「编排线首动作 arm 自己」纪律 + 派发前言提示;
- 积压不封顶: ceded 模式下从未 arm 的会话行永久滞留 inbox.log(体积增长无界)。
  观测靠 `wc -l inbox.log`;装点轮转策略留后续票;
- 缺省 'sole' 不变: 未显式 opt-in 的环境全部既有门零回归,生产切换 = 部署门里
  加一个 env 值(仍需用户门重启才生效)。

## 测试

```bash
node plugins/host-callback-bridge/selftest.mjs   # 35 项自测(node --test 风格)
```

覆盖 SI-003 验证目标 ①–⑤(T01–T12 场景,见 selftest.mjs 头注释映射表)。

## 观测

- `bridge/http.port` — 受理面端口(cb-send 读它,零变更)
- `bridge/host-lane.log` — 插件生命周期日志(active/standby/activation failed)
- `bridge/state.json` 顶层 `hostBridge` 分节 — 计数/游标(bind/file-router 分立)
- `GET /status` — 端口/计数/在册消费者一览
```
