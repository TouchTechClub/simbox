import type { DevicePlatform } from "./runners.js";

/**
 * The committed `.github/workflows/simbox.yml` as data. Simbox owns three
 * locked steps in a fixed order; users may add their own steps before, between
 * or after them. The YAML is always rendered from this spec, so repair and
 * edits never lose user steps and never let a user step alter a locked one.
 */

export const WORKFLOW_SCHEMA_VERSION = 2;
const MARKER = "# simbox-workflow:";

/** Composite action every locked step runs; `step` selects the stage. */
export const RUNNER_ACTION = "TouchTechClub/runner@v1";

export type SimboxStepKey = "prepare" | "start" | "serve";

export const SIMBOX_STEPS: Record<SimboxStepKey, { name: string; description: string }> = {
  prepare: {
    name: "Prepare Simbox",
    description:
      "Checks the runner (OS, architecture, Xcode or KVM and the Android SDK) and downloads the checksum-verified Simbox agent.",
  },
  start: {
    name: "Start devices",
    description:
      "Starts Simlock and warms the requested simulator or emulator in the background. The device is warm but not reachable yet, so steps after this one can prepare the runner.",
  },
  serve: {
    name: "Serve devices",
    description:
      "Opens the tunnel to Simlock, marks the run live and serves devices until idle, stop or the time limit. Steps after it run once the session ends.",
  },
};

const SIMBOX_ORDER: SimboxStepKey[] = ["prepare", "start", "serve"];

export interface UserStep {
  id: string;
  name: string;
  run?: string;
  shell?: string;
  uses?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
  if?: string;
  /** Only run for this platform; absent runs for both. */
  platform?: DevicePlatform;
  workingDirectory?: string;
  continueOnError?: boolean;
  timeoutMinutes?: number;
}

export type LockedStep = { simbox: SimboxStepKey };
export type WorkflowStep = LockedStep | UserStep;

export type PermissionLevel = "read" | "write" | "none";

export interface WorkflowSpec {
  steps: WorkflowStep[];
  /** GITHUB_TOKEN permissions for the job; defaults to contents: read. */
  permissions?: Record<string, PermissionLevel>;
}

/** Where a step goes, relative to another step's id (locked ids are prepare/start/serve). */
export type StepPosition = { before: string } | { after: string };

export type WorkflowStatus = "missing" | "current" | "outdated" | "drifted";

export const isLockedStep = (step: WorkflowStep): step is LockedStep => "simbox" in step;
export const stepId = (step: WorkflowStep) => (isLockedStep(step) ? step.simbox : step.id);

export function defaultWorkflowSpec(): WorkflowSpec {
  return { steps: SIMBOX_ORDER.map((simbox) => ({ simbox })) };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const MAX_USER_STEPS = 40;
const STEP_ID = /^[a-z][a-z0-9_-]{0,39}$/;
const NAME = /^[^\r\n\t]{1,100}$/;
const USES =
  /^(\.\/[\w./-]{1,200}|docker:\/\/[\w./:@-]{1,200}|[\w.-]{1,100}\/[\w./-]{1,200}@[\w./-]{1,100})$/;
const SHELL = /^[\w {}./-]{1,60}$/;
const MAP_KEY = /^[A-Za-z_][A-Za-z0-9_-]{0,99}$/;
const PERMISSION_SCOPES = new Set([
  "actions",
  "attestations",
  "checks",
  "contents",
  "deployments",
  "id-token",
  "issues",
  "packages",
  "pages",
  "pull-requests",
  "security-events",
  "statuses",
]);
const RESERVED_IDS = new Set<string>(SIMBOX_ORDER);
const STEP_KEYS = new Set([
  "id",
  "name",
  "run",
  "shell",
  "uses",
  "with",
  "env",
  "if",
  "platform",
  "workingDirectory",
  "continueOnError",
  "timeoutMinutes",
]);

function fail(message: string): never {
  throw new Error(message);
}

function stringMap(value: unknown, label: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${label} must be an object of strings.`);
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 50) fail(`${label} has too many entries.`);
  const out: Record<string, string> = {};
  for (const [key, raw] of entries) {
    if (!MAP_KEY.test(key)) fail(`${label} key "${key}" is not a valid name.`);
    if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean")
      fail(`${label}.${key} must be a string, number or boolean.`);
    const text = String(raw);
    if (text.length > 4000) fail(`${label}.${key} is too long.`);
    out[key] = text;
  }
  return entries.length ? out : undefined;
}

function expression(value: string): string {
  const trimmed = value.trim();
  const wrapped = /^\$\{\{([\s\S]*)\}\}$/.exec(trimmed);
  return (wrapped ? wrapped[1]! : trimmed).trim();
}

export function validateUserStep(value: unknown): UserStep {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("A step must be an object.");
  const v = value as Record<string, unknown>;
  const unknown = Object.keys(v).find((key) => !STEP_KEYS.has(key));
  if (unknown) fail(`Unsupported step field "${unknown}".`);
  if (typeof v.id !== "string" || !STEP_ID.test(v.id))
    fail("Step id must be 1–40 lowercase letters, digits, - or _, starting with a letter.");
  if (RESERVED_IDS.has(v.id) || v.id.startsWith("simbox"))
    fail(`Step id "${v.id}" is reserved for Simbox.`);
  if (typeof v.name !== "string" || !NAME.test(v.name.trim()))
    fail(`Step "${v.id}" needs a single-line name (1–100 characters).`);
  const hasRun = v.run !== undefined;
  const hasUses = v.uses !== undefined;
  if (hasRun === hasUses) fail(`Step "${v.id}" needs exactly one of run or uses.`);
  const step: UserStep = { id: v.id, name: v.name.trim() };
  if (hasRun) {
    if (typeof v.run !== "string" || !v.run.trim() || v.run.length > 20_000)
      fail(`Step "${v.id}" run must be a non-empty script up to 20,000 characters.`);
    step.run = v.run;
    if (v.shell !== undefined) {
      if (typeof v.shell !== "string" || !SHELL.test(v.shell))
        fail(`Step "${v.id}" shell is invalid.`);
      step.shell = v.shell;
    }
    if (v.with !== undefined) fail(`Step "${v.id}" uses run, so it cannot take with inputs.`);
  } else {
    if (typeof v.uses !== "string" || !USES.test(v.uses))
      fail(`Step "${v.id}" uses must look like owner/repo@ref, ./path or docker://image.`);
    if (v.shell !== undefined) fail(`Step "${v.id}" uses an action, so it cannot set shell.`);
    step.uses = v.uses;
    const inputs = stringMap(v.with, `Step "${v.id}" with`);
    if (inputs) step.with = inputs;
  }
  const env = stringMap(v.env, `Step "${v.id}" env`);
  if (env) step.env = env;
  if (v.if !== undefined) {
    if (typeof v.if !== "string" || !expression(v.if) || v.if.length > 1000)
      fail(`Step "${v.id}" if must be a non-empty expression.`);
    step.if = expression(v.if);
  }
  if (v.platform !== undefined) {
    if (v.platform !== "ios" && v.platform !== "android")
      fail(`Step "${v.id}" platform must be ios or android (omit it for both).`);
    step.platform = v.platform;
  }
  if (v.workingDirectory !== undefined) {
    if (typeof v.workingDirectory !== "string" || !/^[\w./${}\s-]{1,200}$/.test(v.workingDirectory))
      fail(`Step "${v.id}" workingDirectory is invalid.`);
    step.workingDirectory = v.workingDirectory;
  }
  if (v.continueOnError !== undefined) {
    if (typeof v.continueOnError !== "boolean")
      fail(`Step "${v.id}" continueOnError must be boolean.`);
    if (v.continueOnError) step.continueOnError = true;
  }
  if (v.timeoutMinutes !== undefined) {
    if (
      typeof v.timeoutMinutes !== "number" ||
      !Number.isInteger(v.timeoutMinutes) ||
      v.timeoutMinutes < 1 ||
      v.timeoutMinutes > 360
    )
      fail(`Step "${v.id}" timeoutMinutes must be a whole number from 1 to 360.`);
    step.timeoutMinutes = v.timeoutMinutes;
  }
  return step;
}

/** Locked steps present once each, in order; user step ids unique. */
export function validateWorkflowSpec(value: unknown): WorkflowSpec {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Expected {steps: [...]}.");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((key) => key !== "steps" && key !== "permissions"))
    fail("A workflow only has steps and permissions.");
  if (!Array.isArray(v.steps)) fail("steps must be an array.");
  const steps: WorkflowStep[] = [];
  const seen = new Set<string>();
  const locked: SimboxStepKey[] = [];
  for (const raw of v.steps) {
    if (raw && typeof raw === "object" && "simbox" in raw) {
      const key = (raw as { simbox: unknown }).simbox;
      if (Object.keys(raw).length !== 1 || !SIMBOX_ORDER.includes(key as SimboxStepKey))
        fail("Locked steps are {simbox: prepare|start|serve} and cannot be edited.");
      locked.push(key as SimboxStepKey);
      steps.push({ simbox: key as SimboxStepKey });
      continue;
    }
    const step = validateUserStep(raw);
    if (seen.has(step.id)) fail(`Duplicate step id "${step.id}".`);
    seen.add(step.id);
    steps.push(step);
  }
  if (locked.join() !== SIMBOX_ORDER.join())
    fail("The Simbox steps prepare, start and serve must each appear once, in that order.");
  if (seen.size > MAX_USER_STEPS) fail(`Use at most ${MAX_USER_STEPS} custom steps.`);
  const spec: WorkflowSpec = { steps };
  if (v.permissions !== undefined) {
    if (!v.permissions || typeof v.permissions !== "object" || Array.isArray(v.permissions))
      fail("permissions must map scopes to read, write or none.");
    const permissions: Record<string, PermissionLevel> = {};
    for (const [scope, level] of Object.entries(v.permissions as Record<string, unknown>)) {
      if (!PERMISSION_SCOPES.has(scope)) fail(`Unknown permission scope "${scope}".`);
      if (level !== "read" && level !== "write" && level !== "none")
        fail(`Permission ${scope} must be read, write or none.`);
      permissions[scope] = level;
    }
    if (Object.keys(permissions).length) spec.permissions = permissions;
  }
  if (renderWorkflow(spec).length > 256_000) fail("The workflow is too large.");
  return spec;
}

// ---------------------------------------------------------------------------
// Editing (pure; each returns a new validated spec)
// ---------------------------------------------------------------------------

function indexOf(spec: WorkflowSpec, id: string): number {
  const index = spec.steps.findIndex((step) => stepId(step) === id);
  if (index < 0) fail(`No step "${id}". Steps: ${spec.steps.map(stepId).join(", ")}.`);
  return index;
}

function targetIndex(spec: WorkflowSpec, position: StepPosition): number {
  return "before" in position ? indexOf(spec, position.before) : indexOf(spec, position.after) + 1;
}

export function insertStep(
  spec: WorkflowSpec,
  step: UserStep,
  position: StepPosition,
): WorkflowSpec {
  const steps = [...spec.steps];
  steps.splice(targetIndex(spec, position), 0, step);
  return validateWorkflowSpec({ ...spec, steps });
}

export function removeStep(spec: WorkflowSpec, id: string): WorkflowSpec {
  const index = indexOf(spec, id);
  if (isLockedStep(spec.steps[index]!)) fail(`"${id}" is a locked Simbox step.`);
  return validateWorkflowSpec({ ...spec, steps: spec.steps.filter((_, i) => i !== index) });
}

export function moveStep(spec: WorkflowSpec, id: string, position: StepPosition): WorkflowSpec {
  const index = indexOf(spec, id);
  const step = spec.steps[index]!;
  if (isLockedStep(step)) fail(`"${id}" is a locked Simbox step and cannot move.`);
  const without = { ...spec, steps: spec.steps.filter((_, i) => i !== index) };
  return insertStep(without, step, position);
}

export function replaceStep(spec: WorkflowSpec, id: string, step: UserStep): WorkflowSpec {
  const index = indexOf(spec, id);
  if (isLockedStep(spec.steps[index]!)) fail(`"${id}" is a locked Simbox step.`);
  return validateWorkflowSpec({
    ...spec,
    steps: spec.steps.map((current, i) => (i === index ? step : current)),
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** A YAML scalar: literal block for multi-line scripts, JSON-quoted otherwise. */
function scalar(value: string, indent: string): string {
  const lines = value.replace(/\r\n?/g, "\n").split("\n");
  const blockable =
    lines.length > 1 &&
    !/^\s/.test(lines[0]!) &&
    // oxlint-disable-next-line no-control-regex -- control characters force a quoted scalar
    lines.every((line) => !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(line));
  if (!blockable) return JSON.stringify(value);
  let body = value.replace(/\r\n?/g, "\n");
  const trailing = /\n*$/.exec(body)![0].length;
  const chomp = trailing === 0 ? "-" : trailing === 1 ? "" : "+";
  body = body.replace(/\n+$/, "");
  const rendered = body
    .split("\n")
    .map((line) => (line ? `${indent}${line}` : ""))
    .join("\n");
  return `|${chomp}\n${rendered}${"\n".repeat(Math.max(0, trailing - 1))}`;
}

function condition(step: UserStep): string | null {
  const platform = step.platform ? `inputs.platform == '${step.platform}'` : null;
  if (platform && step.if) return `\${{ ${platform} && (${step.if}) }}`;
  if (platform) return `\${{ ${platform} }}`;
  return step.if ? `\${{ ${step.if} }}` : null;
}

function renderUserStep(step: UserStep): string[] {
  const out = [`      - id: ${step.id}`, `        name: ${JSON.stringify(step.name)}`];
  const when = condition(step);
  if (when) out.push(`        if: ${JSON.stringify(when)}`);
  if (step.workingDirectory)
    out.push(`        working-directory: ${JSON.stringify(step.workingDirectory)}`);
  if (step.continueOnError) out.push("        continue-on-error: true");
  if (step.timeoutMinutes) out.push(`        timeout-minutes: ${step.timeoutMinutes}`);
  if (step.uses) out.push(`        uses: ${JSON.stringify(step.uses)}`);
  if (step.with) {
    out.push("        with:");
    for (const [key, value] of Object.entries(step.with))
      out.push(`          ${key}: ${scalar(value, "            ")}`);
  }
  if (step.env) {
    out.push("        env:");
    for (const [key, value] of Object.entries(step.env))
      out.push(`          ${key}: ${scalar(value, "            ")}`);
  }
  if (step.shell) out.push(`        shell: ${JSON.stringify(step.shell)}`);
  if (step.run !== undefined) out.push(`        run: ${scalar(step.run, "          ")}`);
  return out;
}

function renderLockedStep(key: SimboxStepKey): string[] {
  const out = [
    `      - id: simbox_${key}`,
    `        name: ${SIMBOX_STEPS[key].name}`,
    `        uses: ${RUNNER_ACTION}`,
    "        with:",
    `          step: ${key}`,
    "          platform: ${{ inputs.platform }}",
  ];
  if (key === "start")
    out.push(
      "          token: ${{ secrets.SIMBOX_TOKEN }}",
      "          run_id: ${{ inputs.simbox_run }}",
    );
  return out;
}

export function renderWorkflow(spec: WorkflowSpec): string {
  const permissions: Record<string, PermissionLevel> = { contents: "read", ...spec.permissions };
  const header = [
    `${MARKER} ${WORKFLOW_SCHEMA_VERSION}`,
    "# Managed by Simbox. Edit steps in the dashboard or with `simbox workflow`;",
    "# direct edits are replaced the next time Simbox saves or repairs this file.",
    "name: simbox",
    'run-name: "simbox ${{ inputs.platform }} ${{ inputs.simbox_run }}"',
    "",
    "on:",
    "  workflow_dispatch:",
    "    inputs:",
    "      platform:",
    "        type: choice",
    "        options: [ios, android]",
    "        default: ios",
    "        description: Device platform (Android uses Linux/KVM)",
    "      runner_labels:",
    "        type: string",
    '        default: ""',
    "        description: JSON array of runner labels (empty uses platform default)",
    "      simbox_run:",
    "        type: string",
    '        default: ""',
    "        description: Run id assigned by Simbox (empty for manual runs)",
    "",
    "permissions:",
    ...Object.entries(permissions).map(([scope, level]) => `  ${scope}: ${level}`),
    "",
    "jobs:",
    "  simbox:",
    "    runs-on: ${{ fromJSON(inputs.runner_labels || (inputs.platform == 'android' && '[\"ubuntu-latest\"]' || '[\"macos-latest\"]')) }}",
    "    timeout-minutes: 360",
    "    steps:",
  ];
  const steps = spec.steps.flatMap((step) =>
    isLockedStep(step) ? renderLockedStep(step.simbox) : renderUserStep(step),
  );
  return `${[...header, ...steps].join("\n")}\n`;
}

/** The canonical workflow with no custom steps. */
export const WORKFLOW_YAML = renderWorkflow(defaultWorkflowSpec());

/** Schema version a committed workflow declares; 1 for files from before the marker. */
export function workflowVersion(yaml: string): number {
  const match = new RegExp(`^${MARKER}\\s*(\\d+)`, "m").exec(yaml);
  return match ? Number(match[1]) : 1;
}

/** How the committed file relates to what Simbox would render for this spec. */
export function workflowStatus(committed: string | null, spec: WorkflowSpec): WorkflowStatus {
  if (committed === null) return "missing";
  const normalized = committed.replace(/\r\n?/g, "\n");
  if (normalized === renderWorkflow(spec)) return "current";
  return workflowVersion(normalized) < WORKFLOW_SCHEMA_VERSION ? "outdated" : "drifted";
}

/** A free step id derived from a name: "Build app" → "build-app", "build-app-2", … */
export function suggestStepId(spec: WorkflowSpec, name: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/^(?![a-z])/, "step-")
      .slice(0, 34)
      .replace(/^simbox/, "step") || "step";
  const taken = new Set(spec.steps.map(stepId));
  if (!taken.has(base) && !RESERVED_IDS.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}
