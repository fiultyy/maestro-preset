import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  forgeMsgid, digestOf, dedupKeys, createDedupWindow, seenAny, markAll,
} from './dedup.js'
// 只读 oracle: 生产 core/dedup.js(不写其目录)
import { digestOf as coreDigestOf } from '../host-callback-bridge/core/dedup.js'

test('digest 与 msgid 无关(body 键稳定)', () => {
  const line = JSON.stringify({ from: 'a', body: 'x' })
  assert.equal(
    digestOf(line, { from: 'a', body: 'x' }),
    digestOf(line, { from: 'a', body: 'x', msgid: 'm1' }),
  )
})

test('dedupKeys: 4 键行无 msgidKey; v3 行 msgidKey 形状', () => {
  const line4 = JSON.stringify({ type: 'ack', from: 'a', to: 'b', body: 'x' })
  const p4 = JSON.parse(line4)
  assert.equal(dedupKeys(line4, p4).msgidKey, undefined)
  const lineV3 = JSON.stringify({ type: 'ack', from: 'a', to: 'b', body: 'x', msgid: 'mm', ts: 1, ver: 3, via: '', ttl: 5 })
  const p3 = JSON.parse(lineV3)
  assert.equal(dedupKeys(lineV3, p3).msgidKey, 'm\0a\0mm')
})

test('R-B16: 同 from 不同 body 的 4 键行, 60s 窗内零误判重', () => {
  const win = createDedupWindow({ now: () => 1000 })
  const l1 = JSON.stringify({ type: 'ack', from: 'a', to: 'b', body: 'one' })
  const l2 = JSON.stringify({ type: 'ack', from: 'a', to: 'b', body: 'two' })
  const k1 = dedupKeys(l1, JSON.parse(l1))
  const k2 = dedupKeys(l2, JSON.parse(l2))
  markAll(win, k1)
  assert.equal(seenAny(win, k2), undefined)
})

test('R-B03 四向重放: ①v3→同v3 ②v3→4键 ③4键→同4键 ④4键→新msgid v3 全命中', () => {
  // ①
  {
    const win = createDedupWindow({ now: () => 1000 })
    const l = JSON.stringify({ type: 'ack', from: 'a', to: 'b', body: 'x', msgid: 'm1', ts: 1, ver: 3, via: '', ttl: 5 })
    markAll(win, dedupKeys(l, JSON.parse(l)))
    assert.notEqual(seenAny(win, dedupKeys(l, JSON.parse(l))), undefined)
  }
  // ② v3 投 → 同内容 4 键重发(无 msgid): digest 命中
  {
    const win = createDedupWindow({ now: () => 1000 })
    const lv = JSON.stringify({ type: 'ack', from: 'a', to: 'b', body: 'x', msgid: 'm1', ts: 1, ver: 3, via: '', ttl: 5 })
    markAll(win, dedupKeys(lv, JSON.parse(lv)))
    const l4 = JSON.stringify({ type: 'ack', from: 'a', to: 'b', body: 'x' })
    assert.notEqual(seenAny(win, dedupKeys(l4, JSON.parse(l4))), undefined)
  }
  // ③ 4 键投 → 同 4 键重发
  {
    const win = createDedupWindow({ now: () => 1000 })
    const l4 = JSON.stringify({ type: 'ack', from: 'a', to: 'b', body: 'x' })
    markAll(win, dedupKeys(l4, JSON.parse(l4)))
    assert.notEqual(seenAny(win, dedupKeys(l4, JSON.parse(l4))), undefined)
  }
  // ④ 4 键投 → 同内容 v3 重发(新 uuid msgid): digest 命中
  {
    const win = createDedupWindow({ now: () => 1000 })
    const l4 = JSON.stringify({ type: 'ack', from: 'a', to: 'b', body: 'x' })
    markAll(win, dedupKeys(l4, JSON.parse(l4)))
    const lv = JSON.stringify({ type: 'ack', from: 'a', to: 'b', body: 'x', msgid: forgeMsgid(), ts: 1, ver: 3, via: '', ttl: 5 })
    assert.notEqual(seenAny(win, dedupKeys(lv, JSON.parse(lv))), undefined)
  }
})

test('from 缺失整行回退: digestOf === sha256(line), 与 core oracle 逐字节', () => {
  const line = JSON.stringify({ body: 'x' })
  const expected = createHash('sha256').update(line).digest('hex')
  assert.equal(digestOf(line, { body: 'x' }), expected)
  assert.equal(digestOf(line, { body: 'x' }), coreDigestOf(line, { body: 'x' }))
})

test('digestOf 对 core/dedup.js oracle 逐字节相等(多组输入)', () => {
  const cases = [
    ['{"from":"a","body":"x"}', { from: 'a', body: 'x' }],
    ['{"from":"a"}', { from: 'a' }],
    ['{"body":"x"}', { body: 'x' }],
    ['{}', {}],
    ['{"from":"a","body":"x","msgid":"m"}', { from: 'a', body: 'x', msgid: 'm' }],
  ]
  for (const [line, parsed] of cases) {
    assert.equal(digestOf(line, parsed), coreDigestOf(line, parsed))
  }
})

test('meta 通道: mark(k,"id-1") → seen 返回 {deliveredAt, meta}(208 回放 prior.id)', () => {
  const win = createDedupWindow({ now: () => 1000 })
  win.mark('k', 'id-1')
  const hit = win.seen('k')
  assert.equal(typeof hit.deliveredAt, 'number')
  assert.equal(hit.meta, 'id-1')
})

test('mark 不传 meta → meta === null', () => {
  const win = createDedupWindow({ now: () => 1000 })
  win.mark('k2')
  assert.equal(win.seen('k2').meta, null)
})

test('seen 不隐式 mark: miss 后 size 不变; 命中不刷新 deliveredAt', () => {
  let t = 1000
  const win = createDedupWindow({ now: () => t })
  win.mark('k', 'm')
  win.seen('missing')
  assert.equal(win.size, 1)
  t = 2000
  const hit = win.seen('k')
  assert.notEqual(hit, undefined)
  assert.equal(hit.deliveredAt, 1000)
})

test('markAll 双记: 同一 meta 两键可查, 窗口 size=2', () => {
  const win = createDedupWindow({ now: () => 1000 })
  const line = JSON.stringify({ type: 'ack', from: 'a', to: 'b', body: 'x', msgid: 'm1' })
  const keys = dedupKeys(line, JSON.parse(line))
  assert.notEqual(keys.msgidKey, undefined)
  markAll(win, keys, 'rid-9')
  assert.equal(win.size, 2)
  assert.equal(win.seen(keys.msgidKey).meta, 'rid-9')
  assert.equal(win.seen(keys.digest).meta, 'rid-9')
})

test('windowMs 缺省 60_000: 假 clock 59s 命中 / 61s 过期剪枝', () => {
  let t = 0
  const win = createDedupWindow({ now: () => t })
  win.mark('k')
  t = 59_000
  assert.notEqual(win.seen('k'), undefined)
  t = 61_000
  win.prune()
  assert.equal(win.seen('k'), undefined)
})

test('显式 windowMs 覆盖缺省', () => {
  let t = 0
  const win = createDedupWindow({ windowMs: 1000, now: () => t })
  win.mark('k')
  t = 1500
  assert.equal(win.seen('k'), undefined)
})

test('forgeMsgid: uuid4 同构(唯一性冒烟)', () => {
  const set = new Set(Array.from({ length: 200 }, () => forgeMsgid()))
  assert.equal(set.size, 200)
  for (const id of set) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})
