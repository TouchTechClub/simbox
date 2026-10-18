/**
 * Staged mode: the action's `start` step launches the agent in the background
 * with SIMBOX_STAGE_DIR and returns once devices are booted (`ready`), so user
 * steps can install apps before anything is reachable. The `serve` step then
 * writes `go`; only after that does the agent open its tunnel and register.
 * The action reads `exit-code` to finish `serve` with the agent's result.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Stage {
  /** False for the legacy single-step action: nothing is written or awaited. */
  readonly staged: boolean;
  /** Devices are prepared; the `start` step may finish. */
  markReady(): void;
  /** Resolves once `serve` has started. `check` runs every poll (signals, hard exit). */
  waitForGo(options?: { pollMs?: number; check?: () => Promise<void> | void }): Promise<void>;
  /** Must run on every exit path before `process.exit`. */
  recordExit(code: number): void;
}

export function createStage(dir: string | undefined): Stage {
  const write = (name: string, body: string) => {
    if (!dir) return;
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), body);
    } catch {
      /* the action then reports a missing exit code as a failure */
    }
  };
  return {
    staged: !!dir,
    markReady: () => write("ready", `${Date.now()}\n`),
    async waitForGo(options = {}) {
      if (!dir) return;
      while (!existsSync(join(dir, "go"))) {
        await options.check?.();
        await Bun.sleep(options.pollMs ?? 1000);
      }
    },
    recordExit: (code) => write("exit-code", `${code}\n`),
  };
}

/**
 * When the job started, for the hard-exit clock: SIMBOX_JOB_STARTED_AT (unix
 * seconds, written by the prepare step) when sane, else `fallback` (agent boot).
 * User steps before `serve` spend the same six-hour job budget.
 */
export function jobStartedAt(value: string | undefined, fallback: number): number {
  const seconds = Number(value);
  if (!value || !Number.isFinite(seconds) || seconds <= 0) return fallback;
  const ms = seconds * 1000;
  return ms <= fallback ? ms : fallback;
}
