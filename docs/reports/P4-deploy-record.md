# P4 部署与回滚演练记录(T6,2026-08-25)

## pre-flight
- registry 快照: `~/.dsh/maestro/bridge/registry.json` 条目数 = 1(session-9f5a1d3a,host lane 域)
- http.port 持有进程: ss -tlnp 待生产切换时采集(安静窗口判定)
- queen armed 会话: 无(需在切换窗口复检)

## 沙箱正向演练(DSH_HOME=$(mktemp -d),零生产接触)
- ② dev-sync 全量重推: 装点 + bin 镜像 + polyfill lane(host-callback-bridge + _narrow-waist)✓
- ③ --verify 四段清零 ✓
- ④ `diff -rq plugins/_narrow-waist $SBX/plugins/_narrow-waist` 清零 ✓
- 装点 cordis: callback-bridge 行 5 处命中(含注释),orca-callback/message-bridge 0 行 ✓
- `node -e "import('$SBX/plugins/host-callback-bridge/index.js')"` → import-ok(装点自包含,_narrow-waist 在位)✓
- 注记: dev-sync 附带 shared skill 同步到 ~/.agents/skills(既有行为面,非部署三面,生产切换时属预期副作用)

## 沙箱回滚演练(git stash 模拟单提交 revert)
- ① stash 本批 → ② dev-sync 旧代码重推 ✓
- 装点 cordis 复含 orca-callback/message-bridge(6 命中)、无 v4 行(0)✓
- _narrow-waist 目录残留于沙箱(旧 dev-sync 无同步段不清理它;生产回滚时旧 cb-send 不读该目录,无害;下次正向同步自动对齐)✓
- stash 弹回完整(改动 + untracked 全回)✓

## 回归矩阵(单提交前)
- callback-bridge: 38/38(--test-force-exit;Node 24 目录参数空转 + 存量 teardown 竞态导致无 force-exit 挂起,HEAD 版同病,非本批引入)
- _narrow-waist: 58/58(oracle 改判: pump.js/message-bridge 已删,oracle 换 core re-export 链与冻结字面)
- test_cb_send.sh: 17/17(sig 用例改"残留不拦截"+⑥ v3 七键)
- host-callback-bridge selftest: 35/35
- p3-cb-send-a-b-test.sh: 26/26(C1 改判 post-P4)
- p2-a-b-test.sh: 38/38(未受影响)

## 生产切换(待安静窗口,cb-send ask 请示后执行)
- 六步链: 单提交 → dev-sync → verify → 删 http.port.sig → 重启 :3080 → p4-smoke + 24h p4-watch

## 生产切换执行(2026-08-25 15:18-15:26, 窗口令授权)

pre-flight(planner 复验 15:18 + 本侧快照):
- 无在飞编排(最后回报 = T7 done);bridge/registry.json consumers=12(含 planner holder)
- :3080 持有 pid 322941(`dsh --profile web`, systemd 用户单元 dsh-web.service)——预期
- :3081 沙箱在线(pid 953109)

六步链实录:
1. dev-sync ✓(正向同步,shared skills 两项回显)
2. dev-sync --verify 四段清零 ✓(装点/回流/镜像/polyfill lane 全零)
3. rm ~/.dsh/maestro/bridge/http.port.sig ✓(PORT-R1 退役,45B,2026-08-23 遗留)
4. systemctl --user restart dsh-web ✓(15:20:07;新 pid 2979936,active,:3080 LISTEN 恢复;planner 会话中断属预期,用户自行刷新)
5. p4-smoke 五路径 6/6 全绿 ✓(①cb-send http 200+异 msgid 200;②session-send rc0;③journal 基线 31;④⑤Orca 面由验收方会话执行;共同断言 dead.log 零新增(81)+去重窗同 msgid 208)
6. p4-watch ✓: baseline 落 ~/.dsh/maestro/bridge/p4-watch-baseline-20260825.json(deadLines=81/counters.failed=0/rjFailed=0);24h watch 以 persistent 进程 p4-watch-24h(pid 2983244)托管,每 30min check 一次,留痕 ~/.dsh/maestro/bridge/p4-watch-24h.log

切换后基线核验: host-lane.log 837 行续写,registry consumers 12(持久文件),冒烟无 dead 新增。

dais 侧(P5 装车): 与本切换间隔 ≥30min 排期(见 T7 票面);新二进制已在 target 原位(dais-build --assert-current PASS,sentinel=0),生效待 dais GUI 自然重启。

## 24h p4-watch 结论(2026-08-25 15:21 → 08-26 15:21, 48 tick)

三断言终态:
- **counters.failed == 基线(0) PASS** — host lane 24h 零失败投递
- **router-journal failed == 基线(0) PASS** — a2a 重载面(live-vo007/live-vo012)零 failed
- **dead.log 零新增 FAIL** — 81→92(+11), 全部 triage 为非投递面问题(见下), 无一为 P4 拓扑回归

+11 行逐条分类:
| 行 | 时点(CST) | 内容 | 定性 |
|---|---|---|---|
| 82 | 08-25 15:22 | 本侧 T6 done 回报 to=nw-planner@orca-main, :3080 重启后 orca-main 消费者尚未重注册(cb-send 已按预期落 file-bridge 兜底) | 窗口期瞬态, 预期内 |
| 83-88 | 08-26 00:04 | health@check 广播探针(to=*)命中 6 条陈旧 registry 会话(session-not-found ×6) | 陈旧注册项清理噪声; **planner(orch1)已于 00:10 复核并重采基线=88** |
| 89-90 | 08-26 00:04 | maestro/vh-voice-liaison 回 pong 至 health@check — 探针发送方自注册缺失, 回信无消费方 | 探针发送面卫生问题, 死信行为正确(reason 明确) |
| 91-92 | 08-26 13:44 | f326 ack/done 至 voice-head-a2a — 该别名未注册 | voice-head lane 自身寻址配置缺口, 非本面问题 |

遗留(移交 planner 裁量, 非本票范围):
1. registry 含 ≥6 条 session-not-found 陈旧会话 — 可用 bin/session-purge 清(生产面, 需授权)
2. health@check 类探针应自注册消费方或明示单向 — 探针操作方(orch1)侧修订
3. voice-head-a2a 别名未注册 — voice-head lane 配置项

结论: **P4 切换后 24h 投递面零失败(dead 计数器/failed/journal 三者中除 dead 行数外全绿; dead +11 全部为死信正确落账, 行为符合窄腰设计 = 死信+明确 reason)**。窗口后 dead 稳定于 92(13:44 后无新增)。
