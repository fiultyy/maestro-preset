# 0006 — `~/.dsh/maestro/bin` 第三副本无管线维护, 漂移靠手 cp

> 状态: 实施(现场即修) · 发现于 gen2b 装点同步现场(2026-08-16 深夜)

## 现场实录

- `maestro-bridge` 技能的兜底安装点: `CB=~/.dsh/.agent-presets/maestro/bin/cb-send;
  [ -x "$CB" ] || CB=~/.dsh/maestro/bin/cb-send` —— 镜像目录是冷执行对端
  (无 preset 会话/外部进程)的稳定回退路径;
- 但 dev-sync 只管 **仓→装点** 一条线, 镜像是无人维护的第三副本:
  - session-send 修复当次靠**手工 cp 两个目标**(装点+镜像);
  - 装点同步后五脚本比对, 又抓到镜像 dev-sync.sh 漂移, 再手 cp 一次。
- 两次手工 = 两次可漏。任何一次忘了镜像, 兜底路径就回放旧 bug(且兜底
  恰在"装点缺席"场景被踩到, 最难排查)。

## 方案(grill 后)

**收编进 dev-sync**: 主同步步之后增一步 `rsync -a --delete 仓/bin/ → 镜像/`
(排 `__pycache__`); `--verify` 增镜像比对段。

取舍质询:

- **为何不删镜像只留装点?** 兜底的存在意义是"装点缺席也能回调"——preset
  未装/换代/发现根变动时, `~/.dsh/maestro` 是编排域稳定根(fleet.json/ledger.db
  同级)。删兜底 = 把回退路径绑死在装点存活上, 违背兜底初衷;
- **为何不软链镜像→装点?** 同上, 兜底依赖装点存活即失去意义; 且目录级软链
  已被 §10 禁(readdir isDirectory 坑);
- **为何不整仓同步到镜像?** 镜像角色只是 bin 兜底, skills/docs 有各自发现面
  (技能目录/仓库), 扩大镜像面=扩大漂移面。

## 验收

- [x] dev-sync 后三副本齐平: 仓 bin/ = 装点 bin/ = 镜像(逐文件 diff 清零);
- [x] `--verify` 三段报告: 装点落后项 / 仓落后项 / 镜像漂移项;
- [x] maestro-bridge 技能文本零改动(兜底路径语义不变);
- [x] 现场即修: 本票与修复同 commit 序落 feat/field-pitfalls。

## 关联

- §10.2 路径2(bin 先 .dsh 后 sync)的补全: 镜像是路径2的第二个落点;
- 同族: 0005(桥路由)、七/八坑(USAGE §3.3)—— 都是"多副本/多通道语义分裂"族。
