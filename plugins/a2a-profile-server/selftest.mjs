#!/usr/bin/env node
//
// selftest.mjs — @voice-head/a2a-profile-server 内置自测（零外部依赖）。
//
//   T01 agent-card 就绪            T06 task journal 重放（崩溃恢复）
//   T02 message/send 生命周期       T07 profile 版本化（重投影 v+1 + 归档）
//   T03 tasks/cancel + 终态保护     T08 history.jsonl 运行记录
//   T04 错误面（-32601/-32602）     T09 incubate：三门拦截 + dry 回执
//   T05 鉴权（token 生效）          T10 profiles/list+get
//   T11 VO-002 缺参回归一致         T14 dsh-manager 缺省 role 推导 + mailbox 默认
//   T12 role 非法/冲突 → -32602     T15 扩参三门照常拦截（-32000）
//   T13 dsh-liaison mock 孵化（回执/fleet/注入体）
//
// 用法: node selftest.mjs [--verbose]   退出码 0=全绿 1=有失败。
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { activate } from './index.js'
import { createTaskStore } from './task-store.js'

const VERBOSE = process.argv.includes('--verbose')
let passed = 0
let failed = 0
const failures = []

function ok(name, cond, detail = '') {
  if (cond) {
    passed += 1
    console.log(`[ ok ] ${name}`)
  } else {
    failed += 1
    failures.push(name + (detail ? ` — ${detail}` : ''))
    console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function waitFor(condFn, { timeoutMs = 5000, stepMs = 25 } = {}) {
  const start = Date.now()
  for (;;) {
    if (await condFn()) return true
    if (Date.now() - start > timeoutMs) return false
    if (VERBOSE) process.stdout.write('.')
    await sleep(stepMs)
  }
}

async function rpc(base, method, params, token) {
  const res = await fetch(base + '/', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  return { status: res.status, body: await res.json() }
}

const GOOD_MD = `# AGENTS.md

> 探索型 MVP 助手。

## Agent Behavior
快速验证。

### Mission
1. 理解 2. 实现

### How you work
- 小步快跑

### MUST
- 标注证据强度

### MUST NOT
- 禁止删除生产数据或泄露敏感凭据

### Style
简洁。

### Output
- 代码
`

const strictGates = (md) => ({
  passed: !/D\d+|19\s*维|泛化算法/.test(md) && /MUST NOT/.test(md),
  violations: /D\d+|19\s*维/.test(md) ? { gate1: ['framework leak'] } : {},
})

/**
 * mock dsh 宿主（VO-002 扩参用例）：mock session-spawn（真写 fleet.json，不真开会话）
 * + mock loopback（/api/session.prompt 记录注入体）。经 env 注入 incubateDsh
 * 的调用时取值（DSH_PORT/A2A_SESSION_SPAWN/MAESTRO_FLEET）。
 */
async function startMockDsh(dir) {
  const spawnBin = join(dir, 'mock-session-spawn.mjs')
  writeFileSync(spawnBin, `#!/usr/bin/env node
import { readFile, writeFile, rename } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
const fleetPath = process.env.MAESTRO_FLEET
const code = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0')
const fleet = JSON.parse(await readFile(fleetPath, 'utf8'))
fleet.fleet = fleet.fleet ?? {}
fleet.fleet[code] = {
  sessionId: 'session-' + code + Math.random().toString(16).slice(2, 8),
  title: 'ORCH/vh-mock-' + code,
}
const tmp = fleetPath + '.mocktmp'
await writeFile(tmp, JSON.stringify(fleet, null, 2))
await rename(tmp, fleetPath)
if (process.env.A2A_MOCK_SPAWN_ARGS) {
  appendFileSync(process.env.A2A_MOCK_SPAWN_ARGS, JSON.stringify(process.argv) + '\\n')
}
console.log('mock session-spawn ok code=' + code)
`)
  chmodSync(spawnBin, 0o755)
  const prompts = []
  const srv = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      let payload = {}
      try { payload = JSON.parse(raw).payload ?? {} } catch {}
      prompts.push({ url: req.url, payload })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, value: { queued: true } }))
    })
  })
  const port = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)))
  return { spawnBin, port, prompts, stop: () => new Promise((r) => srv.close(() => r())) }
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'a2a-selftest-'))
  const stateDir = join(dir, 'state')
  const profileRoot = join(dir, 'profiles')
  const TOKEN = 'selftest-token'

  // 无 token 实例（契约面）
  const app = await activate({ port: 0, profileRoot, stateDir, gatesFn: strictGates })
  const base = `http://127.0.0.1:${app.port}`

  try {
    // T01 agent-card
    const card = await (await fetch(base + '/.well-known/agent-card.json')).json()
    ok('T01 agent-card', card.name === 'voice-head-orchestrator' && card.version === 'internal-1'
      && card.skills.some((s) => s.id === 'incubate'))

    // T02 message/send 生命周期（echo 执行器 → completed + 凭证约定）
    const sent = await rpc(base, 'message/send', {
      message: { role: 'user', parts: [{ type: 'text', text: '调研 WebGPU' }] },
      context: { source: 'voice-head', ref: 'vh-1' },
    })
    const taskId = sent.body.result?.task?.id
    ok('T02a send → submitted', sent.body.result?.task?.state === 'submitted' && taskId)
    const done = await waitFor(async () => {
      const g = await rpc(base, 'tasks/get', { taskId })
      return g.body.result?.task?.state === 'completed'
    })
    const g = await rpc(base, 'tasks/get', { taskId })
    const content = g.body.result?.task?.artifacts?.[0]?.content ?? ''
    ok('T02b lifecycle → completed', done)
    ok('T02c artifact 契约（Final 前缀 + 凭证）',
      content.startsWith('"Agent Final Message":') && content.includes(`【凭证A2A-${taskId}】`))

    // T03 cancel + 终态保护
    const c = await rpc(base, 'message/send', {
      message: { parts: [{ type: 'text', text: '可取消' }] },
    })
    const cid = c.body.result.task.id
    // echo 执行器有 50ms working 窗口，立即取消应落在 canceled
    const cancelled = await rpc(base, 'tasks/cancel', { taskId: cid })
    ok('T03a cancel', cancelled.body.result?.task?.state === 'canceled')
    const fin = await rpc(base, 'tasks/cancel', { taskId }) // 已终态的 T02 task
    ok('T03b 终态保护', fin.body.error?.code === -32602)

    // T04 错误面
    const nf = await rpc(base, 'no/such', {})
    const bad = await rpc(base, 'tasks/get', { taskId: 't_nope' })
    ok('T04 错误面 -32601/-32602', nf.body.error?.code === -32601 && bad.body.error?.code === -32602)

    // T05 鉴权实例
    const authed = await activate({ port: 0, profileRoot: join(dir, 'p2'), stateDir: join(dir, 's2'), token: TOKEN })
    const abase = `http://127.0.0.1:${authed.port}`
    const noTok = await fetch(abase + '/', { method: 'POST', body: '{}' })
    const withTok = await rpc(abase, 'profiles/list', {}, TOKEN)
    ok('T05 token 鉴权', noTok.status === 401 && withTok.body.result?.profiles)
    authed.stop()

    // T06 journal 重放
    const store2 = createTaskStore(join(dir, 'replay', 'tasks.jsonl'))
    const t1 = await store2.create({ intent: 'x' })
    await store2.transition(t1.id, { state: 'working' })
    const store3 = createTaskStore(join(dir, 'replay', 'tasks.jsonl'))
    const replayed = await store3.get(t1.id)
    ok('T06 journal 重放', replayed?.state === 'working')

    // T07 profile 版本化
    const inc = await rpc(base, 'incubate', {
      name: 'explore-mvp',
      targets: ['dry'],
      projection: { agents_md: GOOD_MD, profile_json: { scenario: '探索', vector19: {} }, description: 'd' },
    })
    ok('T07a incubate v1', inc.body.result?.profile?.version === 1 && inc.body.result?.receipts[0]?.target === 'dry')
    const inc2 = await rpc(base, 'incubate', {
      name: 'explore-mvp',
      targets: ['dry'],
      projection: { agents_md: GOOD_MD + '\n<!-- v2 -->\n', profile_json: {}, description: 'd2' },
    })
    const pdir = join(profileRoot, 'explore-mvp')
    ok('T07b 重投影 v2 + 归档', inc2.body.result?.profile?.version === 2
      && existsSync(join(pdir, 'versions', '1', 'AGENTS.md')) && existsSync(join(pdir, 'AGENTS.md')))

    // T08 history
    const hist = readFileSync(join(pdir, 'history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    ok('T08 history.jsonl', hist.some((h) => h.op === 'create') && hist.some((h) => h.op === 'reproject')
      && hist.some((h) => h.op === 'incubate'))

    // T09 三门拦截
    const leak = await rpc(base, 'incubate', {
      name: 'leaky',
      targets: ['dry'],
      projection: { agents_md: GOOD_MD.replace('MUST NOT', 'MUST NOT（D7 强触发）'), profile_json: {}, description: '' },
    })
    ok('T09 三门拦截（框架术语拒收）', leak.body.error?.code === -32000 && /gate violations/.test(leak.body.error?.message))

    // T10 profiles/list + get
    const list = await rpc(base, 'profiles/list', {})
    const got = await rpc(base, 'profiles/get', { name: 'explore-mvp' })
    ok('T10 profiles/list+get', list.body.result.profiles.some((p) => p.name === 'explore-mvp' && p.version === 2)
      && got.body.result.profile.agentsMd.includes('AGENTS.md'))

    // T11–T15 · VO-002 incubate 扩参（mock dsh 宿主：mock session-spawn + mock loopback，不真孵化）
    const mockDir = join(dir, 'mock-dsh')
    mkdirSync(mockDir)
    const fleetFile = join(mockDir, 'fleet.json')
    writeFileSync(fleetFile, JSON.stringify({ fleet: {} }, null, 2))
    const argsLog = join(mockDir, 'spawn-args.jsonl')
    const mock = await startMockDsh(mockDir)
    const ENV_KEYS = ['DSH_PORT', 'A2A_SESSION_SPAWN', 'MAESTRO_FLEET', 'A2A_MOCK_SPAWN_ARGS']
    const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
    process.env.DSH_PORT = String(mock.port)
    process.env.A2A_SESSION_SPAWN = mock.spawnBin
    process.env.MAESTRO_FLEET = fleetFile
    process.env.A2A_MOCK_SPAWN_ARGS = argsLog
    try {
      // T11 缺参回归：不传 role/mailbox/project → 回执/ctx 与现行完全一致
      const plain = await rpc(base, 'incubate', {
        name: 'plain-worker',
        targets: ['dry'],
        projection: { agents_md: GOOD_MD, profile_json: { scenario: '回归' }, description: 'd' },
      })
      const pr = plain.body.result?.receipts?.[0]
      ok('T11 缺参回归一致（现行语义不变）',
        plain.body.result?.profile?.version === 1
          && pr?.target === 'dry' && pr?.name === 'plain-worker' && pr?.note === 'recorded only'
          && !('role' in pr) && !('mailbox' in pr))

      // T12 role 非法值 / role-target 冲突 → -32602（参数校验先于三门）
      const badRole = await rpc(base, 'incubate', {
        name: 'bad-role', targets: ['dsh'], role: 'chief',
        projection: { agents_md: GOOD_MD, profile_json: {}, description: '' },
      })
      const mismatch = await rpc(base, 'incubate', {
        name: 'bad-match', targets: ['dsh-liaison'], role: 'manager',
        projection: { agents_md: GOOD_MD, profile_json: {}, description: '' },
      })
      ok('T12 role 非法/冲突 → -32602',
        badRole.body.error?.code === -32602 && /invalid role/.test(badRole.body.error?.message)
          && mismatch.body.error?.code === -32602 && /mismatch/.test(mismatch.body.error?.message))

      // T13 dsh-liaison 全参孵化（mock）：回执五键 + fleet 扩展 + 注入体次序 + purpose 携 role
      const li = await rpc(base, 'incubate', {
        name: 'liaison-probe',
        targets: ['dsh-liaison'],
        role: 'liaison', project: 'voice-head', mailbox: 'agent_liaison',
        projection: { agents_md: GOOD_MD, profile_json: { scenario: '编排对接' }, description: 'd' },
      })
      const lr = li.body.result?.receipts?.[0]
      const liPrompt = mock.prompts.at(-1)?.payload?.content?.[0]?.text ?? ''
      const liArgs = readFileSync(argsLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1)
      ok('T13a dsh-liaison 回执含 sessionId/code/mailbox/role/project',
        lr?.target === 'dsh-liaison' && typeof lr.sessionId === 'string' && lr.sessionId.startsWith('session-')
          && /^[0-9a-f]{4}$/.test(lr.code ?? '') && lr.mailbox === 'agent_liaison'
          && lr.role === 'liaison' && lr.project === 'voice-head')
      const ent1 = JSON.parse(readFileSync(fleetFile, 'utf8')).fleet[lr?.code]
      ok('T13b fleet 登记项扩五键（role/project/mailbox/profile_version/spawned_at）',
        ent1 && ent1.role === 'liaison' && ent1.project === 'voice-head' && ent1.mailbox === 'agent_liaison'
          && ent1.profile_version === 1 && typeof ent1.spawned_at === 'number')
      ok('T13c 注入体 = role doctrine 在前 + agentsMd 在后',
        liPrompt.startsWith('ORCA-CB] PROFILE-INJECT] liaison-probe@v1\n')
          && liPrompt.includes('Role Doctrine — liaison')
          && liPrompt.indexOf('Role Doctrine — liaison') < liPrompt.indexOf('# AGENTS.md')
          && liPrompt.includes('check-messages agent_liaison'))
      ok('T13d purpose 携 role、preset/marker 不变',
        liArgs?.[2] === 'maestro' && liArgs?.[3] === 'vh-liaison-probe' && liArgs?.[4] === 'liaison for voice orchestration')

      // T14 dsh-manager 缺省推导：不传 role → 目标蕴含 manager；mailbox 默认 agent_<name>
      const mg = await rpc(base, 'incubate', {
        name: 'mgr-probe',
        targets: ['dsh-manager'],
        projection: { agents_md: GOOD_MD, profile_json: {}, description: '' },
      })
      const mr = mg.body.result?.receipts?.[0]
      const mgPrompt = mock.prompts.at(-1)?.payload?.content?.[0]?.text ?? ''
      const ent2 = JSON.parse(readFileSync(fleetFile, 'utf8')).fleet[mr?.code]
      ok('T14 dsh-manager 缺省 role 推导 + mailbox 默认',
        mr?.target === 'dsh-manager' && mr.role === 'manager' && mr.mailbox === 'agent_mgr-probe' && mr.project === ''
          && mgPrompt.includes('Role Doctrine — manager') && mgPrompt.includes('check-messages agent_mgr-probe')
          && ent2?.role === 'manager' && ent2?.mailbox === 'agent_mgr-probe' && ent2?.profile_version === 1)

      // T15 扩参调用三门前置照常：gate fail → -32000 且不触发 spawn
      const promptsBefore = mock.prompts.length
      const leakRole = await rpc(base, 'incubate', {
        name: 'leaky-role', targets: ['dsh-liaison'], role: 'liaison',
        projection: { agents_md: GOOD_MD.replace('MUST NOT', 'MUST NOT（D7 强触发）'), profile_json: {}, description: '' },
      })
      ok('T15 扩参三门照常拦截（-32000，不触发 spawn）',
        leakRole.body.error?.code === -32000 && /gate violations/.test(leakRole.body.error?.message)
          && mock.prompts.length === promptsBefore)
    } finally {
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      await mock.stop()
    }
  } finally {
    app.stop()
    rmSync(dir, { recursive: true, force: true })
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failures.length) {
    console.log('failures:')
    for (const f of failures) console.log('  -', f)
    process.exit(1)
  }
}

main().catch((e) => {
  console.error('selftest crashed:', e)
  process.exit(1)
})
