#!/usr/bin/env node
// pmw2-f-fix-gate.mjs — PMW2-F 验收尾差修复 gate (D1 + D2, 依据 pmw2-v-acceptance.md).
//
// A. 静态门: canvas.js ESC 接线标记 (回放态才接管 + dialog 让位) + service.mjs
//    D2 旗标跟源 (`live = !t.degraded`); 红线: elk sha256 钉死, app.js/index.html
//    相对 HEAD 零 diff (service.mjs/canvas.js 本票获准改动)。
// B. D1 live CDP: 载入回放 → 游标 30% (回放态) → dispatch Escape → 游标跳 now +
//    切实况 (badge 实况 / cv-future 清零 / range=1000); 非回放态 ESC 不抢语义
//    (确认门 dialog 原生关闭不受扰); 截图 esc-exit-replay.png。
// C. D2 sandbox (注入法照 acceptance EV4(c): mv stub ledger, 暖缓存不断重启):
//    健康态双端点 live/degraded:false → mv 断 CLI: /op/tickets degraded:true+
//    cache:hit+轻探针 note, /op/graph degraded:true+sources.tickets.live:false
//    (同源同值, stale 票节点仍服务) → mv 复位: 双端点回 live。
// 留存 (HF-013 ②): $PM_HOST_SERVICE_GATES_DIR/pmw2-f/<label>/。
// Usage: node pmw2-f-fix-gate.mjs <label> [chrome-bin]
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'

const LABEL = process.argv[2] ?? `manual-${process.pid}`
const CHROME = process.argv[3] ?? process.env.CHROME_BIN ?? 'google-chrome'
const GATES_ROOT = process.env.PM_HOST_SERVICE_GATES_DIR ?? `${homedir()}/.dsh/maestro/logs/pm-host-service/gates`
const BASE = `${GATES_ROOT}/pmw2-f/${LABEL}`
const PUBLIC = new URL('../public/', import.meta.url).pathname
const REPO = new URL('..', import.meta.url).pathname
const SPEC_SHA = '1222e44f953ce7746af23801e723708f8e6f436b8b377a6a5fc7552f34a307b3'

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}${detail ? `  :: ${detail}` : ''}`) } else { fail++; console.log(`FAIL ${name}${detail ? `  :: ${detail}` : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

// ---------- A. 静态门 ----------
{
  const cv = readFileSync(`${PUBLIC}canvas.js`, 'utf8')
  ok('A D1: ESC 接线(回放态才接管 + dialog 让位 + exitReplay)', /e\.key !== 'Escape' \|\| !C\.replay\.on\) return/.test(cv) && /if \(\$\('#cv-act-confirm'\)\?\.open\) return/.test(cv) && /Escape' \|\| !C\.replay\.on[\s\S]{0,200}exitReplay\(\)/.test(cv))
  const svc = readFileSync(`${REPO}service.mjs`, 'utf8')
  ok('A D2: gatherTicketGraph live = !t.degraded (旗标跟源)', /const live = !t\.degraded/.test(svc) && /旗标跟源/.test(svc))
  const buf = readFileSync(`${PUBLIC}elk.bundled.js`)
  ok('红线: elk vendor sha256 仍钉死 (零触碰)', sha256(buf) === SPEC_SHA, sha256(buf).slice(0, 16) + '…')
  const dirty = spawnSync('git', ['-C', REPO, 'diff', '--name-only', 'HEAD', '--', 'plugins/pm-host-service/public/app.js', 'plugins/pm-host-service/public/index.html', 'plugins/pm-host-service/public/style.css', 'plugins/pm-host-service/public/elk.bundled.js', 'plugins/pm-host-service/public/elk.js'], { encoding: 'utf8' }).stdout.trim()
  ok('红线: app.js / index.html / style.css / elk* 相对 HEAD 零 diff', dirty === '', dirty || '(clean)')
}

// ---------- sandbox 工厂 (pmw2-3 惯例; stub ledger 可 mv 断/复) ----------
const SEATS = { g1: { code: 'g1', sessionId: 'session-x', role: 'worker', node: 'n1', preset: 'maestro', spawnedAt: '2026-08-31T00:00:00Z', status: 'active' } }
function writeFleet(sb) {
  writeFileSync(`${sb}/maestro/fleet.json.tmp.${process.pid}`, `${JSON.stringify({ rev: 1, fleet: SEATS }, null, 2)}\n`)
  renameSync(`${sb}/maestro/fleet.json.tmp.${process.pid}`, `${sb}/maestro/fleet.json`)
}
function writeFlowDb(path) {
  mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE nodes(node_id TEXT NOT NULL, verb TEXT, state TEXT NOT NULL, attempts INTEGER DEFAULT 0, events INTEGER DEFAULT 0, deps TEXT)')
  db.exec("INSERT INTO nodes VALUES('n1','rollup','done',0,2,NULL)")
  db.exec('CREATE VIEW v_status AS SELECT node_id, verb, state, attempts, events FROM nodes')
  db.exec('CREATE VIEW v_rollup AS SELECT state, COUNT(*) AS n FROM nodes GROUP BY state')
  db.exec('CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT, node_id TEXT, detail TEXT)')
  db.close()
}
const LEDGER_STUB = (sb) => `#!/bin/bash
SB="${sb}"
if [ "$1 $2" = "ticket list" ]; then
  s1=$(cat "$SB/T-G1.state" 2>/dev/null || echo running)
  echo "{\\"tickets\\":[{\\"ticket_id\\":\\"T-G1\\",\\"state\\":\\"$s1\\",\\"deps\\":\\"[]\\",\\"refs\\":\\"{}\\",\\"lease_owner\\":null}]}"
  exit 0
fi
echo "stub-ok"; exit 0
`
async function startSandbox() {
  const sb = `${BASE}/sb`
  rmSync(sb, { recursive: true, force: true })
  mkdirSync(`${sb}/maestro/bin`, { recursive: true })
  writeFileSync(`${sb}/maestro/bin/ledger`, LEDGER_STUB(sb), { mode: 0o755 })
  writeFileSync(`${sb}/maestro/bin/flowc`, '#!/bin/bash\necho "flowc inspect (stub)"; exit 0\n', { mode: 0o755 })
  writeFileSync(`${sb}/maestro/bin/fleet-list`, '#!/bin/bash\necho "[]"\n', { mode: 0o755 })
  writeFleet(sb)
  writeFlowDb(`${sb}/maestro/flows/gate-live/state.db`)
  mkdirSync(`${sb}/maestro/bridge`, { recursive: true })
  writeFileSync(`${sb}/maestro/bridge/inbox.log`, '') // bridge 源安静 (空文件=live), 隔离 D2 断言噪声
  const mock = createServer((rq, rs) => {
    const chunks = []
    rq.on('data', (d) => chunks.push(d))
    rq.on('end', () => { rs.writeHead(200, { 'content-type': 'application/json' }); rs.end(JSON.stringify({ result: { ok: true, value: { items: [{ sessionId: 'session-x', running: true, cwd: '/tmp/gate', projections: { values: { title: 'pmw2f-mock' } } }] } } })) })
  })
  await new Promise((r) => mock.listen(0, '127.0.0.1', r))
  const env = {
    ...process.env, MAESTRO_HOME: sb,
    PM_HOST_SERVICE_LEDGER: `${sb}/maestro/bin/ledger`,
    PM_HOST_SERVICE_FLOWC: `${sb}/maestro/bin/flowc`,
    PM_HOST_SERVICE_FLEET_LIST: `${sb}/maestro/bin/fleet-list`,
    PM_HOST_SERVICE_TICKETS_MD: `${sb}/maestro/tickets.md`,
    MAESTRO_FLEET: `${sb}/maestro/fleet.json`,
    MAESTRO_FLOWS_ROOT: `${sb}/maestro/flows`,
    DSH_SESSIONS_ROOT: `${sb}/sessions`,
    DSH_PORT: String(mock.address().port),
  }
  const child = spawn(process.execPath, [`${REPO}service.mjs`], { env, stdio: 'ignore' })
  let port = 0
  for (let i = 0; i < 100 && !port; i++) { await sleep(100); try { const p = JSON.parse(readFileSync(`${sb}/maestro/pm.port`, 'utf8')); if (p.pid === child.pid) port = p.port } catch {} }
  if (!port) throw new Error('sandbox never published pm.port')
  return { sb, port, stop: async () => { child.kill('SIGTERM'); await new Promise((r) => mock.close(r)); await sleep(150) } }
}
const getJson = async (port, path) => { const r = await fetch(`http://127.0.0.1:${port}${path}`); return { status: r.status, json: await r.json().catch(() => null) } }

// ---------- CDP ----------
class Cdp {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.handlers = [] }
  open() {
    this.ws = new WebSocket(this.url)
    return new Promise((res, rej) => {
      this.ws.onopen = res
      this.ws.onerror = () => rej(new Error('ws error'))
      this.ws.onmessage = (m) => {
        const msg = JSON.parse(m.data)
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { res, rej } = this.pending.get(msg.id)
          this.pending.delete(msg.id)
          msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result)
        } else if (msg.method) for (const h of this.handlers) h(msg)
      }
    })
  }
  on(fn) { this.handlers.push(fn) }
  send(method, params = {}) {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((res, rej) => this.pending.set(id, { res, rej }))
  }
  async eval(expr, awaitPromise = false) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise })
    if (r.exceptionDetails) throw new Error('page eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 200))
    return r.result?.value
  }
  async shot(file) { const r = await this.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(file, Buffer.from(r.data, 'base64')); return file }
  close() { try { this.ws.close() } catch {} }
}
async function newChrome(tag) {
  const dir = `${BASE}/chrome-${tag}`
  mkdirSync(dir, { recursive: true })
  const proc = spawn(CHROME, ['--headless=new', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', '--window-size=1600,1000', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
  let wsUrl = null
  proc.stderr.on('data', (d) => { const m = /DevTools listening on (ws:\/\/\S+)/.exec(String(d)); if (m) wsUrl = m[1] })
  for (let i = 0; i < 100 && !wsUrl; i++) await sleep(100)
  if (!wsUrl) throw new Error('chrome no devtools ws')
  const debugPort = /127\.0\.0\.1:(\d+)\//.exec(wsUrl)[1]
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()
  const cdp = new Cdp(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
  await cdp.open()
  return { proc, cdp }
}
const killChrome = async (c) => { c?.cdp?.close(); if (c?.proc) { c.proc.kill('SIGKILL'); await sleep(150) } }
async function openCanvas(c, port, errors) {
  c.cdp.on((m) => { if (m.method === 'Runtime.exceptionThrown') errors.push(JSON.stringify(m.params?.exceptionDetails ?? {}).slice(0, 140)) })
  await c.cdp.send('Page.enable')
  await c.cdp.send('Runtime.enable')
  await c.cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/` })
  let ready = false
  for (let i = 0; i < 100 && !ready; i++) { await sleep(300); try { ready = await c.cdp.eval('window.__pmCanvas && window.__pmCanvas.ready === true') } catch {} }
  await c.cdp.eval(`document.querySelector('[data-view="canvas"]').click()`)
  let mode = ''
  for (let i = 0; i < 40 && mode !== 'canvas'; i++) { await sleep(250); mode = await c.cdp.eval('window.__pmCanvas ? window.__pmCanvas.mode : ""') }
  await sleep(500)
  return { ready, mode }
}

// ---------- B. D1 live CDP ----------
async function d1Part(livePort) {
  const shot = (f) => `${BASE}/${f}`
  const errors = []
  const c = await newChrome('live')
  const { ready, mode } = await openCanvas(c, livePort, errors)
  ok('B D1: 页面就绪 + 画布模式', ready && mode === 'canvas', `ready=${ready} mode=${mode}`)
  // 非回放态 ESC 不抢: 确认门 dialog 原生关闭不受扰 (冒烟: 无异常即可, dialog 全链归 pmw2-3 gate)
  await c.cdp.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  const nonReplay = await c.cdp.eval(`({ replay: window.__pmCanvas.replay.on, future: document.querySelectorAll('.cv-future').length })`)
  ok('B D1: 非回放态 ESC 无副作用', nonReplay.replay === false && nonReplay.future === 0, JSON.stringify(nonReplay))
  // 载入回放 → 游标 30% → ESC
  await c.cdp.eval(`document.querySelector('#cv-tl-load').click()`)
  let rp = null
  for (let i = 0; i < 120; i++) { await sleep(500); rp = await c.cdp.eval('window.__pmCanvas.replay'); if (rp.loaded) break }
  ok('B D1: 回放流就绪', !!rp?.loaded, JSON.stringify(rp))
  await c.cdp.eval(`(() => { const r = document.querySelector('#cv-tl-range'); r.value = '300'; r.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  await sleep(300)
  const mid = await c.cdp.eval('({ on: window.__pmCanvas.replay.on, mode: document.querySelector("#cv-tl-mode").textContent, cursor: window.__pmCanvas.replay.cursor })')
  ok('B D1: 前置回放态(游标 30%)', mid.on === true && mid.mode === '回放中', JSON.stringify(mid))
  await c.cdp.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await sleep(400)
  const after = await c.cdp.eval(`({
    on: window.__pmCanvas.replay.on,
    cursor: window.__pmCanvas.replay.cursor,
    max: window.__pmCanvas.replay.max,
    mode: document.querySelector('#cv-tl-mode').textContent,
    future: document.querySelectorAll('.cv-future').length,
    range: document.querySelector('#cv-tl-range').value,
  })`)
  ok('B D1: ESC → 游标跳 now + 切实况(spec §4-12)', after.on === false && after.mode === '实况' && after.future === 0 && after.range === '1000' && Math.abs(after.cursor - after.max) <= 2000, JSON.stringify(after))
  await c.cdp.shot(shot('esc-exit-replay.png'))
  ok('B 证据: esc-exit-replay.png', statSync(shot('esc-exit-replay.png')).size > 10000)
  ok('B D1 段页面零异常', errors.length === 0, errors.slice(0, 2).join(' | '))
  await killChrome(c)
}

// ---------- C. D2 sandbox 暖缓存注入 ----------
async function d2Part() {
  const box = await startSandbox()
  const LEDGER = `${box.sb}/maestro/bin/ledger`
  const HIDDEN = `${box.sb}/maestro/bin/.ledger.hidden`
  try {
    // 健康态
    const t0 = await getJson(box.port, '/op/tickets')
    const g0 = await getJson(box.port, '/op/graph')
    ok('C D2 健康: /op/tickets degraded:false', t0.json?.degraded === false, `cache=${t0.json?.cache}`)
    ok('C D2 健康: /op/graph degraded:false + tickets.live:true', g0.json?.degraded === false && g0.json?.sources?.tickets?.live === true, JSON.stringify(g0.json?.sources?.tickets))
    // 注入: mv stub ledger (暖缓存, 不断重启 — acceptance EV4(c) 同法)
    renameSync(LEDGER, HIDDEN)
    const t1 = await getJson(box.port, '/op/tickets')
    const g1 = await getJson(box.port, '/op/graph')
    ok('C D2 断源(暖): /op/tickets degraded:true + cache:hit + 轻探针 note', t1.json?.degraded === true && t1.json?.cache === 'hit' && /light-probe/.test(t1.json?.note ?? ''), `note=${(t1.json?.note ?? '').slice(0, 60)}`)
    ok('C D2 断源(暖): /op/graph sources.tickets.live:false + degraded:true', g1.json?.degraded === true && g1.json?.sources?.tickets?.live === false, JSON.stringify(g1.json?.sources?.tickets))
    ok('C D2 断源(暖): 双端点旗标同源同值', g1.json?.degraded === t1.json?.degraded && g1.json?.sources?.tickets?.live === !t1.json?.degraded, `tickets.degraded=${t1.json?.degraded} graph.degraded=${g1.json?.degraded}`)
    const tkNodes = g1.json?.counts?.byType?.ticket ?? 0
    ok('C D2 断源(暖): stale 票节点仍如实服务', tkNodes >= 1, `ticket nodes=${tkNodes}`)
    ok('C D2 断源(暖): note 透传轻探针信息', /light-probe/.test(g1.json?.note ?? ''), (g1.json?.note ?? '').slice(0, 100))
    // 复位
    renameSync(HIDDEN, LEDGER)
    const t2 = await getJson(box.port, '/op/tickets')
    const g2 = await getJson(box.port, '/op/graph')
    ok('C D2 恢复: /op/tickets degraded:false', t2.json?.degraded === false && t2.json?.cache === 'hit')
    ok('C D2 恢复: /op/graph degraded:false + tickets.live:true (双端点回 live)', g2.json?.degraded === false && g2.json?.sources?.tickets?.live === true && g2.json?.degraded === t2.json?.degraded)
  } finally {
    try { renameSync(HIDDEN, LEDGER) } catch {}
    await box.stop()
  }
}

// ---------- 部署 + 运行 ----------
mkdirSync(BASE, { recursive: true })
const startedAt = new Date().toISOString()
const PORT_FILE = `${homedir()}/.dsh/maestro/pm.port`
const oldPort = JSON.parse(readFileSync(PORT_FILE, 'utf8')).port
spawnSync('systemctl', ['--user', 'try-restart', 'pm-host-service'])
let livePort = 0
for (let i = 0; i < 80; i++) {
  await sleep(250)
  try { const p = JSON.parse(readFileSync(PORT_FILE, 'utf8')); if (p.port !== oldPort) { livePort = p.port; break } } catch {}
}
ok('部署: try-restart 后端口漂移(静态面新快照)', livePort > 0, `old=${oldPort} new=${livePort}`)
const health = await (await fetch(`http://127.0.0.1:${livePort}/health`)).json()
ok('部署: /health 200 且服务版本可见', !!health?.version, `v${health?.version}`)

await d1Part(livePort)
await d2Part()

writeFileSync(`${BASE}/manifest.json`, `${JSON.stringify({ label: LABEL, gate: 'pmw2-f-fix', startedAt, finishedAt: new Date().toISOString(), pass, fail, node: process.version, repo: REPO }, null, 2)}\n`)
console.log(`\n=== ${LABEL}: PASS=${pass} FAIL=${fail} (evidence: ${BASE}) ===`)
process.exit(fail === 0 ? 0 : 1)
