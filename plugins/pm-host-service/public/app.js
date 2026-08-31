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
  health: null,
  acts: new Map(), // ref -> entry（页面内存态，可丢；服务侧 registry 为权威）
}

// PW-003: consumer 每 tab 随机 —— 重载即全量快照回放；tab 内 EventSource
// 自动重连同 consumer，服务侧游标保证快照+增量无缝。
const TAB_ID = 'pm-web-' + Math.random().toString(36).slice(2, 10)
const SSE_KINDS = 'tickets,fleet,flow,act' // act: PW-005 完成事件对账所需

/* ---- 数据加载 ---- */

async function loadTickets() {
  state.tickets = await fetchJson('/op/tickets')
  renderTickets()
}

async function loadFleet() {
  state.fleet = await fetchJson('/op/fleet')
  renderFleet()
}

async function loadFlow() {
  state.flow = await fetchJson('/op/flow')
  renderFlow()
}

async function pollHealth() {
  state.health = await fetchJson('/health')
  renderHealth()
}

// SSE 事件驱动重取（去抖：watcher+2s reconcile 双通道在服务端已去重，
// 这里再挡一层突发）
const refetch = {
  tickets: debounce(loadTickets, 400),
  fleet: debounce(loadFleet, 400),
  flow: debounce(loadFlow, 400),
}

/* ---- 渲染：票视图 (kanban by state + deps + lease_owner) ---- */

const TICKET_COLS = ['dispatched', 'running', 'blocked', 'done', 'merged', 'rejected']

// 票卡左边框色（与 style.css 徽章色一致）
const STATE_COLORS = {
  dispatched: '#e0a93e', running: '#4da3ff', blocked: '#e06c5f', done: '#3fbf7f',
  merged: '#9d7cd8', rejected: '#8a5a54',
}

const emptyNote = (msg) => `<div class="empty-note">${esc(msg)}</div>`
const viewNote = (note) => `<p class="view-note">⚠ ${esc(note)}</p>`

function ticketCard(t) {
  const deps = parseJsonField(t.deps, [])
  const refs = parseJsonField(t.refs, {})
  const refKeys = refs && typeof refs === 'object' ? Object.keys(refs) : []
  const chips = []
  for (const d of Array.isArray(deps) ? deps : []) chips.push(`<span class="chip dep">↳ ${esc(d)}</span>`)
  if (t.lease_owner) chips.push(`<span class="chip lease">lease: ${esc(t.lease_owner)}</span>`)
  for (const r of refKeys.slice(0, 4)) chips.push(`<span class="chip ref">${esc(r)}</span>`)
  if (refKeys.length > 4) chips.push(`<span class="chip ref">+${refKeys.length - 4}</span>`)
  return `
    <div class="ticket-card" style="border-left-color: ${STATE_COLORS[t.state] || 'var(--pending)'}">
      <span class="tid">${esc(t.ticket_id)}</span><span class="state-badge st-${esc(t.state)}">${esc(t.state)}</span>
      <span class="title">${esc(t.title)}</span>
      <span class="chips">${chips.join('')}</span>
    </div>`
}

function renderTickets() {
  const el = $('#view-tickets')
  const r = state.tickets
  if (!r) { el.innerHTML = emptyNote('票面加载中…'); return }
  if (!r.ok) { el.innerHTML = emptyNote(`票面源不可用（服务死或网络断）：${r.err} —— 降级态，CLI/账本不受影响`); return }
  const d = r.data
  const note = d.degraded && d.note ? viewNote(`票面降级：${d.note}`) : ''
  const list = Array.isArray(d.tickets) ? d.tickets : []
  if (!list.length) {
    el.innerHTML = note + emptyNote(`0 张票${d.note ? ' —— ' + esc(d.note) : '（账本为空或源暂不可用）'}`)
    return
  }
  const cols = new Map(TICKET_COLS.map((c) => [c, []]))
  for (const t of list) {
    if (!cols.has(t.state)) cols.set(t.state, [])
    cols.get(t.state).push(t)
  }
  el.innerHTML = note + `<div class="kanban">${[...cols.entries()].map(([c, ts]) => `
    <div class="col">
      <h3><span>${esc(c)}</span><span>${ts.length}</span></h3>
      ${ts.map(ticketCard).join('')}
    </div>`).join('')}</div>`
}

/* ---- 渲染：席位视图 (卡片 + 持票 + 相对年龄) ---- */

function seatCard(s, leaseCounts) {
  const held = leaseCounts.get(s.code) || 0
  const ses = s.session
  const status = s.status || 'unknown'
  return `
    <div class="seat-card">
      <div class="seat-head">
        <span class="code">${esc(s.code)}</span>
        <span class="state-badge st-${esc(status)}">${esc(status)}</span>
        <span class="role">${esc(s.role || '—')}</span>
      </div>
      <dl>
        <dt>node</dt><dd>${esc(s.node || '—')}</dd>
        <dt>preset</dt><dd>${esc(s.preset || '—')}</dd>
        <dt>spawned</dt><dd>${esc(s.spawnedAt || '—')} <span class="dim">(${relAge(s.spawnedAt)})</span></dd>
        <dt>持票(lease)</dt><dd>${held} 张</dd>
        <dt>session</dt><dd>${ses ? (ses.running ? 'running' : 'idle') : '未 join'}</dd>
      </dl>
      <div class="session-title">${ses && ses.title ? esc(ses.title) : (ses ? '（无标题）' : 'dsh session 不可达或已归档')}</div>
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
  // 持票计数：票面 lease_owner -> seat code（/op/tickets 数据可得时）
  const leaseCounts = new Map()
  const tk = state.tickets
  if (tk && tk.ok && Array.isArray(tk.data.tickets)) {
    for (const t of tk.data.tickets) {
      if (t.lease_owner) leaseCounts.set(t.lease_owner, (leaseCounts.get(t.lease_owner) || 0) + 1)
    }
  }
  el.innerHTML = note + `<div class="fleet-grid">${seats.map((s) => seatCard(s, leaseCounts)).join('')}</div>`
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
  const es = new EventSource(`/subscribe?consumer=${encodeURIComponent(TAB_ID)}&kinds=${SSE_KINDS}`)
  es.onopen = () => {
    badge.textContent = 'SSE 已订阅'
    badge.className = 'badge ok'
    window.dispatchEvent(new CustomEvent('pm:sse-state', { detail: { open: true } })) // PMW2-2 画布: 断线轮询窗
  }
  es.onerror = () => {
    // 浏览器原生自动重连；此处只亮态，不造数据（降级优先）
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
    else if (ev.kind === 'fleet') { refetch.fleet(); refetch.tickets() } // 持票计数依赖票面
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
  const res = await fetchJson('/op/act', {
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

function wireTabs() {
  const buttons = document.querySelectorAll('#tabs button')
  buttons.forEach((b) => b.addEventListener('click', () => {
    buttons.forEach((x) => x.classList.toggle('active', x === b))
    for (const sec of document.querySelectorAll('.view')) sec.hidden = sec.id !== `view-${b.dataset.view}`
  }))
}

/* ---- 启动 ---- */

function boot() {
  wireTabs()
  wireActForm()
  renderActs()
  loadTickets()
  loadFleet()
  loadFlow()
  pollHealth()
  setInterval(pollHealth, 30_000) // PW-004: 30s 轮询
  connectSse() // PW-003
}

boot()
