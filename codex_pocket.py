from __future__ import annotations

import json
import os
import platform
import re
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tarfile
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

try:
    import tkinter as tk
    from tkinter import font as tkfont, messagebox
except ImportError:
    tk = None
    tkfont = None
    messagebox = None


APP_DIR = Path(__file__).resolve().parent
DATA_DIR = APP_DIR / ".data"
TOOLS_DIR = APP_DIR / ".tools"
LOG_PATH = DATA_DIR / "desktop.log"
INSTANCE_LOCK_PATH = DATA_DIR / "desktop.lock"
RUNTIME_CONFIG_PATH = DATA_DIR / "runtime.json"
TUNNEL_URL_PATTERN = re.compile(
    r"https://[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.trycloudflare\.com",
    re.IGNORECASE,
)
CLOUDFLARED_DOWNLOAD_CHUNK_SIZE = 1024 * 1024
CLOUDFLARED_DOWNLOAD_MAX_BYTES = 256 * 1024 * 1024
CLOUDFLARED_DOWNLOAD_READ_TIMEOUT = 30
CLOUDFLARED_DOWNLOAD_TOTAL_TIMEOUT = 10 * 60


def enable_windows_dpi_awareness(system_name: str | None = None) -> bool:
    """Opt out of Windows bitmap scaling before Tk creates any windows."""
    if (system_name or platform.system()).lower() != "windows":
        return False

    import ctypes

    try:
        per_monitor_v2 = ctypes.c_void_p(-4)
        if ctypes.windll.user32.SetProcessDpiAwarenessContext(per_monitor_v2):
            return True
    except (AttributeError, OSError, ValueError):
        pass

    try:
        if ctypes.windll.shcore.SetProcessDpiAwareness(2) == 0:
            return True
    except (AttributeError, OSError, ValueError):
        pass

    try:
        return bool(ctypes.windll.user32.SetProcessDPIAware())
    except (AttributeError, OSError, ValueError):
        return False


def dpi_scale(dpi: float) -> float:
    """Return a conservative scale for dimensions expressed in physical pixels."""
    try:
        value = float(dpi) / 96.0
    except (TypeError, ValueError):
        return 1.0
    return min(3.0, max(1.0, value))


def monitor_work_area_for_point(
    x: int,
    y: int,
    fallback: tuple[int, int, int, int],
    system_name: str | None = None,
) -> tuple[int, int, int, int]:
    """Return the work area of the monitor nearest a virtual-screen point."""
    if (system_name or platform.system()).lower() != "windows":
        return fallback

    try:
        import ctypes
        from ctypes import wintypes

        class MonitorInfo(ctypes.Structure):
            _fields_ = [
                ("cbSize", wintypes.DWORD),
                ("rcMonitor", wintypes.RECT),
                ("rcWork", wintypes.RECT),
                ("dwFlags", wintypes.DWORD),
            ]

        user32 = ctypes.windll.user32
        monitor_from_point = user32.MonitorFromPoint
        monitor_from_point.argtypes = (wintypes.POINT, wintypes.DWORD)
        monitor_from_point.restype = ctypes.c_void_p
        get_monitor_info = user32.GetMonitorInfoW
        get_monitor_info.argtypes = (ctypes.c_void_p, ctypes.POINTER(MonitorInfo))
        get_monitor_info.restype = wintypes.BOOL

        monitor = monitor_from_point(wintypes.POINT(round(x), round(y)), 2)
        info = MonitorInfo()
        info.cbSize = ctypes.sizeof(info)
        if monitor and get_monitor_info(monitor, ctypes.byref(info)):
            area = info.rcWork
            if area.right > area.left and area.bottom > area.top:
                return area.left, area.top, area.right, area.bottom
    except Exception:
        pass
    return fallback


def constrain_tooltip_position(
    x: int,
    y: int,
    width: int,
    height: int,
    anchor_top: int,
    gap: int,
    work_area: tuple[int, int, int, int],
) -> tuple[int, int]:
    """Keep a tooltip inside one monitor, flipping it above its anchor if needed."""
    left, top, right, bottom = work_area
    if y + height > bottom:
        y = anchor_top - height - gap
    max_x = max(left, right - width)
    max_y = max(top, bottom - height)
    return max(left, min(x, max_x)), max(top, min(y, max_y))


def window_position(x: int, y: int) -> str:
    """Format signed Tk window coordinates, including negative monitor offsets."""
    return f"{round(x):+d}{round(y):+d}"


def parse_tunnel_url(text: str) -> str | None:
    match = TUNNEL_URL_PATTERN.search(text)
    return match.group(0) if match else None


def cloudflared_download_spec(
    system_name: str | None = None,
    machine_name: str | None = None,
) -> tuple[str, bool]:
    system_name = (system_name or platform.system()).lower()
    machine_name = (machine_name or platform.machine()).lower()

    if machine_name in {"amd64", "x86_64"}:
        arch = "amd64"
    elif machine_name in {"arm64", "aarch64"}:
        arch = "arm64"
    elif machine_name in {"x86", "i386", "i686"}:
        arch = "386"
    else:
        raise RuntimeError(f"暂不支持此处理器架构：{machine_name}")

    if system_name == "windows":
        asset = f"cloudflared-windows-{arch}.exe"
        return f"https://github.com/cloudflare/cloudflared/releases/latest/download/{asset}", False
    if system_name == "linux":
        asset = f"cloudflared-linux-{arch}"
        return f"https://github.com/cloudflare/cloudflared/releases/latest/download/{asset}", False
    if system_name == "darwin":
        if arch == "386":
            raise RuntimeError("当前 cloudflared 不支持 32 位 macOS")
        asset = f"cloudflared-darwin-{arch}.tgz"
        return f"https://github.com/cloudflare/cloudflared/releases/latest/download/{asset}", True
    raise RuntimeError(f"暂不支持此操作系统：{system_name}")


def local_cloudflared_path() -> Path:
    suffix = ".exe" if os.name == "nt" else ""
    return TOOLS_DIR / f"cloudflared{suffix}"


def hidden_process_options() -> dict:
    if os.name == "nt":
        return {"creationflags": subprocess.CREATE_NO_WINDOW}
    return {"start_new_session": True}


def cloudflared_is_usable(path: str | Path) -> bool:
    try:
        subprocess.run(
            [str(path), "--version"],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=15,
            **hidden_process_options(),
        )
        return True
    except (OSError, subprocess.SubprocessError):
        return False


def ensure_cloudflared(status_callback) -> str:
    installed = shutil.which("cloudflared")
    if installed and cloudflared_is_usable(installed):
        return installed

    target = local_cloudflared_path()
    target_is_file = _is_accessible_file(target)
    if target_is_file and cloudflared_is_usable(target):
        return str(target)
    if target_is_file:
        status_callback("本地公网组件不可用，正在重新准备")
        target.unlink()

    status_callback("首次启动，正在准备公网组件")
    url, is_archive = cloudflared_download_spec()
    TOOLS_DIR.mkdir(parents=True, exist_ok=True)
    download = target.with_suffix(target.suffix + ".download")

    request = urllib.request.Request(url, headers={"User-Agent": "Codex-Pocket/0.2"})
    started_at = time.monotonic()
    try:
        with urllib.request.urlopen(
            request,
            timeout=CLOUDFLARED_DOWNLOAD_READ_TIMEOUT,
        ) as response, download.open("wb") as output:
            content_length = response.headers.get("Content-Length")
            try:
                total_bytes = int(content_length) if content_length else None
            except (TypeError, ValueError):
                total_bytes = None
            if total_bytes is not None and total_bytes > CLOUDFLARED_DOWNLOAD_MAX_BYTES:
                raise RuntimeError("公网组件下载内容过大")

            downloaded_bytes = 0
            while True:
                if time.monotonic() - started_at >= CLOUDFLARED_DOWNLOAD_TOTAL_TIMEOUT:
                    raise TimeoutError("下载公网组件超过 10 分钟")

                chunk = response.read(CLOUDFLARED_DOWNLOAD_CHUNK_SIZE)
                if not chunk:
                    break

                downloaded_bytes += len(chunk)
                if downloaded_bytes > CLOUDFLARED_DOWNLOAD_MAX_BYTES:
                    raise RuntimeError("公网组件下载内容过大")
                output.write(chunk)
                downloaded_mb = downloaded_bytes / (1024 * 1024)
                if total_bytes:
                    total_mb = total_bytes / (1024 * 1024)
                    percent = min(100, downloaded_bytes * 100 / total_bytes)
                    status_callback(
                        f"正在下载公网组件：{downloaded_mb:.1f}/{total_mb:.1f} MB ({percent:.0f}%)"
                    )
                else:
                    status_callback(f"正在下载公网组件：{downloaded_mb:.1f} MB")

                if time.monotonic() - started_at >= CLOUDFLARED_DOWNLOAD_TOTAL_TIMEOUT:
                    raise TimeoutError("下载公网组件超过 10 分钟")

        status_callback("公网组件下载完成，正在校验")

        if is_archive:
            with tarfile.open(download, "r:gz") as archive:
                member = next(
                    (
                        item
                        for item in archive.getmembers()
                        if item.isfile() and Path(item.name).name == "cloudflared"
                    ),
                    None,
                )
                if member is None:
                    raise RuntimeError("下载包中没有找到 cloudflared")
                source = archive.extractfile(member)
                if source is None:
                    raise RuntimeError("无法读取 cloudflared 下载包")
                with target.open("wb") as output:
                    shutil.copyfileobj(source, output)
        else:
            os.replace(download, target)

        if os.name != "nt":
            target.chmod(0o755)
        if not cloudflared_is_usable(target):
            raise RuntimeError("下载的公网组件无法运行")
        return str(target)
    except Exception as error:
        target.unlink(missing_ok=True)
        raise RuntimeError(f"公网组件准备失败：{error}") from error
    finally:
        download.unlink(missing_ok=True)


def _is_accessible_file(value: str | Path | None) -> bool:
    if not value:
        return False
    try:
        return Path(value).is_file()
    except OSError:
        return False


def runtime_configured_path(component: str) -> str | None:
    try:
        payload = json.loads(RUNTIME_CONFIG_PATH.read_text(encoding="utf-8"))
        configured = payload.get(component, {}).get("Path")
    except (OSError, TypeError, ValueError, AttributeError):
        return None
    if isinstance(configured, str) and _is_accessible_file(configured):
        return configured
    return None


def find_node() -> str:
    for configured in (os.environ.get("NODE_BIN"), runtime_configured_path("Node")):
        if _is_accessible_file(configured):
            return configured
    found = shutil.which("node")
    if found:
        return found
    raise RuntimeError("未找到 Node.js，请先安装 Node.js 20 或更高版本")


def find_codex() -> str:
    for configured in (os.environ.get("CODEX_BIN"), runtime_configured_path("Codex")):
        if not _is_accessible_file(configured):
            continue
        configured_path = Path(configured)
        if configured_path.suffix.lower() == ".ps1":
            command_wrapper = configured_path.with_suffix(".cmd")
            if _is_accessible_file(command_wrapper):
                return str(command_wrapper)
        return configured
    found = shutil.which("codex")
    if found:
        return found

    if os.name == "nt":
        local_app_data = os.environ.get("LOCALAPPDATA")
        if local_app_data:
            candidates = list(
                (Path(local_app_data) / "OpenAI" / "Codex" / "bin").glob("*/codex.exe")
            )
            candidates.sort(key=lambda item: item.stat().st_mtime, reverse=True)
            if candidates:
                return str(candidates[0])

    raise RuntimeError("未找到 Codex CLI，请先安装或打开一次 Codex App")


def find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def terminate_process_tree(process: subprocess.Popen | None) -> None:
    if process is None or process.poll() is not None:
        return

    if os.name == "nt":
        try:
            result = subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=10,
                check=False,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
        except (OSError, subprocess.TimeoutExpired):
            result = None

        if result is not None and result.returncode == 0:
            try:
                process.wait(timeout=5)
                return
            except (OSError, subprocess.TimeoutExpired):
                pass
        try:
            process.kill()
            process.wait(timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            pass
        return

    try:
        os.killpg(os.getpgid(process.pid), signal.SIGTERM)
        process.wait(timeout=5)
        return
    except ProcessLookupError:
        return
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(process.pid), signal.SIGKILL)
        except ProcessLookupError:
            return
    try:
        process.wait(timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        pass


class SingleInstanceLock:
    def __init__(self, path: Path):
        self.path = path
        self.handle = None

    def acquire(self) -> bool:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        handle = self.path.open("a+b")
        if handle.seek(0, os.SEEK_END) == 0:
            handle.write(b"0")
            handle.flush()
        handle.seek(0)

        try:
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            handle.close()
            return False

        self.handle = handle
        return True

    def release(self) -> None:
        handle = self.handle
        self.handle = None
        if handle is None:
            return
        try:
            handle.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        finally:
            handle.close()


class ServiceManager:
    class _StartCancelled(Exception):
        pass

    class _Run:
        def __init__(self):
            self.cancel = threading.Event()
            self.start_done = threading.Event()
            self.stop_done = threading.Event()
            self.start_thread_id = threading.get_ident()

    def __init__(self, on_status, on_ready, on_failure):
        self.on_status = on_status
        self.on_ready = on_ready
        self.on_failure = on_failure
        self.viewer_process: subprocess.Popen | None = None
        self.tunnel_process: subprocess.Popen | None = None
        self.public_url = ""
        self.access_key = ""
        self.port = 0
        self._url_event = threading.Event()
        self._connected_event = threading.Event()
        self._lock = threading.RLock()
        self._last_tunnel_lines: list[str] = []
        self._log_lock = threading.Lock()
        self._run: ServiceManager._Run | None = None
        self._starting_run: ServiceManager._Run | None = None
        self._cleaning_run: ServiceManager._Run | None = None
        self._closed = False

    @property
    def running(self) -> bool:
        return (
            self.viewer_process is not None
            and self.viewer_process.poll() is None
            and self.tunnel_process is not None
            and self.tunnel_process.poll() is None
        )

    def _log(self, source: str, message: str) -> None:
        with self._log_lock:
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
            with LOG_PATH.open("a", encoding="utf-8") as log:
                log.write(f"[{timestamp}] [{source}] {message.rstrip()}\n")

    def _read_stream(self, source: str, stream, run: _Run) -> None:
        try:
            for line in iter(stream.readline, ""):
                if not line:
                    break
                if source == "tunnel":
                    with self._lock:
                        if self._run is not run:
                            continue
                        self._last_tunnel_lines.append(line.strip())
                        self._last_tunnel_lines = self._last_tunnel_lines[-12:]
                        url = parse_tunnel_url(line)
                        if url and not self.public_url:
                            self.public_url = url
                            self._url_event.set()
                        if "registered tunnel connection" in line.lower():
                            self._connected_event.set()
                try:
                    self._log(source, line)
                except OSError:
                    # Logging must not prevent URL detection or stream draining.
                    pass
        finally:
            stream.close()

    def _watch_processes(self, run: _Run, viewer_process, tunnel_process) -> None:
        while not run.cancel.wait(1):
            viewer_code = viewer_process.poll()
            tunnel_code = tunnel_process.poll()
            if viewer_code is not None:
                if not self._run_is_current(run):
                    return
                self._stop_run(run)
                self.on_failure(f"本地服务意外退出（代码 {viewer_code}）")
                return
            if tunnel_code is not None:
                if not self._run_is_current(run):
                    return
                self._stop_run(run)
                self.on_failure(f"公网连接意外退出（代码 {tunnel_code}）")
                return

    def _run_is_current(self, run: _Run) -> bool:
        with self._lock:
            return self._run is run and not run.cancel.is_set()

    def _check_cancelled(self, run: _Run) -> None:
        if not self._run_is_current(run):
            raise self._StartCancelled()

    def _register_process(self, run: _Run, attribute: str, process) -> None:
        with self._lock:
            accepted = self._run is run and not self._closed and not run.cancel.is_set()
            if accepted:
                setattr(self, attribute, process)
        if not accepted:
            terminate_process_tree(process)
            raise self._StartCancelled()

    def _wait_for_local_service(
        self,
        run: _Run,
        viewer_process,
        port: int,
        timeout: float = 25,
    ) -> None:
        deadline = time.monotonic() + timeout
        url = f"http://127.0.0.1:{port}/api/health"
        while time.monotonic() < deadline:
            self._check_cancelled(run)
            if viewer_process.poll() is not None:
                raise RuntimeError("本地服务启动失败，请查看日志")
            try:
                with urllib.request.urlopen(url, timeout=1) as response:
                    if response.status == 200:
                        return
            except Exception:
                if run.cancel.wait(0.25):
                    self._check_cancelled(run)
        raise RuntimeError("等待本地服务启动超时")

    def start(self) -> None:
        with self._lock:
            if (
                self._closed
                or self._run is not None
                or self._starting_run is not None
                or self._cleaning_run is not None
            ):
                return
            run = self._Run()
            self._run = run
            self._starting_run = run
            self._url_event.clear()
            self._connected_event.clear()
            self.public_url = ""
            self.access_key = secrets.token_urlsafe(24)
            self.port = find_free_port()
            port = self.port
            access_key = self.access_key
            self._last_tunnel_lines = []

        try:
            def report_status(value: str) -> None:
                self._check_cancelled(run)
                self.on_status(value)

            report_status("正在检查运行环境")
            node = find_node()
            self._check_cancelled(run)
            codex = find_codex()
            self._check_cancelled(run)
            cloudflared = ensure_cloudflared(report_status)
            self._check_cancelled(run)

            env = os.environ.copy()
            env["HOST"] = "127.0.0.1"
            env["PORT"] = str(port)
            env["CODEX_BIN"] = codex
            env["CODEX_RELAY_TOKEN"] = access_key
            env["FORCE_SECURE_COOKIE"] = "1"
            env.setdefault("CODEX_HOME", str(Path.home() / ".codex"))

            report_status("正在连接本机 Codex")
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            viewer_process = subprocess.Popen(
                [node, str(APP_DIR / "src" / "server.mjs")],
                cwd=APP_DIR,
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                **hidden_process_options(),
            )
            self._register_process(run, "viewer_process", viewer_process)
            threading.Thread(
                target=self._read_stream,
                args=("viewer", viewer_process.stdout, run),
                daemon=True,
            ).start()
            threading.Thread(
                target=self._read_stream,
                args=("viewer", viewer_process.stderr, run),
                daemon=True,
            ).start()
            self._wait_for_local_service(run, viewer_process, port)
            self._check_cancelled(run)

            report_status("正在建立公网连接")
            tunnel_process = subprocess.Popen(
                [
                    cloudflared,
                    "tunnel",
                    "--url",
                    f"http://127.0.0.1:{port}",
                    "--no-autoupdate",
                    "--loglevel",
                    "info",
                ],
                cwd=APP_DIR,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                **hidden_process_options(),
            )
            self._register_process(run, "tunnel_process", tunnel_process)
            threading.Thread(
                target=self._read_stream,
                args=("tunnel", tunnel_process.stdout, run),
                daemon=True,
            ).start()
            threading.Thread(
                target=self._read_stream,
                args=("tunnel", tunnel_process.stderr, run),
                daemon=True,
            ).start()

            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                self._check_cancelled(run)
                if tunnel_process.poll() is not None:
                    with self._lock:
                        details = " | ".join(self._last_tunnel_lines[-3:])
                    raise RuntimeError(f"公网连接启动失败：{details or '进程已退出'}")
                if self._url_event.is_set() and self._connected_event.is_set():
                    break
                if run.cancel.wait(0.2):
                    self._check_cancelled(run)
            else:
                if self._url_event.is_set():
                    raise RuntimeError("无法连接 Cloudflare 边缘网络，请检查出站 7844 端口")
                raise RuntimeError("等待公网链接超时，请检查网络后重试")

            self._check_cancelled(run)
            with self._lock:
                public_url = self.public_url
            self.on_ready(public_url, access_key)
            threading.Thread(
                target=self._watch_processes,
                args=(run, viewer_process, tunnel_process),
                daemon=True,
            ).start()
        except self._StartCancelled:
            self._stop_run(run)
            return
        except Exception:
            self._stop_run(run)
            raise
        finally:
            run.start_done.set()
            with self._lock:
                if self._starting_run is run:
                    self._starting_run = None

    def _stop_run(self, expected_run: _Run | None = None) -> _Run | None:
        with self._lock:
            run = self._run
            if expected_run is not None and run is not expected_run:
                return expected_run if self._cleaning_run is expected_run else None
            if run is None:
                return self._cleaning_run or self._starting_run
            run.cancel.set()
            tunnel = self.tunnel_process
            viewer = self.viewer_process
            self.tunnel_process = None
            self.viewer_process = None
            self.public_url = ""
            self.access_key = ""
            self._run = None
            self._cleaning_run = run
        try:
            for process in (tunnel, viewer):
                try:
                    terminate_process_tree(process)
                except Exception as error:
                    try:
                        self._log("desktop", f"进程清理失败：{error}")
                    except Exception:
                        pass
        finally:
            run.stop_done.set()
            with self._lock:
                if self._cleaning_run is run:
                    self._cleaning_run = None
        return run

    def request_shutdown(self) -> None:
        """Synchronously prevent a close-racing start from creating processes."""
        with self._lock:
            self._closed = True
            if self._run is not None:
                self._run.cancel.set()

    def stop(self) -> None:
        wait_for = self._stop_run()
        if wait_for is not None and wait_for.start_thread_id != threading.get_ident():
            wait_for.start_done.wait()
            wait_for.stop_done.wait()


class Tooltip:
    def __init__(
        self,
        widget: tk.Widget,
        text: str,
        *,
        font: tkfont.Font | None = None,
        scale: float = 1.0,
    ):
        self.widget = widget
        self.text = text
        self.font = font
        self.scale = scale
        self.window: tk.Toplevel | None = None
        self.after_id = None
        widget.bind("<Enter>", self._schedule, add="+")
        widget.bind("<Leave>", self._hide, add="+")
        widget.bind("<Destroy>", self._hide, add="+")

    def _schedule(self, _event=None) -> None:
        self._hide()
        self.after_id = self.widget.after(450, self._show)

    def _show(self) -> None:
        self.after_id = None
        enabled = getattr(self.widget, "is_enabled", None)
        if self.window or (callable(enabled) and not enabled()):
            return
        try:
            if self.widget.cget("state") == "disabled":
                return
        except tk.TclError:
            return

        self.window = tk.Toplevel(self.widget)
        self.window.wm_overrideredirect(True)
        label = tk.Label(
            self.window,
            text=self.text,
            bg="#202123",
            fg="#ffffff",
            padx=max(6, round(8 * self.scale)),
            pady=max(4, round(5 * self.scale)),
            bd=0,
            font=self.font,
        )
        label.pack()
        self.window.update_idletasks()

        width = self.window.winfo_reqwidth()
        height = self.window.winfo_reqheight()
        anchor_x = self.widget.winfo_rootx()
        anchor_y = self.widget.winfo_rooty()
        anchor_width = self.widget.winfo_width()
        anchor_height = self.widget.winfo_height()
        gap = round(8 * self.scale)
        x = anchor_x + (anchor_width - width) // 2
        y = anchor_y + anchor_height + gap
        try:
            fallback_left = self.widget.winfo_vrootx()
            fallback_top = self.widget.winfo_vrooty()
            fallback_width = self.widget.winfo_vrootwidth()
            fallback_height = self.widget.winfo_vrootheight()
        except tk.TclError:
            fallback_left = fallback_top = 0
            fallback_width = self.widget.winfo_screenwidth()
            fallback_height = self.widget.winfo_screenheight()
        if fallback_width <= 0 or fallback_height <= 0:
            fallback_left = fallback_top = 0
            fallback_width = self.widget.winfo_screenwidth()
            fallback_height = self.widget.winfo_screenheight()
        fallback = (
            fallback_left,
            fallback_top,
            fallback_left + fallback_width,
            fallback_top + fallback_height,
        )
        work_area = monitor_work_area_for_point(
            anchor_x + anchor_width // 2,
            anchor_y + anchor_height // 2,
            fallback,
        )
        x, y = constrain_tooltip_position(
            x,
            y,
            width,
            height,
            anchor_y,
            gap,
            work_area,
        )
        self.window.wm_geometry(window_position(x, y))

    def _hide(self, _event=None) -> None:
        if self.after_id:
            try:
                self.widget.after_cancel(self.after_id)
            except tk.TclError:
                pass
            self.after_id = None
        if self.window:
            try:
                self.window.destroy()
            except tk.TclError:
                pass
            self.window = None


def draw_rounded_rectangle(
    canvas: tk.Canvas,
    x1: int,
    y1: int,
    x2: int,
    y2: int,
    radius: int,
    **options,
):
    radius = max(1, min(radius, (x2 - x1) // 2, (y2 - y1) // 2))
    points = (
        x1 + radius, y1,
        x2 - radius, y1,
        x2, y1,
        x2, y1 + radius,
        x2, y2 - radius,
        x2, y2,
        x2 - radius, y2,
        x1 + radius, y2,
        x1, y2,
        x1, y2 - radius,
        x1, y1 + radius,
        x1, y1,
    )
    return canvas.create_polygon(
        points,
        smooth=True,
        splinesteps=24,
        **options,
    )


TkCanvasBase = tk.Canvas if tk is not None else object


class IconButton(TkCanvasBase):
    def __init__(
        self,
        parent,
        *,
        icon: str,
        command,
        tooltip: str,
        font: tkfont.Font,
        scale: float,
        background: str,
        hover_background: str,
        foreground: str,
        disabled_foreground: str,
        size: int = 32,
        enabled: bool = False,
    ):
        self.scale = scale
        self.logical_size = size
        self.pixel_size = max(24, round(size * scale))
        self.icon = icon
        self.command = command
        self.background = background
        self.hover_background = hover_background
        self.foreground = foreground
        self.disabled_foreground = disabled_foreground
        self.enabled = enabled
        self.hovered = False
        self.focused = False
        super().__init__(
            parent,
            width=self.pixel_size,
            height=self.pixel_size,
            bg=background,
            bd=0,
            highlightthickness=0,
            takefocus=1,
            cursor="hand2" if enabled else "",
        )
        self.bind("<Enter>", self._enter)
        self.bind("<Leave>", self._leave)
        self.bind("<Button-1>", self._click)
        self.bind("<FocusIn>", self._focus_in)
        self.bind("<FocusOut>", self._focus_out)
        self.bind("<space>", self._key_activate)
        self.bind("<Return>", self._key_activate)
        Tooltip(self, tooltip, font=font, scale=scale)
        self._draw()

    def _p(self, value: float) -> int:
        return round(value * self.scale)

    def is_enabled(self) -> bool:
        return self.enabled

    def set_enabled(self, enabled: bool) -> None:
        self.enabled = enabled
        self.configure(cursor="hand2" if enabled else "")
        self._draw()

    def _enter(self, _event=None) -> None:
        self.hovered = True
        self._draw()

    def _leave(self, _event=None) -> None:
        self.hovered = False
        self._draw()

    def _focus_in(self, _event=None) -> None:
        self.focused = True
        self._draw()

    def _focus_out(self, _event=None) -> None:
        self.focused = False
        self._draw()

    def _click(self, _event=None):
        if not self.enabled:
            return "break"
        self.focus_set()
        self.command()
        return "break"

    def _key_activate(self, _event=None):
        if self.enabled:
            self.command()
        return "break"

    def _draw(self) -> None:
        self.delete("all")
        fill = self.hover_background if self.enabled and self.hovered else self.background
        color = self.foreground if self.enabled else self.disabled_foreground
        draw_rounded_rectangle(
            self,
            0,
            0,
            self.pixel_size,
            self.pixel_size,
            self._p(7),
            fill=fill,
            outline="",
        )
        stroke = max(1, round(self.scale))

        if self.icon == "copy":
            self.create_rectangle(
                self._p(10), self._p(8), self._p(21), self._p(19),
                outline=color, width=stroke,
            )
            self.create_rectangle(
                self._p(7), self._p(11), self._p(18), self._p(22),
                outline=color, width=stroke,
            )
        elif self.icon == "external":
            self.create_line(
                self._p(13), self._p(9), self._p(22), self._p(9),
                self._p(22), self._p(18), fill=color, width=stroke,
                capstyle="round", joinstyle="round",
            )
            self.create_line(
                self._p(22), self._p(9), self._p(12), self._p(19),
                fill=color, width=stroke, capstyle="round",
            )
            self.create_line(
                self._p(19), self._p(15), self._p(19), self._p(22),
                self._p(8), self._p(22), self._p(8), self._p(11),
                self._p(15), self._p(11), fill=color, width=stroke,
                capstyle="round", joinstyle="round",
            )
        elif self.icon == "close":
            self.create_line(
                self._p(10), self._p(10), self._p(22), self._p(22),
                fill=color, width=stroke, capstyle="round",
            )
            self.create_line(
                self._p(22), self._p(10), self._p(10), self._p(22),
                fill=color, width=stroke, capstyle="round",
            )

        if self.focused:
            inset = max(1, round(self.scale))
            draw_rounded_rectangle(
                self,
                inset,
                inset,
                self.pixel_size - inset - 1,
                self.pixel_size - inset - 1,
                self._p(6),
                outline="#707176",
                fill="",
                width=stroke,
            )


class RoundedTextButton(TkCanvasBase):
    def __init__(
        self,
        parent,
        *,
        text: str,
        command,
        font: tkfont.Font,
        scale: float,
        parent_background: str,
        width: int = 112,
        height: int = 38,
        radius: int = 8,
    ):
        self.scale = scale
        self.pixel_width = round(width * scale)
        self.pixel_height = round(height * scale)
        self.radius = round(radius * scale)
        self.text = text
        self.command = command
        self.font = font
        self.state = "normal"
        self.background = "#202123"
        self.hover_background = "#343438"
        self.foreground = "#ffffff"
        self.disabled_foreground = "#d5d5d8"
        self.hovered = False
        self.pressed = False
        self.focused = False
        super().__init__(
            parent,
            width=self.pixel_width,
            height=self.pixel_height,
            bg=parent_background,
            bd=0,
            highlightthickness=0,
            takefocus=1,
            cursor="hand2",
        )
        self.bind("<Enter>", self._enter)
        self.bind("<Leave>", self._leave)
        self.bind("<ButtonPress-1>", self._press)
        self.bind("<ButtonRelease-1>", self._release)
        self.bind("<FocusIn>", self._focus_in)
        self.bind("<FocusOut>", self._focus_out)
        self.bind("<space>", self._key_activate)
        self.bind("<Return>", self._key_activate)
        self._draw()

    def set_style(
        self,
        *,
        text: str,
        state: str,
        background: str,
        hover_background: str,
        foreground: str,
        disabled_foreground: str,
    ) -> None:
        self.text = text
        self.state = state
        self.background = background
        self.hover_background = hover_background
        self.foreground = foreground
        self.disabled_foreground = disabled_foreground
        self.configure(cursor="hand2" if state == "normal" else "")
        self._draw()

    def _enter(self, _event=None) -> None:
        self.hovered = True
        self._draw()

    def _leave(self, _event=None) -> None:
        self.hovered = False
        self.pressed = False
        self._draw()

    def _press(self, _event=None):
        if self.state != "normal":
            return "break"
        self.focus_set()
        self.pressed = True
        self._draw()
        return "break"

    def _release(self, event=None):
        if self.state != "normal":
            return "break"
        was_pressed = self.pressed
        self.pressed = False
        self._draw()
        if was_pressed and event and 0 <= event.x <= self.pixel_width and 0 <= event.y <= self.pixel_height:
            self.command()
        return "break"

    def _focus_in(self, _event=None) -> None:
        self.focused = True
        self._draw()

    def _focus_out(self, _event=None) -> None:
        self.focused = False
        self._draw()

    def _key_activate(self, _event=None):
        if self.state == "normal":
            self.command()
        return "break"

    def _draw(self) -> None:
        self.delete("all")
        active = self.state == "normal"
        fill = self.hover_background if active and (self.hovered or self.pressed) else self.background
        foreground = self.foreground if active else self.disabled_foreground
        inset = max(1, round(self.scale)) if self.focused else 0
        outline = "#77797d" if self.focused else ""
        draw_rounded_rectangle(
            self,
            inset,
            inset,
            self.pixel_width - inset,
            self.pixel_height - inset,
            max(1, self.radius - inset),
            fill=fill,
            outline=outline,
            width=max(1, round(self.scale)),
        )
        self.create_text(
            self.pixel_width // 2,
            self.pixel_height // 2,
            text=self.text,
            fill=foreground,
            font=self.font,
        )


class PocketWindow:
    SIDEBAR = "#edf3f5"
    SIDEBAR_ACTIVE = "#dfe8eb"
    SURFACE = "#ffffff"
    FIELD = "#f7f7f8"
    INK = "#202123"
    MUTED = "#626469"
    SUBTLE = "#6b6d72"
    LINE = "#e4e4e7"
    PRIMARY = "#202123"
    PRIMARY_HOVER = "#343438"
    SOFT = "#f0f0f2"
    SOFT_HOVER = "#e5e5e7"
    SUCCESS = "#0b9963"
    WARNING = "#c77a17"
    DANGER = "#cf4b3f"
    ERROR_BG = "#fff3f1"
    ERROR_INK = "#8f2f27"
    EMPTY_VALUE = "尚未生成"

    def __init__(self, root: tk.Tk):
        self.root = root
        self.scale = dpi_scale(self.root.winfo_fpixels("1i"))
        self.stroke = max(1, round(self.scale))
        self.fonts = self._create_fonts()
        self.root.option_add("*Font", self.fonts["body"])
        self.root.title("Codex Pocket")
        self.root.configure(bg=self.SIDEBAR)
        self.root.protocol("WM_DELETE_WINDOW", self.close)
        self._size_window()
        self._set_window_icon()

        self.status_var = tk.StringVar(value="服务已停止")
        self.url_var = tk.StringVar(value=self.EMPTY_VALUE)
        self.key_var = tk.StringVar(value=self.EMPTY_VALUE)
        self.error_var = tk.StringVar(value="")
        self.busy = False
        self.closing = False

        self.manager = ServiceManager(
            on_status=lambda value: self._post_ui(self._set_starting_status, value),
            on_ready=lambda url, key: self._post_ui(self._service_ready, url, key),
            on_failure=lambda message: self._post_ui(self._service_failed, message),
        )
        self._build()

    def _post_ui(self, callback, *args) -> None:
        try:
            self.root.after(0, callback, *args)
        except (RuntimeError, tk.TclError):
            pass

    def _px(self, value: float) -> int:
        return max(1, round(value * self.scale))

    def _font_family(self, *candidates: str) -> str:
        available = {name.casefold(): name for name in tkfont.families(self.root)}
        for candidate in candidates:
            if candidate.casefold() in available:
                return available[candidate.casefold()]
        return candidates[-1]

    def _create_fonts(self) -> dict[str, tkfont.Font]:
        cjk = self._font_family(
            "Noto Sans SC",
            "MiSans",
            "Microsoft YaHei UI",
        )
        cjk_medium = self._font_family(
            "Noto Sans SC Medium",
            "HarmonyOS Sans SC",
            "Microsoft YaHei UI",
        )
        latin_display = self._font_family(
            "Segoe UI Variable Display Semib",
            "Segoe UI Variable Display",
            "Segoe UI Variable Text",
            "Segoe UI",
        )
        latin_text = self._font_family(
            "Segoe UI Variable Text",
            "Segoe UI",
        )
        mono = self._font_family("Cascadia Mono", "Cascadia Code", "Consolas")
        return {
            "brand": tkfont.Font(root=self.root, family=latin_display, size=15),
            "latin_body": tkfont.Font(root=self.root, family=latin_text, size=10),
            "title": tkfont.Font(root=self.root, family=cjk_medium, size=15),
            "section": tkfont.Font(root=self.root, family=cjk_medium, size=12),
            "body": tkfont.Font(root=self.root, family=cjk, size=10),
            "body_bold": tkfont.Font(root=self.root, family=cjk_medium, size=10),
            "caption": tkfont.Font(root=self.root, family=cjk, size=9),
            "caption_bold": tkfont.Font(root=self.root, family=cjk_medium, size=9),
            "mono": tkfont.Font(root=self.root, family=mono, size=10),
        }

    def _size_window(self) -> None:
        width = self._px(760)
        height = self._px(500)
        screen_width = self.root.winfo_screenwidth()
        screen_height = self.root.winfo_screenheight()
        x = max(0, (screen_width - width) // 2)
        y = max(0, (screen_height - height) // 2)
        self.root.geometry(f"{width}x{height}+{x}+{y}")
        self.root.minsize(self._px(680), self._px(500))

    def _set_window_icon(self) -> None:
        size = max(32, self._px(32))
        self.app_icon = tk.PhotoImage(width=size, height=size)
        self.app_icon.put(self.PRIMARY, to=(0, 0, size, size))
        self.app_icon.put(
            "#ffffff",
            to=(self._px(7), self._px(8), self._px(11), self._px(12)),
        )
        self.app_icon.put(
            "#ffffff",
            to=(self._px(10), self._px(11), self._px(14), self._px(15)),
        )
        self.app_icon.put(
            "#ffffff",
            to=(self._px(7), self._px(18), self._px(15), self._px(21)),
        )
        self.app_icon.put(
            "#ffffff",
            to=(self._px(17), self._px(19), self._px(25), self._px(22)),
        )
        self.root.iconphoto(True, self.app_icon)

    def _build(self) -> None:
        shell = tk.Frame(self.root, bg=self.SURFACE)
        shell.pack(fill="both", expand=True)

        sidebar = tk.Frame(shell, width=self._px(190), bg=self.SIDEBAR)
        sidebar.pack(side="left", fill="y")
        sidebar.pack_propagate(False)

        brand = tk.Frame(sidebar, bg=self.SIDEBAR)
        brand.pack(fill="x", padx=self._px(22), pady=(self._px(24), self._px(32)))
        tk.Label(
            brand,
            text="Codex",
            bg=self.SIDEBAR,
            fg=self.INK,
            font=self.fonts["brand"],
        ).pack(side="left")
        tk.Label(
            brand,
            text="Pocket",
            bg=self.SIDEBAR,
            fg=self.MUTED,
            font=self.fonts["latin_body"],
        ).pack(side="left", padx=(self._px(6), 0), pady=(self._px(3), 0))

        tk.Label(
            sidebar,
            text="工作区",
            bg=self.SIDEBAR,
            fg=self.SUBTLE,
            anchor="w",
            font=self.fonts["caption_bold"],
        ).pack(fill="x", padx=self._px(22), pady=(0, self._px(8)))
        nav_width = self._px(170)
        nav_height = self._px(40)
        nav_item = tk.Canvas(
            sidebar,
            width=nav_width,
            height=nav_height,
            bg=self.SIDEBAR,
            bd=0,
            highlightthickness=0,
        )
        draw_rounded_rectangle(
            nav_item,
            0,
            0,
            nav_width,
            nav_height,
            self._px(8),
            fill=self.SIDEBAR_ACTIVE,
            outline="",
        )
        nav_item.create_text(
            self._px(12),
            nav_height // 2,
            text="远程访问",
            fill=self.INK,
            font=self.fonts["body_bold"],
            anchor="w",
        )
        nav_item.pack(padx=self._px(10))

        status = tk.Frame(sidebar, bg=self.SIDEBAR)
        status.pack(side="bottom", fill="x", padx=self._px(22), pady=self._px(24))
        tk.Label(
            status,
            text="连接状态",
            bg=self.SIDEBAR,
            fg=self.SUBTLE,
            anchor="w",
            font=self.fonts["caption_bold"],
        ).pack(fill="x", pady=(0, self._px(9)))
        status_row = tk.Frame(status, bg=self.SIDEBAR)
        status_row.pack(fill="x")
        dot_size = self._px(12)
        self.status_dot = tk.Canvas(
            status_row,
            width=dot_size,
            height=dot_size,
            bg=self.SIDEBAR,
            highlightthickness=0,
        )
        inset = self._px(3)
        self.status_dot_item = self.status_dot.create_oval(
            inset,
            inset,
            dot_size - inset,
            dot_size - inset,
            fill=self.SUBTLE,
            outline="",
        )
        self.status_dot.pack(side="left", padx=(0, self._px(7)))
        tk.Label(
            status_row,
            textvariable=self.status_var,
            bg=self.SIDEBAR,
            fg=self.MUTED,
            anchor="w",
            justify="left",
            wraplength=self._px(125),
            font=self.fonts["caption"],
        ).pack(side="left", fill="x", expand=True)

        main = tk.Frame(shell, bg=self.SURFACE)
        main.pack(side="left", fill="both", expand=True)

        toolbar = tk.Frame(
            main,
            height=self._px(72),
            bg=self.SURFACE,
            padx=self._px(32),
        )
        toolbar.pack(fill="x")
        toolbar.pack_propagate(False)
        tk.Label(
            toolbar,
            text="远程访问",
            bg=self.SURFACE,
            fg=self.INK,
            font=self.fonts["title"],
        ).pack(side="left")

        self.toggle_button = RoundedTextButton(
            toolbar,
            text="开启服务",
            command=self.toggle_service,
            font=self.fonts["body_bold"],
            scale=self.scale,
            parent_background=self.SURFACE,
        )
        self.toggle_button.pack(side="right")
        tk.Frame(main, bg=self.LINE, height=self.stroke).pack(fill="x")

        content = tk.Frame(
            main,
            bg=self.SURFACE,
            padx=self._px(38),
            pady=self._px(34),
        )
        content.pack(fill="both", expand=True)
        tk.Label(
            content,
            text="连接信息",
            bg=self.SURFACE,
            fg=self.INK,
            anchor="w",
            font=self.fonts["section"],
        ).pack(fill="x", pady=(0, self._px(24)))

        self.error_banner = tk.Frame(
            content,
            bg=self.ERROR_BG,
            highlightthickness=self.stroke,
            highlightbackground="#f1cbc6",
        )
        error_body = tk.Frame(self.error_banner, bg=self.ERROR_BG)
        error_body.pack(fill="x", padx=self._px(13), pady=self._px(10))
        error_dot = tk.Canvas(
            error_body,
            width=self._px(12),
            height=self._px(12),
            bg=self.ERROR_BG,
            highlightthickness=0,
        )
        error_dot.create_oval(
            self._px(2),
            self._px(2),
            self._px(10),
            self._px(10),
            fill=self.DANGER,
            outline="",
        )
        error_dot.pack(side="left", anchor="n", pady=self._px(6))
        tk.Label(
            error_body,
            textvariable=self.error_var,
            bg=self.ERROR_BG,
            fg=self.ERROR_INK,
            justify="left",
            anchor="w",
            wraplength=self._px(360),
            font=self.fonts["caption"],
        ).pack(side="left", fill="x", expand=True, padx=(self._px(8), self._px(4)))
        self.dismiss_error_button = IconButton(
            error_body,
            icon="close",
            command=lambda: self._set_error(""),
            tooltip="关闭提示",
            font=self.fonts["caption"],
            scale=self.scale,
            background=self.ERROR_BG,
            hover_background="#f9ddd8",
            foreground=self.ERROR_INK,
            disabled_foreground=self.SUBTLE,
            enabled=True,
        )
        self.dismiss_error_button.pack(side="right")

        self.fields = tk.Frame(content, bg=self.SURFACE)
        self.fields.pack(fill="x")
        self.url_entry = self._field_row(
            self.fields,
            "公网链接",
            self.url_var,
            [
                ("copy_url", "copy", self.copy_url, "复制链接"),
                ("open_url", "external", self.open_url, "在浏览器中打开"),
            ],
        )
        self.key_entry = self._field_row(
            self.fields,
            "访问密钥",
            self.key_var,
            [("copy_key", "copy", self.copy_key, "复制密钥")],
        )

        footer = tk.Frame(content, bg=self.SURFACE)
        footer.pack(side="bottom", fill="x")
        tk.Frame(footer, bg=self.LINE, height=self.stroke).pack(fill="x", pady=(0, self._px(15)))
        tk.Label(
            footer,
            text="停止服务后，本次链接和密钥立即失效",
            bg=self.SURFACE,
            fg=self.MUTED,
            anchor="w",
            font=self.fonts["caption"],
        ).pack(fill="x")

    def _field_row(self, parent, label: str, variable, actions):
        group = tk.Frame(parent, bg=self.SURFACE)
        group.pack(fill="x", pady=(0, self._px(21)))
        tk.Label(
            group,
            text=label,
            bg=self.SURFACE,
            fg=self.INK,
            anchor="w",
            font=self.fonts["body_bold"],
        ).pack(fill="x", pady=(0, self._px(8)))

        field_height = self._px(48)
        field = tk.Canvas(
            group,
            height=field_height,
            bg=self.SURFACE,
            bd=0,
            highlightthickness=0,
        )
        field.pack(fill="x")
        inner = tk.Frame(field, bg=self.FIELD)
        inner.place(
            x=self._px(10),
            y=self._px(4),
            relwidth=1,
            width=-self._px(20),
            height=self._px(40),
        )

        field_focused = False

        def draw_field(_event=None) -> None:
            width = max(field.winfo_width(), self._px(100))
            field.delete("surface")
            draw_rounded_rectangle(
                field,
                self.stroke,
                self.stroke,
                width - self.stroke - 1,
                field_height - self.stroke - 1,
                self._px(8),
                fill=self.FIELD,
                outline="#85868a" if field_focused else self.LINE,
                width=self.stroke,
                tags="surface",
            )
            field.tag_lower("surface")

        entry = tk.Entry(
            inner,
            textvariable=variable,
            state="readonly",
            readonlybackground=self.FIELD,
            fg=self.INK,
            selectbackground="#d9e8ed",
            selectforeground=self.INK,
            relief="flat",
            bd=0,
            highlightthickness=0,
            exportselection=False,
            font=self.fonts["mono"],
        )
        entry.pack(side="left", fill="both", expand=True)

        def set_field_focus(value: bool) -> None:
            nonlocal field_focused
            field_focused = value
            draw_field()

        entry.bind("<FocusIn>", lambda _event: set_field_focus(True), add="+")
        entry.bind("<FocusOut>", lambda _event: set_field_focus(False), add="+")
        field.bind("<Configure>", draw_field, add="+")
        for identifier, icon, command, tooltip in actions:
            button = IconButton(
                inner,
                icon=icon,
                command=command,
                tooltip=tooltip,
                font=self.fonts["caption"],
                scale=self.scale,
                background=self.FIELD,
                hover_background=self.SOFT_HOVER,
                foreground=self.INK,
                disabled_foreground="#b5b5b9",
            )
            button.pack(side="left", padx=(self._px(4), 0))
            if identifier == "copy_url":
                self.copy_url_button = button
            elif identifier == "open_url":
                self.open_url_button = button
            elif identifier == "copy_key":
                self.copy_key_button = button
        return entry

    def _configure_toggle(self, text: str, state: str, variant: str) -> None:
        if variant == "primary":
            background = self.PRIMARY
            hover = self.PRIMARY_HOVER
            foreground = "#ffffff"
            disabled = "#d5d5d8"
        else:
            background = self.SOFT
            hover = self.SOFT_HOVER
            foreground = self.INK
            disabled = self.SUBTLE
        self.toggle_button.set_style(
            text=text,
            state=state,
            background=background,
            hover_background=hover,
            foreground=foreground,
            disabled_foreground=disabled,
        )

    def _set_status_color(self, color: str) -> None:
        self.status_dot.itemconfigure(self.status_dot_item, fill=color)

    def _set_controls_enabled(self, enabled: bool) -> None:
        self.copy_url_button.set_enabled(enabled)
        self.open_url_button.set_enabled(enabled)
        self.copy_key_button.set_enabled(enabled)

    def _set_error(self, message: str) -> None:
        self.error_var.set(message)
        if message:
            if not self.error_banner.winfo_manager():
                self.error_banner.pack(
                    fill="x",
                    before=self.fields,
                    pady=(0, self._px(20)),
                )
        else:
            self.error_banner.pack_forget()

    def _set_starting_status(self, value: str) -> None:
        if self.closing:
            return
        self.status_var.set(value)
        self._set_status_color(self.WARNING)

    def toggle_service(self) -> None:
        if self.busy:
            return
        if self.manager.running:
            self._begin_stop()
        else:
            self._begin_start()

    def _begin_start(self) -> None:
        self.busy = True
        self.url_var.set(self.EMPTY_VALUE)
        self.key_var.set(self.EMPTY_VALUE)
        self._set_error("")
        self._set_controls_enabled(False)
        self._configure_toggle("正在开启", "disabled", "primary")
        self._set_starting_status("正在启动")
        threading.Thread(target=self._start_worker, daemon=True).start()

    def _start_worker(self) -> None:
        try:
            self.manager.start()
        except Exception as error:
            self._post_ui(self._service_failed, str(error))

    def _service_ready(self, url: str, key: str) -> None:
        if self.closing:
            return
        self.busy = False
        self.url_var.set(url)
        self.key_var.set(key)
        self.url_entry.xview_moveto(0)
        self.key_entry.xview_moveto(0)
        self._set_error("")
        self.status_var.set("服务运行中")
        self._set_status_color(self.SUCCESS)
        self._configure_toggle("停止服务", "normal", "secondary")
        self._set_controls_enabled(True)

    def _begin_stop(self) -> None:
        self.busy = True
        self._configure_toggle("正在停止", "disabled", "secondary")
        self.status_var.set("正在停止服务")
        self._set_status_color(self.SUBTLE)
        threading.Thread(target=self._stop_worker, daemon=True).start()

    def _stop_worker(self) -> None:
        self.manager.stop()
        self._post_ui(self._service_stopped)

    def _service_stopped(self) -> None:
        if self.closing:
            self.root.destroy()
            return
        self.busy = False
        self.url_var.set(self.EMPTY_VALUE)
        self.key_var.set(self.EMPTY_VALUE)
        self.status_var.set("服务已停止")
        self._set_status_color(self.SUBTLE)
        self._configure_toggle("开启服务", "normal", "primary")
        self._set_controls_enabled(False)

    def _service_failed(self, message: str) -> None:
        if self.closing:
            return
        self.manager.stop()
        self.busy = False
        self.url_var.set(self.EMPTY_VALUE)
        self.key_var.set(self.EMPTY_VALUE)
        self.status_var.set("启动失败")
        self._set_status_color(self.DANGER)
        self._configure_toggle("重新开启", "normal", "primary")
        self._set_controls_enabled(False)
        self._set_error(message)

    def _copy(self, value: str) -> None:
        if not value or value == self.EMPTY_VALUE:
            return
        self.root.clipboard_clear()
        self.root.clipboard_append(value)
        self.root.update_idletasks()

    def copy_url(self) -> None:
        self._copy(self.url_var.get())

    def copy_key(self) -> None:
        self._copy(self.key_var.get())

    def open_url(self) -> None:
        url = self.url_var.get()
        if url and url != self.EMPTY_VALUE:
            webbrowser.open(url)

    def close(self) -> None:
        if self.closing:
            return
        self.closing = True
        self.manager.request_shutdown()
        self._configure_toggle("正在关闭", "disabled", "secondary")
        self.status_var.set("正在关闭")
        threading.Thread(target=self._stop_worker, daemon=True).start()


def run_headless(
    manager_factory=ServiceManager,
    *,
    install_signal_handlers: bool = True,
) -> int:
    stopped = threading.Event()
    failures: list[str] = []

    def on_failure(message: str) -> None:
        failures.append(message)
        print(f"ERROR {message}", flush=True)
        stopped.set()

    manager = manager_factory(
        on_status=lambda value: print(f"STATUS {value}", flush=True),
        on_ready=lambda url, key: print(f"READY {url} {key}", flush=True),
        on_failure=on_failure,
    )
    previous_handlers = {}

    def request_stop(_signum, _frame) -> None:
        manager.request_shutdown()
        stopped.set()

    if install_signal_handlers:
        for signal_name in ("SIGINT", "SIGTERM"):
            signal_value = getattr(signal, signal_name, None)
            if signal_value is None:
                continue
            try:
                previous_handlers[signal_value] = signal.signal(signal_value, request_stop)
            except (OSError, ValueError):
                pass

    try:
        try:
            manager.start()
        except Exception as error:
            print(f"ERROR {error}", flush=True)
            return 1
        stopped.wait()
        return 1 if failures else 0
    finally:
        manager.request_shutdown()
        manager.stop()
        for signal_value, handler in previous_handlers.items():
            try:
                signal.signal(signal_value, handler)
            except (OSError, ValueError):
                pass


def main() -> int:
    instance_lock = SingleInstanceLock(INSTANCE_LOCK_PATH)
    if not instance_lock.acquire():
        if "--headless" in sys.argv:
            print("ERROR Codex Pocket 已经在运行", flush=True)
        elif tk is None:
            print("Codex Pocket 已经在运行。", file=sys.stderr, flush=True)
        else:
            enable_windows_dpi_awareness()
            notice = tk.Tk()
            notice.withdraw()
            messagebox.showinfo("Codex Pocket", "Codex Pocket 已经在运行。")
            notice.destroy()
        return 0

    try:
        if "--headless" in sys.argv:
            return run_headless()

        if tk is None:
            print(
                "ERROR 当前 Python 没有 Tk 图形支持，请运行系统对应的 Codex Pocket 安装器。",
                file=sys.stderr,
                flush=True,
            )
            return 1

        enable_windows_dpi_awareness()
        root = tk.Tk()
        PocketWindow(root)
        root.mainloop()
        return 0
    finally:
        instance_lock.release()


if __name__ == "__main__":
    raise SystemExit(main())
