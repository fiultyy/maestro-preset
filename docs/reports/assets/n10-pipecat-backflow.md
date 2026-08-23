# N10 pipecat-poc 回流备料（parent commit 用）

> 生成：9a8b · 2026-08-24 · 基线：pipecat-poc examples/realtime-provider-poc @ f25592a 同源副本（diff=SAME 起步）

## 回流清单（三件）

| # | 源（maestro-preset master） | 目标 | patch |
|---|---|---|---|
| 1 | projector/rt_projector.py | ~/workspace-claw-02/pipecat-poc/examples/realtime-provider-poc/rt_projector.py | backflow-rt_projector.diff |
| 2 | projector/wizard.py | ~/.agents/skills/incubation-wizard/wizard.py | backflow-wizard.diff |
| 3 | projector/SKILL.md | ~/.agents/skills/incubation-wizard/SKILL.md | backflow-skill.diff |

## 应用法（parent 执行）

```bash
# pipecat-poc 仓（parent 域，9a8b 不动）
cd ~/workspace-claw-02/pipecat-poc
patch -p0 examples/realtime-provider-poc/rt_projector.py < <(sed 's|^--- .*|--- examples/realtime-provider-poc/rt_projector.py.orig|; s|^+++ .*|+++ examples/realtime-provider-poc/rt_projector.py|' /home/yy/tools/maestro-preset/docs/reports/assets/n10-backflow-rt_projector.diff)
# 或直接拷贝（基线同源，直接 cp 等价）：
cp /home/yy/tools/maestro-preset/projector/rt_projector.py examples/realtime-provider-poc/rt_projector.py
git add -A && git commit -m "feat(n10): queen role + grill 18 dims + wizard --derive (backflow from maestro-preset N10-T2)"

# 向导安装点（非 git 仓，直接拷）
cp /home/yy/tools/maestro-preset/projector/{wizard.py,SKILL.md} ~/.agents/skills/incubation-wizard/
```

## 验收（回流后）

```bash
cd ~/workspace-claw-02/pipecat-poc/examples/realtime-provider-poc
python3 -c "from rt_projector import ROLE_TEMPLATES, GRILL_DIMENSIONS, grill_checklist; assert 'queen' in ROLE_TEMPLATES and len(GRILL_DIMENSIONS)==18; print('backflow ok:', len(grill_checklist('写代码的agent')))"
```
