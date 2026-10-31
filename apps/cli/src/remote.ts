import { spawn } from "node:child_process";
import { join } from "node:path";
import { CliError } from "./client.js";
import { configDir } from "./config.js";
import { findAgentDevice, sessionName, writeRemoteProfile } from "./connect.js";
import { holderId } from "./holder.js";
import type { ConnectInfo } from "./connect.js";
import { sleep } from "./util.js";
import { registerDevice } from "./device-registration.js";
import { writeCachedRun } from "./run-cache.js";
import { connectForArgs, probeRemote, refreshRun, waitForRemote } from "./runs.js";

export const STARTUP_TIMEOUT_MS = 300_000;

export function remoteArgs(
  args: string[],
  info: ConnectInfo,
  stateDir: string,
  profile: string,
  holder = holderId(),
): string[] {
  // Isolate from saved agent-device proxy profiles: those may hold a stale URL
  // or an orphaned lease from a timed-out open. Simlock leases one device per
  // session. Do not overwrite user-owned config.
  const separator = args.indexOf("--");
  const result = separator < 0 ? [...args] : args.slice(0, separator);
  const tail = separator < 0 ? [] : args.slice(separator);
  if (["open", "boot", "prepare"].includes(args[0] ?? "") && !hasFlag(args, "--timeout")) {
    result.push("--timeout", String(STARTUP_TIMEOUT_MS));
  }
  if (!hasFlag(args, "--session")) result.push("--session", sessionName(info.runId, holder));
  // The profile carries the URL, token and tenant scope Simlock requires.
  result.push("--state-dir", stateDir, "--remote-config", profile);
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
    "--tenant",
    "--run-id",
    "--lease-id",
    "--session-isolation",
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
  if (!bin) throw new CliError("Install agent-device first: npm i -g agent-device@0.21.35");
  // Each agent uses its own run and cache; the platform is explicit, or the
  // only one this agent uses. An iOS endpoint never serves an Android command.
  const { platform, info } = await connectForArgs(args);
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
      const runId = connected.runId;
      const refreshed = await refreshRun(runId);
      if (!refreshed) break;
      connected = await waitForRemote(refreshed, { refresh: () => refreshRun(runId) });
      writeCachedRun(platform, connected);
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
    registerDevice(connected, { args, platform });
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
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.AGENT_DEVICE_DAEMON_AUTH_TOKEN;
  delete env.AGENT_DEVICE_REMOTE_CONFIG;
  delete env.AGENT_DEVICE_DAEMON_BASE_URL;
  let stdout = "";
  let stderr = "";
  const code = await new Promise<number>((resolve, reject) => {
    const profile = writeRemoteProfile(info);
    const child = spawn(bin, remoteArgs(args, info, join(configDir(), "agent-device"), profile), {
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
