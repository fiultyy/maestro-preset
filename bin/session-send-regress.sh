#!/usr/bin/env bash
# session-send-regress — session-send/session-send-v3 既有调用流最小回归(IDX-2 验收)
#
# 全密封: DSH_PORT 指向本脚本自起的假 loopback(接受任意 /api/session.prompt 返
# ok/accepted=true),MAESTRO_FLEET 指向临时 fleet.json——零真会话、零真投递。
# 断言: ①两工具既有 happy path 照发(exit 0 + accepted=True 行);
#       ②from 冒用(指向别席)→ stderr 大写 WARN + 照发不阻断(exit 0);
#       ③from 本席 → 零 WARN;
#       ④成功行注明 resolved-session;
#       ⑤stderr 前缀契约 `session-send:` 保持(R-S29 上层 grep 依赖)。
# 用法: session-send-regress [--selftest-only]   # 后者只跑纯自测,不起假服务
set -u
PASS=0; FAIL=0
ok(){ if [ "$1" = 0 ]; then PASS=$((PASS+1)); echo "PASS $2"; else FAIL=$((FAIL+1)); echo "FAIL $2"; fi }
HERE="$(cd "$(dirname "$0")" && pwd)"

python3 "$HERE/session-send" --selftest >/dev/null 2>&1; ok $? "se: session-send --selftest green"

[ "${1:-}" = "--selftest-only" ] && { echo "regress: $PASS pass / $FAIL fail (selftest-only)"; exit $([ "$FAIL" = 0 ] && echo 0 || echo 1); }

TMP="$(mktemp -d /tmp/ss-regress-XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/fleet.json" <<'EOF'
{"fleet": {
  "orcx": {"sessionId": "session-orcxaaaa-0000-0000-0000-000000000001"},
  "w9":   {"sessionId": "session-w9bbbb-0000-0000-0000-000000000002"}}}
EOF

# 假 loopback: 记 method 进 journal,恒返 {"result":{"ok":true,"value":{"accepted":true}}}
cat > "$TMP/fake-dsh.py" <<'EOF'
import json, http.server
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get('content-length', 0))
        body = self.rfile.read(n)
        with open(self.server.journal, 'ab') as fh:
            fh.write(body + b'\n')
        resp = json.dumps({'result': {'ok': True, 'value': {'accepted': True}}}).encode()
        self.send_response(200)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(resp)))
        self.end_headers()
        self.wfile.write(resp)
    def log_message(self, *a): pass
import sys
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), H)
srv.journal = sys.argv[1]
print(srv.server_address[1], flush=True)
srv.serve_forever()
EOF
python3 "$TMP/fake-dsh.py" "$TMP/journal.jsonl" > "$TMP/port.txt" 2>/dev/null &
FAKE_PID=$!
trap 'kill $FAKE_PID 2>/dev/null; rm -rf "$TMP"' EXIT
for i in $(seq 50); do [ -s "$TMP/port.txt" ] && break; sleep 0.1; done
PORT="$(cat "$TMP/port.txt")"
export MAESTRO_FLEET="$TMP/fleet.json" DSH_PORT="$PORT"

# ① 既有 happy path(python 版): orcx -> w9 steer,冒用告警同时照发不阻断
OUT="$(DSH_SESSION_ID=session-OTHERsid "$HERE/session-send" orcx w9 steer T-1 "regress body" 2>"$TMP/err1")"; RC=$?
echo "$OUT" | grep -q "accepted=True" && [ $RC -eq 0 ]; ok $? "se: spoofed-from send still delivers (exit 0 + accepted=True)"
grep -q "SESSION-SEND: FROM IDENTITY MISMATCH" "$TMP/err1" && grep -q "session-orcxaaaa" "$TMP/err1" && grep -q "session-OTHERsid" "$TMP/err1"; ok $? "se: spoofed-from uppercase MISMATCH WARN on stderr"
echo "$OUT" | grep -q "resolved-session=session-orcxaa"; ok $? "se: success line notes resolved-session"

# ③ from 本席 → 零 WARN
OUT="$(DSH_SESSION_ID=session-orcxaaaa-0000-0000-0000-000000000001 "$HERE/session-send" orcx w9 ping T-2 "self ok" 2>"$TMP/err2")"; RC=$?
echo "$OUT" | grep -q "accepted=True" && [ $RC -eq 0 ] && ! [ -s "$TMP/err2" ]; ok $? "se: self-from sends clean (no WARN, exit 0)"

# ⑤ stderr 前缀契约: 错误路径仍以 session-send: 开头
OUT="$(DSH_SESSION_ID= "$HERE/session-send" orcx no-such-code ping T-3 x 2>"$TMP/err3")"; RC=$?
[ $RC -ne 0 ] && grep -q "^session-send:" "$TMP/err3"; ok $? "se: unknown-code error path unchanged (prefix + nonzero)"

# ①-④ v3 版: 冒用告警 + resolved-session 注记 + 照发
OUT="$(DSH_SESSION_ID=session-OTHERsid "$HERE/session-send-v3" w9 orcx done T-4 "v3 body" 2>"$TMP/err4")"; RC=$?
echo "$OUT" | grep -q "accepted=True" && [ $RC -eq 0 ]; ok $? "v3: spoofed-from send still delivers (exit 0 + accepted=True)"
grep -q "SESSION-SEND: FROM IDENTITY MISMATCH" "$TMP/err4"; ok $? "v3: spoofed-from uppercase MISMATCH WARN on stderr"
echo "$OUT" | grep -q "resolved-session=session-w9bbbb"; ok $? "v3: success line notes resolved-session"
head -c 200 "$TMP/journal.jsonl" | grep -q "session.prompt"; ok $? "se: requests hit the loopback session.prompt method"

echo "regress: $PASS pass / $FAIL fail"
[ "$FAIL" = 0 ]
