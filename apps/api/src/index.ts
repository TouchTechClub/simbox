import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppContext } from "./middleware";
import { createAuth } from "./auth";
import { authRoutes } from "./routes/auth";
import { repoRoutes } from "./routes/repo";
import { runRoutes } from "./routes/runs";
import { runnerRoutes } from "./routes/runners";
import { previewRoutes } from "./routes/preview";
import { webhookRoutes } from "./routes/webhooks";

const app = new Hono<AppContext>();

// The web app calls both /api/auth/* (better-auth: social sign-in, session,
// device approve/deny) and /v1/* cross-origin with cookies → credentialed CORS
// restricted to APP_URL.
const credentialedCors = cors({
  origin: (origin, c) => (origin && origin === c.env.APP_URL ? origin : null),
  credentials: true,
});
app.use("/api/auth/*", credentialedCors);
app.use("/v1/*", credentialedCors);

// better-auth handles /api/auth/* — mounted before the app routes.
app.on(["POST", "GET"], "/api/auth/*", (c) => createAuth(c.env).handler(c.req.raw));

app.get("/healthz", (c) => c.json({ ok: true }));

app.route("/", authRoutes);
app.route("/", repoRoutes);
app.route("/", runRoutes);
app.route("/", runnerRoutes);
app.route("/", previewRoutes);
app.route("/", webhookRoutes);

app.notFound((c) => c.json({ error: "not_found", message: "Unknown route." }, 404));
app.onError((err, c) => {
  console.error("unhandled error", err);
  return c.json({ error: "internal", message: "Internal error." }, 500);
});

export default app;
