/**
 * envelope.js — 窄腰共享库: 信封 v3 构造/校验/序列化/解析/v2 互转 + 版本四态。
 *
 * oracle: bin/session-send(v2 七键键序信封@127-129、V2_TYPES 文档@6、'DSHMSG]' 前缀)、
 * bin/cb-send(4 键 payload@28-32 + body '[ref:]' 前缀折叠@31)。
 * OG5: v3 = v2 严格超集,7 键保留键序不变,新 3 键(ver/via/ttl)尾部追加。
 */
import { forgeMsgid } from './dedup.js'

export { SIGNALS } from './vocabulary.js'

export const LINE_PREFIX = 'DSHMSG]' // 来源: bin/session-send:129
export const ENVELOPE_VERSION = 3
export const V2_TYPES = Object.freeze(['ping', 'pong', 'done', 'ask', 'steer', 'nack', 'ack']) // session-send:6 逐字

/**
 * 构造 v3 信封: 七键键序 = v2 原序(from,to,type,ref,body,msgid,ts),
 * 新三键(ver,via,ttl)尾部追加;msgid 缺省 forgeMsgid(),ts 缺省 Date.now()。
 */
export function createEnvelope(opts) {
  const env = {
    from: opts.from,
    to: opts.to,
    type: opts.type,
    ref: opts.ref,
    body: opts.body,
    msgid: opts.msgid ?? forgeMsgid(),
    ts: opts.ts ?? Date.now(),
  }
  env.ver = ENVELOPE_VERSION
  env.via = opts.via ?? ''
  env.ttl = opts.ttl ?? 5
  return env
}

/**
 * 校验信封: → {ok:true, envelope} | {ok:false, errors[]},不抛。
 * type 只查非空字符串、不查闭集(closed-set 校验留应用层白名单,见 vocabulary.js 常量);
 * 未知键不拒(OG5 超集语义)。
 */
export function validateEnvelope(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, errors: ['envelope must be a JSON object'] }
  }
  const errors = []
  for (const key of ['type', 'from', 'to']) {
    if (typeof obj[key] !== 'string' || obj[key].length === 0) {
      errors.push(`"${key}" must be a non-empty string`)
    }
  }
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, envelope: obj }
}

/** 序列化: 'DSHMSG]' + JSON.stringify(env)(JS 紧凑风格;P2 对拍判据按 R-B05 另裁,本库不复刻 Python 分隔符)。 */
export function serializeLine(env) {
  return LINE_PREFIX + JSON.stringify(env)
}

/**
 * 解析: 识别 'DSHMSG]' 前缀与裸 JSON。
 *   → {ok:true, rawVersion, value, ref} | {ok:false}(非 JSON)
 * rawVersion ∈ {3, 2, 'legacy4', null};value 原样透传(不补造字段、不改写、键数不变)。
 * ref: v3/v2 取 value.ref ?? null;
 *      legacy4 从 body '[ref:' 前缀提取(cb-send:31 折叠约定)?? value.ref ?? null;
 *      null 态取 value.ref ?? null。
 * null 态不抛——JSON 但不成信封的行由各面现状逻辑处理(非 JSON 行才进 malformed 死信)。
 */
export function parseLine(line) {
  if (typeof line !== 'string') return { ok: false }
  const raw = line.startsWith(LINE_PREFIX) ? line.slice(LINE_PREFIX.length) : line
  let value
  try {
    value = JSON.parse(raw)
  } catch {
    return { ok: false }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: true, rawVersion: null, value, ref: null }
  }
  const version = detectVersion(value)
  let ref = value.ref ?? null
  if (version === 'legacy4' && typeof value.body === 'string') {
    const m = value.body.match(/^\[ref:([^\]]*)\]/)
    if (m !== null) ref = m[1]
  }
  return { ok: true, rawVersion: version, value, ref }
}

/**
 * 版本四态(R-S33 拍板):
 *   3         — obj.ver === 3
 *   2         — 无 ver 且 msgid 为非空字符串
 *   'legacy4' — 无 ver 无 msgid 且 from/to/type/body 四基键齐全(cb-send 4 键裸行,inbox 主流量)
 *   null      — 其余(malformed/不构成信封)
 */
export function detectVersion(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null
  if (obj.ver === 3) return 3
  if (obj.ver !== undefined) return null
  const hasMsgid = typeof obj.msgid === 'string' && obj.msgid.length > 0
  if (hasMsgid) return 2
  if (typeof obj.type === 'string' && typeof obj.from === 'string'
    && typeof obj.to === 'string' && typeof obj.body === 'string') {
    return 'legacy4'
  }
  return null
}

/** v2 → v3: 补 ver/via/ttl,原字段与键序不动(OG5;已有键不覆写)。 */
export function upgradeV2toV3(v2, via) {
  const out = { ...v2 }
  if (out.ver === undefined) out.ver = ENVELOPE_VERSION
  if (out.via === undefined) out.via = via ?? ''
  if (out.ttl === undefined) out.ttl = 5
  return out
}

/**
 * v3 → v2: 剥 ver/via/ttl → 7 键。
 * 定位 = 测试辅助 + R-B05 修复选项(b)备用,不列入生产调用面(R-S18 拍板:
 * 保留导出、JSDoc 标注非生产 API;OG5 严格超集下 v2 消费者忽略未知键)。
 */
export function downgradeV3toV2(env) {
  const { ver: _ver, via: _via, ttl: _ttl, ...rest } = env
  return rest
}
