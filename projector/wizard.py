#!/usr/bin/env python3
#
# SPDX-License-Identifier: BSD 2-Clause License
#
"""孵化向导驱动器（VO-010 · docs/kg/03-ws3-spawn-projection.md §4）.

引导链（六步，一步不漏）：
  场景选型 + role 选型 → 投影（rt_projector，含 role doctrine）→
  三门报告回显 → incubate RPC（a2a-profile-server 插件）→ 回执回显。

选型（scenario/role/targets）由调用 agent 在会话内决策后经参数传入；
本脚本负责执行投影、复核三门、发起 incubate 并回显回执。

用法：
  python3 ~/.agents/skills/incubation-wizard/wizard.py \\
      --scenario "<自然语言场景>" --name <slug> \\
      [--role worker] [--targets dry] [--model glm-5-turbo]

派生模式（queen，N10-T2 · docs/10 §2）：
  wizard.py --scenario "<场景>" --name <slug> --derive \\
      --answers-file <json> [--parent <亲本profile名>] [--targets dry]
  answers-file = {维度key: 答案} 映射（grill 清单 18 维，缺维取建议值）。

退出码：0=成功；1=参数/环境缺料；2=投影或三门失败；3=端点不可达；4=RPC 错误。
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

REPO_DIR = Path(os.environ.get(
    "INCUBATION_WIZARD_REPO",
    "~/workspace-claw-02/pipecat-poc/examples/realtime-provider-poc",
)).expanduser()

ROLES = ("liaison", "manager", "queen", "supervisor", "worker")
# 与插件 http-server.js ROLE_TARGETS 同源（G5 不漂移）：目标蕴含 role
ROLE_TARGETS = {"dsh-liaison": "liaison", "dsh-manager": "manager"}
TARGETS = ("dsh", "dsh-liaison", "dsh-manager", "omp", "claude", "dry")

GATE_LABELS = (
    ("gate1_terminology", "gate1 术语零暴露"),
    ("gate2_catastrophe", "gate2 灾难底线"),
    ("gate3_completeness", "gate3 结构完整"),
)


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(
        prog="incubation-wizard",
        description="场景+role 选型→投影→三门回显→孵化→回执（VO-010）",
    )
    ap.add_argument("--scenario", required=True,
                    help="自然语言场景：自包含、指代展开、幂等可重放")
    ap.add_argument("--name", required=True, help="profile 名（slug，如 explore-mvp）")
    ap.add_argument("--role", default="worker", choices=ROLES,
                    help="第 17 维 agent_role（默认 worker=现行通用投影）")
    ap.add_argument("--targets", default="dry",
                    help="逗号分隔孵化目标 dsh/dsh-liaison/dsh-manager/omp/claude/dry"
                         "（默认 dry=只记录不落系统，冒烟安全档）")
    ap.add_argument("--model", default=None,
                    help="GLM 模型（缺省取 GLM_PROJECTOR_MODEL 或 glm-5-turbo）")
    ap.add_argument("--derive", action="store_true",
                    help="派生模式（queen）：grill 清单打印→合并答案→投影→"
                         "incubate 带 lineage；此模式下 --role 由答案 agent_role 决定")
    ap.add_argument("--parent", default="",
                    help="派生血缘亲本 profile 名（可省，省则 lineage.parent 留空）")
    ap.add_argument("--answers-file", default=None,
                    help="--derive 必填：JSON 文件 {维度key: 答案}；缺维取 grill 建议值")
    args = ap.parse_args(argv)

    answers: dict[str, str] = {}
    if args.answers_file:
        try:
            with open(args.answers_file, encoding="utf-8") as fh:
                raw = json.load(fh)
        except (OSError, json.JSONDecodeError) as exc:
            ap.error(f"--answers-file 读取/解析失败: {exc}")
        if not isinstance(raw, dict):
            ap.error("--answers-file 须是 JSON 对象 {维度key: 答案}")
        for k, v in raw.items():
            if isinstance(v, (dict, list)):
                ap.error(f"--answers-file 答案 [{k}] 须是标量字符串")
            answers[str(k)] = str(v)
    if args.derive and not args.answers_file:
        ap.error("--derive 必填 --answers-file（{维度key: 答案} JSON 映射；缺维将取 grill 建议值）")
    args.answers = answers

    targets = [t.strip() for t in args.targets.split(",") if t.strip()]
    bad = [t for t in targets if t not in TARGETS]
    if bad:
        ap.error(f"未知孵化目标 {bad}；合法值：{'/'.join(TARGETS)}")
    for t in targets:
        implied = ROLE_TARGETS.get(t)
        if implied and args.role != implied:
            ap.error(f"role {args.role} 与目标 {t} 冲突（{t} 蕴含 role={implied}）")
    args.targets = targets
    return args


def echo_gates(report) -> bool:
    print("\n== 三门报告（回显）==")
    for key, label in GATE_LABELS:
        hits = report.violations.get(key, [])
        print(f"  {label:<16} {'PASS' if not hits else 'FAIL'}")
        for v in hits:
            print(f"    - {v}")
    return report.passed


def incubate_rpc(params: dict) -> dict:
    port = os.environ.get("A2A_PROFILE_PORT", "8790")
    token = os.environ.get("A2A_PROFILE_TOKEN", "")
    url = f"http://127.0.0.1:{port}/"
    body = json.dumps(
        {"jsonrpc": "2.0", "id": 1, "method": "incubate", "params": params}
    ).encode()
    req = urllib.request.Request(url, data=body,
                                 headers={"Content-Type": "application/json"})
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.URLError as e:
        print(f"[wizard] incubate 端点不可达 {url}: {e.reason}", file=sys.stderr)
        print("[wizard] 前置：dsh 宿主加载 a2a-profile-server 插件（boot 即起 127.0.0.1:8790）。",
              file=sys.stderr)
        raise SystemExit(3)

def _finish_incubate(out: dict) -> int:
    """incubate 回执处理与回显（derive 与非 derive 共用尾部）。"""
    if "error" in out:
        err = out["error"]
        print(f"[wizard] incubate 失败: {err.get('code')} {err.get('message')}",
              file=sys.stderr)
        raise SystemExit(4)

    result = out["result"]
    profile, receipts = result["profile"], result["receipts"]

    # 产物回执回显（name + version + receipts）
    print("\n== 孵化回执 ==")
    print(f"  name:    {profile.get('name')}")
    print(f"  version: {profile.get('version')}")
    for r in receipts:
        print(f"  receipt: {json.dumps(r, ensure_ascii=False)}")
    print("INCUBATION-RECEIPT]" + json.dumps(
        {"name": profile.get("name"), "version": profile.get("version"),
         "receipts": receipts}, ensure_ascii=False))
    return 0


def run_derive(args, Projector, ProjectionError, run_gates,
               grill_checklist, sanitize_mustache) -> int:
    """--derive 派生流（queen）：grill 清单→合并答案→消毒→投影→三门→lineage 入池。

    本函数只做参数构造与纯函数调用；RPC 面由插件票（N10-T3）消费 lineage。
    """
    checklist = grill_checklist(args.scenario)
    print("\n== grill 追问清单（供 queen 会话内向用户转述；建议值=场景先验推断，用户终审）==")
    for i, item in enumerate(checklist, 1):
        print(f"  {i:>2}. [{item['key']}] {item['question']}")
        print(f"      建议值: {item['suggested']}")

    filled = sum(1 for item in checklist if item["key"] in args.answers)
    merged = {
        item["key"]: sanitize_mustache(args.answers.get(item["key"], item["suggested"]))
        for item in checklist
    }
    role = next(
        (r for r in ROLES if r in merged.get("agent_role", "")), "worker"
    )
    print(f"\n== 派生参数 ==")
    print(f"  role={role}（取自答案 agent_role，缺省 worker）  "
          f"parent={args.parent or '(无)'}")
    print(f"  answers: 用户已答 {filled}/{len(checklist)} 维，缺维取建议值；答案已过 '{{' 消毒")

    try:
        proj = asyncio.run(Projector(model=args.model).project(
            args.scenario,
            answers=[f"{k}: {v}" for k, v in merged.items()],
            role=role,
        ))
    except ProjectionError as e:
        print(f"[wizard] 派生投影失败（三门重试耗尽）: {e}", file=sys.stderr)
        raise SystemExit(2)

    print("\n== 投影产物 ==")
    print(f"  description: {proj.description.strip()[:120]}")
    print(f"  agents_md: {len(proj.agents_md)} chars  "
          f"agent_role={proj.profile_json.get('agent_role')}")

    # 三门报告回显（终产物逐门复核；projector 已内部过门，此处为零漂移复核）
    if not echo_gates(run_gates(proj.agents_md)):
        print("[wizard] 三门未过（不应发生：projector 已内部过门）", file=sys.stderr)
        raise SystemExit(2)

    out = incubate_rpc({
        "name": args.name,
        "targets": args.targets,
        "role": role,
        "projection": {
            "agents_md": proj.agents_md,
            "profile_json": proj.profile_json,
            "description": proj.description,
        },
        # 插件侧 N10-T3 才消费 lineage；当前多余参数被无害忽略
        "lineage": {"derived-by": "queen", "parent": args.parent or ""},
    })
    return _finish_incubate(out)



def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    # 环境适配：宿主 shell 常带 SOCKS 代理（ALL_PROXY=socks5://…）而 httpx 未装
    # socksio，构造客户端即 ImportError；GLM 端点国内直连，剥掉 SOCKS 变量即可。
    for _k in ("ALL_PROXY", "all_proxy"):
        os.environ.pop(_k, None)

    print("== 向导参数 ==")
    print(f"  scenario: {args.scenario}")
    print(f"  name={args.name}  role={args.role}  "
          f"targets={args.targets}  model={args.model or '(缺省)'}")

    sys.path.insert(0, str(REPO_DIR))
    try:
        from rt_projector import (Projector, ProjectionError, grill_checklist,
                                  sanitize_mustache)
        from rt_projection_gates import run_gates
    except ImportError as e:
        print(f"[wizard] 无法导入投影器（{REPO_DIR}）: {e}", file=sys.stderr)
        raise SystemExit(1)

    missing = [k for k, ok in Projector.check_sources().items() if not ok]
    if missing:
        print(f"[wizard] 投影原料缺失 {missing}（~/文档/context-files 只读源）",
              file=sys.stderr)
        raise SystemExit(1)

    if args.derive:
        return run_derive(args, Projector, ProjectionError, run_gates,
                          grill_checklist, sanitize_mustache)

    # 投影（含 role doctrine 注入；内部三门失败升温重试 ≤2，耗尽抛 ProjectionError）
    try:
        proj = asyncio.run(Projector(model=args.model).project(
            args.scenario, role=args.role))
    except ProjectionError as e:
        print(f"[wizard] 投影失败（三门重试耗尽）: {e}", file=sys.stderr)
        raise SystemExit(2)

    print("\n== 投影产物 ==")
    print(f"  description: {proj.description.strip()[:120]}")
    print(f"  agents_md: {len(proj.agents_md)} chars  "
          f"agent_role={proj.profile_json.get('agent_role')}")

    # 三门报告回显（终产物逐门复核；projector 已内部过门，此处为零漂移复核）
    if not echo_gates(run_gates(proj.agents_md)):
        print("[wizard] 三门未过（不应发生：projector 已内部过门）", file=sys.stderr)
        raise SystemExit(2)

    return _finish_incubate(incubate_rpc({
        "name": args.name,
        "targets": args.targets,
        "role": args.role,
        "projection": {
            "agents_md": proj.agents_md,
            "profile_json": proj.profile_json,
            "description": proj.description,
        },
    }))


if __name__ == "__main__":
    raise SystemExit(main())
