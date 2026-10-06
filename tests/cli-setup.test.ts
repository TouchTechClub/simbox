import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("CLI setup commands preserve scopes, JSON output, prompts and installer exit codes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "simbox-setup-cli-"));
  const calls: Array<{ path: string; auth: string | null; body: unknown }> = [];
  const settings = {
    account: { ios: null, android: null },
    repository: { ios: null, android: null },
    repoFullName: "owner/repo",
    effective: {
      ios: { runner: { labels: ["macos-latest"] }, source: "default" },
      android: { runner: { labels: ["ubuntu-latest"] }, source: "default" },
    },
  };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      calls.push({
        path: new URL(request.url).pathname,
        auth: request.headers.get("authorization"),
        body: request.method === "POST" ? await request.json() : null,
      });
      return Response.json(settings);
    },
  });
  try {
    await mkdir(join(dir, "bin"));
    await mkdir(join(dir, "config/simbox"), { recursive: true });
    await Bun.write(
      join(dir, "config/simbox/auth.json"),
      JSON.stringify({ token: "test-user-token" }),
    );
    const capture = join(dir, "installer-args.json");
    await Bun.write(
      join(dir, "bin/bunx"),
      `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(process.env.SKILL_ARGS, JSON.stringify({args: process.argv.slice(2), cwd: process.cwd()})); process.exit(Number(process.env.SKILL_EXIT || 0));\n`,
    );
    await chmod(join(dir, "bin/bunx"), 0o755);
    const cli = new URL("../apps/cli/src/cli.ts", import.meta.url).pathname;
    const run = async (args: string[], extra: Record<string, string> = {}) => {
      const child = Bun.spawn([process.execPath, cli, ...args], {
        cwd: dir,
        env: {
          ...process.env,
          XDG_CONFIG_HOME: join(dir, "config"),
          SIMBOX_API_URL: server.url.href.replace(/\/$/, ""),
          PATH: `${join(dir, "bin")}:${process.env.PATH}`,
          SKILL_ARGS: capture,
          ...extra,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { stdout, stderr, code };
    };
    expect((await run(["runners", "presets"])).stdout).toContain("blacksmith-6vcpu-macos-latest");
    expect(calls).toHaveLength(0);
    const shown = await run(["runners", "show", "--json"]);
    expect(shown.code).toBe(0);
    expect(JSON.parse(shown.stdout)).toEqual(settings);
    expect(calls.at(-1)?.auth).toBe("Bearer test-user-token");
    expect(
      (
        await run([
          "runners",
          "set",
          "android",
          "blacksmith-4vcpu-ubuntu-2404",
          "--scope",
          "account",
          "--json",
        ])
      ).code,
    ).toBe(0);
    expect(calls.at(-1)).toMatchObject({
      path: "/v1/runners/account",
      body: { android: { labels: ["blacksmith-4vcpu-ubuntu-2404"] } },
    });
    expect((await run(["runners", "reset", "android", "--scope", "repo"])).code).toBe(0);
    expect(calls.at(-1)?.body).toEqual({ android: null });
    const count = calls.length;
    expect(
      (await run(["runners", "set", "android", "macos-latest", "--scope", "account"])).code,
    ).toBe(1);
    expect((await run(["sim", "--runner", "ubuntu-latest"])).stderr).toContain("--platform");
    expect(calls).toHaveLength(count);

    const noAuth = { XDG_CONFIG_HOME: join(dir, "empty-config") };
    const missingScope = await run(["skills", "install"], noAuth);
    expect(missingScope.code).toBe(1);
    expect(missingScope.stderr).toContain("--project or --global");
    expect(await Bun.file(capture).exists()).toBe(false);
    expect((await run(["skills", "install", "--project", "--global"], noAuth)).stderr).toContain(
      "not both",
    );
    expect((await run(["skills", "install", "--project", "--yes"], noAuth)).stderr).toContain(
      "--agent",
    );
    expect(
      (await run(["skills", "install", "--project", "--agent", "codex", "--dry-run"], noAuth)).code,
    ).toBe(0);
    expect(await Bun.file(capture).exists()).toBe(false);
    const installed = await run(
      ["skills", "install", "--project", "--agent", "codex", "--yes"],
      noAuth,
    );
    expect(installed.code).toBe(0);
    expect(await Bun.file(capture).json()).toEqual({
      args: [
        "skills",
        "add",
        "TouchTechClub/simbox",
        "--skill",
        "simbox",
        "--agent",
        "codex",
        "--yes",
      ],
      cwd: dir,
    });
    expect(
      (
        await run(["skills", "install", "--global", "--agent", "claude-code", "--yes"], {
          ...noAuth,
          SKILL_EXIT: "7",
        })
      ).code,
    ).toBe(7);
    expect((await Bun.file(capture).json()).args).toContain("--global");
    expect(calls).toHaveLength(count); // skill install never contacts Simbox or starts a run
  } finally {
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);
