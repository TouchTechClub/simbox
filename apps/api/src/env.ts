/** Worker bindings + vars/secrets (see wrangler.toml / .dev.vars.example). */
export interface Env {
  DB: D1Database;
  KV: KVNamespace;

  GITHUB_APP_ID: string;
  /** PEM-encoded RSA private key for the GitHub App (secret). */
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;
  /** OAuth credentials for the GitHub App's "identify users" flow (better-auth github provider). */
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  /** Secret used by better-auth to sign session tokens/cookies. */
  BETTER_AUTH_SECRET: string;
  /** Public origin of this API — better-auth baseURL (OAuth callback root). */
  API_URL: string;
  /** Web app origin — used for CORS, OAuth redirects and CLI device verify URLs. */
  APP_URL: string;
  /** Cloudflare account that owns runner tunnels. */
  CLOUDFLARE_ACCOUNT_ID?: string;
  /**
   * Token with Account › Cloudflare Tunnel: Edit and, on TUNNEL_ZONE,
   * Zone: Read + DNS: Edit. Unset → runners fall back to quick tunnels.
   */
  CLOUDFLARE_TUNNEL_API_TOKEN?: string;
  /** Zone runner hostnames live directly under (free Universal SSL covers one level). */
  TUNNEL_ZONE?: string;
  /** Dev-only: "true" bypasses user auth and serves seeded demo data. */
  DEMO_MODE?: string;
}
