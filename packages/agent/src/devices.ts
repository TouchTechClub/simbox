/** Count real sessions, not the idle simulator prewarmed by the agent. */
export function sessionDeviceCount(body: unknown): number | null {
  const rpc = body as {
    result?: {
      ok?: boolean;
      data?: { sessions?: Array<{ platform?: string; id?: string; device_id?: string }> };
    };
  } | null;
  if (rpc?.result?.ok !== true || !Array.isArray(rpc.result.data?.sessions)) return null;
  const ids = new Set<string>();
  for (const session of rpc.result.data.sessions) {
    const id = session?.device_id ?? session?.id;
    if (typeof id !== "string" || !id) return null;
    ids.add(`${session.platform ?? "unknown"}:${id}`);
  }
  return ids.size;
}

export async function countActiveDevices(port: number, token: string): Promise<number | null> {
  try {
    // Bypass the activity gateway: this supervisor probe must not reset idle.
    const response = await fetch(`http://127.0.0.1:${port}/agent-device/rpc`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "simbox-inventory",
        method: "agent_device.command",
        params: { command: "session_list", session: "default", flags: {} },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    return sessionDeviceCount(await response.json());
  } catch {
    return null;
  }
}
