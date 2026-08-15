# maestro — 高级管理编排模式 · 设计与迭代文档

> 自扫快照生成于 v3 完成时。本文档是 maestro 的**身份定义、能力 scope、底层实现构成**的
> 权威描述，供后续迭代对照。改 preset 前先读本文，改完更新本文。

## 0. 快速事实

| 项 | 值 |
|---|---|
| preset id | `maestro`（用户根，`~/.dsh/.agent-presets/maestro/`）|
| 蓝本 | copy 自 shipped `standard`（全量编码能力不减配）|
| 当前版本 | v3（v1 基础编排 → v2 语义/P2P/进度 → v3 SQLite 账本）|
| 挂载校验 | `standingKeyFor('maestro')` → mounted OK（v3 实测通过）|
| 账本 | `~/.dsh/maestro/ledger.db`（v3 首轮实测：20 projects / 24 nodes / events 已开账）|

## 1. 身份定义（它是什么）

maestro 是 DSH 的**监督者模式**：一个不在一线写代码、而是**编排其他 agent** 的管理
agent。它的自我认知由 persona（`agent.cordis.yml` 第 30 行起）定义，一句话：

> orchestration supervisor — coordinates work across agents instead of doing it
> all itself: Orca worktrees and terminals, Orca orchestration runs, zap session
> mailboxes, and this harness's own subagents.

三条身份支柱：
1. **路由者**：一句话需求 → 唯一编排模式（不搅浑、不连环面试）
2. **中继者**：跨平面给 agent 搭对话通道，逐字转发、绝不改写
3. **记账者**：每次分发与回收都落 SQLite 账本，跨会话记忆，汇报只认账本

## 2. 能力 scope

### 2.1 语义路由（persona §"Reading the user's orchestration intent"）

| 用户语义 | 模式 | 核心动作 |
|---|---|---|
| 移交词无监督词 | FULL HANDOFF | `worktree create --agent --prompt`，报告后停 |
| 监督词（盯/等/汇报）| SUPERVISED RUN | Run→Task→Dispatch→滚动 `check --wait` |
| 传话词无后续义务 | ONE-SHOT P2P | 投递+回报即止 |
| "让 A 和 B 对齐" | P2P BRIDGE | 我当邮局，双向埋回复地址后中继 |
| "进度如何/汇总" | PROGRESS SWEEP | 只读收集，零派工副作用 |
| 并行 A/B/C ±监督 | 一 Run 多 Task / 各自 handoff | |
| 卡住/拍板 | DECISION GATE / ask_user_question | |
| 移交+监督并存 | 按监督处理（永不裸 handoff）| |

### 2.2 决策线（persona §"Decision lines"，六条）

Orca 状态→orca-cli；handoff→停式移交；监督/DAG/门→orchestration；跨 harness
终端→zap-direct-send；桌面 UI→computer-use；纯 shell→普通工具。

### 2.3 P2P 三平面通信（persona §"P2P communication planes"）

- **DSH 子代理**：subagent/subagent_fork + `send_message`
- **Orca 终端 agent**：轻量 `terminal send`；结构化走 Run 收件箱 / `dispatch:<id>`
- **zap 面板（任意 harness）**：`zap-oss orchestration send-message` 到 session mailbox

桥接协议四步：解析双方地址 → 开场互埋回复地址 → 按节奏轮询中继（zap 拉取=消费，
Orca `--peek` 不消费）→ 逐字转发+停滞如实报告。

### 2.4 进度收集五级递进（persona §"Progress collection"）

`worktree ps`（免费）→ `task-list --brief`+`check --peek` → zap `check-messages`
（消费式）→ `terminal read --cursor`/`worker-read` → DSH `job_output`/`list_agents`。
报告形状固定：每 worker 一行 + 总览行，`unknown` 必标信号龄。周期 sweep 用后台 job，
禁 sleep 轮询。

### 2.5 SQLite 项目状态账本（persona §"Project status ledger"，详见 skill）

见 §4.2。协议五条：sweep 开场先 sync；每次分发落 `dispatched`+refs；每次回收落
终态+≤300字摘要；汇报只查账本；落账失败不阻塞主流程。

### 2.6 保留的全量编码能力

bash/fs/搜索/jobs/skills/goal/plan/compaction/**subagent+fork+workflow+ralph**/
ask-user/todo/web（组合行见 §4.1）。

### 2.7 环境依赖（运行时外部世界，非组合内）

| 依赖 | 探测方式 | 备注 |
|---|---|---|
| Orca CLI | `$ORCA_CLI_COMMAND` → `orca-dev` → Linux 非托管终端 `orca-ide` | 禁 bare `orca`（GNOME 屏幕阅读器）|
| Orca 指南 | `ORCA skills get orca-cli / orchestration` | 版本匹配，不信任记忆 |
| zap GUI | `pgrep -af zap`；二进制 `command -v zap-oss` 或 debug 构建路径 | headless 只剩 pull 路径 |
| agent 池 | 本机实测：claude/omp/pi 可被 `--agent` 调度 | codex/gemini/grok 未装 |
| skill 池 | `~/.agents/skills`：orca-cli/orchestration/zap-direct-send/orcard/computer-use/herdr/qa-test… | skill-filesystem 自动带入 |

## 3. 版本史

| 版本 | 增量 |
|---|---|
| v1 | copy standard；persona 换监督者 doctrine（First moves / Decision lines / Hard rules / Working style）|
| v2 | +语义路由 8 模式；+P2P 三平面与桥接协议；+进度收集五级递进 |
| v3 | +maestro-ledger skill（sync.py/log.sh）；+SQLite 账本协议节；首轮实测落账 20/24 |

## 4. 底层实现构成

### 4.1 组合行（agent.cordis.yml，28 行）

```
persona(监督者 doctrine, ~110行)  agent-instructions(64KB)
tool-bash / tool-pwsh(平台互斥)   tool-fs / tool-fs-search   tool-jobs
skill-filesystem / tool-skill     tool-goal
planning{planMode isolate}        compaction{compaction+toolResultPruner isolate}
delegation{workflowEngine isolate:
  tool-subagent-control / list-agents / subagent(spawn) / subagent-fork(fork)
  [codex|claude-code 模板 disabled] / workflow-worker-thread / tool-workflow / tool-ralph}
tool-ask-user / tool-todo / tool-web
```

平面规则遵循：所有行只**消费**宿主服务（tools/skills/goals/web…），唯一自持服务
（planMode/compaction族/workflowEngine）均已在 isolate realm 内——v1 copy 蓝本已保证，
maestro 未增减任何服务行，**改动只发生在 persona 文本与 skill 目录**。

### 4.2 maestro-ledger skill

```
skills/maestro-ledger/
├── SKILL.md          # schema + 命令配方 + 写账协议 + 红线
└── scripts/
    ├── sync.py       # orca worktree ps → upsert projects/nodes（幂等，自动建库）
    └── log.sh        # 节点 upsert + 事件追加（同一事务）
```

- 库：`${MAESTRO_LEDGER:-~/.dsh/maestro/ledger.db}`，sqlite3 CLI / python3 标准库实现
  （刻意不依赖 node:sqlite——bash 工具面直接可调）
- 表：`projects(key=repoId::主路径)` / `nodes((project_key,node_id) 唯一; kind;
  status; owner; refs JSON)` / `events(只追加流水)`
- 枚举：kind=`worktree|task|dispatch|handoff|p2p|job`；status=`pending|ready|
  dispatched|running|done|failed|blocked|inactive`；event=`dispatched|progress|
  done|failed|blocked|note|sweep|bootstrap`
- 防覆盖：sync 不把 `dispatched/running/blocked` 编排态冲回 inactive
- 红线：events 只增；nodes/projects 只 upsert；detail ≤300 字存指针不存产物；
  落账失败不阻塞编排

### 4.3 挂载校验方法（迭代必做）

探针插件模式（本 session 验证过的标准姿势）：
`cordis_define`(inject agentPresets → harness.registerTool preset_roster) →
`cordis_run` → `preset_roster id:maestro`（内部 `standingKeyFor`）→ 期待
`mounted OK` → `cordis_undefine` 清理。失败信息会指名未激活行/越界服务。

## 5. 迭代方向备忘

1. **账本读取面**：现在汇报靠手写 SQL；可加 `report.py`（固定报告形状一键生成）
2. **zap 集成深化**：ledger 的 p2p 节点尚未接 zap run/dispatch id（refs 已预留）
3. **调度策略**：worker-start 的 agent 选择（claude/omp/pi）目前靠人；可按项目历史
   （账本 events 统计）给建议
4. **v2 模板启用**：codex/claude-code 子代理行仍是 disabled 模板，装了产品后去掉
   `disabled` 即可
5. **冷藏区治理**：19 个 inactive MAIN worktree 无注释；可批量为 ledger 补 summary
6. **文档同步规矩**：改 persona/组合/skill 任一处 → 更新本文对应小节 + 版本表加一行
   → 重跑挂载校验

## 6. 文件清单（v3 终态）

```
~/.dsh/.agent-presets/maestro/
├── agent.cordis.yml      # 352行；persona 9 节 + standard 全量能力行
├── preset.yml            # 名称「高级编排模式」+ 描述
├── docs/DESIGN.md        # 本文档
└── skills/maestro-ledger/{SKILL.md, scripts/sync.py, scripts/log.sh}
~/.dsh/maestro/ledger.db  # 运行数据（20 projects / 24 nodes，随使用增长）
```

## 7. Orca→DSH 回调通道（orca-bridge skill，v3.2 回调泵驱动 turn）

**约束**：DSH 进程不是 Orca 面板（无 `ORCA_TERMINAL_HANDLE`），Orca 消息路由只能目标
Orca 注册终端 handle，无原生"直发本进程"路径。

**回调泵**（v3.1 桥接 → v3.2 升级为推送即唤醒）：两个 DSH 原生机制组合——
**后台 job 完成通知**（settlement 注入会话，驱动新回合）+ **goal 自动续轮**（armed
goal 持续驱动）。等价 zap 的 push-on-idle 指针，但 body 直接随 job 输出送达。

```
Orca agent: terminal send --terminal <bridge_handle> --text "…"
 └► 桥 pane (cat >> inbox.log) ─► watch.sh 一次性 job(阻塞→打印→退出)
     └► job 结算通知注入 session(驱动回合) ─► 处理+ledger+reply.sh ─► 重新布防
```

工具：`skills/orca-bridge/`（SKILL.md 架构与红线 / scripts/watch.sh 一次性 watcher，
`.cursor` 行号游标顺序消费 / scripts/reply.sh 回复桥 pane）。消息建议 JSON
（`{"type":"ask|report|ping","from":…,"body":…}`）；单行 ~4KB 上限；结构化语义仍走
Orca orchestration 面。Orca 重启 → handle 作废需重建。

**实测记录（v3.2）**：ping@15:02:47 经 job 结算成功驱动 turn → pong 回复 → 账本落账
→ 重布防。**回声环路教训**：桥 pane 是 `cat >> inbox.log`，reply.sh 写回的
`DSH-RE]` 行会回流进 inbox，旧 watcher 把自己的 pong 当新消息又触发一轮。修复：
watch.sh 过滤 `DSH-RE]` 前缀（保留字，跳过并推进游标继续等），SKILL.md 已记约定。

**v3.3 原生插件泵（"一切皆插件"的实证）**：读 dsh-tool-jobs 源码找到回合驱动原生
接缝——`ctx.jobs.onJobDone` → `Agent.followup(message)`（idle）/ `Agent.inject(message)`
（忙），消息为冻结的 `{id, role:'user', content, source:{kind:'plugin',...}}`。据此把
整个泵实现为 **preset 自带本地插件** `plugins/orca-callback/pump.js`：
`node:fs.watch` inbox（游标顺序消费，DSH-RE] 回声跳过）→ followup/inject 直接驱动
回合——**不再需要后台 job、不再需要 goal、不再需要 bash watcher**。组合行
`name: './plugins/orca-callback/pump.js'`（相对路径经组合 baseUrl 解析；ESM 不支持
目录导入须指到文件；**同名文件改内容会被 Node ESM 缓存咬住——换文件名破缓存**，
此坑实测）。工具 `bridge_arm` 会话开场绑定发起 agent。15:08:52 实弹：动态 POC 版
（ocb-5）经 `Agent.followup()` 驱动了真实回合，pong 双向确认。挂载校验通过。

**双模驱动事实（v3.4 记录）**：感知 inbox 存在两种模式——正式版 preset 插件
`fs.watch`/inotify **事件驱动**（毫秒延迟）；POC 动态插件因沙箱无 `node:fs`、fs
服务无 watch 方法，用 **1s interval 轮询**（≤1s 延迟）。投递协议两端一致（写
inbox / orca-cli 桥 pane），消息 append-only 不丢，投递方无需感知模式。该差异已
写入 `~/.agents/skills/maestro-bridge/SKILL.md`（共享 skill 面向投递方的说明）。
参照：zap 的 push-on-idle router 自身也是 500ms 轮询——边缘轮询是此类系统常态，
但 maestro 正式路径已是纯事件驱动。

**v3.2 关键修复**：maestro 的 `skill-filesystem` 行补上 `customSkillDirs:
[preset/skills]`（照抄 cordis preset 的 `!!js` baseUrl 写法）——否则 preset 内 skill
（maestro-ledger / orca-bridge）在真实会话中不会被自动发现。修复后挂载校验通过。

## 8. 迭代方向（并入 §5）
