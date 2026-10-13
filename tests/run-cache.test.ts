import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
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

test("the live run's endpoint is kept owner-only until it expires or the run stops", async () => {
  expect(readCachedRun()).toBeNull();
  writeCachedRun(info);
  expect(readCachedRun()).toEqual(info);
  const file = join(directory, "simbox", "current-run.json");
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  // Expired runs and stopped runs are never reused.
  expect(readCachedRun(info.expiresAt + 1)).toBeNull();
  clearCachedRun();
  expect(readCachedRun()).toBeNull();
  // A corrupt or partial file is ignored rather than trusted.
  await writeFile(file, JSON.stringify({ runId: "run-1" }));
  expect(readCachedRun()).toBeNull();
  await writeFile(file, "{not json");
  expect(readCachedRun()).toBeNull();
});
