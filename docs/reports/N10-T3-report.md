# N10-T3 报告 · OF-013 pool/export dsh 格式导出 + 结构化 lineage + revalidate

> 分支 `fiultyy/n10-t3-pool-export` · 2026-08-24 · 票：OF-013 导出面（docs/10-pool-selection-queen.md §2）
> 前置：N10-T1 pool/spawn（本分支已含，commit 5315bcc/1c23590）

## 要点

1. **新模块 `plugins/a2a-profile-server/exporters/dsh-preset.js`** — `exportDshPreset({profile, presetsDir?, templatePath?, assetsFrom?, force?, order?})`：
   - 缺省路径 env 注入（`A2A_PRESETS_DIR` → `~/.dsh/.agent-presets`；`A2A_PRESET_TEMPLATE` → `…/maestro/agent.cordis.yml`；assetsFrom=模板目录），测试全走临时目录零 `~/.dsh` 写。
   - **四硬规则全落**（docs/10 §2 契约核对）：① id slug `^[a-z0-9][a-z0-9-]*$` 落盘前断言（fail-loud）；② `{{` 消毒防御断言（先于一切落盘动作，含则抛错不静默改写）；③ `agent.cordis.yml` 以模板全文为基底行级手术——persona 块（`^- id: persona$` 起至下一 `^- id: /^  name: cordis:group` 前）内保留头三行+`text: |-` 行，text 内容整体替换为 agentsMd（按模板 text 块首非空行缩进逐行缩进，空行保持空行——roundtrip 逐字节可还原），块外一切行（!!js 平台条件行、group/isolate realm、注释）**字节保真**；④ `preset.yml` 仅 `{name, description}`（order 仅显式传入才写），纯 YAML 标量发射（plain 安全则 plain，否则双引号 JSON 转义），显示名=description 一句话派生（首非空行截首个句末标点），空则回退 profile.name。
   - **目录级原子**：先写 `<name>.tmp-<pid>/` 两文件+软链，再 rename 为 `<name>/`（discovery 永不见半成品——只写 preset.yml 缺 cordis 会被标 broken "directory still occupies the id"）；已存在且 force 时先 rename 旧目录 `<name>.old-<ts>` 再就位。
   - 资产软链：assetsFrom 下 `skills/ bin/ plugins/ shared/ docs/` 逐个 symlink（不存在跳过；同名非软链跳过并记录 skipped），README.md 不带。

2. **http-server.js 三处扩展**：
   - `pool/export {name, force?}`：profiles.get（unknown → -32602）→ exportDshPreset → recordRun `op:'pool-export'`（version+dir）；导出器抛错（slug/{{/模板缺块/目录已存在）→ -32000。
   - `profiles/revalidate {name}`：gatesFn 未配置 → -32000；接 store.revalidate，回执 `{drift, violations?}`。
   - `incubate` 增可选 `params.lineage {derived-by, parent?}`：与缺省 `template: spawnAgentPrompt@v0.1` 合并落 meta.lineage（queen 派生血缘），多余键透传保存；非对象 → -32602。
   - agent-card skills += `pool-export`、`profiles-revalidate`。

3. **selftest.mjs T22–T28**（合成模板 fixture：persona 行块+!!js 平台行+cordis:group isolate 块；全部 env 注入临时目录）：
   - T22 export 基本面（五断言：目录/两文件/回执、preset 仅显式键+一句话派生、persona 内嵌 roundtrip+模板正文被替换、!!js+group/isolate 保真、recordRun op:pool-export）
   - T23 slug/存在性守卫（非法名抛错/重复 -32000/force 覆盖+旧目录归档）
   - T24 `{{` 断言抛错不落盘（含无 .tmp- 残留）
   - T25 原子落位（终态两文件齐备+无 tmp 残留）
   - T26 软链资产（skills/bin/plugins 软链+readlink 指向 assetsFrom+无 README）
   - T27 lineage 透传（derived-by/parent+缺省 template 三键齐落 meta.lineage）
   - T28 revalidate（好文 pass/坏文 fail+violations+history 落账/未配置 -32000）

## 清单

| 文件 | 变更 |
|---|---|
| `plugins/a2a-profile-server/exporters/dsh-preset.js` | 新增（exportDshPreset + firstSentence/yamlScalar/embedPersona 内部件） |
| `plugins/a2a-profile-server/http-server.js` | RPC 头注释+import；incubate lineage 合并；pool/export + profiles/revalidate 两 RPC；agent-card skills 增项 |
| `plugins/a2a-profile-server/selftest.mjs` | T22–T28（+SYNTHETIC_TEMPLATE fixture + recoverPersonaText 辅助 + env3 save/restore） |
| `docs/reports/N10-T3-report.md` | 本报告 |

## 门禁（全量连跑 2 次，41/41 全绿）

第 1 次（timeout 600 node plugins/a2a-profile-server/selftest.mjs）尾部：
```
[ ok ] T22a export 基本面（目录+两文件+回执五键）
[ ok ] T22b preset.yml 仅显式键 + 一句话派生显示名
[ ok ] T22c persona 内嵌 AGENTS.md 全文（缩进后逐字节可还原）+ 模板正文被替换
[ ok ] T22d !!js 平台条件行与 group/isolate 块逐字节保真（硬规则③）
[ ok ] T22e recordRun op:pool-export
[ ok ] T23 slug/存在性守卫（非法名抛错/重复 -32000/force 覆盖+旧目录归档）
[ ok ] T24 '{{' 断言（抛错不落盘）
[ ok ] T25 原子落位（两文件齐备+无 tmp 残留）
[ ok ] T26 软链资产（skills/bin/plugins 软链存在且指向 assetsFrom）
[ ok ] T27 lineage 透传（derived-by/parent 落 meta.lineage + 缺省 template 合并）
[ ok ] T28a profiles/revalidate（好文 pass/坏文 fail+violations+history 落账）
[ ok ] T28b gatesFn 未配置 → -32000

41 passed, 0 failed
```
第 2 次尾部：
```
[ ok ] T22c persona 内嵌 AGENTS.md 全文（缩进后逐字节可还原）+ 模板正文被替换
[ ok ] T22d !!js 平台条件行与 group/isolate 块逐字节保真（硬规则③）
[ ok ] T22e recordRun op:pool-export
[ ok ] T23 slug/存在性守卫（非法名抛错/重复 -32000/force 覆盖+旧目录归档）
[ ok ] T24 '{{' 断言（抛错不落盘）
[ ok ] T25 原子落位（两文件齐备+无 tmp 残留）
[ ok ] T26 软链资产（skills/bin/plugins 软链存在且指向 assetsFrom）
[ ok ] T27 lineage 透传（derived-by/parent 落 meta.lineage + 缺省 template 合并）
[ ok ] T28a profiles/revalidate（好文 pass/坏文 fail+violations+history 落账）
[ ok ] T28b gatesFn 未配置 → -32000

41 passed, 0 failed
```

**附加实证（真模板 smoke，仓库根 agent.cordis.yml → 临时导出目录）**：agentsMd roundtrip=true；!!js 行全保真；group/isolate 保真；symlinks=bin,docs,plugins,shared,skills；tmp 残留=0；`{{` 毒物 fixture 被 fail-loud 拒绝（预期行为反证）。

## 遗留

- 验收③「export 后 session.create {agentPreset} 原生起会话」与 GUI roster 实测（loopback `agentPreset.list`）属 live 面，本票零 live 红线未做——留集成阶段（9a8b/parent）在部署点验证。
- `.old-<ts>` 归档目录不自动清理（force 覆盖的回滚窗口）；目录名含 `.` 不在 slug 字符集，dsh discovery 静默跳过，不进 GUI roster（已验证正则不匹配）。
- queen grill 协议本体（wizard/rt_projector ROLE_TEMPLATES queen）不在此票文件域（N10 另票）。
