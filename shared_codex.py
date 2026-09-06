from __future__ import annotations

import subprocess
import sys

from setup_codex_pocket import APP_DIR, ensure_node_dependencies, portable_environment, read_runtime_config, resolve_codex, resolve_node


def main() -> int:
    config = read_runtime_config()
    node, _version = resolve_node(config)
    codex = resolve_codex(config)
    ensure_node_dependencies(node)
    env = portable_environment([node, codex])
    env["CODEX_BIN"] = codex
    command = [node, str(APP_DIR / "scripts" / "shared-codex.mjs")]
    if "--prepare" not in sys.argv:
        command.append("--open-app")
    return subprocess.run(command, cwd=APP_DIR, env=env, check=False).returncode


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
