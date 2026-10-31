import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DeviceProfile } from "../packages/shared/src/device-profile";
import {
  androidHardwareProfile,
  configureAndroidEnvironment,
  createAndroidAdapter,
} from "../packages/agent/src/android.js";
import {
  bootedFromChoice,
  DeviceRequestError,
  type DeviceChoice,
} from "../packages/agent/src/platform.js";

const LISTING = `Installed packages:
  Path                                        | Version | Description | Location
  system-images;android-30;google_apis;x86_64 | 10      | Google APIs | system-images/android-30/google_apis/x86_64/
Available Packages:
  system-images;android-27;google_apis;x86_64   | 11 | old
  system-images;android-35;google_apis;x86_64   | 9  | Google APIs Intel x86_64 Atom System Image
  system-images;android-35;google_apis;arm64-v8a | 9 | arm
  system-images;android-36.1;google_apis_playstore;x86_64 | 1 | play store
  system-images;android-37.0;google_apis;x86_64 | 1  | Google APIs Intel x86_64 Atom System Image
`;

interface Prepared {
  choice: DeviceChoice;
  sdkCalls: string[][];
  model: string;
}

/** A fake SDK whose tools record their arguments. Simlock creates and boots the AVD. */
async function prepare(
  selector: DeviceProfile | null,
  options: { deviceList?: string; installFails?: boolean } = {},
): Promise<Prepared> {
  const dir = await mkdtemp(join(tmpdir(), "simbox-android-test-"));
  const keys = [
    "ANDROID_HOME",
    "ANDROID_SDK_ROOT",
    "ANDROID_USER_HOME",
    "ANDROID_AVD_HOME",
    "ANDROID_EMULATOR_HOME",
    "SDK_LOG",
    "SDK_LISTING",
    "SDK_FAIL",
  ];
  const original = Object.fromEntries(keys.map((key) => [key, Bun.env[key]]));
  try {
    const sdk = join(dir, "sdk");
    for (const folder of ["cmdline-tools/latest/bin", "emulator", "platform-tools"])
      await mkdir(join(sdk, folder), { recursive: true });
    const deviceList = options.deviceList ?? "pixel_6\\npixel_8\\n7.6in Foldable\\ntv_1080p";
    const tools: Record<string, string> = {
      "cmdline-tools/latest/bin/sdkmanager": `
        const fs = require('node:fs'); const args = process.argv.slice(2);
        fs.appendFileSync(process.env.SDK_LOG, JSON.stringify(args) + '\\n');
        if (args.includes('--list')) process.stdout.write(fs.readFileSync(process.env.SDK_LISTING, 'utf8'));
        else if (!args.includes('--licenses') && process.env.SDK_FAIL) process.exit(3);
      `,
      "cmdline-tools/latest/bin/avdmanager": `
        if (process.argv[2] === 'list') { console.log('${deviceList}'); process.exit(0); }
        process.exit(1);
      `,
      "emulator/emulator": `process.exit(0);`,
    };
    for (const [path, source] of Object.entries(tools)) {
      await Bun.write(join(sdk, path), `#!/usr/bin/env node\n${source}\n`);
      await chmod(join(sdk, path), 0o755);
    }
    await Bun.write(join(dir, "listing"), LISTING);
    Bun.env.SDK_LOG = join(dir, "sdk-log");
    Bun.env.SDK_LISTING = join(dir, "listing");
    Bun.env.ANDROID_HOME = sdk;
    Bun.env.ANDROID_USER_HOME = join(dir, "android-user");
    Bun.env.ANDROID_AVD_HOME = join(dir, "avds");
    if (options.installFails) Bun.env.SDK_FAIL = "1";
    else delete Bun.env.SDK_FAIL;
    await configureAndroidEnvironment();
    const adapter = createAndroidAdapter({ arch: "x64" });
    const choice = await adapter.select(selector);
    await adapter.prepare(choice);
    const sdkCalls = (await Bun.file(join(dir, "sdk-log")).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    return { choice, sdkCalls, model: adapter.simlockModel(choice) };
  } finally {
    for (const key of keys) {
      if (original[key] === undefined) delete Bun.env[key];
      else Bun.env[key] = original[key];
    }
    await rm(dir, { recursive: true, force: true });
  }
}

test("defaults install pixel_8 on the pinned API without listing the SDK repository", async () => {
  const result = await prepare(null);
  expect(result.model).toBe("pixel_8");
  expect(bootedFromChoice(result.choice)).toEqual({ model: "Pixel 8", os: "35", name: "Pixel 8" });
  expect(result.sdkCalls.some((args) => args.includes("--list"))).toBe(false);
  expect(result.sdkCalls).toContainEqual([
    "platform-tools",
    "emulator",
    "platforms;android-35",
    "system-images;android-35;google_apis;x86_64",
  ]);
}, 15_000);

test("a requested API and model install exactly those packages", async () => {
  const result = await prepare({ model: "Pixel 6", os: "37.0" });
  expect(result.sdkCalls.some((args) => args.includes("--list"))).toBe(true);
  expect(result.model).toBe("pixel_6");
  expect(result.sdkCalls).toContainEqual([
    "platform-tools",
    "emulator",
    "platforms;android-37.0",
    "system-images;android-37.0;google_apis;x86_64",
  ]);
}, 15_000);

test("a foldable run warms a foldable hardware profile", async () => {
  const result = await prepare({ foldable: true });
  expect(result.model).toBe("7.6in Foldable");
}, 15_000);

test("a device or API the runner cannot provide is a request error, never a substitute", async () => {
  await expect(prepare({ model: "pixel_99" })).rejects.toBeInstanceOf(DeviceRequestError);
  await expect(prepare({ os: "27" })).rejects.toThrow("not available on this runner");
  await expect(prepare({ os: "36" })).rejects.toThrow("available: 37.0, 35, 30");
}, 30_000);

test("an image that cannot be installed fails preparation", async () => {
  await expect(prepare(null, { installFails: true })).rejects.toThrow("could not install API 35");
}, 15_000);

test("foldables prefer pixel_fold when the SDK ships it", () => {
  expect(androidHardwareProfile(true, ["pixel_fold", "7.6in Foldable"])).toBe("pixel_fold");
  expect(androidHardwareProfile(true, ["7.6in Foldable"])).toBe("7.6in Foldable");
  expect(androidHardwareProfile(false, ["pixel_fold"])).toBe("pixel_8");
});
