# Agent Pulse Apple Watch Requirements

## Summary

These requirements define the first Apple Watch version of Agent Pulse.

The watch product should be a native watchOS app that connects to the existing Agent Pulse helper
API. It is not a port of the current browser UI. The helper remains the trusted process that reads
provider state, normalizes data, enforces auth, and performs actions on behalf of the watch.

The first release should optimize for quick awareness and quick intervention:

- see whether an agent is running, waiting, errored, or finished
- open the relevant thread on the Mac
- send a short follow-up message
- stop work when supported
- get notified when an agent finishes or needs attention

This document is requirements only. It does not implement the watch app.

## Product Goal

When the user is away from the Mac or does not want to pick up a phone or tablet, the Apple Watch
should answer:

- Which agent needs me now?
- Did the agent finish?
- Is anything blocked?
- Can I send a short follow-up?
- Can I stop or reopen the relevant work quickly?

Plain example:

```text
Codex / marketing-site
Status: waiting approval
Last update: needs network permission
Action: Open on Mac
Action: Stop run
Action: Send short note
```

## Scope and Platform Direction

- The Apple Watch client is a native watchOS app built with Swift and SwiftUI.
- The watch app is independent. A dedicated iPhone app is not required for the first release.
- The watch app reuses the same helper backend, device auth model, and remote-access path that
  Agent Pulse already uses for browser clients.
- The watch app does not read raw provider files directly.
- The watch app does not talk directly to `codex app-server` or any raw provider endpoint.

## Research-Locked Decisions

The following decisions are normative for the first watch release:

- **Native client.** The watch app is native watchOS, not Expo or React Native.
- **Same backend.** The watch app uses the existing Agent Pulse helper API shape instead of a new
  watch-only backend.
- **Foreground live updates only.** While the app is open, the watch may use live transport such as
  WebSocket if the helper already supports it for the relevant surface.
- **Push for timely background awareness.** The product must use APNs for finish/error/attention
  notifications. It must not depend on a long-lived background WebSocket on watchOS.
- **Short-message UX.** The watch supports only short follow-up messages suitable for dictation,
  Scribble, or the on-watch keyboard when available.
- **Multi-server future.** The product must not assume one permanent helper forever. The first watch
  release may start with one active server at a time, but the model must be designed so later
  versions can connect and reconnect to multiple different Agent Pulse servers on different
  machines.

## Relationship to Existing Agent Pulse Architecture

The watch app fits the same core model already used by the tablet and remote browser product:

```text
Apple Watch app
        |
        | paired HTTPS / WSS
        v
Agent Pulse helper on Mac
        |
        +--> Codex desktop + app-server + ~/.codex
        +--> Claude Code local state
        +--> GitHub Copilot local state
        +--> optional remote tunnel
```

Rules:

- The helper remains the only authority that reads local provider state.
- The watch app consumes normalized API data only.
- Provider-specific capabilities remain provider-specific.
- The watch app should prefer the same auth and pairing primitives already used by Agent Pulse,
  unless watch-specific onboarding needs a small wrapper.

## Goals

- Add a glanceable Apple Watch surface for Agent Pulse.
- Reuse the helper and shared data model as much as possible.
- Keep the watch UI fast, readable, and safe for short interactions.
- Support trusted local and remote use through the existing helper model.
- Provide timely notifications for finish, error, and attention-needed events.
- Leave room for future switching between multiple helper servers.

## Non-Goals

- Rebuilding the current tablet UI on the watch.
- Building the full transcript experience on the watch.
- Requiring a dedicated iPhone app before shipping the watch app.
- Keeping a persistent background WebSocket alive on watchOS.
- Exposing raw provider files or raw provider APIs to the watch.
- Supporting high-risk admin setup or complex helper configuration on the watch.
- Making the first watch release a multi-user team product.

## Watch Product Shape

The watch app should feel like a glance-and-act surface, not a full workstation dashboard.

The first release should prioritize:

- attention state
- short summaries
- quick actions
- lightweight notifications
- short reply input

The first release should de-prioritize or exclude:

- dense multi-column dashboards
- long transcript reading
- long-form text composition
- complex settings management
- initial helper installation

## MVP Requirements

The first watch release includes:

- server selection screen for the currently active paired server
- thread list with compact status and provider cues
- per-thread detail view with short summary and recent state
- send short follow-up message action
- stop active run action where supported
- open thread on Mac action where supported
- finish/error/attention notifications
- device revoked screen
- offline / server unavailable screen

The first release may omit:

- transcript browsing beyond a short recent summary
- approval completion on watch
- new-thread creation
- model picker
- workspace creation
- server administration

## User Flows

### Glance and check

1. User raises wrist or opens Agent Pulse on Apple Watch.
2. The watch shows the current paired server and the highest-attention threads.
3. The user sees whether anything is running, blocked, errored, or finished.

### Notification and quick action

1. A thread finishes, errors, or needs user attention.
2. Agent Pulse sends an APNs notification to the watch app.
3. The user taps the notification.
4. The watch opens the relevant thread detail view.
5. The user may open on Mac, stop work, or send a short message if the action is allowed.

### Short follow-up message

1. User opens a thread on the watch.
2. User taps Send Message.
3. The watch presents short text input using dictation, Scribble, or keyboard when available.
4. The watch sends the message through the helper API.
5. The helper routes the message to the provider using the existing trusted flow.

## UX Requirements

### Information Density

- The top-level watch list must show only the fields needed to triage attention quickly.
- Each row should include thread title, status, provider, and relative last activity.
- Workspace name should appear when it disambiguates threads, but must not crowd out attention
  status.
- The watch detail view should show only a short summary, not the full transcript by default.

### Input Constraints

- The watch must assume short input only.
- Message composition should be optimized for dictation first.
- The product must not require the on-watch keyboard, because it is not available on every device.
- If a message is too long for good watch UX, the app should direct the user to phone/tablet/Mac
  rather than pretend the watch is a full composer.

### Haptics and Alerts

- Finish, error, and waiting-attention notifications should use distinct titles and concise body
  text.
- The watch app may use haptics consistent with watchOS notification behavior.
- Notifications must not leak sensitive content beyond what the user expects on a wearable lock
  screen.

## Networking Requirements

- The watch app communicates with the helper over HTTPS for request/response and WSS for live
  foreground updates where available.
- LAN access may be used when the helper is reachable locally and the user has enabled it.
- Remote access should reuse the existing remote helper entrypoint when enabled.
- The watch app must not require a separate watch-only transport stack.
- The watch app must gracefully handle watches with intermittent connectivity.

### Live Updates

- While the watch app is foregrounded, the app may subscribe to live thread updates using the same
  normalized event stream shape as other Agent Pulse clients.
- When the watch app backgrounds, live transport loss is expected and must not be treated as an
  error condition by itself.
- The app must refresh state on launch, resume, and notification-open flows.

### Background Model

- The product must not rely on continuous background polling from the watch.
- The product must not rely on persistent background WebSockets on watchOS.
- Timely background awareness must come from push notifications.
- When a notification opens the app, the app should perform a focused refresh for the target thread
  or target server.

## Notification Requirements

- Agent Pulse must support APNs registration for the watch app.
- The backend path must be able to associate a watch device record with one or more helper-server
  records in the future.
- The helper or helper-managed remote path must emit notification-worthy events for:
  - thread finished
  - thread errored
  - thread waiting for user attention
  - optional thread stopped or disconnected events later
- Notification payloads should include enough information to route the user into the relevant thread
  or server context without exposing raw provider data.

### Actionable Notifications

The first release should support at least these notification actions where safe:

- Open on Mac
- Open in Watch App
- Stop Run

The first release should not require these notification actions:

- Approve permission
- Long text reply
- Complex admin actions

## Backend and API Requirements

The watch app reuses the helper backend. The backend must expose compact watch-friendly surfaces in
addition to the broader tablet/browser UI contracts where needed.

Required capabilities:

- list available threads for the active server
- fetch compact thread detail
- send short message
- stop active thread
- open thread on Mac
- return provider-aware status and last activity
- identify the current server record
- support watch notification registration metadata

### Watch-Friendly Response Shape

The watch-specific API surface should prefer:

- short summaries over long transcript payloads
- compact lists over large nested objects
- one focused thread detail payload over broad dashboard hydration
- stable identifiers that match the existing thread and device models

The backend should avoid shipping:

- raw rollout data
- raw provider event blobs
- full transcript history by default
- large image payloads

## Server Model Requirements

### Phase 1: Single Active Server, Future-Safe Model

The first watch release may support one active Agent Pulse server connection at a time, but the data
model must already recognize that users may run different Agent Pulse helpers on different machines.

Requirements:

- A server record must have a stable server id, display name, base URL or remote URL, and pairing
  state.
- The watch app must persist enough metadata to reconnect to the last active server.
- Device auth must remain scoped to the server the watch is paired with.
- Logging and UI must clearly distinguish which server generated a notification or thread event.

### Phase 2: Multiple Saved Servers

Later releases should support multiple saved helper servers.

Requirements for that future direction:

- user can view a saved server list on watch
- user can switch the active server from the watch
- notifications identify which server the event belongs to
- server revoke or auth failure affects only the matching server record
- pairing, reconnect, and token storage stay isolated per server

Important: future multi-server support must not require redesigning thread ids, device ids, or
notification routing from scratch.

## Pairing and Reconnect Requirements

- Initial pairing may start from the helper UI or another larger-screen Agent Pulse client and then
  transfer the connection to the watch.
- The product should not depend on QR scanning from the watch itself.
- A short code or server handoff from an already-paired device is preferred for watch onboarding.
- Reconnect flows must support token + device identity + fingerprint or an equivalent watch-safe
  mechanism consistent with existing Agent Pulse security requirements.
- The watch app must clearly show whether it is paired, disconnected, revoked, or pointed at an
  unreachable server.

## Security Requirements

- The watch app follows the same trust model as other Agent Pulse clients.
- Authentication must not depend on a secret URL.
- Every protected request must validate device auth.
- The watch app must never expose or cache raw provider files.
- Tokens and reconnect secrets must be stored in platform-appropriate secure storage.
- Logs must redact tokens, pairing codes, and reconnect codes.
- Notification payloads must minimize sensitive content because Apple Watch notifications may appear
  on wrist before full app unlock.

### Action Safety

- Actions exposed on the watch must be intentionally limited.
- High-risk actions should stay on larger devices until explicitly designed for the watch.
- If a provider action has ambiguous or high-impact consequences, the watch app should route the
  user to the Mac, phone, or tablet instead of guessing.

## Privacy Requirements

- No raw transcript dump is shown in notifications.
- The watch app should default to summary data only.
- The watch app should fetch only the minimum data needed for the current screen.
- The watch product keeps the same local-first privacy posture as the rest of Agent Pulse.

## Required Screens

- Server picker or current-server screen
- Thread list screen
- Thread detail screen
- Send short message screen
- Notification deep-link handling target
- Offline / reconnect screen
- Device revoked screen

## Helper Settings Requirements

The existing helper settings should eventually add watch-aware controls or visibility:

- show whether watch notifications are configured
- show watch device registrations
- revoke a watch device
- show which server name and public URL the watch is paired against

The first release may keep most watch management in the existing device list UI if that is simpler.

## Operational Requirements

- The watch experience must remain useful on intermittent network connections.
- Foreground thread refresh should feel fast enough for quick triage.
- Notification delivery should be fast enough to make finish/error events feel timely.
- If remote access is disabled or unhealthy, the watch should surface a clear server-unavailable
  state rather than spinning indefinitely.

## Open Questions for Later Phases

- Should the watch support approval decisions after the tablet/phone flows are proven safe?
- Should the watch expose a Smart Stack widget or complication summary later?
- Should a future iPhone app become the onboarding bridge for server management and watch pairing?
- Should the watch support a server-specific summary card instead of a raw thread list first?
