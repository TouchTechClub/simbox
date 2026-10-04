export function healthyProxy(status: number, body: unknown): boolean {
  if (status < 200 || status >= 300 || !body || typeof body !== "object") return false;
  const health = body as { ok?: boolean; upstream?: { ok?: boolean } };
  return health.ok === true && health.upstream?.ok !== false;
}

export async function waitForProxy(url: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastFailure = "no response";
  do {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(Math.min(10_000, Math.max(1, deadline - Date.now()))),
      });
      if (!res.ok) {
        lastFailure = `HTTP ${res.status}`;
      } else {
        const body = await res.json();
        if (healthyProxy(res.status, body)) return;
        lastFailure = "unhealthy proxy/upstream";
      }
    } catch (error) {
      // Error names are diagnostic without exposing secret tunnel URLs.
      lastFailure = error instanceof Error ? error.name : "network error";
      // Startup/DNS propagation is retried, not treated as an established
      // tunnel failure. The caller applies its fatal policy after the budget.
    }
    await Bun.sleep(1000);
  } while (Date.now() < deadline);
  throw new Error(`proxy/tunnel did not become healthy within the startup budget (${lastFailure})`);
}
