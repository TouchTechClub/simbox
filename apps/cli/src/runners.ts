import {
  RUNNER_PRESETS,
  formatRunner,
  parseRunnerInput,
  type DevicePlatform,
  type RunnerSettings,
} from "@simbox/shared";
import { runnerSettings, updateRunners, runnerDiagnostics } from "./client.js";
import { spawnSync } from "node:child_process";

export function printRunnerSettings(settings: RunnerSettings, json = false): void {
  if (json) {
    console.log(JSON.stringify(settings));
    return;
  }
  console.log(`Repository: ${settings.repoFullName ?? "not connected"}`);
  for (const platform of ["ios", "android"] as const) {
    console.log(
      `${platform}: ${formatRunner(settings.effective[platform].runner)} (${settings.effective[platform].source})`,
    );
    console.log(
      `  account: ${settings.account[platform] ? formatRunner(settings.account[platform]) : "GitHub default"}`,
    );
    console.log(
      `  repository: ${settings.repository?.[platform] ? formatRunner(settings.repository[platform]) : "inherit account"}`,
    );
  }
  console.log(
    "Settings apply to future runs only. Run `simbox repair` once to upgrade older workflows.",
  );
  console.log(
    "Blacksmith requires its GitHub App on the repository and bills separately. Custom runners need Linux x64/KVM or macOS ARM64/Xcode.",
  );
}

export async function cmdRunnersShow(json = false): Promise<void> {
  printRunnerSettings(await runnerSettings(), json);
}

export function cmdRunnerPresets(): void {
  for (const preset of RUNNER_PRESETS)
    console.log(`${preset.platform.padEnd(7)} ${preset.runner.labels[0]} — ${preset.name}`);
}

export async function cmdRunnersSet(
  platform: DevicePlatform,
  input: string | null,
  scope: "account" | "repo",
  json = false,
): Promise<void> {
  const runner = input === null ? null : parseRunnerInput(input, platform);
  printRunnerSettings(await updateRunners(scope, { [platform]: runner }), json);
}

export async function cmdDoctor(json = false): Promise<void> {
  const diagnostics = await runnerDiagnostics();
  const tool = (name: string, required: boolean) => {
    const result = spawnSync(name, ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
      shell: false,
    });
    return {
      name,
      required,
      ok: !result.error && result.status === 0,
      message: result.error
        ? `Missing or failed ${name}; install it locally.`
        : (result.stdout || result.stderr).trim().slice(0, 200),
    };
  };
  const local = [tool("agent-device", true), tool("bunx", false)];
  if (json) console.log(JSON.stringify({ ...diagnostics, local }));
  else {
    for (const check of [...local, ...diagnostics.checks])
      console.log(
        `${check.ok ? "PASS" : "required" in check && !check.required ? "WARN" : "FAIL"} ${check.name}: ${check.message}`,
      );
    printRunnerSettings(diagnostics.settings);
    console.log(
      "No job was started. Actual KVM/Xcode capability is checked on the runner, not this machine.",
    );
  }
  if (
    diagnostics.checks.some((check) => !check.ok) ||
    local.some((check) => check.required && !check.ok)
  )
    process.exitCode = 1;
}
