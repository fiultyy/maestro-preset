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
//
// Zero npm deps; node:* ESM only. Read-side only (ADR-002): never touches a
// ledger/sqlite; writes go through maestro CLI (PM-008).
import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { zstdDecompressSync } from 'node:zlib'
import { appendFileSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'

const VERSION = '0.6.0'
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
// In-memory cache is the serving plane; the ledger CLI is the pull plane;
// the tickets.md signature (mtime_ns+size) is the change detector. No
// wide-table cache (ADR-007.2: R1/R3 not triggered); the cursor file only
// records the served signature (temp+rename, skip-if-identical).
const tickets = { list: null, sig: null, pulledAt: null, cliSpawns: 0 }

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

function serveTickets() {
  const sig = mdSignature()
  if (tickets.list !== null && tickets.sig === sig) { // replay: zero cli spawns, zero writes
    return { op: 'tickets', count: tickets.list.length, tickets: tickets.list, cache: 'hit', degraded: false, note: '', signature: sig, cliSpawns: tickets.cliSpawns, pulledAt: tickets.pulledAt }
  }
  try {
    const list = pullLedgerTickets()
    tickets.list = list
    tickets.sig = sig
    tickets.pulledAt = new Date().toISOString()
    mkdirSync(STATE_DIR, { recursive: true })
    const cursorAction = writeFileIfChanged(CURSOR_FILE, jsonDoc({
      signature: sig,
      ticketCount: list.length,
      pulledAt: tickets.pulledAt,
      version: VERSION,
    }))
    log(`op=tickets pull ok count=${list.length} sig=${sig} cursor=${cursorAction}`)
    return { op: 'tickets', count: list.length, tickets: list, cache: 'miss', degraded: false, note: '', signature: sig, cliSpawns: tickets.cliSpawns, pulledAt: tickets.pulledAt, cursor: cursorAction }
  } catch (e) {
    const have = tickets.list !== null
    const note = `ledger unavailable: ${String(e?.message ?? e).slice(0, 220)}`
    log(`op=tickets DEGRADED ${note} (serving ${have ? 'stale cache' : 'empty list'})`)
    return { op: 'tickets', count: have ? tickets.list.length : 0, tickets: have ? tickets.list : [], cache: have ? 'stale' : 'empty', degraded: true, note, signature: sig, cliSpawns: tickets.cliSpawns, pulledAt: tickets.pulledAt }
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
    if (!map || typeof map !== 'object') throw new Error('fleet.json has no fleet map')
    const seats = Object.entries(map).map(([code, s]) => normSeat(code, s))
    if (!seats.length) throw new Error('fleet.json fleet map is empty')
    return seats
  } catch (e1) {
    const r = spawnSync(FLEET_LIST_BIN, [], { encoding: 'utf8', timeout: 8000 })
    if (r.error || r.status !== 0) throw new Error(`fleet.json unreadable (${String(e1?.message ?? e1).slice(0, 100)}) and fleet-list fallback failed`)
    const list = JSON.parse(r.stdout)
    if (!Array.isArray(list) || !list.length) throw new Error('fleet-list fallback returned no seats')
    return list.map((s) => normSeat(s.code, s))
  }
}

let joinSeq = 0
async function joinSessions(seats) { // dsh loopback RPC; 8s abort -> caller degrades
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 8000)
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
    const byId = new Map((data.result.value?.items ?? []).map((s) => [s.sessionId, s]))
    return seats.map((seat) => {
      const s = byId.get(seat.sessionId)
      // identity+liveness only: volatile metrics (updatedAt/tokens) stay out so
      // same-upstream replays are byte-identical
      const session = s ? {
        running: !!s.running,
        blank: !!s.blank,
        agentPreset: s.agentPreset ?? null,
        cwd: s.cwd ?? null,
        title: s.projections?.values?.title ?? null,
      } : null
      return { ...seat, session }
    })
  } finally {
    clearTimeout(timer)
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
  try {
    seats = await joinSessions(seats)
    return { op: 'fleet', count: seats.length, seats, degraded: false, sessionJoined: true, note: '' }
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

const server = createServer((req, res) => {
  const finish = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(obj))
  }
  if (TOKEN !== '') { // optional placeholder path; default deployments never hit this
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return finish(403, { error: 'bad token' })
  }
  if (req.method !== 'GET') return finish(405, { error: 'read-side only (ADR-002); writes go through maestro CLI (PM-008)' })
  if (req.url === '/health') {
    return finish(200, {
      status: 'ok',
      service: SERVICE,
      version: VERSION,
      pid: process.pid,
      uptime_s: Math.round((Date.now() - startedMs) / 1000),
      tokenAuth: TOKEN !== '',
      note: 'PM-002 skeleton; full health/degraded meta endpoint is PM-009',
    })
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
  if (req.url === '/op/fleet') {
    serveFleet().then((r) => finish(200, r)).catch((e) => finish(200, { op: 'fleet', count: 0, seats: [], degraded: true, sessionJoined: false, note: `internal: ${String(e?.message ?? e).slice(0, 120)}` }))
    return
  }
  finish(404, { error: 'not found', service: SERVICE, hint: 'op=subscribe arrives with PM-007' })
})

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address()
  const action = writeFileIfChanged(PORT_FILE, jsonDoc({
    service: SERVICE,
    version: VERSION,
    port,
    pid: process.pid,
    startedAt: new Date(startedMs).toISOString(),
    bind: '127.0.0.1',
    tokenAuth: TOKEN !== '',
    endpoints: ['GET /health', 'GET /op/tickets', 'GET /op/fleet', 'GET /op/trace', 'GET /op/flow'],
    note: '幂等键=本文件路径; temp+rename 0600; PM-002 骨架',
  }))
  log(`http up 127.0.0.1:${port} pid=${process.pid} portfile=${action} tokenAuth=${TOKEN !== ''}`)
})
setInterval(() => log(`heartbeat pid=${process.pid}`), 60_000) // keeps the loop alive
