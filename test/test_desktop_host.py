import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from desktop_host import (
    DesktopController,
    copy_system_text,
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


def wait_for_state(controller, phase, timeout=1):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        state = controller.get_state()
        if state["phase"] == phase:
            return state
        time.sleep(0.01)
    raise AssertionError(f"controller did not enter {phase}")


class DesktopHostTests(unittest.TestCase):
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

        controller.stop_service()
        stopped = wait_for_state(controller, "stopped")
        self.assertEqual(stopped["publicUrl"], "")
        self.assertEqual(stopped["accessKey"], "")

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
