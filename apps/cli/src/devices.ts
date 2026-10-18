import pc from "picocolors";
import {
  PLATFORMS,
  compareVersions,
  formatRunner,
  parseDevicePatch,
  parseRunnerInput,
  type DevicePlatform,
  type InventoryResponse,
  type RunnerTarget,
} from "@simbox/shared";
import { CliError, inventory, updateDevices } from "./client.js";
import { printRunnerSettings } from "./runners.js";
import { PLATFORM_NAMES } from "./runs.js";
import { fmtAgo } from "./util.js";

/** How to type a runner back on the command line: a label, or a quoted JSON array. */
export function runnerArg(runner: RunnerTarget): string {
  return runner.labels.length === 1 && /^[\w.-]+$/.test(runner.labels[0]!)
    ? runner.labels[0]!
    : `'${JSON.stringify(runner.labels)}'`;
}

const MAX_LISTED_MODELS = 6;

/** Human-readable catalog for one platform/runner. */
export function formatInventory(res: InventoryResponse): string[] {
  const { platform, runner } = res;
  const lines = [`${pc.bold(PLATFORM_NAMES[platform])} on ${formatRunner(runner)}`];
  const inv = res.inventory;
  if (!inv) {
    lines.push(
      "  No device catalog yet. A runner reports what it offers on its first run; start one with:",
      `  ${pc.cyan(`simbox sim --platform ${platform} --runner ${runnerArg(runner)}`)}`,
    );
    return lines;
  }
  lines.push(pc.dim(`  reported by ${formatRunner(inv.runner)} ${fmtAgo(inv.reportedAt)}`));
  const names = new Map(inv.models.map((model) => [model.id, model.name]));
  lines.push(`  ${platform === "ios" ? "iOS versions" : "Android API levels"} (newest first):`);
  for (const os of [...inv.os].sort((a, b) => compareVersions(b.version, a.version))) {
    const marks = os.version === inv.defaults.os ? pc.green(" (default)") : "";
    // Only list models when this OS runs a subset of them.
    let runs = "";
    if (os.models && os.models.length < inv.models.length) {
      const listed = os.models.map((id) => names.get(id) ?? id);
      runs = pc.dim(
        ` — ${listed.slice(0, MAX_LISTED_MODELS).join(", ")}${listed.length > MAX_LISTED_MODELS ? `, +${listed.length - MAX_LISTED_MODELS} more` : ""}`,
      );
    }
    lines.push(`    ${os.version.padEnd(8)} ${os.name}${marks}${runs}`);
  }
  lines.push("  Models:");
  for (const model of inv.models) {
    const isDefault = model.id === inv.defaults.model || model.name === inv.defaults.model;
    lines.push(
      // Android profile ids (pixel_8) are what people type; iOS type ids are noise.
      `    ${model.name}${platform === "android" && model.id !== model.name ? pc.dim(` (${model.id})`) : ""}${model.foldable ? " [foldable]" : ""}${isDefault ? pc.green(" (default)") : ""}`,
    );
  }
  if (inv.xcode?.length) lines.push(`  Xcode: ${inv.xcode.join(", ")}`);
  lines.push(
    pc.dim(
      `  e.g. simbox sim --platform ${platform} --device ${JSON.stringify(inv.models.find((m) => !m.foldable)?.name ?? inv.defaults.model)} --os ${inv.defaults.os}`,
    ),
  );
  return lines;
}

export async function cmdDevicesList(
  opts: { platform?: DevicePlatform; runner?: string; json?: boolean },
  read: typeof inventory = inventory,
): Promise<void> {
  if (opts.runner !== undefined && !opts.platform)
    throw new CliError("Use --platform ios or android with --runner.");
  const runner =
    opts.runner === undefined ? undefined : parseRunnerInput(opts.runner, opts.platform!);
  const platforms = opts.platform ? [opts.platform] : PLATFORMS;
  const results = await Promise.all(platforms.map((platform) => read(platform, runner)));
  if (opts.json) {
    console.log(JSON.stringify(Object.fromEntries(results.map((res) => [res.platform, res]))));
    return;
  }
  console.log(results.map((res) => formatInventory(res).join("\n")).join("\n\n"));
}

export async function cmdDevicesSet(
  platform: DevicePlatform,
  /** null resets the scope to inherit. */
  opts: { device?: string; os?: string; foldable?: boolean } | null,
  scope: "account" | "repo",
  json = false,
): Promise<void> {
  let profile = null;
  if (opts) {
    profile = parseDevicePatch({
      [platform]: {
        ...(opts.device !== undefined ? { model: opts.device } : {}),
        ...(opts.os !== undefined ? { os: opts.os } : {}),
        ...(opts.foldable ? { foldable: true } : {}),
      },
    })[platform];
    if (!profile)
      throw new CliError(
        `Pass --device, --os or --foldable. To inherit instead, run \`simbox devices reset ${platform} --scope ${scope}\`.`,
      );
  }
  printRunnerSettings(await updateDevices(scope, { [platform]: profile }), json);
}
