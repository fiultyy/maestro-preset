# maestro — 高级编排模式 (DSH agent preset)

跨 Orca、zap、DSH 三平面的多 agent 编排套件,以 DSH **agent preset** 形态分发。本目录自包含: 插件、技能、脚本全部随包走,零 npm 依赖(仅 `node:*` 内建 + 相对 import)。

> 装好后怎么用 → **[使用说明 USAGE.md](./USAGE.md)**;开发调试(dev-sync 同步,禁用软链接)→ USAGE §10;打包规范(怎么装成插件/怎么发布)→ **[PACKAGING.md](./docs/PACKAGING.md)**。

## 前置要求

| 依赖 | 用途 | 缺失时的降级 |
|---|---|---|
| DeepSeek Harness (DSH) | 宿主 | 不可用 |
| Orca (`orca-ide`/`orca-dev`) | 桥 pane、terminal send、worktree 管理 | 仅剩普通编码能力,编排面不可用 |
| sqlite3 CLI | 项目状态账本 | 账本技能不可用 |
| zap (可选) | zap 平面投递 | 该平面跳过 |

## 安装

```bash
# 方式一: git(推荐,可升级)
git clone <this-repo> ~/.dsh/.agent-presets/maestro

# 方式二: 复制目录
cp -r maestro/ ~/.dsh/.agent-presets/maestro
```

安装后**新建会话**,preset 列表出现「高级编排模式」,选用即挂载。preset 一经选用不可热切换;升级 = `git pull` + 重启 DSH 进程(运行中会话保持加入时的代际,属预期)。

## 包结构

```
maestro/
├── preset.yml            # 名字/描述(官方 schema: name/description[/order],本包不设 order → 排在官方集之后)
├── agent.cordis.yml      # 组合文件: 每插件一行的注册表(路径一律相对本目录、写到精确 .js 文件)
├── plugins/              # 插件(每个 = 一个 ESM 入口,export inject + apply(ctx, config))
│   ├── orca-callback/    #   文件桥泵 v3.5: fs.watch 桥 inbox → at-least-once 投递(多消费者寻址/去重/死信/轮转)
│   ├── message-bridge/   #   HTTP 直发 v1.0: 127.0.0.1 随机端口 POST /callback → 同一投递语义
│   ├── workspace-unarchive/  # 会话归档恢复(活体 registry 走 setState 同路径)
│   └── session-purge/    #   按需删除会话(RPC 面无 session.delete,补全生命周期)
├── skills/               # 技能(模型按需加载的操作手册)
│   ├── orca-bridge/      #   建 pane 桥、watcher、回复署名约定(含可执行脚本)
│   └── maestro-ledger/   #   账本读写手册(含脚本)
├── bin/                  # CLI 脚本(会话/编排操作面,与 ~/.dsh/maestro/bin 等价)
│   ├── session-send      #   跨会话消息直发(DSHMSG 信封 → /api/session.prompt)
│   ├── session-spawn     #   起新会话并入 fleet
│   └── session-purge     #   调 session-purge 插件的 purge 端口
└── docs/                 # 设计文档(含 callback-bridge 抽象设计与 DSH 插件打包面事实)
```

## 运行时状态(不在包内,自动生成)

包是**无状态**的;一切运行数据落 `~/.dsh/maestro/`,首次使用自动创建:

| 路径 | 内容 |
|---|---|
| `~/.dsh/maestro/bridge/` | inbox.log(桥)、registry.json(消费者)、.cursor.*、state/dead/echo |
| `~/.dsh/maestro/fleet.json` | 会话 fleet 码表(session-send/spawn 读写) |
| `~/.dsh/maestro/ledger.db` | SQLite 账本 |

## 环境变量

| 变量 | 缺省 | 作用 |
|---|---|---|
| `MAESTRO_BRIDGE` | `~/.dsh/maestro/bridge` | 桥目录(泵 + skill 脚本同认) |
| `MAESTRO_BRIDGE_ALIAS` | (无) | bridge_arm 的消费别名 |
| `MAESTRO_LEDGER` | `~/.dsh/maestro/ledger.db` | 账本路径 |
| `MAESTRO_HOME` | `~/.dsh` | DSH home(插件内运行数据定位) |
| `MAESTRO_FLEET` | `~/.dsh/maestro/fleet.json` | fleet 码表路径 |
| `DSH_PORT` | 3080 | session-send 目标端口 |

## 快速开始(装完后第一个会话)

1. 会话开场调一次 `bridge_arm {alias: "你的别名"}` —— 绑定回调泵,回执给出规范签名 `<alias>@<sessionId>`
2. 按 `skills/orca-bridge/SKILL.md` 建 Orca 桥 pane(一次性)
3. 之后外部 agent 的回调经桥自动驱动本会话回合;对外发消息用 `bin/session-send`

## 信任边界(必读)

本 preset 的插件会**执行文件系统写入、开本地回环监听端口、驱动会话回合**;技能指使 agent 操作 Orca 终端。按 DSH 的信任模型,user preset 等同 shell 权限——只装你愿意托付 shell 的来源的包。

## 升级 / 卸载

- 升级: `git pull` → 重启 DSH → 新会话用新代际(旧会话自然消亡)
- 卸载: 删掉 `~/.dsh/.agent-presets/maestro/` 即可;运行数据在 `~/.dsh/maestro/`,另行处置
