#!/usr/bin/env bash
# tests/p2-a-b-test.sh — P2 双跑对拍(spec P2.5;OF-005 模式)
#
# 旧路 = bin/session-send(P2_OLD_BIN 可覆盖);新路 = bin/session-send-v3。
# hermetic 层(stub 域): M01-M21 矩阵 + K1-K7 边界 + G1-G8 steer 闸。
# live 层(沙箱 :3081): L0 可达 / L1 错误契约;L2 需 P2_LIVE_SESSION。
# 全 temp 域、幂等可重跑、零生产外溢。
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OLD="${P2_OLD_BIN:-$ROOT/bin/session-send}"
NEW="$ROOT/bin/session-send-v3"
WORK="$(mktemp -d)"
trap 'kill "$STUB_PID" 2>/dev/null; rm -rf "$WORK"' EXIT

# env guard: 外部覆盖为非 temp 路径则拒跑(R-S31 零外溢风格)
for v in MAESTRO_FLEET MAESTRO_STATE; do
  val="${!v:-}"
  if [ -n "$val" ]; then
    case "$val" in
      /tmp/*) ;;
      *) echo "refuse: $v=$val 非 temp 路径(会触生产域)" >&2; exit 1 ;;
    esac
  fi
done
export MAESTRO_FLEET="$WORK/fleet.json"
export MAESTRO_STATE="$WORK/state"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "[ ok ] $1"; }
bad() { FAIL=$((FAIL+1)); echo "[FAIL] $1: $2"; }

# ---- stub(运行时生成;监听 127.0.0.1:0,记录 POST 全文) ----
cat > "$WORK/stub.mjs" <<'EOF'
import { createServer } from 'node:http'
import { appendFileSync, writeFileSync } from 'node:fs'
const s = createServer((req, res) => {
  let b = ''
  req.on('data', (c) => { b += c })
  req.on('end', () => {
    appendFileSync(process.env.STUB_WIRES, b + '\n')
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ result: { ok: true, value: { accepted: true } } }))
  })
})
s.listen(0, '127.0.0.1', () => { writeFileSync(process.env.STUB_PORT, String(s.address().port)) })
setTimeout(() => {}, 3600000)
EOF
export STUB_WIRES="$WORK/wires.jsonl" STUB_PORT="$WORK/stub.port"
: > "$STUB_WIRES"
node "$WORK/stub.mjs" >/dev/null 2>&1 &
STUB_PID=$!
for _ in $(seq 50); do [ -s "$STUB_PORT" ] && break; sleep 0.1; done
STUB_PORT_NUM="$(cat "$STUB_PORT")"
export DSH_PORT="$STUB_PORT_NUM"

# ---- fleet fixture ----
SID1='session-1111-aaaa-bbbb-cccc-000000000001'
SID2='session-2222-bbbb-cccc-dddd-000000000002'
base_fleet() {
  printf '{"fleet":{"1111":{"sessionId":"%s","kind":"worker"},"2222":{"sessionId":"%s","kind":"orca-terminal"}}}' "$SID1" "$SID2" > "$WORK/fleet.json"
}
base_fleet

run_old() { "$OLD" "$@"; }
run_new() { "$NEW" "$@"; }
wire_count() { [ -f "$STUB_WIRES" ] && wc -l < "$STUB_WIRES" || echo 0; }

# ---- M01-M21: 7 type × 3 to 形式 × 两路(比较器在收集后统一跑) ----
i=0
declare -a M_DESC=()
for typ in ping pong done ask nack ack report; do
  for to in 1111 2222 "$SID1"; do
    i=$((i+1))
    mo="m-old-$i"; mn="m-new-$i"
    body="矩阵 case $i"
    if [ "$i" = "$((i))" ] && [ $((i % 7)) -eq 3 ]; then body="矩阵 case $i 中文+emoji 🎉无人机"; fi
    run_old --msgid "$mo" me "$to" "$typ" r$i "$body" >/dev/null 2>"$WORK/mo-$i.err" || { bad "M$(printf %02d $i)" "旧路 rc≠0: $(cat "$WORK/mo-$i.err")"; continue; }
    run_new --msgid "$mn" me "$to" "$typ" r$i "$body" >/dev/null 2>"$WORK/mn-$i.err" || { bad "M$(printf %02d $i)" "新路 rc≠0: $(cat "$WORK/mn-$i.err")"; continue; }
    M_DESC[$i]="$typ|$to"
  done
done

# 比较器: P2.1 判据 1-3 + wire 形状(按 msgid 定位)
node --input-type=module - "$WORK" <<'EOF' > "$WORK/m-result.txt"
import { readFileSync } from 'node:fs'
const W = process.argv[2]
const wires = readFileSync(`${W}/wires.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
const byMsgid = new Map()
for (const w of wires) {
  const text = w?.payload?.content?.[0]?.text
  if (typeof text !== 'string' || !text.startsWith('DSHMSG]')) continue
  const v = JSON.parse(text.slice(7))
  byMsgid.set(v.msgid, { wire: w, value: v, keys: Object.keys(v) })
}
let pass = 0, fail = 0
for (let i = 1; i <= 21; i++) {
  const id = `M${String(i).padStart(2, '0')}`
  const a = byMsgid.get(`m-old-${i}`), b = byMsgid.get(`m-new-${i}`)
  const errs = []
  if (!a || !b) { errs.push('wire missing'); }
  else {
    const ta = a.wire.payload.content[0].text, tb = b.wire.payload.content[0].text
    if (!ta.startsWith('DSHMSG]') || !tb.startsWith('DSHMSG]')) errs.push('prefix!=DSHMSG]')
    const va = a.value, vb = b.value
    for (const k of ['from', 'to', 'type', 'ref', 'body']) if (va[k] !== vb[k]) errs.push(`field ${k}: ${JSON.stringify(va[k])} != ${JSON.stringify(vb[k])}`)
    if (va.msgid !== `m-old-${i}` || vb.msgid !== `m-new-${i}`) errs.push('msgid 注入不符')
    if (!Number.isInteger(va.ts) || !Number.isInteger(vb.ts) || Math.abs(va.ts - vb.ts) > 60_000) errs.push('ts 断言失败')
    if (JSON.stringify(a.keys.slice(0, 7)) !== JSON.stringify(['from','to','type','ref','body','msgid','ts'])) errs.push('旧侧键序错')
    if (JSON.stringify(b.keys.slice(0, 7)) !== JSON.stringify(['from','to','type','ref','body','msgid','ts'])) errs.push('新侧七键序错')
    if (vb.ver !== 3) errs.push('ver!==3')
    if (typeof vb.via !== 'string' || !vb.via.includes('session-send-v3')) errs.push('via 缺自身 id')
    if (!Number.isInteger(vb.ttl) || vb.ttl < 1) errs.push('ttl 非法')
    if (JSON.stringify(b.keys.slice(7)) !== JSON.stringify(['ver','via','ttl'])) errs.push('新三键非尾追')
    const sid = a.wire.payload.sessionId
    const expectSid = (va.to === '1111') ? 'session-1111-aaaa-bbbb-cccc-000000000001'
      : (va.to === '2222') ? 'session-2222-bbbb-cccc-dddd-000000000002' : va.to
    if (sid !== expectSid) errs.push(`payload.sessionId=${sid} expect=${expectSid}`)
    if (a.wire.payload.mode !== 'queue' || a.wire.method !== 'session.prompt') errs.push('wire 形状错')
    if (a.wire.payload.content.length !== 1 || a.wire.payload.content[0].type !== 'text') errs.push('content 形状错')
  }
  if (errs.length) { fail++; console.log(`F ${id}: ${errs.join('; ')}`) } else pass++
}
console.log(`MRESULT ${pass} ${fail}`)
EOF
read -r MPASS MFAIL <<< "$(grep -o 'MRESULT [0-9]* [0-9]*' "$WORK/m-result.txt" | tail -1 | awk '{print $2, $3}')"
while IFS= read -r line; do echo "[FAIL] ${line#F }"; done < <(grep '^F ' "$WORK/m-result.txt")
for _ in $(seq "$MPASS"); do PASS=$((PASS+1)); done
# M 系列各 case 一条 ok(汇总式;逐 case FAIL 已单列)
echo "[ ok ] M01-M21 矩阵对拍($MPASS/21)"

# ---- K1 键序全局 / K2 新三键 ----
if grep -q '键序错\|非尾追' "$WORK/m-result.txt"; then bad K1 "键序违例(见上)"; else ok K1 "全部记录行键序锁定(旧七/新十)"; fi
if grep -q 'ver!==3\|via 缺\|ttl 非法' "$WORK/m-result.txt"; then bad K2 "新三键断言违例"; else ok K2 "v3 新三键存在与类型(判据3)"; fi

# ---- K3 非 UTF-8 argv 边界 ----
B3="$(printf 'x\xffy')"
wc0=$(wire_count)
set +e
run_old --msgid k3o me 1111 ack r "a$B3" >/dev/null 2>"$WORK/k3o.err"; rc_old=$?
wco=$(wire_count)
run_new --msgid k3n me 1111 ack r "a$B3" >/dev/null 2>"$WORK/k3n.err"; rc_new=$?
true
wc1=$(wire_count)
k3_errs=()
[ "$rc_old" = 1 ] || k3_errs+=("旧 rc=$rc_old≠1")
grep -q 'UnicodeEncodeError' "$WORK/k3o.err" || k3_errs+=("旧 stderr 无 UnicodeEncodeError")
[ "$wco" = "$wc0" ] || k3_errs+=("旧路 stub 有新增($wc0→$wco)") # 旧路崩在 .encode(),零投递
[ "$wc1" = "$((wco+1))" ] || k3_errs+=("新路未投递($wco→$wc1)")   # 新路 rc0 投一条
if [ "$rc_new" = 0 ]; then
  node --input-type=module - "$WORK" <<'EOF'
import { readFileSync } from 'node:fs'
const ws = readFileSync(process.argv[2] + '/wires.jsonl', 'utf8').trim().split('\n')
const last = JSON.parse(ws[ws.length - 1])
const text = last.payload.content[0].text
const v = JSON.parse(text.slice(7))
if (!String(v.body).includes('\ufffd')) { console.log('NO-FFFD'); process.exit(1) }
EOF
  [ $? = 0 ] || k3_errs+=("新路 body 无 U+FFFD")
else
  k3_errs+=("新 rc=$rc_new≠0")
fi
[ ${#k3_errs[@]} = 0 ] && ok K3 "非 UTF-8 argv 不对称契约成立" || bad K3 "${k3_errs[*]}"

# ---- K4 4KB 边界 ----
BODY4="$(head -c 3800 /dev/zero | tr '\0' 'a')"
wc0=$(wire_count)
run_old --msgid k4o me 1111 ack r4 "$BODY4" >/dev/null 2>&1 && run_new --msgid k4n me 1111 ack r4 "$BODY4" >/dev/null 2>&1
node --input-type=module - "$WORK" <<'EOF'
import { readFileSync } from 'node:fs'
const ws = readFileSync(process.argv[2] + '/wires.jsonl', 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const find = (m) => ws.find((w) => w.payload.content[0].text.includes(`"${m}"`))
const a = JSON.parse(find('k4o').payload.content[0].text.slice(7))
const b = JSON.parse(find('k4n').payload.content[0].text.slice(7))
for (const k of ['from','to','type','ref','body']) if (a[k] !== b[k]) process.exit(1)
EOF
[ $? = 0 ] && ok K4 "4KB 边界(3800B body)七键深度相等" || bad K4 "七键不等或 rc≠0"

# ---- K5 unknown code ----
run_old me zzzz ack r x >/dev/null 2>"$WORK/k5o.err"; rco=$?
run_new me zzzz ack r x >/dev/null 2>"$WORK/k5n.err"; rcn=$?
if [ "$rco" = 1 ] && [ "$rcn" = 1 ] && grep -q "unknown code 'zzzz'" "$WORK/k5o.err" && grep -q "unknown code 'zzzz'" "$WORK/k5n.err"; then
  ok K5 "unknown code 双路 exit1+stderr 逐字"
else bad K5 "rc:$rco/$rcn"; fi

# ---- K6 参数错 exit 2 ----
k6_errs=()
for spec in "3:@:me 1111 ack" "1:--msgid:--msgid" "1:--via 空:--via" "1:--via 空段:--via"; do
  : # placeholder
done
set +e
"$OLD" me 1111 ack >/dev/null 2>&1; a=$?
"$NEW" me 1111 ack >/dev/null 2>&1; b=$?
[ "$a" = 2 ] && [ "$b" = 2 ] || k6_errs+=("argc≠5: $a/$b")
"$OLD" --msgid >/dev/null 2>&1; a=$?
"$NEW" --msgid >/dev/null 2>&1; b=$?
[ "$a" = 2 ] && [ "$b" = 2 ] || k6_errs+=("--msgid 缺值: $a/$b")
"$NEW" --via '' me 1111 ack r x >/dev/null 2>&1; a=$?
"$OLD" --via '' me 1111 ack r x >/dev/null 2>&1; b=$?
[ "$a" = 2 ] && [ "$b" = 2 ] || k6_errs+=("--via 空串: $a/$b")
"$NEW" --via 'a,,b' me 1111 ack r x >/dev/null 2>&1; a=$?
"$OLD" --via 'a,,b' me 1111 ack r x >/dev/null 2>&1; b=$?
[ "$a" = 2 ] && [ "$b" = 2 ] || k6_errs+=("--via 空段: $a/$b")
true
[ ${#k6_errs[@]} = 0 ] && ok K6 "参数错双路 exit2" || bad K6 "${k6_errs[*]}"

# ---- K7 收方兼容(msg-dedup 对 v3 行) ----
V3LINE=$(node --input-type=module - "$WORK" <<'EOF'
import { readFileSync } from 'node:fs'
const ws = readFileSync(process.argv[2] + '/wires.jsonl', 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const w = ws.reverse().find((x) => x.payload.content[0].text.includes('m-new-1"'))
console.log(w.payload.content[0].text)
EOF
)
"$ROOT/bin/msg-dedup" "$V3LINE" >/dev/null 2>&1; a=$?
"$ROOT/bin/msg-dedup" "$V3LINE" >/dev/null 2>&1; b=$?
[ "$a" = 0 ] && [ "$b" = 3 ] && ok K7 "msg-dedup 首见 0/重放 3" || bad K7 "rc=$a/$b"

# ---- G 系列: steer 闸(蓝本 = of002-selftest ②③⑤) ----
JOURNAL="$MAESTRO_STATE/steer-journal.jsonl"
CONFLICTS="$WORK/fleet-conflicts.jsonl"
jlines() { [ -f "$JOURNAL" ] && wc -l < "$JOURNAL" || echo 0; }
clines() { [ -f "$CONFLICTS" ] && wc -l < "$CONFLICTS" || echo 0; }

FUTURE=$(python3 -c 'from datetime import datetime,timezone,timedelta; print((datetime.now(timezone.utc)+timedelta(minutes=10)).isoformat())')
PAST=$(python3 -c 'from datetime import datetime,timezone,timedelta; print((datetime.now(timezone.utc)-timedelta(minutes=10)).isoformat())')

# G1 有效他人租约
printf '{"fleet":{"3333":{"sessionId":"session-3333-cccc-dddd-eeee-000000000003","kind":"worker","owner":"rival","leaseExpiresAt":"%s"}}}' "$FUTURE" > "$WORK/fleet.json"
wc0=$(wire_count); j0=$(jlines); c0=$(clines)
set +e
run_old --msgid g1-old me 3333 steer rG1 body >/dev/null 2>"$WORK/g1o.err"; ga=$?
run_new --msgid g1-new me 3333 steer rG1 body >/dev/null 2>"$WORK/g1n.err"; gb=$?
true
wc1=$(wire_count)
sed 's/g1-old/M/g' "$WORK/g1o.err" > "$WORK/g1o.n"; sed 's/g1-new/M/g' "$WORK/g1n.err" > "$WORK/g1n.n"
g1_errs=()
[ "$ga" = 4 ] && [ "$gb" = 4 ] || g1_errs+=("rc $ga/$gb≠4")
[ "$wc1" = "$wc0" ] || g1_errs+=("stub 有新增")
cmp -s "$WORK/g1o.n" "$WORK/g1n.n" || g1_errs+=("stderr 归一后不等")
[ ${#g1_errs[@]} = 0 ] && ok G1 "他人租约 steer 双路 exit4+stderr 逐字节(msgid 归一)" || bad G1 "${g1_errs[*]}"

# G2-G5 四放行 reason
g_reason() { # owner expires expected
  printf '{"fleet":{"3333":{"sessionId":"session-3333-cccc-dddd-eeee-000000000003","kind":"worker"%s%s}}}' \
    "${2:+,\"owner\":\"$1\"}" "${2:+,\"leaseExpiresAt\":\"$2\"}" > "$WORK/fleet.json"
  j0=$(jlines)
  run_old --msgid "$3-old" "$4" 3333 steer rG body >/dev/null 2>&1; ga=$?
  run_new --msgid "$3-new" "$4" 3333 steer rG body >/dev/null 2>&1; gb=$?
  [ "$ga" = 0 ] && [ "$gb" = 0 ] || { bad "$5" "rc $ga/$gb"; return; }
  [ "$(jlines)" = "$((j0+2))" ] || { bad "$5" "journal 行数 $(jlines)≠$((j0+2))"; return; }
  ok "$5" "reason=$6 双路 rc0+journal 各 1 行"
}
g_reason me "$FUTURE" g2 me G2 owner-self
g_reason '' '' g3 me G3 unowned
g_reason rival "$PAST" g4 me G4 lease-expired
# G5 no-entry: 直投完整 sessionId(find_entry 双 miss)
j0=$(jlines)
run_old --msgid g5-old me "$SID2" steer rG body >/dev/null 2>&1; ga=$?
run_new --msgid g5-new me "$SID2" steer rG body >/dev/null 2>&1; gb=$?
if [ "$ga" = 0 ] && [ "$gb" = 0 ] && [ "$(jlines)" = "$((j0+2))" ]; then ok G5 "reason=no-entry(直投 sessionId)"; else bad G5 "rc $ga/$gb journal $(jlines)"; fi

# G6 非 steer 七类型过有主目标: conflicts/journal 零增长
printf '{"fleet":{"3333":{"sessionId":"session-3333-cccc-dddd-eeee-000000000003","kind":"worker","owner":"rival","leaseExpiresAt":"%s"}}}' "$FUTURE" > "$WORK/fleet.json"
j0=$(jlines); c0=$(clines); g6ok=1
for typ in ping pong done ask nack ack report; do
  run_old --msgid "g6o-$typ" me 3333 "$typ" rG x >/dev/null 2>&1 || g6ok=0
  run_new --msgid "g6n-$typ" me 3333 "$typ" rG x >/dev/null 2>&1 || g6ok=0
done
if [ "$g6ok" = 1 ] && [ "$(jlines)" = "$j0" ] && [ "$(clines)" = "$c0" ]; then ok G6 "非 steer 七类型零闸影响"; else bad G6 "rc 或 journal/conflicts 增长"; fi

# G7 双写一致(R-S29)+ G8 reason 四值
node --input-type=module - "$WORK" <<'EOF' > "$WORK/g-result.txt"
import { readFileSync, existsSync } from 'node:fs'
const W = process.argv[2]
function rows(p) { return existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [] }
const j = rows(`${W}/state/steer-journal.jsonl`)
const c = rows(`${W}/fleet-conflicts.jsonl`)
let pass = 0, fail = 0
const err = (m) => { fail++; console.log(`F G7/G8: ${m}`) }
// G7: 按 msgid 配对比较
const byM = new Map()
for (const r of j) byM.set(r.msgid, r)
const pairs = [['g2-old','g2-new','owner-self'],['g3-old','g3-new','unowned'],['g4-old','g4-new','lease-expired'],['g5-old','g5-new','no-entry']]
for (const [a, b, reason] of pairs) {
  const ra = byM.get(a), rb = byM.get(b)
  if (!ra || !rb) { err(`journal 缺 ${a}/${b}`); continue }
  if (JSON.stringify(Object.keys(ra)) !== JSON.stringify(Object.keys(rb))) err(`键序不等 ${a}`)
  if (JSON.stringify(new Set(Object.keys(ra))) !== JSON.stringify(new Set(['msgid','from','to','ts','reason']))) err(`键集合错 ${a}`)
  if (ra.from !== rb.from || ra.to !== rb.to || ra.reason !== rb.reason) err(`值不等 ${a}`)
  if (!Number.isInteger(ra.ts) || !Number.isInteger(rb.ts)) err(`ts 非整数 ${a}`)
  if (ra.reason !== reason || rb.reason !== reason) err(`reason ${a}=${ra.reason}/${rb.reason} expect=${reason}`)
  else pass++
}
// conflicts 行结构
for (const r of c) {
  if (JSON.stringify(Object.keys(r)) !== JSON.stringify(['msgid','from','to','ts'])) err('conflict 键序错')
  else pass++
}
console.log(`GRESULT ${pass} ${fail}`)
EOF
read -r GPASS GFAIL <<< "$(grep -o 'GRESULT [0-9]* [0-9]*' "$WORK/g-result.txt" | tail -1 | awk '{print $2, $3}')"
while IFS= read -r line; do echo "[FAIL] ${line#F }"; done < <(grep '^F ' "$WORK/g-result.txt")
if [ "$GFAIL" = 0 ]; then ok G7 "双写行结构一致(键集/键序/值)"; ok G8 "reason 四值枚举全覆盖×两路"; else bad G7 "见上"; bad G8 "见上"; fi

# ---- L 系列: 沙箱 live 层 ----
LIVE_PORT="${P2_LIVE_PORT:-3081}"
# L0 可达性
L0BODY="$(curl -sS -m 5 -X POST "http://127.0.0.1:$LIVE_PORT/api/session.prompt" \
  -H 'content-type: application/json' \
  -d '{"type":"client-request","rpcId":"p2-l0","method":"session.prompt","payload":{"sessionId":"session-00000000-0000-4000-8000-000000000000","mode":"queue","content":[{"type":"text","text":"x"}]}}' 2>&1)" || true
if echo "$L0BODY" | grep -q 'server-response'; then ok L0 "沙箱 :$LIVE_PORT 可达(server-response)"; else bad L0 "不可达或无 server-response: $L0BODY"; fi

# L1 错误契约对拍(temp fleet 指定 port)
printf '{"port":%s}' "$LIVE_PORT" > "$WORK/fleet.json"
set +e
# 注: 旧 bin RPC error 走 stdout(print 无 file=stderr,spec P2.4.4 流向误记);按合并流断言
run_old me session-00000000-0000-4000-8000-000000000000 ack r x >"$WORK/l1o.err" 2>&1; la=$?
run_new me session-00000000-0000-4000-8000-000000000000 ack r x >"$WORK/l1n.err" 2>&1; lb=$?
true
if [ "$la" = 1 ] && [ "$lb" = 1 ] \
  && grep -q 'session-send: RPC error:' "$WORK/l1o.err" && grep -q 'session-not-found' "$WORK/l1o.err" \
  && grep -q 'session-send: RPC error:' "$WORK/l1n.err" && grep -q 'session-not-found' "$WORK/l1n.err"; then
  ok L1 "错误契约对拍(RPC error+session-not-found)"
else bad L1 "rc $la/$lb old:$(head -c 120 "$WORK/l1o.err") new:$(head -c 120 "$WORK/l1n.err")"; fi

# L2 happy-path(条件)
if [ -n "${P2_LIVE_SESSION:-}" ]; then
  run_old --msgid l2-old me "$P2_LIVE_SESSION" ack rL2 live >/dev/null 2>&1; la=$?
  run_new --msgid l2-new me "$P2_LIVE_SESSION" ack rL2 live >/dev/null 2>&1; lb=$?
  if [ "$la" = 0 ] && [ "$lb" = 0 ]; then ok L2 "live happy-path 双路 rc0"; else bad L2 "rc $la/$lb"; fi
else
  echo "[skip] L2: P2_LIVE_SESSION 未提供"
fi

TOTAL=$((PASS+FAIL))
echo
if [ "$FAIL" = 0 ]; then
  echo "p2-a-b-test: $TOTAL/$TOTAL 全绿(exit 0)"
  exit 0
else
  echo "p2-a-b-test: $PASS/$TOTAL 全绿(exit 1)"
  exit 1
fi
