#!/bin/sh

set -u

SCRIPT_DIR=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
if [ -z "$SCRIPT_DIR" ]; then
    echo "Unable to locate the Codex Pocket directory." >&2
    exit 1
fi

VENV_PYTHON="$SCRIPT_DIR/.venv/bin/python"
if [ ! -x "$VENV_PYTHON" ] || ! "$VENV_PYTHON" -c \
    'import os, sys; raise SystemExit(0 if os.path.realpath(sys.prefix) == os.path.realpath(sys.argv[1]) else 1)' \
    "$SCRIPT_DIR/.venv" >/dev/null 2>&1
then
    exec /bin/sh "$SCRIPT_DIR/Install-CodexPocket.sh"
fi

case "${1:-}" in
    --check)
        exec "$VENV_PYTHON" "$SCRIPT_DIR/setup_codex_pocket.py" --check
        ;;
    --headless)
        exec "$VENV_PYTHON" "$SCRIPT_DIR/setup_codex_pocket.py" --headless
        ;;
    *)
        exec "$VENV_PYTHON" "$SCRIPT_DIR/setup_codex_pocket.py" --start
        ;;
esac
