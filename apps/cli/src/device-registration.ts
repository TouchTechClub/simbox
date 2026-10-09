import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { apiBaseUrl, configDir, loadToken } from "./config.js";
import type { ConnectInfo } from "./connect.js";

const MAX_AGE_MS = 5 * 60_000;

/** Private handoff; S5 associates the opaque receipt with the originating tool's thread. */
export function registerDevice(
  info: ConnectInfo,
  options: { platform?: "ios" | "android"; args?: string[]; stop?: boolean } = {},
): void {
  if (
    !process.env.T3CODE_HOME &&
    !process.env.SIMBOX_DEVICE_REGISTRATION_DIR &&
    ![".s5code", ".t3"].some((home) =>
      existsSync(join(homedir(), home, "userdata", "server-runtime.json")),
    )
  )
    return;
  try {
    const directory =
      process.env.SIMBOX_DEVICE_REGISTRATION_DIR ?? join(configDir(), "device-registrations");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // Bound abandoned receipts, including commands run outside an agent session.
    for (const file of readdirSync(directory)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
      const path = join(directory, file);
      if (Date.now() - statSync(path).mtimeMs > MAX_AGE_MS) unlinkSync(path);
    }
    const args = options.args ?? [];
    const flag = (name: string) => {
      const end = args.indexOf("--");
      const flags = end < 0 ? args : args.slice(0, end);
      const index = flags.indexOf(name);
      return index >= 0
        ? flags[index + 1]
        : flags.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
    };
    const id = randomUUID();
    writeFileSync(
      join(directory, `${id}.json`),
      JSON.stringify({
        version: 1,
        createdAt: Date.now(),
        ...info,
        platform: flag("--platform") ?? options.platform,
        deviceId: flag("--udid") ?? flag("--serial"),
        deviceName: flag("--device"),
        agentSession: flag("--session"),
        stop: options.stop === true,
        autoBoot: !options.args,
        apiUrl: apiBaseUrl(),
        userToken: loadToken(),
      }),
      { mode: 0o600, flag: "wx" },
    );
    // Only the receipt is logged. URLs and credentials remain in the private file.
    process.stderr.write(`[simbox-device:${id}]\n`);
  } catch {
    process.stderr.write("Could not notify S5 Code about this device; Simbox remains connected.\n");
  }
}
