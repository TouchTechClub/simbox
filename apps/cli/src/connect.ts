import { spawnSync } from "node:child_process";
import pc from "picocolors";

export interface ConnectInfo {
  runId: string;
  tunnelUrl: string;
  daemonToken: string;
  expiresAt: number | null;
}

export function daemonBaseUrl(tunnelUrl: string): string {
  return `${tunnelUrl.replace(/\/+$/, "")}/agent-device`;
}

/** Locate the agent-device binary on PATH. */
export function findAgentDevice(): string | null {
  const which = process.platform === "win32" ? "where" : "which";
  const res = spawnSync(which, ["agent-device"], { encoding: "utf8" });
  if (res.status !== 0) return null;
  const first = (res.stdout ?? "").split(/\r?\n/).find((l) => l.trim().length > 0);
  return first?.trim() ?? null;
}

/**
 * NOTE: `agent-device connect proxy` persists its own profile (base URL +
 * token) internally. We deliberately do NOT write to its config file —
 * agent-device's schema rejects unknown top-level keys, and our earlier
 * `simbox` namespacing broke subsequent `connect` calls with
 * "Unknown config key". The manual fallback export line printed below is the
 * supported way to reuse the token across shells.
 */

/**
 * Auto-connect if agent-device is installed; always print the manual fallback.
 * Output goes to stderr when `quiet` (JSON mode keeps stdout clean).
 */
export function connectFlow(info: ConnectInfo, quiet = false): void {
  const out = quiet ? process.stderr : process.stdout;
  const base = daemonBaseUrl(info.tunnelUrl);
  const bin = findAgentDevice();

  if (bin) {
    out.write(`${pc.green("▶")} Connecting via ${pc.bold("agent-device")}…\n`);
    const res = spawnSync(bin, ["connect", "proxy", "--daemon-base-url", base], {
      stdio: quiet ? ["inherit", "ignore", "inherit"] : "inherit",
      env: { ...process.env, AGENT_DEVICE_DAEMON_AUTH_TOKEN: info.daemonToken },
    });
    if (res.error || res.status !== 0) {
      out.write(pc.yellow("  agent-device connect failed — use the manual commands below.\n"));
    } else {
      out.write(
        `\nNext: ${pc.cyan("agent-device open <app> --platform ios")} ${pc.dim("(or --platform android)")}\n\n`,
      );
    }
  } else {
    out.write(
      `${pc.yellow("!")} ${pc.bold("agent-device")} not found on PATH — install it, then:\n`,
    );
  }

  out.write(pc.dim("  manual connect:\n"));
  out.write(`  ${pc.cyan(`export AGENT_DEVICE_DAEMON_AUTH_TOKEN=${info.daemonToken}`)}\n`);
  out.write(`  ${pc.cyan(`agent-device connect proxy --daemon-base-url ${base}`)}\n`);
  out.write(`  ${pc.cyan("agent-device open <app> --platform ios")}\n`);
}
