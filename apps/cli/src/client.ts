import type {
  ActiveRunsResponse,
  ApiError,
  DevicePlatform,
  DevicePreferences,
  EnsureRunResponse,
  InventoryResponse,
  PublicRun,
  RepoStatusResponse,
  RunSummary,
  User,
  RunnerSettings,
  RunnerPreferences,
  DeviceProfile,
  RunnerTarget,
  RunnerDiagnostics,
  WorkflowResponse,
  WorkflowSpec,
} from "@simbox/shared";
import { apiBaseUrl, loadToken } from "./config.js";
import { holderId } from "./holder.js";

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

/** Default per-request budget; a hung API must not hang the CLI. */
export const API_TIMEOUT_MS = 30_000;
/** Ensure may dispatch a workflow and wait on GitHub before answering. */
export const ENSURE_TIMEOUT_MS = 120_000;

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  /** Attach Bearer token from auth.json (default true). */
  auth?: boolean;
  /** Explicit token override (e.g. not-yet-saved device token). */
  token?: string;
  /** Abort after this many ms (default API_TIMEOUT_MS). */
  timeoutMs?: number;
}

function unreachable(err: unknown, timeoutMs: number): CliError {
  const error = err as Error;
  if (error?.name === "TimeoutError" || error?.name === "AbortError")
    return new CliError(
      `${apiBaseUrl()} did not answer within ${Math.round(timeoutMs / 1000)}s — check your connection and retry.`,
    );
  return new CliError(
    `Could not reach ${apiBaseUrl()} — check your connection. (${error?.message ?? String(err)})`,
  );
}

/** Sent on every request: Cloudflare's Browser Integrity Check refuses some defaults. */
export const USER_AGENT = "simbox-cli";

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": USER_AGENT,
  };
  const useAuth = opts.auth !== false;
  const token = opts.token ?? (useAuth ? loadToken() : null);
  if (token) headers.authorization = `Bearer ${token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";

  const timeoutMs = opts.timeoutMs ?? API_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${apiBaseUrl()}${path}`, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal,
    });
  } catch (err) {
    throw unreachable(err, timeoutMs);
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
  try {
    return (await res.json()) as T;
  } catch (err) {
    throw unreachable(err, timeoutMs);
  }
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
      headers: { "content-type": "application/json", "user-agent": USER_AGENT },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: CLI_CLIENT_ID,
      }),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (err) {
    throw unreachable(err, API_TIMEOUT_MS);
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

/** Re-renders the stored workflow spec, rotates the secret and re-verifies the install. */
export const repairRepo = () => api<RepoStatusResponse>("/v1/repo/repair", { method: "POST" });

export const ensureRun = (
  fresh: boolean,
  platform?: DevicePlatform,
  runner?: RunnerTarget,
  device?: DeviceProfile,
) =>
  api<EnsureRunResponse>("/v1/runs/ensure", {
    method: "POST",
    body: { new: fresh, platform, runner, device, holder: holderId() },
    timeoutMs: ENSURE_TIMEOUT_MS,
  });

export const runnerSettings = () => api<RunnerSettings>("/v1/runners");
export const runnerDiagnostics = () => api<RunnerDiagnostics>("/v1/runners/doctor");
export const updateRunners = (scope: "account" | "repo", patch: Partial<RunnerPreferences>) =>
  api<RunnerSettings>(`/v1/runners/${scope}`, { method: "POST", body: patch });
export const updateDevices = (scope: "account" | "repo", patch: Partial<DevicePreferences>) =>
  api<RunnerSettings>(`/v1/devices/${scope}`, { method: "POST", body: patch });

/** The last device catalog reported for a runner; runner omitted means the effective one. */
export const inventory = (platform: DevicePlatform, runner?: RunnerTarget) => {
  const query = new URLSearchParams({ platform });
  if (runner)
    query.set(
      "runner",
      runner.labels.length === 1 ? runner.labels[0]! : JSON.stringify(runner.labels),
    );
  return api<InventoryResponse>(`/v1/inventory?${query}`);
};

export const getWorkflow = () => api<WorkflowResponse>("/v1/workflow");
export const putWorkflow = (spec: WorkflowSpec) =>
  api<WorkflowResponse>("/v1/workflow", { method: "PUT", body: { spec } });

/** Every open run (several per platform), `held` marking this caller's. */
export const activeRuns = async (): Promise<PublicRun[]> => {
  // A plain terminal is the API's shared "default" holder.
  const holder = encodeURIComponent(holderId() ?? "default");
  return (await api<ActiveRunsResponse>(`/v1/runs/active?holder=${holder}`)).runs;
};

/**
 * This platform's active run, or null. Without a platform the API answers with
 * the newest active run (legacy); prefer activeRuns() for routing.
 */
export async function currentRun(platform?: DevicePlatform): Promise<PublicRun | null> {
  try {
    const res = await api<{ run: PublicRun | null }>(
      platform ? `/v1/runs/current?platform=${platform}` : "/v1/runs/current",
    );
    return res.run;
  } catch (err) {
    if (err instanceof ApiRequestError && (err.status === 404 || err.code === "no_run")) {
      return null;
    }
    throw err;
  }
}

export const stopRun = (runId: string) =>
  api<{ run: PublicRun }>(`/v1/runs/${encodeURIComponent(runId)}/stop`, {
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
    if (err.code === "workflow_needs_repair") {
      return new CliError(
        `${err.message}\nRun \`simbox repair\` to upgrade the workflow (merge its PR if the default branch is protected).`,
      );
    }
    if (err.code === "platform_busy") {
      return new CliError(
        `${err.message}\nSee \`simbox ps\`; \`simbox stop --platform <ios|android>\` ends a run and \`simbox sim --new --platform <ios|android>\` replaces one.`,
      );
    }
    if (err.code === "invalid_device") {
      return new CliError(
        `${err.message}\nRun \`simbox devices list --platform <ios|android>\` to see what the runner offers.`,
      );
    }
    return new CliError(err.message);
  }
  if (err instanceof Error) return new CliError(err.message);
  return new CliError(String(err));
}
