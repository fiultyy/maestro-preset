# 三平面通信:端点网格模型与迭代同构

> 2026-08-25 二轮调研修正版。核心修正:平面是**原生归属**,不是**访问域**。
> 三平面(Orca/DSH/dais)的通信面全是同机 IPC CLI,无围栏;可达性 =
> CLI 可执行(无 sandbox/PATH/mount 障碍) × skill 暴露 × agent 执行准确。

## 1. 端点网格模型(修正"三平面中继"旧观)

三套系统不是"三个隔离域 + 一个网关",而是**同一台机器上的 N 个 IPC 端点**,
任意终端里的任意 agent 可达任意端点:

```
                 ┌─────────────── 同机 IPC 网格(无围栏) ───────────────┐
                 │                                                      │
  Orca 终端 agent ─┼─▶ orca terminal send / orchestration (原生)        │
                 │   ▶ dais orchestration send-message   (CLI 直达)    │
                 │   ▶ cb-send / session-send → DSH      (CLI 直达)    │
                 │                                                      │
  dais 终端 agent ─┼─▶ dais send-message / inject-prompt (原生)         │
                 │   ▶ orca-ide terminal send            (CLI 直达,     │
                 │     AppImage 需 orca-com bypass: ELECTRON_RUN_AS_NODE)│
                 │   ▶ cb-send / session-send → DSH      (CLI 直达)    │
                 │                                                      │
  DSH 会话 agent ─┼─▶ session.prompt / followup           (原生)        │
                 │   ▶ orca terminal send / orchestration (CLI 直达)    │
                 │   ▶ dais send-message / inject-prompt (CLI 直达)    │
                 └──────────────────────────────────────────────────────┘
```

**"平面"的真实含义**:不是访问边界,而是"谁的原生数据结构承载这条消息"
(Orca 运行时存储 / DSH Agent Inbox 事件流 / dais SQLite)。

**可达性三要素**(2026-08-25 代码+生产数据核实,证据见 §5):
1. **无围栏**:三方向 CLI 全部同机可执行。实测:本机 `which dais` /
   `which orca-ide` 均在 `~/.local/bin` 直接可达;orca-com bypass
   (`ELECTRON_RUN_AS_NODE=1`)只是 AppImage 形态的历史路径,非必要墙。
   唯一对称前置:目标平面运行时活着(dais GUI / DSH host / Orca 运行时);
2. **skill 暴露**:实际形态三种——skill 文件(`~/.agents/skills` 池 →
   各 harness 符号链接,35 条在用)、persona 内联(agent.cordis.yml:41,87
   直接写 dais 用法)、shared/ 手册。当前断点两条,见 §5;
3. **agent 执行准确**:a2a-profile-server/http-server.js:171-175 代码级
   实现"DSHMSG] 信封塞进 dais 载体",dais SQLite 里 43 条信封消息
   证明协议跨平面堆叠已在生产跑通。

推论:**maestro 不是"网关"**,它只是把网格的常用边封装得最好的那个 preset。
任何 agent 都可以绕过它直连任意端点。

## 2. 迭代同构:三套系统走的是同一条演化路径

三套系统独立迭代,却长出同构的四层栈——因为演化压力相同:

| 层 | 解决的失效模式 | Orca | DSH | dais |
|---|---|---|---|---|
| **L1 裸直发** | 最初需求:把消息塞给对面 agent | `terminal send`(PTY stdin) | `session.prompt` RPC / followup | `inject-prompt`(bracketed-paste+CR) |
| **L2 信封+持久 inbox** | L1 无证据/无确认/目标忙即丢 | Run mailbox(运行时存储,FIFO+ack) | Agent Inbox(双队列+session 事件)+ ORCA-CB]/DSHMSG] 信封 + inbox.log | SQLite messages 表(push 指针+pull 消费) |
| **L3 常驻承载** | L2 绑会话则会话死链路死 | Orca 运行时(Electron 主进程)承载 Run | host-callback-bridge 宿主 boot 承载(SI-003) | router 后台线程 + waiters 表 |
| **L4 生命周期治理** | 多 agent 并发协调语义 | worker_done/heartbeat/escalation + decision gate | ack/done 握手 + two-phase steer(OF-003) + fleet 租约(OF-002) + 去重(OF-001) | worker_done/heartbeat + block-settle |

**演化方向恒定:L1 → L2 → L3 → L4**,每层都是对上一层失效模式的回应:
- 直发 fire-and-forget 不可靠 → 加信封、持久化、at-least-once、去重
- 链路随会话消亡 → 搬进常驻进程(宿主/主进程/后台线程)
- 有了可靠链路后,多 agent 并发暴露协调问题 → 生命周期信号、租约、决策门

**载体选型光谱**(三家的 L2 差异):Orca 运行时内存存储(查询最快,进程死丢) ←→
DSH 事件流投影(与会话日志同源,天然审计) ←→ dais SQLite(独立持久,跨进程共享)。
没有唯一正解,各自匹配宿主形态。

## 3. 修正后的交互矩阵

原"不存在的方向"修正为**"无原生封装,CLI 直达"**:

| 边 | 通道 | 状态 |
|---|---|---|
| Orca→DSH | cb-send / 桥 pane / session-send | 原生封装(skill: maestro-bridge) |
| DSH→Orca | orca terminal send / orchestration | 原生封装(persona P2P 段) |
| DSH→dais | dais send-message / inject-prompt | 原生封装(skill: dais-orchestration) |
| dais→DSH | cb-send(dais pane 内执行) | skill 暴露(maestro-bridge) |
| **Orca→dais** | dais CLI 在 Orca 终端直接执行 | **CLI 直达,实测可执行**(skill 暴露当前断链,见 §5) |
| **dais→Orca** | orca-ide CLI(~/.local/bin) | **CLI 直达**(orca-com bypass 仅为 AppImage 历史路径) |

"重叠通道"同理修正:不是冗余,是各平面在 L1/L2 的同构层各自暴露——
选层规则(信封 vs 裸、持久 vs 低延迟)已在 persona Decision Lines 裁决。

## 4. 对迭代的指导意义

给通信机制迭代(comm-iter)的两条推论:
1. **新通道设计先问落在哪一层**:任何新桥件都是在四层栈上选层落位,
   与三平面既有层对齐即可复用心智模型(如 callback-bridge v4 的
   Sources→内核→Sink 就是把 L1/L2 显式分层);
2. **暴露优于封装**:网格模型下,把端点用法写成 skill 给所有 agent,
   比在中枢里加转发逻辑更符合架构本性——中枢会死,CLI 端点常在。

## 5. 核实证据(2026-08-25,代码+生产数据)

**① Orca 平面直发 dais(实测)**:本终端属 Orca(1.4.185)平面,
直接执行 `dais orchestration check-messages --help` 成功——CLI 从
Orca 平面可达,`~/.local/bin/dais` 权限 `-rwxrwxr-x`,零围栏。
唯一前置:目标平面运行时活着(与三平面对称,agent.cordis.yml:41)。
历史流量 from_handle 无 term_*/cc* 模式——可达但尚未有人这么用。

**② 协议跨平面堆叠(生产代码+数据)**:
a2a-profile-server/http-server.js:171-175 重载路径
`const line = 'DSHMSG]' + JSON.stringify(envelope)` →
`dais orchestration send-message`——DSH 信封落进 dais SQLite。
dais DB(770 条,08-22~08-24)实测:43 条消息体含 DSHMSG]/ORCA-CB] 信封;
DSH 平面身份投递 session_* 225 条、fleet 4-hex 短码 60 条、maestro@dsh 1 条。

**③ skill 暴露的实际形态与断点**:
- 池子模式:`~/.claude/skills` 35 条符号链接指向 `~/.agents/skills` 池
  (各 harness 共享暴露机制,在用);
- **断点 A**:`~/.claude/skills/zap-direct-send → ~/.agents/skills/zap-direct-send`
  为断裂符号链接(dais 2026-08-17 改名后目标消失,池中实体已叫
  dais-orchestration 但未链接)——Orca 平面 CC agent 的 dais 暴露降级;
- **断点 B**:maestro preset 装点(`~/.dsh/.agent-presets/maestro/`)
  skills/ 只有 orca-bridge、maestro-ledger,shared/ 只有 maestro-bridge,
  源仓 shared/skills/dais-orchestration 未分发到装点——DSH maestro
  agent 的 dais 面靠 persona 内联指令(agent.cordis.yml:41,87)支撑。
