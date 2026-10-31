/**
 * Android on Linux/KVM: list the SDK's system images and hardware profiles
 * and install the chosen API's packages. Simlock creates the AVD and boots
 * the emulator headlessly; it only warms targets whose image is installed.
 */
import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { compareVersions } from "@simbox/shared";
import type { CatalogModel, DeviceCatalog, DeviceProfile } from "@simbox/shared";
import { PINS } from "./pins.js";
import { endGroup, info, relay, startGroup, warn } from "./log.js";
import { run, which } from "./proc.js";
import { pickOrThrow, type DeviceChoice, type PlatformAdapter } from "./platform.js";

/** A Simlock built-in profile (alias of "Pixel 8"), verified on hosted runners. */
export const DEFAULT_ANDROID_MODEL = "pixel_8";
/** The pinned system image's API level ("35"). */
export const DEFAULT_ANDROID_API = /;android-([\d.]+);/.exec(PINS.androidSystemImage)![1]!;
/** Older images are not worth offering; installed ones are listed regardless. */
const MIN_ANDROID_API = 28;

export function androidAbi(arch: string): string {
  return arch === "arm64" ? "arm64-v8a" : "x86_64";
}

/**
 * SDK package names for an API level. Newer levels are versioned
 * ("android-37.0"), older ones are not ("android-35"); both keep the level
 * exactly as the SDK repository spells it.
 */
export function androidPackages(api: string, arch: string) {
  return {
    platform: `platforms;android-${api}`,
    systemImage: `system-images;android-${api};google_apis;${androidAbi(arch)}`,
  };
}

export function androidSystemImage(arch: string, api = DEFAULT_ANDROID_API): string {
  return androidPackages(api, arch).systemImage;
}

/** API levels with a google_apis image for this ABI in `sdkmanager --list` output, newest first. */
export function parseSystemImageApis(listing: string, arch: string, floor = MIN_ANDROID_API) {
  const abi = androidAbi(arch).replace(/[-_]/g, "[-_]");
  const pattern = new RegExp(
    `(?:^|\\s)system-images;android-(\\d+(?:\\.\\d+)?);google_apis;${abi}(?=\\s|\\||$)`,
    "gm",
  );
  const apis = [...listing.matchAll(pattern)].map((match) => match[1]!);
  return newestFirst(apis.filter((api) => Number(api.split(".")[0]) >= floor));
}

/** Dedupe ("37" and "37.0" are one level; the first spelling wins), newest first. */
function newestFirst(apis: string[]): string[] {
  const unique: string[] = [];
  for (const api of apis) if (!unique.some((u) => compareVersions(u, api) === 0)) unique.push(api);
  return unique.sort((a, b) => compareVersions(b, a));
}

const NOT_A_PHONE = /^(tv|wearos|automotive|desktop|xr)[_-]/i;

export const isFoldableProfile = (id: string) => /fold/i.test(id);

const isTablet = (id: string) =>
  /tablet|^nexus (7|9|10)\b/i.test(id) || Number(/^(\d+(?:\.\d+)?)in\b/.exec(id)?.[1] ?? 0) >= 7;

const prettify = (id: string) =>
  id.includes("_") ? id.replace(/_/g, " ").replace(/\b[a-z]/g, (c) => c.toUpperCase()) : id;

/**
 * `avdmanager list device -c` ids as catalog models: phones, then foldables,
 * then tablets; Pixels first, newest first. TVs, watches and cars are skipped.
 */
export function parseHardwareProfiles(listing: string): CatalogModel[] {
  const ids = [...new Set(listing.split("\n").map((line) => line.trim()))].filter(
    (id) => /^[\w][\w .()+,'-]*$/.test(id) && !NOT_A_PHONE.test(id),
  );
  const rank = (id: string) => (isFoldableProfile(id) ? 1 : isTablet(id) ? 2 : 0);
  const byName = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
  return ids
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        Number(b.startsWith("pixel")) - Number(a.startsWith("pixel")) ||
        byName.compare(b, a),
    )
    .map((id) => ({
      id,
      name: prettify(id),
      ...(isFoldableProfile(id) ? { foldable: true } : {}),
    }));
}

export function buildAndroidCatalog(apis: string[], models: CatalogModel[]): DeviceCatalog {
  return {
    os: newestFirst([...apis, DEFAULT_ANDROID_API]).map((api) => ({
      version: api,
      name: `Android API ${api}`,
    })),
    models,
    defaults: { model: DEFAULT_ANDROID_MODEL, os: DEFAULT_ANDROID_API },
  };
}

/**
 * avdmanager hardware profile. Hosted cmdline-tools lack Android Studio's
 * `pixel_fold`, so foldables fall back to the generic 7.6in Foldable, which
 * has the same hinge and cover/inner displays.
 */
export function androidHardwareProfile(foldable: boolean, available: string[]): string {
  if (!foldable) return DEFAULT_ANDROID_MODEL;
  return ["pixel_fold", "7.6in Foldable"].find((id) => available.includes(id)) ?? "7.6in Foldable";
}

export function androidDirectories(env: Record<string, string | undefined>) {
  const userHome = env.ANDROID_USER_HOME || join(env.HOME || homedir(), ".android");
  return { userHome, avdHome: env.ANDROID_AVD_HOME || join(userHome, "avd") };
}

/** All SDK generations/tools and the daemon must agree on AVD discovery. */
export async function configureAndroidEnvironment(): Promise<void> {
  const dirs = androidDirectories(Bun.env);
  Bun.env.ANDROID_USER_HOME = dirs.userHome;
  Bun.env.ANDROID_EMULATOR_HOME = dirs.userHome;
  Bun.env.ANDROID_AVD_HOME = dirs.avdHome;
  await mkdir(dirs.avdHome, { recursive: true });
}

function firstExisting(candidates: Array<string | null | undefined>): string | null {
  for (const c of candidates) if (c && existsSync(c)) return c;
  return null;
}

export interface AndroidTools {
  sdkRoot: string;
  sdkmanager: string;
  avdmanager: string;
  emulator: string;
  adb: string;
}

export async function findAndroidTools(env = Bun.env): Promise<AndroidTools> {
  const sdkRoot = firstExisting([env.ANDROID_HOME, env.ANDROID_SDK_ROOT]);
  if (!sdkRoot) throw new Error("no ANDROID_HOME/ANDROID_SDK_ROOT; the Android SDK is required");
  const tool = async (name: string) =>
    firstExisting([
      join(sdkRoot, "cmdline-tools", "latest", "bin", name),
      join(sdkRoot, "tools", "bin", name),
      await which(name),
    ]);
  const [sdkmanager, avdmanager] = await Promise.all([tool("sdkmanager"), tool("avdmanager")]);
  if (!sdkmanager || !avdmanager)
    throw new Error(`sdkmanager/avdmanager not found under ${sdkRoot}`);
  return {
    sdkRoot,
    sdkmanager,
    avdmanager,
    emulator: join(sdkRoot, "emulator", "emulator"),
    adb: join(sdkRoot, "platform-tools", "adb"),
  };
}

/** API levels whose google_apis image for this ABI is already on disk. */
async function installedApis(sdkRoot: string, arch: string): Promise<string[]> {
  const names = await readdir(join(sdkRoot, "system-images")).catch(() => [] as string[]);
  return names
    .map((name) => /^android-(\d+(?:\.\d+)?)$/.exec(name)?.[1])
    .filter((api) => api !== undefined)
    .filter((api) =>
      existsSync(join(sdkRoot, "system-images", `android-${api}`, "google_apis", androidAbi(arch))),
    );
}

export function createAndroidAdapter(options: { arch?: string } = {}): PlatformAdapter {
  const arch = options.arch ?? process.arch;
  let found: Promise<AndroidTools> | null = null;
  const tools = () => (found ??= findAndroidTools());

  const profiles = async (): Promise<CatalogModel[]> => {
    const { avdmanager } = await tools();
    const listed = await run([avdmanager, "list", "device", "-c"], { timeoutMs: 120_000 });
    if (listed.code !== 0)
      throw new Error(
        `avdmanager list device exited ${listed.code}: ${listed.stderr.trim().slice(-300)}`,
      );
    return parseHardwareProfiles(listed.stdout);
  };

  /** Installed images plus everything the SDK repository offers (network, ~10-60s). */
  const catalog = async (): Promise<DeviceCatalog> => {
    const { sdkmanager, sdkRoot } = await tools();
    const [listed, models, local] = await Promise.all([
      run([sdkmanager, "--list"], { timeoutMs: 180_000 }),
      profiles(),
      installedApis(sdkRoot, arch),
    ]);
    if (listed.code !== 0)
      throw new Error(
        `sdkmanager --list exited ${listed.code}: ${listed.stderr.trim().slice(-300)}`,
      );
    return buildAndroidCatalog([...parseSystemImageApis(listed.stdout, arch), ...local], models);
  };

  return {
    platform: "android",
    catalog,
    /**
     * Only a requested OS needs the (slow, networked) repository listing;
     * a model needs the hardware profiles; defaults need neither.
     */
    async select(selector: DeviceProfile | null): Promise<DeviceChoice> {
      const { sdkRoot } = await tools();
      let full: DeviceCatalog | undefined;
      let offered: DeviceCatalog;
      if (selector?.os) {
        try {
          full = offered = await catalog();
        } catch (err) {
          warn(
            `could not list the SDK repository; offering installed images only: ${String(err).slice(0, 300)}`,
          );
          offered = buildAndroidCatalog(await installedApis(sdkRoot, arch), await profiles());
        }
      } else {
        const models =
          selector?.model || selector?.foldable
            ? await profiles()
            : [{ id: DEFAULT_ANDROID_MODEL, name: prettify(DEFAULT_ANDROID_MODEL) }];
        offered = buildAndroidCatalog(await installedApis(sdkRoot, arch), models);
      }
      const request =
        selector?.foldable && !selector.model
          ? {
              ...selector,
              foldable: undefined,
              model: androidHardwareProfile(
                true,
                offered.models.map((m) => m.id),
              ),
            }
          : selector;
      const { model, os } = pickOrThrow(request, offered);
      info(`device: ${model.id} on Android API ${os.version}`);
      return { model, os, ...(full ? { catalog: full } : {}) };
    },
    /** Every failure here fails the run: Simlock cannot warm a missing image. */
    async prepare(choice: DeviceChoice): Promise<void> {
      startGroup("Android SDK packages");
      try {
        const t = await tools();
        info(`Android SDK at ${t.sdkRoot}`);
        info(`Android AVD directory: ${Bun.env.ANDROID_AVD_HOME}`);
        // Accept licenses — pipe plenty of "y"s so every prompt is answered.
        const lic = await run([t.sdkmanager, "--licenses"], {
          input: "y\n".repeat(64),
          timeoutMs: 120_000,
        });
        if (lic.code !== 0) warn(`sdkmanager --licenses exited ${lic.code} (continuing)`);
        const { platform, systemImage } = androidPackages(choice.os.version, arch);
        const pkgs = ["platform-tools", "emulator", platform, systemImage];
        info(`sdkmanager ${pkgs.join(" ")}`);
        const inst = await run([t.sdkmanager, ...pkgs], {
          input: "y\n".repeat(16),
          timeoutMs: 600_000,
        });
        for (const l of inst.stdout.split("\n")) if (l.trim()) relay("sdkmanager", l);
        if (inst.code !== 0)
          throw new Error(
            `sdkmanager could not install API ${choice.os.version} (exit ${inst.code}): ${inst.stderr.trim().slice(0, 300)}`,
          );
        const acceleration = await run([t.emulator, "-accel-check"], { timeoutMs: 15_000 });
        info(
          `Android acceleration check (exit ${acceleration.code}): ${acceleration.stdout.trim().slice(0, 500)} ${acceleration.stderr.trim().slice(0, 500)}`,
        );
      } finally {
        endGroup();
      }
    },
    // Simlock accepts avdmanager profile ids ("pixel_8") as model aliases.
    simlockModel: (choice) => choice.model.id,
  };
}
