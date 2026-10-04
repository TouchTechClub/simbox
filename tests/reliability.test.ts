import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { remoteArgs, waitForRemote, waitForAndroid } from "../apps/cli/src/remote.js";
import { healthyProxy } from "../packages/agent/src/health.js";
import { startGateway } from "../packages/agent/src/gateway.js";
import { sessionDeviceCount } from "../packages/agent/src/devices.js";
import { selectWarmSimulator } from "../packages/agent/src/ios.js";
import { preparePlatforms } from "../packages/agent/src/platforms.js";

const info = {
  runId: "run-1",
  tunnelUrl: "https://old.example",
  daemonToken: "secret",
  expiresAt: null,
};

test("default Android preparation never invokes iOS inventory", async () => {
  let android = false;
  await preparePlatforms({
    warmIOS: false,
    ios: async () => {
      throw new Error("iOS must not run");
    },
    android: async () => {
      android = true;
    },
    warn: () => {},
  });
  expect(android).toBe(true);
});

test("even explicitly enabled iOS warmup failures cannot block Android", async () => {
  const events: string[] = [];
  await preparePlatforms({
    warmIOS: true,
    ios: async () => {
      throw new Error("inventory timed out");
    },
    android: async () => {
      events.push("android");
    },
    warn: (message) => {
      events.push(message);
    },
  });
  expect(events[0]).toContain("inventory timed out");
  expect(events[1]).toBe("android");
});

test("Android commands wait for AVD readiness without sending device commands", async () => {
  let reads = 0;
  await waitForAndroid("test", {
    read: async () => ({ id: "test", state: "live", androidReady: ++reads === 2 }) as any,
    pause: async () => {},
  });
  expect(reads).toBe(2);
  await expect(waitForAndroid("test", { read: async () => null })).rejects.toThrow(
    "ended or was replaced",
  );
  await expect(
    waitForAndroid("test", {
      read: async () => ({ id: "test", state: "live", androidReady: false }) as any,
      pause: async () => {},
      timeoutMs: 0,
    }),
  ).rejects.toThrow("No device command was sent");
});

test("prewarming selects an available phone, preferring the documented default", () => {
  expect(
    selectWarmSimulator({
      ios: [
        { name: "iPhone 17e", udid: "bad", isAvailable: false },
        { name: "iPhone 17", udid: "fallback" },
      ],
    })?.udid,
  ).toBe("fallback");
  expect(
    selectWarmSimulator({
      ios: [
        { name: "iPhone 17", udid: "other" },
        { name: "iPhone 17e", udid: "preferred" },
      ],
    })?.udid,
  ).toBe("preferred");
  expect(selectWarmSimulator({ ios: [{ name: "iPad", udid: "tablet" }] })).toBeNull();
});

test("idle counts sessions, not prewarmed devices; failed inventory is unknown", () => {
  expect(sessionDeviceCount({ result: { ok: true, data: { sessions: [] } } })).toBe(0);
  expect(
    sessionDeviceCount({
      result: {
        ok: true,
        data: {
          sessions: [
            { platform: "ios", id: "phone" },
            { platform: "ios", device_id: "phone" },
          ],
        },
      },
    }),
  ).toBe(1);
  expect(sessionDeviceCount({ result: { ok: false } })).toBeNull();
  expect(sessionDeviceCount({ result: { ok: true, data: { sessions: [{}] } } })).toBeNull();
});

describe("remote commands", () => {
  test("startup timeout and session are stable across tunnel URLs", () => {
    const oldArgs = remoteArgs(
      ["open", "com.apple.Preferences", "--device", "iPhone"],
      info,
      "/state",
    );
    const nextArgs = remoteArgs(
      ["open", "com.apple.Preferences", "--device", "iPhone"],
      { ...info, tunnelUrl: "https://new.example" },
      "/state",
    );
    expect(oldArgs).toContain("300000");
    expect(oldArgs).toContain("simbox-run-1");
    expect(nextArgs.slice(0, -3)).toEqual(oldArgs.slice(0, -3));
    expect(nextArgs.at(-3)).toBe("https://new.example/agent-device");
    expect(oldArgs.join(" ")).not.toContain("secret");
  });
  test("routing flags are inserted before a positional separator", () => {
    const args = remoteArgs(["open", "--", "--some-app"], info, "/state");
    expect(args.indexOf("--daemon-base-url")).toBeLessThan(args.indexOf("--"));
    expect(args.at(-1)).toBe("--some-app");
  });
  test("explicit timeout/session respected; taps are not assigned startup budgets", () => {
    const args = remoteArgs(
      ["open", "app", "--timeout", "420000", "--session=other"],
      info,
      "/state",
    );
    expect(args.filter((arg) => arg === "--timeout")).toHaveLength(1);
    expect(args).not.toContain("300000");
    expect(args).not.toContain("simbox-run-1");
    expect(remoteArgs(["press", "@e1"], info, "/state")).not.toContain("--timeout");
  });
  test("readiness waits for the newly registered tunnel without replaying commands", async () => {
    const probes: string[] = [];
    const result = await waitForRemote(info, {
      probe: async (current) => {
        probes.push(current.tunnelUrl);
        return current.tunnelUrl === "https://new.example";
      },
      refresh: async () => ({ ...info, tunnelUrl: "https://new.example" }),
      pause: async () => {},
    });
    expect(result.tunnelUrl).toBe("https://new.example");
    expect(probes).toEqual(["https://old.example", "https://new.example"]);
  });
  test("readiness does not silently switch to another run", async () => {
    await expect(
      waitForRemote(info, {
        probe: async () => false,
        refresh: async () => ({ ...info, runId: "replacement" }),
      }),
    ).rejects.toThrow("ended or was replaced");
  });
  test("readiness has a bounded failure with a useful error", async () => {
    await expect(
      waitForRemote(info, {
        timeoutMs: 0,
        probe: async () => false,
        refresh: async () => info,
        pause: async () => {},
      }),
    ).rejects.toThrow("No device command was sent");
  });
});

test("readiness requires actual proxy/upstream health, not HTTP 200 HTML or a dead daemon", () => {
  expect(healthyProxy(200, { ok: true, upstream: { ok: true } })).toBe(true);
  expect(healthyProxy(200, { ok: true, upstream: { ok: false } })).toBe(false);
  expect(healthyProxy(200, { ok: false })).toBe(false);
  expect(healthyProxy(200, "<html>error</html>")).toBe(false);
  expect(healthyProxy(530, { ok: true })).toBe(false);
});

function port(server: Server): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
}

describe("runner activity gateway", () => {
  test("long RPCs stream JSON whitespace keepalives before the final response", async () => {
    let calls = 0;
    let forwarded: any;
    const result = {
      jsonrpc: "2.0",
      id: "cold-open",
      result: { ok: true, data: { opened: true } },
    };
    const upstream = createServer((req, res) => {
      calls++;
      let text = "";
      req.on("data", (chunk) => {
        text += chunk;
      });
      req.on("end", () => {
        forwarded = JSON.parse(text);
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(result));
        }, 100);
      });
    });
    await listen(upstream);
    const gateway = startGateway({
      port: 0,
      upstreamPort: port(upstream),
      token: "secret",
      heartbeatMs: 10,
    });
    try {
      const response = await fetch(`http://127.0.0.1:${gateway.server.port}/agent-device/rpc`, {
        method: "POST",
        headers: { Authorization: "Bearer secret", "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "cold-open",
          method: "agent_device.command",
          params: { command: "open", meta: { requestProgress: "command", requestId: "request-1" } },
        }),
      });
      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value).trim()).toBe("");
      expect(gateway.activity().inFlight).toBe(1);
      let text = new TextDecoder().decode(first.value);
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += new TextDecoder().decode(chunk.value);
      }
      expect(JSON.parse(text)).toEqual(result);
      expect(text.match(/ \n/g)!.length).toBeGreaterThan(1);
      expect(forwarded.params.meta).toEqual({ requestId: "request-1" });
      expect(calls).toBe(1);
      expect(gateway.activity().inFlight).toBe(0);
    } finally {
      await gateway.server.stop(true);
      upstream.closeAllConnections();
      upstream.close();
    }
  });
  test("streamed RPC deadline returns valid JSON-RPC instead of whitespace/HTML", async () => {
    const upstream = createServer(() => {});
    await listen(upstream);
    const gateway = startGateway({
      port: 0,
      upstreamPort: port(upstream),
      token: "secret",
      requestTimeoutMs: 30,
      heartbeatMs: 5,
    });
    try {
      const response = await fetch(`http://127.0.0.1:${gateway.server.port}/agent-device/rpc`, {
        method: "POST",
        headers: { Authorization: "Bearer secret" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "timeout",
          method: "agent_device.command",
          params: { command: "open" },
        }),
      });
      const body = (await response.json()) as { id: string; error: { code: number } };
      expect(body.id).toBe("timeout");
      expect(body.error.code).toBe(-32000);
      expect(gateway.activity().inFlight).toBe(0);
    } finally {
      await gateway.server.stop(true);
      upstream.closeAllConnections();
      upstream.close();
    }
  });
  test("a hung request has a deadline and cannot suppress idle shutdown forever", async () => {
    const upstream = createServer(() => {});
    await listen(upstream);
    const gateway = startGateway({
      port: 0,
      upstreamPort: port(upstream),
      token: "secret",
      requestTimeoutMs: 30,
    });
    try {
      const response = await fetch(`http://127.0.0.1:${gateway.server.port}/agent-device/rpc`, {
        method: "POST",
        headers: { Authorization: "Bearer secret" },
        body: "{}",
      });
      expect(response.status).toBe(504);
      expect(gateway.activity().inFlight).toBe(0);
    } finally {
      await gateway.server.stop(true);
      upstream.closeAllConnections();
      upstream.close();
    }
  });
  test("health/auth failures are idle; in-progress RPCs and completion reset idle", async () => {
    let finishRpc: (() => void) | undefined;
    const upstream = createServer((req, res) => {
      if (req.url === "/agent-device/rpc") {
        finishRpc = () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end('{"ok":true}');
        };
      } else {
        res.end('{"ok":true}');
      }
    });
    await listen(upstream);
    const gateway = startGateway({ port: 0, upstreamPort: port(upstream), token: "secret" });
    await gateway.ready;
    const url = `http://127.0.0.1:${gateway.server.port}/agent-device`;
    try {
      const initial = gateway.activity();
      await fetch(`${url}/health`, { headers: { Authorization: "Bearer secret" } });
      await fetch(`${url}/other`, { headers: { Authorization: "Bearer wrong" } });
      expect(gateway.activity()).toEqual(initial);
      const pending = fetch(`${url}/rpc`, {
        method: "POST",
        headers: { Authorization: "Bearer secret" },
        body: "{}",
      });
      for (let i = 0; !finishRpc && i < 100; i++) await Bun.sleep(5);
      expect(finishRpc).toBeDefined();
      expect(gateway.activity().inFlight).toBe(1);
      finishRpc!();
      const response = await pending;
      expect(await response.json()).toEqual({ ok: true });
      expect(gateway.activity().inFlight).toBe(0);
      expect(gateway.activity().lastActivityAt).toBeGreaterThanOrEqual(initial.lastActivityAt);
    } finally {
      await gateway.server.stop(true);
      upstream.closeAllConnections();
      upstream.close();
    }
  });
  test("client cancellation cancels upstream work and releases in-flight accounting", async () => {
    let canceled = false;
    let received = false;
    const upstream = createServer((req, res) => {
      received = true;
      res.on("close", () => {
        canceled = true;
      });
      req.socket.on("close", () => {
        canceled = true;
      });
    });
    await listen(upstream);
    const gateway = startGateway({ port: 0, upstreamPort: port(upstream), token: "secret" });
    await gateway.ready;
    try {
      // A real Node CLI disconnect; Bun's outgoing ClientRequest.destroy has
      // different socket behavior from the installed agent-device client.
      const client = Bun.spawn(
        [
          "node",
          "-e",
          `
        const { request } = require('node:http');
        const req = request('http://127.0.0.1:${gateway.server.port}/agent-device/rpc', {
          method: 'POST', headers: { Authorization: 'Bearer secret' }
        });
        req.on('error', () => {}); req.end(JSON.stringify({ jsonrpc: '2.0', id: 'cancel', method: 'agent_device.command', params: { command: 'open' } }));
      `,
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
      for (let i = 0; !received && i < 100; i++) await Bun.sleep(5);
      expect(gateway.activity().inFlight).toBe(1);
      client.kill();
      await client.exited;
      for (let i = 0; !canceled && i < 100; i++) await Bun.sleep(5);
      expect(canceled).toBe(true);
      expect(gateway.activity().inFlight).toBe(0);
    } finally {
      await gateway.server.stop(true);
      upstream.closeAllConnections();
      upstream.close();
    }
  });
});
