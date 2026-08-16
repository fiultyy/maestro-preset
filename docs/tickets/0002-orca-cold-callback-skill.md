# 0002 — Orca agent 冷执行回调 skill(maestro-bridge 注册化)

> 状态: DRAFT(待审) · 前置: 0e61973 派发握手已合入并 E2E 验证

## 问题

握手协议靠派发消息内嵌自包含契约,冷 agent 照抄即可——但**没有任何可发现的 skill**
支撑以下场景:

1. **契约丢失**: 派发被转述/截断/人工口头转达,对端无从查阅协议;
2. **主动回调**: agent 想发 ask/report(未收到嵌契约的派发)无参照;
3. **身份自定位**: `<你的ID>` 需要冷启动自查(orcard 可查 terminal handle,未接线);
4. **不可见**: `~/.agents/skills/maestro-bridge/SKILL.md` 无 frontmatter,skills 约定
   不索引(实测: 本机各 harness catalog 均列出同目录其他 skill,唯独没有它);
   `~/.claude/skills/` 也没有;仓库不追踪该文件(无源头,push 后别机不可复现)。

## 目标

冷启动(零上下文)的 Orca 终端 agent: 收到嵌契约派发 → 照抄执行(现状保留);
契约丢失/主动回调 → **通过 skill 发现协议并正确执行**。

## 方案

1. **源头入库**: preset 仓库新增 `shared/maestro-bridge/`(SKILL.md + frontmatter
   name/description,触发词: cb-send / ack / done / 回调编排 / maestro 回调),
   `bin/dev-sync.sh` 增加镜像步骤 → `~/.agents/skills/maestro-bridge`。
   仓库成为唯一源头,安装点/仓外副本由 sync 派生。
2. **内容升级为冷执行手册**(与 0e61973 契约模板一字对齐):
   - 第一步自查身份: 有 orcard 则查 terminal handle,否则 env/提示词里找;
   - `cb-send` 优先 → `printf >> inbox.log` 兜底(cb-send 不可用时);
   - ack/done/ask/report/ping 语义 + `[ref:]` 前缀纪律 + ≤300 字摘要;
   - 红线: 不以 `DSH-RE]` 开头 / 单行 ≤4KB / to 用编排者签名别用 `*`;
   - 桥重建指引(Orca 重启后 handle 失效)。
3. **claude 发现面**: `~/.claude/skills/maestro-bridge` → 软链或拷贝到
   `~/.agents/skills/maestro-bridge`(先例: `~/.agents/skills/qa-test` 本身就是
   指向 `.claude/skills` 的软链,双向软链在本机已验证可用)。
4. **派发模板加兜底行**(改 `skills/orca-bridge/SKILL.md` 契约模板):
   末尾加一句「契约不完整时: load skill `maestro-bridge`」。

## 验收

- [ ] skills catalog(至少一个 harness)列出 maestro-bridge;frontmatter 合规;
- [ ] 冷 claude agent 在 Orca 终端,仅给「load skill maestro-bridge,向编排者回
      ack 再 done」→ 编排者会话收到 MSGBR]/ORCA-CB] 两回合;
- [ ] 仓库内为源头,`dev-sync.sh` 后安装点与仓外副本一致;
- [ ] 现有 message-bridge 单测 8/8 保持绿(本 ticket 不动插件)。

## 边界与不做

- 不动 DSH 侧插件/泵/收向(已验证);
- 不追 Orca 自带 bundle(`orca skills` 只装 Orca 官方,不可注入);
- 不给 zap 侧单独建 skill(zap agent 同样读 `~/.agents/skills`,一份覆盖)。

## 规模预估

SKILL.md 重写 + frontmatter(~80 行) / dev-sync.sh +3 行 / 模板 +1 行 / 部署验证。
半小时级。
