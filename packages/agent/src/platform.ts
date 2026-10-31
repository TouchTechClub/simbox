/**
 * One run prepares one platform. Each platform adapter lists what its runner
 * can boot, validates the device a run asked for with the shared picker (so
 * the API, CLI and runner agree on what a request means) and prepares the
 * host for it. Simlock then creates and boots the device itself.
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
  /** The full catalog, when choosing needed it (saves listing it again). */
  catalog?: DeviceCatalog;
}

export interface PlatformAdapter {
  readonly platform: DevicePlatform;
  /** Everything this runner can boot. Android lists the SDK repository (slow). */
  catalog(): Promise<DeviceCatalog>;
  /**
   * Choose the device. Runs before Simlock starts (iOS switches Xcode here,
   * since Simlock resolves its toolchain once). Throws DeviceRequestError
   * when the runner cannot provide what was asked for.
   */
  select(selector: DeviceProfile | null): Promise<DeviceChoice>;
  /** Install what Simlock needs to boot the choice (Android: SDK packages). */
  prepare(choice: DeviceChoice): Promise<void>;
  /** The Simlock warm-pool model for the choice. */
  simlockModel(choice: DeviceChoice): string;
}

/** What the run reports as booted, from the choice Simlock keeps warm. */
export function bootedFromChoice(choice: DeviceChoice): BootedDevice {
  return { model: choice.model.name, os: choice.os.version, name: choice.model.name };
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
