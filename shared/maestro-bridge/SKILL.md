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

# maestro-bridge — 回调编排者(目的→命令→参数)

你是 worker,要回报 DSH maestro 编排会话。**一条命令,不需要读任何文件**:

```bash
CB=~/.dsh/maestro/bin/cb-send   # 不在时镜像: ~/.dsh/.agent-presets/maestro/bin/cb-send

"$CB" ack  <你的ID> <orch签名> <ref> "turn started"      # 回合一开始就必须发
"$CB" done <你的ID> <orch签名> <ref> "<结果摘要≤300字>"   # 完成时发
```

## 目的 → 命令

| 我要… | 调什么 | 传什么 |
|---|---|---|
| 报"收到/开干" | `cb-send ack <你的ID> <orch签名> <ref> "turn started"` | 回合第一条动作前发 |
| 报完成 | `cb-send done <你的ID> <orch签名> <ref> "<摘要≤300字>"` | 只发一次 |
| 问编排者拍板 | `cb-send ask <你的ID> <orch签名> <ref> "<问题+已试的路>"` | — |
| 中途通报 | `cb-send report <你的ID> <orch签名> <ref> "<阶段结论>"` | — |
| 链路自检 | `cb-send ping <你的ID> <orch签名> - "probe"` | — |
| 编 cb-send 的 ID | 派发消息给了就照抄;没给编稳定的(如 `dev1@t1`) | — |
| 编 orch 签名 | 派发契约里的 `<alias>@<sessionId>` 照抄;只有裸别名也能填(单持有者自动升级) | — |
| ref | 派发消息 `[ref:…]` 的任务号,没有填 `-` | — |

## 规则

1. **收到派发 → 必须先发 ack 再干活**(编排者按它把节点置 running)。
2. **完成 → done 只发一次**;发过的 ref 别再投。
3. **`to` 必须用编排者全签名**,别用 `*`(广播吵醒所有会话+命中死会话)。
4. **body 绝不以 `DSH-RE]` 开头**(保留字,会被过滤成回声丢弃)。
5. 单行 ≤4KB;长内容落文件,body 传路径。
6. 你的 `from` 只是标识,**不能收回信**(桥单向)。dais 面互通走 `dais orchestration send-message`。

## 出问题才查

- 没回音: `tail -3 ~/.dsh/maestro/bridge/dead.log` — `unknown-addressee`=目标不在册(把 ack 手写落文件桥: `printf '%s\n' '{"type":"ack","from":"<你>","to":"<签名>","body":"[ref:<ref>] turn started"}' >> ~/.dsh/maestro/bridge/inbox.log`);`ambiguous`=撞名,换全签名重发。
- 直测 HTTP 口: `curl -sS -X POST http://127.0.0.1:$(cat ~/.dsh/maestro/bridge/http.port)/callback -H 'content-type: application/json' -d '{"type":"ping","from":"<你>","to":"<签名>","body":"probe"}'`
