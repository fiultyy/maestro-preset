#!/usr/bin/env python3
"""OF-002 selftest — fleet 属主租约(claim/heartbeat/release) + session-send steer 闸 + sweep(D-07)

覆盖验收 ①–⑤(docs/kg/09-orch-hardening-plan.md §3 OF-002):
  ① claim/heartbeat/release 原子读写(temp+rename+flock,并发双写不丢失不撕裂)
  ② owner 有效时非 owner steer 被拒(exit 4)且 fleet-conflicts.jsonl 落行(msgid/from/to/ts)
  ③ owner 本人/无主/已过期/直投 sessionId 四态放行(+steer-journal 审计行)
  ④ sweep dry-run 列表零写入;--apply 后条目 retired;时间戳缺失/非 active 不动
  ⑤ 任务型消息(done/ask/ack/report/ping/pong/nack)不受闸影响

域隔离: 合成 fleet + temp 目录;DSH 流量指向本地 stub HTTP server ——
零真实 DSH 流量,不触真实 fleet.json / 真实 sessionId / 真实 state。
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAESTRO = os.path.expanduser('~/.dsh/maestro')
SESSION_SEND = os.path.join(MAESTRO, 'bin', 'session-send')
FLEET_TOUCH = os.path.join(MAESTRO, 'bin', 'fleet-touch')

CHECKS = []


def check(name, ok, detail=''):
    CHECKS.append((name, bool(ok), detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f' — {detail}' if detail else ''))
    return bool(ok)


class StubHandler(BaseHTTPRequestHandler):
    records = []

    def do_POST(self):
        n = int(self.headers.get('content-length', 0))
        body = json.loads(self.rfile.read(n))
        StubHandler.records.append(body)
        resp = json.dumps({'result': {'ok': True, 'value': {'accepted': True}}}).encode()
        self.send_response(200)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(resp)))
        self.end_headers()
        self.wfile.write(resp)

    def log_message(self, *a):
        pass


def run(bin_path, args, env):
    return subprocess.run([bin_path] + list(args), env=env, capture_output=True,
                          text=True, timeout=120)


def spawn(bin_path, args, env):
    return subprocess.Popen([bin_path] + list(args), env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)


NOW = datetime.now(timezone.utc)


def iso(dt):
    return dt.isoformat(timespec='seconds')


STALE = iso(NOW - timedelta(days=10))
FRESH = iso(NOW - timedelta(hours=1))
OLD2 = iso(NOW - timedelta(days=20))


def sid(code):
    return f'session-{code}aaa1-1111-4111-8111-{code}aaa1111111'


def base_fleet(port):
    def ent(code, **kw):
        base = {'sessionId': sid(code), 'role': 'worker', 'node': 'n1', 'preset': 'code',
                'spawnedAt': OLD2, 'status': 'active'}
        base.update(kw)
        return base

    return {
        'port': port,
        'defaultWorkspaceId': 'ws-of002',
        'fleet': {
            'aa11': ent('aa11', lastSeenAt=FRESH),
            'tgt1': ent('tgt1', lastSeenAt=FRESH),
            'free2': ent('free2', lastSeenAt=FRESH),
            'exp3': ent('exp3', lastSeenAt=FRESH),
            'intr9': ent('intr9', lastSeenAt=FRESH),
            'ownr1': ent('ownr1', lastSeenAt=FRESH),
            'h001': ent('h001', lastSeenAt=FRESH),
            'r001': ent('r001', lastSeenAt=FRESH),
            'stl1': ent('stl1', lastSeenAt=STALE),
            'stl2': ent('stl2', lastSeenAt=STALE, heartbeatAt=iso(NOW - timedelta(days=9))),
            'frsh': ent('frsh', lastSeenAt=FRESH, heartbeatAt=iso(NOW - timedelta(minutes=5))),
            'nots': ent('nots'),  # active 但无时间戳 → sweep 保守跳过
            'gon9': ent('gon9', lastSeenAt=STALE, status='retired'),
            'term_x': {'kind': 'orca-terminal', 'handle': 'term_x', 'status': 'verified',
                       'lastSeenAt': STALE, 'alias': 'stub'},
            **{c: ent(c, lastSeenAt=FRESH) for c in ('c001', 'c002', 'c003', 'c004')},
        },
    }


def main():
    tmp = tempfile.mkdtemp(prefix='of002-selftest-')
    srv = ThreadingHTTPServer(('127.0.0.1', 0), StubHandler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    port = srv.server_address[1]
    fleet_path = os.path.join(tmp, 'fleet.json')
    json.dump(base_fleet(port), open(fleet_path, 'w'))
    env = dict(os.environ, DSH_PORT=str(port), MAESTRO_FLEET=fleet_path,
               MAESTRO_STATE=os.path.join(tmp, 'state'))
    conflicts = os.path.join(tmp, 'fleet-conflicts.jsonl')
    journal = os.path.join(tmp, 'state', 'steer-journal.jsonl')

    def read_fleet():
        return json.load(open(fleet_path))

    def write_fleet(d):
        json.dump(d, open(fleet_path, 'w'))

    def jlines(path):
        try:
            return [json.loads(l) for l in open(path, encoding='utf-8') if l.strip()]
        except FileNotFoundError:
            return []

    def sha(path):
        return hashlib.sha256(open(path, 'rb').read()).hexdigest()

    def sent_n():
        return len(StubHandler.records)

    try:
        print('① claim/heartbeat/release 原子读写(temp+rename+flock,并发不丢不撕):')
        r = run(FLEET_TOUCH, ['claim', 'tgt1', '--owner', 'ownr1', '--ttl-min', '30',
                              '--fleet', fleet_path], env)
        check('claim rc0', r.returncode == 0, r.stderr.strip() or r.stdout.strip())
        e = read_fleet()['fleet']['tgt1']
        delta_min = (datetime.fromisoformat(e['leaseExpiresAt'])
                     - datetime.now(timezone.utc)).total_seconds() / 60
        check('claim 写齐 owner/leaseExpiresAt/heartbeatAt(+leaseTtlMin)',
              e.get('owner') == 'ownr1' and bool(e.get('heartbeatAt'))
              and e.get('leaseTtlMin') == 30 and 25 < delta_min < 35,
              f'expires in {delta_min:.1f}min')

        r = run(FLEET_TOUCH, ['claim', 'tgt1', '--owner', 'intr9', '--ttl-min', '5',
                              '--fleet', fleet_path], env)
        check('他人有效租约 claim → rc1 拒绝且键不变',
              r.returncode == 1 and read_fleet()['fleet']['tgt1']['owner'] == 'ownr1',
              r.stderr.strip())

        r = run(FLEET_TOUCH, ['heartbeat', 'h001', '--fleet', fleet_path], env)
        check('heartbeat 无租约 → rc1', r.returncode == 1, r.stderr.strip())
        run(FLEET_TOUCH, ['claim', 'h001', '--owner', 'ownr1', '--ttl-min', '10',
                          '--fleet', fleet_path], env)
        h0 = read_fleet()['fleet']['h001']
        exp0, hb0 = datetime.fromisoformat(h0['leaseExpiresAt']), h0['heartbeatAt']
        time.sleep(1.2)
        r = run(FLEET_TOUCH, ['heartbeat', 'h001', '--fleet', fleet_path], env)
        h1 = read_fleet()['fleet']['h001']
        check('heartbeat 续期(leaseExpiresAt 前移,heartbeatAt 刷新)',
              r.returncode == 0
              and datetime.fromisoformat(h1['leaseExpiresAt']) > exp0
              and h1['heartbeatAt'] > hb0, r.stdout.strip())

        r = run(FLEET_TOUCH, ['release', 'tgt1', '--fleet', fleet_path], env)
        keys_gone = all(k not in read_fleet()['fleet']['tgt1']
                        for k in ('owner', 'leaseExpiresAt', 'heartbeatAt', 'leaseTtlMin'))
        check('release 清四键', r.returncode == 0 and keys_gone, r.stdout.strip())
        r = run(FLEET_TOUCH, ['release', 'tgt1', '--fleet', fleet_path], env)
        check('release 幂等(rc0)', r.returncode == 0, r.stdout.strip())

        run(FLEET_TOUCH, ['claim', 'exp3', '--owner', 'ownr2', '--ttl-min', '30',
                          '--fleet', fleet_path], env)
        d = read_fleet()
        d['fleet']['exp3']['leaseExpiresAt'] = iso(NOW - timedelta(minutes=1))
        write_fleet(d)
        r = run(FLEET_TOUCH, ['claim', 'exp3', '--owner', 'intr9', '--ttl-min', '5',
                              '--fleet', fleet_path], env)
        check('过期租约可被接管(claim takeover)',
              r.returncode == 0 and read_fleet()['fleet']['exp3']['owner'] == 'intr9',
              r.stdout.strip())

        # 并发双写 wave: 4 claim + 2 heartbeat + 1 release + 2 touch + 1 heartbeat 同刻
        run(FLEET_TOUCH, ['claim', 'r001', '--owner', 'w9', '--ttl-min', '15',
                          '--fleet', fleet_path], env)
        torn = {'fails': 0, 'iters': 0}
        stop = threading.Event()

        def reader():
            while not stop.is_set():
                try:
                    json.load(open(fleet_path))
                except Exception:
                    torn['fails'] += 1
                torn['iters'] += 1

        rt = threading.Thread(target=reader)
        rt.start()
        procs = []
        for c, o in (('c001', 'w1'), ('c002', 'w2'), ('c003', 'w3'), ('c004', 'w4')):
            procs.append(spawn(FLEET_TOUCH, ['claim', c, '--owner', o, '--ttl-min', '15',
                                             '--fleet', fleet_path], env))
        procs.append(spawn(FLEET_TOUCH, ['heartbeat', 'h001', '--fleet', fleet_path], env))
        procs.append(spawn(FLEET_TOUCH, ['heartbeat', 'h001', '--fleet', fleet_path], env))
        procs.append(spawn(FLEET_TOUCH, ['heartbeat', 'exp3', '--fleet', fleet_path], env))
        procs.append(spawn(FLEET_TOUCH, ['release', 'r001', '--fleet', fleet_path], env))
        procs.append(spawn(FLEET_TOUCH, ['aa11', '--fleet', fleet_path], env))
        procs.append(spawn(FLEET_TOUCH, ['free2', '--fleet', fleet_path], env))
        outs = [p.communicate(timeout=90) for p in procs]
        rcs = [p.returncode for p in procs]
        stop.set()
        rt.join()
        check('并发 10 写全部 rc0', all(rc == 0 for rc in rcs), str(rcs))
        f = read_fleet()['fleet']
        check('并发 claim 四键全落地(读-改-写不丢失)',
              all(f[c]['owner'] == o for c, o in
                  (('c001', 'w1'), ('c002', 'w2'), ('c003', 'w3'), ('c004', 'w4'))),
              json.dumps({c: f[c].get('owner') for c in ('c001', 'c002', 'c003', 'c004')}))
        check('并发 release/heartbeat 与 touch 互不覆盖',
              'owner' not in f['r001'] and f['h001']['owner'] == 'ownr1'
              and 'heartbeatAt' in f['exp3'], json.dumps(
                  {'r001': 'owner' not in f['r001'], 'h001': f['h001'].get('owner'),
                   'exp3': 'heartbeatAt' in f['exp3']}))
        check(f'并发期间读者循环 JSON 恒可解析({torn["iters"]} reads)',
              torn['fails'] == 0, f'fails={torn["fails"]}')
        junk = [n for n in os.listdir(tmp) if n.startswith('.fleet-touch-')]
        check('无 .fleet-touch- 临时残留', not junk, str(junk))
        r = run(FLEET_TOUCH, ['aa11', '--fleet', fleet_path], env)
        check('旧路径 touch 输出格式不变(OG1)',
              r.returncode == 0 and r.stdout.startswith('touched aa11: lastSeenAt=')
              and 'status unchanged' in r.stdout, r.stdout.strip())

        print('② owner 有效 + 非 owner steer → 拒(exit 4)+冲突行:')
        run(FLEET_TOUCH, ['claim', 'tgt1', '--owner', 'ownr1', '--ttl-min', '30',
                          '--fleet', fleet_path], env)
        n0 = sent_n()
        r = run(SESSION_SEND, ['intr9', 'tgt1', 'steer', 't1', 'do-x'], env)
        check('exit 4 拒绝', r.returncode == 4, f'rc={r.returncode}')
        check('消息未发出(stub 零新增)', sent_n() == n0)
        check('stderr 标注 REFUSED/属主', 'REFUSED' in r.stderr and 'ownr1' in r.stderr,
              r.stderr.strip())
        lines = jlines(conflicts)
        check('fleet-conflicts.jsonl 落行,键恰=msgid/from/to/ts',
              len(lines) == 1 and set(lines[0]) == {'msgid', 'from', 'to', 'ts'}
              and lines[0]['from'] == 'intr9' and lines[0]['to'] == 'tgt1'
              and len(uuid.UUID(lines[0]['msgid']).hex) == 32
              and isinstance(lines[0]['ts'], int), json.dumps(lines[0]))
        r = run(SESSION_SEND, ['intr9', 'tgt1', 'steer', 't1', 'retry-x'], env)
        check('二次 steer 再拒,冲突行累计 2 且 msgid 各异',
              r.returncode == 4 and len(jlines(conflicts)) == 2
              and jlines(conflicts)[0]['msgid'] != jlines(conflicts)[1]['msgid'])

        print('③ 三态放行(owner 本人/无主/过期/直投):')
        r = run(SESSION_SEND, ['ownr1', 'tgt1', 'steer', 't2', 'self-x'], env)
        check('owner 本人 steer 放行 rc0', r.returncode == 0 and sent_n() == n0 + 1)
        check('journal 行 reason=owner-self',
              jlines(journal)[-1].get('reason') == 'owner-self'
              and jlines(journal)[-1].get('from') == 'ownr1', json.dumps(jlines(journal)[-1]))
        r = run(SESSION_SEND, ['intr9', 'free2', 'steer', 't3', 'free-x'], env)
        check('无主 steer 放行(reason=unowned)',
              r.returncode == 0 and jlines(journal)[-1]['reason'] == 'unowned')
        d = read_fleet()
        d['fleet']['exp3']['leaseExpiresAt'] = iso(NOW - timedelta(minutes=2))
        write_fleet(d)
        r = run(SESSION_SEND, ['ownr1', 'exp3', 'steer', 't4', 'exp-x'], env)
        check('过期租约 steer 放行(reason=lease-expired)',
              r.returncode == 0 and jlines(journal)[-1]['reason'] == 'lease-expired')
        r = run(SESSION_SEND, ['intr9', sid('zz99'), 'steer', 't5', 'direct-x'], env)
        check('直投 sessionId(无 fleet 条目)放行(reason=no-entry)',
              r.returncode == 0 and jlines(journal)[-1]['reason'] == 'no-entry')
        jl = jlines(journal)
        check('journal 行键齐(msgid/from/to/ts/reason)且四 reason 各一行',
              all(set(l) == {'msgid', 'from', 'to', 'ts', 'reason'} for l in jl)
              and sorted(l['reason'] for l in jl) ==
              ['lease-expired', 'no-entry', 'owner-self', 'unowned'])

        print('④ sweep dry-run/apply(D-07):')
        sha_before = sha(fleet_path)
        r = run(FLEET_TOUCH, ['sweep', '--days', '7', '--fleet', fleet_path], env)
        check('dry-run 列出 stl1/stl2 且零写入(sha 不变)',
              r.returncode == 0 and 'stl1' in r.stdout and 'stl2' in r.stdout
              and '[dry-run]' in r.stdout and sha(fleet_path) == sha_before,
              ' | '.join(r.stdout.strip().splitlines()))
        r = run(FLEET_TOUCH, ['sweep', '--days', '7', '--apply', '--fleet', fleet_path], env)
        f = read_fleet()['fleet']
        check('--apply 后 stl1/stl2 retired',
              r.returncode == 0 and f['stl1']['status'] == 'retired'
              and f['stl2']['status'] == 'retired', r.stdout.strip().splitlines()[-1])
        check('frsh(新鲜)/nots(无时间戳)/term_x(非 active)/gon9(已 retired)不动',
              f['frsh']['status'] == 'active' and f['nots']['status'] == 'active'
              and f['term_x']['status'] == 'verified' and f['gon9']['status'] == 'retired')
        r = run(FLEET_TOUCH, ['sweep', '--days', '7', '--fleet', fleet_path], env)
        check('apply 后 dry-run 0 候选', r.returncode == 0 and '0 candidate' in r.stdout,
              r.stdout.strip().splitlines()[-1])

        print('⑤ 任务型消息不受闸影响(有效他人租约在场):')
        c0, j0, n0 = len(jlines(conflicts)), len(jlines(journal)), sent_n()
        rcs = [run(SESSION_SEND, ['intr9', 'tgt1', t, 'r9', f'body-{t}'], env).returncode
               for t in ('done', 'ask', 'ack', 'report', 'ping', 'pong', 'nack')]
        check('七类型经有主目标全放行 rc0', rcs == [0] * 7, str(rcs))
        check('全部送达 stub(7 封)', sent_n() == n0 + 7)
        check('conflicts/journal 不随任务型增长',
              len(jlines(conflicts)) == c0 and len(jlines(journal)) == j0)
        run(FLEET_TOUCH, ['release', 'tgt1', '--fleet', fleet_path], env)
        r = run(SESSION_SEND, ['intr9', 'tgt1', 'steer', 't9', 'post-release'], env)
        check('闭环: release 后同 sender steer 放行(reason=unowned)',
              r.returncode == 0 and jlines(journal)[-1]['reason'] == 'unowned')

        n_pass = sum(1 for _, ok, _ in CHECKS if ok)
        print(f'\nOF-002 selftest: {n_pass}/{len(CHECKS)} 全绿'
              + ('' if n_pass == len(CHECKS) else ' — 存在失败'))
        return 0 if n_pass == len(CHECKS) else 1
    finally:
        srv.shutdown()
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    sys.exit(main())
