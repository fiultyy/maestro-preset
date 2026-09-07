#!/usr/bin/env node
// pmweb-dag-gate.mjs — PMWEB-DAG 图视重构 gate (spec /tmp/pmweb-dag-spec.md)。
//
// A. 聚合纯函数单测 (零浏览器, node 直 import public/cluster.js):
//    双轨键+兜底逐轨断言 (run/deps 连通分量/前缀族/单票), 轨道优先级 (run 压 deps),
//    deps=[] 批次不被吞并, dangling deps / 脏 JSON 防御, 终态-活跃口径, 全覆盖恰一簇;
//    clusterScene 折叠态派生 (簇超节点/成员票替换/边同形去重/跨簇边保留)。
// B. 静态门: index.html 图 tab+浮层 (既有四 tab 零回归); canvas.js 聚合导入+内省;
//    app.js 组织图标记 (既有 SSE 派发/三视图语义保留); style.css 样式面;
//    红线: fetch 端点白名单 + POST 仅 /op/act (ADR-002) + cluster.js 零 fetch
//    + package.json 零依赖。
// C. sandbox 浏览器门 (stub ledger + fleet fixture + mock dsh + bridge 血缘,
//    零 live 变更): 图 tab 出簇 (4 簇 = run/deps/prefix/single 各 1) + list 染选
//    联动 (选簇聚焦其余淡出 / 选票自动展开高亮 deps 边) + 折叠展开往返 + 空白取消;
//    席位 tab 小卡 (一行: 状态点+code+持票数) + 组织图血缘嵌套 (head 上 worker 下)
//    + 详情浮层全量字段+持票列表+关闭返回。页面异常任何一例即 FAIL。
// 留存: 截图/日志落 $PM_HOST_SERVICE_GATES_DIR/pmweb-dag/<label>/。
// Usage: node pmweb-dag-gate.mjs <label> [chrome-bin]
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'

const LABEL = process.argv[2] ?? `manual-${process.pid}`
const CHROME = process.argv[3] ?? process.env.CHROME_BIN ?? 'google-chrome'
const GATES_ROOT = process.env.PM_HOST_SERVICE_GATES_DIR ?? `${homedir()}/.dsh/maestro/logs/pm-host-service/gates`
const BASE = `${GATES_ROOT}/pmweb-dag/${LABEL}`
const PUBLIC = new URL('../public/', import.meta.url).pathname
const REPO = new URL('..', import.meta.url).pathname

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}${detail ? `  :: ${detail}` : ''}`) } else { fail++; console.log(`FAIL ${name}${detail ? `  :: ${detail}` : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- A. 聚合纯函数单测 ----------
{
  const cl = await import(`${PUBLIC}cluster.js`)
  const { clusterTickets, clusterScene, ticketRun, ticketDeps, ticketPrefix, TERMINAL_STATES } = cl
  const t = (id, over = {}) => ({ ticket_id: id, state: 'done', deps: '[]', refs: '{}', lease_owner: null, ...over })

  ok('A 轨①: refs.run 相同 → 同 run 簇', (() => {
    const c = clusterTickets([t('A-1', { refs: '{"run":"R1"}' }), t('A-2', { refs: '{"run":"R1"}' }), t('A-3')])
    return c.length === 2 && c[0].key === 'run:R1' && c[0].kind === 'run' && c[0].total === 2
  })())
  ok('A 轨②: deps 链 → 连通分量 (真 DAG 语义)', (() => {
    const c = clusterTickets([t('C-1'), t('C-2', { deps: '["C-1"]' }), t('C-3', { deps: '["C-2"]' })])
    return c.length === 1 && c[0].kind === 'deps' && c[0].total === 3 && c[0].key === 'cdep:C-1'
  })())
  ok('A 轨③: ticket_id 前缀族 (无 deps 边)', (() => {
    const c = clusterTickets([t('FAM-1'), t('FAM-2'), t('FAM-3')])
    return c.length === 1 && c[0].kind === 'prefix' && c[0].label === 'FAM' && c[0].total === 3
  })())
  ok('A 轨④: 无族无边单票 → 自簇', (() => {
    const c = clusterTickets([t('SOLO')])
    return c.length === 1 && c[0].kind === 'single' && c[0].label === 'SOLO' && c[0].key === 'one:SOLO'
  })())
  ok('A 优先级: run 压 deps — run 簇不与 deps 分量跨轨合并', (() => {
    const c = clusterTickets([t('X-1', { refs: '{"run":"R9"}', deps: '["Y-1"]' }), t('X-2', { refs: '{"run":"R9"}' }), t('Y-1', { deps: '["Y-2"]' }), t('Y-2')])
    const run = c.find((x) => x.kind === 'run'); const dep = c.find((x) => x.kind === 'deps')
    return c.length === 2 && run.total === 2 && dep.total === 2 && dep.ticketIds.join() === 'Y-1,Y-2'
  })())
  ok('A 已知事实: deps=[] 批次不吞巨型分量 — 同前缀批次走轨③', (() => {
    const c = clusterTickets([t('R26-1'), t('R26-2'), t('R26-3'), t('R27-1'), t('R27-2')])
    return c.length === 2 && c.every((x) => x.kind === 'prefix')
  })())
  ok('A 防御: dangling deps / 脏 JSON / null 字段不崩不误聚', (() => {
    const c = clusterTickets([t('ZED-1', { deps: '["GHOST"]', refs: '{bad json' }), t('ZAP-2', { deps: 'not-json', refs: 'null' }), t('ZIN-3', { deps: null, refs: null })])
    return c.length === 3 && c.every((x) => x.kind === 'single')
  })())
  ok('A 活跃口径: done/merged/rejected 终态, blocked/running/dispatched 活跃', (() => {
    const c = clusterTickets([t('M-1', { state: 'done' }), t('M-2', { state: 'merged' }), t('M-3', { state: 'blocked' }), t('M-4', { state: 'running' })])
    return c[0].total === 4 && c[0].active === 2 && c[0].states.done === 1 && c[0].states.blocked === 1
  })())
  ok('A 全覆盖: 一票恰属一簇且 ticketIds 升序', (() => {
    const ts = [t('B-2', { deps: '["B-1"]' }), t('B-1'), t('B-3'), t('S-1', { refs: '{"run":"RX"}' })]
    const c = clusterTickets(ts)
    const sum = c.reduce((a, x) => a + x.total, 0)
    const ids = c.flatMap((x) => x.ticketIds)
    return sum === ts.length && new Set(ids).size === ts.length && c.every((x) => JSON.stringify(x.ticketIds) === JSON.stringify([...x.ticketIds].sort()))
  })())
  ok('A 空入参 → 0 簇', clusterTickets([]).length === 0 && clusterTickets(null).length === 0)
  ok('A 场景(折叠): 簇=超节点, 簇内 deps 边同形去重为 0, 跨簇边保留', (() => {
    const ts = [t('P-1', { refs: '{"run":"R2"}', deps: '["Q-1"]' }), t('P-2', { refs: '{"run":"R2"}' }), t('Q-1'), t('Q-2', { deps: '["Q-1"]' })]
    const sc = clusterScene(ts, new Set())
    return sc.nodes.length === 2 && sc.nodes.every((n) => n.type === 'cluster')
      && sc.edges.length === 1 && sc.edges[0].id === 'dep:cl:cdep:Q-1>cl:run:R2'
  })())
  ok('A 场景(展开): 展开簇 → 成员票节点替换 + 簇内 deps 边显现', (() => {
    const ts = [t('Q-1', { state: 'blocked' }), t('Q-2', { deps: '["Q-1"]' }), t('Q-3')]
    const sc = clusterScene(ts, new Set(['cdep:Q-1']))
    const ids = sc.nodes.map((n) => n.id).sort()
    return ids.join() === 'cl:fam:Q,tk:Q-1,tk:Q-2' && sc.edges.length === 1 && sc.edges[0].id === 'dep:tk:Q-1>tk:Q-2'
      && sc.nodeOfTicket.get('Q-1') === 'tk:Q-1' && sc.nodeOfTicket.get('Q-3') === 'cl:fam:Q'
  })())
  ok('A 辅助: ticketRun/ticketDeps/ticketPrefix 脏形防御', ticketRun({ refs: '{"run":42}' }) === '42' && ticketDeps({ deps: '{"a":1}' }).length === 0 && ticketPrefix('NOPREFIX') === null && ticketPrefix('AND1-2') === 'AND1')
  ok('A 终态集冻结: done/merged/rejected', TERMINAL_STATES.size === 3 && ['done', 'merged', 'rejected'].every((s) => TERMINAL_STATES.has(s)))
}

// ---------- B. 静态门 ----------
const FETCH_ALLOW = new Set(['/op/tickets', '/op/fleet', '/op/flow', '/op/graph', '/op/trace', '/op/act', '/health', '/subscribe'])
{
  const html = readFileSync(`${PUBLIC}index.html`, 'utf8')
  ok('B index.html: 图 tab (data-view=dag + view-dag)', html.includes('data-view="dag"') && html.includes('id="view-dag"'))
  ok('B index.html: 既有四 tab 零回归', ['data-view="tickets"', 'data-view="fleet"', 'data-view="flow"', 'data-view="canvas"'].every((s) => html.includes(s)) && html.includes('id="view-canvas"') && html.includes('canvas.js'))
  ok('B index.html: 席位详情浮层 dialog 在场', html.includes('id="seat-detail"') && html.includes('id="sd-body"') && html.includes('id="sd-close"'))
  const cv = readFileSync(`${PUBLIC}canvas.js`, 'utf8')
  ok('B canvas.js: 聚合层导入 + 图 tab boot + 内省', cv.includes("from './cluster.js'") && cv.includes('clusterTickets(list)') && cv.includes('bootDag()') && cv.includes('window.__pmDag'))
  ok('B canvas.js: 既有泳道画布零回归 (boot/refetchGraph/drawer/replay 锚点仍在)', cv.includes('await refetchGraph()') && cv.includes('syncDrawer()') && cv.includes('loadReplay') && cv.includes('id="canvas-svg"'))
  const ap = readFileSync(`${PUBLIC}app.js`, 'utf8')
  ok('B app.js: 组织图+小卡+浮层标记', ap.includes('function lineageOf') && ap.includes('seat-mini') && ap.includes('org-children') && ap.includes('openSeatDetail') && ap.includes('loadGraph'))
  ok('B app.js: 既有 SSE 派发两事件 + 三视图 refetch 保留', ap.includes("new CustomEvent('pm:sse'") && ap.includes("new CustomEvent('pm:sse-state'") && ap.includes('refetch.tickets()') && ap.includes('refetch.flow()'))
  const css = readFileSync(`${PUBLIC}style.css`, 'utf8')
  ok('B style.css: 图 tab + 组织图 + 小卡 + 浮层样式面', css.includes('#dg-list') && css.includes('.dg-node') && css.includes('.org-children') && css.includes('.seat-mini') && css.includes('#seat-detail'))
  ok('B cluster.js: 纯函数模块零 fetch 零 DOM', (() => {
    const c = readFileSync(`${PUBLIC}cluster.js`, 'utf8')
    return !/fetch\(|document\.|window\./.test(c) && c.includes('export function clusterTickets')
  })())
  // 红线: fetch 端点白名单 + POST 仅 /op/act (ADR-002 页面零账本写)
  let fetchOk = true
  const postSites = []
  for (const f of ['app.js', 'canvas.js']) {
    const src = readFileSync(`${PUBLIC}${f}`, 'utf8')
    for (const m of src.matchAll(/fetch\(\s*['`]([^`'?]+)/g)) {
      // PMWEB-UI (9bb5281): 静态面路径相对化后 fetch 字面量无前导斜杠(按 document.baseURI
      // 解析), 且捕获须越过路径内 '/' 直达 '?'/引号 —— 剥前导斜杠归一, 白名单语义原样。
      const ep = `/${m[1].replace(/^\/+/, '')}`
      if (!FETCH_ALLOW.has(ep)) { fetchOk = false; console.log(`  redline: ${f} fetch(${m[1]}) 越白名单`) }
    }
    postSites.push(`${f}:${(src.match(/method: 'POST'/g) ?? []).length}`)
  }
  ok('B 红线: fetch 全量端点白名单 (/op/* + /health + /subscribe)', fetchOk, postSites.join(' '))
  ok('B 红线: POST 仅两处且均为 /op/act 透传 (app.js PW-005 + canvas.js PMW2-3)', (readFileSync(`${PUBLIC}app.js`, 'utf8').match(/method: 'POST'/g) ?? []).length === 1 && (readFileSync(`${PUBLIC}canvas.js`, 'utf8').match(/method: 'POST'/g) ?? []).length === 1)
  const pkg = JSON.parse(readFileSync(`${REPO}package.json`, 'utf8'))
  ok('B 宪章: package.json 仍零依赖字段', !pkg.dependencies && !pkg.devDependencies && !pkg.optionalDependencies)
}

// ---------- sandbox 工厂 (pmw2-3 gate 惯例: stub ledger + fleet fixture + mock dsh) ----------
// 7 票 → 4 簇: run:R77(RUN-1/RUN-2) + cdep:CH-A(CH-A←CH-B) + fam:FAM(FAM-1/FAM-2) + one:SGL-9
const TICKETS = [
  { ticket_id: 'RUN-1', state: 'running', deps: '[]', refs: '{"run":"R77"}', lease_owner: 'w1' },
  { ticket_id: 'RUN-2', state: 'done', deps: '[]', refs: '{"run":"R77"}', lease_owner: null },
  { ticket_id: 'CH-A', state: 'blocked', deps: '[]', refs: '{}', lease_owner: null },
  { ticket_id: 'CH-B', state: 'done', deps: '["CH-A"]', refs: '{}', lease_owner: null },
  { ticket_id: 'FAM-1', state: 'dispatched', deps: '[]', refs: '{}', lease_owner: null },
  { ticket_id: 'FAM-2', state: 'done', deps: '[]', refs: '{}', lease_owner: null },
  { ticket_id: 'SGL-9', state: 'merged', deps: '[]', refs: '{}', lease_owner: null },
]
const SEATS = {
  h1: { code: 'h1', sessionId: 'session-11111111-aaaa-4bbb-8ccc-111111111111', role: 'head', node: 'n-head', preset: 'maestro', spawnedAt: '2026-09-01T00:00:00Z', status: 'active' },
  w1: { code: 'w1', sessionId: 'session-22222222-aaaa-4bbb-8ccc-222222222222', role: 'worker', node: 'n-w', preset: 'long-task', spawnedAt: '2026-09-01T01:00:00Z', status: 'active' },
}
function writeFleet(sb) {
  const file = `${sb}/maestro/fleet.json`
  writeFileSync(`${file}.tmp.${process.pid}`, `${JSON.stringify({ rev: 1, fleet: SEATS }, null, 2)}\n`)
  renameSync(`${file}.tmp.${process.pid}`, file)
}
const LEDGER_STUB = `#!/bin/bash
if [ "$1 $2" = "ticket list" ]; then
  echo '${JSON.stringify({ tickets: TICKETS })}'
  exit 0
fi
echo "stub-ok"; exit 0
`
async function startMockDsh() {
  const server = createServer((rq, rs) => {
    const chunks = []
    rq.on('data', (d) => chunks.push(d))
    rq.on('end', () => {
      rs.writeHead(200, { 'content-type': 'application/json' })
      rs.end(JSON.stringify({ result: { ok: true, value: { items: [
        { sessionId: 'session-11111111-aaaa-4bbb-8ccc-111111111111', running: true, blank: false, agentPreset: 'maestro', cwd: '/tmp/pmweb-dag-gate', projections: { values: { title: 'head-session' } } },
        { sessionId: 'session-22222222-aaaa-4bbb-8ccc-222222222222', running: false, blank: false, agentPreset: 'long-task', cwd: '/tmp/pmweb-dag-gate', projections: { values: { title: 'worker-session' } } },
      ] } } }))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { server, port: server.address().port, close: () => new Promise((r) => server.close(r)) }
}
async function startSandbox(tag) {
  const sb = `${BASE}/${tag}`
  rmSync(sb, { recursive: true, force: true })
  mkdirSync(`${sb}/maestro/bin`, { recursive: true })
  writeFileSync(`${sb}/maestro/bin/ledger`, LEDGER_STUB, { mode: 0o755 })
  writeFileSync(`${sb}/maestro/bin/flowc`, '#!/bin/bash\necho "flowc inspect (stub)"; exit 0\n', { mode: 0o755 })
  writeFileSync(`${sb}/maestro/bin/fleet-list`, '#!/bin/bash\necho "[]"\n', { mode: 0o755 })
  writeFleet(sb)
  // 血缘 fixture: callback 边 worker→head (bridge inbox.log 行格式, service gatherBridgePairs)
  mkdirSync(`${sb}/maestro/bridge`, { recursive: true })
  writeFileSync(`${sb}/maestro/bridge/inbox.log`, `${JSON.stringify({ from: 'w1@session-22222222-aaaa-4bbb-8ccc-222222222222', to: 'head@session-11111111-aaaa-4bbb-8ccc-111111111111' })}\n`)
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

// ---------- CDP 驱动 (node 内建 WebSocket, 零 npm) ----------
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
async function newChrome(tag) {
  const dir = `${BASE}/chrome-${tag}`
  mkdirSync(dir, { recursive: true })
  const proc = spawn(CHROME, ['--headless=new', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', '--window-size=1600,1000', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
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
const clickNode = (sel) => `(() => {
  const node = document.querySelector('${sel}')
  if (!node) return false
  const r = node.getBoundingClientRect()
  const o = { bubbles: true, cancelable: true, pointerId: 5, buttons: 1, clientX: r.left + 2, clientY: r.top + 2 }
  node.dispatchEvent(new PointerEvent('pointerdown', o))
  node.dispatchEvent(new PointerEvent('pointerup', o))
  return true
})()`
const clickEl = (sel) => `(() => {
  const node = document.querySelector('${sel}')
  if (!node) return false
  node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
  return true
})()`

// ---------- C. sandbox 浏览器门 ----------
async function sandboxPart() {
  const shot = (f) => `${BASE}/${f}`
  const errors = []
  const box = await startSandbox('browser')
  let c = null
  try {
    // 静态面出聚合模块
    const clj = await fetch(`http://127.0.0.1:${box.port}/cluster.js`)
    ok('C 静态面: /cluster.js 200 且 JS MIME', clj.status === 200 && /javascript/.test(clj.headers.get('content-type') ?? ''), clj.headers.get('content-type'))
    const home = await (await fetch(`http://127.0.0.1:${box.port}/`)).text()
    ok('C 静态面: GET / 含图 tab', home.includes('data-view="dag"') && home.includes('id="view-dag"'))

    c = await newChrome('dag')
    c.cdp.on((m) => { if (m.method === 'Runtime.exceptionThrown') errors.push(JSON.stringify(m.params?.exceptionDetails ?? {}).slice(0, 160)) })
    await c.cdp.send('Page.enable')
    await c.cdp.send('Runtime.enable')
    await c.cdp.send('Page.navigate', { url: `http://127.0.0.1:${box.port}/` })
    let ready = false
    for (let i = 0; i < 100 && !ready; i++) { await sleep(300); try { ready = await c.cdp.eval('window.__pmCanvas && window.__pmCanvas.ready === true && window.__pmDag && window.__pmDag.ready === true') } catch {} }
    ok('C 页面就绪: 泳道画布 + 聚合 DAG 双场景 ready', ready)

    // 图 tab: 出簇
    await c.cdp.eval(`document.querySelector('[data-view="dag"]').click()`)
    await sleep(700) // elk 布局+取景
    const dag = await c.cdp.eval('window.__pmDag')
    ok('C 图 tab: 7 票 → 4 簇 (run/deps/prefix/single 各 1)', dag.clusters === 4 && dag.byKind.run === 1 && dag.byKind.deps === 1 && dag.byKind.prefix === 1 && dag.byKind.single === 1, JSON.stringify(dag.byKind))
    ok('C 图 tab: 折叠场景 4 超节点 0 边 (簇内 deps 边聚合隐藏)', dag.nodes === 4 && dag.edges === 0, `nodes=${dag.nodes} edges=${dag.edges}`)
    const listRows = await c.cdp.eval(`({
      clusters: document.querySelectorAll('#dg-list .dg-cluster').length,
      metas: [...document.querySelectorAll('#dg-list .dg-meta')].map((x) => x.textContent.trim()),
      dists: [...document.querySelectorAll('#dg-list .dg-dist')].map((x) => x.textContent.trim()).join(' | '),
    })`)
    ok('C list: 簇列表 4 行 (票数/活跃数/状态分布摘要)', listRows.clusters === 4 && listRows.metas.length === 4 && /2 票 · 1 活跃/.test(listRows.metas.join(' ')) && /running 1 · done 1/.test(listRows.dists), `${listRows.metas.join(' / ')} :: ${listRows.dists.slice(0, 90)}`)

    // 染选联动 ①: 选簇聚焦, 其余淡出
    await c.cdp.eval(clickEl('#dg-list .dg-cluster-row[data-key="run:R77"]'))
    await sleep(150)
    const focus = await c.cdp.eval(`({
      sel: window.__pmDag.selected,
      dims: document.querySelectorAll('#dag-svg .dg-dim').length,
      selNodes: document.querySelectorAll('#dag-svg .dg-sel').length,
    })`)
    ok('C 选簇聚焦: selected=run:R77 且其余簇淡出', focus.sel?.kind === 'cluster' && focus.sel.key === 'run:R77' && focus.dims === 3 && focus.selNodes === 1, JSON.stringify(focus))
    await c.cdp.shot(shot('dag-cluster-focus.png'))

    // 染选联动 ②: list 折叠钮展开 deps 簇 → 点成员票 → deps 边高亮 (折叠簇无成员行, 先展开)
    await c.cdp.eval(clickEl('#dg-list .dg-fold-btn[data-fold="cdep:CH-A"]'))
    await sleep(700)
    const preT = await c.cdp.eval('({ nodes: window.__pmDag.nodes, expanded: window.__pmDag.expanded })')
    ok('C list 折叠钮: 展开 deps 簇 (成员票 2 入场)', preT.nodes === 5 && preT.expanded.includes('cdep:CH-A'), JSON.stringify(preT))
    await c.cdp.eval(clickEl('#dg-list .dg-ticket-row[data-tid="CH-A"]'))
    await sleep(700)
    const tsel = await c.cdp.eval(`({
      sel: window.__pmDag.selected,
      nodes: window.__pmDag.nodes, edges: window.__pmDag.edges,
      expanded: window.__pmDag.expanded,
      dims: document.querySelectorAll('#dag-svg .dg-dim').length,
      lit: document.querySelectorAll('#dag-svg .dg-lit').length,
      selRows: document.querySelectorAll('#dg-list .dg-selected').length,
    })`)
    ok('C 选票: 所在簇自动展开 (成员票 2 + 簇内 deps 边 1)', tsel.sel?.kind === 'ticket' && tsel.sel.id === 'CH-A' && tsel.expanded.includes('cdep:CH-A') && tsel.nodes === 5 && tsel.edges === 1, JSON.stringify(tsel.sel ?? {}))
    ok('C 选票染选: deps 边 lit 且其余淡出 (3 节点淡出)', tsel.lit === 1 && tsel.dims === 3 && tsel.selRows >= 1, `lit=${tsel.lit} dims=${tsel.dims}`)
    await c.cdp.shot(shot('dag-ticket-highlight.png'))

    // 折叠往返: list 折叠钮收起 → 回聚合态 (展开态簇节点不在场景, 折叠走 list)
    await c.cdp.eval(clickEl('#dg-list .dg-fold-btn[data-fold="cdep:CH-A"]'))
    await sleep(700)
    const folded = await c.cdp.eval('({ nodes: window.__pmDag.nodes, edges: window.__pmDag.edges, expanded: window.__pmDag.expanded })')
    ok('C 折叠钮: 展开簇收回聚合态 (4 节点 0 边)', folded.nodes === 4 && folded.edges === 0 && folded.expanded.length === 0, JSON.stringify(folded))

    // 空白点击取消
    const cleared = await c.cdp.eval(`(() => {
      const svg = document.querySelector('#dag-svg')
      const r = svg.getBoundingClientRect()
      const o = { bubbles: true, cancelable: true, pointerId: 6, buttons: 1, clientX: r.left + 5, clientY: r.top + 5 }
      svg.dispatchEvent(new PointerEvent('pointerdown', o))
      svg.dispatchEvent(new PointerEvent('pointerup', o))
      return { sel: window.__pmDag.selected, dims: document.querySelectorAll('#dag-svg .dg-dim').length }
    })()`)
    ok('C 空白点击取消染选', cleared.sel === null && cleared.dims === 0, JSON.stringify(cleared))

    // 席位 tab: 小卡 + 组织图血缘 + 详情浮层
    await c.cdp.eval(`document.querySelector('[data-view="fleet"]').click()`)
    await sleep(500)
    const fleet = await c.cdp.eval(`({
      minis: [...document.querySelectorAll('.seat-mini')].map((b) => ({ code: b.dataset.code, text: b.textContent.replace(/\\s+/g, ' ').trim() })),
      nested: !!document.querySelector('.org-chart .org-children .seat-mini[data-code="w1"]'),
      headTop: !!document.querySelector('.org-chart > .org-node .seat-mini[data-code="h1"]'),
      zeroDag: !document.querySelector('#view-fleet #cv-stage') && !document.querySelector('#view-fleet svg'),
    })`)
    ok('C 席位小卡: 一行缩略 (code+状态点+持票数), 2 卡', fleet.minis.length === 2 && fleet.minis.every((m) => /票/.test(m.text)), JSON.stringify(fleet.minis))
    ok('C 组织图: head 在上 worker 嵌套在下 (血缘边 h1←w1)', fleet.headTop && fleet.nested)
    ok('C 需求4: 席位 tab 零票 DAG 挂载点', fleet.zeroDag)
    await c.cdp.shot(shot('fleet-org-chart.png'))
    await c.cdp.eval(clickEl('.seat-mini[data-code="w1"]'))
    await sleep(200)
    const detail = await c.cdp.eval(`({
      open: document.querySelector('#seat-detail').hasAttribute('open'),
      body: document.querySelector('#sd-body').textContent,
    })`)
    ok('C 详情浮层: 点小卡弹出, join 字段全量+持票列表+血缘', detail.open && detail.body.includes('session-22222222') && detail.body.includes('/tmp/pmweb-dag-gate') && detail.body.includes('RUN-1') && detail.body.includes('上级 head') && detail.body.includes('h1') && detail.body.includes('持票'), `len=${detail.body.length}`)
    await c.cdp.shot(shot('seat-detail-overlay.png'))
    await c.cdp.eval(`document.querySelector('#sd-close').click()`)
    await sleep(120)
    const closed = await c.cdp.eval(`document.querySelector('#seat-detail').hasAttribute('open')`)
    ok('C 详情浮层: 关闭返回', closed === false)

    // 回归: 票视图 kanban 与画布 tab 在场可用
    await c.cdp.eval(`document.querySelector('[data-view="tickets"]').click()`)
    await sleep(300)
    const kanban = await c.cdp.eval(`document.querySelectorAll('#view-tickets .ticket-card').length`)
    ok('C 回归: 票视图 kanban 照常渲染 (7 卡)', kanban === 7, `cards=${kanban}`)
    await c.cdp.eval(`document.querySelector('[data-view="canvas"]').click()`)
    let mode = ''
    for (let i = 0; i < 40 && mode !== 'canvas'; i++) { await sleep(250); mode = await c.cdp.eval('window.__pmCanvas ? window.__pmCanvas.mode : ""') }
    ok('C 回归: 画布 tab 泳道场景照常 (elk 可用即 canvas 模式)', mode === 'canvas', `mode=${mode}`)
    ok('C 页面零异常 (全段)', errors.length === 0, errors.slice(0, 2).join(' | '))
  } finally {
    await killChrome(c)
    await box.stop()
  }
}

// ---------- 运行 ----------
mkdirSync(BASE, { recursive: true })
const startedAt = new Date().toISOString()
await sandboxPart()
writeFileSync(`${BASE}/manifest.json`, `${JSON.stringify({ label: LABEL, gate: 'pmweb-dag', startedAt, finishedAt: new Date().toISOString(), pass, fail, node: process.version, repo: REPO }, null, 2)}\n`)
console.log(`\n=== ${LABEL}: PASS=${pass} FAIL=${fail} (evidence: ${BASE}) ===`)
process.exit(fail === 0 ? 0 : 1)
