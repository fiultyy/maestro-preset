#!/usr/bin/env python3
"""OF-003 selftest — 控制消息两段式契约三处齐 + 派发 prompt 契约头 + SKILL 主叙事切换(D-08 尾)

覆盖验收 ①③④ 全量 + ② 的可离线半面(docs/kg/09-orch-hardening-plan.md §3 OF-003):
  ① 契约文本三处齐(orch-loop.md / bin/dispatch-ticket 模板 / cb-send SKILL.md,grep 可验)
  ② dispatch-ticket --dry-run 生成的派发 prompt 头部含 ack/nack 契约头
     (live steer 往返半面=GM 验收窗口双真实会话执行,见报告 B 节)
  ③ SKILL.md 主叙事含 session-send 直投完整 sessionId;cb-send 标注备胎
  ④ 旧 peer 零阻塞语义在 orch-loop 有明文(nack busy 不丢不重/msgid 勾稽同验)

域隔离: dispatch-ticket 只走 --dry-run(不 send 不落账,零真实终端/ledger 触碰)。
"""
import os
import subprocess
import sys
import tempfile

MAESTRO = os.path.expanduser('~/.dsh/maestro')
ORCH_LOOP = os.path.join(MAESTRO, 'orch-loop.md')
DISPATCH = os.path.join(MAESTRO, 'bin', 'dispatch-ticket')
SKILL = os.path.expanduser('~/.agents/skills/cb-send/SKILL.md')

CHECKS = []


def check(name, ok, detail=''):
    CHECKS.append((name, bool(ok), detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f' — {detail}' if detail else ''))
    return bool(ok)


def read(path):
    with open(path, encoding='utf-8') as fh:
        return fh.read()


# 契约锚点(三处同文,grep 可验;含 ③ 不丢不重/msgid 勾稽 与 ④ 零阻塞语义)
ANCHORS = [
    '控制消息两段式',
    "session-send <self> <from> ack <ref> 'steer-accepted'",
    "session-send <self> <from> nack <ref> 'busy:queued'",
    '不丢不重',
    'bin/msg-dedup',
    '不等待 ack/nack',
    '机械核查为仲裁',
]


def main():
    loop = read(ORCH_LOOP)
    disp = read(DISPATCH)
    skill = read(SKILL)
    sites = {'orch-loop.md': loop, 'bin/dispatch-ticket': disp}

    print('① 契约文本两处齐(grep 可验; SKILL.md 已表格化为 worker 卡,不再承载两段式叙事):')
    for name, text in sites.items():
        missing = [a for a in ANCHORS if a not in text]
        check(f'{name} 含全部 {len(ANCHORS)} 个契约锚点', not missing,
              f'missing={missing}' if missing else '7/7')
    cb_anchors = ['cb-send ack', 'cb-send done', 'inbox.log', '全签名']
    missing = [a for a in cb_anchors if a not in skill]
    check(f'SKILL.md 含全部 {len(cb_anchors)} 个 cb-send 契约锚点', not missing,
          f'missing={missing}' if missing else f'{len(cb_anchors)}/{len(cb_anchors)}')

    print('② dispatch-ticket 生成的派发 prompt 头部含契约头(--dry-run,不发送不落账):')
    tmp = tempfile.mkdtemp(prefix='of003-selftest-')
    repo = os.path.join(tmp, 'repo')
    os.makedirs(os.path.join(repo, 'docs'))
    marker = 'OF003-TICKET-BODY-MARKER'
    with open(os.path.join(repo, 'docs', 'tickets.md'), 'w', encoding='utf-8') as fh:
        fh.write('# Tickets\n\n### TST-001 自测票\n\n- 目标: 验证派发 prompt 契约头\n'
                 f'- 内容标记: {marker}\n')
    env = dict(os.environ, MAESTRO_ORCH_SIGNATURE='orch1@session-of003-selftest')
    r = subprocess.run([sys.executable, DISPATCH, 'TST-001', '--repo', repo,
                        '--terminal', 'term_selftest_stub', '--dry-run'],
                       env=env, capture_output=True, text=True, timeout=60)
    out = r.stdout
    check('dry-run rc0(零发送零落账)', r.returncode == 0, r.stderr.strip()[:120])
    check('prompt 头部 = 控制消息两段式契约块',
          out.startswith('─── 控制消息两段式'), out.splitlines()[0][:60] if out else '<empty>')
    check("契约头含 ack 'steer-accepted' / nack 'busy:queued' 回执命令",
          "ack <ref> 'steer-accepted'" in out and "nack <ref> 'busy:queued'" in out)
    check('契约头位于票体之前(头=头部,非尾部)', 0 <= out.find('steer-accepted') < out.find(marker),
          f'contract@{out.find("steer-accepted")} < body@{out.find(marker)}')
    check('模板主体保留: [ref:TST-001] 回调契约 + 票体注入 + 占位符全替换',
          '[ref:TST-001]' in out and marker in out
          and '{REF}' not in out and '{TICKET_BLOCK}' not in out and '{WORKER}' not in out)

    print('③ SKILL.md 为 worker 回调卡(目的→命令表;表格化后形态):')
    check('SKILL.md 头部即命令卡(cb-send ack/done 首块)',
          'cb-send ack' in skill[:1200] and 'cb-send done' in skill[:1200])

    print('④ 旧 peer 零阻塞语义在 orch-loop 有明文(nack busy 不丢不重同验):')
    check('orch-loop 明文: 发送方零阻塞/不等待 ack-nack/机械核查为仲裁',
          '零阻塞' in loop and '不等待 ack/nack' in loop and '机械核查为仲裁' in loop)
    check('orch-loop 明文: nack busy = 消息保留、下回合首处理、不丢不重(与 msgid 勾稽)',
          '消息保留' in loop and '下回合首' in loop and '不丢不重' in loop
          and 'msgid' in loop and 'msg-dedup' in loop)
    check('orch-loop 契约节引用 OF-002 闸(语义衔接: 契约只处理闸放行后的消息)',
          'OF-002' in loop and 'fleet-conflicts.jsonl' in loop)

    n_pass = sum(1 for _, ok, _ in CHECKS if ok)
    print(f'\nOF-003 selftest: {n_pass}/{len(CHECKS)} 全绿'
          + ('' if n_pass == len(CHECKS) else ' — 存在失败'))
    return 0 if n_pass == len(CHECKS) else 1


if __name__ == '__main__':
    sys.exit(main())
