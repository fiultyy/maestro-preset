#!/usr/bin/env node
// pm-host-service daemon — ExecStart target of the systemd user unit.
//
// PM-001 (shell): stay alive, prove liveness, anchor Restart=on-failure.
// Exit discipline: SIGTERM/SIGINT exit NON-ZERO on purpose — systemd counts
// them as clean signals, so a bare `kill <pid>` would not otherwise be
// restarted. `systemctl stop` still stays stopped (stop jobs suppress
// Restart=). This process IS the unit's MainPID — wrapping it in flock(1)
// would move MainPID to the wrapper, whose signal-death is restart-exempt.
//
// PM-002 (HTTP projection skeleton): listen on 127.0.0.1:<random>, publish
// the port file $MAESTRO_HOME/maestro/pm.port (JSON metadata, 0600,
// temp+rename — this ticket's idempotency key is that file's path) and the
// pm.token explanation file (0600). Per ADR-005 the public net is the
// tailnet (network = auth), so token checking is an OPTIONAL placeholder:
// OFF unless PM_HOST_SERVICE_TOKEN is set. Single instance via flock(2)
// HELD BY THIS PROCESS: we open the lock file, a short-lived `flock -n <fd>`
// child binds LOCK_EX to the shared open-file description, and the lock
// lives as long as we keep the fd open — no wrapper process in the unit.
// A lock loser exits 0 quietly (no restart storm).
// PM-003 (ticket read projection, op=tickets): first pull via
// `$MAESTRO_HOME/maestro/bin/ledger ticket list --json`, then serve from the
// in-memory cache until the tickets.md signature (mtime_ns+size, BigInt
// stat) changes — signature polling is the cheap change detector, the CLI
// the only authority (ADR-002 read-side; this process NEVER opens a ledger
// sqlite). Cursor $MAESTRO_HOME/maestro/state/tickets.cursor.json (0600,
// temp+rename, skip-if-identical) persists the signature per ADR-007.2.
// Degraded discipline: ledger gone (PATH removal simulation kills its
// `env python3` shebang) or non-zero exit -> 200 + degraded:true + note,
// serving stale cache when we have one, empty list when we don't — no 5xx.
// Projection endpoints (op=fleet/trace/flow, PM-004..006) and the
// full health/degraded meta endpoint (PM-009) land here later.
// PM-004 (seat read projection, op=fleet): in-memory join, ZERO disk writes
// (ADR-007.2: no state at all — real-time compute). fleet.json direct read
// (bin/fleet-list CLI as fallback authority) joined over the dsh loopback
// RPC /api/session.list (POST client-request frame, DSH_PORT default 3080,
// 8s abort). The joined fields are identity+liveness only (running/blank/
// preset/cwd/title) — deliberately NO updatedAt/tokens, so the payload is
// deterministic for same-upstream replays. dsh unreachable/timeout ->
// 200 + pure fleet view + degraded:true + note, never 5xx.
// PM-005 (trace read projection, op=trace): direct read of the session
// event log ~/.dsh/sessions/<bucket>/<sid>/session.jsonl.zstd (bucket scan
// = session-purge findSessionDir pattern; NO disk writes, one in-memory
// decode cache keyed by file mtime_ns+size). The log is APPENDED as
// separate zstd frames — node's decoder stops at the first frame, so we
// split on the frame magic 28 B5 2F FD and inflate frame-by-frame.
// Filters: type (exact, comma list) / tool (data.name) / text (raw-line
// substring, case-insensitive) / seqFrom..seqTo (record.seq). Fold:
// head.compact semantic-equivalent (KG 14 §2.5 via ADR-010) — when the
// filtered payload exceeds 20k chars the OLDER entries collapse into ONE
// deterministic single-line snapshot (type trace.compact: counts, seq
// range, type histogram, reason:"threshold") and the most recent tail
// stays verbatim; zero LLM, content-derived only -> sha-stable replays.
// PM-006 (flow read projection, op=flow): flows/<id>/state.db via node:sqlite
// READ-ONLY connections (zero npm dep), v_status/v_rollup views, per-flow
// degrade (one locked/corrupt db never takes down the rest), ORDER BY for
// stable output. Whole-plane degraded only when EVERY db is unreadable ->
// flowc inspect CLI polling as the last-resort fallback, else empty+note —
// never 5xx. Note on lock simulation: the dbs are WAL, where writer locks
// do NOT block readers; unreadability (chmod 000) is the equivalent
// unavailable-simulation that exercises the same open-failure path.
// PM-007 (event fanout, GET /subscribe?consumer=<sessionId>&kinds=<csv>):
// per-consumer SSE stream. Idempotency keys: subscription = (consumer,
// kinds); event = (source, msgid) dedup. Side effects: fs.watch on the
// three data planes (maestro dir filtered to ledger.db / ledger.db-wal /
// fleet.json; flows/ recursive) -> signature projection -> push, PLUS a 2s
// reconcile poll as the second channel (inotify is best-effort) — the two
// channels double-report every change on purpose, and the deterministic
// msgid `<kind>:<base>:<mtime_ns>:<size>` + 60s dedup window turn that into
// exactly-once delivery. On subscribe: snapshot replay FIRST (ring buffer
// capped at 50, kinds-filtered, resuming after the consumer's persisted
// cursor when that cursor is from this boot — seq is only comparable within
// one boot, so a cross-boot cursor replays the whole ring), then live
// increments. Storage per ADR-007.2 (files by default): per-consumer cursor
// JSON + shared dedup-window JSON under state/subscribers/ (temp+rename,
// skip-if-identical; dedup window 60s, >1000 entries -> keep-newest-half
// GC). Stream termination sends a pm_sub_ended frame when the SERVER ends
// the stream (same-consumer replacement); a client disconnect just cleans
// up — the persisted cursor makes the resubscribe seamless.
// PM-008 (write passthrough, POST /op/act): the write-side of ADR-002 —
// this daemon NEVER implements ledger writes and NEVER opens a sqlite for
// writing; every write action is passed through to an allowlisted maestro
// CLI binary (naturally idempotent verbs, ADR-007) spawned async. Per
// action a ref `vh-<8hex>` is minted (node:crypto) or taken from the
// client's retry key; the phase-1 HTTP receipt returns immediately
// {accepted,ref} and settlement flows back through the PM-007 fanout as
// kind 'act' events carrying the ref (additive frame fields). State per
// ADR-007.2 (files): state/act/registry.json = in-flight + terminal
// entries (temp+rename; a same-ref replay answers from the registry with
// ZERO second CLI spawn — this ticket's idempotency gate),
// state/act/audit.jsonl = append-only audit (accept + settle lines; an
// audit write failure logs a warning and NEVER blocks the main chain).
// CLI death is a tripwire: spawn error, non-zero exit or timeout all
// settle as status=error WITH the error event still emitted. A daemon
// restart mid-flight marks orphaned 'flying' entries 'interrupted'
// (replay reports it; a fresh ref resubmits).
// PM-009 (health & degraded meta, GET /health): per-source live/degraded
// probes over EVERY projected source plane (ledger.db + ledger CLI /
// tickets.md signature / fleet.json + fleet-list / dsh loopback RPC /
// sessions root / per-flow state.db SQL self-walk), plus version and the
// systemd bootstrap state (unit file + `systemctl --user is-enabled /
// is-active`, 5s cache). Probes are read-only and individually guarded: a
// probe that fails marks ITS source degraded with a note — the endpoint
// itself NEVER 5xxes; even with every source down it answers 200 +
// status:"degraded" so tk can render empty states (spec gate).
// PMW2-1 (canvas graph projection, GET /op/graph): spec
// docs/specs/spec-pm-web-canvas.md §1/§2 frozen contract — four node types
// (flow-node fn:<flow>/<id> / ticket tk:<id> / seat st:<code> / session
// se:<sid>) × four edge kinds (dep / dispatch / callback / cb-send), edge id
// `<kind>:<from>><to>`, response envelope field-for-field, 恒 200: any dead
// source contributes the EMPTY SET + sources.<plane>.live=false + top
// degraded:true, never 5xx. Sources: flows state.db (v_status + nodes.deps,
// per-flow degrade like PM-006), tickets via serveTickets() (SAME PM-003
// cache instance — zero double pull, PMW1-4 db-signature semantics), fleet
// seats (readSeats) joined over dsh loopback session.list (session nodes
// only with live join data; join loss = sessions empty set, spec-legal),
// bridge inbox.log near-window 200 lines ((from,to) dedup keep-latest,
// handles resolved to graph nodes — unresolved endpoints drop the edge into
// sources.bridge.note, 悬挂禁止). cb-send is the honest empty set today: the
// flows/ledger schema has NO structured orchestrator-seat→worker-seat
// dispatch record (annotated in sources.bridge.note per spec §1.2). SSE
// gains zero new kinds — clients refetch on the existing event kinds.
//
// Zero npm deps; node:* ESM only. Read projections only (ADR-002): never
// opens a ledger/sqlite for writing; writes go through maestro CLI (PM-008).
import { createServer } from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { zstdDecompressSync } from 'node:zlib'
import { accessSync, appendFileSync, chmodSync, closeSync, constants, mkdirSync, openSync, readSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, watch, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'

const VERSION = '0.10.0'
const SERVICE = 'pm-host-service'
const ROOT = process.env.MAESTRO_HOME ?? `${homedir()}/.dsh`
const LOG_DIR = process.env.PM_HOST_SERVICE_LOG_DIR ?? `${ROOT}/maestro/logs/${SERVICE}`
const LOG = `${LOG_DIR}/daemon.log`
const PORT_FILE = `${ROOT}/maestro/pm.port`
const TOKEN_FILE = `${ROOT}/maestro/pm.token`
const LOCK_PATH = process.env.PM_HOST_SERVICE_LOCK ?? `${ROOT}/maestro/${SERVICE}.lock`
const TICKETS_MD = process.env.PM_HOST_SERVICE_TICKETS_MD ?? `${ROOT}/maestro/tickets.md`
const LEDGER_BIN = process.env.PM_HOST_SERVICE_LEDGER ?? `${ROOT}/maestro/bin/ledger`
const STATE_DIR = process.env.PM_HOST_SERVICE_STATE_DIR ?? `${ROOT}/maestro/state`
const CURSOR_FILE = `${STATE_DIR}/tickets.cursor.json`
const FLEET_FILE = process.env.MAESTRO_FLEET ?? `${ROOT}/maestro/fleet.json`
const FLEET_LIST_BIN = process.env.PM_HOST_SERVICE_FLEET_LIST ?? `${ROOT}/maestro/bin/fleet-list`
const DSH_PORT = process.env.DSH_PORT ?? '3080'
const SESSIONS_ROOT = process.env.DSH_SESSIONS_ROOT ?? `${ROOT}/sessions`
const FLOWS_ROOT = process.env.MAESTRO_FLOWS_ROOT ?? `${ROOT}/maestro/flows`
const FLOWC_BIN = process.env.PM_HOST_SERVICE_FLOWC ?? `${ROOT}/maestro/bin/flowc`
const BRIDGE_LOG = process.env.PM_HOST_SERVICE_BRIDGE_LOG ?? `${ROOT}/maestro/bridge/inbox.log`
const TRACE_BUDGET_CHARS = 20_000 // head.compact threshold (KG 14 §2.5 default)
const TRACE_KEEP_MAX_ENTRIES = 500
const TRACE_FILE_MAX_BYTES = 64 * 1024 * 1024
const TOKEN = process.env.PM_HOST_SERVICE_TOKEN ?? '' // ADR-005: default OFF

mkdirSync(LOG_DIR, { recursive: true }) // idempotent (PM-001 side effect ③)

function log(msg) {
  try {
    try { if (statSync(LOG).size > 2_000_000) renameSync(LOG, `${LOG}.1`) } catch {}
    appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`)
  } catch {}
}

// temp+rename atomic write (0600); skips when content is already identical —
// the file-side of the ADR-007 replay rule (repeat execution, zero change).
function writeFileIfChanged(file, data, mode = 0o600) {
  try { if (readFileSync(file, 'utf8') === data) return 'skip: identical' } catch {}
  const tmp = `${file}.tmp.${process.pid}`
  try {
    mkdirSync(dirname(file), { recursive: true }) // fresh ROOT (e.g. empty MAESTRO_HOME) must not crash the daemon
    writeFileSync(tmp, data, { mode })
    renameSync(tmp, file) // same-directory rename = atomic replace
    return 'write: temp+rename'
  } catch (e) {
    try { unlinkSync(tmp) } catch {}
    throw e
  }
}

const jsonDoc = (obj) => `${JSON.stringify(obj, null, 2)}\n`

// Single-instance guard, run before ANY other side effect so a lock loser
// leaves no trace. flock(2) binds to the open-file description we share via
// fd inheritance; the short-lived holder child may exit, the lock stays with
// our open fd. Loss = another instance is live: exit 0 (clean, so a manual
// double start or a racing restart never triggers a systemd restart storm).
function acquireSingletonLock() {
  let fd
  try { mkdirSync(dirname(LOCK_PATH), { recursive: true }); fd = openSync(LOCK_PATH, 'a+') } catch (e) { log(`lock open failed (${e?.message}) — proceeding unlocked`); return 'unavailable' }
  const r = spawnSync('flock', ['-n', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd] })
  if (r.error) { log(`flock unavailable (${r.error.message}) — proceeding unlocked`); return 'unavailable' }
  if (r.status !== 0) {
    log(`another instance holds ${LOCK_PATH} -> exit 0`)
    try { closeSync(fd) } catch {}
    process.exit(0)
  }
  return 'held' // fd stays open for the process lifetime = lock held
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { log(`${sig} -> exit 1 (Restart=on-failure pulls back)`); process.exit(1) })
}

const lockState = acquireSingletonLock()
const startedMs = Date.now()
log(`daemon up pid=${process.pid} node=${process.version} root=${ROOT} lock=${lockState} tokenAuth=${TOKEN !== ''}`)

function publishTokenDoc() {
  const doc = {
    tokenAuth: TOKEN !== '',
    enabledWhen: 'env PM_HOST_SERVICE_TOKEN is non-empty (checked per request)',
    header: 'Authorization: Bearer <PM_HOST_SERVICE_TOKEN>',
    note: 'ADR-005 公网豁免: Tailscale 组网即鉴权, 应用层鉴权默认禁用。本文件是可选占位说明(0600), 不是凭据。',
  }
  return writeFileIfChanged(TOKEN_FILE, jsonDoc(doc))
}
publishTokenDoc()

// ---- PM-003: op=tickets (read-side projection, naturally idempotent) ----
// In-memory cache is the serving plane; the ledger CLI is the pull plane.
// PMW1-4 (E3 fix): cache validity keys on the SAME signature the event
// fanout keys tickets events on — ledgerSig() = ledger.db(+wal) — with the
// tickets.md signature kept as a legacy co-key. Before this, a CLI db
// write (add/state do NOT render md) fired the SSE event that made the
// page refetch, only for the md-keyed cache to HIT stale data; and a later
// manual `ticket render` refreshed the cache with no event to make the
// page refetch — two correct halves, structurally stale together
// (gates/pm009/pmw1-3-acceptance.md E3). db sig = freshness authority
// (ADR-002: the CLI/db IS the truth); md sig = render-observable co-key
// (a manual md edit also re-pulls from the authority). No wide-table
// cache (ADR-007.2: R1/R3 not triggered); the cursor file records the
// served signatures (temp+rename, skip-if-identical).
const tickets = { list: null, sig: null, dbSig: null, pulledAt: null, cliSpawns: 0 }

const mdSignature = () => {
  try { const s = statSync(TICKETS_MD, { bigint: true }); return `${s.mtimeNs}:${s.size}` } catch { return 'missing' }
}

function pullLedgerTickets() {
  tickets.cliSpawns++
  const r = spawnSync(LEDGER_BIN, ['ticket', 'list', '--json'], { encoding: 'utf8', timeout: 8000 })
  if (r.error) throw new Error(`spawn failed (PATH/shebang?): ${r.error.message}`)
  if (r.status !== 0) throw new Error(`exit ${r.status}: ${(r.stderr || r.stdout || '').trim().slice(0, 160)}`)
  const data = JSON.parse(r.stdout)
  const list = Array.isArray(data) ? data : data?.tickets
  if (!Array.isArray(list)) throw new Error('ledger output is not a ticket array')
  return list
}

// HF-016: light liveness re-probe for the cache-HIT path (zero spawns, zero
// pulls): CLI executable + ledger.db absent-or-readable (HF-009 semantics).
// The served content stays pull-time, but `degraded` no longer claims
// pull-time health forever — it reflects this cheap probe at answer time.
function ledgerProbeOk() {
  try { accessSync(LEDGER_BIN, constants.X_OK) } catch { return false }
  try { closeSync(openSync(`${ROOT}/maestro/ledger.db`, 'r')); return true } catch (e) { return e?.code === 'ENOENT' }
}

function serveTickets() {
  const sig = mdSignature()
  const dbSig = ledgerSig() // PMW1-4: the event plane's tickets key — db OR md sig drift forces a fresh pull
  if (tickets.list !== null && tickets.sig === sig && tickets.dbSig === dbSig) { // replay: zero cli spawns, zero writes
    const probeOk = ledgerProbeOk() // HF-016: degraded reflects a light probe, not pull-time health forever
    return { op: 'tickets', count: tickets.list.length, tickets: tickets.list, cache: 'hit', degraded: !probeOk, note: probeOk ? '' : `ledger light-probe failed since last pull (${tickets.pulledAt}) — serving pull-time cache`, signature: sig, dbSignature: dbSig, cliSpawns: tickets.cliSpawns, pulledAt: tickets.pulledAt }
  }
  try {
    const list = pullLedgerTickets()
    tickets.list = list
    tickets.sig = sig
    tickets.dbSig = dbSig // recorded only on success: a failed pull keeps missing (retry next serve)
    tickets.pulledAt = new Date().toISOString()
    mkdirSync(STATE_DIR, { recursive: true })
    const cursorAction = writeFileIfChanged(CURSOR_FILE, jsonDoc({
      signature: sig,
      dbSignature: dbSig,
      ticketCount: list.length,
      pulledAt: tickets.pulledAt,
      version: VERSION,
    }))
    log(`op=tickets pull ok count=${list.length} sig=${sig} cursor=${cursorAction}`)
    return { op: 'tickets', count: list.length, tickets: list, cache: 'miss', degraded: false, note: '', signature: sig, dbSignature: dbSig, cliSpawns: tickets.cliSpawns, pulledAt: tickets.pulledAt, cursor: cursorAction }
  } catch (e) {
    const have = tickets.list !== null
    const note = `ledger unavailable: ${String(e?.message ?? e).slice(0, 220)}`
    log(`op=tickets DEGRADED ${note} (serving ${have ? 'stale cache' : 'empty list'})`)
    return { op: 'tickets', count: have ? tickets.list.length : 0, tickets: have ? tickets.list : [], cache: have ? 'stale' : 'empty', degraded: true, note, signature: sig, dbSignature: dbSig, cliSpawns: tickets.cliSpawns, pulledAt: tickets.pulledAt }
  }
}

// ---- PM-004: op=fleet (seat read projection; in-memory join, no writes) ----
const SEAT_KEYS = ['sessionId', 'role', 'node', 'preset', 'spawnedAt', 'status']
const normSeat = (code, s) => {
  const seat = { code }
  for (const k of SEAT_KEYS) seat[k] = s?.[k] ?? null
  return seat
}

function readSeats() { // fleet.json direct; bin/fleet-list CLI as fallback authority
  try {
    const map = JSON.parse(readFileSync(FLEET_FILE, 'utf8'))?.fleet
    if (!map || typeof map !== 'object' || Array.isArray(map)) throw new Error('fleet.json has no fleet map')
    // HF-017: an EMPTY map is structurally valid (zero seats fielded) — empty
    // != broken; only a missing/malformed map falls to the fallback authority.
    return Object.entries(map).map(([code, s]) => normSeat(code, s))
  } catch (e1) {
    const r = spawnSync(FLEET_LIST_BIN, [], { encoding: 'utf8', timeout: 8000 })
    if (r.error || r.status !== 0) throw new Error(`fleet.json unreadable (${String(e1?.message ?? e1).slice(0, 100)}) and fleet-list fallback failed`)
    const list = JSON.parse(r.stdout)
    if (!Array.isArray(list) || !list.length) throw new Error('fleet-list fallback returned no seats')
    return list.map((s) => normSeat(s.code, s))
  }
}

let joinSeq = 0
async function fetchSessionJoin() { // dsh loopback session.list -> Map(sid->session 投影); throw = 上游不可用/超时 (身份+活性投影, 波动指标不入射以保同上游重放字节一致)
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), JOIN_DSH_TIMEOUT_MS)
  try {
    const res = await fetch(`http://127.0.0.1:${DSH_PORT}/api/session.list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: `pm-host-service-fleet-${++joinSeq}`, method: 'session.list', payload: {} }),
      signal: ctl.signal,
    })
    if (!res.ok) throw new Error(`http ${res.status}`)
    const data = await res.json()
    if (data?.result?.ok !== true) throw new Error(`rpc error: ${JSON.stringify(data?.result?.error ?? 'unknown').slice(0, 120)}`)
    const bySid = new Map()
    for (const s of data.result.value?.items ?? []) {
      bySid.set(s.sessionId, {
        running: !!s.running,
        blank: !!s.blank,
        agentPreset: s.agentPreset ?? null,
        cwd: s.cwd ?? null,
        title: s.projections?.values?.title ?? null,
      })
    }
    return bySid
  } finally {
    clearTimeout(timer)
  }
}
const applySessionJoin = (seats, bySid) => seats.map((seat) => ({ ...seat, session: bySid.get(seat.sessionId) ?? null }))

// PMW2-J: join 结果 TTL 缓存 + stale-while-revalidate — dsh 宿主退化 (session.list >30s) 时
// /op/fleet 命中缓存立即回 (横幅不再间歇闪); 过期后台异步刷新, 失败只累积 note; 冷启动首拉
// 允许阻塞, 超时如实 degraded (现行为)。字段只增: +sessionJoinFreshness。
const JOIN_CACHE_TTL_MS = Number(process.env.PM_JOIN_CACHE_TTL_MS) || 60_000
let joinCache = null // { bySid: Map(sid->session), fetchedAt: ms }
let joinRefreshing = false
let joinRefreshErrors = { count: 0, last: '' }

async function refreshJoinCache() { // 后台异步刷新: 成功翻新缓存; 失败只累积注记, 绝不影响在途响应
  if (joinRefreshing) return
  joinRefreshing = true
  try {
    const bySid = await fetchSessionJoin()
    joinCache = { bySid, fetchedAt: Date.now() }
    if (joinRefreshErrors.count > 0) log(`op=fleet join cache recovered after ${joinRefreshErrors.count} failed refreshes`)
    joinRefreshErrors = { count: 0, last: '' }
  } catch (e) {
    joinRefreshErrors.count++
    joinRefreshErrors.last = String(e?.message ?? e).slice(0, 100)
    log(`op=fleet join background refresh failed x${joinRefreshErrors.count}: ${joinRefreshErrors.last}`)
  } finally {
    joinRefreshing = false
  }
}

async function serveFleet() {
  let seats
  try {
    seats = readSeats()
  } catch (e) {
    return { op: 'fleet', count: 0, seats: [], degraded: true, sessionJoined: false, note: `fleet sources unavailable: ${String(e?.message ?? e).slice(0, 160)}` }
  }
  seats.sort((a, b) => (a.code < b.code ? -1 : 1)) // deterministic order
  if (joinCache) { // 缓存命中: 立即回 (stale-while-revalidate), 不阻塞不闪横幅
    const ageMs = Date.now() - joinCache.fetchedAt
    const fresh = ageMs <= JOIN_CACHE_TTL_MS
    if (!fresh && !joinRefreshing) refreshJoinCache() // fire-and-forget 后台刷新
    const seats2 = applySessionJoin(seats, joinCache.bySid)
    // fresh 命中 note='' 与冷启动响应字节一致 (PM-004 replay byte-stable); 新鲜度走只增字段 sessionJoinFreshness
    let note = fresh ? '' : `sessionJoin: stale age=${Math.round(ageMs / 1000)}s`
    if (joinRefreshErrors.count > 0) note += `${note ? '; ' : ''}后台刷新失败 x${joinRefreshErrors.count} (${joinRefreshErrors.last})`
    return { op: 'fleet', count: seats2.length, seats: seats2, degraded: false, sessionJoined: true, sessionJoinFreshness: fresh ? 'fresh' : 'stale', note }
  }
  try { // 冷启动: 首拉允许阻塞, 超时如实 degraded (现行为)
    const bySid = await fetchSessionJoin()
    joinCache = { bySid, fetchedAt: Date.now() }
    const seats2 = applySessionJoin(seats, bySid)
    return { op: 'fleet', count: seats2.length, seats: seats2, degraded: false, sessionJoined: true, sessionJoinFreshness: 'fresh', note: '' }
  } catch (e) {
    const note = `dsh session.list unreachable (127.0.0.1:${DSH_PORT}): ${String(e?.message ?? e).slice(0, 140)} — pure fleet view`
    log(`op=fleet DEGRADED ${note}`)
    return { op: 'fleet', count: seats.length, seats, degraded: true, sessionJoined: false, note }
  }
}

// ---- PM-005: op=trace (trace read projection; JSONL direct read, no writes) ----
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const traceCache = { path: '', sig: '', lines: null }

function findSessionDir(sid) { // session-purge findSessionDir pattern: bucket scan
  try {
    for (const bucket of readdirSync(SESSIONS_ROOT)) {
      const cand = `${SESSIONS_ROOT}/${bucket}/${sid}`
      try { if (statSync(cand).isDirectory()) return cand } catch {}
    }
  } catch {}
  return null
}

function loadTraceLines(dir) {
  const file = `${dir}/session.jsonl.zstd`
  const st = statSync(file, { bigint: true })
  if (st.size > TRACE_FILE_MAX_BYTES) throw new Error(`session log too large (${st.size} bytes)`)
  const sig = `${st.mtimeNs}:${st.size}`
  if (traceCache.path === file && traceCache.sig === sig) return { lines: traceCache.lines, sig, file }
  const buf = readFileSync(file)
  const offs = []
  let i = 0
  while ((i = buf.indexOf(ZSTD_MAGIC, i)) !== -1) { offs.push(i); i += 4 }
  if (!offs.length) throw new Error('not a zstd session log')
  let text = ''
  let truncated = false
  for (let k = 0; k < offs.length; k++) {
    const part = buf.subarray(offs[k], k + 1 < offs.length ? offs[k + 1] : buf.length)
    try { text += zstdDecompressSync(part).toString('utf8') } catch { truncated = true; break } // torn tail frame: keep what we have
  }
  const lines = text.split('\n').filter((l) => l.length > 0)
  traceCache.path = file; traceCache.sig = sig; traceCache.lines = lines
  return { lines, sig, file, truncated }
}

function serveTrace(q) {
  const sid = q.get('sessionId')
  const dir = findSessionDir(sid)
  if (!dir) return { op: 'trace', sessionId: sid, status: 'miss', entries: [], note: `no session dir under ${SESSIONS_ROOT}/*/${sid}` }
  const { lines, sig, truncated } = loadTraceLines(dir)

  const typeParam = q.get('type')
  const typeSet = typeParam ? new Set(typeParam.split(',').map((s) => s.trim()).filter(Boolean)) : null
  const tool = q.get('tool')
  const text = q.get('text')
  const intParam = (name) => { const v = q.get(name); if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null }
  const seqFrom = intParam('seqFrom')
  const seqTo = intParam('seqTo')
  const needle = text ? text.toLowerCase() : null

  const entries = []
  const histogram = {}
  let parseFailures = 0
  let matchedChars = 0
  let minSeq = null
  let maxSeq = null
  for (const raw of lines) {
    let rec
    try { rec = JSON.parse(raw) } catch { parseFailures++; continue }
    const t = rec.type ?? '_unknown'
    histogram[t] = (histogram[t] || 0) + 1
    if (typeSet && !typeSet.has(t)) continue
    if (tool) { const tn = rec.data?.name ?? rec.data?.toolName ?? rec.data?.tool?.name; if (tn !== tool) continue }
    if (seqFrom != null && !(typeof rec.seq === 'number' && rec.seq >= seqFrom)) continue
    if (seqTo != null && !(typeof rec.seq === 'number' && rec.seq <= seqTo)) continue
    if (needle && !raw.toLowerCase().includes(needle)) continue
    entries.push(rec)
    matchedChars += raw.length + 1
    if (typeof rec.seq === 'number') {
      if (minSeq == null || rec.seq < minSeq) minSeq = rec.seq
      if (maxSeq == null || rec.seq > maxSeq) maxSeq = rec.seq
    }
  }
  // fold decision input = the payload actually served (re-serialized length,
  // may exceed the raw-char sum under escaping) — surfaced as
  // matched.payload_chars so `folded` reads unambiguously as "fold APPLIED
  // because payload_chars > budget" (orchestrator note on PM-005 semantics).
  const payloadChars = JSON.stringify(entries).length

  // head.compact fold (KG 14 §2.5; JS semantic-equivalent per ADR-010):
  // over-budget filtered payload -> the older (head) entries collapse into
  // ONE deterministic single-line snapshot, the recent tail stays verbatim.
  let folded = false
  let outEntries = entries
  let droppedEntries = 0
  let droppedChars = 0
  const droppedHistogram = {}
  if (payloadChars > TRACE_BUDGET_CHARS) {
    folded = true
    const keepBudget = Math.floor(TRACE_BUDGET_CHARS * 0.6)
    let keptChars = 0
    let count = 0
    let cut = 0
    for (let k = entries.length - 1; k >= 0; k--) {
      const c = JSON.stringify(entries[k]).length + 1
      if (count >= TRACE_KEEP_MAX_ENTRIES || keptChars + c > keepBudget) { cut = k + 1; break }
      keptChars += c
      count++
      if (k === 0) cut = 0
    }
    const droppedList = entries.slice(0, cut)
    const keptList = entries.slice(cut)
    droppedEntries = droppedList.length
    droppedChars = droppedList.reduce((a, r) => a + JSON.stringify(r).length + 1, 0)
    for (const r of droppedList) { const t = r.type ?? '_unknown'; droppedHistogram[t] = (droppedHistogram[t] || 0) + 1 }
    const summary = {
      type: 'trace.compact',
      reason: 'threshold',
      algorithm: 'head.compact (KG 14 §2.5; JS semantic-equivalent, ADR-010)',
      threshold: TRACE_BUDGET_CHARS,
      dropped: { entries: droppedEntries, chars: droppedChars, type_histogram: droppedHistogram },
      kept: { entries: keptList.length, chars: keptChars },
      seq_range: [minSeq, maxSeq],
    }
    outEntries = [summary, ...keptList]
  }

  return {
    op: 'trace',
    sessionId: sid,
    signature: sig,
    totalLines: lines.length,
    parseFailures,
    logTruncated: !!truncated,
    filter: { type: typeParam || null, tool: tool || null, text: text || null, seqFrom, seqTo },
    matched: { entries: entries.length, chars: matchedChars, payload_chars: payloadChars, seq_range: [minSeq, maxSeq], type_histogram: histogram },
    folded,
    budget: TRACE_BUDGET_CHARS,
    dropped: folded ? { entries: droppedEntries, chars: droppedChars } : { entries: 0, chars: 0 },
    entries: outEntries,
  }
}

// ---- PM-006: op=flow (flow read projection; SQL self-walking, no writes) ----
function serveFlow() {
  let names = []
  try {
    names = readdirSync(FLOWS_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
  } catch (e) {
    return { op: 'flow', count: 0, flows: [], degraded: true, note: `flows root unavailable: ${String(e?.message ?? e).slice(0, 140)}` }
  }
  const flows = []
  const notes = []
  for (const name of names) {
    const dbPath = `${FLOWS_ROOT}/${name}/state.db`
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true }) // read-side red line: never a write handle
      try {
        const nodes = db.prepare('SELECT * FROM v_status ORDER BY node_id').all()
        const rollup = db.prepare('SELECT * FROM v_rollup ORDER BY state').all()
        flows.push({ flow: name, source: 'sql', degraded: false, nodes, rollup })
      } finally { db.close() }
    } catch (e) { // locked / unreadable / corrupt: degrade THIS flow only, 200 always
      const note = `state.db unreadable: ${String(e?.message ?? e).slice(0, 110)}`
      flows.push({ flow: name, source: 'sql', degraded: true, nodes: [], rollup: [], note })
      notes.push(`${name}: ${note}`)
    }
  }
  let cliFallback = null
  const failed = flows.filter((f) => f.degraded).length
  if (flows.length > 0 && failed === flows.length) { // every db dead -> flowc inspect as last resort
    try {
      const r = spawnSync(FLOWC_BIN, ['inspect'], { encoding: 'utf8', timeout: 8000 })
      cliFallback = { ran: true, ok: !r.error && r.status === 0, raw: (r.stdout || r.stderr || '').slice(0, 500) }
    } catch (e) {
      cliFallback = { ran: true, ok: false, raw: String(e?.message ?? e).slice(0, 200) }
    }
  }
  return {
    op: 'flow',
    count: flows.length,
    flows,
    degraded: flows.length === 0 ? true : failed === flows.length,
    sqlFailed: failed,
    cliFallback,
    note: notes.join('; ').slice(0, 220),
  }
}

// ---- PMW2-1: op=graph (canvas plane projection; additive over PM-003..006) ----
// Spec docs/specs/spec-pm-web-canvas.md §1/§2 (frozen, field-for-field):
// 严守字段表 — nodes/edges 专有字段逐字段照抄, 无自创; sources.<plane>.count =
// 该面对图的节点贡献 (bridge 面零节点, 计其边); note 仅注记, live 才是断源信号。
const GRAPH_TAIL_BYTES = 1_000_000 // bridge tail-read cap: only the near-window matters
const GRAPH_BRIDGE_WINDOW = 200 // spec §1.2: near-window line count
const GRAPH_SID_RE = /(session-[0-9a-fA-F-]{8,})$/ // full or alias@session-<uuid> handle form
let graphJoinSeq = 0

async function fetchSessionMap() { // dsh loopback session.list -> Map(sid -> {running,title,cwd}); throws -> caller degrades
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), JOIN_DSH_TIMEOUT_MS)
  try {
    const res = await fetch(`http://127.0.0.1:${DSH_PORT}/api/session.list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: `pm-host-service-graph-${++graphJoinSeq}`, method: 'session.list', payload: {} }),
      signal: ctl.signal,
    })
    if (!res.ok) throw new Error(`http ${res.status}`)
    const data = await res.json()
    if (data?.result?.ok !== true) throw new Error(`rpc error: ${JSON.stringify(data?.result?.error ?? 'unknown').slice(0, 120)}`)
    const map = new Map()
    for (const s of data.result.value?.items ?? []) {
      map.set(s.sessionId, { running: !!s.running, title: s.projections?.values?.title ?? null, cwd: s.cwd ?? null })
    }
    return map
  } finally {
    clearTimeout(timer)
  }
}

function readBridgeWindow() { // last <=GRAPH_BRIDGE_WINDOW complete lines (tail slice drops its torn head line)
  let text
  let sliced = false
  try {
    const st = statSync(BRIDGE_LOG)
    const start = Math.max(0, st.size - GRAPH_TAIL_BYTES)
    sliced = start > 0
    const fh = openSync(BRIDGE_LOG, 'r')
    try {
      const buf = Buffer.alloc(st.size - start)
      readSync(fh, buf, 0, buf.length, start)
      text = buf.toString('utf8')
    } finally { closeSync(fh) }
  } catch (e) {
    throw new Error(`bridge inbox.log unreadable: ${String(e?.message ?? e).slice(0, 120)}`)
  }
  const lines = text.split('\n').filter((l) => l.trim().length > 0)
  if (sliced && lines.length) lines.shift()
  return lines.slice(-GRAPH_BRIDGE_WINDOW)
}

function gatherBridgePairs() { // (from,to) dedup keep-latest, in file order = recency order
  const lines = readBridgeWindow()
  const latest = new Map()
  let bad = 0
  for (const line of lines) {
    let r
    try { r = JSON.parse(line) } catch { bad++; continue }
    if (typeof r?.from !== 'string' || typeof r?.to !== 'string' || !r.from || !r.to) { bad++; continue }
    latest.set(`${r.from}\u0000${r.to}`, { from: r.from, to: r.to }) // re-set on a later sighting = keep-latest
  }
  return { pairs: [...latest.values()], bad }
}

function graphResolveHandle(h, ctx) { // bridge handle -> emitted node id | null (unresolvable -> edge drops)
  if (typeof h !== 'string') return null
  const t = h.trim()
  const m = GRAPH_SID_RE.exec(t) // full `alias@session-<uuid>` / bare session id
  if (m) {
    const sid = m[1]
    if (ctx.sessionIds.has(sid)) return `se:${sid}`
    if (ctx.seatBySessionId.has(sid)) return `st:${ctx.seatBySessionId.get(sid)}` // session gone, seat remains
    return null
  }
  if (ctx.seatByCode.has(t)) { // bare seat code (fleet code, e.g. a804)
    const sid = ctx.seatByCode.get(t).sessionId
    if (typeof sid === 'string' && ctx.sessionIds.has(sid)) return `se:${sid}`
    return `st:${t}`
  }
  if (/^[0-9a-f]{4,8}$/.test(t)) { // bare short code (e.g. af29) -> unique prefix of a known session id
    for (const sid of ctx.sessionIds) if (sid.startsWith(`session-${t}`)) return `se:${sid}`
  }
  return null
}

function gatherFlowGraph(seatCodes) { // flow-node nodes + intra-flow dep edges + dispatch 子源②; per-flow degrade like PM-006
  const nodes = []
  const edges = []
  const notes = []
  let names = []
  try {
    names = readdirSync(FLOWS_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
  } catch (e) {
    return { nodes, edges, live: false, note: `flows root unavailable: ${String(e?.message ?? e).slice(0, 140)}` }
  }
  if (!names.length) return { nodes, edges, live: false, note: `no flows under ${FLOWS_ROOT}` }
  let failed = 0
  for (const name of names) {
    try {
      const db = new DatabaseSync(`${FLOWS_ROOT}/${name}/state.db`, { readOnly: true }) // read-side red line: never a write handle
      let rows
      let depRows
      let eventRows
      try {
        rows = db.prepare('SELECT node_id, verb, state, attempts, events FROM v_status ORDER BY node_id').all()
        depRows = db.prepare('SELECT node_id, deps FROM nodes ORDER BY node_id').all()
        eventRows = db.prepare('SELECT node_id, detail FROM events ORDER BY id').all() // dispatch 子源② source (§1.2)
      } finally { db.close() }
      const ids = new Set(rows.map((r) => `${name}/${r.node_id}`))
      const verbOf = new Map(rows.map((r) => [r.node_id, r.verb]))
      for (const r of rows) {
        nodes.push({ id: `fn:${name}/${r.node_id}`, type: 'flow-node', label: r.node_id, nodeId: r.node_id, flow: name, verb: r.verb ?? null, state: r.state ?? null, attempts: Number(r.attempts ?? 0) || 0, events: Number(r.events ?? 0) || 0 })
      }
      for (const r of depRows) { // flow deps 同构: fn:X -> fn:Y (X 先行)
        let deps = []
        try { const p = JSON.parse(r.deps ?? '[]'); if (Array.isArray(p)) deps = p } catch {}
        for (const d of deps) {
          if (typeof d !== 'string' || !d || !ids.has(`${name}/${d}`) || !ids.has(`${name}/${r.node_id}`)) {
            if (d) notes.push(`${name}: dangling dep ${d}->${r.node_id} dropped`)
            continue
          }
          edges.push({ id: `dep:fn:${name}/${d}>fn:${name}/${r.node_id}`, kind: 'dep', from: `fn:${name}/${d}`, to: `fn:${name}/${r.node_id}`, label: '' })
        }
      }
      // dispatch 子源② (§1.2: flow 事件中含 dispatch 目标席位 ⇒ st:<code> -> fn:…):
      // steer/spawn targets are free-text in event details — extract 4-hex
      // tokens and keep ONLY those that are CURRENT fleet seat codes (membership
      // validation keeps the graph honest: unknown/retired seats yield no edge,
      // 无数据/无命中则空集合法). Dedup per (seat, flow-node) pair.
      const paired = new Set()
      for (const ev of eventRows) {
        if (verbOf.get(ev.node_id) !== 'dispatch' || typeof ev.detail !== 'string') continue
        for (const m of ev.detail.matchAll(/\b[0-9a-f]{4}\b/g)) {
          const code = m[0]
          if (!seatCodes.has(code)) continue
          const key = `${code}>${name}/${ev.node_id}`
          if (paired.has(key)) continue
          paired.add(key)
          edges.push({ id: `dispatch:st:${code}>fn:${name}/${ev.node_id}`, kind: 'dispatch', from: `st:${code}`, to: `fn:${name}/${ev.node_id}`, label: '' })
        }
      }
    } catch (e) { // locked / unreadable / corrupt: degrade THIS flow only
      failed++
      notes.push(`${name}: state.db unreadable (${String(e?.message ?? e).slice(0, 90)})`)
    }
  }
  const live = failed < names.length
  return { nodes, edges, live, note: notes.join('; ').slice(0, 220) }
}

function gatherTicketGraph(seatCodes) { // ticket nodes via the PM-003 cache instance (zero double pull)
  const t = serveTickets() // never throws — degrades internally (PM-003 discipline)
  const nodes = []
  const edges = []
  const notes = []
  for (const tk of t.tickets ?? []) {
    const tid = tk?.ticket_id
    if (typeof tid !== 'string' || !tid) continue
    let deps = []
    try { const p = JSON.parse(tk.deps ?? '[]'); if (Array.isArray(p)) deps = p.filter((d) => typeof d === 'string') } catch {}
    let refs = [] // spec §1.1: keys of the refs object (values stay out of the graph)
    try {
      const p = JSON.parse(tk.refs ?? '[]')
      if (p && typeof p === 'object' && !Array.isArray(p)) refs = Object.keys(p)
      else if (Array.isArray(p)) refs = p.filter((d) => typeof d === 'string')
    } catch {}
    nodes.push({ id: `tk:${tid}`, type: 'ticket', label: tid, ticketId: tid, state: tk.state ?? null, deps, leaseOwner: tk.lease_owner ?? null, refs })
  }
  const byId = new Map(nodes.map((n) => [n.id, n]))
  for (const n of nodes) {
    for (const d of n.deps) { // 票依赖执行序: tk:A.deps ∋ B ⇒ tk:B -> tk:A
      if (!byId.has(`tk:${d}`)) { notes.push(`dangling ticket dep ${d} of ${n.ticketId} dropped`); continue }
      edges.push({ id: `dep:tk:${d}>tk:${n.ticketId}`, kind: 'dep', from: `tk:${d}`, to: n.id, label: '' })
    }
    const owner = n.leaseOwner // 派发/持有 子源①: st:<code> -> tk:<id>, label "lease"
    if (typeof owner === 'string' && owner) {
      const code = owner.split('/')[0].trim() // recorded forms: "<code>" or "<code>/<budget>" (e.g. af29/240min)
      if (seatCodes.has(code)) edges.push({ id: `dispatch:st:${code}>${n.id}`, kind: 'dispatch', from: `st:${code}`, to: n.id, label: 'lease' })
      else notes.push(`dangling lease owner ${owner} of ${n.ticketId} dropped`)
    }
  }
  // D2 (PMW2-F): 旗标跟源 —— live 与 /op/tickets 的 degraded 同源同值 (照单源端点的
  // HF-016 轻探针判定, 不造新判据): 暖缓存期源 CLI 不可读 -> degraded:true = live:false
  // (stale 节点仍如实服务, note 透传轻探针信息); 冷路径行为不变 (源死=空集+live:false)。
  const live = !t.degraded
  return { nodes, edges, live, note: notes.join('; ').slice(0, 200), sourceNote: t.note ?? '' }
}

async function gatherFleetGraph(bridgeSids) { // seat nodes + session nodes (only with live join data, §1.1)
  let seats
  try {
    seats = readSeats()
  } catch (e) {
    return { seatNodes: [], sessionNodes: [], live: false, note: `fleet sources unavailable: ${String(e?.message ?? e).slice(0, 160)}` }
  }
  seats.sort((a, b) => (a.code < b.code ? -1 : 1)) // deterministic order (serveFleet precedent)
  const seatNodes = seats.map((s) => ({ id: `st:${s.code}`, type: 'seat', label: s.code, code: s.code, role: s.role ?? null, node: s.node ?? null, preset: s.preset ?? null, status: s.status ?? null, sessionId: s.sessionId ?? null }))
  const sessionNodes = []
  const notes = []
  let map = null
  try {
    map = await fetchSessionMap()
  } catch (e) { // join loss = sessions empty set, seats keep sessionId (spec §1.1: 空集合法)
    notes.push(`dsh session.list unreachable (127.0.0.1:${DSH_PORT}): ${String(e?.message ?? e).slice(0, 110)} — session nodes empty set`)
  }
  if (map) {
    const want = new Set()
    for (const s of seats) if (typeof s.sessionId === 'string' && s.sessionId && map.has(s.sessionId)) want.add(s.sessionId)
    for (const sid of bridgeSids) if (map.has(sid)) want.add(sid) // orchestrator/peer sessions observed on the bridge (§2 se:…orch)
    for (const sid of [...want].sort()) {
      const m = map.get(sid)
      const title = m.title ?? null
      sessionNodes.push({ id: `se:${sid}`, type: 'session', label: title ? String(title).slice(0, 40) : sid.slice(0, 16), sessionId: sid, running: !!m.running, title, cwd: m.cwd ?? null })
    }
  }
  return { seatNodes, sessionNodes, live: true, note: notes.join('; ').slice(0, 200) }
}

async function serveGraph() {
  const generatedAt = new Date().toISOString()
  const topNotes = []
  // bridge near-window FIRST: its full-form handles feed the session-node set (§2 example needs se:…orch)
  let bridge
  try {
    bridge = gatherBridgePairs()
  } catch (e) {
    bridge = { pairs: [], bad: 0, dead: String(e?.message ?? e).slice(0, 160) }
  }
  const bridgeSids = new Set()
  for (const p of bridge.pairs) for (const h of [p.from, p.to]) { const m = GRAPH_SID_RE.exec(h.trim()); if (m) bridgeSids.add(m[1]) }

  const fleet = await gatherFleetGraph(bridgeSids)
  const seatCodes = new Set(fleet.seatNodes.map((s) => s.code))
  const flow = gatherFlowGraph(seatCodes) // 席位码成员校验用于 dispatch 子源②
  const ticket = gatherTicketGraph(seatCodes)

  const ctx = {
    sessionIds: new Set(fleet.sessionNodes.map((s) => s.sessionId)),
    seatByCode: new Map(fleet.seatNodes.map((s) => [s.code, s])),
    seatBySessionId: new Map(fleet.seatNodes.filter((s) => typeof s.sessionId === 'string' && s.sessionId).map((s) => [s.sessionId, s.code])),
  }
  // callback edges: worker->orchestrator upstream, resolved (from,to) dedup keep-latest
  const callbackEdges = []
  const seenPairs = new Set()
  const bridgeNotes = []
  let dropped = 0
  for (const p of [...bridge.pairs].reverse()) { // reverse file order: first resolved sighting IS the latest
    const from = graphResolveHandle(p.from, ctx)
    const to = graphResolveHandle(p.to, ctx)
    if (!from || !to || from === to) { dropped++; continue } // 悬挂引用禁止: drop + count into sources.bridge.note
    const key = `${from}>${to}`
    if (seenPairs.has(key)) continue
    seenPairs.add(key)
    callbackEdges.push({ id: `callback:${key}`, kind: 'callback', from, to, label: '', at: generatedAt })
  }
  // cb-send edges (orchestrator->worker steer/spawn, §1.2): source = flows/ledger 派发事件记录.
  // Surveyed 2026-08-31 (PMW2-1 勘察): ledger CLI exposes NO event read (record-only
  // verb) and flow events carry steer targets as free text with NO orchestrator-seat
  // identity (the orchestrator is not a fleet seat) — no st:orch->st:worker edge is
  // derivable today. Empty set is spec-legal; annotated honestly until the schema
  // grows a structured record.
  const cbSendEdges = []
  bridgeNotes.push('cb-send empty set: no structured orchestrator-seat->worker-seat dispatch record in flows/ledger (spec §1.2 空集合法, 如实标注)')

  const nodes = [...flow.nodes, ...ticket.nodes, ...fleet.seatNodes, ...fleet.sessionNodes].sort((a, b) => (a.id < b.id ? -1 : 1))
  const edges = [...flow.edges, ...ticket.edges, ...callbackEdges, ...cbSendEdges].sort((a, b) => (a.id < b.id ? -1 : 1))
  const byType = { 'flow-node': 0, ticket: 0, seat: 0, session: 0 }
  for (const n of nodes) byType[n.type]++
  const byKind = { dep: 0, dispatch: 0, callback: 0, 'cb-send': 0 }
  for (const e of edges) byKind[e.kind]++
  if (bridge.bad) bridgeNotes.push(`${bridge.bad} unparsable inbox line(s) skipped`)
  if (dropped) bridgeNotes.push(`${dropped} bridge pair(s) unresolved to graph nodes, dropped (悬挂禁止)`)
  if (bridge.dead) bridgeNotes.push(bridge.dead)
  if (flow.note) topNotes.push(`flows: ${flow.note}`)
  if (ticket.sourceNote) topNotes.push(`tickets: ${ticket.sourceNote}`)
  if (ticket.note) topNotes.push(`tickets: ${ticket.note}`)
  if (fleet.note) topNotes.push(`fleet: ${fleet.note}`)
  if (bridgeNotes.length) topNotes.push(`bridge: ${bridgeNotes.join('; ')}`)
  const sources = {
    flows: { live: flow.live, count: flow.nodes.length, note: flow.note },
    tickets: { live: ticket.live, count: ticket.nodes.length, note: ticket.sourceNote || ticket.note },
    fleet: { live: fleet.live, count: fleet.seatNodes.length, note: fleet.note },
    bridge: { live: !bridge.dead, count: callbackEdges.length + cbSendEdges.length, note: bridgeNotes.join('; ').slice(0, 240) },
  }
  return {
    op: 'graph',
    degraded: !sources.flows.live || !sources.tickets.live || !sources.fleet.live || !sources.bridge.live,
    note: topNotes.join(' | ').slice(0, 300),
    generatedAt,
    nodes,
    edges,
    counts: { nodes: nodes.length, edges: edges.length, byType, byKind },
    sources,
  }
}

// ---- PM-007: GET /subscribe (SSE event fanout) ----
// Namespaced component storage (state/dedup + state/watch already belong to
// other components — watchd etc. — so everything PM-007 owns lives under
// state/subscribers/).
const SUB_DIR = `${STATE_DIR}/subscribers`
const DEDUP_FILE = `${SUB_DIR}/dedup.json`
const DEDUP_WINDOW_MS = 60_000 // (source,msgid) dedup window
const DEDUP_MAX = 1000 // >1000 rows -> keep-newest-half GC
const RING_CAP = 50 // 订阅时快照回放上限
const RECONCILE_MS = 2_000 // second change-detection channel (inotify is best-effort)
const PING_MS = 15_000 // SSE comment keepalive
// Cursor epoch: ring seq is only comparable within one daemon boot, so the
// cursor records which boot wrote it — a cross-boot cursor replays the full
// ring instead of comparing against a reset seq counter (no loss, no dup).
const BOOT_ID = `${startedMs.toString(36)}-${process.pid.toString(36)}`

const seen = new Map() // watch key -> last signature (armed BEFORE any emit)
const dedup = new Map() // msgid -> acceptedAt(ms), survives restart via DEDUP_FILE
const eventRing = [] // { t, seq, msgid, source, kind, path }
let eventSeq = 0
const subscribers = new Map() // consumer -> { consumer, res, kinds, lastSeq, lastMsgid, file }

const safeName = (s) => s.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 128)
const fileSig = (p) => { try { const s = statSync(p, { bigint: true }); return `${s.mtimeNs}:${s.size}` } catch { return 'missing' } }
const ledgerSig = () => `${fileSig(`${ROOT}/maestro/ledger.db`)}|${fileSig(`${ROOT}/maestro/ledger.db-wal`)}`
const flowDbs = () => { try { return readdirSync(FLOWS_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort() } catch { return [] } }
const flowSig = (name) => `${fileSig(`${FLOWS_ROOT}/${name}/state.db`)}|${fileSig(`${FLOWS_ROOT}/${name}/state.db-wal`)}` // WAL: state.db mtime alone can lag writes

function persistDedup() {
  try { mkdirSync(SUB_DIR, { recursive: true }); writeFileIfChanged(DEDUP_FILE, jsonDoc({ window_ms: DEDUP_WINDOW_MS, cap: DEDUP_MAX, entries: Object.fromEntries(dedup) })) } catch {} // state file write failure never kills the fanout
}

// (source,msgid) dedup — THE exactly-once gate: fs.watch and the reconcile
// poll both report the same change, inotify itself double-fires; identical
// signatures produce identical msgids, and the second sighting dies here.
// `extra` (PM-008) merges additive fields into the frame (act settlement
// payloads); without it frames are byte-identical to PM-007's shape.
function emitEvent(kind, source, msgid, path, extra) {
  const now = Date.now()
  if (dedup.has(msgid)) return false
  for (const [k, ts] of dedup) if (now - ts > DEDUP_WINDOW_MS) dedup.delete(k)
  dedup.set(msgid, now)
  if (dedup.size > DEDUP_MAX) {
    const keep = Math.floor(DEDUP_MAX / 2)
    const oldest = [...dedup.entries()].sort((a, b) => a[1] - b[1]).slice(0, dedup.size - keep)
    for (const [k] of oldest) dedup.delete(k)
  }
  persistDedup()
  const ev = { t: 'pm.event', seq: ++eventSeq, msgid, source, kind, path, ...(extra ?? {}) }
  eventRing.push(ev)
  if (eventRing.length > RING_CAP) eventRing.splice(0, eventRing.length - RING_CAP)
  log(`event seq=${ev.seq} kind=${kind} subs=${subscribers.size} msgid=${msgid}`)
  deliverEvent(ev, false)
  return true
}

function writeCursor(sub) { // per-consumer resume point (temp+rename, skip-if-identical)
  try {
    mkdirSync(SUB_DIR, { recursive: true })
    writeFileIfChanged(sub.file, jsonDoc({ consumer: sub.consumer, kinds: [...sub.kinds], lastSeq: sub.lastSeq, lastMsgid: sub.lastMsgid, bootId: BOOT_ID, updatedAt: new Date().toISOString() }))
  } catch {}
}

function deliverEvent(ev, replay) {
  for (const sub of subscribers.values()) {
    if (sub.kinds.size && !sub.kinds.has(ev.kind)) continue
    sub.res.write(`data: ${JSON.stringify({ ...ev, replay })}\n\n`)
    sub.lastSeq = ev.seq
    sub.lastMsgid = ev.msgid
    writeCursor(sub)
  }
}

// Signature projection over the three data planes. Emits only REAL changes:
// missing files don't (their sigs stay stable), and the initial seed below
// guarantees the boot state itself never emits.
function pollOnce() {
  const ls = ledgerSig()
  if (ls !== seen.get('tickets')) { seen.set('tickets', ls); if (ls !== 'missing|missing') emitEvent('tickets', 'ledger', `tickets:ledger.db:${ls}`, 'maestro/ledger.db') }
  const fsig = fileSig(FLEET_FILE)
  if (fsig !== seen.get('fleet')) { seen.set('fleet', fsig); if (fsig !== 'missing') emitEvent('fleet', 'fleet', `fleet:fleet.json:${fsig}`, 'maestro/fleet.json') }
  for (const name of flowDbs()) {
    const key = `flow:${name}`
    const sig = flowSig(name)
    if (sig === seen.get(key)) continue
    seen.set(key, sig)
    if (!sig.startsWith('missing')) emitEvent('flow', 'flows', `flow:${name}:state.db:${sig}`, `flows/${name}/state.db`)
  }
}

function handleSubscribe(req, res) {
  const u = new URL(req.url, 'http://127.0.0.1')
  const consumer = u.searchParams.get('consumer') || ''
  if (!consumer) {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'consumer query param required', hint: '/subscribe?consumer=<sessionId>&kinds=tickets,fleet,flow (empty kinds = all)' }))
    return
  }
  const kinds = new Set((u.searchParams.get('kinds') || '').split(',').map((s) => s.trim()).filter(Boolean))
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' })
  // Same consumer reconnecting: the subscription idempotency key is
  // (consumer, kinds) — the NEW stream wins, the old one gets pm_sub_ended.
  const prev = subscribers.get(consumer)
  if (prev) {
    try { prev.res.write(`data: ${JSON.stringify({ t: 'pm_sub_ended', consumer, reason: 'replaced' })}\n\n`); prev.res.end() } catch {}
    subscribers.delete(consumer)
  }
  const sub = { consumer, res, kinds, lastSeq: 0, lastMsgid: null, file: `${SUB_DIR}/${safeName(consumer)}.json` }
  subscribers.set(consumer, sub)
  // Snapshot replay first: resume after the persisted cursor when it is from
  // THIS boot; a cross-boot (or missing) cursor replays the whole ring —
  // msgid dedup on the consumer side stays the no-dup authority either way.
  let resumed = false
  try {
    const c = JSON.parse(readFileSync(sub.file, 'utf8'))
    if (c.bootId === BOOT_ID && Number.isFinite(c.lastSeq)) { sub.lastSeq = c.lastSeq; sub.lastMsgid = c.lastMsgid ?? null; resumed = true }
  } catch {}
  let replayed = 0
  for (const ev of eventRing) {
    if (resumed && ev.seq <= sub.lastSeq) continue
    if (kinds.size && !kinds.has(ev.kind)) continue
    res.write(`data: ${JSON.stringify({ ...ev, replay: true })}\n\n`)
    sub.lastSeq = ev.seq
    sub.lastMsgid = ev.msgid
    replayed++
  }
  writeCursor(sub)
  log(`subscribe consumer=${consumer} kinds=${kinds.size ? [...kinds].join(',') : 'all'} replayed=${replayed} cursor=${resumed ? 'resume' : 'fresh'}`)
  req.on('close', () => { if (subscribers.get(consumer) === sub) subscribers.delete(consumer) })
}

function armFanout() {
  // Seed the seen-map with the CURRENT state so boot never emits; after this
  // point any diff is a real change (incl. a brand-new flows/<id>/ dir).
  seen.set('tickets', ledgerSig())
  seen.set('fleet', fileSig(FLEET_FILE))
  for (const name of flowDbs()) seen.set(`flow:${name}`, flowSig(name))
  try { // restore the dedup window (60s survivors only)
    const d = JSON.parse(readFileSync(DEDUP_FILE, 'utf8'))
    if (d && typeof d.entries === 'object') {
      const now = Date.now()
      for (const [k, ts] of Object.entries(d.entries)) if (Number.isFinite(ts) && now - ts < DEDUP_WINDOW_MS) dedup.set(k, ts)
    }
  } catch {}
  // Channel 1: fs.watch. The maestro-dir watcher is filename-filtered (my
  // own writes — state/, logs/, pm.port — must not feed back); the flows
  // watcher is recursive so state.db / state.db-wal hits both register.
  for (const [target, opts, filter] of [
    [`${ROOT}/maestro`, {}, (f) => f === 'ledger.db' || f === 'ledger.db-wal' || f === 'fleet.json'],
    [FLOWS_ROOT, { recursive: true }, () => true],
  ]) {
    try {
      const w = watch(target, opts, (ev, f) => { if (filter(f)) pollOnce() })
      w.on('error', () => {}) // a dead watcher never kills the daemon; reconcile still covers it
    } catch {} // target missing at arm: the reconcile poll picks it up once it exists
  }
  // Channel 2: reconcile poll — also the deterministic double-report path.
  setInterval(pollOnce, RECONCILE_MS)
  // SSE keepalive comments (ignored by every SSE parser, defeat idle proxies).
  setInterval(() => { for (const sub of subscribers.values()) { try { sub.res.write(': ping\n\n') } catch {} } }, PING_MS)
}

// ---- PM-008: POST /op/act (write passthrough; P1) ----
// Namespaced under state/act/ per the PM-007 storage precedent.
const ACT_DIR = `${STATE_DIR}/act`
const ACT_REGISTRY_FILE = `${ACT_DIR}/registry.json`
const ACT_AUDIT_FILE = `${ACT_DIR}/audit.jsonl`
const ACT_REF_RE = /^vh-[0-9a-f]{8}$/
const ACT_REGISTRY_MAX = 1000 // terminal entries cap; flying entries are never GC'd
const ACT_TIMEOUT_MS = 30_000 // CLI lifetime budget -> SIGKILL + error settle
const ACT_OUT_CAP = 8_192 // stdout/stderr captured per action (bytes, in-memory)
const ACT_BODY_MAX = 16 * 1024 // POST body cap
// Write-tool allowlist: name -> binary. These are the maestro CLIs whose
// verbs are naturally idempotent (ADR-007); the endpoint itself never
// writes any ledger/sqlite (ADR-002 P0 red line) — passthrough ONLY.
const ACT_TOOLS = { ledger: LEDGER_BIN, flowc: FLOWC_BIN }

const acts = new Map() // ref -> entry; mirrors registry.json, boot loads it
let actCliSpawns = 0 // global counter (gate G1 evidence surface)

const newRef = () => `vh-${randomBytes(4).toString('hex')}`

function persistRegistry() {
  try {
    mkdirSync(ACT_DIR, { recursive: true })
    writeFileIfChanged(ACT_REGISTRY_FILE, jsonDoc({ version: 1, cap: ACT_REGISTRY_MAX, entries: Object.fromEntries(acts) }))
  } catch (e) {
    log(`act registry persist failed: ${String(e?.message ?? e).slice(0, 140)} (in-memory map stays authoritative this boot)`)
  }
}

// Audit is append-only JSONL; per spec its failure is WARN-ONLY — the main
// chain (receipt -> CLI -> settle event) must keep flowing regardless.
// HF-007: the file is secret-material-adjacent state — created 0600 (mode on
// first append) and re-chmodded after every append so pre-existing 0644/0664
// files heal to 0600 (aligned with registry.json), never silently wider.
function appendAudit(rec) {
  try {
    mkdirSync(ACT_DIR, { recursive: true })
    appendFileSync(ACT_AUDIT_FILE, `${JSON.stringify(rec)}\n`, { mode: 0o600 })
    try { chmodSync(ACT_AUDIT_FILE, 0o600) } catch {} // heal legacy wider modes; failure is not audit failure
    return true
  } catch (e) {
    log(`act AUDIT WRITE FAILED (${String(e?.message ?? e).slice(0, 120)}) — warn only, main chain continues: ${rec.t} ref=${rec.ref}`)
    return false
  }
}

// Boot recovery: an entry still 'flying' at load time lost its daemon (and
// its child) mid-flight. Mark it 'interrupted' — a replay reports the
// outcome honestly and the client resubmits under a fresh ref. HF-008: the
// recovery itself now settles loudly like any other outcome — one audit
// line + one kind=act fanout event per orphan (arrives to later subscribers
// via ring replay; the error-tripwire contract holds across boots too).
function loadRegistry() {
  try {
    const d = JSON.parse(readFileSync(ACT_REGISTRY_FILE, 'utf8'))
    const entries = d?.entries && typeof d.entries === 'object' ? d.entries : {}
    let interrupted = 0
    for (const [ref, raw] of Object.entries(entries)) {
      const e = { exitCode: null, error: null, cliSpawns: 0, stdoutTail: '', stderrTail: '', ...raw }
      if (e.status === 'flying') {
        e.status = 'interrupted'
        e.error = 'daemon restart mid-flight; resubmit under a new ref'
        e.finishedAt = new Date().toISOString()
        interrupted++
        acts.set(ref, e)
        appendAudit({ t: 'act.settle', ts: e.finishedAt, ref, tool: e.tool, status: 'interrupted', exitCode: null, ms: null, err: e.error })
        emitEvent('act', 'act', `act:${ref}:interrupted:${Date.now()}`, `act/${ref}`, { ref, tool: e.tool, args: e.args, status: 'interrupted', exitCode: null, ms: null, err: e.error })
        continue
      }
      acts.set(ref, e)
    }
    if (interrupted > 0) { log(`act boot recovery: ${interrupted} flying -> interrupted (audit + fanout event each)`); persistRegistry() }
  } catch {} // missing/corrupt registry = fresh map; audit.jsonl stays the trail
}

function gcRegistry() { // bounded registry: drop OLDEST TERMINAL entries only
  if (acts.size <= ACT_REGISTRY_MAX) return
  const terminal = [...acts.entries()].filter(([, e]) => e.status !== 'flying').sort((a, b) => (a[1].submittedMs ?? 0) - (b[1].submittedMs ?? 0))
  const drop = acts.size - Math.floor(ACT_REGISTRY_MAX / 2)
  for (let i = 0; i < Math.min(drop, terminal.length); i++) acts.delete(terminal[i][0])
}

function finishAct(ref) { // single settle path: registry + audit + fanout event
  const e = acts.get(ref)
  if (!e || e.status === 'flying') return // still flying = nothing to settle
  e.finishedAt = new Date().toISOString()
  e.stdoutTail = (e.stdoutTail ?? '').slice(-256)
  e.stderrTail = (e.stderrTail ?? '').slice(-256)
  const ms = Date.now() - e.submittedMs
  gcRegistry()
  persistRegistry()
  appendAudit({ t: 'act.settle', ts: e.finishedAt, ref, tool: e.tool, status: e.status, exitCode: e.exitCode, ms, err: e.error })
  log(`op=act settle ref=${ref} status=${e.status} exit=${e.exitCode ?? '-'} ms=${ms}`)
  // Settlement event (kinds 扩 'act'): carries the ref back to subscribers.
  emitEvent('act', 'act', `act:${ref}:${e.status}:${Date.now()}`, `act/${ref}`, { ref, tool: e.tool, args: e.args, status: e.status, exitCode: e.exitCode, ms, err: e.error })
}

function spawnAct(ref, e) {
  actCliSpawns++
  e.cliSpawns++
  let child
  try {
    child = spawn(ACT_TOOLS[e.tool], e.args, { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) { // sync spawn throw — same tripwire as the async error path
    e.status = 'error'
    e.error = `spawn failed: ${err?.message ?? err}`
    finishAct(ref)
    return
  }
  child.stdout?.on('data', (d) => { if ((e.stdoutTail ?? '').length < ACT_OUT_CAP) e.stdoutTail = (e.stdoutTail ?? '') + d.toString() })
  child.stderr?.on('data', (d) => { if ((e.stderrTail ?? '').length < ACT_OUT_CAP) e.stderrTail = (e.stderrTail ?? '') + d.toString() })
  const timer = setTimeout(() => {
    e.error = `timeout after ${ACT_TIMEOUT_MS}ms (SIGKILL)`
    try { child.kill('SIGKILL') } catch {} // close handler settles as error
  }, ACT_TIMEOUT_MS)
  child.on('error', (err) => { // ENOENT / shebang interp gone (PATH-removal sim) -> tripwire
    clearTimeout(timer)
    if (e.status !== 'flying') return
    e.status = 'error'
    e.exitCode = null
    e.error = `spawn failed: ${err?.message ?? err}`
    finishAct(ref)
  })
  child.on('close', (code) => {
    clearTimeout(timer)
    if (e.status !== 'flying') return // settle exactly once (error already fired)
    e.exitCode = code
    if (code === 0) e.status = 'ok'
    else {
      e.status = 'error'
      if (!e.error) e.error = `exit ${code}: ${(e.stderrTail || e.stdoutTail || '').trim().slice(0, 200)}`
    }
    finishAct(ref)
  })
}

function acceptAct({ tool, args, ref }) {
  const known = ref != null ? acts.get(ref) : null
  if (known) { // G1: same-ref replay -> answered from the registry, NO second spawn
    log(`op=act accept ref=${ref} tool=${known.tool} replay=true status=${known.status} — zero second CLI spawn`)
    return { op: 'act', accepted: true, ref, replay: true, status: known.status, tool: known.tool, submittedAt: known.submittedAt, finishedAt: known.finishedAt ?? null, exitCode: known.exitCode, note: 'ref already registered: no second CLI spawn (idempotency replay)' }
  }
  const finalRef = ref ?? newRef()
  const now = new Date()
  const entry = { ref: finalRef, tool, args, status: 'flying', submittedAt: now.toISOString(), submittedMs: Date.now(), finishedAt: null, exitCode: null, error: null, cliSpawns: 0, stdoutTail: '', stderrTail: '' }
  acts.set(finalRef, entry)
  persistRegistry() // registered BEFORE spawn: a crash still leaves the trail
  appendAudit({ t: 'act.accept', ts: entry.submittedAt, ref: finalRef, tool, args })
  spawnAct(finalRef, entry)
  log(`op=act accept ref=${finalRef} tool=${tool} argv=${args.length} replay=false`)
  return { op: 'act', accepted: true, ref: finalRef, replay: false, status: 'flying', tool, registry: ACT_REGISTRY_FILE, audit: ACT_AUDIT_FILE, note: 'phase-1 receipt; settlement flows back as a kind=act fanout event carrying this ref' }
}

function serveActStatus(q) { // GET /op/act?ref=… (single) | GET /op/act (summary)
  const ref = q.get('ref')
  if (ref) {
    const e = acts.get(ref)
    if (!e) return { op: 'act', ref, found: false }
    return { op: 'act', ref, found: true, entry: e }
  }
  const counts = { flying: 0, ok: 0, error: 0, interrupted: 0 }
  for (const e of acts.values()) { if (counts[e.status] != null) counts[e.status]++ }
  return { op: 'act', summary: true, counts: { ...counts, total: acts.size }, cliSpawns: actCliSpawns, tools: Object.keys(ACT_TOOLS), registry: ACT_REGISTRY_FILE, audit: ACT_AUDIT_FILE, hint: 'POST /op/act {"tool":"ledger","args":["ticket","list"],"ref":"vh-<8hex>"?} — ref is the retry key; replay = zero second CLI spawn' }
}

function handleActPost(req, res) {
  const finish = (code, obj) => {
    try { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) } catch {}
  }
  const chunks = []
  let size = 0
  let oversize = false
  req.on('data', (d) => {
    size += d.length
    if (size > ACT_BODY_MAX) { oversize = true; try { req.destroy() } catch {}; return }
    chunks.push(d)
  })
  req.on('error', () => { try { finish(413, { error: `body exceeds ${ACT_BODY_MAX} bytes` }) } catch {} })
  req.on('end', () => {
    if (oversize) return finish(413, { error: `body exceeds ${ACT_BODY_MAX} bytes` })
    let body
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { return finish(400, { error: 'body must be JSON', hint: '{"tool":"ledger","args":["ticket","list"],"ref":"vh-<8hex>(optional retry key)"}' }) }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return finish(400, { error: 'body must be a JSON object' })
    const { tool, args, ref } = body
    if (!ACT_TOOLS[tool]) return finish(400, { error: `unknown tool ${JSON.stringify(tool)}`, allowlist: Object.keys(ACT_TOOLS) })
    if (!Array.isArray(args) || args.length > 64 || !args.every((a) => typeof a === 'string' && a.length <= 1024)) return finish(400, { error: 'args must be an array of <=64 strings (<=1024 chars each)' })
    if (ref != null && !(typeof ref === 'string' && ACT_REF_RE.test(ref))) return finish(400, { error: 'ref must match ^vh-[0-9a-f]{8}$ (or be omitted to get a minted one)' })
    return finish(200, acceptAct({ tool, args, ref: ref ?? null }))
  })
}

loadRegistry() // PM-008 boot recovery (flying -> interrupted) before serving

// ---- PM-009: GET /health (per-source live/degraded + version + bootstrap) ----
// Cheap read-only probes, each individually guarded: a failing probe
// degrades ITS source only; the endpoint itself always answers 200.
const CONFIG_DIR = process.env.XDG_CONFIG_HOME ?? `${homedir()}/.config`
const UNIT_FILE = `${CONFIG_DIR}/systemd/user/${SERVICE}.service`
const HEALTH_DSH_TIMEOUT_MS = 1_000 // loopback RPC probe budget (health must stay snappy)
const JOIN_DSH_TIMEOUT_MS = Number(process.env.PM_JOIN_TIMEOUT_MS) || 10_000 // PMW2-I: session.list 数百会话全投影实测 ~5s, 8s→10s 放宽; join 失败仅自身降级注记(joined:false+原因), 不连坐 dsh_api liveness。PM_JOIN_TIMEOUT_MS 供沙箱门调参
const BOOT_CACHE_MS = 5_000 // systemctl is-enabled/is-active cache

const errBrief = (e) => String(e?.message ?? e).slice(0, 120)

function probeFile(p) { // exists + actually openable (chmod 000 exists but is unreadable)
  try {
    const st = statSync(p)
    let readable = true
    try { closeSync(openSync(p, 'r')) } catch { readable = false }
    return { path: p, exists: true, readable, size: Number(st.size), mtime: new Date(st.mtimeMs).toISOString() }
  } catch (e) {
    return { path: p, exists: false, readable: false, error: errBrief(e) }
  }
}

function probeExec(p) {
  try { accessSync(p, constants.X_OK); return { path: p, exists: true, executable: true } } catch (e) { return { path: p, exists: false, executable: false, error: errBrief(e) } }
}

function probeSessions() {
  try { const buckets = readdirSync(SESSIONS_ROOT); return { live: true, root: SESSIONS_ROOT, buckets: buckets.length } } catch (e) { return { live: false, root: SESSIONS_ROOT, buckets: 0, note: errBrief(e) } }
}

function probeFlows() { // SQL self-walk: a flow is live only if its state.db opens read-only AND v_status answers
  let names = []
  try {
    const st = statSync(FLOWS_ROOT)
    if (!st.isDirectory()) return { live: false, root: FLOWS_ROOT, total: 0, readable: 0, flows: [], degradedFlows: [], note: 'flows root is not a directory' }
    names = readdirSync(FLOWS_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
  } catch (e) {
    if (e?.code === 'ENOENT') return { live: true, root: FLOWS_ROOT, total: 0, readable: 0, flows: [], degradedFlows: [], note: 'absent: flows root does not exist yet — healthy empty state (HF-009: absent != broken)' }
    return { live: false, root: FLOWS_ROOT, total: 0, readable: 0, flows: [], degradedFlows: [], note: `flows root unavailable: ${errBrief(e)}` }
  }
  if (names.length === 0) return { live: true, root: FLOWS_ROOT, total: 0, readable: 0, flows: [], degradedFlows: [], note: 'empty: no flow dirs — healthy empty state (HF-009: absent != broken)' }
  const flows = names.map((name) => {
    const dbPath = `${FLOWS_ROOT}/${name}/state.db`
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true }) // read-side red line
      try { db.prepare('SELECT COUNT(*) AS c FROM v_status').get() } finally { db.close() }
      return { flow: name, live: true }
    } catch (e) { return { flow: name, live: false, note: `state.db: ${errBrief(e)}` } }
  })
  const readable = flows.filter((f) => f.live).length
  const dead = flows.filter((f) => !f.live).map((f) => f.flow)
  return { live: flows.length > 0 && readable === flows.length, root: FLOWS_ROOT, total: flows.length, readable, flows, degradedFlows: dead, note: dead.length ? `unreadable: ${dead.join(',')}` : '' }
}

async function probeDsh() { // PMW2-I: liveness 探针走廉价 workspace.list (同款 RPC wire, ~ms 级); session.list 数百会话全投影 ~5s 曾必超 1s 预算 → abort → 降级横幅间歇闪。只判活, 不取数。
  const t0 = Date.now()
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), HEALTH_DSH_TIMEOUT_MS)
  const url = `127.0.0.1:${DSH_PORT}/api/workspace.list`
  try {
    const res = await fetch(`http://${url}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: `pm-host-service-health-${Date.now()}`, method: 'workspace.list', payload: {} }),
      signal: ctl.signal,
    })
    if (!res.ok) return { live: false, url, latency_ms: Date.now() - t0, note: `http ${res.status}` }
    const data = await res.json()
    if (data?.result?.ok !== true) return { live: false, url, latency_ms: Date.now() - t0, note: `rpc error: ${JSON.stringify(data?.result?.error ?? 'unknown').slice(0, 100)}` }
    return { live: true, url, latency_ms: Date.now() - t0 }
  } catch (e) {
    return { live: false, url, latency_ms: Date.now() - t0, note: errBrief(e) }
  } finally {
    clearTimeout(timer)
  }
}

let bootCache = { at: 0, enabled: 'unknown', active: 'unknown', systemctl: 'unprobed' }
function probeBootstrap() { // G3: unit file + systemctl --user is-enabled / is-active (5s cache)
  const unitFile = probeFile(UNIT_FILE)
  const now = Date.now()
  if (now - bootCache.at > BOOT_CACHE_MS) {
    const run = (args) => { const r = spawnSync('systemctl', ['--user', ...args, SERVICE], { encoding: 'utf8', timeout: 2000 }); return r.error ? null : (r.stdout || '').trim() || (r.status === 0 ? 'unknown' : 'not-found') }
    const enabled = run(['is-enabled'])
    const active = run(['is-active'])
    bootCache = { at: now, enabled: enabled ?? 'unavailable', active: active ?? 'unavailable', systemctl: enabled == null && active == null ? 'missing' : 'ok' }
  }
  return { unit: SERVICE, unitFile: { path: unitFile.path, exists: unitFile.exists, readable: unitFile.readable }, enabled: bootCache.enabled, active: bootCache.active, systemctl: bootCache.systemctl, note: `systemctl --user is-enabled/is-active (cache ${BOOT_CACHE_MS}ms); visibility is the contract, values do not gate top status` }
}

async function serveHealth() {
  const sources = {}
  const guard = (name, fn) => { try { sources[name] = fn() } catch (e) { sources[name] = { live: false, note: `probe failed: ${errBrief(e)}` } } }
  guard('ledger', () => { // PM-003 tickets source; HF-009: absent ledger.db is NOT broken (fresh system — the pull plane is the CLI)
    const db = probeFile(`${ROOT}/maestro/ledger.db`)
    const cli = probeExec(LEDGER_BIN)
    const live = cli.executable && (!db.exists || db.readable)
    return { live, ledgerDb: db, ledgerCli: cli, note: db.exists ? '' : 'ledger.db absent — healthy fresh state (HF-009: absent != broken; tickets pull plane is the CLI)' }
  })
  guard('tickets_md', () => { const f = probeFile(TICKETS_MD); return { live: f.exists && f.readable, file: f } }) // signature plane
  guard('fleet', () => { // PM-004: fleet.json primary + fleet-list fallback CLI
    const f = probeFile(FLEET_FILE)
    const cli = probeExec(FLEET_LIST_BIN)
    return { live: f.exists && f.readable, fleetJson: f, fleetListCli: cli }
  })
  guard('sessions', probeSessions) // PM-005 trace root
  guard('flows', probeFlows) // PM-006 per-flow SQL walk
  guard('singleton', () => ({ // HF-014: flock fail-open made VISIBLE — an unlocked daemon degrades health instead of running silently
    live: lockState === 'held',
    state: lockState,
    note: lockState === 'held' ? 'flock(2) singleton held in-daemon (PM-002)' : 'flock unavailable — SINGLE INSTANCE NOT GUARANTEED; fail-open is now a degraded, visible state (HF-014)',
  }))
  sources.dsh_api = await probeDsh() // PM-004 join plane (always guarded internally)
  const bootstrap = (() => { try { return probeBootstrap() } catch (e) { return { enabled: 'unknown', active: 'unknown', note: errBrief(e) } } })()
  const degraded = Object.entries(sources).filter(([, s]) => !s?.live).map(([k]) => k)
  return {
    status: degraded.length ? 'degraded' : 'ok',
    service: SERVICE,
    version: VERSION,
    pid: process.pid,
    uptime_s: Math.round((Date.now() - startedMs) / 1000),
    bootId: BOOT_ID,
    tokenAuth: TOKEN !== '',
    bootstrap,
    sources,
    degraded,
    note: 'PM-009 meta: per-source live/degraded + version + systemd bootstrap; always HTTP 200 (tk renders empty states on degraded)',
  }
}

// ---- PW-001 (pm-web static face): public/ boot snapshot, read-only ----
// Spec docs/specs/pm-web.md §1: the observability face ships as package
// files NEXT TO this daemon — same port, same lifecycle (the face lives and
// dies with the projector on purpose; a face that outlives the projector
// would render dead data = fake availability). Strict allowlist: ONLY files
// that existed in public/ at boot are served — request input can NAME a
// file, never traverse into one (map keys are scanned filenames, so no
// ../, no absolute paths, no subdirs). Content-Type by extension; a miss
// falls through to the API routes and the JSON 404 stays the final
// fallback. Zero npm, zero build: the authored file IS the deploy.
const PUBLIC_DIR = new URL('./public/', import.meta.url)
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
}
const staticFace = new Map() // name -> { body, type }
try {
  for (const name of readdirSync(PUBLIC_DIR)) {
    try {
      const fileUrl = new URL(`./public/${name}`, import.meta.url)
      if (!statSync(fileUrl).isFile()) continue
      const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : ''
      staticFace.set(name, { body: readFileSync(fileUrl), type: STATIC_TYPES[ext] ?? 'application/octet-stream' })
    } catch {}
  }
  log(`pw-001 static face: ${staticFace.size} file(s) from public/ ([${[...staticFace.keys()].join(', ')}])`)
} catch (e) {
  log(`pw-001 static face: public/ unreadable (${errBrief(e)}) — face disabled, API unaffected`)
}
function serveStatic(rawUrl) { // -> { body, type } | null (miss falls through to API routes)
  const path = rawUrl.split('?')[0]
  const name = path === '/' ? 'index.html' : path.replace(/^\/+/, '')
  return staticFace.get(name) ?? null
}

const server = createServer((req, res) => {
  const finish = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(obj))
  }
  if (TOKEN !== '') { // optional placeholder path; default deployments never hit this
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return finish(403, { error: 'bad token' })
  }
  if (req.method === 'POST' && (req.url === '/op/act' || req.url.startsWith('/op/act?'))) return handleActPost(req, res) // PM-008: the single write path
  if (req.method !== 'GET') return finish(405, { error: 'read-side only (ADR-002); the single write path is POST /op/act (PM-008 maestro CLI passthrough)' })
  // PW-001 (pm-web): static face FIRST — GET / and package files from the
  // public/ boot snapshot; a miss falls through to the API routes untouched.
  const staticHit = serveStatic(req.url)
  if (staticHit) {
    res.writeHead(200, { 'content-type': staticHit.type, 'cache-control': 'no-cache' })
    res.end(staticHit.body)
    return
  }
  if (req.url === '/health' || req.url.startsWith('/health?')) {
    // PM-009: full meta; the catch-all still answers 200+degraded (never 5xx)
    serveHealth().then((r) => finish(200, r)).catch((e) => finish(200, { status: 'degraded', service: SERVICE, version: VERSION, pid: process.pid, degraded: ['health'], note: `health assembly failed: ${String(e?.message ?? e).slice(0, 160)}` }))
    return
  }
  if (req.url === '/op/tickets') return finish(200, serveTickets())
  if (req.url.startsWith('/op/trace?') || req.url === '/op/trace') {
    const u = new URL(req.url, 'http://127.0.0.1')
    if (!u.searchParams.get('sessionId')) return finish(400, { error: 'sessionId query param required', hint: 'op=trace?sessionId=session-…&type=&tool=&text=&seqFrom=&seqTo=' })
    try { return finish(200, serveTrace(u.searchParams)) } catch (e) {
      log(`op=trace DEGRADED ${String(e?.message ?? e).slice(0, 140)}`)
      return finish(200, { op: 'trace', sessionId: u.searchParams.get('sessionId'), degraded: true, entries: [], note: `trace unavailable: ${String(e?.message ?? e).slice(0, 140)}` })
    }
  }
  if (req.url === '/op/flow') return finish(200, serveFlow())
  if (req.url === '/op/act' || req.url.startsWith('/op/act?')) {
    const u = new URL(req.url, 'http://127.0.0.1')
    return finish(200, serveActStatus(u.searchParams)) // PM-008 read-back: entry by ref / summary
  }
  if (req.url === '/subscribe' || req.url.startsWith('/subscribe?')) return handleSubscribe(req, res)
  if (req.url === '/op/fleet') {
    serveFleet().then((r) => finish(200, r)).catch((e) => finish(200, { op: 'fleet', count: 0, seats: [], degraded: true, sessionJoined: false, note: `internal: ${String(e?.message ?? e).slice(0, 120)}` }))
    return
  }
  if (req.url === '/op/graph') { // PMW2-1: the catch-all keeps 恒 200 (spec §2 degradation discipline)
    serveGraph().then((r) => finish(200, r)).catch((e) => finish(200, { op: 'graph', degraded: true, note: `internal: ${String(e?.message ?? e).slice(0, 140)}`, generatedAt: new Date().toISOString(), nodes: [], edges: [], counts: { nodes: 0, edges: 0, byType: { 'flow-node': 0, ticket: 0, seat: 0, session: 0 }, byKind: { dep: 0, dispatch: 0, callback: 0, 'cb-send': 0 } }, sources: { flows: { live: false, count: 0, note: 'internal' }, tickets: { live: false, count: 0, note: 'internal' }, fleet: { live: false, count: 0, note: 'internal' }, bridge: { live: false, count: 0, note: 'internal' } } }))
    return
  }
  finish(404, { error: 'not found', service: SERVICE, hint: 'write passthrough = POST /op/act; health meta = GET /health (PM-009)' })
})

// PMW2-G: PM_PORT pins the listen port (unset/invalid -> 0 = ephemeral random port,
// keeping sandbox-gate compatibility); a pinned port that is occupied must fail fast.
const PM_PORT = (() => { const v = Number(process.env.PM_PORT); return Number.isInteger(v) && v > 0 && v < 65536 ? v : 0 })()
server.on('error', (e) => { // PMW2-G: 钉住端口冲突 -> 显式日志 + 非零退出，绝不静默跳港 (systemd Restart 可见)
  const fatal = `FATAL listen 127.0.0.1:${PM_PORT || '(ephemeral)'} failed code=${e?.code ?? '?'} msg=${String(e?.message ?? e).slice(0, 160)}`
  console.error(fatal) // stderr -> journald (systemctl status / journalctl 直接可见)
  log(fatal) // file -> $LOG_DIR/service.log
  process.exit(1)
})
server.listen(PM_PORT, '127.0.0.1', () => {
  const { port } = server.address()
  const action = writeFileIfChanged(PORT_FILE, jsonDoc({
    service: SERVICE,
    version: VERSION,
    port,
    pid: process.pid,
    startedAt: new Date(startedMs).toISOString(),
    bind: '127.0.0.1',
    tokenAuth: TOKEN !== '',
    endpoints: ['GET / (pm-web static face: public/ snapshot)', 'GET /health (PM-009 meta: per-source live/degraded + bootstrap)', 'GET /op/tickets', 'GET /op/fleet', 'GET /op/trace', 'GET /op/flow', 'GET /op/graph (PMW2-1 canvas plane: 4 node types × 4 edge kinds, 恒 200)', 'GET /subscribe?consumer=<sessionId>&kinds=<csv>', 'POST /op/act {"tool","args","ref"?}', 'GET /op/act?ref=<vh-hex8>'],
    note: '幂等键=本文件路径; temp+rename 0600; PM-007 扇出 + PM-008 写透传 + PM-009 健康元 + PMW2-1 /op/graph 画布面已上线',
  }))
  log(`http up 127.0.0.1:${port} pid=${process.pid} portfile=${action} tokenAuth=${TOKEN !== ''}`)
  armFanout() // PM-007: watchers + reconcile poll + SSE keepalive
})
setInterval(() => log(`heartbeat pid=${process.pid}`), 60_000) // keeps the loop alive
