# pm-host-service（P0 壳 — PM-001）

maestro 编排面的**只读投影服务**（ADR-002）。本目录是 PM-001 交付的插件壳 + 自举 systemd user unit（ADR-003 模式 iii）；HTTP 投影 API 由 PM-002..009 在同一包内续建（端口/端口文件属 PM-002，本票不碰）。

## 形态红线

- 零 npm 依赖，纯 `node:*` ESM（`package.json` 的 `type:module` 锚定解析）
- dsh 插件入口 `export inject + apply(ctx)`；`inject: []`（壳不依赖 host 服务）
- 幂等方法循 ADR-007，幂等键 `pm-host-service@<MAESTRO_HOME>`（MAESTRO_HOME 缺省 `~/.dsh`）
- 状态存储：文件（unit + append-only 日志）；SQLite 仅当 R1/R3 触发（ADR-007.2），本票不建
- 无写死用户名路径：所有路径渲染期解析（`MAESTRO_HOME`/`XDG_CONFIG_HOME`/`import.meta.url`）

## apply() 副作用与幂等策略（ADR-007 五要素）

| # | 副作用 | 动作 | 幂等策略 |
|---|---|---|---|
| ③ | 日志目录 | `mkdir -p $MAESTRO_HOME/maestro/logs/pm-host-service` | 存在即 no-op |
| ① | unit 写入 | 渲染包内 `pm-host-service.service.template` → `~/.config/systemd/user/pm-host-service.service` | temp+rename 原子替换；已存在且字节一致 → 跳过 |
| ② | 启停 | `systemctl --user enable --now pm-host-service` | 已 enabled → 跳过（enabled 但 inactive 时仅 repair-start） |

`daemon-reload` 仅在 unit 实际（重）写后执行 → 重复 apply 零变更。unit 运行态由 systemd 自管；进程内不保存任何需恢复状态。

## unit 要点

- `WantedBy=default.target`（ADR-003 模式 iii，循 hardlink.path/watchd.service 先例）
- `Restart=on-failure` + `RestartSec=2` + `StartLimitIntervalSec=0`（kill 后 ≤10s 拉回；不自锁）
- daemon（`service.mjs`）把 SIGTERM/SIGINT 转为非零退出：`systemctl stop` 仍保持停止（stop job 抑制 Restart=），裸 `kill` 会被拉回
- stdout/stderr 走 journald（`journalctl --user -u pm-host-service`）；业务心跳写 `$MAESTRO_HOME/maestro/logs/pm-host-service/daemon.log`（>2MB 滚动为 `.1`）

## 部署与自举（ADR-003 模式 iii）

- 代码随 maestro-preset 分发，install.sh 落 `~/.dsh/plugins/pm-host-service/`；dsh 首次加载本插件即代装 + enable unit，此后 boot 常驻，dsh 死它不死。
- polyfill.patch.yml 注册**不在** PM-001 副作用清单内：壳由 unit 直拉，可独立于 dsh 运行；后续票再议挂载。
- **linger**：unit 为 user 级。要求无人登录也常驻时，手动执行一次幂等动词
  `loginctl enable-linger $USER`（按 ADR-003 文档要求记录于此；apply() 不代执行，避免越出三副作用清单）。

## 验证门（spec §PM-001，整门 ×2 全绿才收口）

```bash
cd plugins/pm-host-service
node -e "import(process.argv[1]).then(m=>console.log(JSON.stringify(m.apply({}),null,2)))" "$PWD/index.js"  # apply #1
systemctl --user is-active pm-host-service                          # 门1: active
kill "$(systemctl --user show -p MainPID --value pm-host-service)"
sleep 3 && systemctl --user is-active pm-host-service               # 门2: active（MainPID 已换，≤10s）
node -e "…" "$PWD/index.js"                                          # 门3: 全 skip，零变更
# 整门连跑两遍，两遍全绿 = 收口（同 maestro 票据收口门）
```

或 `npm run apply`（无依赖，仅脚本别名）。

## 边界

- 只读投影（ADR-002）：不直写任何 sqlite 账本；写侧一律透传 maestro CLI（P1，PM-008）
- 禁 npm 依赖、禁外发文件；HTTP 端口与 `pm.port` 端口文件属 PM-002
