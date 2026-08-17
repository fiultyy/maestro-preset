/**
 * message-bridge 单测（node:test）：临时目录 + 随机端口真实监听，
 * 用 fetch 走完整 HTTP 路径验证 200 / 400 / 208 三态及边界。
 * 不触碰 ~/.dsh/maestro/bridge 生产文件。运行：
 *   node --test plugins/message-bridge/index.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBridgeService, apply, pickRecipient, ROUTE_MISS, version, MAX_BODY_BYTES, DEDUP_WINDOW_MS, TYPES } from './index.js'

const bridgeDirs = []
async function makeBridge() {
  const dir = await mkdtemp(join(tmpdir(), 'msgbridge-'))
  bridgeDirs.push(dir)
  return dir
}

// 会话内自清理：整个测试文件结束后移除全部临时目录。
test.after?.(() => { void Promise.all(bridgeDirs.map((dir) => rm(dir, { recursive: true, force: true }))) })

async function withService(fn, config = {}) {
  const dir = config.bridgeDir ?? await makeBridge()
  const delivered = []
  const wake = config.wake ?? ((line) => { delivered.push(line) })
  const clock = { now: 1_000_000 }
  const service = createBridgeService({
    bridgeDir: dir,
    wake,
    now: () => clock.now,
    ...config,
  })
  const port = await service.start()
  const base = `http://127.0.0.1:${port}`
  const post = async (path, body, headers = { 'content-type': 'application/json' }) => {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
    const text = await response.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* 非 JSON 响应体 */ }
    return { status: response.status, json, text }
  }
  try {
    await fn({ dir, delivered, service, port, base, post, clock })
  } finally {
    service.stop()
  }
}

test('exports version fingerprint', () => {
  assert.equal(version, '1.3.0')
  assert.equal(DEDUP_WINDOW_MS, 60_000)
  assert.equal(MAX_BODY_BYTES, 256 * 1024)
  assert.deepEqual(TYPES, ['ack', 'done', 'ping', 'status'])
  // ROUTE_MISS 是稳定判别哨: pickRecipient 显式失配返回它, apply 层映射为 404。
  assert.equal(typeof ROUTE_MISS, 'symbol')
})

test('ack (dispatch handshake) → 200 delivered, same canonical line shape', async () => {
  await withService(async ({ delivered, post }) => {
    const response = await post('/callback', { type: 'ack', from: 'dev1@t1', to: 'orch@session-x', body: '[ref:n1] turn started' })
    assert.equal(response.status, 200)
    assert.equal(response.json.status, 'delivered')
    const parsed = JSON.parse(delivered[0])
    assert.equal(parsed.type, 'ack')
    assert.equal(parsed.from, 'dev1@t1')
    assert.equal(parsed.to, 'orch@session-x')
    assert.equal(parsed.body, '[ref:n1] turn started')
  })
})

test('valid callback → 200 delivered; wake receives MSGBR-shaped canonical line; port file written', async () => {
  await withService(async ({ dir, delivered, post, port }) => {
    const response = await post('/callback', { type: 'done', from: 'worker@a1', body: 'task finished' })
    assert.equal(response.status, 200)
    assert.equal(response.json.ok, true)
    assert.equal(response.json.status, 'delivered')
    assert.ok(response.json.id)

    assert.equal(delivered.length, 1)
    const line = delivered[0]
    assert(line.startsWith('{"type":"done","from":"worker@a1"'))
    const parsed = JSON.parse(line)
    assert.equal(parsed.type, 'done')
    assert.equal(parsed.from, 'worker@a1')
    assert.equal(parsed.to, '编排1') // to 缺省值：仅记录不路由
    assert.equal(parsed.body, 'task finished')

    assert.equal((await readFile(join(dir, 'http.port'), 'utf8')).trim(), String(port))
    // http.state.json 是 best-effort 镜像, 写在应答之后——轮询收敛, 不赌时序。
    let state = null
    for (let i = 0; i < 100; i++) {
      state = JSON.parse(await readFile(join(dir, 'http.state.json'), 'utf8'))
      if (state.counters.delivered === 1) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(state.counters.delivered, 1)
    assert.equal(state.last.from, 'worker@a1')
    assert.equal(state.last.to, '编排1')
    assert.equal(state.bind.port, port)
  })
})

test('duplicate (from, body) within window → 208 already-delivered, no second wake; after window → 200 again', async () => {
  await withService(async ({ delivered, post, clock }) => {
    const first = await post('/callback', { type: 'ping', from: 'dup@x', body: 'hello' })
    assert.equal(first.status, 200)
    const second = await post('/callback', { type: 'ping', from: 'dup@x', body: 'hello' })
    assert.equal(second.status, 208)
    assert.equal(second.json.ok, true)
    assert.equal(second.json.status, 'already-delivered')
    assert.equal(second.json.deduplicated, true)
    assert.equal(second.json.id, first.json.id)
    assert.equal(delivered.length, 1)

    // 不同 body 或不同 from 不算重复。
    const other = await post('/callback', { type: 'ping', from: 'dup@x', body: 'different' })
    assert.equal(other.status, 200)
    const otherSender = await post('/callback', { type: 'ping', from: 'other@x', body: 'hello' })
    assert.equal(otherSender.status, 200)
    assert.equal(delivered.length, 3)

    // 窗口过后：允许再次投递（幂等窗口语义）。
    clock.now += DEDUP_WINDOW_MS + 1
    const again = await post('/callback', { type: 'ping', from: 'dup@x', body: 'hello' })
    assert.equal(again.status, 200)
    assert.equal(delivered.length, 4)
  })
})

test('validation failures → 400 with details, nothing delivered', async () => {
  await withService(async ({ delivered, post }) => {
    const cases = [
      ['bad json body', '{not json'],
      ['missing type', JSON.stringify({ from: 'a@x', body: 'b' })],
      ['unknown type', JSON.stringify({ type: 'explode', from: 'a@x', body: 'b' })],
      ['missing from', JSON.stringify({ type: 'done', body: 'b' })],
      ['empty from', JSON.stringify({ type: 'done', from: '   ', body: 'b' })],
      ['non-string body', JSON.stringify({ type: 'done', from: 'a@x', body: 42 })],
      ['empty to', JSON.stringify({ type: 'done', from: 'a@x', body: 'b', to: '' })],
      ['non-object', JSON.stringify(['type'])],
    ]
    for (const [label, raw] of cases) {
      const response = await post('/callback', raw)
      assert.equal(response.status, 400, `expected 400 for: ${label}`)
      assert.equal(response.json.ok, false)
      assert.ok(Array.isArray(response.json.details) && response.json.details.length > 0, `details for: ${label}`)
    }
    assert.equal(delivered.length, 0)
  })
})

test('unarmed wake → 503; wake error → 500; route-miss wake → 404 (v1.3 ADDR-R1)', async () => {
  const dir = await makeBridge()
  const unrouted = createBridgeService({
    bridgeDir: dir,
    wake: () => { throw Object.assign(new Error('message-bridge not armed: call bridge_http_status first'), { code: 'MSG_BRIDGE_NOT_ARMED' }) },
  })
  const port = await unrouted.start()
  let response = await fetch(`http://127.0.0.1:${port}/callback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'status', from: 'x@y', body: '?' }),
  })
  assert.equal(response.status, 503)
  assert.equal((await response.json()).ok, false)
  unrouted.stop()

  const failing = createBridgeService({
    bridgeDir: dir,
    wake: () => { throw new Error('agent refused') },
  })
  const port2 = await failing.start()
  response = await fetch(`http://127.0.0.1:${port2}/callback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'status', from: 'x@y', body: '?' }),
  })
  assert.equal(response.status, 500)
  assert.equal((await response.json()).ok, false)
  failing.stop()

  // 显式 to 无匹配 armed 槽: 404 拒收（v1.2 是兜底吸收的 200 假阳性）。
  const routeMiss = createBridgeService({
    bridgeDir: dir,
    wake: (_line, info) => { throw Object.assign(new Error(`no armed HTTP slot for to=${info?.to}`), { code: 'MSG_BRIDGE_ROUTE_MISS' }) },
  })
  const port3 = await routeMiss.start()
  response = await fetch(`http://127.0.0.1:${port3}/callback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'done', from: 'w@t', to: 'orch@session-dead', body: '[ref:x] done' }),
  })
  assert.equal(response.status, 404)
  const miss = await response.json()
  assert.equal(miss.ok, false)
  assert.equal(miss.error, 'no armed HTTP slot for to=orch@session-dead')
  routeMiss.stop()
})

test('routing guard: wrong path → 404, non-POST → 405, oversized body → 413', async () => {
  await withService(async ({ base, post }) => {
    const wrongPath = await post('/other', { type: 'ping', from: 'a@x', body: 'b' })
    assert.equal(wrongPath.status, 404)

    const get = await fetch(`${base}/callback`)
    assert.equal(get.status, 405)
    assert.equal(get.headers.get('allow'), 'POST')

    const oversized = await post('/callback', { type: 'ping', from: 'a@x', body: 'x'.repeat(MAX_BODY_BYTES) })
    assert.equal(oversized.status, 413)
  })
})

test('listener binds loopback only; status reports port/bind/counters', async () => {
  await withService(async ({ service, port }) => {
    const s = service.status()
    assert.equal(s.version, '1.3.0')
    assert.equal(s.bind.host, '127.0.0.1')
    assert.equal(s.bind.port, port)
    assert.equal(s.endpoint, `http://127.0.0.1:${port}/callback`)
    assert.ok(s.counters)
    // 监听地址确实是回环。
    const address = service.port
    assert.equal(typeof address, 'number')
    assert.ok(address > 0)
  })
})

// ------------------------------------------------ apply 层多会话（incident 0003）

function fakeAgent(id) {
  return {
    id,
    status: 'idle',
    received: [],
    followup(message) { this.received.push(message) },
    inject(message) { this.received.push(message) },
  }
}

function fakeCtx() {
  const tools = new Map()
  const harness = {
    current: null,
    teardown: null,
    agents: { requireInitiator: () => { if (!harness.current) throw new Error('no initiator'); return harness.current } },
    tools: { register: (t) => tools.set(t.name, t) },
    effect: (fn) => { harness.teardown = fn() },
  }
  return { ctx: harness, tools, harness }
}

test('pickRecipient (v1.3 ADDR-R1): exact sid / alias@sid route; explicit miss → ROUTE_MISS; missing/empty to → last armer', () => {
  const known = ['session-ka', 'session-kb']
  assert.equal(pickRecipient('session-ka', known, 'session-kb'), 'session-ka')
  assert.equal(pickRecipient('orchB@session-kb', known, 'session-ka'), 'session-kb')
  // 显式定向失配: v1.2 兜底吸收给 last armer → v1.3 拒收(→404), 不再兜底。
  assert.equal(pickRecipient('nobody@session-zz', known, 'session-ka'), ROUTE_MISS)
  // 裸别名/缺省补全值不是 armed 槽: 同样拒收, 由文件桥按 registry 解析别名。
  assert.equal(pickRecipient('orch1', known, 'session-ka'), ROUTE_MISS)
  assert.equal(pickRecipient('编排1', known, 'session-ka'), ROUTE_MISS)
  // to 缺省/空: last-armer 兜底保留（单会话便利, 0005 验收项）。
  assert.equal(pickRecipient(undefined, known, 'session-kb'), 'session-kb')
  assert.equal(pickRecipient('', known, null), null)
})

test('apply slots per session: to=<alias>@<sid> wakes exactly that session; missing to wakes last armer; explicit miss → 404; arm writes http.port.sig (PORT-R1)', async () => {
  const dir = await makeBridge()
  const prev = process.env.MAESTRO_BRIDGE
  process.env.MAESTRO_BRIDGE = dir
  const A = fakeAgent('session-ma')
  const B = fakeAgent('session-mb')
  const { ctx, tools, harness } = fakeCtx()
  apply(ctx)
  try {
    harness.current = A
    await tools.get('bridge_http_status').execute()
    harness.current = B
    const receipt = await tools.get('bridge_http_status').execute()
    assert.match(receipt, /2 armed slot/)
    // PORT-R1: 持有者签名旁挂 = 最近 armer 的 sessionId, 每次 arm 覆写。
    assert.equal((await readFile(join(dir, 'http.port.sig'), 'utf8')).trim(), 'session-mb')

    const port = Number((await readFile(join(dir, 'http.port'), 'utf8')).trim())
    const post = (payload) => fetch(`http://127.0.0.1:${port}/callback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })

    // 定向 A(后 arm 的是 B: to 路由必须压过 last-armer 兜底——0003 劫持形态)
    assert.equal((await post({ type: 'ping', from: 'x@t', to: 'orch@session-ma', body: 'to A' })).status, 200)
    assert.equal((await post({ type: 'ping', from: 'x@t', to: 'session-mb', body: 'to B' })).status, 200)
    assert.equal((await post({ type: 'ping', from: 'x@t', body: 'no to' })).status, 200)
    assert.equal(A.received.length, 1)
    assert.equal(B.received.length, 2)
    assert.match(A.received[0].content[0].text, /MSGBR\].*"to":"orch@session-ma"/)

    // ADDR-R1: 显式 to 指向无 armed 槽的会话 → 404 拒收, 不吸收给 last armer
    // （0005 现场: 仅文件桥编排者的回调不再被 HTTP 编排者错收）。
    const miss = await post({ type: 'ack', from: 'w@t', to: 'orch1@session-ghost', body: '[ref:t9] turn started' })
    assert.equal(miss.status, 404)
    assert.equal((await miss.json()).error, 'no armed HTTP slot for to=orch1@session-ghost')
    assert.equal(A.received.length, 1)
    assert.equal(B.received.length, 2)
  } finally {
    harness.teardown?.() // 停 HTTP listener:放 finally,断言失败也不拖住进程
    if (prev === undefined) delete process.env.MAESTRO_BRIDGE
    else process.env.MAESTRO_BRIDGE = prev
  }
})
