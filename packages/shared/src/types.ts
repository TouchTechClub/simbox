import type { BootedDevice, DeviceCatalog, RunnerInventory } from "./device-catalog.js";
import type { DeviceProfile } from "./device-profile.js";
import type { DevicePlatform, RunnerTarget } from "./runners.js";
import type { WorkflowSpec, WorkflowStatus } from "./workflow.js";

/** Run lifecycle states (D1 `runs.state`). */
export type RunState =
  | "dispatching" // workflow_dispatch sent, awaiting gh_run_id binding
  | "queued" // gh_run_id bound, waiting for runner pickup
  | "booting" // runner started, agent provisioning / awaiting registration
  | "live" // tunnel registered, connectable
  | "closing" // graceful shutdown in progress
  | "ended" // exited cleanly (idle, hard limit, or user stop)
  | "failed"; // run failed / died / never registered

/** Repo connection states (D1 `repos.state`). */
export type RepoState =
  | "ok"
  | "pending_pr" // protected branch: PR opened, awaiting merge
  | "needs_repair"
  | "uninstalled";

export interface User {
  id: string;
  githubUserId: number;
  login: string;
  avatarUrl: string;
  createdAt: number;
}

export interface Repo {
  repoId: number;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  installationId: number;
  state: RepoState;
  prUrl: string | null;
  createdAt: number;
  /** Schema version of the committed workflow; below 2 cannot run iOS and Android at once. */
  workflowVersion: number;
}

/** Run shape returned to authenticated users (their own tokens are included). */
export interface PublicRun {
  id: string;
  ghRunId: number | null;
  state: RunState;
  platform: "ios" | "android";
  runner: RunnerTarget | null;
  /** What was requested after layering defaults. */
  device: DeviceProfile | null;
  /** What the runner actually booted, once it reports it. */
  bootedDevice: BootedDevice | null;
  tunnelUrl: string | null;
  daemonToken: string | null;
  activeDevices: number;
  /** Devices the runner runs at once; estimated until the runner reports it. */
  maxDevices: number | null;
  /** Reserved for the caller that asked (`holder`); only set when one was given. */
  held?: boolean;
  androidReady: boolean;
  /** The run's devices are booted and accept commands. */
  devicesReady: boolean;
  createdAt: number;
  expiresAt: number | null;
  endReason: string | null;
}

/** GET /v1/runs/active[?holder=] — every starting, live or closing run. */
export interface ActiveRunsResponse {
  runs: PublicRun[];
}

/** Thin public run shape for lists/history — no secrets. */
export interface RunSummary {
  id: string;
  ghRunId: number | null;
  state: RunState;
  platform: "ios" | "android";
  runner: RunnerTarget | null;
  device: DeviceProfile | null;
  bootedDevice: BootedDevice | null;
  activeDevices: number;
  maxDevices: number | null;
  createdAt: number;
  endedAt: number | null;
  endReason: string | null;
}

// ---- API contracts ----

export interface EnsureRunRequest {
  /** Start another run instead of reusing one. Other runs keep running. */
  new?: boolean;
  /**
   * Opaque caller identity (an agent thread or session). Each holder keeps
   * its run across calls, and runs at their device cap go to other holders.
   */
  holder?: string;
  /** Omitted: reuse the only active run, else start iOS. */
  platform?: "ios" | "android";
  runner?: RunnerTarget;
  device?: DeviceProfile;
}

export type EnsureRunResponse =
  | {
      state: "live";
      runId: string;
      ghRunId: number;
      tunnelUrl: string;
      daemonToken: string;
      expiresAt: number;
    }
  | { state: "dispatching" | "queued" | "booting"; runId: string };

// Runner-authenticated requests carry the run id Simbox dispatched
// (`simbox_run` workflow input). Older agents send only ghRunId.

// Auth/device-flow types are owned by better-auth (RFC 8628 shapes) —
// clients use the standard endpoints under /api/auth/*.

export interface RepoStatusResponse {
  connected: boolean;
  repo: Repo | null;
}

export interface RunRegisterRequest {
  ghRunId: number;
  runId?: string;
  tunnelUrl: string;
  daemonToken: string;
  versions: {
    agent: string;
    agentDevice: string;
    cloudflared: string;
    deviceHub?: string;
  };
  /** Devices this runner runs at once, when it reports them; else the API estimates it. */
  maxDevices?: number;
}

export interface RunTunnelRequest {
  ghRunId: number;
  runId?: string;
}

export interface RunConfigRequest {
  ghRunId: number;
  runId?: string;
}

/** What the runner should prepare, as requested when the run was dispatched. */
export interface RunConfigResponse {
  platform: "ios" | "android";
  device: DeviceProfile | null;
  runId?: string;
  /** The runner's configured device count, if set. */
  maxDevices?: number;
}

/** POST /v1/runs/inventory — what the runner offers and what it booted. */
export interface RunInventoryRequest {
  ghRunId: number;
  runId?: string;
  catalog: DeviceCatalog;
  booted?: BootedDevice;
}

/** GET /v1/inventory?platform=&runner= — the last catalog reported for a runner. */
export interface InventoryResponse {
  platform: DevicePlatform;
  runner: RunnerTarget;
  inventory: RunnerInventory | null;
}

/** GET/PUT /v1/workflow */
export interface WorkflowResponse {
  spec: WorkflowSpec;
  yaml: string;
  /** Committed file vs. the rendered spec; null when GitHub could not be read. */
  status: WorkflowStatus | null;
  repoState: RepoState;
  prUrl: string | null;
}

/** A named Cloudflare tunnel for one run: stable URL, several edge connections. */
export interface RunTunnelResponse {
  tunnelUrl: string;
  /** cloudflared connector token; pass as TUNNEL_TOKEN, never on argv or in logs. */
  connectorToken: string;
}

export interface RunHeartbeatRequest {
  ghRunId: number;
  runId?: string;
  activeDevices: number;
  androidReady: boolean;
  /** Newer agents: the run's devices are booted (iOS or Android). */
  devicesReady?: boolean;
}

export interface RunDeregisterRequest {
  ghRunId: number;
  runId?: string;
  reason?: string;
}

export interface ApiError {
  error: string;
  message: string;
}
