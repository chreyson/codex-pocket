#!/bin/sh
SCRIPT_DIR=$(CDPATH= cd -P "$(dirname "$0")" && pwd) || exit 1
POCKET_SHARED_PYTHON="$SCRIPT_DIR/.venv/bin/python"
if [ ! -x "$POCKET_SHARED_PYTHON" ]; then
    echo "Run the Codex Pocket installer first." >&2
    exit 1
fi
exec "$POCKET_SHARED_PYTHON" "$SCRIPT_DIR/shared_codex.py" "$@"
