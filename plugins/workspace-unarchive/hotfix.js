// workspace-unarchive — session-scoped hotfix, mounts with every maestro session.
//
// Why: the RPC surface has workspace.archiveSession but no unarchive verb
// (api/workspace.ts: "a future unarchive restores its position"). Archived
// sessions disappear from the GUI sidebar with no way back — invisible and
// unhandleable. This plugin closes that gap live, in-process, through the
// same WorkspaceRegistry the archive verb itself uses.
//
// How: on mount, drains the spool file (one sessionId per line; ids not in
// the archive list are no-ops, so dupes/replays are safe), then watches it.
// The mutation rides the registry's enqueueOperation chain and performs the
// exact setState archiveSession performs: global.set(next) + memory refresh.
// The GUI picks the change up on the next workspace.list pull (refresh).
//
// Debug trail: every step appends to bridge/unarchive-debug.log — host stderr
// is not observable from inside, the file is.
import { watch } from 'node:fs'
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { homedir } from 'node:os'

export const version = '1.1.0'
export const name = 'workspace-unarchive'
export const inject = ['workspaceRegistry']

const ROOT = process.env.MAESTRO_HOME ?? `${homedir()}/.dsh`
const SPOOL = `${ROOT}/maestro/unarchive.log`
const DBG = `${ROOT}/maestro/unarchive-debug.log`

const dbg = (m) => {
  try { appendFileSync(DBG, `${new Date().toISOString()} ${m}\n`) } catch {}
}

export function apply(ctx) {
  dbg(`[${name} v${version}] apply() entered`)
  let reg = null
  try { reg = ctx.workspaceRegistry ?? null } catch (e) { dbg(`ctx.workspaceRegistry threw: ${e?.message ?? e}`) }
  if (!reg) { try { reg = ctx.get('workspaceRegistry') ?? null } catch (e) { dbg(`ctx.get threw: ${e?.message ?? e}`) } }
  dbg(`registry resolved: ${reg ? 'yes' : 'NO'}`)
  if (!reg || typeof reg.enqueueOperation !== 'function' || !reg.global) {
    dbg('registry unusable — giving up (spool lines stay pending for the next armed session)')
    return
  }
  try { mkdirSync(dirname(SPOOL), { recursive: true }) } catch {}
  try { statSync(SPOOL) } catch { try { writeFileSync(SPOOL, '') } catch {} }

  let offset = 0
  try { offset = statSync(SPOOL).size } catch {}

  async function unarchiveLine(id) {
    try {
      const verdict = await reg.enqueueOperation(async () => {
        const cur = reg.global.get()
        if (!cur || !Array.isArray(cur.archivedSessionIds)) return 'no-state'
        if (!cur.archivedSessionIds.includes(id)) return 'noop(not-archived)'
        const next = { ...cur, archivedSessionIds: cur.archivedSessionIds.filter((x) => x !== id) }
        await reg.global.set(next)
        reg.state = next
        return 'UNARCHIVED'
      })
      dbg(`${id} -> ${verdict}`)
    } catch (error) {
      dbg(`${id} -> error: ${error?.message ?? String(error)}`)
    }
  }

  function drain() {
    try {
      const text = readFileSync(SPOOL, 'utf8')
      const lastNl = text.lastIndexOf('\n')
      if (lastNl + 1 <= offset) return
      const chunk = text.slice(offset, lastNl + 1)
      offset = lastNl + 1
      for (const raw of chunk.split('\n')) {
        const id = raw.trim()
        if (id) void unarchiveLine(id)
      }
    } catch (error) {
      dbg(`drain error: ${error?.message ?? String(error)}`)
    }
  }

  let watcher = null
  let stopped = false
  const arm = () => {
    if (stopped) return
    try {
      watcher = watch(SPOOL, { persistent: false }, (event) => {
        if (event === 'change') setTimeout(drain, 60)
      })
      watcher.on('error', () => { if (!stopped) setTimeout(arm, 1000) })
    } catch {
      if (!stopped) setTimeout(arm, 1000)
    }
  }
  arm()
  drain()
  ctx.effect(() => () => { stopped = true; try { watcher?.close() } catch {} })
  dbg(`armed; spool=${SPOOL} offset=${offset}`)
}
