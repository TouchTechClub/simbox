/**
 * Named Cloudflare tunnels for runs — the same model S5's relay uses for
 * managed endpoints. A quick tunnel holds one edge connection, so every edge
 * drop on a flaky runner is a full outage and a restart changes the URL. A
 * named tunnel keeps several connections and one hostname for the whole run.
 *
 * Per run: a remotely-managed tunnel `simbox-run-<runId>` routing a random
 * `r-<hex>.<TUNNEL_ZONE>` to the runner's gateway, a proxied CNAME to
 * `<tunnelId>.cfargotunnel.com`, and a connector token the agent passes to
 * cloudflared. Cleanup deletes both once the run ends; a cron sweep catches
 * runners that never deregistered and anything a failed request left behind.
 */
import { and, eq, isNotNull, or, inArray, lt } from "drizzle-orm";
import { createDb, schema } from "@simbox/db";
import type { Database } from "@simbox/db";
import { PROXY_PORT } from "@simbox/shared";
import type { Env } from "./env";
import type { RunRow } from "./db";
import { nowSeconds, randomTokenHex } from "./util";

const API = "https://api.cloudflare.com/client/v4";
export const TUNNEL_NAME_PREFIX = "simbox-run-";
const DNS_COMMENT_PREFIX = "simbox run ";
/** Never sweep a tunnel this young: its provisioning request may still be running. */
const ORPHAN_MIN_AGE_SECONDS = 15 * 60;

type TunnelEnv = Pick<
  Env,
  "DB" | "KV" | "CLOUDFLARE_ACCOUNT_ID" | "CLOUDFLARE_TUNNEL_API_TOKEN"
> & {
  TUNNEL_ZONE?: string;
};

export class CloudflareError extends Error {
  constructor(
    readonly status: number,
    readonly codes: number[],
    message: string,
  ) {
    super(message);
    this.name = "CloudflareError";
  }
}

export function tunnelsConfigured(env: TunnelEnv): boolean {
  return !!(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_TUNNEL_API_TOKEN && tunnelZone(env));
}

/**
 * Whether the public internet resolves the tunnel zone through Cloudflare.
 * Cloudflare keeps reporting a zone as active after its parent stops
 * delegating to it (a lapsed free subdomain), and cloudflared still connects,
 * so without this check every runner would register a URL nobody can resolve.
 */
export async function tunnelZoneDelegated(env: TunnelEnv): Promise<boolean> {
  const zone = tunnelZone(env);
  const key = `cf_zone_delegated:${zone}`;
  const cached = await env.KV.get(key);
  if (cached) return cached === "1";
  let delegated = false;
  try {
    const res = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(zone)}&type=NS`, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(5_000),
    });
    const json = (await res.json()) as {
      Status?: number;
      Answer?: Array<{ type: number; data: string }>;
    };
    delegated =
      json.Status === 0 &&
      (json.Answer ?? []).some((a) => a.type === 2 && /\.ns\.cloudflare\.com\.?$/i.test(a.data));
  } catch {
    // Unknown is treated as undelegated: a quick tunnel always works.
  }
  await env.KV.put(key, delegated ? "1" : "0", { expirationTtl: delegated ? 3_600 : 300 });
  return delegated;
}

function tunnelZone(env: TunnelEnv): string {
  return (env.TUNNEL_ZONE ?? "").trim().toLowerCase();
}

/** True for hostnames this deployment hands out — one label under the zone. */
export function isRunTunnelHostname(hostname: string, zone: string): boolean {
  const suffix = `.${zone.toLowerCase()}`;
  return (
    !!zone &&
    hostname.endsWith(suffix) &&
    /^r-[0-9a-f]{16}$/.test(hostname.slice(0, -suffix.length))
  );
}

async function cf<T>(env: TunnelEnv, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env.CLOUDFLARE_TUNNEL_API_TOKEN}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => null)) as {
    success?: boolean;
    result?: T;
    errors?: Array<{ code: number; message: string }>;
  } | null;
  if (!res.ok || !json?.success) {
    const errors = json?.errors ?? [];
    throw new CloudflareError(
      res.status,
      errors.map((e) => e.code),
      `Cloudflare ${method} ${path.replace(/[0-9a-f-]{32,36}/g, ":id")} failed (${res.status}): ${errors
        .map((e) => e.message)
        .join("; ")
        .slice(0, 300)}`,
    );
  }
  return json.result as T;
}

const notFound = (error: unknown) => error instanceof CloudflareError && error.status === 404;

async function zoneId(env: TunnelEnv): Promise<string> {
  const zone = tunnelZone(env);
  const key = `cf_zone:${zone}`;
  const cached = await env.KV.get(key);
  if (cached) return cached;
  const zones = await cf<Array<{ id: string; name: string }>>(
    env,
    "GET",
    `/zones?name=${encodeURIComponent(zone)}`,
  );
  const id = zones.find((z) => z.name === zone)?.id;
  if (!id) throw new Error(`Tunnel zone ${zone} is not visible to the tunnel API token`);
  await env.KV.put(key, id, { expirationTtl: 86_400 });
  return id;
}

interface CfTunnel {
  id: string;
  name: string;
  created_at: string;
  deleted_at?: string | null;
}

async function findTunnel(env: TunnelEnv, name: string): Promise<CfTunnel | null> {
  const tunnels = await cf<CfTunnel[]>(
    env,
    "GET",
    `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel?is_deleted=false&name=${encodeURIComponent(name)}`,
  );
  return tunnels.find((t) => t.name === name) ?? null;
}

/**
 * Provision (or re-issue) this run's tunnel. Idempotent: a retry after any
 * partial failure converges on the same tunnel and hostname.
 */
export async function provisionRunTunnel(
  env: TunnelEnv,
  db: Database,
  run: RunRow,
): Promise<{ tunnelUrl: string; connectorToken: string }> {
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  const hostname = run.tunnel_hostname ?? `r-${randomTokenHex(8)}.${tunnelZone(env)}`;
  const name = `${TUNNEL_NAME_PREFIX}${run.id}`;

  let tunnelId = run.tunnel_id;
  if (!tunnelId) {
    const existing = await findTunnel(env, name);
    tunnelId =
      existing?.id ??
      (
        await cf<CfTunnel>(env, "POST", `/accounts/${account}/cfd_tunnel`, {
          name,
          config_src: "cloudflare",
        })
      ).id;
    // Recorded before anything else can fail, so cleanup always finds it.
    await db
      .update(schema.runs)
      .set({ tunnel_id: tunnelId, tunnel_hostname: hostname })
      .where(eq(schema.runs.id, run.id));
  }

  await cf(env, "PUT", `/accounts/${account}/cfd_tunnel/${tunnelId}/configurations`, {
    config: {
      ingress: [
        { hostname, service: `http://127.0.0.1:${PROXY_PORT}` },
        { service: "http_status:404" },
      ],
    },
  });

  if (!run.tunnel_dns_record_id) {
    const zone = await zoneId(env);
    const record = {
      type: "CNAME",
      name: hostname,
      content: `${tunnelId}.cfargotunnel.com`,
      proxied: true,
      ttl: 1,
      comment: `${DNS_COMMENT_PREFIX}${run.id}`,
    };
    const existing = await cf<Array<{ id: string }>>(
      env,
      "GET",
      `/zones/${zone}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}`,
    );
    const recordId = existing[0]
      ? (
          await cf<{ id: string }>(
            env,
            "PUT",
            `/zones/${zone}/dns_records/${existing[0].id}`,
            record,
          )
        ).id
      : (await cf<{ id: string }>(env, "POST", `/zones/${zone}/dns_records`, record)).id;
    await db
      .update(schema.runs)
      .set({ tunnel_dns_record_id: recordId })
      .where(eq(schema.runs.id, run.id));
  }

  const connectorToken = await cf<string>(
    env,
    "GET",
    `/accounts/${account}/cfd_tunnel/${tunnelId}/token`,
  );
  return { tunnelUrl: `https://${hostname}`, connectorToken };
}

async function deleteTunnel(env: TunnelEnv, tunnelId: string): Promise<void> {
  const base = `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel/${tunnelId}`;
  // A tunnel with live connectors cannot be deleted; drop them first.
  await cf(env, "DELETE", `${base}/connections`).catch((error) => {
    if (!notFound(error)) throw error;
  });
  await cf(env, "DELETE", base).catch((error) => {
    if (!notFound(error)) throw error;
  });
}

/** Delete a run's DNS record and tunnel; columns clear only once both are gone. */
export async function releaseRunTunnel(env: TunnelEnv, db: Database, run: RunRow): Promise<void> {
  if (!tunnelsConfigured(env) || (!run.tunnel_id && !run.tunnel_dns_record_id)) return;
  if (run.tunnel_dns_record_id) {
    const zone = await zoneId(env);
    await cf(env, "DELETE", `/zones/${zone}/dns_records/${run.tunnel_dns_record_id}`).catch(
      (error) => {
        if (!notFound(error)) throw error;
      },
    );
    await db
      .update(schema.runs)
      .set({ tunnel_dns_record_id: null })
      .where(eq(schema.runs.id, run.id));
  }
  if (run.tunnel_id) {
    await deleteTunnel(env, run.tunnel_id);
    await db.update(schema.runs).set({ tunnel_id: null }).where(eq(schema.runs.id, run.id));
  }
}

/**
 * Cron cleanup. Ended or expired runs release their tunnels; tunnels and DNS
 * records with no live run behind them (a crashed request, a lost DB write)
 * are deleted once they are old enough not to be mid-provisioning.
 */
export async function sweepRunTunnels(
  env: TunnelEnv,
): Promise<{ released: number; orphans: number }> {
  if (!tunnelsConfigured(env)) return { released: 0, orphans: 0 };
  const db = createDb(env);
  const now = nowSeconds();
  let released = 0;
  let orphans = 0;

  const stale = await db
    .select()
    .from(schema.runs)
    .where(
      and(
        or(isNotNull(schema.runs.tunnel_id), isNotNull(schema.runs.tunnel_dns_record_id)),
        or(inArray(schema.runs.state, ["ended", "failed"]), lt(schema.runs.expires_at, now)),
      ),
    )
    .limit(50)
    .all();
  for (const run of stale) {
    try {
      await releaseRunTunnel(env, db, run);
      released++;
    } catch (error) {
      console.error("tunnel release failed", run.id, String(error));
    }
  }

  const liveTunnelIds = new Set(
    (
      await db
        .select({ id: schema.runs.tunnel_id })
        .from(schema.runs)
        .where(
          and(
            isNotNull(schema.runs.tunnel_id),
            inArray(schema.runs.state, ["dispatching", "queued", "booting", "live", "closing"]),
          ),
        )
        .all()
    ).map((row) => row.id),
  );
  const tunnels = await cf<CfTunnel[]>(
    env,
    "GET",
    `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel?is_deleted=false&per_page=1000`,
  );
  const youngEnough = (createdAt: string) =>
    now - Math.floor(Date.parse(createdAt) / 1000) < ORPHAN_MIN_AGE_SECONDS;
  for (const tunnel of tunnels) {
    if (!tunnel.name.startsWith(TUNNEL_NAME_PREFIX) || liveTunnelIds.has(tunnel.id)) continue;
    if (youngEnough(tunnel.created_at)) continue;
    try {
      await deleteTunnel(env, tunnel.id);
      orphans++;
    } catch (error) {
      console.error("orphan tunnel delete failed", tunnel.id, String(error));
    }
  }

  const zone = await zoneId(env);
  const records = await cf<
    Array<{ id: string; content: string; comment?: string | null; created_on: string }>
  >(env, "GET", `/zones/${zone}/dns_records?type=CNAME&per_page=1000`);
  for (const record of records) {
    if (!record.comment?.startsWith(DNS_COMMENT_PREFIX)) continue;
    const tunnelId = record.content.replace(/\.cfargotunnel\.com$/, "");
    if (liveTunnelIds.has(tunnelId) || youngEnough(record.created_on)) continue;
    await cf(env, "DELETE", `/zones/${zone}/dns_records/${record.id}`).catch((error) => {
      if (!notFound(error)) console.error("orphan DNS delete failed", record.id, String(error));
    });
    orphans++;
  }
  return { released, orphans };
}
