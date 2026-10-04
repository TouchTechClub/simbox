#!/usr/bin/env node
import { Command } from "commander";
import pc from "picocolors";
import { createRequire } from "node:module";
import { friendlyError } from "./client.js";
import { requireToken } from "./config.js";
import { cmdInit, cmdLogin, cmdLogout, cmdPs, cmdRepair, cmdSim, cmdStop } from "./commands.js";

const program = new Command();

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
  .description("Ensure a run is live and connect agent-device to it")
  .option("--new", "force a fresh run even if one is live")
  .option("--json", "print {tunnel_url, daemon_token, run_id, expires_at} as JSON only")
  .action((opts: { new?: boolean; json?: boolean }) => {
    requireToken();
    return run(cmdSim(opts));
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
