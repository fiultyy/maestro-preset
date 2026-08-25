#!/usr/bin/env bash
# bin/rebuild-host-packages.sh — host/packages/ 重建管线(P2)
#
# 流程: harness local-dev 构建 → 按包 npm pack → 解包替换 host/packages/<pkg>
#       → 版本 stamp(默认保留 host/packages 现值,--version 改写) → README 钉源 hash
#
# 用法: bin/rebuild-host-packages.sh [--dry-run] [--version <semver>]
#   HARNESS_ROOT 环境变量可覆写(默认 ~/tools/deepseek-harness)
#
# 幂等性: 不带 --version 重跑,内容不变则 host/packages 零 diff(tsbuildinfo 已 gitignore)
set -euo pipefail
DRY=0; VERSION=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --version) VERSION="${2:?--version 需要值}"; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HARNESS="${HARNESS_ROOT:-$HOME/tools/deepseek-harness}"
PKGS_SRC="$HARNESS/packages/long-task"
MAP=(long-task:dsh-long-task long-task-context-policy:dsh-long-task-context-policy
     long-task-round-driver:dsh-long-task-round-driver tool-long-task:dsh-tool-long-task)
HASH=$(git -C "$HARNESS" rev-parse --short=10 HEAD)
BRANCH=$(git -C "$HARNESS" branch --show-current)
DATE=$(date +%F)
echo "源: $BRANCH @ $HASH ($DATE)"

run() { if [ "$DRY" = 1 ]; then echo "dry: $*"; else "$@"; fi; }

# 1. 构建(host face 全量;tsc -b 增量,tsbuildinfo 在则快)
echo "== 1. pnpm build:lib:host =="
run sh -c "cd '$HARNESS' && pnpm build:lib:host"

# 2. 按包 pack + 解包替换
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
echo "== 2. npm pack ×4 → host/packages/ =="
OLDVER=""
for m in "${MAP[@]}"; do
  src="${m%%:*}"; dst="${m##*:}"
  echo "   @deepseek-ai/$dst"
  if [ "$DRY" = 0 ]; then
    # 旧版本号先存:tarball 带的是源 package.json 版本(未发布即回退)
    [ -f "$ROOT/host/packages/$dst/package.json" ] \
      && OLDVER="$OLDVER $dst=$(python3 -c "import json;print(json.load(open('$ROOT/host/packages/$dst/package.json'))['version'])")"
    (cd "$PKGS_SRC/$src" && npm pack --silent --json >"$TMP/$src.json")
    tgz=$(python3 -c "import json;print(json.load(open('$TMP/$src.json'))[0]['filename'])")
    mkdir -p "$TMP/$src" && tar -xzf "$PKGS_SRC/$src/$tgz" -C "$TMP/$src"
    # LICENSE 源包缺失时保留仓内副本(tarball 不含;包完整性需要)
    LIC=""
    [ -f "$ROOT/host/packages/$dst/LICENSE" ] && LIC="$TMP/$dst.license" \
      && cp "$ROOT/host/packages/$dst/LICENSE" "$LIC"
    rm -rf "$ROOT/host/packages/$dst"
    mkdir -p "$ROOT/host/packages/$dst"
    cp -a "$TMP/$src/package/." "$ROOT/host/packages/$dst/"
    [ -n "$LIC" ] && [ ! -f "$ROOT/host/packages/$dst/LICENSE" ] && cp "$LIC" "$ROOT/host/packages/$dst/LICENSE"
    # tsbuildinfo 不入库(files 白名单本就不含;tarball 亦无)
    find "$ROOT/host/packages/$dst" -name '*.tsbuildinfo' -delete
  else
    echo "dry:   (cd $PKGS_SRC/$src && npm pack; 解包 → host/packages/$dst)"
  fi
done

# 3. 版本 stamp: --version 覆写四包;缺省还原各自旧值(tarball 带源版本,须回填)
if [ "$DRY" = 0 ]; then
  echo "== 3. 版本 stamp(${VERSION:-还原旧值}) =="
  for pair in $OLDVER; do
    dst="${pair%%=*}"; ver="${pair##*=}"
    [ -n "$VERSION" ] && ver="$VERSION"
    python3 - "$ROOT/host/packages/$dst/package.json" "$ver" <<'EOF'
import json, sys
p, v = sys.argv[1], sys.argv[2]
d = json.load(open(p)); d["version"] = v
open(p, "w").write(json.dumps(d, indent=2, ensure_ascii=False) + "\n")
EOF
  done
fi

# 4. README 钉构建基线(marker 行原地更新)
if [ "$DRY" = 0 ]; then
  NOTE="$ROOT/host/README.md"
  LINE="- 构建基线: $BRANCH @ \`$HASH\` ($DATE);重建入口本仓 bin/rebuild-host-packages.sh"
  if grep -q '^- 构建基线:' "$NOTE"; then
    sed -i "s|^- 构建基线:.*|$LINE|" "$NOTE"
  else
    sed -i "/^## 版本注记/a\\
$LINE" "$NOTE"
  fi
  echo "== 4. host/README.md 构建基线已更新 =="
fi
echo "完成。git diff 检查 host/packages 变更后提交。"
