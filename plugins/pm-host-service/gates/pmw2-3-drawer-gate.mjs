#!/usr/bin/env node
// pmw2-3-drawer-gate.mjs — PMW2-3 节点抽屉 + 过门 act gate.
//
// A. 静态门 (零浏览器): canvas.js 动作面标记 (迁移表镜像/不可逆集/两类 act 构造/
//    确认弹层/双路对账); 红线: service.mjs 与 app.js 相对 HEAD 零 diff, elk vendor
//    sha256 仍钉死 (§3 例外零触碰); package.json 仍零依赖。
// B. 浏览器门- live (部署=try-restart, 只读点击, 零 act): 四型节点抽屉各截图 +
//    型别正确字段断言; 关抽屉/空白点击取消路径; 页面零异常。
// C. 浏览器门- sandbox (stub ledger/flowc + fleet fixture + mock dsh, 零 live 变更):
//    合法转移成功 (确认弹层动作全文+影响节点 → 回执 ref 入历史 → settle ok →
//    graph 直刷回显终态); 不可逆双确认 (确认钮禁用 → checkbox 勾选 → 可提交);
//    取消路径 (stub 调用数不变); flow-node --result advance; 断 SSE → act 响应
//    直刷闭环 (无 SSE 仍 settle + 立即 refetch)。
// 页面异常 (Runtime.exceptionThrown) 任何一例即 FAIL。
// 留存 (HF-013 ②): 截图/日志落 $PM_HOST_SERVICE_GATES_DIR/pmw2-3/<label>/。
// Usage: node pmw2-3-drawer-gate.mjs <label> [chrome-bin]
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'

const LABEL = process.argv[2] ?? `manual-${process.pid}`
const CHROME = process.argv[3] ?? process.env.CHROME_BIN ?? 'google-chrome'
const GATES_ROOT = process.env.PM_HOST_SERVICE_GATES_DIR ?? `${homedir()}/.dsh/maestro/logs/pm-host-service/gates`
const BASE = `${GATES_ROOT}/pmw2-3/${LABEL}`
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
  ok('A 动作面: ledger 迁移表七态镜像', ['dispatched', 'running', 'blocked', 'done', 'merged', 'rejected', "'rolled-back'"].every((s) => cv.includes(s)))
  ok('A 动作面: 不可逆集 blocked/rejected/merged/rolled-back', /const IRREV = new Set\(\['blocked', 'rejected', 'merged', 'rolled-back'\]\)/.test(cv))
  ok('A 两类 act 构造: flowc advance --result / ledger ticket state', /args: \['advance', n\.flow, n\.nodeId, '--result', result\]/.test(cv) && /args: \['ticket', 'state', n\.ticketId, state\]/.test(cv))
  ok('A 确认门: 弹层 + 双确认 checkbox', cv.includes('id="cv-act-confirm"') && cv.includes('cv-act-irrev-chk') && /disabled = !!cmd\.irrev/.test(cv))
  ok('A 唯一写路径: fetch POST /op/act', /fetch\('\/op\/act', \{/.test(cv) && /method: 'POST'/.test(cv))
  ok('A 双路对账: SSE act 事件 + GET /op/act?ref 轮询', /kind === 'act'/.test(cv) && /\/op\/act\?ref=/.test(cv))
  ok('A 抽屉: 四型明细字段', ['verb / 形制', '关联票', 'refs 证据链', '会话态 join', '挂靠席位'].every((s) => cv.includes(s)))
  ok('A 抽屉: 历史 ref+ts+动作', cv.includes('cv-drawer-hist') && cv.includes('e.ts') && cv.includes('e.ref'))
  ok('A refetch 回显: syncDrawer 挂入 refetchGraph', cv.includes('renderCounts(degradedNote)\n    syncDrawer()'))
  const buf = readFileSync(`${PUBLIC}elk.bundled.js`)
  ok('红线: elk vendor sha256 仍钉死 (零触碰)', sha256(buf) === SPEC_SHA, sha256(buf).slice(0, 16) + '…')
  const pkg = JSON.parse(readFileSync(`${REPO}package.json`, 'utf8'))
  ok('宪章: package.json 仍零依赖字段', !pkg.dependencies && !pkg.devDependencies && !pkg.optionalDependencies)
  const dirty = spawnSync('git', ['-C', REPO, 'diff', '--name-only', 'HEAD', '--', 'plugins/pm-host-service/service.mjs', 'plugins/pm-host-service/public/app.js'], { encoding: 'utf8' }).stdout.trim()
  ok('红线: service.mjs 与 app.js 相对 HEAD 零 diff', dirty === '', dirty || '(clean)')
}

// ---------- sandbox 工厂 (pm001-007-gate 惯例) ----------
const SEATS = {
  g1: { code: 'g1', sessionId: 'session-x', role: 'worker', node: 'n1', preset: 'maestro', spawnedAt: '2026-08-31T00:00:00Z', status: 'active' },
}
function writeFleet(sb) {
  const file = `${sb}/maestro/fleet.json`
  writeFileSync(`${file}.tmp.${process.pid}`, `${JSON.stringify({ rev: 1, fleet: SEATS }, null, 2)}\n`)
  renameSync(`${file}.tmp.${process.pid}`, file)
}
function writeFlowDb(path) {
  mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE nodes(node_id TEXT NOT NULL, verb TEXT, state TEXT NOT NULL, attempts INTEGER DEFAULT 0, events INTEGER DEFAULT 0, deps TEXT)')
  db.exec("INSERT INTO nodes VALUES('n1','rollup','done',0,2,NULL)")
  db.exec("INSERT INTO nodes VALUES('n2','dispatch','dispatched',0,1,NULL)")
  db.exec('CREATE VIEW v_status AS SELECT node_id, verb, state, attempts, events FROM nodes')
  db.exec('CREATE VIEW v_rollup AS SELECT state, COUNT(*) AS n FROM nodes GROUP BY state')
  db.exec('CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT, node_id TEXT, detail TEXT)')
  db.close()
}
async function startMockDsh() {
  const server = createServer((rq, rs) => {
    const chunks = []
    rq.on('data', (d) => chunks.push(d))
    rq.on('end', () => {
      rs.writeHead(200, { 'content-type': 'application/json' })
      rs.end(JSON.stringify({ result: { ok: true, value: { items: [
        { sessionId: 'session-x', running: true, blank: false, agentPreset: 'maestro', cwd: '/tmp/pmw23-gate', projections: { values: { title: 'pmw23-gate-mock' } } },
      ] } } }))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { server, port: server.address().port, close: () => new Promise((r) => server.close(r)) }
}
// stub ledger: ticket list (读状态文件) + ticket state (记录 + 变更状态文件)
// 字段形状照 ledger CLI: ticket_id 主键, deps/refs 为 JSON 字符串 (refs object → keys)
const LEDGER_STUB = (sb) => `#!/bin/bash
SB="${sb}"
if [ "$1 $2" = "ticket list" ]; then
  s1=$(cat "$SB/T-G1.state" 2>/dev/null || echo running)
  s2=$(cat "$SB/T-G2.state" 2>/dev/null || echo dispatched)
  echo "{\\"tickets\\":[{\\"ticket_id\\":\\"T-G1\\",\\"state\\":\\"$s1\\",\\"deps\\":\\"[]\\",\\"refs\\":\\"{\\\\\\"evidence\\\\\\":1,\\\\\\"docs/gates/evidence-path.md\\\\\\":1}\\",\\"lease_owner\\":null},{\\"ticket_id\\":\\"T-G2\\",\\"state\\":\\"$s2\\",\\"deps\\":\\"[\\\\\\"T-G1\\\\\\"]\\",\\"refs\\":\\"{}\\",\\"lease_owner\\":null}]}"
  exit 0
fi
echo "$(date +%s%N) $*" >> "$SB/ledger-calls.log"
if [ "$1 $2" = "ticket state" ]; then
  echo "$4" > "$SB/$3.state"
  printf 'x' >> "$MAESTRO_HOME/maestro/ledger.db" 2>/dev/null || :  # 镜像真实 ledger: 写库 → serveTickets 缓存键漂移 → 下轮 pull 新状态
  echo "ok $3 -> $4"; exit 0
fi
echo "stub-ok"; exit 0
`
const FLOWC_STUB = (sb) => `#!/bin/bash
SB="${sb}"
if [ "$1" = "advance" ]; then echo "$(date +%s%N) $*" >> "$SB/flowc-calls.log"; echo "ok"; exit 0; fi
echo "flowc inspect (stub)"; exit 0
`
async function startSandbox(tag) {
  const sb = `${BASE}/${tag}`
  rmSync(sb, { recursive: true, force: true })
  mkdirSync(`${sb}/maestro/bin`, { recursive: true })
  writeFileSync(`${sb}/maestro/bin/ledger`, LEDGER_STUB(sb), { mode: 0o755 })
  writeFileSync(`${sb}/maestro/bin/flowc`, FLOWC_STUB(sb), { mode: 0o755 })
  writeFileSync(`${sb}/maestro/bin/fleet-list`, '#!/bin/bash\necho "[]"\n', { mode: 0o755 })
  writeFleet(sb)
  writeFlowDb(`${sb}/maestro/flows/gate-live/state.db`)
  const mock = await startMockDsh()
  const env = {
    ...process.env, MAESTRO_HOME: sb,
    PM_HOST_SERVICE_LEDGER: `${sb}/maestro/bin/ledger`,
    PM_HOST_SERVICE_FLOWC: `${sb}/maestro/bin/flowc`,
    PM_HOST_SERVICE_FLEET_LIST: `${sb}/maestro/bin/fleet-list`,
    PM_HOST_SERVICE_TICKETS_MD: `${sb}/maestro/tickets.md`,
    MAESTRO_FLEET: `${sb}/maestro/fleet.json`,
    MAESTRO_FLOWS_ROOT: `${sb}/maestro/flows`,
    DSH_SESSIONS_ROOT: `${sb}/sessions`,
    DSH_PORT: String(mock.port),
  }
  const child = spawn(process.execPath, [`${REPO}service.mjs`], { env, stdio: 'ignore' })
  let port = 0
  for (let i = 0; i < 100 && !port; i++) {
    await sleep(100)
    try { const p = JSON.parse(readFileSync(`${sb}/maestro/pm.port`, 'utf8')); if (p.pid === child.pid) port = p.port } catch {}
  }
  if (!port) throw new Error(`sandbox ${tag} never published pm.port`)
  return { sb, port, child, mock, stop: async () => { child.kill('SIGTERM'); await mock.close(); await sleep(200) } }
}

// ---------- CDP 驱动 (零 npm) ----------
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
  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(file, Buffer.from(r.data, 'base64'))
    return file
  }
  close() { try { this.ws.close() } catch {} }
}
async function newChrome(BASE_, tag, extraArgs = []) {
  const dir = `${BASE_}/chrome-${tag}`
  mkdirSync(dir, { recursive: true })
  const proc = spawn(CHROME, ['--headless=new', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', '--window-size=1600,1000', ...extraArgs, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
  let wsUrl = null
  proc.stderr.on('data', (d) => { const m = /DevTools listening on (ws:\/\/\S+)/.exec(String(d)); if (m) wsUrl = m[1] })
  for (let i = 0; i < 100 && !wsUrl; i++) await sleep(100)
  if (!wsUrl) throw new Error(`chrome ${tag} no devtools ws`)
  const debugPort = /127\.0\.0\.1:(\d+)\//.exec(wsUrl)[1]
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page')
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.open()
  return { proc, cdp }
}
const killChrome = async (c) => { c?.cdp?.close(); if (c?.proc) { c.proc.kill('SIGKILL'); await sleep(150) } }
async function openCanvas(c, port, errors, tag) {
  c.cdp.on((m) => { if (m.method === 'Runtime.exceptionThrown') errors.push(tag + ':' + JSON.stringify(m.params?.exceptionDetails ?? {}).slice(0, 140)) })
  await c.cdp.send('Page.enable')
  await c.cdp.send('Runtime.enable')
  await c.cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/` })
  let ready = false
  for (let i = 0; i < 100 && !ready; i++) { await sleep(300); try { ready = await c.cdp.eval('window.__pmCanvas && window.__pmCanvas.ready === true') } catch {} }
  await c.cdp.eval(`document.querySelector('[data-view="canvas"]').click()`)
  let mode = ''
  for (let i = 0; i < 40 && mode !== 'canvas'; i++) { await sleep(250); mode = await c.cdp.eval('window.__pmCanvas ? window.__pmCanvas.mode : ""') }
  return { ready, mode }
}
const clickNode = (id) => `(() => {
  const node = document.querySelector('.cv-node[data-id="${id}"]')
  if (!node) return false
  const r = node.getBoundingClientRect()
  const o = { bubbles: true, cancelable: true, pointerId: 5, buttons: 1, clientX: r.left + 2, clientY: r.top + 2 }
  node.dispatchEvent(new PointerEvent('pointerdown', o))
  node.dispatchEvent(new PointerEvent('pointerup', o))
  return true
})()`
const drawerState = `(() => {
  const d = document.querySelector('#cv-drawer')
  return {
    open: !!d && !d.hidden,
    node: window.__pmCanvas ? window.__pmCanvas.drawer : null,
    kind: (document.querySelector('#cv-drawer-kind') || {}).textContent || '',
    title: (document.querySelector('#cv-drawer-title') || {}).textContent || '',
    body: (document.querySelector('#cv-drawer-body') || {}).textContent || '',
    acts: [...document.querySelectorAll('#cv-drawer-body [data-act]')].map((b) => b.dataset.act),
    refs: document.querySelectorAll('#cv-drawer-body .cv-ref').length,
    hist: [...document.querySelectorAll('#cv-drawer-hist li')].map((li) => li.textContent),
  }
})()`
const dialogState = `(() => {
  const dlg = document.querySelector('#cv-act-confirm')
  return {
    open: dlg.hasAttribute('open'),
    cmd: (document.querySelector('#cv-act-cmd') || {}).textContent || '',
    target: (document.querySelector('#cv-act-target') || {}).textContent || '',
    irrevShown: !document.querySelector('#cv-act-irrev').hidden,
    okDisabled: document.querySelector('#cv-act-ok').disabled,
  }
})()`
const dlgAct = (what) => `document.querySelector('#cv-act-${what}').click()`

// ---------- B. live 抽屉 (只读, 零 act) ----------
async function liveDrawerPart(livePort) {
  const shot = (f) => `${BASE}/${f}`
  const errors = []
  const g = await (await fetch(`http://127.0.0.1:${livePort}/op/graph`)).json()
  const pick = (t) => g.nodes.find((n) => n.type === t)
  const c = await newChrome(BASE, 'live-drawer')
  const { ready, mode } = await openCanvas(c, livePort, errors, 'live')
  ok('B live: 页面就绪 + 画布模式', ready && mode === 'canvas', `ready=${ready} mode=${mode}`)
  const cases = [
    ['flow-node', ['verb / 形制', '快捷动作', '所属 flow'], ['flow:done', 'flow:failed'], 'drawer-live-flow-node.png'],
    ['ticket', ['refs 证据链', '合法转移'], null, 'drawer-live-ticket.png'],
    ['seat', ['会话态 join', '无快捷动作'], null, 'drawer-live-seat.png'],
    ['session', ['挂靠席位', '无快捷动作'], null, 'drawer-live-session.png'],
  ]
  for (const [type, texts, acts, file] of cases) {
    const n = pick(type)
    if (!n) { ok(`B 抽屉[${type}]: live 图中存在该型节点`, false, 'missing'); continue }
    await c.cdp.eval(clickNode(n.id))
    await sleep(250)
    const d = await c.cdp.eval(drawerState)
    ok(`B 抽屉[${type}]: 点节点开抽屉且型别正确`, d.open && d.node === n.id && d.kind === type, `${d.kind}=${d.title}`)
    ok(`B 抽屉[${type}]: 型别字段在场`, texts.every((t) => d.body.includes(t)), texts.map((t) => `${t}=${d.body.includes(t)}`).join(','))
    if (acts) ok(`B 抽屉[${type}]: 两类快捷动作按钮`, acts.every((a) => d.acts.includes(a)), d.acts.join(','))
    if (type === 'ticket') {
      const legal = { dispatched: ['ticket:running', 'ticket:rejected'], running: ['ticket:blocked', 'ticket:done', 'ticket:rejected'], blocked: ['ticket:running', 'ticket:done', 'ticket:rejected'], done: ['ticket:running', 'ticket:merged', 'ticket:rejected'], merged: ['ticket:rolled-back'], rejected: [], 'rolled-back': [] }[n.state] ?? null
      ok('B 抽屉[ticket]: 迁移按钮 = 合法迁移表', legal != null && legal.length === d.acts.length && legal.every((a) => d.acts.includes(a)), `state=${n.state} acts=[${d.acts}]`)
    }
    await sleep(150)
    await c.cdp.shot(shot(file))
    ok(`B 证据: ${file}`, statSync(shot(file)).size > 10000)
    await c.cdp.eval(`document.querySelector('#cv-drawer-close').click()`)
    const closed = await c.cdp.eval(drawerState)
    ok(`B 抽屉[${type}]: 关闭钮收起`, !closed.open && closed.node === null)
  }
  // 取消路径: 节点再点一次 = 取消选中并关抽屉; 空白点击同效
  const tkn = pick('ticket')
  await c.cdp.eval(clickNode(tkn.id)); await sleep(150)
  await c.cdp.eval(clickNode(tkn.id)); await sleep(150)
  const toggled = await c.cdp.eval(drawerState)
  ok('B 取消路径: 同节点再点关抽屉', !toggled.open)
  await c.cdp.eval(clickNode(tkn.id)); await sleep(150)
  const blank = await c.cdp.eval(`(() => {
    const svg = document.querySelector('#canvas-svg')
    const r = svg.getBoundingClientRect()
    const o = { bubbles: true, cancelable: true, pointerId: 6, buttons: 1, clientX: r.left + 5, clientY: r.top + 5 }
    svg.dispatchEvent(new PointerEvent('pointerdown', o))
    svg.dispatchEvent(new PointerEvent('pointerup', o))
    return true
  })()`)
  const afterBlank = await c.cdp.eval(drawerState)
  ok('B 取消路径: 空白点击关抽屉', blank && !afterBlank.open)
  const intro = await c.cdp.eval('({ drawer: window.__pmCanvas.drawer, actHist: window.__pmCanvas.actHist, pendingActs: window.__pmCanvas.pendingActs, nodes: window.__pmCanvas.nodes })')
  ok('B 内省: __pmCanvas 新键在场且 PMW2-2 键不回退', 'drawer' in intro && 'actHist' in intro && 'pendingActs' in intro && intro.nodes >= 150, JSON.stringify(intro))
  ok('B live 段页面零异常', errors.length === 0, errors.slice(0, 2).join(' | '))
  await killChrome(c)
}

// ---------- C. sandbox act 过门 (stub, 零 live 变更) ----------
async function sandboxActPart() {
  const shot = (f) => `${BASE}/${f}`
  const errors = []
  const box = await startSandbox('act')
  try {
    const g = await (await fetch(`http://127.0.0.1:${box.port}/op/graph`)).json()
    const has = (pred) => g.nodes.some(pred)
    ok('C sandbox 图: 四型节点齐(fn/tk/st/se)', has((n) => n.type === 'flow-node') && has((n) => n.type === 'ticket') && has((n) => n.type === 'seat') && has((n) => n.type === 'session'), g.nodes.map((n) => n.type).join(','))

    const c = await newChrome(BASE, 'sandbox-act')
    const { ready, mode } = await openCanvas(c, box.port, errors, 'act')
    ok('C sandbox: 画布模式', ready && mode === 'canvas', `ready=${ready} mode=${mode}`)
    const calls = () => { try { return readFileSync(`${box.sb}/ledger-calls.log`, 'utf8').trim().split('\n').filter(Boolean) } catch { return [] } }
    const waitHist = async (want, ms = 12000) => {
      for (let i = 0; i < ms / 250; i++) {
        await sleep(250)
        const h = await c.cdp.eval(drawerState)
        if (h.hist.length && h.hist.some((x) => x.includes(want))) return h
      }
      return await c.cdp.eval(drawerState)
    }

    // C1 合法转移成功: running T-G1 → done (单确认)
    await c.cdp.eval(clickNode('tk:T-G1')); await sleep(250)
    let d = await c.cdp.eval(drawerState)
    ok('C1 抽屉: T-G1(running) 迁移按钮=合法表', d.acts.join(',') === 'ticket:blocked,ticket:done,ticket:rejected', d.acts.join(','))
    ok('C1 抽屉: path 形 refs 为可点证据 chip', d.refs >= 1, `refs=${d.refs}`)
    await c.cdp.eval(`document.querySelector('[data-act="ticket:done"]').click()`)
    let dlg = await c.cdp.eval(dialogState)
    ok('C1 确认门: 动作全文 + 影响节点', dlg.open && dlg.cmd === 'ledger ticket state T-G1 done' && dlg.target.includes('tk:T-G1'), `${dlg.cmd} @ ${dlg.target}`)
    ok('C1 确认门: 可逆转移无 checkbox', !dlg.irrevShown && !dlg.okDisabled)
    await c.cdp.shot(shot('act-confirm-ticket-done.png'))
    await c.cdp.eval(dlgAct('ok'))
    d = await waitHist('flying') // 提交后至少出现回执行
    ok('C1 回执: 历史入 ref+动作', d.hist.length >= 1 && /vh-[0-9a-f]{8}/.test(d.hist.join('')) && d.hist.join('').includes('ledger ticket state T-G1 done'), d.hist.join(' | ').slice(0, 160))
    d = await waitHist('ok', 15000)
    ok('C1 settle: 轮询对账 → ok (exit 0)', /ok/.test(d.hist.join('')), d.hist.join(' | ').slice(0, 200))
    ok('C1 stub: ledger 收到精确 argv', calls().some((l) => l.includes('ticket state T-G1 done')), calls().join(' | ').slice(-160))
    await sleep(3600) // SSE 在: 3s 未见到数据面事件 → act 响应直刷兜底
    d = await c.cdp.eval(drawerState)
    ok('C1 直刷: 图上状态即时回显 done + 迁移按钮随新状态重算', d.body.includes('statedone') && d.acts.join(',') === 'ticket:running,ticket:merged,ticket:rejected', `acts=[${d.acts}] body=${d.body.slice(0, 60).replace(/\n/g, ' ')}`)
    await c.cdp.shot(shot('act-settled-ticket-done.png'))

    // C2 不可逆双确认: done → rejected (IRREV)
    await c.cdp.eval(`document.querySelector('[data-act="ticket:rejected"]').click()`)
    dlg = await c.cdp.eval(dialogState)
    ok('C2 双确认: 不可逆提示 + 确认钮禁用', dlg.open && dlg.irrevShown && dlg.okDisabled && dlg.cmd === 'ledger ticket state T-G1 rejected', JSON.stringify(dlg))
    await c.cdp.shot(shot('act-confirm-irrev-rejected.png'))
    await c.cdp.eval(dlgAct('ok')); await sleep(200)
    const stillOpen = await c.cdp.eval(dialogState)
    ok('C2 双确认: 未勾选时确认无效(弹层仍开)', stillOpen.open)
    await c.cdp.eval(`document.querySelector('#cv-act-irrev-chk').click()`)
    const enabled = await c.cdp.eval(dialogState)
    ok('C2 双确认: 勾选后确认钮可用', !enabled.okDisabled)
    const callsBefore = calls().length
    await c.cdp.eval(dlgAct('ok'))
    d = await waitHist('rejected', 15000)
    const rejectedSettled = /rejected/.test(d.hist.join('')) && d.hist.filter((x) => x.includes('T-G1 rejected')).length >= 1
    ok('C2 双确认: 勾选后提交 → settle', rejectedSettled, d.hist.join(' | ').slice(-160))
    ok('C2 stub: 恰好一次新调用', calls().length === callsBefore + 1, `${callsBefore} -> ${calls().length}`)

    // C3 取消路径: 开弹层 → 取消 → 零调用零历史
    await c.cdp.eval(clickNode('tk:T-G2')); await sleep(250)
    await c.cdp.eval(`document.querySelector('[data-act="ticket:running"]').click()`)
    dlg = await c.cdp.eval(dialogState)
    ok('C3 取消: 弹层开(T-G2 dispatched→running)', dlg.open && dlg.cmd === 'ledger ticket state T-G2 running', dlg.cmd)
    const c3Before = calls().length
    await c.cdp.eval(dlgAct('cancel')); await sleep(200)
    dlg = await c.cdp.eval(dialogState)
    d = await c.cdp.eval(drawerState)
    ok('C3 取消: 弹层关 + 零新调用 + 零新历史', !dlg.open && calls().length === c3Before && !d.hist.some((x) => x.includes('T-G2')), `calls=${calls().length} hist=${d.hist.length}`)
    await c.cdp.shot(shot('act-after-cancel.png'))

    // C4 flow-node --result: fn n2 failed (单确认)
    await c.cdp.eval(clickNode('fn:gate-live/n2')); await sleep(250)
    d = await c.cdp.eval(drawerState)
    ok('C4 抽屉: fn 明细 + 两类按钮', d.kind === 'flow-node' && d.acts.join(',') === 'flow:done,flow:failed' && d.body.includes('所属 flow') && d.body.includes('gate-live'), d.acts.join(','))
    await c.cdp.eval(`document.querySelector('[data-act="flow:failed"]').click()`)
    dlg = await c.cdp.eval(dialogState)
    ok('C4 确认门: flowc advance 全文', dlg.open && dlg.cmd === 'flowc advance gate-live n2 --result failed', dlg.cmd)
    await c.cdp.shot(shot('act-flow-advance.png'))
    await c.cdp.eval(dlgAct('ok'))
    d = await waitHist('failed', 15000)
    const flowOk = /flowc advance gate-live n2 --result failed/.test(d.hist.join('')) && /ok/.test(d.hist.join(''))
    ok('C4 settle: flow act 闭环 ok', flowOk, d.hist.join(' | ').slice(-160))
    const flowCalls = (() => { try { return readFileSync(`${box.sb}/flowc-calls.log`, 'utf8') } catch { return '' } })()
    ok('C4 stub: flowc 收到精确 argv', flowCalls.includes('advance gate-live n2 --result failed'), flowCalls.trim().slice(-120))
    ok('C sandbox 段页面零异常', errors.length === 0, errors.slice(0, 2).join(' | '))
    await killChrome(c)

    // C5 断 SSE → act 响应直刷闭环 (Fetch 拦截 *subscribe*)
    {
      const errors2 = []
      const c2 = await newChrome(BASE, 'sandbox-nosse')
      await c2.cdp.send('Page.enable')
      await c2.cdp.send('Runtime.enable')
      await c2.cdp.send('Network.enable')
      await c2.cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*subscribe*', interceptionStage: 'Request' }] })
      c2.cdp.on((m) => { if (m.method === 'Fetch.requestPaused') c2.cdp.send('Fetch.failRequest', { requestId: m.params.requestId, errorReason: 'Aborted' }).catch(() => {}) })
      const graphHits = []
      c2.cdp.on((m) => { if (m.method === 'Network.requestWillBeSent' && String(m.params?.request?.url).includes('/op/graph')) graphHits.push(Date.now()) })
      await c2.cdp.send('Page.navigate', { url: `http://127.0.0.1:${box.port}/` })
      let ready = false
      for (let i = 0; i < 100 && !ready; i++) { await sleep(300); try { ready = await c2.cdp.eval('window.__pmCanvas && window.__pmCanvas.ready === true') } catch {} }
      await c2.cdp.eval(`document.querySelector('[data-view="canvas"]').click()`)
      let sse = null
      for (let i = 0; i < 20; i++) { await sleep(300); sse = await c2.cdp.eval('window.__pmCanvas.sseOpen'); if (sse === false) break }
      ok('C5 断 SSE: sseOpen=false (轮询态)', ready && sse === false, `sseOpen=${sse}`)
      await c2.cdp.eval(clickNode('tk:T-G2')); await sleep(300)
      await c2.cdp.eval(`document.querySelector('[data-act="ticket:running"]').click()`)
      await c2.cdp.eval(dlgAct('ok'))
      const hitsBefore = graphHits.length
      let dd = null
      for (let i = 0; i < 40; i++) {
        await sleep(250)
        dd = await c2.cdp.eval(drawerState)
        if (dd.body.includes('running') && dd.hist.some((x) => /ok/.test(x))) break
      }
      ok('C5 无SSE闭环: settle ok + 响应直刷(running 回显)', dd && dd.hist.some((x) => /ok/.test(x)) && dd.body.includes('staterunning'), (dd?.hist ?? []).join(' | ').slice(-140))
      ok('C5 无SSE闭环: /op/graph 直刷请求可见', graphHits.length >= hitsBefore + 1, `hits=${graphHits.length} before=${hitsBefore}`)
      await c2.cdp.shot(shot('act-nosse-direct.png'))
      ok('C5 无SSE段页面零异常', errors2.length === 0, errors2.slice(0, 2).join(' | '))
      await killChrome(c2)
    }
  } finally {
    await box.stop()
  }
}

// ---------- 部署 + 运行 ----------
mkdirSync(BASE, { recursive: true })
const startedAt = new Date().toISOString()
const PORT_FILE = `${homedir()}/.dsh/maestro/pm.port`
const SVC = 'pm-host-service'
const oldPort = JSON.parse(readFileSync(PORT_FILE, 'utf8')).port
spawnSync('systemctl', ['--user', 'try-restart', SVC])
let livePort = 0
for (let i = 0; i < 80; i++) {
  await sleep(250)
  try { const p = JSON.parse(readFileSync(PORT_FILE, 'utf8')); if (p.port !== oldPort) { livePort = p.port; break } } catch {}
}
ok('部署: try-restart 后端口漂移(静态面新快照)', livePort > 0, `old=${oldPort} new=${livePort}`)
const health = await (await fetch(`http://127.0.0.1:${livePort}/health`)).json()
ok('部署: /health 200 且服务版本可见', !!health?.version, `v${health?.version}`)

await liveDrawerPart(livePort)
await sandboxActPart()

writeFileSync(`${BASE}/manifest.json`, `${JSON.stringify({ label: LABEL, gate: 'pmw2-3-drawer', startedAt, finishedAt: new Date().toISOString(), pass, fail, node: process.version, repo: REPO }, null, 2)}\n`)
console.log(`\n=== ${LABEL}: PASS=${pass} FAIL=${fail} (evidence: ${BASE}) ===`)
process.exit(fail === 0 ? 0 : 1)
