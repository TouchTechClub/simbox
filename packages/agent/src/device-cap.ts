/**
 * A runner runs at most `cap` devices at once: one on small runners, whose 3
 * vCPUs a second simulator saturates. Devices with an agent-device session or
 * an open viewer are in use and never stopped. Above the cap, idle devices
 * are shut down, oldest first; a just-booted one is spared for a short grace
 * period, since a session or viewer usually attaches right after the boot.
 */
export function devicesOverCap(options: {
  booted: Array<{ id: string; since: number }>;
  inUse: ReadonlySet<string>;
  cap: number;
  now: number;
  graceMs?: number;
}): string[] {
  const { booted, inUse, cap, now } = options;
  const grace = options.graceMs ?? 120_000;
  let excess = booted.length - cap;
  if (excess <= 0) return [];
  const victims: string[] = [];
  const idle = booted
    .filter((device) => !inUse.has(device.id) && now - device.since >= grace)
    .sort((a, b) => a.since - b.since);
  for (const device of idle) {
    if (excess-- <= 0) break;
    victims.push(device.id);
  }
  return victims;
}

/**
 * Why booting `target` would exceed the cap, or null when it fits. Idle
 * devices do not count: the cap loop shuts them down once the new one boots.
 */
export function bootRefusal(options: {
  target: string | null;
  booted: ReadonlySet<string>;
  inUse: ReadonlySet<string>;
  cap: number;
}): string | null {
  const { target, booted, inUse, cap } = options;
  if (target && booted.has(target)) return null;
  const busy = [...inUse].filter((id) => booted.has(id) && id !== target).length;
  if (busy < cap) return null;
  const devices = `${cap} device${cap === 1 ? "" : "s"}`;
  return `This runner runs ${devices} at a time and ${busy === 1 ? "one is" : `${busy} are`} in use. Close that device's session, or start another runner with \`simbox sim --new --platform ios\`.`;
}

/** The device a hub boot request names, if any. */
export function bootTarget(search: URLSearchParams, body: string | undefined): string | null {
  const query = search.get("udid") ?? search.get("device") ?? search.get("id");
  if (query) return query;
  try {
    const parsed = JSON.parse(body ?? "") as Record<string, unknown>;
    for (const key of ["udid", "device", "deviceId", "id", "serial"])
      if (typeof parsed[key] === "string") return parsed[key] as string;
  } catch {
    /* not JSON */
  }
  return null;
}
