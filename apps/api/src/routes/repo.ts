import { Hono } from "hono";
import { and, eq, notInArray } from "drizzle-orm";
import { createDb, schema } from "@simbox/db";
import type { RepoStatusResponse } from "@simbox/shared";
import type { AppContext } from "../middleware";
import { requireUser } from "../middleware";
import { getLatestActiveRun, getRepoForUser } from "../db";
import { apiError, nowSeconds, randomTokenHex, sha256Hex, toPublicRepo } from "../util";
import {
  cancelWorkflowRun,
  commitWorkflow,
  deleteSimboxTokenSecret,
  deleteWorkflowFile,
  gh,
  GithubApiError,
  installationToken,
  workflowFileExists,
  writeSimboxTokenSecret,
} from "../github";

export const repoRoutes = new Hono<AppContext>();
repoRoutes.use("/v1/installations", requireUser);
repoRoutes.use("/v1/repo/*", requireUser);

// ---------------------------------------------------------------------------
// GET /v1/installations — repos reachable via the user's App installations.
// Uses the user's OAuth token: GET /user/installations only works with
// user-to-server tokens, not installation tokens.
// ---------------------------------------------------------------------------

interface UserInstallationsResponse {
  installations: Array<{ id: number; account: { login: string } | null }>;
}

interface InstallationReposResponse {
  repositories: Array<{
    id: number;
    full_name: string;
    private: boolean;
    default_branch: string;
  }>;
}

repoRoutes.get("/v1/installations", async (c) => {
  const user = c.get("user");
  if (!user.githubAccessToken) {
    return apiError(c, 400, "no_github_token", "Re-login required: missing GitHub token.");
  }
  const installations = await gh<UserInstallationsResponse>(
    user.githubAccessToken,
    "/user/installations?per_page=100",
  );
  const repos: Array<{
    repo_id: number;
    full_name: string;
    private: boolean;
    default_branch: string;
    installation_id: number;
    account_login: string | null;
  }> = [];
  for (const inst of installations.installations) {
    const list = await gh<InstallationReposResponse>(
      user.githubAccessToken,
      `/user/installations/${inst.id}/repositories?per_page=100`,
    );
    for (const r of list.repositories) {
      repos.push({
        repo_id: r.id,
        full_name: r.full_name,
        private: r.private,
        default_branch: r.default_branch,
        installation_id: inst.id,
        account_login: inst.account?.login ?? null,
      });
    }
  }
  return c.json({ installations: repos });
});

// ---------------------------------------------------------------------------
// POST /v1/repo/connect — write secret → commit workflow (PR fallback) → row.
// ---------------------------------------------------------------------------

interface ConnectBody {
  repo_id: number;
  full_name: string;
  private?: boolean;
  default_branch?: string;
  installation_id: number;
}

repoRoutes.post("/v1/repo/connect", async (c) => {
  const user = c.get("user");
  const db = createDb(c.env);
  const body = await c.req.json<ConnectBody>().catch(() => null);
  if (
    !body ||
    typeof body.repo_id !== "number" ||
    !body.full_name ||
    typeof body.installation_id !== "number"
  ) {
    return apiError(c, 400, "bad_request", "Expected {repo_id, full_name, installation_id}.");
  }
  const existing = await getRepoForUser(db, user.id);
  if (existing) {
    return apiError(
      c,
      409,
      "repo_already_connected",
      "Disconnect the current repo before connecting another.",
    );
  }

  const instToken = await installationToken(c.env, body.installation_id);

  // 1. Secret first — a workflow without its secret would fail on first dispatch.
  const simboxToken = randomTokenHex();
  try {
    await writeSimboxTokenSecret(instToken, body.full_name, simboxToken);
  } catch (e) {
    if (e instanceof GithubApiError && (e.status === 404 || e.status === 410 || e.status === 403)) {
      return apiError(
        c,
        400,
        "secret_write_failed",
        "Could not write the repo secret — is the App installed on this repo with secrets:write?",
      );
    }
    throw e;
  }

  // 2. Workflow file → default branch, PR fallback on protected branches.
  let state: "ok" | "pending_pr" = "ok";
  let prUrl: string | null = null;
  try {
    const result = await commitWorkflow(
      c.env,
      instToken,
      body.full_name,
      body.default_branch ?? "main",
    );
    if (result.kind === "pending_pr") {
      state = "pending_pr";
      prUrl = result.prUrl;
    }
  } catch (e) {
    if (e instanceof GithubApiError && (e.status === 404 || e.status === 410)) {
      return apiError(
        c,
        400,
        "actions_unavailable",
        "GitHub Actions is not available on this repo — enable Actions and retry.",
      );
    }
    throw e;
  }

  const now = nowSeconds();
  const accountLogin = body.full_name.split("/")[0] ?? null;
  // Record the installation↔user attribution now (installation webhooks can't
  // reliably attribute which of our users installed the app).
  await db
    .insert(schema.installations)
    .values({
      installation_id: body.installation_id,
      account_login: accountLogin,
      user_id: user.id,
      created_at: now,
    })
    .onConflictDoUpdate({
      target: schema.installations.installation_id,
      set: { account_login: accountLogin, user_id: user.id },
    });

  await db.insert(schema.repos).values({
    user_id: user.id,
    repo_id: body.repo_id,
    full_name: body.full_name,
    private: body.private ? 1 : 0,
    default_branch: body.default_branch ?? "main",
    installation_id: body.installation_id,
    state,
    pr_url: prUrl,
    simbox_token_hash: await sha256Hex(simboxToken),
    created_at: now,
  });

  const repo = await getRepoForUser(db, user.id);
  const resp: RepoStatusResponse = { connected: true, repo: repo ? toPublicRepo(repo) : null };
  return c.json(resp, 201);
});

// ---------------------------------------------------------------------------
// GET /v1/repo/status — lazily promote pending_pr → ok once the workflow file
// has landed on the default branch (i.e. the setup PR was merged).
// ---------------------------------------------------------------------------

repoRoutes.get("/v1/repo/status", async (c) => {
  const user = c.get("user");
  const db = createDb(c.env);
  const repo = await getRepoForUser(db, user.id);
  if (!repo) {
    const resp: RepoStatusResponse = { connected: false, repo: null };
    return c.json(resp);
  }
  if (repo.state === "pending_pr") {
    try {
      const token = await installationToken(c.env, repo.installation_id);
      if (await workflowFileExists(token, repo.full_name, repo.default_branch)) {
        await db
          .update(schema.repos)
          .set({ state: "ok", pr_url: null })
          .where(eq(schema.repos.user_id, user.id));
        repo.state = "ok";
        repo.pr_url = null;
      }
    } catch (e) {
      if (e instanceof GithubApiError && (e.status === 404 || e.status === 401)) {
        // Installation gone → surface as uninstalled rather than erroring.
        await db
          .update(schema.repos)
          .set({ state: "uninstalled" })
          .where(eq(schema.repos.user_id, user.id));
        repo.state = "uninstalled";
      } else {
        throw e;
      }
    }
  }
  const resp: RepoStatusResponse = { connected: true, repo: toPublicRepo(repo) };
  return c.json(resp);
});

// ---------------------------------------------------------------------------
// POST /v1/repo/repair — rotate SIMBOX_TOKEN + re-commit workflow.
// ---------------------------------------------------------------------------

repoRoutes.post("/v1/repo/repair", async (c) => {
  const user = c.get("user");
  const db = createDb(c.env);
  const repo = await getRepoForUser(db, user.id);
  if (!repo) return apiError(c, 404, "no_repo", "No repo connected.");

  let instToken: string;
  try {
    instToken = await installationToken(c.env, repo.installation_id);
    // Verify the installation still exists at all.
    await gh<unknown>(instToken, `/repos/${repo.full_name}`);
  } catch (e) {
    if (e instanceof GithubApiError && (e.status === 404 || e.status === 401 || e.status === 403)) {
      await db
        .update(schema.repos)
        .set({ state: "uninstalled" })
        .where(eq(schema.repos.user_id, user.id));
      return apiError(
        c,
        409,
        "installation_gone",
        "The GitHub App installation was removed — reinstall it, then reconnect.",
      );
    }
    throw e;
  }

  const simboxToken = randomTokenHex();
  await writeSimboxTokenSecret(instToken, repo.full_name, simboxToken);

  let state: "ok" | "pending_pr" = "ok";
  let prUrl: string | null = null;
  const result = await commitWorkflow(c.env, instToken, repo.full_name, repo.default_branch);
  if (result.kind === "pending_pr") {
    state = "pending_pr";
    prUrl = result.prUrl;
  }

  await db
    .update(schema.repos)
    .set({
      state,
      pr_url: prUrl,
      simbox_token_hash: await sha256Hex(simboxToken),
    })
    .where(eq(schema.repos.user_id, user.id));

  const updated = await getRepoForUser(db, user.id);
  const resp: RepoStatusResponse = {
    connected: true,
    repo: updated ? toPublicRepo(updated) : null,
  };
  return c.json(resp);
});

// ---------------------------------------------------------------------------
// POST /v1/repo/disconnect — delete workflow + secret, cancel live run, free slot.
// ---------------------------------------------------------------------------

repoRoutes.post("/v1/repo/disconnect", async (c) => {
  const user = c.get("user");
  const db = createDb(c.env);
  const repo = await getRepoForUser(db, user.id);
  if (!repo) return apiError(c, 404, "no_repo", "No repo connected.");

  // Cancel any active run before the repo row disappears.
  const activeRun = await getLatestActiveRun(db, user.id);

  // Remote cleanup is best-effort: the installation may already be gone.
  try {
    const instToken = await installationToken(c.env, repo.installation_id);
    if (activeRun?.gh_run_id) {
      await cancelWorkflowRun(instToken, repo.full_name, activeRun.gh_run_id).catch(() => {});
    }
    await deleteWorkflowFile(instToken, repo.full_name, repo.default_branch).catch(() => {});
    await deleteSimboxTokenSecret(instToken, repo.full_name).catch(() => {});
  } catch {
    // Swallow — repo row is removed regardless.
  }

  const now = nowSeconds();
  await db
    .update(schema.runs)
    .set({ state: "ended", ended_at: now, end_reason: "repo_disconnected" })
    .where(
      and(eq(schema.runs.user_id, user.id), notInArray(schema.runs.state, ["ended", "failed"])),
    );
  await db.delete(schema.repos).where(eq(schema.repos.user_id, user.id));
  return c.json({ ok: true });
});
