# maestro 使用说明

> 完整安装/结构/信任边界见 [README.md](./README.md)。本文是操作手册: 从装好到跑通一条编排链路,再讲到开发调试。

## 1. 这是什么

一个 DSH **agent preset**: 把它挂到会话上,那个会话就变成「编排主管」,能跨 **Orca**(worktree/terminal)、**dais**(GUI/终端,原 zap,2026-08-17 改名)、**DSH**(子 agent 会话)三个平面协调多 agent 干活、收发消息、折叠进度。配套一套回调桥(文件桥 + HTTP 直发)与 SQLite 账本。

## 2. 安装与前置

```bash
git clone https://github.com/fiultyy/maestro-preset.git ~/.dsh/.agent-presets/maestro
```

可选但推荐——安装**对端共享 skill**(Orca/dais 等其他 harness 的 agent 冷发现用;不装则冷 agent 只能靠派发消息内嵌的契约行)。`shared/` 现含四个技能,全部装:

```bash
mkdir -p ~/.agents/skills
cp -r ~/.dsh/.agent-presets/maestro/shared/* ~/.agents/skills/
# claude 发现面(存在 ~/.claude/skills 时): 逐个软链
for s in maestro-bridge orca-bridge maestro-ledger dais-orchestration; do
  ln -sfn ~/.agents/skills/$s ~/.claude/skills/$s
done
```

- `maestro-bridge` — **worker 侧**冷执行手册(cb-send/语义/红线/排查);
- `orca-bridge` — **编排者侧**派发握手契约模板(Orca 终端编排者必须能发现,否则派发
  不带回调契约,worker 无从回报——2026-08-27 修复: 原先只在 preset 技能目录);
- `maestro-ledger` — 账本读写脚本(sync.py/log.sh);
- `dais-orchestration` — dais 编排面 CLI 参考。

开发流(`bin/dev-sync.sh`)自动镜像 shared/ → `~/.agents/skills` 并接好 claude 软链,无需手工。

前置: DSH(宿主)、Orca CLI(编排面必需)、sqlite3 CLI(账本)。dais(原 zap)可选。

装完**新建一个会话**,在 preset 选择器里选「高级编排模式」。preset 一经选用不可热切换,切换要开新会话。

> **fork 不等于新会话**: `session.fork` 没有 preset 参数,子会话继承源会话的组合;且 fork 自带历史前缀(一出生就"已产出"),而换 preset 的唯一通道 `recompose` 只接受白纸会话。想要"带旧上下文的编排会话": 从一个已是编排模式的会话 fork,或新建编排会话后把旧上下文摘要/检索过去。

## 3. 首次会话三步走

**① arm 回调泵**(会话开场调一次工具):

```
bridge_arm { alias: "orch" }        # 文件桥: 绑定 + 签名 orch@session-xxxx
bridge_arm                          # 裸 preset: file 桥绑定;host lane 部署不 arm(§3.4)
```

回执给出规范签名 `orch@session-xxxx`。记住它——这是别人把回调精准投给你的地址,
也是派发握手契约里嵌给对端的回信地址(见 §5)。

**② 建 Orca 桥**(一次性,Orca 重启后 handle 失效需重建): 让 agent 读 `skills/orca-bridge/SKILL.md` 执行建桥脚本,把桥 pane 的 handle 写进 `~/.dsh/maestro/bridge/handle`。桥 pane 就是一个 `cat >> inbox.log` 的终端,是外部回调进 DSH 的入口。

**③ 对外发消息**: 用 `bin/session-send`(见 §7)。

### 3.1 host 重启后回调重定向

DSH host 重启后,编排者的 sessionId 会变(现场: 9a173a3d→1737c79e)。重启前派出的
在飞 worker,其回调契约里嵌的 `to=orch1@旧id` 随即成**幽灵地址**——桥内无匹配槽,
cb-send 兜底"最近 armer",多编排会话同场时**误投别人**(现场实投 session-313e6f7f,
真正的编排者永远等不到 ACK/DONE)。重启后必做:

1. **重新注册**(host lane: `POST /register`;裸 preset: `bridge_arm`)+ 广播新签名: 拿到新规范签名 `<alias>@<新sessionId>`;
2. **向所有在飞 worker 广播新签名**: 让它们后续回调(ack/done/ask)改投新地址——旧
   地址不会自动转发,不广播就持续丢票。

协议层讨论(most-recent-armer 兜底的安全边界与 alias 稳定性)见
`docs/callback-bridge-design.md` §8。

### 3.2 编排者换代(compact 失效与继任接管)

**fork 会话的 manual compact 失效**: 长对话经 fork(长 seed 重放)后, compact 无法
收拢上下文——重放的 seed 会把体积带回来。编排者上下文过载时, 出路不是 compact,
是**换代**。换代操作律(现场: orch1 一代→二代, 2026-08-16):

1. **继任者 preset 必须 `maestro`**: 编排能力(桥工具/账本/技能面)只在 maestro preset
   里。错用 code preset 的继任者能力受限, 只能废弃重spawn(现场 a741 教训);
2. **会话是 host 槽, kill = retire**: 会话没有独立进程可杀, 下 kill 单即退役; 废弃
   一个继任者 = 一条 retire 指令, 不留僵尸;
3. **简报过继**: 卸任者把交接简报落盘(`maestro/handoff-*.md`: 专用壳/分支状态/
   在飞票/用户偏好/机制坑速查/自迭代回路), 继任者读文即接管, 不依赖原始对话;
4. **签名广播**: 继任者开场双通道武装拿新签名, 自检回报通过后卸任者退役; 在飞
   worker 按新签名寻址(换代消息本身即广播)。

### 3.3 回调路由三决策点(七/八坑; v1.3 已实施, 分支 feat/bridge-routing-v1.3)

**第七坑 — 回调端口代际漂移(HTTP 200 假阳性)**: `bridge/http.port` 是单文件共享,
PORT-R1 已于 P4 退役;现防线 = host lane 常驻口(boot 即绑,端口复用不漂移)+ 显式 to 失配 404 → 降级文件桥;
cb-send 不校验持有者时, 跨代际定向回调先撞错桥再被兜底吸收(现场: 换代 done 两连
投全假阳性)。**已修复(PORT-R1)**: arm 时旁挂写 `bridge/http.port.sig`
(=持有者 sessionId, 每次 arm 覆写, 与 http.port 恒成对); cb-send 读端口后取
目标签名的 `@` 后段与持有者比对, 不符**不 POST 直落文件桥**——"撞错桥"整类现场
消除。`to=*` 广播与 sig 缺失(旧代际/宿主 lane 未写)不拦截, 保持后向兼容。

**第八坑 — HTTP delivered 不回写 inbox, 消费面分裂**: v1.2 的 HTTP delivered
不落 `bridge/inbox.log`, 文件泵(v3.6)的游标/死信/轮转/at-least-once 对 HTTP
消息不可见; "delivered" 只是进程内一次应答, 不构成持久证据。**已裁决
(HTTP-R2, 会话内选项(ii)+宿主分工)**: 会话内 HTTP 面(message-bridge)定位为
**低延迟通知**——不回写 inbox(delivered=进程内直发 wake, ≠持久证据), 驱动语义
与持久证据归**文件泵(v3.6)+session-send**; 回写式受理面(受理即落 inbox,
200=accepted durable)由**宿主 lane**(`plugins/host-callback-bridge`, SI-003
§3.4)承载。会话内不实现回写的原因: ①直发+回写并存 → armed 双通道会话重复唤醒
(两去重窗口不互通, 恰是 HTTP-R2 要消除的形态); ②去掉直发只回写 → HTTP-only
armed 会话(未 bridge_arm)被泵 registry 死信(HTTP 槽表与泵 registry 是两张
路由表)。

**路由收紧(ADDR-R1, 同批实施)**: 显式非空 `to` 必须精确命中 armed HTTP 槽
(`===sessionId` 或以 `@<sessionId>` 结尾), 失配 → `404 {error:"no armed HTTP
slot for to=<sig>"}`, **不再 most-recent-armer 兜底吸收**——错投比拒收危险:
拒收后 cb-send 自动降级文件桥, 由 registry 正确路由; 仅 `to` 缺省/空保留
last-armer 兜底(单会话便利)。

**判定纪律**:

- cb-send 的 HTTP 200 delivered **≠ 送达目标**(低延迟通知已受理并直发 wake,
  非持久证据); 定向回调的送达证据 = **目标侧回合响应**, 或文件桥/`session-send`
  通道;
- cb-send 降级链(确证可达): HTTP 非 200/208——404 显式失配/400/503/连接失败/
  PORT-R1 拦截——一律落文件桥 append inbox.log, 游标消费不丢(`tests/test_cb_send.sh`);
- 桥是回调面, 不是会话驱动面; 跨 main 会话**驱动回合**唯一实证可靠通道 =
  `bin/session-send`;
- v1.3 载体: `plugins/message-bridge`(ADDR-R1/PORT-R1) + `bin/cb-send`(校验+
  降级链), 测试 `plugins/message-bridge/index.test.mjs` + `tests/test_cb_send.sh`;
  设计侧见 `docs/callback-bridge-design.md` §9.3, 票 `docs/tickets/0005`;
  装点生效待 dev-sync + 代际切换(护栏二, 用户拍板时机)。
  (历史: v1.3 会话内载体 `plugins/message-bridge` 已于 P4 退役删除;现行载体 =
  host lane `plugins/host-callback-bridge` + `plugins/callback-bridge` v4)

### 3.4 host lane 回调链路(SI-003 起, 宿主 boot 承载)

**形态**: `plugins/host-callback-bridge`(polyfill lane, 部署面 `~/.dsh/plugins/` +
`polyfill.patch.yml` 行)在**宿主 boot 时**绑定 HTTP `/callback`(优先复用
`http.port` 记录端口, cb-send 协议零变更)并以 fs.watch 事件驱动消费 `inbox.log`
(无轮询), 按 `registry.json` 把每行经回环 `/api/session.prompt` 注入目标会话
(`ORCA-CB]` 信封)。坏行照旧 dead-letter;坏行/投递失败措辞与 v3.6 逐字一致。

**编排会话的新纪律(链路已上移, 会话只保留"消费回合")**:

1. **开场不 arm**——host lane 已持有链路(POST /register 即可);orca-callback/message-bridge 已于 P4 删除,`bridge_http_status`= deprecated 别名; 旧工具
   仍在(preset 兼容), 但再 arm 会与 host lane 双消费(重复唤醒, 无丢失), 迁移期
   尽量不用;
2. **sessionId 是持久路由键, 但 registry 不自清**: 会话在 `~/.dsh/sessions/` 驻留,
   host 重启后同一 sessionId 仍可被 `session.prompt` 原生唤醒, registry 条目跨重启
   有效——但**服务端已删除/不存在的会话, 其 registry 条目不会自动消失**, 寻址/广播
   持续对其死信(`wake failed … session-not-found`, 2026-08-26 实证)。重启或清会话后
   必做: `bin/bridge-rearm`(清死条目+复读闸;错 key POST /unregister 也回 ok:true,
   故清扫走原子改文件)。
3. **换代/新编排会话注册**: `POST /register {"sessionId","alias"}`(端口读
   `bridge/http.port`), 或 `bin/bridge-rearm --register <sessionId> <alias>`
   (清扫+注册+复读闸一条命令); `bin/session-spawn` 已自动尾部注册, 仅换代需手动;
4. **观测**: `GET /status`(端口/计数/在册消费者)、`bridge/state.json` 顶层
   `hostBridge` 分节、`bridge/host-lane.log` 生命周期日志;
5. **迁移窗护驻**: 插件热载入运行中 host 时若 `http.port` 记录端口仍被旧会话内
   桥监听, host lane 全程待机零干扰, 下次 host boot 自动接管(一次性探活, 非轮询)。

**HTTP 受理语义变化(v1.2 → host lane)**: `200 accepted` = 已受理并持久落
`inbox.log`(HTTP-R2 选项(i): 受理即持久证据, 投递由文件消费面统一完成)——不再是
"进程内一次应答"; 显式 `to` 失配照 ADDR-R1 方向拒收(400 附 reason), cb-send 自动
降级文件桥, 由文件面 dead-letter 留痕, 不再 most-recent-armer 兜底误投。

## 4. 核心概念(30 秒版

- **三平面**: Orca(worktree/terminal/repo/浏览器)、dais(原 zap,GUI 终端)、DSH(子会话)。路由靠 persona 里的决策线判断,别硬背。
- **DSHMSG 信封**: 每条跨会话消息首行是 `DSHMSG]{"from","to","type","ref","body"}`。`session-send` 帮你拼,回调桥帮你收。
- **fleet 码表**: `~/.dsh/maestro/fleet.json` 把 `orch1`/`aa0a` 这种 4 位码映射到 sessionId(`session-spawn` 起会话自动登记)。0004 起 Orca 终端条目以 **termid** 为键(`kind: orca-terminal`,状态机 `probing→verified|mismatch|stale`),准入探测见 §5。
- **回调桥**: 两条入向通道——文件桥(Orca pane 写 inbox.log)与 HTTP 直发(本机 curl POST /callback)。出向统一 `session-send`。

## 5. 一条端到端链路

```bash
# 编排者自己: 起一个 worker 会话(code preset,登记为 dev1)
session-spawn code dev1 "跑个回归" <workspaceId>

# 编排者给 dev1 发任务(DSHMSG,queue 模式进 dev1 的回合)
session-send orch1 dev1 task reg1 "在仓库 X 跑 cargo test 并回报"

# dev1 干完,经桥回调编排者(在 dev1 会话里):
session-send dev1 orch1 done reg1 "3 通过 0 失败"
```

编排者收到回调 → 桥把它注入成一个新回合 → 编排者更新账本、继续下一个 gate。

**Orca 派发同理走握手**（`terminal send` 没有投递语义，不读终端输出确认）:

```bash
# 0) 准入(0004): 先探测,回报匹配 verified 才可派发(需 MAESTRO_ORCH_SIGNATURE):
#   MAESTRO_ORCH_SIGNATURE=<orch签名> bin/fleet-probe <termid> --wait 120
#   → 探测回调 from==termid → fleet 条目 verified(编排回调回合验证+落账)

# 派发时消息末尾嵌入 ACK/DONE 契约（模板见 skills/orca-bridge/SKILL.md）:
#   [ref:t1] 在仓库 X 跑 cargo test 并回报
#   —— 回调契约 ——
#   1) 回合开始: bin/cb-send ack dev1 <orch签名> t1 "turn started"
#   2) 完成时:   bin/cb-send done dev1 <orch签名> t1 "<摘要≤300字符>"
# 对端 ACK → 账本节点 running;DONE → 落 outcome 收口
# 一轮 sweep 无 ACK → 退回 terminal read / wait --for tui-idle 机械校验
```

**paste-Enter 时序坑（派发大文本必读）**: `terminal send`/inject 大文本（粘贴）后，
目标 TUI 可能把粘贴**折叠停在输入框**而不提交回合。判据与处置:

- 派发后盯 `terminal read` / `tui-idle`: **45s 仍未消费**（输入框还挂着折叠文本、对端
  未动笔）→ **补发一个空 `--enter`** 单独提交;
- **绝不连发两次 Enter**: 第二次 Enter 会**撤销 bracketed paste**（粘贴正文被撤回），
  前功尽弃——先确认折叠未消费，再补空 Enter，只补一次;
- 大文本优先拆段投递或落文件传路径（PTY 单行 ~4KB 上限），别一次灌满输入框。

## 6. 组件逐项

### 6.1 插件

| 插件 | 作用 | 模型可见工具 |
|---|---|---|
| `callback-bridge` | 会话内消费层 v4.1.0: file 桥(file-inbox 单 source,per-session 分槽,独立去重窗) | `bridge_arm` / `bridge_status`(`bridge_http_status` deprecated) |
| `workspace-unarchive` | 归档会话恢复(读 maestro/unarchive.log 逐行恢复) | 无(自动) |
| `session-purge` | 按需删会话(confirm="PURGE" 闸 + 自删拒 + 忙闸) | 经 `bin/session-purge` |

### 6.2 技能

- **orca-bridge**(shared/,双面发现: preset 会话 + `~/.agents/skills`): 建桥 pane、
  布防 watcher、回复署名约定、派发握手契约模板。含 `scripts/watch.sh`/`reply.sh`。
  Orca 终端编排者(preset 之外)也靠它拿到契约模板——这是 2026-08-27 修复的断路根因之一。
- **maestro-ledger**(shared/,双面): 账本读写(分发/回收全落账)。含 `scripts/sync.py`/`log.sh`。
- **maestro-bridge**(shared/): **worker 侧**冷执行手册——对端 agent 凭它发现回调协议
  (cb-send 用法/ack·done 语义/红线/排查)。镜像到 `~/.agents/skills` + claude 软链(见 §2)。
- **dais-orchestration**(shared/): dais 编排面 CLI 参考(27 子命令)。

### 6.3 bin 脚本

```bash
session-send   <from> <to> <type> <ref> <body>   # 发 DSHMSG;type: ping|pong|done|ask|steer|nack|ack
session-spawn  <preset> <node> <purpose> [ws]    # 起会话+入组+命名+登记,回显 4 位码
session-purge  <code|sessionId>                   # 删会话(确认闸门)
cb-send        <type> <from> <to> <ref> <body>   # 任意进程→编排者回调;type: ack|done|ask|report|ping|status;裸别名自动预解析(单持有者升级/撞名报错)
                                                  # 派发握手投递端: HTTP 优先,文件桥兜底
                                                   # ⚠ HTTP 200 delivered≠送达目标(§3.3 七/八坑)
fleet-probe    <termid> [--wait N]               # Orca 终端准入探测(0004): termid 回报匹配才
               [--reverify] [--status T]         # verified 入册;编排回调回合验证 from==termid
worker-up       <task_id> <project> [harness] [prompt] # dais 面供给一体化: 开面板→start-worker
               # →assign→注入 harness(omp-dais/cc-dais/pi-dais)→派任务;编排者派发只调它
bridge-rearm    [--register <sid> <alias>] [--dry-run] # 桥 registry 卫生: 清死条目+复读闸
               # +可选注册;:3080 重启/清会话后必跑(断路修复, 见 §3.4 纪律 2)
```

## 7. 运行时状态

全部在 `~/.dsh/maestro/`(包本身无状态):

| 路径 | 内容 | 清理方式 |
|---|---|---|
| `bridge/inbox.log[.1]` | 桥收件箱(轮转保留一代) | 停泵后删 |
| `bridge/registry.json` | 在册消费者 | 随会话 teardown 自注销;崩溃残留需手清 |
| `bridge/.cursor.*` / `state.json` / `dead.log` / `echo.log` | 游标/计数/死信/回声 | 可整体删(重置) |
| `bridge/http.port` / `http.state.json` | HTTP 通道端口与计数 | 随实例 |
| `fleet.json` | 码表(4位码↔sessionId)+ Orca 终端准入条目(kind/status) | 手工编辑 / fleet-probe 维护 |
| `ledger.db` | 账本 | sqlite 操作 |

## 8. 环境变量

见 [README.md](./README.md) 环境变量表。核心六个: `MAESTRO_BRIDGE`、`MAESTRO_BRIDGE_ALIAS`、`MAESTRO_LEDGER`、`MAESTRO_HOME`、`MAESTRO_ORCH_SIGNATURE`(fleet-probe)、`DSH_PORT`。

## 9. 升级与代际语义

- 升级 = `git pull` 到安装目录(或本仓库开发目录,见 §10)。
- **preset 以 `agent.cordis.yml` 的 stamp(mtime+size)为代际键**: 改这个文件 → 新会话自动挂新代际;运行中会话**永远保持加入时的代际**。
- **只改 `plugins/*.js`**: 运行中会话已把旧模块导入内存,不受影响;确定性让新代码生效 = **重启 DSH 进程**。
- 因此发布新版本 = 改代码 + 改 `agent.cordis.yml`(哪怕加个注释),让新会话拿到新代际。

## 10. 开发模式(dev-sync 同步,禁用软链接)

开发循环 = 在本仓库编辑 → `bin/dev-sync.sh` 同步到安装点 → 新会话验证:

```bash
bin/dev-sync.sh                 # 正向: 仓库→装点(rsync --delete) + bin/→镜像 ~/.dsh/maestro/bin + shared/→~/.agents/skills + polyfill lane(~/.dsh/plugins: host-callback-bridge/_narrow-waist/a2a/persona-axis)
bin/dev-sync.sh --reverse <f>   # 回流: 装点→仓库逐文件 patch → git apply -p1 + 当场 commit(护栏一见 §10.2)
bin/dev-sync.sh --verify        # 漂移报告: 装点正向/装点回流/镜像/polyfill lane(四组,含 a2a 与 persona-axis host 面)——pre-push 钩子强制清零
```

⚠️ 正向带 `--delete` 会覆盖装点——装点上的实验改动必须**先 `--reverse` 回流入仓**,再跑正向,否则被冲掉。

**⚠️ 禁止把安装点做成软链接**(`ln -s` 指向仓库)。DSH 的 preset discovery 用 `readdir(withFileTypes)` 的 `isDirectory()` 过滤(harness `packages/preset/agent-presets/src/discovery.ts` scanRoot),符号链接 `isDirectory()==false` → **整个 preset 从 roster 消失**,默认/选用该 preset 的新会话全部创建失败(症状: 新建对话无响应)。已实测踩坑并回滚。

**生效边界仍受 §9 约束**: 改 `agent.cordis.yml` → 新会话即得新代际;改插件 `.js` → 重启 DSH 才确定性生效。开发循环: 改代码 → `bin/dev-sync.sh` → 重启宿主(或接受"新会话才生效")→ 开新会话验证 → `git commit` + `git push`。

### 10.1 推送验证（git 假象防线）

开发循环末尾的 `git push` 有三个现场坑，**别信单次命令的表面成功**:

- **git-lfs locks verify 超时静默吞 push**: `git lfs push`/带 lfs 对象的 push 卡在
  locks verify 超时，进程"成功"返回但对象实际没推上去——退出码是假绿;
- **ls-remote 过期缓存**: 推完立刻 `git ls-remote` 可能读到旧引用（缓存/竞态），
  拿到"已在远端"的假象;
- **worktree 检不出主检出分支**: 主检出（主仓库目录）已占住的分支，在 worktree 里
  `checkout` 会被拒——这是 worktree 保护，不是推送/远端出了问题，别误诊。

**终验纪律**: `git ls-remote origin <branch>` **重试**（隔几秒再查一次，避开过期缓存）
+ **哈希比对**（`git rev-parse HEAD` 与 ls-remote 返回值逐字一致才算推上）。不一致 →
查 lfs/网络后重推，直到哈希对上为止。

### 10.2 自迭代路径分治

preset 三类构件的爆炸半径不同,自迭代**按构件选路径**,不一刀切:

| 构件 | 路径 | 理由 |
|---|---|---|
| 文档(USAGE/README/docs) | **路径1: git 直改** | 不进会话运行面,改错无爆炸半径;仓库即真源 |
| `bin/` + `skills/` | **路径2: 先 .dsh 后 sync** | 产物是脚本/手册,按需从磁盘读;先在安装点改+新会话验证,再 sync-back 落仓库 |
| `plugins/` | **路径1: 强制 git 分支迭代** | 爆炸半径 = **全体会话回调面**(pump/bridge 一挂,所有编排会话断流);branch/fix-forward/revert/bisect 是刚需,**禁止在安装点直改** |

**护栏一: sync-back 必须脚本化**。`dev-sync.sh` 增 `--reverse`(从安装点**生成 patch**,不直接覆盖仓库)与 `--verify`(输出双向 diff 报告);**禁止手工 cp 安装点文件覆盖回仓库**。且**每次 sync-back 当场一条 commit,禁攒包**——攒包会把多轮实验混进一笔提交,破坏 revert/bisect 的最小单元。

**护栏二: 验证必须新 spawn 会话跑**。运行中会话(含编排者自身)在加入时钉死旧代际(§9),体内验证永远跑在旧代码上,结论无效;任何"改完了、验证过"必须开新会话执行后才算数。

## 11. headless 借壳纪律

headless 进程/agent（无 `ORCA_TERMINAL_HANDLE`，如 cron、脚本、无 Orca 终端的会话）
要驱动终端时，必须有**活跃终端的 sender**——`terminal send` 只认活 handle。借壳
（借用别的终端发消息/跑命令）的纪律:

- **借壳必须注明"票不投壳"**: 回调/账本/收口票据的归属一律写真正的 from（headless
  自己的 agent ID），不能记到被借的壳终端名下——否则账本错账、fleet 码表误登记、
  追责追到壳;
- **最佳实践是专用壳**: 常驻 headless 任务单开一个**专用终端**做 sender（定位同 §3
  桥 pane），不借在役 worker/交互终端——既不污染对方输入流、抢对方回合，也不会
  sender 被回收后回调断流;
- 借壳只是应急通道: 用完即还，壳内不留长任务;壳 handle 失效（Orca 重启）按 §3 桥
  pane 同款步骤重建。

设计侧背景见 `docs/callback-bridge-design.md` §7。

## 12. 信任与安全

本 preset 的插件会写文件、开回环监听端口、驱动会话回合;技能会指使 agent 操作 Orca 终端。user preset 等同 shell 权限——只从信任来源安装,审阅 `agent.cordis.yml` 列的每一行后再挂载。

## 13. flowc — 编排编译器(十动词监督面, v2)

**定调**: 编排业务 = **十动词**(dispatch/callback/status/rollup/stop/redirect/
escalate/close/succeed/retry), 全部幂等动作节点, 无深分支。flowc 把 `flow.yml`
(动词+参数序列, 含 `chain`(`deps`)/`on_done`/`on_fail`/`gate`)编译成纯 SQLite
状态机——**只编译监督面, 不替代 Orca 权威 dispatch**(派发仍走 worker-start/
dispatch --inject; plugins 面零改)。

```bash
bin/flowc compile docs/flows/ticket-queue.yml   # → ~/.dsh/maestro/flows/<id>/
bin/flowc inspect [flow-id]                     # v_status 一览 + 未决 escalation
bin/flowc advance <flow> <node> --result done|failed|redirected [--note X]
bin/flowc selftest                              # 16 项内置自测
```

**物化产物** `~/.dsh/maestro/flows/<id>/`:`state.db`(状态机, schema 含 CHECK
约束: verb 限定十动词, state 限定 pending/ready/running/done/failed/skipped/
closed)、`nodes/*.sh`(十动词节点脚本)、`units/`、`triggers.sql`(触发器族)。

**触发器族(纯 SQL, 零守护进程)**:

- `done` → 解锁 deps 全满足的后继为 `ready`(AND gate: `NOT EXISTS` 未完成依赖);
- `failed` → `escalations` 行 + `escalated` 事件, 同时 flowc 落 pending JSON →
  **硬链路 v1**(systemd path 单元 + orch-notify.sh + cb-send)唤醒编排者;
- 终态重复 advance = 幂等 no-op(仅记事件);`redirected` = 本节点 skipped +
  目标复活 ready(可复活 failed; 与 retry 区分——retry 计 attempts)。

**十动词执行主体**: 机行(dispatch/callback/status/rollup/close/retry)由节点
脚本执行; **agent 在环仅 escalate/redirect(+stop 回执面)**——escalation 经
cb-send 直通编排者回合, callback 复用硬链路 v1(TRIGGER+path+cb-send)不重造。

**状态机速查**: `pending`(等 deps)→ `ready`(可执行)→ `running` → `done`/
`failed`; `closed`(收口)/`skipped`(被改向绕过)为终态。汇总: `v_rollup` 视图
按 state 聚合计数。

**首个生产流程**: `docs/flows/ticket-queue.yml`(create→dispatch→callback→
verify→commit→next), 以 T-flowc 真实票全链实测。护栏二: flowc 是独立脚本
(每次执行新进程, 无代际钉死), selftest + 实测即新进程验证。
