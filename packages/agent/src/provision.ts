/**
 * Provisioning: download pinned cloudflared. Simlock and agent-device are
 * installed by simlock.ts; device preparation lives in ios.ts and android.ts.
 */
import { chmod, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PINS } from "./pins.js";
import { endGroup, info, startGroup } from "./log.js";
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
