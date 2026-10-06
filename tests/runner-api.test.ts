import { expect, test } from "bun:test";
import { createDb, schema } from "../packages/db/src/index";
import app from "../apps/api/src/index";
import { testD1 } from "./helpers/d1";
import { WORKFLOW_YAML } from "../packages/shared/src/constants";
import type { Env } from "../apps/api/src/env";

test("authenticated runner settings, dispatch, history and repair preserve ownership and precedence", async () => {
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
    GITHUB_WEBHOOK_SECRET: "unused",
  } satisfies Env;
  const db = createDb(env);
  const waits: Promise<unknown>[] = [];
  const executionCtx = {
    waitUntil: (promise: Promise<unknown>) => waits.push(promise),
    passThroughOnException() {},
  } as unknown as ExecutionContext;
  const original = globalThis.fetch;
  const dispatches: any[] = [];
  let legacyWorkflow = false;
  let rejectDispatch = false;
  let nextGhId = 100;
  try {
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
    }
    await db.insert(schema.repos).values({
      user_id: "user-a",
      repo_id: 1,
      full_name: "owner/test",
      installation_id: 1,
      state: "ok",
      created_at: 1,
      simbox_token_hash: "test",
    });
    await env.KV.put(
      "gh_inst_token:1",
      JSON.stringify({
        token: "fake-installation-token",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      }),
    );
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url)
        .pathname;
      if (path.endsWith("/dispatches")) {
        if (rejectDispatch)
          return Response.json(
            { message: "Unexpected inputs provided: runner_labels" },
            { status: 422 },
          );
        dispatches.push(JSON.parse(init?.body as string));
        nextGhId++;
        return new Response(null, { status: 204 });
      }
      if (path.endsWith("/runs"))
        return Response.json({ workflow_runs: [{ id: nextGhId, status: "queued" }] });
      if (path.endsWith("/cancel")) return new Response(null, { status: 204 });
      if (path.endsWith("/secrets/public-key"))
        return Response.json({
          key: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
          key_id: "test-key",
        });
      if (path.includes("/secrets/")) return new Response(null, { status: 204 });
      if (path.includes("/contents/")) {
        if (init?.method === "PUT") {
          legacyWorkflow = false;
          return Response.json({});
        }
        return Response.json({
          sha: "fake-sha",
          encoding: "base64",
          content: Buffer.from(legacyWorkflow ? "on: workflow_dispatch" : WORKFLOW_YAML).toString(
            "base64",
          ),
        });
      }
      if (path === "/repos/owner/test") return Response.json({});
      throw new Error(`Unexpected external call ${path}`);
    }) as typeof fetch;
    const request = async (path: string, body?: unknown, user = "user-a") => {
      const response = await app.request(
        path,
        {
          method: body === undefined ? "GET" : "POST",
          headers: { authorization: `Bearer token-${user}`, "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        env,
        executionCtx,
      );
      await Promise.all(waits.splice(0));
      return { status: response.status, body: (await response.json()) as any };
    };
    expect((await app.request("/v1/runners", {}, env, executionCtx)).status).toBe(401);
    const initial = await request("/v1/runners");
    expect(initial.status).toBe(200);
    expect(initial.body.effective.android.source).toBe("default");
    const account = { labels: ["blacksmith-2vcpu-ubuntu-2404"] };
    const repository = { labels: ["blacksmith-4vcpu-ubuntu-2404"] };
    expect(
      (await request("/v1/runners/account", { android: account })).body.effective.android.source,
    ).toBe("account");
    expect(
      (await request("/v1/runners/account", { ios: { labels: ["macos-latest"] } })).body.account
        .android,
    ).toEqual(account);
    expect((await request("/v1/runners", undefined, "user-b")).body.account.android).toBeNull();
    expect((await request("/v1/runners/repo", { android: repository }, "user-b")).status).toBe(404);
    expect(
      (await request("/v1/runners/repo", { android: repository })).body.effective.android.source,
    ).toBe("repository");
    expect(
      (await request("/v1/runners/account", { android: { labels: ["${{ secrets.TOKEN }}"] } }))
        .status,
    ).toBe(400);
    expect((await request("/v1/runners/account", { unexpected: null })).status).toBe(400);
    expect((await request("/v1/runners/other", { android: null })).status).toBe(400);
    expect((await request("/v1/runners/doctor")).body.checks.every((check: any) => check.ok)).toBe(
      true,
    );
    legacyWorkflow = true;
    expect(
      (await request("/v1/runners/doctor")).body.checks.find(
        (check: any) => check.name === "workflow",
      ).ok,
    ).toBe(false);

    rejectDispatch = true;
    const rejected = await request("/v1/runs/ensure", { platform: "android" });
    expect(rejected.status).toBe(409);
    expect(rejected.body.error).toBe("workflow_needs_repair");
    expect(dispatches).toHaveLength(0); // no fallback
    expect((await db.select().from(schema.runs)).length).toBe(0);
    rejectDispatch = false;
    expect((await request("/v1/repo/repair", {})).status).toBe(200);
    expect((await request("/v1/runners")).body.repository.android).toEqual(repository);
    expect((await request("/v1/runners")).body.account.android).toEqual(account);
    expect((await request("/v1/runners/doctor")).body.checks.every((check: any) => check.ok)).toBe(
      true,
    );

    const started = await request("/v1/runs/ensure", { platform: "android" });
    expect(started.status).toBe(200);
    expect(dispatches[0].inputs).toEqual({
      platform: "android",
      runner_labels: JSON.stringify(repository.labels),
    });
    let row = (await db.select().from(schema.runs)).find((run) => run.id === started.body.runId);
    expect(row?.runner).toEqual(repository);
    storage.sqlite
      .query(
        "UPDATE runs SET state='live', tunnel_url='https://fake.invalid', daemon_token='fake' WHERE id=?",
      )
      .run(started.body.runId);
    await request("/v1/runners/repo", { android: null });
    expect((await request("/v1/runs/ensure", { platform: "android" })).body.runId).toBe(
      started.body.runId,
    );
    expect(dispatches).toHaveLength(1);
    expect((await request("/v1/runs/current")).body.run.runner).toEqual(repository);
    expect(
      (await request("/v1/runs/ensure", { platform: "android", runner: account })).body.error,
    ).toBe("runner_mismatch");
    expect((await request("/v1/runs/ensure", { runner: account })).status).toBe(400);
    expect((await request("/v1/runs/ensure", { platform: "ios" })).body.error).toBe(
      "platform_mismatch",
    );
    expect(
      (
        await request("/v1/runs/ensure", {
          new: true,
          platform: "android",
          runner: { labels: ["windows-latest"] },
        })
      ).status,
    ).toBe(400);
    expect((await request("/v1/runs/current")).body.run.state).toBe("live"); // invalid input never cancels
    const next = await request("/v1/runs/ensure", {
      new: true,
      platform: "android",
      runner: { labels: ["ubuntu-latest"] },
    });
    expect(next.status).toBe(200);
    expect(dispatches[1].inputs.runner_labels).toBe('["ubuntu-latest"]');
    row = (await db.select().from(schema.runs)).find((run) => run.id === next.body.runId);
    expect(row?.runner).toEqual({ labels: ["ubuntu-latest"] });
    const history = await request("/v1/runs");
    expect(history.body.runs.find((run: any) => run.id === started.body.runId).runner).toEqual(
      repository,
    );
    expect((await request("/v1/runs/current", undefined, "user-b")).body.run).toBeNull();

    await request("/v1/repo/disconnect", {});
    const disconnected = await request("/v1/runners");
    expect(disconnected.body.repository).toBeNull();
    expect(disconnected.body.account.android).toEqual(account);
    expect(disconnected.body.effective.android.source).toBe("account");
  } finally {
    globalThis.fetch = original;
    await Promise.all(waits);
    storage.sqlite.close();
  }
}, 15_000);
