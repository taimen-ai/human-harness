#!/usr/bin/env bash
# Собрать пакеты и запустить Web UI DSH с профилем human-harness.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="${DSH_PROFILE:-human-harness}"
export DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
cd "$ROOT"
pnpm build
[ -d "$DSH_HOME/profiles/$PROFILE" ] || bash scripts/profile-init.sh
exec node "$ROOT/scripts/dsh.mjs" --profile "$PROFILE" --no-open "$@"
