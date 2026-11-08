import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cachedRunnerBuilds,
  runnerCacheDecisions,
  runnerCacheReport,
  formatTimeline,
  iosSlim,
  KEEP_RECLAIM_ENV,
  DEFAULT_MODEL_ENV,
  defaultDeviceEnv,
  patchSource,
  SIMLOCK_PATCHES,
  simlockLoad,
  simlockSettings,
  UNTIMED_FETCH_INIT,
  warmReady,
} from "../packages/agent/src/simlock.js";
import { hostMismatch, hostPlatform } from "../packages/agent/src/platform.js";
import { SOCKET_BUFFER_SYSCTLS, socketBufferRaises } from "../packages/agent/src/provision.js";
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
      env: { SIMBOX_IOS_SLIM: "1" },
    }),
  );
  expect(ios["warmPool.targets"]).toBe('[{"platform":"ios","model":"iPhone 17","count":1}]');
  expect(ios["lease.maxPerRequester"]).toBe("3");
  expect(ios["update.check"]).toBe("false");
  expect(ios["capabilities.agent-device.enabled"]).toBe("true");
  expect(ios["capabilities.agent-device.leaseTtlCapMs"]).toBe("1800000");
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
  // Slim is opt-in and needs iOS 18.5; otherwise Simlock boots full.
  const on = { SIMBOX_IOS_SLIM: "1" };
  expect(iosSlim("18.5", on)).toBe(true);
  expect(iosSlim("18.4", on)).toBe(false);
  expect(iosSlim("27.2", {})).toBe(false);
  const old = simlockSettings({
    target: { platform: "ios", model: "iPhone 16", count: 1 },
    maxDevices: 1,
    osVersion: "18.4",
    env: on,
  });
  expect(Object.fromEntries(old)["ios.defaultMode"]).toBeUndefined();
  const full = simlockSettings({
    target: { platform: "ios", model: "iPhone 17e", count: 1 },
    maxDevices: 1,
    osVersion: "27.2",
    env: {},
  });
  expect(Object.fromEntries(full)["ios.defaultMode"]).toBeUndefined();
});

test("Simlock timeout patches are exact and idempotent", () => {
  const from = "const BOOTSTATUS_TIMEOUT_MS = 120_000;";
  const to = "const BOOTSTATUS_TIMEOUT_MS = 600_000;";
  const patched = patchSource(`a\n${from}\nb`, from, to);
  expect(patched).toBe(`a\n${to}\nb`);
  expect(patchSource(patched, from, to)).toBe(patched);
  expect(() => patchSource("const BOOTSTATUS_TIMEOUT_MS = 90_000;", from, to)).toThrow("not found");
});

test("the keep file spares one iOS reclaim, then erases resume", async () => {
  const keep = SIMLOCK_PATCHES.find((patch) => patch.to.includes(KEEP_RECLAIM_ENV))!;
  // The reclaim body as Simlock 0.4.0's iOS driver has it, after the patch.
  const Driver = new Function(
    "COMMAND_TIMEOUT_MS",
    `return class {
      calls = [];
      async #shutdown(udid) { this.calls.push("shutdown " + udid); }
      async #simctl(args) { this.calls.push(args.join(" ")); }
      async reclaim(device) {
        const iosDriverData = (d) => d;
${patchSource(keep.from, keep.from, keep.to)}
        return { state: "shutdown", strategy: "erase" };
      }
    };`,
  )(30_000);
  const file = join(mkdtempSync(join(tmpdir(), "simbox-keep-")), "keep");
  const previous = process.env[KEEP_RECLAIM_ENV];
  process.env[KEEP_RECLAIM_ENV] = file;
  try {
    const driver = new Driver();
    expect(await driver.reclaim({ udid: "A" })).toEqual({ state: "shutdown", strategy: "erase" });
    writeFileSync(file, "");
    expect(await driver.reclaim({ udid: "B" })).toEqual({ state: "ready", strategy: "snapshot" });
    expect(existsSync(file)).toBe(false);
    expect(await driver.reclaim({ udid: "C" })).toEqual({ state: "shutdown", strategy: "erase" });
    expect(driver.calls).toEqual(["shutdown A", "erase A", "shutdown C", "erase C"]);
  } finally {
    if (previous === undefined) delete process.env[KEEP_RECLAIM_ENV];
    else process.env[KEEP_RECLAIM_ENV] = previous;
  }
});

test("a request naming no device leases the warm model on the run's OS", () => {
  const patch = SIMLOCK_PATCHES.find((p) => p.to.includes(DEFAULT_MODEL_ENV))!;
  // The spread from Simlock 0.4.0's agent-device front (planOf), after the patch.
  const plan = new Function(
    "device",
    "klass",
    "osVersion",
    `return { platform: "ios", ${patchSource(patch.from, patch.from, patch.to)} ...(osVersion ? { osVersion } : {}) };`,
  ) as (device?: string, klass?: string, osVersion?: string) => Record<string, string>;
  const saved = { ...process.env };
  try {
    Object.assign(
      process.env,
      defaultDeviceEnv({ platform: "ios", model: "iPhone Duo", count: 1 }, "27.2"),
    );
    expect(plan()).toEqual({ platform: "ios", model: "iPhone Duo", osVersion: "27.2" });
    // What the client names still wins.
    expect(plan(undefined, undefined, "26.5")).toEqual({
      platform: "ios",
      model: "iPhone Duo",
      osVersion: "26.5",
    });
    expect(plan("iPhone 17 Pro")).toEqual({ platform: "ios", model: "iPhone 17 Pro" });
    expect(plan(undefined, "tablet")).toEqual({ platform: "ios", class: "tablet" });
    // A pinned target OS beats the chosen one.
    expect(
      defaultDeviceEnv(
        { platform: "ios", model: "iPhone 17e", osVersion: "26.5", count: 1 },
        "27.0",
      ),
    ).toEqual({
      SIMBOX_DEFAULT_MODEL: "iPhone 17e",
      SIMBOX_DEFAULT_OS: "26.5",
    });
    delete process.env.SIMBOX_DEFAULT_MODEL;
    expect(plan()).toEqual({ platform: "ios" });
  } finally {
    for (const key of ["SIMBOX_DEFAULT_MODEL", "SIMBOX_DEFAULT_OS"])
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
  }
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

test("the warm-up timeline keeps boot events, timed from the daemon start", () => {
  const origin = 1_000_000;
  const events = [
    { timestamp: origin + 1_500, event: "daemon.started", payload: {} },
    { timestamp: origin + 2_000, event: "queue.changed", payload: { depth: 0 } },
    { timestamp: origin + 190_000, event: "device.provisioned", payload: { deviceId: "d1" } },
    { timestamp: origin + 223_400, event: "device.ready", payload: { bootDuration: 33_000 } },
  ];
  const stdout = `${events.map((event) => JSON.stringify(event)).join("\n")}\nnot json\n`;
  expect(formatTimeline(stdout, origin)).toEqual([
    "+1.5s daemon.started {}",
    '+190.0s device.provisioned {"deviceId":"d1"}',
    '+223.4s device.ready {"bootDuration":33000}',
  ]);
});

test("socket buffers are raised for cloudflared, never lowered", () => {
  expect(SOCKET_BUFFER_SYSCTLS.darwin).toBeUndefined();
  const linux = SOCKET_BUFFER_SYSCTLS.linux!;
  expect(socketBufferRaises(linux, { "net.core.rmem_max": 212_992 })).toEqual([
    "net.core.rmem_max=7500000",
    "net.core.wmem_max=7500000",
  ]);
  expect(SOCKET_BUFFER_SYSCTLS.win32).toBeUndefined();
});

test("cached Apple runner builds are counted by agent-device's metadata file", async () => {
  const derived = mkdtempSync(join(tmpdir(), "simbox-derived-"));
  expect(await cachedRunnerBuilds(join(derived, "missing"))).toBe(0);
  for (const build of ["cache-0123456789abcdef", "cache-fedcba9876543210"]) {
    mkdirSync(join(derived, "ios-simulator", build, "Build"), { recursive: true });
    writeFileSync(join(derived, "ios-simulator", build, ".agent-device-runner-cache.json"), "{}");
  }
  expect(await cachedRunnerBuilds(derived)).toBe(2);
});

test("Simlock forwards agent-device calls with no undici timeouts", () => {
  const patch = SIMLOCK_PATCHES.find((p) => p.file === "agent-device/host/upstream.js");
  expect(patch?.to).toContain(UNTIMED_FETCH_INIT);
  const init = () => new Function(`return ${UNTIMED_FETCH_INIT};`)() as unknown;
  const key = Symbol.for("undici.globalDispatcher.1");
  const g = globalThis as unknown as Record<symbol | string, unknown>;
  const saved = g[key];
  try {
    delete g[key];
    delete g.__simboxUntimedDispatcher;
    // Before the first fetch there is no dispatcher to copy: plain fetch.
    expect(init()).toBeUndefined();
    class Agent {
      constructor(readonly options: unknown) {}
    }
    g[key] = new Agent({});
    const first = init() as { dispatcher: Agent };
    expect(first.dispatcher.options).toEqual({ headersTimeout: 0, bodyTimeout: 0 });
    expect((init() as { dispatcher: Agent }).dispatcher).toBe(first.dispatcher);
  } finally {
    delete g.__simboxUntimedDispatcher;
    if (saved === undefined) delete g[key];
    else g[key] = saved;
  }
});

test("the runner cache report says whether each build is reusable and what its key changed", async () => {
  const derived = mkdtempSync(join(tmpdir(), "simbox-derived-"));
  const write = (dir: string, metadata: object) => {
    mkdirSync(join(derived, "ios-simulator", dir), { recursive: true });
    writeFileSync(
      join(derived, "ios-simulator", dir, ".agent-device-runner-cache.json"),
      JSON.stringify(metadata),
    );
  };
  const toolchain = { xcodeVersion: "27.0", sdkVersion: "27.0" };
  write("cache-a", { schemaVersion: 3, packageVersion: "0.21.35", toolchain, artifacts: { a: 1 } });
  write("cache-b", {
    schemaVersion: 3,
    packageVersion: "0.21.35",
    toolchain: { ...toolchain, xcodeVersion: "27.1" },
    artifacts: { b: 1 },
  });
  const seen: string[] = [];
  const lines = await runnerCacheReport((dir) => {
    seen.push(dir);
    return dir.endsWith("cache-a")
      ? { ok: false, mismatch: { path: "Build/x", reason: "mode_changed" } }
      : { ok: true };
  }, derived);
  expect(seen).toHaveLength(2);
  expect(lines[0]).toContain("cache-a (agent-device 0.21.35): files refused");
  expect(lines[0]).toContain("mode_changed");
  expect(lines[0]).toContain('key {"schemaVersion":3,"toolchain":{"xcodeVersion":"27.0"');
  expect(lines[0]).not.toContain("artifacts");
  expect(lines[1]).toContain('files intact; key differs: toolchain.xcodeVersion: "27.0" -> "27.1"');
  expect(await runnerCacheReport(() => ({ ok: true }), join(derived, "missing"))).toEqual([]);
});

test("runner cache decisions are read from agent-device diagnostics, oldest first", async () => {
  const root = mkdtempSync(join(tmpdir(), "simbox-diag-"));
  mkdirSync(join(root, "sessions", "s", "requests"), { recursive: true });
  const event = (ts: string, data: object) =>
    JSON.stringify({ ts, level: "info", phase: "runner_xctestrun_cache", data });
  writeFileSync(
    join(root, "sessions", "s", "requests", "a.ndjson"),
    [
      event("2026-11-07T03:30:02Z", { action: "rebuild", reason: "artifact_content_mismatch" }),
      JSON.stringify({ ts: "2026-11-07T03:30:01Z", phase: "other" }),
      event("2026-11-07T03:30:00Z", { action: "reuse", reason: "reuse_ready" }),
      "not json runner_xctestrun_cache",
    ].join("\n"),
  );
  expect(await runnerCacheDecisions([root, join(root, "missing")])).toEqual([
    '{"action":"reuse","reason":"reuse_ready"}',
    '{"action":"rebuild","reason":"artifact_content_mismatch"}',
  ]);
});
