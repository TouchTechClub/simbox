import { compareVersions } from "@simbox/shared";
import type { BootedDevice, CatalogModel, DeviceCatalog } from "@simbox/shared";
import { run } from "./proc.js";
import { info, warn } from "./log.js";
import { pickOrThrow, type DeviceChoice, type PlatformAdapter } from "./platform.js";
import {
  ensureSimulator,
  installedXcodeVersions,
  isFoldableType,
  isIOSRuntime,
  selectXcode,
  simctlJson,
  type DeviceType,
  type Runtime,
} from "./xcode.js";

/** The documented default phone; GitHub images ship it on their newest runtime. */
export const DEFAULT_IOS_MODEL = "iPhone 17e";

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

/**
 * What an Xcode offers: available iOS runtimes newest first (with the device
 * types each can run), iPhones then iPads newest first, and the default phone
 * on the newest runtime that runs it.
 */
export function buildIOSCatalog(
  deviceTypes: DeviceType[],
  runtimes: Runtime[],
  xcode: string[] = [],
): DeviceCatalog {
  const ios = runtimes.filter(isIOSRuntime).sort((a, b) => compareVersions(b.version, a.version));
  if (ios.length === 0) throw new Error("this Xcode has no available iOS simulator runtime");
  const supported = new Set(
    ios.flatMap((runtime) => (runtime.supportedDeviceTypes ?? []).map((type) => type.identifier)),
  );
  const listsSupport = ios.some((runtime) => runtime.supportedDeviceTypes !== undefined);
  const family = (type: DeviceType) => type.productFamily ?? type.name.split(" ")[0];
  const rank = (type: DeviceType) => (family(type) === "iPhone" ? 0 : 1);
  // simctl lists device types oldest first; newer hardware needs newer runtimes.
  const models: CatalogModel[] = deviceTypes
    .map((type, index) => ({ type, index }))
    .filter(
      ({ type }) =>
        (family(type) === "iPhone" || family(type) === "iPad") &&
        (!listsSupport || supported.has(type.identifier)),
    )
    .sort(
      (a, b) =>
        rank(a.type) - rank(b.type) ||
        (b.type.minRuntimeVersion ?? 0) - (a.type.minRuntimeVersion ?? 0) ||
        b.index - a.index,
    )
    .map(({ type }) => ({
      id: type.identifier,
      name: type.name,
      ...(isFoldableType(type) ? { foldable: true } : {}),
    }));
  const runs = (runtime: Runtime, id: string) =>
    !runtime.supportedDeviceTypes || runtime.supportedDeviceTypes.some((t) => t.identifier === id);
  const phone =
    models.find((model) => model.name === DEFAULT_IOS_MODEL) ??
    models.find((model) => model.name.startsWith("iPhone") && !model.foldable) ??
    models[0];
  const defaultOs = (phone && ios.find((runtime) => runs(runtime, phone.id))) ?? ios[0]!;
  return {
    os: ios.map((runtime) => ({
      version: runtime.version,
      name: runtime.name ?? `iOS ${runtime.version}`,
      ...(runtime.supportedDeviceTypes
        ? { models: runtime.supportedDeviceTypes.map((type) => type.identifier) }
        : {}),
    })),
    models,
    defaults: { model: phone?.id ?? "", os: defaultOs.version },
    ...(xcode.length ? { xcode } : {}),
  };
}

/**
 * iOS: Xcode selection and the simulator happen before the agent-device
 * daemon starts (it resolves its toolchain once); the warmup boots that
 * simulator and builds XCTest once the daemon is up.
 */
export function createIOSAdapter(options: { agentDeviceBin: () => string }): PlatformAdapter {
  let runtimes: Runtime[] = [];
  const catalog = async () => {
    const [{ devicetypes }, listed, xcode] = await Promise.all([
      simctlJson<{ devicetypes: DeviceType[] }>(["devicetypes"]),
      simctlJson<{ runtimes: Runtime[] }>(["runtimes"]),
      installedXcodeVersions(),
    ]);
    runtimes = listed.runtimes;
    return buildIOSCatalog(devicetypes, runtimes, xcode);
  };
  return {
    platform: "ios",
    catalog,
    async select(selector) {
      if (selector?.xcode || selector?.foldable)
        await selectXcode({ version: selector.xcode, foldable: selector.foldable === true });
      const offered = await catalog();
      const { model, os } = pickOrThrow(selector, offered);
      const runtime = runtimes.find((r) => isIOSRuntime(r) && r.version === os.version)!;
      const udid = await ensureSimulator({ identifier: model.id, name: model.name }, runtime);
      info(`device: ${model.name} on iOS ${os.version}`);
      return { model, os, udid, catalog: offered };
    },
    async boot(choice: DeviceChoice): Promise<BootedDevice> {
      const device = await prepareIOS(options.agentDeviceBin(), choice.udid);
      return {
        model: choice.model.name,
        os: choice.os.version,
        name: device.name,
        id: device.udid,
      };
    },
  };
}

/**
 * Boot the run's iPhone and build XCTest before the run is announced live.
 * Throws only if the simulator did not boot; an XCTest build failure is a
 * warning (agent-device builds it on first use).
 */
export async function prepareIOS(
  agentDeviceBin: string,
  preferredUdid?: string,
): Promise<{ name: string; udid: string; xctest: boolean }> {
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
    warn(
      `XCTest preparation failed for ${device.name} (exit ${prepared.code}); agent-device builds it on first use: ${prepared.stderr.trim().slice(-1000)}`,
    );
    return { name: device.name, udid: device.udid, xctest: false };
  }
  info(`${device.name} and XCTest ready (no app session allocated)`);
  return { name: device.name, udid: device.udid, xctest: true };
}
