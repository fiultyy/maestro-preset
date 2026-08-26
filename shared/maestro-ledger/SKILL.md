# maestro-ledger — 项目状态账本（SQLite 持久化）

maestro 模式自建的项目状态 log：一个本地 SQLite 文件记录每个项目的**节点过程**（worktree / task / dispatch / handoff / p2p / job），所有分发与回收的结果落账，跨会话持久。

## 何时用

- maestro 会话首次读写项目状态时（persona 会指到这里）
- **分发后落账**：handoff、worker-start、dispatch --inject、zap send-message、subagent 启动 → 节点置 `dispatched`/`running` + 一条 `dispatched` 事件
- **回收后落账**：worker_done、check-messages 拉到的结果、job 产出、sweep 结论 → 节点置 `done`/`failed`/`blocked` + 对应事件（detail=结论摘要）
- 用户问「各项目什么状态/进展」→ **查账本回答**，不凭上一轮记忆

## 数据位置

`${MAESTRO_LEDGER:-~/.dsh/maestro/ledger.db}`

| 表 | 关键列 | 说明 |
|---|---|---|
| `projects` | key=`repoId::主路径` (PK), status, summary | 项目底账，status: active/inactive |
| `nodes` | (project_key,node_id) UNIQUE, kind, status, owner, refs(JSON) | 节点=过程单元 |
| `events` | ts, event_type, source, detail | **追加式流水，只增不改不删** |

- `kind`: `worktree|task|dispatch|handoff|p2p|job`
- `status`: `pending|ready|dispatched|running|done|failed|blocked|inactive`
- `event_type`: `dispatched|progress|done|failed|blocked|note|sweep|bootstrap`
- `refs` 存指针 JSON：dispatch_id / run_id / terminal handle / zap session / branch…

## 怎么用

```bash
BASE=<本 skill 目录>   # 装点 ~/.agents/skills/maestro-ledger;或 preset 面 ~/.dsh/.agent-presets/maestro/shared/maestro-ledger

# 1. 同步项目/worktree 底账（幂等，sweep 第一步必跑；自动建库建表）
python3 "$BASE/scripts/sync.py"

# 2. 分发/回收 落账（节点 upsert + 事件追加，同一事务）
"$BASE/scripts/log.sh" <project_key> <node_id> <kind> <status> <event_type> <source> <detail> [title] [owner] [refs_json]

# 3. 汇报查询：每节点最近一次事件
sqlite3 -header -column ~/.dsh/maestro/ledger.db "
SELECT p.name, n.node_id, n.kind, n.status, n.owner,
       e.event_type, substr(e.detail,1,80) AS last, n.updated_at
FROM nodes n JOIN projects p ON p.key=n.project_key
LEFT JOIN events e ON e.id=(SELECT id FROM events WHERE project_key=n.project_key AND node_id=n.node_id ORDER BY id DESC LIMIT 1)
ORDER BY p.name, n.status, n.updated_at DESC;"

# 4. 单项目时间线
sqlite3 -header -column ~/.dsh/maestro/ledger.db "
SELECT ts,event_type,source,node_id,substr(detail,1,100) FROM events
WHERE project_key=(SELECT key FROM projects WHERE name LIKE '%NAME%') ORDER BY id;"
```

## 机制

- `sync.py`：`ORCA worktree ps --json` → upsert projects + worktree 节点。活跃节点的
  comment/agents[].agentType 顺带带入 summary/owner；已 `dispatched/running/blocked` 的
  节点不会被 sweep 覆盖回 inactive（编排态只由分发/回收事件推进）。
- `log.sh`：唯一写入口之一；project_key 未知时先跑 sync.py 或手 INSERT projects。
- 时间戳一律本地 ISO（`date -Is` / python isoformat）。

## 红线

- 账本是跨会话唯一事实源：汇报必须查账本，不得凭记忆复述。
- `events` 只追加；`nodes`/`projects` 只 upsert；无 DELETE/UPDATE 既有行。
- detail 存**结论摘要**（≤300 字）；大块产物留在源系统（worktree、terminal、
  transcript、Run 卡），refs 存指针。
- 落账失败（库锁/磁盘）不阻塞编排主流程：告警一次继续，下次 sweep 补账。
