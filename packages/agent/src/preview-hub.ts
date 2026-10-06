import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { binDir } from "./provision.js";
import { PINS } from "./pins.js";
import { run, pumpLines } from "./proc.js";
import { info, warn } from "./log.js";

/** Capture subprocesses invoke adb/emulator by name, unlike SDK inventory. */
export function previewHubEnv(env: Record<string, string | undefined>) {
  const sdk = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT].find(
    (root) => root && existsSync(join(root, "platform-tools", "adb")),
  );
  return {
    ...env,
    ...(sdk
      ? {
          PATH: [join(sdk, "platform-tools"), join(sdk, "emulator"), env.PATH ?? ""].join(
            delimiter,
          ),
        }
      : {}),
  };
}

export function previewHubArgs(platform: string) {
  return [
    "--platform",
    platform === "darwin" ? "ios" : "android",
    "--transport",
    "h264",
    ...(platform === "darwin" ? [] : ["--stream-source", "scrcpy"]),
    "--video-fps",
    "30",
    "--video-bitrate",
    "2000000",
    "--max-dimension",
    "1280",
    "--hide-boot-device",
  ];
}

/** Lazy and independently supervised: a preview failure never kills CLI work. */
export function createPreviewHub(port = 4725) {
  let pending: Promise<number> | null = null;
  let child: ReturnType<typeof Bun.spawn> | null = null;
  let stopped = false;
  let retryAfter = 0;
  const lifecycle = new AbortController();
  const directory = join(binDir(), `device-hub-${PINS.deviceHub}`);
  const entry = join(directory, "node_modules/expo-device-hub/dist/server/cli.mjs");
  async function start(): Promise<number> {
    if (Date.now() < retryAfter)
      throw new Error("Device preview is cooling down after startup failure");
    if (!existsSync(join(directory, ".installed"))) {
      await mkdir(directory, { recursive: true });
      info(`installing preview hub ${PINS.deviceHub}`);
      const install = await run(
        [
          "npm",
          "install",
          "--prefix",
          directory,
          "--no-audit",
          "--no-fund",
          `expo-device-hub@${PINS.deviceHub}`,
        ],
        { timeoutMs: 240_000, signal: lifecycle.signal },
      );
      if (install.code !== 0 || !existsSync(entry))
        throw new Error("Device hub installation failed; inspect runner logs");
      await Bun.write(join(directory, ".installed"), PINS.deviceHub);
    }
    if (stopped) throw new Error("Runner shutting down");
    const current = Bun.spawn(
      [
        "node",
        entry,
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        ...previewHubArgs(process.platform),
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: previewHubEnv(Bun.env) },
    );
    child = current;
    pumpLines(current.stdout, "device-hub");
    pumpLines(current.stderr, "device-hub");
    void current.exited.then(() => {
      if (child === current) {
        child = null;
        pending = null;
        retryAfter = Date.now() + 10_000;
      }
    });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && current.exitCode === null && !stopped) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/devices?booted=1`, {
          signal: AbortSignal.timeout(1500),
        });
        if (response.ok) {
          await response.body?.cancel();
          return port;
        }
        await response.body?.cancel();
      } catch {
        /* starting */
      }
      await Bun.sleep(250);
    }
    current.kill("SIGTERM");
    throw new Error("Device hub did not become ready");
  }
  return {
    port: async () => {
      if (stopped) throw new Error("Runner shutting down");
      pending ??= start().catch((error) => {
        pending = null;
        retryAfter = Date.now() + 10_000;
        warn("device preview unavailable; CLI remains available");
        throw error;
      });
      // Do not hold a Cloudflare request open during npm installation. The UI
      // retries inventory while the single shared installation continues.
      return Promise.race([
        pending,
        Bun.sleep(750).then(() => {
          throw new Error("Preview hub starting");
        }),
      ]);
    },
    /**
     * serve-sim's native capture can wedge after aborted WebSocket/AVCC
     * attachments, leaving every subsequent input socket unanswered. Nothing
     * else can recover it, so an upstream admission failure restarts the hub.
     * Existing CLI work is unaffected; only viewers briefly see a reconnect.
     */
    restart: async () => {
      if (stopped) return;
      const current = child;
      pending = null;
      if (!current) return;
      child = null;
      current.kill("SIGTERM");
      await Promise.race([current.exited, Bun.sleep(3000)]);
      if (current.exitCode === null) current.kill("SIGKILL");
    },
    stop: async () => {
      stopped = true;
      lifecycle.abort();
      const current = child;
      if (!current) return;
      current.kill("SIGTERM");
      await Promise.race([current.exited, Bun.sleep(3000)]);
      if (current.exitCode === null) current.kill("SIGKILL");
    },
  };
}
