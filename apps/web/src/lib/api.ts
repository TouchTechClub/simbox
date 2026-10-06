import { PROD_API_URL } from "@simbox/shared/constants";
import type { PublicRun, Repo, RepoStatusResponse, RunSummary, User } from "@simbox/shared/types";
import type { RunnerSettings, RunnerPreferences, RunnerTarget } from "@simbox/shared/runners";
import type { PreviewInventory, PreviewAccess } from "@simbox/shared/preview";

/**
 * API base URL. Same-origin is NOT assumed in prod: the API lives on
 * api.simbox.touchtech.club and the session cookie rides along via
 * credentials: "include". In dev, VITE_API_URL is empty (see .env.development)
 * so requests are relative and vite proxies them to `wrangler dev`.
 */
export const API_URL = import.meta.env.VITE_API_URL ?? PROD_API_URL;

export const GITHUB_APP_INSTALL_URL =
  import.meta.env.VITE_GITHUB_APP_INSTALL_URL ??
  "https://github.com/apps/simbox-touchtechclub/installations/new";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * On any 401 the session is gone (or never existed) — stash the current
 * location so the landing page can send the user back after re-auth, then
 * bounce to `/` (which shows the GitHub sign-in button).
 */
function handleUnauthorized(): void {
  const here = window.location.pathname + window.location.search;
  if (here !== "/" && !here.startsWith("/auth")) {
    try {
      sessionStorage.setItem("simbox_return_to", here);
    } catch {
      /* storage unavailable — fine */
    }
    window.location.href = "/";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    credentials: "include",
    headers: { "content-type": "application/json", ...init?.headers },
    ...init,
  });

  if (res.status === 401) {
    handleUnauthorized();
    throw new ApiError(401, "unauthorized");
  }
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      message = body.message ?? body.error ?? message;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const get = <T>(path: string) => request<T>(path);
const post = <T>(path: string, body?: unknown) =>
  request<T>(path, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });

// ---- Local contract types ----
// These endpoints' response shapes aren't exported by @simbox/shared yet;
// keep the assumptions in one place. Parsing is defensive about field naming.

export interface InstallableRepo {
  repoId: number;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  installationId: number;
}

export interface CurrentRunResponse {
  run: PublicRun | null;
}

export interface RunsResponse {
  runs: RunSummary[];
}

// ---- Defensive normalization (snake_case ↔ camelCase tolerant) ----

type Rec = Record<string, unknown>;
const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0));
const str = (v: unknown): string => String(v ?? "");
const bool = (v: unknown): boolean => v === true || v === 1;

function asArray(raw: unknown): Rec[] {
  if (Array.isArray(raw)) return raw as Rec[];
  if (raw && typeof raw === "object") {
    const r = raw as Rec;
    for (const key of ["repos", "repositories", "items", "installations"]) {
      if (Array.isArray(r[key])) return r[key] as Rec[];
    }
  }
  return [];
}

/** Extract repo entries from GET /v1/installations (flat or nested). */
function extractRepos(raw: unknown): InstallableRepo[] {
  const out: InstallableRepo[] = [];
  const seen = new Set<number>();
  const push = (r: Rec, fallbackInstallationId: unknown) => {
    const repoId = num(r.repoId ?? r.repo_id ?? r.id);
    if (!repoId || seen.has(repoId)) return;
    seen.add(repoId);
    out.push({
      repoId,
      fullName: str(r.fullName ?? r.full_name ?? r.name),
      private: bool(r.private),
      defaultBranch: str(r.defaultBranch ?? r.default_branch ?? "main"),
      installationId: num(r.installationId ?? r.installation_id ?? fallbackInstallationId),
    });
  };

  for (const item of asArray(raw)) {
    // Nested shape: { installation_id, account_login, repos: [...] }
    if (Array.isArray(item.repos) || Array.isArray(item.repositories)) {
      const instId = item.installationId ?? item.installation_id;
      for (const r of asArray(item.repos ?? item.repositories)) push(r, instId);
    } else {
      push(item, undefined);
    }
  }
  return out;
}

function normalizeRepo(raw: unknown): Repo | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Rec;
  return {
    repoId: num(r.repoId ?? r.repo_id),
    fullName: str(r.fullName ?? r.full_name),
    private: bool(r.private),
    defaultBranch: str(r.defaultBranch ?? r.default_branch),
    installationId: num(r.installationId ?? r.installation_id),
    state: str(r.state) as Repo["state"],
    prUrl: (r.prUrl ?? r.pr_url ?? null) as string | null,
    createdAt: num(r.createdAt ?? r.created_at),
  };
}

function normalizeRun(raw: unknown): PublicRun | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Rec;
  return {
    id: str(r.id),
    ghRunId: (r.ghRunId ?? r.gh_run_id ?? null) as number | null,
    state: str(r.state) as PublicRun["state"],
    platform: r.platform === "android" ? "android" : "ios",
    runner: (r.runner ?? null) as RunnerTarget | null,
    tunnelUrl: (r.tunnelUrl ?? r.tunnel_url ?? null) as string | null,
    daemonToken: (r.daemonToken ?? r.daemon_token ?? null) as string | null,
    activeDevices: num(r.activeDevices ?? r.active_devices),
    androidReady: bool(r.androidReady ?? r.android_ready),
    createdAt: num(r.createdAt ?? r.created_at),
    expiresAt: (r.expiresAt ?? r.expires_at ?? null) as number | null,
    endReason: (r.endReason ?? r.end_reason ?? null) as string | null,
  };
}

function normalizeRunSummary(raw: unknown): RunSummary {
  const r = (raw ?? {}) as Rec;
  return {
    id: str(r.id),
    ghRunId: (r.ghRunId ?? r.gh_run_id ?? null) as number | null,
    state: str(r.state) as RunSummary["state"],
    platform: r.platform === "android" ? "android" : "ios",
    runner: (r.runner ?? null) as RunnerTarget | null,
    activeDevices: num(r.activeDevices ?? r.active_devices),
    createdAt: num(r.createdAt ?? r.created_at),
    endedAt: (r.endedAt ?? r.ended_at ?? null) as number | null,
    endReason: (r.endReason ?? r.end_reason ?? null) as string | null,
  };
}

// ---- API surface used by the app ----

export const api = {
  previewDevices: (runId: string, signal?: AbortSignal) =>
    request<PreviewInventory>(`/v1/runs/${encodeURIComponent(runId)}/preview/devices`, { signal }),
  previewAccess: (runId: string, device: string, control: boolean, signal?: AbortSignal) =>
    request<PreviewAccess>(`/v1/runs/${encodeURIComponent(runId)}/preview/access`, {
      method: "POST",
      body: JSON.stringify({ device, control }),
      signal,
    }),
  me: async (): Promise<User> => {
    const raw = await get<unknown>("/v1/me");
    // API wraps: {user, repo}
    if (raw && typeof raw === "object" && "user" in (raw as Rec)) {
      return (raw as Rec).user as User;
    }
    return raw as User;
  },

  installations: async (): Promise<InstallableRepo[]> =>
    extractRepos(await get<unknown>("/v1/installations")),

  connectRepo: (body: {
    repo_id: number;
    full_name: string;
    private: boolean;
    default_branch: string;
    installation_id: number;
  }) =>
    post<{ ok: boolean; state?: Repo["state"]; pr_url?: string | null }>("/v1/repo/connect", body),

  repoStatus: async (): Promise<RepoStatusResponse> => {
    const raw = (await get<unknown>("/v1/repo/status")) as Rec;
    const repo = normalizeRepo(raw?.repo ?? (raw?.connected ? raw : null));
    return { connected: repo !== null || bool(raw?.connected), repo };
  },

  repairRepo: () => post<{ ok: boolean }>("/v1/repo/repair"),
  disconnectRepo: () => post<{ ok: boolean }>("/v1/repo/disconnect"),
  runnerSettings: () => get<RunnerSettings>("/v1/runners"),
  updateRunners: (scope: "account" | "repo", patch: Partial<RunnerPreferences>) =>
    post<RunnerSettings>(`/v1/runners/${scope}`, patch),

  currentRun: async (): Promise<CurrentRunResponse> => {
    const raw = await get<unknown>("/v1/runs/current");
    if (raw && typeof raw === "object" && "run" in (raw as Rec)) {
      return { run: normalizeRun((raw as Rec).run) };
    }
    // Bare-run shape
    return { run: normalizeRun(raw) };
  },

  runs: async (): Promise<RunsResponse> => {
    const raw = await get<unknown>("/v1/runs");
    const list = Array.isArray(raw) ? raw : asArray(raw);
    return { runs: list.map(normalizeRunSummary) };
  },

  stopRun: (runId: string) => post<{ ok: boolean }>(`/v1/runs/${runId}/stop`),
};
