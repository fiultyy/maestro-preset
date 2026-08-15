/**
 * dedup.js — (from,body) sha256 去重窗口。
 * 平移自 pump.js:101-110,445-450;message-bridge v1.0 同源(跨通道共享同一 digest)。
 */
import { createHash } from 'node:crypto'

/** (from,body) 摘要: from 缺失时退化为整行(pump.js:101-110)。 */
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
 * 窗口化去重(pump.js:445-450 + message-bridge dedup 合并):
 *   seen(digest) → 窗口内命中返回 { deliveredAt, meta },否则 undefined
 *   mark(digest, meta) → 记一笔(meta 供 http 208 回放携带 id),顺带剪枝过期项
 * 跨 source 共享同一实例即可实现跨通道去重。
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
