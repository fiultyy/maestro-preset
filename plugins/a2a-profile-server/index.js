//
// SPDX-License-Identifier: BSD 2-Clause License
//
// index.js — @voice-head/a2a-profile-server 插件入口（cordis polyfill lane）。
// 形制对齐 @maestro/host-callback-bridge：apply(ctx) 失败只记日志不拖垮宿主；
// activate(options) 导出供 selftest 注入隔离环境复用。

import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createHttpServer } from './http-server.js'
import { createTaskStore } from './task-store.js'
import { createProfileStore } from './profile-store.js'
import { getIncubator } from './incubators/index.js'

export const version = '0.1.0'
export const name = 'a2a-profile-server'

const DEFAULT_PORT = Number(process.env.A2A_PROFILE_PORT ?? 8790)
const DEFAULT_ROOT = process.env.A2A_PROFILE_ROOT ?? join(homedir(), '.dsh/profiles/incubated')
const DEFAULT_STATE = join(homedir(), '.dsh/plugins/a2a-profile-server/state')

/** echo 执行器（W2.4 执行桥之前的占位）：working → (50ms) → completed，产物带凭证约定。 */
function echoExecutor(tasks) {
  return async (task) => {
    await tasks.transition(task.id, { state: 'working' })
    await new Promise((r) => setTimeout(r, 50))
    const content = `"Agent Final Message":\n\n${task.intent} 已完成 【凭证A2A-${task.id}】`
    await tasks.transition(task.id, { state: 'completed', artifacts: [{ type: 'done-body', content }] })
  }
}

/**
 * activate(options) -> { port, stop(), status() }
 * options: { port?, profileRoot?, stateDir?, token?, executor?, gatesFn?, incubate? }
 * 全部可注入——selftest 用临时目录 + 随机端口。
 */
export async function activate(options = {}) {
  const {
    port = DEFAULT_PORT,
    profileRoot = DEFAULT_ROOT,
    stateDir = DEFAULT_STATE,
    token = process.env.A2A_PROFILE_TOKEN ?? '',
    executor = null,
    gatesFn = null,
    incubate = null,
  } = options

  await mkdir(stateDir, { recursive: true })
  await mkdir(profileRoot, { recursive: true })

  const tasks = createTaskStore(join(stateDir, 'tasks.jsonl'))
  const profiles = createProfileStore(profileRoot)
  const http = createHttpServer({
    tasks,
    profiles,
    token,
    executor: executor ?? echoExecutor(tasks),
    gatesFn,
    incubate: incubate ?? ((ctx) => getIncubator(ctx.target ?? 'dry')(ctx)),
  })

  const boundPort = await http.start(port)
  log(stateDir, `active: agent-card + JSON-RPC on 127.0.0.1:${boundPort}; profiles at ${profileRoot}`)
  return {
    port: boundPort,
    stop() {
      http.stop()
    },
    status() {
      return { plugin: name, version, port: boundPort, profileRoot }
    },
  }
}

function log(stateDir, message) {
  import('node:fs/promises').then((fsp) => {
    fsp.appendFile(join(stateDir, 'plugin.log'), `${new Date().toISOString()} ${message}\n`).catch(() => {})
  })
}

/** 插件入口：polyfill lane，boot 即起，teardown 尽力而为。 */
export function apply(ctx) {
  let handle = null
  activate({})
    .then((h) => {
      handle = h
    })
    .catch((error) => {
      console.error(`[${name}] activation failed: ${error instanceof Error ? error.message : String(error)}`)
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
    // 非 cordis 上下文（独立 node 直跑）时无注销注册。
  }
}

export default { version, name, apply }
