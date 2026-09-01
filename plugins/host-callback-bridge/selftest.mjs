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
import { spawnSync } from 'node:child_process'
import { activate, resolveFileDelivery, version } from './index.js'
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
      && mockHost.calls.some((c) => c.method === 'session.prompt' && c.text?.includes('cancel-me')), { timeoutMs: 8000 }))
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

/** IDX-4: G1-G3, G5-G12 — ADDR-R1 收紧 + alias-epoch 代际(spec §1/§2)。 */
async function epochScene() {
  const bridgeDir = makeBridgeDir()
  const mockHost = makeMockHost()
  const apiPort = await listen(mockHost.server)
  const inboxPath = join(bridgeDir, 'inbox.log')
  const deadPath = join(bridgeDir, 'dead.log')
  const inboxLines = () => readFileSync(inboxPath, 'utf8').split('\n').filter((l) => l.length > 0)
  const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
  let handle = null
  try {
    handle = await activate({ bridgeDir, apiPort, staleRetentionMs: 150 })
    const port = Number.parseInt(readFileSync(join(bridgeDir, 'http.port'), 'utf8').trim(), 10)

    // G2a: 缺省 to + 0 在册 → 503。
    let r = await httpJson(port, 'POST', '/callback', { type: 'ping', from: 'g2', body: 'zero' })
    assertEq('g2:default-to-zero-503', r.status, 503)

    // R1: 首个持有人 ga@sidX → epoch 1。
    const SIDX = 'session-g1-sidx', SIDY = 'session-g1-sidy', SID2 = 'session-g1-sid2', SID3 = 'session-g1-sid3', SID4 = 'session-g1-sid4'
    r = await httpJson(port, 'POST', '/register', { sessionId: SIDX, alias: 'ga' })
    assertEq('g4:first-holder-epoch-1', [r.status, r.data?.epoch, r.data?.superseded, r.data?.signature], [200, 1, null, `ga@${SIDX}`])

    // G2b: 缺省 to + 恰好 1 活槽 → 200 补全即投。
    r = await httpJson(port, 'POST', '/callback', { type: 'ping', from: 'g2', body: 'unique' })
    assertEq('g2:default-to-unique-200', [r.status, r.data?.status, r.data?.to], [200, 'accepted', `ga@${SIDX}`])

    // G11(部分): 信封键集恒 {type,from,to,body,ref?,msgid?,ver?}——无 epoch。
    const envLine = inboxLines().at(-1)
    const envKeys = Object.keys(JSON.parse(envLine)).sort()
    ok('g11:envelope-keys-epoch-free', envKeys.every((k) => ['type', 'from', 'to', 'body', 'ref', 'msgid', 'ver'].includes(k)) && !envKeys.includes('epoch'), envKeys.join(','))
    // G11: ver 2/3 透传照旧。
    r = await httpJson(port, 'POST', '/callback', { type: 'ping', from: 'g11', to: `ga@${SIDX}`, body: 'ver-passthrough', ver: 3 })
    const verLine = inboxLines().at(-1)
    assertEq('g11:ver3-passthrough', [r.status, JSON.parse(verLine).ver], [200, 3])

    // R2: 第二别名 gb@sidY。
    await httpJson(port, 'POST', '/register', { sessionId: SIDY, alias: 'gb' })

    // G2c: 缺省 to + ≥2 → 400 ambiguous 附 canonical 名单。
    r = await httpJson(port, 'POST', '/callback', { type: 'ping', from: 'g2', body: 'multi' })
    assertEq('g2:default-to-multi-400-ambiguous', [r.status, r.data?.error?.slice(0, 9), r.data?.details?.length], [400, 'ambiguous', 2])

    // G1: 显式 to 幽灵(从未注册) → 400 ghost 分类; inbox 零写入。
    const inboxBefore = inboxLines().length
    r = await httpJson(port, 'POST', '/callback', { type: 'ack', from: 'g1', to: 'ga@session-never-registered', body: '[ref:G1] ghost' })
    assertEq('g1:http-400-ghost-classification', [r.status, r.data?.details?.classification, r.data?.details?.address], [400, 'ghost address', 'ga@session-never-registered'])
    ok('g1:canonical-hint-none-or-live', Array.isArray(r.data?.details?.canonicalHint) && r.data.details.canonicalHint.includes(`ga@${SIDX}`), JSON.stringify(r.data?.details?.canonicalHint))
    assertEq('g1:http-400-no-inbox-write', inboxLines().length, inboxBefore)
    // G1(file 面): 同消息走 inbox → dead.log 条目含 classification 且既有键形状不变。
    appendFileSync(inboxPath, JSON.stringify({ type: 'ack', from: 'g1', to: 'ga@session-never-registered', body: '[ref:G1f] ghost' }) + '\n')
    ok('g1:file-dead-classification-key', await waitFor(() => {
      if (!existsSync(deadPath)) return false
      const entries = readFileSync(deadPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      const hit = entries.find((e) => e.reason?.includes('session-never-registered') && e.line?.includes('G1f'))
      if (hit === undefined) return false
      const keys = Object.keys(hit).sort()
      return hit.classification === 'ghost address' && JSON.stringify(keys) === JSON.stringify(['at', 'classification', 'line', 'reason'])
    }, { timeoutMs: 8000 }))
    await waitFor(() => mockHost.calls.some((c) => c.text?.includes('ver-passthrough')))

    // G3: 双活槽 + ghost 显式 to → 双方投递零新增(任何面都不猜收件人)。
    const callsBefore = mockHost.calls.length
    const inboxG3 = inboxLines().length
    r = await httpJson(port, 'POST', '/callback', { type: 'ping', from: 'g3', to: 'ghost@session-g3-nowhere', body: 'g3' })
    assertEq('g3:ghost-400', r.status, 400)
    await sleep(250)
    assertEq('g3:no-inbox-growth', inboxLines().length, inboxG3)
    assertEq('g3:no-auto-redirection', mockHost.calls.length, callsBefore)

    // G12(IDX-4-reopen 定性修订): 去重契约=投递级最终判重——mark 在 file-router
    // 投递完成侧(P3b.2), HTTP 208 是投递后快路径(deliveredAt=投递时刻)。竞态重放
    // 得 200 合法, 重复行由消费侧 seen-skip 吸收; 确定性 208 须等投递信号(禁裸 sleep)。
    r = await httpJson(port, 'POST', '/callback', { type: 'done', from: 'old-client', to: `gb@${SIDY}`, body: '[ref:G12] done' })
    assertEq('g12:live-200', [r.status, r.data?.status], [200, 'accepted'])
    r = await httpJson(port, 'POST', '/callback', { type: 'done', from: 'old-client', to: `gb@${SIDY}`, body: '[ref:G12] done' })
    ok('g12:racing-replay-200-or-208-both-legal', r.status === 200 || r.status === 208, `status=${r.status}`)
    const g12Total = inboxLines().length
    ok('g12:router-consumed-all', await waitFor(() => handle.status().router.cursor >= g12Total, { timeoutMs: 8000 }))
    assertEq('g12:at-most-once-under-race', mockHost.calls.filter((c) => c.text?.includes('[ref:G12] done')).length, 1)
    r = await httpJson(port, 'POST', '/callback', { type: 'done', from: 'old-client', to: `gb@${SIDY}`, body: '[ref:G12b] done' })
    assertEq('g12:deterministic-path-live-200', r.status, 200)
    ok('g12:delivery-signal-before-replay', await waitFor(() => mockHost.calls.some((c) => c.text?.includes('[ref:G12b] done')), { timeoutMs: 8000 }))
    r = await httpJson(port, 'POST', '/callback', { type: 'done', from: 'old-client', to: `gb@${SIDY}`, body: '[ref:G12b] done' })
    assertEq('g12:deterministic-replay-208', [r.status, r.data?.status, typeof r.data?.deliveredAt], [208, 'already-delivered', 'string'])
    r = await httpJson(port, 'POST', '/callback', { type: 'done', from: 'old-client', to: 'gb@session-g12-ghost', body: '[ref:G12] x' })
    ok('g12:ghost-400-error-readable', r.status === 400 && typeof r.data?.error === 'string' && r.data.error.startsWith('unknown-addressee'))
    appendFileSync(inboxPath, JSON.stringify({ type: 'done', from: 'old-client', to: 'gb@session-g12-ghost', body: '[ref:G12f]' }) + '\n')
    ok('g12:file-fallback-dead-letter', await waitFor(() => existsSync(deadPath) && readFileSync(deadPath, 'utf8').includes('G12f')))

    // G4: 换代 —— ga 由 sid2 再注册: epoch+1, 旧槽 stale, 回执带 superseded。
    r = await httpJson(port, 'POST', '/register', { sessionId: SID2, alias: 'ga' })
    assertEq('g4:bump-receipt', [r.status, r.data?.epoch, r.data?.signature, r.data?.superseded?.sessionId, r.data?.superseded?.epoch], [200, 2, `ga@${SID2}`, SIDX, 1])
    let disk = readJson(join(bridgeDir, 'registry.json'))
    assertEq('g4:aliases-ledger-bumped', [disk.version, disk.aliases.ga.epoch, disk.aliases.ga.holder], ['5.0.0', 2, SID2])
    assertEq('g4:old-slot-staled', [disk.consumers[SIDX].stale?.supersededBy, disk.consumers[SIDX].stale?.epoch, disk.consumers[SIDX].epoch], [SID2, 1, 1])

    // G5: stale 寻址 → 400 stale 分类 + supersededBy; 不自动改投。
    const inboxG5 = inboxLines().length
    r = await httpJson(port, 'POST', '/callback', { type: 'ack', from: 'g5', to: `ga@${SIDX}`, body: '[ref:G5]' })
    assertEq('g5:http-400-stale', [r.status, r.data?.details?.classification, r.data?.details?.supersededBy, r.data?.details?.epoch], [400, 'stale address', `ga@${SID2}`, 2])
    assertEq('g5:no-inbox-write', inboxLines().length, inboxG5)
    appendFileSync(inboxPath, JSON.stringify({ type: 'ack', from: 'g5f', to: `ga@${SIDX}`, body: '[ref:G5f]' }) + '\n')
    ok('g5:file-dead-stale-classification', await waitFor(() => existsSync(deadPath) && readFileSync(deadPath, 'utf8').includes('"classification":"stale address"') && readFileSync(deadPath, 'utf8').includes('is a stale generation of alias ga'), { timeoutMs: 8000 }))

    // G6: 同 sid 重 arm = 续期不换代。
    const armedBefore = readJson(join(bridgeDir, 'registry.json')).consumers[SID2].armedAt
    await sleep(50)
    r = await httpJson(port, 'POST', '/register', { sessionId: SID2, alias: 'ga' })
    disk = readJson(join(bridgeDir, 'registry.json'))
    assertEq('g6:renewal-no-bump', [r.status, r.data?.epoch, r.data?.superseded], [200, 2, null])
    ok('g6:armedat-refreshed', disk.consumers[SID2].armedAt !== armedBefore)
    assertEq('g6:holder-unchanged', [disk.aliases.ga.epoch, disk.aliases.ga.holder], [2, SID2])

    // G7: 裸别名解析排除 stale —— ga 仅剩 sid2 活槽, 恢复唯一即投。
    const sid2Calls = mockHost.calls.filter((c) => c.sessionId === SID2).length
    const sidXStaledCalls = mockHost.calls.filter((c) => c.sessionId === SIDX).length // 含变 stale 前的合法投递(G2b/G11)
    appendFileSync(inboxPath, JSON.stringify({ type: 'report', from: 'g7', to: 'ga', body: 'bare-ga' }) + '\n')
    ok('g7:bare-alias-resolves-live-holder-only', await waitFor(() => mockHost.calls.filter((c) => c.sessionId === SID2 && c.text?.includes('bare-ga')).length === 1))
    assertEq('g7:stale-slot-not-woken', mockHost.calls.filter((c) => c.sessionId === SIDX).length, sidXStaledCalls)
    ok('g7:sid2-received', mockHost.calls.filter((c) => c.sessionId === SID2).length >= sid2Calls)

    // G10: 单调无 ABA —— 换主→无主→再换主, epoch 1,2,3 严格递增。
    r = await httpJson(port, 'POST', '/unregister', { sessionId: SID2 })
    assertEq('g10:unregister-200', r.status, 200)
    disk = readJson(join(bridgeDir, 'registry.json'))
    assertEq('g10:holder-null-epoch-kept', [disk.aliases.ga.epoch, disk.aliases.ga.holder], [2, null])
    ok('g10:clean-retire-no-stale-slot', disk.consumers[SID2] === undefined && disk.consumers[SIDX]?.stale?.supersededBy === SID2)
    r = await httpJson(port, 'POST', '/register', { sessionId: SID3, alias: 'ga' })
    assertEq('g10:reheld-epoch-3', [r.data?.epoch, r.data?.superseded], [3, null])
    disk = readJson(join(bridgeDir, 'registry.json'))
    assertEq('g10:strictly-increasing', [disk.consumers[SIDX].epoch, disk.aliases.ga.epoch, disk.consumers[SID3].epoch], [1, 3, 3])

    // G8: undertaker —— 换代剪更旧代; 超期 prune; 回落 ghost; 账本永不清。
    r = await httpJson(port, 'POST', '/register', { sessionId: SID4, alias: 'ga' })
    assertEq('g8:second-bump-epoch-4', [r.data?.epoch, r.data?.superseded?.sessionId], [4, SID3])
    disk = readJson(join(bridgeDir, 'registry.json'))
    ok('g8:older-stale-gen-pruned-at-bump', disk.consumers[SIDX] === undefined, 'sidX 应在 sid4 换代时被剪(只留最近一代 stale)')
    ok('g8:newest-stale-kept', disk.consumers[SID3]?.stale?.supersededBy === SID4)
    await sleep(250) // > staleRetentionMs(150ms)
    appendFileSync(inboxPath, JSON.stringify({ type: 'ping', from: 'g8', to: `gb@${SIDY}`, body: 'prune-trigger' }) + '\n')
    ok('g8:prune-trigger-delivered', await waitFor(() => mockHost.calls.some((c) => c.text?.includes('prune-trigger'))))
    await sleep(100)
    disk = readJson(join(bridgeDir, 'registry.json'))
    ok('g8:expired-stale-pruned', disk.consumers[SID3] === undefined, 'sid3 stale 超 150ms 应被 prune')
    assertEq('g8:aliases-ledger-never-cleared', [disk.aliases.ga.epoch, disk.aliases.ga.holder], [4, SID4])
    r = await httpJson(port, 'POST', '/callback', { type: 'ack', from: 'g8b', to: `ga@${SID3}`, body: '[ref:G8b]' })
    assertEq('g8:post-prune-falls-back-to-ghost', [r.status, r.data?.details?.classification, r.data?.details?.supersededBy], [400, 'ghost address', undefined])

    // G9: 观测面 —— /status epoch+aliases; state.json 计数 staleHits/epochBumps。
    r = await httpJson(port, 'GET', '/status', undefined)
    const consumers = r.data?.registeredConsumers ?? []
    ok('g9:status-consumers-carry-epoch', consumers.length >= 2 && consumers.every((c) => Number.isFinite(c.epoch)), JSON.stringify(consumers.map((c) => c.epoch)))
    assertEq('g9:status-aliases-node', r.data?.aliases?.ga?.epoch, 4)
    const state = readJson(join(bridgeDir, 'state.json'))
    ok('g9:state-epoch-bumps-counted', (state.hostBridge?.http?.counters?.epochBumps ?? 0) >= 2, `epochBumps=${state.hostBridge?.http?.counters?.epochBumps}`)
    ok('g9:state-stale-hits-counted', (state.hostBridge?.http?.counters?.staleHits ?? 0) >= 1 && (state.hostBridge?.counters?.staleHits ?? 0) >= 1, `http.staleHits=${state.hostBridge?.http?.counters?.staleHits} file.staleHits=${state.hostBridge?.counters?.staleHits}`)

    // G11(收尾): 全量 inbox 行键集守恒(无 epoch 键)。
    const allKeys = new Set(inboxLines().flatMap((l) => Object.keys(JSON.parse(l))))
    ok('g11:all-envelope-lines-epoch-free', [...allKeys].every((k) => ['type', 'from', 'to', 'body', 'ref', 'msgid', 'ver'].includes(k)), [...allKeys].join(','))

    handle.stop()
    handle = null
  } finally {
    if (handle !== null) handle.stop()
    await close(mockHost.server)
    rmSync(bridgeDir, { recursive: true, force: true })
  }
}

/** IDX-4: G13 — v4 registry 懒迁移(spec §3.3)。 */
async function migrationScene() {
  const bridgeDir = makeBridgeDir()
  const mockHost = makeMockHost()
  const apiPort = await listen(mockHost.server)
  const S1 = 'session-v4-a', S2 = 'session-v4-b'
  writeFileSync(join(bridgeDir, 'registry.json'), JSON.stringify({
    version: '4.1.0',
    consumers: {
      [S1]: { alias: 'm', pid: 1, armedAt: '2026-08-30T00:00:00Z' },
      [S2]: { alias: 'm', pid: 2, armedAt: '2026-08-30T00:00:00Z' },
    },
  }, null, 2) + '\n')
  let handle = null
  try {
    handle = await activate({ bridgeDir, apiPort })
    const port = Number.parseInt(readFileSync(join(bridgeDir, 'http.port'), 'utf8').trim(), 10)
    // 两槽 qualified 皆活(迁移不判死)。
    for (const [sid, tag] of [[S1, 'mig-a'], [S2, 'mig-b']]) {
      const r = await httpJson(port, 'POST', '/callback', { type: 'ping', from: 'g13', to: `m@${sid}`, body: tag })
      assertEq(`g13:qualified-live-after-migration(${tag})`, r.status, 200)
      ok(`g13:delivered(${tag})`, await waitFor(() => mockHost.calls.some((c) => c.sessionId === sid && c.text?.includes(tag))))
    }
    // 裸别名 m 歧义死信(v4 双槽 → holder:null)。
    appendFileSync(join(bridgeDir, 'inbox.log'), JSON.stringify({ type: 'ping', from: 'g13', to: 'm', body: 'mig-bare' }) + '\n')
    ok('g13:bare-alias-ambiguous-dead', await waitFor(() => existsSync(join(bridgeDir, 'dead.log')) && readFileSync(join(bridgeDir, 'dead.log'), 'utf8').includes('is ambiguous across 2'), { timeoutMs: 8000 }))
    // 任一 /register → 落盘 v5 + 存量槽回填 epoch:0。
    const r = await httpJson(port, 'POST', '/register', { sessionId: 'session-v4-new', alias: 'other' })
    assertEq('g13:register-200', r.status, 200)
    const disk = JSON.parse(readFileSync(join(bridgeDir, 'registry.json'), 'utf8'))
    assertEq('g13:disk-v5', disk.version, '5.0.0')
    assertEq('g13:legacy-slots-backfilled-epoch-0', [disk.consumers[S1].epoch, disk.consumers[S2].epoch], [0, 0])
    assertEq('g13:aliases-derived', [disk.aliases.m.epoch, disk.aliases.m.holder, disk.aliases.other.epoch, disk.aliases.other.holder], [0, null, 1, 'session-v4-new'])
    handle.stop()
    handle = null
  } finally {
    if (handle !== null) handle.stop()
    await close(mockHost.server)
    rmSync(bridgeDir, { recursive: true, force: true })
  }
}

/**
 * IDX-5: 无人值守回调韧性 —— X1 ceded 让渡面 / X2 fileDelivery 解析优先级 /
 * X3 死信二分类(ghost-noise vs true-ghost vs wake-noise) / X4 计数分立落盘。
 */
async function idx5Scene() {
  // X2: resolveFileDelivery 解析(纯函数, 先行零环境)。
  {
    const prev = process.env.MAESTRO_BRIDGE_FILE_DELIVERY
    assertEq('x2:default-sole', resolveFileDelivery(null), 'sole')
    assertEq('x2:option-ceded', resolveFileDelivery('ceded'), 'ceded')
    assertEq('x2:option-sole', resolveFileDelivery('sole'), 'sole')
    assertEq('x2:garbage-falls-back-sole', resolveFileDelivery('  NONSENSE '), 'sole')
    process.env.MAESTRO_BRIDGE_FILE_DELIVERY = 'ceded'
    assertEq('x2:env-ceded', resolveFileDelivery(null), 'ceded')
    assertEq('x2:option-beats-env', resolveFileDelivery('sole'), 'sole')
    if (prev === undefined) delete process.env.MAESTRO_BRIDGE_FILE_DELIVERY
    else process.env.MAESTRO_BRIDGE_FILE_DELIVERY = prev
    ok('x2:env-restored', process.env.MAESTRO_BRIDGE_FILE_DELIVERY === prev)
  }

  // X1: ceded 模式 —— file-router 不启动(零 flush 零游标零投递),HTTP 受理面照常
  // 受理入账;每行恰一个消费者(宿主原生 watcher)由环境侧保证。
  {
    const bridgeDir = makeBridgeDir()
    const mockHost = makeMockHost()
    const apiPort = await listen(mockHost.server)
    let handle = null
    try {
      handle = await activate({ bridgeDir, apiPort, fileDelivery: 'ceded' })
      assertEq('x1:status-reports-ceded', handle.status().fileDelivery, 'ceded')
      assertEq('x1:router-not-watching', handle.status().router.watching, false)
      const port = Number.parseInt(readFileSync(join(bridgeDir, 'http.port'), 'utf8').trim(), 10)
      const r = await httpJson(port, 'POST', '/register', { sessionId: 'session-x1', alias: 'x1' })
      assertEq('x1:register-ok', r.status, 200)
      const callsBefore = mockHost.calls.length
      const r2 = await httpJson(port, 'POST', '/callback', { type: 'ping', from: 'x1', to: 'x1@session-x1', body: 'ceded-line' })
      assertEq('x1:intake-accepts-200', r2.status, 200)
      await sleep(600) // 给假想中的 polyfill 消费面充分时间;ceded 面必须零投递
      assertEq('x1:zero-polyfill-delivery', mockHost.calls.length, callsBefore)
      ok('x1:inbox-line-kept-for-native-watcher', readFileSync(join(bridgeDir, 'inbox.log'), 'utf8').includes('ceded-line'))
      ok('x1:no-host-cursor-written', !existsSync(join(bridgeDir, '.cursor.host-bridge')))
      handle.stop()
      handle = null
    } finally {
      if (handle !== null) handle.stop()
      await close(mockHost.server)
      rmSync(bridgeDir, { recursive: true, force: true })
    }
  }

  // X3+X4: 死信二分类与计数分立(sole 模式,专用桥)。三个死信面:
  //   a) ghost + 原生游标越行  → deadClass=noise-parallel-delivered(五键)
  //   b) ghost + 无原生游标    → 真幽灵,既有四键形状逐字不变
  //   c) wake-failed + 原生游标越行 → deadClass(noise), 四键 {at,deadClass,reason,line}
  {
    const bridgeDir = makeBridgeDir()
    const mockHost = makeMockHost({ failFor: 'session-wake2' })
    const apiPort = await listen(mockHost.server)
    let handle = null
    try {
      handle = await activate({ bridgeDir, apiPort, retryDelayMs: 10, maxWakeFailures: 2, adaptiveDeferMs: 10 })
      // 原生 watcher rendition: 目标会话已 arm(留下游标)但已不在 registry(ghost 寻址)。
      writeFileSync(join(bridgeDir, '.cursor.session-noise'), '5')
      // A-fix 契约变更: session-wake 游标预置越行 = 原生道已投实证 → 路由器 adaptiveYield
      // 直接跳过,不再打必败唤醒、不再产噪声死信(旧行为: 3 败→noise 死信,已让位)。
      // "游标在失败间隙越行"的噪声死信只剩窄竞态可达,断言面改为: 零死信+adaptiveSkip+行推进。
      // 真幽灵 wake 面由 session-wake2(游标存在但未越行)保留旧四键形状断言。
      writeFileSync(join(bridgeDir, '.cursor.session-wake'), '5')
      writeFileSync(join(bridgeDir, '.cursor.session-wake2'), '0')
      // c) 面: wake/wake2 在册(活槽);sink failFor=session-wake 双双必败 → wake2 走 wake-failed 终态。
      const portX3 = Number.parseInt(readFileSync(join(bridgeDir, 'http.port'), 'utf8').trim(), 10)
      const regX3 = await httpJson(portX3, 'POST', '/register', { sessionId: 'session-wake', alias: 'wk' })
      assertEq('x3:wake-target-registered', regX3.status, 200)
      const regX3b = await httpJson(portX3, 'POST', '/register', { sessionId: 'session-wake2', alias: 'wk2' })
      assertEq('x3:wake2-target-registered', regX3b.status, 200)
      const inboxPath = join(bridgeDir, 'inbox.log')
      appendFileSync(inboxPath, JSON.stringify({ type: 'ping', from: 'x3', to: 'na@session-noise', body: '[ref:X3a] noise' }) + '\n')
      appendFileSync(inboxPath, JSON.stringify({ type: 'ping', from: 'x3', to: 'nb@session-true-ghost', body: '[ref:X3b] ghost' }) + '\n')
      appendFileSync(inboxPath, JSON.stringify({ type: 'ping', from: 'x3', to: 'wk@session-wake', body: '[ref:X3c] wake' }) + '\n')
      appendFileSync(inboxPath, JSON.stringify({ type: 'ping', from: 'x3', to: 'wk2@session-wake2', body: '[ref:X3d] wake2' }) + '\n')
      const deadPath = join(bridgeDir, 'dead.log')
      // A-fix 后死信面 = 2(ghost-noise + ghost-true + wake2-true);X3c 由 adaptiveSkip 消死信。
      ok('x3:three-dead-letters', await waitFor(() => {
        if (!existsSync(deadPath)) return false
        return readFileSync(deadPath, 'utf8').trim().split('\n').filter((l) => l.includes('[ref:X3')).length === 3
      }, { timeoutMs: 8000 }))
      const entries = readFileSync(deadPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      const noise = entries.find((e) => e.line?.includes('[ref:X3a'))
      const ghost = entries.find((e) => e.line?.includes('[ref:X3b'))
      const wake = entries.find((e) => e.line?.includes('[ref:X3c'))
      const wake2 = entries.find((e) => e.line?.includes('[ref:X3d'))
      assertEq('x3:noise-deadclass-key', noise?.deadClass, 'noise-parallel-delivered')
      assertEq('x3:noise-five-keys', Object.keys(noise ?? {}).sort(), ['at', 'classification', 'deadClass', 'line', 'reason'])
      assertEq('x3:true-ghost-four-keys-unchanged', Object.keys(ghost ?? {}).sort(), ['at', 'classification', 'line', 'reason'])
      ok('x3:true-ghost-has-no-deadclass', ghost?.deadClass === undefined)
      // A-fix 新契约: X3c(游标预越行)零死信、走 adaptiveSkip;X3d(游标未越行)保留 wake 四键。
      ok('x3:wake-prenative-passed-zero-deadletter', wake === undefined)
      // wake2 真幽灵变体 = 三键(at/line/reason,无 classification 无 deadClass——它非寻址死信)
      assertEq('x3:wake2-true-ghost-four-keys', Object.keys(wake2 ?? {}).sort(), ['at', 'line', 'reason'])
      ok('x3:wake2-no-deadclass', wake2?.deadClass === undefined)
      ok('x3:wake-reason-wording-unchanged', typeof wake2?.reason === 'string' && wake2.reason.startsWith('wake failed ') && wake2.reason.includes('(target session-wake2)'), wake2?.reason)
      const counters = handle.status().router.counters
      // deadNoise=1(仅 ghost 面 X3a);wake2 终检时游标(0)未越行 → trueGhost;adaptiveSkip≥2(X3c + X3a 不经此,预置5)。
      assertEq('x4:counters-split', [counters.deadNoise, counters.deadTrueGhost, counters.deadCount], [1, 2, 3])
      ok('x4:adaptive-skip-counted', (counters.adaptiveSkip ?? 0) >= 1 && (counters.adaptiveDefer ?? 0) >= 1)
      const disk = JSON.parse(readFileSync(join(bridgeDir, 'state.json'), 'utf8'))
      assertEq('x4:counters-persisted', [disk.hostBridge?.counters?.deadNoise, disk.hostBridge?.counters?.deadTrueGhost], [1, 2])
      handle.stop()
      handle = null
    } finally {
      if (handle !== null) handle.stop()
      await close(mockHost.server)
      rmSync(bridgeDir, { recursive: true, force: true })
    }
  }
}

/**
 * OBS1-fix: 投递期 unrouted 补死信档 —— 行被路由时目标在册,投递窗(退避重试)内
 * 注册表换代后跌落 unrouted:
 *   a) unrouted + 原生游标越行(非 true-ghost/noise)→ 与 intake 死信同构落档
 *      (reason=unrouted during delivery: + 逐字 intake 措辞, deadClass=noise),
 *      死档后不再重复唤醒(mock host 零第二次 prompt),行终态推进游标;
 *   b) unrouted + 原生游标未越行(true-ghost)→ 不入此档不停止投递,照旧退避,
 *      终态仍 wake-failed 死信(at-least-once 不变),unrouted 计数不记 b 面。
 * 门②: router counters.unrouted 进 /status router 节 + state.json 持久化白名单。
 */
async function obs1Scene() {
  // a) noise 面: 换代 + 原生游标越行。
  {
    const bridgeDir = makeBridgeDir()
    const mockHost = makeMockHost({ failFor: 'session-obs1' })
    const apiPort = await listen(mockHost.server)
    let handle = null
    try {
      handle = await activate({ bridgeDir, apiPort, retryDelayMs: 200, maxWakeFailures: 3, adaptiveDeferMs: 10 })
      const port = Number.parseInt(readFileSync(join(bridgeDir, 'http.port'), 'utf8').trim(), 10)
      const reg = await httpJson(port, 'POST', '/register', { sessionId: 'session-obs1', alias: 'o1' })
      assertEq('obs1a:target-registered', reg.status, 200)
      appendFileSync(join(bridgeDir, 'inbox.log'), JSON.stringify({ type: 'ping', from: 'w', to: 'o1@session-obs1', body: '[ref:OBS1a] noise' }) + '\n')
      // 首轮在册路由成立、必败唤醒到账;随后在投递窗内换代 + 原生游标越行。
      ok('obs1a:first-round-wake-attempted', await waitFor(() => mockHost.calls.some((c) => c.sessionId === 'session-obs1' && c.text?.includes('[ref:OBS1a]')), { timeoutMs: 8000 }))
      const succ = await httpJson(port, 'POST', '/register', { sessionId: 'session-obs1-next', alias: 'o1' })
      assertEq('obs1a:successor-supersedes', [succ.status, succ.data?.superseded?.sessionId], [200, 'session-obs1'])
      writeFileSync(join(bridgeDir, '.cursor.session-obs1'), '99')
      const deadPath = join(bridgeDir, 'dead.log')
      ok('obs1a:unrouted-dead-letter-archived', await waitFor(() => existsSync(deadPath) && readFileSync(deadPath, 'utf8').includes('[ref:OBS1a]'), { timeoutMs: 8000 }))
      const entry = readFileSync(deadPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((e) => e.line?.includes('[ref:OBS1a]'))
      ok('obs1a:reason-unrouted-with-intake-wording', typeof entry?.reason === 'string' && entry.reason.startsWith('unrouted during delivery: ') && entry.reason.includes('is a stale generation of alias o1'), entry?.reason)
      assertEq('obs1a:classification-stale', entry?.classification, 'stale address')
      assertEq('obs1a:deadclass-noise', entry?.deadClass, 'noise-parallel-delivered')
      assertEq('obs1a:five-keys-intake-isomorphic', Object.keys(entry ?? {}).sort(), ['at', 'classification', 'deadClass', 'line', 'reason'])
      await sleep(300) // 远大于退避/让道窗: 若档后未停打,此处必现第二次 prompt
      assertEq('obs1a:no-second-wake-after-archive', mockHost.calls.filter((c) => c.sessionId === 'session-obs1' && c.text?.includes('[ref:OBS1a]')).length, 1)
      ok('obs1a:line-terminated-cursor-advanced', handle.status().router.cursor === 1 && handle.status().router.pending === null, `cursor=${handle.status().router.cursor} pending=${JSON.stringify(handle.status().router.pending)}`)
      // 门②: 计数三面一致(内存 / /status router 节 / state.json 持久化)。
      const counters = handle.status().router.counters
      ok('obs1a:unrouted-counted-in-memory', (counters.unrouted ?? 0) >= 1 && counters.deadNoise >= 1, `unrouted=${counters.unrouted} deadNoise=${counters.deadNoise}`)
      const status = await httpJson(port, 'GET', '/status', undefined)
      ok('obs1b:status-router-unrouted-node', (status.data?.router?.counters?.unrouted ?? 0) >= 1, JSON.stringify(status.data?.router?.counters))
      const disk = JSON.parse(readFileSync(join(bridgeDir, 'state.json'), 'utf8'))
      ok('obs1b:state-persisted-unrouted-whitelist', (disk.hostBridge?.counters?.unrouted ?? 0) >= 1, `disk.unrouted=${disk.hostBridge?.counters?.unrouted}`)
      handle.stop()
      handle = null
    } finally {
      if (handle !== null) handle.stop()
      await close(mockHost.server)
      rmSync(bridgeDir, { recursive: true, force: true })
    }
  }

  // b) true-ghost 面: 换代但原生游标未越行 → 不入死信档、不停止投递。
  {
    const bridgeDir = makeBridgeDir()
    const mockHost = makeMockHost({ failFor: 'session-obs2' })
    const apiPort = await listen(mockHost.server)
    let handle = null
    try {
      handle = await activate({ bridgeDir, apiPort, retryDelayMs: 150, maxWakeFailures: 2, adaptiveDeferMs: 10 })
      const port = Number.parseInt(readFileSync(join(bridgeDir, 'http.port'), 'utf8').trim(), 10)
      const reg = await httpJson(port, 'POST', '/register', { sessionId: 'session-obs2', alias: 'o2' })
      assertEq('obs1c:target-registered', reg.status, 200)
      appendFileSync(join(bridgeDir, 'inbox.log'), JSON.stringify({ type: 'ping', from: 'w', to: 'o2@session-obs2', body: '[ref:OBS1b] ghost' }) + '\n')
      ok('obs1c:first-round-wake-attempted', await waitFor(() => mockHost.calls.some((c) => c.sessionId === 'session-obs2' && c.text?.includes('[ref:OBS1b]')), { timeoutMs: 8000 }))
      const succ = await httpJson(port, 'POST', '/register', { sessionId: 'session-obs2-next', alias: 'o2' })
      assertEq('obs1c:successor-supersedes', [succ.status, succ.data?.superseded?.sessionId], [200, 'session-obs2'])
      // 原生游标不写(未越行) → true-ghost: 退避续投至 wake-failed 终态。
      const deadPath = join(bridgeDir, 'dead.log')
      ok('obs1c:wake-failed-terminal-still-reached', await waitFor(() => existsSync(deadPath) && readFileSync(deadPath, 'utf8').includes('[ref:OBS1b]'), { timeoutMs: 8000 }))
      const entry = readFileSync(deadPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((e) => e.line?.includes('[ref:OBS1b]'))
      ok('obs1c:true-ghost-keeps-wake-wording', typeof entry?.reason === 'string' && entry.reason.startsWith('wake failed ') && entry.reason.includes('(target session-obs2)') && !entry.reason.includes('unrouted during delivery'), entry?.reason)
      assertEq('obs1c:wake-shape-unchanged', Object.keys(entry ?? {}).sort(), ['at', 'line', 'reason'])
      ok('obs1c:no-deadclass-on-true-ghost', entry?.deadClass === undefined)
      ok('obs1c:delivery-continued-after-unroute', mockHost.calls.filter((c) => c.sessionId === 'session-obs2' && c.text?.includes('[ref:OBS1b]')).length >= 2, `prompts=${mockHost.calls.filter((c) => c.sessionId === 'session-obs2').length}`)
      const counters = handle.status().router.counters
      assertEq('obs1c:unrouted-not-counted-for-true-ghost', [counters.unrouted ?? 0, counters.deadTrueGhost, counters.deadNoise], [0, 1, 0])
      handle.stop()
      handle = null
    } finally {
      if (handle !== null) handle.stop()
      await close(mockHost.server)
      rmSync(bridgeDir, { recursive: true, force: true })
    }
  }
}

/** IDX-4: G15(预部署面)/G16(剧本演练,沙箱 rendition);IDX-5 G15 白名单扩容。 */
async function deployScene() {
  const pluginDir = dirname(new URL(import.meta.url).pathname)
  const repoRoot = join(pluginDir, '..', '..')
  // G15(预部署面): 改动不出本票白名单; polyfill.patch.yml 入口行未动。
  //   IDX-4 票面 = plugins/host-callback-bridge/;IDX-5 票面追加回调韧性四件
  //   (cb-send 韧性 / cb-send 回归剧本 / session-spawn 提示 / maestro-orch 技能行)。
  //   白名单外任何路径 = 越权改动, 门红。
  //   (完整 G15 = dev-sync 后 diff -rq 装点零差异——部署门执行,留予编排者。)
  {
    const idx5Allow = ['bin/cb-send', 'bin/cb-send-regress.sh', 'bin/session-spawn', 'shared/maestro-orch/SKILL.md']
    const diff = spawnSyncJson('git', ['-C', repoRoot, 'diff', '--name-only', 'HEAD'])
    const outside = (Array.isArray(diff) ? diff : []).filter((f) => !f.startsWith('plugins/host-callback-bridge/') && !idx5Allow.includes(f))
    ok('g15:changes-confined-to-ticket-allowlist', outside.length === 0, outside.join(','))
    let yml = null
    try { yml = readFileSync(join(process.env.HOME ?? '', '.dsh', 'plugins', 'polyfill.patch.yml'), 'utf8') } catch { /* 装点无 yml(非部署环境) */ }
    ok('g15:polyfill-yml-entry-intact', yml === null || yml.includes('host-callback-bridge/index.js'))
  }

  // G16: 六步剧本沙箱演练 —— 落地/装点拷贝/重启续路由/re-arm 回执/广播模板/回滚降级。
  const bridgeDir = makeBridgeDir()
  const mockHost = makeMockHost()
  const apiPort = await listen(mockHost.server)
  let handle = null
  try {
    // 步2(装点同步 rendition): cp -a → diff -rq 零差异。
    const install = mkdtempSync(join(tmpdir(), 'hcb-install-'))
    try {
      spawnSync('cp', ['-a', `${pluginDir}/.`, install])
      const d = spawnSync('diff', ['-rq', '--exclude=__pycache__', pluginDir, install])
      assertEq('g16:step2-install-copy-identical', d.status, 0)
    } finally {
      rmSync(install, { recursive: true, force: true })
    }

    // 步3+4(重启 + re-arm): 注册 → 重启(stop/activate 同 dir) → 路由表跨重启有效 + 续期不换代。
    handle = await activate({ bridgeDir, apiPort })
    let port = Number.parseInt(readFileSync(join(bridgeDir, 'http.port'), 'utf8').trim(), 10)
    let r = await httpJson(port, 'POST', '/register', { sessionId: 'session-g16', alias: 'drill' })
    assertEq('g16:initial-arm-epoch-1', r.data?.epoch, 1)
    handle.stop()
    handle = await activate({ bridgeDir, apiPort })
    port = Number.parseInt(readFileSync(join(bridgeDir, 'http.port'), 'utf8').trim(), 10)
    r = await httpJson(port, 'POST', '/register', { sessionId: 'session-g16', alias: 'drill' })
    assertEq('g16:rearm-after-restart-is-renewal', [r.status, r.data?.epoch, r.data?.superseded], [200, 1, null])
    r = await httpJson(port, 'POST', '/callback', { type: 'ping', from: 'g16', to: 'drill@session-g16', body: 'post-restart' })
    assertEq('g16:routing-survives-restart', r.status, 200)
    ok('g16:post-restart-delivered', await waitFor(() => mockHost.calls.some((c) => c.text?.includes('post-restart'))))

    // 步5(作废广播 rendition): 回执字段足以填模板。
    const status = await httpJson(port, 'GET', '/status', undefined)
    const drill = (status.data?.registeredConsumers ?? []).find((c) => c.sessionId === 'session-g16')
    const broadcast = `换代者新签名 ${drill?.consumer} epoch ${drill?.epoch}; 投旧签名将 400(stale address 附 supersededBy), 请按回执刷新后重发; 桥不自动改投`
    ok('g16:step5-broadcast-template-fills', drill !== undefined && broadcast.includes('@') && broadcast.includes('epoch'))

    // 步6(回滚 rendition): v5 落盘 → v4 透镜(旧白名单)读入 → 自然降级零迁移。
    const disk = JSON.parse(readFileSync(join(bridgeDir, 'registry.json'), 'utf8'))
    const v4View = {}
    for (const [sid, entry] of Object.entries(disk.consumers ?? {})) {
      v4View[sid] = { alias: entry.alias ?? null, pid: Number.isFinite(entry.pid) ? entry.pid : null, armedAt: typeof entry.armedAt === 'string' ? entry.armedAt : null }
    }
    assertEq('g16:step6-rollback-degrades-to-v4', Object.keys(v4View.session_g16_never ?? v4View['session-g16'] ?? {}).sort(), ['alias', 'armedAt', 'pid'])
    ok('g16:step6-aliases-node-ignorable', disk.aliases !== undefined && v4View['session-g16'].alias === 'drill')

    handle.stop()
    handle = null
  } finally {
    if (handle !== null) handle.stop()
    await close(mockHost.server)
    rmSync(bridgeDir, { recursive: true, force: true })
  }
}

function spawnSyncJson(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim().split('\n').filter((l) => l.length > 0) : []
}

async function main() {
  console.log(`host-callback-bridge selftest v${version}`)
  await mainScene()
  await standbyScene()
  await takeoverScene()
  await wakeFailureScene()
  await rotationScene()
  await epochScene()      // IDX-4: G1-G3, G5-G12 (ADDR-R1 + alias-epoch)
  await migrationScene()  // IDX-4: G13 (v4 懒迁移)
  await idx5Scene()       // IDX-5: X1-X4 (ceded 让渡 / 死信二分类 / 计数分立)
  await obs1Scene()       // OBS1-fix: 投递期 unrouted 死信档(noise 落档 / true-ghost 不停投 / 计数三面)
  await deployScene()     // IDX-4: G15(预部署面)/G16(剧本演练) + G14 汇总于退出码
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
