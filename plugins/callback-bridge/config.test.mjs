/**
 * config 归一 + 双 source 用例(node:test)。
 * 新增用例(非旧测试移植): normalizeConfig / resolveBridgeDir / 双 source 共享 dedup / apply 契约冒烟。
 * 运行:
 *   node --test plugins/callback-bridge/config.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, appendFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeConfig, resolveBridgeDir, apply, version, DEDUP_WINDOW_MS } from './index.js'
import { createBridgeStore } from './core/store.js'
import { createDedupWindow } from './core/dedup.js'
import { resolveRouting } from './core/addressing.js'
import { registerConsumer } from './core/registry.js'
import { createFileInboxSource } from './sources/file-inbox.js'
import { createHttpSource } from './sources/http.js'

const bridgeDirs = []
async function makeBridge() {
  const dir = await mkdtemp(join(tmpdir(), 'cb-config-'))
  bridgeDirs.push(dir)
  return dir
}

test.after?.(() => { void Promise.all(bridgeDirs.map((dir) => rm(dir, { recursive: true, force: true }))) })

// ---------------------------------------------------------------- config 归一

test('normalizeConfig: defaults when empty; partial overrides merge; unknown source kind throws', () => {
  const d = normalizeConfig(undefined)
  assert.equal(d.bridgeDir, null)
  assert.equal(d.aliasEnv, 'MAESTRO_BRIDGE_ALIAS')
  assert.equal(d.sink.messagePrefix, 'ORCA-CB]')
  assert.equal(d.sink.pluginId, '@maestro/callback-bridge')
  assert.equal(d.engine.dedupWindowMs, 60_000)
  assert.equal(d.engine.maxWakeFailures, 3)
  assert.equal(d.engine.retryDelayMs, 2_000)
  assert.equal(d.sources.length, 2)
  assert.equal(d.sources[0].kind, 'file-inbox')
  assert.equal(d.sources[0].echoPrefix, 'DSH-RE]')
  assert.equal(d.sources[1].kind, 'http')
  assert.equal(d.sources[1].basePath, '/callback')

  const partial = normalizeConfig({
    bridgeDir: '~/.dsh/x/bridge',
    engine: { dedupWindowMs: 123 },
    sink: { messagePrefix: 'X]' },
  })
  assert.equal(partial.bridgeDir, '~/.dsh/x/bridge')
  assert.equal(partial.engine.dedupWindowMs, 123)
  assert.equal(partial.engine.maxWakeFailures, 3) // 未覆盖项取缺省
  assert.equal(partial.sink.messagePrefix, 'X]')
  assert.equal(partial.sink.pluginId, '@maestro/callback-bridge') // 未覆盖项取缺省
  assert.equal(partial.sources.length, 2)

  assert.throws(() => normalizeConfig({ sources: [{ kind: 'websocket' }] }), /unknown or malformed source kind/)
  assert.throws(() => normalizeConfig({ sources: [{ }] }), /unknown or malformed source kind/)

  // null / 非对象 → 缺省
  assert.equal(normalizeConfig(null).sources.length, 2)
  assert.equal(normalizeConfig('nope').sources.length, 2)
})

test('resolveBridgeDir: env > config > default; expands leading ~', () => {
  const old = process.env.MAESTRO_BRIDGE
  try {
    delete process.env.MAESTRO_BRIDGE
    assert.equal(resolveBridgeDir('~/.dsh/x'), `${process.env.HOME}/.dsh/x`)
    assert.equal(resolveBridgeDir(null), `${process.env.HOME}/.dsh/maestro/bridge`)
    process.env.MAESTRO_BRIDGE = '/tmp/bridge-env'
    assert.equal(resolveBridgeDir('~/.dsh/x'), '/tmp/bridge-env')
  } finally {
    if (old === undefined) delete process.env.MAESTRO_BRIDGE
    else process.env.MAESTRO_BRIDGE = old
  }
})

// ---------------------------------------------------------------- 双 source 共享 dedup

test('dual sources share one dedup window across file-inbox and http channels', async () => {
  const dir = await makeBridge()
  const store = createBridgeStore({ bridgeDir: dir })
  const dedup = createDedupWindow({ windowMs: DEDUP_WINDOW_MS })
  const delivered = []
  const sink = { deliver: (line) => { delivered.push(line) } }
  const consumer = { sessionId: 'session-http-test' }
  const router = { resolve: resolveRouting }

  const file = createFileInboxSource({ store, consumer, router, dedup, sink, version, retryDelayMs: 60_000 })
  const http = createHttpSource({ store, consumer, router, dedup, sink, version })

  // bridge_arm 共享注册(供 http 路由读取 registry)。
  await registerConsumer(store.paths.registry, version, consumer, { armedAt: new Date().toISOString(), pid: process.pid })

  // 文件通道投递一条 (from=dup@x, body=shared)。
  await appendFile(join(dir, 'inbox.log'), '{"type":"done","from":"dup@x","to":"session-http-test","body":"shared"}\n')
  await file.flush()
  assert.equal(delivered.length, 1)
  assert.equal(JSON.parse(delivered[0]).body, 'shared')

  // HTTP 通道投递同 (from, body) → 跨通道 dedup 吸收(208),不二次 wake。
  const port = await http.start()
  let response = await fetch(`http://127.0.0.1:${port}/callback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'done', from: 'dup@x', body: 'shared' }),
  })
  assert.equal(response.status, 208)
  assert.equal(delivered.length, 1)

  // 不同 body → 200,第二次 wake。
  response = await fetch(`http://127.0.0.1:${port}/callback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'done', from: 'dup@x', body: 'other' }),
  })
  assert.equal(response.status, 200)
  assert.equal(delivered.length, 2)

  http.stop()
  await file.dispose()
})

// ---------------------------------------------------------------- apply 契约冒烟

/** 轮询等待谓词为真(watcher 驱动的异步投递是生产路径,断言前须等它完成)。 */
async function waitFor(predicate, timeoutMs = 2_000, stepMs = 10) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
}

test('apply smoke: idle→followup, busy→inject; ORCA-CB] prefix + plugin source metadata', async () => {
  const dir = await makeBridge()
  const old = process.env.MAESTRO_BRIDGE
  const followups = []
  const injects = []
  let currentAgent
  const tools = []
  const effects = []

  const ctx = {
    agents: { requireInitiator: () => currentAgent },
    tools: { register: (t) => { tools.push(t) } },
    effect: (fn) => { effects.push(fn) },
  }

  // 隔离生产桥: config.bridgeDir 显式指向临时目录,且清掉 env 以排除干扰。
  delete process.env.MAESTRO_BRIDGE
  try {
    apply(ctx, { bridgeDir: dir, sources: [{ kind: 'file-inbox' }] })
  } finally {
    if (old === undefined) delete process.env.MAESTRO_BRIDGE
    else process.env.MAESTRO_BRIDGE = old
  }

  assert.equal(tools.map((t) => t.name).sort().join(','), 'bridge_arm,bridge_http_status,bridge_status')

  // idle: 投一条 → watcher 驱动 flush → followup
  currentAgent = {
    id: 'session-apply-test',
    status: 'idle',
    followup: (m) => { followups.push(m) },
    inject: (m) => { injects.push(m) },
  }
  const receipt = await armExecute(tools, { alias: 'orch' })
  assert.match(receipt, /callback-bridge v4\.1\.0/)
  assert.match(receipt, /orch@session-apply-test/)

  await appendFile(join(dir, 'inbox.log'), '{"type":"ping","from":"a@x","to":"orch@session-apply-test","body":"hi"}\n')
  await waitFor(() => followups.length === 1)
  assert.equal(followups.length, 1)
  assert.equal(injects.length, 0)
  const msg = followups[0]
  assert.ok(msg.content[0].text.startsWith('ORCA-CB] '), `prefix: ${msg.content[0].text}`)
  assert.equal(msg.source.kind, 'plugin')
  assert.equal(msg.source.plugin, '@maestro/callback-bridge')

  // busy: 投第二条 → inject
  currentAgent.status = 'busy'
  await appendFile(join(dir, 'inbox.log'), '{"type":"ping","from":"a@x","to":"orch@session-apply-test","body":"hi2"}\n')
  await waitFor(() => injects.length === 1)
  assert.equal(followups.length, 1)
  assert.equal(injects.length, 1)

  // 幂等再 arm: 游标已推进,不产生重复投递。
  await armExecute(tools, { alias: 'orch' })
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(followups.length, 1)
  assert.equal(injects.length, 1)

  // teardown: 触发 effect 清理(关闭 watcher + dispose 注销 registry)。
  const cleanup = effects[effects.length - 1]
  cleanup()
  await new Promise((resolve) => setTimeout(resolve, 50))
})

async function armExecute(tools, args) {
  const arm = tools.find((t) => t.name === 'bridge_arm')
  return arm.execute(args)
}

// ---------------------------------------------------------------- P4 新增用例(T6)

test('P4: v4.1.0 双 slot 隔离(incident 0003 防线)——A arm→B arm→投 A 签名,A 收 B 不收', async () => {
  const dir = await makeBridge()
  const followupsA = []
  const followupsB = []
  let agentA
  let agentB
  const tools = []
  const effects = []
  const ctx = {
    agents: { requireInitiator: () => currentAgent },
    tools: { register: (t) => { tools.push(t) } },
    effect: (fn) => { effects.push(fn) },
  }
  let currentAgent
  delete process.env.MAESTRO_BRIDGE
  apply(ctx, { bridgeDir: dir, sources: [{ kind: 'file-inbox' }] })
  agentA = { id: 'session-slot-a', status: 'idle', followup: (m) => { followupsA.push(m) }, inject: () => {} }
  agentB = { id: 'session-slot-b', status: 'idle', followup: (m) => { followupsB.push(m) }, inject: () => {} }
  currentAgent = agentA
  const receiptA = await armExecute(tools, { alias: 'alpha' })
  assert.match(receiptA, /alpha@session-slot-a/)
  currentAgent = agentB
  const receiptB = await armExecute(tools, { alias: 'beta' })
  assert.match(receiptB, /beta@session-slot-b/)
  // 投 A 签名
  currentAgent = agentA
  await appendFile(join(dir, 'inbox.log'), '{"type":"ping","from":"x","to":"alpha@session-slot-a","body":"for A only"}\n')
  await waitFor(() => followupsA.length === 1, 4_000)
  assert.equal(followupsA.length, 1, `A 未收到投递;status=${await tools.find((t) => t.name === 'bridge_status').execute()}`)
  assert.equal(followupsB.length, 0, 'B 不收(分槽隔离)')
  // A 重 arm 换别名: A 回执新别名,B 槽不动
  currentAgent = agentA
  const receiptA2 = await armExecute(tools, { alias: 'alpha2' })
  assert.match(receiptA2, /alpha2@session-slot-a/)
  const status = await tools.find((t) => t.name === 'bridge_status').execute()
  assert.match(status, /alpha2@session-slot-a/)
  assert.match(status, /beta@session-slot-b/)
  const cleanup = effects[effects.length - 1]
  cleanup()
  await new Promise((r) => setTimeout(r, 50))
})

test('P4: P4.7 行 config 解析 sources 恰 1 条 file-inbox(显式 config 覆盖双 source 缺省)', () => {
  const cfg = normalizeConfig({
    bridgeDir: null,
    aliasEnv: 'MAESTRO_BRIDGE_ALIAS',
    sink: { messagePrefix: 'ORCA-CB]', pluginId: '@maestro/callback-bridge' },
    engine: { dedupWindowMs: 60000, maxWakeFailures: 3, retryDelayMs: 2000 },
    sources: [{ kind: 'file-inbox', file: 'inbox.log', echoPrefix: 'DSH-RE]', rotateMaxBytes: 1048576, rotateMaxLines: 1000 }],
  })
  assert.equal(cfg.sources.length, 1)
  assert.equal(cfg.sources[0].kind, 'file-inbox')
})

test('P4: bridge_http_status deprecated 别名——回执含 [deprecated] 且不创建监听', async () => {
  const tools = []
  const ctx = {
    agents: { requireInitiator: () => { throw new Error('n/a') } },
    tools: { register: (t) => { tools.push(t) } },
    effect: () => {},
  }
  delete process.env.MAESTRO_BRIDGE
  apply(ctx, { bridgeDir: await makeBridge(), sources: [{ kind: 'file-inbox' }] })
  const alias = tools.find((t) => t.name === 'bridge_http_status')
  assert.ok(alias, '别名已注册')
  const out = await alias.execute()
  assert.match(out, /^\[deprecated\] use bridge_status/)
  assert.match(out, /host lane/)
})

test('P4: core/ 四文件纯 re-export(单一物理源= _narrow-waist)', async () => {
  const fs = await import('node:fs/promises')
  for (const f of ['addressing.js', 'dedup.js', 'registry.js', 'store.js']) {
    const src = await fs.readFile(join(import.meta.dirname, 'core', f), 'utf8')
    assert.ok(src.includes("from '../../_narrow-waist/"), `${f} 非 re-export`)
    assert.ok(!/function\s+\w+\s*\(/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^ \*.*$/gm, '')), `${f} 含本地实现体`)
  }
})

test('P4: 双槽并发 registerSelf 压测(写链继承,20 轮交错不丢条目)', async () => {
  const dir = await makeBridge()
  const registryPath = join(dir, 'registry.json')
  const { registerConsumer } = await import('./core/registry.js')
  const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) =>
    registerConsumer(registryPath, `gen-${i}`, { sessionId: `session-cc-${String(i).padStart(2, '0')}`, alias: `a${i}` }, { armedAt: 't', pid: 1 })))
  assert.equal(results.filter((r) => r.status === 'rejected').length, 0)
  const { readRegistry } = await import('./core/registry.js')
  const reg = await readRegistry(registryPath)
  assert.equal(Object.keys(reg.consumers).length, 20)
})
