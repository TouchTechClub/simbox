import { run } from "./proc.js";
import { info, warn } from "./log.js";

interface Simulator {
  name: string;
  udid: string;
  state?: string;
  isAvailable?: boolean;
}

export function selectWarmSimulator(devices: Record<string, Simulator[]>): Simulator | null {
  const phones = Object.values(devices)
    .flat()
    .filter(
      (device) => device.name.startsWith("iPhone") && device.isAvailable !== false && !!device.udid,
    );
  return phones.find((device) => device.name === "iPhone 17e") ?? phones[0] ?? null;
}

/** Cold boot/build saturates small GH Macs; finish it before starting a tunnel. */
export async function prepareIOS(agentDeviceBin: string): Promise<void> {
  const started = Date.now();
  const deadline = started + 10 * 60_000;
  const inventory = await run(["xcrun", "simctl", "list", "devices", "available", "-j"], {
    timeoutMs: 15_000,
  });
  if (inventory.code !== 0) throw new Error("could not inspect iOS simulator inventory");
  const device = selectWarmSimulator(
    (JSON.parse(inventory.stdout) as { devices: Record<string, Simulator[]> }).devices,
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
