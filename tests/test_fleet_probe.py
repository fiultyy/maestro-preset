#!/usr/bin/env python3
"""fleet-probe 签名 freshness 收紧的单测(ticket D3, 伪 registry 双场景)。

被测面: registry_session_ids() / check_sig_freshness() / orch_sig() 的收紧钩子。
场景: ①签名 sessionId 在册 → 放行 ②不在册 → 拒收 exit 8(红线: registry 只读)
     ③registry 缺失(首装) → 回落现状不拒 ④orch_sig 文件源同样受检。

运行: python3 -m unittest tests.test_fleet_probe -v
"""
import importlib.util
import io
import json
import os
import contextlib
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


def load_module():
    """按脚本路径(无 .py 后缀)加载 bin/fleet-probe 为模块;main 有 __name__ 守卫,安全。"""
    spec = importlib.util.spec_from_loader(
        'fleet_probe_under_test',
        importlib.machinery.SourceFileLoader('fleet_probe_under_test', str(REPO / 'bin' / 'fleet-probe')))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class SigFreshnessTestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.bridge = Path(self.tmp.name) / 'bridge'
        self.bridge.mkdir()
        mod = load_module()
        # 模块常量在 import 时解析; 测试直接改模块属性指向伪 bridge
        mod.REGISTRY = str(self.bridge / 'registry.json')
        mod.HOME = self.tmp.name  # orch_sig() 的 orch.signature 兜底也落在伪 HOME
        self.mod = mod
        self.registry_before = None

    def tearDown(self):
        # 红线: registry 只读 — 记录路径集合, 收尾断言未被新建/删除/改写
        if self.registry_before is not None:
            now = self._registry_stat()
            self.assertEqual(now, self.registry_before,
                             'registry.json must stay byte-identical (read-only red line)')
        self.tmp.cleanup()

    def _registry_stat(self):
        reg = self.bridge / 'registry.json'
        if not reg.exists():
            return None
        return (reg.read_bytes(), reg.stat().st_mode)

    def write_registry(self, session_ids):
        payload = {"version": "3.6.0", "consumers": {
            sid: {"alias": "orch1", "pid": 1, "armedAt": "2026-08-17T00:00:00Z"}
            for sid in session_ids}}
        (self.bridge / 'registry.json').write_text(json.dumps(payload))

    def snapshot_registry(self):
        self.registry_before = self._registry_stat()


class ScenarioInRegistryPasses(SigFreshnessTestBase):
    def test_in_registry_sig_passes(self):
        """场景①: sessionId 在册 → 放行,无 stderr 警告。"""
        self.write_registry(['session-11111111-1111-1111-1111-111111111111'])
        self.snapshot_registry()
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self.mod.check_sig_freshness('orch1@session-11111111-1111-1111-1111-111111111111')
        self.assertEqual(err.getvalue(), '')


class ScenarioNotRegisteredRejected(SigFreshnessTestBase):
    def test_stale_sig_rejected_exit8(self):
        """场景②(T12 现场): sessionId 不在册 → SystemExit 8 + 刷新 env 提示。"""
        self.write_registry(['session-22222222-2222-2222-2222-222222222222'])
        self.snapshot_registry()
        err = io.StringIO()
        with contextlib.redirect_stderr(err), self.assertRaises(SystemExit) as ctx:
            self.mod.check_sig_freshness('orch1@session-c63bfd0f-3333-4726-87fd-4623ebee72e4')
        self.assertEqual(ctx.exception.code, 8)
        self.assertIn('stale orch signature', err.getvalue())
        self.assertIn('MAESTRO_ORCH_SIGNATURE', err.getvalue())

    def test_empty_consumers_rejects(self):
        """在册集合为空 = 无任何武装编排者, 同样拒收。"""
        self.write_registry([])
        self.snapshot_registry()
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as ctx:
            self.mod.check_sig_freshness('orch1@session-33333333-3333-3333-3333-333333333333')
        self.assertEqual(ctx.exception.code, 8)

    def test_corrupt_registry_falls_back(self):
        """损坏 JSON → 视同缺失, 回落不拒(只 stderr 警告)。"""
        (self.bridge / 'registry.json').write_text('{not json')
        self.snapshot_registry()
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self.mod.check_sig_freshness('orch1@session-any')
        self.assertIn('warn:', err.getvalue())


class ScenarioNoRegistryFallsBack(SigFreshnessTestBase):
    def test_missing_registry_passes_with_warn(self):
        """场景③(红线): registry 缺失(首装未武装) → 回落现状不拒。"""
        self.snapshot_registry()  # None: 文件不存在, 收尾断言仍未被创建
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self.mod.check_sig_freshness('orch1@session-anything')
        self.assertIn('warn:', err.getvalue())
        self.assertIn('skipping signature freshness check', err.getvalue())


class OrchSigHookTest(SigFreshnessTestBase):
    def test_env_sig_goes_through_freshness(self):
        """orch_sig() 的 env 源签名同样过检(T12 现场: 旧 env 签名被拒)。"""
        self.write_registry(['session-44444444-4444-4444-4444-444444444444'])
        self.snapshot_registry()
        os.environ['MAESTRO_ORCH_SIGNATURE'] = 'orch1@session-c63bfd0f-3333-4726-87fd-4623ebee72e4'
        try:
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as ctx:
                self.mod.orch_sig()
            self.assertEqual(ctx.exception.code, 8)
        finally:
            del os.environ['MAESTRO_ORCH_SIGNATURE']

    def test_file_sig_goes_through_freshness(self):
        """orch_sig() 的 orch.signature 文件兜底源同样受检(env 未设时)。"""
        self.write_registry(['session-55555555-5555-5555-5555-555555555555'])
        sig_path = Path(self.tmp.name) / 'maestro' / 'bridge'
        sig_path.mkdir(parents=True)
        (sig_path / 'orch.signature').write_text(
            'orch1@session-c63bfd0f-3333-4726-87fd-4623ebee72e4')
        self.snapshot_registry()
        os.environ.pop('MAESTRO_ORCH_SIGNATURE', None)
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as ctx:
            self.mod.orch_sig()
        self.assertEqual(ctx.exception.code, 8)


if __name__ == '__main__':
    unittest.main()
