#!/usr/bin/env node
/**
 * selftest.mjs — @maestro/host-callback-bridge 内置自测(node --test 风格,零外部依赖)。
 *
 * 覆盖 SI-003 验证目标(自动面,对应票 ①–⑤):
 *   T01 boot 零手动: activate 后 /callback 立即可用, cb-send 形状 POST → 200 accepted
 *   T02 文件事件驱动: fs.watch 触发投递, 稳态无轮询定时器(retryScheduled=false)
 *   T03 dead-letter 一致: malformed / unknown-addressee 措辞与 v3.5/v3.6 逐字一致
 *   T04 通道回归: HTTP 200/208/400 三态 + 文件兜底行(cb-send 两通道)
 *   T05 多消费者路由: @alias@sessionId 精确单播 / broadcast 每人一次
 *   T06 迁移窗护驻(standby): 旧桥持端口时待机, 不绑不盯零干扰
 *   T07 接管续投: legacy 消费者游标之后, 宿主路由从最大游标续(积压照常投递)
 *   T08 会话驻留唤醒: 目标会话回合空闲/进行中皆原生注入(session.prompt queue 模式)
 *   T09 轮转: 超 1MB 闸门 rename + 游标归零
 *   T10 换代注册: POST /register 新代际自注册(编排会话不再拥有链路)
 *   T11 回声分离: DSH-RE] 前缀行进 echo.log 不投递
 *   T12 投递失败退避: 目标不可达 ×maxWakeFailures → dead.log 留痕
 *
 * 用法: node selftest.mjs [--verbose]
 * 退出码: 0 = 全绿, 1 = 有失败。
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createServer } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import { activate, version } from './index.js'
import { readRegistry, registerConsumer } from './core/registry.js'

const VERBOSE = process.argv.includes('--verbose')
let passed = 0
let failed = 0
const failures = []

function ok(name, cond, detail = '') {
  if (cond) {
    passed += 1
    console.log(`[ ok ] ${name}`)
  } else {
    failed += 1
    failures.push(name + (detail ? ` — ${detail}` : ''))
    console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** 轻量断言辅助。 */
function assertEq(name, actual, expected) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  ok(name, a === b, a === b ? '' : `got ${a}, want ${b}`)
}

async function waitFor(condFn, { timeoutMs = 5000, stepMs = 25 } = {}) {
  const start = Date.now()
  for (;;) {
    if (condFn()) return true
    if (Date.now() - start > timeoutMs) return false
    await sleep(stepMs)
  }
}

/** 临时桥目录 fixture。 */
function makeBridgeDir() {
  const dir = mkdtempSync(join(tmpdir(), 'si003-bridge-'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'inbox.log'), '')
  return dir
}

/** mock 会话宿主: 记录 session.prompt 调用(可编程失败;runningSessions 内会话报在飞)。 */
function makeMockHost({ failFor = null, runningSessions = new Set() } = {}) {
  const calls = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const payload = JSON.parse(body)
      calls.push({ method: payload.method, sessionId: payload.payload?.sessionId, text: payload.payload?.content?.[0]?.text, rpcId: payload.rpcId })
      if (payload.method === 'session.list') {
        const items = [...runningSessions].map((sid) => ({ sessionId: sid, running: true }))
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ result: { ok: true, value: { items } } }))
        return
      }
      if (payload.method === 'session.cancel') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ result: { ok: true, value: {} } }))
        return
      }
      const shouldFail = failFor !== null && payload.payload?.sessionId === failFor
      const result = shouldFail
        ? { ok: false, error: { code: 'SESSION_NOT_FOUND', message: 'no such session' } }
        : { ok: true, value: { accepted: true } }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ result }))
    })
  })
  return { calls, runningSessions, server }
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()))
}

async function httpJson(port, method, path, body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let data = null
  try { data = await response.json() } catch {}
  return { status: response.status, data }
}

/** T01+T04+T05+T10 一体的主场景(共享一个 activate 实例)。 */
async function mainScene() {
  const bridgeDir = makeBridgeDir()
  const mockHost = makeMockHost()
  const apiPort = await listen(mockHost.server)
  let handle = null
  try {
    // T01: boot 零手动 —— activate 即绑定,无需任何会话内 arm 动作。
    handle = await activate({ bridgeDir, apiPort })
    ok('t01:activate-active-not-standby', handle.standby === false)
    const port = Number.parseInt(readFileSync(join(bridgeDir, 'http.port'), 'utf8').trim(), 10)
    ok('t01:http-port-written-at-boot', Number.isFinite(port) && port > 0)

    // 注册两个消费者(模拟新代际编排会话 + 驻留 worker)。
    const ORCH = 'session-c63b-orch'
    const WORKER = 'session-9a17-worker'
    let r = await httpJson(port, 'POST', '/register', { sessionId: ORCH, alias: 'orch1' })
    assertEq('t10:register-orch1-200', [r.status, r.data?.status, r.data?.consumer], [200, 'registered', 'orch1@' + ORCH])
    r = await httpJson(port, 'POST', '/register', { sessionId: WORKER, alias: 'dev1' })
    assertEq('t10:register-dev1-200', [r.status, r.data?.status], [200, 'registered'])
    const registry = await readRegistry(join(bridgeDir, 'registry.json'))
    assertEq('t10:registry-two-consumers', Object.keys(registry.consumers).sort(), [WORKER, ORCH].sort())

    // T01/T04: cb-send 契约 POST(ack 形状,显式 to)→ 200 accepted + 落 inbox。
    const ackBody = { type: 'ack', from: '841f', to: `orch1@${ORCH}`, body: '[ref:SI-003] turn started' }
    r = await httpJson(port, 'POST', '/callback', ackBody)
    assertEq('t04:http-callback-200-accepted', [r.status, r.data?.status], [200, 'accepted'])
    ok('t04:accepted-line-in-inbox', (await waitFor(() => readFileSync(join(bridgeDir, 'inbox.log'), 'utf8').includes('turn started'))))

    // T01: 目标会话原生唤醒(mock host 收到 session.prompt,文本为 ORCA-CB] 信封行)。
    ok('t01:target-session-woken', await waitFor(() => mockHost.calls.some((c) => c.sessionId === ORCH && c.text?.startsWith('ORCA-CB] {"type":"ack"'))))

    // T04: 208 幂等重放(同 (from,body) 60s 窗口内)。
    r = await httpJson(port, 'POST', '/callback', ackBody)
    assertEq('t04:http-callback-208-dedup', [r.status, r.data?.status, r.data?.deduplicated], [208, 'already-delivered', true])

    // T04: 400 校验失败(坏 type)。
    r = await httpJson(port, 'POST', '/callback', { type: 'bogus', from: 'x', to: `orch1@${ORCH}`, body: 'hi' })
    assertEq('t04:http-callback-400-validation', [r.status, r.data?.error], [400, 'validation failed'])

    // T04: 缺省 to + 双在册 → 400 歧义(HTTP-R1 宿主化)。
    r = await httpJson(port, 'POST', '/callback', { type: 'ping', from: 'x', body: 'hi' })
    assertEq('t04:http-callback-400-ambiguous', [r.status, r.data?.error?.slice(0, 9)], [400, 'ambiguous'])

    // T04: 文件兜底行(cb-send 降级通道)→ 同样被消费面投递。
    const before = mockHost.calls.length
    appendFileSync(join(bridgeDir, 'inbox.log'), JSON.stringify({ type: 'done', from: 'w1', to: `dev1@${WORKER}`, body: '[ref:LK-9] PASS' }) + '\n')
    ok('t04:file-fallback-delivered', await waitFor(() => mockHost.calls.some((c) => c.sessionId === WORKER && c.text?.includes('LK-9'))))

    // T05: 多消费者路由 —— 精确单播。
    const orchCalls = mockHost.calls.filter((c) => c.sessionId === ORCH).length
    appendFileSync(join(bridgeDir, 'inbox.log'), JSON.stringify({ type: 'ask', from: 'w2', to: `orch1@${ORCH}`, body: 'blocked' }) + '\n')
    ok('t05:qualified-unicast', await waitFor(() => mockHost.calls.filter((c) => c.sessionId === ORCH).length === orchCalls + 1))
    ok('t05:unicast-no-cross-talk', !mockHost.calls.some((c) => c.sessionId === WORKER && c.text?.includes('blocked')))

    // T05: 广播每人一次。
    const orchN = mockHost.calls.filter((c) => c.sessionId === ORCH).length
    const workerN = mockHost.calls.filter((c) => c.sessionId === WORKER).length
    appendFileSync(join(bridgeDir, 'inbox.log'), JSON.stringify({ type: 'status', from: 'sys', to: '*', body: 'host restarted' }) + '\n')
    ok('t05:broadcast-each-once', await waitFor(() =>
      mockHost.calls.filter((c) => c.sessionId === ORCH).length === orchN + 1
      && mockHost.calls.filter((c) => c.sessionId === WORKER).length === workerN + 1))

    // T02: fs.watch 事件驱动,稳态无重试定时器挂起。
    const routerStatus = handle.status().router
    ok('t02:file-router-watching', routerStatus.watching === true)
    ok('t02:no-pending-retry-timer', routerStatus.retryScheduled === false)
    // 稳态投递链上无周期性定时器: process._getActiveHandles 里不应有未被 unref 的 Timeout 归属本链
    // (retryTimer 建立即 unref;此处断言 flush 静默 + 无 pending)。
    ok('t02:steady-state-no-pending', routerStatus.pending === null)

    // T03: dead-letter 措辞与 v3.5/v3.6 逐字一致。
    appendFileSync(join(bridgeDir, 'inbox.log'), 'this is not json\n')
    appendFileSync(join(bridgeDir, 'inbox.log'), JSON.stringify({ type: 'ping', from: 'x', to: 'orch1@session-ghost', body: 'ghost' }) + '\n')
    ok('t03:malformed-dead', await waitFor(() => existsSync(join(bridgeDir, 'dead.log')) && readFileSync(join(bridgeDir, 'dead.log'), 'utf8').includes('malformed: line is not valid JSON')))
    ok('t03:unknown-addressee-dead', await waitFor(() => {
      if (!existsSync(join(bridgeDir, 'dead.log'))) return false
      const txt = readFileSync(join(bridgeDir, 'dead.log'), 'utf8')
      return txt.includes('unknown-addressee: no registered consumer with sessionId session-ghost')
    }))

    // T11: 回声分离。
    appendFileSync(join(bridgeDir, 'inbox.log'), 'DSH-RE] {"pong":true}\n')
    ok('t11:echo-separated', await waitFor(() => existsSync(join(bridgeDir, 'echo.log')) && readFileSync(join(bridgeDir, 'echo.log'), 'utf8').includes('DSH-RE]')))
    ok('t11:echo-not-delivered', !mockHost.calls.some((c) => c.text?.includes('pong')))

    // T08: 会话进行中(非 idle)也原生注入 —— queue 模式天然串行,这里断言重复投递同一会话逐条到达。
    const seq = []
    for (let i = 0; i < 3; i += 1) {
      appendFileSync(join(bridgeDir, 'inbox.log'), JSON.stringify({ type: 'report', from: 'seq', to: `orch1@${ORCH}`, body: 'seq-' + i }) + '\n')
      seq.push('seq-' + i)
    }
    ok('t08:queued-delivery-all-arrive', await waitFor(() => seq.every((s) => mockHost.calls.some((c) => c.text?.includes(s)))))

    // T13: 目标在飞 → 先 session.cancel 再 session.prompt(steer-cancel 时效语义)。
    mockHost.runningSessions.add(ORCH)
    appendFileSync(join(bridgeDir, 'inbox.log'), JSON.stringify({ type: 'report', from: 'cx', to: `orch1@${ORCH}`, body: 'cancel-me' }) + '\n')
    ok('t13:busy-target-cancel-then-prompt', await waitFor(() =>
      mockHost.calls.some((c) => c.method === 'session.cancel' && c.sessionId === ORCH)
      && mockHost.calls.some((c) => c.method === 'session.prompt' && c.text?.includes('cancel-me'))))
    const cancelIdx = mockHost.calls.findIndex((c) => c.method === 'session.cancel' && c.sessionId === ORCH)
    const promptIdx = mockHost.calls.findIndex((c) => c.method === 'session.prompt' && c.text?.includes('cancel-me'))
    ok('t13:cancel-precedes-prompt', cancelIdx >= 0 && promptIdx > cancelIdx)
    mockHost.runningSessions.delete(ORCH)

    // 观测面冒烟。
    r = await httpJson(port, 'GET', '/status', undefined)
    assertEq('obs:status-endpoint', [r.status, r.data?.version], [200, version])
    assertEq('obs:status-consumers', r.data?.registeredConsumers?.length, 2)

    handle.stop()
    handle = null
  } finally {
    if (handle !== null) handle.stop()
    await close(mockHost.server)
    rmSync(bridgeDir, { recursive: true, force: true })
  }
}

/** T06: 迁移窗护驻。 */
async function standbyScene() {
  const bridgeDir = makeBridgeDir()
  // 旧桥占位: 真实监听一个端口并写入 http.port。
  const legacy = createServer((req, res) => { res.writeHead(200); res.end('legacy lane\n') })
  const legacyPort = await listen(legacy)
  writeFileSync(join(bridgeDir, 'http.port'), String(legacyPort) + '\n')
  let handle = null
  try {
    handle = await activate({ bridgeDir, apiPort: 39999 })
    ok('t06:standby-when-legacy-holds-port', handle.standby === true)
    const s = handle.status()
    assertEq('t06:standby-status-shape', [s.plugin, s.standby, s.recordedPort], ['@maestro/host-callback-bridge', true, legacyPort])
    // 待机期间不抢 inbox: 写一行不被消费(无投递面)。
    appendFileSync(join(bridgeDir, 'inbox.log'), JSON.stringify({ type: 'ping', from: 'x', to: 'a@session-x', body: 'q' }) + '\n')
    await sleep(300)
    ok('t06:standby-does-not-touch-inbox', readFileSync(join(bridgeDir, 'inbox.log'), 'utf8').includes('session-x'))
    ok('t06:standby-no-dead-no-echo', !existsSync(join(bridgeDir, 'dead.log')) && !existsSync(join(bridgeDir, 'echo.log')))
    handle.stop()
    handle = null
  } finally {
    if (handle !== null) handle.stop()
    await close(legacy)
    rmSync(bridgeDir, { recursive: true, force: true })
  }
}

/** T07: 接管续投(legacy 游标无缝衔接)。 */
async function takeoverScene() {
  const bridgeDir = makeBridgeDir()
  const mockHost = makeMockHost()
  const apiPort = await listen(mockHost.server)
  // legacy 泵已消费 2 行(消费者游标=2), 之后又积压 2 行(host 重启事故现场)。
  const lines = [
    JSON.stringify({ type: 'ping', from: 'old', to: 'orch1@session-legacy-consumed', body: 'c1' }),
    JSON.stringify({ type: 'ping', from: 'old', to: 'orch1@session-legacy-consumed', body: 'c2' }),
    JSON.stringify({ type: 'ack', from: 'w', to: 'orch1@session-takeover', body: 'backlog-1' }),
    JSON.stringify({ type: 'done', from: 'w', to: 'orch1@session-takeover', body: 'backlog-2' }),
  ].join('\n') + '\n'
  writeFileSync(join(bridgeDir, 'inbox.log'), lines)
  await registerConsumer(join(bridgeDir, 'registry.json'), '3.6.0', { sessionId: 'session-takeover', alias: 'orch1' }, { armedAt: new Date().toISOString(), pid: 1 })
  writeFileSync(join(bridgeDir, '.cursor.session-legacy-consumed'), '2')
  let handle = null
  try {
    handle = await activate({ bridgeDir, apiPort })
    // 接管游标=2 → 只投积压的 backlog-1/2, 不重放已消费 c1/c2。
    ok('t07:takeover-resumes-at-legacy-cursor', await waitFor(() =>
      mockHost.calls.some((c) => c.text?.includes('backlog-1')) && mockHost.calls.some((c) => c.text?.includes('backlog-2'))))
    await sleep(200)
    ok('t07:no-replay-of-consumed-lines', !mockHost.calls.some((c) => c.text?.includes('legacy-consumed')))
    handle.stop()
    handle = null
  } finally {
    if (handle !== null) handle.stop()
    await close(mockHost.server)
    rmSync(bridgeDir, { recursive: true, force: true })
  }
}

/** T12: 投递失败退避×maxWakeFailures → dead.log。 */
async function wakeFailureScene() {
  const bridgeDir = makeBridgeDir()
  const mockHost = makeMockHost({ failFor: 'session-dead' })
  const apiPort = await listen(mockHost.server)
  await registerConsumer(join(bridgeDir, 'registry.json'), '1.0.0', { sessionId: 'session-dead', alias: 'x' }, { armedAt: new Date().toISOString(), pid: 1 })
  let handle = null
  try {
    handle = await activate({ bridgeDir, apiPort, retryDelayMs: 60, maxWakeFailures: 3 })
    appendFileSync(join(bridgeDir, 'inbox.log'), JSON.stringify({ type: 'done', from: 'w', to: 'x@session-dead', body: 'will fail' }) + '\n')
    ok('t12:wake-failure-dead-letters', await waitFor(() =>
      existsSync(join(bridgeDir, 'dead.log')) && readFileSync(join(bridgeDir, 'dead.log'), 'utf8').includes('wake failed 3 consecutive attempts'), { timeoutMs: 8000 }))
    handle.stop()
    handle = null
  } finally {
    if (handle !== null) handle.stop()
    await close(mockHost.server)
    rmSync(bridgeDir, { recursive: true, force: true })
  }
}

/** T09: 轮转闸门。 */
async function rotationScene() {
  const bridgeDir = makeBridgeDir()
  const mockHost = makeMockHost()
  const apiPort = await listen(mockHost.server)
  await registerConsumer(join(bridgeDir, 'registry.json'), '1.0.0', { sessionId: 'session-rot', alias: 'r' }, { armedAt: new Date().toISOString(), pid: 1 })
  let handle = null
  try {
    // rotateMaxLines=5: 追加 6 行 → 第 6 行消费完后轮转。
    handle = await activate({ bridgeDir, apiPort, rotateMaxLines: 5 })
    for (let i = 0; i < 6; i += 1) {
      appendFileSync(join(bridgeDir, 'inbox.log'), JSON.stringify({ type: 'ping', from: 'rot', to: 'r@session-rot', body: 'rot-' + i }) + '\n')
      await sleep(40)
    }
    ok('t09:rotation-renamed', await waitFor(() => existsSync(join(bridgeDir, 'inbox.log.1'))))
    ok('t09:all-lines-delivered', await waitFor(() => {
      const got = mockHost.calls.filter((c) => c.text?.includes('rot-')).length
      return got === 6
    }))
    const st = handle.status().router
    ok('t09:cursor-reset-after-rotation', st.cursor === 0, 'cursor=' + st.cursor)
    handle.stop()
    handle = null
  } finally {
    if (handle !== null) handle.stop()
    await close(mockHost.server)
    rmSync(bridgeDir, { recursive: true, force: true })
  }
}

async function main() {
  console.log(`host-callback-bridge selftest v${version}`)
  await mainScene()
  await standbyScene()
  await takeoverScene()
  await wakeFailureScene()
  await rotationScene()
  const total = passed + failed
  console.log(`\nhost-callback-bridge selftest: ${passed}/${total} passed`)
  if (failed > 0) {
    console.error('failures:\n' + failures.map((f) => '  - ' + f).join('\n'))
    process.exit(1)
  }
  process.exit(0)
}

main().catch((error) => {
  console.error('selftest crashed:', error)
  process.exit(1)
})
