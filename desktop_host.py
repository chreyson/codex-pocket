from __future__ import annotations

import ctypes
import base64
import binascii
import json
import os
import platform
import shutil
import subprocess
import threading
import time
import webbrowser
from pathlib import Path
from typing import Callable
from urllib.parse import urlencode, urlsplit, urlunsplit

from codex_pocket import (
    DATA_DIR,
    INSTANCE_LOCK_PATH,
    ServiceManager,
    SingleInstanceLock,
    enable_windows_dpi_awareness,
    hidden_process_options,
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


def copy_system_image(png: bytes, system_name: str | None = None) -> bool:
    system_name = (system_name or platform.system()).lower()
    if system_name == "darwin":
        try:
            from AppKit import NSPasteboard, NSPasteboardTypePNG
            from Foundation import NSData

            pasteboard = NSPasteboard.generalPasteboard()
            data = NSData.dataWithBytes_length_(png, len(png))
            pasteboard.clearContents()
            return bool(pasteboard.setData_forType_(data, NSPasteboardTypePNG))
        except Exception:
            return False

    if system_name == "windows":
        script = """
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd())
$stream = [IO.MemoryStream]::new($bytes, 0, $bytes.Length)
try {
    $image = [Drawing.Image]::FromStream($stream)
    try { [Windows.Forms.Clipboard]::SetImage($image) }
    finally { $image.Dispose() }
} finally { $stream.Dispose() }
"""
        commands = [["powershell.exe", "-NoProfile", "-NonInteractive", "-STA", "-Command", script]]
        payload = base64.b64encode(png)
    elif system_name == "linux":
        commands = [["wl-copy", "--type", "image/png"], ["xclip", "-selection", "clipboard", "-t", "image/png"]]
        payload = png
    else:
        return False
    for command in commands:
        executable = shutil.which(command[0])
        if not executable:
            continue
        try:
            result = subprocess.run(
                [executable, *command[1:]], input=payload,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                timeout=5, check=False, **hidden_process_options(),
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
        image_clipboard_writer: Callable[[bytes], bool] = copy_system_image,
        appearance_path: Path = DATA_DIR / "appearance.json",
    ):
        self._lock = threading.RLock()
        self._opener = opener
        self._clipboard_writer = clipboard_writer
        self._image_clipboard_writer = image_clipboard_writer
        self._appearance_path = appearance_path
        self._closed = False
        self._connection_check_at = 0.0
        self._connection_checking = False
        self._state = {
            "phase": "stopped",
            "status": "服务已停止",
            "publicUrl": "",
            "accessKey": "",
            "busy": False,
            "error": "",
            "connectionMode": "unknown",
            "desktopConnection": None,
            "desktopConnecting": False,
        }
        self.manager = manager_factory(
            self._on_status,
            self._on_ready,
            self._on_failure,
        )

    def _snapshot(self) -> dict:
        with self._lock:
            state = dict(self._state)
            state["connectionUrl"] = ""
            if state["phase"] == "running" and state["publicUrl"] and state["accessKey"]:
                url = urlsplit(state["publicUrl"])
                if url.scheme == "https" and url.hostname and not url.username and not url.password:
                    state["connectionUrl"] = urlunsplit(url._replace(
                        fragment=urlencode({"token": state["accessKey"]}),
                    ))
            return state

    def _update(self, **values) -> dict:
        with self._lock:
            if self._closed:
                return self._snapshot()
            self._state.update(values)
            return self._snapshot()

    def _on_status(self, value: str) -> None:
        self._update(phase="starting", status=value, busy=True, publicUrl="")

    def _on_ready(self, url: str, key: str) -> None:
        self._update(
            phase="running",
            status="服务运行中",
            publicUrl=url,
            accessKey=key,
            busy=False,
            error="",
            connectionMode="unknown",
            desktopConnection=None,
        )
        # An App launched before Pocket cannot inherit the shared CLI
        # environment. Migrate it in the background as soon as the local
        # service is ready, so the normal startup path stays seamless.
        if (platform.system().lower() in {"darwin", "windows"}
                and hasattr(self.manager, "connect_desktop")):
            self.connect_desktop()

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
        with self._lock:
            if (self._state["phase"] == "running" and not self._connection_checking
                    and time.monotonic() >= self._connection_check_at
                    and hasattr(self.manager, "connection_status")):
                self._connection_checking = True
                threading.Thread(target=self._refresh_connection, daemon=True).start()
        return self._snapshot()

    def _refresh_connection(self) -> None:
        try:
            status = self.manager.connection_status()
        except (OSError, ValueError):
            status = {"connectionMode": "unknown", "desktopConnection": None}
        finally:
            with self._lock:
                self._connection_check_at = time.monotonic() + 3
                self._connection_checking = False
        with self._lock:
            if self._state["phase"] == "running":
                self._update(**status)

    def connect_desktop(self) -> dict:
        with self._lock:
            if self._closed or self._state["phase"] != "running" or self._state["desktopConnecting"]:
                return self._snapshot()
            self._state.update(desktopConnecting=True, error="")
        threading.Thread(target=self._connect_desktop_worker, daemon=True).start()
        return self._snapshot()

    def _connect_desktop_worker(self) -> None:
        try:
            self.manager.connect_desktop()
        except Exception as error:
            self._update(error=str(error))
        finally:
            self._update(desktopConnecting=False)
            self._connection_check_at = 0

    def get_theme(self) -> str:
        with self._lock:
            try:
                value = json.loads(self._appearance_path.read_text(encoding="utf-8"))
                theme = value.get("theme") if isinstance(value, dict) else None
                return theme if theme in ("system", "light", "dark") else "system"
            except (OSError, ValueError):
                return "system"

    def set_theme(self, theme: str) -> str:
        if not isinstance(theme, str) or theme not in ("system", "light", "dark"):
            raise ValueError("Invalid appearance")
        with self._lock:
            self._appearance_path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self._appearance_path.with_suffix(".tmp")
            temporary.write_text(json.dumps({"theme": theme}), encoding="utf-8")
            temporary.replace(self._appearance_path)
        return theme

    def start_service(self) -> dict:
        with self._lock:
            if self._closed or self._state["phase"] in {"starting", "running", "stopping"}:
                return self._snapshot()
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
                return self._snapshot()
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
        if value not in {state["publicUrl"], state["accessKey"], state["connectionUrl"]} or not value:
            return False
        return bool(self._clipboard_writer(value))

    def copy_qr_image(self, connection_url: str, png_data_url: str) -> bool:
        state = self._snapshot()
        if not connection_url or connection_url != state["connectionUrl"]:
            return False
        prefix = "data:image/png;base64,"
        if not isinstance(png_data_url, str) or not png_data_url.startswith(prefix) or len(png_data_url) > 524_288:
            return False
        try:
            png = base64.b64decode(png_data_url[len(prefix):], validate=True)
        except (ValueError, binascii.Error):
            return False
        if len(png) < 33 or png[:16] != b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR":
            return False
        width = int.from_bytes(png[16:20], "big")
        height = int.from_bytes(png[20:24], "big")
        if not 1 <= width <= 2048 or width != height:
            return False
        return bool(self._image_clipboard_writer(png))

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
        theme = controller.get_theme()
        window = webview.create_window(
            "",
            f"{DESKTOP_PAGE.as_uri()}?theme={theme}",
            js_api=controller,
            width=960,
            height=640,
            min_size=(760, 520),
            background_color="#212121" if theme == "dark" else "#ffffff",
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
