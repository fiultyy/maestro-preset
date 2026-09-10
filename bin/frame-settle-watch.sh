#!/usr/bin/env bash
# frame-settle-watch.sh — 编排者侧票态硬水化哨 (orch-hooks 组, 2026-09-10 FRAME-SETTLE)
# 职责: 帧到达编排者会话即记账,不靠 agent 约定——
#   ticket-received → 票 dispatched→running(幂等:非 dispatched 跳过)
#   ticket-done     → 票+node → end(END 语义:回合结束待复验;复验不过改单 end→running 合法)
# 双路径:
#   A) stdin prompt 帧: ORCA-CB] {json}(桥投递形,实证@本席/e6aa 会话)或 DSHMSG]{json}(信封形)
#   B) inbox 兜底: 桥未投/投失败的帧滞留 inbox.log → 游标增量扫(e6aa 实证:done 帧零投递,
#      G1 全靠 agent sweep 收账=本哨要消灭的洞)
# 寻址(to 匹配): 帧 to 含本会话 session_id(全/前8位)或含 ORCH_SIG → 投本席;其余跳过。
# 幂等: msgid 全局去重(settled-msgids.log,尾500);票现态优先;dag-close 同态跳过。
# fail-open: 任何失败 exit 0(不阻回合);无帧快退。env 同 ups-dispatch-watch 族:
#   ORCH_SIG ORCH_INBOX ORCH_SETTLE_HOME(状态目录,缺省 ~/.dsh/maestro/orch-hooks)
#   ORCH_MAESTRO_DIR(maestro 面,缺省 ~/.dsh/maestro: bin/orch+bin/ledger+state*/orch-dag.json;
#   注意与 orch CLI 的 MAESTRO_HOME[.dsh 级]不同层,故独立命名)
#   MAESTRO_LEDGER(库重定向,selftest 用)
STDIN="$(cat 2>/dev/null || :)"
[ -n "$ORCH_INBOX" ] || ORCH_INBOX="$HOME/.dsh/maestro/bridge/inbox.log"
[ -n "$ORCH_SETTLE_HOME" ] || ORCH_SETTLE_HOME="$HOME/.dsh/maestro/orch-hooks"
[ -n "$ORCH_MAESTRO_DIR" ] || ORCH_MAESTRO_DIR="$HOME/.dsh/maestro"
printf '%s' "$STDIN" | grep -aq 'ORCA-CB\]\|DSHMSG]' || { [ -s "$ORCH_INBOX" ] || exit 0; }
command -v python3 >/dev/null 2>&1 || exit 0

if [ -n "$ORCH_DEBUG" ]; then
  { echo "=== $(date +%T) $$ $0 stdin-head: $(printf '%s' "$STDIN" | head -c 160)"; } >> "$ORCH_DEBUG" 2>/dev/null || :
fi

ORCH_SIG="$ORCH_SIG" ORCH_INBOX="$ORCH_INBOX" ORCH_SETTLE_HOME="$ORCH_SETTLE_HOME" \
ORCH_MAESTRO_DIR="$ORCH_MAESTRO_DIR" MAESTRO_LEDGER="$MAESTRO_LEDGER" ORCH_DEBUG="$ORCH_DEBUG" \
STDIN="$STDIN" python3 - <<'PYFSW' 2>/dev/null || :
import glob, json, os, re, sqlite3, subprocess, sys, uuid

ENV = os.environ
DEBUG = ENV.get('ORCH_DEBUG', '')
def dbg(msg):
    if DEBUG:
        try: open(DEBUG, 'a').write(f"fsw: {msg}\n")
        except OSError: pass

# ── 会话身份(stdin JSON: session_id/prompt) ──────────────────────────────
try:
    payload = json.loads(ENV.get('STDIN') or '{}')
except json.JSONDecodeError:
    payload = {}
SID = str(payload.get('session_id') or '')
PROMPT = str(payload.get('prompt') or '')
if not SID:
    sys.exit(0)
SID8 = SID[:8]
SIG = ENV.get('ORCH_SIG', '')

# ── 帧提取: prompt(路径A) + inbox 增量(路径B) ────────────────────────────
#   prompt 形: ORCA-CB] {json}(桥投递形) / DSHMSG]{json}(信封形)——前缀锚定防误触(prompt 里
#   任意 json 行[如代码块]不得当帧)。inbox 形: 裸 json 行(桥收件箱原生格式,无前缀)。
FRAME_RE = re.compile(r'(?:ORCA-CB\]\s*|DSHMSG\])(\{[^{}\n]*?"type"\s*:\s*"[a-z-]+"[^{}\n]*?\})')
RAW_RE = re.compile(r'^(\{[^{}\n]*?"type"\s*:\s*"[a-z-]+"[^{}\n]*?\})\s*$', re.M)
def frames_of(text, raw=False):
    out = []
    for m in ((RAW_RE if raw else FRAME_RE).finditer(text or '')):
        try: out.append(json.loads(m.group(1)))
        except json.JSONDecodeError: continue
    return out

frames = frames_of(PROMPT)

inbox = ENV.get('ORCH_INBOX', '')
home = ENV.get('ORCH_SETTLE_HOME') or os.path.join(os.path.expanduser('~'), '.dsh/maestro/orch-hooks')
try: os.makedirs(home, exist_ok=True)
except OSError: pass
cursor_f = os.path.join(home, f'settle-cursor-{SID8}')
if inbox and os.path.isfile(inbox):
    try: pos = int(open(cursor_f).read().strip() or 0)
    except (OSError, ValueError): pos = 0
    try:
        with open(inbox, encoding='utf-8', errors='replace') as fh:
            fh.seek(0, 2); size = fh.tell()
            if size >= pos:
                fh.seek(pos)
            else:
                fh.seek(0); pos = 0   # 轮转重写(变小): 从头重扫
            new_frames = frames_of(fh.read(), raw=True)
            pos = size
            # 只留 to 投本席的(inbox 是全席公共流)
            frames += [f for f in new_frames if f.get('to') and (SID in str(f['to']) or SID8 in str(f['to']))]
            try: open(cursor_f, 'w').write(str(pos))
            except OSError: pass
    except OSError: pass

# ── 过滤: 本哨只认 received/done + to 投本席 ────────────────────────────
def mine(f):
    to = str(f.get('to') or '')
    return bool(to) and (SID in to or SID8 in to or (SIG and SIG in to))
todo = []
for f in frames:
    if f.get('type') in ('ticket-received', 'ticket-done') and mine(f):
        todo.append(f)
if not todo:
    sys.exit(0)

# ── msgid 去重(按席分文件,尾500;防 A/B 双路径同源帧与桥重投重放;分席=不误消化他席
#   未处理帧——多编排席共面各记各账,读写无竞态) ──────────────────────────
msgids_f = os.path.join(home, f'settled-msgids-{SID8}.log')
seen = set()
try: seen = set(open(msgids_f, encoding='utf-8', errors='replace').read().split()[-500:])
except OSError: pass
fresh = []
for f in todo:
    mid = str(f.get('msgid') or '')
    if not mid or mid not in seen:
        fresh.append(f)
        if mid: seen.add(mid)
if not fresh:
    sys.exit(0)
try:
    with open(msgids_f, 'a', encoding='utf-8') as fh:
        for f in fresh:
            mid = str(f.get('msgid') or '')
            if mid: fh.write(mid + '\n')
except OSError: pass

# ── ledger 现态查询(轻量直读 sqlite;票表 tickets) ────────────────────────
mh = ENV.get('ORCH_MAESTRO_DIR') or os.path.join(os.path.expanduser('~'), '.dsh/maestro')
db = ENV.get('MAESTRO_LEDGER') or os.path.join(mh, 'ledger.db')
def ticket_state(ref):
    try:
        con = sqlite3.connect(f'file:{db}?mode=ro', uri=True, timeout=2)
        row = con.execute('SELECT state FROM tickets WHERE ticket_id=?', (ref,)).fetchone()
        con.close()
        return row[0] if row else None
    except sqlite3.Error:
        return '?'   # 库不可读: fail-open 前提下不再盲迁,交 agent 路径

# ── state 发现: 找 refs 含 ref 的 state(默认+隔离族 state*/orch-dag.json) ──
_state_cache = None
def state_of(ref):
    global _state_cache
    if _state_cache is None:
        _state_cache = {}
        cands = ([os.environ.get('ORCH_DAG_STATE')] if os.environ.get('ORCH_DAG_STATE') else []) \
            + sorted(glob.glob(os.path.join(mh, 'state*', 'orch-dag.json')))
        for p in cands:
            try:
                st = json.load(open(p, encoding='utf-8'))
            except (OSError, json.JSONDecodeError):
                continue
            for k in (st.get('refs') or {}):
                _state_cache.setdefault(k, p)
    return _state_cache.get(ref)

orch_bin = os.path.join(mh, 'bin', 'orch')

# ── 水化执行 ─────────────────────────────────────────────────────────────
ledger_bin = os.path.join(mh, 'bin', 'ledger')
base_env = dict(os.environ)
for f in fresh:
    ref, ftype = str(f.get('ref') or ''), f.get('type')
    if not ref or ref == '-' or ticket_state(ref) is None:
        continue   # 无 ref/非票帧(如 ping ref=-)/票不在库: 静默
    if ftype == 'ticket-received':
        if ticket_state(ref) != 'dispatched':
            dbg(f'skip received {ref} state={ticket_state(ref)}')
            continue
        subprocess.run([ledger_bin, 'ticket', 'state', ref, 'running',
                        '--source', 'frame-settle-watch',
                        '--note', 'ticket-received 帧水化(worker 收讫)'],
                       capture_output=True, timeout=5, env=base_env)
        dbg(f'received {ref} → running')
    elif ftype == 'ticket-done':
        cur = ticket_state(ref)
        if cur in ('end', 'rejected', 'rolled-back'):
            dbg(f'skip done {ref} state={cur}')
            continue
        if cur in ('dispatched', 'blocked'):
            # 票状态机无 dispatched→end 直迁(legal: rejected,running)——先补 running(received 语义)
            # 再关账;received 帧缺位/未处理场景由是补全,票路 dispatched→running→end 完整。
            subprocess.run([ledger_bin, 'ticket', 'state', ref, 'running',
                            '--source', 'frame-settle-watch',
                            '--note', 'done 帧前置水化(received 缺位补 running)'],
                           capture_output=True, timeout=5, env=base_env)
        sp = state_of(ref)
        if sp and os.path.isfile(orch_bin):
            e2 = dict(base_env, ORCH_DAG_STATE=sp)
            r = subprocess.run([orch_bin, 'dag-close', ref, 'end',
                                '--outcome', f'auto:ticket-done 帧硬水化(待复验) from={f.get("from","?")[:60]}'],
                               capture_output=True, text=True, timeout=8, env=e2)
            dbg(f'done {ref} dag-close rc={r.returncode} {r.stdout.strip()[:80]}')
        else:
            subprocess.run([ledger_bin, 'ticket', 'state', ref, 'end',
                            '--source', 'frame-settle-watch',
                            '--note', 'auto:ticket-done 帧硬水化(无 state,node 跳过)'],
                           capture_output=True, timeout=5, env=base_env)
            dbg(f'done {ref} → end(ledger-only)')
sys.exit(0)
PYFSW
exit 0
