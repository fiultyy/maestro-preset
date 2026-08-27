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

# maestro-bridge — 回调编排者(动作手册)

你是 worker,要向 DSH maestro 编排会话回报。**一条命令,不要读任何文件**:

```bash
CB=~/.dsh/maestro/bin/cb-send   # 不可用时镜像: ~/.dsh/.agent-presets/maestro/bin/cb-send

"$CB" ack  <你的ID> <orch签名> <ref> "turn started"     # 回合一开始就发
"$CB" done <你的ID> <orch签名> <ref> "<结果摘要≤300字>"  # 完成时发,只发一次
```

- `<你的ID>`: 派发消息里给了就用它;没给就编一个稳定可辨识的(如 `dev1@t1`)。
- `<orch签名>`: 派发契约里的 `<alias>@<sessionId>`,照抄。只有裸别名也能填(单持有者自动升级;撞名会列候选)。
- `<ref>`: 派发消息 `[ref:…]` 里的任务号,没有填 `-`。
- type 可选: `ack|done|ask|report|ping|status`。`ask`=被阻塞要拍板;`report`=中途通报。

## 出问题才看这里

- **没回音/被丢**: `tail -3 ~/.dsh/maestro/bridge/dead.log` — `unknown-addressee`=目标不在册(等它 re-arm,把 ack 落文件桥留痕: `printf '%s\n' '{"type":"ack","from":"…","to":"…","body":"[ref:…] turn started"}' >> ~/.dsh/maestro/bridge/inbox.log`);`ambiguous`=撞名,改全签名重发。
- **验证目标在册**(发前可选): `python3 -c "import json,os;[print(k[:22],c.get('alias')) for k,c in json.load(open(os.path.expanduser('~/.dsh/maestro/bridge/registry.json')))['consumers'].items()]"`
- cb-send 自动选路 HTTP→文件桥,皆不丢消息。单行 ≤4KB,长内容落文件传路径。

## 红线

- **绝不以 `DSH-RE]` 开头**(保留字,会被当回声过滤)。
- `to` 用编排者签名,别用 `*` 广播。
- 发过 done 的 ref 不要再投。
- 你的 `from` 只是标识,不能收回信——桥单向。dais 面互通走 `dais orchestration send-message`。
