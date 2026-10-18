import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { clearCachedRun, readCachedRun, writeCachedRun } from "../apps/cli/src/run-cache";

let directory = "";
const previous = process.env.XDG_CONFIG_HOME;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "simbox-run-cache-"));
  process.env.XDG_CONFIG_HOME = directory;
});
afterEach(async () => {
  if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previous;
  await rm(directory, { recursive: true, force: true });
});

const info = {
  runId: "run-1",
  tunnelUrl: "https://r-0123456789abcdef.simboxtouchtech.dpdns.org",
  daemonToken: "private-daemon-token",
  expiresAt: Date.now() + 60_000,
};

test("each platform's live run endpoint is kept owner-only until it expires or the run stops", async () => {
  expect(readCachedRun("ios")).toBeNull();
  writeCachedRun("ios", info);
  expect(readCachedRun("ios")).toEqual(info);
  const file = join(directory, "simbox", "current-run-ios.json");
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  // Expired runs and stopped runs are never reused.
  expect(readCachedRun("ios", info.expiresAt + 1)).toBeNull();
  clearCachedRun("ios");
  expect(readCachedRun("ios")).toBeNull();
  // A corrupt or partial file is ignored rather than trusted.
  await writeFile(file, JSON.stringify({ platform: "ios", runId: "run-1" }));
  expect(readCachedRun("ios")).toBeNull();
  await writeFile(file, "{not json");
  expect(readCachedRun("ios")).toBeNull();
});

test("an iOS endpoint never serves Android and the two platforms stop independently", async () => {
  const android = { ...info, runId: "run-2", tunnelUrl: "https://android.example" };
  writeCachedRun("ios", info);
  expect(readCachedRun("android")).toBeNull();
  writeCachedRun("android", android);
  expect(readCachedRun("ios")).toEqual(info);
  expect(readCachedRun("android")).toEqual(android);
  clearCachedRun("ios");
  expect(readCachedRun("ios")).toBeNull();
  expect(readCachedRun("android")).toEqual(android);

  // A file copied (or written by mistake) under the other platform's name is ignored.
  const ios = join(directory, "simbox", "current-run-ios.json");
  await writeFile(ios, await readFile(join(directory, "simbox", "current-run-android.json")));
  expect(readCachedRun("ios")).toBeNull();
});

test("the legacy single-run cache is never read and is removed", async () => {
  await mkdir(join(directory, "simbox"), { recursive: true });
  const legacy = join(directory, "simbox", "current-run.json");
  await writeFile(legacy, JSON.stringify(info));
  expect(readCachedRun("ios")).toBeNull();
  expect(readCachedRun("android")).toBeNull();
  expect(existsSync(legacy)).toBe(false);
});
