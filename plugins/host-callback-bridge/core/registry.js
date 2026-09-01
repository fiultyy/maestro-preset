/**
 * registry.js — bridge/registry.json 原子读改写 + alias-epoch 代际机制(IDX-3/IDX-4)。
 * 逐行平移自 maestro-preset plugins/callback-bridge/core/registry.js
 * (pump.js:189-226,363-392);本 lane 自包含副本(见 README"路径分治")。
 * host lane 语义: registry 条目是**持久路由表**(键=sessionId,跨 host 重启有效),
 * pid/armedAt 仅元数据;新代际会话经 POST /register 自注册(替代 bridge_arm)。
 *
 * v5(spec-dsh-callback-addr-epoch §2,冻结):
 *   consumers.<sid> += { epoch, stale:null|{since,supersededBy,epoch} }
 *   aliases.<alias>  = { epoch, holder: sid|null }   ← 代际权威源(账本永不清)
 *   换代规则: 同 alias 新 sid 重 arm = epoch+1+旧槽 stale(立即退出一切路由);
 *             同 sid 重 arm = 续期不换代; sid 改挂新别名 = 旧别名 holder=null
 *             (epoch 保留,单调递增防 ABA); /unregister = 干净退役(无 stale 槽)。
 *   懒迁移(§3.3): 读到无 epoch 的 v4 条目 → 内存视图回填 epoch:0 +
 *   aliases 按持有人派生(同别名多槽 → holder:null);首次写回在 register/
 *   unregister/prune。回滚兼容: 旧代码 sanitizeConsumers 白名单剥掉新键 → 自然降级。
 */
import * as fsp from 'node:fs/promises'

/** registry 文件版本(v5 = alias-epoch 代际面)。 */
export const REGISTRY_VERSION = '5.0.0'
/** stale 槽默认保留期(undertaker;可被 activate/file-router 覆盖)。 */
export const STALE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function sanitizeStale(raw) {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) return null
  const since = typeof raw.since === 'string' ? raw.since : null
  const supersededBy = typeof raw.supersededBy === 'string' && raw.supersededBy.length > 0 ? raw.supersededBy : null
  const epoch = Number.isFinite(raw.epoch) && raw.epoch >= 0 ? Math.trunc(raw.epoch) : null
  if (since === null || supersededBy === null || epoch === null) return null
  return { since, supersededBy, epoch }
}

/**
 * 白名单化消费者条目(alias/pid/armedAt + v5 增量 epoch/stale)。
 * v4 懒迁移: 无 epoch 的条目在**内存视图**回填 epoch:0(spec §3.3)。
 */
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
      epoch: Number.isFinite(entry.epoch) && entry.epoch >= 0 ? Math.trunc(entry.epoch) : 0,
      stale: sanitizeStale(entry.stale),
    }
  }
  return out
}

function sanitizeAliases(raw) {
  const out = {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [alias, entry] of Object.entries(raw)) {
    if (typeof alias !== 'string' || alias.length === 0) continue
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    out[alias] = {
      epoch: Number.isFinite(entry.epoch) && entry.epoch >= 0 ? Math.trunc(entry.epoch) : 0,
      holder: typeof entry.holder === 'string' && entry.holder.length > 0 ? entry.holder : null,
    }
  }
  return out
}

/** v4(无 aliases 节)→ 派生别名账本: 同别名多活槽 → holder:null(裸别名本就歧义死信)。 */
function deriveAliases(consumers) {
  const holders = new Map()
  for (const [sid, entry] of Object.entries(consumers)) {
    if (entry.stale !== null || typeof entry.alias !== 'string') continue
    if (!holders.has(entry.alias)) holders.set(entry.alias, [])
    holders.get(entry.alias).push(sid)
  }
  const aliases = {}
  for (const [alias, sids] of holders) {
    aliases[alias] = { epoch: 0, holder: sids.length === 1 ? sids[0] : null }
  }
  return aliases
}

/** 消费者视图里的别名账本与槽对齐(手写 v5 缺账本条目时兜底派生)。 */
function alignAliases(aliases, consumers) {
  const out = { ...aliases }
  const byAlias = new Map()
  for (const [sid, entry] of Object.entries(consumers)) {
    if (entry.stale !== null || typeof entry.alias !== 'string') continue
    if (!byAlias.has(entry.alias)) byAlias.set(entry.alias, [])
    byAlias.get(entry.alias).push(sid)
  }
  for (const [alias, sids] of byAlias) {
    if (out[alias] === undefined) {
      const epochs = sids.map((sid) => consumers[sid].epoch)
      out[alias] = { epoch: epochs.reduce((a, b) => Math.max(a, b), 0), holder: sids.length === 1 ? sids[0] : null }
    }
  }
  return out
}

export async function readRegistry(registryPath) {
  try {
    const txt = await fsp.readFile(registryPath, 'utf8')
    const parsed = JSON.parse(txt)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const consumers = sanitizeConsumers(parsed.consumers)
      const aliases = Object.keys(sanitizeAliases(parsed.aliases)).length > 0 || parsed.aliases !== undefined
        ? alignAliases(sanitizeAliases(parsed.aliases), consumers)
        : deriveAliases(consumers)
      return {
        version: typeof parsed.version === 'string' ? parsed.version : null,
        consumers,
        aliases,
      }
    }
  } catch {
    // 缺失或损坏: 视为空表。
  }
  return { version: null, consumers: {}, aliases: {} }
}

export async function writeRegistryAtomic(registryPath, registry) {
  const tmp = `${registryPath}.tmp`
  await fsp.writeFile(tmp, `${JSON.stringify({ ...registry, version: REGISTRY_VERSION }, null, 2)}\n`)
  await fsp.rename(tmp, registryPath)
}

/**
 * 注册/续期一条消费者(v5 代际机,读改写保留其他条目,tmp+rename 原子落盘)。
 * 写失败不抛(IO 抖动不丢路由)——条目仍并入返回的内存视图。
 * 返回 { registry, receipt: { signature, epoch, superseded } }:
 *   superseded 非空 = 本次 arm 造成换代(旧 sid/旧代)——编排者据此广播作废(spec §2.3)。
 */
export async function registerConsumer(registryPath, registryVersion, consumer, { armedAt, pid, now = () => Date.now() }) {
  const registry = await readRegistry(registryPath)
  registry.version = REGISTRY_VERSION
  const sid = consumer.sessionId
  const alias = typeof consumer.alias === 'string' && consumer.alias.length > 0 ? consumer.alias : null
  const slot = registry.consumers[sid] ?? { alias: null, pid: null, armedAt: null, epoch: 0, stale: null }
  let superseded = null
  let epoch = slot.epoch ?? 0

  if (alias !== null) {
    const ledger = registry.aliases[alias] ?? { epoch: 0, holder: null }
    if (ledger.holder !== null && ledger.holder !== sid) {
      // 换代(§2.2): epoch+1, 旧持有者槽 stale(立即退出一切路由), 剪同别名更旧代 stale。
      const oldSid = ledger.holder
      const old = registry.consumers[oldSid]
      const oldEpoch = old?.epoch ?? ledger.epoch
      epoch = ledger.epoch + 1
      ledger.epoch = epoch
      ledger.holder = sid
      if (old !== undefined) {
        old.stale = { since: new Date(now()).toISOString(), supersededBy: sid, epoch: oldEpoch }
      }
      superseded = { sessionId: oldSid, alias, epoch: oldEpoch }
      for (const [s, e] of Object.entries(registry.consumers)) {
        if (s !== oldSid && e?.stale !== null && e?.alias === alias) delete registry.consumers[s]
      }
    } else if (ledger.holder === null) {
      // 别名现无主(epoch 保留不回退): 本席接任, 代际继续。
      epoch = ledger.epoch + 1
      ledger.epoch = epoch
      ledger.holder = sid
    } else {
      // 同 sid 续期(持有人未变): epoch 不变, armedAt/pid 刷新; 曾 stale 的槽复活。
      epoch = ledger.epoch
    }
    registry.aliases[alias] = ledger
    if (slot.alias !== null && slot.alias !== alias && registry.aliases[slot.alias]?.holder === sid) {
      // sid 改挂新别名: 旧别名 holder=null(epoch 保留)——干净让位, 不产 stale 槽。
      registry.aliases[slot.alias] = { ...registry.aliases[slot.alias], holder: null }
    }
  }

  registry.consumers[sid] = {
    alias,
    pid,
    armedAt,
    epoch,
    stale: alias !== null && registry.aliases[alias]?.holder === sid ? null : slot.stale,
  }
  try {
    await writeRegistryAtomic(registryPath, registry)
  } catch (error) {
    console.error('host-callback-bridge registry.json write failed:', errorMessage(error))
  }
  return {
    registry,
    receipt: { signature: alias !== null ? `${alias}@${sid}` : sid, epoch, superseded },
  }
}

/** 干净退役(§2.2): 删槽, 别名 holder=null(epoch 保留), 不产 stale 槽。 */
export async function unregisterConsumer(registryPath, registryVersion, sessionId) {
  const registry = await readRegistry(registryPath)
  if (registry.consumers[sessionId] !== undefined) {
    const alias = registry.consumers[sessionId].alias
    delete registry.consumers[sessionId]
    if (alias !== null && registry.aliases[alias]?.holder === sessionId) {
      registry.aliases[alias] = { ...registry.aliases[alias], holder: null }
    }
    registry.version = REGISTRY_VERSION
    try {
      await writeRegistryAtomic(registryPath, registry)
    } catch (error) {
      console.error('host-callback-bridge registry.json unregister failed:', errorMessage(error))
    }
  }
  return registry
}

/**
 * undertaker(§2.5): 清理超期 stale 槽(保留期内不动; 同别名更旧代已在换代时剪除)。
 * 只删 consumers 里的 stale 槽; aliases 账本永不清(epoch 是审计事实)。
 * 返回被剪除的 sessionId 列表(未变盘 = 空表)。
 */
export async function pruneStaleSlots(registryPath, { retentionMs = STALE_RETENTION_MS, now = () => Date.now() } = {}) {
  const registry = await readRegistry(registryPath)
  const pruned = []
  for (const [sid, entry] of Object.entries(registry.consumers)) {
    if (entry.stale === null) continue
    const sinceMs = Date.parse(entry.stale.since)
    if (Number.isFinite(sinceMs) && now() - sinceMs > retentionMs) {
      delete registry.consumers[sid]
      pruned.push(sid)
    }
  }
  if (pruned.length > 0) {
    registry.version = REGISTRY_VERSION
    try {
      await writeRegistryAtomic(registryPath, registry)
    } catch (error) {
      console.error('host-callback-bridge registry.json prune failed:', errorMessage(error))
    }
  }
  return pruned
}
