//
// SPDX-License-Identifier: BSD 2-Clause License
//
// executors/dais.js — 执行桥完整版：message/send 进来的 intent 转投 dais 编排总线，
// 在 head 自己的邮箱（收件人语义、读即消费，live 实测 2026-08-23）等 done 回信。
// 序列与 python 侧 DaisLane/DshBackend 对齐（docs/kg/01-ws1-head-dsh.md §2/§5）：
//   create-run → send-message(head→orch, [ref:] 前缀) → 轮询 check-messages(head 邮箱)
//   过滤：seq > intentSeq 且 from === orchestratorHandle（防自匹配发出的 intent）。
// 产物 content = 去掉 [ref:] 前缀的 done body（不带 "Agent Final Message" 前缀，
// 终稿前缀统一由 head 侧拼接）。

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const HEADER_RE = /^---\s*seq\s+(\d+)\s+from\s+(\S+)\s+\[([^\]]+)\](?:\s+(.*?))?\s*---$/
const KV_RE = /^seq[=: ]+(\d+)\s+from[=: ]+(\S+)\s+to[=: ]+(\S+)\s+type[=: ]+(\S+)(?:\s+body[=: ]?(.*))?$/

/** 解析 check-messages 输出（live 两行式 + mock kv + json 行），与 rt_dsh_lane._parse_message_rows 对齐。 */
export function parseMailbox(out) {
  const rows = []
  let pending = null
  const flush = () => {
    if (pending) {
      pending.body = pending.lines.join('\n').trim()
      delete pending.lines
      rows.push(pending)
      pending = null
    }
  }
  for (const raw of out.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('{')) {
      try {
        const obj = JSON.parse(line)
        if (obj && typeof obj === 'object' && ('body' in obj || 'type' in obj)) {
          flush()
          rows.push(obj)
          continue
        }
      } catch {
        // 非 JSON 行落到下面的风味解析。
      }
    }
    const header = line.match(HEADER_RE)
    if (header) {
      flush()
      pending = { seq: Number(header[1]), from: header[2], to: '', type: header[3], subject: (header[4] ?? '').trim(), lines: [] }
      continue
    }
    if (line.startsWith('no unread messages')) {
      flush()
      continue
    }
    if (pending) {
      pending.lines.push(line)
      continue
    }
    const kv = line.match(KV_RE)
    if (kv) {
      rows.push({ seq: Number(kv[1]), from: kv[2], to: kv[3], type: kv[4], body: (kv[5] ?? '').trim() })
    }
  }
  flush()
  return rows
}

const defaultRun = (binary) => (argv) =>
  execFileAsync(binary, ['orchestration', ...argv], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }).then(
    (r) => ({ stdout: r.stdout, stderr: r.stderr }),
  )

/**
 * createDaisExecutor(tasks, opts)
 * opts: { binary, orchestratorHandle, headHandle='voice-head', pollMs=1500,
 *         timeoutMs=600000, run? }   run(argv) -> {stdout, stderr}（可注入测试）。
 */
export function createDaisExecutor(tasks, opts = {}) {
  const {
    binary = process.env.DAIS_BIN ?? `${process.env.HOME}/.local/bin/dais`,
    orchestratorHandle = process.env.DAIS_ORCHESTRATOR_HANDLE ?? '',
    headHandle = 'voice-head',
    pollMs = 1500,
    timeoutMs = 600_000,
    run = null,
  } = opts
  const doRun = run ?? defaultRun(binary)

  return async (task) => {
    const ref = task.ref && task.ref !== '-' ? task.ref : `vh-a2a-${String(task.id).slice(-8)}`
    await tasks.transition(task.id, { state: 'working' })

    const created = await doRun(['create-run', '--objective', `[voice-head-a2a] ${String(task.intent).slice(0, 200)}`])
    const runId = (created.stdout.match(/run_[0-9a-f]+/) ?? [])[0]
    if (!runId) throw new Error(`no run id in create-run output: ${created.stdout.slice(0, 120)}`)

    let intentSeq = -1
    if (orchestratorHandle) {
      const sent = await doRun([
        'send-message', runId, headHandle, orchestratorHandle,
        '--message-type', 'status', '--subject', 'intent',
        '--body', `[ref:${ref}] ${task.intent}`,
      ])
      intentSeq = Number((sent.stdout.match(/seq[=: ]+(\d+)/) ?? [])[1] ?? -1)
    } else {
      await doRun(['create-task', runId, String(task.intent).slice(0, 2000)])
    }

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      // Bounded poll: a flagless check-messages blocks FOREVER on an empty
      // mailbox and holds the bus lock (live-probed 2026-08-23); --timeout-ms
      // bounds it, reads consume, and unread persists across polls.
      const checked = await doRun([
        'check-messages', headHandle, '--timeout-ms', String(Math.min(pollMs, 2000)),
      ])
      const reply = parseMailbox(checked.stdout).find(
        (row) =>
          String(row.body ?? '').includes(`[ref:${ref}]`) &&
          row.seq > intentSeq &&
          (!orchestratorHandle || row.from === orchestratorHandle),
      )
      if (reply) {
        const content = String(reply.body).replace(`[ref:${ref}]`, '').trim()
        await tasks.transition(task.id, {
          state: 'completed',
          artifacts: [{ type: 'done-body', content }],
        })
        return
      }
      await new Promise((r) => setTimeout(r, pollMs))
    }
    throw new Error(`no done reply for ref ${ref} within ${timeoutMs}ms`)
  }
}
