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

/** One Simlock stream frame: `[u32 length][u8 tag][payload]`, length counting the tag. */
function frame(tag: number, payload: number[]): number[] {
  const length = payload.length + 1;
  return [
    length >>> 24,
    (length >>> 16) & 255,
    (length >>> 8) & 255,
    length & 255,
    tag,
    ...payload,
  ];
}

const NAMES = ["window", "VideoDecoder", "EncodedVideoChunk", "WebSocket", "fetch"] as const;

/** Browser globals for one stream; `body` is the lease's stream response. */
async function withStream(
  platform: "ios" | "android",
  body: number[],
  run: (state: {
    decoded: any[];
    sent: string[];
    states: string[];
    fetches: string[];
    socket: any;
  }) => Promise<void>,
) {
  const { startDeviceStream, directory } = await loadStream();
  const globals = globalThis as Record<string, any>;
  const originals = NAMES.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  const state = {
    decoded: [] as any[],
    sent: [] as string[],
    states: [] as string[],
    fetches: [] as string[],
    socket: undefined as any,
  };
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
      decode(chunk: unknown) {
        state.decoded.push(chunk);
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
        // oxlint-disable-next-line typescript/no-this-alias
        state.socket = this;
      }
      send(value: string) {
        state.sent.push(value);
      }
      close() {
        this.readyState = 3;
      }
    };
    globals.fetch = async (url: string) => {
      state.fetches.push(url);
      return new Response(new Uint8Array(body));
    };
    stream = startDeviceStream({
      runId: "test",
      device: { id: "lse_1", name: "test", platform },
      control: false,
      canvas: {
        getContext: () => ({
          save() {},
          translate() {},
          rotate() {},
          drawImage() {},
          restore() {},
        }),
      },
      status(_status: string, detail: string) {
        state.states.push(detail);
      },
      input() {},
      frame() {},
    });
    await Bun.sleep(1);
    state.socket.onopen();
    await run(state);
  } finally {
    stream?.stop();
    await rm(directory, { recursive: true, force: true });
    NAMES.forEach((name, index) => {
      const descriptor = originals[index];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globals[name];
    });
  }
}

for (const platform of ["ios", "android"] as const)
  test(`${platform} decodes the lease stream in order across the codec check`, async () => {
    // A keyframe and a delta land in the same chunk as the avcC record,
    // before the asynchronous codec support check resolves.
    const body = [
      ...frame(1, [1, 0x42, 0, 0x1e, 0xff]),
      ...frame(2, [0, 0, 0, 1, 0x65]),
      ...frame(3, [0, 0, 0, 1, 0x41]),
    ];
    await withStream(platform, body, async ({ decoded, sent, fetches }) => {
      await Bun.sleep(60);
      expect(decoded.map((chunk) => chunk.type)).toEqual(["key", "delta"]);
      expect(fetches[0]).toBe("/v1/runs/test/preview/video?device=lse_1");
      expect(sent).toEqual([]);
    });
  });

test("an ended lease stops the preview instead of reconnecting", async () => {
  await withStream("ios", frame(7, []), async ({ states, fetches }) => {
    await Bun.sleep(60);
    expect(states.at(-1)).toContain("lease ended");
    await Bun.sleep(1100);
    expect(fetches).toHaveLength(1);
  });
});
