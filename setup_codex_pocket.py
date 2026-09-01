from __future__ import annotations

import argparse
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path


APP_DIR = Path(__file__).resolve().parent
DATA_DIR = APP_DIR / ".data"
RUNTIME_CONFIG_PATH = DATA_DIR / "runtime.json"
SETUP_RESULT_PATH = DATA_DIR / "setup-result.json"
REQUIREMENTS_PATH = APP_DIR / "requirements-desktop.txt"
VENV_DIR = APP_DIR / ".venv"
DESKTOP_HOST_PATH = APP_DIR / "desktop_host.py"
NODE_VERSION_PATTERN = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)")


def unique_paths(values):
    seen = set()
    result = []
    for value in values:
        if not value:
            continue
        path = Path(value).expanduser()
        key = os.path.normcase(os.path.abspath(str(path)))
        if key in seen:
            continue
        seen.add(key)
        result.append(path)
    return result


def read_runtime_config(path: Path = RUNTIME_CONFIG_PATH) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, TypeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def configured_path(config: dict, component: str) -> str:
    value = config.get(component, {})
    if not isinstance(value, dict):
        return ""
    path = value.get("Path")
    return path if isinstance(path, str) else ""


def is_accessible_file(value: str | Path, *, executable: bool = False) -> bool:
    try:
        path = Path(value)
        return path.is_file() and (not executable or os.access(path, os.X_OK))
    except (OSError, TypeError, ValueError):
        return False


def is_accessible_directory(value: str | Path) -> bool:
    try:
        return Path(value).is_dir()
    except (OSError, TypeError, ValueError):
        return False


def write_json_atomic(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    try:
        temporary.write_text(
            json.dumps(value, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def common_bin_directories(system_name: str | None = None):
    system_name = (system_name or platform.system()).lower()
    home = Path.home()
    values = os.environ.get("PATH", "").split(os.pathsep)
    values.extend(
        [
            home / ".local" / "bin",
            home / ".volta" / "bin",
            home / ".npm-global" / "bin",
            home / ".asdf" / "shims",
            home / ".mise" / "shims",
            home / ".local" / "share" / "mise" / "shims",
            home / ".bun" / "bin",
            home / "miniconda3" / "bin",
            home / "anaconda3" / "bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
        ]
    )
    if system_name == "darwin":
        values.extend(["/opt/homebrew/bin", "/opt/local/bin"])
    elif system_name == "linux":
        values.extend(["/snap/bin", "/var/lib/flatpak/exports/bin"])

    patterns = [
        ".nvm/versions/node/*/bin",
        ".fnm/node-versions/*/installation/bin",
        ".local/share/fnm/node-versions/*/installation/bin",
        ".asdf/installs/nodejs/*/bin",
        ".local/share/mise/installs/node/*/bin",
    ]
    for pattern in patterns:
        values.extend(sorted(home.glob(pattern), reverse=True))
    return unique_paths(values)


def resolve_candidate(value: str | Path, search_directories) -> Path | None:
    text = os.path.expandvars(os.path.expanduser(str(value))).strip()
    if not text:
        return None

    path = Path(text)
    if is_accessible_file(path, executable=True):
        return path.absolute()

    if path.parent != Path("."):
        return None

    search_path = os.pathsep.join(str(item) for item in search_directories)
    found = shutil.which(text, path=search_path)
    if not found:
        return None
    found_path = Path(found)
    return found_path.absolute() if is_accessible_file(found_path) else None


def command_candidates(name: str, configured: str = "", environment_name: str = ""):
    directories = common_bin_directories()
    values = [configured]
    if environment_name:
        values.append(os.environ.get(environment_name, ""))
    values.append(name)
    values.extend(directory / name for directory in directories)
    return unique_paths(
        path
        for value in values
        if (path := resolve_candidate(value, directories)) is not None
    )


def portable_environment(extra_paths=()) -> dict:
    env = os.environ.copy()
    directories = []
    for value in extra_paths:
        if not value:
            continue
        path = Path(value)
        if is_accessible_directory(path):
            directories.append(path)
        elif path.parent != Path("."):
            directories.append(path.parent)
    directories.extend(common_bin_directories())
    env["PATH"] = os.pathsep.join(str(path) for path in unique_paths(directories))
    return env


def command_output(command, timeout: float = 10) -> str | None:
    try:
        result = subprocess.run(
            list(command),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=portable_environment([command[0]]),
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return result.stdout.strip() if result.returncode == 0 else None


def resolve_node(config: dict) -> tuple[str, str]:
    for candidate in command_candidates(
        "node",
        configured_path(config, "Node"),
        "NODE_BIN",
    ):
        output = command_output([str(candidate), "--version"])
        match = NODE_VERSION_PATTERN.match(output or "")
        if not match or int(match.group(1)) < 20:
            continue
        return str(candidate), ".".join(match.groups())
    raise RuntimeError(
        "未找到 Node.js 20 或更高版本。安装 Node.js 后重新运行安装器。"
    )


def macos_codex_app_candidates():
    roots = [Path("/Applications"), Path.home() / "Applications"]
    relative_candidates = [
        "Codex.app/Contents/Resources/codex",
        "Codex.app/Contents/Resources/bin/codex",
        "Codex.app/Contents/MacOS/codex",
    ]
    for root in roots:
        for relative in relative_candidates:
            yield root / relative


def resolve_codex(config: dict) -> str:
    candidates = list(
        command_candidates(
            "codex",
            configured_path(config, "Codex"),
            "CODEX_BIN",
        )
    )
    if platform.system().lower() == "darwin":
        candidates.extend(macos_codex_app_candidates())

    for candidate in unique_paths(candidates):
        if not is_accessible_file(candidate, executable=True):
            continue
        if command_output([str(candidate), "--version"]):
            return str(candidate.absolute())
    raise RuntimeError(
        "未找到可用的 Codex CLI。请先安装 Codex CLI，或打开一次 Codex App。"
    )


def ensure_project_virtualenv() -> None:
    expected = VENV_DIR.resolve()
    current = Path(sys.prefix).resolve()
    if current != expected:
        raise RuntimeError(
            "macOS/Linux 必须使用项目内 .venv。请运行 Install-CodexPocket.command "
            "或 Install-CodexPocket.sh。"
        )


def run_pip(arguments) -> None:
    command = [
        sys.executable,
        "-m",
        "pip",
        "install",
        "--disable-pip-version-check",
        *arguments,
    ]
    if subprocess.run(command, cwd=APP_DIR, check=False).returncode != 0:
        raise RuntimeError("Python 桌面依赖安装失败。")


def probe_python(code: str) -> bool:
    try:
        result = subprocess.run(
            [sys.executable, "-c", code],
            cwd=APP_DIR,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=20,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0


def ensure_desktop_dependencies(system_name: str | None = None) -> str:
    system_name = (system_name or platform.system()).lower()
    if not probe_python("import webview"):
        run_pip(["-r", str(REQUIREMENTS_PATH)])

    if system_name == "darwin":
        cocoa_ready = probe_python("import webview.platforms.cocoa")
        if not cocoa_ready:
            run_pip(["-r", str(REQUIREMENTS_PATH)])
            cocoa_ready = probe_python("import webview.platforms.cocoa")
        if not cocoa_ready:
            raise RuntimeError("macOS Cocoa 桌面后端不可用。")
        return "cocoa"

    if system_name == "linux":
        if probe_python("import webview.platforms.gtk"):
            return "gtk"
        if probe_python("import webview.platforms.qt"):
            return "qt"

        print("未检测到 GTK/Qt，正在项目虚拟环境中安装 Qt 桌面后端...", flush=True)
        run_pip(["pywebview[pyside6]>=5.4,<6"])
        if not probe_python("import webview.platforms.qt"):
            raise RuntimeError(
                "Linux Qt 桌面后端不可用。请查看 README 中对应发行版的原生依赖说明。"
            )
        return "qt"

    raise RuntimeError(f"此安装器不支持当前系统：{platform.system()}")


def prepare_cloudflared() -> str:
    from codex_pocket import ensure_cloudflared

    return ensure_cloudflared(lambda message: print(message, flush=True))


def write_runtime_config(node_path: str, node_version: str, codex_path: str) -> None:
    write_json_atomic(
        RUNTIME_CONFIG_PATH,
        {
            "SchemaVersion": 1,
            "UpdatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "Python": {
                "Path": str(Path(sys.executable).absolute()),
                "Version": platform.python_version(),
            },
            "Node": {"Path": node_path, "Version": node_version},
            "Codex": {"Path": codex_path},
        },
    )


def launch_desktop(
    node_path: str,
    codex_path: str,
    headless: bool = False,
    system_name: str | None = None,
) -> None:
    system_name = (system_name or platform.system()).lower()
    if not headless and system_name == "linux":
        if not os.environ.get("DISPLAY") and not os.environ.get("WAYLAND_DISPLAY"):
            raise RuntimeError(
                "未检测到 Linux 图形会话。服务器环境请使用 CodexPocket.sh --headless。"
            )

    env = os.environ.copy()
    env["NODE_BIN"] = node_path
    env["CODEX_BIN"] = codex_path
    env["PATH"] = portable_environment([node_path, codex_path])["PATH"]
    target = APP_DIR / ("codex_pocket.py" if headless else "desktop_host.py")
    arguments = [sys.executable, str(target)]
    if headless:
        arguments.append("--headless")
        exit_code = subprocess.call(arguments, cwd=APP_DIR, env=env)
        if exit_code != 0:
            raise RuntimeError(f"无图形模式退出（代码 {exit_code}）。")
        return

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    launcher_log = DATA_DIR / "launcher.log"
    with launcher_log.open("a", encoding="utf-8") as output:
        process = subprocess.Popen(
            arguments,
            cwd=APP_DIR,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=output,
            stderr=subprocess.STDOUT,
            start_new_session=True,
            close_fds=True,
        )
    time.sleep(0.75)
    exit_code = process.poll()
    if exit_code not in (None, 0):
        raise RuntimeError(
            f"桌面程序启动失败（代码 {exit_code}），请查看 {launcher_log}。"
        )


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Set up Codex Pocket on macOS/Linux")
    parser.add_argument("--install", action="store_true", help="prepare dependencies")
    parser.add_argument("--start", action="store_true", help="start the desktop app")
    parser.add_argument("--check", action="store_true", help="only check the environment")
    parser.add_argument("--headless", action="store_true", help="run without a desktop window")
    return parser.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    system_name = platform.system().lower()
    result = {
        "Ok": False,
        "UpdatedAt": None,
        "Platform": platform.system(),
        "Architecture": platform.machine(),
        "ProjectRoot": str(APP_DIR),
        "Python": None,
        "Node": None,
        "Codex": None,
        "Cloudflared": None,
        "DesktopBackend": None,
        "Started": False,
        "Error": None,
    }

    try:
        if system_name not in {"darwin", "linux"}:
            raise RuntimeError("此入口仅用于 macOS/Linux；Windows 请双击安装 .cmd。")
        if sys.version_info < (3, 8):
            raise RuntimeError("需要 Python 3.8 或更高版本。")
        ensure_project_virtualenv()
        if not REQUIREMENTS_PATH.is_file() or not DESKTOP_HOST_PATH.is_file():
            raise RuntimeError("项目文件不完整，请重新下载整个仓库。")

        config = read_runtime_config()
        print("正在检查 Python、Node.js 和 Codex...", flush=True)
        node_path, node_version = resolve_node(config)
        os.environ["NODE_BIN"] = node_path
        os.environ["PATH"] = portable_environment([node_path])["PATH"]
        codex_path = resolve_codex(config)
        backend = ensure_desktop_dependencies(system_name)
        cloudflared_path = ""
        if args.install:
            print("正在准备 Cloudflared...", flush=True)
            cloudflared_path = prepare_cloudflared()

        write_runtime_config(node_path, node_version, codex_path)
        result["Python"] = {
            "Path": str(Path(sys.executable).absolute()),
            "Version": platform.python_version(),
        }
        result["Node"] = {"Path": node_path, "Version": node_version}
        result["Codex"] = {"Path": codex_path}
        result["DesktopBackend"] = backend
        if cloudflared_path:
            result["Cloudflared"] = {"Path": cloudflared_path}

        if args.check:
            print(f"Python: {sys.executable} ({platform.python_version()})")
            print(f"Node.js: {node_path} ({node_version})")
            print(f"Codex: {codex_path}")
            print(f"Desktop backend: {backend}")

        if args.start or args.headless:
            print("正在启动 Codex Pocket...", flush=True)
            launch_desktop(node_path, codex_path, headless=args.headless)
            result["Started"] = True

        result["Ok"] = True
        return 0
    except SystemExit:
        raise
    except Exception as error:
        result["Error"] = str(error)
        print(f"安装失败：{error}", file=sys.stderr, flush=True)
        return 1
    finally:
        result["UpdatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        write_json_atomic(SETUP_RESULT_PATH, result)


if __name__ == "__main__":
    raise SystemExit(main())
