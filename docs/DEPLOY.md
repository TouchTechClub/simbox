# Simbox — Deployment Setup

Everything needed to go from this repo to production. Order matters — GitHub App first (it produces most of the env values).

---

## 1. GitHub App

Create at <https://github.com/settings/apps/new> (name suggestion: `simbox`).

| Field                                                  | Value                                                                                             |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Homepage URL                                           | `https://simbox.touchtech.club`                                                                   |
| Callback URL                                           | `https://api.simbox.touchtech.club/api/auth/callback/github`                                      |
| Setup URL                                              | `https://simbox.touchtech.club/onboarding` (redirect on install ✓)                                |
| Webhook URL                                            | `https://api.simbox.touchtech.club/webhooks/github`                                               |
| Webhook secret                                         | generate: `openssl rand -hex 32` → `GITHUB_WEBHOOK_SECRET`                                        |
| Request user authorization (OAuth) during installation | ✓ enabled                                                                                         |
| Description (markdown, shown on install page)          | Tells users: **install on a NEW, EMPTY repository only** — see `scripts/simbox-app-manifest.html` |

**Permissions (Repository):**

- `Contents` → Read & write
- `Workflows` → Read & write _(required to commit .github/workflows/\*)_
- `Actions` → Read & write
- `Secrets` → Read & write
- `Metadata` → Read (automatic)

**Subscribe to events:** `workflow_run` (+ `installation` / `installation_repositories` — these are account-level events every app receives implicitly; they're not selectable in the manifest but the webhook deliveries still arrive at our endpoint)

**Collect after creation:**

- App ID → `GITHUB_APP_ID`
- OAuth Client ID + Client secret (App page → "Client secrets") → `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` _(these double as the better-auth GitHub provider)_
- Generate a **Private key** (PEM download) → `GITHUB_APP_PRIVATE_KEY`

> Local domains work for dev too — create a _second_ dev App with callback `http://localhost:8787/api/auth/callback/github` if you want full auth locally.

---

## 2. Cloudflare

One-time:

```bash
cd packages/infra
bunx alchemy profile edit        # or export CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID
cp .env.example .env             # fill values below
```

### `packages/infra/.env`

```bash
# --- from GitHub App ---
GITHUB_APP_ID=1234567
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
GITHUB_WEBHOOK_SECRET=          # openssl rand -hex 32
GITHUB_CLIENT_ID=Iv1.xxxxxxxxxxxxxxxx
GITHUB_CLIENT_SECRET=           # openssl rand -hex 32 works for BETTER_AUTH_SECRET too

# --- generated ---
BETTER_AUTH_SECRET=             # openssl rand -base64 32

# --- after first deploy (see §3) ---
APP_URL=                        # leave empty for first deploy → set to web URL → redeploy

# --- never in prod ---
DEMO_MODE=false
```

Alchemy provisions automatically: D1 `simbox-db` (migrations from `packages/db/migrations` apply on deploy), KV `simbox-kv`, Worker `simbox-api`, Website `simbox-web`.

```bash
bun run deploy                   # in packages/infra (or root)
# → prints api + web URLs
```

### Chicken-and-egg (one-time)

`APP_URL` must equal the web origin for CORS + OAuth, but it's only known after deploy. So:

1. `bun run deploy` → note the printed `web` URL
2. Set `APP_URL=https://<web-url>` in `.env` (or add custom domain first — below)
3. `bun run deploy` again

---

## 3. Domains

Default deploy lands on `*.workers.dev` / `*.pages.dev`-style URLs. For the real product:

| Domain                      | Points to            |
| --------------------------- | -------------------- |
| `simbox.touchtech.club`     | `simbox-web` website |
| `api.simbox.touchtech.club` | `simbox-api` worker  |

Add as custom domains in the CF dashboard (or `Cloudflare.Domain` resources in `alchemy.run.ts`), then set `APP_URL=https://simbox.touchtech.club` and update `PROD_API_URL` in `packages/shared/src/constants.ts` + `API_URL` var → `https://api.simbox.touchtech.club`, redeploy.

**GitHub App callback + webhook URLs** must match the final API domain — update them in App settings if you add `api.simbox.touchtech.club`.

---

## 4. CLI publish

```bash
cd apps/cli
npm publish --access public     # first publish of @touchtechclub/simbox must be manual (trusted publishing needs the package to exist)
```

CLI defaults to `PROD_API_URL`; users can override via `SIMBOX_API_URL` / `SIMBOX_WEB_URL` env.

Use `simbox exec <agent-device command>` for device operations. It injects the
per-run daemon token, resolves the latest tunnel on each command, and uses a
stable run-scoped session in Simbox's own state directory (without modifying
agent-device global/proxy profiles). Cold startup gets a 300000 ms budget.
Clients should use `agent-device@0.21.20`, matching the runner pin. Existing
runs keep the old agent until stopped/recreated after a release.

---

## 5. Action repo + agent release

The committed workflow uses `TouchTechClub/runner@v1` — needs a real repo:

```bash
# 1. Create github.com/TouchTechClub/simbox, push this monorepo there
git remote add origin git@github.com:TouchTechClub/simbox.git && git push -u origin main

# 2. Create github.com/TouchTechClub/runner, push action-src/ contents there
#    (action.yml at repo root), tag it:
cd action-src && git init && git add -A && git commit -m "v1" \
  && git remote add origin git@github.com:TouchTechClub/runner.git && git push -u origin main \
  && git tag v1 && git push origin v1

# 3. Build + publish the agent release (darwin-arm64 — run on a Mac or macOS CI)
cd action-src && ./release.sh 1.0.0
#    → builds packages/agent, tars, computes sha256, re-renders action.yml,
#      prints gh release commands for TouchTechClub/simbox/releases/tag/v1
```

---

## 6. Local development

`apps/api/.dev.vars` (gitignored):

```bash
APP_URL=http://localhost:5173
API_URL=http://localhost:8787
GITHUB_APP_ID=            # dev app
GITHUB_APP_PRIVATE_KEY=
GITHUB_WEBHOOK_SECRET=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
BETTER_AUTH_SECRET=       # any 32+ char string
DEMO_MODE=true            # bypasses auth, seeds fake repo+live run — preview only
```

```bash
bun run dev:api           # wrangler dev :8787 (auto-applies drizzle migrations)
bun run dev:web           # vite :5173, proxies /api/auth + /v1 → :8787
```

---

## 7. CI releases (tag → deploy everything)

`.github/workflows/release.yml` — `git tag v0.2.0 && git push origin v0.2.0` runs:
quality (typecheck+lint) → agent build+GH release (macos) → alchemy deploy → npm publish → TouchTechClub/runner action.yml update + `v1` retag.

### GitHub repo → Settings → Secrets and variables → Actions

**Secrets** (`production` environment for deploy job, `npm` environment for cli job, or repo-level — GH falls back):

| Secret                              | Value                                                                                                            |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`              | CF API token — Workers + D1 + KV + (zone DNS + Workers Routes for custom domains)                                |
| `ALCHEMY_STATE_STORE_CREDENTIALS`   | contents of `~/.alchemy/credentials/default/cloudflare-state-store.json` after your first local `alchemy deploy` |
| `GH_APP_ID`                         | `5036209` — `GITHUB_` prefix is reserved, hence `GH_`                                                            |
| `GH_APP_PRIVATE_KEY`                | full PEM (literal newlines OK in secrets)                                                                        |
| `GH_WEBHOOK_SECRET`                 | app webhook secret                                                                                               |
| `GH_CLIENT_ID` / `GH_CLIENT_SECRET` | app OAuth creds                                                                                                  |
| `BETTER_AUTH_SECRET`                | `openssl rand -base64 32`                                                                                        |

No PAT needed — the `runner` job mints an installation token via `actions/create-github-app-token` using the app's own creds. **One-time manual step: install the `simbox` GitHub App on `TouchTechClub/runner`** so the token can write there.

**Variables:**

| Var                     | Value                                                                |
| ----------------------- | -------------------------------------------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID` | CF dashboard → account ID                                            |
| `APP_URL`               | `https://simbox.touchtech.club` (or workers.dev URL until DNS lands) |

### npm trusted publisher

npmjs.com → `@touchtechclub/simbox` package → Settings → Trusted Publisher:

- Org: `TouchTechClub`, repo: `simbox`, workflow: `release.yml`, environment: `npm`

## Deploy gotchas (hit once, documented)

- **CF token**: `Workers Editor` role alone cannot create worker scripts (`PUT /workers/scripts` → 403 while D1/KV succeed). Use the **Edit Cloudflare Workers** template or add `Workers Scripts → Edit` explicitly.
- **State-store 401**: `~/.alchemy/credentials/default/cloudflare-state-store.json` must contain `accountId` matching `CLOUDFLARE_ACCOUNT_ID`. Creds minted before `accountId` existed (or for another account) trigger a re-derive that 401s on the state-store worker's refresh endpoint — delete/invalidate them (add `accountId`) or bootstrap fresh.
- **vite ≥ 8**: `@alchemy.run/cloudflare-runtime` extends `vite.DevEnvironment` (vite 8 only). If `bun install` leaves a stale per-package `vite` symlink in `node_modules/.bun/<pkg>/node_modules/`, delete it and reinstall.
- **`_redirects`**: don't ship a Pages-style `/* /index.html 200` file — workers static-assets validation rejects it as an infinite loop. `notFoundHandling: "single-page-application"` in `alchemy.run.ts` already provides SPA fallback.
- **Pinned resource names are load-bearing**: Alchemy's auto-generated physical names embed the deploying OS **username** (plus stage + a random instanceId). Deploying the same stack from a different identity — e.g. `ubuntu` locally vs `runner` in CI — forks a parallel stack: new workers, and a **fresh empty D1/KV**, plus orphaned state records under `simbox/live_<user>/`. That's why `alchemy.run.ts` pins `name`/`title` (`simbox-api`, `simbox-web`, `simbox-db`, `simbox-kv`) and manages `domain` on the workers. Never unpin or rename them — rename = resource replace (D1 data loss).
- **Renaming an existing auto-named resource**: the old worker still holds the custom domain, and alchemy refuses to steal it — delete the old worker script first (`DELETE /workers/scripts/:id`), then redeploy. After a _failed_ deploy, `alchemy state` may believe a resource exists that was rolled back; check with `alchemy state read <path>` and `state delete` the stale record before redeploying (hit this with `simbox-db`).

---

## Env var reference (API worker)

| Var                      | Source                    | Purpose                           |
| ------------------------ | ------------------------- | --------------------------------- |
| `GITHUB_APP_ID`          | App settings              | installation tokens               |
| `GITHUB_APP_PRIVATE_KEY` | App → private key (PEM)   | App JWT signing                   |
| `GITHUB_WEBHOOK_SECRET`  | you generate              | `X-Hub-Signature-256` verify      |
| `GITHUB_CLIENT_ID`       | App → OAuth               | better-auth github provider       |
| `GITHUB_CLIENT_SECRET`   | App → client secrets      | token exchange                    |
| `BETTER_AUTH_SECRET`     | `openssl rand -base64 32` | session signing                   |
| `APP_URL`                | web origin                | CORS + trustedOrigins + redirects |
| `API_URL`                | worker URL (auto)         | better-auth baseURL               |
| `DEMO_MODE`              | —                         | dev-only seeding, `false` in prod |

Bindings (auto-provisioned by alchemy): `DB` (D1), `KV`.
