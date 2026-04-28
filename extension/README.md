# AgentPulse — OpenAssist Extension

This folder packages AgentPulse as an [OpenAssist extension](../../OpenAssist/Docs/Extensions.md).

## Install

```sh
OpenAssist --cli extension install ./extension
OpenAssist --cli extension enable agent-pulse
```

The first launch builds the helper (`pnpm --filter @agent-pulse/helper build`)
into `apps/helper/dist/`. Subsequent launches reuse the build.

## Files

- `extension.json` — manifest consumed by OpenAssist
- `run.sh` — entry script; runs the helper's `dev-server.js` under Node

## Why ship as an extension

The standalone helper still works on its own (`pnpm --filter @agent-pulse/helper start`).
Shipping an extension manifest just lets OpenAssist supervise the lifecycle
and surface the tablet UI as a dashboard tile, so users don't have to manage a
second app.
