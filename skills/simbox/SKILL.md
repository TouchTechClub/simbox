---
name: simbox
description: Start and control remote iOS simulators or Android emulators on GitHub Actions with Simbox. Use for mobile app smoke tests, screenshots, app installation, runner or device/OS selection, workflow setup steps, or remote device recovery.
---

# Simbox

Simbox manages runners and credentials; `agent-device` drives devices. Use
`simbox exec <agent-device arguments>` so auth/tunnel routing refreshes before
each command. Do not write global agent-device profiles or expose run JSON tokens.

## Setup

1. Check `simbox --version`, `agent-device --version`, and `simbox doctor`.
   If missing, ask before installing `@touchtechclub/simbox` and the compatible
   `agent-device` version documented in the repository README.
2. A human completes `simbox login` and `simbox init`. Never approve someone
   else's authorization code. Do not log credentials.
3. Ask for platform, app binary/identifier, and test goal if unclear.
   Android uses Linux x64/KVM; iOS uses macOS ARM64/Xcode. Android APKs with
   native libraries need x86_64; iOS needs a simulator build, not a device IPA.

## Start and inspect

```bash
simbox ps                               # at most one active run per platform
simbox runners show
simbox devices list --platform ios      # models/OS the runner reported
simbox sim --platform ios --device "<model from devices list>" --os latest
simbox sim --platform android           # runs alongside the iOS run
simbox exec devices --platform android
```

iOS and Android runs are independent and can be active at once. **Always pass
`--platform` to `sim`, `exec` and `stop`**. Reuse a compatible active run. `--new` replaces only that platform's run: ask
before disrupting another session. Runner priority is explicit `--runner` →
repository override → account default → GitHub default; device model and OS
defaults layer the same way, field by field. Custom labels can be a JSON array.
Blacksmith needs its GitHub App and bills separately; do not silently select a
paid runner. `--os` takes `18.4`, `18`, an API level, `latest` or `oldest`.
`invalid_device` lists what the runner offers. A workflow-input or `workflow_needs_repair`
error requires `simbox repair`, and possibly merging its PR.

For hinge testing, start with `--foldable` (iOS also needs
`--runner xcode-27 --xcode 27.1`; startup takes several extra minutes), open
an app, then `simbox exec fold closed|half-open|open --platform <p>`
(idempotent: retry a failed pose). A run's device, OS and runner are fixed;
changing them requires `--new`.

To prepare the runner before devices go live (checkout, build, install an app,
seed data), add workflow steps; ask first, since saving commits to the
repository (or opens a PR on a protected branch) and needs push access:

```bash
simbox workflow show
simbox workflow add --name Checkout --uses actions/checkout@v4   # before start
simbox workflow add --name "Install app" --run "./scripts/install.sh" \
  --platform android --after start   # devices booted, not yet reachable
simbox workflow remove install-app
```

`prepare`, `start` and `serve` are locked. Changes apply to the next run.

The dashboard shows live video, read-only unless a human enables control;
coordinate before mixing browser and CLI inputs.

## Test

Choose an exact device from inventory; do not assume an iPhone name.

```bash
simbox exec boot --platform android --device simbox --headless
simbox exec install /absolute/path/app.apk --platform android --device simbox
simbox exec open com.example.app --platform android --device simbox
simbox exec snapshot -i --platform android
simbox exec click @e1 --platform android
simbox exec screenshot /absolute/path/evidence.png --platform android
```

For iOS, use `--platform ios --device "<exact inventory name>"` (or `--udid`
from the `Booted:` line `simbox sim` prints) and the simulator `.app` build.
Check `agent-device help <command>` when unsure. Take a fresh snapshot after
navigation; old refs may be invalid. Screenshots are visual evidence, not
proof of backend behavior. Use `--session <name>` consistently for multiple
independent device sessions; otherwise Simbox uses a stable run-scoped session.

## Recovery and cleanup

- A transport failure has an uncertain outcome. **Never blindly replay a tap,
  submit, install, or other action.** Inspect `simbox exec session list`, a fresh
  snapshot, and screenshot first. The next command refreshes tunnel credentials.
- For Android system dialogs, inspect `simbox exec alert get`; only dismiss
  after reading what is blocking the app. Startup can take minutes.
- Report platform, run ID, booted device/OS, Actions link, tested behavior,
  evidence paths, and limitations.
  Redact daemon tokens, tunnel credentials, pairing codes, and auth files.
- Close sessions you created with `simbox exec close --platform <p>`. Use
  `simbox stop --platform <p>` when finished with a run you own; `--all` stops
  both, so do not use it while another agent uses the other platform. A screenshot
  alone does not establish that pairing, orchestration, or a full flow passed.
