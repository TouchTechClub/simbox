import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { previewHubArgs, previewHubEnv } from "../packages/agent/src/preview-hub";

test("preview hub uses platform-compatible capture options", () => {
  const ios = previewHubArgs("darwin");
  expect(ios).toContain("ios");
  expect(ios).not.toContain("--stream-source");
  const android = previewHubArgs("linux");
  expect(android).toContain("android");
  expect(android[android.indexOf("--stream-source") + 1]).toBe("scrcpy");
});

test("hub capture subprocesses can resolve SDK tools without altering the agent environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "preview-sdk-"));
  try {
    await mkdir(join(root, "platform-tools"));
    await writeFile(join(root, "platform-tools", "adb"), "");
    const env = { PATH: "/usr/bin", ANDROID_HOME: "/missing-sdk", ANDROID_SDK_ROOT: root };
    const hub = previewHubEnv(env);
    expect(hub.PATH).toBe(
      [join(root, "platform-tools"), join(root, "emulator"), "/usr/bin"].join(delimiter),
    );
    expect(env.PATH).toBe("/usr/bin");
    expect(previewHubEnv({ PATH: "/usr/bin" }).PATH).toBe("/usr/bin");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
