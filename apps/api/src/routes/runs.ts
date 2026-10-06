import { Hono } from "hono";
import { and, desc, eq, isNull, notInArray } from "drizzle-orm";
import { createDb, schema } from "@simbox/db";
import type { Database } from "@simbox/db";
import type {
  EnsureRunRequest,
  EnsureRunResponse,
  RunHeartbeatRequest,
  RunRegisterRequest,
  RunState,
} from "@simbox/shared";
import {
  HARD_EXIT_MINUTES,
  MAX_DEVICES_PER_RUN,
  resolveRunner,
  validateRunner,
  sameRunner,
} from "@simbox/shared";
import type { AppContext } from "../middleware";
import type { Env } from "../env";
import { requireRunnerToken, requireUser } from "../middleware";
import type { RepoRow, RunRow } from "../db";
import { getLatestActiveRun, getRepoForUser, isTerminal } from "../db";
import { apiError, newId, nowSeconds, toPublicRun, toRunSummary } from "../util";
import { getRunnerSettings } from "../runners";
import {
  bindGhRunId,
  cancelWorkflowRun,
  dispatchWorkflow,
  getWorkflowRun,
  GithubApiError,
  installationToken,
} from "../github";

export const runRoutes = new Hono<AppContext>();

// ---------------------------------------------------------------------------
// Lazy reconciliation
//
// The schema has no heartbeat timestamp column (locked in the plan), so stale
// detection is time-based: `expires_at` marks the hard-exit horizon, and runs
// that sit too long in early states get reconciled by asking GitHub for the
// real workflow_run status. The `gh_check:{run_id}` KV key throttles those
// API calls to at most once per 20s per run. The workflow_run webhook remains
// the primary update path (plan §11).
// ---------------------------------------------------------------------------

const DISPATCH_BIND_GRACE_SECONDS = 600; // unbound run older than this → failed
// Cloudflare KV enforces expirationTtl >= 60.
const GH_CHECK_THROTTLE_SECONDS = 60;

export function mapWorkflowRun(
  status: string | null,
  conclusion: string | null,
  current: RunState,
): { state: RunState; endReason: string | null } | null {
  if (status === "queued" || status === "waiting" || status === "pending") {
    return current === "dispatching" || current === "queued"
      ? { state: "queued", endReason: null }
      : null;
  }
  if (status === "in_progress" || status === "requested") {
    return current === "dispatching" || current === "queued" || current === "booting"
      ? { state: "booting", endReason: null }
      : null;
  }
  if (status === "completed") {
    if (isTerminal(current)) return null;
    if (conclusion === "success") return { state: "ended", endReason: "completed" };
    if (conclusion === "cancelled") return { state: "ended", endReason: "cancelled" };
    return { state: "failed", endReason: conclusion ?? "unknown" };
  }
  return null;
}

async function applyRunTransition(
  db: Database,
  run: RunRow,
  next: { state: RunState; endReason: string | null },
): Promise<RunRow> {
  const now = nowSeconds();
  const terminal = isTerminal(next.state);
  await db
    .update(schema.runs)
    .set({
      state: next.state,
      end_reason: next.endReason ?? run.end_reason,
      ended_at: terminal ? (run.ended_at ?? now) : run.ended_at,
    })
    .where(eq(schema.runs.id, run.id));
  return {
    ...run,
    state: next.state,
    end_reason: next.endReason ?? run.end_reason,
    ended_at: terminal ? (run.ended_at ?? now) : run.ended_at,
  };
}

/**
 * Ask GitHub about a run whose local state looks stale, and fold the result
 * back into the runs row. Throttled via KV so hot endpoints don't hammer the
 * GitHub API.
 */
export async function reconcileRun(
  env: Pick<Env, "DB" | "KV">,
  run: RunRow,
  repo: RepoRow | null,
  instToken: string | null,
): Promise<RunRow> {
  const db = createDb(env);
  if (isTerminal(run.state) || !repo) return run;
  const now = nowSeconds();

  // Past the hard-exit horizon → treat as ended regardless of what GH says.
  if (run.expires_at !== null && run.expires_at < now) {
    return applyRunTransition(db, run, { state: "ended", endReason: "expired" });
  }

  // Dispatching with no gh_run_id: retry binding briefly, then give up.
  if (run.state === "dispatching" && run.gh_run_id === null) {
    if (run.created_at + DISPATCH_BIND_GRACE_SECONDS < now) {
      return applyRunTransition(db, run, { state: "failed", endReason: "run_never_appeared" });
    }
    if (!instToken) return run;
    const throttleKey = `gh_check:${run.id}`;
    if (await env.KV.get(throttleKey)) return run;
    await env.KV.put(throttleKey, "1", { expirationTtl: GH_CHECK_THROTTLE_SECONDS });
    const bound = await bindGhRunId(instToken, repo.full_name, run.created_at, 1).catch(() => null);
    if (bound) {
      await db
        .update(schema.runs)
        .set({ gh_run_id: bound, state: "queued" })
        .where(and(eq(schema.runs.id, run.id), isNull(schema.runs.gh_run_id)));
      return { ...run, gh_run_id: bound, state: "queued" };
    }
    return run;
  }

  if (!run.gh_run_id || !instToken) return run;

  // Only poll GH for runs that look stale — a run stuck in dispatching/queued/
  // booting for >90s, or a closing run that hasn't resolved.
  const staleEarly =
    (run.state === "dispatching" || run.state === "queued" || run.state === "booting") &&
    run.created_at + 90 < now;
  const staleClosing = run.state === "closing";
  const suspiciousLive =
    run.state === "live" && run.live_at !== null && run.live_at + HARD_EXIT_MINUTES * 60 < now;
  if (!staleEarly && !staleClosing && !suspiciousLive) return run;

  const throttleKey = `gh_check:${run.id}`;
  if (await env.KV.get(throttleKey)) return run;
  await env.KV.put(throttleKey, "1", { expirationTtl: GH_CHECK_THROTTLE_SECONDS });

  const info = await getWorkflowRun(instToken, repo.full_name, run.gh_run_id).catch(() => null);
  if (!info) {
    // Run vanished from GitHub entirely → almost certainly dead.
    return applyRunTransition(db, run, { state: "failed", endReason: "run_not_found" });
  }
  const next = mapWorkflowRun(info.status, info.conclusion, run.state);
  return next ? applyRunTransition(db, run, next) : run;
}

// ---------------------------------------------------------------------------
// POST /v1/runs/ensure — the heart of the run state machine.
// ---------------------------------------------------------------------------

runRoutes.post("/v1/runs/ensure", requireUser, async (c) => {
  const user = c.get("user");
  const db = createDb(c.env);
  const body = await c.req.json<EnsureRunRequest>().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body))
    return apiError(c, 400, "bad_request", "Expected a run request object.");
  const wantNew = body.new === true;
  if (body.platform !== undefined && body.platform !== "ios" && body.platform !== "android") {
    return apiError(c, 400, "invalid_platform", "platform must be ios or android.");
  }
  const platform = body.platform ?? "ios";
  if (body.runner !== undefined && !body.platform)
    return apiError(c, 400, "invalid_runner", "Specify platform when overriding a runner.");
  let override;
  try {
    override = body.runner === undefined ? undefined : validateRunner(body.runner, platform);
  } catch (err) {
    return apiError(c, 400, "invalid_runner", (err as Error).message);
  }

  const repo = await getRepoForUser(db, user.id);
  if (!repo) return apiError(c, 404, "no_repo", "Connect a repo first (dashboard onboarding).");
  if (repo.state !== "ok") {
    return apiError(
      c,
      409,
      "repo_not_ready",
      `Repo state is "${repo.state}" — finish setup or run repair.`,
    );
  }

  const instToken = await installationToken(c.env, repo.installation_id);

  let active = await getLatestActiveRun(db, user.id);
  if (active) active = await reconcileRun(c.env, active, repo, instToken);

  if (active && !isTerminal(active.state)) {
    if (!wantNew) {
      if (body.platform && body.platform !== active.platform) {
        return apiError(
          c,
          409,
          "platform_mismatch",
          "The active run uses a different platform. Use `simbox sim --new --platform android` (or ios) to replace it.",
        );
      }
      if (override && !sameRunner(active.runner, override)) {
        return apiError(
          c,
          409,
          "runner_mismatch",
          "The active run uses a different runner. Use `simbox sim --new --platform <platform> --runner <label>` to replace it.",
        );
      }
      if (active.state === "live") {
        if (active.active_devices >= MAX_DEVICES_PER_RUN) {
          return c.json(
            {
              error: "at_capacity",
              message: `Run already has ${active.active_devices} devices (cap ${MAX_DEVICES_PER_RUN}).`,
              hint: "use --new",
            },
            409,
          );
        }
        const resp: EnsureRunResponse = {
          state: "live",
          runId: active.id,
          ghRunId: active.gh_run_id ?? 0,
          tunnelUrl: active.tunnel_url ?? "",
          daemonToken: active.daemon_token ?? "",
          expiresAt: (active.expires_at ?? 0) * 1000,
        };
        return c.json(resp);
      }
      if (active.state === "closing") {
        // Treat closing as occupied until the webhook/poll resolves it —
        // dispatching a second run would fight the shutdown.
        const resp: EnsureRunResponse = { state: "booting", runId: active.id };
        return c.json(resp);
      }
      const resp: EnsureRunResponse = {
        state: active.state as "dispatching" | "queued" | "booting",
        runId: active.id,
      };
      return c.json(resp);
    }
    // wantNew → mark the old run for shutdown and dispatch fresh.
    if (active.gh_run_id) {
      c.executionCtx.waitUntil(
        cancelWorkflowRun(instToken, repo.full_name, active.gh_run_id).catch(() => {}),
      );
    }
    await db
      .update(schema.runs)
      .set({ state: "closing" })
      .where(
        and(eq(schema.runs.id, active.id), notInArray(schema.runs.state, ["ended", "failed"])),
      );
  }

  const settings = await getRunnerSettings(db, user.id);
  const { runner } = resolveRunner(platform, settings.account, settings.repository, override);

  // Idempotency: two CLIs racing `ensure` — the loser sees the lock and
  // reports "dispatching" rather than double-dispatching.
  const lockKey = `ensure_lock:${user.id}`;
  if (await c.env.KV.get(lockKey)) {
    const resp: EnsureRunResponse = { state: "dispatching", runId: active?.id ?? "" };
    return c.json(resp);
  }
  await c.env.KV.put(lockKey, "1", { expirationTtl: 60 });

  try {
    const now = nowSeconds();
    try {
      await dispatchWorkflow(instToken, repo.full_name, repo.default_branch, platform, runner);
    } catch (e) {
      if (e instanceof GithubApiError && e.status === 422) {
        return apiError(
          c,
          409,
          "workflow_needs_repair",
          "Run `simbox repair` to install the runner-aware workflow (merge its PR if needed), then retry. Simbox will not fall back to another runner.",
        );
      }
      if (e instanceof GithubApiError && (e.status === 404 || e.status === 410)) {
        // Actions disabled or workflow file missing → needs_repair (plan §11).
        await db
          .update(schema.repos)
          .set({ state: "needs_repair" })
          .where(eq(schema.repos.user_id, user.id));
        return apiError(
          c,
          409,
          "dispatch_failed",
          "Could not dispatch the workflow — run `simbox repair`.",
        );
      }
      throw e;
    }

    // workflow_dispatch returns 204 — bind the real run id by polling.
    const ghRunId = await bindGhRunId(instToken, repo.full_name, now).catch(() => null);

    const runId = newId();
    await db.insert(schema.runs).values({
      id: runId,
      user_id: user.id,
      repo_full_name: repo.full_name,
      gh_run_id: ghRunId,
      state: ghRunId ? "queued" : "dispatching",
      platform,
      runner,
      created_at: now,
      dispatched_at: now,
      expires_at: now + HARD_EXIT_MINUTES * 60,
    });

    const resp: EnsureRunResponse = ghRunId
      ? { state: "queued", runId }
      : { state: "dispatching", runId };
    return c.json(resp);
  } finally {
    // Release via waitUntil so the response isn't held by KV latency.
    c.executionCtx.waitUntil(c.env.KV.delete(lockKey));
  }
});

// ---------------------------------------------------------------------------
// GET /v1/runs/current — latest non-terminal run (reconciled).
// ---------------------------------------------------------------------------

runRoutes.get("/v1/runs/current", requireUser, async (c) => {
  const user = c.get("user");
  const db = createDb(c.env);
  const repo = await getRepoForUser(db, user.id);
  let run = await getLatestActiveRun(db, user.id);
  if (run && repo) {
    // Reconciliation may need an installation token; fetch lazily only when
    // the run looks stale to avoid paying the JWT+KV cost on every poll.
    const now = nowSeconds();
    const looksStale =
      (run.expires_at !== null && run.expires_at < now) ||
      (run.state === "dispatching" && run.created_at + 90 < now) ||
      ((run.state === "queued" || run.state === "booting") && run.created_at + 90 < now) ||
      run.state === "closing" ||
      (run.state === "live" && run.live_at !== null && run.live_at + HARD_EXIT_MINUTES * 60 < now);
    if (looksStale) {
      const instToken = await installationToken(c.env, repo.installation_id).catch(() => null);
      run = await reconcileRun(c.env, run, repo, instToken);
    }
  }
  if (!run || isTerminal(run.state)) return c.json({ run: null });
  return c.json({ run: toPublicRun(run) });
});

// ---------------------------------------------------------------------------
// GET /v1/runs — history (no secrets).
// ---------------------------------------------------------------------------

runRoutes.get("/v1/runs", requireUser, async (c) => {
  const user = c.get("user");
  const db = createDb(c.env);
  const results = await db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.user_id, user.id))
    .orderBy(desc(schema.runs.created_at))
    .limit(20);
  return c.json({ runs: results.map(toRunSummary) });
});

// ---------------------------------------------------------------------------
// POST /v1/runs/:id/stop — cancel via GitHub, then wait for webhook to end it.
// ---------------------------------------------------------------------------

runRoutes.post("/v1/runs/:id/stop", requireUser, async (c) => {
  const user = c.get("user");
  const db = createDb(c.env);
  const runId = c.req.param("id");
  let run = await db.select().from(schema.runs).where(eq(schema.runs.id, runId)).get();
  // Ownership check: a run id is an unguessable uuid, but still scope to user.
  if (!run || run.user_id !== user.id) {
    return apiError(c, 404, "not_found", "Run not found.");
  }
  if (isTerminal(run.state)) return c.json({ run: toPublicRun(run) });

  const repo = await getRepoForUser(db, user.id);
  const now = nowSeconds();
  if (run.gh_run_id && repo) {
    try {
      const instToken = await installationToken(c.env, repo.installation_id);
      await cancelWorkflowRun(instToken, repo.full_name, run.gh_run_id);
      await db.update(schema.runs).set({ state: "closing" }).where(eq(schema.runs.id, run.id));
      run = { ...run, state: "closing" };
    } catch (e) {
      if (e instanceof GithubApiError && e.status === 404) {
        // Already gone on GitHub — close it locally.
        await db
          .update(schema.runs)
          .set({ state: "ended", ended_at: now, end_reason: "cancelled" })
          .where(eq(schema.runs.id, run.id));
        run = { ...run, state: "ended", ended_at: now, end_reason: "cancelled" };
      } else {
        throw e;
      }
    }
  } else {
    // Never bound to a GH run → nothing to cancel remotely.
    await db
      .update(schema.runs)
      .set({ state: "ended", ended_at: now, end_reason: "stopped" })
      .where(eq(schema.runs.id, run.id));
    run = { ...run, state: "ended", ended_at: now, end_reason: "stopped" };
  }
  return c.json({ run: toPublicRun(run) });
});

// ---------------------------------------------------------------------------
// Runner-authenticated endpoints (Bearer SIMBOX_TOKEN)
// ---------------------------------------------------------------------------

// POST /v1/runs/register — agent announces its tunnel.
// Security: the run must be one WE dispatched for THIS repo — otherwise a
// leaked token could attach foreign tunnels to arbitrary runs.
runRoutes.post("/v1/runs/register", requireRunnerToken, async (c) => {
  const repo = c.get("repo");
  const db = createDb(c.env);
  const body = await c.req.json<RunRegisterRequest>().catch(() => null);
  if (!body || typeof body.ghRunId !== "number" || !body.tunnelUrl || !body.daemonToken) {
    return apiError(c, 400, "bad_request", "Expected {ghRunId, tunnelUrl, daemonToken, versions}.");
  }

  // Normal path: gh_run_id was bound at dispatch time.
  let run = await db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.gh_run_id, body.ghRunId))
    .get();

  if (!run) {
    // Fallback: ensure's bind poll timed out and the webhook hasn't arrived —
    // adopt the run id onto the single unbound dispatching run for this repo.
    run = await db
      .select()
      .from(schema.runs)
      .where(
        and(
          eq(schema.runs.repo_full_name, repo.full_name),
          isNull(schema.runs.gh_run_id),
          eq(schema.runs.state, "dispatching"),
        ),
      )
      .orderBy(desc(schema.runs.created_at))
      .limit(1)
      .get();
    if (run) {
      await db
        .update(schema.runs)
        .set({ gh_run_id: body.ghRunId })
        .where(and(eq(schema.runs.id, run.id), isNull(schema.runs.gh_run_id)));
      run = { ...run, gh_run_id: body.ghRunId };
    }
  }

  if (
    !run ||
    run.repo_full_name !== repo.full_name ||
    // "live" is allowed: a restarted cloudflared re-registers the fresh
    // tunnel URL onto the same run.
    (run.state !== "dispatching" &&
      run.state !== "queued" &&
      run.state !== "booting" &&
      run.state !== "live")
  ) {
    return apiError(c, 403, "run_not_accepted", "No dispatched run matching this gh_run_id.");
  }

  const now = nowSeconds();
  await db
    .update(schema.runs)
    .set({
      state: "live",
      tunnel_url: body.tunnelUrl,
      daemon_token: body.daemonToken,
      live_at: now,
    })
    .where(eq(schema.runs.id, run.id));
  return c.json({ ok: true });
});

// POST /v1/runs/heartbeat — refresh device counts. A missing heartbeat is
// detected lazily (see reconcileRun — no heartbeat column in the locked schema).
runRoutes.post("/v1/runs/heartbeat", requireRunnerToken, async (c) => {
  const repo = c.get("repo");
  const db = createDb(c.env);
  const body = await c.req.json<RunHeartbeatRequest>().catch(() => null);
  if (!body || typeof body.ghRunId !== "number") {
    return apiError(c, 400, "bad_request", "Expected {ghRunId, active_devices, android_ready}.");
  }
  const run = await db
    .select()
    .from(schema.runs)
    .where(
      and(eq(schema.runs.gh_run_id, body.ghRunId), eq(schema.runs.repo_full_name, repo.full_name)),
    )
    .get();
  if (!run || isTerminal(run.state)) {
    return apiError(c, 404, "run_not_found", "No active run for this gh_run_id.");
  }
  await db
    .update(schema.runs)
    .set({
      active_devices: Math.max(0, body.activeDevices | 0),
      android_ready: body.androidReady ? 1 : 0,
    })
    .where(eq(schema.runs.id, run.id));
  return c.json({ ok: true });
});

// POST /v1/runs/deregister — clean shutdown path from the agent.
runRoutes.post("/v1/runs/deregister", requireRunnerToken, async (c) => {
  const repo = c.get("repo");
  const db = createDb(c.env);
  const body = await c.req
    .json<{ ghRunId?: number; reason?: string }>()
    .catch(() => ({}) as { ghRunId?: number; reason?: string });
  const now = nowSeconds();
  const set = {
    state: "ended" as const,
    ended_at: now,
    end_reason: body.reason ?? "agent_exit",
  };
  if (typeof body.ghRunId === "number") {
    await db
      .update(schema.runs)
      .set(set)
      .where(
        and(
          eq(schema.runs.gh_run_id, body.ghRunId),
          eq(schema.runs.repo_full_name, repo.full_name),
          notInArray(schema.runs.state, ["ended", "failed"]),
        ),
      );
  } else {
    // No gh_run_id — end any still-active run for this repo.
    await db
      .update(schema.runs)
      .set(set)
      .where(
        and(
          eq(schema.runs.repo_full_name, repo.full_name),
          notInArray(schema.runs.state, ["ended", "failed"]),
        ),
      );
  }
  return c.json({ ok: true });
});
