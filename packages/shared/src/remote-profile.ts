/**
 * The agent-device remote profile for a run, in the shape Simlock writes for
 * its own host (`~/.simlock/agent-device-profile.json`). Simlock's front only
 * admits tenant-scoped sessions that hold a lease, and agent-device allocates
 * that lease itself only from a profile with `leaseProvider: "proxy"`; the
 * per-command URL and token flags alone are refused.
 */
export interface RemoteProfile {
  clientId: string;
  daemonAuthToken: string;
  daemonBaseUrl: string;
  daemonTransport: "http";
  leaseProvider: "proxy";
  runId: string;
  sessionIsolation: "tenant";
  tenant: string;
}

/** The run's Simlock daemon serves agent-device here. */
export function agentDeviceBaseUrl(tunnelUrl: string): string {
  return `${tunnelUrl.replace(/\/+$/, "")}/v1/agent-device`;
}

export function remoteProfile(run: {
  runId: string;
  tunnelUrl: string;
  daemonToken: string;
}): RemoteProfile {
  return {
    // agent-device refuses a proxy open without a client id; a constant keeps the file stable.
    clientId: "51b0c51b0c51b0c5",
    daemonAuthToken: run.daemonToken,
    daemonBaseUrl: agentDeviceBaseUrl(run.tunnelUrl),
    daemonTransport: "http",
    leaseProvider: "proxy",
    runId: run.runId,
    sessionIsolation: "tenant",
    tenant: "simbox",
  };
}
