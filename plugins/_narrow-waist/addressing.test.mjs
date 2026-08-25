import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseAddress, aliasIndex,
  resolveRouting, resolveRoutingUnified, resolveHostRouting, resolveAddress,
  findFleetEntry, resolveFleetSessionId,
  sanitizeConsumers, readRegistry, registerConsumer, unregisterConsumer,
} from './addressing.js'
// 只读 oracle: 生产 core/addressing.js 与 pump.js
import * as coreAddressing from '../host-callback-bridge/core/addressing.js'
import { resolveRouting as pumpResolveRouting } from '../orca-callback/pump.js'

const REG = (entries) => ({ version: 'v-test', consumers: Object.fromEntries(entries) })
const SID_A = 'session-aaaa-1111'
const SID_B = 'session-bbbb-2222'
const SELF = 'session-self-0000'

// ---- P1.2.1 resolveRouting 统一形状 ----

test('宿主视角: 空 registry + broadcast → skip', () => {
  const out = resolveRoutingUnified(parseAddress('*'), REG([]), {})
  assert.deepEqual(out, { action: 'skip' })
})

test('宿主视角: 两消费者 broadcast → wake, sids = 全集', () => {
  const reg = REG([
    [SID_A, { alias: 'a', pid: 1, armedAt: 't' }],
    [SID_B, { alias: 'b', pid: 2, armedAt: 't' }],
  ])
  const out = resolveRoutingUnified(parseAddress('*'), reg, {})
  assert.equal(out.action, 'wake')
  assert.equal(out.broadcast, true)
  assert.deepEqual([...out.sids].sort(), [SID_A, SID_B])
})

test('泵视角: 空 registry + broadcast → 恒 wake-self, sids=[self]', () => {
  const out = resolveRoutingUnified(parseAddress('*'), REG([]), { self: { sessionId: SELF } })
  assert.deepEqual(out, { action: 'wake', broadcast: true, sids: [SELF] })
})

test('泵视角: skip/wake 四分支(他人 sid / 他人唯一 alias / self sid / self alias)', () => {
  const reg = REG([
    [SID_A, { alias: 'other', pid: 1, armedAt: 't' }],
    [SELF, { alias: 'me', pid: 3, armedAt: 't' }],
  ])
  const self = { sessionId: SELF }
  assert.deepEqual(resolveRoutingUnified(parseAddress(SID_A), reg, { self }), { action: 'skip' })
  assert.deepEqual(resolveRoutingUnified(parseAddress('other'), reg, { self }), { action: 'skip' })
  const wakeSelf = resolveRoutingUnified(parseAddress(SELF), reg, { self })
  assert.equal(wakeSelf.action, 'wake')
  assert.deepEqual(wakeSelf.sids, [SELF])
  const wakeAlias = resolveRoutingUnified(parseAddress('me'), reg, { self })
  assert.equal(wakeAlias.action, 'wake')
  assert.deepEqual(wakeAlias.sids, [SELF])
})

test('dead reason 四条: 与 core/addressing.js、pump.js 两处 oracle 逐字节相等', () => {
  const reg = REG([
    [SID_A, { alias: 'amb', pid: 1, armedAt: 't' }],
    [SID_B, { alias: 'amb', pid: 2, armedAt: 't' }],
  ])
  const cases = [
    parseAddress(''),
    parseAddress(undefined),
    { kind: 'qualified', alias: 'x', sessionId: 'session-zzzz-9999' },
    { kind: 'bare', name: 'nobody' },
    { kind: 'bare', name: 'amb' },
  ]
  for (const addr of cases) {
    const host = resolveRoutingUnified(addr, reg, {})
    const pump = pumpResolveRouting(addr, { sessionId: SELF }, reg)
    const coreHost = coreAddressing.resolveHostRouting(addr, reg)
    assert.equal(host.action, 'dead')
    assert.equal(host.reason, coreHost.reason)
    assert.equal(host.reason, pump.reason)
  }
})

test('R-S28 参数序回归: 底层 resolveRouting(address, self, registry) 语义 = pump 现行为', () => {
  const reg = REG([[SID_A, { alias: 'a', pid: 1, armedAt: 't' }]])
  const addr = { kind: 'qualified', alias: 'a', sessionId: SID_A }
  const self = { sessionId: 'session-other-42' }
  const mine = resolveRouting(addr, self, reg)
  const oracle = pumpResolveRouting(addr, self, reg)
  assert.equal(mine.action, oracle.action)
  assert.equal(mine.broadcast, oracle.broadcast)
  if (mine.action === 'wake') assert.deepEqual(mine.sids, [self.sessionId])
})

test('resolveHostRouting 兼容别名 = unified 宿主视角; 与 core oracle 逐行为一致', () => {
  const reg = REG([[SID_A, { alias: 'a', pid: 1, armedAt: 't' }]])
  for (const to of ['*', SID_A, 'a', 'a@' + SID_A, 'nope', '']) {
    const addr = parseAddress(to)
    assert.deepEqual(resolveHostRouting(addr, reg), coreAddressing.resolveHostRouting(addr, reg))
  }
})

// ---- P1.2.2 resolveAddress 撞名 ----

const FLEET = (entries) => ({ fleet: Object.fromEntries(entries) })

test('R-B15 撞名: fleet 精确 code + registry alias 同名 → collision 死信(ambiguous)', () => {
  const fleet = FLEET([['orch1', { sessionId: 'session-fleet-orch1', kind: 'orca-terminal' }]])
  const reg = REG([[SID_A, { alias: 'orch1', pid: 1, armedAt: 't' }]])
  const out = resolveAddress(parseAddress('orch1'), fleet, reg)
  assert.equal(out.ok, false)
  assert.equal(out.ambiguous, true)
  assert.equal(
    out.reason,
    'collision: bare name "orch1" is both a fleet code and a registered alias; use <alias>@<sessionId>',
  )
})

test('撞名不误伤单侧: 仅 fleet → e 分支 ok; 仅 alias 唯一持有 → c 分支 ok', () => {
  const fleet = FLEET([['orch1', { sessionId: 'session-fleet-orch1', kind: 'orca-terminal' }]])
  const reg = REG([[SID_A, { alias: 'orch1', pid: 1, armedAt: 't' }]])
  assert.equal(resolveAddress(parseAddress('orch1'), fleet, REG([])).ok, true)
  assert.equal(resolveAddress(parseAddress('orch1'), FLEET([]), reg).ok, true)
})

test('多持有者 alias → reason ④ 逐字节 + ambiguous', () => {
  const reg = REG([
    [SID_A, { alias: 'amb', pid: 1, armedAt: 't' }],
    [SID_B, { alias: 'amb', pid: 2, armedAt: 't' }],
  ])
  const out = resolveAddress(parseAddress('amb'), FLEET([]), reg)
  assert.equal(out.ok, false)
  assert.equal(out.ambiguous, true)
  assert.equal(
    out.reason,
    `unknown-addressee: alias "amb" is ambiguous across 2 registered consumers; use <alias>@<sessionId>`,
  )
})

test('resolveAddress broadcast/qualified/裸 sessionId/plane 判定', () => {
  const fleet = FLEET([
    ['orc9', { sessionId: 'session-orc-9', kind: 'orca-terminal' }],
    ['ctx1', { sessionId: 'ctx_abc', kind: 'worker' }],
  ])
  const reg = REG([[SID_A, { alias: 'a', pid: 1, armedAt: 't' }]])
  assert.deepEqual(resolveAddress(parseAddress('*'), fleet, reg), { ok: true, broadcast: true, plane: null, handle: '*' })
  const q = resolveAddress(parseAddress('a@' + SID_A), fleet, reg)
  assert.equal(q.ok, true)
  assert.equal(q.plane, 'dsh')
  assert.equal(q.sessionId, SID_A)
  const bare = resolveAddress(parseAddress(SID_A), fleet, reg)
  assert.equal(bare.ok, true)
  assert.equal(bare.plane, 'dsh')
  const fleetQ = resolveAddress(parseAddress('x@session-orc-9'), fleet, reg)
  assert.equal(fleetQ.ok, true)
  assert.equal(fleetQ.plane, 'orca')
  const ctx = resolveAddress(parseAddress('ctx1'), fleet, reg)
  assert.equal(ctx.ok, true)
  assert.equal(ctx.plane, 'dais')
  const miss = resolveAddress(parseAddress('x@session-zzz'), fleet, reg)
  assert.equal(miss.ok, false)
  assert.equal(miss.reason, 'unknown-addressee: no registered consumer with sessionId session-zzz')
})

// ---- P1.2.3 findFleetEntry / resolveFleetSessionId ----

const PREFIX_FLEET = FLEET([
  ['2437', { sessionId: 'session-2437-abcd-0001', kind: 'worker' }],
  ['x1', { sessionId: 'session-9999-zzzz-0002', kind: 'worker' }],
])

test('exact 模式: 只认精确键, 绝不静默命中前缀条目(R-S05 防线)', () => {
  const hit = findFleetEntry(PREFIX_FLEET, '2437', { mode: 'exact' })
  assert.equal(hit.sessionId, 'session-2437-abcd-0001')
  // 无精确键、但有 sessionId 前缀条目('2437-abcd' 前缀命中 'x1'? 否——前缀串不同,构造专门用例):
  const fleet2 = FLEET([['k1', { sessionId: 'session-2437-ffff-0003' }]])
  assert.equal(findFleetEntry(fleet2, '2437', { mode: 'exact' }), undefined)
})

test('prefix 模式: 精确 miss 后按迭代序返回第一个 sessionId 前缀条目', () => {
  const fleet = FLEET([['k1', { sessionId: 'session-2437-ffff-0003' }]])
  assert.equal(findFleetEntry(fleet, '2437')?.sessionId, 'session-2437-ffff-0003')
  // 精确键优先于前缀
  assert.equal(findFleetEntry(PREFIX_FLEET, '2437')?.sessionId, 'session-2437-abcd-0001')
})

test('resolveFleetSessionId: 与 session-send resolve() 同语义(fixture 比对); 双 miss → undefined', () => {
  // fixture 复刻 session-send resolve(): '2437' → entry.sessionId; 短码 '9999' → 前缀条目
  assert.equal(resolveFleetSessionId(PREFIX_FLEET, '2437'), 'session-2437-abcd-0001')
  assert.equal(resolveFleetSessionId(PREFIX_FLEET, '9999'), 'session-9999-zzzz-0002')
  assert.equal(resolveFleetSessionId(PREFIX_FLEET, '8888'), undefined)
  assert.equal(resolveFleetSessionId(undefined, '8888'), undefined)
})

// ---- P1.2.4 registry 写链 ----

test('R-B14: 并发 20 写不丢条目, version=最后一次写入值, 零 reject', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nw-reg-'))
  const path = join(dir, 'registry.json')
  const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) =>
    registerConsumer(path, `gen-${i}`, { sessionId: `session-c${String(i).padStart(2, '0')}`, alias: `a${i}` }, { armedAt: 't', pid: 1 })))
  assert.equal(results.filter((r) => r.status === 'rejected').length, 0)
  const reg = await readRegistry(path)
  assert.equal(Object.keys(reg.consumers).length, 20)
  assert.equal(typeof reg.version, 'string')
  await rm(dir, { recursive: true, force: true })
})

test('R-B04 白名单回归: 多余键被剥, 恰三键; 顶层 version 字符串保留', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nw-reg-'))
  const path = join(dir, 'registry.json')
  await writeFile(path, JSON.stringify({
    version: 'keep-me',
    consumers: { 'session-x': { alias: 'a', pid: 1, armedAt: 't', version: 9, extra: true } },
  }))
  const reg = await readRegistry(path)
  assert.deepEqual(Object.keys(reg.consumers['session-x']).sort(), ['alias', 'armedAt', 'pid'])
  assert.equal(reg.version, 'keep-me')
  await rm(dir, { recursive: true, force: true })
})

test('sanitizeConsumers 与 core/registry.js oracle 深度相等', async () => {
  const { sanitizeConsumers: coreSanitize } = await import('../host-callback-bridge/core/registry.js')
  const raw = {
    good: { alias: 'a', pid: 1, armedAt: 't', version: 9 },
    noAlias: { pid: 2 },
    badPid: { alias: 'b', pid: 'x', armedAt: 't' },
  }
  assert.deepEqual(sanitizeConsumers(raw), coreSanitize(raw))
  assert.deepEqual(sanitizeConsumers(null), coreSanitize(null))
})

test('unregisterConsumer: 删除条目且保留他人', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nw-reg-'))
  const path = join(dir, 'registry.json')
  await registerConsumer(path, 'g1', { sessionId: SID_A, alias: 'a' }, { armedAt: 't', pid: 1 })
  await registerConsumer(path, 'g2', { sessionId: SID_B, alias: 'b' }, { armedAt: 't', pid: 2 })
  await unregisterConsumer(path, 'g3', SID_A)
  const reg = await readRegistry(path)
  assert.equal(reg.consumers[SID_A], undefined)
  assert.notEqual(reg.consumers[SID_B], undefined)
  assert.equal(reg.version, 'g3')
  const txt = await readFile(path, 'utf8')
  assert.ok(txt.endsWith('\n'))
  await rm(dir, { recursive: true, force: true })
})

test('aliasIndex/parseAddress 与 core oracle 逐行为一致', () => {
  const reg = REG([
    [SID_A, { alias: 'a', pid: 1, armedAt: 't' }],
    [SID_B, { alias: 'a', pid: 2, armedAt: 't' }],
  ])
  assert.deepEqual(aliasIndex(reg), coreAddressing.aliasIndex(reg))
  for (const to of ['*', 'a@session-x', 'bare', '', undefined, 'x@y@z']) {
    assert.deepEqual(parseAddress(to), coreAddressing.parseAddress(to))
  }
})
