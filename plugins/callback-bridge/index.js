/**
 * @maestro/callback-bridge — 通用回调桥插件 (v4.0.0)
 *
 * 把 orca-callback(文件桥 v3.5)与 message-bridge(HTTP v1.0)抽象为:
 *   共享内核(core/: addressing/registry/dedup/store)+ 传输 source(sources/: file-inbox/http)
 *   + 回合 sink(sinks/agent-turn)。
 * 设计文档: docs/callback-bridge-design.md;平移映射表: ./README.md。
 *
 * 状态: P1 内核平移完成,尚未注册进 agent.cordis.yml(生产两插件零接触)。
 *
 * 契约: export const version / inject / apply(ctx, config)
 *   —— 与 orca-callback pump.js 相同的 preset 插件模块形状。
 */

import { createAgentTurnSink } from './sinks/agent-turn.js'
import { createBridgeStore } from './core/store.js'
import { createDedupWindow } from './core/dedup.js'
import { resolveRouting } from './core/addressing.js'
import { createFileInboxSource } from './sources/file-inbox.js'
import { createHttpSource } from './sources/http.js'

/** 版本指纹: arm/status 回执与磁盘对账用(v4,drop-in v3.5)。 */
export const version = '4.0.0'

export const inject = ['agents', 'tools']

// ---- 可调参数缺省(导出供测试引用;可由行 config 逐项覆盖) ----

export const DEDUP_WINDOW_MS = 60_000
export const MAX_WAKE_FAILURES = 3
export const RETRY_DELAY_MS = 2_000
export const ROTATE_MAX_BYTES = 1024 * 1024
export const ROTATE_MAX_LINES = 1000
export const ECHO_PREFIX = 'DSH-RE]'

/** config 缺省值: 与 orca-callback v3.5 + message-bridge v1.0 逐字段等价。 */
export const DEFAULT_CONFIG = {
  bridgeDir: null, // 解析优先级: env MAESTRO_BRIDGE > config.bridgeDir > ~/.dsh/maestro/bridge
  aliasEnv: 'MAESTRO_BRIDGE_ALIAS',
  sink: {
    messagePrefix: 'ORCA-CB]',
    pluginId: '@maestro/callback-bridge',
  },
  engine: {
    dedupWindowMs: DEDUP_WINDOW_MS,
    maxWakeFailures: MAX_WAKE_FAILURES,
    retryDelayMs: RETRY_DELAY_MS,
  },
  sources: [
    { kind: 'file-inbox', file: 'inbox.log', echoPrefix: ECHO_PREFIX, rotateMaxBytes: ROTATE_MAX_BYTES, rotateMaxLines: ROTATE_MAX_LINES },
    { kind: 'http', basePath: '/callback', portFile: 'http.port', bind: '127.0.0.1', maxBodyBytes: 256 * 1024 },
  ],
}

const KNOWN_SOURCE_KINDS = new Set(['file-inbox', 'http'])

/** 归一 + 校验行 config;未知 source kind 抛错(fail-loud,符合 mount "row 未达 usable 即拒")。 */
export function normalizeConfig(raw) {
  const cfg = raw === null || typeof raw !== 'object' ? {} : raw
  const merged = {
    bridgeDir: typeof cfg.bridgeDir === 'string' && cfg.bridgeDir.length > 0 ? cfg.bridgeDir : DEFAULT_CONFIG.bridgeDir,
    aliasEnv: typeof cfg.aliasEnv === 'string' ? cfg.aliasEnv : DEFAULT_CONFIG.aliasEnv,
    sink: { ...DEFAULT_CONFIG.sink, ...(cfg.sink ?? {}) },
    engine: { ...DEFAULT_CONFIG.engine, ...(cfg.engine ?? {}) },
    sources: Array.isArray(cfg.sources) && cfg.sources.length > 0 ? cfg.sources : DEFAULT_CONFIG.sources,
  }
  for (const source of merged.sources) {
    if (source === null || typeof source !== 'object' || typeof source.kind !== 'string'
      || !KNOWN_SOURCE_KINDS.has(source.kind)) {
      throw new Error(`callback-bridge: unknown or malformed source kind ${JSON.stringify(source?.kind)}`)
    }
  }
  return merged
}

/** bridgeDir 三级解析: env MAESTRO_BRIDGE > config.bridgeDir > ~/.dsh/maestro/bridge。 */
export function resolveBridgeDir(configured) {
  if (typeof process.env.MAESTRO_BRIDGE === 'string' && process.env.MAESTRO_BRIDGE.length > 0) {
    return process.env.MAESTRO_BRIDGE
  }
  if (configured !== null) return configured.replace(/^~(?=\/|$)/, process.env.HOME ?? '')
  return `${process.env.HOME}/.dsh/maestro/bridge`
}

export function apply(ctx, config) {
  const agents = ctx.agents
  const cfg = normalizeConfig(config)
  const bridgeDir = resolveBridgeDir(cfg.bridgeDir)

  // 共享内核(单实例,所有 source 复用: store / dedup / router / sink)。
  const store = createBridgeStore({ bridgeDir })
  const dedup = createDedupWindow({ windowMs: cfg.engine.dedupWindowMs })
  const router = { resolve: resolveRouting }
  const sink = createAgentTurnSink(agents, cfg.sink)

  const state = {
    consumer: null, // { sessionId, alias, canonical, armedAt }
    sources: new Map(), // id -> Source
  }

  async function armAll() {
    const consumer = state.consumer
    const started = []
    for (const sourceCfg of cfg.sources) {
      if (sourceCfg.kind === 'file-inbox') {
        let src = state.sources.get('file-inbox')
        if (src === undefined) {
          src = createFileInboxSource({
            store, consumer, router, dedup, sink, version,
            echoPrefix: sourceCfg.echoPrefix,
            rotateMaxBytes: sourceCfg.rotateMaxBytes,
            rotateMaxLines: sourceCfg.rotateMaxLines,
            dedupWindowMs: cfg.engine.dedupWindowMs,
            maxWakeFailures: cfg.engine.maxWakeFailures,
            retryDelayMs: cfg.engine.retryDelayMs,
          })
          state.sources.set('file-inbox', src)
        }
        src.start()
        await src.flush()
        started.push('file-inbox')
      } else if (sourceCfg.kind === 'http') {
        let src = state.sources.get('http')
        if (src === undefined) {
          src = createHttpSource({
            store, consumer, router, dedup, sink, version,
            basePath: sourceCfg.basePath,
            portFile: sourceCfg.portFile,
            bind: sourceCfg.bind,
            maxBodyBytes: sourceCfg.maxBodyBytes,
            dedupWindowMs: cfg.engine.dedupWindowMs,
          })
          state.sources.set('http', src)
        }
        await src.start()
        started.push('http')
      }
    }
    return started
  }

  ctx.tools.register({
    name: 'bridge_arm',
    description:
      'Arm the callback bridge (v4) for this session: bind the calling agent as a consumer, register it in '
      + 'bridge/registry.json, and start every configured source (file-inbox watcher on the Orca bridge inbox '
      + '+ loopback HTTP callback endpoint). Addressing, at-least-once file delivery, dedup, dead-lettering and '
      + 'rotation semantics are identical to orca-callback v3.5; the HTTP endpoint keeps the v1.0 status-code '
      + 'contract (200/208/400/403/404/405/413/503/500) and routes its "to" field through the same addressing '
      + 'kernel (see docs/callback-bridge-design.md). Call once at session start when externally driven callbacks are wanted.',
    parameters: {
      type: 'object',
      properties: {
        alias: {
          type: 'string',
          description: 'Consumer alias registered in bridge/registry.json; used in the canonical <alias>@<sessionId> signature. Defaults to the configured alias env when set, else sessionId-only registration.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      let agent
      try {
        agent = agents.requireInitiator()
      } catch (error) {
        return `cannot resolve initiating agent: ${error?.message}`
      }
      const sessionId = String(agent.id)
      const alias = typeof args?.alias === 'string' && args.alias.trim().length > 0
        ? args.alias.trim()
        : (typeof process.env[cfg.aliasEnv] === 'string' && process.env[cfg.aliasEnv].length > 0
          ? process.env[cfg.aliasEnv]
          : null)
      const canonical = alias === null ? sessionId : `${alias}@${sessionId}`
      if (state.consumer === null) {
        state.consumer = { sessionId, alias, canonical }
      }
      sink.bind(agent)
      let started
      try {
        started = await armAll()
      } catch (error) {
        return `bridge armed (callback-bridge v${version}) as ${canonical} but source start failed: ${error?.message}`
      }
      const statuses = [...state.sources.values()].map((src) => src.status())
      return `bridge armed (callback-bridge v${version}): consumer ${canonical} bound + registered in bridge/registry.json (pid ${process.pid}); `
        + `sources ${JSON.stringify(started)}; `
        + `config ${JSON.stringify({ bridgeDir, sink: cfg.sink, engine: cfg.engine })}`
    },
  })

  ctx.tools.register({
    name: 'bridge_status',
    description:
      'Callback bridge status: registered consumers, per-source health (HTTP port/bind, file cursor), and delivery counters. Idempotent; arms nothing by itself.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute() {
      const statuses = [...state.sources.values()].map((src) => src.status())
      return `callback-bridge v${version}: consumer=${state.consumer?.canonical ?? '(unarmed)'} bridgeDir=${bridgeDir} sources=${JSON.stringify(statuses)}`
    },
  })

  ctx.effect(() => () => {
    for (const source of state.sources.values()) {
      source.stop()
      if (typeof source.dispose === 'function') void source.dispose()
    }
  })
}

export default { version, inject, apply }