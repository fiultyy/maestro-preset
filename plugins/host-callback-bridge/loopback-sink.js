/**
 * loopback-sink.js — 回合驱动 sink: 经回环 /api/session.prompt 把指针行注入目标会话。
 *
 * SI-003 的"原生唤醒"通道: 与 bin/session-send 同一 RPC 形状(wire = client-request /
 * session.prompt / mode:'queue'),accepted=True 即入列驱动目标会话回合(会话可以是
 * 活跃态,也可以是 host 重启后的驻留态——sessionId 是持久路由键,这正是"零手动
 * 动作"的根据)。指针行复用 ORCA-CB] 信封(与 v3.5/v3.6 会话内 sink 投递的行格式
 * 逐字一致): text = `ORCA-CB] {原始 inbox 行 JSON}`。
 *
 * 双链 wire(seatA-cut3-2): rpc/deliver 统一走 core/wire.js dshWire()——dot(默认)
 * 逐字节现行为; DSH_WIRE=slash 走 NEW 链 /api/<ns>/<verb> + {args:{request}} + cookie。
 *
 * 时效语义(2026-08-26 orch1 裁定"消息必须到达时 cancel 当前步"): 目标会话在飞时,
 * 投递前先 POST session.cancel 中断在飞 step,再以 queue 入列——agent loop 会把
 * 唤醒消息重类为 next-turn 并基于全量历史立即开新回合(即 steer-cancel 模式),
 * 通知不再排在当前回合之后一条一回合地慢放。空闲会话直接 queue 驱动新回合,
 * 与旧语义一致。cancel/list 的瞬时失败不阻塞投递(退化为纯 queue)。
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dshWire } from './core/wire.js'

/** 缺省请求超时: 与 bin/session-send 的 urlopen timeout=30 一致。 */
export const REQUEST_TIMEOUT_MS = 30_000

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * createLoopbackSink(options):
 *   messagePrefix     — 指针行前缀(缺省 'ORCA-CB]')
 *   fleetFile         — fleet.json 路径(回环端口发现,缺省 bridgeDir 同级 fleet.json)
 *   apiPort           — 显式回环端口(测试注入;优先级最高)
 *   requestTimeoutMs  — 单次请求超时
 *   fetchImpl         — fetch 注入(测试)
 * 返回 { deliver(sessionId, line, info) → Promise<true>, resolveApiPort() }。
 * deliver 抛错 = 投递失败(文件面退避×3 → 死信,与 v3.5 wake 失败策略同构)。
 */
export function createLoopbackSink(options = {}) {
  const {
    messagePrefix = 'ORCA-CB]',
    fleetFile = null,
    apiPort: configuredPort = null,
    requestTimeoutMs = REQUEST_TIMEOUT_MS,
    fetchImpl = null,
  } = options
  const doFetch = fetchImpl ?? ((url, init) => fetch(url, init))

  /** 回环端口三级解析: 显式配置 > env DSH_PORT > fleet.json .port > 3080。 */
  function resolveApiPort() {
    if (configuredPort !== null && configuredPort !== undefined) return configuredPort
    const envPort = Number.parseInt(process.env.DSH_PORT ?? '', 10)
    if (Number.isFinite(envPort) && envPort > 0) return envPort
    if (typeof fleetFile === 'string' && fleetFile.length > 0) {
      try {
        const fleet = JSON.parse(readFileSync(fleetFile, 'utf8'))
        const port = Number.parseInt(fleet?.port, 10)
        if (Number.isFinite(port) && port > 0) return port
      } catch {
        // fleet.json 缺失/损坏: 落到缺省。
      }
    }
    return 3080
  }

  /** 单次 RPC: 双形态 wire（dot 逐字节现行为; DSH_WIRE=slash 走 NEW 链+cookie）→ 非 ok 抛错。 */
  async function rpc(port, method, payload) {
    const wire = dshWire(method, payload, port)
    const response = await doFetch(`http://127.0.0.1:${port}${wire.path}`, {
      method: 'POST',
      headers: wire.headers,
      body: JSON.stringify(wire.body),
      signal: AbortSignal.timeout(requestTimeoutMs),
    })
    let data = null
    try {
      data = await response.json()
    } catch {
      // 非 JSON 应答按失败处理。
    }
    const result = data?.result
    if (data === null || result?.ok !== true) {
      const err = result?.error ?? { httpStatus: response.status }
      throw new Error(`${method} rejected: ${JSON.stringify(err)}`)
    }
    return result?.value ?? {}
  }

  /** 目标会话是否在飞(session.list 权威);查询失败按空闲处理。 */
  async function isRunning(port, sessionId) {
    try {
      const value = await rpc(port, 'session.list', {})
      const items = Array.isArray(value?.items) ? value.items : []
      return items.some((it) => it?.sessionId === sessionId && it?.running === true)
    } catch (error) {
      console.error('host-callback-bridge session.list precheck failed:', errorMessage(error))
      return false
    }
  }

  async function deliver(sessionId, line, info) {
    const port = resolveApiPort()
    const text = `${messagePrefix} ${line}`
    if (await isRunning(port, sessionId)) {
      // steer-cancel: 中断在飞 step;随后的 queue 入列会被 agent loop 重类为
      // next-turn,基于全量历史立即开新回合(时效裁定)。
      try {
        await rpc(port, 'session.cancel', { sessionId })
      } catch (error) {
        // cancel 失败不阻塞投递: 退化为纯 queue(下一回合边界送达)。
        console.error('host-callback-bridge session.cancel failed:', errorMessage(error))
      }
    }
    const wire = dshWire('session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    }, port)
    let response
    try {
      response = await doFetch(`http://127.0.0.1:${port}${wire.path}`, {
        method: 'POST',
        headers: wire.headers,
        body: JSON.stringify(wire.body),
        signal: AbortSignal.timeout(requestTimeoutMs),
      })
    } catch (error) {
      throw new Error(`session.prompt transport failed for ${sessionId}: ${errorMessage(error)}`)
    }
    let data = null
    try {
      data = await response.json()
    } catch {
      // 非 JSON 应答按失败处理。
    }
    const result = data?.result
    if (data === null || result?.ok !== true) {
      const err = result?.error ?? { httpStatus: response.status }
      throw new Error(`session.prompt rejected for ${sessionId}: ${JSON.stringify(err)}`)
    }
    if (result?.value?.accepted !== true) {
      throw new Error(`session.prompt not accepted for ${sessionId}: ${JSON.stringify(result?.value ?? {})}`)
    }
    return true
  }

  return { deliver, resolveApiPort }
}
