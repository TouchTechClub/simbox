import { Hono } from "hono";
import { and, eq, gte, inArray, isNull } from "drizzle-orm";
import { createDb, schema } from "@simbox/db";
import { WORKFLOW_PATH } from "@simbox/shared";
import type { Env } from "../env";
import { nowSeconds } from "../util";
import { verifyWebhookSignature } from "../github";
import {
  bindGithubRun,
  createLifecycle,
  finishRun,
  isTerminal,
  mapWorkflowRun,
  runIdFromTitle,
  setRunState,
} from "../run-lifecycle";

export const webhookRoutes = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// POST /webhooks/github — X-Hub-Signature-256 verified against the raw body.
// ---------------------------------------------------------------------------

interface InstallationPayload {
  action: string;
  installation: {
    id: number;
    account?: { login?: string } | null;
    suspended_at?: string | null;
  };
}

interface InstallationReposPayload {
  action: string;
  installation: { id: number };
  repositories_removed?: Array<{ full_name?: string }>;
}

interface WorkflowRunPayload {
  action: string;
  installation?: { id?: number };
  repository?: { full_name?: string };
  workflow_run: {
    id: number;
    status: string | null;
    conclusion: string | null;
    event?: string;
    path?: string;
    display_title?: string;
    created_at?: string;
    repository?: { full_name?: string };
  };
}

webhookRoutes.post("/webhooks/github", async (c) => {
  const raw = await c.req.arrayBuffer();
  const ok = await verifyWebhookSignature(
    c.env.GITHUB_WEBHOOK_SECRET,
    raw,
    c.req.header("X-Hub-Signature-256") ?? null,
  );
  if (!ok) {
    return c.json({ error: "bad_signature" }, 401);
  }

  const event = c.req.header("X-GitHub-Event") ?? "";
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return c.json({ error: "bad_json" }, 400);
  }

  const now = nowSeconds();
  const db = createDb(c.env);

  if (event === "installation") {
    const p = payload as InstallationPayload;
    const installationId = p.installation?.id;
    if (!installationId) return c.json({ ok: true });

    if (p.action === "created") {
      // Record the installation; user attribution happens at repo/connect
      // (the webhook can't know which of our users clicked install).
      await db
        .insert(schema.installations)
        .values({
          installation_id: installationId,
          account_login: p.installation.account?.login ?? null,
          user_id: null,
          created_at: now,
        })
        .onConflictDoUpdate({
          target: schema.installations.installation_id,
          set: { account_login: p.installation.account?.login ?? null },
        });
    } else if (p.action === "deleted" || p.action === "suspend") {
      await db
        .update(schema.repos)
        .set({ state: "uninstalled" })
        .where(eq(schema.repos.installation_id, installationId));
    } else if (p.action === "unsuspend") {
      await db
        .update(schema.repos)
        .set({ state: "needs_repair" })
        .where(
          and(
            eq(schema.repos.installation_id, installationId),
            eq(schema.repos.state, "uninstalled"),
          ),
        );
    }
    return c.json({ ok: true });
  }

  if (event === "installation_repositories") {
    const p = payload as InstallationReposPayload;
    if (p.action === "removed" && p.repositories_removed?.length) {
      // If the connected repo was removed from the installation, the repo
      // needs repair (plan §11 — covers renames/transfers too).
      const removed = p.repositories_removed
        .map((r) => r.full_name)
        .filter((n): n is string => typeof n === "string");
      for (const fullName of removed) {
        await db
          .update(schema.repos)
          .set({ state: "needs_repair" })
          .where(
            and(
              eq(schema.repos.full_name, fullName),
              eq(schema.repos.installation_id, p.installation.id),
            ),
          );
      }
    }
    return c.json({ ok: true });
  }

  if (event === "workflow_run") {
    const p = payload as WorkflowRunPayload;
    const wr = p.workflow_run;
    const fullName = p.repository?.full_name ?? wr?.repository?.full_name;
    // Only Simbox's own dispatches: other workflows in the repo never touch runs.
    if (!wr?.id || !fullName || wr.event !== "workflow_dispatch") return c.json({ ok: true });
    if (wr.path && wr.path !== WORKFLOW_PATH) return c.json({ ok: true });

    const repo = await db
      .select()
      .from(schema.repos)
      .where(eq(schema.repos.full_name, fullName))
      .get();
    if (!repo || (p.installation?.id && p.installation.id !== repo.installation_id))
      return c.json({ ok: true });
    const ctx = createLifecycle(c.env, (work) => c.executionCtx.waitUntil(work), repo);

    let run = await db
      .select()
      .from(schema.runs)
      .where(and(eq(schema.runs.gh_run_id, wr.id), eq(schema.runs.repo_full_name, fullName)))
      .get();

    if (!run) {
      const runId = runIdFromTitle(wr.display_title);
      if (runId) {
        const candidate = await db
          .select()
          .from(schema.runs)
          .where(and(eq(schema.runs.id, runId), eq(schema.runs.repo_full_name, fullName)))
          .get();
        if (candidate) run = (await bindGithubRun(ctx, candidate, repo, wr.id)) ?? undefined;
      } else if (repo.workflow_version < 2) {
        // Legacy workflow (no run id in its title): bind only an unambiguous
        // unbound run dispatched shortly before this one was created.
        const createdAt = wr.created_at ? Math.floor(Date.parse(wr.created_at) / 1000) : now;
        const unbound = await db
          .select()
          .from(schema.runs)
          .where(
            and(
              eq(schema.runs.repo_full_name, fullName),
              isNull(schema.runs.gh_run_id),
              inArray(schema.runs.state, ["dispatching", "queued", "closing"]),
              gte(schema.runs.created_at, createdAt - 600),
            ),
          )
          .limit(2)
          .all();
        if (unbound.length === 1)
          run = (await bindGithubRun(ctx, unbound[0]!, repo, wr.id)) ?? undefined;
      }
    }

    if (!run || isTerminal(run.state)) return c.json({ ok: true });
    const next = mapWorkflowRun(wr.status, wr.conclusion, run.state);
    if (next && isTerminal(next.state))
      await finishRun(ctx, run, next.state as "ended" | "failed", next.endReason!);
    else if (next) await setRunState(db, run, next);
    return c.json({ ok: true });
  }

  return c.json({ ok: true });
});
