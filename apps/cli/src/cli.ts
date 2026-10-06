#!/usr/bin/env node
import { Argument, Command, Option } from "commander";
import pc from "picocolors";
import { createRequire } from "node:module";
import { friendlyError } from "./client.js";
import { requireToken } from "./config.js";
import { cmdInit, cmdLogin, cmdLogout, cmdPs, cmdRepair, cmdSim, cmdStop } from "./commands.js";
import { cmdExec } from "./remote.js";
import { cmdRunnerPresets, cmdRunnersSet, cmdRunnersShow, cmdDoctor } from "./runners.js";
import { cmdSkillsInstall, type SkillInstallOptions } from "./skills.js";
import type { DevicePlatform } from "@simbox/shared";

const program = new Command().enablePositionalOptions();

program
  .name("simbox")
  .description("On-demand iOS simulators & Android emulators on your own GitHub Actions minutes.")
  // Resolved from package.json at runtime (bin is a bundled dist/cli.js, so a
  // plain import of ../package.json doesn't work after `bun build`).
  .version(getVersion());

program
  .command("login")
  .description("Authenticate via device flow")
  .action(() => run(cmdLogin()));

program
  .command("init")
  .description("Open onboarding and wait until a repo is connected")
  .action(() => {
    requireToken();
    return run(cmdInit());
  });

program
  .command("sim")
  .description("Ensure a run and its tunnel are ready for device commands")
  .option("--new", "force a fresh run even if one is live")
  .addOption(
    new Option("--platform <platform>", "ios: macOS runner; android: Linux/KVM runner").choices([
      "ios",
      "android",
    ]),
  )
  .option(
    "--runner <label-or-json>",
    "override runner label or JSON label array; requires --platform",
  )
  .option("--json", "print {tunnel_url, daemon_token, run_id, expires_at} as JSON only")
  .action(
    (opts: { new?: boolean; json?: boolean; platform?: "ios" | "android"; runner?: string }) => {
      requireToken();
      return run(cmdSim(opts));
    },
  );

program
  .command("exec")
  .description("Run agent-device with fresh tunnel credentials and a cold-boot startup budget")
  .argument("[args...]", "agent-device command and arguments")
  .allowUnknownOption()
  .allowExcessArguments()
  .passThroughOptions()
  .action((args: string[]) => {
    requireToken();
    return run(cmdExec(args));
  });

program
  .command("ps")
  .description("Show the current run")
  .action(() => {
    requireToken();
    return run(cmdPs());
  });

program
  .command("stop")
  .description("Cancel the active run")
  .action(() => {
    requireToken();
    return run(cmdStop());
  });

program
  .command("repair")
  .description("Re-commit the workflow, rotate the repo secret, re-verify the installation")
  .action(() => {
    requireToken();
    return run(cmdRepair());
  });

program
  .command("logout")
  .description("Delete the saved auth token")
  .action(() => run(cmdLogout()));

const runners = program
  .command("runners")
  .description("Account runner defaults and connected-repository overrides");
program
  .command("doctor")
  .description("Check tools, runner settings and workflow without starting a job")
  .option("--json", "print diagnostics as JSON")
  .action((opts: { json?: boolean }) => {
    requireToken();
    return run(cmdDoctor(opts.json));
  });
runners
  .command("show")
  .option("--json", "print settings as JSON")
  .action((opts: { json?: boolean }) => {
    requireToken();
    return run(cmdRunnersShow(opts.json));
  });
runners
  .command("presets")
  .description("List GitHub and Blacksmith presets")
  .action(cmdRunnerPresets);
for (const command of ["set", "reset"] as const) {
  const cmd = runners
    .command(command)
    .addArgument(new Argument("<platform>").choices(["ios", "android"]));
  if (command === "set") cmd.argument("<label-or-json>", "runner label or JSON label array");
  cmd
    .addOption(
      new Option("--scope <scope>", "account defaults or connected repository override")
        .choices(["account", "repo"])
        .makeOptionMandatory(),
    )
    .option("--json", "print settings as JSON");
  if (command === "set")
    cmd.action(
      (
        platform: DevicePlatform,
        input: string,
        opts: { scope: "account" | "repo"; json?: boolean },
      ) => {
        requireToken();
        return run(cmdRunnersSet(platform, input, opts.scope, opts.json));
      },
    );
  else
    cmd.action((platform: DevicePlatform, opts: { scope: "account" | "repo"; json?: boolean }) => {
      requireToken();
      return run(cmdRunnersSet(platform, null, opts.scope, opts.json));
    });
}

program
  .command("skills")
  .description("Set up the small Simbox agent skill")
  .command("install")
  .description("Install via bunx skills; asks current project or global")
  .option("--project", "install to the current project")
  .option("--global", "install to your user account")
  .option("--agent <agents...>", "target skills CLI agent IDs; otherwise let the installer ask")
  .option("--yes", "accept installer confirmations; requires explicit scope and agents")
  .option("--dry-run", "print the command without installing")
  .action((opts: SkillInstallOptions) => run(cmdSkillsInstall(opts)));

function getVersion(): string {
  try {
    // dist/cli.js sits next to package.json inside the installed package.
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function run(p: Promise<void>): Promise<void> {
  try {
    await p;
  } catch (err) {
    const error = friendlyError(err);
    process.stderr.write(`${pc.red("✖")} ${error.message}\n`);
    process.exitCode = error.exitCode;
  }
}

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`${pc.red("✖")} ${friendlyError(err).message}\n`);
  process.exitCode = 1;
});
