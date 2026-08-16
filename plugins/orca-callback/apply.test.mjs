/**
 * apply() 层多会话回归（incident 0003：standing scope 单例互杀）。
 * 假 harness ctx + 两个假 agent,在同一 apply() 实例内先后 arm:
 *   - 双会话注册并存,各自独立游标;
 *   - 定向行只唤醒目标会话(文件桥 & HTTP);
 *   - 回执含 "verified on disk";注册写不进时回执 INCONSISTENT(fail-loud)。
 * 运行: node --test plugins/orca-callback/apply.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, chmod, readFile, rm, appendFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, version, readRegistry } from './pump.js'

const dirs = []
async function makeBridge() {
  const dir = await mkdtemp(join(tmpdir(), 'pump-apply-'))
  dirs.push(dir)
  return dir
}

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
test.after(() => { void Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))) })

test('two sessions arm in one standing apply(): both register, directed rows wake exactly the target', async () => {
  const dir = await makeBridge()
  const prevBridge = process.env.MAESTRO_BRIDGE
  process.env.MAESTRO_BRIDGE = dir
  const A = fakeAgent('session-aaaa')
  const B = fakeAgent('session-bbbb')
  const { ctx, tools, harness } = fakeCtx()
  apply(ctx)
  const arm = tools.get('bridge_arm')
  try {
    harness.current = A
    const receiptA = await arm.execute({ alias: 'orchA' })
    assert.match(receiptA, /verified on disk/)
    harness.current = B
    const receiptB = await arm.execute({ alias: 'orchB' })
    assert.match(receiptB, /verified on disk/)

    // 双会话并存注册(0003 事故形态: v3.5 单例下只有首个会话真实注册)
    const registry = await readRegistry(join(dir, 'registry.json'))
    assert.deepEqual(Object.keys(registry.consumers).sort(), ['session-aaaa', 'session-bbbb'])

    // 定向行只唤醒目标: B 收到,A 零接收(以 B 身份再 arm = 幂等 flush 驱动消费)
    await appendFile(join(dir, 'inbox.log'),
      '{"type":"ping","from":"x@y","to":"orchB@session-bbbb","body":"[ref:r] hi B"}\n')
    await arm.execute({})
    // watcher 的在途 flush 可能与本次 flush 撞 flushing 守卫:轮询等待唤醒落地
    for (let i = 0; i < 40 && B.received.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    assert.equal(B.received.length, 1)
    assert.equal(A.received.length, 0)
    assert.match(B.received[0].content[0].text, /ORCA-CB\].*"to":"orchB@session-bbbb"/)
    // 消费者 B 的游标落盘(A 未消费任何行,其游标文件按需创建,不强断)
    const cursors = (await readdir(dir)).filter((f) => f.startsWith('.cursor.'))
    assert.ok(cursors.includes('.cursor.session-bbbb'), `expected B cursor, got ${JSON.stringify(cursors)}`)
  } finally {
    harness.teardown?.() // 关 watcher + 卸册:放 finally,断言失败也不拖住进程
    if (prevBridge === undefined) delete process.env.MAESTRO_BRIDGE
    else process.env.MAESTRO_BRIDGE = prevBridge
  }
})

test('phantom-registration guard: unwritable bridge dir → receipt INCONSISTENT, no false claim', async () => {
  const dir = await makeBridge()
  const prevBridge = process.env.MAESTRO_BRIDGE
  process.env.MAESTRO_BRIDGE = dir
  const A = fakeAgent('session-cccc')
  const { ctx, tools, harness } = fakeCtx()
  apply(ctx)
  try {
    await mkdir(dir, { recursive: true })
    await chmod(dir, 0o555) // r-x: 读可得,写必败 → 注册无法落盘
    harness.current = A
    const receipt = await tools.get('bridge_arm').execute({ alias: 'orchC' })
    assert.match(receipt, /INCONSISTENT/)
    assert.doesNotMatch(receipt, /verified on disk/)
  } finally {
    await chmod(dir, 0o755).catch(() => {})
    harness.teardown?.()
    if (prevBridge === undefined) delete process.env.MAESTRO_BRIDGE
    else process.env.MAESTRO_BRIDGE = prevBridge
  }
})

test('exports the v3.6 fingerprint and readRegistry helper', async () => {
  assert.equal(version, '3.6.0')
  assert.equal(typeof readRegistry, 'function')
  const dir = await makeBridge()
  const empty = await readRegistry(join(dir, 'registry.json'))
  assert.deepEqual(empty.consumers, {})
})
