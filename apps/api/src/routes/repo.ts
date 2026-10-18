import { Hono } from "hono";
import { and, eq, inArray, ne } from "drizzle-orm";
import { createDb, schema } from "@simbox/db";
import type { RepoStatusResponse } from "@simbox/shared";
import type { AppContext } from "../middleware";
import { requireUser } from "../middleware";
import { getRepoForUser, type RepoRow } from "../db";
import { apiError, nowSeconds, randomTokenHex, sha256Hex, toPublicRepo } from "../util";
import {
  deleteSimboxTokenSecret,
  deleteWorkflowFile,
  gh,
  GithubApiError,
  installationToken,
  userRepoAccess,
  writeSimboxTokenSecret,
} from "../github";
import {
  cancelOnGithub,
  createLifecycle,
  finishRun,
  isInstallationGone,
  locateGithubRun,
  markInstallationGone,
  OPEN_STATES,
  openRuns,
} from "../run-lifecycle";
import { publishWorkflow, refreshWorkflowState, repoSpec } from "../repo-workflow";

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
// POST /v1/repo/connect — verify access → commit workflow → secret → row.
//
// The client only names the repository; everything stored comes from GitHub.
// The user must be able to push to it (their OAuth token says so) and the
// App installation must cover it, so nobody can point Simbox at a repo they
// don't control.
// ---------------------------------------------------------------------------

interface ConnectBody {
  repo_id: number;
  full_name: string;
  installation_id: number;
}

interface InstallationRepo {
  id: number;
  full_name: string;
  default_branch: string;
  private: boolean;
}

repoRoutes.post("/v1/repo/connect", async (c) => {
  const user = c.get("user");
  const db = createDb(c.env);
  const body = await c.req.json<ConnectBody>().catch(() => null);
  if (
    !body ||
    typeof body.repo_id !== "number" ||
    typeof body.full_name !== "string" ||
    !/^[\w.-]+\/[\w.-]+$/.test(body.full_name) ||
    typeof body.installation_id !== "number"
  ) {
    return apiError(c, 400, "bad_request", "Expected {repo_id, full_name, installation_id}.");
  }
  if (await getRepoForUser(db, user.id)) {
    return apiError(
      c,
      409,
      "repo_already_connected",
      "Disconnect the current repo before connecting another.",
    );
  }
  if (!user.githubAccessToken)
    return apiError(c, 400, "no_github_token", "Re-login required: missing GitHub token.");

  const access = await userRepoAccess(user.githubAccessToken, body.full_name);
  if (!access || access.id !== body.repo_id)
    return apiError(c, 404, "repo_not_found", "You don't have access to that repository.");
  if (!access.canPush)
    return apiError(
      c,
      403,
      "repo_forbidden",
      "You need push access to a repository to connect it to Simbox.",
    );

  const taken = await db
    .select({ user_id: schema.repos.user_id })
    .from(schema.repos)
    .where(and(eq(schema.repos.repo_id, access.id), ne(schema.repos.user_id, user.id)))
    .get();
  if (taken)
    return apiError(
      c,
      409,
      "repo_in_use",
      "Another Simbox account already uses this repository. Its runner token is per account; disconnect it there first.",
    );

  let instToken: string;
  let ghRepo: InstallationRepo;
  try {
    instToken = await installationToken(c.env, body.installation_id);
    ghRepo = await gh<InstallationRepo>(instToken, `/repositories/${access.id}`);
    // Public repositories are readable by any installation; only one that
    // covers the repository can read its Actions secrets key.
    await gh(instToken, `/repos/${ghRepo.full_name}/actions/secrets/public-key`);
  } catch (e) {
    if (e instanceof GithubApiError && (e.status === 404 || e.status === 403))
      return apiError(
        c,
        400,
        "not_installed",
        "The Simbox GitHub App is not installed on that repository.",
      );
    throw e;
  }
  const target = { full_name: ghRepo.full_name, default_branch: ghRepo.default_branch };

  // 1. Workflow → default branch (PR fallback on protected branches). First,
  //    so a failure here leaves no secret behind; a retry is idempotent.
  let workflow;
  try {
    workflow = await publishWorkflow(instToken, target, repoSpec({ workflow: null }));
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

  // 2. SIMBOX_TOKEN secret.
  const simboxToken = randomTokenHex();
  try {
    await writeSimboxTokenSecret(instToken, target.full_name, simboxToken);
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

  const now = nowSeconds();
  const accountLogin = target.full_name.split("/")[0] ?? null;
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
    repo_id: ghRepo.id,
    full_name: target.full_name,
    private: ghRepo.private ? 1 : 0,
    default_branch: target.default_branch,
    installation_id: body.installation_id,
    state: workflow.state,
    pr_url: workflow.pr_url,
    workflow_version: workflow.workflow_version,
    simbox_token_hash: await sha256Hex(simboxToken),
    created_at: now,
  });

  const repo = await getRepoForUser(db, user.id);
  const resp: RepoStatusResponse = { connected: true, repo: repo ? toPublicRepo(repo) : null };
  return c.json(resp, 201);
});

// ---------------------------------------------------------------------------
// GET /v1/repo/status — lazily pick up a merged setup PR.
// ---------------------------------------------------------------------------

repoRoutes.get("/v1/repo/status", async (c) => {
  const user = c.get("user");
  const db = createDb(c.env);
  let repo = await getRepoForUser(db, user.id);
  if (!repo) return c.json({ connected: false, repo: null } satisfies RepoStatusResponse);
  // Dashboards poll this; check GitHub at most once a minute per repo.
  const throttleKey = `repo_status_check:${repo.repo_id}`;
  if ((repo.state === "pending_pr" || repo.pr_url) && !(await c.env.KV.get(throttleKey))) {
    await c.env.KV.put(throttleKey, "1", { expirationTtl: 60 });
    try {
      const token = await installationToken(c.env, repo.installation_id);
      repo = (await refreshWorkflowState(db, token, repo)).repo;
    } catch (e) {
      if (isInstallationGone(e)) {
        await markInstallationGone(db, repo.installation_id);
        repo = { ...repo, state: "uninstalled" };
      } else if (!(e instanceof GithubApiError)) {
        throw e;
      }
      // Other GitHub errors: report the stored state; the next poll retries.
    }
  }
  return c.json({ connected: true, repo: toPublicRepo(repo) } satisfies RepoStatusResponse);
});

// ---------------------------------------------------------------------------
// POST /v1/repo/repair — re-commit the stored workflow and, when no run is
// using it, rotate SIMBOX_TOKEN. Also picks up renames and branch changes.
// ---------------------------------------------------------------------------

repoRoutes.post("/v1/repo/repair", async (c) => {
  const user = c.get("user");
  const db = createDb(c.env);
  const repo = await getRepoForUser(db, user.id);
  if (!repo) return apiError(c, 404, "no_repo", "No repo connected.");

  let instToken: string;
  let ghRepo: InstallationRepo;
  try {
    instToken = await installationToken(c.env, repo.installation_id);
    ghRepo = await gh<InstallationRepo>(instToken, `/repositories/${repo.repo_id}`);
  } catch (e) {
    if (isInstallationGone(e) || (e instanceof GithubApiError && e.status === 401)) {
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
  const target = { full_name: ghRepo.full_name, default_branch: ghRepo.default_branch };

  // Workflow first: if it fails, the existing token keeps working.
  const workflow = await publishWorkflow(instToken, target, repoSpec(repo));

  // Rotating the secret would break the agent of a run already in flight.
  const busy = (await openRuns(db, user.id)).length > 0;
  let tokenHash = repo.simbox_token_hash;
  if (!busy) {
    const simboxToken = randomTokenHex();
    await writeSimboxTokenSecret(instToken, target.full_name, simboxToken);
    tokenHash = await sha256Hex(simboxToken);
  }

  await db
    .update(schema.repos)
    .set({
      ...target,
      private: ghRepo.private ? 1 : 0,
      state: workflow.state,
      pr_url: workflow.pr_url,
      workflow_version: workflow.workflow_version,
      simbox_token_hash: tokenHash,
    })
    .where(eq(schema.repos.user_id, user.id));
  if (target.full_name !== repo.full_name) {
    // A renamed repository: in-flight runs' GitHub calls follow the new name.
    await db
      .update(schema.runs)
      .set({ repo_full_name: target.full_name })
      .where(and(eq(schema.runs.user_id, user.id), inArray(schema.runs.state, [...OPEN_STATES])));
  }

  const updated = await getRepoForUser(db, user.id);
  const resp: RepoStatusResponse = {
    connected: true,
    repo: updated ? toPublicRepo(updated) : null,
  };
  return c.json(resp);
});

// ---------------------------------------------------------------------------
// POST /v1/repo/disconnect — cancel every run, delete workflow + secret.
// ---------------------------------------------------------------------------

repoRoutes.post("/v1/repo/disconnect", async (c) => {
  const user = c.get("user");
  const db = createDb(c.env);
  const repo = await getRepoForUser(db, user.id);
  if (!repo) return apiError(c, 404, "no_repo", "No repo connected.");

  const ctx = createLifecycle(c.env, (work) => c.executionCtx.waitUntil(work), repo);
  for (const open of await openRuns(db, user.id)) {
    const run = await locateGithubRun(ctx, open, repo);
    if (run.gh_run_id) await cancelOnGithub(ctx, repo, run.gh_run_id).catch(() => {});
    await finishRun(ctx, run, "ended", "repo_disconnected");
  }

  // Remote cleanup is best-effort: the installation may already be gone.
  await removeFromGithub(c.env, repo).catch(() => {});
  await db.delete(schema.repos).where(eq(schema.repos.user_id, user.id));
  return c.json({ ok: true });
});

async function removeFromGithub(env: AppContext["Bindings"], repo: RepoRow): Promise<void> {
  const token = await installationToken(env, repo.installation_id);
  await deleteWorkflowFile(token, repo.full_name, repo.default_branch).catch(() => {});
  await deleteSimboxTokenSecret(token, repo.full_name).catch(() => {});
}
