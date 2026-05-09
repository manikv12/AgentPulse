# Agent Pulse Remote Access Requirements

## Summary

The next milestone after the LAN release should allow paired devices to reach the local helper from outside the local network.

The preferred direction is to extend the current local-first architecture, not rebuild the product around Firebase or a cloud-sync-first model.

The public hostname assigned by the tunnel is treated as public knowledge. Security must not depend on the URL being secret; every protected surface must hold up when an attacker already knows the entrypoint.

This document defines the requirements, architectural direction, locked decisions, and rollout checkpoints for secure internet access.

## Problem Statement

Today Agent Pulse works well on the same trusted LAN as the local helper. That is enough for a desk tablet, but it does not cover these next-step use cases:

- checking threads from outside the home or office
- opening the dashboard from a phone on cellular
- using Agent Pulse while traveling away from the helper computer's local network
- preparing the system for a future hosted product without throwing away the current helper model

The remote-access design must preserve the core product shape: the helper remains the authority that reads local agent state and mediates all actions.

## Current Architecture Constraints

Current implementation facts that matter for remote access:

- The helper already serves the built tablet app.
- The tablet app currently assumes same-origin HTTP requests.
- The live event stream currently assumes same-origin WebSocket access.
- The helper binds to loopback by default and can optionally open LAN mode.
- Device pairing, per-device tokens, per-device reconnect PINs, and fingerprint checks already exist.
- The helper does not currently have an external-origin or remote-host configuration model.
- The helper must continue to hide raw Codex files and raw agent app-server surfaces from remote clients.
- The current pairing PIN flow assumes a same-room or same-LAN trust ceremony. It is not safe to expose unmodified to the public internet, where anyone who reaches the URL can attempt the PIN.

These constraints make a tunnel-first rollout the lowest-risk path for the first remote release.

## Architectural Direction

### Decision Statement

Agent Pulse should keep the current helper-centered architecture and add remote access in phases.

The first remote release should expose the current helper-served app through a secure tunnel as a single origin. A cloud relay or hosted control plane can be added later if the product needs multi-user accounts, tenant routing, push notifications, or more advanced SaaS behaviors.

Firebase is not the preferred transport layer for this phase. It may be evaluated later for account identity, notifications, or supporting services, but not as the core real-time thread transport.

### Preferred Sequence

1. Tunnel the existing helper-served app as one HTTPS/WSS origin.
2. Add explicit remote-access settings, origin rules, and operational visibility.
3. Harden auth, logging, reconnect handling, and remote admin controls.
4. Evaluate a relay or broker only after the tunnel-based model is validated with real usage.

### Decisions Locked for Phase 1

The following decisions are normative for Phase 1 and are not open research questions. They unblock the settings model, auth flow, and client work.

- **Tunnel lifecycle ownership.** The helper supervises the tunnel binary directly: spawn on enable, monitor health, restart on failure, terminate on disable. A bring-your-own-tunnel mode is explicitly deferred and is not a supported Phase 1 configuration.
- **Phase 1 provider.** Cloudflare Tunnel is the supported provider for Phase 1, chosen for stable hostname, clean WebSocket support, free tier suitable for a single-user product, and a supervisable binary (`cloudflared`). Other providers from the evaluation list are documented as fallbacks only.
- **Frontend hosting.** The tablet app continues to be served by the helper as a single same-origin bundle. No separately hosted frontend, no configurable API or WebSocket base URLs in the client. Client transport configuration changes are pushed to Phase 3.
- **Pairing trust model over the public URL.** Initial pairing of a brand-new device must occur on the LAN, or via a one-time pairing code generated on the helper UI and entered out-of-band. The public URL alone is never sufficient to begin pairing. Reconnection of an already-paired device may occur over the public URL using the existing per-device reconnect PIN, token, and fingerprint.

## Goals

- Allow a paired device to open Agent Pulse from outside the LAN.
- Preserve the local-first helper model.
- Avoid a big-bang rewrite.
- Keep the helper as the only process that reads local agent state.
- Support live updates remotely with the same device auth model.
- Provide pairing flows that remain safe when the entrypoint URL is publicly known.
- Make remote access reversible from the admin settings screen.
- Keep the system compatible with a later hosted or relay-based architecture.

## Non-Goals

- Rewriting the product around Firebase.
- Replacing helper-managed device auth with anonymous public access.
- Exposing raw agent or Codex endpoints directly to the internet.
- Building native iOS or Android apps in this phase.
- Multi-user team collaboration in the first remote release.
- Cloud persistence of all threads in this phase.
- Bring-your-own-tunnel as a first-class supported configuration in Phase 1.
- Configurable API or WebSocket base URLs in the tablet client in Phase 1.

## Product Requirements

### User-Facing Requirements

- The user can enable remote access from the existing admin settings screen.
- The user can see whether remote access is off, starting, healthy, degraded, or disconnected.
- After enabling remote access, the user sees a first-run checklist (dependency installed, tunnel authenticated, hostname assigned, health green) and the public URL is presented as ready to share only when every check passes.
- The user can copy a public URL from the settings screen.
- The settings screen can show a QR code for the public URL when useful.
- Initial pairing of a new device requires either being on the LAN, or entering a one-time pairing code that is generated on and visible only from the helper UI. Opening the public URL alone is never sufficient to begin pairing.
- An already-paired device can reconnect remotely using the existing reconnect flow (per-device reconnect PIN, token, and fingerprint).
- The remote dashboard shows the same thread list, transcript loading, and live status updates as the LAN version.
- The user can turn remote access off immediately, and the public entrypoint stops working.

### Admin Requirements

- Remote access controls must live beside the existing LAN and mobile-send controls.
- The settings screen must show the current remote hostname or public URL.
- The settings screen must show enough health information to diagnose whether the tunnel or relay is connected.
- The settings screen must show the last remote connection error when the remote path is broken.
- LAN mode and remote mode are independently toggleable. Enabling one must not enable or disable the other, and the UI must show both states distinctly.
- When remote access is on but the tunnel is unhealthy, LAN access — if enabled — must continue to function unaffected.
- Remote admin settings must not silently enable LAN mode unless explicitly required and surfaced.

### Pairing and Device Requirements

- Initial pairing of a new device is restricted to the LAN, or to a one-time pairing code generated on the helper UI and entered out-of-band by the user. The same pairing PIN must not be reusable across attempts.
- Pairing PINs and one-time pairing codes are short-TTL (under 5 minutes), single-use, and invalidated on first successful use or expiry.
- The pairing endpoint enforces a per-IP attempt rate limit and a global lockout after a small number of consecutive failures, sized so the PIN space cannot be exhausted within the TTL.
- Per-device reconnect PIN flows continue to work over the public URL for already-paired devices.
- Device auth remains token + device id + fingerprint on every protected request, even when traffic is remote.
- Device revoke must terminate the device's active sessions and any in-flight WebSocket connections within 5 seconds, and block all future remote requests for that device.
- Remote pairing, reconnect, revoke, and auth-failure events must be recorded in admin activity or logs with device id, source IP, and reason.

## Security Requirements

### Transport and Exposure

- Remote access must use HTTPS and WSS at the public edge.
- Authentication must not depend on the secrecy of the public hostname. Every protected surface must hold up assuming the URL is publicly known.
- The helper must never expose raw Codex files, raw SQLite databases, or raw agent app-server endpoints.
- The helper must keep device-auth validation (token + device id + fingerprint) on every protected request.
- The admin screen must allow remote access to be disabled without deleting pairings.

### Origin Policy

- WebSocket upgrades and authenticated HTTP requests must validate the request `Origin` against a helper-managed allowlist.
- The allowlist is auto-populated from the configured public URL and the LAN origin. Manual user entry of origins is not required for the supported setup.
- CORS must not default to wildcard access for authenticated routes.

### Rate Limiting

- Pairing endpoints enforce per-IP attempt limits and global lockout after consecutive failures (see Pairing and Device Requirements).
- All unauthenticated routes must be rate-limited per source IP whenever remote access is enabled.
- Authenticated routes must be rate-limited per token, sized so a stolen token cannot scrape data at LAN speed.

### Logging and Observability

- Tokens, pairing PINs, and one-time pairing codes must always be redacted in logs.
- The helper records structured remote-session events — connect, disconnect, auth failure, origin reject, rate-limit trip — with device id (when known), source IP, and reason. PII is excluded.
- Remote health (tunnel up/down, last error, time since last reconnect) must flow through the existing status surface, not a parallel one.

### Optional Hardening To Evaluate

- A second access-control layer in front of the public URL, such as Cloudflare Access.
- Separate policy for admin-only routes vs device routes.
- IP or geo restrictions for remote admin access.

## Operational Requirements

- Remote access must not require manual router port forwarding for the primary supported setup.
- The remote entrypoint must recover cleanly after helper restart, helper-computer sleep/wake, and network change. Recovery target: reconnect within 30 seconds of the network event, or surface a specific actionable error in the settings UI.
- On first enable, the helper detects whether the tunnel binary is installed and authenticated. If not, the UI guides the user through install and provider login. The helper must not silently auto-install system binaries.
- The helper must surface whether the remote dependency is installed, authenticated, and connected — both as a status string and as discrete machine-readable fields suitable for the settings UI checklist.
- The supervised tunnel survives helper-computer restart via the existing helper auto-start mechanism. Credential-store access while the screen is locked must not block tunnel reconnect.
- The remote solution must support WebSocket traffic reliably enough for live thread updates: live event end-to-end latency under 1 second p95 for a single client on a typical home network.
- The helper must remain responsive with at least 5 simultaneous live remote WebSocket clients. No hard cap on paired devices is enforced in Phase 1.
- The remote solution must provide a stable hostname, not a constantly changing ad hoc URL.
- The setup should be simple enough for a single-user desktop product.

## Architecture Requirements

### Phase 1: Tunnel the Existing Helper

The first remote-capable release keeps a single origin for the web app and API.

Requirements:

- The helper-served app remains the primary entrypoint.
- The supervised tunnel (Cloudflare Tunnel via `cloudflared`) publishes the helper over HTTPS/WSS.
- The existing same-origin fetch and WebSocket client behavior must remain unchanged. Phase 1 forbids client-side base-URL refactors.
- No separate hosted frontend is shipped for the first remote release.
- Remote health flows through the existing status surface, not a parallel one.

This is the lowest-risk approach because it avoids immediate client refactoring while proving real remote demand.

### Phase 2: Add Explicit Remote Configuration

After the first tunnel-based release works, the product gains first-class remote configuration.

Requirements:

- Persist remote-access settings (enabled, provider, public base URL, last health state, last error) in helper settings.
- Surface richer status — health timeline, last reconnect, dependency version — in the admin settings UI.
- Expose remote-status fields via the settings API for the tablet to render.

Origin allowlist and WebSocket origin validation are normative from Phase 1 and live in the Security Requirements section, not here.

### Phase 3: Evaluate Relay or Broker

If the product later needs multi-user accounts, shared access, hosted dashboards, or stronger SaaS separation, evaluate a cloud relay.

Requirements for that future decision:

- The helper still owns local agent access.
- The relay only brokers authenticated traffic; it does not become the source of truth for agent state by default.
- The transport model must continue to support streaming updates and reconnect semantics.
- The migration path from tunnel mode to relay mode must not require replacing the entire local product.

## Implementation Requirements By Surface

### Helper Server

- Add a remote-access settings model.
- Add origin-aware HTTP handling for browser requests.
- Add origin validation for WebSocket upgrade requests.
- Add remote-status reporting to the settings API.
- Keep LAN mode and remote mode separately controllable.

### Tablet Client

- Same-origin assumption is preserved. No new transport configuration in the client for Phase 1.
- On WebSocket disconnect, the client retries with capped exponential backoff and surfaces a non-destructive "reconnecting" state.
- A 401 or 403 transitions the client into the existing revoked-device flow rather than infinite reconnect.
- The offline and revoked-device screens must behave correctly when the remote path drops.
- Configurable API or WebSocket base URLs (needed only if the frontend is ever hosted separately from the helper) are out of scope for Phase 1 and tracked under Phase 3.

### Settings UI

- Add a remote-access section to the existing admin settings screen.
- Show remote status, public URL, and connection errors.
- Provide a clear enable or disable control.
- Provide setup guidance that does not assume the user understands tunnels.

## Provider Evaluation Criteria

Cloudflare Tunnel is the chosen Phase 1 provider (see Decisions Locked for Phase 1). These criteria document the bar the chosen provider must clear and the bar any future swap must clear.

Must-have:

- WebSocket stability over long-lived (multi-hour) sessions.
- Stable hostname; not a constantly changing ad hoc URL.
- No inbound port forwarding required.
- Supervisable from the helper as a managed child process on macOS and Windows.
- Exposes connection health the helper can surface in the UI.

Nice-to-have:

- Acceptable cost for a solo or small-scale product (free tier or low fixed cost).
- Custom domain support.
- An optional access-gate add-on (e.g. Cloudflare Access) usable for admin-only routes.
- Swappable without an architectural reset if hosting strategy changes later.

Other providers considered:

- Tailscale Funnel or a comparable Tailscale-based path — viable fallback if Cloudflare Tunnel proves unsuitable.
- ngrok or similar developer tunnels — for internal development and testing only, not a shipped Phase 1 option.

## Research Checklist

Decisions resolved in this revision (see Decisions Locked for Phase 1) are no longer open: provider choice, tunnel lifecycle ownership, frontend hosting, pairing trust model, and sleep/wake recovery target.

Open questions still worth answering during implementation:

- What are the exact idle timeout and reconnect behaviors of `cloudflared` for long-lived WebSocket sessions, and how do we work around them if they drop sessions earlier than our 1s p95 latency target tolerates?
- How should the helper surface tunnel authentication state and credential failures in the settings UI, distinct from network-level health?
- Is a provider-level access gate (e.g. Cloudflare Access) warranted for admin-only routes specifically, in addition to device pairing?
- What is the cleanest first-run UX for installing and authenticating `cloudflared` from inside a desktop helper app?
- At what scale or product complexity does a dedicated relay become justified over the supervised-tunnel model?
- If Firebase is used later, what exact job would it perform: auth, notifications, presence, or something else? (This stays deferred until real demand appears.)

## Acceptance Criteria

The first remote-access milestone is complete when every bullet below can be verified by manual or automated test:

- A factory-fresh phone on cellular can open the public Agent Pulse URL, complete the LAN-or-one-time-code pairing flow, and reach the dashboard. Opening the public URL alone, without LAN access or a one-time code, must not allow pairing.
- A previously paired device on cellular can reconnect remotely using only the per-device reconnect PIN, and then loads thread list, transcripts, and live updates.
- Live event end-to-end latency for a single remote client stays under 1 second p95 on a typical home network.
- The helper remains responsive and continues to push live updates with at least 5 simultaneous remote WebSocket clients.
- Revoking a device terminates its active remote sessions and any in-flight WebSocket connections within 5 seconds, and blocks all future remote requests for that device.
- Disabling remote access stops the public entrypoint within 5 seconds and does not affect LAN mode if LAN is also enabled.
- After helper-computer sleep/wake or Wi-Fi change, the public entrypoint reconnects within 30 seconds, or the settings UI surfaces a specific actionable error.
- A WebSocket upgrade attempt from an origin not in the helper-managed allowlist is rejected.
- A scripted brute-force attempt against the pairing endpoint trips rate-limit lockout before the PIN space can be exhausted within the PIN TTL.
- The settings UI shows remote status, public URL, last connection error, and the dependency/auth-state checklist.

## Deferred Decisions

These questions remain open until real remote usage is validated:

- Whether a relay should replace tunnel mode (Phase 3 trigger).
- Whether hosted accounts should be added before or after remote beta feedback.
- Whether remote admin access should require stronger policy than normal device access (idle-session expiry, forced revalidation, IP/geo restrictions).
- Whether the frontend should eventually be hosted separately from the helper. This is the trigger for the configurable client base-URL work that Phase 1 explicitly excludes.
- Whether bring-your-own-tunnel becomes a supported configuration after Phase 1.

## Relationship To Other Docs

- `docs/TOUCH_APP_REQUIREMENTS.md` remains the v1 local and LAN product requirements document.
- This document covers the next remote-access phase and the constraints for doing it without an architectural reset.
