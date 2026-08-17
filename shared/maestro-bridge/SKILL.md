---
name: maestro-bridge
description: >-
  Cross-harness callback into a DSH maestro orchestrator session: send ack/done
  dispatch handshakes, ask/report/ping messages that drive the orchestrator's
  turn natively. Use when a dispatched task message tells you to "cb-send",
  reply "ack"/"done" to an orchestrator, you see a "[ref:...]" callback contract,
  or you need to report to / ask the maestro coordinator from Orca terminals,
  dais (formerly zap) panes, cron, or any local agent process.
---

# maestro-bridge — 回调 DSH maestro 编排会话(对端 agent 冷执行手册)

你在另一个 harness(Orca 终端 / dais(原 zap)面板 / cron / 脚本)里干活,DSH maestro 编排会话
是协调者。本手册让你**零上下文**完成回调: 消息直达编排者并驱动其回合,无需它轮询。

## 第一步: 自查身份(from 字段填什么)

`from` 只需**稳定可辨识**,不必是任何真 handle:

1. 派发消息里的回调契约通常已写明你的 ID(如 `dev1@t1`)——直接用它;
2. 否则,若 orcard skill 可用: 查 terminal handle 作 ID;
3. 否则用 `<角色>@<项目或终端名>`,如 `coder@zap-repo-x`,并在 body 里自我说明一次。

## 第二步: 一条命令回调(cb-send)

```bash
CB=~/.dsh/.agent-presets/maestro/bin/cb-send    # 安装点
[ -x "$CB" ] || CB=~/.dsh/maestro/bin/cb-send   # 镜像兜底

# 握手: 收到派发、回合已开始(第一条动作前发!)
"$CB" ack <你的ID> <orch签名> <ref> "turn started"

# 完成: 结果摘要 ≤300 字符
"$CB" done <你的ID> <orch签名> <ref> "<结论;产物路径;剩余事项>"
```

- `<orch签名>` = 派发契约里编排者给的 `<alias>@<sessionId>`。**别填 `*`**(广播吵醒
  所有在册会话);实在没有就填 `orch1`。
- `<ref>` = 派发消息 `[ref:…]` 里的任务号,没有填 `-`。
- cb-send 自动选路: HTTP(有语义应答 200/208)优先,文件桥兜底,皆不丢消息。

## cb-send 不可用时: 手拼 JSON 写文件桥

```bash
printf '%s\n' '{"type":"ack","from":"<你的ID>","to":"<orch签名>","body":"[ref:<ref>] turn started"}' \
  >> ~/.dsh/maestro/bridge/inbox.log
```

armed 的编排会话按游标顺序消费,未 armed 也**不丢**(武装后补投)。

## 消息语义(type)

| type | 何时发 | body |
|---|---|---|
| `ack` | 收到派发、回合一开始 | `[ref:<ref>] turn started` |
| `done` | 任务完成 | `[ref:<ref>] <摘要≤300字;产物位置;剩余事项>` |
| `ask` | 被阻塞,需编排者拍板 | 问题 + 你已试过的路 |
| `report` | 中途进度通报 | 阶段结论 |
| `ping` | 链路自检 | 任意;应收到 `DSH-RE]` pong |

共同纪律: body 以 `[ref:<ref>] ` 前缀(编排者按它对账节点)。

## 红线

- **绝不以 `DSH-RE]` 开头**——DSH 侧回复保留字,会被泵当回声过滤掉;
- 单行 ≤4KB(PTY 上限);长内容落文件,body 传路径;
- `to` 用编排者签名,不用 `*`;
- `done` 只发一次;发过 done 的 ref 不要再投(编排者按 done 收口节点)。

## 排查

- 编排者收不到: `tail ~/.dsh/maestro/bridge/inbox.log` 看行是否落盘;HTTP 口在
  `~/.dsh/maestro/bridge/http.port`,可 `curl -sS -X POST http://127.0.0.1:$(cat ~/.dsh/maestro/bridge/http.port)/callback -H 'content-type: application/json' -d '<同上JSON>'` 直测;
- 回复查看: `orca terminal read --terminal $(cat ~/.dsh/maestro/bridge/handle)` 读桥
  pane,或 tail inbox.log 找 `DSH-RE]` 行;
- 桥 pane 失效(Orca 重启后): 
  ```bash
  mkdir -p ~/.dsh/maestro/bridge
  orca-ide terminal create --title maestro-bridge \
    --command "bash -c 'cat >> ~/.dsh/maestro/bridge/inbox.log'" --json
  # 把 result.terminal.handle 写入 ~/.dsh/maestro/bridge/handle
  ```
