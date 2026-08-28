# pm-host-service（P0 — PM-001 壳 + PM-002 HTTP 投影骨架）

maestro 编排面的**只读投影服务**（ADR-002）。本目录 PM-001 交付插件壳 + 自举 systemd user unit（ADR-003 模式 iii）；PM-002 交付 HTTP 投影 API 骨架（随机端口 / pm.port 端口文件 / 单实例 flock / `GET /health` 桩）。op=tickets/fleet/trace/flow、事件扇出、写透传由 PM-003..009 在同一包内续建。

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

骨架路由：`GET /health` → 200 状态桩（完整 health/degraded 元端点属 PM-009）；`GET /op/tickets` → 票面读投影（PM-003）；`GET /op/fleet` → 席位读投影（PM-004）；非 GET → 405（只读红线）；其余 → 404（PM-005..006 端点占位）。stdout/stderr 走 journald；业务日志 `$MAESTRO_HOME/maestro/logs/pm-host-service/daemon.log`（>2MB 滚动）。

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

## 边界

- 只读投影（ADR-002）：不直写任何 sqlite 账本；写侧一律透传 maestro CLI（P1，PM-008）
- 禁 npm 依赖、禁外发文件；op=fleet/trace/flow 与订阅属 PM-004..009
