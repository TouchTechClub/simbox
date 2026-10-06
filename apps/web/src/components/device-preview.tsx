import { useQuery } from "@tanstack/react-query";
import {
  CircleAlert,
  MonitorSmartphone,
  Loader2,
  RefreshCw,
  Home,
  ArrowLeft,
  Layers,
  Power,
  RotateCw,
  Camera,
  Maximize2,
  X,
  Hand,
} from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent, type KeyboardEvent } from "react";
import { hidUsage, type PreviewDevice, type PreviewInput } from "@simbox/shared/preview";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Notice } from "@/components/ui/notice";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { api } from "@/lib/api";
import { devicePoint } from "@/lib/device-video";
import { startDeviceStream, type StreamStatus } from "@/lib/device-stream";

function useVisible() {
  const [visible, setVisible] = useState(!document.hidden);
  useEffect(() => {
    const update = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

/** Keyed by run/device/control so no socket or pending gesture crosses targets. */
function DeviceScreen({
  runId,
  device,
  control,
  visible,
}: {
  runId: string;
  device: PreviewDevice;
  control: boolean;
  visible: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const stream = useRef<ReturnType<typeof startDeviceStream> | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  const pointer = useRef<number | null>(null);
  const lastPoint = useRef({ x: 0, y: 0 });
  const heldKeys = useRef(new Map<string, { code: string; key: string }>());
  const lastMove = useRef(0);
  const [epoch, setEpoch] = useState(0);
  const [status, setStatus] = useState<{ state: StreamStatus; detail: string }>({
    state: "connecting",
    detail: "Connecting live video…",
  });
  const [inputReady, setInputReady] = useState(false);
  const [hasFrame, setHasFrame] = useState(false);
  const [text, setText] = useState("");
  const [lastFrameAt, setLastFrameAt] = useState<number | null>(null);
  const [orientation, setOrientation] = useState(0);
  const canControl = control && inputReady && visible && status.state === "live";
  useEffect(() => {
    if (!visible || !canvas.current) return;
    setHasFrame(false);
    setLastFrameAt(null);
    setInputReady(false);
    const client = startDeviceStream({
      runId,
      device,
      control,
      canvas: canvas.current,
      status: (state, detail) => setStatus({ state, detail }),
      input(ready) {
        setInputReady(ready);
        if (!ready) {
          const id = pointer.current;
          pointer.current = null;
          heldKeys.current.clear();
          if (id !== null && canvas.current?.hasPointerCapture(id))
            canvas.current.releasePointerCapture(id);
        }
      },
      frame() {
        setHasFrame(true);
        setLastFrameAt(Date.now());
      },
    });
    stream.current = client;
    return () => {
      stream.current = null;
      pointer.current = null;
      heldKeys.current.clear();
      client.stop();
    };
  }, [runId, device.id, control, visible, epoch]);
  const send = (input: PreviewInput) => {
    if (!canControl || !stream.current?.send(input)) {
      stream.current?.stop();
      setInputReady(false);
      setStatus({
        state: "error",
        detail: "Input unavailable. Inspect the screen before retrying; no actions were replayed.",
      });
    }
  };
  const release = () => {
    if (pointer.current !== null) {
      stream.current?.send({ type: "touch", phase: "end", ...lastPoint.current });
      pointer.current = null;
    }
    for (const key of heldKeys.current.values())
      stream.current?.send({ type: "key", phase: "up", ...key });
    heldKeys.current.clear();
  };
  useEffect(() => {
    window.addEventListener("blur", release);
    return () => window.removeEventListener("blur", release);
  }, []);
  const point = (event: PointerEvent<HTMLCanvasElement>) =>
    devicePoint(event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY);
  const down = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!canControl || pointer.current !== null || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    pointer.current = event.pointerId;
    lastPoint.current = point(event);
    send({ type: "touch", phase: "begin", ...lastPoint.current });
  };
  const move = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!canControl || pointer.current !== event.pointerId) return;
    lastPoint.current = point(event);
    if (Date.now() - lastMove.current < 20) return;
    lastMove.current = Date.now();
    send({ type: "touch", phase: "move", ...lastPoint.current });
  };
  const up = (event: PointerEvent<HTMLCanvasElement>) => {
    if (pointer.current !== event.pointerId) return;
    lastPoint.current = point(event);
    release();
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const key = (event: KeyboardEvent<HTMLCanvasElement>, phase: "down" | "up") => {
    if (!canControl || event.repeat || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (device.platform === "android" && (event.ctrlKey || event.metaKey || event.altKey)) return;
    if (device.platform === "ios" && hidUsage(event.code) === null) return;
    if (
      device.platform === "android" &&
      (phase === "up" ||
        (event.key.length !== 1 &&
          ![
            "Enter",
            "Backspace",
            "Delete",
            "Tab",
            "Escape",
            "ArrowUp",
            "ArrowDown",
            "ArrowLeft",
            "ArrowRight",
          ].includes(event.key)))
    )
      return;
    const input = { code: event.code, key: event.key };
    if (phase === "down") heldKeys.current.set(event.code, input);
    else heldKeys.current.delete(event.code);
    send({ type: "key", phase, ...input });
  };
  const screenshot = () => {
    if (!canvas.current || !hasFrame) return;
    canvas.current.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `simbox-${device.id}-${Date.now()}.png`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  };
  return (
    <div className="flex flex-col gap-3" ref={frame}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span
          className={
            status.state === "live" && visible ? "text-emerald-500" : "text-muted-foreground"
          }
        >
          {!visible ? "Paused · tab hidden" : status.detail}
        </span>
        <span className="ml-auto text-muted-foreground">
          {control ? "Control enabled" : "Read-only"}
        </span>
        <Button
          size="icon"
          variant="ghost"
          aria-label="Reconnect device preview"
          onClick={() => {
            release();
            setEpoch((value) => value + 1);
          }}
        >
          <RefreshCw />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          aria-label="Save preview screenshot"
          disabled={!hasFrame}
          onClick={screenshot}
        >
          <Camera />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          aria-label="Fullscreen device preview"
          onClick={() => {
            void frame.current?.requestFullscreen?.().catch(() =>
              setStatus((previous) => ({
                ...previous,
                detail: "Fullscreen is unavailable in this browser.",
              })),
            );
          }}
        >
          <Maximize2 />
        </Button>
      </div>
      <div className="flex min-h-64 items-center justify-center overflow-hidden rounded-xl border bg-black p-3">
        {!hasFrame && visible && status.state === "connecting" ? (
          <p className="flex items-center gap-2 text-sm text-white">
            <Loader2 className="size-4 animate-spin" />
            Waiting for live video…
          </p>
        ) : null}
        <canvas
          ref={canvas}
          width={360}
          height={720}
          tabIndex={canControl ? 0 : -1}
          aria-label={`${device.name} live screen${canControl ? "; touch, drag, or type to control" : "; read-only"}`}
          className={`${hasFrame ? "block" : "hidden"} rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-primary`}
          style={{
            maxHeight: "65vh",
            maxWidth: "100%",
            width: "auto",
            height: "auto",
            touchAction: canControl ? "none" : "auto",
            cursor: canControl ? "crosshair" : "default",
          }}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          onLostPointerCapture={release}
          onBlur={release}
          onKeyDown={(event) => key(event, "down")}
          onKeyUp={(event) => key(event, "up")}
        />
        {status.state === "error" && !hasFrame ? (
          <p className="max-w-md text-center text-sm text-white">{status.detail}</p>
        ) : null}
      </div>
      {hasFrame && (!visible || status.state !== "live") ? (
        <Notice variant="warning">
          <CircleAlert />
          <span>
            Last frame is stale
            {lastFrameAt ? ` (${new Date(lastFrameAt).toLocaleTimeString()})` : ""}. Reconnect
            before acting. No input is automatically replayed.
          </span>
        </Notice>
      ) : null}
      {control ? (
        <>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!canControl}
              onClick={() => send({ type: "button", button: "home" })}
            >
              <Home />
              Home
            </Button>
            {device.platform === "android" ? (
              <Button
                size="sm"
                variant="outline"
                disabled={!canControl}
                onClick={() => send({ type: "button", button: "back" })}
              >
                <ArrowLeft />
                Back
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              disabled={!canControl}
              onClick={() => send({ type: "button", button: "recents" })}
            >
              <Layers />
              Apps
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!canControl}
              onClick={() => send({ type: "button", button: "power" })}
            >
              <Power />
              Lock / wake
            </Button>
            {device.platform === "ios" ? (
              <Button
                size="sm"
                variant="outline"
                disabled={!canControl}
                onClick={() => {
                  const next = (orientation + 1) % 4;
                  setOrientation(next);
                  send({
                    type: "rotate",
                    orientation: (
                      [
                        "portrait",
                        "landscape_left",
                        "portrait_upside_down",
                        "landscape_right",
                      ] as const
                    )[next]!,
                  });
                }}
              >
                <RotateCw />
                Rotate
              </Button>
            ) : null}
          </div>
          {device.platform === "android" ? (
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (!text || !canControl) return;
                send({ type: "text", text });
                setText("");
              }}
            >
              <Input
                aria-label="Text to type on Android"
                placeholder="Type text on the device…"
                value={text}
                maxLength={1000}
                disabled={!canControl}
                onChange={(event) => setText(event.target.value)}
              />
              <Button size="sm" disabled={!canControl || !text} type="submit">
                Send text
              </Button>
            </form>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Click the screen to focus, then type. Drag to swipe. These controls act directly on{" "}
            {device.name}; coordinate with agents using the same device.{" "}
            {device.platform === "ios"
              ? "iOS uses hardware-key events; paste/IME text is not supported."
              : "Android modifier shortcuts are not forwarded."}
          </p>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          Viewing does not keep an idle runner alive. Enable control to interact; accepted input
          resets its idle timer.
        </p>
      )}
    </div>
  );
}

export function DevicePreviewPanel({ runId }: { runId: string }) {
  const visible = useVisible();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState("");
  const [control, setControl] = useState(false);
  const [confirmControl, setConfirmControl] = useState(false);
  const inventory = useQuery({
    queryKey: ["previewDevices", runId],
    queryFn: ({ signal }) => api.previewDevices(runId, signal),
    enabled: open && visible,
    refetchInterval: open && visible ? 8000 : false,
    retry: false,
    refetchOnWindowFocus: true,
  });
  const device =
    inventory.data?.devices.find((item) => item.id === selected) ??
    (!selected ? inventory.data?.devices[0] : undefined);
  // Losing the exact selected device must never retarget the controller.
  useEffect(() => {
    if (device && !selected) setSelected(device.id);
  }, [device?.id, selected]);
  useEffect(() => {
    if (!device) setControl(false);
  }, [device?.id]);
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2">
            <MonitorSmartphone className="size-4" />
            Devices
          </CardTitle>
          <CardDescription>
            Live video and optional browser controls, powered by the same hub as T3 Code.
          </CardDescription>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setOpen((value) => !value);
            setControl(false);
          }}
        >
          {open ? (
            <>
              <X />
              Close
            </>
          ) : (
            "Open device panel"
          )}
        </Button>
      </CardHeader>
      {open ? (
        <CardContent className="flex flex-col gap-4">
          {inventory.isPending ? (
            <p className="flex items-center gap-2 text-sm">
              <Loader2 className="size-4 animate-spin" />
              Discovering active devices…
            </p>
          ) : null}
          {inventory.isError ? (
            <Notice variant="warning">
              <CircleAlert />
              <span>{inventory.error.message} Retrying while this panel is visible.</span>
              <Button size="sm" variant="outline" onClick={() => void inventory.refetch()}>
                Retry
              </Button>
            </Notice>
          ) : null}
          {inventory.data && inventory.data.devices.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No active supported devices. Boot one with{" "}
              <code>simbox exec boot --platform &lt;ios|android&gt; --device &lt;name&gt;</code>.
              This panel never boots or replaces a device automatically.
            </p>
          ) : null}
          {inventory.data && inventory.data.devices.length > 0 ? (
            <div className="flex flex-wrap items-center gap-3">
              <label className="min-w-0 flex-1">
                <span className="sr-only">Preview device</span>
                <select
                  aria-label="Preview device"
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={device?.id ?? ""}
                  onChange={(event) => {
                    setControl(false);
                    setSelected(event.target.value);
                  }}
                >
                  <option value="" disabled>
                    Select device
                  </option>
                  {inventory.data.devices.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name} · {item.version} · {item.id}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                variant={control ? "default" : "outline"}
                size="sm"
                disabled={!device || inventory.isError}
                onClick={() => (control ? setControl(false) : setConfirmControl(true))}
              >
                <Hand />
                {control ? "Disable control" : "Enable control"}
              </Button>
            </div>
          ) : null}
          {selected && inventory.data && !device ? (
            <Notice variant="warning">
              <CircleAlert />
              <span>
                The selected device is no longer active. Choose another device explicitly.
              </span>
            </Notice>
          ) : null}
          {device ? (
            <DeviceScreen
              key={`${runId}:${device.id}:${control}`}
              runId={runId}
              device={device}
              control={control}
              visible={visible}
            />
          ) : null}
          <ConfirmDialog
            open={confirmControl}
            onOpenChange={setConfirmControl}
            title="Control this device?"
            body={`Touch and keyboard input will change ${device?.name ?? "the device"} immediately, and may conflict with CLI agents. Only one browser controller can attach at a time. Inputs are never replayed after a disconnect.`}
            confirmLabel="Enable control"
            onConfirm={() => {
              setConfirmControl(false);
              setControl(true);
            }}
          />
        </CardContent>
      ) : null}
    </Card>
  );
}
