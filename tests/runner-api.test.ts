import { expect, test } from "bun:test";
import { createDb, schema } from "../packages/db/src/index";
import app from "../apps/api/src/index";
import { sha256Hex } from "../apps/api/src/util";
import { testD1 } from "./helpers/d1";
import { fakeGithub } from "./helpers/fake-github";
import {
  defaultWorkflowSpec,
  insertStep,
  renderWorkflow,
  WORKFLOW_YAML,
} from "../packages/shared/src/workflow";
import type { Env } from "../apps/api/src/env";

const LEGACY_WORKFLOW = `name: simbox
on:
  workflow_dispatch:
    inputs:
      platform: {type: choice, options: [ios, android]}
      runner_labels: {type: string}
`;

const CATALOG = {
  os: [
    { version: "35", name: "Android 15" },
    { version: "34", name: "Android 14" },
    { version: "30", name: "Android 11", models: ["pixel_6"] },
  ],
  models: [
    { id: "pixel_8", name: "Pixel 8" },
    { id: "pixel_6", name: "Pixel 6" },
    { id: "7.6in_foldable", name: "7.6in Foldable", foldable: true },
  ],
  defaults: { model: "pixel_8", os: "35" },
};

async function setup() {
  const storage = await testD1();
  const env = {
    DB: storage.DB,
    KV: storage.KV,
    API_URL: "http://localhost:8787",
    APP_URL: "http://localhost:5173",
    BETTER_AUTH_SECRET: "test-only-secret-at-least-thirty-two-characters",
    GITHUB_CLIENT_ID: "test",
    GITHUB_CLIENT_SECRET: "test",
    GITHUB_APP_ID: "test",
    GITHUB_APP_PRIVATE_KEY: "unused",
    GITHUB_WEBHOOK_SECRET: "whsec-test",
  } satisfies Env;
  const db = createDb(env);
  const waits: Promise<unknown>[] = [];
  const executionCtx = {
    waitUntil: (promise: Promise<unknown>) => waits.push(promise),
    passThroughOnException() {},
  } as unknown as ExecutionContext;
  const github = fakeGithub({ fullName: "owner/test", repoId: 1 });
  github.state.files.set("main", WORKFLOW_YAML);
  const original = globalThis.fetch;
  globalThis.fetch = github.fetch as typeof fetch;

  for (const id of ["user-a", "user-b"]) {
    await db.insert(schema.user).values({
      id,
      name: id,
      login: id,
      email: `${id}@test.invalid`,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(schema.session).values({
      id: `session-${id}`,
      userId: id,
      token: `token-${id}`,
      expiresAt: new Date(Date.now() + 86400_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(schema.account).values({
      id: `account-${id}`,
      accountId: id === "user-a" ? "11" : "12",
      providerId: "github",
      userId: id,
      accessToken: `gho-${id}`,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
  github.state.pushAccess.set("gho-user-a", true);
  await env.KV.put(
    "gh_inst_token:1",
    JSON.stringify({ token: "fake-installation-token", expiresAt: Date.now() / 1000 + 3600 }),
  );

  const call = async (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = { authorization: "Bearer token-user-a" },
  ) => {
    const response = await app.request(
      path,
      {
        method,
        headers: { ...headers, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      env,
      executionCtx,
    );
    await Promise.all(waits.splice(0));
    return { status: response.status, body: (await response.json()) as any };
  };
  const user = (path: string, body?: unknown, who = "user-a") =>
    call(body === undefined ? "GET" : "POST", path, body, {
      authorization: `Bearer token-${who}`,
    });
  const runner = (path: string, body: unknown) =>
    call("POST", path, body, { authorization: "Bearer runner-secret" });
  const webhook = async (event: string, payload: unknown) => {
    const raw = JSON.stringify(payload);
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(env.GITHUB_WEBHOOK_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = Buffer.from(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)),
    ).toString("hex");
    const response = await app.request(
      "/webhooks/github",
      {
        method: "POST",
        headers: { "x-github-event": event, "x-hub-signature-256": `sha256=${sig}` },
        body: raw,
      },
      env,
      executionCtx,
    );
    await Promise.all(waits.splice(0));
    return response.status;
  };
  const connectA = async () => {
    await db.insert(schema.repos).values({
      user_id: "user-a",
      repo_id: 1,
      full_name: "owner/test",
      installation_id: 1,
      state: "ok",
      created_at: 1,
      workflow_version: 2,
      simbox_token_hash: await sha256Hex("runner-secret"),
    });
  };
  const runRow = (id: string) =>
    storage.sqlite.query("select * from runs where id = ?").get(id) as any;
  const close = async () => {
    globalThis.fetch = original;
    await Promise.all(waits);
    storage.sqlite.close();
  };
  return { env, db, github, user, call, runner, webhook, connectA, runRow, storage, close };
}

test("runner and device settings layer by scope and stay per user", async () => {
  const t = await setup();
  try {
    await t.connectA();
    expect((await t.call("GET", "/v1/runners", undefined, {})).status).toBe(401);
    const initial = await t.user("/v1/runners");
    expect(initial.body.effective.android.source).toBe("default");
    expect(initial.body.devices.effective.ios).toEqual({ device: null, sources: {} });

    const account = { labels: ["blacksmith-2vcpu-ubuntu-2404"] };
    const repository = { labels: ["blacksmith-4vcpu-ubuntu-2404"] };
    expect(
      (await t.user("/v1/runners/account", { android: account })).body.effective.android.source,
    ).toBe("account");
    expect((await t.user("/v1/runners", undefined, "user-b")).body.account.android).toBeNull();
    expect((await t.user("/v1/runners/repo", { android: repository }, "user-b")).status).toBe(404);
    expect(
      (await t.user("/v1/runners/repo", { android: repository })).body.effective.android.source,
    ).toBe("repository");
    expect(
      (await t.user("/v1/runners/account", { android: { labels: ["${{ secrets.TOKEN }}"] } }))
        .status,
    ).toBe(400);
    expect((await t.user("/v1/runners/other", { android: null })).status).toBe(400);

    // Device defaults layer field by field: the repo's OS keeps the account's model.
    await t.user("/v1/devices/account", { ios: { model: "iPhone 16 Pro", os: "18.4" } });
    const layered = await t.user("/v1/devices/repo", { ios: { os: "17" } });
    expect(layered.body.devices.effective.ios).toEqual({
      device: { model: "iPhone 16 Pro", os: "17" },
      sources: { model: "account", os: "repository" },
    });
    expect((await t.user("/v1/devices/account", { ios: { xcode: "27.1" } })).body.error).toBe(
      "invalid_device",
    );
    expect((await t.user("/v1/devices/account", { android: { os: "fifteen" } })).status).toBe(400);
    expect(
      (await t.user("/v1/devices/repo", { ios: null })).body.devices.repository.ios,
    ).toBeNull();
  } finally {
    await t.close();
  }
});

test("iOS and Android runs are independent, correlated by run id, and only the matching platform is replaced", async () => {
  const t = await setup();
  try {
    await t.connectA();
    const ios = await t.user("/v1/runs/ensure", { platform: "ios" });
    expect(ios.status).toBe(200);
    expect(ios.body.state).toBe("dispatching");
    const android = await t.user("/v1/runs/ensure", {
      platform: "android",
      device: { model: "pixel_8" },
    });
    expect(android.status).toBe(200);
    expect(android.body.runId).not.toBe(ios.body.runId);
    expect(t.github.state.runs.map((r) => r.inputs)).toEqual([
      { platform: "ios", runner_labels: '["xcode-27"]', simbox_run: ios.body.runId },
      { platform: "android", runner_labels: '["ubuntu-latest"]', simbox_run: android.body.runId },
    ]);
    // Re-ensuring a platform reuses its run instead of dispatching again.
    expect((await t.user("/v1/runs/ensure", { platform: "ios" })).body.runId).toBe(ios.body.runId);
    expect(t.github.state.runs).toHaveLength(2);
    // Without a platform, two active runs default to iOS.
    expect((await t.user("/v1/runs/ensure", {})).body.runId).toBe(ios.body.runId);

    // Runner calls name their run: GitHub ids bind exactly, even out of order.
    const [ghIos, ghAndroid] = t.github.state.runs;
    const config = await t.runner("/v1/runs/config", {
      ghRunId: ghAndroid!.id,
      runId: android.body.runId,
    });
    expect(config.body).toEqual({
      platform: "android",
      device: { model: "pixel_8" },
      runId: android.body.runId,
    });
    expect(t.runRow(android.body.runId).gh_run_id).toBe(ghAndroid!.id);
    // A mismatched pair is refused.
    expect(
      (await t.runner("/v1/runs/config", { ghRunId: ghAndroid!.id, runId: ios.body.runId })).status,
    ).toBe(403);

    // Webhooks bind by the run id in the run name and ignore other workflows.
    const workflowRun = (run: typeof ghIos, extra: object = {}) => ({
      action: "in_progress",
      installation: { id: 1 },
      repository: { full_name: "owner/test" },
      workflow_run: {
        id: run!.id,
        status: "in_progress",
        conclusion: null,
        event: "workflow_dispatch",
        path: ".github/workflows/simbox.yml",
        display_title: run!.display_title,
        ...extra,
      },
    });
    expect(
      await t.webhook("workflow_run", workflowRun(ghIos, { path: ".github/workflows/ci.yml" })),
    ).toBe(200);
    expect(t.runRow(ios.body.runId).gh_run_id).toBeNull();
    expect(await t.webhook("workflow_run", workflowRun(ghIos))).toBe(200);
    expect(t.runRow(ios.body.runId)).toMatchObject({ gh_run_id: ghIos!.id, state: "booting" });

    // Register makes it live and starts the hard-exit clock there.
    expect(t.runRow(ios.body.runId).expires_at).toBeNull();
    const registered = await t.runner("/v1/runs/register", {
      ghRunId: ghIos!.id,
      runId: ios.body.runId,
      tunnelUrl: "https://ios.example.invalid",
      daemonToken: "daemon-ios",
      versions: { agent: "x", agentDevice: "x", cloudflared: "x" },
    });
    expect(registered.status).toBe(200);
    expect(t.runRow(ios.body.runId).expires_at).toBeGreaterThan(Date.now() / 1000 + 3600);
    // Readiness follows the agent's heartbeat when it reports one.
    const beatIos = (devicesReady: boolean) =>
      t.runner("/v1/runs/heartbeat", {
        ghRunId: ghIos!.id,
        runId: ios.body.runId,
        activeDevices: 1,
        androidReady: false,
        devicesReady,
      });
    await beatIos(false);
    expect((await t.user("/v1/runs/current?platform=ios")).body.run.devicesReady).toBe(false);
    expect((await beatIos(true)).status).toBe(200);
    // A late, out-of-order webhook never moves a live run backwards.
    await t.webhook("workflow_run", workflowRun(ghIos, { status: "queued" }));
    expect(t.runRow(ios.body.runId).state).toBe("live");

    const live = await t.user("/v1/runs/ensure", { platform: "ios" });
    expect(live.body).toMatchObject({
      state: "live",
      tunnelUrl: "https://ios.example.invalid",
      daemonToken: "daemon-ios",
    });

    // The runner reports its catalog and booted device.
    await t.runner("/v1/runs/inventory", {
      ghRunId: ghAndroid!.id,
      runId: android.body.runId,
      catalog: CATALOG,
      booted: { model: "pixel_8", os: "35", name: "Pixel 8", id: "emulator-5554" },
    });
    const active = await t.user("/v1/runs/active");
    expect(active.body.runs.map((r: any) => [r.platform, r.state, r.devicesReady])).toEqual([
      ["ios", "live", true],
      ["android", "dispatching", false],
    ]);
    expect(active.body.runs[1].bootedDevice).toMatchObject({ name: "Pixel 8" });
    expect((await t.user("/v1/runs/current?platform=ios")).body.run.id).toBe(ios.body.runId);
    const inventory = await t.user("/v1/inventory?platform=android");
    expect(inventory.body.inventory.models).toHaveLength(3);
    expect(inventory.body.runner).toEqual({ labels: ["ubuntu-latest"] });

    // Requests the runner cannot satisfy fail before dispatching anything.
    const impossible = await t.user("/v1/runs/ensure", {
      new: true,
      platform: "android",
      device: { model: "pixel_8", os: "30" },
    });
    expect(impossible.status).toBe(400);
    expect(impossible.body.error).toBe("invalid_device");
    expect(impossible.body.message).toContain("Pixel 8 cannot run OS 30");
    expect(t.runRow(android.body.runId).state).toBe("dispatching"); // invalid input never cancels

    // --new replaces only Android; iOS keeps running.
    const replaced = await t.user("/v1/runs/ensure", {
      new: true,
      platform: "android",
      device: { os: "oldest" },
    });
    expect(replaced.status).toBe(200);
    expect(t.runRow(android.body.runId)).toMatchObject({
      state: "closing",
      end_reason: "replaced",
    });
    expect(t.github.state.cancelled).toEqual([ghAndroid!.id]);
    expect(t.runRow(ios.body.runId).state).toBe("live");
    // The replaced agent learns its run is over.
    const beat = await t.runner("/v1/runs/heartbeat", {
      ghRunId: ghAndroid!.id,
      runId: android.body.runId,
      activeDevices: 0,
      androidReady: false,
    });
    expect(beat).toMatchObject({ status: 409, body: { error: "run_over" } });

    // Stop ends iOS through GitHub; the completed webhook finishes it.
    const stopped = await t.user(`/v1/runs/${ios.body.runId}/stop`, {});
    expect(stopped.body.run.state).toBe("closing");
    ghIos!.status = "completed";
    ghIos!.conclusion = "cancelled";
    await t.webhook(
      "workflow_run",
      workflowRun(ghIos, { status: "completed", conclusion: "cancelled" }),
    );
    expect(t.runRow(ios.body.runId)).toMatchObject({ state: "ended", end_reason: "stopped" });

    // Deregister ends only the run that asked.
    await t.runner("/v1/runs/deregister", {
      ghRunId: ghIos!.id,
      runId: ios.body.runId,
      reason: "idle",
    });
    expect(t.runRow(replaced.body.runId).state).toBe("dispatching");
    expect((await t.user("/v1/runs/current", undefined, "user-b")).body.run).toBeNull();
  } finally {
    await t.close();
  }
});

test("legacy workflows run one platform at a time and repair upgrades them", async () => {
  const t = await setup();
  try {
    await t.connectA();
    t.github.state.files.set("main", LEGACY_WORKFLOW);
    t.github.state.acceptsRunId = false;
    const ios = await t.user("/v1/runs/ensure", { platform: "ios" });
    expect(ios.status).toBe(200);
    expect(ios.body.state).toBe("queued"); // bound by the legacy poll
    expect(t.github.state.runs[0]!.inputs.simbox_run).toBeUndefined();
    expect(t.runRow(ios.body.runId).gh_run_id).toBe(t.github.state.runs[0]!.id);

    const android = await t.user("/v1/runs/ensure", { platform: "android" });
    expect(android).toMatchObject({ status: 409, body: { error: "workflow_needs_repair" } });
    expect(t.github.state.runs).toHaveLength(1);
    expect((await t.user("/v1/repo/status")).body.repo.workflowVersion).toBe(1);

    const doctor = await t.user("/v1/runners/doctor");
    expect(doctor.body.checks.find((c: any) => c.name === "workflow")).toMatchObject({ ok: false });

    // Repair commits the current workflow but keeps the runner token while a run is active.
    const before = t.runRow(ios.body.runId);
    const repaired = await t.user("/v1/repo/repair", {});
    expect(repaired.body.repo).toMatchObject({ state: "ok", workflowVersion: 2 });
    expect(t.github.state.files.get("main")).toBe(WORKFLOW_YAML);
    expect(t.github.state.secrets.size).toBe(0);
    expect(before.id).toBe(ios.body.runId);
    expect((await t.user("/v1/runners/doctor")).body.checks.every((c: any) => c.ok)).toBe(true);

    // Pre-runner-selection workflows never fall back to another runner.
    t.github.state.rejectAllInputs = true;
    const rejected = await t.user("/v1/runs/ensure", { new: true, platform: "ios" });
    expect(rejected).toMatchObject({ status: 409, body: { error: "workflow_needs_repair" } });
  } finally {
    await t.close();
  }
});

test("connect verifies push access and the installation; the workflow is editable around locked steps", async () => {
  const t = await setup();
  try {
    const connect = { repo_id: 1, full_name: "owner/test", installation_id: 1 };
    // user-b cannot push to owner/test.
    t.github.state.pushAccess.set("gho-user-b", false);
    expect((await t.user("/v1/repo/connect", connect, "user-b")).body.error).toBe("repo_forbidden");
    // A wrong id for the name is refused, so the client cannot mix repositories.
    expect((await t.user("/v1/repo/connect", { ...connect, repo_id: 2 })).body.error).toBe(
      "repo_not_found",
    );

    t.github.state.files.delete("main");
    t.github.state.protectedDefault = true;
    const created = await t.user("/v1/repo/connect", connect);
    expect(created.status).toBe(201);
    expect(created.body.repo).toMatchObject({
      state: "pending_pr",
      fullName: "owner/test",
      private: true,
    });
    expect(t.github.state.secrets.has("SIMBOX_TOKEN")).toBe(true);
    t.github.mergeSetupPr();
    expect((await t.user("/v1/repo/status")).body.repo).toMatchObject({
      state: "ok",
      prUrl: null,
      workflowVersion: 2,
    });

    // Another account cannot take over the same repository.
    t.github.state.pushAccess.set("gho-user-b", true);
    expect((await t.user("/v1/repo/connect", connect, "user-b")).body.error).toBe("repo_in_use");

    const shown = await t.user("/v1/workflow");
    expect(shown.body.status).toBe("current");
    const spec = insertStep(
      defaultWorkflowSpec(),
      { id: "build", name: "Build app", run: "npm ci && npm run build:ios", platform: "ios" },
      { before: "start" },
    );
    // Removing a locked step is refused.
    const broken = { ...spec, steps: spec.steps.filter((s: any) => s.simbox !== "serve") };
    expect((await t.call("PUT", "/v1/workflow", { spec: broken })).body.error).toBe(
      "invalid_workflow",
    );

    // Protected default branch: the edit waits in a PR, but runs keep working.
    const saved = await t.call("PUT", "/v1/workflow", { spec });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ repoState: "ok", status: "drifted" });
    expect(saved.body.prUrl).toContain("/pull/");
    expect(saved.body.yaml).toBe(renderWorkflow(spec));
    expect((await t.user("/v1/runs/ensure", { platform: "ios" })).status).toBe(200);
    t.github.mergeSetupPr();
    // Status checks GitHub at most once a minute.
    expect((await t.user("/v1/repo/status")).body.repo.prUrl).not.toBeNull();
    await t.env.KV.delete("repo_status_check:1");
    expect((await t.user("/v1/repo/status")).body.repo.prUrl).toBeNull();
    expect((await t.user("/v1/workflow")).body).toMatchObject({ status: "current", spec });

    // Only people with push access may change workflow steps.
    t.github.state.pushAccess.set("gho-user-a", false);
    expect((await t.call("PUT", "/v1/workflow", { spec: defaultWorkflowSpec() })).status).toBe(403);

    await t.user("/v1/repo/disconnect", {});
    expect(t.github.state.cancelled).toHaveLength(1);
    expect((await t.user("/v1/runners")).body.repository).toBeNull();
  } finally {
    await t.close();
  }
});

test("each caller keeps its run; full small runners send others to new runs, up to the limit", async () => {
  const t = await setup();
  try {
    await t.connectA();
    const ensure = (holder: string, body: object = {}) =>
      t.user("/v1/runs/ensure", { platform: "ios", holder, ...body });
    const goLive = async (runId: string, maxDevices?: number) => {
      const gh = t.github.state.runs.find((run) => run.inputs.simbox_run === runId)!;
      await t.runner("/v1/runs/config", { ghRunId: gh.id, runId });
      const registered = await t.runner("/v1/runs/register", {
        ghRunId: gh.id,
        runId,
        tunnelUrl: `https://${runId}.example.invalid`,
        daemonToken: `daemon-${runId}`,
        versions: { agent: "x", agentDevice: "x", cloudflared: "x" },
        ...(maxDevices ? { maxDevices } : {}),
      });
      expect(registered.status).toBe(200);
      return gh;
    };

    const a = await ensure("agent-a");
    expect(t.runRow(a.body.runId)).toMatchObject({ holder: "agent-a", max_devices: 1 });
    // A small runner's one slot is agent A's: agent B gets its own run.
    const b = await ensure("agent-b");
    expect(b.body.runId).not.toBe(a.body.runId);
    expect((await ensure("agent-a")).body.runId).toBe(a.body.runId);
    expect((await ensure("agent-b")).body.runId).toBe(b.body.runId);
    expect(t.github.state.runs).toHaveLength(2);

    // Each caller sees which runs are its own.
    const listed = await t.user("/v1/runs/active?holder=agent-b");
    expect(
      Object.fromEntries(listed.body.runs.map((run: any) => [run.id, [run.held, run.maxDevices]])),
    ).toEqual({ [b.body.runId]: [true, 1], [a.body.runId]: [false, 1] });
    expect((await t.user("/v1/runs/current?platform=ios&holder=agent-a")).body.run.id).toBe(
      a.body.runId,
    );

    // A bigger runner reports room for two devices and takes a second caller.
    await goLive(a.body.runId, 2);
    expect(t.runRow(a.body.runId).max_devices).toBe(2);
    const c = await ensure("agent-c");
    expect(c.body).toMatchObject({ state: "live", runId: a.body.runId });
    // Devices in use count even when no caller holds the run.
    const d = await ensure("agent-d");
    expect(d.body.runId).not.toBe(a.body.runId);
    expect(d.body.runId).not.toBe(b.body.runId);

    // Another device than a run has starts another run instead of failing.
    const foldable = await ensure("agent-a", { device: { foldable: true } });
    expect(foldable.status).toBe(200);
    expect(foldable.body.runId).not.toBe(a.body.runId);
    expect(JSON.parse(t.runRow(foldable.body.runId).device)).toEqual({ foldable: true });

    // Five iOS runs is the limit: the next caller shares the least-loaded one,
    // and an explicit fresh run is refused.
    const e = await ensure("agent-e");
    expect(t.github.state.runs).toHaveLength(5);
    expect(e.status).toBe(200);
    const f = await ensure("agent-f");
    expect(f.status).toBe(200);
    expect(t.github.state.runs).toHaveLength(5);
    const refused = await ensure("agent-g", { new: true });
    expect(refused).toMatchObject({ status: 409, body: { error: "run_limit" } });
    expect(refused.body.message).toContain("5 iOS runs are active");

    // An invalid holder is rejected before anything is dispatched.
    expect((await ensure("bad holder!")).status).toBe(400);
  } finally {
    await t.close();
  }
});

test("an ensure that loses the insert race reports the winning run", async () => {
  const t = await setup();
  try {
    await t.connectA();
    // Another ensure inserts its run after this one read the active runs.
    const get = t.env.KV.get.bind(t.env.KV);
    let raced = false;
    t.env.KV.get = (async (key: string, ...rest: unknown[]) => {
      if (!raced && key.startsWith("inventory:")) {
        raced = true;
        await t.db.insert(schema.runs).values({
          id: "winner",
          user_id: "user-a",
          repo_full_name: "owner/test",
          gh_run_id: null,
          state: "queued",
          platform: "android",
          holder: "default",
          created_at: Math.floor(Date.now() / 1000),
        });
      }
      return (get as (...args: unknown[]) => unknown)(key, ...rest);
    }) as typeof t.env.KV.get;
    const result = await t.user("/v1/runs/ensure", {
      platform: "android",
      device: { model: "pixel_8" },
    });
    expect(raced).toBe(true);
    expect(result.status).toBe(200);
    expect(result.body.runId).toBe("winner");
    expect(t.github.state.runs).toHaveLength(0);
  } finally {
    await t.close();
  }
});
