#!/usr/bin/env node
// backfill-cwd — ledger tickets refs.cwd 回填 (PMWEB-CWD, 用户裁决: refs 路径回填)
// 推导链 (序): ① lease_owner 归一 code → fleet 席位 → 席位 sessionId → ~/.dsh/sessions 元数据 cwd
//             ② refs.run → 提及该 run id 的会话转录 → 其 header cwd (全候选一致才采信)
//             ③ 皆无 → 不回填 (留空, 前端「未分配」桶)
// 用法: backfill-cwd.mjs [--apply] [--json]
//   缺省 dry-run: 只打印分类报告, 零写。--apply: 先备份 ledger.db.bak-cwd-<ts>,
//   再经 bin/ledger (flock+ticket_events 审计) 逐票写 refs.cwd — 只动 cwd 键,
//   幂等 WHERE 语义 (已等值即跳过), state/deps/lease_owner 零触碰。
// 数据源 (勘察结论 2026-09-08):
//   ~/.dsh/sessions/<cwd-slug桶>/<session-uuid>/session.jsonl.zstd 首行 =
//   {"type":"session","id":...,"cwd":"/abs/path",...} — cwd 精确形态, 桶名歧义绕开。
import { DatabaseSync } from 'node:sqlite'
import { spawn, execFile } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync, renameSync, existsSync, copyFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const DSH = join(homedir(), '.dsh')
const SESSIONS = join(DSH, 'sessions')
const FLEET = join(DSH, 'maestro/fleet.json')
const DB = process.env.MAESTRO_LEDGER ?? join(DSH, 'maestro/ledger.db')
const LEDGER = join(import.meta.dirname, 'ledger') // 同仓 bin/ledger (flock + ticket_events 审计的正规写面)
const APPLY = process.argv.includes('--apply')
const AS_JSON = process.argv.includes('--json')
const P = 8 // 会话索引并行度

const leaseCode = (v) => (typeof v === 'string' && v ? v.split(/[/@]/)[0].trim() : '') // 与 pm-host-service 两端同规则

const sh = (cmd, args) => new Promise((res) => execFile(cmd, args, { maxBuffer: 1 << 26 }, (e, so, se) => res({ err: e, out: so, errOut: se })))

// ---- sid → cwd 索引 (转录首行, 精确 cwd) ----
async function buildSidIndex() {
  const buckets = readdirSync(SESSIONS).filter((b) => !b.startsWith('.'))
  const jobs = []
  for (const b of buckets) {
    for (const s of readdirSync(join(SESSIONS, b))) {
      const f = join(SESSIONS, b, s, 'session.jsonl.zstd')
      if (existsSync(f)) jobs.push({ sid: s, file: f })
    }
  }
  const index = new Map()
  let done = 0
  await Promise.all(Array.from({ length: P }, async () => {
    while (jobs.length) {
      const j = jobs.pop()
      const r = await sh('zstd', ['-dc', j.file])
      const line = (r.out.split('\n')[0] ?? '').trim()
      try {
        const h = JSON.parse(line)
        if (h.type === 'session' && h.cwd) index.set(h.id, { cwd: h.cwd, bucket: j.file.split('/sessions/')[1].split('/')[0], preset: h.agentPreset ?? null, createdAt: h.createdAt ?? null })
      } catch { /* 损坏头跳过, 计入索引损耗 */ }
      done++
      if (done % 100 === 0) console.error(`  …索引 ${done}`)
    }
  }))
  return { index, scanned: done }
}

// ---- run id → cwd (链②主源: Orca 编排注册表 orchestration.db 的 tasks.spec 路径字面量多数派;
//      副源弃用说明: 转录全文提及被 tickets.md 阅读污染 — 读过票板的会话都带 run id, 不可采信) ----
async function resolveRuns(runIds) {
  const out = new Map() // runId -> { cwd | null, detail }
  if (!runIds.size) return out
  const ORCH = join(homedir(), '.config/orca/orchestration.db')
  if (!existsSync(ORCH)) { for (const rid of runIds) out.set(rid, { cwd: null, detail: 'orchestration.db 不存在' }); return out }
  // WAL 快照拷贝只读 (原库被 Orca 进程持有, 直接只读打开会撞 WAL 锁)
  const snap = join(tmpdir(), `orch-cwd-snap-${process.pid}.db`)
  copyFileSync(ORCH, snap)
  for (const ext of ['-wal', '-shm']) { try { if (existsSync(ORCH + ext)) copyFileSync(ORCH + ext, snap + ext) } catch {} }
  const odb = new DatabaseSync(snap, { readOnly: true })
  for (const rid of runIds) {
    const specs = odb.prepare('select spec from tasks where run_id = ?').all(rid).map((r) => r.spec ?? '')
    const counts = new Map()
    for (const s of specs) for (const m of String(s).matchAll(/\/home\/yy\/[a-zA-Z0-9._/-]+/g)) counts.set(m[0], (counts.get(m[0]) || 0) + 1)
    const total = [...counts.values()].reduce((a, b) => a + b, 0)
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1])
    if (sorted.length === 1) out.set(rid, { cwd: sorted[0][0], detail: `registry: ${specs.length} tasks, 路径字面量唯一 (${sorted[0][1]} 处)` })
    else if (sorted.length > 1 && sorted[0][1] > sorted[1][1]) out.set(rid, { cwd: sorted[0][0], detail: `registry: ${specs.length} tasks, 路径多数派 ${sorted[0][1]}/${total} (次: ${sorted[1][0]}:${sorted[1][1]})` })
    else if (sorted.length > 1) out.set(rid, { cwd: null, detail: `registry: 路径字面量并列冲突 ${sorted.slice(0, 3).map((e) => `${e[0]}:${e[1]}`).join(' | ')} — 不采信` })
    else out.set(rid, { cwd: null, detail: `registry: ${specs.length} tasks 无 /home/yy 路径字面量` })
  }
  odb.close()
  for (const ext of ['', '-wal', '-shm']) { try { if (existsSync(snap + ext)) rmSync(snap + ext) } catch {} }
  return out
}

const uniq = (a) => [...new Set(a)]

// ---- 主流程 ----
const { index: sidIndex, scanned } = await buildSidIndex()
console.error(`会话索引: ${sidIndex.size}/${scanned} 个转录可解析`)
const db = new DatabaseSync(DB, { readOnly: true })
const tickets = db.prepare('select ticket_id, state, lease_owner, refs from tickets order by ticket_id').all()
db.close()
const fleet = (() => { const j = JSON.parse(readFileSync(FLEET, 'utf8')); return j.fleet ?? j })()
const fleetByCode = new Map(Object.entries(fleet).map(([code, s]) => [code, s]))

const runIds = uniq(tickets.map((t) => { try { const r = JSON.parse(t.refs ?? '{}'); return typeof r.run === 'string' && r.run.startsWith('run_') ? r.run : null } catch { return null } }).filter(Boolean))
console.error(`run id 集合: ${runIds.join(', ') || '(无)'}`)
const runMap = await resolveRuns(new Set(runIds))

const rows = []
for (const t of tickets) {
  let refs = {}
  let refsErr = null
  try { refs = JSON.parse(t.refs ?? '{}') } catch (e) { refsErr = e?.message ?? String(e) }
  const row = { ticket: t.ticket_id, state: t.state, lease: t.lease_owner, chain: null, source: null, cwd: null, note: refsErr ? `refs 非JSON: ${refsErr}` : null }
  // ① lease → 席位 → session cwd
  const code = leaseCode(t.lease_owner)
  if (code) {
    const seat = fleetByCode.get(code)
    if (seat?.sessionId) {
      const sid = String(seat.sessionId).replace(/^session-/, '')
      const rec = sidIndex.get(sid)
      if (rec) { row.chain = '①lease→席位→session'; row.source = `fleet:${code}→${sid.slice(0, 8)}`; row.cwd = rec.cwd }
      else row.note = (row.note ? row.note + '; ' : '') + `席位 ${code} 会话 ${sid.slice(0, 8)} 无转录索引`
    } else row.note = (row.note ? row.note + '; ' : '') + `lease code ${code} 无在场席位`
  }
  // ② refs.run → 编排注册表 (orchestration.db runs→tasks.spec 路径字面量多数派)
  if (!row.cwd && typeof refs.run === 'string' && refs.run.startsWith('run_')) {
    const hit = runMap.get(refs.run)
    if (hit?.cwd) { row.chain = '②refs.run→编排注册表'; row.source = hit.detail; row.cwd = hit.cwd }
    else row.note = (row.note ? row.note + '; ' : '') + `run ${refs.run}: ${hit?.detail ?? '无解析'}`
  }
  if (!row.cwd && !row.chain) row.chain = '③无源'
  row.existing = typeof refs.cwd === 'string' ? refs.cwd : null
  row.refsKeys = Object.keys(refs).sort()
  rows.push(row)
}

// 额外观察 (非本票推导链, 未计入可回填 — 供编排席裁决): lease @ 后缀是会话 uuid 前缀
const extraLeaseSid = []
for (const t of tickets) {
  const m = /@(?:subagent-|session-)?([0-9a-f]{8})/.exec(t.lease_owner ?? '')
  if (!m) continue
  const hit = [...sidIndex.entries()].find(([sid]) => sid.startsWith(m[1]))
  if (hit) extraLeaseSid.push({ ticket: t.ticket_id, lease: t.lease_owner, sid: hit[0].slice(0, 8), cwd: hit[1].cwd })
}

// ---- 分类汇总 ----
const backfill = rows.filter((r) => r.cwd)
const noSource = rows.filter((r) => !r.cwd)
const perCwd = {}
for (const r of backfill) perCwd[r.cwd] = (perCwd[r.cwd] || 0) + 1
const alreadyEq = backfill.filter((r) => r.existing === r.cwd)
const conflicts = backfill.filter((r) => r.existing != null && r.existing !== r.cwd)
const summary = {
  total: rows.length,
  byState: rows.reduce((m, r) => (m[r.state] = (m[r.state] || 0) + 1, m), {}),
  backfillable: backfill.length,
  noSource: noSource.length,
  alreadyEq: alreadyEq.length,
  conflicts: conflicts.length,
  perCwd,
  noSourceReasons: noSource.reduce((m, r) => { const k = (r.note ?? '无 lease 无 run').replace(/x[0-9a-f]{8}/g, 'x*').slice(0, 60); m[k] = (m[k] || 0) + 1; return m }, {}),
  extraLeaseSidResolvable: extraLeaseSid.length,
}

if (AS_JSON) {
  console.log(JSON.stringify({ summary, backfill, noSource, extraLeaseSid }, null, 1))
} else {
  console.log('== PMWEB-CWD dry-run 分类报告 ==')
  console.log(`总票数 ${summary.total}  状态: ${JSON.stringify(summary.byState)}`)
  console.log(`可回填 ${summary.backfillable} ｜ 无源 ${summary.noSource} ｜ 已等值(幂等跳过) ${summary.alreadyEq} ｜ 现值冲突 ${summary.conflicts}`)
  console.log('per-cwd 分布:')
  for (const [c, n] of Object.entries(summary.perCwd).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${c}`)
  console.log('无源原因分布:')
  for (const [k, n] of Object.entries(summary.noSourceReasons).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`)
  console.log('可回填明细:')
  for (const r of backfill) console.log(`  ${r.ticket.padEnd(14)} ${String(r.state).padEnd(11)} ${r.chain}  ${r.cwd}  [${r.source ?? ''}]${r.existing != null ? (r.existing === r.cwd ? ' (已等值)' : ` (现值冲突: ${r.existing})`) : ''}`)
  if (extraLeaseSid.length) {
    console.log('额外观察 (推导链外, 未计入可回填 — lease @ 后缀即会话 id 前缀, 可解析者):')
    for (const e of extraLeaseSid) console.log(`  ${e.ticket.padEnd(14)} ${e.lease} → ${e.sid} → ${e.cwd}`)
  }
}

if (APPLY) {
  const targets = backfill.filter((r) => r.existing !== r.cwd) // 幂等 WHERE 语义: 已等值跳过
  if (!targets.length) { console.log('apply: 无需写入 (全部已等值)'); process.exit(0) }
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '')
  const bak = `${DB}.bak-cwd-${ts}`
  copyFileSync(DB, bak)
  console.log(`备份: ${bak} (${targets.length} 票待写)`)
  let okN = 0, failN = 0
  for (const r of targets) {
    // 只动 refs.cwd 键: 读-改-写整个 refs JSON, 其余键原样保留; 经 bin/ledger 走 flock+事件审计
    const d2 = new DatabaseSync(DB, { readOnly: true })
    const raw = d2.prepare('select refs from tickets where ticket_id = ?').get(r.ticket)?.refs ?? '{}'
    d2.close()
    let obj = {}; try { obj = JSON.parse(raw) } catch {}
    obj.cwd = r.cwd
    const res = await sh(LEDGER, ['ticket', 'refs-set', r.ticket, '--json', JSON.stringify(obj)])
    if (res.err || /error|拒绝/i.test(res.out + res.errOut)) { failN++; console.log(`  ✗ ${r.ticket}: ${(res.out + res.errOut).slice(0, 120)}`) } else { okN++; console.log(`  ✓ ${r.ticket} → ${r.cwd}`) }
  }
  console.log(`apply 完成: ok=${okN} fail=${failN} (备份 ${bak})`)
} else {
  console.log('(dry-run — 未写任何数据; 实填: backfill-cwd.mjs --apply, 先备份+幂等跳过+经 bin/ledger 审计写面)')
}
