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
#   bin/dev-sync.sh --verify      # 双向 diff 报告(不同文件清单, 不改动任何文件;
#                                 #   段: 装点正向/装点回流/镜像/polyfill lane[host-cb+nw+a2a+persona-axis])
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
DST="${DSH_HOME:-$HOME/.dsh}/.agent-presets/maestro"

# 排除集: .git / 运行时产物 / 镜像副本互不相干;host/ 与 agent-presets/ 是分发面
# (装点在 ~/.dsh/plugins、profile node_modules、~/.dsh/.agent-presets/<id>,走
# host/install.sh),不随 maestro preset 本体同步。
EXCLUDES=(--exclude .git --exclude __pycache__ --exclude host --exclude agent-presets --exclude .pytest_cache --exclude githooks)

# 镜像兜底(maestro-bridge 技能的 [ -x 装点 ] || 镜像 回退路径, 0006 收编)
MIRROR="${DSH_HOME:-$HOME/.dsh}/maestro/bin"

case "${1:-}" in
--verify)
  echo "== repo -> install (装点落后项):"
  diff -rq "${EXCLUDES[@]}" "$SRC" "$DST" | sed "s|$DST|<install>|g; s|$SRC|<repo>|g" || true
  echo "== install -> repo (仓落后项, 应逐个回流):"
  diff -rq "${EXCLUDES[@]}" "$DST" "$SRC" | sed "s|$DST|<install>|g; s|$SRC|<repo>|g" || true
  echo "== mirror drift (镜像漂移项, 下次正向同步自动齐平):"
  diff -rq --exclude __pycache__ --exclude githooks "$SRC/bin" "$MIRROR" 2>/dev/null | sed "s|$MIRROR|<mirror>|g; s|$SRC|<repo>|g" || true
  echo "== polyfill lane drift (P4.4: host-callback-bridge + _narrow-waist → ~/.dsh/plugins):"
  PL="${DSH_HOME:-$HOME/.dsh}/plugins"
  diff -rq --exclude __pycache__ "$SRC/plugins/host-callback-bridge" "$PL/host-callback-bridge" 2>/dev/null | sed "s|$PL|<polyfill>|g; s|$SRC|<repo>|g" || true
  diff -rq --exclude __pycache__ "$SRC/plugins/_narrow-waist" "$PL/_narrow-waist" 2>/dev/null | sed "s|$PL|<polyfill>|g; s|$SRC|<repo>|g" || true
  diff -rq --exclude __pycache__ --exclude .git --exclude state "$SRC/plugins/a2a-profile-server" "$PL/a2a-profile-server" 2>/dev/null | sed "s|$PL|<polyfill>|g; s|$SRC|<repo>|g" || true
  diff -rq --exclude __pycache__ --exclude .git --exclude state "$SRC/plugins/persona-axis" "$PL/persona-axis" 2>/dev/null | sed "s|$PL|<polyfill>|g; s|$SRC|<repo>|g" || true
  echo "== 五段清零 = 完全同步"
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
  rsync -a --delete --exclude '.git' --exclude .pytest_cache "$SRC"/ "$DST"/
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

# polyfill lane(0007/SI-003): 仓 plugins/host-callback-bridge → ~/.dsh/plugins/ 自包含副本。
# 宿主 boot 经 run-web.sh --patch ~/.dsh/plugins/polyfill.patch.yml 装载该 lane;仓是
# 唯一源头,部署面禁止手改。polyfill.patch.yml 的 insert 行由 --polyfill-register 一次性写入。
POLYFILL_DIR="${DSH_HOME:-$HOME/.dsh}/plugins/host-callback-bridge"
if [ -d "$SRC/plugins/host-callback-bridge" ]; then
  mkdir -p "$(dirname "$POLYFILL_DIR")"
  rm -rf "$POLYFILL_DIR"
  cp -a "$SRC/plugins/host-callback-bridge" "$POLYFILL_DIR"
  rm -rf "$POLYFILL_DIR/__pycache__"
  echo "polyfill synced: $SRC/plugins/host-callback-bridge -> $POLYFILL_DIR"
fi
# P4.4(R-B13): _narrow-waist 同步——host-callback-bridge 的 import
# '../_narrow-waist/…' 在装点解析为 ~/.dsh/plugins/_narrow-waist,不同步即 ENOENT、
# 宿主回调链路静默全断。与 host-callback-bridge 同窗拷贝(原子性同现状)。
NW_DIR="${DSH_HOME:-$HOME/.dsh}/plugins/_narrow-waist"
if [ -d "$SRC/plugins/_narrow-waist" ]; then
  mkdir -p "$(dirname "$NW_DIR")"
  rm -rf "$NW_DIR"
  cp -a "$SRC/plugins/_narrow-waist" "$NW_DIR"
  rm -rf "$NW_DIR/__pycache__"
  echo "narrow-waist synced: $SRC/plugins/_narrow-waist -> $NW_DIR"
fi
# a2a lane(2026-08-25 修复案): a2a-profile-server 的 host 面副本(systemd
# a2a-profile-daemon 常驻 :8790)——dev-sync 原不覆盖它(T4 后静默漂移一天:
# 装点停在旧 dais DB 路径指向 0 字节死库)。仓是唯一源头;.git/state 是
# daemon 运行时产物,不同步。
A2A_DIR="${DSH_HOME:-$HOME/.dsh}/plugins/a2a-profile-server"
if [ -d "$SRC/plugins/a2a-profile-server" ]; then
  mkdir -p "$A2A_DIR"
  for f in "$SRC"/plugins/a2a-profile-server/*; do
    name="$(basename "$f")"
    [ "$name" = ".git" ] || [ "$name" = "state" ] && continue
    rm -rf "$A2A_DIR/$name"
    cp -a "$f" "$A2A_DIR/$name"
  done
  rm -rf "$A2A_DIR/__pycache__"
  echo "a2a synced: $SRC/plugins/a2a-profile-server -> $A2A_DIR (daemon 需 restart 生效)"
fi
# persona-axis lane(2026-08-26 整理收编): host 面副本(polyfill.patch.yml 注册行指向
# ~/.dsh/plugins/persona-axis/index.js)。v1.2.0 热修即漏此面——dev-sync 原不覆盖,
# 装点可静默停旧版(事件写入版=resume 断)。仓是唯一源头;state/(sessions.json/
# pending.json)是运行时落账,不同步。
PA_DIR="${DSH_HOME:-$HOME/.dsh}/plugins/persona-axis"
if [ -d "$SRC/plugins/persona-axis" ]; then
  mkdir -p "$PA_DIR"
  for f in "$SRC"/plugins/persona-axis/*; do
    name="$(basename "$f")"
    [ "$name" = ".git" ] || [ "$name" = "state" ] && continue
    rm -rf "$PA_DIR/$name"
    cp -a "$f" "$PA_DIR/$name"
  done
  rm -rf "$PA_DIR/__pycache__"
  echo "persona-axis synced: $SRC/plugins/persona-axis -> $PA_DIR (重启 host 生效)"
fi

case "${1:-}" in
--polyfill-register)
  # 把 polyfill lane 插件行写入 ~/.dsh/plugins/polyfill.patch.yml(幂等: 已在册则不动)。
  PATCH_FILE="${DSH_HOME:-$HOME/.dsh}/plugins/polyfill.patch.yml"
  [ -f "$PATCH_FILE" ] || { echo "dev-sync --polyfill-register: $PATCH_FILE 不存在" >&2; exit 1; }
  if grep -q "host-callback-bridge/index.js" "$PATCH_FILE"; then
    echo "polyfill.patch.yml 已注册 host-callback-bridge(幂等跳过)"
  else
    printf '%s\n' "    - id: host-callback-bridge" "      name: '${POLYFILL_DIR}/index.js'" >> "$PATCH_FILE"
    echo "polyfill registered: host-callback-bridge -> $PATCH_FILE"
  fi
  echo "reminder: polyfill.patch.yml 变更经 HMR 热载入;插件代码变更需重启 host"
  exit 0
  ;;
esac

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
    touch "$SHARED/$name/.maestro-preset-owned"   # 属主标记: stale 清理只碰本仓技能
    # claude 发现面: 沿用 orca-cli/orcard 先例(软链 → ~/.agents/skills)
    if [ -d "$HOME/.claude/skills" ] && { [ ! -e "$HOME/.claude/skills/$name" ] || [ -L "$HOME/.claude/skills/$name" ]; }; then
      ln -sfn "$SHARED/$name" "$HOME/.claude/skills/$name"
    fi
    echo "shared skill: $SHARED/$name"
  done
  # stale 清理: 仓 shared/ 已无的技能,镜像与 claude 软链同步摘除
  # (2026-08-27 技能重构 maestro-bridge→cb-send / orca-bridge+maestro-ledger→maestro-orch 引入)
  for m in "$SHARED"/*/; do
    [ -d "$m" ] || continue
    name="$(basename "$m")"
    if [ -f "$m/.maestro-preset-owned" ] && [ ! -d "$SRC/shared/$name" ]; then
      rm -rf "$SHARED/$name"
      [ -L "$HOME/.claude/skills/$name" ] && rm -f "$HOME/.claude/skills/$name"
      echo "stale skill removed: $SHARED/$name"
    fi
  done
fi
echo "reminder: 改 agent.cordis.yml → 新会话自动新代际; 只改 plugins/*.js → 重启 DSH 才确定性生效"
