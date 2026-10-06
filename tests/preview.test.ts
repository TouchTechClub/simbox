import { expect, test } from "bun:test";
import {
  previewInventory,
  parsePreviewInput,
  hubInput,
  validPreviewDevice,
  hidUsage,
} from "../packages/shared/src/preview";
import {
  androidFrame,
  scanAnnexB,
  avcCodec,
  AvccFrames,
  JpegFrames,
  devicePoint,
  iosDisplayRotation,
  iosRawPoint,
} from "../apps/web/src/lib/device-video";
import {
  signPreviewTicket,
  verifyPreviewTicket,
  bridgePreviewSockets,
} from "../apps/api/src/preview-ticket";

test("preview inventory includes only exact booted supported virtual targets", () => {
  const item = {
    id: "emulator-5554",
    name: "Pixel",
    platform: "android",
    booted: true,
    physical: false,
    version: "Android 14",
  };
  const inventory = previewInventory(
    {
      emulators: [
        item,
        item,
        { ...item, id: "off", booted: false },
        { ...item, id: "physical", physical: true },
        { ...item, id: "bad", supported: false },
        { ...item, id: "../../exec" },
        { ...item, id: "ios", platform: "ios" },
      ],
    },
    "android",
  );
  expect(inventory.devices).toEqual([
    { id: item.id, name: item.name, platform: "android", version: item.version },
  ]);
  expect(inventory.observedAt).toBeGreaterThan(0);
  for (const value of ["../a", "a/b", "?device=x", "$(id)", "a%2Fexec", "", "x".repeat(129)])
    expect(validPreviewDevice(value)).toBe(false);
});

test("control validation rejects generic RPC, shell and unbounded gestures", () => {
  for (const value of [
    null,
    [],
    { type: "exec", command: "ls" },
    { type: "touch", phase: "begin", x: 2, y: 0 },
    { type: "touch", phase: "down", x: 0, y: 0 },
    { type: "text", text: "x".repeat(1001) },
    { type: "button", button: "install" },
    { type: "key", phase: "down", code: "$(id)", key: "a" },
    { type: "rotate", orientation: "bad" },
  ])
    expect(() => parsePreviewInput(value)).toThrow();
  const touch = parsePreviewInput({
    type: "touch",
    phase: "begin",
    x: 0.5,
    y: 0.25,
    command: "untrusted",
  });
  expect(hubInput("android", touch)).toBe('{"type":"touch","action":"down","x":0.5,"y":0.25}');
  const ios = hubInput("ios", touch) as Uint8Array;
  expect(ios[0]).toBe(3);
  expect(JSON.parse(new TextDecoder().decode(ios.subarray(1)))).toEqual({
    type: "begin",
    x: 0.5,
    y: 0.25,
  });
  expect(hubInput("ios", { type: "button", button: "back" })).toBeNull();
  expect(hidUsage("KeyA")).toBe(4);
  expect(hidUsage("ShiftLeft")).toBe(225);
  expect(hubInput("android", { type: "key", phase: "up", code: "KeyA", key: "a" })).toBeNull();
});

test("short-lived preview tickets bind user/run/device/platform/control and resist tampering", async () => {
  const secret = "test-signing-secret";
  const now = Date.now();
  const access = await signPreviewTicket(
    secret,
    { userId: "user", runId: "run", device: "emulator-5554", platform: "android", control: false },
    now,
  );
  const claims = await verifyPreviewTicket(secret, access.ticket, now);
  expect(claims).toMatchObject({
    userId: "user",
    runId: "run",
    device: "emulator-5554",
    control: false,
  });
  expect(await verifyPreviewTicket(secret, access.ticket, now + 60_001)).toBeNull();
  expect(await verifyPreviewTicket("other", access.ticket, now)).toBeNull();
  expect(await verifyPreviewTicket(secret, "garbage", now)).toBeNull();
  const [body, signature] = access.ticket.split(".");
  const tampered = Buffer.from(
    JSON.stringify({ ...JSON.parse(Buffer.from(body!, "base64url").toString()), control: true }),
  ).toString("base64url");
  expect(await verifyPreviewTicket(secret, `${tampered}.${signature}`, now)).toBeNull();
});

test("SEMU v1/v2, Annex B and fragmented AVCC parsers support both hub video formats", () => {
  const annex = new Uint8Array([0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1e, 0, 0, 1, 0x65, 0xff]);
  expect(scanAnnexB(annex).key).toBe(true);
  expect(avcCodec(scanAnnexB(annex).sps!)).toBe("avc1.42e01e");
  for (const version of [1, 2]) {
    const offset = version === 1 ? 16 : 24;
    const packet = new Uint8Array(offset + annex.length);
    const view = new DataView(packet.buffer);
    view.setUint32(0, 0x53454d55);
    view.setUint8(4, version);
    view.setUint8(5, 1);
    view.setBigUint64(8, 123n);
    packet.set(annex, offset);
    expect(androidFrame(packet.buffer)).toEqual({ data: annex, key: true, timestamp: 123 });
  }
  const avcc = new Uint8Array([0, 0, 0, 4, 1, 10, 20, 30, 0, 0, 0, 2, 2, 40]);
  const parser = new AvccFrames();
  const frames = Array.from(avcc, (byte) => parser.push(new Uint8Array([byte]))).flat();
  expect(frames).toEqual([
    { tag: 1, payload: new Uint8Array([10, 20, 30]) },
    { tag: 2, payload: new Uint8Array([40]) },
  ]);
  expect(() => new AvccFrames().push(new Uint8Array([0xff, 0xff, 0xff, 0xff]))).toThrow();
  const jpeg = new JpegFrames();
  expect(jpeg.push(new Uint8Array([45, 45, 255]))).toEqual([]);
  expect(jpeg.push(new Uint8Array([216, 1, 2, 255, 217]))).toEqual([
    new Uint8Array([255, 216, 1, 2, 255, 217]),
  ]);
  expect(devicePoint({ left: 10, top: 20, width: 100, height: 200 }, 60, 120)).toEqual({
    x: 0.5,
    y: 0.5,
  });
  expect(devicePoint({ left: 10, top: 20, width: 100, height: 200 }, 999, -1)).toEqual({
    x: 1,
    y: 0,
  });
  expect(iosDisplayRotation(360, 720, "landscape_left")).toBe(90);
  expect(iosDisplayRotation(720, 360, "landscape_left")).toBe(0);
  expect(iosRawPoint(0.25, 0.75, 90)).toEqual({ x: 0.75, y: 0.75 });
  expect(iosRawPoint(0.25, 0.75, -90)).toEqual({ x: 0.25, y: 0.25 });
  expect(iosRawPoint(0.25, 0.75, 180)).toEqual({ x: 0.75, y: 0.25 });
});

class Socket extends EventTarget {
  sent: unknown[] = [];
  closed: unknown[] = [];
  send(value: unknown) {
    this.sent.push(value);
  }
  close(code: number, reason: string) {
    this.closed.push({ code, reason });
  }
  message(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}
test("Worker socket bridge enforces read-only input, forwards binary frames and closes both peers", () => {
  const client = new Socket();
  const upstream = new Socket();
  const stop = bridgePreviewSockets(
    client as unknown as WebSocket,
    upstream as unknown as WebSocket,
    false,
  );
  upstream.message(new Uint8Array([1, 2]).buffer);
  expect(client.sent).toHaveLength(1);
  client.message('{"type":"reset-video"}');
  expect(upstream.sent).toHaveLength(1);
  client.message('{"type":"button","button":"home"}');
  expect(client.closed).toMatchObject([{ code: 1008 }]);
  expect(upstream.closed).toMatchObject([{ code: 1008 }]);
  stop();
  expect(client.closed).toHaveLength(1);
});
