/**
 * registry.js — bridge/registry.json 原子读改写。
 * 平移自 pump.js:189-226(sanitize/read/write),363-392(register/unregister 一般化)。
 */
import * as fsp from 'node:fs/promises'

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 白名单化消费者条目(仅 alias/pid/armedAt),pump.js:191-204。 */
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
 * 注册/续期自身条目(读改写保留他消费者,tmp+rename 原子落盘)。
 * 写失败不抛(IO 抖动不丢自身路由)——自身仍并入返回的内存视图。
 */
export async function registerConsumer(registryPath, version, consumer, { armedAt, pid }) {
  const registry = await readRegistry(registryPath)
  registry.version = version
  registry.consumers[consumer.sessionId] = { alias: consumer.alias ?? null, pid, armedAt }
  try {
    await writeRegistryAtomic(registryPath, registry)
  } catch (error) {
    console.error('callback-bridge registry.json write failed:', errorMessage(error))
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
      console.error('callback-bridge registry.json unregister failed:', errorMessage(error))
    }
  }
  return registry
}
