# N10 总报告 · OF-012 池选型 spawn + OF-013 queen 派生/导出

> 波次：N10（docs/10-pool-selection-queen.md v1）· 9a8b 现场集成 · 2026-08-24 02:0x–02:4x
> 基线 master f25592a（N10 dev base 导入）→ 收口 HEAD **2192930** · 全程未 push

## 1. 票面与收口

| 票 | 内容 | worker | merge | 门禁 |
|---|---|---|---|---|
| N10-T1 | OF-012 pool/spawn RPC + 三策略（default/fanout-sub/binding-mode）+ 选型面（`*new*`/具名复用·版本钉死）+ queen 禁 spawn 守卫 | omp@worktree | `5315bcc` | selftest 29/29 ×2（独立复跑）+ T16..T21 |
| N10-T2 | OF-013 queen ROLE_TEMPLATE + GRILL_DIMENSIONS 18 维 + grill_checklist + sanitize/assert_no_mustache + wizard `--derive/--answers-file` + SKILL.md | omp@worktree | `8b8bca2` | unittest 18/18 ×2（独立复跑） |
| N10-T3 | OF-013 pool/export RPC + exporters/dsh-preset.js（四硬规则）+ incubate lineage 透传 + profiles/revalidate RPC | omp@worktree | `c4991f1` | selftest 41/41 ×2（独立复跑）+ T22..T28 |
| T4-seam-1 | queen role 集成接缝：插件 ROLE_VALUES 无 queen，incubate 拒收 → INCUBATE_ROLE_VALUES（incubate 收 queen / pool/spawn 拒 queen 参数） | 9a8b | `db81d50` | 42/42 ×2（T29） |
| T4-seam-2 | agent_role 承重落盘：Projector 顶层 agent_role 被 store 窄写丢弃 → 有效 role 并入 vector19.agent_role（incubate + `*new*` 两路） | 9a8b | `2192930` | 42/42 ×2（T29 扩三断言） |

两个 seam 均为 **live E2E 揭露**（mock 面测不出）：seam-1=queen 人格 incubate -32602；seam-2=守卫对 wizard 产物失效（vector19.agent_role 恒空，queen profile 被真孵化出会话）。VO-002 报告的"agent_role 落盘键范围外"遗留缺口就此关闭。

**终门（HEAD 2192930）**：`timeout 600` 壳全量双跑——selftest **42/42 ×2 绿**、unittest **18/18 ×2 绿**。

## 2. live E2E 证据（本机 loopback，低负载窗口）

| 验收点 | 证据 |
|---|---|
| ① queen 派生真跑 | wizard `--derive`：18 维清单打印、**5/18 维用户作答**（≥3）、GLM 投影 1468 chars、三门 PASS、入池 `queen-smoke-coder@v1`（dry 回执） |
| ② 血缘可溯 | meta.json lineage = `{template, derived-by:"queen", parent:"queen-smoke"}`（profiles/get 实读） |
| ③ export→agentPreset 原生起会话 | pool/export → `~/.dsh/.agent-presets/queen-smoke-coder/`（preset.yml+agent.cordis.yml+5 资产软链）→ **agentPreset.list 即刻显示**（trust=user 非 broken）→ `session.create {agentPreset}` 真起会话（session-4b07b658）→ persona 探针应答："我是代码审查与质量把关助手，交付物是…带 `文件路径:行号` 证据锚点的结构化审查清单"（与 grill 答案 D7 一致） |
| ③′ 导出完整性 | `!!js` 平台行 3/3 逐字节同模板；派生 AGENTS.md 全文嵌入 persona text 块；group/isolate realm 行数守恒；`{{` 零毒（registered {{model}}/{{cwd}} 除外，位于模板原行）；maestro persona 已替换（'orchestration supervisor' 残留仅模板注释行 1/28=硬规则③要求的字节保真） |
| ④ revalidate 对派生物 | RPC 面：无 gatesFn 守护诚实返 -32000（生产语义=向导侧门权限）；python 真门 run_gates(derived AGENTS.md) = **PASS**；T28 mock 证 RPC 全路径 |
| ⑤ queen 不越权 | role 参数路：-32602 `invalid role: queen`；落库路（v2 vector19.agent_role=queen）：**-32000 `queen profile cannot spawn (derive-only)`** |
| binding-mode | pool/spawn {profile: probe-liaison, strategy: binding-mode, role: liaison, mailbox: n10bind} → 在飞 session 注入回执 injected:true；下回合**首动作=邮箱核验+ref 纪律**（doctrine 生效并优先于"不要执行工具"的松指令） |
| fanout-sub | count=3 → 3 回执（77ef/c7aa/cdd4）、mailbox `n10fan-1/2/3` 唯一、fleet 三条含 profile_version/preset；会话已 purge、fleet 已清 |
| `*new*` 回归 | pool/spawn `*new*` → n10-newface-smoke@v1 dry 回执，形状与 incubate 同构 |
| strategy 缺省 | 省略 strategy → default 单回执（live + T20） |

## 3. 投影稳健性观察（非阻断，供后续波次）

queen 场景投影对**场景措辞敏感**：v1 措辞（"逐维…档案"）→ GLM 产物泄漏 "19 维度"（gate1）；v2 措辞缺底线暗示 → gate2（灾难底线缺位）；v3 补底线暗示后三门全过。建议后续在 spawnAgentPrompt 元提示或 queen 模板内固化底线条款暗示（T2 报告遗留区已记同向观察）。

## 4. 部署终态

- 插件已部署 `~/.dsh/plugins/a2a-profile-server/`（= HEAD 2192930），守护 **运行中**（run-plugin.mjs 激活，端口 8790，agent-card 六 skills：dispatch/query/incubate/pool-spawn/pool-export/profiles-revalidate；PID 见 /tmp/n10/plugin-daemon.pid）。重启法：`nohup node /tmp/n10/run-plugin.mjs &`（或任意 `activate({})` 载体）。
- 池新增：queen-smoke-coder@v1（worker·queen 派生）、queen-persona-smoke@v2（queen·守卫验证）、n10-newface-smoke@v1（`*new*` 回归）——留作证据与复用素材。
- GUI preset roster 新增：`queen-smoke-coder`（导出产物，即刻可见）。
- 临时会话全清（e2/fanout×3/queen a82a；a82a 若 409 busy 已在收口前重试清除，见 ledger）。

## 5. 回流备料（parent 域）

`docs/reports/assets/n10-pipecat-backflow.md` + 三 patch（rt_projector/wizard/SKILL vs pipecat-poc 部署副本，基线同源起步）。pipecat-poc 仓全程零写入。

## 6. 遗留

- pipecat-poc 回流 commit（parent）；向导安装点 `~/.agents/skills/incubation-wizard/` 同批拷贝。
- fanout 失败语义：中途失败整 RPC 500（部分实例已起）——票面未定义，live 正常路径已验，留后续票。
- 投影稳健性（§3）。
