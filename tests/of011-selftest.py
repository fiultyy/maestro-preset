#!/usr/bin/env python3
"""OF-011 selftest — HOOK-ENVELOPE: 信封上车 + 来路即目标(#133 A′/B′)

覆盖验收 V1-V4 可离线面(envelope.md):
  ① V1 生产端单元面: bin/orch 模块级 dag_envelope/dag_orch_sig — 信封 jq 可析/from=旗标/ref=票REF/
     msgid 唯一/回落链五槽位(旗标→env ORCH_SIG→seat 落态→MAESTRO_ORCH_SIGNATURE→signature 文件→orch-p0);
     CLI 全链由 orch selftest S21e/S21f 断言(此处兼跑其尾行,全绿方过)
  ② V2 消费端: 带信封 prompt → ups 落 inflight 5 列含 FROM + ticket-received(to=ORCH_SIG 不变);
     旧 4 列 inflight → done to=ORCH_SIG 回落;NO-INFLIGHT 静默不变
  ③ V3 端到端仿真(文件沙盘,帧走文件不真投桥): 信封 prompt → ups → 检 inflight →
     turn-end-pair → 检 inbox 尾帧目标=信封 FROM(来路即目标)
  ④ 回归: running sidecar 分支不回归(preamble prompt → ticket-running 帧,零 inflight 零 inbox);
     turn-idle 分支 to=ORCH_SIG
  ⑤ 部署面 cmp: 仓内 bin/ ↔ ~/.dsh/maestro/bin/ ↔ ~/.dsh/.agent-presets/maestro/bin/ 三面一致

域隔离: ORCH_INBOX/ORCH_INFLIGHT/ORCH_RUNNING 全指 tempfile,零真桥流量,不触真实会话。
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import uuid

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ORCH = os.path.join(REPO, 'bin', 'orch')
UPS = os.path.join(REPO, 'bin', 'ups-dispatch-watch.sh')
PAIR = os.path.join(REPO, 'bin', 'turn-end-pair.sh')

CASES = []
FAILS = []


def case(fn):
    CASES.append(fn)
    return fn


def run_script(path, stdin_doc, env_over):
    env = dict(os.environ)
    for k in ('ORCH_SIG', 'ORCH_INBOX', 'ORCH_INFLIGHT', 'ORCH_RUNNING', 'ORCH_DEBUG', 'ORCH_IDLE_ALL'):
        env.pop(k, None)
    env.update(env_over)
    return subprocess.run(['bash', path], input=json.dumps(stdin_doc), capture_output=True,
                          text=True, env=env, timeout=30)


def envelope_prompt(from_sig, ref, body='任务书正文'):
    env_json = {'from': from_sig, 'to': '-', 'type': 'dispatch', 'ref': ref,
                'msgid': str(uuid.uuid4()), 'ver': 3}
    return 'DSHMSG]' + json.dumps(env_json, ensure_ascii=False) + '\n' + body


def main():
    tmp = tempfile.mkdtemp(prefix='of011-')
    inbox = os.path.join(tmp, 'inbox.log')
    open(inbox, 'w').close()
    inflight = os.path.join(tmp, 'inflight')
    os.makedirs(inflight)
    runlog = os.path.join(tmp, 'running.log')
    open(runlog, 'w').close()
    SEAT0 = 'orch-seat0@session-seat0'   # 本席(区别于信封 FROM,证明来路优先于 env)
    base = {'ORCH_INBOX': inbox, 'ORCH_INFLIGHT': inflight, 'ORCH_RUNNING': runlog,
            'ORCH_SIG': SEAT0}
    try:
        for fn in CASES:
            try:
                r = fn(tmp, base)
                if r is False:
                    FAILS.append(fn.__name__)
            except Exception as e:   # noqa: BLE001
                print(f'[FAIL] {fn.__name__}: {type(e).__name__}: {e}')
                FAILS.append(fn.__name__)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    total = len(CASES)
    if FAILS:
        print(f'OF-011 selftest: {total - len(FAILS)}/{total} 绿,失败: {", ".join(FAILS)}')
        sys.exit(1)
    print(f'OF-011 selftest: {total}/{total} 全绿(exit 0)')
    sys.exit(0)


# ── ① V1 生产端单元面: bin/orch 模块级信封/回落链 ─────────────────────────────
def _load_orch_mod():
    import importlib.util
    from importlib.machinery import SourceFileLoader
    name = 'orch_mod_of011'
    loader = SourceFileLoader(name, ORCH)   # 无扩展名脚本须显式 loader
    spec = importlib.util.spec_from_loader(name, loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


@case
def v1_envelope_shape(tmp, base):
    om = _load_orch_mod()
    env_line = om.dag_envelope('sig-x@session-x', 'OF11-R1')
    print('[ ok ] v1 信封构造可调')

    def first_env(spec):
        first = spec.split('\n', 1)[0]
        assert first.startswith('DSHMSG]'), first[:80]
        return json.loads(first[len('DSHMSG]'):])
    j = first_env(env_line + '\n正文')
    assert j['from'] == 'sig-x@session-x' and j['to'] == '-' and j['type'] == 'dispatch'
    assert j['ref'] == 'OF11-R1' and j['ver'] == 3, j
    uuid.UUID(j['msgid'])
    assert first_env(om.dag_envelope('sig-x@session-x', 'OF11-R2'))['msgid'] != j['msgid']
    print('[ ok ] v1 信封 jq 可析/from/to=-/type/ref/msgid 唯一')

    j2 = first_env(om.dag_envelope('sig-x@session-x', ''))
    assert j2['ref'] == 'dispatch'   # 无票场景兜底(与消费端同款)
    print('[ ok ] v1 无票 ref=dispatch 兜底')


@case
def v1_sig_fallback_chain(tmp, base):
    om = _load_orch_mod()
    saved = {k: os.environ.get(k) for k in ('ORCH_SIG', 'MAESTRO_ORCH_SIGNATURE')}
    saved_md = om.MAESTRO_DIR
    try:
        for k in saved:
            os.environ.pop(k, None)
        assert om.dag_orch_sig('flag@session-f', {'orch_sig': 'seat@session-s'}) == 'flag@session-f'
        assert om.dag_orch_sig(None, {'orch_sig': 'seat@session-s'}) == 'seat@session-s'
        os.environ['ORCH_SIG'] = 'env@session-e'
        assert om.dag_orch_sig(None, {'orch_sig': 'seat@session-s'}) == 'env@session-e'
        os.environ.pop('ORCH_SIG', None)
        sigdir = os.path.join(tmp, 'maestro', 'bridge')
        os.makedirs(sigdir, exist_ok=True)
        with open(os.path.join(sigdir, 'orch.signature'), 'w') as f:
            f.write('file@session-fi')
        om.MAESTRO_DIR = os.path.join(tmp, 'maestro')
        assert om.dag_orch_sig(None, None) == 'file@session-fi'
        om.MAESTRO_DIR = os.path.join(tmp, 'no-such-maestro')
        assert om.dag_orch_sig(None, None) == 'orch-p0'   # 末位兜底=消费端同款
        print('[ ok ] v1 回落链五槽位: 旗标→env ORCH_SIG→seat 落态→signature 文件→orch-p0')
    finally:
        om.MAESTRO_DIR = saved_md
        for k, v in saved.items():
            if v is not None:
                os.environ[k] = v
            else:
                os.environ.pop(k, None)


@case
def v1_orch_selftest_green(tmp, base):
    env = dict(os.environ)
    env.pop('ORCH_SIG', None)
    p = subprocess.run([sys.executable, ORCH, 'selftest'], capture_output=True, text=True,
                       env=env, timeout=300)
    tail = (p.stdout.strip().splitlines() or [''])[-1]
    assert p.returncode == 0 and '0 failed' in tail.replace('  ', ' '), tail
    print(f"[ ok ] v1 orch selftest 尾行: {tail}")


# ── ②③ V2/V3 消费端: 文件沙盘全链 ────────────────────────────────────────────
@case
def v2_ups_inflight_5col(tmp, base):
    e = dict(base)
    p = run_script(UPS, {'session_id': 'sess-a1', 'prompt': envelope_prompt('orch-x@session-x', 'OF11-A1')}, e)
    assert p.returncode == 0, p.stderr
    row = open(os.path.join(inflight_dir(base), 'sess-a1'), encoding='utf-8').read().rstrip('\n')
    cols = row.split('\t')
    assert len(cols) == 5, cols
    assert cols[0] == 'OF11-A1' and cols[4] == 'orch-x@session-x', cols
    print(f'[ ok ] v2 inflight 5 列含 FROM: {row}')
    frames = [json.loads(l) for l in open(base['ORCH_INBOX'], encoding='utf-8') if l.strip()]
    assert len(frames) == 1 and frames[0]['type'] == 'ticket-received'
    assert frames[0]['to'] == base['ORCH_SIG'] and frames[0]['from'] == 'orch-x@session-x'
    assert frames[0]['ref'] == 'OF11-A1'
    print('[ ok ] v2 ticket-received to=ORCH_SIG 不变,from=信封 FROM')


def inflight_dir(base):
    return base['ORCH_INFLIGHT']


@case
def v3_e2e_done_to_from(tmp, base):
    """V3 端到端仿真(文件沙盘): 信封 prompt → ups → inflight → turn-end-pair → done to=FROM。"""
    e = dict(base)
    run_script(UPS, {'session_id': 'sess-e2e', 'prompt': envelope_prompt('orch-e2e@session-e2e', 'OF11-E2E')}, e)
    inf = os.path.join(inflight_dir(base), 'sess-e2e')
    assert os.path.isfile(inf) and len(open(inf).read().rstrip('\n').split('\t')) == 5
    print('[ ok ] v3 inflight 在案(5 列)')
    p = run_script(PAIR, {'session_id': 'sess-e2e'}, e)
    assert p.returncode == 0, p.stderr
    frames = [json.loads(l) for l in open(base['ORCH_INBOX'], encoding='utf-8') if l.strip()]
    done = [f for f in frames if f['type'] == 'ticket-done']
    assert len(done) == 1, frames
    d = done[0]
    assert d['to'] == 'orch-e2e@session-e2e', d   # 来路即目标: to=信封 FROM,非 ORCH_SIG
    assert d['ref'] == 'OF11-E2E' and d['from'] == 'sess-e2e' and d['ver'] == 3
    assert not os.path.exists(inf)   # 配对清态
    print('[ ok ] v3 done 帧 to=信封 FROM + 配对清态')


@case
def v2_old_4col_falls_back_orch_sig(tmp, base):
    inf = os.path.join(inflight_dir(base), 'sess-old')
    with open(inf, 'w', encoding='utf-8') as f:
        f.write('OF11-OLD\toldmsgid\t1788966000\treport\n')
    p = run_script(PAIR, {'session_id': 'sess-old'}, dict(base))
    assert p.returncode == 0, p.stderr
    frames = [json.loads(l) for l in open(base['ORCH_INBOX'], encoding='utf-8') if l.strip()]
    d = [f for f in frames if f['type'] == 'ticket-done' and f['ref'] == 'OF11-OLD'][-1]
    assert d['to'] == base['ORCH_SIG'], d   # 存量 4 列 → 回落 ORCH_SIG
    print(f"[ ok ] v2 旧 4 列回落 ORCH_SIG: to={d['to']}")


@case
def v2_no_inflight_silent(tmp, base):
    before = sum(1 for _ in open(base['ORCH_INBOX'], encoding='utf-8'))
    p = run_script(PAIR, {'session_id': 'sess-none'}, dict(base))
    assert p.returncode == 0, p.stderr
    after = sum(1 for _ in open(base['ORCH_INBOX'], encoding='utf-8'))
    assert before == after, (before, after)
    print('[ ok ] v2 NO-INFLIGHT 静默不变(无 ORCH_IDLE_ALL)')


@case
def v4_turn_idle_to_orch_sig(tmp, base):
    e = dict(base)
    e['ORCH_IDLE_ALL'] = '1'
    before = sum(1 for _ in open(base['ORCH_INBOX'], encoding='utf-8'))
    p = run_script(PAIR, {'session_id': 'sess-idle'}, e)
    assert p.returncode == 0, p.stderr
    frames = [json.loads(l) for l in open(base['ORCH_INBOX'], encoding='utf-8') if l.strip()]
    assert len(frames) == before + 1
    idle = frames[-1]
    assert idle['type'] == 'turn-idle' and idle['to'] == base['ORCH_SIG'], idle
    print('[ ok ] v4 turn-idle 分支 to=ORCH_SIG 保持原样')


@case
def v4_preamble_branch_untouched(tmp, base):
    before = sum(1 for _ in open(base['ORCH_INBOX'], encoding='utf-8'))
    prompt = ('You are a dispatched worker.\nYour coordinator handle: term_c\n'
              'Your task ID is: task_0f11a\n\n正文若干\n')
    p = run_script(UPS, {'session_id': 'sess-pre', 'prompt': prompt}, dict(base))
    assert p.returncode == 0, p.stderr
    assert not os.path.exists(os.path.join(inflight_dir(base), 'sess-pre'))   # 不落 inflight
    frames = [json.loads(l) for l in open(base['ORCH_INBOX'], encoding='utf-8') if l.strip()]
    assert len(frames) == before   # 零 inbox 流量(不走桥)
    run = [json.loads(l) for l in open(base['ORCH_RUNNING'], encoding='utf-8') if l.strip()]
    assert len(run) == 1 and run[0]['type'] == 'ticket-running' and run[0]['ref'] == 'task_0f11a', run
    assert run[0]['to'] == base['ORCH_SIG']
    print('[ ok ] v4 running sidecar 分支不回归(sidecar 帧,零 inflight 零 inbox)')


@case
def v4_no_envelope_silent(tmp, base):
    before = sum(1 for _ in open(base['ORCH_INBOX'], encoding='utf-8'))
    p = run_script(UPS, {'session_id': 'sess-plain', 'prompt': '普通人类打字\n无信封'}, dict(base))
    assert p.returncode == 0, p.stderr
    after = sum(1 for _ in open(base['ORCH_INBOX'], encoding='utf-8'))
    assert before == after and not os.path.exists(os.path.join(inflight_dir(base), 'sess-plain'))
    print('[ ok ] v4 无信封普通 prompt 静默不变')


# ── ⑤ 部署面 cmp ─────────────────────────────────────────────────────────────
@case
def v4_deployment_cmp(tmp, base):
    import filecmp
    faces = [REPO,
             os.path.expanduser('~/.dsh/maestro'),
             os.path.expanduser('~/.dsh/.agent-presets/maestro')]
    for rel in ('bin/orch', 'bin/ups-dispatch-watch.sh', 'bin/turn-end-pair.sh'):
        a = os.path.join(faces[0], rel)
        for face in faces[1:]:
            b = os.path.join(face, rel)
            assert os.path.isfile(b), b
            assert filecmp.cmp(a, b, shallow=False), f'漂移: {a} != {b}'
            print(f'[ ok ] v4 cmp 一致: {rel} == {os.path.join(os.path.basename(face), rel)}')


if __name__ == '__main__':
    main()
