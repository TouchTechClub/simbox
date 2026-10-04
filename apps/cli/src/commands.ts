import { rmSync } from "node:fs";
import pc from "picocolors";
import type { PublicRun, RepoStatusResponse } from "@simbox/shared";
import {
  CliError,
  currentRun,
  ensureRun,
  me,
  pollDeviceToken,
  repairRepo,
  repoStatus,
  runHistory,
  startDeviceFlow,
  stopRun,
} from "./client.js";
import { authPath, saveToken, webBaseUrl } from "./config.js";
import { connectFlow, type ConnectInfo } from "./connect.js";
import { openInBrowser } from "./open.js";
import { fmtCountdown, sleep, Spinner } from "./util.js";
import { waitForRemote, waitForAndroid } from "./remote.js";

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
      pc.yellow("Note: private repos are billed at the 10× macOS minute multiplier by GitHub."),
    );
  }
  console.log(`Run ${pc.cyan("simbox sim")} to boot a simulator.`);
}

// ---- sim ----

const SIM_TIMEOUT_MS = 12 * 60 * 1000;
const SIM_POLL_MS = 3000;

export async function cmdSim(opts: {
  new?: boolean;
  json?: boolean;
  platform?: "ios" | "android";
}): Promise<void> {
  const json = opts.json === true;
  const out = json ? process.stderr : process.stdout;

  const first = await ensureRun(opts.new === true, opts.platform);

  let info: ConnectInfo;
  if (first.state === "live") {
    info = {
      runId: first.runId,
      tunnelUrl: first.tunnelUrl,
      daemonToken: first.daemonToken,
      expiresAt: first.expiresAt,
    };
  } else {
    const spinner = new Spinner(`Run ${first.state}`);
    spinner.begin();
    const deadline = Date.now() + SIM_TIMEOUT_MS;
    let live: { run: PublicRun; tunnelUrl: string; daemonToken: string } | null = null;

    while (Date.now() < deadline) {
      await sleep(SIM_POLL_MS);
      const run = await currentRun();
      if (!run) {
        const ended = (await runHistory()).find((candidate) => candidate.id === first.runId);
        if (ended && (ended.state === "ended" || ended.state === "failed")) {
          spinner.fail(`Run ${ended.state}`);
          throw new CliError(
            `The run ${ended.state} during startup (${ended.endReason ?? "check the Actions logs"}). Try \`simbox sim --new\`.`,
          );
        }
        continue;
      }
      if (run.state === "live" && run.tunnelUrl && run.daemonToken) {
        live = { run, tunnelUrl: run.tunnelUrl, daemonToken: run.daemonToken };
        break;
      }
      if (run.state === "failed" || run.state === "ended" || run.state === "closing") {
        spinner.fail(`Run ${run.state}`);
        throw new CliError(
          `The run ${run.state} before coming online (${run.endReason ?? "no reason given"}). Try \`simbox sim --new\`.`,
        );
      }
      spinner.set(`Run ${run.state}`);
    }

    if (!live) {
      spinner.fail("Timed out");
      throw new CliError(
        "Run didn't come online within 12 minutes. Check the workflow run in your repo's Actions tab, then try `simbox sim` again (or `--new`).",
      );
    }
    spinner.succeed("Run is live");
    info = {
      runId: live.run.id,
      tunnelUrl: live.tunnelUrl,
      daemonToken: live.daemonToken,
      expiresAt: live.run.expiresAt,
    };
  }

  info = await waitForRemote(info);
  if (opts.platform === "android") await waitForAndroid(info.runId);

  if (json) {
    const payload = {
      tunnel_url: info.tunnelUrl,
      daemon_token: info.daemonToken,
      run_id: info.runId,
      expires_at: info.expiresAt,
    };
    process.stdout.write(JSON.stringify(payload) + "\n");
    return;
  }

  out.write(
    `Run ${pc.bold(info.runId)} is ${pc.green("live")}` +
      (info.expiresAt ? ` — expires in ${fmtCountdown(info.expiresAt)}` : "") +
      "\n\n",
  );
  connectFlow(info, false);
}

// ---- ps ----

export async function cmdPs(): Promise<void> {
  const run = await currentRun();
  if (!run) {
    console.log(`No active run. Start one with ${pc.cyan("simbox sim")}.`);
    return;
  }

  const stateColor = run.state === "live" ? pc.green : run.state === "failed" ? pc.red : pc.yellow;
  console.log(`${pc.bold("run")} ${run.id}`);
  console.log(`  state:          ${stateColor(run.state)}`);
  console.log(`  platform:       ${run.platform}`);
  console.log(`  gh_run_id:      ${run.ghRunId ?? pc.dim("pending")}`);
  console.log(`  active_devices: ${run.activeDevices}`);
  console.log(`  android_ready:  ${run.androidReady ? "yes" : "no"}`);
  console.log(`  expires:        ${run.expiresAt ? fmtCountdown(run.expiresAt) : pc.dim("n/a")}`);
  if (run.endReason) console.log(`  end_reason:     ${run.endReason}`);
}

// ---- stop ----

export async function cmdStop(): Promise<void> {
  const run = await currentRun();
  if (!run) {
    console.log("No active run to stop.");
    return;
  }
  await stopRun(run.id);
  console.log(`${pc.green("✔")} Stop requested for run ${pc.bold(run.id)}.`);
}

// ---- repair ----

export async function cmdRepair(): Promise<void> {
  const spinner = new Spinner("Repairing repo");
  spinner.begin();
  const res = await repairRepo();
  spinner.succeed("Repair complete");
  if (res.message) console.log(res.message);
  else console.log("Workflow re-committed, secret rotated, installation verified.");
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
