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
import { cmdDevicesList, cmdDevicesSet } from "./devices.js";
import {
  cmdWorkflowAdd,
  cmdWorkflowApply,
  cmdWorkflowEdit,
  cmdWorkflowMove,
  cmdWorkflowRemove,
  cmdWorkflowShow,
  type AddStepOptions,
} from "./workflow.js";
import type { DevicePlatform } from "@simbox/shared";

const platformOption = (description: string) =>
  new Option("--platform <platform>", description).choices(["ios", "android"]);
const scopeOption = () =>
  new Option("--scope <scope>", "account defaults or connected repository override")
    .choices(["account", "repo"])
    .makeOptionMandatory();
const collect = (value: string, previous: string[] = []) => [...previous, value];

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
  .option("--new", "start another run instead of reusing one (others keep running until idle)")
  .addOption(
    platformOption(
      "ios: macOS runner; android: Linux/KVM runner (omitted: this agent's run's platform, else iOS)",
    ),
  )
  .option(
    "--runner <label-or-json>",
    'override runner: a label, JSON label array, or {"labels":[...],"maxDevices":2}; requires --platform',
  )
  .option(
    "--device <model>",
    'simulator/emulator model, e.g. "iPhone 16 Pro" or pixel_8 (see `simbox devices list`); requires --platform',
  )
  .option(
    "--os <version>",
    "iOS version (18.4, 18), Android API level (35), latest or oldest; requires --platform",
  )
  .option(
    "--foldable",
    "boot a foldable: iPhone Duo (needs Xcode 27.1+, the default xcode-27 runner has it) or a 7.6in Android foldable; requires --platform",
  )
  .option("--xcode <version>", "iOS: select this Xcode (e.g. 27.1) before the device daemon starts")
  .option(
    "--json",
    "print {tunnel_url, daemon_token, run_id, expires_at, platform, booted_device, max_devices} as JSON only",
  )
  .action(
    (opts: {
      new?: boolean;
      json?: boolean;
      platform?: DevicePlatform;
      runner?: string;
      device?: string;
      os?: string;
      foldable?: boolean;
      xcode?: string;
    }) => {
      requireToken();
      return run(cmdSim(opts));
    },
  );

program
  .command("exec")
  .description(
    "Run agent-device on this agent's run with fresh tunnel credentials and a cold-boot startup budget; --platform picks iOS or Android, SIMBOX_RUN=<id> pins a run",
  )
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
  .description("Show active runs (several per platform; this agent's are marked)")
  .option("--json", "print {runs} as JSON")
  .action((opts: { json?: boolean }) => {
    requireToken();
    return run(cmdPs(opts));
  });

program
  .command("stop")
  .description("Stop this agent's runs (or the only platform's runs)")
  .option("--run <id>", "stop one run")
  .addOption(platformOption("stop this agent's run of this platform"))
  .option("--all", "stop every active run")
  .action((opts: { platform?: DevicePlatform; all?: boolean; run?: string }) => {
    requireToken();
    return run(cmdStop(opts));
  });

program
  .command("repair")
  .description(
    "Re-commit the workflow, re-verify the installation, and rotate the repo secret when no run is active",
  )
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
  cmd.addOption(scopeOption()).option("--json", "print settings as JSON");
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

const devices = program
  .command("devices")
  .description("Device models and OS versions a runner offers, and your device defaults");
devices
  .command("list")
  .description("Show the last catalog a runner reported (models, OS versions, Xcode)")
  .addOption(platformOption("only this platform"))
  .option("--runner <label-or-json>", "a runner other than the effective one; requires --platform")
  .option("--json", "print {ios?, android?} inventory responses as JSON")
  .action((opts: { platform?: DevicePlatform; runner?: string; json?: boolean }) => {
    requireToken();
    return run(cmdDevicesList(opts));
  });
devices
  .command("set")
  .description("Set the default device model and/or OS for future runs")
  .addArgument(new Argument("<platform>").choices(["ios", "android"]))
  .option("--device <model>", 'model, e.g. "iPhone 16 Pro" or pixel_8')
  .option("--os <version>", "iOS version, Android API level, latest or oldest")
  .option("--foldable", "default to a foldable instead of a model")
  .addOption(scopeOption())
  .option("--json", "print settings as JSON")
  .action(
    (
      platform: DevicePlatform,
      opts: {
        device?: string;
        os?: string;
        foldable?: boolean;
        scope: "account" | "repo";
        json?: boolean;
      },
    ) => {
      requireToken();
      return run(cmdDevicesSet(platform, opts, opts.scope, opts.json));
    },
  );
devices
  .command("reset")
  .description("Clear a device default so the scope inherits")
  .addArgument(new Argument("<platform>").choices(["ios", "android"]))
  .addOption(scopeOption())
  .option("--json", "print settings as JSON")
  .action((platform: DevicePlatform, opts: { scope: "account" | "repo"; json?: boolean }) => {
    requireToken();
    return run(cmdDevicesSet(platform, null, opts.scope, opts.json));
  });

const workflow = program
  .command("workflow")
  .description("Show and edit the steps of .github/workflows/simbox.yml");
workflow
  .command("show")
  .description("List steps (prepare/start/serve are locked) and the committed file's status")
  .option("--yaml", "print the rendered YAML")
  .option("--json", "print {spec, yaml, status, repoState, prUrl} as JSON")
  .action((opts: { yaml?: boolean; json?: boolean }) => {
    requireToken();
    return run(cmdWorkflowShow(opts));
  });
workflow
  .command("add")
  .description("Add a step (default: before the locked `start` step, i.e. before devices boot)")
  .requiredOption("--name <name>", "step name")
  .option("--run <script>", "shell script to run")
  .option("--uses <action>", "action to use, e.g. actions/checkout@v4")
  .option("--with <key=value>", "action input (repeatable)", collect)
  .option("--env <key=value>", "environment variable (repeatable)", collect)
  .option("--if <expression>", "GitHub Actions condition")
  .addOption(platformOption("only run this step for one platform"))
  .option("--id <id>", "step id (default: derived from --name)")
  .option("--before <id>", "insert before this step")
  .option("--after <id>", "insert after this step")
  .option("--json", "print the saved workflow as JSON")
  .action((opts: AddStepOptions) => {
    requireToken();
    return run(cmdWorkflowAdd(opts));
  });
workflow
  .command("remove")
  .description("Remove a custom step")
  .argument("<id>", "step id")
  .option("--json", "print the saved workflow as JSON")
  .action((id: string, opts: { json?: boolean }) => {
    requireToken();
    return run(cmdWorkflowRemove(id, opts));
  });
workflow
  .command("move")
  .description("Move a custom step before or after another step")
  .argument("<id>", "step id")
  .option("--before <id>", "move before this step")
  .option("--after <id>", "move after this step")
  .option("--json", "print the saved workflow as JSON")
  .action((id: string, opts: { before?: string; after?: string; json?: boolean }) => {
    requireToken();
    return run(cmdWorkflowMove(id, opts));
  });
workflow
  .command("edit")
  .description("Edit the steps as JSON in $VISUAL/$EDITOR, then save")
  .option("--json", "print the saved workflow as JSON")
  .action((opts: { json?: boolean }) => {
    requireToken();
    return run(cmdWorkflowEdit(opts));
  });
workflow
  .command("apply")
  .description("Save a workflow spec from a JSON file ({steps, permissions?})")
  .argument("<file>", "JSON file")
  .option("--json", "print the saved workflow as JSON")
  .action((file: string, opts: { json?: boolean }) => {
    requireToken();
    return run(cmdWorkflowApply(file, opts));
  });

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
