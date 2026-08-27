# orca-bridge — 编排者派发手册(动作模板)

你是编排者,要把任务派给终端里的 agent 并等它回报。**照抄模板,不要读文件**。

## 派发(terminal send 时必嵌契约)

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

`<MY-SIG>` = 你的注册签名 `<alias>@<sessionId>`(host-lane 部署下 = `POST /register` 回执;spawn 已自动注册)。**永远写全签名**,裸别名靠 cb-send 预解析只是兜底。

## 收口

- ACK 到 → 节点 running;DONE 到 → 落 outcome 收口。回调**原生唤醒你的回合**,不轮询。
- 超 ~10 分钟无 ACK → 机械校验兜底(`terminal read --cursor` / `terminal wait --for tui-idle`)。握手协作,机械校验仲裁。
- 判定对端产出时防旧文误触: 排除回合开始前已存在的命中行,关键词用本轮独有词(ref 号/新产物名),命中后再等一次 tui-idle 才收口。

## 大文本 paste 陷阱

正文大时目标 TUI 会折叠停在输入框不提交。派发后 45s 未消费 → 补一个空 `--enter` 单独提交;**绝不连发两次 Enter**(第二次撤销 bracketed paste)。单行 ~4KB 上限,超长拆段或落文件传路径。

## 边界

- FULL HANDOFF 不嵌契约(已放弃监督)。
- dais/orchestration 面派发已有 worker_done,不叠第二套协议——dais 面直接用 `worker-up`(见 dais-orchestration skill)。
- 编排会话注册: host-lane 部署(session-spawn 起 = 已注册);裸 preset 用 `bridge_arm { alias }`。重启后死信 `session-not-found` = 目标会话死,等 re-arm。
