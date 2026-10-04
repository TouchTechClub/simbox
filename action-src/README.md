# TouchTechClub/runner — composite action

Boots on-demand iOS simulators and Android emulators on a `macos-latest`
GitHub Actions job, exposes them through a Cloudflare quick tunnel, and lets
you drive them from your local machine with
[`agent-device`](https://oss.callstack.com/agent-device).

This repo contains only the composite action that gets published as
`TouchTechClub/runner`. The source of truth lives in the `simbox` monorepo
(`action-src/`) — this directory is synced here verbatim.

## Usage

This step is normally installed for you (`simbox init` commits
`.github/workflows/simbox.yml` to your repo). Manually:

```yaml
name: simbox
on:
  workflow_dispatch:

jobs:
  simbox:
    runs-on: macos-latest
    timeout-minutes: 350
    steps:
      - name: Simbox agent
        uses: TouchTechClub/runner@v1
        with:
          token: ${{ secrets.SIMBOX_TOKEN }}
```

Then from your machine:

```bash
npx @touchtechclub/simbox login
npx @touchtechclub/simbox sim          # waits for run AND tunnel readiness
npx @touchtechclub/simbox exec devices
npx @touchtechclub/simbox exec open <app> --platform ios --udid <udid-from-inventory>
```

## Inputs

| Input     | Required | Default                             | Description                                  |
| --------- | -------- | ----------------------------------- | -------------------------------------------- |
| `token`   | yes      | —                                   | `SIMBOX_TOKEN` repo secret                   |
| `api_url` | no       | `https://api.simbox.touchtech.club` | API base URL (staging override)              |
| `version` | no       | `v1`                                | Release tag of the agent tarball to download |

## What the step does

1. Downloads `simbox-agent-darwin-arm64.tar.gz` from the pinned
   `TouchTechClub/simbox` GitHub release (`version` input).
2. Verifies its sha256 against the digest embedded in this `action.yml`
   (`shasum -a 256 -c`) — fails the job on mismatch.
3. Untars and runs `simbox-agent`, which:
   - installs `agent-device` + `cloudflared` (versions pinned in the binary),
   - preps an Android AVD in the background (`android_ready` in heartbeats),
   - starts `agent-device proxy` on `127.0.0.1:4311`, with an activity-aware
     gateway on `127.0.0.1:4310` behind a trycloudflare tunnel,
   - registers `tunnel_url` + a per-run `daemon_token` with the API over TLS
     (`Authorization: Bearer SIMBOX_TOKEN`) — neither ever hits the logs,
   - waits for a healthy local proxy before registration; the CLI checks public tunnel readiness,
   - heartbeats every 60s; authenticated in-flight RPCs postpone idle exit
     (each request is bounded to 10 minutes); exits after 15 min idle or 5h45m uptime (clean
     shutdown before GitHub's 6h limit → green checkmark).

## Security notes

- `SIMBOX_TOKEN` is a repo secret — GitHub masks it automatically.
- The tunnel URL and daemon token are minted in-runner, masked via
  `::add-mask::`, and only ever sent to the API inside the TLS body.
- The agent tarball is sha256-pinned here; `agent-device`/`cloudflared`
  versions are pinned in the agent's `src/pins.ts`.
- The tunnel is unguessable (`*.trycloudflare.com`) and every proxied command
  additionally requires the per-run daemon token.

## Releasing

From the monorepo:

```bash
# bump packages/agent/package.json version + src/pins.ts first
action-src/release.sh 0.2.0
```

`release.sh` builds the darwin-arm64 binary, creates
`simbox-agent-darwin-arm64.tar.gz`, re-renders `action.yml` with the real
sha256, and prints the `gh release` + git commands to publish both the
release asset and this action repo.
