#!/bin/bash
# pm001-007-regression.sh — PM-001..007 live gates + full-clause sandbox gate (HF-013 ①).
# Live part (this script, against the systemd unit that ExecStarts THIS repo
# checkout): PM-001 is-active / kill pull-back / zero-change apply; PM-002
# try-restart port drift + old-port refused + live-flock loser; live API smoke
# (tickets replay, fleet join, trace replay, flow SQL).
# Sandbox part (gates/pm001-007-gate.mjs, rv-a reviewer sandbox style): every
# PM-002..007 clause asserted one by one — ledger 降级 / dsh 死 / 折叠+过滤 /
# db 不可读 / exactly-once+断线重连 — on env-overridden sandbox daemons running
# the same service.mjs.
# Retention (HF-013 ②): ALL artifacts (this log + sandbox trees + manifest)
# land in $PM_HOST_SERVICE_GATES_DIR/pm001-007/<label>/ — default
# ~/.dsh/maestro/logs/pm-host-service/gates — never /tmp.
# Usage: pm001-007-regression.sh [label]     (default label: run-<ts>-<pid>)
set -u
PASS=0; FAIL=0
ok(){ if [ "$1" = 0 ]; then PASS=$((PASS+1)); echo "PASS $2${3:+  :: $3}"; else FAIL=$((FAIL+1)); echo "FAIL $2${3:+  :: $3}"; fi }
REPO="$HOME/tools/maestro-preset/plugins/pm-host-service"
GATES_DIR="${PM_HOST_SERVICE_GATES_DIR:-$HOME/.dsh/maestro/logs/pm-host-service/gates}"
LABEL="${1:-run-$(date +%Y%m%dT%H%M%S)-$$}"
EVID="$GATES_DIR/pm001-007/$LABEL"
PORT_FILE="$HOME/.dsh/maestro/pm.port"
SVC=pm-host-service
mkdir -p "$EVID"
exec > >(tee -a "$EVID/regression.log") 2>&1
port(){ node -p "JSON.parse(require('fs').readFileSync('$PORT_FILE','utf8')).port"; }
apiget(){ curl -sS -m 10 "http://127.0.0.1:$1$2"; }
sha(){ sha256sum | cut -c1-16; }
VER=$(node -p "JSON.parse(require('fs').readFileSync('$REPO/package.json','utf8')).version")

echo "=== PM-001..007 regression $LABEL  repo=$REPO version=$VER evid=$EVID ==="

echo "=== 0. deploy check via PM-002 restart gate (pid 更新 + 端口恒定, PMW2-G 钉港) ==="
OLD=$(port); OLDPID=$(systemctl --user show -p MainPID --value $SVC)
systemctl --user try-restart $SVC
NEW="$OLD"; NEWPID="$OLDPID"
for i in $(seq 50); do
  NEWPID=$(systemctl --user show -p MainPID --value $SVC 2>/dev/null || true)
  PORTPID=$(node -pe "try{JSON.parse(require('fs').readFileSync('$PORT_FILE','utf8')).pid}catch{''}" 2>/dev/null || true)
  [ -n "$NEWPID" ] && [ "$NEWPID" != 0 ] && [ "$NEWPID" != "$OLDPID" ] && [ "$PORTPID" = "$NEWPID" ] && NEW=$(port) && break
  sleep 0.2
done
ok $([ -n "$NEW" ] && [ "$NEW" = "$OLD" ] && [ -n "$NEWPID" ] && [ "$NEWPID" != "$OLDPID" ]; echo $?) "PM-002 restart: pid 更新且端口恒定(PMW2-G 钉港)" "pid $OLDPID->$NEWPID port=$OLD->$NEW"
curl -sS -m 3 "http://127.0.0.1:$NEW/health" >/dev/null 2>&1; ok $([ $? -eq 0 ]; echo $?) "PM-002 钉港 /health 200 after restart" "$NEW"
H=$(apiget $NEW /health)
echo "$H" | grep -q "\"version\":\"$VER\""; ok $? "repo version $VER live after restart" "$(echo "$H" | head -c 100)"

echo "=== PM-001 gates (is-active / kill pull-back / zero-change apply) ==="
[ "$(systemctl --user is-active $SVC)" = active ]; ok $? "PM-001 is-active"
KILLPID=$(systemctl --user show -p MainPID --value $SVC)
kill "$KILLPID"; sleep 3
NEWPID=$(systemctl --user show -p MainPID --value $SVC)
[ "$(systemctl --user is-active $SVC)" = active ] && [ "$NEWPID" != "$KILLPID" ] && [ -n "$NEWPID" ] && [ "$NEWPID" != 0 ]
ok $? "PM-001 kill -> Restart=on-failure pulls back (<=10s)" "$KILLPID -> $NEWPID"
NEW=$(port)  # pid changed => port file rewritten; refetch
APPLY=$(node -e "import('$REPO/index.js').then(m=>console.log(JSON.stringify(m.apply({}))))")
echo "$APPLY" | grep -q '"ok":true' && echo "$APPLY" | grep -q '"unit":"skip: identical' && echo "$APPLY" | grep -q 'skip: already enabled'
ok $? "PM-001 repeat apply zero-change" "$(echo "$APPLY" | head -c 160)"

echo "=== PM-002 flock (second bare instance exits 0 as lock loser, live pid unchanged) ==="
T0=$(date +%s)
timeout 8 node "$REPO/service.mjs" >/dev/null 2>&1; RC=$?
T1=$(date +%s); DUR=$((T1-T0))
LIVEPID=$(systemctl --user show -p MainPID --value $SVC)
ok $([ $RC -eq 0 ] && [ $DUR -lt 4 ] && [ "$LIVEPID" = "$NEWPID" ]; echo $?) "PM-002 single instance (flock loser exit 0)" "rc=$RC dur=${DUR}s livepid_unchanged=$([ "$LIVEPID" = "$NEWPID" ] && echo yes || echo no)"

echo "=== PM-003 tickets live (replay cache hit, sha stable) ==="
apiget $NEW /op/tickets >/dev/null  # warm-up (first call after restart may be a cold miss)
T1=$(apiget $NEW /op/tickets); S1=$(echo -n "$T1" | sha); SP1=$(echo "$T1" | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).cliSpawns')
T2=$(apiget $NEW /op/tickets); S2=$(echo -n "$T2" | sha); SP2=$(echo "$T2" | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).cliSpawns')
[ "$S1" = "$S2" ] && echo "$T2" | grep -q '"cache":"hit"' && [ "$SP1" = "$SP2" ]
ok $? "PM-003 tickets replay zero re-pull" "sha=$S1 cliSpawns=$SP1->$SP2"

echo "=== PM-004 fleet live (join + sha stable) ==="
F1=$(apiget $NEW /op/fleet); FS1=$(echo -n "$F1" | sha)
F2=$(apiget $NEW /op/fleet); FS2=$(echo -n "$F2" | sha)
[ "$FS1" = "$FS2" ] && echo "$F1" | grep -q '"sessionJoined":true' && echo "$F1" | grep -q '"degraded":false'
ok $? "PM-004 fleet join + replay stable" "sha=$FS1"

echo "=== PM-005 trace live (real session replay sha stable) ==="
SID=""
for b in "$HOME"/.dsh/sessions/*/; do
  for d in "$b"*/; do
    [ -f "$d/session.jsonl.zstd" ] && SID=$(basename "$d") && break 2
  done
done
[ -z "$SID" ] && SID="session-none-$$"
TR1=$(apiget $NEW "/op/trace?sessionId=$SID"); TRS1=$(echo -n "$TR1" | sha)
TR2=$(apiget $NEW "/op/trace?sessionId=$SID"); TRS2=$(echo -n "$TR2" | sha)
echo "$TR1" | grep -q '"op":"trace"'; [ "$TRS1" = "$TRS2" ]
ok $? "PM-005 trace read + replay stable" "sid=$SID sha=$TRS1 status=$(echo "$TR1" | grep -o '"status":"[a-z]*"' | head -1)"

echo "=== PM-006 flow live (SQL self-walk) ==="
FL=$(apiget $NEW /op/flow)
echo "$FL" | grep -q '"flow":"pm-p1"' && echo "$FL" | grep -q '"source":"sql"'
ok $? "PM-006 flow reads pm-p1 via sql" "$(echo "$FL" | node -p 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));`count=${j.count} sqlFailed=${j.sqlFailed}`')"

echo "=== PM-007 live subscribe endpoint health (no live-state mutation) ==="
# SSE headers flush only with the first frame/ping (writeHead alone does not
# hit the wire; ping period 15s) — budget -m 18 so the keepalive flushes them.
SSECODE=$(curl -sN -m 18 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$NEW/subscribe?consumer=pm001-007-regression-$LABEL")
[ "$SSECODE" = 200 ]; ok $? "PM-007 subscribe endpoint 200 SSE (headers flush <= ping 15s)" "code=$SSECODE"

echo "=== sandbox full-clause gate (rv-a reviewer sandbox style) ==="
node "$REPO/gates/pm001-007-gate.mjs" "$LABEL"
GATE_RC=$?
ok $([ $GATE_RC -eq 0 ]; echo $?) "PM-002..007 full-clause sandbox gate green" "gate_rc=$GATE_RC evid=$EVID"

echo "=== regression $LABEL: PASS=$PASS FAIL=$FAIL (evidence: $EVID) ==="
[ $FAIL -eq 0 ]
