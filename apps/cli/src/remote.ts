import { spawn } from "node:child_process";
import { join } from "node:path";
import { currentRun, CliError } from "./client.js";
import { configDir } from "./config.js";
import { daemonBaseUrl, findAgentDevice } from "./connect.js";
import type { ConnectInfo } from "./connect.js";
import { sleep } from "./util.js";

export const STARTUP_TIMEOUT_MS = 300_000;

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
  const deadline = Date.now() + (options.timeoutMs ?? 90_000);
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
  if (!bin) throw new CliError("Install agent-device first: npm i -g agent-device@0.21.20");
  const initial = await refreshRemote();
  if (!initial) throw new CliError("No live run. Start one with `simbox sim`.");
  const info = await waitForRemote(initial);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGENT_DEVICE_DAEMON_AUTH_TOKEN: info.daemonToken,
  };
  delete env.AGENT_DEVICE_REMOTE_CONFIG;
  delete env.AGENT_DEVICE_DAEMON_BASE_URL;
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(bin, remoteArgs(args, info, join(configDir(), "agent-device")), {
      stdio: "inherit",
      env,
    });
    child.on("error", reject);
    child.on("exit", (status) => resolve(status ?? 1));
  });
  if (code !== 0) {
    process.stderr.write(
      "Simbox did not retry the device command (it may already have executed). Use `simbox exec session list` to inspect it; the next command refreshes the tunnel automatically.\n",
    );
  }
  process.exitCode = code;
}
