# maestro 使用说明

> 完整安装/结构/信任边界见 [README.md](./README.md)。本文是操作手册: 从装好到跑通一条编排链路,再讲到开发调试。

## 1. 这是什么

一个 DSH **agent preset**: 把它挂到会话上,那个会话就变成「编排主管」,能跨 **Orca**(worktree/terminal)、**zap**(GUI/终端)、**DSH**(子 agent 会话)三个平面协调多 agent 干活、收发消息、折叠进度。配套一套回调桥(文件桥 + HTTP 直发)与 SQLite 账本。

## 2. 安装与前置

```bash
git clone https://github.com/fiultyy/maestro-preset.git ~/.dsh/.agent-presets/maestro
```

前置: DSH(宿主)、Orca CLI(编排面必需)、sqlite3 CLI(账本)。zap 可选。

装完**新建一个会话**,在 preset 选择器里选「高级编排模式」。preset 一经选用不可热切换,切换要开新会话。

## 3. 首次会话三步走

**① arm 回调泵**(会话开场调一次工具):

```
bridge_arm { alias: "orch" }
```

回执给出规范签名 `orch@session-xxxx`。记住它——这是别人把回调精准投给你的地址。

**② 建 Orca 桥**(一次性,Orca 重启后 handle 失效需重建): 让 agent 读 `skills/orca-bridge/SKILL.md` 执行建桥脚本,把桥 pane 的 handle 写进 `~/.dsh/maestro/bridge/handle`。桥 pane 就是一个 `cat >> inbox.log` 的终端,是外部回调进 DSH 的入口。

**③ 对外发消息**: 用 `bin/session-send`(见 §7)。

## 4. 核心概念(30 秒版)

- **三平面**: Orca(worktree/terminal/repo/浏览器)、zap(GUI 终端)、DSH(子会话)。路由靠 persona 里的决策线判断,别硬背。
- **DSHMSG 信封**: 每条跨会话消息首行是 `DSHMSG]{"from","to","type","ref","body"}`。`session-send` 帮你拼,回调桥帮你收。
- **fleet 码表**: `~/.dsh/maestro/fleet.json` 把 `orch1`/`aa0a` 这种 4 位码映射到 sessionId。`session-spawn` 起会话自动登记。
- **回调桥**: 两条入向通道——文件桥(Orca pane 写 inbox.log)与 HTTP 直发(本机 curl POST /callback)。出向统一 `session-send`。

## 5. 一条端到端链路

```bash
# 编排者自己: 起一个 worker 会话(code preset,登记为 dev1)
session-spawn code dev1 "跑个回归" <workspaceId>

# 编排者给 dev1 发任务(DSHMSG,queue 模式进 dev1 的回合)
session-send orch1 dev1 task reg1 "在仓库 X 跑 cargo test 并回报"

# dev1 干完,经桥回调编排者(在 dev1 会话里):
session-send dev1 orch1 done reg1 "3 通过 0 失败"
```

编排者收到回调 → 桥把它注入成一个新回合 → 编排者更新账本、继续下一个 gate。

## 6. 组件逐项

### 6.1 插件

| 插件 | 作用 | 模型可见工具 |
|---|---|---|
| `orca-callback` | 文件桥泵: watch inbox.log,at-least-once 投递(多消费者寻址/去重/死信/轮转) | `bridge_arm {alias}` |
| `message-bridge` | HTTP 直发: 127.0.0.1 随机端口 POST /callback | `bridge_http_status` |
| `workspace-unarchive` | 归档会话恢复(读 maestro/unarchive.log 逐行恢复) | 无(自动) |
| `session-purge` | 按需删会话(confirm="PURGE" 闸 + 自删拒 + 忙闸) | 经 `bin/session-purge` |

### 6.2 技能

- **orca-bridge**: 建桥 pane、布防 watcher、回复署名约定。含 `scripts/watch.sh`(阻塞等一条回调)、`scripts/reply.sh`(回执)。
- **maestro-ledger**: 账本读写(分发/回收全落账)。含 `scripts/sync.py`/`log.sh`。

### 6.3 bin 脚本

```bash
session-send   <from> <to> <type> <ref> <body>   # 发 DSHMSG;type: ping|pong|done|ask|steer|nack|ack
session-spawn  <preset> <node> <purpose> [ws]    # 起会话+入组+命名+登记,回显 4 位码
session-purge  <code|sessionId>                   # 删会话(确认闸门)
```

## 7. 运行时状态

全部在 `~/.dsh/maestro/`(包本身无状态):

| 路径 | 内容 | 清理方式 |
|---|---|---|
| `bridge/inbox.log[.1]` | 桥收件箱(轮转保留一代) | 停泵后删 |
| `bridge/registry.json` | 在册消费者 | 随会话 teardown 自注销;崩溃残留需手清 |
| `bridge/.cursor.*` / `state.json` / `dead.log` / `echo.log` | 游标/计数/死信/回声 | 可整体删(重置) |
| `bridge/http.port` / `http.state.json` | HTTP 通道端口与计数 | 随实例 |
| `fleet.json` | 码表 | 手工编辑 |
| `ledger.db` | 账本 | sqlite 操作 |

## 8. 环境变量

见 [README.md](./README.md) 环境变量表。核心五个: `MAESTRO_BRIDGE`、`MAESTRO_BRIDGE_ALIAS`、`MAESTRO_LEDGER`、`MAESTRO_HOME`、`DSH_PORT`。

## 9. 升级与代际语义

- 升级 = `git pull` 到安装目录(或本仓库开发目录,见 §10)。
- **preset 以 `agent.cordis.yml` 的 stamp(mtime+size)为代际键**: 改这个文件 → 新会话自动挂新代际;运行中会话**永远保持加入时的代际**。
- **只改 `plugins/*.js`**: 运行中会话已把旧模块导入内存,不受影响;确定性让新代码生效 = **重启 DSH 进程**。
- 因此发布新版本 = 改代码 + 改 `agent.cordis.yml`(哪怕加个注释),让新会话拿到新代际。

## 10. 开发模式(软链接,repo 改动即时生效)

不想每次改完拷贝到 `~/.dsh/.agent-presets/maestro`? 让安装点直接指向本仓库:

```bash
# 1) 备份已安装副本(如有)
mkdir -p ~/.dsh/maestro/dev
[ -e ~/.dsh/.agent-presets/maestro ] && mv ~/.dsh/.agent-presets/maestro ~/.dsh/maestro/dev/maestro.installed.bak

# 2) 软链接指向本仓库
ln -s "$(pwd)" ~/.dsh/.agent-presets/maestro

# 3) 验证
readlink -f ~/.dsh/.agent-presets/maestro   # → /home/<you>/tools/maestro-preset
```

之后在本仓库改文件,安装点即所见(软链接直通)。**生效边界仍受 §9 约束**: 改 `agent.cordis.yml` → 新会话即得新代际;改插件 `.js` → 重启 DSH 才确定性生效。开发循环建议: 改代码 → 重启宿主(或接受"新会话才生效")→ 开新会话验证。

## 11. 信任与安全

本 preset 的插件会写文件、开回环监听端口、驱动会话回合;技能会指使 agent 操作 Orca 终端。user preset 等同 shell 权限——只从信任来源安装,审阅 `agent.cordis.yml` 列的每一行后再挂载。
