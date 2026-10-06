import type {
  ApiError,
  EnsureRunResponse,
  PublicRun,
  RepoStatusResponse,
  RunSummary,
  User,
  RunnerSettings,
  RunnerPreferences,
  RunnerTarget,
  RunnerDiagnostics,
} from "@simbox/shared";
import { apiBaseUrl, loadToken } from "./config.js";

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "DELETE";
  body?: unknown;
  /** Attach Bearer token from auth.json (default true). */
  auth?: boolean;
  /** Explicit token override (e.g. not-yet-saved device token). */
  token?: string;
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {
    accept: "application/json",
  };
  const useAuth = opts.auth !== false;
  const token = opts.token ?? (useAuth ? loadToken() : null);
  if (token) headers.authorization = `Bearer ${token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(`${apiBaseUrl()}${path}`, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (err) {
    throw new CliError(
      `Could not reach ${apiBaseUrl()} — check your connection. (${(err as Error).message})`,
    );
  }

  if (res.status === 401 || res.status === 403) {
    throw new ApiRequestError(
      res.status,
      "unauthorized",
      "Your session is invalid or expired. Run `simbox login`.",
    );
  }
  if (res.status === 404) {
    const body = await parseErrorBody(res);
    throw new ApiRequestError(404, body?.error ?? "not_found", body?.message ?? "Not found.");
  }
  if (!res.ok) {
    const body = await parseErrorBody(res);
    throw new ApiRequestError(
      res.status,
      body?.error ?? `http_${res.status}`,
      body?.message ?? `Request failed (HTTP ${res.status}).`,
    );
  }
  return (await res.json()) as T;
}

async function parseErrorBody(res: Response): Promise<ApiError | null> {
  try {
    return (await res.json()) as ApiError;
  } catch {
    return null;
  }
}

// ---- Endpoint helpers ----

// Auth is better-auth. CLI login = RFC 8628 device flow against /api/auth/*.
// These endpoints return RFC 8628 snake_case fields and JSON (NOT form-encoded).

export const CLI_CLIENT_ID = "simbox-cli";

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

export type DeviceTokenResult =
  | { ok: true; token: string }
  | { ok: false; error: string; description?: string };

export const startDeviceFlow = () =>
  api<DeviceCodeResponse>("/api/auth/device/code", {
    method: "POST",
    auth: false,
    body: { client_id: CLI_CLIENT_ID },
  });

/** Poll /api/auth/device/token. Error statuses (authorization_pending etc.)
 *  come back as non-2xx JSON — decode them rather than throwing. */
export async function pollDeviceToken(deviceCode: string): Promise<DeviceTokenResult> {
  let res: Response;
  try {
    res = await fetch(`${apiBaseUrl()}/api/auth/device/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: CLI_CLIENT_ID,
      }),
    });
  } catch (err) {
    throw new CliError(
      `Could not reach ${apiBaseUrl()} — check your connection. (${(err as Error).message})`,
    );
  }
  const body = (await res.json().catch(() => null)) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  } | null;
  if (res.ok && body?.access_token) return { ok: true, token: body.access_token };
  return {
    ok: false,
    error: body?.error ?? `http_${res.status}`,
    description: body?.error_description,
  };
}

export const me = async (token?: string): Promise<User> =>
  (await api<{ user: User }>("/v1/me", { token })).user;

export const repoStatus = () => api<RepoStatusResponse>("/v1/repo/status");

export const repairRepo = () =>
  api<{ ok: boolean; state?: string; message?: string }>("/v1/repo/repair", {
    method: "POST",
  });

export const ensureRun = (fresh: boolean, platform?: "ios" | "android", runner?: RunnerTarget) =>
  api<EnsureRunResponse>("/v1/runs/ensure", {
    method: "POST",
    body: { new: fresh, platform, runner },
  });

export const runnerSettings = () => api<RunnerSettings>("/v1/runners");
export const runnerDiagnostics = () => api<RunnerDiagnostics>("/v1/runners/doctor");
export const updateRunners = (scope: "account" | "repo", patch: Partial<RunnerPreferences>) =>
  api<RunnerSettings>(`/v1/runners/${scope}`, { method: "POST", body: patch });

/** null when the user has no active/recent run. API wraps: {run: PublicRun | null}. */
export async function currentRun(): Promise<PublicRun | null> {
  try {
    const res = await api<{ run: PublicRun | null }>("/v1/runs/current");
    return res.run;
  } catch (err) {
    if (err instanceof ApiRequestError && (err.status === 404 || err.code === "no_run")) {
      return null;
    }
    throw err;
  }
}

export const stopRun = (runId: string) =>
  api<{ ok: boolean; state?: string }>(`/v1/runs/${encodeURIComponent(runId)}/stop`, {
    method: "POST",
  });

export const runHistory = async (): Promise<RunSummary[]> =>
  (await api<{ runs: RunSummary[] }>("/v1/runs")).runs;

/** Map API error codes into actionable CLI messages. */
export function friendlyError(err: unknown): CliError {
  if (err instanceof CliError) return err;
  if (err instanceof ApiRequestError) {
    if (err.code === "repo_not_connected" || err.code === "no_repo") {
      return new CliError(`${err.message}\nRun \`simbox init\` to connect a repo.`);
    }
    if (err.code === "at_capacity") {
      return new CliError(
        `${err.message}\nThat run is full — try \`simbox sim --new\` for a fresh one.`,
      );
    }
    if (
      err.code === "needs_repair" ||
      err.code === "repo_needs_repair" ||
      err.code === "repo_not_ready" ||
      err.code === "dispatch_failed"
    ) {
      return new CliError(`${err.message}\nRun \`simbox repair\` to fix the repo setup.`);
    }
    return new CliError(err.message);
  }
  if (err instanceof Error) return new CliError(err.message);
  return new CliError(String(err));
}
