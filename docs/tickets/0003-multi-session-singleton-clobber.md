# 0003 — 多编排会话单例互杀:bridge 插件 state 未按 session 键控

> 状态: IMPLEMENTED(pump v3.6 / message-bridge v1.2,测试 22+3+10 全绿,待重启验证) · 发现于 0002 冷测 E2E · 证据全落盘(~/.dsh/maestro/bridge/)

## 现象(2026-08-16 02:09-02:40Z 实测)

同宿主进程(pid 1266839)两个 maestro 会话: 我(session-313e6f7f, workspace
`--home-yy-tools-maestro-preset--`)与 orch1(session-9a173a3d, `--home-yy-.dsh--`,
fleet.json 旧编排者)。两者各自 bridge_arm/bridge_http_status 后:

1. **HTTP 绑定抢占**: message-bridge `apply()` 的 `state.agent` 是闭包单例,
   后 arm 者覆盖先者(wake 只认 state.agent)。冷测 3 条 delivered(02:31,to=我的
   签名)实际唤醒了 orch1 的会话——我零收到。http.state.json 计数/last 为证。
2. **文件桥幻注册**: orca-callback 同为闭包单例。我的 arm 回执声称 registered,
   但 registry.json/游标文件从无我的条目;我的定向 ping 两度死信
   ("no registered consumer with sessionId session-313e6f7f",dead.log 02:37:15/
   02:39:53)。arm 同回合 2 秒后读盘,条目已不在——**注册写入被异步 dispose 卸册**
   (`ctx.effect` teardown → `pump.dispose()` → `unregisterSelf()`,并 close watcher)。
   唯一存活的 pump 是 orch1 的(其 undertaker 在死信我的行)。
3. **代际竞写**: 02:09:18.884(我)/.885(orch1) 两次 registerSelf 读改写相隔 1ms,
   后写覆盖前写——共享 registry.json 无并发防护。

## 根因(白盒确认,2026-08-16 11:40Z)

- **preset 按 standing scope 只挂载一次**(agent.cordis.yml 头部自述): `apply()` 全程
  只跑一遍,`state`(agent/pump/watcher)是**所有会话共享的单例**;
- **pump 先到先得**: bridge_arm execute 里 `if (state.pump === null) createPump({consumer:{sessionId: 首arm者}})`
  ——宿主重启(10:04)后 orch1 先 arm(02:09:18.885Z),pump 的 consumer 身份永远=
  orch1;我 1ms 后 arm 只是 `state.pump.flush()`(**替 orch1 的 pump 干活**)+ 重绑
  state.agent=我;
- **回执撒谎**: 回执串的是 `state.canonical`(按本次 arm 的会话现算),与 pump 实际
  注册的 consumer 无关——"registered as orch@session-313e6f7f" 纯属转述,盘上从未发生;
- **僵尸泵跨 purge 存活**: orch1 会话被 purge(磁盘/registry slot/projcache 全删)后,
  插件 scope(standing)不受影响——zombie pump + watcher 仍在进程内,每次 flush 重新
  注册 orch1(armedAt 保首值),继续把我的定向行死信;若有发往 orch1 的行,wake 会
  注入 **state.agent=我** 的会话(身份错乱闭环);
- **无进程内恢复**: `state.pump !== null` 永假性 → 唯一清路是重启宿主;
- 次级: registry.json 读改写无锁(两 arm 相隔 1ms 后写覆盖前写);
  message-bridge 同构(state.agent 后 arm 者覆盖,但无 pump 复用问题,重 arm 可自愈)。

## 方案(建议)

1. **state 按 sessionId 键控**: `const state = new Map<sessionId, {...}>`;
   bridge_arm/bridge_http_status 以 `agents.requireInitiator().id` 取槽;
   wake 用对应槽的 agent。HTTP 服务单例保留(端口/去重全局),仅绑定分槽——
   请求带 to 时按签名路由到槽,无 to 时投给最近 arm 者(显式记录)。
2. **注册与回执对账**: execute 返回前回读 registry.json 断言自身条目在册,
   不在则回执报错(fail-loud),杜绝幻注册。
3. **卸册只随会话真终局**: dispose 改为幂等 + 仅在 agent/session 终局事件触发;
   若 harness 无此事件,退而求其次:unregister 前检查 registry armedAt 是否仍为
   本实例首次值(被后续 arm 覆盖则跳过卸册)。
4. **registry 写入加互斥**: 同进程内模块级 Promise 链串行化读改写;跨进程用
   O_EXCL lock 文件或接受 last-write-wins(单机单宿主场景)。

## 验收

- [ ] 两 maestro 会话同进程共存: 各自 arm 后 registry.json 同时含两条目,
      各自定向 ping 各自唤醒(四向交叉: A→A/B→B 通,A→B 不唤醒 A);
- [ ] bridge_arm/bridge_http_status 回执后 60s,条目仍在册(无异步卸册);
- [ ] HTTP 请求 to=签名A 只唤醒 A;to 缺省投最近 arm 者且回执写明投给了谁;
- [ ] pump.test.mjs / index.test.mjs 全绿 + 新增多会话用例(假 agents registry
      注入两个 initiator)。

## 关联

- 0002 E2E 的"对端协议执行"已验通过(冷 agent ack/done 语义/签名/ref 全对);
  本 ticket 是其"编排者收到"一环的拦路 bug。
- 运维缓解(已执行): 旧 orch1 已 purge(2026-08-16 11:36Z,registry/disk/projcache
  三步 ok,fleet 移除)。**但僵尸泵仍在进程内**——文件桥对我不可用直至宿主重启;
  HTTP 通道正常(state.agent 已被我的 bridge_http_status 重绑)。
- 修复+重启是唯一彻底解;重启前不要再让第二个 maestro 会话 arm。
