import { createHash } from "node:crypto";

/**
 * Who is calling: an agent thread or session, so each keeps its own run while
 * other agents get theirs. Hashed, so the raw ids never leave this machine.
 * Undefined in a plain terminal: such callers share one run.
 */
export function holderId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = [env.SIMBOX_HOLDER, env.T3CODE_THREAD_ID, env.CLAUDE_CODE_SESSION_ID]
    .map((value) => value?.trim())
    .find((value) => value);
  return raw ? createHash("sha256").update(raw).digest("hex").slice(0, 32) : undefined;
}

/** `SIMBOX_RUN=<id>` pins every command to one run. */
export function pinnedRunId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.SIMBOX_RUN?.trim() || undefined;
}
