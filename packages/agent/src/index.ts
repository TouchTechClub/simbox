/**
 * simbox-agent — runs a standalone Simlock daemon for the run's platform
 * (iOS on macOS, Android on Linux/KVM), warms one device, opens the run's
 * named Cloudflare tunnel to it, registers with the simbox API, then
 * supervises until idle/hard-exit/stop/token revocation.
 *
 * Clients talk to Simlock directly through the tunnel with the run's agent
 * token: agent-device at `/v1/agent-device`, leases, stream and input.
 *
 * Staged mode (SIMBOX_STAGE_DIR, see stage.ts) pauses between "device warm"
 * and "tunnel + register" so workflow steps can run in between.
 *
 * Exit codes: 0 = clean shutdown (green check), 1 = failure (red X).
 */
import {
  HARD_EXIT_MINUTES,
  HEARTBEAT_INTERVAL_SECONDS,
  IDLE_EXIT_MINUTES,
  MAX_DEVICES_PER_RUN,
  PROD_API_URL,
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
import { childEnv, pumpLines, setSecretFilter } from "./proc.js";
import type { ChildProc } from "./proc.js";
import { installCloudflared } from "./provision.js";
import { ApiClient, HttpError, runIsOver } from "./api.js";
import { waitForAuthoritativeDns } from "./dns.js";
import { createIOSAdapter, quietHost, raisePriority } from "./ios.js";
import { configureAndroidEnvironment, createAndroidAdapter } from "./android.js";
import {
  bootedFromChoice,
  hostMismatch,
  hostPlatform,
  printableCatalog,
  type DeviceChoice,
  type PlatformAdapter,
} from "./platform.js";
import {
  createSimlock,
  installSimlock,
  selfTest,
  simlockLoad,
  warmReady,
  type Simlock,
  type WarmTarget,
} from "./simlock.js";
import { createStage, jobStartedAt } from "./stage.js";

const TUNNEL_CONNECT_TIMEOUT_MS = 60_000;
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const REGISTER_ATTEMPTS = 3;
const HEARTBEAT_FAILURE_LIMIT = 3;
const TUNNEL_PROBE_TIMEOUT_MS = 15_000;
const TUNNEL_RECONNECT_WINDOW_MS = 60_000;
const TUNNEL_REPROBE_INTERVAL_MS = 10_000;
const TUNNEL_RESTART_LIMIT = 3;
/** Consecutive unanswered `simlock status` calls before the daemon is restarted. */
const DAEMON_PROBE_FAILURE_LIMIT = 3;
const DAEMON_RESTART_LIMIT = 2;
/** A cold boot on a 3-vCPU hosted Mac can take several attempts. */
const WARM_TIMEOUT_MS = { ios: 15 * 60_000, android: 12 * 60_000 } as const;
const SELF_TEST_ATTEMPTS = 2;
/** A child that ran this long before dying earns back its full restart budget. */
const HEALTHY_RESET_MS = 30 * 60_000;
/** Cleanup never outlives this; a stuck step must not keep the job running. */
const SHUTDOWN_DEADLINE_MS = 30_000;

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
  /** Simlock agent token handed to the run's owner. */
  daemonToken: "",
  tunnelUrl: "",
  named: null as RunTunnelResponse | null,
  /** Device requested for this run beyond the platform defaults. */
  device: null as DeviceProfile | null,
  /** What Simlock keeps warm, once it is. */
  booted: null as BootedDevice | null,
  /** The runner's configured device count; null lets the API estimate it. */
  maxDevices: null as number | null,
  cloudflaredBin: "",
  simlock: null as Simlock | null,
  /** A warm device is ready to lease. */
  devicesReady: false,
  activeDevices: 0,
  daemonRestarts: 0,
  daemonRestartedAt: 0,
  registered: false,
  shuttingDown: false,
  /** Hard-exit clock: the job's start when the prepare step recorded it. */
  bootedAt: jobStartedAt(Bun.env.SIMBOX_JOB_STARTED_AT, Date.now()),
  tunnel: null as ManagedChild | null,
  wake: null as (() => void) | null,
};
let adapter: PlatformAdapter | null = null;

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
// cloudflared
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

/** Stop a child and wait until it is gone. */
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

/**
 * The run's named tunnel: several edge connections and one URL. Its token
 * stays in the environment (never argv). http2 keeps it on TCP: QUIC died
 * under CPU starvation on hosted Macs. Up once the first edge connection
 * registers.
 */
function spawnTunnel(
  named: RunTunnelResponse,
  restarts = 0,
): { child: ManagedChild; up: Promise<void> } {
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
  // Keep the tunnel served while devices saturate the CPU.
  if (process.platform === "darwin") void raisePriority(proc.pid, "cloudflared");
  let settled = false;
  const up = new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`no edge connection within ${TUNNEL_CONNECT_TIMEOUT_MS / 1000}s`));
      }
    }, TUNNEL_CONNECT_TIMEOUT_MS);
    pumpLines(proc.stderr, "cloudflared", (line) => {
      if (!settled && line.includes("Registered tunnel connection")) {
        settled = true;
        clearTimeout(deadline);
        resolve();
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
  return { child, up };
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
  if (err instanceof HttpError) return err.status >= 500; // 4xx = fatal
  return true; // network errors retriable
}

/** What to prepare; null (host defaults) when the API is older or unreachable. */
async function requestRunConfig(): Promise<RunConfigResponse | null> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await api().config(ids());
    } catch (err) {
      if (err instanceof HttpError && err.status < 500) {
        info(`run config unavailable (HTTP ${err.status}); preparing the default device`);
        return null;
      }
      warn(`run config request failed: ${String(err).slice(0, 200)}`);
      if (attempt < 3) await Bun.sleep(2000);
    }
  }
  warn("could not read the run config; preparing the default device");
  return null;
}

/** The run's named tunnel. Clients can only reach Simlock through it. */
async function requestTunnel(): Promise<RunTunnelResponse> {
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const named = await api().tunnel(ids());
      addMask(named.connectorToken);
      maskTunnel(named.tunnelUrl);
      info("named tunnel provisioned");
      return named;
    } catch (err) {
      lastErr = err;
      if (runIsOver(err)) await shutdown("run is over (stopped before it went live)", 0);
      if (!isRetriable(err)) break;
      warn(`tunnel request failed: ${String(err).slice(0, 200)}`);
      if (attempt < 3) await Bun.sleep(2000 * attempt);
    }
  }
  throw new Error(`the API did not provision this run's tunnel: ${message(lastErr)}`);
}

/** Throws on failure, except a run that is already over, which exits cleanly. */
async function register(): Promise<void> {
  const body: RunRegisterRequest = {
    ...ids(),
    tunnelUrl: state.tunnelUrl,
    daemonToken: state.daemonToken,
    versions: {
      agent: pkg.version,
      simlock: PINS.simlock,
      agentDevice: PINS.agentDevice,
      cloudflared: PINS.cloudflared,
    },
    ...(state.maxDevices ? { maxDevices: state.maxDevices } : {}),
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

/** Tell the API what this runner offers and what it keeps warm. Never fatal. */
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

/**
 * Deregister, stop cloudflared and Simlock, and exit. Only the first call
 * does anything; a second signal (or a failure noticed meanwhile) waits for
 * that cleanup.
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
  if (state.tunnel) await stopChild(state.tunnel);
  if (code !== 0) await state.simlock?.logs().catch(() => {});
  await state.simlock?.stop().catch(() => {});
  info(`goodbye (exit ${code})`);
  exit(code);
}

// ---------------------------------------------------------------------------
// Supervision loop
// ---------------------------------------------------------------------------

async function restartTunnel(): Promise<string | null> {
  const old = state.tunnel!;
  const used = restartsUsed(old);
  if (used >= TUNNEL_RESTART_LIMIT)
    return `cloudflared kept dying (${TUNNEL_RESTART_LIMIT} restarts used)`;
  await stopChild(old);
  warn(`restarting cloudflared (${used + 1}/${TUNNEL_RESTART_LIMIT})`);
  const next = spawnTunnel(state.named!, used + 1);
  state.tunnel = next.child;
  try {
    // A named tunnel keeps its URL: nothing to re-register.
    await next.up;
    info("tunnel reconnected");
  } catch (err) {
    error(`tunnel restart failed: ${String(err).slice(0, 300)}`);
    return `tunnel restart failed: ${message(err).slice(0, 150)}`;
  }
  return null;
}

/**
 * Edge-side tunnel liveness. A zombie cloudflared (process alive, edge
 * connections dead) looks fine to process supervision while the edge serves
 * 530. Only 530 and network errors count as dead: any other status means the
 * edge reached Simlock.
 */
async function tunnelEdgeDead(): Promise<boolean> {
  if (!state.tunnelUrl) return false;
  try {
    const res = await fetch(`${state.tunnelUrl}/v1/healthz`, {
      headers: { "user-agent": `simbox-agent/${pkg.version}` },
      signal: AbortSignal.timeout(TUNNEL_PROBE_TIMEOUT_MS),
    });
    await res.body?.cancel();
    if (res.status === 530) warn("tunnel probe: HTTP 530");
    return res.status === 530;
  } catch (err) {
    warn(`tunnel probe: ${err instanceof Error ? err.name : "network error"}`);
    return true; // DNS/connect/timeout — edge can't reach us
  }
}

/** Re-probe through cloudflared's reconnect window; true if never reachable. */
async function tunnelStaysDead(): Promise<boolean> {
  const deadline = Date.now() + TUNNEL_RECONNECT_WINDOW_MS;
  while (Date.now() < deadline) {
    await interruptibleSleep(TUNNEL_REPROBE_INTERVAL_MS);
    if (state.shuttingDown || state.tunnel?.dead) return false;
    if (!(await tunnelEdgeDead())) return false;
  }
  return true;
}

/** Restart an unresponsive Simlock daemon; leases and devices survive a restart. */
async function restartDaemon(): Promise<string | null> {
  const used = Date.now() - state.daemonRestartedAt >= HEALTHY_RESET_MS ? 0 : state.daemonRestarts;
  if (used >= DAEMON_RESTART_LIMIT)
    return `Simlock daemon stopped answering (${DAEMON_RESTART_LIMIT} restarts used)`;
  state.daemonRestarts = used + 1;
  state.daemonRestartedAt = Date.now();
  warn(`Simlock daemon is not answering; restarting it (${used + 1}/${DAEMON_RESTART_LIMIT})`);
  await state.simlock!.logs();
  await state.simlock!.stop().catch(() => {});
  try {
    await state.simlock!.start();
  } catch (err) {
    return `Simlock daemon restart failed: ${message(err).slice(0, 150)}`;
  }
  return null;
}

async function checkHardExit(): Promise<void> {
  if (Date.now() - state.bootedAt >= HARD_EXIT_MINUTES * 60_000)
    await shutdown(`hard exit after ${HARD_EXIT_MINUTES} minutes`, 0);
}

async function supervise(): Promise<never> {
  let daemonProbeFailures = 0;
  let lastWorkAt = Date.now(); // idle clock starts once the run is live
  for (;;) {
    await interruptibleSleep(HEARTBEAT_INTERVAL_SECONDS * 1000);

    // --- cloudflared ---
    if (state.tunnel?.dead) {
      const failure = await restartTunnel();
      if (failure) await shutdown(failure, 1);
    } else if (await tunnelEdgeDead()) {
      warn("tunnel unreachable at edge; waiting for cloudflared to reconnect");
      if (await tunnelStaysDead()) {
        warn("killing zombie cloudflared to force reconnect");
        const failure = await restartTunnel();
        if (failure) await shutdown(failure, 1);
      } else info("tunnel reconnected");
    }

    // --- Simlock: leases, queue and warm devices ---
    const status = await state.simlock!.status();
    if (!status) {
      daemonProbeFailures += 1;
      warn(`simlock status failed (${daemonProbeFailures}/${DAEMON_PROBE_FAILURE_LIMIT})`);
      // Unknown load is not evidence of idleness.
      lastWorkAt = Date.now();
      if (daemonProbeFailures >= DAEMON_PROBE_FAILURE_LIMIT) {
        daemonProbeFailures = 0;
        const failure = await restartDaemon();
        if (failure) await shutdown(failure, 1);
      }
    } else {
      daemonProbeFailures = 0;
      const load = simlockLoad(status);
      state.activeDevices = load.leases;
      state.devicesReady = warmReady(status) > 0 || load.leases > 0;
      if (load.leases > 0 || load.queued > 0) lastWorkAt = Date.now();
    }

    // --- exits (checked before heartbeat so a dead run doesn't beat one more time) ---
    const uptimeMin = (Date.now() - state.bootedAt) / 60_000;
    await checkHardExit();
    const idleMin = (Date.now() - lastWorkAt) / 60_000;
    if (idleMin >= IDLE_EXIT_MINUTES)
      await shutdown(`idle exit — no leases for ${IDLE_EXIT_MINUTES} minutes`, 0);

    // --- heartbeat ---
    if (await heartbeat())
      info(
        `heartbeat ok — leases=${state.activeDevices} ready=${state.devicesReady} ` +
          `idle=${idleMin.toFixed(1)}m up=${uptimeMin.toFixed(1)}m`,
      );
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

/** Warm the device and prove it answers agent-device, retrying once. */
async function warmUp(simlock: Simlock, agentDevice: string): Promise<void> {
  const timeoutMs = WARM_TIMEOUT_MS[state.platform];
  const stopping = () => state.shuttingDown;
  await simlock.waitForWarm({ timeoutMs, isStopping: stopping });
  for (let attempt = 1; ; attempt++) {
    try {
      await selfTest(agentDevice, state.platform);
      info("warm-up self-test passed");
      break;
    } catch (err) {
      if (attempt >= SELF_TEST_ATTEMPTS) throw err;
      warn(`${message(err)}; retrying`);
    }
  }
  // Releasing the self-test's lease wipes that device; wait until one is warm again.
  await simlock.waitForWarm({ timeoutMs, isStopping: stopping });
}

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
  // The repo secret stays in this process: npm, Simlock, agent-device and
  // cloudflared never inherit it.
  delete Bun.env.SIMBOX_TOKEN;
  if (state.runId && !RUN_ID_RE.test(state.runId)) {
    warn("ignoring malformed SIMBOX_RUN_ID");
    state.runId = "";
  }

  // Register signal handlers early so a SIGTERM during provisioning still
  // stops Simlock instead of orphaning it.
  process.on("SIGTERM", () => void shutdown("SIGTERM", 0));
  process.on("SIGINT", () => void shutdown("SIGINT", 0));

  info(
    `simbox-agent v${pkg.version} (simlock ${PINS.simlock}) — run ${state.ghRunId} (attempt ${state.ghRunAttempt})` +
      `${state.runId ? `, simbox run ${state.runId}` : ""}${stage.staged ? ", staged" : ""}, api ${state.apiUrl}`,
  );

  // 2. What to prepare. The API's platform wins; a host that cannot run it
  // fails here rather than serving the wrong thing.
  const config = await requestRunConfig();
  state.platform = config?.platform ?? hostPlatform(process.platform, Bun.env.SIMBOX_PLATFORM);
  state.device = config?.device ?? null;
  if (config?.maxDevices)
    state.maxDevices = Math.min(Math.max(1, config.maxDevices), MAX_DEVICES_PER_RUN);
  if (!state.runId && config?.runId && RUN_ID_RE.test(config.runId)) state.runId = config.runId;
  const mismatch = hostMismatch(state.platform, process.platform);
  if (mismatch) {
    error(mismatch);
    await shutdown(mismatch, 1);
  }
  info(
    `platform ${state.platform}; device ${state.device ? JSON.stringify(state.device) : "runner default"}`,
  );

  // 3. Choose the device and prepare the host before Simlock starts: it
  // resolves its toolchain once, so iOS's Xcode switch has to land first. A
  // requested device the runner cannot provide fails the run rather than
  // silently serving another one.
  if (state.platform === "ios") {
    await quietHost();
    adapter = createIOSAdapter();
  } else {
    await configureAndroidEnvironment();
    adapter = createAndroidAdapter();
  }
  let choice: DeviceChoice;
  try {
    choice = await adapter.select(state.device);
  } catch (err) {
    error(message(err).slice(0, 500));
    return shutdown(message(err).slice(0, 200), 1);
  }

  // 4. Provision: SDK packages, Simlock + agent-device, cloudflared.
  const [, bins, cloudflaredBin] = await Promise.all([
    adapter.prepare(choice),
    installSimlock(),
    installCloudflared(),
  ]);
  state.cloudflaredBin = cloudflaredBin;

  // 5. Simlock: one warm target for the chosen device.
  const simlock = (state.simlock = createSimlock(bins));
  const target: WarmTarget = {
    platform: state.platform,
    model: adapter.simlockModel(choice),
    // An OS is only pinned when the run asked for one.
    ...(state.device?.os ? { osVersion: choice.os.version } : {}),
    count: 1,
  };
  // Simlock's own capacity bounds the devices; this only stops one token
  // (all of the owner's clients) from being refused a second lease.
  await simlock.configure({
    target,
    maxDevices: state.maxDevices ?? MAX_DEVICES_PER_RUN,
    osVersion: choice.os.version,
  });
  await simlock.start();
  info("Simlock daemon started on 127.0.0.1:4701");

  // 6. Warm the device (and on iOS build XCTest) before anyone can reach it:
  // a client's first call then never waits on a cold boot.
  try {
    await warmUp(simlock, bins.agentDevice);
  } catch (err) {
    const reason = `${state.platform === "ios" ? "iOS simulator" : "Android emulator"} did not warm up: ${message(err)}`;
    error(reason.slice(0, 500));
    return shutdown(reason.slice(0, 200), 1);
  }
  state.devicesReady = true;
  state.booted = bootedFromChoice(choice);
  void reportInventory(choice);

  // 7. The agent token the run's owner gets: mask it before anything else sees it.
  state.daemonToken = await simlock.createAgentToken(
    `simbox-run-${state.runId || state.ghRunId}`.slice(0, 60),
  );
  addMask(state.daemonToken);
  setSecretFilter(
    (line) =>
      line.includes(state.daemonToken) ||
      (!!state.named &&
        (line.includes(new URL(state.named.tunnelUrl).hostname) ||
          line.includes(state.named.connectorToken))),
  );

  // 8. Staged: hand over to the workflow's steps until the serve step starts.
  if (stage.staged) {
    stage.markReady();
    info("device warm; waiting for the serve step");
    await stage.waitForGo({ check: checkHardExit });
    info("serve step started");
  }

  // 9. The run's named tunnel to Simlock.
  state.named = await requestTunnel().catch((err) => {
    error(message(err).slice(0, 500));
    return shutdown(message(err).slice(0, 200), 1);
  });
  state.tunnelUrl = state.named.tunnelUrl;
  const tunnel = spawnTunnel(state.named);
  state.tunnel = tunnel.child;
  try {
    await tunnel.up;
  } catch (err) {
    error(`tunnel never came up: ${String(err).slice(0, 300)}`);
    await shutdown("tunnel never came up", 1);
  }
  // Never hand out a hostname before its DNS record is served: an early
  // lookup caches NXDOMAIN on the client's resolver for half an hour.
  const dns = await waitForAuthoritativeDns(new URL(state.tunnelUrl).hostname);
  if (dns === "missing") warn("tunnel DNS not visible on its nameservers yet; registering anyway");
  else if (dns === "unverified")
    info("tunnel DNS not verified (no dig or nameservers); registering anyway");
  info("tunnel up");

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
