/** Protocol/input mappings reference T3 Code (MIT, © 2026 T3 Tools Inc.).
 * Full notice: docs/THIRD-PARTY-NOTICES.md; included in release artifacts.
 */
import type { DevicePlatform } from "./runners.js";

export const PREVIEW_SESSION_MS = 5 * 60_000;
export const PREVIEW_MAX_MESSAGE = 16_384;
export interface PreviewDevice {
  id: string;
  name: string;
  platform: DevicePlatform;
  version: string;
}
export interface PreviewInventory {
  devices: PreviewDevice[];
  observedAt: number;
}
export interface PreviewAccess {
  ticket: string;
  expiresAt: number;
}
export type PreviewInput =
  | { type: "touch"; phase: "begin" | "move" | "end"; x: number; y: number }
  | { type: "key"; phase: "down" | "up"; code: string; key: string }
  | { type: "button"; button: "home" | "back" | "recents" | "power" }
  | {
      type: "rotate";
      orientation: "portrait" | "landscape_left" | "landscape_right" | "portrait_upside_down";
    }
  | { type: "text"; text: string }
  | { type: "reset-video" };

export function validPreviewDevice(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id);
}

/** Only active virtual devices, never paths supplied by the upstream service. */
export function previewInventory(raw: unknown, platform: DevicePlatform): PreviewInventory {
  const data = raw as { simulators?: unknown; emulators?: unknown } | null;
  const list = platform === "ios" ? data?.simulators : data?.emulators;
  if (!Array.isArray(list)) throw new Error("Invalid device hub inventory");
  const devices: PreviewDevice[] = [];
  for (const item of list.slice(0, 100)) {
    if (
      !item ||
      typeof item !== "object" ||
      item.platform !== platform ||
      item.booted !== true ||
      item.physical === true ||
      item.supported === false ||
      !validPreviewDevice(item.id)
    )
      continue;
    if (devices.some((device) => device.id === item.id)) continue;
    devices.push({
      id: item.id,
      name: typeof item.name === "string" ? item.name.slice(0, 150) : item.id,
      version: typeof item.version === "string" ? item.version.slice(0, 80) : "",
      platform,
    });
  }
  return { devices, observedAt: Date.now() };
}

export function parsePreviewInput(raw: unknown): PreviewInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid input");
  const value = raw as Record<string, unknown>;
  const unit = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
  switch (value.type) {
    case "touch":
      if (
        !["begin", "move", "end"].includes(String(value.phase)) ||
        !unit(value.x) ||
        !unit(value.y)
      )
        break;
      return {
        type: "touch",
        phase: value.phase as "begin" | "move" | "end",
        x: value.x as number,
        y: value.y as number,
      };
    case "key":
      if (
        !["down", "up"].includes(String(value.phase)) ||
        typeof value.code !== "string" ||
        !/^[A-Za-z0-9]{1,32}$/.test(value.code) ||
        typeof value.key !== "string" ||
        value.key.length > 32
      )
        break;
      return { type: "key", phase: value.phase as "down" | "up", code: value.code, key: value.key };
    case "button":
      if (!["home", "back", "recents", "power"].includes(String(value.button))) break;
      return { type: "button", button: value.button as "home" | "back" | "recents" | "power" };
    case "rotate":
      if (
        !["portrait", "landscape_left", "landscape_right", "portrait_upside_down"].includes(
          String(value.orientation),
        )
      )
        break;
      return { type: "rotate", orientation: value.orientation as "portrait" };
    case "text":
      if (typeof value.text !== "string" || value.text.length < 1 || value.text.length > 1000)
        break;
      return { type: "text", text: value.text };
    case "reset-video":
      return { type: "reset-video" };
  }
  throw new Error("Unsupported or out-of-bounds device input");
}

export function hidUsage(code: string): number | null {
  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3) - 65 + 4;
  if (/^Digit[1-9]$/.test(code)) return Number(code.slice(5)) + 29;
  return (
    (
      {
        Digit0: 39,
        Enter: 40,
        Escape: 41,
        Backspace: 42,
        Tab: 43,
        Space: 44,
        Minus: 45,
        Equal: 46,
        BracketLeft: 47,
        BracketRight: 48,
        Backslash: 49,
        Semicolon: 51,
        Quote: 52,
        Backquote: 53,
        Comma: 54,
        Period: 55,
        Slash: 56,
        CapsLock: 57,
        Delete: 76,
        ArrowRight: 79,
        ArrowLeft: 80,
        ArrowDown: 81,
        ArrowUp: 82,
        ControlLeft: 224,
        ShiftLeft: 225,
        AltLeft: 226,
        MetaLeft: 227,
        ControlRight: 228,
        ShiftRight: 229,
        AltRight: 230,
        MetaRight: 231,
      } as Record<string, number>
    )[code] ?? null
  );
}

function tagged(tag: number, payload: unknown): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(payload));
  const bytes = new Uint8Array(json.length + 1);
  bytes[0] = tag;
  bytes.set(json, 1);
  return bytes;
}

/** A deliberately small wire allowlist: no shell, app management or generic RPC. */
export function hubInput(
  platform: DevicePlatform,
  input: PreviewInput,
): string | Uint8Array | null {
  if (platform === "android") {
    switch (input.type) {
      case "touch":
        return JSON.stringify({
          type: "touch",
          action: input.phase === "begin" ? "down" : input.phase === "end" ? "up" : "move",
          x: input.x,
          y: input.y,
        });
      case "button":
        return JSON.stringify({ type: input.button });
      case "text":
        return JSON.stringify(input);
      case "reset-video":
        return JSON.stringify({ type: "reset-video", ack: false });
      case "key": {
        if (input.phase === "up") return null;
        const keycode = (
          {
            Enter: 66,
            Backspace: 67,
            Delete: 112,
            Tab: 61,
            ArrowUp: 19,
            ArrowDown: 20,
            ArrowLeft: 21,
            ArrowRight: 22,
            Escape: 4,
          } as Record<string, number>
        )[input.key];
        if (keycode !== undefined) return JSON.stringify({ type: "key", keycode });
        return input.key.length === 1 ? JSON.stringify({ type: "text", text: input.key }) : null;
      }
      default:
        return null;
    }
  }
  switch (input.type) {
    case "touch":
      return tagged(0x03, { type: input.phase, x: input.x, y: input.y });
    case "button":
      return input.button === "back"
        ? null
        : tagged(0x04, {
            button:
              input.button === "recents"
                ? "app_switcher"
                : input.button === "power"
                  ? "lock"
                  : "home",
          });
    case "key": {
      const usage = hidUsage(input.code);
      return usage === null ? null : tagged(0x06, { type: input.phase, usage });
    }
    case "rotate":
      return tagged(0x07, { orientation: input.orientation });
    default:
      return null;
  }
}

export const iosHardwareKeyboard = () => tagged(0x0d, { enabled: false });
