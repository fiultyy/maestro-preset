/**
 * pump v3.5 单测（node:test）。
 *
 * 全部使用 mkdtemp 自建临时目录模拟 inbox/.cursor.<sid>/dead.log/echo.log/
 * state.json/registry.json，绝不触碰 ~/.dsh/maestro/bridge 生产文件，也绝不读取
 * MAESTRO_BRIDGE 等环境变量（2026-08-15 事故根因之一即 headless 冒烟误指生产桥）。
 * makeBridge 内有 os.tmpdir() 前缀断言作为红线守卫。运行：
 *   node --test plugins/orca-callback/pump.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, appendFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  version,
  createPump,
  parseAddress,
  ECHO_PREFIX,
  MAX_WAKE_FAILURES,
  ROTATE_MAX_LINES,
  ROTATE_MAX_BYTES,
  DEDUP_WINDOW_MS,
} from './pump.js'

// 两个稳定的假消费者身份（模拟事故中"两个 host 上的同名/异名编排 main"）。
const S_A = 'session-aaaa-1111'
const S_B = 'session-bbbb-2222'

const bridgeDirs = []
async function makeBridge() {
  const dir = await mkdtemp(join(tmpdir(), 'pump-v35-'))
  await mkdir(dir, { recursive: true })
  // 红线守卫：测试桥目录必须位于系统 tmp 下（绝不指向生产桥）。
  assert.ok(dir.startsWith(tmpdir()), `test bridge dir must live under os.tmpdir(): ${dir}`)
  bridgeDirs.push(dir)
  return dir
}

// 会话内自清理：整个测试文件结束后移除全部临时目录。
test.after?.(() => { void Promise.all(bridgeDirs.map((dir) => rm(dir, { recursive: true, force: true }))) })

const appendInbox = (dir, lines) =>
  appendFile(join(dir, 'inbox.log'), `${lines.map((line) => `${line}\n`).join('')}`)

const readMaybe = async (path) => {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

const readLines = async (path) => {
  const txt = await readMaybe(path)
  return txt === null || txt.length === 0 ? [] : txt.replace(/\n$/, '').split('\n')
}

const cursorOf = async (dir, sid) => (await readFile(join(dir, `.cursor.${sid}`), 'utf8')).trim()

const bodyOf = (line) => JSON.parse(line).body

const readState = async (dir) => JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
const readRegistry = async (dir) => JSON.parse(await readFile(join(dir, 'registry.json'), 'utf8'))

/** 收集型 wake：把投递到的行推进 delivered；throwWhen(line) 返回 true 时抛错。 */
function collectorWake(delivered, throwWhen = () => false) {
  return (line) => {
    if (throwWhen(line)) throw new Error('synthetic wake failure')
    delivered.push(line)
  }
}

/** 常规消费者泵：大 retryDelay（不依赖定时器，手工 flush）。 */
const mkPump = (dir, delivered, consumer, extra = {}) =>
  createPump({ bridgeDir: dir, wake: collectorWake(delivered), consumer, retryDelayMs: 60_000, ...extra })

// ---------------------------------------------------------------- v3.5 指纹与寻址

test('exports the v3.5 version fingerprint; parseAddress classifies all addressing forms', () => {
  assert.equal(version, '3.6.0')
  assert.equal(ECHO_PREFIX, 'DSH-RE]')
  assert.equal(MAX_WAKE_FAILURES, 3)
  assert.equal(ROTATE_MAX_LINES, 1000)
  assert.equal(ROTATE_MAX_BYTES, 1024 * 1024)
  assert.equal(DEDUP_WINDOW_MS, 60_000)
  assert.deepEqual(parseAddress('*'), { kind: 'broadcast' })
  assert.deepEqual(parseAddress(`编排1@${S_A}`), { kind: 'qualified', alias: '编排1', sessionId: S_A })
  assert.deepEqual(parseAddress('weird@alias@session-x'), { kind: 'qualified', alias: 'weird@alias', sessionId: 'session-x' })
  assert.deepEqual(parseAddress(S_A), { kind: 'bare', name: S_A })
  assert.deepEqual(parseAddress('编排1'), { kind: 'bare', name: '编排1' })
  assert.deepEqual(parseAddress(''), { kind: 'invalid' })
  assert.deepEqual(parseAddress(undefined), { kind: 'invalid' })
  assert.deepEqual(parseAddress(42), { kind: 'invalid' })
  assert.deepEqual(parseAddress(null), { kind: 'invalid' })
})

test('createPump requires an explicit consumer identity in v3.5', () => {
  const dir = '/nonexistent-bridge-dir-irrelevant'
  const wake = () => {}
  assert.throws(() => createPump({ bridgeDir: dir, wake }), TypeError)
  assert.throws(() => createPump({ bridgeDir: dir, wake, consumer: {} }), TypeError)
  assert.throws(() => createPump({ bridgeDir: dir, wake, consumer: { sessionId: '' } }), TypeError)
  assert.throws(() => createPump({ bridgeDir: dir, wake, consumer: { sessionId: S_A, alias: 7 } }), TypeError)
})

// ---------------------------------------------------------------- v3.4 语义（带寻址字段重放）

test('delivers rows addressed to self in order; per-consumer cursor file, state section and registry entry', async () => {
  const dir = await makeBridge()
  const delivered = []
  const pump = mkPump(dir, delivered, { sessionId: S_A, alias: '编排1' })
  await appendInbox(dir, [
    `{"type":"ping","from":"a@x","to":"编排1@${S_A}","body":"one"}`,
    `{"type":"done","from":"b@x","to":"${S_A}","body":"two"}`,
  ])
  await pump.flush()
  assert.deepEqual(delivered.map(bodyOf), ['one', 'two'])
  assert.equal(await cursorOf(dir, S_A), '2')

  const state = await readState(dir)
  assert.equal(state.version, '3.6.0')
  assert.equal(state.consumers[S_A].deliveredCount, 2)
  assert.equal(state.consumers[S_A].alias, '编排1')
  assert.ok(state.consumers[S_A].lastDeliveredAt)
  assert.equal(state.consumers[S_A].senders['a@x'].deliveredCount, 1)
  assert.equal(state.consumers[S_A].senders['b@x'].deliveredCount, 1)

  const registry = await readRegistry(dir)
  assert.equal(registry.consumers[S_A].alias, '编排1')
  assert.equal(registry.consumers[S_A].pid, process.pid)
  assert.ok(!Number.isNaN(Date.parse(registry.consumers[S_A].armedAt)))
})

test('echo lines (DSH-RE]) are skipped, never woken, and archived to echo.log', async () => {
  const dir = await makeBridge()
  const delivered = []
  const pump = mkPump(dir, delivered, { sessionId: S_A })
  await appendInbox(dir, [
    `{"type":"ping","from":"a@x","to":"${S_A}","body":"before"}`,
    `${ECHO_PREFIX} {"type":"ack","from":"编排1@${S_A}","body":"signed-ack-echo"}`,
    `{"type":"done","from":"a@x","to":"${S_A}","body":"after"}`,
  ])
  await pump.flush()
  assert.equal(delivered.length, 2)
  assert.ok(!delivered.some((line) => line.startsWith(ECHO_PREFIX)))
  const echo = await readLines(join(dir, 'echo.log'))
  assert.deepEqual(echo, [`${ECHO_PREFIX} {"type":"ack","from":"编排1@${S_A}","body":"signed-ack-echo"}`])
  assert.equal(await cursorOf(dir, S_A), '3')
  const state = await readState(dir)
  assert.equal(state.consumers[S_A].echoCount, 1)
  assert.equal(state.consumers[S_A].deliveredCount, 2)
  assert.equal((await readLines(join(dir, 'dead.log'))).length, 0)
})

test('malformed rows dead-letter exactly once even when two consumers scan them (undertaker dedup)', async () => {
  const dir = await makeBridge()
  const deliveredA = []
  const deliveredB = []
  const a = mkPump(dir, deliveredA, { sessionId: S_A, alias: '编排1' })
  await a.flush() // A 先注册 → armedAt 最早 → 行内在终态由 A 唯一落笔
  const b = mkPump(dir, deliveredB, { sessionId: S_B, alias: '编排2' })
  await appendInbox(dir, [
    'this is not json at all {{{',
    `{"type":"ping","from":"a@x","to":"${S_A}","body":"still flows"}`,
  ])
  await a.flush()
  await b.flush()
  assert.deepEqual(deliveredA.map(bodyOf), ['still flows'])
  assert.deepEqual(deliveredB, [])
  const dead = await readLines(join(dir, 'dead.log'))
  assert.equal(dead.length, 1)
  const entry = JSON.parse(dead[0])
  assert.equal(entry.line, 'this is not json at all {{{')
  assert.match(entry.reason, /malformed/)
  assert.ok(!Number.isNaN(Date.parse(entry.at)))
  assert.equal(await cursorOf(dir, S_A), '2')
  assert.equal(await cursorOf(dir, S_B), '2')
  const state = await readState(dir)
  assert.equal(state.consumers[S_A].deadCount, 1)
  assert.equal(state.consumers[S_B].deadCount, 0)
})

test('wake failures stall only the failing consumer; 3 consecutive strikes dead-letter and unblock', async () => {
  const dir = await makeBridge()
  const deliveredA = []
  const deliveredB = []
  const badLine = `{"type":"done","from":"flaky@x","to":"${S_A}","body":"fails to enqueue"}`
  let attempts = 0
  const wakeA = (line) => {
    if (line === badLine) {
      attempts += 1
      throw new Error('agent refused the turn')
    }
    deliveredA.push(line)
  }
  const a = createPump({ bridgeDir: dir, wake: wakeA, consumer: { sessionId: S_A }, retryDelayMs: 60_000 })
  const b = mkPump(dir, deliveredB, { sessionId: S_B })
  await appendInbox(dir, [
    `{"type":"ping","from":"ok@x","to":"${S_A}","body":"first"}`,
    badLine,
    `{"type":"ping","from":"ok@x","to":"${S_B}","body":"for-b"}`,
  ])
  await a.flush()
  assert.equal(attempts, 1)
  assert.deepEqual(deliveredA.map(bodyOf), ['first'])
  assert.equal(await cursorOf(dir, S_A), '1')

  // B 不被 A 的卡行阻塞：越过前两行（非本消费者），属于自己的行照常到达。
  await b.flush()
  assert.deepEqual(deliveredB.map(bodyOf), ['for-b'])
  assert.equal(await cursorOf(dir, S_B), '3')

  // A 的第 2、3 次重试仍失败 → 死信并推进，游标越过 badLine 与其后所有行。
  await a.flush()
  assert.equal(attempts, 2)
  assert.equal(await cursorOf(dir, S_A), '1')
  await a.flush()
  assert.equal(attempts, 3)
  assert.equal(await cursorOf(dir, S_A), '3')

  const dead = await readLines(join(dir, 'dead.log'))
  assert.equal(dead.length, 1)
  const entry = JSON.parse(dead[0])
  assert.equal(entry.line, badLine)
  assert.match(entry.reason, /wake failed 3 consecutive attempts: agent refused the turn/)
  assert.ok(!Number.isNaN(Date.parse(entry.at)))
  assert.deepEqual(deliveredA.map(bodyOf), ['first']) // badLine 死信后不再投递
  const state = await readState(dir)
  assert.equal(state.consumers[S_A].deadCount, 1)
  assert.equal(state.consumers[S_A].deliveredCount, 1)
})

test('wake failure then success on retry: row delivered exactly once (at-least-once recovery)', async () => {
  const dir = await makeBridge()
  const delivered = []
  let failFirst = true
  const wake = (line) => {
    if (failFirst) {
      failFirst = false
      throw new Error('transient')
    }
    delivered.push(line)
  }
  const pump = createPump({ bridgeDir: dir, wake, consumer: { sessionId: S_A }, retryDelayMs: 60_000 })
  await appendInbox(dir, [`{"type":"ping","from":"t@x","to":"${S_A}","body":"retry me"}`])
  await pump.flush()
  assert.equal(delivered.length, 0)
  // 游标未推进（.cursor 文件在无推进时甚至不落盘 —— 推进才写）。
  assert.equal(pump.snapshot().cursor, 0)
  assert.equal(await readMaybe(join(dir, `.cursor.${S_A}`)), null)
  await pump.flush()
  assert.deepEqual(delivered.map(bodyOf), ['retry me'])
  assert.equal(await cursorOf(dir, S_A), '1')
})

test('dedup window: identical (from, body) inside the window wakes once; outside it redelivers', async () => {
  const dir = await makeBridge()
  const delivered = []
  let clock = 1_000_000
  const pump = mkPump(dir, delivered, { sessionId: S_A }, { now: () => clock })
  const line = `{"type":"done","from":"dup@x","to":"${S_A}","body":"same payload"}`
  await appendInbox(dir, [line, line])
  await pump.flush()
  // 窗口内第二行：不 wake，但游标推进（dedupCount 记 1）。
  assert.equal(delivered.length, 1)
  assert.equal(await cursorOf(dir, S_A), '2')
  let state = await readState(dir)
  assert.equal(state.consumers[S_A].dedupCount, 1)

  // 窗口过后同一内容再来 → 允许重投（at-least-once 的"再"侧）。
  clock += 61_000
  await appendInbox(dir, [line])
  await pump.flush()
  assert.equal(delivered.length, 2)
  state = await readState(dir)
  assert.equal(state.consumers[S_A].dedupCount, 1)
  assert.equal(state.consumers[S_A].deliveredCount, 2)
})

test('blank lines are skipped silently (no wake, no dead entry)', async () => {
  const dir = await makeBridge()
  const delivered = []
  const pump = mkPump(dir, delivered, { sessionId: S_A })
  await appendInbox(dir, ['', '   ', `{"type":"ping","from":"a@x","to":"${S_A}","body":"real"}`])
  await pump.flush()
  assert.deepEqual(delivered.map(bodyOf), ['real'])
  assert.equal((await readLines(join(dir, 'dead.log'))).length, 0)
  assert.equal(await cursorOf(dir, S_A), '3')
})

test('partial trailing row (no newline yet) is not consumed', async () => {
  const dir = await makeBridge()
  const delivered = []
  const pump = mkPump(dir, delivered, { sessionId: S_A })
  await appendInbox(dir, [`{"type":"ping","from":"a@x","to":"${S_A}","body":"complete"}`])
  await writeFile(join(dir, 'inbox.log'), `{"type":"ping","from":"a@x","to":"${S_A}","body":"partial-writ`, { flag: 'a' })
  await pump.flush()
  assert.deepEqual(delivered.map(bodyOf), ['complete'])
  assert.equal(await cursorOf(dir, S_A), '1')
  // 写完换行后可消费。
  await writeFile(join(dir, 'inbox.log'), 'ing"}\n', { flag: 'a' })
  await pump.flush()
  assert.equal(delivered.length, 2)
})

test('rotation: past line threshold while idle, renames to inbox.log.1, resets cursor, keeps consuming', async () => {
  const dir = await makeBridge()
  const delivered = []
  const pump = mkPump(dir, delivered, { sessionId: S_A }, { rotateMaxLines: 5 })
  const batch = Array.from({ length: 6 }, (_, i) => `{"type":"ping","from":"r@x","to":"${S_A}","body":"line-${i}"}`)
  await appendInbox(dir, batch)
  await pump.flush()
  // 6 行 > 5 行阈值且已消费完（单消费者闸门平凡通过）→ 轮转。
  assert.equal(delivered.length, 6)
  const rotated = await readLines(join(dir, 'inbox.log.1'))
  assert.equal(rotated.length, 6)
  assert.equal(await readMaybe(join(dir, 'inbox.log')), null)
  assert.equal(await cursorOf(dir, S_A), '0')
  const state = await readState(dir)
  assert.equal(state.rotatedCount, 1)
  assert.ok(state.lastRotatedAt)

  // 轮转后新消息从游标 0 继续消费；本次不足阈值不再轮转（只保留一代 .1）。
  await appendInbox(dir, [`{"type":"done","from":"r@x","to":"${S_A}","body":"post-rotate"}`])
  await pump.flush()
  assert.equal(delivered.length, 7)
  assert.equal(await cursorOf(dir, S_A), '1')
  assert.equal((await readLines(join(dir, 'inbox.log.1'))).length, 6)
})

test('rotation: byte threshold also triggers; undersized inbox never rotates', async () => {
  const dir = await makeBridge()
  const delivered = []
  const pump = mkPump(dir, delivered, { sessionId: S_A }, { rotateMaxBytes: 40 })
  await appendInbox(dir, [`{"type":"ping","from":"b@x","to":"${S_A}","body":"0123456789012345678901234567890123456789"}`])
  await pump.flush()
  assert.equal(delivered.length, 1)
  assert.notEqual(await readMaybe(join(dir, 'inbox.log.1')), null)

  const dir2 = await makeBridge()
  const delivered2 = []
  const pump2 = mkPump(dir2, delivered2, { sessionId: S_A }, { rotateMaxBytes: 100 })
  // 53 字节 << 100：不轮转。
  await appendInbox(dir2, [`{"from":"t@x","to":"${S_A}","body":"tiny"}`])
  await pump2.flush()
  assert.equal(await readMaybe(join(dir2, 'inbox.log.1')), null)
  assert.equal(await cursorOf(dir2, S_A), '1')
})

// ---------------------------------------------------------------- v3.5 多消费者路由

test('multi-consumer routing: qualified/bare/broadcast rows reach exactly the addressed consumers', async () => {
  const dir = await makeBridge()
  const deliveredA = []
  const deliveredB = []
  const a = mkPump(dir, deliveredA, { sessionId: S_A, alias: '编排1' })
  const b = mkPump(dir, deliveredB, { sessionId: S_B, alias: '编排2' })
  await a.flush()
  await b.flush()
  await appendInbox(dir, [
    `{"type":"cb","from":"z@x","to":"编排1@${S_A}","body":"a-qualified"}`,
    `{"type":"cb","from":"z@x","to":"编排2@${S_B}","body":"b-qualified"}`,
    `{"type":"cb","from":"z@x","to":"${S_A}","body":"a-bare-sid"}`,
    `{"type":"cb","from":"z@x","to":"*","body":"broadcast"}`,
    `{"type":"cb","from":"z@x","to":"编排X@${S_A}","body":"a-sid-keyed-alias-ignored"}`,
  ])
  await a.flush()
  await b.flush()
  // A 拿到 0/2/3/4；B 拿到 1/3；互不误投（含 alias 不匹配但 sessionId 匹配的行——sid 为路由键）。
  assert.deepEqual(deliveredA.map(bodyOf), ['a-qualified', 'a-bare-sid', 'broadcast', 'a-sid-keyed-alias-ignored'])
  assert.deepEqual(deliveredB.map(bodyOf), ['b-qualified', 'broadcast'])
  assert.equal(await cursorOf(dir, S_A), '5')
  assert.equal(await cursorOf(dir, S_B), '5')

  // 游标已到尾：重复 flush 不重投。
  await a.flush()
  await b.flush()
  assert.equal(deliveredA.length, 4)
  assert.equal(deliveredB.length, 2)

  const state = await readState(dir)
  assert.equal(state.consumers[S_A].deliveredCount, 4)
  assert.equal(state.consumers[S_B].deliveredCount, 2)
  assert.equal(state.consumers[S_A].broadcastCount, 1)
  assert.equal(state.consumers[S_B].broadcastCount, 1)
  assert.equal(state.consumers[S_A].skippedCount, 1) // B 的行被 A 越过
  assert.equal(state.consumers[S_B].skippedCount, 3) // A 的 3 行被 B 越过(广播行是 wake 不是 skip)
  assert.equal((await readLines(join(dir, 'dead.log'))).length, 0)
  await a.dispose()
  await b.dispose()
})

test('independent cursors: a slow consumer catches up later without stealing or re-waking rows', async () => {
  const dir = await makeBridge()
  const deliveredA = []
  const deliveredB = []
  const a = mkPump(dir, deliveredA, { sessionId: S_A })
  const b = mkPump(dir, deliveredB, { sessionId: S_B })
  await a.flush() // 注册 A
  await b.flush() // 注册 B（空扫，未消费任何行）
  await appendInbox(dir, [
    `{"type":"cb","from":"z@x","to":"${S_A}","body":"a-1"}`,
    `{"type":"cb","from":"z@x","to":"${S_B}","body":"b-1"}`,
    `{"type":"cb","from":"z@x","to":"${S_A}","body":"a-2"}`,
  ])
  // 快消费者 A 先消费全部行：自己的行投递，B 的行越过；A 的游标推进到 3。
  await a.flush()
  assert.deepEqual(deliveredA.map(bodyOf), ['a-1', 'a-2'])
  assert.deepEqual(deliveredB, [])
  assert.equal(await cursorOf(dir, S_A), '3')
  assert.equal(await readMaybe(join(dir, `.cursor.${S_B}`)), null)

  // 慢消费者 B 之后才 flush：从自己的游标(0)起扫，越过 A 的行（不误投），拿到自己的行。
  await b.flush()
  assert.deepEqual(deliveredB.map(bodyOf), ['b-1'])
  assert.deepEqual(deliveredA.map(bodyOf), ['a-1', 'a-2']) // A 不受 B 消费影响
  assert.equal(await cursorOf(dir, S_B), '3')
  assert.equal((await readLines(join(dir, 'dead.log'))).length, 0)
})

test('broadcast rows wake every registered consumer exactly once; repeats absorbed by dedup', async () => {
  const dir = await makeBridge()
  const deliveredA = []
  const deliveredB = []
  const a = mkPump(dir, deliveredA, { sessionId: S_A })
  const b = mkPump(dir, deliveredB, { sessionId: S_B })
  await a.flush()
  await b.flush()
  const row = `{"type":"cb","from":"z@x","to":"*","body":"bcast"}`
  await appendInbox(dir, [row, row])
  await a.flush()
  await b.flush()
  assert.deepEqual(deliveredA.map(bodyOf), ['bcast'])
  assert.deepEqual(deliveredB.map(bodyOf), ['bcast'])
  assert.equal(await cursorOf(dir, S_A), '2')
  assert.equal(await cursorOf(dir, S_B), '2')
  const state = await readState(dir)
  assert.equal(state.consumers[S_A].broadcastCount, 1)
  assert.equal(state.consumers[S_B].broadcastCount, 1)
  assert.equal(state.consumers[S_A].dedupCount, 1)
  assert.equal(state.consumers[S_B].dedupCount, 1)
})

test('per-consumer cursor persists across pump instances; another consumer resumes from 0', async () => {
  const dir = await makeBridge()
  const delivered1 = []
  const first = mkPump(dir, delivered1, { sessionId: S_A })
  const b = mkPump(dir, [], { sessionId: S_B })
  await first.flush() // 注册 A
  await b.flush() // 注册 B（保证后续 to:B 的行可寻址）
  await appendInbox(dir, [
    `{"type":"ping","from":"a@x","to":"${S_A}","body":"1"}`,
    `{"type":"ping","from":"a@x","to":"${S_B}","body":"for-b"}`,
  ])
  await first.flush()
  await first.dispose() // teardown：A 从 registry 注销
  assert.deepEqual(delivered1.map(bodyOf), ['1'])

  // 同 sid 新实例（模拟会话重建）：读回自己的游标，不重投旧行。
  const delivered2 = []
  const again = mkPump(dir, delivered2, { sessionId: S_A })
  await appendInbox(dir, [`{"type":"ping","from":"a@x","to":"${S_A}","body":"2"}`])
  await again.flush()
  await again.dispose()
  assert.deepEqual(delivered2.map(bodyOf), ['2'])
  assert.equal(await cursorOf(dir, S_A), '3')

  // 另一 sid（B，游标仍为 0）之后消费：只拿到属于自己的行。
  const deliveredB = []
  const wakeB = collectorWake(deliveredB)
  const b2 = createPump({ bridgeDir: dir, wake: wakeB, consumer: { sessionId: S_B }, retryDelayMs: 60_000 })
  await b2.flush()
  await b2.dispose()
  assert.deepEqual(deliveredB.map(bodyOf), ['for-b'])
  assert.equal(await cursorOf(dir, S_B), '3')
})

// ---------------------------------------------------------------- v3.5 死信寻址

test('unaddressable rows (missing/invalid to, unknown sessionId, unresolvable alias) dead-letter once and wake nobody', async () => {
  const dir = await makeBridge()
  const deliveredA = []
  const deliveredB = []
  const a = mkPump(dir, deliveredA, { sessionId: S_A, alias: '编排1' })
  const b = mkPump(dir, deliveredB, { sessionId: S_B, alias: '编排2' })
  await a.flush() // A 先注册 → undertaker
  await b.flush()
  await appendInbox(dir, [
    '{"type":"cb","from":"z@x","body":"no-to-field"}',
    `{"type":"cb","from":"z@x","to":"ghost@session-zzzz","body":"unknown-session"}`,
    '{"type":"cb","from":"z@x","to":"no-such-alias","body":"unknown-alias"}',
    '{"type":"cb","from":"z@x","to":42,"body":"numeric-to"}',
    `{"type":"cb","from":"z@x","to":"${S_A}","body":"still-flows"}`,
  ])
  await a.flush()
  await b.flush()
  assert.deepEqual(deliveredA.map(bodyOf), ['still-flows'])
  assert.deepEqual(deliveredB, [])
  const dead = await readLines(join(dir, 'dead.log'))
  assert.equal(dead.length, 4) // 两个消费者都扫过，但只有 undertaker 落笔
  for (const entryText of dead) {
    const entry = JSON.parse(entryText)
    assert.match(entry.reason, /unknown-addressee/)
    assert.ok(!Number.isNaN(Date.parse(entry.at)))
  }
  const reasons = dead.map((entryText) => JSON.parse(entryText).reason)
  assert.ok(reasons.some((reason) => reason.includes('missing or not a non-empty string')))
  assert.ok(reasons.some((reason) => reason.includes('no registered consumer with sessionId session-zzzz')))
  assert.ok(reasons.some((reason) => reason.includes('neither a registered sessionId nor a resolvable alias')))
  assert.equal(await cursorOf(dir, S_A), '5')
  assert.equal(await cursorOf(dir, S_B), '5')
  const state = await readState(dir)
  assert.equal(state.consumers[S_A].deadCount, 4)
  assert.equal(state.consumers[S_B].deadCount, 0)
})

test('legacy bare-alias rows resolve through the registry to the armed consumer', async () => {
  const dir = await makeBridge()
  const deliveredA = []
  const deliveredB = []
  const a = mkPump(dir, deliveredA, { sessionId: S_A, alias: '编排1' })
  const b = mkPump(dir, deliveredB, { sessionId: S_B, alias: '编排2' })
  await a.flush()
  await b.flush()
  await appendInbox(dir, [
    '{"type":"cb","from":"zap@impl","to":"编排1","body":"legacy-a"}',
    '{"type":"cb","from":"zap@impl","to":"编排2","body":"legacy-b"}',
  ])
  await a.flush()
  await b.flush()
  assert.deepEqual(deliveredA.map(bodyOf), ['legacy-a'])
  assert.deepEqual(deliveredB.map(bodyOf), ['legacy-b'])
  assert.equal((await readLines(join(dir, 'dead.log'))).length, 0)
  assert.equal(await cursorOf(dir, S_A), '2')
  assert.equal(await cursorOf(dir, S_B), '2')
})

test('ambiguous legacy alias (two armed consumers sharing one alias) dead-letters and wakes neither — incident regression', async () => {
  const dir = await makeBridge()
  const deliveredA = []
  const deliveredB = []
  // 事故形态：两个 host 实例的 armed main 同名"编排1"，sessionId 不同。
  const a = mkPump(dir, deliveredA, { sessionId: S_A, alias: '编排1' })
  const b = mkPump(dir, deliveredB, { sessionId: S_B, alias: '编排1' })
  await a.flush()
  await b.flush()
  await appendInbox(dir, [
    '{"type":"done","from":"zap@impl","to":"编排1","body":"v3.4-style legacy callback"}',
    `{"type":"done","from":"zap@impl","to":"编排1@${S_A}","body":"qualified callback"}`,
  ])
  await a.flush()
  await b.flush()
  // 旧式裸别名歧义 → 死信，两个同名消费者都不投（绝不挑边、绝不冒名）。
  assert.deepEqual(deliveredA.map(bodyOf), ['qualified callback'])
  assert.deepEqual(deliveredB, [])
  const dead = await readLines(join(dir, 'dead.log'))
  assert.equal(dead.length, 1)
  const entry = JSON.parse(dead[0])
  assert.equal(JSON.parse(entry.line).body, 'v3.4-style legacy callback')
  assert.match(entry.reason, /unknown-addressee/)
  assert.match(entry.reason, /ambiguous/)
  assert.equal(await cursorOf(dir, S_A), '2')
  assert.equal(await cursorOf(dir, S_B), '2')
})

// ---------------------------------------------------------------- v3.5 注册表与轮转闸门

test('registry lifecycle: flush registers (sid/pid/armedAt/alias), dispose unregisters, atomic write leaves no .tmp', async () => {
  const dir = await makeBridge()
  const a = mkPump(dir, [], { sessionId: S_A, alias: '编排1' })
  const b = mkPump(dir, [], { sessionId: S_B, alias: '编排2' })
  await a.flush()
  let registry = await readRegistry(dir)
  assert.deepEqual(Object.keys(registry.consumers), [S_A])
  assert.equal(registry.consumers[S_A].alias, '编排1')
  assert.equal(registry.consumers[S_A].pid, process.pid)
  assert.ok(registry.consumers[S_A].armedAt)

  await b.flush()
  registry = await readRegistry(dir)
  assert.deepEqual(Object.keys(registry.consumers).sort(), [S_A, S_B].sort())

  await a.dispose()
  registry = await readRegistry(dir)
  assert.deepEqual(Object.keys(registry.consumers), [S_B])

  await b.dispose()
  registry = await readRegistry(dir)
  assert.deepEqual(registry.consumers, {})
  assert.equal(await readMaybe(join(dir, 'registry.json.tmp')), null) // 原子写无残留
  assert.equal(await readMaybe(join(dir, 'state.json.tmp')), null)
})

test('rotation waits for every registered consumer to reach the tail (slow-consumer protection)', async () => {
  const dir = await makeBridge()
  const deliveredA = []
  const deliveredB = []
  const a = mkPump(dir, deliveredA, { sessionId: S_A }, { rotateMaxLines: 3 })
  const b = mkPump(dir, deliveredB, { sessionId: S_B }, { rotateMaxLines: 3 })
  await a.flush() // 注册
  await b.flush()
  await appendInbox(dir, Array.from({ length: 4 }, (_, i) => `{"type":"ping","from":"r@x","to":"${S_A}","body":"line-${i}"}`))

  // A 消费完全部 4 行（> 3 阈值），但 B 的游标（缺失 = 0）阻塞轮转。
  await a.flush()
  assert.equal(deliveredA.length, 4)
  assert.notEqual(await readMaybe(join(dir, 'inbox.log')), null)
  assert.equal(await readMaybe(join(dir, 'inbox.log.1')), null)

  // B 到尾（越过全部非本消费者行）→ 本轮 flush 触发轮转，全部在册游标归零。
  await b.flush()
  assert.deepEqual(deliveredB, [])
  assert.equal((await readLines(join(dir, 'inbox.log.1'))).length, 4)
  assert.equal(await readMaybe(join(dir, 'inbox.log')), null)
  assert.equal(await cursorOf(dir, S_A), '0')
  assert.equal(await cursorOf(dir, S_B), '0')
  const state = await readState(dir)
  assert.equal(state.rotatedCount, 1)

  // 轮转后从 0 继续消费，互不干扰。
  await appendInbox(dir, [`{"type":"ping","from":"r@x","to":"${S_B}","body":"post-rotate"}`])
  await b.flush()
  assert.deepEqual(deliveredB.map(bodyOf), ['post-rotate'])
  assert.equal(await cursorOf(dir, S_B), '1')
})

test('legacy shared .cursor is never read or written; per-consumer files are authoritative', async () => {
  const dir = await makeBridge()
  await writeFile(join(dir, '.cursor'), '99')
  const delivered = []
  const pump = mkPump(dir, delivered, { sessionId: S_A })
  await appendInbox(dir, [`{"type":"ping","from":"a@x","to":"${S_A}","body":"x"}`])
  await pump.flush()
  // v3.4 遗留的共享游标一个字节都不动。
  assert.equal((await readFile(join(dir, '.cursor'), 'utf8')).trim(), '99')
  assert.equal(await cursorOf(dir, S_A), '1')
})
