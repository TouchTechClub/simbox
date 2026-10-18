import { run as runCommand } from "./proc.js";

type Run = typeof runCommand;

/**
 * Wait until a fresh named-tunnel hostname is served by its zone's own
 * nameservers. A client resolving it any earlier gets NXDOMAIN, which
 * resolvers then cache for the zone's negative TTL (30 minutes on
 * Cloudflare), leaving the run unreachable from that machine. Authoritative
 * servers do not cache, so polling them is safe; the run's URL is registered
 * only afterwards. Resolves "served" once every nameserver answers, "missing"
 * if the record never appeared within the deadline, and "unverified" when the
 * check itself cannot run (no `dig`, no nameservers) — never a run failure.
 */
export async function waitForAuthoritativeDns(
  hostname: string,
  options: { timeoutMs?: number; pollMs?: number; graceMs?: number; run?: Run } = {},
): Promise<"served" | "missing" | "unverified"> {
  try {
    return (await poll(hostname, options)) ? "served" : "missing";
  } catch {
    return "unverified";
  }
}

async function poll(
  hostname: string,
  options: { timeoutMs?: number; pollMs?: number; graceMs?: number; run?: Run },
): Promise<boolean> {
  const run = options.run ?? runCommand;
  const zone = hostname.slice(hostname.indexOf(".") + 1);
  const ns = await run(["dig", "+short", "NS", zone], { timeoutMs: 10_000 });
  const servers = ns.stdout
    .split("\n")
    .map((line) => line.trim().replace(/\.$/, ""))
    .filter((line) => /^[a-z0-9.-]+$/i.test(line));
  if (ns.code !== 0 || servers.length === 0) throw new Error("no nameservers");
  const deadline = Date.now() + (options.timeoutMs ?? 90_000);
  while (Date.now() < deadline) {
    const answers = await Promise.all(
      servers.map((server) =>
        run(["dig", "+short", "+norecurse", "A", hostname, `@${server}`], { timeoutMs: 5_000 }),
      ),
    );
    if (answers.every((a) => a.code === 0 && /^\d+\.\d+\.\d+\.\d+$/m.test(a.stdout))) {
      // Anycast nameservers in other regions can lag the nearest one briefly.
      await Bun.sleep(options.graceMs ?? 5_000);
      return true;
    }
    await Bun.sleep(options.pollMs ?? 2_000);
  }
  return false;
}
