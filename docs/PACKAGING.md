# DSH 插件打包规范(PACKAGING)

> 本文件是 maestro 包的**权威打包规范**: 规定「怎么把一个能力装成 DSH 插件、怎么组织 preset 目录、怎么发出去」。实现细节的历史脉络见 [callback-bridge-design.md](./callback-bridge-design.md),操作手册见 [USAGE.md](../USAGE.md)。
> 依据: DSH 仓库 `packages/preset/agent-presets/`(README + src/mount.ts + src/discovery.ts + src/metadata.ts)实测,rev 47f9438。

## 1. 分发单位 = preset 目录(不是 npm 包)

DSH 没有第三方 npm 插件通道。一个能力的最小分发单位是一个 **preset 目录**:

```
<preset-id>/                 # id 必须匹配 [a-z0-9][a-z0-9-]*,安装时目录名即 id
├── preset.yml               # 名字/描述(元数据,官方 schema 见 §6)
├── agent.cordis.yml         # 组合文件: 每插件一行
├── plugins/                 # 插件(可选)
├── skills/                  # 技能(可选)
├── bin/                     # 随包脚本(可选)
└── README.md / USAGE.md / LICENSE / docs/   # 文档(可选,分发必备)
```

安装 = 目录放进 `${DSH_HOME:-~/.dsh}/.agent-presets/<id>/`。复制即用、零构建。

## 2. 组合文件(agent.cordis.yml)行规则

- 每行 `- id: <unique>` + `name: <specifier>` + 可选 `config:` + 可选 `disabled: true`。
- **行名必须写到精确 .js 文件**(ESM 无目录 index 解析): `./plugins/x/index.js` ✅、`./plugins/x` ❌。
- 服务型行若发布 service,必须落在 `isolate` realm 内(entry-local),否则 mount 被拒(root-realm 冲突)。只消费 `agents`/`tools` 不发布服务的行无需 realm。

## 3. 行名解析三通道(mount.ts:81-92)

| specifier | 解析自 | 说明 |
|---|---|---|
| `./相对` | preset 目录 | **推荐**;随目录自包含 |
| 裸包名 | 宿主组合基(harness 安装树) | 仅 `@deepseek-ai/dsh-*` 等随宿主发布的包可达;**第三方 npm 裸名不可用** |
| 绝对路径 | file URL | 可用但不自包含,分发禁用 |

推论: **preset 里装不了第三方 npm 依赖**。插件只能 import `node:*` 内建 + 相对路径文件;DSH 能力一律经 `inject` 从 `ctx` 拿。

## 4. 插件模块契约

```js
export const version = '1.0.0'          // 版本指纹: arm/status 回执与磁盘对账用
export const inject = ['agents','tools'] // 依赖的服务键(从 ctx 注入)
export function apply(ctx, config) { … }  // 入口: config = 行里的 config 字段
export default { version, inject, apply }
```

- 注册工具: `ctx.tools.register({name, description, parameters, output, execute})`。
- 清理: `ctx.effect(() => () => { … })` 做 teardown。
- 绑定当前 agent: `ctx.agents.requireInitiator()`;驱动回合: `agent.followup(msg)`(idle)/ `agent.inject(msg)`(忙)。

## 5. 代际与生效语义(改代码怎么上线)

- preset 代际以 `agent.cordis.yml` 的 **stamp(mtime+size)** 为键。
- 改 `agent.cordis.yml` → **新会话**挂新代际;运行中会话永远保持加入时代际。
- 只改 `plugins/*.js` → 运行中会话已 import 旧模块不受影响;**确定性生效 = 重启 DSH 进程**。
- 开发模式: `bin/dev-sync.sh` 同步仓库→安装点(见 USAGE §10)。**禁止软链接安装点**: discovery 的 `isDirectory()` 过滤会把 symlink 的 preset 从 roster 整个踢掉,新会话创建失败。

## 6. preset.yml 官方 schema(metadata.ts)

```yaml
name: 显示名            # 必填
description: 一句话用途  # 必填
order: 4               # 可选;无 order 的排在有 order 的官方集之后、按 id 字典序
```

第三方包**不设 order**(天然排在官方集后)。`copy()` 复制时会丢 name/order、留 description。

## 7. 信任模型

user preset 等同 shell 权限(preset 是组合,插件代码无额外沙箱)。分发必须: 文档声明信任边界、README 说明装了什么、审阅 `agent.cordis.yml` 每行。

## 8. maestro 包的落地约定

- 结构: 见 §1 目录树(4 插件 + 2 技能 + 3 bin + docs)。
- 所有可配置运行路径走环境变量(`MAESTRO_BRIDGE`/`MAESTRO_LEDGER`/`MAESTRO_HOME`/`MAESTRO_FLEET`/`DSH_PORT`),缺省值 `~/.dsh/maestro/*`;禁止写死用户名路径。
- 回调桥双通道(文件 + HTTP)共享语义(去重窗口/寻址/死信/状态观测),是 callback-bridge 抽象(§9)的目标。
- 发布 = `git commit` + `git push`;仓库根 `README.md`(概览)/ `USAGE.md`(手册)/ 本文(规范)三件套随包走。

## 9. callback-bridge 抽象与迁移(待办,见 callback-bridge-design.md)

把 orca-callback(文件桥 v3.5)+ message-bridge(HTTP v1.0)合并为一个通用回调桥:

- 分层: Sources(传输: file-inbox/http)→ Codec(前缀/JSON)→ 共享内核(addressing/registry/dedup/store)→ Sink(agent-turn)。
- 关键判断: **共享的是内核语义,不是单条投递管线**——at-least-once 游标/轮转/死信是文件传输特性;HTTP 状态码契约是 HTTP 传输特性。
- 阶段: P1 内核平移(不注册)→ P2 双跑 → P3 切换(重启)→ P4 清理。
- scaffold 现移出分发树,在 `~/.dsh/maestro/dev/callback-bridge/`。
- 平移映射表见该 scaffold 的 `README.md`(pump.js 逐行 → 新模块)。
- 4 个开决策点: HTTP 缺省 `to` 语义、http.state 是否并入主 state、前缀统一、多 host 端口文件。

## 10. 校验清单(每次发布前)

- [ ] 所有插件 `node --check` 通过
- [ ] 无 `/home/<user>` 硬编码路径(grep 验证)
- [ ] 插件 import 仅 `node:*` + 相对路径
- [ ] 行名写到精确 .js;无 root-realm 服务
- [ ] README/USAGE/PACKAGING 三件套与代码同步
- [ ] `git push` 后远端 HEAD 与本地一致
