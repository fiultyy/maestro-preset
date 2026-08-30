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
# 用法: host/install.sh [--dry-run] [--profile web] [--systemd]
set -euo pipefail
DRY=0; PROFILE=web; SYSTEMD=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --systemd) SYSTEMD=1 ;;
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
  dst="${NM}/$(basename "$pkg")"
  # 替换语义: 包目录整体换新(叠加 cp 会残留旧 .map/空壳 → release-check 漂移)
  run rm -rf "$dst"
  install_dir "$ROOT/$pkg" "$dst"
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


if [ "$SYSTEMD" = 1 ]; then
  echo "== 5. systemd user unit → ${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/"
  NODE_BIN="$(command -v node)"
  [ -n "$NODE_BIN" ] || { echo "node 不在 PATH,无法生成 unit" >&2; exit 1; }
  NODE_BIN_DIR="$(dirname "$(readlink -f "$NODE_BIN")")"
  UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  UNIT="$UNIT_DIR/a2a-profile-daemon.service"
  run mkdir -p "$UNIT_DIR"
  if [ "$DRY" = 1 ]; then
    echo "dry: sed 模板渲染 → $UNIT"
  else
    sed -e "s|__NODE_BIN__|$NODE_BIN|g" \
        -e "s|__DAEMON__|$DSH/plugins/a2a-profile-server/daemon.mjs|g" \
        -e "s|__LOG__|$DSH/a2a-profile-daemon.log|g" \
        "$ROOT/host/systemd/a2a-profile-daemon.service.in" > "$UNIT"
  fi
  run systemctl --user daemon-reload
  run systemctl --user enable a2a-profile-daemon
  echo "   已 enable。在役 daemon 不打断;改代码后手动: systemctl --user restart a2a-profile-daemon"

  # dsh-web(宿主+web GUI) — 插件同发布装点: 模板渲染, 在役不打断
  UNIT="$UNIT_DIR/dsh-web.service"
  if [ -f "$DSH/run-web.sh" ]; then
    if [ "$DRY" = 1 ]; then
      echo "dry: sed 模板渲染 → $UNIT"
    else
      sed -e "s|__DSH__|$DSH|g" \
          -e "s|__NODE_BIN_DIR__|$NODE_BIN_DIR|g" \
          "$ROOT/host/systemd/dsh-web.service.in" > "$UNIT"
    fi
    run systemctl --user daemon-reload
    run systemctl --user enable dsh-web
    echo "   dsh-web 已 enable(在役不打断; 绑定地址由 ${DSH}/cordis.patch.yml webserver 行管)"
  else
    echo "   跳过 dsh-web: ${DSH}/run-web.sh 不存在(先按 host/README.md 人工步骤落 run-web.sh)"
  fi
fi

echo "== 完成。剩余人工步骤(凭据/组合行): host/README.md"
