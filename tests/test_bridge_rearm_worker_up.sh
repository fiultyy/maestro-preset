#!/usr/bin/env bash
# test_bridge_rearm_worker_up.sh — 断路修复三件套单测(2026-08-26)
# 被测面: ①bridge-rearm 清扫/复读闸 ②session-spawn bridge_register 尾部
#         ③worker-up dry-run 序列形状。全 temp 域, 零真实投递。
set -uo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d); trap 'rm -rf "$WORK"; [ -n "${MOCK_PID:-}" ] && kill "$MOCK_PID" 2>/dev/null' EXIT
B="$WORK/bridge"; mkdir -p "$B"; export MAESTRO_BRIDGE="$B"
PASS=0; FAIL=0
ok() { PASS=$((PASS+1)); echo "[ ok ] $1"; }
bad() { FAIL=$((FAIL+1)); echo "[FAIL] $1: $2"; }

# ── mock host lane: /register /unregister /status(错 key 也回 ok:true, 复刻真面) ──
MOCK_PORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')
MOCK_REG="$B/registry.json"
python3 - "$MOCK_PORT" "$MOCK_REG" <<'EOF' &
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
port, reg_path = int(sys.argv[1]), sys.argv[2]
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _j(self, code, obj):
        self.send_response(code); self.send_header('content-type','application/json'); self.end_headers()
        self.wfile.write(json.dumps(obj).encode())
    def do_POST(self):
        n = int(self.headers.get('content-length', 0)); body = json.loads(self.rfile.read(n) or b'{}')
        if self.path == '/register':
            d = json.load(open(reg_path)); d['consumers'][body['sessionId']] = {'alias': body.get('alias'), 'pid': 424242}
            json.dump(d, open(reg_path, 'w'))
            self._j(200, {'ok': True})
        elif self.path == '/unregister':
            self._j(200, {'ok': True})  # 复刻静默 no-op 面洞
        else: self._j(404, {'ok': False})
    def do_GET(self):
        if self.path == '/status': self._j(200, {'ok': True, 'registeredConsumers': len(json.load(open(reg_path))['consumers'])})
        else: self._j(404, {'ok': False})
HTTPServer(('127.0.0.1', port), H).serve_forever()
EOF
MOCK_PID=$!
echo "$MOCK_PORT" > "$B/http.port"

# ── ① bridge-rearm ──
DEAD_PID=999999999   # 保证不存在
python3 -c "
import json
json.dump({'version':'test','consumers':{
  'session-aaaa':{'alias':'live','pid':$PPID},
  'session-bbbb':{'alias':'dead','pid':$DEAD_PID},
  'session-cccc':{'alias':'nopid','pid':None}}}, open('$MOCK_REG','w'))"

OUT=$("$REPO/bin/bridge-rearm" --dry-run 2>&1)
echo "$OUT" | grep -q "dead=2" && echo "$OUT" | grep -q "no changes" && ok "rearm dry-run 报2死且不改" || bad "rearm dry-run" "$OUT"
python3 -c "
import json,sys
d=json.load(open('$MOCK_REG')); sys.exit(0 if len(d['consumers'])==3 else 1)" && ok "dry-run 零副作用" || bad "dry-run 副作用" "consumers 变了"

OUT=$("$REPO/bin/bridge-rearm" 2>&1)
echo "$OUT" | grep -q "swept: 2" && echo "$OUT" | grep -q "verified: 0 dead" && ok "rearm 清扫2+复读闸" || bad "rearm 清扫" "$OUT"
python3 -c "
import json,sys
d=json.load(open('$MOCK_REG')); sys.exit(0 if list(d['consumers'])==['session-aaaa'] else 1)" && ok "仅活条目存活" || bad "清扫结果" "残留: $(python3 -c "import json;print(list(json.load(open('$MOCK_REG'))['consumers']))")"

OUT=$("$REPO/bin/bridge-rearm" --register session-zzz orch1 2>&1)
echo "$OUT" | grep -q "verified: orch1@session-zzz" && ok "rearm --register 注册+复读闸" || bad "rearm register" "$OUT"

# ── ② session-spawn bridge_register(独立函数经 mock 口直测) ──
SPAWN_ERR="$WORK/spawn-err.txt"
python3 - "$REPO/bin/session-spawn" <<'EOF' 2>"$SPAWN_ERR"
import sys
src = open(sys.argv[1]).read()
ns = {'__name__': 'not_main'}
body = src.split("def main()", 1)[0]  # 只执行 imports+atomic_write+bridge_register 定义
exec(compile(body, 'session-spawn', 'exec'), ns)
ns['bridge_register']('session-zzz2', 'probe')
print('called')
EOF
OUT=$(cat "$SPAWN_ERR")
echo "$OUT" | grep -q "registered probe@session-zzz2" && ok "spawn 尾部注册经 mock 口成功" || bad "spawn 注册" "$OUT"
# 失败路径: 无 http.port → warn 不抛
rm -f "$B/http.port"
OUT=$(python3 - "$REPO/bin/session-spawn" <<'EOF' 2>&1
import sys
src = open(sys.argv[1]).read()
ns = {'__name__': 'not_main'}
exec(compile(src.split("def main()", 1)[0], 's', 'exec'), ns)
ns['bridge_register']('session-x', 'y')
print('survived')
EOF
)
echo "$OUT" | grep -q "survived" && echo "$OUT" | grep -q "register skipped" && ok "桥不可用仅warn不阻断" || bad "spawn warn 路径" "$OUT"

# ── ③ worker-up dry-run 序列形状 ──
OUT=$("$REPO/bin/worker-up" task_x "$REPO" cc-dais 'do the thing' --dry-run 2>&1)
echo "$OUT" | grep -q "new-terminal .*maestro-preset-iter" && ok "up① new-terminal 带项目路径" || bad "up①" "$OUT"
echo "$OUT" | grep -q "start-worker task_x" && ok "up② start-worker" || bad "up②" "$OUT"
echo "$OUT" | grep -q "assigned ctx_" && echo "$OUT" | grep -q "dispatch: ctx_" && ok "up③ assign 链" || bad "up③" "$OUT"
echo "$OUT" | grep -q "inject-prompt ctx_.* cc-dais" && ok "up④ harness 注入" || bad "up④" "$OUT"
echo "$OUT" | grep -q "inject-prompt ctx_.* do the thing" && ok "up⑤ 任务注入" || bad "up⑤" "$OUT"
echo "$OUT" | grep -q "worker-up: ok" && ok "up 收尾行" || bad "up 收尾" "$OUT"
OUT=$("$REPO/bin/worker-up" task_x "$REPO" bogus-harness --dry-run 2>&1); [ $? = 2 ] && ok "up 非法 harness 拒绝" || bad "up harness 校验" "$OUT"

echo; echo "rearm/worker-up suite: $PASS/$((PASS+FAIL))"; [ "$FAIL" = 0 ]
