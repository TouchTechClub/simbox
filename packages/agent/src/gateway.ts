import { timingSafeEqual } from "node:crypto";
import { createPreviewGateway, type PreviewSocket } from "./preview-gateway.js";
import { createDeviceHubGateway, type DeviceHubSocket } from "./device-hub-gateway.js";
import type { Server, ServerWebSocket } from "bun";

/** A loopback-only relay; agent-device remains responsible for RPC/auth. */
export function startGateway(options: {
  port: number;
  upstreamPort: number;
  token: string;
  requestTimeoutMs?: number;
  heartbeatMs?: number;
  previewPort?: () => Promise<number>;
  previewPlatform?: "ios" | "android";
  previewSessionMs?: number;
  restartPreviewHub?: () => Promise<void>;
}) {
  let inFlight = 0;
  let lastActivityAt = Date.now();
  const expected = Buffer.from(`Bearer ${options.token}`);
  const preview = createPreviewGateway({
    platform: options.previewPlatform,
    port:
      options.previewPort ??
      (async () => {
        throw new Error("Preview unavailable");
      }),
    activity: () => {
      lastActivityAt = Date.now();
    },
    sessionMs: options.previewSessionMs,
    restartHub: options.restartPreviewHub,
  });
  const nativeHub = createDeviceHubGateway({
    port:
      options.previewPort ??
      (async () => {
        throw new Error("Preview unavailable");
      }),
    activity: () => {
      lastActivityAt = Date.now();
    },
    video: (req) => preview.fetch(req, server as Server<PreviewSocket>),
  });
  const server = Bun.serve<PreviewSocket | DeviceHubSocket>({
    hostname: "127.0.0.1",
    port: options.port,
    idleTimeout: 255,
    // Same RPC body ceiling as agent-device; upload streams are supported too.
    maxRequestBodySize: 512 * 1024 * 1024,
    websocket: {
      maxPayloadLength: preview.websocket.maxPayloadLength,
      backpressureLimit: preview.websocket.backpressureLimit,
      closeOnBackpressureLimit: preview.websocket.closeOnBackpressureLimit,
      idleTimeout: preview.websocket.idleTimeout,
      open(ws) {
        if ("nativeHub" in ws.data)
          nativeHub.websocket.open(ws as ServerWebSocket<DeviceHubSocket>);
        else preview.websocket.open(ws as ServerWebSocket<PreviewSocket>);
      },
      message(ws, message) {
        if ("nativeHub" in ws.data)
          nativeHub.websocket.message(ws as ServerWebSocket<DeviceHubSocket>, message);
        else preview.websocket.message(ws as ServerWebSocket<PreviewSocket>, message);
      },
      close(ws) {
        if ("nativeHub" in ws.data)
          nativeHub.websocket.close(ws as ServerWebSocket<DeviceHubSocket>);
        else preview.websocket.close(ws as ServerWebSocket<PreviewSocket>);
      },
    },
    async fetch(req, server) {
      const url = new URL(req.url);
      const auth = Buffer.from(req.headers.get("authorization") ?? "");
      const authenticated = auth.length === expected.length && timingSafeEqual(auth, expected);
      if (url.pathname.startsWith("/simbox-device-hub")) {
        if (!authenticated)
          return new Response("Unauthorized", {
            status: 401,
            headers: { "cache-control": "no-store" },
          });
        return nativeHub.fetch(req, server as Server<DeviceHubSocket>);
      }
      if (url.pathname.startsWith("/simbox-preview")) {
        if (!authenticated)
          return new Response("Unauthorized", {
            status: 401,
            headers: { "cache-control": "no-store" },
          });
        return preview.fetch(req, server as Server<PreviewSocket>);
      }
      // Probes must not keep an unused runner alive. Only authenticated device
      // work counts, and each request has a ceiling so hung work is bounded.
      const activity = authenticated && url.pathname !== "/agent-device/health";
      if (activity) {
        inFlight++;
        lastActivityAt = Date.now();
      }
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        if (activity) {
          inFlight--;
          lastActivityAt = Date.now();
        }
      };
      const signal = AbortSignal.any([
        req.signal,
        AbortSignal.timeout(options.requestTimeoutMs ?? 10 * 60 * 1000),
      ]);
      signal.addEventListener("abort", finish, { once: true });
      try {
        const headers = new Headers(req.headers);
        // Preserve the public origin for agent-device's upload URL rewriting.
        headers.set("x-forwarded-host", url.host);
        if (authenticated && req.method === "POST" && url.pathname === "/agent-device/rpc") {
          const text = await req.text();
          if (Buffer.byteLength(text) > 1024 * 1024) {
            finish();
            return new Response("RPC body too large", { status: 413 });
          }
          let rpc: { id?: unknown; method?: string; params?: { meta?: Record<string, unknown> } };
          try {
            rpc = JSON.parse(text);
          } catch {
            finish();
            return new Response("Invalid RPC JSON", { status: 400 });
          }
          if (
            rpc?.method === "agent_device.command" &&
            rpc.params &&
            typeof rpc.params === "object"
          ) {
            // JSON whitespace is valid framing and keeps Cloudflare's read
            // deadline alive. Disable upstream NDJSON progress for this RPC:
            // the final body remains a single JSON-RPC response for all clients.
            if (rpc.params.meta && typeof rpc.params.meta === "object")
              delete rpc.params.meta.requestProgress;
            headers.delete("content-length");
            headers.delete("transfer-encoding");
            return streamRpc({
              url: `http://127.0.0.1:${options.upstreamPort}${url.pathname}${url.search}`,
              headers,
              body: JSON.stringify(rpc),
              id: rpc.id,
              signal,
              finish,
              heartbeatMs: options.heartbeatMs ?? 15_000,
            });
          }
          // Lease/unknown RPCs are short and keep their original HTTP semantics.
          headers.delete("content-length");
          headers.delete("transfer-encoding");
          return await relay(
            new Request(req.url, { method: req.method, headers, body: text }),
            headers,
          );
        }
        return await relay(req, headers);

        async function relay(request: Request, headers: Headers): Promise<Response> {
          const response = await fetch(
            `http://127.0.0.1:${options.upstreamPort}${url.pathname}${url.search}`,
            {
              method: request.method,
              headers,
              body: request.body,
              signal,
              redirect: "manual",
            },
          );
          if (!response.body) {
            finish();
            return response;
          }
          const reader = response.body.getReader();
          // Account for streamed RPC progress/uploads through their final byte,
          // not just until the upstream sends response headers.
          const body = new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                const chunk = await reader.read();
                if (chunk.done) {
                  finish();
                  controller.close();
                } else controller.enqueue(chunk.value);
              } catch (error) {
                finish();
                controller.error(error);
              }
            },
            async cancel() {
              finish();
              await reader.cancel();
            },
          });
          return new Response(body, { status: response.status, headers: response.headers });
        }
      } catch {
        finish();
        return new Response("Upstream daemon unavailable", {
          status: req.signal.aborted ? 502 : signal.aborted ? 504 : 502,
        });
      }
    },
  });
  return {
    server,
    activity: () => ({ inFlight, lastActivityAt }),
    ready: Promise.resolve(),
    stopPreview: () => {
      preview.stop();
      nativeHub.stop();
    },
  };
}

function streamRpc(options: {
  url: string;
  headers: Headers;
  body: string;
  id: unknown;
  signal: AbortSignal;
  finish: () => void;
  heartbeatMs: number;
}): Response {
  const canceled = new AbortController();
  const signal = AbortSignal.any([options.signal, canceled.signal]);
  let timer: ReturnType<typeof setInterval> | undefined;
  const finish = () => {
    clearInterval(timer);
    options.finish();
  };
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(" \n"));
      timer = setInterval(() => controller.enqueue(encoder.encode(" \n")), options.heartbeatMs);
      void (async () => {
        try {
          const response = await fetch(options.url, {
            method: "POST",
            headers: options.headers,
            body: options.body,
            signal,
            redirect: "manual",
          });
          const body = await response.text();
          // Never feed Cloudflare HTML/other non-RPC bodies to the client.
          JSON.parse(body);
          if (!signal.aborted) controller.enqueue(encoder.encode(body));
        } catch {
          if (!canceled.signal.aborted)
            controller.enqueue(
              encoder.encode(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: options.id ?? null,
                  error: {
                    code: -32000,
                    message:
                      "Remote request failed or exceeded its gateway deadline. Its outcome may be unknown; inspect the session before retrying.",
                  },
                }),
              ),
            );
        } finally {
          finish();
          if (!canceled.signal.aborted) controller.close();
        }
      })();
    },
    cancel() {
      canceled.abort();
      finish();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
