# Agent Pulse

A touch-controlled dashboard for local AI coding agents (Codex, Claude Code, GitHub Copilot CLI), built for iPad, Android tablet, and small desk displays.

Agent Pulse shows the agent threads running on your Mac on a touch screen, with color-coded status so you can quickly see which ones are active, idle, waiting on approval, or errored. Tapping a thread opens that thread in the underlying agent on the Mac. v1 targets Codex; Claude Code and Copilot CLI adapters are planned.

## Status

Touch-app requirements are documented in [docs/TOUCH_APP_REQUIREMENTS.md](docs/TOUCH_APP_REQUIREMENTS.md).
Remote-access requirements are documented in [docs/REMOTE_ACCESS_REQUIREMENTS.md](docs/REMOTE_ACCESS_REQUIREMENTS.md).

## Platform

macOS only for v1. Requires:

- iPad, Android tablet, or browser-capable touch display on the same trusted local network.
- A local Codex install at `~/.codex/`.

## Components

- A touch web app for the tablet screen.
- A background helper service that reads Codex state and pushes updates to paired tablet clients.

See [docs/TOUCH_APP_REQUIREMENTS.md](docs/TOUCH_APP_REQUIREMENTS.md) for the first product requirements.
See [docs/REMOTE_ACCESS_REQUIREMENTS.md](docs/REMOTE_ACCESS_REQUIREMENTS.md) for the outside-LAN roadmap and architecture constraints.

## Development

Install and check the app:

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
```

Run the local helper preview after a build:

```bash
pnpm --filter @agent-pulse/helper start
```

Use the all-in-one dev runner to rebuild the workspace, restart the helper, and, when Cloudflare remote access is enabled in Agent Pulse settings, attach the Cloudflare tunnel too:

```bash
pnpm dev:run
```

If you only want the rebuilt local helper without the extra manual Cloudflare connector, use:

```bash
pnpm dev:run:local
```

Then open the settings URL printed in the terminal to generate a pairing PIN.
