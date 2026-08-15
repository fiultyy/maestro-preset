/**
 * http.js — 回环 HTTP source(message-bridge v1.0 createBridgeService 平移 + HTTP-R1 路由)。
 * 状态码契约整体保留: 200/208/400/403/404/405/413/503/500。
 * HTTP-R1: "to" 并入 router;缺省(缺失/空)→ 本绑定消费者(≥2 在册 → 400 歧义);
 *          显式 to → resolveRouting: wake→200/208, skip→404, dead→400(不写 dead.log,
 *          dead.log 是 file-inbox 传输特性,HTTP 是请求级同步契约)。
 * HTTP-R2: 计数并入主 state.json 的 consumers.<sid>.http 分节(无独立 http.state.json);
 *          保留 http.port 端口发现文件。
 */
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import * as fsp from 'node:fs/promises'
import { parseAddress } from '../core/addressing.js'
import { digestOf } from '../core/dedup.js'
import { readRegistry } from '../core/registry.js'

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

/**
 * 与宿主解耦的 HTTP source。
 * config:
 *   store / consumer / router / dedup / sink / version — 同 file-inbox
 *   basePath / portFile / bind / maxBodyBytes / types / port / now / dedupWindowMs
 * 返回 { id, start, stop, status, port }。
 */
export function createHttpSource(config) {
  const {
    store,
    consumer,
    router,
    dedup,
    sink,
    version,
    basePath = '/callback',
    portFile = 'http.port',
    bind = '127.0.0.1',
    maxBodyBytes = 256 * 1024,
    types = ['done', 'ping', 'status'],
    port = 0,
    now = () => Date.now(),
    dedupWindowMs = 60_000,
  } = config

  if (store === null || typeof store !== 'object' || typeof store.paths !== 'object') {
    throw new TypeError('createHttpSource: store { paths, saveState } is required')
  }
  if (typeof router !== 'object' || router === null || typeof router.resolve !== 'function') {
    throw new TypeError('createHttpSource: router.resolve is required')
  }
  if (dedup === null || typeof dedup !== 'object' || typeof dedup.seen !== 'function' || typeof dedup.mark !== 'function') {
    throw new TypeError('createHttpSource: dedup { seen, mark } is required')
  }
  if (sink === null || typeof sink !== 'object' || typeof sink.deliver !== 'function') {
    throw new TypeError('createHttpSource: sink.deliver is required')
  }
  if (consumer === null || typeof consumer !== 'object' || typeof consumer.sessionId !== 'string' || consumer.sessionId.length === 0) {
    throw new TypeError('createHttpSource: consumer.sessionId is required')
  }

  const canonical = consumer.alias ? `${consumer.alias}@${consumer.sessionId}` : consumer.sessionId
  const paths = {
    dir: store.paths.dir,
    portFile: `${store.paths.dir}/${portFile}`,
  }

  const counters = {
    received: 0,
    delivered: 0,
    duplicates: 0,
    rejected: 0,
    unrouted: 0,
    failed: 0,
    skipped: 0,
    lastFrom: null,
    lastTo: null,
    lastDeliveredAt: null,
    lastDuplicateAt: null,
  }
  const rt = { server: null, boundPort: null, startedAt: null }

  /** HTTP-R2: 计数镜像进主 state.json 的 consumers.<sid>.http 分节(best-effort)。 */
  async function persistState() {
    await store.saveState((root) => {
      root.version = version
      if (root.consumers === null || typeof root.consumers !== 'object' || Array.isArray(root.consumers)) {
        root.consumers = {}
      }
      const prev = root.consumers[consumer.sessionId]
      if (prev === null || typeof prev !== 'object' || Array.isArray(prev)) {
        root.consumers[consumer.sessionId] = {}
      }
      root.consumers[consumer.sessionId].http = {
        pid: process.pid,
        startedAt: rt.startedAt,
        bind: { host: bind, port: rt.boundPort },
        counters: {
          received: counters.received,
          delivered: counters.delivered,
          duplicates: counters.duplicates,
          rejected: counters.rejected,
          unrouted: counters.unrouted,
          failed: counters.failed,
          skipped: counters.skipped,
        },
        last: {
          from: counters.lastFrom,
          to: counters.lastTo,
          deliveredAt: counters.lastDeliveredAt,
          duplicateAt: counters.lastDuplicateAt,
        },
      }
    })
  }

  function validate(payload) {
    const errors = []
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return ['body must be a JSON object']
    }
    if (!types.includes(payload.type)) {
      errors.push(`type must be one of ${types.join('|')} (got ${JSON.stringify(payload.type)})`)
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

  async function route(payload) {
    const self = { sessionId: consumer.sessionId, alias: consumer.alias ?? null }
    const toValue = payload.to
    const missing = toValue === undefined || (typeof toValue === 'string' && toValue.trim().length === 0)
    if (!missing) {
      const registry = await readRegistry(store.paths.registry)
      return router.resolve(parseAddress(toValue), self, registry)
    }
    // HTTP-R1: 缺省 to → 本绑定消费者;≥2 在册 → 400 歧义(单消费者假设显式化)。
    const registry = await readRegistry(store.paths.registry)
    const sids = Object.keys(registry.consumers)
    if (sids.length >= 2) {
      return { action: 'ambiguous', sids }
    }
    if (sids.length === 1 && sids[0] !== consumer.sessionId) {
      return { action: 'skip' }
    }
    return { action: 'wake', broadcast: false }
  }

  async function handle(req, res) {
    counters.received += 1

    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      counters.rejected += 1
      sendJson(res, 403, { ok: false, error: 'forbidden: loopback clients only' })
      return
    }

    const path = (req.url ?? '').split('?')[0]
    if (path !== basePath) {
      counters.rejected += 1
      sendJson(res, 404, { ok: false, error: `not found: POST ${basePath} is the only endpoint (got ${req.method} ${path})` })
      return
    }
    if (req.method !== 'POST') {
      counters.rejected += 1
      sendJson(res, 405, { ok: false, error: 'method not allowed: use POST', allow: 'POST' }, { allow: 'POST' })
      return
    }

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
      sendJson(res, 400, {
        ok: false,
        error: 'validation failed',
        details: [`body must be valid JSON: ${errorMessage(error)}`],
      })
      return
    }

    const errors = validate(payload)
    if (errors.length > 0) {
      counters.rejected += 1
      await persistState()
      sendJson(res, 400, { ok: false, error: 'validation failed', details: errors })
      return
    }

    const routing = await route(payload)
    if (routing.action === 'ambiguous') {
      counters.rejected += 1
      await persistState()
      sendJson(res, 400, {
        ok: false,
        error: 'ambiguous: no "to" field but multiple consumers are registered; address one explicitly',
        details: routing.sids,
      })
      return
    }
    if (routing.action === 'dead') {
      counters.unrouted += 1
      await persistState()
      sendJson(res, 400, { ok: false, error: routing.reason })
      return
    }
    if (routing.action === 'skip') {
      counters.skipped += 1
      await persistState()
      sendJson(res, 404, { ok: false, error: 'addressed to another registered consumer; POST to that consumer endpoint' })
      return
    }

    const to = (typeof payload.to === 'string' && payload.to.trim().length > 0) ? payload.to : canonical
    counters.lastFrom = payload.from
    counters.lastTo = to

    const line = JSON.stringify({ type: payload.type, from: payload.from, to, body: payload.body })
    const digest = digestOf(line, payload)
    const prior = dedup.seen(digest)
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
        windowMs: dedupWindowMs,
      })
      return
    }

    try {
      sink.deliver(line, { parsed: payload, at: now(), to, broadcast: routing.broadcast ?? false, consumer: canonical })
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'MSG_BRIDGE_NOT_ARMED') {
        counters.unrouted += 1
        await persistState()
        sendJson(res, 503, { ok: false, error: errorMessage(error) })
        return
      }
      counters.failed += 1
      await persistState()
      sendJson(res, 500, { ok: false, error: `wake failed: ${errorMessage(error)}` })
      return
    }

    const id = randomUUID()
    dedup.mark(digest, id)
    counters.delivered += 1
    counters.lastDeliveredAt = new Date(now()).toISOString()
    await persistState()
    sendJson(res, 200, {
      ok: true,
      status: 'delivered',
      id,
      to,
      dedupWindowMs,
    })
  }

  async function start() {
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
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, bind, () => resolve())
    })
    rt.server = server
    rt.boundPort = server.address().port
    rt.startedAt = new Date(now()).toISOString()
    server.on('close', () => {
      rt.server = null
      rt.boundPort = null
    })
    try {
      await fsp.mkdir(store.paths.dir, { recursive: true })
      await fsp.writeFile(paths.portFile, `${rt.boundPort}\n`)
    } catch (error) {
      console.error('callback-bridge http.port write failed:', errorMessage(error))
    }
    await persistState()
    return rt.boundPort
  }

  function stop() {
    if (rt.server !== null) rt.server.close()
  }

  function status() {
    return {
      kind: 'http',
      version,
      armed: rt.server !== null,
      bind: { host: bind, port: rt.boundPort },
      endpoint: rt.boundPort === null ? null : `http://${bind}:${rt.boundPort}${basePath}`,
      portFile: paths.portFile,
      counters: { ...counters },
      dedupSize: dedup.size,
      dedupWindowMs,
    }
  }

  return { id: 'http', start, stop, status, get port() { return rt.boundPort } }
}