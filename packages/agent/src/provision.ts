/**
 * Provisioning: download pinned cloudflared. Simlock and agent-device are
 * installed by simlock.ts; device preparation lives in ios.ts and android.ts.
 */
import { chmod, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PINS } from "./pins.js";
import { endGroup, info, startGroup, warn } from "./log.js";
import { run } from "./proc.js";

/** Directory the agent uses for downloaded binaries. */
export function binDir(): string {
  const base = Bun.env.RUNNER_TEMP ?? join(tmpdir(), "simbox");
  return join(base, "simbox-bin");
}

interface CloudflaredAsset {
  url: string;
  /** "tgz" assets need extraction; "bin" assets are written directly. */
  kind: "tgz" | "bin";
}

function cloudflaredAssets(tag: string): CloudflaredAsset[] {
  const base = `https://github.com/cloudflare/cloudflared/releases/download/${tag}`;
  if (process.platform === "linux") {
    return [
      {
        url: `${base}/cloudflared-linux-${process.arch === "arm64" ? "arm64" : "amd64"}`,
        kind: "bin",
      },
    ];
  }
  // macos-latest is arm64. Older tags only shipped darwin-amd64.tgz — try
  // arm64 first, amd64 (Rosetta) as fallback; .tgz before raw binaries.
  return [
    { url: `${base}/cloudflared-darwin-arm64.tgz`, kind: "tgz" },
    { url: `${base}/cloudflared-darwin-amd64.tgz`, kind: "tgz" },
    { url: `${base}/cloudflared-darwin-arm64`, kind: "bin" },
    { url: `${base}/cloudflared-darwin-amd64`, kind: "bin" },
  ];
}

/**
 * Socket buffer limits cloudflared needs. It opens a UDP socket even over
 * http2 and asks quic-go for a 7 MiB receive buffer, which hosted Macs cap at
 * 6 MiB ("failed to sufficiently increase receive buffer size") and Linux at
 * about 200 KiB. Values from quic-go's UDP buffer guide. Hosted Macs refuse any
 * kern.ipc.maxsockbuf above their default ("Result too large", even quic-go's
 * 8441037), and the tunnel runs over http2, so macOS keeps the warning.
 */
export const SOCKET_BUFFER_SYSCTLS: Partial<Record<NodeJS.Platform, Record<string, number>>> = {
  linux: { "net.core.rmem_max": 7_500_000, "net.core.wmem_max": 7_500_000 },
};

/** The settings to raise: each limit below its target, never a lowered one. */
export function socketBufferRaises(
  targets: Record<string, number>,
  current: Record<string, number | undefined>,
): string[] {
  return Object.entries(targets)
    .filter(([key, value]) => (current[key] ?? 0) < value)
    .map(([key, value]) => `${key}=${value}`);
}

/** Raise the host's socket buffer limits for cloudflared. Best effort: needs passwordless sudo. */
export async function raiseSocketBuffers(
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const targets = SOCKET_BUFFER_SYSCTLS[platform];
  if (!targets) return;
  const current: Record<string, number | undefined> = {};
  for (const key of Object.keys(targets)) {
    const read = await run(["sysctl", "-n", key], { timeoutMs: 10_000 });
    const value = Number(read.stdout.trim());
    if (read.code === 0 && Number.isFinite(value)) current[key] = value;
  }
  const raises = socketBufferRaises(targets, current);
  if (raises.length === 0) return;
  const result = await run(["sudo", "-n", "sysctl", "-w", ...raises], { timeoutMs: 10_000 });
  if (result.code === 0) info(`socket buffers raised for cloudflared: ${raises.join(", ")}`);
  else warn(`could not raise socket buffers: ${result.stderr.trim().slice(0, 200)}`);
}

/** Download pinned cloudflared → executable path in binDir(). */
export async function installCloudflared(): Promise<string> {
  startGroup("Install cloudflared");
  const dir = binDir();
  const dest = join(dir, "cloudflared");
  try {
    await mkdir(dir, { recursive: true });
    const tag = PINS.cloudflared;
    let lastErr: unknown = null;
    for (const asset of cloudflaredAssets(tag)) {
      info(`downloading ${asset.url}`);
      try {
        const res = await fetch(asset.url, {
          redirect: "follow",
          signal: AbortSignal.timeout(120_000),
        });
        if (!res.ok) {
          info(`  → HTTP ${res.status}, trying next asset`);
          continue;
        }
        // Consume the download before handing bytes to filesystem I/O. Passing
        // a network Response directly to Bun.write can leave compiled Linux
        // agents with no referenced event-loop work while the body is pending.
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (asset.kind === "tgz") {
          const file = join(dir, "cloudflared.tgz");
          await Bun.write(file, bytes);
          const untar = await run(["tar", "xzf", file, "-C", dir], { timeoutMs: 60_000 });
          if (untar.code !== 0 || !existsSync(dest)) {
            info(`  → untar failed (${untar.stderr.trim().slice(0, 200)}), trying next asset`);
            continue;
          }
        } else {
          await Bun.write(dest, bytes);
        }
        await chmod(dest, 0o755);
        info(`cloudflared ${tag} ready at ${dest}`);
        return dest;
      } catch (err) {
        lastErr = err;
        info(`  → ${String(err).slice(0, 200)}, trying next asset`);
      }
    }
    throw new Error(`all cloudflared assets failed (last: ${String(lastErr)})`);
  } finally {
    endGroup();
  }
}
