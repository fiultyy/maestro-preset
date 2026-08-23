//
// SPDX-License-Identifier: BSD 2-Clause License
//
// incubators/real.js — 三个真实孵化适配器（WS2 §5；docs/kg/02-ws2-a2a-profile.md）。
//
// dsh    : session-spawn（session.create+rename+fleet 登记）→ /api/session.prompt 注入
//         （W5.1 扩展：role doctrine 段前置 + fleet 登记项扩 role/project/mailbox/profile_version/spawned_at）
//
// 幂等：同名同版本已孵化 → 直接返回现回执，不重复 spawn/写文件。

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile, rename, mkdir, access } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

const run = promisify(execFile)

const HOME = homedir()
// 调用时求值（env 可覆写，selftest 注入 mock 用）；缺省与现行常量完全一致
const dshPort = () => process.env.DSH_PORT ?? '3080'
const sessionSpawnPath = () => process.env.A2A_SESSION_SPAWN ?? join(HOME, '.dsh/maestro/bin/session-spawn')
const fleetPath = () => process.env.MAESTRO_FLEET ?? join(HOME, '.dsh/maestro/fleet.json')
const OMP_CONFIG = process.env.OMP_CONFIG ?? join(HOME, '.config/opencode/oh-my-opencode.json')
const CLAUDE_AGENTS_DIR = process.env.CLAUDE_AGENTS_DIR ?? join(HOME, '.claude/agents')

async function fileExists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function rpc(method, payload) {
  // 与 maestro session-spawn/session-send 同 wire 格式（loopback /api/<method>）。
  const res = await fetch(`http://127.0.0.1:${dshPort()}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: crypto.randomUUID(),
      method,
      payload,
    }),
  })
  const body = await res.json()
  const result = body.result ?? body
  if (!result.ok) throw new Error(`${method} failed: ${JSON.stringify(result.error ?? result)}`)
  return result.value
}

/**
 * role doctrine 段（N6§1.2 条款 + §1.6 唤醒模型；注入体 = doctrine 在前 + agentsMd 在后）。
 * worker 无 doctrine（现行零变化）；supervisor 预留（W5.4 后视需要展开）。
 */
function roleDoctrine(role, ext) {
  const mailboxLine = `- 回合首动作：check-messages ${ext.mailbox} --timeout-ms 快照排空邮箱取正文（推唤醒仅触发回合，正文一律走邮箱）。`
  if (role === 'liaison') return [
    '## Role Doctrine — liaison（对接 agent）',
    '',
    '- 语义收敛：上游语义指令 → 稳定指令（自包含、指代全展开、幂等可重放）。',
    '- 两阶段应答：先回受理回执 {status:"accepted", run_id, ref, credentials}；终稿以 "Agent Final Message": 前缀行起首。',
    '- 信封纪律：所有对外消息 body 以 [ref:<ref>] 前缀。',
    '- 凭证回显：【凭证…】逐字回显，不得改写。',
    mailboxLine,
    '',
  ].join('\n')
  if (role === 'manager') return [
    '## Role Doctrine — manager（域编排）',
    '',
    `- 域职责边界：只受理 project=${ext.project || '(未指定)'} 域内任务。`,
    '- 车道选择：终端/工作树类 → orca 车道；消息 DAG/轻量 fan-out → dais 车道。',
    '- 拆分产物 = 子任务 + --dep 依赖表。',
    '- 等待纪律：worker_done 块匹配等待（免轮询）。',
    '- 异常上抛：gate 阻塞 → resolve-gate；wait-blocked → scan-wait-blocked；超时 → 上抛 supervisor。',
    mailboxLine,
    '',
  ].join('\n')
  if (role === 'supervisor') return [
    '## Role Doctrine — supervisor（预留）',
    '',
    '- 超时受理与逐级上抛裁决（role 预留：W5.4 后视需要展开）。',
    '',
  ].join('\n')
  return ''
}

/**
 * dsh 孵化：spawn 命名会话 + 首回合注入（W5.1 扩展 N6§1.4/§1.5）。
 * ctx: { name, version, agentsMd, purpose?, preset?, role?, project?, mailbox? }
 * 扩展路径（ctx.role 存在，由 http-server 在显式传参或 role-target 时注入）：
 *   purpose 携 role；注入体 = role doctrine 段 + agentsMd；fleet 登记项扩五键；
 *   返回 target:'dsh-<role>' + mailbox/role/project。缺省（无 role）与现行完全一致。
 * session.prompt payload 形制对齐 loopback-sink.js（content 数组 + 完整 sessionId）。
 */
export async function incubateDsh(ctx) {
  const { name, version, agentsMd, preset = 'maestro' } = ctx
  const ext = ctx.role !== undefined
    ? { role: ctx.role, project: ctx.project ?? '', mailbox: ctx.mailbox ?? `agent_${name}` }
    : null
  const purpose = ctx.purpose ?? (ext ? `${ext.role} for voice orchestration` : 'voice-head incubated agent')
  const marker = `vh-${name}`
  // session-spawn 输出末行含 4 位 code（sessionId 前 4 hex）
  const { stdout } = await run(sessionSpawnPath(), [preset, marker, purpose])
  const code = (stdout.trim().match(/\b([0-9a-f]{4})\b/g) ?? []).pop()
  if (!code) throw new Error(`session-spawn produced no code: ${stdout.trim().slice(-120)}`)
  const sessionId = await resolveSessionId(code)
  // 首回合注入：信封前缀复用 loopback-sink 形制（ORCA-CB]）；role doctrine 在前，行为准则在后
  const doctrine = ext ? roleDoctrine(ext.role, ext) : ''
  const injectBody = doctrine ? doctrine + '\n' + agentsMd : agentsMd
  const prompt = `ORCA-CB] PROFILE-INJECT] ${name}@v${version}\n${injectBody}`
  await rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: prompt }] })
  if (ext) {
    // fleet 登记项扩展（N6§1.5）：role/project/mailbox/profile_version/spawned_at
    await extendFleetEntry(code, {
      role: ext.role,
      project: ext.project,
      mailbox: ext.mailbox,
      profile_version: version,
      spawned_at: Date.now(),
    })
  }
  return ext
    ? { target: `dsh-${ext.role}`, name, version, code, sessionId, mailbox: ext.mailbox, role: ext.role, project: ext.project, preset, marker }
    : { target: 'dsh', name, version, code, sessionId, preset, marker }
}

/** fleet 条目定位：key==code / sessionId 前缀匹配（现行 resolveSessionId 反查规则原样）。 */
function findFleetEntry(fleet, code) {
  for (const [key, ent] of Object.entries(fleet.fleet ?? {})) {
    const sid = ent.sessionId ?? ''
    if (key === code || sid === `session-${code}` || sid.startsWith('session-' + code)) {
      return { ent, sessionId: sid.startsWith('session-') ? sid : `session-${code}` }
    }
  }
  return null
}

async function readFleet() {
  return JSON.parse(await readFile(fleetPath(), 'utf8'))
}

async function resolveSessionId(code) {
  // session-spawn 的 rename 已把 code 写进标题；sessionId 完整值经 fleet.json 反查。
  const hit = findFleetEntry(await readFleet(), code)
  if (!hit) throw new Error(`cannot resolve sessionId for code ${code} in fleet.json`)
  return hit.sessionId
}

/** fleet 扩展键合并写（temp+rename 原子写，形制对齐 ProfileStore 纪律）。 */
async function extendFleetEntry(code, fields) {
  const path = fleetPath()
  const fleet = await readFleet()
  const hit = findFleetEntry(fleet, code)
  if (!hit) throw new Error(`cannot extend fleet entry for code ${code} in fleet.json`)
  Object.assign(hit.ent, fields)
  const tmp = `${path}.tmp-${process.pid}`
  await writeFile(tmp, JSON.stringify(fleet, null, 2) + '\n', 'utf8')
  await rename(tmp, path)
}

/**
 * omp 孵化：注册 agent 路由 + 项目 AGENTS.md。
 * ctx: { name, version, agentsMd, projectRoot, model?, temperature? }
 */
export async function incubateOmp(ctx) {
  const {
    name, version, agentsMd,
    projectRoot = process.cwd(),
    model = 'zhipuai-coding-plan/glm-5',
    temperature = 0.1,
  } = ctx
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(name)) throw new Error(`invalid agent name: ${name}`)

  // 1) oh-my-opencode.json 备份写
  const raw = await readFile(OMP_CONFIG, 'utf8')
  const config = JSON.parse(raw)
  if (config.agents?.[name] && ctx.idempotent) {
    return { target: 'omp', name, version, agent: name, project: projectRoot, reused: true }
  }
  config.agents = config.agents ?? {}
  config.agents[name] = { model, temperature }
  const backup = OMP_CONFIG + `.backup-${Date.now()}`
  await writeFile(backup, raw, 'utf8')
  await writeFile(OMP_CONFIG, JSON.stringify(config, null, 2) + '\n', 'utf8')

  // 2) 项目 AGENTS.md（尾注反向索引：重孵化对账用）
  await mkdir(projectRoot, { recursive: true })
  const agentsPath = join(projectRoot, 'AGENTS.md')
  await writeFile(agentsPath, agentsMd + `\n<!-- x-profile-ref: ${name}@v${version} -->\n`, 'utf8')

  return { target: 'omp', name, version, agent: name, project: projectRoot, configBackup: backup }
}

/**
 * claude 孵化：~/.claude/agents/<name>.md（frontmatter 形制对齐 research-analyst.md）。
 * ctx: { name, version, agentsMd, description?, model?, color? }
 */
export async function incubateClaude(ctx) {
  const { name, version, agentsMd, description = '', model = 'opus', color = 'green' } = ctx
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(name)) throw new Error(`invalid agent name: ${name}`)
  await mkdir(CLAUDE_AGENTS_DIR, { recursive: true })
  const path = join(CLAUDE_AGENTS_DIR, `${name}.md`)
  const existing = await fileExists(path)
  if (existing && ctx.idempotent) {
    return { target: 'claude', name, version, path, reused: true }
  }
  const frontmatter = [
    '---',
    `name: ${name}`,
    `description: "${description.replace(/"/g, '\\"').slice(0, 400) || `${name} agent incubated by voice-head`}"`,
    `model: ${model}`,
    `color: ${color}`,
    '---',
    '',
  ].join('\n')
  await writeFile(path, frontmatter + agentsMd + `\n<!-- x-profile-ref: ${name}@v${version} -->\n`, 'utf8')
  return { target: 'claude', name, version, path }
}

export const realIncubators = { dsh: incubateDsh, omp: incubateOmp, claude: incubateClaude }
