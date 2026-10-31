/**
 * The run's device daemon: a standalone Simlock worker on 127.0.0.1:4701.
 * Simlock creates, boots, leases, wipes and streams the devices; the agent
 * installs it, configures one warm target, waits for it, mints the agent
 * token clients use, and reads its status for heartbeats and idle exit.
 */
import { chmod, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DevicePlatform } from "@simbox/shared";
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

/** Every `simlock config set` the run needs, in order. */
export function simlockSettings(options: {
  target: WarmTarget;
  maxDevices: number;
}): Array<[string, string]> {
  const { target } = options;
  const settings: Array<[string, string]> = [
    ["capabilities.agent-device.enabled", "true"],
    ["capabilities.stream.enabled", "true"],
    ["capabilities.input.enabled", "true"],
    // The pin is deliberate; a runner never updates itself mid-run.
    ["update.check", "false"],
    ["warmPool.targets", JSON.stringify([target])],
    // Every client of a run shares its one agent token: one Simlock requester.
    ["lease.maxPerRequester", String(Math.max(1, options.maxDevices))],
  ];
  if (target.platform === "android")
    settings.push(
      ["android.emulator.headless", "true"],
      ["android.emulator.audio", "false"],
      ["downloads.acceptAndroidLicenses", "true"],
    );
  return settings;
}

export function createSimlock(bins: SimlockBins) {
  const simlock = (args: string[], timeoutMs = 60_000) =>
    run([bins.simlock, ...args], { timeoutMs });

  async function status(): Promise<SimlockStatus | null> {
    const res = await simlock(["status", "--json"], 20_000);
    if (res.code !== 0) return null;
    try {
      return JSON.parse(res.stdout) as SimlockStatus;
    } catch {
      return null;
    }
  }

  async function logs(lines = 80): Promise<void> {
    const res = await simlock(["daemon", "logs"], 15_000);
    for (const line of res.stdout.trimEnd().split("\n").slice(-lines))
      if (line.trim()) relayFiltered("simlock", line);
  }

  return {
    status,
    logs,

    async configure(options: { target: WarmTarget; maxDevices: number }): Promise<void> {
      for (const [key, value] of simlockSettings(options)) {
        const res = await simlock(["config", "set", key, value]);
        if (res.code !== 0)
          throw new Error(
            `simlock config set ${key} failed (exit ${res.code}): ${res.stderr.trim().slice(-300)}`,
          );
      }
      info(`warm target: ${JSON.stringify(options.target)}`);
    },

    async start(): Promise<void> {
      const res = await simlock(["daemon", "start"], 120_000);
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
          : "warm pool: starting";
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
 * Open, inspect and release one device through the local daemon before the
 * run goes live. On iOS this builds the XCTest runner; the first snapshot on a
 * fresh lease then took 164s on a hosted Mac, past `snapshot`'s 90s default
 * client budget, so it passes `--timeout` (which sets that budget).
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
    await step("snapshot", ["snapshot", "--timeout", "270000"], 300_000);
  } finally {
    await step("close", ["close"], 120_000).catch((err) => warn(String(err)));
  }
}
