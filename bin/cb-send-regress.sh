#!/usr/bin/env bash
# cb-send-regress — cb-send IDX-5 韧性链路回归(hermetic: 临时桥目录 + 假 HTTP 面,
# 零真实桥触碰)。覆盖:
#   R1  4xx 拒收 → 精确 CB_RETRY_MAX 次尝试 → stall.log 全息档案(十一键)+
#       大写 stderr + 文件桥兜底投递,exit 0(绝不静默、绝不弃件)
#   R2  CB_RETRY_MAX=1 → 恰 1 次尝试(次数精确受控)
#   R3  200 成功 → 零重试零 stall
#   R4  无端口(000 不可达)→ 零 stall 照旧文件桥降级(非拒收语义)
# 用法: cb-send-regress   (依赖: python3, cb-send 同款)
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
CB="$HERE/cb-send"
pass=0; total=0; failures=()
check() { # <name> <ok:0|1> [detail]
  total=$((total+1))
  if [ "$2" = 0 ]; then pass=$((pass+1)); echo "  [ ok ] $1"
  else echo "  [FAIL] $1 ${3:-}"; failures+=("$1"); fi
}

WORK="$(mktemp -d)"
SRV_PID=""
cleanup() { [ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT

# 假桥面: /callback 按 code 文件应答;命中数落 hits(锁内读-改-写)
cat > "$WORK/server.py" <<'PY'
import http.server, json, os, sys, threading
work = sys.argv[1]
hits = os.path.join(work, 'hits')
code_f = os.path.join(work, 'code')
lock = threading.Lock()
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers.get('content-length', 0)))
        with lock:
            try:
                n = int(open(hits).read().strip() or '0')
            except Exception:
                n = 0
            open(hits, 'w').write(str(n + 1))
        try:
            code = int(open(code_f).read().strip())
        except Exception:
            code = 400
        body = (json.dumps({"error": "fake-reject"}).encode() if code >= 400
                else json.dumps({"result": {"status": "accepted"}}).encode())
        self.send_response(code)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a):
        pass
srv = http.server.HTTPServer(('127.0.0.1', 0), H)
open(os.path.join(work, 'port'), 'w').write(str(srv.server_address[1]))
srv.serve_forever()
PY
python3 "$WORK/server.py" "$WORK" & SRV_PID=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do [ -f "$WORK/port" ] && break; sleep 0.2; done
PORT="$(cat "$WORK/port")"

new_bridge() { # <dir>: http.port 指向假面;清 hits
  mkdir -p "$1"; printf '%s\n' "$PORT" > "$1/http.port"; printf '0' > "$WORK/hits"
}

# ---------- R1: 400 拒收 ×2 次尝试 → stall.log + 文件桥兜底, exit 0 ----------
B1="$WORK/bridge-r1"; new_bridge "$B1"; printf '400' > "$WORK/code"
out="$(MAESTRO_BRIDGE="$B1" CB_RETRY_MAX=2 CB_RETRY_DELAY_S=0 \
  "$CB" done w1 'orch@session-x' IDX5R1 '结果摘要' 2>"$WORK/err")"; rc=$?
check "r1:exit-0-file-fallback" "$([ "$rc" = 0 ] && echo 0 || echo 1)" "rc=$rc out=$out"
check "r1:exact-retry-count" "$([ "$(cat "$WORK/hits")" = 2 ] && echo 0 || echo 1)" "hits=$(cat "$WORK/hits")"
check "r1:inbox-exactly-one-line" "$([ "$(wc -l < "$B1/inbox.log" 2>/dev/null || echo 0)" = 1 ] && echo 0 || echo 1)" "lines=$(wc -l < "$B1/inbox.log" 2>/dev/null || echo 0)"
check "r1:stall-log-exists" "$([ -f "$B1/stall.log" ] && echo 0 || echo 1)"
check "r1:stall-log-single-line" "$([ "$(wc -l < "$B1/stall.log")" = 1 ] && echo 0 || echo 1)"
python3 - "$B1/stall.log" <<'PY' && stall_rc=0 || stall_rc=1
import json, sys
lines = open(sys.argv[1]).read().strip().split('\n')
d = json.loads(lines[-1])
assert sorted(d) == ["at", "deliveredVia", "envelope", "from", "lastHttpBody",
                     "lastHttpCode", "msgid", "ref", "to", "type", "ver"], sorted(d)
assert d["lastHttpCode"] == 400 and "fake-reject" in d["lastHttpBody"]
assert d["type"] == "done" and d["from"] == "w1"
assert d["to"] == "orch@session-x" and d["ref"] == "IDX5R1"
assert d["msgid"] not in ("", "-", None), d["msgid"]          # v3 缺省 uuid 从信封提取
assert d["ver"] == 3 and d["deliveredVia"] == "file-bridge"
assert d["envelope"]["body"] == "[ref:IDX5R1] 结果摘要"
PY
check "r1:stall-record-holographic" "$stall_rc"
grep -q "CB-SEND:.*TERMINALLY REJECTED (400)" "$WORK/err" && u_rc=0 || u_rc=1
check "r1:uppercase-terminal-warning" "$u_rc" "$(cat "$WORK/err")"
grep -q "retrying in 0s" "$WORK/err" && r_rc=0 || r_rc=1
check "r1:retry-note-in-stderr" "$r_rc"

# ---------- R2: CB_RETRY_MAX=1 → 恰 1 次 ----------
B2="$WORK/bridge-r2"; new_bridge "$B2"; printf '500' > "$WORK/code"
MAESTRO_BRIDGE="$B2" CB_RETRY_MAX=1 CB_RETRY_DELAY_S=0 \
  "$CB" ack w2 'orch@session-y' IDX5R2 'x' >/dev/null 2>&1; rc=$?
check "r2:max-1-single-attempt" "$([ "$(cat "$WORK/hits")" = 1 ] && echo 0 || echo 1)" "hits=$(cat "$WORK/hits")"
check "r2:stall-recorded-500" "$([ -f "$B2/stall.log" ] && grep -q '"lastHttpCode": *500\|"lastHttpCode":500' "$B2/stall.log" && echo 0 || echo 1)"

# ---------- R3: 200 成功 → 零重试零 stall ----------
B3="$WORK/bridge-r3"; new_bridge "$B3"; printf '200' > "$WORK/code"
out="$(MAESTRO_BRIDGE="$B3" CB_RETRY_MAX=3 CB_RETRY_DELAY_S=0 \
  "$CB" ping w3 'orch@session-z' IDX5R3 'x' 2>"$WORK/err3")"; rc=$?
check "r3:exit-0-http-200" "$([ "$rc" = 0 ] && grep -q "cb-send: http 200" <<<"$out" && echo 0 || echo 1)" "rc=$rc out=$out"
check "r3:single-attempt" "$([ "$(cat "$WORK/hits")" = 1 ] && echo 0 || echo 1)" "hits=$(cat "$WORK/hits")"
check "r3:no-stall-on-success" "$([ ! -f "$B3/stall.log" ] && echo 0 || echo 1)"

# ---------- R4: 无端口(不可达)→ 零 stall 照旧降级 ----------
B4="$WORK/bridge-r4"; mkdir -p "$B4"   # 无 http.port
out="$(MAESTRO_BRIDGE="$B4" CB_RETRY_MAX=3 CB_RETRY_DELAY_S=0 \
  "$CB" ping w4 'orch@session-w' IDX5R4 'x' 2>"$WORK/err4")"; rc=$?
check "r4:exit-0-file-fallback" "$([ "$rc" = 0 ] && grep -q "file-bridge appended" <<<"$out" && echo 0 || echo 1)" "rc=$rc out=$out"
check "r4:no-stall-on-unreachable" "$([ ! -f "$B4/stall.log" ] && echo 0 || echo 1)" "$(cat "$B4/stall.log" 2>/dev/null)"
# (无端口面历史上就不打印 falling back 行——守卫 if 直接跳过 HTTP 块,行为不变)

echo "cb-send-regress: $pass/$total passed"
[ "$pass" = "$total" ]
