import { createMiddleware } from "hono/factory";
import { createDb } from "@simbox/db";
import type { Env } from "./env";
import type { AuthUser, RepoRow } from "./db";
import { getGithubAccount, getRepoByTokenHash } from "./db";
import { apiError, sha256Hex } from "./util";
import { createAuth } from "./auth";

export interface AppVariables {
  user: AuthUser;
  repo: RepoRow;
}

export type AppContext = { Bindings: Env; Variables: AppVariables };

/**
 * Authenticates the human user via better-auth: either the web session cookie
 * or `Authorization: Bearer <access_token>` issued by the device flow (the
 * bearer plugin rewrites it into the session cookie for getSession).
 *
 * Sets `user` as a normalized AuthUser — better-auth user.id plus the linked
 * GitHub account's id/token (account row, providerId = 'github').
 */
export const requireUser = createMiddleware<AppContext>(async (c, next) => {
  // Dev-only escape hatch: DEMO_MODE serves a seeded fake user/repo/run so the
  // dashboard can be previewed without GitHub credentials. Never set in prod.
  if (c.env.DEMO_MODE === "true") {
    await seedDemo(c.env);
    c.set("user", {
      id: DEMO_USER_ID,
      githubUserId: 1,
      login: "demo-user",
      avatarUrl: "https://avatars.githubusercontent.com/u/9919?v=4",
      githubAccessToken: null,
      createdAtMs: Date.now() - 30 * 24 * 3600 * 1000,
    });
    await next();
    return;
  }

  const auth = createAuth(c.env);
  const session = await auth.api.getSession({ headers: c.req.raw.headers }).catch(() => null);
  if (!session) {
    return apiError(c, 401, "unauthorized", "Sign in via the web app or `simbox login`.");
  }

  const account = await getGithubAccount(createDb(c.env), session.user.id);
  const u = session.user as typeof session.user & { login?: string };
  const user: AuthUser = {
    id: session.user.id,
    githubUserId: account ? Number(account.accountId) : null,
    login: u.login ?? u.name,
    avatarUrl: session.user.image ?? null,
    githubAccessToken: account?.accessToken ?? null,
    createdAtMs: new Date(session.user.createdAt).getTime(),
  };
  c.set("user", user);
  await next();
});

/**
 * Authenticates the in-runner agent: Bearer SIMBOX_TOKEN → sha256 →
 * repos.simbox_token_hash. On success `repo` is set on the context.
 * (Runner tokens are not user auth — unchanged from hand-rolled auth.)
 */
export const requireRunnerToken = createMiddleware<AppContext>(async (c, next) => {
  const auth = c.req.header("Authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) {
    return apiError(c, 401, "unauthorized", "Missing SIMBOX_TOKEN bearer.");
  }
  const repo = await getRepoByTokenHash(createDb(c.env), await sha256Hex(token));
  if (!repo) {
    // Unknown token — never reveal whether a repo exists for it.
    return apiError(c, 403, "forbidden", "Invalid runner token.");
  }
  c.set("repo", repo);
  await next();
});

// ---------------------------------------------------------------------------
// DEMO_MODE — seeded preview data (dev only, never set in prod)
// ---------------------------------------------------------------------------

const DEMO_USER_ID = "demo-user-0001";
let demoSeeded = false;

async function seedDemo(env: Env): Promise<void> {
  if (demoSeeded) return;
  // Don't latch until inserts succeed — a failed seed (e.g. unmigrated DB)
  // must retry on the next request.
  const db = createDb(env);
  const now = Math.floor(Date.now() / 1000);
  // Fake repo + one live run with a tunnel/token so the dashboard renders
  // its full "live" state. Tunnel URL/token are obviously fake.
  const { repos, runs, user } = await import("@simbox/db/schema");
  // repos.user_id FKs to better-auth's "user" table — seed a demo user first.
  const ms = Date.now();
  await db
    .insert(user)
    .values({
      id: DEMO_USER_ID,
      name: "demo-user",
      email: "demo@simbox.touchtech.club",
      emailVerified: true,
      image: "https://avatars.githubusercontent.com/u/9919?v=4",
      login: "demo-user",
      createdAt: new Date(ms - 30 * 86400_000),
      updatedAt: new Date(ms),
    })
    .onConflictDoNothing();
  await db
    .insert(repos)
    .values({
      user_id: DEMO_USER_ID,
      repo_id: 123456,
      full_name: "demo-user/my-ios-app",
      private: 0,
      default_branch: "main",
      installation_id: 900001,
      state: "ok",
      simbox_token_hash: "demo",
      created_at: now - 86400 * 3,
    })
    .onConflictDoNothing();
  await db
    .insert(runs)
    .values({
      id: "demo-run-0001",
      user_id: DEMO_USER_ID,
      repo_full_name: "demo-user/my-ios-app",
      gh_run_id: 18234567890,
      state: "live",
      tunnel_url: "https://demo-tunnel.trycloudflare.com",
      daemon_token: "demo_daemon_token_9f8e7d6c5b",
      active_devices: 1,
      android_ready: 0,
      created_at: now - 900,
      dispatched_at: now - 900,
      live_at: now - 720,
      expires_at: now + 5 * 3600,
    })
    .onConflictDoNothing();
  demoSeeded = true;
}
