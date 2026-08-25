/**
 * http source 单测(node:test)—— 移植自 plugins/message-bridge/index.test.mjs(7 例)。
 * 临时目录 + 随机端口真实监听,用 fetch 走完整 HTTP 路径验证 200/208/400 三态及边界。
 * 不触碰 ~/.dsh/maestro/bridge 生产文件。运行:
 *   node --test plugins/callback-bridge/http.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHttpSource } from './sources/http.js'
import { createBridgeStore } from './core/store.js'
import { createDedupWindow } from './core/dedup.js'
import { resolveRouting } from './core/addressing.js'
import { version, DEDUP_WINDOW_MS } from './index.js'

const bridgeDirs = []
async function makeBridge() {
  const dir = await mkdtemp(join(tmpdir(), 'cb-http-'))
  bridgeDirs.push(dir)
  return dir
}

test.after?.(() => { void Promise.all(bridgeDirs.map((dir) => rm(dir, { recursive: true, force: true }))) })

async function withService(fn, config = {}) {
  const dir = config.bridgeDir ?? await makeBridge()
  const delivered = []
  const store = createBridgeStore({ bridgeDir: dir })
  const clock = { now: 1_000_000 }
  const consumer = { sessionId: 'session-http-test' }
  const dedup = createDedupWindow({ windowMs: DEDUP_WINDOW_MS, now: () => clock.now })
  const sink = config.sink ?? { deliver: (line) => { delivered.push(line) } }
  const service = createHttpSource({
    store, consumer, router: { resolve: resolveRouting }, dedup, sink, version,
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
    await fn({ dir, delivered, service, port, base, post, clock, store })
  } finally {
    service.stop()
  }
}

test('exports v4 version fingerprint', () => {
  assert.equal(version, '4.1.0')
  assert.equal(DEDUP_WINDOW_MS, 60_000)
})

test('valid callback → 200 delivered; wake receives canonical line; port file written; state merged into state.json', async () => {
  await withService(async ({ dir, delivered, post, port, store }) => {
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
    assert.equal(parsed.to, 'session-http-test') // 缺省 to → 本绑定消费者(HTTP-R1)
    assert.equal(parsed.body, 'task finished')

    assert.equal((await readFile(join(dir, 'http.port'), 'utf8')).trim(), String(port))
    // HTTP-R2: 计数并入主 state.json 的 consumers.<sid>.http,无独立 http.state.json
    assert.equal(await readMaybe(join(dir, 'http.state.json')), null)
    const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
    assert.equal(state.consumers['session-http-test'].http.counters.delivered, 1)
    assert.equal(state.consumers['session-http-test'].http.last.from, 'worker@a1')
    assert.equal(state.consumers['session-http-test'].http.last.to, 'session-http-test')
    assert.equal(state.consumers['session-http-test'].http.bind.port, port)
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

    const other = await post('/callback', { type: 'ping', from: 'dup@x', body: 'different' })
    assert.equal(other.status, 200)
    const otherSender = await post('/callback', { type: 'ping', from: 'other@x', body: 'hello' })
    assert.equal(otherSender.status, 200)
    assert.equal(delivered.length, 3)

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

test('unarmed sink → 503; sink error → 500', async () => {
  const dir = await makeBridge()
  const consumer = { sessionId: 'session-http-test' }
  const makeService = (sink) => createHttpSource({
    store: createBridgeStore({ bridgeDir: dir }),
    consumer,
    router: { resolve: resolveRouting },
    dedup: createDedupWindow({ windowMs: DEDUP_WINDOW_MS }),
    sink,
    version,
  })

  const unrouted = makeService({
    deliver: () => { throw Object.assign(new Error('callback-bridge not armed: call bridge_arm first'), { code: 'MSG_BRIDGE_NOT_ARMED' }) },
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

  const failing = makeService({
    deliver: () => { throw new Error('agent refused') },
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

    const oversized = await post('/callback', { type: 'ping', from: 'a@x', body: 'x'.repeat(256 * 1024) })
    assert.equal(oversized.status, 413)
  })
})

test('listener binds loopback only; status reports port/bind/counters', async () => {
  await withService(async ({ service, port }) => {
    const s = service.status()
    assert.equal(s.version, '4.1.0')
    assert.equal(s.bind.host, '127.0.0.1')
    assert.equal(s.bind.port, port)
    assert.equal(s.endpoint, `http://127.0.0.1:${port}/callback`)
    assert.ok(s.counters)
    const address = service.port
    assert.equal(typeof address, 'number')
    assert.ok(address > 0)
  })
})

async function readMaybe(path) {
  try { return await readFile(path, 'utf8') } catch { return null }
}
