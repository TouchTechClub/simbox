import { Hono } from "hono";
import { and, desc, eq, isNull } from "drizzle-orm";
import { createDb, schema } from "@simbox/db";
import type { Env } from "../env";
import { nowSeconds } from "../util";
import { verifyWebhookSignature } from "../github";
import { mapWorkflowRun } from "./runs";

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
  workflow_run: {
    id: number;
    status: string | null;
    conclusion: string | null;
    path?: string;
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
    if (!wr?.id) return c.json({ ok: true });

    let run = await db.select().from(schema.runs).where(eq(schema.runs.gh_run_id, wr.id)).get();

    if (!run && wr.repository?.full_name) {
      // Bind a dispatching run whose gh_run_id was never resolved by the
      // ensure-time poll (see bindGhRunId).
      const repo = await db
        .select()
        .from(schema.repos)
        .where(eq(schema.repos.full_name, wr.repository.full_name))
        .get();
      if (repo) {
        const unbound = await db
          .select()
          .from(schema.runs)
          .where(
            and(
              eq(schema.runs.user_id, repo.user_id),
              isNull(schema.runs.gh_run_id),
              eq(schema.runs.state, "dispatching"),
            ),
          )
          .orderBy(desc(schema.runs.created_at))
          .limit(1)
          .get();
        if (unbound) {
          await db
            .update(schema.runs)
            .set({ gh_run_id: wr.id })
            .where(and(eq(schema.runs.id, unbound.id), isNull(schema.runs.gh_run_id)));
          run = { ...unbound, gh_run_id: wr.id };
        }
      }
    }

    if (!run) return c.json({ ok: true });

    const next = mapWorkflowRun(wr.status, wr.conclusion, run.state);
    if (next) {
      const terminal = next.state === "ended" || next.state === "failed";
      await db
        .update(schema.runs)
        .set({
          state: next.state,
          end_reason: next.endReason ?? run.end_reason,
          ended_at: terminal ? (run.ended_at ?? now) : run.ended_at,
        })
        .where(eq(schema.runs.id, run.id));
    }
    return c.json({ ok: true });
  }

  return c.json({ ok: true });
});
