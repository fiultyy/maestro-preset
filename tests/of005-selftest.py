#!/usr/bin/env python3
# OF-005 selftest — tickets DAG 数据化(状态机/deps 门/flock 并发/render v4/回溯查询/既有子命令回归)
# 红线:一切库访问走 MAESTRO_LEDGER=<temp db>;render 一律 -o <temp>;绝不触 live ledger.db 与真实 tickets.md。
import json, os, shutil, sqlite3, subprocess, sys, tempfile
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LEDGER = os.path.join(HERE, 'bin', 'ledger')

CASES, FAILS = [], []

def case(fn):
    CASES.append(fn)
    return fn

def run(db, *args, check=True):
    r = subprocess.run([sys.executable, LEDGER, *args], capture_output=True, text=True,
                       env={**os.environ, 'MAESTRO_LEDGER': db})
    if check and r.returncode != 0:
        raise AssertionError(f'意外非零退出: ledger {" ".join(args)}\nrc={r.returncode}\nstderr={r.stderr.strip()}')
    return r

def q(db, sql, *params):
    c = sqlite3.connect(db)
    c.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in c.execute(sql, params)]
    finally:
        c.close()

def exec_sql(db, sql, *params):
    c = sqlite3.connect(db)
    try:
        c.execute(sql, params)
        c.commit()
    finally:
        c.close()

def newdb(d, name):
    return os.path.join(d, name)

def legacy_schema(db):
    """按 live ledger.db 现行 schema 建 projects/nodes/events fixture 表(旧库等价物)。"""
    c = sqlite3.connect(db)
    try:
        c.executescript("""
          CREATE TABLE projects(key TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL,
            repo_id TEXT, status TEXT NOT NULL DEFAULT 'unknown', summary TEXT, updated_at TEXT NOT NULL);
          CREATE TABLE nodes(id INTEGER PRIMARY KEY AUTOINCREMENT, project_key TEXT NOT NULL, node_id TEXT NOT NULL,
            kind TEXT NOT NULL, title TEXT, status TEXT NOT NULL DEFAULT 'pending', owner TEXT, refs TEXT,
            updated_at TEXT NOT NULL, UNIQUE(project_key, node_id));
          CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, project_key TEXT,
            node_id TEXT, event_type TEXT NOT NULL, source TEXT, detail TEXT);
        """)
        c.commit()
    finally:
        c.close()

def to_state(db, tid, target):
    """把无 deps 票据沿合法路径迁到 target(测试铺轨用)。"""
    PATHS = {'dispatched': [], 'running': ['running'], 'blocked': ['running', 'blocked'],
             'done': ['running', 'done'], 'merged': ['running', 'done', 'merged'],
             'rejected': ['rejected'], 'rolled-back': ['running', 'done', 'merged', 'rolled-back']}
    for s in PATHS[target]:
        run(db, 'ticket', 'state', tid, s)

# ── 回归(OG1:既有子命令零变化) ────────────────────────────────────────────

@case
def C1_既有子命令回归(tmp):
    compile(open(LEDGER, encoding='utf-8').read(), LEDGER, 'exec')  # G1 等价,零 __pycache__ 副产物
    db = newdb(tmp, 'reg.db')
    legacy_schema(db)
    proj = os.path.join(tmp, 'regrepo')
    r = run(db, 'project', proj, 'p1')
    assert r.stdout.strip() == proj, f'project 输出漂移: {r.stdout!r}'
    r = run(db, 'node', proj, 'n1', 'impl', '标题A', 'pending')
    assert r.stdout.strip() == 'n1 -> pending', f'node 输出漂移: {r.stdout!r}'
    r = run(db, 'event', proj, 'n1', 'build', '详情X')
    assert r.stdout.strip() == 'event +build @ n1', f'event 输出漂移: {r.stdout!r}'
    r = run(db, 'review', proj, 'n1', 'pass', '通过')
    assert r.stdout.strip() == 'n1 -> reviewed-pass', f'review 输出漂移: {r.stdout!r}'
    r = run(db, 'status', proj)
    lines = [l.rstrip() for l in r.stdout.splitlines()]
    assert lines[0] == f'== {proj}', f'status 头漂移: {lines[:1]!r}'
    node_line = next(l for l in lines if ' n1 ' in f" {l} ")
    assert node_line.startswith('  ') and 'reviewed-pass' in node_line and 'impl' in node_line, node_line
    assert any('build(orch1)' in l and '详情X' in l for l in lines), lines
    assert any('reviewed(orch1)' in l and '通过' in l for l in lines), lines

# ── 验收①:状态机 ──────────────────────────────────────────────────────

LEGAL_TRANSITIONS = [  # 12 条合法迁移,全表
    ('dispatched', 'running'), ('dispatched', 'rejected'),
    ('running', 'blocked'), ('running', 'done'), ('running', 'rejected'),
    ('blocked', 'running'), ('blocked', 'done'), ('blocked', 'rejected'),
    ('done', 'running'), ('done', 'merged'), ('done', 'rejected'),
    ('merged', 'rolled-back'),
]

@case
def C2_add与list基础(tmp):
    db = newdb(tmp, 'add.db')
    r = run(db, 'ticket', 'add', 'OF-101', '标题甲',
            '--refs', '{"worktree":"/wt/a","run":"/run/a","session":"s1","verify":"/v/a"}')
    assert r.stdout.strip() == 'OF-101 +dispatched', r.stdout
    rows = json.loads(run(db, 'ticket', 'list', '--json').stdout)
    assert len(rows) == 1 and rows[0]['ticket_id'] == 'OF-101' and rows[0]['state'] == 'dispatched'
    assert rows[0]['deps'] == '[]' and rows[0]['lease_owner'] is None
    assert json.loads(rows[0]['refs'])['worktree'] == '/wt/a'
    r = run(db, 'ticket', 'add', 'OF-101', '重复', check=False)
    assert r.returncode != 0 and 'exists' in r.stderr
    r = run(db, 'ticket', 'add', 'OF-102', '坏refs', '--refs', '{bad', check=False)
    assert r.returncode != 0 and 'JSON' in r.stderr
    r = run(db, 'ticket', 'add', 'OF-103', '坏deps', '--deps', '"not-array"', check=False)
    assert r.returncode != 0 and '数组' in r.stderr
    r = run(db, 'ticket', 'state', 'OF-404', 'running', check=False)
    assert r.returncode != 0 and 'not found' in r.stderr

@case
def C3_状态机全合法迁移(tmp):
    db = newdb(tmp, 'sm.db')
    for tid in ('TA', 'TB', 'TC', 'TD', 'TE', 'TF'):
        run(db, 'ticket', 'add', tid, 't' + tid)
    WALKS = {
        'TA': ['running', 'blocked', 'running', 'done', 'merged', 'rolled-back'],
        'TB': ['rejected'],
        'TC': ['running', 'rejected'],
        'TD': ['running', 'blocked', 'done'],
        'TE': ['running', 'blocked', 'rejected'],
        'TF': ['running', 'done', 'running', 'done', 'rejected'],
    }
    for tid, steps in WALKS.items():
        for s in steps:
            run(db, 'ticket', 'state', tid, s)
    final = {r['ticket_id']: r['state'] for r in q(db, 'SELECT ticket_id,state FROM tickets')}
    assert final == {'TA': 'rolled-back', 'TB': 'rejected', 'TC': 'rejected',
                     'TD': 'done', 'TE': 'rejected', 'TF': 'rejected'}, final
    # 覆盖率勾稽:12 条合法迁移逐条被上面 WALKS 走过
    covered = set()
    for tid, steps in WALKS.items():
        cur = 'dispatched'
        for s in steps:
            covered.add((cur, s))
            cur = s
    assert covered == set(LEGAL_TRANSITIONS), covered ^ set(LEGAL_TRANSITIONS)
    # 每步迁移有 append-only 事件
    evs = q(db, "SELECT ticket_id,event_type,detail FROM ticket_events WHERE event_type='state'")
    assert len(evs) == sum(len(s) for s in WALKS.values()) and evs[0]['detail'] == 'dispatched -> running'

@case
def C4_状态机非法迁移拒绝(tmp):
    db = newdb(tmp, 'ill.db')
    for i, (frm, to) in enumerate([('dispatched', 'merged'), ('dispatched', 'done'),
                                   ('running', 'merged'), ('running', 'dispatched'),
                                   ('blocked', 'merged'), ('done', 'blocked'),
                                   ('merged', 'running'), ('rejected', 'running'),
                                   ('rolled-back', 'merged')]):
        tid = f'I{i}'
        run(db, 'ticket', 'add', tid, '非法迁移' + tid)
        to_state(db, tid, frm)
        r = run(db, 'ticket', 'state', tid, to, check=False)
        assert r.returncode != 0 and 'illegal transition' in r.stderr, (tid, frm, to, r.stderr)
        assert json.loads(run(db, 'ticket', 'list', '--state', frm, '--json').stdout), f'{tid} 迁移失败后状态应不变'
    # 未知状态名被 argparse choices 拒
    r = run(db, 'ticket', 'state', 'I0', 'paused', check=False)
    assert r.returncode != 0

# ── 验收②:deps 前置门 + --force ────────────────────────────────────────

@case
def C5_deps前置与force旁路(tmp):
    db = newdb(tmp, 'deps.db')
    for t in ('D1', 'D2', 'C1'):
        run(db, 'ticket', 'add', t, 'dep 测试 ' + t)
    run(db, 'ticket', 'dep', 'C1', 'D1')
    run(db, 'ticket', 'dep', 'C1', 'D2')
    r = run(db, 'ticket', 'state', 'C1', 'running', check=False)
    assert r.returncode != 0 and 'D1' in r.stderr and 'D2' in r.stderr and '--force' in r.stderr, r.stderr
    run(db, 'ticket', 'state', 'D1', 'running')
    run(db, 'ticket', 'state', 'D1', 'done')
    r = run(db, 'ticket', 'state', 'C1', 'running', check=False)
    assert r.returncode != 0 and 'D2' in r.stderr and 'D1' not in r.stderr.replace('--force', ''), r.stderr
    r = run(db, 'ticket', 'state', 'C1', 'running', '--force')
    assert r.returncode == 0 and '(forced)' in r.stdout, r.stdout
    forced = q(db, "SELECT detail FROM ticket_events WHERE ticket_id='C1' AND event_type='deps-forced'")
    assert len(forced) == 1 and 'D2' in forced[0]['detail'], forced
    r = run(db, 'ticket', 'state', 'C1', 'done', check=False)  # D2 仍未 done → done 也设门
    assert r.returncode != 0 and 'D2' in r.stderr
    run(db, 'ticket', 'state', 'D2', 'running')
    run(db, 'ticket', 'state', 'D2', 'done')
    run(db, 'ticket', 'state', 'C1', 'done')  # deps 齐,无 force 通过
    assert q(db, "SELECT state FROM tickets WHERE ticket_id='C1'")[0]['state'] == 'done'
    assert len(q(db, "SELECT 1 FROM ticket_events WHERE event_type='deps-forced'")) == 1  # 全程仅一次旁路
    # 依赖未入库票(镜像场景):同样挡门
    run(db, 'ticket', 'add', 'C2', '镜像依赖')
    run(db, 'ticket', 'dep', 'C2', 'OF-404')
    r = run(db, 'ticket', 'state', 'C2', 'running', check=False)
    assert r.returncode != 0 and 'OF-404' in r.stderr

@case
def C6_dep边与环(tmp):
    db = newdb(tmp, 'cycle.db')
    for t in ('X1', 'X2', 'X3'):
        run(db, 'ticket', 'add', t, 'x' + t)
    run(db, 'ticket', 'dep', 'X1', 'X2')
    assert json.loads(q(db, "SELECT deps FROM tickets WHERE ticket_id='X1'")[0]['deps']) == ['X2']
    r = run(db, 'ticket', 'dep', 'X2', 'X1', check=False)
    assert r.returncode != 0 and '环' in r.stderr
    run(db, 'ticket', 'dep', 'X2', 'X3')
    run(db, 'ticket', 'dep', 'X1', 'X3')  # 无环可加
    r = run(db, 'ticket', 'dep', 'X3', 'X1', check=False)  # X1→X2→X3→X1 成环
    assert r.returncode != 0 and '环' in r.stderr
    r = run(db, 'ticket', 'dep', 'X1', 'X1', check=False)
    assert r.returncode != 0 and 'self' in r.stderr
    r = run(db, 'ticket', 'dep', 'X1', 'X2', check=False)  # 重复边拒绝
    assert r.returncode != 0 and 'exists' in r.stderr
    run(db, 'ticket', 'dep', 'X1', 'OF-404')  # 未入库票允许(§8 镜像场景)
    assert json.loads(q(db, "SELECT deps FROM tickets WHERE ticket_id='X1'")[0]['deps']) == ['X2', 'X3', 'OF-404']
    run(db, 'ticket', 'dep', 'X1', 'X3', '--rm')
    assert json.loads(q(db, "SELECT deps FROM tickets WHERE ticket_id='X1'")[0]['deps']) == ['X2', 'OF-404']
    r = run(db, 'ticket', 'dep', 'X1', 'X3', '--rm', check=False)
    assert r.returncode != 0 and 'no such dep' in r.stderr

@case
def C7_lease(tmp):
    db = newdb(tmp, 'lease.db')
    run(db, 'ticket', 'add', 'L1', 'lease 测试')
    r = run(db, 'ticket', 'lease', 'L1', 'orch1')
    assert 'lease_owner=orch1' in r.stdout
    assert json.loads(run(db, 'ticket', 'list', '--json').stdout)[0]['lease_owner'] == 'orch1'
    r = run(db, 'ticket', 'lease', 'L1', '--release')
    assert 'lease_owner=-' in r.stdout
    assert json.loads(run(db, 'ticket', 'list', '--json').stdout)[0]['lease_owner'] is None
    assert len(q(db, "SELECT 1 FROM ticket_events WHERE ticket_id='L1' AND event_type='lease'")) == 2
    r = run(db, 'ticket', 'lease', 'L1', check=False)  # 缺 owner 且非 --release
    assert r.returncode != 0

# ── 验收④:flock 并发 ───────────────────────────────────────────────────

@case
def C8_并发双进程add(tmp):
    db = newdb(tmp, 'conc2.db')
    env = {**os.environ, 'MAESTRO_LEDGER': db}
    ps = [subprocess.Popen([sys.executable, LEDGER, 'ticket', 'add', f'P{i}', f'并发{i}'],
                           env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for i in (1, 2)]
    rcs = [p.wait() for p in ps]
    assert rcs == [0, 0], [p.stderr.read() for p in ps]
    ids = {r['ticket_id'] for r in json.loads(run(db, 'ticket', 'list', '--json').stdout)}
    assert {'P1', 'P2'} <= ids, ids
    assert q(db, 'PRAGMA integrity_check')[0]['integrity_check'] == 'ok'

@case
def C9_并发六进程压力(tmp):
    db = newdb(tmp, 'conc6.db')
    env = {**os.environ, 'MAESTRO_LEDGER': db}
    ps = [subprocess.Popen([sys.executable, LEDGER, 'ticket', 'add', f'S{i}', f'压力{i}'],
                           env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for i in range(6)]
    rcs = [p.wait() for p in ps]
    assert rcs == [0] * 6, [p.stderr.read() for p in ps]
    ids = {r['ticket_id'] for r in json.loads(run(db, 'ticket', 'list', '--json').stdout)}
    assert ids == {f'S{i}' for i in range(6)}, ids
    assert q(db, 'PRAGMA integrity_check')[0]['integrity_check'] == 'ok'

# ── 验收③:render v4 字段 + 幂等 + hand 保留区 ───────────────────────────

def seed_render_db(db):
    run(db, 'ticket', 'add', 'R1', '甲 dispatched')
    run(db, 'ticket', 'add', 'R2', '乙 running', '--deps', '["R1"]', '--refs',
        '{"worktree":"/wt/of005","run":"/run/of005","dispatch":"/d/of005","session":"sess-9","verify":"/v/of005.py"}')
    run(db, 'ticket', 'state', 'R2', 'running', '--force')  # 前置 R1 未 done,镜像场景走 force
    run(db, 'ticket', 'add', 'R3', '丙 blocked');  to_state(db, 'R3', 'blocked')
    run(db, 'ticket', 'add', 'R4', '丁 done');     to_state(db, 'R4', 'done')
    run(db, 'ticket', 'add', 'R5', '戊 merged');   to_state(db, 'R5', 'merged')
    run(db, 'ticket', 'add', 'R6', '己 rejected'); to_state(db, 'R6', 'rejected')
    run(db, 'ticket', 'add', 'R7', '庚 rolled');   to_state(db, 'R7', 'rolled-back')

@case
def C10_render_v4字段(tmp):
    db = newdb(tmp, 'render.db')
    seed_render_db(db)
    out = os.path.join(tmp, 'board.md')
    open(out, 'w', encoding='utf-8').write('# 旧手写票板\n\n### SI-999 手写 SENTINEL-HAND-42\n旧内容行\n')
    r = run(db, 'ticket', 'render', '-o', out)
    assert 'render 7 tickets' in r.stdout, r.stdout
    md = open(out, encoding='utf-8').read()
    assert 'AUTOGENERATED' in md
    for sym in ('☐', '◐', '☑'):
        assert sym in md, f'缺状态符号 {sym}'
    for tid, sym in (('R1', '☐'), ('R2', '◐'), ('R3', '◐'), ('R4', '☑'), ('R5', '☑'),
                     ('R6', '☑'), ('R7', '☑')):
        line = next(l for l in md.splitlines() if l.startswith(f'### {tid} '))
        assert line.rstrip().endswith(sym), (line, sym)
    seg = md[md.index('### R2 '):md.index('### R3 ')]
    assert 'worktree=/wt/of005' in seg and 'run=/run/of005' in seg
    assert 'dispatch=/d/of005' in seg and 'session=sess-9' in seg
    assert '**验证目标指针**: /v/of005.py' in seg
    assert 'R1(dispatched)' in seg                      # 依赖列(带实时状态)
    for kw in ('**状态**', '**路径**', '**验证目标指针**', '**依赖**'):
        assert kw in md, kw
    assert 'SENTINEL-HAND-42' in md                     # 既有全文被保留

@case
def C11_render幂等(tmp):
    db = newdb(tmp, 'idem.db')
    seed_render_db(db)
    out = os.path.join(tmp, 'idem.md')
    run(db, 'ticket', 'render', '-o', out)
    b1 = open(out, 'rb').read()
    run(db, 'ticket', 'render', '-o', out)
    b2 = open(out, 'rb').read()
    assert b1 == b2, '两次渲染字节不一致'
    out2 = os.path.join(tmp, 'idem2.md')
    run(db, 'ticket', 'render', '-o', out2)
    assert open(out2, 'rb').read() == b1, '跨目标渲染不一致(非 DB 纯函数)'

@case
def C12_hand保留区(tmp):
    db = newdb(tmp, 'hand.db')
    seed_render_db(db)
    out = os.path.join(tmp, 'hand.md')
    old = 'SENTINEL-HAND-42 旧全文第一行\n第二行\n'
    open(out, 'w', encoding='utf-8').write(old)
    run(db, 'ticket', 'render', '-o', out)
    m1 = open(out, encoding='utf-8').read()
    assert '<!-- hand -->' in m1 and '<!-- /hand -->' in m1
    zone = m1.split('<!-- hand -->\n', 1)[1].split('<!-- /hand -->')[0]
    assert zone == old, f'hand 区应逐字节保留既有全文: {zone!r}'
    run(db, 'ticket', 'add', 'R8', '辛 新增')
    run(db, 'ticket', 'render', '-o', out)               # auto 区更新
    m2 = open(out, encoding='utf-8').read()
    assert '### R8 ' in m2 and m2.count('SENTINEL-HAND-42') == 1
    zone2 = m2.split('<!-- hand -->\n', 1)[1].split('<!-- /hand -->')[0]
    assert zone2 == zone, '再渲染后 hand 区漂移'
    run(db, 'ticket', 'render', '-o', out)               # 复渲染幂等
    assert open(out, encoding='utf-8').read() == m2

# ── 验收⑤:回溯查询 ─────────────────────────────────────────────────────

@case
def C13_回溯查询(tmp):
    db = newdb(tmp, 'query.db')
    for t in ('A1', 'A2'):
        run(db, 'ticket', 'add', t, 'q' + t)
        to_state(db, t, 'blocked')
    old = (datetime.now(timezone.utc) - timedelta(hours=30)).isoformat(timespec='seconds')
    exec_sql(db, "UPDATE tickets SET updated_at=? WHERE ticket_id='A1'", old)
    r = run(db, 'ticket', 'list', '--state', 'blocked', '--since', '24h')
    assert 'A2' in r.stdout and 'A1' not in r.stdout, r.stdout
    r = run(db, 'ticket', 'list', '--state', 'blocked')
    assert 'A1' in r.stdout and 'A2' in r.stdout, r.stdout
    rows = json.loads(run(db, 'ticket', 'list', '--state', 'blocked', '--since', '35h', '--json').stdout)
    assert {x['ticket_id'] for x in rows} == {'A1', 'A2'}, rows
    rows = json.loads(run(db, 'ticket', 'list', '--state', 'blocked', '--since', '2d', '--json').stdout)
    assert {x['ticket_id'] for x in rows} == {'A1', 'A2'}, rows
    r = run(db, 'ticket', 'list', '--since', 'bogus', check=False)
    assert r.returncode != 0 and '--since' in r.stderr
    r = run(db, 'ticket', 'list', '--state', 'nope', check=False)
    assert r.returncode != 0 and 'unknown state' in r.stderr

def main():
    assert 'MAESTRO_LEDGER' not in os.environ or os.environ['MAESTRO_LEDGER'].startswith('/tmp'), \
        '禁止以非 temp MAESTRO_LEDGER 环境跑 selftest'
    print(f'OF-005 selftest · ledger={LEDGER} · python={sys.version.split()[0]}')
    tmproot = tempfile.mkdtemp(prefix='of005-selftest-')
    try:
        for fn in CASES:
            d = tempfile.mkdtemp(dir=tmproot)  # 每用例独立 temp db,零交叉
            try:
                fn(d)
                print(f'[ ok ] {fn.__name__}')
            except AssertionError as e:
                print(f'[FAIL] {fn.__name__}: {e}')
                FAILS.append(fn.__name__)
            except Exception as e:
                print(f'[FAIL] {fn.__name__}: {type(e).__name__}: {e}')
                FAILS.append(fn.__name__)
    finally:
        shutil.rmtree(tmproot, ignore_errors=True)
    total = len(CASES)
    if FAILS:
        print(f'OF-005 selftest: {total - len(FAILS)}/{total} 绿,失败: {", ".join(FAILS)}')
        sys.exit(1)
    print(f'OF-005 selftest: {total}/{total} 全绿(exit 0)')
    sys.exit(0)

if __name__ == '__main__':
    main()
