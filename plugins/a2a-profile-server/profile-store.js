//
// SPDX-License-Identifier: BSD 2-Clause License
//
// profile-store.js — 版本化 base profile 库（WS2 §4；docs/kg/02-ws2-a2a-profile.md）。
//
// 目录契约（每 profile 一个版本化目录）：
//   <root>/<name>/AGENTS.md        投影产物本体（三孵化共享同一份）
//   <root>/<name>/profile.json     场景 + 19 维 + 模板版本（可追溯，不进 prompt）
//   <root>/<name>/meta.json        孵化目标/血缘/版本/创建时间
//   <root>/<name>/history.jsonl    运行记录（孵化/重孵化/校验）
//   <root>/<name>/versions/<v>/…   旧版本归档（重投影才产生 v+1）
//
// 持久化语义：save() 同名增量 = 版本 +1 + 归档旧版；重孵化不产生新版本。
// 原子写纪律：tmp+rename（对齐 maestro session-spawn 的 fleet.json 原子写）。

import { mkdir, readFile, writeFile, readdir, appendFile, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const CURRENT_VERSION = 1

function nowIso() {
  return new Date().toISOString()
}

/**
 * createProfileStore(root) — root 为 profile 库根目录。
 * 返回 { save, get, list, recordRun, revalidate }；全部 Promise。
 */
export function createProfileStore(root) {
  const dirFor = (name) => join(root, name)

  async function ensureRoot() {
    await mkdir(root, { recursive: true })
  }

  async function readJson(path, fallback) {
    try {
      return JSON.parse(await readFile(path, 'utf8'))
    } catch {
      return fallback
    }
  }

  /**
   * save({ name, agentsMd, profile, targets, lineage }) -> { name, version, created }
   * 新名 → v1；同名 → 归档当前版到 versions/<v>/ 后写入 v+1。
   */
  async function save({ name, agentsMd, profile = {}, targets = [], lineage = {} }) {
    if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(name)) {
      throw new Error(`invalid profile name: ${name} (kebab-case, 2-64)`)
    }
    await ensureRoot()
    const dir = dirFor(name)
    const metaPath = join(dir, 'meta.json')
    const existing = await readJson(metaPath, null)
    const version = existing ? existing.version + 1 : CURRENT_VERSION

    if (existing) {
      const vdir = join(dir, 'versions', String(existing.version))
      await mkdir(vdir, { recursive: true })
      for (const f of ['AGENTS.md', 'profile.json', 'meta.json']) {
        const from = join(dir, f)
        if (existsSync(from)) await rename(from, join(vdir, f))
      }
    } else {
      await mkdir(dir, { recursive: true })
    }

    const meta = {
      name,
      version,
      targets,
      lineage, // { source_scenario_hash?, template? }
      created: existing ? existing.created : nowIso(),
      updated: nowIso(),
    }
    await atomicWrite(join(dir, 'AGENTS.md'), agentsMd)
    await atomicWrite(join(dir, 'profile.json'), JSON.stringify({ scenario: profile.scenario ?? '', vector19: profile.vector19 ?? {}, description: profile.description ?? '' }, null, 2))
    await atomicWrite(join(dir, 'meta.json'), JSON.stringify(meta, null, 2))
    await appendFile(join(dir, 'history.jsonl'), JSON.stringify({ ts: nowIso(), op: existing ? 'reproject' : 'create', version }) + '\n')
    return { name, version, created: meta.created }
  }

  /** get(name) -> { name, version, agentsMd, profile, meta, historyTail } | null */
  async function get(name) {
    const dir = dirFor(name)
    if (!existsSync(join(dir, 'meta.json'))) return null
    const meta = await readJson(join(dir, 'meta.json'), {})
    let agentsMd = ''
    try {
      agentsMd = await readFile(join(dir, 'AGENTS.md'), 'utf8')
    } catch {
      agentsMd = ''
    }
    const profile = await readJson(join(dir, 'profile.json'), {})
    const history = await readHistory(join(dir, 'history.jsonl'), 20)
    return { name, version: meta.version, agentsMd, profile, meta, historyTail: history }
  }

  /** list() -> [{ name, version, targets, updated, lineage }]（lineage 供消费面区分派生通道） */
  async function list() {
    await ensureRoot()
    let entries = []
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch {
      return []
    }
    const out = []
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const meta = await readJson(join(dirFor(e.name), 'meta.json'), null)
      if (meta) out.push({ name: meta.name, version: meta.version, targets: meta.targets ?? [], updated: meta.updated, lineage: meta.lineage ?? {} })
    }
    out.sort((a, b) => a.name.localeCompare(b.name))
    return out
  }

  /** recordRun(name, entry) — history.jsonl append（孵化/运行/校验记录）。 */
  async function recordRun(name, entry) {
    const path = join(dirFor(name), 'history.jsonl')
    await appendFile(path, JSON.stringify({ ts: nowIso(), ...entry }) + '\n')
  }

  /**
   * revalidate(name, gatesFn) — 重孵化前对 AGENTS.md 重跑质量门。
   * gatesFn: (agentsMd) => { passed, violations }（N3 三门注入）。
   */
  async function revalidate(name, gatesFn) {
    const p = await get(name)
    if (!p) return { drift: 'missing' }
    const report = gatesFn(p.agentsMd)
    await recordRun(name, { op: 'revalidate', version: p.version, drift: report.passed ? 'pass' : 'fail' })
    return { drift: report.passed ? 'pass' : 'fail', violations: report.violations ?? {} }
  }

  return { save, get, list, recordRun, revalidate, _dirFor: dirFor }
}

async function atomicWrite(path, content) {
  const tmp = path + '.tmp'
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, path)
}

async function readHistory(path, tail) {
  try {
    const text = await readFile(path, 'utf8')
    const lines = text.split('\n').filter(Boolean)
    return lines.slice(-tail).map((l) => JSON.parse(l))
  } catch {
    return []
  }
}
