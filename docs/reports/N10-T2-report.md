# N10-T2 · queen role + grill 18 维协议 + 向导派生模式（OF-013 投影器侧）

> 票：OF-013 python 投影器侧 · 分支 `fiultyy/n10-t2-queen-grill`（基点 master c89cd71，含 f25592a N10 基座）
> 日期：2026-08-24 · 规格：docs/10-pool-selection-queen.md §2 · 零网络零 GLM

## 要点

1. **queen role 模板**（`projector/rt_projector.py` ROLE_TEMPLATES）：派生者人格 doctrine，
   与 liaison/manager 同风格中文铁条款。职责链=逐维追问→候选建议值→用户确认/修正→
   全维收敛→构造行为档案→三道验收门→入池回执（顺序不可倒置）；三条铁律：人在环
   （半自动收敛、用户终审、不做全自动派生）、派生专属（不直接孵化会话，孵化走池选型
   通道）、血缘如实（derived-by=queen 与 parent 如实记录）。模板文本先对照
   rt_projection_gates.py 真实禁则措辞，单测验证 gate1 零命中、骨架+模板三门全绿。
2. **GRILL_DIMENSIONS 18 维**：全集=行为空间 19 trait 维（D1..D16+元层 3）+投影器元数据
   维（agent_role/template_version）。排除 template_version（机械版本戳）与 M1/M2
   （宪法性元层——BEHAVIOR-SPACE §四 7 预设表恒为"-"，非逐场景可调，grill 不问）；
   故 18 = D1..D16 + M3 时间视野（场景选择器）+ agent_role。每维 {key, question(中文一问),
   default_hint(先验推断口径)}。
3. **grill_checklist(scenario)**：建议值口径=nearest_priors 关键词检索最强预设→§四 数值表
   （只读转录 `_PRESET_VALUES`）转定性词；agent_role 走角色关键词（manager/liaison/
   supervisor，无信号默认 worker）；M3 走预设语义定性。建议值只是候选，用户终审。
   Projector._nearest_priors 改为委托模块级 nearest_priors（grill 与投影同一先验口径，行为不变）。
4. **mustache 消毒**：sanitize_mustache（`{{`→`{ {`）+ assert_no_mustache（残留即
   ValueError）。Projector.project() 在三门通过后对 agents_md 断言——违反与 gate 失败同路：
   升温重试（0.2），耗尽抛 ProjectionError（dsh 严格插值硬规则，docs/10 §2 ②）。
5. **向导 --derive**（`projector/wizard.py`）：ROLES += queen；--derive 与 --scenario/--name
   配合，--parent 可省，--answers-file 必填（缺则 argparse error 退出 2），JSON {维度key:答案}
   标量映射。流程=grill 清单打印（供 queen 会话内转述用户）→缺维取建议值→sanitize_mustache
   →Projector.project(answers=18 维 "k: v" 列表, role=答案 agent_role 或缺省 worker)→三门回显→
   incubate RPC params 增 `lineage:{derived-by:'queen', parent:args.parent||''}`（插件侧
   N10-T3 才消费；当前多余参数被无害忽略）。回执尾部与现行路径共用 `_finish_incubate`
   （输出逐字节同构）。非 derive 路径参数面与流程零变化（回归单测钉死）。
6. **SKILL.md**：role 表补 queen 行（判据+铁条款），新增 ②′ 派生模式段（用法命令、
   answers-file 契约、role 来源、消毒、血缘、三铁条款），frontmatter 触发词补 queen 派生。

## 变更清单

| 文件 | 变更 |
|---|---|
| projector/rt_projector.py | +queen 模板；+GRILL_DIMENSIONS/_PRESET_VALUES/_M3_PRESET/_ROLE_KEYWORDS/_qualitative/nearest_priors/grill_checklist/sanitize_mustache/assert_no_mustache；project() 挂 assert_no_mustache；_nearest_priors 委托；docstring 注记 |
| projector/wizard.py | ROLES+queen；--derive/--parent/--answers-file 参数与校验（answers JSON 加载进 args.answers）；run_derive() 派生流；_finish_incubate() 共用回执尾部；docstring 用法 |
| projector/SKILL.md | frontmatter 触发词、role 表 queen 行、②′ 派生模式段 |
| tests/test_n10_queen.py | 新增，18 用例（见下） |

## 测试（tests.test_n10_queen，18 例全绿）

- queen 模板非空、gate1 单独零命中、骨架+模板 run_gates 全绿、铁条款关键词在位。
- GRILL_DIMENSIONS 恰 18 条、key 唯一、每条 question/default_hint 非空、含 agent_role、
  不含 template_version；grill_checklist('写代码的agent') 18 条建议值全非空且保序；
  关键词命中（管理→manager、上线→release 先验）与兜底先验均有值。
- sanitize_mustache('{{x}}'→'{ {x}}'、多重改写、普通文本 no-op)；assert_no_mustache 触发
  ValueError / 干净文本放行。
- wizard.parse_args：--role queen 合法；--derive 无 --answers-file → SystemExit(2) 且报错
  文案含 --answers-file；--answers-file JSON 正确加载为 args.answers；经典参数面
  （scenario/name/role/targets/model）零变化回归。
- ast.parse 两 py 文件语法完好。
- 三门导入路径缺失 → setUpClass AssertionError 显式 error（实测 skipped=0、errors=1，不 skip）。
- RPC/GLM 零真调用：incubate 参数构造经 stub 冒烟验证（lineage/消毒/role 提取正确），
  真实 RPC 面归 N10-T3。

## 门禁（timeout 600 python3 -m unittest tests.test_n10_queen -v 连跑 2 次）

第 1 次尾部：

```
test_roles_contain_queen (tests.test_n10_queen.WizardArgsTests.test_roles_contain_queen) ... ok

----------------------------------------------------------------------
Ran 18 tests in 1.462s

OK
```

第 2 次尾部：

```
test_roles_contain_queen (tests.test_n10_queen.WizardArgsTests.test_roles_contain_queen) ... ok

----------------------------------------------------------------------
Ran 18 tests in 1.434s

OK
```

## 遗留

- lineage 消费面（ProfileStore.save 落盘 derived-by/parent、meta.json 血缘）归插件票
  N10-T3；当前 incubate RPC 多余参数被插件无害忽略（已核实 http-server.js 现状）。
- queen 真跑（GLM 投影 + 池选型孵化 + dsh export 四硬规则全链）依赖 N10-T3 插件面与
  live 预算，本票不触碰（红线：测试禁 GLM/网络）。
- 投影器/向导的部署回拷（pipecat-poc examples 与 ~/.agents/skills/incubation-wizard）
  按 AGENTS.md 两级指挥归 parent/9a8b 集成时做，本票只在 worktree 分支 commit。
