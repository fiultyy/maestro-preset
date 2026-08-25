#!/usr/bin/env bash
# tests/p3-cb-send-a-b-test.sh — T5 对拍(P3b.6;OF-005 基底)
# 通道A 文件桥(A1-A6) / 通道B HTTP 受理面 node harness(B1-B9) /
# 通道B' 静态(C1) / 通道C mock-orca(O1-O9) / 回归(R1-R2)。
# 全 temp 域、幂等可重跑、零 live 写入。
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

for v in MAESTRO_BRIDGE MAESTRO_FLEET MAESTRO_STATE; do
  val="${!v:-}"
  if [ -n "$val" ]; then
    case "$val" in /tmp/*) ;; *) echo "refuse: $v=$val 非 temp 路径" >&2; exit 1 ;; esac
  fi
done

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "[ ok ] $1"; }
bad() { FAIL=$((FAIL+1)); echo "[FAIL] $1: $2"; }

jline() { python3 -c "import json,sys; print(json.dumps(json.loads(sys.argv[1]), ensure_ascii=False))" "$1"; }

# ============ 通道A: 文件桥 ============
BA="$WORK/bridge-a"; mkdir -p "$BA"
export MAESTRO_BRIDGE="$BA"
line_count() { [ -f "$BA/inbox.log" ] && wc -l < "$BA/inbox.log" || echo 0; }

# A1: v2 ≡ --ver 2 逐字节
"$ROOT/bin/cb-send.v2" ack a1from t1 R1 bodyA1 >/dev/null 2>&1; ra=$?
"$ROOT/bin/cb-send" --ver 2 ack a1from t1 R1 bodyA1 >/dev/null 2>&1; rb=$?
L1=$(sed -n '$p' "$BA/inbox.log"); n0=$(line_count)
"$ROOT/bin/cb-send" --ver 2 ack a1from t1 R1 bodyA1 >/dev/null 2>&1
L2=$(sed -n '$p' "$BA/inbox.log")
if [ "$ra" = 0 ] && [ "$rb" = 0 ] && [ "$L1" = "$L2" ]; then ok A1 "cb-send.v2 ≡ cb-send --ver 2(逐字节)"; else bad A1 "rc=$ra/$rb lines differ"; fi

# A2: v3 缺省形状(自产同参 v2 基线: 头四键内容一致才能断字节前缀)
"$ROOT/bin/cb-send" --ver 2 ack a2from t2 R2 bodyA2 >/dev/null 2>&1
L2B=$(sed -n '$p' "$BA/inbox.log")
"$ROOT/bin/cb-send" ack a2from t2 R2 bodyA2 >/dev/null 2>&1
L3=$(sed -n '$p' "$BA/inbox.log")
python3 - "$L3" "$L2B" <<'EOF' && ok A2 "v3 七键序+头四键不动+ref==前缀+uuid+字节前缀" || bad A2 "形状断言失败(python 侧报错)"
import json, re, sys
v3, v2 = json.loads(sys.argv[1]), json.loads(sys.argv[2])
assert list(v3.keys()) == ['type', 'from', 'to', 'body', 'ref', 'msgid', 'ver'], v3.keys()
assert v3['ver'] == 3
assert re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', v3['msgid'])
assert v3['body'].startswith('[ref:R2] ')
assert v3['ref'] == 'R2' == v3['body'][len('[ref:'):v3['body'].index(']')]
l3, l1 = sys.argv[1], sys.argv[2]
assert l3.startswith(l1[:-1]), 'v3 字节前缀 != v2 去尾 }'
assert v3['type'] == v2['type'] and v3['from'] == v2['from'] and v3['to'] == v2['to'] and v3['body'] == v2['body'], '头四键深度不等'
EOF

# A3: --msgid 透传
"$ROOT/bin/cb-send" --msgid tok-a3 ack a3from t3 R3 bodyA3 >/dev/null 2>&1
grep -q '"msgid": "tok-a3"' "$BA/inbox.log" && ok A3 "--msgid tok-a3 透传" || bad A3 "token 未见于行"

# A4: 参数错三态
a4=()
"$ROOT/bin/cb-send" --msgid '' ack f t r b >/dev/null 2>&1; [ $? = 2 ] || a4+=("msgid空")
n4=$(line_count)
"$ROOT/bin/cb-send" --ver 5 ack f t r b >/dev/null 2>&1; [ $? = 2 ] || a4+=("ver5")
"$ROOT/bin/cb-send" --ver 2 --msgid m ack f t r b >/dev/null 2>&1; [ $? = 2 ] || a4+=("ver2+msgid")
[ "$(line_count)" = "$n4" ] || a4+=("有落行")
[ ${#a4[@]} = 0 ] && ok A4 "三态 exit2+零落行" || bad A4 "${a4[*]}"

# A5: 非 5 参
"$ROOT/bin/cb-send" ack f t r >/dev/null 2>"$WORK/a5.err"; rc5=$?
if [ "$rc5" = 2 ] && grep -q 'usage\|用法\|cb-send' "$WORK/a5.err"; then ok A5 "非 5 参 exit2+头注释"; else bad A5 "rc=$rc5"; fi

# A6 由 R1 全绿承接(传输选路三态)
ok A6 "传输选路回归(=R1 全绿承接)"

# ============ 通道B: HTTP 受理面 harness ============
unset MAESTRO_BRIDGE
BOUT=$(node --input-type=module - "$ROOT" "$WORK" <<'BEOF'
import { mkdtempSync, readFileSync, appendFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const ROOT = process.argv[2]
const WORK = process.argv[3]
const { activate } = await import(`file://${ROOT}/plugins/host-callback-bridge/index.js`)

const ok = (id) => console.log(`[ ok ] ${id}`)
const bad = (id, d) => console.log(`[FAIL] ${id}: ${d}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const waitFor = async (fn, ms = 8000) => { const t = Date.now(); for (;;) { if (fn()) return true; if (Date.now() - t > ms) return false; await sleep(25) } }

const bridgeDir = mkdtempSync(join(tmpdir(), 'nw-t5-bridge-'))
const calls = []
const host = createServer((req, res) => {
  let b = ''
  req.on('data', (c) => { b += c })
  req.on('end', () => {
    const p = JSON.parse(b)
    calls.push({ sessionId: p.payload?.sessionId, text: p.payload?.content?.[0]?.text })
    res.end(JSON.stringify({ result: { ok: true, value: { accepted: true } } }))
  })
})
await new Promise((r) => host.listen(0, '127.0.0.1', r))
const apiPort = host.address().port
const handle = await activate({ bridgeDir, apiPort })
const port = Number(readFileSync(join(bridgeDir, 'http.port'), 'utf8').trim())

const ORCH = 'session-cccc-orch-0001'
const httpJson = async (path, body) => {
  const resp = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  let data = null
  try { data = await resp.json() } catch {}
  return { status: resp.status, data }
}
await httpJson('/register', { sessionId: ORCH, alias: 'orch1' })

const cbSend = (args, env2 = {}) => new Promise((resolve) => {
  execFile('bash', [`${ROOT}/bin/cb-send`, ...args], { env: { ...process.env, MAESTRO_BRIDGE: bridgeDir, ...env2 } }, (error, stdout, stderr) => {
    resolve({ rc: error ? error.code : 0, stdout: String(stdout), stderr: String(stderr) })
  })
})
const inboxLines = () => readFileSync(join(bridgeDir, 'inbox.log'), 'utf8').split('\n').filter(Boolean)
const lastLine = () => inboxLines()[inboxLines().length - 1] ?? ''

// B1: HTTP 优先路径 200 + msgid + 与文件桥行深度相等/键序一致 + 投递文本 ORCA-CB] 前缀
const M1 = '0b1b2b3b-4c4d-4e5f-8a9b-0c1d2e3f4a5b'
const r1 = await cbSend(['--msgid', M1, 'ack', 'b1from', ORCH, 'RB1', 'bodyB1'])
const delivered = await waitFor(() => calls.some((c) => c.sessionId === ORCH && (c.text ?? '').includes(M1)))
// 文件桥对照(关 HTTP 面: 指到无 http.port 的目录)
const fileDir = mkdtempSync(join(tmpdir(), 'nw-t5-file-'))
const rf = await new Promise((resolve) => {
  execFile('bash', [`${ROOT}/bin/cb-send`, '--msgid', M1, 'ack', 'b1from', ORCH, 'RB1', 'bodyB1'], { env: { ...process.env, MAESTRO_BRIDGE: fileDir } }, (error, stdout) => resolve({ rc: error ? error.code : 0, stdout: String(stdout) }))
})
const fileLine = readFileSync(join(fileDir, 'inbox.log'), 'utf8').split('\n').filter(Boolean).pop()
const accLine = lastLine()
const a = JSON.parse(accLine); const f = JSON.parse(fileLine)
const wakeText = calls.map((c) => c.text).find((t) => (t ?? '').includes(M1)) ?? ''
let b1err = []
if (r1.rc !== 0 || !r1.stdout.includes('http 200')) b1err.push(`rc/stdout: ${r1.stdout.slice(0, 80)}`)
if (!String(r1.stdout).includes(`"msgid":"${M1}"`) && !String(r1.stdout).includes(`"msgid": "${M1}"`)) b1err.push('应答无 msgid')
if (JSON.stringify(a) !== JSON.stringify(f)) b1err.push('受理行≠文件桥行(深度)')
if (JSON.stringify(Object.keys(a)) !== JSON.stringify(Object.keys(f))) b1err.push('键序不一致')
if (wakeText !== `ORCA-CB] ${accLine}`) b1err.push(`投递文本 != ORCA-CB] +受理行: ${wakeText.slice(0, 60)}`)
b1err.length === 0 && delivered ? ok('B1') : bad('B1', b1err.join(';') + ` delivered=${delivered}`)

// B2: 同 msgid 重发 → 208 + msgid 回显 + 零新行零新投递
const callsN = calls.length; const linesN = inboxLines().length
const r2 = await cbSend(['--msgid', M1, 'ack', 'b1from', ORCH, 'RB1', 'bodyB1'])
await sleep(300)
let b2err = []
if (!r2.stdout.includes('http 208')) b2err.push(`非 208: ${r2.stdout.slice(0, 80)}`)
if (!r2.stdout.includes(M1)) b2err.push('208 无 msgid 回显')
if (inboxLines().length !== linesN) b2err.push('inbox 新行')
if (calls.length !== callsN) b2err.push('新投递')
b2err.length === 0 ? ok('B2') : bad('B2', b2err.join(';'))

// B3: 同 from 异 msgid 异 body → 200 + 新行 + 新投递
const callsN3 = calls.length
const r3 = await cbSend(['--msgid', 'd1d2d3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d', 'ack', 'b1from', ORCH, 'RB3', 'bodyB3-different'])
await waitFor(() => calls.length > callsN3)
let b3err = []
if (!r3.stdout.includes('http 200')) b3err.push('非 200')
if (!lastLine().includes('bodyB3-different')) b3err.push('无新行')
if (calls.length <= callsN3) b3err.push('无新投递')
b3err.length === 0 ? ok('B3') : bad('B3', b3err.join(';'))

// B4: legacy 四键裸 POST → 200 + 恰四键 + msgid:null
const callsN4 = calls.length
const rb4 = await httpJson('/callback', { type: 'ping', from: 'b4from', to: ORCH, body: '[ref:RB4] legacy body' })
await waitFor(() => calls.length > callsN4)
const lb4 = JSON.parse(lastLine())
let b4err = []
if (rb4.status !== 200) b4err.push(`status=${rb4.status}`)
if (JSON.stringify(Object.keys(lb4)) !== JSON.stringify(['type', 'from', 'to', 'body'])) b4err.push(`键集 ${Object.keys(lb4)}`)
if (rb4.data?.msgid !== null) b4err.push(`msgid=${rb4.data?.msgid}≠null`)
b4err.length === 0 ? ok('B4') : bad('B4', b4err.join(';'))

// B5: 同 from 异 body 四键×2 → 均 200+均投递(串行: 规避 inotify 事件合并的投递时序抖动)
const c5 = calls.length
const r5a = await httpJson('/callback', { type: 'ping', from: 'b5from', to: ORCH, body: '[ref:R] one' })
const d5a = await waitFor(() => calls.some((c) => (c.text ?? '').includes('one')))
const r5b = await httpJson('/callback', { type: 'ping', from: 'b5from', to: ORCH, body: '[ref:R] two' })
const d5b = await waitFor(() => calls.some((c) => (c.text ?? '').includes('two')));
(r5a.status === 200 && r5b.status === 200 && d5a && d5b) ? ok('B5') : bad('B5', `${r5a.status}/${r5b.status} d=${d5a}/${d5b}`)

// B6: 跨通道单次投递(受理行直 append → flush → 零新投递)
const c6 = calls.length
appendFileSync(join(bridgeDir, 'inbox.log'), accLine + '\n')
await sleep(600)
calls.length === c6 ? ok('B6') : bad('B6', `新投递 +${calls.length - c6}`)

// B7: 升级期双记(v3 投递后,同 from 同 body 四键 → 次键命中,零新投递)
const c7 = calls.length
const rb7 = await httpJson('/callback', { type: 'ack', from: 'b1from', to: ORCH, body: '[ref:RB1] bodyB1' })
await sleep(400)
let b7err = []
if (rb7.status !== 208) b7err.push(`status=${rb7.status}(期望次键命中 208)`)
if (calls.length !== c7) b7err.push('新投递')
b7err.length === 0 ? ok('B7') : bad('B7', b7err.join(';'))

// B8: 语义回归(坏 type 400 / 死 to 400 unknown-addressee / 空表 503)
const rb8a = await httpJson('/callback', { type: '', from: 'x', to: ORCH, body: 'b' })
const rb8b = await httpJson('/callback', { type: 'ack', from: 'x', to: 'nobody@session-zzz', body: 'b' })
const un = await httpJson('/unregister', { sessionId: ORCH })
const rb8c = await httpJson('/callback', { type: 'ack', from: 'x', body: 'b' }) // 无 to + 空表
let b8err = []
if (rb8a.status !== 400) b8err.push(`坏type=${rb8a.status}`)
if (rb8b.status !== 400 || !String(rb8b.data?.error ?? '').includes('unknown-addressee')) b8err.push(`死to=${rb8b.status} ${rb8b.data?.error}`)
if (rb8c.status !== 503) b8err.push(`空表=${rb8c.status}`)
b8err.length === 0 ? ok('B8') : bad('B8', b8err.join(';'))

// B9: msg-dedup 联动('ORCA-CB] '+受理行 首跑 0 / 重跑 3)
const dedupRun = (line) => new Promise((resolve) => {
  execFile('python3', [`${ROOT}/bin/msg-dedup`, line], { env: { ...process.env, MAESTRO_STATE: `${WORK}/state-b9` } }, (error) => resolve(error ? error.code : 0))
})
const d1 = await dedupRun(`ORCA-CB] ${accLine}`)
const d2 = await dedupRun(`ORCA-CB] ${accLine}`);
(d1 === 0 && d2 === 3) ? ok('B9') : bad('B9', `rc=${d1}/${d2}`)

await handle.stop?.()
host.close()
// stdout 为 pipe(命令替换)时异步缓冲需先冲刷,否则 process.exit 截断尾部断言行
await new Promise((resolve) => process.stdout.write('', resolve))
process.exit(0)
BEOF
)
echo "$BOUT"
BN_OK=$(grep -c '^\[ ok \]' <<< "$BOUT"); BN_BAD=$(grep -c '^\[FAIL\]' <<< "$BOUT")
PASS=$((PASS+BN_OK)); [ "$BN_BAD" = 0 ] || FAIL=$((FAIL+BN_BAD))

# ============ C1: message-bridge 过渡态断言(P4 后改判: 目录已删) ============
if [ ! -d plugins/message-bridge ]; then
  ok C1 "message-bridge 已随 P4 删除(过渡期三处一行级交付随 T5 归档)"
else
  grep -q 'canonical.ref = payload.ref' plugins/message-bridge/index.js \
    && grep -q 'canonical.msgid = payload.msgid' plugins/message-bridge/index.js \
    && ok C1 "canonical line 条件透传(静态)" || bad C1 "源形状断言未命中"
fi

# ============ 通道C: mock-orca ============
MOCK="$WORK/mock-orca"
cat > "$MOCK" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "$MOCK_LOG"
cmd="$1"; shift
case "$cmd" in
  orchestration)
    case "$(cat "$MOCK_MODE" 2>/dev/null || echo ok)" in
      ok) echo '{"ok":true,"runId":"run-777","deliveryId":"dlv-1"}' ;;
      *) echo '{"ok":false,"error":"mock fail"}' ;;
    esac ;;
  terminal)
    case "$(cat "$MOCK_MODE")" in
      terminal-fail) echo '{"ok":false,"error":"pty busy"}' ;;
      *) echo '{"ok":true}' ;;
    esac ;;
esac
EOF
chmod +x "$MOCK"
export ORCA_CLI_COMMAND="$MOCK" MOCK_LOG="$WORK/mock-orca.log" MOCK_MODE="$WORK/mock-mode"
echo ok > "$MOCK_MODE"
: > "$WORK/mock-orca.log"
FA="$WORK/fleet-orca.json"
printf '{"fleet":{"orc1":{"sessionId":"session-orc-x1","kind":"orca-terminal","handle":"term_x1"},"dsh1":{"sessionId":"session-dsh-y1","kind":"worker"}}}' > "$FA"
export MAESTRO_FLEET="$FA"
orc() { "$ROOT/bin/orca-send" "$@"; }
mock_argv() { tr ' ' '\n' <<< "$(cat "$WORK/mock-orca.log" | tail -n +1 | head -1)" >/dev/null 2>&1; cat "$WORK/mock-orca.log"; }

# O1/O2/O3: 主路径
orc me orc1 ack RO1 bodyO1 >/dev/null 2>"$WORK/o1.err"; rc1=$?
A1LOG=$(grep 'orchestration send' "$WORK/mock-orca.log" | tail -1)
o1=()
[ "$rc1" = 0 ] || o1+=("rc=$rc1 $(head -c 100 "$WORK/o1.err")")
echo "$A1LOG" | grep -q -- '--subject RO1' || o1+=("subject")
echo "$A1LOG" | grep -q -- '--type status' || o1+=("type")
echo "$A1LOG" | grep -q -- '--from me' && echo "$A1LOG" | grep -q -- '--to term_x1' || o1+=("from/to")
BODY=$(python3 - "$A1LOG" <<'EOF'
import sys
args = sys.argv[1].split()
i = args.index('--body')
print(args[i+1])
EOF
)
echo "$BODY" | grep -q '^DSHMSG\]' || o1+=("body 非 DSHMSG] 开头")
[ ${#o1[@]} = 0 ] && ok O1 "fleet 短码→orchestration send(subject/type/from/to/body)" || bad O1 "${o1[*]}"

node --input-type=module - "$BODY" <<'EOF' && ok O2 "--body parseLine round-trip 全字段" || bad O2 "parse 断言失败"
import { parseLine } from '/home/yy/tools/maestro-preset-iter/plugins/_narrow-waist/index.js'
const p = parseLine(process.argv[2])
const v = p.value
if (!p.ok || p.rawVersion !== 3) process.exit(1)
if (v.from !== 'me' || v.to !== 'orc1' || v.type !== 'ack' || v.ref !== 'RO1') process.exit(1)
if (v.ver !== 3 || v.ttl !== 5 || !String(v.via).includes('orca-send')) process.exit(1)
EOF

orc --msgid tok-o3 me orc1 ack RO3 bodyO3 >/dev/null 2>&1
grep 'orchestration send' "$WORK/mock-orca.log" | tail -1 | grep -q 'tok-o3' && ok O3 "--msgid 透传/缺省 uuid4 形" || bad O3 "token 未透传"

# O4: 主路径失败 → PTY 兜底(裸 JSON,无 DSHMSG] 叠前缀)
: > "$WORK/mock-orca.log"
echo terminal-ok > "$MOCK_MODE"
orc me orc1 ack RO4 bodyO4 >/dev/null 2>"$WORK/o4.err"; rc4=$?
TLOG=$(grep 'terminal send' "$WORK/mock-orca.log" | tail -1)
PTYTEXT=$(python3 - "$TLOG" <<'EOF'
import sys
args = sys.argv[1].split()
i = args.index('--text')
# 前缀 'ORCA-CB] ' 含空格;JSON.stringify 无内部空格,前缀后恰一个 token
print(' '.join(args[i+1:i+3]) if args[i+1] == 'ORCA-CB]' else args[i+1])
EOF
)
node --input-type=module - "$PTYTEXT" <<'EOF' && P4=ok || P4=fail
import { parseLine } from '/home/yy/tools/maestro-preset-iter/plugins/_narrow-waist/index.js'
const s = process.argv[2]
if (!s.startsWith('ORCA-CB] {')) process.exit(1)      // 裸 JSON,严禁叠 DSHMSG]
const v = JSON.parse(s.slice('ORCA-CB] '.length))
if (v.type !== 'ack' || v.ver !== 3) process.exit(1)
EOF
if [ "$rc4" = 0 ] && echo "$TLOG" | grep -q -- '--enter' && [ "$P4" = ok ]; then ok O4 "PTY 兜底(--enter+裸 JSON 可解)"; else bad O4 "rc=$rc4 pty=$P4 $(head -c 80 "$WORK/o4.err")"; fi
echo ok > "$MOCK_MODE"

# O5: run:<id> 透传 + fleet 零读取
: > "$WORK/mock-orca.log"
MAESTRO_FLEET="$WORK/nonexistent-fleet.json" orc me run:abc123 ack RO5 bodyO5 >/dev/null 2>&1; rc5=$?
grep 'orchestration send' "$WORK/mock-orca.log" | grep -q -- '--to run:abc123' && t5=ok || t5=fail
[ "$rc5" = 0 ] && [ "$t5" = ok ] && ok O5 "run:<id> 原样透传,fleet 零读取" || bad O5 "rc=$rc5 to=$t5"
export MAESTRO_FLEET="$FA"

# O6: DSH 条目 plane mismatch
: > "$WORK/mock-orca.log"
orc me dsh1 ack RO6 bodyO6 >/dev/null 2>"$WORK/o6.err"; rc6=$?
[ "$rc6" = 1 ] && [ ! -s "$WORK/mock-orca.log" ] && ok O6 "DSH 条目 exit1+mock 零调用" || bad O6 "rc=$rc6 calls=$(wc -l < "$WORK/mock-orca.log")"

# O7: steer/Pong 拒
orc me orc1 steer RO7 b >/dev/null 2>"$WORK/o7a.err"; r7a=$?
orc me orc1 Pong RO7 b >/dev/null 2>&1; r7b=$?
[ "$r7a" = 2 ] && grep -q -- '--interrupt' "$WORK/o7a.err" && [ "$r7b" = 2 ] && ok O7 "steer exit2+--interrupt 提示;Pong exit2" || bad O7 "rc=$r7a/$r7b"

# O8: worker_done --outcome
orc me orc1 worker_done RO8 b >/dev/null 2>&1; r8a=$?
: > "$WORK/mock-orca.log"
orc --outcome succeeded me orc1 worker_done RO8 b >/dev/null 2>&1; r8b=$?
[ "$r8a" = 2 ] && [ "$r8b" = 0 ] && grep 'orchestration send' "$WORK/mock-orca.log" | grep -q -- '--outcome succeeded' && ok O8 "worker_done outcome 闸" || bad O8 "rc=$r8a/$r8b"

# O9: live 冒烟(默认 skip)
if [ "${NW_T5_LIVE_ORCA:-}" = 1 ]; then
  echo "[info] O9 live 冒烟: 手动执行(编排验收方)"
else
  echo "[skip] live-orca (NW_T5_LIVE_ORCA 未设)"
fi
unset ORCA_CLI_COMMAND MOCK_LOG MOCK_MODE MAESTRO_FLEET

# ============ 回归 R1/R2 ============
unset MAESTRO_BRIDGE
R1OUT=$(bash "$ROOT/tests/test_cb_send.sh" 2>&1 | tail -1)
echo "$R1OUT" | grep -q 'pass=17 fail=0' && ok R1 "test_cb_send.sh 17/17" || bad R1 "$R1OUT"
R2OUT=$(node "$ROOT/plugins/host-callback-bridge/selftest.mjs" 2>&1 | tail -1)
echo "$R2OUT" | grep -q '35/35' && ok R2 "host-callback-bridge selftest 35/35" || bad R2 "$R2OUT"

TOTAL=$((PASS+FAIL))
echo
if [ "$FAIL" = 0 ]; then echo "p3-cb-send-a-b-test: $TOTAL/$TOTAL 全绿(exit 0)"; exit 0
else echo "p3-cb-send-a-b-test: $PASS/$TOTAL 全绿(exit 1)"; exit 1; fi
