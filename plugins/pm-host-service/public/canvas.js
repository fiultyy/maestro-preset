// pm-web 图 tab — PMWEB-3TAB: 三 tab 面 (票/席位/图) 的 scope-DAG 中心场景。
// 聚合纯函数在 cluster.js (双轨键 refs.run → deps 连通分量 → 前缀族/单票 + scope 层),
// 簇 = 可折叠超级节点 (簇头 = run_id|族名/票数/活跃数, 展开显成员票), 左侧簇 list
// 联动染选 (选簇聚焦/选票高亮 deps 边+邻接, 其余淡出; selected 优先 hover)。
// scope 选择器三档 (用户裁决 ③): 全部 / cwd 桶 (refs.cwd) / fleet (席位 code) ——
// scope 内票全展开 (簇语义保留), 出界 deps 邻居按自身聚簇轨道聚成「出界簇盒」
// (type:'out'), 点击重聚焦 (scope → cluster:<key> 展开该簇成员)。
// PMWEB-3TAB 退役: 旧泳道画布 (#view-canvas, PMW2-2..4) 场景代码整体移除 —— 用户裁决
// 2026-09-08「3个tab就够了」(191 边全量视图与图 tab 构造性冗余); 删除而非死代码:
// 零构建静态面逐字节出货, 死代码 = 每次加载常驻开销; git 5e7f98a 存档可溯; 共享工具
// (elk 通道/svgEl/pathFromPoints/EDGE_STYLE/textW) 保留供 DAG 复用。
// A4 口径: /op/graph 仍被本 tab 消费 —— refetchDag 顺带拉 counts (nodes/edges) 进计数条。
// 流程页降级为本 tab 折叠区 (#dg-flow, 默认收起; 数据面仍归 app.js op/flow, 经
// window.__pmRenderFlow 回填)。
// 零 npm / 零构建: 唯一 vendor = elk.bundled.js (elkjs 0.12.0, EPL-2.0, README「Vendor
// 例外」), elk 失败 → 网格兜底, 绝不白屏。数据 GET /op/tickets + /op/graph (只读);
// SSE 复用 app.js 连接 (pm:sse), 断 → 30s 轮询。交互只读: wheel 缩放/拖拽平移/点选染选。
'use strict'

import { clusterTickets, clusterScene, scopeScene, scopeBuckets, ticketInScope } from './cluster.js' // PMWEB-DAG 聚合层 + PMWEB-3TAB scope 层 (纯函数)

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
const EDGE_STYLE = { // §1.2 样式列照抄: 实线/虚线(6 4)/点线(2 4); PMWEB-GRAPH: 四类边全接 marker-end (方向可读, 逐类同色箭头)
  dep: { color: '#6b7688', dash: '', width: 1.5, arrow: true },
  dispatch: { color: '#4da3ff', dash: '', width: 1.5, arrow: true },
  callback: { color: '#9d7cd8', dash: '6 4', width: 1.5, arrow: true },
  'cb-send': { color: '#e0a93e', dash: '2 4', width: 1.5, arrow: true },
}
const ZOOM_MIN = 0.12 // PMWEB-GRAPH: fit/缩放下限 0.5(泳道)/0.3(DAG) → 0.12 (16 泳道全可见), 上限 2 不变


const SVG_NS = 'http://www.w3.org/2000/svg'
const svgEl = (tag, attrs = {}) => {
  const n = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v))
  return n
}

// ---- elk 实例缓存 (泳道画布退役后仅 DAG 布局使用) ----
const C = { elk: null }

// elk 边路由折线 → SVG path d (PMWEB-GRAPH: DAG/泳道共用几何; 泳道退役后 DAG 唯一消费)
const pathFromPoints = (pts) => pts.map(([x, y], i) => `${i ? 'L' : 'M'} ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ')

// ---- elk 加载 (唯一 vendor 通道: elk.js → elk.bundled.js) ----
async function loadElk() {
  if (C.elk) return C.elk
  try {
    const m = await import('./elk.js') // 失败 → 调用方回退列表视图
    C.elk = new m.ELK()
    return C.elk
  } catch { return null }
}


// ==== PMWEB-DAG: 图 tab —— 聚合 DAG 场景 (只增; 聚合语义见 cluster.js 头注) ====
const D2 = {
  tickets: [], // 最近一次 /op/tickets 票数组
  clusters: [], // clusterTickets 结果
  scene: null, // clusterScene 结果 (折叠态语义)
  expanded: new Set(), // 展开的簇 key 集 (默认全折叠 = 聚合态)
  pos: new Map(), // 场景节点 id -> {x,y,w,h}
  routes: new Map(), // edgeId -> [x,y][] elk 路由折线 (世界坐标; PMWEB-GRAPH sections 消费)
  world: { w: 0, h: 0 },
  nodeEls: new Map(),
  edgeEls: new Map(),
  view: { x: 0, y: 0, s: 1 },
  selected: null, // {kind:'cluster', key} | {kind:'ticket', id}
  hover: null,
  fitDone: false,
  lastRefetchAt: 0,
  refetching: false,
  sseOpen: null,
  pollTimer: 0,
  sig: '', // 场景签名 (节点+边 id) —— 未变则只刷高亮/计数, 不重排不重画
  scope: 'all', // PMWEB-3TAB: 'all' | 'cwd:<path>' | 'fleet:<code>' | 'cluster:<key>'
  graphCounts: null, // PMWEB-3TAB A4: /op/graph counts (nodes/edges) —— 图 tab 仍消费 op/graph
}
const dagStage = () => $('#dg-stage')
const dagSvg = () => $('#dag-svg')
const dagBannerEl = () => $('#dg-banner')

async function refetchDag() {
  if (D2.refetching) return
  D2.refetching = true
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 15_000) // 传输楔死兜底 (旧泳道 refetch 同款惯例)
  try {
    const res = await fetch('op/tickets', { signal: ctl.signal })
    const d = await res.json()
    D2.lastRefetchAt = Date.now()
    const list = Array.isArray(d?.tickets) ? d.tickets : []
    D2.tickets = list
    D2.clusters = clusterTickets(list)
    const alive = new Set(D2.clusters.map((c) => c.key))
    for (const k of [...D2.expanded]) if (!alive.has(k)) D2.expanded.delete(k) // 簇消失即收拢
    renderScopeOptions() // PMWEB-3TAB: scope 桶随票面刷新 (当前桶消失自动回「全部」)
    await pullGraphCounts(ctl) // PMWEB-3TAB A4: /op/graph 仍被 图 tab 消费
    if (!list.length) { dagShowEmpty(d?.note); return }
    const ov = $('#dg-empty')
    if (ov) ov.hidden = true
    await rebuildDag()
    renderDagList()
    const degradedNote = d?.degraded && d.note ? `票面降级: ${d.note}` : ''
    renderDagCounts(degradedNote)
    if (degradedNote) dagBanner(degradedNote)
    else if (dagBannerEl() && /票面降级/.test(dagBannerEl().textContent)) dagBannerEl().hidden = true
  } catch (e) {
    dagBanner(`/op/tickets 不可达 —— 保留上一帧渲染 (${String(e?.message ?? e).slice(0, 80)})`)
  } finally {
    clearTimeout(timer)
    D2.refetching = false
  }
}

// PMWEB-3TAB A4: /op/graph 仍被 图 tab 消费 —— 只取 counts (nodes/edges) 进计数条;
// 失败静默清空, 不影响 DAG 场景 (场景数据面仍是 op/tickets)。
async function pullGraphCounts(ctl) {
  try {
    const gres = await fetch('op/graph', { signal: ctl?.signal })
    const g = await gres.json()
    D2.graphCounts = g?.counts ? { nodes: g.counts.nodes ?? 0, edges: g.counts.edges ?? 0 } : null
  } catch { D2.graphCounts = null }
}

// PMWEB-3TAB: scope 选择器数据面 —— cwd 桶 / fleet 桶自票面派生 (cluster.js scopeBuckets)。
// 当前 scope 桶已从票面消失 → 自动回「全部」(降级优先, 不留死 scope)。
function renderScopeOptions() {
  const sel = $('#dg-scope')
  if (!sel) return
  const b = scopeBuckets(D2.tickets)
  const opt = (v, label) => `<option value="${esc(v)}">${esc(label)}</option>`
  const short = (p) => String(p).split('/').filter(Boolean).pop() || String(p)
  sel.innerHTML = opt('all', `全部 (${D2.tickets.length})`) +
    (b.cwds.length ? `<optgroup label="cwd 桶">${b.cwds.map((x) => opt(`cwd:${x.key}`, `${short(x.key)} · ${x.count}`)).join('')}</optgroup>` : '') +
    (b.fleets.length ? `<optgroup label="fleet">${b.fleets.map((x) => opt(`fleet:${x.key}`, `${x.key} · ${x.count}`)).join('')}</optgroup>` : '')
  sel.value = D2.scope
  if (sel.value !== D2.scope && D2.scope !== 'all') { // 桶消失回退
    D2.scope = 'all'
    D2.expanded.clear()
    D2.selected = null
    sel.value = 'all'
  }
}

// PMWEB-3TAB: scope 切换单入口 (选择器/联动共用) —— 展开态与选中态随 scope 重置
async function setDagScope(scope) {
  D2.scope = scope || 'all'
  D2.expanded.clear()
  D2.selected = null
  const sel = $('#dg-scope')
  if (sel && sel.value !== D2.scope) { // 重聚焦 scope 不在桶选项中 → 前插临时选中项 (选择器不落空)
    const opt = document.createElement('option')
    opt.value = D2.scope
    opt.textContent = `聚焦 ${D2.scope.replace('cluster:', '')}`
    sel.prepend(opt)
    sel.value = D2.scope
  }
  await rebuildDag(true)
  renderDagList()
  renderDagCounts('')
  if (D2.world.w) { dagFitView(); D2.fitDone = true }
  dagIntro()
}

function dagBanner(msg) {
  const b = dagBannerEl()
  if (!b) return
  b.hidden = false
  b.textContent = `⚠ ${msg}`
  b.className = 'cv-banner warn'
}

function dagShowEmpty(note) { // 空态: 清场景 + 覆盖层注记 (不销毁 svg, 恢复时直接重建场景)
  D2.scene = null
  D2.sig = ''
  D2.nodeEls.clear()
  D2.edgeEls.clear()
  const s = dagSvg()
  if (s) s.textContent = ''
  const st = dagStage()
  if (st) {
    let ov = $('#dg-empty')
    if (!ov) { ov = document.createElement('div'); ov.id = 'dg-empty'; st.appendChild(ov) }
    ov.hidden = false
    ov.innerHTML = `<div class="empty-note">0 张票${note ? ' —— ' + esc(note) : ''} —— 图为空 (账本为空或票面源不可用, 降级态)</div>`
  }
  const el = $('#dg-list')
  if (el) el.innerHTML = `<p class="dim small">0 簇${note ? ` —— ${esc(note)}` : ''}</p>`
  renderDagCounts('')
}

function renderDagCounts(degradedNote) {
  const el = $('#dg-counts')
  if (!el) return
  const c = D2.clusters
  const active = c.reduce((a, x) => a + x.active, 0)
  const outN = D2.scene?.outClusters?.length ?? 0
  const scopeTxt = !D2.scope || D2.scope === 'all' ? 'scope 全部' : `scope ${D2.scope}`
  const graphTxt = D2.graphCounts ? ` · graph ${D2.graphCounts.nodes}节点/${D2.graphCounts.edges}边` : ''
  el.textContent = D2.scene
    ? `${D2.tickets.length} 票 → ${c.length} 簇 (run ${c.filter((x) => x.kind === 'run').length} / deps ${c.filter((x) => x.kind === 'deps').length} / 前缀 ${c.filter((x) => x.kind === 'prefix').length} / 单票 ${c.filter((x) => x.kind === 'single').length}) · 活跃 ${active} · ${scopeTxt}${outN ? ` · 出界簇 ${outN}` : ''}${graphTxt} · 场景 ${D2.scene.nodes.length} 节点 / ${D2.scene.edges.length} 边 · 展开 ${D2.expanded.size}`
    : '加载中…'
  if (!degradedNote && dagBannerEl() && /票面降级/.test(dagBannerEl().textContent || '')) dagBannerEl().hidden = true
}

// 场景重建: 聚合派生 + elk layered 布局; 签名未变则跳过重排 (SSE 突发不闪)。
// PMWEB-3TAB: scope ≠ all → scopeScene (scope 内全展开 + 出界聚合簇盒)。
async function rebuildDag(force) {
  D2.scene = !D2.scope || D2.scope === 'all'
    ? clusterScene(D2.tickets, D2.expanded)
    : scopeScene(D2.tickets, D2.scope)
  const sig = D2.scene.nodes.map((n) => n.id).join('|') + '#' + D2.scene.edges.map((e) => e.id).join('|')
  if (!force && sig === D2.sig) { applyDagHighlight(); renderDagCounts(''); return }
  D2.sig = sig
  try {
    const r = await layoutDag()
    D2.pos = r.pos
    D2.routes = r.routes ?? new Map()
    D2.world = { w: r.w, h: r.h }
  } catch (e) { // elk 不可用 → 本地网格兜底 (仍出簇, 边画直线 bezier)
    dagGridLayout()
  }
  drawDag()
}

async function layoutDag() {
  const elk = await loadElk()
  if (!elk) throw new Error('elk unavailable')
  const children = D2.scene.nodes.map((n) => { const { w, h } = dagNodeSize(n); return { id: n.id, width: w, height: h } })
  const out = await elk.layout({
    id: 'dag', children,
    edges: D2.scene.edges.map((e) => ({ id: e.id, sources: [e.from], targets: [e.to] })),
  }, { 'elk.algorithm': 'layered' })
  const pos = new Map()
  let w = 0; let h = 0
  for (const c of out.children ?? []) {
    const n = D2.scene.nodes.find((x) => x.id === c.id)
    const s = dagNodeSize(n)
    pos.set(c.id, { x: c.x ?? 0, y: c.y ?? 0, w: s.w, h: s.h })
    w = Math.max(w, (c.x ?? 0) + (c.width ?? 0))
    h = Math.max(h, (c.y ?? 0) + (c.height ?? 0))
  }
  // PMWEB-GRAPH: 消费 elk 边路由 sections (同 layoutLane; 曾弃用致自算 bezier 穿盒)
  const routes = new Map()
  const pushPt = (arr, x, y) => { if (Number.isFinite(x) && Number.isFinite(y)) arr.push([x, y]) }
  for (const e of out.edges ?? []) {
    const pts = []
    for (const sec of e.sections ?? []) {
      if (!sec.startPoint || !sec.endPoint) continue
      const n0 = pts.length
      pushPt(pts, sec.startPoint.x, sec.startPoint.y)
      const b = sec.bendPoints ?? []
      if (b.length && typeof b[0] === 'object') for (const bp of b) pushPt(pts, bp.x, bp.y)
      else for (let i = 0; i + 1 < b.length; i += 2) pushPt(pts, b[i], b[i + 1])
      pushPt(pts, sec.endPoint.x, sec.endPoint.y)
      if (pts.length - n0 < 2) pts.length = n0
    }
    if (pts.length >= 2) routes.set(e.id, pts)
  }
  return { pos, w: Math.ceil(w), h: Math.ceil(h), routes }
}

function dagGridLayout() { // elk 失败兜底: 按簇序网格铺开 (降级优先, 不白屏)
  const pos = new Map()
  const COLS = 6; const CW = 210; const CH = 96
  D2.scene.nodes.forEach((n, i) => {
    const s = dagNodeSize(n)
    pos.set(n.id, { x: (i % COLS) * CW + 12, y: Math.floor(i / COLS) * CH + 12, w: s.w, h: s.h })
  })
  const rows = Math.ceil(D2.scene.nodes.length / COLS)
  D2.pos = pos
  D2.routes = new Map() // 网格兜底无路由 → dagEdgePath 走 bezier
  D2.world = { w: COLS * CW + 24, h: rows * CH + 24 }
}

// ---- 簇标签估宽 (PMWEB-GRAPH): canvas measureText 实测 —— 曾按 6px/字估, CJK 实宽近 2 倍致溢出;
// 无 DOM/canvas 环境兜底按 CJK 全宽系数。----
let measureCtx = null
const DG_LABEL_FONT = '600 11.5px ui-monospace, "SF Mono", Menlo, Consolas, monospace'
const DG_SUB_FONT = '10px ui-monospace, "SF Mono", Menlo, Consolas, monospace'
function textW(s, font = DG_LABEL_FONT) {
  try {
    measureCtx = measureCtx || document.createElement('canvas').getContext('2d')
    if (measureCtx) { measureCtx.font = font; return measureCtx.measureText(String(s)).width }
  } catch {}
  return [...String(s)].reduce((a, ch) => a + (ch.charCodeAt(0) > 0x2e80 ? 11.5 : 7), 0)
}
function fitText(s, maxPx, font = DG_LABEL_FONT) { // 截断到实测宽 ≤ maxPx, 省略号收尾
  s = String(s ?? '')
  if (textW(s, font) <= maxPx) return s
  let lo = 0; let hi = s.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (textW(`${s.slice(0, mid)}…`, font) <= maxPx) lo = mid
    else hi = mid - 1
  }
  return `${s.slice(0, lo)}…`
}

function dagNodeSize(n) {
  if (n.type === 'cluster' || n.type === 'out') {
    // 尺寸常数与渲染预算对齐: fitText 预算 = p.w - 28 (左 12 + 右 16 让位 ▸ 角标) → sizing 同 28/34
    const w1 = 34 + Math.min(textW(String(n.label ?? '')), 226)
    const w2 = 28 + Math.min(textW(dagClusterSub(n), DG_SUB_FONT), 232)
    return { w: clamp(Math.ceil(Math.max(w1, w2)), 130, 260), h: 46 }
  }
  const w = 44 + Math.min(textW(String(n.label ?? '')), 190)
  return { w: clamp(Math.ceil(w), 96, 220), h: 40 }
}

// 簇副标签: 票数/活跃/轨道 + 跨簇依赖计数 ↗出 ↘入 (无依赖不显示; PMWEB-GRAPH F3);
// 出界簇盒 (PMWEB-3TAB): 「出界」徽标 + 票数/活跃 —— 独立聚合显示, 非 ghost 散点。
function dagClusterSub(n) {
  if (n.type === 'out') return `出界 · ${n.total} 票 · ${n.active} 活跃`
  return `${n.total} 票 · ${n.active} 活跃${n.kind === 'single' ? '' : ' · ' + n.kind}` +
    (n.depOut ? ` ↗${n.depOut}` : '') + (n.depIn ? ` ↘${n.depIn}` : '')
}

function dagNodeEl(n) {
  const p = D2.pos.get(n.id) || { x: 0, y: 0, w: 140, h: 44 }
  const g = svgEl('g', { class: `dg-node t-${n.type}`, 'data-id': n.id })
  if (n.type === 'out') { // PMWEB-3TAB: 出界聚合簇盒 —— 虚线框 + 出界徽标, 点击重聚焦该簇
    g.appendChild(svgEl('rect', { x: 1.5, y: 1.5, width: p.w - 3, height: p.h - 3, rx: 9, class: 'dg-node-body', stroke: '#e0a93e', 'stroke-dasharray': '5 4' }))
    const label = svgEl('text', { x: p.w / 2, y: 19, class: 'dg-label', title: String(n.label ?? '') })
    label.textContent = fitText(n.label, p.w - 28)
    g.appendChild(label)
    const sub = svgEl('text', { x: p.w / 2, y: 35, class: 'dg-sub', title: dagClusterSub(n) })
    sub.textContent = fitText(dagClusterSub(n), p.w - 28, DG_SUB_FONT)
    g.appendChild(sub)
    const refocus = svgEl('text', { x: p.w - 10, y: 15, class: 'dg-fold', title: '点击重聚焦到该簇 scope' })
    refocus.textContent = '⤴'
    g.appendChild(refocus)
  } else if (n.type === 'cluster') {
    const stroke = n.active > 0 ? '#4da3ff' : '#6b7688'
    g.appendChild(svgEl('rect', { x: 1.5, y: 1.5, width: p.w - 3, height: p.h - 3, rx: 9, class: 'dg-node-body', stroke }))
    const labelText = fitText(n.label, p.w - 28)
    const label = svgEl('text', { x: p.w / 2, y: 19, class: 'dg-label', title: String(n.label ?? '') })
    label.textContent = labelText
    g.appendChild(label)
    const subText = fitText(dagClusterSub(n), p.w - 28, DG_SUB_FONT)
    const sub = svgEl('text', { x: p.w / 2, y: 35, class: 'dg-sub', title: dagClusterSub(n) })
    sub.textContent = subText
    g.appendChild(sub)
    const fold = svgEl('text', { x: p.w - 10, y: 15, class: 'dg-fold', 'data-fold': n.clusterKey, title: '展开/折叠成员票' }) // 角标: 点击折叠展开
    fold.textContent = '▸'
    g.appendChild(fold)
  } else {
    g.appendChild(svgEl('rect', { x: 1.5, y: 1.5, width: p.w - 3, height: p.h - 3, rx: 7, class: 'dg-node-body', stroke: colorOf(n.state) }))
    const label = svgEl('text', { x: p.w / 2, y: 17, class: 'dg-label', title: String(n.label ?? '') })
    label.textContent = fitText(n.label, p.w - 28)
    g.appendChild(label)
    const sub = svgEl('text', { x: p.w / 2, y: 32, class: 'dg-sub', title: `${n.state}${n.leaseOwner ? ' · lease ' + n.leaseOwner : ''}` })
    sub.textContent = fitText(`${n.state}${n.leaseOwner ? ' · lease ' + n.leaseOwner : ''}`, p.w - 28, DG_SUB_FONT)
    g.appendChild(sub)
  }
  g.style.transform = `translate(${p.x}px, ${p.y}px)`
  return g
}

function dagEdgePath(e) { // elk 路由折线优先 (PMWEB-GRAPH); 网格兜底态走右出左入 bezier
  const routed = D2.routes.get(e.id)
  if (routed) return pathFromPoints(routed)
  const a = D2.pos.get(e.from); const b = D2.pos.get(e.to)
  if (!a || !b) return ''
  let sx; let sy; let tx; let ty
  if (b.x >= a.x) { sx = a.x + a.w; sy = a.y + a.h / 2; tx = b.x; ty = b.y + b.h / 2 } else { sx = a.x; sy = a.y + a.h / 2; tx = b.x + b.w; ty = b.y + b.h / 2 }
  const dx = Math.max(40, Math.abs(tx - sx) / 2)
  const dir = tx >= sx ? 1 : -1
  return `M ${sx} ${sy} C ${sx + dx * dir} ${sy}, ${tx - dx * dir} ${ty}, ${tx} ${ty}`
}

function drawDag() {
  const s = dagSvg()
  if (!s) return
  s.textContent = ''
  const defs = svgEl('defs')
  defs.appendChild(svgEl('marker', { id: 'dg-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 10, markerHeight: 10, markerUnits: 'userSpaceOnUse', orient: 'auto-start-reverse' }))
    .appendChild(svgEl('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: EDGE_STYLE.dep.color }))
  s.appendChild(defs)
  const viewport = svgEl('g', { id: 'dg-viewport' })
  s.appendChild(viewport)
  const gEdges = svgEl('g', { id: 'dg-edges' })
  D2.edgeEls.clear()
  for (const e of D2.scene.edges) {
    const st = EDGE_STYLE[e.kind] || EDGE_STYLE.dep
    // PMWEB-GRAPH: #dg-arrow 接上 (曾定义零引用, dep 边方向不可读)
    const p = svgEl('path', { class: `dg-edge k-${e.kind}`, d: dagEdgePath(e), fill: 'none', stroke: st.color, 'stroke-width': st.width, 'data-edge': e.id })
    if (st.dash) p.setAttribute('stroke-dasharray', st.dash)
    if (st.arrow) p.setAttribute('marker-end', 'url(#dg-arrow)')
    D2.edgeEls.set(e.id, p)
    gEdges.appendChild(p)
  }
  viewport.appendChild(gEdges)
  const gNodes = svgEl('g', { id: 'dg-nodes' })
  D2.nodeEls.clear()
  for (const n of D2.scene.nodes) {
    const g = dagNodeEl(n)
    D2.nodeEls.set(n.id, g)
    gNodes.appendChild(g)
  }
  viewport.appendChild(gNodes)
  applyDagView()
  applyDagHighlight()
  dagIntro()
}

// 染选: selected 优先, hover 预览同路径。lit = 根节点(选簇/选票的场景形态) +
// 关联边 + 邻接节点 (票级 deps 邻域; 同簇成员经簇节点/成员节点天然入 lit)。
function dagActiveSel() {
  if (D2.selected) return D2.selected
  if (!D2.hover) return null
  const n = D2.scene?.nodes.find((x) => x.id === D2.hover)
  if (!n) return null
  return n.type === 'cluster' ? { kind: 'cluster', key: n.clusterKey } : { kind: 'ticket', id: n.ticketId }
}

function dagLit(active) {
  if (!active || !D2.scene) return null
  const sc = D2.scene
  const rootIds = new Set()
  if (active.kind === 'cluster') {
    const root = sc.clusterRoot.get(active.key)
    if (root) rootIds.add(root)
    else for (const n of sc.nodes) if (n.clusterKey === active.key) rootIds.add(n.id) // 展开簇: 成员集为根
  } else {
    const nid = sc.nodeOfTicket.get(active.id)
    if (nid) rootIds.add(nid)
  }
  if (!rootIds.size) return null
  const nodes = new Set(rootIds)
  const edges = new Set()
  for (const e of sc.edges) {
    if (!rootIds.has(e.from) && !rootIds.has(e.to)) continue
    edges.add(e.id)
    nodes.add(e.from); nodes.add(e.to)
  }
  if (active.kind === 'ticket') { // refs 邻接: 同簇成员 (折叠=簇根, 展开=成员节点)
    const c = sc.clusters.find((x) => x.ticketIds.includes(active.id))
    const root = c && sc.clusterRoot.get(c.key)
    if (root) nodes.add(root)
    else if (c) for (const n of sc.nodes) if (n.clusterKey === c.key) nodes.add(n.id)
  }
  return { nodes, edges, roots: rootIds }
}

function applyDagHighlight() {
  const lit = dagLit(dagActiveSel())
  for (const [id, g] of D2.nodeEls) {
    g.classList.toggle('dg-dim', !!lit && !lit.nodes.has(id))
    g.classList.toggle('dg-sel', !!lit && lit.roots.has(id))
  }
  for (const [id, p] of D2.edgeEls) {
    p.classList.toggle('dg-dim', !!lit && !lit.edges.has(id))
    p.classList.toggle('dg-lit', !!lit && lit.edges.has(id))
  }
}

function selectDag(sel) { // sel = null 取消
  D2.selected = sel
  applyDagHighlight()
  renderDagList()
  dagIntro()
}

async function toggleDagExpand(key, force) {
  const open = D2.expanded.has(key)
  const next = force == null ? !open : !!force
  if (next) D2.expanded.add(key)
  else D2.expanded.delete(key)
  await rebuildDag(true)
  if (D2.world.w) { dagFitView(); D2.fitDone = true } // PMWEB-GRAPH: 展开/折叠后重取景 (曾不 fit 致新成员出画)
  renderDagList()
  renderDagCounts('')
}

// ---- 图 tab: 左侧簇 list (票数/活跃数/状态分布摘要; 点选联动染选) ----
function renderDagList() {
  const el = $('#dg-list')
  if (!el) return
  const ticketsById = new Map(D2.tickets.map((t) => [String(t.ticket_id), t]))
  const rows = D2.clusters.map((c) => {
    const open = D2.expanded.has(c.key)
    const sel = D2.selected?.kind === 'cluster' && D2.selected.key === c.key
    const dist = Object.entries(c.states).map(([s, n]) => `${s} ${n}`).join(' · ')
    const members = !open ? '' : `<ul class="dg-members">${c.ticketIds.map((id) => {
      const st = String(ticketsById.get(id)?.state ?? 'unknown')
      const tsel = D2.selected?.kind === 'ticket' && D2.selected.id === id
      return `<li><button type="button" class="dg-ticket-row${tsel ? ' dg-selected' : ''}" data-tid="${esc(id)}"><span class="dg-dot" style="background:${colorOf(st)}"></span><span class="mono">${esc(id)}</span><span class="dim small">${esc(st)}</span></button></li>`
    }).join('')}</ul>`
    return `<div class="dg-cluster${sel ? ' dg-selected' : ''}" data-keywrap="${esc(c.key)}">
      <div class="dg-cluster-row${sel ? ' dg-selected' : ''}" data-key="${esc(c.key)}">
        <button type="button" class="dg-fold-btn" data-fold="${esc(c.key)}" title="${open ? '折叠' : '展开'}成员票">${open ? '▾' : '▸'}</button>
        <span class="dg-label mono" title="${esc(c.key)}">${esc(c.label)}</span>
        <span class="dg-kind k-${c.kind}">${c.kind}</span>
        <span class="dg-meta small">${c.total} 票 · <span class="${c.active ? 'dg-active' : 'dim'}">${c.active} 活跃</span></span>
      </div>
      <div class="dg-dist small dim">${esc(dist)}</div>
      ${members}
    </div>`
  }).join('')
  el.innerHTML = rows || '<p class="dim small">0 簇 —— 无票或票面未就绪</p>'
}

function wireDagList() {
  const el = $('#dg-list')
  if (!el) return
  el.addEventListener('click', async (e) => {
    const fold = e.target.closest?.('[data-fold]')
    if (fold) { await toggleDagExpand(fold.dataset.fold); return }
    const tid = e.target.closest?.('[data-tid]')
    if (tid) { // 选票: 所在簇折叠时自动展开 (图上可见其 deps 边)
      const id = tid.dataset.tid
      const c = D2.clusters.find((x) => x.ticketIds.includes(id))
      if (c && !D2.expanded.has(c.key)) await toggleDagExpand(c.key, true)
      selectDag({ kind: 'ticket', id })
      return
    }
    const row = e.target.closest?.('[data-key]')
    if (row) {
      const key = row.dataset.key
      selectDag(D2.selected?.kind === 'cluster' && D2.selected.key === key ? null : { kind: 'cluster', key })
    }
  })
}

// ---- 图 tab: 画布交互 (wheel 缩放/拖拽平移/点选染选/双击与角标折叠展开) ----
function applyDagView() {
  $('#dg-viewport')?.setAttribute('transform', `translate(${D2.view.x} ${D2.view.y}) scale(${D2.view.s})`)
}

function dagFitView() {
  const st = dagStage()
  if (!st || st.clientWidth < 40 || !D2.world.w) return
  const s = clamp(Math.min((st.clientWidth - 32) / D2.world.w, (st.clientHeight - 32) / D2.world.h), ZOOM_MIN, 2)
  D2.view = { s, x: (st.clientWidth - D2.world.w * s) / 2, y: 12 }
  applyDagView()
}

function wireDagStage() {
  const st = dagStage()
  const s = dagSvg()
  s.addEventListener('wheel', (e) => {
    e.preventDefault()
    const rect = s.getBoundingClientRect()
    const px = e.clientX - rect.left; const py = e.clientY - rect.top
    const s2 = clamp(D2.view.s * Math.exp(-e.deltaY * 0.0015), ZOOM_MIN, 2)
    D2.view.x = px - (px - D2.view.x) * (s2 / D2.view.s)
    D2.view.y = py - (py - D2.view.y) * (s2 / D2.view.s)
    D2.view.s = s2
    applyDagView()
  }, { passive: false })
  let pan = null
  s.addEventListener('pointerdown', (e) => {
    const nodeG = e.target.closest?.('.dg-node')
    if (nodeG) { pan = { node: nodeG.dataset.id, x0: e.clientX, y0: e.clientY, moved: false }; return }
    pan = { node: null, x0: e.clientX, y0: e.clientY, vx0: D2.view.x, vy0: D2.view.y, moved: false }
  })
  s.addEventListener('pointermove', (e) => {
    if (!pan) return
    const dx = e.clientX - pan.x0; const dy = e.clientY - pan.y0
    if (Math.abs(dx) + Math.abs(dy) > 4) pan.moved = true
    if (pan.node) return
    D2.view.x = pan.vx0 + dx; D2.view.y = pan.vy0 + dy
    applyDagView()
  })
  const up = (e) => {
    if (!pan) return
    if (pan.node && !pan.moved) {
      const n = D2.scene?.nodes.find((x) => x.id === pan.node)
      if (n?.type === 'out') { pan = null; setDagScope(`cluster:${n.clusterKey}`); return } // PMWEB-3TAB: 出界簇盒点击 → 重聚焦该簇 scope
      if (n?.type === 'cluster' && e.target.closest?.('.dg-fold')) { const k = n.clusterKey; pan = null; toggleDagExpand(k); return } // 角标: 折叠展开
      const sel = n?.type === 'cluster' ? { kind: 'cluster', key: n.clusterKey } : n ? { kind: 'ticket', id: n.ticketId } : null
      const same = D2.selected && sel && D2.selected.kind === sel.kind &&
        (sel.kind === 'cluster' ? D2.selected.key === sel.key : D2.selected.id === sel.id)
      selectDag(same ? null : sel) // 再点同节点 = 取消
    } else if (!pan.node && !pan.moved) selectDag(null) // 空白点击取消
    pan = null
  }
  s.addEventListener('pointerup', up)
  s.addEventListener('pointercancel', () => { pan = null })
  s.addEventListener('dblclick', (e) => {
    const nodeG = e.target.closest?.('.dg-node.t-cluster')
    if (!nodeG) return
    const n = D2.scene?.nodes.find((x) => x.id === nodeG.dataset.id)
    if (n?.clusterKey) toggleDagExpand(n.clusterKey)
  })
  s.addEventListener('mouseover', (e) => {
    const nodeG = e.target.closest?.('.dg-node')
    if (nodeG) { D2.hover = nodeG.dataset.id; applyDagHighlight() }
  })
  s.addEventListener('mouseout', (e) => {
    if (e.target.closest?.('.dg-node')) { D2.hover = null; applyDagHighlight() }
  })
}

function wireDagVisibility() { // tab 首次可见时取景 (隐藏时 stage 尺寸为 0)
  const sec = $('#view-dag')
  if (!sec) return
  const mo = new MutationObserver(() => {
    if (!sec.hidden && !D2.fitDone && D2.world.w) { D2.fitDone = true; dagFitView() }
  })
  mo.observe(sec, { attributes: true, attributeFilter: ['hidden'] })
}

function dagIntro() { // 门/证据只读数据面
  window.__pmDag = {
    ready: !!D2.scene,
    tickets: D2.tickets.length,
    clusters: D2.clusters.length,
    byKind: Object.fromEntries(['run', 'deps', 'prefix', 'single'].map((k) => [k, D2.clusters.filter((c) => c.kind === k).length])),
    nodes: D2.scene?.nodes.length ?? 0,
    edges: D2.scene?.edges.length ?? 0,
    expanded: [...D2.expanded],
    selected: D2.selected,
    view: { ...D2.view },
    lastRefetchAt: D2.lastRefetchAt,
    sseOpen: D2.sseOpen,
    clusterKeys: D2.clusters.map((c) => c.key),
    scope: D2.scope, // PMWEB-3TAB: 当前 scope 键
    outClusters: D2.scene?.outClusters?.length ?? 0, // 出界聚合簇盒数 (scope ≠ all 时)
    graphCounts: D2.graphCounts, // A4: /op/graph counts (图 tab 仍消费 op/graph)
  }
}

async function bootDag() {
  const sec = $('#view-dag')
  if (!sec) return
  sec.innerHTML = `
    <div class="cv-head">
      <span id="dg-counts" class="dim mono">加载中…</span>
      <select id="dg-scope" title="scope 选择器: 全部 / cwd 桶 (refs.cwd) / fleet 席位"></select>
      <span class="dim small">聚合 DAG · scope 内全展开, 出界簇盒点击重聚焦 · ▸ 展开簇 / 双击簇折叠 · 点选染选 deps+邻接 · 数据 GET /op/tickets + /op/graph (只读)</span>
    </div>
    <details id="dg-flow" class="dg-flow">
      <summary>流程 <span class="dim small">原流程页折叠区 · 默认收起 · 数据源 op/flow (app.js)</span></summary>
      <div id="dg-flow-body"></div>
    </details>
    <div id="dg-banner" class="cv-banner" hidden></div>
    <div id="dg-wrap">
      <aside id="dg-list" title="聚合簇列表: 点簇聚焦图, 点票染选其 deps 边+邻接"></aside>
      <div class="dg-stage" id="dg-stage">
        <svg id="dag-svg"></svg>
      </div>
    </div>`
  const scopeSel = $('#dg-scope')
  if (scopeSel) scopeSel.addEventListener('change', (e) => setDagScope(e.target.value))
  wireDagStage()
  wireDagList()
  wireDagVisibility()
  if (typeof window.__pmRenderFlow === 'function') window.__pmRenderFlow() // 流程数据先到 → 回填折叠区
  await refetchDag()
  if (!D2.fitDone && !sec.hidden && D2.world.w) { D2.fitDone = true; dagFitView() }
  dagIntro() // 空票面/降级态也要有内省面 (门断言用)
}

// ---- PMWEB-3TAB: 跨 tab 联动 (票 tab 选票 → 本 tab 染选; 席位 tab「在图中聚焦」→ fleet scope) ----
window.addEventListener('pm:dag-focus', async (e) => {
  const id = e.detail?.ticketId == null ? null : String(e.detail.ticketId)
  if (!id) return
  const t = D2.tickets.find((x) => String(x.ticket_id) === id)
  if (t && !ticketInScope(t, D2.scope)) await setDagScope('all') // 目标票不在当前 scope → 先回全部
  const c = D2.clusters.find((x) => x.ticketIds.includes(id))
  if (c && !D2.expanded.has(c.key)) await toggleDagExpand(c.key, true) // 所在簇自动展开
  selectDag({ kind: 'ticket', id })
  dagIntro()
})
window.addEventListener('pm:dag-focus-fleet', async (e) => {
  const code = e.detail?.code == null ? null : String(e.detail.code)
  if (!code) return
  await setDagScope(`fleet:${code}`) // 席位聚焦: scope=fleet:<code> (持票全展开 + 出界聚合)
  dagIntro()
})

window.addEventListener('pm:sse', (e) => { // 复用 app.js SSE: 票面变化 → 图 tab refetch
  if (['tickets', 'fleet', 'flow', 'act'].includes(e.detail?.kind)) dagRefetchDebounced() // fleet/flow 也动 /op/graph counts (A4 消费面保新鲜)
})
window.addEventListener('pm:sse-state', (e) => {
  D2.sseOpen = !!e.detail?.open
  if (D2.sseOpen) { clearInterval(D2.pollTimer); D2.pollTimer = 0 }
  else if (!D2.pollTimer) D2.pollTimer = setInterval(refetchDag, 30_000) // SSE 断: 30s 轮询兜底
})
const dagRefetchDebounced = (() => { let t = 0; return () => { clearTimeout(t); t = setTimeout(refetchDag, 400) } })() // 400ms 去抖
// PMWEB-DAG: SSE 初态回放 —— app.js (classic) 先于本 module 执行，若订阅在两个监听器
// 注册完成之前就断开（本页 cluster.js 静态导入会拉长 module 取回链，放大此窗口），
// pm:sse-state 事件会无人接听而丢失；按记账初态补发一次，保证轮询兜底与横幅不缺位。
// 回放延后到本任务之后: 监听器 render 依赖 bootDag() 注入的 DOM (#dg-counts 等)。
setTimeout(() => {
  if (state.sseOpen != null) {
    window.dispatchEvent(new CustomEvent('pm:sse-state', { detail: { open: state.sseOpen } }))
  }
}, 0)

// ---- boot (PMWEB-3TAB: 画布退役, 本文件仅 图 tab 场景) ----
bootDag()
