# T7 (0013) — dais router 到达事件: notify 收口 enqueue_message + Condvar wait 兜底

> 状态: DISPATCHED

## 依据

- 评审报告 `docs/reports/nw-plan-review-report.md`: §4.⑦ P5 增补专审(notify 收口漏 block_settle 落库点 L229-232;四不变量未列成测试 L238-241)、R-S22(L173/L236,P5 收益对 C 节单向依赖)、R-S25(L142,验证可执行性)、总裁决表 P5 行(L263"修两点后可独立并行")。
- spec 节 P5(最终裁决版,`docs/reports/.nw-spec-raw-P5.md`,并入方案后为 §5.3 修订版)——本票的唯一实施规格。
- T1 提供的**仅是 spec 依据**(窄腰方案定稿);本票不依赖窄腰库(`plugins/_narrow-waist/`)任何代码。

## 目标

把 dais GUI 内 router 线程的"指针注入 500ms~2s 盲轮询"改为"落库即触发": `DieselOrchestrationStore::enqueue_message` 成功返回处单一挂点 notify(同时覆盖 send-message 转发面与 block_settle worker_done 自动入队面);router 循环 `thread::sleep` 改 Condvar `wait_for_arrival`(timeout 兜底,正确性不依赖事件);四不变量 + 事件机制逐条固化为单测;沙箱新旧二进制双跑量延迟。

## 交付物(文件级清单,全部在 /home/yy/warpdotdev/dais)

1. `crates/ai/src/agent/orchestration/arrival.rs` — 新,进程全局到达 hub(`notify_message_arrived`/`current_arrival`/`wait_for_arrival`/`wake_all`,`OnceLock<(Mutex<u64>, Condvar)>` 单调代际)+ 自带单测 3 例;
2. `crates/ai/src/agent/orchestration/mod.rs` — `+pub mod arrival;`;
3. `crates/ai/src/agent/orchestration/store.rs` — `enqueue_message` 尾部(`last_insert_rowid` 成功后、`Ok(seq)` 前)`+arrival::notify_message_arrived()`;Err 路径不 notify;
4. `crates/ai/src/agent/orchestration/router.rs` — spawn 循环 sleep→`wait_for_arrival`(退避映射按 spec P5.2 表: 事件空轮不加深退避;Ok(true) 重置;Err 保持 BACKOFF);`shutdown`/`Drop` 追加 `arrival::wake_all()`;测试 mod 新增 INV-1..4 / E1..E4 共 8 例;
5. `script/p5-router-ab-delay.sh` — 新,沙箱新旧二进制双跑(独立 HOME 隔离;read 位翻转时延主观测量 50ms 粒度;delivered_at−created_at 辅助;断言生产库 mtime 不变);
6. `docs/p5-router-ab-delay-report.md` — 双跑记录(样本数/中位/分布/环境/新旧二进制 commit)。

不动清单(越界即停): MessageType 枚举、`crates/persistence/migrations/`、delivery.rs/idle_detector/prompt_injection/messaging.rs 逻辑、`drain_inbox`/`mark_messages_read`/`get_undelivered_unread`/`mark_delivered` 语义、`block_settle.rs` 与 `agent_sdk/orchestration.rs` 两调用方(挂点收口的意义所在)。

## 验收断言(可执行)

1. `cargo test -p ai agent::orchestration` 全绿,含新增 8 例:
   - INV-1 恒败 executor + Idle probe → 一轮 push_pending 后 `get_undelivered_unread` 仍 2 条(delivered_at 全 NULL);
   - INV-2 投递成功 → unregister+register(丢 watermark)→ 新消息: 旧消息指针恰 1 条(不重)、新消息恰 1 条(不漏);
   - INV-3 显式 `notify_message_arrived()` + Busy probe → executor.writes 空、pending 仍 1 条(零注入);
   - INV-4 push 投递后两行 `read==0`;`drain_inbox` 后 `read==1`;
   - E1 enqueue→指针行 ≤450ms;
   - E2 无任何 notify,消息 ≤2.5s 内仍投递;
   - E3 BACKOFF 态 wait 中 `shutdown()` join ≤200ms 返回;
   - E4 成功 enqueue 使 arrival 代际恰 +1,失败入队代际不变;
2. `script/p5-router-ab-delay.sh` exit 0: 新二进制 read 翻转中位 ≤200ms;旧二进制中位 ≥400ms 且呈 500/2000ms 阶梯;沙箱日志含 "orchestration message router started";生产库 `~/.local/state/dais/warp.sqlite` mtime 不变;
3. `~/.local/bin/dais-build --assert-current` PASS(sentinel=0);
4. 零外溢: 全部单测 in_memory store、双跑全在 `mktemp -d` 沙箱 HOME 下,不写任何真实状态目录、不触生产 GUI。

## 依赖与顺序

- 依赖 T1(仅 spec 依据);与 T2-T6 **零文件交集、零部署轴交集**,可全并行开工。
- 收益注记(R-S22): 对 a2a 重载路径的端到端收益须 T4(direct→status 修复)先行方可在该路径观测;本票验收全走 dais 内生消息面,不受 T4 进度影响。
- 部署窗口与 P4 host 重启不得重叠,间隔 ≥30min(见 spec P5.6);建议 dais 仓开分支 `feat/p5-router-arrival-event` 实施,变更单提交收敛(便于 git revert 回滚)。

## 回报契约

开工第一动作: ~/.dsh/maestro/bin/cb-send ack impl@omp nw-planner@orca-main nw-T7 'turn started';完成后(≤300字摘要): cb-send done impl@omp nw-planner@orca-main nw-T7 '<结论;产物路径;剩余>';被阻塞: cb-send ask。done 只发一次。

## 工作目录注记

仓 = /home/yy/warpdotdev/dais(main 检出);产物一律写该仓;不碰 /home/yy/tools/maestro-preset 主检出,不动生产 ~/.dsh;不动生产库 ~/.local/state/dais/warp.sqlite 与在跑生产 GUI(沙箱验证一律走独立 HOME 的 mktemp 目录)。

## 工作说明

1. 先读 spec P5 节 + 报告 §4.⑦/R-S22/R-S25;亲证锚点(行号可漂、函数名为锚): router.rs `spawn` 循环/drain_and_route/push_pending/shutdown/Drop、store.rs `enqueue_message`(:1119-1160)、block_settle.rs worker_done 入队(:93-107)、agent_sdk/orchestration.rs socket fast-path(:25-33)与 `execute_command`(:141-149)、lib.rs router spawn guard(:1169-1217)。
2. 实施序: arrival.rs(hub+自测)→ store.rs 挂点(+E4)→ router.rs 循环改造(退避映射照 spec P5.2 表;drain_and_route/push_pending 本体一行不动)→ INV/E 用例 → `cargo test -p ai` 全绿。
3. 沙箱双跑: 备份旧二进制 → 构建(必须 `--features orchestration`,用 dais-build 或等价命令+sentinel 断言)→ 脚本双跑 → 记录 `docs/p5-router-ab-delay-report.md`。
4. 分支 + 单提交收敛;done 摘要贴关键数字(新旧中位/样本数/测试计数)。
5. 越界即停: 若发现必须动 migrations/枚举/delivery 投递逻辑才能达成目标,说明理解有偏——cb-send ask,不要擅改。
