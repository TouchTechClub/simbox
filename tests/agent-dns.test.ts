import { expect, test } from "bun:test";
import { waitForAuthoritativeDns } from "../packages/agent/src/dns";

const result = (stdout: string, code = 0) => ({ code, stdout, stderr: "" });

test("a named hostname is registered only once every zone nameserver serves it", async () => {
  const calls: string[][] = [];
  let polls = 0;
  const run = (async (cmd: string[]) => {
    calls.push(cmd);
    if (cmd.includes("NS")) return result("hal.ns.cloudflare.com.\ndaisy.ns.cloudflare.com.\n");
    // The second nameserver only starts serving the record on the second poll.
    if (cmd.at(-1) === "@daisy.ns.cloudflare.com" && polls++ < 1) return result("");
    return result("104.21.18.190\n172.67.183.36\n");
  }) as never;
  const ok = await waitForAuthoritativeDns("r-0123456789abcdef.simboxtouchtech.dpdns.org", {
    run,
    pollMs: 1,
    graceMs: 1,
  });
  expect(ok).toBe("served");
  expect(calls[0]).toEqual(["dig", "+short", "NS", "simboxtouchtech.dpdns.org"]);
  const queries = calls.filter((cmd) => cmd.includes("+norecurse"));
  expect(queries).toHaveLength(4);
  expect(queries.every((cmd) => cmd.includes("r-0123456789abcdef.simboxtouchtech.dpdns.org"))).toBe(
    true,
  );
});

test("a hostname that never appears is reported; an unrunnable check is unverified, never fatal", async () => {
  const never = (async (cmd: string[]) =>
    cmd.includes("NS") ? result("hal.ns.cloudflare.com.\n") : result("")) as never;
  expect(
    await waitForAuthoritativeDns("r-0123456789abcdef.simboxtouchtech.dpdns.org", {
      run: never,
      timeoutMs: 20,
      pollMs: 5,
      graceMs: 1,
    }),
  ).toBe("missing");
  const noZone = (async () => result("", 9)) as never;
  expect(await waitForAuthoritativeDns("r-x.example.org", { run: noZone })).toBe("unverified");
  const noDig = (async () => {
    throw Object.assign(new Error("spawn dig ENOENT"), { code: "ENOENT" });
  }) as never;
  expect(await waitForAuthoritativeDns("r-x.example.org", { run: noDig })).toBe("unverified");
});
