/**
 * Provisioning: install agent-device via npm and download pinned cloudflared.
 * Device preparation lives in the platform adapters (ios.ts, android.ts).
 */
import { chmod, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PINS } from "./pins.js";
import { endGroup, info, relay, startGroup } from "./log.js";
import { run, which } from "./proc.js";

/** Directory the agent uses for downloaded binaries. */
export function binDir(): string {
  const base = Bun.env.RUNNER_TEMP ?? join(tmpdir(), "simbox");
  return join(base, "simbox-bin");
}

/**
 * `npm i -g agent-device@<pin>` — Node/npm exist in the macOS runner toolcache.
 * Returns the resolved path to the agent-device binary.
 */
export async function installAgentDevice(): Promise<string> {
  startGroup("Install agent-device");
  try {
    const spec = `agent-device@${PINS.agentDevice}`;
    info(`npm i -g ${spec}`);
    const res = await run(["npm", "i", "-g", spec], { timeoutMs: 240_000 });
    for (const l of res.stdout.split("\n")) {
      if (l.trim()) relay("npm", l);
    }
    for (const l of res.stderr.split("\n")) {
      if (l.trim()) relay("npm", l);
    }
    if (res.code !== 0) throw new Error(`npm i -g ${spec} exited ${res.code}`);

    // Resolve the binary: PATH first, then the global npm prefix (global
    // installs can land outside PATH on some runner images).
    const onPath = await which("agent-device");
    if (onPath) {
      info(`agent-device at ${onPath}`);
      return onPath;
    }
    const prefix = await run(["npm", "prefix", "-g"]);
    const guess = join(prefix.stdout.trim(), "bin", "agent-device");
    if (existsSync(guess)) {
      info(`agent-device at ${guess}`);
      return guess;
    }
    throw new Error("agent-device installed but binary not found on PATH or npm prefix");
  } finally {
    endGroup();
  }
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
