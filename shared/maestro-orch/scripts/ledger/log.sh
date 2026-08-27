#!/usr/bin/env bash
# maestro-ledger 落账：upsert 一个节点 + 追加一条事件（同一事务）。
# 用法:
#   log.sh <project_key> <node_id> <kind> <status> <event_type> <source> <detail> [title] [owner] [refs_json]
# 示例:
#   log.sh "repo::/home/yy/x" "/home/yy/orca/workspaces/x/t1" dispatch running dispatched orca "task t1 -> codex@term_xx" "t1" codex '{"dispatch_id":"dp1"}'
# kind: worktree|task|dispatch|handoff|p2p|job
# status: pending|ready|dispatched|running|done|failed|blocked|inactive
# event_type: dispatched|progress|done|failed|blocked|note|sweep|bootstrap
set -euo pipefail
DB="${MAESTRO_LEDGER:-$HOME/.dsh/maestro/ledger.db}"

if [ "$#" -lt 7 ]; then
  grep '^#' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
fi
project_key="$1"; node_id="$2"; kind="$3"; status="$4"; etype="$5"; source="$6"; detail="$7"
title="${8:-}"; owner="${9:-}"; refs="${10:-null}"

esc() { printf '%s' "${1//\'/\'\'}"; }
now=$(date -Is)

sqlite3 "$DB" <<SQL
BEGIN;
INSERT INTO nodes(project_key,node_id,kind,title,status,owner,refs,updated_at)
VALUES('$(esc "$project_key")','$(esc "$node_id")','$(esc "$kind")','$(esc "$title")','$(esc "$status")','$(esc "$owner")','$(esc "$refs")','$now')
ON CONFLICT(project_key,node_id) DO UPDATE SET
  kind=excluded.kind,
  status=excluded.status,
  title=CASE WHEN excluded.title!='' THEN excluded.title ELSE nodes.title END,
  owner=CASE WHEN excluded.owner!='' THEN excluded.owner ELSE nodes.owner END,
  refs=CASE WHEN excluded.refs!='null' THEN excluded.refs ELSE nodes.refs END,
  updated_at=excluded.updated_at;
INSERT INTO events(ts,project_key,node_id,event_type,source,detail)
VALUES('$now','$(esc "$project_key")','$(esc "$node_id")','$(esc "$etype")','$(esc "$source")','$(esc "$detail")');
COMMIT;
SQL
echo "ledger: $project_key / $node_id -> $status ($etype)"
