// pm-web 聚合层 — PMWEB-DAG: 票按 DAG 聚合 (spec: 聚合键双轨+兜底, 按序)。
// 纯函数模块: 零 DOM / 零 fetch / 零构建 —— 供 canvas.js (图 tab 聚合 DAG 场景)
// 与 gates 单测 (node 直 import) 共用。数据形状照 /op/tickets:
// ticket.deps / ticket.refs 是 JSON 编码字符串 (ledger 字段原样), 其余字段原形。
// 聚合语义 (每票按序取第一个命中的轨道, 轨道间不跨界合并):
//   ① refs.run 相同 → 同 run 簇
//   ② deps 连通分量 (真 DAG 语义; 仅计两端都在场内的 deps 边, 分量>1 才成簇)
//   ③ ticket_id 前缀族 (最后一个 '-' 之前的前缀, ≥2 才成簇; 无连字符 → 不适用)
//   ④ 单票自簇
// 已知事实防呆: R26-R36 批次 deps=[] (真 DAG 在 dais task 层) —— ② 不会把
// 零边批次吞成一个巨型分量; OF-* 族靠 deps 边成簇。
'use strict'

// JSON 编码字段解析 (与 app.js parseJsonField 同形; 独立副本保持本模块零依赖)
export function parseJsonField(s, fallback) {
  if (s == null || s === '') return fallback
  try { return JSON.parse(s) } catch { return fallback }
}

// 活跃(非终态)口径: done/merged/rejected 为终态, 其余 (dispatched/running/blocked
// 及未知态) 计活跃 —— 簇头「活跃数」用。
export const TERMINAL_STATES = new Set(['done', 'merged', 'rejected'])
export const isActiveState = (st) => !TERMINAL_STATES.has(st)

export function ticketDeps(t) { // deps 字段 → string[] (脏形防御: 非 JSON/非数组 → [])
  const d = parseJsonField(t?.deps, [])
  return Array.isArray(d) ? d.filter((x) => x != null && x !== '').map(String) : []
}

export function ticketRun(t) { // refs.run → string | null
  const r = parseJsonField(t?.refs, null)
  const run = r && typeof r === 'object' && !Array.isArray(r) ? r.run : null
  return run == null || run === '' ? null : String(run)
}

export function ticketPrefix(id) { // 'AND1-1' → 'AND1'; 无连字符/空前缀 → null
  const s = String(id ?? '')
  const i = s.lastIndexOf('-')
  return i > 0 ? s.slice(0, i) : null
}

// clusterTickets(tickets) → 簇数组 (互斥全覆盖, 一票恰属一簇):
//   { key, kind: 'run'|'deps'|'prefix'|'single', label,
//     ticketIds: [升序], total, active, states: {state: n} }
// key 稳定 (run:<run> / cdep:<最小票id> / fam:<前缀> / one:<票id>), 重拉幂等。
export function clusterTickets(tickets) {
  const list = Array.isArray(tickets) ? tickets.filter((t) => t && t.ticket_id != null) : []
  const byId = new Map(list.map((t) => [String(t.ticket_id), t]))
  // 轨道①: run 分组
  const runGroups = new Map() // run → [ids]
  for (const t of list) {
    const run = ticketRun(t)
    if (run == null) continue
    if (!runGroups.has(run)) runGroups.set(run, [])
    runGroups.get(run).push(String(t.ticket_id))
  }
  // 轨道②: deps 连通分量 (union-find, 边仅计两端在场)
  const parent = new Map([...byId.keys()].map((id) => [id, id]))
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x) } return x }
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(ra < rb ? ra : rb, ra < rb ? rb : ra) }
  for (const t of list) {
    const id = String(t.ticket_id)
    for (const d of ticketDeps(t)) if (byId.has(d) && d !== id) union(id, d)
  }
  const compMembers = new Map() // root → [ids]
  for (const id of byId.keys()) {
    const r = find(id)
    if (!compMembers.has(r)) compMembers.set(r, [])
    compMembers.get(r).push(id)
  }
  // 逐票定轨 → 簇 key
  const assign = new Map() // id → { key, kind }
  for (const [run, ids] of runGroups) for (const id of ids) assign.set(id, { key: `run:${run}`, kind: 'run' })
  for (const members of compMembers.values()) {
    const free = members.filter((id) => !assign.has(id)) // ① 已收编的不入 deps 簇 (簇 key 只由实际成员派生)
    if (free.length < 2) continue // ② 零边/自环/仅剩被收编者不成簇 → 落 ③/④
    const sorted = [...free].sort()
    for (const id of free) assign.set(id, { key: `cdep:${sorted[0]}`, kind: 'deps' })
  }
  for (const t of list) {
    const id = String(t.ticket_id)
    if (assign.has(id)) continue
    const pre = ticketPrefix(id)
    if (pre != null) {
      const fam = list.filter((m) => ticketPrefix(String(m.ticket_id)) === pre).map((m) => String(m.ticket_id))
      if (fam.length >= 2) { assign.set(id, { key: `fam:${pre}`, kind: 'prefix' }); continue }
    }
    assign.set(id, { key: `one:${id}`, kind: 'single' })
  }
  // 归簇 + 元数据
  const groups = new Map() // key → [ids]
  for (const [id, a] of assign) {
    if (!groups.has(a.key)) groups.set(a.key, [])
    groups.get(a.key).push(id)
  }
  const clusters = []
  for (const [key, ids] of groups) {
    const ticketIds = [...ids].sort()
    const kind = assign.get(ticketIds[0]).kind // 同 key 同 kind (轨道互斥保证)
    const states = {}
    let active = 0
    for (const id of ticketIds) {
      const st = String(byId.get(id).state ?? 'unknown')
      states[st] = (states[st] || 0) + 1
      if (isActiveState(st)) active++
    }
    let label
    if (kind === 'run') label = `run:${key.slice(4)}`
    else if (kind === 'deps') {
      const pres = [...new Set(ticketIds.map(ticketPrefix).filter(Boolean))]
      label = pres.length === 1 ? pres[0] : ticketIds[0]
    } else if (kind === 'prefix') label = key.slice(4)
    else label = ticketIds[0]
    clusters.push({ key, kind, label, ticketIds, total: ticketIds.length, active, states })
  }
  // PMWEB-GRAPH (审计 #108): 跨轨撞名消歧 —— 不同轨/不同簇同名 label 追加轨道后缀
  // (如 deps 分量与前缀族同叫 OF → 'OF·deps' / 'OF·prefix'), 簇列表与画布同源同规则;
  // 同轨仍撞 (罕见: 同前缀多个连通分量) → 序号兜底。
  const baseCount = new Map()
  for (const c of clusters) baseCount.set(c.label, (baseCount.get(c.label) ?? 0) + 1)
  if (baseCount.size !== clusters.length) {
    const seen = new Map()
    for (const c of clusters) {
      if (baseCount.get(c.label) <= 1) continue
      const base = `${c.label}·${c.kind}`
      const n = (seen.get(base) ?? 0) + 1
      seen.set(base, n)
      c.label = n === 1 ? base : `${base}${n}`
    }
  }
  clusters.sort((a, b) => (b.active - a.active) || (b.total - a.total) || (a.key < b.key ? -1 : 1))
  return clusters
}

// clusterScene(tickets, expandedSet) → 聚合 DAG 场景 (折叠态语义, 纯派生):
//   nodes: 折叠簇 → 超级节点 { id:'cl:<key>', type:'cluster', cluster }; 展开簇 →
//          成员票节点 { id:'tk:<tid>', type:'ticket', … } 替换簇节点
//   edges: deps 边 (前置 d → 依赖方 t, 即 d 先行), 两端各自映射到当前形态
//          (端所在簇折叠=簇节点, 展开=票节点), 同形去重。
// 返回 { clusters, nodes, edges, nodeOfTicket: Map(tid→场景节点id),
//        clusterNodeIds: Set(场景中代表簇根的节点id), expanded: Set }
export function clusterScene(tickets, expandedSet) {
  const clusters = clusterTickets(tickets)
  const expanded = expandedSet instanceof Set ? expandedSet : new Set()
  const byId = new Map((Array.isArray(tickets) ? tickets : []).filter((t) => t && t.ticket_id != null).map((t) => [String(t.ticket_id), t]))
  const clusterOfTicket = new Map() // tid → cluster
  for (const c of clusters) for (const id of c.ticketIds) clusterOfTicket.set(id, c)
  const isExpanded = (c) => expanded.has(c.key)
  const nodes = []
  const nodeOfTicket = new Map() // tid → 场景节点 id (折叠=所在簇节点, 展开=自身票节点)
  const clusterRoot = new Map() // key → 场景根节点 id
  for (const c of clusters) {
    if (isExpanded(c)) {
      clusterRoot.set(c.key, null) // 展开簇无单一根; 聚焦时用成员集
      for (const id of c.ticketIds) {
        const t = byId.get(id)
        nodeOfTicket.set(id, `tk:${id}`)
        nodes.push({ id: `tk:${id}`, type: 'ticket', label: id, ticketId: id, state: String(t.state ?? 'unknown'), deps: ticketDeps(t), leaseOwner: t.lease_owner ?? null, clusterKey: c.key, clusterLabel: c.label })
      }
    } else {
      const nid = `cl:${c.key}`
      clusterRoot.set(c.key, nid)
      for (const id of c.ticketIds) nodeOfTicket.set(id, nid)
      nodes.push({ id: nid, type: 'cluster', label: c.label, clusterKey: c.key, kind: c.kind, total: c.total, active: c.active, states: c.states, ticketIds: c.ticketIds })
    }
  }
  // deps 边: 场景形态映射 + 去重 (折叠簇把多条成员边聚成一条簇间边)。
  // PMWEB-GRAPH (审计 #108): 跨簇 deps 边在此生成簇级边 (两端各自映射到簇节点/成员节点,
  // 不同场景节点即保留) —— 折叠态簇间依赖必须可见; 簇内边 from===to 折叠语义不变。
  const seen = new Set()
  const edges = []
  for (const t of byId.values()) {
    const tid = String(t.ticket_id)
    for (const d of ticketDeps(t)) {
      if (!byId.has(d) || d === tid) continue
      const from = nodeOfTicket.get(d)
      const to = nodeOfTicket.get(tid)
      if (!from || !to || from === to) continue // 同场景节点内部边不画 (展开簇内部边保留: from!==to)
      const eid = `dep:${from}>${to}`
      if (seen.has(eid)) continue
      seen.add(eid)
      edges.push({ id: eid, kind: 'dep', from, to, label: '' })
    }
  }
  // PMWEB-GRAPH: 簇级依赖度 —— 出/入簇跨簇 deps 边计数 (折叠簇节点副标签 ↗N ↘N; 无依赖不显示)
  const degOut = new Map()
  const degIn = new Map()
  for (const e of edges) {
    degOut.set(e.from, (degOut.get(e.from) ?? 0) + 1)
    degIn.set(e.to, (degIn.get(e.to) ?? 0) + 1)
  }
  for (const n of nodes) if (n.type === 'cluster') { n.depOut = degOut.get(n.id) ?? 0; n.depIn = degIn.get(n.id) ?? 0 }
  return { clusters, nodes, edges, nodeOfTicket, clusterRoot, expanded }
}

// ==== PMWEB-REPO: 仓优先 scope 层 (纯派生, 仍零 DOM/零 fetch) ====
// 用户两裁决 (2026-09-08 定谳, spec 变更记录引用原话):
//   裁决 A「ticket 就像 issue 跟着 repo 走, git 什么时候会把所有 issue/pr 混在一起
//   不区分 repo 再用 repo 去过滤」→ 容器优先翻转: 落地默认即仓内视图; 跨仓全局档
//   彻底退役删码; fleet 降为显式次级入口。
//   裁决 B「145 张无 refs.cwd 存量票隔离为归档池」→ 无仓票在任何 scope 零入场
//   (不进图/不出节点/不入桶), 票 tab 折叠区隔离 (app.js 侧), 账本数据不动。
// scope 键两档 (无全局档):
//   'cwd:<path>'   → refs.cwd === <path> 的仓内票 (默认档; 仓清单 = refs.cwd distinct)
//   'fleet:<code>' → lease_owner 归一 code === <code> 且有仓的票 (显式次级)
// 出界盒 (跨仓跳转): scope 内票 deps 指向 scope 外票 → 按其自身聚簇轨道聚成出界簇盒
// { type:'out', jumpCwd } —— jumpCwd = 盒成员多数 refs.cwd (点击跳目标仓 + 聚焦该簇,
// canvas.js 侧); 成员全无仓 (归档池) → jumpCwd '' 纯提示不可点。
// lease 归一与 app.js leaseCode 同规则镜像 (剥 '/' 与 '@' 后段取 code 前缀)。

export function ticketCwd(t) { // refs.cwd → string ('' = 无仓 → 归档池)
  const r = parseJsonField(t?.refs, null)
  const cwd = r && typeof r === 'object' && !Array.isArray(r) ? r.cwd : null
  return cwd == null || cwd === '' ? '' : String(cwd)
}

export function ticketFleet(t) { // lease_owner → 席位 code ('' = 未派发/脏形)
  const v = t?.lease_owner
  return typeof v === 'string' && v ? v.split(/[/@]/)[0].trim() : ''
}

// 仓/席位桶清单 (scope 选择器数据面): 只对有仓票分桶 (归档池零入场故不入桶),
// 升序 (稳定幂等)。archive = 无仓票数 (归档池口径, 票 tab 折叠区/计数条注记用)。
export function scopeBuckets(tickets) {
  const list = Array.isArray(tickets) ? tickets : []
  const cwds = new Map()
  const fleets = new Map()
  let archive = 0
  for (const t of list) {
    const cwd = ticketCwd(t)
    if (!cwd) { archive++; continue } // 裁决 B: 归档池不出任何桶
    cwds.set(cwd, (cwds.get(cwd) ?? 0) + 1)
    const code = ticketFleet(t)
    if (code) fleets.set(code, (fleets.get(code) ?? 0) + 1)
  }
  const asc = (m) => [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, n]) => ({ key: k, count: n }))
  return { cwds: asc(cwds), fleets: asc(fleets), archive }
}

export function ticketInScope(t, scope) {
  const cwd = ticketCwd(t)
  if (!cwd) return false // 裁决 B: 归档池任何 scope 零入场 (持票也不入场 fleet)
  if (scope?.startsWith('cwd:')) return cwd === scope.slice(4)
  if (scope?.startsWith('fleet:')) return ticketFleet(t) === scope.slice(6)
  return false // 未知/退役 scope 一律不在场 (无全局档)
}

// 出界盒跨仓跳转目标 (纯派生): 盒成员 refs.cwd 多数仓; 平票取字典序最小仓 (确定幂等);
// 全员无仓 → '' (canvas.js 渲染为纯提示盒, 不可点)。
export function outJumpCwd(c, byId) {
  const tally = new Map()
  for (const id of c.ticketIds) {
    const cwd = ticketCwd(byId.get(id))
    if (cwd) tally.set(cwd, (tally.get(cwd) ?? 0) + 1)
  }
  let best = ''
  let bestN = 0
  for (const [cwd, n] of [...tally.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (n > bestN) { best = cwd; bestN = n }
  }
  return best
}

// scopeScene(tickets, scope, foldedSet) → 仓内 scope-DAG 场景 (纯派生):
//   归档池票 (无仓) 全程零入场; scope 内票全入场, 簇默认全展开 (裁决③语义),
//   foldedSet 中的簇折叠为超级节点 (仓内折叠交互); scope 外仅「被 scope 内票 deps
//   指向」的票入场, 按自身聚簇轨道聚成出界簇盒 { type:'out', jumpCwd } (跨仓跳转),
//   deps 边重映射 成员票节点 → 出界簇盒 (同目标去重)。
// 返回同 clusterScene 形 + outClusters (含 jumpCwd) + scope。
export function scopeScene(tickets, scope, foldedSet) {
  const list = Array.isArray(tickets) ? tickets.filter((t) => t && t.ticket_id != null) : []
  const repoList = list.filter((t) => ticketCwd(t) !== '') // 归档池隔离 (裁决 B)
  const inList = repoList.filter((t) => ticketInScope(t, scope))
  const inClusters = clusterTickets(inList)
  const folded = foldedSet instanceof Set ? foldedSet : new Set()
  const openSet = new Set(inClusters.filter((c) => !folded.has(c.key)).map((c) => c.key)) // 默认全展开
  const base = clusterScene(inList, openSet)
  const inIds = new Set(inList.map((t) => String(t.ticket_id)))
  const outNeeded = new Set()
  for (const t of inList) for (const d of ticketDeps(t)) if (!inIds.has(String(d))) outNeeded.add(String(d))
  const byId = new Map(list.map((t) => [String(t.ticket_id), t]))
  const outTickets = list.filter((t) => outNeeded.has(String(t.ticket_id))) // 出界含归档票 (聚合计数, 不出节点)
  const outClusters = clusterTickets(outTickets).map((c) => ({ ...c, jumpCwd: outJumpCwd(c, byId) }))
  const outNodeByKey = new Map() // key → 出界簇节点
  const outNodes = outClusters.map((c) => {
    const n = { id: `out:${c.key}`, type: 'out', clusterKey: c.key, label: c.label, kind: c.kind, total: c.total, active: c.active, states: c.states, ticketIds: c.ticketIds, jumpCwd: c.jumpCwd }
    outNodeByKey.set(c.key, n)
    return n
  })
  const tidToOut = new Map() // 出界票id → out 节点 id
  for (const c of outClusters) for (const id of c.ticketIds) tidToOut.set(id, `out:${c.key}`)
  const seen = new Set()
  const outEdges = []
  for (const t of inList) {
    const from = base.nodeOfTicket.get(String(t.ticket_id))
    if (!from) continue
    for (const d of ticketDeps(t)) {
      const to = tidToOut.get(String(d))
      if (!to) continue
      const eid = `dep:${from}>${to}`
      if (seen.has(eid)) continue
      seen.add(eid)
      outEdges.push({ id: eid, kind: 'dep', from, to, label: '' })
    }
  }
  return { ...base, nodes: [...base.nodes, ...outNodes], edges: [...base.edges, ...outEdges], outClusters, scope }
}
