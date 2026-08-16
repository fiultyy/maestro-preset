/**
 * @maestro/orca-callback — 原生 Orca→DSH 回调泵插件 (v3.6)
 *
 * v3.6 相对 v3.5 的变更（incident 0003：多编排会话单例互杀）：
 *   apply() 的 state 按 sessionId 分槽——pump/watcher/agent 绑定每会话独立,
 *   绝不跨会话复用（v3.5 单例下,首 arm 会话创建 pump,后续会话 arm 只是其
 *   幻注册+身份劫持）。bridge_arm 回执对账盘上 registry:条目不在即 INCONSISTENT。
 *
 * 机制（v3.5，v3.4 之上的多消费者路由迭代）：
 *   Orca 侧任意 agent:
 *     orca terminal send --terminal <bridge_handle> --text "…" --enter
 *       └─► 桥 pane (cat >> inbox.log)
 *             └─► 本插件 fs.watch inbox（每个消费者独立游标 .cursor.<sessionId>，
 *                 扫描越过所有行，仅对 to 匹配自身的行 wake；DSH-RE] 回声跳过并归档）
 *                   └─► Agent.followup()/inject()  ← harness 原生回合驱动原语
 *
 * v3.5 相对 v3.4 的变更（对应 obs-collection/bridge-governance-v35.md 规格）：
 *   0. 事故背景：v3.4 的单消费者假设在"多 DSH host 实例 + 多 armed main 并存"下
 *      破裂——同名"编排1"的第二个实例抢先消费共享 inbox 并冒名 ack（2026-08-15）。
 *   1. 寻址：消息 to 必须为 <alias>@<sessionId> 或裸 sessionId；to:"*" 为广播
 *      （每个在册消费者各自 wake 一次）。alias@sessionId 形式以 sessionId 为
 *      路由键，alias 仅为可读修饰、不参与匹配（收件人身份由注册表裁定）。
 *   2. per-consumer 游标：.cursor.<sessionId> 各自独立；每个消费者扫描越过所有
 *      行，仅对 to 匹配自身的行 wake；不匹配行照常推进自身游标、不影响自身投递。
 *   3. 消费者注册：首次 flush 即 arm——写 bridge/registry.json（sid/pid/armedAt
 *      [/alias]，临时文件+rename 原子写；此后每轮 flush 幂等续期）；dispose()
 *      （teardown）注销自身条目。回执签名一律 <alias>@<sessionId>：规范签名在
 *      arm 回执与 wake source 摘要中给出；echo.log 生产端的署名改动属 skills
 *      侧，不在本插件写范围内（遗留项，同 v3.4 reply.sh）。
 *   4. 无法寻址的消息 → dead.log（原因 unknown-addressee*），不投递不丢失：
 *      - to 缺失/非字符串/空；
 *      - to 为合格式 <x>@<sid> 但 sid 无在册消费者；
 *      - 旧式裸别名查 registry 解析失败；
 *      - 裸别名命中多个在册消费者（同名歧义，即本次事故形态）——一律死信，
 *        绝不挑一个"看起来像"的投下去。
 *      行内在终态（malformed / unknown-addressee）由 undertaker（registry 中
 *      armedAt 最早的在册消费者，平键按 sessionId 字典序）唯一落一笔 dead.log，
 *      避免 N 个消费者重复死信；其余消费者静默越过。wake 失败型死信是消费者
 *      自身的终态，不作 undertaker 门控（谁失败谁落笔）。
 *   5. registry.json 与 state.json 同为原子写（tmp+rename）；state.json 改为
 *      per-consumer 分节（consumers.<sessionId>.*，含各自游标/计数），轮转计数
 *      保持全局。写入前重读合并，只覆写自身分节/条目（跨进程读改写存在微小
 *      last-writer-wins 竞窗，原子 rename 保证文件不损坏——已知限制）。
 *   6. 轮转（1MB/1000 行）保留，但多消费者下仅当"所有在册消费者的游标都已
 *      消费到文件尾"才轮转——防止快消费者抢跑轮转吃掉慢消费者的行；轮转后
 *      同步归零全部在册游标文件，避免陈旧偏移在下一轮闸门检查中误放行。
 *
 * v3.4 投递语义全部保留：at-least-once（游标仅在 wake 成功或行进入终态后推进）、
 * wake 失败 2s 退避重试、连续 3 次失败→dead.log、60s (from,body) 去重窗口、
 * DSH-RE] 回声跳过并归档 echo.log（复制式，不重写 inbox）、malformed→dead.log、
 * 尾部残行不消费、createPump 纯函数结构（桥目录/wake/时钟/阈值全部可注入）。
 *
 * 工具:
 *   bridge_arm  — 绑定调用方 agent 到 inbox watcher 并登记 registry
 *                （可选参数 alias：登记用的消费别名，缺省取 MAESTRO_BRIDGE_ALIAS）
 *
 * 约定: 单行消息（PTY ~4KB 上限）；JSON {"type","from","to","body"}。
 * 已知限制（记录于实施报告）：
 *   - 崩溃未 teardown 的注册条目会阻塞轮转与行内在终态死信，直至条目被清除；
 *   - v3.4 旧共享 .cursor 不迁移（各消费者从 0 起扫，at-least-once + 轮转吸收重叠）；
 *   - 桥 pane 建立/重建见 skills/orca-bridge/SKILL.md（本插件只依赖 inbox 文件）。
 */

import { watch } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import * as fsp from 'node:fs/promises'

/** 版本指纹：会话 arm 回执与磁盘插件对账用。 */
export const version = '3.6.0'

export const inject = ['agents', 'tools']

// ---- 可调参数（导出供测试引用） ----

/** 同一 (from, body) 的去重窗口（毫秒），per-consumer 生效。 */
export const DEDUP_WINDOW_MS = 60_000
/** wake 连续失败多少次后死信并推进游标。 */
export const MAX_WAKE_FAILURES = 3
/** wake 失败后的重试 backoff（毫秒）；定时器 unref，不阻止进程退出。 */
export const RETRY_DELAY_MS = 2_000
/** rotation 阈值：字节数。 */
export const ROTATE_MAX_BYTES = 1024 * 1024
/** rotation 阈值：完整行数。 */
export const ROTATE_MAX_LINES = 1000
/** 回声行前缀（与 v3.3/v3.4 / orca-bridge skill 旧约定保持兼容）。 */
export const ECHO_PREFIX = 'DSH-RE]'

/** 把文件文本切成"已写完的完整行"数组：末尾无换行的残行不算（尚未写完）。 */
function splitCompleteLines(txt) {
  if (txt.length === 0) return []
  const cut = txt.endsWith('\n') ? txt.length : txt.lastIndexOf('\n') + 1
  if (cut === 0) return []
  const body = txt.slice(0, cut - 1)
  return body.length === 0 ? [] : body.split('\n')
}

/** 行是否为可解析 JSON（字段校验由寻址/兜底逻辑负责）。 */
function tryParseJson(line) {
  try {
    return { ok: true, value: JSON.parse(line) }
  } catch {
    return { ok: false }
  }
}

function digestOf(line, parsed) {
  const from = parsed !== null && typeof parsed === 'object' && typeof parsed.from === 'string'
    ? parsed.from
    : null
  const body = parsed !== null && typeof parsed === 'object' && parsed.body !== undefined
    ? String(parsed.body)
    : ''
  const material = from === null ? line : `${from}\u0000${body}`
  return createHash('sha256').update(material).digest('hex')
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function isoOf(now) {
  return new Date(now()).toISOString()
}

/** sessionId → 游标文件名安全形式（session id 形如 session-<uuid>，通常原样通过）。 */
function fileSafeSid(sessionId) {
  if (/^[A-Za-z0-9._-]+$/.test(sessionId)) return sessionId
  const hash = createHash('sha256').update(sessionId).digest('hex').slice(0, 8)
  return `${sessionId.replace(/[^A-Za-z0-9._-]+/g, '_')}-${hash}`
}

// ---- v3.5 寻址 ----

/**
 * 解析消息 to 字段为寻址形式：
 *   '*'                    → { kind: 'broadcast' }
 *   '<alias>@<sessionId>'  → { kind: 'qualified', alias, sessionId }（sessionId 为路由键）
 *   '<sessionId>|<alias>'  → { kind: 'bare', name }（裸 token，靠注册表消歧）
 *   缺失/非字符串/空       → { kind: 'invalid' }
 * 含多个 '@' 时按最后一个切分（sessionId 不含 '@'，alias 理论上可含）。
 */
export function parseAddress(to) {
  if (typeof to !== 'string' || to.length === 0) return { kind: 'invalid' }
  if (to === '*') return { kind: 'broadcast' }
  const at = to.lastIndexOf('@')
  if (at === -1) return { kind: 'bare', name: to }
  return { kind: 'qualified', alias: to.slice(0, at), sessionId: to.slice(at + 1) }
}

/** alias → 持有该别名的在册 sessionId 列表（用于旧式裸别名解析与同名歧义检测）。 */
function aliasIndex(registry) {
  const map = new Map()
  for (const [sid, entry] of Object.entries(registry.consumers)) {
    if (typeof entry?.alias !== 'string' || entry.alias.length === 0) continue
    if (!map.has(entry.alias)) map.set(entry.alias, [])
    map.get(entry.alias).push(sid)
  }
  return map
}

/**
 * 路由裁定（纯函数，导出供单测）：
 *   { action: 'wake', broadcast }  — 该行投递给本消费者（broadcast 标记 to:"*"）
 *   { action: 'skip' }             — 该行属于其他在册消费者，静默越过
 *   { action: 'dead', reason }     — 无法寻址：不投递不丢失，reason 以 unknown-addressee 开头
 * 规则要点：
 *   - qualified 以 sessionId 为路由键（alias 不参与匹配，防同名歧义）；
 *   - 裸 token 先比对 sessionId，再当旧式别名查注册表；
 *   - 旧式别名解析失败或命中多个持有者 → dead（歧义绝不静默挑边，即 2026-08-15 事故防线）。
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
  // bare：裸 sessionId 或旧式裸别名。
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

// ---- 注册表（bridge/registry.json，原子写） ----

// v3.6: 同进程多 pump 并发读改写会撞同一 tmp 路径(ENOENT/丢更新)——
// 模块级链串行化全部 registry 写操作(registerSelf/unregisterSelf)。
let registryOpChain = Promise.resolve()
function serializeRegistryOp(operation) {
  const next = registryOpChain.then(operation, operation)
  registryOpChain = next.catch(() => {})
  return next
}

function sanitizeConsumers(raw) {
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
    // 缺失或损坏：视为空表；本轮 registerSelf 的读改写会自愈自身条目。
  }  return { version: null, consumers: {} }
}

async function writeRegistryAtomic(registryPath, registry) {
  const tmp = `${registryPath}.tmp`
  await fsp.writeFile(tmp, `${JSON.stringify(registry, null, 2)}\n`)
  await fsp.rename(tmp, registryPath)
}

/**
 * 与宿主解耦的泵核心（导出供单测注入临时目录与假 wake）。
 *
 * config:
 *   bridgeDir      — 桥目录（inbox/游标/dead.log/echo.log/state.json/registry.json 所在地）
 *   consumer       — 本消费者身份 { sessionId, alias? }（v3.5 必填；alias 用于注册表
 *                    与规范签名 <alias>@<sessionId>，可缺省）
 *   wake(line, info) — 投递函数：成功入队正常返回；失败必须抛错（触发重试/死信）。
 *                    info = { parsed, at, to, broadcast, consumer }
 *   now()          — 时钟注入（测试用），默认 Date.now
 *   dedupWindowMs / maxWakeFailures / retryDelayMs / rotateMaxBytes / rotateMaxLines — 阈值覆盖
 *
 * 返回 { paths, flush, dispose, snapshot }：
 *   flush()   — 消费一轮（幂等，并发调用合并为一次）；首轮完成 state 载入 + registry 注册
 *   dispose() — 清理重试定时器并从 registry 注销（teardown；异步，可 await）
 *   snapshot()— 当前内存态视图（含 state.json 将持久化的 per-consumer 计数）
 */
export function createPump(config) {
  const {
    bridgeDir,
    wake,
    consumer,
    now = () => Date.now(),
    dedupWindowMs = DEDUP_WINDOW_MS,
    maxWakeFailures = MAX_WAKE_FAILURES,
    retryDelayMs = RETRY_DELAY_MS,
    rotateMaxBytes = ROTATE_MAX_BYTES,
    rotateMaxLines = ROTATE_MAX_LINES,
  } = config

  if (typeof bridgeDir !== 'string' || bridgeDir.length === 0) throw new TypeError('createPump: bridgeDir is required')
  if (typeof wake !== 'function') throw new TypeError('createPump: wake function is required')
  if (consumer === null || typeof consumer !== 'object' || Array.isArray(consumer)) {
    throw new TypeError('createPump: consumer { sessionId, alias? } is required (v3.5)')
  }
  if (typeof consumer.sessionId !== 'string' || consumer.sessionId.length === 0) {
    throw new TypeError('createPump: consumer.sessionId must be a non-empty string')
  }
  if (consumer.alias !== undefined && consumer.alias !== null
    && (typeof consumer.alias !== 'string' || consumer.alias.length === 0)) {
    throw new TypeError('createPump: consumer.alias must be a non-empty string when provided')
  }

  const sidSafe = fileSafeSid(consumer.sessionId)
  const canonical = consumer.alias ? `${consumer.alias}@${consumer.sessionId}` : consumer.sessionId

  const paths = {
    dir: bridgeDir,
    inbox: `${bridgeDir}/inbox.log`,
    rotated: `${bridgeDir}/inbox.log.1`,
    cursor: `${bridgeDir}/.cursor.${sidSafe}`,
    dead: `${bridgeDir}/dead.log`,
    echo: `${bridgeDir}/echo.log`,
    state: `${bridgeDir}/state.json`,
    registry: `${bridgeDir}/registry.json`,
    cursorFor: (sessionId) => `${bridgeDir}/.cursor.${fileSafeSid(sessionId)}`,
  }

  const rt = {
    cursor: null,
    flushing: false,
    retryTimer: null,
    loaded: false,
    registered: false,
    armedAt: null,
    registry: { version: null, consumers: {} },
    failures: { digest: null, count: 0 },
    dedup: new Map(),
  }

  // 本消费者在 state.json 的持久化分节（consumers.<sessionId>）。
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
  // 桥级全局（轮转）计数。
  const globals = { rotatedCount: 0, lastRotatedAt: null }

  async function loadState() {
    try {
      const txt = await fsp.readFile(paths.state, 'utf8')
      const saved = JSON.parse(txt)
      if (saved !== null && typeof saved === 'object' && !Array.isArray(saved)) {
        if (Number.isFinite(saved.rotatedCount)) globals.rotatedCount = saved.rotatedCount
        if (typeof saved.lastRotatedAt === 'string') globals.lastRotatedAt = saved.lastRotatedAt
        const mine = saved.consumers?.[consumer.sessionId]
        if (mine !== null && typeof mine === 'object' && !Array.isArray(mine)) {
          for (const key of Object.keys(own)) {
            if (mine[key] !== undefined) own[key] = mine[key]
          }
        }
      }
    } catch {
      // 首次运行或文件损坏：从零计起，不阻塞消费（v3.4 顶层形状不迁移）。
    }
    rt.loaded = true
  }

  async function saveState() {
    try {
      let root = null
      try {
        root = JSON.parse(await fsp.readFile(paths.state, 'utf8'))
      } catch {
        // 尚不存在。
      }
      if (root === null || typeof root !== 'object' || Array.isArray(root)) root = {}
      if (root.consumers === null || typeof root.consumers !== 'object' || Array.isArray(root.consumers)) {
        root.consumers = {}
      }
      root.version = version
      root.rotatedCount = globals.rotatedCount
      root.lastRotatedAt = globals.lastRotatedAt
      root.consumers[consumer.sessionId] = { ...JSON.parse(JSON.stringify(own)), cursor: rt.cursor ?? 0 }
      const tmp = `${paths.state}.tmp`
      await fsp.writeFile(tmp, `${JSON.stringify(root, null, 2)}\n`)
      await fsp.rename(tmp, paths.state)
    } catch (error) {
      // 可观测文件写失败不阻断投递主路径。
      console.error('orca-callback state.json write failed:', errorMessage(error))
    }
  }

  /** 注册自身（读改写保留他消费者条目，tmp+rename 原子落盘）；每轮 flush 幂等续期。 */
  async function registerSelf() {
    if (rt.armedAt === null) rt.armedAt = isoOf(now)
    own.armedAt = rt.armedAt
    own.pid = process.pid
    const registry = await serializeRegistryOp(async () => {
      const current = await readRegistry(paths.registry)
      current.version = version
      current.consumers[consumer.sessionId] = { alias: own.alias, pid: own.pid, armedAt: rt.armedAt }
      try {
        await writeRegistryAtomic(paths.registry, current)
        rt.registered = true
      } catch (error) {
        console.error('orca-callback registry.json write failed:', errorMessage(error))
      }
      return current
    })
    // 即使落盘失败也把自身并入内存视图：路由/undertaker 判定不因 IO 抖动丢自己。
    return registry
  }

  async function unregisterSelf() {
    try {
      await serializeRegistryOp(async () => {
        const registry = await readRegistry(paths.registry)
        if (registry.consumers[consumer.sessionId] === undefined) return
        delete registry.consumers[consumer.sessionId]
        registry.version = version
        await writeRegistryAtomic(paths.registry, registry)
      })
    } catch (error) {
      console.error('orca-callback registry.json unregister failed:', errorMessage(error))
    } finally {
      rt.registered = false
    }
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
    // at-least-once 下游语义：写失败仅损失"跨重启去重"，重启后重投由 dedup 窗口吸收。
    return fsp.writeFile(path, String(n)).catch((error) => {
      console.error('orca-callback cursor write failed:', errorMessage(error))
    })
  }

  async function appendDead(line, reason) {
    const entry = `${JSON.stringify({ at: isoOf(now), reason, line })}\n`
    try {
      await fsp.appendFile(paths.dead, entry)
    } catch (error) {
      // 死信写失败不阻塞游标推进（否则坏行会永久卡住队列头部）。
      console.error('orca-callback dead.log append failed:', errorMessage(error))
    }
    own.deadCount += 1
    own.lastDeadAt = isoOf(now)
  }

  async function appendEcho(line) {
    try {
      await fsp.appendFile(paths.echo, `${line}\n`)
    } catch (error) {
      console.error('orca-callback echo.log append failed:', errorMessage(error))
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

  function pruneDedup() {
    const horizon = now() - dedupWindowMs
    for (const [key, deliveredAt] of rt.dedup) {
      if (deliveredAt < horizon) rt.dedup.delete(key)
    }
  }

  function scheduleRetry() {
    if (rt.retryTimer !== null) return
    rt.retryTimer = setTimeout(() => {
      rt.retryTimer = null
      flush().catch((error) => {
        console.error('orca-callback retry flush failed:', errorMessage(error))
      })
    }, retryDelayMs)
    rt.retryTimer.unref?.()
  }

  /** undertaker：行内在终态（malformed/unknown-addressee）的唯一死信责任人。 */
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

  /**
   * 轮转：仅在自身消费到文件尾时评估；多消费者闸门——所有在册消费者的游标都
   * 到尾才允许 rename（慢消费者的行不能被吃掉）。成功则归零全部在册游标文件
   * 并返回 true（调用方再消费一轮，吸收 rename 竞争窗口内新落的行）。
   */
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
      console.error('orca-callback rotate rename failed:', errorMessage(error))
      return false
    }
    rt.cursor = 0
    await writeCursorFile(paths.cursor, 0)
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
      if (rt.cursor === null) rt.cursor = await readCursorFile(paths.cursor)
      for (;;) {
        // 每轮先续期注册（幂等，armedAt 取首次值保 undertaker 稳定）再取注册表快照。
        const registry = await registerSelf()
        rt.registry = registry
        const txt = await fsp.readFile(paths.inbox, 'utf8').catch(() => '')
        const lines = splitCompleteLines(txt)
        // 外部轮转/手工截断使文件变短时，游标钳到行尾（视为已消费），避免永久卡死。
        if (rt.cursor > lines.length) {
          rt.cursor = lines.length
          await writeCursorFile(paths.cursor, rt.cursor)
        }
        while (rt.cursor < lines.length) {
          const line = lines[rt.cursor]

          if (line.startsWith(ECHO_PREFIX)) {
            await appendEcho(line)
            rt.cursor += 1
            await writeCursorFile(paths.cursor, rt.cursor)
            await saveState()
            continue
          }

          if (line.trim().length === 0) {
            own.blankCount += 1
            rt.cursor += 1
            await writeCursorFile(paths.cursor, rt.cursor)
            continue
          }

          const parsed = tryParseJson(line)
          if (!parsed.ok) {
            if (undertakerSessionId(registry) === consumer.sessionId) {
              await appendDead(line, 'malformed: line is not valid JSON')
            }
            rt.cursor += 1
            await writeCursorFile(paths.cursor, rt.cursor)
            await saveState()
            continue
          }

          const value = parsed.value
          const toValue = value !== null && typeof value === 'object' && !Array.isArray(value)
            ? value.to
            : undefined
          const routing = resolveRouting(
            parseAddress(toValue),
            { sessionId: consumer.sessionId, alias: own.alias },
            registry,
          )

          if (routing.action === 'dead') {
            if (undertakerSessionId(registry) === consumer.sessionId) {
              await appendDead(line, routing.reason)
            }
            rt.cursor += 1
            await writeCursorFile(paths.cursor, rt.cursor)
            await saveState()
            continue
          }

          if (routing.action === 'skip') {
            // 别的消费者的行：静默越过，游标照常推进（不阻塞自身投递）。
            own.skippedCount += 1
            rt.cursor += 1
            await writeCursorFile(paths.cursor, rt.cursor)
            await saveState()
            continue
          }

          const digest = digestOf(line, value)
          const deliveredAt = rt.dedup.get(digest)
          if (deliveredAt !== undefined && now() - deliveredAt < dedupWindowMs) {
            own.dedupCount += 1
            rt.cursor += 1
            await writeCursorFile(paths.cursor, rt.cursor)
            await saveState()
            continue
          }

          try {
            await wake(line, { parsed: value, at: now(), to: toValue, broadcast: routing.broadcast, consumer: canonical })
          } catch (error) {
            const count = rt.failures.digest === digest ? rt.failures.count + 1 : 1
            rt.failures = { digest, count }
            if (count >= maxWakeFailures) {
              await appendDead(line, `wake failed ${count} consecutive attempts: ${errorMessage(error)}`)
              rt.failures = { digest: null, count: 0 }
              rt.cursor += 1
              await writeCursorFile(paths.cursor, rt.cursor)
              await saveState()
              continue
            }
            // at-least-once：游标不动，留待下轮（backoff 定时器 + 下一次 watch 事件）。
            scheduleRetry()
            return
          }

          rt.failures = { digest: null, count: 0 }
          rt.dedup.set(digest, now())
          pruneDedup()
          noteDelivery(value, routing.broadcast)
          rt.cursor += 1
          await writeCursorFile(paths.cursor, rt.cursor)
          await saveState()
        }
        // flush 空闲（消费到尾）→ 检查轮转（多消费者闸门）；轮转后若 inbox 立即再现则再消费一轮。
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
      dedupSize: rt.dedup.size,
      registered: rt.registered,
      registeredConsumers: Object.keys(rt.registry.consumers),
      ...JSON.parse(JSON.stringify(own)),
      ...JSON.parse(JSON.stringify(globals)),
    }
  }

  return { paths, flush, dispose, snapshot }
}

export function apply(ctx) {
  const agents = ctx.agents
  const bridgeDir = process.env.MAESTRO_BRIDGE ?? `${process.env.HOME}/.dsh/maestro/bridge`

  // v3.6（incident 0003）：preset 按 standing scope 只挂载一次，apply() 全程仅跑
  // 一遍——state 绝不能是闭包单例，否则首个 arm 的会话创建 pump 后，后续会话的
  // arm 只是"替别人的 pump 干活 + 回执按自己现算的签名撒谎"（幻注册 + 身份劫持）。
  // 故 state 按 sessionId 分槽：每会话独立的 pump/watcher/agent 绑定，互不复用。
  const slots = new Map() // sessionId -> { agent, alias, canonical, pump, watcher }

  function makeWake(slot) {
    return (line, info) => {
      const message = Object.freeze({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: `ORCA-CB] ${line}` }],
        source: {
          kind: 'plugin',
          plugin: '@maestro/orca-callback',
          form: 'notice',
          summary: `Orca bridge callback routed to ${info?.consumer ?? slot.canonical}`,
        },
      })
      if (slot.agent.status === 'idle') slot.agent.followup(message)
      else slot.agent.inject(message)
    }
  }

  ctx.tools.register({
    name: 'bridge_arm',
    description:
      'Arm the Orca callback pump (v3.6, multi-consumer routing) for this session: bind the calling agent to the bridge inbox watcher and register it in bridge/registry.json (sid/pid/armedAt/alias). Each incoming Orca callback is routed by its "to" field: <alias>@<sessionId>, bare <sessionId>, or "*" (broadcast wakes every registered consumer once); legacy bare aliases resolve via the registry and ambiguous ones dead-letter. This consumer keeps its own cursor file .cursor.<sessionId>, scans past all rows, and wakes only on rows addressed to itself. Delivery is at-least-once with a 60s (from,body) dedup window and 2s-backoff retries (3 strikes -> dead.log); unaddressable and malformed rows go to bridge/dead.log; DSH-RE] echoes are skipped and archived to bridge/echo.log; inbox rotates to inbox.log.1 past 1MB/1000 lines only after every registered consumer reached the tail; counters live in bridge/state.json per consumer. Acks must be signed <alias>@<sessionId>. Call once at session start when Orca-driven callbacks are wanted. The receipt verifies the registry entry on disk (fail-loud on phantom registration).',
    parameters: {
      type: 'object',
      properties: {
        alias: {
          type: 'string',
          description:
            'Consumer alias to register in bridge/registry.json and to use in the canonical <alias>@<sessionId> signature. Defaults to MAESTRO_BRIDGE_ALIAS when set, else sessionId-only registration.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      const alias = typeof args?.alias === 'string' && args.alias.trim().length > 0
        ? args.alias.trim()
        : (typeof process.env.MAESTRO_BRIDGE_ALIAS === 'string' && process.env.MAESTRO_BRIDGE_ALIAS.length > 0
          ? process.env.MAESTRO_BRIDGE_ALIAS
          : null)
      let agent
      try {
        agent = agents.requireInitiator()
      } catch (error) {
        return `cannot resolve initiating agent: ${error?.message}`
      }
      const sessionId = String(agent.id)
      const canonical = alias === null ? sessionId : `${alias}@${sessionId}`
      let slot = slots.get(sessionId)
      if (slot === undefined) {
        slot = { agent, alias, canonical, pump: null, watcher: null }
        slots.set(sessionId, slot)
      } else {
        // 重复 arm：刷新绑定与签名（别名可变），但绝不复用他人的 pump。
        slot.agent = agent
        slot.alias = alias
        slot.canonical = canonical
      }
      if (slot.pump === null) {
        slot.pump = createPump({ bridgeDir, wake: makeWake(slot), consumer: { sessionId, alias } })
      }
      if (slot.watcher === null) {
        slot.watcher = watch(bridgeDir, (_event, filename) => {
          if (filename === 'inbox.log') {
            slot.pump.flush().catch((error) => {
              console.error('orca-callback flush failed:', error?.message)
            })
          }
        })
      }
      try {
        await slot.pump.flush()
      } catch (error) {
        return `bridge armed (pump v${version}) as ${canonical} but initial flush failed: ${error?.message}`
      }
      // 回执对账（0003 幻注册防线）：flush 声称注册完成，但必须盘上确有其事。
      let onDisk = false
      try {
        const registry = await readRegistry(`${bridgeDir}/registry.json`)
        onDisk = registry.consumers[sessionId] !== undefined
      } catch {
        onDisk = false
      }
      if (!onDisk) {
        return `bridge arm INCONSISTENT as ${canonical}: flush 完成但 registry.json 无本会话条目 — `
          + `检查桥目录(${bridgeDir})写权限;回调无法路由到本会话,本 arm 不可信`
      }
      return `bridge armed (orca-callback pump v${version}): consumer ${canonical} bound + registered in `
        + `bridge/registry.json (pid ${process.pid}, verified on disk); addressing: to=<alias>@<sessionId> | <sessionId> | "*" broadcast `
        + `(legacy bare aliases resolve via registry, ambiguous ones dead-letter); per-consumer cursor .cursor.${sessionId}; `
        + `at-least-once wake with ${Math.round(DEDUP_WINDOW_MS / 1000)}s dedup window; `
        + `unknown-addressee/malformed/retry-exhausted lines -> bridge/dead.log; `
        + `DSH-RE] echoes skipped+archived (replies belong in bridge/echo.log); `
        + `rotation @ ${ROTATE_MAX_LINES} lines / ${Math.round(ROTATE_MAX_BYTES / 1024 / 1024)}MB gated on all registered consumers; `
        + `counters in bridge/state.json (per consumer); sign acks as ${canonical}`
    },
  })

  ctx.effect(() => () => {
    // scope teardown（宿主停机）：逐槽关闭 watcher + 卸册,只动自己的条目。
    for (const slot of slots.values()) {
      if (slot.watcher !== null) {
        slot.watcher.close()
        slot.watcher = null
      }
      void slot.pump?.dispose()
    }
    slots.clear()
  })
}

export default { version, inject, apply }
