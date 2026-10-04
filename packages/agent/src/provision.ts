/**
 * Provisioning: install agent-device via npm, download pinned cloudflared,
 * and kick off Android SDK/AVD prep in the background (never blocks iOS).
 */
import { chmod, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PINS } from "./pins.js";
import { endGroup, info, relay, startGroup, warn } from "./log.js";
import { run, which, pumpLines } from "./proc.js";
import type { ChildProc } from "./proc.js";

/** Directory the agent uses for downloaded binaries. */
export function binDir(): string {
  const base = Bun.env.RUNNER_TEMP ?? join(tmpdir(), "simbox");
  return join(base, "simbox-bin");
}

/**
 * `npm i -g agent-device@<pin>` — Node/npm exist in the macOS runner toolcache.
 * Returns the resolved path to the agent-device binary.
 */
export async function installAgentDevice(): Promise<string> {
  startGroup("Install agent-device");
  try {
    const spec = `agent-device@${PINS.agentDevice}`;
    info(`npm i -g ${spec}`);
    const res = await run(["npm", "i", "-g", spec], { timeoutMs: 240_000 });
    for (const l of res.stdout.split("\n")) {
      if (l.trim()) relay("npm", l);
    }
    for (const l of res.stderr.split("\n")) {
      if (l.trim()) relay("npm", l);
    }
    if (res.code !== 0) throw new Error(`npm i -g ${spec} exited ${res.code}`);

    // Resolve the binary: PATH first, then the global npm prefix (global
    // installs can land outside PATH on some runner images).
    const onPath = await which("agent-device");
    if (onPath) {
      info(`agent-device at ${onPath}`);
      return onPath;
    }
    const prefix = await run(["npm", "prefix", "-g"]);
    const guess = join(prefix.stdout.trim(), "bin", "agent-device");
    if (existsSync(guess)) {
      info(`agent-device at ${guess}`);
      return guess;
    }
    throw new Error("agent-device installed but binary not found on PATH or npm prefix");
  } finally {
    endGroup();
  }
}

interface CloudflaredAsset {
  url: string;
  /** "tgz" assets need extraction; "bin" assets are written directly. */
  kind: "tgz" | "bin";
}

function cloudflaredAssets(tag: string): CloudflaredAsset[] {
  const base = `https://github.com/cloudflare/cloudflared/releases/download/${tag}`;
  // macos-latest is arm64. Older tags only shipped darwin-amd64.tgz — try
  // arm64 first, amd64 (Rosetta) as fallback; .tgz before raw binaries.
  return [
    { url: `${base}/cloudflared-darwin-arm64.tgz`, kind: "tgz" },
    { url: `${base}/cloudflared-darwin-amd64.tgz`, kind: "tgz" },
    { url: `${base}/cloudflared-darwin-arm64`, kind: "bin" },
    { url: `${base}/cloudflared-darwin-amd64`, kind: "bin" },
  ];
}

/** Download pinned cloudflared → executable path in binDir(). */
export async function installCloudflared(): Promise<string> {
  startGroup("Install cloudflared");
  const dir = binDir();
  const dest = join(dir, "cloudflared");
  try {
    await mkdir(dir, { recursive: true });
    const tag = PINS.cloudflared;
    let lastErr: unknown = null;
    for (const asset of cloudflaredAssets(tag)) {
      info(`downloading ${asset.url}`);
      try {
        const res = await fetch(asset.url, {
          redirect: "follow",
          signal: AbortSignal.timeout(120_000),
        });
        if (!res.ok) {
          info(`  → HTTP ${res.status}, trying next asset`);
          continue;
        }
        if (asset.kind === "tgz") {
          const file = join(dir, "cloudflared.tgz");
          await Bun.write(file, res);
          const untar = await run(["tar", "xzf", file, "-C", dir], { timeoutMs: 60_000 });
          if (untar.code !== 0 || !existsSync(dest)) {
            info(`  → untar failed (${untar.stderr.trim().slice(0, 200)}), trying next asset`);
            continue;
          }
        } else {
          await Bun.write(dest, res);
        }
        await chmod(dest, 0o755);
        info(`cloudflared ${tag} ready at ${dest}`);
        return dest;
      } catch (err) {
        lastErr = err;
        info(`  → ${String(err).slice(0, 200)}, trying next asset`);
      }
    }
    throw new Error(`all cloudflared assets failed (last: ${String(lastErr)})`);
  } finally {
    endGroup();
  }
}

function firstExisting(candidates: Array<string | null>): string | null {
  for (const c of candidates) if (c && existsSync(c)) return c;
  return null;
}

/**
 * Android emulator prep — runs fully in the background. Every failure is
 * non-fatal: it only leaves `androidReady` false in heartbeats.
 */
export async function prepareAndroid(
  setReady: () => void,
  onEmulator: (proc: ChildProc) => void,
): Promise<void> {
  startGroup("Android emulator prep");
  try {
    const sdkRoot = firstExisting([Bun.env.ANDROID_HOME ?? null, Bun.env.ANDROID_SDK_ROOT ?? null]);
    if (!sdkRoot) {
      warn("no ANDROID_HOME/ANDROID_SDK_ROOT — Android emulator unavailable this run");
      return;
    }
    const sdkmanager = firstExisting([
      join(sdkRoot, "cmdline-tools", "latest", "bin", "sdkmanager"),
      join(sdkRoot, "tools", "bin", "sdkmanager"),
      await which("sdkmanager"),
    ]);
    const avdmanager = firstExisting([
      join(sdkRoot, "cmdline-tools", "latest", "bin", "avdmanager"),
      join(sdkRoot, "tools", "bin", "avdmanager"),
      await which("avdmanager"),
    ]);
    if (!sdkmanager || !avdmanager) {
      warn(`sdkmanager/avdmanager not found under ${sdkRoot} — Android unavailable`);
      return;
    }
    info(`Android SDK at ${sdkRoot}`);

    // Accept licenses — pipe plenty of "y"s so every prompt is answered.
    const lic = await run([sdkmanager, "--licenses"], {
      input: "y\n".repeat(64),
      timeoutMs: 120_000,
    });
    if (lic.code !== 0) warn(`sdkmanager --licenses exited ${lic.code} (continuing)`);

    // An AVD/system image alone is not runnable: install the emulator executable
    // too instead of relying on whatever happens to be in the hosted image.
    const pkgs = ["platform-tools", "emulator", PINS.androidPlatform, PINS.androidSystemImage];
    info(`sdkmanager ${pkgs.join(" ")}`);
    const inst = await run([sdkmanager, ...pkgs], {
      input: "y\n".repeat(16),
      timeoutMs: 600_000,
    });
    for (const l of inst.stdout.split("\n")) {
      if (l.trim()) relay("sdkmanager", l);
    }
    if (inst.code !== 0) {
      warn(`sdkmanager install exited ${inst.code}: ${inst.stderr.trim().slice(0, 300)}`);
      return;
    }

    // "no" answers the "custom hardware profile?" prompt.
    const avd = await run(
      [
        avdmanager,
        "create",
        "avd",
        "-n",
        "simbox",
        "-k",
        PINS.androidSystemImage,
        "-d",
        "pixel_6",
        "--force",
      ],
      { input: "no\n", timeoutMs: 60_000 },
    );
    if (avd.code !== 0) {
      warn(`avdmanager create avd exited ${avd.code}: ${avd.stderr.trim().slice(0, 300)}`);
      return;
    }
    const acceleration = await run([join(sdkRoot, "emulator", "emulator"), "-accel-check"], {
      timeoutMs: 15_000,
    });
    info(
      `Android acceleration check (exit ${acceleration.code}): ${acceleration.stdout.trim().slice(0, 500)} ${acceleration.stderr.trim().slice(0, 500)}`,
    );
    info("booting AVD 'simbox' headlessly with software graphics");
    const emulator = Bun.spawn(
      [
        join(sdkRoot, "emulator", "emulator"),
        "-avd",
        "simbox",
        "-port",
        "5554",
        "-no-window",
        "-no-audio",
        "-no-boot-anim",
        "-no-snapshot",
        "-gpu",
        "swiftshader_indirect",
        "-feature",
        "-Vulkan",
        "-memory",
        "2048",
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    onEmulator(emulator);
    pumpLines(emulator.stdout, "android-emulator");
    pumpLines(emulator.stderr, "android-emulator");
    const deadline = Date.now() + 6 * 60_000;
    const adb = join(sdkRoot, "platform-tools", "adb");
    let booted = false;
    while (Date.now() < deadline && emulator.exitCode === null) {
      const result = await run(
        [adb, "-s", "emulator-5554", "shell", "getprop", "sys.boot_completed"],
        { timeoutMs: 10_000 },
      );
      if (result.code === 0 && result.stdout.trim() === "1") {
        booted = true;
        break;
      }
      await Bun.sleep(2000);
    }
    if (!booted) {
      emulator.kill();
      throw new Error(
        `Android emulator failed to boot (exit ${emulator.exitCode ?? "boot deadline exceeded"}); see android-emulator logs`,
      );
    }
    // Dismiss first-boot keyguard so remotely launched apps are interactive.
    await run([adb, "-s", "emulator-5554", "shell", "input", "keyevent", "82"], {
      timeoutMs: 10_000,
    });
    info("AVD 'simbox' boot completed — Android ready (emulator-5554)");
    setReady();
  } catch (err) {
    warn(`Android prep failed (non-fatal): ${String(err).slice(0, 300)}`);
  } finally {
    endGroup();
  }
}
