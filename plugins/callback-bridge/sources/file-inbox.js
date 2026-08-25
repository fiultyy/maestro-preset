/**
 * file-inbox.js — 文件桥 source(pump.js:378-658 平移)。
 * 职责: fs.watch inbox / per-consumer 游标 / at-least-once / 退避重试 / 死信 / 回声 / 轮转闸门。
 * at-least-once 主循环整体保留;wake 失败策略经 sink 抛错触发(文件侧退避×3→死信)。
 */
import { watch } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { parseAddress } from '../core/addressing.js'
import { digestOf } from '../core/dedup.js'
import { registerConsumer, unregisterConsumer } from '../core/registry.js'
import { fileSafeSid } from '../core/store.js'

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 切成"已写完的完整行"数组: 末尾无换行的残行不算(pump.js:84-90)。 */
function splitCompleteLines(txt) {
  if (txt.length === 0) return []
  const cut = txt.endsWith('\n') ? txt.length : txt.lastIndexOf('\n') + 1
  if (cut === 0) return []
  const body = txt.slice(0, cut - 1)
  return body.length === 0 ? [] : body.split('\n')
}

/** 行是否为可解析 JSON(pump.js:93-99)。 */
function tryParseJson(line) {
  try {
    return { ok: true, value: JSON.parse(line) }
  } catch {
    return { ok: false }
  }
}

function isoOf(now) {
  return new Date(now()).toISOString()
}

/**
 * 与宿主解耦的文件桥 source(对应 pump.js createPump)。
 *
 * config:
 *   store       — createBridgeStore({ bridgeDir })(paths/readState/saveState)
 *   consumer    — 本消费者身份 { sessionId, alias? }
 *   router      — { resolve(address, self, registry) }
 *   dedup       — createDedupWindow(...)(跨 source 共享)
 *   sink        — { deliver(line, info) };抛错 = 投递失败(触发退避/死信)
 *   version     — 版本指纹(state.json/registry.json 写入)
 *   echoPrefix / rotateMaxBytes / rotateMaxLines / dedupWindowMs / maxWakeFailures / retryDelayMs
 *   now()       — 时钟注入(测试用)
 *
 * 返回 { id, start, stop, status, flush, dispose, snapshot, paths }。
 */
export function createFileInboxSource(config) {
  const {
    store,
    consumer,
    router,
    dedup,
    sink,
    version,
    echoPrefix = 'DSH-RE]',
    rotateMaxBytes = 1024 * 1024,
    rotateMaxLines = 1000,
    dedupWindowMs = 60_000,
    maxWakeFailures = 3,
    retryDelayMs = 2_000,
    now = () => Date.now(),
  } = config

  if (store === null || typeof store !== 'object' || typeof store.paths !== 'object') {
    throw new TypeError('createFileInboxSource: store { paths, readState, saveState } is required')
  }
  if (typeof router !== 'object' || router === null || typeof router.resolve !== 'function') {
    throw new TypeError('createFileInboxSource: router.resolve is required')
  }
  if (dedup === null || typeof dedup !== 'object' || typeof dedup.seen !== 'function' || typeof dedup.mark !== 'function') {
    throw new TypeError('createFileInboxSource: dedup { seen, mark } is required')
  }
  if (sink === null || typeof sink !== 'object' || typeof sink.deliver !== 'function') {
    throw new TypeError('createFileInboxSource: sink.deliver is required')
  }
  if (consumer === null || typeof consumer !== 'object' || Array.isArray(consumer)) {
    throw new TypeError('createFileInboxSource: consumer { sessionId, alias? } is required (v3.5)')
  }
  if (typeof consumer.sessionId !== 'string' || consumer.sessionId.length === 0) {
    throw new TypeError('createFileInboxSource: consumer.sessionId must be a non-empty string')
  }
  if (consumer.alias !== undefined && consumer.alias !== null
    && (typeof consumer.alias !== 'string' || consumer.alias.length === 0)) {
    throw new TypeError('createFileInboxSource: consumer.alias must be a non-empty string when provided')
  }

  const paths = store.paths
  const canonical = consumer.alias ? `${consumer.alias}@${consumer.sessionId}` : consumer.sessionId

  const rt = {
    cursor: null,
    flushing: false,
    retryTimer: null,
    loaded: false,
    registered: false,
    armedAt: null,
    registry: { version: null, consumers: {} },
    failures: { digest: null, count: 0 },
  }

  // 本消费者在 state.json 的持久化分节(consumers.<sessionId>,平铺计数)。
  const own = {
    alias: consumer.alias ?? null,
    pid: process.pid,
    armedAt: null,
    lastDeliveredAt: null,
    deliveredCount: 0,
    deadCount: 0,
    echoCount: 0,
    blankCount: 0,
    dedupCount: 0,
    skippedCount: 0,
    broadcastCount: 0,
    lastDeadAt: null,
    senders: {},
  }
  // 桥级全局(轮转)计数。
  const globals = { rotatedCount: 0, lastRotatedAt: null }

  async function loadState() {
    const saved = await store.readState()
    if (Number.isFinite(saved.rotatedCount)) globals.rotatedCount = saved.rotatedCount
    if (typeof saved.lastRotatedAt === 'string') globals.lastRotatedAt = saved.lastRotatedAt
    const mine = saved.consumers?.[consumer.sessionId]
    if (mine !== null && typeof mine === 'object' && !Array.isArray(mine)) {
      for (const key of Object.keys(own)) {
        if (mine[key] !== undefined) own[key] = mine[key]
      }
    }
    rt.loaded = true
  }

  async function saveState() {
    await store.saveState((root) => {
      root.version = version
      root.rotatedCount = globals.rotatedCount
      root.lastRotatedAt = globals.lastRotatedAt
      if (root.consumers === null || typeof root.consumers !== 'object' || Array.isArray(root.consumers)) {
        root.consumers = {}
      }
      const prev = root.consumers[consumer.sessionId]
      const prevHttp = (prev !== null && typeof prev === 'object' && !Array.isArray(prev)) ? prev.http : undefined
      const section = { ...JSON.parse(JSON.stringify(own)), cursor: rt.cursor ?? 0 }
      if (prevHttp !== undefined) section.http = prevHttp // 保留 http source 分节,避免覆盖
      root.consumers[consumer.sessionId] = section
    })
  }

  /** 注册自身(每轮 flush 幂等续期;armedAt 取首次值保 undertaker 稳定)。 */
  async function registerSelf() {
    if (rt.armedAt === null) rt.armedAt = isoOf(now)
    own.armedAt = rt.armedAt
    own.pid = process.pid
    const registry = await registerConsumer(paths.registry, version, consumer, { armedAt: rt.armedAt, pid: process.pid })
    rt.registered = true
    return registry
  }

  async function unregisterSelf() {
    await unregisterConsumer(paths.registry, version, consumer.sessionId)
    rt.registered = false
  }

  async function readCursorFile(path) {
    try {
      const txt = await fsp.readFile(path, 'utf8')
      const n = Number.parseInt(txt.trim(), 10)
      return Number.isFinite(n) && n > 0 ? n : 0
    } catch {
      return 0
    }
  }

  function writeCursorFile(path, n) {
    // 写失败仅损失"跨重启去重",重启后重投由 dedup 窗口吸收。
    return fsp.writeFile(path, String(n)).catch((error) => {
      console.error('callback-bridge cursor write failed:', errorMessage(error))
    })
  }

  async function appendDead(line, reason) {
    const entry = `${JSON.stringify({ at: isoOf(now), reason, line })}\n`
    try {
      await fsp.appendFile(paths.dead, entry)
    } catch (error) {
      console.error('callback-bridge dead.log append failed:', errorMessage(error))
    }
    own.deadCount += 1
    own.lastDeadAt = isoOf(now)
  }

  async function appendEcho(line) {
    try {
      await fsp.appendFile(paths.echo, `${line}\n`)
    } catch (error) {
      console.error('callback-bridge echo.log append failed:', errorMessage(error))
    }
    own.echoCount += 1
  }

  function noteDelivery(parsed, broadcast) {
    own.deliveredCount += 1
    if (broadcast) own.broadcastCount += 1
    own.lastDeliveredAt = isoOf(now)
    const from = parsed !== null && typeof parsed === 'object' && typeof parsed.from === 'string'
      ? parsed.from
      : '(unknown)'
    const sender = own.senders[from] ?? { deliveredCount: 0, lastDeliveredAt: null }
    sender.deliveredCount += 1
    sender.lastDeliveredAt = own.lastDeliveredAt
    own.senders[from] = sender
  }

  function scheduleRetry() {
    if (rt.retryTimer !== null) return
    rt.retryTimer = setTimeout(() => {
      rt.retryTimer = null
      flush().catch((error) => {
        console.error('callback-bridge retry flush failed:', errorMessage(error))
      })
    }, retryDelayMs)
    rt.retryTimer.unref?.()
  }

  /** undertaker: 行内在终态(malformed/unknown-addressee)的唯一死信责任人。 */
  function undertakerSessionId(registry) {
    let best = null
    for (const sid of Object.keys(registry.consumers)) {
      if (best === null) {
        best = sid
        continue
      }
      const a = registry.consumers[sid].armedAt ?? ''
      const b = registry.consumers[best].armedAt ?? ''
      if (a < b || (a === b && sid < best)) best = sid
    }
    return best
  }

  /** 轮转: 多消费者闸门——所有在册消费者游标都到尾才 rename;成功归零全部游标文件。 */
  async function rotateIfOversized(txt, completeCount, registry) {
    if (txt.length === 0) return false
    let size = Buffer.byteLength(txt)
    try {
      const st = await fsp.stat(paths.inbox)
      size = st.size
    } catch {
      return false
    }
    if (size <= rotateMaxBytes && completeCount <= rotateMaxLines) return false
    for (const sid of Object.keys(registry.consumers)) {
      const consumed = sid === consumer.sessionId
        ? rt.cursor
        : await readCursorFile(paths.cursorFor(sid))
      if (consumed < completeCount) return false
    }
    try {
      await fsp.rename(paths.inbox, paths.rotated) // POSIX: 覆盖旧一代
    } catch (error) {
      console.error('callback-bridge rotate rename failed:', errorMessage(error))
      return false
    }
    rt.cursor = 0
    await writeCursorFile(paths.cursorFor(consumer.sessionId), 0)
    for (const sid of Object.keys(registry.consumers)) {
      if (sid !== consumer.sessionId) await writeCursorFile(paths.cursorFor(sid), 0)
    }
    globals.rotatedCount += 1
    globals.lastRotatedAt = isoOf(now)
    await saveState()
    return true
  }

  async function flush() {
    if (rt.flushing) return
    rt.flushing = true
    try {
      if (!rt.loaded) await loadState()
      if (rt.cursor === null) rt.cursor = await readCursorFile(paths.cursorFor(consumer.sessionId))
      for (;;) {
        const registry = await registerSelf()
        rt.registry = registry
        const txt = await fsp.readFile(paths.inbox, 'utf8').catch(() => '')
        const lines = splitCompleteLines(txt)
        // 外部轮转/手工截断使文件变短时,游标钳到行尾,避免永久卡死。
        if (rt.cursor > lines.length) {
          rt.cursor = lines.length
          await writeCursorFile(paths.cursorFor(consumer.sessionId), rt.cursor)
        }
        while (rt.cursor < lines.length) {
          const line = lines[rt.cursor]

          if (line.startsWith(echoPrefix)) {
            await appendEcho(line)
            rt.cursor += 1
            await writeCursorFile(paths.cursorFor(consumer.sessionId), rt.cursor)
            await saveState()
            continue
          }

          if (line.trim().length === 0) {
            own.blankCount += 1
            rt.cursor += 1
            await writeCursorFile(paths.cursorFor(consumer.sessionId), rt.cursor)
            continue
          }

          const parsed = tryParseJson(line)
          if (!parsed.ok) {
            if (undertakerSessionId(registry) === consumer.sessionId) {
              await appendDead(line, 'malformed: line is not valid JSON')
            }
            rt.cursor += 1
            await writeCursorFile(paths.cursorFor(consumer.sessionId), rt.cursor)
            await saveState()
            continue
          }

          const value = parsed.value
          const toValue = value !== null && typeof value === 'object' && !Array.isArray(value)
            ? value.to
            : undefined
          const routing = router.resolve(
            parseAddress(toValue),
            { sessionId: consumer.sessionId, alias: own.alias },
            registry,
          )

          if (routing.action === 'dead') {
            if (undertakerSessionId(registry) === consumer.sessionId) {
              await appendDead(line, routing.reason)
            }
            rt.cursor += 1
            await writeCursorFile(paths.cursorFor(consumer.sessionId), rt.cursor)
            await saveState()
            continue
          }

          if (routing.action === 'skip') {
            own.skippedCount += 1
            rt.cursor += 1
            await writeCursorFile(paths.cursorFor(consumer.sessionId), rt.cursor)
            await saveState()
            continue
          }

          const digest = digestOf(line, value)
          if (dedup.seen(digest) !== undefined) {
            own.dedupCount += 1
            rt.cursor += 1
            await writeCursorFile(paths.cursorFor(consumer.sessionId), rt.cursor)
            await saveState()
            continue
          }

          try {
            await sink.deliver(line, { parsed: value, at: now(), to: toValue, broadcast: routing.broadcast, consumer: canonical })
          } catch (error) {
            const count = rt.failures.digest === digest ? rt.failures.count + 1 : 1
            rt.failures = { digest, count }
            if (count >= maxWakeFailures) {
              await appendDead(line, `wake failed ${count} consecutive attempts: ${errorMessage(error)}`)
              rt.failures = { digest: null, count: 0 }
              rt.cursor += 1
              await writeCursorFile(paths.cursorFor(consumer.sessionId), rt.cursor)
              await saveState()
              continue
            }
            scheduleRetry()
            return
          }

          rt.failures = { digest: null, count: 0 }
          dedup.mark(digest)
          noteDelivery(value, routing.broadcast)
          rt.cursor += 1
          await writeCursorFile(paths.cursorFor(consumer.sessionId), rt.cursor)
          await saveState()
        }
        const rotated = await rotateIfOversized(txt, lines.length, registry)
        if (!rotated) break
      }
    } finally {
      rt.flushing = false
    }
  }

  async function dispose() {
    if (rt.retryTimer !== null) {
      clearTimeout(rt.retryTimer)
      rt.retryTimer = null
    }
    if (rt.registered) await unregisterSelf()
  }

  function snapshot() {
    return {
      consumer: { sessionId: consumer.sessionId, alias: own.alias, canonical },
      cursor: rt.cursor,
      flushing: rt.flushing,
      pendingFailure: { ...rt.failures },
      dedupSize: dedup.size,
      registered: rt.registered,
      registeredConsumers: Object.keys(rt.registry.consumers),
      ...JSON.parse(JSON.stringify(own)),
      ...JSON.parse(JSON.stringify(globals)),
    }
  }

  let watcher = null
  function start() {
    if (watcher !== null) return
    watcher = watch(paths.dir, (_event, filename) => {
      if (filename === 'inbox.log') {
        flush().catch((error) => {
          console.error('callback-bridge flush failed:', errorMessage(error))
        })
      }
    })
  }

  function stop() {
    if (watcher !== null) {
      watcher.close()
      watcher = null
    }
  }

  function status() {
    return { kind: 'file-inbox', ...snapshot(), watching: watcher !== null }
  }

  // P4.1.1: 重复 arm 刷新本槽 consumer 元数据(别名变更 → registry 重写带新 canonical)。
  function refreshConsumer(next) {
    if (next === null || typeof next !== 'object') return
    if (typeof next.alias === 'string' && next.alias.length > 0) consumer.alias = next.alias
    else if (next.alias === null) consumer.alias = undefined
  }

  return { id: 'file-inbox', start, stop, status, flush, dispose, snapshot, paths, refreshConsumer }
}
