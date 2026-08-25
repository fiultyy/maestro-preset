/**
 * dedup.js — (from,body) sha256 去重窗口。
 * 逐行平移自 maestro-preset plugins/callback-bridge/core/dedup.js(pump.js:101-110,445-450
 * + message-bridge v1.0 同源);本 lane 自包含副本(见 README"路径分治")。
 * HTTP 受理面与文件消费面共享同一实例 → 跨通道 60s 单次投递。
 */
import { createHash } from 'node:crypto'

/** (from,body) 摘要: from 缺失时退化为整行。 */
export function digestOf(line, parsed) {
  const from = parsed !== null && typeof parsed === 'object' && typeof parsed.from === 'string'
    ? parsed.from
    : null
  const body = parsed !== null && typeof parsed === 'object' && parsed.body !== undefined
    ? String(parsed.body)
    : ''
  const material = from === null ? line : `${from}\u0000${body}`
  return createHash('sha256').update(material).digest('hex')
}

/**
 * 双键去重身份(P3b.2,R-B03+R-B16 联合):
 *   parsed.msgid 为非空字符串 → primary=sha256(from\0msgid)、secondary=sha256(from\0body)
 *   否则                        → primary=sha256(from\0body)、secondary=null
 *   from 缺失/非对象            → primary=sha256(line)(现行退化分支逐字保留)、secondary=null
 * 调用面: seen = primary 或 secondary 任一命中即重;mark = 两键同记(secondary 非 null 时)。
 */
export function digestKeys(line, parsed) {
  const from = parsed !== null && typeof parsed === 'object' && typeof parsed.from === 'string'
    ? parsed.from
    : null
  if (from === null) {
    return { primary: createHash('sha256').update(line).digest('hex'), secondary: null }
  }
  const body = parsed !== null && typeof parsed === 'object' && parsed.body !== undefined
    ? String(parsed.body)
    : ''
  const msgid = parsed !== null && typeof parsed === 'object' && typeof parsed.msgid === 'string' && parsed.msgid.length > 0
    ? parsed.msgid
    : null
  const bodyKey = createHash('sha256').update(`${from}\u0000${body}`).digest('hex')
  if (msgid === null) return { primary: bodyKey, secondary: null }
  return { primary: createHash('sha256').update(`${from}\u0000${msgid}`).digest('hex'), secondary: bodyKey }
}

/**
 * 窗口化去重:
 *   seen(digest) → 窗口内命中返回 { deliveredAt, meta },否则 undefined
 *   mark(digest, meta) → 记一笔,顺带剪枝过期项
 */
export function createDedupWindow({ windowMs, now = () => Date.now() }) {
  const map = new Map() // digest -> { deliveredAt, meta }
  function prune() {
    const horizon = now() - windowMs
    for (const [key, entry] of map) {
      if (entry.deliveredAt < horizon) map.delete(key)
    }
  }
  return {
    seen(digest) {
      const entry = map.get(digest)
      if (entry === undefined) return undefined
      if (now() - entry.deliveredAt < windowMs) return entry
      return undefined
    },
    mark(digest, meta) {
      map.set(digest, { deliveredAt: now(), meta })
      prune()
    },
    prune,
    get size() {
      return map.size
    },
  }
}
