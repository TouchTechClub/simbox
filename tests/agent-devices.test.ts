import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pickDevice } from "../packages/shared/src/device-catalog";
import { buildIOSCatalog } from "../packages/agent/src/ios";
import { ensureSimulator } from "../packages/agent/src/xcode";
import {
  buildAndroidCatalog,
  parseHardwareProfiles,
  parseSystemImageApis,
} from "../packages/agent/src/android";
import { printableCatalog } from "../packages/agent/src/platform";
import { childEnv, run } from "../packages/agent/src/proc";
import { HttpError, runIsOver } from "../packages/agent/src/api";
import { createStage, jobStartedAt } from "../packages/agent/src/stage";

const type = (name: string, minRuntimeVersion = 0, productFamily?: string) => ({
  identifier: `com.apple.CoreSimulator.SimDeviceType.${name.replace(/ /g, "-")}`,
  name,
  minRuntimeVersion,
  ...(productFamily ? { productFamily } : {}),
});
const runtime = (version: string, types: Array<ReturnType<typeof type>>, platform = "iOS") => ({
  identifier: `com.apple.CoreSimulator.SimRuntime.${platform}-${version.replace(".", "-")}`,
  version,
  name: `${platform} ${version}`,
  platform,
  isAvailable: true,
  supportedDeviceTypes: types.map(({ identifier, name }) => ({ identifier, name })),
});

const ipad = type("iPad Pro 13-inch (M4)", 3, "iPad");
const phone16 = type("iPhone 16 Pro", 2, "iPhone");
const phone17e = type("iPhone 17e", 4, "iPhone");
const phone17 = type("iPhone 17", 4, "iPhone");
const duo = type("iPhone Duo", 5, "iPhone");
const watch = type("Apple Watch Series 10", 6, "Apple Watch");

test("the iOS catalog lists runtimes newest first and phones before tablets", () => {
  const catalog = buildIOSCatalog(
    [ipad, phone16, phone17e, phone17, duo, watch, type("iPhone 6", 0, "iPhone")],
    [
      runtime("18.4", [phone16, ipad]),
      runtime("27.1", [phone17e, phone17, duo, ipad]),
      runtime("27.0", [phone17e, phone17, phone16, ipad]),
      runtime("11.0", [watch], "watchOS"),
    ],
    ["27.1", "26.4"],
  );
  expect(catalog.os.map((os) => os.version)).toEqual(["27.1", "27.0", "18.4"]);
  expect(catalog.os[0]!.name).toBe("iOS 27.1");
  // Unsupported by every installed runtime (iPhone 6) and non-iOS families are dropped.
  expect(catalog.models.map((m) => m.name)).toEqual([
    "iPhone Duo",
    "iPhone 17",
    "iPhone 17e",
    "iPhone 16 Pro",
    "iPad Pro 13-inch (M4)",
  ]);
  expect(catalog.models.find((m) => m.foldable)?.name).toBe("iPhone Duo");
  expect(catalog.defaults).toEqual({ model: phone17e.identifier, os: "27.1" });
  expect(catalog.xcode).toEqual(["27.1", "26.4"]);

  // The shared picker resolves requests against it.
  const pick = (selector: Parameters<typeof pickDevice>[0]) => {
    const result = pickDevice(selector, catalog);
    return result.ok ? `${result.model.name} @ ${result.os.version}` : result.error;
  };
  expect(pick(null)).toBe("iPhone 17e @ 27.1");
  expect(pick({ model: "iPhone 16 Pro" })).toBe("iPhone 16 Pro @ 27.0");
  expect(pick({ os: "18" })).toBe("iPhone 16 Pro @ 18.4");
  expect(pick({ foldable: true })).toBe("iPhone Duo @ 27.1");
  expect(pick({ os: "17.5" })).toContain("available: 27.1, 27.0, 18.4");
  expect(pick({ model: "iPhone Duo", os: "27.0" })).toContain("cannot run OS 27.0");
});

test("a simulator of the chosen type and runtime is reused, else created in the default set", async () => {
  const devices = {
    [runtime("27.1", []).identifier]: [
      { name: "iPhone 17", udid: "OTHER", deviceTypeIdentifier: phone17.identifier },
      { name: "iPhone 17e", udid: "SHUTDOWN", deviceTypeIdentifier: phone17e.identifier },
      {
        name: "iPhone 17e",
        udid: "BOOTED",
        state: "Booted",
        deviceTypeIdentifier: phone17e.identifier,
      },
    ],
  };
  const calls: string[][] = [];
  const fake = (async (cmd: string[]) => {
    calls.push(cmd);
    if (cmd[2] === "list") return { code: 0, stdout: JSON.stringify({ devices }), stderr: "" };
    return { code: 0, stdout: "6C1F2E7A-0000-4000-8000-000000000001\n", stderr: "" };
  }) as typeof run;
  const r271 = runtime("27.1", []);
  expect(await ensureSimulator(phone17e, r271, fake)).toBe("BOOTED");
  expect(calls.some((cmd) => cmd.includes("create"))).toBe(false);
  expect(await ensureSimulator(phone16, r271, fake)).toBe("6C1F2E7A-0000-4000-8000-000000000001");
  expect(calls.at(-1)).toEqual([
    "xcrun",
    "simctl",
    "create",
    "iPhone 16 Pro",
    phone16.identifier,
    r271.identifier,
  ]);
  const failing = (async (cmd: string[]) =>
    cmd[2] === "list"
      ? { code: 0, stdout: '{"devices":{}}', stderr: "" }
      : { code: 1, stdout: "", stderr: "Invalid runtime" }) as typeof run;
  await expect(ensureSimulator(phone16, r271, failing)).rejects.toThrow("could not create");
});

test("Android system images: google_apis for this ABI, API 28+, both package spellings", () => {
  const listing = `Installed packages:
  system-images;android-26;google_apis;x86_64 | 1 | installed old image
Available Packages:
  system-images;android-27;google_apis;x86_64 | 1 | too old
  system-images;android-28;google_apis;x86_64 | 1 | ok
  system-images;android-35;google_apis;x86_64 | 9 | ok
  system-images;android-35;google_apis_playstore;x86_64 | 9 | play store
  system-images;android-36;google_apis;arm64-v8a | 1 | wrong abi
  system-images;android-37;google_apis;x86_64 | 1 | duplicate level
  system-images;android-37.0;google_apis;x86_64 | 1 | ok
  system-images;android-Baklava;google_apis;x86_64 | 1 | preview`;
  expect(parseSystemImageApis(listing, "x64")).toEqual(["37", "35", "28"]);
  expect(parseSystemImageApis(listing, "arm64")).toEqual(["36"]);
  const catalog = buildAndroidCatalog(["35", "30"], []);
  expect(catalog.os.map((os) => os.version)).toEqual(["37.0", "35", "30"]);
  expect(catalog.defaults).toEqual({ model: "pixel_6", os: "37.0" });
});

test("Android hardware profiles: phones, then foldables, then tablets; no TVs or watches", () => {
  const models = parseHardwareProfiles(
    [
      "automotive_1024p_landscape",
      "Galaxy Nexus",
      "pixel_tablet",
      "pixel_6",
      "pixel_10",
      "pixel_9_pro",
      "7.6in Foldable",
      "pixel_fold",
      "10.1in WXGA (Tablet)",
      "tv_1080p",
      "wearos_small_round",
      "",
    ].join("\n"),
  );
  expect(models.map((m) => m.id)).toEqual([
    "pixel_10",
    "pixel_9_pro",
    "pixel_6",
    "Galaxy Nexus",
    "pixel_fold",
    "7.6in Foldable",
    "pixel_tablet",
    "10.1in WXGA (Tablet)",
  ]);
  expect(models.find((m) => m.id === "pixel_9_pro")?.name).toBe("Pixel 9 Pro");
  expect(models.filter((m) => m.foldable).map((m) => m.id)).toEqual([
    "pixel_fold",
    "7.6in Foldable",
  ]);
  const catalog = buildAndroidCatalog(["35"], models);
  const pick = pickDevice({ model: "Pixel 9 Pro", os: "37" }, catalog);
  expect(pick.ok && [pick.model.id, pick.os.version]).toEqual(["pixel_9_pro", "37.0"]);
});

test("catalog reports drop entries the API would reject instead of failing whole", () => {
  const catalog = printableCatalog({
    os: [
      { version: "35", name: "Android API 35" },
      { version: "36", name: 'bad "quote"' },
    ],
    models: [
      { id: "pixel_6", name: "Pixel 6" },
      { id: "x\ny", name: "newline" },
    ],
    defaults: { model: "pixel_6", os: "35" },
  });
  expect(catalog.os.map((os) => os.version)).toEqual(["35"]);
  expect(catalog.models.map((m) => m.id)).toEqual(["pixel_6"]);
});

test("children never inherit the repo secret; a missing tool is exit 127, not a crash", async () => {
  const env = childEnv({ EXTRA: "1" }, { PATH: "/bin", SIMBOX_TOKEN: "secret", HOME: "/h" });
  expect(env).toEqual({ PATH: "/bin", HOME: "/h", EXTRA: "1" });
  const original = Bun.env.SIMBOX_TOKEN;
  Bun.env.SIMBOX_TOKEN = "secret";
  try {
    const printed = await run(["/bin/sh", "-c", 'printf "%s" "${SIMBOX_TOKEN:-unset}"']);
    expect(printed.stdout).toBe("unset");
  } finally {
    if (original === undefined) delete Bun.env.SIMBOX_TOKEN;
    else Bun.env.SIMBOX_TOKEN = original;
  }
  const missing = await run(["simbox-definitely-missing-tool", "+short"]);
  expect(missing.code).toBe(127);
});

test("register/heartbeat 409 run_over (and heartbeat 404) mean the run is over", () => {
  expect(runIsOver(new HttpError(409, '{"error":"run_over"}'))).toBe(true);
  expect(runIsOver(new HttpError(409, '{"error":"conflict_other"}'))).toBe(false);
  expect(runIsOver(new HttpError(404, "{}"))).toBe(false);
  expect(runIsOver(new HttpError(404, "{}"), { notFound: true })).toBe(true);
  expect(runIsOver(new HttpError(500, '{"error":"run_over"}'))).toBe(false);
  expect(runIsOver(new Error("network"))).toBe(false);
});

test("staged mode writes ready and exit-code and waits for go; legacy mode does nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "simbox-stage-"));
  try {
    const stage = createStage(join(dir, "stage"));
    expect(stage.staged).toBe(true);
    stage.markReady();
    expect(existsSync(join(dir, "stage/ready"))).toBe(true);
    let polls = 0;
    const waiting = stage.waitForGo({
      pollMs: 5,
      check: () => {
        if (++polls === 3) void Bun.write(join(dir, "stage/go"), "");
      },
    });
    await waiting;
    expect(polls).toBeGreaterThanOrEqual(3);
    stage.recordExit(3);
    expect(await Bun.file(join(dir, "stage/exit-code")).text()).toBe("3\n");

    const legacy = createStage(undefined);
    expect(legacy.staged).toBe(false);
    await legacy.waitForGo(); // returns at once
    legacy.recordExit(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the hard-exit clock starts at the recorded job start when it is sane", () => {
  const now = 1_800_000_000_000;
  expect(jobStartedAt("1799999000", now)).toBe(1_799_999_000_000);
  expect(jobStartedAt(undefined, now)).toBe(now);
  expect(jobStartedAt("", now)).toBe(now);
  expect(jobStartedAt("soon", now)).toBe(now);
  expect(jobStartedAt("1900000000", now)).toBe(now); // in the future
});
