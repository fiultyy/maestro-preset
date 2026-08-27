# maestro-ledger — 账本速查

`~/.dsh/maestro/ledger.db`(SQLite)。工具: `python3 ~/.dsh/maestro/bin/ledger`(装点)或 preset 面 `~/.dsh/.agent-presets/maestro/shared/maestro-ledger/scripts/`。

```bash
L="python3 ~/.dsh/maestro/bin/ledger"
$L project <path> <name>                                    # 登记项目(幂等)
$L node <project_key> <node_id> <kind> <status> <event_type> <source> <detail> [refs_json]
#   kind: worktree|task|dispatch|handoff|p2p|job
#   status/event_type 按事件写: dispatched/running/done/failed/blocked
$L event <project_key> <node_id> <event_type> <detail>      # 只追加事件
$L report                                                  # 汇报查询
```

规则: 每次派发→upsert 节点 dispatched + `dispatched` 事件;每次收果(回调/扫描)→update 状态 + ≤300 字 outcome。汇报从账本来,不凭记忆。账本写失败不阻塞编排:记一笔继续。
