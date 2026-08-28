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
//
// Zero npm deps; node:* ESM only. Read-side only (ADR-002): never touches a
// ledger/sqlite; writes go through maestro CLI (PM-008).
import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { zstdDecompressSync } from 'node:zlib'
import { appendFileSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, watch, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'

const VERSION = '0.7.0'
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
function emitEvent(kind, source, msgid, path) {
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
  const ev = { t: 'pm.event', seq: ++eventSeq, msgid, source, kind, path }
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
  if (req.url === '/subscribe' || req.url.startsWith('/subscribe?')) return handleSubscribe(req, res)
  if (req.url === '/op/fleet') {
    serveFleet().then((r) => finish(200, r)).catch((e) => finish(200, { op: 'fleet', count: 0, seats: [], degraded: true, sessionJoined: false, note: `internal: ${String(e?.message ?? e).slice(0, 120)}` }))
    return
  }
  finish(404, { error: 'not found', service: SERVICE, hint: 'writes go through maestro CLI (PM-008); health/degraded meta is PM-009' })
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
    endpoints: ['GET /health', 'GET /op/tickets', 'GET /op/fleet', 'GET /op/trace', 'GET /op/flow', 'GET /subscribe?consumer=<sessionId>&kinds=<csv>'],
    note: '幂等键=本文件路径; temp+rename 0600; PM-007 SSE 扇出已上线',
  }))
  log(`http up 127.0.0.1:${port} pid=${process.pid} portfile=${action} tokenAuth=${TOKEN !== ''}`)
  armFanout() // PM-007: watchers + reconcile poll + SSE keepalive
})
setInterval(() => log(`heartbeat pid=${process.pid}`), 60_000) // keeps the loop alive
