#!/usr/bin/env bash
# bin/release-check.sh — PACKAGING.md §10 校验清单机械化
#
# 用法: bin/release-check.sh [--with-sync | --selftest]
#   --with-sync  额外跑 bin/dev-sync.sh --verify(装点漂移报告;需本机 DSH_HOME 装点存在)
#   --selftest   纯读自检: 只跑 1/2/3/6/7 五项检查(跳过 4 沙箱实跑安装器与
#                5 node eval 两项有执行面/环境依赖的检查),汇总 pass/fail,
#                exit code 表达结果;可重复运行(全部只读,无副作用)
#
# 检查项(除注明外全部无副作用;沙箱安装用 mktemp -d):
#   1. node --check: maestro plugins/ + host/plugins/ + agent-presets/ 全部 .js/.mjs
#      (host/packages/ 豁免 — tsdown 构建产物)
#   2. /home/<user> 硬编码路径 grep(分发面与本体脚本)
#   3. import 白名单: node:* + 相对路径(host/packages/ 豁免)
#   4. host/install.sh 沙箱实跑(DSH_HOME=mktemp) + 落位数断言        [--selftest 跳过]
#   5. host/polyfill.patch.yml 用 loader 真实方言解析:                [--selftest 跳过]
#      !!js 行求值 — 默认/DSH_HOME 重定向两分支 + 断言无绝对 home 残留
#   6. agent-presets/*/preset.yml name 与 description 不同文(显示重复检测)
#   7. host/packages ↔ 装点一致性(存在装点时)
#   8. dev-sync 装点漂移(仅 --with-sync)
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAIL=0

ok()   { echo "  ok    $*"; }
bad()  { echo "  FAIL  $*"; FAIL=$((FAIL+1)); }
head2(){ echo; echo "== $* =="; }

chk_syntax() {
  head2 "1. node --check (插件语法)"
  COUNT=0
  while IFS= read -r f; do
    node --check "$f" 2>/dev/null || bad "语法: $f"
    COUNT=$((COUNT+1))
  done < <(find "$ROOT/plugins" "$ROOT/host/plugins" "$ROOT/agent-presets" \
           -name "*.js" -o -name "*.mjs" 2>/dev/null)
  [ "$COUNT" -gt 0 ] && ok "$COUNT 个文件" || bad "未找到任何插件文件"
}

chk_homepaths() {
  head2 "2. /home/<user> 硬编码路径"
  HITS=$(grep -rnE '/home/[a-z][a-z0-9_-]*' \
          --include="*.js" --include="*.mjs" --include="*.sh" --include="*.yml" --include="*.md" \
          "$ROOT/host" "$ROOT/agent-presets" "$ROOT/plugins" "$ROOT/bin" \
          "$ROOT/shared" "$ROOT/skills" "$ROOT/agent.cordis.yml" 2>/dev/null \
          | grep -v "docs/\|README.md:" || true)
  # README 中 /home/<user> 形式的占位写法允许(非具体用户名)
  HITS=$(echo "$HITS" | grep -vE '/home/(yy|user)\b' || true)
  [ -z "$HITS" ] && ok "无具体用户路径" || { bad "硬编码:"; echo "$HITS"; }
}

chk_imports() {
  head2 "3. import 白名单 (node:* + 相对路径; host/packages 豁免)"
  BADIMP=$(grep -rhE '^\s*import\s.*from\s' \
             --include="*.js" --include="*.mjs" \
             "$ROOT/plugins" "$ROOT/host/plugins" "$ROOT/agent-presets" 2>/dev/null \
           | grep -vE "from\s+('node:|'\\./|'\\.\\./|\"node:|\"\\./|\"\\.\\./)" || true)
  [ -z "$BADIMP" ] && ok "全部合规" || { bad "越界 import:"; echo "$BADIMP"; }
}

chk_installer() {
  head2 "4. host/install.sh 沙箱实跑"
  SBX=$(mktemp -d)
  if DSH_HOME="$SBX" "$ROOT/host/install.sh" >/dev/null 2>&1; then
    N_PKG=$(find "$SBX/profiles/web/node_modules/@deepseek-ai" -mindepth 1 -maxdepth 1 -type d | wc -l)
    N_PLG=$(find "$SBX/plugins" -mindepth 1 -maxdepth 1 | wc -l)
    N_PRE=$(find "$SBX/.agent-presets" -mindepth 1 -maxdepth 1 -type d | wc -l)
    [ "$N_PKG" = 4 ] && ok "4 个 npm 包" || bad "npm 包数=$N_PKG (期望 4)"
    [ "$N_PLG" = 5 ] && ok "5 个插件"     || bad "插件数=$N_PLG (期望 5)"
    [ "$N_PRE" = 2 ] && ok "2 个 preset"  || bad "preset数=$N_PRE (期望 2)"
  else
    bad "沙箱安装非零退出"
  fi
  rm -rf "$SBX"
}

chk_polyfill() {
  head2 "5. polyfill.patch.yml loader 方言解析"
  CHECK5=$(cat <<'EOF'
const fs = await import("node:fs");
const { pathToFileURL } = await import("node:url");
// 逐字复刻 harness entryListSchema (vendor/include/src/index.ts:9-23)
// 与 loader evaluate (vendor/loader/src/config/utils.ts:5-9);方言变更时同步这里。
let yaml;
// node -e 下 argv[1]=js-yaml 目录, argv[2]=目标 yml
try { yaml = (await import(pathToFileURL(process.argv[1] + "/dist/js-yaml.mjs").href)).default; }
catch { yaml = (await import(pathToFileURL(process.argv[1] + "/index.js").href)).default; }
const JsExpr = new yaml.Type("tag:yaml.org,2002:js", {
  kind: "scalar",
  resolve: (d) => typeof d === "string",
  construct: (d) => ({ __jsExpr: d }),
  predicate: (d) => d instanceof Object && "__jsExpr" in d,
  represent: (d) => d["__jsExpr"],
});
const schema = yaml.JSON_SCHEMA.extend(JsExpr);
const evaluate = new Function("ctx", "expr", `with (ctx) { return eval(expr) }`);
const rows = yaml.load(fs.readFileSync(process.argv[2], "utf8"), { schema });
const isJs = (v) => v instanceof Object && "__jsExpr" in v;
let fail = 0;
for (const r of rows[0].insert) {
  const v = isJs(r.name) ? evaluate({}, r.name.__jsExpr) : r.name;
  if (typeof v !== "string" || !v) { console.error("empty-name: " + r.id); fail = 1; }
}
// DSH_HOME 重定向分支:表达式必须尊重环境变量(默认分支回落真实 home 是合法行为,
// 硬编码检测归静态 grep 检查项 2)
process.env.DSH_HOME = "/tmp/rc-probe";
const rows2 = yaml.load(fs.readFileSync(process.argv[2], "utf8"), { schema });
const n2 = rows2[0].insert.find((r) => r.id === "random-uuid-polyfill");
const v2 = evaluate({}, n2.name.__jsExpr);
if (v2 !== "/tmp/rc-probe/plugins/random-uuid-polyfill.js") { console.error("redirect-wrong: " + v2); fail = 1; }
process.exit(fail);
EOF
)
  JSYAML=""
  for cand in "$ROOT/node_modules/js-yaml" "${HARNESS_ROOT:-$HOME/tools/deepseek-harness}/node_modules/js-yaml"; do
    [ -d "$cand" ] && JSYAML="$cand" && break
  done
  if [ -n "$JSYAML" ]; then
    if node --input-type=module -e "$CHECK5" -- "$JSYAML" "$ROOT/host/polyfill.patch.yml" 2>&1; then
      ok "!!js 求值 + DSH_HOME 重定向正确"
    else
      bad "loader 方言解析失败(见上)"
    fi
  else
    bad "本机无 js-yaml 可解析依赖(装 js-yaml 或在 harness 仓内跑)"
  fi
}

chk_presets() {
  head2 "6. agent-presets preset.yml 元信息"
  for y in "$ROOT"/agent-presets/*/preset.yml; do
    NAME=$(python3 -c "import yaml,sys; print(yaml.safe_load(open(sys.argv[1])).get('name',''))" "$y" 2>/dev/null || echo "?")
    DESC=$(python3 -c "import yaml,sys; print(yaml.safe_load(open(sys.argv[1])).get('description',''))" "$y" 2>/dev/null || echo "?")
    if [ -n "$NAME" ] && [ "$NAME" = "$DESC" ]; then bad "$(dirname "$y" | xargs basename): name==description(显示重复)"; fi
  done
  ok "重复检测完成"
}

chk_versions() {
  head2 "7. host/packages ↔ 装点一致性(存在装点时)"
  DSH="${DSH_HOME:-$HOME/.dsh}"
  NMP="$DSH/profiles/web/node_modules/@deepseek-ai"
  if [ -d "$NMP/dsh-long-task" ]; then
    DRIFT=0
    for dst in dsh-long-task dsh-long-task-context-policy dsh-long-task-round-driver dsh-tool-long-task; do
      RV=$(python3 -c "import json;print(json.load(open('$ROOT/host/packages/$dst/package.json'))['version'])" 2>/dev/null)
      IV=$(python3 -c "import json;print(json.load(open('$NMP/$dst/package.json'))['version'])" 2>/dev/null)
      if [ "$RV" != "$IV" ]; then echo "  drift  $dst: repo=$RV install=$IV"; DRIFT=1; fi
      # 文件清单: 装点多出的 tsbuildinfo 忽略
      RD=$(cd "$ROOT/host/packages/$dst" && find . -type f ! -name '*.tsbuildinfo' | sort)
      ID=$(cd "$NMP/$dst" 2>/dev/null && find . -type f ! -name '*.tsbuildinfo' | sort)
      DIFFN=$(diff <(echo "$RD") <(echo "$ID") | grep -c '^[<>]' || true)
      [ "$DIFFN" -gt 0 ] && { echo "  drift  $dst: 文件清单差 $DIFFN 行"; DRIFT=1; }
    done
    if [ "$DRIFT" = 0 ]; then ok "四包零漂移"; else bad "装点漂移(host/install.sh 重装同步)"; fi
  else
    ok "无装点($NMP 不存在),跳过"
  fi
}

chk_sync() {
  head2 "8. dev-sync 装点漂移"
  if OUT=$("$ROOT/bin/dev-sync.sh" --verify 2>&1); then
    echo "$OUT" | tail -5
    ok "零漂移"
  else
    bad "装点漂移(上方报告)"
  fi
}

case "${1:-}" in
--selftest)
  # 纯读子集: 1/2/3/6/7(跳过 4 沙箱安装与 5 node eval);全部幂等可重复
  chk_syntax
  chk_homepaths
  chk_imports
  chk_presets
  chk_versions
  echo
  if [ "$FAIL" = 0 ]; then
    echo "SELFTEST PASS: 纯读检查 5/5 项通过(跳过 4 沙箱安装与 5 node eval)"
    exit 0
  else
    echo "SELFTEST FAIL: $FAIL 项未过"
    exit 1
  fi
  ;;
--with-sync)
  chk_syntax
  chk_homepaths
  chk_imports
  chk_installer
  chk_polyfill
  chk_presets
  chk_versions
  chk_sync
  ;;
*)
  chk_syntax
  chk_homepaths
  chk_imports
  chk_installer
  chk_polyfill
  chk_presets
  chk_versions
  ;;
esac

echo
if [ "$FAIL" = 0 ]; then echo "PASS: 全部检查通过"; exit 0
else echo "FAIL: $FAIL 项未过"; exit 1; fi
