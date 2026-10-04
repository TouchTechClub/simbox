# Simbox

Free on-demand iOS simulators & Android emulators running on your own GitHub Actions minutes, exposed to your local machine as an `agent-device` remote proxy.

**Plan:** [.plans/v1-plan.md](.plans/v1-plan.md)

## How it works

1. Sign in with GitHub on the dashboard, install the GitHub App, pick a repo.
2. We commit `.github/workflows/simbox.yml` to the repo and write a `SIMBOX_TOKEN` secret.
3. `simbox sim` asks our API for a run → we `workflow_dispatch` into your repo → a `macos-latest` runner boots `agent-device proxy` + a Cloudflare tunnel → the tunnel URL + daemon token come back to your CLI.
4. Drive sims/emulators with `agent-device` until the run ends (idle timeout, `simbox stop`, or ~6h).

## Monorepo

| Path              | What                                                                  |
| ----------------- | --------------------------------------------------------------------- |
| `apps/api`        | Cloudflare Worker (Hono + D1 + KV) — auth, repo connect, run registry |
| `apps/cli`        | `simbox` npm package — login/sim/ps/stop/repair                       |
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
