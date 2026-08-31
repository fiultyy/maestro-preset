#!/usr/bin/env node
// pmw2-4-replay-gate.mjs — PMW2-4 trace 时间轴回放 + minimap/缩放打磨 gate (末票).
//
// A. 静态门 (零浏览器): canvas.js 回放/minimap/常显标题/双击居中标记 + 回放冻结
//    refetch 守卫; 红线: service.mjs / app.js / index.html 相对 HEAD 零 diff,
//    elk vendor sha256 仍钉死。
// B. 浏览器门- live (部署=try-restart; /op/trace 只读):
//    1) 载入回放: 事件数 === gate 侧 /op/trace 全会话条目和 (逐条一致);
//    2) 游标拖至 30%: 回放态 (回放中徽章 + cv-future 淡出节点/边各 >0 + 活跃 >0);
//    3) 播放 4×: 游标推进 ≥ 2× 实时; 暂停;
//    4) 游标推到 now: 自动切实况, cv-future 清零, /op/graph refetch 恢复;
//    5) minimap: 视口框随拖拽平移联动, 点缩略图跳转视图; 节点 dots 数 = 全图节点;
//    6) 双击节点: 节点中心对准 stage 中心 (±80px) 且适配缩放;
//    7) 泳道常显标题: 深缩放+下滚后 sticky chips ≥1;
//    8) 抽屉回归冒烟 (点节点开抽屉); 页面零异常。
// 全程截图留证; 留存 (HF-013 ②): $PM_HOST_SERVICE_GATES_DIR/pmw2-4/<label>/。
// Usage: node pmw2-4-replay-gate.mjs <label> [chrome-bin]
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'

const LABEL = process.argv[2] ?? `manual-${process.pid}`
const CHROME = process.argv[3] ?? process.env.CHROME_BIN ?? 'google-chrome'
const GATES_ROOT = process.env.PM_HOST_SERVICE_GATES_DIR ?? `${homedir()}/.dsh/maestro/logs/pm-host-service/gates`
const BASE = `${GATES_ROOT}/pmw2-4/${LABEL}`
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
  ok('A 回放: 载入按钮 + /op/trace 按 sessionId 拉取', /\/op\/trace\?sessionId=/.test(cv) && cv.includes('载入回放'))
  ok('A 回放: 事件按 ts 排序 + 命中预计算', /\.sort\(\(a, b\) => \(a\._ts \?\? Infinity\) - \(b\._ts \?\? Infinity\)\)/.test(cv) && cv.includes('buildReplayHits'))
  ok('A 回放: 游标 now → 切回实况', /R\.max - R\.cursor <= 1500\) return exitReplay\(\)/.test(cv))
  ok('A 回放: 播放/倍速 1x|4x|16x', cv.includes('tlPlayToggle') && ['"1"', '"4"', '"16"'].every((v) => cv.includes(`<option value=${v}`)))
  ok('A 性能: 回放只切样式 (cv-future class), refetch 冻结守卫', /cv-future/.test(cv) && /C\.replay\.on\) return \/\/ PMW2-4/.test(cv))
  ok('A minimap: 全图缩略 + 视口框 + 点跳联动', cv.includes('drawMinimap') && cv.includes('updateMiniVp') && cv.includes('wireMinimap'))
  ok('A 打磨: 双击居中 + 泳道常显标题', cv.includes("addEventListener('dblclick'") && cv.includes('updateSticky') && cv.includes('cv-sticky-chip'))
  ok('A 初始 fit 全图 (既有 fitView 链在位)', cv.includes('function fitView()') && cv.includes('fitDoneCheck'))
  const buf = readFileSync(`${PUBLIC}elk.bundled.js`)
  ok('红线: elk vendor sha256 仍钉死 (零触碰)', sha256(buf) === SPEC_SHA, sha256(buf).slice(0, 16) + '…')
  const dirty = spawnSync('git', ['-C', REPO, 'diff', '--name-only', 'HEAD', '--', 'plugins/pm-host-service/service.mjs', 'plugins/pm-host-service/public/app.js', 'plugins/pm-host-service/public/index.html'], { encoding: 'utf8' }).stdout.trim()
  ok('红线: service.mjs / app.js / index.html 相对 HEAD 零 diff', dirty === '', dirty || '(clean)')
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
async function newChrome(tag, extraArgs = []) {
  const dir = `${BASE}/chrome-${tag}`
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
  await sleep(600)
  return { ready, mode }
}

// ---------- B. live 浏览器门 ----------
async function livePart(livePort) {
  const shot = (f) => `${BASE}/${f}`
  const errors = []

  // gate 侧 trace 总数 (与页面同源同口径: /op/graph 会话集 → 逐会话 entries 和)
  const g = await (await fetch(`http://127.0.0.1:${livePort}/op/graph`)).json()
  const sids = [...new Set(g.nodes.filter((n) => n.type === 'session').map((n) => n.sessionId).filter(Boolean))]
  let traceTotal = 0
  for (const sid of sids) {
    try { const j = await (await fetch(`http://127.0.0.1:${livePort}/op/trace?sessionId=${encodeURIComponent(sid)}`)).json(); traceTotal += (j?.entries ?? []).length } catch {}
  }

  const c = await newChrome('live')
  const { ready, mode } = await openCanvas(c, livePort, errors, 'live')
  ok('B live: 页面就绪 + 画布模式', ready && mode === 'canvas', `ready=${ready} mode=${mode}`)
  const nodes = await c.cdp.eval('window.__pmCanvas.nodes')
  const miniDots = await c.cdp.eval('window.__pmCanvas.minimapDots')
  ok('B minimap: 呈现且 dots = 全图节点', miniDots === nodes && nodes > 100, `dots=${miniDots} nodes=${nodes}`)

  // 1) 载入回放
  await c.cdp.eval(`document.querySelector('#cv-tl-load').click()`)
  let rp = null
  for (let i = 0; i < 120; i++) { await sleep(500); rp = await c.cdp.eval('window.__pmCanvas.replay'); if (rp.loaded) break }
  ok('B 回放: 事件流载入完成', !!rp?.loaded, JSON.stringify(rp))
  ok('B 回放: 事件数与 /op/trace 一致', rp.events === traceTotal, `page=${rp.events} gate=${traceTotal}`)
  ok('B 回放: 时间轴控件切到播放态', await c.cdp.eval(`!document.querySelector('#cv-tl-ctrl').hidden && document.querySelector('#cv-tl-load').hidden`) === true)
  await c.cdp.shot(shot('timeline-loaded.png'))
  ok('B 证据: timeline-loaded.png', statSync(shot('timeline-loaded.png')).size > 10000)

  // 2) 游标拖至 30% → 回放态
  const setRange = (v) => `(() => {
    const r = document.querySelector('#cv-tl-range')
    r.value = '${v}'
    r.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`
  await c.cdp.eval(setRange(300))
  await sleep(400)
  let mid = await c.cdp.eval(`({
    on: window.__pmCanvas.replay.on,
    mode: document.querySelector('#cv-tl-mode').textContent,
    cursor0: window.__pmCanvas.replay.cursor,
    futureN: document.querySelectorAll('.cv-node.cv-future').length,
    liveN: document.querySelectorAll('.cv-node:not(.cv-future)').length,
    futureE: document.querySelectorAll('.cv-edge.cv-future').length,
    liveE: document.querySelectorAll('.cv-edge:not(.cv-future)').length,
  })`)
  ok('B 回放: 游标 30% → 回放态(徽章/节点变色/边随游标增减)', mid.on && mid.mode === '回放中' && mid.futureN > 0 && mid.liveN > 0 && mid.futureE > 0 && mid.liveE > 0, JSON.stringify(mid))
  await c.cdp.shot(shot('replay-mid.png'))
  ok('B 证据: replay-mid.png', statSync(shot('replay-mid.png')).size > 10000)

  // 3) 播放 4×
  await c.cdp.eval(`(() => { const s = document.querySelector('#cv-tl-speed'); s.value = '4'; s.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
  await c.cdp.eval(`document.querySelector('#cv-tl-play').click()`)
  await sleep(1500)
  const rp2 = await c.cdp.eval('window.__pmCanvas.replay')
  ok('B 回放: 播放中且 4× 游标推进 ≥ 2× 实时', rp2.playing && rp2.speed === 4 && rp2.cursor - mid.cursor0 >= 3000, JSON.stringify({ cursor0: mid.cursor0, cursor: rp2.cursor, speed: rp2.speed }))
  await c.cdp.shot(shot('replay-playing-4x.png'))
  await c.cdp.eval(`document.querySelector('#cv-tl-play').click()`) // 暂停
  const paused = await c.cdp.eval('window.__pmCanvas.replay.playing')
  ok('B 回放: 暂停生效', paused === false)
  ok('B 证据: replay-playing-4x.png', statSync(shot('replay-playing-4x.png')).size > 10000)

  // 4) 游标 → now 切回实况
  const lra0 = await c.cdp.eval('window.__pmCanvas.lastRefetchAt')
  await c.cdp.eval(setRange(1000))
  await sleep(1200)
  const live = await c.cdp.eval(`({
    on: window.__pmCanvas.replay.on,
    mode: document.querySelector('#cv-tl-mode').textContent,
    future: document.querySelectorAll('.cv-future').length,
    sse: window.__pmCanvas.sseOpen,
    lra: window.__pmCanvas.lastRefetchAt,
  })`)
  ok('B 回放: 游标=now → 切回实况(样式清零 + refetch 恢复)', live.on === false && live.mode === '实况' && live.future === 0 && live.lra > lra0, JSON.stringify(live))
  await c.cdp.shot(shot('replay-live.png'))
  ok('B 证据: replay-live.png', statSync(shot('replay-live.png')).size > 10000)

  // 5) minimap 联动
  const vp0 = await c.cdp.eval(`(() => { const v = document.querySelector('#mm-vp'); return { x: v.getAttribute('x'), y: v.getAttribute('y') } })()`)
  await c.cdp.eval(`(() => {
    const svg = document.querySelector('#canvas-svg')
    const r = svg.getBoundingClientRect()
    const o = { bubbles: true, cancelable: true, pointerId: 7, buttons: 1, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }
    svg.dispatchEvent(new PointerEvent('pointerdown', o))
    svg.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: r.left + r.width / 2 + 200, clientY: r.top + r.height / 2 + 120 }))
    svg.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: r.left + r.width / 2 + 200, clientY: r.top + r.height / 2 + 120 }))
    return true
  })()`)
  await sleep(250)
  const vp1 = await c.cdp.eval(`(() => { const v = document.querySelector('#mm-vp'); return { x: v.getAttribute('x'), y: v.getAttribute('y') } })()`)
  ok('B minimap: 拖拽平移 → 视口框联动', vp1.x !== vp0.x && vp1.y !== vp0.y, `${JSON.stringify(vp0)} -> ${JSON.stringify(vp1)}`)
  const view0 = await c.cdp.eval('window.__pmCanvas.view')
  await c.cdp.eval(`(() => {
    const box = document.querySelector('#cv-minimap')
    const r = box.getBoundingClientRect()
    const o = { bubbles: true, cancelable: true, pointerId: 8, clientX: r.left + 30, clientY: r.top + 30 }
    box.dispatchEvent(new PointerEvent('pointerdown', o))
    box.dispatchEvent(new PointerEvent('pointerup', o))
    return true
  })()`)
  await sleep(250)
  const view1 = await c.cdp.eval('window.__pmCanvas.view')
  ok('B minimap: 点缩略图跳转视图', view1.x !== view0.x || view1.y !== view0.y, `${JSON.stringify(view0)} -> ${JSON.stringify(view1)}`)
  await c.cdp.shot(shot('minimap-link.png'))
  ok('B 证据: minimap-link.png', statSync(shot('minimap-link.png')).size > 10000)

  // 6) 双击节点居中+适配
  const dbl = await c.cdp.eval(`(() => {
    const node = document.querySelector('.cv-node[data-id="tk:AND1-1"]') || document.querySelector('.cv-node')
    if (!node) return null
    node.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 300, clientY: 300, detail: 2 }))
    const id = node.dataset.id
    const p = window.__pmCanvas && document.querySelector('.cv-node[data-id="' + id + '"]')
    const st = document.querySelector('#cv-stage').getBoundingClientRect()
    const nb = p.getBoundingClientRect()
    return { id, dx: Math.abs(nb.left + nb.width / 2 - (st.left + st.width / 2)), dy: Math.abs(nb.top + nb.height / 2 - (st.top + st.height / 2)), s: window.__pmCanvas.view.s }
  })()`)
  ok('B 打磨: 双击节点居中(±80px)+适配缩放', dbl && dbl.dx < 80 && dbl.dy < 80 && dbl.s >= 1.4, JSON.stringify(dbl))
  await c.cdp.shot(shot('dblclick-center.png'))
  ok('B 证据: dblclick-center.png', statSync(shot('dblclick-center.png')).size > 10000)

  // 7) 泳道常显标题 (深缩放到 2× + 上滚: 让早泳道 header 越过视口顶)
  const sticky = await c.cdp.eval(`(() => {
    const svg = document.querySelector('#canvas-svg')
    const r = svg.getBoundingClientRect()
    for (let i = 0; i < 14; i++) svg.dispatchEvent(new WheelEvent('wheel', { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, deltaY: -240, bubbles: true, cancelable: true }))
    const o = { bubbles: true, cancelable: true, pointerId: 9, buttons: 1, clientX: r.left + r.width / 2, clientY: r.top + 620 }
    svg.dispatchEvent(new PointerEvent('pointerdown', o))
    svg.dispatchEvent(new PointerEvent('pointermove', { ...o, clientY: r.top + 20 }))
    svg.dispatchEvent(new PointerEvent('pointerup', { ...o, clientY: r.top + 20 }))
    return { s: window.__pmCanvas.view.s, vy: window.__pmCanvas.view.y, sticky: window.__pmCanvas.stickyVisible }
  })()`)
  ok('B 打磨: 深缩放+上滚 → 泳道常显标题 ≥1', sticky.s >= 1.9 && sticky.sticky >= 1, JSON.stringify(sticky))
  await c.cdp.shot(shot('sticky-titles.png'))
  ok('B 证据: sticky-titles.png', statSync(shot('sticky-titles.png')).size > 10000)

  // 8) 抽屉回归冒烟 (PMW2-3 面未回退; 全量回归由 pmw2-3 gate 复跑承担)
  await c.cdp.eval(`(() => {
    const node = document.querySelector('.cv-node')
    const r = node.getBoundingClientRect()
    const o = { bubbles: true, cancelable: true, pointerId: 4, buttons: 1, clientX: r.left + 2, clientY: r.top + 2 }
    node.dispatchEvent(new PointerEvent('pointerdown', o))
    node.dispatchEvent(new PointerEvent('pointerup', o))
    return true
  })()`)
  await sleep(250)
  const drawerOk = await c.cdp.eval(`!document.querySelector('#cv-drawer').hidden && !!window.__pmCanvas.drawer`)
  ok('B 冒烟: 点节点仍开抽屉 (PMW2-3 零回归)', drawerOk === true)
  ok('B live 段页面零异常', errors.length === 0, errors.slice(0, 2).join(' | '))
  await killChrome(c)
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

await livePart(livePort)

writeFileSync(`${BASE}/manifest.json`, `${JSON.stringify({ label: LABEL, gate: 'pmw2-4-replay', startedAt, finishedAt: new Date().toISOString(), pass, fail, node: process.version, repo: REPO }, null, 2)}\n`)
console.log(`\n=== ${LABEL}: PASS=${pass} FAIL=${fail} (evidence: ${BASE}) ===`)
process.exit(fail === 0 ? 0 : 1)
