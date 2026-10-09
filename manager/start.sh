#!/usr/bin/env bash
# WarOnPaper product launcher (manager entry).
#
# Usage (from this directory or via repo-root start.sh):
#   ./start.sh
#   PORT=4358 ./start.sh
#   WOP_BUILD=1 ./start.sh          # force rebuild core + manager
#
# Optional env:
#   PORT          listen port (default 4358; passed through to start.js)
#   WOP_BUILD     set to 1 to force rebuild before start
#   WOP_SAVE_KEY  optional override of config.json saveKey
#
# Save AES key primary source: repo-root config.json → saveKey
# Build / install / serve logic lives in start.js — this wrapper only
# resolves paths and invokes Node on Linux.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd -- "$SCRIPT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "[wop-start] error: node not found in PATH" >&2
  echo "[wop-start] install Node.js (LTS recommended), then retry." >&2
  exit 1
fi

if [[ ! -f "$SCRIPT_DIR/start.js" ]]; then
  echo "[wop-start] error: start.js missing next to this script:" >&2
  echo "  $SCRIPT_DIR/start.js" >&2
  exit 1
fi

export PORT="${PORT:-4358}"

exec node start.js "$@"
