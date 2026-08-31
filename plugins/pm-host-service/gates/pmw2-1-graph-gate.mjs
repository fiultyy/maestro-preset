#!/usr/bin/env node
// pmw2-1-graph-gate.mjs — PMW2-1 /op/graph sandbox gate (spec
// docs/specs/spec-pm-web-canvas.md §1/§2 contract, field-for-field).
//
// Sandbox pattern (rv-a reviewer / pm001-007-gate precedent): env-overridden
// MAESTRO_HOME, the daemon runs THIS repo checkout's service.mjs, a fake dsh
// loopback RPC server (DSH_PORT) serves session.list, and every contract
// clause gets its own assertion:
//   §2 envelope: exact key set, ISO generatedAt, 恒 200, counts/sources shape
//   §1.1 nodes: four types on fixture data, per-type field sets EXACT
//        (flow-node / ticket / seat / session), label rules
//   §1.2 edges: dep direction (ticket + flow 同构), dispatch lease
//        (st:code -> tk:id, label "lease"), callback resolution
//        (seat-code / bare-short-code / alias@session-uuid handles, resolved
//        (from,to) dedup keep-latest, at present; dep/dispatch carry no at),
//        cb-send honest empty set + sources.bridge.note annotation,
//        悬挂禁止 (dangling dep / lease / handle -> edge dropped + note)
//   §5 degradation: flows root removed -> 200 + empty contribution +
//        sources.flows.live=false + degraded:true (never 5xx); fleet.json
//        removed -> seats empty, callback edges all drop (nodes gone);
//        bridge log removed -> bridge live=false; boot with EVERYTHING
//        absent -> all four planes live=false, four-type/four-kind zero
//        envelopes intact.
// Red lines re-checked here: existing /op/* untouched (this gate only ever
// calls GET /op/graph), zero new SSE kinds (service emits none for graph),
// zero npm (gate is node:* ESM only).
//
// Retention (HF-013 ②): artifacts land under
//   $PM_HOST_SERVICE_GATES_DIR/pmw2-1/<label>/  (default
//   ~/.dsh/maestro/logs/pm-host-service/gates) — never /tmp.
// Usage: node pmw2-1-graph-gate.mjs <label>    (label default: manual-<pid>)
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'

const LABEL = process.argv[2] ?? `manual-${process.pid}`
const GATES_ROOT = process.env.PM_HOST_SERVICE_GATES_DIR ?? `${homedir()}/.dsh/maestro/logs/pm-host-service/gates`
const BASE = `${GATES_ROOT}/pmw2-1/${LABEL}`
const REPO = new URL('..', import.meta.url).pathname // plugins/pm-host-service/
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}${detail ? `  :: ${detail}` : ''}`) } else { fail++; console.log(`FAIL ${name}${detail ? `  :: ${detail}` : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const keysOf = (o) => [...Object.keys(o)].sort().join(',')

// ---------- fake dsh loopback RPC (session.list only) ----------
const SESS_FE86 = 'session-fe86aaa1-1111-2222-3333-444444444444'
const SESS_A804 = 'session-a804bbb1-1111-2222-3333-444444444444'
const SESS_ORCH = 'session-ffff9999-aaaa-bbbb-cccc-dddddddddddd'
const SESSION_ITEMS = [
  { sessionId: SESS_FE86, running: true, cwd: '/home/yy/tools/proj-a', projections: { values: { title: 'fe86-gw · maestro · 门测试波(实现)' } } },
  { sessionId: SESS_A804, running: false, cwd: '/home/yy/tools/proj-b', projections: { values: { title: 'a804-repo · maestro · 门测试波(验证)' } } },
  { sessionId: SESS_ORCH, running: true, cwd: '/home/yy/tools/proj-a', projections: { values: { title: 'orch-p0 · maestro · 门测试编排' } } },
]
async function startFakeDsh() {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ result: { ok: true, value: { items: SESSION_ITEMS }, echo: body.slice(0, 80) } }))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { server, port: server.address().port }
}

// ---------- daemon lifecycle (pm001-007-gate pattern) ----------
function daemonEnv(sb, extra = {}) {
  return {
    ...process.env,
    MAESTRO_HOME: sb,
    PM_HOST_SERVICE_LEDGER: `${sb}/maestro/bin/ledger`,
    PM_HOST_SERVICE_FLOWC: `${sb}/maestro/bin/flowc`,
    PM_HOST_SERVICE_FLEET_LIST: `${sb}/maestro/bin/fleet-list`,
    PM_HOST_SERVICE_TICKETS_MD: `${sb}/maestro/tickets.md`,
    MAESTRO_FLEET: `${sb}/maestro/fleet.json`,
    MAESTRO_FLOWS_ROOT: `${sb}/maestro/flows`,
    PM_HOST_SERVICE_BRIDGE_LOG: `${sb}/maestro/bridge/inbox.log`,
    DSH_SESSIONS_ROOT: `${sb}/sessions`,
    ...extra,
  }
}
async function startDaemon(sb, dshPort, extraEnv = {}) {
  const child = spawn(process.execPath, [`${REPO}/service.mjs`], { env: daemonEnv(sb, { DSH_PORT: String(dshPort), ...extraEnv }), stdio: 'ignore' })
  for (let i = 0; i < 100; i++) {
    try {
      const p = JSON.parse(readFileSync(`${sb}/maestro/pm.port`, 'utf8'))
      if (p.port && p.pid === child.pid) return { child, port: p.port }
    } catch {}
    await sleep(100)
  }
  throw new Error(`daemon in ${sb} never published pm.port`)
}
const stopDaemon = (child) => new Promise((resolve) => {
  if (!child || child.exitCode != null || child.signalCode != null) return resolve()
  child.once('exit', resolve); try { child.kill('SIGTERM') } catch { resolve() }
})
async function req(port, path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`)
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { status: res.status, json, text }
}

// ---------- fixtures (real ledger/state.db shapes) ----------
const LEDGER_FIXTURE = `#!/bin/bash
echo '{"tickets":[
 {"ticket_id":"T-A","title":"依赖执行序被dep边测试","state":"running","deps":"[\\"T-B\\"]","lease_owner":null,"refs":"{}","outcome":null,"updated_at":"2026-08-31T00:00:00+00:00"},
 {"ticket_id":"T-B","title":"被T-A依赖+fe86持租","state":"dispatched","deps":"[]","lease_owner":"fe86/240min","refs":"{\\"repo\\":\\"/x\\"}","outcome":null,"updated_at":"2026-08-31T00:00:01+00:00"},
 {"ticket_id":"T-C","title":"悬挂dep+refs键位","state":"open","deps":"[\\"ghost-T\\"]","lease_owner":null,"refs":"{\\"repo\\":\\"/x\\",\\"adr\\":\\"y\\"}","outcome":null,"updated_at":"2026-08-31T00:00:02+00:00"},
 {"ticket_id":"T-D","title":"悬挂lease持有人","state":"open","deps":"[]","lease_owner":"ghostseat","refs":"{}","outcome":null,"updated_at":"2026-08-31T00:00:03+00:00"}
]}'`
const FLOWC_FIXTURE = '#!/bin/bash\necho "flowc inspect fallback output (fixture)"\nexit 0\n'
const FLEETLIST_FIXTURE = '#!/bin/bash\necho "fixture fleet-list dead" >&2\nexit 3\n'

const SEATS = {
  fe86: { sessionId: SESS_FE86, role: 'worker', node: 'gw-node', preset: 'maestro', spawnedAt: '2026-08-31T00:00:00+00:00', status: 'active' },
  a804: { sessionId: SESS_A804, role: 'worker', node: 'repo-node', preset: 'maestro', spawnedAt: '2026-08-31T00:01:00+00:00', status: 'active' },
  orphan: { sessionId: 'session-vanished0000-1111-2222-3333-444444444444', role: 'worker', node: 'gone-node', preset: 'maestro', spawnedAt: '2026-08-31T00:02:00+00:00', status: 'stale' },
}

function writeFlowDbReal(path, nodes, events) {
  mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE nodes(node_id TEXT NOT NULL, verb TEXT NOT NULL, title TEXT, state TEXT NOT NULL,
    deps TEXT NOT NULL DEFAULT '[]', on_done TEXT, on_fail TEXT, attempts INTEGER NOT NULL DEFAULT 0,
    result TEXT, payload TEXT, updated_at TEXT)`)
  db.exec('CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT, node_id TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT, ts TEXT)')
  db.exec(`CREATE VIEW v_status AS SELECT node_id, verb, title, state, attempts, result,
    (SELECT count(*) FROM events e WHERE e.node_id=n.node_id) AS events FROM nodes n ORDER BY node_id`)
  db.exec(`CREATE VIEW v_rollup AS SELECT state, count(*) AS n, group_concat(node_id) AS nodes
    FROM nodes GROUP BY state ORDER BY state`)
  for (const n of nodes) db.prepare('INSERT INTO nodes(node_id,verb,title,state,deps,attempts) VALUES (?,?,?,?,?,?)').run(n.id, n.verb, n.title ?? n.id, n.state, JSON.stringify(n.deps ?? []), n.attempts ?? 0)
  for (const e of events) db.prepare('INSERT INTO events(node_id,kind,detail,ts) VALUES (?,?,?,?)').run(e[0], e[1], e[2], '2026-08-31T00:00:00')
  db.close()
}

function buildSandbox(sb) {
  rmSync(sb, { recursive: true, force: true })
  mkdirSync(`${sb}/maestro/bin`, { recursive: true })
  mkdirSync(`${sb}/maestro/state`, { recursive: true })
  mkdirSync(`${sb}/maestro/bridge`, { recursive: true })
  writeFileSync(`${sb}/maestro/bin/ledger`, LEDGER_FIXTURE, { mode: 0o755 })
  writeFileSync(`${sb}/maestro/bin/flowc`, FLOWC_FIXTURE, { mode: 0o755 })
  writeFileSync(`${sb}/maestro/bin/fleet-list`, FLEETLIST_FIXTURE, { mode: 0o755 })
  writeFileSync(`${sb}/maestro/fleet.json`, `${JSON.stringify({ rev: 1, fleet: SEATS }, null, 2)}\n`)
  writeFileSync(`${sb}/maestro/tickets.md`, '# tickets\n')
  // flows: alpha (dep chain + dispatch event), beta (chain), deadflow (chmod 000 -> per-flow degrade)
  writeFlowDbReal(`${sb}/maestro/flows/alpha/state.db`, [
    { id: 'n1', verb: 'dispatch', state: 'done', deps: [] },
    { id: 'n2', verb: 'callback', state: 'done', deps: ['n1'] },
    { id: 'n3', verb: 'rollup', state: 'armed', deps: ['n2'], attempts: 1 },
  ], [['n1', 'armed', 'deps satisfied'], ['n2', 'armed', 'deps satisfied'], ['n2', 'done', 'ok'], ['n1', 'dispatched', 'AND-G steer accepted fe86(复用席); steer→b9be(离席不连)']])
  writeFlowDbReal(`${sb}/maestro/flows/beta/state.db`, [
    { id: 'm1', verb: 'dispatch', state: 'done', deps: [] },
    { id: 'm2', verb: 'callback', state: 'running', deps: ['m1'] },
  ], [['m1', 'armed', 'deps satisfied']])
  writeFlowDbReal(`${sb}/maestro/flows/deadflow/state.db`, [{ id: 'z1', verb: 'dispatch', state: 'armed', deps: [] }], [])
  chmodSync(`${sb}/maestro/flows/deadflow/state.db`, 0o000)
  // bridge near-window: full-form / bare-short-code / unresolvable / self-loop / garbage
  const orch = `orch-p0@${SESS_ORCH}`
  const lines = [
    JSON.stringify({ type: 'ack', from: 'fe86', to: orch, body: 'ack first sighting', ref: 'G-1' }),
    JSON.stringify({ type: 'done', from: 'fe86', to: orch, body: 'done later sighting — dedup keeps THIS', ref: 'G-1' }),
    JSON.stringify({ type: 'done', from: 'a804', to: 'ffff', body: 'bare short code resolves by unique prefix', ref: 'G-2' }),
    JSON.stringify({ type: 'ping', from: 'ghost-nobody', to: 'also-ghost', body: 'unresolvable both ends' }),
    JSON.stringify({ type: 'status', from: 'fe86', to: 'fe86', body: 'self loop after resolution' }),
    '{"type":"broken" json line',
  ]
  writeFileSync(`${sb}/maestro/bridge/inbox.log`, `${lines.join('\n')}\n`)
}

// ---------- assertions ----------
const EDGE_ID_RE = /^[a-z-]+:\S+>\S+$/
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/
const NODE_KEYS = {
  'flow-node': 'attempts,events,flow,id,label,nodeId,state,type,verb',
  ticket: 'deps,id,label,leaseOwner,refs,state,ticketId,type',
  seat: 'code,id,label,node,preset,role,sessionId,status,type',
  session: 'cwd,id,label,running,sessionId,title,type',
}
const EDGE_KEYS = { dep: 'from,id,kind,label,to', dispatch: 'from,id,kind,label,to', callback: 'at,from,id,kind,label,to', 'cb-send': 'at,from,id,kind,label,to' }

async function graphAssertions(g, tag) {
  const r = await req(g.port, '/op/graph')
  ok(`${tag} 恒 200`, r.status === 200, `status=${r.status}`)
  const j = r.json
  ok(`${tag} op=graph`, j?.op === 'graph')
  ok(`${tag} §2 envelope key set exact`, keysOf(j ?? {}) === 'counts,degraded,edges,generatedAt,nodes,note,op,sources', keysOf(j ?? {}))
  ok(`${tag} generatedAt ISO 8601`, ISO_RE.test(j?.generatedAt ?? ''), j?.generatedAt)
  ok(`${tag} sources 四面齐`, keysOf(j?.sources ?? {}) === 'bridge,fleet,flows,tickets', keysOf(j?.sources ?? {}))
  ok(`${tag} counts 键形`, keysOf(j?.counts ?? {}) === 'byKind,byType,edges,nodes', keysOf(j?.counts ?? {}))
  ok(`${tag} byType 四型枚举`, keysOf(j?.counts?.byType ?? {}) === 'flow-node,seat,session,ticket', keysOf(j?.counts?.byType ?? {}))
  ok(`${tag} byKind 四义枚举`, keysOf(j?.counts?.byKind ?? {}) === 'callback,cb-send,dep,dispatch', keysOf(j?.counts?.byKind ?? {}))
  ok(`${tag} counts 自洽`, j?.counts?.nodes === j?.nodes?.length && j?.counts?.edges === j?.edges?.length
    && Object.values(j?.counts?.byType ?? {}).reduce((a, b) => a + b, 0) === j?.nodes?.length
    && Object.values(j?.counts?.byKind ?? {}).reduce((a, b) => a + b, 0) === j?.edges?.length)
  for (const n of j?.nodes ?? []) {
    if (NODE_KEYS[n.type] !== undefined && keysOf(n) !== NODE_KEYS[n.type]) { ok(`${tag} §1.1 ${n.type} 字段集逐字`, false, `${n.id}: ${keysOf(n)}`); break }
  }
  ok(`${tag} §1.1 四型字段集逐字(含缺失型零断言)`, (j?.nodes ?? []).every((n) => NODE_KEYS[n.type] === undefined || keysOf(n) === NODE_KEYS[n.type]),
    (j?.nodes ?? []).filter((n) => NODE_KEYS[n.type] !== undefined && keysOf(n) !== NODE_KEYS[n.type]).slice(0, 1).map((n) => `${n.id}: ${keysOf(n)}`).join(''))
  ok(`${tag} §1.2 边字段集逐字`, (j?.edges ?? []).every((e) => EDGE_KEYS[e.kind] !== undefined && keysOf(e) === EDGE_KEYS[e.kind]),
    (j?.edges ?? []).filter((e) => !(EDGE_KEYS[e.kind] !== undefined && keysOf(e) === EDGE_KEYS[e.kind])).slice(0, 1).map((e) => `${e.id}: ${keysOf(e)}`).join(''))
  ok(`${tag} §1.2 边 id 规则 <kind>:<from>><to>`, (j?.edges ?? []).every((e) => e.id === `${e.kind}:${e.from}>${e.to}` && EDGE_ID_RE.test(e.id)))
  return j
}

// ---------- run ----------
mkdirSync(BASE, { recursive: true })
const startedAt = new Date().toISOString()
const dsh = await startFakeDsh()

// SB1: every source alive -> full-contract assertions, then file-level degradation chain.
{
  const sb = `${BASE}/sb1`
  buildSandbox(sb)
  const g = await startDaemon(sb, dsh.port)
  try {
    const j = await graphAssertions(g, 'SB1')
    const byId = new Map((j?.nodes ?? []).map((n) => [n.id, n]))
    const byEdge = new Map((j?.edges ?? []).map((e) => [e.id, e]))

    // §1.1 four node types on fixture data
    ok('SB1 flow-node 在图(alpha/n1)', byId.get('fn:alpha/n1')?.type === 'flow-node', JSON.stringify(byId.get('fn:alpha/n1')))
    ok('SB1 flow-node 字段值(v_status 面)', byId.get('fn:alpha/n2')?.verb === 'callback' && byId.get('fn:alpha/n2')?.state === 'done' && byId.get('fn:alpha/n2')?.events === 2 && byId.get('fn:alpha/n3')?.attempts === 1)
    ok('SB1 flow-node label=node_id', byId.get('fn:alpha/n1')?.label === 'n1' && byId.get('fn:alpha/n1')?.flow === 'alpha')
    ok('SB1 ticket 在图+refs=键名数组', byId.get('tk:T-C')?.refs?.join(',') === 'repo,adr' && Array.isArray(byId.get('tk:T-C')?.deps))
    ok('SB1 ticket deps 解析(字符串->数组)', Array.isArray(byId.get('tk:T-A')?.deps) && byId.get('tk:T-A')?.deps[0] === 'T-B')
    ok('SB1 leaseOwner 透传(lease_owner)', byId.get('tk:T-B')?.leaseOwner === 'fe86/240min')
    ok('SB1 seat 在图(字段对 fleet.json)', byId.get('st:fe86')?.role === 'worker' && byId.get('st:fe86')?.sessionId === SESS_FE86 && byId.get('st:orphan')?.sessionId?.startsWith('session-vanished'))
    ok('SB1 session 节点=join 面数据', byId.get(`se:${SESS_FE86}`)?.running === true && byId.get(`se:${SESS_FE86}`)?.cwd === '/home/yy/tools/proj-a' && String(byId.get(`se:${SESS_FE86}`)?.label).startsWith('fe86-gw'))
    ok('SB1 无 join 数据的席位无 session 节点(席位保留 sessionId)', byId.get('se:session-vanished0000-1111-2222-3333-444444444444') === undefined && byId.get('st:orphan') !== undefined)
    ok('SB1 编排者 session 节点(bridge 全形 handle→join 面)', byId.get(`se:${SESS_ORCH}`)?.type === 'session' && byId.get(`se:${SESS_ORCH}`)?.running === true)
    ok('SB1 label 截 40', (j?.nodes ?? []).every((n) => n.type !== 'session' || String(n.label).length <= 40))

    // §1.2 edges
    ok('SB1 dep 票向(tk:B->tk:A 方向)', byEdge.get('dep:tk:T-B>tk:T-A')?.from === 'tk:T-B' && byEdge.get('dep:tk:T-B>tk:T-A')?.to === 'tk:T-A')
    ok('SB1 dep flow 同构(fn:n1->fn:n2)', byEdge.get('dep:fn:alpha/n1>fn:alpha/n2')?.kind === 'dep')
    ok('SB1 dispatch 子源① lease(st:fe86->tk:T-B,label lease)', byEdge.get('dispatch:st:fe86>tk:T-B')?.label === 'lease' && byEdge.get('dispatch:st:fe86>tk:T-B')?.from === 'st:fe86')
    ok('SB1 dispatch 子源② flow 事件席位(st:fe86->fn:alpha/n1)', byEdge.get('dispatch:st:fe86>fn:alpha/n1')?.kind === 'dispatch')
    ok('SB1 dispatch 子源② 非在席位不连(b9be)', byEdge.get('dispatch:st:b9be>fn:alpha/n1') === undefined)
    ok('SB1 dep/dispatch 无 at', (j?.edges ?? []).every((e) => e.kind !== 'dep' && e.kind !== 'dispatch' || !('at' in e)))
    const cb = byEdge.get(`callback:se:${SESS_FE86}>se:${SESS_ORCH}`)
    ok('SB1 callback 边(席码->全形 handle)', cb?.kind === 'callback' && ISO_RE.test(cb?.at ?? ''), JSON.stringify(cb))
    ok('SB1 callback 裸短码(ffff 前缀)解析', byEdge.get(`callback:se:${SESS_A804}>se:${SESS_ORCH}`)?.kind === 'callback')
    ok('SB1 cb-send 如实空集+注记', (j?.counts?.byKind?.['cb-send'] ?? -1) === 0 && /cb-send/.test(j?.sources?.bridge?.note ?? ''), j?.sources?.bridge?.note?.slice(0, 120))
    ok('SB1 悬挂票 dep 丢弃+note', byEdge.get('dep:tk:ghost-T>tk:T-C') === undefined && /ghost-T/.test(j?.note ?? ''))
    ok('SB1 悬挂 lease 丢弃', byEdge.get('dispatch:st:ghostseat>tk:T-D') === undefined)
    ok('SB1 悬挂 handle 丢弃+计数进 note', byEdge.get('callback:ghost-nobody>also-ghost') === undefined && /unresolved/.test(j?.sources?.bridge?.note ?? ''))
    ok('SB1 (from,to) 去重保留最新(解析对)', (j?.edges ?? []).filter((e) => e.kind === 'callback' && e.from === `se:${SESS_FE86}`).length === 1)
    ok('SB1 自环丢弃', byEdge.get(`callback:se:${SESS_FE86}>se:${SESS_FE86}`) === undefined)
    ok('SB1 坏行计数进 note', /unparsable/.test(j?.sources?.bridge?.note ?? ''))
    ok('SB1 全活: degraded=false', j?.degraded === false, `note=${(j?.note ?? '').slice(0, 80)}`)
    ok('SB1 partial(deadflow) 进 note 但面仍 live', j?.sources?.flows?.live === true && /deadflow/.test(j?.sources?.flows?.note ?? ''))
    ok('SB1 sources counts 语义(flows=节点/tickets=节点/fleet=席位/bridge=边)', j?.sources?.flows?.count === (j?.counts?.byType?.['flow-node'] ?? -1) && j?.sources?.tickets?.count === (j?.counts?.byType?.ticket ?? -1) && j?.sources?.fleet?.count === (j?.counts?.byType?.seat ?? -1) && j?.sources?.bridge?.count === (j?.counts?.byKind?.callback ?? -1) + (j?.counts?.byKind?.['cb-send'] ?? -1))

    // replay determinism (同上游两次调用, 除观测时刻 generatedAt/边 at 外逐字节同)
    const j2 = await req(g.port, '/op/graph').then((r) => r.json)
    const strip = (x) => JSON.stringify({ ...x, generatedAt: '', edges: (x?.edges ?? []).map((e) => ({ ...e, at: e.at ? '' : undefined })) })
    ok('SB1 同上游重放稳定(观测时刻外)', strip(j) === strip(j2))

    // §5 degradation: flows root removed
    rmSync(`${sb}/maestro/flows`, { recursive: true, force: true })
    const d1 = await req(g.port, '/op/graph').then((r) => r.json)
    ok('§5 flows 源挂: 仍 200 + 空集 + live=false + degraded=true', d1?.degraded === true && d1?.sources?.flows?.live === false && (d1?.counts?.byType?.['flow-node'] ?? -1) === 0, `status note=${(d1?.note ?? '').slice(0, 60)}`)
    ok('§5 flows 源挂: 其余面不受传染', (d1?.counts?.byType?.ticket ?? 0) >= 4 && d1?.sources?.tickets?.live === true)

    // §5 degradation: fleet.json removed -> seats empty, callback 边随节点消失
    rmSync(`${sb}/maestro/fleet.json`, { recursive: true, force: true })
    const d2 = await req(g.port, '/op/graph').then((r) => r.json)
    ok('§5 fleet 源挂: 席位空集 + live=false + degraded=true', d2?.sources?.fleet?.live === false && (d2?.counts?.byType?.seat ?? -1) === 0 && d2?.degraded === true)
    ok('§5 fleet 源挂: session/callback 连带空集(悬挂禁止)', (d2?.counts?.byType?.session ?? -1) === 0 && (d2?.counts?.byKind?.callback ?? -1) === 0)

    // §5 degradation: bridge log removed
    rmSync(`${sb}/maestro/bridge/inbox.log`, { recursive: true, force: true })
    const d3 = await req(g.port, '/op/graph').then((r) => r.json)
    ok('§5 bridge 源挂: live=false + callback 空 + degraded=true', d3?.sources?.bridge?.live === false && (d3?.counts?.byKind?.callback ?? -1) === 0 && d3?.degraded === true)
    ok('§5 bridge 源挂: 仍 200 恒律', d3?.op === 'graph')
  } finally {
    await stopDaemon(g.child)
  }
}

// SB2: boot with EVERYTHING absent -> all four planes live=false, zero envelopes, never 5xx.
{
  const sb = `${BASE}/sb2`
  rmSync(sb, { recursive: true, force: true })
  mkdirSync(`${sb}/maestro/bin`, { recursive: true }) // no ledger/flowc/fleet-list/flows/fleet.json/bridge
  const g = await startDaemon(sb, dsh.port)
  try {
    const r = await req(g.port, '/op/graph')
    ok('SB2 全源缺席: 恒 200', r.status === 200)
    const j = r.json
    ok('SB2 全源缺席: 四面 live=false + degraded=true', j?.degraded === true && ['flows', 'tickets', 'fleet', 'bridge'].every((k) => j?.sources?.[k]?.live === false))
    ok('SB2 全源缺席: 零节点零边但信封完整', j?.counts?.nodes === 0 && j?.counts?.edges === 0 && Array.isArray(j?.nodes) && Array.isArray(j?.edges))
    ok('SB2 全源缺席: byType/byKind 零值枚举齐', Object.values(j?.counts?.byType ?? {}).every((v) => v === 0) && Object.values(j?.counts?.byKind ?? {}).every((v) => v === 0))
    ok('SB2 既有 /op/* 不受累(红线: 零改动)', await req(g.port, '/op/fleet').then((x) => x.status === 200 && x.json?.op === 'fleet') && await req(g.port, '/op/tickets').then((x) => x.status === 200 && x.json?.op === 'tickets') && await req(g.port, '/op/flow').then((x) => x.status === 200 && x.json?.op === 'flow'))
    ok('SB2 SSE 零新 kind(红线): /subscribe 仍按旧面应答', await req(g.port, '/subscribe').then((x) => x.status === 400)) // 无 consumer -> 旧 400 契约不变
  } finally {
    await stopDaemon(g.child)
  }
}

dsh.server.close()
writeFileSync(`${BASE}/manifest.json`, `${JSON.stringify({ label: LABEL, gate: 'pmw2-1-graph', startedAt, finishedAt: new Date().toISOString(), pass, fail, version: VERSION, node: process.version, repo: REPO }, null, 2)}\n`)
console.log(`\n=== ${LABEL}: PASS=${pass} FAIL=${fail} (evidence: ${BASE}) ===`)
process.exit(fail === 0 ? 0 : 1)
