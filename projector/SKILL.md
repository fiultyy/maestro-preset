---
name: incubation-wizard
description: >-
  孵化向导：引导 agent 走全流程——场景选型 + role 选型
  （liaison/manager/worker/supervisor/queen）→ AGENTS.md 投影 → 三门报告
  回显 → 选孵化目标（dsh/dsh-liaison/dsh-manager/omp/claude/dry）→
  incubate → 回执（name+version+receipts）回显。queen 角色走派生模式
  --derive：18 维 grill 追问清单（问题+建议值）→ 用户确认/修正 → 合并
  答案（缺维取建议值，'{' 消毒）→ 投影 → incubate 带 lineage（derived-by=
  queen + parent）。Use when 用户要求"孵化/新建/派生一个 agent"、"生成
  AGENTS.md 投影"、"跑一下孵化向导"、"incubate"、"spawn agent"、"建子代理/
  对接员/管理员/监督员"、"queen 派生/追问收敛/派生入池"，或编排链路需要
  为某场景产出可孵化 profile 时。参数 --scenario --name --role --targets
  --model；派生另加 --derive --answers-file [--parent]。
---

# 孵化向导（incubation-wizard）

把一个自然语言场景变成可孵化的 agent profile，并按选定目标真孵化。六步链路
**一步不漏**（第 2 步 role 选型是必经步，不可跳过）：

```
①场景选型 → ②role 选型 → ③投影 → ④三门报告回显 → ⑤选孵化目标 → ⑥incubate → 回执回显
（①②⑤由本 skill 决策表引导、经参数传给 wizard.py；③④⑥由 wizard.py 执行）
```

## 前置检查（三条，任一缺失先报告再停）

1. 投影原料：`~/文档/context-files/` 六源文件在位（wizard 启动自检，缺料报错）。
2. GLM 凭据：`~/.dsh/zhipu.env` 有 `ZHIPU_CODING_PLAN_API_KEY`。
3. incubate 端点：dsh 宿主加载 a2a-profile-server 插件（`http://127.0.0.1:8790/`）。
   向导只调用不拉起；不可达时明确报"端点不可达"，不要自行起服务。

## ① 场景选型（--scenario）

把用户意图收敛成一个**自包含**场景句：离开对话历史仍可独立执行、指代全部展开
（不留"它/上面/刚才"）、幂等可重放（同一意图收敛结果恒定）。例：
"调研 WebGPU 在实时语音管线中的可行性并输出结论摘要"（好）；
"帮我调研一下刚才那个"（坏：悬空指代）。

## ② role 选型（--role，必经步）

| role | 用在 | 一句话判据 |
|---|---|---|
| `worker` | 执行单件任务 | 默认；无跨 agent 协调职责 |
| `liaison` | 对接联络 | 需要语义收敛、两阶段回复、[ref:] 回执、对外凭证回显 |
| `manager` | 分派管理 | 需要车道选择、--dep 派发、worker_done 回收、异常上抛 |
| `supervisor` | 监督 | 长期盯质量门/回归，只裁不停手 |
| `queen` | 派生者 | 逐维追问（18 维清单）→ 建议值 → 用户终审 → 构造行为档案 → 三门 → 入池；不直接孵化会话（孵化走池选型），血缘如实（derived-by=queen，parent 记亲本） |

注意：role 与目标蕴含冲突会被拒（`dsh-liaison` 蕴含 `liaison`、`dsh-manager`
蕴含 `manager`；`--role manager --targets dsh-liaison` → -32602）。

## ②′ 派生模式（--derive，queen 专属 · N10-T2）

用户要"从已有 profile 派生/分化一个新 agent"或要求 queen 角色时走此模式，
普通孵化流程不经过此段：

```bash
python3 ~/.agents/skills/incubation-wizard/wizard.py \
  --scenario "<自包含场景句>" \
  --name queen-v<N> \
  --derive \
  --answers-file /tmp/answers.json \
  [--parent <亲本profile名>] \
  [--targets dry]
```

1. **grill 清单**：wizard 先打印 18 维追问清单（每维一问 + 建议值）——
   queen 会话内把这清单转述给用户逐维确认/修正，把结果收进 answers-file
   （`{维度key: 答案}` JSON；缺维自动取建议值）。建议值来自场景先验
   （最近预设数值定性 + 角色关键词），只是候选，**用户终审**。
2. **role 来源**：派生模式的 role 取自答案 `agent_role`（缺省 worker）；
   `--role` 参数在此模式下不生效。
3. **消毒**：答案与投影产物中的 `{{` 一律改写为 `{ {`（dsh 严格插值下
   未知变量首用即崩）；projector 对产物做断言，违者升温重试。
4. **血缘**：incubate params 携带 `lineage: {derived-by: queen, parent:
   <args.parent 或空>}`（插件侧消费面由 N10-T3 落地，当前多余参数被
   无害忽略）；命名即 `queen-v<版本号>`——wizard 校验该形式，并在不合规时
   读池 `profiles/list` 取最大 N 后建议 N+1（daemon 不可达时由 wizard 报错中止，不再回退固定名）。
5. **铁条款**：人在环（不做全自动派生）、不直接孵化会话（spawn 走池选型
   面）、血缘如实——三条由 queen doctrine 模板注入产物并由三门把关。

## ⑤ 选孵化目标（--targets，逗号分隔多值）

| target | 效果 |
|---|---|
| `dry` | 只记录不落系统（冒烟/契约验证安全档，默认） |
| `dsh` | 真孵化 dsh 会话（注入 AGENTS.md + 登记 fleet） |
| `dsh-liaison` / `dsh-manager` | role 蕴含孵化：复用 dsh 孵化器 + role doctrine 前置 |
| `omp` | 落 Orca agents 配置（幂等：同名复用） |
| `claude` | 落 Claude 配置目录（幂等：同名复用） |

## ③④⑥ 运行（一条命令走完投影→三门回显→incubate）

```bash
python3 ~/.agents/skills/incubation-wizard/wizard.py \
  --scenario "调研 WebGPU 在实时语音管线中的可行性并输出结论摘要" \
  --name research-webgpu \
  --role worker \
  --targets dry \
  --model glm-5-turbo
```

`--model` 缺省取 `GLM_PROJECTOR_MODEL` 或 `glm-5-turbo`；`--name` 用 slug
（如 `explore-mvp`）。仓库路径异常时用 `INCUBATION_WIZARD_REPO` 指向
`examples/realtime-provider-poc`。

## 回执回显（必做）

wizard 末尾输出回执并附机器可解析单行；把 **name + version + receipts 原样回显
给调用方**，不要转述或截断 receipts：

```
== 孵化回执 ==
  name:    research-webgpu
  version: 1
  receipt: {"target":"dry","name":"research-webgpu","version":1,"note":"recorded only"}
INCUBATION-RECEIPT]{"name":"research-webgpu","version":1,"receipts":[...]}
```

## 退出码与失败处置

| 码 | 含义 | 处置 |
|---|---|---|
| 0 | 成功 | 回显回执，结束 |
| 1 | 参数/环境缺料 | 按报错补前置（原料/导入路径）后重跑 |
| 2 | 投影或三门失败 | 检查 scenario 是否触犯术语/灾难底线铁律，改写后重跑 |
| 3 | 端点不可达 | 报告"dsh 宿主未加载 a2a-profile-server 插件"，勿自行拉起 |
| 4 | RPC 错误 | 回显 code+message（如 -32602 参数冲突 / -32000 三门拦截） |

红线：投影产物零框架术语、灾难底线恒 CAN NOT（两铁律由三门机器把关）；
`dry` 之外的目标都会真实落系统，先与调用方确认再选。
