//
// SPDX-License-Identifier: BSD 2-Clause License
//
// wire.js — dsh 回环双形态 wire 翻译单点（seatA-cut3-2；T0 探针裁决契约）。
//
// dot（默认，DSH_WIRE 非 'slash'）= OLD dh1-slim 链，逐字节现行为：
//   POST /api/<method>   payload 原样（client-request 信封）。
// slash（DSH_WIRE=slash）= NEW rebase/dh1-slim-on-master 链（T0 探针实测，无点号兼容层）：
//   POST /api/<ns>/<verb>   payload 包 {args:{request}}   method 字段同步斜杠名。
//   且全部 /api/* 过浏览器鉴权闸（client-connection）：cookie = dsh-auth-<b64u(sha256(authority))>
//   = v1.<b64u({version,authority,issuedAt,expiresAt})>.<b64u(hmac-sha256(secret,body))>，
//   secret = $DSH_HOME/.credentials.yaml records 下 client-connection/browser-session 的
//   base64url 32B secret（b64u-decode 后作 HMAC key）。铸败（缺文件/缺 key/长度≠32）显式抛错。
//
// 消费方：loopback-sink.js（session.list 预检 + session.cancel/session.prompt 投递）。
// a2a-profile-server/registry.js 有同契约独立副本（插件自包含纪律，禁跨插件 import）。
//
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const B64U = (buf) => Buffer.from(buf).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
const B64U_DEC = (s) => Buffer.from(s.replaceAll('-', '+').replaceAll('_', '/'), 'base64')

/** 读 $DSH_HOME/.credentials.yaml 的 browser-session secret（只读；零依赖缩进解析）。 */
export function readWireSecret(home = process.env.DSH_HOME ?? join(homedir(), '.dsh')) {
  const file = join(home, '.credentials.yaml')
  if (!existsSync(file)) return undefined
  const m = readFileSync(file, 'utf8').match(/client-connection\/browser-session:[\s\S]*?secret:\s*(\S+)/)
  return m?.[1]
}

/** 按目标链铸造浏览器会话 cookie；铸败（secret 缺失/形坏）显式抛错。 */
export function mintWireCookie(port, secretB64, now = Date.now()) {
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
 * 单点 wire 翻译：把点号 method/payload 映射为目标链的 {path, body, headers}。
 * @param {string} method 点号方法名（如 'session.list'）
 * @param {object|undefined} payload OLD 形态载荷（原样入 dot；包 args.request 入 slash）
 * @param {number|string} port 回环端口（cookie authority 组成）
 */
export function dshWire(method, payload, port) {
  if (process.env.DSH_WIRE !== 'slash') {
    return {
      path: `/api/${method}`,
      body: { type: 'client-request', rpcId: randomUUID(), method, payload },
      headers: { 'content-type': 'application/json' },
    }
  }
  const cookie = mintWireCookie(port, readWireSecret())
  const [namespace, verb] = method.split('.')
  return {
    path: `/api/${namespace}/${verb}`,
    body: { type: 'client-request', rpcId: randomUUID(), method: `${namespace}/${verb}`, payload: { args: { request: payload ?? {} } } },
    headers: { 'content-type': 'application/json', cookie },
  }
}
