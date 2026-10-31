# Simbox

Free on-demand iOS simulators & Android emulators running on your own GitHub Actions minutes. Each run is a [Simlock](https://incubator.callstack.com/simlock/) daemon your machine reaches with `agent-device`.

**Plan:** [.plans/v3-simlock.md](.plans/v3-simlock.md) (Simlock); [v1](.plans/v1-plan.md) for history.

## How it works

1. Sign in with GitHub on the dashboard, install the GitHub App, pick a repo.
2. We commit `.github/workflows/simbox.yml` to the repo and write a `SIMBOX_TOKEN` secret.
3. `simbox sim` asks our API for a run → we `workflow_dispatch` into your repo → your selected macOS/iOS or Linux/Android runner starts Simlock, which warms the requested device, behind the run's own Cloudflare tunnel → the tunnel URL + the run's Simlock token come back to your CLI.
4. Drive sims/emulators with `simbox exec <agent-device command>` until the run ends (idle timeout, `simbox stop`, or ~6h).

Several runs can be live at once: up to 5 iOS and 10 Android runs per account
(GitHub runs at most 5 macOS jobs at a time below Enterprise; extra jobs wait in
its queue). Each agent keeps the run `simbox sim` gave it. A small runner (4
vCPUs or fewer, which includes GitHub's hosted Macs) runs one device at a time,
so another agent gets a new run rather than a busy one. At the limit, agents
share the least busy run.

## Use

```bash
npm i -g @touchtechclub/simbox agent-device@0.21.35
simbox login
simbox init
simbox sim --platform ios --device "iPhone 16 Pro" --os 18.4  # or plain `simbox sim`
simbox exec open com.apple.Preferences --platform ios  # leases the warm device
simbox exec snapshot -i --platform ios
simbox exec close --platform ios   # releases it; Simlock wipes it for the next lease
simbox stop --platform ios   # or --all
```

`simbox ps` lists active runs and marks this agent's. `exec` and `stop` go to
this agent's run of `--platform`, else to the platform's only run. With both an
iOS and an Android run active, pass `--platform` on every command.
`SIMBOX_RUN=<id>` pins a shell to one run, and `simbox stop --run <id>` stops
one. An agent is identified by its thread or session (`T3CODE_THREAD_ID`,
`CLAUDE_CODE_SESSION_ID`), or by `SIMBOX_HOLDER`; a plain terminal is one
shared caller.

`--device` and `--os` (`18.4`, `18` for the newest 18.x, an Android API level,
`latest` or `oldest`) require `--platform`. `simbox devices list` shows the
models and OS versions a runner offers, once it has run in your repository; the
API rejects a combination that catalog cannot satisfy before dispatching. A
run's device is fixed: changing it (or the runner) needs `--new`.

`exec` supplies the run's token and refreshes the tunnel URL before **each**
command. Its session (`simbox-<run>-<agent>`) is stable for the GitHub run, even
if the tunnel restarts, and separate for each agent sharing the run. Cold
`open`/`boot`/`prepare` commands get a five-minute startup budget; override
with `--timeout <ms>`. To use several sessions/devices, pass `--session <name>`
consistently to each command. A run leases at most `maxDevices` devices at once. Simbox never automatically replays device actions
after a transport failure: inspect with `simbox exec session list` first. Only
read-only or absolute commands (`devices`, `snapshot`, `screenshot`, `fold`,
`session`, `appstate`, `apps`, `get`, `is`) are retried, up to twice, when the
tunnel drops.
Simlock leases, wipes and streams the devices. The run goes live only after
its device is warm and a full `open`/`snapshot`/`close` through Simlock has
passed; on iOS that also builds agent-device's XCTest runner, which adds a few
minutes to startup. A simulator's first boot
saturates the 3-vCPU hosted Macs for several minutes; commands sent during it
time out and the tunnel drops. So Simbox counts a run as full at one device per
4 vCPUs (at most 3) and sends other agents to another run; set `maxDevices` in a
JSON `--runner` to override, for example
`--runner '{"labels":["blacksmith-12vcpu-macos-latest"],"maxDevices":2}'`. The runner also turns off host Spotlight
indexing and raises cloudflared's priority. A device that does not warm, or a
failed self-test, fails the run. Android runs on Linux and never waits for iOS. iOS runs
default to GitHub's Xcode 27 image (`xcode-27`, a public preview) and use its
newest release Xcode; `--runner macos-latest` gives Xcode 26. A manual Actions
dispatch with empty `runner_labels` still uses `macos-latest`.

Android requires **Linux/KVM**: GitHub's ARM macOS VMs cannot initialize HVF
for the emulator, even when `-accel-check` reports success. Start with
`simbox sim --platform android`; `--new` starts another run.
Without a platform flag, `sim` reuses the only active run, else uses iOS.

Update the CLI and run `simbox repair` once (merge its PR if the branch is
protected) to install the current workflow. Runners whose agent predates
Simlock are refused with a message to repair. Repair rotates `SIMBOX_TOKEN`
only when no run is active.

`sim` and `exec` wait until `devices_ready: yes` (Simlock has a warm device)
before sending commands:

```bash
simbox sim --new --platform android --json
simbox exec open com.android.settings --platform android
simbox exec snapshot -i --platform android
simbox exec close --platform android
```

Direct `agent-device` clients remain supported via the exports printed by
`simbox sim`, but must refresh those exports after a tunnel change. Simbox does
not edit agent-device's global configuration or existing proxy profiles.

## Runners, devices, workflow and agent setup

Configure independent iOS/macOS and Android/Linux runners on the dashboard's
**Runners** page. New runs resolve **CLI override → repository override → account
default → GitHub default**. GitHub and Blacksmith presets plus custom labels are
supported; Blacksmith requires its App and separate billing. Device model and
OS defaults layer the same way, field by field. Settings affect only future runs
and survive `simbox repair`.

```bash
simbox runners set android blacksmith-4vcpu-ubuntu-2404 --scope account
simbox runners set ios macos-latest --scope repo
simbox runners show
simbox doctor
simbox sim --new --platform android --runner ubuntu-latest
simbox sim --new --platform ios --runner xcode-27 --xcode 27.1 --foldable
simbox devices list --platform ios   # catalog the runner reported on its last run
simbox devices set android --device pixel_8 --os 35 --scope account
simbox workflow add --name Checkout --uses actions/checkout@v4  # default: before start
simbox workflow show
simbox skills install  # asks current project vs global, then agent selection
```

`.github/workflows/simbox.yml` has three locked steps (prepare → start → serve);
your own steps can run before, between or after them. Edit them in the
dashboard or with `simbox workflow`; saving needs push access and commits to the
default branch, or opens a PR when it is protected.

Upgrade older workflows with `simbox repair` once (merge its PR if needed) before
using runner-aware dispatch. Custom runners must be Linux x64/KVM or macOS
ARM64/Xcode with the documented tools. Simbox never silently falls back to
another runner. For automation: `simbox skills install --project --agent codex
--yes`. Direct installation: `bunx skills add TouchTechClub/simbox --skill simbox`.

Details: [runners, devices, workflow and skills](docs/RUNNERS-AND-SKILLS.md).

## Live device panel

On a live run, open **Dashboard → Devices → Open device panel** to see the
run's leased devices with live H.264 video from Simlock. Enable control
explicitly for tap/drag, keyboard and navigation buttons; screenshots and
fullscreen are available too. The API proxies Simlock's lease stream and input
socket with the run's token. Preview routes are authenticated and viewing
doesn't reset the runner idle timer. The panel needs H.264 WebCodecs on
HTTPS/localhost.
See [device previews](docs/DEVICE-PREVIEWS.md) for details and rollout requirements.

## S5 Code integration

Enable device support and agent device access in S5 Code, and log in to Simbox
on the same machine and user account as its environment server. An agent's
`simbox sim` command automatically attaches the runner's device to its thread;
successful `simbox exec` commands attach a selected or running device too.
Keep command output visible to the agent so S5 can detect the registration.
The panel supports live video and input. Sessions disappear when the run ends
or the agent runs `simbox stop`.

This requires the updated Simbox CLI, runner binary, and S5 Code server.

## Monorepo

| Path              | What                                                                    |
| ----------------- | ----------------------------------------------------------------------- |
| `apps/api`        | Cloudflare Worker (Hono + D1 + KV) — auth, repo connect, run registry   |
| `apps/cli`        | `@touchtechclub/simbox` npm package — sim/exec/ps/stop/devices/workflow |
| `apps/web`        | TanStack dashboard (Vite + Router + Query) — CF Pages                   |
| `packages/agent`  | `simbox-agent` Bun-compiled binary that runs inside the GH job          |
| `packages/shared` | API contracts, constants, workflow spec + YAML renderer                 |
| `action-src`      | Source of the composite action published to `TouchTechClub/runner`      |

## Develop

```bash
bun install
bun run typecheck        # all packages
bun run dev:api          # wrangler dev (needs .dev.vars, see apps/api/.dev.vars.example)
bun run dev:web          # vite dev on :5173, proxies /v1 → :8787
bun run --cwd apps/cli dev -- <command>   # run CLI from source
```

## Deploy

Full setup: [docs/DEPLOY.md](docs/DEPLOY.md) — GitHub App creation, Alchemy infra (`bun run deploy` in `packages/infra`), custom domains, CLI publish, action repo + agent release.
