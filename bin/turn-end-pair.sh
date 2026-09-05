#!/usr/bin/env bash
# turn-end-pair.sh — 编排回合配对哨 (orch-hooks 组, 2026-09-05)
# TurnEnd 时查 inflight 配对态: 有 → 回 ticket-done(与 ticket-received 配对)并清态;
# 无 → 默认静默(ORCH_IDLE_ALL=1 则回 turn-idle 心跳)。Tolerates everything: exit 0。
# 2026-09-05 晚: emit 由 python heredoc 改 jq -n — 实测 TurnEnd hook 子进程被宿主
# 随回合终结快速回收, python 解释器启动(~50ms+)必输退出竞速(p1-p3/run1-4 全灭),
# jq 单二进制与存活 trace 同速级。ups 侧不在竞速窗口, 保留 python。
# env: ORCH_SIG ORCH_INBOX ORCH_INFLIGHT [ORCH_IDLE_ALL]
STDIN="$(cat 2>/dev/null || :)"
[ -n "$ORCH_INBOX" ] || ORCH_INBOX="$HOME/.dsh/maestro/bridge/inbox.log"
[ -n "$ORCH_INFLIGHT" ] || ORCH_INFLIGHT="$HOME/.dsh/maestro/orch-hooks/inflight"
[ -n "$ORCH_SIG" ] || ORCH_SIG="orch-p0"
command -v jq >/dev/null 2>&1 || exit 0

if [ -n "$ORCH_DEBUG" ]; then
  { echo "=== $(date +%T) $$ $0 t0=$(date +%s%3N)"; echo "env:"; env | grep -E "^ORCH_|^HOME=|^PATH=" | head -8;
    echo "stdin-head: $(printf '%s' "$STDIN" | head -c 200)"; } >> "$ORCH_DEBUG" 2>/dev/null || :
fi

SID="$(printf '%s' "$STDIN" | jq -r '.session_id // empty' 2>/dev/null || :)"
[ -n "$SID" ] || exit 0

INFILE="$ORCH_INFLIGHT/$SID"
if [ -s "$INFILE" ]; then
  REF="$(awk -F'\t' 'NR==1{print $1}' "$INFILE" 2>/dev/null)"
  OTYPE="$(awk -F'\t' 'NR==1{print $4}' "$INFILE" 2>/dev/null)"
  [ -n "$REF" ] || REF="dispatch"
  [ -n "$ORCH_DEBUG" ] && echo "branch: PAIRED ref=$REF rm=$INFILE pre-size=$(wc -c <"$INFILE" 2>/dev/null) t1=$(date +%s%3N)" >> "$ORCH_DEBUG" 2>/dev/null || :
  rm -f "$INFILE" 2>/dev/null || :
  jq -cn --arg sig "$ORCH_SIG" --arg from "$SID" \
        --arg ref "$REF" --arg otype "$OTYPE" \
        --arg ts "$(date +%s000)" '
        {"type":"ticket-done","from":$from,"to":$sig,
         "body":("[ref:" + $ref + "] worker turn done (paired; ticket type=" + $otype + ")"),
         "ref":$ref,"msgid":(now*1000|floor|tostring),"ts":($ts|tonumber),"ver":3}' \
    >> "$ORCH_INBOX" 2>"${ORCH_DEBUG:-/dev/null}" || :
  [ -n "$ORCH_DEBUG" ] && echo "emit-done appended to=$ORCH_INBOX t2=$(date +%s%3N)" >> "$ORCH_DEBUG" 2>/dev/null || :
else
  [ -n "$ORCH_DEBUG" ] && echo "branch: NO-INFLIGHT idle=$ORCH_IDLE_ALL t1=$(date +%s%3N)" >> "$ORCH_DEBUG" 2>/dev/null || :
  if [ "$ORCH_IDLE_ALL" = "1" ]; then
    jq -cn --arg sig "$ORCH_SIG" --arg inbox "$ORCH_INBOX" --arg from "$SID" \
          --arg ts "$(date +%s000)" '
          {"type":"turn-idle","from":$from,"to":$sig,
           "body":"[ref:-] turn end, no inflight ticket (idle)","ref":"-",
           "msgid":(now*1000|floor|tostring),"ts":($ts|tonumber),"ver":3}' \
      >> "$ORCH_INBOX" 2>"${ORCH_DEBUG:-/dev/null}" || :
    [ -n "$ORCH_DEBUG" ] && echo "emit-idle appended to=$ORCH_INBOX t2=$(date +%s%3N)" >> "$ORCH_DEBUG" 2>/dev/null || :
  fi
fi
exit 0
