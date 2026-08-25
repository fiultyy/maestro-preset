# 0011 — nw-T5: cb-send v3 升格(留 cb-send.v2)+ orca adapter(bin/orca-send)+ 双通道对拍

> 状态: DISPATCHED

## 依据

- 评审报告: **R-B17**(阻断;三选一拍板=受理落盘行透传,spec P3b.1)、**R-S02**(msgid 进受理面双查键+208 回执带 msgid,P3b.2)、**R-S03**(ref 双真相权威=字段,P3b.3)、R-B03/R-B16(受理面双查双记联动)、R-B05(对拍判据=结构等价非字节)、R-S07(cb-send 归 P3;message-bridge 过渡上限)、R-S32(大小预算)、D-N4/D-N7、E-B03。
- spec 节: `docs/reports/.nw-spec-raw-P3b.md`(P3b.1-P3b.7)= 本票唯一实施规格。方案正文 splice(§0-2 例外/§6B 两行/§7-1 注/P3 验收行)由 spec 集成者带回 narrow-waist-implementation-plan.md,**本票不改方案文档**。

## 目标

cb-send 单命令双通道产出**同构 v3 行**(七键,头部四键逐字节不动),msgid 成为受理面可用的去重/回执键(重发保号闭环);DSH→Orca 方向获得产 v3 信封的 `bin/orca-send`(orchestration send Run mailbox 优先,PTY terminal send 降 L1 兜底,产出 ORCA-CB]/DSHMSG] 可 parseLine 载体);全部行为以 `tests/p3-cb-send-a-b-test.sh` 按通道分列锁定。

## 交付物(文件级)

1. `bin/cb-send` — 就地升 v3: 七键载荷(尾部追加 ref/msgid/ver)、`--msgid`/`--ver` 解析(P3b.4)、用法头注释更新;降级链/PORT-R1 零改动。
2. `bin/cb-send.v2` — 新建: 旧 cb-send 字节冻结副本(`git show HEAD:bin/cb-send`,chmod +x)。
3. `bin/orca-send` — 新建(node): 按 P3b.5 九条(库解析链/主路径/PTY 兜底/to 解析/type 翻译/退出码)。
4. `plugins/host-callback-bridge/core/dedup.js` — 新增 `digestKeys(line,parsed)` 双键导出;`digestOf` 保留(=primary);from 缺失整行退化逐字保留。
5. `plugins/host-callback-bridge/http-intake.js` — handleCallback: line 构造尾部条件透传(P3b.1-2)、digestKeys 双查、200/208 增 `"msgid"`。
6. `plugins/host-callback-bridge/file-router.js` — flush 双查接线;deliverPending mark 双记+`meta=parsed.msgid??null`。
7. `plugins/message-bridge/index.js` — 三处一行级过渡: digest 材料条件分流(:286-288)、canonical line 条件透传(:305)、Map 值+208 增 msgid(:293-300/:331-333)。
8. `tests/p3-cb-send-a-b-test.sh` — 新建: P3b.6 全清单(A1-A6/B1-B9/C1/O1-O9/R1-R2)。
9. `shared/maestro-bridge/SKILL.md` — cb-send 节补 v3 行形状+`--msgid`/`--ver`+ref 字段优先/前缀回退一行段;手拼兜底示例保持四键并注明仍受理。

## 验收断言(可执行)

- `bash tests/p3-cb-send-a-b-test.sh` → 全部 `[ ok ]`、exit 0(A/B/C/O/R 全组,含 B6/B7 跨通道与跨版本单次投递、B9 msg-dedup 联动)。
- `bash tests/test_cb_send.sh` 全绿;`node plugins/host-callback-bridge/selftest.mjs` 全绿。
- O9 live 冒烟默认 skip;验收方可选 `NW_T5_LIVE_ORCA=1` 跑一次并按输出的 run id 人工清理。
- `git status` 变更恰好覆盖上列 9 项,无方案文档/agent.cordis.yml/其他插件改动。

## 依赖与顺序

- **依赖 T2(库 `plugins/_narrow-waist/`)**: orca-send 的 createEnvelope/serializeLine/parseLine/resolveAddress、dedupKeys 等价语义以 T2 落地版为准。T2 未就绪时可先做交付物 1-2/4-9(orca-send 与 O2/O5-O8 用 `NW_HOME` 指向 T2 目录跑),最后联调。
- 与 dais 面票(T3/T4)零文件交集,可并行;不改 cordis.yml、不注册插件、不动 agent-presets/、不跑 dev-sync(生产生效归 P3 集成/部署步)。

## 回报契约

开工第一动作: ~/.dsh/maestro/bin/cb-send ack impl@omp nw-planner@orca-main nw-T5 'turn started';完成后(≤300字摘要): cb-send done impl@omp nw-planner@orca-main nw-T5 '<结论;产物路径;剩余>';被阻塞: cb-send ask。done 只发一次。

## 工作目录注记

仓 = /home/yy/tools/maestro-preset-iter(master 的 linked worktree);产物一律写该 worktree;不碰 /home/yy/tools/maestro-preset 主检出,不动生产 ~/.dsh。

## 工作说明

- 建议顺序: ①冻结 cb-send.v2 → ②cb-send v3+参数解析 → ③core/dedup.js digestKeys+两调用点接线 → ④intake/message-bridge 透传与回执 → ⑤跑 R1/R2 回归 → ⑥bin/orca-send → ⑦p3 对拍脚本全清单 → ⑧SKILL 行。
- 关键坑位: python/js 序列化字节差(A2 只对同生产者断字节、跨通道 B1 断结构+键序);ORCA-CB] **禁止**叠 DSHMSG] 双前缀(msg-dedup 按 `']'` 一刀切必析败);ver 透传只认字面 2|3;`--ver 2` 输出必须与 cb-send.v2 逐字节一致(A1);受理面 validate 只查四字段不拒未知键——透传的前提,**勿加键白名单**;mark 双记的 meta=msgid 是 208 回显的唯一数据源;测试全 temp 域,收尾 trap 清理。
- 规格冲突时以 `.nw-spec-raw-P3b.md` 为准;行号漂移以锚函数名为准;仍有歧义 → cb-send ask,勿自行发明。
