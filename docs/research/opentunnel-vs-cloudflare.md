# OpenTunnel vs Cloudflare Tunnel for Simbox

Date: 2026-10-17. OpenTunnel CLI v0.5.2 (released 2026-10-16), cloudflared 2026.9.1 (the version pinned in `packages/agent/src/pins.ts`).

## TL;DR

- **What it is.** [OpenTunnel](https://opentunnel.xyz/) is a free, anonymous, MIT-licensed "blind TLS tunnel" from Anomaly (the opencode team). Each tunnel gets a random `<id>.opentunnel.xyz` hostname with a wildcard certificate whose private key lives only on the client. The relay routes by SNI and never sees plaintext.
- **Speed: slower from here.** This host is in Mumbai, and OpenTunnel has no point of presence in India. Small-GET p50 was **~520 ms vs ~24 ms** for a cloudflared quick tunnel, WebSocket echo **532 ms vs 4.9 ms**, and upload **23 vs 47 Mbit/s**. Download was the same: both hit this host's ~50 Mbit/s line rate.
- **Better long-request behaviour.** The idle timeout is **900 s, vs Cloudflare's 125 s** (we measured a 524 at 125.6 s). Streamed bytes reach the client live, whereas Cloudflare held all of them until the response finished. The URL survives a client restart with no account (2.0–2.6 s to be reachable again).
- **Slow to provision.** A **brand-new tunnel takes 46–189 s** before it is usable, because a ZeroSSL certificate is issued per tunnel. A cloudflared quick tunnel takes **~7 s**. It has no custom domains, no HTTP/2 to browsers, a single bridge WebSocket (the same failure class as a quick tunnel's single edge connection), no ToS or SLA, and a hosted service re-platformed about a week ago with two outage issues since.
- **Recommendation: don't adopt now.** At most, **prototype it behind a flag** as an alternative to the _quick-tunnel fallback_, and only after a benchmark from real GitHub-hosted US/EU runners (see the end of this document). It cannot replace per-run named-tunnel provisioning without a pool of pre-issued identities in the API, and it loses the custom zone.

---

## 1. Research (primary sources)

| Question                     | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Source                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What it is                   | "A cli and sdk to create end-to-end encrypted public urls for apps running on your machine. the relay cannot read your traffic." It is a hosted service plus a CLI (Rust) and a TypeScript SDK (`@opentunnel/client`, for Bun/Node/Deno).                                                                                                                                                                                                                                                                                                                                                                                            | [opentunnel.xyz](https://opentunnel.xyz/) (meta tags and bundle), [README](https://github.com/anomalyco/opentunnel#readme)                                                                                                                                                                                                                  |
| Operator / hosting           | Anomaly (`anomalyco`, the opencode org). The hosted service is "one Rust binary, `crates/opentunnel-server`, on Fly.io", with state in PlanetScale MySQL (AWS us-east-1). Certificates come from ZeroSSL via ACME DNS-01 on a Cloudflare-hosted zone. The apex `opentunnel.xyz` (API and bridge) is proxied by Cloudflare.                                                                                                                                                                                                                                                                                                           | [README §Architecture](https://github.com/anomalyco/opentunnel#architecture), [fly.toml](https://github.com/anomalyco/opentunnel/blob/master/fly.toml), [docs/server.md](https://github.com/anomalyco/opentunnel/blob/master/docs/server.md)                                                                                                |
| Self-hostable?               | Yes in principle. The server is MIT, with a Dockerfile, `fly.toml` and the full config documented. It needs raw TCP 443 ingress, MySQL 8, a ZeroSSL EAB account, and a Cloudflare DNS token for DNS-01. Single-machine mode works (`INTERNAL_LISTEN=off`). The project does not accept pull requests.                                                                                                                                                                                                                                                                                                                                | [docs/server.md §Configuration](https://github.com/anomalyco/opentunnel/blob/master/docs/server.md#configuration), [README §Contributing](https://github.com/anomalyco/opentunnel#contributing)                                                                                                                                             |
| License                      | MIT. The LICENSE file was added 2026-10-07 after [issue #23](https://github.com/anomalyco/opentunnel/issues/23).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | [LICENSE](https://github.com/anomalyco/opentunnel/blob/master/LICENSE)                                                                                                                                                                                                                                                                      |
| Pricing / limits / ToS / SLA | **None published.** `/terms`, `/privacy`, `/pricing` and `/docs` all return 404, and the landing page has no pricing. No rate limits are documented: clients retry on 429, but no quota is stated. There is no uptime commitment and no acceptable-use policy, so CI or automated use is neither allowed nor forbidden in writing.                                                                                                                                                                                                                                                                                                   | `curl https://opentunnel.xyz/{terms,privacy,pricing}` → 404 (checked 2026-10-17); [docs/protocol.md §Retries](https://github.com/anomalyco/opentunnel/blob/master/docs/protocol.md#retries-and-errors)                                                                                                                                      |
| Client install               | `curl -fsSL https://opentunnel.xyz/install \| sh`, `brew install anomalyco/tap/opentunnel`, AUR `opentunnel-bin`, `npm i -g opentunnel`, `cargo install opentunnel-cli`. GitHub releases ship `opentunnel-{linux,darwin}-{x64,arm64}.tar.gz`, which covers linux-x64, linux-arm64 and darwin-arm64. **No checksum files are published**, so Simbox would have to pin its own sha256.                                                                                                                                                                                                                                                 | [README §Installation](https://github.com/anomalyco/opentunnel#installation), [release v0.5.2](https://github.com/anomalyco/opentunnel/releases/tag/v0.5.2), [install script](https://opentunnel.xyz/install)                                                                                                                               |
| Single static binary?        | Yes. The linux-arm64 binary is a **5.6 MB statically linked, stripped ELF** (tarball 2.9 MB). cloudflared is 37 MB.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `file` on the downloaded binaries (this machine)                                                                                                                                                                                                                                                                                            |
| Account / token              | **No account.** `POST /api/tunnel` is unauthenticated and returns `{tunnel, token}`; the token is shown once. "Tunnels do not expire", and the token is the only way to delete one.                                                                                                                                                                                                                                                                                                                                                                                                                                                  | [docs/protocol.md §HTTP API](https://github.com/anomalyco/opentunnel/blob/master/docs/protocol.md#http-api), [packages/client README §Storage](https://github.com/anomalyco/opentunnel/tree/master/packages/client#storage)                                                                                                                 |
| Hostnames                    | `<id>.opentunnel.xyz`, where `id` is 12 random base32 characters, plus routes `<route>.<id>.opentunnel.xyz` (a random 16-character route by default, or `--name`). The hostname is stable for as long as you keep the identity files (token, key, cert). **No custom domains**; the maintainer confirms Cloudflare Tunnel "is the better choice if you need your own domain". The tunnel hostname goes into Certificate Transparency logs; route names do not, because the cert is a wildcard.                                                                                                                                       | [README](https://github.com/anomalyco/opentunnel#installation), [issue #28](https://github.com/anomalyco/opentunnel/issues/28)                                                                                                                                                                                                              |
| Programmatic provisioning    | Yes, via a small documented HTTP API: `POST /api/tunnel`, then `POST /api/tunnel/:id/certificate` with a client-generated P-256 CSR (CN plus wildcard SAN), then poll `GET …/certificate` every 2 s until `ready`, then `DELETE /api/tunnel/:id`. **Issuance is slow**: the CLI warns "this can take a few minutes", the server runs at most 4 ACME orders at a time (`ISSUANCE_CONCURRENCY=4`), and we measured 46–189 s. There is no "list my tunnels" call (no account), so Simbox must record every id and token it creates.                                                                                                     | [docs/protocol.md §Provisioning](https://github.com/anomalyco/opentunnel/blob/master/docs/protocol.md#provisioning), [docs/server.md §Configuration](https://github.com/anomalyco/opentunnel/blob/master/docs/server.md#configuration)                                                                                                      |
| Transport                    | Visitors connect over **raw TCP 443** to a Fly anycast IP (`168.220.93.252`, wildcard DNS). The server reads only the ClientHello and forwards bytes over the client's **single bridge WebSocket** (`wss://opentunnel.xyz/api/tunnel/:id/connect`, which goes through Cloudflare), multiplexed in ≤32 KiB binary frames. **No QUIC/UDP anywhere.** The client terminates TLS with **no ALPN, so it is HTTP/1.1 only** (no h2, no h3).                                                                                                                                                                                                | [docs/server.md §Request flow](https://github.com/anomalyco/opentunnel/blob/master/docs/server.md#request-flow), [docs/protocol.md §Bridge](https://github.com/anomalyco/opentunnel/blob/master/docs/protocol.md#bridge), [issue #28](https://github.com/anomalyco/opentunnel/issues/28); curl reports "server did not agree on a protocol" |
| WebSockets / streaming       | It works for any protocol inside TLS, because it is a byte pipe and SSE is fine. **There is no per-connection flow control**: "one slow public reader can delay other connections that share the bridge". A visitor that stops reading for 30 s is reset.                                                                                                                                                                                                                                                                                                                                                                            | [docs/protocol.md §Backpressure](https://github.com/anomalyco/opentunnel/blob/master/docs/protocol.md#backpressure), [docs/server.md §Request flow](https://github.com/anomalyco/opentunnel/blob/master/docs/server.md#request-flow)                                                                                                        |
| Timeouts                     | A connection with no traffic either way for **15 min** (`CONNECTION_IDLE_TIMEOUT_MS=900000`) is reset; we confirmed 901.9 s. After a half-close, the other side gets 60 s. The ClientHello must arrive within 10 s. There is no request or response deadline otherwise.                                                                                                                                                                                                                                                                                                                                                              | [docs/server.md](https://github.com/anomalyco/opentunnel/blob/master/docs/server.md#configuration)                                                                                                                                                                                                                                          |
| Bandwidth / rate limits      | None documented. Capacity is sized per machine (`shared-cpu-1x`, 1 GB, soft/hard limits of 5000/10000 connections).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | [fly.toml](https://github.com/anomalyco/opentunnel/blob/master/fly.toml), [docs/server.md §Capacity](https://github.com/anomalyco/opentunnel/blob/master/docs/server.md#capacity)                                                                                                                                                           |
| Points of presence           | One Fly machine each in **iad, ord, sjc, gru, lhr, fra, cdg, jnb, sin, nrt, syd**. There is **none in India**. Visitors land on the machine nearest them, and the bridge lands on the one nearest the client's _Cloudflare colo_; the two are joined through a mesh over Fly's private network.                                                                                                                                                                                                                                                                                                                                      | [fly.toml](https://github.com/anomalyco/opentunnel/blob/master/fly.toml), [docs/server.md §Multiple regions](https://github.com/anomalyco/opentunnel/blob/master/docs/server.md#multiple-regions)                                                                                                                                           |
| Uptime / incidents           | No SLA. The service moved from a Cloudflare Worker to the Fly server around **2026-10-09**. [#45](https://github.com/anomalyco/opentunnel/issues/45) reported a full API outage of about 33 min (Cloudflare 525s) and 525 bursts on every deploy. [#46](https://github.com/anomalyco/opentunnel/issues/46) reported a client "connected" while no visitors reached it, caused by a server-side file-descriptor leak. Both were fixed within days.                                                                                                                                                                                    | linked issues                                                                                                                                                                                                                                                                                                                               |
| Security model               | TLS terminates **on the client**: "the server never holds the certificate private key or sees HTTP plaintext." The relay sees the SNI, visitor IPs and byte counts, and it posts analytics events. Caveats: the operator controls the `opentunnel.xyz` DNS zone and the ACME account, so it _could_ issue another cert for your hostname and MITM you, which would be visible in CT logs. The bridge's attach message (containing the tunnel token) passes through Cloudflare, which terminates TLS for `opentunnel.xyz`. The local target sees a loopback peer and the visitor's own `Host`, with no `X-Forwarded-*` headers added. | [README](https://github.com/anomalyco/opentunnel#architecture), [docs/trust-boundary.md](https://github.com/anomalyco/opentunnel/blob/master/docs/trust-boundary.md), [docs/server.md](https://github.com/anomalyco/opentunnel/blob/master/docs/server.md)                                                                                  |
| Maturity                     | Repo created 2026-03-30; about 90 commits. The first `v0.1.0` CLI release was 2026-10-07, and there have been 13 releases in 10 days, up to v0.5.2 on 2026-10-16. 308 stars, 16 forks. Contributors: `thdxr` (63 commits), `kitlangton` (9), and bots. Many issue replies are signed "from OpenCode", which suggests agent-written changes. Pull requests are not accepted.                                                                                                                                                                                                                                                          | `gh repo view anomalyco/opentunnel`, [releases](https://github.com/anomalyco/opentunnel/releases), [contributors](https://github.com/anomalyco/opentunnel/graphs/contributors)                                                                                                                                                              |

For comparison, the Cloudflare Quick Tunnel documentation says: "Quick Tunnels are for testing and development", "no uptime guarantee", "up to 200 in-flight requests", and "do not support Server-Sent Events (SSE)" ([docs](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)). Cloudflare's proxy read timeout is 125 s, and only Enterprise plans can raise it ([524 docs](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/)).

---

## 2. Benchmark

### Methodology

- **Host:** Oracle Cloud VM, `aarch64` (linux-arm64), Ubuntu kernel 7.0.0-1013-oracle, in **Mumbai, India**. The Cloudflare colo is `BOM` (3 ms away). The OpenTunnel anycast IP is 143 ms away by ping, and no OpenTunnel region is in India. Measured to `speed.cloudflare.com`, the host's line rate is about **53 Mbit/s down and 61 Mbit/s up**. Bun 1.4.3.
- **Binaries:** each was downloaded into its own empty directory: `/tmp/tunnel-bench/opentunnel/` (GitHub release v0.5.2 `opentunnel-linux-arm64.tar.gz`, binary sha256 `7efda255…7ebde`) and `/tmp/tunnel-bench/cloudflared/` (GitHub release 2026.9.1 `cloudflared-linux-arm64`, sha256 `3d974378…a3faa3`). Neither was ever run from inside its directory. All processes ran with cwd `/tmp`.
- **Origin:** a throwaway Bun server on `127.0.0.1:47310` with no secrets, serving these endpoints: `/small` (3 bytes), `/download` (20 MiB), `/upload`, `/long` (one space every 10 s for 180 s, then JSON), `/idle?secs=N` (the whole response withheld for N s), and `/ws` (echo, plus a binary stream mode). Nothing else on the machine was exposed.
- **Tunnels:**
  - `cloudflared tunnel --url http://127.0.0.1:47310 --protocol http2 --no-autoupdate` (cf-h2), and the same with `--protocol quic` (cf-quic). Both registered at `bom03`/`bom06`.
  - `opentunnel serve` with an isolated `XDG_*` state directory and a route `bench → 127.0.0.1:47310`. The tunnel was created with `opentunnel up` run with **`PATH` stripped of `systemctl`**, so it never registered a systemd login service. Every OpenTunnel tunnel created was deleted afterwards (`opentunnel delete --yes`).
- **Client:** a Bun harness on the same machine, calling the public URLs. **This is a hairpin**: every byte leaves this host and comes back, so throughput is capped by this host's link in both directions, and the latency figures are visitor RTT plus runner RTT added together. Because client and origin share a clock, WebSocket frame delay is a true one-way measurement.
- **Trials:**
  - Latency: 3 runs of 200 sequential keep-alive GETs plus 200 GETs at 20-way concurrency, for OpenTunnel and cf-h2; 1 run for cf-quic.
  - Throughput: 5 downloads and 5 uploads per tool.
  - Cold start: 5 per mode.
  - WebSocket: 5 connects, 200 echoes, and a 60 s stream at 2 Mbit/s (25,000-byte frames at 10 fps).
  - Long and idle requests: 1 each.

### Headline table (median or p50 unless noted)

| Metric                                               | Direct localhost | OpenTunnel                    | cloudflared quick, http2             | cloudflared quick, QUIC    |
| ---------------------------------------------------- | ---------------- | ----------------------------- | ------------------------------------ | -------------------------- |
| Cold start, **new tunnel**: spawn → public 200       | —                | **64.4 s** (48.4–≥189 s)      | **7.0 s** (6.7–7.4)¹                 | 9.1 s (7.3–12.1)¹          |
| Cold start, same identity (reconnect)                | —                | **2.5 s** (2.0–2.6)           | n/a (new URL every time)             | n/a                        |
| Small GET, sequential p50 / p95 / p99 (ms)           | 0.1 / 0.5 / 1.0  | **521 / 534 / 608**           | **24.3 / 47.8 / 78**                 | 24.2 / 42.5 / 58           |
| Small GET, 20-way p50 / p95 / p99 (ms)               | 1.5 / 3.6 / 3.7  | 549 / 1715 / 1793             | 32 / 620 / 819                       | 32 / 794 / 801             |
| 20-way throughput (req/s)                            | 11,292           | 28.9                          | 210.5                                | 207.1                      |
| First request on a new connection (ms)               | 3.2              | 1,436                         | 699                                  | 898                        |
| Download 20 MiB (Mbit/s)                             | 4,519            | 46.1                          | 47.2                                 | 47.6                       |
| Upload 5 MiB (Mbit/s)                                | 6,918            | **23.4**                      | 47.5                                 | 44.3                       |
| 3-minute whitespace-streamed response                | ok               | **ok, bytes delivered live**  | ok, **bytes buffered until the end** | ok, buffered until the end |
| Response withheld 120 s                              | ok               | ok (121.5 s)                  | ok (120.8 s)                         | ok (120.3 s)               |
| Idle cutoff (response withheld 1000 s)               | —                | **reset at 901.9 s** (15 min) | **524 at 125.6 s**                   | 524 at 125.8 s             |
| WebSocket connect (ms)                               | 0.4              | 1,466                         | 799                                  | 703                        |
| WebSocket echo RTT p50 / p95 (ms)                    | 0.0 / 0.1        | **532 / 537**                 | **4.9 / 6.4**                        | 4.5 / 6.2                  |
| 2 Mbit/s WS stream for 60 s: frames received, closes | 600/600, none    | 600/600, none                 | 600/600, none                        | 600/600, none              |
| WS frame one-way delay p50 / p95 / p99 / max (ms)    | 0 / 1 / 2 / 7    | 291 / 425 / 604 / 689         | 4 / 7 / 18 / 315                     | 4 / 6 / 19 / 309           |
| URL after client kill and restart                    | —                | **same URL** (5/5)            | new URL (10/10)                      | new URL                    |

¹ This is the time to 200 with the hostname pinned to a Cloudflare edge IP (`curl --resolve`). Through the system resolver, the time was **66–113 s** (median 66.7 s for h2, 67.1 s for QUIC), because polling before the record existed got NXDOMAIN, and the negative answer was cached for about 60 s. OpenTunnel uses wildcard DNS, so it has no such penalty. Simbox clients that resolve a fresh trycloudflare URL too early hit the same cache.

### Raw results

**Cold start: cloudflared quick tunnel.** `urlMs` is spawn until the trycloudflare URL is printed. "200" is spawn until the first 200 response.

| Trial | h2 URL | h2 200 (resolver) | h2 URL (pinned run) | h2 200 (pinned) | QUIC URL | QUIC 200 (resolver) | QUIC URL (pinned run) | QUIC 200 (pinned) |
| ----- | ------ | ----------------- | ------------------- | --------------- | -------- | ------------------- | --------------------- | ----------------- |
| 1     | 4.80 s | 65.9 s            | 4.97 s              | 7.16 s          | 4.48 s   | 102.4 s             | 5.89 s                | 11.71 s           |
| 2     | 5.58   | 66.7              | 5.01                | 6.71            | 6.13     | 67.1                | 5.76                  | 12.09             |
| 3     | 5.52   | 112.7             | 4.99                | 6.71            | 5.40     | 66.6                | 5.41                  | 9.10              |
| 4     | 5.05   | 65.9              | 5.20                | 6.99            | 4.87     | 65.9                | 5.51                  | 7.29              |
| 5     | 5.80   | 66.7              | 5.57                | 7.42            | 5.59     | 112.0               | 5.23                  | 8.01              |

In the pinned runs, the edge returned 530 for about 1–2 s after the URL was printed (1–8 polls) before the first 200.

**Cold start: OpenTunnel.** In "new identity" mode, `serve` is spawned, `up` creates a new tunnel (key, CSR, ZeroSSL issuance), and we poll until 200. In "same identity" mode, `serve` restarts with a saved identity.

| Trial | New: provisioning done | New: public 200                               | Same identity: public 200 |
| ----- | ---------------------- | --------------------------------------------- | ------------------------- |
| 1     | 62.2 s                 | 64.4 s                                        | 2.12 s                    |
| 2     | 48.1                   | 50.2                                          | 2.01                      |
| 3     | 46.4                   | 48.4                                          | 2.50                      |
| 4     | **189.4**              | not measured (exceeded the 180 s poll budget) | 2.59                      |
| 5     | 77.6                   | 79.7                                          | 2.54                      |

A sixth, manual creation took 48.1 s for `up`. The bridge attaches about 0.6 s after `serve` starts. The rest of the time is the ~1.4 s TLS-through-relay first request from this location. While the client was down, the URL failed fast (TCP reset, `curl` 000 in 0.56 s), not with an HTTP error page.

**Small GET latency (ms).** Sequential runs use 200 keep-alive requests after one warm-up request. 20-way runs use 200 requests across 20 workers.

| Tool / run    | First request | Seq p50 | Seq p95 | Seq p99 | Seq max | 20-way p50 | 20-way p95 | 20-way p99 | req/s  | Errors |
| ------------- | ------------- | ------- | ------- | ------- | ------- | ---------- | ---------- | ---------- | ------ | ------ |
| direct        | 3.2           | 0.1     | 0.5     | 1.0     | 1.1     | 1.5        | 3.6        | 3.7        | 11,292 | 0      |
| OpenTunnel #1 | 1,436         | 521.0   | 533.8   | 607.6   | 880.7   | 548.6      | 1,714.7    | 1,793.2    | 28.9   | 0      |
| OpenTunnel #2 | 1,434         | 519.3   | 520.8   | 522.4   | 683.7   | 530.9      | 1,783.0    | 2,801.4    | 28.8   | 0      |
| OpenTunnel #3 | 1,471         | 531.4   | 533.2   | 630.1   | 822.3   | 520.4      | 1,612.1    | 1,782.7    | 30.5   | 0      |
| cf-h2 #1      | 699           | 24.3    | 47.8    | 78.0    | 170.5   | 32.0       | 620.2      | 819.3      | 210.5  | 0      |
| cf-h2 #2      | 864           | 21.4    | 49.0    | 89.6    | 112.6   | 23.5       | 616.2      | 796.8      | 213.3  | 0      |
| cf-h2 #3      | 633           | 24.1    | 44.4    | 63.5    | 149.2   | 30.2       | 606.0      | 799.5      | 242.8  | 0      |
| cf-quic #1    | 898           | 24.2    | 42.5    | 58.0    | 158.7   | 31.8       | 793.7      | 801.4      | 207.1  | 0      |

The 20-way tail for both tools is mostly the cost of opening new TLS connections: 0.6–0.9 s on Cloudflare and ~1.4 s plus queueing on OpenTunnel.

**Throughput (Mbit/s, 5 trials each).**

| Tool       | Download p50 | Download min–max | Upload p50 | Upload min–max | Errors |
| ---------- | ------------ | ---------------- | ---------- | -------------- | ------ |
| direct     | 4,519        | 4,154–8,294      | 6,918      | 5,708–7,710    | 0      |
| OpenTunnel | 46.1         | 27.1–47.2        | 23.4       | 15.9–23.5      | 0      |
| cf-h2      | 47.2         | 43.6–47.5        | 47.5       | 45.9–50.5      | 0      |
| cf-quic    | 47.6         | 44.8–47.7        | 44.3       | 39.6–47.2      | 0      |

All the tunnel downloads are capped by the hairpin and this host's ~53 Mbit/s link, so they say nothing about either service's ceiling. OpenTunnel's upload is half of Cloudflare's. The likely cause is the long-RTT TCP-over-WebSocket path, through Cloudflare to a distant Fly region, combined with the bridge's bounded send queue.

**Long request (`/long`: one space every 10 s for 180 s, then `{"ok":true}`).**

| Tool                | Status | Headers at | Done at | Complete | When the body bytes arrived (s)                             |
| ------------------- | ------ | ---------- | ------- | -------- | ----------------------------------------------------------- |
| direct (20 s check) | 200    | 1 ms       | 20 s    | yes      | 0, 10, 20                                                   |
| OpenTunnel          | 200    | 1.45 s     | 181.5 s | yes      | 1.4, 11.5, 21.4, … every ~10 s … 171.7, 181.5 (19 arrivals) |
| cf-h2               | 200    | 0.54 s     | 180.4 s | yes      | **180.4 only**                                              |
| cf-quic             | 200    | 0.71 s     | 180.6 s | yes      | **180.6 only**                                              |

Follow-up 30 s checks against cf-h2 and cf-quic, using Simbox's exact `streamRpc` response headers (`content-type: application/json`, `cache-control: no-store, no-transform`, `x-accel-buffering: no`) with `Accept-Encoding` set both to `gzip, br` and to `identity`, still delivered every byte only when the response finished. Through Cloudflare, Simbox's whitespace keepalives therefore keep the 125 s edge read deadline alive, which is their purpose, but the client never sees them until the end. Through OpenTunnel the bytes are passed through live.

**Idle request (`/idle`: no bytes at all until the end).**

| Tool       | 120 s withheld | 1000 s withheld                                               |
| ---------- | -------------- | ------------------------------------------------------------- |
| OpenTunnel | 200 at 121.5 s | connection reset ("Empty reply") at **901.9 s** (curl client) |
| cf-h2      | 200 at 120.8 s | **HTTP 524 at 125.6 s**                                       |
| cf-quic    | 200 at 120.3 s | HTTP 524 at 125.8 s                                           |

Harness artifact: Bun 1.4.3's `fetch` client gave up on its own after **360 s** of silence ("The operation timed out"), even against localhost with a 400 s server delay. curl completed the same 400 s request. So the 1000 s OpenTunnel test was rerun with curl. This could also bite Simbox's own Bun clients on a request silent for more than 6 minutes, but the 15 s RPC heartbeat already prevents that.

**WebSocket.**

| Tool       | Connect p50 (min–max) ms | Echo p50 / p95 / p99 / max ms | Stream frames | Dropped | Out of order | Closed early | One-way delay p50 / p95 / p99 / max ms |
| ---------- | ------------------------ | ----------------------------- | ------------- | ------- | ------------ | ------------ | -------------------------------------- |
| direct     | 0.4 (0.4–0.8)            | 0.0 / 0.1 / 0.3 / 0.9         | 600/600       | 0       | 0            | no           | 0 / 1 / 2 / 7                          |
| OpenTunnel | 1,466 (1,446–1,525)      | 532 / 537 / 552 / 611         | 600/600       | 0       | 0            | no           | 291 / 425 / 604 / 689                  |
| cf-h2      | 799 (67–867)             | 4.9 / 6.4 / 8.3 / 12.7        | 600/600       | 0       | 0            | no           | 4 / 7 / 18 / 315                       |
| cf-quic    | 703 (48–770)             | 4.5 / 6.2 / 8.9 / 11.8        | 600/600       | 0       | 0            | no           | 4 / 6 / 19 / 309                       |

**Reconnect.** cloudflared quick tunnels gave a different `*.trycloudflare.com` URL on each of the 10 cold-start spawns. OpenTunnel's `tunnel.json` was byte-identical before and after 5 kill-and-restart cycles (same md5), and the same URL answered 200 within 2.0–2.6 s each time.

### Why OpenTunnel is ~20× slower here

From Mumbai, every OpenTunnel request crosses two long legs: visitor → nearest Fly machine (143 ms RTT), and runner → Cloudflare BOM → whichever Fly machine holds the bridge. When those are different machines they are joined over the Fly mesh, which adds a third leg. The result is about 520 ms per round trip, against 3 ms to Cloudflare's local PoP. On a GitHub-hosted runner in the US (Azure East US, Central US or West US), with clients also in the US or EU, the iad, ord, sjc, lhr, fra and cdg machines would be close to both ends. The gap would probably shrink to tens of milliseconds, though it would likely still be above Cloudflare, because the bridge also hops through Cloudflare. **The numbers here are worst-case geography and should not be read as US/EU performance.**

---

## 3. Fit for Simbox

### Is it faster?

Here, no. Small-request and RPC round trips are **~21× slower** (521 vs 24 ms), WebSocket echo is **~100× slower** (532 vs 4.9 ms), frame delay is **~70× higher** (291 vs 4 ms), and upload is **half**. Creating a brand-new tunnel is **7–27× slower** (48–189 s vs 7 s). Restarting with an existing identity takes 2–2.6 s, which no quick tunnel can match because a quick tunnel has to get a new URL. US/EU runners are unmeasured, so whether it is faster there is still an open question.

### Is it reliable enough for multi-minute RPCs and video?

**For long RPCs, it behaves better than Cloudflare.**

- The idle window is 15 min, against Cloudflare's 125 s, so the 15 s whitespace heartbeat becomes optional. The gateway's 10 min request ceiling fits inside it.
- Bytes stream through live.
- The 3-minute test passed.

**For video, it is functional.**

- The 60 s 2 Mbit/s stream had zero drops and no closes.
- Latency is the problem from distant regions: 291 ms p50 one-way, with a 689 ms max. The same would apply to touch-input round trips.
- Head-of-line blocking is a structural risk. All connections share one TCP WebSocket with no per-connection flow control, so a slow MJPEG viewer can stall RPCs and other viewers ([protocol.md §Backpressure](https://github.com/anomalyco/opentunnel/blob/master/docs/protocol.md#backpressure)).
- Browsers get HTTP/1.1 only, so an MJPEG stream holds one of the ~6 connections a browser allows per host.

**Service reliability is the weak point.**

- It has a single bridge per client, which is the same failure class as a quick tunnel's single edge connection. Simbox's CPU-starved macOS runners would hit it the same way.
- There is one machine per region.
- It was re-platformed about a week ago, with a full API outage of about 33 min ([#45](https://github.com/anomalyco/opentunnel/issues/45)), and a "zombie connected" failure ([#46](https://github.com/anomalyco/opentunnel/issues/46)) that matches the zombie-tunnel class `tunnelEdgeDead()` already exists to catch.
- There is no SLA.
- One positive: it is TCP-only, so the "QUIC dies on hosted macOS" problem cannot happen.

### Can it replace named-tunnel provisioning, the quick-tunnel fallback, or both?

**Named tunnels (`apps/api/src/tunnels.ts`): not as a drop-in.**

- There _is_ an API, and it is simpler than Cloudflare's: no account, and none of the zone, CNAME or connector-token steps.
- But each new tunnel needs a fresh ZeroSSL certificate, which took 46–189 s and is capped at 4 concurrent orders service-wide. That cannot sit on the run's critical path.
- The workable design is a **pool of pre-issued identities** in the API: a cron keeps N tunnels with `ready` certificates. Each run leases one, gets a fresh random 16-character route name, and has the identity deleted and replaced when the run ends.
- It **loses the custom zone**: URLs become `https://<route>.<id>.opentunnel.xyz`.
- The API would hold private keys and tokens at rest, and Simbox must keep its own ledger of ids and tokens, because tunnels never expire and cannot be listed.
- Sharing one identity across runs is technically possible, since many bridges can attach to one token with different routes. It is **not safe**: the runner executes customer workflow code, so any run could steal the token and key and delete or hijack every other run's routes.

**Quick-tunnel fallback: plausible, and the most interesting use.**

- It needs no account and keeps a stable URL across client restarts, which fixes "URL changes strand clients".
- It has a 15 min idle window and no QUIC dependency.
- But creating an identity _on the runner_ costs 48–189 s, against ~7 s. A useful fallback would therefore also need the API to hand out a pre-issued identity, at which point it is no longer an account-free fallback.
- An agent-side "create in the background while the quick tunnel serves, then switch" design is possible, but switching URLs mid-run is exactly what it was meant to avoid.

**Both: no.** The custom domain, the HTTP/2 or HTTP/3 to browsers, the multi-connection HA and the SLA-backed provider would all go.

### What integration would look like (not implemented)

**`packages/agent/src/index.ts`**

- **New `spawnOpenTunnel(identity)`** beside `spawnQuickTunnel` and `spawnNamedTunnel`, chosen by `spawnTunnel()`:
  - Create a `mkdtemp` directory (0700) and set `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME` and `XDG_RUNTIME_DIR` inside it.
  - Write `tunnel.json`, `token`, `private-key.pem`, `certificate.pem` and `chain.pem` there, plus `config/opentunnel/default.toml` with `[routes] <route16> = "127.0.0.1:${PROXY_PORT}"`.
  - Spawn `[state.opentunnelBin, "serve"]`. Use only `serve`: `up` and `route add` register a systemd or launchd login service whenever `systemctl --user` or launchd is available, which it is on hosted runners.
  - The alternative is `@opentunnel/client`'s `tunnel.connect()` in-process with `OpenTunnelStorage.memory()`. That avoids a binary download but pulls `effect` into the agent and puts TLS termination on the agent's own event loop.
- **URL detection.**
  - With a pre-issued identity, the URL is known up front: `https://<route>.<hostname>`.
  - Resolve readiness on the daemon log line `event={"type":"connected",…}`.
  - Reject on `attach_error`, a fatal `bad_token` or `cert_not_ready`, or the process exiting, as the existing promise does.
  - If the agent ever creates its own identity, add a regex next to `TUNNEL_URL_RE`, e.g. `/https:\/\/[a-z0-9-]+\.[a-z2-7]{12}\.opentunnel\.xyz/`.
- **Secret masking.** `addMask` the token, the hostname and the route URL.
- **Log filtering.** Extend the named-tunnel log filter to drop daemon lines that contain the hostname. Also drop lines with `"peer":"<ip>:<port>"`: the daemon logs every visitor's public IP on `connection-opened`, which would otherwise end up in GitHub Actions logs.
- **Cleanup.** Never put the token on argv, and delete the XDG directory in `shutdown()`.
- **Liveness.** `tunnelEdgeDead()` still works: OpenTunnel failures show up as TCP resets or TLS errors, which the `catch` already treats as dead. It never returns 530, so that branch would be dead code for this provider. Keep the edge probe, because it is exactly what catches the [#46](https://github.com/anomalyco/opentunnel/issues/46) failure.
- **Flags.** `--protocol http2` and `raisePriority` have no equivalent; `raisePriority` can still be applied to the `opentunnel` pid.
- **Installation.** `provision.ts` and `pins.ts` gain an `opentunnel` pin and a per-platform tarball download with **Simbox-pinned sha256s**, because upstream publishes none.

**`apps/api/src/tunnels.ts`**

- Put a provider interface behind `provisionRunTunnel`, `releaseRunTunnel` and `sweepRunTunnels`.
- The OpenTunnel provider needs:
  - A pool table in D1 holding id, hostname, token, private key and cert, encrypted at rest.
  - A cron that does `POST /api/tunnel`, generates a P-256 key and CSR (WebCrypto plus an x509 library such as `@peculiar/x509`), polls the certificate, and marks the identity ready.
  - Lease-on-provision.
  - `DELETE /api/tunnel/:id` on release, then refill.
  - A sweep over the ledger instead of Cloudflare's tunnel list.
- `tunnelsConfigured`, `tunnelZoneDelegated` and `waitForAuthoritativeDns` do not apply, because OpenTunnel uses wildcard DNS.
- `isRunTunnelHostname` must accept `*.<id>.opentunnel.xyz` for leased ids.
- In `packages/shared/src/types.ts`, `RunTunnelResponse` becomes a tagged union, either `{ kind: "cloudflare", tunnelUrl, connectorToken }` or `{ kind: "opentunnel", tunnelUrl, identity: {...} }`, so older agents keep working.

### Risks

- **Third-party trust.** This is better than Cloudflare's, but not zero. The relay cannot read device traffic or the daemon token in request headers, whereas Cloudflare terminates TLS and sees both. The operator still controls DNS and ACME for `opentunnel.xyz`, so a malicious or compromised operator could mint a cert and MITM, which CT logs would reveal. The operator also sees visitor IPs and metadata and posts analytics.
- **Cost and ToS.** It is free today, with **no ToS, no AUP, no stated limits and no SLA**. Hammering it with a pool of tunnels and per-run traffic from CI has no written permission, and could be throttled or cut off without notice. Ask the maintainers before relying on it.
- **Maturity.** The CLI is 10 days old (13 releases), with a single primary maintainer, no external PRs accepted, a backend migration a week ago with outages since, and API and backend changes landing daily.
- **Lock-in.** It is low for the protocol (documented, MIT, self-hostable) but high for the hostname: URLs are under `opentunnel.xyz` unless Simbox self-hosts the server. Self-hosting means operating Fly or equivalent, MySQL, ZeroSSL EAB and Cloudflare DNS, i.e. becoming a tunnel operator.
- **Functional gaps.** There is no HTTP/2 or HTTP/3 to browsers. Head-of-line blocking on one bridge has no per-connection flow control. A visitor that stops reading is reset after 30 s, which could bite a backgrounded browser tab that pauses an MJPEG reader.

### Recommendation: **don't adopt now; prototype behind a flag at most**

Do not replace either Cloudflare path today.

1. Measured from here it is much slower. The provider is too new and has no ToS or SLA.
2. Replacing named tunnels requires an identity pool holding private keys in the API, and gives up the custom domain.
3. A reasonable follow-up is a **flagged prototype of the quick-tunnel fallback** (`SIMBOX_TUNNEL=opentunnel`, using an API-leased identity). Before promoting it, require a real-runner benchmark that shows small-RPC p50 within about 2× of cloudflared, plus a written OK from the maintainers for CI use.
4. Two findings from this work are worth acting on regardless of OpenTunnel:
   - **Through a Cloudflare quick tunnel, the RPC whitespace keepalives are buffered and never reach the client before the final body**, and the hard idle limit is 125 s.
   - **Polling a fresh trycloudflare URL too early poisons resolvers' negative caches for about 60 s.** The quick-tunnel path may want something like the named-tunnel `waitForAuthoritativeDns()` before registering the URL.

### Caveat and how to benchmark from a real runner

Everything above was measured from one arm64 VM in India through a hairpin. GitHub-hosted runners sit in Azure US and EU regions (macOS arm64 runners included), close to OpenTunnel's iad, ord, sjc, lhr, fra and cdg machines, so absolute numbers _will_ differ, probably substantially in OpenTunnel's favour.

To measure properly, add a `workflow_dispatch` workflow (for example `.github/workflows/tunnel-bench.yml`):

- A **matrix** over `ubuntu-24.04` (x64), `ubuntu-24.04-arm` and `macos-15` (arm64).
- Steps: `oven-sh/setup-bun`, then download pinned `cloudflared` and `opentunnel` binaries into separate directories and check their sha256s. Then run `server.ts`, start a cf-h2 quick tunnel, a cf-quic quick tunnel and `opentunnel serve`, with the identity created in a previous step, timed for cold start, using the `PATH`-stripped `opentunnel up`.
- **Hairpin client:** run `harness.ts` against all three URLs from the runner itself, the same as here.
- **Real client:** a second, concurrent job in another region, or a scheduled Worker or VPS in us-east and eu-west, reads the URLs from a job output or artifact and runs the same harness. Visitor-to-runner numbers matter more than hairpin numbers.
- **Load variant:** repeat the latency, WebSocket and long tests while the runner is CPU-saturated (`stress-ng --cpu 0` on Linux; boot an iOS simulator on macOS), because the quick-tunnel drops Simbox sees happen under load.
- Upload all JSON lines as an artifact. Always delete the OpenTunnel identity (`opentunnel delete --yes`) in an `if: always()` step.
- Run it 5+ times across different hours.

The scripts are reproduced below so they can be committed for that job. They are not in the repo.

<details>
<summary><code>server.ts</code>: throwaway origin (127.0.0.1 only)</summary>

```ts
// Throwaway benchmark origin. Binds 127.0.0.1 only; serves synthetic data, no secrets.
// Usage: bun server.ts <port>
const port = Number(process.argv[2] ?? 47310);
const CHUNK = new Uint8Array(64 * 1024).fill(0x61);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type WsData = { streaming: boolean };
const server = Bun.serve<WsData>({
  hostname: "127.0.0.1",
  port,
  idleTimeout: 0,
  async fetch(req, srv) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (p === "/ws") {
      if (srv.upgrade(req, { data: { streaming: false } })) return;
      return new Response("upgrade failed", { status: 400 });
    }
    if (p === "/small") return new Response("ok\n", { headers: { "cache-control": "no-store" } });
    if (p === "/download") {
      const total = Number(url.searchParams.get("bytes") ?? 20 * 1024 * 1024);
      let sent = 0;
      const stream = new ReadableStream({
        pull(c) {
          if (sent >= total) return c.close();
          const n = Math.min(CHUNK.length, total - sent);
          c.enqueue(n === CHUNK.length ? CHUNK : CHUNK.subarray(0, n));
          sent += n;
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(total),
          "cache-control": "no-store",
        },
      });
    }
    if (p === "/upload" && req.method === "POST") {
      let n = 0;
      for await (const c of req.body!) n += (c as Uint8Array).byteLength;
      return Response.json({ received: n });
    }
    if (p === "/long") {
      const interval = Number(url.searchParams.get("interval") ?? 10) * 1000;
      const duration = Number(url.searchParams.get("duration") ?? 180) * 1000;
      const enc = new TextEncoder();
      const t0 = Date.now();
      const stream = new ReadableStream({
        async start(c) {
          try {
            while (Date.now() - t0 < duration) {
              c.enqueue(enc.encode(" "));
              await sleep(interval);
            }
            c.enqueue(enc.encode(JSON.stringify({ ok: true, elapsedMs: Date.now() - t0 }) + "\n"));
            c.close();
          } catch {}
        },
      });
      // nt=1 mirrors Simbox's streamRpc response headers (packages/agent/src/gateway.ts).
      const simbox = url.searchParams.get("nt") === "1";
      return new Response(stream, {
        headers: simbox
          ? {
              "content-type": "application/json",
              "cache-control": "no-store, no-transform",
              "x-accel-buffering": "no",
            }
          : { "content-type": "application/json", "cache-control": "no-store" },
      });
    }
    if (p === "/idle") {
      const secs = Number(url.searchParams.get("secs") ?? 120);
      await sleep(secs * 1000);
      return Response.json({ ok: true, waitedS: secs });
    }
    return new Response("not found", { status: 404 });
  },
  websocket: {
    idleTimeout: 960,
    maxPayloadLength: 16 * 1024 * 1024,
    async message(ws, msg) {
      if (typeof msg === "string" && msg.startsWith("stream:")) {
        // stream:<seconds>:<frameBytes>:<fps> → binary frames [u32 seq][f64 sentAtMs][pad]
        const [, secs, bytes, fps] = msg.split(":").map(Number);
        const frames = secs * fps,
          gap = 1000 / fps,
          t0 = performance.now();
        for (let i = 0; i < frames; i++) {
          const wait = t0 + i * gap - performance.now();
          if (wait > 0) await sleep(wait);
          if (ws.readyState !== 1) return;
          const buf = new ArrayBuffer(bytes);
          const dv = new DataView(buf);
          dv.setUint32(0, i);
          dv.setFloat64(4, Date.now());
          ws.send(buf);
        }
        ws.send(`done:${frames}`);
        return;
      }
      ws.send(msg);
    },
  },
});
console.log(`listening http://127.0.0.1:${server.port}`);
```

</details>

<details>
<summary><code>harness.ts</code>: client (<code>bun harness.ts &lt;latency|throughput|long|idle|ws|probe&gt; &lt;baseUrl&gt; [args]</code>)</summary>

```ts
const [test, base, ...args] = process.argv.slice(2);
const now = () => performance.now();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function pct(xs: number[], p: number) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}
const r1 = (x: number) => Math.round(x * 10) / 10;
function stats(xs: number[]) {
  return {
    n: xs.length,
    p50: r1(pct(xs, 50)),
    p95: r1(pct(xs, 95)),
    p99: r1(pct(xs, 99)),
    min: r1(Math.min(...xs)),
    max: r1(Math.max(...xs)),
    mean: r1(xs.reduce((a, b) => a + b, 0) / (xs.length || 1)),
  };
}
async function timedGet(url: string) {
  const t = now();
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  await res.arrayBuffer();
  return { ms: now() - t, status: res.status };
}

async function latency() {
  const n = Number(args[0] ?? 200),
    url = `${base}/small`;
  const first = await timedGet(url).catch((e) => ({ ms: NaN, status: String(e) }));
  const seq: number[] = [];
  let seqErr = 0;
  for (let i = 0; i < n; i++) {
    try {
      const r = await timedGet(url);
      r.status === 200 ? seq.push(r.ms) : seqErr++;
    } catch {
      seqErr++;
    }
  }
  const conc: number[] = [];
  let concErr = 0;
  const statuses: Record<string, number> = {};
  let next = 0;
  const t0 = now();
  await Promise.all(
    Array.from({ length: 20 }, async () => {
      while (next < n) {
        next++;
        try {
          const r = await timedGet(url);
          statuses[r.status] = (statuses[r.status] ?? 0) + 1;
          r.status === 200 ? conc.push(r.ms) : concErr++;
        } catch (e) {
          concErr++;
          const k = String(e).slice(0, 40);
          statuses[k] = (statuses[k] ?? 0) + 1;
        }
      }
    }),
  );
  const wall = now() - t0;
  return {
    firstRequestMs: r1(first.ms),
    sequential: { ...stats(seq), errors: seqErr },
    concurrent20: {
      ...stats(conc),
      errors: concErr,
      wallMs: r1(wall),
      rps: r1((n / wall) * 1000),
      statuses,
    },
  };
}
async function throughput() {
  const trials = Number(args[0] ?? 5);
  const down: number[] = [],
    up: number[] = [],
    errs: string[] = [];
  for (let i = 0; i < trials; i++) {
    try {
      const t = now();
      const res = await fetch(`${base}/download?bytes=${20 * 1024 * 1024}`, {
        signal: AbortSignal.timeout(300_000),
      });
      const b = await res.arrayBuffer();
      const ms = now() - t;
      if (b.byteLength !== 20 * 1024 * 1024) throw new Error(`short body ${b.byteLength}`);
      down.push((b.byteLength * 8) / 1e6 / (ms / 1000));
    } catch (e) {
      errs.push(`down: ${String(e).slice(0, 120)}`);
    }
    try {
      const body = new Uint8Array(5 * 1024 * 1024).fill(0x62);
      const t = now();
      const res = await fetch(`${base}/upload`, {
        method: "POST",
        body,
        signal: AbortSignal.timeout(300_000),
      });
      const j = (await res.json()) as { received: number };
      const ms = now() - t;
      if (j.received !== body.byteLength) throw new Error(`short upload ${j.received}`);
      up.push((body.byteLength * 8) / 1e6 / (ms / 1000));
    } catch (e) {
      errs.push(`up: ${String(e).slice(0, 120)}`);
    }
  }
  return { download20MB_Mbps: stats(down), upload5MB_Mbps: stats(up), errors: errs };
}
async function long() {
  const duration = Number(args[0] ?? 180);
  const t0 = now();
  const arrivals: number[] = [];
  try {
    const res = await fetch(`${base}/long?interval=10&duration=${duration}`, {
      signal: AbortSignal.timeout((duration + 60) * 1000),
    });
    const headersMs = now() - t0;
    let bytes = 0,
      tail = "";
    const dec = new TextDecoder();
    for await (const chunk of res.body!) {
      bytes += chunk.byteLength;
      arrivals.push(r1((now() - t0) / 1000));
      tail = (tail + dec.decode(chunk)).slice(-200);
    }
    return {
      status: res.status,
      headersMs: r1(headersMs),
      totalS: r1((now() - t0) / 1000),
      bytes,
      complete: tail.includes('"ok":true'),
      chunkArrivalsS: arrivals,
    };
  } catch (e) {
    return {
      error: String(e).slice(0, 200),
      afterS: r1((now() - t0) / 1000),
      chunkArrivalsS: arrivals,
    };
  }
}
async function idle() {
  const secs = Number(args[0] ?? 120);
  const t0 = now();
  try {
    const res = await fetch(`${base}/idle?secs=${secs}`, {
      signal: AbortSignal.timeout((secs + 60) * 1000),
    });
    const body = await res.text();
    return {
      status: res.status,
      afterS: r1((now() - t0) / 1000),
      body: body.slice(0, 160),
      server: res.headers.get("server"),
    };
  } catch (e) {
    return { error: String(e).slice(0, 200), afterS: r1((now() - t0) / 1000) };
  }
}
function openWs(): Promise<{ ws: WebSocket; ms: number }> {
  return new Promise((resolve, reject) => {
    const t = now();
    const ws = new WebSocket(base.replace(/^http/, "ws") + "/ws");
    ws.binaryType = "arraybuffer";
    const to = setTimeout(() => reject(new Error("ws connect timeout")), 30_000);
    ws.onopen = () => {
      clearTimeout(to);
      resolve({ ws, ms: now() - t });
    };
    ws.onerror = () => {
      clearTimeout(to);
      reject(new Error("ws error"));
    };
  });
}
async function ws() {
  const trials = Number(args[0] ?? 5),
    streamSecs = Number(args[1] ?? 60);
  const connect: number[] = [],
    connectErr: string[] = [];
  for (let i = 0; i < trials; i++) {
    try {
      const { ws, ms } = await openWs();
      connect.push(ms);
      ws.close();
      await sleep(200);
    } catch (e) {
      connectErr.push(String(e).slice(0, 100));
    }
  }
  const { ws: sock } = await openWs();
  const rtt: number[] = [];
  for (let i = 0; i < 200; i++) {
    const t = now();
    await new Promise<void>((res) => {
      sock.onmessage = () => res();
      sock.send(`echo:${i}`);
    });
    rtt.push(now() - t);
  }
  const frameBytes = 25_000,
    fps = 10,
    expected = streamSecs * fps;
  const seen = new Set<number>();
  const oneWay: number[] = [];
  let outOfOrder = 0,
    last = -1,
    doneMsg = false;
  let closed: { code: number; reason: string; atS: number } | null = null;
  const t0 = now();
  await new Promise<void>((resolve) => {
    const hard = setTimeout(resolve, (streamSecs + 30) * 1000);
    sock.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        if (ev.data.startsWith("done:")) {
          doneMsg = true;
          clearTimeout(hard);
          resolve();
        }
        return;
      }
      const dv = new DataView(ev.data as ArrayBuffer);
      const seq = dv.getUint32(0);
      oneWay.push(Date.now() - dv.getFloat64(4));
      if (seq < last) outOfOrder++;
      last = seq;
      seen.add(seq);
    };
    sock.onclose = (ev) => {
      closed = { code: ev.code, reason: ev.reason, atS: r1((now() - t0) / 1000) };
      clearTimeout(hard);
      resolve();
    };
    sock.send(`stream:${streamSecs}:${frameBytes}:${fps}`);
  });
  sock.close();
  return {
    connectMs: { ...stats(connect), errors: connectErr },
    echoRttMs: stats(rtt),
    stream: {
      targetMbps: (frameBytes * 8 * fps) / 1e6,
      expectedFrames: expected,
      receivedFrames: seen.size,
      dropped: expected - seen.size,
      outOfOrder,
      completed: doneMsg,
      closed,
      elapsedS: r1((now() - t0) / 1000),
      frameDelayMs: stats(oneWay),
    },
  };
}
async function probe() {
  const timeout = Number(args[0] ?? 120) * 1000;
  const t0 = now();
  let tries = 0,
    lastErr = "";
  while (now() - t0 < timeout) {
    tries++;
    try {
      const res = await fetch(`${base}/small`, { signal: AbortSignal.timeout(5000) });
      await res.arrayBuffer();
      if (res.status === 200) return { ok: true, ms: r1(now() - t0), tries };
      lastErr = `status ${res.status}`;
    } catch (e) {
      lastErr = String(e).slice(0, 80);
    }
    await sleep(250);
  }
  return { ok: false, ms: r1(now() - t0), tries, lastErr };
}
const tests: Record<string, () => Promise<unknown>> = {
  latency,
  throughput,
  long,
  idle,
  ws,
  probe,
};
console.log(JSON.stringify({ test, result: await tests[test]() }));
process.exit(0);
```

</details>

<details>
<summary><code>coldstart.ts</code>: spawn-to-200 trials (<code>[PIN_IP=&lt;edge ip&gt;] bun coldstart.ts &lt;cf-h2|cf-quic|ot-warm|ot-new&gt; &lt;trials&gt; &lt;port&gt;</code>)</summary>

Outline of each trial:

1. Spawn the client:
   - `cloudflared tunnel --url … --protocol http2|quic --no-autoupdate` with cwd `/tmp`; or
   - `opentunnel serve` with isolated `XDG_*` directories and `PATH` set to an empty directory, so `systemctl` is never found. For `ot-new`, `opentunnel up` also runs to create the identity.
2. For cloudflared, read the URL from stderr with `/https:\/\/[a-z0-9-]+\.trycloudflare\.com/`.
3. Poll `GET <url>/small` every 250 ms until it returns 200. With `PIN_IP` set, poll through `curl --resolve host:443:$PIN_IP` to bypass the local resolver's negative cache.
4. Record spawn→URL and spawn→200. Send SIGTERM, then SIGKILL after 5 s. For `ot-new`, also run `opentunnel delete --yes`.

</details>

### Cleanup performed

- Deleted all 6 OpenTunnel tunnels created by this benchmark: 5 `ot-new` trials, each with `deleteExit: 0`, and the main identity with "Deleted the tunnel for profile default".
- Killed every process started here: the cloudflared http2 and QUIC quick tunnels, the per-trial cloudflared processes, `opentunnel serve`, and the Bun origin.
- Verified with `ps` that none remain and that port 47310 is closed.
- No systemd user units were created.
- The pre-existing, unrelated `cloudflared` (pid 3188, `~/.s5code/tools/…`) was not touched.
