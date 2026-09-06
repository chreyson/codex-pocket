import time
import base64
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

from desktop_host import (
    DesktopController,
    copy_system_text,
    copy_system_image,
    desktop_dependency_message,
    main,
    webview_start_options,
)


class FakeManager:
    def __init__(self, on_status, on_ready, on_failure):
        self.on_status = on_status
        self.on_ready = on_ready
        self.on_failure = on_failure
        self.shutdown_requested = False
        self.stop_count = 0

    def start(self):
        self.on_status("正在建立公网连接")
        self.on_ready("https://pocket.example.test", "sample-key")

    def stop(self):
        self.stop_count += 1

    def request_shutdown(self):
        self.shutdown_requested = True


class AutoConnectManager(FakeManager):
    def __init__(self, on_status, on_ready, on_failure):
        super().__init__(on_status, on_ready, on_failure)
        self.connect_count = 0

    def connect_desktop(self):
        self.connect_count += 1


def wait_for_state(controller, phase, timeout=1):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        state = controller.get_state()
        if state["phase"] == phase:
            return state
        time.sleep(0.01)
    raise AssertionError(f"controller did not enter {phase}")


class DesktopHostTests(unittest.TestCase):
    def test_backend_config_alone_does_not_claim_desktop_attachment(self):
        controller = DesktopController(FakeManager)
        controller._on_ready("https://pocket.example.test", "sample-key")
        self.assertEqual(controller.get_state()["connectionMode"], "unknown")
        self.assertIsNone(controller.get_state()["desktopConnection"])

    def test_macos_and_windows_ready_state_start_desktop_migration_in_background(self):
        for system_name in ("Darwin", "Windows"):
            with self.subTest(system=system_name), patch(
                "desktop_host.platform.system", return_value=system_name
            ):
                controller = DesktopController(AutoConnectManager)
                controller._on_ready("https://pocket.example.test", "sample-key")
                deadline = time.monotonic() + 1
                while time.monotonic() < deadline and controller.manager.connect_count == 0:
                    time.sleep(0.01)
                self.assertEqual(controller.manager.connect_count, 1)
                self.assertFalse(controller.get_state()["desktopConnecting"])

    def test_linux_ready_state_does_not_restart_the_desktop(self):
        with patch("desktop_host.platform.system", return_value="Linux"):
            controller = DesktopController(AutoConnectManager)
            controller._on_ready("https://pocket.example.test", "sample-key")
        self.assertEqual(controller.manager.connect_count, 0)

    def test_connection_status_refreshes_without_restarting_service(self):
        controller = DesktopController(FakeManager)
        controller.manager.connection_status = lambda: {
            "connectionMode": "shared", "desktopConnection": {"state": "independent"},
        }
        controller._on_ready("https://pocket.example.test", "sample-key")
        controller._refresh_connection()
        self.assertEqual(controller.get_state()["desktopConnection"]["state"], "independent")
        controller.manager.connection_status = lambda: {
            "connectionMode": "shared", "desktopConnection": {"state": "shared"},
        }
        controller._refresh_connection()
        self.assertEqual(controller.get_state()["desktopConnection"]["state"], "shared")
        self.assertEqual(controller.manager.stop_count, 0)

    def test_qr_clipboard_accepts_only_bounded_pngs_for_the_current_connection(self):
        images = []
        controller = DesktopController(FakeManager, image_clipboard_writer=lambda value: images.append(value) or True)
        controller._on_ready("https://pocket.example.test", "sample-key")
        url = controller.get_state()["connectionUrl"]
        png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP9sAAAAASUVORK5CYII=")
        data = "data:image/png;base64," + base64.b64encode(png).decode("ascii")
        self.assertTrue(controller.copy_qr_image(url, data))
        self.assertEqual(images, [png])
        for invalid in (None, "file:///tmp/secret.png", "data:image/png;base64,!!!!", "data:image/png;base64," + "A" * 524_288):
            self.assertFalse(controller.copy_qr_image(url, invalid))
        self.assertFalse(controller.copy_qr_image(url + "old", data))
        controller._on_status("Reconnecting")
        self.assertFalse(controller.copy_qr_image(url, data))
        self.assertEqual(images, [png])

    def test_image_clipboard_uses_png_bytes_on_linux_and_sta_on_windows(self):
        for system, executable in (("Linux", "wl-copy"), ("Windows", "powershell.exe")):
            with patch("desktop_host.shutil.which", return_value=executable), patch("desktop_host.subprocess.run", return_value=SimpleNamespace(returncode=0)) as run:
                self.assertTrue(copy_system_image(b"synthetic-png", system))
                args = run.call_args.args[0]
                if system == "Linux":
                    self.assertEqual(args, ["wl-copy", "--type", "image/png"])
                    self.assertEqual(run.call_args.kwargs["input"], b"synthetic-png")
                else:
                    self.assertIn("-STA", args)
                    self.assertEqual(base64.b64decode(run.call_args.kwargs["input"]), b"synthetic-png")

    def test_appearance_survives_controller_restart_without_service_actions(self):
        with tempfile.TemporaryDirectory() as directory:
            appearance_path = Path(directory) / "appearance.json"
            controller = DesktopController(FakeManager, appearance_path=appearance_path)
            self.assertEqual(controller.get_theme(), "system")
            for theme in ("dark", "light", "system"):
                self.assertEqual(controller.set_theme(theme), theme)
                reopened = DesktopController(FakeManager, appearance_path=appearance_path)
                self.assertEqual(reopened.get_theme(), theme)
                self.assertEqual(reopened.get_state()["phase"], "stopped")
            self.assertEqual(controller.manager.stop_count, 0)
            for invalid in ("auto", None, {}):
                with self.assertRaises(ValueError):
                    controller.set_theme(invalid)
            for damaged in ("not json", "[]", '{"theme": "invalid"}'):
                appearance_path.write_text(damaged, encoding="utf-8")
                self.assertEqual(controller.get_theme(), "system")

    def test_webview_backend_is_only_forced_on_windows(self):
        self.assertEqual(webview_start_options("Windows")["gui"], "edgechromium")
        self.assertNotIn("gui", webview_start_options("Darwin"))
        self.assertNotIn("gui", webview_start_options("Linux"))

    def test_macos_clipboard_uses_pbcopy(self):
        with (
            patch("desktop_host.shutil.which", return_value="/usr/bin/pbcopy"),
            patch(
                "desktop_host.subprocess.run",
                return_value=SimpleNamespace(returncode=0),
            ) as run,
        ):
            self.assertTrue(copy_system_text("访问密钥", "Darwin"))

        self.assertEqual(run.call_args.args[0], ["/usr/bin/pbcopy"])
        self.assertEqual(run.call_args.kwargs["input"], "访问密钥")

    def test_linux_clipboard_falls_back_to_xclip(self):
        def which(name):
            return "/usr/bin/xclip" if name == "xclip" else None

        with (
            patch("desktop_host.shutil.which", side_effect=which),
            patch(
                "desktop_host.subprocess.run",
                return_value=SimpleNamespace(returncode=0),
            ) as run,
        ):
            self.assertTrue(copy_system_text("key", "Linux"))

        self.assertEqual(
            run.call_args.args[0],
            ["/usr/bin/xclip", "-selection", "clipboard"],
        )

    def test_dependency_message_names_the_platform_installer(self):
        self.assertIn("Install-CodexPocket.cmd", desktop_dependency_message("Windows"))
        self.assertIn("Install-CodexPocket.command", desktop_dependency_message("Darwin"))
        self.assertIn("Install-CodexPocket.sh", desktop_dependency_message("Linux"))

    def test_main_rejects_a_second_instance_before_starting_webview(self):
        with (
            patch("desktop_host.SingleInstanceLock") as lock_type,
            patch("desktop_host.show_already_running") as show_already_running,
        ):
            lock_type.return_value.acquire.return_value = False

            self.assertEqual(main(), 0)

        show_already_running.assert_called_once_with()
        lock_type.return_value.release.assert_not_called()

    def test_service_lifecycle_is_exposed_to_webview(self):
        controller = DesktopController(FakeManager)

        starting = controller.start_service()
        self.assertIn(starting["phase"], {"starting", "running"})
        running = wait_for_state(controller, "running")
        self.assertEqual(running["publicUrl"], "https://pocket.example.test")
        self.assertEqual(running["accessKey"], "sample-key")
        self.assertEqual(running["connectionUrl"], "https://pocket.example.test#token=sample-key")

        controller.stop_service()
        stopped = wait_for_state(controller, "stopped")
        self.assertEqual(stopped["publicUrl"], "")
        self.assertEqual(stopped["accessKey"], "")
        self.assertEqual(stopped["connectionUrl"], "")

    def test_clipboard_and_browser_only_accept_current_values(self):
        copied = []
        opened = []
        controller = DesktopController(
            FakeManager,
            opener=lambda value: opened.append(value) or True,
            clipboard_writer=lambda value: copied.append(value) or True,
        )
        controller.start_service()
        state = wait_for_state(controller, "running")

        self.assertFalse(controller.copy_text("not-the-key"))
        self.assertFalse(controller.copy_text(["not", "text"]))
        self.assertTrue(controller.copy_text(state["accessKey"]))
        self.assertEqual(copied, ["sample-key"])
        self.assertFalse(controller.open_url("https://other.example.test"))
        self.assertFalse(controller.open_url({"url": "https://pocket.example.test"}))
        self.assertTrue(controller.open_url(state["publicUrl"]))
        self.assertEqual(opened, ["https://pocket.example.test"])

    def test_connection_links_encode_keys_and_reject_stale_clipboard_values(self):
        copied = []
        controller = DesktopController(FakeManager, clipboard_writer=lambda value: copied.append(value) or True)
        controller._on_ready("https://pocket.example.test/path?view=mobile#old", "key+with /?#=&")
        link = controller.get_state()["connectionUrl"]
        parsed = urlsplit(link)
        self.assertEqual(parsed.path, "/path")
        self.assertEqual(parsed.query, "view=mobile")
        self.assertEqual(parse_qs(parsed.fragment), {"token": ["key+with /?#=&"]})
        self.assertTrue(controller.copy_text(link))
        self.assertFalse(controller.copy_text(link + "tampered"))
        controller._on_status("Reconnecting")
        self.assertEqual(controller.get_state()["connectionUrl"], "")
        self.assertFalse(controller.copy_text(link))
        controller._on_ready("https://recovered.example.test", "new-key")
        replacement = controller.get_state()["connectionUrl"]
        self.assertNotEqual(replacement, link)
        self.assertFalse(controller.copy_text(link))
        self.assertTrue(controller.copy_text(replacement))
        controller._on_failure("Disconnected")
        self.assertEqual(controller.get_state()["connectionUrl"], "")
        self.assertFalse(controller.copy_text(replacement))
        controller._on_ready("http://insecure.example.test", "key")
        self.assertEqual(controller.get_state()["connectionUrl"], "")

    def test_shutdown_prevents_future_state_changes(self):
        controller = DesktopController(FakeManager)
        controller.shutdown()
        before = controller.get_state()
        after = controller.start_service()

        self.assertEqual(after, before)
        self.assertTrue(controller.manager.shutdown_requested)
        self.assertEqual(controller.manager.stop_count, 1)


if __name__ == "__main__":
    unittest.main()
