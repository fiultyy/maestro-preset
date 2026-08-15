#!/usr/bin/env bash
# orca-bridge reply — 从 DSH 侧回复 Orca 桥终端。
# 用法: reply.sh "<回复文本>"   （文本会以 DSH-RE] 前缀出现在桥 pane）
set -euo pipefail
[ "${1:-}" = "" ] && { grep '^#' "$0" >&2; exit 2; }
B="${MAESTRO_BRIDGE:-$HOME/.dsh/maestro/bridge}"
[ -f "$B/handle" ] || { echo "no bridge handle at $B/handle" >&2; exit 2; }
ORCA="${ORCA_CLI_COMMAND:-orca-ide}"
exec "$ORCA" terminal send --terminal "$(cat "$B/handle")" \
  --text "DSH-RE] $1" --enter --json
