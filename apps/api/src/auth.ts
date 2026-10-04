import { betterAuth } from "better-auth";
import { bearer, deviceAuthorization } from "better-auth/plugins";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createDb, schema } from "@simbox/db";
import type { Env } from "./env";

/**
 * better-auth instance factory. Workers get bindings per-request via `c.env`,
 * so the auth object can't be a module-level singleton — build one per request
 * (cheap: the adapter just wraps env.DB in a drizzle D1 instance).
 *
 * Tables live in the same D1 database (drizzle schema @simbox/db):
 *   user, session, account, verification, device_code
 */
export function createAuth(env: Env) {
  const db = createDb(env);
  return betterAuth({
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema,
    }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.API_URL,
    trustedOrigins: [env.APP_URL],
    telemetry: { enabled: false },
    socialProviders: {
      github: {
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
        // Stash the GitHub login on user.login (additional field) — the
        // default `name` column gets GitHub's display name, not the handle.
        // GitHub Apps can't use the user:email scope; if the app lacks the
        // Email addresses permission (or the user hides all emails), both
        // /user and /user/emails come back empty → email_not_found. Fall back
        // to the noreply address so sign-in always succeeds.
        mapProfileToUser: (profile) => ({
          login: profile.login,
          email: profile.email ?? `${profile.id}+${profile.login}@users.noreply.github.com`,
        }),
      },
    },
    user: {
      additionalFields: {
        login: { type: "string" },
      },
    },
    plugins: [
      deviceAuthorization({
        verificationUri: `${env.APP_URL}/device`,
        expiresIn: "10m",
        interval: "3s",
        validateClient: (id) => id === "simbox-cli",
      }),
      // Lets the CLI call /v1/* with `Authorization: Bearer <access_token>`
      // — the device/token endpoint issues a session token, and this hook
      // translates it into the session cookie for getSession.
      bearer(),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
