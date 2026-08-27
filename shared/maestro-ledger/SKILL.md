# maestro-ledger — 账本(目的→命令→参数)

库: `~/.dsh/maestro/ledger.db`。工具: `L="python3 ~/.dsh/maestro/bin/ledger"`。

| 我要… | 调什么 | 传什么 |
|---|---|---|
| 登记项目 | `$L project <path> <name>` | 幂等 |
| 派发后记账 | `$L node <project_key> <node_id> <kind> <status> <event_type> <source> <detail> [refs_json]` | kind: worktree\|task\|dispatch\|handoff\|p2p\|job;refs 是 JSON(`{"dispatch":"ctx_..","run":"run_.."}`) |
| 只追加事件 | `$L event <project_key> <node_id> <event_type> <detail>` | 收果/进展补记 |
| 汇报查询 | `$L report` | 汇报从账本来,不凭记忆 |

## 规则

1. **每次派发 → 必须记账**(node 置 dispatched + dispatched 事件)。
2. **每次收果(回调/扫描)→ 必须更新**(状态 done/failed/blocked + ≤300 字 outcome)。
3. 账本写失败不阻塞编排: 记一笔继续,下轮 sweep 对账。
