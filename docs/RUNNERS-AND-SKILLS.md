# Runners and agent setup

## Runner defaults and overrides

Runner precedence for **new runs**:

1. `simbox sim --platform <platform> --runner <label-or-json>`
2. Connected repository override
3. Simbox account default
4. GitHub default (`ubuntu-latest` / `macos-latest`)

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

Settings never migrate an active run. Plain `sim` reuses that run even if defaults
have changed; an explicitly different platform or runner is rejected unless
`--new` is requested. History and `ps` record the selected runner, not a newly
resolved default. Historical runs without recorded labels are marked unknown.

### Workflow upgrade

Run `simbox repair` **once after upgrading** to install the new `runner_labels`
workflow input; merge the generated PR if the default branch is protected.
The API always dispatches the exact labels selected for the run. Old workflows
return an actionable repair error rather than silently ignoring your selection.
Manual Actions dispatch can leave `runner_labels` empty to use the platform default.

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
  downloading binaries. Emulator acceleration/boot is checked during provisioning.
- Self-hosted runners must be trusted and appropriately isolated: the action
  receives repository/run credentials. Ensure outbound HTTPS and Cloudflare
  tunnel connectivity. A nonexistent label can remain queued; Simbox's startup
  timeout points to the Actions job and never substitutes a different target.

`simbox doctor` checks local tools, configuration and the installed workflow
without starting a paid job; actual KVM/Xcode capability is checked on the runner.

## Small agent skill

The skill lives at `skills/simbox/SKILL.md`. It covers setup, runner selection,
app smoke tests, credential hygiene, uncertain-outcome recovery and cleanup.
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

The dashboard now includes **live video and optional browser controls**, based on
the same device hub as T3 Code. See [device previews](DEVICE-PREVIEWS.md) for
transport, security, controls, browser requirements and remaining real-device
verification. Landing-page work remains outside this release's scope.

## Release checklist

Apply the included `runner_settings` / repository override / run-label D1
migration before deploying the API. Publish the updated runner action from
`action-src/action.yml.template` through the normal release pipeline (the rendered
`action.yml` and binary checksums are release-generated), publish the CLI, and
deploy the dashboard/API together. Push `skills/simbox` to the public repository
before testing the GitHub-based install command. Then repair older connected
workflows and verify actual GitHub/Blacksmith runs on accounts with provider access.
