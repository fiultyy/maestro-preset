// pm-web 画布 tab — PMW2-2 MVP 只读 (spec docs/specs/spec-pm-web-canvas.md §1/§2/§4/§5)
// 零 npm / 零构建: 唯一 vendor = elk.bundled.js (elkjs 0.12.0 逐字节, EPL-2.0,
// 见 README「Vendor 例外」), 经 elk.js 动态 import —— 加载或布局失败 → 画布
// 回退按 flow 分组的列表视图, 绝不白屏 (spec §5 降级链)。
// 数据: GET /op/graph (PMW2-1); 增量: 复用 app.js 既有 SSE 连接 (pm:sse 事件,
// 400ms 去抖 refetch → 按 id diff → 受影响泳道重排 → 节点/边 300ms 位移过渡);
// SSE 断 (pm:sse-state open:false) → 30s 轮询, 恢复即回事件驱动。
// 交互只读: wheel 缩放 (指针为锚, 0.5×–2×) + 空白拖拽平移 + 节点 hover/点击
// 高亮关联边 (点击钉住, 空白点击取消)。无编辑无拖动无抽屉无回放 (§4 明确禁止)。
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
  if (C.refetching) return
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
    if (pan.node && !pan.moved) { C.selected = C.selected === pan.node ? null : pan.node; applyHighlight() } // 点击选中/取消
    else if (!pan.node && !pan.moved) { C.selected = null; applyHighlight() } // 空白点击取消
    pan = null
  }
  s.addEventListener('pointerup', up)
  s.addEventListener('pointercancel', () => { pan = null; st.classList.remove('cv-panning') })
  s.addEventListener('mouseover', (e) => {
    const nodeG = e.target.closest?.('.cv-node')
    if (nodeG) { C.hover = nodeG.dataset.id; applyHighlight() }
  })
  s.addEventListener('mouseout', (e) => {
    if (e.target.closest?.('.cv-node')) { C.hover = null; applyHighlight() }
  })
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
      <span class="dim small">只读画布 · wheel 缩放 / 拖拽平移 / 点击或悬停高亮关联 · 数据 GET /op/graph</span>
    </div>
    <div id="cv-banner" class="cv-banner" hidden></div>
    <div class="cv-stage" id="cv-stage">
      <div id="cv-svg-wrap"><svg id="canvas-svg"></svg></div>
      <div id="cv-list" hidden></div>
    </div>`
  wireStage()
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
