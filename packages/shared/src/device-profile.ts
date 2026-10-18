import type { DevicePlatform } from "./runners.js";

/**
 * Which device a run prepares beyond its platform defaults. Every field is
 * optional; absent fields fall back to the next settings layer and finally to
 * whatever the runner boots by default.
 */
export interface DeviceProfile {
  /**
   * iOS: a simulator device type name or identifier ("iPhone 16 Pro").
   * Android: an avdmanager hardware profile id or name ("pixel_8").
   */
  model?: string;
  /**
   * iOS: a runtime version ("18.4", or "18" for the newest 18.x).
   * Android: an API level ("35"). "latest" and "oldest" resolve on the runner.
   */
  os?: string;
  /** iOS: an iPhone Duo simulator. Android: a 7.6in foldable emulator with a hinge. */
  foldable?: boolean;
  /** iOS only: the Xcode version selected before the device daemon starts, e.g. "27.1". */
  xcode?: string;
}

/** Per-platform device defaults for one settings layer; null inherits. */
export type DevicePreferences = Record<DevicePlatform, DeviceProfile | null>;

const XCODE_VERSION = /^\d{1,3}(\.\d{1,3}){0,2}$/;
const IOS_VERSION = /^\d{1,3}(\.\d{1,3}){0,2}$/;
const ANDROID_API = /^\d{1,3}(\.\d{1,2})?$/;
// Simulator and AVD profile names: "iPad Pro 13-inch (M4)", "7.6in Foldable", "pixel_9_pro".
const MODEL = /^[A-Za-z0-9][A-Za-z0-9 ._()+,'-]{0,79}$/;
const KEYS = new Set(["model", "os", "foldable", "xcode"]);

export function emptyDevicePreferences(): DevicePreferences {
  return { ios: null, android: null };
}

/** Null when the profile asks for nothing beyond the platform defaults. */
export function validateDeviceProfile(
  value: unknown,
  platform: DevicePlatform,
): DeviceProfile | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value))
    throw new Error("Device must be {model?, os?, foldable?, xcode?}.");
  if (Object.keys(value).some((key) => !KEYS.has(key)))
    throw new Error("Device only accepts model, os, foldable and xcode.");
  const { model, os, foldable, xcode } = value as Record<string, unknown>;
  if (foldable !== undefined && typeof foldable !== "boolean")
    throw new Error("foldable must be true or false.");
  if (model !== undefined) {
    if (typeof model !== "string" || !MODEL.test(model) || model !== model.trim())
      throw new Error(
        'Device model must be a simulator or emulator profile name such as "iPhone 16 Pro" or "pixel_8".',
      );
    if (foldable === true) throw new Error("Choose either a foldable or a device model, not both.");
  }
  if (os !== undefined) {
    if (typeof os !== "string") throw new Error("os must be a version string.");
    const keyword = os === "latest" || os === "oldest";
    if (!keyword && platform === "ios" && !IOS_VERSION.test(os))
      throw new Error('iOS version must look like "18.4", "18", "latest" or "oldest".');
    if (!keyword && platform === "android" && !ANDROID_API.test(os))
      throw new Error('Android version must be an API level such as "35", "latest" or "oldest".');
  }
  if (xcode !== undefined) {
    if (typeof xcode !== "string" || !XCODE_VERSION.test(xcode))
      throw new Error('Xcode must be a version such as "27.1".');
    if (platform !== "ios") throw new Error("Xcode selection only applies to iOS runs.");
  }
  const profile: DeviceProfile = {
    ...(model !== undefined ? { model: model as string } : {}),
    ...(os !== undefined ? { os: os as string } : {}),
    ...(foldable === true ? { foldable: true } : {}),
    ...(xcode !== undefined ? { xcode: xcode as string } : {}),
  };
  return Object.keys(profile).length > 0 ? profile : null;
}

export function sameDeviceProfile(a: DeviceProfile | null, b: DeviceProfile | null): boolean {
  return (
    (a?.foldable === true) === (b?.foldable === true) &&
    a?.xcode === b?.xcode &&
    a?.model?.toLowerCase() === b?.model?.toLowerCase() &&
    a?.os === b?.os
  );
}

/**
 * Field-wise layering: an override's model replaces the default model but keeps
 * the default OS, and vice versa. A foldable and a model are alternatives, so
 * whichever the higher layer sets wins. Xcode is a per-run choice only.
 */
export function mergeDeviceProfiles(
  base: DeviceProfile | null,
  top: DeviceProfile | null,
): DeviceProfile | null {
  if (!base) return top;
  if (!top) return base;
  const pickedModel = top.model !== undefined || top.foldable === true;
  const merged: DeviceProfile = {
    ...(pickedModel
      ? top.model !== undefined
        ? { model: top.model }
        : { foldable: true }
      : base.model !== undefined
        ? { model: base.model }
        : base.foldable
          ? { foldable: true }
          : {}),
    ...((top.os ?? base.os) !== undefined ? { os: top.os ?? base.os } : {}),
    ...((top.xcode ?? base.xcode) !== undefined ? { xcode: top.xcode ?? base.xcode } : {}),
  };
  return Object.keys(merged).length > 0 ? merged : null;
}

export function parseDevicePatch(value: unknown): Partial<DevicePreferences> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length === 0 ||
    Object.keys(value).some((key) => key !== "ios" && key !== "android")
  ) {
    throw new Error("Expected ios and/or android device settings; use null to inherit.");
  }
  const patch: Partial<DevicePreferences> = {};
  for (const platform of ["ios", "android"] as const) {
    if (!Object.hasOwn(value, platform)) continue;
    const profile = validateDeviceProfile((value as Record<string, unknown>)[platform], platform);
    if (profile?.xcode) throw new Error("Xcode is chosen per run with --xcode, not as a default.");
    patch[platform] = profile;
  }
  return patch;
}

export function formatDeviceProfile(
  profile: DeviceProfile | null,
  platform: DevicePlatform,
): string {
  const model = profile?.foldable
    ? platform === "ios"
      ? "iPhone Duo"
      : "Android foldable"
    : (profile?.model ?? "default");
  const os = profile?.os
    ? platform === "ios"
      ? `iOS ${profile.os}`
      : /^\d/.test(profile.os)
        ? `API ${profile.os}`
        : `Android ${profile.os}`
    : null;
  return [model, os, profile?.xcode ? `Xcode ${profile.xcode}` : null]
    .filter((part) => part !== null)
    .join(", ");
}
