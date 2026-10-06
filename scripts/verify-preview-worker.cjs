/* Workerd smoke test: mocks only the remote runner, not auth, D1 or upgrades. */
const { createRequire } = require("node:module");
const { readFileSync, readdirSync, mkdtempSync, rmSync } = require("node:fs");
const { join, dirname } = require("node:path");
const { tmpdir } = require("node:os");
const { spawnSync } = require("node:child_process");
const assert = require("node:assert/strict");
const { Miniflare } = require("miniflare");

const repo = join(__dirname, "..");
const directory = mkdtempSync(join(tmpdir(), "simbox-preview-worker-"));
const apiRequire = createRequire(join(repo, "apps/api/package.json"));
const wrangler = join(dirname(apiRequire.resolve("wrangler/package.json")), "bin/wrangler.js");
const build = spawnSync(
  process.execPath,
  [
    wrangler,
    "deploy",
    "--dry-run",
    "--outdir",
    directory,
    "--config",
    join(repo, "apps/api/wrangler.toml"),
  ],
  { cwd: repo, stdio: "inherit", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
);
if (build.status !== 0) {
  rmSync(directory, { recursive: true, force: true });
  process.exit(build.status ?? 1);
}
const mf = new Miniflare({
  workers: [
    {
      name: "simbox",
      modules: [
        {
          type: "ESModule",
          path: "worker.js",
          contents: readFileSync(join(directory, "index.js"), "utf8"),
        },
      ],
      compatibilityDate: "2026-01-05",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: ["DB"],
      kvNamespaces: ["KV"],
      bindings: {
        APP_URL: "http://localhost:5173",
        API_URL: "http://localhost:8787",
        BETTER_AUTH_SECRET: "test-only-preview-signing-secret-32-long",
        GITHUB_CLIENT_ID: "test",
        GITHUB_CLIENT_SECRET: "test",
      },
      outboundService: "hub-fixture",
    },
    {
      name: "hub-fixture",
      modules: true,
      script: `export default { fetch(req) {
    const url = new URL(req.url);
    if(req.headers.get('authorization') !== 'Bearer private-daemon-token') return new Response('unauthorized',{status:401});
    if (url.pathname === '/simbox-preview/devices') return Response.json({devices:[{id:'emulator-5554',name:'simbox',platform:'android',version:'Android 14'}],observedAt:Date.now()});
    if (url.pathname === '/simbox-preview/socket') {
      const pair = new WebSocketPair(); const ws=pair[1]; ws.accept();
      ws.addEventListener('message', e => ws.send(JSON.stringify({type:'received',input:JSON.parse(e.data),control:req.headers.get('x-simbox-preview-control')})));
      setTimeout(()=>ws.send(new Uint8Array([1,2,3]).buffer),100);
      return new Response(null,{status:101,webSocket:pair[0]});
    }
    return new Response('unexpected',{status:404});
  } }`,
    },
  ],
});

async function smoke() {
  try {
    const db = await mf.getD1Database("DB");
    for (const name of readdirSync(join(repo, "packages/db/migrations")).sort()) {
      const sql = readFileSync(join(repo, "packages/db/migrations", name, "migration.sql"), "utf8");
      for (const part of sql.split("--> statement-breakpoint"))
        if (part.trim()) await db.prepare(part).run();
    }
    const now = Date.now();
    await db
      .prepare("INSERT INTO user (id,name,email,login,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .bind("u", "u", "u@test.invalid", "u", now, now)
      .run();
    await db
      .prepare(
        "INSERT INTO session (id,user_id,token,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?)",
      )
      .bind("s", "u", "fixture-token", now + 3600000, now, now)
      .run();
    await db
      .prepare(
        "INSERT INTO runs (id,user_id,repo_full_name,state,platform,created_at,tunnel_url,daemon_token) VALUES (?,?,?,?,?,?,?,?)",
      )
      .bind(
        "run",
        "u",
        "owner/repo",
        "live",
        "android",
        Math.floor(now / 1000),
        "https://fixture.trycloudflare.com",
        "private-daemon-token",
      )
      .run();
    const connect = async (control) => {
      const access = await mf.dispatchFetch("http://localhost:8787/v1/runs/run/preview/access", {
        method: "POST",
        headers: {
          authorization: "Bearer fixture-token",
          origin: "http://localhost:5173",
          "content-type": "application/json",
        },
        body: JSON.stringify({ device: "emulator-5554", control }),
      });
      assert.equal(access.status, 200);
      assert.ok(!JSON.stringify(await access.clone().json()).includes("private-daemon-token"));
      const { ticket } = await access.json();
      const response = await mf.dispatchFetch(
        `http://localhost:8787/v1/runs/run/preview/socket?ticket=${ticket}`,
        { headers: { origin: "http://localhost:5173", upgrade: "websocket" } },
      );
      assert.equal(response.status, 101);
      const ws = response.webSocket;
      assert.ok(ws);
      ws.accept();
      return ws;
    };
    const viewer = await connect(false);
    const frames = [];
    viewer.addEventListener("message", (event) => frames.push(event.data));
    viewer.send(JSON.stringify({ type: "reset-video" }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(frames.some((frame) => typeof frame !== "string"));
    assert.ok(
      frames.some((frame) => typeof frame === "string" && JSON.parse(frame).control === "0"),
    );
    const closed = new Promise((resolve) =>
      viewer.addEventListener("close", resolve, { once: true }),
    );
    viewer.send(JSON.stringify({ type: "button", button: "home" }));
    await closed;
    const controller = await connect(true);
    const operated = new Promise((resolve) =>
      controller.addEventListener(
        "message",
        (event) => {
          if (typeof event.data === "string") resolve(JSON.parse(event.data));
        },
        { once: true },
      ),
    );
    controller.send(JSON.stringify({ type: "button", button: "home" }));
    assert.deepEqual(await operated, {
      type: "received",
      input: { type: "button", button: "home" },
      control: "1",
    });
    controller.close();
    console.log(
      "PASS workerd: authenticated tickets, real WebSocket upgrades, binary frames, read-only/control modes and peer cleanup.",
    );
  } finally {
    await mf.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
}
const deadline = setTimeout(() => {
  console.error("Worker preview smoke test timed out");
  process.exit(1);
}, 60_000);
smoke()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => clearTimeout(deadline));
