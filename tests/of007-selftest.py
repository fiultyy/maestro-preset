#!/usr/bin/env python3
# OF-007 selftest — wave 检查点机器可读(原子追加/tail 重建/跳号 WARN/旧库容错/kill -9 完整性)
# 红线:检查点一律 --file <temp>;ledger 一律 MAESTRO_LEDGER=<temp db>;真实 state/wave-checkpoints.jsonl 与 ledger.db 零触碰。
import importlib.machinery
import importlib.util
import json
import os
import random
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
from datetime import datetime

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(HERE, 'bin', 'wave-checkpoint')

CASES, FAILS = [], []


def case(fn):
    CASES.append(fn)
    return fn


def run(db, *args, check=True):
    r = subprocess.run([sys.executable, SCRIPT, *args], capture_output=True, text=True,
                       env={**os.environ, 'MAESTRO_LEDGER': db})
    if check and r.returncode != 0:
        raise AssertionError(f'意外非零退出: wave-checkpoint {" ".join(args)}\nrc={r.returncode}\nstderr={r.stderr.strip()}')
    return r


def load_module():
    loader = importlib.machinery.SourceFileLoader('wc_u007', SCRIPT)
    spec = importlib.util.spec_from_loader('wc_u007', loader)
    m = importlib.util.module_from_spec(spec)
    loader.exec_module(m)
    return m


def make_db(path, with_tickets, rows=()):
    c = sqlite3.connect(path)
    try:
        c.executescript("""
          CREATE TABLE projects(key TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL,
            repo_id TEXT, status TEXT NOT NULL DEFAULT 'unknown', summary TEXT, updated_at TEXT NOT NULL);
          CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, project_key TEXT,
            node_id TEXT, event_type TEXT NOT NULL, source TEXT, detail TEXT);
        """)
        if with_tickets:
            c.execute("""CREATE TABLE tickets(ticket_id TEXT PRIMARY KEY, title TEXT,
              state TEXT, deps TEXT, lease_owner TEXT, refs TEXT, outcome TEXT, updated_at TEXT)""")
            c.executemany("INSERT INTO tickets(ticket_id,title,state) VALUES(?,?,?)", rows)
        c.commit()
    finally:
        c.close()

def read_jsonl(path):
    if not os.path.exists(path):
        return []
    raw = open(path, encoding='utf-8').read()
    if not raw:
        return []
    assert raw.endswith('\n'), f'文件不以换行结尾(半行撕裂): {raw[-80:]!r}'
    return [json.loads(l) for l in raw.split('\n') if l]


CHILD_LOOP = '''
import importlib.machinery, importlib.util, sys
loader = importlib.machinery.SourceFileLoader('wc_c', sys.argv[1])
spec = importlib.util.spec_from_loader('wc_c', loader)
m = importlib.util.module_from_spec(spec)
loader.exec_module(m)
for i in range(int(sys.argv[2])):
    m.append_checkpoint(sys.argv[3], wave='WK', notes='child', collect_env=False)
print('done')
'''


def spawn_child(db, script, n, path):
    return subprocess.Popen([sys.executable, '-c', CHILD_LOOP, script, str(n), path],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                            env={**os.environ, 'MAESTRO_LEDGER': db})


# ── 验收①②基础:追加/字段/round 连续/dry-run ─────────────────────────────

@case
def C1_追加字段与round连续(tmp):
    compile(open(SCRIPT, encoding='utf-8').read(), SCRIPT, 'exec')
    m = load_module()
    assert m.DEFAULT_FILE == os.path.join(HERE, 'state', 'wave-checkpoints.jsonl'), m.DEFAULT_FILE
    db = os.path.join(tmp, 'c1.db')
    make_db(db, with_tickets=False)
    f = os.path.join(tmp, 'cp.jsonl')
    r = run(db, '--file', f, '--wave', 'W6', '--notes', 'OF-005 merged b013d64')
    assert 'round=1' in r.stdout and f in r.stdout and 'tickets=0' in r.stdout, r.stdout
    rec = read_jsonl(f)[0]
    assert list(rec) == ['round', 'ts', 'wave', 'tickets', 'git', 'env', 'notes'], list(rec)
    assert rec['round'] == 1 and rec['wave'] == 'W6' and rec['notes'] == 'OF-005 merged b013d64'
    assert rec['tickets'] == []
    assert isinstance(rec['git'], dict) and rec['git']['head'] and len(rec['git']['head']) >= 7, rec['git']
    assert set(rec['env']) == {'dais', 'orca'}, rec['env']
    datetime.fromisoformat(rec['ts'])  # ts 可解析
    r = run(db, '--file', f, '--wave', 'W6')           # 第二次 → round=2
    assert 'round=2' in r.stdout
    r = run(db, '--file', f, '--dry-run', '--wave', 'W6')  # dry-run:打印 round=3 但不落盘
    assert 'round=3' in r.stdout and '(dry-run)' in r.stdout
    assert len(read_jsonl(f)) == 2, 'dry-run 不得写文件'
    run(db, '--file', f, '--wave', 'W6')               # dry-run 不占 round → 仍 round=3
    assert [x['round'] for x in read_jsonl(f)] == [1, 2, 3]

# ── 验收②:--tail 1 重建视图(id/state/git head 三字段齐全) ────────────────

@case
def C2_tail重建视图(tmp):
    db = os.path.join(tmp, 'c2.db')
    make_db(db, with_tickets=True,
            rows=[('OF-001', '信封 v2', 'done'), ('OF-005', 'DAG', 'merged'), ('OF-007', 'checkpoint', 'running')])
    f = os.path.join(tmp, 'cp.jsonl')
    run(db, '--file', f, '--wave', 'W6')
    run(db, '--file', f, '--wave', 'W6')
    r = run(db, '--tail', '1', '--file', f)
    assert r.stdout.count('\n') == 1, r.stdout
    rec = json.loads(r.stdout.strip())
    assert rec['round'] == 2
    tix = {t['id']: t['state'] for t in rec['tickets']}
    assert tix == {'OF-001': 'done', 'OF-005': 'merged', 'OF-007': 'running'}, tix
    for t in rec['tickets']:
        assert set(t) == {'id', 'state'}, t
    assert rec['git']['head'], 'git head 三字段之一缺失'
    r = run(db, '--tail', '2', '--file', f)
    assert [json.loads(l)['round'] for l in r.stdout.strip().split('\n')] == [1, 2]
    r = run(db, '--tail', '99', '--file', f)           # 超行数 → 全部
    assert len(r.stdout.strip().split('\n')) == 2

# ── 验收③:round 跳号 WARN(stdout 干净,stderr 有 WARN) ───────────────────

@case
def C3_跳号WARN(tmp):
    db = os.path.join(tmp, 'c3.db')
    make_db(db, with_tickets=False)
    f = os.path.join(tmp, 'cp.jsonl')
    run(db, '--file', f, '--wave', 'W6')               # round=1
    r = run(db, '--file', f, '--round', '2', '--wave', 'W6')  # 连续显式 round → 无 WARN
    assert 'WARN' not in r.stderr and 'round=2' in r.stdout
    r = run(db, '--file', f, '--round', '9', '--wave', 'W6')  # 跳号 → WARN
    assert 'WARN' not in r.stdout, r.stdout            # stdout 干净
    assert 'WARN round 跳号' in r.stderr and 'last=2' in r.stderr and '预期 3' in r.stderr, r.stderr
    assert 'round=9' in r.stdout
    r = run(db, '--file', f, '--round', '1', '--wave', 'W6')  # 回退同样告警
    assert 'WARN round 跳号' in r.stderr
    run(db, '--file', f, '--wave', 'W6')               # 自动续 = 末行 round+1 → 2
    assert [x['round'] for x in read_jsonl(f)] == [1, 2, 9, 1, 2]
    r = run(db, '--tail', '1', '--file', f, '--dry-run', check=False)  # tail 与追加互斥
    assert r.returncode != 0

# ── 验收④:无 tickets 表旧库容错 ────────────────────────────────────────

@case
def C4_无tickets表旧库容错(tmp):
    f = os.path.join(tmp, 'cp.jsonl')
    db_old = os.path.join(tmp, 'old.db')               # 旧 schema(projects/events,无 tickets)
    make_db(db_old, with_tickets=False)
    r = run(db_old, '--file', f, '--wave', 'W6')
    assert 'tickets=0' in r.stdout and json.loads(open(f, encoding='utf-8').read())['tickets'] == []
    sqlite3.connect(db_old).close()
    f2 = os.path.join(tmp, 'cp2.jsonl')
    db_empty = os.path.join(tmp, 'empty.db')           # 全空库(连旧表都没有)
    sqlite3.connect(db_empty).close()
    r = run(db_empty, '--file', f2, '--wave', 'W6')
    assert r.returncode == 0 and 'tickets=0' in r.stdout
    assert read_jsonl(f2)[0]['tickets'] == []

# ── 验收①:kill -9 原子性 ──────────────────────────────────────────────

@case
def C5_kill9原子性(tmp):
    db = os.path.join(tmp, 'c5.db')
    make_db(db, with_tickets=False)
    # A: 灌 500 行,全完整且 round 1..500 连续
    fA = os.path.join(tmp, 'fill.jsonl')
    p = spawn_child(db, SCRIPT, 500, fA)
    assert p.wait(timeout=120) == 0, p.stderr.read()
    recs = read_jsonl(fA)
    assert len(recs) == 500, len(recs)
    assert [x['round'] for x in recs] == list(range(1, 501))
    # B: 写入中 kill -9 ×3,文件无半行
    random.seed(20260823)
    for i, delay in enumerate((0.08, 0.2, 0.35)):
        fB = os.path.join(tmp, f'kill{i}.jsonl')
        p = spawn_child(db, SCRIPT, 500, fB)
        time.sleep(delay)
        if p.poll() is None:
            p.kill()                                    # SIGKILL,写入中途
        p.wait()
        recs = read_jsonl(fB)                           # 断言:每行完整 JSON,无半行
        assert 0 <= len(recs) <= 500
        if recs:
            assert [x['round'] for x in recs] == list(range(1, len(recs) + 1))
        # kill 后真实 CLI 追加,round 从最后完整行续
        r = run(db, '--file', fB, '--wave', 'W6')
        last = read_jsonl(fB)[-1]
        assert f'round={len(recs) + 1}' in r.stdout and last['round'] == len(recs) + 1, (r.stdout, last['round'])


def main():
    print(f'OF-007 selftest · script={SCRIPT} · python={sys.version.split()[0]}')
    tmproot = tempfile.mkdtemp(prefix='of007-selftest-')
    try:
        for fn in CASES:
            d = tempfile.mkdtemp(dir=tmproot)
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
        import shutil
        shutil.rmtree(tmproot, ignore_errors=True)
    total = len(CASES)
    if FAILS:
        print(f'OF-007 selftest: {total - len(FAILS)}/{total} 绿,失败: {", ".join(FAILS)}')
        sys.exit(1)
    print(f'OF-007 selftest: {total}/{total} 全绿(exit 0)')
    sys.exit(0)


if __name__ == '__main__':
    main()
