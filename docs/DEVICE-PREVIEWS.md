# Live device previews and controls

Open **Dashboard → Devices → Open device panel** on a live run. Select the exact
booted device, watch live video, and optionally **Enable control** after reviewing
the confirmation. The panel never boots/replaces a device or changes a CLI session.

## Interaction

- Touch/click to tap; drag to swipe, using normalized screen coordinates.
- Focus the screen to type. iOS forwards HID keyboard down/up events; Android
  forwards printable characters and navigation keys. iOS paste/IME and Android
  modifier shortcuts are not supported. Android also has an explicit text field.
- Home, app switcher, lock/wake; Android Back; iOS rotation.
- Download the displayed frame as PNG, expand fullscreen, or reconnect video.
- Only one browser controller can attach to a device. Other tabs can view it.
  Browser control does **not** lock out CLI agents: coordinate with them.

Viewing and inventory queries do not reset the runner idle timer. Valid controls
do. Opening a viewer does not create an agent-device session just to keep the
runner alive. Closing the panel, hiding the tab, switching devices, or ending the
run closes transports and releases held touch/keyboard input where possible.
The last frame is marked stale after a disconnect. Reconnect acquires new access
and only restores video; **no device action is queued or replayed**.

## Same transport as T3 Code

The reference is T3 Code's device panel and `DeviceHubProxy`, not an embedded
third-party dashboard. Simbox installs **expo-device-hub 0.12.0** into an isolated
runner-temp directory on first preview access, binds it to loopback, and uses:

- Android `serve-emu`: scrcpy H.264 over WebSocket with SEMU v1/v2 frame metadata.
- iOS `serve-sim`: AVCC-framed H.264 over streaming HTTP and a separate HID socket.
- WebCodecs decoding onto a canvas; continuous iOS MJPEG video fallback when H.264
  is unavailable. This fallback is a live hub stream, **not screenshot polling**.

Android requires a browser with working H.264 WebCodecs (current Chrome/Edge) on
HTTPS or localhost. Decoder support is checked at runtime; unsupported browsers
get an actionable error. Audio, WebRTC, foldable-device tooling, app upload,
accessibility overlays, device creation/boot, and arbitrary shell/RPC commands are
not part of this panel. Existing CLI app setup/testing remains unchanged.

The hub installs lazily and is supervised separately from the CLI gateway. First
access may take a few minutes; inventory retries while the panel is visible.
Hub failure never makes an otherwise functional CLI run fail. serve-sim's
native capture can stop answering control/video socket admission after aborted
attachments; the runner detects that admission failure and restarts the hub
process (viewers reconnect; CLI work is unaffected). Restart/reconnect never
repeats an input. Android uses the hub's pinned scrcpy server (downloaded
on first capture); the runner needs outbound access to npm/GitHub in addition to
the existing API and Cloudflare endpoints. iOS needs the normal Xcode/simulator
tools. The action's existing platform/tool checks continue to apply.

## Security and lifecycle

Preview endpoints/tickets never include the daemon token, and the panel never
connects directly to the runner tunnel. (The existing CLI connection-details
card is separate and still lets the owner reveal their credentials.)
Authenticated API endpoints verify run ownership and live
state, and admit only devices in the observed active inventory. WebSockets use
HMAC-signed tickets bound to user, run, platform, exact device and read/control
mode. Tickets expire after **60 seconds for connection admission**; an admitted
stream has a maximum **five-minute lease**, then reacquires access. Tickets are
short-lived bearer capabilities, not single-use tokens; treat them as private.
Logout/session revocation prevents issuing new tickets; an already admitted
connection can last until its lease ends. Ending a run tears down its runner
transports, and the API rejects further admission immediately.

WebSocket upgrades require the configured app Origin. The API forwards credentials
only to validated HTTPS `*.trycloudflare.com` origins, never follows redirects,
and strips browser cookies/credentials from the upstream request. The runner
requires daemon auth before touching the hub. Only inventory, fixed video paths
and a validated input socket are reachable—no dashboard, exec, app-management or
generic hub RPC surface. Read tickets cannot escalate to controls. Inputs are
size/rate bounded, video parsers and relay frames are bounded, slow runner-side
clients are disconnected, and at most four preview transports attach per runner
(an iOS preview uses two). Streams/screenshots use no-store/no-transform and never
enter an API/cache bucket. Downloaded PNGs are local evidence and may contain
private app content.

## Verification and rollout

```bash
bun test tests
bun run test:preview-worker  # real workerd/auth/D1/101 upgrades; mocked runner
bun run typecheck
bun run check
```

Local browser verification used a generated H.264 fixture through **browser →
workerd API → real Simbox runner gateway → fixture hub**. It checked actual canvas
decoding, read-only mode, consent, tap/drag/keyboard/navigation/text translation,
screenshot download initiation, reconnect without replay, and desktop/mobile
layout. Separate browser fixtures verified iOS AVCC decoding, landscape touch
remapping and continuous MJPEG fallback. The official hub also installed and
started locally.

**Real-runner verification (2026-10-06):** a real `ubuntu-latest` GitHub runner
ran an unreleased agent build against a real Android 14 emulator. Browser →
updated workerd API → real Cloudflare tunnel → runner gateway → expo-device-hub
delivered live scrcpy H.264 that decoded on canvas. Verified: read-only mode sends
zero input (confirmed via independent CLI snapshot), consent dialog, direct tap
navigation into a Settings sub-screen, Back, explicit text field input, Backspace
key editing, swipe, Home, and transport reconnect — each confirmed against
independent `agent-device` snapshots and screenshots of the real device, not the
web view. iOS real-runner verification: a macOS ARM64 runner booted a real
iPhone 17 Pro simulator (iOS 26.4); the hub reported direct IOSurface capture at
1206x2622 and served live H.264 AVCC and HID. Verified on the real device:
tap navigation into Settings → General, touch Back, HID keyboard typing into the
Settings search field (real "No Results for 'network'" result) and Home,
confirmed by independent native simulator screenshots. Landscape canvas rotation
was observed, but physical rotation and landscape control were not independently
established. Direct MJPEG probes delivered continuous real capture (6 MB in
15 seconds). Complete iOS browser reconnect/fallback verification did not pass
reliably; it remains a production testing item rather than a verified success.
Repeated AVCC attachments stalled while MJPEG and device inventory remained
healthy. Admission watchdogs restart the hub on timeout, and the web client
attempts continuous MJPEG when H.264 produces no decodable output. These recovery
paths are covered by regression tests, not a complete passing real-device run.

Release the agent/action and deploy the API/dashboard together. Older active
agents lack preview routes: retain CLI access, then start a new run after upgrade.
No new preview-specific database migration is needed; the accompanying runner
settings migration still must precede the combined API release. Keep existing
agent-device version compatibility and release-generated binary checksums intact.

## Attribution

The wire/client design references [T3 Code](https://github.com/pingdotgg/t3code),
especially `packages/client-runtime/src/device/stream.ts`, `DeviceStreamView`, and
`DeviceHubProxy`. Protocol parsing/input mappings are adapted for Simbox's Worker
and Bun transports. See [third-party notices](THIRD-PARTY-NOTICES.md).
