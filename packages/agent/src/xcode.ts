import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { compareVersions } from "@simbox/shared";
import { run } from "./proc.js";
import { info, warn } from "./log.js";

type Run = typeof run;

const APPLICATIONS = "/Applications";

export interface Runtime {
  identifier: string;
  version: string;
  name?: string;
  platform?: string;
  isAvailable?: boolean;
  supportedDeviceTypes?: Array<{ identifier: string; name: string }>;
}

export interface DeviceType {
  identifier: string;
  name: string;
  productFamily?: string;
  minRuntimeVersion?: number;
}

interface Simulator {
  name: string;
  udid: string;
  state?: string;
  deviceTypeIdentifier?: string;
  isAvailable?: boolean;
}

/**
 * Bundles that are exactly this version. GitHub images also ship
 * `Xcode_<v>_beta.app` beside the release, whose runtimes can differ (the
 * 27.1 beta only offers iOS 27.0, which cannot run an iPhone Duo).
 */
export function xcodeCandidates(version: string): string[] {
  return [`Xcode_${version}.app`, `Xcode_${version}.0.app`, `Xcode-${version}.app`];
}

/** Release Xcode bundles in /Applications, newest first; betas and RCs last. */
export function rankXcodeBundles(names: string[]): string[] {
  const parsed = names
    .map((name) => {
      const match = /^Xcode[_-](\d+(?:\.\d+)*)(.*)\.app$/.exec(name);
      return match ? { name, version: match[1]!, prerelease: match[2] !== "" } : null;
    })
    .filter((entry) => entry !== null);
  return parsed
    .sort(
      (a, b) =>
        Number(a.prerelease) - Number(b.prerelease) || compareVersions(b.version, a.version),
    )
    .map((entry) => entry.name);
}

/** Installed release Xcode versions, newest first (what `--xcode` can select). */
export function xcodeVersions(names: string[]): string[] {
  const versions = rankXcodeBundles(names)
    .map((name) => /^Xcode[_-](\d+(?:\.\d+)*)\.app$/.exec(name)?.[1])
    .filter((version) => version !== undefined);
  return [...new Set(versions)];
}

export async function installedXcodeVersions(): Promise<string[]> {
  return xcodeVersions(await readdir(APPLICATIONS).catch(() => []));
}

const developerDir = (app: string) => join(APPLICATIONS, app, "Contents", "Developer");

export async function simctlJson<T>(
  args: string[],
  developer?: string,
  exec: Run = run,
): Promise<T> {
  const result = await exec(["xcrun", "simctl", "list", ...args, "-j"], {
    timeoutMs: 120_000,
    ...(developer ? { env: { DEVELOPER_DIR: developer } } : {}),
  });
  if (result.code !== 0)
    throw new Error(`simctl list ${args.join(" ")} failed: ${result.stderr.trim().slice(-300)}`);
  return JSON.parse(result.stdout) as T;
}

export const isFoldableType = (type: DeviceType) =>
  type.name.startsWith("iPhone") && /\bDuo\b/.test(type.name);

/** The iPhone Duo device type and the newest available iOS runtime that can run it. */
export const isIOSRuntime = (runtime: Runtime) =>
  runtime.isAvailable !== false &&
  (runtime.platform ?? "iOS") === "iOS" &&
  runtime.identifier.includes(".iOS-");

export function foldableTarget(
  deviceTypes: DeviceType[],
  runtimes: Runtime[],
): { type: DeviceType; runtime: Runtime } | null {
  const types = deviceTypes
    .filter(isFoldableType)
    .sort((a, b) => Number(b.name === "iPhone Duo") - Number(a.name === "iPhone Duo"));
  for (const type of types) {
    const runtime = runtimes
      .filter(
        (candidate) =>
          isIOSRuntime(candidate) &&
          (candidate.supportedDeviceTypes ?? []).some(
            (supported) => supported.identifier === type.identifier,
          ),
      )
      .sort((a, b) => compareVersions(b.version, a.version))[0];
    if (runtime) return { type, runtime };
  }
  return null;
}

async function foldableSupport(developer?: string): Promise<"ready" | "needs-runtime" | "none"> {
  try {
    const [{ devicetypes }, { runtimes }] = await Promise.all([
      simctlJson<{ devicetypes: DeviceType[] }>(["devicetypes"], developer),
      simctlJson<{ runtimes: Runtime[] }>(["runtimes"], developer),
    ]);
    if (foldableTarget(devicetypes, runtimes)) return "ready";
    return devicetypes.some((type) => isFoldableType(type)) ? "needs-runtime" : "none";
  } catch {
    return "none";
  }
}

/**
 * GitHub's Xcode images ship only some simulator runtimes (xcode-27 has iOS
 * 27.0 alone, while the iPhone Duo needs 27.1). Xcode downloads the runtime
 * it was built for; several GB, so this takes minutes.
 */
async function downloadIOSRuntime(): Promise<void> {
  info("downloading the iOS simulator runtime for this Xcode (several minutes)");
  const started = Date.now();
  const result = await run(["xcodebuild", "-downloadPlatform", "iOS"], { timeoutMs: 30 * 60_000 });
  if (result.code !== 0)
    throw new Error(
      `xcodebuild -downloadPlatform iOS failed: ${(result.stderr || result.stdout).trim().slice(-300)}`,
    );
  info(`iOS runtime ready after ${Math.round((Date.now() - started) / 1000)}s`);
}

/**
 * Select the Xcode every later simctl, devicectl and agent-device call uses.
 * Must run before the agent-device daemon starts: it resolves its toolchain
 * once. DEVELOPER_DIR covers this process tree; xcode-select covers anything
 * that ignores it. A foldable also needs an iOS runtime that can run it.
 */
export async function selectXcode(options: { version?: string; foldable: boolean }): Promise<void> {
  const bundles = rankXcodeBundles(await readdir(APPLICATIONS).catch(() => []));
  let app: string | undefined;
  if (options.version) {
    app = xcodeCandidates(options.version).find((name) => existsSync(join(APPLICATIONS, name)));
    if (!app)
      throw new Error(
        `Xcode ${options.version} is not installed on this runner (found ${bundles.join(", ") || "none"}). Choose a runner image that has it, e.g. --runner xcode-27.`,
      );
  } else if (options.foldable && (await foldableSupport()) === "none") {
    // Prefer an Xcode that is ready, then one that only lacks the runtime.
    const support = new Map<string, Awaited<ReturnType<typeof foldableSupport>>>();
    for (const bundle of bundles) support.set(bundle, await foldableSupport(developerDir(bundle)));
    app =
      bundles.find((bundle) => support.get(bundle) === "ready") ??
      bundles.find((bundle) => support.get(bundle) === "needs-runtime");
    if (!app)
      throw new Error(
        `No installed Xcode has the iPhone Duo (found ${bundles.join(", ") || "none"}). Use a runner with Xcode 27.1 or later, e.g. --runner xcode-27 --xcode 27.1.`,
      );
  }
  if (app) {
    const developer = developerDir(app);
    Bun.env.DEVELOPER_DIR = developer;
    const selected = await run(["sudo", "-n", "xcode-select", "-s", developer], {
      timeoutMs: 30_000,
    });
    if (selected.code !== 0)
      warn(
        `xcode-select could not switch (${selected.stderr.trim().slice(0, 200)}); using DEVELOPER_DIR only`,
      );
    info(`using ${app} for simulators and agent-device`);
  }
  if (!options.foldable) return;
  const support = await foldableSupport();
  if (support === "none")
    throw new Error(
      `${app ?? "The selected Xcode"} has no iPhone Duo; use Xcode 27.1 or later, e.g. --xcode 27.1.`,
    );
  if (support === "needs-runtime") {
    await downloadIOSRuntime();
    if ((await foldableSupport()) !== "ready")
      throw new Error("the downloaded iOS runtime cannot run an iPhone Duo");
  }
}

/**
 * A simulator of this type on this runtime: an available one is reused, else
 * one is created in the default device set (agent-device's `fold` refuses
 * custom sets, and the default set is where clients look for devices).
 */
export async function ensureSimulator(
  type: { identifier: string; name: string },
  runtime: { identifier: string; version: string },
  exec: Run = run,
): Promise<string> {
  const { devices } = await simctlJson<{ devices: Record<string, Simulator[]> }>(
    ["devices", "available"],
    undefined,
    exec,
  );
  const matching = (devices[runtime.identifier] ?? []).filter(
    (device) =>
      device.deviceTypeIdentifier === type.identifier &&
      device.isAvailable !== false &&
      !!device.udid,
  );
  const existing = matching.find((device) => device.state === "Booted") ?? matching[0];
  if (existing) return existing.udid;
  const created = await exec(
    ["xcrun", "simctl", "create", type.name, type.identifier, runtime.identifier],
    { timeoutMs: 120_000 },
  );
  const udid = created.stdout.trim();
  if (created.code !== 0 || !/^[0-9A-F-]{36}$/i.test(udid))
    throw new Error(
      `could not create ${type.name} on iOS ${runtime.version}: ${created.stderr.trim().slice(-300)}`,
    );
  info(`created ${type.name} on iOS ${runtime.version}`);
  return udid;
}
