# host/ — 装点自研插件的分发面

> 2026-08-24 从运行装点(`~/.dsh`)提取整理。来源与装点一一对应,准备分发用。
> 规范入口: [../docs/PACKAGING.md](../docs/PACKAGING.md) §11。

## 内容

| 目录 | 内容 | 装到 | 来源(提取时) |
|---|---|---|---|
| `packages/dsh-long-task` | long-task 领域+service(`ctx.longTasks`,事件投影) | `~/.dsh/profiles/<profile>/node_modules/@deepseek-ai/` | profile node_modules, v0.1.0-rc.8 构建 |
| `packages/dsh-tool-long-task` | 模型工具面 get/create/update_long_task | 同上 | 同上 |
| `packages/dsh-long-task-round-driver` | continuation 轮驱动 | 同上 | 同上 |
| `packages/dsh-long-task-context-policy` | 上下文压力 handoff 策略 | 同上 | 同上 |
| `plugins/random-uuid-polyfill.js` | 单文件 host 补丁 | `~/.dsh/plugins/` | 装点原样 |
| `plugins/workspace-unarchive/` | workspace unarchive RPC 补齐(host 面) | `~/.dsh/plugins/` | 仓内 canonical 版(新于装点单文件版) |
| `plugins/ui-agent-pool/` | N10-GUI agent-pool 选择器(client 插件) | `~/.dsh/plugins/` | 装点原样 |
| `polyfill.patch.yml` | host 补丁组合模板(run-web.sh `--patch` 用) | 引用,不安装 | 装点原样 |
| `install.sh` | 一键安装器(支持 `--dry-run`) | — | 本仓新写 |

`host-callback-bridge` / `a2a-profile-server` 的 host 面副本由 install.sh 从 `../plugins/` 装(源码同仓,不双份)。

## 安装

```bash
host/install.sh --dry-run          # 预览
host/install.sh                    # 执行
host/install.sh --systemd          # 另: 生成 a2a-profile-daemon systemd unit
```

## daemon 存活(systemd,推荐)

`agent-presets` 池后端(a2a-profile-server)由 systemd user unit 托管:
`host/install.sh --systemd` 生成 `~/.config/systemd/user/a2a-profile-daemon.service`
(模板 `systemd/a2a-profile-daemon.service.in`,node 绝对路径装时探测)并 enable。
重启策略 `Restart=on-failure`;在役 daemon 不打断,改代码后手动
`systemctl --user restart a2a-profile-daemon`。替代旧 nohup 裸跑形态(v3 教训:
3081 退役曾连带清掉 daemon)。

## 人工步骤(install 不碰)

1. `run-web.sh` 里 `--patch` 指向 `${DSH_HOME}/plugins/polyfill.patch.yml`。
2. web profile 的 `cordis.patch.yml` 需含 long-task 两行 insert(dsh-long-task + dsh-long-task-round-driver)。
3. 凭据走环境变量:`FEISHU_APP_ID/FEISHU_APP_SECRET`(lark)、`ZHIPU_CODING_PLAN_API_KEY`(zhipu search)——polyfill.patch.yml 已全部 env 引用,无明文。

## 版本注记
- 构建基线: local-dev @ `6f57282c39` (2026-08-25);重建入口本仓 bin/rebuild-host-packages.sh

- 4 个 dsh 包是 **v0.1.1-rc.2+local.1 构建(2026-08-24,基于 upstream 0.1.1-rc.2 + 本地 clear action + 投影新接口迁移)**,源码在 `~/tools/deepseek-harness/packages/long-task/`(分支 local-dev)。
- `update_long_task action=clear` 已含在本构建中(装点 :3080 运行验证过);重新分发前从 local-dev 分支 `pnpm build` 后替换 packages/ 下对应目录并 bump 版本号。

## 关联 preset

`../agent-presets/` 下三个自研 preset(long-task / queen-v1 / liangshen)同样由 install.sh 安装;maestro 本体 preset 即仓库根,走 `bin/dev-sync.sh`。
