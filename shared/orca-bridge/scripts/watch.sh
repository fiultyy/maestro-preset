#!/usr/bin/env bash
# orca-bridge watch — 阻塞等待下一条 Orca→DSH 回调，打印后退出。
# 设计为"一次性"后台 job：job 结算通知即回调信号，驱动 session 新回合。
# 回声过滤: 桥 pane 是 cat >> inbox.log，DSH 侧 reply 写回的 DSH-RE] 行会回流，
#           故 DSH-RE] 前缀为保留字——跳过(推进游标)并继续等待真正的 Orca 回调。
# 光标存 .cursor（行号），多 watcher 顺序消费；轮询 1s（脚本内部阻塞，非 agent 轮询）。
set -euo pipefail
B="${MAESTRO_BRIDGE:-$HOME/.dsh/maestro/bridge}"
INBOX="$B/inbox.log"; CUR="$B/.cursor"
mkdir -p "$B"; touch "$INBOX"
base=0
[ -f "$CUR" ] && base=$(cat "$CUR")
while true; do
  n=$(wc -l < "$INBOX")
  if [ "$n" -gt "$base" ]; then
    line=$(sed -n "$((base+1))p" "$INBOX")
    base=$((base+1)); echo "$base" > "$CUR"
    case "$line" in
      DSH-RE]*) continue ;;   # 自己的回答回声，吞掉继续等
    esac
    printf 'ORCA-CB] %s\n' "$line"
    exit 0
  fi
  sleep "${MAESTRO_CB_POLL:-1}"
done
