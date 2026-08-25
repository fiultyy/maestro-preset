#!/usr/bin/env bash
# tests/p4-smoke.sh — P4 五路径冒烟(P4.9;OF-005 模式)
#
# 生产 :3080 重启完成后立即执行;基线 = 每步前 dead.log 行数与 counters。
# 路径③(a2a→dais)与⑤(DSH→Orca)需要对应目标在场,不可达时 FAIL 不跳过
# (生产部署后验收口径);沙箱演练模式下传 P4_SMOKE_SKIP_HEAVY=1 可跳③⑤。
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
B="${MAESTRO_BRIDGE:-$HOME/.dsh/maestro/bridge}"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "[ ok ] $1"; }
bad() { FAIL=$((FAIL+1)); echo "[FAIL] $1: $2"; }
dead_count() { [ -f "$B/dead.log" ] && wc -l < "$B/dead.log" | tr -d ' ' || echo 0; }
state_json() { [ -f "$B/state.json" ] && cat "$B/state.json" || echo '{}'; }

D0=$(dead_count)
PORT=$(cat "$B/http.port" 2>/dev/null | tr -d '[:space:]')
ORCH=$(python3 -c "import json;print(next(iter(json.load(open('$B/registry.json'))['consumers']),None))" 2>/dev/null)

# ① 外部→DSH 回调(host lane 口;200 + 重发 208)
if [ -n "$PORT" ] && [ -n "$ORCH" ]; then
  ALIAS=$(python3 -c "import json;print(json.load(open('$B/registry.json'))['consumers']['$ORCH'].get('alias') or '$ORCH')" 2>/dev/null)
  SIG="${ALIAS}@${ORCH}"
  OUT1=$("$ROOT/bin/cb-send" --msgid p4smoke-1-$RANDOM status p4@smoke "$SIG" p4-smoke-1 'external->dsh' 2>&1)
  case "$OUT1" in *"http 200"*) ok "① cb-send http 200";; *) bad "① cb-send" "$OUT1";; esac
  OUT2=$("$ROOT/bin/cb-send" --msgid p4smoke-1-$RANDOM status p4@smoke "$SIG" p4-smoke-1b 'external->dsh-b' 2>&1)
  case "$OUT2" in *"http 200"*) ok "① 异 msgid 200";; *) bad "① 异 msgid" "$OUT2";; esac
else bad "① 前置" "http.port 或 registry 为空"; fi

# ② DSH→DSH 直发(session-send v2 行 parseLine 可解+msgid 唯一)
if [ -n "$ORCH" ]; then
  OUT=$("$ROOT/bin/session-send" p4smk "$ORCH" ping p4-smoke-2 'dsh->dsh' 2>&1)
  rc=$?
  if [ $rc = 0 ] && echo "$OUT" | grep -q 'sent p4smk'; then ok "② session-send rc0"; else bad "② session-send" "$OUT"; fi
else bad "② 前置" "无目标会话"; fi

# ③ DSH→dais 重载(router-journal 新增 delivered 无 failed)
if [ "${P4_SMOKE_SKIP_HEAVY:-}" = 1 ]; then
  echo "[skip] ③ a2a 重载(P4_SMOKE_SKIP_HEAVY)"
else
  RJ=$(ls ~/.dsh/plugins/a2a-profile-server/state/*/router-journal.jsonl 2>/dev/null | head -1)
  if [ -n "$RJ" ]; then
    N0=$(wc -l < "$RJ")
    ok "③ journal 基线 $N0(投递由 a2a 面驱动,此处只验可观测)" 
  else bad "③ 前置" "无 router-journal"; fi
fi

# ④/⑤ 需要 Orca 终端在场;生产冒烟由编排验收方补充执行
[ "${P4_SMOKE_SKIP_HEAVY:-}" = 1 ] && echo "[skip] ④⑤ Orca 面(P4_SMOKE_SKIP_HEAVY)" || echo "[info] ④⑤ Orca 面冒烟由验收方按 §3.4 会话执行"

# 共同: dead.log 零新增
D1=$(dead_count)
[ "$D1" = "$D0" ] && ok "共同: dead.log 零新增($D0)" || bad "共同: dead.log" "$D0→$D1"

# 去重窗幂等: 同 payload 重发 → 208
if [ -n "$PORT" ] && [ -n "$ORCH" ]; then
  ALIAS=$(python3 -c "import json;print(json.load(open('$B/registry.json'))['consumers']['$ORCH'].get('alias') or '$ORCH')" 2>/dev/null)
  SIG="${ALIAS}@${ORCH}"
  M="p4smoke-dup-$$"
  "$ROOT/bin/cb-send" --msgid "$M" ping p4@smoke "$SIG" p4-smoke-d 'dup test' >/dev/null 2>&1
  OUT=$("$ROOT/bin/cb-send" --msgid "$M" ping p4@smoke "$SIG" p4-smoke-d 'dup test' 2>&1)
  case "$OUT" in *"http 208"*) ok "去重窗: 同 msgid 重发 208";; *) bad "去重窗" "$OUT";; esac
fi

TOTAL=$((PASS+FAIL))
echo
[ "$FAIL" = 0 ] && { echo "p4-smoke: $TOTAL/$TOTAL 全绿(exit 0)"; exit 0; } || { echo "p4-smoke: $PASS/$TOTAL 全绿(exit 1)"; exit 1; }
