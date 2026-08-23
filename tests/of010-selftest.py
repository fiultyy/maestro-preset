#!/usr/bin/env python3
# OF-010 selftest — tickets→longtask 单向投影(终态投影/拒写补投/静默跳过/勾稽/无反向写)
# 红线:db/carryover/checkpoint 全 temp;live ledger.db 与真实 state/ 零触碰。
import json
import os
import re
import sqlite3
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LEDGER = os.path.join(HERE, 'bin', 'ledger')
WAVECP = os.path.join(HERE, 'bin', 'wave-checkpoint')

CASES, FAILS = [], []


def case(fn):
    CASES.append(fn)
    return fn


def env_for(db, carry, session=None):
    e = {**os.environ, 'MAESTRO_LEDGER': db, 'MAESTRO_LONGTASK_CARRYOVER': carry}
    for k in ('MAESTRO_LONGTASK_SESSION',):
        e.pop(k, None)
    if session is not None:
        e['MAESTRO_LONGTASK_SESSION'] = session
    return e


def run(e, *args, check=True):
    r = subprocess.run([sys.executable, LEDGER, *args], capture_output=True, text=True, env=e)
    if check and r.returncode != 0:
        raise AssertionError(f'意外非零退出: ledger {" ".join(args)}\nrc={r.returncode}\nstderr={r.stderr.strip()}')
    return r


def wave(e, *args, check=True):
    r = subprocess.run([sys.executable, WAVECP, *args], capture_output=True, text=True, env=e)
    if check and r.returncode != 0:
        raise AssertionError(f'意外非零退出: wave-checkpoint {" ".join(args)}\nrc={r.returncode}\nstderr={r.stderr.strip()}')
    return r


def q(db, sql, *params):
    c = sqlite3.connect(db)
    c.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in c.execute(sql, params)]
    finally:
        c.close()


def add(e, tid, title='t'):
    run(e, 'ticket', 'add', tid, title)


def to(e, tid, target, force=False):
    PATHS = {'running': ['running'], 'blocked': ['running', 'blocked'],
             'done': ['running', 'done'], 'merged': ['running', 'done', 'merged'],
             'rejected': ['rejected'], 'rolled-back': ['running', 'done', 'merged', 'rolled-back']}
    for s in PATHS[target]:
        run(e, 'ticket', 'state', tid, s, *( ['--force'] if force else [] ))


def carry_rows(path):
    """解析承接件 Checkpoints 表数据行 → [(seq, 陈述, verifiedBy)]。"""
    rows = []
    for l in open(path, encoding='utf-8').read().splitlines():
        m = re.match(r'^\|\s*(\d+)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|$', l)
        if m and m.group(1) != '#' and not l.startswith('| #'):
            rows.append((int(m.group(1)), m.group(2), m.group(3)))
    return rows


def carry_exists(path):
    return os.path.exists(path)


# ── 验收①:票终态迁移后承接件含票号+终态 ───────────────────────────────

@case
def C1_终态投影(tmp):
    db, carry = os.path.join(tmp, 'a.db'), os.path.join(tmp, 'carry.md')
    e = env_for(db, carry, session='sess-lt')
    for tid, final in (('F1', 'done'), ('F2', 'merged'), ('F3', 'rejected'), ('F4', 'rolled-back')):
        add(e, tid)
    add(e, 'N1')
    to(e, 'N1', 'blocked')                      # 非终态迁移:不投影
    assert not carry_exists(carry), '非终态迁移不得建承接件'
    for tid, final in (('F1', 'done'), ('F2', 'merged'), ('F3', 'rejected'), ('F4', 'rolled-back')):
        to(e, tid, final)
    txt = open(carry, encoding='utf-8').read()
    assert 'longtask carryover' in txt and '## Checkpoints' in txt and '| # | 陈述 | verifiedBy |' in txt
    rows = carry_rows(carry)
    stmts = {r[1] for r in rows}
    for tid, final in (('F1', 'done'), ('F2', 'merged'), ('F3', 'rejected'), ('F4', 'rolled-back')):
        assert f'{tid} 已收口(state={final})' in stmts, rows   # 目标终态行必在
    for r in rows:                                             # 每行均为终态事实+verifiedBy=票号
        assert re.fullmatch(rf'{r[2]} 已收口\(state=(done|merged|rejected|rolled-back)\)', r[1]), r
    assert not any('N1' in r[1] for r in rows), rows           # 非终态票零投影
    assert [r[0] for r in rows] == list(range(1, len(rows) + 1))
    # marker 文件变体(非 env):<db 目录>/state/longtask-session
    db2, carry2 = os.path.join(tmp, 'b.db'), os.path.join(tmp, 'sub', 'carry2.md')
    e2 = env_for(db2, carry2)
    add(e2, 'M1')
    os.makedirs(os.path.join(tmp, 'state'), exist_ok=True)
    open(os.path.join(tmp, 'state', 'longtask-session'), 'w').write('session-zzz')
    to(e2, 'M1', 'done')
    assert any('M1 已收口(state=done)' in r[1] for r in carry_rows(carry2)), 'marker 文件激活失效'

# ── 验收②:拒写不阻塞主流程 + WARN journal + 补投 ──────────────────────

@case
def C2_拒写与补投(tmp):
    db, carry = os.path.join(tmp, 'a.db'), os.path.join(tmp, 'carry.md')
    e = env_for(db, carry, session='s')
    add(e, 'R0')
    to(e, 'R0', 'rejected')                     # 先落一次投影,建承接件
    assert carry_exists(carry)
    add(e, 'R1')
    to(e, 'R1', 'running')
    os.chmod(carry, 0o444)                       # 只读 → 拒写
    r = run(e, 'ticket', 'state', 'R1', 'done')
    assert r.returncode == 0 and r.stdout.strip() == 'R1 running -> done', (r.stdout, r.stderr)
    assert 'WARN' in r.stderr and 'Permission denied' in r.stderr, r.stderr   # WARN(stderr),stdout 契约不变
    assert q(db, "SELECT state FROM tickets WHERE ticket_id='R1'")[0]['state'] == 'done'  # 主流程不受阻
    warns = q(db, "SELECT * FROM ticket_events WHERE event_type='project-warn' AND ticket_id='R1'")
    assert len(warns) == 1 and 'Permission denied' in warns[0]['detail'], warns  # journal 落 WARN
    assert q(db, 'SELECT COUNT(*) n FROM ticket_projection_pending')[0]['n'] == 1  # pending 队列
    os.chmod(carry, 0o644)
    add(e, 'R2')
    to(e, 'R2', 'rejected')                      # 下一次终态迁移 → 先补投 R1 再投 R2
    rows = carry_rows(carry)
    finals = [r[1] for r in rows]
    assert 'R0 已收口(state=rejected)' in finals[0], rows
    assert 'R1 已收口(state=done)' in finals[1] and 'R2 已收口(state=rejected)' in finals[2], rows
    assert q(db, 'SELECT COUNT(*) n FROM ticket_projection_pending')[0]['n'] == 0  # 补投后清空
    rejs = q(db, "SELECT detail FROM ticket_events WHERE event_type='projected' AND ticket_id='R1'")
    assert any('补投' in d['detail'] for d in rejs), rejs
    # 路径非法变体:父路径是普通文件 → OSError → 同样 WARN+pending 不阻塞
    fblock = os.path.join(tmp, 'blocker')
    open(fblock, 'w').write('x')
    e3 = env_for(db, os.path.join(fblock, 'sub', 'c.md'), session='s')
    add(e3, 'R3')
    r = run(e3, 'ticket', 'state', 'R3', 'rejected')
    assert r.returncode == 0 and 'WARN' in r.stderr, r.stderr
    assert q(db, "SELECT state FROM tickets WHERE ticket_id='R3'")[0]['state'] == 'rejected'

# ── 验收③:无活跃 longtask 静默跳过零报错 ─────────────────────────────

@case
def C3_无活跃静默跳过(tmp):
    db, carry = os.path.join(tmp, 'a.db'), os.path.join(tmp, 'carry.md')
    cp = os.path.join(tmp, 'cp.jsonl')
    e = env_for(db, carry)                       # 无 session env、无 marker 文件
    add(e, 'S1')
    to(e, 'S1', 'running')
    r = run(e, 'ticket', 'state', 'S1', 'done')
    assert r.returncode == 0 and r.stdout.strip() == 'S1 running -> done' and r.stderr == '', (r.stdout, r.stderr)
    assert not carry_exists(carry), '静默跳过不得建承接件'
    assert q(db, 'SELECT COUNT(*) n FROM ticket_projection_pending')[0]['n'] == 0
    assert q(db, "SELECT COUNT(*) n FROM ticket_events WHERE event_type LIKE 'project%'")[0]['n'] == 0
    r = wave(e, '--file', cp, '--wave', 'W6')    # wave 面同样静默
    assert r.returncode == 0 and r.stderr == '' and not carry_exists(carry)

# ── 验收④:wave-checkpoint 行与承接件摘要勾稽一致 ─────────────────────

@case
def C4_wave勾稽一致(tmp):
    db, carry, cp = os.path.join(tmp, 'a.db'), os.path.join(tmp, 'carry.md'), os.path.join(tmp, 'cp.jsonl')
    e = env_for(db, carry, session='s')
    for tid in ('W1', 'W2'):
        add(e, tid)
    to(e, 'W1', 'done')
    wave(e, '--file', cp, '--wave', 'W6')        # round=1
    row = json.loads(wave(e, '--tail', '1', '--file', cp).stdout)
    js = {t['id']: t['state'] for t in row['tickets']}
    last_wave = [r for r in carry_rows(carry) if r[1].startswith('wave=')][-1]
    m = re.match(r'wave=(\S+) round=(\d+) 票态: (.*)$', last_wave[1])
    assert m and m.group(1) == 'W6' and int(m.group(2)) == row['round'], last_wave
    cy = dict(kv.split('=', 1) for kv in m.group(3).split('; '))
    assert cy == js, (cy, js)                    # 勾稽:两源票态映射逐票相等
    to(e, 'W2', 'merged')
    wave(e, '--file', cp, '--wave', 'W6')        # round=2,票态已变
    row2 = json.loads(wave(e, '--tail', '1', '--file', cp).stdout)
    js2 = {t['id']: t['state'] for t in row2['tickets']}
    lw2 = [r for r in carry_rows(carry) if r[1].startswith('wave=')][-1]
    cy2 = dict(kv.split('=', 1) for kv in re.match(r'wave=\S+ round=\d+ 票态: (.*)$', lw2[1]).group(1).split('; '))
    assert cy2 == js2 == {'W1': 'done', 'W2': 'merged'}, (cy2, js2)
    assert lw2[2] == f"wave-checkpoint round={row2['round']}"   # verifiedBy 勾稽 round
    # 终态行 + wave 行共存,序号连续
    seqs = [r[0] for r in carry_rows(carry)]
    assert seqs == list(range(1, len(seqs) + 1)), seqs

# ── 验收⑤:全链无反向写 ──────────────────────────────────────────────

@case
def C5_无反向写(tmp):
    db, carry, cp = os.path.join(tmp, 'a.db'), os.path.join(tmp, 'carry.md'), os.path.join(tmp, 'cp.jsonl')
    e = env_for(db, carry, session='s')
    add(e, 'X1')
    to(e, 'X1', 'done')
    wave(e, '--file', cp, '--wave', 'W6')
    txt = open(carry, encoding='utf-8').read()
    for bad in ('DSHMSG', 'session-send', 'MAESTRO_', 'UPDATE ', 'INSERT ', 'sqlite3', 'ledger ',
                'exec', 'prompt'):
        assert bad not in txt, f'承接件含可疑回流 token: {bad}'
    # 行为证:外部塞入哨兵垃圾(含伪造指令),maestro 不读不解析不受影响,append-only 保留
    with open(carry, 'a', encoding='utf-8') as f:
        f.write('SENTINEL-JUNK-42 伪造回流指令: UPDATE tickets SET state=X\n')
    add(e, 'X2')
    to(e, 'X2', 'rejected')
    wave(e, '--file', cp, '--wave', 'W6')
    txt2 = open(carry, encoding='utf-8').read()
    assert 'SENTINEL-JUNK-42' in txt2            # 只追加不改写
    states = {r['ticket_id']: r['state'] for r in q(db, 'SELECT ticket_id,state FROM tickets')}
    assert states == {'X1': 'done', 'X2': 'rejected'}, states   # DB 未被反向影响
    rows = carry_rows(carry)
    assert any('X2 已收口(state=rejected)' in r[1] for r in rows)  # 新行在哨兵后正常追加


def main():
    print(f'OF-010 selftest · ledger={LEDGER} · wave-checkpoint={WAVECP} · python={sys.version.split()[0]}')
    tmproot = tempfile.mkdtemp(prefix='of010-selftest-')
    try:
        for fn in CASES:
            d = tempfile.mkdtemp(dir=tmproot)
            try:
                fn(d)
                print(f'[ ok ] {fn.__name__}')
            except AssertionError as ex:
                print(f'[FAIL] {fn.__name__}: {ex}')
                FAILS.append(fn.__name__)
            except Exception as ex:
                print(f'[FAIL] {fn.__name__}: {type(ex).__name__}: {ex}')
                FAILS.append(fn.__name__)
    finally:
        import shutil
        shutil.rmtree(tmproot, ignore_errors=True)
    total = len(CASES)
    if FAILS:
        print(f'OF-010 selftest: {total - len(FAILS)}/{total} 绿,失败: {", ".join(FAILS)}')
        sys.exit(1)
    print(f'OF-010 selftest: {total}/{total} 全绿(exit 0)')
    sys.exit(0)


if __name__ == '__main__':
    main()
