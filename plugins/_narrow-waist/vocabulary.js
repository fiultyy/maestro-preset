/**
 * vocabulary.js — 窄腰共享库: 18 Signal 词汇表 + 三平面映射 + 每平面入站白名单常量。
 *
 * 18 Signal 终表以 docs/narrow-waist-fix-spec.md §G.3 为准(含第 18 个 Signal `report`);
 * done ≠ worker_done 裁决沿用: cb-send done 是纯文本摘要、worker_done 是 JSON 生命周期载荷。
 * 闭集校验留在各 intake 应用层白名单常量,库不做全局闭集拒绝。
 */

/** 18 Signal 全集(frozen;单一来源,envelope.js 从此引用)。 */
export const SIGNALS = Object.freeze([
  'done', 'worker_done', 'heartbeat', 'escalation', 'status', 'report',
  'dispatch', 'question', 'handoff', 'decision_gate', 'merge_ready', 'notify',
  'ping', 'pong', 'ack', 'nack', 'ask', 'steer',
])

/** dais MessageType 9 值枚举(types.rs 枚举@14-33)+ 显式 direct:null 条目。 */
export const DAIS_TYPE_MAP = Object.freeze({
  worker_done: 'worker_done',
  heartbeat: 'heartbeat',
  escalation: 'escalation',
  status: 'status',
  dispatch: 'dispatch',
  question: 'question',
  handoff: 'handoff',
  decision_gate: 'decision_gate',
  merge_ready: 'merge_ready',
  // 'direct' 不是合法 dais MessageType(CLI+DB CHECK 双层拒,真实库 0 条落库):
  // 显式归 null——误译 status 会把"必死的历史发送值"洗成合法语义。
  direct: null,
})

/** DSH type 面: V2 七值 + status/report/notify。 */
export const DSH_TYPE_MAP = Object.freeze({
  done: 'done',
  status: 'status',
  report: 'report',
  notify: 'notify',
  ping: 'ping',
  pong: 'pong',
  ack: 'ack',
  nack: 'nack',
  ask: 'ask',
  steer: 'steer',
})

/** Orca --type 面。 */
export const ORCA_TYPE_MAP = Object.freeze({
  worker_done: 'worker_done',
  heartbeat: 'heartbeat',
  escalation: 'escalation',
  dispatch: 'dispatch',
  question: 'question',
  handoff: 'handoff',
  decision_gate: 'decision_gate',
  merge_ready: 'merge_ready',
})

const SIGNAL_SET = new Set(SIGNALS)
const PLANE_MAPS = { dais: DAIS_TYPE_MAP, dsh: DSH_TYPE_MAP, orca: ORCA_TYPE_MAP }

/**
 * normalizeType 三态(R-S33 词汇半边终稿):
 *   已知(18 Signal)            → { signal, source }
 *   未知非空字符串             → { signal: null, source: rawType } 透传打标(不抛、不猜)
 *   空串/非字符串              → { signal: null, source: null }
 * 不做大小写归一("Status"→signal:null——归一会静默改 wire 值)。
 */
export function normalizeType(rawType) {
  if (typeof rawType !== 'string' || rawType.length === 0) {
    return { signal: null, source: null }
  }
  if (SIGNAL_SET.has(rawType)) {
    return { signal: rawType, source: rawType }
  }
  return { signal: null, source: rawType }
}

/**
 * Signal → 平面原生 type;不可译(含 direct 条目与未知平面)返回 null。
 * dais 面永不产出 'direct'(DAIS_TYPE_MAP 显式 null 条目保证)。
 */
export function denormalizeType(signal, plane) {
  const map = PLANE_MAPS[plane]
  if (map === undefined) return null
  if (!Object.prototype.hasOwnProperty.call(map, signal)) return null
  const native = map[signal]
  return native === undefined ? null : native
}

/**
 * 每平面入站白名单常量(R-S24 拍板,值逐字取自现网点位,禁取 V2_TYPES 顶替):
 * 任何 adapter 换用后入站面行为零变化——扩面/收面需另立裁决。
 */
export const DSH_CALLBACK_TYPES = Object.freeze(['ack', 'done', 'ping', 'status'])
//   = message-bridge/index.js TYPES 现值 = cb-send 用法契约(type: ack|done|ping|status),值集与顺序逐字
export const DSH_INTAKE_TYPES = Object.freeze(['ack', 'done', 'ask', 'report', 'ping', 'status'])
//   = host-callback-bridge http-intake.js TYPES 现值(6 值,含 report),值集与顺序逐字
