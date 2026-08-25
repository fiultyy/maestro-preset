/**
 * addressing.js — 窄腰共享库: 寻址纯函数 + 路由裁定(双视角) + 发送侧联合解析 + fleet 查表 + registry 读写链。
 *
 * 兼容基准(逐字平移,函数名锚定):
 *   parseAddress/aliasIndex/resolveHostRouting(宿主视角) ← plugins/host-callback-bridge/core/addressing.js
 *   resolveRouting(泵视角底层,原签名原参数序)           ← plugins/orca-callback/pump.js resolveRouting@171-192
 *   registry 五函数                                       ← core/registry.js
 * 写链语义 ← pump.js registryOpChain@196-203(进程内串行化);
 * 唯一 tmp 名 ← core/store.js saveState 模式(`${path}.tmp-${pid}-${seq}`)。
 */
import * as fsp from 'node:fs/promises'

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
 * ① 底层路由裁定(泵视角;pump 调用点零改动的前提 = 原名、原参数序、原判定语义):
 *   { action:'wake', broadcast, sids:[self.sessionId] } — 该行投递给本消费者
 *   { action:'skip' }  — 该行属其他在册消费者,本消费者越过(游标推进不阻塞自身)
 *   { action:'dead', reason } — 无法寻址(不投递不丢失,reason 以 unknown-addressee 开头)
 * 唯一增强: 两个 wake 返回追加 sids(泵调用点不读该键,零影响)。
 */
export function resolveRouting(address, self, registry) {
  if (address.kind === 'broadcast') return { action: 'wake', broadcast: true, sids: [self.sessionId] }
  if (address.kind === 'invalid') {
    return { action: 'dead', reason: 'unknown-addressee: "to" field is missing or not a non-empty string' }
  }
  if (address.kind === 'qualified') {
    if (address.sessionId === self.sessionId) return { action: 'wake', broadcast: false, sids: [self.sessionId] }
    if (registry.consumers[address.sessionId] !== undefined) return { action: 'skip' }
    return { action: 'dead', reason: `unknown-addressee: no registered consumer with sessionId ${address.sessionId}` }
  }
  // bare: 裸 sessionId 或旧式裸别名。
  if (address.name === self.sessionId) return { action: 'wake', broadcast: false, sids: [self.sessionId] }
  if (registry.consumers[address.name] !== undefined) return { action: 'skip' }
  const holders = aliasIndex(registry).get(address.name) ?? []
  if (holders.length === 0) {
    return { action: 'dead', reason: `unknown-addressee: "${address.name}" is neither a registered sessionId nor a resolvable alias` }
  }
  if (holders.length > 1) {
    return { action: 'dead', reason: `unknown-addressee: alias "${address.name}" is ambiguous across ${holders.length} registered consumers; use <alias>@<sessionId>` }
  }
  return holders[0] === self.sessionId
    ? { action: 'wake', broadcast: false, sids: [self.sessionId] }
    : { action: 'skip' }
}

/**
 * ② 统一门面(新代码一律用它): resolveRoutingUnified(addr, registry, { self } = {})
 *   self 缺省 = 宿主视角(host lane),判定逻辑与 core/addressing.js resolveHostRouting() 逐字一致:
 *     broadcast → sids = 在册全集快照;空集 → skip;非空 → wake(broadcast:true, sids 全集)
 *     invalid/qualified/bare 判定与 reason 逐字同 resolveHostRouting,wake 恒带 sids:[目标]
 *   self = { sessionId, alias? } = 泵视角: 委托底层①,返回恒带 sids:[self.sessionId]
 *     broadcast → 恒 wake-self(不查 registry)
 * skip 语义按调用方钉死:
 *   宿主 lane 的 skip = "广播零在册,该行整体越过,不投递不死信,计数 skippedCount,游标推进";
 *   泵的 skip = "该行属其他在册消费者,本消费者越过,游标推进不阻塞自身"。
 *   两者都不重试、不落 dead.log。
 */
export function resolveRoutingUnified(addr, registry, { self } = {}) {
  if (self !== undefined) {
    return resolveRouting(addr, self, registry)
  }
  if (addr.kind === 'broadcast') {
    const sids = Object.keys(registry.consumers)
    if (sids.length === 0) return { action: 'skip' }
    return { action: 'wake', broadcast: true, sids }
  }
  if (addr.kind === 'invalid') {
    return { action: 'dead', reason: 'unknown-addressee: "to" field is missing or not a non-empty string' }
  }
  if (addr.kind === 'qualified') {
    if (registry.consumers[addr.sessionId] !== undefined) {
      return { action: 'wake', broadcast: false, sids: [addr.sessionId] }
    }
    return { action: 'dead', reason: `unknown-addressee: no registered consumer with sessionId ${addr.sessionId}` }
  }
  // bare: 裸 sessionId 或旧式裸别名。
  if (registry.consumers[addr.name] !== undefined) {
    return { action: 'wake', broadcast: false, sids: [addr.name] }
  }
  const holders = aliasIndex(registry).get(addr.name) ?? []
  if (holders.length === 0) {
    return { action: 'dead', reason: `unknown-addressee: "${addr.name}" is neither a registered sessionId nor a resolvable alias` }
  }
  if (holders.length > 1) {
    return { action: 'dead', reason: `unknown-addressee: alias "${addr.name}" is ambiguous across ${holders.length} registered consumers; use <alias>@<sessionId>` }
  }
  return { action: 'wake', broadcast: false, sids: [holders[0]] }
}

/** ③ 兼容别名(原位 re-export 用,host lane 调用点零改动): 逐字保留现导出名。 */
export function resolveHostRouting(address, registry) {
  return resolveRoutingUnified(address, registry, {})
}

/**
 * 发送侧联合解析(R-B15 撞名防线只在此面;消费侧 resolveRouting 族不引入 fleet):
 *   成功 {ok:true, plane:'dsh'|'orca'|'dais', handle, sessionId, alias}
 *   广播 {ok:true, broadcast:true, plane:null, handle:'*'}(展开由 adapter 面,库不猜 plane)
 *   失败 {ok:false, reason, ambiguous?}
 * 判定序:
 *   1. broadcast(*);2. qualified(alias@sid): registry 在册 → fleet 按 sessionId → reason②;
 *   3. bare N: a. registry 裸 sessionId 在册;
 *      b. 撞名检测: fleet 精确键 + aliasIndex 命中 → collision 死信(仅 fleet **精确键**,前缀命中不计入);
 *      c. alias 唯一持有者; d. alias 多持有者(reason④); e. fleet code(prefix 模式); f. reason③。
 * plane 判定: sessionId 'session-' 前缀→'dsh';fleet 条目 kind='orca-terminal'→'orca';
 *            'ctx_'/'session_' 前缀→'dais';缺省 'dsh'。
 */
export function resolveAddress(parsed, fleet, registry) {
  if (parsed.kind === 'broadcast') {
    return { ok: true, broadcast: true, plane: null, handle: '*' }
  }
  if (parsed.kind === 'qualified') {
    const sid = parsed.sessionId
    if (registry.consumers[sid] !== undefined) {
      const entry = registry.consumers[sid]
      return { ok: true, plane: planeOf(sid), handle: sid, sessionId: sid, alias: entry.alias ?? null }
    }
    const fleetEntry = fleetEntryBySessionId(fleet, sid)
    if (fleetEntry !== undefined) {
      return { ok: true, plane: planeOf(sid, fleetEntry), handle: sid, sessionId: sid, alias: null }
    }
    return { ok: false, reason: `unknown-addressee: no registered consumer with sessionId ${sid}` }
  }
  if (parsed.kind === 'bare') {
    const name = parsed.name
    if (registry.consumers[name] !== undefined) {
      const entry = registry.consumers[name]
      return { ok: true, plane: planeOf(name), handle: name, sessionId: name, alias: entry.alias ?? null }
    }
    const exactFleet = fleetTable(fleet)[name]
    const isExactFleet = exactFleet !== null && typeof exactFleet === 'object'
    const holders = aliasIndex(registry).get(name) ?? []
    if (isExactFleet && holders.length > 0) {
      return {
        ok: false,
        ambiguous: true,
        reason: `collision: bare name "${name}" is both a fleet code and a registered alias; use <alias>@<sessionId>`,
      }
    }
    if (holders.length === 1) {
      return { ok: true, plane: planeOf(holders[0]), handle: holders[0], sessionId: holders[0], alias: name }
    }
    if (holders.length > 1) {
      return {
        ok: false,
        ambiguous: true,
        reason: `unknown-addressee: alias "${name}" is ambiguous across ${holders.length} registered consumers; use <alias>@<sessionId>`,
      }
    }
    const fleetEntry = findFleetEntry(fleet, name, { mode: 'prefix' })
    if (fleetEntry !== undefined) {
      return { ok: true, plane: planeOf(fleetEntry.sessionId, fleetEntry), handle: fleetEntry.sessionId, sessionId: fleetEntry.sessionId, alias: null }
    }
    return { ok: false, reason: `unknown-addressee: "${name}" is neither a registered sessionId nor a resolvable alias` }
  }
  return { ok: false, reason: 'unknown-addressee: "to" field is missing or not a non-empty string' }
}

function fleetTable(fleet) {
  if (fleet !== null && typeof fleet === 'object'
    && fleet.fleet !== null && typeof fleet.fleet === 'object') {
    return fleet.fleet
  }
  return {}
}

function planeOf(sessionId, fleetEntry) {
  if (fleetEntry !== null && typeof fleetEntry === 'object' && fleetEntry.kind === 'orca-terminal') {
    return 'orca'
  }
  if (typeof sessionId === 'string') {
    if (sessionId.startsWith('session-')) return 'dsh'
    if (sessionId.startsWith('ctx_') || sessionId.startsWith('session_')) return 'dais'
  }
  return 'dsh'
}

function fleetEntryBySessionId(fleet, sessionId) {
  for (const entry of Object.values(fleetTable(fleet))) {
    if (entry !== null && typeof entry === 'object' && entry.sessionId === sessionId) return entry
  }
  return undefined
}

/**
 * entry-level fleet 查表(与路由分离;只回答"条目在不在、是哪条",不判 plane、不做撞名检测、不抛不 exit):
 *   mode 'exact'  : 仅精确键(fleet-touch get_entry 语义;miss 处置 die/exit 1 留调用方),绝不前缀回退
 *   mode 'prefix' : 先精确;miss 后按 Object.entries 迭代序返回第一个
 *                   entry.sessionId?.startsWith('session-' + key) 的条目(session-send resolve()/find_entry
 *                   语义逐字,含迭代序,保证短码解析结果一致)
 */
export function findFleetEntry(fleet, key, { mode = 'prefix' } = {}) {
  const table = fleetTable(fleet)
  const exact = table[key]
  if (exact !== null && typeof exact === 'object' && !Array.isArray(exact)) return exact
  if (mode !== 'prefix') return undefined
  for (const entry of Object.values(table)) {
    if (entry === null || typeof entry !== 'object') continue
    const sid = entry.sessionId
    if (typeof sid === 'string' && sid.startsWith('session-' + key)) return entry
  }
  return undefined
}

/** 薄包装: findFleetEntry(fleet, key, {mode:'prefix'})?.sessionId ?? undefined。 */
export function resolveFleetSessionId(fleet, key) {
  return findFleetEntry(fleet, key, { mode: 'prefix' })?.sessionId ?? undefined
}

// ---- registry 段(bridge/registry.json 原子读改写 + v3.6 写链语义) ----

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 白名单化消费者条目(仅 alias/pid/armedAt 三键;R-B04 拍板: consumer 条目不加 version 字段)。 */
export function sanitizeConsumers(raw) {
  const out = {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [sid, entry] of Object.entries(raw)) {
    if (typeof sid !== 'string' || sid.length === 0) continue
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    out[sid] = {
      alias: typeof entry.alias === 'string' && entry.alias.length > 0 ? entry.alias : null,
      pid: Number.isFinite(entry.pid) ? entry.pid : null,
      armedAt: typeof entry.armedAt === 'string' ? entry.armedAt : null,
    }
  }
  return out
}

export async function readRegistry(registryPath) {
  try {
    const txt = await fsp.readFile(registryPath, 'utf8')
    const parsed = JSON.parse(txt)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        version: typeof parsed.version === 'string' ? parsed.version : null,
        consumers: sanitizeConsumers(parsed.consumers),
      }
    }
  } catch {
    // 缺失或损坏: 视为空表。
  }
  return { version: null, consumers: {} }
}

// v3.6 写链语义(R-B14): 同进程多 watcher 并发读改写会撞同一 tmp 路径(ENOENT/丢更新)——
// 模块级按 registryPath 分链串行化全部写操作;唯一 tmp 名对齐 core/store.js saveState 模式。
// 跨进程 last-writer-wins 竞窗与现状相同,不引入 flock(升级另立票)。
const registryChains = new Map() // registryPath -> Promise
let registryWriteSeq = 0

function serializeRegistryOp(registryPath, operation) {
  const chain = registryChains.get(registryPath) ?? Promise.resolve()
  const next = chain.then(operation, operation)
  registryChains.set(registryPath, next.catch(() => {}))
  return next
}

export async function writeRegistryAtomic(registryPath, registry) {
  const tmp = `${registryPath}.tmp-${process.pid}-${++registryWriteSeq}`
  await fsp.writeFile(tmp, `${JSON.stringify(registry, null, 2)}\n`)
  await fsp.rename(tmp, registryPath)
}

/**
 * 注册/续期一条消费者(读改写保留其他条目,唯一 tmp + rename 原子落盘,经串行链)。
 * 写失败不抛(IO 抖动不丢路由)——条目仍并入返回的内存视图。
 */
export function registerConsumer(registryPath, version, consumer, { armedAt, pid }) {
  return serializeRegistryOp(registryPath, async () => {
    const registry = await readRegistry(registryPath)
    registry.version = version
    registry.consumers[consumer.sessionId] = { alias: consumer.alias ?? null, pid, armedAt }
    try {
      await writeRegistryAtomic(registryPath, registry)
    } catch (error) {
      console.error('_narrow-waist registry.json write failed:', errorMessage(error))
    }
    return registry
  })
}

export function unregisterConsumer(registryPath, version, sessionId) {
  return serializeRegistryOp(registryPath, async () => {
    const registry = await readRegistry(registryPath)
    if (registry.consumers[sessionId] !== undefined) {
      delete registry.consumers[sessionId]
      registry.version = version
      try {
        await writeRegistryAtomic(registryPath, registry)
      } catch (error) {
        console.error('_narrow-waist registry.json unregister failed:', errorMessage(error))
      }
    }
    return registry
  })
}
