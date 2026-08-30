# maestro 通信架构:各 Bridge 与 Maestro/Fleet 的关系

> 2026-08-25 由四路源码调研汇编。源码:/home/yy/tools/maestro-preset(§行号均指此仓);
> 运行装点:~/.dsh;隔离沙箱:/home/yy/tools/dsh-comm-sandbox(:3081)。
> 2026-08-30 增补:fleet-adopt/fleet-tree(parent 结构面)+ watchdog/orch-notify 退役勘正。

## 0. 全景图

```mermaid
flowchart TB
    subgraph 生产DSH宿主["DSH 宿主 :3080 (systemd dsh-web)"]
        HOSTLAN["host-callback-bridge<br/>(宿主 boot 期,polyfill lane)"]
        LOOPRPC["/api/session.prompt<br/>(loopback RPC)"]
        subgraph 会话["编排/worker 会话们 (maestro preset)"]
            ORCA["orca-callback<br/>(会话内,bridge_arm)"]
            MSG["callback-bridge v4<br/>(会话内兼容层,bridge_arm)"]
        end
    end

    subgraph 桥面["bridge/ 目录 (MAESTRO_BRIDGE)"]
        INBOX["inbox.log (文件 spool)"]
        REG["registry.json (消费者路由表)"]
        HTTP["HTTP /callback :46855"]
    end

    subgraph 客户端["bin/ 客户端 (任意进程)"]
        CBSEND["cb-send"]
        SS["session-send"]
        SPAWN["session-spawn"]
        TOUCH["fleet-touch"]
        ADOPT["fleet-adopt"]
        TREE["fleet-tree"]
    end

    subgraph 登记["fleet.json (MAESTRO_FLEET)"]
        FLEET["fleet 表: shortcode→session/terminal<br/>+ parent 结构字段(编排组树)"]
    end

    CBSEND -->|HTTP 优先| HTTP
    CBSEND -->|文件兜底| INBOX
    HTTP -->|同步 append| INBOX
    INBOX -->|fs.watch 路由| HOSTLAN
    HOSTLAN -->|ORCA-CB] 信封| LOOPRPC
    LOOPRPC --> 会话
    SS -->|短码解析| FLEET
    SS -->|DSHMSG] v2 信封| LOOPRPC
    SPAWN -->|session.create + 登记| FLEET
    TOUCH -->|flock 心跳/租约/sweep| FLEET
    ADOPT -->|flock 写 parent/flow/lane 挂树| FLEET
    TREE -->|只读森林渲染| FLEET
    ORCA -.standby 让位.-> HOSTLAN
    MSG -.standby 让位.-> HOSTLAN
```

**三平面分工**:
- **宿主面**(host-callback-bridge): 回调链路存活于宿主进程,host 重启不丢(SI-003 动机)
- **会话面**(orca-callback / message-bridge): 链路存活于编排会话,靠 agent 原生 followup/inject
- **客户端面**(bin/*): 无状态 CLI,经 fleet.json 寻址、经桥或 loopback RPC 投递

## 1. 四个 Bridge 逐一拆解

### 1.1 host-callback-bridge(现任主力,宿主面)

| 维度 | 事实 |
|---|---|
| 挂载 | `polyfill.patch.yml` insert,run-web.sh `--patch` 挂载,boot 期加载(index.js:1-22 注释链) |
| 双入口 | ① HTTP `POST /callback`(http-intake.js:187-287,校验后同步 append inbox.log);② fs.watch inbox.log(file-router.js:388-395) |
| 端口决策 | 复用 `bridge/http.port` 记录端口,无则 OS 随机;写回 http.port(http-intake.js:407-460);生产 46855/沙箱 41751 |
| 寻址 | registry.json `{consumers:{sessionId:{alias,pid,armedAt}}}`(core/registry.js:47-73) + addressing.js `to` 解析(`*`广播/`alias@sessionId`/裸名,Bare→sessionId 优先→alias 索引)(core/addressing.js:42-73) |
| 投递出口 | loopback-sink:`POST /api/session.prompt` mode:queue,信封 `ORCA-CB] {json}`(loopback-sink.js:6-36);apiPort 三级解析 config>DSH_PORT>fleet.json.port>3080 |
| 生命周期 | 宿主 boot 即绑定,host 重启自动接管;**standby 迁移窗**:http.port 被占(旧会话桥仍持链,HMR 场景)→本进程 inert,下次 boot 接管(index.js:90-98) |
| 去重 | SHA256(from\0body) 60s 滑窗,HTTP+文件两通道共享单实例(core/dedup.js:10-14) |
| 死信/轮转 | malformed/unknown/failed×3→dead.log;`DSH-RE]` 前缀→echo.log;1MB/1000 行轮转(file-router.js:222-250,379-396) |

### 1.2 orca-callback(前任文件桥,会话内,v3.6)

| 维度 | 事实 |
|---|---|
| 挂载 | `agent.cordis.yml:361-362`(maestro preset 内,编排会话才载) |
| 入口 | 同一个 inbox.log,fs.watch(pump.js:652-656);由 **Orca 侧** `orca terminal send` 写桥 pane(`cat >> inbox.log`)触发 |
| 注册 | 编排会话开场调 `bridge_arm` 工具→绑 agent、登记 registry(pump.js:618-726);arm 回执自验不一致返回 INCONSISTENT(pump.js:710-722) |
| 出口 | 会话内原生:`agent.followup()`(idle)/`agent.inject()`(忙)(pump.js:594-613)——**不经 loopback RPC** |
| 多会话 | per-sessionId 分槽(slots Map,pump.js:577-580),解决多编排会话互杀(incident 0003) |
| 与 fleet | **零接触**——路由靠 bridge/registry.json,不读 fleet.json |
| 现状 | 与 host-callback-bridge 是**前任/宿主接管版**关系;addressing.js 从 pump.js:127-187 逐行平移(host-callback-bridge/core/addressing.js:3-4) |

### 1.3 message-bridge(会话内 HTTP 直发通道)

| 维度 | 事实 |
|---|---|
| 挂载 | `agent.cordis.yml:369-370` |
| 入口 | 回环 HTTP 口(host-callback-bridge 常驻 lane;P4 起唯一 HTTP 持有者=host 进程,会话内不绑口) |
| 出口 | 会话内原生 followup/inject,前缀 `MSGB]`(index.js:355-370);同样 per-sessionId 分槽 |
| 与 host 桥关系 | 并列的第二入向通道(message-bridge/index.js:4-5);host 桥 standby 探测的就是它的口——旧会话桥占着 http.port 时宿主版让位 |
| 现状 | 宿主接管后,arm 流程对编排会话已非必需(USAGE.md:118-148) |

### 1.4 callback-bridge(P1 重构件,未上线)

| 维度 | 事实 |
|---|---|
| 状态 | v4.0.0 **P1 内核平移完成,未注册进任何 cordis yml,生产零接触**(index.js:1-8,README.md:6) |
| 目标形态 | Sources(file-inbox/http)→Codec→共享内核(addressing/registry/dedup/store)→Sink(agent-turn)(PACKAGING.md §9) |
| 迁移计划 | P1 平移(不注册)→P2 双跑→P3 切换(重启)→P4 清理 |

## 2. fleet.json:与桥正交的会话登记面

**路径** `~/.dsh/maestro/fleet.json`(env `MAESTRO_FLEET`);顶层 `{port, defaultWorkspaceId, fleet, terminal}`。

两种条目:
- **session 类**(键=sessionId 前 4 hex):`sessionId/role(worker|orchestrator|supervisor|peer|liaison)/node/preset/spawnedAt/status(active|standby|retired)/mailbox?/project?` + OF-002 租约键(`owner/leaseExpiresAt/heartbeatAt/leaseTtlMin`,claim 后) + **结构面字段**(`parent` 编排者签名或父席位码、`flow?` 波 id、`lane?` 车道——编排组树,fleet-adopt 写/fleet-tree 读,与租约闸正交)
- **orca-terminal 类**(键=terminal handle):`kind:"orca-terminal"/handle/status(probing|verified|mismatch|stale|inactive|released)/probedAt/verifiedAt/lastSeenAt/alias/note`

**生命周期写入者**(全部 flock 串行或 tmp+rename 原子):

| 操作 | 写入者 |
|---|---|
| 建 session | session-spawn(session.create RPC→fleet 原子写,:63-85) |
| 建 terminal | fleet-probe(upsert_probing,:85-94) |
| 建 a2a 孵化 | a2a-profile-server/registry.js(updateEntry→writeFleet,:62-69) |
| 心跳/租约/sweep | fleet-touch(touch/claim/heartbeat/release/sweep,:125-218) |
| 结构认领/解除 | fleet-adopt(flock 写 parent/flow/lane,幂等,--clear 解除) |
| 状态迁移 | a2a registry.transition('retired') 同步落 fleet |
| 删 | session-purge(HTTP /purge→fleet 移除,:48-55) |

只读消费者:fleet-list(席位清单)、fleet-tree(编排组森林,循环引用降级/unattached 计数)。

**关键关系**:fleet 管"**谁存在**"(会话/终端元数据),registry.json 管"**桥投给谁**"(消费者路由)——两者正交;host-callback-bridge 不读写 fleet(仅 loopback-sink 读它的 `port` 字段做 apiPort 回退);orca-callback 完全不碰 fleet。

## 3. maestro 编排会话如何被驱动

两条独立路径,殊途同归到回合:

1. **桥路径**(外部 agent → 编排会话):
   `cb-send`/Orca terminal send → HTTP/文件 → inbox.log → host-callback-bridge fs.watch → addressing(registry.json 解析 to)→ loopback `/api/session.prompt`(ORCA-CB] 信封)→ 会话回合
2. **直发路径**(bin 客户端 → 任意会话):
   `session-send` → fleet.json 短码解析 → OF-002 steer 租约闸 → DSHMSG] v2 信封 → 同一个 `/api/session.prompt` → 会话回合;收方回合首动作 `msg-dedup` 去重(OF-001)

投递语义保障:at-least-once(游标/死信/重试×3)+ 60s 去重窗(跨通道共享)+ steer 两段式 ack/nack(OF-003)+ 租约闸(OF-002)。

## 4. 其余角色

- **a2a-profile-server**(:8790):A2A HTTP 面 + profile 孵化库;读 fleet 做 reattach/心跳,retired 同步写回;`agents/send` 轻载走 session-send、重载走 dais mailbox(http-server.js:152-166)
- ~~event-watchd~~:**已退役**(2026-08-30 gapfix;bin 留档无单元在跑)——回合外看守职能并入编排者自巡
- ~~orch-notify.sh~~:**已退役**(ADR-011,orch-hardlink 退役;单元归档 `logs/orch-hardlink-retire/`,orchestration.db 仍活用于 memory/diag 线)
- **ledger**(SQLite):项目状态账本,与桥/fleet 无直接耦合,终态票单向投影 longtask-carryover.md(OF-010)
- **锁文件真相**:无 `maestro.lock`;现行实锁 = `state/fleet.json.lock`(spawn/touch/adopt 共用哨兵)、`ledger.db.lock`;watch/hooks 旧锁随单元退役消亡

## 5. env 重定向矩阵(沙箱隔离依据)

| env | 默认 | 作用 |
|---|---|---|
| `DSH_HOME` | `~/.dsh` | 宿主 sessions/storages/profiles/presets 根 |
| `DSH_PORT` | 3080 | loopback RPC 端口回退(fleet.json port 优先) |
| `MAESTRO_FLEET` | `~/.dsh/maestro/fleet.json` | fleet 表 |
| `MAESTRO_BRIDGE` | `~/.dsh/maestro/bridge` | 桥目录(inbox/registry/http.port) |
| `MAESTRO_STATE` | `~/.dsh/maestro/state` | 锁/去重窗/游标 |
| `MAESTRO_HOME` | `~/.dsh` | purge.port/unarchive spool 等杂项根 |
| `MAESTRO_ORCH_SIGNATURE` | bridge/orch.signature | 编排者签名 |
| `MAESTRO_LEDGER` | `~/.dsh/maestro/ledger.db` | 账本 |

沙箱 `/home/yy/tools/dsh-comm-sandbox/run.sh` 全量重定向上述变量 + `--port 3081`,已验证与生产并存(桥口 41751 vs 46855,fleet/会话/存储完全分置)。
