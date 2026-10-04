# Android runner startup fix — verified 2026-10-04

## Result / Kotlin testing handoff

The Simbox infrastructure blocker is resolved in **@touchtechclub/simbox 0.2.11**.
Kotlin testing thread `4495190e-c533-480f-adbe-c22fd1c37453` can resume alpha.19
pairing-code and Orchestrator V2 testing after the steps below. **No S5 Code APK,
pairing code, or Orchestrator workflow was tested as part of this verification.**

Thread notification could not be delivered: this session has no T3 messaging
tools or supported ACP terminal transport. This document is the copy-ready handoff.

## Required steps

```bash
npm i -g @touchtechclub/simbox@0.2.11 agent-device@0.21.20
simbox --version  # 0.2.11
simbox repair    # once per connected repository; replaces workflow and rotates secret
simbox sim --new --platform android --json
simbox exec devices --platform android
simbox exec boot --platform android --device simbox --headless
simbox exec open com.android.settings --platform android --device simbox
simbox exec snapshot -i
```

Keep the JSON credentials private. Use `simbox exec` for subsequent commands;
it supplies current tunnel/auth and the stable run-scoped session. Android is
now a Linux/KVM run, not the default iOS/macOS run. An active Android run can be
reused with `simbox sim --platform android --json` or `simbox sim --json`.
Install the alpha.19 APK through the remote install flow before opening it;
this device image is x86_64, so the APK must include x86_64 native libraries
if it uses native code. Test runs below were closed/stopped to avoid billing.

## Diagnosis and fixes

- Both reported failures ([37219493549](https://github.com/SparshKaushik/rb-sim-test/actions/runs/37219493549),
  [37219553371](https://github.com/SparshKaushik/rb-sim-test/actions/runs/37219553371))
  hit the 15-second `simctl list` deadline. Mandatory iOS warmup aborted the
  entire runner before Android preparation could start. Logs do not establish
  why CoreSimulator inventory itself was slow.
- iOS prewarming is now opt-in, non-fatal, and not a tunnel startup gate.
  Its inventory budget is 60 seconds with better errors.
- A real Mac Android boot failed with `HVF error: HV_UNSUPPORTED` despite a
  successful `-accel-check`. Android therefore selects `ubuntu-latest` with
  `/dev/kvm` access via the CLI/API/workflow platform input.
- Releases include sha256-pinned Linux x64 and macOS ARM64 binaries. Agent
  log versions now match the actual release rather than remaining at 0.1.0.
- Android preparation installs the emulator, selects the host ABI, owns an
  explicit AVD path/discovery registry, and passes that environment to all
  subprocesses. It boots headlessly with software graphics and checks
  `sys.boot_completed=1` before reporting Android ready.
- Compiled Linux agent startup is kept alive during asynchronous downloads.
  CLI startup/Android commands wait for readiness; an explicitly mismatched
  active run is rejected rather than silently reused.

## Verification evidence

- Release: [v0.2.11 pipeline](https://github.com/TouchTechClub/simbox/actions/runs/37225552264):
  all six jobs passed, including 22 regression tests, typecheck, lint/format,
  both compiled agents, deployment/migration, npm publication and runner update.
- Initial successful Linux run:
  [37225697158](https://github.com/SparshKaushik/rb-sim-test/actions/runs/37225697158),
  Simbox `8fd9b7b9-d033-4e82-8bef-e56c90454e15`.
  Logs identify agent 0.2.11, usable KVM version 12 and emulator boot completion.
  This run had an initial Pixel Launcher ANR (dismissed with `alert dismiss`)
  and false upstream foreground-escape errors despite screenshot-confirmed taps.
- Fresh **installed npm CLI 0.2.11** run:
  [37226101568](https://github.com/SparshKaushik/rb-sim-test/actions/runs/37226101568),
  Simbox `71cbe687-7f15-4a88-9265-aaf15917f562`.
  `simbox sim --new --platform android --json` completed in **2m20s**.
  `boot` returned `Boot ready: simbox (android)`; Settings opened successfully.
  `click 'text="Network & internet"'` returned `Tapped ... (540, 886)`;
  the following screenshot and snapshot showed Network & internet / AndroidWifi.
  `back` returned `Back`, and a new snapshot showed Settings again.
  Session inventory identified Android `emulator-5554`; `ps` reported
  `android_ready: yes` and `active_devices: 1`.
- Both explicit-platform and plain `simbox sim --json` reused the live Android
  run successfully. Cleanup closed the session, canceled the test job, and
  `simbox ps` confirmed no active run.

Local evidence (no credentials):
`/tmp/opencode/android-final-verification-success.log`,
`/tmp/opencode/android-verification-success.log`, and
`/tmp/opencode/android-v0.2.11-network.png`.
