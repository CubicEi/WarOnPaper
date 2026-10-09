#!/usr/bin/env bash
# WarOnPaper product launcher (repo root).
#
# Usage:
#   ./start.sh
#   PORT=4358 ./start.sh
#   WOP_BUILD=1 ./start.sh          # force rebuild core + manager
#   WOP_SAVE_KEY=… ./start.sh       # optional override of config.json saveKey
#
# Delegates to manager/start.sh so Linux servers have one entry at the
# repo root and the real wrapper next to start.js.
# Primary save key: repo-root config.json → saveKey

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
MANAGER_START="$ROOT_DIR/manager/start.sh"

if [[ ! -f "$MANAGER_START" ]]; then
  echo "[wop-start] error: manager/start.sh not found at:" >&2
  echo "  $MANAGER_START" >&2
  exit 1
fi

exec bash "$MANAGER_START" "$@"
