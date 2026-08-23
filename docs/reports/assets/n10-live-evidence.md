# N10 live E2E 证据链（完整版 · 含真实问答）

> 采集：9a8b · 2026-08-24 02:05–02:25（低负载窗口）· 全部本机 loopback 实测
> 对应验收：docs/10 §1 验①-⑤ + §2 验①-⑤；会话验毕已 purge（证据为采集期实录）

## E1 · queen grill ≥3 维真实问答 → 派生入池（验① §2）

**grill 清单**：`grill_checklist('代码审查与质量把关的助手')` 输出 18 维（agent_role, D1..D16, M3），每维一问+先验建议值（例：D1 建议"高（参考 coding 预设先验）"）。

**用户真实作答（5/18 维，answers-file 原文）**：

| 维度 | 问题（节选） | 用户答案（原文） |
|---|---|---|
| agent_role | 角色定位是哪类？ | `worker` |
| D1 | 主要职责边界？ | `高——专注单仓代码审查，不做跨仓调度` |
| D7 | 下结论前的证据要求？ | `高——审查结论必须逐条给出证据锚点（文件:行号）` |
| D15 | 产出格式纪律？ | `高——输出固定为审查清单格式` |
| M3 | 时间视野？ | `低——单次审查会话内闭环，不跨天驻留` |

缺 13 维自动取建议值；全部答案过 `{{` 消毒。GLM 投影产物 1468 chars，三门 PASS（gate1/gate2/gate3 全过），入池 `queen-smoke-coder@v1`（dry 回执）。

**血缘（meta.json 实读）**：
```json
"lineage": { "template": "spawnAgentPrompt@v0.1", "derived-by": "queen", "parent": "queen-smoke" }
```

## E2 · pool/export → agentPreset.list 非 broken → session.create 真起会话跑通首回合（验③ §2 终态）

1. `pool/export {name:"queen-smoke-coder"}` → `~/.dsh/.agent-presets/queen-smoke-coder/`（preset.yml 177B + agent.cordis.yml 19877B + 5 资产软链 skills/bin/plugins/shared/docs → maestro）。
2. `agentPreset.list`（GUI loopback）即返回：
```json
{"id":"queen-smoke-coder","trust":"user","isDefault":false,"name":"对提交的 diff 做逐文件审查，输出带证据锚点的审查清单。","description":"对提交的 diff 做逐文件审查，输出带证据锚点的审查清单。"}
```
（trust=user、无 broken 标记——目录落位即刻可见，零 UI 改动。）
3. `session.create {workspaceId, agentPreset:'queen-smoke-coder'}` → **session-4b07b658-0b8a-4645-8620-98b16467c67e**（renamed `4b07-n10e2 · queen-smoke-coder · derived-preset E2E(active)`）。
4. 首回合探针（`session.prompt`："用一句话回答：你是什么角色的助手？你的交付物是什么？"）→ turn 1 完成（turn/start→…→turn/end），assistant 应答原文：
> 我是代码审查与质量把关助手，交付物是对提交 diff 逐文件审查后、按严重度排序且每条带 `文件路径:行号` 证据锚点的结构化审查清单。

与 grill 答案 D7（"证据锚点（文件:行号）"）/D15（"审查清单格式"）逐点一致——派生 persona 经 preset 原生生效。

**导出完整性**（模板 vs 生成物字节比对）：`!!js` 平台行 3/3 逐字节同；派生 AGENTS.md 全文嵌入 persona text 块（缩进还原一致）；group/isolate realm 行数守恒；`{{` 零毒（仅模板注册变量 {{model}}/{{cwd}} 于原行）；maestro persona 已被替换（残留 'orchestration supervisor' 仅模板注释行 1/28——硬规则③字节保真要求）。

## E3 · binding-mode（车道A"穿衣"泛化）

`pool/spawn {profile:"probe-liaison", strategy:"binding-mode", role:"liaison", mailbox:"n10bind", binding:{sessionId: session-4b07…}}` → 回执 `{target:"binding", injected:true}`（无 spawn）。
随后探针回合：**回合首动作=邮箱核验**（assistant 首输出："邮箱已排空，无未读来件。做一次无副作用的只读核验，确认是否存在已投递/已读的唤醒信令（取 `run_id` 与 `[ref:]`）"）——doctrine 生效并优先于探针中"不要执行工具"的松指令，即验收③"回合首动作可验"。

## E4 · fanout-sub 3 实例

`count=3` → 3 回执：code `77ef/c7aa/cdd4`，mailbox `n10fan-1/2/3`（两两不同）；fleet.json 三条登记各含 `role/project/mailbox/profile_version=1/preset=maestro`（五键齐）。会话验毕 purge，fleet 清零。

## E5 · queen 禁 spawn（两路）+ queen 人格真孵化

- role 参数路：`pool/spawn {role:"queen"}` → `-32602 invalid role: queen (legal: liaison/manager/worker/supervisor)`。
- 落库路（v2，vector19.agent_role=queen 承重落盘后）：`pool/spawn {profile:"queen-persona-smoke"}` → **`-32000 queen profile cannot spawn (derive-only): queen-persona-smoke`**。
- queen 人格经 wizard `--role queen` 真孵化入池 `queen-persona-smoke`（v1 接缝拦截 → db81d50 修复后 v2 成功），doctrine 含五铁条款+灾难底线。
- seam-2 实录（守卫失效瞬间）：v1 时 pool/spawn 对 queen profile 真孵化出 session-a82a（vector19.agent_role 恒空所致）→ 2192930 承重落盘修复 → v2 重派生后守卫 -32000 生效。a82a 会话已 purge。

## 其它 live 面

- `*new*` 回归：`pool/spawn {profile:'*new*', name:'n10-newface-smoke', targets:['dry'], …}` → `{profile:{name,version:1,created}, receipts:[dry]}` 与 incubate 同构。
- strategy 缺省 default 单回执；unknown profile -32602。
- python 真门 revalidate：`run_gates(queen-smoke-coder AGENTS.md)` = PASS（violations 空）。
- daemon：`daemon.mjs` 常驻入口（端口 8790）；存活口径见 N10-final-report §4。

## 会话/实例清理账

session-4b07…（E2/E3）、77ef/c7aa/cdd4（E4）、a82a（seam-2）全部 purge，fleet 仅剩编排者自身（9a8b）。dais 零 spawn（红线遵守）。
