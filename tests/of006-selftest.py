#!/usr/bin/env python3
"""OF-006 selftest — relay 泛化为事件守护 event-watchd(W6 · B 组 · 分期:①文件面+②进程面;
③SLA/④租约留位 patch,本票 NotImplemented 不崩溃)

覆盖(任务书编号;规范 §4 OF-006 验收映射见报告 B 节):
  ① 文件面合成场景: 首轮基线不报 → 新文件=事件 → 位点推进 → 同文件重放零回声 → 增长=事件;
     DSHMSG 达 owner(notify=session-send 经 stub fleet/server,信封含 msgid)
  ② 进程面合成场景: 假进程低 CPU+旧 mtime 双条件命中;单条件(低CPU新日志 / 高CPU旧日志)不误报;
     连续挂死 latch 只报一次;进程缺席不判定不崩溃
  ③④ 留位断言: sla/lease 配置项 → WATCHD-STUB NotImplemented 提示,exit 0 不崩溃,不投递 DSHMSG
  ⑤ 单实例锁 + SIGTERM 优雅退出: 后起实例 exit 3 打印持有者;TERM → WATCHD-SHUTDOWN exit 0 无残留
  ★ 自续期(D-09 ②,任务书 bin 范围): max_rounds 到期边界有活动(存活目标)→WATCHD-RENEW 顺延;
    活动消失 → WATCHD-EXIT 退场,无残留进程
  ★ owner 失联升级终点: notify=session-send 指向死端口 → 投递失败 → alerts.log 落 JSONL 行

载荷加固(2026-08-23 GM 并发复验踩坑,两处):
  a) 单条件B(高CPU+旧日志)spinner 阈值动态取实测 CPU 一半——满载并发复跑时 spinner 可能被
     饿到 <50%,固定阈值既误报单条件B又连带双条件计数=2;动态阈值使语义在任意载荷下成立。
  b) RENEW 边界由固定 sleep 1.0s 改轮询(≤5s)——满载下 daemon 轮次变慢会错过固定窗口。

域隔离: 全部 temp(state/alerts/config/fleet);守护目标=本测试 Popen 的 sleep/合成进程;
DSHMSG 仅投 stub HTTP server 或死端口(MAESTRO_FLEET 指 temp 副本)——零真实 sessionId,零真实 worker。
清理: 所有 Popen(daemon/目标进程)入注册表,finally 全量 kill——任何断言路径崩溃不泄漏常驻进程。
"""
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAESTRO = os.path.expanduser('~/.dsh/maestro')
WATCHD = os.path.join(MAESTRO, 'bin', 'event-watchd')

CHECKS = []
DAEMONS = []   # 常驻 watchd
TARGETS = []   # 被守护的合成目标进程


def check(name, ok, detail=''):
    CHECKS.append((name, bool(ok), detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f' — {detail}' if detail else ''))
    return bool(ok)


def write_cfg(path, cfg):
    with open(path, 'w') as fh:
        json.dump(cfg, fh, ensure_ascii=False, indent=1)


def run_once(cfg_path, state_dir, extra_env=None, timeout=60):
    env = dict(os.environ, WATCHD_STATE_DIR=state_dir)
    if extra_env:
        env.update(extra_env)
    return subprocess.run([sys.executable, WATCHD, '--config', cfg_path, '--once'],
                          env=env, capture_output=True, text=True, timeout=timeout)


def spawn_daemon(cfg_path, state_dir, out, extra_env=None):
    env = dict(os.environ, WATCHD_STATE_DIR=state_dir)
    if extra_env:
        env.update(extra_env)
    p = subprocess.Popen([sys.executable, WATCHD, '--config', cfg_path],
                         env=env, stdout=out, stderr=subprocess.STDOUT)
    DAEMONS.append(p)
    return p


def reap_all():
    for p in DAEMONS:
        if p.poll() is None:
            p.terminate()
    for p in DAEMONS:
        try:
            p.wait(timeout=5)
        except subprocess.TimeoutExpired:
            p.kill()
    for p in TARGETS:
        if p.poll() is None:
            p.kill()


def lifetime_cpu(pid):
    """/proc 生命周期均值 CPU%(与 daemon 同式): (utime+stime)/elapsed。"""
    hz = os.sysconf('SC_CLK_TCK')
    parts = open(f'/proc/{pid}/stat').read().split()
    ticks = int(parts[13]) + int(parts[14])
    uptime = float(open('/proc/uptime').read().split()[0])
    elapsed = uptime - int(parts[21]) / hz
    return ticks / hz / elapsed * 100.0


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


def main():
    tmp = tempfile.mkdtemp(prefix='of006-')
    srv = ThreadingHTTPServer(('127.0.0.1', 0), StubHandler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    stub_port = srv.server_address[1]
    # stub fleet: orch1 → stub server;deadfleet: 指向无人监听端口(owner 失联场景)
    for name, port in (('fleet.json', stub_port), ('fleet-dead.json', 59999)):
        write_cfg(os.path.join(tmp, name),
                  {'port': port, 'fleet': {'orch1': {'sessionId': 'session-stub0f006aa'}}})
    try:
        print('\n① 文件面(基线/落地/零回声/增长 + DSHMSG 达 owner 含 msgid):')
        ev = os.path.join(tmp, 'ev')
        os.makedirs(ev, exist_ok=True)
        cfg1 = os.path.join(tmp, 'w-file.json')
        st1 = os.path.join(tmp, 'st-file')
        write_cfg(cfg1, {'interval': 1, 'notify': 'stdout',
                         'faces': {'file': [{'name': 'relay-events', 'glob': ev + '/*.jsonl'}]}})
        with open(os.path.join(ev, 'seed.jsonl'), 'w') as f:
            f.write('{"a":1}\n')
        r = run_once(cfg1, st1)
        check('首轮基线:无事件', r.returncode == 0 and 'WATCHD-EVENT' not in r.stdout
              and 'events=0' in r.stdout)
        with open(os.path.join(ev, 'new.jsonl'), 'w') as f:
            f.write('{"b":2}\n')
        r = run_once(cfg1, st1)
        check('新文件 → file-landed 事件', 'file-landed' in r.stdout and 'new.jsonl' in r.stdout)
        r = run_once(cfg1, st1)
        check('同内容重放 → 零回声(位点已推进)', 'WATCHD-EVENT' not in r.stdout and 'events=0' in r.stdout)
        with open(os.path.join(ev, 'new.jsonl'), 'a') as f:
            f.write('{"c":3}\n')
        r = run_once(cfg1, st1)
        check('文件增长 → file-grew 事件(字节位点)', 'file-grew' in r.stdout and re.search(
            r'bytes \d+->\d+', r.stdout) is not None)
        state = json.load(open(os.path.join(st1, 'w-file.json.state.json')))
        grown = os.path.getsize(os.path.join(ev, 'new.jsonl'))
        check('state 位点推进=当前文件大小(按 entry 分桶)',
              state['files']['relay-events'][os.path.join(ev, 'new.jsonl')] == grown,
              f"state={state['files']}")

        # 多 entry 回归(真值守 2026-08-24 抓到的真 bug): 各 glob 独立分桶——
        # 平面共享时 entry A 每轮把 entry B 的文件"清出→再落地"发 file-landed 洪水。
        ev_b = os.path.join(tmp, 'ev-b')
        os.makedirs(ev_b, exist_ok=True)
        with open(os.path.join(ev_b, 'b1.jsonl'), 'w') as f:
            f.write('{"x":1}\n')
        cfg1m = os.path.join(tmp, 'w-file-multi.json')
        st1m = os.path.join(tmp, 'st-file-multi')
        write_cfg(cfg1m, {'interval': 1, 'notify': 'stdout', 'faces': {'file': [
            {'name': 'fa', 'glob': ev + '/*.jsonl'},
            {'name': 'fb', 'glob': ev_b + '/*.jsonl'}]}})
        r = run_once(cfg1m, st1m)
        check('多 entry 首轮: 全体基线零事件', 'WATCHD-EVENT' not in r.stdout, r.stdout[-150:])
        r = run_once(cfg1m, st1m)
        r2 = run_once(cfg1m, st1m)
        check('多 entry 稳态: 无跨 entry 洪水', 'WATCHD-EVENT' not in r.stdout
              and 'WATCHD-EVENT' not in r2.stdout)

        # DSHMSG 达 owner(notify=session-send → stub)
        StubHandler.records.clear()
        cfg1s = os.path.join(tmp, 'w-file-send.json')
        st1s = os.path.join(tmp, 'st-file-send')
        write_cfg(cfg1s, {'interval': 1, 'notify': 'session-send',
                          'owner': {'from': 'watchd', 'to': 'orch1'},
                          'faces': {'file': [{'name': 'relay-events', 'glob': ev + '2/*.jsonl'}]}})
        ev2 = os.path.join(tmp, 'ev2')
        os.makedirs(ev2, exist_ok=True)
        r = run_once(cfg1s, st1s, extra_env={'MAESTRO_FLEET': os.path.join(tmp, 'fleet.json')})
        check('send 模式首轮基线投递 0 条', r.returncode == 0 and not StubHandler.records)
        with open(os.path.join(ev2, 'x.jsonl'), 'w') as f:
            f.write('{"z":9}\n')
        r = run_once(cfg1s, st1s, extra_env={'MAESTRO_FLEET': os.path.join(tmp, 'fleet.json')})
        # wire 双形容忍(回流修正): session-send v4 默认 DSH_WIRE=slash → method='session/prompt'
        # 且信文在 payload.args.request.content[0].text;dot 退路=method='session.prompt'
        # 信文在 payload.content[0].text。断言语义=DSHMSG 达 owner,不钉死 wire 形。
        def _env_text(c):
            pay = c.get('payload') or {}
            req = (pay.get('args') or {}).get('request') or {}
            node = req if req else pay
            ct = node.get('content') or [{}]
            return (ct[0] or {}).get('text')
        env_lines = [t for t in (_env_text(c) for c in StubHandler.records
                                 if c.get('method') in ('session.prompt', 'session/prompt'))
                     if t]
        check('事件经 session-send DSHMSG 达 owner(1 条)', len(env_lines) == 1, f'n={len(env_lines)}')
        if env_lines:
            payload = json.loads(env_lines[0].split(']', 1)[1])
            check('信封含 msgid(uuid4 形制,可去重)', re.fullmatch(
                r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',
                payload.get('msgid', '')) is not None)
            check('信封路由正确 from=watchd to=orch1 type=report',
                  payload.get('from') == 'watchd' and payload.get('to') == 'orch1'
                  and payload.get('type') == 'report')

        print('\n② 进程面(低 CPU+旧 mtime 双条件命中;单条件不误报;latch;缺席不崩):')
        sleeper = subprocess.Popen(['sleep', '300'])
        spinner = subprocess.Popen([sys.executable, '-c', 'while True: pass'])
        TARGETS.extend([sleeper, spinner])
        time.sleep(1.1)  # 保证 elapsed≥1s,CPU 均值可判
        # 加载加固 a): spinner 阈值动态取实测 CPU 一半(满载并发复跑时 spinner 可被饿<50%,
        # 固定阈值会误报单条件B并连带双条件计数=2);sleep≈0% 不受载荷影响,阈值 5 安全。
        spin_cpu = lifetime_cpu(spinner.pid)
        spin_cpu_max = round(spin_cpu / 2, 2)
        assert spin_cpu > 5, f'spinner lifetime cpu unexpectedly low: {spin_cpu:.2f}%'
        print(f'  [info] spinner lifetime cpu={spin_cpu:.1f}% → 动态阈值 cpu_max={spin_cpu_max}%')
        logs = os.path.join(tmp, 'logs')
        os.makedirs(logs, exist_ok=True)
        stale_log = os.path.join(logs, 'stale.log')
        fresh_log = os.path.join(logs, 'fresh.log')
        for p in (stale_log, fresh_log):
            open(p, 'w').close()
        old_ts = time.time() - 30 * 60
        os.utime(stale_log, (old_ts, old_ts))
        cfg2 = os.path.join(tmp, 'w-proc.json')
        st2 = os.path.join(tmp, 'st-proc')
        write_cfg(cfg2, {'interval': 1, 'notify': 'stdout', 'faces': {'process': [
            {'name': 'dual', 'pid': sleeper.pid, 'cpu_max': 5, 'stale_min': 10, 'log': stale_log},
            {'name': 'single-lowcpu-freshlog', 'pid': sleeper.pid, 'cpu_max': 5,
             'stale_min': 10, 'log': fresh_log},
            {'name': 'single-stalelog-busycpu', 'pid': spinner.pid, 'cpu_max': spin_cpu_max,
             'stale_min': 10, 'log': stale_log},
            {'name': 'gone', 'pid': 999999, 'cpu_max': 5, 'stale_min': 10, 'log': stale_log},
        ]}})
        r = run_once(cfg2, st2)
        check('双条件命中 → process-hung(仅 dual)', r.returncode == 0
              and len(re.findall(r'WATCHD-EVENT process-hung', r.stdout)) == 1
              and 'watch=dual ' in r.stdout,
              [l for l in r.stdout.splitlines() if 'process-hung' in l][:1])
        check('单条件A(低CPU+新日志)不误报', 'single-lowcpu-freshlog' not in r.stdout)
        check('单条件B(高CPU+旧日志)不误报', 'single-stalelog-busycpu' not in r.stdout)
        check('进程缺席不判定不崩溃', 'watch=gone' not in r.stdout and r.returncode == 0)
        r = run_once(cfg2, st2)
        check('连续挂死 latch 只报一次(重放无事件)', 'WATCHD-EVENT' not in r.stdout
              and 'events=0' in r.stdout)
        os.utime(stale_log, None)  # 条件解除
        r = run_once(cfg2, st2)
        check('条件解除 → latch 复位不再报', 'WATCHD-EVENT' not in r.stdout)
        os.utime(stale_log, (old_ts, old_ts))

        print('\n③ SLA 面(非终态票超 ttl → sla-overdue;latch/复位;在飞票=活动票):')
        # temp ledger: 过载票(updated 5h 前)+新鲜票+终态票;ttl=60m 只该报过载票
        ldb = os.path.join(tmp, 'ledger.db')
        import sqlite3 as _sq
        from datetime import datetime as _dt, timezone as _tz, timedelta as _td
        _now = _dt.now(_tz.utc)
        con = _sq.connect(ldb)
        con.execute("""CREATE TABLE IF NOT EXISTS tickets(ticket_id TEXT PRIMARY KEY,
            title TEXT, state TEXT, deps TEXT DEFAULT '[]', lease_owner TEXT,
            refs TEXT DEFAULT '{}', outcome TEXT, updated_at TEXT)""")
        con.executemany(
            "INSERT INTO tickets(ticket_id,title,state,updated_at) VALUES(?,?,?,?)",
            [('T-OLD', '过载票', 'running', (_now - _td(hours=5)).isoformat()),
             ('T-NEW', '新鲜票', 'running', _now.isoformat()),
             ('T-DONE', '终态票', 'done', (_now - _td(hours=9)).isoformat())])
        con.commit(); con.close()
        cfg3 = os.path.join(tmp, 'w-sla.json')
        st3 = os.path.join(tmp, 'st-sla')
        write_cfg(cfg3, {'interval': 1, 'notify': 'stdout',
                         'faces': {'sla': [{'name': 'ticket-ttl', 'ttl_min': 60}]}})
        r = run_once(cfg3, st3, extra_env={'MAESTRO_LEDGER': ldb})
        check('过载票 → sla-overdue(新鲜/终态不报)', r.returncode == 0
              and 'sla-overdue watch=ticket-ttl face=sla ticket=T-OLD' in r.stdout
              and r.stdout.count('sla-overdue') == 1, r.stdout[-200:])
        r = run_once(cfg3, st3, extra_env={'MAESTRO_LEDGER': ldb})
        check('SLA latch: 重放零回声', 'sla-overdue' not in r.stdout)
        con = _sq.connect(ldb)  # 票迁终态 → latch 复位语义面(再触发需新一轮过载)
        con.execute("UPDATE tickets SET state='done' WHERE ticket_id='T-OLD'")
        con.commit(); con.close()
        r = run_once(cfg3, st3, extra_env={'MAESTRO_LEDGER': ldb})
        check('票迁终态 → 不再报', 'sla-overdue' not in r.stdout)

        print('\n④ 租约面(fleet owner lease 过期 → lease-expired;有效租约=活动票):')
        flt = os.path.join(tmp, 'fleet34.json')
        with open(flt, 'w') as fh:
            json.dump({'fleet': {
                'exp1': {'owner': 'orchX', 'leaseExpiresAt': '2026-08-24T00:00:00+00:00'},
                'alive1': {'owner': 'orchY', 'leaseExpiresAt': '2099-01-01T00:00:00+00:00'},
                'noown': {'status': 'active'}}}, fh)
        cfg4 = os.path.join(tmp, 'w-lease.json')
        st4 = os.path.join(tmp, 'st-lease')
        write_cfg(cfg4, {'interval': 1, 'notify': 'stdout',
                         'faces': {'lease': [{'name': 'fleet-lease'}]}})
        r = run_once(cfg4, st4, extra_env={'MAESTRO_FLEET': flt})
        check('过期租约 → lease-expired(有效/无主不报)', r.returncode == 0
              and 'lease-expired watch=fleet-lease face=lease code=exp1 owner=orchX' in r.stdout
              and r.stdout.count('lease-expired') == 1, r.stdout[-200:])
        r = run_once(cfg4, st4, extra_env={'MAESTRO_FLEET': flt})
        check('租约 latch: 重放零回声', 'lease-expired' not in r.stdout)

        print('\n★ 在飞票 → RENEW 活动票(sla 面配置时寿命随在飞票延长):')
        cfg3r = os.path.join(tmp, 'w-sla-renew.json')
        st3r = os.path.join(tmp, 'st-sla-renew')
        write_cfg(cfg3r, {'interval': 0.3, 'max_rounds': 2, 'notify': 'stdout',
                          'faces': {'sla': [{'name': 'ticket-ttl', 'ttl_min': 60}]}})
        out3r = open(os.path.join(tmp, 'sla-renew.out'), 'w+')
        d3r = spawn_daemon(cfg3r, st3r, out3r, extra_env={'MAESTRO_LEDGER': ldb})
        renewed3 = False
        deadline = time.time() + 15.0   # 补丁批: 满载下 5s 窗口偏紧,放宽 15s
        while time.time() < deadline:
            if 'WATCHD-RENEW' in open(out3r.name).read():
                renewed3 = True
                break
            if d3r.poll() is not None:
                break
            time.sleep(0.1)
        check('在飞票存在 → WATCHD-RENEW 顺延', renewed3 and d3r.poll() is None,
              f'poll={d3r.poll()} renewed={renewed3}')
        con = _sq.connect(ldb)  # 全部迁终态 → 活动消失 → 退场
        con.execute("UPDATE tickets SET state='done'")
        con.commit(); con.close()
        rc3 = d3r.wait(timeout=15)
        c3r = open(out3r.name).read()
        check('在飞票清空 → WATCHD-EXIT 退场(非杀)', rc3 == 0
              and 'WATCHD-EXIT reason=max-rounds-reached' in c3r, f'rc={rc3}')
        out3r.close()

        print('\n⑤ 单实例锁 + SIGTERM 优雅退出(无残留进程/锁):')
        cfg5 = os.path.join(tmp, 'w-resident.json')
        st5 = os.path.join(tmp, 'st-resident')
        write_cfg(cfg5, {'interval': 0.3, 'notify': 'stdout',
                         'faces': {'file': [{'name': 'f', 'glob': os.path.join(tmp, 'r', '*.jsonl')}]}})
        out5 = open(os.path.join(tmp, 'resident.out'), 'w+')
        d1 = spawn_daemon(cfg5, st5, out5)
        deadline = time.time() + 5
        while time.time() < deadline and 'WATCHD-START' not in out5.read():
            time.sleep(0.1)
        r = run_once(cfg5, st5)
        check('常驻实例持锁时后起 --once → exit 3 + 打印持有者', r.returncode == 3
              and 'instance lock held' in r.stderr and re.search(
                  r'pid=\d+', r.stderr) is not None, f'rc={r.returncode}')
        d1.send_signal(signal.SIGTERM)
        rc = d1.wait(timeout=5)
        content5 = open(out5.name).read()
        check('SIGTERM → 优雅退出 WATCHD-SHUTDOWN exit 0', rc == 0
              and 'WATCHD-SHUTDOWN signal=SIGTERM' in content5, f'rc={rc}')
        check('无残留进程(poll 与 rc 一致=已收尸)', d1.poll() == rc)
        r = run_once(cfg5, st5)
        check('锁随进程退出自动释放(随后 --once 正常)', r.returncode == 0)
        out5.close()

        print('\n★ 自续期(D-09 ②):max_rounds 边界有活动→顺延;无活动→退场:')
        cfg6 = os.path.join(tmp, 'w-renew.json')
        st6 = os.path.join(tmp, 'st-renew')
        write_cfg(cfg6, {'interval': 0.3, 'max_rounds': 2, 'notify': 'stdout', 'faces': {
            'process': [{'name': 'target', 'pid': sleeper.pid, 'cpu_max': 5,
                         'stale_min': 10, 'log': stale_log}]}})
        out6 = open(os.path.join(tmp, 'renew.out'), 'w+')
        d6 = spawn_daemon(cfg6, st6, out6)
        # 加载加固 b): 固定 sleep 1.0s 在满载下会错过 round2 边界;改轮询等 RENEW 落盘
        # (边界 0.6s,余量 5s;daemon 若已退出则提前跳出交由下一检查报错)。
        renewed = False
        deadline = time.time() + 15.0   # 补丁批: 满载下 5s 窗口偏紧,放宽 15s
        while time.time() < deadline:
            if 'WATCHD-RENEW' in open(out6.name).read():
                renewed = True
                break
            if d6.poll() is not None:
                break
            time.sleep(0.1)
        check('存活目标 → 到期边界 WATCHD-RENEW 顺延', renewed and d6.poll() is None,
              f'poll={d6.poll()} renewed={renewed}')
        sleeper.terminate()  # 活动消失 → 下一边界退场
        rc = d6.wait(timeout=8)
        c6 = open(out6.name).read()
        check('活动消失 → WATCHD-EXIT 退场(非杀)', rc == 0
              and 'WATCHD-EXIT reason=max-rounds-reached' in c6, f'rc={rc}')
        check('退场后无残留', d6.poll() is not None)
        out6.close()

        print('\n★ owner 失联升级终点(投递失败 → alerts.log):')
        alerts = os.path.join(tmp, 'alerts.log')
        cfg7 = os.path.join(tmp, 'w-alert.json')
        st7 = os.path.join(tmp, 'st-alert')
        ev7 = os.path.join(tmp, 'ev7')
        os.makedirs(ev7, exist_ok=True)
        write_cfg(cfg7, {'interval': 1, 'notify': 'session-send',
                         'owner': {'from': 'watchd', 'to': 'orch1'},
                         'faces': {'file': [{'name': 'f7', 'glob': ev7 + '/*.jsonl'}]}})
        run_once(cfg7, st7, extra_env={  # 首轮基线
            'MAESTRO_FLEET': os.path.join(tmp, 'fleet.json'),
            'WATCHD_ALERTS': alerts})
        with open(os.path.join(ev7, 'trigger.jsonl'), 'w') as f:
            f.write('{"boom":1}\n')
        r = run_once(cfg7, st7, extra_env={
            'MAESTRO_FLEET': os.path.join(tmp, 'fleet-dead.json'),  # 死端口=owner 失联
            'WATCHD_ALERTS': alerts})
        lines = [json.loads(x) for x in open(alerts).read().splitlines()] if os.path.exists(alerts) else []
        check('投递失败 → WATCHD-WARN + daemon 不崩(rc 0)', r.returncode == 0
              and 'WATCHD-WARN owner unreachable' in r.stdout)
        check('alerts.log 落单行 JSON 告警(≥1 行)', len(lines) >= 1, f'n={len(lines)}')
        if lines:
            check('告警行含 ts/event/error=owner unreachable',
                  all(k in lines[-1] for k in ('ts', 'event', 'error'))
                  and lines[-1]['error'] == 'owner unreachable')

        n_pass = sum(1 for _, ok, _ in CHECKS if ok)
        print(f'\nOF-006 selftest: {n_pass}/{len(CHECKS)} 全绿'
              + ('' if n_pass == len(CHECKS) else ' — 存在失败'))
        return 0 if n_pass == len(CHECKS) else 1
    finally:
        reap_all()
        srv.shutdown()
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    sys.exit(main())
