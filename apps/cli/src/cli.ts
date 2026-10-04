#!/usr/bin/env node
import { Command, Option } from "commander";
import pc from "picocolors";
import { createRequire } from "node:module";
import { friendlyError } from "./client.js";
import { requireToken } from "./config.js";
import { cmdInit, cmdLogin, cmdLogout, cmdPs, cmdRepair, cmdSim, cmdStop } from "./commands.js";
import { cmdExec } from "./remote.js";

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
  .option("--json", "print {tunnel_url, daemon_token, run_id, expires_at} as JSON only")
  .action((opts: { new?: boolean; json?: boolean; platform?: "ios" | "android" }) => {
    requireToken();
    return run(cmdSim(opts));
  });

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
    process.stderr.write(`${pc.red("✖")} ${friendlyError(err).message}\n`);
    process.exitCode = 1;
  }
}

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`${pc.red("✖")} ${friendlyError(err).message}\n`);
  process.exitCode = 1;
});
