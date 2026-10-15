import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { run } from "./proc.js";
import { info, warn } from "./log.js";

const APPLICATIONS = "/Applications";

interface Runtime {
  identifier: string;
  version: string;
  platform?: string;
  isAvailable?: boolean;
  supportedDeviceTypes?: Array<{ identifier: string; name: string }>;
}

interface DeviceType {
  identifier: string;
  name: string;
}

interface Simulator {
  name: string;
  udid: string;
  deviceTypeIdentifier?: string;
  isAvailable?: boolean;
}

export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
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

const developerDir = (app: string) => join(APPLICATIONS, app, "Contents", "Developer");

async function simctlJson<T>(args: string[], developer?: string): Promise<T> {
  const result = await run(["xcrun", "simctl", "list", ...args, "-j"], {
    timeoutMs: 120_000,
    ...(developer ? { env: { DEVELOPER_DIR: developer } } : {}),
  });
  if (result.code !== 0)
    throw new Error(`simctl list ${args.join(" ")} failed: ${result.stderr.trim().slice(-300)}`);
  return JSON.parse(result.stdout) as T;
}

const isFoldableType = (type: DeviceType) =>
  type.name.startsWith("iPhone") && /\bDuo\b/.test(type.name);

/** The iPhone Duo device type and the newest available iOS runtime that can run it. */
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
          candidate.isAvailable !== false &&
          (candidate.platform ?? "iOS") === "iOS" &&
          candidate.identifier.includes(".iOS-") &&
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
 * The iPhone Duo to boot: an existing one on the newest runtime that supports
 * it, else one created in the default device set (fold refuses custom sets).
 */
export async function ensureFoldableSimulator(): Promise<string> {
  const [{ devicetypes }, { runtimes }] = await Promise.all([
    simctlJson<{ devicetypes: DeviceType[] }>(["devicetypes"]),
    simctlJson<{ runtimes: Runtime[] }>(["runtimes"]),
  ]);
  const target = foldableTarget(devicetypes, runtimes);
  if (!target)
    throw new Error(
      "this Xcode has no iOS runtime that can run an iPhone Duo; use Xcode 27.1 or later",
    );
  const { devices } = await simctlJson<{ devices: Record<string, Simulator[]> }>([
    "devices",
    "available",
  ]);
  const existing = (devices[target.runtime.identifier] ?? []).find(
    (device) => device.deviceTypeIdentifier === target.type.identifier && !!device.udid,
  );
  if (existing) return existing.udid;
  const created = await run(
    [
      "xcrun",
      "simctl",
      "create",
      target.type.name,
      target.type.identifier,
      target.runtime.identifier,
    ],
    { timeoutMs: 120_000 },
  );
  const udid = created.stdout.trim();
  if (created.code !== 0 || !/^[0-9A-F-]{36}$/i.test(udid))
    throw new Error(
      `could not create ${target.type.name} on iOS ${target.runtime.version}: ${created.stderr.trim().slice(-300)}`,
    );
  info(`created ${target.type.name} on iOS ${target.runtime.version}`);
  return udid;
}
