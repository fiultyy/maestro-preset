/**
 * loopback-sink.js — 回合驱动 sink: 经回环 /api/session.prompt 把指针行注入目标会话。
 *
 * SI-003 的"原生唤醒"通道: 与 bin/session-send 同一 RPC 形状(wire = client-request /
 * session.prompt / mode:'queue'),accepted=True 即入列驱动目标会话回合(会话可以是
 * 活跃态,也可以是 host 重启后的驻留态——sessionId 是持久路由键,这正是"零手动
 * 动作"的根据)。指针行复用 ORCA-CB] 信封(与 v3.5/v3.6 会话内 sink 投递的行格式
 * 逐字一致): text = `ORCA-CB] {原始 inbox 行 JSON}`。
 *
 * 设计边界(与 callback-bridge sinks/agent-turn.js 的差异): 本 sink 不持 agent 引用、
 * 不区分 idle/busy——queue 模式天然串行(parked 消息在目标会话空闲后驱动回合),
 * 不再中断进行中的回合(旧 sink 的 busy→inject 会打断)。
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

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

  async function deliver(sessionId, line, info) {
    const port = resolveApiPort()
    const text = `${messagePrefix} ${line}`
    const wire = {
      type: 'client-request',
      rpcId: randomUUID(),
      method: 'session.prompt',
      payload: {
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      },
    }
    let response
    try {
      response = await doFetch(`http://127.0.0.1:${port}/api/session.prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(wire),
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
