"""Install shared Codex launch settings for the current desktop user."""

import argparse
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
LABEL = "com.codexpocket.desktop-launch"
ENV_NAMES = ("CODEX_APP_SERVER_FORCE_CLI", "CODEX_CLI_PATH")


def run(*args, check=True):
    return subprocess.run(args, check=check, text=True, encoding="utf-8", capture_output=True, timeout=60)


def read_environment():
    return {name: run("/bin/launchctl", "getenv", name, check=False).stdout.rstrip("\n")
            for name in ENV_NAMES}


def restore_environment(previous, installed):
    current = read_environment()
    for name in ENV_NAMES:
        if current[name] != installed[name]:
            continue
        if previous[name]:
            run("/bin/launchctl", "setenv", name, previous[name])
        else:
            run("/bin/launchctl", "unsetenv", name)


def launch_agent(node, codex=None):
    return {
        "Label": LABEL,
        "ProgramArguments": [node, str(ROOT / "scripts/desktop-auto-connect.mjs"), "--activate"] + (["--codex", codex] if codex else []),
        "RunAtLoad": True,
        "LimitLoadToSessionType": "Aqua",
        "StandardErrorPath": str(ROOT / ".data/desktop-auto-connect.log"),
    }


def windows_environment():
    import winreg
    result = {}
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, "Environment") as key:
        for name in ENV_NAMES:
            try:
                value, kind = winreg.QueryValueEx(key, name)
                result[name] = {"value": value, "kind": kind}
            except FileNotFoundError:
                result[name] = None
    return result


def write_windows_environment(values):
    import winreg
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, "Environment") as key:
        for name, entry in values.items():
            if entry is None:
                try:
                    winreg.DeleteValue(key, name)
                except FileNotFoundError:
                    pass
                os.environ.pop(name, None)
            else:
                winreg.SetValueEx(key, name, 0, entry["kind"], entry["value"])
                os.environ[name] = entry["value"]


def notify_windows_environment():
    import ctypes
    from ctypes import wintypes
    send = ctypes.WinDLL("user32", use_last_error=True).SendMessageTimeoutW
    send.argtypes = [wintypes.HWND, wintypes.UINT, ctypes.c_size_t, wintypes.LPCWSTR,
                     wintypes.UINT, wintypes.UINT, ctypes.POINTER(ctypes.c_size_t)]
    send.restype = ctypes.c_ssize_t
    result = ctypes.c_size_t()
    # Explorer refreshes the environment used for new Start-menu launches.
    if not send(0xFFFF, 0x001A, 0, "Environment", 0x0002, 5000, ctypes.byref(result)):
        raise RuntimeError("Windows did not acknowledge the launch environment update. Retry setup.")


def save_state(path, state):
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(state), encoding="utf-8")
    temporary.chmod(0o600)
    temporary.replace(path)


def install_windows(uninstall, node, codex):
    import winreg
    state_path = ROOT / ".data/desktop-launch-environment.json"
    state = json.loads(state_path.read_text(encoding="utf-8")) if state_path.exists() else None
    before = windows_environment()
    if uninstall:
        if state:
            restore = {name: state["previous"][name] for name in ENV_NAMES
                       if before[name] == state["installed"][name]}
            write_windows_environment(restore)
            notify_windows_environment()
            state_path.unlink()
        return
    if not codex or Path(codex).suffix.lower() != ".exe":
        raise RuntimeError("Shared desktop setup requires the native Codex .exe. Install Codex App and retry setup.")
    environment = proxy_environment(node, codex)
    installed = {name: {"value": value, "kind": winreg.REG_SZ} for name, value in environment.items()}
    if state and state["installed"] == installed and before == installed:
        return
    ROOT.joinpath(".data").mkdir(exist_ok=True)
    # Save recovery information before changing the user's registry.
    save_state(state_path, {"previous": state["previous"] if state else before, "installed": installed})
    try:
        write_windows_environment(installed)
        if windows_environment() != installed:
            raise RuntimeError("Windows shared launch settings could not be verified")
        notify_windows_environment()
    except Exception:
        write_windows_environment(before)
        if state:
            save_state(state_path, state)
        else:
            state_path.unlink(missing_ok=True)
        raise
    print("Codex shared launch installed for the current Windows user.")


def proxy_environment(node, codex=None):
    args = [node, str(ROOT / "scripts/desktop-auto-connect.mjs")]
    if codex:
        args.extend(["--codex", codex])
    return json.loads(run(*args).stdout)


def install(uninstall=False, node=None, codex=None):
    node = node or shutil.which("node")
    if not uninstall and not node:
        raise RuntimeError("Node.js was not found")
    if sys.platform == "win32":
        return install_windows(uninstall, node, codex)
    if sys.platform != "darwin":
        raise RuntimeError("Automatic desktop launch setup supports macOS and Windows")
    agent_path = Path.home() / "Library/LaunchAgents" / (LABEL + ".plist")
    state_path = ROOT / ".data/desktop-launch-environment.json"
    domain = "gui/" + str(os.getuid())
    state = json.loads(state_path.read_text()) if state_path.exists() else None
    if agent_path.exists():
        existing = plistlib.loads(agent_path.read_bytes())
        if existing.get("ProgramArguments", [None, None])[1:2] != [str(ROOT / "scripts/desktop-auto-connect.mjs")]:
            raise RuntimeError("A different Pocket installation owns this launch agent")
    if uninstall:
        if not state:
            return
        run("/bin/launchctl", "bootout", domain + "/" + LABEL, check=False)
        restore_environment(state["previous"], state["installed"])
        if agent_path.exists():
            agent_path.unlink()
        state_path.unlink()
        print("Normal Codex launch environment restored. Running apps were not stopped.")
        return
    environment = proxy_environment(node, codex)
    agent_config = launch_agent(node, codex)
    if (state and state["installed"] == environment and read_environment() == environment
            and agent_path.exists() and plistlib.loads(agent_path.read_bytes()) == agent_config
            and run("/bin/launchctl", "print", domain + "/" + LABEL, check=False).returncode == 0):
        return
    old_agent = agent_path.read_bytes() if agent_path.exists() else None
    before = read_environment()
    previous = state["previous"] if state else read_environment()
    ROOT.joinpath(".data").mkdir(exist_ok=True)
    save_state(state_path, {"previous": previous, "installed": environment})
    agent_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = agent_path.with_suffix(".plist.tmp")
    temporary.write_bytes(plistlib.dumps(agent_config))
    temporary.chmod(0o600)
    temporary.replace(agent_path)
    run("/bin/launchctl", "bootout", domain + "/" + LABEL, check=False)
    try:
        run("/bin/launchctl", "enable", domain + "/" + LABEL)
        run("/bin/launchctl", "bootstrap", domain, str(agent_path))
        # Apply synchronously too, so completion means Finder launches inherit it.
        run(*agent_config["ProgramArguments"])
        if read_environment() != environment:
            raise RuntimeError("The GUI launch environment did not update")
    except Exception:
        run("/bin/launchctl", "bootout", domain + "/" + LABEL, check=False)
        restore_environment(before, environment)
        if old_agent:
            agent_path.write_bytes(old_agent)
            run("/bin/launchctl", "bootstrap", domain, str(agent_path), check=False)
        else:
            agent_path.unlink(missing_ok=True)
        if state:
            save_state(state_path, state)
        else:
            state_path.unlink(missing_ok=True)
        raise
    print("Codex GUI auto-connect installed and verified. Running apps were not stopped.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--uninstall", action="store_true")
    parser.add_argument("--node")
    parser.add_argument("--codex")
    arguments = parser.parse_args()
    install(arguments.uninstall, arguments.node, arguments.codex)
