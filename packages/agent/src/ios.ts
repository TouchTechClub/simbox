import { compareVersions } from "@simbox/shared";
import type { CatalogModel, DeviceCatalog } from "@simbox/shared";
import { run } from "./proc.js";
import { info, warn } from "./log.js";
import { pickOrThrow, type DeviceChoice, type PlatformAdapter } from "./platform.js";
import {
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

/** How long the priming boot may take; GitHub's macOS images have taken minutes. */
const PRIME_BOOT_TIMEOUT_MS = 10 * 60_000;

/**
 * Boot, then delete, a throwaway simulator of the chosen model and runtime.
 * A runtime's first boot on a fresh host is the slow one, and it outlasts
 * Simlock's fixed 120s boot limit on hosted Macs (three timeouts in 15 minutes
 * in testing). Best effort: Simlock still boots its own device either way.
 */
export async function primeSimulator(choice: DeviceChoice): Promise<void> {
  const started = Date.now();
  const { runtimes } = await simctlJson<{ runtimes: Runtime[] }>(["runtimes"]);
  const runtime = runtimes.find((r) => isIOSRuntime(r) && r.version === choice.os.version);
  if (!runtime) return warn(`no iOS ${choice.os.version} runtime to prime`);
  const created = await run(
    ["xcrun", "simctl", "create", "simbox-prime", choice.model.id, runtime.identifier],
    { timeoutMs: 120_000 },
  );
  const udid = created.stdout.trim();
  if (created.code !== 0 || !udid)
    return warn(`could not create a priming simulator: ${created.stderr.trim().slice(-300)}`);
  try {
    const booted = await run(["xcrun", "simctl", "bootstatus", udid, "-b"], {
      timeoutMs: PRIME_BOOT_TIMEOUT_MS,
    });
    if (booted.code === 0)
      info(`iOS ${choice.os.version} primed in ${Math.round((Date.now() - started) / 1000)}s`);
    else warn(`priming simulator did not boot (exit ${booted.code}); continuing`);
  } finally {
    await run(["xcrun", "simctl", "shutdown", udid], { timeoutMs: 120_000 });
    await run(["xcrun", "simctl", "delete", udid], { timeoutMs: 120_000 });
  }
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
 * iOS: Xcode selection happens before Simlock starts (it resolves its
 * toolchain once). Simlock creates the simulator in its own device set.
 */
export function createIOSAdapter(): PlatformAdapter {
  const catalog = async () => {
    const [{ devicetypes }, { runtimes }, xcode] = await Promise.all([
      simctlJson<{ devicetypes: DeviceType[] }>(["devicetypes"]),
      simctlJson<{ runtimes: Runtime[] }>(["runtimes"]),
      installedXcodeVersions(),
    ]);
    return buildIOSCatalog(devicetypes, runtimes, xcode);
  };
  return {
    platform: "ios",
    catalog,
    async select(selector) {
      // Without a choice, the newest installed release Xcode.
      await selectXcode({ version: selector?.xcode, foldable: selector?.foldable === true });
      const offered = await catalog();
      const { model, os } = pickOrThrow(selector, offered);
      info(`device: ${model.name} on iOS ${os.version}`);
      return { model, os, catalog: offered };
    },
    prepare: primeSimulator,
    // Simlock names iOS models by their simctl device type name.
    simlockModel: (choice) => choice.model.name,
  };
}
