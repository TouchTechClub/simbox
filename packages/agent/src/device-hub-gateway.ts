import type { Server, ServerWebSocket } from "bun";
import { validPreviewDevice } from "@simbox/shared";

export interface DeviceHubSocket {
  nativeHub: true;
  upstream: WebSocket;
  platform: "ios" | "android" | "inventory";
  timer?: ReturnType<typeof setTimeout>;
  rateAt: number;
  rateCount: number;
  pending: Array<string | Uint8Array>;
  lastTouch?: { x: number; y: number };
  keys: Set<number>;
}

const READ_PATHS = [
  /^\/api\/devices$/,
  /^\/vendor\/serve-sim\/api$/,
  /^\/vendor\/serve-sim\/helper\/[A-Za-z0-9_-]+\/(config|health|ax|foreground)$/,
  /^\/vendor\/serve-sim\/appstate$/,
  /^\/vendor\/serve-emu\/api\/(devices|accessibility|fold)$/,
  /^\/vendor\/serve-emu\/health$/,
];
const WRITE_PATHS = [
  /^\/api\/devices\/(boot|shutdown)$/,
  /^\/vendor\/serve-sim\/grid\/api\/(start|shutdown)$/,
  /^\/vendor\/serve-sim\/api\/screenshot$/,
  /^\/vendor\/serve-emu\/api\/(screenshot|stream-mode|stream-settings|fold)$/,
];
const SOCKET_PATHS = new Map<string, "inventory" | "ios" | "android">([
  ["/api/devices/ws", "inventory"],
  ["/vendor/serve-sim/helper/ws", "ios"],
  ["/vendor/serve-emu/ws", "android"],
] as const);
const NO_CACHE = { "cache-control": "no-store, no-transform" };

/** The native Device panel protocol. Deliberately excludes hub exec and shell sockets. */
export function createDeviceHubGateway(options: {
  port: () => Promise<number>;
  activity: () => void;
  video: (req: Request) => Promise<Response | undefined>;
}) {
  const sockets = new Set<ServerWebSocket<DeviceHubSocket>>();
  const upstreams = new Set<WebSocket>();
  let stopped = false;
  return {
    async fetch(req: Request, server: Server<DeviceHubSocket>): Promise<Response | undefined> {
      if (stopped) return new Response("Device hub stopped", { status: 503 });
      const url = new URL(req.url);
      const path = url.pathname.slice("/simbox-device-hub".length);
      const stream = path.match(
        /^\/vendor\/serve-sim\/helper\/([A-Za-z0-9_-]+)\/stream\.(avcc|mjpeg)$/,
      );
      if (req.method === "GET" && stream) {
        url.pathname = `/simbox-preview/${stream[2] === "avcc" ? "video" : "mjpeg"}`;
        url.search = new URLSearchParams({ device: stream[1]!, platform: "ios" }).toString();
        return options.video(new Request(url.toString(), { signal: req.signal }));
      }
      const upgrade = req.headers.get("upgrade")?.toLowerCase() === "websocket";
      const platform = SOCKET_PATHS.get(path);
      if (
        upgrade
          ? !platform
          : !(req.method === "GET" ? READ_PATHS : req.method === "POST" ? WRITE_PATHS : []).some(
              (pattern) => pattern.test(path),
            )
      )
        return new Response("Device hub route not allowed", { status: 404 });
      const device = url.searchParams.get("device") ?? url.searchParams.get("udid");
      if (device !== null && !validPreviewDevice(device))
        return new Response("Invalid device", { status: 400 });
      const port = await options.port().catch(() => null);
      if (!port) return new Response("Device hub starting; retry shortly", { status: 503 });
      const origin = `http://127.0.0.1:${port}`;
      if (!upgrade) {
        const body = req.method === "POST" ? await req.text() : undefined;
        if (body && Buffer.byteLength(body) > 16_384)
          return new Response("Payload too large", { status: 413 });
        if (req.method === "POST") options.activity();
        try {
          const upstream = await fetch(`${origin}${path}${url.search}`, {
            method: req.method,
            body,
            headers: { "content-type": "application/json" },
            signal: AbortSignal.any([req.signal, AbortSignal.timeout(180_000)]),
            redirect: "error",
          });
          const headers = new Headers(upstream.headers);
          headers.delete("set-cookie");
          headers.set("cache-control", NO_CACHE["cache-control"]);
          return new Response(upstream.body, { status: upstream.status, headers });
        } catch {
          return new Response("Device hub unavailable", { status: 502, headers: NO_CACHE });
        }
      }
      if (upstreams.size >= 4)
        return new Response("At most four native device connections", { status: 429 });
      const upstream = new WebSocket(`${origin.replace("http", "ws")}${path}${url.search}`);
      upstreams.add(upstream);
      upstream.binaryType = "arraybuffer";
      const pending: Array<string | Uint8Array> = [];
      let pendingBytes = 0;
      upstream.onmessage = (event) => {
        const message =
          typeof event.data === "string" ? event.data : new Uint8Array(event.data as ArrayBuffer);
        pendingBytes +=
          typeof message === "string" ? Buffer.byteLength(message) : message.byteLength;
        if (pendingBytes > 4 * 1024 * 1024) upstream.close(1009, "Oversized device admission");
        else pending.push(message);
      };
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Socket admission timed out")), 10_000);
          upstream.onopen = () => {
            clearTimeout(timer);
            resolve();
          };
          upstream.onerror = () => {
            clearTimeout(timer);
            reject(new Error("Socket unavailable"));
          };
          upstream.onclose = () => {
            clearTimeout(timer);
            reject(new Error("Socket closed"));
          };
        });
        const data: DeviceHubSocket = {
          nativeHub: true,
          upstream,
          platform: platform!,
          rateAt: 0,
          rateCount: 0,
          pending,
          keys: new Set(),
        };
        if (!stopped && server.upgrade(req, { data })) return;
      } catch {
        /* handled below */
      }
      upstream.close();
      upstreams.delete(upstream);
      return new Response("Device socket unavailable", { status: 502 });
    },
    websocket: {
      open(ws: ServerWebSocket<DeviceHubSocket>) {
        sockets.add(ws);
        const upstream = ws.data.upstream;
        for (const message of ws.data.pending) ws.send(message);
        ws.data.pending.length = 0;
        upstream.onmessage = (event) =>
          ws.send(
            typeof event.data === "string" ? event.data : new Uint8Array(event.data as ArrayBuffer),
          );
        upstream.onclose = () => ws.close(1012, "Device connection interrupted");
        upstream.onerror = () => ws.close(1011, "Device connection failed");
        ws.data.timer = setTimeout(() => ws.close(4000, "Renew device connection"), 5 * 60_000);
      },
      message(ws: ServerWebSocket<DeviceHubSocket>, message: string | Buffer) {
        const data = ws.data;
        if (data.platform === "inventory") return;
        if (Date.now() - data.rateAt > 1000) {
          data.rateAt = Date.now();
          data.rateCount = 0;
        }
        if (
          ++data.rateCount > 200 ||
          Buffer.byteLength(message) > 16_384 ||
          !safeInput(data.platform, message)
        ) {
          ws.close(1008, "Unsupported device input");
          return;
        }
        if (data.upstream.readyState === WebSocket.OPEN) {
          const payload = JSON.parse(
            data.platform === "ios" ? (message as Buffer).subarray(1).toString() : String(message),
          );
          if (data.platform === "ios" && (message as Buffer)[0] === 0x03)
            data.lastTouch = payload.type === "end" ? undefined : { x: payload.x, y: payload.y };
          if (data.platform === "android" && payload.type === "touch")
            data.lastTouch = payload.action === "up" ? undefined : { x: payload.x, y: payload.y };
          if (data.platform === "ios" && (message as Buffer)[0] === 0x06) {
            if (payload.type === "up") data.keys.delete(payload.usage);
            else data.keys.add(payload.usage);
          }
          data.upstream.send(message);
          options.activity();
        }
      },
      close(ws: ServerWebSocket<DeviceHubSocket>) {
        sockets.delete(ws);
        clearTimeout(ws.data.timer);
        releaseInput(ws.data);
        ws.data.upstream.close();
        upstreams.delete(ws.data.upstream);
      },
    },
    stop() {
      stopped = true;
      for (const ws of sockets) {
        releaseInput(ws.data);
        ws.data.upstream.close();
        ws.terminate();
        clearTimeout(ws.data.timer);
      }
      sockets.clear();
      for (const upstream of upstreams) upstream.close();
      upstreams.clear();
    },
  };
}

function releaseInput(data: DeviceHubSocket) {
  if (data.upstream.readyState !== WebSocket.OPEN) return;
  const tagged = (tag: number, payload: unknown) =>
    data.upstream.send(Buffer.concat([Buffer.from([tag]), Buffer.from(JSON.stringify(payload))]));
  if (data.lastTouch) {
    if (data.platform === "ios") tagged(0x03, { type: "end", ...data.lastTouch });
    else data.upstream.send(JSON.stringify({ type: "touch", action: "up", ...data.lastTouch }));
    data.lastTouch = undefined;
  }
  for (const usage of data.keys) tagged(0x06, { type: "up", usage });
  data.keys.clear();
}

function safeInput(platform: "ios" | "android", message: string | Buffer): boolean {
  try {
    if (platform === "ios") {
      if (typeof message === "string" || ![0x03, 0x04, 0x06, 0x07, 0x0d].includes(message[0]!))
        return false;
      const payload = JSON.parse(message.subarray(1).toString());
      if (message[0] === 0x03)
        return (
          ["begin", "move", "end"].includes(payload.type) &&
          [payload.x, payload.y].every(
            (n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1,
          )
        );
      if (message[0] === 0x04) return ["home", "app_switcher", "lock"].includes(payload.button);
      if (message[0] === 0x06)
        return (
          ["down", "up"].includes(payload.type) &&
          Number.isInteger(payload.usage) &&
          payload.usage >= 0 &&
          payload.usage <= 255
        );
      if (message[0] === 0x07)
        return ["portrait", "landscape_left", "landscape_right", "portrait_upside_down"].includes(
          payload.orientation,
        );
      return typeof payload.enabled === "boolean";
    }
    const payload = JSON.parse(String(message));
    if (["home", "back", "recents", "power"].includes(payload.type)) return true;
    if (payload.type === "reset-video") return typeof payload.ack === "boolean";
    if (payload.type === "touch")
      return (
        ["down", "move", "up"].includes(payload.action) &&
        [payload.x, payload.y].every(
          (n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1,
        )
      );
    if (payload.type === "key")
      return Number.isInteger(payload.keycode) && payload.keycode >= 0 && payload.keycode <= 300;
    return (
      payload.type === "text" && typeof payload.text === "string" && payload.text.length <= 1000
    );
  } catch {
    return false;
  }
}
