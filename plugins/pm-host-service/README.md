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
| ④ 票面读 | `GET /op/tickets`: 首拉 `$MAESTRO_HOME/maestro/bin/ledger ticket list --json`, 之后按 `tickets.md` 签名(mtime_ns+size, BigInt stat)轮询增量 | 只读天然幂等: 签名未变 → 内存缓存直出(零 CLI 调用、零写盘); 签名变 → 重拉+游标更新。游标 `state/tickets.cursor.json`(0600, temp+rename, 内容一致跳过)。**降级纪律**: ledger 停走(PATH 移除模拟杀 `env python3` shebang)或非零退出 → 仍 200 + `degraded:true` + note(有缓存给 stale, 无缓存给空态), 绝不 5xx。**命中路径(HF-016)**: `degraded` 不再永久沿袭拉取时刻健康——每次命中轻量再探(CLI 可执行+ledger.db 缺席或可读, 零 spawn), 探败即 `degraded:true`+note(pull-time cache), 探好自愈 false。本进程从不打开 ledger sqlite(ADR-002 只读红线) |
| ⑤ 席位读 | `GET /op/fleet`: `fleet.json` 直读(`bin/fleet-list` CLI 为 fallback 权威) + dsh loopback `POST /api/session.list`(client-request 帧, `DSH_PORT` 缺省 3080, 8s abort) join | **无写盘**(内存 join 实时计算, ADR-007.2: 零状态)。join 仅取身份+存活字段(running/blank/preset/cwd/title), 刻意排除 updatedAt/token 等易变指标 → 同上游重放逐字节一致(sha 相同); 席位按 code 排序。**降级纪律**: dsh 不可达/超时 → 200 + 纯 fleet 视图 + `degraded:true` + note; fleet 源全灭(fleet.json 缺失/畸形+fallback 败) → 200 + 空态 + note。**空 map(HF-017)**: `{fleet:{}}` 结构合法=零席位在编, 非 degraded(join 照常 `sessionJoined:true`, count 0) |
| ⑥ 轨迹读 | `GET /op/trace?sessionId=…&type=&tool=&text=&seqFrom=&seqTo=`: `sessions/<bucket>/<sid>/session.jsonl.zstd` 直读(bucket 扫描 = session-purge findSessionDir 模式; 多帧 zstd 按 magic `28 B5 2F FD` 切分逐帧解压, node 只解首帧; 单槽内存解码缓存按 mtime_ns+size 失效) | **无写盘**(单槽内存缓存)。过滤: type 精确(逗号列表)/tool(`data.name`)/text(原始行子串, 大小写不敏感)/seq 区间(记录显式 `seq`)。**head.compact 折叠**(KG 14 §2.5, ADR-010 JS 语义等价): 过滤负载 >20000 字符 → 旧头部折叠为**单行确定性快照** `trace.compact`(计数/seq 区间/类型直方图/reason:"threshold", 零 LLM), 最近尾部原样保留 → sha 稳定重放。`folded` 语义 = **折叠已应用**: 判定量是实际下发负载的重序列化长度 `matched.payload_chars`(转义可使其高于原始字符和 `matched.chars`), 二者均已暴露。**降级纪律**: sessionId 缺失 400; 目录/文件不可读 → 200 + `degraded:true` + note; 断尾帧截断保留已解部分并标记 `logTruncated` |
| ⑦ 流程读 | `GET /op/flow`: `flows/<id>/state.db` 逐库 `node:sqlite` **只读连接**(零 npm 依赖), 查 `v_status`/`v_rollup` 视图, `ORDER BY` 稳定输出 | **无写盘**(只读句柄, ADR-002 红线)。**按库降级**: 单库被锁/不可读只标记该 flow(`degraded:true`+note), 其余照常 200, 绝不 5xx; 全部库不可读 → `flowc inspect` CLI 轮询兜底(原样文本, 不解析表格式), 仍败 → 空态+note。锁模拟备注: 库为 WAL, 写者锁不挡读者(SQLite 语义), 不可读(chmod 000)是等价"不可用"模拟, 走同一打开失败路径 |
| ⑧ 事件扇出 | `GET /subscribe?consumer=<sessionId>&kinds=<csv>` SSE 长连接: fs.watch 三数据面(`maestro/` 目录按文件名过滤 ledger.db / ledger.db-wal / fleet.json; `flows/` 递归) → 签名投影 → 推送; **双通道**第二通道 = 2s reconcile 轮询(inotify 尽力而为, 同时天然构成"同一变更双投递"实测路径) | 订阅幂等键 `(consumer, kinds)`: 同 consumer 再订阅 → 旧流收 `pm_sub_ended` 帧后终止, 新流接管(单 consumer 单活流)。事件幂等键 `(source, msgid)`, msgid 确定性 = `<kind>:<base>:<mtime_ns>:<size>` → 双通道同变更同 msgid, 60s 去重窗只放行一帧(恰好一次)。订阅先快照回放(环形缓冲 ≤50, kinds 过滤, 同 boot 游标后续发)再增量; 跨 boot 游标 → 全环回放(seq 只在单 boot 内可比)。**存储**(ADR-007.2 文件): `state/subscribers/<consumer>.json` 游标 + `state/subscribers/dedup.json` 去重窗(60s, >1000 行截半 GC, 重启恢复 60s 幸存者), 均 temp+rename 内容一致跳过。15s SSE 注释 ping(`: ping`)防代理空闲断连 |
| ⑨ 写透传 | `POST /op/act` body `{"tool":"ledger\|flowc","args":[…],"ref":"vh-<8hex>"?}`: **本进程绝不实现账本写入、绝不打开 sqlite 写句柄**(ADR-002 P0 红线)——写动作一律 spawn 白名单 maestro CLI 透传(调用方按 ADR-007 只选天然幂等动词), 异步 spawn, 立即回 phase-1 回执 `{accepted,ref}` | 幂等键 = 每动作 `ref`(`vh-<8hex>`, `node:crypto` 铸造; 客户端重试可自带同格式 ref): **同 ref 重放 → 查登记表直答(replay:true), 零二次 CLI 调用**。CLI 完成(含死亡: spawn 失败/非零退出/30s 超时 SIGKILL)→ 经 PM-007 扇出 kind=`act` 事件带 ref 回流(tripwire: error 必达)。**存储**(ADR-007.2 文件): `state/act/registry.json` 在飞+终态登记表(temp+rename; 终态 >1000 条截半 GC, 只 GC 终态; boot 时孤儿 flying → `interrupted`, 重放如实上报, 换新 ref 重投) + `state/act/audit.jsonl` 审计(append-only, accept+settle 各一行; **写失败仅告警不阻断主链**)。读回: `GET /op/act?ref=` 单条 / `GET /op/act` 汇总(cliSpawns 计数为门证据面) |
| ⑩ 画布图读 | `GET /op/graph`(PMW2-1, spec `docs/specs/spec-pm-web-canvas.md` §1/§2 冻结契约逐字段): 归一 `flows state.db × ledger 票面(PM-003 同一缓存实例, 零二次拉取) × fleet+session join × bridge 近窗 200 行` → **四型节点**(flow-node `fn:<flow>/<id>` / ticket `tk:<id>` / seat `st:<code>` / session `se:<sid>`) × **四义边**(dep / dispatch / callback / cb-send), 边 id `<kind>:<from>><to>`, 响应信封 `op/degraded/note/generatedAt/nodes/edges/counts/sources` | **恒 200**(§5 降级律, 与 /health 的 HF-009 absent≠broken 特例不同源: 本端点照 §2 明文, 源不可读=live:false): 任一源不可读 → 该源贡献空集 + `sources.<源>.live=false` + note + 顶层 `degraded:true`, 绝不 5xx。**悬挂禁止**: 端点节点缺失的边一律丢弃并计入 `sources.<plane>.note`。bridge 句柄解析序: 全形 `alias@session-<uuid>` → 裸席码 → 裸短码唯一前缀(如 `af29`); callback 边 `(from,to)` 解析对去重保留最新, `at`=观测时刻。**cb-send 现为如实空集**: flows/ledger schema 无"编排席位→工作者席位"结构化派发记录(编排者非席位; 2026-08-31 勘察标注, spec §1.2 空集合法)。**SSE 零新增 kind**: 客户端以既有 `tickets/fleet/flow` 事件触发 refetch。会话节点仅随 join 面数据发出(席位会话 + bridge 全形 handle 命中 session.list 者, §2 示例 `se:…orch` 的实现面); join 退化 = session 空集(席位保留 sessionId), spec §1.1 明文合法 |

骨架路由：`GET /health` → 200 健康元端点（PM-009：逐源 live/degraded + 版本 + 自举状态，永不 5xx）；`GET /op/tickets` → 票面读投影（PM-003）；`GET /op/fleet` → 席位读投影（PM-004）；`GET /op/trace` → 轨迹读投影（PM-005）；`GET /op/flow` → 流程读投影（PM-006）；`GET /op/graph` → 画布图读投影（PMW2-1：四型节点×四义边，恒 200）；`GET /subscribe?consumer=<sessionId>&kinds=<csv>` → SSE 事件扇出（PM-007）；`POST /op/act` → 写透传（PM-008，唯一写路径）；`GET /op/act?ref=<vh-hex8>` → 动作读回；非 GET 且非 `/op/act` → 405（只读红线）；其余 → 404。stdout/stderr 走 journald；业务日志 `$MAESTRO_HOME/maestro/logs/pm-host-service/daemon.log`（>2MB 滚动）。

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
- **已声偏差**：① 每 consumer 单活流——幂等键虽为 `(consumer,kinds)`，同 consumer 换 kinds 订阅同样顶替旧流而非并存；② 跨 daemon 重启 seq 归零——游标按 bootId 判代，跨 boot 一律全环回放（≤50 帧 `replay:true`）。该回放**直写流、不经服务端 60s 去重窗**，故**消费端按 `msgid` 去重是无重语义的最终义务**（HF-018 表述固化）：`(source,msgid)` 全局判重、同 msgid 重复帧一律丢弃——环内 msgid 含 `mtime_ns+size`，同一变更跨 boot 稳定不变，消费端判重即无重无漏；③ 帧内无 wall-clock 字段（时间只在磁盘游标文件里），网关侧计时自行打点。

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

PMW2-1（spec spec-pm-web-canvas §1/§2/§5，0.10.0 基线）：沙箱门 `gates/pmw2-1-graph-gate.mjs`（fake dsh session.list + 真形 fixtures：信封键集/四型字段逐字/边 id 规则/dep 方向(票+flow 同构)/dispatch lease/callback 三种句柄解析+解析对去重保留最新/悬挂丢弃进 note/cb-send 如实空集+注记/重放稳定(观测时刻外)；§5 降级注入：flows 根移走 / fleet.json 移走 / bridge log 移走 → 各面 live=false + degraded:true 仍 200；全源缺席 boot → 四面 live=false 零信封完整；红线复验：/op/fleet、/op/tickets、/op/flow 原样、/subscribe 旧 400 契约不变）。活体门 `gates/pmw2-1-live.sh`（try-restart 部署本 checkout → 真-data `/op/graph`：四型节点各 ≥1、dep/dispatch/callback 边各 ≥1、cb-send=0 且带注记、信封/sources 完整、恒 200，证据 JSON+截图落 gates 目录）。回归：pm001-007 / pm008 / pm009 既有全绿。

PMW2-2（spec-pm-web-canvas §3/§4/§5，画布 tab MVP）：门 `gates/pmw2-2-canvas-gate.mjs` 35 断言 —— vendor 钉死（sha256+字节，改一字即 FAIL）+ 沙箱静态面（/elk.bundled.js 字节等价、/elk.js JS MIME、/canvas.js 200、三 tab 零回归）+ live CDP（真数据渲染 207n/165e/16l 截图×3、wheel 缩放指针锚 0.5×–2× clamp、拖拽平移、单泳道取景、hover/点击高亮+空白取消、断 SSE→30s 轮询、断 elk→列表回退不白屏），页面零异常硬门。

PMW2-3（节点抽屉 + 过门 act）：`public/canvas.js` 增量 —— ①**抽屉**：点画布节点开右侧抽屉，四型明细（flow-node: verb/形制/state/所属flow/attempts·events/关联票〔经席位 lease/dispatch 桥 join〕；ticket: state/leaseOwner/deps 跳转 chip/refs 证据链〔path 形可点复制〕；seat: role/node/preset/status/会话态 join；session: running/title/cwd/挂靠席位），refetch 后 `syncDrawer` 回显、节点消失自动关；②**动作面**：仅两类且唯一写路径仍走既有 `POST /op/act` 透传（flow-node → `flowc advance <flow> <node> --result done|failed`；ticket → `ledger ticket state <id> <合法转移>`，迁移表只读镜像自 ledger CLI，随当前状态只列合法目标）；③**确认门**：任何提交前弹层展示动作全文+影响节点；不可逆类（blocked/rejected/merged/rolled-back）双确认 —— 确认钮禁用直至勾选 checkbox；④**act 后**：回执 ref 入抽屉历史（ref+ts+动作+exit/ms/err），双路对账（SSE `kind=act` 事件快路径 + `GET /op/act?ref` 800ms 轮询兜底仲裁 ~32s 超时），settle 后图刷新：SSE 断 → act 响应直刷（setTimeout 0），SSE 在 → 让数据面事件先行 3s 兜底直刷；门证据：`gates/pmw2-3-drawer-gate.mjs` 63 断言 —— 静态门（迁移表镜像/不可逆集/两类 act 构造/双路对账/红线 `git diff` 零触碰 service.mjs+app.js/elk sha256 仍钉死）+ live CDP 四型抽屉各截图+取消路径（只读，零 live act）+ sandbox CDP act 全链（stub ledger/flowc，`ticket state` 时镜像真实 ledger 写 ledger.db 触发 serveTickets 缓存键漂移）：合法转移成功（确认弹层→回执→settle ok→图直显新状态+迁移按钮重算）、不可逆双确认（未勾选确认无效）、取消路径（stub 零调用零历史）、flow advance、断 SSE act 闭环（settle + /op/graph 直刷请求可见），页面零异常。回归：pm001-007 74+13 / pm008 18 / pm009 28 / pmw2-1 54+4 / pmw2-2 35 全绿。

PMW2-4（trace 时间轴回放 + minimap/缩放打磨，末票）：`public/canvas.js` 增量（纯前端，/op/trace 与服务端零改动）—— ①**回放**：画布顶部时间轴控件，「载入回放」拉取图上全部会话的 `/op/trace` 事件流（按 `time` 升序，事件数与 trace 逐条一致），拖动游标重演图状态 —— 游标前命中事件激活节点（session 自身/同席席位/文本提及的 ticket·flow-node，一次性预计算命中表），两端激活的边才亮、其余 `cv-future` 淡出（**回放只切样式零重排**，refetch 冻结守卫，207n/165e 帧率无感）；play/pause/倍速 1×|4×|16×；游标到 now 自动切实况（样式清零 + refetch 立即恢复对齐 SSE 数据面）；②**minimap**：右下角全图缩略（泳道框 + 节点状态色点）+ 视口框，与缩放平移双向联动（拖画布→框动，点/拖 minimap→视图跳转）；③**打磨**：双击节点居中+适配（s≥1.4 clamp 2，收尾选中+抽屉开）、flow 泳道标题常显（header 滚出视口顶 → 顶部 sticky chip）、初始 fitView 全图；④**顺带修复**：`#view-canvas [hidden]{display:none!important}` —— author `display:flex` 曾击穿 `hidden` 语义致抽屉空壳恒显（PMW2-3 引入、属性级断言盲区，回放截图目检暴露）。门证据：`gates/pmw2-4-replay-gate.mjs` 34 断言 —— 静态门（回放/minimap/常显标题/双击/冻结守卫标记 + 红线 `git diff` 零触碰 service.mjs·app.js·index.html + elk sha256 钉死）+ live CDP（载入回放事件数=gate 侧逐会话 trace 和〔502=502 实测〕、游标 30% 回放态节点/边淡出、4× 播放游标推进 ≥2× 实时、暂停、now 切实况+refetch 恢复、minimap 双向联动、双击居中 ±80px、深缩放上滚 sticky ≥1、抽屉冒烟、7 张截图、页面零异常）。回归：pm001-007 74+13 / pm008 18 / pm009 28 / pmw2-1 54+4 / pmw2-2 35 / pmw2-3 63 全绿。

PMW2-F（验收尾差修复，依据 `gates/pm009/pmw2-v-acceptance.md` 缺陷清单）：**D1** — 画布接线 ESC：回放态 ESC = 游标跳 now + 切回实况（spec §4 item 12）；非回放态不抢 ESC（确认门 dialog 原生关闭等既有语义原样，dialog open 时让位）。**D2** — `/op/graph` 暖缓存降级旗标跟源：`gatherTicketGraph` 的 `live` 由「stale 节点在场即 true」改为 `!t.degraded`，与 `/op/tickets` 的 HF-016 轻探针判定同源同值、不造新判据 —— 暖缓存期源 CLI 不可读（注入法照 acceptance EV4(c)：mv stub ledger）→ 双端点一致 degraded:true + sources.tickets.live:false（stale 票节点仍如实服务 + 轻探针 note 透传），复位后双端点回 live；冷路径行为不变（源死=空集+live:false，pmw2-1 SB2 门复验）。门证据：`gates/pmw2-f-fix-gate.mjs` 22 断言（静态标记 + live CDP ESC 全链截图 + sandbox 暖缓存注入三相位）；回归 pm001-007 74+13 / pm008 18 / pm009 28 / pmw2-1 54+4 / pmw2-2 35 / pmw2-3 63 / pmw2-4 34 全绿。

PMW2-G（服务端口钉扎）：**① service.mjs listen** — `PM_PORT` 环境变量优先（数值合法 >0 <65536 才钉，未设/非法 → 仍 `listen(0)` 随机端口，沙箱门零感知）；**钉住端口被占 → fail-fast**：`server.on('error')` 显式 FATAL 行（file→`daemon.log` + stderr→journald，`EADDRINUSE` 可见）+ `process.exit(1)` 非零退出，**绝不静默跳港**（systemd `Restart=on-failure` 拉起即重试可见）；`pm.port` 照旧每次启动写入实际绑定端口+pid。**② 单元钉港** — 模板与已安装 unit 均含 `Environment=PM_PORT=35451`；安装走**合规路径**：PM-001 `index.js apply()` 渲染包内模板 → temp+rename 原子替换 → `daemon-reload` + `try-restart`（字节变了才动），零手补丁。**③ 契约迁移（有意的行为变更，随票更新门）** — 部署信号由「端口漂移」改为「pid 更新 + 端口恒定」：`pm001-007/pm008/pm009-regression.sh`、`pmw2-1-live.sh` live 部署块，与 `pmw2-2/3/4/F` 四门部署等待全部改写（等待以 `pm.port.pid` 翻转=新守护 bind 完成为准，杜绝 pid 已翻 yet 未 bind 的早拉窗口）；沙箱门（无 `PM_PORT`）随机端口语义原样，pm001-007 SB2 `port2 !== port1` 不变。门证据：`gates/pmw2-g-port-gate.mjs` 16 断言 — A 静态（PM_PORT 解析/fail-fast/模板+unit 钉 35451/live pm.port）+ B 沙箱钉港两次恒定 + C 占港 fail-fast（rc=1 + stderr/daemon.log FATAL·EADDRINUSE + 败者不改写 pm.port）+ D 无 PM_PORT 随机兜底 + E live try-restart ×2 恒 35451。

PMW2-H（回放活体全灰急修）：单行根因 — `loadReplay` 的 `_ts: e.time ?? e.time0 ?? null` 保留活体 trace 的**字符串** time（"1788172761057"），拖拽 `R.min + (R.max - R.min) * v / 1000` 在 `R.min` 为字符串时变**字符串拼接** → 游标垃圾 → `replayActiveSet` 恒空 → 全 `cv-future` 全灰；门沙箱合成事件 time 是数值所以没拦住。修：`_ts: Number(e.time ?? e.time0) || null`（数值化 + 空值兜底）。顺带：①载入按钮失败路径复位（`try/catch` → 按钮回「载入回放」可重试 + toast，成功路径不变：载入中态保持到 `R.loaded` 才 hidden + 切出 ctrl）；②pmw2-4 门补 PMW2-H 断言 — 静态（`_ts` 数值化标记 + 载入中态守卫）+ live（游标元数据 `max/cursor` 全 number + 拖 30% 后 0<lit<total 有节点点亮；快照 `R.events` 是计数非数组，断言走可观测面），refetch 恢复检查改轮询（exit 时在途 fetch 会吞 kick、由其完成收敛，不钉死 1200ms 窗口）。CDP 活体复现：修后拖 range → `fut=353`（212 节点+~250 边的真子集）、19 节点点亮。回归全绿：pm001-007 74+13 / pm008 18 / pm009 28 / pmw2-1 54+4 / pmw2-2 35 / pmw2-3 63 / pmw2-4 38 / pmw2-F 22 / pmw2-G 16。

PMW2-I（dsh_api 探针误靶修复）：liveness 探针从 `session.list`（数百会话全投影实测 ~5.35s，必超 1s 健康预算 → abort → 降级横幅间歇闪）改打**廉价 `workspace.list`**（同款 client-request RPC wire，~ms 级，只判活不取数）；席位 join 与 graph session join 继续用 `session.list` 但超时统一放宽 8s→10s（`JOIN_DSH_TIMEOUT_MS`），失败**独立降级**（`/op/fleet` `joined:false` + 原因注记，graph 侧 session 节点空集 + 注记），不连坐 dsh_api liveness；健康面 `sources.dsh_api` 增 `latency_ms` 便于日后观测。红线：`/op/*` 契约零改，只动探针/join 内部。门证据：pm001-007-gate 新增 SB6 双相位 7 断言 — A（session.list rpc 注错 → dsh_api 仍 live + workspace.list url + latency_ms + fleet 降级注记如实 + 纯席位面照常 200）+ B（session.list 慢 2.5s：> 旧 1s 预算、< 10s join 预算 → join 照常成功 + liveness 不被拖累）；全门 81 断言绿。

PMW2-H 复验（编排者活体读数 events:0 疑点，复现属实并修复）：**根因 1 — 载入面过窄**：loadReplay 只取 `type==='session'` 节点的 sessionId，图上带 sessionId 的 seat 型节点被漏掉；**根因 2 — 早点空面锁死**：图未就绪时点「载入回放」→ 0 事件仍置 `loaded:true`，永久全灰（编排者 probe 即此场景，已 CDP 复现）。修：载入面改**全图带 sessionId 节点**；空面轮询等数据面（~20s 上限，`C.refetching` 卡在途时 refetchGraph 秒回故不能只 await 它）；空面/零事件**不锁 loaded**（报错复位可重试）；逐会话 trace fetch 10s deadline（活体大 trace 慢载/楔死降级为空，整条流必结算，按钮不永久卡载入中）；refetchGraph fetch 15s deadline（楔死不得永久占 `C.refetching`，否则 exit 回放 kick 与 3s 对账轮询全被门死）。门：pmw2-4 40 断言（+梯度 lit(90%)>lit(30%)、+载入面/空面静态断言；gate 侧 trace 聚合同口径改全带 sessionId 节点 + 10s deadline 对称）。活体验收（编排者 probe 场景复现）：早点点击 → loaded:true events=89（「回放流就绪: 89 事件 / 3 会话」）→ 拖 30%→90% 点亮 16→19 梯度成立。

PMW2-J（席位 join 缓存 + stale-while-revalidate）：dsh web 宿主退化时 `session.list` >30s，I 修了 liveness 但 join 仍直打，10s 预算到点 → 席位降级横幅间歇闪（用户已遇到）。修：join 结果 **TTL 缓存 60s + SWR** — `/op/fleet` 命中缓存立即回（`degraded:false` + `sessionJoined:true` + 只增字段 `sessionJoinFreshness: fresh|stale`，stale 时 note 带 `age`），**横幅不再闪**；过期后台异步刷新，失败只累积 note（`后台刷新失败 xN (原因)`），绝不影响在途响应；冷启动无缓存首拉仍允许阻塞、超时如实 degraded（现行为）；fresh 命中与冷启动响应**字节一致**（PM-004 replay byte-stable 保持，新鲜度走只增字段）。`PM_JOIN_TIMEOUT_MS`/`PM_JOIN_CACHE_TTL_MS` 供沙箱门调参。门：pm001-007 +SB7 7 断言（冷启动 fresh → 命中字节一致 → 注入 12s 慢源+TTL 过期 → 4ms stale 命中横幅不闪 → 后台刷新失败 x1 只累积 → 恢复后回 fresh 计数清零 → 冷启动慢源阻塞预算后如实 degraded）；PM-004 dsh-death 子句迁移到 SWR 契约（死源时缓存 join 照常服务 + 失败累积，不再 whole-face degraded）。全门 88 断言绿；回归 pm001-009 + pmw2 全绿。

## 门证据留存与回归脚本入库（HF-013）

- **回归脚本入库**（随票演进）：`gates/pm001-007-gate.mjs` + `gates/pm001-007-regression.sh`（PM-001..007 全子句：live 部分 PM-001 systemd 三门 + PM-002 端口漂移/活锁 + 读面冒烟；沙箱部分逐条断言 ledger 降级 / dsh 死 / 折叠+过滤 / db 不可读 / exactly-once+断线重连）、`gates/pm008-regression.sh`、`gates/pm009-regression.sh`、`gates/pmw2-1-graph-gate.mjs` + `gates/pmw2-1-live.sh`（PMW2-1 /op/graph：沙箱契约+降级注入 / 真-data 活体断言+证据）、`gates/pmw2-2-canvas-gate.mjs`（画布 MVP：vendor 钉死/渲染/交互/降级）、`gates/pmw2-3-drawer-gate.mjs`（抽屉+过门 act：四型抽屉/确认门双确认/取消/无 SSE 闭环）、`gates/pmw2-4-replay-gate.mjs`（trace 回放/minimap/常显标题/双击居中）、`gates/pmw2-f-fix-gate.mjs`（D1 ESC 退回放 / D2 暖缓存旗标跟源）、`gates/pmw2-g-port-gate.mjs`（PMW2-G PM_PORT 钉港：fail-fast / 端口恒定 / 随机兜底）。自 PMW2-G 起 live 部署断言契约统一为「pid 更新 + 端口恒定」——`try-restart` 后等待 `pm.port` 由新 pid 重写（=bind 完成），不再等待端口漂移。脚本运行时把版本钉在**本仓 package.json**（unit ExecStart 指向本仓 checkout，`try-restart` 即部署）——版本号升不破回归。
- **留存策略（②，不落 /tmp）**：一切回归/门产物固定落 `$PM_HOST_SERVICE_GATES_DIR/<label>/<run>/`（默认 `~/.dsh/maestro/logs/pm-host-service/gates`，`PM_HOST_SERVICE_GATES_DIR` 可整体重定向）：regression.log、SSE 临时帧、沙箱树（pm.port/游标/登记表/daemon.log）与 manifest.json 全部留档。
- **重跑纪律（ADR-007.1 证据链）**：收口 = 新回归脚本 live ×2 全绿 + pm008/pm009 既有回归复跑绿，证据目录实测在册（`gates/pm001-007/`、`gates/pm008/`、`gates/pm009/`）。

## Vendor 例外（elkjs — 零 npm 宪章唯一例外）

> 例外条款（spec-pm-web-canvas §3 原文入宪，仅此一次，逐字适用）：零 npm 运行时依赖宪章（mvp-plan §6.1）仅开此一例外：`public/elk.bundled.js` 为 elkjs 0.12.0 官方 tarball 内 `lib/elk.bundled.js` 的逐字节原样拷贝（sha256 见下），依上游双许可之 EPL-2.0 条款 vendored；该文件不经 npm/构建/打包工具获取运行时依赖地位，不写入 package.json 依赖项，不做任何派生修改（**修改即失效本例外**，须重新原样 vendor 并更新 sha256）；版本、许可与来源注记常驻本 README。除本文件外，宪章对其余 public/ 文件与全部服务端代码仍然全部适用。

| 项 | 值 |
|---|---|
| 版本 | elkjs 0.12.0（registry latest stable） |
| 许可 | EPL-2.0 OR GPL-3.0-or-later（vendoring 取 EPL-2.0 通道） |
| sha256 | `1222e44f953ce7746af23801e723708f8e6f436b8b377a6a5fc7552f34a307b3` |
| 字节 | 1,609,707 |
| 来源 URL | https://registry.npmjs.org/elkjs/-/elkjs-0.12.0.tgz |
| 落位 | `public/elk.bundled.js`（逐字节）+ `public/LICENSE.elkjs.md`（tarball 内 LICENSE.md 原样）+ `public/elk.js`（薄 ESM 包装，`import './elk.bundled.js'` 后 `export const ELK = globalThis.ELK`；app 代码不触全局） |
| 引入形态 | UMD 单文件（classic `<script>` 或模块副作用 import 均挂 `globalThis.ELK`）；画布代码只经 `elk.mjs` 取 `ELK` |
| 落位偏差注记（PMW2-2 实测） | spec §3 原定 `public/vendor/` 子目录 —— PW-001 静态面为**非递归** boot 快照（`readdirSync(public/)` 顶层文件名直入 allowlist），且本票红线 service.mjs 冻结不动，子目录文件不可达；故落位上移一层至 `public/` 顶层；包装器同理由 `elk.mjs` 落为 `elk.js`（静态面 MIME 表无 `.mjs` —— 模块脚本必须 JS MIME，浏览器对 octet-stream 模块直接拒载）。字节/许可/注记义务全部照行。静态面将来若递归化+补 MIME，可原样移回 `vendor/elk.*` 并更新本节 |

sha256 门：`gates/pmw2-2-canvas-gate.mjs` 校验 `public/elk.bundled.js` 的 sha256 与字节数（≠ 上值即 FAIL）。

## 边界

- 只读投影（ADR-002）：不直写任何 sqlite 账本；写侧一律透传 maestro CLI（PM-008 已交付：`POST /op/act`，本进程零账本写入）
- 禁 npm 依赖、禁外发文件；健康元端点已交付（PM-009，`GET /health`）
