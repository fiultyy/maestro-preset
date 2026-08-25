/**
 * @maestro/persona-axis — 会话级人格轴（host half，polyfill lane）
 *
 * 设计（2026-08-25 定案）：人格与预设（agent preset）正交。
 *   - A2A 池（a2a-profile-server :8790）是人格唯一源：profiles/get → AGENTS.md，
 *     版本钉死在 meta.version；本插件不再把人格 export 成预设。
 *   - 注入路径与 dsh-subagent 给子代理装人格的先例一致：在 agent 作用域注册
 *     systemPrompt.section("deployment:persona")，scoped 层遮蔽 deployment 默认
 *     人格——system prompt 最前段（order 0）被替换，能力段/工具段不动。
 *   - 选择落账为 persona/selected 会话事件（含 text 全文，版本绝对钉死、
 *     重建零依赖），冷恢复在 agent/created（创建与 resume 都发）时从事件
 *     log 重建注入 —— model-visible ⟺ logged，与预设轴同构。
 *   - 锁定规则：首条消息（turn/start）后不可换。人格位于 prompt 前缀，
 *     中途替换会使 LLM prompt cache 全部作废，且对话身份漂移。
 *
 * RPC（webServer 同源 exact 路由 /persona-axis/rpc，POST JSON）：
 *   persona/list    {}                          → {ok, personas:[{name,version,updated}]}
 *   persona/current {sessionId}                 → {ok, persona:{name,version}|null}
 *   persona/select  {sessionId, persona|''}     → {ok, persona:{name,version}|null}
 *     persona='' → 卸载注入，会话回 deployment 默认人格。
 *   GET /persona-axis/health → {ok, version}    （部署对账）
 *
 * 部署形态： 源码 = maestro-preset 仓 plugins/persona-axis/（唯一源头）；
 * 运行面 = ~/.dsh/plugins/persona-axis/（自包含副本）；
 * ~/.dsh/plugins/polyfill.patch.yml 插入行。红线：DSH 本体零改动。
 */

export const name = 'persona-axis'
export const version = '1.0.0'

// 会话级事件与 agent 事件是宿主内置；webServer 提供同源 RPC 路由；
// agents 是宿主 agent 注册表（agentFor 同源 API 的基础）。
export const inject = ['webServer', 'agents']

const A2A_ORIGIN = process.env.A2A_PROFILE_ORIGIN || 'http://127.0.0.1:8790/'
/** 座席只暴露 queen 族（用户定案：池座席 = queen + 不加载）。 */
const SEAT_FAMILY = /^queen(-|$)/
/** 与 dsh-persona / dsh-subagent 对齐：遮蔽 deployment 默认人格段。 */
const PERSONA_SECTION = 'deployment:persona'
const PERSONA_ORDER = 0

function apply (ctx) {
  /** sessionId → section disposer（换人格/卸载时释放，防 scoped 层同名冲突）。 */
  const installed = new Map()

  const blank = (session) =>
    !session.events.some((e) => e?.type === 'turn/start')

  const lastPersona = (session) => {
    for (let i = session.events.length - 1; i >= 0; i -= 1) {
      const e = session.events[i]
      if (e?.type === 'persona/selected') return e.data
    }
    return undefined
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

  /** 冷恢复 + 新建：从事件 log 重建（agent/created 在创建与 resume 都发）。 */
  ctx.on('agent/created', ({ agent }) => {
    try {
      const pick = lastPersona(agent.session)
      if (pick === undefined || pick.persona === null) return
      uninstallSection(agent.id)
      installed.set(agent.id, installSection(agent, pick.text))
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
    const profiles = (result?.profiles || []).filter((p) => SEAT_FAMILY.test(p.name))
    return {
      personas: profiles.map((p) => ({
        name: p.name, version: p.version, updated: p.updated
      }))
    }
  }

  function currentPersona (sessionId) {
    const agent = findAgent(sessionId)
    const pick = lastPersona(agent.session)
    if (pick === undefined || pick.persona === null) return { persona: null }
    return { persona: { name: pick.persona, version: pick.version } }
  }

  async function selectPersona (sessionId, personaName) {
    const agent = findAgent(sessionId)
    if (!blank(agent.session)) {
      const err = new Error(`session "${sessionId}" has already started; its persona is fixed`)
      err.code = 'persona-locked'
      throw err
    }
    if (!personaName) {
      uninstallSection(agent.id)
      agent.session.append('persona/selected', { persona: null })
      return { persona: null }
    }
    // 人格源唯一：A2A 池；text 全文进事件，版本钉死、重建零依赖。
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
    const version = record.version ?? record.meta?.version ?? null
    uninstallSection(agent.id)
    installed.set(agent.id, installSection(agent, text))
    agent.session.append('persona/selected', {
      persona: record.name, version, text
    })
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
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}')
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
