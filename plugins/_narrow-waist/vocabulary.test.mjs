import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SIGNALS, DAIS_TYPE_MAP, DSH_TYPE_MAP, ORCA_TYPE_MAP,
  normalizeType, denormalizeType, DSH_CALLBACK_TYPES, DSH_INTAKE_TYPES,
} from './vocabulary.js'
// 只读 oracle: 两插件现网 TYPES 常量
import { TYPES as MSGBR_TYPES } from '../message-bridge/index.js'
import { TYPES as INTAKE_TYPES } from '../host-callback-bridge/http-intake.js'

// §G.3 终表(fix-spec G 节)18 Signal 逐条清单
const G_TERMINAL_TABLE = new Set([
  'done', 'worker_done', 'heartbeat', 'escalation', 'status', 'report',
  'dispatch', 'question', 'handoff', 'decision_gate', 'merge_ready', 'notify',
  'ping', 'pong', 'ack', 'nack', 'ask', 'steer',
])

test('18 Signal 与 §G 节终表逐条一致', () => {
  assert.equal(SIGNALS.length, 18)
  assert.deepEqual(new Set(SIGNALS), G_TERMINAL_TABLE)
})

test('normalizeType: 已知值 → {signal, source}', () => {
  for (const s of SIGNALS) {
    assert.deepEqual(normalizeType(s), { signal: s, source: s })
  }
})

test('normalizeType: 未知非空字符串透传打标(不抛不猜)', () => {
  assert.deepEqual(normalizeType('donee'), { signal: null, source: 'donee' })
  assert.deepEqual(normalizeType('Status'), { signal: null, source: 'Status' })
})

test('normalizeType: 空串/非字符串 → {signal:null, source:null}', () => {
  assert.deepEqual(normalizeType(''), { signal: null, source: null })
  assert.deepEqual(normalizeType(undefined), { signal: null, source: null })
  assert.deepEqual(normalizeType(123), { signal: null, source: null })
})

test('存量值直通(R-S06): direct → null 打标', () => {
  assert.deepEqual(normalizeType('direct'), { signal: null, source: 'direct' })
  assert.equal(DAIS_TYPE_MAP.direct, null)
})

test('存量值直通: report 按 G 终表映射', () => {
  const n = normalizeType('report')
  assert.equal(n.signal, 'report')
  assert.equal(denormalizeType('report', 'dsh'), 'report')
})

test('存量值直通: status → status', () => {
  assert.equal(normalizeType('status').signal, 'status')
  assert.equal(denormalizeType('status', 'dsh'), 'status')
  assert.equal(denormalizeType('status', 'dais'), 'status')
})

test("denormalizeType('dais') 对全部 18 Signal: ∈ 9 值枚举 ∪ {null} 且永不为 'direct'", () => {
  const daisEnum = new Set(['worker_done', 'heartbeat', 'escalation', 'status', 'dispatch',
    'question', 'handoff', 'decision_gate', 'merge_ready'])
  for (const s of SIGNALS) {
    const out = denormalizeType(s, 'dais')
    assert.notEqual(out, 'direct', `signal=${s}`)
    if (out !== null) assert.ok(daisEnum.has(out), `signal=${s} out=${out}`)
  }
  assert.equal(denormalizeType('done', 'dais'), null)
})

test('白名单常量 oracle: DSH_CALLBACK_TYPES == message-bridge TYPES; DSH_INTAKE_TYPES == http-intake TYPES', () => {
  assert.deepEqual([...DSH_CALLBACK_TYPES], [...MSGBR_TYPES])
  assert.deepEqual([...DSH_INTAKE_TYPES], [...INTAKE_TYPES])
})

test('两常量 Object.isFrozen', () => {
  assert.ok(Object.isFrozen(DSH_CALLBACK_TYPES))
  assert.ok(Object.isFrozen(DSH_INTAKE_TYPES))
})

test('映射表形状: 三平面 frozen; DSH 面 10 值; Orca 面 8 值', () => {
  assert.ok(Object.isFrozen(DAIS_TYPE_MAP) && Object.isFrozen(DSH_TYPE_MAP) && Object.isFrozen(ORCA_TYPE_MAP))
  assert.equal(Object.keys(DSH_TYPE_MAP).length, 10)
  assert.equal(Object.keys(ORCA_TYPE_MAP).length, 8)
  assert.equal(denormalizeType('ping', 'orca'), null)
  assert.equal(denormalizeType('done', 'bogus-plane'), null)
})
