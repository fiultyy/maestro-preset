# N10-T1 报告 · OF-012 池选型 spawn（pool/spawn RPC + 策略分派）

> 分支 `fiultyy/n10-t1-pool-spawn`（基点 c89cd71，master ff 合入取 f25592a 插件 dev base）· 2026-08-24
> 规格：docs/10-pool-selection-queen.md §1 · 红线：AGENTS.md（两级指挥 / 不碰默认分支 / 不 push / mock 零 live）

## 实现要点

### 1. `pool/spawn` RPC（http-server.js 新分支，插在 incubate 与 profiles/list 之间）

- **入参**：`{ profile（必填 '*new*'|<已有名>）, strategy?（缺省 default，非法 -32602）, name?（*new* 必填——票面参数表未列 name，但 *new* 需新 profile 命名，缺 -32602）, scenario?（仅 *new*：并入 profile_json.scenario 缺省位）, role?, targets?（缺省 ['dsh']）, mailbox?, project?, count?（缺省 3，整数 1..8 否则 -32602）, binding?:{sessionId}（binding-mode 必填，缺 -32602）, projection?（*new* 必填）}`。
- **校验序**：profile → strategy → role（ROLE_VALUES 复用）→ mailbox/project（incubate 同 regex）→ count → binding.sessionId → role-target 冲突（incubate 同规则）→ fanout 目标域（仅 dsh/dsh-liaison/dsh-manager）→ *new* 时三门（gate fail -32000）→ save/get → queen 守卫 → 分派。所有参数错误先于 save/gate。
- **选型面**：
  - `*new*`：现行 incubate 全语义（校验+三门+save+target 分派），输出 `{profile:{name,version,created}, receipts}` 与 incubate 同构（验收④，T16 键集对拍）。
  - `<name>`：`profiles.get` 复用；unknown → -32602。**绝不 save、零版本 bump**；AGENTS.md 直接读库内容注入（逐字节，不重排）；信封/回执/recordRun 一律引用库内 `meta.version`（版本钉死）。`recordRun op:'pool-spawn'`（含 version/targets/strategy）。
- **queen 守卫**（验收⑤前置）：库存 `profile.vector19.agent_role === 'queen'` → -32000 拒 spawn（queen 只派生不 spawn）。守卫点在选型解析之后（*new* 落库后同样过守卫）、分派之前。
- **effectiveRole** = `params.role ?? 库存 vector19.agent_role（若 ∈ ROLE_VALUES）`；default 策略的 extend 判定与 incubate 现行规则一致（显式 role/mailbox/project 或 role-target 时才走扩展回执），纯具名复用 + dsh 目标时回执与现行 incubateDsh 完全同形。

### 2. 三策略分派（incubators/real.js 扩）

- **default**：现行单实例孵化语义——http-server 内与 incubate 相同的 per-target 分派循环（经注入的 `incubate` 函数，dry/omp/claude 目标同样可达）。
- **fanout-sub**：`fanoutDsh(ctx, count)`（real.js 导出）——逐实例 `incubateDsh`，mailbox = 基名（`params.mailbox ?? agent_<name>`）+ `-` + 序号（1..N）；每实例各自 session-spawn + 注入 + fleet 登记（role 缺省 worker → fleet 扩展键全落）；回执 = N 条数组。
- **binding-mode**：`bindProfile(ctx)`（real.js 导出）——不 spawn；`rpc('session.prompt', {sessionId, mode:'queue', content:[{type:'text',text:信封}]})`；信封经抽取的 `injectionPrompt()` 与 incubateDsh **逐字节同形制**（`ORCA-CB] PROFILE-INJECT] <name>@v<version>\n` + role doctrine（若 role 已知）+ agentsMd）；回执 `{target:'binding', name, version, sessionId, injected:true}`。
- **重构**：incubateDsh 的信封两行抽取为共用 `injectionPrompt()`（零行为变化，T13c/T14 旧测保持绿）。

### 3. agent-card

skills += `{id:'pool-spawn', description:'select profile from pool & spawn with strategy'}`（T16 附带断言）。

### 4. 依赖方向说明

http-server.js 直接 `import { fanoutDsh, bindProfile } from './incubators/real.js'`（index.js 红线不可动；real.js 函数 env 调用时求值 → selftest mock 注入零 live）。default 策略仍走注入的 `incubate`，保持 incubate 方法同语义。

## 文件清单

| 文件 | 变更 |
|---|---|
| `plugins/a2a-profile-server/http-server.js` | +142：头注释 pool/spawn 契约行、real.js 策略件导入、STRATEGY_VALUES/FANOUT_TARGETS/NEW_PROFILE 常量、pool/spawn RPC 分支（约 110 行）、agent-card skill 增项 |
| `plugins/a2a-profile-server/incubators/real.js` | +61/-2：`injectionPrompt()` 抽取（incubateDsh 改用，行为不变）、`bindProfile()`、`fanoutDsh()`、头注释导出面说明 |
| `plugins/a2a-profile-server/selftest.mjs` | +97：T16–T21（含 T19a/b 拆分）+ 头注释索引 |
| `docs/reports/N10-T1-report.md` | 本报告 |

基线：动工前 selftest 22/22 绿（T01..T15）已确认。

## 测试要点（T16–T21，全走现有 startMockDsh mock，零网络零 live spawn）

- **T16** *new* 同构：incubate 与 pool/spawn{profile:'*new*'} 各孵一个同参 profile，`profile` 键集 + `receipts[0]` 键集排序相等、version=1、target=dsh；agent-card 含 pool-spawn skill。
- **T17** 具名复用：注入体 `=== 'ORCA-CB] PROFILE-INJECT] explore-mvp@v2\n' + 库内 AGENTS.md 原文`（全等比较，逐字节）；复用后 profiles/get version 仍 2（不 bump）；history.jsonl 出现 `{op:'pool-spawn', version:2, targets:[...]}`。
- **T18** fanout-sub count=3（mailbox 基名 fan-probe）：3 回执、mailbox 集合恰为 {fan-probe-1,fan-probe-2,fan-probe-3}、fleet 中 fan-probe-* 条目 3 条且全含 profile_version=2、注入 delta=3 且均带 explore-mvp@v2 前缀。
- **T19a/b** binding-mode：mock loopback 收到 `session.prompt{sessionId:'session-deadbeef',mode:'queue'}`，正文与期望信封全等；回执五键齐；spawn 调用数（argsLog 行数）不变；缺 binding.sessionId → -32602。
- **T20** 缺省 strategy=default + 缺省 targets=['dsh'] → 单回执 target=dsh version=2；非法 strategy → -32602 /invalid strategy/；unknown profile → -32602 /unknown profile/。
- **T21** queen 守卫：incubate 存 `vector19.agent_role='queen'` 的 profile → pool/spawn → -32000 /queen/。

## 门禁（timeout 600 全量连跑 2 次）

RUN 1 尾部：

```
[ ok ] T15 扩参三门照常拦截（-32000，不触发 spawn）
[ ok ] T16 *new* 回归同构（与 incubate 输出同形 + agent-card skills 增项）
[ ok ] T17 具名复用（注入体逐字节一致 + 版本钉死不 bump + recordRun op:pool-spawn）
[ ok ] T18 fanout-sub count=3（3 回执/mailbox 唯一/fleet 含 profile_version/3 次注入）
[ ok ] T19a binding-mode（信封入在飞 session，与 incubateDsh 同形制）
[ ok ] T19b binding-mode 不 spawn + 缺 binding.sessionId → -32602
[ ok ] T20 缺省 default 单回执（targets 缺省 dsh）/非法 strategy/unknown profile → -32602
[ ok ] T21 queen 守卫（agent_role=queen → -32000 拒 spawn）

29 passed, 0 failed
run1 exit=0
```

RUN 2 尾部：

```
[ ok ] T15 扩参三门照常拦截（-32000，不触发 spawn）
[ ok ] T16 *new* 回归同构（与 incubate 输出同形 + agent-card skills 增项）
[ ok ] T17 具名复用（注入体逐字节一致 + 版本钉死不 bump + recordRun op:pool-spawn）
[ ok ] T18 fanout-sub count=3（3 回执/mailbox 唯一/fleet 含 profile_version/3 次注入）
[ ok ] T19a binding-mode（信封入在飞 session，与 incubateDsh 同形制）
[ ok ] T19b binding-mode 不 spawn + 缺 binding.sessionId → -32602
[ ok ] T20 缺省 default 单回执（targets 缺省 dsh）/非法 strategy/unknown profile → -32602
[ ok ] T21 queen 守卫（agent_role=queen → -32000 拒 spawn）

29 passed, 0 failed
run2 exit=0
```

（旧 T01..T15 两轮均全绿，输出在各自 RUN 头部，此处省略——尾部见上。）

## 遗留 / 边界

- 票面参数表未给 `*new*` 的新 profile 命名位；实现取 `params.name`（*new* 必填，-32602）。集成侧调用约定需带上。
- 非法 profile 名（如大写/下划线）在 *new* 路径由 ProfileStore.save 抛错 → HTTP 500（与现行 incubate 同 parity，未收窄）。
- fanout-sub 仅支持 dsh 族目标（omp/claude/dry → -32602）；binding-mode 忽略 targets（不 spawn）。
- binding-mode 的 doctrine 生效验收（验收③"回合首动作可验"）在 mock 层验证了信封逐字节同形制；live 回合验证属 OF-013 后续联调面（本票红线禁 live）。
- count 显式传非法值在任何策略下均 -32602（含 default/binding-mode——参数面统一校验）。
