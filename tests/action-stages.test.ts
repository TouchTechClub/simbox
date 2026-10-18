import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { actionStepScript } from "./helpers/action";

// The start/serve scripts run on macOS bash 3.2 too; these tests drive them
// with a fake agent that follows the agent's staged-mode file protocol.
let temp = "";
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "simbox-stages-"));
});
afterEach(async () => {
  await rm(temp, { recursive: true, force: true });
});

async function fakeAgent(body: string): Promise<void> {
  await mkdir(join(temp, "simbox"), { recursive: true });
  const path = join(temp, "simbox", "simbox-agent");
  await Bun.write(path, `#!/bin/bash\nS="$SIMBOX_STAGE_DIR"\n${body}\n`);
  await chmod(path, 0o755);
}

const READY = `
echo "::add-mask::s3cret"
echo "booting $SIMBOX_RUN_ID"
printf 'half a '
touch "$S/ready"
while [ ! -f "$S/go" ]; do sleep 0.1; done
echo "line"
echo "serving"`;

function step(name: "Start simbox-agent" | "Serve devices", env: Record<string, string> = {}) {
  return actionStepScript(name).then((script) =>
    Bun.spawn(["/bin/bash", "-c", script], {
      env: {
        PATH: "/usr/bin:/bin",
        RUNNER_TEMP: temp,
        SIMBOX_TOKEN: "token",
        SIMBOX_RUN_ID: "run-1",
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
}

async function finish(proc: Bun.Subprocess<"ignore" | "inherit" | "pipe", "pipe", "pipe">) {
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

test("start streams whole lines until ready; serve streams the rest and exits with the agent", async () => {
  await fakeAgent(`${READY}\necho 0 > "$S/exit-code"\nexit 0`);
  const start = await finish(await step("Start simbox-agent"));
  expect(start.code).toBe(0);
  // Mask commands reach the step output first; a partial line is held back.
  expect(start.stdout.startsWith("::add-mask::s3cret\nbooting run-1\n")).toBe(true);
  expect(start.stdout).not.toContain("half a");
  expect(existsSync(join(temp, "simbox/stage/go"))).toBe(false);

  const serve = await finish(await step("Serve devices"));
  expect(serve.code).toBe(0);
  expect(serve.stdout).toContain("half a line\nserving\n");
  expect(serve.stdout).not.toContain("booting");
});

test("start fails with the agent's exit code when it dies before devices are ready", async () => {
  await fakeAgent('echo "boom: no emulator"\necho 3 > "$S/exit-code"\nexit 3');
  const died = await finish(await step("Start simbox-agent"));
  expect(died.code).toBe(3);
  expect(died.stdout).toContain("boom: no emulator");
  expect(died.stdout).toContain("before its devices were ready");

  // Ending "cleanly" before ready is still a failed start.
  await fakeAgent("printf 'stopped'\nexit 0");
  const clean = await finish(await step("Start simbox-agent"));
  expect(clean.code).toBe(1);
  expect(clean.stdout).toContain("stopped");
});

test("serve propagates the recorded exit code, and a missing one is a failure", async () => {
  await fakeAgent(`${READY}\necho 4 > "$S/exit-code"\nexit 4`);
  expect((await finish(await step("Start simbox-agent"))).code).toBe(0);
  expect((await finish(await step("Serve devices"))).code).toBe(4);

  await fakeAgent(`${READY}\nexit 0`);
  expect((await finish(await step("Start simbox-agent"))).code).toBe(0);
  expect((await finish(await step("Serve devices"))).code).toBe(1);
});

test("serve forwards cancellation to the agent and waits for its cleanup", async () => {
  await fakeAgent(`${READY}
trap 'echo "agent got TERM"; echo 0 > "$S/exit-code"; exit 0' TERM
while :; do sleep 0.1; done`);
  expect((await finish(await step("Start simbox-agent"))).code).toBe(0);
  const serve = await step("Serve devices");
  const deadline = Date.now() + 5000;
  while (!existsSync(join(temp, "simbox/stage/go")) && Date.now() < deadline) await Bun.sleep(50);
  await Bun.sleep(1500);
  serve.kill("SIGTERM");
  const result = await finish(serve);
  expect(result.stdout).toContain("Stopping simbox-agent");
  expect(result.stdout).toContain("agent got TERM");
  expect(result.code).toBe(0);
}, 20_000);

test("start and serve refuse to run out of order or without a token", async () => {
  const unprepared = await finish(await step("Start simbox-agent"));
  expect(unprepared.code).toBe(1);
  expect(unprepared.stderr).toContain("step: prepare");

  await fakeAgent(READY);
  const tokenless = await finish(await step("Start simbox-agent", { SIMBOX_TOKEN: "" }));
  expect(tokenless.code).toBe(1);
  expect(tokenless.stderr).toContain("token");

  const unstarted = await finish(await step("Serve devices"));
  expect(unstarted.code).toBe(1);
  expect(unstarted.stderr).toContain("step: start");
});

test("every input reaches the scripts as env data, never as interpolated shell", async () => {
  const template = await Bun.file(
    new URL("../action-src/action.yml.template", import.meta.url),
  ).text();
  for (const name of [
    "Prepare simbox-agent",
    "Start simbox-agent",
    "Serve devices",
    "Run simbox-agent",
  ])
    expect(await actionStepScript(name)).not.toContain("${{");
  expect(template).toContain('default: "all"');
  expect(template).toMatch(/token:\n(?:.*\n){1,2}\s+required: false/);
});
