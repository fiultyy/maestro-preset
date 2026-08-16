# 0005 — cb-send HTTP 兜底吸收显式定向消息:仅在文件桥注册的消费者收不到回调

> 状态: DRAFT(待审) · 发现于 0004 后自迭代现场(selfiter-1, 2026-08-16 14:39Z)

## 现场实录

- 同进程双编排者共存(0003 修复生效): 我 `orch@session-313e6f7f` + 对方 `orch1@session-1737c79e`,
  registry.json v3.6 双条目并存;
- 对方只调了 `bridge_arm`(文件桥注册),没调 `bridge_http_status`(无 HTTP 槽);
- 其 worker `5d2e` 按契约用 `cb-send ack` 回调 → HTTP 优先 → v1.2 路由:
  `to=orch1@session-1737c79e` 无 HTTP 槽匹配 → **兜底"最近 armer"= 我** → HTTP 200
  delivered → cb-send 认为送达,**永不降级文件桥**(文件桥本可按 registry 正确路由);
- 结果: 对方编排者的 ACK/DONE 全部错投给我,它的握手监督降级为机械校验。

## 根因(两处叠加)

1. **message-bridge v1.2**: `pickRecipient` 对显式 `to` 无匹配时回退 last-armer——
   该兜底本意服务"to 缺省",但把"显式定向失败"也一并吸收了;
2. **cb-send**: HTTP 200/208 即成功,不感知"兜底吸收"与"定向命中"的区别。

## 方案

1. **message-bridge v1.3 路由收紧**: `to` 显式且非空 → 必须精确命中 HTTP 槽,否则
   `404 {error: "no armed HTTP slot for to=<sig>"}`;仅 `to` 缺省/空才走 last-armer
   兜底。v1.2 的测试相应改(错投用例从"兜底"改为"404")。
2. **cb-send 降级链补全**: HTTP 非 200/208(含 404)→ 落文件桥(现状已有,本票使其
   真正可达);文件桥按 registry 路由,仅在文件桥也注册的目标上闭环。
3. **文档**: USAGE §5/共享 skill 补一句——编排者开场必须**双通道**武装(persona 已写,
   本票把"漏武装"的后果从静默错投变成显式拒收,可观测)。

## 验收

- [ ] 双编排者场景(一 HTTP+文件桥,一仅文件桥): worker cb-send ack → 仅文件桥编排者
      **经文件桥收到**(HTTP 404 → cb-send 降级 → registry 路由命中);
- [ ] to 缺省仍兜底最近 armer(单会话便利性保留);
- [ ] 死签名(to 指向不存在会话)→ HTTP 404 + 文件桥 dead.log(不再吸收);
- [ ] 测试: message-bridge 路由用例更新 + cb-send 降级路径单测;全量回归绿。

## 关联

- 0003 的多会话共存使双编排常态化,本票是共存的"最后一公里"路由正确性;
- 现场止血已做: steer 对方补调 bridge_http_status(session-send 2026-08-16 14:40Z,
  accepted);
- 第七/八坑(USAGE §3.3 / callback-bridge-design §9, 2026-08-16 换代现场)与本票同根
  互证: 本票是它们的**插件级修复载体**(ADDR-R1 落地即消除 HTTP 200 假阳性), 按
  §10.2 plugins 强制 git 分支路径实施。

## 规模预估

message-bridge pickRecipient+handle 改动 ~15 行 + 测试改 2 例 + cb-send 无需改
(404 已在降级分支)+ 文档 3 行。半小时级。
