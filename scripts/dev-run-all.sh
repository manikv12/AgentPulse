#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
settings_path="$HOME/Library/Application Support/Agent Pulse/settings.json"
helper_script="$repo_root/apps/helper/dist/dev-server.js"
helper_log="$(mktemp -t agent-pulse-helper-log.XXXXXX)"
vite_log="$(mktemp -t agent-pulse-vite-log.XXXXXX)"
dev_config_path="$(mktemp -t agent-pulse-cloudflare-dev.XXXXXX.yml)"
tunnel_target="${AGENT_PULSE_TUNNEL_TARGET:-helper}"

log() {
  echo "[agent-pulse] $*"
}

filter_cloudflared_logs() {
  grep -Ev ' INF (Tunnel connection curve preferences|Registered tunnel connection)\b' || true
}

run_cloudflared() {
  cloudflared "$@" > >(filter_cloudflared_logs) 2> >(filter_cloudflared_logs >&2)
}

load_local_env() {
  local env_path="$repo_root/.env.local"
  if [[ ! -f "$env_path" ]]; then
    return
  fi

  set -a
  # shellcheck disable=SC1090
  source "$env_path"
  set +a
}

read_settings() {
  node --input-type=module - "$settings_path" <<'NODE'
import { readFileSync } from 'node:fs';
import path from 'node:path';

const settingsPath = process.argv[2];
const defaultConfigPath = path.join(path.dirname(settingsPath), 'cloudflared', 'config.yml');
const fallback = {
  helperPort: 55110,
  remoteEnabled: false,
  remoteProvider: 'cloudflare',
  remoteMode: 'quick',
  tunnelProtocol: 'auto',
  configPath: defaultConfigPath,
  tunnelName: 'agent-pulse',
  publicUrl: '',
  hostname: ''
};

let parsed = {};
try {
  const raw = readFileSync(settingsPath, 'utf8').trim();
  if (raw) {
    parsed = JSON.parse(raw);
  }
} catch {
  // Fall back to defaults when the file is missing or temporarily invalid.
}

const remote = parsed && typeof parsed === 'object' && parsed.remoteAccess && typeof parsed.remoteAccess === 'object'
  ? parsed.remoteAccess
  : {};
const rawPort = Number(parsed && typeof parsed === 'object' ? parsed.port : NaN);

const values = {
  helper_port: Number.isFinite(rawPort) && rawPort > 0 ? rawPort : fallback.helperPort,
  remote_enabled: remote.enabled === true,
  remote_provider: typeof remote.provider === 'string' && remote.provider ? remote.provider : fallback.remoteProvider,
  remote_mode: remote.mode === 'named' ? 'named' : 'quick',
  tunnel_protocol:
    remote.tunnelProtocol === 'http2' || remote.tunnelProtocol === 'quic' ? remote.tunnelProtocol : fallback.tunnelProtocol,
  config_path: typeof remote.configPath === 'string' && remote.configPath ? remote.configPath : fallback.configPath,
  tunnel_name: typeof remote.tunnelName === 'string' && remote.tunnelName.trim() ? remote.tunnelName.trim() : fallback.tunnelName,
  tunnel_id: typeof remote.tunnelId === 'string' ? remote.tunnelId : '',
  public_url: typeof remote.publicUrl === 'string' ? remote.publicUrl : fallback.publicUrl,
  hostname: typeof remote.hostname === 'string' ? remote.hostname : fallback.hostname
};

for (const [key, value] of Object.entries(values)) {
  process.stdout.write(`${key}=${JSON.stringify(value)}\n`);
}
NODE
}

read_health() {
  local helper_url="$1"
  curl -fsS "$helper_url/health/get" | node --input-type=module <<'NODE'
let payload = {};
try {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
} catch {
  payload = {};
}

const remote = payload && typeof payload === 'object' && payload.remoteAccess && typeof payload.remoteAccess === 'object'
  ? payload.remoteAccess
  : {};
const checklist = remote && typeof remote === 'object' && remote.checklist && typeof remote.checklist === 'object'
  ? remote.checklist
  : {};

const values = {
  health_remote_enabled: remote.enabled === true,
  health_remote_provider: typeof remote.provider === 'string' ? remote.provider : '',
  health_remote_mode: remote.mode === 'named' ? 'named' : 'quick',
  health_remote_status: typeof remote.status === 'string' ? remote.status : '',
  health_tunnel_running: checklist.tunnelRunning === true
};

for (const [key, value] of Object.entries(values)) {
  process.stdout.write(`${key}=${JSON.stringify(value)}\n`);
}
NODE
}

helper_pid=""
helper_log_tail_pid=""
vite_pid=""
vite_log_tail_pid=""

cleanup() {
  if [[ -n "$helper_log_tail_pid" ]] && kill -0 "$helper_log_tail_pid" 2>/dev/null; then
    kill -TERM "$helper_log_tail_pid" 2>/dev/null || true
    wait "$helper_log_tail_pid" 2>/dev/null || true
  fi
  if [[ -n "$helper_pid" ]] && kill -0 "$helper_pid" 2>/dev/null; then
    kill -TERM "$helper_pid" 2>/dev/null || true
    wait "$helper_pid" 2>/dev/null || true
  fi
  if [[ -n "$vite_log_tail_pid" ]] && kill -0 "$vite_log_tail_pid" 2>/dev/null; then
    kill -TERM "$vite_log_tail_pid" 2>/dev/null || true
    wait "$vite_log_tail_pid" 2>/dev/null || true
  fi
  if [[ -n "$vite_pid" ]] && kill -0 "$vite_pid" 2>/dev/null; then
    kill -TERM "$vite_pid" 2>/dev/null || true
    wait "$vite_pid" 2>/dev/null || true
  fi
  rm -f "$helper_log" "$vite_log" "$dev_config_path"
}

trap cleanup EXIT INT TERM

wait_for_pid_exit() {
  local pid="$1"
  for _ in $(seq 1 20); do
    if ! kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
    sleep 0.2
  done
  kill -KILL "$pid" 2>/dev/null || true
}

echo
load_local_env

log "Removing previous helper build so the next start always loads fresh code..."
rm -rf "$repo_root/apps/helper/dist"

log "Building latest helper workspace bundles..."
cd "$repo_root"
pnpm --filter @agent-pulse/shared build
pnpm --filter @agent-pulse/helper build

log "Removing any stale tablet build so the helper cannot fall back to cached UI..."
rm -rf "$repo_root/apps/tablet/dist"

existing_pids="$({
  pgrep -f "$helper_script" || true
} | sort -u)"
if [[ -n "$existing_pids" ]]; then
  while IFS= read -r existing_pid; do
    [[ -n "$existing_pid" ]] || continue
    log "Stopping existing helper process $existing_pid..."
    kill -TERM "$existing_pid" || true
  done <<< "$existing_pids"
fi

eval "$(read_settings)"

existing_port_pids="$(lsof -tiTCP:"$helper_port" -sTCP:LISTEN 2>/dev/null || true)"
if [[ -n "$existing_port_pids" ]]; then
  while IFS= read -r existing_pid; do
    [[ -n "$existing_pid" ]] || continue
    log "Stopping existing listener on port $helper_port (pid $existing_pid)..."
    kill -TERM "$existing_pid" 2>/dev/null || true
    wait_for_pid_exit "$existing_pid"
  done <<< "$existing_port_pids"
fi

helper_port_for_vite="${AGENT_PULSE_HELPER_PORT:-$helper_port}"
hmr_host_pre="$hostname"
if [[ -z "$hmr_host_pre" && -n "$public_url" ]]; then
  hmr_host_pre="$(node --input-type=module -e "try { console.log(new URL(process.argv[1]).hostname); } catch { process.exit(0); }" "$public_url")"
fi
vite_env=(AGENT_PULSE_HELPER_PORT="$helper_port_for_vite")
if [[ "$remote_enabled" == "true" && "$remote_provider" == "cloudflare" && -n "$hmr_host_pre" ]]; then
  vite_env+=(
    AGENT_PULSE_ALLOWED_HOSTS="$hmr_host_pre"
    AGENT_PULSE_HMR_HOST="$hmr_host_pre"
    AGENT_PULSE_HMR_PROTOCOL="wss"
    AGENT_PULSE_HMR_CLIENT_PORT="443"
  )
fi

log "Starting Vite tablet dev server first so the helper can proxy to it..."
env "${vite_env[@]}" pnpm --filter @agent-pulse/tablet dev >"$vite_log" 2>&1 &
vite_pid="$!"
tail -n +1 -f "$vite_log" &
vite_log_tail_pid="$!"

vite_url=""
for _ in $(seq 1 30); do
  if [[ -f "$vite_log" ]]; then
    vite_url="$(grep -Eo 'Local:[[:space:]]+http://127\.0\.0\.1:[0-9]+/' "$vite_log" | tail -n 1 | sed -E 's/Local:[[:space:]]+//' || true)"
  fi
  if [[ -n "$vite_url" ]] && curl -fsS "$vite_url" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$vite_pid" 2>/dev/null; then
    log "Vite dev server exited before becoming ready."
    exit 1
  fi
  sleep 1
done

if [[ -z "$vite_url" ]]; then
  log "Vite dev server did not become ready before timeout."
  exit 1
fi

vite_origin="${vite_url%/}"
log "Vite tablet dev UI is ready at $vite_origin; the helper will proxy to it."

log "Starting helper..."
AGENT_PULSE_SKIP_MANAGED_TUNNEL=1 AGENT_PULSE_TABLET_DEV_URL="$vite_origin" node "$helper_script" >"$helper_log" 2>&1 &
helper_pid="$!"
tail -n +1 -f "$helper_log" &
helper_log_tail_pid="$!"

helper_ready="false"
helper_url=""
for _ in $(seq 1 30); do
  if [[ -f "$helper_log" ]]; then
    helper_url="$(grep -Eo 'Agent Pulse helper running at http://[^[:space:]]+' "$helper_log" | tail -n 1 | sed 's/Agent Pulse helper running at //' || true)"
  fi

  if [[ -n "$helper_url" ]] && curl -fsS "$helper_url/health/get" >/dev/null 2>&1; then
    helper_ready="true"
    break
  fi
  if ! kill -0 "$helper_pid" 2>/dev/null; then
    log "Helper exited before becoming ready."
    exit 1
  fi
  sleep 1
done

if [[ "$helper_ready" != "true" ]]; then
  log "Helper did not become ready before timeout."
  exit 1
fi

log "Helper is ready at $helper_url."

eval "$(read_health "$helper_url")"
# cloudflared resolves "localhost" via getaddrinfo and may pick AAAA (::1) before A (127.0.0.1).
# Our helper binds to 0.0.0.0 (IPv4 only), so an IPv6 connect attempt fails with
# "dial tcp [::1]:55110: connect: connection refused". Pin the origin to 127.0.0.1.
tunnel_origin="${helper_url//localhost/127.0.0.1}"
if [[ "$tunnel_target" == "vite" ]]; then
  tunnel_origin="${vite_origin//localhost/127.0.0.1}"
fi

if [[ "$remote_enabled" != "true" || "$remote_provider" != "cloudflare" ]]; then
  log "Remote Cloudflare access is disabled in settings; keeping helper and Vite running."
  wait "$helper_pid"
  exit $?
fi

if [[ "$health_remote_enabled" == "true" && "$health_remote_provider" == "cloudflare" && "$health_tunnel_running" == "true" ]]; then
  log "Ignoring helper-managed Cloudflare status for dev mode; this run manages its own tunnel."
fi

if ! command -v cloudflared >/dev/null 2>&1; then
  log "cloudflared is not installed, so the Cloudflare endpoint cannot be started."
  exit 1
fi

if [[ "$remote_mode" == "named" ]]; then
  if [[ -n "$public_url" ]]; then
    log "Starting Cloudflare named tunnel for $public_url..."
  elif [[ -n "$hostname" ]]; then
    log "Starting Cloudflare named tunnel for https://$hostname..."
  else
    log "Starting Cloudflare named tunnel..."
  fi

  tunnel_ref="${tunnel_id:-$tunnel_name}"
  credentials_ref="${tunnel_id:-$tunnel_name}"
  credentials_file="$HOME/.cloudflared/${credentials_ref}.json"
  cat >"$dev_config_path" <<EOF
tunnel: $tunnel_ref
credentials-file: $credentials_file

ingress:
  - hostname: $hostname
    service: $tunnel_origin
  - service: http_status:404
EOF

  log "Cloudflare tunnel target: $tunnel_origin"
  run_cloudflared tunnel --protocol "$tunnel_protocol" --config "$dev_config_path" run "$tunnel_name"
  exit $?
fi

origin_url="$tunnel_origin"
log "Starting Cloudflare quick tunnel for $origin_url..."
run_cloudflared tunnel --protocol "$tunnel_protocol" --url "$origin_url"
