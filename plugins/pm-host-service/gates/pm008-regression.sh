#!/bin/bash
# pm008-regression.sh — PM-001..007 live gates re-run + PM-008 live smoke
# (read-only verb through the real write path).
# Repo copy (HF-013): version is pinned at runtime to the repo checkout's
# package.json (the systemd unit ExecStarts THIS checkout, so try-restart
# deploys it — the gate stays green across future version bumps).
# Retention (HF-013 ②): temp/evidence artifacts land in
# $PM_HOST_SERVICE_GATES_DIR/pm008/<label>/ (default
# ~/.dsh/maestro/logs/pm-host-service/gates) — never /tmp.
# Usage: pm008-regression.sh [label]
set -u
PASS=0; FAIL=0
ok(){ if [ "$1" = 0 ]; then PASS=$((PASS+1)); echo "PASS $2${3:+  :: $3}"; else FAIL=$((FAIL+1)); echo "FAIL $2${3:+  :: $3}"; fi }
REPO="$HOME/tools/maestro-preset/plugins/pm-host-service"
GATES_DIR="${PM_HOST_SERVICE_GATES_DIR:-$HOME/.dsh/maestro/logs/pm-host-service/gates}"
LABEL="${1:-run-$(date +%Y%m%dT%H%M%S)-$$}"
EVID="$GATES_DIR/pm008/$LABEL"
mkdir -p "$EVID"
exec > >(tee -a "$EVID/regression.log") 2>&1
PORT_FILE="$HOME/.dsh/maestro/pm.port"
SVC=pm-host-service
port(){ node -p "JSON.parse(require('fs').readFileSync('$PORT_FILE','utf8')).port"; }
apiget(){ curl -sS -m 10 "http://127.0.0.1:$1$2"; }
sha(){ sha256sum | cut -c1-16; }
VER=$(node -p "JSON.parse(require('fs').readFileSync('$REPO/package.json','utf8')).version")

echo "=== 0. deploy $VER via PM-002 restart gate (port drift) ==="
OLD=$(port); OLDPID=$(systemctl --user show -p MainPID --value $SVC)
systemctl --user try-restart $SVC
for i in $(seq 50); do NEW=$(port); [ "$NEW" != "$OLD" ] && break; sleep 0.2; done
ok $([ -n "$NEW" ] && [ "$NEW" != "$OLD" ]; echo $?) "PM-002 port drift after restart" "old=$OLD new=$NEW"
curl -sS -m 3 "http://127.0.0.1:$OLD/health" >/dev/null 2>&1; ok $([ $? -ne 0 ]; echo $?) "PM-002 old port refused" "$OLD"
H=$(apiget $NEW /health)
echo "$H" | grep -q "\"version\":\"$VER\""; ok $? "$VER live after restart" "$(echo "$H" | head -c 120)"

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
ok $? "PM-001 repeat apply zero-change" "$(echo "$APPLY" | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).unit+"/"+JSON.parse(require("fs").readFileSync(0,"utf8")).enable' 2>/dev/null || echo "$APPLY" | head -c 160)"

echo "=== PM-002 flock (second bare instance exits 0 as lock loser) ==="
T0=$(date +%s)
timeout 8 node "$REPO/service.mjs" >/dev/null 2>&1; RC=$?
T1=$(date +%s); DUR=$((T1-T0))
LIVEPID=$(systemctl --user show -p MainPID --value $SVC)
ok $([ $RC -eq 0 ] && [ $DUR -lt 4 ] && [ "$LIVEPID" = "$NEWPID" ]; echo $?) "PM-002 single instance (flock loser exit 0)" "rc=$RC dur=${DUR}s livepid_unchanged=$([ "$LIVEPID" = "$NEWPID" ] && echo yes || echo no)"

echo "=== PM-003 tickets (replay cache hit, sha stable) ==="
apiget $NEW /op/tickets >/dev/null  # warm-up (first call after restart may be a cold miss)
T1=$(apiget $NEW /op/tickets); S1=$(echo -n "$T1" | sha); SP1=$(echo "$T1" | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).cliSpawns')
T2=$(apiget $NEW /op/tickets); S2=$(echo -n "$T2" | sha); SP2=$(echo "$T2" | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).cliSpawns')
[ "$S1" = "$S2" ] && echo "$T2" | grep -q '"cache":"hit"' && [ "$SP1" = "$SP2" ]
ok $? "PM-003 tickets replay zero re-pull" "sha=$S1 cliSpawns=$SP1->$SP2 cache=$(echo "$T2" | grep -o '"cache":"[a-z]*"')"

echo "=== PM-004 fleet (join live, sha stable) ==="
F1=$(apiget $NEW /op/fleet); FS1=$(echo -n "$F1" | sha)
F2=$(apiget $NEW /op/fleet); FS2=$(echo -n "$F2" | sha)
[ "$FS1" = "$FS2" ] && echo "$F1" | grep -q '"sessionJoined":true' && echo "$F1" | grep -q '"degraded":false'
ok $? "PM-004 fleet join + replay stable" "sha=$FS1"

echo "=== PM-005 trace (real session, replay sha stable) ==="
SID=$(ls "$(ls -d $HOME/.dsh/sessions/*/ | head -20 | xargs -I{} sh -c 'ls -d {}* 2>/dev/null | head -50' | while read d; do [ -f "$d/session.jsonl.zstd" ] && basename "$d" && break; done)" 2>/dev/null | head -1)
if [ -z "$SID" ]; then for b in $HOME/.dsh/sessions/*/; do for d in "$b"*/; do [ -f "$d/session.jsonl.zstd" ] && SID=$(basename "$d") && break 2; done; done; fi
TR1=$(apiget $NEW "/op/trace?sessionId=$SID"); TRS1=$(echo -n "$TR1" | sha)
TR2=$(apiget $NEW "/op/trace?sessionId=$SID"); TRS2=$(echo -n "$TR2" | sha)
echo "$TR1" | grep -q '"op":"trace"'; [ "$TRS1" = "$TRS2" ]
ok $? "PM-005 trace read + replay stable" "sid=$SID sha=$TRS1 status=$(echo "$TR1" | grep -o '"status":"[a-z]*"' | head -1)"

echo "=== PM-006 flow (SQL self-walk) ==="
FL=$(apiget $NEW /op/flow)
echo "$FL" | grep -q '"flow":"pm-p1"' && echo "$FL" | grep -q '"source":"sql"'
ok $? "PM-006 flow reads pm-p1 via sql" "$(echo "$FL" | node -p 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));`count=${j.count} degraded=${j.degraded}`')"

echo "=== PM-007 + PM-008 live smoke (SSE kind=act + read-only verb through write path) ==="
SSE="$EVID/live-sse-$$.log"
curl -sN -m 12 "http://127.0.0.1:$NEW/subscribe?consumer=pm008-regression&kinds=act" >"$SSE" 2>/dev/null &
CURLPID=$!
sleep 1
R=$(curl -sS -m 10 -X POST -H 'content-type: application/json' -d '{"tool":"ledger","args":["ticket","list"]}' "http://127.0.0.1:$NEW/op/act")
REF=$(echo "$R" | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).ref' 2>/dev/null)
echo "$R" | grep -q '"accepted":true' && echo "$REF" | grep -Eq '^vh-[0-9a-f]{8}$'
ok $? "PM-008 live phase-1 receipt (minted ref)" "ref=$REF"
for i in $(seq 40); do ST=$(curl -sS -m 5 "http://127.0.0.1:$NEW/op/act?ref=$REF" | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).entry?.status' 2>/dev/null); [ "$ST" = ok ] && break; sleep 0.25; done
[ "$ST" = ok ]
ok $? "PM-008 live settles ok (real ledger CLI)" "status=$ST"
RR=$(curl -sS -m 10 -X POST -H 'content-type: application/json' -d "{\"tool\":\"ledger\",\"args\":[\"ticket\",\"list\"],\"ref\":\"$REF\"}" "http://127.0.0.1:$NEW/op/act")
echo "$RR" | grep -q '"replay":true'
ok $? "PM-008 live same-ref replay (zero second CLI)" "$(echo "$RR" | grep -o '"replay":[a-z]*')"
wait $CURLPID 2>/dev/null
grep -q "\"ref\":\"$REF\"" "$SSE" && grep "\"ref\":\"$REF\"" "$SSE" | grep -q '"status":"ok"' && grep "\"ref\":\"$REF\"" "$SSE" | grep -q '"replay":false'
ok $? "PM-007+008 kind=act settle event on live SSE" "frames=$(grep -c '^data: ' "$SSE")"
grep -q "\"t\":\"act.accept\".*\"ref\":\"$REF\"" "$HOME/.dsh/maestro/state/act/audit.jsonl" && grep -q "\"t\":\"act.settle\".*\"ref\":\"$REF\"" "$HOME/.dsh/maestro/state/act/audit.jsonl"
ok $? "PM-008 live audit accept+settle lines" "audit=$HOME/.dsh/maestro/state/act/audit.jsonl"

echo "=== negative: non-act POST still 405 / GET /op/act summary ==="
CODE=$(curl -sS -m 5 -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$NEW/op/tickets")
[ "$CODE" = 405 ]; ok $? "non-act POST 405" "code=$CODE"
SUM=$(apiget $NEW /op/act); echo "$SUM" | grep -q '"summary":true' && echo "$SUM" | grep -q '"ok":[1-9]'
ok $? "GET /op/act summary" "$(echo "$SUM" | node -p 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));`counts=${JSON.stringify(j.counts)} spawns=${j.cliSpawns}`')"

echo "=== regression: PASS=$PASS FAIL=$FAIL (evidence: $EVID) ==="
[ $FAIL -eq 0 ]
