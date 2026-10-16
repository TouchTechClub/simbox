import { spawn } from "node:child_process";
import { join } from "node:path";
import { currentRun, CliError } from "./client.js";
import { configDir } from "./config.js";
import { daemonBaseUrl, findAgentDevice } from "./connect.js";
import type { ConnectInfo } from "./connect.js";
import { sleep } from "./util.js";
import { registerDevice } from "./device-registration.js";
import { clearCachedRun, readCachedRun, writeCachedRun } from "./run-cache.js";

export const STARTUP_TIMEOUT_MS = 300_000;

export async function waitForAndroid(
  runId: string,
  options: {
    read?: typeof currentRun;
    pause?: () => Promise<void>;
    timeoutMs?: number;
  } = {},
): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? 12 * 60_000);
  do {
    const run = await (options.read ?? currentRun)();
    if (!run || run.id !== runId || run.state !== "live") {
      throw new CliError(
        "The run ended or was replaced while preparing Android. Run `simbox sim` again.",
      );
    }
    if (run.platform === "ios") {
      throw new CliError(
        "Android needs a Linux/KVM run. Run `simbox repair`, then `simbox sim --new --platform android`.",
      );
    }
    if (run.androidReady) return;
    await (options.pause?.() ?? sleep(3000));
  } while (Date.now() < deadline);
  throw new CliError(
    "Android AVD preparation did not complete. Inspect the Actions job's Android emulator prep logs. No device command was sent.",
  );
}

/** Poll only reads: never replay an open/tap/install whose outcome is unknown. */
export async function waitForRemote(
  initial: ConnectInfo,
  options: {
    timeoutMs?: number;
    probe?: (info: ConnectInfo) => Promise<boolean>;
    refresh?: () => Promise<ConnectInfo | null>;
    pause?: () => Promise<void>;
  } = {},
): Promise<ConnectInfo> {
  const probe = options.probe ?? probeRemote;
  const refresh = options.refresh ?? refreshRemote;
  // Covers two supervisor heartbeat intervals plus tunnel restart/DNS time.
  const deadline = Date.now() + (options.timeoutMs ?? 180_000);
  let info = initial;
  do {
    if (await probe(info)) return info;
    const next = await refresh();
    if (!next || next.runId !== initial.runId) {
      throw new CliError("The run ended or was replaced. Run `simbox sim` to connect again.");
    }
    info = next;
    await (options.pause?.() ?? sleep(1000));
  } while (Date.now() < deadline);
  throw new CliError(
    "The run is live but its tunnel/daemon is not ready. Retry `simbox sim` or inspect the Actions logs. No device command was sent.",
  );
}

async function probeRemote(info: ConnectInfo): Promise<boolean> {
  try {
    const res = await fetch(`${daemonBaseUrl(info.tunnelUrl)}/health`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean; upstream?: { ok?: boolean } };
    return body.ok === true && body.upstream?.ok !== false;
  } catch {
    return false;
  }
}

async function refreshRemote(): Promise<ConnectInfo | null> {
  const run = await currentRun();
  if (run?.state !== "live" || !run.tunnelUrl || !run.daemonToken) return null;
  return {
    runId: run.id,
    tunnelUrl: run.tunnelUrl,
    daemonToken: run.daemonToken,
    expiresAt: run.expiresAt,
  };
}

export function remoteArgs(args: string[], info: ConnectInfo, stateDir: string): string[] {
  // Isolate from saved agent-device proxy profiles: those may hold a stale URL
  // or an orphaned lease from a timed-out open. The daemon itself still enforces
  // exclusive device ownership by session. Do not overwrite user-owned config.
  const separator = args.indexOf("--");
  const result = separator < 0 ? [...args] : args.slice(0, separator);
  const tail = separator < 0 ? [] : args.slice(separator);
  if (["open", "boot", "prepare"].includes(args[0] ?? "") && !hasFlag(args, "--timeout")) {
    result.push("--timeout", String(STARTUP_TIMEOUT_MS));
  }
  if (!hasFlag(args, "--session")) result.push("--session", `simbox-${info.runId}`);
  result.push(
    "--state-dir",
    stateDir,
    "--daemon-base-url",
    daemonBaseUrl(info.tunnelUrl),
    "--daemon-transport",
    "http",
  );
  return [...result, ...tail];
}

/**
 * Commands that only read state or set it to an absolute value (a fold pose).
 * Replaying one after a dropped tunnel is harmless; taps, typing, installs and
 * opens are never replayed.
 */
const REPLAY_SAFE = new Set([
  "devices",
  "snapshot",
  "screenshot",
  "fold",
  "session",
  "appstate",
  "apps",
  "get",
  "is",
]);

/** agent-device failures where the request may never have reached the runner. */
const TRANSPORT_ERROR =
  /Remote daemon is unavailable|Daemon request timed out|Failed to read daemon response|fetch failed|ECONNRESET|socket hang up/;

export function shouldReplay(args: string[], code: number, output: string): boolean {
  return code !== 0 && REPLAY_SAFE.has(args[0] ?? "") && TRANSPORT_ERROR.test(output);
}

const REPLAY_ATTEMPTS = 3;

function hasFlag(args: string[], flag: string): boolean {
  const end = args.indexOf("--");
  return (end < 0 ? args : args.slice(0, end)).some(
    (arg) => arg === flag || arg.startsWith(`${flag}=`),
  );
}

export async function cmdExec(args: string[]): Promise<void> {
  if (!args.length) throw new CliError("Usage: simbox exec <agent-device command> [arguments]");
  // Simbox owns routing/auth. Never let ambient profiles or flags silently send
  // this command to another device host. Use agent-device directly for those.
  const reserved = [
    "--daemon-base-url",
    "--daemon-auth-token",
    "--daemon-transport",
    "--remote-config",
    "--state-dir",
  ];
  if (reserved.some((flag) => hasFlag(args, flag))) {
    throw new CliError(
      "Simbox manages the remote URL, credentials and state directory for `exec`.",
    );
  }
  if (["connect", "disconnect", "proxy", "auth"].includes(args[0]!)) {
    throw new CliError("Use device commands with `simbox exec`, not connection/auth commands.");
  }
  const bin = findAgentDevice();
  if (!bin) throw new CliError("Install agent-device first: npm i -g agent-device@0.21.28");
  const android = args.some(
    (arg, i) => arg === "--platform=android" || (arg === "--platform" && args[i + 1] === "android"),
  );
  // A reachable cached endpoint skips the API round-trip. Android commands
  // still ask the API, which alone knows whether the AVD is ready.
  let info = android ? null : readCachedRun();
  if (info && !(await probeRemote(info))) info = null;
  if (!info) {
    const initial = await refreshRemote();
    if (!initial) {
      clearCachedRun();
      throw new CliError("No live run. Start one with `simbox sim`.");
    }
    if (android) await waitForAndroid(initial.runId);
    info = await waitForRemote(initial);
  }
  writeCachedRun(info);
  const replaySafe = REPLAY_SAFE.has(args[0]!);
  let connected: ConnectInfo = info;
  let result = await runRemote(bin, args, connected, replaySafe);
  for (let attempt = 1; attempt < REPLAY_ATTEMPTS; attempt++) {
    if (!shouldReplay(args, result.code, result.output)) break;
    process.stderr.write(
      `Tunnel dropped during \`${args[0]}\`; retrying (${attempt}/${REPLAY_ATTEMPTS - 1}).\n`,
    );
    await sleep(attempt * 5_000);
    if (!(await probeRemote(connected))) {
      const refreshed = await refreshRemote();
      if (!refreshed) break;
      connected = await waitForRemote(refreshed);
      writeCachedRun(connected);
    }
    result = await runRemote(bin, args, connected, replaySafe);
  }
  if (replaySafe) {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
  }
  const code = result.code;
  if (
    code === 0 &&
    !args.some((arg) => ["help", "--help", "-h", "--version", "version"].includes(arg))
  )
    registerDevice(connected, { args });
  if (code !== 0 && !replaySafe) {
    process.stderr.write(
      "Simbox did not retry the device command (it may already have executed). Use `simbox exec session list` to inspect it; the next command refreshes the tunnel automatically.\n",
    );
  }
  process.exitCode = code;
}

/**
 * Run agent-device against the runner. Replay-safe commands are buffered so a
 * failed attempt that will be retried prints nothing.
 */
async function runRemote(
  bin: string,
  args: string[],
  info: ConnectInfo,
  capture: boolean,
): Promise<{ code: number; output: string; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGENT_DEVICE_DAEMON_AUTH_TOKEN: info.daemonToken,
  };
  delete env.AGENT_DEVICE_REMOTE_CONFIG;
  delete env.AGENT_DEVICE_DAEMON_BASE_URL;
  let stdout = "";
  let stderr = "";
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(bin, remoteArgs(args, info, join(configDir(), "agent-device")), {
      stdio: capture ? ["inherit", "pipe", "pipe"] : "inherit",
      env,
    });
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (status) => resolve(status ?? 1));
  });
  return { code, output: stdout + stderr, stdout, stderr };
}
