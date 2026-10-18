import {
  REPO_SECRET_NAME,
  WORKFLOW_COMMIT_MESSAGE,
  WORKFLOW_PATH,
  DEFAULT_RUNNERS,
  validateRunner,
  type RunnerTarget,
} from "@simbox/shared";
import { sealedBox } from "./sealedbox";
import type { Env } from "./env";
import {
  base64ToBytes,
  bytesToBase64,
  bytesToBase64Url,
  hexToBytes,
  nowSeconds,
  sleep,
} from "./util";

const GH_API = "https://api.github.com";

export class GithubApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GithubApiError";
  }
}

// ---------------------------------------------------------------------------
// App JWT (RS256) — signed with WebCrypto, no JWT dependency.
// ---------------------------------------------------------------------------

let cachedKey: { pem: string; key: Promise<CryptoKey> } | null = null;

function importAppKey(pem: string): Promise<CryptoKey> {
  // PEM may arrive with literal "\n" escapes from secrets stores.
  const normalized = pem.replace(/\\n/g, "\n");
  const body = normalized
    .replace(/-----BEGIN [A-Z ]+-----/g, "")
    .replace(/-----END [A-Z ]+-----/g, "")
    .replace(/\s+/g, "");
  const der = base64ToBytes(body);
  return crypto.subtle.importKey(
    "pkcs8",
    der.buffer as ArrayBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

export async function appJwt(env: Env): Promise<string> {
  if (!cachedKey || cachedKey.pem !== env.GITHUB_APP_PRIVATE_KEY) {
    cachedKey = { pem: env.GITHUB_APP_PRIVATE_KEY, key: importAppKey(env.GITHUB_APP_PRIVATE_KEY) };
  }
  const key = await cachedKey.key;

  const now = nowSeconds();
  const header = { alg: "RS256", typ: "JWT" };
  // GitHub requires iat <= 60s in the past to tolerate clock skew; exp <= 10min.
  const payload = { iat: now - 60, exp: now + 9 * 60, iss: env.GITHUB_APP_ID };
  const enc = new TextEncoder();
  const signingInput =
    bytesToBase64Url(enc.encode(JSON.stringify(header))) +
    "." +
    bytesToBase64Url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(signingInput));
  return signingInput + "." + bytesToBase64Url(new Uint8Array(sig));
}

// ---------------------------------------------------------------------------
// Fetch helper
// ---------------------------------------------------------------------------

export interface GhFetchOptions {
  method?: string;
  body?: unknown;
}

export async function gh<T>(token: string, path: string, opts: GhFetchOptions = {}): Promise<T> {
  const res = await fetch(`${GH_API}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "simbox-api",
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new GithubApiError(
      res.status,
      `GitHub ${opts.method ?? "GET"} ${path}: ${res.status} ${text.slice(0, 300)}`,
    );
  }
  // 202/204 (cancel, dispatch) may have an empty body.
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

// ---------------------------------------------------------------------------
// Installation tokens — 1h lifetime, cached in KV until expiry.
// ---------------------------------------------------------------------------

interface AccessTokenResponse {
  token: string;
  expires_at: string; // ISO
}

export async function installationToken(env: Env, installationId: number): Promise<string> {
  const kvKey = `gh_inst_token:${installationId}`;
  const cached = await env.KV.get(kvKey, "json");
  if (cached && typeof cached === "object") {
    const c = cached as { token?: string; expiresAt?: number };
    // 60s safety margin so a token doesn't die mid-request.
    if (
      typeof c.token === "string" &&
      typeof c.expiresAt === "number" &&
      c.expiresAt - 60 > nowSeconds()
    ) {
      return c.token;
    }
  }
  const jwt = await appJwt(env);
  const res = await gh<AccessTokenResponse>(
    jwt,
    `/app/installations/${installationId}/access_tokens`,
    { method: "POST", body: {} },
  );
  const expiresAt = Math.floor(new Date(res.expires_at).getTime() / 1000);
  const ttl = Math.max(60, expiresAt - nowSeconds() - 120);
  await env.KV.put(kvKey, JSON.stringify({ token: res.token, expiresAt }), {
    expirationTtl: ttl,
  });
  return res.token;
}

// ---------------------------------------------------------------------------
// Workflow file commit (with protected-branch PR fallback)
// ---------------------------------------------------------------------------

interface ContentFile {
  sha: string;
  /** base64 with embedded newlines; absent for files over 1MB. */
  content?: string;
}

interface RefResponse {
  object: { sha: string };
}

interface PullResponse {
  html_url: string;
  number: number;
}

export type CommitResult = { kind: "committed" } | { kind: "pending_pr"; prUrl: string };

const SETUP_BRANCH = "simbox-setup";

async function putWorkflowFile(
  token: string,
  fullName: string,
  branch: string,
  sha: string | null,
  yaml: string,
): Promise<void> {
  await gh<unknown>(token, `/repos/${fullName}/contents/${WORKFLOW_PATH}`, {
    method: "PUT",
    body: {
      message: WORKFLOW_COMMIT_MESSAGE,
      content: bytesToBase64(new TextEncoder().encode(yaml)),
      branch,
      ...(sha ? { sha } : {}),
    },
  });
}

async function getWorkflowFile(
  token: string,
  fullName: string,
  branch: string,
): Promise<ContentFile | null> {
  try {
    return await gh<ContentFile>(
      token,
      `/repos/${fullName}/contents/${WORKFLOW_PATH}?ref=${encodeURIComponent(branch)}`,
    );
  } catch (e) {
    if (e instanceof GithubApiError && e.status === 404) return null;
    throw e;
  }
}

async function getFileSha(token: string, fullName: string, branch: string): Promise<string | null> {
  return (await getWorkflowFile(token, fullName, branch))?.sha ?? null;
}

/** The workflow file's text on a branch, or null when it does not exist. */
export async function readWorkflowFile(
  token: string,
  fullName: string,
  branch: string,
): Promise<string | null> {
  const file = await getWorkflowFile(token, fullName, branch);
  if (!file) return null;
  return typeof file.content === "string" ? decodeContent(file.content) : "";
}

/**
 * Commit a rendered workflow to the default branch. On a protected branch
 * (403/409 from rulesets), fall back to a `simbox-setup` branch + PR; caller
 * marks the repo `pending_pr` and stores the returned pr_url. Unchanged
 * content is not re-committed.
 */
export async function commitWorkflow(
  token: string,
  fullName: string,
  defaultBranch: string,
  yaml: string,
): Promise<CommitResult> {
  const current = await getWorkflowFile(token, fullName, defaultBranch);
  if (current?.content && decodeContent(current.content) === yaml) return { kind: "committed" };
  try {
    await putWorkflowFile(token, fullName, defaultBranch, current?.sha ?? null, yaml);
    return { kind: "committed" };
  } catch (e) {
    if (!(e instanceof GithubApiError) || (e.status !== 403 && e.status !== 409)) throw e;
  }

  // Protected branch → PR path.
  const ref = await gh<RefResponse>(
    token,
    `/repos/${fullName}/git/ref/heads/${encodeURIComponent(defaultBranch)}`,
  );
  try {
    await gh<unknown>(token, `/repos/${fullName}/git/refs`, {
      method: "POST",
      body: { ref: `refs/heads/${SETUP_BRANCH}`, sha: ref.object.sha },
    });
  } catch (e) {
    // 422 = branch already exists — reuse it.
    if (!(e instanceof GithubApiError) || e.status !== 422) throw e;
  }
  const branchFile = await getWorkflowFile(token, fullName, SETUP_BRANCH);
  if (!branchFile?.content || decodeContent(branchFile.content) !== yaml)
    await putWorkflowFile(token, fullName, SETUP_BRANCH, branchFile?.sha ?? null, yaml);
  try {
    const pr = await gh<PullResponse>(token, `/repos/${fullName}/pulls`, {
      method: "POST",
      body: {
        title: "Update Simbox workflow",
        head: SETUP_BRANCH,
        base: defaultBranch,
        body: "Updates `.github/workflows/simbox.yml` so Simbox can run iOS/Android emulators on this repo's GitHub Actions minutes. Merge to finish setup.",
      },
    });
    return { kind: "pending_pr", prUrl: pr.html_url };
  } catch (e) {
    // 422: a PR from simbox-setup is already open; the push above updated it.
    if (!(e instanceof GithubApiError) || e.status !== 422) throw e;
    const owner = fullName.split("/")[0];
    const open = await gh<PullResponse[]>(
      token,
      `/repos/${fullName}/pulls?state=open&head=${encodeURIComponent(`${owner}:${SETUP_BRANCH}`)}&per_page=1`,
    );
    if (!open[0]) throw e;
    return { kind: "pending_pr", prUrl: open[0].html_url };
  }
}

function decodeContent(content: string): string {
  return new TextDecoder().decode(base64ToBytes(content.replace(/\s+/g, "")));
}

/** Best-effort removal of the workflow file from the default branch. */
export async function deleteWorkflowFile(
  token: string,
  fullName: string,
  defaultBranch: string,
): Promise<void> {
  const sha = await getFileSha(token, fullName, defaultBranch);
  if (!sha) return;
  await gh<unknown>(token, `/repos/${fullName}/contents/${WORKFLOW_PATH}`, {
    method: "DELETE",
    body: {
      message: "chore: remove simbox workflow",
      sha,
      branch: defaultBranch,
    },
  });
}

// ---------------------------------------------------------------------------
// SIMBOX_TOKEN repo secret — libsodium-compatible sealed box (see sealedbox.ts).
// ---------------------------------------------------------------------------

export async function writeSimboxTokenSecret(
  token: string,
  fullName: string,
  secretValue: string,
): Promise<void> {
  const pub = await gh<{ key_id: string; key: string }>(
    token,
    `/repos/${fullName}/actions/secrets/public-key`,
  );
  const encrypted = sealedBox(new TextEncoder().encode(secretValue), base64ToBytes(pub.key));
  const res = await fetch(`${GH_API}/repos/${fullName}/actions/secrets/${REPO_SECRET_NAME}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "simbox-api",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      encrypted_value: bytesToBase64(encrypted),
      key_id: pub.key_id,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new GithubApiError(
      res.status,
      `write secret ${fullName}: ${res.status} ${text.slice(0, 300)}`,
    );
  }
}

export async function deleteSimboxTokenSecret(token: string, fullName: string): Promise<void> {
  try {
    await gh<unknown>(token, `/repos/${fullName}/actions/secrets/${REPO_SECRET_NAME}`, {
      method: "DELETE",
    });
  } catch (e) {
    if (!(e instanceof GithubApiError) || e.status !== 404) throw e;
  }
}

// ---------------------------------------------------------------------------
// workflow_dispatch + run-id binding + cancel
// ---------------------------------------------------------------------------

export interface DispatchOptions {
  platform: "ios" | "android";
  runner?: RunnerTarget;
  /** Simbox run id; omitted only for legacy (v1) workflows without the input. */
  simboxRun?: string;
}

export async function dispatchWorkflow(
  token: string,
  fullName: string,
  ref: string,
  options: DispatchOptions,
): Promise<void> {
  const { platform, runner = DEFAULT_RUNNERS[platform], simboxRun } = options;
  // The workflow file is addressed by path, per the REST API.
  await gh<unknown>(token, `/repos/${fullName}/actions/workflows/simbox.yml/dispatches`, {
    method: "POST",
    // Always bind the exact selected target. Old workflows must be repaired;
    // omitting inputs could silently run on a different (possibly paid) image.
    body: {
      ref,
      inputs: {
        platform,
        runner_labels: JSON.stringify(validateRunner(runner, platform).labels),
        ...(simboxRun ? { simbox_run: simboxRun } : {}),
      },
    },
  });
}

/** GitHub's 422 when a dispatch passes an input the committed workflow lacks. */
export function isUnexpectedInputError(error: unknown): boolean {
  return (
    error instanceof GithubApiError &&
    error.status === 422 &&
    /unexpected inputs?/i.test(error.message)
  );
}

interface WorkflowRunsResponse {
  total_count: number;
  workflow_runs: Array<{ id: number; status: string; display_title?: string }>;
}

async function listDispatchedRuns(
  token: string,
  fullName: string,
  since: number,
): Promise<WorkflowRunsResponse["workflow_runs"]> {
  const iso = new Date((since - 5) * 1000).toISOString();
  const res = await gh<WorkflowRunsResponse>(
    token,
    `/repos/${fullName}/actions/workflows/simbox.yml/runs?event=workflow_dispatch&created=${encodeURIComponent(`>=${iso}`)}&per_page=20`,
  );
  return res.workflow_runs;
}

/**
 * The GitHub run whose `run-name` carries this Simbox run id (v2 workflows).
 * Exact correlation: two platforms dispatched in the same second cannot swap.
 */
export async function findDispatchedRun(
  token: string,
  fullName: string,
  simboxRunId: string,
  dispatchedAt: number,
): Promise<number | null> {
  const runs = await listDispatchedRuns(token, fullName, dispatchedAt);
  return runs.find((run) => run.display_title?.toLowerCase().includes(simboxRunId))?.id ?? null;
}

/**
 * Legacy (v1 workflow) binding: workflow_dispatch returns 204 with no run id,
 * so poll for the oldest run created after `dispatchedAt` that no other Simbox
 * run already claims. Bounded (~24s) so ensure can't hang; on a miss the row
 * stays unbound and the webhook or reconcile binds it later.
 */
export async function bindGhRunId(
  token: string,
  fullName: string,
  dispatchedAt: number,
  claimed: ReadonlySet<number>,
  attempts = 8,
): Promise<number | null> {
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(3000);
    const runs = await listDispatchedRuns(token, fullName, dispatchedAt);
    const run = runs.filter((r) => !claimed.has(r.id)).at(-1);
    if (run) return run.id;
  }
  return null;
}

/** Whether a GitHub user may push to a repository, via their OAuth token. */
export async function userRepoAccess(
  userToken: string,
  fullName: string,
): Promise<{
  id: number;
  fullName: string;
  defaultBranch: string;
  private: boolean;
  canPush: boolean;
} | null> {
  try {
    const repo = await gh<{
      id: number;
      full_name: string;
      default_branch: string;
      private: boolean;
      permissions?: { admin?: boolean; maintain?: boolean; push?: boolean };
    }>(userToken, `/repos/${fullName}`);
    const p = repo.permissions ?? {};
    return {
      id: repo.id,
      fullName: repo.full_name,
      defaultBranch: repo.default_branch,
      private: repo.private,
      canPush: Boolean(p.admin || p.maintain || p.push),
    };
  } catch (e) {
    if (e instanceof GithubApiError && (e.status === 404 || e.status === 403)) return null;
    throw e;
  }
}

export interface WorkflowRunInfo {
  id: number;
  status: string | null;
  conclusion: string | null;
  display_title?: string;
}

export async function getWorkflowRun(
  token: string,
  fullName: string,
  ghRunId: number,
): Promise<WorkflowRunInfo | null> {
  try {
    return await gh<WorkflowRunInfo>(token, `/repos/${fullName}/actions/runs/${ghRunId}`);
  } catch (e) {
    if (e instanceof GithubApiError && e.status === 404) return null;
    throw e;
  }
}

export async function cancelWorkflowRun(
  token: string,
  fullName: string,
  ghRunId: number,
): Promise<void> {
  await gh<unknown>(token, `/repos/${fullName}/actions/runs/${ghRunId}/cancel`, {
    method: "POST",
    body: {},
  });
}

// ---------------------------------------------------------------------------
// Webhook signature verification (X-Hub-Signature-256)
// ---------------------------------------------------------------------------

/**
 * `crypto.subtle.verify` performs the HMAC comparison internally without an
 * early-exit byte compare, so this is timing-safe.
 */
export async function verifyWebhookSignature(
  secret: string,
  rawBody: ArrayBuffer,
  signatureHeader: string | null,
): Promise<boolean> {
  // Fail closed: an unconfigured secret must reject every webhook, and
  // WebCrypto refuses zero-length HMAC keys anyway.
  if (!secret) return false;
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const sigHex = signatureHeader.slice("sha256=".length);
  if (!/^[0-9a-f]{64}$/i.test(sigHex)) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, hexToBytes(sigHex).buffer as ArrayBuffer, rawBody);
}
