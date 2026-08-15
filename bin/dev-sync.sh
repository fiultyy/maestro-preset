#!/usr/bin/env bash
# dev-sync — 把本仓库内容同步到已安装 preset 目录(开发循环最后一步)
#
# ⚠️ 为什么不用软链接: DSH 的 preset discovery 用 readdir(withFileTypes) 的
#    isDirectory() 过滤(harness packages/preset/agent-presets/src/discovery.ts
#    scanRoot),符号链接 isDirectory()==false → 整个 preset 从 roster 消失,
#    新会话解析失败(表现为"新建对话无响应")。禁止 ln -s 安装点。
#
# 用法: 本仓库任意位置执行 bin/dev-sync.sh
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
DST="${DSH_HOME:-$HOME/.dsh}/.agent-presets/maestro"
mkdir -p "$DST"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete --exclude '.git' "$SRC"/ "$DST"/
else
  rm -rf "$DST"
  cp -a "$SRC" "$DST"
  rm -rf "$DST/.git"
fi
echo "synced: $SRC -> $DST"
echo "reminder: 改 agent.cordis.yml → 新会话自动新代际; 只改 plugins/*.js → 重启 DSH 才确定性生效"
