import { rmSync } from "node:fs";
import pc from "picocolors";
import type { DevicePlatform, PublicRun, RepoStatusResponse } from "@simbox/shared";
import {
  parseRunnerInput,
  formatRunner,
  formatDeviceProfile,
  validateDeviceProfile,
} from "@simbox/shared";
import {
  activeRuns,
  CliError,
  ensureRun,
  me,
  pollDeviceToken,
  repairRepo,
  repoStatus,
  startDeviceFlow,
  stopRun,
} from "./client.js";
import { authPath, saveToken, webBaseUrl } from "./config.js";
import { connectFlow, type ConnectInfo } from "./connect.js";
import { openInBrowser } from "./open.js";
import { fmtCountdown, sleep, Spinner } from "./util.js";
import { registerDevice } from "./device-registration.js";
import { clearCachedRun } from "./run-cache.js";
import {
  defaultRunsDeps,
  PLATFORM_NAMES,
  refreshRun,
  targetPlatform,
  waitForRemote,
  waitForRun,
  type RunsDeps,
} from "./runs.js";

// ---- login ----

export async function cmdLogin(): Promise<void> {
  const flow = await startDeviceFlow();

  console.log(`\nYour login code: ${pc.bold(pc.cyan(flow.user_code))}\n`);
  const verifyUrl = flow.verification_uri_complete ?? flow.verification_uri;
  const opened = await openInBrowser(verifyUrl);
  console.log(
    opened
      ? `Opened ${pc.underline(verifyUrl)} — approve the code in your browser.`
      : `Open ${pc.underline(verifyUrl)} to approve the code.`,
  );

  const spinner = new Spinner("Waiting for approval");
  spinner.begin();
  const deadline = Date.now() + flow.expires_in * 1000;
  let interval = Math.max(1, flow.interval) * 1000;

  let token: string | null = null;
  while (Date.now() < deadline) {
    await sleep(interval);
    const res = await pollDeviceToken(flow.device_code);
    if (res.ok) {
      token = res.token;
      break;
    }
    switch (res.error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        interval += 5000;
        continue;
      case "access_denied":
        spinner.fail("Denied");
        throw new CliError("Login was denied in the browser.");
      case "expired_token":
        spinner.fail("Device code expired");
        throw new CliError("Login code expired — run `simbox login` again.");
      default:
        spinner.fail("Login failed");
        throw new CliError(
          `Login failed: ${res.description ?? res.error}. Run \`simbox login\` again.`,
        );
    }
  }
  if (!token) {
    spinner.fail("Timed out");
    throw new CliError("Login timed out — run `simbox login` again.");
  }

  const user = await me(token);
  saveToken(token, user.login);
  spinner.succeed(`Logged in as ${pc.bold(user.login)}`);
}

// ---- init ----

const INIT_TIMEOUT_MS = 10 * 60 * 1000;
const INIT_POLL_MS = 3000;

export async function cmdInit(): Promise<void> {
  const first = await repoStatus();
  if (first.connected && first.repo) {
    printRepoConnected(first.repo);
    return;
  }

  const url = `${webBaseUrl()}/onboarding`;
  const opened = await openInBrowser(url);
  console.log(
    opened
      ? `Opened ${pc.underline(url)} — install the GitHub App and pick a repo.`
      : `Open ${pc.underline(url)} to install the GitHub App and pick a repo.`,
  );

  const spinner = new Spinner("Waiting for repo connection");
  spinner.begin();
  const deadline = Date.now() + INIT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await sleep(INIT_POLL_MS);
    const status: RepoStatusResponse = await repoStatus();
    if (status.connected && status.repo) {
      spinner.succeed("Repo connected");
      printRepoConnected(status.repo);
      return;
    }
  }

  spinner.fail("Timed out waiting for repo connection");
  throw new CliError(
    `No repo connected after 10 minutes. Finish onboarding at ${webBaseUrl()}/onboarding then re-run \`simbox init\`.`,
  );
}

function printRepoConnected(repo: {
  fullName: string;
  state: string;
  prUrl: string | null;
  private: boolean;
}): void {
  console.log(`Repo connected: ${pc.bold(repo.fullName)} ${pc.dim(`(${repo.state})`)}`);
  if (repo.state === "pending_pr" && repo.prUrl) {
    console.log(
      `Your default branch is protected — merge ${pc.underline(repo.prUrl)} to activate Simbox.`,
    );
  }
  if (repo.private) {
    console.log(
      pc.yellow(
        "Note: private repositories may consume paid runner minutes. Review GitHub or your selected provider's billing.",
      ),
    );
  }
  console.log(`Run ${pc.cyan("simbox sim")} to boot a simulator.`);
}

// ---- sim ----

/** Queue + runner start + device boot on a warm image. */
export const SIM_TIMEOUT_MS = 25 * 60 * 1000;
/** A foldable or a pinned Xcode may first download a simulator runtime (up to ~30 min). */
export const SIM_RUNTIME_TIMEOUT_MS = 45 * 60 * 1000;

export interface SimOptions {
  new?: boolean;
  json?: boolean;
  platform?: DevicePlatform;
  runner?: string;
  device?: string;
  os?: string;
  foldable?: boolean;
  xcode?: string;
}

/** Validate sim flags before any API call; device and runner choices need a platform. */
export function simRequest(opts: SimOptions) {
  if (opts.runner !== undefined && !opts.platform)
    throw new CliError("Use --platform ios or android with --runner.");
  const runner =
    opts.runner === undefined ? undefined : parseRunnerInput(opts.runner, opts.platform!);
  const flags = [
    opts.device !== undefined && "--device",
    opts.os !== undefined && "--os",
    opts.foldable === true && "--foldable",
    opts.xcode !== undefined && "--xcode",
  ].filter((flag): flag is string => typeof flag === "string");
  if (flags.length && !opts.platform)
    throw new CliError(`Use --platform ios or android with ${flags.join(", ")}.`);
  let device;
  try {
    device = flags.length
      ? (validateDeviceProfile(
          {
            model: opts.device,
            os: opts.os,
            foldable: opts.foldable || undefined,
            xcode: opts.xcode,
          },
          opts.platform!,
        ) ?? undefined)
      : undefined;
  } catch (err) {
    throw new CliError((err as Error).message);
  }
  const timeoutMs =
    opts.platform === "ios" && (device?.foldable || device?.xcode)
      ? SIM_RUNTIME_TIMEOUT_MS
      : SIM_TIMEOUT_MS;
  return { platform: opts.platform, runner, device, timeoutMs };
}

export function simTimeoutMessage(timeoutMs: number): string {
  return `Run didn't come online within ${Math.round(timeoutMs / 60_000)} minutes. Check the workflow run in your repo's Actions tab, then try \`simbox sim\` again (or \`--new\`).`;
}

export async function cmdSim(opts: SimOptions, deps: Partial<RunsDeps> = {}): Promise<void> {
  const json = opts.json === true;
  const all = { ...defaultRunsDeps, ...deps };
  const request = simRequest(opts);
  const first = await ensureRun(
    opts.new === true,
    request.platform,
    request.runner,
    request.device,
  );

  // Follow THE run ensure returned, by id: other agents' runs may be active
  // on the same platform. Wait for live + devices ready.
  const spinner = new Spinner(`Run ${first.state}`);
  spinner.begin();
  let ready: { run: PublicRun; info: ConnectInfo };
  try {
    ready = await waitForRun(first.runId, {
      timeoutMs: request.timeoutMs,
      timeoutMessage: simTimeoutMessage(request.timeoutMs),
      onUpdate: (run) =>
        spinner.set(
          `${PLATFORM_NAMES[run.platform]} run ${run.state === "live" ? "live, waiting for devices" : run.state}`,
        ),
      deps: all,
    });
  } catch (err) {
    spinner.fail("Run did not come online");
    throw err;
  }
  spinner.succeed(`${PLATFORM_NAMES[ready.run.platform]} run is live`);
  const { run } = ready;
  const info = await waitForRemote(ready.info, {
    probe: all.probe,
    refresh: () => refreshRun(run.id, all),
  });
  all.writeCache(run.platform, info);
  registerDevice(info, { platform: run.platform });

  if (json) {
    const payload = {
      tunnel_url: info.tunnelUrl,
      daemon_token: info.daemonToken,
      run_id: info.runId,
      expires_at: info.expiresAt,
      platform: run.platform,
      booted_device: run.bootedDevice ?? null,
      max_devices: run.maxDevices ?? null,
    };
    process.stdout.write(JSON.stringify(payload) + "\n");
    return;
  }

  process.stdout.write(
    `${PLATFORM_NAMES[run.platform]} run ${pc.bold(info.runId)} is ${pc.green("live")}` +
      (info.expiresAt ? ` — expires in ${fmtCountdown(info.expiresAt)}` : "") +
      "\n\n",
  );
  connectFlow(info, { platform: run.platform, bootedDevice: run.bootedDevice });
}

// ---- ps ----

function stateColor(state: string): (text: string) => string {
  return state === "live" ? pc.green : state === "failed" ? pc.red : pc.yellow;
}

export function printRun(run: PublicRun): void {
  const booted = run.bootedDevice;
  console.log(
    `${pc.bold(PLATFORM_NAMES[run.platform])} run ${run.id}${run.held ? pc.dim(" (this agent's)") : ""}`,
  );
  console.log(`  state:          ${stateColor(run.state)(run.state)}`);
  console.log(`  runner:         ${formatRunner(run.runner)}`);
  console.log(`  requested:      ${formatDeviceProfile(run.device ?? null, run.platform)}`);
  console.log(
    `  booted:         ${
      booted
        ? `${booted.name} (${run.platform === "ios" ? "iOS" : "API"} ${booted.os}${booted.id ? `, ${booted.id}` : ""})`
        : pc.dim(run.devicesReady ? "unknown" : "not yet")
    }`,
  );
  console.log(`  devices_ready:  ${run.devicesReady ? "yes" : "no"}`);
  console.log(`  active_devices: ${run.activeDevices}/${run.maxDevices ?? "?"}`);
  console.log(`  gh_run_id:      ${run.ghRunId ?? pc.dim("pending")}`);
  console.log(`  expires:        ${run.expiresAt ? fmtCountdown(run.expiresAt) : pc.dim("n/a")}`);
  if (run.endReason) console.log(`  end_reason:     ${run.endReason}`);
}

export async function cmdPs(opts: { json?: boolean } = {}): Promise<void> {
  const runs = await activeRuns();
  if (opts.json) {
    console.log(JSON.stringify({ runs }));
    return;
  }
  if (!runs.length) {
    console.log(`No active runs. Start one with ${pc.cyan("simbox sim --platform ios|android")}.`);
    return;
  }
  runs.forEach((run, i) => {
    if (i) console.log("");
    printRun(run);
  });
}

// ---- stop ----

export async function cmdStop(
  opts: { platform?: DevicePlatform; all?: boolean; run?: string } = {},
): Promise<void> {
  if ([opts.all, opts.platform, opts.run].filter(Boolean).length > 1)
    throw new CliError("Use one of --run, --platform or --all.");
  const active = await activeRuns();
  let targets: PublicRun[];
  if (opts.all) targets = active;
  else if (opts.run) {
    targets = active.filter((run) => run.id === opts.run);
    if (!targets.length) throw new CliError(`No active run ${opts.run}. Check \`simbox ps\`.`);
  } else {
    // This agent's runs: another agent may be using the platform's others.
    const scope = opts.platform ? active.filter((run) => run.platform === opts.platform) : active;
    targets = scope.filter((run) => run.held);
    if (!targets.length && scope.length) {
      const platform =
        opts.platform ??
        targetPlatform(
          undefined,
          active,
          "Pass --run <id> or --platform ios|android to stop runs, or --all to stop every run.",
        );
      targets = active.filter((run) => run.platform === platform);
      if (targets.length > 1)
        throw new CliError(
          `${targets.length} ${PLATFORM_NAMES[platform]} runs are active (${targets.map((run) => run.id).join(", ")}) and none is this agent's. Pass --run <id>, or --all to stop every run.`,
        );
    }
  }
  if (!targets.length) {
    if (opts.platform) clearCachedRun(opts.platform);
    console.log(
      opts.platform
        ? `No active ${PLATFORM_NAMES[opts.platform]} run to stop.`
        : "No active run to stop.",
    );
    return;
  }
  for (const run of targets) {
    await stopRun(run.id);
    clearCachedRun(run.platform);
    if (run.tunnelUrl && run.daemonToken)
      registerDevice(
        {
          runId: run.id,
          tunnelUrl: run.tunnelUrl,
          daemonToken: run.daemonToken,
          expiresAt: run.expiresAt,
        },
        { stop: true, platform: run.platform },
      );
    console.log(
      `${pc.green("✔")} Stop requested for the ${PLATFORM_NAMES[run.platform]} run ${pc.bold(run.id)}.`,
    );
  }
}

// ---- repair ----

export function printRepoStatus(status: RepoStatusResponse): void {
  const repo = status.repo;
  if (!status.connected || !repo) {
    console.log(`No repo connected. Run ${pc.cyan("simbox init")}.`);
    return;
  }
  const color = repo.state === "ok" ? pc.green : pc.yellow;
  console.log(
    `Repo ${pc.bold(repo.fullName)}: ${color(repo.state)}${repo.workflowVersion ? pc.dim(` (workflow v${repo.workflowVersion})`) : ""}`,
  );
  if (repo.state === "pending_pr")
    console.log(
      repo.prUrl
        ? `The default branch is protected — merge ${pc.underline(repo.prUrl)} to apply the workflow.`
        : "The default branch is protected — merge the Simbox pull request to apply the workflow.",
    );
  else if (repo.state === "ok" && repo.prUrl)
    console.log(
      `The default branch is protected — merge ${pc.underline(repo.prUrl)} to apply the update. The current workflow keeps working meanwhile.`,
    );
  else if (repo.state === "ok")
    console.log(
      "Workflow up to date and installation verified (the repo secret rotates only while no run is active).",
    );
  else if (repo.state === "needs_repair")
    console.log("The repo still needs repair; check the GitHub App installation and permissions.");
  else if (repo.state === "uninstalled")
    console.log(`The GitHub App is not installed. Run ${pc.cyan("simbox init")}.`);
}

export async function cmdRepair(): Promise<void> {
  const spinner = new Spinner("Repairing repo");
  spinner.begin();
  let status: RepoStatusResponse;
  try {
    status = await repairRepo();
  } catch (err) {
    spinner.fail("Repair failed");
    throw err;
  }
  spinner.succeed("Repair complete");
  printRepoStatus(status);
}

// ---- logout ----

export async function cmdLogout(): Promise<void> {
  try {
    rmSync(authPath());
    console.log(`${pc.green("✔")} Logged out.`);
  } catch {
    console.log("Already logged out.");
  }
}
