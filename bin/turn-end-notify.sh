#!/usr/bin/env bash
# TurnEnd 观测锚 (pm 编排面, orch-p0 2026-09-03): 只观测——把 CC 桥 TurnEnd 载荷追加为 JSONL trace。
# 不消费 hook 输出、不回唤醒编排者(防回合结束回环); 失败静默(对照 dsh-hooks 约定: 钩子失败 agent 照常)。
LOG="${DSH_TURNEND_LOG:-$HOME/.dsh/maestro/logs/hooks-claude-code/turn-end.log}"
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true
export DSH_TURNEND_LOG="$LOG"
python3 -c '
import sys, json, os, datetime
try:
    p = json.load(sys.stdin)
    if not isinstance(p, dict):
        p = {"_payload": "non-dict"}
except Exception:
    p = {"_parse": "error"}
rec = {"ts": datetime.datetime.now().astimezone().isoformat(timespec="seconds")}
for k in ("session_id", "hook_event_name", "cwd", "transcript_path"):
    if k in p:
        rec[k] = p[k]
with open(os.environ["DSH_TURNEND_LOG"], "a") as f:
    f.write(json.dumps(rec, ensure_ascii=False) + "\n")
' 2>/dev/null || { command -p cat >/dev/null 2>&1 || :; }
exit 0
