// session-purge — on-demand session deletion, exposed as a method for agents.
//
// NOT a watcher, NOT automatic. Mounts with every maestro session and serves
// POST /purge on 127.0.0.1:<random> (port -> ~/.dsh/maestro/purge.port).
// Nothing happens until an agent explicitly calls it with a confirm token.
//
// Why: the RPC surface ends at archiveSession — no session.delete exists
// (46 methods; the only delete is workspace.delete). Unwanted sessions could
// only be hidden, never removed. This closes the lifecycle, on demand.
//
// Contract (POST /purge, application/json):
//   {"sessionId": "...", "confirm": "PURGE"}   — or {"code": "d33e"} (fleet.json)
// Guards:
//   - confirm must be exactly "PURGE"            -> 403 otherwise
//   - the carrier session's own id is refused    -> 403 self-purge
//   - event log grown within the last 5 minutes  -> 409 busy (settle first;
//     purging under a running turn may recreate files beneath you)
// Surgery (registry operation order, then disk):
//   1. global.archivedSessionIds + every workspace record's sessionIds slot (KvTable.put)
//   2. registry in-memory header/path indexes
//   3. sessions/<bucket>/<sessionId>/ directory (bucket discovered by scan)
//   4. session_projcache.json keys mentioning the id (best effort)
// Audit trail: every verdict lands in maestro/unarchive-debug.log.
import { createServer } from 'node:http'
import { appendFileSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'

export const version = '1.0.0'
export const name = 'session-purge'
export const inject = ['workspaceRegistry']

const ROOT = process.env.MAESTRO_HOME ?? `${homedir()}/.dsh`
const PORT_FILE = `${ROOT}/maestro/purge.port`
const DBG = `${ROOT}/maestro/unarchive-debug.log`
const SELF = process.env.DSH_SESSION_ID ?? null

const dbg = (m) => { try { appendFileSync(DBG, `${new Date().toISOString()} [session-purge] ${m}\n`) } catch {} }

function findSessionDir(sid) {
  const base = `${ROOT}/sessions`
  try {
    for (const bucket of readdirSync(base)) {
      const cand = `${base}/${bucket}/${sid}`
      try { if (statSync(cand).isDirectory()) return cand } catch {}
    }
  } catch {}
  return null
}

function lastWriteMs(dir) {
  let newest = 0
  try {
    newest = statSync(dir).mtimeMs
    for (const f of readdirSync(dir)) {
      try { newest = Math.max(newest, statSync(`${dir}/${f}`).mtimeMs) } catch {}
    }
  } catch {}
  return newest
}

export function apply(ctx) {
  const reg = ctx.workspaceRegistry
  if (!reg || typeof reg.enqueueOperation !== 'function' || !reg.global) {
    dbg('registry unusable — plugin inert')
    return
  }
  const server = createServer((req, res) => {
    const json = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(obj))
    }
    if (req.method !== 'POST' || req.url !== '/purge') return json(404, { error: 'not found' })
    let body = ''
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy() })
    req.on('end', async () => {
      let msg
      try { msg = JSON.parse(body) } catch { return json(400, { error: 'bad json' }) }
      if (msg.confirm !== 'PURGE') return json(403, { error: 'confirm must be "PURGE"' })
      let sid = typeof msg.sessionId === 'string' ? msg.sessionId : null
      if (!sid && typeof msg.code === 'string') {
        try { sid = JSON.parse(readFileSync(`${ROOT}/maestro/fleet.json`, 'utf8')).fleet?.[msg.code]?.sessionId ?? null } catch {}
      }
      if (!sid || !sid.startsWith('session-')) return json(400, { error: 'sessionId or fleet code required' })
      if (sid === SELF) return json(403, { error: 'self-purge refused' })
      const dir0 = findSessionDir(sid)
      if (dir0 && Date.now() - lastWriteMs(dir0) < 5 * 60_000) {
        return json(409, { error: 'busy: event log written within 5 minutes — settle first' })
      }
      const verdict = { sid, steps: {} }
      try {
        const out = await reg.enqueueOperation(async () => {
          const cur = reg.global.get()
          const next = { ...cur, archivedSessionIds: (cur.archivedSessionIds ?? []).filter((x) => x !== sid) }
          let touched = 0
          for (const key of reg.table.keys()) {
            const rec = reg.table.get(key)
            if (rec && Array.isArray(rec.sessionIds) && rec.sessionIds.includes(sid)) {
              await reg.table.put(key, { ...rec, sessionIds: rec.sessionIds.filter((x) => x !== sid) })
              touched++
            }
          }
          await reg.global.set(next)
          reg.state = next
          reg.headers.delete(sid)
          reg.sessionPaths.delete(sid)
          reg.invalidSessionPaths.delete(sid)
          return touched
        })
        verdict.steps.registry = `ok (${out} workspace slot(s))`
      } catch (error) {
        verdict.steps.registry = `error: ${error?.message ?? String(error)}`
        dbg(`FAILED ${sid}: ${verdict.steps.registry}`)
        return json(500, verdict)
      }
      const dir = dir0
      if (dir) {
        try { rmSync(dir, { recursive: true, force: true }); verdict.steps.disk = `rm ok` }
        catch (error) { verdict.steps.disk = `error: ${error?.message ?? String(error)}` }
      } else verdict.steps.disk = 'no dir (already gone?)'
      try {
        const pc = `${ROOT}/storages/session_projcache.json`
        const cache = JSON.parse(readFileSync(pc, 'utf8'))
        const before = JSON.stringify(cache)
        for (const k of Object.keys(cache)) if (String(k).includes(sid)) delete cache[k]
        if (JSON.stringify(cache) !== before) writeFileSync(pc, JSON.stringify(cache))
        verdict.steps.projcache = 'ok'
      } catch (error) { verdict.steps.projcache = `skipped: ${error?.message ?? String(error)}` }
      dbg(`PURGED ${sid}: ${JSON.stringify(verdict.steps)}`)
      json(200, verdict)
    })
  })
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address()
    try { writeFileSync(PORT_FILE, String(port)) } catch (e) { dbg(`port file write failed: ${e?.message}`) }
    dbg(`armed on 127.0.0.1:${port} (self=${SELF ?? '?'})`)
  })
  ctx.effect(() => () => { try { server.close() } catch {} })
}
