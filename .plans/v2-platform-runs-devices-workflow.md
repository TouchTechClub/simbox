# v2: per-platform runs, device selection, editable workflow

Status: implemented on `feat/platform-runs-devices-workflow`; this is the contract doc.

## Goals

1. **One active run per platform.** An iOS run (macOS runner) and an Android run
   (Linux/KVM runner) can be active at the same time and start/stop independently.
   A partial unique index on `runs (user_id, platform)` over active states enforces it.
   `sim`/`exec`/`stop` take `--platform`; without it they use the only active run
   (`sim` falls back to iOS, `stop --all` stops both).
2. **Runner selection.** Unchanged layering — CLI `--runner` → repository override →
   account default → GitHub default — now shown alongside device defaults.
3. **Device + OS selection.** `simbox sim --platform ios --device "iPhone 16 Pro" --os 18.4`
   (`--os latest|oldest`, `--foldable`, `--xcode` still work). Account/repository defaults
   for model and OS are set in the dashboard or `simbox devices set|reset`. Layering is
   field-wise: an override's model keeps the default OS and vice versa; a model and
   `foldable` are alternatives (`resolveDevice` in `packages/shared/src/runners.ts`).
   Xcode is per-run only. Each run reports its runner's catalog (KV, per repo + platform +
   runner labels, 60-day TTL; `simbox devices list`) and what it booted (`bootedDevice`).
4. **Editable workflow.** `.github/workflows/simbox.yml` is rendered from a `WorkflowSpec`
   (`packages/shared/src/workflow.ts`): three locked steps `prepare → start → serve`, user
   steps anywhere before/between/after. Saved via dashboard or `simbox workflow`; only
   users with push access may save. A save commits to the default branch, or opens/updates
   a `simbox-setup` PR when the branch is protected. `repos.state` is `pending_pr` only
   while the default branch has no workflow at all: an edit waiting in a PR keeps the repo
   `ok` (the committed workflow still runs) and records `pr_url`.

## Correlation (replaces time-window binding)

The API inserts the `runs` row **before** dispatching and passes its id as the
`simbox_run` workflow input. The workflow sets
`run-name: "simbox ${{ inputs.platform }} ${{ inputs.simbox_run }}"`, so webhooks and
the runs list carry the id in `display_title`. The `start` step passes it to the agent as
`SIMBOX_RUN_ID`; every runner API call sends `runId` alongside `ghRunId`. Old workflows
(no `simbox_run` input) get one legacy retry without it (bound by the old time window),
and cannot run both platforms at once until `simbox repair` (409 `workflow_needs_repair`).
`repos.workflow_version` records the schema version on the default branch (marker
comment `# simbox-workflow: 2`). Repair re-renders the stored spec and rotates
`SIMBOX_TOKEN` only when no run is open, so it never breaks an agent in flight.

The hard-exit clock (`expires_at`) starts at register, not dispatch: queue time is not
run time.

## Workflow stages (action `step` input)

| step      | does                                                                                                                                                              |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prepare` | preflight + download + checksum the agent into `$RUNNER_TEMP/simbox`; records job start                                                                           |
| `start`   | starts the agent in the background with `SIMBOX_STAGE_DIR`; streams its log until the agent writes `ready` (devices booted, nothing registered) or exits (fail)   |
| `serve`   | writes `go`; agent opens the tunnel, registers, supervises; streams the rest of the log; exits with the agent's `exit-code`; forwards SIGINT/SIGTERM to the agent |
| `all`     | legacy single step (default, so `TouchTechClub/runner@v1` without `step` behaves as before)                                                                       |

The action pins the exact release it was rendered for (`version` defaults to that tag),
so its tarball and embedded sha256 always match; CI no longer overwrites the rolling `v1`
release's tarballs.

## API surface

User (session/bearer):

- `POST /v1/runs/ensure` `{new?, platform?, runner?, device?}` → `EnsureRunResponse`.
  Platform omitted: reuse the only active run, else iOS. Device validated against the
  runner's last reported catalog when one exists (400 `invalid_device` lists options).
- `GET /v1/runs/active` → `{runs: PublicRun[]}` (≤ 1 per platform, reconciled).
- `GET /v1/runs/current?platform=ios|android` → `{run}` (no param: newest active; legacy).
- `GET /v1/runs?limit=` → `{runs: RunSummary[]}` (default 20, max 100);
  `POST /v1/runs/:id/stop` → `{run}`. Ensure `--new` ends only that platform's run.
- `GET /v1/runners` → `RunnerSettings` (now with `devices`); `GET /v1/runners/doctor` →
  `RunnerDiagnostics` (workflow status, per-platform catalog summary).
- `POST /v1/runners/:scope` `{ios?, android?}` runner patch; `POST /v1/devices/:scope`
  `{ios?: DeviceProfile|null, android?: …}` → `RunnerSettings`. `scope` = account|repo.
- `GET /v1/inventory?platform=ios&runner=<label or JSON array>` → `InventoryResponse`
  (runner omitted: the effective runner).
- `GET /v1/workflow` / `PUT /v1/workflow {spec}` → `WorkflowResponse`
  `{spec, yaml, status, repoState, prUrl}`. PUT: 400 `invalid_workflow`, 403
  `repo_forbidden` without push access.
- `POST /v1/repo/repair` → `RepoStatusResponse` (re-renders the stored spec).

Runner (Bearer `SIMBOX_TOKEN`), all accept optional `runId`:
`/v1/runs/{config,tunnel,register,heartbeat,deregister,inventory}`. `config` → `{platform,
device, runId}`; `inventory` `{catalog, booted?}` stores the catalog and `booted_device`.
409 `run_over` from config/tunnel/register/heartbeat, or a heartbeat 404, means the run is
over: agents exit 0.

`PublicRun` gains `devicesReady` and `bootedDevice`; `Repo` gains `workflowVersion`.
`RunHeartbeatRequest.devicesReady` (newer agents) is stored in `runs.devices_ready`;
while it is null (older agents) `devicesReady` falls back to live iOS or `androidReady`.

## Migration

`20261017124924_platform_runs_devices_workflow` adds device columns to `repos` and
`runner_settings`, `repos.workflow` / `workflow_version`, and `runs.booted_device` /
`devices_ready`. Before creating `uniq_runs_active_platform` it ends all but the newest
active run per user + platform (`state = 'ended'`, `end_reason = 'superseded'`).

## Release checklist

1. Release the agent + action (tag push → `release.yml`): the `runner` job pushes the
   `step`-aware `action.yml` to `TouchTechClub/runner` and retags `v1`. This must land
   **before** an API that commits v2 workflows; `release.yml` orders `deploy` after
   `runner` and `cli`.
2. Publish the CLI (`sim --platform` routing, `devices`, `workflow`).
3. Deploy API + dashboard; Alchemy applies the migration before the Worker.
4. Connected repos keep their v1 workflow (one platform at a time) until `simbox repair`;
   merge the `simbox-setup` PR on protected branches.
5. Verify concurrent iOS + Android runs and a custom step between `start` and `serve` on a
   real repository.
