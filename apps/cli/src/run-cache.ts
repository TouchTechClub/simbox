import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DevicePlatform } from "@simbox/shared";
import { configDir } from "./config.js";
import type { ConnectInfo } from "./connect.js";
import { holderId } from "./holder.js";

/** Each agent (holder) caches its own run: agents on one machine may use different runs. */
const cachePath = (platform: DevicePlatform) => {
  const holder = holderId();
  return join(
    configDir(),
    `current-run-${platform}${holder ? `-${holder.slice(0, 16)}` : ""}.json`,
  );
};

/** Pre-v2 single-run cache. It cannot say which platform it served, so it is never read. */
const legacyPath = () => join(configDir(), "current-run.json");

function removeLegacy(): void {
  try {
    rmSync(legacyPath(), { force: true });
  } catch {
    // Unreadable config dirs only cost an API round-trip.
  }
}

/**
 * One platform's live run endpoint, so each `exec` can go straight to the
 * runner instead of asking the API first (about 1.5s per command). A named
 * tunnel keeps one URL for the whole run; callers still health-check it and
 * ask the API whenever it stops answering. Holds the daemon token, so
 * owner-only. The file records its platform, and a mismatch is ignored, so an
 * iOS endpoint can never serve an Android command or vice versa.
 */
export function readCachedRun(platform: DevicePlatform, now = Date.now()): ConnectInfo | null {
  removeLegacy();
  try {
    const info = JSON.parse(readFileSync(cachePath(platform), "utf8")) as Partial<
      ConnectInfo & { platform: string }
    >;
    if (
      info.platform !== platform ||
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

export function writeCachedRun(platform: DevicePlatform, info: ConnectInfo): void {
  removeLegacy();
  const path = cachePath(platform);
  try {
    mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    const { runId, tunnelUrl, daemonToken, expiresAt } = info;
    writeFileSync(path, JSON.stringify({ platform, runId, tunnelUrl, daemonToken, expiresAt }), {
      mode: 0o600,
    });
    // mode only applies to new files; enforce it on an existing one too.
    chmodSync(path, 0o600);
  } catch {
    // A missing cache only costs the next command an API round-trip.
  }
}

export function clearCachedRun(platform: DevicePlatform): void {
  removeLegacy();
  rmSync(cachePath(platform), { force: true });
}
