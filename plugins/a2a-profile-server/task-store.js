//
// SPDX-License-Identifier: BSD 2-Clause License
//
// task-store.js — A2A task 表（内部契约最小子集；docs/kg/02-ws2-a2a-profile.md §3）。
//
// 状态机：submitted → working ─┬→ completed（artifacts=[{type:"done-body", content}]）
//                              ├→ failed（error）
//                              └→ canceled
// 持久化：JSONL append-only journal；启动重放重建内存表（崩溃恢复）。

import { appendFile, readFile, mkdir, rename, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

const TERMINAL_STATES = new Set(['completed', 'failed', 'canceled'])
const LEGAL = {
  submitted: ['working', 'canceled', 'failed'],
  working: ['completed', 'failed', 'canceled'],
}

const ROTATE_MAX_BYTES = 1024 * 1024

/**
 * createTaskStore(journalPath) — 返回 { create, transition, get, all }。
 */
export function createTaskStore(journalPath) {
  /** @type {Map<string, object>} */
  const tasks = new Map()
  let replayed = false

  async function replay() {
    if (replayed) return
    replayed = true
    if (!existsSync(journalPath)) return
    const text = await readFile(journalPath, 'utf8')
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        applyEvent(JSON.parse(line))
      } catch {
        // malformed journal 行跳过（截断尾部容忍）
      }
    }
  }

  function applyEvent(evt) {
    if (evt.op === 'create') {
      tasks.set(evt.task.id, evt.task)
    } else if (evt.op === 'transition') {
      const t = tasks.get(evt.id)
      if (t && !TERMINAL_STATES.has(t.state)) {
        Object.assign(t, evt.patch)
      }
    }
  }

  async function journal(evt) {
    await mkdir(dirname(journalPath), { recursive: true })
    await appendFile(journalPath, JSON.stringify(evt) + '\n')
    try {
      const s = await stat(journalPath)
      if (s.size > ROTATE_MAX_BYTES) {
        await rename(journalPath, journalPath + '.1')
      }
    } catch {
      // 轮转失败不致命
    }
  }

  /** create({ intent, ref, source }) -> task（submitted 态）。 */
  async function create({ intent, ref = '-', source = 'unknown' }) {
    await replay()
    const task = {
      id: 't_' + randomUUID().slice(0, 8),
      state: 'submitted',
      intent,
      ref,
      source,
      created_at: Date.now(),
      artifacts: [],
      error: null,
    }
    tasks.set(task.id, task)
    await journal({ ts: Date.now(), op: 'create', task })
    return task
  }

  /** transition(id, patch) -> task；非法迁移抛错（防倒退/重复终态）。 */
  async function transition(id, patch) {
    await replay()
    const t = tasks.get(id)
    if (!t) throw new Error(`unknown task: ${id}`)
    if (TERMINAL_STATES.has(t.state)) throw new Error(`task ${id} already terminal: ${t.state}`)
    const next = patch.state
    if (next && !LEGAL[t.state].includes(next)) {
      throw new Error(`illegal transition ${t.state} → ${next}`)
    }
    Object.assign(t, patch)
    await journal({ ts: Date.now(), op: 'transition', id, patch })
    return t
  }

  /** get(id) -> 公开视图（不含 intent 内文，防泄漏给无关查询方）。 */
  async function get(id) {
    await replay()
    const t = tasks.get(id)
    if (!t) return null
    return publicView(t)
  }

  async function all() {
    await replay()
    return [...tasks.values()].map(publicView)
  }

  function publicView(t) {
    return { id: t.id, state: t.state, artifacts: t.artifacts, error: t.error, ref: t.ref }
  }

  return { create, transition, get, all }
}
