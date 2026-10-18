import pc from "picocolors";

export const isTTY = process.stderr.isTTY === true;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

/** Human countdown like "4h 12m" / "9m 30s" from an epoch-ms timestamp. */
export function fmtCountdown(expiresAt: number): string {
  const ms = expiresAt - Date.now();
  if (ms <= 0) return "expired";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/** "3 hours ago" from epoch ms (epoch seconds are accepted too). */
export function fmtAgo(at: number, now = Date.now()): string {
  const ms = now - (at < 1e12 ? at * 1000 : at);
  const s = Math.max(0, Math.floor(ms / 1000));
  const unit = (n: number, name: string) => `${n} ${name}${n === 1 ? "" : "s"} ago`;
  if (s < 60) return "just now";
  if (s < 3600) return unit(Math.floor(s / 60), "minute");
  if (s < 86_400) return unit(Math.floor(s / 3600), "hour");
  return unit(Math.floor(s / 86_400), "day");
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Minimal status line. TTY: animated spinner on stderr, re-rendered in place.
 * Non-TTY: prints a line only when the message changes.
 */
export class Spinner {
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastMsg = "";
  private start = Date.now();

  constructor(private label: string) {}

  begin(): void {
    this.start = Date.now();
    if (!isTTY) {
      process.stderr.write(`${this.label}\n`);
      this.lastMsg = this.label;
      return;
    }
    this.render();
    this.timer = setInterval(() => this.render(), 80);
  }

  set(label: string): void {
    if (label === this.label) return;
    this.label = label;
    if (!isTTY) {
      process.stderr.write(`${label}\n`);
      this.lastMsg = label;
      return;
    }
    this.render();
  }

  private render(): void {
    const glyph = FRAMES[this.frame++ % FRAMES.length] ?? "⠋";
    const elapsed = pc.dim(`(${fmtElapsed(Date.now() - this.start)})`);
    this.clearLine();
    process.stderr.write(`${pc.cyan(glyph)} ${this.label} ${elapsed}`);
  }

  private clearLine(): void {
    if (isTTY) process.stderr.write("\r\x1b[K");
  }

  /** Stop without printing a result symbol. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.clearLine();
  }

  succeed(msg: string): void {
    this.finish(pc.green("✔"), msg);
  }

  fail(msg: string): void {
    this.finish(pc.red("✖"), msg);
  }

  private finish(symbol: string, msg: string): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.clearLine();
    const elapsed = pc.dim(`(${fmtElapsed(Date.now() - this.start)})`);
    process.stderr.write(`${symbol} ${msg} ${elapsed}\n`);
  }
}
