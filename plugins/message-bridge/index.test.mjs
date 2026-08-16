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
import { createBridgeService, version, MAX_BODY_BYTES, DEDUP_WINDOW_MS, TYPES } from './index.js'

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
  assert.equal(version, '1.1.0')
  assert.equal(DEDUP_WINDOW_MS, 60_000)
  assert.equal(MAX_BODY_BYTES, 256 * 1024)
  assert.deepEqual(TYPES, ['ack', 'done', 'ping', 'status'])
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
    const state = JSON.parse(await readFile(join(dir, 'http.state.json'), 'utf8'))
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

test('unarmed wake → 503; wake error → 500', async () => {
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
    assert.equal(s.version, '1.1.0')
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
