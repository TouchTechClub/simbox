/**
 * Run lifecycle: every state write, GitHub-run binding and reconciliation for
 * the `runs` table goes through here, so routes and webhooks agree on what a
 * transition means.
 *
 * Writes are compare-and-set on the state the caller read: a slow webhook or
 * reconcile can never move a run backwards (live → booting) or revive one that
 * already ended. A user may have several runs per platform (up to
 * MAX_ACTIVE_RUNS); each caller starts at most one at a time, enforced by the
 * `uniq_runs_starting_holder` index.
 */
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { createDb, schema, type Database } from "@simbox/db";
import { PLATFORMS, type DevicePlatform, type RunState } from "@simbox/shared";
import type { Env } from "./env";
import type { RepoRow, RunRow } from "./db";
import {
  cancelWorkflowRun,
  findDispatchedRun,
  getWorkflowRun,
  GithubApiError,
  installationToken,
} from "./github";
import { releaseRunTunnel } from "./tunnels";
import { nowSeconds } from "./util";

/** States that hold a platform slot. */
export const ACTIVE_STATES = [
  "dispatching",
  "queued",
  "booting",
  "live",
] as const satisfies RunState[];
/** States a run can still leave. */
export const OPEN_STATES = [...ACTIVE_STATES, "closing"] as const satisfies RunState[];
export const TERMINAL_STATES = ["ended", "failed"] as const satisfies RunState[];

export function isTerminal(state: RunState): boolean {
  return (TERMINAL_STATES as readonly RunState[]).includes(state);
}

/** Unbound runs older than this never got a GitHub run. */
const DISPATCH_BIND_GRACE_SECONDS = 600;
/** A run without progress for this long is checked against GitHub. */
const STALE_AFTER_SECONDS = 90;
/** Cloudflare KV enforces expirationTtl >= 60. */
const GH_CHECK_THROTTLE_SECONDS = 60;
/**
 * Live runs normally end by webhook or deregister; this catches a runner that
 * died silently without paying a GitHub call on every dashboard poll.
 */
const LIVE_CHECK_AFTER_SECONDS = 300;
const LIVE_CHECK_THROTTLE_SECONDS = 300;

export interface Transition {
  state: RunState;
  endReason: string | null;
}

/** A GitHub workflow_run status folded onto a run; null when it changes nothing. */
export function mapWorkflowRun(
  status: string | null,
  conclusion: string | null,
  current: RunState,
): Transition | null {
  if (
    status === "queued" ||
    status === "waiting" ||
    status === "pending" ||
    status === "requested"
  ) {
    return current === "dispatching" ? { state: "queued", endReason: null } : null;
  }
  if (status === "in_progress") {
    return current === "dispatching" || current === "queued"
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

/** Whether a run should be checked against GitHub. Pure; no I/O. */
export function needsReconcile(run: RunRow, now: number): boolean {
  if (isTerminal(run.state)) return false;
  if (run.expires_at !== null && run.expires_at < now) return true;
  if (run.state === "closing") return true;
  if (run.state === "live") return (run.live_at ?? run.created_at) + LIVE_CHECK_AFTER_SECONDS < now;
  return run.created_at + STALE_AFTER_SECONDS < now;
}

type RunPatch = Partial<Omit<typeof schema.runs.$inferInsert, "id" | "state">>;

function changed(result: unknown): boolean {
  return ((result as { meta?: { changes?: number } })?.meta?.changes ?? 0) > 0;
}

/**
 * Move a run to `next` only if it is still in one of `from` (default: the
 * state the caller read). Returns the updated row, or null if another writer
 * got there first.
 */
export async function setRunState(
  db: Database,
  run: RunRow,
  next: Transition,
  options: { from?: readonly RunState[]; patch?: RunPatch; now?: number } = {},
): Promise<RunRow | null> {
  const now = options.now ?? nowSeconds();
  const { runs } = schema;
  // Decided in SQL against the row as it is now, not as the caller read it:
  // a run that was closing ends for the reason it was closed ("stopped",
  // "replaced"), not GitHub's resulting "cancelled".
  const reason = next.endReason ?? null;
  const endReason =
    next.state === "ended"
      ? sql`CASE WHEN ${runs.state} = 'closing' AND ${runs.end_reason} IS NOT NULL THEN ${runs.end_reason} ELSE coalesce(${reason}, ${runs.end_reason}) END`
      : sql`coalesce(${reason}, ${runs.end_reason})`;
  const [updated] = await db
    .update(runs)
    .set({
      ...options.patch,
      state: next.state,
      end_reason: endReason,
      ...(isTerminal(next.state) ? { ended_at: sql`coalesce(${runs.ended_at}, ${now})` } : {}),
    })
    .where(and(eq(runs.id, run.id), inArray(runs.state, [...(options.from ?? [run.state])])))
    .returning();
  return updated ?? null;
}

export interface LifecycleContext {
  env: Pick<Env, "DB" | "KV"> & Partial<Env>;
  db: Database;
  /** Lazily fetched; null when the installation cannot mint one. */
  token: () => Promise<string | null>;
  defer: (work: Promise<unknown>) => void;
}

/**
 * Lifecycle dependencies for one request. The installation token is minted on
 * first use; an installation GitHub reports as deleted or suspended marks the
 * repo uninstalled, so the dashboard asks for a reinstall instead of failing
 * every call.
 */
export function createLifecycle(
  env: Env,
  defer: (work: Promise<unknown>) => void,
  repo: RepoRow | null,
  token?: string,
): LifecycleContext {
  const db = createDb(env);
  let pending: Promise<string | null> | null = token ? Promise.resolve(token) : null;
  return {
    env,
    db,
    defer,
    token: () =>
      (pending ??= repo
        ? installationToken(env, repo.installation_id).catch(async (error) => {
            if (isInstallationGone(error))
              await markInstallationGone(db, repo.installation_id).catch(() => {});
            return null;
          })
        : Promise.resolve(null)),
  };
}

/**
 * GitHub answers 404 for a deleted installation and 403 for a suspended one.
 * Other 403s (rate limits) are transient and must not disconnect anything.
 */
export function isInstallationGone(error: unknown): boolean {
  if (!(error instanceof GithubApiError)) return false;
  return error.status === 404 || (error.status === 403 && /suspend/i.test(error.message));
}

export async function markInstallationGone(db: Database, installationId: number): Promise<void> {
  await db
    .update(schema.repos)
    .set({ state: "uninstalled" })
    .where(eq(schema.repos.installation_id, installationId));
}

/** End a run and release its tunnel. Null if it was already over. */
export async function finishRun(
  ctx: Pick<LifecycleContext, "env" | "db" | "defer">,
  run: RunRow,
  state: "ended" | "failed",
  reason: string,
): Promise<RunRow | null> {
  const ended = await setRunState(ctx.db, run, { state, endReason: reason }, { from: OPEN_STATES });
  if (ended?.tunnel_id) ctx.defer(releaseTunnel(ctx, ended));
  return ended;
}

function releaseTunnel(ctx: Pick<LifecycleContext, "env" | "db">, run: RunRow): Promise<void> {
  return releaseRunTunnel(ctx.env as Env, ctx.db, run).catch((error) =>
    console.error("tunnel release failed", run.id, String(error)),
  );
}

/** Ask GitHub to cancel a run; success or "already gone" both count as done. */
export async function cancelOnGithub(
  ctx: Pick<LifecycleContext, "token">,
  repo: RepoRow,
  ghRunId: number,
): Promise<"cancelled" | "gone" | "finished" | "unavailable"> {
  const token = await ctx.token();
  if (!token) return "unavailable";
  try {
    await cancelWorkflowRun(token, repo.full_name, ghRunId);
    return "cancelled";
  } catch (error) {
    if (error instanceof GithubApiError && error.status === 404) return "gone";
    // 409: the run already completed and cannot be cancelled.
    if (error instanceof GithubApiError && error.status === 409) return "finished";
    throw error;
  }
}

/**
 * Attach a GitHub run to a Simbox run. A run that was stopped or replaced
 * before GitHub created its job is cancelled now instead of being orphaned.
 */
export async function bindGithubRun(
  ctx: LifecycleContext,
  run: RunRow,
  repo: RepoRow,
  ghRunId: number,
): Promise<RunRow | null> {
  if (run.gh_run_id === ghRunId) return run;
  if (run.gh_run_id !== null) return null;
  let result: unknown;
  try {
    result = await ctx.db
      .update(schema.runs)
      .set({ gh_run_id: ghRunId })
      .where(and(eq(schema.runs.id, run.id), isNull(schema.runs.gh_run_id)))
      .run();
  } catch {
    return null; // gh_run_id is unique: already bound to another run
  }
  if (!changed(result)) {
    const current = await ctx.db.select().from(schema.runs).where(eq(schema.runs.id, run.id)).get();
    return current?.gh_run_id === ghRunId ? current : null;
  }
  const bound = { ...run, gh_run_id: ghRunId };
  if (run.state === "closing" || isTerminal(run.state))
    ctx.defer(cancelOnGithub(ctx, repo, ghRunId).catch(() => {}));
  return bound;
}

/**
 * The run's GitHub id, looking it up by run name (v2 workflows) when the
 * webhook has not bound it yet. Null when GitHub has no such run (yet).
 */
export async function locateGithubRun(
  ctx: LifecycleContext,
  run: RunRow,
  repo: RepoRow,
): Promise<RunRow> {
  if (run.gh_run_id !== null) return run;
  const token = await ctx.token();
  if (!token) return run;
  const found = await findDispatchedRun(token, repo.full_name, run.id, run.created_at).catch(
    () => null,
  );
  return (found && (await bindGithubRun(ctx, run, repo, found))) || run;
}

const RUN_ID_IN_TITLE = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;

/** The Simbox run id a workflow run's `run-name` carries, if any. */
export function runIdFromTitle(title: string | null | undefined): string | null {
  return title ? (RUN_ID_IN_TITLE.exec(title)?.[1]?.toLowerCase() ?? null) : null;
}

/**
 * Fold GitHub's view back into a run that looks stale. Throttled per run via
 * KV. Transient GitHub errors leave the run alone; only a 404 means it is gone.
 */
export async function reconcileRun(
  ctx: LifecycleContext,
  run: RunRow,
  repo: RepoRow | null,
): Promise<RunRow> {
  const now = nowSeconds();
  if (!repo || !needsReconcile(run, now)) return run;

  if (run.expires_at !== null && run.expires_at < now) {
    if (run.gh_run_id) ctx.defer(cancelOnGithub(ctx, repo, run.gh_run_id).catch(() => {}));
    return (await finishRun(ctx, run, "ended", "expired")) ?? run;
  }

  if (run.gh_run_id === null && run.created_at + DISPATCH_BIND_GRACE_SECONDS < now) {
    // Look once more before giving up: the job may be queued with its webhook lost.
    run = await locateGithubRun(ctx, run, repo);
    if (run.gh_run_id === null) {
      const reason = run.state === "closing" ? "stopped" : "run_never_appeared";
      const state = run.state === "closing" ? "ended" : "failed";
      return (await finishRun(ctx, run, state, reason)) ?? run;
    }
  }

  const throttleKey = `gh_check:${run.id}`;
  if (await ctx.env.KV.get(throttleKey)) return run;
  await ctx.env.KV.put(throttleKey, "1", {
    expirationTtl: run.state === "live" ? LIVE_CHECK_THROTTLE_SECONDS : GH_CHECK_THROTTLE_SECONDS,
  });
  const token = await ctx.token();
  if (!token) return run;

  if (run.gh_run_id === null) {
    run = await locateGithubRun(ctx, run, repo);
    if (run.gh_run_id === null) return run;
  }

  let info;
  try {
    info = await getWorkflowRun(token, repo.full_name, run.gh_run_id!);
  } catch {
    return run; // rate limit, 5xx or network: try again later
  }
  if (!info) return (await finishRun(ctx, run, "failed", "run_not_found")) ?? run;
  const next = mapWorkflowRun(info.status, info.conclusion, run.state);
  if (!next) return run;
  if (isTerminal(next.state))
    return (await finishRun(ctx, run, next.state as "ended" | "failed", next.endReason!)) ?? run;
  return (await setRunState(ctx.db, run, next)) ?? run;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Non-terminal runs, newest first. */
export async function openRuns(db: Database, userId: string): Promise<RunRow[]> {
  return db
    .select()
    .from(schema.runs)
    .where(and(eq(schema.runs.user_id, userId), inArray(schema.runs.state, [...OPEN_STATES])))
    .orderBy(desc(schema.runs.created_at))
    .all();
}

/** Every open run after lazy reconciliation: iOS first, newest first within a platform. */
export async function activeRuns(
  ctx: LifecycleContext,
  userId: string,
  repo: RepoRow | null,
): Promise<RunRow[]> {
  const byPlatform = new Map<DevicePlatform, RunRow[]>();
  for (const candidate of await openRuns(ctx.db, userId)) {
    const run = await reconcileRun(ctx, candidate, repo);
    if (isTerminal(run.state)) continue;
    byPlatform.set(run.platform, [...(byPlatform.get(run.platform) ?? []), run]);
  }
  return PLATFORMS.flatMap((platform) => byPlatform.get(platform) ?? []);
}
