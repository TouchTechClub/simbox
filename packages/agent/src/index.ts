/**
 * simbox-agent — prepares the run's iOS simulator (macOS) or Android emulator
 * (Linux/KVM), boots agent-device proxy + a Cloudflare tunnel, registers with
 * the simbox API, then supervises until idle/hard-exit/stop/token revocation.
 *
 * Staged mode (SIMBOX_STAGE_DIR, see stage.ts) pauses between "devices
 * booted" and "tunnel + register" so workflow steps can run in between.
 *
 * Exit codes: 0 = clean shutdown (green check), 1 = failure (red X).
 */
import { randomBytes } from "node:crypto";
import { availableParallelism } from "node:os";
import {
  deviceCapForCpus,
  HARD_EXIT_MINUTES,
  HEARTBEAT_INTERVAL_SECONDS,
  IDLE_EXIT_MINUTES,
  PROD_API_URL,
  PROXY_PORT,
} from "@simbox/shared";
import type {
  BootedDevice,
  DevicePlatform,
  DeviceProfile,
  RunConfigResponse,
  RunRegisterRequest,
  RunTunnelResponse,
} from "@simbox/shared";
import { PINS } from "./pins.js";
import pkg from "../package.json" with { type: "json" };
import { addMask, error, info, warn } from "./log.js";
import { childEnv, pumpLines, relayFiltered, run, setSecretFilter } from "./proc.js";
import type { ChildProc } from "./proc.js";
import { installAgentDevice, installCloudflared } from "./provision.js";
import { ApiClient, HttpError, runIsOver } from "./api.js";
import { activeSessionDevices } from "./devices.js";
import { bootRefusal, devicesOverCap } from "./device-cap.js";
import { simctlJson } from "./xcode.js";
import { waitForAuthoritativeDns } from "./dns.js";
import { startGateway } from "./gateway.js";
import { createPreviewHub } from "./preview-hub.js";
import { healthyProxy, waitForProxy } from "./health.js";
import { createIOSAdapter, prepareIOS, quietHost, raisePriority } from "./ios.js";
import {
  configureAndroidEnvironment,
  createAndroidAdapter,
  type AndroidAdapter,
} from "./android.js";
import {
  hostMismatch,
  hostPlatform,
  printableCatalog,
  type DeviceChoice,
  type PlatformAdapter,
} from "./platform.js";
import { createStage, jobStartedAt } from "./stage.js";

const TUNNEL_URL_TIMEOUT_MS = 60_000;
const TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
/** Any quick-tunnel hostname, with or without a scheme. */
const QUICK_TUNNEL_HOST_RE = /[a-z0-9-]+\.trycloudflare\.com/i;
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const REGISTER_ATTEMPTS = 3;
const HEARTBEAT_FAILURE_LIMIT = 3;
const TUNNEL_PROBE_TIMEOUT_MS = 15_000;
const TUNNEL_RECONNECT_WINDOW_MS = 60_000;
const TUNNEL_REPROBE_INTERVAL_MS = 10_000;
const PROXY_PROBE_TIMEOUT_MS = 10_000;
const PROXY_PROBE_FAILURE_LIMIT = 2;
const PROXY_RESTART_LIMIT = 5; // daemon can die repeatedly on GH macOS runners
const TUNNEL_RESTART_LIMIT = 3;
const EMULATOR_RESTART_LIMIT = 2;
/** A child that ran this long before dying earns back its full restart budget. */
const HEALTHY_RESET_MS = 30 * 60_000;
/** Cleanup never outlives this; a stuck step must not keep the job running. */
const SHUTDOWN_DEADLINE_MS = 30_000;
const UPSTREAM_PORT = PROXY_PORT + 1;

// ---------------------------------------------------------------------------
// Shared run state (module-level so provision/supervise/shutdown all see it)
// ---------------------------------------------------------------------------

interface ManagedChild {
  name: string;
  proc: ChildProc;
  restarts: number;
  /** Exited, or deliberately being stopped (its exit is then not "unexpected"). */
  dead: boolean;
  startedAt: number;
}

const stage = createStage(Bun.env.SIMBOX_STAGE_DIR || undefined);

const state = {
  apiUrl: Bun.env.SIMBOX_API_URL ?? PROD_API_URL,
  token: Bun.env.SIMBOX_TOKEN ?? "",
  ghRunId: 0,
  /** Simbox's run id (`simbox_run` workflow input); empty for legacy/manual runs. */
  runId: (Bun.env.SIMBOX_RUN_ID ?? "").trim(),
  ghRunAttempt: Bun.env.GITHUB_RUN_ATTEMPT ?? "?",
  platform: "ios" as DevicePlatform,
  daemonToken: "",
  tunnelUrl: "",
  /** Named tunnel for this run; null → quick tunnel (older API, or provisioning failed). */
  named: null as RunTunnelResponse | null,
  /** Device requested for this run beyond the platform defaults. */
  device: null as DeviceProfile | null,
  /** What was actually booted, once it is. */
  booted: null as BootedDevice | null,
  agentDeviceBin: "",
  cloudflaredBin: "",
  /** The run's device is booted and accepts commands. */
  devicesReady: false,
  /** Device preparation or emulator recovery is running: work, not idleness. */
  preparing: true,
  activeDevices: 0,
  /** Devices this runner runs at once (configured, else sized from its vCPUs). */
  maxDevices: 1,
  emulatorRestarts: 0,
  registered: false,
  shuttingDown: false,
  /** Hard-exit clock: the job's start when the prepare step recorded it. */
  bootedAt: jobStartedAt(Bun.env.SIMBOX_JOB_STARTED_AT, Date.now()),
  children: {} as { proxy?: ManagedChild; tunnel?: ManagedChild; emulator?: ManagedChild },
  gateway: null as ReturnType<typeof startGateway> | null,
  wake: null as (() => void) | null,
};
const previewHub = createPreviewHub();
let adapter: PlatformAdapter | null = null;
let android: AndroidAdapter | null = null;

/** Every exit path records its code for the action's serve step first. */
function exit(code: number): never {
  stage.recordExit(code);
  process.exit(code);
}

/** Run identity sent on every runner API call. */
const ids = () => ({ ghRunId: state.ghRunId, ...(state.runId ? { runId: state.runId } : {}) });

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

function notifyWake(): void {
  const w = state.wake;
  state.wake = null;
  w?.();
}

/** Sleep `ms`, waking early if a supervised child exits. */
async function interruptibleSleep(ms: number): Promise<void> {
  let woke = false;
  const wokeP = new Promise<void>((resolve) => {
    state.wake = () => {
      woke = true;
      resolve();
    };
  });
  await Promise.race([Bun.sleep(ms), wokeP]);
  if (!woke) state.wake = null;
}

// ---------------------------------------------------------------------------
// Child processes
// ---------------------------------------------------------------------------

function track(name: string, proc: ChildProc, restarts = 0): ManagedChild {
  const child: ManagedChild = { name, proc, restarts, dead: false, startedAt: Date.now() };
  proc.exited
    .then((code) => {
      const expected = child.dead;
      child.dead = true;
      if (!expected && !state.shuttingDown) {
        warn(`${name} exited unexpectedly (code ${code})`);
        notifyWake();
      }
    })
    .catch(() => {
      child.dead = true;
    });
  return child;
}

/** Stop a child and wait until it is gone, so a replacement can reuse its port. */
async function stopChild(child: ManagedChild): Promise<void> {
  child.dead = true;
  const running = () => child.proc.exitCode === null && child.proc.signalCode === null;
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    if (!running()) return;
    try {
      child.proc.kill(signal);
    } catch {
      /* already gone */
    }
    await Promise.race([child.proc.exited, Bun.sleep(5000)]);
  }
}

/** Restarts already spent; a child that ran healthily for a while starts afresh. */
function restartsUsed(child: ManagedChild): number {
  return Date.now() - child.startedAt >= HEALTHY_RESET_MS ? 0 : child.restarts;
}

function spawnProxy(restarts = 0): ManagedChild {
  const proc = Bun.spawn(
    [
      state.agentDeviceBin,
      "proxy",
      "--port",
      String(UPSTREAM_PORT),
      "--host",
      "127.0.0.1",
      "--daemon-auth-token",
      state.daemonToken,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      // Simbox owns idle shutdown. Otherwise an unused embedded daemon reaps
      // itself after five minutes, leaving a live proxy with a dead upstream.
      env: childEnv({ AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: "0" }),
    },
  );
  const child = track("agent-device proxy", proc, restarts);
  pumpLines(proc.stdout, "agent-device");
  pumpLines(proc.stderr, "agent-device");
  return child;
}

interface TunnelSpawn {
  child: ManagedChild;
  url: Promise<string>;
}

function spawnTunnel(restarts = 0): TunnelSpawn {
  return state.named ? spawnNamedTunnel(state.named, restarts) : spawnQuickTunnel(restarts);
}

/**
 * A named tunnel keeps several edge connections and one URL for the run. Its
 * token stays in the environment (never argv); it is up once the first edge
 * connection registers.
 */
function spawnNamedTunnel(named: RunTunnelResponse, restarts: number): TunnelSpawn {
  const proc = Bun.spawn(
    [state.cloudflaredBin, "tunnel", "--no-autoupdate", "--protocol", "http2", "run"],
    {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: childEnv({ TUNNEL_TOKEN: named.connectorToken }),
    },
  );
  const child = track("cloudflared", proc, restarts);
  if (process.platform === "darwin") void raisePriority(proc.pid, "cloudflared");
  let settled = false;
  const url = new Promise<string>((resolve, reject) => {
    const deadline = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`no edge connection within ${TUNNEL_URL_TIMEOUT_MS / 1000}s`));
      }
    }, TUNNEL_URL_TIMEOUT_MS);
    pumpLines(proc.stderr, "cloudflared", (line) => {
      if (!settled && line.includes("Registered tunnel connection")) {
        settled = true;
        clearTimeout(deadline);
        resolve(named.tunnelUrl);
      }
    });
    proc.exited.then((code) => {
      if (!settled) {
        settled = true;
        clearTimeout(deadline);
        reject(new Error(`cloudflared exited (code ${code}) before connecting`));
      }
    });
  });
  pumpLines(proc.stdout, "cloudflared");
  return { child, url };
}

function spawnQuickTunnel(restarts: number): TunnelSpawn {
  const proc = Bun.spawn(
    [
      state.cloudflaredBin,
      "tunnel",
      // UDP egress on GH-hosted macOS runners dies silently under load —
      // cloudflared's default QUIC never re-registers, leaving a dead 530
      // tunnel on a live process. http2 stays on TCP.
      "--protocol",
      "http2",
      "--url",
      `http://127.0.0.1:${PROXY_PORT}`,
      "--no-autoupdate",
    ],
    { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: childEnv() },
  );
  const child = track("cloudflared", proc, restarts);
  if (process.platform === "darwin") void raisePriority(proc.pid, "cloudflared");

  // The trycloudflare URL is printed on stderr once the tunnel is up.
  let settled = false;
  const url = new Promise<string>((resolve, reject) => {
    const deadline = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`no trycloudflare URL within ${TUNNEL_URL_TIMEOUT_MS / 1000}s`));
      }
    }, TUNNEL_URL_TIMEOUT_MS);
    pumpLines(proc.stderr, "cloudflared", (line) => {
      const m = TUNNEL_URL_RE.exec(line);
      if (m && !settled) {
        settled = true;
        clearTimeout(deadline);
        resolve(m[0]);
      }
    });
    proc.exited.then((code) => {
      if (!settled) {
        settled = true;
        clearTimeout(deadline);
        reject(new Error(`cloudflared exited (code ${code}) before tunnel URL`));
      }
    });
  });
  pumpLines(proc.stdout, "cloudflared");
  return { child, url };
}

/** Mask a tunnel URL and its bare hostname (logs mention either). */
function maskTunnel(url: string): void {
  addMask(url);
  addMask(new URL(url).hostname);
}

// ---------------------------------------------------------------------------
// API calls with their retry/fatal policies
// ---------------------------------------------------------------------------

const api = () => new ApiClient(state.apiUrl, state.token);

function isRetriable(err: unknown): boolean {
  if (err instanceof HttpError) {
    if (err.status >= 400 && err.status < 500) return false; // 4xx = fatal
    return true; // 5xx retriable
  }
  return true; // network errors retriable
}

/** What to prepare; null (host defaults) when the API is older or unreachable. */
async function requestRunConfig(): Promise<RunConfigResponse | null> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await api().config(ids());
    } catch (err) {
      if (err instanceof HttpError && err.status < 500) {
        info(`run config unavailable (HTTP ${err.status}); preparing default devices`);
        return null;
      }
      warn(`run config request failed: ${String(err).slice(0, 200)}`);
      if (attempt < 3) await Bun.sleep(2000);
    }
  }
  warn("could not read the run config; preparing default devices");
  return null;
}

/** Ask the API for a named tunnel; any failure means a quick tunnel instead. */
async function requestNamedTunnel(): Promise<RunTunnelResponse | null> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const named = await api().tunnel(ids());
      addMask(named.connectorToken);
      maskTunnel(named.tunnelUrl);
      info("named tunnel provisioned");
      return named;
    } catch (err) {
      // 4xx (unconfigured, older API, rejected run) will not change on retry.
      if (err instanceof HttpError && err.status < 500) {
        info(`named tunnel unavailable (HTTP ${err.status}); using a quick tunnel`);
        return null;
      }
      warn(`named tunnel request failed: ${String(err).slice(0, 200)}`);
      if (attempt < 2) await Bun.sleep(2000);
    }
  }
  info("using a quick tunnel");
  return null;
}

/** Throws on failure, except a run that is already over, which exits cleanly. */
async function register(): Promise<void> {
  const body: RunRegisterRequest = {
    ...ids(),
    tunnelUrl: state.tunnelUrl,
    daemonToken: state.daemonToken,
    versions: {
      agent: pkg.version,
      agentDevice: PINS.agentDevice,
      cloudflared: PINS.cloudflared,
      deviceHub: PINS.deviceHub,
    },
    maxDevices: state.maxDevices,
  };
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= REGISTER_ATTEMPTS; attempt++) {
    try {
      await api().register(body);
      state.registered = true;
      info(`registered run ${state.ghRunId} (attempt ${attempt})`);
      return;
    } catch (err) {
      lastErr = err;
      if (runIsOver(err)) await shutdown("run is over (stopped before it went live)", 0);
      if (!isRetriable(err)) {
        error(`registration rejected (${String(err)}) — exiting`);
        throw err;
      }
      warn(`register attempt ${attempt}/${REGISTER_ATTEMPTS} failed: ${String(err).slice(0, 200)}`);
      if (attempt < REGISTER_ATTEMPTS) await Bun.sleep(1000 * attempt);
    }
  }
  error(`registration failed after ${REGISTER_ATTEMPTS} attempts: ${String(lastErr)}`);
  throw lastErr;
}

let heartbeatFailures = 0;

/** One heartbeat. A run the API says is over exits cleanly; repeated failures exit 1. */
async function heartbeat(): Promise<boolean> {
  try {
    await api().heartbeat({
      ...ids(),
      activeDevices: state.activeDevices,
      androidReady: state.platform === "android" && state.devicesReady,
      devicesReady: state.devicesReady,
    });
    heartbeatFailures = 0;
    return true;
  } catch (err) {
    if (runIsOver(err, { notFound: true }))
      await shutdown("run is over (stopped or ended on the API)", 0);
    if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
      error("heartbeat unauthorized — SIMBOX_TOKEN revoked, exiting");
      await shutdown("token revoked", 1);
    }
    heartbeatFailures++;
    warn(
      `heartbeat failed (${heartbeatFailures}/${HEARTBEAT_FAILURE_LIMIT}): ${String(err).slice(0, 200)}`,
    );
    if (heartbeatFailures >= HEARTBEAT_FAILURE_LIMIT) {
      error("too many consecutive heartbeat failures — exiting");
      await shutdown("heartbeat failures", 1);
    }
    return false;
  }
}

/** Tell the API what this runner offers and what it booted. Never fatal. */
async function reportInventory(choice: DeviceChoice | null): Promise<void> {
  try {
    const catalog = choice?.catalog ?? (await adapter!.catalog());
    if (state.shuttingDown) return;
    await api().inventory({
      ...ids(),
      catalog: printableCatalog(catalog),
      ...(state.booted ? { booted: state.booted } : {}),
    });
    info("reported this runner's device catalog");
  } catch (err) {
    info(`device catalog not reported (non-fatal): ${String(err).slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

async function killChildren(): Promise<void> {
  const kids = [state.children.proxy, state.children.tunnel, state.children.emulator].filter(
    (c): c is ManagedChild => !!c,
  );
  for (const c of kids) {
    if (c.dead) continue;
    try {
      c.proc.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  // Give them a moment, then SIGKILL stragglers.
  await Promise.race([
    Promise.allSettled(kids.filter((c) => !c.dead).map((c) => c.proc.exited)),
    Bun.sleep(3000),
  ]);
  for (const c of kids) {
    if (c.dead) continue;
    try {
      c.proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/**
 * Deregister, stop children and exit. Only the first call does anything; a
 * second signal (or a failure noticed meanwhile) waits for that cleanup.
 */
async function shutdown(reason: string, code: number): Promise<never> {
  if (state.shuttingDown) {
    info(`already shutting down; ignoring: ${reason}`);
    return new Promise<never>(() => {});
  }
  state.shuttingDown = true;
  setTimeout(() => {
    warn(`cleanup did not finish within ${SHUTDOWN_DEADLINE_MS / 1000}s`);
    exit(code);
  }, SHUTDOWN_DEADLINE_MS);
  info(`shutting down: ${reason}`);
  if (state.ghRunId > 0 && state.token) {
    try {
      await api().deregister({ ...ids(), reason });
    } catch (err) {
      warn(`deregister failed (continuing shutdown): ${String(err).slice(0, 200)}`);
    }
  }
  await killChildren();
  state.gateway?.stopPreview();
  await previewHub.stop();
  // Bun can retain an upgraded socket in its stop promise after the peer has
  // closed. Preview transports are already released; never wedge hard exit.
  await Promise.race([state.gateway?.server.stop(true), Bun.sleep(1000)]);
  info(`goodbye (exit ${code})`);
  exit(code);
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

/**
 * Boot the chosen device. Never throws: an Android run, or an explicitly
 * requested iOS device, that cannot boot shuts the run down with the reason;
 * the default iPhone's warmup failing only warns (agent-device boots on use).
 */
async function bootDevices(choice: DeviceChoice | null): Promise<void> {
  try {
    if (choice) state.booted = await adapter!.boot(choice);
    else await prepareIOS(state.agentDeviceBin);
    state.devicesReady = true;
    state.preparing = false;
    info(`devices ready${state.booted ? `: ${state.booted.name} (${state.booted.os})` : ""}`);
    if (state.registered) void heartbeat();
  } catch (err) {
    state.preparing = false;
    const reason = `${state.platform === "ios" ? "iOS simulator" : "Android emulator"} did not boot: ${message(err)}`;
    if (state.platform === "android" || state.device) {
      error(reason.slice(0, 500));
      await shutdown(reason.slice(0, 200), 1);
    }
    warn(`optional iOS warmup failed; the simulator boots on first use: ${message(err)}`);
    // Still usable: agent-device boots the simulator on the first command.
    state.devicesReady = true;
    if (state.registered) void heartbeat();
  }
  void reportInventory(choice);
}

/** A crashed emulator is relaunched in the background within a small budget. */
function recoverEmulator(dead: ManagedChild): string | null {
  const used = restartsUsed(dead);
  if (used >= EMULATOR_RESTART_LIMIT)
    return `Android emulator crashed ${used + 1} times; giving up`;
  state.devicesReady = false;
  state.preparing = true;
  state.emulatorRestarts = used + 1;
  warn(`Android emulator died; relaunching it (${used + 1}/${EMULATOR_RESTART_LIMIT})`);
  void heartbeat();
  void android!
    .relaunch()
    .then(() => {
      state.devicesReady = true;
      state.preparing = false;
      void heartbeat();
    })
    .catch((err) => shutdown(`Android emulator relaunch failed: ${message(err)}`.slice(0, 200), 1));
  return null;
}

// ---------------------------------------------------------------------------
// Device cap (iOS; an Android runner has a single emulator)
// ---------------------------------------------------------------------------

/** When each booted simulator was first seen booted. */
const bootedSince = new Map<string, number>();

async function bootedSimulators(): Promise<Set<string>> {
  const { devices } = await simctlJson<{
    devices: Record<string, Array<{ udid: string; state?: string }>>;
  }>(["devices", "booted"]);
  const ids = new Set(
    Object.values(devices)
      .flat()
      .filter((device) => device.state === "Booted" && device.udid)
      .map((device) => device.udid),
  );
  for (const id of bootedSince.keys()) if (!ids.has(id)) bootedSince.delete(id);
  for (const id of ids) if (!bootedSince.has(id)) bootedSince.set(id, Date.now());
  return ids;
}

const inUse = (sessions: Set<string> | null) =>
  new Set([...(sessions ?? []), ...(state.gateway?.viewedDevices() ?? [])]);

/** Device-panel boots wait for a free slot; idle devices do not hold one. */
async function refuseBoot(target: string | null): Promise<string | null> {
  if (state.platform !== "ios") return null;
  const sessions = await activeSessionDevices(UPSTREAM_PORT, state.daemonToken);
  return bootRefusal({
    target,
    booted: await bootedSimulators(),
    inUse: inUse(sessions),
    cap: state.maxDevices,
  });
}

/** Shut down idle simulators above the cap; unknown sessions stop nothing. */
async function enforceDeviceCap(sessions: Set<string> | null): Promise<void> {
  if (state.platform !== "ios" || state.preparing || sessions === null) return;
  let booted: Set<string>;
  try {
    booted = await bootedSimulators();
  } catch (err) {
    warn(`could not list booted simulators: ${message(err)}`);
    return;
  }
  const victims = devicesOverCap({
    booted: [...booted].map((id) => ({ id, since: bootedSince.get(id) ?? Date.now() })),
    inUse: inUse(sessions),
    cap: state.maxDevices,
    now: Date.now(),
  });
  for (const id of victims) {
    info(`shutting down idle simulator ${id}: this runner runs ${state.maxDevices} at a time`);
    const result = await run(["xcrun", "simctl", "shutdown", id], { timeoutMs: 60_000 });
    if (result.code !== 0)
      warn(`simctl shutdown ${id} failed: ${result.stderr.trim().slice(-200)}`);
  }
}

// ---------------------------------------------------------------------------
// Supervision loop
// ---------------------------------------------------------------------------

async function restartProxy(): Promise<string | null> {
  const old = state.children.proxy!;
  const used = restartsUsed(old);
  if (used >= PROXY_RESTART_LIMIT)
    return `agent-device proxy kept dying (${PROXY_RESTART_LIMIT} restarts used)`;
  // The replacement binds the same port: the old process must be gone first.
  await stopChild(old);
  warn(`restarting agent-device proxy (${used + 1}/${PROXY_RESTART_LIMIT})`);
  const next = spawnProxy(used + 1);
  state.children.proxy = next;
  try {
    await waitForProxy(`http://127.0.0.1:${PROXY_PORT}/agent-device/health`);
  } catch (err) {
    // A failed restart: the next supervision pass tries again within budget.
    warn(`restarted agent-device proxy is unhealthy: ${message(err).slice(0, 200)}`);
    await stopChild(next);
  }
  return null;
}

async function restartTunnel(): Promise<string | null> {
  const old = state.children.tunnel!;
  const used = restartsUsed(old);
  if (used >= TUNNEL_RESTART_LIMIT)
    return `cloudflared kept dying (${TUNNEL_RESTART_LIMIT} restarts used)`;
  await stopChild(old);
  warn(`restarting cloudflared${state.named ? "" : " (new tunnel URL)"}`);
  const t = spawnTunnel(used + 1);
  state.children.tunnel = t.child;
  try {
    const newUrl = await t.url;
    maskTunnel(newUrl);
    state.tunnelUrl = newUrl;
    // A runner's DNS/egress is not an authoritative test of a tunnel client
    // can reach. The CLI validates public readiness before returning it.
    // URL changed → re-register so the API hands out the fresh tunnel.
    await register();
    info("tunnel re-registered with new URL");
  } catch (err) {
    error(`tunnel restart failed: ${String(err).slice(0, 300)}`);
    return `tunnel restart failed: ${message(err).slice(0, 150)}`;
  }
  return null;
}

/** Restart dead children within their budgets. Returns a shutdown reason if exhausted. */
async function handleDeadChildren(): Promise<string | null> {
  if (state.children.proxy?.dead) {
    const failure = await restartProxy();
    if (failure) return failure;
  }
  if (state.children.tunnel?.dead) {
    const failure = await restartTunnel();
    if (failure) return failure;
  }
  // Death during a boot is the boot's failure; only a booted emulator is recovered.
  const emulator = state.children.emulator;
  if (emulator?.dead && android && state.devicesReady) return recoverEmulator(emulator);
  return null;
}

/**
 * Edge-side tunnel liveness. A zombie cloudflared (QUIC datagram dead but
 * process alive) looks fine to process supervision while the edge serves
 * 530 — the tunnel appears "live" in the API but is unreachable.
 *
 * Only status 530 and network errors/timeouts count as dead: other statuses
 * (502/504/4xx) mean the edge reached our origin, i.e. the tunnel works and
 * the proxy is just busy (e.g. building the Apple runner during `open`).
 */
async function tunnelEdgeDead(): Promise<boolean> {
  if (!state.tunnelUrl) return false;
  try {
    const res = await fetch(`${state.tunnelUrl}/agent-device/health`, {
      signal: AbortSignal.timeout(TUNNEL_PROBE_TIMEOUT_MS),
    });
    if (res.status === 530) warn("tunnel probe: HTTP 530");
    return res.status === 530;
  } catch (error) {
    warn(`tunnel probe: ${error instanceof Error ? error.name : "network error"}`);
    return true; // DNS/connect/timeout — edge can't reach us
  }
}

/** Re-probe through cloudflared's reconnect window; true if never reachable. */
async function tunnelStaysDead(): Promise<boolean> {
  const deadline = Date.now() + TUNNEL_RECONNECT_WINDOW_MS;
  while (Date.now() < deadline) {
    await interruptibleSleep(TUNNEL_REPROBE_INTERVAL_MS);
    if (state.shuttingDown || state.children.tunnel?.dead) return false;
    if (!(await tunnelEdgeDead())) return false;
  }
  return true;
}

/**
 * agent-device swallows daemon crashes into ndjson diagnostics under
 * ~/.agent-device/logs — print the tail of the freshest ones into our step
 * log so daemon deaths are diagnosable from the Actions UI. Lines go through
 * the secret filter like any other child output.
 */
async function dumpRecentDaemonLogs(): Promise<void> {
  const res = await run(
    [
      "/bin/sh",
      "-c",
      "ls -t ~/.agent-device/logs/*/*.ndjson ~/.agent-device/logs/*/*/*.ndjson 2>/dev/null | head -3",
    ],
    { timeoutMs: 10_000 },
  );
  for (const file of res.stdout.split("\n").filter(Boolean)) {
    const tail = await run(["tail", "-n", "30", file], { timeoutMs: 10_000 });
    if (tail.stdout.trim()) {
      for (const line of tail.stdout.trimEnd().split("\n")) {
        relayFiltered(`agent-device log ${file}`, line);
      }
    }
  }
}

/**
 * Local proxy liveness. The proxy's embedded daemon can die while the proxy
 * process stays up — /health then returns {"ok":false,"error":"fetch failed"}
 * forever (observed on GH macOS runners ~60-90s after a client connects).
 * Proxy restart re-spawns its child daemon.
 */
async function proxyUpstreamDead(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${PROXY_PORT}/agent-device/health`, {
      signal: AbortSignal.timeout(PROXY_PROBE_TIMEOUT_MS),
    });
    return !healthyProxy(res.status, await res.json());
  } catch {
    return true; // local connect/timeout — proxy wedged
  }
}

async function checkHardExit(): Promise<void> {
  if (Date.now() - state.bootedAt >= HARD_EXIT_MINUTES * 60_000)
    await shutdown(`hard exit after ${HARD_EXIT_MINUTES} minutes`, 0);
}

async function supervise(): Promise<never> {
  let proxyProbeFailures = 0;
  let lastDeviceSeenAt = Date.now(); // idle clock starts once the run is live
  for (;;) {
    await interruptibleSleep(HEARTBEAT_INTERVAL_SECONDS * 1000);
    // A cold boot/runner build is real work, not an idle or wedged daemon.
    const activity = state.gateway?.activity();
    let busy = (activity?.inFlight ?? 0) > 0;
    if (activity) lastDeviceSeenAt = Math.max(lastDeviceSeenAt, activity.lastActivityAt);

    // --- children ---
    const failure = await handleDeadChildren();
    if (failure) await shutdown(failure, 1);

    // --- tunnel liveness (edge-side; process can be a zombie) ---
    // Quick tunnels hold a single edge connection, so every edge drop is a
    // full outage that cloudflared usually heals in 10-30s on the same URL.
    // Only a tunnel that stays dead is replaced: a new URL strands clients.
    if (!busy && !state.children.tunnel?.dead && (await tunnelEdgeDead())) {
      warn("tunnel unreachable at edge; waiting for cloudflared to reconnect");
      if (await tunnelStaysDead()) {
        warn("killing zombie cloudflared to force reconnect");
        state.children.tunnel!.dead = true; // restartTunnel stops it and awaits its exit
        const restart = await handleDeadChildren();
        if (restart) await shutdown(restart, 1);
      } else info("tunnel reconnected");
    }

    // --- proxy liveness (upstream daemon can die inside a live proxy) ---
    if (!busy && !state.children.proxy?.dead && (await proxyUpstreamDead())) {
      proxyProbeFailures += 1;
      warn(`proxy upstream dead (${proxyProbeFailures}/${PROXY_PROBE_FAILURE_LIMIT})`);
      if (proxyProbeFailures >= PROXY_PROBE_FAILURE_LIMIT) {
        warn("killing wedged agent-device proxy to force restart");
        proxyProbeFailures = 0;
        await dumpRecentDaemonLogs();
        state.children.proxy!.dead = true; // restartProxy stops it and awaits its exit
        const restart = await handleDeadChildren();
        if (restart) await shutdown(restart, 1);
      }
    } else {
      proxyProbeFailures = 0;
    }

    // --- device count and cap ---
    const sessions = await activeSessionDevices(UPSTREAM_PORT, state.daemonToken);
    const deviceCount = sessions?.size ?? null;
    if (!busy) await enforceDeviceCap(sessions);
    // Unknown inventory is not evidence that a session is idle. Hard exit
    // remains authoritative even if inventory is unavailable.
    if (deviceCount === null || deviceCount > 0) lastDeviceSeenAt = Date.now();
    state.activeDevices = deviceCount ?? 0;
    // A request can start while probes/device inventory are awaited.
    const latestActivity = state.gateway?.activity();
    busy = (latestActivity?.inFlight ?? 0) > 0;
    if (latestActivity)
      lastDeviceSeenAt = Math.max(lastDeviceSeenAt, latestActivity.lastActivityAt);
    // Device preparation and emulator recovery are work, not idleness.
    if (state.preparing) lastDeviceSeenAt = Date.now();

    // --- exits (checked before heartbeat so a dead run doesn't beat one more time) ---
    const uptimeMin = (Date.now() - state.bootedAt) / 60_000;
    await checkHardExit();
    const idleMin = (Date.now() - lastDeviceSeenAt) / 60_000;
    if (!busy && idleMin >= IDLE_EXIT_MINUTES) {
      await shutdown(`idle exit — no active devices for ${IDLE_EXIT_MINUTES} minutes`, 0);
    }

    // --- heartbeat ---
    if (await heartbeat())
      info(
        `heartbeat ok — devices=${state.activeDevices} ready=${state.devicesReady} ` +
          `idle=${idleMin.toFixed(1)}m busy=${busy} up=${uptimeMin.toFixed(1)}m`,
      );
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // 1. Env
  if (!state.token) {
    error("SIMBOX_TOKEN is required (repo secret). Set it in the workflow's `with: token:`.");
    exit(1);
  }
  if (!Bun.env.GITHUB_RUN_ID || Number.isNaN(Number(Bun.env.GITHUB_RUN_ID))) {
    error("GITHUB_RUN_ID missing or invalid — this agent must run inside GitHub Actions.");
    exit(1);
  }
  state.ghRunId = Number(Bun.env.GITHUB_RUN_ID);
  addMask(state.token); // belt-and-braces; GH already masks repo secrets
  // The repo secret stays in this process: npm, agent-device, cloudflared,
  // the emulator and the preview hub never inherit it.
  delete Bun.env.SIMBOX_TOKEN;
  if (state.runId && !RUN_ID_RE.test(state.runId)) {
    warn("ignoring malformed SIMBOX_RUN_ID");
    state.runId = "";
  }

  // Register signal handlers early so a SIGTERM during provisioning still
  // cleans up children instead of orphaning them.
  process.on("SIGTERM", () => void shutdown("SIGTERM", 0));
  process.on("SIGINT", () => void shutdown("SIGINT", 0));

  info(
    `simbox-agent v${pkg.version} — run ${state.ghRunId} (attempt ${state.ghRunAttempt})` +
      `${state.runId ? `, simbox run ${state.runId}` : ""}${stage.staged ? ", staged" : ""}, api ${state.apiUrl}`,
  );

  // 2. What to prepare. The API's platform wins; a host that cannot run it
  // fails here rather than serving the wrong thing.
  const config = await requestRunConfig();
  state.platform = config?.platform ?? hostPlatform(process.platform, Bun.env.SIMBOX_PLATFORM);
  state.device = config?.device ?? null;
  if (!state.runId && config?.runId && RUN_ID_RE.test(config.runId)) state.runId = config.runId;
  state.maxDevices =
    state.platform === "android"
      ? 1
      : (config?.maxDevices ?? deviceCapForCpus(availableParallelism()));
  const mismatch = hostMismatch(state.platform, process.platform);
  if (mismatch) {
    error(mismatch);
    await shutdown(mismatch, 1);
  }
  info(
    `platform ${state.platform}; device ${state.device ? JSON.stringify(state.device) : "runner default"}; ` +
      `up to ${state.maxDevices} device${state.maxDevices === 1 ? "" : "s"} at a time (${availableParallelism()} vCPUs)`,
  );

  // 3. Choose the device before installing anything. agent-device resolves
  // its toolchain once, so iOS's Xcode switch has to land before its daemon
  // starts. A requested device the runner cannot provide fails the run
  // rather than silently serving another one.
  if (state.platform === "ios") {
    await quietHost();
    adapter = createIOSAdapter({ agentDeviceBin: () => state.agentDeviceBin });
  } else {
    await configureAndroidEnvironment();
    adapter = android = createAndroidAdapter({
      onEmulator: (proc) => {
        state.children.emulator = track("Android emulator", proc, state.emulatorRestarts);
      },
    });
  }
  let choice: DeviceChoice | null = null;
  try {
    choice = await adapter.select(state.device);
  } catch (err) {
    if (state.device || state.platform === "android") {
      error(message(err).slice(0, 500));
      await shutdown(message(err).slice(0, 200), 1);
    }
    warn(`could not choose the default simulator (${message(err)}); warming any available iPhone`);
  }

  // 4. Provision: agent-device + cloudflared in parallel.
  const [agentDeviceBin, cloudflaredBin] = await Promise.all([
    installAgentDevice(),
    installCloudflared(),
  ]);
  state.agentDeviceBin = agentDeviceBin;
  state.cloudflaredBin = cloudflaredBin;

  // 5. daemon token — mask before any use.
  state.daemonToken = randomBytes(32).toString("hex");
  addMask(state.daemonToken);
  // Filter by hostname *pattern* (not just the known value) so the very stderr
  // line the URL is parsed from is never relayed to the log.
  // A named tunnel's cloudflared logs its ingress hostname; never relay it.
  setSecretFilter(
    (line) =>
      line.includes(state.daemonToken) ||
      QUICK_TUNNEL_HOST_RE.test(line) ||
      (!!state.named &&
        (line.includes(new URL(state.named.tunnelUrl).hostname) ||
          line.includes(state.named.connectorToken))),
  );

  // 6. agent-device proxy
  state.children.proxy = spawnProxy();
  state.gateway = startGateway({
    port: PROXY_PORT,
    upstreamPort: UPSTREAM_PORT,
    token: state.daemonToken,
    previewPort: previewHub.port,
    restartPreviewHub: previewHub.restart,
    beforeBoot: refuseBoot,
  });
  await state.gateway.ready;
  await waitForProxy(`http://127.0.0.1:${PROXY_PORT}/agent-device/health`);
  info(`agent-device gateway on 127.0.0.1:${PROXY_PORT} (pid ${state.children.proxy.proc.pid})`);

  // 7. Boot the device. iOS boots its simulator and builds XCTest before the
  // tunnel starts, so the first commands neither race that work for 3 vCPUs
  // nor land in the simulator's first-boot storm. A legacy (single-step)
  // Android run goes live while its emulator boots; staged runs wait.
  const booting = bootDevices(choice);
  if (state.platform === "ios" || stage.staged) await booting;

  // 8. Staged: hand over to the workflow's steps until the serve step starts.
  if (stage.staged) {
    stage.markReady();
    info("devices ready; waiting for the serve step");
    await stage.waitForGo({ check: checkHardExit });
    info("serve step started");
  }

  // 9. cloudflared — a named tunnel when the API provisions one, else a quick
  // tunnel. Either way, wait for the URL.
  state.named = await requestNamedTunnel();
  let tunnel = spawnTunnel();
  state.children.tunnel = tunnel.child;
  try {
    state.tunnelUrl = await tunnel.url;
  } catch (err) {
    if (state.named) {
      warn(`named tunnel did not connect (${String(err).slice(0, 200)}); using a quick tunnel`);
      await stopChild(tunnel.child);
      state.named = null;
      tunnel = spawnTunnel();
      state.children.tunnel = tunnel.child;
      try {
        state.tunnelUrl = await tunnel.url;
      } catch (quickErr) {
        error(`tunnel never came up: ${String(quickErr).slice(0, 300)}`);
        await shutdown("no tunnel URL", 1);
      }
    } else {
      error(`tunnel never came up: ${String(err).slice(0, 300)}`);
      await shutdown("no tunnel URL", 1);
    }
  }
  maskTunnel(state.tunnelUrl);
  // Never hand out a named hostname before its DNS record is served: an early
  // lookup caches NXDOMAIN on the client's resolver for half an hour.
  if (state.named) {
    const dns = await waitForAuthoritativeDns(new URL(state.tunnelUrl).hostname);
    if (dns === "missing")
      warn("named tunnel DNS not visible on its nameservers yet; registering anyway");
    else if (dns === "unverified")
      info("named tunnel DNS not verified (no dig or nameservers); registering anyway");
  }
  // The local origin is ready; public DNS/edge readiness is checked by the
  // client. Hairpin probes from GH runners can fail while clients can reach it.
  info("tunnel up (url registered + masked)");

  // 10. Register, then report readiness right away rather than a minute later.
  await register().catch(async (err) => {
    await shutdown(`registration failed: ${String(err).slice(0, 200)}`, 1);
    throw err; // unreachable, keeps types happy
  });
  await heartbeat();

  // 11. Supervision
  await supervise();
}

// A long-lived service must not exit cleanly while startup awaits an unref'ed
// network/file operation (notably streamed downloads in compiled Linux Bun).
setInterval(() => {}, 10_000);
main().catch(async (err) => {
  error(`fatal: ${String(err).slice(0, 500)}`);
  await shutdown(`fatal boot error: ${message(err).slice(0, 150)}`, 1);
});
