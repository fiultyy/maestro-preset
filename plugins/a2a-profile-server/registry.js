//
// SPDX-License-Identifier: BSD 2-Clause License
//
// registry.js — fleet 元数据扩展 + reattach + 生命周期状态机（VO-003；KG 06 §1.5–1.6）。
//
//   fleet 登记项扩五键：role/project/mailbox/profile_version/spawned_at（VO-002 孵化侧已写；
//   本模块提供原子读写面，合并写不破坏既有键）。
//   reattach()：插件启动恢复——遍历 fleet role≠worker 条目，loopback session.list 比对；
//     会话在 → 内存表登记 {code, sessionId, mailbox, state:"reattached"}；
//     会话失 → fleet 标 retired + journal {op:"orphan"}（孤儿检测）。
//   生命周期：spawn→arm→ready→serving→retired（transition 校验，非法抛错）；
//     reattached 为恢复态（等效 ready，§1.5），可 → serving/retired。
//   心跳：heartbeat() = router 侧 loopback session.list 探活（arm→ready 首次心跳触发）。
//     唤醒模型（§1.6 钉死）：dsh 会话非常驻轮询者——本模块零定时器零自发轮询，
//     探活一律由 router 外部驱动调用；agent 侧推唤醒 + 回合首拉取，与此无涉。
//
// journal：router-journal.jsonl（task-store JSONL 形制：{ts, op, ...} append-only + 1MB 轮转）；
//   本票只记 orphan/lifecycle 事件（route 事件 VO-004 增补）。
//
// createRegistry({ fleetPath, journalPath?, loopback })
//   loopback: async (method, payload) => value —— real.js rpc 同形制（注入；测试 mock）。
//
// Dual-chain wire (seatA-cut3-2, T0 探针裁决): dshWire() 把点号 method/payload 翻译成
// 目标链线形——dot(默认)=/api/<method> payload 原样(OLD dh1-slim, 逐字节现行为);
// DSH_WIRE=slash=/api/<ns>/<verb> + payload:{args:{request}} + 浏览器 cookie
// (NEW rebase 链; cookie 按 client-connection/browser-auth.ts 契约自铸, secret 读
// $DSH_HOME/.credentials.yaml 的 client-connection/browser-session, 铸败显式抛错)。
// liveSessionIds 的 loopback 若由宿主注入则透传不分派——本 helper 只服务缺省自给路径。

import { createHmac, createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { readFile, writeFile, rename, appendFile, mkdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'

// ── dual-chain wire helper（seatA-cut3-2；与 host-callback-bridge/loopback-sink.js 同契约）──

const B64U = (buf) => Buffer.from(buf).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
const B64U_DEC = (s) => Buffer.from(s.replaceAll('-', '+').replaceAll('_', '/'), 'base64')
/** 读 $DSH_HOME/.credentials.yaml 的 client-connection/browser-session secret（只读；零依赖缩进解析）。 */
function readWireSecret(home = process.env.DSH_HOME ?? `${homedir()}/.dsh`) {
  const file = `${home}/.credentials.yaml`
  if (!existsSync(file)) return undefined
  // 极简解析: 定位 client-connection/browser-session 块内 secret 行。
  const m = readFileSync(file, 'utf8').match(/client-connection\/browser-session:[\s\S]*?secret:\s*(\S+)/)
  return m?.[1]
}

/**
 * 按目标链铸造浏览器会话 cookie（browser-auth.ts 契约）：
 * name = dsh-auth-<b64url(sha256(authority))>；value = v1.<b64url(payload)>.<b64url(hmac)>，
 * payload = {version:1, authority, issuedAt, expiresAt}，HMAC-SHA256 key = b64url-decode(secret)。
 * 铸败（secret 缺失/形坏）显式抛错。
 */
function mintWireCookie(port, secretB64, now = Date.now()) {
  if (!secretB64) throw new Error('dshWire: browser-session secret unavailable in $DSH_HOME/.credentials.yaml')
  const secret = B64U_DEC(secretB64)
  if (secret.length !== 32) throw new Error(`dshWire: secret must decode to 32 bytes, got ${secret.length}`)
  const authority = `127.0.0.1:${port}`
  const payload = { version: 1, authority, issuedAt: now, expiresAt: now + 24 * 3600 * 1000 }
  const body = B64U(Buffer.from(JSON.stringify(payload), 'utf8'))
  const sig = createHmac('sha256', secret).update(body).digest()
  return `dsh-auth-${B64U(createHash('sha256').update(authority).digest())}=v1.${body}.${B64U(sig)}`
}

/**
 * 单点 wire 翻译：dot(默认) 逐字节现行为；DSH_WIRE=slash 走新链形。
 * @returns {path, body, headers}
 */
export function dshWire(method, payload, port) {
  if (process.env.DSH_WIRE !== 'slash') {
    return {
      path: `/api/${method}`,
      body: { type: 'client-request', rpcId: randomUUID(), method, payload },
      headers: { 'content-type': 'application/json' },
    }
  }
  const secret = readWireSecret()
  const cookie = mintWireCookie(port, secret)
  const [namespace, verb] = method.split('.')
  return {
    path: `/api/${namespace}/${verb}`,
    body: { type: 'client-request', rpcId: randomUUID(), method: `${namespace}/${verb}`, payload: { args: { request: payload ?? {} } } },
    headers: { 'content-type': 'application/json', cookie },
  }
}


/** fleet 扩展五键（VO-002 孵化侧写入；本模块读写面按此对账）。 */
export const FLEET_EXT_KEYS = ['role', 'project', 'mailbox', 'profile_version', 'spawned_at']

/**
 * 生命周期合法迁移表（KG 06 §1.6）。reattached 为 reattach 恢复态（§1.5），
 * 等效 ready：首次 agents/send 投递成功 → serving（VO-004）；显式退场 → retired。
 */
const LIFECYCLE = {
  spawn: ['arm'],
  arm: ['ready'],
  ready: ['serving'],
  serving: ['retired'],
  retired: [],
  reattached: ['serving', 'retired'],
}

const ROTATE_MAX_BYTES = 1024 * 1024 // 对齐 task-store 轮转阈值

export function createRegistry({ fleetPath, journalPath = join(dirname(fleetPath), 'router-journal.jsonl'), loopback }) {
  /** @type {Map<string, object>} 内存 agents 表（reattach/register 重建；fleet+journal 为持久面） */
  const agents = new Map()

  async function readFleet() {
    return JSON.parse(await readFile(fleetPath, 'utf8'))
  }

  /** 原子写（tmp+rename，形制对齐 profile-store/maestro fleet 写纪律）。 */
  async function writeFleet(fleet) {
    const tmp = `${fleetPath}.tmp-${process.pid}`
    await writeFile(tmp, JSON.stringify(fleet, null, 2) + '\n', 'utf8')
    await rename(tmp, fleetPath)
  }

  /** fleet 条目合并写（五键扩展，不破坏既有键）；unknown code 抛错。 */
  async function updateEntry(code, fields) {
    const fleet = await readFleet()
    const ent = (fleet.fleet ?? {})[code]
    if (!ent) throw new Error(`unknown fleet code: ${code}`)
    Object.assign(ent, fields)
    await writeFleet(fleet)
    return ent
  }

  async function journal(evt) {
    await mkdir(dirname(journalPath), { recursive: true })
    await appendFile(journalPath, JSON.stringify({ ts: Date.now(), ...evt }) + '\n')
    try {
      const s = await stat(journalPath)
      if (s.size > ROTATE_MAX_BYTES) {
        await rename(journalPath, journalPath + '.1')
      }
    } catch {
      // 轮转失败不致命（对齐 task-store）
    }
  }

  /** 内存表登记（spawn 入口 / reattach 恢复入口；VO-004 agents/registry 的状态源）。 */
  function register({ code, sessionId, mailbox = '', role = 'worker', project = '', state = 'spawn' }) {
    if (!LIFECYCLE[state]) throw new Error(`unknown state: ${state}`)
    const agent = { code, sessionId, mailbox, role, project, state, lastHeartbeat: null }
    agents.set(code, agent)
    return agent
  }

  /** 状态迁移；非法抛错（形制对齐 task-store：`illegal transition X → Y`）。
   * 退场（→retired）同步落 fleet.state（持久标记；profile 保留可复活，KG §1.6）。 */
  async function transition(code, to) {
    const agent = agents.get(code)
    if (!agent) throw new Error(`unknown agent: ${code}`)
    if (!LIFECYCLE[agent.state].includes(to)) {
      throw new Error(`illegal transition ${agent.state} → ${to}`)
    }
    const from = agent.state
    agent.state = to
    await journal({ op: 'lifecycle', code, from, to })
    if (to === 'retired') {
      const fleet = await readFleet()
      const ent = (fleet.fleet ?? {})[code]
      if (ent) {
        ent.state = 'retired'
        await writeFleet(fleet)
      }
    }
    return agent
  }

  /** loopback session.list → 存活 sessionId 集（router 侧唯一探活通道）。
   * 注入 loopback 时透传（测试 mock / 宿主定制）；缺省自给走 dshWire 双形态
   * （DSH_WIRE=slash 时打 NEW 链并自铸 cookie，seatA-cut3-2）。 */
  async function liveSessionIds() {
    if (loopback) {
      const value = await loopback('session.list', {})
      return new Set((value?.items ?? []).map((it) => it.sessionId))
    }
    const wire = dshWire('session.list', {}, process.env.DSH_PORT ?? 3080)
    const res = await fetch(`http://127.0.0.1:${process.env.DSH_PORT ?? 3080}${wire.path}`, {
      method: 'POST',
      headers: wire.headers,
      body: JSON.stringify(wire.body),
    })
    const data = await res.json()
    if (data?.result?.ok !== true) throw new Error(`session.list failed: ${JSON.stringify(data?.result?.error ?? res.status)}`)
    return new Set((data.result.value?.items ?? []).map((it) => it.sessionId))
  }

  /**
   * 启动恢复（KG §1.5 算法）：遍历 fleet 中 role≠worker 条目
   * （无 role 键 = VO-002 前老 worker 条目，跳过）。
   * 返回 { reattached:[code], orphans:[code] }。
   */
  async function reattach() {
    const live = await liveSessionIds()
    const reattached = []
    const orphans = []
    const fleet = await readFleet()
    let dirty = false
    for (const [code, ent] of Object.entries(fleet.fleet ?? {})) {
      const role = ent.role
      if (!role || role === 'worker') continue
      const sessionId = ent.sessionId ?? ''
      if (live.has(sessionId)) {
        agents.set(code, {
          code, sessionId,
          mailbox: ent.mailbox ?? '',
          role, project: ent.project ?? '',
          state: 'reattached', lastHeartbeat: null,
        })
        reattached.push(code)
      } else {
        ent.state = 'retired' // 孤儿：fleet 持久标记（既有键不动）
        dirty = true
        await journal({ op: 'orphan', code, sessionId })
        orphans.push(code)
      }
    }
    if (dirty) await writeFleet(fleet)
    return { reattached, orphans }
  }

  /**
   * 心跳（router 侧驱动，外部调用；本模块无任何定时器/自发轮询）：
   * loopback session.list 一次探活内存表 agents——
   *   alive → 更新 lastHeartbeat；state==='arm' → 晋 ready（§1.6 首次心跳）。
   *   dead  → 只报告不动状态（孤儿判定归 reattach / 显式 retire，不越权改态）。
   */
  async function heartbeat() {
    const live = await liveSessionIds()
    const alive = []
    const dead = []
    const promoted = []
    for (const agent of agents.values()) {
      if (agent.state === 'retired') continue
      if (live.has(agent.sessionId)) {
        agent.lastHeartbeat = Date.now()
        alive.push(agent.code)
        if (agent.state === 'arm') {
          await transition(agent.code, 'ready')
          promoted.push(agent.code)
        }
      } else {
        dead.push(agent.code)
      }
    }
    return { probed: agents.size, alive, dead, promoted }
  }

  function list() {
    return [...agents.values()].map((a) => ({ ...a }))
  }

  return {
    FLEET_EXT_KEYS,
    readFleet, writeFleet, updateEntry,
    register, transition, reattach, heartbeat, liveSessionIds,
    agents: list,
  }
}
