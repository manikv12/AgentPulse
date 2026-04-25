# AgentPulse

A touch-controlled dashboard for local AI coding agents (Codex, Claude Code, GitHub Copilot CLI), built for iPad, Android tablet, and small desk displays.

AgentPulse shows the agent threads running on your Mac on a touch screen, with color-coded status so you can quickly see which ones are active, idle, waiting on approval, or errored. Tapping a thread opens that thread in the underlying agent on the Mac. v1 targets Codex; Claude Code and Copilot CLI adapters are planned.

## Status

Touch-app requirements are documented in [docs/TOUCH_APP_REQUIREMENTS.md](docs/TOUCH_APP_REQUIREMENTS.md).

## Platform

macOS only for v1. Requires:

- iPad, Android tablet, or browser-capable touch display on the same trusted local network.
- A local Codex install at `~/.codex/`.

## Components

- A touch web app for the tablet screen.
- A background helper service that reads Codex state and pushes updates to paired tablet clients.

See [docs/TOUCH_APP_REQUIREMENTS.md](docs/TOUCH_APP_REQUIREMENTS.md) for the first product requirements.
