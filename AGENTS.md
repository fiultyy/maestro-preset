# maestro-preset 工作区

DSH maestro 预设与孵化池机制的统一开发仓库。当前波次：**N10（docs/10-pool-selection-queen.md）— OF-012 池选型 spawn + OF-013 queen 派生/导出**。

## 布局与部署映射

| 目录 | 是什么 | 部署点（sync 回） |
|---|---|---|
| `agent.cordis.yml` / `preset.yml` / `bin/` / `skills/` / `shared/` | maestro 预设本体 | `bin/dev-sync.sh`（仓库 → `~/.dsh/.agent-presets/maestro`，rsync --delete；`--verify` 先看差异） |
| `plugins/a2a-profile-server/` | 孵化池插件（独立守护，端口 8790；cordis polyfill lane，非 polyfill.patch.yml 注册） | 拷回 `~/.dsh/plugins/a2a-profile-server/` 后重启守护 |
| `projector/rt_projector.py` | 19 维 profile 投影器（ROLE_TEMPLATES） | 拷回 `pipecat-poc examples/realtime-provider-poc/` |
| `projector/wizard.py` + `SKILL.md` | 孵化向导 | 拷回 `~/.agents/skills/incubation-wizard/` |
| `docs/` | 计划/设计/报告 | 随仓库 |

## 红线（继承 orch-index §4）

- worker 不碰默认分支不改别人的域；集成合并由编排者（maestro 会话）做。
- 不 push；跨会话只有 `bin/session-send` 回程通道。
- live 测试禁止同 mailbox 并发实例；21:30 后 live 预算 ×1.5。
- 禁 dais spawning（实例锁强制）。
- 票据收口门 = timeout-shell 全量重跑绿 ≥2 次。
- dsh 预设导出四条硬规则（id slug `^[a-z0-9][a-z0-9-]*$`、`{{` 消毒、生成行纯 YAML 平台行原文拷贝、isolate realm）见 docs/10 §2——违反者静默失败或运行期崩。

## dsh 契约事实（已源码级核实，2026-08-24）

- `~/.dsh/.agent-presets/` 落目录即刻进 GUI 新会话屏（trust=user，实时扫描）；`agent.cordis.yml` 必填、`preset.yml` 仅 `{name, description, order}`。
- persona row 是 preset 改身份唯一机制；AGENTS.md 是 workspace 指令通道，不进 preset。
- 本机 GUI loopback：`http://127.0.0.1:3080`（`agentPreset.list` 可验证 roster）。
