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
    }))
    await waitFor(() => mockHost.calls.some((c) => c.text?.includes('ver-passthrough')))

    // G3: 双活槽 + ghost 显式 to → 双方投递零新增(任何面都不猜收件人)。
    const callsBefore = mockHost.calls.length
    const inboxG3 = inboxLines().length
    r = await httpJson(port, 'POST', '/callback', { type: 'ping', from: 'g3', to: 'ghost@session-g3-nowhere', body: 'g3' })
    assertEq('g3:ghost-400', r.status, 400)
    await sleep(250)
    assertEq('g3:no-inbox-growth', inboxLines().length, inboxG3)
    assertEq('g3:no-auto-redirection', mockHost.calls.length, callsBefore)

    // G12: 无 epoch 意识旧端四态全链。
    r = await httpJson(port, 'POST', '/callback', { type: 'done', from: 'old-client', to: `gb@${SIDY}`, body: '[ref:G12] done' })
    assertEq('g12:live-200', [r.status, r.data?.status], [200, 'accepted'])
    r = await httpJson(port, 'POST', '/callback', { type: 'done', from: 'old-client', to: `gb@${SIDY}`, body: '[ref:G12] done' })
    assertEq('g12:replay-208', [r.status, r.data?.status], [208, 'already-delivered'])
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
    ok('g5:file-dead-stale-classification', await waitFor(() => existsSync(deadPath) && readFileSync(deadPath, 'utf8').includes('"classification":"stale address"') && readFileSync(deadPath, 'utf8').includes('is a stale generation of alias ga')))

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
    ok('g13:bare-alias-ambiguous-dead', await waitFor(() => existsSync(join(bridgeDir, 'dead.log')) && readFileSync(join(bridgeDir, 'dead.log'), 'utf8').includes('is ambiguous across 2')))
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

/** IDX-4: G15(预部署面)/G16(剧本演练,沙箱 rendition)。 */
async function deployScene() {
  const pluginDir = dirname(new URL(import.meta.url).pathname)
  const repoRoot = join(pluginDir, '..', '..')
  // G15(预部署面): 本票改动不出 plugins/host-callback-bridge; polyfill.patch.yml 入口行未动。
  //   (完整 G15 = dev-sync 后 diff -rq 装点零差异——本票红线禁 dev-sync 正向, 留给部署门。)
  {
    const diff = spawnSyncJson('git', ['-C', repoRoot, 'diff', '--name-only', 'HEAD'])
    const outside = (Array.isArray(diff) ? diff : []).filter((f) => !f.startsWith('plugins/host-callback-bridge/'))
    ok('g15:changes-confined-to-plugin-dir', outside.length === 0, outside.join(','))
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
