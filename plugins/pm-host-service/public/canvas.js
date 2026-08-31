// pm-web 画布 tab — PMW2-2 MVP 只读 (spec docs/specs/spec-pm-web-canvas.md §1/§2/§4/§5)
// 零 npm / 零构建: 唯一 vendor = elk.bundled.js (elkjs 0.12.0 逐字节, EPL-2.0,
// 见 README「Vendor 例外」), 经 elk.js 动态 import —— 加载或布局失败 → 画布
// 回退按 flow 分组的列表视图, 绝不白屏 (spec §5 降级链)。
// 数据: GET /op/graph (PMW2-1); 增量: 复用 app.js 既有 SSE 连接 (pm:sse 事件,
// 400ms 去抖 refetch → 按 id diff → 受影响泳道重排 → 节点/边 300ms 位移过渡);
// SSE 断 (pm:sse-state open:false) → 30s 轮询, 恢复即回事件驱动。
// 交互只读: wheel 缩放 (指针为锚, 0.5×–2×) + 空白拖拽平移 + 节点 hover/点击
// 高亮关联边 (点击钉住, 空白点击取消)。PMW2-3 增量: 点节点开右侧抽屉 (四型明细)
// + 抽屉内过门快捷动作 (唯一写路径仍是既有 POST /op/act 透传, 确认弹层把门,
// 不可逆转移双确认); §4 其余禁令 (节点拖动/编辑/右键/hover 抽屉/回放) 保持。
'use strict'

const $ = (s) => document.querySelector(s)
const clamp = (v, a, b) => Math.min(b, Math.max(a, v))
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]))

// 色板对齐 app.js STATE_COLORS / style.css 徽章色表 (状态色环外环用)
const STATE_COLORS = {
  dispatched: '#e0a93e', running: '#4da3ff', blocked: '#e06c5f', done: '#3fbf7f',
  merged: '#9d7cd8', rejected: '#8a5a54', pending: '#7f8da0', unknown: '#7f8da0',
  flying: '#7f8da0', ok: '#3fbf7f', ready: '#4da3ff', error: '#e06c5f',
  active: '#3fbf7f', verified: '#3fbf7f', probing: '#e0a93e', stale: '#e0a93e',
}
const colorOf = (s) => STATE_COLORS[s] || '#7f8da0'
const EDGE_STYLE = { // §1.2 样式列照抄: 实线/虚线(6 4)/点线(2 4), dispatch 终点箭头
  dep: { color: '#6b7688', dash: '', width: 1.5, arrow: false },
  dispatch: { color: '#4da3ff', dash: '', width: 1.5, arrow: true },
  callback: { color: '#9d7cd8', dash: '6 4', width: 1.5, arrow: false },
  'cb-send': { color: '#e0a93e', dash: '2 4', width: 1.5, arrow: false },
}

// PMW2-3 动作面: 快捷动作仅两类, 均走既有 POST /op/act (服务端零改动)。
// flow-node → `flowc advance <flow> <node> --result done|failed`;
// ticket    → `ledger ticket state <id> <合法转移>` (迁移表镜像自 ledger CLI)。
// 不可逆类 (blocked/rejected/merged/rolled-back) 双确认: 勾选 checkbox 后才可提交。
const TICKET_TRANSITIONS = { // ledger 状态机合法迁移表 (只读镜像)
  dispatched: ['running', 'rejected'],
  running: ['blocked', 'done', 'rejected'],
  blocked: ['running', 'done', 'rejected'],
  done: ['running', 'merged', 'rejected'],
  merged: ['rolled-back'],
  rejected: [],
  'rolled-back': [],
}
const IRREV = new Set(['blocked', 'rejected', 'merged', 'rolled-back'])
const actCmdFor = {
  'flow-node': (n, result) => ({ tool: 'flowc', args: ['advance', n.flow, n.nodeId, '--result', result] }),
  ticket: (n, state) => ({ tool: 'ledger', args: ['ticket', 'state', n.ticketId, state] }),
}
const VERB_SHAPE = { status: '矩形', dispatch: '平行四边形', callback: '圆角矩形' }
const argvText = (tool, args) => `${tool} ${args.map((a) => (/^[\w./:@=-]+$/.test(a) ? a : JSON.stringify(a))).join(' ')}`

const SVG_NS = 'http://www.w3.org/2000/svg'
const svgEl = (tag, attrs = {}) => {
  const n = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v))
  return n
}

// ---- 状态 ----
const C = {
  graph: null, // 最近一次 /op/graph 响应
  elk: null, // ELK 实例 (加载失败保持 null)
  elkTried: false,
  mode: 'boot', // 'canvas' | 'list'
  nodes: new Map(), // id -> node json (现场景)
  edges: new Map(), // id -> edge json
  pos: new Map(), // id -> {x, y, w, h} 世界坐标
  local: new Map(), // laneId -> Map(id -> {x, y}) 泳道内局部布局 (未受影响泳道复用)
  lanes: [], // [{ id, title, nodeIds, w, h, x, y }]
  laneIndex: new Map(), // id -> lane
  laneBounds: {}, // gate/证据取景用 (只读数据面)
  nodeEls: new Map(), // id -> <g>
  edgeEls: new Map(), // id -> <path>
  view: { x: 0, y: 0, s: 1 },
  selected: null,
  hover: null,
  tweenRaf: 0,
  fitDone: false,
  sseOpen: null,
  pollTimer: 0,
  lastRefetchAt: 0,
  refetching: false,
  drawerNode: null, // PMW2-3: 抽屉当前节点 id (null = 关)
  actHist: new Map(), // nodeId -> [ {ts, ref, action, status, exitCode, ms, err} ] (页内内存审计)
  pending: new Map(), // ref -> {nodeId, entry, timer} 在途 act (轮询 + SSE 双路对账)
  replay: { on: false, loaded: false, loading: false, events: [], min: 0, max: 0, cursor: 0, playing: false, speed: 1, raf: 0 }, // PMW2-4: trace 回放
  mini: { k: 1, ox: 0, oy: 0 }, // minimap 世界→缩略图 投影
  stickySig: '', // 泳道常显标题 chips 签名 (lane 集变化才重建)
}

const stage = () => $('#cv-stage')
const svg = () => $('#canvas-svg')

// ---- 泳道派生 (§1.3 定死: flow-node→flow:<名>; ticket→tickets; seat/session→fleet) ----
const laneOf = (n) => n.type === 'flow-node' ? `flow:${n.flow}` : n.type === 'ticket' ? 'tickets' : 'fleet'
const laneTitle = (id) => id.startsWith('flow:') ? id.slice(5) : id === 'tickets' ? '票面 tickets' : 'fleet'
const laneRank = (id) => id.startsWith('flow:') ? [0, id.slice(5)] : id === 'tickets' ? [1, ''] : [2, '']
function laneOrder(ids) {
  return [...ids].sort((a, b) => {
    const [ra, na] = laneRank(a); const [rb, nb] = laneRank(b)
    return ra !== rb ? ra - rb : (na < nb ? -1 : na > nb ? 1 : 0)
  })
}

// ---- 节点盒尺寸 (label + 次行关键态) ----
function nodeSize(n) {
  const sub = nodeSub(n)
  const w1 = 30 + Math.min(String(n.label ?? '').length, 26) * 6.4
  const w2 = 24 + Math.min(sub.length, 30) * 5.6
  const w = clamp(Math.ceil(Math.max(w1, w2)), n.type === 'seat' ? 96 : 110, n.type === 'session' ? 300 : 230)
  const h = n.type === 'ticket' ? 50 : n.type === 'session' ? 38 : n.type === 'seat' ? 32 : 42
  return { w, h }
}
function nodeSub(n) {
  if (n.type === 'flow-node') return `${n.verb ?? '—'} · ${n.state ?? '—'}`
  if (n.type === 'ticket') return `${n.state ?? '—'}${Array.isArray(n.deps) && n.deps.length ? ` · deps ${n.deps.length}` : ''}`
  if (n.type === 'seat') return `${n.role ?? '—'} · ${n.status ?? '—'}`
  return `${n.running ? 'running' : 'idle'}${n.cwd ? ' · ' + String(n.cwd).slice(0, 24) : ''}`
}

// ---- elk 加载 (唯一 vendor 通道: elk.js → elk.bundled.js) ----
async function loadElk() {
  if (C.elk) return C.elk
  try {
    const m = await import('./elk.js') // 失败 → 调用方回退列表视图
    C.elk = new m.ELK()
    return C.elk
  } catch { return null }
}

// 泳道内 layered 布局 (spec §4: 只调 algorithm, 其余默认不调参)
async function layoutLane(lane) {
  const nodes = lane.nodeIds.map((id) => {
    const n = C.nodes.get(id)
    const { w, h } = nodeSize(n)
    return { id, width: w, height: h }
  })
  const inner = [...C.edges.values()].filter((e) =>
    laneOf(C.nodes.get(e.from) || {}) === lane.id && laneOf(C.nodes.get(e.to) || {}) === lane.id)
  const elk = await loadElk()
  if (!elk) throw new Error('elk unavailable')
  const out = await elk.layout({
    id: 'lane', children: nodes,
    edges: inner.map((e) => ({ id: e.id, sources: [e.from], targets: [e.to] })),
  }, { 'elk.algorithm': 'layered' })
  const pos = new Map()
  let w = 0; let h = 0
  for (const c of out.children ?? []) {
    pos.set(c.id, { x: c.x ?? 0, y: c.y ?? 0 })
    w = Math.max(w, (c.x ?? 0) + (c.width ?? 0))
    h = Math.max(h, (c.y ?? 0) + (c.height ?? 0))
  }
  return { pos, w: Math.ceil(w), h: Math.ceil(h), inner: new Set(inner.map((e) => e.id)) }
}

// ---- refetch + diff (§4 item 7: 按 id diff, 只重排受影响泳道) ----
async function refetchGraph() {
  if (C.refetching || C.replay.on) return // PMW2-4: 回放态数据冻结 (只改样式不重排), 游标回 now 自动恢复
  C.refetching = true
  try {
    const res = await fetch('/op/graph')
    const g = await res.json()
    C.lastRefetchAt = Date.now()
    if (!g || g.op !== 'graph') throw new Error('bad /op/graph payload')
    const degradedNote = g.degraded && g.note ? g.note : ''
    // diff: 增/删/字段变更
    const newNodes = new Map(g.nodes.map((n) => [n.id, n]))
    const newEdges = new Map(g.edges.map((e) => [e.id, e]))
    const changedLanes = new Set()
    for (const [id, n] of newNodes) {
      const old = C.nodes.get(id)
      if (!old || JSON.stringify(old) !== JSON.stringify(n)) changedLanes.add(laneOf(n))
    }
    for (const id of C.nodes.keys()) if (!newNodes.has(id)) changedLanes.add(laneOf(C.nodes.get(id)))
    for (const [id, e] of newEdges) {
      const old = C.edges.get(id)
      if (!old || JSON.stringify(old) !== JSON.stringify(e)) { changedLanes.add(laneOf(newNodes.get(e.from) || {})); changedLanes.add(laneOf(newNodes.get(e.to) || {})) }
    }
    for (const id of C.edges.keys()) if (!newEdges.has(id)) { const e = C.edges.get(id); changedLanes.add(laneOf(C.nodes.get(e.from) || {})); changedLanes.add(laneOf(C.nodes.get(e.to) || {})) }
    changedLanes.delete('undefined')

    C.graph = g
    C.nodes = newNodes
    C.edges = newEdges

    if (!C.nodeEls.size || [...C.nodeEls.keys()].some((id) => !newNodes.has(id))) await buildScene(changedLanes)
    else await updateScene(changedLanes)
    renderCounts(degradedNote)
    syncDrawer() // PMW2-3: 抽屉开着时随数据回显 (节点消失则自动关)
  } catch (e) {
    bannerShow(`/op/graph 不可达 —— 保留上一帧渲染 (${String(e?.message ?? e).slice(0, 80)})`, true)
  } finally {
    C.refetching = false
    introspect()
  }
}

// 组泳道: 受影响泳道 elk 重排, 未受影响泳道复用既有局部布局
async function computeLanes(changedLanes) {
  const byLane = new Map()
  for (const n of C.nodes.values()) {
    const l = laneOf(n)
    if (!byLane.has(l)) byLane.set(l, [])
    byLane.get(l).push(n.id)
  }
  const ids = laneOrder(byLane.keys())
  const lanes = []
  let y = 0
  let maxW = 0
  for (const id of ids) {
    const nodeIds = byLane.get(id)
    let local = C.local.get(id)
    let innerSet = null
    if (!local || changedLanes?.has(id)) {
      try {
        const probe = await layoutLane({ id, nodeIds })
        local = probe.pos
        C.local.set(id, local)
        innerSet = probe.inner
      } catch (e) { // elk 加载失败或布局抛错 → 列表回退 (spec §5)
        listFallback(`布局引擎不可用(${String(e?.message ?? e).slice(0, 60)})——已回退列表视图; 下轮事件自动重试 layout`)
        return null
      }
    }
    let w = 0; let h = 0
    for (const nid of nodeIds) {
      const p = local.get(nid)
      if (!p) continue
      const { w: nw, h: nh } = nodeSize(C.nodes.get(nid))
      w = Math.max(w, p.x + nw); h = Math.max(h, p.y + nh)
    }
    const PAD = 24; const HEAD = 34
    const lane = { id, title: laneTitle(id), nodeIds, w: Math.ceil(w) + PAD * 2, h: Math.ceil(h) + HEAD + PAD, x: 0, y, head: HEAD, pad: PAD }
    lanes.push(lane)
    y += lane.h + 48
    maxW = Math.max(maxW, lane.w)
  }
  return { lanes, maxW }
}

async function updateScene(changedLanes) {
  const built = await computeLanes(changedLanes || new Set())
  if (!built) return
  C.lanes = built.lanes
  C.laneIndex = new Map(C.lanes.map((l) => [l.id, l]))
  const pos = new Map()
  for (const lane of C.lanes) {
    const local = C.local.get(lane.id)
    for (const nid of lane.nodeIds) {
      const p = local.get(nid)
      if (p) pos.set(nid, { x: lane.x + lane.pad + p.x, y: lane.y + lane.head + p.y, w: 0, h: 0 })
    }
  }
  for (const n of C.nodes.values()) { const s = nodeSize(n); const p = pos.get(n.id); if (p) { p.w = s.w; p.h = s.h } }
  C.pos = pos
  reconcileDom()
}

// 首帧/成员变化: 全量重建容器, 节点元素仍按 id 持久化
async function buildScene(changedLanes) {
  C.nodeEls.clear(); C.edgeEls.clear(); C.local.clear()
  const built = await computeLanes(changedLanes || new Set())
  if (!built) return
  C.lanes = built.lanes
  C.laneIndex = new Map(C.lanes.map((l) => [l.id, l]))
  const pos = new Map()
  for (const lane of C.lanes) {
    const local = C.local.get(lane.id)
    for (const nid of lane.nodeIds) {
      const p = local.get(nid)
      if (p) pos.set(nid, { x: lane.x + lane.pad + p.x, y: lane.y + lane.head + p.y, w: nodeSize(C.nodes.get(nid)).w, h: nodeSize(C.nodes.get(nid)).h })
    }
  }
  C.pos = pos
  drawScene()
}

// ---- DOM: 场景搭建 (一次) + 调和 (持久节点元素) ----
function drawScene() {
  canvasMode(); C.mode = 'canvas' // 列表回退后 elk 恢复 → 回画布
  const s = svg()
  s.textContent = ''
  const defs = svgEl('defs')
  defs.appendChild(svgEl('marker', { id: 'cv-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }))
    .appendChild(svgEl('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: EDGE_STYLE.dispatch.color }))
  s.appendChild(defs)
  const viewport = svgEl('g', { id: 'cv-viewport' })
  s.appendChild(viewport)
  const gLanes = svgEl('g', { id: 'cv-lanes' })
  for (const lane of C.lanes) {
    const gl = svgEl('g', { 'data-lane': lane.id })
    gl.appendChild(svgEl('rect', { x: lane.x, y: lane.y, width: lane.w, height: lane.h, rx: 12, class: 'cv-lane' }))
    const t = svgEl('text', { x: lane.x + 14, y: lane.y + 21, class: 'cv-lane-title' })
    t.textContent = `${lane.title} · ${lane.nodeIds.length}`
    gl.appendChild(t)
    gLanes.appendChild(gl)
  }
  viewport.appendChild(gLanes)
  const gEdges = svgEl('g', { id: 'cv-edges' })
  for (const e of C.edges.values()) {
    const st = EDGE_STYLE[e.kind] || EDGE_STYLE.dep
    const p = svgEl('path', { class: `cv-edge k-${e.kind}`, d: edgePath(e), fill: 'none', stroke: st.color, 'stroke-width': st.width })
    if (st.dash) p.setAttribute('stroke-dasharray', st.dash)
    if (st.arrow) p.setAttribute('marker-end', 'url(#cv-arrow)')
    C.edgeEls.set(e.id, p)
    gEdges.appendChild(p)
  }
  viewport.appendChild(gEdges)
  const gNodes = svgEl('g', { id: 'cv-nodes' })
  for (const n of C.nodes.values()) {
    const g = nodeEl(n)
    C.nodeEls.set(n.id, g)
    gNodes.appendChild(g)
  }
  viewport.appendChild(gNodes)
  drawMinimap()
  applyView()
  applyHighlight()
  introspect()
}

function reconcileDom() {
  // 泳道容器重画 (少而廉价), 节点/边元素按 id 持久调和 → 位移走 300ms tween
  const gLanes = $('#cv-lanes'); const gEdges = $('#cv-edges'); const gNodes = $('#cv-nodes')
  const viewport = $('#cv-viewport')
  if (!gLanes || !gEdges || !gNodes) return drawScene()
  gLanes.textContent = ''
  for (const lane of C.lanes) {
    const gl = svgEl('g', { 'data-lane': lane.id })
    gl.appendChild(svgEl('rect', { x: lane.x, y: lane.y, width: lane.w, height: lane.h, rx: 12, class: 'cv-lane' }))
    const t = svgEl('text', { x: lane.x + 14, y: lane.y + 21, class: 'cv-lane-title' })
    t.textContent = `${lane.title} · ${lane.nodeIds.length}`
    gl.appendChild(t)
    gLanes.appendChild(gl)
  }
  for (const [id, p] of C.edgeEls) if (!C.edges.has(id)) { p.remove(); C.edgeEls.delete(id) }
  for (const e of C.edges.values()) if (!C.edgeEls.has(e.id)) {
    const st = EDGE_STYLE[e.kind] || EDGE_STYLE.dep
    const p = svgEl('path', { class: `cv-edge k-${e.kind}`, d: edgePath(e), fill: 'none', stroke: st.color, 'stroke-width': st.width })
    if (st.dash) p.setAttribute('stroke-dasharray', st.dash)
    if (st.arrow) p.setAttribute('marker-end', 'url(#cv-arrow)')
    C.edgeEls.set(e.id, p); gEdges.appendChild(p)
  }
  for (const [id, g] of C.nodeEls) if (!C.nodes.has(id)) { g.remove(); C.nodeEls.delete(id); C.pos.delete(id) }
  for (const n of C.nodes.values()) if (!C.nodeEls.has(n.id)) {
    const g = nodeEl(n)
    C.nodeEls.set(n.id, g); gNodes.appendChild(g)
  }
  tweenTo()
  drawMinimap()
  applyHighlight()
  introspect()
}

// ---- 节点形制 (§1.1: verb 定形制 / 状态色环 / 徽章 / 胶囊) ----
function nodeShape(n, w, h) {
  if (n.type === 'ticket') return svgEl('rect', { x: 1.5, y: 1.5, width: w - 3, height: h - 3, rx: 7, class: 'cv-node-body', stroke: colorOf(n.state) })
  if (n.type === 'seat') return svgEl('rect', { x: 1.5, y: 1.5, width: w - 3, height: h - 3, rx: h / 2 - 1.5, class: 'cv-node-body', stroke: colorOf(n.status) })
  if (n.type === 'session') return svgEl('rect', { x: 1.5, y: 1.5, width: w - 3, height: h - 3, rx: h / 2 - 1.5, class: n.running ? 'cv-node-body cv-solid' : 'cv-node-body', stroke: n.running ? '#3fbf7f' : '#7f8da0' })
  const verb = n.verb || ''
  if (verb === 'dispatch') { // 平行四边形
    const k = 12
    return svgEl('path', { d: `M ${k} 1.5 L ${w - 1.5} 1.5 L ${w - k} ${h - 1.5} L 1.5 ${h - 1.5} Z`, class: 'cv-node-body', stroke: '#4da3ff' })
  }
  if (verb === 'callback') return svgEl('rect', { x: 1.5, y: 1.5, width: w - 3, height: h - 3, rx: 14, class: 'cv-node-body', stroke: '#9d7cd8' })
  if (verb === 'rollup') { // 六边形
    const k = 11
    return svgEl('path', { d: `M ${k} 1.5 L ${w - k} 1.5 L ${w - 1.5} ${h / 2} L ${w - k} ${h - 1.5} L ${k} ${h - 1.5} L 1.5 ${h / 2} Z`, class: 'cv-node-body', stroke: '#e0a93e' })
  }
  return svgEl('rect', { x: 1.5, y: 1.5, width: w - 3, height: h - 3, rx: 3, class: 'cv-node-body', stroke: colorOf(n.state) })
}

function nodeEl(n) {
  const p = C.pos.get(n.id) || { x: 0, y: 0, w: 120, h: 40 }
  const g = svgEl('g', { class: `cv-node t-${n.type}`, 'data-id': n.id })
  g.appendChild(nodeShape(n, p.w, p.h))
  const yLabel = p.h <= 34 ? 13 : 17
  const ySub = p.h <= 34 ? 26 : (n.type === 'ticket' || n.type === 'session' ? 33 : 31)
  const label = svgEl('text', { x: p.w / 2, y: yLabel, class: 'cv-label' })
  label.textContent = String(n.label ?? n.id).slice(0, 30)
  g.appendChild(label)
  const sub = svgEl('text', { x: p.w / 2, y: ySub, class: 'cv-sub' })
  sub.textContent = nodeSub(n).slice(0, 32)
  g.appendChild(sub)
  g.style.transform = `translate(${p.x}px, ${p.y}px)`
  return g
}

// ---- 边几何: 右出左入 bezier; 反向时换侧 ----
function edgePath(e) {
  const a = C.pos.get(e.from); const b = C.pos.get(e.to)
  if (!a || !b) return ''
  let sx; let sy; let tx; let ty
  if (b.x >= a.x) { sx = a.x + a.w; sy = a.y + a.h / 2; tx = b.x; ty = b.y + b.h / 2 } else { sx = a.x; sy = a.y + a.h / 2; tx = b.x + b.w; ty = b.y + b.h / 2 }
  const dx = Math.max(46, Math.abs(tx - sx) / 2)
  const dir = tx >= sx ? 1 : -1
  return `M ${sx} ${sy} C ${sx + dx * dir} ${sy}, ${tx - dx * dir} ${ty}, ${tx} ${ty}`
}

// ---- 300ms 位移过渡 (节点 + 边同步重算, spec §4 item 7) ----
function tweenTo(ms = 300) {
  cancelAnimationFrame(C.tweenRaf)
  const starts = new Map()
  for (const [id, g] of C.nodeEls) {
    const to = C.pos.get(id)
    if (!to) continue
    const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(g.style.transform || '')
    const from = m ? { x: +m[1], y: +m[2] } : to
    starts.set(id, { from, to, g })
  }
  const edgeStarts = [...C.edgeEls].map(([id, p]) => ({ id, p, d: p.getAttribute('d') || '' }))
  if (!edgeStarts.length && ![...starts.values()].some((s) => s.from.x !== s.to.x || s.from.y !== s.to.y)) return
  const t0 = performance.now()
  const ease = (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
  const savedPos = new Map(C.pos)
  const step = (now) => {
    const k = ms <= 0 ? 1 : ease(clamp((now - t0) / ms, 0, 1))
    for (const { from, to, g } of starts.values()) {
      const x = from.x + (to.x - from.x) * k
      const y = from.y + (to.y - from.y) * k
      g.style.transform = `translate(${x}px, ${y}px)`
    }
    // 边按当前动画位置重算端点: 位移期间以插值后的实际盒位置为准
    for (const e of C.edges.values()) {
      const p = C.edgeEls.get(e.id)
      if (!p) continue
      const a = animatedBox(e.from, starts, k, savedPos); const b = animatedBox(e.to, starts, k, savedPos)
      if (!a || !b) continue
      let sx; let sy; let tx; let ty
      if (b.x >= a.x) { sx = a.x + a.w; sy = a.y + a.h / 2; tx = b.x; ty = b.y + b.h / 2 } else { sx = a.x; sy = a.y + a.h / 2; tx = b.x + b.w; ty = b.y + b.h / 2 }
      const dx = Math.max(46, Math.abs(tx - sx) / 2)
      const dir = tx >= sx ? 1 : -1
      p.setAttribute('d', `M ${sx} ${sy} C ${sx + dx * dir} ${sy}, ${tx - dx * dir} ${ty}, ${tx} ${ty}`)
    }
    if (k < 1) C.tweenRaf = requestAnimationFrame(step)
  }
  C.tweenRaf = requestAnimationFrame(step)
}
function animatedBox(id, starts, k, savedPos) {
  const s = starts.get(id)
  const base = savedPos.get(id)
  if (!base) return null
  if (!s) return base
  return { x: s.from.x + (s.to.x - s.from.x) * k, y: s.from.y + (s.to.y - s.from.y) * k, w: base.w, h: base.h }
}

// ---- 高亮: hover 瞬时 / 点击钉住; 相关节点亮, 其余淡出 30% ----
function adjacent(id) {
  const nodes = new Set([id]); const edges = new Set()
  for (const e of C.edges.values()) {
    if (e.from === id || e.to === id) { edges.add(e.id); nodes.add(e.from); nodes.add(e.to) }
  }
  return { nodes, edges }
}
function applyHighlight() {
  const active = C.selected || C.hover
  const lit = active ? adjacent(active) : null
  for (const [id, g] of C.nodeEls) g.classList.toggle('cv-dim', !!lit && !lit.nodes.has(id))
  for (const [id, p] of C.edgeEls) {
    p.classList.toggle('cv-dim', !!lit && !lit.edges.has(id))
    p.classList.toggle('cv-lit', !!lit && lit.edges.has(id))
  }
}

// ---- 视口: wheel 缩放 (指针锚, 0.5×–2×) + 空白拖拽平移 ----
function applyView() {
  $('#cv-viewport')?.setAttribute('transform', `translate(${C.view.x} ${C.view.y}) scale(${C.view.s})`)
  updateMiniVp()
  updateSticky()
  introspect()
}
function fitView() {
  const st = stage(); if (!st || st.clientWidth < 40) return // 隐藏 tab 时延到可见
  const world = C.lanes.reduce((a, l) => ({ w: Math.max(a.w, l.w), h: l.y + l.h }), { w: 0, h: 0 })
  if (!world.w) return
  const s = clamp(Math.min((st.clientWidth - 32) / world.w, (st.clientHeight - 32) / world.h), 0.5, 2)
  C.view = { s, x: (st.clientWidth - world.w * s) / 2, y: 12 }
  applyView()
}
function wireStage() {
  const st = stage()
  const s = svg()
  s.addEventListener('wheel', (e) => {
    e.preventDefault()
    const rect = s.getBoundingClientRect()
    const px = e.clientX - rect.left; const py = e.clientY - rect.top
    const s2 = clamp(C.view.s * Math.exp(-e.deltaY * 0.0015), 0.5, 2)
    C.view.x = px - (px - C.view.x) * (s2 / C.view.s)
    C.view.y = py - (py - C.view.y) * (s2 / C.view.s)
    C.view.s = s2
    applyView()
  }, { passive: false })
  let pan = null
  s.addEventListener('pointerdown', (e) => {
    const nodeG = e.target.closest?.('.cv-node')
    if (nodeG) { pan = { node: nodeG.dataset.id, x0: e.clientX, y0: e.clientY, moved: false }; return }
    pan = { node: null, x0: e.clientX, y0: e.clientY, vx0: C.view.x, vy0: C.view.y, moved: false }
    st.classList.add('cv-panning')
    try { s.setPointerCapture?.(e.pointerId) } catch {} // 合成/已失效 pointerId 抛 NotFoundError —— capture 只是锦上添花
  })
  s.addEventListener('pointermove', (e) => {
    if (!pan) return
    const dx = e.clientX - pan.x0; const dy = e.clientY - pan.y0
    if (Math.abs(dx) + Math.abs(dy) > 4) pan.moved = true
    if (pan.node) return // 节点上的按下只为点击判定 (MVP 禁节点拖动改布局)
    C.view.x = pan.vx0 + dx; C.view.y = pan.vy0 + dy
    applyView()
  })
  const up = (e) => {
    if (!pan) return
    st.classList.remove('cv-panning')
    if (pan.node && !pan.moved) { // 点击选中/取消 + PMW2-3: 选中即开抽屉, 取消即关
      const next = C.selected === pan.node ? null : pan.node
      C.selected = next
      applyHighlight()
      next ? openDrawer(next) : closeDrawer()
    } else if (!pan.node && !pan.moved) { C.selected = null; applyHighlight(); closeDrawer() } // 空白点击取消
    pan = null
  }
  s.addEventListener('pointerup', up)
  s.addEventListener('pointercancel', () => { pan = null; st.classList.remove('cv-panning') })
  // PMW2-4 打磨: 双击节点居中+适配 (收尾态: 选中+抽屉开)
  s.addEventListener('dblclick', (e) => {
    const nodeG = e.target.closest?.('.cv-node')
    if (!nodeG) return
    const id = nodeG.dataset.id
    const p = C.pos.get(id)
    if (!p) return
    const s2 = clamp(Math.max(C.view.s, 1.4), 0.5, 2)
    C.view = { s: s2, x: st.clientWidth / 2 - (p.x + p.w / 2) * s2, y: st.clientHeight / 2 - (p.y + p.h / 2) * s2 }
    C.selected = id
    applyHighlight()
    openDrawer(id)
    applyView()
  })
  s.addEventListener('mouseover', (e) => {
    const nodeG = e.target.closest?.('.cv-node')
    if (nodeG) { C.hover = nodeG.dataset.id; applyHighlight() }
  })
  s.addEventListener('mouseout', (e) => {
    if (e.target.closest?.('.cv-node')) { C.hover = null; applyHighlight() }
  })
}

// ---- PMW2-4: minimap (全图缩略 + 视口框, 点跳/拖动, 与缩放平移联动) ----
function drawMinimap() {
  const svg = $('#minimap-svg')
  if (!svg) return
  const world = C.lanes.reduce((a, l) => ({ w: Math.max(a.w, l.w), h: Math.max(a.h, l.y + l.h) }), { w: 0, h: 0 })
  if (!world.w) { svg.textContent = ''; return }
  const k = Math.min(172 / world.w, 132 / world.h)
  const ox = 4; const oy = 4
  C.mini = { k, ox, oy }
  const g = C.graph
  const lanes = C.lanes.map((l) => `<rect x="${(l.x * k + ox).toFixed(1)}" y="${(l.y * k + oy).toFixed(1)}" width="${(l.w * k).toFixed(1)}" height="${(l.h * k).toFixed(1)}" rx="2" class="mm-lane"/>`).join('')
  const dots = [...C.pos.entries()].map(([id, p]) => {
    const n = C.nodes.get(id)
    return `<circle cx="${(p.x * k + ox).toFixed(1)}" cy="${(p.y * k + oy).toFixed(1)}" r="1.8" fill="${colorOf(n?.state ?? n?.status)}"/>`
  }).join('')
  svg.innerHTML = `${lanes}<g id="mm-dots">${dots}</g><rect id="mm-vp" class="mm-vp"/>`
  updateMiniVp()
}
function updateMiniVp() {
  const vp = $('#mm-vp')
  const st = stage()
  if (!vp || !st || !st.clientWidth) return
  const { k, ox, oy } = C.mini
  const wx = -C.view.x / C.view.s; const wy = -C.view.y / C.view.s
  const ww = st.clientWidth / C.view.s; const wh = st.clientHeight / C.view.s
  vp.setAttribute('x', (wx * k + ox).toFixed(1))
  vp.setAttribute('y', (wy * k + oy).toFixed(1))
  vp.setAttribute('width', (ww * k).toFixed(1))
  vp.setAttribute('height', (wh * k).toFixed(1))
}
function wireMinimap() {
  const box = $('#cv-minimap')
  const toWorld = (e) => {
    const r = box.getBoundingClientRect()
    const { k, ox, oy } = C.mini
    return { x: (e.clientX - r.left - ox) / k, y: (e.clientY - r.top - oy) / k }
  }
  const jump = (e) => {
    const w = toWorld(e)
    const st = stage()
    C.view.x = st.clientWidth / 2 - w.x * C.view.s
    C.view.y = st.clientHeight / 2 - w.y * C.view.s
    applyView()
  }
  box.addEventListener('pointerdown', (e) => { e.preventDefault(); jump(e); try { box.setPointerCapture?.(e.pointerId) } catch {} ; box.dataset.drag = '1' })
  box.addEventListener('pointermove', (e) => { if (box.dataset.drag) jump(e) })
  const drop = () => { delete box.dataset.drag }
  box.addEventListener('pointerup', drop)
  box.addEventListener('pointercancel', drop)
}

// ---- PMW2-4: flow 泳道标题常显 (header 滚出视口顶 → 顶部 sticky chip) ----
function updateSticky() {
  const st = stage()
  const wrap = $('#cv-sticky')
  if (!st || !wrap || !C.lanes.length) return
  const sig = C.lanes.map((l) => `${l.id}:${l.nodeIds.length}`).join('|')
  if (sig !== C.stickySig) {
    C.stickySig = sig
    wrap.textContent = ''
    for (const lane of C.lanes) {
      const chip = document.createElement('span')
      chip.className = 'cv-sticky-chip'
      chip.dataset.lane = lane.id
      chip.textContent = `${lane.title} · ${lane.nodeIds.length}`
      wrap.appendChild(chip)
    }
  }
  let visible = 0
  for (const lane of C.lanes) {
    const chip = wrap.querySelector(`[data-lane="${CSS.escape(lane.id)}"]`)
    if (!chip) continue
    const hy = lane.y * C.view.s + C.view.y
    const by = (lane.y + lane.h) * C.view.s + C.view.y
    const lx = lane.x * C.view.s + C.view.x
    const rx = (lane.x + lane.w) * C.view.s + C.view.x
    const show = hy < 6 && by > 34 && rx > 340 && lx < st.clientWidth // 340 = 抽屉/时间轴侧让位
    chip.style.display = show ? 'inline-flex' : 'none'
    if (show) { visible++; chip.style.left = `${clamp(lx, 6, Math.max(6, st.clientWidth - 160))}px` }
  }
  introspect()
}

// ---- PMW2-4: trace 时间轴回放 (数据源既有 /op/trace, 服务端零改动) ----
// 语义: 拉全部图上会话的 trace 事件流 → 按 time 升序 → 游标前的命中事件激活
// 节点 (session 自身/同席席位/文本提及的 ticket·flow-node), 两端激活的边才亮,
// 其余 cv-future 淡出 —— 回放只切样式, 零重排; 游标到 now → 切回实况 (SSE)。
async function loadReplay() {
  const R = C.replay
  if (R.loading || R.loaded) return
  R.loading = true
  const btn = $('#cv-tl-load')
  btn.disabled = true
  btn.textContent = '载入中…'
  const sids = [...new Set([...C.nodes.values()].filter((n) => n.type === 'session').map((n) => n.sessionId).filter(Boolean))]
  try {
    const parts = await Promise.all(sids.map(async (sid) => {
      try {
        const res = await fetch(`/op/trace?sessionId=${encodeURIComponent(sid)}`)
        const j = await res.json()
        // PMW2-H: 活体 trace 的 time 是字符串 ("1788172761057") — 必须数值化,
        // 否则拖拽 R.min+(R.max-R.min)*v/1000 变字符串拼接 → 游标垃圾 → 全灰。
        return (j?.entries ?? []).map((e) => ({ ...e, _sid: sid, _ts: Number(e.time ?? e.time0) || null }))
      } catch { return [] }
    }))
    R.events = parts.flat().sort((a, b) => (a._ts ?? Infinity) - (b._ts ?? Infinity))
    buildReplayHits(R.events)
    R.min = R.events.find((e) => e._ts != null)?._ts ?? Date.now() - 60_000
  } catch (e) { // 载入失败: 按钮复位可重试, 不吞 ctrl (载入中态只属于进行中的载入)
    R.loading = false
    btn.disabled = false
    btn.textContent = '载入回放'
    toast(`回放载入失败: ${String(e?.message ?? e).slice(0, 80)}`)
    return
  }
  R.max = Date.now()
  R.cursor = R.max
  R.loaded = true
  R.loading = false
  btn.hidden = true
  $('#cv-tl-ctrl').hidden = false
  $('#cv-tl-range').value = '1000'
  updateTimeLabel()
  toast(`回放流就绪: ${R.events.length} 事件 / ${sids.length} 会话`)
  introspect()
}
function buildReplayHits(events) { // 事件 → 图节点命中 (一次性预计算; 回放态只查表)
  const seats = [...C.nodes.values()].filter((n) => n.type === 'seat')
  const tks = [...C.nodes.values()].filter((n) => n.type === 'ticket' && n.label)
  const fns = [...C.nodes.values()].filter((n) => n.type === 'flow-node' && n.label)
  for (const e of events) {
    const hits = new Set([`se:${e._sid}`])
    for (const s of seats) if (s.sessionId === e._sid) hits.add(s.id)
    const raw = JSON.stringify(e.data ?? e).toLowerCase()
    for (const t of tks) if (raw.includes(String(t.label).toLowerCase())) hits.add(t.id)
    for (const f of fns) if (raw.includes(String(f.label).toLowerCase())) hits.add(f.id)
    e._hits = [...hits]
  }
}
function replayActiveSet(upto) {
  const s = new Set()
  for (const e of C.replay.events) {
    if (e._ts != null && e._ts <= upto) for (const id of e._hits) s.add(id)
  }
  return s
}
function applyReplay() {
  const active = replayActiveSet(C.replay.cursor)
  for (const [id, g] of C.nodeEls) g.classList.toggle('cv-future', !active.has(id))
  for (const e of C.edges.values()) {
    const p = C.edgeEls.get(e.id)
    if (p) p.classList.toggle('cv-future', !(active.has(e.from) && active.has(e.to)))
  }
}
function setReplayCursor(ms) {
  const R = C.replay
  R.cursor = clamp(ms, R.min, R.max)
  $('#cv-tl-range').value = String(Math.round(((R.cursor - R.min) / Math.max(1, R.max - R.min)) * 1000))
  if (R.max - R.cursor <= 1500) return exitReplay() // 游标=now → 切回实况
  if (!R.on) {
    R.on = true
    const mode = $('#cv-tl-mode')
    mode.textContent = '回放中'
    mode.classList.add('warn')
  }
  applyReplay()
  updateTimeLabel()
  introspect()
}
function exitReplay() {
  const R = C.replay
  R.on = false
  R.playing = false
  cancelAnimationFrame(R.raf)
  for (const [, g] of C.nodeEls) g.classList.remove('cv-future')
  for (const [, p] of C.edgeEls) p.classList.remove('cv-future')
  const mode = $('#cv-tl-mode')
  if (mode) { mode.textContent = '实况'; mode.classList.remove('warn') }
  const play = $('#cv-tl-play')
  if (play) play.textContent = '▶'
  R.cursor = R.max
  const range = $('#cv-tl-range')
  if (range) range.value = '1000'
  updateTimeLabel()
  introspect()
  refetchGraph() // 回实况: 立即对齐当前数据面
}
function tlPlayToggle() {
  const R = C.replay
  if (R.playing) {
    R.playing = false
    cancelAnimationFrame(R.raf)
    $('#cv-tl-play').textContent = '▶'
    introspect()
    return
  }
  if (R.max - R.cursor <= 1500) R.cursor = R.min - 1 // 从头播
  R.playing = true
  $('#cv-tl-play').textContent = '⏸'
  let last = performance.now()
  const step = (now) => {
    if (!R.playing) return
    setReplayCursor(R.cursor + (now - last) * R.speed)
    last = now
    if (R.playing && R.on) R.raf = requestAnimationFrame(step)
  }
  R.raf = requestAnimationFrame(step)
}
function updateTimeLabel() {
  const R = C.replay
  const el = $('#cv-tl-time')
  if (!el) return
  const past = R.events.filter((e) => e._ts != null && e._ts <= R.cursor).length
  el.textContent = `${new Date(R.cursor).toLocaleTimeString()} · 事件 ${past}/${R.events.length}`
}
function wireTimeline() {
  $('#cv-tl-load').addEventListener('click', loadReplay)
  $('#cv-tl-play').addEventListener('click', tlPlayToggle)
  $('#cv-tl-speed').addEventListener('change', (e) => { C.replay.speed = Number(e.target.value) || 1; introspect() })
  $('#cv-tl-range').addEventListener('input', (e) => {
    const R = C.replay
    setReplayCursor(R.min + ((R.max - R.min) * Number(e.target.value)) / 1000)
  })
  // D1 (PMW2-F, spec §4-12): 回放态 ESC = 游标跳 now + 切回实况; 非回放态不抢
  // ESC (确认门 dialog 原生关闭等既有语义原样)。
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !C.replay.on) return
    if ($('#cv-act-confirm')?.open) return // dialog 在场: ESC 归原生关闭
    exitReplay()
  })
}

// ---- PMW2-3: 节点抽屉 (四型明细) + 过门 act ----
const hist = (nodeId) => {
  if (!C.actHist.has(nodeId)) C.actHist.set(nodeId, [])
  return C.actHist.get(nodeId)
}
const fieldRow = (k, v) => `<div class="cv-frow"><span class="cv-fkey">${esc(k)}</span><span class="cv-fval">${v}</span></div>`
const stateBadge = (s) => s == null ? '<span class="dim">—</span>' : `<span class="cv-badge" style="--st:${colorOf(s)}">${esc(s)}</span>`
const jumpChip = (id, label) => C.nodes.has(id)
  ? `<button class="cv-chip cv-jump" data-jump="${esc(id)}" title="${esc(id)}">${esc(label ?? id)}</button>`
  : `<span class="cv-chip dim">${esc(label ?? id)}</span>`
const looksPath = (r) => /^\/|^\.\//.test(r) || (r.includes('/') && !/\s/.test(r))
const refChip = (r) => looksPath(r)
  ? `<button class="cv-chip cv-ref" data-ref="${esc(r)}" title="点击复制路径">${esc(r)}</button>`
  : `<span class="cv-chip" title="${esc(r)}">${esc(r)}</span>`
const verbShape = (v) => VERB_SHAPE[v] ?? '六边形'

function relatedTickets(fn) { // 经席位桥: dispatch(st→fn) 的席位 ∩ lease(dispatch st→tk) 的票
  const seats = new Set([...C.edges.values()].filter((e) => e.kind === 'dispatch' && e.to === fn.id).map((e) => e.from))
  if (!seats.size) return []
  return [...C.nodes.values()].filter((n) => n.type === 'ticket'
    && [...C.edges.values()].some((e) => e.kind === 'dispatch' && seats.has(e.from) && e.to === n.id))
}

function drawerBodyHtml(n) {
  if (n.type === 'flow-node') {
    const rel = relatedTickets(n)
    return `
      ${fieldRow('verb / 形制', `${esc(n.verb ?? '—')} · ${esc(verbShape(n.verb))}`)}
      ${fieldRow('state', stateBadge(n.state))}
      ${fieldRow('所属 flow', `<span class="mono">${esc(n.flow)}</span>`)}
      ${fieldRow('attempts / events', `${n.attempts ?? 0} / ${n.events ?? 0}`)}
      ${fieldRow('关联票', rel.length ? rel.map((t) => jumpChip(t.id, t.ticketId)).join(' ') : '<span class="dim">无 (席位 lease/dispatch 桥未关联)</span>')}
      <div class="cv-acts">
        <h5>快捷动作 <span class="dim">flowc advance · POST /op/act</span></h5>
        <button class="cv-act-btn" data-act="flow:done">--result done</button>
        <button class="cv-act-btn warn" data-act="flow:failed">--result failed</button>
      </div>`
  }
  if (n.type === 'ticket') {
    const legal = TICKET_TRANSITIONS[n.state] ?? null
    const legalHtml = legal == null ? '<span class="dim">未知状态</span>'
      : legal.length === 0 ? '<span class="dim">终态 · 无可用转移</span>'
        : legal.map((s) => `<button class="cv-act-btn${IRREV.has(s) ? ' warn' : ''}" data-act="ticket:${esc(s)}">${esc(s)}${IRREV.has(s) ? ' ⚠' : ''}</button>`).join('')
    return `
      ${fieldRow('state', stateBadge(n.state))}
      ${fieldRow('leaseOwner', esc(n.leaseOwner ?? '—'))}
      ${fieldRow('deps', (n.deps ?? []).length ? n.deps.map((d) => jumpChip(`tk:${d}`, d)).join(' ') : '<span class="dim">无</span>')}
      ${fieldRow('refs 证据链', (n.refs ?? []).length ? n.refs.map((r) => refChip(r)).join(' ') : '<span class="dim">无</span>')}
      <div class="cv-acts">
        <h5>合法转移 <span class="dim">ledger ticket state · POST /op/act</span></h5>
        <div class="cv-act-row">${legalHtml}</div>
        <p class="dim small">⚠ 不可逆转移需二次确认 (勾选)</p>
      </div>`
  }
  if (n.type === 'seat') {
    const ses = n.sessionId ? [...C.nodes.values()].find((m) => m.type === 'session' && m.sessionId === n.sessionId) : null
    return `
      ${fieldRow('role / node', `${esc(n.role ?? '—')} / ${esc(n.node ?? '—')}`)}
      ${fieldRow('preset / status', `${esc(n.preset ?? '—')} · ${stateBadge(n.status)}`)}
      ${fieldRow('会话态 join', ses
        ? `${jumpChip(ses.id, ses.label)} <span class="dim small">${ses.running ? 'running' : 'idle'}${ses.cwd ? ' · ' + esc(ses.cwd) : ''}</span>`
        : `<span class="mono small dim">${esc(n.sessionId ?? '—')}</span>`)}
      <p class="dim small">席位无快捷动作 (动作面仅 flow-node / ticket 两类)</p>`
  }
  const seats = [...C.nodes.values()].filter((m) => m.type === 'seat' && m.sessionId === n.sessionId)
  return `
    ${fieldRow('running', String(!!n.running))}
    ${fieldRow('title', `<span class="small">${esc(n.title ?? '—')}</span>`)}
    ${fieldRow('cwd', `<span class="mono small">${esc(n.cwd ?? '—')}</span>`)}
    ${fieldRow('挂靠席位', seats.length ? seats.map((s) => jumpChip(s.id, s.code)).join(' ') : '<span class="dim">无</span>')}
    <p class="dim small">会话无快捷动作 (动作面仅 flow-node / ticket 两类)</p>`
}

function renderDrawer() {
  const n = C.drawerNode && C.nodes.get(C.drawerNode)
  if (!n) return
  const kind = $('#cv-drawer-kind')
  kind.textContent = n.type
  kind.style.setProperty('--st', colorOf(n.state ?? n.status))
  $('#cv-drawer-title').textContent = n.label ?? n.id
  $('#cv-drawer-body').innerHTML = drawerBodyHtml(n)
  const h = hist(n.id)
  $('#cv-drawer-hist').innerHTML = h.length ? h.map((e) => `
    <li class="cv-hist-item">
      <div class="cv-hist-head"><span class="mono">${esc(e.ref)}</span> ${stateBadge(e.status)} <span class="dim small">${new Date(e.ts).toLocaleTimeString()}</span></div>
      <div class="mono small">${esc(e.action)}</div>
      ${e.err ? `<div class="small cv-hist-err">${esc(String(e.err).slice(0, 160))}</div>` : ''}
      ${e.exitCode != null ? `<div class="dim small">exit ${e.exitCode}${e.ms != null ? ` · ${e.ms}ms` : ''}</div>` : ''}
    </li>`).join('') : '<li class="dim small">本节点尚无动作历史</li>'
}
function openDrawer(id) {
  if (!C.nodes.has(id)) return
  C.drawerNode = id
  renderDrawer()
  $('#cv-drawer').hidden = false
  introspect()
}
function closeDrawer() {
  C.drawerNode = null
  const d = $('#cv-drawer')
  if (d) d.hidden = true
  introspect()
}
function syncDrawer() { // refetch 后回显: 节点仍在 → 重绘; 消失 → 关
  if (!C.drawerNode) return
  if (!C.nodes.has(C.drawerNode)) return closeDrawer()
  renderDrawer()
}

// ---- 确认门: 动作全文 + 影响节点; 不可逆类 checkbox 双确认 ----
function askAct(node, cmd) {
  const dlg = $('#cv-act-confirm')
  $('#cv-act-cmd').textContent = argvText(cmd.tool, cmd.args)
  $('#cv-act-target').textContent = `${node.id} · ${node.label ?? ''} · ${node.type}`
  $('#cv-act-irrev').hidden = !cmd.irrev
  $('#cv-act-ok').disabled = !!cmd.irrev // 双确认: 勾选后才可点确认
  dlg._job = { node, cmd }
  dlg.showModal()
}

function wireDrawer() {
  $('#cv-drawer-close').addEventListener('click', closeDrawer)
  const body = $('#cv-drawer-body')
  body.addEventListener('click', (e) => {
    const j = e.target.closest?.('[data-jump]')
    if (j) { C.selected = j.dataset.jump; applyHighlight(); openDrawer(j.dataset.jump); return }
    const r = e.target.closest?.('[data-ref]')
    if (r) return void copyText(r.dataset.ref)
    const a = e.target.closest?.('[data-act]')
    if (!a) return
    const n = C.nodes.get(C.drawerNode)
    if (!n) return
    const [kind, val] = String(a.dataset.act).split(':')
    const cmd = kind === 'flow'
      ? { ...actCmdFor['flow-node'](n, val), irrev: false }
      : { ...actCmdFor.ticket(n, val), irrev: IRREV.has(val) }
    askAct(n, cmd)
  })
  const dlg = $('#cv-act-confirm')
  const chk = $('#cv-act-irrev-chk')
  chk.addEventListener('change', () => { $('#cv-act-ok').disabled = !chk.checked })
  $('#cv-act-cancel').addEventListener('click', () => dlg.close('cancel'))
  $('#cv-act-ok').addEventListener('click', () => dlg.close('ok'))
  dlg.addEventListener('close', () => {
    const job = dlg._job
    dlg._job = null
    chk.checked = false
    $('#cv-act-ok').disabled = false
    if (!job) return
    if (dlg.returnValue !== 'ok') { toast('已取消 —— 未提交任何动作'); return }
    submitAct(job.node, job.cmd)
  })
}

// ---- act 提交 + 双路对账 (SSE act 事件快路径, GET /op/act?ref 轮询兜底仲裁) ----
async function submitAct(node, cmd) {
  const entry = { ts: Date.now(), ref: '—', action: argvText(cmd.tool, cmd.args), status: 'flying', exitCode: null, ms: null, err: null }
  hist(node.id).push(entry)
  renderDrawer()
  try {
    const res = await fetch('/op/act', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: cmd.tool, args: cmd.args }),
    })
    const d = await res.json().catch(() => null)
    if (!res.ok || !d?.accepted) {
      entry.status = 'error'
      entry.ref = d?.ref ?? '—'
      entry.err = d?.error ?? `http ${res.status}`
      toast(`提交被拒: ${entry.err}`)
    } else {
      entry.ref = d.ref
      if (d.replay) { entry.status = d.status ?? 'ok'; entry.exitCode = d.exitCode ?? null; entry.err = d.error ?? null }
      else pollAct(d.ref, node.id, entry)
    }
  } catch (e) {
    entry.status = 'error'
    entry.err = String(e?.message ?? e)
    toast(`提交失败: ${entry.err}`)
  }
  renderDrawer()
}
function pollAct(ref, nodeId, entry) {
  C.pending.set(ref, { nodeId, entry, timer: 0 })
  let tries = 0
  const tick = async () => {
    const p = C.pending.get(ref)
    if (!p) return // SSE 路径已 settle
    if (++tries > 40) { // ~32s 兜底超时 (服务端 CLI 预算 30s)
      C.pending.delete(ref)
      p.entry.status = 'error'
      p.entry.err = '轮询超时 —— 待 SSE act 事件对账'
      renderDrawer()
      return
    }
    try {
      const res = await fetch(`/op/act?ref=${encodeURIComponent(ref)}`)
      const j = await res.json()
      if (j?.found && j.entry && j.entry.status !== 'flying') return settleAct(ref, j.entry)
    } catch {}
    p.timer = setTimeout(tick, 800)
  }
  tick()
}
function settleAct(ref, src) {
  const p = C.pending.get(ref)
  if (!p) return
  clearTimeout(p.timer)
  C.pending.delete(ref)
  p.entry.status = src.status ?? 'ok'
  p.entry.exitCode = src.exitCode ?? null
  p.entry.ms = src.ms ?? null
  p.entry.err = src.error ?? src.err ?? null
  renderDrawer()
  scheduleActRefresh()
  toast(`act ${ref} → ${p.entry.status}`)
}
function scheduleActRefresh() { // SSE 在: 让数据面事件先行, 3s 未刷则直刷兜底; SSE 断: act 响应直刷
  const at = C.lastRefetchAt
  setTimeout(() => { if (C.lastRefetchAt === at && !C.refetching) refetchGraph() }, C.sseOpen ? 3000 : 0)
}

let toastTimer = 0
function toast(msg) {
  const t = $('#cv-toast')
  if (!t) return
  t.textContent = msg
  t.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { t.hidden = true }, 2600)
}
async function copyText(txt) {
  try { await navigator.clipboard.writeText(txt); toast(`已复制: ${txt}`) } catch { toast(`evidence: ${txt}`) }
}

// ---- 列表回退 (spec §5: nodes/edges 清单 + counts, 按泳道分组, 横幅注明) ----
function listFallback(reason) {
  C.mode = 'list'
  $('#cv-svg-wrap').hidden = true
  const list = $('#cv-list')
  list.hidden = false
  bannerShow(reason, true)
  const g = C.graph
  if (!g) { list.innerHTML = '<p class="cv-note">/op/graph 未取得 —— 服务不可达或尚未就绪。</p>'; introspect(); return }
  const byLane = new Map()
  for (const n of g.nodes) {
    const l = laneOf(n)
    if (!byLane.has(l)) byLane.set(l, [])
    byLane.get(l).push(n)
  }
  const rows = laneOrder(byLane.keys()).map((l) => `
    <div class="cv-lane-block">
      <h4>${esc(laneTitle(l))} <span class="dim">· ${byLane.get(l).length}</span></h4>
      <ul>${byLane.get(l).map((n) => `<li><span class="mono">${esc(n.id)}</span> <span class="dim">${esc(nodeSub(n))}</span></li>`).join('')}</ul>
    </div>`).join('')
  const edgeRows = g.edges.map((e) => `<li><span class="mono">${esc(e.id)}</span> <span class="dim">${esc(e.kind)}${e.at ? ' · ' + esc(e.at) : ''}</span></li>`).join('')
  list.innerHTML = `
    <div class="cv-list-cols">
      <div><h3 class="dim">nodes (${g.nodes.length})</h3>${rows}</div>
      <div><h3 class="dim">edges (${g.edges.length})</h3><ul class="cv-edge-list">${edgeRows}</ul></div>
    </div>`
  introspect()
}

function canvasMode() {
  if (C.mode !== 'list') return
  C.mode = 'canvas'
  $('#cv-svg-wrap').hidden = false
  $('#cv-list').hidden = true
}

// ---- 横幅 / 计数条 ----
function bannerShow(msg, warn) {
  const b = $('#cv-banner')
  b.hidden = false
  b.textContent = `⚠ ${msg}`
  b.className = warn ? 'cv-banner warn' : 'cv-banner'
}
function bannerClearIf(reasonPrefix) {
  const b = $('#cv-banner')
  if (!b.hidden && String(b.textContent).includes(reasonPrefix)) b.hidden = true
}
function renderCounts(degradedNote) {
  const g = C.graph
  const c = g?.counts
  $('#cv-counts').textContent = g
    ? `${c.nodes} 节点 · ${c.edges} 边 · dep ${c.byKind.dep} / dispatch ${c.byKind.dispatch} / callback ${c.byKind.callback} / cb-send ${c.byKind['cb-send']} · 泳道 ${C.lanes.length} · ${C.mode === 'canvas' ? 'SVG' : '列表回退'}`
    : '加载中…'
  if (degradedNote) bannerShow(`graph 降级: ${degradedNote}`, true)
  else bannerClearIf('graph 降级')
  if (C.sseOpen === false) bannerShow('SSE 断连——画布已转 30s 轮询 (恢复即回事件驱动)', true)
  else bannerClearIf('SSE 断连')
}

// ---- SSE 复用 (app.js 派发) + 断线 30s 轮询 (spec §5) ----
window.addEventListener('pm:sse', (e) => {
  const kind = e.detail?.kind
  if (kind === 'tickets' || kind === 'fleet' || kind === 'flow') canvasRefetchDebounced()
  else if (kind === 'act') { // PMW2-3: act settle 事件对账 (快路径; 轮询为兜底仲裁)
    const ev = e.detail ?? {}
    if (ev.ref && C.pending.has(ev.ref)) settleAct(ev.ref, ev)
  }
})
window.addEventListener('pm:sse-state', (e) => {
  C.sseOpen = !!e.detail?.open
  if (C.sseOpen) {
    clearInterval(C.pollTimer); C.pollTimer = 0
  } else if (!C.pollTimer) {
    C.pollTimer = setInterval(refetchGraph, 30_000)
  }
  renderCounts(C.graph?.degraded ? C.graph.note : '')
})
const canvasRefetchDebounced = (() => { let t = 0; return () => { clearTimeout(t); t = setTimeout(refetchGraph, 400) } })() // 400ms 去抖

// ---- 内省 (gate/证据只读数据面; 无行为) ----
function introspect() {
  window.__pmCanvas = {
    ready: C.mode === 'canvas' || C.mode === 'list',
    mode: C.mode,
    nodes: C.nodeEls.size,
    edges: C.edgeEls.size,
    lanes: C.lanes.length,
    laneIds: C.lanes.map((l) => l.id),
    laneBounds: Object.fromEntries(C.lanes.map((l) => [l.id, { x: l.x, y: l.y, w: l.w, h: l.h }])),
    view: { ...C.view },
    lastRefetchAt: C.lastRefetchAt,
    sseOpen: C.sseOpen,
    drawer: C.drawerNode, // PMW2-3 内省 (只读)
    actHist: [...C.actHist.values()].reduce((a, l) => a + l.length, 0),
    pendingActs: C.pending.size,
    replay: { on: C.replay.on, loaded: C.replay.loaded, events: C.replay.events.length, cursor: C.replay.cursor, max: C.replay.max, playing: C.replay.playing, speed: C.replay.speed }, // PMW2-4/F
    minimapDots: $('#mm-dots') ? $('#mm-dots').children.length : 0,
    stickyVisible: [...($('#cv-sticky')?.children ?? [])].filter((c) => c.style.display !== 'none').length,
  }
}

// ---- tab 可见性: 首次可见时取景 (隐藏时 svg 尺寸为 0) ----
function wireVisibility() {
  const sec = $('#view-canvas')
  const mo = new MutationObserver(() => {
    if (!sec.hidden && !C.fitDone && C.lanes.length) { C.fitDone = true; fitView() }
  })
  mo.observe(sec, { attributes: true, attributeFilter: ['hidden'] })
}

// ---- boot ----
async function boot() {
  $('#view-canvas').innerHTML = `
    <div class="cv-head">
      <span id="cv-counts" class="dim mono">加载中…</span>
      <span class="dim small">只读画布 · wheel 缩放 / 拖拽平移 / 点击或悬停高亮关联 · 点节点开抽屉 · 数据 GET /op/graph</span>
    </div>
    <div id="cv-banner" class="cv-banner" hidden></div>
    <div id="cv-timeline" class="cv-timeline">
      <button id="cv-tl-load" class="cv-act-btn" title="拉取 /op/trace 事件流 (图上全部会话)">载入回放</button>
      <div id="cv-tl-ctrl" hidden>
        <button id="cv-tl-play" class="cv-act-btn" title="播放/暂停">▶</button>
        <select id="cv-tl-speed" title="倍速"><option value="1">1×</option><option value="4">4×</option><option value="16">16×</option></select>
        <input type="range" id="cv-tl-range" min="0" max="1000" value="1000">
        <span id="cv-tl-time" class="mono small dim"></span>
        <span id="cv-tl-mode" class="cv-badge">实况</span>
      </div>
    </div>
    <div class="cv-stage" id="cv-stage">
      <div id="cv-svg-wrap"><svg id="canvas-svg"></svg></div>
      <div id="cv-list" hidden></div>
      <div id="cv-sticky" aria-hidden="true"></div>
      <div id="cv-minimap" title="缩略图 · 点击/拖动跳转">
        <svg id="minimap-svg" width="180" height="140"></svg>
      </div>
      <aside id="cv-drawer" hidden>
        <div class="cv-drawer-head">
          <span id="cv-drawer-kind" class="cv-badge"></span>
          <strong id="cv-drawer-title"></strong>
          <button id="cv-drawer-close" title="关闭抽屉">×</button>
        </div>
        <div id="cv-drawer-body"></div>
        <div class="cv-hist-wrap">
          <h5>动作历史 <span class="dim small">ref + ts + 动作 (页内审计)</span></h5>
          <ul id="cv-drawer-hist"></ul>
        </div>
      </aside>
    </div>
    <dialog id="cv-act-confirm">
      <h4>确认动作</h4>
      <p class="small dim">动作全文</p>
      <pre id="cv-act-cmd" class="mono"></pre>
      <p class="small dim">影响节点</p>
      <p id="cv-act-target" class="mono small"></p>
      <label id="cv-act-irrev" class="cv-irrev" hidden><input type="checkbox" id="cv-act-irrev-chk"> 这是不可逆转移, 我已知晓且确认</label>
      <div class="cv-dlg-row">
        <button id="cv-act-cancel">取消</button>
        <button id="cv-act-ok">确认提交</button>
      </div>
    </dialog>
    <div id="cv-toast" hidden></div>`
  wireStage()
  wireDrawer()
  wireTimeline()
  wireMinimap()
  wireVisibility()
  await refetchGraph()
  if (C.mode === 'canvas' && C.lanes.length) { fitView() }
  setInterval(() => { if (!document.hidden && C.mode === 'canvas') fitDoneCheck() }, 5000)
}
function fitDoneCheck() { // 首帧渲染发生在隐藏 tab 时: 可见后补取景
  const sec = $('#view-canvas')
  if (!sec.hidden && !C.fitDone && C.lanes.length) { C.fitDone = true; fitView() }
}

boot()
