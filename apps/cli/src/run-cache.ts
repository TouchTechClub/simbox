import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./config.js";
import type { ConnectInfo } from "./connect.js";

const cachePath = () => join(configDir(), "current-run.json");

/**
 * The live run's endpoint, so each `exec` can go straight to the runner
 * instead of asking the API first (about 1.5s per command). A named tunnel
 * keeps one URL for the whole run; callers still health-check it and ask the
 * API whenever it stops answering. Holds the daemon token, so owner-only.
 */
export function readCachedRun(now = Date.now()): ConnectInfo | null {
  try {
    const info = JSON.parse(readFileSync(cachePath(), "utf8")) as Partial<ConnectInfo>;
    if (
      typeof info.runId !== "string" ||
      typeof info.tunnelUrl !== "string" ||
      typeof info.daemonToken !== "string"
    )
      return null;
    const expiresAt = typeof info.expiresAt === "number" ? info.expiresAt : null;
    if (expiresAt !== null && expiresAt <= now) return null;
    return {
      runId: info.runId,
      tunnelUrl: info.tunnelUrl,
      daemonToken: info.daemonToken,
      expiresAt,
    };
  } catch {
    return null;
  }
}

export function writeCachedRun(info: ConnectInfo): void {
  try {
    mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    writeFileSync(cachePath(), JSON.stringify(info), { mode: 0o600 });
    // mode only applies to new files; enforce it on an existing one too.
    chmodSync(cachePath(), 0o600);
  } catch {
    // A missing cache only costs the next command an API round-trip.
  }
}

export function clearCachedRun(): void {
  rmSync(cachePath(), { force: true });
}
