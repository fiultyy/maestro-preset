/**
 * http-intake.js — HTTP 受理面(宿主 boot 即绑定,SI-003 ①)。
 *
 * 端点(全部仅限回环来源):
 *   POST /callback   — cb-send 契约零变更(v1.2 状态码语义保留: 200/208/400/403/
 *                      404/405/413/500/503)。受理 = **同步追加写 inbox.log**(HTTP-R2
 *                      选项(i): 受理即持久证据),投递由文件消费面(fs 事件)统一完成,
 *                      游标/死信/轮转/去重单窗口。200 语义 = accepted(durable),非
 *                      "已驱动目标会话"。
 *   POST /register   — 新代际消费者自注册(替代会话内 bridge_arm 的登账职责,SI-003 ④:
 *                      编排会话不再拥有链路,只保留消费回合)。
 *   POST /unregister — 消费者注销(换代退役)。
 *   GET  /status     — 观测面(端口/游标/计数/在册消费者)。
 *
 * 缺省 to 的路由规则(HTTP-R1 宿主化): 唯一在册消费者 → 补全其规范签名投递;
 * ≥2 在册 → 400 附 details(要求显式寻址);0 在册 → 503(先 POST /register)。
 * 显式 to → resolveHostRouting: wake/broadcast → 受理;dead → 400 附 reason
 * (请求级同步契约,不写 dead.log;cb-send 收 400 后自行降级文件桥,由文件面
 * 死信留痕——与 v1.2/http.js 行为同构)。
 */
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import * as fsp from 'node:fs/promises'
import { parseAddress, resolveHostRouting } from './core/addressing.js'
import { digestKeys, digestOf } from './core/dedup.js'
import { readRegistry, registerConsumer, unregisterConsumer } from './core/registry.js'

/** 请求体上限(v1.2 同值)。 */
export const MAX_BODY_BYTES = 256 * 1024
/** 允许的消息 type 枚举: v1.2 的 ack|done|ping|status + maestro 技能面在用的 ask|report。 */
export const TYPES = ['ack', 'done', 'ask', 'report', 'ping', 'status']

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false
  if (address.includes(':')) {
    const normalized = address.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, '$1')
    if (normalized.includes('.')) return isLoopbackAddress(normalized)
    return normalized === '::1'
  }
  return address === '127.0.0.1' || address.startsWith('127.')
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = `${JSON.stringify(payload)}\n`
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...extraHeaders,
  })
  res.end(body)
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0
    let overflow = false
    const chunks = []
    req.on('data', (chunk) => {
      if (overflow) return
      size += chunk.length
      if (size > limit) {
        overflow = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (overflow) {
        reject(Object.assign(new Error(`request body exceeds ${limit} bytes`), { statusCode: 413 }))
        return
      }
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', reject)
  })
}

function validate(payload) {
  const errors = []
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return ['body must be a JSON object']
  }
  if (!TYPES.includes(payload.type)) {
    errors.push(`type must be one of ${TYPES.join('|')} (got ${JSON.stringify(payload.type)})`)
  }
  if (typeof payload.from !== 'string' || payload.from.trim().length === 0) {
    errors.push('from must be a non-empty string')
  }
  if (typeof payload.body !== 'string') {
    errors.push('body must be a string')
  }
  if (payload.to !== undefined && (typeof payload.to !== 'string' || payload.to.trim().length === 0)) {
    errors.push('to must be a non-empty string when present')
  }
  return errors
}

function canonicalOf(sessionId, alias) {
  return alias ? `${alias}@${sessionId}` : sessionId
}

/**
 * createHttpIntake(config):
 *   store / dedup / version   — 共享内核(store.paths 布局 + 跨通道去重窗口)
 *   intake                    — 受理落盘函数: async (line) => void(追加 inbox.log)
 *   onActivity                — 受理后回调(触发文件面立即 flush;可为 null)
 *   basePath / bind / maxBodyBytes / types / port / now / dedupWindowMs
 *   bindRetry                 — { attempts, delayMs }: 优先端口的 EADDRINUSE 有限重试
 * 返回 { start(preferredPort), stop, status, port }。
 */
export function createHttpIntake(config) {
  const {
    store,
    dedup,
    version,
    intake,
    onActivity = null,
    basePath = '/callback',
    bind = '127.0.0.1',
    maxBodyBytes = MAX_BODY_BYTES,
    types = TYPES,
    port = 0,
    now = () => Date.now(),
    dedupWindowMs = 60_000,
    bindRetry = { attempts: 5, delayMs: 300 },
  } = config

  if (store === null || typeof store !== 'object' || typeof store.paths !== 'object') {
    throw new TypeError('createHttpIntake: store { paths, saveState } is required')
  }
  if (dedup === null || typeof dedup !== 'object' || typeof dedup.seen !== 'function' || typeof dedup.mark !== 'function') {
    throw new TypeError('createHttpIntake: dedup { seen, mark } is required')
  }
  if (typeof intake !== 'function') {
    throw new TypeError('createHttpIntake: intake(line) function is required')
  }

  const paths = store.paths
  const counters = {
    received: 0,
    accepted: 0,
    duplicates: 0,
    rejected: 0,
    unrouted: 0,
    failed: 0,
    registered: 0,
    unregistered: 0,
    staleHits: 0,
    epochBumps: 0,
    lastFrom: null,
    lastTo: null,
    lastAcceptedAt: null,
    lastDuplicateAt: null,
  }
  const rt = { server: null, boundPort: null, startedAt: null, retryTimer: null }

  /** 计数镜像进 state.json 顶层 hostBridge.http 分节(best-effort,分节合并写)。 */
  async function persistState() {
    await store.saveState((root) => {
      if (root.hostBridge === null || typeof root.hostBridge !== 'object' || Array.isArray(root.hostBridge)) {
        root.hostBridge = {}
      }
      root.hostBridge.http = {
        pid: process.pid,
        startedAt: rt.startedAt,
        bind: { host: bind, port: rt.boundPort },
        counters: {
          received: counters.received,
          accepted: counters.accepted,
          duplicates: counters.duplicates,
          rejected: counters.rejected,
          unrouted: counters.unrouted,
          failed: counters.failed,
          registered: counters.registered,
          unregistered: counters.unregistered,
          staleHits: counters.staleHits,
          epochBumps: counters.epochBumps,
        },
        last: {
          from: counters.lastFrom,
          to: counters.lastTo,
          acceptedAt: counters.lastAcceptedAt,
          duplicateAt: counters.lastDuplicateAt,
        },
      }
    })
  }

  /** 活槽判定(stale = 已换代,不算在册,spec §1.3)。 */
  function liveSids(registry) {
    return Object.keys(registry.consumers).filter((sid) => {
      const e = registry.consumers[sid]
      return e.stale === null || e.stale === undefined
    })
  }

  /** dead 裁定 → 400 载荷(IDX-4: details 分类增量,旧 error 语义不变,spec §1.1/§2.4)。 */
  function deadPayload(toValue, routing) {
    if (routing.classification === 'stale address') {
      return {
        ok: false,
        error: routing.reason,
        details: { classification: routing.classification, address: toValue, supersededBy: routing.supersededBy, epoch: routing.epoch },
      }
    }
    if (routing.classification === 'ghost address') {
      return {
        ok: false,
        error: routing.reason,
        details: { classification: routing.classification, address: toValue, canonicalHint: routing.hintCanonicals ?? ['none'] },
      }
    }
    return { ok: false, error: routing.reason }
  }

  /** 受理决策: 返回 {to} 或 {error, status, payload}。 */
  async function decideTo(payload) {
    const toValue = payload.to
    const missing = toValue === undefined || (typeof toValue === 'string' && toValue.trim().length === 0)
    const registry = await readRegistry(paths.registry)
    if (!missing) {
      const routing = resolveHostRouting(parseAddress(toValue), registry)
      if (routing.action === 'dead') {
        if (routing.classification === 'stale address') counters.staleHits += 1
        return { error: true, status: 400, payload: deadPayload(toValue, routing) }
      }
      return { to: toValue, broadcast: routing.broadcast ?? false }
    }
    // 缺省 to: 唯一**活槽**消费者补全;≥2 → 400 歧义;0 → 503(stale 不算在册,spec §1.3)。
    const sids = liveSids(registry)
    if (sids.length === 0) {
      return {
        error: true,
        status: 503,
        payload: { ok: false, error: 'host-callback-bridge: no registered consumers; POST /register {"sessionId","alias"} first' },
      }
    }
    if (sids.length >= 2) {
      return {
        error: true,
        status: 400,
        payload: {
          ok: false,
          error: 'ambiguous: no "to" field but multiple consumers are registered; address one explicitly',
          details: sids.map((sid) => canonicalOf(sid, registry.consumers[sid].alias)),
        },
      }
    }
    const sid = sids[0]
    return { to: canonicalOf(sid, registry.consumers[sid].alias), broadcast: false }
  }

  async function handleCallback(req, res) {
    let raw
    try {
      raw = await readBody(req, maxBodyBytes)
    } catch (error) {
      counters.rejected += 1
      sendJson(res, error?.statusCode ?? 400, { ok: false, error: `cannot read body: ${errorMessage(error)}` })
      return
    }
    let payload
    try {
      payload = JSON.parse(raw)
    } catch (error) {
      counters.rejected += 1
      await persistState()
      sendJson(res, 400, { ok: false, error: 'validation failed', details: [`body must be valid JSON: ${errorMessage(error)}`] })
      return
    }
    const errors = validate(payload)
    if (errors.length > 0) {
      counters.rejected += 1
      await persistState()
      sendJson(res, 400, { ok: false, error: 'validation failed', details: errors })
      return
    }

    const decision = await decideTo(payload)
    if (decision.error) {
      counters.unrouted += 1
      await persistState()
      sendJson(res, decision.status, decision.payload)
      return
    }

    const to = decision.to
    counters.lastFrom = payload.from
    counters.lastTo = to

    // P3b.1-2: 头四键重组 + 尾部条件透传 ref/msgid/ver(类型合法才透传;legacy 四键行零幻影键)
    const canonical = { type: payload.type, from: payload.from, to, body: payload.body }
    if (typeof payload.ref === 'string' && payload.ref.length > 0) canonical.ref = payload.ref
    if (typeof payload.msgid === 'string' && payload.msgid.length > 0) canonical.msgid = payload.msgid
    if (payload.ver === 2 || payload.ver === 3) canonical.ver = payload.ver
    const line = JSON.stringify(canonical)
    // 双查(R-B03+R-B16): primary 或 secondary 任一命中即重
    const keys = digestKeys(line, payload)
    const prior = dedup.seen(keys.primary) ?? (keys.secondary !== null ? dedup.seen(keys.secondary) : undefined)
    if (prior !== undefined) {
      counters.duplicates += 1
      counters.lastDuplicateAt = new Date(now()).toISOString()
      await persistState()
      sendJson(res, 208, {
        ok: true,
        status: 'already-delivered',
        deduplicated: true,
        deliveredAt: new Date(prior.deliveredAt).toISOString(),
        id: prior.meta ?? null,
        msgid: prior.meta ?? null,
        windowMs: dedupWindowMs,
      })
      return
    }

    try {
      await intake(line)
    } catch (error) {
      counters.failed += 1
      await persistState()
      sendJson(res, 500, { ok: false, error: `intake append failed: ${errorMessage(error)}` })
      return
    }

    counters.accepted += 1
    counters.lastAcceptedAt = new Date(now()).toISOString()
    await persistState()
    sendJson(res, 200, {
      ok: true,
      status: 'accepted',
      id: randomUUID(),
      msgid: payload.msgid ?? null,
      to,
      queue: 'inbox.log',
      dedupWindowMs,
    })
    try {
      onActivity?.()
    } catch {
      // 观发回调失败不影响应答。
    }
  }

  async function handleRegister(req, res) {
    let payload
    try {
      payload = JSON.parse(await readBody(req, maxBodyBytes))
    } catch (error) {
      counters.rejected += 1
      sendJson(res, 400, { ok: false, error: `body must be valid JSON: ${errorMessage(error)}` })
      return
    }
    const sessionId = payload?.sessionId
    const alias = payload?.alias ?? null
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      counters.rejected += 1
      sendJson(res, 400, { ok: false, error: 'sessionId must be a non-empty string', details: ['expected {"sessionId":"session-…","alias":"orch1"}'] })
      return
    }
    if (alias !== null && (typeof alias !== 'string' || alias.trim().length === 0)) {
      counters.rejected += 1
      sendJson(res, 400, { ok: false, error: 'alias must be a non-empty string when present' })
      return
    }
    const trimmedAlias = alias?.trim() ?? null
    const { registry, receipt } = await registerConsumer(paths.registry, version, { sessionId, alias: trimmedAlias }, { armedAt: new Date(now()).toISOString(), pid: process.pid, now })
    counters.registered += 1
    if (receipt.superseded !== null) counters.epochBumps += 1
    await persistState()
    // 多编排者防撞名(2026-08-26): 同 alias 被**其他活槽**持有时附 warning——
    // 裸别名寻址将死信(ambiguous), 差异化别名或全签名可解。非阻断: alias 是标签非键。
    // (IDX-4 后正常换代即 stale 退出, 此 warning 只剩 v4 懒迁移多槽等边角会触发。)
    let warning = null
    if (trimmedAlias) {
      const holders = Object.entries(registry.consumers)
        .filter(([sid, c]) => c?.alias === trimmedAlias && sid !== sessionId && (c.stale === null || c.stale === undefined))
        .map(([sid]) => sid)
      if (holders.length > 0) {
        warning = `alias "${trimmedAlias}" also held by ${holders.length} other consumer(s); bare-alias addressing will dead-letter (ambiguous) — use <alias>@<sessionId>`
      }
    }
    sendJson(res, 200, {
      ok: true,
      status: 'registered',
      consumer: canonicalOf(sessionId, trimmedAlias),
      registeredConsumers: Object.keys(registry.consumers).length,
      // IDX-4(spec §2.3): 代际回执——signature/epoch 恒在; superseded 非空 = 本次 arm 换代。
      signature: receipt.signature,
      epoch: receipt.epoch,
      superseded: receipt.superseded,
      ...(warning ? { warning } : {}),
    })
  }

  async function handleUnregister(req, res) {
    let payload
    try {
      payload = JSON.parse(await readBody(req, maxBodyBytes))
    } catch (error) {
      counters.rejected += 1
      sendJson(res, 400, { ok: false, error: `body must be valid JSON: ${errorMessage(error)}` })
      return
    }
    const sessionId = payload?.sessionId
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      counters.rejected += 1
      sendJson(res, 400, { ok: false, error: 'sessionId must be a non-empty string' })
      return
    }
    const registry = await unregisterConsumer(paths.registry, version, sessionId)
    counters.unregistered += 1
    await persistState()
    sendJson(res, 200, { ok: true, status: 'unregistered', sessionId, registeredConsumers: Object.keys(registry.consumers).length })
  }

  async function handle(req, res) {
    counters.received += 1
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      counters.rejected += 1
      sendJson(res, 403, { ok: false, error: 'forbidden: loopback clients only' })
      return
    }
    const path = (req.url ?? '').split('?')[0]
    if (path === basePath && req.method === 'POST') {
      await handleCallback(req, res)
      return
    }
    if (path === '/register' && req.method === 'POST') {
      await handleRegister(req, res)
      return
    }
    if (path === '/unregister' && req.method === 'POST') {
      await handleUnregister(req, res)
      return
    }
    if (path === '/status' && req.method === 'GET') {
      const registry = await readRegistry(paths.registry)
      sendJson(res, 200, {
        ok: true,
        plugin: '@maestro/host-callback-bridge',
        version,
        pid: process.pid,
        bind: { host: bind, port: rt.boundPort },
        counters: { ...counters },
        // IDX-4(spec §2.3): 每消费者带 epoch/stale; 新增 aliases 节(别名→epoch/holder)。
        registeredConsumers: Object.entries(registry.consumers).map(([sid, entry]) => ({
          consumer: canonicalOf(sid, entry.alias),
          sessionId: sid,
          epoch: entry.epoch ?? 0,
          stale: entry.stale ?? null,
        })),
        aliases: registry.aliases,
      })
      return
    }
    counters.rejected += 1
    sendJson(res, 404, {
      ok: false,
      error: `not found: endpoints are POST ${basePath}, POST /register, POST /unregister, GET /status (got ${req.method} ${path})`,
    })
  }

  function listenOnce(server, listenPort) {
    return new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(listenPort, bind, () => resolve())
    })
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  /**
   * start(preferredPort): 优先复用 http.port 记录的端口(发送端零漂移);EADDRINUSE
   * 时有限重试(HMR 换代窗内旧实例 close 排空竞窗),仍失败则退随机端口。
   */
  function start(preferredPort) {
    const run = (async () => {
      if (rt.server !== null) return rt.boundPort
      const server = createServer((req, res) => {
        handle(req, res).catch((error) => {
          counters.failed += 1
          try {
            sendJson(res, 500, { ok: false, error: `internal error: ${errorMessage(error)}` })
          } catch {
            // 响应头已发出则无法补救;计数已记。
          }
        })
      })
      let listenPort = preferredPort ?? port
      for (let attempt = 0; ; attempt += 1) {
        try {
          await listenOnce(server, listenPort)
          break
        } catch (error) {
          if (error?.code === 'EADDRINUSE' && listenPort !== 0 && attempt < bindRetry.attempts) {
            await sleep(bindRetry.delayMs)
            continue
          }
          if (error?.code === 'EADDRINUSE' && listenPort !== 0) {
            listenPort = 0 // 退随机端口(观测面如实记录)
            continue
          }
          throw error
        }
      }
      rt.server = server
      rt.boundPort = server.address().port
      rt.startedAt = new Date(now()).toISOString()
      server.on('close', () => {
        rt.server = null
        rt.boundPort = null
      })
      try {
        await fsp.mkdir(paths.dir, { recursive: true })
        await fsp.writeFile(`${paths.dir}/http.port`, `${rt.boundPort}\n`)
      } catch (error) {
        console.error('host-callback-bridge http.port write failed:', errorMessage(error))
      }
      await persistState()
      return rt.boundPort
    })()
    return run
  }

  function stop() {
    if (rt.retryTimer !== null) {
      clearTimeout(rt.retryTimer)
      rt.retryTimer = null
    }
    if (rt.server !== null) rt.server.close()
  }

  function status() {
    return {
      kind: 'http-intake',
      version,
      armed: rt.server !== null,
      bind: { host: bind, port: rt.boundPort },
      endpoint: rt.boundPort === null ? null : `http://${bind}:${rt.boundPort}${basePath}`,
      counters: { ...counters },
      dedupSize: dedup.size,
      dedupWindowMs,
    }
  }

  return { id: 'http-intake', start, stop, status, get port() { return rt.boundPort } }
}
