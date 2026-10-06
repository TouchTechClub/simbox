import { eq } from "drizzle-orm";
import { schema, type Database } from "@simbox/db";
import { emptyRunnerPreferences, resolveRunner, type RunnerSettings } from "@simbox/shared";
import { getRepoForUser } from "./db";

export async function getRunnerSettings(db: Database, userId: string): Promise<RunnerSettings> {
  const [account, repo] = await Promise.all([
    db.select().from(schema.runnerSettings).where(eq(schema.runnerSettings.user_id, userId)).get(),
    getRepoForUser(db, userId),
  ]);
  const defaults = account
    ? { ios: account.ios_runner, android: account.android_runner }
    : emptyRunnerPreferences();
  const overrides = repo ? { ios: repo.ios_runner, android: repo.android_runner } : null;
  return {
    account: defaults,
    repository: overrides,
    repoFullName: repo?.full_name ?? null,
    effective: {
      ios: resolveRunner("ios", defaults, overrides),
      android: resolveRunner("android", defaults, overrides),
    },
  };
}
