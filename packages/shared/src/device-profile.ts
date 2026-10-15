import type { DevicePlatform } from "./runners.js";

/** Which device a run prepares beyond its platform defaults. */
export interface DeviceProfile {
  /** iOS: an iPhone Duo simulator. Android: a 7.6in foldable emulator with a hinge. */
  foldable?: boolean;
  /** iOS only: the Xcode version selected before the device daemon starts, e.g. "27.1". */
  xcode?: string;
}

const XCODE_VERSION = /^\d{1,3}(\.\d{1,3}){0,2}$/;

/** Null when the profile asks for nothing beyond the platform defaults. */
export function validateDeviceProfile(
  value: unknown,
  platform: DevicePlatform,
): DeviceProfile | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value))
    throw new Error("Device must be {foldable?: boolean, xcode?: string}.");
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "foldable" && key !== "xcode"))
    throw new Error("Device only accepts foldable and xcode.");
  const { foldable, xcode } = value as { foldable?: unknown; xcode?: unknown };
  if (foldable !== undefined && typeof foldable !== "boolean")
    throw new Error("foldable must be true or false.");
  if (xcode !== undefined) {
    if (typeof xcode !== "string" || !XCODE_VERSION.test(xcode))
      throw new Error('Xcode must be a version such as "27.1".');
    if (platform !== "ios") throw new Error("Xcode selection only applies to iOS runs.");
  }
  const profile: DeviceProfile = {
    ...(foldable === true ? { foldable: true } : {}),
    ...(xcode !== undefined ? { xcode } : {}),
  };
  return Object.keys(profile).length > 0 ? profile : null;
}

export function sameDeviceProfile(a: DeviceProfile | null, b: DeviceProfile | null): boolean {
  return (a?.foldable === true) === (b?.foldable === true) && a?.xcode === b?.xcode;
}

export function formatDeviceProfile(
  profile: DeviceProfile | null,
  platform: DevicePlatform,
): string {
  const device = profile?.foldable
    ? platform === "ios"
      ? "iPhone Duo"
      : "Android foldable"
    : "default";
  return profile?.xcode ? `${device}, Xcode ${profile.xcode}` : device;
}
