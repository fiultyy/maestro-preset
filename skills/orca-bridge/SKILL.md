# orca-bridge — Orca→DSH 回调通道（驱动 turn 的桥）

让 Orca 侧任何 agent 用 **一条 orca-cli 命令**回调本 DSH 进程，且回调能**直接驱动
session 新回合**——不只是消息落盘，而是"推送即唤醒"。

## 架构（回调泵 · v3.3 原生插件版）

```
Orca agent: terminal send --terminal <bridge_handle> --text "…" --enter
   └─► 桥 pane (cat >> inbox.log)
         └─► plugins/orca-callback/pump.js: fs.watch + 游标消费（回声过滤）
               └─► Agent.followup()/inject()   ← DSH 原生回合驱动（同 tool-jobs 唤醒接缝）
                     └─► 回合内: 处理消息 → ledger 落账 → (可选) reply.sh 回复
```

**maestro 会话开场调一次 `bridge_arm`** 即武装（绑定发起 agent）。无 job、无 goal、
无 bash watcher。bash 版 `watch.sh`（job 结算 + goal 续轮）保留为无插件环境的手工
后备方案。

**双模驱动**：maestro 正式路径 `fs.watch`/inotify **事件驱动**（毫秒延迟）；
动态插件 POC 因沙箱无 `node:fs`，退化为 **1s interval 轮询**（≤1s 延迟）。
投递协议两端一致、消息不丢；面向投递方的说明见共享 skill
`~/.agents/skills/maestro-bridge/SKILL.md`。

## 落地步骤（maestro 会话开场即可复用）

```bash
B=~/.dsh/.agent-presets/maestro/skills/orca-bridge/scripts

# 1) 建桥（Orca 重启后 handle 失效需重建；成功后 handle 写入 ~/.dsh/maestro/bridge/handle）
mkdir -p ~/.dsh/maestro/bridge
orca-ide terminal create --title maestro-bridge \
  --command "bash -c 'cat >> ~/.dsh/maestro/bridge/inbox.log'" --json
#   → 取 result.terminal.handle 存入 ~/.dsh/maestro/bridge/handle

# 2) 布防一次性 watcher（run_in_background: true）
"$B/watch.sh"          # 阻塞直到下一条回调，打印 ORCA-CB] <msg> 后退出

# 3) arm goal（回调泵目标，保持自动续轮；见 persona "Project status ledger" 同款纪律）

# 4) Orca 侧投递（Orca agent 视角的"回调 API"）：
orca-ide terminal send --terminal $(cat ~/.dsh/maestro/bridge/handle) \
  --text "<JSON or 文本>" --enter --json

# 5) DSH 侧回复：
"$B/reply.sh" "<回复>"
```

## 派发握手（ACK/DONE 契约，terminal send 派发必嵌）

`terminal send` 没有投递语义——不要靠读终端输出确认对方收到并开始回合。监督式派发
（supervised dispatch）在消息末尾嵌入下面的契约，把确认变成对方的两次回调：

```
[ref:<node_id>] <任务正文>

—— 回调契约（收到本消息后必须执行）——
1) 回合一开始（第一条动作前）:
   ~/.dsh/.agent-presets/maestro/bin/cb-send ack <你的ID> <orch签名> <ref> "turn started"
2) 完成时:
   ~/.dsh/.agent-presets/maestro/bin/cb-send done <你的ID> <orch签名> <ref> "<结果摘要≤300字符>"
   （cb-send 不在/失败时兜底: printf '%s\n' '{"type":"ack","from":"<你的ID>","to":"<orch签名>","body":"[ref:<ref>] turn started"}' >> ~/.dsh/maestro/bridge/inbox.log）
```

- `<orch签名>` = 编排者 `bridge_arm` 回执的 `<alias>@<sessionId>`（HTTP 通道仅记录、
  文件桥按它路由——务必带上，别用 `*` 广播吵醒所有在册会话）。
- 对端视角：`cb-send` 一条命令（HTTP 优先、文件桥兜底），语义见共享 skill
  `~/.agents/skills/maestro-bridge/SKILL.md`。
- 编排者视角：ACK 到达 → 账本节点 `running`；DONE 到达 → 落 outcome 收口。超过一轮
  sweep（~10 分钟）无 ACK → 退回机械校验（`terminal read --cursor` /
  `terminal wait --for tui-idle`）。握手是协作语义，机械校验兜底，方向不可倒置。
- 边界：FULL HANDOFF 不嵌契约（已放弃监督）；orchestration 面 dispatch 已有
  worker_done 单次回报，不叠第二套协议。

## 约定

- **回声过滤**：桥 pane 是 `cat >> inbox.log`，DSH 侧 `reply.sh` 的回复会回流进
  inbox——`DSH-RE]` 前缀是保留字，watch.sh 会跳过它继续等真正的 Orca 回调。
  Orca 侧消息不要以 `DSH-RE]` 开头。
- 消息格式自由；建议 JSON（`{"type":"ask|report|ping","from":"<agent>","body":…}`）
  便于回合内解析分发
- 单行 ~4KB（PTY 规范模式上限），长内容分段或落文件后传路径
- `.cursor` 是行号游标，多 watcher 顺序消费 inbox，不丢不重
- 结构化语义（线程/阻塞等待）仍走 Orca orchestration 面（`send --to` + `check --peek`），
  本桥定位是**轻量唤醒/回调**

## 红线

- watch.sh 是一次性的：每处理一条回调必须重新布防，否则泵断流
- 桥 pane 是共享资源：不要往里灌大输出（会污染 inbox.log）
- Orca 重启 → handle 作废：`terminal list` 找 `maestro-bridge` 重建 handle 文件
