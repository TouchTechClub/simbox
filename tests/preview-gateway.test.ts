import { expect, test } from "bun:test";
import { startGateway } from "../packages/agent/src/gateway";
import { createPreviewGateway, type PreviewSocket } from "../packages/agent/src/preview-gateway";

test("real preview relay authenticates, streams video, isolates read-only mode and releases control", async () => {
  const messages: string[] = [];
  const peers = new Set<any>();
  const hub = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/api/devices")
        return Response.json({
          emulators: [
            {
              id: "emulator-5554",
              name: "simbox",
              booted: true,
              platform: "android",
              version: "Android 14",
            },
          ],
        });
      if (
        url.pathname === "/vendor/serve-emu/ws" &&
        url.searchParams.get("device") === "emulator-5554"
      ) {
        if (server.upgrade(req)) return;
      }
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        peers.add(ws);
      },
      message(_ws, message) {
        messages.push(String(message));
      },
      close(ws) {
        peers.delete(ws);
      },
    },
  });
  const gateway = startGateway({
    port: 0,
    upstreamPort: 1,
    token: "secret",
    previewPort: async () => hub.port!,
  });
  const base = `http://127.0.0.1:${gateway.server.port}/simbox-preview`;
  const headers = { authorization: "Bearer secret" };
  const closeables: WebSocket[] = [];
  const connect = async (control: boolean) => {
    const ws = new WebSocket(
      `${base.replace("http", "ws")}/socket?device=emulator-5554&platform=android`,
      { headers: { ...headers, "x-simbox-preview-control": control ? "1" : "0" } },
    );
    ws.binaryType = "arraybuffer";
    closeables.push(ws);
    const inbox: unknown[] = [];
    ws.onmessage = (event) => inbox.push(event.data);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("Upgrade failed"));
    });
    return { ws, inbox };
  };
  const wait = async (condition: () => boolean) => {
    const deadline = Date.now() + 2000;
    while (!condition() && Date.now() < deadline) await Bun.sleep(5);
    expect(condition()).toBe(true);
  };
  try {
    const initial = gateway.activity().lastActivityAt;
    expect((await fetch(`${base}/devices`)).status).toBe(401);
    const inventory = await fetch(`${base}/devices`, { headers });
    expect(inventory.headers.get("cache-control")).toContain("no-store");
    expect((await inventory.json()).devices).toHaveLength(1);
    expect((await fetch(`${base}/exec`, { headers })).status).toBe(404);
    expect((await fetch(`${base}/devices`, { method: "POST", headers })).status).toBe(405);
    expect(
      (await fetch(`${base}/socket?platform=android&device=..%2Fexec`, { headers })).status,
    ).toBe(400);
    const viewer = await connect(false);
    await wait(() => viewer.inbox.some((message) => String(message).includes('"ready"')));
    for (const peer of peers) peer.send(new Uint8Array([0, 0, 0, 1, 0x65, 1]));
    await wait(() => viewer.inbox.some((message) => message instanceof ArrayBuffer));
    expect(gateway.activity().inFlight).toBe(0);
    expect(gateway.activity().lastActivityAt).toBe(initial);
    viewer.ws.send(JSON.stringify({ type: "button", button: "home" }));
    await wait(() => viewer.inbox.some((message) => String(message).includes("read-only")));
    expect(messages.some((message) => message === '{"type":"home"}')).toBe(false);
    const controller = await connect(true);
    controller.ws.send(JSON.stringify({ type: "touch", phase: "begin", x: 0.5, y: 0.25 }));
    await wait(() => messages.some((message) => message.includes('"action":"down"')));
    expect(gateway.activity().lastActivityAt).toBeGreaterThan(initial);
    await expect(connect(true)).rejects.toThrow();
    controller.ws.send(JSON.stringify({ type: "exec", command: "whoami" }));
    await wait(() => controller.inbox.some((message) => String(message).includes("Unsupported")));
    expect(messages.some((message) => message.includes("whoami"))).toBe(false);
    controller.ws.close();
    await wait(() => messages.some((message) => message.includes('"action":"up"')));
    const next = await connect(true);
    next.ws.send(JSON.stringify({ type: "button", button: "back" }));
    await wait(() => messages.some((message) => message === '{"type":"back"}'));
  } finally {
    for (const ws of closeables) ws.close();
    gateway.stopPreview();
    void gateway.server.stop(true);
    void hub.stop(true);
  }
}, 10_000);

test("preview connection leases expire without resetting idle activity", async () => {
  const hub = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, server) {
      if (server.upgrade(req)) return;
      return new Response("no", { status: 400 });
    },
    websocket: { message() {} },
  });
  const gateway = startGateway({
    port: 0,
    upstreamPort: 1,
    token: "secret",
    previewPort: async () => hub.port!,
    previewSessionMs: 50,
  });
  try {
    const initial = gateway.activity().lastActivityAt;
    const ws = new WebSocket(
      `ws://127.0.0.1:${gateway.server.port}/simbox-preview/socket?device=emulator-5554&platform=android`,
      { headers: { authorization: "Bearer secret" } },
    );
    const code = await new Promise<number>((resolve) => {
      ws.onclose = (event) => resolve(event.code);
    });
    expect(code).toBe(4000);
    expect(gateway.activity().lastActivityAt).toBe(initial);
  } finally {
    gateway.stopPreview();
    void gateway.server.stop(true);
    void hub.stop(true);
  }
});

test("iOS stream that only returns headers restarts the hub instead of hanging", async () => {
  // Reproduces the serve-sim wedge seen on real runners: a fresh AVCC
  // attachment gets HTTP 200 headers but no bytes after earlier aborts.
  const hub = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return new Response(
        new ReadableStream<Uint8Array>({
          start() {
            /* never produces */
          },
        }),
        { headers: { "content-type": "application/octet-stream" } },
      );
    },
  });
  let restarts = 0;
  const relay = createPreviewGateway({
    port: async () => hub.port!,
    platform: "ios",
    activity() {},
    streamStartMs: 50,
    restartHub: async () => {
      restarts++;
    },
  });
  const server = Bun.serve<PreviewSocket>({
    hostname: "127.0.0.1",
    port: 0,
    // Production gateway uses 255; Bun's default 10s kills the request before
    // the stream watchdog can respond.
    idleTimeout: 255,
    fetch: relay.fetch,
    websocket: relay.websocket,
  });
  try {
    const res = await fetch(
      `http://127.0.0.1:${server.port}/simbox-preview/video?device=ABCD-1234&platform=ios`,
    );
    expect(res.status).toBe(502);
    expect(restarts).toBe(1);
  } finally {
    relay.stop();
    void server.stop(true);
    void hub.stop(true);
  }
}, 30_000);

test("iOS relay streams AVCC/MJPEG and forwards tagged HID without exposing hub APIs", async () => {
  const received: Uint8Array[] = [];
  const paths: string[] = [];
  const hub = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, server) {
      const url = new URL(req.url);
      paths.push(url.pathname);
      if (url.pathname === "/vendor/serve-sim/helper/ws") {
        if (server.upgrade(req)) return;
      }
      if (url.pathname.endsWith("/stream.avcc"))
        return new Response(new Uint8Array([0, 0, 0, 2, 4, 1]));
      if (url.pathname.endsWith("/stream.mjpeg"))
        return new Response(new Uint8Array([255, 216, 1, 255, 217]), {
          headers: { "content-type": "multipart/x-mixed-replace; boundary=frame" },
        });
      return new Response("no", { status: 404 });
    },
    websocket: {
      message(_ws, bytes) {
        received.push(new Uint8Array(bytes as Buffer));
      },
    },
  });
  let activity = 0;
  const relay = createPreviewGateway({
    port: async () => hub.port!,
    platform: "ios",
    activity: () => activity++,
  });
  const server = Bun.serve<PreviewSocket>({
    hostname: "127.0.0.1",
    port: 0,
    fetch: relay.fetch,
    websocket: relay.websocket,
  });
  const base = `http://127.0.0.1:${server.port}/simbox-preview`;
  try {
    const video = await fetch(`${base}/video?device=ABCD-1234&platform=ios`);
    expect(new Uint8Array(await video.arrayBuffer())).toEqual(new Uint8Array([0, 0, 0, 2, 4, 1]));
    const mjpeg = await fetch(`${base}/mjpeg?device=ABCD-1234&platform=ios`);
    expect(mjpeg.headers.get("content-type")).toContain("multipart");
    await mjpeg.arrayBuffer();
    expect(activity).toBe(0);
    const ws = new WebSocket(`${base.replace("http", "ws")}/socket?device=ABCD-1234&platform=ios`, {
      headers: { "x-simbox-preview-control": "1" },
    });
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = reject;
    });
    ws.send(JSON.stringify({ type: "key", code: "KeyA", key: "a", phase: "down" }));
    ws.send(JSON.stringify({ type: "rotate", orientation: "landscape_left" }));
    const deadline = Date.now() + 2000;
    while (received.length < 3 && Date.now() < deadline) await Bun.sleep(5);
    expect(received.map((bytes) => bytes[0])).toEqual([0x0d, 0x06, 0x07]);
    expect(JSON.parse(new TextDecoder().decode(received[1]!.subarray(1)))).toEqual({
      type: "down",
      usage: 4,
    });
    expect(activity).toBe(2);
    ws.close();
    while (received.length < 4 && Date.now() < deadline) await Bun.sleep(5);
    expect(JSON.parse(new TextDecoder().decode(received[3]!.subarray(1)))).toEqual({
      type: "up",
      usage: 4,
    });
    expect(paths).toContain("/vendor/serve-sim/helper/ABCD-1234/stream.avcc");
    expect((await fetch(`${base}/exec`)).status).toBe(404);
  } finally {
    relay.stop();
    void server.stop(true);
    void hub.stop(true);
  }
});
