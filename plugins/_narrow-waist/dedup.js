/**
 * dedup.js — 窄腰共享库: msgid 铸造 + 双键去重窗口。
 *
 * 兼容基准: digestOf/createDedupWindow 逐字平移自
 * plugins/host-callback-bridge/core/dedup.js(与 pump.js digestOf@106-115 同源);
 * 本文件是其超集: 材料分流(R-B16 根除) + 双记(R-B03 根除) + meta 通道(R-S01③)。
 *
 * mark 时机不变量(库侧为文档化契约,不在库内实现状态机):
 *   mark/markAll 仅在 pending 行全部目标终态(全部送达或全部死信)后由调用方执行
 *   ——file-router deliverPending() 的 attempts.size === 0 才 mark 语义、
 *   pump flush() wake 成功后的 rt.dedup.set 语义;seen/seenAny 绝不隐式 mark、
 *   命中不刷新 deliveredAt。attempts 状态机、退避、死信全部留应用层。
 */
import { createHash, randomUUID } from 'node:crypto'

/** msgid 铸造: uuid4(session-send msgid 同构)。 */
export function forgeMsgid() {
  return randomUUID()
}

/**
 * (from,body) 摘要,兼容层签名逐字同 core/dedup.js:
 *   from 非字符串 → sha256(line)(from 缺失整行回退)
 *   否则          → sha256(`${from}\u0000${body}`),body 缺失取 ''
 * digest 与 msgid 无关(body 键稳定)——任何路径都不存在 `from\0undefined` 材料。
 */
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
 * 一条行的去重身份双键:
 *   msgidKey = parsed.msgid 为非空字符串时 `m\u0000${from ?? ''}\u0000${msgid}`,否则 undefined
 *   digest   = digestOf(line, parsed)
 */
export function dedupKeys(line, parsed) {
  const isObj = parsed !== null && typeof parsed === 'object'
  const msgid = isObj && typeof parsed.msgid === 'string' && parsed.msgid.length > 0
    ? parsed.msgid
    : undefined
  const from = isObj && typeof parsed.from === 'string' ? parsed.from : undefined
  const msgidKey = msgid === undefined ? undefined : `m\u0000${from ?? ''}\u0000${msgid}`
  return { msgidKey, digest: digestOf(line, parsed) }
}

/**
 * 窗口化去重(windowMs 缺省 60_000,对齐 file-router/pump/message-bridge/http-intake 四处 60s 窗):
 *   seen(key)            → 窗口内命中返回 { deliveredAt, meta },否则 undefined(不隐式 mark)
 *   mark(key, meta=null) → 记 { deliveredAt: now(), meta } 并顺带剪枝
 *   prune() / get size
 * meta 通道: message-bridge/http-intake 的 208 回放 `id: prior.meta ?? null` 依赖此参数。
 */
export function createDedupWindow({ windowMs = 60_000, now = () => Date.now() } = {}) {
  const map = new Map() // key -> { deliveredAt, meta }
  function prune() {
    const horizon = now() - windowMs
    for (const [key, entry] of map) {
      if (entry.deliveredAt < horizon) map.delete(key)
    }
  }
  return {
    seen(key) {
      const entry = map.get(key)
      if (entry === undefined) return undefined
      if (now() - entry.deliveredAt < windowMs) return entry
      return undefined
    },
    mark(key, meta = null) {
      map.set(key, { deliveredAt: now(), meta })
      prune()
    },
    prune,
    get size() {
      return map.size
    },
  }
}

/**
 * 升级期双查: keys.msgidKey 先、keys.digest 后 → entry | undefined。
 */
export function seenAny(win, keys) {
  if (keys.msgidKey !== undefined) {
    const hit = win.seen(keys.msgidKey)
    if (hit !== undefined) return hit
  }
  return win.seen(keys.digest)
}

/**
 * 双记: msgidKey(若存在)+ digest 两键写入,共享同一 meta——
 * 由此四向重放全部命中: v3→v3(msgid)、v3→4键(digest)、4键→4键(digest)、
 * 4键/v2→v3 新 msgid(digest,升级窗语义)。
 */
export function markAll(win, keys, meta = null) {
  if (keys.msgidKey !== undefined) win.mark(keys.msgidKey, meta)
  win.mark(keys.digest, meta)
}
