# OF-003 报告 — 控制消息 two-phase + 可达性文档收口(D-08 尾巴)

> 票: docs/kg/09-orch-hardening-plan.md §3 OF-003 · 基线 28fa9d8(OF-002 已合入)
> 执行: of003 · 2026-08-23 · 改动在 working tree 待 GM 统一提交
> 文件域: orch-loop.md · bin/dispatch-ticket · ~/.agents/skills/maestro-bridge/SKILL.md(仓外) · tests/of003-selftest.py(new) · 本报告
> 未触碰: bin/session-send、bin/fleet-touch(28fa9d8 刚合入)、bin/wave-checkpoint(OF-007 在制品)、templates/dispatch-preamble.md

## 0. 交付物摘要

| 文件 | 变更 |
|---|---|
| `orch-loop.md` | 编排环节后新增"控制消息两段式(OF-003)"节: 契约正文 + 三条补充(短码/fullId 双兼容、OF-002 闸衔接=契约只处理闸放行后的消息、派发模板自动携带) |
| `bin/dispatch-ticket` | 新增 `STEER_TWO_PHASE` 常量;`build_message()` 在渲染模板前**预置契约头**——生成的派发 prompt 首行即"─── 控制消息两段式 ───"块;CLI 参数/退出码零变化(OG1) |
| `~/.agents/skills/maestro-bridge/SKILL.md` | 主叙事切换: 新首节"主通道: 编排者可达性 = 直投完整 sessionId(session-send 推唤醒)"+ 内嵌两段式契约;cb-send 节降级改名"备胎通道",文件桥改名"深备胎";frontmatter description 同步(触发词加 steer ack/nack) |
| `tests/of003-selftest.py` | 14 检查全绿(下节原文) |

**契约正文(三处同文,grep 锚点 7 个)**:

```
控制消息两段式(two-phase steer,OF-003):
steer 发出后,收方回合首动作 = `session-send <self> <from> ack <ref> 'steer-accepted'`(已读将执行)
或 `session-send <self> <from> nack <ref> 'busy:queued'`(正忙: 消息保留、入列,下回合首处理)。
nack busy 语义钉死 = 不丢不重: 消息由收方回合队列持有,下回合首先处理;同 msgid(OF-001 信封)
重复投递由 bin/msg-dedup 在去重窗口拦截(exit 3),收方零重复执行。类型复用现有 ack/nack,不新增。
无契约旧 peer: 发送方零阻塞——不等待 ack/nack,发送即返回;未回 ack 不构成失败,不重发、不升级,
沿用"机械核查为仲裁"原则(回调逾期才触发人工核查)。
```

## A. selftest 输出原文

`cd /home/yy/.dsh/maestro && python3 tests/of003-selftest.py`(exit 0):

```
① 契约文本三处齐(grep 可验):
  [PASS] orch-loop.md 含全部 7 个契约锚点 — 7/7
  [PASS] bin/dispatch-ticket 含全部 7 个契约锚点 — 7/7
  [PASS] SKILL.md 含全部 7 个契约锚点 — 7/7
② dispatch-ticket 生成的派发 prompt 头部含契约头(--dry-run,不发送不落账):
  [PASS] dry-run rc0(零发送零落账)
  [PASS] prompt 头部 = 控制消息两段式契约块 — ─── 控制消息两段式(two-phase steer,OF-003;收到 steer 必答)───
  [PASS] 契约头含 ack 'steer-accepted' / nack 'busy:queued' 回执命令
  [PASS] 契约头位于票体之前(头=头部,非尾部) — contract@110 < body@1227
  [PASS] 模板主体保留: [ref:TST-001] 回调契约 + 票体注入 + 占位符全替换
③ SKILL.md 主叙事切换(session-send 直投为主,cb-send 降备胎;D-08 尾):
  [PASS] 主叙事 = 编排者可达性直投完整 sessionId(session-send 推唤醒)
  [PASS] 主通道节在 cb-send 备胎节之前(叙事主次落地) — main@955 < cb-fallback@2242
  [PASS] cb-send 明确标注备胎(降级定位)
④ 旧 peer 零阻塞语义在 orch-loop 有明文(nack busy 不丢不重同验):
  [PASS] orch-loop 明文: 发送方零阻塞/不等待 ack-nack/机械核查为仲裁
  [PASS] orch-loop 明文: nack busy = 消息保留、下回合首处理、不丢不重(与 msgid 勾稽)
  [PASS] orch-loop 契约节引用 OF-002 闸(语义衔接: 契约只处理闸放行后的消息)

OF-003 selftest: 14/14 全绿
```

## B. 验收逐条(§3 OF-003 验收 ①–④)

| # | 验收 | 证据 |
|---|---|---|
| ① | 契约文本三处齐(grep 可验) | selftest §①: orch-loop.md / bin/dispatch-ticket(STEER_TWO_PHASE 常量) / SKILL.md 各含全部 7 锚点(两段式标题、ack/nack 回执命令、不丢不重、msg-dedup、不等待、机械核查为仲裁);契约正文三处同文 |
| ② | 一次真实 steer 往返: 收方 ack 回达发送方(live 冒烟) | **待 GM 窗口**——GM 验收时以两真实会话走一次(正例: steer → 收方回合首动作 `session-send <self> <from> ack <ref> 'steer-accepted'` 回达发送方)。可离线半面已验: selftest §② dispatch-ticket --dry-run 生成的派发 prompt 头部即契约块(收方冷启动零上下文携带),rc0 零发送零落账 |
| ③ | nack busy 语义文档钉死 = 消息保留、下回合首处理,不丢不重(与 OF-001 msgid 勾稽) | 契约正文第 3–4 行(三处同文): "消息由收方回合队列持有,下回合首先处理;同 msgid(OF-001 信封)重复投递由 bin/msg-dedup 在去重窗口拦截(exit 3)";selftest ④ 第二项 grep 断言 orch-loop 在位 |
| ④ | 无契约旧 peer: 发送方零阻塞(无 ack 不等待,机械核查为仲裁,文档明示) | 契约正文末两行(三处同文)+ selftest ④ 第一项: "发送方零阻塞——不等待 ack/nack,发送即返回;未回 ack 不构成失败,不重发、不升级,沿用'机械核查为仲裁'原则" |

## C. OG 门核对

- **OG1 兼容不破**: dispatch-ticket CLI 参数/用法/退出码零变化(--help 干跑验证);生成 prompt 增契约头 = 本票票面特性(收方为 LLM,无机械解析依赖首行格式);orch-loop/SKILL 为纯文档。未碰 session-send/fleet-touch/ledger/wave-checkpoint 二进制
- **OG2 冒烟自带**: selftest 14/14;dispatch-ticket 走 --dry-run(temp repo + env 签名,零真实终端/ledger 触碰)
- **OG3 红线继承**: 未 commit/push;未改 pipecat-poc 仓;orch-loop.md 与 OF-007 worker 的八步/checkpoint 改动无冲突(本票节插在断点续传节之后,依变后基线适配)
- **OG4 台账回写**: D-08 尾巴由 GM 回写(本票不直改台账),done body 带 `台账:D-08尾 待GM回写`
- **OG5 信封只增不改**: 本票零信封改动(纯文档/模板)

## D. 设计注记

1. **契约正文单一范本**: 6 行正文三处逐字同文(锚点 grep 勾稽);各处仅头部装饰行不同(orch-loop fenced 块 / dispatch-ticket `───` 分隔头 / SKILL fenced 块)。
2. **dispatch-ticket 嵌入点选 build_message() 而非 templates/dispatch-preamble.md**: 模板文件不在本票许可文件域;且契约头在脚本常量中可 grep、可单点维护。若后续要移回模板,把 `STEER_TWO_PHASE + '\n' +` 前缀去掉、模板头粘贴同文即可。
3. **SKILL.md 叙事层级**: 主通道(session-send 直投)→ 身份自查 → 备胎通道(cb-send)→ 深备胎(手拼 JSON);消息语义表/红线/排查共用不动。steer 收方义务放在主通道节内("收到 steer 必答"),冷执行 agent 直达。
4. **与 OF-002 闸的边界**: 闸拦"谁有权发"(发送侧 exit 4),两段式管"收方怎么回执"(闸放行后);orch-loop 补充②明示此衔接,防两机制语义混淆。

---
done body:通过;报告:reports/OF-003-report.md;测试:14全绿;台账:D-08尾 待GM回写;备注:两段式契约三处齐;SKILL主叙事切直投
