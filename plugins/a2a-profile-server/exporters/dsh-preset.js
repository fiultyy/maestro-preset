//
// SPDX-License-Identifier: BSD 2-Clause License
//
// exporters/dsh-preset.js — dsh 预设导出器（N10-T3 · OF-013；docs/10 §2「dsh 格式导出」）。
//
// 池 profile（profiles.get 产物）→ ~/.dsh/.agent-presets/<name>/（preset.yml + agent.cordis.yml
// + maestro 资产软链）。落目录即刻进 GUI 新会话屏（roster 实时扫描，trust=user，零 UI 改动）。
//
// 导出四硬规则（docs/10 §2 源码级契约核对；违反=静默失败或运行期炸）：
//   ① id slug：目录名必须 ^[a-z0-9][a-z0-9-]*$（不符则 discovery 静默跳过）→ 落盘前断言；
//   ② `{{` 消毒：persona 文本严格插值，未知/畸形 {{x}} 首 model step 即 throw
//     → agentsMd 嵌入前断言（fail-loud 不静默改写；上游 wizard/projector 负责消毒）；
//   ③ 生成行纯 YAML：模板全文字节保真透传（!!js 平台条件行、group/isolate realm、注释
//     一律原文，不 parse 不重序列化），唯一改写 = persona text 块内容整体替换为 agentsMd
//     （按模板 text 块同等缩进逐行缩进）；
//   ④ preset.yml 仅 {name, description, order?} 显式键纯 YAML。
//
// 目录级原子落位：先写 <name>.tmp-<pid>/ 两文件+软链，再 rename 为 <name>/
// （只写 preset.yml 缺 agent.cordis.yml 的目录会被 discovery 标 broken——"directory
// still occupies the id"）；已存在且 force 时先 rename 旧目录到 <name>.old-<ts> 再就位。

import { mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync, lstatSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 硬规则①：dsh discovery 的 id slug（profile-store 已保证 kebab，此处防御断言）。 */
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/

/** maestro 资产面（README.md 不带——那是仓库说明，非预设运行资产）。 */
const ASSET_ENTRIES = ['skills', 'bin', 'plugins', 'shared', 'docs']

// 调用时求值（env 可覆写，selftest 注入临时目录用）；缺省与现网部署点一致
const presetsDirOf = (opt) => opt ?? process.env.A2A_PRESETS_DIR ?? join(homedir(), '.dsh/.agent-presets')
const templatePathOf = (opt) => opt ?? process.env.A2A_PRESET_TEMPLATE ?? join(homedir(), '.dsh/.agent-presets/maestro/agent.cordis.yml')

/**
 * 一句话派生（preset.yml name/description 用）：首非空行截到首个句末标点（含标点）。
 * 空描述 → ''（调用方回退 profile.name）。
 */
function firstSentence(text) {
  const firstLine = String(text ?? '').split('\n').map((s) => s.trim()).find((l) => l.length > 0) ?? ''
  if (!firstLine) return ''
  const m = firstLine.match(/^[^。．!?!?]*(?:[。．!?!?]|$)/)
  return (m ? m[0] : firstLine).trim()
}

/**
 * 纯 YAML 标量发射（硬规则③④：生成行零 !!js 等方言标签）。
 * 安全则 plain（与 maestro preset.yml 形制一致），否则双引号转义（JSON 转义 ⊂ YAML 双引号方言）。
 */
function yamlScalar(value) {
  const s = String(value)
  if (s && !/^\s|\s$/.test(s)
    && !/^[-?:,[\]{}#&*!|>'"%@`]/.test(s)
    && !s.includes(': ') && !s.endsWith(':') && !s.includes(' #')
    && !/[\x00-\x1f\x7f]/.test(s)) {
    return s
  }
  return JSON.stringify(s)
}

/**
 * persona 块内嵌（硬规则③唯一改写点）：模板行级手术，块外逐字节保真。
 *   persona 块 = /^- id: persona$/ 起，到下一个 /^- id: / 或 /^  name: cordis:group/ 前；
 *   块内保留头行（id/name/config）与 '    text: |-' 行，text 内容行整体替换为 agentsMd
 *   （缩进 = 模板 text 块首个非空内容行的前导空白，空行保持空行——|-' 的 strip 语义下
 *   可逐字节还原：提取内容行、去同宽缩进、去尾部空行即得原文）。
 */
function embedPersona(templateText, agentsMd) {
  const lines = templateText.split('\n')
  const personaIdx = lines.findIndex((l) => /^- id: persona$/.test(l))
  if (personaIdx < 0) throw new Error('template persona block not found (^- id: persona$)')

  let endIdx = lines.length
  for (let i = personaIdx + 1; i < lines.length; i++) {
    if (/^- id: /.test(lines[i]) || /^ {2}name: cordis:group/.test(lines[i])) { endIdx = i; break }
  }
  let textIdx = -1
  for (let i = personaIdx + 1; i < endIdx; i++) {
    if (/^\s+text: \|-\s*$/.test(lines[i])) { textIdx = i; break }
  }
  if (textIdx < 0) throw new Error('persona text block not found ("text: |-")')

  let contentIndent = ''
  let lastContentIdx = textIdx
  for (let i = textIdx + 1; i < endIdx; i++) {
    if (lines[i].trim()) {
      if (!contentIndent) contentIndent = lines[i].match(/^\s*/)[0]
      lastContentIdx = i
    }
  }
  if (!contentIndent) throw new Error('persona text block has no content line to derive indent from')

  const core = agentsMd.endsWith('\n') ? agentsMd.slice(0, -1) : agentsMd
  const embedded = core.split('\n').map((l) => (l === '' ? '' : contentIndent + l))
  return [...lines.slice(0, textIdx + 1), ...embedded, ...lines.slice(lastContentIdx + 1)].join('\n')
}

/**
 * exportDshPreset({ profile, presetsDir?, templatePath?, assetsFrom?, force?, order? })
 *   profile     profiles.get 产物（{ name, version, agentsMd, profile:{description,...} }）
 *   presetsDir  缺省 env A2A_PRESETS_DIR 否则 ~/.dsh/.agent-presets
 *   templatePath 缺省 env A2A_PRESET_TEMPLATE 否则 <presetsDir 缺省>/maestro/agent.cordis.yml
 *   assetsFrom  缺省 templatePath 的目录（maestro 资产软链源）
 *   force       目标目录已存在时覆盖（旧目录 rename 为 <name>.old-<ts>）
 *   order       preset.yml 可选排序键（整数；缺省不写——硬规则④「仅显式键」）
 * -> { target:'dsh-preset', name, version, dir, presetYml, cordisYml, assets:[...] }
 */
export async function exportDshPreset({ profile, presetsDir, templatePath, assetsFrom, force = false, order } = {}) {
  if (!profile || typeof profile !== 'object') throw new Error('profile required (profiles.get result)')
  const name = profile.name
  if (typeof name !== 'string' || !SLUG_RE.test(name)) {
    throw new Error(`invalid preset id (hard rule #1 slug ^[a-z0-9][a-z0-9-]*$): ${JSON.stringify(name)}`)
  }
  const version = profile.version
  const agentsMd = typeof profile.agentsMd === 'string' ? profile.agentsMd : ''
  // 硬规则②：嵌入前断言（fail-loud；先于一切落盘动作）
  if (agentsMd.includes('{{')) {
    throw new Error(`agentsMd contains '{{' (hard rule #2 interpolation poison): ${name}`)
  }
  if (order !== undefined && (!Number.isInteger(order) || order < 0)) {
    throw new Error(`invalid order (non-negative integer): ${order}`)
  }

  const presets = presetsDirOf(presetsDir)
  const template = templatePathOf(templatePath)
  const assetsRoot = assetsFrom ?? dirname(template)

  const templateText = await readFile(template, 'utf8')
  const cordisYml = embedPersona(templateText, agentsMd)

  // preset.yml（硬规则④）：name = description 一句话派生，空则回退 profile.name；order 仅显式传入才写
  const sentence = firstSentence(profile.profile?.description)
  const displayName = sentence || name
  const displayDescription = sentence || name
  const presetLines = [
    `name: ${yamlScalar(displayName)}`,
    `description: ${yamlScalar(displayDescription)}`,
  ]
  if (order !== undefined) presetLines.push(`order: ${order}`)
  const presetYml = presetLines.join('\n') + '\n'

  await mkdir(presets, { recursive: true })
  const target = join(presets, name)
  if (existsSync(target)) {
    if (!force) throw new Error(`preset dir already exists: ${target} (force=true to overwrite)`)
    await rename(target, `${target}.old-${Date.now()}`)
  }

  // 目录级原子：tmp 齐两文件+软链后一次性 rename 就位（discovery 永不见半成品 <name>/）
  const tmp = join(presets, `${name}.tmp-${process.pid}`)
  if (existsSync(tmp)) await rm(tmp, { recursive: true, force: true })
  await mkdir(tmp)

  await writeFile(join(tmp, 'preset.yml'), presetYml, 'utf8')
  await writeFile(join(tmp, 'agent.cordis.yml'), cordisYml, 'utf8')

  const assets = []
  for (const entry of ASSET_ENTRIES) {
    const dest = join(tmp, entry)
    if (existsSync(dest) && !lstatSync(dest).isSymbolicLink()) {
      assets.push({ asset: entry, skipped: 'non-symlink entry exists' })
      continue
    }
    const src = join(assetsRoot, entry)
    if (!existsSync(src)) continue
    await symlink(src, dest)
    assets.push({ asset: entry, target: src })
  }

  await rename(tmp, target)
  return {
    target: 'dsh-preset',
    name,
    version,
    dir: target,
    presetYml: join(target, 'preset.yml'),
    cordisYml: join(target, 'agent.cordis.yml'),
    assets,
  }
}
