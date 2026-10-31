# v3: Simlock under the hood

Status: **in progress** on `refactor/use-simlock-leasing`. The architecture is settled (no gateway,
spike S4). The defaults taken for D2–D4 are listed under [Decisions](#decisions).

## Goal

Stop maintaining our own device stack. [Simlock](https://incubator.callstack.com/simlock/)
(Callstack, MIT, pinned at `simlock@0.4.0`) does device creation and boot, the warm pool, leasing
and the queue, wiping between agents, the agent-device proxy, and screen streaming and input.
Simbox keeps four jobs:

1. **Auth.** GitHub sign-in, CLI login, the repo's `SIMBOX_TOKEN`, and handing each run's Simlock
   agent token to that run's owner only.
2. **The common entry point.** One API and dashboard for every user. It lists the user's runs and
   proxies the dashboard's live view. It is not a Simlock gateway.
3. **Dashboard.** Repo connection, runner, device and workflow settings, runs, and live devices.
4. **Running GitHub Actions.** Committing the workflow, managing `SIMBOX_TOKEN`, dispatching runs,
   per-run named tunnels, and cleaning up runs.

## Why there is no Simlock gateway

A Simlock gateway is single-tenant: an agent token is shell access to whichever worker holds its
lease, and the gateway gets operator rights on every worker that joins it. A shared gateway would
let user A's agent land on user B's runner, which holds B's checkout and secrets. So it would have
to be one gateway per user. That needs hosting: Cloudflare Containers need the Workers Paid plan,
which we do not have, and a VPS is one more thing to run.

Spike S4 showed we need neither. **Each GitHub run is its own standalone Simlock daemon**, reached
through the per-run named tunnel we already provision. The tenant boundary is the run: its agent
token only opens that run's daemon, and only the run's owner ever receives it.

## Target architecture

```
 simbox CLI / agent ──(1) ensure/list runs ─────────────▶ API Worker (D1, KV, GitHub App)
        │                                                     │  (2) workflow_dispatch
        │                                                     ▼
        │                                              GitHub Actions run
        │                                     ┌───────────────────────────────────┐
        └──(3) agent-device / HTTP leases ───▶│ cloudflared (named tunnel, http2) │
          https://r-<hex>.<zone>/v1/…         │      ▼ 127.0.0.1:4701             │
                                              │ simlock daemon (standalone)       │
 dashboard ──▶ API Worker /v1/runs/:id/live/* │   warm pool, leases, stream/input │
          (proxied with the run's token) ────▶│ simbox-agent: supervise+heartbeat │
                                              └───────────────────────────────────┘
```

1. The CLI asks the API for a run of the platform (`POST /v1/runs/ensure`). The API reuses a live
   run with a free device or dispatches a new one, exactly as today.
2. The runner's agent installs Simlock, warms one device, mints a Simlock **agent** token, opens
   the run's named tunnel and registers `{tunnelUrl, daemonToken}` with the API.
3. The CLI connects agent-device to `https://<run>/v1/agent-device` with that token. Simlock leases
   a device per agent-device session, and frees and wipes it on `close` or lease expiry.

### Runner (`packages/agent`, `simbox-agent`)

The `start` step, in order (all before the run is announced live):

1. Host checks and API config (platform, requested device, run id, `maxDevices`).
2. **iOS:** Spotlight off, select Xcode (the requested one, else the newest release), and validate
   the requested model and OS against the runner's catalog. **Android:** AVD/SDK dirs, accept
   licenses, install `emulator`, `platform-tools` and the chosen system image (Simlock only warms
   targets whose image is installed), and validate the model.
3. `npm i -g simlock@<pin> agent-device@<pin>`, then `chmod +x "$(npm root -g)"/simlock/dist/bin/*`
   (0.4.0 ships the capture binaries without the exec bit).
4. Write `~/.simlock/config.json`: capabilities `agent-device`, `stream` and `input` on; one warm
   target `{platform, model, osVersion?, count: 1}`; `lease.maxPerRequester = maxDevices` (every
   client of a run shares one agent token, which Simlock counts as one requester); Android
   emulator headless with no audio, licenses accepted.
5. `simlock daemon start`, then poll `simlock status --json` until the warm target is ready. Fail the
   run after the warm-up deadline or repeated boot failures.
6. Self-test and warm-up through the local profile (`agent-device connect --remote-config
~/.simlock/agent-device-profile.json`): `open` (iOS: `com.apple.Preferences`), `snapshot`, `close`.
   On iOS this also builds the XCTest runner, so no client call later waits on the 90s build.
7. `simlock token create --role agent --label simbox-run-<id>`; the secret is masked in logs.
8. Stage `ready`; the `serve` step says `go`.
9. Named tunnel from `POST /v1/runs/tunnel` (ingress `http://127.0.0.1:4701`), cloudflared with
   `--protocol http2` at raised priority; wait for authoritative DNS; register.
10. Supervise: the daemon and cloudflared are alive, the edge answers `/v1/healthz`, heartbeat every
    60s with `activeDevices` = Simlock leases and `devicesReady` = warm devices ready. Idle exit
    after 15 minutes with no leases and no queued requests; hard exit before the job limit. On
    exit: deregister, `simlock daemon stop`, stop cloudflared.

Deleted from the agent: the agent-device proxy and our gateway, the preview gateway, the
device hub, our own device boot and recovery, the quick-tunnel fallback and the device counting.

### API (`apps/api`)

- **Kept:** auth, repos and installations, workflow commits, `SIMBOX_TOKEN`, dispatch, run lifecycle
  and webhooks, named tunnels and the sweep cron, holders and `ensure` (picking a run is our queue:
  one hosted run is about one device).
- **Changed:** tunnel ingress port `4310` → `SIMLOCK_PORT` (`4701`). `register` requires
  `versions.simlock`; an older agent gets a 409 telling the user to run `simbox repair` (new
  action release). `daemon_token` now holds the Simlock agent secret. Quick tunnels are gone, so
  `register` only accepts the run's own named-tunnel hostname.
- **Live view:** the old preview routes become a thin proxy to the run's daemon, using the run's
  token (browsers cannot send `Authorization` on WebSockets, and Simlock sends no CORS headers):
  - `GET /v1/runs/:id/preview/devices` → `GET /v1/leases` (each active lease is a viewable device).
  - `POST /v1/runs/:id/preview/access` → short ticket bound to user, run, lease and control mode.
  - `GET /v1/runs/:id/preview/video?device=<lease>` → `GET /v1/leases/:lease/stream`.
  - `WS /v1/runs/:id/preview/socket?ticket=` → `WS /v1/leases/:lease/input`. The Worker translates
    the panel's JSON input to Simlock's binary messages (`0x03` touch, `0x04` button, `0x06` key;
    Simlock has no rotation or text message) and drops input in read-only mode.
- **No migration.** The `runs` columns stay; `android_ready` keeps meaning "a warm device is ready".

### CLI (`apps/cli`)

- `simbox sim` is unchanged in shape: ensure, wait for live and a ready device, probe
  `GET <tunnel>/v1/agent-device/health` with the token, write the cache, then print or run the
  connect command: `agent-device connect proxy --daemon-base-url <tunnel>/v1/agent-device
--session simbox-<run>` with `AGENT_DEVICE_DAEMON_AUTH_TOKEN`.
- `simbox exec` stays (the skill and S5 use it) but only adds the remote flags. Its retry and
  caching are unchanged.
- Every request sends a real `User-Agent` (Cloudflare's Browser Integrity Check blocks some).

### Dashboard (`apps/web`)

The live panel keeps its UI. Video comes from the proxied Simlock stream on both platforms (the
same `[u32 len][u8 tag]` framing the iOS path already decodes), and input goes over the proxied
socket. Android no longer gets video over the socket.

## Decisions

- **D1 Gateway:** none (S4). Settled.
- **D2 Agent interface:** keep `simbox exec` as a thin wrapper, so the skill and S5 keep working.
  Agents may also call `agent-device` directly after `simbox sim`.
- **D3 Live devices:** port our panel, with control, through the API proxy.
- **D4 Compatibility:** hard cutover. The new action release moves `TouchTechClub/runner@v1`, so
  workflows pick it up on the next dispatch. Old agents are refused at `register` with a clear 409.

## Phases

1. **Shared:** `SIMLOCK_PORT`, pins (`simlock`, `agent-device`), register versions, step texts.
2. **Agent:** `simlock.ts` (install, config, daemon, status, token, self-test); a new `index.ts`
   main and supervisor; adapters reduced to select + host prep; delete the old stack.
3. **Action:** Android `prepare` installs `libpulse0`; release bumps to v0.6.0.
4. **API:** tunnel port, register check, live-view proxy (replaces preview), delete the old
   preview plumbing.
5. **CLI:** `/v1/agent-device` paths, health probe, User-Agent.
6. **Web:** stream + input through the proxy.
7. **Tests, docs, skill.** Then a real end-to-end run on both platforms before merging.

## Spike results (2026-10-31, simlock 0.4.0, agent-device 0.21.35)

S1–S3 ran with a gateway on a dev box; S4 is the design we are building. Runs were on
`SparshKaushik/rb-sim-test` branch `spike/simlock` (`macos-latest`: 3 vCPU, 7 GB, Xcode 26.6,
iOS 26.2–26.5; `ubuntu-latest`: 4 vCPU, 16 GB, KVM).

### S1 Runner: works, with fixes we must ship

- **Join and startup are fast.** `npm i -g simlock agent-device` takes 4s. iOS joined about 20s
  after job start; Android about 45s (including the `android-35` image download). Today's runner
  needs several minutes. Default `resource` capacity gives 1 iOS device on a hosted Mac and
  1 Android device on `ubuntu-latest`, the same as today's rule.
- **Both platforms, end to end through the gateway.**
  - **Leases.** HTTP lease, `exec` (`simctl launch`, `adb shell am start`) and release all work.
  - **agent-device.** `open`, `snapshot -i`, `press`, `screenshot` and `close` work for both
    platforms. Warm command latency was 1.5–2.6s (India ↔ US). Leases routed to the right
    worker, with `warm-hit` and `free-capacity` dispatch.
  - **Input** works on both platforms (`0x83`, then `0x82` with the screen size).
  - **Stream** works on Android, 720p at about 80 kbit/s mostly-idle. It works on iOS too, once
    the binary fix below is applied.
- **Cold boot times.**
  - Android Pixel 8: 74s.
  - iOS iPhone 17: 83s and 110s granted. **2 of 4 cold boots failed with `boot-timeout`**: the
    full-mode deadline is hard-coded at 120s (`BOOTSTATUS_TIMEOUT_MS`). Only slim mode has a
    configurable `ios.slim.bootTimeoutMs`.
  - One cold boot also starved the Mac enough that the **worker's uplink dropped** (reconnected
    within about 10s). The in-flight lease failed with `WORKER_UNREACHABLE`.
  - After a release, the wipe and re-boot take 40–50s before the device is warm again. Meanwhile
    the gateway sends new leases to another worker with a free slot, which means a cold boot.
- **Upstream bugs and missing pieces we must work around:**
  1. simlock 0.4.0's npm tarball ships `dist/bin/simlock-screen-capture` and
     `simlock-device-capture` **without the executable bit**, so the iOS stream fails with
     `EACCES` and iOS input is unavailable. Workaround: `chmod +x "$(npm root -g)"/simlock/dist/bin/*`.
     File upstream.
  2. `ubuntu-24.04` runners lack `libpulse0`, which the emulator needs even with
     `android.emulator.audio false` (`emulator -version` fails). Install it in `prepare`.
  3. A worker that fails every provision keeps getting requests: the tie-break picks the lowest
     worker id, and the gateway does not learn that the worker is broken. The runner must
     self-test (boot one device) **before** joining, and the API should drain a worker on
     repeated `PROVISION_FAILED`.
- **agent-device `open` blocks for the whole boot** (and the first iOS XCTest runner build, about
  40s). Through Cloudflare's proxy that request failed with **524 at 100s**. The lease still
  completed on the worker, and the session picked it up on the next `open`.
- **agent-device sessions:** the session name saved by `connect proxy` beat
  `AGENT_DEVICE_SESSION`. The CLI and skill must pass `--session` explicitly.

**Plan changes from S1:**

- The runner's `start` step boots the default device (and builds the XCTest runner on iOS)
  **before joining**. The sequence: start the worker standalone with `warmPool.targets`, wait for
  `ready`, then set `gateway` and restart the daemon (leases and devices survive a restart). The
  first lease is then a warm hit, and the 120s cold-boot limit and the uplink starvation stay off
  the agent's path.
- Ask upstream for a configurable full-mode boot timeout. Evaluate `ios.defaultMode slim`.
- `simbox sim` waits for a warm device of the platform, not just a connected worker.

### S2 Gateway host: partly done locally; the Cloudflare part still needs a real deploy

- **Token persistence works.** The sidecar snapshots only `state.db`, which holds tokens and
  worker pairing (about 49 KB base64), using `node:sqlite` `backup()`. A brand-new container
  restored from it accepts the same agent token as the same identity.
  - The snapshot is too big for a container env var (argument list too long). So the sidecar
    starts first, the DO POSTs `/restore`, and the sidecar then configures and starts the gateway.
- **Keep-alive.** `@cloudflare/containers` 0.3.7 counts an open proxied WebSocket as an in-flight
  request, so a connected worker keeps the container awake. WebSockets must be proxied inside the
  DO (`containerFetch`), not from the Worker.
- **Local `wrangler dev` isn't possible on this arm64 box.** Wrangler hard-codes `linux/amd64`
  image builds, npm segfaults under QEMU, and amd64 Node under QEMU hangs. Spike code:
  `/tmp/spike/cf` (Worker + `GatewayHost` DO + sidecar).
- **Still unverified, needs a real Cloudflare deploy:**
  - Worker → DO → container passing WebSocket `/v1/uplink` for more than 1h.
  - An idle response longer than 100s (agent-device `open`).
  - Small streamed bodies not being buffered. Through the quick tunnel, the low-bitrate iOS stream
    delivered **0 bytes in 75s** while the same stream fetched directly gave 35 KB in 40s.
  - Cold start time and container sleep.

### S3 Stream: answered

The body is `[u32 BE length][u8 tag][payload]`:

| Tag    | Payload                              |
| ------ | ------------------------------------ |
| `0x05` | JSON meta                            |
| `0x01` | avcC                                 |
| `0x02` | keyframe (length-prefixed AVCC NALs) |
| `0x03` | delta                                |
| `0x04` | seed                                 |
| `0x06` | keepalive                            |
| `0x07` | ended                                |

Captured Android and iOS streams parse cleanly. This feeds WebCodecs `VideoDecoder` without
rewriting anything. Simlock's console reader `ui/src/data/stream.ts` (458 lines, MIT) is the
reference to port. So D3(a) is cheap.

### S4 No gateway: client → runner's standalone daemon over a named tunnel: works

The question: drop the gateway. Each runner runs a **standalone** simlock daemon (HTTP on, port
4701, no `gateway` set). Our API only lists runs (URL plus agent token), and the CLI, agents and
dashboard talk to the run's daemon directly.

The setup:

- One remotely managed named tunnel per platform in `simboxtouchtech.dpdns.org`, set up the way
  `apps/api/src/tunnels.ts` does it (proxied CNAME, ingress to `http://127.0.0.1:4701`).
- The runner starts the daemon with `warmPool.targets` (one iPhone 17 or Pixel 8) and waits for
  `ready 1`. It then mints an agent token (`simlock token create --role agent`) and starts
  cloudflared.
- The client ran on this box (India); the runners were in the US. Runs 41199224922 and
  41200386572 on `rb-sim-test`.

| Check through the tunnel                       | Android                               | iOS                                            |
| ---------------------------------------------- | ------------------------------------- | ---------------------------------------------- |
| `GET /v1/healthz`                              | 0.8s                                  | 0.9s                                           |
| `GET /v1/catalog` (auth); without a token: 401 | 3.9s                                  | 3.5s                                           |
| Console `/` and its 1 MB JS bundle             | 200                                   | 200                                            |
| agent-device `open` on a warm device           | 6.9s                                  | 9.1s, or 26s with an app                       |
| agent-device `snapshot -i` / `screenshot`      | 3.1s / 4.5s                           | 1.5–2.4s / 6s, once the XCTest runner is built |
| HTTP lease on a warm device                    | granted in 0.3s                       | granted in 2.7s                                |
| Stream, idle for 75s                           | 469 KB, frame gap p50 0.10s           | 104 KB (about 1.4 KB/s), p50 0.27s, max 9.9s   |
| Stream while swiping (input socket, 17 swipes) | 1.5 MB in 60s, p50 57ms               | 675 KB in 60s, p50 119ms                       |
| Input socket                                   | `0x83` and `0x82` in 2.4s, 1005 close | `0x83` and `0x82` in 1.2s, 1005 close          |
| `DELETE /v1/leases/{id}`                       | 202                                   | 202                                            |

- **The named tunnel does not buffer the stream.** Tiny idle 10-second bins, down to a single
  10-byte keepalive, arrived on time. The low-bitrate iOS stream flowed. The 0-byte result in S2
  was the quick tunnel.
- **The 524 stays off the agent's path once a device is warm.** Every call was well under 100s.
  The one call that would have broken it was the first iOS `snapshot` while the XCTest runner
  was still building. It failed at agent-device's own 90s client timeout, and the next `open`
  took 26s. **So the runner's warm-up must also build the XCTest runner** (`open
com.apple.Preferences`, then `snapshot`), not just boot the device.
- **Cloudflare Browser Integrity Check** answers 403 (error 1010) to the `Python-urllib`
  User-Agent. agent-device, Node `fetch`/`WebSocket` and curl pass. Our CLI must send a real UA.
- **iOS on hosted Macs is the real risk, not the tunnel.**
  - In the first run (3-core `macos-latest`, CPU at 100%), four iPhone 17 boots in a row hit
    simlock's fixed 120s `BootTimeoutError`. `xcodebuild -version` and the host-load probe timed
    out. Then **all of cloudflared's QUIC connections timed out** ("no recent network activity"),
    and the tunnel answered 502.
  - The retry warmed in 77s with no failures, using `--protocol http2`.
  - Same pattern as the S1 uplink drop. Mitigations: cloudflared `--protocol http2`; the runner
    reports ready only once the warm pool is `ready` (and fails the run after N boot failures);
    the upstream boot-timeout ask from S1.
- **The token handoff works,** but for the spike it ran through an encrypted artifact. In the
  product the runner sends the agent token to our API in `register`, as it does today with its
  tunnel URL.

**What this means for the plan (if we choose no gateway):**

- The gateway, its hosting, sessions-to-JWT, worker tokens and the capacity alarm all go.
- The API keeps `runs` with `tunnel_*` plus an encrypted per-run agent token, and hands both to the
  owner's CLI and dashboard.
- `simbox sim` picks a run of the platform whose daemon has a free warm device (`GET
/v1/catalog` or status). If none, it dispatches a new run and waits for `ready`. It then runs
  `agent-device connect proxy --daemon-base-url https://<run>/v1/agent-device --session …`.
- The dashboard opens the run's own simlock console, or our panel reads `/v1/leases/{id}/stream`
  and `/input` from it.
- One run is about one device on hosted runners, so picking a run is the queue.

## Risks

- **iOS on 3-vCPU hosted Macs.** Simlock's full-mode boot deadline is a fixed 120s and a cold boot
  can starve cloudflared. Mitigations: warm before announcing, build XCTest in the warm-up,
  cloudflared over http2 at raised priority, fail the run after repeated boot failures. Ask
  upstream for a configurable full-mode boot timeout.
- **Simlock is young and moves fast.** Pin it exactly (`PINS.simlock`) and bump deliberately after
  an end-to-end run on both platforms.
- **One shared agent token per run.** All of the owner's clients count as one Simlock requester,
  hence `lease.maxPerRequester`. Clients cannot see each other's devices' secrets, but they can
  see each other's leases. That is the same trust boundary as today (one owner per run).
- **Cloudflare limits:** 524 after 100s of origin silence (kept off the path by warming), and Browser
  Integrity Check on odd User-Agents.
- **Second and later devices on a run boot cold** (Simlock boots them on lease). The first
  agent-device `open` for them can take over 100s on iOS; agent-device retries `open`.
- **Unverified until the first end-to-end run** (code assumes them; check in the run logs):
  Simlock accepts our catalog's iOS model names and OS versions in a warm target; Android
  avdmanager ids (`pixel_8`, `7.6in Foldable`) work as model aliases; `simbox exec`'s per-command
  `--daemon-base-url <tunnel>/v1/agent-device` works against Simlock's front; the
  `/v1/agent-device/health` body; whether Simlock's iOS stream is already rotated for landscape
  (the panel still applies its own rotation); `install` before the first `open`.
