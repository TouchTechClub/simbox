import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareAndroid, configureAndroidEnvironment } from "../packages/agent/src/provision.js";
import type { ChildProc } from "../packages/agent/src/proc.js";

test("provisioning owns the AVD registry and only marks ready after a booted emulator", async () => {
  const dir = await mkdtemp(join(tmpdir(), "simbox-android-test-"));
  const keys = [
    "ANDROID_HOME",
    "ANDROID_SDK_ROOT",
    "ANDROID_USER_HOME",
    "ANDROID_AVD_HOME",
    "ANDROID_EMULATOR_HOME",
  ];
  const original = Object.fromEntries(keys.map((key) => [key, Bun.env[key]]));
  let child: ChildProc | undefined;
  try {
    const sdk = join(dir, "sdk");
    for (const folder of ["cmdline-tools/latest/bin", "emulator", "platform-tools"])
      await mkdir(join(sdk, folder), { recursive: true });
    const tools: Record<string, string> = {
      "cmdline-tools/latest/bin/sdkmanager": "process.exit(0);",
      "cmdline-tools/latest/bin/avdmanager": `
        const fs = require('node:fs'); const args = process.argv.slice(2);
        const path = args[args.indexOf('--path') + 1];
        if (!process.env.ANDROID_AVD_HOME || !path.endsWith('simbox.avd')) process.exit(1);
        fs.mkdirSync(path, { recursive: true }); fs.writeFileSync(path + '/config.ini', 'AvdId=simbox\\n');
      `,
      "emulator/emulator": `
        if (process.argv.includes('-accel-check')) process.exit(0);
        const fs = require('node:fs'); const path = process.env.ANDROID_AVD_HOME + '/simbox.ini';
        if (!fs.readFileSync(path, 'utf8').includes('simbox.avd')) process.exit(1);
        setInterval(() => {}, 1000);
      `,
      "platform-tools/adb": "console.log('1');",
    };
    for (const [path, source] of Object.entries(tools)) {
      await Bun.write(join(sdk, path), `#!/usr/bin/env node\n${source}\n`);
      await chmod(join(sdk, path), 0o755);
    }
    Bun.env.ANDROID_HOME = sdk;
    Bun.env.ANDROID_USER_HOME = join(dir, "android-user");
    Bun.env.ANDROID_AVD_HOME = join(dir, "avds");
    await configureAndroidEnvironment();
    let ready = false;
    await prepareAndroid(
      () => {
        ready = true;
      },
      (proc) => {
        child = proc;
      },
    );
    expect(ready).toBe(true);
    expect(child?.exitCode).toBeNull();
    expect(await Bun.file(join(dir, "avds/simbox.ini")).text()).toContain(
      `path=${dir}/avds/simbox.avd`,
    );
  } finally {
    if (child) {
      child.kill();
      await child.exited;
    }
    for (const key of keys) {
      if (original[key] === undefined) delete Bun.env[key];
      else Bun.env[key] = original[key];
    }
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);
