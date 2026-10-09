import { expect, test } from "bun:test";
import { startGateway } from "../packages/agent/src/gateway";

test("native device gateway authenticates discovery, boot, screenshot and video; never admits shell routes or frames", async () => {
  const requests: Array<{ path: string; method: string; auth: string | null }> = [];
  const inputs: Array<string | Uint8Array> = [];
  const device = {
    id: "ABCD-1234",
    name: "iPhone 17 Pro",
    platform: "ios",
    booted: true,
    physical: false,
    version: "iOS 26.4",
  };
  const received = Promise.withResolvers<void>();
  const hub = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req, server) {
      const url = new URL(req.url);
      requests.push({
        path: url.pathname,
        method: req.method,
        auth: req.headers.get("authorization"),
      });
      if (url.pathname === "/api/devices")
        return Response.json({ simulators: [device], emulators: [] });
      if (url.pathname.endsWith("/boot") || url.pathname.endsWith("/start"))
        return Response.json({ ok: true, id: device.id });
      if (url.pathname.endsWith("/screenshot"))
        return new Response(new Uint8Array([137, 80, 78, 71]));
      if (url.pathname.endsWith("/stream.avcc"))
        return new Response(new Uint8Array([0, 0, 0, 2, 4, 1]));
      if (url.pathname === "/vendor/serve-sim/helper/ws" && server.upgrade(req)) return;
      return new Response("missing", { status: 404 });
    },
    websocket: {
      open(ws) {
        ws.send(new Uint8Array([0x82, 123, 125]));
      },
      message(_ws, message) {
        inputs.push(typeof message === "string" ? message : new Uint8Array(message));
        received.resolve();
      },
    },
  });
  const gateway = startGateway({
    port: 0,
    upstreamPort: 1,
    token: "secret",
    previewPlatform: "ios",
    previewPort: async () => hub.port!,
  });
  const origin = `http://127.0.0.1:${gateway.server.port}/simbox-device-hub`;
  const headers = { authorization: "Bearer secret" };
  let ws: WebSocket | undefined;
  try {
    expect((await fetch(`${origin}/api/devices`)).status).toBe(401);
    expect((await fetch(`${origin}/api/devices`, { headers })).status).toBe(200);
    expect(
      (
        await fetch(`${origin}/api/devices/boot`, {
          method: "POST",
          headers,
          body: JSON.stringify({ platform: "ios", id: device.id }),
        })
      ).status,
    ).toBe(200);
    const screenshot = await fetch(
      `${origin}/vendor/serve-sim/api/screenshot?device=${device.id}`,
      { method: "POST", headers },
    );
    expect(new Uint8Array(await screenshot.arrayBuffer())).toEqual(
      new Uint8Array([137, 80, 78, 71]),
    );
    const stream = await fetch(`${origin}/vendor/serve-sim/helper/${device.id}/stream.avcc`, {
      headers,
    });
    expect(stream.headers.get("cache-control")).toContain("no-transform");
    expect(new Uint8Array(await stream.arrayBuffer())).toEqual(new Uint8Array([0, 0, 0, 2, 4, 1]));
    for (const path of [
      "/exec",
      "/vendor/serve-sim/exec",
      "/vendor/serve-emu/action",
      "/api/devices/../../exec",
    ])
      expect((await fetch(`${origin}${path}`, { headers })).status).toBe(404);
    expect(requests.every((request) => request.auth === null)).toBe(true);
    ws = new WebSocket(
      `${origin.replace("http", "ws")}/vendor/serve-sim/helper/ws?device=${device.id}`,
      { headers },
    );
    const config = Promise.withResolvers<void>();
    ws.onmessage = () => config.resolve();
    await new Promise<void>((resolve, reject) => {
      ws!.onopen = () => resolve();
      ws!.onerror = reject;
    });
    await config.promise;
    const key = new TextEncoder().encode(JSON.stringify({ type: "down", usage: 4 }));
    ws.send(new Uint8Array([0x06, ...key]));
    await received.promise;
    expect(inputs).toHaveLength(1);
    const closed = Promise.withResolvers<number>();
    ws.onclose = (event) => closed.resolve(event.code);
    ws.send(
      new Uint8Array([0x08, ...new TextEncoder().encode(JSON.stringify({ command: "whoami" }))]),
    );
    expect(await closed.promise).toBe(1008);
    expect(inputs.every((input) => typeof input !== "string" && input[0] === 0x06)).toBe(true);
  } finally {
    ws?.close();
    gateway.stopPreview();
    void gateway.server.stop(true);
    void hub.stop(true);
  }
}, 10_000);
