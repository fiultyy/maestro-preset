/**
 * addressing.js — 回调桥寻址纯函数。
 * 平移自 orca-callback/pump.js:127-187(v3.5 多消费者路由,含 2026-08-15 同名歧义事故防线)。
 * 纯函数,无 IO,导出供单测。
 */

/**
 * 解析消息 to 字段(pump.js:137-143):
 *   '*'                    → { kind: 'broadcast' }
 *   '<alias>@<sessionId>'  → { kind: 'qualified', alias, sessionId }(sessionId 为路由键)
 *   '<sessionId>|<alias>'  → { kind: 'bare', name }
 *   缺失/非字符串/空       → { kind: 'invalid' }
 * 含多个 '@' 时按最后一个切分(sessionId 不含 '@',alias 理论上可含)。
 */
export function parseAddress(to) {
  if (typeof to !== 'string' || to.length === 0) return { kind: 'invalid' }
  if (to === '*') return { kind: 'broadcast' }
  const at = to.lastIndexOf('@')
  if (at === -1) return { kind: 'bare', name: to }
  return { kind: 'qualified', alias: to.slice(0, at), sessionId: to.slice(at + 1) }
}

/** alias → 持有该别名的在册 sessionId 列表(裸别名解析与同名歧义检测,pump.js:146-154)。 */
export function aliasIndex(registry) {
  const map = new Map()
  for (const [sid, entry] of Object.entries(registry.consumers)) {
    if (typeof entry?.alias !== 'string' || entry.alias.length === 0) continue
    if (!map.has(entry.alias)) map.set(entry.alias, [])
    map.get(entry.alias).push(sid)
  }
  return map
}

/**
 * 路由裁定(纯函数,pump.js:166-187):
 *   { action: 'wake', broadcast }  — 投递给本消费者(broadcast 标记 to:"*")
 *   { action: 'skip' }             — 属于其他在册消费者,静默越过
 *   { action: 'dead', reason }     — 无法寻址: reason 以 unknown-addressee 开头
 */
export function resolveRouting(address, self, registry) {
  if (address.kind === 'broadcast') return { action: 'wake', broadcast: true }
  if (address.kind === 'invalid') {
    return { action: 'dead', reason: 'unknown-addressee: "to" field is missing or not a non-empty string' }
  }
  if (address.kind === 'qualified') {
    if (address.sessionId === self.sessionId) return { action: 'wake', broadcast: false }
    if (registry.consumers[address.sessionId] !== undefined) return { action: 'skip' }
    return { action: 'dead', reason: `unknown-addressee: no registered consumer with sessionId ${address.sessionId}` }
  }
  // bare: 裸 sessionId 或旧式裸别名。
  if (address.name === self.sessionId) return { action: 'wake', broadcast: false }
  if (registry.consumers[address.name] !== undefined) return { action: 'skip' }
  const holders = aliasIndex(registry).get(address.name) ?? []
  if (holders.length === 0) {
    return { action: 'dead', reason: `unknown-addressee: "${address.name}" is neither a registered sessionId nor a resolvable alias` }
  }
  if (holders.length > 1) {
    return { action: 'dead', reason: `unknown-addressee: alias "${address.name}" is ambiguous across ${holders.length} registered consumers; use <alias>@<sessionId>` }
  }
  return holders[0] === self.sessionId ? { action: 'wake', broadcast: false } : { action: 'skip' }
}
