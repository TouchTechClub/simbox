import { expect, test } from "bun:test";
import { createDb, schema } from "../packages/db/src/index";
import app from "../apps/api/src/index";
import { sweepRunTunnels } from "../apps/api/src/tunnels";
import { sha256Hex } from "../apps/api/src/util";
import { testD1 } from "./helpers/d1";
import type { Env } from "../apps/api/src/env";

/** Just enough of Cloudflare's tunnel and DNS API to observe what the API does. */
function fakeCloudflare() {
  const tunnels = new Map<string, { id: string; name: string; created_at: string }>();
  const records = new Map<
    string,
    { id: string; name: string; content: string; comment: string; created_on: string }
  >();
  const configs = new Map<string, unknown>();
  let next = 0;
  const ok = (result: unknown) => Response.json({ success: true, errors: [], result });
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    if (url.hostname === "dns.google") {
      const name = url.searchParams.get("name");
      // runnerbox is delegated to Cloudflare; a lapsed zone gets no NS answer.
      return Response.json(
        name === "runnerbox.dpdns.org"
          ? { Status: 0, Answer: [{ type: 2, data: "vin.ns.cloudflare.com." }] }
          : { Status: 0, Authority: [{ type: 6, data: "ns1.dpdns.org." }] },
      );
    }
    const path = url.pathname.replace("/client/v4", "");
    if (path === "/zones") return ok([{ id: "zone-1", name: url.searchParams.get("name") }]);
    let m = path.match(/^\/accounts\/acct\/cfd_tunnel(?:\/([^/]+))?(?:\/(\w+))?$/);
    if (m) {
      const [, id, sub] = m;
      if (!id && method === "GET")
        return ok(
          [...tunnels.values()].filter(
            (t) => !url.searchParams.get("name") || t.name === url.searchParams.get("name"),
          ),
        );
      if (!id && method === "POST") {
        const tunnel = {
          id: `tunnel-${++next}`,
          name: body.name,
          created_at: new Date().toISOString(),
        };
        tunnels.set(tunnel.id, tunnel);
        return ok(tunnel);
      }
      if (!tunnels.has(id!)) return Response.json({ success: false, errors: [] }, { status: 404 });
      if (sub === "configurations") return ok(configs.set(id!, body.config) && {});
      if (sub === "token") return ok(`connector-token-for-${id}`);
      if (sub === "connections") return ok({});
      if (method === "DELETE") return ok(tunnels.delete(id!) && {});
    }
    m = path.match(/^\/zones\/zone-1\/dns_records(?:\/([^/]+))?$/);
    if (m) {
      const [, id] = m;
      if (!id && method === "GET")
        return ok(
          [...records.values()].filter(
            (r) => !url.searchParams.get("name") || r.name === url.searchParams.get("name"),
          ),
        );
      if (!id && method === "POST") {
        const record = { id: `dns-${++next}`, created_on: new Date().toISOString(), ...body };
        records.set(record.id, record);
        return ok(record);
      }
      if (!records.has(id!)) return Response.json({ success: false, errors: [] }, { status: 404 });
      if (method === "DELETE") return ok(records.delete(id!) && {});
    }
    throw new Error(`unexpected Cloudflare call ${method} ${path}`);
  };
  return { tunnels, records, configs, fetch };
}

test("runs get one named tunnel, foreign runs get none, and ended or orphaned tunnels are deleted", async () => {
  const storage = await testD1();
  const base = {
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
  const env = {
    ...base,
    CLOUDFLARE_ACCOUNT_ID: "acct",
    CLOUDFLARE_TUNNEL_API_TOKEN: "cf-token",
    TUNNEL_ZONE: "runnerbox.dpdns.org",
  } satisfies Env;
  const db = createDb(env);
  const waits: Promise<unknown>[] = [];
  const executionCtx = {
    waitUntil: (promise: Promise<unknown>) => waits.push(promise),
    passThroughOnException() {},
  } as unknown as ExecutionContext;
  const cloudflare = fakeCloudflare();
  const original = globalThis.fetch;
  globalThis.fetch = cloudflare.fetch as typeof fetch;
  const post = (path: string, body: unknown, target: Env = env) =>
    app.request(
      path,
      {
        method: "POST",
        headers: { authorization: "Bearer runner-secret", "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      target,
      executionCtx,
    );
  try {
    await db.insert(schema.user).values({
      id: "user-a",
      name: "user-a",
      login: "user-a",
      email: "user-a@test.invalid",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(schema.repos).values({
      user_id: "user-a",
      repo_id: 1,
      full_name: "owner/test",
      installation_id: 1,
      state: "ok",
      created_at: 1,
      simbox_token_hash: await sha256Hex("runner-secret"),
    });
    const now = Math.floor(Date.now() / 1000);
    await db.insert(schema.runs).values({
      id: "run-1",
      user_id: "user-a",
      repo_full_name: "owner/test",
      gh_run_id: 77,
      state: "booting",
      created_at: now,
      expires_at: now + 3600,
    });

    // Unconfigured deployments answer promptly so the agent uses a quick tunnel.
    expect((await post("/v1/runs/tunnel", { ghRunId: 77 }, base)).status).toBe(503);
    // A zone its parent no longer delegates would hand out unresolvable URLs.
    expect(
      (await post("/v1/runs/tunnel", { ghRunId: 77 }, { ...env, TUNNEL_ZONE: "lapsed.dpdns.org" }))
        .status,
    ).toBe(503);
    expect(cloudflare.tunnels.size).toBe(0);
    expect((await post("/v1/runs/tunnel", { ghRunId: 999 })).status).toBe(403);

    const first = await post("/v1/runs/tunnel", { ghRunId: 77 });
    expect(first.status).toBe(200);
    const named = (await first.json()) as { tunnelUrl: string; connectorToken: string };
    const hostname = new URL(named.tunnelUrl).hostname;
    expect(hostname).toMatch(/^r-[0-9a-f]{16}\.runnerbox\.dpdns\.org$/);
    const [tunnel] = cloudflare.tunnels.values();
    expect(tunnel!.name).toBe("simbox-run-run-1");
    expect(named.connectorToken).toBe(`connector-token-for-${tunnel!.id}`);
    expect(cloudflare.configs.get(tunnel!.id)).toEqual({
      ingress: [{ hostname, service: "http://127.0.0.1:4310" }, { service: "http_status:404" }],
    });
    const [record] = cloudflare.records.values();
    expect(record).toMatchObject({
      name: hostname,
      content: `${tunnel!.id}.cfargotunnel.com`,
      proxied: true,
    });

    // A retried request converges on the same tunnel and hostname.
    const again = (await (await post("/v1/runs/tunnel", { ghRunId: 77 })).json()) as {
      tunnelUrl: string;
    };
    expect(again.tunnelUrl).toBe(named.tunnelUrl);
    expect(cloudflare.tunnels.size).toBe(1);
    expect(cloudflare.records.size).toBe(1);

    // The agent's normal exit releases the tunnel and its DNS record.
    expect((await post("/v1/runs/deregister", { ghRunId: 77 })).status).toBe(200);
    await Promise.all(waits);
    expect(cloudflare.tunnels.size).toBe(0);
    expect(cloudflare.records.size).toBe(0);
    const run = storage.sqlite
      .query("select state, tunnel_id, tunnel_dns_record_id from runs where id = 'run-1'")
      .get();
    expect(run).toMatchObject({ state: "ended", tunnel_id: null, tunnel_dns_record_id: null });

    // The sweep deletes stale orphans but leaves ones that may be mid-provisioning.
    const old = new Date(Date.now() - 60 * 60_000).toISOString();
    cloudflare.tunnels.set("orphan", { id: "orphan", name: "simbox-run-gone", created_at: old });
    cloudflare.tunnels.set("young", {
      id: "young",
      name: "simbox-run-new",
      created_at: new Date().toISOString(),
    });
    cloudflare.tunnels.set("other", { id: "other", name: "s5code-tunnel", created_at: old });
    cloudflare.records.set("dns-orphan", {
      id: "dns-orphan",
      name: "r-0000000000000000.runnerbox.dpdns.org",
      content: "orphan.cfargotunnel.com",
      comment: "simbox run gone",
      created_on: old,
    });
    const swept = await sweepRunTunnels(env);
    expect(swept.orphans).toBe(2);
    expect([...cloudflare.tunnels.keys()].sort()).toEqual(["other", "young"]);
    expect(cloudflare.records.size).toBe(0);
  } finally {
    globalThis.fetch = original;
  }
});
