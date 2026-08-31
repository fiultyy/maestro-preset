#!/usr/bin/env node
// pm001-007-gate.mjs — PM-001..007 full-clause sandbox gate (HF-013 ①).
// rv-a reviewer sandbox pattern: env-overridden MAESTRO_HOME sandboxes, the
// daemon runs THIS repo checkout's service.mjs (the same code the systemd
// unit ExecStarts), and every spec clause gets its own assertion:
//   PM-002 port-file drift / old-port refusal / flock single instance (SB2)
//   PM-003 tickets: replay zero-CLI zero-write, signature-change re-pull,
//          ledger death -> 200 + degraded + stale cache, never 5xx (SB1)
//          + boot-time death -> 200 + degraded + EMPTY state (SB2)
//   PM-004 fleet: live join, byte-stable replay, dsh API death ->
//          200 + pure fleet view + degraded:true + note (SB1)
//   PM-005 trace: >20k head.compact fold (snapshot line + verbatim tail),
//          type/tool/text/seq filters (subset + replay sha), torn tail frame,
//          missing sessionId 400, unknown sid miss (SB1)
//   PM-006 flow: SQL self-walk, per-db degradation (chmod 000 one db),
//          all-dead -> flowc CLI fallback, never 5xx (SB1)
//   PM-007 subscribe: dual-channel exactly-once (one touch -> one frame),
//          kinds filter, disconnect/reconnect (replay:true resume + fresh
//          replay:false, no dup no loss), same-consumer replace ->
//          pm_sub_ended, missing consumer 400 (SB1)
// PM-001 (systemd is-active / kill pull-back / zero-change apply) cannot be
// sandboxed — it lives in pm001-007-regression.sh (live part).
//
// Retention (HF-013 ②): ALL artifacts land under
//   $PM_HOST_SERVICE_GATES_DIR/pm001-007/<label>/  (default
//   ~/.dsh/maestro/logs/pm-host-service/gates) — never /tmp.
// Usage: node pm001-007-gate.mjs <label>    (label default: manual-<pid>)
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

const LABEL = process.argv[2] ?? `manual-${process.pid}`
const GATES_ROOT = process.env.PM_HOST_SERVICE_GATES_DIR ?? `${homedir()}/.dsh/maestro/logs/pm-host-service/gates`
const BASE = `${GATES_ROOT}/pm001-007/${LABEL}`
const REPO = new URL('..', import.meta.url).pathname // plugins/pm-host-service/
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}${detail ? `  :: ${detail}` : ''}`) } else { fail++; console.log(`FAIL ${name}${detail ? `  :: ${detail}` : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- daemon lifecycle (pm008-gate pattern) ----------
function buildSandbox(sb) {
  rmSync(sb, { recursive: true, force: true })
  mkdirSync(`${sb}/maestro/bin`, { recursive: true })
  mkdirSync(`${sb}/maestro/state`, { recursive: true })
}
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
    DSH_SESSIONS_ROOT: `${sb}/sessions`,
    ...extra,
  }
}
async function startDaemon(sb, extraEnv = {}) {
  const child = spawn(process.execPath, [`${REPO}/service.mjs`], { env: daemonEnv(sb, extraEnv), stdio: 'ignore' })
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
  if (!child || child.exitCode != null || child.signalCode != null) return resolve() // already dead (idempotent)
  child.once('exit', resolve); try { child.kill('SIGTERM') } catch { resolve() }
})
const waitExit = (child, ms = 8000) => new Promise((resolve) => { const t = setTimeout(() => resolve('timeout'), ms); child.once('exit', (c) => { clearTimeout(t); resolve(c) }) })

async function req(port, method, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body != null ? { 'content-type': 'application/json' } : {},
    body: body != null ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { status: res.status, json, text }
}

// SSE collector (pm008-gate pattern + ended promise for pm_sub_ended).
async function subscribe(port, consumer, kinds) {
  const ctl = new AbortController()
  const res = await fetch(`http://127.0.0.1:${port}/subscribe?consumer=${consumer}${kinds ? `&kinds=${kinds}` : ''}`, { signal: ctl.signal })
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  const frames = []
  let buf = ''
  let endedResolve
  const ended = new Promise((r) => { endedResolve = r })
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let i
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i)
          buf = buf.slice(i + 2)
          for (const line of chunk.split('\n')) if (line.startsWith('data: ')) { try { frames.push(JSON.parse(line.slice(6))) } catch {} }
        }
      }
    } catch {}
    endedResolve()
  })()
  return { frames, ended, stop: async () => { ctl.abort(); try { await pump } catch {} } }
}
const waitFrame = async (sse, pred, timeoutMs = 5000) => {
  const t0 = Date.now()
  for (;;) {
    const f = sse.frames.find(pred)
    if (f) return f
    if (Date.now() - t0 > timeoutMs) return null
    await sleep(100)
  }
}

// ---------- fixture writers ----------
const LEDGER_ALIVE = `#!/bin/bash
echo "$(date +%s%N) $*" >> "$PMG_CALLS"
if [ -f "\${PMG_LEDGER_MODE:-/dev/null}" ] && [ "$(cat "$PMG_LEDGER_MODE" 2>/dev/null)" != "alive" ]; then
  echo "fixture ledger death" >&2; exit 9
fi
echo '{"tickets":[{"id":"T-a","state":"open"},{"id":"T-b","state":"dispatched"}]}'
`
const FLOWC_FIXTURE = '#!/bin/bash\necho "flowc inspect fallback output (fixture)"\nexit 0\n'
const FLEETLIST_FIXTURE = '#!/bin/bash\necho "fixture fleet-list dead" >&2\nexit 3\n'

const SEATS = {
  'seat-a': { sessionId: 'session-x', role: 'worker', node: 'n1', preset: 'omp', spawnedAt: '2026-08-29T00:00:00Z', status: 'running' },
  'seat-b': { sessionId: 'session-missing', role: 'liaison', node: 'n2', preset: 'maestro', spawnedAt: '2026-08-29T00:01:00Z', status: 'idle' },
}
function writeFleet(sb, rev) {
  const file = `${sb}/maestro/fleet.json`
  const tmp = `${file}.tmp.${process.pid}`
  writeFileSync(tmp, `${JSON.stringify({ rev, fleet: SEATS }, null, 2)}\n`)
  renameSync(tmp, file)
}
const fleetSig = (sb) => { const s = statSync(`${sb}/maestro/fleet.json`, { bigint: true }); return `${s.mtimeNs}:${s.size}` }

function writeTrace(sb, sid, entries, tornTail) {
  const dir = `${sb}/sessions/bucket-gate/${sid}`
  mkdirSync(dir, { recursive: true })
  const jsonl = entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
  let buf = zstdCompressSync(Buffer.from(jsonl))
  if (tornTail) buf = Buffer.concat([buf, Buffer.concat([ZSTD_TAIL_GARBAGE])]) // torn second frame (fails decompress)
  writeFileSync(`${dir}/session.jsonl.zstd`, buf)
  return entries
}

// magic + a header that makes the frame undecodable — "Data corruption detected"
const ZSTD_TAIL_GARBAGE = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])

// Synthetic sessions: small (no fold) / big (payload > 20k -> fold) / torn.
function traceFixtures() {
  const small = [
    { type: 'user', seq: 1, data: { text: 'hello gate' } },
    { type: 'assistant', seq: 2, data: { text: 'hi NEEDLE-ALPHA there' } },
    { type: 'tool_call', seq: 3, data: { name: 'bash' } },
    { type: 'result', seq: 4, data: { name: 'bash', out: 'ok' } },
    { type: 'assistant', seq: 5, data: { text: 'done' } },
  ]
  const big = []
  for (let i = 1; i <= 70; i++) {
    if (i % 5 === 0) big.push({ type: 'tool_call', seq: i, data: { name: 'bash' } })
    else if (i % 7 === 0) big.push({ type: 'assistant', seq: i, data: { text: `NEEDLE-ALPHA pad ${i} ${'y'.repeat(120)}` } })
    else big.push({ type: 'assistant', seq: i, data: { text: `pad-${i}-${'x'.repeat(480)}` } })
  }
  return { small, big }
}

function writeFlowDb(path) {
  mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE nodes(node_id TEXT NOT NULL, state TEXT NOT NULL)')
  db.exec("INSERT INTO nodes VALUES('n1','done')")
  db.exec("INSERT INTO nodes VALUES('n2','dispatched')")
  db.exec('CREATE VIEW v_status AS SELECT node_id, state FROM nodes')
  db.exec('CREATE VIEW v_rollup AS SELECT state, COUNT(*) AS n FROM nodes GROUP BY state')
  db.close()
}

// Mock dsh loopback API (session.list RPC shape the fleet join expects).
async function startMockDsh() {
  const server = createServer((rq, rs) => {
    const chunks = []
    rq.on('data', (d) => chunks.push(d))
    rq.on('end', () => {
      rs.writeHead(200, { 'content-type': 'application/json' })
      rs.end(JSON.stringify({ result: { ok: true, value: { items: [
        { sessionId: 'session-x', running: true, blank: false, agentPreset: 'maestro', cwd: '/tmp/gate', projections: { values: { title: 'gate-mock' } } },
      ] } } }))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { server, port: server.address().port, close: () => new Promise((r) => server.close(r)) }
}

// ============ SB1: read-plane clauses (tickets/fleet/trace/flow/subscribe) ============
async function sb1() {
  const sb = `${BASE}/sb1`
  buildSandbox(sb)
  writeFileSync(`${sb}/maestro/bin/ledger`, LEDGER_ALIVE, { mode: 0o755 })
  writeFileSync(`${sb}/maestro/bin/flowc`, FLOWC_FIXTURE, { mode: 0o755 })
  writeFileSync(`${sb}/maestro/bin/fleet-list`, FLEETLIST_FIXTURE, { mode: 0o755 })
  writeFileSync(`${sb}/maestro/ledger-mode`, 'alive\n')
  writeFileSync(`${sb}/maestro/tickets.md`, '# tickets\nT-a open\nT-b dispatched\n')
  writeFleet(sb, 0)
  const { small, big } = traceFixtures()
  writeTrace(sb, 'session-gate-small', small)
  writeTrace(sb, 'session-gate-big', big)
  writeTrace(sb, 'session-gate-torn', small, true)
  writeFlowDb(`${sb}/maestro/flows/gate-live/state.db`)
  writeFlowDb(`${sb}/maestro/flows/gate-dead/state.db`)

  const mock = await startMockDsh()
  const { child, port } = await startDaemon(sb, {
    PMG_CALLS: `${sb}/ledger-calls.log`,
    PMG_LEDGER_MODE: `${sb}/maestro/ledger-mode`,
    DSH_PORT: String(mock.port),
    PM_JOIN_CACHE_TTL_MS: '3000', // PMW2-J: SB1 dsh-death 断言需在秒级看到 stale 翻转
    PM_JOIN_TIMEOUT_MS: '2000',
  })
  try {
    console.log(`\n=== SB1 ${sb} (mock dsh :${mock.port}) port=${port} ===`)
    const h = await req(port, 'GET', '/health')
    ok('SB1 boot /health 200 (never 5xx)', h.status === 200, `version=${h.json?.version}`)
    ok('SB1 version matches repo package.json', h.json?.version === VERSION, `${h.json?.version} vs ${VERSION}`)

    // ---- PM-003 tickets: miss -> hit -> zero-write replay ----
    const t0r = await req(port, 'GET', '/op/tickets')
    ok('PM-003 first pull 200 cache:miss', t0r.status === 200 && t0r.json?.cache === 'miss' && t0r.json?.count === 2, `count=${t0r.json?.count}`)
    const cursor = `${sb}/maestro/state/tickets.cursor.json`
    const cursorSig = () => { const s = statSync(cursor, { bigint: true }); return `${s.mtimeNs}:${s.size}` }
    const c0 = cursorSig()
    const t1 = await req(port, 'GET', '/op/tickets') // replay #1 (cache hit)
    const t2 = await req(port, 'GET', '/op/tickets') // replay #2 (cache hit)
    ok('PM-003 replay byte-identical', t1.text === t2.text, `${t1.text.length}B`)
    ok('PM-003 replay cache:hit + zero CLI spawns', t2.json?.cache === 'hit' && t2.json?.cliSpawns === t1.json?.cliSpawns && t2.json?.cliSpawns === t0r.json?.cliSpawns, `spawns=${t2.json?.cliSpawns}`)
    ok('PM-003 replay zero disk writes (cursor untouched)', cursorSig() === c0)
    // signature change -> re-pull + cursor update
    const sleepTouch = async () => { const t = Date.now(); while (Date.now() === t) await sleep(1); } // ensure mtime_ns advances
    await sleepTouch()
    writeFileSync(`${sb}/maestro/tickets.md`, '# tickets\nT-a open\nT-b dispatched\nT-c new\n')
    const t3 = await req(port, 'GET', '/op/tickets')
    ok('PM-003 signature change -> re-pull (cache:miss, +1 CLI)', t3.json?.cache === 'miss' && t3.json?.cliSpawns === t2.json?.cliSpawns + 1, `spawns=${t3.json?.cliSpawns}`)
    ok('PM-003 cursor file updated after re-pull', cursorSig() !== c0)

    // ---- PM-004 fleet: live join + byte-stable replay ----
    const f1 = await req(port, 'GET', '/op/fleet')
    ok('PM-004 join live sessionJoined:true degraded:false', f1.status === 200 && f1.json?.sessionJoined === true && f1.json?.degraded === false)
    const seatA = f1.json?.seats?.find((s) => s.code === 'seat-a')
    const seatB = f1.json?.seats?.find((s) => s.code === 'seat-b')
    ok('PM-004 join fills known session identity fields', seatA?.session?.running === true && seatA?.session?.cwd === '/tmp/gate' && seatA?.session?.title === 'gate-mock', JSON.stringify(seatA?.session))
    ok('PM-004 unknown sessionId -> session:null (pure projection)', seatB?.session === null)
    const f2 = await req(port, 'GET', '/op/fleet')
    ok('PM-004 replay byte-identical', f1.text === f2.text)

    // ---- PM-005 trace: small / big fold / torn / filters ----
    const trS = await req(port, 'GET', '/op/trace?sessionId=session-gate-small')
    ok('PM-005 small session full read, no fold', trS.status === 200 && trS.json?.folded === false && trS.json?.entries?.length === small.length, `entries=${trS.json?.entries?.length}`)
    const trB = await req(port, 'GET', '/op/trace?sessionId=session-gate-big')
    const payload = trB.json?.matched?.payload_chars ?? 0
    ok('PM-005 big payload over budget triggers fold', payload > 20000 && trB.json?.folded === true, `payload_chars=${payload} budget=${trB.json?.budget}`)
    const head = trB.json?.entries?.[0]
    ok('PM-005 fold head is single trace.compact snapshot line', head?.type === 'trace.compact' && head?.reason === 'threshold' && head?.dropped?.entries > 0, `dropped=${head?.dropped?.entries} kept=${head?.kept?.entries}`)
    ok('PM-005 fold keeps recent tail verbatim', trB.json?.entries?.[trB.json.entries.length - 1]?.seq === big[big.length - 1].seq, `last seq=${trB.json?.entries?.[trB.json.entries.length - 1]?.seq}`)
    ok('PM-005 fold output within budget', JSON.stringify(trB.json?.entries ?? []).length <= 20000 * 0.6 + 2000, `${JSON.stringify(trB.json?.entries ?? []).length}B`)
    // filters (each reduces below budget -> unfolded, exact subset, stable replay)
    const toolCount = big.filter((e) => e.type === 'tool_call').length
    const tf = await req(port, 'GET', '/op/trace?sessionId=session-gate-big&type=tool_call')
    ok('PM-005 filter type=tool_call exact subset', tf.json?.folded === false && tf.json?.entries?.length === toolCount && tf.json?.entries?.every((e) => e.type === 'tool_call'), `${tf.json?.entries?.length}/${toolCount}`)
    const tl = await req(port, 'GET', '/op/trace?sessionId=session-gate-big&tool=bash')
    ok('PM-005 filter tool=bash matches data.name', tl.json?.entries?.length === toolCount && tl.json?.entries?.every((e) => e?.data?.name === 'bash'))
    const needleCount = big.filter((e) => JSON.stringify(e).includes('NEEDLE-ALPHA')).length
    const tn = await req(port, 'GET', '/op/trace?sessionId=session-gate-big&text=NEEDLE-ALPHA')
    ok('PM-005 filter text=NEEDLE-ALPHA exact subset (case-insensitive substring)', tn.json?.entries?.length === needleCount, `${tn.json?.entries?.length}/${needleCount}`)
    const ts = await req(port, 'GET', '/op/trace?sessionId=session-gate-big&seqFrom=10&seqTo=20')
    ok('PM-005 filter seq window', ts.json?.entries?.every((e) => e.seq >= 10 && e.seq <= 20) && ts.json?.entries?.length === big.filter((e) => e.seq >= 10 && e.seq <= 20).length)
    const tc = await req(port, 'GET', '/op/trace?sessionId=session-gate-big&type=assistant&text=NEEDLE-ALPHA')
    ok('PM-005 combined filters', tc.json?.entries?.every((e) => e.type === 'assistant' && JSON.stringify(e).includes('NEEDLE-ALPHA')) && tc.json?.entries?.length > 0)
    const tf2 = await req(port, 'GET', '/op/trace?sessionId=session-gate-big&type=tool_call')
    ok('PM-005 filter replay byte-identical', tf.text === tf2.text)
    const trT = await req(port, 'GET', '/op/trace?sessionId=session-gate-torn')
    ok('PM-005 torn tail frame -> partial + logTruncated', trT.status === 200 && trT.json?.logTruncated === true && trT.json?.entries?.length === small.length, `entries=${trT.json?.entries?.length}`)
    const neg1 = await req(port, 'GET', '/op/trace')
    ok('PM-005 missing sessionId -> 400', neg1.status === 400)
    const neg2 = await req(port, 'GET', '/op/trace?sessionId=session-nope')
    ok('PM-005 unknown sid -> 200 status:miss', neg2.status === 200 && neg2.json?.status === 'miss')

    // ---- PM-006 flow: per-db degrade + all-dead CLI fallback ----
    chmodSync(`${sb}/maestro/flows/gate-dead/state.db`, 0o000)
    const fl = await req(port, 'GET', '/op/flow')
    const live = fl.json?.flows?.find((f) => f.flow === 'gate-live')
    const dead = fl.json?.flows?.find((f) => f.flow === 'gate-dead')
    ok('PM-006 healthy db reads via SQL', fl.status === 200 && live?.source === 'sql' && live?.degraded === false && live?.nodes?.some((n) => n.node_id === 'n1'), `nodes=${live?.nodes?.length}`)
    ok('PM-006 unreadable db (chmod 000) degrades THAT flow only', dead?.degraded === true && /unreadable/i.test(dead?.note ?? '') && fl.json?.degraded === false && fl.json?.sqlFailed === 1, `note=${(dead?.note ?? '').slice(0, 60)}`)
    chmodSync(`${sb}/maestro/flows/gate-live/state.db`, 0o000)
    const fl2 = await req(port, 'GET', '/op/flow')
    ok('PM-006 all-dead -> top degraded + flowc CLI fallback, still 200', fl2.status === 200 && fl2.json?.degraded === true && fl2.json?.cliFallback?.ran === true && /fixture/.test(fl2.json?.cliFallback?.raw ?? ''), `raw=${(fl2.json?.cliFallback?.raw ?? '').slice(0, 40)}`)

    // ---- PM-007 subscribe suite ----
    const neg3 = await req(port, 'GET', '/subscribe')
    ok('PM-007 missing consumer -> 400', neg3.status === 400)

    // exactly-once + kinds filter (fs.watch channel + 2s reconcile channel both report)
    const ex1 = await subscribe(port, 'gate-ex1', 'fleet')
    await sleep(300)
    writeFileSync(`${sb}/maestro/ledger.db`, 'gate-ledger-stub\n') // tickets-kind event source
    await sleep(300)
    writeFleet(sb, 1)
    const sig1 = fleetSig(sb)
    const ev1 = await waitFrame(ex1, (f) => f.msgid === `fleet:fleet.json:${sig1}`)
    // let the second channel (reconcile, 2s) have its chance to double-report
    await sleep(3200)
    const dupCount = ex1.frames.filter((f) => f.msgid === `fleet:fleet.json:${sig1}`).length
    ok('PM-007 one change -> exactly ONE frame (watch+reconcile dedup)', ev1 != null && dupCount === 1, `frames for msgid=${dupCount}`)
    ok('PM-007 kinds filter: tickets event not delivered to fleet subscriber', ex1.frames.every((f) => f.kind === 'fleet'), `kinds seen=${[...new Set(ex1.frames.map((f) => f.kind))].join(',')}`)
    await ex1.stop()

    // disconnect -> ring holds E3 -> reconnect replays E3 only -> E4 fresh
    const rc1 = await subscribe(port, 'gate-rc1') // kinds omitted = all
    await sleep(300)
    writeFleet(sb, 2)
    const e1 = await waitFrame(rc1, (f) => f.replay === false && f.source === 'fleet')
    ok('PM-007 reconnect flow: E1 received live', e1 != null, e1?.msgid?.slice(0, 40))
    writeFleet(sb, 3)
    const e2 = await waitFrame(rc1, (f) => f.replay === false && f.source === 'fleet' && f.msgid !== e1?.msgid)
    ok('PM-007 reconnect flow: E2 received live', e2 != null)
    await rc1.stop()
    await sleep(200)
    writeFleet(sb, 4)
    const sigE3 = fleetSig(sb)
    await sleep(2600) // change lands in the ring while disconnected
    const rc2 = await subscribe(port, 'gate-rc1')
    const e3 = await waitFrame(rc2, (f) => f.msgid === `fleet:fleet.json:${sigE3}`)
    ok('PM-007 reconnect replays missed E3 with replay:true', e3?.replay === true, e3?.msgid?.slice(0, 40))
    const replayed = rc2.frames.filter((f) => f.replay === true)
    ok('PM-007 replay carries ONLY post-cursor events (no E1/E2 resend)', replayed.length === 1 && !rc2.frames.some((f) => f.msgid === e1?.msgid || f.msgid === e2?.msgid), `replayed=${replayed.length}`)
    writeFleet(sb, 5)
    const e4 = await waitFrame(rc2, (f) => f.replay === false && f.source === 'fleet')
    ok('PM-007 post-reconnect increment E4 replay:false', e4 != null && e4.replay === false)
    const all = [...rc1.frames, ...rc2.frames].filter((f) => f.t === 'pm.event')
    const counts = new Map()
    for (const f of all) counts.set(f.msgid, (counts.get(f.msgid) ?? 0) + 1)
    ok('PM-007 no dup no loss: every msgid delivered exactly once', [e1?.msgid, e2?.msgid, e3?.msgid, e4?.msgid].every((m) => m && counts.get(m) === 1), `distinct msgids=${counts.size}`)
    await rc2.stop()

    // same consumer second subscription -> old stream pm_sub_ended + replaced
    const dup1 = await subscribe(port, 'gate-dup') // kinds=all
    await sleep(300)
    const dup2 = await subscribe(port, 'gate-dup', 'fleet') // different kinds STILL replaces (declared deviation ①)
    await sleep(300)
    const endedFrame = await (async () => {
      const t0 = Date.now()
      while (Date.now() - t0 < 3000) {
        const f = dup1.frames.find((x) => x.t === 'pm_sub_ended')
        if (f) return f
        await sleep(100)
      }
      return null
    })()
    ok('PM-007 same-consumer resubscribe ends old stream (pm_sub_ended/replaced)', endedFrame?.reason === 'replaced', JSON.stringify(endedFrame ?? null))
    writeFleet(sb, 6)
    const dupEv = await waitFrame(dup2, (f) => f.replay === false && f.source === 'fleet')
    ok('PM-007 new stream undisturbed after replace', dupEv != null)
    const d1len = dup1.frames.filter((f) => f.t === 'pm.event').length
    await sleep(500)
    ok('PM-007 ended stream receives nothing further', dup1.frames.filter((f) => f.t === 'pm.event').length === d1len)
    await dup1.stop()
    await dup2.stop()

    // ---- PM-003 ledger death -> stale cache; recovery ----
    writeFileSync(`${sb}/maestro/ledger-mode`, 'dead9\n')
    await sleepTouch()
    writeFileSync(`${sb}/maestro/tickets.md`, '# tickets\nT-a open\nT-b dispatched\nT-c new\nT-d sigchange\n')
    const t4 = await req(port, 'GET', '/op/tickets')
    ok('PM-003 ledger death -> 200 + degraded:true (never 5xx)', t4.status === 200 && t4.json?.degraded === true, `status=${t4.status}`)
    ok('PM-003 death serves STALE cache with note', t4.json?.cache === 'stale' && /ledger unavailable/.test(t4.json?.note ?? '') && t4.json?.tickets?.length === 2, `cache=${t4.json?.cache} count=${t4.json?.count}`)
    writeFileSync(`${sb}/maestro/ledger-mode`, 'alive\n')
    await sleepTouch()
    writeFileSync(`${sb}/maestro/tickets.md`, '# tickets\nT-a open\nT-b dispatched\nT-c new\nT-d recovered\n')
    const t5 = await req(port, 'GET', '/op/tickets')
    ok('PM-003 recovery -> re-pull healthy again', t5.json?.degraded === false && t5.json?.cache === 'miss' && t5.json?.count === 2, `cache=${t5.json?.cache}`)

    // ---- HF-016: cache-hit degraded = light re-probe (CLI executable), not pull-time forever ----
    chmodSync(`${sb}/maestro/bin/ledger`, 0o000) // probe fails; signature UNCHANGED -> still the hit path
    const t6 = await req(port, 'GET', '/op/tickets')
    ok('HF-016 hit path degrades on light-probe failure without re-pull', t6.status === 200 && t6.json?.cache === 'hit' && t6.json?.degraded === true && /light-probe/.test(t6.json?.note ?? '') && t6.json?.cliSpawns === t5.json?.cliSpawns, `cache=${t6.json?.cache} spawns=${t6.json?.cliSpawns}`)
    chmodSync(`${sb}/maestro/bin/ledger`, 0o755)
    const t7 = await req(port, 'GET', '/op/tickets')
    ok('HF-016 hit path recovers when the probe passes again', t7.json?.cache === 'hit' && t7.json?.degraded === false && t7.json?.cliSpawns === t5.json?.cliSpawns)

    // ---- PM-004 dsh API death -> PMW2-J SWR: 缓存 join 照常服务 (横幅不闪), 刷新失败只累积 note ----
    await mock.close()
    await sleep(3200) // 越过 join 缓存 TTL (SB1 env 钉 3s) -> f3 走 stale 命中
    const f3 = await req(port, 'GET', '/op/fleet')
    ok('PM-004 dsh death -> cached join served, degraded:false (PMW2-J 横幅不闪)', f3.status === 200 && f3.json?.degraded === false && f3.json?.sessionJoined === true && f3.json?.sessionJoinFreshness === 'stale', `freshness=${f3.json?.sessionJoinFreshness} note=${(f3.json?.note ?? '').slice(0, 50)}`)
    ok('PM-004 cached seats still enriched (session data from cache)', f3.json?.count === 2 && f3.json?.seats?.some((s) => s.session?.title === 'gate-mock'), `note=${(f3.json?.note ?? '').slice(0, 60)}`)
    await sleep(2300) // 后台刷新 (dsh 死, 2s 预算) 结算
    const f4 = await req(port, 'GET', '/op/fleet')
    ok('PM-004 dsh death -> refresh failures accumulate in note only', f4.json?.degraded === false && /后台刷新失败/.test(f4.json?.note ?? ''), `note=${(f4.json?.note ?? '').slice(0, 80)}`)

    // ---- HF-007: audit.jsonl must be 0600 (fresh create + legacy heal) ----
    const auditFile = `${sb}/maestro/state/act/audit.jsonl`
    const auditMode = () => { try { return (statSync(auditFile).mode & 0o777).toString(8) } catch { return 'missing' } }
    const a7 = await req(port, 'POST', '/op/act', { tool: 'ledger', args: ['ticket', 'list'] })
    await sleep(800)
    ok('HF-007 audit.jsonl created 0600', a7.status === 200 && auditMode() === '600', `mode=${auditMode()}`)
    chmodSync(auditFile, 0o664) // simulate the legacy wider mode found on live
    const a7b = await req(port, 'POST', '/op/act', { tool: 'ledger', args: ['ticket', 'list'] })
    await sleep(800)
    ok('HF-007 legacy 0664 audit heals to 0600 on next append', a7b.status === 200 && auditMode() === '600', `mode=${auditMode()}`)
  } finally {
    await stopDaemon(child)
  }
}

// ============ SB3: HF-008 boot orphan (flying -> interrupted + event + audit) ============
async function sb3() {
  const sb = `${BASE}/sb3`
  buildSandbox(sb)
  mkdirSync(`${sb}/maestro/state/act`, { recursive: true })
  const ORPHAN = 'vh-deadbeef'
  writeFileSync(`${sb}/maestro/state/act/registry.json`, `${JSON.stringify({ version: 1, cap: 1000, entries: {
    [ORPHAN]: { ref: ORPHAN, tool: 'ledger', args: ['ticket', 'state', 'T-X', 'done'], status: 'flying', submittedAt: '2026-08-29T00:00:00.000Z', submittedMs: 1, finishedAt: null, exitCode: null, error: null, cliSpawns: 1, stdoutTail: '', stderrTail: '' },
  } }, null, 2)}\n`)
  const { child, port } = await startDaemon(sb)
  try {
    console.log(`\n=== SB3 ${sb} (pre-seeded flying orphan ${ORPHAN}) port=${port} ===`)
    const st = await req(port, 'GET', `/op/act?ref=${ORPHAN}`)
    ok('HF-008 orphan readback status=interrupted', st.status === 200 && st.json?.found === true && st.json?.entry?.status === 'interrupted', JSON.stringify(st.json?.entry?.status))
    const audit = readFileSync(`${sb}/maestro/state/act/audit.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    ok('HF-008 boot recovery writes act.settle(interrupted) audit line', audit.some((l) => l.t === 'act.settle' && l.ref === ORPHAN && l.status === 'interrupted'), `audit lines=${audit.length}`)
    const sse = await subscribe(port, 'hf008-sub', 'act') // ring replay flushes headers instantly
    const f = await waitFrame(sse, (x) => x.kind === 'act' && x.ref === ORPHAN, 3000)
    ok('HF-008 orphan settles LOUDLY: kind=act SSE frame (ring replay)', f?.status === 'interrupted' && f?.replay === true, `msgid=${f?.msgid?.slice(0, 40)}`)
    await sse.stop()
  } finally {
    await stopDaemon(child)
  }
}

// ============ SB4: HF-009 absent-vs-broken health semantics ============
async function sb4() {
  const sb = `${BASE}/sb4`
  buildSandbox(sb)
  writeFileSync(`${sb}/maestro/bin/ledger`, LEDGER_ALIVE, { mode: 0o755 }) // CLI present, alive
  // deliberately ABSENT: ledger.db, flows root, sessions root; fleet.json empty map (HF-017 fixture)
  writeFleet(sb, 0)
  writeFileSync(`${sb}/maestro/fleet.json`, `${JSON.stringify({ fleet: {} }, null, 2)}\n`)
  const mock = await startMockDsh()
  const { child, port } = await startDaemon(sb, { DSH_PORT: String(mock.port) })
  try {
    console.log(`\n=== SB4 ${sb} (absent sources + empty fleet map; mock dsh :${mock.port}) port=${port} ===`)
    let h = await req(port, 'GET', '/health')
    ok('HF-009 absent ledger.db -> ledger source live (not degraded)', h.json?.sources?.ledger?.live === true, `note=${(h.json?.sources?.ledger?.note ?? '').slice(0, 50)}`)
    ok('HF-009 absent flows root -> flows source live (not degraded)', h.json?.sources?.flows?.live === true, `note=${(h.json?.sources?.flows?.note ?? '').slice(0, 50)}`)
    ok('HF-009 flows probe reports total 0 readable 0', h.json?.sources?.flows?.total === 0 && h.json?.sources?.flows?.readable === 0)
    // broken variants: files exist but unreadable -> degraded
    writeFileSync(`${sb}/maestro/ledger.db`, 'not-a-db-but-present\n')
    chmodSync(`${sb}/maestro/ledger.db`, 0o000)
    writeFlowDb(`${sb}/maestro/flows/hf009-broken/state.db`)
    chmodSync(`${sb}/maestro/flows/hf009-broken/state.db`, 0o000)
    h = await req(port, 'GET', '/health')
    ok('HF-009 unreadable ledger.db -> ledger source degraded', h.json?.sources?.ledger?.live === false)
    ok('HF-009 unreadable flow db -> flows source degraded (broken != absent)', h.json?.sources?.flows?.live === false && h.json?.sources?.flows?.total === 1, `note=${(h.json?.sources?.flows?.note ?? '').slice(0, 50)}`)

    // ---- HF-017: empty fleet map = structurally valid (not degraded) ----
    const fe = await req(port, 'GET', '/op/fleet')
    ok('HF-017 empty fleet map -> 200 + count 0 + NOT degraded + join live', fe.status === 200 && fe.json?.count === 0 && fe.json?.degraded === false && Array.isArray(fe.json?.seats) && fe.json?.seats.length === 0 && fe.json?.sessionJoined === true, `count=${fe.json?.count} joined=${fe.json?.sessionJoined}`)
    writeFileSync(`${sb}/maestro/fleet.json`, '{not-json')
    const fb = await req(port, 'GET', '/op/fleet')
    ok('HF-017 malformed fleet.json still degrades (broken != empty)', fb.status === 200 && fb.json?.degraded === true && fb.json?.sessionJoined === false && /fleet sources unavailable/.test(fb.json?.note ?? ''), `note=${(fb.json?.note ?? '').slice(0, 60)}`)
    await mock.close()
  } finally {
    await stopDaemon(child)
  }
}

// ============ SB5: HF-014 flock unavailable -> singleton degraded (fail-open visible) ============
async function sb5() {
  const sb = `${BASE}/sb5`
  buildSandbox(sb)
  // PATH WITHOUT /usr/bin: spawnSync('flock') ENOENTs -> lockState 'unavailable'
  // (node itself is spawned by absolute path, so the daemon boots fine).
  const { child, port } = await startDaemon(sb, { PATH: dirname(process.execPath) })
  try {
    console.log(`\n=== SB5 ${sb} (PATH without flock) port=${port} ===`)
    const h = await req(port, 'GET', '/health')
    ok('HF-014 daemon still serves /health 200 when flock is missing', h.status === 200)
    ok('HF-014 singleton source exposed degraded', h.json?.sources?.singleton?.live === false && h.json?.sources?.singleton?.state === 'unavailable', JSON.stringify(h.json?.sources?.singleton))
    ok('HF-014 fail-open visible: top status degraded + listed', h.json?.status === 'degraded' && (h.json?.degraded ?? []).includes('singleton'), `degraded=[${h.json?.degraded}]`)
  } finally {
    await stopDaemon(child)
  }
}

// ============ SB6: PMW2-I dsh_api 探针误靶修复 (liveness=廉价 workspace.list; session.list 慢/坏不连坐) ============
function startMockDshMode(mode) { // mode: 'ok' | 'err-session' | 'slow-session'; workspace.list 探针恒快答
  const server = createServer((rq, rs) => {
    const chunks = []
    rq.on('data', (d) => chunks.push(d))
    rq.on('end', () => {
      const reply = (obj, delay = 0) => setTimeout(() => { rs.writeHead(200, { 'content-type': 'application/json' }); rs.end(JSON.stringify(obj)) }, delay)
      if (/workspace\.list/.test(rq.url ?? '')) return reply({ result: { ok: true, value: { items: [] } } })
      if (mode === 'err-session') return reply({ result: { ok: false, error: 'injected: session.list broken (PMW2-I gate)' } })
      if (mode === 'slow12-session') return reply({ result: { ok: true, value: { items: [
        { sessionId: 'session-x', running: true, blank: false, agentPreset: 'maestro', cwd: '/tmp/gate', projections: { values: { title: 'gate-mock' } } },
      ] } } }, 12_000)
      if (mode === 'slow-session') return reply({ result: { ok: true, value: { items: [
        { sessionId: 'session-x', running: true, blank: false, agentPreset: 'maestro', cwd: '/tmp/gate', projections: { values: { title: 'gate-mock' } } },
      ] } } }, 2500)
      return reply({ result: { ok: true, value: { items: [ // 'ok' 及其余: 快答 + session-x (PMW2-J SB7 冷启动 warm 面)
        { sessionId: 'session-x', running: true, blank: false, agentPreset: 'maestro', cwd: '/tmp/gate', projections: { values: { title: 'gate-mock' } } },
      ] } } })
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server,
    port: server.address().port,
    setMode: (m) => { mode = m }, // PMW2-J: 运行中切换 mock 行为 (注入慢/恢复)
    close: () => new Promise((r) => server.close(r)),
  })))
}

async function sb6() {
  // Phase A: session.list rpc 报错 -> fleet join 独立降级注记(joined:false+原因), dsh_api 探针仍 live (走 workspace.list)
  {
    const sb = `${BASE}/sb6a`
    buildSandbox(sb)
    writeFleet(sb, 0)
    const mock = await startMockDshMode('err-session')
    const { child, port } = await startDaemon(sb, { DSH_PORT: String(mock.port) })
    try {
      console.log(`\n=== SB6a ${sb} (session.list broken; mock dsh :${mock.port}) port=${port} ===`)
      const h = await req(port, 'GET', '/health')
      const d = h.json?.sources?.dsh_api
      ok('PMW2-I probe targets cheap workspace.list endpoint', typeof d?.url === 'string' && d.url.includes('workspace.list'), `url=${d?.url}`)
      ok('PMW2-I dsh_api live despite broken session.list', d?.live === true, JSON.stringify(d))
      ok('PMW2-I health face exposes latency_ms (number)', typeof d?.latency_ms === 'number' && d.latency_ms >= 0, `latency_ms=${d?.latency_ms}`)
      const f = await req(port, 'GET', '/op/fleet')
      ok('PMW2-I broken session.list -> fleet join degraded note honest (joined:false + reason)', f.status === 200 && f.json?.degraded === true && f.json?.sessionJoined === false && /rpc error|session\.list/.test(f.json?.note ?? ''), `note=${(f.json?.note ?? '').slice(0, 90)}`)
      ok('PMW2-I pure fleet view still served (seats present, 200)', f.json?.count > 0 && Array.isArray(f.json?.seats), `count=${f.json?.count}`)
    } finally {
      await stopDaemon(child)
      await mock.close()
    }
  }
  // Phase B: session.list 慢 2.5s (> 旧 1s 健康预算, < 10s join 预算) -> join 照常成功 + dsh_api 仍 live
  {
    const sb = `${BASE}/sb6b`
    buildSandbox(sb)
    writeFleet(sb, 0)
    const mock = await startMockDshMode('slow-session')
    const { child, port } = await startDaemon(sb, { DSH_PORT: String(mock.port) })
    try {
      console.log(`\n=== SB6b ${sb} (session.list +2.5s; mock dsh :${mock.port}) port=${port} ===`)
      const f = await req(port, 'GET', '/op/fleet')
      const seat = (f.json?.seats ?? []).find((s) => s.sessionId === 'session-x')
      ok('PMW2-I slow session.list (2.5s<10s budget) -> join still succeeds', f.status === 200 && f.json?.sessionJoined === true && f.json?.degraded === false && seat?.session?.title === 'gate-mock', `joined=${f.json?.sessionJoined} title=${seat?.session?.title}`)
      const h = await req(port, 'GET', '/health')
      ok('PMW2-I slow session.list does not drag dsh_api liveness', h.json?.sources?.dsh_api?.live === true && typeof h.json?.sources?.dsh_api?.latency_ms === 'number', JSON.stringify(h.json?.sources?.dsh_api))
    } finally {
      await stopDaemon(child)
      await mock.close()
    }
  }
}

// ============ SB7: PMW2-J join 缓存 + stale-while-revalidate (慢 session.list 不再闪横幅) ============
async function sb7() {
  const JOIN_BUDGET = 2000 // 沙箱 join 预算 (env PM_JOIN_TIMEOUT_MS)
  const TTL = 3000 // 沙箱缓存 TTL (env PM_JOIN_CACHE_TTL_MS)
  const env = { PM_JOIN_TIMEOUT_MS: String(JOIN_BUDGET), PM_JOIN_CACHE_TTL_MS: String(TTL) }
  const sb = `${BASE}/sb7`
  buildSandbox(sb)
  writeFleet(sb, 0)
  const mock = await startMockDshMode('ok')
  const { child, port } = await startDaemon(sb, { DSH_PORT: String(mock.port), ...env })
  try {
    console.log(`\n=== SB7 ${sb} (join cache SWR; mock dsh :${mock.port}) port=${port} ===`)
    const f1 = await req(port, 'GET', '/op/fleet')
    ok('PMW2-J cold first pull -> fresh join (现行为)', f1.status === 200 && f1.json?.degraded === false && f1.json?.sessionJoined === true && f1.json?.sessionJoinFreshness === 'fresh' && f1.json?.seats?.[0]?.session?.title === 'gate-mock', `freshness=${f1.json?.sessionJoinFreshness}`)
    const f2 = await req(port, 'GET', '/op/fleet')
    ok('PMW2-J cache hit (fresh) -> 立即回, 与冷启动字节一致 (note 空, freshness 字段 fresh)', f2.json?.sessionJoinFreshness === 'fresh' && f2.json?.note === '' && f2.text === f1.text, `note=${JSON.stringify(f2.json?.note)}`)

    mock.setMode('slow12-session') // 注入 12s 慢 session.list (> 预算 2s)
    await sleep(TTL + 600) // 等 TTL 过期
    const t0 = Date.now()
    const f3 = await req(port, 'GET', '/op/fleet')
    const dur3 = Date.now() - t0
    ok('PMW2-J 过期缓存命中: 立即回(不阻塞 2s 预算) + stale 注记 + degraded:false(横幅不闪)', f3.status === 200 && f3.json?.degraded === false && f3.json?.sessionJoined === true && f3.json?.sessionJoinFreshness === 'stale' && /stale age=/.test(f3.json?.note ?? '') && dur3 < 1500, `dur=${dur3}ms freshness=${f3.json?.sessionJoinFreshness} note=${(f3.json?.note ?? '').slice(0, 60)}`)
    await sleep(JOIN_BUDGET + 800) // 等后台刷新 (12s 慢源 → 2s 预算 abort) 结算
    const f4 = await req(port, 'GET', '/op/fleet')
    ok('PMW2-J 后台刷新失败只累积 note (degraded 仍 false)', f4.json?.degraded === false && /后台刷新失败 x1/.test(f4.json?.note ?? ''), `note=${(f4.json?.note ?? '').slice(0, 80)}`)

    mock.setMode('ok') // 恢复
    await req(port, 'GET', '/op/fleet') // 触发后台刷新
    await sleep(1200)
    const f5 = await req(port, 'GET', '/op/fleet')
    ok('PMW2-J 恢复后后台刷新回 fresh + 失败计数清零', f5.json?.sessionJoinFreshness === 'fresh' && !/后台刷新失败/.test(f5.json?.note ?? ''), `note=${f5.json?.note}`)
  } finally {
    await stopDaemon(child)
    await mock.close()
  }
  // Phase 4: 冷启动 + 慢源 → 首拉阻塞到预算后如实 degraded (现行为保留)
  {
    const sb = `${BASE}/sb7-cold`
    buildSandbox(sb)
    writeFleet(sb, 0)
    const mock = await startMockDshMode('slow12-session')
    const { child, port } = await startDaemon(sb, { DSH_PORT: String(mock.port), ...env })
    try {
      const t0 = Date.now()
      const f = await req(port, 'GET', '/op/fleet')
      const dur = Date.now() - t0
      ok('PMW2-J 冷启动无缓存: 首拉阻塞到预算后如实 degraded', f.json?.degraded === true && f.json?.sessionJoined === false && /unreachable/.test(f.json?.note ?? '') && dur >= JOIN_BUDGET && dur < JOIN_BUDGET + 3000, `dur=${dur}ms note=${(f.json?.note ?? '').slice(0, 60)}`)
    } finally {
      await stopDaemon(child)
      await mock.close()
    }
  }
}
async function sb2() {
  const sb = `${BASE}/sb2`
  buildSandbox(sb) // no fixtures: ledger/fleet/sessions all absent by design
  const { child, port: port1 } = await startDaemon(sb)
  try {
    console.log(`\n=== SB2 ${sb} port=${port1} ===`)
    const h = await req(port1, 'GET', '/health')
    ok('SB2 boot /health 200 despite missing sources', h.status === 200 && h.json?.version === VERSION)
    ok('HF-014 control: normal PATH -> singleton held + not in degraded list', h.json?.sources?.singleton?.live === true && h.json?.sources?.singleton?.state === 'held' && !(h.json?.degraded ?? []).includes('singleton'))

    // PM-003 boot-time ledger death (no cache yet) -> EMPTY degraded state, not 5xx
    const t = await req(port1, 'GET', '/op/tickets')
    ok('PM-003 boot-death -> 200 + degraded + EMPTY state (no cache yet)', t.status === 200 && t.json?.degraded === true && t.json?.cache === 'empty' && t.json?.count === 0, `cache=${t.json?.cache}`)

    // PM-002 flock: second bare instance against the SAME sandbox lock exits 0 fast
    const t0 = Date.now()
    const second = spawn(process.execPath, [`${REPO}/service.mjs`], { env: daemonEnv(sb), stdio: 'ignore' })
    const rc = await waitExit(second, 8000)
    const dur = Date.now() - t0
    ok('PM-002 flock loser exits 0 fast', rc === 0 && dur < 4000, `rc=${rc} dur=${dur}ms`)
    const h2 = await req(port1, 'GET', '/health')
    const pf = JSON.parse(readFileSync(`${sb}/maestro/pm.port`, 'utf8'))
    ok('PM-002 live instance untouched by loser', h2.status === 200 && pf.pid === child.pid && pf.port === port1, `pid=${pf.pid}`)

    // PM-002 restart drift: new port published, old port refused
    await stopDaemon(child)
    const { child: child2, port: port2 } = await startDaemon(sb)
    try {
      const pf2 = JSON.parse(readFileSync(`${sb}/maestro/pm.port`, 'utf8'))
      ok('PM-002 restart -> pm.port rewritten (new port, new pid, version field)', port2 !== port1 && pf2.pid === child2.pid && pf2.version === VERSION && pf2.bind === '127.0.0.1', `${port1} -> ${port2}`)
      let oldRefused = false
      try { await fetch(`http://127.0.0.1:${port1}/health`) } catch { oldRefused = true }
      ok('PM-002 old port refused after restart', oldRefused)
      const h3 = await req(port2, 'GET', '/health')
      ok('PM-002 new port serves 200', h3.status === 200 && h3.json?.pid === child2.pid)
      await stopDaemon(child2)
    } catch (e) { await stopDaemon(child2); throw e }
  } finally {
    try { await stopDaemon(child) } catch {}
  }
}

mkdirSync(BASE, { recursive: true })
const startedAt = new Date().toISOString()
// HF-015: engines floor must match the real API floor (node:zlib zstd landed
// v23.8.0, node:sqlite unflagged v23.4.0 -> 23.8.0) AND the running node
// must actually expose both — measured, not remembered.
{
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  ok('HF-015 engines floor = >=23.8.0 (measured API floor)', pkg.engines?.node === '>=23.8.0', `engines=${pkg.engines?.node}`)
  const { zstdDecompressSync } = await import('node:zlib')
  const { DatabaseSync } = await import('node:sqlite')
  ok('HF-015 runtime exposes node:zlib zstd + node:sqlite unflagged', typeof zstdDecompressSync === 'function' && typeof DatabaseSync === 'function', process.version)
  // HF-018: declared deviation ② closed by wording — the consumer-side msgid
  // dedup obligation must stay documented (cross-boot ring replay bypasses
  // the server dedup window by design).
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  ok('HF-018 deviation ② documents consumer msgid-dedup obligation', /跨 boot 一律全环回放/.test(readme) && /消费端按 `msgid` 去重/.test(readme) && /不经服务端 60s 去重窗/.test(readme))
}
await sb1()
await sb2()
await sb3()
await sb4()
await sb5()
await sb6()
await sb7()
writeFileSync(`${BASE}/manifest.json`, `${JSON.stringify({ label: LABEL, gate: 'pm001-007', startedAt, finishedAt: new Date().toISOString(), pass, fail, version: VERSION, node: process.version, repo: REPO }, null, 2)}\n`)
console.log(`\n=== ${LABEL}: PASS=${pass} FAIL=${fail} (evidence: ${BASE}) ===`)
process.exit(fail === 0 ? 0 : 1)
