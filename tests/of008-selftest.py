#!/usr/bin/env python3
"""OF-008 selftest — dais 构建断言 + 实例锁(W6 · C 组 · 本票只做 ①②;③ 消费侧 WARN 在
pipecat-poc 在飞域,票面明确 deferred)

覆盖验收(docs/kg/09-orch-hardening-plan.md §5 OF-008):
  ① 好/坏二进制合成 fixtures:断言通过/失败两态均正确(dais-build --selftest --fixture)
  ② 锁三场景:获取/拒绝(打印持有者)/boot-id 变化陈旧锁让位(全部 dais --lock-dryrun,不起 GUI)
  ③ 探针对坏形态输出 WARN — DEFERRED(POC 域 rt_probe_m0.py/rt_dsh_lane.py 在飞,不入本票)
  ④ dais-build 幂等可重跑(selftest 连跑两轮输出一致 + dryrun 连续两次获取)
  ⑤ 错误形制快照落盘(fixture 快照 + --assert-current 对现行真二进制只读断言,D-03 基线)
  ★ 现场证据:锁被持有时 `dais orchestration check-status` 零影响(CLI 路径零取锁,GM 侧可并行复核)

域隔离:锁走 temp 文件(env DAIS_LOCK_FILE);dais-build 报告走 temp(env DAIS_BUILD_REPORT);
真实锁路径仅在"CLI 零影响"证据中短暂 flock 后恢复原状。零 GUI 启动,零真实构建。
"""
import fcntl
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

DAIS = os.path.expanduser('~/.local/bin/dais')
DAIS_PRE = os.path.expanduser('~/.local/bin/dais.pre-of008')
DAIS_BUILD = os.path.expanduser('~/.local/bin/dais-build')
REAL_LOCK = os.path.expanduser('~/.local/state/dais/instance.lock')
REAL_BOOT_ID = open('/proc/sys/kernel/random/boot_id').read().strip()
SENTINEL = b'not enabled in this build'

CHECKS = []


def check(name, ok, detail=''):
    CHECKS.append((name, bool(ok), detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f' — {detail}' if detail else ''))
    return bool(ok)


def run(cmd, env=None, timeout=180):
    e = dict(os.environ)
    if env:
        e.update(env)
    return subprocess.run(cmd, env=e, capture_output=True, text=True, timeout=timeout)


def dryrun(lock, extra=(), env_extra=None):
    env = {'DAIS_LOCK_FILE': lock}
    if env_extra:
        env.update(env_extra)
    return run([DAIS, '--lock-dryrun', *extra], env=env)


def make_fixtures(d):
    """合成好/坏二进制样本:好=无哨兵串;坏=内嵌 1/2 次 D-01 哨兵串。"""
    good1 = b'\x7fELF\x02\x01\x01\x00' + b'warp::ai::orchestration\x00RPC server up\x00' + os.urandom(512)
    good2 = b'\x7fELF' + b'dais-runtime.json\x00session mailbox ok\x00' + os.urandom(256)
    bad1 = (b'\x7fELF\x02' + b'orchestration: ' + SENTINEL + b'\x00' + os.urandom(128))
    bad2 = (b'\x7fELF' + SENTINEL + b'\x00mid\x00' + SENTINEL + b'\x00' + os.urandom(64))
    for name, blob in (('good.bin', good1), ('good2.bin', good2),
                       ('bad.bin', bad1), ('bad2.bin', bad2)):
        with open(os.path.join(d, name), 'wb') as f:
            f.write(blob)
    # 破坏组:完整 fixture(好+坏齐)里掺一颗伪装成 good 的坏样本
    # (selftest 须判 MISMATCH→exit 1;缺 bad* 会走 exit 2 fixture-incomplete,测不到断言逻辑)
    sabot = os.path.join(d, 'sabotage')
    os.makedirs(sabot, exist_ok=True)
    with open(os.path.join(sabot, 'good.bin'), 'wb') as f:
        f.write(bad1)
    with open(os.path.join(sabot, 'bad.bin'), 'wb') as f:
        f.write(bad2)


def main():
    tmp = tempfile.mkdtemp(prefix='of008-')
    try:
        print(f"boot_id(real) = {REAL_BOOT_ID}")
        print(f"wrapper = {DAIS} (backup {DAIS_PRE})")

        print('\n① 合成 fixtures 断言两态(好→通过 / 坏→失败):')
        fx = os.path.join(tmp, 'fixtures')
        os.makedirs(fx, exist_ok=True)
        make_fixtures(fx)
        r1 = run([DAIS_BUILD, '--selftest', '--fixture', fx],
                 env={'DAIS_BUILD_REPORT': os.path.join(tmp, 'r1.md')})
        check('好/坏混合 fixtures → exit 0', r1.returncode == 0, f'rc={r1.returncode}')
        check('good 样本 expect=pass→OK(≥2)', len(re.findall(r'expect=pass actual=pass → OK', r1.stdout)) >= 2)
        check('bad 样本 expect=fail→OK(≥2)', len(re.findall(r'expect=fail actual=fail → OK', r1.stdout)) >= 2)
        check('bad 断言计数可见(count>0)', 'sentinel count=1' in r1.stdout and 'sentinel count=2' in r1.stdout)
        r2 = run([DAIS_BUILD, '--selftest', '--fixture', os.path.join(fx, 'sabotage')],
                 env={'DAIS_BUILD_REPORT': os.path.join(tmp, 'r2.md')})
        check('伪装好样本 → MISMATCH + exit≠0', r2.returncode != 0 and 'MISMATCH' in r2.stdout,
              f'rc={r2.returncode}')

        print('\n② 实例锁三场景(dais --lock-dryrun,零 GUI 启动):')
        lock = os.path.join(tmp, 'instance.lock')
        # 场景 1: 获取
        a = dryrun(lock)
        check('S1 空位获取 → exit 0 RESULT=acquired', a.returncode == 0 and 'RESULT=acquired' in a.stdout)
        content = open(lock).read()
        check('S1 锁内容 pid+boot_id+ts 三键', all(k in content for k in ('pid=', 'boot_id=', 'ts=')), content.strip())
        check('S1 默认读 /proc 真 boot-id', f'boot_id={REAL_BOOT_ID}' in a.stdout)
        # 场景 2: 拒绝 + --force 覆盖
        fd = os.open(lock, os.O_RDWR | os.O_CREAT, 0o644)
        fcntl.flock(fd, fcntl.LOCK_EX)
        os.ftruncate(fd, 0)
        os.write(fd, f'pid=424242 boot_id={REAL_BOOT_ID} ts=1700000000\n'.encode())
        rej = dryrun(lock)
        check('S2 持锁中 → exit 1 RESULT=rejected', rej.returncode == 1 and 'RESULT=rejected' in rej.stdout)
        check('S2 拒绝时打印持有者 pid=424242', 'holder=pid=424242' in rej.stdout)
        forced = dryrun(lock, extra=['--force'])
        check('S2 --force 覆盖 → exit 0 RESULT=forced', forced.returncode == 0 and 'RESULT=forced' in forced.stdout)
        os.close(fd)
        # 场景 3: boot-id 变化 → 陈旧锁自动让位
        with open(lock, 'w') as f:
            f.write('pid=111 boot_id=00000000-0000-0000-0000-000000000000 ts=1\n')
        st = dryrun(lock)
        check('S3 陈旧 boot-id → 获取成功且 stale_replaced=1',
              st.returncode == 0 and 'RESULT=acquired stale_replaced=1' in st.stdout)
        check('S3 让位后锁内容已换为本机 boot-id', f'boot_id={REAL_BOOT_ID}' in open(lock).read())

        print('\n③ 消费侧 WARN(rt_probe_m0/rt_dsh_lane 捕坏形态告警):')
        print('  [DEFERRED] POC 域在飞文件,票面明确不入本票(③ 涉 pipecat-poc,GM 裁决 deferred)')

        print('\n④ 幂等可重跑:')
        r3 = run([DAIS_BUILD, '--selftest', '--fixture', fx],
                 env={'DAIS_BUILD_REPORT': os.path.join(tmp, 'r3.md')})
        check('dais-build selftest 二轮重跑 → 同样 exit 0', r3.returncode == 0 and r1.stdout == r3.stdout,
              f'rc1={r1.returncode} rc3={r3.returncode}')
        a2 = dryrun(lock)
        check('dryrun 顺序二次获取(前次已释放) → 仍 acquired', a2.returncode == 0 and 'RESULT=acquired' in a2.stdout)

        print('\n⑤ 错误形制快照(D-03 契约基线):')
        check('selftest 输出含 fixture 错误形制快照(哨兵行)', SENTINEL.decode() in r1.stdout)
        real_bin = os.path.expanduser('~/warpdotdev/dais/target/release/dais')
        if os.path.isfile(real_bin):
            ac = run([DAIS_BUILD, '--assert-current'], env={'DAIS_BUILD_REPORT': os.path.join(tmp, 'rc.md')})
            check('现行真二进制只读断言 → PASS(哨兵计数 0)', ac.returncode == 0 and ': PASS' in ac.stdout,
                  ac.stdout.splitlines()[0] if ac.stdout else '')
            check('--assert-current 快照含 read-worker 形制', 'PTY bridge running' in ac.stdout)
            rep = open(os.path.join(tmp, 'rc.md')).read()
            check('快照已落报告(sha256+形式行)', 'sha256=' in rep and '错误形制快照' in rep)
        else:
            check('现行真二进制只读断言(二进制缺席→跳过)', True, f'{real_bin} 不存在,跳过')

        print('\n★ 现场证据:锁不影响 CLI(监督自锁禁令,GM 侧可并行复核):')
        real_existed = os.path.exists(REAL_LOCK)
        try:
            base = run([DAIS, 'orchestration', 'check-status'], timeout=60)
            fd2 = os.open(REAL_LOCK, os.O_RDWR | os.O_CREAT, 0o644)
            try:
                fcntl.flock(fd2, fcntl.LOCK_EX)
                os.ftruncate(fd2, 0)
                os.write(fd2, f'pid={os.getpid()} boot_id={REAL_BOOT_ID} ts={int(time.time())}\n'.encode())
                held = run([DAIS, 'orchestration', 'check-status'], timeout=60)
                oldw = run(['bash', DAIS_PRE, 'orchestration', 'check-status'], timeout=60)
            finally:
                fcntl.flock(fd2, fcntl.LOCK_UN)
                os.close(fd2)
            l0 = held.stdout.splitlines()[0] if held.stdout else ''
            check('真锁被持有时 check-status(新 wrapper) → rc 0', held.returncode == 0, f'rc={held.returncode}')
            check('输出形制不变(首行 N runs)', re.match(r'^\d+ runs$', l0) is not None, l0)
            check('与无锁基线 rc 一致', base.returncode == held.returncode,
                  f'base={base.returncode} held={held.returncode}')
            check('与改前 wrapper(dais.pre-of008) rc 一致', oldw.returncode == 0,
                  f'pre-of008 rc={oldw.returncode}')
        finally:
            if not real_existed and os.path.exists(REAL_LOCK):
                os.unlink(REAL_LOCK)
        check('真实锁路径恢复原状(测前不存在→测后不存在)', not real_existed and not os.path.exists(REAL_LOCK))

        n_pass = sum(1 for _, ok, _ in CHECKS if ok)
        print(f'\nOF-008 selftest: {n_pass}/{len(CHECKS)} 全绿' + ('' if n_pass == len(CHECKS) else ' — 存在失败'))
        return 0 if n_pass == len(CHECKS) else 1
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    sys.exit(main())
