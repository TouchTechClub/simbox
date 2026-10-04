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
 * Prefer exec: proxy connect intentionally does NOT persist the daemon token,
 * and URL-derived proxy sessions become stale after a quick-tunnel restart.
 * Keep a direct manual fallback for clients which do not use the Simbox CLI.
 * Output goes to stderr when `quiet` (JSON mode keeps stdout clean).
 */
export function connectFlow(info: ConnectInfo, quiet = false): void {
  const out = quiet ? process.stderr : process.stdout;
  const base = daemonBaseUrl(info.tunnelUrl);
  const bin = findAgentDevice();

  if (bin) {
    out.write(`${pc.green("▶")} Ready for ${pc.bold("agent-device")} via Simbox.\n`);
  } else {
    out.write(
      `${pc.yellow("!")} ${pc.bold("agent-device")} not found on PATH — install it, then:\n`,
    );
  }

  out.write(`\n  ${pc.cyan("simbox exec devices")}\n`);
  out.write(
    `  ${pc.cyan('simbox exec open <app> --platform ios --device "<device from inventory>"')}\n`,
  );
  out.write(`  ${pc.cyan("simbox exec snapshot -i")}\n`);
  out.write("  Use --udid for iOS or --serial for Android when selecting a specific device.\n");
  out.write(
    "  exec supplies auth, refreshes tunnel URLs, and allows 5 minutes for cold startup.\n\n",
  );
  out.write(pc.dim("  manual connect:\n"));
  out.write(`  ${pc.cyan(`export AGENT_DEVICE_DAEMON_AUTH_TOKEN=${info.daemonToken}`)}\n`);
  out.write(`  ${pc.cyan(`export AGENT_DEVICE_DAEMON_BASE_URL=${base}`)}\n`);
  out.write(
    `  ${pc.cyan(`agent-device open <app> --platform ios --udid <udid> --session simbox-${info.runId} --timeout 300000`)}\n`,
  );
  out.write("  Raw agent-device commands need these exports again if the tunnel changes.\n");
}
