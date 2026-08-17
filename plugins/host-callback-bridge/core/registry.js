/**
 * registry.js — bridge/registry.json 原子读改写。
 * 逐行平移自 maestro-preset plugins/callback-bridge/core/registry.js
 * (pump.js:189-226,363-392);本 lane 自包含副本(见 README"路径分治")。
 * host lane 语义: registry 条目是**持久路由表**(键=sessionId,跨 host 重启有效),
 * pid/armedAt 仅元数据;新代际会话经 POST /register 自注册(替代 bridge_arm)。
 */
import * as fsp from 'node:fs/promises'

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 白名单化消费者条目(仅 alias/pid/armedAt)。 */
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

export async function writeRegistryAtomic(registryPath, registry) {
  const tmp = `${registryPath}.tmp`
  await fsp.writeFile(tmp, `${JSON.stringify(registry, null, 2)}\n`)
  await fsp.rename(tmp, registryPath)
}

/**
 * 注册/续期一条消费者(读改写保留其他条目,tmp+rename 原子落盘)。
 * 写失败不抛(IO 抖动不丢路由)——条目仍并入返回的内存视图。
 */
export async function registerConsumer(registryPath, version, consumer, { armedAt, pid }) {
  const registry = await readRegistry(registryPath)
  registry.version = version
  registry.consumers[consumer.sessionId] = { alias: consumer.alias ?? null, pid, armedAt }
  try {
    await writeRegistryAtomic(registryPath, registry)
  } catch (error) {
    console.error('host-callback-bridge registry.json write failed:', errorMessage(error))
  }
  return registry
}

export async function unregisterConsumer(registryPath, version, sessionId) {
  const registry = await readRegistry(registryPath)
  if (registry.consumers[sessionId] !== undefined) {
    delete registry.consumers[sessionId]
    registry.version = version
    try {
      await writeRegistryAtomic(registryPath, registry)
    } catch (error) {
      console.error('host-callback-bridge registry.json unregister failed:', errorMessage(error))
    }
  }
  return registry
}
