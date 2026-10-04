import type { Context, Env as HonoEnv } from "hono";
import type { AuthUser, RepoRow, RunRow } from "./db";
import type { ApiError, PublicRun, Repo, RunSummary, User } from "@simbox/shared";

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function newId(): string {
  return crypto.randomUUID();
}

/** 32 random bytes, hex — used for SIMBOX_TOKEN and CLI bearer tokens. */
export function randomTokenHex(bytes = 32): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Hex(input: string | ArrayBuffer): Promise<string> {
  const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", data)));
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  // chunked to avoid arg-count limits on String.fromCharCode
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

// ---- API error + row→contract mappers ----

export function apiError<E extends HonoEnv>(
  c: Context<E>,
  status: 400 | 401 | 403 | 404 | 409 | 500,
  error: string,
  message: string,
): Response {
  const body: ApiError = { error, message };
  return c.json(body, status);
}

// D1 stores unix seconds; API contracts emit epoch MILLISECONDS (JS convention —
// CLI/web do `expiresAt - Date.now()`).
const toMs = (s: number) => s * 1000;
const toMsOrNull = (s: number | null) => (s === null ? null : s * 1000);

export function toPublicUser(user: AuthUser): User {
  return {
    id: user.id,
    githubUserId: user.githubUserId ?? 0,
    login: user.login,
    avatarUrl: user.avatarUrl ?? "",
    createdAt: user.createdAtMs,
  };
}

export function toPublicRepo(row: RepoRow): Repo {
  return {
    repoId: row.repo_id,
    fullName: row.full_name,
    private: row.private === 1,
    defaultBranch: row.default_branch,
    installationId: row.installation_id,
    state: row.state,
    prUrl: row.pr_url,
    createdAt: toMs(row.created_at),
  };
}

export function toPublicRun(row: RunRow): PublicRun {
  return {
    id: row.id,
    ghRunId: row.gh_run_id,
    state: row.state,
    platform: row.platform,
    tunnelUrl: row.tunnel_url,
    daemonToken: row.daemon_token,
    activeDevices: row.active_devices,
    androidReady: row.android_ready === 1,
    createdAt: toMs(row.created_at),
    expiresAt: toMsOrNull(row.expires_at),
    endReason: row.end_reason,
  };
}

export function toRunSummary(row: RunRow): RunSummary {
  return {
    id: row.id,
    ghRunId: row.gh_run_id,
    state: row.state,
    activeDevices: row.active_devices,
    createdAt: toMs(row.created_at),
    endedAt: toMsOrNull(row.ended_at),
    endReason: row.end_reason,
  };
}
