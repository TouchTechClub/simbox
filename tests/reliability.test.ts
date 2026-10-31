import { expect, test } from "bun:test";
import {
  iosSlim,
  patchSource,
  simlockLoad,
  simlockSettings,
  warmReady,
} from "../packages/agent/src/simlock.js";
import { hostMismatch, hostPlatform } from "../packages/agent/src/platform.js";
import { androidSystemImage, androidDirectories } from "../packages/agent/src/android.js";
import { WORKFLOW_YAML } from "../packages/shared/src/workflow.js";
import { dispatchWorkflow } from "../apps/api/src/github.js";

test("a run prepares its own platform and fails on a host that cannot run it", () => {
  expect(hostPlatform("darwin")).toBe("ios");
  expect(hostPlatform("linux")).toBe("android");
  expect(hostPlatform("darwin", "android")).toBe("android");
  expect(hostMismatch("ios", "darwin")).toBeNull();
  expect(hostMismatch("android", "linux")).toBeNull();
  expect(hostMismatch("ios", "linux")).toContain("macOS");
  expect(hostMismatch("android", "darwin")).toContain("Linux x64");
});

test("Android uses the host ABI and platform-aware workflow selects runner label arrays", () => {
  expect(androidSystemImage("x64")).toBe("system-images;android-35;google_apis;x86_64");
  expect(androidSystemImage("arm64")).toBe("system-images;android-35;google_apis;arm64-v8a");
  expect(WORKFLOW_YAML).toContain("options: [ios, android]");
  expect(WORKFLOW_YAML).toContain(
    "inputs.platform == 'android' && '[\"ubuntu-latest\"]' || '[\"macos-latest\"]'",
  );
  expect(WORKFLOW_YAML).toContain("fromJSON(inputs.runner_labels");
  expect(WORKFLOW_YAML).toContain("platform: ${{ inputs.platform }}");
});

test("AVD creation and discovery share explicit directories across SDK generations", () => {
  expect(androidDirectories({ HOME: "/home/runner" })).toEqual({
    userHome: "/home/runner/.android",
    avdHome: "/home/runner/.android/avd",
  });
  expect(
    androidDirectories({ HOME: "/home/runner", ANDROID_USER_HOME: "/custom/android" }),
  ).toEqual({ userHome: "/custom/android", avdHome: "/custom/android/avd" });
  expect(
    androidDirectories({ HOME: "/home/runner", ANDROID_AVD_HOME: "/custom/avds" }).avdHome,
  ).toBe("/custom/avds");
});

test("workflow dispatch always carries platform and exact runner labels", async () => {
  const original = globalThis.fetch;
  const bodies: unknown[] = [];
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string));
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  try {
    await dispatchWorkflow("test", "owner/repo", "main", { platform: "android" });
    await dispatchWorkflow("test", "owner/repo", "main", {
      platform: "ios",
      simboxRun: "0b8f3c1e-8a4e-4d7c-9a51-3f0e8b2f6a10",
    });
    await dispatchWorkflow("test", "owner/repo", "main", {
      platform: "android",
      runner: { labels: ["self-hosted", "linux", "x64", "kvm"] },
    });
    expect(bodies).toEqual([
      { ref: "main", inputs: { platform: "android", runner_labels: '["ubuntu-latest"]' } },
      {
        ref: "main",
        inputs: {
          platform: "ios",
          runner_labels: '["xcode-27"]',
          simbox_run: "0b8f3c1e-8a4e-4d7c-9a51-3f0e8b2f6a10",
        },
      },
      {
        ref: "main",
        inputs: { platform: "android", runner_labels: '["self-hosted","linux","x64","kvm"]' },
      },
    ]);
  } finally {
    globalThis.fetch = original;
  }
});

test("Simlock warms only the run's target and caps leases at the run's devices", () => {
  const ios = Object.fromEntries(
    simlockSettings({
      target: { platform: "ios", model: "iPhone 17", count: 1 },
      maxDevices: 3,
      osVersion: "26.5",
    }),
  );
  expect(ios["warmPool.targets"]).toBe('[{"platform":"ios","model":"iPhone 17","count":1}]');
  expect(ios["lease.maxPerRequester"]).toBe("3");
  expect(ios["update.check"]).toBe("false");
  expect(ios["capabilities.agent-device.enabled"]).toBe("true");
  expect(ios["android.emulator.headless"]).toBeUndefined();
  expect(ios["capacity.config.limits.ios.maxDevices"]).toBe("4");
  expect(ios["ios.defaultMode"]).toBe("slim");
  expect(ios["ios.slim.bootTimeoutMs"]).toBe("600000");
  const android = Object.fromEntries(
    simlockSettings({
      target: { platform: "android", model: "pixel_8", osVersion: "35", count: 1 },
      maxDevices: 0,
      osVersion: "35",
    }),
  );
  expect(android["lease.maxPerRequester"]).toBe("1");
  expect(android["capacity.config.limits.android.maxDevices"]).toBe("2");
  expect(android["android.emulator.headless"]).toBe("true");
  expect(android["downloads.acceptAndroidLicenses"]).toBe("true");
  expect(android["ios.defaultMode"]).toBeUndefined();
  // Slim needs iOS 18.5; older runtimes keep Simlock's default full mode.
  expect(iosSlim("18.5")).toBe(true);
  expect(iosSlim("18.4")).toBe(false);
  const old = simlockSettings({
    target: { platform: "ios", model: "iPhone 16", count: 1 },
    maxDevices: 1,
    osVersion: "18.4",
  });
  expect(Object.fromEntries(old)["ios.defaultMode"]).toBeUndefined();
});

test("Simlock timeout patches are exact and idempotent", () => {
  const from = "const BOOTSTATUS_TIMEOUT_MS = 120_000;";
  const to = "const BOOTSTATUS_TIMEOUT_MS = 600_000;";
  const patched = patchSource(`a\n${from}\nb`, from, to);
  expect(patched).toBe(`a\n${to}\nb`);
  expect(patchSource(patched, from, to)).toBe(patched);
  expect(() => patchSource("const BOOTSTATUS_TIMEOUT_MS = 90_000;", from, to)).toThrow("not found");
});

test("idle counts leases and queued requests, not warm devices", () => {
  expect(simlockLoad({})).toEqual({ leases: 0, queued: 0 });
  expect(simlockLoad({ leases: [{ id: "a" }, { id: "b" }], queueDepth: 1 })).toEqual({
    leases: 2,
    queued: 1,
  });
  const warm = { targets: [{ model: "iPhone 17", count: 1, ready: 1, booting: 0 }] };
  expect(warmReady({ warmPool: warm })).toBe(1);
  expect(simlockLoad({ warmPool: warm }).leases).toBe(0);
  expect(warmReady({})).toBe(0);
});
