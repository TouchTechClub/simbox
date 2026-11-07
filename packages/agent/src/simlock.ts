/**
 * The run's device daemon: a standalone Simlock worker on 127.0.0.1:4701.
 * Simlock creates, boots, leases, wipes and streams the devices; the agent
 * installs it, configures one warm target, waits for it, mints the agent
 * token clients use, and reads its status for heartbeats and idle exit.
 */
import { chmod, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { compareVersions, type DevicePlatform } from "@simbox/shared";
import { PINS } from "./pins.js";
import { endGroup, info, relay, startGroup, warn } from "./log.js";
import { relayFiltered, run, which } from "./proc.js";

export interface SimlockBins {
  simlock: string;
  agentDevice: string;
}

/** One warm-pool target: Simlock keeps `count` such devices booted and unleased. */
export interface WarmTarget {
  platform: DevicePlatform;
  /** Simlock model name or alias (iOS device type name, Android profile id). */
  model: string;
  /** Only when the run asked for an OS; otherwise Simlock picks the newest fit. */
  osVersion?: string;
  count: number;
}

/** The parts of `simlock status --json` the agent reads. */
export interface SimlockStatus {
  leases?: Array<{ id: string }>;
  queueDepth?: number;
  devices?: Array<{
    id: string;
    state: string;
    spec?: { platform?: string; model?: string; osVersion?: string };
  }>;
  warmPool?: {
    targets: Array<{
      model: string;
      osVersion?: string;
      count: number;
      ready: number;
      booting: number;
      short?: string;
    }>;
  };
}

/** Resolve an npm global binary: PATH first, then the global prefix. */
async function globalBin(name: string, prefix: string): Promise<string> {
  const onPath = await which(name);
  if (onPath) return onPath;
  const guess = join(prefix, "bin", name);
  if (existsSync(guess)) return guess;
  throw new Error(`${name} installed but not found on PATH or under ${prefix}/bin`);
}

/**
 * `npm i -g simlock@<pin> agent-device@<pin>`. Simlock 0.4.0's tarball ships
 * its screen and device capture helpers without the executable bit, which
 * breaks the iOS stream and input; restore it.
 */
export async function installSimlock(): Promise<SimlockBins> {
  startGroup("Install Simlock and agent-device");
  try {
    const specs = [`simlock@${PINS.simlock}`, `agent-device@${PINS.agentDevice}`];
    info(`npm i -g ${specs.join(" ")}`);
    const res = await run(["npm", "i", "-g", ...specs], { timeoutMs: 300_000 });
    for (const line of `${res.stdout}\n${res.stderr}`.split("\n"))
      if (line.trim()) relay("npm", line);
    if (res.code !== 0) throw new Error(`npm i -g ${specs.join(" ")} exited ${res.code}`);
    const prefix = (await run(["npm", "prefix", "-g"])).stdout.trim();
    const root = (await run(["npm", "root", "-g"])).stdout.trim();
    await patchSimlock(join(root, "simlock", "dist"));
    const helpers = join(root, "simlock", "dist", "bin");
    for (const name of await readdir(helpers).catch(() => [] as string[]))
      await chmod(join(helpers, name), 0o755).catch(() => {});
    const bins = {
      simlock: await globalBin("simlock", prefix),
      agentDevice: await globalBin("agent-device", prefix),
    };
    info(`simlock at ${bins.simlock}; agent-device at ${bins.agentDevice}`);
    return bins;
  } finally {
    endGroup();
  }
}

/** Names the keep file for the patched Simlock daemon (see SIMLOCK_PATCHES). */
export const KEEP_RECLAIM_ENV = "SIMBOX_KEEP_RECLAIM_FILE";

/**
 * While this file exists, the next iOS reclaim keeps its device booted instead
 * of erasing it, and deletes the file. The agent creates it only after a
 * passing self-test, so that lease's release keeps the warm device.
 */
export function keepReclaimFile(home = Bun.env.HOME || homedir()): string {
  return join(home, ".simlock", "simbox-keep-next-reclaim");
}

/**
 * The warm target's model and OS, for agent-device requests that name no
 * device (see SIMLOCK_PATCHES). Simlock reads such a request as "any phone",
 * so on a foldable or tablet run it shut the warm iPhone Duo down and booted an
 * iPhone 17 for the self-test and for every client's first `open`.
 */
export const DEFAULT_MODEL_ENV = "SIMBOX_DEFAULT_MODEL";
export const DEFAULT_OS_ENV = "SIMBOX_DEFAULT_OS";

/** The daemon env that makes a request naming no device mean the warm one. */
export function defaultDeviceEnv(target: WarmTarget, osVersion: string): Record<string, string> {
  return { [DEFAULT_MODEL_ENV]: target.model, [DEFAULT_OS_ENV]: target.osVersion ?? osVersion };
}

/** How long an agent-device lease survives without a command. */
export const AGENT_DEVICE_LEASE_TTL_MS = 30 * 60_000;

/**
 * Edits to the pinned Simlock build, until upstream makes these configurable.
 * Each edit must match exactly, so a Simlock bump that moves one fails the run
 * instead of silently reverting it.
 *
 * - Simlock 0.4.0 hard-codes iOS timeouts that hosted Macs (3 vCPUs) cannot
 *   meet: in testing, a boot took 134s against a 120s limit and `simctl list`
 *   outlasted 30s, so most runs never warmed.
 * - agent-device (0.21.35) asks for a fixed 5-minute proxy lease, renewed only
 *   by commands, so an agent that pauses to think loses its device and Simlock
 *   wipes it. The client runs on the user's machine, so the runner overrides
 *   it in Simlock's agent-device front: there the configured
 *   `leaseTtlCapMs` becomes the TTL instead of only capping the client's.
 * - agent-device asks for streamed progress on `devices` unless `--json` is
 *   set, which the front refuses because it filters the answer to the token's
 *   own devices. Drop the request instead; the client reads a plain reply.
 * - Every iOS simulator reclaim shuts the device down and erases it, so the
 *   warm-up self-test's release cost a second cold boot (4-5 minutes, more for
 *   an iPhone Duo) before the run could go live. While the keep file exists,
 *   the next reclaim consumes it and returns the device booted and ready, the
 *   way Simlock's own Android snapshot reclaim does. See `keepReclaimFile`.
 */
export const SIMLOCK_PATCHES: Array<{ file: string; from: string; to: string }> = [
  {
    file: "drivers/ios/index.js",
    from: "const BOOTSTATUS_TIMEOUT_MS = 120_000;",
    to: "const BOOTSTATUS_TIMEOUT_MS = 600_000;",
  },
  {
    file: "drivers/ios/index.js",
    from: "const COMMAND_TIMEOUT_MS = 30_000;",
    to: "const COMMAND_TIMEOUT_MS = 120_000;",
  },
  {
    file: "core/warm-pool/catalog-check.js",
    from: "const CATALOG_READ_LIMIT_MS = 30_000;",
    to: "const CATALOG_READ_LIMIT_MS = 120_000;",
  },
  {
    file: "agent-device/front/ttl.js",
    from: "return Math.max(cap === undefined ? sent : Math.min(sent, cap), MIN_TTL_MS);",
    to: "return Math.max(cap === undefined ? sent : cap, MIN_TTL_MS);",
  },
  {
    file: "agent-device/front/request-rules.js",
    from: 'throw refuse("refused: devices does not stream through simlock");',
    to: 'delete check.meta["requestProgress"]; check.changed = true;',
  },
  {
    file: "drivers/ios/index.js",
    from: [
      "        const data = iosDriverData(device);",
      "        await this.#shutdown(data.udid);",
      '        await this.#simctl(["erase", data.udid], COMMAND_TIMEOUT_MS);',
    ].join("\n"),
    to: [
      "        const data = iosDriverData(device);",
      `        if (await import("node:fs").then((fs) => { try { fs.unlinkSync(process.env.${KEEP_RECLAIM_ENV}); return true; } catch { return false; } }))`,
      '            return { state: "ready", strategy: "snapshot" };',
      "        await this.#shutdown(data.udid);",
      '        await this.#simctl(["erase", data.udid], COMMAND_TIMEOUT_MS);',
    ].join("\n"),
  },
  {
    file: "agent-device/front/allocate.js",
    from: "...(device === undefined ? (klass === undefined ? {} : { class: klass }) : { model: device }),",
    to:
      `...(device === undefined && klass === undefined && process.env.${DEFAULT_MODEL_ENV} ? { model: process.env.${DEFAULT_MODEL_ENV}, ...(process.env.${DEFAULT_OS_ENV} ? { osVersion: process.env.${DEFAULT_OS_ENV} } : {}) } : ` +
      "device === undefined ? (klass === undefined ? {} : { class: klass }) : { model: device }),",
  },
];

export function patchSource(source: string, from: string, to: string): string {
  if (source.includes(to)) return source;
  if (!source.includes(from)) throw new Error(`Simlock patch target not found: ${from}`);
  return source.replace(from, to);
}

async function patchSimlock(dist: string): Promise<void> {
  for (const { file, from, to } of SIMLOCK_PATCHES) {
    const path = join(dist, file);
    await writeFile(path, patchSource(await readFile(path, "utf8"), from, to));
  }
  info(
    `patched Simlock: iOS timeouts, agent-device lease TTL, devices and default model, self-test keep (${SIMLOCK_PATCHES.length} edits)`,
  );
}

/** Simlock's slim mode applies from iOS 18.5; older runtimes always boot full. */
export function iosSlim(osVersion: string): boolean {
  return compareVersions(osVersion, "18.5") >= 0;
}

/** Every `simlock config set` the run needs, in order. */
export function simlockSettings(options: {
  target: WarmTarget;
  maxDevices: number;
  /** The chosen OS version; decides iOS slim mode. */
  osVersion: string;
}): Array<[string, string]> {
  const { target } = options;
  const settings: Array<[string, string]> = [
    ["capabilities.agent-device.enabled", "true"],
    // With SIMLOCK_PATCHES, the TTL of every agent-device lease.
    ["capabilities.agent-device.leaseTtlCapMs", String(AGENT_DEVICE_LEASE_TTL_MS)],
    ["capabilities.stream.enabled", "true"],
    ["capabilities.input.enabled", "true"],
    // The pin is deliberate; a runner never updates itself mid-run.
    ["update.check", "false"],
    ["warmPool.targets", JSON.stringify([target])],
    // Every client of a run shares its one agent token: one Simlock requester.
    ["lease.maxPerRequester", String(Math.max(1, options.maxDevices))],
    // Simlock counts a device whose boot failed against this limit; one spare
    // lets it provision a replacement (the running limit still applies).
    [
      `capacity.config.limits.${target.platform}.maxDevices`,
      String(Math.max(1, options.maxDevices) + 1),
    ],
  ];
  // Slim turns off iOS background services (Siri, search, iCloud sync, widgets
  // and so on) and boots under its own, configurable limit.
  if (target.platform === "ios" && iosSlim(options.osVersion))
    settings.push(["ios.defaultMode", "slim"], ["ios.slim.bootTimeoutMs", "600000"]);
  if (target.platform === "android")
    settings.push(
      ["android.emulator.headless", "true"],
      ["android.emulator.audio", "false"],
      ["downloads.acceptAndroidLicenses", "true"],
    );
  return settings;
}

/** Simlock events that explain where a warm-up's time went. */
const TIMELINE_EVENT = /^(daemon|device|warm-pool|component|disk|capacity|lease)\./;

/**
 * `simlock events` output (one JSON envelope per line) as lines timed from
 * `origin`: `+12.3s device.ready {"bootDuration":...}`.
 */
export function formatTimeline(stdout: string, origin: number): string[] {
  const lines: string[] = [];
  for (const raw of stdout.split("\n")) {
    if (!raw.trim()) continue;
    let envelope: { timestamp?: unknown; event?: unknown; payload?: unknown };
    try {
      envelope = JSON.parse(raw) as typeof envelope;
    } catch {
      continue;
    }
    if (typeof envelope.event !== "string" || !TIMELINE_EVENT.test(envelope.event)) continue;
    const at =
      typeof envelope.timestamp === "number"
        ? `+${((envelope.timestamp - origin) / 1000).toFixed(1)}s`
        : "?";
    const payload = envelope.payload === undefined ? "" : JSON.stringify(envelope.payload);
    lines.push(`${at} ${envelope.event}${payload ? ` ${payload.slice(0, 240)}` : ""}`);
  }
  return lines;
}

/** Where agent-device keeps its Apple runner builds (the action caches it). */
export function appleRunnerDerived(home = Bun.env.HOME || homedir()): string {
  return join(home, ".agent-device", "apple-runner", "derived");
}

/** Runner builds already on disk, by agent-device's per-build metadata file. */
export async function cachedRunnerBuilds(derived = appleRunnerDerived()): Promise<number> {
  const entries = await readdir(derived, { recursive: true }).catch(() => [] as string[]);
  return entries.filter((entry) => basename(entry) === ".agent-device-runner-cache.json").length;
}

/**
 * agent-device's Apple runner cache decisions (reuse, or rebuild and why),
 * from the diagnostics it writes under these roots, oldest first.
 */
export async function runnerCacheDecisions(
  roots = [
    join(Bun.env.HOME || homedir(), ".simlock", "agent-device"),
    join(Bun.env.HOME || homedir(), ".agent-device", "logs"),
  ],
): Promise<string[]> {
  const found: Array<{ ts: string; line: string }> = [];
  const seen = new Set<string>();
  for (const root of roots) {
    const entries = await readdir(root, { recursive: true }).catch(() => [] as string[]);
    for (const entry of entries.filter((e) => e.endsWith(".ndjson") || e.endsWith(".log"))) {
      const text = await readFile(join(root, entry), "utf8").catch(() => "");
      for (const raw of text.split("\n")) {
        if (!raw.includes("runner_xctestrun_cache")) continue;
        try {
          const event = JSON.parse(raw) as { ts?: string; timestamp?: string; data?: unknown };
          const line = JSON.stringify(event.data ?? event).slice(0, 600);
          if (seen.has(line)) continue;
          seen.add(line);
          found.push({ ts: String(event.ts ?? event.timestamp ?? ""), line });
        } catch {
          // Not JSON: an agent-device text log line.
        }
      }
    }
  }
  return found.sort((a, b) => a.ts.localeCompare(b.ts)).map((f) => f.line);
}

export function createSimlock(bins: SimlockBins) {
  const simlock = (args: string[], timeoutMs = 60_000) =>
    run([bins.simlock, ...args], { timeoutMs });
  let startedAt = Date.now();
  let defaultDevice: Record<string, string> = {};
  /** Why the last status read failed; empty after a good read. */
  let statusProblem = "";

  async function status(): Promise<SimlockStatus | null> {
    const started = Date.now();
    const res = await simlock(["status", "--json"], 20_000);
    const took = `${Math.round((Date.now() - started) / 1000)}s`;
    if (res.code !== 0) {
      const detail = (res.stderr || res.stdout).trim().split("\n").pop()?.slice(0, 160) ?? "";
      statusProblem = `exit ${res.code} after ${took}${detail ? `: ${detail}` : ""}`;
      return null;
    }
    try {
      const parsed = JSON.parse(res.stdout) as SimlockStatus;
      statusProblem = "";
      return parsed;
    } catch {
      statusProblem = `unreadable reply after ${took}`;
      return null;
    }
  }

  /** Simlock's warnings and errors; its request log would drown them. */
  async function logs(lines = 60): Promise<void> {
    const res = await simlock(["daemon", "logs"], 15_000);
    const notable = res.stdout.split("\n").filter((line) => /"level":"(warn|error)"/.test(line));
    for (const line of notable.slice(-lines)) relayFiltered("simlock", line);
  }

  return {
    status,
    logs,

    async configure(options: Parameters<typeof simlockSettings>[0]): Promise<void> {
      for (const [key, value] of simlockSettings(options)) {
        const res = await simlock(["config", "set", key, value]);
        if (res.code !== 0)
          throw new Error(
            `simlock config set ${key} failed (exit ${res.code}): ${res.stderr.trim().slice(-300)}`,
          );
      }
      defaultDevice = defaultDeviceEnv(options.target, options.osVersion);
      info(`warm target: ${JSON.stringify(options.target)}`);
    },

    /**
     * Simlock's events since the daemon started, timed from its start: where
     * a warm-up spent its time (catalog, provision, boot, slim, leases).
     */
    async timeline(): Promise<void> {
      const seconds = Math.ceil((Date.now() - startedAt) / 1000) + 5;
      const res = await simlock(["events", "--since", `${seconds}s`], 30_000);
      if (res.code !== 0) {
        warn(`simlock events exited ${res.code}; no warm-up timeline`);
        return;
      }
      startGroup("Simlock timeline (from daemon start)");
      try {
        for (const line of formatTimeline(res.stdout, startedAt)) info(line);
      } finally {
        endGroup();
      }
    },

    async start(): Promise<void> {
      startedAt = Date.now();
      await rm(keepReclaimFile(), { force: true });
      const res = await run([bins.simlock, "daemon", "start"], {
        timeoutMs: 120_000,
        env: { [KEEP_RECLAIM_ENV]: keepReclaimFile(), ...defaultDevice },
      });
      for (const line of `${res.stdout}\n${res.stderr}`.split("\n"))
        if (line.trim()) relayFiltered("simlock", line);
      if (res.code !== 0) throw new Error(`simlock daemon start exited ${res.code}`);
    },

    async stop(): Promise<void> {
      await simlock(["daemon", "stop"], 20_000);
    },

    /**
     * Wait until the warm target has a ready device. Simlock retries failed
     * boots itself; the deadline is what turns a host that cannot boot (the
     * fixed 120s iOS boot limit on a starved Mac) into a failed run.
     */
    async waitForWarm(options: { timeoutMs: number; isStopping: () => boolean }): Promise<void> {
      const started = Date.now();
      let last = "";
      while (!options.isStopping()) {
        const current = await status();
        const target = current?.warmPool?.targets[0];
        const line = target
          ? `warm pool: ready ${target.ready}/${target.count}, booting ${target.booting}${target.short ? `, short: ${target.short}` : ""}`
          : current
            ? "warm pool: no target in status yet"
            : `warm pool: simlock status failed (${statusProblem.replace(/ after \d+s/, "")})`;
        if (line !== last) info(line);
        last = line;
        if (target && target.ready > 0) {
          info(`warm device ready after ${Math.round((Date.now() - started) / 1000)}s`);
          return;
        }
        if (Date.now() - started >= options.timeoutMs) {
          await logs();
          throw new Error(
            `no warm device after ${Math.round(options.timeoutMs / 60_000)} minutes${target?.short ? ` (${target.short})` : ""}`,
          );
        }
        await Bun.sleep(5000);
      }
    },

    /** Drop an unconsumed keep file, so no later release skips its wipe. */
    async clearKeep(): Promise<void> {
      await rm(keepReclaimFile(), { force: true });
    },

    /** End every lease, as the operator; only before clients can connect. */
    async releaseAll(): Promise<void> {
      const res = await simlock(["release", "--all", "--yes"], 60_000);
      if (res.code !== 0) warn(`simlock release --all exited ${res.code}`);
    },

    /** A fresh agent token for this run's clients. The caller masks it. */
    async createAgentToken(label: string): Promise<string> {
      const res = await simlock(["token", "create", "--role", "agent", "--label", label]);
      const secret = /"secret"\s*:\s*"(slk_[^"]+)"/.exec(res.stdout)?.[1];
      if (res.code !== 0 || !secret)
        throw new Error(`simlock token create failed (exit ${res.code})`);
      return secret;
    },
  };
}

export type Simlock = ReturnType<typeof createSimlock>;

/** Leases held, and requests waiting for one: anything but zero is work. */
export function simlockLoad(status: SimlockStatus): { leases: number; queued: number } {
  return { leases: status.leases?.length ?? 0, queued: status.queueDepth ?? 0 };
}

/** Warm devices ready to lease right now. */
export function warmReady(status: SimlockStatus): number {
  return (status.warmPool?.targets ?? []).reduce((sum, target) => sum + target.ready, 0);
}

/** The local agent-device profile the standalone worker writes for this host. */
export function agentDeviceProfile(home = Bun.env.HOME || homedir()): string {
  return join(home, ".simlock", "agent-device-profile.json");
}

/**
 * The warm-up snapshot's budget. It builds and starts the XCTest runner: 101s
 * for an iPhone 17e on iOS 27.0, 164s on iOS 26.5, and past 270s for an iPhone
 * Duo on iOS 27.1. A client that gives up does not stop the build, so the
 * `close` behind it times out too and the lease is left held.
 */
const WARM_UP_SNAPSHOT_MS = 15 * 60_000;

/**
 * Open, inspect and release one device through the local daemon before the
 * run goes live. On iOS this builds the XCTest runner, so the snapshot passes
 * `--timeout` (which sets agent-device's 90s default client budget). Once it
 * passes on iOS, the keep file makes the release return the device booted,
 * runner installed, instead of erasing it; a failed test still wipes it.
 */
export async function selfTest(agentDevice: string, platform: DevicePlatform): Promise<void> {
  const session = ["--session", "simbox-warmup"];
  const step = async (label: string, args: string[], timeoutMs: number) => {
    const res = await run([agentDevice, ...args, ...session], { timeoutMs });
    for (const line of `${res.stdout}\n${res.stderr}`.trim().split("\n").slice(-5))
      if (line.trim()) relayFiltered("agent-device", line);
    if (res.code !== 0) throw new Error(`warm-up ${label} failed (exit ${res.code})`);
  };
  await step("connect", ["connect", "--remote-config", agentDeviceProfile()], 60_000);
  try {
    await step(
      "open",
      platform === "ios"
        ? ["open", "com.apple.Preferences", "--platform", "ios"]
        : ["open", "--platform", "android"],
      300_000,
    );
    // The device booted and opened Settings, so `close` keeps it booted even
    // if the snapshot fails: that failure is the runner build or the RPC around
    // it, and an erase costs a full first boot again (7 minutes for a 17e on
    // iOS 27).
    if (platform === "ios") await writeFile(keepReclaimFile(), "");
    await step(
      "snapshot",
      ["snapshot", "--timeout", String(WARM_UP_SNAPSHOT_MS)],
      WARM_UP_SNAPSHOT_MS + 30_000,
    );
  } finally {
    await step("close", ["close"], 120_000).catch((err) => warn(String(err)));
  }
}
