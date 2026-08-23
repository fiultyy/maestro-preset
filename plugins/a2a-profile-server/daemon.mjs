#!/usr/bin/env node
//
// SPDX-License-Identifier: BSD 2-Clause License
//
// daemon.mjs — a2a-profile-server 独立守护入口（N10-T4 · parent 指令③ daemon 存活口径）。
//
// 用法：nohup node ~/.dsh/plugins/a2a-profile-server/daemon.mjs >/dev/null 2>&1 &
//   端口：A2A_PROFILE_PORT（缺省 8790）；profile 库：A2A_PROFILE_ROOT（缺省 ~/.dsh/profiles/incubated）
//   日志：<stateDir>/plugin.log（activate 内置）+ 本进程 stdout。
// 停止：kill $(pgrep -f 'a2a-profile-server/daemon.mjs')
//
import { activate } from './index.js'

const h = await activate({})
console.log(`[${new Date().toISOString()}] a2a-profile-server daemon:`, JSON.stringify(h.status()))
setInterval(() => {}, 1 << 30) // 常驻（无定时器语义，仅保事件循环）
