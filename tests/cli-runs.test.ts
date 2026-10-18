import { describe, expect, test } from "bun:test";
import type { DevicePlatform, PublicRun, RunSummary } from "../packages/shared/src/index.js";
import type { ConnectInfo } from "../apps/cli/src/connect.js";
import { remoteArgs, shouldReplay } from "../apps/cli/src/remote.js";
import {
  connect,
  connectForArgs,
  platformFlag,
  targetPlatform,
  waitForRemote,
  waitForRun,
  type RunsDeps,
} from "../apps/cli/src/runs.js";
import {
  SIM_RUNTIME_TIMEOUT_MS,
  SIM_TIMEOUT_MS,
  simRequest,
  simTimeoutMessage,
} from "../apps/cli/src/commands.js";
import { api, ApiRequestError, friendlyError } from "../apps/cli/src/client.js";

const info = {
  runId: "run-1",
  tunnelUrl: "https://old.example",
  daemonToken: "secret",
  expiresAt: null,
};

function run(platform: DevicePlatform, patch: Partial<PublicRun> = {}): PublicRun {
  return {
    id: `${platform}-run`,
    ghRunId: 1,
    state: "live",
    platform,
    runner: null,
    device: null,
    bootedDevice: null,
    tunnelUrl: `https://${platform}.example`,
    daemonToken: `${platform}-token`,
    activeDevices: 0,
    androidReady: platform === "android",
    devicesReady: true,
    createdAt: 1,
    expiresAt: null,
    endReason: null,
    ...patch,
  };
}

const endpoint = (r: PublicRun): ConnectInfo => ({
  runId: r.id,
  tunnelUrl: r.tunnelUrl!,
  daemonToken: r.daemonToken!,
  expiresAt: r.expiresAt,
});

/** In-memory API, cache and runner health for routing tests. */
function fakes(
  options: {
    active?: PublicRun[] | (() => PublicRun[]);
    history?: RunSummary[];
    cache?: Partial<Record<DevicePlatform, ConnectInfo>>;
    healthy?: (info: ConnectInfo) => boolean;
  } = {},
) {
  const cache = { ...options.cache };
  const calls = {
    active: 0,
    probes: [] as string[],
    writes: [] as string[],
    clears: [] as string[],
  };
  const deps: RunsDeps = {
    activeRuns: async () => {
      calls.active++;
      return typeof options.active === "function" ? options.active() : (options.active ?? []);
    },
    history: async () => options.history ?? [],
    probe: async (target) => {
      calls.probes.push(target.tunnelUrl);
      return options.healthy?.(target) ?? true;
    },
    readCache: (platform) => cache[platform] ?? null,
    writeCache: (platform, target) => {
      calls.writes.push(platform);
      cache[platform] = target;
    },
    clearCache: (platform) => {
      calls.clears.push(platform);
      delete cache[platform];
    },
    pause: async () => {},
  };
  return { deps, calls, cache };
}

describe("platform routing", () => {
  test("--platform is read in both forms, only before a positional separator", () => {
    expect(platformFlag(["open", "app", "--platform", "android"])).toBe("android");
    expect(platformFlag(["snapshot", "--platform=ios"])).toBe("ios");
    expect(platformFlag(["open", "--", "--platform", "android"])).toBeUndefined();
    expect(platformFlag(["devices"])).toBeUndefined();
    expect(() => platformFlag(["devices", "--platform", "macos"])).toThrow("ios or android");
    expect(() => platformFlag(["devices", "--platform=ios", "--platform", "android"])).toThrow(
      "once",
    );
  });

  test("explicit platform wins, else the only active run; two active runs name both", () => {
    const both = [run("ios"), run("android", { state: "booting" })];
    expect(targetPlatform("android", both)).toBe("android");
    expect(targetPlatform(undefined, [run("android")])).toBe("android");
    expect(() => targetPlatform(undefined, [])).toThrow("No active run");
    let message = "";
    try {
      targetPlatform(undefined, both);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("iOS (run ios-run, live)");
    expect(message).toContain("Android (run android-run, booting)");
    expect(message).toContain("--platform");
  });

  test("an iOS cache never serves an Android command", async () => {
    const ios = run("ios");
    const { deps, calls } = fakes({ active: [ios], cache: { ios: endpoint(ios) } });
    await expect(connectForArgs(["open", "app", "--platform", "android"], deps)).rejects.toThrow(
      "No active Android run",
    );
    expect(calls.probes).toEqual([]);
    expect(calls.clears).toEqual(["android"]);
  });

  test("one reachable cached platform skips the API; two caches ask the API", async () => {
    const ios = run("ios");
    const android = run("android");
    const one = fakes({ active: [ios, android], cache: { ios: endpoint(ios) } });
    expect(await connectForArgs(["snapshot"], one.deps)).toEqual({
      platform: "ios",
      info: endpoint(ios),
    });
    expect(one.calls.active).toBe(0);

    const two = fakes({
      active: [ios, android],
      cache: { ios: endpoint(ios), android: endpoint(android) },
    });
    await expect(connectForArgs(["snapshot"], two.deps)).rejects.toThrow("Two runs are active");
    expect(
      (await connectForArgs(["snapshot", "--platform=android"], two.deps)).info.tunnelUrl,
    ).toBe("https://android.example");
  });

  test("an unreachable cache falls back to the API and is replaced", async () => {
    const android = run("android", { tunnelUrl: "https://new.example" });
    const { deps, calls, cache } = fakes({
      active: [android],
      cache: { android: { ...endpoint(android), tunnelUrl: "https://stale.example" } },
      healthy: (target) => target.tunnelUrl !== "https://stale.example",
    });
    const result = await connect("android", { deps });
    expect(result.tunnelUrl).toBe("https://new.example");
    expect(calls.writes).toEqual(["android"]);
    expect(cache.android?.tunnelUrl).toBe("https://new.example");
  });

  test("connect waits for devicesReady without sending device commands", async () => {
    let polls = 0;
    const { deps } = fakes({
      active: () => [run("android", { devicesReady: ++polls >= 3, androidReady: false })],
    });
    await connect("android", { deps });
    expect(polls).toBe(3);
  });
});

describe("waiting for a run", () => {
  const wait = (deps: RunsDeps, timeoutMs = 60_000) =>
    waitForRun("android-run", { timeoutMs, timeoutMessage: "never came online", deps });

  test("follows the run by id, not whichever run is current on another platform", async () => {
    const states: string[] = [];
    let polls = 0;
    const { deps } = fakes({
      active: () => [
        run("ios"),
        run("android", polls++ < 2 ? { state: "booting", tunnelUrl: null } : {}),
      ],
    });
    const result = await waitForRun("android-run", {
      timeoutMs: 60_000,
      timeoutMessage: "never",
      onUpdate: (current) => states.push(current.state),
      deps,
    });
    expect(result.run.platform).toBe("android");
    expect(result.info.tunnelUrl).toBe("https://android.example");
    expect(states).toEqual(["booting", "booting", "live"]);
  });

  test("fails fast with the run's endReason when it ends during startup", async () => {
    const ended = fakes({
      active: [run("ios")],
      history: [
        {
          ...run("android", { state: "failed" }),
          endedAt: 2,
          endReason: "KVM unavailable",
        } as RunSummary,
      ],
    });
    await expect(wait(ended.deps)).rejects.toThrow(/failed .*KVM unavailable/);
    const closing = fakes({
      active: [run("android", { state: "closing", endReason: "user stop" })],
    });
    await expect(wait(closing.deps)).rejects.toThrow("user stop");
    const missing = fakes({ active: [] });
    await expect(wait(missing.deps)).rejects.toThrow("no longer active");
  });

  test("bounded: a live run whose devices never boot says so; otherwise the caller's message", async () => {
    const live = fakes({ active: [run("android", { devicesReady: false, androidReady: false })] });
    await expect(wait(live.deps, 0)).rejects.toThrow("No device command was sent");
    const queued = fakes({ active: [run("android", { state: "queued", tunnelUrl: null })] });
    await expect(wait(queued.deps, 0)).rejects.toThrow("never came online");
  });

  test("older APIs without devicesReady fall back to androidReady (iOS: live)", async () => {
    const legacy = fakes({
      active: [run("android", { devicesReady: undefined as never, androidReady: true })],
    });
    expect((await wait(legacy.deps)).run.id).toBe("android-run");
    const notYet = fakes({
      active: [run("android", { devicesReady: undefined as never, androidReady: false })],
    });
    await expect(wait(notYet.deps, 0)).rejects.toThrow("did not finish booting");
  });
});

describe("sim flags", () => {
  test("device flags require --platform and are validated before any API call", () => {
    expect(() => simRequest({ device: "iPhone 16 Pro" })).toThrow("--platform");
    expect(() => simRequest({ os: "18.4" })).toThrow("--os");
    expect(() => simRequest({ platform: "android", os: "18.4b" })).toThrow("API level");
    expect(() => simRequest({ platform: "android", xcode: "27.1" })).toThrow("iOS");
    expect(() => simRequest({ platform: "ios", device: "iPhone 16", foldable: true })).toThrow(
      "either",
    );
    expect(simRequest({ platform: "ios", device: "iPhone 16 Pro", os: "latest" })).toMatchObject({
      platform: "ios",
      device: { model: "iPhone 16 Pro", os: "latest" },
      timeoutMs: SIM_TIMEOUT_MS,
    });
    expect(simRequest({}).device).toBeUndefined();
  });

  test("runtime downloads get a longer budget and the message states it", () => {
    expect(simRequest({ platform: "ios", foldable: true }).timeoutMs).toBe(SIM_RUNTIME_TIMEOUT_MS);
    expect(simRequest({ platform: "ios", xcode: "27.1" }).timeoutMs).toBe(SIM_RUNTIME_TIMEOUT_MS);
    expect(simRequest({ platform: "android", foldable: true }).timeoutMs).toBe(SIM_TIMEOUT_MS);
    expect(simTimeoutMessage(SIM_TIMEOUT_MS)).toContain("within 25 minutes");
    expect(simTimeoutMessage(SIM_RUNTIME_TIMEOUT_MS)).toContain("within 45 minutes");
  });
});

describe("API client", () => {
  test("requests time out instead of hanging", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = ((_url: unknown, init: RequestInit) =>
      new Promise((_resolve, reject) =>
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason)),
      )) as typeof fetch;
    try {
      await expect(api("/v1/runs/active", { auth: false, timeoutMs: 20 })).rejects.toThrow(
        "did not answer within",
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  test("new error codes map to actionable hints", () => {
    expect(friendlyError(new ApiRequestError(409, "platform_busy", "Busy.")).message).toContain(
      "simbox stop --platform",
    );
    expect(
      friendlyError(new ApiRequestError(409, "workflow_needs_repair", "Old workflow.")).message,
    ).toContain("simbox repair");
    expect(friendlyError(new ApiRequestError(400, "invalid_device", "No.")).message).toContain(
      "simbox devices list",
    );
  });
});

describe("remote commands", () => {
  test("startup timeout and session are stable across tunnel URLs", () => {
    const oldArgs = remoteArgs(
      ["open", "com.apple.Preferences", "--device", "iPhone"],
      info,
      "/state",
    );
    const nextArgs = remoteArgs(
      ["open", "com.apple.Preferences", "--device", "iPhone"],
      { ...info, tunnelUrl: "https://new.example" },
      "/state",
    );
    expect(oldArgs).toContain("300000");
    expect(oldArgs).toContain("simbox-run-1");
    expect(nextArgs.slice(0, -3)).toEqual(oldArgs.slice(0, -3));
    expect(nextArgs.at(-3)).toBe("https://new.example/agent-device");
    expect(oldArgs.join(" ")).not.toContain("secret");
  });
  test("routing flags are inserted before a positional separator", () => {
    const args = remoteArgs(["open", "--", "--some-app"], info, "/state");
    expect(args.indexOf("--daemon-base-url")).toBeLessThan(args.indexOf("--"));
    expect(args.at(-1)).toBe("--some-app");
  });
  test("explicit timeout/session respected; taps are not assigned startup budgets", () => {
    const args = remoteArgs(
      ["open", "app", "--timeout", "420000", "--session=other"],
      info,
      "/state",
    );
    expect(args.filter((arg) => arg === "--timeout")).toHaveLength(1);
    expect(args).not.toContain("300000");
    expect(args).not.toContain("simbox-run-1");
    expect(remoteArgs(["press", "@e1"], info, "/state")).not.toContain("--timeout");
  });
  test("readiness waits for the newly registered tunnel without replaying commands", async () => {
    const probes: string[] = [];
    const result = await waitForRemote(info, {
      probe: async (current) => {
        probes.push(current.tunnelUrl);
        return current.tunnelUrl === "https://new.example";
      },
      refresh: async () => ({ ...info, tunnelUrl: "https://new.example" }),
      pause: async () => {},
    });
    expect(result.tunnelUrl).toBe("https://new.example");
    expect(probes).toEqual(["https://old.example", "https://new.example"]);
  });
  test("readiness does not silently switch to another run", async () => {
    await expect(
      waitForRemote(info, {
        probe: async () => false,
        refresh: async () => ({ ...info, runId: "replacement" }),
      }),
    ).rejects.toThrow("ended or was replaced");
  });
  test("readiness has a bounded failure with a useful error", async () => {
    await expect(
      waitForRemote(info, {
        timeoutMs: 0,
        probe: async () => false,
        refresh: async () => info,
        pause: async () => {},
      }),
    ).rejects.toThrow("No device command was sent");
  });
  test("exec replays only read-only or absolute commands, and only after a transport drop", () => {
    const dropped = "Error (COMMAND_FAILED): Remote daemon is unavailable";
    expect(shouldReplay(["devices", "--platform", "ios"], 1, dropped)).toBe(true);
    expect(shouldReplay(["fold", "closed"], 1, "Daemon request timed out")).toBe(true);
    expect(shouldReplay(["snapshot", "-i"], 1, "Failed to read daemon response")).toBe(true);
    // Actions may already have run on the device: never replay them.
    for (const command of ["click", "type", "fill", "install", "open", "press"])
      expect(shouldReplay([command, "@e1"], 1, dropped)).toBe(false);
    // Real command failures are reported, not retried.
    expect(shouldReplay(["fold", "closed"], 1, "UNSUPPORTED_OPERATION single-panel-device")).toBe(
      false,
    );
    expect(shouldReplay(["devices"], 0, dropped)).toBe(false);
  });
});
