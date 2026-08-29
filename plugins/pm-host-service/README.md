# pm-host-service（P0 — PM-001 壳 + PM-002 HTTP 投影骨架）

maestro 编排面的**只读投影服务**（ADR-002）。本目录 PM-001 交付插件壳 + 自举 systemd user unit（ADR-003 模式 iii）；PM-002 交付 HTTP 投影 API 骨架（随机端口 / pm.port 端口文件 / 单实例 flock / `GET /health` 桩）；PM-003..007 已续建 op=tickets/fleet/trace/flow 读投影与 `/subscribe` SSE 事件扇出；PM-008 已交付写透传 `POST /op/act`；PM-009 已交付健康元端点（逐源 live/degraded + 版本 + 自举状态）。

## 形态红线

- 零 npm 依赖，纯 `node:*` ESM（`package.json` 的 `type:module` 锚定解析）
- dsh 插件入口 `export inject + apply(ctx)`；`inject: []`（壳不依赖 host 服务）
- 幂等方法循 ADR-007：PM-001 键 `pm-host-service@<MAESTRO_HOME>`；PM-002 键 = 端口文件路径 `<MAESTRO_HOME>/maestro/pm.port`
- 状态存储：文件（unit + 端口文件 + append-only 日志）；SQLite 仅当 R1/R3 触发（ADR-007.2），本组件不建
- 无写死用户名路径：所有路径渲染期解析（`MAESTRO_HOME`/`XDG_CONFIG_HOME`/`import.meta.url`）

## apply() 副作用与幂等策略（ADR-007 五要素）

| # | 副作用 | 动作 | 幂等策略 |
|---|---|---|---|
| ③ | 日志目录 | `mkdir -p $MAESTRO_HOME/maestro/logs/pm-host-service` | 存在即 no-op |
| ① | unit 写入 | 渲染包内 `pm-host-service.service.template` → `~/.config/systemd/user/pm-host-service.service` | temp+rename 原子替换；已存在且字节一致 → 跳过；实际(重)写才 `daemon-reload` + `try-restart`（stale exec 线不得继续服役） |
| ② | 启停 | `systemctl --user enable --now pm-host-service` | 已 enabled → 跳过（enabled 但 inactive 时仅 repair-start） |

重复 apply 零变更（重放路径全 skip）。unit 运行态由 systemd 自管。

## daemon（service.mjs）副作用与幂等策略（PM-002）

| 副作用 | 动作 | 幂等策略 |
|---|---|---|
| ① 监听 | `server.listen(0, '127.0.0.1')` 随机端口 | 重启即换新端口；旧端口自然失效 |
| ② 端口文件 | `pm.port` = JSON 元数据（port/pid/version/startedAt），0600 | temp+rename；单写者由 flock 保证 |
| ② token 说明 | `pm.token` 说明文件（非凭据），0600 | 内容一致 → 跳过写；ADR-005 公网豁免：鉴权为可选占位，默认关闭（仅 `PM_HOST_SERVICE_TOKEN` 非空时启用 Bearer 校验） |
| ③ 单实例 | daemon 内持有 `flock(2)` 锁 `$MAESTRO_HOME/maestro/pm-host-service.lock` | node 打开锁文件, 短命 `flock -n <fd>` 子进程把 LOCK_EX 绑到共享 open-file-description, fd 不关锁不失; 抢锁失败的实例干净退出 0(不触发 Restart 风暴), 锁随进程死亡自动释放。锁在 daemon 内的原因: flock(1) 包裹 ExecStart 会成为 MainPID, 其信号死亡被 Restart=on-failure 豁免, kill 门拉回失效 |
| ④ 票面读 | `GET /op/tickets`: 首拉 `$MAESTRO_HOME/maestro/bin/ledger ticket list --json`, 之后按 `tickets.md` 签名(mtime_ns+size, BigInt stat)轮询增量 | 只读天然幂等: 签名未变 → 内存缓存直出(零 CLI 调用、零写盘); 签名变 → 重拉+游标更新。游标 `state/tickets.cursor.json`(0600, temp+rename, 内容一致跳过)。**降级纪律**: ledger 停走(PATH 移除模拟杀 `env python3` shebang)或非零退出 → 仍 200 + `degraded:true` + note(有缓存给 stale, 无缓存给空态), 绝不 5xx。本进程从不打开 ledger sqlite(ADR-002 只读红线) |
| ⑤ 席位读 | `GET /op/fleet`: `fleet.json` 直读(`bin/fleet-list` CLI 为 fallback 权威) + dsh loopback `POST /api/session.list`(client-request 帧, `DSH_PORT` 缺省 3080, 8s abort) join | **无写盘**(内存 join 实时计算, ADR-007.2: 零状态)。join 仅取身份+存活字段(running/blank/preset/cwd/title), 刻意排除 updatedAt/token 等易变指标 → 同上游重放逐字节一致(sha 相同); 席位按 code 排序。**降级纪律**: dsh 不可达/超时 → 200 + 纯 fleet 视图 + `degraded:true` + note; fleet 源全灭 → 200 + 空态 + note |
| ⑥ 轨迹读 | `GET /op/trace?sessionId=…&type=&tool=&text=&seqFrom=&seqTo=`: `sessions/<bucket>/<sid>/session.jsonl.zstd` 直读(bucket 扫描 = session-purge findSessionDir 模式; 多帧 zstd 按 magic `28 B5 2F FD` 切分逐帧解压, node 只解首帧; 单槽内存解码缓存按 mtime_ns+size 失效) | **无写盘**(单槽内存缓存)。过滤: type 精确(逗号列表)/tool(`data.name`)/text(原始行子串, 大小写不敏感)/seq 区间(记录显式 `seq`)。**head.compact 折叠**(KG 14 §2.5, ADR-010 JS 语义等价): 过滤负载 >20000 字符 → 旧头部折叠为**单行确定性快照** `trace.compact`(计数/seq 区间/类型直方图/reason:"threshold", 零 LLM), 最近尾部原样保留 → sha 稳定重放。`folded` 语义 = **折叠已应用**: 判定量是实际下发负载的重序列化长度 `matched.payload_chars`(转义可使其高于原始字符和 `matched.chars`), 二者均已暴露。**降级纪律**: sessionId 缺失 400; 目录/文件不可读 → 200 + `degraded:true` + note; 断尾帧截断保留已解部分并标记 `logTruncated` |
| ⑦ 流程读 | `GET /op/flow`: `flows/<id>/state.db` 逐库 `node:sqlite` **只读连接**(零 npm 依赖), 查 `v_status`/`v_rollup` 视图, `ORDER BY` 稳定输出 | **无写盘**(只读句柄, ADR-002 红线)。**按库降级**: 单库被锁/不可读只标记该 flow(`degraded:true`+note), 其余照常 200, 绝不 5xx; 全部库不可读 → `flowc inspect` CLI 轮询兜底(原样文本, 不解析表格式), 仍败 → 空态+note。锁模拟备注: 库为 WAL, 写者锁不挡读者(SQLite 语义), 不可读(chmod 000)是等价"不可用"模拟, 走同一打开失败路径 |
| ⑧ 事件扇出 | `GET /subscribe?consumer=<sessionId>&kinds=<csv>` SSE 长连接: fs.watch 三数据面(`maestro/` 目录按文件名过滤 ledger.db / ledger.db-wal / fleet.json; `flows/` 递归) → 签名投影 → 推送; **双通道**第二通道 = 2s reconcile 轮询(inotify 尽力而为, 同时天然构成"同一变更双投递"实测路径) | 订阅幂等键 `(consumer, kinds)`: 同 consumer 再订阅 → 旧流收 `pm_sub_ended` 帧后终止, 新流接管(单 consumer 单活流)。事件幂等键 `(source, msgid)`, msgid 确定性 = `<kind>:<base>:<mtime_ns>:<size>` → 双通道同变更同 msgid, 60s 去重窗只放行一帧(恰好一次)。订阅先快照回放(环形缓冲 ≤50, kinds 过滤, 同 boot 游标后续发)再增量; 跨 boot 游标 → 全环回放(seq 只在单 boot 内可比)。**存储**(ADR-007.2 文件): `state/subscribers/<consumer>.json` 游标 + `state/subscribers/dedup.json` 去重窗(60s, >1000 行截半 GC, 重启恢复 60s 幸存者), 均 temp+rename 内容一致跳过。15s SSE 注释 ping(`: ping`)防代理空闲断连 |
| ⑨ 写透传 | `POST /op/act` body `{"tool":"ledger\|flowc","args":[…],"ref":"vh-<8hex>"?}`: **本进程绝不实现账本写入、绝不打开 sqlite 写句柄**(ADR-002 P0 红线)——写动作一律 spawn 白名单 maestro CLI 透传(调用方按 ADR-007 只选天然幂等动词), 异步 spawn, 立即回 phase-1 回执 `{accepted,ref}` | 幂等键 = 每动作 `ref`(`vh-<8hex>`, `node:crypto` 铸造; 客户端重试可自带同格式 ref): **同 ref 重放 → 查登记表直答(replay:true), 零二次 CLI 调用**。CLI 完成(含死亡: spawn 失败/非零退出/30s 超时 SIGKILL)→ 经 PM-007 扇出 kind=`act` 事件带 ref 回流(tripwire: error 必达)。**存储**(ADR-007.2 文件): `state/act/registry.json` 在飞+终态登记表(temp+rename; 终态 >1000 条截半 GC, 只 GC 终态; boot 时孤儿 flying → `interrupted`, 重放如实上报, 换新 ref 重投) + `state/act/audit.jsonl` 审计(append-only, accept+settle 各一行; **写失败仅告警不阻断主链**)。读回: `GET /op/act?ref=` 单条 / `GET /op/act` 汇总(cliSpawns 计数为门证据面) |

骨架路由：`GET /health` → 200 健康元端点（PM-009：逐源 live/degraded + 版本 + 自举状态，永不 5xx）；`GET /op/tickets` → 票面读投影（PM-003）；`GET /op/fleet` → 席位读投影（PM-004）；`GET /op/trace` → 轨迹读投影（PM-005）；`GET /op/flow` → 流程读投影（PM-006）；`GET /subscribe?consumer=<sessionId>&kinds=<csv>` → SSE 事件扇出（PM-007）；`POST /op/act` → 写透传（PM-008，唯一写路径）；`GET /op/act?ref=<vh-hex8>` → 动作读回；非 GET 且非 `/op/act` → 405（只读红线）；其余 → 404。stdout/stderr 走 journald；业务日志 `$MAESTRO_HOME/maestro/logs/pm-host-service/daemon.log`（>2MB 滚动）。

## 健康元端点（PM-009）

`GET /health` 恒 200（供 tk 渲染空态；任何探针失败只降级对应源，端点绝不 5xx）：

```json
{
  "status": "ok | degraded",            // 任一源 degraded 即 degraded
  "service": "pm-host-service", "version": "…", "pid": …, "uptime_s": …, "bootId": "…", "tokenAuth": false,
  "bootstrap": { "unit": "pm-host-service", "unitFile": {"path","exists","readable"}, "enabled": "enabled|disabled|not-found|unavailable", "active": "…", "systemctl": "ok|missing" },
  "sources": {
    "ledger":     { "live": …, "ledgerDb": {exists,readable,size,mtime}, "ledgerCli": {executable} },   // PM-003 源
    "tickets_md": { "live": …, "file": {…} },                                                            // 签名面
    "fleet":      { "live": …, "fleetJson": {…}, "fleetListCli": {…} },                                  // PM-004 源
    "dsh_api":    { "live": …, "url": "127.0.0.1:3080/api/session.list", "note": … },                    // fleet join 面(1s 预算)
    "sessions":   { "live": …, "root": …, "buckets": N },                                                // PM-005 源
    "flows":      { "live": …, "total": N, "readable": N, "flows": [{"flow","live","note"}], "degradedFlows": […] }, // PM-006 逐库 SQL 自走
    "singleton":  { "live": …, "state": "held|unavailable", "note": "…" }                                // HF-014: flock 单例态(fail-open 可见化)
  },
  "degraded": ["…"],                     // 当前降级源名列表
  "note": "…"
}
```

探针纪律：全部只读（文件 stat+open 探可读，chmod 000 = exists 但不可读 → 降级；flows 逐库 `node:sqlite` readOnly 连接真跑 `SELECT COUNT(*) FROM v_status`；dsh_api 复用 fleet join 的 loopback RPC，1s abort）；**absent ≠ broken（HF-009）**：`ledger.db` 缺席（fresh 系统，票面拉取面是 CLI）与 flows 根缺席/空目录均判 `live:true` 健康空态，只有"存在但不可读"才降级；`systemctl --user is-enabled/is-active` 结果缓存 5s，自举字段**可见即可见性契约**，不参与顶层 status 判定；探针各自 try/catch，单个探针崩溃只降级该源。

## 网关对齐（PM-008 / 写透传冻结假设对照）

- 请求：`POST /op/act`，body `{"tool":"ledger|flowc","args":["…"],"ref":"vh-<8hex>"?}`；`ref` 可省（服务端铸造 `vh-<8hex>`）；tool 白名单外/args 非字符串数组/ref 格式非法/body >16KB → 400（allowlist 随错误返回）。
- phase-1 回执（立即）：`{op:"act",accepted:true,ref,replay:false,status:"flying",tool,…}`——同步等待只到"已受理+已登记+已 spawn"，不等 CLI。
- 同 ref 重放：`{accepted:true,ref,replay:true,status:<flying|ok|error|interrupted>,…}`——登记表直答，**零二次 CLI 调用**；`interrupted` = 上个 daemon 中途死亡（换新 ref 重投）。
- 完成回流：PM-007 扇出 kind=`act` 事件帧（加性字段）：`data: {"t":"pm.event","seq":N,"msgid":"act:<ref>:<status>:<ms>","source":"act","kind":"act","path":"act/<ref>","ref":…,"tool":…,"args":[…],"status":"ok|error","exitCode":N|null,"ms":N,"err":…,"replay":bool}`——**error 事件必达**（spawn 失败/非零退出/超时均 settle 为 error 并照常扇出 = tripwire）。**跨 boot 孤儿（HF-008）**：boot 扫登记表发现 `flying` 遗留 → 置 `interrupted` 并**补落 act.settle(interrupted) 审计行 + kind=act interrupted 扇出事件**（后连订阅者经环回放收到 `replay:true`），tripwire 语义跨 boot 成立。
- 审计：`state/act/audit.jsonl` 每动作两行（`act.accept` / `act.settle`），append-only，**0600**（创建即 0600；历史 0644/0664 文件在下次追加时治愈回 0600——HF-007，对齐 registry.json）；写失败仅 daemon.log 告警，主链路（回执→CLI→settle 事件）不受阻。
- 安全边界：端点自身零账本写入（ADR-002）；动词幂等性由调用方按 ADR-007 选用天然幂等动词（如 `ledger ticket state`、`flowc advance`）。

## 网关对齐（PM-007 / GW-002 冻结假设对照）

- 路径/查询：`GET /subscribe?consumer=<sessionId>&kinds=<csv>` —— 与冻结假设一致；`consumer` 缺失 → 400；`kinds` 省略/空 = 订阅全部（`tickets,fleet,flow`）；未知 kind 静默忽略。
- 事件帧：`data: {"t":"pm.event","seq":N,"msgid":"…","source":"ledger|fleet|flows","kind":"tickets|fleet|flow","path":"…","replay":bool}` —— 服务器侧 msgid 保留；**增量帧额外带 `replay:false`、回放帧 `replay:true`**（加性字段，供网关区分快照/增量，不改变帧型）。
- 快照先行：订阅建立即回放环形缓冲（≤50 条, kinds 过滤），随后增量。
- 终止帧：服务器主动终结流时发 `{"t":"pm_sub_ended","consumer":…,"reason":"replaced"}`（同 consumer 重订阅顶替旧流）；客户端主动断开不发帧，仅清理——重连由持久游标兜底。
- 保活：每 15s 一行 SSE 注释 `: ping`（任何 SSE 解析器均忽略）。
- **已声偏差**：① 每 consumer 单活流——幂等键虽为 `(consumer,kinds)`，同 consumer 换 kinds 订阅同样顶替旧流而非并存；② 跨 daemon 重启 seq 归零——游标按 bootId 判代，跨 boot 一律全环回放（≤50），无重无漏由 msgid 去重兜底；③ 帧内无 wall-clock 字段（时间只在磁盘游标文件里），网关侧计时自行打点。

## unit 要点

- `WantedBy=default.target`（ADR-003 模式 iii，循 hardlink.path/watchd.service 先例）
- `Restart=on-failure` + `RestartSec=2` + `StartLimitIntervalSec=0`（kill 后 ≤10s 拉回；不自锁）
- `ExecStart=<node> <service.mjs>`（渲染期解析绝对路径; daemon 即 MainPID）
- `StartLimitIntervalSec=0` 位于 `[Unit]` 段（放 `[Service]` 会被 systemd 255 静默忽略）
- daemon 把 SIGTERM/SIGINT 转为非零退出：`systemctl stop` 仍保持停止（stop job 抑制 Restart=），裸 `kill` 会被拉回

## 部署与自举（ADR-003 模式 iii）

- 代码随 maestro-preset 分发，install.sh 落 `~/.dsh/plugins/pm-host-service/`；dsh 首次加载本插件即代装 + enable unit，此后 boot 常驻，dsh 死它不死。
- polyfill.patch.yml 注册**不在** PM-001 副作用清单内：壳由 unit 直拉，可独立于 dsh 运行；后续票再议挂载。
- **linger**：unit 为 user 级。要求无人登录也常驻时，手动执行一次幂等动词
  `loginctl enable-linger $USER`（按 ADR-003 文档要求记录于此；apply() 不代执行，避免越出副作用清单）。

## 验证门（收口 = 整门 ×2 全绿）

PM-001（spec §PM-001）：

```bash
node -e "import(process.argv[1]).then(m=>console.log(JSON.stringify(m.apply({}),null,2)))" "$PWD/index.js"  # apply
systemctl --user is-active pm-host-service                          # 门1: active
kill "$(systemctl --user show -p MainPID --value pm-host-service)"
sleep 3 && systemctl --user is-active pm-host-service               # 门2: active（MainPID 已换，≤10s）
node -e "…" "$PWD/index.js"                                          # 门3: 全 skip，零变更
```

PM-002（spec §PM-002）：重启进程后 `pm.port` 更新且旧端口失效（curl 旧端口 refused / 新端口 200）；并发两次裸启动仅单实例存活（撞 systemd 真锁双退 0；互抢临时锁恰好一活）；PM-001 三门回归绿。

PM-003（spec §PM-003）：op=tickets 重放（签名未变）零 CLI 调用零写盘、负载逐字节一致；touch tickets.md（签名变）→ 重拉+游标更新；ledger 停走（PATH 移除模拟）→ 200 + `degraded:true` + note + 空态，不 5xx；回归：PM-001 三门 + PM-002 重启漂移/flock 全绿。

PM-004（spec §PM-004）：op=fleet join 活跃（sessionJoined:true）；幂等重放 sha 一致；dsh API 指向不存在端口 → 200 + 纯 fleet 视图 + `degraded:true` + note；回归：PM-001 三门 + PM-002 flock/端口漂移 + PM-003 三门全绿。

PM-005（spec §PM-005）：合成大 session（>20k 字符）折叠生效（`trace.compact` 快照行 + 尾部保留，after ≤ 预算）；过滤参数重放 sha 一致；真实 session 直读折叠 + text 过滤重放；回归：PM-001..004 全部门绿。

PM-006（spec §PM-006）：op=flow SQL 自走（只读并发连接交叉核对行数一致）；state.db 不可读 → 该库降级不 5xx、其余库照常；回归：PM-001..005 全部门绿。

PM-007（spec §PM-007）：同一变更双投递（watch + reconcile 双通道同触一次 touch）→ 消费端恰一帧（按 msgid 计数=1）；断线重连（首连收 E1/E2 → 断线 → E3 落环 → 重连回放 E3 `replay:true` 不含 E1/E2 → 增量 E4 `replay:false`，四 msgid 全局各恰一帧 = 无重无漏）；同 consumer 二次订阅 → 旧流收 `pm_sub_ended`、新流不受扰；缺 `consumer` → 400；回归：PM-001..006 全部门绿。

PM-008（spec §PM-008）：G1 同 ref 重放 → 零二次 CLI 调用（fixture CLI 调用日志恰一行 + 汇总 `cliSpawns` 不增 + `replay:true`，受理态与终态两相位均验）；G2 CLI 死亡 → tripwire 必报（shebang 失效 spawn 失败 / 非零退出两路均 settle `status:error` 且 kind=act error 事件必达，daemon /health 仍 200）；G3 审计写失败（chmod 000 audit.jsonl）→ phase-1 回执照发、CLI 照跑、settle 事件照达、登记表照更新，daemon.log 出现 AUDIT WRITE FAILED 告警，恢复权限后审计续写；回归：PM-001..007 全部门绿（0.7.0 基线）。

PM-009（spec §PM-009）：G1 正常态 → 全源 `live:true` + `version` 可见 + 顶层 `status:"ok"`；G2 逐源挂（chmod 000 ledger.db / 移走 tickets.md / chmod 000 fleet.json / chmod 000 flows/*/state.db / chmod 000 sessions root / 断 dsh_api）→ 逐源 `live:false` 顶层 `status:"degraded"` 且恒 HTTP 200，全源齐挂仍 200+degraded，恢复后自愈回 ok；G3 自举状态可见（`bootstrap.enabled/active/unitFile` 字段在场；live 上 `enabled=="enabled" && active=="active"`）；回归：PM-001..008 全部门绿（0.8.0 基线含 op=act）。

## 门证据留存与回归脚本入库（HF-013）

- **回归脚本入库**（随票演进）：`gates/pm001-007-gate.mjs` + `gates/pm001-007-regression.sh`（PM-001..007 全子句：live 部分 PM-001 systemd 三门 + PM-002 端口漂移/活锁 + 读面冒烟；沙箱部分逐条断言 ledger 降级 / dsh 死 / 折叠+过滤 / db 不可读 / exactly-once+断线重连）、`gates/pm008-regression.sh`、`gates/pm009-regression.sh`。脚本运行时把版本钉在**本仓 package.json**（unit ExecStart 指向本仓 checkout，`try-restart` 即部署）——版本号升不破回归。
- **留存策略（②，不落 /tmp）**：一切回归/门产物固定落 `$PM_HOST_SERVICE_GATES_DIR/<label>/<run>/`（默认 `~/.dsh/maestro/logs/pm-host-service/gates`，`PM_HOST_SERVICE_GATES_DIR` 可整体重定向）：regression.log、SSE 临时帧、沙箱树（pm.port/游标/登记表/daemon.log）与 manifest.json 全部留档。
- **重跑纪律（ADR-007.1 证据链）**：收口 = 新回归脚本 live ×2 全绿 + pm008/pm009 既有回归复跑绿，证据目录实测在册（`gates/pm001-007/`、`gates/pm008/`、`gates/pm009/`）。

## 边界

- 只读投影（ADR-002）：不直写任何 sqlite 账本；写侧一律透传 maestro CLI（PM-008 已交付：`POST /op/act`，本进程零账本写入）
- 禁 npm 依赖、禁外发文件；健康元端点已交付（PM-009，`GET /health`）
