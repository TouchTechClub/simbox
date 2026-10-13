/**
 * Thin client for the simbox API — everything is POST + Bearer SIMBOX_TOKEN.
 * Contracts come from @simbox/shared.
 */
import type {
  RunDeregisterRequest,
  RunHeartbeatRequest,
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

  register(body: RunRegisterRequest): Promise<Response> {
    return this.post("/v1/runs/register", body, 20_000);
  }

  heartbeat(body: RunHeartbeatRequest): Promise<Response> {
    return this.post("/v1/runs/heartbeat", body, 15_000);
  }

  deregister(body: RunDeregisterRequest): Promise<Response> {
    return this.post("/v1/runs/deregister", body, 10_000);
  }
}
