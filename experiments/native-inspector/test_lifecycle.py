"""Controlled cleanup regressions, not a claim of real LLDB execution."""
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import MagicMock, patch

sys.modules.setdefault("lldb", types.SimpleNamespace(SBError=MagicMock))
import native_hierarchy as native


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="rea-native-lifecycle-")
        self.addCleanup(self.temp.cleanup)
        self.output = str(Path(self.temp.name) / "capture.json")
        self.debugger = MagicMock()
        self.process = self.debugger.CreateTarget.return_value.AttachToProcessWithID.return_value
        self.process.Detach.return_value.Fail.return_value = False
        thread = MagicMock()
        thread.GetQueueName.return_value = "com.apple.main-thread"
        self.process.__iter__.return_value = iter([thread])

    def capture(self):
        error = MagicMock()
        error.Fail.return_value = False
        with patch.object(native.lldb, "SBError", return_value=error):
            native.capture_attached(self.debugger, "/debug/fixture", 123, "1:2", "/debug/reader", self.output)

    def test_collect_failure_still_detaches_and_resumes_same_lifetime(self):
        with patch.object(native, "require_identity") as identity, \
                patch.object(native, "collect", side_effect=RuntimeError("probe failed")), \
                patch.object(native.os, "kill") as kill:
            with self.assertRaisesRegex(RuntimeError, "probe failed"):
                self.capture()
            self.process.Detach.assert_called_once_with(False)
            self.assertEqual(identity.call_count, 3)
            kill.assert_called_once_with(123, native.signal.SIGCONT)
            self.assertFalse(Path(self.output).exists())

    def test_reused_pid_is_never_resumed(self):
        with patch.object(native, "require_identity", side_effect=[None, None, RuntimeError("lifetime changed")]), \
                patch.object(native, "collect", return_value={}), \
                patch.object(native.os, "kill") as kill:
            with self.assertRaisesRegex(RuntimeError, "lifetime changed"):
                self.capture()
            kill.assert_not_called()
            self.assertFalse(Path(self.output).exists())

    def test_detach_failure_is_not_published_as_completed_capture(self):
        self.process.Detach.return_value.Fail.return_value = True
        with patch.object(native, "require_identity"), patch.object(native, "collect", return_value={}), \
                patch.object(native.os, "kill") as kill:
            with self.assertRaisesRegex(RuntimeError, "cleanup is unresolved"):
                self.capture()
            kill.assert_not_called()
            self.assertFalse(Path(self.output).exists())

    def test_success_publishes_only_after_resume(self):
        def resumed(*_):
            self.assertFalse(Path(self.output).exists())
        with patch.object(native, "require_identity"), \
                patch.object(native, "collect", return_value={"windows": [], "truncated": False}), \
                patch.object(native.os, "kill", side_effect=resumed):
            self.capture()
        self.assertEqual(json.loads(Path(self.output).read_text())["process_identity"], "1:2")

    def test_unavailable_identity_fails_closed(self):
        response = types.SimpleNamespace(stdout=json.dumps({"results": [{"pid": 123, "state": "unavailable"}]}))
        with patch.object(native.subprocess, "run", return_value=response):
            with self.assertRaisesRegex(RuntimeError, "lifetime changed or is unknown"):
                native.require_identity("/debug/reader", 123, "1:2")


if __name__ == "__main__":
    unittest.main()
