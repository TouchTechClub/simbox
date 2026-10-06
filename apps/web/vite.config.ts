import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const DEV_API_TARGET = process.env.VITE_DEV_API_TARGET ?? "http://localhost:8787";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    // Allow previews through trycloudflare quick tunnels (and any other host)
    // in dev — the dev server is never publicly exposed otherwise.
    allowedHosts: true,
    proxy: {
      // Same-origin in dev: vite proxies auth + API to `wrangler dev`.
      "/api/auth": { target: DEV_API_TARGET, changeOrigin: true },
      "/v1": { target: DEV_API_TARGET, changeOrigin: true, ws: true },
    },
  },
});
