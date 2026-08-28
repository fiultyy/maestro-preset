#!/usr/bin/env node
// pm-host-service daemon (PM-001 shell) — ExecStart target of the user unit.
//
// Scope: stay alive and prove liveness; nothing else. The read-side HTTP
// projector is PM-002..009 — this process only anchors systemd's
// Restart=on-failure so the kill->pull-back gate has something to restart,
// and keeps an append-only heartbeat (ADR-007.2: file storage by default).
//
// Exit discipline: systemd counts SIGTERM/SIGINT as CLEAN termination, so a
// bare `kill <pid>` under Restart=on-failure would NOT be restarted. The
// shell converts both signals into a non-zero exit: `systemctl stop` still
// stays stopped (an active stop job suppresses Restart=), while an
// unsupervised kill is pulled back within RestartSec=2.
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'

const ROOT = process.env.MAESTRO_HOME ?? `${homedir()}/.dsh`
const LOG_DIR = process.env.PM_HOST_SERVICE_LOG_DIR ?? `${ROOT}/maestro/logs/pm-host-service`
const LOG = `${LOG_DIR}/daemon.log`

mkdirSync(LOG_DIR, { recursive: true }) // idempotent; mirrors side effect ③ in-daemon

function log(msg) {
  try {
    try { if (statSync(LOG).size > 2_000_000) renameSync(LOG, `${LOG}.1`) } catch {}
    appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`)
  } catch {}
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { log(`${sig} -> exit 1 (Restart=on-failure pulls back)`); process.exit(1) })
}

log(`daemon up pid=${process.pid} node=${process.version} root=${ROOT}`)
setInterval(() => log(`heartbeat pid=${process.pid}`), 60_000) // keeps the loop alive
