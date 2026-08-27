#!/usr/bin/env bash
set -euo pipefail
PROFILE="${1:-${DSH_TUI_PROFILE:-tui}}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v dsh >/dev/null 2>&1; then
  echo "error: 'dsh' not found on PATH" >&2
  exit 1
fi

echo "==> installing dependencies"
npm install --no-audit --no-fund

echo "==> building dsh-llm-xai-oauth"
npm run build

echo "==> linking into dsh profile '$PROFILE'"
dsh plugin --profile "$PROFILE" add "link:${REPO_DIR}"

echo "==> done"
echo "select with:  dsh --profile $PROFILE --provider xai --model grok-4.6"
