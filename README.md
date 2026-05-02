<p align="center">
  <img src="apps/tablet/public/icon.svg" alt="Agent Pulse logo" width="128" />
</p>

# Agent Pulse

Agent Pulse is a browser-based control surface for local coding agents running on your Mac.

It gives you one live dashboard for active agent work, recent threads, approvals, transcripts, models, and health. Open it on an iPad, Android tablet, phone, or desktop browser so you can watch and steer work even when you are not sitting next to your computer.

![Agent Pulse dashboard preview](assets/agent-pulse-readme-hero.png)

Agent Pulse is local-first with optional remote access: the helper runs on your Mac, reads local agent state, and serves a paired web app to trusted devices. When remote access is enabled, the helper can expose that same paired web app through a Cloudflare Tunnel.

## Supported Providers

Agent Pulse is built around provider choice. You can use the agent that fits the task instead of forcing every workflow through one tool.

| Provider | Status | What Agent Pulse Can Do |
| --- | --- | --- |
| Codex | Supported | Read threads, show live status, open threads in Codex, send messages, stop work, change models, use plan mode, handle supported approvals, and show transcripts. |
| Claude Code | Supported | Read sessions, show provider-aware threads, send messages, change models when available, show live work, show transcripts, and keep Claude-specific composer behavior separate from Codex. |
| GitHub Copilot | Supported | Read sessions, show provider-aware threads, send prompts through the helper, show transcripts, and track live work from Copilot sessions. |
| Codex app-server / local app server | Supported internally | Used by the helper for Codex state, live updates, transcripts, approvals, model data, and local control flows. |

Some features depend on what each provider exposes. For example, image sending from the tablet composer is planned, but the current send channel is text-first.

## What You Can Do

From a paired tablet, phone, or browser, Agent Pulse can:

- see active and recent threads across supported providers
- tell which provider owns each thread with clear provider color and icons
- show running, waiting, review, error, and idle status
- open a Codex thread on the Mac
- view transcript history and loaded screenshots/images from provider history
- send follow-up messages to supported providers
- start new provider-backed threads from known workspaces
- switch models where the provider supports it
- use Codex plan mode from the composer menu
- stop active work when supported
- respond to supported approvals and plan requests
- manage pairing, local access, and Cloudflare Tunnel remote access settings

The browser UI is the control and visibility surface. The Mac helper remains the trusted process that talks to local agents and owns the local data.

## How It Works

Agent Pulse has three main parts:

1. **Local agents on your Mac**
   Codex, Claude Code, GitHub Copilot, and app-server style backends keep their own local sessions and state.
2. **Agent Pulse helper**
   A macOS helper service reads local agent data, tracks status changes, handles pairing, and exposes one safe API for the browser UI.
3. **Browser web app**
   A React/Vite web app that connects to the helper over a paired HTTP and WebSocket connection.

High-level flow:

```text
Tablet / phone / browser
        |
        | paired HTTP + WebSocket
        | local LAN or optional Cloudflare Tunnel
        v
Agent Pulse helper on macOS
        |
        +--> Codex desktop + app-server + ~/.codex
        +--> Claude Code session files / live process
        +--> GitHub Copilot sessions / live process
        +--> optional Cloudflare Tunnel for remote access
```

## Current Scope

Agent Pulse is currently designed for a trusted personal setup:

- the helper runs on macOS
- paired devices can use the browser UI from the local network
- optional remote access can expose the same paired UI through the helper-managed Cloudflare Tunnel flow
- pairing is required before a device can read or control thread data
- raw provider files and raw provider endpoints are not exposed directly to the browser
- provider-specific features stay provider-specific, so Codex commands do not appear in Claude-only composer flows

More detailed product and architecture notes live here:

- [docs/TOUCH_APP_REQUIREMENTS.md](docs/TOUCH_APP_REQUIREMENTS.md)
- [docs/REMOTE_ACCESS_REQUIREMENTS.md](docs/REMOTE_ACCESS_REQUIREMENTS.md)
- [docs/AGENT_PULSE_SUPERVISION_FEATURES.md](docs/AGENT_PULSE_SUPERVISION_FEATURES.md)

## Platform Requirements

Agent Pulse is macOS-first.

You need:

- a Mac running the helper
- at least one supported local provider, such as Codex, Claude Code, or GitHub Copilot
- `pnpm` for local development
- an iPad, Android tablet, phone, or browser-capable display for local or remote access

The client is just a web app. The helper depends on local macOS behavior for pairing storage, provider discovery, and opening local apps.

## Repository Layout

- `apps/helper`: macOS helper server, provider adapters, pairing, settings, remote access, and API routes
- `apps/tablet`: React/Vite browser UI for tablet, phone, and desktop access
- `packages/shared`: shared schemas, provider types, thread types, and API contracts
- `docs`: product and architecture requirements
- `scripts`: local development runners
- `assets`: README and product visual assets

## Getting Started For Development

Install dependencies and run the standard checks:

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
```

Run the full local development loop:

```bash
pnpm dev:run
```

This script:

- rebuilds shared packages and helper code
- starts the helper
- starts the browser UI dev server
- connects the helper to the browser UI
- manages the Cloudflare tunnel when remote access is enabled in Agent Pulse settings

For local-only helper development without the managed remote-access hookup:

```bash
pnpm dev:run:local
```

After the helper starts:

1. Open the settings URL printed in the terminal.
2. Generate or view the pairing PIN.
3. Open the browser UI on a phone, tablet, or desktop browser.
4. Pair the device.
5. Use the dashboard to monitor and control supported agent threads.

## Remote Access With Cloudflare Tunnel

Agent Pulse can be used away from your Mac when remote access is enabled. The Mac still runs the helper and talks to the local agents, but your phone, tablet, or browser can reach the paired Agent Pulse UI through a Cloudflare Tunnel URL.

Basic flow:

1. Start the helper with `pnpm dev:run` or run the built helper.
2. Open the settings URL printed by the helper.
3. Go to **Agent Pulse settings**.
4. Pair your device first, or generate a pairing PIN if the device is not paired yet.
5. In settings, turn on **Remote access**.
6. Agent Pulse starts or supervises the Cloudflare Tunnel.
7. Open the remote URL or scan the QR code shown in settings.
8. Use the paired device to view threads, send messages, respond to supported approvals, and monitor work while away from your computer.

Remote access notes:

- The Mac must stay awake and the Agent Pulse helper must keep running.
- Pairing is still required; the tunnel does not make raw provider data public.
- The remote URL is managed by the helper and can change if the tunnel is restarted or remote access is turned off and on.
- If you only want local network access, leave remote access off and use the LAN URL from settings.

## Helper Data Model

The helper is the only process that reads provider state directly. It normalizes provider-specific data into shared thread, transcript, provider, status, and approval schemas.

Examples of local sources include:

- Codex app-server events and local `~/.codex` state
- Codex desktop IPC mirror for live sends
- Claude Code JSONL/session data and live process state
- GitHub Copilot session data and live process state
- local helper settings, pairing records, and remote-access state

This keeps the browser simple and safer. The paired web app talks to Agent Pulse, not directly to each provider's raw files or internal endpoints.

## Notes

- Agent Pulse is local-first and personal-workspace focused.
- Windows is not supported by the helper today.
- Image display from provider history is supported where transcripts expose images, but composer image sending is not fully wired yet.
- Provider support will continue to expand behind the shared helper API.
