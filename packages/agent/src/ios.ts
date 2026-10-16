import { run } from "./proc.js";
import { info, warn } from "./log.js";

interface Simulator {
  name: string;
  udid: string;
  state?: string;
  isAvailable?: boolean;
}

export function selectWarmSimulator(
  devices: Record<string, Simulator[]>,
  preferredUdid?: string,
): Simulator | null {
  if (preferredUdid)
    return (
      Object.values(devices)
        .flat()
        .find((device) => device.udid === preferredUdid) ?? null
    );
  const phones = Object.values(devices)
    .flat()
    .filter(
      (device) => device.name.startsWith("iPhone") && device.isAvailable !== false && !!device.udid,
    );
  return phones.find((device) => device.name === "iPhone 17e") ?? phones[0] ?? null;
}

/**
 * Hosted Macs have 3 vCPUs. A simulator's first boot saturates them for
 * minutes, and host Spotlight makes it worse by indexing the simulator's files
 * (mds kills and respawns mdworker_shared hundreds of times). Nothing on a CI
 * runner needs Spotlight. Best effort: needs passwordless sudo.
 */
export async function quietHost(): Promise<void> {
  const result = await run(["sudo", "-n", "mdutil", "-a", "-i", "off"], { timeoutMs: 30_000 });
  if (result.code === 0) info("host Spotlight indexing off");
  else warn(`could not turn off Spotlight indexing: ${result.stderr.trim().slice(0, 200)}`);
}

/**
 * Keep the tunnel served while simulators saturate the CPU: a starved
 * cloudflared misses edge heartbeats and drops in-flight requests.
 */
export async function raisePriority(pid: number, name: string): Promise<void> {
  const result = await run(["sudo", "-n", "renice", "-n", "-20", "-p", String(pid)], {
    timeoutMs: 10_000,
  });
  if (result.code !== 0)
    warn(`could not raise ${name} priority: ${result.stderr.trim().slice(0, 200)}`);
}

/** Boot the run's iPhone and build XCTest before the run is announced live. */
export async function prepareIOS(agentDeviceBin: string, preferredUdid?: string): Promise<void> {
  const started = Date.now();
  const deadline = started + 10 * 60_000;
  const inventory = await run(["xcrun", "simctl", "list", "devices", "available", "-j"], {
    timeoutMs: 60_000,
  });
  if (inventory.code !== 0)
    throw new Error(
      `could not inspect iOS simulator inventory (${inventory.code === -1 ? "timed out after 60s" : `exit ${inventory.code}`}): ${inventory.stderr.trim().slice(-500)}`,
    );
  const device = selectWarmSimulator(
    (JSON.parse(inventory.stdout) as { devices: Record<string, Simulator[]> }).devices,
    preferredUdid,
  );
  if (!device) throw new Error("no available iPhone simulator on the runner");
  info(`preparing ${device.name} before exposing the tunnel`);
  if (device.state !== "Booted") {
    const boot = await run(["xcrun", "simctl", "boot", device.udid], { timeoutMs: 15_000 });
    if (boot.code !== 0) throw new Error(`could not start ${device.name}`);
  }
  const booted = await run(["xcrun", "simctl", "bootstatus", device.udid, "-b"], {
    timeoutMs: Math.max(1, deadline - Date.now()),
  });
  if (booted.code !== 0) throw new Error(`${device.name} did not boot within the startup budget`);
  info(`${device.name} booted in ${Math.round((Date.now() - started) / 1000)}s; preparing XCTest`);
  // prepare expects the Simulator UI infrastructure to exist; unlike open it
  // does not launch Simulator.app for a device we booted with simctl ourselves.
  await run(["open", "-a", "Simulator", "--args", "-CurrentDeviceUDID", device.udid], {
    timeoutMs: 15_000,
  });
  const remaining = Math.max(1, deadline - Date.now() - 30_000);
  const prepared = await run(
    [
      agentDeviceBin,
      "prepare",
      "ios-runner",
      "--platform",
      "ios",
      "--udid",
      device.udid,
      "--timeout",
      String(remaining),
    ],
    { timeoutMs: Math.max(1, deadline - Date.now()) },
  );
  if (prepared.code !== 0) {
    warn(`XCTest preparation exited ${prepared.code}: ${prepared.stderr.trim().slice(-1000)}`);
    throw new Error(`XCTest preparation failed for ${device.name}`);
  }
  info(`${device.name} and XCTest ready (no app session allocated)`);
}
