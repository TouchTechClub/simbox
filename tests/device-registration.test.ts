import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("CLI hands off selected devices privately without putting credentials in the receipt output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "simbox-device-registration-"));
  const module = new URL("../apps/cli/src/device-registration.ts", import.meta.url).pathname;
  const run = async (options: unknown, extra: Record<string, string> = {}) => {
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import {registerDevice} from ${JSON.stringify(module)}; registerDevice({runId:'039dd761-9144-4a9c-a03b-e44c893d73ad',tunnelUrl:'https://fixture.trycloudflare.com',daemonToken:'private-daemon-token',expiresAt:null}, ${JSON.stringify(options)});`,
      ],
      {
        env: {
          ...process.env,
          SIMBOX_DEVICE_REGISTRATION_DIR: directory,
          XDG_CONFIG_HOME: directory,
          ...extra,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    return {
      code: await child.exited,
      stdout: await new Response(child.stdout).text(),
      stderr: await new Response(child.stderr).text(),
    };
  };
  try {
    const result = await run({
      args: [
        "open",
        "app",
        "--platform=ios",
        "--udid",
        "ABCD-1234",
        "--",
        "--serial=not-a-selector",
      ],
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^\[simbox-device:[a-f0-9-]{36}\]\n$/);
    expect(result.stderr).not.toContain("private-daemon-token");
    expect(result.stderr).not.toContain("trycloudflare");
    const files = await readdir(directory);
    expect(files).toHaveLength(1);
    const file = join(directory, files[0]!);
    const input = JSON.parse(await readFile(file, "utf8"));
    expect(input.deviceId).toBe("ABCD-1234");
    expect(input.platform).toBe("ios");
    expect(input.daemonToken).toBe("private-daemon-token");
    expect(input.autoBoot).toBe(false);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await run({ stop: true })).stderr).toContain("[simbox-device:");
    expect((await readdir(directory)).length).toBe(2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
