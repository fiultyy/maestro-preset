/**
 * addressing.js — 寻址纯函数。
 * parseAddress / aliasIndex 逐行平移自 maestro-preset plugins/callback-bridge/core/addressing.js
 * (其本身平移自 orca-callback pump.js:127-187;本 lane 自包含副本,见 README"路径分治")。
 * resolveHostRouting 是本插件新增: 宿主路由视角——没有"本消费者 self",每行按
 * registry.json 直接裁定目标集合(单播 sid / 广播全体 / 死信),reason 措辞与
 * v3.5/v3.6 pump 逐字一致(dead.log 对账不变)。
 *
 * IDX-4 增量(spec §1/§2,冻结):
 *   - stale 槽**不算在册**: 单播/广播/别名索引全排除,命中 stale 槽 → dead 带
 *     classification:"stale address" + supersededBy(新规范名)+ epoch(新代);
 *   - 显式 to 无匹配 → dead 带 classification:"ghost address"(HTTP 面 400 details
 *     / file 面 dead.log 新增 classification 键;既有 reason 措辞逐字不变);
 *   - 无 most-recent-armer 兜底(负向不变式 G3): 任何失配都不猜收件人。
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

function canonicalOf(sessionId, entry) {
  return entry?.alias ? `${entry.alias}@${sessionId}` : sessionId
}

/** alias → 持有该别名的**活槽** sessionId 列表(stale 退出别名索引,spec §2.2)。 */
export function aliasIndex(registry) {
  const map = new Map()
  for (const [sid, entry] of Object.entries(registry.consumers)) {
    if (typeof entry?.alias !== 'string' || entry.alias.length === 0) continue
    if (entry.stale !== null && entry.stale !== undefined) continue
    if (!map.has(entry.alias)) map.set(entry.alias, [])
    map.get(entry.alias).push(sid)
  }
  return map
}

/** 活槽判定(stale = 已换代,不算在册,spec §1.3)。 */
function liveEntry(registry, sid) {
  const entry = registry.consumers[sid]
  if (entry === undefined) return undefined
  return entry.stale !== null && entry.stale !== undefined ? undefined : entry
}

/** stale 槽死亡语义(§2.4 措辞冻结,可 grep)。 */
function staleDead(registry, sid) {
  const entry = registry.consumers[sid]
  const stale = entry?.stale
  const successor = registry.consumers[stale?.supersededBy]
  const newCanonical = successor !== undefined ? canonicalOf(stale.supersededBy, successor) : `${entry?.alias ?? '?'}@${stale?.supersededBy ?? '?'}`
  const newEpoch = registry.aliases[entry?.alias]?.epoch ?? successor?.epoch ?? '?'
  return {
    action: 'dead',
    classification: 'stale address',
    supersededBy: newCanonical,
    epoch: newEpoch,
    reason: `unknown-addressee: sessionId ${sid} is a stale generation of alias ${entry?.alias ?? '?'} (epoch ${stale?.epoch ?? '?'}), superseded by ${newCanonical} (epoch ${newEpoch})`,
  }
}

/** 幽灵死亡(§1.1): classification + 同别名活槽 canonical 提示(不自动改投,§1.4)。 */
function ghostDead(reason, hintCanonicals) {
  return {
    action: 'dead',
    classification: 'ghost address',
    hintCanonicals: hintCanonicals.length > 0 ? hintCanonicals : ['none'],
    reason,
  }
}

/**
 * 宿主路由裁定(纯函数,SI-003 新增):
 *   { action: 'wake', broadcast, sids } — 投递给 sids 中每个**活槽**消费者(broadcast 标记 to:"*")
 *   { action: 'skip' }                  — 广播但零活槽(越过,不投递不死信)
 *   { action: 'dead', reason[, classification, …] } — 无法寻址;reason 与 pump v3.5/v3.6 逐字一致
 */
export function resolveHostRouting(address, registry) {
  if (address.kind === 'broadcast') {
    const sids = Object.keys(registry.consumers).filter((sid) => liveEntry(registry, sid) !== undefined)
    if (sids.length === 0) return { action: 'skip' }
    return { action: 'wake', broadcast: true, sids }
  }
  if (address.kind === 'invalid') {
    return { action: 'dead', reason: 'unknown-addressee: "to" field is missing or not a non-empty string' }
  }
  if (address.kind === 'qualified') {
    const entry = registry.consumers[address.sessionId]
    if (entry !== undefined) {
      if (entry.stale !== null && entry.stale !== undefined) return staleDead(registry, address.sessionId)
      return { action: 'wake', broadcast: false, sids: [address.sessionId] }
    }
    const hints = (aliasIndex(registry).get(address.alias) ?? []).map((sid) => canonicalOf(sid, registry.consumers[sid]))
    return ghostDead(`unknown-addressee: no registered consumer with sessionId ${address.sessionId}`, hints)
  }
  // bare: 裸 sessionId 或旧式裸别名。
  const direct = registry.consumers[address.name]
  if (direct !== undefined) {
    if (direct.stale !== null && direct.stale !== undefined) return staleDead(registry, address.name)
    return { action: 'wake', broadcast: false, sids: [address.name] }
  }
  const holders = aliasIndex(registry).get(address.name) ?? []
  if (holders.length === 0) {
    return ghostDead(`unknown-addressee: "${address.name}" is neither a registered sessionId nor a resolvable alias`, [])
  }
  if (holders.length > 1) {
    return { action: 'dead', reason: `unknown-addressee: alias "${address.name}" is ambiguous across ${holders.length} registered consumers; use <alias>@<sessionId>` }
  }
  return { action: 'wake', broadcast: false, sids: [holders[0]] }
}
