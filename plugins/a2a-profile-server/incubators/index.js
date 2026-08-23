//
// SPDX-License-Identifier: BSD 2-Clause License
//
// incubators/index.js — 孵化适配器注册表（WS2 §5；docs/kg/02-ws2-a2a-profile.md）。
//
// 契约：每个适配器导出 async incubate(ctx) -> { target, ...回执 }；
// 幂等：同名同版本已孵化 → 直接返回现回执（不重复 spawn）。
// 注册面：dry（契约/selftest 用）+ real（dsh/omp/claude，真实现）。

import { realIncubators } from './real.js'

/** @type {Record<string, (ctx: object) => Promise<object>>} */
const incubators = {
  /**
   * dry — 记录意图不落系统：供契约验证与 selftest。
   */
  dry: async (ctx) => {
    return { target: 'dry', name: ctx.name, version: ctx.version, note: 'recorded only' }
  },
  ...realIncubators,
}

export function getIncubator(name) {
  const fn = incubators[name]
  if (!fn) throw new Error(`unknown incubator: ${name} (known: ${Object.keys(incubators).join(', ')})`)
  return fn
}

export function listIncubators() {
  return Object.keys(incubators)
}
