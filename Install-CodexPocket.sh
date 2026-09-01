#!/bin/sh

set -u

SCRIPT_DIR=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
if [ -z "$SCRIPT_DIR" ]; then
    echo "Unable to locate the Codex Pocket directory." >&2
    exit 1
fi

VENV_DIR="$SCRIPT_DIR/.venv"
VENV_PYTHON="$VENV_DIR/bin/python"

chmod +x \
    "$SCRIPT_DIR/Install-CodexPocket.sh" \
    "$SCRIPT_DIR/CodexPocket.sh" \
    "$SCRIPT_DIR/Install-CodexPocket.command" \
    "$SCRIPT_DIR/CodexPocket.command" \
    2>/dev/null || true

find_python() {
    for candidate in \
        "${POCKET_PYTHON:-}" \
        python3 \
        python \
        /opt/homebrew/bin/python3 \
        /opt/local/bin/python3 \
        /usr/local/bin/python3 \
        /usr/bin/python3 \
        "$HOME/.local/bin/python3" \
        "$HOME/.pyenv/shims/python3" \
        "$HOME/miniconda3/bin/python" \
        "$HOME/anaconda3/bin/python"
    do
        [ -n "$candidate" ] || continue
        resolved=$(command -v "$candidate" 2>/dev/null || true)
        [ -n "$resolved" ] || continue
        if "$resolved" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 8) else 1)' \
            >/dev/null 2>&1
        then
            base=$(
                "$resolved" -c \
                    'import os, sys; print(os.path.realpath(getattr(sys, "_base_executable", sys.executable)))' \
                    2>/dev/null
            )
            if [ -n "$base" ] && [ -x "$base" ]; then
                printf '%s\n' "$base"
                return 0
            fi
        fi
    done
    return 1
}

pause_after_failure() {
    if [ -t 0 ] && [ -z "${CODEX_POCKET_NO_PAUSE:-}" ]; then
        printf '\nPress Enter to close...'
        read answer
    fi
}

venv_is_ready() {
    [ -x "$VENV_PYTHON" ] || return 1
    "$VENV_PYTHON" -c \
        'import os, sys; raise SystemExit(0 if sys.version_info >= (3, 8) and os.path.realpath(sys.prefix) == os.path.realpath(sys.argv[1]) else 1)' \
        "$VENV_DIR" >/dev/null 2>&1
}

echo "Preparing Codex Pocket for $(uname -s)..."

BASE_PYTHON=$(find_python)
if [ -z "$BASE_PYTHON" ]; then
    echo "Python 3.8 or newer was not found." >&2
    echo "Install Python, then run this installer again." >&2
    pause_after_failure
    exit 1
fi

if ! venv_is_ready; then
    echo "Creating the project virtual environment..."
    if [ -d "$VENV_DIR" ]; then
        "$BASE_PYTHON" -m venv --clear "$VENV_DIR"
    else
        "$BASE_PYTHON" -m venv "$VENV_DIR"
    fi
    if ! venv_is_ready; then
        echo "Unable to create .venv." >&2
        echo "On Debian/Ubuntu, install the python3-venv package and retry." >&2
        pause_after_failure
        exit 1
    fi
fi

"$VENV_PYTHON" "$SCRIPT_DIR/setup_codex_pocket.py" --install --start
status=$?
if [ "$status" -ne 0 ]; then
    pause_after_failure
    exit "$status"
fi

echo "Codex Pocket setup completed."
