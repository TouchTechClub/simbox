/**
 * simbox-agent — boots agent-device proxy + cloudflared quick tunnel on a
 * GitHub Actions macOS runner, registers with the simbox API, then
 * supervises until idle/hard-exit/token-revocation.
 *
 * Exit codes: 0 = clean shutdown (green check), 1 = failure (red X).
 */
import { randomBytes } from "node:crypto";
import {
  HARD_EXIT_MINUTES,
  HEARTBEAT_INTERVAL_SECONDS,
  IDLE_EXIT_MINUTES,
  PROD_API_URL,
  PROXY_PORT,
} from "@simbox/shared";
import type { RunRegisterRequest } from "@simbox/shared";
import { PINS } from "./pins.js";
import pkg from "../package.json" with { type: "json" };
import { addMask, error, info, warn } from "./log.js";
import { pumpLines, setSecretFilter } from "./proc.js";
import type { ChildProc } from "./proc.js";
import { installAgentDevice, installCloudflared, prepareAndroid } from "./provision.js";
import { ApiClient, HttpError } from "./api.js";
import { countActiveDevices } from "./devices.js";
import { run } from "./proc.js";
import { startGateway } from "./gateway.js";
import { healthyProxy, waitForProxy } from "./health.js";
import { prepareIOS } from "./ios.js";
import { preparePlatforms } from "./platforms.js";

const TUNNEL_URL_TIMEOUT_MS = 60_000;
const TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const REGISTER_ATTEMPTS = 3;
const HEARTBEAT_FAILURE_LIMIT = 3;
const TUNNEL_PROBE_TIMEOUT_MS = 15_000;
const TUNNEL_PROBE_FAILURE_LIMIT = 2;
const PROXY_PROBE_TIMEOUT_MS = 10_000;
const PROXY_PROBE_FAILURE_LIMIT = 2;
const PROXY_RESTART_LIMIT = 5; // daemon can die repeatedly on GH macOS runners
const UPSTREAM_PORT = PROXY_PORT + 1;

// ---------------------------------------------------------------------------
// Shared run state (module-level so provision/supervise/shutdown all see it)
// ---------------------------------------------------------------------------

interface ManagedChild {
  name: string;
  proc: ChildProc;
  restarts: number;
  dead: boolean;
}

const state = {
  apiUrl: Bun.env.SIMBOX_API_URL ?? PROD_API_URL,
  token: Bun.env.SIMBOX_TOKEN ?? "",
  ghRunId: 0,
  ghRunAttempt: Bun.env.GITHUB_RUN_ATTEMPT ?? "?",
  daemonToken: "",
  tunnelUrl: "",
  agentDeviceBin: "",
  cloudflaredBin: "",
  androidReady: false,
  registered: false,
  shuttingDown: false,
  bootedAt: Date.now(),
  children: {} as { proxy?: ManagedChild; tunnel?: ManagedChild; emulator?: ManagedChild },
  gateway: null as ReturnType<typeof startGateway> | null,
  wake: null as (() => void) | null,
};

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

function track(name: string, proc: ChildProc): ManagedChild {
  const child: ManagedChild = { name, proc, restarts: 0, dead: false };
  proc.exited
    .then((code) => {
      child.dead = true;
      if (!state.shuttingDown) {
        warn(`${name} exited unexpectedly (code ${code})`);
        notifyWake();
      }
    })
    .catch(() => {
      child.dead = true;
    });
  return child;
}

function spawnProxy(): ManagedChild {
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
      env: { ...Bun.env, AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: "0" },
    },
  );
  const child = track("agent-device proxy", proc);
  pumpLines(proc.stdout, "agent-device");
  pumpLines(proc.stderr, "agent-device");
  return child;
}

interface TunnelSpawn {
  child: ManagedChild;
  url: Promise<string>;
}

function spawnTunnel(): TunnelSpawn {
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
    { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  );
  const child = track("cloudflared", proc);

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

async function register(): Promise<void> {
  const body: RunRegisterRequest = {
    ghRunId: state.ghRunId,
    tunnelUrl: state.tunnelUrl,
    daemonToken: state.daemonToken,
    versions: {
      agent: pkg.version,
      agentDevice: PINS.agentDevice,
      cloudflared: PINS.cloudflared,
    },
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

async function shutdown(reason: string, code: number): Promise<never> {
  if (state.shuttingDown) process.exit(code);
  state.shuttingDown = true;
  info(`shutting down: ${reason}`);
  if (state.ghRunId > 0 && state.token) {
    try {
      await api().deregister({ ghRunId: state.ghRunId, reason });
    } catch (err) {
      warn(`deregister failed (continuing shutdown): ${String(err).slice(0, 200)}`);
    }
  }
  await killChildren();
  await state.gateway?.server.stop(true);
  info(`goodbye (exit ${code})`);
  process.exit(code);
}

// ---------------------------------------------------------------------------
// Supervision loop
// ---------------------------------------------------------------------------

/** Restart dead children within their budgets. Returns false if exhausted. */
async function handleDeadChildren(): Promise<boolean> {
  if (state.children.proxy?.dead) {
    const c = state.children.proxy;
    if (c.restarts >= PROXY_RESTART_LIMIT) {
      error(`agent-device proxy died ${PROXY_RESTART_LIMIT + 1} times — exiting`);
      return false;
    }
    warn(`restarting agent-device proxy (${c.restarts + 1}/${PROXY_RESTART_LIMIT})`);
    state.children.proxy = spawnProxy();
    state.children.proxy.restarts = c.restarts + 1;
    await waitForProxy(`http://127.0.0.1:${PROXY_PORT}/agent-device/health`);
  }
  if (state.children.tunnel?.dead) {
    const c = state.children.tunnel;
    if (c.restarts >= 3) {
      error("cloudflared exhausted its restart budget — exiting");
      return false;
    }
    warn("restarting cloudflared (new tunnel URL)");
    const t = spawnTunnel();
    state.children.tunnel = t.child;
    t.child.restarts = c.restarts + 1;
    try {
      const newUrl = await t.url;
      addMask(newUrl);
      state.tunnelUrl = newUrl;
      // A runner's DNS/egress is not an authoritative test of a tunnel client
      // can reach. The CLI validates public readiness before returning it.
      // URL changed → re-register so the API hands out the fresh tunnel.
      await register();
      info("tunnel re-registered with new URL");
    } catch (err) {
      error(`tunnel restart failed: ${String(err).slice(0, 300)}`);
      return false;
    }
  }
  return true;
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

/**
 * Local proxy liveness. The proxy's embedded daemon can die while the proxy
 * process stays up — /health then returns {"ok":false,"error":"fetch failed"}
 * forever (observed on GH macOS runners ~60-90s after a client connects).
 * Proxy restart re-spawns its child daemon.
 */
/**
 * agent-device swallows daemon crashes into ndjson diagnostics under
 * ~/.agent-device/logs — print the tail of the freshest ones into our step
 * log so daemon deaths are diagnosable from the Actions UI.
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
        info(`[agent-device log ${file}] ${line}`);
      }
    }
  }
}

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

async function supervise(): Promise<never> {
  let heartbeatFailures = 0;
  let tunnelProbeFailures = 0;
  let proxyProbeFailures = 0;
  let lastDeviceSeenAt = Date.now(); // idle clock starts at boot
  for (;;) {
    await interruptibleSleep(HEARTBEAT_INTERVAL_SECONDS * 1000);
    // A cold boot/runner build is real work, not an idle or wedged daemon.
    const activity = state.gateway?.activity();
    let busy = (activity?.inFlight ?? 0) > 0;
    if (activity) lastDeviceSeenAt = Math.max(lastDeviceSeenAt, activity.lastActivityAt);

    // --- children ---
    const childrenOk = await handleDeadChildren();
    if (!childrenOk) await shutdown("child process died twice", 1);

    // --- tunnel liveness (edge-side; process can be a zombie) ---
    if (!busy && !state.children.tunnel?.dead && (await tunnelEdgeDead())) {
      tunnelProbeFailures += 1;
      warn(`tunnel unreachable at edge (${tunnelProbeFailures}/${TUNNEL_PROBE_FAILURE_LIMIT})`);
      if (tunnelProbeFailures >= TUNNEL_PROBE_FAILURE_LIMIT) {
        warn("killing zombie cloudflared to force reconnect");
        tunnelProbeFailures = 0;
        const t = state.children.tunnel!;
        t.dead = true; // guarantee handleDeadChildren sees it even if exit is slow
        t.proc.kill("SIGTERM");
        if (!(await handleDeadChildren())) await shutdown("tunnel restart failed", 1);
      }
    } else {
      tunnelProbeFailures = 0;
    }

    // --- proxy liveness (upstream daemon can die inside a live proxy) ---
    if (!busy && !state.children.proxy?.dead && (await proxyUpstreamDead())) {
      proxyProbeFailures += 1;
      warn(`proxy upstream dead (${proxyProbeFailures}/${PROXY_PROBE_FAILURE_LIMIT})`);
      if (proxyProbeFailures >= PROXY_PROBE_FAILURE_LIMIT) {
        warn("killing wedged agent-device proxy to force restart");
        proxyProbeFailures = 0;
        await dumpRecentDaemonLogs();
        const p = state.children.proxy!;
        p.dead = true;
        p.proc.kill("SIGTERM");
        if (!(await handleDeadChildren())) await shutdown("proxy restart failed", 1);
      }
    } else {
      proxyProbeFailures = 0;
    }

    // --- device count ---
    const deviceCount = await countActiveDevices(UPSTREAM_PORT, state.daemonToken);
    // Unknown inventory is not evidence that a session is idle. Hard exit
    // remains authoritative even if inventory is unavailable.
    if (deviceCount === null || deviceCount > 0) lastDeviceSeenAt = Date.now();
    const activeDevices = deviceCount ?? 0;
    // A request can start while probes/device inventory are awaited.
    const latestActivity = state.gateway?.activity();
    busy = (latestActivity?.inFlight ?? 0) > 0;
    if (latestActivity)
      lastDeviceSeenAt = Math.max(lastDeviceSeenAt, latestActivity.lastActivityAt);

    // --- exits (checked before heartbeat so a dead run doesn't beat one more time) ---
    const uptimeMin = (Date.now() - state.bootedAt) / 60_000;
    if (uptimeMin >= HARD_EXIT_MINUTES) {
      await shutdown(`hard exit after ${HARD_EXIT_MINUTES} minutes`, 0);
    }
    const idleMin = (Date.now() - lastDeviceSeenAt) / 60_000;
    if (!busy && idleMin >= IDLE_EXIT_MINUTES) {
      await shutdown(`idle exit — no active devices for ${IDLE_EXIT_MINUTES} minutes`, 0);
    }

    // --- heartbeat ---
    try {
      await api().heartbeat({
        ghRunId: state.ghRunId,
        activeDevices,
        androidReady: state.androidReady,
      });
      heartbeatFailures = 0;
      info(
        `heartbeat ok — devices=${activeDevices} android=${state.androidReady} ` +
          `idle=${idleMin.toFixed(1)}m busy=${busy} up=${uptimeMin.toFixed(1)}m`,
      );
    } catch (err) {
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
    }
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // 1. Env
  if (!state.token) {
    error("SIMBOX_TOKEN is required (repo secret). Set it in the workflow's `with: token:`.");
    process.exit(1);
  }
  if (!Bun.env.GITHUB_RUN_ID || Number.isNaN(Number(Bun.env.GITHUB_RUN_ID))) {
    error("GITHUB_RUN_ID missing or invalid — this agent must run inside GitHub Actions.");
    process.exit(1);
  }
  state.ghRunId = Number(Bun.env.GITHUB_RUN_ID);
  addMask(state.token); // belt-and-braces; GH already masks repo secrets

  // Register signal handlers early so a SIGTERM during provisioning still
  // cleans up children instead of orphaning them.
  process.on("SIGTERM", () => void shutdown("SIGTERM", 0));
  process.on("SIGINT", () => void shutdown("SIGINT", 0));

  info(
    `simbox-agent v${pkg.version} — run ${state.ghRunId} (attempt ${state.ghRunAttempt}), api ${state.apiUrl}`,
  );

  // 2. Provision: agent-device + cloudflared in parallel; Android prep runs
  // fully in the background and must never block iOS bring-up (it handles all
  // its own errors internally).
  const [agentDeviceBin, cloudflaredBin] = await Promise.all([
    installAgentDevice(),
    installCloudflared(),
  ]);
  state.agentDeviceBin = agentDeviceBin;
  state.cloudflaredBin = cloudflaredBin;

  // 3. daemon token — mask before any use.
  state.daemonToken = randomBytes(32).toString("hex");
  addMask(state.daemonToken);
  // Filter by URL *pattern* (not just the known value) so the very stderr line
  // the URL is parsed from is never relayed to the log.
  setSecretFilter((line) => line.includes(state.daemonToken) || TUNNEL_URL_RE.test(line));

  // 4. agent-device proxy
  state.children.proxy = spawnProxy();
  state.gateway = startGateway({
    port: PROXY_PORT,
    upstreamPort: UPSTREAM_PORT,
    token: state.daemonToken,
  });
  await state.gateway.ready;
  await waitForProxy(`http://127.0.0.1:${PROXY_PORT}/agent-device/health`);
  info(`agent-device gateway on 127.0.0.1:${PROXY_PORT} (pid ${state.children.proxy.proc.pid})`);

  // Platform preparation must not gate tunnel registration. iOS warmup is
  // explicitly opt-in, and even its failure cannot skip Android provisioning.
  void preparePlatforms({
    warmIOS: Bun.env.SIMBOX_WARM_IOS === "true",
    ios: () => prepareIOS(state.agentDeviceBin),
    android: () =>
      prepareAndroid(
        () => {
          state.androidReady = true;
        },
        (proc) => {
          state.children.emulator = track("Android emulator", proc);
        },
      ),
    warn,
  });

  // 5. cloudflared quick tunnel — wait for the URL.
  const tunnel = spawnTunnel();
  state.children.tunnel = tunnel.child;
  try {
    state.tunnelUrl = await tunnel.url;
  } catch (err) {
    error(`tunnel never came up: ${String(err).slice(0, 300)}`);
    await shutdown("no tunnel URL", 1);
  }
  addMask(state.tunnelUrl);
  // The local origin is ready; public DNS/edge readiness is checked by the
  // client. Hairpin probes from GH runners can fail while clients can reach it.
  info("tunnel up (url registered + masked)");

  // 6. Register
  await register().catch(async (err) => {
    await shutdown(`registration failed: ${String(err).slice(0, 200)}`, 1);
    throw err; // unreachable, keeps types happy
  });

  // 7. Supervision
  await supervise();
}

main().catch(async (err) => {
  error(`fatal: ${String(err).slice(0, 500)}`);
  await shutdown("fatal boot error", 1);
});
