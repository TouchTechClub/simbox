import { Hono, type Context } from "hono";
import { eq } from "drizzle-orm";
import { createDb, schema } from "@simbox/db";
import {
  formatDeviceProfile,
  parseDevicePatch,
  parseRunnerInput,
  parseRunnerPatch,
  workflowStatus,
  type DevicePlatform,
  type InventoryResponse,
  type RunnerDiagnostics,
  type RunnerTarget,
} from "@simbox/shared";
import { requireUser, type AppContext } from "../middleware";
import { apiError } from "../util";
import { getRunnerSettings, readInventory } from "../runners";
import { getRepoForUser } from "../db";
import { installationToken, readWorkflowFile } from "../github";
import { repoSpec } from "../repo-workflow";

export const runnerRoutes = new Hono<AppContext>();
runnerRoutes.use("/v1/runners", requireUser);
runnerRoutes.use("/v1/runners/*", requireUser);
runnerRoutes.use("/v1/devices/*", requireUser);
runnerRoutes.use("/v1/inventory", requireUser);

runnerRoutes.get("/v1/runners", async (c) => {
  return c.json(await getRunnerSettings(createDb(c.env), c.get("user").id));
});

const WORKFLOW_MESSAGES = {
  current: "Workflow matches your Simbox workflow settings.",
  drifted:
    "Workflow differs from your Simbox settings (edited on GitHub?); run simbox repair to restore it.",
  outdated:
    "Workflow predates per-platform runs and device selection; run simbox repair and merge its PR if needed.",
  missing: "Workflow file is missing on the default branch; run simbox repair.",
} as const;

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
      const committed = await readWorkflowFile(token, repo.full_name, repo.default_branch);
      const status = workflowStatus(committed, repoSpec(repo));
      checks.push({
        name: "workflow",
        ok: status === "current",
        message: WORKFLOW_MESSAGES[status] + (repo.pr_url ? ` Pending change: ${repo.pr_url}` : ""),
      });
    } catch {
      checks.push({
        name: "workflow",
        ok: false,
        message:
          "Could not inspect the workflow. Check the GitHub App installation, permissions and default branch; run simbox repair if needed.",
      });
    }
    for (const platform of ["ios", "android"] as const) {
      const runner = settings.effective[platform].runner;
      const inventory = await readInventory(c.env, repo.repo_id, platform, runner);
      checks.push({
        name: `${platform} devices`,
        ok: true,
        message: inventory
          ? `${runner.labels.join(", ")} offers ${inventory.models.length} devices, OS ${inventory.os.map((os) => os.version).join(", ")}; default ${formatDeviceProfile(settings.devices.effective[platform].device, platform)}.`
          : `No device catalog for ${runner.labels.join(", ")} yet; it is reported by the first run on that runner.`,
      });
    }
  }
  return c.json({ settings, checks } satisfies RunnerDiagnostics);
});

function parseScope(scope: string): "account" | "repo" | null {
  return scope === "account" || scope === "repo" ? scope : null;
}

runnerRoutes.post("/v1/runners/:scope", async (c) => {
  const scope = parseScope(c.req.param("scope"));
  if (!scope) return apiError(c, 400, "invalid_scope", "scope must be account or repo.");
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
  const columns = {
    ...(patch.ios !== undefined ? { ios_runner: patch.ios } : {}),
    ...(patch.android !== undefined ? { android_runner: patch.android } : {}),
  };
  return saveSettings(c, scope, columns);
});

// POST /v1/devices/:scope {ios?: DeviceProfile|null, android?: …} — device
// defaults; null inherits. Xcode is a per-run choice, never a default.
runnerRoutes.post("/v1/devices/:scope", async (c) => {
  const scope = parseScope(c.req.param("scope"));
  if (!scope) return apiError(c, 400, "invalid_scope", "scope must be account or repo.");
  let patch;
  try {
    patch = parseDevicePatch(await c.req.json());
  } catch (err) {
    return apiError(
      c,
      400,
      "invalid_device",
      err instanceof Error ? err.message : "Invalid device settings.",
    );
  }
  const columns = {
    ...(patch.ios !== undefined ? { ios_device: patch.ios } : {}),
    ...(patch.android !== undefined ? { android_device: patch.android } : {}),
  };
  return saveSettings(c, scope, columns);
});

async function saveSettings(
  c: Context<AppContext>,
  scope: "account" | "repo",
  columns: Partial<typeof schema.runnerSettings.$inferInsert>,
) {
  const userId = c.get("user").id;
  const db = createDb(c.env);
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
}

// GET /v1/inventory?platform=ios&runner=<label | JSON array> — the device
// catalog a runner last reported. Runner omitted: the effective runner.
runnerRoutes.get("/v1/inventory", async (c) => {
  const platform = c.req.query("platform") as DevicePlatform | undefined;
  if (platform !== "ios" && platform !== "android")
    return apiError(c, 400, "invalid_platform", "platform must be ios or android.");
  const db = createDb(c.env);
  const userId = c.get("user").id;
  const repo = await getRepoForUser(db, userId);
  if (!repo) return apiError(c, 404, "no_repo", "Connect a repository first.");
  let runner: RunnerTarget;
  const raw = c.req.query("runner");
  try {
    runner = raw
      ? parseRunnerInput(raw, platform)
      : (await getRunnerSettings(db, userId)).effective[platform].runner;
  } catch (err) {
    return apiError(c, 400, "invalid_runner", (err as Error).message);
  }
  const inventory = await readInventory(c.env, repo.repo_id, platform, runner);
  return c.json({ platform, runner, inventory } satisfies InventoryResponse);
});
