import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function loadStream() {
  const build = await Bun.build({
    entrypoints: [new URL("../apps/web/src/lib/device-stream.ts", import.meta.url).pathname],
    target: "browser",
    plugins: [
      {
        name: "local-preview-api",
        setup(builder) {
          builder.onLoad({ filter: /\/lib\/api\.ts$/ }, () => ({
            contents:
              'export const API_URL=""; export const api={previewAccess:async()=>({ticket:"test"})};',
            loader: "js",
          }));
        },
      },
    ],
  });
  expect(build.success).toBe(true);
  const directory = await mkdtemp(join(tmpdir(), "preview-stream-"));
  const modulePath = join(directory, "stream.mjs");
  await Bun.write(modulePath, await build.outputs[0]!.text());
  const { startDeviceStream } = await import(modulePath);
  return { startDeviceStream, directory };
}

test("Android session setup preserves frames during codec checks without a reset feedback loop", async () => {
  const { startDeviceStream, directory } = await loadStream();
  const names = ["window", "VideoDecoder", "EncodedVideoChunk", "WebSocket"] as const;
  const globals = globalThis as Record<string, any>;
  const originals = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  const sent: string[] = [];
  const decoded: any[] = [];
  let socket: any;
  let stream: ReturnType<typeof startDeviceStream> | undefined;
  try {
    globals.window = { location: { href: "http://localhost/" } };
    globals.VideoDecoder = class {
      static async isConfigSupported() {
        await Bun.sleep(20);
        return { supported: true };
      }
      state = "unconfigured";
      decodeQueueSize = 0;
      configure() {
        this.state = "configured";
      }
      decode(frame: unknown) {
        decoded.push(frame);
      }
      close() {
        this.state = "closed";
      }
    };
    globals.EncodedVideoChunk = class {
      constructor(value: unknown) {
        Object.assign(this, value);
      }
    };
    globals.WebSocket = class {
      static OPEN = 1;
      readyState = 1;
      bufferedAmount = 0;
      constructor() {
        // Capture the test socket to inject actual hub event ordering.
        // oxlint-disable-next-line typescript/no-this-alias
        socket = this;
      }
      send(value: string) {
        sent.push(value);
      }
      close() {
        this.readyState = 3;
      }
    };
    stream = startDeviceStream({
      runId: "test",
      device: { id: "emulator-5554", name: "test", platform: "android" },
      control: false,
      canvas: { getContext: () => ({}) },
      status() {},
      input() {},
      frame() {},
    });
    await Bun.sleep(1);
    socket.onmessage({ data: '{"type":"video-session"}' });
    // An SPS + IDR followed immediately by a delta arrives before the
    // asynchronous codec support check completes, as it does on real scrcpy.
    socket.onmessage({
      data: new Uint8Array([0, 0, 0, 1, 0x67, 0x42, 0, 0x1e, 0, 0, 0, 1, 0x65, 1]).buffer,
    });
    socket.onmessage({ data: new Uint8Array([0, 0, 0, 1, 0x41, 2]).buffer });
    await Bun.sleep(40);
    expect(decoded.map((frame) => frame.type)).toEqual(["key", "delta"]);
    expect(sent).toEqual([]);
  } finally {
    stream?.stop();
    await rm(directory, { recursive: true, force: true });
    names.forEach((name, index) => {
      const descriptor = originals[index];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globals[name];
    });
  }
});

test("iOS falls back to continuous MJPEG when AVCC stalls before headers and cancels on stop", async () => {
  const { startDeviceStream, directory } = await loadStream();
  const names = [
    "window",
    "VideoDecoder",
    "EncodedVideoChunk",
    "WebSocket",
    "fetch",
    "createImageBitmap",
  ] as const;
  const globals = globalThis as Record<string, any>;
  const originals = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  let socket: any;
  let stream: ReturnType<typeof startDeviceStream> | undefined;
  let avccAborted = false;
  let painted = 0;
  let mjpegRequests = 0;
  const states: string[] = [];
  const sent: string[] = [];
  try {
    globals.window = { location: { href: "http://localhost/" } };
    globals.VideoDecoder = class {};
    globals.EncodedVideoChunk = class {};
    globals.WebSocket = class {
      static OPEN = 1;
      readyState = 1;
      bufferedAmount = 0;
      constructor() {
        // oxlint-disable-next-line typescript/no-this-alias
        socket = this;
      }
      send(value: string) {
        sent.push(value);
      }
      close() {
        this.readyState = 3;
      }
    };
    globals.createImageBitmap = async () => ({ width: 400, height: 800, close() {} });
    globals.fetch = (url: string, init: RequestInit) => {
      if (url.includes("/video?"))
        return new Promise((_resolve, reject) => {
          init.signal!.addEventListener(
            "abort",
            () => {
              avccAborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
      mjpegRequests++;
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([255, 216, 255, 217]));
            },
          }),
        ),
      );
    };
    stream = startDeviceStream({
      runId: "test",
      device: { id: "ABCD-1234", name: "test", platform: "ios" },
      control: false,
      iosStartMs: 20,
      canvas: {
        getContext: () => ({
          save() {},
          translate() {},
          rotate() {},
          drawImage() {
            painted++;
          },
          restore() {},
        }),
      },
      status(_state: string, detail: string) {
        states.push(detail);
      },
      input() {},
      frame() {},
    });
    await Bun.sleep(1);
    socket.onopen();
    await Bun.sleep(60);
    expect(avccAborted).toBe(true);
    expect(mjpegRequests).toBe(2);
    expect(painted).toBeGreaterThan(0);
    expect(states).toContain("Live · MJPEG fallback");
    stream.stop();
    await Bun.sleep(40);
    expect(mjpegRequests).toBe(2);
    expect(sent).toEqual([]);
  } finally {
    stream?.stop();
    await rm(directory, { recursive: true, force: true });
    names.forEach((name, index) => {
      const descriptor = originals[index];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globals[name];
    });
  }
});
