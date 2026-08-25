#!/usr/bin/env bash
# tests/p4-watch.sh — P4 24h 可判定观测(P4.9)
# 用法: p4-watch.sh baseline [file]   # 采集基线(写 /tmp 或指定文件)
#       p4-watch.sh check <基线文件>   # 比对,退出码 0=三断言全过
set -u
B="${MAESTRO_BRIDGE:-$HOME/.dsh/maestro/bridge}"
mode="${1:-}"
dead_count() { [ -f "$B/dead.log" ] && wc -l < "$B/dead.log" | tr -d ' ' || echo 0; }
counters() { python3 - "$B/state.json" <<'EOF'
import json, sys
try:
    s = json.load(open(sys.argv[1]))
    hb = s.get('hostBridge', {})
    http = hb.get('http', {}).get('counters', {})
    fr = hb.get('fileRouter', {}).get('counters', {}) if isinstance(hb.get('fileRouter'), dict) else {}
    print(json.dumps({
        'dead': http.get('deadCount', fr.get('deadCount', 0)),
        'failed': http.get('failed', 0),
        'delivered': http.get('delivered', fr.get('deliveredLines', 0)),
    }))
except Exception:
    print(json.dumps({'dead': -1, 'failed': -1, 'delivered': -1}))
EOF
}
rj_failed() { cat ~/.dsh/plugins/a2a-profile-server/state/*/router-journal.jsonl 2>/dev/null | grep -c '"delivered":"failed"' || true; }

case "$mode" in
baseline)
  OUT="${2:-/tmp/p4-watch-baseline.json}"
  python3 - "$OUT" "$(dead_count)" "$(counters)" "$(rj_failed)" <<'EOF'
import json, sys
json.dump({'deadLines': int(sys.argv[2]), 'counters': json.loads(sys.argv[3]), 'rjFailed': int(sys.argv[4])}, open(sys.argv[1], 'w'))
print(f"baseline -> {sys.argv[1]}")
EOF
  ;;
check)
  BASE="${2:?check 需要基线文件}"
  python3 - "$BASE" "$(dead_count)" "$(counters)" "$(rj_failed)" <<'EOF'
import json, sys
base = json.load(open(sys.argv[1]))
dead_now, counters_now, rj_now = int(sys.argv[2]), json.loads(sys.argv[3]), int(sys.argv[4])
fails = []
if dead_now != base['deadLines']:
    fails.append(f"dead.log 行数 {base['deadLines']}→{dead_now}(零新增破线)")
if counters_now['failed'] != base['counters']['failed']:
    fails.append(f"counters.failed {base['counters']['failed']}→{counters_now['failed']}")
if rj_now != base['rjFailed']:
    fails.append(f"router-journal failed {base['rjFailed']}→{rj_now}")
if fails:
    print("p4-watch FAIL: " + "; ".join(fails))
    sys.exit(1)
print("p4-watch PASS: dead.log 零新增 / counters.failed==基线 / router-journal 无新增 failed")
EOF
  ;;
*) echo "usage: p4-watch.sh baseline [file] | check <file>" >&2; exit 2 ;;
esac
