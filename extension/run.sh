#!/usr/bin/env bash
# Entry point used by OpenAssist when this extension is enabled.
# Resolves the helper package and runs its dev-server in headless Node mode.
# OPENASSIST_EXTENSION_DIR is set by the host; we walk up to the repo root.
set -euo pipefail

EXT_DIR="${OPENASSIST_EXTENSION_DIR:-$(cd "$(dirname "$0")" && pwd)}"
REPO_ROOT="$(cd "$EXT_DIR/.." && pwd)"

cd "$REPO_ROOT"

# Build once if dist/ is missing — keeps cold start usable for a freshly
# cloned checkout. Subsequent runs reuse the existing build.
if [ ! -f "apps/helper/dist/dev-server.js" ]; then
  pnpm --filter @agent-pulse/helper build >&2
fi

exec node apps/helper/dist/dev-server.js
