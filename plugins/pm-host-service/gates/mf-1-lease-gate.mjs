#!/usr/bin/env node
// mf-1-lease-gate.mjs — MF-1 持票死视图接线 gate (派发三环 SOP: claim+state+lease)
//
// A. 静态门: bin/dispatch-ticket 持票三环接线 (ticket 勾稽 add + lease 挂席位,
//    WARN-continue 策略) + --dry-run 契约不变 (OF-003: dry-run 不发送不落账)
//    + conventions 文档三环 SOP 在册 (docs/orch-fleet-conventions.md)。
// B. 台账门 (真实 ledger.db 只读): state∈{dispatched,running} 的票 lease_owner
//    非空; 豁免=显式白名单 (无席位纯记录票); 违例应=0 (撰写刻: AND5-1=a804,
//    DH1-1=fe86, MF-1=9b8b 在挂)。/op/tickets 持票计数 (lease_owner→席位卡)
//    是准绳——本门即其不变式。
// C. 沙箱功能门 (HOME 重定向全隔离, 跑真实 bin/dispatch-ticket + bin/ledger,
//    mock orca send): 三环落账 → 幂等重派 (lease 随执行席位迁移) → 复核票面。
// 留存: $PM_HOST_SERVICE_GATES_DIR/mf-1-lease-gate/<label>/
// Usage: node mf-1-lease-gate.mjs <label>
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const LABEL = process.argv[2] ?? `manual-${process.pid}`
const GATES_ROOT = process.env.PM_HOST_SERVICE_GATES_DIR ?? `${homedir()}/.dsh/maestro/logs/pm-host-service/gates`
const BASE = `${GATES_ROOT}/mf-1-lease-gate/${LABEL}`
const REPO = new URL('../../..', import.meta.url).pathname // plugins/pm-host-service/gates → repo root
const REAL_HOME = homedir()

// 显式白名单: 无席位的纯记录票 (dispatched/running 却无 lease 的唯一合法情形)。
// 入册须带一行理由注释; 出册即恢复强校验。撰写刻为空。
const WHITELIST = new Set([
  // (无)
])

mkdirSync(BASE, { recursive: true })
let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}${detail ? `  :: ${detail}` : ''}`) } else { fail++; console.log(`FAIL ${name}${detail ? `  :: ${detail}` : ''}`) }
}

// ---------- A. 静态门 ----------
{
  const src = readFileSync(`${REPO}/bin/dispatch-ticket`, 'utf8')
  ok('A 接线: ticket 勾稽 (无票先 add, refs 带溯源)', /ticket.*add/.test(src) && /dispatch-ticket/.test(src) && /'--refs'/.test(src))
  ok('A 接线: ticket lease 挂执行席位 (持票三环第三环)', /'ticket',\s*'lease',\s*ref,\s*worker/.test(src))
  ok('A 策略: 票环失败 WARN-continue (不回滚已发送派发)', /ticket lease failed \(continue\)/.test(src) && /ticket add failed \(continue\)/.test(src))
  ok('A 契约: --dry-run 仍先于 send/ledger 返回 (OF-003 零落账)', /if a\.dry_run:[\s\S]{0,400}return[\s\S]*?send\(a\.terminal/.test(src))
  const conv = readFileSync(`${REPO}/docs/orch-fleet-conventions.md`, 'utf8')
  ok('A 文档: 派发三环 SOP 在册 (claim+state+lease)', /三环/.test(conv) && /ticket lease/.test(conv))
}

// ---------- B. 台账门 (真实 ledger.db 只读) ----------
const LIVE_DB = process.env.MAESTRO_LEDGER ?? `${REAL_HOME}/.dsh/maestro/ledger.db`
{
  const db = new DatabaseSync(LIVE_DB, { readOnly: true })
  const total = db.prepare('SELECT COUNT(*) n FROM tickets').get().n
  ok('B 可达: ledger.db 票账在册且非空', total > 50, `tickets=${total}`)
  const active = db.prepare("SELECT ticket_id, lease_owner FROM tickets WHERE state IN ('dispatched','running') ORDER BY ticket_id").all()
  const violations = active.filter(t => !t.lease_owner && !WHITELIST.has(t.ticket_id))
  ok('B 不变式: dispatched/running 全部持票 (违例=0)', violations.length === 0,
    violations.length ? violations.map(t => t.ticket_id).join(',') : `active=${active.length} 全挂lease: ${active.map(t => `${t.ticket_id}=${t.lease_owner}`).join(', ') || '(当前无活跃票)'}`)
  const exempt = active.filter(t => !t.lease_owner && WHITELIST.has(t.ticket_id))
  if (exempt.length) console.log(`  豁免(白名单): ${exempt.map(t => t.ticket_id).join(', ')}`)
  db.close()
}

// ---------- C. 沙箱功能门 (HOME 重定向全隔离) ----------
{
  const SB = mkdtempSync('/tmp/mf1-gate-')
  try {
    // 沙箱 HOME: dispatch-ticket 的 ~ 与 bin/ledger 的默认 DB 都落进来
    const sbHome = join(SB, 'home'), m = `${sbHome}/.dsh/maestro`
    mkdirSync(`${m}/bin`, { recursive: true }); mkdirSync(`${m}/templates`, { recursive: true }); mkdirSync(`${m}/bridge`, { recursive: true })
    cpSync(`${REPO}/bin/ledger`, `${m}/bin/ledger`)                                   // 被测: 仓库 ledger
    cpSync(`${REAL_HOME}/.dsh/maestro/templates/dispatch-preamble.md`, `${m}/templates/dispatch-preamble.md`)
    writeFileSync(`${m}/bridge/orch.signature`, 'gate-sig@session-mf1gate\n')
    // mock orca: terminal send 只落档不外发
    const mockOut = join(SB, 'sent.txt')
    writeFileSync(`${SB}/mock-orca`, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
const i = process.argv.indexOf('--text')
if (i >= 0) appendFileSync(${JSON.stringify(mockOut)}, process.argv[i + 1] + '\\n')
console.log(JSON.stringify({ ok: true, terminal: 'term_gate', bytes: i >= 0 ? process.argv[i + 1].length : 0 }))
`, { mode: 0o755 })
    // 播种 node 账 schema (真实库外部播种同款 DDL; tickets 表由 ledger 写路径自建)
    const sbDb = new DatabaseSync(`${m}/ledger.db`)
    sbDb.exec(`CREATE TABLE IF NOT EXISTS projects(
      key TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, repo_id TEXT,
      status TEXT NOT NULL DEFAULT 'unknown', summary TEXT, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS nodes(
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_key TEXT NOT NULL, node_id TEXT NOT NULL,
      kind TEXT NOT NULL, title TEXT, status TEXT NOT NULL DEFAULT 'pending', owner TEXT,
      refs TEXT, updated_at TEXT NOT NULL, UNIQUE(project_key, node_id));
      CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind, status);
      CREATE TABLE IF NOT EXISTS events(
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, project_key TEXT, node_id TEXT,
      event_type TEXT NOT NULL, source TEXT, detail TEXT);`)
    sbDb.close()
    const repo = join(SB, 'repo'); mkdirSync(`${repo}/docs`, { recursive: true })
    writeFileSync(`${repo}/docs/tickets.md`, `## 票\n\n### MFG-1 持票接线沙箱票\n\n- 验 dispatch-ticket 三环: node claim + ticket add + ticket lease\n- deliverable: 无(沙箱门内自净)\n\n`)
    const env = { ...process.env, HOME: sbHome, ORCA_CLI_COMMAND: join(SB, 'mock-orca') }
    const sbLedger = ['python3', `${m}/bin/ledger`]
    const reg = spawnSync(sbLedger[0], [...sbLedger.slice(1), 'project', repo, 'mf1-sb'], { encoding: 'utf8', env, timeout: 30_000 })
    ok('C 前置: 沙箱 project 登记 (node 环前置, 真实流程等价步)', reg.status === 0, (reg.stdout || reg.stderr || '').trim())

    const run = (args) => spawnSync('python3', [`${REPO}/bin/dispatch-ticket`, ...args], { encoding: 'utf8', env, timeout: 60_000 })
    const r1 = run(['MFG-1', '--repo', repo, '--terminal', 'term_gate', '--worker', 'g1'])
    ok('C 派发: send(mock)+三环落账 退出码 0', r1.status === 0, (r1.stderr || r1.stdout || '').slice(-160).replace(/\n/g, ' '))

    const db = new DatabaseSync(`${m}/ledger.db`, { readOnly: true })
    const t1 = db.prepare('SELECT * FROM tickets WHERE ticket_id=?').get('MFG-1')
    ok('C 环一/二: 票面建票 MFG-1 (state=dispatched, refs 带溯源)', !!t1 && t1.state === 'dispatched' && /term_gate/.test(t1.refs ?? ''), t1 ? `state=${t1.state}` : '(missing)')
    ok('C 环三: lease 挂执行席位 g1', !!t1 && t1.lease_owner === 'g1', `lease_owner=${t1?.lease_owner}`)
    const n1 = db.prepare('SELECT node_id, status FROM nodes WHERE node_id=?').get('MFG-1')
    ok('C 环零(node 账): MFG-1 node dispatched 在册', !!n1 && n1.status === 'dispatched')
    const evs = db.prepare("SELECT event_type, source FROM ticket_events WHERE ticket_id='MFG-1' ORDER BY id").all()
    ok('C 事件: added+lease 双事件留痕 (source=dispatch-ticket)', evs.some(e => e.event_type === 'added') && evs.some(e => e.event_type === 'lease' && e.source === 'dispatch-ticket'), evs.map(e => e.event_type).join(','))
    db.close()
    ok('C 契约头: mock 终端收到的 prompt 含 OF-003 两段式契约', /两段式/.test(readFileSync(mockOut, 'utf8')))

    const r2 = run(['MFG-1', '--repo', repo, '--terminal', 'term_gate', '--worker', 'g2'])
    const db2 = new DatabaseSync(`${m}/ledger.db`, { readOnly: true })
    const cnt = db2.prepare("SELECT COUNT(*) n FROM tickets WHERE ticket_id='MFG-1'").get().n
    const t2 = db2.prepare('SELECT lease_owner, state FROM tickets WHERE ticket_id=?').get('MFG-1')
    db2.close()
    ok('C 幂等: 重派不撞 "ticket exists" (list 预检跳过 add)', r2.status === 0, (r2.stderr || '').slice(-120).replace(/\n/g, ' '))
    ok('C 幂等: 票仍单张, lease 随执行席位迁移 g1→g2', cnt === 1 && t2.lease_owner === 'g2', `count=${cnt} lease_owner=${t2?.lease_owner}`)

    cpSync(`${m}/ledger.db`, `${BASE}/sandbox-ledger.db`)
    cpSync(mockOut, `${BASE}/sandbox-sent.txt`)
  } finally {
    rmSync(SB, { recursive: true, force: true })
  }
}

console.log(`\n=== ${LABEL}: PASS=${pass} FAIL=${fail} (evidence: ${BASE}) ===`)
process.exit(fail ? 1 : 0)
