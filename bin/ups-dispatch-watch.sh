#!/usr/bin/env bash
# ups-dispatch-watch.sh — 编排派票接收哨 (orch-hooks 组, 2026-09-05)
# 解析 prompt 首行 DSHMSG 信封 → 回 ticket-received 至编排桥 + 落 inflight 配对态。
# 2026-09-06 增: Orca dispatch --inject preamble 分支 — 识别 "You are a dispatched worker."
# → 提 task_id 发 ticket-running 至 ORCH_RUNNING sidecar(不走桥,免唤醒编排席),零契约零 worker 动作;
#   done 不在此发(原生 worker_done 负责,防双报),不落 inflight。
# 无信封非派票(人打字/普通 prompt)=静默。Tolerates everything: 任何缺失/失败 exit 0
# (设计同 memsvc hooks 家族; fail-open, 不阻回合)。
# 2026-09-09 增(HOOK-ENVELOPE B′): inflight 第 5 列存信封 FROM(来路即目标);
#   turn-end-pair.sh 的 ticket-done to 优先取之,空回落 ORCH_SIG(兼容存量 4 列)。
# env: ORCH_SIG(编排者签名) ORCH_INBOX(桥收件箱) ORCH_INFLIGHT(配对态目录) ORCH_RUNNING(running sidecar)
STDIN="$(cat 2>/dev/null || :)"
[ -n "$ORCH_INBOX" ] || ORCH_INBOX="$HOME/.dsh/maestro/bridge/inbox.log"
[ -n "$ORCH_INFLIGHT" ] || ORCH_INFLIGHT="$HOME/.dsh/maestro/orch-hooks/inflight"
[ -n "$ORCH_RUNNING" ] || ORCH_RUNNING="$HOME/.dsh/maestro/orch-hooks/running.log"
[ -n "$ORCH_SIG" ] || ORCH_SIG="orch-p0"
command -v jq >/dev/null 2>&1 || exit 0
command -v python3 >/dev/null 2>&1 || exit 0

if [ -n "$ORCH_DEBUG" ]; then
  { echo "=== $(date +%T) $$ $0"; echo "env:"; env | grep -E "^ORCH_|^HOME=|^PATH=" | head -8;
    echo "stdin-head: $(printf '%s' "$STDIN" | head -c 200)"; } >> "$ORCH_DEBUG" 2>/dev/null || :
fi

SID="$(printf '%s' "$STDIN" | jq -r '.session_id // empty' 2>/dev/null || :)"
PROMPT="$(printf '%s' "$STDIN" | jq -r '.prompt // empty' 2>/dev/null || :)"
[ -n "$SID" ] && [ -n "$PROMPT" ] || exit 0

FIRST="$(printf '%s\n' "$PROMPT" | awk 'NR==1')"
case "$FIRST" in
  'DSHMSG]'*) : ;;
  *)
    # Orca dispatch --inject preamble 分支(running 信号,零契约)
    if printf '%s\n' "$PROMPT" | head -20 | grep -q "You are a dispatched worker\." 2>/dev/null; then
      TASKID="$(printf '%s\n' "$PROMPT" | grep -m1 -o 'Your task ID is: *task_[0-9a-f]*' | grep -o 'task_[0-9a-f]*' | head -1)"
      [ -n "$TASKID" ] || exit 0
      [ -n "$ORCH_DEBUG" ] && echo "branch: DISPATCH-PREAMBLE task=$TASKID sid=$SID" >> "$ORCH_DEBUG" 2>/dev/null || :
      ORCH_SIG="$ORCH_SIG" ORCH_RUNNING="$ORCH_RUNNING" TASKID="$TASKID" SID="$SID" \
      NEWMSGID="$(python3 -c 'import uuid;print(uuid.uuid4())')" \
      TS="$(date +%s000)" python3 - <<'PYRUN' 2>/dev/null || :
import json, os
ev = {"type": "ticket-running", "from": os.environ["SID"], "to": os.environ["ORCH_SIG"],
      "body": f"[task:{os.environ['TASKID']}] worker turn started (dispatch-injected) session={os.environ['SID']}",
      "ref": os.environ["TASKID"], "msgid": os.environ["NEWMSGID"], "ts": int(os.environ["TS"]), "ver": 3}
with open(os.environ["ORCH_RUNNING"], "a", encoding="utf-8") as fh:
    fh.write(json.dumps(ev, ensure_ascii=False) + "\n")
PYRUN
      exit 0
    fi
    exit 0 ;;
esac

ENV_JSON="${FIRST#DSHMSG]}"
FROM="$(printf '%s' "$ENV_JSON" | jq -r '.from // empty' 2>/dev/null || :)"
REF="$(printf '%s' "$ENV_JSON" | jq -r '.ref // empty' 2>/dev/null || :)"
OMSGID="$(printf '%s' "$ENV_JSON" | jq -r '.msgid // empty' 2>/dev/null || :)"
OTYPE="$(printf '%s' "$ENV_JSON" | jq -r '.type // empty' 2>/dev/null || :)"
[ -n "$FROM" ] || exit 0
case "$REF" in ''|'-') REF="dispatch" ;; esac
[ -n "$ORCH_DEBUG" ] && echo "branch: ENVELOPE from=$FROM ref=$REF sid=$SID" >> "$ORCH_DEBUG" 2>/dev/null || :

mkdir -p "$ORCH_INFLIGHT" 2>/dev/null || :
printf '%s\t%s\t%s\t%s\t%s\n' "$REF" "$OMSGID" "$(date +%s)" "$OTYPE" "$FROM" > "$ORCH_INFLIGHT/$SID" 2>/dev/null || :

ORCH_SIG="$ORCH_SIG" ORCH_INBOX="$ORCH_INBOX" FROM="$FROM" REF="$REF" \
OTYPE="$OTYPE" SID="$SID" NEWMSGID="$(python3 -c 'import uuid;print(uuid.uuid4())')" \
TS="$(date +%s000)" python3 - <<'PYEOF' 2>/dev/null || :
import json, os
ev = {"type": "ticket-received", "from": os.environ["FROM"], "to": os.environ["ORCH_SIG"],
      "body": f"[ref:{os.environ['REF']}] ticket received ({os.environ['OTYPE']}) session={os.environ['SID']}",
      "ref": os.environ["REF"], "msgid": os.environ["NEWMSGID"], "ts": int(os.environ["TS"]), "ver": 3}
with open(os.environ["ORCH_INBOX"], "a", encoding="utf-8") as fh:
    fh.write(json.dumps(ev, ensure_ascii=False) + "\n")
PYEOF
exit 0
