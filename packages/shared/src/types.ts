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
}

/** Run shape returned to authenticated users (their own tokens are included). */
export interface PublicRun {
  id: string;
  ghRunId: number | null;
  state: RunState;
  platform: "ios" | "android";
  tunnelUrl: string | null;
  daemonToken: string | null;
  activeDevices: number;
  androidReady: boolean;
  createdAt: number;
  expiresAt: number | null;
  endReason: string | null;
}

/** Thin public run shape for lists/history — no secrets. */
export interface RunSummary {
  id: string;
  ghRunId: number | null;
  state: RunState;
  activeDevices: number;
  createdAt: number;
  endedAt: number | null;
  endReason: string | null;
}

// ---- API contracts ----

export interface EnsureRunRequest {
  new?: boolean;
  platform?: "ios" | "android";
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

// Auth/device-flow types are owned by better-auth (RFC 8628 shapes) —
// clients use the standard endpoints under /api/auth/*.

export interface RepoStatusResponse {
  connected: boolean;
  repo: Repo | null;
}

export interface RunRegisterRequest {
  ghRunId: number;
  tunnelUrl: string;
  daemonToken: string;
  versions: {
    agent: string;
    agentDevice: string;
    cloudflared: string;
  };
}

export interface RunHeartbeatRequest {
  ghRunId: number;
  activeDevices: number;
  androidReady: boolean;
}

export interface RunDeregisterRequest {
  ghRunId: number;
  reason?: string;
}

export interface ApiError {
  error: string;
  message: string;
}
