# orca-bridge — 编排者派发手册(目的→模板→参数)

你是编排者,把任务派给终端里的 agent 并等回报。**照抄模板,不要读文件**。

## 目的 → 动作

| 我要… | 怎么做 | 传什么 |
|---|---|---|
| 派任务并等回报 | `terminal send` + 末尾嵌下面的契约模板 | 见模板 |
| 报"对方已开工/已完成" | 等回调(原生唤醒你的回合,不轮询) | ACK→节点 running;DONE→收口 |
| 回调超时(~10 分钟) | 机械校验: `terminal read --cursor` / `terminal wait --for tui-idle` | 握手协作,机械校验仲裁 |
| 派大文本 | 拆段或落文件传路径 | 见规则 4 |
| 换 pane 里的 harness | `answer <sid> --text "/quit" --enter` 再注入新别名 | — |

## 派发契约模板(terminal send 末尾必嵌,照抄改尖括号)

```
[ref:<ref>] <任务正文>

—— 回调契约(收到本消息后必须执行)——
1) 回合一开始:
   ~/.dsh/maestro/bin/cb-send ack <你的ID> <MY-SIG> <ref> "turn started"
2) 完成时:
   ~/.dsh/maestro/bin/cb-send done <你的ID> <MY-SIG> <ref> "<摘要≤300字>"
   (cb-send 不在时兜底: printf '%s\n' '{"type":"ack","from":"<你的ID>","to":"<MY-SIG>","body":"[ref:<ref>] turn started"}' >> ~/.dsh/maestro/bridge/inbox.log)
3) 契约行丢失: load skill `maestro-bridge`
```

`<MY-SIG>` = 你的注册签名 `<alias>@<sessionId>`。**必须写全签名**。

## 规则

1. **派发 → 必须嵌契约**(terminal send 没有投递语义,别靠读终端输出确认)。
2. **回调原生唤醒回合,不轮询**;超时才机械校验。
3. **判定对方产出 → 三闸**: 排除回合前已存在的命中行;关键词用本轮独有词(ref 号/新产物名);命中后再等一次 tui-idle 才收口。
4. **大文本折叠陷阱**: 派发后 45s 未消费 → 补一个空 `--enter`;**绝不连发两次 Enter**(第二次撤销粘贴,正文被撤回)。单行 ~4KB 上限。
5. **FULL HANDOFF 不嵌契约**(已放弃监督);dais 面派发已有 worker_done,不叠第二套——dais 面用 `worker-up`(见 dais-orchestration skill)。
6. 死信 `wake failed … session-not-found` = 目标会话死了,等它 re-arm,别重投。
