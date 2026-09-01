import io
import json
import os
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from codex_pocket import (
    ServiceManager,
    SingleInstanceLock,
    cloudflared_download_spec,
    constrain_tooltip_position,
    dpi_scale,
    enable_windows_dpi_awareness,
    ensure_cloudflared,
    find_codex,
    find_node,
    hidden_process_options,
    monitor_work_area_for_point,
    parse_tunnel_url,
    runtime_configured_path,
    run_headless,
    terminate_process_tree,
    window_position,
)


class DesktopControllerTests(unittest.TestCase):
    def test_headless_mode_exits_and_cleans_up_after_service_failure(self):
        instances = []

        class FakeManager:
            def __init__(self, on_status, on_ready, on_failure):
                self.on_status = on_status
                self.on_ready = on_ready
                self.on_failure = on_failure
                self.shutdown_requested = False
                self.stopped = False
                instances.append(self)

            def start(self):
                self.on_failure("tunnel exited")

            def request_shutdown(self):
                self.shutdown_requested = True

            def stop(self):
                self.stopped = True

        with patch("builtins.print"):
            self.assertEqual(
                run_headless(FakeManager, install_signal_handlers=False),
                1,
            )
        self.assertTrue(instances[0].shutdown_requested)
        self.assertTrue(instances[0].stopped)

    def test_tunnel_state_updates_even_when_log_writes_fail(self):
        manager = ServiceManager(lambda _value: None, lambda _url, _key: None, lambda _error: None)
        run = manager._Run()
        manager._run = run
        stream = io.StringIO(
            "https://mobile-test.trycloudflare.com\nRegistered tunnel connection\n"
        )

        with patch.object(manager, "_log", side_effect=OSError("disk full")):
            manager._read_stream("tunnel", stream, run)

        self.assertEqual(manager.public_url, "https://mobile-test.trycloudflare.com")
        self.assertTrue(manager._url_event.is_set())
        self.assertTrue(manager._connected_event.is_set())

    def test_inaccessible_runtime_path_is_ignored(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Path(directory) / "runtime.json"
            runtime.write_text(
                json.dumps({"Codex": {"Path": "C:\\locked\\codex.exe"}}),
                encoding="utf-8",
            )
            with (
                patch("codex_pocket.RUNTIME_CONFIG_PATH", runtime),
                patch("codex_pocket.Path.is_file", side_effect=PermissionError("denied")),
            ):
                self.assertIsNone(runtime_configured_path("Codex"))

    def test_runtime_config_supplies_node_and_codex_outside_shell_path(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            node = root / "node.exe"
            codex_ps1 = root / "codex.ps1"
            codex_cmd = root / "codex.cmd"
            runtime = root / "runtime.json"
            node.touch()
            codex_ps1.touch()
            codex_cmd.touch()
            runtime.write_text(
                json.dumps(
                    {
                        "Node": {"Path": str(node)},
                        "Codex": {"Path": str(codex_ps1)},
                    }
                ),
                encoding="utf-8",
            )

            with (
                patch("codex_pocket.RUNTIME_CONFIG_PATH", runtime),
                patch.dict(os.environ, {"NODE_BIN": "", "CODEX_BIN": ""}),
                patch("codex_pocket.shutil.which", return_value=None),
            ):
                self.assertEqual(find_node(), str(node))
                self.assertEqual(find_codex(), str(codex_cmd))

    def test_stale_runtime_config_falls_back_to_current_path(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Path(directory) / "runtime.json"
            runtime.write_text(
                json.dumps(
                    {
                        "Node": {"Path": str(Path(directory) / "missing-node.exe")},
                        "Codex": {"Path": str(Path(directory) / "missing-codex.exe")},
                    }
                ),
                encoding="utf-8",
            )

            def which(name):
                return {"node": "node-from-path", "codex": "codex-from-path"}.get(name)

            with (
                patch("codex_pocket.RUNTIME_CONFIG_PATH", runtime),
                patch.dict(os.environ, {"NODE_BIN": "", "CODEX_BIN": ""}),
                patch("codex_pocket.shutil.which", side_effect=which),
            ):
                self.assertEqual(find_node(), "node-from-path")
                self.assertEqual(find_codex(), "codex-from-path")

    def test_downloads_cloudflared_with_progress_and_verifies_it(self):
        class FakeResponse:
            headers = {"Content-Length": str(2 * 1024 * 1024)}

            def __init__(self):
                self.chunks = [b"a" * 1024 * 1024, b"b" * 1024 * 1024, b""]

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self, _size):
                return self.chunks.pop(0)

        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "cloudflared.exe"
            statuses = []
            with (
                patch("codex_pocket.shutil.which", return_value=None),
                patch("codex_pocket.local_cloudflared_path", return_value=target),
                patch(
                    "codex_pocket.cloudflared_download_spec",
                    return_value=("https://example.test/cloudflared.exe", False),
                ),
                patch("codex_pocket.urllib.request.urlopen", return_value=FakeResponse()),
                patch("codex_pocket.subprocess.run") as verify,
            ):
                result = ensure_cloudflared(statuses.append)

            self.assertEqual(result, str(target))
            self.assertEqual(target.stat().st_size, 2 * 1024 * 1024)
            self.assertTrue(any("50%" in status for status in statuses))
            self.assertTrue(any("100%" in status for status in statuses))
            self.assertEqual(statuses[-1], "公网组件下载完成，正在校验")
            verify.assert_called_once()

    def test_cloudflared_download_timeout_removes_partial_file(self):
        class FakeResponse:
            headers = {}

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self, _size):
                raise AssertionError("deadline should be checked before reading")

        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "cloudflared.exe"
            download = target.with_suffix(".exe.download")
            with (
                patch("codex_pocket.shutil.which", return_value=None),
                patch("codex_pocket.local_cloudflared_path", return_value=target),
                patch(
                    "codex_pocket.cloudflared_download_spec",
                    return_value=("https://example.test/cloudflared.exe", False),
                ),
                patch("codex_pocket.urllib.request.urlopen", return_value=FakeResponse()),
                patch("codex_pocket.time.monotonic", side_effect=[0, 601]),
            ):
                with self.assertRaisesRegex(RuntimeError, "超过 10 分钟"):
                    ensure_cloudflared(lambda _message: None)

            self.assertFalse(target.exists())
            self.assertFalse(download.exists())

    def test_oversized_cloudflared_download_is_rejected_before_writing(self):
        class FakeResponse:
            headers = {"Content-Length": str(512 * 1024 * 1024)}

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self, _size):
                raise AssertionError("oversized content should not be read")

        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "cloudflared.exe"
            with (
                patch("codex_pocket.shutil.which", return_value=None),
                patch("codex_pocket.local_cloudflared_path", return_value=target),
                patch(
                    "codex_pocket.cloudflared_download_spec",
                    return_value=("https://example.test/cloudflared.exe", False),
                ),
                patch("codex_pocket.urllib.request.urlopen", return_value=FakeResponse()),
            ):
                with self.assertRaisesRegex(RuntimeError, "内容过大"):
                    ensure_cloudflared(lambda _message: None)

            self.assertFalse(target.exists())
            self.assertFalse(target.with_suffix(".exe.download").exists())

    def test_invalid_cached_cloudflared_is_replaced(self):
        class FakeResponse:
            headers = {"Content-Length": "5"}

            def __init__(self):
                self.chunks = [b"valid", b""]

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self, _size):
                return self.chunks.pop(0)

        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "cloudflared.exe"
            target.write_bytes(b"invalid")
            statuses = []
            verification_error = subprocess.CalledProcessError(1, [str(target), "--version"])
            with (
                patch("codex_pocket.shutil.which", return_value=None),
                patch("codex_pocket.local_cloudflared_path", return_value=target),
                patch(
                    "codex_pocket.cloudflared_download_spec",
                    return_value=("https://example.test/cloudflared.exe", False),
                ),
                patch("codex_pocket.urllib.request.urlopen", return_value=FakeResponse()),
                patch(
                    "codex_pocket.subprocess.run",
                    side_effect=[verification_error, None],
                ) as verify,
            ):
                result = ensure_cloudflared(statuses.append)

            self.assertEqual(result, str(target))
            self.assertEqual(target.read_bytes(), b"valid")
            self.assertIn("本地公网组件不可用，正在重新准备", statuses)
            self.assertEqual(verify.call_count, 2)

    def test_single_instance_lock_rejects_a_second_owner(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "desktop.lock"
            first = SingleInstanceLock(path)
            second = SingleInstanceLock(path)

            self.assertTrue(first.acquire())
            self.assertFalse(second.acquire())
            first.release()
            self.assertTrue(second.acquire())
            second.release()

    @unittest.skipUnless(os.name == "nt", "Windows-specific process cleanup")
    def test_failed_taskkill_falls_back_to_direct_process_termination(self):
        class FakeProcess:
            pid = 24680

            def __init__(self):
                self.killed = False
                self.waited = False

            def poll(self):
                return None

            def kill(self):
                self.killed = True

            def wait(self, timeout):
                self.assert_timeout = timeout
                self.waited = True

        process = FakeProcess()
        failed = subprocess.CompletedProcess(["taskkill"], returncode=1)
        with patch("codex_pocket.subprocess.run", return_value=failed):
            terminate_process_tree(process)

        self.assertTrue(process.killed)
        self.assertTrue(process.waited)

    def test_parses_quick_tunnel_url(self):
        line = "INF Your quick Tunnel has been created! https://plain-field-9.trycloudflare.com"
        self.assertEqual(
            parse_tunnel_url(line),
            "https://plain-field-9.trycloudflare.com",
        )

    def test_ignores_unrelated_https_url(self):
        self.assertIsNone(parse_tunnel_url("see https://developers.cloudflare.com"))

    def test_selects_platform_downloads(self):
        windows, windows_archive = cloudflared_download_spec("Windows", "AMD64")
        macos, macos_archive = cloudflared_download_spec("Darwin", "arm64")
        linux, linux_archive = cloudflared_download_spec("Linux", "x86_64")

        self.assertTrue(windows.endswith("cloudflared-windows-amd64.exe"))
        self.assertFalse(windows_archive)
        self.assertTrue(macos.endswith("cloudflared-darwin-arm64.tgz"))
        self.assertTrue(macos_archive)
        self.assertTrue(linux.endswith("cloudflared-linux-amd64"))
        self.assertFalse(linux_archive)

    def test_scales_fixed_dimensions_for_high_dpi(self):
        self.assertEqual(dpi_scale(96), 1.0)
        self.assertEqual(dpi_scale(120), 1.25)
        self.assertEqual(dpi_scale(144), 1.5)
        self.assertEqual(dpi_scale(72), 1.0)
        self.assertEqual(dpi_scale(480), 3.0)
        self.assertEqual(dpi_scale(None), 1.0)

    def test_dpi_awareness_is_a_noop_outside_windows(self):
        self.assertFalse(enable_windows_dpi_awareness("Linux"))

    def test_tooltip_stays_on_negative_coordinate_monitor_and_flips_above(self):
        position = constrain_tooltip_position(
            x=-1820,
            y=1020,
            width=160,
            height=40,
            anchor_top=990,
            gap=8,
            work_area=(-1920, 0, 0, 1040),
        )
        self.assertEqual(position, (-1820, 942))
        self.assertEqual(window_position(*position), "-1820+942")

    def test_monitor_work_area_has_a_platform_api_fallback(self):
        fallback = (-1920, 0, 1920, 1080)
        self.assertEqual(
            monitor_work_area_for_point(-800, 400, fallback, "Linux"),
            fallback,
        )

    def test_shutdown_during_environment_check_prevents_process_spawn(self):
        manager = ServiceManager(lambda _value: None, lambda *_args: None, lambda _error: None)
        entered = threading.Event()
        release = threading.Event()
        errors = []

        def delayed_find_node():
            entered.set()
            if not release.wait(2):
                raise AssertionError("test did not release environment check")
            return "node"

        def start_manager():
            try:
                manager.start()
            except BaseException as error:
                errors.append(error)

        with (
            patch("codex_pocket.find_node", side_effect=delayed_find_node),
            patch("codex_pocket.find_codex", return_value="codex"),
            patch("codex_pocket.ensure_cloudflared", return_value="cloudflared"),
            patch("codex_pocket.subprocess.Popen") as popen,
        ):
            starter = threading.Thread(target=start_manager)
            starter.start()
            self.assertTrue(entered.wait(2))
            manager.request_shutdown()
            stopper = threading.Thread(target=manager.stop)
            stopper.start()
            release.set()
            starter.join(2)
            stopper.join(2)

        self.assertFalse(starter.is_alive())
        self.assertFalse(stopper.is_alive())
        self.assertEqual(errors, [])
        popen.assert_not_called()
        self.assertFalse(manager.running)

    def test_shutdown_after_process_registration_reaps_owned_process(self):
        class FakeProcess:
            pid = 24680

            def __init__(self):
                self.stdout = io.StringIO("")
                self.stderr = io.StringIO("")

            def poll(self):
                return None

        manager = ServiceManager(lambda _value: None, lambda *_args: None, lambda _error: None)
        viewer = FakeProcess()
        registered = threading.Event()
        release = threading.Event()
        cleanup_started = threading.Event()
        allow_cleanup = threading.Event()
        stop_returned = threading.Event()
        errors = []

        def delayed_health_check(_run, process, _port, timeout=25):
            self.assertIs(process, viewer)
            registered.set()
            if not release.wait(2):
                raise AssertionError("test did not release health check")

        def start_manager():
            try:
                manager.start()
            except BaseException as error:
                errors.append(error)

        def delayed_terminate(process):
            if process is viewer:
                cleanup_started.set()
                if not allow_cleanup.wait(2):
                    raise AssertionError("test did not release process cleanup")

        def stop_manager():
            manager.stop()
            stop_returned.set()

        with (
            patch("codex_pocket.find_node", return_value="node"),
            patch("codex_pocket.find_codex", return_value="codex"),
            patch("codex_pocket.ensure_cloudflared", return_value="cloudflared"),
            patch("codex_pocket.subprocess.Popen", return_value=viewer) as popen,
            patch.object(manager, "_wait_for_local_service", side_effect=delayed_health_check),
            patch("codex_pocket.terminate_process_tree", side_effect=delayed_terminate) as terminate,
        ):
            starter = threading.Thread(target=start_manager)
            starter.start()
            self.assertTrue(registered.wait(2))
            manager.request_shutdown()
            release.set()
            self.assertTrue(cleanup_started.wait(2))
            stopper = threading.Thread(target=stop_manager)
            stopper.start()
            self.assertFalse(stop_returned.wait(0.05))
            allow_cleanup.set()
            starter.join(2)
            stopper.join(2)

        self.assertFalse(starter.is_alive())
        self.assertFalse(stopper.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(popen.call_count, 1)
        terminate.assert_any_call(viewer)
        self.assertFalse(manager.running)

    @unittest.skipUnless(os.name == "nt", "Windows-specific process flags")
    def test_hidden_windows_process_can_spawn_children(self):
        self.assertEqual(
            hidden_process_options(),
            {"creationflags": subprocess.CREATE_NO_WINDOW},
        )

if __name__ == "__main__":
    unittest.main()
