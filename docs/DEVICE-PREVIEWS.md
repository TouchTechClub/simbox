# Live device previews and controls

Open **Dashboard → Devices → Open device panel** on a live run. The panel lists
the run's Simlock leases: each device an agent has open is viewable. Select one,
watch live video, and optionally **Enable control** after reviewing the
confirmation. The panel never leases, boots or replaces a device, and never
changes a CLI session.

## Interaction

- Touch/click to tap; drag to swipe, using normalized screen coordinates.
- Focus the screen to type. Both platforms forward USB HID key down/up events;
  shortcuts with Ctrl/Cmd, paste and IME are not supported.
- Home, app switcher, lock/wake; Android Back.
- Download the displayed frame as PNG, expand fullscreen, or reconnect video.
- Browser control does **not** lock out CLI agents: coordinate with them.

Simlock's input channel has no rotation or text message, so the panel has no
Rotate button or Android text field. Use `simbox exec` for those.

Viewing does not reset the runner idle timer: only leases do. Closing the panel,
hiding the tab, switching devices, or ending the run closes transports and
releases held touch/keyboard input where possible. When an agent releases its
lease, Simlock ends the stream and the panel says so. Reconnect acquires new
access and only restores video; **no device action is queued or replayed**.

## Transport

Simlock serves each lease's video and input; the API Worker proxies both with
the run's token, because browsers cannot send `Authorization` on a WebSocket
and Simlock sends no CORS headers:

| Panel route                             | Simlock                      |
| --------------------------------------- | ---------------------------- |
| `GET /v1/runs/:id/preview/devices`      | `GET /v1/leases` (+ devices) |
| `POST /v1/runs/:id/preview/access`      | — (signs a ticket)           |
| `GET /v1/runs/:id/preview/video?device` | `GET /v1/leases/:id/stream`  |
| `WS /v1/runs/:id/preview/socket?ticket` | `WS /v1/leases/:id/input`    |

- Video, both platforms: Simlock's `[u32 length][u8 tag][payload]` stream over
  streaming HTTP (avcC, key and delta frames, a JPEG seed frame, and an
  end-of-lease marker), decoded with WebCodecs onto a canvas.
- Input: the Worker validates the panel's JSON and translates it to Simlock's
  binary messages (`0x03` touch, `0x04` button, `0x06` HID key). It forwards
  only Simlock's screen config (`0x82`) back, and turns its admission (`0x83`)
  into the panel's ready message.

The panel needs a browser with working H.264 WebCodecs (current Chrome/Edge) on
HTTPS or localhost. Unsupported browsers get an actionable error. Audio, app
upload, accessibility overlays, device creation and arbitrary commands are not
part of this panel.

## Security and lifecycle

Preview endpoints and tickets never include the run's token, and the panel never
connects directly to the runner tunnel. (The CLI connection-details card is
separate and still lets the owner reveal their credentials.) Authenticated API
endpoints verify run ownership and live state, and admit only leases Simlock
currently reports. WebSockets use HMAC-signed tickets bound to user, run,
platform, exact lease and read/control mode. Tickets expire after **60 seconds
for connection admission**; an admitted stream has a maximum **five-minute
session**, then reacquires access. Tickets are short-lived bearer capabilities,
not single-use tokens; treat them as private. Logout/session revocation prevents
issuing new tickets; an already admitted connection can last until its session
ends. Ending a run tears down its tunnel, and the API rejects further admission
immediately.

WebSocket upgrades require the configured app Origin. The API forwards the
token only to the run's own HTTPS named-tunnel hostname, never follows
redirects, and strips browser cookies/credentials from the upstream request.
Only lease inventory, the lease stream and a validated input socket are
reachable: no agent-device, exec or admin surface. Read tickets cannot escalate
to controls; read-only sockets that send input are closed. Input messages are
size bounded and parsed against an allowlist, and video parsers are bounded.
Streams/screenshots use no-store/no-transform and never enter an API/cache
bucket. Downloaded PNGs are local evidence and may contain private app content.

## Verification and rollout

```bash
bun test tests/preview.test.ts tests/preview-api.test.ts tests/preview-stream.test.ts
bun run test:preview-worker  # real workerd/auth/D1/101 upgrades; mocked runner
```

Spike S4 (see [the v3 plan](../.plans/v3-simlock.md)) streamed and controlled
leases through a per-run named tunnel on hosted runners. The panel's port onto
that path still needs a real end-to-end run on both platforms before release.

Release the agent/action and deploy the API/dashboard together. Agents that
predate Simlock are refused at registration; start a new run after
`simbox repair`.

## Attribution

Devices, leases, video and input come from [Simlock](https://incubator.callstack.com/simlock/)
(Callstack). The panel's canvas client originally followed
[T3 Code](https://github.com/pingdotgg/t3code)'s `DeviceStreamView`. See [third-party notices](THIRD-PARTY-NOTICES.md).
