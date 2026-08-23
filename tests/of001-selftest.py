#!/usr/bin/env python3
"""OF-001 selftest — DSHMSG 信封 v2:msgid+ts / msg-dedup 去重 / 窗口 GC / relay base 原子推进 / 单行 JSON 兼容

覆盖验收 ①–⑤(docs/kg/09-orch-hardening-plan.md §3 OF-001):
  ① 零参(旧 5 参)调用兼容:输出/退出码与现行一致,信封多 msgid+ts 两键
  ② 同 msgid 重发 → msg-dedup exit 3;重复 steer 丢弃演示(doctrine)
  ③ 窗口文件 GC:灌 1001 行合成数据 → 截半
  ④ relay mock:base 原子推进(temp+rename)后同事件重放零回报
  ⑤ 信封仍单行 JSON,老消费者(']' 切一刀 + json.loads + 只读老键)解析不拒收(OG5)

域隔离:live fleet.json 只读复制为 temp 副本(port 重写指向本地 stub HTTP server),
state 走 temp 目录——零真实 DSH 流量,不触真实 sessionId。
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAESTRO = os.path.expanduser('~/.dsh/maestro')
SESSION_SEND = os.path.join(MAESTRO, 'bin', 'session-send')
MSG_DEDUP = os.path.join(MAESTRO, 'bin', 'msg-dedup')

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


def envelope_lines():
    """stub 收到的所有 DSHMSG 信封原文(含前缀)。"""
    out = []
    for rec in StubHandler.records:
        out.append(rec['payload']['content'][0]['text'])
    return out


def parse_env(line):
    return json.loads(line.partition(']')[2])


def run(bin_path, args, env):
    return subprocess.run([bin_path] + list(args), env=env, capture_output=True, text=True)


def mock_relay_cycle(env, reports_dir, gitlog, relay_state):
    """按 orch-fleet-conventions.md relay 契约实现的一轮扫描(mock,四步:diff/回报/原子推进/零回声)。"""
    state = {'reports.base': None, 'git.base': None}
    if os.path.exists(relay_state):
        state = json.load(open(relay_state))
    rep_files = sorted(f for f in os.listdir(reports_dir) if f.endswith('.md'))
    base_r = state['reports.base']
    new_reports = rep_files[rep_files.index(base_r) + 1:] if base_r in rep_files else rep_files
    commits = [json.loads(l)['sha'] for l in open(gitlog) if l.strip()]
    base_g = state['git.base']
    new_commits = commits[commits.index(base_g) + 1:] if base_g in commits else commits
    events = [('report', f) for f in new_reports] + [('git', c) for c in new_commits]
    sent = 0
    for kind, name in events:
        r = run(SESSION_SEND, ['--msgid', str(uuid.uuid4()), 'rl01', 'orch1', 'report',
                               'relay-mock', f'{kind}:{name}'], env)
        assert r.returncode == 0, r.stderr
        sent += 1
    if events:  # 回报成功后原子推进(temp+rename)
        new_state = {'reports.base': rep_files[-1] if rep_files else base_r,
                     'git.base': commits[-1] if commits else base_g,
                     'ts': int(time.time() * 1000)}
        tmp = relay_state + '.tmp'
        with open(tmp, 'w') as fh:
            json.dump(new_state, fh)
        os.replace(tmp, relay_state)
    return sent, {'new_reports': [n for _, n in events if _ == 'report'],
                  'new_commits': [n for _, n in events if _ == 'git']}


def main():
    tmp = tempfile.mkdtemp(prefix='of001-selftest-')
    srv = ThreadingHTTPServer(('127.0.0.1', 0), StubHandler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    stub_port = srv.server_address[1]
    env = dict(os.environ,
               DSH_PORT=str(stub_port),
               MAESTRO_FLEET=os.path.join(tmp, 'fleet.json'),
               MAESTRO_STATE=os.path.join(tmp, 'state'))
    try:
        # --- 域隔离基座:temp fleet 副本(live 只读复制,port 重写指向 stub)+ 注入确定性测试码 ---
        live = json.load(open(os.path.join(MAESTRO, 'fleet.json')))
        live['port'] = stub_port
        for code, sid in (('orch1', 'session-1111aaaa-1111-4111-8111-111111111111'),
                          ('2437', 'session-2437abcd-2437-4237-8237-2437abcd2437'),
                          ('rl01', 'session-r0l1aaaa-1111-4111-8111-r0l1aaaar0l1')):
            live.setdefault('fleet', {})[code] = {'sessionId': sid, 'role': 'test', 'status': 'stub-only'}
        fleet_path = os.path.join(tmp, 'fleet.json')
        json.dump(live, open(fleet_path, 'w'))
        sid2437 = live['fleet']['2437']['sessionId']
        reports_dir = os.path.join(tmp, 'reports')
        os.makedirs(reports_dir)
        gitlog = os.path.join(tmp, 'gitlog.jsonl')

        print('① 旧 5 参调用兼容(输出/退出码逐字节一致 + 信封多 msgid/ts):')
        r = run(SESSION_SEND, ['orch1', '2437', 'done', 'r1', 'hello-v2'], env)
        expected = f"sent orch1 -> 2437({sid2437[:14]}…) type=done ref=r1: accepted=True"
        check('exit 0(旧参调用)', r.returncode == 0, f'rc={r.returncode}')
        check('stdout 与现行格式逐字节一致', r.stdout.strip() == expected,
              f'got={r.stdout.strip()!r}' if r.stdout.strip() != expected else expected)
        e1 = parse_env(envelope_lines()[-1])
        t_before = int(time.time() * 1000)
        check('信封新增 msgid(uuid4)', 'msgid' in e1 and len(uuid.UUID(e1['msgid']).hex) == 32, e1.get('msgid', '')[:13] + '…')
        check('信封新增 ts(epoch ms,当前时刻)', isinstance(e1.get('ts'), int) and abs(e1['ts'] - t_before) < 60_000,
              f"ts={e1.get('ts')}")
        r0 = run(SESSION_SEND, [], env)
        check('零参调用 → usage + exit 2(与现行一致)', r0.returncode == 2 and r0.stderr.startswith('session-send —'))

        print('② 同 msgid 重发 → msg-dedup exit 3(重复 steer 丢弃演示):')
        mid = str(uuid.uuid4())
        r = run(SESSION_SEND, ['--msgid', mid, 'orch1', '2437', 'steer', 't2', 'do-x'], env)
        check('重发保号:--msgid 透传送达', r.returncode == 0 and parse_env(envelope_lines()[-1])['msgid'] == mid)
        line = envelope_lines()[-1]
        d1 = run(MSG_DEDUP, [line], env)
        check('收方首见该 steer → exit 0 放行', d1.returncode == 0, f'rc={d1.returncode}')
        d2 = run(MSG_DEDUP, [line], env)
        check('重复投递(网络重试/relay 回声) → exit 3 丢弃', d2.returncode == 3,
              d2.stderr.strip() or f'rc={d2.returncode}')
        d3 = run(MSG_DEDUP, ['orch1', mid, '2437'], env)
        check('三参直查形式同键 → exit 3', d3.returncode == 3)
        d4 = run(MSG_DEDUP, ['orch1', '--msgid', mid, '2437'], env) if False else None  # msg-dedup 无 --msgid;占位防误用
        wpath = os.path.join(tmp, 'state', 'dedup', '2437.jsonl')
        now = int(time.time() * 1000)
        with open(wpath, 'a') as fh:
            fh.write(json.dumps({'from': 'old1', 'msgid': 'm-old', 'ts': now - 61_000}) + '\n')
        d5 = run(MSG_DEDUP, ['old1', 'm-old', '2437'], env)
        check('窗口过期(61s 前同键) → exit 0 放行', d5.returncode == 0, f'rc={d5.returncode}')
        legacy = 'DSHMSG]' + json.dumps({'from': 'legacy', 'to': '2437', 'type': 'ping', 'ref': '-', 'body': 'v1'},
                                        ensure_ascii=False)
        d6 = run(MSG_DEDUP, [legacy], env)
        check('v2 前老信封(无 msgid) → exit 0 透传不误伤', d6.returncode == 0)

        print('③ 去重窗口 GC(灌 1001 行合成数据 → 截半):')
        gpath = os.path.join(tmp, 'state', 'dedup', 'gc99.jsonl')
        os.makedirs(os.path.dirname(gpath), exist_ok=True)
        with open(gpath, 'w') as fh:
            for i in range(1001):
                fh.write(json.dumps({'from': 'syn', 'msgid': f'm-{i}', 'ts': now}) + '\n')
        g1 = run(MSG_DEDUP, ['syn-new', 'm-fresh', 'gc99'], env)
        lines = [l for l in open(gpath).read().splitlines() if l.strip()]
        first_kept = json.loads(lines[0])
        check('GC 后新消息 exit 0', g1.returncode == 0, f'rc={g1.returncode}')
        check('1001 行 → 501 行(保留最近 500 + 新 1)', len(lines) == 501, f'lines={len(lines)}')
        check('保留的是最近一半(m-501 起,最早 501 行被截)', first_kept['msgid'] == 'm-501', first_kept['msgid'])
        g2 = run(MSG_DEDUP, ['syn-new', 'm-fresh', 'gc99'], env)
        check('GC 后窗口去重仍生效(同键 → exit 3)', g2.returncode == 3)


        print('④ relay mock:base 原子推进后同事件重放零回报(D-10):')
        for f in ('OFX-1-report.md', 'OFX-2-report.md'):
            open(os.path.join(reports_dir, f), 'w').write('stub\n')
        with open(gitlog, 'w') as fh:
            fh.write(json.dumps({'sha': 'c1'}) + '\n' + json.dumps({'sha': 'c2'}) + '\n')
        relay_state = os.path.join(tmp, 'state', 'relay-rl01.json')
        n1, ev1 = mock_relay_cycle(env, reports_dir, gitlog, relay_state)
        rs = json.load(open(relay_state))
        check('首轮全量回报 4 事件(2 report + 2 git)', n1 == 4 and len(ev1['new_reports']) == 2 and len(ev1['new_commits']) == 2,
              f'sent={n1} reports={ev1["new_reports"]} git={ev1["new_commits"]}')
        check('位点文件落盘且 base 已推进', rs['reports.base'] == 'OFX-2-report.md' and rs['git.base'] == 'c2',
              json.dumps(rs))
        n2, ev2 = mock_relay_cycle(env, reports_dir, gitlog, relay_state)
        check('同事件重放(零新落地) → 零回报', n2 == 0 and not ev2['new_reports'] and not ev2['new_commits'],
              f'sent={n2}')
        open(os.path.join(reports_dir, 'OFX-3-report.md'), 'w').write('stub\n')
        with open(gitlog, 'a') as fh:
            fh.write(json.dumps({'sha': 'c3'}) + '\n')
        n3, ev3 = mock_relay_cycle(env, reports_dir, gitlog, relay_state)
        rs3 = json.load(open(relay_state))
        check('新增落地只报增量(1 report + 1 git)', n3 == 2 and ev3['new_reports'] == ['OFX-3-report.md'] and ev3['new_commits'] == ['c3'],
              f'sent={n3}')
        check('base 跟随推进至最新位点', rs3['reports.base'] == 'OFX-3-report.md' and rs3['git.base'] == 'c3')
        total = len(StubHandler.records)
        check('stub 总请求数 = 1(①)+1(②)+4+0+2 = 8,无回声流量', total == 8, f'total={total}')

        print('⑤ 信封仍单行 JSON,老消费者解析不拒收(OG5):')
        lines5 = envelope_lines()
        ok_all = all(('\n' not in l and l.startswith('DSHMSG]')) for l in lines5)
        check('全部信封单行 + DSHMSG] 前缀', ok_all and len(lines5) == 8, f'n={len(lines5)}')
        ok_legacy = all(all(k in parse_env(l) for k in ('from', 'to', 'type', 'ref', 'body')) for l in lines5)
        check("老消费者解析(']' 切一刀 + json.loads + 只读老键)全部成功", ok_legacy)
        l0 = envelope_lines()[0]
        legacy_prefix = 'DSHMSG]' + json.dumps(
            {'from': 'orch1', 'to': '2437', 'type': 'done', 'ref': 'r1', 'body': 'hello-v2'},
            ensure_ascii=False).rstrip('}') + ','
        check('老键字节序保持(新键只追加在尾部)', l0.startswith(legacy_prefix), l0[:80] + '…')
        ok_v2keys = all('msgid' in parse_env(l) and 'ts' in parse_env(l) for l in lines5)
        check('v2 键(msgid/ts)全量在位,与老键共存', ok_v2keys)

        n_pass = sum(1 for _, ok, _ in CHECKS if ok)
        print(f'\nOF-001 selftest: {n_pass}/{len(CHECKS)} 全绿' + ('' if n_pass == len(CHECKS) else ' — 存在失败'))
        return 0 if n_pass == len(CHECKS) else 1
    finally:
        srv.shutdown()
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    sys.exit(main())
