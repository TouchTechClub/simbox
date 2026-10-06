import type { PreviewDevice, PreviewInput } from "@simbox/shared/preview";
import { api, API_URL } from "./api";
import {
  AvccFrames,
  JpegFrames,
  avcCodec,
  androidFrame,
  scanAnnexB,
  iosDisplayRotation,
  iosRawPoint,
} from "./device-video";

export type StreamStatus = "connecting" | "live" | "error";
/** One device/mode per lifecycle. Reconnect only transport; never replay input. */
export function startDeviceStream(options: {
  runId: string;
  device: PreviewDevice;
  control: boolean;
  canvas: HTMLCanvasElement;
  status: (status: StreamStatus, detail: string) => void;
  input: (ready: boolean) => void;
  frame: () => void;
  iosStartMs?: number;
}) {
  let stopped = false;
  let socket: WebSocket | null = null;
  let decoder: VideoDecoder | null = null;
  let waitingForKey = true;
  let configured = false;
  let configuring = false;
  let pendingAndroid: ReturnType<typeof androidFrame>[] = [];
  let decoderEpoch = 0;
  let timestamp = 0;
  let failures = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let frameTimer: ReturnType<typeof setTimeout> | undefined;
  let videoAbort: AbortController | null = null;
  let avccStartTimer: ReturnType<typeof setTimeout> | undefined;
  let jpegBusy = false;
  let iosOrientation = "portrait";
  let displayRotation = 0;
  let lastUiFrame = 0;
  const lifecycle = new AbortController();
  const context = options.canvas.getContext("2d");
  const webCodecs = typeof VideoDecoder !== "undefined" && typeof EncodedVideoChunk !== "undefined";
  let mjpeg = !webCodecs;
  function closeDecoder() {
    decoderEpoch++;
    if (decoder && decoder.state !== "closed") decoder.close();
    decoder = null;
    configured = false;
    waitingForKey = true;
    configuring = false;
  }
  function clearTransport() {
    pendingAndroid = [];
    clearTimeout(frameTimer);
    clearTimeout(avccStartTimer);
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
    // Real capture is change-driven: an unchanged screen can legitimately
    // produce no frames until the clock or input changes it. Transport close,
    // stream EOF, decode errors and admission leases detect disconnection;
    // an arbitrary inter-frame deadline incorrectly disables idle controls.
    failures = 0;
    if (Date.now() - lastUiFrame >= 1000) {
      lastUiFrame = Date.now();
      options.status("live", mjpeg ? "Live · MJPEG fallback" : "Live · H.264");
      options.frame();
    }
  }
  function paint(source: CanvasImageSource, width: number, height: number) {
    if (stopped || !context) return;
    displayRotation =
      options.device.platform === "ios" ? iosDisplayRotation(width, height, iosOrientation) : 0;
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
  function resetVideo() {
    if (socket?.readyState === WebSocket.OPEN && options.device.platform === "android")
      socket.send(JSON.stringify({ type: "reset-video" }));
  }
  function fallbackIos() {
    if (stopped || mjpeg) return;
    mjpeg = true;
    clearTimeout(avccStartTimer);
    closeDecoder();
    void readIosVideo();
  }
  async function configure(config: VideoDecoderConfig) {
    if (configuring || stopped) return false;
    configuring = true;
    const current = socket;
    const epoch = decoderEpoch;
    const support = await VideoDecoder.isConfigSupported({
      ...config,
      optimizeForLatency: true,
    }).catch(() => ({ supported: false }));
    if (stopped || socket !== current || epoch !== decoderEpoch) return false;
    configuring = false;
    if (!support.supported) {
      if (options.device.platform === "ios") {
        fallbackIos();
      } else
        fail("This browser cannot decode H.264. Use a current Chrome/Edge browser over HTTPS.");
      return false;
    }
    closeDecoder();
    try {
      decoder = new VideoDecoder({
        output(frame) {
          try {
            // Real decoder output proves AVCC capture is alive; the priming
            // JPEG comes from a different subscription and must not count.
            clearTimeout(avccStartTimer);
            if (!stopped) paint(frame, frame.displayWidth, frame.displayHeight);
          } finally {
            frame.close();
          }
        },
        error() {
          if (options.device.platform === "ios") fallbackIos();
          else fail("Video decoder failed. Reconnect to inspect the current screen.");
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
  function decode(data: Uint8Array, key: boolean, pts?: number | null) {
    if (!decoder || !configured || decoder.state !== "configured") return;
    if (waitingForKey && !key) return;
    if (decoder.decodeQueueSize > 8) {
      if (options.device.platform === "ios") {
        // Sustained decoder overflow: MJPEG keeps the preview live instead of
        // an error that drops the user's only window into the device.
        fallbackIos();
        return;
      }
      decoder.reset();
      closeDecoder();
      resetVideo();
      return;
    }
    waitingForKey = false;
    try {
      decoder.decode(
        new EncodedVideoChunk({
          type: key ? "key" : "delta",
          timestamp: pts ?? (timestamp += 33_333),
          data: data as Uint8Array<ArrayBuffer>,
        }),
      );
    } catch {
      if (options.device.platform === "ios") {
        // AVCC decode failure on a real wedged subscription: fall back to the
        // always-continuous MJPEG stream instead of disabling the device.
        fallbackIos();
        return;
      }
      closeDecoder();
      resetVideo();
    }
  }
  async function paintJpeg(bytes: Uint8Array) {
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
    } finally {
      jpegBusy = false;
    }
  }
  async function readIosVideo() {
    clearTimeout(avccStartTimer);
    videoAbort?.abort();
    const abort = new AbortController();
    videoAbort = abort;
    const current = () => !stopped && videoAbort === abort;
    try {
      // serve-sim's MJPEG endpoint starts screen capture; AVCC alone may not.
      if (!mjpeg) {
        const prime = new AbortController();
        const timer = setTimeout(() => prime.abort(), 2000);
        try {
          const seed = await fetch(
            `${API_URL}/v1/runs/${options.runId}/preview/mjpeg?device=${encodeURIComponent(options.device.id)}`,
            { credentials: "include", signal: AbortSignal.any([abort.signal, prime.signal]) },
          );
          await seed.body?.getReader().read();
        } catch {
          /* AVCC still attempted */
        } finally {
          clearTimeout(timer);
          prime.abort();
        }
      }
      // Cover stalled response headers too, not just an admitted reader.
      if (!mjpeg) {
        avccStartTimer = setTimeout(() => {
          if (current()) fallbackIos();
        }, options.iosStartMs ?? 12_000);
      }
      const response = await fetch(
        `${API_URL}/v1/runs/${options.runId}/preview/${mjpeg ? "mjpeg" : "video"}?device=${encodeURIComponent(options.device.id)}`,
        { credentials: "include", signal: abort.signal },
      );
      if (!current()) {
        await response.body?.cancel().catch(() => {});
        return;
      }
      if (!response.ok || !response.body)
        throw new Error(`Stream unavailable (${response.status}). Reconnect or sign in again.`);
      const reader = response.body.getReader();
      const avcc = new AvccFrames();
      const jpeg = new JpegFrames();
      while (current()) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (mjpeg) {
          for (const bytes of jpeg.push(chunk.value)) void paintJpeg(bytes).catch(() => {});
        } else
          for (const frame of avcc.push(chunk.value)) {
            if (frame.tag === 1) {
              await configure({
                codec: avcCodec(frame.payload),
                description: frame.payload as Uint8Array<ArrayBuffer>,
              });
            } else if (frame.tag === 2 || frame.tag === 3) {
              // HTTP/tunnel chunks can batch many frames. Apply reader
              // backpressure rather than overflowing the decoder in one task;
              // dropping iOS delta frames would break the reference chain.
              const deadline = Date.now() + 3000;
              while (current() && decoder && decoder.decodeQueueSize > 4 && Date.now() < deadline)
                await new Promise<void>((resolve) => setTimeout(resolve, 5));
              if (!current()) return;
              decode(frame.payload, frame.tag === 2);
            } else if (frame.tag === 4) void paintJpeg(frame.payload).catch(() => {});
          }
      }
      if (current()) reconnect("Video feed ended; reconnecting…");
    } catch (error) {
      if (current()) {
        if (!mjpeg) fallbackIos();
        else reconnect(error instanceof Error ? error.message : "Video disconnected");
      }
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
    if (!webCodecs && options.device.platform === "android") {
      fail("Android live video needs WebCodecs. Use a current Chrome/Edge browser over HTTPS.");
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
        if (stopped || socket !== ws) return;
        if (options.device.platform === "ios") void readIosVideo();
      };
      ws.onmessage = (event) => {
        if (stopped || socket !== ws) return;
        if (typeof event.data === "string") {
          try {
            const message = JSON.parse(event.data);
            if (message.type === "ready")
              options.input(options.control && message.control === true);
            if (message.type === "input-error")
              fail(`${message.message} Inspect before retrying; nothing was replayed.`);
            if (message.type === "video-session") {
              pendingAndroid = [];
              closeDecoder();
              // The hub already emits config/keyframes for the new session.
              // Resetting here creates a session -> reset -> session loop.
            }
          } catch {
            /* unknown event */
          }
          return;
        }
        if (!(event.data instanceof ArrayBuffer)) return;
        if (options.device.platform === "ios") {
          const bytes = new Uint8Array(event.data);
          if (bytes[0] === 0x82 && bytes.length < 16_384) {
            try {
              const config = JSON.parse(new TextDecoder().decode(bytes.subarray(1)));
              if (
                ["portrait", "landscape_left", "landscape_right", "portrait_upside_down"].includes(
                  config.orientation,
                )
              )
                iosOrientation = config.orientation;
            } catch {
              /* malformed config */
            }
          }
          return;
        }
        try {
          const packet = androidFrame(event.data);
          const scan = scanAnnexB(packet.data);
          const key = packet.key ?? scan.key;
          if (configuring) {
            // Codec support checks are asynchronous: preserve the initial IDR
            // arriving immediately after SPS/PPS, without resetting the hub.
            if (
              pendingAndroid.length < 8 &&
              pendingAndroid.reduce((size, frame) => size + frame.data.byteLength, 0) +
                packet.data.byteLength <=
                4 * 1024 * 1024
            )
              pendingAndroid.push(packet);
          } else if (!configured && scan.sps) {
            pendingAndroid = [packet];
            void configure({ codec: avcCodec(scan.sps) }).then((ok) => {
              const queued = pendingAndroid;
              pendingAndroid = [];
              if (ok && socket === ws) {
                for (const frame of queued)
                  decode(frame.data, frame.key ?? scanAnnexB(frame.data).key, frame.timestamp);
              }
            });
          } else decode(packet.data, key, packet.timestamp);
        } catch {
          fail("Invalid video frame; reconnect to view");
        }
      };
      ws.onclose = (event) => {
        if (socket === ws && !stopped)
          reconnect(
            event.code === 1006
              ? "Connection refused/interrupted. Another browser tab may own control; disable it there if needed. No actions are replayed."
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
        input.type === "touch" && options.device.platform === "ios"
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
