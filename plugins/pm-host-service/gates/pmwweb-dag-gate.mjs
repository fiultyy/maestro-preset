#!/usr/bin/env node
// pmweb-dag-gate.mjs — PMWEB-DAG 图视重构 gate (spec /tmp/pmweb-dag-spec.md; PMWEB-REPO 仓优先翻转)。
//
// A. 聚合纯函数单测 (零浏览器, node 直 import public/cluster.js):
//    双轨键+兜底逐轨断言 (run/deps 连通分量/前缀族/单票), 轨道优先级 (run 压 deps),
//    deps=[] 批次不被吞并, dangling deps / 脏 JSON 防御, 终态-活跃口径, 全覆盖恰一簇;
//    clusterScene 折叠态派生 (簇超节点/成员票替换/边同形去重/跨簇边保留);
//    PMWEB-REPO 仓优先 scope 层: 归档池零入场 / 出界盒跨仓 jumpCwd (多数仓+平票字典序)
//    / 折叠集默认全展开 / 全局档退役恒假。
// B. 静态门: index.html 三 tab 面 (PMWEB-3TAB: 票/席位/图; 流程折叠区+画布退役);
//    canvas.js 容器优先 (默认首个仓/无全局档/出界跨仓跳转/折叠集) + 聚合导入+联动锚点
//    +退役零残留; app.js 仓分组看板+无仓归档折叠区 (纯展示) +组织图标记; style.css 样式面;
//    红线: fetch 端点白名单 + POST 仅 /op/act (ADR-002, canvas.js 退役后零 POST) + cluster.js 零 fetch
//    + package.json 零依赖。
// C. sandbox 浏览器门 (stub ledger + fleet fixture + mock dsh + bridge 血缘,
//    零 live 变更): 图 tab 默认即仓内视图 (alpha 全展开) + scope 选择器 (仓/fleet 次级,
//    无全局档) + 仓内折叠往返 + list 染选联动 + 流程折叠区默认收起 + op/graph counts
//    消费 (A4) + 票 tab 仓分组看板 + 无仓归档折叠区 (默认收起, 纯展示 3 卡) + 选票联动
//    跳所在仓 + 席位「在图中聚焦」+ 画布退役零残留; 席位 tab 小卡 + 组织图血缘嵌套
//    + 详情浮层全量字段+持票列表+关闭返回。页面异常任何一例即 FAIL。
// D. PMWEB-GRAPH 几何门 (独立扩模 sandbox, 零 live 变更; 泳道场景退役后仅 DAG):
//    G1 几何断言: DAG SVG 边路径采样点 vs 非端点节点盒零求交 (容差 2px 内缩; /w/one
//    仓内场景含 2 出界边);
//    G2 REPO: 默认首个仓 (/repo/alpha) + 归档池零入场注记 + 出界盒两态 (jumpCwd 可跳转
//    / 无仓纯提示不可点) + 点击跨仓跳转 → 目标仓 + 染选聚焦该簇;
//    G3 折叠重取景 (fold → fit) + 标签零溢出 (dense 仓 8 成员);
//    G4 = 既有断言零回归 (A/B/C 全段原样)。
// 留存: 截图/日志落 $PM_HOST_SERVICE_GATES_DIR/pmweb-dag/<label>/。
// Usage: node pmwweb-dag-gate.mjs <label> [chrome-bin]
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { zstdCompressSync } from 'node:zlib' // PMWEB-FLEET-SIDE: 造 session.jsonl.zstd fixture (service loadTraceLines 同格式)

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
  const { clusterTickets, clusterScene, scopeScene, scopeBuckets, ticketCwd, ticketFleet, ticketInScope, ticketRun, ticketDeps, ticketPrefix, TERMINAL_STATES } = cl
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
  // PMWEB-GRAPH G3 (unit): 折叠态簇间 deps → 簇级边 + ↗出/↘入计数
  ok('G3 unit: 2 簇跨簇 deps → 折叠场景簇级边 ≥1 + ↗↘ 计数正确', (() => {
    const ts = [t('RA-1', { refs: '{"run":"RA"}', deps: '["RB-9"]' }), t('RA-2', { refs: '{"run":"RA"}' }), t('RB-9', { refs: '{"run":"RB"}' })]
    const sc = clusterScene(ts, new Set())
    const ra = sc.nodes.find((n) => n.id === 'cl:run:RA')
    const rb = sc.nodes.find((n) => n.id === 'cl:run:RB')
    return sc.edges.length === 1 && sc.edges[0].id === 'dep:cl:run:RB>cl:run:RA'
      && rb?.depOut === 1 && rb?.depIn === 0 && ra?.depIn === 1 && ra?.depOut === 0
  })())
  ok('G3 unit: 无跨簇依赖 → 计数位为 0 (渲染侧不显示)', (() => {
    const ts = [t('S-1', { refs: '{"run":"SC"}' }), t('S-2', { refs: '{"run":"SC"}' })]
    const sc = clusterScene(ts, new Set())
    return sc.edges.length === 0 && sc.nodes.every((n) => n.depOut === 0 && n.depIn === 0)
  })())
  // PMWEB-GRAPH (审计 #108): 跨轨撞名消歧
  ok('F8 unit: 跨轨撞名 label 加轨道后缀 (OF·deps / OF·prefix), 独名不变', (() => {
    const ts = [t('OF-1'), t('OF-2', { deps: '["OF-1"]' }), t('OF-3'), t('OF-4')]
    const c = clusterTickets(ts)
    const labels = c.map((x) => x.label).sort()
    const solo = clusterTickets([t('SOLO'), t('SXX-1', { refs: '{"run":"SR"}' }), t('SXX-2', { refs: '{"run":"SR"}' })])
    return c.length === 2 && new Set(labels).size === 2 && labels.includes('OF·deps') && labels.includes('OF·prefix')
      && solo.map((x) => x.label).sort().join() === 'SOLO,run:SR' // 无撞名 → 零消歧 (回归)
  })())
  ok('A 辅助: ticketRun/ticketDeps/ticketPrefix 脏形防御', ticketRun({ refs: '{"run":42}' }) === '42' && ticketDeps({ deps: '{"a":1}' }).length === 0 && ticketPrefix('NOPREFIX') === null && ticketPrefix('AND1-2') === 'AND1')
  ok('A 终态集冻结: done/merged/rejected', TERMINAL_STATES.size === 3 && ['done', 'merged', 'rejected'].every((s) => TERMINAL_STATES.has(s)))
  // PMWEB-REPO (A): 仓优先 scope 层 —— 归档池零入场 + 出界盒跨仓 jumpCwd (用户两裁决)
  const ts3 = [
    t('A-1', { state: 'running', deps: '["B-1"]', refs: '{"cwd":"/x/y"}', lease_owner: 'w1/budget' }),
    t('B-1', { refs: '{"cwd":"/x/z"}' }),
    t('A-2', { state: 'blocked', refs: '{"cwd":"/x/y"}', lease_owner: 'w1@sub' }),
    t('C-9', { refs: '{}' }),
    t('C-8', { lease_owner: 'w1' }), // 归档池持票: 有 lease 无仓 → fleet 也不入场
  ]
  ok('A REPO scope: cwd/fleet 口径 + scopeBuckets 仓桶 (归档池不计桶)', ticketCwd(ts3[0]) === '/x/y' && ticketCwd(t('N', { refs: null })) === ''
    && ticketFleet(ts3[0]) === 'w1' && ticketFleet(ts3[2]) === 'w1' && ticketFleet(t('N2', { lease_owner: null })) === ''
    && (() => { const b = scopeBuckets(ts3); return JSON.stringify(b.cwds) === JSON.stringify([{ key: '/x/y', count: 2 }, { key: '/x/z', count: 1 }]) && b.fleets.length === 1 && b.fleets[0].key === 'w1' && b.fleets[0].count === 2 && b.archive === 2 })())
  ok('A REPO scopeScene: scope 内全展开 + 出界 deps 聚簇盒带跨仓 jumpCwd (非 ghost 散点)', (() => {
    const sc = scopeScene(ts3, 'cwd:/x/y')
    const ids = sc.nodes.map((n) => `${n.id}:${n.type}`)
    return ids.join() === 'tk:A-1:ticket,tk:A-2:ticket,out:one:B-1:out'
      && sc.edges.length === 1 && sc.edges[0].id === 'dep:tk:A-1>out:one:B-1'
      && sc.outClusters.length === 1 && sc.outClusters[0].key === 'one:B-1' && sc.outClusters[0].jumpCwd === '/x/z' // C-9/C-8 归档池不入场
  })())
  ok('A REPO 归档池零入场: 无仓票任何 scope 不出节点 (持票也不入 fleet); 全员无仓出界盒 → 纯提示 jumpCwd 空', (() => {
    const fl = scopeScene(ts3, 'fleet:w1')
    const hint = scopeScene([t('H-1', { refs: '{"cwd":"/h"}', deps: '["AR-9"]' }), t('AR-9')], 'cwd:/h')
    return fl.nodes.some((n) => n.id === 'tk:A-1') && fl.nodes.some((n) => n.id === 'tk:A-2')
      && !fl.nodes.some((n) => n.id === 'tk:C-8') // 归档池持票: fleet scope 也不入场 (裁决 B)
      && hint.nodes.some((n) => n.id === 'tk:H-1') && !hint.nodes.some((n) => n.id === 'tk:AR-9') // 归档池票零节点 (出界提示盒除外)
      && hint.outClusters.length === 1 && hint.outClusters[0].jumpCwd === '' && hint.outClusters[0].total === 1
  })())
  ok('A REPO 跨仓跳转: 出界盒 jumpCwd = 成员多数仓, 平票取字典序最小 (确定幂等)', (() => {
    const tj = [t('J-1', { refs: '{"cwd":"/r/a"}', deps: '["K-1","K-2"]' }), t('K-1', { refs: '{"cwd":"/r/b"}' }), t('K-2', { refs: '{"cwd":"/r/c"}', deps: '["K-1"]' })]
    const sc = scopeScene(tj, 'cwd:/r/a')
    const c = sc.outClusters[0]
    const single = scopeScene(ts3, 'cwd:/x/z') // 仓内无跨界 deps → 零出界
    return sc.outClusters.length === 1 && c.key === 'cdep:K-1' && c.jumpCwd === '/r/b'
      && single.outClusters.length === 0 && single.nodes.map((n) => n.id).join() === 'tk:B-1'
  })())
  ok('A REPO 折叠集: scope 内默认全展开, foldedSet 折叠为超级节点; 未知 scope 安全空场', (() => {
    const tf = [t('D-1', { refs: '{"cwd":"/f"}' }), t('D-2', { refs: '{"cwd":"/f"}', deps: '["D-1"]' }), t('D-3', { refs: '{"cwd":"/f"}', deps: '["D-2"]' })]
    const open = scopeScene(tf, 'cwd:/f')
    const folded = scopeScene(tf, 'cwd:/f', new Set(['cdep:D-1']))
    const dead = scopeScene(tf, 'cwd:/nope')
    return open.nodes.length === 3 && open.nodes.every((n) => n.type === 'ticket')
      && folded.nodes.length === 1 && folded.nodes[0].id === 'cl:cdep:D-1' && folded.edges.length === 0
      && dead.nodes.length === 0 && dead.edges.length === 0 && dead.outClusters.length === 0
  })())
  ok('A REPO scope: ticketInScope 谓词 (全局档退役恒假/归档池恒假/cwd 严格/fleet 归一/未知档假)', ticketInScope(ts3[0], 'all') === false
    && ticketInScope(ts3[3], 'cwd:/x/y') === false && ticketInScope(ts3[4], 'fleet:w1') === false
    && ticketInScope(ts3[0], 'cwd:/x/y') === true && ticketInScope(ts3[1], 'cwd:/x/y') === false
    && ticketInScope(ts3[2], 'fleet:w1') === true && ticketInScope(ts3[0], 'junk:z') === false)
}

// ---------- B. 静态门 ----------
const FETCH_ALLOW = new Set(['/op/tickets', '/op/fleet', '/op/flow', '/op/graph', '/op/trace', '/op/act', '/health', '/subscribe'])
{
  const html = readFileSync(`${PUBLIC}index.html`, 'utf8')
  ok('B index.html: 图 tab (data-view=dag + view-dag)', html.includes('data-view="dag"') && html.includes('id="view-dag"'))
  ok('B index.html: 三 tab 面 (票/席位/图; PMWEB-3TAB 五→三)', ['data-view="tickets"', 'data-view="fleet"', 'data-view="dag"'].every((s) => html.includes(s))
    && !html.includes('data-view="flow"') && !html.includes('data-view="canvas"')
    && !html.includes('id="view-flow"') && !html.includes('id="view-canvas"'))
  ok('B index.html: 席位详情浮层 dialog 在场', html.includes('id="seat-detail"') && html.includes('id="sd-body"') && html.includes('id="sd-close"'))
  const cv = readFileSync(`${PUBLIC}canvas.js`, 'utf8')
  ok('B canvas.js: 聚合层导入 + 图 tab boot + 内省', cv.includes("from './cluster.js'") && cv.includes('scopeScene(D2.tickets') && cv.includes('bootDag()') && cv.includes('window.__pmDag'))
  ok('B canvas.js: 画布退役 (泳道/抽屉/回放/minimap 锚点零残留)', !cv.includes('refetchGraph') && !cv.includes('loadReplay') && !cv.includes('canvas-svg')
    && !cv.includes('openDrawer') && !cv.includes('wireMinimap') && !cv.includes('id="cv-stage"'))
  ok('B canvas.js: scope 选择器+出界聚合+流程折叠区+联动锚点 (PMWEB-3TAB)', cv.includes('scopeScene') && cv.includes('scopeBuckets') && cv.includes('#dg-scope')
    && cv.includes('dg-flow-body') && cv.includes("pm:dag-focus") && cv.includes("pm:dag-focus-fleet") && cv.includes('pullGraphCounts'))
  ok('B canvas.js: 容器优先翻转 (默认首个仓/无全局档/出界盒跨仓跳转/折叠集/A4 全量口径注记)', !cv.includes("'all'") && !cv.includes("'cluster:")
    && cv.includes('b.cwds[0]') && cv.includes('jumpCwd') && cv.includes('D2.folded') && cv.includes('graph 全量'))
  const ap = readFileSync(`${PUBLIC}app.js`, 'utf8')
  ok('B app.js: 组织图+小卡+浮层标记', ap.includes('function lineageOf') && ap.includes('seat-mini') && ap.includes('org-children') && ap.includes('openSeatDetail') && ap.includes('loadGraph'))
  ok('B app.js: 既有 SSE 派发两事件 + 三视图 refetch 保留', ap.includes("new CustomEvent('pm:sse'") && ap.includes("new CustomEvent('pm:sse-state'") && ap.includes('refetch.tickets()') && ap.includes('refetch.flow()'))
  ok('B app.js: REPO 仓分组看板+无仓归档折叠区+选票联动+席位聚焦+流程重定向锚点', ap.includes('cwd-group') && ap.includes('tk-pool') && ap.includes('无仓归档')
    && !ap.includes(": '未分配'") && ap.includes("pm:dag-focus'")
    && ap.includes('data-dg-focus') && ap.includes('__pmRenderFlow') && ap.includes("$('#dg-flow-body')"))
  ok('B app.js: 归档池纯展示 (pool 卡零联动零钮; 折叠区 details 默认收起不带 open)', ap.includes('{ pool: true }') && ap.includes("pool ? '' : ` data-tid=")
    && ap.includes('<details class="tk-pool"') && !/details class="tk-pool"[^>]*\bopen\b/.test(ap))
  ok('B cluster.js: 仓优先 scope 层 (无全局档字面量/无簇伪 scope/出界 jumpCwd/归档池 archive 口径)', (() => {
    const c = readFileSync(`${PUBLIC}cluster.js`, 'utf8')
    return !c.includes("'all'") && !c.includes("'cluster:") && c.includes('export function outJumpCwd') && c.includes('jumpCwd') && c.includes('archive')
  })())
  const css = readFileSync(`${PUBLIC}style.css`, 'utf8')
  ok('B style.css: 图 tab + 组织图 + 小卡 + 浮层样式面', css.includes('#dg-list') && css.includes('.dg-node') && css.includes('.org-children') && css.includes('.seat-mini') && css.includes('#seat-detail'))
  ok('B style.css: 3TAB 样式面 (cwd 分组/scope 选择器/出界簇盒/流程折叠区)', css.includes('.cwd-group') && css.includes('#dg-scope') && css.includes('.t-out') && css.includes('details.dg-flow') && css.includes('.dg-focus'))
  ok('B style.css: REPO 样式面 (无仓归档折叠区/归档池卡/出界提示盒)', css.includes('.tk-pool') && css.includes('.ticket-card.pool') && css.includes('.t-out-hint'))
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
  ok('B 红线: POST 仅 /op/act 透传 (app.js PW-005 一处; canvas.js 画布退役后零 POST)', (readFileSync(`${PUBLIC}app.js`, 'utf8').match(/method: 'POST'/g) ?? []).length === 1 && (readFileSync(`${PUBLIC}canvas.js`, 'utf8').match(/method: 'POST'/g) ?? []).length === 0)
  const pkg = JSON.parse(readFileSync(`${REPO}package.json`, 'utf8'))
  ok('B 宪章: package.json 仍零依赖字段', !pkg.dependencies && !pkg.devDependencies && !pkg.optionalDependencies)
}

// ---------- sandbox 工厂 (pmw2-3 gate 惯例: stub ledger + fleet fixture + mock dsh) ----------
// 7 票 → 4 簇: run:R77(RUN-1/RUN-2) + cdep:CH-A(CH-A←CH-B) + fam:FAM(FAM-1/FAM-2) + one:SGL-9
// PMWEB-REPO: refs.cwd 仓标注 (alpha×2 / beta×2) + 无仓×3 (FAM-1/FAM-2/SGL-9 = 归档池,
// 图零入场/票 tab 折叠区) —— cwd 不参与聚合轨道, 簇结构不变; 默认 scope = /repo/alpha。
const TICKETS = [
  { ticket_id: 'RUN-1', state: 'running', deps: '[]', refs: '{"run":"R77","cwd":"/repo/alpha"}', lease_owner: 'w1' },
  { ticket_id: 'RUN-2', state: 'done', deps: '[]', refs: '{"run":"R77","cwd":"/repo/alpha"}', lease_owner: null },
  { ticket_id: 'CH-A', state: 'blocked', deps: '[]', refs: '{"cwd":"/repo/beta"}', lease_owner: null },
  { ticket_id: 'CH-B', state: 'done', deps: '["CH-A"]', refs: '{"cwd":"/repo/beta"}', lease_owner: null },
  { ticket_id: 'FAM-1', state: 'dispatched', deps: '[]', refs: '{}', lease_owner: null },
  { ticket_id: 'FAM-2', state: 'done', deps: '[]', refs: '{}', lease_owner: null },
  { ticket_id: 'SGL-9', state: 'merged', deps: '[]', refs: '{}', lease_owner: null },
]
const SEATS = {
  h1: { code: 'h1', sessionId: 'session-11111111-aaaa-4bbb-8ccc-111111111111', role: 'head', node: 'n-head', preset: 'maestro', spawnedAt: '2026-09-01T00:00:00Z', status: 'active' },
  w1: { code: 'w1', sessionId: 'session-22222222-aaaa-4bbb-8ccc-222222222222', role: 'worker', node: 'n-w', preset: 'long-task', spawnedAt: '2026-09-01T01:00:00Z', status: 'active' },
}
function writeFleet(sb, fleet = SEATS) {
  const file = `${sb}/maestro/fleet.json`
  writeFileSync(`${file}.tmp.${process.pid}`, `${JSON.stringify({ rev: 1, fleet }, null, 2)}\n`)
  renameSync(`${file}.tmp.${process.pid}`, file)
}
// PMWEB-GRAPH G2 fixture: flow state.db 最小四表 schema (v_status/v_rollup/nodes/events,
// 供 gatherFlowGraph + PM-006 op=flow 只读查询; 独立 sandbox 内一次性写入, 不触 live)
function writeFlowDb(dir, spec) {
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(`${dir}/state.db`)
  try {
    db.exec('CREATE TABLE v_status (node_id TEXT PRIMARY KEY, verb TEXT, state TEXT, attempts INTEGER DEFAULT 0, events INTEGER DEFAULT 0);\nCREATE TABLE v_rollup (state TEXT PRIMARY KEY, count INTEGER DEFAULT 0);\nCREATE TABLE nodes (node_id TEXT PRIMARY KEY, deps TEXT DEFAULT \'[]\');\nCREATE TABLE events (id INTEGER PRIMARY KEY, node_id TEXT, detail TEXT)')
    const insN = db.prepare('INSERT INTO v_status (node_id, verb, state) VALUES (?, ?, ?)')
    const insD = db.prepare('INSERT INTO nodes (node_id, deps) VALUES (?, ?)')
    const insE = db.prepare('INSERT INTO events (id, node_id, detail) VALUES (?, ?, ?)')
    const roll = {}
    for (const n of spec.nodes) {
      insN.run(n.id, n.verb ?? 'status', n.state ?? 'done')
      insD.run(n.id, JSON.stringify(n.deps ?? []))
      roll[n.state ?? 'done'] = (roll[n.state ?? 'done'] ?? 0) + 1
    }
    ;(spec.events ?? []).forEach((e, i) => insE.run(i + 1, e.node, e.detail))
    const insR = db.prepare('INSERT INTO v_rollup (state, count) VALUES (?, ?)')
    for (const [s, c] of Object.entries(roll)) insR.run(s, c)
  } finally { db.close() }
}
const LEDGER_STUB = (tickets) => `#!/bin/bash
if [ "$1 $2" = "ticket list" ]; then
  echo '${JSON.stringify({ tickets })}'
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
async function startSandbox(tag, opts = {}) { // PMWEB-GRAPH: opts = { fleet, tickets, flows } 覆写 (缺省 = 既有 fixture 原样)
  const { fleet = SEATS, tickets = TICKETS, flows = null } = opts
  const sb = `${BASE}/${tag}`
  rmSync(sb, { recursive: true, force: true })
  mkdirSync(`${sb}/maestro/bin`, { recursive: true })
  writeFileSync(`${sb}/maestro/bin/ledger`, LEDGER_STUB(tickets), { mode: 0o755 })
  writeFileSync(`${sb}/maestro/bin/flowc`, '#!/bin/bash\necho "flowc inspect (stub)"; exit 0\n', { mode: 0o755 })
  writeFileSync(`${sb}/maestro/bin/fleet-list`, '#!/bin/bash\necho "[]"\n', { mode: 0o755 })
  writeFleet(sb, fleet)
  if (flows) for (const [name, spec] of Object.entries(flows)) writeFlowDb(`${sb}/maestro/flows/${name}`, spec)
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
  // PMWEB-FLEET-SIDE fixture: w1 session trace (zstd 单帧 JSONL, loadTraceLines 同格式)。
  // 故意先放一条纯 tool-call 的 assistant/message (turn2/step5) 再放带 text 的
  // (turn3/step9) —— 锁「取最后一条带 text block 的消息 = agent end turn 原文」语义。
  {
    const lines = [
      JSON.stringify({ seq: 1, type: 'assistant/message', data: { turn: 2, step: 5, message: { role: 'assistant', content: [{ type: 'tool-call', id: 't1' }] } } }),
      JSON.stringify({ seq: 2, type: 'assistant/message', data: { turn: 3, step: 9, message: { role: 'assistant', content: [{ type: 'text', text: 'SMOKE-TURN-END-ALPHA 最终结论原文' }] } } }),
      JSON.stringify({ seq: 3, type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } }),
    ]
    const dir = `${box.sb}/sessions/ab/session-22222222-aaaa-4bbb-8ccc-222222222222`
    mkdirSync(dir, { recursive: true })
    writeFileSync(`${dir}/session.jsonl.zstd`, zstdCompressSync(Buffer.from(lines.join('\n') + '\n')))
  }
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
    for (let i = 0; i < 100 && !ready; i++) { await sleep(300); try { ready = await c.cdp.eval('window.__pmDag && window.__pmDag.ready === true') } catch {} }
    ok('C 页面就绪: 图 tab scope-DAG ready (泳道画布已退役)', ready)

    // 图 tab: 容器优先默认仓 (裁决 A: 落地即仓内视图, 无全局档)
    await c.cdp.eval(`document.querySelector('[data-view="dag"]').click()`)
    await sleep(700) // elk 布局+取景
    const dag = await c.cdp.eval('window.__pmDag')
    ok('C REPO: 默认即仓内视图 (首个仓 /repo/alpha, alpha 2 票全展开, 归档池 3 零入场)', dag.scope === 'cwd:/repo/alpha' && dag.nodes === 2 && dag.edges === 0 && dag.clusters === 1 && dag.archive === 3, JSON.stringify({ scope: dag.scope, nodes: dag.nodes, archive: dag.archive }))
    const countsBar = await c.cdp.eval(`(document.querySelector('#dg-counts') || {}).textContent || ''`)
    ok('C REPO: 计数条 仓/归档 零入场注记 + graph 全量口径', /仓 4 票 · 归档 3 零入场/.test(countsBar) && /scope cwd:\/repo\/alpha/.test(countsBar) && /graph 全量 \d+节点\/\d+边/.test(countsBar), countsBar)
    // PMWEB-REPO: scope 选择器 (仓默认 + fleet 次级; 无全局档) + 流程折叠区 (原流程页降级, 默认收起)
    const scopeUi = await c.cdp.eval(`({
      sel: !!document.querySelector('#dg-scope'),
      opts: [...document.querySelectorAll('#dg-scope option')].map((o) => o.value),
      groups: [...document.querySelectorAll('#dg-scope optgroup')].map((o) => o.label),
      selVal: (document.querySelector('#dg-scope') || {}).value || '',
      flow: !!document.querySelector('#dg-flow'),
      flowOpen: document.querySelector('#dg-flow') ? document.querySelector('#dg-flow').open : null,
      flowBody: (document.querySelector('#dg-flow-body') || {}).textContent || '',
      graphCounts: window.__pmDag.graphCounts,
    })`)
    ok('C REPO: scope 选择器 仓默认档 (无全局档, fleet 次级 optgroup)', scopeUi.sel && scopeUi.selVal === 'cwd:/repo/alpha'
      && JSON.stringify(scopeUi.opts) === JSON.stringify(['cwd:/repo/alpha', 'cwd:/repo/beta', 'fleet:w1'])
      && JSON.stringify(scopeUi.groups) === JSON.stringify(['仓 (refs.cwd)', 'fleet 席位 (次级)']), JSON.stringify(scopeUi))
    ok('C 3TAB: 流程折叠区默认收起且流程面已回填 (加载中/降级注记均算)', scopeUi.flow && scopeUi.flowOpen === false && scopeUi.flowBody.trim().length > 0, `len=${scopeUi.flowBody.trim().length}`)
    ok('C 3TAB A4: /op/graph 仍被图 tab 消费 (counts 进内省)', !!scopeUi.graphCounts && scopeUi.graphCounts.nodes > 0 && scopeUi.graphCounts.edges > 0, JSON.stringify(scopeUi.graphCounts))
    const listRows = await c.cdp.eval(`({
      clusters: document.querySelectorAll('#dg-list .dg-cluster').length,
      metas: [...document.querySelectorAll('#dg-list .dg-meta')].map((x) => x.textContent.trim()),
      dists: [...document.querySelectorAll('#dg-list .dg-dist')].map((x) => x.textContent.trim()).join(' | '),
      memberRows: document.querySelectorAll('#dg-list .dg-ticket-row').length,
      foldGlyph: (document.querySelector('#dg-list .dg-fold-btn') || {}).textContent || '',
    })`)
    ok('C list: scope 内簇列表 1 行 (run:R77 · 票数/活跃数/状态分布) 默认展开成员 2 行 ▾', listRows.clusters === 1 && /2 票 · 1 活跃/.test(listRows.metas.join(' ')) && /running 1 · done 1/.test(listRows.dists) && listRows.memberRows === 2 && listRows.foldGlyph === '▾', `${listRows.metas.join(' / ')} :: ${listRows.dists.slice(0, 60)} :: rows=${listRows.memberRows}`)

    // 染选联动 ①: scope 切 beta 仓 → 选簇聚焦 (折叠态簇超节点, 其余淡出)
    await c.cdp.eval(`(() => {
      const sel = document.querySelector('#dg-scope')
      sel.value = 'cwd:/repo/beta'
      sel.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)
    await sleep(700)
    const beta0 = await c.cdp.eval(`({ scope: window.__pmDag.scope, nodes: window.__pmDag.nodes, edges: window.__pmDag.edges, selVal: (document.querySelector('#dg-scope') || {}).value || '' })`)
    ok('C REPO: scope 切 beta 仓 (2 票全展开 1 簇内 deps 边)', beta0.scope === 'cwd:/repo/beta' && beta0.nodes === 2 && beta0.edges === 1 && beta0.selVal === 'cwd:/repo/beta', JSON.stringify(beta0))
    // 仓内折叠: list 折叠钮 → 簇超节点 (裁决③默认全展开的反向交互)
    await c.cdp.eval(clickEl('#dg-list .dg-fold-btn[data-fold="cdep:CH-A"]'))
    await sleep(700)
    const foldedS = await c.cdp.eval(`({
      nodes: window.__pmDag.nodes, edges: window.__pmDag.edges,
      folded: window.__pmDag.folded,
      glyph: (document.querySelector('#dag-svg .dg-node.t-cluster .dg-fold') || {}).textContent || '',
    })`)
    ok('C REPO 折叠钮: 展开簇收回聚合超节点 (1 节点 0 边, ▸ 角标)', foldedS.nodes === 1 && foldedS.edges === 0 && foldedS.folded.includes('cdep:CH-A') && foldedS.glyph === '▸', JSON.stringify(foldedS))
    await c.cdp.eval(clickEl('#dg-list .dg-cluster-row[data-key="cdep:CH-A"]'))
    await sleep(150)
    const focus = await c.cdp.eval(`({
      sel: window.__pmDag.selected,
      dims: document.querySelectorAll('#dag-svg .dg-dim').length,
      selNodes: document.querySelectorAll('#dag-svg .dg-sel').length,
    })`)
    ok('C 选簇聚焦: selected=cdep:CH-A 折叠超节点染选', focus.sel?.kind === 'cluster' && focus.sel.key === 'cdep:CH-A' && focus.dims === 0 && focus.selNodes === 1, JSON.stringify(focus))
    await c.cdp.shot(shot('dag-cluster-focus.png'))

    // 折叠往返 ②: 展开钮还原成员票 → 点成员票 → deps 边高亮
    await c.cdp.eval(clickEl('#dg-list .dg-fold-btn[data-fold="cdep:CH-A"]'))
    await sleep(700)
    const openedS = await c.cdp.eval('({ nodes: window.__pmDag.nodes, edges: window.__pmDag.edges, folded: window.__pmDag.folded })')
    ok('C REPO 展开钮: 折叠簇还原成员票 (2 节点 1 边, 折叠集清空)', openedS.nodes === 2 && openedS.edges === 1 && openedS.folded.length === 0, JSON.stringify(openedS))
    await c.cdp.eval(clickEl('#dg-list .dg-ticket-row[data-tid="CH-A"]'))
    await sleep(700)
    const tsel = await c.cdp.eval(`({
      sel: window.__pmDag.selected,
      nodes: window.__pmDag.nodes, edges: window.__pmDag.edges,
      dims: document.querySelectorAll('#dag-svg .dg-dim').length,
      lit: document.querySelectorAll('#dag-svg .dg-lit').length,
      selRows: document.querySelectorAll('#dg-list .dg-selected').length,
    })`)
    ok('C 选票: 染选 deps 边+邻接 (2 节点全邻接入 lit, 1 边亮)', tsel.sel?.kind === 'ticket' && tsel.sel.id === 'CH-A' && tsel.nodes === 2 && tsel.edges === 1, JSON.stringify(tsel.sel ?? {}))
    ok('C 选票染选: deps 边 lit (邻接全亮 → 零淡出)', tsel.lit === 1 && tsel.dims === 0 && tsel.selRows >= 1, `lit=${tsel.lit} dims=${tsel.dims}`)
    await c.cdp.shot(shot('dag-ticket-highlight.png'))

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

    // PMWEB-FLEET-SIDE: 树展开持票 (有序) + 点票行开侧栏 + 最新 turn end 原文
    const fs0 = await c.cdp.eval(`({
      toggles: [...document.querySelectorAll('.org-toggle')].map((b) => b.dataset.org),
      sideHidden: document.getElementById('fleet-side') ? document.getElementById('fleet-side').hidden : null,
    })`)
    ok('PMWEB-FLEET-SIDE: 持票席位带展开 chevron + 侧栏容器收起', fs0.toggles.includes('w1') && fs0.sideHidden === true, JSON.stringify(fs0))
    await c.cdp.eval(clickEl('.org-toggle[data-org="w1"]'))
    await sleep(200)
    const fs1 = await c.cdp.eval(`(() => {
      const rows = [...document.querySelectorAll('.org-tickets .tk-row')]
      return { n: rows.length, idx: rows.map((r) => r.querySelector('.tk-idx').textContent).join(','), first: rows[0] ? rows[0].dataset.tk : null }
    })()`)
    ok('PMWEB-FLEET-SIDE: 展开持票按序 (idx 1..n, 首行 RUN-1)', fs1.n === 1 && fs1.idx === '1' && fs1.first === 'RUN-1', JSON.stringify(fs1))
    await c.cdp.eval(clickEl('.org-tickets .tk-row'))
    await sleep(400)
    const fs2 = await c.cdp.eval(`(() => {
      const s = document.getElementById('fleet-side')
      return { visible: s && !s.hidden, title: (s.querySelector('.fs-head h3') || {}).textContent || '', fields: s.querySelectorAll('.fs-fields dt').length }
    })()`)
    ok('PMWEB-FLEET-SIDE: 点票行开侧栏 (不弹窗), 字段面在场', fs2.visible && /票 /.test(fs2.title) && fs2.fields >= 5, JSON.stringify(fs2))
    let fs3 = { meta: '', text: '' }
    for (let i = 0; i < 20; i++) {
      fs3 = await c.cdp.eval(`({
        meta: (document.getElementById('fs-turn-meta') || {}).textContent || '',
        text: (document.getElementById('fs-turn-text') || {}).textContent || '',
      })`)
      if (!/加载中/.test(fs3.meta)) break
      await sleep(300)
    }
    ok('PMWEB-FLEET-SIDE: 最新 turn end 原文 (turn 3 · step 9 · 跳过纯 tool-call 消息)',
      /turn 3/.test(fs3.meta) && /step 9/.test(fs3.meta) && fs3.text.includes('SMOKE-TURN-END-ALPHA'), JSON.stringify(fs3))
    const fs4 = await c.cdp.eval(`(() => {
      document.querySelector('.seat-mini[data-code="w1"]').click()
      return new Promise((res) => setTimeout(() => {
        const row = document.querySelector('#seat-detail .tk-row')
        if (!row) { res({ row: false }); return }
        row.click()
        setTimeout(() => res({ row: true, dlgClosed: !document.getElementById('seat-detail').hasAttribute('open'), side: !document.getElementById('fleet-side').hidden }), 250)
      }, 250))
    })()`, true)
    ok('PMWEB-FLEET-SIDE: 浮层持票行点击 → 关浮层开侧栏 (弹窗改侧栏)', fs4.row === true && fs4.dlgClosed === true && fs4.side === true, JSON.stringify(fs4))

    // PMWEB-3TAB: 席位「在图中聚焦」→ 切图 tab + scope=fleet:<code> (持票全展开)
    await c.cdp.eval(clickEl('.dg-focus[data-dg-focus="w1"]'))
    await sleep(900)
    const foc = await c.cdp.eval(`({
      hash: location.hash,
      scope: window.__pmDag.scope,
      nodes: window.__pmDag.nodes,
      out: window.__pmDag.outClusters,
      selVal: (document.querySelector('#dg-scope') || {}).value || '',
    })`)
    ok('C 3TAB: 席位在图中聚焦 → scope=fleet:w1 (持票 RUN-1 全展开, 无出界)', foc.hash === '#view-dag' && foc.scope === 'fleet:w1' && foc.nodes === 1 && foc.out === 0 && foc.selVal === 'fleet:w1', JSON.stringify(foc))
    await c.cdp.shot(shot('3tab-fleet-focus.png'))

    // PMWEB-ARCHIVE: 终态票归档 → 归档区 → 还原 (localStorage 往返, 看板计数还原)
    // PMWEB-REPO: 归档池 (无仓 3 票) 并存 —— 计数选择器排除 pool-open 区, 互不污染
    await c.cdp.eval(`document.querySelector('[data-view="tickets"]').click()`)
    await sleep(300)
    const archA = await c.cdp.eval(`({
      cards: document.querySelectorAll('#view-tickets .kanban:not(.archive-open):not(.pool-open) .ticket-card').length,
      btns: document.querySelectorAll('#view-tickets .kanban:not(.archive-open):not(.pool-open) .arch-btn[data-arch]').length,
      terminal: [...document.querySelectorAll('#view-tickets .kanban:not(.archive-open):not(.pool-open) .ticket-card')]
        .filter((el) => /st-(done|merged|rejected)/.test(el.querySelector('.state-badge').className)).length,
      pool: !!document.querySelector('#tk-pool'),
      poolOpen: document.querySelector('#tk-pool') ? document.querySelector('#tk-pool').open : null,
      poolCards: document.querySelectorAll('#tk-pool .ticket-card').length,
    })`)
    ok('PMWEB-ARCHIVE: 仅终态票卡带归档钮 (钮数=终态卡数, 非终态不可归档)', archA.cards === 4 && archA.btns === archA.terminal && archA.btns === 2, JSON.stringify(archA))
    ok('C REPO: 无仓归档折叠区在场且默认收起 (3 卡)', archA.pool && archA.poolOpen === false && archA.poolCards === 3, JSON.stringify({ pool: archA.pool, poolOpen: archA.poolOpen, poolCards: archA.poolCards }))
    // 归档池纯展示: 无 data-tid (零图联动) + 无归档钮; 展开可见
    const poolPure = await c.cdp.eval(`(() => {
      const d = document.querySelector('#tk-pool')
      d.open = true
      const cards = [...d.querySelectorAll('.ticket-card')]
      return {
        n: cards.length,
        linked: d.querySelectorAll('.ticket-card[data-tid]').length,
        btns: d.querySelectorAll('.arch-btn').length,
        cls: cards[0] ? cards[0].className : '',
      }
    })()`)
    ok('C REPO: 归档池展开可见且纯展示 (零 data-tid 零归档钮, pool 弱化态)', poolPure.n === 3 && poolPure.linked === 0 && poolPure.btns === 0 && /\bpool\b/.test(poolPure.cls), JSON.stringify(poolPure))
    await c.cdp.shot(shot('repo-pool-expanded.png'))
    await c.cdp.eval(clickEl('#view-tickets .arch-btn[data-arch]'))
    await sleep(200)
    const archB = await c.cdp.eval(`({
      toggle: (document.querySelector('#arch-toggle') || {}).textContent || '',
      board: document.querySelectorAll('#view-tickets .kanban:not(.archive-open):not(.pool-open) .ticket-card').length,
      ls: localStorage.getItem('pmweb:archive:v1'),
    })`)
    ok('PMWEB-ARCHIVE: 归档 → 看板 -1 + 计数 1 + localStorage 落盘', /1/.test(archB.toggle) && archB.board === 3 && !!archB.ls, JSON.stringify(archB))
    await c.cdp.eval(clickEl('#arch-toggle'))
    await sleep(200)
    const archC = await c.cdp.eval(`({ open: !!document.querySelector('#view-tickets .kanban.archive-open'), un: !!document.querySelector('[data-unarch]') })`)
    ok('PMWEB-ARCHIVE: 归档区展开 + 还原钮在场', archC.open && archC.un, JSON.stringify(archC))
    await c.cdp.eval(clickEl('[data-unarch]'))
    await sleep(200)
    const archD = await c.cdp.eval(`localStorage.getItem('pmweb:archive:v1')`)
    ok('PMWEB-ARCHIVE: 还原 → 归档集清空 (看板复原)', archD === '[]', `ls=${archD}`)

    // 回归: 票视图 kanban 与画布 tab 在场可用
    await c.cdp.eval(`document.querySelector('[data-view="tickets"]').click()`)
    await sleep(300)
    const kanban = await c.cdp.eval(`document.querySelectorAll('#view-tickets .ticket-card').length`)
    ok('C 回归: 票视图 kanban 照常渲染 (4 仓卡 + 3 归档池卡 = 7)', kanban === 7, `cards=${kanban}`)

    // PMWEB-REPO: 票 tab 容器优先看板 (仓分组主体; 归档池收折叠区; 无未分配并列桶)
    const cwdG = await c.cdp.eval(`({
      groups: [...document.querySelectorAll('#view-tickets .cwd-group')].map((g) => ({
        cwd: g.dataset.cwd,
        name: (g.querySelector('.cwd-name') || {}).textContent || '',
        n: g.querySelectorAll('.ticket-card').length,
        cols: g.querySelectorAll('.kanban .col').length,
      })),
      unassignedGroup: [...document.querySelectorAll('#view-tickets .cwd-group')].some((g) => g.dataset.cwd === ''),
    })`)
    ok('C REPO: 票看板仓分组主体 (alpha/beta 升序; 列结构不变; 零未分配并列桶)', cwdG.groups.length === 2
      && cwdG.groups[0].cwd === '/repo/alpha' && cwdG.groups[0].name === 'alpha' && cwdG.groups[0].n === 2
      && cwdG.groups[1].cwd === '/repo/beta' && cwdG.groups[1].n === 2
      && cwdG.unassignedGroup === false && cwdG.groups.every((g) => g.cols === 6), JSON.stringify(cwdG))
    // PMWEB-REPO: 选票联动 → 跳所在仓 (容器优先: 目标不在当前仓 → 切仓) + 染选 (卡片选中态)
    await c.cdp.eval(clickEl('#view-tickets .ticket-card[data-tid="CH-A"]'))
    await sleep(900)
    const link = await c.cdp.eval(`({
      hash: location.hash,
      visible: !document.querySelector('#view-dag').hidden,
      scope: window.__pmDag.scope,
      sel: window.__pmDag.selected,
      folded: window.__pmDag.folded,
      lit: document.querySelectorAll('#dag-svg .dg-lit').length,
      cardSel: !!document.querySelector('.ticket-card.tk-selected[data-tid="CH-A"]'),
    })`)
    ok('C REPO: 选票联动 → 切图 tab + 所在仓 scope + 染选 (卡片选中态)', link.hash === '#view-dag' && link.visible
      && link.scope === 'cwd:/repo/beta' && link.sel?.kind === 'ticket' && link.sel.id === 'CH-A' && link.folded.length === 0 && link.lit >= 1 && link.cardSel, JSON.stringify(link))
    // PMWEB-3TAB: 画布退役 (入口/视图/泳道场景/内省全不存在)
    const retired = await c.cdp.eval(`({
      btn: !!document.querySelector('[data-view="canvas"]'),
      sec: !!document.querySelector('#view-canvas'),
      stage: !!document.querySelector('#cv-stage'),
      intro: !!window.__pmCanvas,
    })`)
    ok('C 回归: 画布退役 (按钮/视图/泳道场景/内省零残留)', !retired.btn && !retired.sec && !retired.stage && !retired.intro, JSON.stringify(retired))
    ok('C 页面零异常 (全段)', errors.length === 0, errors.slice(0, 2).join(' | '))
  } finally {
    await killChrome(c)
    await box.stop()
  }
}

// ---------- D. PMWEB-GRAPH 几何门 (扩模 sandbox: G1 穿盒零求交 / G2 REPO 仓优先 / G3 折叠重取景) ----------
// G2 fixture: 4 flows (PMWEB-3TAB: 泳道场景退役, flows 仅喂 /op/graph counts 消费) + 25 票
// (7 基线 + GR1 跨簇 + OF 撞名组 + TW-1/OX-1 跨仓 deps 对 + AX-1/AR-9 无仓出界对 + DEN×8 dense 仓)
// + 4 席 (h1/w1/aa11/bb22) + 2 session;
// 仓标注: /repo/alpha×2 /repo/beta×2 /w/one×2 (TW-1,AX-1) /w/two×1 (OX-1) /w/dense×8, 无仓×10 (归档池);
// 默认 scope = /repo/alpha (首个仓升序)。TW-1 deps→OX-1 (跨仓可跳转), AX-1 deps→AR-9 (全员无仓 → 纯提示盒)。
const TICKETS_G2 = [
  ...TICKETS,
  { ticket_id: 'GX-1', state: 'running', deps: '["CH-A"]', refs: '{"run":"GR1"}', lease_owner: null },
  { ticket_id: 'GX-2', state: 'dispatched', deps: '[]', refs: '{"run":"GR1"}', lease_owner: null },
  { ticket_id: 'OF-1', state: 'done', deps: '[]', refs: '{}', lease_owner: null },
  { ticket_id: 'OF-2', state: 'done', deps: '["OF-1"]', refs: '{}', lease_owner: null },
  { ticket_id: 'OF-3', state: 'done', deps: '[]', refs: '{}', lease_owner: null },
  { ticket_id: 'OF-4', state: 'done', deps: '[]', refs: '{}', lease_owner: null },
  { ticket_id: 'TW-1', state: 'running', deps: '["OX-1"]', refs: '{"cwd":"/w/one"}', lease_owner: 'aa11' },
  { ticket_id: 'OX-1', state: 'done', deps: '[]', refs: '{"cwd":"/w/two"}', lease_owner: null },
  { ticket_id: 'AX-1', state: 'running', deps: '["AR-9"]', refs: '{"cwd":"/w/one"}', lease_owner: null },
  { ticket_id: 'AR-9', state: 'done', deps: '[]', refs: '{}', lease_owner: null }, // 归档池: 出界纯提示盒成员
  ...Array.from({ length: 8 }, (_, i) => ({ ticket_id: `DEN-${i + 1}`, state: 'done', deps: '[]', refs: '{"cwd":"/w/dense"}', lease_owner: null })),
]
const SEATS_G2 = {
  ...SEATS,
  aa11: { code: 'aa11', sessionId: '', role: 'worker', node: 'n-g2a', preset: 'long-task', spawnedAt: '2026-09-02T00:00:00Z', status: 'active' },
  bb22: { code: 'bb22', sessionId: '', role: 'worker', node: 'n-g2b', preset: 'long-task', spawnedAt: '2026-09-02T00:00:00Z', status: 'active' },
}
const chainNodes = (prefix, n, extra = {}) => Array.from({ length: n }, (_, i) => ({
  id: `${prefix}${i + 1}`, deps: i > 0 ? [`${prefix}${i}`] : [], ...extra,
}))
const FLOW_SPECS = {
  g1: {
    nodes: [
      { id: 'n1', deps: ['n2'] }, { id: 'n2', deps: ['n1'] }, // 双向对 ① (反向边来源)
      { id: 'n3', deps: ['n2'], verb: 'dispatch' }, { id: 'n4', deps: ['n1'] },
      { id: 'n5', deps: ['n3', 'n4'] }, { id: 'n6', deps: ['n5'], verb: 'dispatch' },
      { id: 'n7', deps: ['n6'] }, { id: 'n8', deps: ['n7'] },
    ],
    events: [{ node: 'n3', detail: 'spawn seat aa11 for steer' }, { node: 'n6', detail: 'reroute to seat bb22 now' }],
  },
  g2: {
    nodes: chainNodes('m', 8, { }),
    events: [{ node: 'm4', detail: 'dispatch to seat aa11 done' }],
  },
  g3: {
    nodes: [
      ...chainNodes('p', 4),
      { id: 'p5', deps: ['p3', 'p4'] }, { id: 'p6', deps: ['p5'] },
    ],
  },
  g4: { nodes: chainNodes('q', 6) },
}
// G1 几何扫描 (in-page): 边路径按长度采样, 与「非端点节点盒」(内缩 2px 容差) 求交计数。
// 坐标一律 user space (getBBox/transform vs getPointAtLength), 与 viewport transform 无关。
const geoSweep = (svgSel, nodeSel, edgeSel) => `(() => {
  const svg = document.querySelector('${svgSel}')
  if (!svg) return { error: 'no svg' }
  const boxes = new Map()
  for (const g of svg.querySelectorAll('${nodeSel}')) {
    const m = /translate\\(([-\\d.]+)px,\\s*([-\\d.]+)px\\)/.exec(g.style.transform || '')
    const r = g.querySelector('rect, path')
    if (!m || !r) continue
    const b = r.getBBox()
    boxes.set(g.dataset.id, { x: +m[1] + b.x, y: +m[2] + b.y, w: b.width, h: b.height })
  }
  const TOL = 2
  let samples = 0
  const hits = []
  const edges = [...svg.querySelectorAll('${edgeSel}')]
  for (const p of edges) {
    const id = p.getAttribute('data-edge') || ''
    const ends = new Set(id.replace(/^[a-z-]+:/, '').split('>'))
    let len = 0
    try { len = p.getTotalLength() } catch { continue }
    const n = Math.min(80, Math.max(12, Math.ceil(len / 6)))
    for (let i = 0; i <= n; i++) {
      const pt = p.getPointAtLength((len * i) / n)
      samples++
      for (const [nid, b] of boxes) {
        if (ends.has(nid)) continue
        if (pt.x > b.x + TOL && pt.x < b.x + b.w - TOL && pt.y > b.y + TOL && pt.y < b.y + b.h - TOL) {
          hits.push(id + '@' + nid + '(' + pt.x.toFixed(0) + ',' + pt.y.toFixed(0) + ')')
        }
      }
    }
  }
  return { edges: edges.length, nodes: boxes.size, samples, violations: hits.length, hits: hits.slice(0, 5) }
})()`

async function graphPart() {
  const shot = (f) => `${BASE}/${f}`
  const errors = []
  const box = await startSandbox('g2graph', { fleet: SEATS_G2, tickets: TICKETS_G2, flows: FLOW_SPECS })
  let c = null
  try {
    c = await newChrome('g2')
    c.cdp.on((m) => { if (m.method === 'Runtime.exceptionThrown') errors.push(JSON.stringify(m.params?.exceptionDetails ?? {}).slice(0, 160)) })
    await c.cdp.send('Page.enable')
    await c.cdp.send('Runtime.enable')
    await c.cdp.send('Page.navigate', { url: `http://127.0.0.1:${box.port}/` })
    let ready = false
    for (let i = 0; i < 100 && !ready; i++) { await sleep(300); try { ready = await c.cdp.eval('window.__pmDag && window.__pmDag.ready === true') } catch {} }
    ok('G2 页面就绪 (扩模 sandbox 图 tab scope-DAG)', ready)

    // 图 tab: 容器优先默认仓 (泳道画布已退役 —— G2 泳道/箭头/双向对断言随场景同步移除)
    await c.cdp.eval(`document.querySelector('[data-view="dag"]').click()`)
    await sleep(1500)
    const dag = await c.cdp.eval(`({
      scope: window.__pmDag.scope, nodes: window.__pmDag.nodes, edges: window.__pmDag.edges,
      archive: window.__pmDag.archive, clusters: window.__pmDag.clusters,
      counts: (document.querySelector('#dg-counts') || {}).textContent || '',
    })`)
    ok('G2 REPO: 默认首个仓 /repo/alpha (升序) + 归档池 10 零入场 + 全量口径注记', dag.scope === 'cwd:/repo/alpha' && dag.nodes === 2 && dag.clusters === 1 && dag.archive === 10
      && /仓 15 票 · 归档 10 零入场/.test(dag.counts) && /graph 全量/.test(dag.counts), JSON.stringify({ scope: dag.scope, nodes: dag.nodes, archive: dag.archive, counts: dag.counts.slice(0, 80) }))
    await c.cdp.shot(shot('g2-dag-default-repo.png'))

    // dense 仓: 标签零溢出 (8 成员全展开) + 折叠重取景
    await c.cdp.eval(`(() => {
      const sel = document.querySelector('#dg-scope')
      sel.value = 'cwd:/w/dense'
      sel.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)
    await sleep(1200)
    const dense = await c.cdp.eval(`({
      scope: window.__pmDag.scope, nodes: window.__pmDag.nodes,
      listLabel: (document.querySelector('#dg-list .dg-label') || {}).textContent || '',
      listKind: (document.querySelector('#dg-list .dg-kind') || {}).textContent || '',
    })`)
    ok('G3 dense 仓: 8 成员 fam 簇全展开 + 列表行在场', dense.scope === 'cwd:/w/dense' && dense.nodes === 8 && dense.listLabel === 'DEN' && dense.listKind === 'prefix', JSON.stringify(dense))
    const fit = await c.cdp.eval(`(() => {
      let over = 0
      for (const g of document.querySelectorAll('#dag-svg .dg-node')) {
        const t = g.querySelector('.dg-label'); const r = g.querySelector('rect')
        if (!t || !r) continue
        if (t.getComputedTextLength() > r.getBBox().width - 20) over++
      }
      return { over, nodes: document.querySelectorAll('#dag-svg .dg-node').length }
    })()`)
    ok('F7 标签: CJK/长标签实测估宽 → 零溢出盒框', fit.over === 0 && fit.nodes >= 7, JSON.stringify(fit))
    await c.cdp.eval(clickEl('#dg-list .dg-fold-btn[data-fold="fam:DEN"]'))
    await sleep(1200)
    const foldedFit = await c.cdp.eval('({ nodes: window.__pmDag.nodes, folded: window.__pmDag.folded, view: window.__pmDag.view })')
    ok('G3 折叠重取景: fam 折叠为超节点 (8→1) + fit 生效', foldedFit.nodes === 1 && foldedFit.folded.includes('fam:DEN') && foldedFit.view.s > 0, JSON.stringify(foldedFit))
    await c.cdp.shot(shot('g2-dense-folded.png'))

    // /w/one 仓内场景: 2 仓票 + 出界盒两态 (跨仓可跳转 OX-1 / 无仓纯提示 AR-9)
    await c.cdp.eval(`(() => {
      const sel = document.querySelector('#dg-scope')
      sel.value = 'cwd:/w/one'
      sel.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)
    await sleep(1200)
    const scoped = await c.cdp.eval(`({
      scope: window.__pmDag.scope,
      nodes: window.__pmDag.nodes,
      edges: window.__pmDag.edges,
      out: window.__pmDag.outClusters,
      jumps: window.__pmDag.outJumps,
      ids: [...document.querySelectorAll('#dag-svg .dg-node')].map((g) => g.dataset.id),
      jumpGlyph: !!document.querySelector('#dag-svg .dg-node[data-id="out:one:OX-1"] .dg-fold'),
      hintClass: ((document.querySelector('#dag-svg .dg-node[data-id="out:one:AR-9"]') || {}).getAttribute('class')) || '',
      hintGlyph: !!document.querySelector('#dag-svg .dg-node[data-id="out:one:AR-9"] .dg-fold'),
      hintSub: (document.querySelector('#dag-svg .dg-node[data-id="out:one:AR-9"] .dg-sub') || {}).textContent || '',
      outEdge: !!document.querySelector('#dag-svg .dg-edge[data-edge="dep:tk:TW-1>out:one:OX-1"]'),
      outEdge2: !!document.querySelector('#dag-svg .dg-edge[data-edge="dep:tk:AX-1>out:one:AR-9"]'),
    })`)
    ok('G2 REPO: scope /w/one → 2 仓票 + 出界盒 2 (独立聚合非 ghost), 跨仓边 2', scoped.scope === 'cwd:/w/one' && scoped.nodes === 4 && scoped.out === 2 && scoped.edges === 2
      && scoped.ids.includes('tk:TW-1') && scoped.ids.includes('tk:AX-1') && scoped.ids.includes('out:one:OX-1') && scoped.ids.includes('out:one:AR-9')
      && scoped.outEdge && scoped.outEdge2, JSON.stringify({ ...scoped, ids: undefined }))
    ok('G2 REPO 出界盒两态: OX-1 可跳转 (jumpCwd=/w/two, ⤴ 角标) / AR-9 纯提示 (无仓, 无角标, 提示语)', JSON.stringify(scoped.jumps) === JSON.stringify([{ key: 'one:AR-9', jumpCwd: '' }, { key: 'one:OX-1', jumpCwd: '/w/two' }])
      && scoped.jumpGlyph && scoped.hintClass.includes('t-out-hint') && !scoped.hintGlyph && /无仓/.test(scoped.hintSub), JSON.stringify({ jumps: scoped.jumps, jumpGlyph: scoped.jumpGlyph, hintClass: scoped.hintClass, hintGlyph: scoped.hintGlyph, hintSub: scoped.hintSub }))
    await c.cdp.shot(shot('3tab-scope-cwd-outcluster.png'))
    // 纯提示盒点击 → 不跳转 (scope 不变)
    await c.cdp.eval(clickNode('.dg-node[data-id="out:one:AR-9"]'))
    await sleep(700)
    const hintClick = await c.cdp.eval('({ scope: window.__pmDag.scope, nodes: window.__pmDag.nodes })')
    ok('G2 REPO: 纯提示盒点击零跳转 (scope 保持 /w/one)', hintClick.scope === 'cwd:/w/one' && hintClick.nodes === 4, JSON.stringify(hintClick))
    // 跨仓跳转: 出界盒点击 → 切成员多数仓 (/w/two) + 染选聚焦该簇
    await c.cdp.eval(clickNode('.dg-node[data-id="out:one:OX-1"]'))
    await sleep(1200)
    const refoc = await c.cdp.eval(`({
      scope: window.__pmDag.scope,
      selVal: (document.querySelector('#dg-scope') || {}).value || '',
      nodes: window.__pmDag.nodes,
      out: window.__pmDag.outClusters,
      sel: window.__pmDag.selected,
      ids: [...document.querySelectorAll('#dag-svg .dg-node')].map((g) => g.dataset.id),
      selCls: ((document.querySelector('#dag-svg .dg-node[data-id="tk:OX-1"]') || {}).getAttribute('class')) || '',
    })`)
    ok('G2 REPO: 出界盒点击跨仓跳转 → scope cwd:/w/two + 1 节点 + 染选聚焦簇 one:OX-1', refoc.scope === 'cwd:/w/two' && refoc.selVal === 'cwd:/w/two' && refoc.nodes === 1 && refoc.out === 0
      && refoc.sel?.kind === 'cluster' && refoc.sel.key === 'one:OX-1' && refoc.ids.join() === 'tk:OX-1' && /\bdg-sel\b/.test(refoc.selCls), JSON.stringify(refoc))
    await c.cdp.shot(shot('3tab-scope-refocus-cluster.png'))
    // G1 几何: /w/one 回切 (2 出界边场景) 采样零穿盒
    await c.cdp.eval(`(() => {
      const sel = document.querySelector('#dg-scope')
      sel.value = 'cwd:/w/one'
      sel.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)
    await sleep(1200)
    const geoDag = await c.cdp.eval(geoSweep('#dag-svg', '.dg-node', '.dg-edge'))
    ok('G1 DAG: 边采样点 vs 非端点节点盒零求交 (容差 2px)', geoDag.edges >= 2 && geoDag.violations === 0, JSON.stringify(geoDag))
    ok('D 页面零异常 (全段)', errors.length === 0, errors.slice(0, 2).join(' | '))
  } finally {
    await killChrome(c)
    await box.stop()
  }
}

// ---------- 运行 ----------
mkdirSync(BASE, { recursive: true })
const startedAt = new Date().toISOString()
await sandboxPart()
await graphPart()
writeFileSync(`${BASE}/manifest.json`, `${JSON.stringify({ label: LABEL, gate: 'pmweb-dag', startedAt, finishedAt: new Date().toISOString(), pass, fail, node: process.version, repo: REPO }, null, 2)}\n`)
console.log(`\n=== ${LABEL}: PASS=${pass} FAIL=${fail} (evidence: ${BASE}) ===`)
process.exit(fail === 0 ? 0 : 1)
