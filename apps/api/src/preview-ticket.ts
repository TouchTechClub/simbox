import { PREVIEW_SESSION_MS, validPreviewDevice, type DevicePlatform } from "@simbox/shared";
import { base64ToBytes, bytesToBase64Url } from "./util";

export interface PreviewTicket {
  purpose: "simbox-preview";
  userId: string;
  runId: string;
  device: string;
  platform: DevicePlatform;
  control: boolean;
  expiresAt: number;
}
const encoder = new TextEncoder();
async function signingKey(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
export async function signPreviewTicket(
  secret: string,
  claims: Omit<PreviewTicket, "purpose" | "expiresAt">,
  now = Date.now(),
) {
  const ticket: PreviewTicket = { ...claims, purpose: "simbox-preview", expiresAt: now + 60_000 };
  const payload = bytesToBase64Url(encoder.encode(JSON.stringify(ticket)));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await signingKey(secret),
    encoder.encode(payload),
  );
  return {
    ticket: `${payload}.${bytesToBase64Url(new Uint8Array(signature))}`,
    expiresAt: ticket.expiresAt,
  };
}
export async function verifyPreviewTicket(
  secret: string,
  value: string,
  now = Date.now(),
): Promise<PreviewTicket | null> {
  try {
    if (value.length > 2000 || !/^[\w-]+\.[\w-]+$/.test(value)) return null;
    const [payload, signature] = value.split(".");
    const decode = (part: string) =>
      base64ToBytes(
        part
          .replace(/-/g, "+")
          .replace(/_/g, "/")
          .padEnd(Math.ceil(part.length / 4) * 4, "="),
      );
    if (
      !(await crypto.subtle.verify(
        "HMAC",
        await signingKey(secret),
        decode(signature!),
        encoder.encode(payload),
      ))
    )
      return null;
    const claims: PreviewTicket = JSON.parse(new TextDecoder().decode(decode(payload!)));
    if (
      claims.purpose !== "simbox-preview" ||
      typeof claims.userId !== "string" ||
      typeof claims.runId !== "string" ||
      !validPreviewDevice(claims.device) ||
      !["ios", "android"].includes(claims.platform) ||
      typeof claims.control !== "boolean" ||
      !Number.isFinite(claims.expiresAt) ||
      claims.expiresAt <= now ||
      claims.expiresAt > now + 60_000
    )
      return null;
    return claims;
  } catch {
    return null;
  }
}

/** Workers terminates both halves after a bounded viewing lease. No input replay. */
export function bridgePreviewSockets(
  client: WebSocket,
  upstream: WebSocket,
  control: boolean,
  sessionMs = PREVIEW_SESSION_MS,
) {
  let stopped = false;
  const close = (code = 1011, reason = "Preview disconnected; reconnect to view") => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    for (const socket of [client, upstream]) {
      try {
        socket.close(code, reason);
      } catch {
        /* already closed */
      }
    }
  };
  const timer = setTimeout(
    () => close(4000, "Renew preview access"),
    Math.min(sessionMs, PREVIEW_SESSION_MS),
  );
  client.addEventListener("message", (event) => {
    try {
      if (typeof event.data !== "string" || event.data.length > 16_384) {
        close(1008, "Invalid input");
        return;
      }
      const input = JSON.parse(event.data);
      if (!control && input.type !== "reset-video") {
        close(1008, "Read-only preview");
        return;
      }
      upstream.send(event.data);
    } catch {
      close(1008, "Invalid input");
    }
  });
  upstream.addEventListener("message", (event) => {
    try {
      if (
        (typeof event.data === "string" ? event.data.length : event.data.byteLength) >
        4 * 1024 * 1024
      ) {
        close(1009, "Oversized frame");
        return;
      }
      client.send(event.data);
    } catch {
      close();
    }
  });
  for (const socket of [client, upstream]) {
    socket.addEventListener("close", () => close(1000, "Preview closed"));
    socket.addEventListener("error", () => close());
  }
  return close;
}
