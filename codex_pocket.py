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
from pathlib import Path


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
        # Cloudflare publishes no Windows ARM64 binary; Windows 11 supports x64 emulation.
        if arch == "arm64":
            arch = "amd64"
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
    explicit = os.environ.get("CODEX_BIN")
    for configured in (explicit,):
        if not _is_accessible_file(configured):
            continue
        configured_path = Path(configured)
        if configured_path.suffix.lower() == ".ps1":
            command_wrapper = configured_path.with_suffix(".cmd")
            if _is_accessible_file(command_wrapper):
                return str(command_wrapper)
        return configured

    # The desktop app and its app-server protocol must use the same bundled
    # CLI. A globally installed CLI can be newer (or older) and may reject the
    # app's dynamic MCP configuration during thread resume/start.
    if platform.system().lower() == "darwin":
        for candidate in (
            Path("/Applications/ChatGPT.app/Contents/Resources/codex"),
            Path("/Applications/Codex.app/Contents/Resources/codex"),
            Path.home() / "Applications/ChatGPT.app/Contents/Resources/codex",
            Path.home() / "Applications/Codex.app/Contents/Resources/codex",
        ):
            if _is_accessible_file(candidate):
                return str(candidate)

    configured = runtime_configured_path("Codex")
    if _is_accessible_file(configured):
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
            self.helper_process: subprocess.Popen | None = None

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
        # Keep the exact runtime selected for this service instance.  Desktop
        # attachment must use the same Node/Codex executable and environment
        # as the backend that was just started.
        self._runtime_node: str | None = None
        self._runtime_env: dict[str, str] | None = None
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

    def _read_stream(self, source: str, stream, run: _Run, process=None) -> None:
        try:
            for line in iter(stream.readline, ""):
                if not line:
                    break
                if source == "tunnel":
                    with self._lock:
                        if self._run is not run or (process is not None and self.tunnel_process is not process):
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

    def _watch_processes(self, run: _Run, viewer_process, tunnel_process, cloudflared: str) -> None:
        try:
            while not run.cancel.wait(1):
                viewer_code = viewer_process.poll()
                if viewer_code is not None:
                    raise RuntimeError(f"本地服务意外退出（代码 {viewer_code}）")
                if tunnel_process.poll() is not None:
                    tunnel_process = self._recover_tunnel(run, cloudflared)
        except self._StartCancelled:
            return
        except (OSError, RuntimeError) as error:
            if self._run_is_current(run):
                self._stop_run(run)
                self.on_failure(str(error))

    def _recover_tunnel(self, run: _Run, cloudflared: str):
        retry_delay = 1
        while True:
            self._check_cancelled(run)
            self.on_status("公网连接已断开，正在恢复")
            if run.cancel.wait(retry_delay):
                raise self._StartCancelled()
            self._check_viewer()
            process = None
            try:
                process = self._start_tunnel(run, cloudflared, self.port)
                self._wait_for_tunnel(run, process)
                with self._lock:
                    self._check_cancelled(run)
                    self.on_ready(self.public_url, self.access_key)
                return process
            except (OSError, RuntimeError) as error:
                terminate_process_tree(process)
                self._check_viewer()
                try:
                    self._log("tunnel", str(error))
                except OSError:
                    pass
                retry_delay = min(30, retry_delay * 2)

    def _check_viewer(self) -> None:
        if self.viewer_process is None or self.viewer_process.poll() is not None:
            raise RuntimeError("本地服务已退出，请查看日志")

    def _run_is_current(self, run: _Run) -> bool:
        with self._lock:
            return self._run is run and not run.cancel.is_set()

    def _check_cancelled(self, run: _Run) -> None:
        if not self._run_is_current(run):
            raise self._StartCancelled()

    def _spawn_process(self, run: _Run, source: str, command, env=None):
        # Register under the same lock as shutdown so a late spawn cannot escape cleanup.
        with self._lock:
            self._check_cancelled(run)
            process = subprocess.Popen(
                command, cwd=APP_DIR, env=env, stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, encoding="utf-8", errors="replace", bufsize=1,
                **hidden_process_options(),
            )
            setattr(self, f"{source}_process", process)
        for stream in (process.stdout, process.stderr):
            threading.Thread(
                target=self._read_stream, args=(source, stream, run, process), daemon=True,
            ).start()
        return process

    def _start_tunnel(self, run: _Run, cloudflared: str, port: int):
        with self._lock:
            self._check_cancelled(run)
            self._url_event.clear()
            self._connected_event.clear()
            self.public_url = ""
            self._last_tunnel_lines = []
            return self._spawn_process(run, "tunnel", [
                cloudflared, "tunnel", "--url", f"http://127.0.0.1:{port}",
                "--no-autoupdate", "--loglevel", "info",
            ])

    def _wait_for_tunnel(self, run: _Run, process, timeout: float = 60) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self._check_cancelled(run)
            self._check_viewer()
            if process.poll() is not None:
                with self._lock:
                    details = " | ".join(self._last_tunnel_lines[-3:])
                raise RuntimeError(f"公网连接启动失败：{details or '进程已退出'}")
            if self._url_event.is_set() and self._connected_event.is_set():
                return
            if run.cancel.wait(0.2):
                raise self._StartCancelled()
        raise RuntimeError("等待公网连接超时，请检查网络及出站 7844 端口")

    def _wait_for_local_service(
        self,
        run: _Run,
        viewer_process,
        port: int,
        timeout: float = 25,
    ) -> None:
        deadline = time.monotonic() + timeout
        url = f"http://127.0.0.1:{port}/api/health"
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        while time.monotonic() < deadline:
            self._check_cancelled(run)
            if viewer_process.poll() is not None:
                raise RuntimeError("本地服务启动失败，请查看日志")
            try:
                with opener.open(url, timeout=1) as response:
                    if response.status == 200 and json.load(response).get("codex") == "ready":
                        return
            except (OSError, ValueError):
                pass
            if run.cancel.wait(0.25):
                self._check_cancelled(run)
        raise RuntimeError("等待本地服务启动超时")

    def _run_shared_backend(
        self,
        node: str,
        env: dict[str, str],
        *,
        open_app: bool = False,
        run: _Run | None = None,
    ) -> None:
        """Run the shared-runtime helper while allowing the owning run to cancel it."""
        command = [node, str(APP_DIR / "scripts" / "shared-codex.mjs")]
        if open_app:
            command.append("--open-app")
        timeout = 90 if open_app else 60
        # Register the helper while holding the same lock used by stop(). This
        # closes the race where shutdown happens between the cancellation check
        # and process creation.
        with self._lock:
            if run is not None and (self._run is not run or run.cancel.is_set()):
                raise self._StartCancelled()
            process = subprocess.Popen(
                command,
                cwd=APP_DIR,
                env=dict(env),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                **hidden_process_options(),
            )
            if run is not None:
                run.helper_process = process

        try:
            deadline = time.monotonic() + timeout
            while True:
                if run is not None and (run.cancel.is_set() or not self._run_is_current(run)):
                    terminate_process_tree(process)
                    try:
                        process.communicate(timeout=5)
                    except (OSError, subprocess.TimeoutExpired):
                        pass
                    raise self._StartCancelled()
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    terminate_process_tree(process)
                    try:
                        process.communicate(timeout=5)
                    except (OSError, subprocess.TimeoutExpired):
                        pass
                    raise subprocess.TimeoutExpired(command, timeout)
                try:
                    stdout, stderr = process.communicate(timeout=min(0.25, remaining))
                    break
                except subprocess.TimeoutExpired:
                    continue

            if process.returncode:
                message = (stderr or "").strip()
                if open_app:
                    raise RuntimeError(message or "桌面 App 未接入共享后端")
                raise RuntimeError(message or "共享 Codex 启动失败")
        finally:
            with self._lock:
                if run is not None and run.helper_process is process:
                    run.helper_process = None

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
            self.public_url = ""
            self.access_key = secrets.token_urlsafe(24)
            self.port = 0
            self._url_event.clear()
            self._connected_event.clear()
            self._last_tunnel_lines = []
            self._runtime_node = None
            self._runtime_env = None
            access_key = self.access_key

        try:
            allocated_port = find_free_port()
            with self._lock:
                self._check_cancelled(run)
                self.port = allocated_port
            port = allocated_port

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

            with self._lock:
                self._check_cancelled(run)
                self._runtime_node = node
                self._runtime_env = dict(env)

            report_status("正在连接本机 Codex")
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            if env.get("POCKET_SHARED_SERVER") != "off" and not env.get("CODEX_APP_SERVER_WS_URL"):
                # Keep the backend outside the viewer tree, including Windows taskkill /T.
                self._run_shared_backend(node, env, run=run)
                self._check_cancelled(run)
            viewer_process = self._spawn_process(
                run, "viewer", [node, str(APP_DIR / "src" / "server.mjs")], env=env,
            )
            self._wait_for_local_service(run, viewer_process, port)
            self._check_cancelled(run)

            report_status("正在建立公网连接")
            tunnel_process = self._start_tunnel(run, cloudflared, port)
            self._wait_for_tunnel(run, tunnel_process)

            self._check_cancelled(run)
            with self._lock:
                public_url = self.public_url
            self.on_ready(public_url, access_key)
            threading.Thread(
                target=self._watch_processes,
                args=(run, viewer_process, tunnel_process, cloudflared),
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

    def connection_status(self) -> dict:
        with self._lock:
            port = self.port
            viewer = self.viewer_process
        if not port or viewer is None or viewer.poll() is not None:
            return {"connectionMode": "unknown", "desktopConnection": None}
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(f"http://127.0.0.1:{port}/api/health", timeout=6) as response:
            result = json.load(response)
        return {
            "connectionMode": result.get("connectionMode", "unknown"),
            "desktopConnection": result.get("desktopConnection") if result.get("codex") == "ready" else None,
        }

    def connect_desktop(self) -> None:
        with self._lock:
            run = self._run
            node = self._runtime_node
            env = dict(self._runtime_env) if self._runtime_env is not None else None
            viewer = self.viewer_process
            if (
                run is None
                or run.cancel.is_set()
                or not node
                or env is None
                or viewer is None
                or viewer.poll() is not None
            ):
                raise RuntimeError("本地服务尚未运行，无法连接桌面 App")
        try:
            self._run_shared_backend(node, env, open_app=True, run=run)
        except self._StartCancelled:
            # stop()/shutdown owns cancellation; do not surface a late error
            # or continue opening the desktop after the window has closed.
            return

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
            helper = run.helper_process
            cleanup_node = self._runtime_node
            cleanup_env = dict(self._runtime_env) if self._runtime_env is not None else None
            self.tunnel_process = None
            self.viewer_process = None
            run.helper_process = None
            self.public_url = ""
            self.access_key = ""
            self.port = 0
            self._runtime_node = None
            self._runtime_env = None
            self._url_event.clear()
            self._connected_event.clear()
            self._last_tunnel_lines = []
            self._run = None
            self._cleaning_run = run
        try:
            for process in (helper, tunnel, viewer):
                try:
                    terminate_process_tree(process)
                except Exception as error:
                    try:
                        self._log("desktop", f"进程清理失败：{error}")
                    except Exception:
                        pass
            # The shared App Server is intentionally outside the viewer
            # process tree. Reap it only when no Codex Desktop client uses it;
            # the cleanup helper preserves an App-owned active connection.
            if cleanup_node:
                try:
                    cleanup = subprocess.run(
                        [cleanup_node, str(APP_DIR / "scripts" / "shared-codex.mjs"), "--stop"],
                        cwd=APP_DIR,
                        env=cleanup_env or os.environ.copy(),
                        stdin=subprocess.DEVNULL,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        timeout=15,
                        **hidden_process_options(),
                    )
                    if cleanup.returncode != 0:
                        self._log("desktop", "共享 Codex 清理未完成，已保留现有后端")
                except (OSError, subprocess.SubprocessError) as error:
                    self._log("desktop", f"共享 Codex 清理失败，已保留现有后端：{error}")
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
    if "--headless" not in sys.argv:
        from desktop_host import main as desktop_main

        return desktop_main()

    instance_lock = SingleInstanceLock(INSTANCE_LOCK_PATH)
    if not instance_lock.acquire():
        print("ERROR Codex Pocket 已经在运行", flush=True)
        return 0

    try:
        return run_headless()
    finally:
        instance_lock.release()


if __name__ == "__main__":
    raise SystemExit(main())
