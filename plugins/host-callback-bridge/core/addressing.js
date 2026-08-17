/**
 * addressing.js — 寻址纯函数。
 * parseAddress / aliasIndex 逐行平移自 maestro-preset plugins/callback-bridge/core/addressing.js
 * (其本身平移自 orca-callback pump.js:127-187;本 lane 自包含副本,见 README"路径分治")。
 * resolveHostRouting 是本插件新增: 宿主路由视角——没有"本消费者 self",每行按
 * registry.json 直接裁定目标集合(单播 sid / 广播全体 / 死信),reason 措辞与
 * v3.5/v3.6 pump 逐字一致(dead.log 对账不变)。
 */

/**
 * 解析消息 to 字段:
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

/** alias → 持有该别名的在册 sessionId 列表(裸别名解析与同名歧义检测)。 */
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
 * 宿主路由裁定(纯函数,SI-003 新增):
 *   { action: 'wake', broadcast, sids } — 投递给 sids 中每个在册消费者(broadcast 标记 to:"*")
 *   { action: 'skip' }                  — 广播但零在册消费者(越过,不投递不死信)
 *   { action: 'dead', reason }          — 无法寻址;reason 与 pump v3.5/v3.6 逐字一致
 */
export function resolveHostRouting(address, registry) {
  if (address.kind === 'broadcast') {
    const sids = Object.keys(registry.consumers)
    if (sids.length === 0) return { action: 'skip' }
    return { action: 'wake', broadcast: true, sids }
  }
  if (address.kind === 'invalid') {
    return { action: 'dead', reason: 'unknown-addressee: "to" field is missing or not a non-empty string' }
  }
  if (address.kind === 'qualified') {
    if (registry.consumers[address.sessionId] !== undefined) {
      return { action: 'wake', broadcast: false, sids: [address.sessionId] }
    }
    return { action: 'dead', reason: `unknown-addressee: no registered consumer with sessionId ${address.sessionId}` }
  }
  // bare: 裸 sessionId 或旧式裸别名。
  if (registry.consumers[address.name] !== undefined) {
    return { action: 'wake', broadcast: false, sids: [address.name] }
  }
  const holders = aliasIndex(registry).get(address.name) ?? []
  if (holders.length === 0) {
    return { action: 'dead', reason: `unknown-addressee: "${address.name}" is neither a registered sessionId nor a resolvable alias` }
  }
  if (holders.length > 1) {
    return { action: 'dead', reason: `unknown-addressee: alias "${address.name}" is ambiguous across ${holders.length} registered consumers; use <alias>@<sessionId>` }
  }
  return { action: 'wake', broadcast: false, sids: [holders[0]] }
}
