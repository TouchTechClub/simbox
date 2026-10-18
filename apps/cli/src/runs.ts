import type { DevicePlatform, PublicRun, RunSummary } from "@simbox/shared";
import { PLATFORMS } from "@simbox/shared";
import { activeRuns, CliError, runHistory } from "./client.js";
import { daemonBaseUrl, type ConnectInfo } from "./connect.js";
import { clearCachedRun, readCachedRun, writeCachedRun } from "./run-cache.js";
import { sleep } from "./util.js";

/**
 * Which run a command talks to, and when it is ready. At most one run is
 * active per platform (iOS on macOS, Android on Linux), so a platform names a
 * run. Everything here is injectable; production uses the API and the
 * per-platform cache in run-cache.ts.
 */

export const PLATFORM_NAMES: Record<DevicePlatform, string> = { ios: "iOS", android: "Android" };

export interface RunsDeps {
  activeRuns: () => Promise<PublicRun[]>;
  history: () => Promise<RunSummary[]>;
  probe: (info: ConnectInfo) => Promise<boolean>;
  readCache: (platform: DevicePlatform) => ConnectInfo | null;
  writeCache: (platform: DevicePlatform, info: ConnectInfo) => void;
  clearCache: (platform: DevicePlatform) => void;
  pause: (ms: number) => Promise<void>;
}

export const defaultRunsDeps: RunsDeps = {
  activeRuns,
  history: runHistory,
  probe: probeRemote,
  readCache: (platform) => readCachedRun(platform),
  writeCache: writeCachedRun,
  clearCache: clearCachedRun,
  pause: sleep,
};

const withDefaults = (deps: Partial<RunsDeps> = {}): RunsDeps => ({ ...defaultRunsDeps, ...deps });

/** Waiting for devices on a run that is already live (AVD prep, simulator boot). */
export const DEVICES_TIMEOUT_MS = 12 * 60_000;
const POLL_MS = 3000;

/** `--platform x` or `--platform=x` before any `--` separator. */
export function platformFlag(args: string[]): DevicePlatform | undefined {
  const end = args.indexOf("--");
  const flags = end < 0 ? args : args.slice(0, end);
  let found: DevicePlatform | undefined;
  for (let i = 0; i < flags.length; i++) {
    const arg = flags[i]!;
    const value =
      arg === "--platform"
        ? flags[i + 1]
        : arg.startsWith("--platform=")
          ? arg.slice("--platform=".length)
          : undefined;
    if (value === undefined) continue;
    if (value !== "ios" && value !== "android")
      throw new CliError(`Simbox runs serve --platform ios or android, not "${value}".`);
    if (found && found !== value)
      throw new CliError("Pass --platform once: a command goes to one run.");
    found = value;
  }
  return found;
}

function describe(run: PublicRun): string {
  return `${PLATFORM_NAMES[run.platform]} (run ${run.id}, ${run.state})`;
}

/**
 * Explicit platform, else the only active run's platform. Two active runs and
 * no platform is ambiguous and names both.
 */
export function targetPlatform(
  explicit: DevicePlatform | undefined,
  active: PublicRun[],
  hint = "Pass --platform ios or --platform android.",
): DevicePlatform {
  if (explicit) return explicit;
  if (active.length === 1) return active[0]!.platform;
  if (active.length === 0) throw new CliError("No active run. Start one with `simbox sim`.");
  throw new CliError(`Two runs are active: ${active.map(describe).join(" and ")}. ${hint}`);
}

/** Runs report devicesReady; older APIs only had androidReady (iOS was ready once live). */
export function devicesReady(run: PublicRun): boolean {
  return run.devicesReady ?? (run.platform === "android" ? run.androidReady : true);
}

export function connectInfo(run: PublicRun): ConnectInfo | null {
  if (run.state !== "live" || !run.tunnelUrl || !run.daemonToken) return null;
  return {
    runId: run.id,
    tunnelUrl: run.tunnelUrl,
    daemonToken: run.daemonToken,
    expiresAt: run.expiresAt,
  };
}

const STOPPED = new Set(["closing", "ended", "failed"]);

/**
 * Poll one run by id until it is live with its devices ready. Fails fast with
 * the run's endReason when it ends during startup; never switches to another
 * run (a replacement on the same platform is an error).
 */
export async function waitForRun(
  runId: string,
  options: {
    timeoutMs: number;
    /** Shown when the run never went live. */
    timeoutMessage: string;
    onUpdate?: (run: PublicRun) => void;
    deps?: Partial<RunsDeps>;
  },
): Promise<{ run: PublicRun; info: ConnectInfo }> {
  const deps = withDefaults(options.deps);
  const deadline = Date.now() + options.timeoutMs;
  let last: PublicRun | null = null;
  while (true) {
    const run = (await deps.activeRuns()).find((candidate) => candidate.id === runId);
    if (!run) {
      const past = (await deps.history()).find((candidate) => candidate.id === runId);
      const name = past ? PLATFORM_NAMES[past.platform] : "The";
      const retry = past ? ` --platform ${past.platform}` : "";
      throw new CliError(
        past && STOPPED.has(past.state)
          ? `The ${name} run ${past.state} before its devices were ready (${past.endReason ?? "check the Actions logs"}). Try \`simbox sim --new${retry}\`.`
          : `${name} run ${runId} is no longer active (it ended or was replaced). Run \`simbox sim${retry}\` again.`,
      );
    }
    if (STOPPED.has(run.state))
      throw new CliError(
        `The ${PLATFORM_NAMES[run.platform]} run ${run.state} before its devices were ready (${run.endReason ?? "check the Actions logs"}). Try \`simbox sim --new --platform ${run.platform}\`.`,
      );
    last = run;
    options.onUpdate?.(run);
    const info = connectInfo(run);
    if (info && devicesReady(run)) return { run, info };
    if (Date.now() >= deadline) break;
    await deps.pause(POLL_MS);
  }
  if (last?.state === "live")
    throw new CliError(
      `The ${PLATFORM_NAMES[last.platform]} run is live but its devices did not finish booting. Inspect the Actions job's device logs. No device command was sent.`,
    );
  throw new CliError(options.timeoutMessage);
}

/** The platform's live run endpoint from the API, or null. */
export async function refreshPlatform(
  platform: DevicePlatform,
  deps: Partial<RunsDeps> = {},
): Promise<ConnectInfo | null> {
  const run = (await withDefaults(deps).activeRuns()).find((r) => r.platform === platform);
  return run ? connectInfo(run) : null;
}

/** Poll only reads: never replay an open/tap/install whose outcome is unknown. */
export async function waitForRemote(
  initial: ConnectInfo,
  options: {
    timeoutMs?: number;
    probe?: (info: ConnectInfo) => Promise<boolean>;
    refresh: () => Promise<ConnectInfo | null>;
    pause?: () => Promise<void>;
  },
): Promise<ConnectInfo> {
  const probe = options.probe ?? probeRemote;
  // Covers two supervisor heartbeat intervals plus tunnel restart/DNS time.
  const deadline = Date.now() + (options.timeoutMs ?? 180_000);
  let info = initial;
  do {
    if (await probe(info)) return info;
    const next = await options.refresh();
    if (!next || next.runId !== initial.runId) {
      throw new CliError("The run ended or was replaced. Run `simbox sim` to connect again.");
    }
    info = next;
    await (options.pause?.() ?? sleep(1000));
  } while (Date.now() < deadline);
  throw new CliError(
    "The run is live but its tunnel/daemon is not ready. Retry `simbox sim` or inspect the Actions logs. No device command was sent.",
  );
}

export async function probeRemote(info: ConnectInfo): Promise<boolean> {
  try {
    const res = await fetch(`${daemonBaseUrl(info.tunnelUrl)}/health`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean; upstream?: { ok?: boolean } };
    return body.ok === true && body.upstream?.ok !== false;
  } catch {
    return false;
  }
}

/**
 * A reachable endpoint for this platform's run: its cache when the runner
 * answers, else the API, waiting until the run is live with devices ready.
 */
export async function connect(
  platform: DevicePlatform,
  options: { active?: PublicRun[]; timeoutMs?: number; deps?: Partial<RunsDeps> } = {},
): Promise<ConnectInfo> {
  const deps = withDefaults(options.deps);
  const cached = deps.readCache(platform);
  if (cached && (await deps.probe(cached))) return cached;
  const active = options.active ?? (await deps.activeRuns());
  const run = active.find((candidate) => candidate.platform === platform);
  if (!run) {
    deps.clearCache(platform);
    throw new CliError(
      `No active ${PLATFORM_NAMES[platform]} run. Start one with \`simbox sim --platform ${platform}\`.`,
    );
  }
  const ready = await waitForRun(run.id, {
    timeoutMs: options.timeoutMs ?? DEVICES_TIMEOUT_MS,
    timeoutMessage: `The ${PLATFORM_NAMES[platform]} run did not come online in time. Check the workflow run in your repo's Actions tab. No device command was sent.`,
    deps,
  });
  const info = await waitForRemote(ready.info, {
    probe: deps.probe,
    refresh: () => refreshPlatform(platform, deps),
    pause: () => deps.pause(1000),
  });
  deps.writeCache(platform, info);
  return info;
}

/**
 * Route a device command: explicit --platform, else the only platform this
 * machine has a reachable cached endpoint for, else the only active run.
 */
export async function connectForArgs(
  args: string[],
  deps: Partial<RunsDeps> = {},
): Promise<{ platform: DevicePlatform; info: ConnectInfo }> {
  const all = withDefaults(deps);
  const explicit = platformFlag(args);
  if (explicit) return { platform: explicit, info: await connect(explicit, { deps: all }) };
  const cached = PLATFORMS.flatMap((platform) => {
    const info = all.readCache(platform);
    return info ? [{ platform, info }] : [];
  });
  if (cached.length === 1 && (await all.probe(cached[0]!.info))) return cached[0]!;
  const active = await all.activeRuns();
  const platform = targetPlatform(undefined, active);
  return { platform, info: await connect(platform, { active, deps: all }) };
}
