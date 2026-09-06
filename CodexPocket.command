#!/bin/sh

SCRIPT_DIR=$(CDPATH= cd -P "$(dirname "$0")" && pwd) || exit 1
/bin/sh "$SCRIPT_DIR/CodexPocket.sh" "$@"
status=$?

# A Finder-launched .command gets its own Terminal window. The actual Pocket
# desktop process is detached by setup_codex_pocket.py, so close only that
# finished launcher window instead of leaving one window per launch.
if [ "${CODEX_POCKET_KEEP_TERMINAL:-}" != "1" ]; then
    /usr/bin/osascript <<'OSA' >/dev/null 2>&1 || true
tell application "Terminal"
    repeat with candidate in (every window)
        if (name of candidate contains "CodexPocket.command") then close candidate
    end repeat
end tell
OSA
fi
exit "$status"
