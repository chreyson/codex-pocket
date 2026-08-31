import io
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
    hidden_process_options,
    monitor_work_area_for_point,
    parse_tunnel_url,
    window_position,
)


class DesktopControllerTests(unittest.TestCase):
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
