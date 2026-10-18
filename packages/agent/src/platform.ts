/**
 * One run prepares one platform. Each platform adapter lists what its runner
 * can boot and boots the device a run asked for, using the shared picker so
 * the API, CLI and runner agree on what a request means.
 */
import { pickDevice } from "@simbox/shared";
import type {
  BootedDevice,
  CatalogModel,
  CatalogOs,
  DeviceCatalog,
  DevicePlatform,
  DeviceProfile,
} from "@simbox/shared";

/** A model + OS chosen from the runner's catalog, ready to boot. */
export interface DeviceChoice {
  model: CatalogModel;
  os: CatalogOs;
  /** iOS: the simulator created or reused for this run. */
  udid?: string;
  /** The full catalog, when choosing needed it (saves listing it again). */
  catalog?: DeviceCatalog;
}

export interface PlatformAdapter {
  readonly platform: DevicePlatform;
  /** Everything this runner can boot. Android lists the SDK repository (slow). */
  catalog(): Promise<DeviceCatalog>;
  /**
   * Choose the device and prepare the host for it. Runs before the device
   * daemon starts (iOS switches Xcode here). Throws DeviceRequestError when
   * the runner cannot provide what was asked for.
   */
  select(selector: DeviceProfile | null): Promise<DeviceChoice>;
  /** Boot the chosen device until it accepts commands. */
  boot(choice: DeviceChoice): Promise<BootedDevice>;
}

/** A requested device or OS this runner cannot provide; the run must fail. */
export class DeviceRequestError extends Error {
  override name = "DeviceRequestError";
}

/** pickDevice, throwing a DeviceRequestError that lists what the runner offers. */
export function pickOrThrow(
  selector: DeviceProfile | null,
  catalog: DeviceCatalog,
): { model: CatalogModel; os: CatalogOs } {
  const pick = pickDevice(selector, catalog);
  if (!pick.ok) throw new DeviceRequestError(pick.error);
  return { model: pick.model, os: pick.os };
}

/** iOS simulators need macOS; the Android emulator needs Linux/KVM. */
export function hostMismatch(platform: DevicePlatform, host: string): string | null {
  if (platform === "ios" && host !== "darwin")
    return `This run is for iOS, which needs a macOS ARM64 runner with Xcode (this runner is ${host}).`;
  if (platform === "android" && host !== "linux")
    return `This run is for Android, which needs a Linux x64 runner with KVM (this runner is ${host}).`;
  return null;
}

/** The platform a runner hosts when the API does not say (older API or manual run). */
export function hostPlatform(host: string, declared?: string): DevicePlatform {
  if (declared === "ios" || declared === "android") return declared;
  return host === "darwin" ? "ios" : "android";
}

const PRINTABLE = /^[\w .()+,'/:-]{1,120}$/;

/** Drop entries the API would reject so one odd SDK name cannot void a report. */
export function printableCatalog(catalog: DeviceCatalog): DeviceCatalog {
  const ok = (text: string) => PRINTABLE.test(text);
  return {
    ...catalog,
    models: catalog.models.filter((m) => ok(m.id) && ok(m.name)).slice(0, 400),
    os: catalog.os
      .filter((os) => ok(os.version) && ok(os.name))
      .slice(0, 400)
      .map((os) => (os.models ? { ...os, models: os.models.filter(ok).slice(0, 400) } : os)),
    ...(catalog.xcode ? { xcode: catalog.xcode.filter(ok).slice(0, 40) } : {}),
  };
}
