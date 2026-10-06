import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { CliError } from "./client.js";

export interface SkillInstallOptions {
  project?: boolean;
  global?: boolean;
  agent?: string[];
  yes?: boolean;
  dryRun?: boolean;
}

export function skillInstallArgs(opts: SkillInstallOptions): string[] {
  if (opts.project && opts.global)
    throw new CliError("Choose either --project or --global, not both.");
  if (!opts.project && !opts.global)
    throw new CliError("Choose --project or --global (scope is never inferred).");
  if (opts.agent?.some((agent) => !/^[a-z][a-z0-9-]*$/.test(agent) && agent !== "*"))
    throw new CliError("Invalid agent ID. Use skills CLI agent names, e.g. claude-code or codex.");
  if (opts.yes && !opts.agent?.length)
    throw new CliError(
      "Non-interactive installs require --agent; Simbox will not choose agents for you.",
    );
  return [
    "skills",
    "add",
    "TouchTechClub/simbox",
    "--skill",
    "simbox",
    ...(opts.global ? ["--global"] : []),
    ...(opts.agent?.length ? ["--agent", ...opts.agent] : []),
    ...(opts.yes ? ["--yes"] : []),
  ];
}

export async function selectSkillScope(
  opts: SkillInstallOptions,
  interactive: boolean,
  ask: (question: string) => Promise<string>,
): Promise<SkillInstallOptions> {
  if (opts.project && opts.global)
    throw new CliError("Choose either --project or --global, not both.");
  if (opts.project || opts.global) return opts;
  if (!interactive || opts.yes)
    throw new CliError(
      "Specify --project or --global. For automation also provide --agent <id> --yes.",
    );
  while (true) {
    const answer = (
      await ask(
        `Install the Simbox skill where?\n  1. Current project (${process.cwd()})\n  2. Global (your user account)\nChoose 1 or 2 (q to cancel): `,
      )
    )
      .trim()
      .toLowerCase();
    if (answer === "1" || answer === "project") return { ...opts, project: true };
    if (answer === "2" || answer === "global") return { ...opts, global: true };
    if (answer === "q" || answer === "cancel") throw new CliError("Skill installation canceled.");
  }
}

export async function cmdSkillsInstall(opts: SkillInstallOptions): Promise<void> {
  let selected = opts;
  if (!opts.project && !opts.global) {
    if (!process.stdin.isTTY || !process.stdout.isTTY || opts.yes) {
      selected = await selectSkillScope(opts, false, async () => "");
    } else {
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      try {
        selected = await selectSkillScope(opts, true, (q) => prompt.question(q));
      } finally {
        prompt.close();
      }
    }
  }
  const args = skillInstallArgs(selected);
  if (!opts.dryRun && !opts.yes && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new CliError(
      "Interactive skills installation needs a terminal. Use --project/--global --agent <id> --yes for automation.",
    );
  }
  console.log(`Scope: ${selected.global ? "global" : `current project (${process.cwd()})`}`);
  console.log(`Command: bunx ${args.map((arg) => (arg === "*" ? "'*'" : arg)).join(" ")}`);
  console.log(
    "This runs the third-party skills CLI. It handles agent selection and install confirmations; --yes accepts its installation/overwrite prompts.",
  );
  console.log("Set DISABLE_TELEMETRY=1 to opt out of skills CLI telemetry.");
  if (opts.dryRun) return;
  await new Promise<void>((resolve, reject) => {
    const child = spawn("bunx", args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
      shell: false,
    });
    child.once("error", (err) =>
      reject(
        new CliError(
          `Could not start bunx. Install Bun or run the printed command manually. (${err.message})`,
        ),
      ),
    );
    child.once("exit", (code, signal) =>
      code === 0
        ? resolve()
        : reject(
            new CliError(
              `Skills installer ${signal ? `stopped by ${signal}` : `exited with code ${code}`}.`,
              code ?? 1,
            ),
          ),
    );
  });
}
