#!/usr/bin/env node
// pmw2-2-canvas-gate.mjs — PMW2-2 画布 tab MVP gate (spec spec-pm-web-canvas §3/§4/§5).
//
// A. vendor/静态门 (零浏览器):
//    §3 elkjs 0.12.0 逐字节: public/elk.bundled.js sha256 + 字节数钉死
//    (1222e44f…a307b3 / 1,609,707 — 改一字即例外失效); LICENSE.elkjs.md 在场;
//    elk.mjs 薄包装逐字; package.json 零依赖字段 (例外不进 package.json)。
//    沙箱 daemon (env 覆盖, pm001-007-gate 惯例): GET / 含画布 tab + 三 tab
//    零回归; /elk.bundled.js 出自静态面且 sha256=repo 字节; /elk.mjs /canvas.js 200。
// B. 浏览器门 (CDP over node 内建 WebSocket, 零 npm; 部署=try-restart 本 checkout):
//    §4 真数据渲染: 全 flow 总览截图 / 缩放平移态截图 / 单 flow 泳道截图;
//    hover/点击高亮关联边 + 空白点击取消;
//    §5 降级: 断 SSE (Fetch 域拦截 /subscribe) → 30s 轮询仍拉 /op/graph;
//    断 elk (拦截 /elk.bundled.js) → 列表回退不白屏 + 横幅注明。
// 页面异常 (Runtime.exceptionThrown) 任何一例即 FAIL。
// 留存 (HF-013 ②): 截图/日志落 $PM_HOST_SERVICE_GATES_DIR/pmw2-2/<label>/。
// Usage: node pmw2-2-canvas-gate.mjs <label> [chrome-bin]
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'

const LABEL = process.argv[2] ?? `manual-${process.pid}`
const CHROME = process.argv[3] ?? process.env.CHROME_BIN ?? 'google-chrome'
const GATES_ROOT = process.env.PM_HOST_SERVICE_GATES_DIR ?? `${homedir()}/.dsh/maestro/logs/pm-host-service/gates`
const BASE = `${GATES_ROOT}/pmw2-2/${LABEL}`
const PUBLIC = new URL('../public/', import.meta.url).pathname
const REPO = new URL('..', import.meta.url).pathname
const SPEC_SHA = '1222e44f953ce7746af23801e723708f8e6f436b8b377a6a5fc7552f34a307b3'
const SPEC_BYTES = 1_609_707

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}${detail ? `  :: ${detail}` : ''}`) } else { fail++; console.log(`FAIL ${name}${detail ? `  :: ${detail}` : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

// ---------- A. vendor / 静态面 ----------
{
  const buf = readFileSync(`${PUBLIC}elk.bundled.js`)
  ok('§3 elk.bundled.js sha256 = spec 钉死值', sha256(buf) === SPEC_SHA, sha256(buf).slice(0, 16) + '…')
  ok('§3 elk.bundled.js 字节数 = 1,609,707', buf.length === SPEC_BYTES, String(buf.length))
  const lic = `${PUBLIC}LICENSE.elkjs.md`
  ok('§3 LICENSE.elkjs.md 在场且为 EPL-2.0 原文', (() => { try { return /Eclipse Public License/.test(readFileSync(lic, 'utf8').slice(0, 200)) } catch { return false } })())
  const wrapper = (() => { try { return readFileSync(`${PUBLIC}elk.js`, 'utf8') } catch { return '' } })()
  ok('§3 elk.js 薄包装(不触全局, re-export globalThis.ELK)', /import '\.\/elk\.bundled\.js'/.test(wrapper) && /export const ELK = globalThis\.ELK/.test(wrapper))
  const pkg = JSON.parse(readFileSync(`${REPO}package.json`, 'utf8'))
  ok('宪章: package.json 无依赖字段(例外不写入)', !pkg.dependencies && !pkg.devDependencies && !pkg.optionalDependencies)
  const html = readFileSync(`${PUBLIC}index.html`, 'utf8')
  ok('index.html: 第四 tab「画布」+ view-canvas + canvas.js(既有三 tab 零回归)', html.includes('data-view="canvas"') && html.includes('id="view-canvas"') && html.includes('canvas.js') && ['data-view="tickets"', 'data-view="fleet"', 'data-view="flow"'].every((s) => html.includes(s)))
  const appjs = readFileSync(`${PUBLIC}app.js`, 'utf8')
  ok('app.js 三 tab 语义未动(仅 SSE 派发两事件)', appjs.includes("new CustomEvent('pm:sse'") && appjs.includes("new CustomEvent('pm:sse-state'") && appjs.includes("refetch.tickets()") && appjs.includes('refetch.flow()'))
}

// ---------- 沙箱 daemon: 静态面出 vendored 文件 ----------
async function sandboxPart() {
  const sb = `${BASE}/sb`
  rmSync(sb, { recursive: true, force: true })
  mkdirSync(`${sb}/maestro/bin`, { recursive: true })
  const env = {
    ...process.env, MAESTRO_HOME: sb,
    PM_HOST_SERVICE_LEDGER: `${sb}/maestro/bin/ledger`,
    PM_HOST_SERVICE_FLOWC: `${sb}/maestro/bin/flowc`,
    PM_HOST_SERVICE_FLEET_LIST: `${sb}/maestro/bin/fleet-list`,
    PM_HOST_SERVICE_TICKETS_MD: `${sb}/maestro/tickets.md`,
    MAESTRO_FLEET: `${sb}/maestro/fleet.json`,
    MAESTRO_FLOWS_ROOT: `${sb}/maestro/flows`,
    DSH_SESSIONS_ROOT: `${sb}/sessions`,
  }
  const child = spawn(process.execPath, [`${REPO}service.mjs`], { env, stdio: 'ignore' })
  let port = 0
  for (let i = 0; i < 100 && !port; i++) {
    await sleep(100)
    try { const p = JSON.parse(readFileSync(`${sb}/maestro/pm.port`, 'utf8')); if (p.pid === child.pid) port = p.port } catch {}
  }
  try {
    const get = async (p) => { const r = await fetch(`http://127.0.0.1:${port}${p}`); return { status: r.status, buf: Buffer.from(await r.arrayBuffer()) } }
    const elk = await get('/elk.bundled.js')
    ok('静态面: /elk.bundled.js 200 且 sha256=repo 字节', elk.status === 200 && sha256(elk.buf) === sha256(readFileSync(`${PUBLIC}elk.bundled.js`)))
    const elkjsWrap = await fetch(`http://127.0.0.1:${port}/elk.js`)
    ok('静态面: /elk.js 200 且 JS MIME(模块脚本硬要求)', elkjsWrap.status === 200 && /javascript/.test(elkjsWrap.headers.get('content-type') ?? ''), elkjsWrap.headers.get('content-type'))
    ok('静态面: /canvas.js 200', (await get('/canvas.js')).status === 200)
    const home = await get('/')
    ok('静态面: GET / 含画布 tab', home.status === 200 && home.buf.toString('utf8').includes('data-view="canvas"'))
  } finally {
    child.kill('SIGTERM')
    await sleep(200)
  }
}

// ---------- CDP 驱动 (node 内建 WebSocket, 零 npm) ----------
async function newChrome(extraArgs = [], tag) {
  const dir = `${BASE}/chrome-${tag}`
  mkdirSync(dir, { recursive: true })
  const proc = spawn(CHROME, ['--headless=new', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', '--window-size=1600,1000', ...extraArgs, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
  let wsUrl = null
  const stderr = []
  proc.stderr.on('data', (d) => { stderr.push(String(d)); const m = /DevTools listening on (ws:\/\/\S+)/.exec(String(d)); if (m) wsUrl = m[1] })
  for (let i = 0; i < 100 && !wsUrl; i++) await sleep(100)
  if (!wsUrl) throw new Error(`chrome ${tag} never published devtools ws: ${stderr.join('').slice(0, 300)}`)
  const debugPort = /127\.0\.0\.1:(\d+)\//.exec(wsUrl)[1]
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page')
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.open()
  return { proc, cdp }
}

class Cdp {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.handlers = [] }
  open() {
    this.ws = new WebSocket(this.url)
    return new Promise((res, rej) => {
      this.ws.onopen = res
      this.ws.onerror = (e) => rej(new Error('ws error'))
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
const killChrome = async (c) => { c?.cdp?.close(); if (c?.proc) { c.proc.kill('SIGKILL'); await sleep(150) } }

// ---------- B. 浏览器门 ----------
async function browserPart(livePort) {
  const shot = (f) => `${BASE}/${f}`
  const pageErrors = []

  // B1: 健康渲染 + 交互
  {
    const c = await newChrome([], 'render')
    c.cdp.on((m) => { if (m.method === 'Runtime.exceptionThrown') pageErrors.push(JSON.stringify(m.params?.exceptionDetails ?? {}).slice(0, 160)) })
    await c.cdp.send('Page.enable')
    await c.cdp.send('Runtime.enable')
    await c.cdp.send('Page.navigate', { url: `http://127.0.0.1:${livePort}/` })
    let ready = false
    for (let i = 0; i < 100 && !ready; i++) { await sleep(300); try { ready = await c.cdp.eval('window.__pmCanvas && window.__pmCanvas.ready === true') } catch {} }
    ok('§4 页面就绪(__pmCanvas.ready)', ready)
    await c.cdp.eval(`document.querySelector('[data-view="canvas"]').click()`)
    let mode = ''
    for (let i = 0; i < 40 && mode !== 'canvas'; i++) { await sleep(250); mode = await c.cdp.eval('window.__pmCanvas ? window.__pmCanvas.mode : ""') }
    ok('§4 画布模式(SVG 渲染, 非列表回退)', mode === 'canvas', `mode=${mode}`)
    const info = await c.cdp.eval('({nodes: window.__pmCanvas.nodes, edges: window.__pmCanvas.edges, lanes: window.__pmCanvas.lanes, laneIds: window.__pmCanvas.laneIds})')
    ok('§4 真数据全量渲染(节点/泳道数)', info.nodes >= 150 && info.lanes >= 5, JSON.stringify({ nodes: info.nodes, edges: info.edges, lanes: info.lanes }))
    ok('§1.3 泳道按 flow 切(含 tickets/fleet 尾部泳道)', Array.isArray(info.laneIds) && info.laneIds.includes('tickets') && info.laneIds.includes('fleet') && info.laneIds.filter((l) => String(l).startsWith('flow:')).length >= 3, `lanes=${(info.laneIds || []).length}`)
    await sleep(600) // 取景稳定
    await c.cdp.shot(shot('canvas-overview.png'))
    ok('§4 证据: 全 flow 总览截图', statSync(shot('canvas-overview.png')).size > 10000)

    // 缩放(指针锚)+平移
    const v0 = await c.cdp.eval('window.__pmCanvas.view')
    await c.cdp.eval(`(() => {
      const svg = document.querySelector('#canvas-svg')
      const r = svg.getBoundingClientRect()
      for (const dy of [-240, -240, -240]) svg.dispatchEvent(new WheelEvent('wheel', { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, deltaY: dy, bubbles: true, cancelable: true }))
      const opts = { bubbles: true, cancelable: true, pointerId: 7, buttons: 1, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }
      svg.dispatchEvent(new PointerEvent('pointerdown', opts))
      svg.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: r.left + r.width / 2 + 180, clientY: r.top + r.height / 2 + 120 }))
      svg.dispatchEvent(new PointerEvent('pointerup', { ...opts, clientX: r.left + r.width / 2 + 180, clientY: r.top + r.height / 2 + 120 }))
      return true
    })()`)
    await sleep(300)
    const v1 = await c.cdp.eval('window.__pmCanvas.view')
    ok('§4 wheel 缩放(0.5×–2× clamp)+拖拽平移生效', v1.s > v0.s && v1.s <= 2 && (v1.x !== v0.x || v1.y !== v0.y), `${JSON.stringify(v0)} -> ${JSON.stringify(v1)}`)
    await c.cdp.shot(shot('canvas-zoom-pan.png'))
    ok('§4 证据: 缩放平移态截图', statSync(shot('canvas-zoom-pan.png')).size > 10000)

    // 单 flow 泳道取景: 从 laneBounds 反推 wheel/pan 序列把该泳道框入视口
    const framed = await c.cdp.eval(`(() => {
      const lb = window.__pmCanvas.laneBounds['flow:pm-p0'] || Object.entries(window.__pmCanvas.laneBounds).find(([k]) => String(k).startsWith('flow:'))?.[1]
      if (!lb) return null
      const svg = document.querySelector('#canvas-svg')
      const r = svg.getBoundingClientRect()
      const sTarget = 1.4
      let vx = 0, vy = 0, vs = 1
      // 逐段 wheel 到 sTarget (每次 1.25x, 指针锚在视口中心)
      for (let i = 0; i < 12 && vs < sTarget - 1e-6; i++) {
        const ev = new WheelEvent('wheel', { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, deltaY: -240, bubbles: true, cancelable: true })
        svg.dispatchEvent(ev)
        const nv = window.__pmCanvas.view; if (nv.s <= vs + 1e-9) break; vs = nv.s; vx = nv.x; vy = nv.y
      }
      // 平移: 使泳道中心对齐视口中心 (world 中心 * s + view = 视口中心)
      const cx = (lb.x + lb.w / 2) * window.__pmCanvas.view.s, cy = (lb.y + lb.h / 2) * window.__pmCanvas.view.s
      const tx = r.width / 2 - cx, ty = r.height / 2 - cy
      const o = { bubbles: true, cancelable: true, pointerId: 9, buttons: 1, clientX: r.left + 30, clientY: r.top + 30 }
      svg.dispatchEvent(new PointerEvent('pointerdown', o))
      svg.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: r.left + 30 + (tx - window.__pmCanvas.view.x), clientY: r.top + 30 + (ty - window.__pmCanvas.view.y) }))
      svg.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: r.left + 30 + (tx - window.__pmCanvas.view.x), clientY: r.top + 30 + (ty - window.__pmCanvas.view.y) }))
      return window.__pmCanvas.view
    })()`)
    ok('§4 单 flow 泳道取景计算', !!framed, JSON.stringify(framed))
    await sleep(400)
    await c.cdp.shot(shot('canvas-single-lane.png'))
    ok('§4 证据: 单 flow 泳道截图', statSync(shot('canvas-single-lane.png')).size > 10000)

    // hover/点击高亮 + 空白取消
    const hl = await c.cdp.eval(`(() => {
      const svg = document.querySelector('#canvas-svg')
      const node = svg.querySelector('.cv-node')
      if (!node) return { dimHover: -1, dimClick: -1, lit: -1 }
      const r = node.getBoundingClientRect()
      node.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: r.left, clientY: r.top }))
      const dimHover = svg.querySelectorAll('.cv-dim').length
      node.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, clientX: r.left, clientY: r.top }))
      const o = { bubbles: true, cancelable: true, pointerId: 5, buttons: 1, clientX: r.left + 2, clientY: r.top + 2 }
      node.dispatchEvent(new PointerEvent('pointerdown', o))
      node.dispatchEvent(new PointerEvent('pointerup', o))
      const dimClick = svg.querySelectorAll('.cv-dim').length
      const lit = svg.querySelectorAll('.cv-lit').length
      return { dimHover, dimClick, lit }
    })()`)
    ok('§4 hover 高亮关联(其余淡出)', hl.dimHover > 0, JSON.stringify(hl))
    ok('§4 点击钉住选中(邻边 cv-lit)', hl.dimClick > 0 && hl.lit > 0, JSON.stringify(hl))
    const cleared = await c.cdp.eval(`(() => {
      const svg = document.querySelector('#canvas-svg')
      const r = svg.getBoundingClientRect()
      const o = { bubbles: true, cancelable: true, pointerId: 6, buttons: 1, clientX: r.left + 5, clientY: r.top + 5 }
      svg.dispatchEvent(new PointerEvent('pointerdown', o))
      svg.dispatchEvent(new PointerEvent('pointerup', o))
      return svg.querySelectorAll('.cv-dim').length
    })()`)
    ok('§4 空白点击取消选中', cleared === 0, `dim=${cleared}`)
    ok('§4 页面零异常(健康渲染段)', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '))
    await killChrome(c)
  }

  // B2: §5 断 SSE → 30s 轮询仍刷
  {
    const c = await newChrome(['--host-resolver-rules=EXPIRE 1'], 'sse-broken')
    c.cdp.on((m) => { if (m.method === 'Runtime.exceptionThrown') pageErrors.push('sse:' + JSON.stringify(m.params?.exceptionDetails ?? {}).slice(0, 120)) })
    await c.cdp.send('Page.enable')
    await c.cdp.send('Runtime.enable')
    await c.cdp.send('Network.enable')
    await c.cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*subscribe*', interceptionStage: 'Request' }] })
    c.cdp.on((m) => {
      if (m.method === 'Fetch.requestPaused') c.cdp.send('Fetch.failRequest', { requestId: m.params.requestId, errorReason: 'Aborted' }).catch(() => {})
    })
    const graphHits = []
    c.cdp.on((m) => { if (m.method === 'Network.requestWillBeSent' && String(m.params?.request?.url).includes('/op/graph')) graphHits.push(Date.now()) })
    await c.cdp.send('Page.navigate', { url: `http://127.0.0.1:${livePort}/` })
    let ready = false
    for (let i = 0; i < 100 && !ready; i++) { await sleep(300); try { ready = await c.cdp.eval('window.__pmCanvas && window.__pmCanvas.ready') } catch {} }
    const initialHits = graphHits.length
    await c.cdp.eval(`document.querySelector('[data-view="canvas"]').click()`)
    ok('§5 断 SSE: 页面/画布仍就绪', ready)
    // EventSource 原生重连周期 ~3s; 轮询窗 30s: 等 36s 断言 /op/graph 仍有新请求
    await sleep(36_000)
    ok('§5 断 SSE: 30s 轮询仍拉 /op/graph', graphHits.length >= initialHits + 1, `hits=${graphHits.length} initial=${initialHits}`)
    const banner = await c.cdp.eval('document.querySelector("#cv-banner") && !document.querySelector("#cv-banner").hidden ? document.querySelector("#cv-banner").textContent : ""')
    ok('§5 断 SSE: 画布横幅注明轮询态', /30s 轮询|SSE 断连/.test(banner), banner.slice(0, 60))
    ok('§5 断 SSE 段页面零异常', !pageErrors.some((x) => x.startsWith('sse:')))
    await killChrome(c)
  }

  // B3: §5 断 elk → 列表回退不白屏
  {
    const c = await newChrome([], 'elk-broken')
    let pageErr = 0
    c.cdp.on((m) => { if (m.method === 'Runtime.exceptionThrown') pageErr++ })
    await c.cdp.send('Page.enable')
    await c.cdp.send('Runtime.enable')
    await c.cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*elk.bundled.js*', interceptionStage: 'Request' }] })
    c.cdp.on((m) => {
      if (m.method === 'Fetch.requestPaused') c.cdp.send('Fetch.failRequest', { requestId: m.params.requestId, errorReason: 'Aborted' }).catch(() => {})
    })
    await c.cdp.send('Page.navigate', { url: `http://127.0.0.1:${livePort}/` })
    let ready = false
    for (let i = 0; i < 100 && !ready; i++) { await sleep(300); try { ready = await c.cdp.eval('window.__pmCanvas && window.__pmCanvas.ready') } catch {} }
    await c.cdp.eval(`document.querySelector('[data-view="canvas"]').click()`)
    let mode = ''
    for (let i = 0; i < 40; i++) { await sleep(250); mode = await c.cdp.eval('window.__pmCanvas ? window.__pmCanvas.mode : ""'); if (mode === 'list') break }
    ok('§5 断 elk: 列表回退模式', mode === 'list', `mode=${mode}`)
    const vis = await c.cdp.eval(`({
      listShown: !document.querySelector('#cv-list').hidden,
      rows: document.querySelectorAll('#cv-list li').length,
      bodyLen: document.body.textContent.length,
      banner: (document.querySelector('#cv-banner')?.textContent || '')
    })`)
    ok('§5 断 elk: 列表视图在场+非白屏', vis.listShown && vis.rows > 50 && vis.bodyLen > 2000, `rows=${vis.rows} bodyLen=${vis.bodyLen}`)
    ok('§5 断 elk: 横幅注明回退', /列表回退|布局引擎/.test(vis.banner), vis.banner.slice(0, 60))
    await c.cdp.shot(shot('canvas-elk-fallback-list.png'))
    ok('§5 证据: 列表回退截图', statSync(shot('canvas-elk-fallback-list.png')).size > 10000)
    ok('§5 断 elk 段页面零未捕获异常', pageErr === 0, `exceptions=${pageErr}`)
    await killChrome(c)
  }
}

// ---------- 部署 + 运行 ----------
mkdirSync(BASE, { recursive: true })
const startedAt = new Date().toISOString()
await sandboxPart()

// 部署: 静态面是 boot 快照, 必须 try-restart 让 vendored/画布文件可服务
const PORT_FILE = `${homedir()}/.dsh/maestro/pm.port`
const SVC = 'pm-host-service'
const oldPort = JSON.parse(readFileSync(PORT_FILE, 'utf8')).port
const { spawnSync } = await import('node:child_process')
spawnSync('systemctl', ['--user', 'try-restart', SVC])
let livePort = 0
for (let i = 0; i < 80; i++) {
  await sleep(250)
  try { const p = JSON.parse(readFileSync(PORT_FILE, 'utf8')); if (p.port !== oldPort) { livePort = p.port; break } } catch {}
}
ok('部署: try-restart 后端口漂移(静态面新快照)', livePort > 0, `old=${oldPort} new=${livePort}`)
const health = await (await fetch(`http://127.0.0.1:${livePort}/health`)).json()
ok('部署: /health 200 且服务版本可见', !!health?.version, `v${health?.version}`)

await browserPart(livePort)

writeFileSync(`${BASE}/manifest.json`, `${JSON.stringify({ label: LABEL, gate: 'pmw2-2-canvas', startedAt, finishedAt: new Date().toISOString(), pass, fail, node: process.version, repo: REPO }, null, 2)}\n`)
console.log(`\n=== ${LABEL}: PASS=${pass} FAIL=${fail} (evidence: ${BASE}) ===`)
process.exit(fail === 0 ? 0 : 1)
