/**
 * Thin client for the simbox API — everything is POST + Bearer SIMBOX_TOKEN.
 * Contracts come from @simbox/shared.
 */
import type {
  RunConfigRequest,
  RunConfigResponse,
  RunDeregisterRequest,
  RunHeartbeatRequest,
  RunInventoryRequest,
  RunRegisterRequest,
  RunTunnelRequest,
  RunTunnelResponse,
} from "@simbox/shared";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`HTTP ${status}: ${body.slice(0, 300)}`);
    this.name = "HttpError";
  }
}

/**
 * The API says the run is already over (stopped, ended or replaced): 409
 * `run_over` from register/heartbeat, or 404 for a run it no longer knows.
 * Agents exit cleanly instead of counting these as failures.
 */
export function runIsOver(err: unknown, options: { notFound?: boolean } = {}): boolean {
  if (!(err instanceof HttpError)) return false;
  if (err.status === 404) return options.notFound === true;
  if (err.status !== 409) return false;
  try {
    const body = JSON.parse(err.body) as { error?: unknown };
    return body?.error === undefined || body.error === "run_over";
  } catch {
    return true;
  }
}

export class ApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private async post(path: string, body: unknown, timeoutMs = 15_000): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new Error(`network error posting ${path}: ${String(err)}`);
    }
    if (!res.ok) {
      throw new HttpError(res.status, await res.text().catch(() => ""));
    }
    return res;
  }

  async tunnel(body: RunTunnelRequest): Promise<RunTunnelResponse> {
    const res = await this.post("/v1/runs/tunnel", body, 30_000);
    const named = (await res.json()) as RunTunnelResponse;
    if (!named?.tunnelUrl?.startsWith("https://") || !named.connectorToken)
      throw new Error("malformed tunnel response");
    return named;
  }

  async config(body: RunConfigRequest): Promise<RunConfigResponse> {
    const res = await this.post("/v1/runs/config", body, 15_000);
    return (await res.json()) as RunConfigResponse;
  }

  register(body: RunRegisterRequest): Promise<Response> {
    return this.post("/v1/runs/register", body, 20_000);
  }

  heartbeat(body: RunHeartbeatRequest): Promise<Response> {
    return this.post("/v1/runs/heartbeat", body, 15_000);
  }

  deregister(body: RunDeregisterRequest): Promise<Response> {
    return this.post("/v1/runs/deregister", body, 10_000);
  }

  inventory(body: RunInventoryRequest): Promise<Response> {
    return this.post("/v1/runs/inventory", body, 15_000);
  }
}
