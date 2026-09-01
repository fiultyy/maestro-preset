/**
 * file-router.js — 文件消费面(SI-003 ②③): fs.watch 事件驱动,禁轮询。
 *
 * 职责(与 v3.5/v3.6 文件桥同构,视角从"每会话一泵"改为"宿主单路由"):
 *   - fs.watch 盯 bridge 目录的 inbox.log(事件直达 flush,稳态零定时器;
 *     仅投递失败退避时有一次性 setTimeout,unref);
 *   - 全局游标(.cursor.host-bridge + state.json hostBridge.cursor),at-least-once;
 *     首次接管时从既有消费者游标最大值续(legacy 消费进度无缝接管,积压照常投递);
 *   - 每行按 registry.json 裁定: 单播 → 目标会话;广播 → 每在册消费者各一次;
 *     回声(DSH-RE] 前缀)→ echo.log;malformed/unknown-addressee → dead.log
 *     (措辞与 v3.5/v3.6 逐字一致);投递失败退避×maxWakeFailures → dead.log;
 *   - 轮转闸门: 本游标到尾 + 超 1MB/1000 行 → rename inbox.log.1,游标归零;
 *   - 投递经 sink.deliver(sessionId, line, info)(loopback session.prompt)。
 */
import { watch } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { parseAddress, resolveHostRouting } from './core/addressing.js'
import { digestKeys, digestOf } from './core/dedup.js'
import { readRegistry, pruneStaleSlots, STALE_RETENTION_MS } from './core/registry.js'

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 切成"已写完的完整行"数组: 末尾无换行的残行不算。 */
function splitCompleteLines(txt) {
  if (txt.length === 0) return []
  const cut = txt.endsWith('\n') ? txt.length : txt.lastIndexOf('\n') + 1
  if (cut === 0) return []
  const body = txt.slice(0, cut - 1)
  return body.length === 0 ? [] : body.split('\n')
}

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

const HOST_CONSUMER_ID = 'host-bridge'

/**
 * createFileRouter(config):
 *   store / router / dedup / sink / version — 共享内核
 *   echoPrefix / rotateMaxBytes / rotateMaxLines / dedupWindowMs /
 *   maxWakeFailures / retryDelayMs / now
 * 返回 { id, start, stop, status, flush, snapshot }。
 */
export function createFileRouter(config) {
  const {
    store,
    dedup,
    sink,
    version,
    echoPrefix = 'DSH-RE]',
    rotateMaxBytes = 1024 * 1024,
    rotateMaxLines = 1000,
    dedupWindowMs = 60_000,
    maxWakeFailures = 3,
    retryDelayMs = 2_000,
    staleRetentionMs = STALE_RETENTION_MS,
    now = () => Date.now(),
  } = config

  if (store === null || typeof store !== 'object' || typeof store.paths !== 'object') {
    throw new TypeError('createFileRouter: store { paths, readState, saveState } is required')
  }
  if (dedup === null || typeof dedup !== 'object' || typeof dedup.seen !== 'function' || typeof dedup.mark !== 'function') {
    throw new TypeError('createFileRouter: dedup { seen, mark } is required')
  }
  if (sink === null || typeof sink !== 'object' || typeof sink.deliver !== 'function') {
    throw new TypeError('createFileRouter: sink.deliver is required')
  }

  const paths = store.paths
  const rt = {
    cursor: null,
    flushing: false,
    retryTimer: null,
    startedAt: null,
    pending: null, // { line, parsed, digest, broadcast, to, attempts: Map<sid, n> }
  }

  const counters = {
    deliveredLines: 0,
    wakeTargets: 0,
    broadcastLines: 0,
    deadCount: 0,
    echoCount: 0,
    blankCount: 0,
    dedupCount: 0,
    skippedCount: 0,
    staleHits: 0,
    prunedStaleSlots: 0,
    lastDeliveredAt: null,
    lastDeadAt: null,
    senders: {},
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

  function writeCursorFile(n) {
    return fsp.writeFile(paths.cursorFor(HOST_CONSUMER_ID), String(n)).catch((error) => {
      console.error('host-callback-bridge cursor write failed:', errorMessage(error))
    })
  }

  /**
   * 首次接管游标: 自有游标文件存在(含 0,如轮转后)即为权威;文件缺失 = 首次接管,
   * 从既有消费者进度(游标文件 + state 分节)取最大值续——legacy 泵消费到哪,宿主
   * 路由从哪续,积压行照常投递。
   */
  async function initialCursor() {
    try {
      const txt = await fsp.readFile(paths.cursorFor(HOST_CONSUMER_ID), 'utf8')
      const own = Number.parseInt(txt.trim(), 10)
      if (Number.isFinite(own) && own >= 0) return own
    } catch {
      // 自有游标缺失: 走接管逻辑。
    }
    let max = 0
    try {
      for (const name of await fsp.readdir(paths.dir)) {
        if (!name.startsWith('.cursor.')) continue
        const n = await readCursorFile(`${paths.dir}/${name}`)
        if (n > max) max = n
      }
    } catch {
      // 目录不可读: 从 0 起。
    }
    try {
      const state = await store.readState()
      for (const section of Object.values(state.consumers ?? {})) {
        const n = Number.parseInt(section?.cursor, 10)
        if (Number.isFinite(n) && n > max) max = n
      }
    } catch {
      // state 缺失: 忽略。
    }
    return max
  }

  async function saveState() {
    await store.saveState((root) => {
      root.version = version
      if (root.hostBridge === null || typeof root.hostBridge !== 'object' || Array.isArray(root.hostBridge)) {
        root.hostBridge = {}
      }
      root.hostBridge.version = version
      root.hostBridge.pid = process.pid
      root.hostBridge.startedAt = rt.startedAt
      root.hostBridge.cursor = rt.cursor ?? 0
      root.hostBridge.counters = {
        deliveredLines: counters.deliveredLines,
        wakeTargets: counters.wakeTargets,
        broadcastLines: counters.broadcastLines,
        deadCount: counters.deadCount,
        echoCount: counters.echoCount,
        blankCount: counters.blankCount,
        dedupCount: counters.dedupCount,
        skippedCount: counters.skippedCount,
        staleHits: counters.staleHits,
        prunedStaleSlots: counters.prunedStaleSlots,
        lastDeliveredAt: counters.lastDeliveredAt,
        lastDeadAt: counters.lastDeadAt,
      }
      root.hostBridge.senders = counters.senders
    })
  }

  /** dead.log 追加(IDX-4: classification 键按需新增,既有键形状不动,spec §1.1)。 */
  async function appendDead(line, reason, classification = null) {
    const entry = classification === null
      ? { at: isoOf(now), reason, line }
      : { at: isoOf(now), reason, classification, line }
    try {
      await fsp.appendFile(paths.dead, `${JSON.stringify(entry)}\n`)
    } catch (error) {
      console.error('host-callback-bridge dead.log append failed:', errorMessage(error))
    }
    counters.deadCount += 1
    counters.lastDeadAt = isoOf(now)
  }

  async function appendEcho(line) {
    try {
      await fsp.appendFile(paths.echo, `${line}\n`)
    } catch (error) {
      console.error('host-callback-bridge echo.log append failed:', errorMessage(error))
    }
    counters.echoCount += 1
  }

  function noteDelivery(parsed, targets) {
    counters.deliveredLines += 1
    counters.wakeTargets += targets
    counters.lastDeliveredAt = isoOf(now)
    const from = parsed !== null && typeof parsed === 'object' && typeof parsed.from === 'string'
      ? parsed.from
      : '(unknown)'
    const sender = counters.senders[from] ?? { deliveredCount: 0, lastDeliveredAt: null }
    sender.deliveredCount += 1
    sender.lastDeliveredAt = counters.lastDeliveredAt
    counters.senders[from] = sender
  }

  function scheduleRetry() {
    if (rt.retryTimer !== null) return
    rt.retryTimer = setTimeout(() => {
      rt.retryTimer = null
      flush().catch((error) => {
        console.error('host-callback-bridge retry flush failed:', errorMessage(error))
      })
    }, retryDelayMs)
    rt.retryTimer.unref?.()
  }

  /** 轮转: 本游标到尾 + 超限 → rename;成功归零自有游标(legacy 游标文件一并清零)。 */
  async function rotateIfOversized(completeCount) {
    let size = 0
    try {
      const st = await fsp.stat(paths.inbox)
      size = st.size
    } catch {
      return false
    }
    if (size <= rotateMaxBytes && completeCount <= rotateMaxLines) return false
    if ((rt.cursor ?? 0) < completeCount) return false
    try {
      await fsp.rename(paths.inbox, paths.rotated) // POSIX: 覆盖旧一代
    } catch (error) {
      console.error('host-callback-bridge rotate rename failed:', errorMessage(error))
      return false
    }
    rt.cursor = 0
    await writeCursorFile(0)
    try {
      for (const name of await fsp.readdir(paths.dir)) {
        if (!name.startsWith('.cursor.') || name === paths.cursorFor(HOST_CONSUMER_ID).split('/').pop()) continue
        await fsp.writeFile(`${paths.dir}/${name}`, '0').catch(() => {})
      }
    } catch {
      // 目录列举失败: 自有游标已归零,不阻塞。
    }
    await saveState()
    return true
  }

  /** 对 pending 剩余目标逐一投递;全部终态(送达/死信)返回 true。 */
  async function deliverPending() {
    const { line, parsed, keys, broadcast } = rt.pending
    const attempts = rt.pending.attempts
    let deadLettered = 0
    for (const sid of [...attempts.keys()]) {
      try {
        await sink.deliver(sid, line, { parsed, at: now(), broadcast, consumer: sid })
        attempts.delete(sid)
      } catch (error) {
        const count = (attempts.get(sid) ?? 0) + 1
        attempts.set(sid, count)
        if (count >= maxWakeFailures) {
          await appendDead(line, `wake failed ${count} consecutive attempts: ${errorMessage(error)} (target ${sid})`)
          attempts.delete(sid)
          deadLettered += 1
        }
      }
    }
    if (attempts.size === 0) {
      // 双记(P3b.2): msgid 键 + body 键;meta = msgid(208 回放 id/msgid 数据源)
      dedup.mark(keys.primary, parsed.msgid ?? null)
      if (keys.secondary !== null) dedup.mark(keys.secondary, parsed.msgid ?? null)
      noteDelivery(parsed, rt.pending.targets - deadLettered)
      if (broadcast) counters.broadcastLines += 1
      rt.pending = null
      return true
    }
    scheduleRetry()
    return false
  }

  async function flush() {
    if (rt.flushing) return
    rt.flushing = true
    try {
      if (rt.cursor === null) rt.cursor = await initialCursor()
      for (;;) {
        // 上一轮未终态的行(退避重试)优先推进。
        if (rt.pending !== null) {
          const done = await deliverPending()
          if (!done) return
          rt.cursor += 1
          await writeCursorFile(rt.cursor)
          await saveState()
        }
        const registry = await readRegistry(paths.registry)
        const txt = await fsp.readFile(paths.inbox, 'utf8').catch(() => '')
        const lines = splitCompleteLines(txt)
        if (rt.cursor > lines.length) {
          rt.cursor = lines.length
          await writeCursorFile(rt.cursor)
        }
        while (rt.cursor < lines.length) {
          const line = lines[rt.cursor]

          if (line.startsWith(echoPrefix)) {
            await appendEcho(line)
            rt.cursor += 1
            await writeCursorFile(rt.cursor)
            continue
          }

          if (line.trim().length === 0) {
            counters.blankCount += 1
            rt.cursor += 1
            await writeCursorFile(rt.cursor)
            continue
          }

          const parsed = tryParseJson(line)
          if (!parsed.ok) {
            await appendDead(line, 'malformed: line is not valid JSON')
            rt.cursor += 1
            await writeCursorFile(rt.cursor)
            await saveState()
            continue
          }

          const value = parsed.value
          const toValue = value !== null && typeof value === 'object' && !Array.isArray(value)
            ? value.to
            : undefined
          const routing = resolveHostRouting(parseAddress(toValue), registry)

          if (routing.action === 'dead') {
            if (routing.classification === 'stale address') counters.staleHits += 1
            await appendDead(line, routing.reason, routing.classification ?? null)
            rt.cursor += 1
            await writeCursorFile(rt.cursor)
            await saveState()
            continue
          }

          if (routing.action === 'skip') {
            counters.skippedCount += 1
            rt.cursor += 1
            await writeCursorFile(rt.cursor)
            continue
          }

          const keys = digestKeys(line, value)
          if (dedup.seen(keys.primary) !== undefined
            || (keys.secondary !== null && dedup.seen(keys.secondary) !== undefined)) {
            counters.dedupCount += 1
            rt.cursor += 1
            await writeCursorFile(rt.cursor)
            continue
          }

          rt.pending = {
            line,
            parsed: value,
            keys,
            broadcast: routing.broadcast ?? false,
            to: toValue,
            targets: routing.sids.length,
            attempts: new Map(routing.sids.map((sid) => [sid, 0])),
          }
          const done = await deliverPending()
          if (!done) return
          rt.pending = null
          rt.cursor += 1
          await writeCursorFile(rt.cursor)
          await saveState()
        }
        const rotated = await rotateIfOversized(lines.length)
        if (!rotated) break
      }
      // undertaker(spec §2.5): 既有巡检拍子尾加 prune pass——超期 stale 槽清出
      // consumers(aliases 账本永不清); 同别名更旧代已在换代时剪除。
      try {
        const pruned = await pruneStaleSlots(paths.registry, { retentionMs: staleRetentionMs, now })
        if (pruned.length > 0) counters.prunedStaleSlots += pruned.length
      } catch (error) {
        console.error('host-callback-bridge prune pass failed:', errorMessage(error))
      }
    } finally {
      rt.flushing = false
    }
  }

  let watcher = null
  function start() {
    if (watcher !== null) return
    rt.startedAt = rt.startedAt ?? isoOf(now)
    watcher = watch(paths.dir, (_event, filename) => {
      if (filename === 'inbox.log') {
        flush().catch((error) => {
          console.error('host-callback-bridge flush failed:', errorMessage(error))
        })
      }
    })
  }

  function stop() {
    if (watcher !== null) {
      watcher.close()
      watcher = null
    }
    if (rt.retryTimer !== null) {
      clearTimeout(rt.retryTimer)
      rt.retryTimer = null
    }
  }

  function snapshot() {
    return {
      cursor: rt.cursor,
      flushing: rt.flushing,
      pending: rt.pending === null ? null : { to: rt.pending.to, remaining: [...rt.pending.attempts.keys()] },
      counters: JSON.parse(JSON.stringify(counters)),
    }
  }

  function status() {
    return { kind: 'file-router', watching: watcher !== null, retryScheduled: rt.retryTimer !== null, ...snapshot() }
  }

  return { id: 'file-router', start, stop, status, flush, snapshot }
}
