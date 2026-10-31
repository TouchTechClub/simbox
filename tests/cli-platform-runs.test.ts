import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PublicRun, RunnerSettings } from "../packages/shared/src/index.js";

/**
 * The CLI as a user runs it, against a stubbed API that serves both an iOS
 * and an Android run. Each run's "tunnel" is a path on the same server, so
 * the health probe and agent-device routing are observable.
 */
let dir = "";
let server: ReturnType<typeof Bun.serve>;
const calls: Array<{ method: string; path: string; body: unknown }> = [];
let active: PublicRun[] = [];
let inventory: Record<string, unknown> = {};
const base = () => server.url.href.replace(/\/$/, "");

function run(platform: "ios" | "android", patch: Partial<PublicRun> = {}): PublicRun {
  return {
    id: `${platform}-run`,
    ghRunId: 1,
    state: "live",
    platform,
    runner: { labels: [platform === "ios" ? "macos-latest" : "ubuntu-latest"] },
    device: null,
    bootedDevice: null,
    tunnelUrl: `${base()}/${platform}`,
    daemonToken: `${platform}-token`,
    activeDevices: 0,
    androidReady: platform === "android",
    devicesReady: true,
    createdAt: 1,
    expiresAt: Date.now() + 3_600_000,
    endReason: null,
    ...patch,
  };
}

const settings: RunnerSettings = {
  account: { ios: null, android: null },
  repository: { ios: null, android: null },
  repoFullName: "owner/repo",
  effective: {
    ios: { runner: { labels: ["macos-latest"] }, source: "default" },
    android: { runner: { labels: ["ubuntu-latest"] }, source: "default" },
  },
  devices: {
    account: { ios: { os: "18.4" }, android: null },
    repository: { ios: { model: "iPhone 16 Pro" }, android: null },
    effective: {
      ios: {
        device: { model: "iPhone 16 Pro", os: "18.4" },
        sources: { model: "repository", os: "account" },
      },
      android: { device: null, sources: {} },
    },
  },
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "simbox-platform-runs-"));
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      // A run's tunnel answers only while that run is active.
      const health = url.pathname.match(/^\/(ios|android)\/v1\/agent-device\/health$/);
      if (health)
        return active.some((r) => r.platform === health[1] && r.state === "live")
          ? Response.json({ ok: true, upstream: { ok: true } })
          : new Response("gone", { status: 503 });
      const body = request.method === "GET" ? null : await request.json().catch(() => null);
      calls.push({ method: request.method, path: url.pathname + url.search, body });
      const path = url.pathname;
      if (path === "/v1/runs/active") return Response.json({ runs: active });
      if (path === "/v1/runs") return Response.json({ runs: [] });
      if (path === "/v1/runs/ensure") {
        const platform = (body as { platform?: "ios" | "android" }).platform ?? "ios";
        active = [
          ...active.filter((r) => r.platform !== platform),
          run(platform, {
            device: (body as { device?: PublicRun["device"] }).device ?? null,
            bootedDevice: { model: "pixel_8", os: "35", name: "Pixel 8", id: "emulator-5554" },
          }),
        ];
        return Response.json({ state: "booting", runId: `${platform}-run` });
      }
      const stop = path.match(/^\/v1\/runs\/([^/]+)\/stop$/);
      if (stop) {
        const stopped = active.find((r) => r.id === stop[1])!;
        active = active.filter((r) => r.id !== stop[1]);
        return Response.json({ run: { ...stopped, state: "closing" } });
      }
      if (path === "/v1/inventory") return Response.json(inventory);
      if (path.startsWith("/v1/devices/") || path === "/v1/runners") return Response.json(settings);
      if (path === "/v1/repo/repair")
        return Response.json({
          connected: true,
          repo: {
            repoId: 1,
            fullName: "owner/repo",
            private: false,
            defaultBranch: "main",
            installationId: 1,
            state: "pending_pr",
            prUrl: "https://github.com/owner/repo/pull/9",
            createdAt: 1,
            workflowVersion: 2,
          },
        });
      return Response.json({ error: "not_found", message: `no ${path}` }, { status: 404 });
    },
  });
  await mkdir(join(dir, "bin"));
  await mkdir(join(dir, "config/simbox"), { recursive: true });
  writeFileSync(join(dir, "config/simbox/auth.json"), JSON.stringify({ token: "user-token" }));
  // agent-device stand-in: records where Simbox routed the command.
  writeFileSync(
    join(dir, "bin/agent-device"),
    `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(process.env.EXEC_LOG, JSON.stringify({args: process.argv.slice(2), token: process.env.AGENT_DEVICE_DAEMON_AUTH_TOKEN}) + "\\n");\n`,
  );
  await chmod(join(dir, "bin/agent-device"), 0o755);
});

afterAll(async () => {
  server.stop(true);
  await rm(dir, { recursive: true, force: true });
});

const cli = new URL("../apps/cli/src/cli.ts", import.meta.url).pathname;
const execLog = () => join(dir, "exec.log");
const cacheFile = (platform: string) => join(dir, "config/simbox", `current-run-${platform}.json`);

async function simbox(...args: string[]) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: dir, // no S5 runtime here, so no device receipts
    XDG_CONFIG_HOME: join(dir, "config"),
    SIMBOX_API_URL: base(),
    PATH: `${join(dir, "bin")}:${process.env.PATH}`,
    EXEC_LOG: execLog(),
    NO_COLOR: "1",
  };
  delete env.T3CODE_HOME;
  // One shared caller: the session is the run's own, with no agent suffix.
  delete env.SIMBOX_HOLDER;
  delete env.T3CODE_THREAD_ID;
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.SIMBOX_DEVICE_REGISTRATION_DIR;
  const child = Bun.spawn([process.execPath, cli, ...args], {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

test("sim validates device flags locally, follows its own run and caches it per platform", async () => {
  active = [run("ios")];
  calls.length = 0;
  const bad = await simbox("sim", "--device", "pixel_8");
  expect(bad.code).toBe(1);
  expect(bad.stderr).toContain("--platform");
  expect((await simbox("sim", "--platform", "android", "--xcode", "27.1")).stderr).toContain("iOS");
  expect(calls).toHaveLength(0);

  const sim = await simbox("sim", "--platform", "android", "--device", "pixel_8", "--os", "35");
  expect(sim.code).toBe(0);
  expect(calls[0]).toMatchObject({
    path: "/v1/runs/ensure",
    body: { new: false, platform: "android", device: { model: "pixel_8", os: "35" } },
  });
  expect(sim.stdout).toContain("Android run android-run is live");
  expect(sim.stdout).toContain("Warm: Pixel 8 (API 35)");
  expect(sim.stdout).toContain("simbox exec open <app> --platform android");
  expect(sim.stdout).toContain("--session simbox-android-run");
  expect(sim.stdout).not.toContain("--platform ios");
  expect(JSON.parse(readFileSync(cacheFile("android"), "utf8"))).toMatchObject({
    platform: "android",
    runId: "android-run",
  });
  expect((await stat(cacheFile("android"))).mode & 0o777).toBe(0o600);
  expect(existsSync(cacheFile("ios"))).toBe(false);

  const json = await simbox("sim", "--platform", "android", "--json");
  expect(JSON.parse(json.stdout)).toMatchObject({
    run_id: "android-run",
    platform: "android",
    booted_device: { name: "Pixel 8" },
  });
});

test("ps lists every active run; stop needs a platform when two are active", async () => {
  active = [
    run("ios", {
      bootedDevice: { model: "iPhone 16", os: "18.4", name: "iPhone 16", id: "UDID-1" },
    }),
    run("android", { state: "booting", tunnelUrl: null, devicesReady: false }),
  ];
  const ps = await simbox("ps");
  expect(ps.stdout).toContain("iOS run ios-run");
  expect(ps.stdout).toContain("iPhone 16 (iOS 18.4, UDID-1)");
  expect(ps.stdout).toContain("Android run android-run");
  expect(ps.stdout).toContain("booting");
  expect(JSON.parse((await simbox("ps", "--json")).stdout).runs).toHaveLength(2);

  writeFileSync(
    cacheFile("ios"),
    JSON.stringify({
      platform: "ios",
      runId: "ios-run",
      tunnelUrl: "x",
      daemonToken: "y",
      expiresAt: null,
    }),
  );
  writeFileSync(
    cacheFile("android"),
    JSON.stringify({
      platform: "android",
      runId: "android-run",
      tunnelUrl: "x",
      daemonToken: "y",
      expiresAt: null,
    }),
  );
  calls.length = 0;
  const ambiguous = await simbox("stop");
  expect(ambiguous.code).toBe(1);
  expect(ambiguous.stderr).toContain("iOS (run ios-run, live)");
  expect(ambiguous.stderr).toContain("--all");
  expect(calls.some((call) => call.path.endsWith("/stop"))).toBe(false);

  const one = await simbox("stop", "--platform", "android");
  expect(one.code).toBe(0);
  expect(calls.at(-1)?.path).toBe("/v1/runs/android-run/stop");
  expect(existsSync(cacheFile("android"))).toBe(false);
  expect(existsSync(cacheFile("ios"))).toBe(true);

  // One left: no flag stops it.
  expect((await simbox("stop")).stdout).toContain("iOS run ios-run");
  expect(existsSync(cacheFile("ios"))).toBe(false);
  expect((await simbox("stop", "--all")).stdout).toContain("No active run");
});

test("stop --platform stops only this agent's run when several are active", async () => {
  active = [run("ios", { id: "mine", held: true }), run("ios", { id: "theirs", held: false })];
  calls.length = 0;
  const mine = await simbox("stop", "--platform", "ios");
  expect(mine.code).toBe(0);
  expect(calls.filter((call) => call.path.endsWith("/stop")).map((call) => call.path)).toEqual([
    "/v1/runs/mine/stop",
  ]);

  // Neither is this agent's: name one rather than stop someone else's.
  active = [run("ios", { id: "a" }), run("ios", { id: "b" })];
  calls.length = 0;
  const ambiguous = await simbox("stop", "--platform", "ios");
  expect(ambiguous.code).toBe(1);
  expect(ambiguous.stderr).toContain("2 iOS runs are active (a, b)");
  expect(calls.some((call) => call.path.endsWith("/stop"))).toBe(false);
  expect((await simbox("stop", "--run", "b")).code).toBe(0);
  expect(calls.at(-1)?.path).toBe("/v1/runs/b/stop");
  active = [];
});

test("exec routes by --platform or the only active run, never across platforms", async () => {
  active = [run("ios"), run("android")];
  const routed = () =>
    readFileSync(execLog(), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { args: string[]; token: string })
      .at(-1)!;
  const ambiguous = await simbox("exec", "snapshot");
  expect(ambiguous.code).toBe(1);
  expect(ambiguous.stderr).toContain("iOS and Android runs are active");

  expect((await simbox("exec", "snapshot", "--platform=android")).code).toBe(0);
  let last = routed();
  expect(last.token).toBe("android-token");
  expect(last.args).toContain(`${base()}/android/v1/agent-device`);
  expect(last.args).toContain("simbox-android-run");

  expect((await simbox("exec", "open", "app", "--platform", "ios")).code).toBe(0);
  last = routed();
  expect(last.token).toBe("ios-token");
  expect(last.args).toContain(`${base()}/ios/v1/agent-device`);

  // Both platforms are cached now; without a flag it is still ambiguous.
  expect((await simbox("exec", "snapshot")).stderr).toContain("iOS and Android runs are active");

  active = [run("android")];
  writeFileSync(cacheFile("ios"), "{}");
  expect((await simbox("exec", "snapshot")).code).toBe(0);
  expect(routed().token).toBe("android-token");

  active = [run("ios")];
  const none = await simbox("exec", "snapshot", "--platform", "android");
  expect(none.code).toBe(1);
  expect(none.stderr).toContain("No active Android run");
});

test("devices list explains a missing catalog; set/reset post field-wise profiles", async () => {
  inventory = {
    platform: "android",
    runner: { labels: ["blacksmith-4vcpu-ubuntu-2404"] },
    inventory: null,
  };
  const empty = await simbox(
    "devices",
    "list",
    "--platform",
    "android",
    "--runner",
    "blacksmith-4vcpu-ubuntu-2404",
  );
  expect(calls.at(-1)?.path).toBe(
    "/v1/inventory?platform=android&runner=blacksmith-4vcpu-ubuntu-2404",
  );
  expect(empty.stdout).toContain("first run");
  expect(empty.stdout).toContain(
    "simbox sim --platform android --runner blacksmith-4vcpu-ubuntu-2404",
  );
  expect((await simbox("devices", "list", "--runner", "x")).stderr).toContain("--platform");

  inventory = {
    platform: "ios",
    runner: { labels: ["macos-latest"] },
    inventory: {
      platform: "ios",
      runner: { labels: ["macos-latest"] },
      reportedAt: Date.now() - 3 * 3_600_000,
      os: [
        { version: "18.4", name: "iOS 18.4", models: ["iphone-16"] },
        { version: "26.1", name: "iOS 26.1" },
      ],
      models: [
        { id: "iphone-17", name: "iPhone 17" },
        { id: "iphone-16", name: "iPhone 16" },
        { id: "duo", name: "iPhone Duo", foldable: true },
      ],
      defaults: { model: "iphone-17", os: "26.1" },
      xcode: ["27.1", "26.2"],
    },
  };
  const list = (await simbox("devices", "list", "--platform", "ios")).stdout;
  expect(list).toContain("reported by macos-latest 3 hours ago");
  expect(list.indexOf("26.1")).toBeLessThan(list.indexOf("18.4"));
  expect(list).toMatch(/26\.1 .*iOS 26\.1 \(default\)/);
  expect(list).toMatch(/18\.4 .*iOS 18\.4 — iPhone 16/);
  expect(list).toContain("iPhone Duo [foldable]");
  expect(list).toContain("Xcode: 27.1, 26.2");

  const set = await simbox(
    "devices",
    "set",
    "ios",
    "--device",
    "iPhone 16 Pro",
    "--os",
    "18.4",
    "--scope",
    "repo",
  );
  expect(set.code).toBe(0);
  expect(calls.at(-1)).toMatchObject({
    path: "/v1/devices/repo",
    body: { ios: { model: "iPhone 16 Pro", os: "18.4" } },
  });
  expect(set.stdout).toContain("device: iPhone 16 Pro, iOS 18.4 (model: repository, os: account)");
  expect((await simbox("devices", "reset", "android", "--scope", "account")).code).toBe(0);
  expect(calls.at(-1)).toMatchObject({ path: "/v1/devices/account", body: { android: null } });
  const count = calls.length;
  expect((await simbox("devices", "set", "ios", "--scope", "repo")).stderr).toContain("--device");
  expect((await simbox("devices", "set", "android", "--os", "18.4b", "--scope", "repo")).code).toBe(
    1,
  );
  expect(calls).toHaveLength(count);
});

test("repair prints the repo state and the PR to merge", async () => {
  const repair = await simbox("repair");
  expect(repair.code).toBe(0);
  expect(repair.stdout).toContain("owner/repo: pending_pr");
  expect(repair.stdout).toContain("https://github.com/owner/repo/pull/9");
});
