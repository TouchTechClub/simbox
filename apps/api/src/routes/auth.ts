import { Hono } from "hono";
import type { Context } from "hono";
import { createDb } from "@simbox/db";
import type { AppContext } from "../middleware";
import type { RepoRow } from "../db";
import { getRepoForUser } from "../db";
import { toPublicRepo, toPublicUser } from "../util";
import { requireUser } from "../middleware";

/**
 * Identity endpoints only — OAuth, session cookies, and the RFC 8628 device
 * flow are all handled by better-auth under /api/auth/* (see src/auth.ts and
 * the mount in src/index.ts).
 */
export const authRoutes = new Hono<AppContext>();

// GET /v1/me — identity for both surfaces (web cookie or CLI bearer token).
authRoutes.get("/v1/me", requireUser, async (c: Context<AppContext>) => {
  const user = c.get("user");
  const repo: RepoRow | null = await getRepoForUser(createDb(c.env), user.id);
  return c.json({ user: toPublicUser(user), repo: repo ? toPublicRepo(repo) : null });
});
