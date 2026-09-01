from __future__ import annotations

import ctypes
import os
import platform
import shutil
import subprocess
import threading
import time
import webbrowser
from pathlib import Path
from typing import Callable

from codex_pocket import (
    INSTANCE_LOCK_PATH,
    ServiceManager,
    SingleInstanceLock,
    enable_windows_dpi_awareness,
)


APP_DIR = Path(__file__).resolve().parent
DESKTOP_PAGE = APP_DIR / "public" / "desktop" / "index.html"


def copy_windows_text(value: str) -> bool:
    """Write Unicode text to the Windows clipboard without creating a Tk window."""
    if os.name != "nt":
        return False

    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32
    user32.OpenClipboard.argtypes = [ctypes.c_void_p]
    user32.OpenClipboard.restype = ctypes.c_int
    user32.EmptyClipboard.argtypes = []
    user32.EmptyClipboard.restype = ctypes.c_int
    user32.SetClipboardData.argtypes = [ctypes.c_uint, ctypes.c_void_p]
    user32.SetClipboardData.restype = ctypes.c_void_p
    user32.CloseClipboard.argtypes = []
    user32.CloseClipboard.restype = ctypes.c_int
    kernel32.GlobalAlloc.argtypes = [ctypes.c_uint, ctypes.c_size_t]
    kernel32.GlobalAlloc.restype = ctypes.c_void_p
    kernel32.GlobalLock.argtypes = [ctypes.c_void_p]
    kernel32.GlobalLock.restype = ctypes.c_void_p
    kernel32.GlobalUnlock.argtypes = [ctypes.c_void_p]
    kernel32.GlobalUnlock.restype = ctypes.c_int
    kernel32.GlobalFree.argtypes = [ctypes.c_void_p]
    kernel32.GlobalFree.restype = ctypes.c_void_p
    global_moveable = 0x0002
    unicode_text = 13
    payload = ctypes.create_unicode_buffer(value)
    size = ctypes.sizeof(payload)

    for _attempt in range(6):
        if user32.OpenClipboard(None):
            break
        time.sleep(0.04)
    else:
        return False

    handle = None
    try:
        if not user32.EmptyClipboard():
            return False
        handle = kernel32.GlobalAlloc(global_moveable, size)
        if not handle:
            return False
        pointer = kernel32.GlobalLock(handle)
        if not pointer:
            return False
        try:
            ctypes.memmove(pointer, ctypes.addressof(payload), size)
        finally:
            kernel32.GlobalUnlock(handle)
        if not user32.SetClipboardData(unicode_text, handle):
            return False
        handle = None
        return True
    finally:
        user32.CloseClipboard()
        if handle:
            kernel32.GlobalFree(handle)


def copy_system_text(value: str, system_name: str | None = None) -> bool:
    system_name = (system_name or platform.system()).lower()
    if system_name == "windows":
        return copy_windows_text(value)

    commands = []
    if system_name == "darwin":
        commands.append(["pbcopy"])
    elif system_name == "linux":
        commands.extend(
            [
                ["wl-copy"],
                ["xclip", "-selection", "clipboard"],
                ["xsel", "--clipboard", "--input"],
            ]
        )

    for command in commands:
        executable = shutil.which(command[0])
        if not executable:
            continue
        try:
            result = subprocess.run(
                [executable, *command[1:]],
                input=value,
                text=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=3,
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            continue
        if result.returncode == 0:
            return True
    return False


def webview_start_options(system_name: str | None = None) -> dict:
    options = {"debug": False, "private_mode": True}
    if (system_name or platform.system()).lower() == "windows":
        options["gui"] = "edgechromium"
    return options


def desktop_dependency_message(system_name: str | None = None) -> str:
    system_name = (system_name or platform.system()).lower()
    if system_name == "windows":
        return "缺少 WebView2 桌面组件。请重新双击 Install-CodexPocket.cmd 完成安装。"
    if system_name == "darwin":
        return "缺少 macOS 桌面组件。请重新双击 Install-CodexPocket.command 完成安装。"
    return "缺少 Linux 桌面组件。请重新运行 Install-CodexPocket.sh 完成安装。"


class DesktopController:
    def __init__(
        self,
        manager_factory: Callable = ServiceManager,
        *,
        opener: Callable[[str], object] = webbrowser.open,
        clipboard_writer: Callable[[str], bool] = copy_system_text,
    ):
        self._lock = threading.RLock()
        self._opener = opener
        self._clipboard_writer = clipboard_writer
        self._closed = False
        self._state = {
            "phase": "stopped",
            "status": "服务已停止",
            "publicUrl": "",
            "accessKey": "",
            "busy": False,
            "error": "",
        }
        self.manager = manager_factory(
            self._on_status,
            self._on_ready,
            self._on_failure,
        )

    def _snapshot(self) -> dict:
        with self._lock:
            return dict(self._state)

    def _update(self, **values) -> dict:
        with self._lock:
            if self._closed:
                return dict(self._state)
            self._state.update(values)
            return dict(self._state)

    def _on_status(self, value: str) -> None:
        self._update(phase="starting", status=value, busy=True)

    def _on_ready(self, url: str, key: str) -> None:
        self._update(
            phase="running",
            status="服务运行中",
            publicUrl=url,
            accessKey=key,
            busy=False,
            error="",
        )

    def _on_failure(self, message: str) -> None:
        self._update(
            phase="error",
            status="服务异常",
            publicUrl="",
            accessKey="",
            busy=False,
            error=message,
        )

    def get_state(self) -> dict:
        return self._snapshot()

    def start_service(self) -> dict:
        with self._lock:
            if self._closed or self._state["phase"] in {"starting", "running", "stopping"}:
                return dict(self._state)
            self._state.update(
                phase="starting",
                status="正在启动",
                publicUrl="",
                accessKey="",
                busy=True,
                error="",
            )
        threading.Thread(target=self._start_worker, name="codex-pocket-start", daemon=True).start()
        return self._snapshot()

    def _start_worker(self) -> None:
        try:
            self.manager.start()
        except Exception as error:
            self._on_failure(str(error))

    def stop_service(self) -> dict:
        with self._lock:
            if self._closed or self._state["phase"] == "stopping":
                return dict(self._state)
            self._state.update(phase="stopping", status="正在停止", busy=True, error="")
        threading.Thread(target=self._stop_worker, name="codex-pocket-stop", daemon=True).start()
        return self._snapshot()

    def _stop_worker(self) -> None:
        try:
            self.manager.stop()
        except Exception as error:
            self._on_failure(str(error))
            return
        self._update(
            phase="stopped",
            status="服务已停止",
            publicUrl="",
            accessKey="",
            busy=False,
            error="",
        )

    def dismiss_error(self) -> dict:
        return self._update(error="")

    def copy_text(self, value: str) -> bool:
        if not isinstance(value, str):
            return False
        state = self._snapshot()
        if value not in {state["publicUrl"], state["accessKey"]} or not value:
            return False
        return bool(self._clipboard_writer(value))

    def open_url(self, value: str) -> bool:
        if not isinstance(value, str):
            return False
        state = self._snapshot()
        if value != state["publicUrl"] or not value.startswith("https://"):
            return False
        return bool(self._opener(value))

    def shutdown(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
        self.manager.request_shutdown()
        self.manager.stop()


def show_dependency_error(message: str) -> None:
    if os.name == "nt":
        ctypes.windll.user32.MessageBoxW(None, message, "Codex Pocket", 0x10)
    else:
        print(message)


def show_already_running() -> None:
    if os.name == "nt":
        ctypes.windll.user32.MessageBoxW(
            None,
            "Codex Pocket 已经在运行。",
            "Codex Pocket",
            0x40,
        )
    else:
        print("Codex Pocket 已经在运行。")


def main() -> int:
    instance_lock = SingleInstanceLock(INSTANCE_LOCK_PATH)
    if not instance_lock.acquire():
        show_already_running()
        return 0

    try:
        try:
            import webview
        except ImportError:
            show_dependency_error(desktop_dependency_message())
            return 1

        enable_windows_dpi_awareness()
        controller = DesktopController()
        window = webview.create_window(
            "Codex Pocket",
            DESKTOP_PAGE.as_uri(),
            js_api=controller,
            width=960,
            height=640,
            min_size=(760, 520),
            background_color="#ffffff",
            text_select=True,
        )
        window.events.closed += controller.shutdown
        try:
            webview.start(**webview_start_options())
        finally:
            controller.shutdown()
        return 0
    finally:
        instance_lock.release()


if __name__ == "__main__":
    raise SystemExit(main())
