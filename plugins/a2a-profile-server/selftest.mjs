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
//   T16 pool/spawn *new* 回归同构  T19 binding-mode（信封/未 spawn/缺 sessionId）
//   T17 具名复用（字节一致+版本钉死） T20 缺省 default/非法 strategy/unknown
//   T18 fanout-sub count=3（回执/mailbox/fleet/注入） T21 queen 守卫 -32000
//
//   T22 export 基本面（目录/preset 仅显式键/persona 内嵌逐字节还原/!!js+group 保真）
//   T23 slug+存在性守卫（非法名抛错/重复抛错/force 覆盖）   T24 '{{' 断言（抛错不落盘）
//   T25 原子落位（终态两文件齐备+无 tmp 残留）              T26 软链资产指向 assetsFrom
//   T27 incubate lineage 透传（derived-by/parent 落 meta）  T28 profiles/revalidate（pass/fail/未配置）
//
// 用法: node selftest.mjs [--verbose]   退出码 0=全绿 1=有失败。
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync, readdirSync, readlinkSync, lstatSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { activate } from './index.js'
import { createTaskStore } from './task-store.js'
import { createProfileStore } from './profile-store.js'
import { exportDshPreset } from './exporters/dsh-preset.js'

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
 * 合成模板 fixture（N10-T3 用例）：persona 行块（text: |- + 6 空格缩进正文）+ 一行
 * disabled: !!js 平台条件行（bash/pwsh 各一）+ 一个 cordis:group isolate 块。
 * 导出后块外一切行必须与该模板逐字节相同（硬规则③）。
 */
const SYNTHETIC_TEMPLATE = [
  '# synthetic template fixture (selftest T22): persona row + !!js platform lines + cordis:group isolate.',
  '# every line outside the persona text block must survive export byte-identical.',
  '- id: persona',
  "  name: '@deepseek-ai/dsh-persona'",
  '  config:',
  '    text: |-',
  '      You are an orchestration supervisor placeholder. {{model}} and {{cwd}} stay (registered variables).',
  '',
  '      TEMPLATE-ONLY BODY that export must replace wholesale.',
  '',
  '- id: agent-instructions',
  "  name: '@deepseek-ai/dsh-agent-instructions'",
  '  config:',
  '    maxBytes: 65536',
  '',
  '- id: tool-bash',
  "  name: '@deepseek-ai/dsh-tool-bash'",
  "  disabled: !!js process.platform === 'win32'",
  '',
  '- id: tool-pwsh',
  "  name: '@deepseek-ai/dsh-tool-pwsh'",
  "  disabled: !!js process.platform !== 'win32'",
  '',
  '- id: planning',
  '  name: cordis:group',
  '  group: true',
  '  isolate:',
  '    planMode: true',
  '',
].join('\n')

/** 从生成的 agent.cordis.yml 提取 persona text 块内容：去同宽缩进+去尾部空行（|- strip 语义）。 */
function recoverPersonaText(cordisText) {
  const lines = cordisText.split('\n')
  const textIdx = lines.findIndex((l) => /^\s+text: \|-$/.test(l))
  if (textIdx < 0) return null
  const end = lines.findIndex((l, i) => i > textIdx && /^- id: /.test(l))
  const content = lines.slice(textIdx + 1, end < 0 ? lines.length : end)
  while (content.length && content[content.length - 1] === '') content.pop()
  const indent = (content.find((l) => l.trim()) ?? '').match(/^\s*/)[0]
  return content.map((l) => (l === '' ? '' : l.slice(indent.length))).join('\n')
}

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

      // ---- T16–T21 · N10-T1 pool/spawn（OF-012；全部走现有 mock，零 live）----

      // T16 *new* 回归同构：pool/spawn{profile:'*new*'} 与 incubate 输出同形（验收④）
      const incRef16 = await rpc(base, 'incubate', {
        name: 'pool-ref-probe', targets: ['dsh'],
        projection: { agents_md: GOOD_MD, profile_json: { scenario: '同构' }, description: 'd' },
      })
      const psNew = await rpc(base, 'pool/spawn', {
        profile: '*new*', name: 'pool-new-probe', targets: ['dsh'],
        projection: { agents_md: GOOD_MD, profile_json: { scenario: '同构' }, description: 'd' },
      })
      const ref16 = incRef16.body.result
      const new16 = psNew.body.result
      const card16 = await (await fetch(base + '/.well-known/agent-card.json')).json()
      ok('T16 *new* 回归同构（与 incubate 输出同形 + agent-card skills 增项）',
        new16?.profile?.version === 1
          && Object.keys(ref16?.profile ?? {}).sort().join() === Object.keys(new16?.profile ?? {}).sort().join()
          && Object.keys(ref16?.receipts?.[0] ?? {}).sort().join() === Object.keys(new16?.receipts?.[0] ?? {}).sort().join()
          && new16?.receipts?.[0]?.target === 'dsh' && new16.receipts[0].name === 'pool-new-probe'
          && new16.receipts[0].version === 1 && typeof new16.receipts[0].sessionId === 'string'
          && card16.skills.some((s) => s.id === 'pool-spawn'))

      // T17 具名复用：incubate 存底（explore-mvp@v2）→ pool/spawn 复用
      const storedMd17 = readFileSync(join(profileRoot, 'explore-mvp', 'AGENTS.md'), 'utf8')
      const reuse = await rpc(base, 'pool/spawn', { profile: 'explore-mvp', targets: ['dsh'] })
      const ru17 = reuse.body.result
      const ruPrompt17 = mock.prompts.at(-1)?.payload?.content?.[0]?.text ?? ''
      const after17 = await rpc(base, 'profiles/get', { name: 'explore-mvp' })
      const hist17 = readFileSync(join(profileRoot, 'explore-mvp', 'history.jsonl'), 'utf8')
        .trim().split('\n').map((l) => JSON.parse(l))
      ok('T17 具名复用（注入体逐字节一致 + 版本钉死不 bump + recordRun op:pool-spawn）',
        ru17?.profile?.version === 2 && ru17?.receipts?.[0]?.version === 2
          && ruPrompt17 === `ORCA-CB] PROFILE-INJECT] explore-mvp@v2\n${storedMd17}`
          && after17.body.result?.profile?.version === 2
          && hist17.some((h) => h.op === 'pool-spawn' && h.version === 2 && Array.isArray(h.targets)))

      // T18 fanout-sub count=3：3 回执、mailbox base-1/2/3 两两不同、fleet 3 条含 profile_version、3 次注入
      const promptsBefore18 = mock.prompts.length
      const fan = await rpc(base, 'pool/spawn', {
        profile: 'explore-mvp', strategy: 'fanout-sub', mailbox: 'fan-probe', count: 3, project: 'n10',
      })
      const fr18 = fan.body.result?.receipts ?? []
      const fanFleet = Object.values(JSON.parse(readFileSync(fleetFile, 'utf8')).fleet)
        .filter((e) => typeof e.mailbox === 'string' && e.mailbox.startsWith('fan-probe-'))
      ok('T18 fanout-sub count=3（3 回执/mailbox 唯一/fleet 含 profile_version/3 次注入）',
        fr18.length === 3
          && new Set(fr18.map((r) => r.mailbox)).size === 3
          && fr18.map((r) => r.mailbox).sort().join(',') === 'fan-probe-1,fan-probe-2,fan-probe-3'
          && fanFleet.length === 3 && fanFleet.every((e) => e.profile_version === 2)
          && mock.prompts.length === promptsBefore18 + 3
          && mock.prompts.slice(-3).every((p) => (p.payload?.content?.[0]?.text ?? '')
            .startsWith('ORCA-CB] PROFILE-INJECT] explore-mvp@v2\n')))

      // T19 binding-mode：mock loopback 收到 session.prompt 信封；session-spawn 次数不变；缺 sessionId → -32602
      const spawnCalls19 = readFileSync(argsLog, 'utf8').trim().split('\n').filter(Boolean).length
      const promptsBefore19 = mock.prompts.length
      const bind = await rpc(base, 'pool/spawn', {
        profile: 'explore-mvp', strategy: 'binding-mode', binding: { sessionId: 'session-deadbeef' },
      })
      const bindP = mock.prompts.at(-1)?.payload
      const bindMissing = await rpc(base, 'pool/spawn', { profile: 'explore-mvp', strategy: 'binding-mode' })
      const spawnCallsAfter19 = readFileSync(argsLog, 'utf8').trim().split('\n').filter(Boolean).length
      ok('T19a binding-mode（信封入在飞 session，与 incubateDsh 同形制）',
        bind.body.result?.receipts?.[0]?.target === 'binding'
          && bind.body.result.receipts[0].name === 'explore-mvp'
          && bind.body.result.receipts[0].version === 2
          && bind.body.result.receipts[0].sessionId === 'session-deadbeef'
          && bind.body.result.receipts[0].injected === true
          && bindP?.sessionId === 'session-deadbeef' && bindP?.mode === 'queue'
          && (bindP?.content?.[0]?.text ?? '') === `ORCA-CB] PROFILE-INJECT] explore-mvp@v2\n${storedMd17}`)
      ok('T19b binding-mode 不 spawn + 缺 binding.sessionId → -32602',
        mock.prompts.length === promptsBefore19 + 1
          && spawnCallsAfter19 === spawnCalls19
          && bindMissing.body.error?.code === -32602 && /binding\.sessionId/.test(bindMissing.body.error?.message))

      // T20 strategy 缺省=default 单回执；非法 strategy → -32602；unknown profile → -32602
      const def20 = await rpc(base, 'pool/spawn', { profile: 'explore-mvp' })
      const badStrategy = await rpc(base, 'pool/spawn', { profile: 'explore-mvp', strategy: 'cascade' })
      const unknown20 = await rpc(base, 'pool/spawn', { profile: 'no-such-profile' })
      ok('T20 缺省 default 单回执（targets 缺省 dsh）/非法 strategy/unknown profile → -32602',
        def20.body.result?.receipts?.length === 1 && def20.body.result.receipts[0].target === 'dsh'
          && def20.body.result.receipts[0].version === 2
          && badStrategy.body.error?.code === -32602 && /invalid strategy/.test(badStrategy.body.error?.message)
          && unknown20.body.error?.code === -32602 && /unknown profile/.test(unknown20.body.error?.message))

      // T21 queen 守卫：库存 vector19.agent_role='queen' → -32000 拒 spawn
      await rpc(base, 'incubate', {
        name: 'queen-mother', targets: ['dry'],
        projection: { agents_md: GOOD_MD, profile_json: { scenario: '派生', vector19: { agent_role: 'queen' } }, description: 'q' },
      })
      const qs21 = await rpc(base, 'pool/spawn', { profile: 'queen-mother' })
      ok('T21 queen 守卫（agent_role=queen → -32000 拒 spawn）',
        qs21.body.error?.code === -32000 && /queen/.test(qs21.body.error?.message))
    } finally {
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      await mock.stop()
    }

    // ---- T22–T28 · N10-T3 pool/export + lineage + revalidate（OF-013；env 注入临时目录，零 ~/.dsh 写）----

    const presetsDir = join(dir, 'presets-out')
    const maestroAssets = join(dir, 'maestro-assets')
    for (const sub of ['skills', 'bin', 'plugins']) mkdirSync(join(maestroAssets, sub), { recursive: true })
    const templatePath = join(maestroAssets, 'agent.cordis.yml')
    writeFileSync(templatePath, SYNTHETIC_TEMPLATE)
    const ENV3_KEYS = ['A2A_PRESETS_DIR', 'A2A_PRESET_TEMPLATE']
    const savedEnv3 = Object.fromEntries(ENV3_KEYS.map((k) => [k, process.env[k]]))
    process.env.A2A_PRESETS_DIR = presetsDir
    process.env.A2A_PRESET_TEMPLATE = templatePath
    try {
      // 存底 + 首次导出（RPC 面：profiles.get → exportDshPreset → recordRun op:pool-export）
      await rpc(base, 'incubate', {
        name: 'export-probe', targets: ['dry'],
        projection: { agents_md: GOOD_MD, profile_json: { scenario: '导出' }, description: '探索型 MVP 助手。第二句不取。' },
      })
      const ex22 = await rpc(base, 'pool/export', { name: 'export-probe' })
      const r22 = ex22.body.result?.export
      const expDir = join(presetsDir, 'export-probe')
      ok('T22a export 基本面（目录+两文件+回执五键）',
        r22?.target === 'dsh-preset' && r22?.name === 'export-probe' && r22?.version === 1
          && r22?.dir === expDir && existsSync(r22?.presetYml) && existsSync(r22?.cordisYml)
          && existsSync(join(expDir, 'preset.yml')) && existsSync(join(expDir, 'agent.cordis.yml')))

      const storedMd22 = readFileSync(join(profileRoot, 'export-probe', 'AGENTS.md'), 'utf8')
      const generated22 = readFileSync(join(expDir, 'agent.cordis.yml'), 'utf8')
      const presetRaw22 = readFileSync(join(expDir, 'preset.yml'), 'utf8')
      const presetKeys = presetRaw22.trim().split('\n').map((l) => l.match(/^([a-z]+): /)?.[1])
      const jsLines = SYNTHETIC_TEMPLATE.split('\n').filter((l) => l.includes('!!js'))
      ok('T22b preset.yml 仅显式键 + 一句话派生显示名',
        JSON.stringify(presetKeys) === JSON.stringify(['name', 'description'])
          && /^name: 探索型 MVP 助手。$/m.test(presetRaw22)
          && /^description: 探索型 MVP 助手。$/m.test(presetRaw22))
      ok('T22c persona 内嵌 AGENTS.md 全文（缩进后逐字节可还原）+ 模板正文被替换',
        recoverPersonaText(generated22) === storedMd22.replace(/\n$/, '')
          && !generated22.includes('TEMPLATE-ONLY BODY'))
      ok('T22d !!js 平台条件行与 group/isolate 块逐字节保真（硬规则③）',
        jsLines.every((l) => generated22.split('\n').includes(l))
          && ['- id: planning', '  name: cordis:group', '  group: true', '  isolate:', '    planMode: true']
            .every((l) => generated22.split('\n').includes(l)))
      const hist22 = readFileSync(join(profileRoot, 'export-probe', 'history.jsonl'), 'utf8')
        .trim().split('\n').map((l) => JSON.parse(l))
      ok('T22e recordRun op:pool-export',
        hist22.some((h) => h.op === 'pool-export' && h.version === 1 && typeof h.dir === 'string'))

      // T23 slug/存在性守卫：非法名（store 不可能产出 → 直测模块）；重复导出抛错；force 覆盖
      let slugErr = null
      try {
        await exportDshPreset({ profile: { name: 'Bad_Name', version: 1, agentsMd: GOOD_MD }, presetsDir, templatePath })
      } catch (e) { slugErr = e }
      const dup23 = await rpc(base, 'pool/export', { name: 'export-probe' })
      const force23 = await rpc(base, 'pool/export', { name: 'export-probe', force: true })
      const oldDirs23 = readdirSync(presetsDir).filter((e) => e.startsWith('export-probe.old-'))
      ok('T23 slug/存在性守卫（非法名抛错/重复 -32000/force 覆盖+旧目录归档）',
        /invalid preset id/.test(String(slugErr?.message))
          && dup23.body.error?.code === -32000 && /already exists/.test(dup23.body.error?.message)
          && force23.body.result?.export?.dir === expDir
          && existsSync(join(expDir, 'preset.yml')) && existsSync(join(expDir, 'agent.cordis.yml'))
          && oldDirs23.length === 1 && existsSync(join(presetsDir, oldDirs23[0], 'preset.yml')))

      // T24 '{{' 消毒断言：抛错且不落盘（fail-loud，先于一切写动作）
      let poisonErr = null
      try {
        await exportDshPreset({
          profile: { name: 'poison-probe', version: 1, agentsMd: GOOD_MD + '\n Poison: {{evil}}\n' },
          presetsDir, templatePath,
        })
      } catch (e) { poisonErr = e }
      ok("T24 '{{' 断言（抛错不落盘）",
        /hard rule #2/.test(String(poisonErr?.message))
          && !existsSync(join(presetsDir, 'poison-probe'))
          && !readdirSync(presetsDir).some((e) => e.includes('.tmp-')))

      // T25 原子落位：终态两文件齐备 + 无 <name>.tmp-<pid> 残留（目录级 tmp+rename）
      ok('T25 原子落位（两文件齐备+无 tmp 残留）',
        existsSync(join(expDir, 'preset.yml')) && existsSync(join(expDir, 'agent.cordis.yml'))
          && !readdirSync(presetsDir).some((e) => e.includes('.tmp-')))

      // T26 软链资产：skills/bin/plugins 指向 assetsFrom（= dirname(templatePath)）
      const linked = ['skills', 'bin', 'plugins'].map((a) => join(expDir, a))
      ok('T26 软链资产（skills/bin/plugins 软链存在且指向 assetsFrom）',
        linked.every((p) => existsSync(p) && lstatSync(p).isSymbolicLink())
          && linked.every((p, i) => readlinkSync(p) === join(maestroAssets, ['skills', 'bin', 'plugins'][i]))
          && !existsSync(join(expDir, 'README.md')))

      // T27 incubate lineage 透传：与缺省 template 合并落 meta.lineage，多余键透传
      await rpc(base, 'incubate', {
        name: 'queen-derived', targets: ['dry'],
        lineage: { 'derived-by': 'queen', parent: 'x' },
        projection: { agents_md: GOOD_MD, profile_json: { scenario: '派生' }, description: '派生物' },
      })
      const got27 = await rpc(base, 'profiles/get', { name: 'queen-derived' })
      const lin27 = got27.body.result?.profile?.meta?.lineage
      ok('T27 lineage 透传（derived-by/parent 落 meta.lineage + 缺省 template 合并）',
        lin27?.['derived-by'] === 'queen' && lin27?.parent === 'x'
          && lin27?.template === 'spawnAgentPrompt@v0.1')

      // T28 profiles/revalidate：好文 pass、坏文 fail（strictGates）、gatesFn 未配置 -32000
      const rawStore = createProfileStore(profileRoot)
      await rawStore.save({ name: 'drifty-doc', agentsMd: '# bad\nD7 泄漏。\n', profile: {}, targets: ['dry'] })
      const good28 = await rpc(base, 'profiles/revalidate', { name: 'queen-derived' })
      const bad28 = await rpc(base, 'profiles/revalidate', { name: 'drifty-doc' })
      const hist28 = readFileSync(join(profileRoot, 'drifty-doc', 'history.jsonl'), 'utf8')
        .trim().split('\n').map((l) => JSON.parse(l))
      ok('T28a profiles/revalidate（好文 pass/坏文 fail+violations+history 落账）',
        good28.body.result?.drift === 'pass'
          && bad28.body.result?.drift === 'fail' && bad28.body.result?.violations?.gate1
          && hist28.some((h) => h.op === 'revalidate' && h.drift === 'fail'))
      const nogates = await activate({ port: 0, profileRoot: join(dir, 'p3'), stateDir: join(dir, 's3') })
      try {
        const ng28 = await rpc(`http://127.0.0.1:${nogates.port}`, 'profiles/revalidate', { name: 'any' })
        ok('T28b gatesFn 未配置 → -32000', ng28.body.error?.code === -32000 && /gates not configured/.test(ng28.body.error?.message))
      } finally {
        nogates.stop()
      }
    } finally {
      for (const [k, v] of Object.entries(savedEnv3)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
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
