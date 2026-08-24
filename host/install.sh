#!/usr/bin/env bash
# host/install.sh — 装点自研插件分发安装器
#
# 四个安装面(PACKAGING.md §11):
#   1. host/packages/dsh-*        → ${DSH_HOME}/profiles/<profile>/node_modules/@deepseek-ai/
#   2. host/plugins/*             → ${DSH_HOME}/plugins/          (polyfill.patch.yml 引用)
#   3. ../plugins/{host-callback-bridge,a2a-profile-server} → ${DSH_HOME}/plugins/
#      (同一份源码在 maestro preset 内也挂 agent 面,此处装 host 面副本)
#   4. ../agent-presets/<id>      → ${DSH_HOME}/.agent-presets/<id>/
#
# 不自动改写的东西(人工步骤,见 host/README.md):
#   - run-web.sh 的 --patch 指向 polyfill.patch.yml
#   - web profile cordis.patch.yml 的 long-task 两行 insert
#   - lark/zhipu 凭据环境变量
#
# 用法: host/install.sh [--dry-run] [--profile web]
set -euo pipefail
DRY=0; PROFILE=web
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --profile) : ;; # 值在下一轮取
    *) [[ "${PREV:-}" == --profile ]] && PROFILE="$a" || { echo "unknown arg: $a" >&2; exit 2; } ;;
  esac
  PREV="$a"
done
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DSH="${DSH_HOME:-$HOME/.dsh}"

run() { if [ "$DRY" = 1 ]; then echo "dry: $*"; else "$@"; fi; }
install_dir() { # src dst
  run mkdir -p "$2"
  run cp -a "$1/." "$2/"
}

echo "== 1. host npm 包 → ${DSH}/profiles/${PROFILE}/node_modules/@deepseek-ai/"
NM="${DSH}/profiles/${PROFILE}/node_modules/@deepseek-ai"
for pkg in host/packages/*/; do
  name="$(python3 -c "import json;print(json.load(open('$pkg/package.json'))['name'])")"
  echo "   ${name}"
  install_dir "$ROOT/$pkg" "${NM}/$(basename "$pkg")"
done

echo "== 2. host polyfill 插件 → ${DSH}/plugins/"
for item in host/plugins/*/ host/plugins/*.js; do
  [ -e "$item" ] || continue
  run mkdir -p "${DSH}/plugins"
  run cp -a "$ROOT/$item" "${DSH}/plugins/"
  echo "   $(basename "$item")"
done

echo "== 3. maestro 插件的 host 面副本 → ${DSH}/plugins/"
for p in host-callback-bridge a2a-profile-server; do
  install_dir "$ROOT/plugins/$p" "${DSH}/plugins/$p"
  echo "   $p"
done

echo "== 4. agent presets → ${DSH}/.agent-presets/"
for d in "$ROOT"/agent-presets/*/; do
  id="$(basename "$d")"
  install_dir "$d" "${DSH}/.agent-presets/$id"
  echo "   $id"
done

echo "== 完成。剩余人工步骤(凭据/组合行): host/README.md"
