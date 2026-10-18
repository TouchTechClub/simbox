/**
 * The connected repository's workflow file: render the stored spec, commit it
 * (or open a PR on a protected branch), and fold what is actually on the
 * default branch back into the repo row.
 *
 * `repos.state` answers "can Simbox dispatch?" — it is `pending_pr` only while
 * the default branch has no workflow at all. An edit waiting in a PR keeps the
 * repo `ok` (the committed workflow still runs) and records `pr_url`.
 * `workflow_version` is the schema version on the default branch.
 */
import { eq } from "drizzle-orm";
import { schema, type Database } from "@simbox/db";
import {
  defaultWorkflowSpec,
  renderWorkflow,
  WORKFLOW_SCHEMA_VERSION,
  workflowStatus,
  workflowVersion,
  type RepoState,
  type WorkflowSpec,
  type WorkflowStatus,
} from "@simbox/shared";
import type { RepoRow } from "./db";
import { commitWorkflow, readWorkflowFile } from "./github";

export interface WorkflowState {
  state: Extract<RepoState, "ok" | "pending_pr">;
  pr_url: string | null;
  workflow_version: number;
  /** Default branch vs. the spec, after this change. */
  status: WorkflowStatus;
}

export function repoSpec(repo: Pick<RepoRow, "workflow">): WorkflowSpec {
  return repo.workflow ?? defaultWorkflowSpec();
}

/** Commit `spec` to the repo's default branch, falling back to a setup PR. */
export async function publishWorkflow(
  token: string,
  repo: Pick<RepoRow, "full_name" | "default_branch">,
  spec: WorkflowSpec,
): Promise<WorkflowState> {
  const before = await readWorkflowFile(token, repo.full_name, repo.default_branch);
  const result = await commitWorkflow(
    token,
    repo.full_name,
    repo.default_branch,
    renderWorkflow(spec),
  );
  if (result.kind === "committed")
    return {
      state: "ok",
      pr_url: null,
      workflow_version: WORKFLOW_SCHEMA_VERSION,
      status: "current",
    };
  return {
    state: before === null ? "pending_pr" : "ok",
    pr_url: result.prUrl,
    workflow_version: before === null ? 1 : workflowVersion(before),
    status: workflowStatus(before, spec),
  };
}

/** Re-read the default branch, e.g. after the user merged the setup PR. */
export async function refreshWorkflowState(
  db: Database,
  token: string,
  repo: RepoRow,
): Promise<{ repo: RepoRow; status: WorkflowStatus }> {
  const committed = await readWorkflowFile(token, repo.full_name, repo.default_branch);
  const status = workflowStatus(committed, repoSpec(repo));
  const next: Partial<RepoRow> = {};
  if (committed !== null) {
    if (repo.state === "pending_pr") next.state = "ok";
    const version = workflowVersion(committed);
    if (version !== repo.workflow_version) next.workflow_version = version;
    if (repo.pr_url && status === "current") next.pr_url = null;
  }
  if (Object.keys(next).length === 0) return { repo, status };
  await db.update(schema.repos).set(next).where(eq(schema.repos.user_id, repo.user_id));
  return { repo: { ...repo, ...next }, status };
}
