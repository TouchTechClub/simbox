import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { PROD_API_URL } from "@simbox/shared";

const DEFAULT_WEB_URL = "https://simbox.touchtech.club";

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export function apiBaseUrl(): string {
  return stripTrailingSlash(process.env.SIMBOX_API_URL ?? PROD_API_URL);
}

export function webBaseUrl(): string {
  return stripTrailingSlash(process.env.SIMBOX_WEB_URL ?? DEFAULT_WEB_URL);
}

export function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.length > 0) return join(xdg, "simbox");
  return join(homedir(), ".config", "simbox");
}

export function authPath(): string {
  return join(configDir(), "auth.json");
}

interface AuthFile {
  token: string;
  login?: string;
  createdAt?: number;
}

export function loadToken(): string | null {
  try {
    const raw = readFileSync(authPath(), "utf8");
    const parsed = JSON.parse(raw) as AuthFile;
    if (typeof parsed.token === "string" && parsed.token.length > 0) {
      return parsed.token;
    }
    return null;
  } catch {
    return null;
  }
}

export function saveToken(token: string, login: string): void {
  mkdirSync(configDir(), { recursive: true });
  const data: AuthFile = { token, login, createdAt: Date.now() };
  writeFileSync(authPath(), JSON.stringify(data, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  // mode on writeFileSync only applies to new files; enforce on existing too.
  try {
    chmodSync(authPath(), 0o600);
  } catch {
    if (platform() === "win32") return; // chmod is a no-op concept on Windows
  }
}

export function requireToken(): string {
  const token = loadToken();
  if (!token) {
    process.stderr.write("Not logged in. Run `simbox login` first.\n");
    process.exit(1);
  }
  return token;
}
