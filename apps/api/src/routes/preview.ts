import { Hono, type Context } from "hono";
import { eq } from "drizzle-orm";
import { createDb, schema } from "@simbox/db";
import { validPreviewDevice, type PreviewInventory } from "@simbox/shared";
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
function upstreamUrl(run: RunRow, path: string): string {
  const origin = new URL(run.tunnel_url!);
  // Registered tunnels have a fixed origin; device identifiers never select a host.
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.port ||
    !/^[a-z0-9-]+\.trycloudflare\.com$/.test(origin.hostname)
  )
    throw new Error("Invalid tunnel");
  return `${origin.origin}/simbox-preview/${path}`;
}
async function inventory(run: RunRow, signal?: AbortSignal): Promise<PreviewInventory> {
  const response = await fetch(upstreamUrl(run, "devices"), {
    headers: { authorization: `Bearer ${run.daemon_token}` },
    redirect: "manual",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(300_000)])
      : AbortSignal.timeout(300_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      "Preview hub unavailable. Older agents need a new run after upgrading; first access may take a few minutes to install the hub.",
    );
  }
  const result: PreviewInventory = await response.json();
  if (
    !Array.isArray(result.devices) ||
    !result.devices.every(
      (device) => validPreviewDevice(device.id) && device.platform === run.platform,
    )
  )
    throw new Error("Invalid preview inventory");
  return result;
}

previewRoutes.get("/v1/runs/:id/preview/devices", requireUser, async (c) => {
  const run = await ownedRun(c, c.get("user").id, c.req.param("id"));
  if (!run) return failure("Run not found", 404);
  if (!available(run)) return failure("The run is not live", 409);
  try {
    return c.json(await inventory(run, c.req.raw.signal), { headers: NO_CACHE });
  } catch {
    return failure(
      "Device preview unavailable. First access installs the hub; retry shortly. Older agents require a new run after upgrading.",
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
      upstreamUrl(
        run,
        `socket?device=${encodeURIComponent(claims.device)}&platform=${claims.platform}`,
      ),
      {
        headers: {
          upgrade: "websocket",
          authorization: `Bearer ${run.daemon_token}`,
          "x-simbox-preview-control": claims.control ? "1" : "0",
        },
        redirect: "manual",
      },
    );
    if (upstream.status !== 101 || !upstream.webSocket) {
      await upstream.body?.cancel();
      return failure(
        upstream.status === 409
          ? "Device already has a browser controller"
          : "Preview socket unavailable",
        upstream.status === 409 ? 409 : 502,
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

for (const format of ["video", "mjpeg"] as const) {
  previewRoutes.get(`/v1/runs/:id/preview/${format}`, requireUser, async (c) => {
    const device = c.req.query("device");
    if (!validPreviewDevice(device)) return failure("Invalid device", 400);
    const run = await ownedRun(c, c.get("user").id, c.req.param("id"));
    if (!run) return failure("Run not found", 404);
    if (!available(run) || run.platform !== "ios") return failure("iOS live run required", 409);
    try {
      if (!(await inventory(run, c.req.raw.signal)).devices.some((item) => item.id === device))
        return failure("Device is no longer active", 409);
      const response = await fetch(
        upstreamUrl(run, `${format}?platform=ios&device=${encodeURIComponent(device)}`),
        {
          headers: { authorization: `Bearer ${run.daemon_token}` },
          redirect: "manual",
          signal: c.req.raw.signal,
        },
      );
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
}
