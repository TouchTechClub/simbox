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
import { DeviceRequestError } from "../packages/agent/src/platform.js";
import type { ChildProc } from "../packages/agent/src/proc.js";

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

interface Provisioned {
  avdArgs: string[];
  sdkCalls: string[][];
  booted: unknown;
  emulatorAlive: boolean;
}

/** A fake SDK whose tools record their arguments; the emulator "boots" at once. */
async function provision(
  selector: DeviceProfile | null,
  options: { deviceList?: string; emulatorDies?: boolean } = {},
): Promise<Provisioned> {
  const dir = await mkdtemp(join(tmpdir(), "simbox-android-test-"));
  const keys = [
    "ANDROID_HOME",
    "ANDROID_SDK_ROOT",
    "ANDROID_USER_HOME",
    "ANDROID_AVD_HOME",
    "ANDROID_EMULATOR_HOME",
    "SDK_LOG",
    "SDK_LISTING",
    "SIMBOX_TOKEN",
  ];
  const original = Object.fromEntries(keys.map((key) => [key, Bun.env[key]]));
  let child: ChildProc | undefined;
  try {
    const sdk = join(dir, "sdk");
    for (const folder of ["cmdline-tools/latest/bin", "emulator", "platform-tools"])
      await mkdir(join(sdk, folder), { recursive: true });
    const deviceList = options.deviceList ?? "pixel_6\\npixel_8\\n7.6in Foldable\\ntv_1080p";
    const tools: Record<string, string> = {
      "cmdline-tools/latest/bin/sdkmanager": `
        const fs = require('node:fs');
        fs.appendFileSync(process.env.SDK_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
        if (process.argv.includes('--list')) process.stdout.write(fs.readFileSync(process.env.SDK_LISTING, 'utf8'));
      `,
      "cmdline-tools/latest/bin/avdmanager": `
        const fs = require('node:fs'); const args = process.argv.slice(2);
        if (args[0] === 'list') { console.log('${deviceList}'); process.exit(0); }
        const path = args[args.indexOf('--path') + 1];
        if (!process.env.ANDROID_AVD_HOME || !path.endsWith('simbox.avd')) process.exit(1);
        fs.mkdirSync(path, { recursive: true });
        fs.writeFileSync(path + '/config.ini', 'AvdId=simbox\\n');
        fs.writeFileSync(process.env.ANDROID_AVD_HOME + '/avdmanager-args', JSON.stringify(args));
      `,
      "emulator/emulator": `
        if (process.argv.includes('-accel-check')) process.exit(0);
        if (process.env.SIMBOX_TOKEN) process.exit(9);
        ${options.emulatorDies ? "process.exit(1);" : ""}
        const fs = require('node:fs'); const path = process.env.ANDROID_AVD_HOME + '/simbox.ini';
        if (!fs.readFileSync(path, 'utf8').includes('simbox.avd')) process.exit(1);
        fs.writeFileSync(process.env.ANDROID_AVD_HOME + '/alive', '');
        setInterval(() => {}, 1000);
      `,
      "platform-tools/adb": `
        const fs = require('node:fs');
        console.log(fs.existsSync(process.env.ANDROID_AVD_HOME + '/alive') ? '1' : '0');
      `,
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
    Bun.env.SIMBOX_TOKEN = "repo-secret"; // children must never see it
    await configureAndroidEnvironment();
    const adapter = createAndroidAdapter({
      arch: "x64",
      bootTimeoutMs: 5000,
      onEmulator: (proc) => {
        child = proc;
      },
    });
    const choice = await adapter.select(selector);
    const booted = await adapter.boot(choice);
    const sdkCalls = (await Bun.file(join(dir, "sdk-log")).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(await Bun.file(join(dir, "avds/simbox.ini")).text()).toContain(
      `path=${dir}/avds/simbox.avd`,
    );
    return {
      avdArgs: JSON.parse(await Bun.file(join(dir, "avds/avdmanager-args")).text()) as string[],
      sdkCalls,
      booted,
      emulatorAlive: child?.exitCode === null,
    };
  } finally {
    if (child && child.exitCode === null) {
      child.kill();
      await child.exited;
    }
    for (const key of keys) {
      if (original[key] === undefined) delete Bun.env[key];
      else Bun.env[key] = original[key];
    }
    await rm(dir, { recursive: true, force: true });
  }
}

test("defaults boot pixel_6 on the pinned API without listing the SDK repository", async () => {
  const result = await provision(null);
  expect(result.avdArgs[result.avdArgs.indexOf("-d") + 1]).toBe("pixel_6");
  expect(result.avdArgs[result.avdArgs.indexOf("-k") + 1]).toBe(
    "system-images;android-37.0;google_apis;x86_64",
  );
  expect(result.sdkCalls.some((args) => args.includes("--list"))).toBe(false);
  expect(result.sdkCalls).toContainEqual([
    "platform-tools",
    "emulator",
    "platforms;android-37.0",
    "system-images;android-37.0;google_apis;x86_64",
  ]);
  expect(result.emulatorAlive).toBe(true);
  expect(result.booted).toEqual({
    model: "Pixel 6",
    os: "37.0",
    name: "simbox",
    id: "emulator-5554",
  });
}, 15_000);

test("a requested API and model install exactly those packages", async () => {
  const result = await provision({ model: "Pixel 8", os: "35" });
  expect(result.sdkCalls.some((args) => args.includes("--list"))).toBe(true);
  expect(result.avdArgs[result.avdArgs.indexOf("-d") + 1]).toBe("pixel_8");
  expect(result.sdkCalls).toContainEqual([
    "platform-tools",
    "emulator",
    "platforms;android-35",
    "system-images;android-35;google_apis;x86_64",
  ]);
}, 15_000);

test("a foldable run creates the AVD from a foldable hardware profile", async () => {
  const result = await provision({ foldable: true });
  expect(result.avdArgs[result.avdArgs.indexOf("-d") + 1]).toBe("7.6in Foldable");
}, 15_000);

test("a device or API the runner cannot provide is a request error, never a substitute", async () => {
  await expect(provision({ model: "pixel_99" })).rejects.toBeInstanceOf(DeviceRequestError);
  await expect(provision({ os: "27" })).rejects.toThrow("not available on this runner");
  await expect(provision({ os: "36" })).rejects.toThrow("available: 37.0, 35, 30");
}, 30_000);

test("an emulator that dies during boot fails preparation", async () => {
  await expect(provision(null, { emulatorDies: true })).rejects.toThrow("failed to boot");
}, 15_000);

test("foldables prefer pixel_fold when the SDK ships it", () => {
  expect(androidHardwareProfile(true, ["pixel_fold", "7.6in Foldable"])).toBe("pixel_fold");
  expect(androidHardwareProfile(true, ["7.6in Foldable"])).toBe("7.6in Foldable");
  expect(androidHardwareProfile(false, ["pixel_fold"])).toBe("pixel_6");
});
