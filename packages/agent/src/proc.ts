/**
 * Process helpers: short-lived command runner (`run`), line-pumping for
 * long-lived children (`pumpLines`), and a managed-child wrapper that
 * signals the supervision loop on exit.
 */
import { relay } from "./log.js";

/** Spawned child process type — long-lived children are piped on stdout/stderr. */
export type ChildProc = Bun.Subprocess<"ignore", "pipe", "pipe">;

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** Bytes written to the child's stdin, then stdin is closed. */
  input?: string;
  /** Kill after this many ms. */
  timeoutMs?: number;
  /** Cancel optional setup work during runner shutdown. */
  signal?: AbortSignal;
}

/** Run a command to completion, capturing output. Never throws on non-zero exit. */
export async function run(cmd: string[], opts: RunOptions = {}): Promise<RunResult> {
  opts.signal?.throwIfAborted();
  const proc = Bun.spawn(cmd, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...Bun.env },
  });
  const stdin = proc.stdin;
  if (stdin && typeof stdin === "object" && "write" in stdin) {
    if (opts.input) void stdin.write(opts.input);
    void stdin.end();
  }
  let timedOut = false;
  const cancel = () => {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already dead */
    }
  };
  opts.signal?.addEventListener("abort", cancel, { once: true });
  const killer =
    opts.timeoutMs !== undefined
      ? setTimeout(() => {
          timedOut = true;
          try {
            proc.kill("SIGKILL");
          } catch {
            /* already dead */
          }
        }, opts.timeoutMs)
      : null;
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code: timedOut || opts.signal?.aborted ? -1 : code, stdout, stderr };
  } finally {
    if (killer) clearTimeout(killer);
    opts.signal?.removeEventListener("abort", cancel);
  }
}

/** Locate an executable on PATH (`command -v` equivalent). Returns null if absent. */
export async function which(bin: string): Promise<string | null> {
  const res = await run(["/bin/sh", "-c", `command -v ${JSON.stringify(bin)}`]);
  const path = res.stdout.trim();
  return res.code === 0 && path.length > 0 ? path : null;
}

/** Default suppression filter — overridden by callers with real secrets. */
let suppressLine: (line: string) => boolean = () => false;
export function setSecretFilter(fn: (line: string) => boolean): void {
  suppressLine = fn;
}

/**
 * Stream a child's stdout/stderr into the GH log line-by-line.
 * Lines matching the secret filter are dropped entirely.
 * `onLine` is invoked only for non-secret lines.
 */
export function pumpLines(
  stream: ReadableStream<Uint8Array>,
  prefix: string,
  onLine?: (line: string) => void,
): void {
  void (async () => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, idx).replace(/\r$/, "");
          buf = buf.slice(idx + 1);
          // onLine always fires (callers parse e.g. the tunnel URL out of
          // a line we must not relay); relay is suppressed for secret lines.
          onLine?.(line);
          if (!suppressLine(line)) relay(prefix, line);
        }
      }
      buf += decoder.decode();
      const tail = buf.trimEnd();
      if (tail.length > 0) {
        onLine?.(tail);
        if (!suppressLine(tail)) relay(prefix, tail);
      }
    } catch {
      /* stream closed / process died — nothing to relay */
    }
  })();
}
