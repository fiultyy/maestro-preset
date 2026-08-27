---
name: maestro-orch
description: >-
  DSH maestro orchestrator's single entry skill: internal calls (signature,
  ledger, bridge re-arm), dispatch to Orca terminals (terminal send + ACK/DONE
  contract template), and driving the dais plane (worker-up three-step chain,
  delegate full CLI usage to the dais-orchestration skill). Use when you are
  the DSH maestro orchestrator session and need to dispatch work, drive
  terminals, or settle tasks.
---

# maestro-orch — DSH 编排者总入口(目的→命令→参数)

你是 DSH maestro 编排会话。**第一条 bash 永远先 PATH 引导**(spawned shell 缺目录):

```bash
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"
```

你的注册签名 `<alias>@<sessionId>`(session-spawn 自动注册,`cat ~/.dsh/maestro/bridge/registry` 可验)。

## 我要… → 走哪面

| 我要… | 走哪面 | 见 |
|---|---|---|
| 派活给 dais GUI 里的终端 worker | **dais 面** | worker-up 三步链(下)+ `dais-orchestration` skill 全表 |
| 派活给 Orca 终端 agent | **Orca 面** | 契约模板(下) |
| 记账/汇报 | **内部调用** | ledger(下) |
| 桥死了/注册丢了 | **内部调用** | bridge-rearm(下) |

## dais 面 — worker-up 三步链

```bash
dais orchestration new-terminal <项目绝对路径>          # → session_<sid>
dais orchestration start-worker <task_id> --session session_<sid>   # 必须 --session → ctx_<id>
dais orchestration inject-prompt <ctx或session> "<全文>"  # 目标须 idle
```

prompt 里必须嵌 cb-send 回调契约(命令见 `cb-send` skill)。收到 done → `dais orchestration transition-worker <ctx_id> succeeded` 收口,然后 close-terminal。**完整命令面(send-message/check-messages/read-worker/scan-wait-blocked/answer/建 run-task)→ load skill `dais-orchestration`**,本技能不重复。

## Orca 面 — 派发契约模板(terminal send 末尾必嵌,照抄改尖括号)

```
[ref:<ref>] <任务正文>

—— 回调契约(收到本消息后必须执行)——
1) 回合一开始:
   ~/.dsh/maestro/bin/cb-send ack <你的ID> <MY-SIG> <ref> "turn started"
2) 完成时:
   ~/.dsh/maestro/bin/cb-send done <你的ID> <MY-SIG> <ref> "<摘要≤300字>"
   (cb-send 不在时兜底: printf '%s\n' '{"type":"ack","from":"<你的ID>","to":"<MY-SIG>","body":"[ref:<ref>] turn started"}' >> ~/.dsh/maestro/bridge/inbox.log)
3) 契约行丢失: load skill `cb-send`
```

`<MY-SIG>` = 你的注册签名 `<alias>@<sessionId>`。**必须写全签名**。

| 我要… | 怎么做 | 传什么 |
|---|---|---|
| 派任务并等回报 | `terminal send` + 末尾嵌上面的契约模板 | 见模板 |
| 报"对方已开工/已完成" | 等回调(原生唤醒你的回合,不轮询) | ACK→节点 running;DONE→收口 |
| 回调超时(~10 分钟) | 机械校验: `terminal read --cursor` / `terminal wait --for tui-idle` | 握手协作,机械校验仲裁 |
| 派大文本 | 拆段或落文件传路径 | 见规则 4 |
| 换 pane 里的 harness | `answer <sid> --text "/quit" --enter` 再注入新别名 | — |

## 内部调用 — ledger(账本)

库: `~/.dsh/maestro/ledger.db`。工具: `L="python3 ~/.dsh/maestro/bin/ledger"`(sync/log 脚本在本技能 `scripts/ledger/`)。

| 我要… | 调什么 | 传什么 |
|---|---|---|
| 登记项目 | `$L project <path> <name>` | 幂等 |
| 派发后记账 | `$L node <project_key> <node_id> <kind> <status> <event_type> <source> <detail> [refs_json]` | kind: worktree\|task\|dispatch\|handoff\|p2p\|job;refs 是 JSON(`{"dispatch":"ctx_..","run":"run_.."}`) |
| 只追加事件 | `$L event <project_key> <node_id> <event_type> <detail>` | 收果/进展补记 |
| 汇报查询 | `$L report` | 汇报从账本来,不凭记忆 |

## 内部调用 — bridge-rearm(桥/注册修复)

| 我要… | 调什么 | 传什么 |
|---|---|---|
| 宿主重启后重建桥注册 | `~/.dsh/maestro/bin/bridge-rearm --sync` | `--sync` 权威清扫死条目 |
| 只自注册不改册 | `bridge-rearm`(无参) | — |

## 规则

1. **派发 → 必须嵌契约**(terminal send 没有投递语义,别靠读终端输出确认)。
2. **回调原生唤醒回合,不轮询**;超时才机械校验。
3. **判定对方产出 → 三闸**: 排除回合前已存在的命中行;关键词用本轮独有词(ref 号/新产物名);命中后再等一次 tui-idle 才收口。
4. **大文本折叠陷阱**: 派发后 45s 未消费 → 补一个空 `--enter`;**绝不连发两次 Enter**(第二次撤销粘贴,正文被撤回)。单行 ~4KB 上限。
5. **FULL HANDOFF 不嵌契约**(已放弃监督);dais 面派发已有 worker_done,不叠第二套——dais 面用 `worker-up`(见 dais-orchestration skill)。
6. 死信 `wake failed … session-not-found` = 目标会话死了,等它 re-arm,别重投。
7. **每次派发 → 必须记账**(node 置 dispatched + dispatched 事件)。
8. **每次收果(回调/扫描)→ 必须更新**(状态 done/failed/blocked + ≤300 字 outcome)。账本写失败不阻塞编排: 记一笔继续,下轮 sweep 对账。
