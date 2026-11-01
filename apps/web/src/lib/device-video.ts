/** Simlock's lease stream framing and the canvas/device coordinate maths.
 * Bounded parsers are kept independent for protocol regression tests.
 */
const MAX_FRAME = 4 * 1024 * 1024;
export function avcCodec(bytes: Uint8Array): string {
  if (bytes.length < 4) throw new Error("Truncated AVC configuration");
  return `avc1.${Array.from(bytes.slice(1, 4), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
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
