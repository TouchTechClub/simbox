import type { PreviewDevice, PreviewInput } from "@simbox/shared/preview";
import { api, API_URL } from "./api";
import { AvccFrames, avcCodec, iosDisplayRotation, iosRawPoint } from "./device-video";

export type StreamStatus = "connecting" | "live" | "error";

/** Simlock stream frame tags (`[u32 len][u8 tag][payload]`). */
const TAG = { avcc: 1, key: 2, delta: 3, seed: 4, ended: 7 } as const;

/**
 * One device/mode per lifecycle. Video is the lease's Simlock stream (HTTP,
 * both platforms); the socket carries input and screen config. Reconnect
 * only transport; never replay input.
 */
export function startDeviceStream(options: {
  runId: string;
  device: PreviewDevice;
  control: boolean;
  canvas: HTMLCanvasElement;
  status: (status: StreamStatus, detail: string) => void;
  input: (ready: boolean) => void;
  frame: () => void;
}) {
  let stopped = false;
  let socket: WebSocket | null = null;
  let decoder: VideoDecoder | null = null;
  let waitingForKey = true;
  let configured = false;
  let timestamp = 0;
  let failures = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let frameTimer: ReturnType<typeof setTimeout> | undefined;
  let videoAbort: AbortController | null = null;
  let jpegBusy = false;
  let orientation = "portrait";
  let displayRotation = 0;
  let lastUiFrame = 0;
  const ios = options.device.platform === "ios";
  const lifecycle = new AbortController();
  const context = options.canvas.getContext("2d");
  const webCodecs = typeof VideoDecoder !== "undefined" && typeof EncodedVideoChunk !== "undefined";

  function closeDecoder() {
    if (decoder && decoder.state !== "closed") decoder.close();
    decoder = null;
    configured = false;
    waitingForKey = true;
  }
  function clearTransport() {
    clearTimeout(frameTimer);
    options.input(false);
    videoAbort?.abort();
    videoAbort = null;
    const previous = socket;
    socket = null;
    previous?.close();
    closeDecoder();
  }
  function fail(detail: string) {
    if (stopped) return;
    clearTransport();
    options.status("error", detail);
  }
  function markFrame() {
    clearTimeout(frameTimer);
    // Capture is change-driven: an unchanged screen can legitimately produce
    // no frames. Transport close, stream end and decode errors detect
    // disconnection; an inter-frame deadline would disable idle controls.
    failures = 0;
    if (Date.now() - lastUiFrame >= 1000) {
      lastUiFrame = Date.now();
      options.status("live", "Live · H.264");
      options.frame();
    }
  }
  function paint(source: CanvasImageSource, width: number, height: number) {
    if (stopped || !context) return;
    displayRotation = ios ? iosDisplayRotation(width, height, orientation) : 0;
    const swap = Math.abs(displayRotation) === 90;
    const displayWidth = swap ? height : width;
    const displayHeight = swap ? width : height;
    if (options.canvas.width !== displayWidth || options.canvas.height !== displayHeight) {
      options.canvas.width = displayWidth;
      options.canvas.height = displayHeight;
    }
    context.save();
    context.translate(displayWidth / 2, displayHeight / 2);
    context.rotate((displayRotation * Math.PI) / 180);
    context.drawImage(source, -width / 2, -height / 2);
    context.restore();
    markFrame();
  }
  async function configure(config: VideoDecoderConfig): Promise<boolean> {
    const support = await VideoDecoder.isConfigSupported({
      ...config,
      optimizeForLatency: true,
    }).catch(() => ({ supported: false }));
    if (stopped) return false;
    if (!support.supported) {
      fail("This browser cannot decode H.264. Use a current Chrome/Edge browser over HTTPS.");
      return false;
    }
    closeDecoder();
    try {
      decoder = new VideoDecoder({
        output(frame) {
          try {
            if (!stopped) paint(frame, frame.displayWidth, frame.displayHeight);
          } finally {
            frame.close();
          }
        },
        error() {
          reconnect("Video decoder failed; reconnecting…");
        },
      });
      decoder.configure({ ...config, optimizeForLatency: true });
      configured = true;
      return true;
    } catch {
      fail("Could not initialize video decoding. Close other previews and reconnect.");
      return false;
    }
  }
  function decode(data: Uint8Array, key: boolean) {
    if (!decoder || !configured || decoder.state !== "configured") return;
    if (waitingForKey && !key) return;
    waitingForKey = false;
    try {
      decoder.decode(
        new EncodedVideoChunk({
          type: key ? "key" : "delta",
          timestamp: (timestamp += 33_333),
          data: data as Uint8Array<ArrayBuffer>,
        }),
      );
    } catch {
      // Wait for the next keyframe rather than decoding a broken chain.
      waitingForKey = true;
    }
  }
  /** A still frame Simlock sends before (or between) video. */
  async function paintSeed(bytes: Uint8Array) {
    if (jpegBusy || stopped) return;
    jpegBusy = true;
    try {
      const bitmap = await createImageBitmap(
        new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }),
      );
      try {
        if (!stopped) paint(bitmap, bitmap.width, bitmap.height);
      } finally {
        bitmap.close();
      }
    } catch {
      /* not an image the browser can paint */
    } finally {
      jpegBusy = false;
    }
  }
  async function readVideo() {
    videoAbort?.abort();
    const abort = new AbortController();
    videoAbort = abort;
    const current = () => !stopped && videoAbort === abort;
    try {
      const response = await fetch(
        `${API_URL}/v1/runs/${options.runId}/preview/video?device=${encodeURIComponent(options.device.id)}`,
        { credentials: "include", signal: abort.signal },
      );
      if (!current()) {
        await response.body?.cancel().catch(() => {});
        return;
      }
      if (!response.ok || !response.body)
        throw new Error(`Stream unavailable (${response.status}). Reconnect or sign in again.`);
      const reader = response.body.getReader();
      const frames = new AvccFrames();
      while (current()) {
        const chunk = await reader.read();
        if (chunk.done) break;
        for (const frame of frames.push(chunk.value)) {
          if (frame.tag === TAG.avcc) {
            await configure({
              codec: avcCodec(frame.payload),
              description: frame.payload as Uint8Array<ArrayBuffer>,
            });
          } else if (frame.tag === TAG.key || frame.tag === TAG.delta) {
            // HTTP chunks can batch many frames. Apply reader backpressure
            // rather than overflowing the decoder; dropping delta frames
            // would break the reference chain.
            const deadline = Date.now() + 3000;
            while (current() && decoder && decoder.decodeQueueSize > 4 && Date.now() < deadline)
              await new Promise<void>((resolve) => setTimeout(resolve, 5));
            if (!current()) return;
            decode(frame.payload, frame.tag === TAG.key);
          } else if (frame.tag === TAG.seed) void paintSeed(frame.payload);
          else if (frame.tag === TAG.ended) {
            fail("The device's lease ended. Reopen it from the device list.");
            return;
          }
        }
      }
      if (current()) reconnect("Video feed ended; reconnecting…");
    } catch (error) {
      if (current()) reconnect(error instanceof Error ? error.message : "Video disconnected");
    }
  }
  function reconnect(detail: string) {
    if (stopped || retry) return;
    clearTransport();
    if (++failures > 4) {
      options.status("error", `${detail} Use Reconnect to try again. No actions were replayed.`);
      return;
    }
    options.status("connecting", detail);
    retry = setTimeout(
      () => {
        retry = undefined;
        void connect();
      },
      Math.min(1000 * 2 ** (failures - 1), 8000),
    );
  }
  async function connect() {
    if (stopped) return;
    options.status("connecting", "Connecting live video…");
    if (!webCodecs) {
      fail("Live video needs WebCodecs. Use a current Chrome/Edge browser over HTTPS.");
      return;
    }
    try {
      const access = await api.previewAccess(
        options.runId,
        options.device.id,
        options.control,
        lifecycle.signal,
      );
      if (stopped) return;
      const url = new URL(
        `${API_URL}/v1/runs/${options.runId}/preview/socket`,
        window.location.href,
      );
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("ticket", access.ticket);
      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      socket = ws;
      frameTimer = setTimeout(
        () => fail("No video frames arrived. Check that the device is booted, then Reconnect."),
        30_000,
      );
      ws.onopen = () => {
        if (!stopped && socket === ws) void readVideo();
      };
      ws.onmessage = (event) => {
        if (stopped || socket !== ws) return;
        if (typeof event.data === "string") {
          try {
            const message = JSON.parse(event.data);
            if (message.type === "ready")
              options.input(options.control && message.control === true);
          } catch {
            /* unknown event */
          }
          return;
        }
        if (!(event.data instanceof ArrayBuffer)) return;
        const bytes = new Uint8Array(event.data);
        // 0x82: the screen config ({width, height, orientation}).
        if (bytes[0] !== 0x82 || bytes.length >= 16_384) return;
        try {
          const config = JSON.parse(new TextDecoder().decode(bytes.subarray(1)));
          if (config.inputUnavailable === true) options.input(false);
          if (
            ["portrait", "landscape_left", "landscape_right", "portrait_upside_down"].includes(
              config.orientation,
            )
          )
            orientation = config.orientation;
        } catch {
          /* malformed config */
        }
      };
      ws.onclose = (event) => {
        if (socket === ws && !stopped)
          reconnect(
            event.code === 1006
              ? "Connection refused or interrupted. No actions are replayed."
              : "Connection lost or access lease renewed; reconnecting without replaying actions…",
          );
      };
      ws.onerror = () => ws.close();
    } catch (error) {
      if (!stopped) reconnect(error instanceof Error ? error.message : "Preview unavailable");
    }
  }
  void connect();
  return {
    send(input: PreviewInput): boolean {
      if (
        stopped ||
        !options.control ||
        socket?.readyState !== WebSocket.OPEN ||
        socket.bufferedAmount > 64_000
      )
        return false;
      const command =
        input.type === "touch" && ios
          ? { ...input, ...iosRawPoint(input.x, input.y, displayRotation) }
          : input;
      socket.send(JSON.stringify(command));
      return true;
    },
    stop() {
      stopped = true;
      lifecycle.abort();
      clearTimeout(retry);
      clearTransport();
    },
  };
}
