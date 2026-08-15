/**
 * agent-turn.js — 回合驱动 sink: idle→followup / busy→inject。
 * 平移自 pump.js:666-684 一般化: 前缀/插件名由 config.sink 供给。
 */
import { randomUUID } from 'node:crypto'

/**
 * createAgentTurnSink(agents, { messagePrefix, pluginId }) → sink
 * sink.deliver(line, info): 未绑定 agent 抛 {code:'MSG_BRIDGE_NOT_ARMED'}(http 侧 503),
 * 其余抛错 = 投递失败(file 侧退避重试,http 侧 500)。
 */
export function createAgentTurnSink(agents, { messagePrefix, pluginId }) {
  let agent = null
  return {
    bind(next) {
      agent = next
    },
    get bound() {
      return agent !== null
    },
    get sessionId() {
      return agent === null ? null : String(agent.id)
    },
    deliver(line, info) {
      if (agent === null) {
        throw Object.assign(
          new Error('callback-bridge not armed: no agent bound (call bridge_arm in this session first)'),
          { code: 'MSG_BRIDGE_NOT_ARMED' },
        )
      }
      const message = Object.freeze({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: `${messagePrefix} ${line}` }],
        source: {
          kind: 'plugin',
          plugin: pluginId,
          form: 'notice',
          summary: `Callback routed to ${info?.consumer ?? '(unrouted)'}`,
        },
      })
      if (agent.status === 'idle') agent.followup(message)
      else agent.inject(message)
    },
  }
}
