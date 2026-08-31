#!/bin/bash
# pmw2-1-live.sh — PMW2-1 /op/graph live gate on REAL ~/.dsh/maestro data.
# Deploys THIS repo checkout via PM-002 try-restart (unit ExecStart points
# here — restart IS the deploy, pm009-regression precedent), then asserts the
# frozen spec contract (docs/specs/spec-pm-web-canvas.md §1/§2/§5) against
# live aggregation: ≥1 node per type, ≥1 edge per derivable kind on real
# data, cb-send honest empty set + annotation (spec §1.2 空集合法), envelope/
# sources integrity, 恒 200.
# Retention (HF-013 ②): evidence lands in
#   $PM_HOST_SERVICE_GATES_DIR/pmw2-1-live/<label>/  (default
#   ~/.dsh/maestro/logs/pm-host-service/gates) — op-graph.json + this log.
# Usage: pmw2-1-live.sh [label]
set -u
PASS=0; FAIL=0
ok(){ if [ "$1" = 0 ]; then PASS=$((PASS+1)); echo "PASS $2${3:+  :: $3}"; else FAIL=$((FAIL+1)); echo "FAIL $2${3:+  :: $3}"; fi }
REPO="$HOME/tools/maestro-preset/plugins/pm-host-service"
GATES_DIR="${PM_HOST_SERVICE_GATES_DIR:-$HOME/.dsh/maestro/logs/pm-host-service/gates}"
LABEL="${1:-run-$(date +%Y%m%dT%H%M%S)-$$}"
EVID="$GATES_DIR/pmw2-1-live/$LABEL"
mkdir -p "$EVID"
exec > >(tee -a "$EVID/regression.log") 2>&1
PORT_FILE="$HOME/.dsh/maestro/pm.port"
SVC=pm-host-service
port(){ node -p "JSON.parse(require('fs').readFileSync('$PORT_FILE','utf8')).port"; }
VER=$(node -p "JSON.parse(require('fs').readFileSync('$REPO/package.json','utf8')).version")

echo "=== 0. deploy $VER via PM-002 try-restart ==="
OLD=$(port); OLDPID=$(systemctl --user show -p MainPID --value $SVC)
systemctl --user try-restart $SVC
NEW="$OLD"; NEWPID="$OLDPID"
for i in $(seq 60); do
  NEWPID=$(systemctl --user show -p MainPID --value $SVC 2>/dev/null || true)
  PORTPID=$(node -pe "try{JSON.parse(require('fs').readFileSync('$PORT_FILE','utf8')).pid}catch{''}" 2>/dev/null || true)
  [ -n "$NEWPID" ] && [ "$NEWPID" != 0 ] && [ "$NEWPID" != "$OLDPID" ] && [ "$PORTPID" = "$NEWPID" ] && NEW=$(port 2>/dev/null || true) && break
  sleep 0.25
done
ok $([ -n "$NEW" ] && [ "$NEW" = "$OLD" ] && [ -n "$NEWPID" ] && [ "$NEWPID" != "$OLDPID" ]; echo $?) "PM-002 restart: pid 更新且端口恒定(PMW2-G 钉港)" "pid $OLDPID->$NEWPID port=$OLD->$NEW"
H=$(curl -sS -m 10 "http://127.0.0.1:$NEW/health")
echo "$H" | grep -q "\"version\":\"$VER\""; ok $? "$VER live after restart" "$(echo "$H" | head -c 100)"

echo "=== PMW2-1 /op/graph real-data contract ==="
CODE=$(curl -sS -m 30 -o "$EVID/op-graph.json" -w '%{http_code}' "http://127.0.0.1:$NEW/op/graph")
ok $([ "$CODE" = 200 ]; echo $?) "恒 200 on real data" "http=$CODE bytes=$(wc -c < "$EVID/op-graph.json")"

node -e "
const fs = require('fs')
const j = JSON.parse(fs.readFileSync('$EVID/op-graph.json', 'utf8'))
const keys = (o) => Object.keys(o ?? {}).sort().join(',')
let bad = 0
const ok = (name, cond, detail = '') => { if (cond) console.log('PASS ' + name + (detail ? '  :: ' + detail : '')); else { bad++; console.log('FAIL ' + name + (detail ? '  :: ' + detail : '')) } }
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/
ok('op=graph', j.op === 'graph')
ok('§2 信封键集逐字', keys(j) === 'counts,degraded,edges,generatedAt,nodes,note,op,sources', keys(j))
ok('generatedAt ISO', ISO.test(j.generatedAt ?? ''), j.generatedAt)
ok('counts 键形+自洽', keys(j.counts) === 'byKind,byType,edges,nodes' && j.counts.nodes === j.nodes.length && j.counts.edges === j.edges.length && Object.values(j.counts.byType).reduce((a, b) => a + b, 0) === j.nodes.length && Object.values(j.counts.byKind).reduce((a, b) => a + b, 0) === j.edges.length)
ok('sources 四面齐+全 live(健康真-data)', keys(j.sources) === 'bridge,fleet,flows,tickets' && ['flows', 'tickets', 'fleet', 'bridge'].every((k) => j.sources[k].live === true), JSON.stringify(Object.fromEntries(Object.entries(j.sources).map(([k, v]) => [k, v.live]))))
ok('健康真-data degraded=false', j.degraded === false, (j.note || '').slice(0, 80))
// §1.1 four node types on real data + exact per-type field sets
const NODE_KEYS = { 'flow-node': 'attempts,events,flow,id,label,nodeId,state,type,verb', ticket: 'deps,id,label,leaseOwner,refs,state,ticketId,type', seat: 'code,id,label,node,preset,role,sessionId,status,type', session: 'cwd,id,label,running,sessionId,title,type' }
ok('§1.1 四型节点各 ≥1(真-data)', j.counts.byType['flow-node'] >= 1 && j.counts.byType.ticket >= 1 && j.counts.byType.seat >= 1 && j.counts.byType.session >= 1, JSON.stringify(j.counts.byType))
ok('§1.1 四型字段集逐字', j.nodes.every((n) => NODE_KEYS[n.type] && keys(n) === NODE_KEYS[n.type]), j.nodes.filter((n) => !NODE_KEYS[n.type] || keys(n) !== NODE_KEYS[n.type]).slice(0, 1).map((n) => n.id + ':' + keys(n)).join(''))
const byId = new Map(j.nodes.map((n) => [n.id, n]))
ok('§1.1 ticket refs=键名数组样本', j.nodes.filter((n) => n.type === 'ticket').every((n) => Array.isArray(n.refs) && Array.isArray(n.deps)))
ok('§1.1 session label ≤40', j.nodes.filter((n) => n.type === 'session').every((n) => String(n.label).length <= 40))
// §1.2 edges
const EDGE_KEYS = { dep: 'from,id,kind,label,to', dispatch: 'from,id,kind,label,to', callback: 'at,from,id,kind,label,to', 'cb-send': 'at,from,id,kind,label,to' }
ok('§1.2 四义边键形逐字', j.edges.every((e) => EDGE_KEYS[e.kind] && keys(e) === EDGE_KEYS[e.kind]), j.edges.filter((e) => !EDGE_KEYS[e.kind] || keys(e) !== EDGE_KEYS[e.kind]).slice(0, 1).map((e) => e.id + ':' + keys(e)).join(''))
ok('§1.2 边 id 规则 <kind>:<from>><to> 全体', j.edges.every((e) => e.id === e.kind + ':' + e.from + '>' + e.to))
ok('§1.2 边端点零悬挂(全部落在节点集)', j.edges.every((e) => byId.has(e.from) && byId.has(e.to)))
ok('§1.2 dep ≥1(真-data)', (j.counts.byKind.dep ?? 0) >= 1, 'dep=' + j.counts.byKind.dep)
ok('§1.2 dispatch ≥1(真-data)', (j.counts.byKind.dispatch ?? 0) >= 1, 'dispatch=' + j.counts.byKind.dispatch)
ok('§1.2 callback ≥1(真-data)', (j.counts.byKind.callback ?? 0) >= 1, 'callback=' + j.counts.byKind.callback)
ok('§1.2 callback at=观测时刻 ISO', j.edges.filter((e) => e.kind === 'callback').every((e) => ISO.test(e.at ?? '')))
ok('§1.2 dep/dispatch 无 at', j.edges.filter((e) => e.kind === 'dep' || e.kind === 'dispatch').every((e) => !('at' in e)))
ok('§1.2 cb-send 如实空集+注记(现行 schema 勘察)', j.counts.byKind['cb-send'] === 0 && /cb-send/.test(j.sources.bridge.note ?? ''), (j.sources.bridge.note ?? '').slice(0, 100))
const orchEdge = j.edges.find((e) => e.kind === 'callback' && e.from.startsWith('se:session-') && e.to.startsWith('se:session-'))
ok('§2 示例形态在场(worker se: → orchestrator se:)', !!orchEdge, orchEdge ? orchEdge.id.slice(0, 90) : 'missing')
ok('lane 判型前提: 节点 id 前缀即类型', j.nodes.every((n) => (n.type === 'flow-node' && n.id.startsWith('fn:')) || (n.type === 'ticket' && n.id.startsWith('tk:')) || (n.type === 'seat' && n.id.startsWith('st:')) || (n.type === 'session' && n.id.startsWith('se:'))))
process.exit(bad === 0 ? 0 : 1)
"
ok $? "PMW2-1 real-data assertion block" "evidence=$EVID/op-graph.json"

echo "=== head of real response (evidence excerpt) ==="
head -c 400 "$EVID/op-graph.json"; echo; echo "…"

echo
echo "=== $LABEL: PASS=$PASS FAIL=$FAIL (evidence: $EVID) ==="
exit $([ $FAIL -eq 0 ]; echo $?)
