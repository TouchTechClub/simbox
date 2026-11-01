# TouchTechClub/runner — composite action

Boots on-demand iOS simulators (macOS) and Android emulators (Linux/KVM) on a
GitHub Actions job, exposes them through a Cloudflare tunnel, and lets
you drive them from your local machine with
[`agent-device`](https://oss.callstack.com/agent-device).

This repo contains only the composite action that gets published as
`TouchTechClub/runner`. The source of truth lives in the `simbox` monorepo
(`action-src/`) — this directory is synced here verbatim.

## Usage

This workflow is normally installed for you (`simbox init` commits
`.github/workflows/simbox.yml` to your repo, and the dashboard or
`simbox workflow` edits it). It runs the action three times, so your own steps
can run between the stages:

```yaml
name: simbox
run-name: "simbox ${{ inputs.platform }} ${{ inputs.simbox_run }}"
on:
  workflow_dispatch:
    inputs:
      platform:
        type: choice
        options: [ios, android]
        default: ios
      runner_labels:
        type: string
        default: ""
      simbox_run:
        type: string
        default: ""

jobs:
  simbox:
    runs-on: ${{ fromJSON(inputs.runner_labels || (inputs.platform == 'android' && '["ubuntu-latest"]' || '["macos-latest"]')) }}
    timeout-minutes: 360
    steps:
      - uses: TouchTechClub/runner@v1
        with:
          step: prepare
          platform: ${{ inputs.platform }}
      - uses: TouchTechClub/runner@v1
        with:
          step: start
          platform: ${{ inputs.platform }}
          token: ${{ secrets.SIMBOX_TOKEN }}
          run_id: ${{ inputs.simbox_run }}
      # Devices are booted but not reachable yet: install apps, seed data...
      - uses: TouchTechClub/runner@v1
        with:
          step: serve
          platform: ${{ inputs.platform }}
```

Without `step`, the action does everything in one step (`step: all`), exactly
as older workflows expect:

```yaml
- uses: TouchTechClub/runner@v1
  with:
    token: ${{ secrets.SIMBOX_TOKEN }}
    platform: ${{ inputs.platform }}
```

Then from your machine:

```bash
npx @touchtechclub/simbox login
npx @touchtechclub/simbox sim          # waits for run AND tunnel readiness
npx @touchtechclub/simbox exec devices
npx @touchtechclub/simbox exec open <app> --platform ios --udid <udid-from-inventory>
```

For Android, run `simbox repair` once after upgrading, then
`simbox sim --new --platform android --json`. This selects Linux/KVM and waits
for the headless emulator to finish booting; hosted ARM Macs cannot initialize
HVF for Android. Control it with `simbox exec open com.android.settings --platform
android --device simbox`, followed by `simbox exec snapshot -i`.

## Inputs

`platform` optionally declares `ios` or `android` (empty infers the host).
The prepare stage fails before binary download on the wrong OS/architecture or
missing tools. Linux requires x64/KVM/Java/Android SDK command-line tools; macOS
requires ARM64/Xcode. Existing KVM access is preserved; otherwise passwordless
sudo is required to grant it. See [runner settings](../docs/RUNNERS-AND-SKILLS.md)
for account defaults, repository overrides, Blacksmith prerequisites and custom labels.

| Input      | Required   | Default                             | Description                                                    |
| ---------- | ---------- | ----------------------------------- | -------------------------------------------------------------- |
| `step`     | no         | `all`                               | `prepare`, `start`, `serve`, or `all` (one step)               |
| `token`    | start, all | —                                   | `SIMBOX_TOKEN` repo secret                                     |
| `run_id`   | no         | `""`                                | Run id Simbox dispatched (`simbox_run`); empty for manual runs |
| `platform` | no         | `""`                                | `ios` or `android`; empty infers the host                      |
| `api_url`  | no         | `https://api.simbox.touchtech.club` | API base URL (staging override)                                |
| `version`  | no         | this action's release tag           | Agent release to download; must match the embedded sha256      |
| `warm_ios` | no         | `false`                             | Ignored since v0.4.10: iOS runs always warm before going live  |

## What the stages do

- **prepare** checks the runner, downloads `simbox-agent-darwin-arm64.tar.gz` or
  `simbox-agent-linux-amd64.tar.gz` from the pinned `TouchTechClub/simbox`
  release (`version` input) into `$RUNNER_TEMP/simbox`, verifies its sha256
  against the digest embedded in this `action.yml` (`shasum -a 256 -c`), and
  records the job's start time for the agent's hard-exit clock.
- **start** launches `simbox-agent` in the background. It reads the run's
  platform and device from the API, installs `simlock`, `agent-device` and
  `cloudflared` (versions pinned in the binary; Android also needs
  `libpulse0`, which **prepare** installs), configures one Simlock warm target
  for the requested device and starts the Simlock daemon on `127.0.0.1:4701`.
  Once a device is warm it runs an `open`/`snapshot`/`close` self-test through
  Simlock (on iOS this builds the XCTest runner) and mints the run's Simlock
  agent token. A requested device or OS the runner cannot provide fails the
  step with the list of what it offers; so does a device that never warms.
  The step streams the agent's log and finishes once the device is warm;
  nothing is reachable yet.
- **serve** lets the agent open the tunnel and register `tunnel_url` + a
  per-run `daemon_token` with the API over TLS (`Authorization: Bearer
SIMBOX_TOKEN`) — neither ever hits the logs. It streams the agent's log until
  the run ends, forwards cancellation to the agent so it can deregister, and
  exits with the agent's exit code.
- **all** does all of the above in one step.

While serving, the agent heartbeats every 60s with Simlock's lease count and
restarts the daemon or tunnel if either dies. It exits after 15 min with no
lease and no queued lease request, or 5h45m after the job started (clean shutdown before GitHub's 6h
limit → green checkmark), or with exit 0 when the run is stopped from Simbox.

## Security notes

- `SIMBOX_TOKEN` is a repo secret — GitHub masks it automatically.
- The tunnel URL and the Simlock agent token are minted in-runner, masked via
  `::add-mask::`, and only ever sent to the API inside the TLS body.
- `SIMBOX_TOKEN` stays in the agent process: npm, Simlock, agent-device,
  cloudflared, the emulator and your own steps never receive it from the agent.
- The agent tarball is sha256-pinned here; `simlock`/`agent-device`/`cloudflared`
  versions are pinned in the agent's `src/pins.ts`.
- Each run has its own named tunnel, deleted when the run ends. Everything
  under Simlock's `/v1` except `/v1/healthz` also requires the run's agent
  token, which Simlock checks.

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
