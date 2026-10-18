import { Hono, type Context } from "hono";
import { and, desc, eq, gte, inArray, isNotNull, isNull } from "drizzle-orm";
import { createDb, schema } from "@simbox/db";
import type {
  ActiveRunsResponse,
  DevicePlatform,
  DeviceProfile,
  EnsureRunRequest,
  EnsureRunResponse,
  RunConfigResponse,
  RunHeartbeatRequest,
  RunInventoryRequest,
  RunnerInventory,
  RunnerTarget,
  RunRegisterRequest,
  RunTunnelResponse,
} from "@simbox/shared";
import {
  DEFAULT_RUNNERS,
  HARD_EXIT_MINUTES,
  MAX_DEVICES_PER_RUN,
  formatDeviceProfile,
  pickDevice,
  resolveDevice,
  resolveRunner,
  sameDeviceProfile,
  sameRunner,
  validateBootedDevice,
  validateCatalog,
  validateDeviceProfile,
  validateRunner,
} from "@simbox/shared";
import type { AppContext } from "../middleware";
import { requireRunnerToken, requireUser } from "../middleware";
import type { RepoRow, RunRow } from "../db";
import { getRepoForUser } from "../db";
import { apiError, newId, nowSeconds, toPublicRun, toRunSummary } from "../util";
import { getRunnerSettings, readInventory, writeInventory } from "../runners";
import { provisionRunTunnel, tunnelsConfigured, tunnelZoneDelegated } from "../tunnels";
import {
  bindGhRunId,
  dispatchWorkflow,
  getWorkflowRun,
  GithubApiError,
  installationToken,
  isUnexpectedInputError,
} from "../github";
import {
  ACTIVE_STATES,
  activeRuns,
  bindGithubRun,
  cancelOnGithub,
  createLifecycle,
  finishRun,
  isInstallationGone,
  isTerminal,
  locateGithubRun,
  mapWorkflowRun,
  markInstallationGone,
  openRuns,
  setRunState,
  type LifecycleContext,
} from "../run-lifecycle";

export const runRoutes = new Hono<AppContext>();

type Ctx = Context<AppContext>;

function lifecycle(c: Ctx, repo: RepoRow | null, token?: string): LifecycleContext {
  return createLifecycle(c.env, (work) => c.executionCtx.waitUntil(work), repo, token);
}

/** Drizzle wraps driver errors; the SQLite constraint text is on the cause chain. */
function isUniqueViolation(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 5; e = (e as Error).cause, depth++)
    if (/UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(String((e as Error).message ?? e)))
      return true;
  return false;
}

const isActive = (run: RunRow) => (ACTIVE_STATES as readonly string[]).includes(run.state);

function parsePlatform(value: unknown): DevicePlatform | null | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return value === "ios" || value === "android" ? value : null;
}

function liveResponse(run: RunRow): EnsureRunResponse {
  return {
    state: "live",
    runId: run.id,
    ghRunId: run.gh_run_id ?? 0,
    tunnelUrl: run.tunnel_url ?? "",
    daemonToken: run.daemon_token ?? "",
    expiresAt: (run.expires_at ?? 0) * 1000,
  };
}

function pendingResponse(run: RunRow): EnsureRunResponse {
  return {
    state: run.state === "dispatching" || run.state === "queued" ? run.state : "booting",
    runId: run.id,
  };
}

/** A device request the runner's last reported catalog cannot satisfy. */
function inventoryMismatch(device: DeviceProfile, inventory: RunnerInventory): string | null {
  if (device.model !== undefined || device.foldable || device.os !== undefined) {
    const pick = pickDevice(device, inventory);
    if (!pick.ok) return pick.error;
  }
  if (device.xcode && inventory.xcode?.length) {
    const wanted = device.xcode;
    if (!inventory.xcode.some((v) => v === wanted || v.startsWith(`${wanted}.`)))
      return `Xcode ${wanted} is not installed on this runner (installed: ${inventory.xcode.join(", ")}).`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// POST /v1/runs/ensure — reuse this platform's run, or dispatch one.
// ---------------------------------------------------------------------------

runRoutes.post("/v1/runs/ensure", requireUser, async (c) => {
  const user = c.get("user");
  const body = await c.req.json<EnsureRunRequest>().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body))
    return apiError(c, 400, "bad_request", "Expected a run request object.");
  const wantNew = body.new === true;
  const requested = parsePlatform(body.platform);
  if (requested === null)
    return apiError(c, 400, "invalid_platform", "platform must be ios or android.");
  if (body.runner !== undefined && !requested)
    return apiError(c, 400, "invalid_runner", "Specify platform when overriding a runner.");
  if (body.device !== undefined && !requested)
    return apiError(c, 400, "invalid_device", "Specify platform when choosing a device.");

  const db = createDb(c.env);
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

  let token: string;
  try {
    token = await installationToken(c.env, repo.installation_id);
  } catch (error) {
    if (!isInstallationGone(error)) throw error;
    await markInstallationGone(db, repo.installation_id);
    return apiError(
      c,
      409,
      "repo_not_ready",
      `The Simbox GitHub App can no longer access ${repo.full_name}. Reinstall it from the dashboard.`,
    );
  }
  const ctx = lifecycle(c, repo, token);
  const open = (await activeRuns(ctx, user.id, repo)).filter(isActive);
  const platform: DevicePlatform = requested ?? (open.length === 1 ? open[0]!.platform : "ios");

  let override: RunnerTarget | undefined;
  let deviceOverride: DeviceProfile | null = null;
  try {
    override = body.runner === undefined ? undefined : validateRunner(body.runner, platform);
  } catch (err) {
    return apiError(c, 400, "invalid_runner", (err as Error).message);
  }
  try {
    deviceOverride = validateDeviceProfile(body.device, platform);
  } catch (err) {
    return apiError(c, 400, "invalid_device", (err as Error).message);
  }

  const settings = await getRunnerSettings(ctx.db, user.id);
  const { runner } = resolveRunner(platform, settings.account, settings.repository, override);
  const { device } = resolveDevice(
    platform,
    settings.devices.account,
    settings.devices.repository,
    deviceOverride,
  );

  const current = open.find((run) => run.platform === platform);
  if (current && !wantNew) {
    if (override && !sameRunner(current.runner, override)) {
      return apiError(
        c,
        409,
        "runner_mismatch",
        `The active ${platform} run uses a different runner. Add --new to replace it.`,
      );
    }
    if (body.device !== undefined && !sameDeviceProfile(current.device ?? null, device)) {
      return apiError(
        c,
        409,
        "device_mismatch",
        `The active ${platform} run has a different device (${formatDeviceProfile(current.device ?? null, platform)}). Add --new to replace it.`,
      );
    }
    if (current.state !== "live") return c.json(pendingResponse(current));
    if (current.active_devices >= MAX_DEVICES_PER_RUN) {
      return c.json(
        {
          error: "at_capacity",
          message: `Run already has ${current.active_devices} devices (cap ${MAX_DEVICES_PER_RUN}).`,
          hint: "use --new",
        },
        409,
      );
    }
    return c.json(liveResponse(current));
  }

  if (device) {
    const inventory = await readInventory(c.env, repo.repo_id, platform, runner);
    const problem = inventory && inventoryMismatch(device, inventory);
    if (problem)
      return apiError(
        c,
        400,
        "invalid_device",
        `${problem} Run \`simbox devices list --platform ${platform}\` to see this runner's devices.`,
      );
  }

  if (current) {
    // --new: retire this platform's run; the other platform keeps running.
    const closing = await setRunState(
      ctx.db,
      current,
      { state: "closing", endReason: "replaced" },
      { from: ACTIVE_STATES },
    );
    if (closing?.gh_run_id) ctx.defer(cancelOnGithub(ctx, repo, closing.gh_run_id).catch(() => {}));
  }

  const runId = newId();
  const now = nowSeconds();
  try {
    await ctx.db.insert(schema.runs).values({
      id: runId,
      user_id: user.id,
      repo_full_name: repo.full_name,
      gh_run_id: null,
      state: "dispatching",
      platform,
      runner,
      device,
      created_at: now,
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Another ensure for this platform won the race: report its run.
    const winner = (await openRuns(ctx.db, user.id)).find(
      (run) => run.platform === platform && isActive(run),
    );
    if (winner)
      return c.json(winner.state === "live" ? liveResponse(winner) : pendingResponse(winner));
    return apiError(c, 409, "run_conflict", "Another run is starting; retry in a moment.");
  }
  const run = (await ctx.db.select().from(schema.runs).where(eq(schema.runs.id, runId)).get())!;

  const failDispatch = async (reason: string) => {
    await finishRun(ctx, run, "failed", reason);
  };

  let legacy = false;
  try {
    await dispatchWorkflow(token, repo.full_name, repo.default_branch, {
      platform,
      runner,
      simboxRun: runId,
    });
    if (repo.workflow_version < 2)
      await ctx.db
        .update(schema.repos)
        .set({ workflow_version: 2 })
        .where(eq(schema.repos.user_id, user.id));
  } catch (error) {
    if (isUnexpectedInputError(error)) {
      legacy = true;
    } else if (error instanceof GithubApiError && (error.status === 404 || error.status === 410)) {
      // Actions disabled or the workflow file is gone.
      await ctx.db
        .update(schema.repos)
        .set({ state: "needs_repair" })
        .where(eq(schema.repos.user_id, user.id));
      await failDispatch("dispatch_failed");
      return apiError(
        c,
        409,
        "dispatch_failed",
        "Could not dispatch the workflow — run `simbox repair`.",
      );
    } else {
      await failDispatch("dispatch_failed");
      throw error;
    }
  }

  if (legacy) {
    // The committed workflow predates run correlation. It can still run one
    // platform at a time, bound by the older time-window heuristic.
    if (repo.workflow_version !== 1)
      await ctx.db
        .update(schema.repos)
        .set({ workflow_version: 1 })
        .where(eq(schema.repos.user_id, user.id));
    const other = open.find((r) => r.platform !== platform);
    if (other) {
      await failDispatch("workflow_needs_repair");
      return apiError(
        c,
        409,
        "workflow_needs_repair",
        `Your Simbox workflow predates running iOS and Android at once, and a ${other.platform} run is active. Run \`simbox repair\` (merge its PR if needed), or stop the ${other.platform} run.`,
      );
    }
    try {
      await dispatchWorkflow(token, repo.full_name, repo.default_branch, { platform, runner });
    } catch (error) {
      await failDispatch("workflow_needs_repair");
      if (error instanceof GithubApiError && (error.status === 422 || error.status === 404))
        return apiError(
          c,
          409,
          "workflow_needs_repair",
          "Run `simbox repair` to install the current workflow (merge its PR if needed), then retry. Simbox will not fall back to another runner.",
        );
      throw error;
    }
    const claimed = new Set(
      (
        await ctx.db
          .select({ id: schema.runs.gh_run_id })
          .from(schema.runs)
          .where(
            and(
              eq(schema.runs.repo_full_name, repo.full_name),
              isNotNull(schema.runs.gh_run_id),
              gte(schema.runs.created_at, now - 3600),
            ),
          )
          .all()
      ).map((row) => row.id!),
    );
    const ghRunId = await bindGhRunId(token, repo.full_name, now, claimed).catch(() => null);
    await ctx.db.update(schema.runs).set({ dispatched_at: now }).where(eq(schema.runs.id, runId));
    if (ghRunId && (await bindGithubRun(ctx, run, repo, ghRunId))) {
      const queued = await setRunState(
        ctx.db,
        { ...run, gh_run_id: ghRunId },
        {
          state: "queued",
          endReason: null,
        },
      );
      return c.json(pendingResponse(queued ?? run));
    }
    return c.json(pendingResponse(run));
  }

  await ctx.db.update(schema.runs).set({ dispatched_at: now }).where(eq(schema.runs.id, runId));
  return c.json(pendingResponse(run));
});

// ---------------------------------------------------------------------------
// Reads: active runs (≤1 per platform), current (legacy), history.
// ---------------------------------------------------------------------------

async function userRuns(c: Ctx): Promise<RunRow[]> {
  const user = c.get("user");
  const db = createDb(c.env);
  const repo = await getRepoForUser(db, user.id);
  return activeRuns(lifecycle(c, repo), user.id, repo);
}

runRoutes.get("/v1/runs/active", requireUser, async (c) => {
  const runs = await userRuns(c);
  return c.json({ runs: runs.map(toPublicRun) } satisfies ActiveRunsResponse);
});

runRoutes.get("/v1/runs/current", requireUser, async (c) => {
  const platform = parsePlatform(c.req.query("platform"));
  if (platform === null)
    return apiError(c, 400, "invalid_platform", "platform must be ios or android.");
  // Without a platform (older clients): the newest active run.
  const runs = (await userRuns(c))
    .filter((run) => !platform || run.platform === platform)
    .sort((a, b) => b.created_at - a.created_at);
  const run = runs.find(isActive) ?? runs[0] ?? null;
  return c.json({ run: run ? toPublicRun(run) : null });
});

runRoutes.get("/v1/runs", requireUser, async (c) => {
  const user = c.get("user");
  const db = createDb(c.env);
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit")) || 20));
  const results = await db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.user_id, user.id))
    .orderBy(desc(schema.runs.created_at))
    .limit(limit);
  return c.json({ runs: results.map(toRunSummary) });
});

// ---------------------------------------------------------------------------
// POST /v1/runs/:id/stop — cancel on GitHub; the webhook or reconcile ends it.
// ---------------------------------------------------------------------------

runRoutes.post("/v1/runs/:id/stop", requireUser, async (c) => {
  const user = c.get("user");
  const db = createDb(c.env);
  const run = await db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.id, c.req.param("id")))
    .get();
  // Run ids are unguessable, but still scope them to their owner.
  if (!run || run.user_id !== user.id) return apiError(c, 404, "not_found", "Run not found.");
  if (isTerminal(run.state)) return c.json({ run: toPublicRun(run) });

  const repo = await getRepoForUser(db, user.id);
  const ctx = lifecycle(c, repo);
  const stopped = await stopRun(ctx, run, repo);
  return c.json({ run: toPublicRun(stopped) });
});

/** Cancel a run on GitHub and record the outcome. Exported for disconnect. */
export async function stopRun(
  ctx: LifecycleContext,
  run: RunRow,
  repo: RepoRow | null,
): Promise<RunRow> {
  if (repo) run = await locateGithubRun(ctx, run, repo);
  const closing = async () =>
    (await setRunState(
      ctx.db,
      run,
      { state: "closing", endReason: "stopped" },
      { from: ACTIVE_STATES },
    )) ?? run;

  if (!run.gh_run_id || !repo) {
    // Not bound yet: GitHub may still create the job. Closing keeps the row
    // around so binding cancels it; reconcile ends it after the grace period.
    if (repo && run.state === "dispatching") return closing();
    return (await finishRun(ctx, run, "ended", "stopped")) ?? run;
  }

  let outcome: Awaited<ReturnType<typeof cancelOnGithub>>;
  try {
    outcome = await cancelOnGithub(ctx, repo, run.gh_run_id);
  } catch {
    // GitHub is unavailable: the agent stops itself once heartbeats say the run is over.
    return (await finishRun(ctx, run, "ended", "stopped")) ?? run;
  }
  if (outcome === "cancelled") return closing();
  if (outcome === "finished") {
    const token = await ctx.token();
    const info = token
      ? await getWorkflowRun(token, repo.full_name, run.gh_run_id).catch(() => null)
      : null;
    const next = info && mapWorkflowRun(info.status, info.conclusion, run.state);
    if (next && isTerminal(next.state))
      return (await finishRun(ctx, run, next.state as "ended" | "failed", next.endReason!)) ?? run;
  }
  return (await finishRun(ctx, run, "ended", outcome === "gone" ? "cancelled" : "stopped")) ?? run;
}

// ---------------------------------------------------------------------------
// Runner-authenticated endpoints (Bearer SIMBOX_TOKEN)
// ---------------------------------------------------------------------------

interface RunnerRef {
  ghRunId?: unknown;
  runId?: unknown;
}

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readRef(body: RunnerRef | null): { ghRunId: number; runId: string | null } | null {
  if (!body || typeof body.ghRunId !== "number" || !Number.isSafeInteger(body.ghRunId)) return null;
  const runId =
    typeof body.runId === "string" && RUN_ID.test(body.runId) ? body.runId.toLowerCase() : null;
  return { ghRunId: body.ghRunId, runId };
}

/**
 * The Simbox run a runner is acting for, in any state. Matched by gh_run_id;
 * otherwise by the dispatched run id (v2 workflows), binding the two; older
 * agents fall back to the repo's single unbound dispatching run. Never
 * crosses repositories.
 */
async function findRunnerRun(
  ctx: LifecycleContext,
  repo: RepoRow,
  ref: { ghRunId: number; runId: string | null },
): Promise<RunRow | null> {
  const bound = await ctx.db
    .select()
    .from(schema.runs)
    .where(and(eq(schema.runs.gh_run_id, ref.ghRunId), eq(schema.runs.user_id, repo.user_id)))
    .get();
  if (bound) return !ref.runId || bound.id === ref.runId ? bound : null;

  let candidate: RunRow | undefined;
  if (ref.runId) {
    candidate = await ctx.db
      .select()
      .from(schema.runs)
      .where(and(eq(schema.runs.id, ref.runId), eq(schema.runs.user_id, repo.user_id)))
      .get();
  } else {
    const unbound = await ctx.db
      .select()
      .from(schema.runs)
      .where(
        and(
          eq(schema.runs.user_id, repo.user_id),
          isNull(schema.runs.gh_run_id),
          inArray(schema.runs.state, ["dispatching", "queued"]),
        ),
      )
      .limit(2)
      .all();
    // Two unbound runs are ambiguous for an agent that cannot say which it is.
    candidate = unbound.length === 1 ? unbound[0] : undefined;
  }
  if (!candidate || candidate.gh_run_id !== null) return null;
  if (!(await isOurGithubRun(ctx, repo, ref))) return null;
  return bindGithubRun(ctx, candidate, repo, ref.ghRunId);
}

/**
 * Before first binding, check the GitHub run exists in this repository and,
 * for v2 workflows, carries this run id — so a runner token cannot claim
 * another repository's (globally unique) run id. GitHub being unavailable
 * fails open: the runner token already proves access to this repository.
 */
async function isOurGithubRun(
  ctx: LifecycleContext,
  repo: RepoRow,
  ref: { ghRunId: number; runId: string | null },
): Promise<boolean> {
  const token = await ctx.token();
  if (!token) return true;
  let info;
  try {
    info = await getWorkflowRun(token, repo.full_name, ref.ghRunId);
  } catch {
    return true;
  }
  if (!info) return false;
  return !ref.runId || !info.display_title || info.display_title.toLowerCase().includes(ref.runId);
}

async function runnerRun(
  c: Ctx,
  body: RunnerRef | null,
): Promise<{ run: RunRow; ctx: LifecycleContext } | Response> {
  const ref = readRef(body);
  if (!ref) return apiError(c, 400, "bad_request", "Expected {ghRunId, runId?}.");
  const repo = c.get("repo");
  const ctx = lifecycle(c, repo);
  const run = await findRunnerRun(ctx, repo, ref);
  if (!run)
    return apiError(c, 403, "run_not_accepted", "No dispatched run matching this gh_run_id.");
  return { run, ctx };
}

const runOver = (c: Ctx) =>
  apiError(c, 409, "run_over", "This run was stopped or has ended; shut down.");

// POST /v1/runs/config — what the runner should prepare.
runRoutes.post("/v1/runs/config", requireRunnerToken, async (c) => {
  const found = await runnerRun(c, await c.req.json<RunnerRef>().catch(() => null));
  if (found instanceof Response) return found;
  if (!isActive(found.run)) return runOver(c);
  const config: RunConfigResponse = {
    platform: found.run.platform,
    device: found.run.device ?? null,
    runId: found.run.id,
  };
  return c.json(config);
});

// POST /v1/runs/inventory — the runner's device catalog and what it booted.
runRoutes.post("/v1/runs/inventory", requireRunnerToken, async (c) => {
  const body = await c.req.json<RunInventoryRequest>().catch(() => null);
  const found = await runnerRun(c, body);
  if (found instanceof Response) return found;
  const { run, ctx } = found;
  let catalog;
  let booted;
  try {
    catalog = validateCatalog(body!.catalog);
    booted = body!.booted === undefined ? undefined : validateBootedDevice(body!.booted);
  } catch (error) {
    return apiError(c, 400, "invalid_inventory", (error as Error).message);
  }
  await writeInventory(c.env, c.get("repo").repo_id, {
    ...catalog,
    platform: run.platform,
    runner: run.runner ?? DEFAULT_RUNNERS[run.platform],
    reportedAt: Date.now(),
  });
  if (booted)
    await ctx.db
      .update(schema.runs)
      .set({ booted_device: booted })
      .where(eq(schema.runs.id, run.id));
  return c.json({ ok: true });
});

// POST /v1/runs/tunnel — a named Cloudflare tunnel for this run. Agents fall
// back to a quick tunnel on any failure, including 503 when unconfigured.
runRoutes.post("/v1/runs/tunnel", requireRunnerToken, async (c) => {
  const found = await runnerRun(c, await c.req.json<RunnerRef>().catch(() => null));
  if (found instanceof Response) return found;
  if (!isActive(found.run)) return runOver(c);
  if (!tunnelsConfigured(c.env) || !(await tunnelZoneDelegated(c.env)))
    return apiError(c, 503, "tunnels_unavailable", "Named tunnels are unavailable.");
  try {
    const tunnel: RunTunnelResponse = await provisionRunTunnel(c.env, found.ctx.db, found.run);
    return c.json(tunnel);
  } catch (error) {
    console.error("tunnel provisioning failed", found.run.id, String(error));
    return apiError(c, 502, "tunnel_failed", "Could not provision a named tunnel.");
  }
});

// POST /v1/runs/register — the agent announces its tunnel. Re-registering a
// live run (restarted cloudflared) updates the URL. The hard-exit clock
// starts here, not at dispatch: queue time is not run time.
runRoutes.post("/v1/runs/register", requireRunnerToken, async (c) => {
  const body = await c.req.json<RunRegisterRequest>().catch(() => null);
  if (
    !body ||
    typeof body.tunnelUrl !== "string" ||
    !/^https:\/\/[^\s/]+/.test(body.tunnelUrl) ||
    typeof body.daemonToken !== "string" ||
    !body.daemonToken
  )
    return apiError(c, 400, "bad_request", "Expected {ghRunId, tunnelUrl, daemonToken, versions}.");
  const found = await runnerRun(c, body);
  if (found instanceof Response) return found;
  const { run, ctx } = found;
  if (!isActive(run)) return runOver(c);
  const now = nowSeconds();
  const live = await setRunState(
    ctx.db,
    run,
    { state: "live", endReason: null },
    {
      from: ACTIVE_STATES,
      patch: {
        tunnel_url: body.tunnelUrl,
        daemon_token: body.daemonToken,
        live_at: run.live_at ?? now,
        expires_at: run.expires_at ?? now + HARD_EXIT_MINUTES * 60,
      },
    },
  );
  if (!live) return runOver(c);
  return c.json({ ok: true });
});

// POST /v1/runs/heartbeat — device counts and readiness. 409 tells the agent
// the run is over (stopped, replaced or expired) so it exits cleanly.
runRoutes.post("/v1/runs/heartbeat", requireRunnerToken, async (c) => {
  const body = await c.req.json<RunHeartbeatRequest>().catch(() => null);
  const ref = readRef(body);
  if (!ref)
    return apiError(c, 400, "bad_request", "Expected {ghRunId, activeDevices, androidReady}.");
  const repo = c.get("repo");
  const ctx = lifecycle(c, repo);
  const run = await findRunnerRun(ctx, repo, ref);
  if (!run) return apiError(c, 404, "run_not_found", "No run for this gh_run_id.");
  if (!isActive(run)) return runOver(c);
  if (run.expires_at !== null && run.expires_at < nowSeconds()) {
    await finishRun(ctx, run, "ended", "expired");
    return runOver(c);
  }
  const result = await ctx.db
    .update(schema.runs)
    .set({
      active_devices: Math.max(0, Math.min(1000, Number(body!.activeDevices) | 0)),
      android_ready: body!.androidReady ? 1 : 0,
      ...(typeof body!.devicesReady === "boolean"
        ? { devices_ready: body!.devicesReady ? 1 : 0 }
        : {}),
    })
    .where(and(eq(schema.runs.id, run.id), inArray(schema.runs.state, [...ACTIVE_STATES])))
    .run();
  if (!((result as { meta?: { changes?: number } }).meta?.changes ?? 0)) return runOver(c);
  return c.json({ ok: true });
});

// POST /v1/runs/deregister — clean shutdown from the agent. Ends only the
// run that asked; the other platform's run is untouched.
runRoutes.post("/v1/runs/deregister", requireRunnerToken, async (c) => {
  const body = await c.req.json<RunnerRef & { reason?: unknown }>().catch(() => null);
  const ref = readRef(body);
  if (!ref) return apiError(c, 400, "bad_request", "Expected {ghRunId, runId?, reason?}.");
  const repo = c.get("repo");
  const ctx = lifecycle(c, repo);
  const run = await findRunnerRun(ctx, repo, ref);
  if (!run) return c.json({ ok: true });
  const reason =
    typeof body!.reason === "string" && /^[\w:.-]{1,64}$/.test(body!.reason)
      ? body!.reason
      : "agent_exit";
  await finishRun(ctx, run, "ended", reason);
  return c.json({ ok: true });
});
