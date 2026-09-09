# 编排硬机制三 harness 接线清单 (2026-09-06)

机制: 派票信封 DSHMSG]{...} 于用户 prompt 进入时解析 → 回 ticket-received + 落 inflight;
回合终结 → 配对清 inflight + 回 ticket-done。无信封/无 inflight = 静默。fail-open。
信封生产端已接——dag-seat 注入，来路即目标（2026-09-09 HOOK-ENVELOPE #133：dag-task 落 task 文本首行构造信封，
inflight 第 5 列存 FROM，ticket-done 的 to 优先取之、空回落 ORCH_SIG；--orch-sig 回落链见 maestro-orch SKILL.md）。

| harness | 挂载点 | 配置/文件 | 钩点映射 |
|---|---|---|---|
| dsh | cordis.patch.yml insert `hooks-claude-code-orch` → `hooks/orch-hooks.json` | 同 wrapper (hooks-claude-code-wrap.mjs), 与 memsvc 钩(独立条目 memsvc)双钩共存 | UserPromptSubmit / TurnEnd |
| claude code | `~/.claude/settings.json` hooks.UserPromptSubmit + hooks.Stop 追加条目 (guard+env 内联, timeout 10) | 备份: settings.json.bak-orchhooks-20260906 | UPS 等价=UserPromptSubmit; TurnEnd 等价=**Stop** |
| omp (oh-my-pi) | `~/.omp/agent/extensions/orch-orchestrate.ts` (本目录同名文件=真源副本) | 扩展工厂 pi.on, spawn 同款脚本+CC-dialect stdin 垫片 | UPS 等价=**before_agent_start**(带原始 prompt); TurnEnd 等价=**turn_end** |

## ORCH_SIG 换席同步清单 (改一处必改四处)
1. `~/.dsh/maestro/orch-hooks.json` (dsh)
2. `~/.claude/settings.json` hooks.UserPromptSubmit[*]/hooks.Stop[*] 内联 env (cc)
3. `~/.omp/agent/extensions/orch-orchestrate.ts` ENV 常量 (omp)
4. 账本/orch-report 登记

## 验证锚 (2026-09-06 全绿)
- dsh: 单元4/4 + live p5 + E2E 双腿 + 并行串位零串位 (账本 #74/#76/#81)
- cc: claude -p 信封 e2e-cc1 received+done 配对+inflight 清态+桥送达
- omp: omp -p 信封 e2e-omp1 同上四实证
- 边界: 三平台均不解决 BRIDGE-WAKE (桥唤醒路径缺 requestId, #63 同族) — 独立票
