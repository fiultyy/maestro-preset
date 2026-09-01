# 编排派生 main session 的命名与分组规范

> 2026-08-15 订立,起因:B/B2 spawn 后游离于 workspace 外、标题无统一格式,GUI 侧栏不可辨识。

## 命名(title)

`session.create` 无 title 参数,spawn 后**立即** `session.rename`:

```
<code>-<ledger-node-id> · <preset> · <一句话用途>(<状态>)
```

- 码:4 位十六进制,sessionId 前 4 位派生(随机、零状态、自校验);
- `<node>`:ledger node_id,与 nodes 表一致,GUI ↔ ledger 双向可溯;
- `<preset>`:能力面(minimal/code/maestro);
- 状态:`active` → `done` → `done,可复用`(继续派活)/归档;
- 示例:`2437-pump-v35-b2 · code · pump v3.5实现(done,可复用)`。

## 分组(workspace)

DSH 的 workspace = **目录上下文**,成员关系(accounting)有硬语义:

1. **入账只发生在 `session.create` 时**:显式传 `workspaceId`——**只传 cwd 不会入账**(B/B2 实证:cwd 正确仍游离);
2. `workspace.insertSessionBefore` 是**排序**动词,只对已入账会话有效(未入账报 `workspace-move-invalid: not accounted`);
3. 无事后入账 RPC → **spawn 协议必须出生即带 workspaceId**;
4. 生命周期终点:`workspace.archiveSession {sessionId}`(对游离会话同样有效,B 实证)——归档出侧栏,不删数据。

## Spawn 标准协议(编排者执行)

```
1. ws    = <目标 workspaceId>          # 如 .dsh 目录组
2. rpc   session.create  {workspaceId: ws, agentPreset: <preset>}   # 不用 cwd
3. rpc   session.rename  {sessionId, title: "<code>-<node> · <preset> · <用途>(active)"}
4. ledger nodes upsert (node_id, kind=session, refs=sessionId) + events(dispatched)
5. 完成回调:worker curl loopback session.prompt → 编排者 sessionId
6. 验收后:rename 状态改 done → 归档或保留复用,ledger 记 done
```

## 短码与消息信封(2026-08-15 v2:方向语义)

**问题**:loopback `session.prompt` 是匿名文本注入,无 from/to 字段;36 位 sessionId 无法当对话内地址。

**短码**:4 位十六进制 = sessionId 前 4 位(UUID 派生:随机、零状态、自校验,码即 sid 前缀)。
- 登记处:`~/.dsh/maestro/fleet.json`(code → sessionId/node/preset/status;编排者别名 `orch1`)
- 标题携带:`<code>-<node> · <preset> · <用途>(<状态>)` —— 码前置,无前缀
- 工具:`maestro/bin/session-spawn <preset> <node> <purpose> [wsId]`(出生入组+命名+登记,回显码)、`maestro/bin/session-send <from> <to> <type> <ref> <body>`

**信封**(收方回合首行,前缀+单行 JSON,与文件桥 v3.5 同一心智模型):

```
DSHMSG]{"from":"2437","to":"orch1","type":"done","ref":"pump-v35-b2","body":"…"}
```

- `type`:ping|pong|done|ask|steer|nack|ack;`ref` 关联 ledger node_id(无则 `-`)
- 方向、来源、任务关联全部显式可解析;解析 = 按 `]` 切一刀 + json.loads

**信封 v2(2026-08-23,OF-001)**:增 `msgid`(uuid4,`session-send --msgid <id>` 可透传保号)与
`ts`(epoch ms)两键——只增不改(OG5),老键顺序保留,老消费者忽略未知键即兼容;示例:

```
DSHMSG]{"from":"2437","to":"orch1","type":"done","ref":"pump-v35-b2","body":"…","msgid":"5f0c…","ts":1787480000000}
```

收方回合首动作对信封行跑 `maestro/bin/msg-dedup '<DSHMSG 行>'`:60s 窗口内同 (from,msgid)
重复 → exit 3 丢弃;新消息记录后 exit 0 放行(窗口文件 `state/dedup/<to>.jsonl`,>1000 行截半 GC)。

## Relay 契约:事件回报后原子推进基线(2026-08-23,OF-001/D-10)

**回声缺陷**:relay 只看守文件事件(报告落地/git merge),无消费位点——已由编排者处理完的事件
(合并后)下轮扫描仍重复回报(VO-009/merge 回声实录,D-10)。

**契约(relay 每轮扫描循环,四步)**:

1. **diff**:扫描看守面,与位点文件里的基线比对取增量——
   - `reports` 面:`reports/` 目录文件名(按名排序),基线 = `reports.base`(最后已回报文件名);
   - `git` 面:提交增量,基线 = `git.base`(最后已回报 commit sha);
2. **回报**:增量逐条 `session-send <relay> <编排者> report <ref> <…>`(信封带 msgid);
3. **原子推进**:回报成功后更新位点 `state/relay-<code>.json`(JSON:`{"reports.base","git.base","ts"}`)
   ——必须 **temp+rename**(写临时文件+`os.replace` 覆盖,禁止就地覆写防半写),与 fleet-touch 同策;
4. **零回声**:同事件二次落地(文件未变/同 sha 重放)= diff 为空 → 零回报。

位点未初始化(新 relay)时首轮全量回报后即建立基线;收方第二道防线 = 回合首动作 `msg-dedup`
(msgid 去重),relay 违约重复投递时收方兜底丢弃——两道防线勾稽 D-10。

## 血泪补充(2026-08-15 可见性事故)

1. **归档是单向的**:当前 RPC 面没有 unarchive(workspace.ts 仅留 "a future unarchive" 注释;模型侧保留槽位但无动词暴露)。归档前必须确认——用户可能还想在侧栏看到它。**实验/演示用途的 session,验收后默认保留,不归档**;只有明确说"可归档"才归档。
2. **未入账 = workspace 视图不可见**:老协议(仅 cwd)spawn 的会话(如 B2/pump-v35-b2)不在任何 workspace,侧栏看不到但 `session.list` 可查——出生带 workspaceId 不是可选优化,是可见性前提。
3. 归档会话仍可 `session.prompt`/`session.history`(数据不删),只是侧栏隐藏。

## 生命周期语义:归档=回收站(2026-08-15 定稿)

```
archiveSession   → 进回收站(侧栏隐藏,数据留)
unarchive 热修    → 还原(回原槽位)
session-purge    → 清空(单件或全清;也可直接清未归档会话,d33e 实证)
```

- 回收站**不强制中转**:purge 可直接清在册会话;"先归档再清"只是给后悔留窗口;
- 全清 = `workspace.list` 取 `archivedSessionIds` 逐个 `maestro/bin/session-purge`;
- 幽灵边界(见上节):本 host 派生会话 purge 后 session.list 留惰性幽灵至 host 重启,磁盘/registry/舰队三面干净;
- 首次全清记录:dbde6ccf(唯一在站件)三步全绿,`archivedSessionIds=[]`。

## 会话删除(2026-08-15:按需方法,非自动)

RPC 面 46 方法**无 session.delete**(唯一 delete 是 workspace.delete)。缺口由 preset 插件 `session-purge`(v1.0.0)按需补上:

- **暴露**:每个 maestro 会话挂载后在 127.0.0.1 随机端口起 `POST /purge`,端口写 `maestro/purge.port`;**无 watcher、不自动**,agent 用 `maestro/bin/session-purge <code|sessionId>` 显式执行(confirm="PURGE" 闸 + 编排者自删拒 + 5 分钟忙闸);
- **级联**:registry(global 归档表 + workspace 槽位 + 内存索引)→ 会话目录 rm → projcache 死键 → fleet.json 摘码;
- **已知边界**:本 host 派生过的会话,其空闲 Session 对象仍驻留 host 内存(`ctx.sessions` 无公开逐出动词),表现为 session.list 里的**惰性幽灵**(磁盘/分组/舰队三面已清,prompt 它会从内存事件图重建目录)。冷会话(非本 host 派生)删除即 100% 干净。彻底解决需上游补 `session.delete` RPC。

## 现存舰队(2026-08-15 整改后)

| session | 标题 | 状态 |
|---|---|---|
| session-243750f0 | 2437-pump-v35-b2 · code · pump v3.5实现(done,可复用) | 在册可见 |
| session-a409b2c9 | a409-main-to-main-loopback · minimal · B→A回环验证(done) | 已恢复可见 ✅ |

## 多编排者并存纪律(2026-08-30)

四层隔离(steer 属主租约 / 按 to 寻址回调 / ledger flock+状态机 / per-flow state.db)已覆盖执行面互斥;残余共享面靠以下纪律兜底:

1. **ID 命名空间前缀**:flow/node/ref ID 带编排者+波前缀(如 `pm-p1-*`、`rv1-*`、`hf1-*`),杜绝跨编排者撞 key;裸名(w1/step1)只许在单编排者独占期使用。
2. **同仓串行**:同一 repo 的 worktree 写入车道串行——两个编排者派 worker 进同一 repo 时,后到者等前波 close(先例:P1 单车道推进);纯读车道可并行(先例:rv1 三分片)。
3. **ticket 全限定**:ticket 归属写全(repo+编号),跨编排者不复用同一 ticket key;`lease_owner` 天然互斥,但认知面要能一眼分属。
4. **结构面归属见下节**:席位挂谁的树,fleet-tree 一眼可查——不靠翻 steer 日志反推。

## 编排组树:parent 结构面(2026-08-30)

fleet.json 席位条目新增**结构字段**(与 status/role 等执行字段正交):

```
"<code>": { ..., "parent": "<编排者完整签名|父席位码>", "flow": "<波id>", "lane": "<车道标签>" }
```

- **根不在 fleet.json**:编排者活在 bridge/registry.json consumers,fleet.json 只存被编排侧;树根 = parent 值为编排者签名(如 `orch-p0@session-…`)的串,不要求根席位在册。
- **嵌套**:parent 也可指向另一席位码(分组/子树),fleet-tree 按嵌套根渲染。
- **与属主契约正交**:OF-002 steer 租约是**执行面**互斥;parent 是**结构面**标注,不参与 steer 判定——查得出"谁在谁的组里",不代表"谁此刻有权派活"。
- **解除认领**:`fleet-adopt --clear` 抹掉 parent/flow/lane。

工具(preset `bin/`,dev-sync 落地):

```
fleet-adopt <code> <parent> [--flow F] [--lane L] [--clear] [--fleet <path>]   # flock 写,幂等
fleet-tree  [--root <签名前缀>] [--json] [--orphans] [--fleet <path>]          # 只读森林渲染
```

- fleet-adopt:锁与 session-spawn 同款(LOCK_EX 哨兵于 `MAESTRO_STATE/<basename>.lock`,重读→改→temp+os.replace);认领时机 = 编排者派发首个 steer 之前,同波席位同 parent,`--flow/--lane` 标注波与车道。
- fleet-tree:按 parent 聚合成森林;循环引用单列 ⚠ 不进树;无 parent 席位列 unattached(计数提示,`--orphans` 展开);`--root orch-p0` 只看本编排组。
- 两工具均带 `--selftest`(临时 fixture,零真实状态触碰)。

派发协议插一步(第 3.5 步,spawn 之后 steer 之前):

```
spawn → 验席位 → fleet-adopt 认领挂树 → steer 派发(内嵌 cb-send 契约)
      → 独立验证闸 ×2 → ledger → flowc advance(幂等预检)
```

**派发落账三环 SOP(MF-1)**: steer 派发后 ledger 落账三环缺一不可——①node claim
(`ledger node … dispatched`) ②票状态(票面无票先 `ticket add`, dispatched 态与派发
同刻; 状态迁移走 `ticket state`) ③持票(`ledger ticket lease <票> <fleet 席位码>`)。
`bin/dispatch-ticket` 已一体化自动三环(票面无票自动建票再挂 lease); 手工派发等价补齐。
准绳 = /op/tickets 持票计数(lease_owner→pm-web 席位卡), 违例(dispatched/running 无
lease)由 `plugins/pm-host-service/gates/mf-1-lease-gate.mjs` 兜底(豁免=显式白名单,
无席位纯记录票)。

## 签名纪律: 禁止借用他人注册签名(IDX-1)

事故锚: 他线编排跑 `bridge-rearm --sync` 看到 registry 唯一活体消费者签名,派单时
直接照抄(from=他人席+回调=他人签名)——被冒名编排者收到全数错投回调;skill 模板旧文
只说"签名必须写全",未禁借。本节钉死:

1. **派发前必自注册签名**(`bridge-rearm` 无参 / `bridge_arm`);未注册先注册,再派发。
2. **禁止使用 registry 既存他人签名**——那是别的编排者的活体签名,照抄即冒名;
   `--sync` 清扫输出里的签名同样禁抄。
3. **`session-send` 的 from 必为本席码/本席 sessionId**,绝不填他人 alias/sessionId。
4. 收方对称校验: 回调 `to` 非你自己的签名 → 视为错投,拒收并回告发送方
   (cb-send skill 规则 7 同文)。

落点: `shared/maestro-orch` + `shared/cb-send` SKILL.md 嵌同款禁令(grep "禁止" 可验),
dev-sync 同步至 `~/.agents/skills` 对端发现面。

**steer 简报必须内嵌回报全签名**(2026-08-30 and2 死信教训):cb-send 的 `to` 只认
`alias@session-…` 全签名或注册别名——**fleet 4 位码不经桥寻址**(bridge/registry.json
无 fleet 码索引),裸码回报必死信(dead.log)。派发模板写法:
`完成 cb-send 到 <alias>@<sessionId>(必须全签名, 勿用裸码) type=done ref=<票>`。
死信救信先例:旁路席捞 dead.log 转 report + 存档
(`gates/pm009/and2-2-dead-rescue.jsonl`)。
