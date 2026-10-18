import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pc from "picocolors";
import {
  SIMBOX_STEPS,
  WORKFLOW_PATH,
  insertStep,
  isLockedStep,
  moveStep,
  removeStep,
  suggestStepId,
  validateWorkflowSpec,
  type DevicePlatform,
  type StepPosition,
  type UserStep,
  type WorkflowResponse,
  type WorkflowSpec,
  type WorkflowStatus,
} from "@simbox/shared";
import { CliError, getWorkflow, putWorkflow } from "./client.js";

/** The API calls this module makes; injectable for tests. */
export interface WorkflowDeps {
  get: () => Promise<WorkflowResponse>;
  put: (spec: WorkflowSpec) => Promise<WorkflowResponse>;
  /** Opens the file in the user's editor and returns once they close it. */
  openEditor: (file: string) => void;
  log: (line: string) => void;
}

export const defaultWorkflowDeps: WorkflowDeps = {
  get: getWorkflow,
  put: putWorkflow,
  openEditor,
  log: (line) => console.log(line),
};

const withDefaults = (deps: Partial<WorkflowDeps> = {}): WorkflowDeps => ({
  ...defaultWorkflowDeps,
  ...deps,
});

/** Shared editing helpers throw plain Errors; surface them as CLI errors. */
function edit<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw new CliError((err as Error).message);
  }
}

const STATUS_TEXT: Record<WorkflowStatus, string> = {
  current: "current — the committed file matches these steps",
  outdated: "outdated — run `simbox repair` to upgrade it",
  drifted: "differs from these steps — a pending pull request or an edit outside Simbox",
  missing: "missing — run `simbox repair` to commit it",
};

function oneLine(text: string, max = 60): string {
  const first = text.trim().split("\n")[0]!;
  const more = first.length > max || text.trim().includes("\n");
  return `${first.slice(0, max)}${more ? "…" : ""}`;
}

function describeStep(step: UserStep): string {
  const parts: string[] = [];
  if (step.platform) parts.push(`[${step.platform} only]`);
  if (step.if) parts.push(`if: ${step.if}`);
  if (step.uses) {
    const inputs = step.with ? Object.keys(step.with) : [];
    parts.push(`uses: ${step.uses}${inputs.length ? ` (with ${inputs.join(", ")})` : ""}`);
  } else if (step.run !== undefined) parts.push(`run: ${oneLine(step.run)}`);
  if (step.env) parts.push(`env: ${Object.keys(step.env).join(", ")}`);
  return parts.join("  ");
}

export function formatWorkflow(res: WorkflowResponse): string[] {
  const lines = [
    `${pc.bold(WORKFLOW_PATH)}: ${res.status ? STATUS_TEXT[res.status] : pc.yellow("unknown — GitHub could not be read")}`,
    `Repo state: ${res.repoState === "ok" ? pc.green("ok") : pc.yellow(res.repoState)}`,
  ];
  if (res.prUrl)
    lines.push(
      `Merge ${pc.underline(res.prUrl)} to apply these steps (the default branch is protected).`,
    );
  else if (res.repoState === "pending_pr")
    lines.push(
      "Merge the Simbox pull request to apply the workflow (the default branch is protected).",
    );
  lines.push("", "Steps:");
  const width = Math.max(...res.spec.steps.map((s) => (isLockedStep(s) ? s.simbox : s.id).length));
  res.spec.steps.forEach((step, i) => {
    const n = `${String(i + 1).padStart(2)}.`;
    if (isLockedStep(step)) {
      lines.push(
        `${n} ${pc.dim("locked")} ${step.simbox.padEnd(width)}  ${SIMBOX_STEPS[step.simbox].name}`,
      );
    } else {
      const detail = describeStep(step);
      lines.push(
        `${n}        ${step.id.padEnd(width)}  ${step.name}${detail ? pc.dim(`  ${detail}`) : ""}`,
      );
    }
  });
  if (res.spec.permissions)
    lines.push(
      "",
      `Permissions: ${Object.entries(res.spec.permissions)
        .map(([scope, level]) => `${scope}: ${level}`)
        .join(", ")}`,
    );
  return lines;
}

export async function cmdWorkflowShow(
  opts: { yaml?: boolean; json?: boolean },
  deps: Partial<WorkflowDeps> = {},
): Promise<void> {
  const d = withDefaults(deps);
  if (opts.yaml && opts.json) throw new CliError("Choose either --yaml or --json.");
  const res = await d.get();
  if (opts.json) d.log(JSON.stringify(res));
  else if (opts.yaml) d.log(res.yaml.replace(/\n$/, ""));
  else for (const line of formatWorkflow(res)) d.log(line);
}

/** Save and report the status, and the PR to merge when the branch is protected. */
async function save(spec: WorkflowSpec, d: WorkflowDeps, json = false): Promise<WorkflowResponse> {
  const res = await d.put(spec);
  if (json) {
    d.log(JSON.stringify(res));
    return res;
  }
  d.log(`${pc.green("✔")} Workflow saved.`);
  for (const line of formatWorkflow(res)) d.log(line);
  return res;
}

/** "--before x" / "--after y"; default is before the locked `start` step. */
export function stepPosition(opts: { before?: string; after?: string }): StepPosition {
  if (opts.before !== undefined && opts.after !== undefined)
    throw new CliError("Choose either --before or --after.");
  if (opts.after !== undefined) return { after: opts.after };
  return { before: opts.before ?? "start" };
}

/** Repeatable `k=v` options into a map. */
export function keyValues(
  pairs: string[] | undefined,
  flag: string,
): Record<string, string> | undefined {
  if (!pairs?.length) return undefined;
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new CliError(`${flag} takes key=value (got "${pair}").`);
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

export interface AddStepOptions {
  name: string;
  run?: string;
  uses?: string;
  with?: string[];
  env?: string[];
  if?: string;
  platform?: DevicePlatform;
  id?: string;
  before?: string;
  after?: string;
  json?: boolean;
}

export function buildStep(spec: WorkflowSpec, opts: AddStepOptions): UserStep {
  if ((opts.run === undefined) === (opts.uses === undefined))
    throw new CliError("Pass exactly one of --run <script> or --uses <action>.");
  if (opts.with?.length && opts.uses === undefined)
    throw new CliError("--with only applies to --uses steps.");
  const inputs = keyValues(opts.with, "--with");
  const env = keyValues(opts.env, "--env");
  return {
    id: opts.id ?? suggestStepId(spec, opts.name),
    name: opts.name,
    ...(opts.run !== undefined ? { run: opts.run } : { uses: opts.uses }),
    ...(inputs ? { with: inputs } : {}),
    ...(env ? { env } : {}),
    ...(opts.if !== undefined ? { if: opts.if } : {}),
    ...(opts.platform ? { platform: opts.platform } : {}),
  };
}

export async function cmdWorkflowAdd(
  opts: AddStepOptions,
  deps: Partial<WorkflowDeps> = {},
): Promise<void> {
  const d = withDefaults(deps);
  const position = stepPosition(opts);
  const { spec } = await d.get();
  const step = buildStep(spec, opts);
  await save(
    edit(() => insertStep(spec, step, position)),
    d,
    opts.json,
  );
}

export async function cmdWorkflowRemove(
  id: string,
  opts: { json?: boolean } = {},
  deps: Partial<WorkflowDeps> = {},
): Promise<void> {
  const d = withDefaults(deps);
  const { spec } = await d.get();
  await save(
    edit(() => removeStep(spec, id)),
    d,
    opts.json,
  );
}

export async function cmdWorkflowMove(
  id: string,
  opts: { before?: string; after?: string; json?: boolean },
  deps: Partial<WorkflowDeps> = {},
): Promise<void> {
  const d = withDefaults(deps);
  if (opts.before === undefined && opts.after === undefined)
    throw new CliError("Pass --before <id> or --after <id>.");
  const position = stepPosition(opts);
  const { spec } = await d.get();
  await save(
    edit(() => moveStep(spec, id, position)),
    d,
    opts.json,
  );
}

export function parseSpecText(text: string, source: string): WorkflowSpec {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new CliError(`${source} is not valid JSON: ${(err as Error).message}`);
  }
  // Accept a whole `workflow show --json` response as well as a bare spec.
  if (value && typeof value === "object" && "spec" in value && !("steps" in value))
    value = (value as { spec: unknown }).spec;
  return edit(() => validateWorkflowSpec(value));
}

export async function cmdWorkflowApply(
  file: string,
  opts: { json?: boolean } = {},
  deps: Partial<WorkflowDeps> = {},
): Promise<void> {
  const d = withDefaults(deps);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    throw new CliError(`Could not read ${file}: ${(err as Error).message}`);
  }
  await save(parseSpecText(text, file), d, opts.json);
}

export async function cmdWorkflowEdit(
  opts: { json?: boolean } = {},
  deps: Partial<WorkflowDeps> = {},
): Promise<void> {
  const d = withDefaults(deps);
  const { spec } = await d.get();
  const original = `${JSON.stringify(spec, null, 2)}\n`;
  const dir = mkdtempSync(join(tmpdir(), "simbox-workflow-"));
  const file = join(dir, "simbox-workflow.json");
  writeFileSync(file, original, { mode: 0o600 });
  let keep = false;
  try {
    d.openEditor(file);
    const text = readFileSync(file, "utf8");
    if (text === original) {
      d.log("No changes.");
      return;
    }
    let next: WorkflowSpec;
    try {
      next = parseSpecText(text, "The edited workflow");
    } catch (err) {
      keep = true;
      throw new CliError(
        `${(err as Error).message}\nYour edit is kept at ${file}; fix it and run \`simbox workflow apply ${file}\`.`,
      );
    }
    await save(next, d, opts.json);
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
}

/** $VISUAL, then $EDITOR, then vi; the editor command may carry arguments ("code --wait"). */
function openEditor(file: string): void {
  const editor = process.env.VISUAL || process.env.EDITOR || "vi";
  const result =
    process.platform === "win32"
      ? spawnSync(editor, [file], { stdio: "inherit", shell: true })
      : spawnSync("sh", ["-c", `${editor} "$1"`, "sh", file], { stdio: "inherit" });
  if (result.error || result.status !== 0)
    throw new CliError(
      `Editor "${editor}" ${result.error ? `failed to start (${result.error.message})` : `exited with code ${result.status}`}; nothing was saved.`,
    );
}
