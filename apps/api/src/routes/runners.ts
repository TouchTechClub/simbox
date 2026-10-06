import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { createDb, schema } from "@simbox/db";
import { parseRunnerPatch, WORKFLOW_PATH, type RunnerDiagnostics } from "@simbox/shared";
import { requireUser, type AppContext } from "../middleware";
import { apiError, base64ToBytes } from "../util";
import { getRunnerSettings } from "../runners";
import { getRepoForUser } from "../db";
import { gh, installationToken } from "../github";

export const runnerRoutes = new Hono<AppContext>();
runnerRoutes.use("/v1/runners", requireUser);
runnerRoutes.use("/v1/runners/*", requireUser);

runnerRoutes.get("/v1/runners", async (c) => {
  return c.json(await getRunnerSettings(createDb(c.env), c.get("user").id));
});

runnerRoutes.get("/v1/runners/doctor", async (c) => {
  const db = createDb(c.env);
  const userId = c.get("user").id;
  const settings = await getRunnerSettings(db, userId);
  const repo = await getRepoForUser(db, userId);
  const checks: RunnerDiagnostics["checks"] = [];
  checks.push({
    name: "repository",
    ok: repo?.state === "ok",
    message: repo
      ? `${repo.full_name}: ${repo.state}${repo.state === "pending_pr" ? "; merge the setup PR" : ""}`
      : "No repository connected; run simbox init.",
  });
  if (repo) {
    try {
      const token = await installationToken(c.env, repo.installation_id);
      const file = await gh<{ content?: string; encoding?: string }>(
        token,
        `/repos/${repo.full_name}/contents/${WORKFLOW_PATH}?ref=${encodeURIComponent(repo.default_branch)}`,
      );
      const yaml =
        file.encoding === "base64" && file.content
          ? new TextDecoder().decode(base64ToBytes(file.content.replace(/\s/g, "")))
          : "";
      const ok =
        /\brunner_labels:\s*\n/.test(yaml) && yaml.includes("fromJSON(inputs.runner_labels");
      checks.push({
        name: "workflow",
        ok,
        message: ok
          ? "Runner-label dispatch input installed."
          : "Workflow lacks runner selection; run simbox repair and merge its PR if needed.",
      });
    } catch {
      checks.push({
        name: "workflow",
        ok: false,
        message:
          "Could not inspect the workflow. Check the GitHub App installation, permissions and default branch; run simbox repair if needed.",
      });
    }
  }
  return c.json({ settings, checks } satisfies RunnerDiagnostics);
});

runnerRoutes.post("/v1/runners/:scope", async (c) => {
  const scope = c.req.param("scope");
  if (scope !== "account" && scope !== "repo")
    return apiError(c, 400, "invalid_scope", "scope must be account or repo.");
  let patch;
  try {
    patch = parseRunnerPatch(await c.req.json());
  } catch (err) {
    return apiError(
      c,
      400,
      "invalid_runner",
      err instanceof Error ? err.message : "Invalid runner settings.",
    );
  }
  const userId = c.get("user").id;
  const db = createDb(c.env);
  const columns = {
    ...(patch.ios !== undefined ? { ios_runner: patch.ios } : {}),
    ...(patch.android !== undefined ? { android_runner: patch.android } : {}),
  };
  if (scope === "account") {
    await db
      .insert(schema.runnerSettings)
      .values({ user_id: userId, ...columns })
      .onConflictDoUpdate({ target: schema.runnerSettings.user_id, set: columns });
  } else {
    if (!(await getRepoForUser(db, userId)))
      return apiError(c, 404, "no_repo", "Connect a repository before setting overrides.");
    await db.update(schema.repos).set(columns).where(eq(schema.repos.user_id, userId));
  }
  return c.json(await getRunnerSettings(db, userId));
});
