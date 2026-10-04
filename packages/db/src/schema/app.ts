import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { RepoState, RunState } from "@simbox/shared";
import { user } from "./auth";

/**
 * App tables — snake_case names/properties matching the original hand-written
 * SQL (migrations/0001+0003). Timestamps are unix SECONDS as integers (not
 * timestamp_ms) — the API does `created_at * 1000` when emitting contracts.
 */
export const installations = sqliteTable("installations", {
  installation_id: integer("installation_id").primaryKey(),
  account_login: text("account_login"),
  user_id: text("user_id").references(() => user.id),
  created_at: integer("created_at").notNull(),
});

export const repos = sqliteTable(
  "repos",
  {
    user_id: text("user_id")
      .primaryKey()
      .references(() => user.id),
    repo_id: integer("repo_id").notNull(),
    full_name: text("full_name").notNull(),
    private: integer("private").notNull().default(0),
    default_branch: text("default_branch").notNull().default("main"),
    installation_id: integer("installation_id").notNull(),
    state: text("state").$type<RepoState>().notNull().default("ok"),
    pr_url: text("pr_url"),
    simbox_token_hash: text("simbox_token_hash"),
    created_at: integer("created_at").notNull(),
  },
  (table) => [index("idx_repos_token_hash").on(table.simbox_token_hash)],
);

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id")
      .notNull()
      .references(() => user.id),
    repo_full_name: text("repo_full_name").notNull(),
    gh_run_id: integer("gh_run_id").unique(),
    state: text("state").$type<RunState>().notNull().default("dispatching"),
    tunnel_url: text("tunnel_url"),
    daemon_token: text("daemon_token"),
    active_devices: integer("active_devices").notNull().default(0),
    android_ready: integer("android_ready").notNull().default(0),
    created_at: integer("created_at").notNull(),
    dispatched_at: integer("dispatched_at"),
    live_at: integer("live_at"),
    ended_at: integer("ended_at"),
    expires_at: integer("expires_at"),
    end_reason: text("end_reason"),
  },
  (table) => [index("idx_runs_user_created").on(table.user_id, sql`${table.created_at} desc`)],
);
