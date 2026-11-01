/**
 * Pinned versions of everything the agent downloads at runtime.
 * Bump these (via action-src/release.sh) when cutting a new agent release,
 * after an end-to-end run on both platforms: Simlock moves fast.
 */
export const PINS = {
  /** npm package `simlock`: the runner's standalone device daemon. */
  simlock: "0.4.0",
  /** npm package `agent-device`; Simlock serves it at `/v1/agent-device`. */
  agentDevice: "0.21.35",
  /** cloudflared GitHub release tag — https://github.com/cloudflare/cloudflared/releases */
  cloudflared: "2026.9.1",
  /**
   * Default Android system image; the ABI follows the host. API 35 is what the
   * Simlock spike verified on hosted runners.
   */
  androidSystemImage: "system-images;android-35;google_apis;x86_64",
} as const;
