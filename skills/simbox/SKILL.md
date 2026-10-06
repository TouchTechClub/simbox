---
name: simbox
description: Start and control remote iOS simulators or Android emulators on GitHub Actions with Simbox. Use for mobile app smoke tests, screenshots, app installation, runner selection, or remote device recovery.
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
simbox ps
simbox runners show
simbox sim --platform android          # use ios for iOS
simbox exec devices --platform android
```

Reuse a compatible active run. `--new` stops/replaces it: ask before disrupting
another session. Runner priority is explicit `--runner` → repository override
→ account default → GitHub default. Custom labels can be a JSON array.
Blacksmith needs its GitHub App and bills separately; do not silently select a
paid runner. A workflow-input error requires `simbox repair` (rotates the repo
secret), and possibly merging its PR; ask before repairing an active run.

The dashboard's Devices panel shows live video. Viewing is read-only unless a
human enables browser control; coordinate before mixing browser and CLI inputs.
Viewing alone does not keep an idle runner alive.

## Test

Choose an exact device from inventory; do not assume an iPhone name.

```bash
simbox exec boot --platform android --device simbox --headless
simbox exec install /absolute/path/app.apk --platform android --device simbox
simbox exec open com.example.app --platform android --device simbox
simbox exec snapshot -i
simbox exec click @e1
simbox exec screenshot /absolute/path/evidence.png
```

For iOS, use `--platform ios --device "<exact inventory name>"` and the
simulator `.app` build. Inspect `agent-device help install` or other command
help when syntax/platform support is uncertain. Take a fresh snapshot after
navigation; old refs may be invalid. Screenshots are visual evidence, not
proof of backend behavior. Use `--session <name>` consistently for multiple
independent device sessions; otherwise Simbox uses a stable run-scoped session.

## Recovery and cleanup

- A transport failure has an uncertain outcome. **Never blindly replay a tap,
  submit, install, or other action.** Inspect `simbox exec session list`, a fresh
  snapshot, and screenshot first. The next command refreshes tunnel credentials.
- For Android system dialogs, inspect `simbox exec alert get`; only dismiss
  after reading what is blocking the app. Startup can take minutes.
- Report run ID, Actions link, tested behavior, evidence paths, and limitations.
  Redact daemon tokens, tunnel credentials, pairing codes, and auth files.
- Close sessions you created with `simbox exec close`. Use `simbox stop` when
  finished with a run you own; do not stop another agent's work. A screenshot
  alone does not establish that pairing, orchestration, or a full flow passed.
