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
