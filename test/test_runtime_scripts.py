import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


class LauncherContractTests(unittest.TestCase):
    @unittest.skipIf(os.name == "nt", "POSIX shell launcher")
    def test_first_headless_launch_preserves_arguments_from_another_directory(self):
        project_root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "project with spaces"
            root.mkdir()
            shutil.copyfile(project_root / "CodexPocket.sh", root / "CodexPocket.sh")
            (root / "Install-CodexPocket.sh").write_text(
                '#!/bin/sh\nprintf "%s\\n" "$@"\n', encoding="utf-8",
            )
            result = subprocess.run(
                ["/bin/sh", str(root / "CodexPocket.sh"), "--headless"],
                cwd=directory, capture_output=True, text=True, timeout=10,
            )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "--headless")

    @unittest.skipIf(os.name == "nt", "POSIX shell launcher")
    def test_check_without_a_venv_does_not_start_the_installer(self):
        project_root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as directory:
            launcher = Path(directory) / "CodexPocket.sh"
            shutil.copyfile(project_root / "CodexPocket.sh", launcher)
            result = subprocess.run(
                ["/bin/sh", str(launcher), "--check"],
                cwd=directory, capture_output=True, text=True, timeout=10,
            )
        self.assertEqual(result.returncode, 1)
        self.assertIn("environment is missing", result.stderr)

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
    def test_npm_powershell_shim_resolves_to_verified_native_executable(self):
        project_root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            shim = root / "codex.ps1"
            shim.touch()
            (root / "codex.cmd").touch()
            native = root / "node_modules/@openai/codex/vendor/test/codex/codex.exe"
            native.parent.mkdir(parents=True)
            shutil.copyfile(shutil.which("node"), native)
            environment = {**os.environ, "CODEX_BIN": str(shim),
                           "POCKET_TEST_HELPER": str(project_root / "CodexPocket.Runtime.ps1"),
                           "POCKET_TEST_NATIVE": str(native)}
            result = subprocess.run([
                "powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
                ". $env:POCKET_TEST_HELPER; $resolved = Resolve-PocketCodex; "
                "if ((Resolve-Path -LiteralPath $resolved).Path -ine (Resolve-Path -LiteralPath $env:POCKET_TEST_NATIVE).Path) { throw ('Unexpected CLI: ' + $resolved) }",
            ], env=environment, capture_output=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", errors="replace"))

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
