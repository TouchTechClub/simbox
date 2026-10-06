import type { Server, ServerWebSocket } from "bun";
import {
  PREVIEW_SESSION_MS,
  PREVIEW_MAX_MESSAGE,
  validPreviewDevice,
  previewInventory,
  parsePreviewInput,
  hubInput,
  iosHardwareKeyboard,
  type DevicePlatform,
  type PreviewInput,
} from "@simbox/shared";

export interface PreviewSocket {
  upstream: WebSocket;
  platform: DevicePlatform;
  device: string;
  control: boolean;
  key: string;
  release: () => void;
  timer?: ReturnType<typeof setTimeout>;
  lastTouch?: Extract<PreviewInput, { type: "touch" }>;
  keys: Map<string, Extract<PreviewInput, { type: "key" }>>;
  rateAt: number;
  rateCount: number;
}

const NO_CACHE = {
  "cache-control": "no-store, no-transform",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};
/** Separate, small preview surface: never exposes the hub dashboard/exec APIs. */
export function createPreviewGateway(options: {
  port: () => Promise<number>;
  activity: () => void;
  sessionMs?: number;
  platform?: DevicePlatform;
  /** Restart the hub when upstream socket admission wedges (iOS HID). */
  restartHub?: () => Promise<void>;
  /** Max wait for the first iOS stream bytes before treating it as wedged. */
  streamStartMs?: number;
}) {
  const controllers = new Set<string>();
  const sockets = new Set<ServerWebSocket<PreviewSocket>>();
  let connections = 0;
  let stopped = false;
  const sessionMs = Math.min(options.sessionMs ?? PREVIEW_SESSION_MS, PREVIEW_SESSION_MS);
  const response = (message: string, status: number) =>
    Response.json({ message }, { status, headers: NO_CACHE });
  return {
    async fetch(req: Request, server: Server<PreviewSocket>): Promise<Response | undefined> {
      const url = new URL(req.url);
      if (stopped) return response("Preview stopped", 503);
      if (req.method !== "GET") return response("Method not allowed", 405);
      const path = url.pathname.slice("/simbox-preview".length);
      if (!["/devices", "/socket", "/video", "/mjpeg"].includes(path))
        return response("Preview route not found", 404);
      const platform: DevicePlatform =
        options.platform ?? (process.platform === "darwin" ? "ios" : "android");
      const device = url.searchParams.get("device");
      if (
        path !== "/devices" &&
        (!validPreviewDevice(device) || url.searchParams.get("platform") !== platform)
      )
        return response("Invalid device/platform", 400);
      const port = await options.port().catch(() => null);
      if (!port)
        return response("Preview hub unavailable. Retry after it starts; CLI still works.", 503);
      const origin = `http://127.0.0.1:${port}`;
      if (path === "/devices") {
        try {
          const upstream = await fetch(`${origin}/api/devices?booted=1`, {
            signal: AbortSignal.any([req.signal, AbortSignal.timeout(10_000)]),
            redirect: "error",
          });
          if (!upstream.ok) throw new Error();
          return Response.json(previewInventory(await upstream.json(), platform), {
            headers: NO_CACHE,
          });
        } catch {
          return response("Device inventory unavailable", 502);
        }
      }
      if (connections >= 4) return response("At most four preview connections per runner", 429);
      if (path !== "/socket") {
        if (platform !== "ios") return response("Android video uses WebSocket", 400);
        connections++;
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), sessionMs);
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          connections--;
          abort.abort();
        };
        try {
          // serve-sim can stop delivering to a fresh shared-capture
          // subscription after a client aborts mid-admission: the request
          // stays open (headers may never flush) and nothing else can recover
          // it, so the hub process is restarted and the client retries.
          // The watchdog is cleared by the first real bytes, never by headers.
          const startAbort = new AbortController();
          const watchdog = setTimeout(() => startAbort.abort(), options.streamStartMs ?? 15_000);
          let upstream: Response;
          try {
            upstream = await fetch(
              `${origin}/vendor/serve-sim/helper/${encodeURIComponent(device!)}/stream.${path === "/mjpeg" ? "mjpeg" : "avcc"}`,
              {
                signal: AbortSignal.any([req.signal, abort.signal, startAbort.signal]),
                redirect: "error",
              },
            );
          } catch {
            clearTimeout(watchdog);
            finish();
            // A watchdog abort proves the wedged serve-sim attachment bug;
            // restart the hub so the client's next retry works.
            if (startAbort.signal.aborted) await options.restartHub?.().catch(() => {});
            return response("Device stream admission failed", 502);
          }
          if (!upstream.ok || !upstream.body) {
            finish();
            clearTimeout(watchdog);
            return response("Device stream unavailable", 502);
          }
          const reader = upstream.body.getReader();
          // The watchdog stays armed through the first bytes; it only stops
          // protecting the stream once real data proves capture is live.
          const first = await reader.read().catch(() => null);
          clearTimeout(watchdog);
          const wedged = startAbort.signal.aborted;
          if (first === null || first.done) {
            finish();
            if (wedged) await options.restartHub?.().catch(() => {});
            return response("Device stream produced no frames", 502);
          }
          let pending: { done?: boolean; value: Uint8Array } | null = first;
          const body = new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                const result = pending ?? (await reader.read());
                pending = null;
                if (result.done) {
                  finish();
                  controller.close();
                } else controller.enqueue(result.value);
              } catch (error) {
                finish();
                controller.error(error);
              }
            },
            async cancel() {
              finish();
              await reader.cancel().catch(() => {});
            },
          });
          return new Response(body, {
            headers: {
              ...NO_CACHE,
              "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
            },
          });
        } catch {
          finish();
          return response("Device stream unavailable", 502);
        }
      }
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket")
        return response("WebSocket upgrade required", 426);
      const control = req.headers.get("x-simbox-preview-control") === "1";
      const key = `${platform}:${device}`;
      if (control && controllers.has(key))
        return response(
          "This device already has a browser controller. Disable control in the other tab.",
          409,
        );
      if (control) controllers.add(key);
      connections++;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        connections--;
        if (control) controllers.delete(key);
      };
      const upstream = new WebSocket(
        `${origin.replace("http", "ws")}${platform === "ios" ? "/vendor/serve-sim/helper/ws" : "/vendor/serve-emu/ws"}?device=${encodeURIComponent(device!)}${platform === "android" ? "&frame-meta=1" : ""}`,
      );
      upstream.binaryType = "arraybuffer";
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            upstream.close();
            reject(new Error());
          }, 10_000);
          upstream.onopen = () => {
            clearTimeout(timer);
            resolve();
          };
          upstream.onerror = upstream.onclose = () => {
            clearTimeout(timer);
            reject(new Error());
          };
        });
        const data: PreviewSocket = {
          upstream,
          platform,
          device: device!,
          key,
          control,
          release,
          keys: new Map(),
          rateAt: Date.now(),
          rateCount: 0,
        };
        if (stopped || !server.upgrade(req, { data })) {
          upstream.close();
          release();
          return response("Unable to upgrade preview", 502);
        }
        return undefined;
      } catch {
        upstream.close();
        release();
        // serve-sim can stop answering HID socket upgrades after aborted
        // attachments; viewers alone cannot recover a wedged native capture.
        await options.restartHub?.().catch(() => {});
        return response("Device input/video socket unavailable", 502);
      }
    },
    websocket: {
      maxPayloadLength: PREVIEW_MAX_MESSAGE,
      backpressureLimit: 4 * 1024 * 1024,
      closeOnBackpressureLimit: true,
      idleTimeout: 60,
      open(ws: ServerWebSocket<PreviewSocket>) {
        sockets.add(ws);
        const data = ws.data;
        data.timer = setTimeout(() => ws.close(4000, "Renew preview access"), sessionMs);
        data.upstream.onmessage = (event) => {
          if (typeof event.data === "string") {
            // The hub's connection/status events contain no secret URLs.
            try {
              const value = JSON.parse(event.data);
              if (value.type === "video-session")
                ws.send(JSON.stringify({ type: "video-session" }));
            } catch {
              /* not a video event */
            }
          } else if (event.data instanceof ArrayBuffer && event.data.byteLength <= 4 * 1024 * 1024)
            ws.send(event.data);
          else ws.close(1009, "Oversized video frame");
        };
        data.upstream.onclose = data.upstream.onerror = () =>
          ws.close(1011, "Device transport disconnected");
        if (data.control && data.platform === "ios") data.upstream.send(iosHardwareKeyboard());
        if (data.platform === "android")
          data.upstream.send(JSON.stringify({ type: "reset-video", ack: false }));
        ws.send(JSON.stringify({ type: "ready", control: data.control }));
      },
      message(ws: ServerWebSocket<PreviewSocket>, message: string | Buffer) {
        const data = ws.data;
        try {
          if (typeof message !== "string" || Buffer.byteLength(message) > PREVIEW_MAX_MESSAGE)
            throw new Error("Invalid input packet");
          if (Date.now() - data.rateAt >= 1000) {
            data.rateAt = Date.now();
            data.rateCount = 0;
          }
          if (++data.rateCount > 120) {
            ws.close(1008, "Input rate exceeded");
            return;
          }
          const input = parsePreviewInput(JSON.parse(message));
          if (input.type !== "reset-video" && !data.control)
            throw new Error("Preview is read-only");
          const payload = hubInput(data.platform, input);
          if (
            payload === null &&
            data.platform === "android" &&
            input.type === "key" &&
            input.phase === "up"
          )
            return;
          if (payload === null) throw new Error("Control is not supported on this platform");
          if (data.upstream.readyState !== WebSocket.OPEN || data.upstream.bufferedAmount > 64_000)
            throw new Error("Input unavailable; outcome uncertain. Inspect before retrying.");
          data.upstream.send(payload);
          if (input.type === "touch") data.lastTouch = input.phase === "end" ? undefined : input;
          if (input.type === "key" && data.platform === "ios") {
            if (input.phase === "down") data.keys.set(input.code, input);
            else data.keys.delete(input.code);
          }
          if (input.type !== "reset-video") options.activity();
        } catch (error) {
          ws.send(
            JSON.stringify({
              type: "input-error",
              message: error instanceof Error ? error.message : "Invalid input",
            }),
          );
        }
      },
      close(ws: ServerWebSocket<PreviewSocket>) {
        const data = ws.data;
        clearTimeout(data.timer);
        sockets.delete(ws);
        data.release();
        if (data.upstream.readyState === WebSocket.OPEN) {
          // Avoid stuck touches/modifiers after tab hiding, disconnect or expiry.
          const inputs: PreviewInput[] = [...data.keys.values()].map((key) => ({
            ...key,
            phase: "up",
          }));
          if (data.lastTouch) inputs.push({ ...data.lastTouch, phase: "end" });
          for (const input of inputs) {
            const payload = hubInput(data.platform, input);
            if (payload) data.upstream.send(payload);
          }
        }
        data.upstream.close();
      },
    },
    stop() {
      stopped = true;
      for (const socket of sockets) {
        clearTimeout(socket.data.timer);
        socket.data.release();
        socket.data.upstream.close();
        socket.terminate();
      }
      sockets.clear();
    },
  };
}
