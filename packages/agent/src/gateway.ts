import { timingSafeEqual } from "node:crypto";

/** A loopback-only relay; agent-device remains responsible for RPC/auth. */
export function startGateway(options: {
  port: number;
  upstreamPort: number;
  token: string;
  requestTimeoutMs?: number;
}) {
  let inFlight = 0;
  let lastActivityAt = Date.now();
  const expected = Buffer.from(`Bearer ${options.token}`);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port,
    idleTimeout: 255,
    // Same RPC body ceiling as agent-device; upload streams are supported too.
    maxRequestBodySize: 512 * 1024 * 1024,
    async fetch(req) {
      const url = new URL(req.url);
      const auth = Buffer.from(req.headers.get("authorization") ?? "");
      const authenticated = auth.length === expected.length && timingSafeEqual(auth, expected);
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
        const response = await fetch(
          `http://127.0.0.1:${options.upstreamPort}${url.pathname}${url.search}`,
          {
            method: req.method,
            headers,
            body: req.body,
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
  };
}
