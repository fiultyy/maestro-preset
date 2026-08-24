# Voice-Orchestration KG · 10 池选型与派生规划（pool-selection & queen-derivation）

> 版本 v1 · 2026-08-24 · 来源：用户两节点指示（当日裁决级输入）
> 性质：**规划态**。票据 OF-012..OF-015（延续 09 编号），落地排 W6 余量窗口。
> 依据链：本文 → `docs/kg/02-ws2-a2a-profile.md`（池建成态）+ `06-ws5-agent-ecosystem.md`（W5）+ `09-orch-hardening-plan.md`（OF 序列）。

## 0. 两节点与底座差距

| 节点 | 用户要求 | 底座现状（2026-08-24 核实） | 差距 |
|---|---|---|---|
| **节点1** 池选型 spawn | 新 session 创建时把 agent base profile（dsh 格式）抽象出来供池选 spawn；带策略：默认 / fanout-sub / binding-mode | `incubate` 单发：scenario→投影→session-spawn（fixed preset）；无选型面、无策略参数 | ①缺"从池选已有 profile 复用"通道（现行只能新建）②缺 spawn 策略语义 ③base profile（preset.yml+cordis 格式）与池 profile（19 维+AGENTS.md）两套格式未打通 |
| **节点2** queen agent | init 一个 queen base profile：按维度与用户 grill（追问）后创建新 profile 进池 | wizard 有 scenario+role 两问；无 queen 角色、无逐维 grill 交互、无"派生入池"闭环 | ①queen=第 18 维新 role（派生者）②grill 协议=维度清单驱动的多轮问答 ③派生产物走 ProfileStore.save 版本化入池 |

**格式事实**（本轮实测钉死）：dsh base profile = `~/.dsh/.agent-presets/<name>/`（preset.yml 元信息 + agent.cordis.yml 组合面 + plugins/skills 资产）。池 profile = `<root>/<name>/`（AGENTS.md + profile.json{scenario,vector19} + meta.json 血缘）。**打通点 = 派生器**：池 profile → 生成 dsh preset 目录（cordis persona 段内嵌 AGENTS.md 投影）→ `~/.dsh/.agent-presets/` 落位 → session.create {agentPreset} 原生可用。

## 1. OF-012 · 池选型 spawn（profile resolve + strategy）

**范围**：`http-server.js` 增 `pool/spawn` RPC：
- 入参 `{ profile: <name|`*new*`>, scenario?, role?, targets?, strategy, binding? }`
- **选型面**：`profile=*new*` → 走现行投影新建；`profile=<name>` → `profiles/get` 复用（AGENTS.md+vector19 读出重注入，版本钉死 meta.version）
- **策略三型**：
  - `default`：单 session 孵化（现行语义）
  - `fanout-sub`：N 个 worker sub-session 扇出（复用 VO-007 manager 群语义：同 profile 注入 N 实例，各自 mailbox 后缀唯一化）
  - `binding-mode`：绑定已有 session（不新孵——`{binding: {sessionId}}` 注入 profile 到在飞会话 = 车道A"穿衣"路径泛化）
- 落点：pool-registry（http-server 三分支扩第四支）+ incubators/real.js 扩 spawn 策略分派
- **验收**：①复用已有 profile 孵化，AGENTS.md 与库内逐字节一致；②fanout-sub 3 实例各自 mailbox 唯一+fleet 登记；③binding-mode 注入在飞 session 后 doctrine 生效（回合首动作可验）；④`*new*` 与现行 incubate 输出同构（回归）；⑤strategy 缺省=default 兼容
- 量：中 · 依赖：无（VO-007/012 已铺好 fanout 与穿衣先例）· 文件域：插件 http-server.js + incubators/real.js

## 2. OF-013 · queen base profile + grill 派生协议

**范围**：
- **queen role 落位**：rt_projector ROLE_TEMPLATES 增 `queen`（第 17 维扩值：派生者人格=维度追问→profile 构造→三门→入池）；wizard --role 增 queen 选项
- **grill 协议**（queen 的 doctrine 核心）：18 维清单（19 维中 grill 适用的维度——排除 template_version 等机械维）驱动多轮问答：每维 1 问+候选建议值（可从 scenario 预投影推断默认），用户确认/修正 → 全维收敛后构造 profile
- **派生入池闭环**：queen 收敛结果 → ProfileStore.save（lineage 记 `derived-by: queen,<parent-profile>?`）→ 三门 → 回执含新 profile 名+版本
- **dsh 格式导出**（打通节点1 格式差）：`pool/export` RPC——池 profile → 生成 `~/.dsh/.agent-presets/<name>/`（preset.yml 从 profile.json 生成 + agent.cordis.yml persona 段嵌 AGENTS.md 全文 + 软链 plugins/skills 资产自 maestro 模板）→ dsh 原生 agentPreset 即刻可用
- **验收**：①queen 孵化真跑：grill ≥3 维问答 → 派生 profile 入池（三门过）；②lineage 血缘可溯；③export 后 `session.create {agentPreset:<derived>}` 原生起会话；④revalidate 对派生物有效；⑤queen 不越权（只能派生 profile，不能直接 spawn——spawn 走 OF-012）
- **GUI 通路实证**（2025 实测，loopback `agentPreset.list`）：新会话屏原生有 preset 选择 chip（`AgentPresetSeat`，workspace 选择器旁，菜单项=name+description）；roster 每次 list 调用实时扫 `~/.dsh/.agent-presets/`——落一个目录**即刻出现**（trust=user，无需重启/重载）；只写 preset.yml 缺 agent.cordis.yml 会标 `broken`（"directory still occupies the id"）→ export 必须两文件齐写。即 export 一步就把派生 profile 送进 GUI 原生列表，零 UI 改动
- **池选择 GUI 落地**（`~/.dsh/plugins/ui-agent-pool`，2026-08-24 E2E 全绿）：原生 preset chip 之外补一面**池直选 GUI**——设置区「Agent 池」表格（11 profile：name/version/targets/updated/已导出态）+ 欢迎屏 `conversation.input.left` 座「池 · N」下拉；一键「导出并设为默认」= `pool/export {force}` → `settings.update agent-presets.default` → 宿主 roster 即刻翻转。技术要点：①插件走 `--patch` 装载，本地目录包须 symlink 进 `~/.dsh/node_modules/` 用裸名解析（绝对路径 ERR_UNSUPPORTED_DIR_IMPORT）；②inject face 返回值被 renderer **拍平到 props 顶层**（`props.load`/`props.poolStore`，非 `props.inject.*`），entry 内 throw 会被错误边界静默吞掉=空行；③store 防重入勿用 status==="loading" 短路——初始态即 loading，首载会被自己跳过（独立 `fetching` 标志）；④daemon CORS 已放行 loopback origin（commit 69a6dfa）。主宿主 3080 下次重启后生效，验证宿主 3081 已在线可看
- **v2：池视图并轨官方预设 + 不注入 + queen 派生复验**（同日）：①表格改为 union 视图——顶部「不注入（清除自定义默认，回退部署默认）」行（`settings.mutate {op:"unset", path:["default"]}`，与宿主 remove() 同款 op，非写 null）+ roster 预设行（trust=system 标官方 / trust=user 标用户，可直选「设为默认」，broken 拒选）；seat 菜单同步。②**真实替换双证**：default 写 queen 后新会话 header 落盘 `agentPreset:"queen-smoke-coder"`，且模型自述身份与导出 persona 逐字一致（对照组 long-task 答标准助手身份）——`resolveSessionPreset` 读会话事件流 `agent-preset/selected`，header 是创建事实。③池已清理至单 queen：`queen-diff-review v1`（wizard `--derive --answers-file {agent_role:queen} --parent queen-smoke-coder`，三门 PASS，lineage `derived-by: queen`），GUI 导出→默认→回设 long-task 全链路复验通过。④GUI 会话视图无「设置」文本按钮——设置入口在侧栏（`aria-label=打开侧边栏` 开关内），E2E 需先开侧栏
- **v3：池民永居池行 + root 架构定论 + daemon 存活**（同日）：①v2 的 union 表有接线错误——池 profile 导出后从池行**迁移**进预设行（用户组），视觉上 queen 变成了"用户预设"。修正：池组 = 全部池 profile（导出与否都常驻，按钮 exported?设为默认:导出并设为默认），预设组 = roster 减池成员；seat 菜单同律，selectedId 判序池优先。②**物化目录是唯一桥**：dsh `profile-boot` 组装时 `roots: [SHIPPED_ROOT]` 强制覆写（用户层无法注册第二个可写 preset root），composable 位置只有 shipped + `~/.dsh/.agent-presets/`；池目录本身非 preset 形状（AGENTS.md+profile.json，无 agent.cordis.yml），故 pool/export 的物化副本必须留在 `~/.dsh/.agent-presets/`——它是构建产物，所有权与展示归池。③daemon 是 nohup 裸跑（重启：`setsid nohup node ~/.dsh/plugins/a2a-profile-server/daemon.mjs >>~/.dsh/a2a-profile-daemon.log 2>&1 &`），无 systemd 托管，3081 退役时曾被连带清掉（GUI 表现为「池 · —」+ daemon FAIL: Failed to fetch）
- **v4：身份面/工具面契约落地**（同日）：池产物两面各归其位——**身份面**：exporter 生成 persona row 时注入 `complete: true`（`embedPersona` 在 `text:` 行前插行）；源码依据 `dsh-system-prompt`：complete 段使 sections 折叠为仅剩 persona（`harness:identity` order -100 一并消失），contexts（模型/cwd 运行时信息）保留不 suppress——身份 100% 归池 AGENTS.md，运营信息照常注入。**工具面**：模板行级保真 = maestro 20 行（standard 16 全集 + message-bridge/orca-callback/session-purge/workspace-unarchive 4 增量）= 完整超集，零缺失。**官方预设无特权**（问题1 定论）：四预设 = 同构普通 YAML（persona+工具行清单），standard persona 仅 1 行、无 complete；minimal 是官方唯一 complete:true 用例；`harness:identity` 在宿主层注册，非 complete 预设盖不掉。活体终证：default=queen-diff-review 新会话（header 落盘 `agentPreset:"queen-diff-review"`）自述"我是由 Z.ai 训练的 GLM 模型驱动的逐文件 Diff 代码审查 agent…"——与池 AGENTS.md 逐字对应，无 DeepSeek Harness 身份残留（对照组旧 maestro 会话答"DeepSeek Harness's Orchestration Supervisor"）。commit c9582df
- **v5：池页不加载项回归**（同日）：纯池视图改造（v3 后续）曾误删「不注入」行——原生「Agent 预设」页只会**写**默认（`writeDefaultPreset`→`settings.update`，无 unset 面），"回到 dsh 默认"唯一入口在池页。已恢复：表格首行「不加载（dsh 默认）/停用池注入…/恢复默认」+ seat 菜单首项；选中态=roster 无任何 isDefault。E2E：点击恢复默认 → `settings.mutate unset default` → roster 翻 `standard`（部署默认浮现）→ API 还原 long-task 全通
- **dsh 格式契约核对**（源码级，`dsh-agent-presets`/`dsh-system-prompt`/`dsh-agent-instructions`/`dsh-persona` 四包 + maestro 实例，2026-08-24）：
  - **prompt 分层**（关键认知）：①SystemPrompt 注册表 = sections（有序静态）+ contexts（动态快照）+ variables + tool providers，scoped 层遮蔽全局；基础段仅 `harness:identity`(order -100) 与 `deployment:persona`(order 0，base 发行版默认空)。②**persona row（`@deepseek-ai/dsh-persona`）是 preset 改身份的唯一机制**——scope-only，config `{text(必填), complete?, includeRuntimeContext?}`；`complete:true`=独占段接管全 prompt（仅允许一个）。③**AGENTS.md 是另一通道**（`dsh-agent-instructions`）：workspace 链 `AGENTS.md`/`CLAUDE.md`+`.local` 叠层 + 用户全局 `~/.dsh/AGENTS.md`，以持久上下文基线消息注入（"Instructions from: <path>"），maxBytes 65536，fs 触碰实时对账；**不入 preset**。→ N10 的"persona 段嵌 AGENTS.md 全文"架构上正确：派生身份随 preset 走（任意 cwd 生效、遮蔽部署 persona、无字节预算），写 workspace AGENTS.md 反而是错误通道（作用域错+预算截断+与仓库自身 AGENTS.md 冲突）
  - **mount 契约**：组合=插件行列表（Include 子树挂 agent scope，会话级生命周期）；行不可用（等服务等）即 mount 失败；**任何行向 ROOT realm 发服务即拒绝**（必须 `isolate` realm 或移宿主组合）——池侧新增插件行若引用须守此则；裸包名从 harness base 解析（生成 preset 可直接引 `@deepseek-ai/dsh-*`）；preset 子树永不回写
  - **export 硬规则**（生成器必守，均会静默/运行期炸）：①**id slug**：目录名必须 `^[a-z0-9][a-z0-9-]*$`，不符则 discovery 静默跳过（中文/下划线/大写全灭）→ queen 命名即 `queen-v<N>`（wizard 读池 max N 自动递增建议，2026-08-24 简化）；②**`{{` 消毒**：插值是严格模式——文本中任何 `{{x}}` 形段（x 不匹配已注册变量 `model`/`cwd` 等）在首次 model step 即 throw（未知/畸形变量皆炸，代码围栏不豁免）→ 投影器生成时断言输出无 `{{`，grill 用户答案含 `{{` 则改写为 `{ {`；③**生成行只用纯 YAML**（loader 方言含 `!!js` 函数标签是超集）——平台条件行（bash/pwsh `disabled: !!js ...`）从 maestro **原文整段拷贝**，不重排不重序列化；④preset.yml 仅显文本 `{name, description, order?}`（order 控制 picker 排序），坏损只降级显示不阻断 mount
- 量：中-大 · 依赖：OF-012（选型面先行，queen 产物经池选型消费）· 文件域：rt_projector.py + wizard + 插件 export RPC

## 3. 排期与依赖

```
OF-012（池选型 spawn）──→ OF-013（queen+grill+export）
   （先行：选型/策略面）        （消费面：派生入池+dsh 格式打通）
```

两票均在 W6 余量窗口（OF-004/009 之后或并行——文件域不相交：OF-012 动插件 JS、OF-013 动 python 投影器+插件 RPC，与持有票零冲突）。

## 4. 非目标（裁决）

- 不做 queen 自动派生（必须用户 grill 在环——半自动收敛，人是终审）
- 不做池 profile 反向同步进 dsh preset（单向：池→dsh 导出；dsh preset 改动不回流池）
- 不做多 queen 协商派生（单 queen 会话内闭环）
