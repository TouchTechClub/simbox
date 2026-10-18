import { Hono, type Context } from "hono";
import { eq } from "drizzle-orm";
import { createDb, schema } from "@simbox/db";
import {
  defaultWorkflowSpec,
  renderWorkflow,
  validateWorkflowSpec,
  workflowStatus,
  type WorkflowResponse,
  type WorkflowSpec,
  type WorkflowStatus,
} from "@simbox/shared";
import { requireUser, type AppContext } from "../middleware";
import { apiError } from "../util";
import { getRepoForUser, type RepoRow } from "../db";
import { GithubApiError, installationToken, readWorkflowFile, userRepoAccess } from "../github";
import { publishWorkflow, repoSpec } from "../repo-workflow";

export const workflowRoutes = new Hono<AppContext>();
workflowRoutes.use("/v1/workflow", requireUser);

function respond(
  c: Context<AppContext>,
  repo: RepoRow,
  spec: WorkflowSpec,
  status: WorkflowStatus | null,
) {
  return c.json({
    spec,
    yaml: renderWorkflow(spec),
    status,
    repoState: repo.state,
    prUrl: repo.pr_url,
  } satisfies WorkflowResponse);
}

// GET /v1/workflow — the stored spec, its rendering, and how the default
// branch compares.
workflowRoutes.get("/v1/workflow", async (c) => {
  const db = createDb(c.env);
  const repo = await getRepoForUser(db, c.get("user").id);
  if (!repo) return apiError(c, 404, "no_repo", "Connect a repository first.");
  const spec = repoSpec(repo);
  let status: WorkflowStatus | null = null;
  try {
    const token = await installationToken(c.env, repo.installation_id);
    status = workflowStatus(
      await readWorkflowFile(token, repo.full_name, repo.default_branch),
      spec,
    );
  } catch (error) {
    if (!(error instanceof GithubApiError)) throw error;
  }
  return respond(c, repo, spec, status);
});

// PUT /v1/workflow {spec} — validate, commit (or open a PR), store. Locked
// Simbox steps must stay present and in order; validateWorkflowSpec enforces it.
workflowRoutes.put("/v1/workflow", async (c) => {
  const user = c.get("user");
  const db = createDb(c.env);
  const repo = await getRepoForUser(db, user.id);
  if (!repo) return apiError(c, 404, "no_repo", "Connect a repository first.");
  const body = await c.req.json<{ spec?: unknown }>().catch(() => null);
  let spec: WorkflowSpec;
  try {
    spec = validateWorkflowSpec(body?.spec);
  } catch (error) {
    return apiError(c, 400, "invalid_workflow", (error as Error).message);
  }

  // Workflow steps run with the repo's secrets: only people who could commit
  // the file themselves may change it through Simbox.
  if (!user.githubAccessToken)
    return apiError(c, 403, "no_github_token", "Re-login required: missing GitHub token.");
  const access = await userRepoAccess(user.githubAccessToken, repo.full_name).catch(() => null);
  if (!access?.canPush)
    return apiError(
      c,
      403,
      "repo_forbidden",
      `You need push access to ${repo.full_name} to change its workflow.`,
    );

  const token = await installationToken(c.env, repo.installation_id);
  const result = await publishWorkflow(token, repo, spec);
  const isDefault = renderWorkflow(spec) === renderWorkflow(defaultWorkflowSpec());
  const next = {
    workflow: isDefault ? null : spec,
    state: repo.state === "pending_pr" || repo.state === "ok" ? result.state : repo.state,
    pr_url: result.pr_url,
    workflow_version: result.workflow_version,
  };
  await db.update(schema.repos).set(next).where(eq(schema.repos.user_id, user.id));
  return respond(c, { ...repo, ...next }, spec, result.status);
});
