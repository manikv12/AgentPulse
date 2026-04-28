#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
settings_path="$HOME/Library/Application Support/Agent Pulse/settings.json"
helper_script="$repo_root/apps/helper/dist/dev-server.js"

helper_port="$({
  if [[ -f "$settings_path" ]]; then
    node --input-type=module -e "import { readFileSync } from 'node:fs'; const fallback = 55110; try { const raw = readFileSync(process.argv[1], 'utf8').trim(); if (!raw) { console.log(fallback); process.exit(0); } const settings = JSON.parse(raw); const port = Number(settings?.port); console.log(Number.isFinite(port) && port > 0 ? port : fallback); } catch { console.log(fallback); }" "$settings_path"
  else
    echo 55110
  fi
} | tail -n 1)"

echo "[agent-pulse] Removing previous helper build so the next start always loads fresh code..."
rm -rf "$repo_root/apps/helper/dist"

echo "[agent-pulse] Building latest workspace bundles..."
cd "$repo_root"
pnpm build

existing_pid="$(lsof -tiTCP:"$helper_port" -sTCP:LISTEN 2>/dev/null | head -n 1 || true)"
if [[ -n "$existing_pid" ]]; then
  echo "[agent-pulse] Stopping existing helper on port $helper_port (pid $existing_pid)..."
  kill -TERM "$existing_pid" || true
fi

echo "[agent-pulse] Starting helper on port $helper_port..."
exec node "$helper_script"