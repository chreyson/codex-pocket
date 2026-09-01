import json
import os
import runpy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import setup_codex_pocket as setup


class PosixSetupTests(unittest.TestCase):
    def test_inaccessible_runtime_candidates_are_skipped(self):
        with patch("setup_codex_pocket.Path.is_file", side_effect=PermissionError("denied")):
            self.assertIsNone(setup.resolve_candidate("/locked/bin/node", []))

    def test_macos_search_path_includes_homebrew_and_version_managers(self):
        directories = {str(path) for path in setup.common_bin_directories("Darwin")}

        self.assertIn(str(Path("/opt/homebrew/bin")), directories)
        self.assertIn(str(Path.home() / ".volta" / "bin"), directories)
        self.assertIn(str(Path.home() / ".asdf" / "shims"), directories)
        self.assertIn(str(Path.home() / "miniconda3" / "bin"), directories)

    def test_node_discovery_skips_versions_older_than_20(self):
        candidates = [Path("/old/bin/node"), Path("/new/bin/node")]
        with (
            patch("setup_codex_pocket.command_candidates", return_value=candidates),
            patch(
                "setup_codex_pocket.command_output",
                side_effect=["v18.20.0", "v22.14.0"],
            ),
        ):
            path, version = setup.resolve_node({})

        self.assertEqual(path, str(candidates[1]))
        self.assertEqual(version, "22.14.0")

    def test_portable_environment_prepends_explicit_runtime_directories(self):
        environment = setup.portable_environment(
            ["/portable/node/bin/node", "/portable/codex/bin/codex"]
        )
        entries = environment["PATH"].split(os.pathsep)

        self.assertEqual(entries[0], str(Path("/portable/node/bin")))
        self.assertEqual(entries[1], str(Path("/portable/codex/bin")))

    def test_linux_installs_local_qt_backend_when_gtk_is_unavailable(self):
        with (
            patch(
                "setup_codex_pocket.probe_python",
                side_effect=[True, False, False, True],
            ),
            patch("setup_codex_pocket.run_pip") as run_pip,
            patch("builtins.print"),
        ):
            backend = setup.ensure_desktop_dependencies("Linux")

        self.assertEqual(backend, "qt")
        run_pip.assert_called_once_with(["pywebview[pyside6]>=5.4,<6"])

    def test_macos_uses_the_cocoa_backend(self):
        with (
            patch("setup_codex_pocket.probe_python", side_effect=[True, True]),
            patch("setup_codex_pocket.run_pip") as run_pip,
        ):
            backend = setup.ensure_desktop_dependencies("Darwin")

        self.assertEqual(backend, "cocoa")
        run_pip.assert_not_called()

    def test_runtime_config_round_trips_unicode_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Path(directory) / "路径" / "runtime.json"
            with patch("setup_codex_pocket.RUNTIME_CONFIG_PATH", runtime):
                setup.write_runtime_config(
                    "/opt/Node 安装/bin/node",
                    "22.0.0",
                    "/opt/Codex 安装/bin/codex",
                )
                value = json.loads(runtime.read_text(encoding="utf-8"))

        self.assertEqual(value["Node"]["Path"], "/opt/Node 安装/bin/node")
        self.assertEqual(value["Codex"]["Path"], "/opt/Codex 安装/bin/codex")
        self.assertEqual(value["Python"]["Path"], str(Path(setup.sys.executable).absolute()))

    def test_linux_gui_launch_requires_a_display(self):
        environment = os.environ.copy()
        environment.pop("DISPLAY", None)
        environment.pop("WAYLAND_DISPLAY", None)
        with patch.dict(os.environ, environment, clear=True):
            with self.assertRaisesRegex(RuntimeError, "图形会话"):
                setup.launch_desktop(
                    "/usr/bin/node",
                    "/usr/bin/codex",
                    system_name="Linux",
                )

    def test_headless_launch_runs_the_core_service_in_the_foreground(self):
        with patch("setup_codex_pocket.subprocess.call", return_value=0) as call:
            setup.launch_desktop(
                "/usr/bin/node",
                "/usr/bin/codex",
                headless=True,
                system_name="Linux",
            )

        command = call.call_args.args[0]
        self.assertTrue(command[-2].endswith("codex_pocket.py"))
        self.assertEqual(command[-1], "--headless")
        self.assertEqual(call.call_args.kwargs["env"]["NODE_BIN"], "/usr/bin/node")

    def test_core_module_imports_without_tkinter(self):
        original_import = __import__

        def import_without_tkinter(name, *args, **kwargs):
            if name == "tkinter" or name.startswith("tkinter."):
                raise ImportError("tkinter is intentionally unavailable")
            return original_import(name, *args, **kwargs)

        project_root = Path(__file__).resolve().parents[1]
        with patch("builtins.__import__", side_effect=import_without_tkinter):
            namespace = runpy.run_path(
                str(project_root / "codex_pocket.py"),
                run_name="codex_pocket_without_tkinter",
            )

        self.assertIsNone(namespace["tk"])
        self.assertIs(namespace["TkCanvasBase"], object)

    def test_unix_launchers_are_root_relative(self):
        project_root = Path(__file__).resolve().parents[1]
        installer = (project_root / "Install-CodexPocket.sh").read_text(
            encoding="utf-8"
        )
        launcher = (project_root / "CodexPocket.sh").read_text(encoding="utf-8")
        mac_installer = (project_root / "Install-CodexPocket.command").read_text(
            encoding="utf-8"
        )

        self.assertTrue(installer.startswith("#!/bin/sh\n"))
        self.assertIn('VENV_DIR="$SCRIPT_DIR/.venv"', installer)
        self.assertIn("setup_codex_pocket.py\" --install --start", installer)
        self.assertIn('VENV_PYTHON="$SCRIPT_DIR/.venv/bin/python"', launcher)
        self.assertIn("setup_codex_pocket.py\" --start", launcher)
        self.assertIn('Install-CodexPocket.sh" "$@"', mac_installer)


if __name__ == "__main__":
    unittest.main()
