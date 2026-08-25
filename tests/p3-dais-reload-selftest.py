#!/usr/bin/env python3
"""tests/p3-dais-reload-selftest.py — T4 dais 重载修复沙箱验证(spec P3a;OF-005 基底)

全 temp 域(mktemp -d)/[ ok ][FAIL] 原子断言/幂等可重跑/句柄命名空间 nw-sbx-* 隔离。
沙箱机制(实证): XDG_STATE_HOME=$SBX/state 隔离 dais CLI 落库与 socket 快路;
A2A_DAIS_DB 指沙箱库隔离 reader;router 以 createRouter(桩 registry+journalPath)
进程内驱动,不启 daemon 不占端口;生产库仅只读快照(断言 12)。

用法: python3 tests/p3-dais-reload-selftest.py [--rollback-drill]
"""
import json
import os
import subprocess
import sys
import tempfile
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PROD_DB = Path.home() / '.local/state/dais/warp.sqlite'
DAIS_BIN = os.environ.get('A2A_DAIS_BIN', str(Path.home() / '.local/bin/dais'))

PASS = 0
FAIL = 0


def ok(cid):
    global PASS
    PASS += 1
    print(f'[ ok ] {cid}')


def bad(cid, detail):
    global FAIL
    FAIL += 1
    print(f'[FAIL] {cid}: {detail}')


def sql_ro(db, q, params=()):
    import sqlite3
    con = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
    try:
        return con.execute(q, params).fetchall()
    finally:
        con.close()


BRIDGE = '''
import { createRouter, DAIS_MESSAGE_TYPE } from %r
const [op, argRaw] = process.argv.slice(-2)
const arg = JSON.parse(argRaw)
const registry = { agents: async () => [
  { code: 'nw-sbx-orch', mailbox: 'nw-sbx-orch@session-x', project: 'nw' },
  { code: 'nw-sbx-w1', mailbox: 'nw-sbx-w1', project: 'nw' },
] }
const router = createRouter({ registry, journalPath: process.env.SBX_JOURNAL })
const main = async () => {
  if (op === 'send') return await router.send(arg)
  if (op === 'inbox') return await router.inbox(arg)
  if (op === 'parity') {
    const v = await import(%r)
    return Object.fromEntries(['notify', 'steer', 'ping'].map((t) =>
      [t, { inline: DAIS_MESSAGE_TYPE[t], lib: v.denormalizeType(t, 'dais') }]))
  }
  throw new Error('unknown op ' + op)
}
try {
  console.log(JSON.stringify({ ok: true, value: await main() }))
} catch (e) {
  console.log(JSON.stringify({ ok: false, rpcCode: e.rpcCode ?? null, message: String(e && e.message) }))
}
''' % (str(ROOT / 'plugins/a2a-profile-server/http-server.js'),
       str(ROOT / 'plugins/_narrow-waist/vocabulary.js'))


def bridge(env, op, arg):
    r = subprocess.run(
        ['node', '--input-type=module', '--eval', BRIDGE, '--', op, json.dumps(arg, ensure_ascii=False)],
        capture_output=True, text=True, env=env, cwd=str(ROOT), timeout=120)
    out = r.stdout.strip().splitlines()
    if not out:
        return {'ok': False, 'message': f'stdout empty stderr={r.stderr[-300:]!r}'}
    try:
        return json.loads(out[-1])
    except json.JSONDecodeError:
        return {'ok': False, 'message': f'unparseable stdout={out[-1][:200]!r}'}


def prod_snapshot():
    if not PROD_DB.exists():
        return (0, None)
    rows = sql_ro(PROD_DB, "SELECT COUNT(*) FROM messages WHERE from_handle LIKE 'nw-sbx-%' OR to_handle LIKE 'nw-sbx-%'")
    d = sql_ro(PROD_DB, "SELECT COUNT(*) FROM messages WHERE body LIKE 'DSHMSG]%'")
    return (rows[0][0], d[0][0])


def main():
    sbx = Path(tempfile.mkdtemp(prefix='nw-t4-sbx-'))
    journal = sbx / 'journal.jsonl'
    env = dict(os.environ)
    env['XDG_STATE_HOME'] = str(sbx / 'state')
    env['A2A_DAIS_DB'] = str(sbx / 'state/dais/warp.sqlite')
    env['SBX_JOURNAL'] = str(journal)
    sandbox_db = sbx / 'state/dais/warp.sqlite'

    # ---- 断言 12(前): 生产零接触基线 ----
    prod_before = prod_snapshot()
    if prod_before[0] != 0:
        print(f'refuse: 生产库已含 nw-sbx-* 句柄({prod_before[0]})')
        return 1

    # ---- 断言 1-3: 三型投递 ----
    bodies = {
        'notify': 'multi-line notify body\nsecond line\nthird line for heavy path' + 'x' * 300,
        'steer': 'multi-line steer body\nsecond line',
        'ping': 'multi-line ping body\nsecond line',
    }
    sent = {}
    for typ, body in bodies.items():
        res = bridge(env, 'send', {'from': 'nw-sbx-orch', 'to': 'nw-sbx-w1', 'type': typ,
                                   'ref': f'LB-{typ}', 'body': body})
        sent[typ] = (res, body)
    a1_errs = []
    for typ, (res, body) in sent.items():
        if not (res.get('ok') and res['value']['delivered'] == 'mailbox'):
            a1_errs.append(f'{typ}: {res}')
        elif '@' not in str(res['value'].get('ackRef', '')) or not any(c.isdigit() for c in str(res['value'].get('ackRef', ''))):
            a1_errs.append(f'{typ}: ackRef 无数字 seq: {res["value"].get("ackRef")}')
    jlines = [json.loads(l) for l in journal.read_text().splitlines()] if journal.exists() else []
    if sum(1 for j in jlines if j.get('delivered') == 'mailbox') != 3:
        a1_errs.append(f'journal mailbox 行数={sum(1 for j in jlines if j.get("delivered")=="mailbox")}≠3')
    if a1_errs:
        bad('1', '; '.join(a1_errs))
    else:
        ok('1')

    # ---- 断言 2/3: 落库 message_type 与 body 纯净化 ----
    rows = sql_ro(sandbox_db, 'SELECT message_type, subject, body FROM messages WHERE from_handle=? ORDER BY sequence',
                  ('nw-sbx-orch@session-x',))
    a2 = a3 = True
    for r in rows[:3]:
        if r[0] != 'status':
            a2 = False
    typed = {r[1]: r for r in rows}
    for typ, body in bodies.items():
        r = typed.get(f'[ref:LB-{typ}]')
        if r is None or r[2] != body or r[2].startswith('DSHMSG]') or '"from"' in r[2]:
            a3 = False
    ok(2) if a2 else bad('2', f'message_type 非 status: {[r[0] for r in rows]}')
    ok('3') if a3 else bad('3', 'body 非纯净/不相等')

    # ---- 断言 4: 拒收不变 ----
    res = bridge(env, 'send', {'from': 'nw-sbx-orch', 'to': 'nw-sbx-w1', 'type': 'direct',
                               'ref': 'x', 'body': 'b\nb'})
    if res.get('ok') is False and res.get('rpcCode') == -32602 and 'invalid type' in str(res.get('message', '')):
        ok('4')
    else:
        bad('4', str(res))

    # ---- 断言 5: parity ----
    res = bridge(env, 'parity', {})
    parity = res.get('value', {}) if res.get('ok') else {}
    if all(v['inline'] == v['lib'] for v in parity.values()) and len(parity) == 3:
        ok('5')
    else:
        bad('5', str(res))

    # ---- 断言 7/8: agents/inbox RPC + 新格式 ref ----
    res = bridge(env, 'inbox', {'mailbox': 'nw-sbx-w1'})
    if not res.get('ok'):
        bad('7', str(res))
    else:
        unread = res['value']['unread']
        if len(unread) >= 3:
            ok('7')
        else:
            bad('7', f'unread 行数 {len(unread)}')
    res8 = bridge(env, 'send', {'from': 'nw-sbx-orch', 'to': 'nw-sbx-w1', 'type': 'notify',
                                'ref': 'LB-002', 'body': 'assertion eight body\nline2'})
    unread8 = bridge(env, 'inbox', {'mailbox': 'nw-sbx-w1'}).get('value', {}).get('unread', [])
    m = [u for u in unread8 if u.get('subject') == '[ref:LB-002]']
    if res8.get('ok') and m and m[0].get('ref') == 'LB-002':
        ok('8')
    else:
        bad('8', f'res8={res8} match={m[:1]}')

    # ---- 断言 9: 旧格式兼容两形态(dais CLI 直投, subject='route') ----
    old_json = 'DSHMSG]{"from":"x","to":"y","ref":"legacy-ref","type":"notify","body":"hi"}'
    old_pref = '[ref:body-pref] hi'
    for body in (old_json, old_pref):
        subprocess.run([DAIS_BIN, 'orchestration', 'send-message', 'router',
                        'nw-sbx-orch@session-x', 'nw-sbx-w1', '--message-type', 'status',
                        '--subject', 'route', '--body', body],
                       capture_output=True, text=True, env=env, timeout=60, check=True)
    unread9 = bridge(env, 'inbox', {'mailbox': 'nw-sbx-w1'}).get('value', {}).get('unread', [])
    refs9 = {u.get('ref') for u in unread9}
    if 'legacy-ref' in refs9 and 'body-pref' in refs9:
        ok('9')
    else:
        bad('9', f'refs={refs9}')

    # ---- 断言 10: 路径静态断言 ----
    src = (ROOT / 'plugins/a2a-profile-server/http-server.js').read_text()
    if '.local/state/dais/warp.sqlite' in src and '.local/share/dais/data.sqlite' not in src:
        ok('10')
    else:
        bad('10', '缺省路径断言失败')

    # ---- 断言 11: subject 约束 ----
    r_def = bridge(env, 'send', {'from': 'nw-sbx-orch', 'to': 'nw-sbx-w1', 'type': 'ping', 'body': 'default ref\nbody'})
    r_nl = bridge(env, 'send', {'from': 'nw-sbx-orch', 'to': 'nw-sbx-w1', 'type': 'ping', 'ref': 'a\nb', 'body': 'nl ref\nbody'})
    r_big = bridge(env, 'send', {'from': 'nw-sbx-orch', 'to': 'nw-sbx-w1', 'type': 'ping', 'ref': 'x' * 300, 'body': 'big ref\nbody'})
    a11 = []
    if not r_def.get('ok'):
        a11.append(f'default rc: {r_def}')
    else:
        rows_def = sql_ro(sandbox_db, "SELECT subject FROM messages WHERE to_handle=? AND subject='[ref:-]'", ('nw-sbx-w1',))
        if not rows_def:
            a11.append('default ref subject != [ref:-]')
    if not r_nl.get('ok'):
        a11.append(f'nl rc: {r_nl}')
    else:
        nl_rows = sql_ro(sandbox_db, "SELECT subject FROM messages WHERE to_handle=? AND subject LIKE '%%a b%%'", ('nw-sbx-w1',))
        if not nl_rows or any('\n' in r[0] for r in nl_rows):
            a11.append('nl subject 含换行或缺失')
    if not r_big.get('ok'):
        a11.append(f'big rc: {r_big}')
    else:
        big_rows = sql_ro(sandbox_db, "SELECT subject FROM messages WHERE to_handle=? ORDER BY sequence DESC LIMIT 1", ('nw-sbx-w1',))
        if not big_rows or len(big_rows[0][0].encode('utf-8')) > 120:
            a11.append(f'big subject >120B: {big_rows[:1]}')
    ok('11') if not a11 else bad('11', '; '.join(a11))

    # ---- 断言 12(后): 生产零接触 ----
    prod_after = prod_snapshot()
    sbx_count = sql_ro(sandbox_db, "SELECT COUNT(*) FROM messages WHERE from_handle LIKE 'nw-sbx-%' OR to_handle LIKE 'nw-sbx-%'")[0][0]
    total_sent = 3 + 1 + 2 + 3  # 三型 + LB-002 + 旧格式×2 + 断言11×3
    if prod_after == prod_before and prod_after[0] == 0 and sbx_count == total_sent:
        ok('12')
    else:
        bad('12', f'prod {prod_before}→{prod_after} sbx_count={sbx_count}≠{total_sent}')

    print(f'\nSBX={sbx}')
    total = PASS + FAIL
    if FAIL == 0:
        print(f'p3-dais-reload-selftest: {total}/{total} 全绿(exit 0)')
        if '--keep' not in sys.argv:
            shutil.rmtree(sbx, ignore_errors=True)
        return 0
    print(f'p3-dais-reload-selftest: {PASS}/{total} 全绿(exit 1)')
    return 1


if __name__ == '__main__':
    sys.exit(main())
