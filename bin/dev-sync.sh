#!/usr/bin/env bash
# dev-sync — 把本仓库内容同步到已安装 preset 目录(开发循环最后一步)
#
# ⚠️ 为什么不用软链接: DSH 的 preset discovery 用 readdir(withFileTypes) 的
#    isDirectory() 过滤(harness packages/preset/agent-presets/src/discovery.ts
#    scanRoot),符号链接 isDirectory()==false → 整个 preset 从 roster 消失,
#    新会话解析失败(表现为"新建对话无响应")。禁止 ln -s 安装点。
#
# 用法: 本仓库任意位置执行 bin/dev-sync.sh
#   bin/dev-sync.sh               # 正向: 仓库 → 安装点(rsync --delete, 仓库为准)
#   bin/dev-sync.sh --reverse     # 回流: 安装点 → 仓库, 只生成 patch 不直接覆盖
#                                 #       (§10.2 护栏一: 禁手工 cp 覆盖回仓库)
#   bin/dev-sync.sh --verify      # 双向 diff 报告(不同文件清单, 不改动任何文件)
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
DST="${DSH_HOME:-$HOME/.dsh}/.agent-presets/maestro"

# 排除集: .git / 运行时产物 / 镜像副本互不相干
EXCLUDES=(--exclude .git --exclude __pycache__)

# 镜像兜底(maestro-bridge 技能的 [ -x 装点 ] || 镜像 回退路径, 0006 收编)
MIRROR="${DSH_HOME:-$HOME/.dsh}/maestro/bin"

case "${1:-}" in
--verify)
  echo "== repo -> install (装点落后项):"
  diff -rq "${EXCLUDES[@]}" "$SRC" "$DST" | sed "s|$DST|<install>|g; s|$SRC|<repo>|g" || true
  echo "== install -> repo (仓落后项, 应逐个回流):"
  diff -rq "${EXCLUDES[@]}" "$DST" "$SRC" | sed "s|$DST|<install>|g; s|$SRC|<repo>|g" || true
  echo "== mirror drift (镜像漂移项, 下次正向同步自动齐平):"
  diff -rq --exclude __pycache__ "$SRC/bin" "$MIRROR" 2>/dev/null | sed "s|$MIRROR|<mirror>|g; s|$SRC|<repo>|g" || true
  echo "== 三段清零 = 完全同步"
  exit 0
  ;;
--reverse)
  # 生成"装点→仓库"patch 到 stdout; 调用方: git apply -p1 + 当场 commit(禁攒包)。
  # 输出为统一 diff, 路径映射 a/=安装点 b/=仓库; git apply 忽略 diff 头行、
  # 容忍 ---/+++ 行尾时间戳。空输出 = 无回流项。
  # ⚠️ 必须带文件参数逐文件回流: 全量 patch 会把"仓新于装点、尚未正向同步"的
  #    改动一并反向回滚(混合双向漂移时必炸)。例:
  #    bin/dev-sync.sh --reverse bin/session-send > /tmp/p && git apply -p1 /tmp/p
  shift; [ $# -gt 0 ] || { echo "dev-sync --reverse: 需要至少一个相对路径参数(逐文件回流)" >&2; exit 2; }
  cd "$SRC"
  for f in "$@"; do
    # 方向: 仓(a/=现状) → 装点(b/=目标); 应用后仓获得装点该文件的状态
    diff -uN "$SRC/$f" "$DST/$f" 2>/dev/null \
      | sed "s|$SRC/|a/|g; s|$DST/|b/|g" || true
  done
  exit 0
  ;;
esac

mkdir -p "$DST"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete --exclude '.git' "$SRC"/ "$DST"/
else
  rm -rf "$DST"
  cp -a "$SRC" "$DST"
  rm -rf "$DST/.git"
fi
echo "synced: $SRC -> $DST"

# 镜像兜底(0006): 仓/bin → ~/.dsh/maestro/bin, 冷执行对端的稳定回退路径。
# 只镜像 bin/(镜像角色=脚本兜底, skills/docs 有各自发现面); 排 __pycache__。
mkdir -p "$MIRROR"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete --exclude __pycache__ "$SRC/bin"/ "$MIRROR"/
else
  rm -rf "$MIRROR"; cp -a "$SRC/bin" "$MIRROR"; rm -rf "$MIRROR/__pycache__"
fi
echo "mirror synced: $SRC/bin -> $MIRROR"

# shared/ → ~/.agents/skills: 对端 harness(Orca/zap 里的 agent)的 skill 发现面。
# 仓库是唯一源头;~/.agents/skills 与 ~/.claude/skills 的副本/软链均由这里派生。
SHARED="${MAESTRO_SHARED_SKILLS:-$HOME/.agents/skills}"
if [ -d "$SRC/shared" ]; then
  mkdir -p "$SHARED"
  for d in "$SRC"/shared/*/; do
    [ -d "$d" ] || continue
    name="$(basename "$d")"
    rm -rf "$SHARED/$name"
    cp -a "$d" "$SHARED/$name"
    # claude 发现面: 沿用 orca-cli/orcard 先例(软链 → ~/.agents/skills)
    if [ -d "$HOME/.claude/skills" ] && { [ ! -e "$HOME/.claude/skills/$name" ] || [ -L "$HOME/.claude/skills/$name" ]; }; then
      ln -sfn "$SHARED/$name" "$HOME/.claude/skills/$name"
    fi
    echo "shared skill: $SHARED/$name"
  done
fi
echo "reminder: 改 agent.cordis.yml → 新会话自动新代际; 只改 plugins/*.js → 重启 DSH 才确定性生效"
