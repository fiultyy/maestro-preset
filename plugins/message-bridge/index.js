/**
 * @maestro/message-bridge — HTTP 直发回调插件 (v1.3)
 *
 * 与 orca-callback pump（文件桥）并列的第二条入向通道：不走 Orca 桥 pane /
 * inbox.log，而是本地回环 HTTP 微服务，供任何同机进程一条 curl 直发回调：
 *
 *   curl -sS -X POST http://127.0.0.1:<port>/callback \
 *        -H 'content-type: application/json' \
 *        -d '{"type":"done","from":"agent@loc","to":"编排1","body":"…"}'
 *
 * 选型说明（handoff 任务 B 的二选一）：
 *   首选接缝本是宿主连接面 HostConnectionRpc.intercept('/api', …, {authority:'loopback'})
 *   （DSH 源码锚点 packages/client/connection/src/rpc.ts），但该服务由
 *   @deepseek-ai/dsh-client-connection 提供、inject ['webServer']，只在 web
 *   profile（dsh-web-app bundle）存在；headless bundle 自述 "no Host, HTTP, or
 *   browser layer"，preset 作用域内 ctx.get('connection') 解析不到。且 /api
 *   拦截器走 ClientRequest RPC 信封（rpcId/method/payload），与 handoff 规定的
 *   裸 JSON POST /callback 契约不匹配，注册面也随会话 fiber 撤销。故实现为
 *   本地回环 HTTP 微服务（127.0.0.1 + 随机端口写入 bridge/http.port），
 *   headless/web 两类会话同一行为、可独立 curl 自测。apply() 仍会探测
 *   ctx.connection 并在 bridge_http_status 中报告（仅信息性，不用于路由）。
 *
 * 行为契约：
 *   POST /callback  {"type":"ack|done|ping|status","from":"<agent@loc>","to":"<可选,默认编排1>","body":"<文本>"}
 *     - type=ack 用于派发握手: 对端回合开始时回 "[ref:…] turn started"(见 bin/cb-send
 *       与 skills/orca-bridge 的 ACK/DONE 契约);done 携带 ≤300 字符结果摘要
 *     - 200 校验通过且已投递（followup/inject 与 pump 同策略：idle→followup，忙→inject）
 *     - 400 校验失败（附错误详情），不投递
 *     - 208 同一 (from, body) 60s 内重复 → 已投递标记，不重复 wake
 *     - 404 非显式路由: 路径不符, 或（v1.3 ADDR-R1）显式 to 无匹配 armed 槽
 *     - 405/413/403 非 POST / 超过 256KB / 非回环来源
 *     - 503 尚未 arm（目标会话还没调过 bridge_http_status，无 agent 绑定）
 *     - 500 wake 抛错（计数入 failed）
 *   鉴权：仅监听 127.0.0.1，且逐请求校验 remoteAddress 为回环；`to` 自 v1.2 起
 *     路由（v1.3 收紧为精确命中, 见上）, 缺省补 DEFAULT_TO 仅作记录。
 *
 * 工具:
 *   bridge_http_status — arm + 状态查询：绑定发起 agent、启动监听（幂等），
 *   返回端口/绑定/计数。会话开场调用一次即可。
 *
 * v1.3 相对 v1.2 的变更（ticket 0005 / design §9, 换代七/八坑现场）:
 *   1. ADDR-R1 路由收紧: 显式非空 to 必须精确命中 armed HTTP 槽（to===sid 或
 *      以 `@${sid}` 结尾, 弃 v1.2 的 includes 宽匹配）, 失配 →
 *      404 {error:"no armed HTTP slot for to=<sig>"}——绝不 most-recent-armer
 *      兜底吸收（错投比拒收危险: 拒收后 cb-send 降级文件桥仍可按 registry 正确
 *      路由, 错投则双方都难察觉）; 仅 to 缺省/空保留 last-armer 兜底。
 *   2. PORT-R1 端口持有者签名: arm 时旁挂写 bridge/http.port.sig（=持有者
 *      sessionId, 每次 arm 覆写, 与 http.port 恒成对; 不用 port 文件第二行——
 *      发送端 `tr -d '[:space:]'` 读取会把双行拼串）; bin/cb-send 读端口后校验
 *      目标签名==持有者, 不符不 POST 直落文件桥（消除跨代际"撞错桥"整类现场）。
 *   3. HTTP-R2 裁决（不回写 inbox）: 会话内 HTTP 面定位为"低延迟通知"——
 *      delivered 是进程内一次直发 wake, 非持久证据; 驱动语义与持久证据归文件泵
 *      （v3.6）+session-send。回写式受理面（受理即落 inbox, 200=accepted durable）
 *      由宿主 lane 承载（plugins/host-callback-bridge, SI-003）。会话内实现回写
 *      被否: 直发+回写并存 → armed 双通道会话重复唤醒（两去重窗口不互通）; 去掉
 *      直发只回写 → HTTP-only armed 会话被泵 registry 死信（HTTP 槽表与泵
 *      registry 是两张路由表）。
 */
import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import * as fsp from 'node:fs/promises'

/** 版本指纹：bridge_http_status 回执携带，供会话与磁盘对账。 */
export const version = '1.3.0'

export const inject = ['agents', 'tools']

/** 幂等去重窗口（毫秒）：同一 (from, body) 在窗口内重复请求返回 208。 */
export const DEDUP_WINDOW_MS = 60_000
/** 请求体上限（字节）。 */
export const MAX_BODY_BYTES = 256 * 1024
/** 允许的消息 type 枚举（ack = 派发握手: 回合已开始）。 */
export const TYPES = ['ack', 'done', 'ping', 'status']
/** to 缺省（仅记录，不路由）。 */
export const DEFAULT_TO = '编排1'
/** 回环监听地址。 */
export const BIND_HOST = '127.0.0.1'

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
      if (overflow) return // 已超限：不再缓冲，但继续排空以便干净应答
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
 * 与宿主解耦的服务核心（导出供单测/临时实例注入假 wake）。
 *
 * config:
 *   bridgeDir — 桥目录（http.port / http.state.json 写入地）
 *   wake(line)— 投递函数：成功入队正常返回；失败必须抛错（→ 500）
 *   host / port / now / dedupWindowMs — 覆盖项（测试用）
 *
 * 返回 { start, stop, status, port, url }。
 */
export function createBridgeService(config) {
  const {
    bridgeDir,
    wake,
    host = BIND_HOST,
    port = 0,
    now = () => Date.now(),
    dedupWindowMs = DEDUP_WINDOW_MS,
  } = config

  if (typeof bridgeDir !== 'string' || bridgeDir.length === 0) throw new TypeError('createBridgeService: bridgeDir is required')
  if (typeof wake !== 'function') throw new TypeError('createBridgeService: wake function is required')

  const paths = {
    dir: bridgeDir,
    portFile: `${bridgeDir}/http.port`,
    stateFile: `${bridgeDir}/http.state.json`,
  }

  const counters = {
    received: 0,
    delivered: 0,
    duplicates: 0,
    rejected: 0,
    unrouted: 0,
    failed: 0,
  }

  const dedup = new Map() // digest → { deliveredAt, id }
  const rt = { server: null, boundPort: null, startedAt: null }

  function pruneDedup() {
    const horizon = now() - dedupWindowMs
    for (const [key, entry] of dedup) {
      if (entry.deliveredAt < horizon) dedup.delete(key)
    }
  }

  async function persistState() {
    try {
      // 计数平铺进 counters，last* 收进 last；均为 best-effort 镜像。
      const clean = {
        version,
        plugin: '@maestro/message-bridge',
        pid: process.pid,
        startedAt: rt.startedAt,
        bind: { host, port: rt.boundPort },
        counters: {
          received: counters.received,
          delivered: counters.delivered,
          duplicates: counters.duplicates,
          rejected: counters.rejected,
          unrouted: counters.unrouted,
          failed: counters.failed,
        },
        last: {
          from: counters.lastFrom ?? null,
          to: counters.lastTo ?? null,
          deliveredAt: counters.lastDeliveredAt ?? null,
          duplicateAt: counters.lastDuplicateAt ?? null,
        },
      }
      const tmp = `${paths.stateFile}.tmp`
      await fsp.writeFile(tmp, `${JSON.stringify(clean, null, 2)}\n`)
      await fsp.rename(tmp, paths.stateFile)
    } catch {
      // 可观测镜像失败不阻断投递主路径。
    }
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

  async function handle(req, res) {
    counters.received += 1

    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      counters.rejected += 1
      sendJson(res, 403, { ok: false, error: 'forbidden: loopback clients only' })
      return
    }

    const path = (req.url ?? '').split('?')[0]
    if (path !== '/callback') {
      counters.rejected += 1
      sendJson(res, 404, { ok: false, error: `not found: POST /callback is the only endpoint (got ${req.method} ${path})` })
      return
    }
    if (req.method !== 'POST') {
      counters.rejected += 1
      sendJson(res, 405, { ok: false, error: 'method not allowed: use POST', allow: 'POST' }, { allow: 'POST' })
      return
    }

    let raw
    try {
      raw = await readBody(req, MAX_BODY_BYTES)
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
      sendJson(res, 400, {
        ok: false,
        error: 'validation failed',
        details: [`body must be valid JSON: ${errorMessage(error)}`],
      })
      await persistState()
      return
    }

    const errors = validate(payload)
    if (errors.length > 0) {
      counters.rejected += 1
      sendJson(res, 400, { ok: false, error: 'validation failed', details: errors })
      await persistState()
      return
    }

    const to = payload.to ?? DEFAULT_TO
    counters.lastFrom = payload.from
    counters.lastTo = to

    // P3b.2 过渡: digest 材料条件分流(msgid 非空 → from\0msgid;该面 P4 删,无跨版本双记义务)
    const digest = createHash('sha256')
      .update(typeof payload.msgid === 'string' && payload.msgid.length > 0
        ? `${payload.from}\u0000${payload.msgid}`
        : `${payload.from}\u0000${payload.body}`)
      .digest('hex')
    const prior = dedup.get(digest)
    if (prior !== undefined && now() - prior.deliveredAt < dedupWindowMs) {
      counters.duplicates += 1
      counters.lastDuplicateAt = new Date(now()).toISOString()
      sendJson(res, 208, {
        ok: true,
        status: 'already-delivered',
        deduplicated: true,
        deliveredAt: new Date(prior.deliveredAt).toISOString(),
        id: prior.id,
        msgid: prior.msgid ?? null,
        windowMs: dedupWindowMs,
      })
      await persistState()
      return
    }

    // P3b.1-3 过渡: canonical line 尾部条件透传 ref/msgid/ver(与宿主受理面同构;P4 本文件删除)
    const canonical = { type: payload.type, from: payload.from, to, body: payload.body }
    if (typeof payload.ref === 'string' && payload.ref.length > 0) canonical.ref = payload.ref
    if (typeof payload.msgid === 'string' && payload.msgid.length > 0) canonical.msgid = payload.msgid
    if (payload.ver === 2 || payload.ver === 3) canonical.ver = payload.ver
    const line = JSON.stringify(canonical)
    try {
      // info.to = 请求原始 to（未混入 DEFAULT_TO 补全）: 缺省 → last-armer 兜底;
      // 显式非空 → 必须精确命中 armed 槽（v1.3 ADDR-R1）。canonical line 仍带
      // 补全后的 to（记录面不变）。
      wake(line, { to: payload.to })
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'MSG_BRIDGE_ROUTE_MISS') {
        // 显式定向失配: 拒收（非 5xx）——发送端 cb-send 据此降级文件桥按 registry
        // 正确路由, 不再兜底吸收（ticket 0005 现场根因一）。
        counters.unrouted += 1
        sendJson(res, 404, { ok: false, error: errorMessage(error) })
        await persistState()
        return
      }
      if (error !== null && typeof error === 'object' && error.code === 'MSG_BRIDGE_NOT_ARMED') {
        counters.unrouted += 1
        sendJson(res, 503, { ok: false, error: errorMessage(error) })
        await persistState()
        return
      }
      counters.failed += 1
      sendJson(res, 500, { ok: false, error: `wake failed: ${errorMessage(error)}` })
      await persistState()
      return
    }

    const id = randomUUID()
    dedup.set(digest, { deliveredAt: now(), id, msgid: payload.msgid ?? null })
    pruneDedup()
    counters.delivered += 1
    counters.lastDeliveredAt = new Date(now()).toISOString()
    sendJson(res, 200, {
      ok: true,
      status: 'delivered',
      id,
      to,
      dedupWindowMs: dedupWindowMs,
    })
    await persistState()
  }

  async function start() {
    if (rt.server !== null) return rt.boundPort
    const server = createServer((req, res) => {
      handle(req, res).catch((error) => {
        counters.failed += 1
        try {
          sendJson(res, 500, { ok: false, error: `internal error: ${errorMessage(error)}` })
        } catch {
          // 响应头已发出则无法补救；计数已记。
        }
      })
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => resolve())
    })
    rt.server = server
    rt.boundPort = server.address().port
    rt.startedAt = new Date(now()).toISOString()
    server.on('close', () => {
      rt.server = null
      rt.boundPort = null
    })
    try {
      await fsp.mkdir(bridgeDir, { recursive: true })
      await fsp.writeFile(paths.portFile, `${rt.boundPort}\n`)
    } catch (error) {
      console.error('message-bridge http.port write failed:', errorMessage(error))
    }
    await persistState()
    return rt.boundPort
  }

  function stop() {
    if (rt.server !== null) rt.server.close()
  }

  function status() {
    return {
      version,
      plugin: '@maestro/message-bridge',
      pid: process.pid,
      armed: rt.server !== null,
      bind: { host, port: rt.boundPort },
      endpoint: rt.boundPort === null ? null : `http://${host}:${rt.boundPort}/callback`,
      portFile: paths.portFile,
      stateFile: paths.stateFile,
      counters: { ...counters },
      dedupSize: dedup.size,
      dedupWindowMs,
    }
  }

  return { start, stop, status, get port() { return rt.boundPort } }
}

/**
 * 按投递目标挑选唤醒槽（v1.3,ticket 0005 ADDR-R1）:
 * to 显式且非空 → 必须精确命中 armed 槽（to===sid 或 to 以 `@${sid}` 结尾;
 *   弃 v1.2 的 includes 宽匹配——子串命中会把幽灵/错拼地址静默路由到碰巧包含
 *   的槽）: 命中返回 sid, 失配返回 ROUTE_MISS（handle → 404 拒收, 由发送端
 *   降级文件桥——错投比拒收危险）;
 * to 缺省/空/非字符串 → lastArmedId 兜底（单会话便利性保留, v1.2 行为）。
 * 纯函数,导出供单测。
 */
export const ROUTE_MISS = Symbol('pickRecipient: explicit to matched no armed slot')

export function pickRecipient(to, knownSessionIds, lastArmedId) {
  if (typeof to === 'string' && to.length > 0) {
    for (const sid of knownSessionIds) {
      if (to === sid || to.endsWith(`@${sid}`)) return sid
    }
    return ROUTE_MISS
  }
  return lastArmedId ?? null
}

export function apply(ctx) {
  const agents = ctx.agents
  const bridgeDir = process.env.MAESTRO_BRIDGE ?? `${process.env.HOME}/.dsh/maestro/bridge`
  // v1.2: HTTP 服务进程级单例(端口/去重全局),但 agent 绑定按 sessionId 分槽——
  // 单槽会被后 arm 的会话抢占(incident 0003 冷测回调全数劫持)。
  const slots = new Map() // sessionId -> agent
  let lastArmedId = null
  const state = { service: null, hostRpcAvailable: undefined }

  try {
    state.hostRpcAvailable = typeof ctx.get === 'function' ? ctx.get('connection') !== undefined : false
  } catch {
    state.hostRpcAvailable = false
  }

  const wake = (line, info) => {
    let targetId = null
    let missedTo = null
    try {
      const envelope = JSON.parse(line)
      // info 由 handle() 恒携带: {to: payload.to}。info.to === undefined 即"缺省"
      // （不能回退 envelope.to——那是 DEFAULT_TO 补全后的记录面值, 回退会把缺省
      // 误判成显式定向而 404）。仅在无 info 的旧式直调下才读 envelope。
      const to = info !== undefined ? info.to : envelope?.to
      const picked = pickRecipient(to, [...slots.keys()], lastArmedId)
      if (picked === ROUTE_MISS) missedTo = to
      else targetId = picked
    } catch {
      targetId = lastArmedId
    }
    if (missedTo !== null) {
      throw Object.assign(
        new Error(`no armed HTTP slot for to=${missedTo}`),
        { code: 'MSG_BRIDGE_ROUTE_MISS' },
      )
    }
    const agent = targetId === null ? null : slots.get(targetId) ?? null
    if (agent === null) {
      throw Object.assign(
        new Error('message-bridge not armed: call bridge_http_status in the target session first'),
        { code: 'MSG_BRIDGE_NOT_ARMED' },
      )
    }
    const message = Object.freeze({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: `MSGBR] ${line}` }],
      source: { kind: 'plugin', plugin: '@maestro/message-bridge', form: 'notice', summary: `Message bridge callback routed to ${targetId}` },
    })
    if (agent.status === 'idle') agent.followup(message)
    else agent.inject(message)
  }

  ctx.tools.register({
    name: 'bridge_http_status',
    description:
      'Arm and inspect the message-bridge loopback HTTP callback endpoint (POST /callback on 127.0.0.1, random port published to bridge/http.port). First call in a session binds the calling agent and starts the listener (idempotent); every call returns port/bind/counters. Valid callbacks drive native followup/inject turns with 60s (from,body) idempotency (208 on duplicates) and 400 on validation failure. Types: ack (dispatch handshake - peer turn started), done (completion summary), ping, status. Since v1.3 the to field routes strictly: <alias>@<sessionId> or bare sessionId wakes exactly that armed session; an explicit unmatched to is rejected with 404 (no fallback absorption - the sender falls back to the file bridge, which routes via registry); only a missing to wakes the most recent armer. Arming also records the port-holder signature in bridge/http.port.sig (PORT-R1) so cb-send can refuse cross-generation POSTs. HTTP delivery is a low-latency notice, not durable evidence (HTTP-R2 option ii): durable semantics live in the file pump + session-send. HostConnectionRpc availability is reported for the record only.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute() {
      let agent
      try {
        agent = agents.requireInitiator()
      } catch (error) {
        return `cannot resolve initiating agent: ${error?.message}`
      }
      const sessionId = String(agent.id)
      slots.set(sessionId, agent)
      lastArmedId = sessionId
      if (state.service === null) {
        state.service = createBridgeService({ bridgeDir, wake })
      }
      let startedError = null
      try {
        await state.service.start()
      } catch (error) {
        startedError = errorMessage(error)
      }
      const s = state.service.status()
      if (startedError !== null) {
        return `message-bridge failed to start listener: ${startedError}; counters: ${JSON.stringify(s.counters)}`
      }
      // PORT-R1: 端口持有者签名旁挂（=本 sessionId; 每次 arm 覆写, 与 http.port
      // 恒成对——进程级单例端口不变, 持有者随 arm 更新）。best-effort: 写失败仅记
      // 日志, 不影响 arm 回执（与 service 内 http.port 写同策略）。
      try {
        await fsp.writeFile(`${bridgeDir}/http.port.sig`, `${sessionId}\n`)
      } catch (error) {
        console.error('message-bridge http.port.sig write failed:', errorMessage(error))
      }
      return `message-bridge v${version} armed: ${s.endpoint} (pid ${s.pid}); `
        + `this session ${sessionId} (${slots.size} armed slot(s), routing: explicit to must hit an armed slot - miss → 404, no fallback absorption; missing to → most-recent armer); `
        + `port file ${s.portFile} (holder sig http.port.sig=${sessionId}); `
        + `curl -X POST ${s.endpoint} -H 'content-type: application/json' `
        + `-d '{"type":"done","from":"<agent@loc>","body":"…"}'; `
        + `counters ${JSON.stringify(s.counters)}; `
        + `hostConnectionRpc=${state.hostRpcAvailable ? 'available (unused by design: headless preset scope lacks it; /api RPC envelope does not match the plain-JSON POST contract)' : 'unavailable (headless preset scope)'}`
    },
  })

  ctx.effect(() => () => {
    state.service?.stop()
  })
}

export default { version, inject, apply }
