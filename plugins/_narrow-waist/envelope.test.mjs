import test from 'node:test'
import assert from 'node:assert/strict'
import {
  LINE_PREFIX, ENVELOPE_VERSION, V2_TYPES,
  createEnvelope, validateEnvelope, serializeLine, parseLine,
  detectVersion, upgradeV2toV3, downgradeV3toV2,
} from './envelope.js'

const V2_SAMPLE = {
  from: 'a@session-1111', to: 'session-2222', type: 'ack', ref: 'r1',
  body: 'hello', msgid: 'm-uuid-1', ts: 1750000000000,
}

test('detectVersion: ver===3 → 3', () => {
  assert.equal(detectVersion({ ...V2_SAMPLE, ver: 3 }), 3)
})

test('detectVersion: 有 msgid 无 ver → 2', () => {
  assert.equal(detectVersion(V2_SAMPLE), 2)
})

test("detectVersion: 四基键裸行 → 'legacy4'", () => {
  assert.equal(detectVersion({ type: 'ack', from: 'a@x', to: 'b', body: '[ref:r1] hi' }), 'legacy4')
})

test('detectVersion: 残件 → null', () => {
  assert.equal(detectVersion({ type: 'ack', from: 'a' }), null)
  assert.equal(detectVersion('not an object'), null)
  assert.equal(detectVersion(null), null)
})

test('parseLine: DSHMSG] 前缀 v2 七键 → rawVersion 2, ref=value.ref, 七键原样', () => {
  const line = LINE_PREFIX + JSON.stringify(V2_SAMPLE)
  const out = parseLine(line)
  assert.equal(out.ok, true)
  assert.equal(out.rawVersion, 2)
  assert.equal(out.ref, 'r1')
  assert.deepEqual(out.value, V2_SAMPLE)
  assert.equal(Object.keys(out.value).length, 7)
})

test("parseLine: 裸 4 键行 → rawVersion 'legacy4', ref 从 body '[ref:' 提取, 键数不变", () => {
  const raw = JSON.stringify({ type: 'ack', from: 'a@x', to: 'b', body: '[ref:r1] hi' })
  const out = parseLine(raw)
  assert.equal(out.ok, true)
  assert.equal(out.rawVersion, 'legacy4')
  assert.equal(out.ref, 'r1')
  assert.equal(Object.keys(out.value).length, 4)
  assert.deepEqual(out.value, JSON.parse(raw))
})

test('parseLine: 非 JSON → {ok:false}', () => {
  assert.deepEqual(parseLine('not json'), { ok: false })
  assert.equal(parseLine(LINE_PREFIX + 'not json').ok, false)
})

test('round-trip 幂等: createEnvelope→serializeLine→parseLine→serializeLine 二次相等', () => {
  const env = createEnvelope({ from: 'a', to: 'b', type: 'ack', ref: 'r1', body: 'hi', msgid: 'm1', ts: 123, via: 'x', ttl: 5 })
  const l1 = serializeLine(env)
  const parsed = parseLine(l1)
  assert.equal(parsed.rawVersion, 3)
  const l2 = serializeLine(parsed.value)
  assert.equal(l1, l2)
})

test('createEnvelope 键序 = v2 七键原序 + ver/via/ttl 尾部', () => {
  const env = createEnvelope({ from: 'a', to: 'b', type: 'ack', ref: 'r', body: 'x', msgid: 'm', ts: 9 })
  assert.deepEqual(
    Object.keys(env),
    ['from', 'to', 'type', 'ref', 'body', 'msgid', 'ts', 'ver', 'via', 'ttl'],
  )
  assert.equal(env.ver, ENVELOPE_VERSION)
  assert.equal(env.ttl, 5)
})

test('upgradeV2toV3: 原字段与键序不动, 新三键尾部追加', () => {
  const up = upgradeV2toV3(V2_SAMPLE, 'adapter-1')
  assert.deepEqual(
    Object.keys(up),
    ['from', 'to', 'type', 'ref', 'body', 'msgid', 'ts', 'ver', 'via', 'ttl'],
  )
  for (const [k, v] of Object.entries(V2_SAMPLE)) assert.equal(up[k], v)
  assert.equal(up.ver, 3)
  assert.equal(up.via, 'adapter-1')
  assert.equal(up.ttl, 5)
})

test('upgradeV2toV3: 已有键不覆写(幂等)', () => {
  const once = upgradeV2toV3(V2_SAMPLE, 'a1')
  const twice = upgradeV2toV3(once, 'a2')
  assert.equal(twice.via, 'a1')
  assert.equal(twice.ttl, 5)
})

test('validateEnvelope: 闭集外 type 字符串放行, 未知键不拒', () => {
  const out = validateEnvelope({ type: 'Status', from: 'a', to: 'b', ver7: 'unknown-key' })
  assert.equal(out.ok, true)
})

test('validateEnvelope: 空串 type → errors 非空', () => {
  const out = validateEnvelope({ type: '', from: 'a', to: 'b' })
  assert.equal(out.ok, false)
  assert.ok(out.errors.length > 0)
})

test('downgradeV3toV2: 剥三键 → 7 键(测试辅助,非生产 API)', () => {
  const env = createEnvelope({ from: 'a', to: 'b', type: 'ack', ref: 'r', body: 'x', msgid: 'm', ts: 9, via: 'v', ttl: 5 })
  const down = downgradeV3toV2(env)
  assert.deepEqual(Object.keys(down), ['from', 'to', 'type', 'ref', 'body', 'msgid', 'ts'])
})

test('V2_TYPES 七值逐字(session-send:6)', () => {
  assert.deepEqual([...V2_TYPES], ['ping', 'pong', 'done', 'ask', 'steer', 'nack', 'ack'])
})
