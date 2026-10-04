/**
 * Pinned versions of everything the agent downloads at runtime.
 * Bump these (via action-src/release.sh) when cutting a new agent release.
 */
export const PINS = {
  /** npm package `agent-device` — installed via `npm i -g agent-device@<pin>`. */
  agentDevice: "0.21.20",
  /** cloudflared GitHub release tag — https://github.com/cloudflare/cloudflared/releases */
  cloudflared: "2026.9.1",
  /** Android SDK system image + platform installed for the emulator AVD. */
  androidSystemImage: "system-images;android-34;google_apis;arm64-v8a",
  androidPlatform: "platforms;android-34",
} as const;
