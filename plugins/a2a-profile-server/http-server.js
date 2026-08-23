//
// SPDX-License-Identifier: BSD 2-Clause License
//
// http-server.js — 内部契约 A2A HTTP 面（loopback；docs/kg/02-ws2-a2a-profile.md §2）。
//
//   GET /.well-known/agent-card.json
//   POST /  JSON-RPC 2.0：
//     message/send  {message:{parts:[{type:"text",text}]}, context:{source, ref}}
//     tasks/get     {taskId}
//     tasks/cancel  {taskId}
//     incubate      {name, targets:[...], projection:{agents_md, profile_json, description},
//                   role?, project?, mailbox?}   // W5.1 扩参（N6§1.3）；targets += dsh-liaison/dsh-manager
//     pool/spawn   {profile:'*new*'|<已有名>, strategy?='default'|'fanout-sub'|'binding-mode',
//                   name?(*new* 必填), scenario?, role?, targets?=['dsh'], mailbox?, project?,
//                   count?=3(1..8 fanout), binding?:{sessionId}(binding-mode 必填),
//                   projection?(*new* 必填：agents_md/profile_json/description/template)}
//                   ← N10-T1 池选型 spawn（OF-012；docs/10 §1）：具名复用版本钉死不 save；
//                     queen 只派生不 spawn（-32000）；三策略分派见 incubators/real.js
//     pool/export  {name, force?}                       ← N10-T3 dsh 预设导出（OF-013；docs/10 §2）：
//                   profiles.get → exportDshPreset（preset.yml+agent.cordis.yml persona 内嵌
//                   + maestro 资产软链，目录级原子 tmp+rename）→ recordRun op:'pool-export'
//     profiles/revalidate {name}                        ← 库内 AGENTS.md 重跑三门（gatesFn 未配置 -32000）
//     profiles/list {}
//     profiles/get  {name}
//     agents/registry {}                          ← W5.2 router 三 RPC（N6§2.4；需注入 router）
//     agents/send     {to, from, ref, type, body}   // scope 校验→push(session-send)/mailbox(dais)
//     agents/inbox    {mailbox}                     // 只读快照不消费

import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { appendFile, mkdir, stat, rename } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fanoutDsh, bindProfile } from './incubators/real.js'
import { exportDshPreset } from './exporters/dsh-preset.js'

const runBin = promisify(execFile)
const HOME = homedir()

const MAX_BODY_BYTES = 256 * 1024
const INTERNAL_VERSION = 'internal-1'
// W5.1 incubate 扩参（N6§1.3）：role 合法值 + role 孵化目标映射（复用 dsh 孵化器）
const ROLE_VALUES = ['liaison', 'manager', 'worker', 'supervisor']
// N10-T4 集成接缝：queen（OF-013 派生者）仅在 incubate 面合法——queen 会话由运营者
// 经 incubate 直建（doctrine 已由投影器嵌进产物）；pool/spawn 拒 queen（守卫语义不变）。
const INCUBATE_ROLE_VALUES = [...ROLE_VALUES, 'queen']
const ROLE_TARGETS = { 'dsh-liaison': 'liaison', 'dsh-manager': 'manager' }
// N10-T1 pool/spawn（OF-012）：策略面 + fanout 约束（count 1..8、dsh 族目标）
const STRATEGY_VALUES = ['default', 'fanout-sub', 'binding-mode']
const FANOUT_TARGETS = ['dsh', 'dsh-liaison', 'dsh-manager']
const NEW_PROFILE = '*new*'

// ---- W5.2 router（N6§2.4–2.5；VO-004）----

/** router 消息类型集（KG 06 §2.4）；推模式经 session-send 透传进固定 DSHMSG 信封。 */
const ROUTER_TYPES = ['notify', 'steer', 'ping']
const ROUTER_ROTATE_MAX_BYTES = 1024 * 1024 // 对齐 task-store 轮转阈值

/** RPC 可映射错误：branch 捕获后按 rpcCode 返 JSON-RPC error（缺省 -32000）。 */
class RouterError extends Error {
  constructor(message, rpcCode = -32000) {
    super(message)
    this.rpcCode = rpcCode
  }
}

// 底座 bin（调用时求值，env 可覆写；缺省与 maestro/dais 现网路径一致）
const sessionSendBin = () => process.env.A2A_SESSION_SEND ?? join(HOME, '.dsh/maestro/bin/session-send')
const daisBin = () => process.env.A2A_DAIS_BIN ?? join(HOME, '.local/bin/dais')
const daisDbPath = () => process.env.A2A_DAIS_DB ?? join(HOME, '.local/share/dais/data.sqlite')
const daisRunId = () => process.env.A2A_DAIS_RUN_ID ?? 'router'

/** 信封/正文双格式的 ref 提取（DSHMSG] json 行 · [ref:X] 前缀；均不中 → '-'）。 */
function extractRef(body) {
  if (body.startsWith('DSHMSG]')) {
    try { return JSON.parse(body.slice('DSHMSG]'.length)).ref ?? '-' } catch { return '-' }
  }
  const m = body.match(/^\[ref:([^\]]+)\]/)
  return m ? m[1] : '-'
}

/**
 * createRouter({ registry, journalPath, sessionSend?, dais?, inboxReader?,
 *               heavyweightBytes?, grants? }) —— router 三 RPC 的逻辑体。
 *   registry:     registry.js 实例（在册/状态/心跳唯一状态源）。
 *   sessionSend:  async (args[]) => stdout —— 缺省 execFile session-send bin
 *                 （`session-send <from> <to> <type> <ref> <body>`，CLI 自建 DSHMSG] 固定信封）。
 *   dais:         async (args[]) => stdout —— 缺省 execFile dais orchestration send-message。
 *   inboxReader:  async (mailbox) => rows —— 缺省只读 sqlite（mode=ro 纪律）快照 messages
 *                 表 read=0 行；check-messages 为消费语义，不可用于只读 inbox。
 *   grants:       [{from,to,ts}] 或 async () => [...] —— 跨 project 显式授权（KG §2.5）。
 * 红线（G5 同源）：只经底座注入固定信封格式——推模式由 session-send CLI 构造
 * DSHMSG]{from,to,type,ref,body} 单行；重载投递正文 = 同构单行信封；router 绝不
 * 直接 session.prompt 注入任意指令。
 */
export function createRouter({
  registry, journalPath,
  sessionSend = (args) => runBin(sessionSendBin(), args).then(({ stdout }) => stdout),
  dais = (args) => runBin(daisBin(), args).then(({ stdout }) => stdout),
  inboxReader = defaultInboxReader,
  heavyweightBytes = 256,
  grants = [],
}) {
  if (!registry) throw new Error('createRouter: registry required')
  if (!journalPath) throw new Error('createRouter: journalPath required')

  const getGrants = async () => (typeof grants === 'function' ? await grants() : grants)

  async function journal(evt) {
    await mkdir(dirname(journalPath), { recursive: true })
    await appendFile(journalPath, JSON.stringify({ ts: Date.now(), op: 'route', ...evt }) + '\n')
    try {
      const s = await stat(journalPath)
      if (s.size > ROUTER_ROTATE_MAX_BYTES) {
        await rename(journalPath, journalPath + '.1')
      }
    } catch {
      // 轮转失败不致命（对齐 task-store/registry）
    }
  }

  function resolveAgent(key, agents) {
    return agents.find((a) => a.code === key || a.mailbox === key) ?? null
  }

  /** 在册快照（agents/registry 数据源 = registry 内存表）。 */
  async function list() {
    return registry.agents()
  }

  /**
   * agents/send {to, from, ref?, type='notify', body}：
   * scope（同非空 project 或 grants 显式授权，否则 -32000 scope denied）
   * → 轻载/单行 = push（session-send DSHMSG 推注入）；重载/多行 = mailbox（dais 投邮箱）。
   */
  async function send(params) {
    const { to, from, ref = '-', type = 'notify', body } = params ?? {}
    if (!to || !from) throw new RouterError('agents/send requires from and to', -32602)
    if (typeof body !== 'string' || !body.trim()) throw new RouterError('agents/send requires non-empty body', -32602)
    if (!ROUTER_TYPES.includes(type)) {
      throw new RouterError(`invalid type: ${type} (legal: ${ROUTER_TYPES.join('/')})`, -32602)
    }
    const agents = await list()
    const fromA = resolveAgent(from, agents)
    const toA = resolveAgent(to, agents)
    if (!fromA) throw new RouterError(`unknown from agent: ${from}`, -32602)
    if (!toA) throw new RouterError(`unknown to agent: ${to}`, -32602)

    // scope 校验（KG §2.5）：同 project（非空相等）全互通；跨 project 需显式授权记录
    const sameProject = Boolean(fromA.project) && fromA.project === toA.project
    const granted = (await getGrants()).some((g) => g.from === fromA.mailbox && g.to === toA.mailbox)
    if (!sameProject && !granted) {
      await journal({ from: fromA.mailbox, to: toA.mailbox, type, ref, delivered: 'denied' })
      throw new RouterError(
        `scope denied: ${fromA.mailbox}(${fromA.project || '∅'}) → ${toA.mailbox}(${toA.project || '∅'}) cross-project without grant`,
      )
    }

    const heavy = Buffer.byteLength(body, 'utf8') > heavyweightBytes || body.includes('\n')
    // 信封收发双方身份：from = 邮箱句柄；to = fleet code（session-send 的 fleet 解析键）
    const envelope = { from: fromA.mailbox, to: toA.code, type, ref, body }
    try {
      if (!heavy) {
        // 轻载/唤醒：session-send 底座（CLI 构造 DSHMSG] 固定信封；body 单行由模式分流保证）
        await sessionSend([envelope.from, envelope.to, type, ref, body])
        await journal({ from: envelope.from, to: toA.mailbox, type, ref, delivered: 'push' })
        return { delivered: 'push', ackRef: `${ref}@push` }
      }
      // 重载：dais 邮箱投递；正文 = 与推模式同构的单行 DSHMSG] 信封（VO-005 对拍基底）
      const line = 'DSHMSG]' + JSON.stringify(envelope)
      const stdout = await dais([
        'orchestration', 'send-message', daisRunId(), envelope.from, toA.mailbox,
        '--message-type', 'direct', '--subject', 'route', '--body', line,
      ])
      const seq = (String(stdout).match(/seq[=:\s]+(\d+)/) ?? [])[1] ?? '?'
      await journal({ from: envelope.from, to: toA.mailbox, type, ref, delivered: 'mailbox' })
      return { delivered: 'mailbox', ackRef: `${ref}@${seq}` }
    } catch (e) {
      if (e instanceof RouterError) throw e
      await journal({ from: envelope.from, to: toA.mailbox, type, ref, delivered: 'failed', error: String(e?.message ?? e) })
      throw new RouterError(`delivery failed: ${String(e?.message ?? e)}`)
    }
  }

  /** agents/inbox {mailbox}：只读快照不消费（读即消费仅 dais 邮箱侧语义）。 */
  async function inbox(params) {
    const mailbox = params?.mailbox
    if (!mailbox || typeof mailbox !== 'string') throw new RouterError('agents/inbox requires mailbox', -32602)
    let unread
    try {
      unread = await inboxReader(mailbox)
    } catch (e) {
      throw new RouterError(`inbox read failed: ${String(e?.message ?? e)}`)
    }
    return { unread }
  }

  return { list, send, inbox }
}

/**
 * 缺省 inbox 读法：dais 存储 sqlite 只读连接快照（file mode=ro 纪律，零写入路径）。
 * 表假设：messages(seq, sender, recipient, message_type, subject, body, read)；
 * schema 不符时显式抛错（不静默伪造空结果）；live 偏差由 VO-005 对拍收敛。
 */
function defaultInboxReader(mailbox) {
  const db = new DatabaseSync(daisDbPath(), { readOnly: true })
  try {
    const rows = db
      .prepare('SELECT seq, sender, message_type, body FROM messages WHERE recipient = ? AND read = 0 ORDER BY seq')
      .all(mailbox)
    return rows.map((r) => ({ from: r.sender, type: r.message_type, body: r.body, seq: r.seq, ref: extractRef(r.body) }))
  } finally {
    db.close()
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function isLoopback(address) {
  if (typeof address !== 'string') return false
  if (address.includes(':')) {
    const norm = address.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, '$1')
    return norm.includes('.') ? isLoopback(norm) : norm === '::1'
  }
  return address === '127.0.0.1' || address.startsWith('127.')
}

/**
 * createHttpServer({ tasks, profiles, token, executor, gatesFn, incubate, router })
 * executor: async (task) => void —— message/send 后的执行桥（W2.4 前为 echo 执行器）。
 * gatesFn:  (agentsMd) => { passed, violations } —— incubate 前三门（可空 = 跳过）。
 * router:   createRouter() 产物（可空 = agents/* 三 RPC 返 -32000 router not configured）。
 */
export function createHttpServer({ tasks, profiles, token, executor, gatesFn, incubate, router }) {
  async function handleRpc(payload) {
    const method = payload.method
    const params = payload.params ?? {}
    const id = payload.id ?? null

    if (method === 'message/send') {
      const text = (params.message?.parts ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('\n')
      if (!text.trim()) return rpcError(id, -32602, 'empty text part')
      const task = await tasks.create({
        intent: text,
        ref: params.context?.ref ?? '-',
        source: params.context?.source ?? 'unknown',
      })
      executor?.(task).catch(async (e) => {
        await tasks.transition(task.id, { state: 'failed', error: String(e?.message ?? e) }).catch(() => {})
      })
      return { jsonrpc: '2.0', id, result: { task: { id: task.id, state: task.state } } }
    }

    if (method === 'tasks/get') {
      const task = await tasks.get(params.taskId)
      if (!task) return rpcError(id, -32602, `unknown taskId: ${params.taskId}`)
      return { jsonrpc: '2.0', id, result: { task } }
    }

    if (method === 'tasks/cancel') {
      const task = await tasks.get(params.taskId)
      if (!task) return rpcError(id, -32602, `unknown taskId: ${params.taskId}`)
      if (['completed', 'failed'].includes(task.state)) {
        return rpcError(id, -32602, `task ${params.taskId} already ${task.state}`)
      }
      const t = await tasks.transition(params.taskId, { state: 'canceled' })
      return { jsonrpc: '2.0', id, result: { task: { id: t.id, state: t.state } } }
    }

    if (method === 'incubate') {
      const agentsMd = params.projection?.agents_md ?? ''
      if (!agentsMd.trim()) return rpcError(id, -32602, 'projection.agents_md required')
      // W5.1 扩参（N6§1.3；缺省即现行语义）：role ∈ {liaison,manager,worker,supervisor,queen(N10-T4)}
      const role = params.role
      if (role !== undefined && !INCUBATE_ROLE_VALUES.includes(role)) {
        return rpcError(id, -32602, `invalid role: ${role} (legal: ${INCUBATE_ROLE_VALUES.join('/')})`)
      }
      if (params.mailbox !== undefined && (typeof params.mailbox !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(params.mailbox))) {
        return rpcError(id, -32602, `invalid mailbox: ${params.mailbox}`)
      }
      if (params.project !== undefined && (typeof params.project !== 'string' || !params.project.trim())) {
        return rpcError(id, -32602, `invalid project: ${params.project}`)
      }
      // N10-T3 queen 派生血缘（docs/10 §2 验收②）：lineage 键与缺省 template 合并落 meta.lineage，
      // 多余键透传保存（derived-by/parent 等）
      if (params.lineage !== undefined && (typeof params.lineage !== 'object' || Array.isArray(params.lineage))) {
        return rpcError(id, -32602, `invalid lineage: ${JSON.stringify(params.lineage)}`)
      }
      const targets = params.targets ?? []
      for (const target of targets) {
        const implied = ROLE_TARGETS[target]
        if (implied && role !== undefined && role !== implied) {
          return rpcError(id, -32602, `role ${role} mismatches target ${target} (implies ${implied})`)
        }
      }
      if (gatesFn) {
        const report = gatesFn(agentsMd)
        if (!report.passed) return rpcError(id, -32000, `gate violations: ${JSON.stringify(report.violations)}`)
      }
      // 有效 role：显式 role 优先；全部 role-target 蕴含同一 role 时采用之
      // （agent_role 落 profile.json 需 profile-store 扩展落盘键，本票范围外——见 VO-002 报告）
      const uniqueImplied = [...new Set(targets.map((t) => ROLE_TARGETS[t]).filter(Boolean))]
      const effectiveRole = role ?? (uniqueImplied.length === 1 ? uniqueImplied[0] : undefined)
      const saved = await profiles.save({
        name: params.name,
        agentsMd,
        profile: {
          ...params.projection.profile_json ?? {},
          description: params.projection.description ?? (params.projection.profile_json ?? {}).description ?? '',
        },
        targets,
        lineage: {
          template: params.projection.template ?? 'spawnAgentPrompt@v0.1',
          ...(params.lineage ?? {}),
        },
      })
      const receipts = []
      for (const target of targets) {
        try {
          const profile = await profiles.get(saved.name)
          const implied = ROLE_TARGETS[target]
          // 扩展仅在显式传参或 role-target 时激活；纯现行调用 ctx 形状不变
          const extend = implied !== undefined || role !== undefined
            || params.mailbox !== undefined || params.project !== undefined
          receipts.push(await incubate({
            name: saved.name,
            version: saved.version,
            target: implied !== undefined ? 'dsh' : target,
            agentsMd,
            description: params.projection.description ?? '',
            idempotent: false,
            profile,
            ...(extend ? {
              role: implied ?? effectiveRole ?? 'worker',
              mailbox: params.mailbox ?? `agent_${saved.name}`,
              project: params.project ?? '',
            } : {}),
          }))
        } catch (e) {
          receipts.push({ target, error: String(e?.message ?? e) })
        }
      }
      await profiles.recordRun(saved.name, { op: 'incubate', version: saved.version, targets })
      return { jsonrpc: '2.0', id, result: { profile: saved, receipts } }
    }

    // ---- N10-T1 pool/spawn（OF-012；docs/10 §1）：池选型面 + 三策略分派 ----

    if (method === 'pool/spawn') {
      const profileName = params.profile
      if (typeof profileName !== 'string' || !profileName.trim()) {
        return rpcError(id, -32602, "profile required ('*new*' | <existing profile name>)")
      }
      const strategy = params.strategy ?? 'default'
      if (!STRATEGY_VALUES.includes(strategy)) {
        return rpcError(id, -32602, `invalid strategy: ${strategy} (legal: ${STRATEGY_VALUES.join('/')})`)
      }
      const role = params.role
      if (role !== undefined && !ROLE_VALUES.includes(role)) {
        return rpcError(id, -32602, `invalid role: ${role} (legal: ${ROLE_VALUES.join('/')})`)
      }
      if (params.mailbox !== undefined && (typeof params.mailbox !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(params.mailbox))) {
        return rpcError(id, -32602, `invalid mailbox: ${params.mailbox}`)
      }
      if (params.project !== undefined && (typeof params.project !== 'string' || !params.project.trim())) {
        return rpcError(id, -32602, `invalid project: ${params.project}`)
      }
      const count = params.count ?? 3
      if (!Number.isInteger(count) || count < 1 || count > 8) {
        return rpcError(id, -32602, `invalid count: ${count} (integer 1..8)`)
      }
      if (strategy === 'binding-mode'
        && (typeof params.binding?.sessionId !== 'string' || !params.binding.sessionId.trim())) {
        return rpcError(id, -32602, 'binding.sessionId required for binding-mode')
      }
      const targets = params.targets ?? ['dsh']
      for (const target of targets) {
        const implied = ROLE_TARGETS[target]
        if (implied && role !== undefined && role !== implied) {
          return rpcError(id, -32602, `role ${role} mismatches target ${target} (implies ${implied})`)
        }
      }
      if (strategy === 'fanout-sub' && targets.some((t) => !FANOUT_TARGETS.includes(t))) {
        return rpcError(id, -32602, `fanout-sub requires dsh-family targets (${FANOUT_TARGETS.join('/')})`)
      }

      // 选型面：*new* = 现行 incubate 全语义（校验+三门+save）；具名 = 库内复用（绝不 save、版本钉死 meta.version）
      let saved = null
      let record = null
      if (profileName === NEW_PROFILE) {
        if (typeof params.name !== 'string' || !params.name.trim()) {
          return rpcError(id, -32602, 'name required for *new* profile')
        }
        const newMd = params.projection?.agents_md ?? ''
        if (!newMd.trim()) return rpcError(id, -32602, 'projection.agents_md required for *new*')
        if (gatesFn) {
          const report = gatesFn(newMd)
          if (!report.passed) return rpcError(id, -32000, `gate violations: ${JSON.stringify(report.violations)}`)
        }
        const pj = params.projection.profile_json ?? {}
        saved = await profiles.save({
          name: params.name,
          agentsMd: newMd,
          profile: {
            ...pj,
            scenario: pj.scenario ?? params.scenario ?? '',
            description: params.projection.description ?? pj.description ?? '',
          },
          targets,
          lineage: { template: params.projection.template ?? 'spawnAgentPrompt@v0.1' },
        })
        record = await profiles.get(saved.name)
      } else {
        record = await profiles.get(profileName)
        if (!record) return rpcError(id, -32602, `unknown profile: ${profileName}`)
      }
      // queen 守卫（docs/10 §2 验⑤前置）：queen 只派生不 spawn
      if (record?.profile?.vector19?.agent_role === 'queen') {
        return rpcError(id, -32000, `queen profile cannot spawn (derive-only): ${record.name}`)
      }

      // 版本钉死：信封/回执/recordRun 一律引用库内 meta.version；AGENTS.md 直接读库注入（逐字节，不重排）
      const { name, version, agentsMd } = record
      const description = record.profile?.description ?? ''
      const storedRole = record.profile?.vector19?.agent_role
      const effectiveRole = role ?? (ROLE_VALUES.includes(storedRole) ? storedRole : undefined)

      const receipts = []
      if (strategy === 'binding-mode') {
        // 策略③：绑定在飞 session（不 spawn），信封与 incubateDsh 完全同形制
        receipts.push(await bindProfile({
          name, version, agentsMd,
          sessionId: params.binding.sessionId,
          role: effectiveRole, project: params.project ?? '', mailbox: params.mailbox,
        }))
      } else if (strategy === 'fanout-sub') {
        // 策略②：N 实例扇出，mailbox = 基名-<i>（1..N）；回执 = N 条数组
        for (const target of targets) {
          const implied = ROLE_TARGETS[target]
          receipts.push(...await fanoutDsh({
            name, version, agentsMd,
            role: implied ?? effectiveRole ?? 'worker',
            project: params.project ?? '',
            mailboxBase: params.mailbox ?? `agent_${name}`,
            profile: record, idempotent: false,
          }, count))
        }
      } else {
        // 策略① default：现行单实例孵化语义（target 分派/回执形状与 incubate 一致）
        for (const target of targets) {
          try {
            const implied = ROLE_TARGETS[target]
            const extend = implied !== undefined || role !== undefined
              || params.mailbox !== undefined || params.project !== undefined || effectiveRole !== undefined
            receipts.push(await incubate({
              name, version,
              target: implied !== undefined ? 'dsh' : target,
              agentsMd, description, idempotent: false, profile: record,
              ...(extend ? {
                role: implied ?? effectiveRole ?? 'worker',
                mailbox: params.mailbox ?? `agent_${name}`,
                project: params.project ?? '',
              } : {}),
            }))
          } catch (e) {
            receipts.push({ target, error: String(e?.message ?? e) })
          }
        }
      }
      await profiles.recordRun(name, { op: 'pool-spawn', version, targets, strategy })
      return {
        jsonrpc: '2.0', id,
        result: { profile: saved ?? { name, version, created: record.meta?.created }, receipts },
      }
    }

    if (method === 'profiles/list') {
      return { jsonrpc: '2.0', id, result: { profiles: await profiles.list() } }
    }

    if (method === 'profiles/get') {
      const p = await profiles.get(params.name)
      if (!p) return rpcError(id, -32602, `unknown profile: ${params.name}`)
      return { jsonrpc: '2.0', id, result: { profile: p } }
    }

    // ---- N10-T3 pool/export + profiles/revalidate（OF-013；docs/10 §2 导出/复验）----

    if (method === 'pool/export') {
      if (typeof params.name !== 'string' || !params.name.trim()) {
        return rpcError(id, -32602, 'name required')
      }
      const record = await profiles.get(params.name)
      if (!record) return rpcError(id, -32602, `unknown profile: ${params.name}`)
      // 导出四硬规则违例（slug/{{/模板缺块/目录已存在）一律 fail-loud → -32000
      try {
        const receipt = await exportDshPreset({ profile: record, force: params.force === true })
        await profiles.recordRun(record.name, { op: 'pool-export', version: record.version, dir: receipt.dir })
        return { jsonrpc: '2.0', id, result: { export: receipt } }
      } catch (e) {
        return rpcError(id, -32000, String(e?.message ?? e))
      }
    }

    if (method === 'profiles/revalidate') {
      if (!gatesFn) return rpcError(id, -32000, 'gates not configured')
      if (typeof params.name !== 'string' || !params.name.trim()) {
        return rpcError(id, -32602, 'name required')
      }
      const record = await profiles.get(params.name)
      if (!record) return rpcError(id, -32602, `unknown profile: ${params.name}`)
      return { jsonrpc: '2.0', id, result: await profiles.revalidate(params.name, gatesFn) }
    }

    // ---- W5.2 router 三 RPC（VO-004；与六 RPC 同形制，router 未装配时显式报状态）----

    if (method === 'agents/registry') {
      if (!router) return rpcError(id, -32000, 'router not configured')
      return { jsonrpc: '2.0', id, result: { agents: await router.list() } }
    }

    if (method === 'agents/send') {
      if (!router) return rpcError(id, -32000, 'router not configured')
      try {
        return { jsonrpc: '2.0', id, result: await router.send(params) }
      } catch (e) {
        return rpcError(id, e instanceof RouterError ? e.rpcCode : -32000, String(e?.message ?? e))
      }
    }

    if (method === 'agents/inbox') {
      if (!router) return rpcError(id, -32000, 'router not configured')
      try {
        return { jsonrpc: '2.0', id, result: await router.inbox(params) }
      } catch (e) {
        return rpcError(id, e instanceof RouterError ? e.rpcCode : -32000, String(e?.message ?? e))
      }
    }
    return rpcError(id, -32601, `method not found: ${method}`)
  }

  const server = createServer(async (req, res) => {
    try {
      if (!isLoopback(req.socket.remoteAddress ?? '')) {
        sendJson(res, 403, { error: 'loopback only' })
        return
      }
      if (req.method === 'GET' && req.url === '/.well-known/agent-card.json') {
        sendJson(res, 200, {
          name: 'voice-head-orchestrator',
          description: 'internal a2a endpoint + base-profile incubator (voice orchestration head)',
          skills: [
            { id: 'dispatch', description: 'fan out a raw intent' },
            { id: 'query', description: 'task status' },
            { id: 'incubate', description: 'project & incubate a base profile' },
            { id: 'pool-spawn', description: 'select profile from pool & spawn with strategy' },
            { id: 'pool-export', description: 'export a pool profile as a dsh preset directory' },
            { id: 'profiles-revalidate', description: 're-run quality gates on a stored profile' },
          ],
          url: 'http://127.0.0.1:8790/',
          version: INTERNAL_VERSION,
        })
        return
      }
      if (req.method === 'POST' && req.url === '/') {
        if (token && req.headers.authorization !== `Bearer ${token}`) {
          sendJson(res, 401, { error: 'bad token' })
          return
        }
        let payload
        try {
          payload = JSON.parse(await readBody(req))
        } catch {
          sendJson(res, 400, { error: 'bad json' })
          return
        }
        sendJson(res, 200, await handleRpc(payload))
        return
      }
      sendJson(res, 404, { error: 'not found' })
    } catch (e) {
      sendJson(res, 500, { error: String(e?.message ?? e) })
    }
  })

  return {
    server,
    /** start(port=0) -> boundPort；0 = 随机端口（selftest 用）。 */
    start: (port = 0) => new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server.address().port))),
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  }
}
