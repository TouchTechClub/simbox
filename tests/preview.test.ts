import { expect, test } from "bun:test";
import {
  leaseInventory,
  parsePreviewInput,
  simlockInput,
  validPreviewDevice,
  hidUsage,
} from "../packages/shared/src/preview";
import {
  avcCodec,
  AvccFrames,
  devicePoint,
  iosDisplayRotation,
  iosRawPoint,
} from "../apps/web/src/lib/device-video";
import {
  signPreviewTicket,
  verifyPreviewTicket,
  bridgePreviewSockets,
} from "../apps/api/src/preview-ticket";

test("preview inventory is the run's Simlock leases, named from its devices", () => {
  const lease = { id: "lse_1", deviceId: "dev_1" };
  const inventory = leaseInventory(
    {
      leases: [
        lease,
        lease,
        { id: "lse_2", deviceId: "dev_unknown" },
        { id: "lse_3", deviceId: "dev_physical" },
        { id: "lse_4", deviceId: "dev_ios" },
        { id: "../../exec", deviceId: "dev_1" },
      ],
    },
    {
      devices: [
        { id: "dev_1", spec: { platform: "android", model: "Pixel 8", osVersion: "35" } },
        { id: "dev_physical", spec: { platform: "android", model: "Pixel", physical: true } },
        { id: "dev_ios", spec: { platform: "ios", model: "iPhone 17", osVersion: "26.5" } },
      ],
    },
    "android",
  );
  expect(inventory.devices).toEqual([
    { id: "lse_1", name: "Pixel 8", platform: "android", version: "35" },
    { id: "lse_2", name: "Leased device", platform: "android", version: "" },
  ]);
  expect(inventory.observedAt).toBeGreaterThan(0);
  // Without the device list, leases are still viewable.
  expect(leaseInventory({ leases: [lease] }, null, "ios").devices).toHaveLength(1);
  expect(() => leaseInventory({}, null, "ios")).toThrow();
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
  const encoded = simlockInput(touch)!;
  expect(encoded[0]).toBe(3);
  expect(JSON.parse(new TextDecoder().decode(encoded.subarray(1)))).toEqual({
    type: "begin",
    x: 0.5,
    y: 0.25,
  });
  const button = (name: "home" | "back" | "recents" | "power") =>
    JSON.parse(
      new TextDecoder().decode(simlockInput({ type: "button", button: name })!.subarray(1)),
    ).button;
  expect([button("home"), button("back"), button("recents"), button("power")]).toEqual([
    "home",
    "back",
    "app_switcher",
    "lock",
  ]);
  expect(hidUsage("KeyA")).toBe(4);
  expect(hidUsage("ShiftLeft")).toBe(225);
  expect(simlockInput({ type: "key", phase: "up", code: "KeyA", key: "a" })![0]).toBe(6);
  // Simlock's input socket cannot rotate or type text.
  expect(simlockInput({ type: "text", text: "hi" })).toBeNull();
  expect(simlockInput({ type: "rotate", orientation: "landscape_left" })).toBeNull();
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

test("fragmented Simlock stream frames, codec strings and coordinate maps", () => {
  expect(avcCodec(new Uint8Array([1, 0x42, 0xe0, 0x1e, 0xff]))).toBe("avc1.42e01e");
  const avcc = new Uint8Array([0, 0, 0, 4, 1, 10, 20, 30, 0, 0, 0, 2, 2, 40]);
  const parser = new AvccFrames();
  const frames = Array.from(avcc, (byte) => parser.push(new Uint8Array([byte]))).flat();
  expect(frames).toEqual([
    { tag: 1, payload: new Uint8Array([10, 20, 30]) },
    { tag: 2, payload: new Uint8Array([40]) },
  ]);
  expect(() => new AvccFrames().push(new Uint8Array([0xff, 0xff, 0xff, 0xff]))).toThrow();
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
test("Worker socket bridge translates input, enforces read-only and closes both peers", () => {
  const client = new Socket();
  const upstream = new Socket();
  const stop = bridgePreviewSockets(
    client as unknown as WebSocket,
    upstream as unknown as WebSocket,
    false,
  );
  // Admission becomes the panel's ready event; screen config passes through.
  upstream.message(new Uint8Array([0x83]).buffer);
  upstream.message(new Uint8Array([0x82, 0x7b, 0x7d]).buffer);
  upstream.message(new Uint8Array([1, 2]).buffer);
  expect(client.sent).toHaveLength(2);
  expect(JSON.parse(client.sent[0] as string)).toEqual({ type: "ready", control: false });
  client.message('{"type":"reset-video"}');
  expect(upstream.sent).toHaveLength(0);
  client.message('{"type":"button","button":"home"}');
  expect(client.closed).toMatchObject([{ code: 1008 }]);
  expect(upstream.closed).toMatchObject([{ code: 1008 }]);
  stop();
  expect(client.closed).toHaveLength(1);

  const controller = new Socket();
  const device = new Socket();
  bridgePreviewSockets(controller as unknown as WebSocket, device as unknown as WebSocket, true);
  controller.message('{"type":"touch","phase":"begin","x":0.5,"y":0.5}');
  expect((device.sent[0] as Uint8Array)[0]).toBe(3);
  controller.message('{"type":"exec","command":"ls"}');
  expect(controller.closed).toMatchObject([{ code: 1008 }]);
});
