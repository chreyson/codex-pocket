import os
import subprocess
import tempfile
import unittest
from pathlib import Path


class LauncherContractTests(unittest.TestCase):
    def test_double_click_launchers_are_root_relative_and_keep_failures_visible(self):
        project_root = Path(__file__).resolve().parents[1]
        installer = (project_root / "Install-CodexPocket.cmd").read_text(
            encoding="utf-8"
        )
        launcher = (project_root / "CodexPocket.cmd").read_text(encoding="utf-8")

        self.assertIn('cd /d "%~dp0"', installer)
        self.assertIn('-File "%~dp0Setup-CodexPocket.ps1"', installer)
        self.assertIn("-Start", installer)
        self.assertIn("if not defined CODEX_POCKET_NO_PAUSE pause", installer)

        self.assertIn('cd /d "%~dp0"', launcher)
        self.assertIn('-File "%~dp0Start-CodexPocket.ps1"', launcher)
        self.assertIn("if not defined CODEX_POCKET_NO_PAUSE pause", launcher)


@unittest.skipUnless(os.name == "nt", "Windows PowerShell runtime configuration")
class RuntimeScriptTests(unittest.TestCase):
    def test_runtime_config_round_trips_unicode_paths(self):
        project_root = Path(__file__).resolve().parents[1]
        helper = project_root / "CodexPocket.Runtime.ps1"
        powershell = Path(os.environ.get("SystemRoot", r"C:\Windows")) / (
            r"System32\WindowsPowerShell\v1.0\powershell.exe"
        )

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "runtime path 测试"
            root.mkdir()
            runtime = root / "runtime.json"
            python_path = root / "Python 安装" / "python.exe"
            node_path = root / "Node 安装" / "node.exe"
            codex_path = root / "Codex 安装" / "codex.cmd"
            environment = os.environ.copy()
            environment.update(
                {
                    "POCKET_TEST_HELPER": str(helper),
                    "POCKET_TEST_RUNTIME": str(runtime),
                    "POCKET_TEST_PYTHON": str(python_path),
                    "POCKET_TEST_NODE": str(node_path),
                    "POCKET_TEST_CODEX": str(codex_path),
                }
            )
            script = """
. $env:POCKET_TEST_HELPER
$python = [pscustomobject]@{ Command = $env:POCKET_TEST_PYTHON; Version = '3.11.0' }
$node = [pscustomobject]@{ Path = $env:POCKET_TEST_NODE; Version = '22.0.0' }
Write-PocketRuntimeConfig -Path $env:POCKET_TEST_RUNTIME -Python $python -Node $node -Codex $env:POCKET_TEST_CODEX
$config = Read-PocketRuntimeConfig $env:POCKET_TEST_RUNTIME
if ((Get-PocketRuntimePath $config 'Python') -cne $env:POCKET_TEST_PYTHON) { throw 'Python path changed' }
if ((Get-PocketRuntimePath $config 'Node') -cne $env:POCKET_TEST_NODE) { throw 'Node path changed' }
if ((Get-PocketRuntimePath $config 'Codex') -cne $env:POCKET_TEST_CODEX) { throw 'Codex path changed' }
"""
            result = subprocess.run(
                [
                    str(powershell),
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-Command",
                    script,
                ],
                cwd=project_root,
                env=environment,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=20,
                check=False,
            )

        self.assertEqual(result.returncode, 0, result.stdout)


if __name__ == "__main__":
    unittest.main()
