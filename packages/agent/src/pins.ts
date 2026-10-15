/**
 * Pinned versions of everything the agent downloads at runtime.
 * Bump these (via action-src/release.sh) when cutting a new agent release.
 */
export const PINS = {
  /** npm package `agent-device` — installed via `npm i -g agent-device@<pin>`. */
  agentDevice: "0.21.28",
  /** Same screen-streaming backend as T3 Code's device panel. */
  deviceHub: "0.12.0",
  /** cloudflared GitHub release tag — https://github.com/cloudflare/cloudflared/releases */
  cloudflared: "2026.9.1",
  /** Android SDK system image + platform installed for the emulator AVD (Android 17). */
  androidSystemImage: "system-images;android-37.0;google_apis;arm64-v8a",
  androidPlatform: "platforms;android-37.0",
} as const;
