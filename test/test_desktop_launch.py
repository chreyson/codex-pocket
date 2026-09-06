import plistlib
import json
import tempfile
import types
from pathlib import Path
import unittest
from unittest.mock import patch

import install_desktop_launch as launch


class DesktopLaunchTests(unittest.TestCase):
    def test_login_agent_only_sets_launch_environment(self):
        config = plistlib.loads(plistlib.dumps(launch.launch_agent("/path with spaces/node")))
        self.assertEqual(config["ProgramArguments"], ["/path with spaces/node", str(launch.ROOT / "scripts/desktop-auto-connect.mjs"), "--activate"])
        self.assertTrue(config["RunAtLoad"])
        self.assertNotIn("KeepAlive", config)

    def test_uninstall_preserves_later_user_environment_changes(self):
        previous = dict(zip(launch.ENV_NAMES, ["", "/original/cli"]))
        installed = dict(zip(launch.ENV_NAMES, ["1", "/pocket/cli"]))
        with patch.object(launch, "read_environment", return_value={**installed, "CODEX_CLI_PATH": "/new/user/cli"}), patch.object(launch, "run") as run:
            launch.restore_environment(previous, installed)
        run.assert_called_once_with("/bin/launchctl", "unsetenv", "CODEX_APP_SERVER_FORCE_CLI")

    def test_uninstall_restores_original_values(self):
        previous = dict(zip(launch.ENV_NAMES, ["", "/original/cli"]))
        installed = dict(zip(launch.ENV_NAMES, ["1", "/pocket/cli"]))
        with patch.object(launch, "read_environment", return_value=installed), patch.object(launch, "run") as run:
            launch.restore_environment(previous, installed)
        self.assertEqual(run.call_count, 2)
        run.assert_any_call("/bin/launchctl", "setenv", "CODEX_CLI_PATH", "/original/cli")

    def test_windows_install_is_repeatable_and_uninstall_preserves_user_changes(self):
        registry = {name: None for name in launch.ENV_NAMES}
        registry["CODEX_CLI_PATH"] = {"value": "%LOCALAPPDATA%\\original.exe", "kind": 2}
        original = registry.copy()
        environment = dict(zip(launch.ENV_NAMES, ["1", "C:\\Pocket\\proxy.exe"]))
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(launch, "ROOT", Path(directory)),
            patch.dict("sys.modules", {"winreg": types.SimpleNamespace(REG_SZ=1)}),
            patch.object(launch, "windows_environment", side_effect=lambda: registry.copy()),
            patch.object(launch, "write_windows_environment", side_effect=registry.update),
            patch.object(launch, "notify_windows_environment") as notify,
            patch.object(launch, "proxy_environment", return_value=environment),
            patch("builtins.print"),
        ):
            launch.install_windows(False, "node.exe", "codex.exe")
            launch.install_windows(False, "node.exe", "codex.exe")
            self.assertEqual(notify.call_count, 1)
            state = json.loads((Path(directory) / ".data/desktop-launch-environment.json").read_text())
            self.assertEqual(state["previous"], original)
            custom = {"value": "C:\\Custom\\cli.exe", "kind": 1}
            registry["CODEX_CLI_PATH"] = custom
            launch.install_windows(True, None, None)
            self.assertIsNone(registry["CODEX_APP_SERVER_FORCE_CLI"])
            self.assertEqual(registry["CODEX_CLI_PATH"], custom)

    def test_windows_notification_failure_restores_registry_and_backup(self):
        registry = {name: None for name in launch.ENV_NAMES}
        original = registry.copy()
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(launch, "ROOT", Path(directory)),
            patch.dict("sys.modules", {"winreg": types.SimpleNamespace(REG_SZ=1)}),
            patch.object(launch, "windows_environment", side_effect=lambda: registry.copy()),
            patch.object(launch, "write_windows_environment", side_effect=registry.update),
            patch.object(launch, "notify_windows_environment", side_effect=RuntimeError("timeout")),
            patch.object(launch, "proxy_environment", return_value=dict(zip(launch.ENV_NAMES, ["1", "proxy.exe"]))),
        ):
            with self.assertRaisesRegex(RuntimeError, "timeout"):
                launch.install_windows(False, "node.exe", "codex.exe")
            self.assertEqual(registry, original)
            self.assertFalse((Path(directory) / ".data/desktop-launch-environment.json").exists())
