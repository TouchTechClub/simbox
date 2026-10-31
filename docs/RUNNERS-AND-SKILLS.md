# Runners, devices, workflow and agent setup

## Runner defaults and overrides

Runner precedence for **new runs**:

1. `simbox sim --platform <platform> --runner <label-or-json>`
2. Connected repository override
3. Simbox account default
4. Simbox default (`ubuntu-latest` / `xcode-27`, GitHub's Xcode 27 preview image)

Configure Android/Linux and iOS/macOS independently on the dashboard's **Runners**
page, or through the CLI:

```bash
simbox runners presets
simbox runners set android blacksmith-4vcpu-ubuntu-2404 --scope account
simbox runners set ios blacksmith-6vcpu-macos-latest --scope repo
simbox runners set android '["self-hosted","linux","x64","kvm"]' --scope repo
simbox runners show --json
simbox runners reset android --scope repo  # inherit account default
simbox runners reset android --scope account  # inherit GitHub default
simbox sim --new --platform android --runner ubuntu-latest
```

Account means your **Simbox user account**, not a GitHub organization. Defaults
survive repository disconnects. Repository overrides are attached to the current
connected repository; this release does not add multiple simultaneous repositories.
Repair updates the workflow/secret without clearing either settings layer.

A platform can have several active runs (up to 5 iOS, 10 Android), and iOS and
Android runs are independent. Each caller (an agent thread or session, or
`SIMBOX_HOLDER`) keeps the run `sim` gave it; a plain terminal is one shared
caller. Settings never migrate an active run. `sim` reuses the caller's run of
that platform (plain `sim`: the platform of its runs, otherwise iOS) even if
defaults have changed. Otherwise it joins a run with a free device slot, or starts
one. A run holds one device per 4 vCPUs (at most 3; GitHub's hosted Macs hold
one, Android always one); `{"labels":[...],"maxDevices":N}` overrides it. A run
whose runner or device does not match an explicit `--runner`/`--device` is
skipped. `--new` always starts another run and retires only the caller's runs
that are still starting. At the limit, `sim` shares the least busy run, and
`sim --new` fails with `run_limit`. History and `ps` record the selected runner
and device, not a newly resolved default. Historical runs without recorded labels
are marked unknown.

### Workflow upgrade

Run `simbox repair` **once after upgrading** to install the current workflow
(`runner_labels` and `simbox_run` inputs, staged steps); merge the generated PR if
the default branch is protected. Repair re-renders your saved steps, and rotates
`SIMBOX_TOKEN` only when no run is active. The API always dispatches the exact
labels selected for the run and passes the run id as `simbox_run`, which appears
in the Actions run name. Older workflows without `simbox_run` still work, one
platform at a time: starting the other platform returns a repair error rather
than guessing which job is which. Manual Actions dispatch can leave
`runner_labels` and `simbox_run` empty to use the platform default.

### Providers and custom runners

- GitHub Ubuntu x64 and macOS ARM64 remain defaults.
- Blacksmith presets include Ubuntu 24.04 x64 (2/4/8 vCPU) and macOS ARM64
  (6/12 vCPU). Install the [Blacksmith App](https://docs.blacksmith.sh/blacksmith-runners/overview)
  on every target repository first. Its billing is separate; labels do not create
  a provider account or prove the repository has access. There is no paid/free fallback.
- Custom input is a single label or JSON array of labels. All labels must match
  the runner. Expressions, shell commands, YAML and runner-group objects are not accepted.
- Linux x64 needs KVM, Java, Node/npm, curl, tar, shasum, and an installed Android
  SDK with command-line tools. The runner user must have `/dev/kvm` read/write
  access, or passwordless sudo to grant it. Android ARM, macOS Intel, Windows,
  and container-only Ubuntu images are not supported in this release.
- macOS ARM64 needs Xcode with Simulator support plus Node/npm/curl/tar/shasum.
  The action checks host OS/architecture against the requested platform before
  downloading binaries. Emulator acceleration is checked during provisioning, and
  Android needs `libpulse0` (the action installs it with passwordless sudo).
- Self-hosted runners must be trusted and appropriately isolated: the action
  receives repository/run credentials. Ensure outbound HTTPS and Cloudflare
  tunnel connectivity. A nonexistent label can remain queued; Simbox's startup
  timeout points to the Actions job and never substitutes a different target.

`simbox doctor` checks local tools, configuration and the installed workflow
without starting a paid job; actual KVM/Xcode capability is checked on the runner.

## Devices and OS versions

`--device` picks a simulator or emulator model and `--os` its version: an iOS
runtime (`18.4`, or `18` for the newest 18.x), an Android API level (`35`), or
`latest`/`oldest`. Both require `--platform`.

```bash
simbox devices list                      # both platforms, effective runners
simbox devices list --platform android --runner blacksmith-4vcpu-ubuntu-2404
simbox sim --new --platform ios --device "iPhone 16 Pro" --os 18.4
simbox sim --new --platform android --device pixel_8 --os latest
simbox devices set ios --device "iPhone 16 Pro" --scope account
simbox devices set ios --os 18 --scope repo   # keeps the account's model
simbox devices reset ios --scope repo         # inherit the account default
```

`devices list` shows the catalog a runner last reported (models, OS versions,
Xcode versions). Each run reports it, so a runner has no catalog until its first
run in your repository. The API checks a requested device against that catalog
and rejects an unavailable model/OS/Xcode with the runner's options before
dispatching; without a catalog the runner checks it and fails its start step
with the same list.

Defaults layer like runners — CLI flag → repository → account → runner default —
but **field by field**: a repository OS keeps the account's model and vice versa.
A model and `--foldable` are alternatives; the higher layer wins. Xcode is chosen
per run with `--xcode`, never as a default. `runners show` prints the effective
defaults; `ps` prints each run's requested and booted device.

## Workflow steps

`.github/workflows/simbox.yml` is rendered from a list of steps. Three are locked
and always run in order: **prepare** (check the runner, download the agent),
**start** (start Simlock and warm the device; nothing is reachable yet) and **serve** (open the
tunnel and serve until the run ends). Your steps can go before `start` (checkout,
build), between `start` and `serve` (prepare the runner while the device is
warm) or after `serve` (runs once the session ends).

```bash
simbox workflow show                     # --yaml for the rendered file
simbox workflow add --name Checkout --uses actions/checkout@v4
simbox workflow add --name "Install app" --run "./scripts/install.sh" \
  --platform android --after start
simbox workflow move install-app --before serve
simbox workflow remove install-app
simbox workflow edit                     # all steps as JSON in $VISUAL/$EDITOR
simbox workflow apply steps.json         # {steps, permissions?}
```

`add` defaults to before `start`; `--platform` limits a step to one platform and
`--if`, `--env`, `--with` (for `--uses`) work as in GitHub Actions. Edits are also
available in the dashboard. Steps run with the repository's secrets, so saving
requires push access to the repository. A save commits to the default branch, or
opens/updates a `simbox-setup` PR when it is protected; the repository stays
usable with the committed workflow while the change is pending. Direct edits to
the file on GitHub are replaced the next time Simbox saves or repairs it.

## Foldables

`--foldable` prepares a foldable device instead of the default phone (it can
also be a default: `simbox devices set <platform> --foldable`); `--xcode` selects
an installed Xcode before Simlock starts. Both require `--platform` and
are fixed for the life of a run, so changing them needs `--new`.

```bash
simbox sim --new --platform ios --runner xcode-27 --xcode 27.1 --foldable
simbox sim --new --platform android --foldable
simbox exec fold closed      # or half-open / open
```

- **iOS** warms an iPhone Duo. It needs Xcode 27.1 or later; GitHub's
  `xcode-27` image is a preview and can queue slowly. That image ships only the
  iOS 27.0 simulator runtime, so the runner downloads the 27.1 runtime first,
  which adds several minutes to startup. Without `--xcode`, the newest
  installed Xcode that has the iPhone Duo is used.
- **Android** warms the SDK's generic 7.6in Foldable (1768x2208 with a hinge
  sensor and closed, half-open and open postures). The hosted command-line
  tools have no `pixel_fold` profile; Simbox uses it when the SDK provides one.
  Folding commits the device state apps observe (Jetpack WindowManager posture
  and hinge angle), but this profile has no separate cover display, so
  screenshots stay 1768x2208 in every pose.
- `fold` needs agent-device 0.21.35 on the client on the client and an open session.
  It reads the hinge angle back after each pose. On the busy xcode-27 image
  devicectl sometimes answers "no display table" or times out; setting a pose
  is idempotent, so retry it.

## Small agent skill

The skill lives at `skills/simbox/SKILL.md`. It covers setup, runner and device
selection, concurrent iOS/Android runs, workflow steps, app smoke tests,
credential hygiene, uncertain-outcome recovery and cleanup.
It complements—not duplicates—the agent-device command documentation.

```bash
simbox skills install  # asks current project vs global, then official installer prompts
simbox skills install --project --agent claude-code codex
simbox skills install --global --agent codex --yes
simbox skills install --project --agent codex --dry-run

# Direct skills.sh ecosystem installation (requires Bun):
bunx skills add TouchTechClub/simbox --skill simbox
```

Simbox invokes the official `skills` CLI through `bunx` without a shell and does
not maintain its own agent-path mapping. Project means the caller's current
working directory; global means the user's agent directories. Neither is inferred
in non-interactive mode: supply scope, agents and `--yes`. Conflicting scopes
fail before running anything. `--yes` accepts upstream install/overwrite prompts;
otherwise review the install plan and select agents interactively.
No Simbox login is needed. Set `DISABLE_TELEMETRY=1` to disable upstream telemetry.

## Live-video previews

The dashboard includes **live video and optional browser controls** for the
run's leased devices, served by Simlock through the API. See [device previews](DEVICE-PREVIEWS.md) for
transport, security, controls, browser requirements and remaining real-device
verification. Landing-page work remains outside this release's scope.

## Release checklist

Publish the updated runner action from `action-src/action.yml.template` through
the normal release pipeline (the rendered `action.yml` and binary checksums are
release-generated) **before** deploying an API that commits staged workflows, then
publish the CLI and deploy the dashboard/API together; the D1 migration applies
before the Worker (see [release order](DEPLOY.md#release-order)). Push
`skills/simbox` to the public repository before testing the GitHub-based install
command. Then repair older connected workflows and verify actual GitHub/Blacksmith
runs, including concurrent iOS and Android runs, on accounts with provider access.
