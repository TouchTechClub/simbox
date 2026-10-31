import { Hono, type Context } from "hono";
import { eq } from "drizzle-orm";
import { createDb, schema } from "@simbox/db";
import { leaseInventory, validPreviewDevice, type PreviewInventory } from "@simbox/shared";
import { requireUser, type AppContext } from "../middleware";
import type { RunRow } from "../db";
import { signPreviewTicket, verifyPreviewTicket, bridgePreviewSockets } from "../preview-ticket";

export const previewRoutes = new Hono<AppContext>();
const NO_CACHE = {
  "cache-control": "no-store, no-transform",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};
const failure = (message: string, status: number) =>
  Response.json({ error: "preview_unavailable", message }, { status, headers: NO_CACHE });

async function ownedRun(
  c: Context<AppContext>,
  userId: string,
  runId: string,
): Promise<RunRow | null> {
  const run = await createDb(c.env)
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.id, runId))
    .get();
  return run?.user_id === userId ? run : null;
}
function available(
  run: RunRow | null,
): run is RunRow & { tunnel_url: string; daemon_token: string } {
  return (
    !!run &&
    run.state === "live" &&
    !!run.tunnel_url &&
    !!run.daemon_token &&
    (run.expires_at === null || run.expires_at * 1000 > Date.now())
  );
}
/** A path on the run's Simlock daemon, only ever through the run's own named tunnel. */
function upstreamUrl(run: RunRow, path: string): string {
  const origin = new URL(run.tunnel_url!);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.port ||
    !run.tunnel_hostname ||
    origin.hostname !== run.tunnel_hostname
  )
    throw new Error("Invalid tunnel");
  return `${origin.origin}/v1/${path}`;
}
const upstreamHeaders = (run: RunRow) => ({
  authorization: `Bearer ${run.daemon_token}`,
  // Cloudflare's Browser Integrity Check refuses some default user agents.
  "user-agent": "simbox-api/1",
});
async function simlockJson(run: RunRow, path: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(upstreamUrl(run, path), {
    headers: upstreamHeaders(run),
    redirect: "manual",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Simlock answered ${response.status}`);
  }
  return response.json();
}
/** The run's leased devices; a lease is what can be streamed. */
async function inventory(run: RunRow, signal?: AbortSignal): Promise<PreviewInventory> {
  const booted = run.booted_device;
  return leaseInventory(await simlockJson(run, "leases", signal), run.platform, {
    name: booted?.model,
    version: booted?.os,
  });
}

previewRoutes.get("/v1/runs/:id/preview/devices", requireUser, async (c) => {
  const run = await ownedRun(c, c.get("user").id, c.req.param("id"));
  if (!run) return failure("Run not found", 404);
  if (!available(run)) return failure("The run is not live", 409);
  try {
    return c.json(await inventory(run, c.req.raw.signal), { headers: NO_CACHE });
  } catch {
    return failure(
      "Device preview unavailable: the run's Simlock daemon did not answer. Retry shortly.",
      503,
    );
  }
});

previewRoutes.post("/v1/runs/:id/preview/access", requireUser, async (c) => {
  if (c.req.header("origin") && c.req.header("origin") !== c.env.APP_URL)
    return failure("Origin not allowed", 403);
  const body = (await c.req.json().catch(() => null)) as {
    device?: unknown;
    control?: unknown;
  } | null;
  if (!body || !validPreviewDevice(body.device) || typeof body.control !== "boolean")
    return failure("Choose a device and explicit control mode", 400);
  const run = await ownedRun(c, c.get("user").id, c.req.param("id"));
  if (!run) return failure("Run not found", 404);
  if (!available(run)) return failure("The run is not live", 409);
  try {
    const observed = await inventory(run, c.req.raw.signal);
    if (!observed.devices.some((device) => device.id === body.device))
      return failure("Device is no longer active", 409);
    return c.json(
      await signPreviewTicket(c.env.BETTER_AUTH_SECRET, {
        userId: c.get("user").id,
        runId: run.id,
        platform: run.platform,
        device: body.device,
        control: body.control,
      }),
      { headers: NO_CACHE },
    );
  } catch {
    return failure("Device preview unavailable", 503);
  }
});

// A short, run/device/mode-bound ticket is needed because browsers cannot set
// Authorization on WebSocket upgrades. Never expose daemon tokens to the panel.
previewRoutes.get("/v1/runs/:id/preview/socket", async (c) => {
  if (c.req.header("origin") !== c.env.APP_URL) return failure("Origin not allowed", 403);
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket")
    return failure("WebSocket upgrade required", 426);
  const claims = await verifyPreviewTicket(c.env.BETTER_AUTH_SECRET, c.req.query("ticket") ?? "");
  if (!claims || claims.runId !== c.req.param("id"))
    return failure("Preview access expired; reconnect", 401);
  const run = await ownedRun(c, claims.userId, claims.runId);
  if (!available(run) || run.platform !== claims.platform)
    return failure("The run is no longer live", 409);
  try {
    const upstream = await fetch(
      upstreamUrl(run, `leases/${encodeURIComponent(claims.device)}/input`),
      { headers: { ...upstreamHeaders(run), upgrade: "websocket" }, redirect: "manual" },
    );
    if (upstream.status !== 101 || !upstream.webSocket) {
      await upstream.body?.cancel();
      return failure(
        upstream.status === 404 ? "The device's lease has ended" : "Preview socket unavailable",
        upstream.status === 404 ? 409 : 502,
      );
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    upstream.webSocket.accept();
    bridgePreviewSockets(server, upstream.webSocket, claims.control);
    return new Response(null, { status: 101, webSocket: client, headers: NO_CACHE });
  } catch {
    return failure(
      "Preview socket unavailable; reconnect to inspect before retrying any action",
      502,
    );
  }
});

// The lease's H.264 stream (`[u32 len][u8 tag]` frames), on both platforms.
previewRoutes.get("/v1/runs/:id/preview/video", requireUser, async (c) => {
  const device = c.req.query("device");
  if (!validPreviewDevice(device)) return failure("Invalid device", 400);
  const run = await ownedRun(c, c.get("user").id, c.req.param("id"));
  if (!run) return failure("Run not found", 404);
  if (!available(run)) return failure("The run is not live", 409);
  try {
    if (!(await inventory(run, c.req.raw.signal)).devices.some((item) => item.id === device))
      return failure("Device is no longer active", 409);
    const response = await fetch(upstreamUrl(run, `leases/${encodeURIComponent(device)}/stream`), {
      headers: upstreamHeaders(run),
      redirect: "manual",
      signal: c.req.raw.signal,
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      return failure("Device stream unavailable", 502);
    }
    return new Response(response.body, {
      headers: {
        ...NO_CACHE,
        "content-type": response.headers.get("content-type") ?? "application/octet-stream",
        "x-accel-buffering": "no",
      },
    });
  } catch {
    return failure("Device stream unavailable", 502);
  }
});
