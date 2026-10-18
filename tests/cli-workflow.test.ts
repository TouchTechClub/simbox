import { expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultWorkflowSpec,
  renderWorkflow,
  stepId,
  type WorkflowResponse,
  type WorkflowSpec,
} from "../packages/shared/src/index.js";
import {
  cmdWorkflowAdd,
  cmdWorkflowApply,
  cmdWorkflowEdit,
  cmdWorkflowMove,
  cmdWorkflowRemove,
  cmdWorkflowShow,
  type WorkflowDeps,
} from "../apps/cli/src/workflow.js";

/** A stored spec behind GET/PUT /v1/workflow; a protected branch answers pending_pr. */
function fakeApi(spec: WorkflowSpec = defaultWorkflowSpec(), protectedBranch = false) {
  let stored = spec;
  const puts: WorkflowSpec[] = [];
  const lines: string[] = [];
  const response = (): WorkflowResponse => ({
    spec: stored,
    yaml: renderWorkflow(stored),
    status: "current",
    repoState: protectedBranch ? "pending_pr" : "ok",
    prUrl: protectedBranch ? "https://github.com/owner/repo/pull/7" : null,
  });
  const deps: Partial<WorkflowDeps> = {
    get: async () => response(),
    put: async (next) => {
      puts.push(next);
      stored = next;
      return response();
    },
    log: (line) => lines.push(line),
    openEditor: () => {
      throw new Error("no editor in this test");
    },
  };
  return { deps, puts, lines, ids: () => stored.steps.map(stepId) };
}

test("show lists locked and custom steps, sync status and the PR to merge", async () => {
  const api = fakeApi(
    {
      steps: [
        { id: "checkout", name: "Checkout", uses: "actions/checkout@v4" },
        { simbox: "prepare" },
        { simbox: "start" },
        { id: "seed", name: "Seed data", run: "npm run seed\nnpm run more", platform: "ios" },
        { simbox: "serve" },
      ],
    },
    true,
  );
  await cmdWorkflowShow({}, api.deps);
  const text = api.lines.join("\n");
  expect(text).toContain("current");
  expect(text).toContain("pending_pr");
  expect(text).toContain("https://github.com/owner/repo/pull/7");
  expect(text).toMatch(/2\. .*locked.*prepare/);
  expect(text).toMatch(/4\. .*seed.*Seed data.*\[ios only\].*run: npm run seed…/);
  expect(text).toContain("uses: actions/checkout@v4");

  api.lines.length = 0;
  await cmdWorkflowShow({ yaml: true }, api.deps);
  expect(api.lines.join("\n")).toContain("simbox-workflow: 2");
  api.lines.length = 0;
  await cmdWorkflowShow({ json: true }, api.deps);
  expect(JSON.parse(api.lines[0]!).spec.steps).toHaveLength(5);
  await expect(cmdWorkflowShow({ json: true, yaml: true }, api.deps)).rejects.toThrow("either");
});

test("add defaults to before start, derives ids, and saves through PUT", async () => {
  const api = fakeApi();
  await cmdWorkflowAdd({ name: "Build app", run: "npm run build" }, api.deps);
  expect(api.ids()).toEqual(["prepare", "build-app", "start", "serve"]);
  await cmdWorkflowAdd(
    {
      name: "Build app",
      uses: "actions/setup-node@v4",
      with: ["node-version=22", "cache=npm"],
      env: ["CI=1"],
      platform: "android",
      if: "github.ref == 'refs/heads/main'",
      after: "serve",
    },
    api.deps,
  );
  expect(api.ids()).toEqual(["prepare", "build-app", "start", "serve", "build-app-2"]);
  expect(api.puts.at(-1)!.steps.at(-1)).toEqual({
    id: "build-app-2",
    name: "Build app",
    uses: "actions/setup-node@v4",
    with: { "node-version": "22", cache: "npm" },
    env: { CI: "1" },
    if: "github.ref == 'refs/heads/main'",
    platform: "android",
  });
  expect(api.lines.join("\n")).toContain("Workflow saved");

  await expect(cmdWorkflowAdd({ name: "x" }, api.deps)).rejects.toThrow("exactly one");
  await expect(cmdWorkflowAdd({ name: "x", run: "a", with: ["k=v"] }, api.deps)).rejects.toThrow(
    "--with",
  );
  await expect(
    cmdWorkflowAdd({ name: "x", run: "a", before: "start", after: "serve" }, api.deps),
  ).rejects.toThrow("either");
  await expect(cmdWorkflowAdd({ name: "x", run: "a", env: ["NOEQ"] }, api.deps)).rejects.toThrow(
    "key=value",
  );
  await expect(cmdWorkflowAdd({ name: "x", run: "a", id: "start" }, api.deps)).rejects.toThrow(
    "reserved",
  );
  await expect(cmdWorkflowAdd({ name: "x", run: "a", before: "nope" }, api.deps)).rejects.toThrow(
    'No step "nope"',
  );
  expect(api.puts).toHaveLength(2);
});

test("remove and move edit custom steps; locked steps refuse with the shared message", async () => {
  const api = fakeApi({
    steps: [
      { simbox: "prepare" },
      { id: "one", name: "One", run: "true" },
      { id: "two", name: "Two", run: "true" },
      { simbox: "start" },
      { simbox: "serve" },
    ],
  });
  await cmdWorkflowMove("one", { after: "start" }, api.deps);
  expect(api.ids()).toEqual(["prepare", "two", "start", "one", "serve"]);
  await cmdWorkflowRemove("two", {}, api.deps);
  expect(api.ids()).toEqual(["prepare", "start", "one", "serve"]);
  await expect(cmdWorkflowRemove("start", {}, api.deps)).rejects.toThrow(
    '"start" is a locked Simbox step.',
  );
  await expect(cmdWorkflowMove("serve", { before: "prepare" }, api.deps)).rejects.toThrow(
    "cannot move",
  );
  await expect(cmdWorkflowMove("one", {}, api.deps)).rejects.toThrow("--before");
  expect(api.puts).toHaveLength(2);
});

test("edit round-trips a private temp file, re-validates, and keeps a broken edit", async () => {
  const api = fakeApi();
  let seen = "";
  await cmdWorkflowEdit(
    {},
    {
      ...api.deps,
      openEditor: (file) => {
        seen = file;
      },
    },
  );
  expect(api.lines).toContain("No changes.");
  expect(api.puts).toHaveLength(0);
  expect(await Bun.file(seen).exists()).toBe(false);

  // Owner-only: the spec may hold env values.
  let mode = 0;
  await cmdWorkflowEdit(
    {},
    {
      ...api.deps,
      openEditor: (file) => {
        mode = statSync(file).mode & 0o777;
        const spec = JSON.parse(readFileSync(file, "utf8"));
        spec.steps.splice(2, 0, { id: "seed", name: "Seed", run: "./seed.sh" });
        writeFileSync(file, JSON.stringify(spec));
      },
    },
  );
  expect(mode).toBe(0o600);
  expect(api.ids()).toEqual(["prepare", "start", "seed", "serve"]);

  let kept = "";
  await expect(
    cmdWorkflowEdit(
      {},
      {
        ...api.deps,
        openEditor: (file) => {
          kept = file;
          writeFileSync(file, JSON.stringify({ steps: [{ simbox: "serve" }] }));
        },
      },
    ),
  ).rejects.toThrow("simbox workflow apply");
  expect(await Bun.file(kept).exists()).toBe(true);
  expect(api.puts).toHaveLength(1);
  await rm(join(kept, ".."), { recursive: true, force: true });
});

test("apply validates a file (bare spec or a show --json response) before saving", async () => {
  const dir = await mkdtemp(join(tmpdir(), "simbox-workflow-apply-"));
  try {
    const api = fakeApi(defaultWorkflowSpec(), true);
    const file = join(dir, "spec.json");
    const spec = {
      steps: [
        { simbox: "prepare" },
        { simbox: "start" },
        { id: "test", name: "Test", run: "npm test" },
        { simbox: "serve" },
      ],
    };
    await writeFile(file, JSON.stringify({ spec, yaml: "", status: "current" }));
    await cmdWorkflowApply(file, {}, api.deps);
    expect(api.ids()).toEqual(["prepare", "start", "test", "serve"]);
    expect(api.lines.join("\n")).toContain("pull/7");

    await writeFile(file, "{nope");
    await expect(cmdWorkflowApply(file, {}, api.deps)).rejects.toThrow("not valid JSON");
    await writeFile(file, JSON.stringify({ steps: [{ simbox: "start" }] }));
    await expect(cmdWorkflowApply(file, {}, api.deps)).rejects.toThrow("prepare, start and serve");
    await expect(cmdWorkflowApply(join(dir, "missing.json"), {}, api.deps)).rejects.toThrow(
      "Could not read",
    );
    expect(api.puts).toHaveLength(1);
    expect((await stat(file)).isFile()).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
