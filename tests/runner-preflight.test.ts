import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("action preflight rejects wrong hosts and missing tools before any download", async () => {
  const template = await Bun.file(
    new URL("../action-src/action.yml.template", import.meta.url),
  ).text();
  const preflight = template
    .split("      run: |\n")[1]!
    .split('        case "$(uname -s)-$(uname -m)" in')[0]!
    .split("\n")
    .map((line) => line.replace(/^        /, ""))
    .join("\n");
  const dir = await mkdtemp(join(tmpdir(), "simbox-preflight-"));
  try {
    await mkdir(join(dir, "sdk/cmdline-tools/latest/bin"), { recursive: true });
    const writeTool = async (tool: string, body = "exit 0") => {
      const path = join(dir, tool);
      await Bun.write(path, `#!/bin/sh\n${body}\n`);
      await chmod(path, 0o755);
    };
    await writeTool(
      "uname",
      'if [ "$1" = "-s" ]; then echo "$FAKE_OS"; else echo "$FAKE_ARCH"; fi',
    );
    for (const tool of ["node", "npm", "curl", "tar", "shasum", "java"]) await writeTool(tool);
    await writeTool("xcrun", 'exit "${XCODE_EXIT:-0}"');
    const run = async (overrides: Record<string, string> = {}) => {
      const child = Bun.spawn(["/bin/bash", "-c", preflight], {
        env: {
          PATH: dir,
          FAKE_OS: "Darwin",
          FAKE_ARCH: "arm64",
          SIMBOX_PLATFORM: "ios",
          ...overrides,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      return { code: await child.exited, error: await new Response(child.stderr).text() };
    };
    expect((await run()).code).toBe(0);
    expect((await run({ SIMBOX_PLATFORM: "" })).code).toBe(0); // direct-action compatibility
    expect((await run({ SIMBOX_PLATFORM: "android" })).error).toContain("Unsupported runner");
    expect((await run({ FAKE_ARCH: "x86_64" })).error).toContain("Unsupported runner");
    expect(
      (await run({ FAKE_OS: "Linux", FAKE_ARCH: "aarch64", SIMBOX_PLATFORM: "android" })).code,
    ).toBe(1);
    expect((await run({ XCODE_EXIT: "1" })).error).toContain("Xcode with Simulator support");
    expect(
      (await run({ FAKE_OS: "Linux", FAKE_ARCH: "x86_64", SIMBOX_PLATFORM: "android" })).error,
    ).toContain("ANDROID_HOME");
    expect(
      (
        await run({
          FAKE_OS: "Linux",
          FAKE_ARCH: "x86_64",
          SIMBOX_PLATFORM: "android",
          ANDROID_HOME: join(dir, "sdk"),
        })
      ).error,
    ).toContain("sdkmanager");
    await rm(join(dir, "npm"));
    expect((await run()).error).toContain("Missing npm");
    expect(preflight).toContain("sudo -n chmod 666 /dev/kvm");
    expect(preflight).toContain("if [[ ! -r /dev/kvm || ! -w /dev/kvm ]]");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
