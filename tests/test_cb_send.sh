#!/usr/bin/env bash
# test_cb_send.sh — bin/cb-send 降级链 + PORT-R1 持有者校验单测(ticket 0005)。
#
# 被测面: cb-send 的传输选路——
#   ①PORT-R1 拦截: http.port.sig 在而目标 sessionId(取 to 的 @ 后段)≠持有者
#     → 不 POST, 直落文件桥(请求计数为 0);
#   ②持有者匹配 + HTTP 200 → POST 成功, 不写 inbox.log;
#   ③ADDR-R1 404(HTTP 面显式 to 失配拒收)→ 降级文件桥, inbox.log 落行;
#   ④无 http.port → 直落文件桥;
#   ⑤to=* 广播跳过 sig 拦截(后向兼容), 照常 POST;
#   ⑥落行信封 = {"type","from","to","body"}, body 带 "[ref:<ref>] " 前缀。
#
# 运行: bash tests/test_cb_send.sh   (依赖: bash/curl/python3)
set -uo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
CB="$REPO/bin/cb-send"
WORK=$(mktemp -d)
B="$WORK/bridge"; mkdir -p "$B"
export MAESTRO_BRIDGE="$B"

PASS=0; FAIL=0
check() { # check <desc> <expected> <actual>
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "ok   - $1"
  else FAIL=$((FAIL+1)); echo "FAIL - $1 (expected [$2] got [$3])"; fi
}

# ── 伪 HTTP 面: 记录每个请求体, 状态码由 control 文件决定 ──────────────────
REQS="$WORK/requests"; : > "$REQS"
CODE="$WORK/code"; echo 200 > "$CODE"
SRV="$WORK/server.py"
cat > "$SRV" <<'EOF'
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
class H(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get('content-length', 0))
        body = self.rfile.read(n)
        with open(sys.argv[2], 'ab') as f: f.write(body + b'\n')
        code = int(open(sys.argv[3]).read().strip() or 200)
        self.send_response(code)
        self.send_header('content-type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{"ok":true,"status":"delivered"}')
    do_GET = do_POST
    def log_message(self, *a): pass
HTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
EOF
PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
python3 "$SRV" "$PORT" "$REQS" "$CODE" & SRV_PID=$!
trap 'kill $SRV_PID 2>/dev/null; rm -rf "$WORK"' EXIT
for _ in $(seq 50); do
  curl -s -o /dev/null "http://127.0.0.1:$PORT/" && break || true
  sleep 0.1
done

reqs() { wc -l < "$REQS" | tr -d ' '; }
inbox_lines() { [ -f "$B/inbox.log" ] && wc -l < "$B/inbox.log" | tr -d ' ' || echo 0; }
reset_case() { : > "$REQS"; rm -f "$B/inbox.log"; echo 200 > "$CODE"; }

# ── ① PORT-R1: 持有者不符 → 不 POST 直落文件桥 ──────────────────────────
reset_case
echo "$PORT" > "$B/http.port"; echo "session-holder" > "$B/http.port.sig"
out=$("$CB" done dev1 orch@session-other r1 "summary one" 2>&1); rc=$?
check "① sig mismatch: POST 未发生" "0" "$(reqs)"
check "① sig mismatch: 文件桥落行" "1" "$(inbox_lines)"
check "① sig mismatch: exit 0" "0" "$rc"
case "$out" in *"holder session-holder != target session-other"*) check "① sig mismatch: 拦截日志" ok ok ;;
  *) check "① sig mismatch: 拦截日志" ok "missing in: $out" ;;
esac
MISSED_LINE=$(sed -n '1p' "$B/inbox.log")   # ⑥ 稍后校验(后续 case 会 reset 掉文件)

# ── ② 持有者匹配 + 200 → HTTP 成功, 不写 inbox ───────────────────────────
reset_case
echo "session-mine" > "$B/http.port.sig"
out=$("$CB" ack dev1 orch@session-mine r2 "turn started" 2>&1); rc=$?
check "② sig match: POST 成功" "1" "$(reqs)"
check "② sig match: 不写 inbox" "0" "$(inbox_lines)"
check "② sig match: exit 0" "0" "$rc"
case "$out" in *"cb-send: http 200"*) check "② sig match: http 200 回显" ok ok ;;
  *) check "② sig match: http 200 回显" ok "got: $out" ;;
esac

# ── ③ 404(ADDR-R1 拒收)→ 降级文件桥 ─────────────────────────────────────
reset_case
echo 404 > "$CODE"
out=$("$CB" done dev1 orch@session-mine r3 "summary three" 2>&1); rc=$?
check "③ 404: POST 发生" "1" "$(reqs)"
check "③ 404: 降级文件桥落行" "1" "$(inbox_lines)"
check "③ 404: exit 0" "0" "$rc"

# ── ④ 无 http.port → 直落文件桥 ──────────────────────────────────────────
reset_case
rm -f "$B/http.port" "$B/http.port.sig"
out=$("$CB" ping dev1 orch@session-anywhere r4 "probe" 2>&1); rc=$?
check "④ no port: 无 POST" "0" "$(reqs)"
check "④ no port: 文件桥落行" "1" "$(inbox_lines)"
check "④ no port: exit 0" "0" "$rc"

# ── ⑤ to=* 广播: 跳过 sig 拦截照常 POST ─────────────────────────────────
reset_case
echo "$PORT" > "$B/http.port"; echo "session-holder" > "$B/http.port.sig"
out=$("$CB" status dev1 '*' r5 "broadcast" 2>&1); rc=$?
check "⑤ broadcast: POST 发生" "1" "$(reqs)"
check "⑤ broadcast: 不写 inbox" "0" "$(inbox_lines)"

# ── ⑥ 落行信封形状(①的 inbox 行): 字段与 ref 前缀 ────────────────────────
shape=$(python3 - "$MISSED_LINE" <<'EOF'
import json, sys
try:
    o = json.loads(sys.argv[1])
    ok = (o.get('type') == 'done' and o.get('from') == 'dev1'
          and o.get('to') == 'orch@session-other'
          and o.get('body') == '[ref:r1] summary one')
    print('ok' if ok else f'bad:{o}')
except Exception as e:
    print(f'unparsable:{e}')
EOF
)
check "⑥ inbox 行信封 + ref 前缀" "ok" "$shape"

echo "----"
echo "pass=$PASS fail=$FAIL"
[ "$FAIL" -eq 0 ]
