# Agent Pulse Touch App Requirements

## Summary

Agent Pulse v1 is a touch-controlled app for Codex.

The first version runs as a local web app on an iPad, Android tablet, or small touch-screen browser device. The helper computer runs Codex and the Agent Pulse helper. The tablet is the control screen.

## Goal

When many Codex threads are running, the user should be able to glance at a desk tablet and quickly see:

- which Codex thread is active
- which thread is waiting
- which thread needs approval
- which thread has an error
- which workspace the thread belongs to

The user should be able to tap a thread on the tablet and open that thread in Codex on the helper computer.

## Glossary

- **Thread**: a Codex conversation as shown in Codex Desktop / VS Code, identified by a stable thread ID.
- **Session**: a single run of Codex producing turns and tool calls for a thread.
- **Rollout**: the on-disk JSONL file under `~/.codex/sessions/...` that records a session's events.
- **Helper**: the local Agent Pulse service that reads Codex state and serves the touch app.
- **Tablet**: any paired browser client (iPad Safari, Android Chrome, kiosk browser).

In the API and UI, "thread" is the user-visible unit. Sessions and rollouts are implementation details inside the helper.

## First Product Shape

The first product is:

- A local macOS or Windows helper service.
- A touch web app served by that helper.
- A dashboard that works on iPad Safari and Android Chrome.
- A local-only system by default.

The app does not require special hardware. A normal tablet on a good desk stand is enough.

Remote internet access is a later phase and is specified separately in `docs/REMOTE_ACCESS_REQUIREMENTS.md`.

## Target Devices

Supported for v1:

- iPad with Safari.
- Android tablet with Chrome.
- Android tablet with a kiosk browser.
- Small smart display only if it can open a normal browser page.

Good physical setup:

- Landscape tablet stand.
- Charging dock.
- Always-on display setting, if the user wants a permanent desk panel.

## Lockdown Mode

The tablet should be able to feel like a dedicated Codex panel.

For iPad:

- Open the Agent Pulse touch app in Safari.
- Add it to the Home Screen.
- Use Guided Access to lock the iPad to that app.

For Android:

- Use app pinning for simple lock mode.
- Use Fully Kiosk Browser for stronger kiosk mode.
- Use Android Enterprise or MDM later if a managed setup is needed.

Agent Pulse only needs to provide a clean full-screen web app that works well in these modes.

## Thread Status Model

Every thread reported by the helper has exactly one `status` value from this enum:

| Status             | Color  | Meaning                                                              |
| ------------------ | ------ | -------------------------------------------------------------------- |
| `idle`             | green  | Thread exists and is healthy, no active turn.                        |
| `running`          | blue   | A turn is in progress or activity was seen in the last few seconds.  |
| `waiting_approval` | yellow | Codex is waiting for the user to approve a permission or tool call.  |
| `error`            | red    | The last turn failed, or Codex reported an error for this thread.    |
| `connection`       | orange | Helper or Codex `app-server` connection is degraded for this thread. |
| `unknown`          | gray   | Thread is archived, stale, or status cannot currently be determined. |

If more than one signal applies to a thread (for example, an erroring thread that is also waiting), the helper picks the highest-attention status using this priority:

`error` > `connection` > `waiting_approval` > `running` > `idle` > `unknown`

`unknown` is lowest because it is the helper's own ignorance, not a known thread problem; the user should be drawn to real signals first. The helper does not invent statuses outside this list. If a new signal type is needed later, it must be added here first.

## MVP Requirements

The v1 touch app includes:

- Full-screen dashboard.
- Thread list view.
- Optional grid view for tablet landscape mode.
- Thread title.
- Workspace name.
- Last activity time.
- Thread status (from the status model above).
- Color-coded status.
- Helper health indicator.
- Tap-to-open-thread action.
- Lightweight visual alert when a thread enters `waiting_approval` or `error` (e.g. pulsing tile, badge count). No sound in v1.
- Pairing flow for new tablet devices.
- Device revoke flow.
- Offline screen when the helper is not reachable.

## Main User Flow

Example flow:

1. User opens Agent Pulse on an iPad.
2. The iPad shows the running Codex threads from the helper computer.
3. One thread changes to yellow because it needs approval.
4. User taps that thread on the iPad.
5. Codex opens the matching thread on the helper computer.
6. User reviews and approves inside Codex on the helper computer.

Important: the tablet opens the thread. It does not approve the permission by itself in v1.

## Architecture

High-level design:

```text
iPad or Android tablet
        |
        | browser, paired token
        v
Agent Pulse touch web app
        |
        | local network API
        v
Agent Pulse helper on macOS or Windows
        |
        +--> codex app-server
        +--> ~/.codex local state
        +--> Codex desktop app
```

The helper is the only process that reads Codex local state.

The tablet does not read Codex files directly. The tablet does not connect directly to `codex app-server`.

## Codex Data Sources

The helper uses the same safe data sources already researched for Agent Pulse:

- `codex app-server` for live Codex events where possible.
- `~/.codex/state_5.sqlite` for thread metadata.
- `~/.codex/session_index.jsonl` for thread index updates.
- `~/.codex/sessions/<year>/<month>/<day>/rollout-*.jsonl` for live rollout updates.
- `~/.codex/config.toml` for local Codex settings, read-only.

The helper must read Codex files as read-only. It must not write to Codex databases or rollout files.

## Network Requirements

The touch app needs LAN mode because the tablet is a different device.

Outside-LAN access is out of scope for this document and is tracked in `docs/REMOTE_ACCESS_REQUIREMENTS.md`.

Requirements:

- LAN access is off by default; the helper binds to `127.0.0.1` until enabled.
- User must explicitly enable tablet access; this opens the LAN listener.
- Helper shows the local URL, for example `http://mac-name.local:PORT`.
- Helper shows a QR code that encodes URL + pairing PIN, plus the short PIN as a fallback.
- Pairing creates a device-specific token.
- Each tablet has its own token.
- User can revoke one tablet without resetting every device.
- Unpaired devices cannot see thread data.
- Tokens are never printed in full in logs (only first/last 4 chars, if at all).

### Port and discovery

- Default port: configurable in helper settings; helper picks a free high port on first run and persists it.
- mDNS/Bonjour: helper advertises `_agentpulse._tcp` on the LAN so tablets can discover `mac-name.local`.
- Fallback: helper settings screen shows the raw IP + port for networks where mDNS is blocked. The tablet pairing screen accepts either form.

### Transport

- HTTP for loading the web app and JSON request/response.
- WebSocket (preferred) or Server-Sent Events for live updates.
- JSON for actions like `thread/open`.

### Timestamps

- All timestamps in API payloads are ISO-8601 in UTC, with a trailing `Z` (e.g. `2026-04-25T16:14:00Z`). The tablet renders them in local time.

## Security Requirements

Agent Pulse must be careful because Codex can affect local files and projects.

Security rules:

- Local-only by default.
- LAN mode must be opt-in.
- Pairing is required.
- Raw Codex files are never served to the tablet.
- Raw `codex app-server` is never exposed to the tablet.
- The tablet cannot approve Codex permission prompts in v1.
- The helper validates every request token.
- The helper has a single "disable tablet access" switch that closes the LAN listener immediately.

### Token lifetime

- Tokens are stored in platform-local helper storage: macOS Keychain on macOS, and `%APPDATA%\Agent Pulse\devices.json` on Windows.
- Tokens have no fixed expiry but can be rotated or revoked at any time from helper settings.
- Helper restart preserves tokens; clearing the platform-local pairing store resets all pairings.
- A "rotate token" action invalidates the old token and emits a fresh pairing PIN for that device.

### Rate limits

- Pairing PIN attempts: max 5 per device-IP per 10 minutes; on exhaustion, that IP is blocked from pairing for 1 hour.
- Pairing PIN expiry: 5 minutes; helper generates a new PIN on demand.
- Authenticated request rate limit: 60 requests/sec per token, burst 120 (cheap reads); action endpoints (`thread/open`, `device/*`) capped at 10/sec per token.

### Plain HTTP on LAN

If v1 uses plain HTTP on the LAN, the setup screen must say it is for trusted local networks only. Mitigations in v1:

- Tokens are bound to the paired device record (not just possession of the bearer string) — server checks token + device fingerprint.
- The helper logs every successful pair and every revoke, visible in the settings screen.
- HTTPS or a secure tunnel is a phase 2 enhancement.

## Privacy Requirements

The touch app keeps the same privacy promise:

- No telemetry in v1.
- No third-party server in v1.
- No cloud account needed.
- Codex data stays on the helper computer and paired tablet.
- The tablet receives only summary data needed for the dashboard.

## Required Screens

Touch app screens:

- Pairing screen.
- Dashboard screen.
- Thread detail drawer or page.
- Helper offline screen.
- Device revoked screen.
- Settings screen.

Helper settings screens:

- Enable or disable tablet access.
- Show pairing QR code or PIN.
- List paired devices.
- Revoke paired device.
- Show helper health.

## UI Requirements

The touch UI should be easy to use from a desk.

Requirements:

- Large tap targets.
- Works in landscape and portrait.
- Works on iPad mini size and larger tablets.
- Uses clear status colors.
- Shows waiting-for-approval clearly.
- Does not hide important state behind small hover-only controls.
- Uses short labels and simple language.
- Has a dark mode friendly design.
- Recovers cleanly when the helper computer sleeps or the helper restarts.

## Helper API Requirements

### Read endpoints

- `GET health/get` → `{ status: "ok" | "degraded" | "down", codexAppServer: "connected" | "disconnected", version: string, uptimeSec: number }`
- `GET threads/list` → `{ threads: Thread[] }`

### Action endpoints

- `POST thread/open` → opens a thread in Codex on the helper computer. Body: `{ threadId: string }`. Response: `{ ok: boolean, error?: string }`.
- `POST device/pair` → exchanges PIN for token. Body: `{ pin: string, deviceName: string }`. Response: `{ token: string, deviceId: string }`.
- `POST device/revoke` → revokes a device. Body: `{ deviceId: string }`. Response: `{ ok: boolean }`.

### Live events (WebSocket / SSE)

- `thread/upsert` → payload: `Thread`. Sent on creation or any field change.
- `thread/remove` → payload: `{ threadId: string }`.
- `health/changed` → payload: same shape as `health/get` response.

### `Thread` payload shape

```json
{
  "threadId": "string, stable Codex thread id",
  "title": "string, human-readable thread title",
  "workspace": "string, workspace or project name",
  "status": "idle | running | waiting_approval | error | connection | unknown",
  "lastActivityAt": "ISO-8601 UTC timestamp, e.g. 2026-04-25T16:14:00Z",
  "lastTurnSummary": "string, short one-line summary, may be empty"
}
```

The helper does not send raw rollout content, file paths, or tool-call arguments to the tablet in v1.

### Out of scope for MVP

- approval accept or deny
- sending a new prompt to Codex
- editing Codex settings
- deleting Codex threads

## Tap-to-Open Mechanism (open question)

`thread/open` requires the helper to focus the matching Codex thread on the local computer when the provider supports it. The Codex `remote_control` feature flag exists but is not stable enough to depend on (see below). Candidate approaches to evaluate during design:

- Codex Desktop deep link (e.g. `codex://thread/<id>`), if one exists or can be added.
- AppleScript / `osascript` on macOS, or the registered `codex://` URL handler on Windows, to focus Codex Desktop and select the thread.
- A small accessibility-API helper that activates the Codex window.
- Falling back to opening Codex Desktop with no thread selection if no targeted method works.

Decision must be made before MVP build; whatever is picked must not require writes to Codex's on-disk state.

## Codex Remote Control Position

Codex has a `remote_control` feature flag and related app-server protocol fields. Local testing showed it exists, but it is still under development and not stable enough to build the first product on.

For v1:

- Do not depend on Codex `remote_control`.
- Do not require OpenAI backend enrollment for the tablet app.
- Use Agent Pulse's own local helper API.

Future:

- Re-check Codex `remote_control` if OpenAI documents it as a stable feature.
- If it becomes stable, evaluate whether it can replace part of the custom helper API.

## Non-Goals For v1

The first version does not include:

- Native iPad app.
- Native Android app.
- Internet remote access.
- Cloud sync.
- Telemetry.
- Auto approval from the tablet.
- Direct tablet access to Codex files.
- Direct tablet access to `codex app-server`.
- Remote control of the helper computer desktop.

## Acceptance Criteria

The touch MVP is ready when:

- A paired iPad can open the dashboard in Safari.
- A paired Android tablet can open the dashboard in Chrome.
- Unpaired devices cannot see thread data.
- The dashboard updates within 2 seconds when a Codex thread status changes.
- Tapping a thread opens that thread in Codex on the helper computer.
- Revoking a device blocks future access immediately.
- Helper restart keeps paired devices unless the user resets them.
- LAN mode can be disabled completely; the listener stops accepting connections within 1 second.
- No Codex approval can be accepted from the tablet.
- When the helper becomes unreachable, the tablet shows the offline screen within 5 seconds.
- The helper health indicator on the dashboard reflects `health/get` status and updates on `health/changed` events.
- A thread that enters `waiting_approval` or `error` triggers a visible alert on the dashboard.

## Test Plan

Automated tests:

- Pairing token creation.
- Invalid token rejection.
- Revoked token rejection.
- LAN mode disabled behavior.
- `threads/list` response shape.
- `thread/open` request validation.
- Live update event shape (`thread/upsert`, `thread/remove`, `health/changed`).
- Status priority resolution (e.g. error+waiting → error).
- Pairing rate limit enforcement.

Manual tests:

- iPad Safari.
- iPad Home Screen web app.
- iPad Guided Access.
- Android Chrome.
- Android kiosk browser.
- Helper offline screen.
- Wrong pairing code.
- Token revoke.
- Tap-to-open Codex thread.
- Portrait layout.
- Landscape layout.

Security checks:

- Unauthenticated requests return no thread data.
- Raw Codex files are not served.
- Raw `codex app-server` is not exposed on the LAN.
- Approval actions are unavailable.
- Tokens do not appear in full in helper logs.

## Future Ideas

Possible later features:

- Send a new prompt from the tablet.
- Explicit approval review from the tablet with strong confirmation.
- Favorite workspaces.
- Custom macro buttons.
- Push notifications when a thread needs attention.
- Tailscale or secure remote access (HTTPS).
- Native iPad app.
- Native Android app.
- Integration with stable Codex remote-control APIs if they become available.
