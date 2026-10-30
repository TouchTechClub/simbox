import {
  mergeDeviceProfiles,
  validateDeviceProfile,
  type DeviceProfile,
  type DevicePreferences,
} from "./device-profile.js";
import { MAX_DEVICES_PER_RUN } from "./constants.js";

export type DevicePlatform = "ios" | "android";
export const PLATFORMS: readonly DevicePlatform[] = ["ios", "android"];
export type RunnerTarget = {
  labels: string[];
  /** Devices this runner runs at once; omitted: sized from its vCPUs. */
  maxDevices?: number;
};
export type RunnerPreferences = Record<DevicePlatform, RunnerTarget | null>;
export type RunnerSource = "override" | "repository" | "account" | "default";
export type ResolvedRunner = { runner: RunnerTarget; source: RunnerSource };
export interface LayeredDevice {
  device: DeviceProfile | null;
  /** Which layer supplied each field that is set. */
  sources: Partial<Record<"model" | "os" | "foldable" | "xcode", RunnerSource>>;
}
export interface RunnerSettings {
  account: RunnerPreferences;
  repository: RunnerPreferences | null;
  repoFullName: string | null;
  effective: Record<DevicePlatform, ResolvedRunner>;
  /** Device defaults, layered like runners but field by field. */
  devices: {
    account: DevicePreferences;
    repository: DevicePreferences | null;
    effective: Record<DevicePlatform, LayeredDevice>;
  };
}

export interface RunnerDiagnostics {
  settings: RunnerSettings;
  checks: Array<{ name: string; ok: boolean; message: string }>;
}

/**
 * iOS defaults to GitHub's Xcode 27 image (a public preview): `macos-latest`
 * only offers Xcode 26.
 */
export const DEFAULT_RUNNERS: Record<DevicePlatform, RunnerTarget> = {
  ios: { labels: ["xcode-27"] },
  android: { labels: ["ubuntu-latest"] },
};

export const RUNNER_PRESETS: Array<{
  name: string;
  platform: DevicePlatform;
  provider: "github" | "blacksmith";
  runner: RunnerTarget;
}> = [
  {
    name: "GitHub Xcode 27 (ARM64, preview)",
    platform: "ios",
    provider: "github",
    runner: DEFAULT_RUNNERS.ios,
  },
  {
    name: "GitHub macOS (ARM64, Xcode 26)",
    platform: "ios",
    provider: "github",
    runner: { labels: ["macos-latest"] },
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
    Object.keys(value).some((key) => key !== "labels" && key !== "maxDevices")
  ) {
    throw new Error('Runner must be {labels: ["runner-label"], maxDevices?: 1-3}.');
  }
  const maxDevices = (value as { maxDevices?: unknown }).maxDevices;
  if (
    maxDevices !== undefined &&
    (!Number.isInteger(maxDevices) ||
      (maxDevices as number) < 1 ||
      (maxDevices as number) > MAX_DEVICES_PER_RUN)
  )
    throw new Error(`maxDevices must be a whole number from 1 to ${MAX_DEVICES_PER_RUN}.`);
  if (platform === "android" && maxDevices !== undefined && maxDevices !== 1)
    throw new Error("Android runners run one emulator; maxDevices must be 1.");
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
  return {
    labels: [...labels],
    ...(maxDevices === undefined ? {} : { maxDevices: maxDevices as number }),
  };
}

/**
 * CLI/custom form accepts a single label, a JSON label array, or a JSON runner
 * object (`{"labels": [...], "maxDevices": 2}`).
 */
export function parseRunnerInput(input: string, platform: DevicePlatform): RunnerTarget {
  const text = input.trim();
  if (text.startsWith("{")) {
    let runner: unknown;
    try {
      runner = JSON.parse(text);
    } catch {
      throw new Error("Custom runner must be valid JSON.");
    }
    return validateRunner(runner, platform);
  }
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

/**
 * Devices a runner with this many vCPUs runs at once. Small runners, such as
 * GitHub's standard 3-vCPU Macs and 4-vCPU Linux runners, get one: a second
 * simulator saturates them.
 */
export function deviceCapForCpus(vcpus: number): number {
  return vcpus <= 4 ? 1 : vcpus <= 8 ? 2 : MAX_DEVICES_PER_RUN;
}

/**
 * The device cap before the runner reports its own: the configured one, else
 * sized from the vCPUs its labels name. Android runs one emulator; unknown
 * labels are treated as small.
 */
export function estimateDeviceCap(platform: DevicePlatform, runner: RunnerTarget | null): number {
  if (platform === "android") return 1;
  if (runner?.maxDevices) return runner.maxDevices;
  for (const label of runner?.labels ?? []) {
    const vcpus = /(?:^|-)(\d+)vcpu(?:-|$)/i.exec(label)?.[1];
    if (vcpus) return deviceCapForCpus(Number(vcpus));
    // GitHub's M2 Pro "xlarge" Macs have 5 vCPUs.
    if (/-xlarge$/i.test(label)) return deviceCapForCpus(5);
  }
  return 1;
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

/** Field-wise device layering: override → repository → account → runner default. */
export function resolveDevice(
  platform: DevicePlatform,
  account: DevicePreferences,
  repository: DevicePreferences | null,
  override?: DeviceProfile | null,
): LayeredDevice {
  const layers: Array<[RunnerSource, DeviceProfile | null]> = [
    ["account", account[platform] ? validateDeviceProfile(account[platform], platform) : null],
    [
      "repository",
      repository?.[platform] ? validateDeviceProfile(repository[platform], platform) : null,
    ],
    ["override", override ? validateDeviceProfile(override, platform) : null],
  ];
  let device: DeviceProfile | null = null;
  const sources: LayeredDevice["sources"] = {};
  for (const [source, layer] of layers) {
    if (!layer) continue;
    device = mergeDeviceProfiles(device, layer);
    if (layer.model !== undefined || layer.foldable) {
      delete sources.model;
      delete sources.foldable;
    }
    for (const key of ["model", "os", "foldable", "xcode"] as const)
      if (layer[key] !== undefined) sources[key] = source;
  }
  return { device, sources };
}

/** Same labels; a cap on `b` must match too. */
export function sameRunner(a: RunnerTarget | null, b: RunnerTarget): boolean {
  if (!a || a.labels.length !== b.labels.length) return false;
  if (b.maxDevices !== undefined && a.maxDevices !== b.maxDevices) return false;
  const left = a.labels.map((label) => label.toLowerCase()).sort();
  const right = b.labels.map((label) => label.toLowerCase()).sort();
  return left.every((label, i) => label === right[i]);
}

export function formatRunner(runner: RunnerTarget | null): string {
  if (!runner) return "unknown (legacy workflow)";
  const labels = runner.labels.join(" + ");
  return runner.maxDevices
    ? `${labels} (${runner.maxDevices} device${runner.maxDevices === 1 ? "" : "s"})`
    : labels;
}
