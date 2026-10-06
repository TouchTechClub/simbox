export type DevicePlatform = "ios" | "android";
export type RunnerTarget = { labels: string[] };
export type RunnerPreferences = Record<DevicePlatform, RunnerTarget | null>;
export type RunnerSource = "override" | "repository" | "account" | "default";
export type ResolvedRunner = { runner: RunnerTarget; source: RunnerSource };
export interface RunnerSettings {
  account: RunnerPreferences;
  repository: RunnerPreferences | null;
  repoFullName: string | null;
  effective: Record<DevicePlatform, ResolvedRunner>;
}

export interface RunnerDiagnostics {
  settings: RunnerSettings;
  checks: Array<{ name: string; ok: boolean; message: string }>;
}

export const DEFAULT_RUNNERS: Record<DevicePlatform, RunnerTarget> = {
  ios: { labels: ["macos-latest"] },
  android: { labels: ["ubuntu-latest"] },
};

export const RUNNER_PRESETS: Array<{
  name: string;
  platform: DevicePlatform;
  provider: "github" | "blacksmith";
  runner: RunnerTarget;
}> = [
  {
    name: "GitHub macOS (ARM64)",
    platform: "ios",
    provider: "github",
    runner: DEFAULT_RUNNERS.ios,
  },
  {
    name: "GitHub Ubuntu (x64/KVM)",
    platform: "android",
    provider: "github",
    runner: DEFAULT_RUNNERS.android,
  },
  ...[2, 4, 8].map((cpu) => ({
    name: `Blacksmith Ubuntu · ${cpu} vCPU`,
    platform: "android" as const,
    provider: "blacksmith" as const,
    runner: { labels: [`blacksmith-${cpu}vcpu-ubuntu-2404`] },
  })),
  ...[6, 12].map((cpu) => ({
    name: `Blacksmith macOS · ${cpu} vCPU`,
    platform: "ios" as const,
    provider: "blacksmith" as const,
    runner: { labels: [`blacksmith-${cpu}vcpu-macos-latest`] },
  })),
];

export function emptyRunnerPreferences(): RunnerPreferences {
  return { ios: null, android: null };
}

/** Labels only: no YAML, expressions, group objects or executable input. */
export function validateRunner(value: unknown, platform: DevicePlatform): RunnerTarget {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => key !== "labels")
  ) {
    throw new Error('Runner must be {labels: ["runner-label"]}.');
  }
  const labels = (value as { labels?: unknown }).labels;
  if (
    !Array.isArray(labels) ||
    labels.length < 1 ||
    labels.length > 8 ||
    labels.some(
      (label) =>
        typeof label !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9_. -]{0,99}$/.test(label) ||
        label !== label.trim(),
    )
  ) {
    throw new Error(
      "Use 1–8 runner labels (1–100 letters, numbers, spaces, dots, underscores or hyphens each).",
    );
  }
  if (new Set(labels.map((label: string) => label.toLowerCase())).size !== labels.length)
    throw new Error("Runner labels must be unique (case-insensitive).");
  for (const label of labels as string[]) {
    const lower = label.toLowerCase();
    if (lower.includes("windows") || lower === "ubuntu-slim")
      throw new Error("Windows and container-only ubuntu-slim runners are unsupported.");
    if (
      platform === "android" &&
      (/macos|darwin/.test(lower) || /(?:^|[-_ ])(?:arm|arm64|aarch64)(?:$|[-_ ])/.test(lower))
    ) {
      throw new Error("Android requires a Linux x64 runner with KVM, not macOS or ARM.");
    }
    if (platform === "ios" && (/ubuntu|linux/.test(lower) || /intel|x64|x86_64/.test(lower))) {
      throw new Error("iOS requires a macOS ARM64 runner with Xcode.");
    }
  }
  return { labels: [...labels] };
}

/** CLI/custom form accepts a single label or an explicit JSON label array. */
export function parseRunnerInput(input: string, platform: DevicePlatform): RunnerTarget {
  const text = input.trim();
  let labels: unknown = [text];
  if (text.startsWith("[")) {
    try {
      labels = JSON.parse(text);
    } catch {
      throw new Error("Custom runner label list must be valid JSON.");
    }
  }
  return validateRunner({ labels }, platform);
}

export function parseRunnerPatch(value: unknown): Partial<RunnerPreferences> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length === 0 ||
    Object.keys(value).some((key) => key !== "ios" && key !== "android")
  ) {
    throw new Error("Expected ios and/or android runner settings; use null to inherit.");
  }
  const patch: Partial<RunnerPreferences> = {};
  for (const platform of ["ios", "android"] as const) {
    if (Object.hasOwn(value, platform)) {
      const runner = (value as Record<string, unknown>)[platform];
      patch[platform] = runner === null ? null : validateRunner(runner, platform);
    }
  }
  return patch;
}

export function resolveRunner(
  platform: DevicePlatform,
  account: RunnerPreferences,
  repository: RunnerPreferences | null,
  override?: RunnerTarget,
): ResolvedRunner {
  if (override) return { runner: validateRunner(override, platform), source: "override" };
  if (repository?.[platform])
    return { runner: validateRunner(repository[platform], platform), source: "repository" };
  if (account[platform])
    return { runner: validateRunner(account[platform], platform), source: "account" };
  return { runner: DEFAULT_RUNNERS[platform], source: "default" };
}

export function sameRunner(a: RunnerTarget | null, b: RunnerTarget): boolean {
  if (!a || a.labels.length !== b.labels.length) return false;
  const left = a.labels.map((label) => label.toLowerCase()).sort();
  const right = b.labels.map((label) => label.toLowerCase()).sort();
  return left.every((label, i) => label === right[i]);
}

export function formatRunner(runner: RunnerTarget | null): string {
  return runner ? runner.labels.join(" + ") : "unknown (legacy workflow)";
}
