import { spawnSync } from "node:child_process";
import pc from "picocolors";
import type { BootedDevice, DevicePlatform } from "@simbox/shared";

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

/** What the hints can say about the run's device. */
export interface ConnectHints {
  platform: DevicePlatform;
  /** The device the runner booted, once reported. */
  bootedDevice?: BootedDevice | null;
}

/**
 * Prefer exec: proxy connect intentionally does NOT persist the daemon token,
 * and URL-derived proxy sessions become stale after a quick-tunnel restart.
 * Keep a direct manual fallback for clients which do not use the Simbox CLI.
 * Output goes to stderr when `quiet` (JSON mode keeps stdout clean).
 */
export function connectFlow(info: ConnectInfo, hints: ConnectHints, quiet = false): void {
  const out = quiet ? process.stderr : process.stdout;
  const base = daemonBaseUrl(info.tunnelUrl);
  const bin = findAgentDevice();
  const { platform, bootedDevice } = hints;
  const device = bootedDevice
    ? JSON.stringify(bootedDevice.name)
    : '"<device from simbox exec devices>"';
  const selector = platform === "ios" ? "--udid" : "--serial";
  const id = bootedDevice?.id ?? (platform === "ios" ? "<udid>" : "<serial>");

  if (bin) {
    out.write(`${pc.green("▶")} Ready for ${pc.bold("agent-device")} via Simbox.\n`);
  } else {
    out.write(
      `${pc.yellow("!")} ${pc.bold("agent-device")} not found on PATH — install it, then:\n`,
    );
  }
  if (bootedDevice)
    out.write(
      `  Booted: ${pc.bold(bootedDevice.name)} (${platform === "ios" ? "iOS" : "API"} ${bootedDevice.os}${bootedDevice.id ? `, ${bootedDevice.id}` : ""})\n`,
    );

  out.write(`\n  ${pc.cyan(`simbox exec devices --platform ${platform}`)}\n`);
  out.write(`  ${pc.cyan(`simbox exec open <app> --platform ${platform} --device ${device}`)}\n`);
  out.write(`  ${pc.cyan(`simbox exec snapshot -i --platform ${platform}`)}\n`);
  out.write(
    `  Pass --platform ${platform} whenever both an iOS and an Android run are active; use ${selector} to pick a specific device.\n`,
  );
  out.write(
    `  This run (${info.runId}) is reserved for this agent; other agents get their own. SIMBOX_RUN=${info.runId} pins a shell to it.\n`,
  );
  out.write(
    "  exec supplies auth, refreshes tunnel URLs, and allows 5 minutes for cold startup.\n\n",
  );
  out.write(pc.dim("  manual connect:\n"));
  out.write(`  ${pc.cyan(`export AGENT_DEVICE_DAEMON_AUTH_TOKEN=${info.daemonToken}`)}\n`);
  out.write(`  ${pc.cyan(`export AGENT_DEVICE_DAEMON_BASE_URL=${base}`)}\n`);
  out.write(
    `  ${pc.cyan(`agent-device open <app> --platform ${platform} ${selector} ${id} --session simbox-${info.runId} --timeout 300000`)}\n`,
  );
  out.write("  Raw agent-device commands need these exports again if the tunnel changes.\n");
}
