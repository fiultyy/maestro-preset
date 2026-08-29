// pm-host-service — P0 shell + self-bootstrapping systemd user unit.
//
// PM-001 (this entry): bootstrap + idempotent unit lifecycle. PM-002 (same
// package, service.mjs): HTTP projection skeleton — random 127.0.0.1 port,
// pm.port JSON port file (idempotency key: its path), pm.token placeholder
// doc (0600), flock(2) single instance. Read-side projector for the maestro
// plane (ADR-002); apply() runs the ADR-003 pattern-iii bootstrap: render the
// in-package unit template and hand the lifecycle to systemd, so the service
// is boot-resident and outlives any dsh session.
//
// Idempotency (ADR-007, key `pm-host-service@<MAESTRO_HOME>`) — every side
// effect states its replay strategy:
//   log dir  mkdir -p $MAESTRO_HOME/maestro/logs/pm-host-service
//                                                   present -> no-op
//   unit     render template -> ~/.config/systemd/user/pm-host-service.service
//                                     temp+rename; byte-identical -> skip
//   enable   systemctl --user enable --now
//                                     already enabled -> skip (repair `start`
//                                     only when enabled yet inactive; that
//                                     branch never fires on the happy replay
//                                     path -> second apply is zero-change)
// `daemon-reload` runs only when the unit was actually (re)written. Run state
// is systemd's; on-disk state is the unit + append-only logs (ADR-007.2:
// files by default, SQLite only when R1/R3 fire — not on this ticket).
//
// Gate (spec §PM-001, whole gate green twice): is-active=active; kill MainPID
// -> Restart=on-failure pulls it back within 10s; repeat apply -> zero
// changes. Standalone check:
//   node -e 'import(process.argv[1]).then(m=>console.log(JSON.stringify(m.apply({}),null,2)))' <abs>/index.js
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const version = '0.8.0'
export const name = 'pm-host-service'
export const inject = [] // the shell needs no host services (PM-002+ may extend)

const PKG_DIR = dirname(fileURLToPath(import.meta.url))
const SERVICE = 'pm-host-service'
const ROOT = process.env.MAESTRO_HOME ?? `${homedir()}/.dsh`
const LOG_DIR = process.env.PM_HOST_SERVICE_LOG_DIR ?? `${ROOT}/maestro/logs/${SERVICE}`
const CONFIG_DIR = process.env.XDG_CONFIG_HOME ?? `${homedir()}/.config`
const UNIT_PATH = `${CONFIG_DIR}/systemd/user/${SERVICE}.service`
const LOCK_PATH = `${ROOT}/maestro/${SERVICE}.lock` // flock(2) single-instance anchor

// PM-002: single instance via flock(2), held IN-DAEMON (service.mjs opens
// the lock file and binds the lock to its own open-file description). The
// unit's ExecStart stays plain node on purpose: a flock(1) wrapper would
// become MainPID, and a MainPID dying by signal is restart-exempt under
// Restart=on-failure — which silently broke the kill->pull-back gate.
function resolveFlock() {
  if (process.env.PM_HOST_SERVICE_FLOCK) return process.env.PM_HOST_SERVICE_FLOCK
  for (const p of ['/usr/bin/flock', '/bin/flock']) {
    try { if (statSync(p).isFile()) return p } catch {}
  }
  return null
}

const sc = (args) => {
  const r = spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8' })
  if (r.error) return { ok: false, out: '', err: r.error.message }
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }
}

function renderUnit() {
  const entry = join(PKG_DIR, 'service.mjs')
  // Plain node ExecStart — the daemon is MainPID; locking is in-daemon.
  const exec = `${process.execPath} ${entry}`
  return readFileSync(join(PKG_DIR, `${SERVICE}.service.template`), 'utf8')
    .replaceAll('{{EXEC}}', exec)
    .replaceAll('{{LOCK}}', LOCK_PATH)
    .replaceAll('{{PKG_DIR}}', PKG_DIR)
    .replaceAll('{{MAESTRO_HOME}}', ROOT)
    .replaceAll('{{LOG_DIR}}', LOG_DIR)
}

function writeUnitIfChanged(rendered) {
  let current = null
  try { current = readFileSync(UNIT_PATH, 'utf8') } catch {}
  if (current === rendered) return 'skip: identical'
  mkdirSync(dirname(UNIT_PATH), { recursive: true })
  const tmp = `${UNIT_PATH}.tmp.${process.pid}`
  try {
    writeFileSync(tmp, rendered, { mode: 0o644 })
    renameSync(tmp, UNIT_PATH) // same-directory rename = atomic replace
    return 'write: temp+rename'
  } catch (e) {
    try { unlinkSync(tmp) } catch {}
    throw e
  }
}

// dsh plugin entry. ctx is unused by the shell (inject: []) — bootstrap must
// work identically whether dsh loads it or a human runs the standalone check.
export function apply(ctx) {
  void ctx
  const report = { service: SERVICE, key: `${SERVICE}@${ROOT}`, ok: false, logDir: '', unit: '', enable: '', active: '', pid: 0, lock: LOCK_PATH, flock: resolveFlock() ? 'in-daemon' : 'unavailable' }
  try {
    mkdirSync(LOG_DIR, { recursive: true }) // side effect ③: idempotent mkdir
    report.logDir = 'ok'

    report.unit = writeUnitIfChanged(renderUnit()) // side effect ①
    if (report.unit !== 'skip: identical') {
      sc(['daemon-reload'])
      const rs = sc(['try-restart', SERVICE]) // a rewritten exec line must not keep the stale process serving
      if (report.unit === 'write: temp+rename') report.unit += rs.ok ? ' + try-restart' : ` + try-restart FAILED (${rs.err || rs.out})`
    }

    const en = sc(['is-enabled', SERVICE]) // side effect ②
    if (/^enabled/.test(en.out)) {
      report.enable = 'skip: already enabled'
      if (sc(['is-active', SERVICE]).out !== 'active') {
        const up = sc(['start', SERVICE])
        report.enable += up.ok ? ' + repair-start' : ` + repair-start FAILED (${up.err || up.out})`
      }
    } else {
      const up = sc(['enable', '--now', SERVICE])
      report.enable = up.ok ? 'enable --now: ok' : `enable --now FAILED: ${up.err || up.out}`
    }

    report.active = sc(['is-active', SERVICE]).out || 'unknown'
    report.pid = Number(sc(['show', '-p', 'MainPID', '--value', SERVICE]).out) || 0
    report.ok = report.active === 'active' && !report.enable.includes('FAILED')
  } catch (e) {
    report.error = e?.message ?? String(e) // never throw into the host boot path
  }
  return report
}
