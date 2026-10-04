# Simbox

Free on-demand iOS simulators & Android emulators running on your own GitHub Actions minutes, exposed to your local machine as an `agent-device` remote proxy.

**Plan:** [.plans/v1-plan.md](.plans/v1-plan.md)

## How it works

1. Sign in with GitHub on the dashboard, install the GitHub App, pick a repo.
2. We commit `.github/workflows/simbox.yml` to the repo and write a `SIMBOX_TOKEN` secret.
3. `simbox sim` asks our API for a run → we `workflow_dispatch` into your repo → a `macos-latest` runner boots `agent-device proxy` + a Cloudflare tunnel → the tunnel URL + daemon token come back to your CLI.
4. Drive sims/emulators with `simbox exec <agent-device command>` until the run ends (idle timeout, `simbox stop`, or ~6h).

## Use

```bash
npm i -g @touchtechclub/simbox agent-device@0.21.20
simbox login
simbox init
simbox sim
simbox exec devices
# Pick an exact device name/UDID from inventory (multiple iPhones are available).
simbox exec open com.apple.Preferences --platform ios --device "iPhone 17e"
simbox exec snapshot -i
simbox exec close --shutdown
simbox stop
```

`exec` supplies the daemon token and refreshes the tunnel URL before **each**
command. Its session is stable for the GitHub run, even if the tunnel restarts.
Cold `open`/`boot`/`prepare` commands get a five-minute startup budget; override
with `--timeout <ms>`. To use several sessions/devices, pass `--session <name>`
consistently to each command. Simbox never automatically replays device actions
after a transport failure: inspect with `simbox exec session list` first.
The runner streams JSON whitespace keepalives during RPCs so a cold boot does
not hit Cloudflare's idle-response timeout. Startup progress is buffered; the
final command result is returned when ready.
iOS prewarming is **off by default**: Android startup never depends on
CoreSimulator inventory or XCTest. Opt into best-effort iOS warmup with the
action's `warm_ios: "true"` input. Warmup failures are warnings, not fatal run
failures. The generated workflow uses stable `macos-latest`; preview-only device
types require opting into `xcode-27` in your repository's workflow.

Android AVD preparation runs in the background. `simbox exec ... --platform
android` waits for it before sending commands. `android_ready: yes` means the
SDK/emulator executable and AVD are installed **and the emulator has completed boot**:

```bash
simbox sim --new --json
simbox exec boot --platform android --device simbox --headless
simbox exec open com.android.settings --platform android --device simbox
simbox exec snapshot -i
```

Direct `agent-device` clients remain supported via the exports printed by
`simbox sim`, but must refresh those exports after a tunnel change. Simbox does
not edit agent-device's global configuration or existing proxy profiles.

## Monorepo

| Path              | What                                                                  |
| ----------------- | --------------------------------------------------------------------- |
| `apps/api`        | Cloudflare Worker (Hono + D1 + KV) — auth, repo connect, run registry |
| `apps/cli`        | `@touchtechclub/simbox` npm package — login/sim/exec/ps/stop/repair   |
| `apps/web`        | TanStack dashboard (Vite + Router + Query) — CF Pages                 |
| `packages/agent`  | `simbox-agent` Bun-compiled binary that runs inside the GH job        |
| `packages/shared` | API contracts, constants, canonical workflow YAML                     |
| `action-src`      | Source of the composite action published to `TouchTechClub/runner`    |

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
