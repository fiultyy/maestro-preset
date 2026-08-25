# T1(0007) — 窄腰实施方案文档修订:全局总则落稿(阶段列 / 词汇表 18 / 边界规格 / 部署面)

> 状态: DISPATCHED

### 依据

- 评审报告: `docs/reports/nw-plan-review-report.md` — R-S07/R-S09/R-S10/R-S13(阶段关联面)/R-S17/R-S18/R-S24/R-S32/R-S33 + §3④ 行号勘误表(14 处)+ R-B01/R-B13/R-B17/R-B10(方案文本级部分)。
- spec 节: `docs/reports/.nw-spec-raw-G.md`(§G.0–§G.10)——本票唯一权威依据,逐条落稿。

### 目标

把 G 节全部裁决**原样写进** `docs/narrow-waist-implementation-plan.md`:§6 阶段归属列与 P3.5 新设、词汇表 18 Signal 与每平面白名单常量、detectVersion 四态/normalizeType 三态、ttl/via 执行规格与六条死信基准、大小预算三档、验收可观测改写、AGENT_CARD/downgrade 降级、§0 约束 2 例外清单与新增约束 5 部署面、全文锚点勘误。**纯文档修订,零代码改动。**

### 交付物

- `docs/narrow-waist-implementation-plan.md`(唯一改动文件):
  1. §0: 约束 2 追加例外清单条款(G.9);新增约束 5"部署面"(G.10);
  2. §1: 交付物总览表——AGENT_CARD.json 移出必交付(G.8)、增 P3.5 行与 §6E(callback-bridge)行(G.1);
  3. §2.1: parseLine/detectVersion 四态、enforceHopBudget/appendVia 函数块、downgradeV3toV2 标注测试辅助(G.4/G.5/G.8);
  4. §2.4: 18 Signal 表(+report 行)与五个白名单常量块(G.3);
  5. §3: 新增"大小预算"行(三档+超限行为+边界用例)(G.6);ttl/via 行补执行规格(G.5);
  6. §4: P2"不动"改"仅限 P2"、P3 交付/验证行改写(A2A_DAIS_DB 沙箱库,G.7)、新增 P3.5 小节(G.1)、P4 验证行 24h 断言化(G.7)、P2/P3 回滚行补 dev-sync(G.10);
  7. §6: 四表加"阶段"列、message-bridge 行改冻结声明、pump 行删过渡改造、新增 §6E 表行、§6C 末风险段删缓解二扩 reader 名单(G.1/G.2);
  8. 全文 14 处行号锚点按 G.0 勘误表重标(函数名锚点为权威)。

### 验收断言(可执行)

```bash
P=docs/narrow-waist-implementation-plan.md
grep -c "P3.5" $P                      # ≥5,且含 "### P3.5" 小节标题
grep -c "仅限 P2" $P                   # ≥1(P2 不动行)
! grep -q "或 P3 内同步" $P            # 缓解二已删
! grep -q "换 import 删内联" $P        # pump 过渡改造已删
! grep -q "TYPES 改共享常量" $P        # message-bridge 改造已删
grep -q "report" $P && grep -q "18 Signal" $P
for c in DSH_CALLBACK_TYPES MSGBR_CALLBACK_TYPES A2A_ROUTER_TYPES CB_SEND_TYPES SESSION_SEND_TYPES; do grep -q $c $P; done
grep -q "legacy" $P && grep -q "malformed" $P && grep -q "enforceHopBudget" $P
grep -q "ttl-exhausted" $P && grep -q "loop-detected" $P && grep -q "六条" $P
grep -q "大小预算" $P && grep -q "4096" $P && grep -q "256KB" $P
grep -q "A2A_DAIS_DB" $P && grep -q "dsh-comm-sandbox/run.sh" $P
grep -q "dead.log 行数与冒烟基线差 == 0" $P && grep -q "router-journal" $P
! grep -q "shared/skills/maestro-bridge" $P   # AGENT_CARD 路径已修正
grep -q "测试辅助" $P && grep -q "例外清单" $P && grep -q "部署面" $P && grep -q "_narrow-waist" $P
# 勘误: 旧锚点不再出现
! grep -qE "file-router.js:61-106|session-send:21-28|fleet-touch:105-118|http-server.js:45 " $P
# §6 表阶段列: 逐表抽查每行行首单元格 ∈ {P1,P2,P3,P3.5,P4,不动,无改造,过渡期}
```
另: 人工复核一遍——修订后文档逐条覆盖 `.nw-spec-raw-G.md` §G.0–§G.10 全部裁决项(对照打勾),引用行号与现码锚点抽查 ≥10 处(以 read 亲证,函数名锚点必须在位)。

### 依赖与顺序

- 前置: 无(纯文档)。**本票先行**——修订版方案是 P1/P2/P3/P3.5/P4/P5 全部实施票的文本基线。
- 与其他 spec 节票的边界: 本票只落 G 节裁决;R-B05(P2 判据)/R-B02~R-B04/R-B14~R-B16(库 API)/R-B06/R-B07(§6C 内容)/R-B08~R-B12(P4 重写)等归对应节票。若后续票重写同段,以本票落定的**结构框架**(阶段列、断言格式、例外清单机制)为准,内容级覆写允许。

### 回报契约

"开工第一动作: ~/.dsh/maestro/bin/cb-send ack impl@omp nw-planner@orca-main nw-T1 'turn started';完成后(≤300字摘要): cb-send done impl@omp nw-planner@orca-main nw-T1 '<结论;产物路径;剩余>';被阻塞: cb-send ask。done 只发一次。"

### 工作说明

- 工作目录注记: "仓 = /home/yy/tools/maestro-preset-iter(master 的 linked worktree);产物一律写该 worktree;不碰 /home/yy/tools/maestro-preset 主检出,不动生产 ~/.dsh。"
- 步骤: ①ack 回报开工;②通读 `.nw-spec-raw-G.md` 与 `nw-plan-review-report.md` §2/§3;③用 edit 工具按交付物清单 1→8 顺序修订 plan(保持原文表格/代码块风格,篇幅增长至 ~300 行可接受;**逐字引用 G 节给出的原文块**,不得再发明备选);④跑验收断言命令集;⑤锚点抽查(§G.0 列表逐处 read 亲证);⑥done 回报(≤300 字: 结论/产物路径/剩余)。
- 红线: 不改 `docs/reports/` 下任何文件;不提前实施代码级内容(哪怕"顺手");遇 G 节与现文冲突,以 G 节为准并在 done 摘要中列出冲突点。
