import { spawnSync } from "node:child_process";
import pc from "picocolors";
import type { BootedDevice, DevicePlatform } from "@simbox/shared";
import { holderId } from "./holder.js";

export interface ConnectInfo {
  runId: string;
  tunnelUrl: string;
  daemonToken: string;
  expiresAt: number | null;
}

/** The run's Simlock daemon serves agent-device here. */
export function daemonBaseUrl(tunnelUrl: string): string {
  return `${tunnelUrl.replace(/\/+$/, "")}/v1/agent-device`;
}

/**
 * The agent-device session on a run. Simlock leases one device per session,
 * so agents sharing a run (`holder`) each get their own device.
 */
export function sessionName(runId: string, holder?: string): string {
  return holder ? `simbox-${runId}-${holder.slice(0, 8)}` : `simbox-${runId}`;
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
 * Prefer exec: it supplies the token and the run's URL on every command.
 * Keep a direct manual fallback for clients which do not use the Simbox CLI.
 * Output goes to stderr when `quiet` (JSON mode keeps stdout clean).
 */
export function connectFlow(
  info: ConnectInfo,
  hints: ConnectHints,
  quiet = false,
  holder = holderId(),
): void {
  const out = quiet ? process.stderr : process.stdout;
  const base = daemonBaseUrl(info.tunnelUrl);
  const bin = findAgentDevice();
  const { platform, bootedDevice } = hints;
  const session = sessionName(info.runId, holder);

  if (bin) {
    out.write(`${pc.green("▶")} Ready for ${pc.bold("agent-device")} via Simbox.\n`);
  } else {
    out.write(
      `${pc.yellow("!")} ${pc.bold("agent-device")} not found on PATH — install it, then:\n`,
    );
  }
  if (bootedDevice)
    out.write(
      `  Warm: ${pc.bold(bootedDevice.name)} (${platform === "ios" ? "iOS" : "API"} ${bootedDevice.os})\n`,
    );

  out.write(`\n  ${pc.cyan(`simbox exec open <app> --platform ${platform}`)}\n`);
  out.write(`  ${pc.cyan(`simbox exec snapshot -i --platform ${platform}`)}\n`);
  out.write(`  ${pc.cyan(`simbox exec close --platform ${platform}`)}\n`);
  out.write(
    `  Pass --platform ${platform} whenever both an iOS and an Android run are active. \`open\` leases a device; \`close\` releases it.\n`,
  );
  out.write(
    `  This run (${info.runId}) is reserved for this agent; other agents get their own. SIMBOX_RUN=${info.runId} pins a shell to it.\n`,
  );
  out.write("  exec supplies auth and allows 5 minutes for a cold boot.\n\n");
  out.write(pc.dim("  manual connect:\n"));
  out.write(`  ${pc.cyan(`export AGENT_DEVICE_DAEMON_AUTH_TOKEN=${info.daemonToken}`)}\n`);
  out.write(
    `  ${pc.cyan(`agent-device connect proxy --daemon-base-url ${base} --session ${session}`)}\n`,
  );
  out.write(
    `  ${pc.cyan(`agent-device open <app> --platform ${platform} --session ${session} --timeout 300000`)}\n`,
  );
}
