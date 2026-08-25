# 窄腰三件套实施方案评审报告

> ref: `nw-plan-review` · 评审对象: `docs/narrow-waist-implementation-plan.md`(含 0665041 增补的 §5 统一投递机制 + P5)
> 方式: fan-out 五路专项评审(host-bridge / bin 轻载 / dais 重载 / pump 与退役 / 方案结构)+ 阻断级对抗复核 + 主评审人逐条证据重验(20+ 评审 agent;**所有[阻断]证据均由主评审人亲自复跑命令或重读源码坐实**,包括 dais 真实库 `~/.local/state/dais/warp.sqlite`(32.9MB)、CLI 实测、`~/.dsh/maestro/bridge/` 生产流量与死信日志实测)。

## 0. 评审过程声明与对象版本

- **评审期间方案两次修订**(199 → 232 行): 新增 §5「统一投递机制」与 P5 阶段;原 §5/§6/§7 顺移为 §6/§7(+新 §5),原文未动。本报告行号一律以 232 行版钉死;§5/P5 为增补审核范围(orchestrator 第二道派发),由主评审人独立完成专审(见 §4.⑦)。
- 源码基线: `/home/yy/tools/maestro-preset-iter`(与 maestro-preset 的 plugins/、bin/ 逐字节一致,已 diff);dais 仓 `/home/yy/warpdotdev/dais`;DSH 契约 `@deepseek-ai/dsh-client-runtime`。

---

## 1. 执行摘要

四约束框架与 P1→P4 阶段骨架**成立**,零推倒路线(信封超集/core 提炼/词汇表)方向正确,大量行号级断言经核验准确(§5)。但存在 **17 条阻断**,集中在五簇:

1. **P3 dais 路径(R-B06/R-B07)**: 改造①缺省值 `direct` 不是合法 MessageType(枚举 9 值实测无此值,CLI+DB 双层拒),且 a2a 面全部合法 type 无 dais 映射;消费侧 inbox reader 现状三重断裂(SQL 列名全错/DB 路径指向 0 字节文件/extractRef 对新格式失灵)。**现行重载路径本来就是断的**——真实库 0 条 direct 落库,生产 router-journal 实测 `{'push':30,'denied':3,'mailbox':0}`,重载投递零成功——方案在修复死路径时保留了致死取值,P3"新旧对拍"的旧路径基线本身不成立。
2. **P4 退役/回滚/部署面(R-B08~R-B13)**: 回滚三步不触达运行面(**三个** rsync 部署面: 装点+bin 镜像+polyfill lane);注册 callback-bridge v4 复活 incident 0003/0005 防线;漏 queen-v1 分发面、bridge_http_status 的 persona 硬指令、http.port.sig 清理;polyfill lane 自包含拷贝使 `../_narrow-waist` import 装点 ENOENT;P4 后宿主投递栈拓扑(host lane vs v4 谁常驻)未定义。
3. **库 API 规格(R-B01~R-B04, R-B14~R-B16)**: 词汇表漏活类型 `report`(生产 inbox.log 实测 23 条活跃流量);resolveRouting 泛化未钉死三处形状不兼容;dedup 双查无"双记"且 **v3 默认模式对无 msgid 行摘要恒等**(60s 窗内同 from 消息被误判重吞);registry version 字段被 sanitize 白名单自毁;**"四处同源"前提在 registry 写链上不成立**——按字面"换 import 删内联"会删掉 v3.6 写链修复;resolveAddress 优先级 alias>fleet code **撞名静默错投**(dead.log 已有 orch1 歧义实证)。
4. **P2 验收(R-B05)与阶段归属(R-B17 相关联的 R-S07)**: "content[0].text 逐字节相等"在 Python/JS 序列化差异下必然 100% 失败;cb-send msgid 在 HTTP 主通道被受理面四键重组丢弃,"双通道协议不变"不成立(验收"新版多 msgid"必失败);§6A/§6B 大部改造在 P1-P4 任何阶段清单无落点。
5. **P3/P4 验收可执行性**: 沙箱无 dais 实例,"沙箱 a2a 投递后 SQLite…"的库落点未定义(见 R-S10)。

**总裁决: 需修后实施**(§6:P1 修完五条库规格阻断即可启动;P2 改判据;P3/P4 重写后再排期;P5 补两处精度后可独立并行,且其主收益依赖 C 节先修复死路径)。

---

## 2. 阻断问题(17 条,均经主评审人独立复核坐实)

### R-B01 [阻断] 词汇表漏现存活类型 `report`——event-watchd 监控告警链路会被切断
- 方案: §2.4(L89-98)、§2.1 L42、P1 验收 L129、§6A L193
- 证据: `http-intake.js:31` `TYPES=['ack','done','ask','report','ping','status']`(注释明言 report 在用);`bin/event-watchd:259` 活产线 `subprocess.run([SESSION_SEND, frm, to, 'report', ...])`;`docs/DESIGN.md:181` 契约;`docs/reports/OF-006-report.md:39` 实跑记录。17 Signal 表无 report。
- 影响: P2 升 v3/§6A TYPES 并表后,文件/进程 hung 告警被 400 拒绝,静默断流。
- 修复: 增设第 18 个 Signal `report`(或映射 status 但 denormalize 还原原词);P1 验收改为"全仓 type 白名单点位 ∪ 线上实发类型"全覆盖。点位全景: http-intake:31(6 值)/message-bridge:73(4 值)/a2a http-server:58(3 值)/cb-send:7(4 值)/session-send:6(7 值,仅文档)/pump(无)。

### R-B02 [阻断] `resolveRouting(addr,registry,{self})` 泛化未钉死三处形状不兼容——宿主面投递静默停摆或广播丢消息
- 方案: §6A L196/L194/L223
- 证据: ①broadcast: `pump.js:171-172` 无条件 wake(无 sids、不查 registry);`core/addressing.js:44-47` 零在册→skip、非零→wake+`sids`。②skip 含义相反(pump=属其他消费者;host=广播零在册)。③wake 形状: pump 无 sids、host 必须(`file-router.js:367-368` 裸解引用 `routing.sids.length`);`index.js:172-174` `router.flush().catch(()=>{})` 静默吞异常。
- 影响: 采 pump 语义→宿主面 TypeError 被吞→游标永卡而 HTTP 照常 200=静默停摆;空 sids→该行被记已投递但零接收者(`file-router.js:274-279`),60s 窗内晚注册消费者的重发也被压制=广播丢消息;采 host 语义→泵自身注册完成前收广播被 skip=泵面丢广播。
- 修复: §2.2 补统一函数规格——无 self(宿主)→broadcast 时 sids=在册全集、空则 skip;有 self(泵)→broadcast 恒 wake-self;sids 两种形状必填(泵=只含 self);skip 语义按调用方分支钉死;file-router 防御 sids 缺失;`index.js:173` 静默 catch 改 console.error。

### R-B03 [阻断] dedup "升级期双查"只规定读侧、无"双记"——v3 先走造成重复投递;digestOf v2 模式漏 from 缺失退化分支
- 方案: §2.3 L71-75
- 证据: `core/dedup.js:10-19` 实算法含 `from===null ? line : from\0body` 退化;窗口单索引,写侧唯一点 `file-router.js:275`;L75 只写读顺序。
- 推演: ①v2 先投(记 digest)→v3 重发: digest 命中 ✓;②**v3 先投(只记 msgid)→v2 重发(cb-send.v2 无 msgid 仍在线): 双查全 miss→重复投递**。双向兜底的必要条件是 mark() 双记(msgid+digest 两键),方案无此规定。
- 修复: §2.3 补 mark() 双记;digestOf v2 模式保留 from 缺失→整行退化;dedup.test.mjs 覆盖 v2→v3 与 v3→v2 双向重放断言。

### R-B04 [阻断] registry consumer 条目增 version 与 "sanitize 白名单不变" 自相矛盾——字段永远无法持久化
- 方案: §6A L197
- 证据: `core/registry.js:15-28` sanitizeConsumers 白名单仅 `{alias,pid,armedAt}`;readRegistry 每次读过 sanitize;register/unregister 整表读-改-写。
- 影响: 任一条目写入 version 后,下一次任何 register/unregister 把它剥掉——按方案原文实施该交付物必然不工作。
- 修复: 二选一写死——version 进白名单(注明这是白名单变更,需同步 pump.js:205-218 与两份 core 副本);或沿用顶层 `registry.version`(pump.js:226/core:33 已有)承载代际。

### R-B05 [阻断] P2 验收"wire payload content[0].text 逐字节相等"必然 100% 失败
- 方案: §4 P2 L136、§2.1 L49
- 证据(实测): `session-send:129` Python `json.dumps` 输出 `{"from": "a", ...}`(分隔符带空格);JS `JSON.stringify` 输出无空格——**第 8 字节起分叉**;且新 adapter 默认 10 键 v3 vs 旧 bin 7 键 v2。现网本就两种字节格式并存(`a2a http-server.js:172` 紧凑 5 键行在线),系统契约只是"`]`+json.loads"(`session-send:13`)。
- 修复(三选一): (a) 推荐——判据降为"前缀字节相等+JSON.parse 后 v2 七键深度相等(键值与键序),新三键只验存在与类型";(b) serializeLine 契约复刻 Python 分隔符+键序钉进单测,A/B 走 downgradeV3toV2;(c) 规范化比较+写明"字节格式随生产者而异"。另补边界用例: 非 UTF-8 argv 下老 bin 崩(:143 `.encode()` 抛 UnicodeEncodeError)vs JS 成功。

### R-B06 [阻断] §6C 改造①缺省值 `direct` 不是合法 dais MessageType,且 a2a 路全部合法 type 无 dais 映射——重载分支按方案实施后仍 100% 失败,且方案未察觉现状本身就是断的
- 方案: §6C L215、P3 验收 L143、词汇表 L97-98(notify/ping/steer 的 dais 列全为"—")
- 证据: ①`types.rs:14-33` 枚举恰 9 值无 direct;②CLI 硬拒非法值(`agent_sdk/orchestration.rs:240-241`,实测 `invalid message_type 'direct': Matching variant not found`),DB 层 `CHECK(message_type IN (9值))` 双层拦截;③`http-server.js:58` `ROUTER_TYPES=['notify','steer','ping']` 是 a2a 面仅有三合法 type,词汇表对三者**全部无 dais 映射**→denormalizeType 恒 null→恒走缺省 direct→恒被拒;④真实库实测 `GROUP BY message_type`=status|741+worker_done|29,**0 条 direct**;⑤**生产 router-journal 实测**(E 路,主评审人复核): `~/.dsh/plugins/a2a-profile-server/state/*/router-journal.jsonl` 计数 `{'push':30,'denied':3,'mailbox':0}`——重载路径投递零成功,43 条 DSHMSG] 存量全部是外部探测脚本以 `--message-type status` 写入。
- 修复: 缺省改 `'status'`(messaging.rs:27-33 Status→Ignored 无副作用,与存量先例一致);词汇表显式补 notify/steer/ping→dais 映射(统一译 status);把"修复已断的重载路径"写成 P3 验收断言(沙箱实测投递成功+落库)。

### R-B07 [阻断] §6C 只改发送侧;消费侧 inbox reader 三重断裂未列改造——v3 字段在 dais 载体上无任何落点,"统一信封"在重载路径名存实亡
- 方案: §6C L215-216、P4 验收 L150、§3 L108
- 证据(全部实测): ①`http-server.js:212` `SELECT seq, sender, … WHERE recipient=?`——真实列名 `sequence`/`from_handle`/`to_handle`,**该 SQL 必抛 no such column,agents/inbox RPC 从未工作过**;②`http-server.js:72` DB 路径 `~/.local/share/dais/data.sqlite` 实测 **0 字节**,真实库 `~/.local/state/dais/warp.sqlite`(SKILL.md:36-38 自证);③`extractRef`(:76-82)对纯正文恒返 '-'——改造②后对新格式失灵;④SELECT 不含 subject——改造③把 ref 放 subject 后 preset 侧读不到;⑤messages 表无 msgid/ver/via/ttl 列,信封行从 body 拿掉后 v3 四字段在 dais 载体彻底无落点。
- 修复: §6C 增第④点——修 defaultInboxReader(路径/列名/SELECT 增 subject/ref 解析改"优先 subject、fallback extractRef");二选一写死 v3 字段落点(承认不承载 msgid、去重退 digest 并写明;或 msgid 编进 subject 如 `ref@msgid`),否则 P4 验收条款需删改。

### R-B08 [阻断] P4"增 callback-bridge v4 行"按现状注册即复活 incident 0003 多会话互杀,退化 ack 握手与 PORT-R1,并与 host lane 端口互踩
- 方案: §1 L20 / P4 L149;对照 §6D L223("incident 0003 防线…全保留")
- 证据: v4 是 v3.5/v1.0 时代内核——`callback-bridge/index.js:96-99` 单消费者 + `:179-182` 第二会话 arm 时 sink 无条件重绑(`sinks/agent-turn.js:13-17` 单槽);pump.js:4-7(v3.6)与 message-bridge:427-429 正是为修复此点;`sources/http.js:87` `types=['done','ping','status']` **丢 'ack'**(cb-send:7-9 派发握手类型)→P4 后所有 `cb-send ack` HTTP 面 400;`sources/http.js` 全文不写 `http.port.sig`(grep=0),而 cb-send:36-43 依赖它防撞桥,唯一写入方 message-bridge:513 恰被 P4 删;`sources/http.js:88` `port=0` 随机绑口覆写 `http.port`,与宿主 boot 已绑定的 host lane(`http-intake.js:455`)冲突;v4 设计文档 `docs/callback-bridge-design.md:174` 自承诺 deprecated 别名过渡两稳定周期、§4.2 要求双跑期,P4 一步跳完。
- 修复: P4 前给 callback-bridge 补"升格到 v3.6/v1.3 等价"硬话(按 sessionId 分槽或只注册 file-inbox source、HTTP 面归 host lane;types 补 ack;补 sig 或明示 PORT-R1 退役并同步改 cb-send);否则 P4 不可执行。

### R-B09 [阻断] §6 逐文件清单对已存在的 `plugins/callback-bridge/`(第三份同源 core 副本)零审计——单源化目标自相矛盾;§6D pump.js 改造在 P4 即被删除
- 方案: §6 全节(L186-225 无 callback-bridge 行)、§6D L223 vs P4 L149
- 证据: `plugins/callback-bridge/` 已在仓(version 4.0.0)自带 core/ 四件,与 host-callback-bridge/core/ 的 parseAddress/aliasIndex/registry/dedup 函数体逐字相同(已 diff)——同一套逻辑现存三份。§6 只审计 pump(D 表)与 host-callback-bridge/core/(A 表),对 P4 将注册进生产的 callback-bridge/core/ 一行没有;§1 L24 四 adapter 相对路径引入也不含它。§6D pump 803→~550 行的改造成果活不过 P4 删目录,两段清单互相拆台。
- 修复: 二选一写死——①P4 注册前 callback-bridge/core/ 四文件改 re-export `_narrow-waist`(纳入 §6E 新表,附 R-B08 代差修复);②§6D pump 改造降级"过渡期不实施",P4 直接以 callback-bridge v4+窄腰库为终点。

### R-B10 [阻断] P4 回滚三步(git revert + git checkout + 重启 host)不触达任何运行面,按字面执行等于没有回滚
- 方案: P4 L151
- 证据: 生产 :3080 加载装点而非仓——`bin/dev-sync.sh:14` `DST=~/.dsh/.agent-presets/maestro`(rsync -a --delete);**第三部署面**: `dev-sync.sh:85` bin 镜像 `~/.dsh/maestro/bin`(cb-send/session-send 的稳定回退路径,maestro-bridge skill 的镜像兜底);host-callback-bridge 更走第二部署面: `dev-sync.sh:75-84` polyfill lane `rm -rf+cp -a` 到 `~/.dsh/plugins/host-callback-bridge`,注册在 `~/.dsh/plugins/polyfill.patch.yml`(:88-96),与 agent.cordis.yml 无关。git checkout 只改仓(.git 为 worktree 引用,`gitdir: …/worktrees/maestro-preset-iter`),三个仓外目录原样——重启后 :3080 仍加载新插件新行、镜像 bin 仍是新版。另 `git checkout HEAD~1 --` 隐含"P4 恰为单提交"假设。
- 修复: 回滚补全为 git 恢复 → `bin/dev-sync.sh` 全量重推 → `dev-sync.sh --verify` 三段清零 → 重启 host → 冒烟五路径;P4 变更收敛为单提交或恢复分支;P4 正向部署链(重启前必跑 dev-sync)写进验证条目。

### R-B11 [阻断] `bridge_http_status` 退役不干净——preset persona 逐字指令每个会话开场调用它,替代者无别名
- 方案: §1 L20 / P4 L149
- 证据: 唯一提供者 `message-bridge/index.js:477-525` 随 P4 删;`agent.cordis.yml:100` persona 硬指令 "Session start: arm both callback channels (`bridge_arm`, then `bridge_http_status`)";README.md:147、USAGE.md:37/54/79/128/201、docs/orch-loop.md:9、docs/comm-architecture.md:15,87 引用;替代者 `callback-bridge/index.js` 仅 bridge_arm(:143)/bridge_status(:197) 无别名(grep 全仓无);v4 design:174 自承诺别名过渡。
- 修复: P4 追加 deprecated 别名(或 persona 改写先行)+persona 与文档同步更新清单入交付物。

### R-B12 [阻断] 退役清单遗漏 queen-v1 分发面——另一套已安装生产 preset 仍注册并捆绑旧件
- 方案: P4 L149(全文只涉 maestro 的 agent.cordis.yml)
- 证据: `agent-presets/queen-v1/agent.cordis.yml:334-343` 注册 orca-callback+message-bridge;queen-v1 已安装(`~/.dsh/.agent-presets/` 实测含 queen-v1,自带全套插件副本,pump.js 与仓内逐字节一致);安装走 host/install.sh 第 4 面,dev-sync 显式 `--exclude agent-presets`(dev-sync.sh:22)。queen 侧 message-bridge arm 仍覆写 `http.port`(:372),与 host lane/v4 端口互踩——跨 preset 撞桥重开。
- 修复: P4 补 queen-v1 决策(同步切行携 v4+代差修复,或显式冻结+bridge 目录隔离),二选一写死。

### R-B13 [阻断] polyfill lane 是自包含单目录拷贝——§6A 换 `import '../_narrow-waist/…'` 后装点 ENOENT,host boot 回调链路全断(方案完全未提 dev-sync)
- 方案: §1 L24、§6A L192-199;全篇无 dev-sync 字样
- 证据: `bin/dev-sync.sh:75-84` polyfill **只拷 plugins/host-callback-bridge 一个目录**到 `~/.dsh/plugins/`(实测该目录自包含,`~/.dsh/plugins/` 下无 `_narrow-waist`);host-callback-bridge 按 §6A 改 import 后,装点解析为 `~/.dsh/plugins/_narrow-waist/…`→**模块不存在**;`index.js:208-214` apply() catch 不拖垮宿主 boot,但激活失败=外部→DSH 回调链路(SI-003 全部成果)静默全断。(对照: `.agent-presets/maestro/plugins/` 整目录 rsync,`_narrow-waist` 会同步,仓内 adapter 不受影响。)
- 修复: 方案补部署面——dev-sync polyfill 段增加 `_narrow-waist` 同步(或改拷两目录);P1-P3 触碰 host-callback-bridge 的改造把"dev-sync 变更+重启窗口"列入该阶段交付与回滚。

### R-B14 [阻断] "四处与 core/ 同源"前提在 registry 写路径与 store 写路径不成立——"换 import 删内联"按字面执行会删掉 v3.6 写链修复,多槽并发 ENOENT/丢更新事故回归
- 方案: §6D L223("四处换 import 删内联")、§6A L197(只字未提写链/串行化/唯一 tmp)
- 证据: `pump.js:196-203` registryOpChain 模块级链串行化全部 registry 写(注释原文: "v3.6: 同进程多 pump 并发读改写会撞同一 tmp 路径(ENOENT/丢更新)"),registerSelf/unregisterSelf(:380,:398)全经链;而 `callback-bridge/core/registry.js:43-47` writeRegistryAtomic 用**固定** tmp `${path}.tmp`,:53-77 register/unregister 裸读改写**无链**(host-callback-bridge/core 同,已 diff)。多 pump 同进程正是 slots 机制制造的常态(:687 每会话独立 pump、:751 per-slot createPump、:542 每轮 flush 都 registerSelf)。反向差异: `core/store.js:49-63` 有 writeChain+唯一 tmp(`state.json.tmp-${pid}-${seq}`),pump.js:350-373 saveState 是固定 tmp 无链——换 import 会顺带改变 state 写语义。
- 影响: 字面执行后,两个 armed 会话的 watcher 同时 flush→registerSelf(共享库版),两路读改写撞同一 tmp→ENOENT/丢更新→registry 丢消费者条目→回调被裁 unknown-addressee 进 dead.log——**v3.6 修掉的事故形态被无声复活**。
- 修复: §6A registry 行增写"共享库写路径并入 pump v3.6 写链语义(或统一唯一 tmp+进程内串行化)";registryOpChain 保留写进 §6D 全保留清单;§6A L197"原子读写"现状描述改为"单次写原子、读改写无链"。

### R-B15 [阻断] resolveAddress 优先级 `alias 查 registry > fleet code` 存在跨表撞名静默错投——现网已有 alias 歧义实证(dead.log orch1 行)
- 方案: §2.2 L62(优先级)、L63(plane 判定)
- 证据: L62 优先级把 registry alias 放在 fleet code **之前**;`orch1` 同时是 fleet code(session-send:5 文档示例名)与高频 registry alias——`~/.dsh/maestro/bridge/dead.log` 实测一行(2026-08-24): `"unknown-addressee: alias \"orch1\" is ambiguous across 2 registered consumers"`(一条 to:"orch1" 的 ack 因此死信),证明现网该名双表活跃。现状两套解析互不知名: `session-send:32-42` resolve() 只查 fleet;`core/addressing.js:59-69` bare 分支只查 registry。message-bridge 注释原话(:36-38): "错投比拒收危险"。
- 影响: registry 某消费者 alias 恰与 fleet code 同名时,窄腰 resolveAddress('orch1') 恒先命中 registry alias——发往 DSH fleet 会话的消息被永久劫持到 registry 消费者,**静默错投、无死信、无对账痕迹**;plane 判定(L63)依赖解析结果,连带选错 plane。
- 修复: 撞名改显式死信(复用 "…is ambiguous…" 措辞骨架,reason 注明 alias/fleet 冲突)或强制 `agent://` 显式形式;至少 resolveAddress 返回带 `ambiguous:true` 让 adapter 拒发;P1 验收 L129 补撞名用例。

### R-B16 [阻断] digestOf 默认 v3 模式对无 msgid 行(cb-send 4 键行/存量 v2)产生恒等摘要——60s 窗内同 from 的不同消息被误判重而静默吞
- 方案: §2.3 L72(`digestOf(envelope, mode='v3') // v3: sha256(from\0msgid)`)、L75(双查)
- 证据: 生产 inbox.log 尾部实测多行 4 键格式(cb-send:30-31 产物,无 msgid 无 ver)——这是 inbox 现存主力流量;方案默认 mode='v3' 时 material=`from\0msgid`,对无 msgid 行退化为 `from\0undefined`——**同一 from 的所有消息摘要恒等**。现有调用点均不传 mode(`file-router.js:353`、`http-intake.js:266`)。叠加 L75 双查: mark 侧若用 v3 摘要记窗,60s 内同 from 的第二条不同消息被 seen 命中→静默丢弃。
- 影响: 消息丢失级——去重主键设计在无 msgid 主流量上从"误报免疫"变成"必错"。
- 修复: 写死 digest material 分流——`parsed.msgid ?? parsed.body`(有 msgid 用 msgid、无 msgid 用 body),或 digestOf 恒用 from\0body 与现状逐字一致、msgid 只做独立索引;双查写清 seen/mark 两侧各自查/记哪个键;单测加"同 from 连发两条不同 4 键行,零误判重"断言。

### R-B17 [阻断] cb-send v3 的 msgid/ver/via/ttl 在 HTTP 主通道被受理面四键白名单重组丢弃——"双通道协议不变"不成立,P3 对拍断言在主通道必失败
- 方案: §6B L206("增 msgid…HTTP 与文件双通道协议不变")、P3 验收 L143("新版多 msgid/ver/via/ttl")
- 证据: `http-intake.js:265` 受理落盘行 `JSON.stringify({type,from,to,body})` 白名单重组——payload 里的 msgid/ver/via/ttl 一律丢弃(validate :84-102 也只认四字段);message-bridge 侧同构(:305)。cb-send 加 msgid后: 文件桥路径(cb-send:58 整串落盘)带 msgid,HTTP 优先路径经受理后落盘行**不带**——同一命令两条通道产出不同 schema。
- 影响: ①`--msgid` 重发保号在主通道失效;②§3 L108"from+msgid 去重主键"在主通道无键可用(与 R-B16 叠加);③P3 验收"逐字段一致(新版多 msgid)"若对拍落盘行则主通道必不符,若只对拍发送 payload 则掩盖丢弃——判据两头不成立。
- 修复: 显式三选一——受理落盘行透传 msgid(动 :265,需在 §0 约束 2 开显式例外并同步 MSGBR]/ORCA-CB] 面);或 v3 字段只走文件桥(HTTP 通道明示不携带);或以 HTTP 应答 `id: randomUUID()`(http-intake.js:298)回填作 msgid 源。并据此修 P3 对拍判据(按通道分列)。

---

## 3. 建议问题(按维度归组)

### ② 库 API / 规格

- **R-S01 dedup 标记时机与签名**(B/D 路): ①message-bridge 现窗口"wake 成功后 mark"(:333)——共享窗口若 seen 时即 mark,wake 失败重试得 208"已投递"而实际未投(直连 curl 用户静默丢唤醒);调用序锁定 seen→wake→(仅成功)mark。②现签名 `digestOf(line,parsed)` 与方案 `(envelope,mode)` 不同构,"逐字兼容"表述改为"摘要材料公式一致+保留 (line,parsed) 兼容层供原位 re-export";windowMs 默认 60s 是改进应写明。③208 回放的 `id` 语义靠 `meta` 参数承载——§2.3 L73 的 `{seen,mark,prune,size}` 四键签名漏 meta,实施者会漏接(message-bridge:293-300 依赖 prior.id)。
- **R-S02 cb-send msgid 双通道分叉**(B/D 路): HTTP 受理面摘要键 sha256(from\0body)(message-bridge:286-288)不含 msgid;canonical line 四键重建(:305)规格性丢弃 msgid——文件通道携带、HTTP 通道不携带,"两通道统一此格式"被 v3 打破而方案未置一词;收方 msg-dedup 对 MSGBR] 行恒 pass(msg-dedup:92-94)。P3 对拍 L143 若覆盖 HTTP 通道,"新版多 msgid/ver/via/ttl"断言必失败。修复: 裁决"HTTP 通道维持四键 canonical line,v3 字段仅文件通道携带,对拍按通道分列",或规定 :305 透传(则 MSGBR] 行格式变化,需改 §7 表述);"重发保号"生效前提=payload.msgid 接入受理面双查键。
- **R-S03 ref 双真相无权威裁决**(B 路): cb-send 折 ref 进 body 前缀(:31),v3 又列 ref 一等字段,§6C 再引入第三编码(subject)。建议: 升格期双写,权威=独立字段,前缀标 legacy 于 P4 退役,对拍断言 `envelope.ref == 前缀解析值`。
- **R-S04 steer 闸共享化三风险**(B 路): find_entry 查表梯(fleet 精确→前缀,:56-65)与 resolveAddress 全梯不同——混用则 no-entry 放行变 exit 4 拒绝,可拦集合静默扩大;两处 journal 落点与 reason 四值被 `tests/of002-selftest.py:124,256` 钉死,移植须逐字保留(abspath 非 realpath、$MAESTRO_STATE 缺省链);`--via` 解析规则需定义(=--msgid 同款,禁空串,含逗号=追加)。库内提供独立 entry-level 查表函数,与路由 resolveAddress 分离。
- **R-S05 fleet-resolve 两语义不能朴素合并**(B 路): fleet-touch get_entry(实 :137-141)仅精确命中否则 die;session-send resolve(:32-42)含前缀回退。统一函数须参数化 exact/prefix,否则 claim/heartbeat/release 的"零变化"被破坏(精确 miss 键会静默命中某 session-* 条目并写租约)。
- **R-S06 'direct' 与存量值的 normalize 方向**(A/C 路): DAIS_TYPE_MAP 需显式 direct 条目(归 null 或 status);vocabulary.test.mjs 加存量值('direct'/'report'/'status')直通用例。
- **R-S24 "TYPES 改共享常量"无匹配常量**(D 路 D-N3): 全方案唯一 type 常量 V2_TYPES(7 值)不含 status、反多 pong/ask/steer/nack——照做即改行为(status 回调 400→cb-send 降文件桥,HTTP 快道 208 语义对该类型丢失;或 pong/ask/steer/nack 由拒收变可投递,扩面)。修复: 增设每平面入站白名单常量(如 `DSH_CALLBACK_TYPES=['ack','done','ping','status']`)并指名。

### ③ 阶段 / 验收 / 回滚 / 负向边界

- **R-S07 §6 表全部无阶段归属——同一动作三重矛盾**(B/E 路): session-send 升 v3 在方案里出现**三种归属**: P2 承诺一行不改(L138)、§6B 列为改造(L205)、§5C 说"或 P3 内同步"(L217);cb-send 明落 P3(L142)但与 P2"一行不改"承诺冲突;**§6A 八文件(host-callback-bridge 全部 import 换源)与 §6B message-bridge 行在 P1-P4 四个阶段的交付/验证/回滚/不动清单里均无落点**——按 §4 执行完 P4 这些改造根本不会发生,§6 清单成为空文;message-bridge 若 P3 改造 P4 即删(532 行插件)是短命投资。修复: §6 加"阶段"列(§6A/§6B message-bridge 行并入 P4 或新设 P3.5);session-send 升 v3 二选一钉死(推荐 P3,与 cb-send 同阶段);删掉 §5C"或…"模糊表述;message-bridge 改造整行删除(P4 直接退役,dedup 单一化由 host lane 承接)。
- **R-S08 P3 回滚盲区**(主评审人): revert http-server.js 后,已写入 SQLite 的新格式消息能否被消费取决于 R-B07 reader 修复是否同批 revert——回滚顺序需写明。
- **R-S09 负向边界缺失**(主评审人): ttl 谁减/≤0 死信在哪判/via 环回、broadcast 部分成功的 dedup 标记(对照 file-router deliverPending"全部终态才 mark")、17 闭集外 type 的 v3 信封在 validateEnvelope 与下游的遭遇、cb-send 4 键裸行被 detectVersion 判成什么(无 msgid 无 ver→null?)——均未写。
- **R-S10 验收可观测性**(E 路+主评审人): ①沙箱 :3081 DSH 面**有真实支撑**(E 路实测 `/home/yy/tools/dsh-comm-sandbox/run.sh` 存在且 127.0.0.1:3081 在线,`docs/comm-architecture.md:153` 有并存验证记录)——但**沙箱只有 DSH 面,没有 dais 实例**: P3"沙箱 a2a 投递后 SQLite messages 表…"的目标库落点未定义,实测只能打生产 warp.sqlite 即违反约束 4——需沙箱 dais 实例或 `A2A_DAIS_DB` 指到临时库;②P4"24h 无回归"无判据——现成可观测面未引用: hostBridge.http counters(http-intake:145-158 镜像进 state.json)、file-router counters(:89-101)、dead.log 零新增、router-journal 无 failed——应写成可判定断言;③对拍基底 OF-005 模式属实(of005-selftest.py:371-377 `[ ok ]/[FAIL]` 原子断言、全 temp 域、幂等可重跑)✓。
- **R-S25 P5 验证可执行性**(主评审人): "沙箱 dais 实例新旧二进制双跑"需 dais 工具链重建(rust-toolchain/diesel),方案未给沙箱实例的落点/环境变量隔离手段(A2A_DAIS_DB 注入点已存在 http-server.js:72 可复用);量延迟的 arrival→指针行出现用 observable 手段(如 delivered_at 与 created_at 差值直查 SQLite)应写明。

### ④ 逐文件清单与代码现状核对(行号勘误表)

方案行号系统性停留在旧基线,现状"质"多数成立但锚点漂移,按行号施工会改错位置:

| 方案引用(新版行号) | 实际锚点 | 偏差 |
|---|---|---|
| §6A index.js:98-137 "import core 四模块闭包组装"(L192) | imports@27-34 且只引 store/dedup 两 core 模块;组装@144-177;全文 228 行 | 双重错位;"~170→~120"基数不符 |
| §6A http-intake.js:7-8,41,119-186(L193) | TYPES@31;validate@84-102;createHttpIntake@117-189 | 7-8 是注释,41 是 IPv6 归一化 |
| §6A file-router.js:61-106=flush()(L194) | flush()@285-383;61-106=配置/守卫/游标读 | 整段错位(链描述准确: :336/:353-354) |
| §2.2 addressing.js:4-16/20-30(L64-65) | parseAddress@18-24;aliasIndex@27-35 | 引用的是注释 |
| §6B session-send:21-28,44-60,83-92(L205) | resolve@32-42;parse_ts@45-53;find_entry@56-65;steer_gate@76-100;信封@127-129 ✓ | resolve 完全在区间外;steer_gate 被截半(78-81 属主判定与 98-100 journal 落点恰是核心) |
| §6B cb-send:38-41(L206) | payload@28-32;38-41=PORT-R1 签名比对 | 锚点错位;现状漏"body 恒带 [ref:] 前缀" |
| §6B message-bridge:164-175,221-240(L207) | dedup Map@168-176;TYPES@73;判定@215-217;validate@210-228 | 221-240 是 body/to 校验+handle 前奏,不含 TYPES |
| §6D fleet-touch:105-118(L224) | get_entry@137-141;105-118=LEASE_KEYS/fleet_lock | 错位 |
| §6D pump.js"同源 101-110/127-187/189-226"(L196-198 注) | digestOf@106-115;parseAddress/aliasIndex@142-159;resolveRouting@171-192;registry@194-239(register/unregister@375-410);store@287-373;flush 内 dedup@609-617/638-639 | "445-450"实为 appendEcho/noteDelivery,内容错位非漂移 |
| §2.1 a2a http-server.js:45(L45) | ROUTER_TYPES@58(:45 是 ROLE_VALUES) | 漂移(内容属实) |
| §2.1 types.rs:14-27(L45) | 枚举跨 14-33(漏 question/heartbeat 行) | 漂移(9 值属实) |
| §6C 重载分支 160-186(L211) | heavy 判定@161;dais 调用@171-179 | 偏宽(属实) |
| §6D SKILL.md:50-55(L225) | :49-55 | ✓ 准确 |
| P4 AGENT_CARD 路径 `shared/skills/maestro-bridge/`(L149) | 仓内实为 `shared/maestro-bridge/` | 路径错误 |

- **R-S11 pump"全保留"清单漏 18 项**(D 路 D-F8): pump 特有机制全清单 27 项(全部带行号,见 `.nw-review-D-raw.md`),方案明列 4、间接覆盖 4、**漏 18**——其中退避死信(:470-479,619-635)、undertaker(:481-494)、DSH-RE] 回声归档(:441-448)、幻注册对账(:767-778,0003 防线第二半)、registryOpChain(→R-B14)、游标钳位(:546-550)、at-least-once 游标语义、registry 幂等续期/落盘失败内存兜底(:377-393)、teardown(:790-800)是投递正确性与两次事故防线的实质载荷。建议 §6D pump 行显式声明"flush() 内一切非路由逻辑逐行保留,只换 resolveRouting 调用点",并按清单逐项点名。

### ⑤ 风险识别

- **R-S12 registry last-writer-wins 无对策**(A 路): host 版 core 无链(R-B14 之外),跨进程(HTTP 面 register/unregister 与 pump registerSelf)仍 LWW(store.js:49-50 注释自认);P1 提炼后更多进程共享写路径,暴露面放大。建议库版内置 per-process 操作链+评估 flock(OF-002 对 fleet.json 有 temp+rename+flock 先例)。
- **R-S13 轻/重载分叉缓解二维度错配**(C 路): L217 两缓解中,"P3 内 session-send 升 v3"解决不了分叉——v3 不改 `DSHMSG]` 前缀,"v2→v3"与"有信封行→无信封行"是正交维度。有效的是缓解一(extractRef 已天然双格式)。全仓 DSHMSG] 消费方: 轻载线=session-send:129→msg-dedup:4;重载线=dais body→defaultInboxReader/extractRef+executors/dais.js:119-124;两线 reader 互不相交。拍板缓解一并写明两端 reader 名单,删除缓解二。
- **R-S14 http.port.sig 生命周期**(A 路): host lane 只写 http.port 不清 sig;P4 删 message-bridge(唯一 sig 写入方 :513)后残留 sig 使所有定向 cb-send 永久绕开活着的宿主 HTTP 口(cb-send:36-43)直落文件桥——消息不丢但受理语义与入口去重失效。P4 清单加"删除/覆写 sig"。
- **R-S15 msgid 主键平面退化**(A 路): 受理落盘行固定四键(http-intake:265),msgid 在此被丢弃——§3 L108"msgid 升为去重主键"只覆盖 DSHMSG] 平面。方案应显式声明各平面去重权威(与 R-S02 联动)。
- **R-S22 P5 主收益对 C 节有顺序依赖**(主评审人,§5/P5 专审): P5 的延迟改善对象是"指针注入";而 a2a 重载路径现状已断(R-B06),修好之前 P5 对该路径无感知意义;反向无依赖(C 的验收不依赖 P5)。独立性主张在**仓与部署轴层面成立**(C 改 preset 的 CLI 参数构造,P5 改 GUI 侧 router/store,零文件交集),但**收益层面单向依赖 C 先行**——建议 P5 排期注明"C 节修复后 P5 收益才对 a2a 重载路径成立"。

### ⑥ 遗漏 / 过度设计

- **R-S16 callback-bridge 目录去留未表态**(A 路): 未注册死代码,但是 core/* 平移源头、多处注释引用——P4 明确删或留。
- **R-S17 AGENT_CARD.json 无现存消费者且路径错**(主评审人): 全仓 grep 仅方案自身提及;实路径 `shared/maestro-bridge/`。建议降 P4 可选项。
- **R-S18 downgradeV3toV2 用途存疑**(主评审人): 唯一合理场景是 R-B05 修复选项(b)——若按选项(a)修判据,可降为可选。
- **R-S19 消息大小边界不统一**(主评审人): HTTP 面 256KB(http-intake:29),dais/PTY 面无上限,cb-send SKILL 约定单行 ≤4KB(PTY 上限)——§7 未涵盖。
- **R-S26 v4 行 cordis config 形态未裁决**(D 路 D-N6): 现两行均无 config 键;DEFAULT_CONFIG 双 source 全启——"两行换一行"等价性押在未成文默认值上,且该默认正是 R-B08 的事故面。P4 交付物应给 v4 行完整 YAML 字面+默认双 source 与被删两插件行为面差异表。
- **R-S27 pickRecipient"留应用层"一句带过**(D 路 D-N7): 两表分工三细节未说清——①分工前提被 R-S02 打破(两通道字段集不再一致);②208 回放 id 依赖 meta 参数(见 R-S01③);③P4 删 message-bridge 后 sig 校验自然放行、全量落文件桥,分工退化为单表的终态未画出。

- **R-S28 resolveRouting 参数序陷阱**(E 路 E-S03): pump.js:172 现签名 `resolveRouting(address, self, registry)`(self 第二参),方案泛化签名 `resolveRouting(addr, registry, {self})`——若库导出换序,pump 全部调用点错位传参(registry 传进 self 位)→路由全错,且不是"纯 import 替换"。修复: 库内保留 pump 原签名作底层,新签名作门面薄包装;§6D 注明"pump 调用点零改动"的前提是签名不动。
- **R-S29 steer 审计三件套双写归属**(E 路 E-S13): P2 起旧 bin 与新 adapter 双跑,两边都 append 同一对 jsonl(fleet-conflicts/steer-journal)——Python dict 键序 vs JS 对象键序不一致会污染对账工具;exit 4 语义与 stderr 文案是上层脚本依赖契约。修复: appendJsonl/steer_gate 副作用三件套提炼为库函数或明确双实现逐字段一致;P2 对拍加"两路 conflict/journal 行结构一致"断言。
- **R-S30 P4 后宿主投递栈拓扑未定义**(E 路 E-S14): host-callback-bridge 不在 cordis.yml(走 polyfill.patch.yml),P4 注册 callback-bridge v4 行后——两 lane 并存靠 standby 探活互让,还是 polyfill 退役?polyfill.patch.yml 行的去留、v4 与 host lane 的分工声明(谁常驻、谁是兼容层)在退役清单里缺席。与 R-B08/R-B13 联动裁决。
- **R-S31 P1 store 单测落盘域**(E 路 E-S15): 库含 store.js 提炼,createBridgeStore 直写真实 bridgeDir——单测若不注入 temp bridgeDir 会写 `~/.dsh/maestro/bridge/` 真文件;"删目录即回滚"成立的前提是零外溢。修复: P1 验证补"全部单测在 mktemp -d 桥目录下运行,断言 ~/.dsh/maestro/bridge mtime 不变"。
- **R-S32 v3 信封膨胀 vs 三档大小限制**(E 路 E-S12): v3 头部净增约 90-130 字节,而 PTY 单行 ≤4KB(maestro-bridge SKILL.md:68)、HTTP 256KB、a2a heavy 阈值 256B(http-server.js:103)——body 接近 4KB 时信封膨胀破限。修复: §3 补"大小预算"行+超限行为+4KB 边界对拍用例。
- **R-S33 normalize 未知 type 与 legacy-4key 四态未定义**(E 路 E-S09/E-S10,扩展 R-S09): ①normalizeType 对未知 type(report 之外的误拼如 "Status"/"donee")返回什么(透传?null?抛?)未写,大小写归一未提;②v2 识别"有 msgid 无 ver"不覆盖 cb-send 4 键行(无 msgid 无 ver)——detectVersion 返 null,而 4 键行是 inbox 主流量,parseLine 对 null 版本行的处置悬空。修复: 定义四态 v3/v2/legacy-4key(rawVersion:null,原样透传按旧式路由,ref 从 body 前缀提取)/malformed;normalizeType 未知值透传+打标 `{signal:null,source:raw}`,闭集校验留应用层白名单。

---

## 4. 六个审核维度 + §5/P5 增补专审 结论

### ① 四约束贯穿性

- **约束 1(无服务进程)✓ 贯彻**: 库+查表+协议约定,adapter 骑既有落点(host 进程/dais 线程/Orca 运行时);P5 改 GUI 内线程不新增进程;v4 注册不新增进程。无违例。
- **约束 2(信封不载体)△ 结构性张力未裁决**: 载体确实一字未动,但"msgid 去重主键"在不改载体的平面上无法生效——http-intake canonical line 四键(R-S15)、MSGBR] 行四键(R-S02)、messages 表无 v3 列(R-B07)。三处都需要方案明示"该平面去重权威=什么",目前只字未提。
- **约束 3(零推倒)△ P4 实质破功**: v2→v3 超集/core 提炼/词汇表是升格 ✓;但 P4 删两插件+注册 v4 是**换零件**,v4 是 v3.5/v1.0 内核(R-B08)——旧资产携带的两条事故修复被推倒。零推倒要在 P4 兑现,前提是 R-B08 的代差修复先行。
- **约束 4(沙箱先行)△**: P1/P2/P3 遵守;P4 生产重启有安静窗口声明(可接受);但 P3 的 dais 沙箱验证手段与 :3081 来源未写(R-S10/R-S25)。

### ② 库 API 漏洞

R-B01~R-B04、R-B14~R-B16、R-S01~R-S06、R-S24、R-S28、R-S33。**done≠worker_done 裁决本身站得住**: cb-send done 是纯文本摘要、worker_done 是 JSON 生命周期载荷,dais messaging.rs:22-33 仅对后两者接 reconciliation——两侧语义确实不同源,区分有据;出站翻译责任在 adapter(L100)方向正确。缺口集中在: 词汇表**闭集不覆盖现状**(report/direct/每平面入站白名单)、dedup 三个规格级漏洞(双记缺失 R-B03/digest 恒等 R-B16/标记时机 R-S01)、addressing 两个(形状不兼容 R-B02/撞名错投 R-B15)、registry 两个(version 自毁 R-B04/写链不等价 R-B14)。

### ③ 阶段依赖 / 验收 / 回滚 / 负向边界

R-S07(阶段归属三重矛盾: 同一动作三种归属+§6A/§6B 大部改造无阶段承载)、R-B05(P2 判据)、R-B17(cb-send 主通道 schema 分叉)、R-S08/P4 回滚(R-B10,三个 rsync 部署面)、负向边界(ttl/via 四项全缺 R-S09、normalize/legacy-4key 四态 R-S33、digest 恒等 R-B16、撞名错投 R-B15)、验收可观测(R-S10: 3081 DSH 面有 run.sh 支撑但沙箱无 dais 实例;"24h 无回归"需写成可判定断言)。阶段骨架 P1→P2→P3→P4 依赖序本身合理(库先行→单 adapter 对拍→多 adapter→退役),P5 独立轴成立(见⑦);P1 单测落盘域需补约束(R-S31)。

### ④ 逐文件清单与代码现状

行号勘误表 14 处(§3④);§6 缺第五张表(callback-bridge,R-B09);pump 全保留清单漏 18 项(R-S11);cordis 切行 config 形态未定(R-S26);resolveRouting 参数序陷阱(R-S28);AGENT_CARD 路径错误(R-S17)。现状描述的"质"多数准确(§5 verifiedOk)。

### ⑤ 风险识别

方案自己识别的三风险中,"轻/重载信封分叉"识别正确但缓解二错配(R-S13);"registry last-writer-wins"在方案文本无对策条目(R-S12+R-B14——且"换 import 删内联"会把 pump 侧已有的对策一并删掉,比不作为更糟);"跨进程共享单源化"被 R-B13(部署面)与 R-B09(三副本)双向击穿。方案未识别的: sig 残留(R-S14)、msgid 平面退化(R-S15/R-B17)、v4 代差(R-B08)、queen 面(R-B12)、**撞名错投**(R-B15,dead.log 已有实证)、**digest 恒等吞消息**(R-B16)。

### ⑥ 遗漏 / 过度设计

遗漏为主: report 类型(R-B01,生产 23 条活跃流量)、reader 修复(R-B07)、dev-sync 三部署面(R-B10/R-B13)、queen-v1(R-B12)、persona/文档同步(R-B11)、消息大小三档边界(R-S32)、P4 后投递栈拓扑(R-S30)、steer 双写归属(R-S29)、P1 单测落盘域(R-S31)。过度设计倾向轻微: AGENT_CARD.json(R-S17,全仓零消费者,另有 a2a 标准 `/.well-known/agent-card.json` 端点可参照)与 downgradeV3toV2(R-S18)可降级为可选——不是错误,是排期性价比。

### ⑦ §5/P5 增补专审(第二道派发范围)

**语义裁决——站得住(双头论证机制已逐点验证)**:
- "read 闭环只有拉链拥有"属实: `read=1` 全仓恰两个写点,均在 store 拉链函数内(`store.rs:1180` drain_inbox 事务、`:1196` mark_messages_read);push 侧只动 delivered_at(delivery.rs:13-14)。
- 双头两头机制真实: ①直注正文不标 read→drain_inbox 仍返回该行→双消费;②发送时标 read→PTY 写失败后拉链永不可见(read=1 过滤)→永久丢。所选第三条路(指针+`delivered_at` 仅在指针写成功后落)恰好避开两头,与 delivery.rs 头注释一致。
- "结构化插 turn 仅 DSH 收方"引文属实(contract/session.d.ts:34 `'queue' appends a turn; 'steer' interrupts the running one`,方案引源码行 session.ts:38 为编译前路径);外部 harness 无 queue 契约的论断与 loopback-sink 头注(:10-12,旧 sink busy→inject 会打断)互相印证。B 链 500ms/bracketed paste/单独 \r(prompt_injection.rs:22,44-48)✓。

**Condvar 改造点范围——不完备,漏一处生产落库点**:
- `enqueue_message`(store.rs:1142 insert)生产调用面恰**两处**: ①`app/src/ai/agent_sdk/orchestration.rs:243`——GUI 转发的 send-message(方案 §5.3 写的"落库点"即此);②**`app/src/ai/orchestration/block_settle.rs:95`——worker shell block 结算时自动入队 worker_done 给 orchestrator**(方案未提)。router.rs:282/delivery.rs:242,370 为测试代码。
- 后果: notify 只挂 send-message 路径时,**编排生命周期消息(worker_done)——恰是 P5 延迟改善的最大受益者——仍走 500ms~2s 盲轮询**,方案"落库即触发"的效果主张对最关键消息类静默失效(正确性不受影响,轮询兜底仍在)。
- 修复(一行话): notify 收口放在 `store.enqueue_message` 成功返回处(单一挂点),而非任一调用方——一劳永逸覆盖两处及未来新增入队面。另注: headless(CLI 直写 DB,无 GUI)时 router 本就不启动(is_cli_mode guard,app/src/lib.rs:1166-1168),notify 无意义,不受影响。

**P5 独立性主张——仓/部署轴层面成立,收益层面单向依赖 C 节**:
- 零文件交集: C 节改 maestro-preset 的 http-server.js(CLI 参数构造);P5 改 dais 仓 router.rs/store enqueue;部署轴独立(dais-build 重建 vs host 重启)✓;回滚互不牵连 ✓。
- 两个注意: ①R-S22——a2a 重载路径现状已断(R-B06),C 修复前 P5 对该路径无感知意义,建议 P5 排期注明顺序;②P5 与 C 共用 dais 沙箱验证资源(R-S25),若 C 的对拍含时延断言,需注明基线随 P5 变化。

**不变量四条——全部可测,但方案未把断言列成测试**:
- 可测性基础现成: PushPlane 的 executor 是 trait(Arc<dyn PtyExecutor>)可注入 mock;signal_probe 可注入 Busy/Idle;store 有 in_memory 构造(router.rs:290 测试已在用);drain_inbox/mark_read 直查可断言。
- 逐条: ①"指针写成功才落 delivered_at"→mock executor 抛错+断言 delivered_at IS NULL;②"pending 以 SQLite 为准,内存 watermark 只防重复注入"→双消息+重启丢 watermark 场景断言不漏不重;③"idle 闸不跳过"→notify 到达但 probe=Busy 断言零注入;④"拉链权威"→push 后断言 read=0,check-messages 后 read=1。
- 方案 §5.3"验证"行只写了"Condvar 唤醒+notify 丢失兜底"单测与双跑延迟——**四不变量的断言清单应补进验证条目**,否则"不变量(必须保持)"只是口号。

---

## 5. 已核实为准确的方案断言(节选,给实施者信心)

- **信封/轻载**: LINE_PREFIX 来源 session-send:129 ✓;V2_TYPES 7 值逐字 ✓;forgeMsgid 同构 ✓;v2 七键键序 ✓;steer 拒绝 exit 4 可复刻 ✓;msg-dedup 与 v3 行兼容(多键忽略)✓;60s 窗口三处对齐 ✓
- **dais**: MessageType 9 种 strum 枚举逐一对照无多无少 ✓;worker_done/heartbeat 有生命周期副作用、其余 7 型 Ignored ✓(messaging.rs:22-33);send-message 签名 from/to 位置参数"已现场核实"属实 ✓(CLI --help 实测);"存量 SQLite 43 条 DSHMSG] body"数字精确 ✓(真实库实测);SKILL.md:49-55 约定段 ✓
- **host lane / pump**: loopback-sink 零 core 依赖"整文件不动"可执行 ✓;'dead' reason 四条措辞两侧逐字一致 ✓;validate 只查四字段不拒未知键 ✓;轮转闸门/initialCursor/persistState 分节/store 原子写描述准确 ✓;pump.js 803 行 ✓;dedup/addressing/registry 三组核心函数与 core/ 逐字同源 ✓(注意 R-B14 的两处**不等价**排除项);message-bridge TYPES 与 cb-send 4 值集一致 ✓;pump 无 type 白名单 ✓(grep 零命中)
- **§5/P5**: "No failure path mutates the DB except a successful pointer write"(delivery.rs:13)✓;"check-messages 是 authoritative consumer"(:19-20)✓;router.rs 盲轮询参数(POLL 500ms/3 次退避 2s,:27-29/:100-127)✓;"移植自 Orca deliverPendingMessagesForLeaf"(delivery.rs:4)✓;queue/steer 契约引文 ✓(d.ts:34)
- **E 路补充确认**: 沙箱 :3081 有真实支撑且在线(dsh-comm-sandbox/run.sh + ss 实测 LISTEN,修正主评审人此前"无支撑"的初判)✓;"preset 目录复制分发、裸名 import 不可达、相对路径可行"选型依据成立(agent-presets mount.js/discovery.js 实测)✓;comm-topology.html 关键主张与实测一致(含"生产实测 43 条 DSHMSG] 进 body")✓;OF-005 对拍基底模式属实(of005-selftest.py:371-377)✓;messages 表 subject 列 NOT NULL(schema 实测,§6C③ schema 层可行)✓;session.prompt wire 形状与 resolveApiPort 三级回退 ✓;steer 闸四 reason 逐条吻合 ✓;dais-orchestration SKILL.md 约定段 ✓

## 6. 总裁决

**需修后实施。**

| 阶段 | 裁决 | 前置条件 |
|---|---|---|
| P1(库) | 修后可启动 | R-B01/R-B02/R-B03/R-B04/R-B14/R-B15/R-B16 七条规格阻断 + R-S01/R-S06/R-S24/R-S28/R-S31/R-S33——全部是方案文本级修订,不动架构 |
| P2(dsh adapter) | 修后可开跑 | R-B05 修正验收判据;steer 按 R-S04/R-S29 锁定语义与审计三件套 |
| P3(dais/orca/cb-send) | 重写 §6C 后重排 | R-B06/R-B07(缺省 status+reader 修复+v3 字段落点裁决)+R-B17(cb-send 主通道裁决);§6 加阶段列(R-S07);沙箱 dais 落点(R-S10) |
| P4(退役) | 重写后方可进入 | R-B08~R-B13 六条全部命中本阶段(v4 代差修复/回滚补 dev-sync 三面/queen-v1 决策/别名过渡/sig 清理/_narrow-waist 同步)+R-S26/R-S30(投递栈拓扑) |
| P5(dais 到达事件) | 修两点后可独立并行 | notify 收口改挂 store.enqueue_message(漏 block_settle 落库点);四不变量断言补进验证条目;注明对 C 节的收益顺序依赖(R-S22) |

修改完成后建议对修订版做一次快速复审(重点: 词汇表闭环、digest/去重语义、resolveAddress 撞名裁决、§6 阶段列、§6C/P4 重写段、§5.3 notify 落点),无需全量重评。

---

*评审产出原始材料: 五路结构化 findings(20+ agents,含阻断级对抗复核)+ 主评审人复核记录;D 路补充评审 `.nw-review-D-raw.md`(27 项机制清单+D-N1~N7);E 路补充评审 `.nw-review-E-raw.md`(22 findings: 6 阻断+16 建议,24 verifiedOk 含生产 inbox.log/dead.log/router-journal 实测)。*
