import type { Database } from "@simbox/db";
import { schema } from "@simbox/db";
import { and, desc, eq } from "drizzle-orm";

const { account, repos, runs, installations } = schema;

/**
 * The authenticated caller, normalized off the better-auth session `user`
 * plus their linked GitHub `account` row. `user.id` is better-auth's TEXT id;
 * `repos.user_id` / `runs.user_id` / `installations.user_id` all point at it.
 */
export interface AuthUser {
  id: string;
  githubUserId: number | null;
  login: string;
  avatarUrl: string | null;
  /** OAuth access token from account.accessToken (providerId = 'github'). */
  githubAccessToken: string | null;
  /** better-auth user.createdAt, epoch milliseconds. */
  createdAtMs: number;
}

/** Row shapes are inferred from the drizzle schema (app tables are snake_case). */
export type InstallationRow = typeof installations.$inferSelect;
export type RepoRow = typeof repos.$inferSelect;
export type RunRow = typeof runs.$inferSelect;

/** better-auth `account` row (camelCase drizzle props), the fields we read. */
export interface GithubAccountRow {
  accountId: string;
  accessToken: string | null;
}

/**
 * The GitHub OAuth account linked to a better-auth user. `accountId` is the
 * GitHub user id (TEXT); `accessToken` is the user OAuth token needed by
 * GET /user/installations (repo picker).
 */
export async function getGithubAccount(
  db: Database,
  userId: string,
): Promise<GithubAccountRow | null> {
  const row = await db
    .select({ accountId: account.accountId, accessToken: account.accessToken })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, "github")))
    .orderBy(desc(account.createdAt))
    .limit(1)
    .get();
  return row ?? null;
}

export async function getRepoForUser(db: Database, userId: string): Promise<RepoRow | null> {
  const row = await db.select().from(repos).where(eq(repos.user_id, userId)).get();
  return row ?? null;
}

export async function getRepoByTokenHash(db: Database, tokenHash: string): Promise<RepoRow | null> {
  const row = await db.select().from(repos).where(eq(repos.simbox_token_hash, tokenHash)).get();
  return row ?? null;
}
