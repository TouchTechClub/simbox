/** Wire formats used by expo-device-hub and T3 Code's device stream client.
 * Reference: pingdotgg/t3code packages/client-runtime/src/device/stream.ts (MIT).
 * Bounded parsers are kept independent for protocol regression tests.
 */
const MAX_FRAME = 4 * 1024 * 1024;
export function avcCodec(bytes: Uint8Array): string {
  if (bytes.length < 4) throw new Error("Truncated AVC configuration");
  return `avc1.${Array.from(bytes.slice(1, 4), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
export function androidFrame(raw: ArrayBuffer) {
  const bytes = new Uint8Array(raw);
  if (bytes.length > MAX_FRAME) throw new Error("Oversized video frame");
  if (bytes.length > 16) {
    const view = new DataView(raw);
    if (view.getUint32(0) === 0x53454d55) {
      const version = view.getUint8(4);
      const offset = version === 1 ? 16 : version === 2 ? 24 : 0;
      if (!offset || bytes.length <= offset) throw new Error("Invalid SEMU frame header");
      const pts = view.getBigUint64(8);
      return {
        data: bytes.subarray(offset),
        key: (bytes[5]! & 1) !== 0,
        timestamp: pts <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(pts) : null,
      };
    }
  }
  return { data: bytes, key: null, timestamp: null };
}
export function scanAnnexB(bytes: Uint8Array) {
  let sps: Uint8Array | null = null;
  let key = false;
  for (let i = 0; i + 4 < bytes.length; i++) {
    if (bytes[i] !== 0 || bytes[i + 1] !== 0) continue;
    const start =
      bytes[i + 2] === 1 ? i + 3 : bytes[i + 2] === 0 && bytes[i + 3] === 1 ? i + 4 : -1;
    if (start < 0) continue;
    const type = bytes[start]! & 31;
    if (type === 7) sps = bytes.subarray(start);
    if (type === 5) key = true;
  }
  return { sps, key };
}
export class AvccFrames {
  private buffer = new Uint8Array(0);
  push(chunk: Uint8Array): Array<{ tag: number; payload: Uint8Array }> {
    if (chunk.length + this.buffer.length > MAX_FRAME * 2)
      throw new Error("AVCC buffer exceeded limit");
    const bytes = new Uint8Array(this.buffer.length + chunk.length);
    bytes.set(this.buffer);
    bytes.set(chunk, this.buffer.length);
    const frames: Array<{ tag: number; payload: Uint8Array }> = [];
    let offset = 0;
    while (bytes.length - offset >= 4) {
      const length = new DataView(bytes.buffer, offset).getUint32(0);
      if (length < 1 || length > MAX_FRAME) throw new Error("Invalid AVCC envelope length");
      if (bytes.length - offset < length + 4) break;
      frames.push({
        tag: bytes[offset + 4]!,
        payload: bytes.slice(offset + 5, offset + 4 + length),
      });
      offset += length + 4;
    }
    this.buffer = bytes.slice(offset);
    return frames;
  }
}

/** Continuous hub MJPEG fallback, not screenshot polling. */
export class JpegFrames {
  private buffer = new Uint8Array(0);
  push(chunk: Uint8Array): Uint8Array[] {
    if (chunk.length + this.buffer.length > MAX_FRAME * 2)
      throw new Error("MJPEG buffer exceeded limit");
    const bytes = new Uint8Array(this.buffer.length + chunk.length);
    bytes.set(this.buffer);
    bytes.set(chunk, this.buffer.length);
    const frames: Uint8Array[] = [];
    let start = -1;
    let consumed = 0;
    for (let i = 0; i + 1 < bytes.length; i++) {
      if (start < 0 && bytes[i] === 255 && bytes[i + 1] === 216) {
        start = i;
        i++;
      } else if (start >= 0 && bytes[i] === 255 && bytes[i + 1] === 217) {
        frames.push(bytes.slice(start, i + 2));
        consumed = i + 2;
        start = -1;
        i++;
      }
    }
    this.buffer = bytes.slice(start >= 0 ? start : Math.max(consumed, bytes.length - 1));
    return frames;
  }
}

/** Letterboxing is outside the canvas; input is normalized to its visible bounds. */
export function devicePoint(
  rect: { left: number; top: number; width: number; height: number },
  x: number,
  y: number,
) {
  return {
    x: Math.min(1, Math.max(0, (x - rect.left) / rect.width)),
    y: Math.min(1, Math.max(0, (y - rect.top) / rect.height)),
  };
}

/** serve-sim can retain a portrait framebuffer after a logical rotation. */
export function iosDisplayRotation(width: number, height: number, orientation: string): number {
  if (width > height) return 0;
  return (
    (
      { landscape_left: 90, landscape_right: -90, portrait_upside_down: 180 } as Record<
        string,
        number
      >
    )[orientation] ?? 0
  );
}
export function iosRawPoint(x: number, y: number, rotation: number) {
  if (rotation === 90) return { x: y, y: 1 - x };
  if (rotation === -90) return { x: 1 - y, y: x };
  if (rotation === 180) return { x: 1 - x, y: 1 - y };
  return { x, y };
}
