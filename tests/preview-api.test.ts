import { expect, test } from "bun:test";
import { createDb, schema } from "../packages/db/src/index";
import app from "../apps/api/src/index";
import { verifyPreviewTicket, signPreviewTicket } from "../apps/api/src/preview-ticket";
import { testD1 } from "./helpers/d1";
import type { Env } from "../apps/api/src/env";

test("preview API owns every target, hides credentials, rejects origins and invalid/expired access", async () => {
  const storage = await testD1();
  const env: Env = {
    DB: storage.DB,
    KV: storage.KV,
    API_URL: "http://localhost:8787",
    APP_URL: "http://localhost:5173",
    BETTER_AUTH_SECRET: "test-only-preview-secret-thirty-two-characters",
    GITHUB_CLIENT_ID: "test",
    GITHUB_CLIENT_SECRET: "test",
    GITHUB_APP_ID: "test",
    GITHUB_APP_PRIVATE_KEY: "unused",
    GITHUB_WEBHOOK_SECRET: "unused",
  };
  const executionCtx = {
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext;
  const original = globalThis.fetch;
  const calls: Array<{ url: string; auth: string | null }> = [];
  let iosInventory = false;
  try {
    const db = createDb(env);
    for (const id of ["a", "b"]) {
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
    await db.insert(schema.runs).values({
      id: "android",
      user_id: "a",
      repo_full_name: "owner/repo",
      state: "live",
      platform: "android",
      created_at: 1,
      tunnel_url: "https://example.trycloudflare.com",
      daemon_token: "must-stay-private",
    });
    await db.insert(schema.runs).values({
      id: "ios",
      user_id: "a",
      repo_full_name: "owner/repo",
      state: "live",
      platform: "ios",
      created_at: 1,
      tunnel_url: "https://example.trycloudflare.com",
      daemon_token: "must-stay-private",
    });
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
      if (url.endsWith("/devices"))
        return Response.json({
          devices: [
            {
              id: iosInventory ? "ABCD-1234" : "emulator-5554",
              name: "simbox",
              platform: iosInventory ? "ios" : "android",
              version: "14",
            },
          ],
          observedAt: Date.now(),
        });
      if (url.includes("/video?"))
        return new Response(new Uint8Array([0, 0, 0, 2, 4, 1]), {
          headers: { "content-type": "application/octet-stream" },
        });
      throw new Error("Unexpected external call");
    }) as typeof fetch;
    const request = async (
      path: string,
      body?: unknown,
      user = "a",
      extra: Record<string, string> = {},
    ) =>
      app.request(
        path,
        {
          method: body === undefined ? "GET" : "POST",
          headers: {
            authorization: `Bearer token-${user}`,
            origin: env.APP_URL,
            "content-type": "application/json",
            ...extra,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        env,
        executionCtx,
      );
    expect(
      (await app.request("/v1/runs/android/preview/devices", {}, env, executionCtx)).status,
    ).toBe(401);
    expect((await request("/v1/runs/android/preview/devices", undefined, "b")).status).toBe(404);
    expect(calls).toHaveLength(0);
    const devices = await request("/v1/runs/android/preview/devices");
    expect(devices.status).toBe(200);
    expect(devices.headers.get("cache-control")).toContain("no-store");
    const observed = await devices.text();
    expect(observed).not.toContain("must-stay-private");
    expect(observed).not.toContain("trycloudflare");
    expect(calls[0]?.auth).toBe("Bearer must-stay-private");
    expect(
      (
        await request(
          "/v1/runs/android/preview/access",
          { device: "emulator-5554", control: true },
          "a",
          { origin: "https://evil.invalid" },
        )
      ).status,
    ).toBe(403);
    expect(
      (await request("/v1/runs/android/preview/access", { device: "../../exec", control: true }))
        .status,
    ).toBe(400);
    expect(
      (await request("/v1/runs/android/preview/access", { device: "emulator-5554" })).status,
    ).toBe(400);
    expect(
      (await request("/v1/runs/android/preview/access", { device: "other", control: false }))
        .status,
    ).toBe(409);
    const access = await request("/v1/runs/android/preview/access", {
      device: "emulator-5554",
      control: false,
    });
    const ticket = (await access.json()).ticket;
    expect(await verifyPreviewTicket(env.BETTER_AUTH_SECRET, ticket)).toMatchObject({
      userId: "a",
      runId: "android",
      control: false,
    });
    expect(
      (
        await request(`/v1/runs/android/preview/socket?ticket=${ticket}`, undefined, "a", {
          upgrade: "websocket",
          origin: "https://evil.invalid",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request("/v1/runs/android/preview/socket?ticket=invalid", undefined, "a", {
          upgrade: "websocket",
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(`/v1/runs/ios/preview/socket?ticket=${ticket}`, undefined, "a", {
          upgrade: "websocket",
        })
      ).status,
    ).toBe(401);
    expect((await request("/v1/runs/android/preview/video?device=emulator-5554")).status).toBe(409);
    expect((await request("/v1/runs/ios/preview/video?device=../../exec")).status).toBe(400);
    iosInventory = true;
    expect((await request("/v1/runs/ios/preview/video?device=missing")).status).toBe(409);
    const video = await request("/v1/runs/ios/preview/video?device=ABCD-1234");
    expect(video.status).toBe(200);
    expect(new Uint8Array(await video.arrayBuffer())).toHaveLength(6);
    expect(calls.at(-1)?.url).toBe(
      "https://example.trycloudflare.com/simbox-preview/video?platform=ios&device=ABCD-1234",
    );
    storage.sqlite.exec("UPDATE runs SET state='ended' WHERE id='android'");
    expect(
      (
        await request(`/v1/runs/android/preview/socket?ticket=${ticket}`, undefined, "a", {
          upgrade: "websocket",
        })
      ).status,
    ).toBe(409);
    expect((await request("/v1/runs/android/preview/devices")).status).toBe(409);
    const expired = await signPreviewTicket(
      env.BETTER_AUTH_SECRET,
      {
        userId: "a",
        runId: "android",
        device: "emulator-5554",
        platform: "android",
        control: true,
      },
      Date.now() - 120_000,
    );
    expect(
      (
        await request(`/v1/runs/android/preview/socket?ticket=${expired.ticket}`, undefined, "a", {
          upgrade: "websocket",
        })
      ).status,
    ).toBe(401);
  } finally {
    globalThis.fetch = original;
    storage.sqlite.close();
  }
});
