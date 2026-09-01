/**
 * @maestro/host-callback-bridge — 宿主 boot 回调桥(polyfill lane,SI-003)
 *
 * 尸检背景(2026-08-17 host 重启事故): 旧链路(bridge_arm/HTTP 口)随编排 agent 会话
 * 存亡——host 重启后 registry 清空、HTTP 死口、inbox 积压,投递依赖"agent 记得重
 * arm"+bash 后台轮询兜底,两者皆反模式。
 *
 * 本插件把链路载体从"编排会话"搬到"host 进程":
 *   ① 宿主 boot 即绑定 HTTP /callback(优先复用 bridge/http.port 记录端口,启动即写,
 *      与 cb-send 协议零变更);
 *   ② fs.watch 事件驱动盯 inbox.log(禁轮询): 新行按 registry.json 路由到目标会话,
 *      经回环 /api/session.prompt 注入指针行(复用 ORCA-CB] 信封;sessionId 是持久
 *      路由键,重启后的驻留会话被原生唤醒——零手动动作);
 *   ③ unknown/坏行照旧 dead-letter(dead.log 措辞与 v3.5/v3.6 逐字一致);
 *   ④ 编排会话只保留"消费回合",不再拥有链路——新代际经 POST /register 自注册。
 *
 * 迁移窗护驻(standby): apply() 时若 bridge/http.port 记录的端口已被监听(= 旧
 * 会话内 message-bridge 仍持有链路,即本插件被 HMR 热载入运行中 host 的情形),
 * 本插件全程待机不绑端口不盯文件,零干扰在飞编排;下次 host boot(旧面随进程消亡,
 * 端口必然空闲)自动全量接管。检测是一次性事件探活,不是轮询。
 *
 * 文件面单一权威(IDX-5): 2026-09 现场实证 polyfill file-router 与宿主原生
 * per-session watcher(bridge_arm 起活)并存时,同一 inbox 行被双投、且 polyfill
 * 误将原生道已投的行记成 ghost dead-letter。'sole'(缺省)保持本插件独占文件面
 * (全部既有门零回归);MAESTRO_BRIDGE_FILE_DELIVERY=ceded 让渡文件面——本插件
 * 只留 HTTP 受理面,消费交宿主原生 watcher,每行恰一个消费者 = 恰好一次。
 * 权衡全文见 README.md「文件面单一权威」。
 *
 * 部署形态: 源码=maestro-preset 仓 plugins/host-callback-bridge/(唯一源头);
 * 运行面=~/.dsh/plugins/host-callback-bridge/(自包含副本,dev-sync --polyfill 同步)
 * + ~/.dsh/plugins/polyfill.patch.yml 插入行(run-web.sh --patch 已装载)。
 * 红线: DSH 本体零改动。
 */
import { connect } from 'node:net'
import { appendFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createBridgeStore } from './core/store.js'
import { createDedupWindow } from './core/dedup.js'
import { createLoopbackSink } from './loopback-sink.js'
import { createHttpIntake } from './http-intake.js'
import { createFileRouter } from './file-router.js'

/** 版本指纹(状态文件/状态端点对账用)。 */
export const version = '1.0.0'

export const name = 'host-callback-bridge'

// polyfill lane 不注入宿主服务: 全部机制走 node:http/fs + 回环 fetch。
export const inject = []

export const DEDUP_WINDOW_MS = 60_000
export const MAX_WAKE_FAILURES = 3
export const RETRY_DELAY_MS = 2_000
export const ROTATE_MAX_BYTES = 1024 * 1024
export const ROTATE_MAX_LINES = 1000
export const STALE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000 // undertaker: stale 槽保留期(spec §2.5)
export const ECHO_PREFIX = 'DSH-RE]'
export const MESSAGE_PREFIX = 'ORCA-CB]'

/** bridgeDir 解析: env MAESTRO_BRIDGE > config.bridgeDir > ~/.dsh/maestro/bridge。 */
export function resolveBridgeDir(configured) {
  if (typeof process.env.MAESTRO_BRIDGE === 'string' && process.env.MAESTRO_BRIDGE.length > 0) {
    return process.env.MAESTRO_BRIDGE
  }
  if (typeof configured === 'string' && configured.length > 0) {
    return configured.replace(/^~(?=\/|$)/, process.env.HOME ?? '')
  }
  return `${process.env.HOME}/.dsh/maestro/bridge`
}

/**
 * 文件面投递权裁决(IDX-5 事故①: 双 watcher 同一 inbox.log — polyfill file-router
 * 与宿主原生 per-session watcher 并行消费,同一行双投 + 一方误记 dead-letter)。
 *   'sole'  (缺省) 现状不变: file-router 是文件面唯一消费者(既有门零回归)。
 *   'ceded'            polyfill 让渡文件面: 不启动 file-router、不写游标、不 flush;
 *                      HTTP 受理面照旧受理并 append inbox.log,文件消费整体交宿主
 *                      原生 per-session watcher(armed 才盯,自己游标自己写)。
 *                      caveat: 从未 arm 的会话其 inbox 行无人消费,积压不封顶——
 *                      由"编排线首动作 arm 自己"(IDX-5 Task D)缓解。
 * 解析优先级: options.fileDelivery > env MAESTRO_BRIDGE_FILE_DELIVERY > 'sole'。
 * 权衡记录见 README.md「文件面单一权威」。
 */
export function resolveFileDelivery(configured) {
  const raw = (configured ?? process.env.MAESTRO_BRIDGE_FILE_DELIVERY ?? '').trim().toLowerCase()
  return raw === 'ceded' ? 'ceded' : 'sole'
}

function log(bridgeDir, message) {
  const line = `${new Date().toISOString()} [host-callback-bridge] ${message}`
  console.log(line)
  try {
    appendFileSync(`${bridgeDir}/host-lane.log`, `${line}\n`)
  } catch {
    // 观测日志失败不阻断。
  }
}

/** 一次性 TCP 探活(事件回调,无定时循环): 端口被监听 → resolve(true)。 */
export function probePort(host, port, timeoutMs = 500) {
  return new Promise((resolve) => {
    if (!Number.isFinite(port) || port <= 0) {
      resolve(false)
      return
    }
    const socket = connect({ host, port })
    const finish = (result) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

/** 读 http.port 记录端口(缺省/坏值 → null)。 */
export async function readRecordedPort(fsp, portFile) {
  try {
    const txt = await fsp.readFile(portFile, 'utf8')
    const port = Number.parseInt(txt.trim(), 10)
    return Number.isFinite(port) && port > 0 ? port : null
  } catch {
    return null
  }
}

/**
 * activate(options) — 组装并启动全链路;导出供 selftest 注入 mock 环境复用。
 * options: { bridgeDir, apiPort?, fleetFile?, now?, fetchImpl?, httpIntake? (覆盖件) }
 * 返回 { standby, stop(), status() }。
 */
export async function activate(options = {}) {
  const {
    bridgeDir,
    apiPort = null,
    fleetFile = null,
    now = () => Date.now(),
    fetchImpl = null,
    httpIntake: intakeOverride = null,
    rotateMaxBytes = ROTATE_MAX_BYTES,
    rotateMaxLines = ROTATE_MAX_LINES,
    maxWakeFailures = MAX_WAKE_FAILURES,
    retryDelayMs = RETRY_DELAY_MS,
    staleRetentionMs = STALE_RETENTION_MS,
    fileDelivery: fileDeliveryOption = null,
  } = options
  const fileDelivery = resolveFileDelivery(fileDeliveryOption)

  const fsp = await import('node:fs/promises')
  await fsp.mkdir(bridgeDir, { recursive: true })
  try {
    await fsp.writeFile(`${bridgeDir}/inbox.log`, '', { flag: 'a' })
  } catch {
    // inbox 建立失败不致命(flush 会再试)。
  }

  // 迁移窗护驻: 记录端口仍被监听 = 旧会话内桥持有链路 → 待机到下次 host boot。
  const recordedPort = await readRecordedPort(fsp, `${bridgeDir}/http.port`)
  if (recordedPort !== null && await probePort('127.0.0.1', recordedPort)) {
    log(bridgeDir, `standby: http.port=${recordedPort} still held by the legacy in-session lane; host lane stays inert this process lifetime and takes over at next host boot`)
    return {
      standby: true,
      stop() {},
      status() {
        return { plugin: '@maestro/host-callback-bridge', version, standby: true, recordedPort }
      },
    }
  }

  const store = createBridgeStore({ bridgeDir })
  const dedup = createDedupWindow({ windowMs: DEDUP_WINDOW_MS, now })
  const sink = createLoopbackSink({
    messagePrefix: MESSAGE_PREFIX,
    fleetFile: fleetFile ?? `${dirname(bridgeDir)}/fleet.json`,
    apiPort,
    fetchImpl,
  })
  const router = createFileRouter({
    store,
    dedup,
    sink,
    version,
    echoPrefix: ECHO_PREFIX,
    rotateMaxBytes,
    rotateMaxLines,
    dedupWindowMs: DEDUP_WINDOW_MS,
    maxWakeFailures,
    retryDelayMs,
    staleRetentionMs,
    now,
  })
  const intake = intakeOverride ?? createHttpIntake({
    store,
    dedup,
    version,
    intake: async (line) => {
      await fsp.appendFile(store.paths.inbox, `${line}\n`)
    },
    onActivity: () => {
      if (fileDelivery === 'sole') {
        router.flush().catch(() => {})
      }
    },
    now,
    dedupWindowMs: DEDUP_WINDOW_MS,
  })

  const boundPort = await intake.start(recordedPort ?? 0)
  if (fileDelivery === 'sole') {
    router.start()
    // boot 即冲账: 接管 legacy 游标之后的积压(事故现场的"积压 3 行"场景)。
    await router.flush()
    log(bridgeDir, `active: /callback on 127.0.0.1:${boundPort} (http.port written); file router watching inbox.log (fileDelivery=sole); apiPort=${sink.resolveApiPort()}`)
  } else {
    // IDX-5: 文件面让渡——零 flush 零游标写入,文件消费权整体移交宿主原生
    // per-session watcher(投递恰好一次的前提是每行恰一个消费者)。
    log(bridgeDir, `active: /callback on 127.0.0.1:${boundPort} (http.port written); file delivery CEDED to per-session native watchers (fileDelivery=ceded; exactly-once = one consumer per line); caveat: never-armed sessions leave inbox backlog unbounded until they arm; apiPort=${sink.resolveApiPort()}`)
  }
  return {
    standby: false,
    stop() {
      router.stop()
      intake.stop()
    },
    status() {
      return {
        plugin: '@maestro/host-callback-bridge',
        version,
        standby: false,
        fileDelivery,
        http: intake.status(),
        router: router.status(),
      }
    },
  }
}

/**
 * 插件入口(polyfill lane): apply(ctx)。失败只记日志——插件挂掉不能拖垮宿主 boot。
 */
export function apply(ctx) {
  const bridgeDir = resolveBridgeDir(null)
  let handle = null
  activate({ bridgeDir })
    .then((h) => {
      handle = h
    })
    .catch((error) => {
      log(bridgeDir, `activation failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  try {
    ctx.effect(() => () => {
      try {
        handle?.stop()
      } catch {
        // teardown 尽力而为。
      }
    })
  } catch {
    // ctx.effect 不可用(非 cordis 上下文)时跳过注销注册。
  }
}

export default { version, name, inject, apply }
