#!/bin/sh

SCRIPT_DIR=$(CDPATH= cd -P "$(dirname "$0")" && pwd) || exit 1
exec /bin/sh "$SCRIPT_DIR/CodexPocket.sh" "$@"
