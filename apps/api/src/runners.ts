import { eq } from "drizzle-orm";
import { schema, type Database } from "@simbox/db";
import {
  emptyDevicePreferences,
  emptyRunnerPreferences,
  resolveDevice,
  resolveRunner,
  type DevicePlatform,
  type DevicePreferences,
  type RunnerInventory,
  type RunnerSettings,
  type RunnerTarget,
} from "@simbox/shared";
import type { Env } from "./env";
import { getRepoForUser } from "./db";

export async function getRunnerSettings(db: Database, userId: string): Promise<RunnerSettings> {
  const [account, repo] = await Promise.all([
    db.select().from(schema.runnerSettings).where(eq(schema.runnerSettings.user_id, userId)).get(),
    getRepoForUser(db, userId),
  ]);
  const defaults = account
    ? { ios: account.ios_runner, android: account.android_runner }
    : emptyRunnerPreferences();
  const overrides = repo ? { ios: repo.ios_runner, android: repo.android_runner } : null;
  const accountDevices: DevicePreferences = account
    ? { ios: account.ios_device, android: account.android_device }
    : emptyDevicePreferences();
  const repoDevices: DevicePreferences | null = repo
    ? { ios: repo.ios_device, android: repo.android_device }
    : null;
  return {
    account: defaults,
    repository: overrides,
    repoFullName: repo?.full_name ?? null,
    effective: {
      ios: resolveRunner("ios", defaults, overrides),
      android: resolveRunner("android", defaults, overrides),
    },
    devices: {
      account: accountDevices,
      repository: repoDevices,
      effective: {
        ios: resolveDevice("ios", accountDevices, repoDevices),
        android: resolveDevice("android", accountDevices, repoDevices),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Runner inventory — the device catalog a runner image last reported, so the
// CLI and dashboard can offer real choices and ensure can reject impossible
// ones before spending a runner.
// ---------------------------------------------------------------------------

/** Runner images change every few weeks; an old catalog is still a useful hint. */
const INVENTORY_TTL_SECONDS = 60 * 24 * 3600;

function inventoryKey(repoId: number, platform: DevicePlatform, runner: RunnerTarget): string {
  const labels = runner.labels.map((label) => label.toLowerCase()).sort();
  return `inventory:${repoId}:${platform}:${labels.join(",")}`;
}

export async function readInventory(
  env: Pick<Env, "KV">,
  repoId: number,
  platform: DevicePlatform,
  runner: RunnerTarget,
): Promise<RunnerInventory | null> {
  const value = await env.KV.get(inventoryKey(repoId, platform, runner), "json");
  return (value as RunnerInventory | null) ?? null;
}

export async function writeInventory(
  env: Pick<Env, "KV">,
  repoId: number,
  inventory: RunnerInventory,
): Promise<void> {
  await env.KV.put(
    inventoryKey(repoId, inventory.platform, inventory.runner),
    JSON.stringify(inventory),
    { expirationTtl: INVENTORY_TTL_SECONDS },
  );
}
