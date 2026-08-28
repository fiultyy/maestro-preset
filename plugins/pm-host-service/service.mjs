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
//
// Zero npm deps; node:* ESM only. Read-side only (ADR-002): never touches a
// ledger/sqlite; writes go through maestro CLI (PM-008).
import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'

const VERSION = '0.3.0'
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
  finish(404, { error: 'not found', service: SERVICE, hint: 'op=fleet/trace/flow arrive with PM-004..006' })
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
    endpoints: ['GET /health', 'GET /op/tickets'],
    note: '幂等键=本文件路径; temp+rename 0600; PM-002 骨架',
  }))
  log(`http up 127.0.0.1:${port} pid=${process.pid} portfile=${action} tokenAuth=${TOKEN !== ''}`)
})
setInterval(() => log(`heartbeat pid=${process.pid}`), 60_000) // keeps the loop alive
