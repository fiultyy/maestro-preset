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
 *   - IDX-5 死信二分类(deadClass 键,仅 noise 行追加,真幽灵行四键形状不变):
 *     目标会话的宿主原生 watcher 游标(.cursor.<sid>)已越过本行 = 并行道已投
 *     (noise-parallel-delivered);无原生游标/未越过 = true-ghost(无槽真失联);
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
    tailCheckMs = 750,
    adaptiveDeferMs = 2_500,
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
    missedWake: false, // flush 进行中被吞的 watch/受理事件 → 本轮结束后补读(IDX-4-reopen: 防末行孤儿化)
    retryTimer: null,
    tailTimer: null, // 有界尾查: 有产出 pass 后挂一次性校验, 静稳态零存活定时器(非轮询)
    didWork: false,
    startedAt: null,
    pending: null, // { line, parsed, digest, broadcast, to, attempts: Map<sid, n> }
  }

  /**
   * 有界尾查(IDX-4-reopen): fs.watch 事件可被内核静默丢(inotify 队列溢出)且
   * 读/写交错可截出残行——每次**有产出**的 flush 后挂一次性 tailCheckMs 校验,
   * 再读一轮;仍有新行则续链,无产出即停(静稳态零存活定时器,T02 禁轮询不破)。
   * 这让"末行孤儿化"从概率性停顿变为 ≤tailCheckMs 的自愈。
   */
  function armTailCheck() {
    if (rt.tailTimer !== null) return
    rt.tailTimer = setTimeout(() => {
      rt.tailTimer = null
      flush().catch((error) => {
        console.error('host-callback-bridge tail-check flush failed:', errorMessage(error))
      })
    }, tailCheckMs)
    rt.tailTimer.unref?.()
  }

  const counters = {
    deliveredLines: 0,
    wakeTargets: 0,
    broadcastLines: 0,
    deadCount: 0,
    deadTrueGhost: 0, // IDX-5: 真幽灵死信(无槽且原生道未投)
    deadNoise: 0,     // IDX-5: 噪声死信(并行原生道已投,本面重复记账而已)
    adaptiveSkip: 0,  // A-fix: 原生道已投实证后本道跳过(消重复)
    adaptiveDefer: 0, // A-fix: 让道窗口触发次数
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
        deadTrueGhost: counters.deadTrueGhost,
        deadNoise: counters.deadNoise,
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

  /**
   * dead.log 追加(IDX-4: classification 键按需新增,既有键形状不动,spec §1.1)。
   * IDX-5: deadClass 仅在 noise-parallel-delivered 时追加——真幽灵行保持既有
   * 四键形状(at/reason/classification/line),既有门(G1f 逐键断言)零回归。
   */
  async function appendDead(line, reason, classification = null, deadClass = null) {
    const entry = classification === null
      ? { at: isoOf(now), reason, line }
      : { at: isoOf(now), reason, classification, line }
    if (deadClass !== null) entry.deadClass = deadClass
    try {
      await fsp.appendFile(paths.dead, `${JSON.stringify(entry)}\n`)
    } catch (error) {
      console.error('host-callback-bridge dead.log append failed:', errorMessage(error))
    }
    counters.deadCount += 1
    counters.lastDeadAt = isoOf(now)
  }

  /**
   * IDX-5 死信二分类探针: 目标会话的宿主原生 watcher 游标(.cursor.<sid>,行数
   * 语义与本题游标一致,轮转时一并归零)已越过本行下标 = 原生道已消费 = 本面
   * 若再死信记账纯属并行噪声;游标文件缺失(会话从未 arm)或未越过 = 真幽灵。
   */
  async function nativeCursorPassed(sessionId, lineIndex) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return false
    const n = await readCursorFile(`${paths.dir}/.cursor.${sessionId}`)
    return n > lineIndex
  }

  /** A-fix 探针: 目标会话曾 arm 过 v4 原生道(游标文件存在)。存在≠活着——
   * 活性由 defer 窗口终检兜底(窗口尽游标仍未过=原生道死/僵,本道直投)。 */
  async function nativeLaneExists(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return false
    try {
      await fsp.access(`${paths.dir}/.cursor.${sessionId}`)
      return true
    } catch {
      return false
    }
  }

  /**
   * A-fix(自适应让道, 用户裁决 2026-09-01): sole 下目标有 v4 原生道时先让原生道投,
   * 消双道重复唤醒;至少一次不变——跳过仅发生在原生道"已投"实证之后
   * (v4 契约: deliver 成功后才推进游标, sources/file-inbox.js 在案)。
   * 三段: ① 原生游标已过→跳过; ② 有原生道但未过→短窗让道(defer);
   * ③ 窗口尽仍未过(死/僵/慢)→本道兜底直投。窗口内原生道后到=有界竞态重复
   * (与旧常态相比重复只减不增, L4)。
   */
  async function adaptiveYield(attempts) {
    let armed = false
    for (const sid of [...attempts.keys()]) {
      if (await nativeCursorPassed(sid, rt.cursor)) {
        attempts.delete(sid)
        counters.adaptiveSkip += 1
        continue
      }
      if (await nativeLaneExists(sid)) armed = true
    }
    return armed
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

  /** 对 pending 剩余目标逐一投递;全部终态(送达/死信/原生道已投)返回 true。 */
  async function deliverPending() {
    const { line, parsed, keys, broadcast } = rt.pending
    const attempts = rt.pending.attempts
    let deadLettered = 0
    // A-fix 自适应让道(详见 adaptiveYield 注释): 原生道已投→跳过;有原生道未投→
    // 短窗让道;窗口尽→终检后兜底直投。deferUntil 三态: undefined=未评估,
    // 未来时刻=让道中, 过去时刻=窗口尽(终检一次)。
    if (rt.pending.deferUntil === undefined) {
      const armed = await adaptiveYield(attempts)
      if (attempts.size > 0 && armed) {
        rt.pending.deferUntil = now() + adaptiveDeferMs
        counters.adaptiveDefer += 1
        scheduleRetry()
        return false
      }
    } else if (now() < rt.pending.deferUntil) {
      scheduleRetry()
      return false
    } else if (await adaptiveYield(attempts) || attempts.size > 0) {
      // 窗口尽:终检(可能全跳过);仍有目标则落回兜底直投。
    }
    for (const sid of [...attempts.keys()]) {
      try {
        await sink.deliver(sid, line, { parsed, at: now(), broadcast, consumer: sid })
        attempts.delete(sid)
      } catch (error) {
        const count = (attempts.get(sid) ?? 0) + 1
        attempts.set(sid, count)
        if (count >= maxWakeFailures) {
          // IDX-5: 唤醒失败终态同样二分类——原生道已投 = 噪声死信。
          const noise = await nativeCursorPassed(sid, rt.cursor)
          if (noise) counters.deadNoise += 1
          else counters.deadTrueGhost += 1
          await appendDead(
            line,
            `wake failed ${count} consecutive attempts: ${errorMessage(error)} (target ${sid})`,
            null,
            noise ? 'noise-parallel-delivered' : null,
          )
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
    if (rt.flushing) {
      // 冲撞中的事件不再丢弃: 记一笔, 本轮 outer loop 末尾补一轮重读(否则末行
      // 孤儿化到下一个外部事件——静默系统里可能永不投递)。
      rt.missedWake = true
      return
    }
    rt.flushing = true
    const entryCursor = rt.cursor
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
            // IDX-5 二分类: 幽灵/换代死信先探原生道——已投 = 噪声(记 deadClass),
            // 未投 = 真幽灵(四键形状不变)。寻址解析不出 sessionId(裸名/坏形)按真幽灵。
            let deadClass = null
            if (routing.classification === 'ghost address' || routing.classification === 'stale address') {
              const addr = parseAddress(toValue)
              const noise = await nativeCursorPassed(addr.kind === 'qualified' ? addr.sessionId : null, rt.cursor)
              deadClass = noise ? 'noise-parallel-delivered' : null
              if (noise) counters.deadNoise += 1
              else counters.deadTrueGhost += 1
            }
            await appendDead(line, routing.reason, routing.classification ?? null, deadClass)
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
        if (rotated) continue
        if (rt.missedWake) {
          rt.missedWake = false
          continue // 被吞的事件: 补一轮重读新行
        }
        break
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
      // 有界尾查(IDX-4-reopen): 本 pass 游标有推进(=消费过行) → 挂一次性校验,
      // 兜内核丢事件/残行交错;无产出不挂——静稳态零存活定时器(T02 禁轮询不破)。
      if (rt.cursor !== null && (entryCursor === null || rt.cursor > entryCursor)) {
        rt.didWork = true
      }
      if (rt.didWork) {
        rt.didWork = false
        armTailCheck()
      }
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
    if (rt.tailTimer !== null) {
      clearTimeout(rt.tailTimer)
      rt.tailTimer = null
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
