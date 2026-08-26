/**
 * @maestro/persona-axis — 会话级人格轴（host half，polyfill lane）
 *
 * 设计（2026-08-25 定案，v1.2.0 修订）：人格与预设（agent preset）正交。
 *   - A2A 池（a2a-profile-server :8790）是人格唯一源：profiles/get → AGENTS.md，
 *     版本钉死在 meta.version；本插件不把人格 export 成预设。
 *   - 注入路径与 dsh-subagent 给子代理装人格的先例一致：在 agent 作用域注册
 *     systemPrompt.section("deployment:persona")，scoped 层遮蔽 deployment 默认
 *     人格——system prompt 最前段（order 0）被替换，能力段/工具段不动。
 *   - 持久化（v1.2.0）：state/sessions.json 是唯一落账面。早期版本把选择写为
 *     persona/selected 会话事件，而宿主读路径（assertEventsSupported）拒绝
 *     包含未知事件类型的整份日志——写出该事件的会话在宿主重启后无法 resume。
 *     自 v1.2.0 起插件零事件写入；历史日志中的 persona/selected（已补
 *     ignorable:true）仅作只读兜底：state 未命中时从事件轨迹采用。
 *   - 锁定规则：首条消息（turn/start）后不可换。人格位于 prompt 前缀，
 *     中途替换会使 LLM prompt cache 全部作废，且对话身份漂移。
 *
 * RPC（webServer 同源 exact 路由 /persona-axis/rpc，POST JSON）：
 *   persona/list    {}                          → {ok, personas:[{name,version,updated}]}
 *   persona/current {sessionId}                 → {ok, persona:{name,version}|null, pending?}
 *   persona/select  {sessionId, persona|''}     → {ok, persona:{name,version}|null, deferred?}
 *     persona='' → 卸载注入，会话回 deployment 默认人格。
 *   GET /persona-axis/health → {ok, version}    （部署对账）
 *
 * 部署形态： 源码 = maestro-preset 仓 plugins/persona-axis/（唯一源头）；
 * 运行面 = ~/.dsh/plugins/persona-axis/（自包含副本）；
 * ~/.dsh/plugins/polyfill.patch.yml 插入行。红线：DSH 本体零改动。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const name = 'persona-axis'
export const version = '1.2.0'

// 会话级事件与 agent 事件是宿主内置；webServer 提供同源 RPC 路由；
// agents 是宿主 agent 注册表（agentFor 同源 API 的基础）。
export const inject = ['webServer', 'agents']

const A2A_ORIGIN = process.env.A2A_PROFILE_ORIGIN || 'http://127.0.0.1:8790/'
/** 座席如实反映池 roster（人格源唯一 = 池），不做名称族过滤——
 *  早先"只放 queen 族"是池内仅有 queen 时期的临时定案，与
 *  "queen 派生新人格入池 → 会话经座席消费"的工作流冲突（2026-08-25 纠正）。 */
/** 与 dsh-persona / dsh-subagent 对齐：遮蔽 deployment 默认人格段。 */
const PERSONA_SECTION = 'deployment:persona'
const PERSONA_ORDER = 0
/** 插件私有状态目录：
 *   sessions.json — sessionId → {persona, version, text, ts}，人格选择唯一落账面
 *                   （会话事件不可用：宿主读路径拒绝含未知事件类型的日志）。
 *   pending.json  — 延迟生效意图：宿主重启把磁盘上的空白会话搁浅（新进程无
 *                   live agent，GUI 复用该空白会话时 select 报 session-not-found）。
 *                   意图先落盘，agent/created（该会话恢复/续用时触发）消费：
 *                   会话仍空白即装段并转正到 sessions.json，非空白则弃。 */
const STATE_DIR = join(homedir(), '.dsh', 'plugins', 'persona-axis', 'state')
const SESSIONS_PATH = join(STATE_DIR, 'sessions.json')
const PENDING_PATH = join(STATE_DIR, 'pending.json')

function apply (ctx) {
  /** sessionId → section disposer（换人格/卸载时释放，防 scoped 层同名冲突）。 */
  const installed = new Map()

  const loadJson = (path, fallback) => {
    try { return JSON.parse(readFileSync(path, 'utf8')) || fallback } catch { return fallback }
  }
  const saveJson = (path, value) => {
    try {
      mkdirSync(STATE_DIR, { recursive: true })
      writeFileSync(path, JSON.stringify(value, null, 2))
    } catch (error) {
      ctx.logger.warn(`persona-axis: persist state failed: ${String(error)}`)
    }
  }
  const loadSessions = () => loadJson(SESSIONS_PATH, {})
  const loadPending = () => loadJson(PENDING_PATH, {})
  const clearPending = (sessionId) => {
    const pending = loadPending()
    if (pending[sessionId]) {
      delete pending[sessionId]
      saveJson(PENDING_PATH, pending)
    }
  }

  const blank = (session) =>
    !session.events.some((e) => e?.type === 'turn/start')

  /** 只读兜底：v1.1.x 写入日志的 persona/selected（已补 ignorable:true）。
   *  仅在 sessions.json 未命中时采用，绝不回写事件。 */
  const lastPersonaEvent = (session) => {
    for (let i = session.events.length - 1; i >= 0; i -= 1) {
      const e = session.events[i]
      if (e?.type === 'persona/selected') return e.data
    }
    return undefined
  }

  /** 恢复一个会话的人格注入：sessions.json 为准，事件轨迹只读兜底。 */
  const restoreFrom = (agent) => {
    const state = loadSessions()[agent.id]
    if (state !== undefined) {
      if (state.persona === null) return
      uninstallSection(agent.id)
      installed.set(agent.id, installSection(agent, state.text))
      return
    }
    const pick = lastPersonaEvent(agent.session)
    if (pick !== undefined) {
      if (pick.persona === null) return
      uninstallSection(agent.id)
      installed.set(agent.id, installSection(agent, pick.text))
    }
  }

  async function a2a (method, params) {
    const res = await fetch(A2A_ORIGIN, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'persona-' + Date.now(), method, params: params || {} })
    })
    if (!res.ok) throw new Error('a2a http ' + res.status)
    const data = await res.json()
    if (data.error) throw new Error(data.error.message || 'a2a error')
    return data.result
  }

  /** 在 agent 作用域注册人格段（遮蔽全局），返回 disposer。 */
  function installSection (agent, text) {
    return agent.ctx.systemPrompt.section({ name: PERSONA_SECTION, order: PERSONA_ORDER, text })
  }

  function uninstallSection (sessionId) {
    const dispose = installed.get(sessionId)
    if (dispose === undefined) return
    installed.delete(sessionId)
    try { dispose() } catch { /* scope already gone */ }
  }

  /** 冷恢复 + 新建：agent/created 在创建与 resume 都发。先按 state/事件恢复；
   *  无任何轨迹时消费延迟生效意图（宿主重启搁浅的空白会话）。
   *  零事件写入：意图转正只写 sessions.json。 */
  ctx.on('agent/created', ({ agent }) => {
    try {
      restoreFrom(agent)
      const intent = loadPending()[agent.id]
      if (!intent) return
      clearPending(agent.id)
      if (!blank(agent.session)) {
        ctx.logger.warn(`persona-axis: deferred intent for "${agent.id}" dropped (session not blank)`)
        return
      }
      uninstallSection(agent.id)
      installed.set(agent.id, installSection(agent, intent.text))
      const sessions = loadSessions()
      sessions[agent.id] = {
        persona: intent.persona, version: intent.version, text: intent.text,
        ts: new Date().toISOString()
      }
      saveJson(SESSIONS_PATH, sessions)
      ctx.logger.info(`persona-axis: deferred intent applied for "${agent.id}" (${intent.persona} v${intent.version})`)
    } catch (error) {
      ctx.logger.warn(`persona-axis: restore for "${agent.id}" failed: ${String(error)}`)
    }
  })
  ctx.on('agent/disposed', ({ agent }) => {
    // scoped layer 随 agent 消亡整体清理；这里只防 Map 泄漏。
    installed.delete(agent.id)
  })

  const findAgent = (sessionId) => {
    const agents = ctx.get('agents')
    const agent = agents?.get(sessionId)
    if (agent === undefined) {
      const err = new Error(`session "${sessionId}" is not live`)
      err.code = 'session-not-found'
      throw err
    }
    return agent
  }

  async function listPersonas () {
    const result = await a2a('profiles/list', {})
    const profiles = result?.profiles || []
    return {
      personas: profiles.map((p) => ({
        name: p.name, version: p.version, updated: p.updated
      }))
    }
  }

  function currentPersona (sessionId) {
    let agent
    try {
      agent = findAgent(sessionId)
    } catch {
      const intent = loadPending()[sessionId]
      if (intent) return { persona: { name: intent.persona, version: intent.version }, pending: true }
      const state = loadSessions()[sessionId]
      if (state && state.persona !== null) return { persona: { name: state.persona, version: state.version } }
      return { persona: null }
    }
    const state = loadSessions()[sessionId]
    const pick = state !== undefined ? state : lastPersonaEvent(agent.session)
    if (pick === undefined || pick.persona === null) return { persona: null }
    return { persona: { name: pick.persona, version: pick.version } }
  }

  /** 池取档 + 校验（live 安装与延迟意图共用）。 */
  async function fetchPersona (personaName) {
    // 人格源唯一：A2A 池；text 全文进 state/意图，版本钉死、重建零依赖。
    // profiles/get 返回 {profile:{name,version,agentsMd,...}}。
    const out = await a2a('profiles/get', { name: personaName })
    const record = out?.profile
    if (!record || record.name !== personaName) {
      const err = new Error(`persona "${personaName}" not found in pool`)
      err.code = 'persona-not-found'
      throw err
    }
    const text = record.agentsMd || ''
    if (!text.trim()) {
      const err = new Error(`persona "${personaName}" has empty AGENTS.md`)
      err.code = 'persona-empty'
      throw err
    }
    return { record, text, version: record.version ?? record.meta?.version ?? null }
  }

  const writeSelection = (sessionId, entry) => {
    const sessions = loadSessions()
    if (entry === null) delete sessions[sessionId]
    else sessions[sessionId] = { ...entry, ts: new Date().toISOString() }
    saveJson(SESSIONS_PATH, sessions)
    clearPending(sessionId)
  }

  async function selectPersona (sessionId, personaName) {
    let agent
    try {
      agent = findAgent(sessionId)
    } catch {
      // 非 live（典型：宿主重启后 GUI 复用的搁浅空白会话）——落延迟意图。
      if (!personaName) {
        clearPending(sessionId)
        writeSelection(sessionId, null)
        return { persona: null }
      }
      const { record, text, version } = await fetchPersona(personaName)
      const pending = loadPending()
      pending[sessionId] = { persona: record.name, version, text, ts: new Date().toISOString() }
      saveJson(PENDING_PATH, pending)
      return { persona: { name: record.name, version }, deferred: true }
    }
    if (!blank(agent.session)) {
      const err = new Error(`session "${sessionId}" has already started; its persona is fixed`)
      err.code = 'persona-locked'
      throw err
    }
    if (!personaName) {
      uninstallSection(agent.id)
      writeSelection(sessionId, null)
      return { persona: null }
    }
    const { record, text, version } = await fetchPersona(personaName)
    uninstallSection(agent.id)
    installed.set(agent.id, installSection(agent, text))
    writeSelection(sessionId, { persona: record.name, version, text })
    return { persona: { name: record.name, version } }
  }

  async function handleRpc (body) {
    const method = body?.method
    const params = body?.params || {}
    if (method === 'persona/list') return listPersonas()
    if (method === 'persona/current') return currentPersona(String(params.sessionId || ''))
    if (method === 'persona/select') {
      return selectPersona(String(params.sessionId || ''), params.persona ? String(params.persona) : '')
    }
    const err = new Error(`unknown method "${String(method)}"`)
    err.code = 'method-not-found'
    throw err
  }

  function sendJson (res, status, payload) {
    const body = JSON.stringify(payload)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(body)
  }

  ctx.webServer.register({
    kind: 'exact',
    path: '/persona-axis/health',
    handler: (req, res) => sendJson(res, 200, { ok: true, name, version, a2a: A2A_ORIGIN })
  })

  ctx.webServer.register({
    kind: 'exact',
    path: '/persona-axis/rpc',
    handler: async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
      try {
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        const result = await handleRpc(body)
        sendJson(res, 200, { ok: true, ...result })
      } catch (error) {
        sendJson(res, 200, {
          ok: false,
          code: error?.code || 'internal',
          error: String(error?.message || error)
        })
      }
    }
  })

  ctx.logger.info(`persona-axis ${version} up (a2a=${A2A_ORIGIN})`)
}

export { apply }
