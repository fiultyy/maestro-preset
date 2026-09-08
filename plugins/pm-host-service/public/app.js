// pm-web — maestro 浏览器观测面逻辑 (spec docs/specs/pm-web.md PW-002..005)
// 零 npm / 零构建 / 零第三方 import：系统浏览器原生 API only。
// 红线：页面零账本写 —— 一切写动作 = POST /op/act 透传 (ADR-002)；
//       降级优先 —— 任何源不可用渲染空态+note，绝不白屏不崩 (mvp-plan §6.5)。
'use strict'

/* ---- 基础工具 ---- */

const $ = (sel) => document.querySelector(sel)

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]))

// ledger 的 deps/refs 字段是 JSON 编码字符串（"[]" / '{"evidence":…}'）
const parseJsonField = (s, fallback) => {
  if (s == null || s === '') return fallback
  try { return JSON.parse(s) } catch { return fallback }
}

// PMWEB-DATA: lease_owner→席位 code 归一 — 认 '<code>' / '<code>/<budget>' /
// '<code>@<sub>' 三形态，剥 '/' 与 '@' 后段取 code 前缀；与 service.mjs
// gatherTicketsGraph join 侧同规则（两侧镜像，零共享模块）。归一后仍匹配不到
// 席位的票计入「未分配」，不虚标到任何席位。
const leaseCode = (v) => (typeof v === 'string' && v ? v.split(/[/@]/)[0].trim() : '')

const debounce = (fn, ms) => {
  let t = 0
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms) }
}

const nowHms = () => new Date().toTimeString().slice(0, 8)

const relAge = (iso) => {
  const ms = Date.now() - Date.parse(iso)
  if (!Number.isFinite(ms)) return '—'
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s 前`
  if (s < 3600) return `${Math.floor(s / 60)}m 前`
  if (s < 86400) return `${Math.floor(s / 3600)}h 前`
  return `${Math.floor(s / 86400)}d 前`
}

async function fetchJson(url, opts) {
  try {
    const res = await fetch(url, opts)
    let data = null
    try { data = await res.json() } catch { /* 非 JSON 体 */ }
    return { ok: res.ok, status: res.status, data, err: res.ok ? null : `HTTP ${res.status}` }
  } catch (e) {
    return { ok: false, status: 0, data: null, err: String(e && e.message ? e.message : e) }
  }
}

/* ---- 状态 ---- */

const state = {
  tickets: null, // { ok, data, err }
  fleet: null,
  flow: null,
  graph: null, // PMWEB-DAG: /op/graph (席位组织图血缘源; 只读)
  health: null,
  acts: new Map(), // ref -> entry（页面内存态，可丢；服务侧 registry 为权威）
  sseOpen: null, // PMWEB-DAG: SSE 初态记账 —— canvas.js 是 module（晚于 classic 执行），断连事件可能先于其监听注册到达，初态由此回放
  // PMWEB-ARCHIVE: 票看板手动归档 —— 仅终态票可归档; localStorage 本页持久 (ADR-002
  // 红线: 页面零账本写, 归档是纯观测面折叠, 不改 ledger)。
  archive: loadArchiveSet(),
  archOpen: false, // 归档区展开态 (内存态, 刷新收起)
  // PMWEB-FLEET-SIDE: 席位树展开 + 票侧栏 —— orgTicketsOpen = 展开了持票列表的席位
  // code; fleetSide = 侧栏当前对象 (ticket 只读详情 + 最新 turn end 原文)。
  orgTicketsOpen: new Set(),
  fleetSide: null, // { kind: 'ticket', id } — null = 侧栏收起
  turnEndCache: new Map(), // sessionId -> { ok, turn, step, text, err } (内存态)
}

// PW-003: consumer 每 tab 随机 —— 重载即全量快照回放；tab 内 EventSource
// 自动重连同 consumer，服务侧游标保证快照+增量无缝。
const TAB_ID = 'pm-web-' + Math.random().toString(36).slice(2, 10)
const SSE_KINDS = 'tickets,fleet,flow,act' // act: PW-005 完成事件对账所需

/* ---- 数据加载 ---- */

async function loadTickets() {
  state.tickets = await fetchJson('op/tickets')
  renderTickets()
  renderFleet() // PMWEB-DATA: 持票计数/「未分配」注记依赖票面 — boot 并行加载下 fleet 先渲染时票面未到会缺计, 票面到齐即重渲 (与 loadGraph→renderFleet 同理; renderFleet 自身对 fleet 未到有加载中守卫)
}

async function loadFleet() {
  state.fleet = await fetchJson('op/fleet')
  renderFleet()
}

async function loadFlow() {
  state.flow = await fetchJson('op/flow')
  renderFlow()
}

// PMWEB-DAG: /op/graph 只为席位组织图供血缘 (callback 边 = worker→head 会话血缘)。
async function loadGraph() {
  state.graph = await fetchJson('op/graph')
  renderFleet() // 血缘到齐后重绘席位组织图 (票/流程视图不依赖它)
}

async function pollHealth() {
  state.health = await fetchJson('health')
  renderHealth()
}

// SSE 事件驱动重取（PMWEB-DATA: 同事件窗口合并拉取 — 每 500ms 窗口内同资源至多
// 一次 fetch：tickets 突发 / fleet 复合事件 / act 对账互撞均并成一轮，单事件窗口
// 内 /op/tickets ≤1；watcher+2s reconcile 双通道在服务端已去重，这里再挡一层突发）
const refetch = {
  tickets: debounce(loadTickets, 500),
  fleet: debounce(loadFleet, 500),
  flow: debounce(loadFlow, 500),
  graph: debounce(loadGraph, 500),
}

/* ---- 渲染：票视图 (kanban by state + deps + lease_owner) ---- */

const TICKET_COLS = ['dispatched', 'running', 'blocked', 'done', 'merged', 'rejected']

// PMWEB-ARCHIVE: 归档能力 —— 终态票 (cluster.js TERMINAL_STATES 同口径) 卡上出
// 「归档」钮, 归档票从看板移入底部归档区 (可展开/还原)。纯前端折叠: localStorage
// 持久 (key pmweb:archive:v1), 账本零写 (ADR-002 红线), 服务端 /op/tickets 不动。
const ARCHIVE_KEY = 'pmweb:archive:v1'
const TERMINAL_STATES = new Set(['done', 'merged', 'rejected'])

function loadArchiveSet() {
  try { return new Set(JSON.parse(localStorage.getItem(ARCHIVE_KEY) || '[]').map(String)) } catch { return new Set() }
}
function saveArchiveSet(set) {
  try { localStorage.setItem(ARCHIVE_KEY, JSON.stringify([...set].map(String))) } catch { /* 隐私模式等: 归档退化为会话内存态 */ }
}
function toggleArchive(id) {
  const idStr = String(id)
  state.archive.has(idStr) ? state.archive.delete(idStr) : state.archive.add(idStr)
  saveArchiveSet(state.archive)
  renderTickets()
}

// 票卡左边框色（与 style.css 徽章色一致）
const STATE_COLORS = {
  dispatched: '#e0a93e', running: '#4da3ff', blocked: '#e06c5f', done: '#3fbf7f',
  merged: '#9d7cd8', rejected: '#8a5a54',
}

const emptyNote = (msg) => `<div class="empty-note">${esc(msg)}</div>`
const viewNote = (note) => `<p class="view-note">⚠ ${esc(note)}</p>`

function ticketCard(t, { archived = false } = {}) {
  const deps = parseJsonField(t.deps, [])
  const refs = parseJsonField(t.refs, {})
  const refKeys = refs && typeof refs === 'object' ? Object.keys(refs) : []
  const chips = []
  for (const d of Array.isArray(deps) ? deps : []) chips.push(`<span class="chip dep">↳ ${esc(d)}</span>`)
  if (t.lease_owner) chips.push(`<span class="chip lease">lease: ${esc(t.lease_owner)}</span>`)
  for (const r of refKeys.slice(0, 4)) chips.push(`<span class="chip ref">${esc(r)}</span>`)
  if (refKeys.length > 4) chips.push(`<span class="chip ref">+${refKeys.length - 4}</span>`)
  // PMWEB-ARCHIVE: 终态票卡悬停出归档钮; 归档区票卡出还原钮 (非终态不可归档)
  const isTerminal = TERMINAL_STATES.has(t.state)
  const act = archived
    ? `<button type="button" class="arch-btn" data-unarch="${esc(t.ticket_id)}" title="还原到看板">↩</button>`
    : (isTerminal ? `<button type="button" class="arch-btn" data-arch="${esc(t.ticket_id)}" title="归档 (从看板收起, 本页持久)">✕</button>` : '')
  return `
    <div class="ticket-card${archived ? ' archived' : ''}" style="border-left-color: ${STATE_COLORS[t.state] || 'var(--pending)'}">
      <span class="tid">${esc(t.ticket_id)}</span><span class="state-badge st-${esc(t.state)}">${esc(t.state)}</span>
      <span class="title">${esc(t.title)}</span>
      <span class="chips">${chips.join('')}</span>${act}
    </div>`
}

function renderTickets() {
  const el = $('#view-tickets')
  const r = state.tickets
  if (!r) { el.innerHTML = emptyNote('票面加载中…'); return }
  if (!r.ok) { el.innerHTML = emptyNote(`票面源不可用（服务死或网络断）：${r.err} —— 降级态，CLI/账本不受影响`); return }
  const d = r.data
  const note = d.degraded && d.note ? viewNote(`票面降级：${d.note}`) : ''
  const all = Array.isArray(d.tickets) ? d.tickets : []
  // PMWEB-ARCHIVE: 归档票移出看板 → 底部归档区; 未知 id (账本已删) 丢弃
  const list = []
  const archivedList = []
  for (const t of all) (state.archive.has(String(t.ticket_id)) ? archivedList : list).push(t)
  if (!all.length) {
    el.innerHTML = note + emptyNote(`0 张票${d.note ? ' —— ' + esc(d.note) : '（账本为空或源暂不可用）'}`)
    return
  }
  const cols = new Map(TICKET_COLS.map((c) => [c, []]))
  for (const t of list) {
    if (!cols.has(t.state)) cols.set(t.state, [])
    cols.get(t.state).push(t)
  }
  // 归档区: 默认收起 (计数常显); 展开列出归档票卡 (还原钮)
  const archSection = archivedList.length || state.archive.size
    ? `<div class="archive-bar">
         <button type="button" id="arch-toggle" class="${state.archOpen ? 'open' : ''}">
           归档 <b>${archivedList.length}</b> ${state.archOpen ? '▾' : '▸'}
         </button>
         <span class="dim small">手动归档仅本页折叠 (localStorage), 账本不动</span>
       </div>
       ${state.archOpen ? `<div class="kanban archive-open">${archivedList.map((t) => ticketCard(t, { archived: true })).join('') || emptyNote('归档集非空但票面已无对应票 (账本已删/过期)')}</div>` : ''}`
    : ''
  el.innerHTML = note + `<div class="kanban">${[...cols.entries()].map(([c, ts]) => `
    <div class="col">
      <h3><span>${esc(c)}</span><span>${ts.length}</span></h3>
      ${ts.map((t) => ticketCard(t)).join('')}
    </div>`).join('')}</div>` + archSection
}

// PMWEB-ARCHIVE: 归档钮/还原钮/归档区折叠 — 事件委托常驻 (SSE 全量重渲不丢)
function wireTickets() {
  const el = $('#view-tickets')
  el.addEventListener('click', (e) => {
    const arch = e.target.closest?.('[data-arch]')
    if (arch) { toggleArchive(arch.dataset.arch); return }
    const un = e.target.closest?.('[data-unarch]')
    if (un) { toggleArchive(un.dataset.unarch); return }
    if (e.target.closest?.('#arch-toggle')) { state.archOpen = !state.archOpen; renderTickets() }
  })
}

/* ---- 渲染：席位视图 (组织图 + 小卡 + 详情浮层; PMWEB-DAG 需求 4-7) ---- */
// 需求 4: 本视图零票 DAG 挂载点 (票 DAG 在「图」tab)。
// 需求 5: 组织图 = 血缘树 (callback 边 worker→head, head 在上 worker 在下) + 持票边
//         (lease_owner→席位, 体现为小卡持票数与浮层持票列表); 只吃席位/血缘/持票数据。
// 需求 6: 席位小卡一行缩略 (状态点 + code + 持票数)。
// 需求 7: 点小卡 → 详情浮层 (join 现成字段全量 + 持票列表)。

// 血缘: /op/graph callback 边语义 from=worker session, to=head session (service.mjs
// bridge 派生)。席位级组织树: 子席位挂父席位; 一父多子保持出现序; 多父取首见
// (确定性); visited 防环; 血缘源不可达 → 平铺小卡+注记 (降级优先)。
function lineageOf(seats) {
  const bySid = new Map(seats.filter((s) => s.sessionId).map((s) => [String(s.sessionId), s]))
  const headOf = new Map() // 子席位 code → 父席位 code
  const childrenOf = new Map() // 父席位 code → [子席位 code]
  const g = state.graph
  const edges = g && g.ok && g.data && Array.isArray(g.data.edges) ? g.data.edges : []
  for (const e of edges) {
    if (!e || e.kind !== 'callback') continue
    const w = bySid.get(String(e.from ?? '').replace(/^se:/, ''))
    const h = bySid.get(String(e.to ?? '').replace(/^se:/, ''))
    if (!w || !h || w.code === h.code || headOf.has(w.code)) continue
    headOf.set(w.code, h.code)
    if (!childrenOf.has(h.code)) childrenOf.set(h.code, [])
    childrenOf.get(h.code).push(w.code)
  }
  return { headOf, childrenOf }
}

const STATUS_DOT = {
  active: '#3fbf7f', running: '#4da3ff', ready: '#4da3ff', idle: '#7f8da0',
  stale: '#e0a93e', probing: '#e0a93e', interrupted: '#e06c5f', error: '#e06c5f',
  unknown: '#7f8da0',
}

// 需求 6: 小卡一行 = 状态点 + code + 角色/活性 + 持票数
function seatMini(s, held) {
  const status = s.status || 'unknown'
  const dot = STATUS_DOT[status] || STATUS_DOT.unknown
  const live = s.session && s.session.running ? ' · live' : ''
  return `
    <button type="button" class="seat-mini" data-code="${esc(s.code)}" title="点击查看席位全量信息">
      <span class="seat-dot" style="background:${dot}" title="${esc(status)}"></span>
      <span class="sm-code mono">${esc(s.code)}</span>
      <span class="sm-role">${esc(s.role || '—')}${live}</span>
      <span class="sm-held">${held} 票</span>
    </button>`
}

// PMWEB-FLEET-SIDE: 席位执行的票按顺序出来 — updated_at 升序 (执行完成序),
// 同刻回退 ticket_id 自然序 (数值感知: AND1-2 < AND1-10)。
function orderedHeld(code) {
  const tk = state.tickets
  const list = tk && tk.ok && Array.isArray(tk.data.tickets)
    ? tk.data.tickets.filter((t) => leaseCode(t.lease_owner) === code) : []
  return list.sort((a, b) =>
    String(a.updated_at || '').localeCompare(String(b.updated_at || '')) ||
    String(a.ticket_id).localeCompare(String(b.ticket_id), undefined, { numeric: true }))
}

function orgBranch(code, seatsByCode, childrenOf, rendered, heldCounts) {
  const s = seatsByCode.get(code)
  if (!s || rendered.has(code)) return ''
  rendered.add(code)
  const kids = childrenOf.get(code) || []
  // PMWEB-FLEET-SIDE: 树状展开 — 席位卡侧 chevron 展开该席位执行的票 (有序),
  // 点票行开侧栏 (不弹窗)。默认收起; 展开态会话内存 (SSE 重渲保持)。
  const held = orderedHeld(code)
  const open = state.orgTicketsOpen.has(code)
  const toggle = held.length
    ? `<button type="button" class="org-toggle" data-org="${esc(code)}"
         title="${open ? '收起持票列表' : '展开持票列表 (按 updated_at 执行序)'}">${open ? '▾' : '▸'} ${held.length}</button>`
    : ''
  const ticketsHtml = !open ? '' : (!held.length
    ? '<div class="org-tickets dim small">无持票</div>'
    : `<div class="org-tickets">${held.map((t, i) => `
        <button type="button" class="tk-row" data-tk="${esc(t.ticket_id)}" title="点击在侧栏查看详情 + 最新 turn end 原文">
          <span class="tk-idx">${i + 1}</span>
          <span class="state-badge st-${esc(t.state)}">${esc(t.state)}</span>
          <span class="mono">${esc(t.ticket_id)}</span>
          <span class="tk-title">${esc(t.title || '')}</span>
        </button>`).join('')}</div>`)
  return `
    <div class="org-node" data-code="${esc(code)}">
      <div class="org-row">${seatMini(s, heldCounts.get(code) || 0)}${toggle}</div>
      ${ticketsHtml}
      ${kids.length ? `<div class="org-children">${kids.map((k) => orgBranch(k, seatsByCode, childrenOf, rendered, heldCounts)).join('')}</div>` : ''}
    </div>`
}

function renderFleet() {
  const el = $('#view-fleet')
  const r = state.fleet
  if (!r) { el.innerHTML = emptyNote('席位加载中…'); return }
  if (!r.ok) { el.innerHTML = emptyNote(`席位源不可用：${r.err}`); return }
  const d = r.data
  const note = d.degraded && d.note ? viewNote(`席位降级：${d.note}`) : ''
  const seats = Array.isArray(d.seats) ? d.seats : []
  if (!seats.length) {
    el.innerHTML = note + emptyNote(`0 席位${d.note ? ' —— ' + esc(d.note) : '（fleet.json 空：无在场 worker）'}`)
    return
  }
  // 持票计数 + 持票列表 (PMWEB-DATA: 票面 lease_owner 先归一为席位 code 再计数;
  // 命中席位 → 小卡持票数 + 浮层持票列表; 归一后无席位认领 → 计入「未分配」注记,
  // 不虚标到任何席位。/op/tickets 可得时)
  const seatsByCode = new Map(seats.map((s) => [s.code, s]))
  const heldCounts = new Map()
  const heldBy = new Map()
  const unassigned = new Map() // 归一 code -> [tickets]（席位外）
  const tk = state.tickets
  if (tk && tk.ok && Array.isArray(tk.data.tickets)) {
    for (const t of tk.data.tickets) {
      if (!t.lease_owner) continue
      const code = leaseCode(t.lease_owner)
      if (!code) continue
      const bucket = seatsByCode.has(code) ? heldBy : unassigned
      if (!bucket.has(code)) bucket.set(code, [])
      bucket.get(code).push(t)
      if (bucket === heldBy) heldCounts.set(code, heldBy.get(code).length)
    }
  }
  const { headOf, childrenOf } = lineageOf(seats)
  const rendered = new Set()
  const roots = seats.filter((s) => !headOf.has(s.code)).map((s) => s.code)
  const tree = roots.map((c) => orgBranch(c, seatsByCode, childrenOf, rendered, heldCounts)).join('')
  const missed = seats.filter((s) => !rendered.has(s.code))
    .map((s) => orgBranch(s.code, seatsByCode, childrenOf, rendered, heldCounts)).join('') // 环防漏
  const lineageNote = (state.graph && state.graph.ok)
    ? ''
    : viewNote('血缘源 (/op/graph) 不可达 —— 组织图退化为平铺小卡（降级优先，CLI/账本不受影响）')
  // PMWEB-DATA: 归一后无席位认领的持票 → 「未分配」如实注记，不虚标到任何席位小卡
  const unassignedNote = unassigned.size
    ? viewNote(`未分配持票 ${[...unassigned.values()].reduce((a, l) => a + l.length, 0)} 张（归一 code: ${[...unassigned.keys()].map((c) => esc(c)).join(', ')} —— 无席位认领，不计入任何席位）`)
    : ''
  el.innerHTML = note + lineageNote + unassignedNote + `<div class="org-chart">${tree}${missed}</div>` + '<aside id="fleet-side" hidden></aside>'
  renderFleetSide() // PMWEB-FLEET-SIDE: SSE 重渲后侧栏跟随 (选中票还在场才复显)
}

/* ---- PMWEB-FLEET-SIDE: 票侧栏 (只读详情 + 最新 turn end 原文) ---- */
// 数据: 票字段 = state.tickets (零额外请求); turn end 原文 = /op/trace
// (PM-005 只读投影) 取该票 lease 席位 session 的**最后一条带 text block 的
// assistant/message** —— 即 agent 最近一次 end turn 的原文。turn/end 记录只带
// (turn, reason) 无正文; trace fold (head.compact) 保尾不保头, 最新正文恒在
// kept tail —— 取不到时如实注记, 不造数据 (降级优先)。
function findTicket(id) {
  const tk = state.tickets
  const list = tk && tk.ok && Array.isArray(tk.data.tickets) ? tk.data.tickets : []
  return list.find((t) => String(t.ticket_id) === String(id)) || null
}

function seatSessionOf(t) {
  const code = leaseCode(t.lease_owner)
  const fleet = state.fleet
  const seats = fleet && fleet.ok && Array.isArray(fleet.data.seats) ? fleet.data.seats : []
  const s = seats.find((x) => x.code === code)
  return { code, sessionId: (s && s.sessionId) || null }
}

async function fetchTurnEnd(sid) {
  const cached = state.turnEndCache.get(sid)
  if (cached) return cached
  const r = await fetchJson(`op/trace?sessionId=${encodeURIComponent(sid)}&type=${encodeURIComponent('assistant/message')}`)
  let out
  if (!r.ok || !r.data) out = { err: r.err || 'trace 源不可用' }
  else if (r.data.status === 'miss') out = { err: '无会话目录 (trace status=miss — 会话已清或 sid 失效)' }
  else {
    const ents = (Array.isArray(r.data.entries) ? r.data.entries : []).filter((e) => e && e.type === 'assistant/message')
    let found = null
    for (let i = ents.length - 1; i >= 0 && !found; i--) {
      const m = ents[i].data && ents[i].data.message
      const blocks = Array.isArray(m && m.content) ? m.content : []
      const text = blocks.filter((b) => b && b.type === 'text').map((b) => String(b.text || '')).join('\n').trim()
      if (text) found = { turn: ents[i].data.turn, step: ents[i].data.step, text }
    }
    out = found || { err: 'trace 尾部无带 text 的 assistant/message (该会话最近未产出结论文本)' }
  }
  state.turnEndCache.set(sid, out)
  return out
}

function renderFleetSide() {
  const aside = $('#fleet-side')
  if (!aside) return
  const sel = state.fleetSide
  const t = sel && sel.kind === 'ticket' ? findTicket(sel.id) : null
  if (!t) { state.fleetSide = null; aside.hidden = true; aside.innerHTML = ''; return }
  const deps = parseJsonField(t.deps, [])
  const refs = parseJsonField(t.refs, {})
  const refKeys = refs && typeof refs === 'object' ? Object.keys(refs) : []
  const { code, sessionId } = seatSessionOf(t)
  aside.hidden = false
  aside.innerHTML = `
    <div class="fs-head"><h3>票 ${esc(t.ticket_id)}</h3><button type="button" class="fs-close" title="关闭侧栏">×</button></div>
    <p class="fs-title">${esc(t.title || '')}</p>
    <dl class="fs-fields">
      <dt>state</dt><dd><span class="state-badge st-${esc(t.state)}">${esc(t.state)}</span></dd>
      <dt>lease</dt><dd>${t.lease_owner ? `${esc(t.lease_owner)} → 席位 <span class="mono">${esc(code)}</span>` : '<span class="dim">未派发</span>'}</dd>
      <dt>updated_at</dt><dd class="mono small">${esc(t.updated_at || '—')}</dd>
      <dt>outcome</dt><dd class="small">${esc(t.outcome && t.outcome !== 'None' ? t.outcome : '—')}</dd>
      <dt>deps</dt><dd>${(Array.isArray(deps) && deps.length) ? deps.map((d) => `<span class="chip dep">↳ ${esc(d)}</span>`).join(' ') : '<span class="dim">—</span>'}</dd>
      <dt>refs</dt><dd class="small">${refKeys.length ? refKeys.map((k) => `<span class="chip ref">${esc(k)}=${esc(String(refs[k]))}</span>`).join(' ') : '<span class="dim">—</span>'}</dd>
    </dl>
    <div class="fs-turn">
      <h4>最新一次 turn end 原文 <span class="dim small" id="fs-turn-meta">${sessionId ? '加载中…' : '无执行会话'}</span></h4>
      <pre class="fs-turn-text" id="fs-turn-text">${sessionId ? '' : '<span class="dim">该票 lease 席位当前无 sessionId（fleet join 断或席位未在场）</span>'}</pre>
    </div>`
  const fill = (res) => {
    const meta = $('#fs-turn-meta'); const pre = $('#fs-turn-text')
    if (!meta || !pre) return
    if (res.err) { meta.textContent = '不可得'; pre.innerHTML = `<span class="dim">${esc(res.err)}</span>`; return }
    meta.textContent = `turn ${res.turn}${res.step != null ? ` · step ${res.step}` : ''} · sid ${String(sessionId).replace(/^session-/, '').slice(0, 8)}`
    pre.textContent = res.text
  }
  aside.querySelector('.fs-close').addEventListener('click', () => { state.fleetSide = null; renderFleetSide() })
  if (!sessionId) return
  const cached = state.turnEndCache.get(sessionId)
  if (cached) { fill(cached); return }
  fetchTurnEnd(sessionId).then((res) => {
    const cur = state.fleetSide // 侧栏已切走/关闭 → 丢弃 (SSE 重渲走 renderFleetSide 缓存路径)
    if (!cur || cur.kind !== 'ticket' || String(cur.id) !== String(sel.id)) return
    fill(res)
  }).catch(() => { /* fetchJson 已兜 err; 此处静默保持加载中文案不再变动即降级 */ })
}

function openTicketSide(id) {
  state.fleetSide = { kind: 'ticket', id: String(id) }
  renderFleetSide()
  const aside = $('#fleet-side')
  if (aside && !aside.hidden) aside.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
}

/* ---- 席位详情浮层 (需求 7: join 现成字段全量 + 持票列表 + 血缘, 关闭返回) ---- */

const sdRow = (k, v) => `<div class="sd-row"><dt>${esc(k)}</dt><dd>${v}</dd></div>`
const sdVal = (v) => v == null || v === ''
  ? '<span class="dim">—</span>'
  : (typeof v === 'object' ? `<span class="mono small">${esc(JSON.stringify(v))}</span>` : esc(String(v)))

function seatDetailHtml(code) {
  const r = state.fleet
  const seats = r && r.ok && r.data && Array.isArray(r.data.seats) ? r.data.seats : []
  const s = seats.find((x) => x.code === code)
  if (!s) return '<p class="dim small">席位已不在场（fleet 已刷新）——关闭返回。</p>'
  const rows = []
  for (const [k, v] of Object.entries(s)) { // join 现成字段全量 (服务侧日后新增字段自动展示)
    if (k === 'session') continue
    rows.push(sdRow(k, k === 'spawnedAt' ? `${sdVal(v)} <span class="dim small">(${relAge(v)})</span>` : sdVal(v)))
  }
  if (s.session && typeof s.session === 'object') {
    for (const [k, v] of Object.entries(s.session)) rows.push(sdRow(`session.${k}`, k === 'title' ? `<span class="small">${sdVal(v)}</span>` : sdVal(v)))
  }
  // 持票列表 (持票边 lease_owner→seat; PMWEB-DATA: 同 renderFleet 归一口径;
  // PMWEB-FLEET-SIDE: 有序 (updated_at 执行序) + 行可点 → 侧栏, 不再止步浮层)
  const held = orderedHeld(code)
  const heldHtml = held.length
    ? held.map((t) => `<li><button type="button" class="tk-row" data-tk="${esc(t.ticket_id)}" title="点击在侧栏查看详情 + 最新 turn end 原文"><span class="state-badge st-${esc(t.state)}">${esc(t.state)}</span> <span class="mono">${esc(t.ticket_id)}</span> <span class="dim small">${esc(t.title || '')}</span></button></li>`).join('')
    : '<li class="dim small">无持票 (lease_owner 未指向本席位)</li>'
  // 血缘 (上下级)
  const { headOf, childrenOf } = lineageOf(seats)
  const head = headOf.get(code)
  const kids = childrenOf.get(code) || []
  return `
    <dl class="sd-fields">${rows.join('')}</dl>
    <div class="sd-held">
      <h3>持票 <span class="dim small">(lease_owner → 本席位 · ${held.length} 张)</span></h3>
      <ul>${heldHtml}</ul>
    </div>
    <div class="sd-lineage">
      <h3>血缘 <span class="dim small">(会话 callback 边)</span></h3>
      ${sdRow('上级 head', head ? `<span class="mono">${esc(head)}</span>` : '<span class="dim">— (根/无血缘)</span>')}
      ${sdRow('下级 worker', kids.length ? kids.map((k) => `<span class="mono">${esc(k)}</span>`).join(' ') : '<span class="dim">—</span>')}
    </div>`
}

function openSeatDetail(code) {
  const dlg = $('#seat-detail')
  if (!dlg) return
  $('#sd-title').textContent = `席位 ${code} · 全量信息`
  $('#sd-body').innerHTML = seatDetailHtml(code)
  dlg.showModal()
}

function wireSeatDetail() {
  const el = $('#view-fleet')
  el.addEventListener('click', (e) => {
    const mini = e.target.closest?.('.seat-mini')
    if (mini) { openSeatDetail(mini.dataset.code); return }
    // PMWEB-FLEET-SIDE: 树展开 chevron + 票行 → 侧栏
    const tog = e.target.closest?.('.org-toggle')
    if (tog) {
      const code = tog.dataset.org
      state.orgTicketsOpen.has(code) ? state.orgTicketsOpen.delete(code) : state.orgTicketsOpen.add(code)
      renderFleet()
      return
    }
    const row = e.target.closest?.('.tk-row')
    if (row) openTicketSide(row.dataset.tk)
  })
  const dlg = $('#seat-detail')
  if (!dlg) return
  // 浮层内持票行可点 → 关浮层开侧栏 (点击票本弹出信息窗改为侧栏显示)
  dlg.addEventListener('click', (e) => {
    const row = e.target.closest?.('.tk-row')
    if (row) { dlg.close(); openTicketSide(row.dataset.tk) }
  })
  $('#sd-close').addEventListener('click', () => dlg.close())
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close() }) // 点背景关闭
}

/* ---- 渲染：流程视图 (flow 节点状态推进) ---- */

function flowBlock(f) {
  const rows = (Array.isArray(f.nodes) ? f.nodes : []).map((n) => `
    <tr>
      <td class="mono">${esc(n.node_id)}</td>
      <td><span class="state-badge st-${esc(n.state)}">${esc(n.state)}</span></td>
      <td class="mono">${esc(n.verb)}</td>
      <td>${esc(n.title || n.node_id)}</td>
      <td class="mono">${esc(n.attempts)}</td>
      <td class="mono">${esc(n.events)}</td>
    </tr>`).join('')
  return `
    <div class="flow-block">
      <h3>${esc(f.flow)} <span class="dim">· ${f.nodes ? f.nodes.length : 0} 节点${f.degraded ? ' · <span style="color:var(--warn)">degraded</span>' : ''}</span></h3>
      <table>
        <thead><tr><th>node</th><th>state</th><th>verb</th><th>title</th><th>att</th><th>ev</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`
}

function renderFlow() {
  const el = $('#view-flow')
  const r = state.flow
  if (!r) { el.innerHTML = emptyNote('流程加载中…'); return }
  if (!r.ok) { el.innerHTML = emptyNote(`流程源不可用：${r.err}`); return }
  const d = r.data
  const note = d.degraded && d.note ? viewNote(`流程降级：${d.note}`) : ''
  const flows = Array.isArray(d.flows) ? d.flows : []
  if (!flows.length) {
    el.innerHTML = note + emptyNote(`0 个 flow${d.note ? ' —— ' + esc(d.note) : '（flows/ 目录为空）'}`)
    return
  }
  el.innerHTML = note + flows.map(flowBlock).join('')
}

/* ---- 渲染：health 横幅 (PW-004, 30s 轮询) ---- */

// PMW1-4(c): 按源给准确影响说明——/health 的 source 是探测面，不是每个
// 都兑现为"视图空态"（如 tickets_md 仅签名面；dsh_api 只影响席位 join）。
// 视图是否空态/stale 以各视图自身 note 为准（降级优先，mvp-plan §6.5）。
const SRC_EFFECT = {
  ledger: '票面拉取面(CLI)降级 → 票视图 stale/空态+note',
  tickets_md: 'tickets.md 签名面降级 → 不影响数据新鲜度（缓存键已对齐 ledger.db，PMW1-4）',
  fleet: '席位源降级 → 席位视图空态+note',
  sessions: 'session 根降级 → 影响轨迹源（pm-web 未挂轨迹视图）',
  flows: '流程源降级 → 流程视图空态+note',
  dsh_api: 'dsh RPC 不可达 → 席位 join 退化为纯席位表',
  singleton: '单实例锁失效 → 可能双实例（HF-014 可视降级态）',
}

function renderHealth() {
  const badge = $('#health-badge')
  const banner = $('#banner')
  const r = state.health
  if (!r || !r.ok || !r.data) {
    badge.textContent = 'health 不可达'
    badge.className = 'badge err'
    banner.hidden = false
    banner.textContent = '⚠ /health 不可达 —— 服务疑似已死（红线3：观测面暂不可用，CLI/账本不受影响）；重启后刷新本页。'
    return
  }
  const d = r.data
  $('#svc-meta').textContent = `v${d.version} · :${location.port}`
  if (d.status === 'ok') {
    badge.textContent = `health ok (v${d.version})`
    badge.className = 'badge ok'
    banner.hidden = true
    return
  }
  badge.textContent = `health degraded`
  badge.className = 'badge warn'
  const dead = Array.isArray(d.degraded) ? d.degraded : []
  const effects = dead.map((s) => SRC_EFFECT[s]).filter(Boolean)
  banner.hidden = false
  banner.textContent = `⚠ 降级源：${dead.join(', ')}。${effects.join('；')} —— 视图是否空态以各视图自身 note 为准（降级优先，mvp-plan §6.5）`
}

/* ---- 事件流日志 ---- */

function logEvent(ev) {
  const ul = $('#event-log')
  const li = document.createElement('li')
  li.innerHTML = `<span class="dim">${nowHms()}</span> <span class="k">${esc(ev.kind)}</span>` +
    ` <span class="dim">${esc(ev.source)}</span> seq=${esc(ev.seq)}` +
    (ev.replay ? ' <span class="rp">[replay]</span>' : '')
  ul.prepend(li)
  while (ul.children.length > 10) ul.removeChild(ul.lastChild)
}

/* ---- SSE (PW-003: 快照回放 + 增量重绘) ---- */

function connectSse() {
  const badge = $('#sse-badge')
  $('#consumer-name').textContent = TAB_ID
  const es = new EventSource(`subscribe?consumer=${encodeURIComponent(TAB_ID)}&kinds=${SSE_KINDS}`)
  es.onopen = () => {
    state.sseOpen = true
    badge.textContent = 'SSE 已订阅'
    badge.className = 'badge ok'
    window.dispatchEvent(new CustomEvent('pm:sse-state', { detail: { open: true } })) // PMW2-2 画布: 断线轮询窗
  }
  es.onerror = () => {
    // 浏览器原生自动重连；此处只亮态，不造数据（降级优先）
    state.sseOpen = false
    badge.textContent = 'SSE 断连，自动重连中…'
    badge.className = 'badge err'
    window.dispatchEvent(new CustomEvent('pm:sse-state', { detail: { open: false } })) // PMW2-2 画布: 转 30s 轮询
  }
  es.onmessage = (m) => {
    let ev
    try { ev = JSON.parse(m.data) } catch { return }
    if (ev.t === 'pm_sub_ended') { // 同 consumer 被新流替换（本 tab 重连竞态）
      logEvent({ kind: 'pm_sub_ended', source: ev.consumer, seq: '-' })
      return
    }
    if (ev.t !== 'pm.event') return
    logEvent(ev)
    window.dispatchEvent(new CustomEvent('pm:sse', { detail: ev })) // PMW2-2 画布: 复用同一连接, 画布侧自行去抖
    if (ev.kind === 'tickets') refetch.tickets()
    else if (ev.kind === 'fleet') { refetch.fleet(); refetch.tickets(); refetch.graph() } // 持票计数依赖票面; 组织图血缘跟 fleet/bridge
    else if (ev.kind === 'flow') refetch.flow()
    else if (ev.kind === 'act') onActEvent(ev)
  }
}

/* ---- 写动作 (PW-005: 确认弹层 → POST /op/act → ref 回显 → SSE 对账) ---- */

function actEntryHtml(e) {
  const detail = [
    `argv: ${JSON.stringify(e.args)}`,
    e.ms != null ? `耗时 ${e.ms}ms` : null,
    e.exitCode != null ? `exit ${e.exitCode}` : null,
    e.err ? `err: ${e.err}` : null,
  ].filter(Boolean).join(' · ')
  return `
    <li>
      <div class="act-head">
        <span class="ref">${esc(e.ref)}</span>
        <span><span class="state-badge st-${esc(e.status)}">${esc(e.status)}</span> <span class="dim">${esc(e.tool)}</span></span>
      </div>
      <div class="act-detail">${esc(detail)}</div>
    </li>`
}

function renderActs() {
  const ul = $('#act-log')
  const entries = [...state.acts.values()].sort((a, b) => (b.submittedMs || 0) - (a.submittedMs || 0)).slice(0, 12)
  ul.innerHTML = entries.map(actEntryHtml).join('') || '<li class="dim small">尚无动作</li>'
}

function onActEvent(ev) { // SSE 完成事件：ref 对账（PM-008 契约）
  const e = state.acts.get(ev.ref)
  if (e) {
    e.status = ev.status
    e.exitCode = ev.exitCode
    e.ms = ev.ms
    e.err = ev.err
    e.finishedAt = true
    renderActs()
  }
  if (ev.status === 'ok' || ev.status === 'error') { // CLI 已落地 → 数据面可能已变
    refetch.tickets()
    refetch.flow()
  }
}

async function submitAct(tool, args) {
  const res = await fetchJson('op/act', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool, args }),
  })
  if (!res.ok || !res.data || !res.data.accepted) {
    state.acts.set(`reject-${Date.now()}`, {
      ref: '—', tool, args, status: 'error', err: (res.data && (res.data.error || res.data.note)) || res.err || 'rejected',
    })
    renderActs()
    return
  }
  const d = res.data // phase-1 回执 {accepted, ref}
  state.acts.set(d.ref, {
    ref: d.ref, tool: d.tool, args, status: d.replay ? d.status : 'flying',
    exitCode: d.replay ? d.exitCode : null, ms: null,
    err: d.replay ? 'replay: registry 应答，零二次 CLI spawn' : null,
    submittedMs: Date.now(), finishedAt: !!d.replay,
  })
  renderActs()
}

function wireActForm() {
  const form = $('#act-form')
  const dlg = $('#act-confirm')
  form.addEventListener('submit', (e) => {
    e.preventDefault()
    const tool = $('#act-tool').value
    let args
    try { args = JSON.parse($('#act-args').value) } catch {
      form.reportValidity && $('#act-args').reportValidity()
      return
    }
    if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) return
    $('#confirm-cmd').textContent = `${tool} ${args.map((a) => JSON.stringify(a)).join(' ')}`
    const rv = dlg.showModal() // 返回值无意义；下面读 button value
    void rv
  })
  dlg.addEventListener('close', () => {
    if (dlg.returnValue !== 'ok') return
    const tool = $('#act-tool').value
    const args = JSON.parse($('#act-args').value)
    submitAct(tool, args)
  })
}

/* ---- tab 切换 ---- */

// tab 激活单一入口: 切视图 + 落 hash (boot 时按 hash 恢复, 非法回退 view-tickets; 审计 #108)
function wireTabs() {
  const buttons = document.querySelectorAll('#tabs button')
  const known = new Set([...buttons].map((b) => b.dataset.view))
  const hashView = () => {
    const m = /^view-([a-z]+)$/.exec(location.hash.slice(1))
    return m && known.has(m[1]) ? m[1] : null
  }
  const activate = (name, { viaHash = false } = {}) => {
    if (!known.has(name)) name = 'tickets'
    buttons.forEach((x) => x.classList.toggle('active', x.dataset.view === name))
    for (const sec of document.querySelectorAll('.view')) sec.hidden = sec.id !== `view-${name}`
    if (!viaHash && `#view-${name}` !== location.hash) location.hash = `view-${name}`
    window.scrollTo({ top: 0 }) // 切 tab 回顶 (168 卡列表滚到深处切 tab 不再留在页底)
  }
  buttons.forEach((b) => b.addEventListener('click', () => activate(b.dataset.view)))
  window.addEventListener('hashchange', () => activate(hashView() ?? 'tickets', { viaHash: true }))
  activate(hashView() ?? 'tickets', { viaHash: true }) // boot: hash 合法即恢复, 否则回票视图
}

/* ---- 启动 ---- */

function boot() {
  wireTabs()
  wireActForm()
  wireTickets() // PMWEB-ARCHIVE: 归档委托
  wireSeatDetail() // PMWEB-DAG: 席位小卡 → 详情浮层; PMWEB-FLEET-SIDE: 树展开+票侧栏
  renderActs()
  loadTickets()
  loadFleet()
  loadFlow()
  loadGraph() // 组织图血缘源
  pollHealth()
  setInterval(pollHealth, 30_000) // PW-004: 30s 轮询
  connectSse() // PW-003
}

boot()
