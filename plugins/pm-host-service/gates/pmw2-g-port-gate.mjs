// PMW2-G port-pinning gate — PM_PORT env pins the listen port; occupied pinned
// port fails fast (non-zero exit + FATAL log); unset PM_PORT keeps the
// ephemeral random-port fallback (sandbox-gate compatibility); pm.port still
// written every boot with the actually-bound port + pid.
//
// A. 静态面: service.mjs PM_PORT 解析 + fail-fast handler; 模板与已安装 unit
//    均含 Environment=PM_PORT=35451; live pm.port 即 35451。
// B. 沙箱钉港: PM_PORT=<空闲> 连续两次 spawn -> pm.port 恒定 (两次同 port,
//    pid 更新), /health 200。
// C. 占港 fail-fast: 钉住已被占用的端口 -> 非零退出 + stderr/service.log 显式
//    FATAL(EADDRINUSE), 且绝不静默跳港 (pm.port 不被败者改写)。
// D. 无 PM_PORT 兜底: 未设 PM_PORT -> 随机端口照常 (pm.port.port > 0 且非钉住值)。
// E. live 双重启: try-restart ×2 -> 35451 两次不变, pid 更新, /health 200。
//
// Retention (HF-013 ②): ALL artifacts land under
//   $PM_HOST_SERVICE_GATES_DIR/pmw2-g/<label>/  (default
//   ~/.dsh/maestro/logs/pm-host-service/gates) — never /tmp.
// Usage: node pmw2-g-port-gate.mjs <label>    (label default: manual-<pid>)
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'

const LABEL = process.argv[2] ?? `manual-${process.pid}`
const GATES_ROOT = process.env.PM_HOST_SERVICE_GATES_DIR ?? `${homedir()}/.dsh/maestro/logs/pm-host-service/gates`
const BASE = `${GATES_ROOT}/pmw2-g/${LABEL}`
const REPO = new URL('..', import.meta.url).pathname // plugins/pm-host-service/
const UNIT = `${process.env.XDG_CONFIG_HOME ?? `${homedir()}/.config`}/systemd/user/pm-host-service.service`
const PINNED = 35451

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}${detail ? `  :: ${detail}` : ''}`) } else { fail++; console.log(`FAIL ${name}${detail ? `  :: ${detail}` : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- daemon lifecycle (pm001-007-gate pattern) ----------
function daemonEnv(sb, extra = {}) {
  const env = { ...process.env }
  delete env.PM_PORT // 沙箱一律显式决定端口面: 默认裸兜底, 钉港走 extra
  return {
    ...env,
    MAESTRO_HOME: sb,
    PM_HOST_SERVICE_LEDGER: `${sb}/maestro/bin/ledger`,
    PM_HOST_SERVICE_FLOWC: `${sb}/maestro/bin/flowc`,
    PM_HOST_SERVICE_FLEET_LIST: `${sb}/maestro/bin/fleet-list`,
    PM_HOST_SERVICE_TICKETS_MD: `${sb}/maestro/tickets.md`,
    MAESTRO_FLEET: `${sb}/maestro/fleet.json`,
    MAESTRO_FLOWS_ROOT: `${sb}/maestro/flows`,
    DSH_SESSIONS_ROOT: `${sb}/sessions`,
    ...extra,
  }
}
function buildSandbox(sb) {
  rmSync(sb, { recursive: true, force: true })
  mkdirSync(`${sb}/maestro/bin`, { recursive: true })
  mkdirSync(`${sb}/maestro/bridge`, { recursive: true })
  writeFileSync(`${sb}/maestro/bridge/inbox.log`, '') // 隔离 bridge 源噪声
}
async function freePort() {
  const s = createServer()
  await new Promise((r) => s.listen(0, '127.0.0.1', r))
  const p = s.address().port
  await new Promise((r) => s.close(r))
  return p
}
async function startDaemon(sb, extraEnv = {}, expectedPort = 0) {
  const child = spawn(process.execPath, [`${REPO}/service.mjs`], { env: daemonEnv(sb, extraEnv), stdio: 'ignore' })
  for (let i = 0; i < 100; i++) {
    try {
      const p = JSON.parse(readFileSync(`${sb}/maestro/pm.port`, 'utf8'))
      if (p.pid === child.pid && p.port > 0 && (!expectedPort || p.port === expectedPort)) return { child, port: p.port }
    } catch {}
    await sleep(100)
  }
  throw new Error(`daemon in ${sb} never published pm.port`)
}
const stopDaemon = (child) => new Promise((resolve) => {
  if (!child || child.exitCode != null || child.signalCode != null) return resolve()
  child.once('exit', resolve); try { child.kill('SIGTERM') } catch { resolve() }
})
const waitExit = (child, ms = 8000) => new Promise((resolve) => { const t = setTimeout(() => resolve('timeout'), ms); child.once('exit', (c) => { clearTimeout(t); resolve(c) }) })

// ============ A. 静态面 ============
async function partA() {
  const src = readFileSync(`${REPO}/service.mjs`, 'utf8')
  ok('A1 service.mjs 解析 PM_PORT 环境变量', src.includes('Number(process.env.PM_PORT)'))
  ok('A2 listen 使用 PM_PORT (0 兜底=随机)', src.includes('server.listen(PM_PORT,'))
  ok('A3 fail-fast handler: FATAL 日志 + stderr + exit(1)', /server\.on\('error'[\s\S]{0,400}FATAL[\s\S]{0,400}console\.error\(fatal\)[\s\S]{0,200}process\.exit\(1\)/.test(src))
  const tpl = readFileSync(`${REPO}/pm-host-service.service.template`, 'utf8')
  ok('A4 模板含 Environment=PM_PORT=35451', tpl.includes('Environment=PM_PORT=35451'))
  const unit = readFileSync(UNIT, 'utf8')
  ok('A5 已安装 unit 含 Environment=PM_PORT=35451', unit.includes('Environment=PM_PORT=35451'))
  const live = JSON.parse(readFileSync(`${homedir()}/.dsh/maestro/pm.port`, 'utf8'))
  ok('A6 live pm.port 钉在 35451', live.port === PINNED, `port=${live.port} pid=${live.pid}`)
}

// ============ B. 沙箱钉港两次恒定 ============
async function partB() {
  const sb = `${BASE}/sb-pinned`
  buildSandbox(sb)
  const port1 = await freePort()
  const { child: c1, port: b1 } = await startDaemon(sb, { PM_PORT: String(port1) }, port1)
  try {
    const pf1 = JSON.parse(readFileSync(`${sb}/maestro/pm.port`, 'utf8'))
    ok('B1 钉港 spawn #1 -> pm.port = 指定端口', b1 === port1 && pf1.port === port1 && pf1.pid === c1.pid, `port=${b1}`)
    const h = await fetch(`http://127.0.0.1:${b1}/health`)
    ok('B2 钉港 /health 200', h.status === 200)
  } finally { await stopDaemon(c1) }
  const { child: c2, port: b2 } = await startDaemon(sb, { PM_PORT: String(port1) }, port1)
  try {
    const pf2 = JSON.parse(readFileSync(`${sb}/maestro/pm.port`, 'utf8'))
    ok('B3 重启后端口恒定(不再漂移), pid 更新', b2 === port1 && pf2.port === port1 && pf2.pid === c2.pid && c2.pid !== c1.pid, `port=${b1}->${b2} pid=${c1.pid}->${c2.pid}`)
  } finally { await stopDaemon(c2) }
}

// ============ C. 占港 fail-fast ============
async function partC() {
  const sb = `${BASE}/sb-occupied`
  buildSandbox(sb)
  const occupied = await freePort()
  const squatter = createServer()
  await new Promise((r) => squatter.listen(occupied, '127.0.0.1', r))
  try {
    const child = spawn(process.execPath, [`${REPO}/service.mjs`], { env: daemonEnv(sb, { PM_PORT: String(occupied) }), stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (d) => { stderr += d })
    const rc = await waitExit(child, 10_000)
    ok('C1 占港启动非零退出(不挂起不跳港)', rc !== 'timeout' && rc !== 0, `rc=${rc}`)
    ok('C2 stderr 显式 FATAL(EADDRINUSE)', stderr.includes('FATAL') && /EADDRINUSE/.test(stderr), stderr.trim().slice(0, 120))
    let fileFatal = ''
    try { fileFatal = readFileSync(`${sb}/maestro/logs/pm-host-service/daemon.log`, 'utf8') } catch {}
    ok('C3 daemon.log 落 FATAL 行', fileFatal.includes('FATAL') && fileFatal.includes('EADDRINUSE'))
    let pf = null
    try { pf = JSON.parse(readFileSync(`${sb}/maestro/pm.port`, 'utf8')) } catch {}
    ok('C4 败者不改写 pm.port (无静默换港痕迹)', !pf || pf.pid !== child.pid, pf ? `pid=${pf.pid} loser=${child.pid}` : 'pm.port absent')
  } finally { squatter.close() }
}

// ============ D. 无 PM_PORT 兜底 ============
async function partD() {
  const sb = `${BASE}/sb-ephemeral`
  buildSandbox(sb)
  const { child, port } = await startDaemon(sb)
  try {
    const pf = JSON.parse(readFileSync(`${sb}/maestro/pm.port`, 'utf8'))
    ok('D1 未设 PM_PORT -> 随机端口照常发布', port > 0 && port !== PINNED && pf.pid === child.pid, `port=${port}`)
  } finally { await stopDaemon(child) }
}

// ============ E. live 双重启恒定 ============
async function partE() {
  const pf0 = JSON.parse(readFileSync(`${homedir()}/.dsh/maestro/pm.port`, 'utf8'))
  let pid = pf0.pid
  let ports = []
  for (let i = 0; i < 2; i++) {
    spawnSync('systemctl', ['--user', 'try-restart', 'pm-host-service'])
    let snap = null
    for (let k = 0; k < 80; k++) {
      await sleep(250)
      try { const p = JSON.parse(readFileSync(`${homedir()}/.dsh/maestro/pm.port`, 'utf8')); if (p.pid !== pid) { snap = p; break } } catch {}
    }
    if (!snap) { ports.push(0); break }
    ports.push(snap.port)
    pid = snap.pid
  }
  ok('E1 live try-restart ×2 -> 35451 两次恒定 + pid 更新', ports.length === 2 && ports.every((p) => p === PINNED), `ports=${ports.join('->')} pid->${pid}`)
  const h = await fetch(`http://127.0.0.1:${PINNED}/health`)
  ok('E2 钉港 /health 200', h.status === 200)
}

mkdirSync(BASE, { recursive: true })
const startedAt = new Date().toISOString()
await partA()
await partB()
await partC()
await partD()
await partE()
writeFileSync(`${BASE}/manifest.json`, `${JSON.stringify({ label: LABEL, gate: 'pmw2-g-port', startedAt, finishedAt: new Date().toISOString(), pass, fail, pinned: PINNED, node: process.version, repo: REPO }, null, 2)}\n`)
console.log(`\n=== ${LABEL}: PASS=${pass} FAIL=${fail} (evidence: ${BASE}) ===`)
process.exit(fail === 0 ? 0 : 1)
